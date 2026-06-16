import { randomUUID } from "node:crypto";
import { sha256Digest } from "./canonical.js";
import {
  snapshotWorkflowDefinition,
  type CompilableWorkflowDefinition,
  type PlannerAdapter,
  type SuperviseDecision,
  type SuperviseOuterLoopState,
} from "./compiler.js";
import type { ToolRegistry } from "./tool-registry.js";
import type { FailedRunResult, LocalWorld, RunResult } from "./authoring.js";
import type { BashCapabilities } from "./bash-tool.js";
import type { WorkflowVersionReuseStrategy } from "./workflow-version-reuse.js";
import {
  RunFailedError,
  runWorkflowCycle,
  type RunWorkflowCycleOptions,
} from "./runtime.js";
import { materializeRunStateFromEvents } from "./run-state.js";
import {
  writeOuterLoopManifest,
  readOuterLoopManifest,
  type EventEnvelope,
  type OuterLoopCycleSummary,
  type OuterLoopManifest,
} from "./world.js";

// ── Public types ───────────────────────────────────────────────────────────────

export type RunOuterLoopOptions = {
  readonly world: LocalWorld;
  readonly workflow: CompilableWorkflowDefinition;
  readonly input: unknown;
  readonly planner: PlannerAdapter;
  readonly tools?: ToolRegistry;
  readonly maxAttempts?: number;
  readonly maxOuterCycles: number;
  readonly signal?: AbortSignal;
  readonly timeout?: string | number;
  readonly bash?: BashCapabilities;
  readonly workflowVersionReuseStrategy?: WorkflowVersionReuseStrategy;
  /** Pass to resume an existing outer-loop run. */
  readonly outerLoopId?: string;
  /** Human-readable label stamped into each cycle's RunStarted.payload.label. */
  readonly label?: string;
  /** Free-form tags stamped into each cycle's RunStarted.payload.tags. */
  readonly tags?: readonly string[];
};

// ── Implementation ─────────────────────────────────────────────────────────────

/**
 * Drives multiple compile-and-run cycles (the outer loop, Layer B §3.3-3.5).
 *
 * Each cycle gets its own `runId` and a full per-cycle event log including
 * compiler lifecycle events (OrchestrationRequested, PlannerDraftedWorkflow, …)
 * and an `OuterLoopCycleCompleted` event appended at the end.
 *
 * The outer-loop manifest is written transactionally to
 * `<dataDir>/outer-loops/{outerLoopId}.json` after every cycle.
 *
 * Returns a `RunResult`-compatible object using the final cycle's runId,
 * workflowVersionId, and events. The `finalOutput` from the supervise `done`
 * decision is used as the `output`.
 *
 * Throws `RunFailedError` with causeCode:
 * - `"runtime_config_error"` — if `maxOuterCycles > 1` but `planner.supervise`
 *   is missing.
 * - `"outer_loop_exhausted"` — if all cycles complete but `supervise` never
 *   returns `{ kind: "done" }`.
 */
export async function runOuterLoop(
  options: RunOuterLoopOptions,
): Promise<RunResult<unknown>> {
  const outerLoopId = options.outerLoopId ?? `ol_${randomUUID().replace(/-/g, "")}`;
  const startedAt = Date.now();
  const outerLoopTimeoutMs = timeoutMsFor(options.timeout);

  // Resume: if a manifest exists and the loop is already done, return early.
  const existing = await readOuterLoopManifest(options.world, outerLoopId);
  const cycles: OuterLoopCycleSummary[] = existing ? [...existing.cycles] : [];

  if (existing !== undefined && existing.maxCycles !== options.maxOuterCycles) {
    throw new RunFailedError({
      runId: "uncompiled",
      workflowVersionId: "uncompiled",
      causeCode: "runtime_config_error",
      message:
        `runtime_config_error: outer_loop_max_cycles_mismatch — existing outer loop ` +
        `'${outerLoopId}' was started with maxCycles=${existing.maxCycles}, ` +
        `caller now passed maxOuterCycles=${options.maxOuterCycles}.`,
    });
  }

  const expectedGoalHash = workflowDefinitionHash(options.workflow, options.tools);
  if (existing !== undefined && existing.goal.workflowDefinitionHash !== expectedGoalHash) {
    throw new RunFailedError({
      runId: "uncompiled",
      workflowVersionId: "uncompiled",
      causeCode: "runtime_config_error",
      message:
        "runtime_config_error: outer_loop_goal_mismatch — existing outer loop " +
        `'${outerLoopId}' was started with workflowDefinitionHash=` +
        `${existing.goal.workflowDefinitionHash}, caller now passed ${expectedGoalHash}.`,
    });
  }

  if (existing?.result?.kind === "done") {
    if (cycles.length === 0) {
      throw new RunFailedError({
        runId: "uncompiled",
        workflowVersionId: "uncompiled",
        causeCode: "runtime_config_error",
        message:
          "runtime_config_error: outer_loop_manifest_corrupt — existing outer loop " +
          `'${outerLoopId}' has result.kind='done' but cycles is empty.`,
      });
    }
    const lastCycle = cycles[cycles.length - 1]!;
    return buildDoneRunResult(options.world, existing.result.finalOutput, lastCycle, undefined);
  }

  let promptNote: string | undefined;

  // Resume: if continuing after a prior `continue` decision, the supervisor's
  // promptNote was persisted as cycles[-1].summary. Seed promptNote so the
  // next compile sees it. Skip when the loop has finished (`result` set).
  if (existing !== undefined && existing.result === undefined && cycles.length > 0) {
    promptNote = cycles[cycles.length - 1]?.summary;
  }

  if (typeof options.planner.supervise !== "function") {
    throw new RunFailedError({
      runId: "uncompiled",
      workflowVersionId: "uncompiled",
      causeCode: "runtime_config_error",
      message:
        "runtime_config_error: outer_loop_requested_without_supervise_adapter — " +
        "maxOuterCycles > 1 requires a PlannerAdapter with a supervise() method.",
    });
  }

  // If the manifest records a pendingCycleRunId, we crashed mid-cycle during
  // a previous invocation. Reuse that runId for the first iteration so Layer A
  // replay can resume execution from the last committed step event.
  // After the first iteration completes, subsequent cycles always get fresh runIds.
  let resumeRunId: string | undefined = existing?.pendingCycleRunId;

  for (
    let cycleNumber = cycles.length + 1;
    cycleNumber <= options.maxOuterCycles;
    cycleNumber += 1
  ) {
    const isFinalCycle = cycleNumber === options.maxOuterCycles;
    // isResumingMidCycle is true only for the very first iteration when we reuse
    // an existing pendingCycleRunId from the manifest (crash recovery path).
    const isResumingMidCycle = resumeRunId !== undefined;
    const runId = resumeRunId ?? `run_${randomUUID().replace(/-/g, "").slice(0, 32)}`;
    resumeRunId = undefined; // only the first iteration may reuse a persisted runId

    // Persist pendingCycleRunId before starting the cycle so that a mid-cycle
    // crash can be detected on resume. The manifest is cleared of this field
    // after supervise completes and the post-cycle manifest is written.
    // Skip this write when resuming a mid-cycle crash — the manifest already has
    // the correct pendingCycleRunId from the previous interrupted invocation.
    if (!isResumingMidCycle) {
      await writeOuterLoopManifest(options.world, outerLoopId, {
        outerLoopId,
        goal: {
          workflowDefinitionHash: workflowDefinitionHash(options.workflow, options.tools),
          description: options.workflow.description ?? options.workflow.id,
        },
        maxCycles: options.maxOuterCycles,
        cycles,
        pendingCycleRunId: runId,
      });
    }

    // Build the outerLoop context for this cycle's OrchestrationRequest.
    // summary is optional — omit it when undefined so sha256Digest doesn't choke.
    const outerLoopContext: RunWorkflowCycleOptions["outerLoop"] = {
      cycleNumber,
      maxCycles: options.maxOuterCycles,
      isFinalCycle,
      priorCycles: cycles.map((c) => ({
        cycleNumber: c.cycleNumber,
        status: c.status,
        output: c.output ?? null,
        ...(c.summary !== undefined ? { summary: c.summary } : {}),
      })),
    };

    // Run one cycle via runWorkflowCycle (handles compile, lifecycle events, execution).
    let cycleRunResult: RunResult<unknown> | undefined;
    let cycleError: RunFailedError | undefined;

    try {
      const cycleDraftPlanner = options.workflow.planner === undefined
        ? options.planner
        : undefined;
      cycleRunResult = await runWorkflowCycle({
        world: options.world,
        workflow: options.workflow,
        input: options.input,
        ...(cycleDraftPlanner === undefined ? {} : { planner: cycleDraftPlanner }),
        tools: options.tools,
        maxAttempts: options.maxAttempts,
        runId,
        signal: options.signal,
        timeout: remainingTimeoutMs(outerLoopTimeoutMs, startedAt),
        bash: options.bash,
        workflowVersionReuseStrategy: options.workflowVersionReuseStrategy,
        outerLoop: outerLoopContext,
        promptNote,
        outerLoopId,
        label: options.label,
        tags: options.tags,
      });
    } catch (err) {
      if (isRunFailedError(err)) {
        cycleError = err;
      } else {
        throw err;
      }
    }

    if (
      cycleError !== undefined &&
      (cycleError.causeCode === "cancelled" || cycleError.causeCode === "timeout")
    ) {
      throw cycleError;
    }

    const cycleSummary: OuterLoopCycleSummary = {
      cycleNumber,
      runId,
      workflowVersionId: cycleRunResult?.workflowVersionId
        ?? cycleError?.workflowVersionId
        ?? "uncompiled",
      status: cycleRunResult !== undefined ? "completed" : "failed",
      output: cycleRunResult?.output ?? cycleError?.result?.output ?? null,
    };
    cycles.push(cycleSummary);

    // Call supervise to get the next decision.
    const superviseState: SuperviseOuterLoopState = {
      goal: {
        workflowDefinitionHash: workflowDefinitionHash(options.workflow, options.tools),
        description: options.workflow.description ?? options.workflow.id,
      },
      cycles: cycles.map((c) => ({
        cycleNumber: c.cycleNumber,
        workflowVersionId: c.workflowVersionId,
        runId: c.runId,
        status: c.status,
        output: c.output ?? null,
        ...(c.summary !== undefined ? { summary: c.summary } : {}),
      })),
    };

    // Resume: if OuterLoopCycleCompleted is already committed for this cycleNumber,
    // reuse the persisted supervise payload instead of calling planner.supervise again.
    // Skips because LLM-based planners are non-deterministic and the durable event log
    // is the source of truth.
    const eventsBeforeSupervise = await options.world.listEvents(runId);
    const committedSuperviseEvent = eventsBeforeSupervise.find(
      (e) =>
        e.type === "OuterLoopCycleCompleted" &&
        (e.payload as { cycleNumber?: number }).cycleNumber === cycleNumber,
    );
    const decision: SuperviseDecision = committedSuperviseEvent !== undefined
      ? decodeSuperviseFromEvent(committedSuperviseEvent)
      : await superviseWithCancellation({
        supervise: options.planner.supervise!,
        state: superviseState,
        signal: options.signal,
        timeoutMs: remainingTimeoutMs(outerLoopTimeoutMs, startedAt),
        runId,
        workflowVersionId: cycleSummary.workflowVersionId,
      });

    // Attach the promptNote from a continue decision as the summary of the cycle
    // that supervise just commented on. Next cycle will see it in priorCycles.
    if (decision.kind === "continue" && decision.promptNote !== undefined) {
      cycles[cycles.length - 1] = { ...cycles[cycles.length - 1]!, summary: decision.promptNote };
    }

    // Normalise decision for canonical JSON: strip undefined values (e.g.
    // finalOutput may legitimately be undefined from a buggy planner).
    const supervisePayload: Record<string, unknown> =
      decision.kind === "done"
        ? { kind: "done", finalOutput: decision.finalOutput ?? null }
        : decision.promptNote !== undefined
        ? { kind: "continue", promptNote: decision.promptNote }
        : { kind: "continue" };

    // Append OuterLoopCycleCompleted to this cycle's run event log, unless a
    // crash already committed this event (crash between appendEvent and
    // writeOuterLoopManifest). When the committed event short-circuits supervise
    // above, the decision is decoded from that event and this dedup check will
    // detect it — the append is skipped. This dedup remains as a backup guard.
    const existingEvents = await options.world.listEvents(runId);
    const alreadyRecorded = existingEvents.some(
      (e) =>
        e.type === "OuterLoopCycleCompleted" &&
        (e.payload as { cycleNumber?: number }).cycleNumber === cycleNumber,
    );
    if (!alreadyRecorded) {
      await options.world.appendEvent(runId, {
        type: "OuterLoopCycleCompleted",
        payload: {
          outerLoopId,
          cycleNumber,
          supervise: supervisePayload,
        },
      });
    }

    // Persist the outer-loop manifest transactionally.
    const manifest: OuterLoopManifest = {
      outerLoopId,
      goal: {
        workflowDefinitionHash: workflowDefinitionHash(options.workflow, options.tools),
        description: options.workflow.description ?? options.workflow.id,
      },
      maxCycles: options.maxOuterCycles,
      cycles,
      ...(decision.kind === "done" ? { result: decision } : {}),
    };
    await writeOuterLoopManifest(options.world, outerLoopId, manifest);

    if (decision.kind === "done") {
      return buildDoneRunResult(options.world, decision.finalOutput, cycleSummary, cycleRunResult);
    }

    if (isFinalCycle) {
      throw buildOuterLoopExhaustedError(
        outerLoopId,
        cycleNumber,
        cycleSummary,
        cycleRunResult,
      );
    }

    // Carry promptNote forward to the next cycle.
    promptNote = decision.promptNote;
  }

  // Recovery path: a crash occurred AFTER the final cycle's manifest write
  // (cycles.length === maxOuterCycles) but BEFORE buildOuterLoopExhaustedError
  // was thrown. The for-loop guard fails on resume because cycleNumber starts
  // at cycles.length + 1 which exceeds maxOuterCycles. Surface the exhausted
  // error from the recovered manifest instead of falling off the end.
  if (cycles.length >= options.maxOuterCycles && cycles.length > 0) {
    const lastCycle = cycles[cycles.length - 1]!;
    throw buildOuterLoopExhaustedError(
      outerLoopId,
      lastCycle.cycleNumber,
      lastCycle,
      undefined,
    );
  }

  // Truly unreachable; TypeScript satisfaction only.
  throw new Error("outer-loop: unreachable");
}

// ── Private helpers ────────────────────────────────────────────────────────────

function workflowDefinitionHash(
  workflow: CompilableWorkflowDefinition,
  tools: ToolRegistry | undefined,
): string {
  return sha256Digest(snapshotWorkflowDefinition(workflow, tools));
}

function isRunFailedError(err: unknown): err is RunFailedError {
  return err instanceof Error && err.name === "RunFailedError" && "causeCode" in err;
}

async function buildDoneRunResult(
  world: LocalWorld,
  finalOutput: unknown,
  lastCycle: OuterLoopCycleSummary,
  lastRunResult: RunResult<unknown> | undefined,
): Promise<RunResult<unknown>> {
  const events = await world.listEvents(lastCycle.runId);
  if (events.length === 0) {
    return {
      runId: lastCycle.runId,
      workflowVersionId: lastCycle.workflowVersionId,
      status: "completed",
      output: finalOutput,
      usage: lastRunResult?.usage ?? { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      events: lastRunResult?.events ?? [],
      artifacts: lastRunResult?.artifacts ?? [],
    };
  }
  const state = materializeRunStateFromEvents(lastCycle.runId, events);
  return {
    runId: lastCycle.runId,
    workflowVersionId: state.workflowVersionId ?? lastCycle.workflowVersionId,
    status: "completed",
    output: finalOutput,
    usage: state.usage,
    events,
    artifacts: state.artifacts,
  };
}

function decodeSuperviseFromEvent(event: EventEnvelope): SuperviseDecision {
  const payload = event.payload as {
    supervise: { kind: "done" | "continue"; finalOutput?: unknown; promptNote?: string };
  };
  const s = payload.supervise;
  // Note: the encoder coerces undefined → null on append. Treat null as the same
  // legitimate `done` output — the producer did not distinguish them.
  if (s.kind === "done") {
    return { kind: "done", finalOutput: s.finalOutput ?? null };
  }
  return s.promptNote !== undefined
    ? { kind: "continue", promptNote: s.promptNote }
    : { kind: "continue" };
}

function buildOuterLoopExhaustedError(
  outerLoopId: string,
  finalCycleNumber: number,
  lastCycle: OuterLoopCycleSummary,
  lastRunResult: RunResult<unknown> | undefined,
): RunFailedError {
  const failedResult: FailedRunResult = {
    runId: lastCycle.runId,
    workflowVersionId: lastCycle.workflowVersionId,
    status: "failed",
    usage: lastRunResult?.usage ?? { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    events: lastRunResult?.events ?? [],
    artifacts: lastRunResult?.artifacts ?? [],
  };
  return new RunFailedError({
    runId: lastCycle.runId,
    workflowVersionId: lastCycle.workflowVersionId,
    causeCode: "outer_loop_exhausted",
    message: `Outer loop exhausted after ${finalCycleNumber} cycles (outerLoopId: ${outerLoopId}).`,
    result: failedResult,
    outerLoopId,
    lastCycleOutput: lastCycle.output ?? lastRunResult?.output,
  });
}

function timeoutMsFor(timeout: string | number | undefined): number | undefined {
  if (timeout === undefined) {
    return undefined;
  }
  if (typeof timeout === "number") {
    return timeout;
  }
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/u.exec(timeout.trim());
  if (match?.[1] === undefined) {
    throw new Error(`Invalid timeout '${timeout}'.`);
  }
  const value = Number(match[1]);
  const unit = match[2] ?? "ms";
  switch (unit) {
    case "ms":
      return value;
    case "s":
      return value * 1_000;
    case "m":
      return value * 60_000;
    case "h":
      return value * 3_600_000;
  }
}

function remainingTimeoutMs(timeoutMs: number | undefined, startedAt: number): number | undefined {
  if (timeoutMs === undefined) {
    return undefined;
  }
  return timeoutMs - (Date.now() - startedAt);
}

function cancelledRunError(runId: string, workflowVersionId: string): RunFailedError {
  return new RunFailedError({
    runId,
    workflowVersionId,
    causeCode: "cancelled",
    message: "Run was cancelled.",
  });
}

function timedOutRunError(runId: string, workflowVersionId: string): RunFailedError {
  return new RunFailedError({
    runId,
    workflowVersionId,
    causeCode: "timeout",
    message: "Run timed out.",
  });
}

async function superviseWithCancellation(options: {
  readonly supervise: (state: SuperviseOuterLoopState) => Promise<SuperviseDecision>;
  readonly state: SuperviseOuterLoopState;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly runId: string;
  readonly workflowVersionId: string;
}): Promise<SuperviseDecision> {
  if (options.signal?.aborted === true) {
    throw cancelledRunError(options.runId, options.workflowVersionId);
  }
  if (options.timeoutMs !== undefined && options.timeoutMs <= 0) {
    throw timedOutRunError(options.runId, options.workflowVersionId);
  }
  return new Promise<SuperviseDecision>((resolve, reject) => {
    let settled = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const cleanup = () => {
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
      }
      if (onAbort !== undefined) {
        options.signal?.removeEventListener("abort", onAbort);
      }
    };
    const rejectOnce = (error: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };
    if (options.timeoutMs !== undefined) {
      timeoutHandle = setTimeout(() => {
        rejectOnce(timedOutRunError(options.runId, options.workflowVersionId));
      }, options.timeoutMs);
    }
    if (options.signal !== undefined) {
      onAbort = () => rejectOnce(cancelledRunError(options.runId, options.workflowVersionId));
      options.signal.addEventListener("abort", onAbort, { once: true });
    }
    Promise.resolve(options.supervise(options.state)).then(
      (decision) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve(decision);
      },
      (error) => rejectOnce(error),
    );
  });
}
