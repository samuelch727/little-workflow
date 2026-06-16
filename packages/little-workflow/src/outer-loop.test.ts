import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendEvent,
  createLittleWorkflow,
  createToolRegistry,
  getWorkflowDefinitionHash,
  listEvents,
  localWorld,
  model,
  output,
  RunFailedError,
  truncateEventLogForTest,
  writeOuterLoopManifest,
} from "./index.js";
import { runWorkflowWithLegacyPlannerAdapter } from "./runtime.js";
import type {
  Harness,
  InferWorkflowOutput,
  LwirWorkflow,
  RunResult,
  RunWorkflowOptions,
  SuperviseDecision,
  SuperviseOuterLoopState,
  WorkflowRunTarget,
} from "./index.js";
import type { PlannerAdapter } from "./compiler.js";

// ── Fixtures ───────────────────────────────────────────────────────────────────

const simpleInputSchema = {
  type: "object",
  required: ["value"],
  additionalProperties: false,
  properties: { value: { type: "string" } },
} as const;

const simpleOutputSchema = {
  type: "object",
  required: ["result"],
  additionalProperties: false,
  properties: { result: { type: "string" } },
} as const;

const simpleWorkflow = createLittleWorkflow({
  id: "outer-loop-test.simple",
  description: "A simple workflow for outer-loop tests.",
  inputSchema: simpleInputSchema,
  output: output.object({ schema: simpleOutputSchema }),
  globalTools: ["process"],
} as unknown as Parameters<typeof createLittleWorkflow>[0]);

const simpleToolRegistry = createToolRegistry();
simpleToolRegistry.register("process", {
  description: "Process a value.",
  inputSchema: simpleInputSchema,
  execute: async (input) => {
    const { value } = input as { value: string };
    return { result: `processed:${value}` };
  },
});

function simpleWorkflowDefinitionHash(): string {
  return getWorkflowDefinitionHash(simpleWorkflow, simpleToolRegistry);
}

function simpleLwir(): LwirWorkflow {
  return {
    apiVersion: "littleworkflow.dev/v0.1",
    kind: "Workflow",
    metadata: {
      name: "outer-loop-test.simple",
      version: "0.1.0-alpha",
      description: "A simple workflow for outer-loop tests.",
    },
    input: { schema: simpleInputSchema },
    output: { schema: simpleOutputSchema },
    permissions: { tools: ["process"], models: [], secrets: [], network: [] },
    steps: [
      {
        id: "process",
        uses: "tool.call",
        with: { tool: "process" },
        input: { value: "{{ input.value }}" },
        output: { mode: "object", schema: simpleOutputSchema },
      },
    ],
  };
}

function plannerWithSupervise(
  superviseDecisions: SuperviseDecision[],
): PlannerAdapter {
  let callIndex = 0;
  return {
    draft: vi.fn(async () => simpleLwir()),
    supervise: vi.fn(async () => {
      const decision = superviseDecisions[callIndex++];
      if (decision === undefined) {
        throw new Error(`supervise called more times (${callIndex}) than decisions provided (${superviseDecisions.length})`);
      }
      return decision;
    }),
  };
}

function plannerWithoutSupervise(): PlannerAdapter {
  return {
    draft: vi.fn(async () => simpleLwir()),
  };
}

type RunWorkflowLegacyPlannerOptions<TWorkflow extends WorkflowRunTarget> =
  RunWorkflowOptions<TWorkflow> & {
    readonly planner?: PlannerAdapter;
  };

async function runWorkflow<TWorkflow extends WorkflowRunTarget>(
  options: RunWorkflowLegacyPlannerOptions<TWorkflow>,
): Promise<RunResult<InferWorkflowOutput<TWorkflow>>> {
  return runWorkflowWithLegacyPlannerAdapter(options) as Promise<
    RunResult<InferWorkflowOutput<TWorkflow>>
  >;
}

// ── Test setup ────────────────────────────────────────────────────────────────

let tmpDir: string;
let world: ReturnType<typeof localWorld>;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "lwf-outer-loop-"));
  world = localWorld({ dataDir: tmpDir });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("Layer B — runWorkflow with maxOuterCycles", () => {
  it("runs a single cycle when maxOuterCycles is 1 (default)", async () => {
    const planner = plannerWithoutSupervise();

    const result = await runWorkflow({
      world,
      workflows: simpleWorkflow,
      input: { value: "hello" },
      planner,
      tools: simpleToolRegistry,
      maxOuterCycles: 1,
    });

    expect(result.status).toBe("completed");
    expect(result.output).toEqual({ result: "processed:hello" });
    // draft called exactly once
    expect(vi.mocked(planner.draft)).toHaveBeenCalledTimes(1);
  });

  it("errors when maxOuterCycles > 1 but adapter.supervise is missing", async () => {
    const planner = plannerWithoutSupervise();

    await expect(
      runWorkflow({
        world,
        workflows: simpleWorkflow,
        input: { value: "hello" },
        planner,
        tools: simpleToolRegistry,
        maxOuterCycles: 3,
      }),
    ).rejects.toThrow(RunFailedError);

    try {
      await runWorkflow({
        world,
        workflows: simpleWorkflow,
        input: { value: "hello" },
        planner,
        tools: simpleToolRegistry,
        maxOuterCycles: 3,
      });
    } catch (err) {
      expect(err).toBeInstanceOf(RunFailedError);
      expect((err as RunFailedError).causeCode).toBe("runtime_config_error");
      expect((err as RunFailedError).message).toContain(
        "outer_loop_requested_without_supervise_adapter",
      );
    }
  });

  it("runs multiple cycles when supervise returns continue then done", async () => {
    const planner = plannerWithSupervise([
      { kind: "continue" },
      { kind: "continue" },
      { kind: "done", finalOutput: { result: "final-answer" } },
    ]);

    const result = await runWorkflow({
      world,
      workflows: simpleWorkflow,
      input: { value: "test" },
      planner,
      tools: simpleToolRegistry,
      maxOuterCycles: 5,
    });

    expect(result.status).toBe("completed");
    expect(result.output).toEqual({ result: "final-answer" });
    // draft() called once per cycle × 3 cycles
    expect(vi.mocked(planner.draft)).toHaveBeenCalledTimes(3);
    // supervise() called once per cycle × 3 cycles
    expect(vi.mocked(planner.supervise!)).toHaveBeenCalledTimes(3);
  });

  it("uses workflow.planner harness for draft while planner adapter supplies supervise", async () => {
    const harnessPlannerLwir = (): LwirWorkflow => ({
      ...simpleLwir(),
      metadata: {
        ...simpleLwir().metadata,
        name: "outer-loop-test.harness-planner",
        description: "Outer-loop workflow with harness-based planner drafting.",
      },
    });

    const plannerHarnessRun = vi.fn<Harness["run"]>(async (task) => {
      if (task.kind === "plan") {
        return { kind: "plan", lwir: harnessPlannerLwir() };
      }
      return { kind: "delegate_to_default" };
    });

    const workflowWithHarnessPlanner = createLittleWorkflow({
      id: "outer-loop-test.harness-planner",
      description: "Outer-loop workflow with harness-based planner drafting.",
      inputSchema: simpleInputSchema,
      output: output.object({ schema: simpleOutputSchema }),
      models: [model({ provider: "mock", modelId: "planner-harness" }, { id: "model.planner" })],
      planner: {
        model: { provider: "mock", modelId: "planner-harness" },
        harness: {
          harnessId: "testPlannerHarness@1.0.0",
          run: plannerHarnessRun,
        },
      },
      globalTools: ["process"],
    });

    const planner = {
      draft: vi.fn(async () => {
        throw new Error("legacy planner draft should not be called when workflow.planner is configured");
      }),
      supervise: vi.fn(async (state: SuperviseOuterLoopState) => {
        return state.cycles.length < 2
          ? ({ kind: "continue" } as SuperviseDecision)
          : ({ kind: "done", finalOutput: { result: "harness-final" } } as SuperviseDecision);
      }),
    } satisfies PlannerAdapter;

    const result = await runWorkflow({
      world,
      workflows: workflowWithHarnessPlanner,
      input: { value: "harness" },
      planner,
      tools: simpleToolRegistry,
      maxOuterCycles: 3,
    });

    expect(result.status).toBe("completed");
    expect(result.output).toEqual({ result: "harness-final" });
    expect(plannerHarnessRun).toHaveBeenCalledTimes(2);
    expect(vi.mocked(planner.draft)).not.toHaveBeenCalled();
    expect(vi.mocked(planner.supervise)).toHaveBeenCalledTimes(2);
  });

  it("fails with outer_loop_exhausted when supervise always returns continue", async () => {
    const planner = plannerWithSupervise([
      { kind: "continue" },
      { kind: "continue" },
    ]);

    let caught: RunFailedError | undefined;
    try {
      await runWorkflow({
        world,
        workflows: simpleWorkflow,
        input: { value: "test" },
        planner,
        tools: simpleToolRegistry,
        maxOuterCycles: 2,
      });
    } catch (err) {
      caught = err as RunFailedError;
    }

    expect(caught).toBeDefined();
    expect(caught).toBeInstanceOf(RunFailedError);
    expect(caught?.causeCode).toBe("outer_loop_exhausted");
    // Spec §3.4 step 7: structured fields on RunFailedError for outer_loop_exhausted.
    expect(caught?.outerLoopId).toMatch(/^ol_/u);
    expect(caught?.lastCycleOutput).toEqual({ result: "processed:test" });
  });

  it("each cycle's OrchestrationRequest carries outerLoop context with correct fields", async () => {
    const draftRequests: unknown[] = [];
    const planner: PlannerAdapter = {
      draft: vi.fn(async (request) => {
        draftRequests.push(request);
        return simpleLwir();
      }),
      supervise: vi.fn(async (_state) => {
        if (draftRequests.length < 3) {
          return { kind: "continue" } as SuperviseDecision;
        }
        return { kind: "done", finalOutput: { result: "ok" } } as SuperviseDecision;
      }),
    };

    await runWorkflow({
      world,
      workflows: simpleWorkflow,
      input: { value: "ctx-test" },
      planner,
      tools: simpleToolRegistry,
      maxOuterCycles: 3,
    });

    expect(draftRequests).toHaveLength(3);

    const req1 = (draftRequests[0] as { outerLoop?: unknown }).outerLoop as {
      cycleNumber: number;
      maxCycles: number;
      isFinalCycle: boolean;
      priorCycles: unknown[];
    };
    expect(req1.cycleNumber).toBe(1);
    expect(req1.maxCycles).toBe(3);
    expect(req1.isFinalCycle).toBe(false);
    expect(req1.priorCycles).toEqual([]);

    const req2 = (draftRequests[1] as { outerLoop?: unknown }).outerLoop as typeof req1;
    expect(req2.cycleNumber).toBe(2);
    expect(req2.isFinalCycle).toBe(false);
    expect(req2.priorCycles).toHaveLength(1);

    const req3 = (draftRequests[2] as { outerLoop?: unknown }).outerLoop as typeof req1;
    expect(req3.cycleNumber).toBe(3);
    expect(req3.isFinalCycle).toBe(true);
    expect(req3.priorCycles).toHaveLength(2);
  });

  it("appends OuterLoopCycleCompleted event at end of each cycle's run", async () => {
    const cycleRunIds: string[] = [];
    const planner: PlannerAdapter = {
      draft: vi.fn(async () => simpleLwir()),
      supervise: vi.fn(async (state) => {
        // Capture the runId from the last cycle's entry
        const lastCycle = state.cycles[state.cycles.length - 1];
        if (lastCycle) {
          cycleRunIds.push(lastCycle.runId);
        }
        if (state.cycles.length >= 2) {
          return { kind: "done", finalOutput: { result: "done" } } as SuperviseDecision;
        }
        return { kind: "continue" } as SuperviseDecision;
      }),
    };

    await runWorkflow({
      world,
      workflows: simpleWorkflow,
      input: { value: "events-test" },
      planner,
      tools: simpleToolRegistry,
      maxOuterCycles: 3,
    });

    expect(cycleRunIds).toHaveLength(2);

    for (const runId of cycleRunIds) {
      const events = await listEvents(world, runId);
      const completedEvent = events.find((e) => e.type === "OuterLoopCycleCompleted");
      expect(completedEvent).toBeDefined();
      expect(completedEvent?.payload).toEqual(
        expect.objectContaining({
          outerLoopId: expect.stringMatching(/^ol_/u),
          cycleNumber: expect.any(Number),
          supervise: expect.objectContaining({ kind: expect.stringMatching(/continue|done/u) }),
        }),
      );
    }
  });

  it("writes outer-loops/{id}.json manifest after each cycle", async () => {
    const capturedRunIds: string[] = [];
    const planner: PlannerAdapter = {
      draft: vi.fn(async () => simpleLwir()),
      supervise: vi.fn(async (state) => {
        // Capture all runIds seen so far
        for (const c of state.cycles) {
          if (!capturedRunIds.includes(c.runId)) {
            capturedRunIds.push(c.runId);
          }
        }
        if (state.cycles.length >= 2) {
          return { kind: "done", finalOutput: { result: "final" } } as SuperviseDecision;
        }
        return { kind: "continue" } as SuperviseDecision;
      }),
    };

    await runWorkflow({
      world,
      workflows: simpleWorkflow,
      input: { value: "manifest-test" },
      planner,
      tools: simpleToolRegistry,
      maxOuterCycles: 3,
    });

    // Find the outer-loop id from the OuterLoopCycleCompleted events (appended after supervise)
    expect(capturedRunIds).toHaveLength(2);
    const cycle1Events = await listEvents(world, capturedRunIds[0]!);
    const completedEvt = cycle1Events.find((e) => e.type === "OuterLoopCycleCompleted");
    expect(completedEvt).toBeDefined();
    const capturedOuterLoopId = completedEvt?.payload.outerLoopId as string;
    expect(capturedOuterLoopId).toMatch(/^ol_/u);

    const manifestPath = join(tmpDir, "outer-loops", `${capturedOuterLoopId}.json`);
    expect(existsSync(manifestPath)).toBe(true);

    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      outerLoopId: string;
      maxCycles: number;
      cycles: unknown[];
      result?: { kind: string };
    };
    expect(manifest.outerLoopId).toBe(capturedOuterLoopId);
    expect(manifest.maxCycles).toBe(3);
    expect(manifest.cycles).toHaveLength(2);
    expect(manifest.result?.kind).toBe("done");
  });

  it("folds promptNote from continue into the next cycle's OrchestrationRequest system message", async () => {
    const draftRequests: Array<{ messages?: { system?: string } }> = [];
    const planner: PlannerAdapter = {
      draft: vi.fn(async (request) => {
        draftRequests.push(request as { messages?: { system?: string } });
        return simpleLwir();
      }),
      supervise: vi.fn(async (state) => {
        if (state.cycles.length >= 2) {
          return { kind: "done", finalOutput: { result: "done" } } as SuperviseDecision;
        }
        return {
          kind: "continue",
          promptNote: "try harder next time",
        } as SuperviseDecision;
      }),
    };

    await runWorkflow({
      world,
      workflows: simpleWorkflow,
      input: { value: "prompt-note-test" },
      planner,
      tools: simpleToolRegistry,
      maxOuterCycles: 3,
    });

    expect(draftRequests).toHaveLength(2);
    // First cycle: no system message
    expect(draftRequests[0]?.messages?.system).toBeUndefined();
    // Second cycle: system message uses the exact separator from Spec §3.4 step 6.
    expect(draftRequests[1]?.messages?.system).toContain(
      "\n\n--- Prior cycle note ---\ntry harder next time",
    );
  });
});

// ── Layer B §3.6 — Replay across outer-loop cycle boundaries ──────────────────

describe("outer-loop replay (Layer B §3.6)", () => {
  it("returns the recorded finalOutput when the manifest already shows done — no draft() calls", async () => {
    // Pre-write a completed manifest. No event logs exist.
    const outerLoopId = "ol_replaydonetest00000000000000000000000";
    const fakeRunId = "run_replaydonerun00000000000000000000";
    const planner = plannerWithSupervise([]);

    await writeOuterLoopManifest(world, outerLoopId, {
      outerLoopId,
      goal: {
        workflowDefinitionHash: simpleWorkflowDefinitionHash(),
        description: "outer-loop-test.simple",
      },
      maxCycles: 3,
      cycles: [
        {
          cycleNumber: 1,
          runId: fakeRunId,
          workflowVersionId: "wv_fake",
          status: "completed",
          output: { result: "cached-answer" },
        },
      ],
      result: { kind: "done", finalOutput: { value: 42 } },
    });

    const result = await runWorkflow({
      world,
      workflows: simpleWorkflow,
      input: { value: "ignored" },
      planner,
      tools: simpleToolRegistry,
      maxOuterCycles: 3,
      outerLoopId,
    });

    // The manifest already records done — return immediately, no re-running.
    expect(result.status).toBe("completed");
    expect(result.output).toEqual({ value: 42 });
    expect(vi.mocked(planner.draft)).not.toHaveBeenCalled();
    expect(vi.mocked(planner.supervise!)).not.toHaveBeenCalled();
  });

  it("replays done manifests without requiring planner.supervise", async () => {
    const outerLoopId = "ol_replaydonewithoutsupervise000000000";
    const fakeRunId = "run_replaydonewithoutsupervise000000000";
    const planner = plannerWithoutSupervise();

    await writeOuterLoopManifest(world, outerLoopId, {
      outerLoopId,
      goal: {
        workflowDefinitionHash: simpleWorkflowDefinitionHash(),
        description: "outer-loop-test.simple",
      },
      maxCycles: 3,
      cycles: [
        {
          cycleNumber: 1,
          runId: fakeRunId,
          workflowVersionId: "wv_fake",
          status: "completed",
          output: { result: "cached-answer" },
        },
      ],
      result: { kind: "done", finalOutput: { value: "from-manifest" } },
    });

    const result = await runWorkflow({
      world,
      workflows: simpleWorkflow,
      input: { value: "ignored" },
      planner,
      tools: simpleToolRegistry,
      maxOuterCycles: 3,
      outerLoopId,
    });

    expect(result.status).toBe("completed");
    expect(result.output).toEqual({ value: "from-manifest" });
    expect(vi.mocked(planner.draft)).not.toHaveBeenCalled();
  });

  it("resumes between cycles: cycle 1 done and manifest persisted, cycle 2 runs on resume", async () => {
    // Simulate "killed between cycles" by:
    // 1. Running a full first invocation (cycle 1 completes, supervise=continue,
    //    manifest written with cycles=[1], no result). The loop then exhausts
    //    because maxOuterCycles=2 and isFinalCycle is true for cycle 2...
    //    Actually we need the manifest to have cycles=[1] without result.
    //    Strategy: run with maxOuterCycles=2, supervise[0]=continue. The loop
    //    writes manifest with cycles=[1] and no result, then starts cycle 2.
    //    We stop that by making the cycle 2 draft() throw — but that would leave
    //    a pendingCycleRunId in the manifest.
    //
    // Cleanest approach: run first call with maxOuterCycles=3, supervise=[continue,done].
    // Capture the outerLoopId. Then call runWorkflow with the same outerLoopId
    // and a new planner — since the manifest has result=done, it returns immediately.
    //
    // For a true "starts from cycle 2" test without running cycle 1 again, we
    // pre-write the manifest with cycles=[cycle1Summary] and no result, simulating
    // a state where cycle 1 completed but the process died after writing the manifest
    // but before starting cycle 2 (i.e., pendingCycleRunId is absent).

    const outerLoopId = "ol_betweencyclesresume00000000000000000";

    // Simulate a real cycle 1 run: run a single-cycle workflow and capture the
    // run result. We use a separate world for this "setup" run.
    // Instead, directly pre-write the manifest and event log.

    // Pre-inject cycle 1 event log. The runtime will accept a pre-written
    // RunCompleted event for a runId as a completed run.
    // We write the manifest with cycles=[{cycleNumber:1, runId, ...}].
    // No pendingCycleRunId — the crash happened after cycle 1 completed but
    // before cycle 2 started.

    // We don't need a real event log for cycle 1 since it's not replayed
    // in the second call (cycles=1 means cycleNumber starts at 2 in the loop).
    const cycle1RunId = "run_betweencycles1run000000000000000000";
    const fakeWvId = "wv_betweencycles1fake0000000000000000";

    await writeOuterLoopManifest(world, outerLoopId, {
      outerLoopId,
      goal: {
        workflowDefinitionHash: simpleWorkflowDefinitionHash(),
        description: "outer-loop-test.simple",
      },
      maxCycles: 3,
      cycles: [
        {
          cycleNumber: 1,
          runId: cycle1RunId,
          workflowVersionId: fakeWvId,
          status: "completed",
          output: { result: "processed:cycle1" },
        },
      ],
      // no result (cycle 1 completed with continue, cycle 2 not yet started)
      // no pendingCycleRunId (crash happened BETWEEN cycles, not mid-cycle)
    });

    // Second call: the manifest has cycles=[1], no pendingCycleRunId.
    // The loop should start at cycleNumber=2 (cycles.length+1).
    const resumePlanner = plannerWithSupervise([
      { kind: "done", finalOutput: { result: "cycle-2-answer" } },
    ]);

    const result = await runWorkflow({
      world,
      workflows: simpleWorkflow,
      input: { value: "resume-test" },
      planner: resumePlanner,
      tools: simpleToolRegistry,
      maxOuterCycles: 3,
      outerLoopId,
    });

    expect(result.status).toBe("completed");
    expect(result.output).toEqual({ result: "cycle-2-answer" });
    // draft() called exactly once — for cycle 2 only (cycle 1 seeded from manifest)
    expect(vi.mocked(resumePlanner.draft)).toHaveBeenCalledTimes(1);
    // supervise() called exactly once — for cycle 2 only
    expect(vi.mocked(resumePlanner.supervise!)).toHaveBeenCalledTimes(1);
    // The supervise state for cycle 2 should include cycle 1 from the manifest
    const superviseArg = vi.mocked(resumePlanner.supervise!).mock.calls[0]![0];
    expect(superviseArg.cycles).toHaveLength(2);
    expect(superviseArg.cycles[0]!.cycleNumber).toBe(1);
    expect(superviseArg.cycles[1]!.cycleNumber).toBe(2);
  });

  it("resumes mid-cycle (crash before steps): manifest has pendingCycleRunId with no prior events, Layer A runs cycle fresh", async () => {
    // Simulate a crash that happened AFTER pendingCycleRunId was written to the
    // manifest but BEFORE any run events were committed (e.g., crash during compile).
    // On resume: the outer loop reuses pendingCycleRunId, finds no events,
    // compiles and runs the cycle from scratch — writing events under that runId.

    const outerLoopId = "ol_midcycleresumetest00000000000000000";
    const pendingRunId = "run_midcyclependingrun00000000000000";

    // Pre-write manifest with pendingCycleRunId. No events for pendingRunId.
    await writeOuterLoopManifest(world, outerLoopId, {
      outerLoopId,
      goal: {
        workflowDefinitionHash: simpleWorkflowDefinitionHash(),
        description: "outer-loop-test.simple",
      },
      maxCycles: 3,
      cycles: [], // cycle 1 has not completed
      pendingCycleRunId: pendingRunId,
    });

    const planner = plannerWithSupervise([
      { kind: "done", finalOutput: { result: "mid-cycle-resume-output" } },
    ]);

    const result = await runWorkflow({
      world,
      workflows: simpleWorkflow,
      input: { value: "mid-cycle" },
      planner,
      tools: simpleToolRegistry,
      maxOuterCycles: 3,
      outerLoopId,
    });

    expect(result.status).toBe("completed");
    expect(result.output).toEqual({ result: "mid-cycle-resume-output" });

    // Verify events were written under the PERSISTED pendingRunId, not a fresh one.
    const resumedEvents = await listEvents(world, pendingRunId);
    expect(resumedEvents.some((e) => e.type === "RunStarted")).toBe(true);
    expect(resumedEvents.some((e) => e.type === "RunCompleted")).toBe(true);
    expect(resumedEvents.some((e) => e.type === "OuterLoopCycleCompleted")).toBe(true);

    // draft() called once (for the resumed cycle 1).
    expect(vi.mocked(planner.draft)).toHaveBeenCalledTimes(1);
    // supervise() called once (after cycle 1 completes).
    expect(vi.mocked(planner.supervise!)).toHaveBeenCalledTimes(1);

    // The manifest must NOT have pendingCycleRunId after completion.
    const manifestPath = join(tmpDir, "outer-loops", `${outerLoopId}.json`);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      pendingCycleRunId?: string;
      result?: { kind: string };
    };
    expect(manifest.pendingCycleRunId).toBeUndefined();
    expect(manifest.result?.kind).toBe("done");
  });

  it("resumes mid-cycle (crash after RunCompleted, before OuterLoopCycleCompleted): Layer A detects RunCompleted and skips re-execution", async () => {
    // Simulate a crash that happened AFTER a cycle's RunCompleted event was committed
    // but BEFORE OuterLoopCycleCompleted was appended (and before the manifest was
    // updated). This means:
    //   - cycles=[] (cycle 1 never finished from the outer loop's perspective)
    //   - pendingCycleRunId = cycle1RunId (set before the cycle started)
    //   - cycle1RunId event log has RunCompleted (all steps finished)
    //
    // On resume: outer loop reuses cycle1RunId, existingTerminalCompletion
    // detects RunCompleted and returns the cached result WITHOUT re-calling tools
    // or re-compiling (draft is not called), then appends OuterLoopCycleCompleted
    // and calls supervise.

    // Step 1: Run a single outer-loop cycle to produce real committed events.
    // We capture the runId from the result.
    const setupPlanner = plannerWithSupervise([
      { kind: "done", finalOutput: { result: "cycle1-setup" } },
    ]);
    const setupResult = await runWorkflow({
      world,
      workflows: simpleWorkflow,
      input: { value: "mid-cycle-step" },
      planner: setupPlanner,
      tools: simpleToolRegistry,
      maxOuterCycles: 2,
    });
    expect(setupResult.status).toBe("completed");
    const cycle1RunId = setupResult.runId;

    // Verify cycle1RunId has RunCompleted in its event log.
    const cycle1Events = await listEvents(world, cycle1RunId);
    expect(cycle1Events.some((e) => e.type === "RunCompleted")).toBe(true);
    expect(cycle1Events.some((e) => e.type === "OuterLoopCycleCompleted")).toBe(true);

    // Simulate the exact crash topology: RunCompleted is committed but
    // OuterLoopCycleCompleted is NOT. Use the medium-agnostic crash seam to
    // drop everything after the last event that precedes OuterLoopCycleCompleted,
    // matching what the test name claims ("before OuterLoopCycleCompleted").
    //
    // Tripwire: in runWorkflow's commit order, OuterLoopCycleCompleted is the
    // LAST event of the cycle. If that ever changes, dropping "everything after
    // the last non-OuterLoopCycleCompleted event" would no longer faithfully
    // reproduce the crash topology, so assert it explicitly before truncating.
    const lastNonCompletedIndex = cycle1Events.reduce(
      (acc, event, index) => (event.type === "OuterLoopCycleCompleted" ? acc : index),
      -1,
    );
    expect(lastNonCompletedIndex).toBe(cycle1Events.length - 2);
    expect(cycle1Events[cycle1Events.length - 1]!.type).toBe("OuterLoopCycleCompleted");
    const keepThroughSequence = cycle1Events[lastNonCompletedIndex]!.sequence;
    await truncateEventLogForTest(world, cycle1RunId, keepThroughSequence);

    // Confirm the truncation worked: OuterLoopCycleCompleted is now absent.
    const eventsAfterStrip = await listEvents(world, cycle1RunId);
    expect(eventsAfterStrip.some((e) => e.type === "RunCompleted")).toBe(true);
    expect(eventsAfterStrip.some((e) => e.type === "OuterLoopCycleCompleted")).toBe(false);

    // Step 2: Set up a new outer-loop with a fresh outerLoopId. Write a manifest
    // that simulates: cycle 1 was pending (crash after RunCompleted, before
    // OuterLoopCycleCompleted). The pendingCycleRunId points to cycle1RunId
    // which already has RunCompleted events.
    const resumeOuterLoopId = "ol_midcycleafterrunresume000000000000";
    await writeOuterLoopManifest(world, resumeOuterLoopId, {
      outerLoopId: resumeOuterLoopId,
      goal: {
        workflowDefinitionHash: simpleWorkflowDefinitionHash(),
        description: "outer-loop-test.simple",
      },
      maxCycles: 3,
      cycles: [], // cycle 1 never recorded in manifest (crash before OuterLoopCycleCompleted)
      pendingCycleRunId: cycle1RunId, // but its events ARE committed
    });

    // Step 3: Resume. Track tool invocations to verify no re-execution.
    const toolCallCount = { count: 0 };
    const countingToolRegistry = createToolRegistry();
    countingToolRegistry.register("process", {
      description: "Process a value.",
      inputSchema: simpleInputSchema,
      execute: async (input) => {
        toolCallCount.count++;
        const { value } = input as { value: string };
        return { result: `processed:${value}` };
      },
    });

    const resumePlanner = plannerWithSupervise([
      { kind: "done", finalOutput: { result: "resumed-no-reexecution" } },
    ]);

    const resumeResult = await runWorkflow({
      world,
      workflows: simpleWorkflow,
      input: { value: "mid-cycle-step" },
      planner: resumePlanner,
      tools: countingToolRegistry,
      maxOuterCycles: 3,
      outerLoopId: resumeOuterLoopId,
    });

    expect(resumeResult.status).toBe("completed");
    expect(resumeResult.output).toEqual({ result: "resumed-no-reexecution" });

    // Tool must NOT have been called — Layer A returned cached RunCompleted result.
    expect(toolCallCount.count).toBe(0);
    // draft() is NOT called: existingTerminalCompletion returns before compile.
    expect(vi.mocked(resumePlanner.draft)).not.toHaveBeenCalled();
    // supervise() called once (after cycle 1's result was recovered).
    expect(vi.mocked(resumePlanner.supervise!)).toHaveBeenCalledTimes(1);

    // The manifest must show cycle 1 recorded and no pendingCycleRunId.
    const manifestPath = join(tmpDir, "outer-loops", `${resumeOuterLoopId}.json`);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      cycles: Array<{ cycleNumber: number }>;
      pendingCycleRunId?: string;
      result?: { kind: string };
    };
    expect(manifest.pendingCycleRunId).toBeUndefined();
    expect(manifest.result?.kind).toBe("done");
    expect(manifest.cycles).toHaveLength(1);
    expect(manifest.cycles[0]!.cycleNumber).toBe(1);
  });

  // ── Spec §3.5 — outerLoopId in RunStarted payload ──────────────────────────

  it("RunStarted.payload.outerLoopId is set for each cycle of an outer-loop run", async () => {
    const runIds: string[] = [];
    const planner: PlannerAdapter = {
      draft: vi.fn(async () => simpleLwir()),
      supervise: vi.fn(async (state) => {
        if (state.cycles.length >= 2) {
          return { kind: "done", finalOutput: { result: "done" } } as SuperviseDecision;
        }
        return { kind: "continue" } as SuperviseDecision;
      }),
    };

    const result = await runWorkflow({
      world,
      workflows: simpleWorkflow,
      input: { value: "outer-loop-id-test" },
      planner,
      tools: simpleToolRegistry,
      maxOuterCycles: 3,
    });

    expect(result.status).toBe("completed");

    // Collect the runIds from the manifest to look up events.
    const manifestPath = join(tmpDir, "outer-loops");
    const manifestFiles = (await import("node:fs")).readdirSync(manifestPath);
    expect(manifestFiles.length).toBe(1);
    const manifest = JSON.parse(
      (await import("node:fs")).readFileSync(join(manifestPath, manifestFiles[0]!), "utf8"),
    ) as { outerLoopId: string; cycles: Array<{ runId: string }> };
    const outerLoopId = manifest.outerLoopId;
    for (const cycle of manifest.cycles) {
      runIds.push(cycle.runId);
    }

    // Each cycle's event log must have RunStarted with outerLoopId set.
    for (const runId of runIds) {
      const events = await listEvents(world, runId);
      const runStarted = events.find((e) => e.type === "RunStarted");
      expect(runStarted).toBeDefined();
      expect((runStarted!.payload as { outerLoopId?: string }).outerLoopId).toBe(outerLoopId);
    }
  });

  it("RunStarted.payload.outerLoopId is absent for a single-cycle run", async () => {
    const planner = plannerWithoutSupervise();

    const result = await runWorkflow({
      world,
      workflows: simpleWorkflow,
      input: { value: "single-cycle-test" },
      planner,
      tools: simpleToolRegistry,
    });

    expect(result.status).toBe("completed");
    const events = await listEvents(world, result.runId);
    const runStarted = events.find((e) => e.type === "RunStarted");
    expect(runStarted).toBeDefined();
    expect((runStarted!.payload as { outerLoopId?: string }).outerLoopId).toBeUndefined();
  });

  it("manifest writes pendingCycleRunId before each cycle and clears it after", async () => {
    // Verify the manifest lifecycle: pendingCycleRunId is written before the cycle
    // and absent after. We do this by intercepting the manifest read after each cycle.
    const draftRunIds: string[] = [];
    let capturedOuterLoopId: string | undefined;

    const planner: PlannerAdapter = {
      draft: vi.fn(async () => simpleLwir()),
      supervise: vi.fn(async (state) => {
        // Capture the outerLoopId via the last cycle's runId.
        if (!capturedOuterLoopId && state.cycles.length > 0) {
          const lastRunId = state.cycles[state.cycles.length - 1]!.runId;
          draftRunIds.push(lastRunId);
          // We'll look up the outerLoopId from events after the test.
        }
        if (state.cycles.length >= 2) {
          return { kind: "done", finalOutput: { result: "done" } } as SuperviseDecision;
        }
        return { kind: "continue" } as SuperviseDecision;
      }),
    };

    await runWorkflow({
      world,
      workflows: simpleWorkflow,
      input: { value: "manifest-lifecycle" },
      planner,
      tools: simpleToolRegistry,
      maxOuterCycles: 3,
    });

    // Get the outerLoopId from the event log.
    expect(draftRunIds.length).toBeGreaterThan(0);
    const firstRunId = draftRunIds[0]!;
    const events = await listEvents(world, firstRunId);
    const completedEvt = events.find((e) => e.type === "OuterLoopCycleCompleted");
    expect(completedEvt).toBeDefined();
    capturedOuterLoopId = completedEvt?.payload.outerLoopId as string;

    // After the loop completes, the manifest must NOT have pendingCycleRunId.
    const manifestPath = join(tmpDir, "outer-loops", `${capturedOuterLoopId}.json`);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      pendingCycleRunId?: string;
      result?: { kind: string };
    };
    expect(manifest.pendingCycleRunId).toBeUndefined();
    expect(manifest.result?.kind).toBe("done");
  });

  it("surfaces outer_loop_exhausted when crash occurs between final-cycle manifest write and error throw (Spec §3.4)", async () => {
    // Simulate a process kill AFTER the final cycle's manifest was written with
    // cycles.length === maxOuterCycles but result === undefined, and BEFORE
    // buildOuterLoopExhaustedError was thrown. On resume, the for-loop guard
    // fails immediately (cycleNumber starts at cycles.length + 1 = 3 > 2).
    // The recovery path must detect this and throw the exhausted error.
    //
    // Note: runWorkflow only calls runOuterLoop when maxOuterCycles > 1,
    // so we use maxOuterCycles: 2 (the minimum for the outer-loop path).

    const outerLoopId = "ol_exhaustedcrashrecovery000000000000";
    const cycle1RunId = "run_exhaustedcrashcycle1000000000000";
    const cycle2RunId = "run_exhaustedcrashcycle2000000000000";
    const fakeWvId = "wv_exhaustedcrashfake0000000000000000";
    const lastCycleOutput = { result: "final-cycle-output" };

    // Pre-inject the final cycle's manifest: cycles.length === maxOuterCycles === 2,
    // result is absent (crash after manifest write, before error throw).
    await writeOuterLoopManifest(world, outerLoopId, {
      outerLoopId,
      goal: {
        workflowDefinitionHash: simpleWorkflowDefinitionHash(),
        description: "outer-loop-test.simple",
      },
      maxCycles: 2,
      cycles: [
        {
          cycleNumber: 1,
          runId: cycle1RunId,
          workflowVersionId: fakeWvId,
          status: "completed",
          output: { result: "cycle-1-output" },
        },
        {
          cycleNumber: 2,
          runId: cycle2RunId,
          workflowVersionId: fakeWvId,
          status: "completed",
          output: lastCycleOutput,
        },
      ],
      // no result — simulates crash after manifest write, before error throw
    });

    // Pre-inject the OuterLoopCycleCompleted event for the final cycle (supervise: continue).
    await appendEvent(world, cycle2RunId, {
      type: "OuterLoopCycleCompleted",
      payload: {
        outerLoopId,
        cycleNumber: 2,
        supervise: { kind: "continue" },
      },
    });

    // Resume: planner has no supervise decisions because the loop is already
    // at maxOuterCycles, and the recovery path triggers before any cycle runs.
    const planner = plannerWithSupervise([]);

    let caught: RunFailedError | undefined;
    try {
      await runWorkflow({
        world,
        workflows: simpleWorkflow,
        input: { value: "crash-recovery" },
        planner,
        tools: simpleToolRegistry,
        maxOuterCycles: 2,
        outerLoopId,
      });
    } catch (err) {
      caught = err as RunFailedError;
    }

    expect(caught).toBeDefined();
    expect(caught).toBeInstanceOf(RunFailedError);
    expect(caught?.causeCode).toBe("outer_loop_exhausted");
    // draft() and supervise() must not have been called — recovery is immediate.
    expect(vi.mocked(planner.draft)).not.toHaveBeenCalled();
    expect(vi.mocked(planner.supervise!)).not.toHaveBeenCalled();
    // Structured fields from Spec §3.4 step 7.
    expect(caught?.outerLoopId).toBe(outerLoopId);
    expect(caught?.lastCycleOutput).toEqual(lastCycleOutput);
  });
});

// ── Gap 3: Layer A failure → Layer B supervise interaction (Spec §3.6) ───────

describe("Layer A failure → Layer B supervise (Spec §3.6)", () => {
  it("invokes supervise with failed cycle when Layer A fails due to max_visits_exceeded, and supervise can rescue the run", async () => {
    // Layer A LWIR: worker (maxVisits:2) → review (maxVisits:2) → route (maxVisits:3)
    // review tool always returns { passed: false }, so route always sends back to worker.
    // After worker.visit[1] completes and review.visit[1] returns { passed: false },
    // route tries to re-visit worker for a third time — exceeding maxVisits:2 → max_visits_exceeded.
    //
    // The outer-loop catches RunFailedError from the cycle and builds a "failed"
    // cycle summary. Supervise is then called with that failed cycle in state.cycles,
    // and we have it return { kind: "done", finalOutput: { rescued: true } }.

    const workerTool = vi.fn(async () => ({ work: "done" }));
    const reviewTool = vi.fn(async () => ({ passed: false }));

    const loopLwir: LwirWorkflow = {
      apiVersion: "littleworkflow.dev/v0.1",
      kind: "Workflow",
      metadata: { name: "outer-loop-test.loop-fail" },
      input: { schema: { type: "object" } },
      output: { schema: { type: "object" } },
      permissions: { tools: ["worker", "review"], models: [], secrets: [], network: [] },
      steps: [
        {
          id: "worker",
          uses: "tool.call",
          with: { tool: "worker" },
          maxVisits: 2,
          output: { mode: "object", schema: { type: "object" } },
        },
        {
          id: "review",
          uses: "tool.call",
          needs: ["worker"],
          with: { tool: "review" },
          maxVisits: 2,
          output: { mode: "object", schema: { type: "object" } },
        },
        {
          id: "route",
          uses: "decision",
          needs: ["review"],
          maxVisits: 3,
          with: {
            cases: [{ when: "{{ steps.review.lastOutput.passed }}", to: "end" }],
            default: "worker",
          },
        },
      ],
    };

    const loopToolRegistry = createToolRegistry();
    loopToolRegistry.register("worker", {
      description: "Worker step.",
      inputSchema: { type: "object" },
      execute: workerTool,
    });
    loopToolRegistry.register("review", {
      description: "Review step.",
      inputSchema: { type: "object" },
      execute: reviewTool,
    });

    // Planner that always returns the failing LWIR.
    // supervise: after cycle 1 fails, rescue with done.
    let superviseCallCount = 0;
    const planner: PlannerAdapter = {
      draft: vi.fn(async () => loopLwir),
      supervise: vi.fn(async (state) => {
        superviseCallCount++;
        // Verify cycle 1 is in state with status "failed".
        expect(state.cycles).toHaveLength(1);
        expect(state.cycles[0]!.status).toBe("failed");
        expect(state.cycles[0]!.output).toBeNull();
        return { kind: "done", finalOutput: { rescued: true } } as SuperviseDecision;
      }),
    };

    // Use a workflow without globalTools so snapshotWorkflowDefinition does not
    // try to look up "process" in loopToolRegistry (which only has worker/review).
    // The planner's draft() overrides the LWIR entirely; the workflow definition
    // here only supplies input/output schema.
    const loopWorkflow = createLittleWorkflow({
      id: "outer-loop-test.loop-fail",
      inputSchema: { type: "object" } as const,
      output: output.object({ schema: { type: "object" } as const }),
    } as unknown as Parameters<typeof createLittleWorkflow>[0]);

    const result = await runWorkflow({
      world,
      workflows: loopWorkflow,
      input: {},
      planner,
      tools: loopToolRegistry,
      maxOuterCycles: 3,
    });

    expect(result.status).toBe("completed");
    expect(result.output).toEqual({ rescued: true });
    // supervise called exactly once (after cycle 1 failed).
    expect(superviseCallCount).toBe(1);
    expect(vi.mocked(planner.supervise!)).toHaveBeenCalledTimes(1);
  });
});

// ── Gap 4: workflowDefinitionHash alignment ────────────────────────────────────

describe("Gap 4 — goal.workflowDefinitionHash matches request.locks.workflowDefinitionHash", () => {
  it("state.goal.workflowDefinitionHash equals the hash in each cycle's OrchestrationRequest.locks", async () => {
    const capturedRequestHashes: string[] = [];
    const capturedGoalHashes: string[] = [];

    const planner: PlannerAdapter = {
      draft: vi.fn(async (request) => {
        const req = request as { locks?: { workflowDefinitionHash?: string } };
        if (req.locks?.workflowDefinitionHash !== undefined) {
          capturedRequestHashes.push(req.locks.workflowDefinitionHash);
        }
        return simpleLwir();
      }),
      supervise: vi.fn(async (state) => {
        capturedGoalHashes.push(state.goal.workflowDefinitionHash);
        if (state.cycles.length >= 2) {
          return { kind: "done", finalOutput: { result: "ok" } } as SuperviseDecision;
        }
        return { kind: "continue" } as SuperviseDecision;
      }),
    };

    await runWorkflow({
      world,
      workflows: simpleWorkflow,
      input: { value: "hash-alignment-test" },
      planner,
      tools: simpleToolRegistry,
      maxOuterCycles: 3,
    });

    // Both collections should be non-empty.
    expect(capturedRequestHashes.length).toBeGreaterThan(0);
    expect(capturedGoalHashes.length).toBeGreaterThan(0);

    // Every request hash should equal every goal hash (same workflow, same tools).
    const expectedHash = capturedRequestHashes[0]!;
    for (const h of capturedRequestHashes) {
      expect(h).toBe(expectedHash);
    }
    for (const h of capturedGoalHashes) {
      expect(h).toBe(expectedHash);
    }
  });
});

// ── Gap 5: cycle summary populated from prior promptNote ──────────────────────

describe("Gap 5 — cycle summary populated from prior promptNote", () => {
  it("cycle N's summary equals the promptNote returned by supervise for cycle N", async () => {
    const superviseArgs: SuperviseOuterLoopState[] = [];

    const planner: PlannerAdapter = {
      draft: vi.fn(async () => simpleLwir()),
      supervise: vi.fn(async (state) => {
        superviseArgs.push(state);
        if (state.cycles.length === 1) {
          return { kind: "continue", promptNote: "focus on candidate scores" } as SuperviseDecision;
        }
        return { kind: "done", finalOutput: { result: "done" } } as SuperviseDecision;
      }),
    };

    await runWorkflow({
      world,
      workflows: simpleWorkflow,
      input: { value: "summary-test" },
      planner,
      tools: simpleToolRegistry,
      maxOuterCycles: 3,
    });

    // supervise is called twice: once after cycle 1 (continue), once after cycle 2 (done).
    expect(superviseArgs).toHaveLength(2);

    // The first supervise call sees only cycle 1, with no summary yet (supervise hasn't decided).
    expect(superviseArgs[0]!.cycles).toHaveLength(1);
    expect(superviseArgs[0]!.cycles[0]!.summary).toBeUndefined();

    // The second supervise call sees cycles 1 and 2.
    // Cycle 1's summary should be the promptNote from the first supervise decision.
    expect(superviseArgs[1]!.cycles).toHaveLength(2);
    expect(superviseArgs[1]!.cycles[0]!.summary).toBe("focus on candidate scores");
    // Cycle 2 has no summary yet (its supervise hasn't returned yet).
    expect(superviseArgs[1]!.cycles[1]!.summary).toBeUndefined();
  });
});

// ── Gap 6: deduplicate OuterLoopCycleCompleted on crash recovery ───────────────

describe("Gap 6 — OuterLoopCycleCompleted deduplication on crash recovery", () => {
  it("does not append a second OuterLoopCycleCompleted when one for the cycleNumber already exists", async () => {
    // Step 1: run a real cycle to get a committed event log with OuterLoopCycleCompleted.
    const setupPlanner = plannerWithSupervise([
      { kind: "done", finalOutput: { result: "setup-done" } },
    ]);
    const setupResult = await runWorkflow({
      world,
      workflows: simpleWorkflow,
      input: { value: "dedup-test" },
      planner: setupPlanner,
      tools: simpleToolRegistry,
      maxOuterCycles: 2,
    });
    const cycle1RunId = setupResult.runId;

    // Verify cycle1RunId already has OuterLoopCycleCompleted (cycleNumber=1).
    const eventsBefore = await listEvents(world, cycle1RunId);
    const completedBefore = eventsBefore.filter((e) => e.type === "OuterLoopCycleCompleted");
    expect(completedBefore).toHaveLength(1);

    // Step 2: simulate the crash scenario — write a new manifest that points to
    // cycle1RunId as pendingCycleRunId (crash happened after appendEvent but before
    // manifest was updated to include the cycle in cycles[]).
    const resumeOuterLoopId = "ol_dedupcrashrecovery0000000000000000";
    await writeOuterLoopManifest(world, resumeOuterLoopId, {
      outerLoopId: resumeOuterLoopId,
      goal: {
        workflowDefinitionHash: simpleWorkflowDefinitionHash(),
        description: "outer-loop-test.simple",
      },
      maxCycles: 3,
      cycles: [], // cycle 1 NOT yet recorded in manifest
      pendingCycleRunId: cycle1RunId, // but its events ARE committed (including OuterLoopCycleCompleted)
    });

    // Step 3: resume. Track that no tool re-execution happens.
    const resumePlanner = plannerWithSupervise([
      { kind: "done", finalOutput: { result: "dedup-resumed" } },
    ]);

    await runWorkflow({
      world,
      workflows: simpleWorkflow,
      input: { value: "dedup-test" },
      planner: resumePlanner,
      tools: simpleToolRegistry,
      maxOuterCycles: 3,
      outerLoopId: resumeOuterLoopId,
    });

    // Assert exactly ONE OuterLoopCycleCompleted for cycle 1 in the event log.
    const eventsAfter = await listEvents(world, cycle1RunId);
    const completedAfter = eventsAfter.filter((e) => e.type === "OuterLoopCycleCompleted");
    expect(completedAfter).toHaveLength(1);
  });
});

// ── P2.1: Honor persisted maxCycles on outer-loop resume ─────────────────────

describe("P2.1 — maxCycles mismatch on resume throws runtime_config_error", () => {
  it("throws runtime_config_error when existing manifest maxCycles differs from options.maxOuterCycles", async () => {
    const outerLoopId = "ol_maxcyclesmismatchtest0000000000000";
    const fakeRunId = "run_maxcyclesmismatch0000000000000000";

    // Pre-write a manifest with maxCycles=3 and one completed cycle.
    await writeOuterLoopManifest(world, outerLoopId, {
      outerLoopId,
      goal: {
        workflowDefinitionHash: simpleWorkflowDefinitionHash(),
        description: "outer-loop-test.simple",
      },
      maxCycles: 3,
      cycles: [
        {
          cycleNumber: 1,
          runId: fakeRunId,
          workflowVersionId: "wv_fake",
          status: "completed",
          output: { result: "cycle1" },
        },
      ],
      // no result — loop is still in progress
    });

    const planner = plannerWithSupervise([
      { kind: "done", finalOutput: { result: "should-not-reach" } },
    ]);

    let caught: RunFailedError | undefined;
    try {
      // Resume with a DIFFERENT maxOuterCycles (5 vs persisted 3).
      await runWorkflow({
        world,
        workflows: simpleWorkflow,
        input: { value: "mismatch-test" },
        planner,
        tools: simpleToolRegistry,
        maxOuterCycles: 5,
        outerLoopId,
      });
    } catch (err) {
      caught = err as RunFailedError;
    }

    expect(caught).toBeDefined();
    expect(caught).toBeInstanceOf(RunFailedError);
    expect(caught?.causeCode).toBe("runtime_config_error");
    expect(caught?.message).toContain("maxCycles");
    expect(caught?.message).toContain("mismatch");
    // Neither draft() nor supervise() should have been called.
    expect(vi.mocked(planner.draft)).not.toHaveBeenCalled();
    expect(vi.mocked(planner.supervise!)).not.toHaveBeenCalled();
  });

  it("throws runtime_config_error when existing manifest workflowDefinitionHash differs", async () => {
    const outerLoopId = "ol_goalhashmismatchtest000000000000000";
    const fakeRunId = "run_goalhashmismatch000000000000000000";

    await writeOuterLoopManifest(world, outerLoopId, {
      outerLoopId,
      goal: {
        workflowDefinitionHash: "sha256:" + "1".repeat(64),
        description: "outer-loop-test.simple",
      },
      maxCycles: 3,
      cycles: [
        {
          cycleNumber: 1,
          runId: fakeRunId,
          workflowVersionId: "wv_fake",
          status: "completed",
          output: { result: "cycle1" },
        },
      ],
    });

    const planner = plannerWithSupervise([
      { kind: "done", finalOutput: { result: "should-not-reach" } },
    ]);

    let caught: RunFailedError | undefined;
    try {
      await runWorkflow({
        world,
        workflows: simpleWorkflow,
        input: { value: "goal-mismatch-test" },
        planner,
        tools: simpleToolRegistry,
        maxOuterCycles: 3,
        outerLoopId,
      });
    } catch (err) {
      caught = err as RunFailedError;
    }

    expect(caught).toBeDefined();
    expect(caught).toBeInstanceOf(RunFailedError);
    expect(caught?.causeCode).toBe("runtime_config_error");
    expect(caught?.message).toContain("outer_loop_goal_mismatch");
    expect(vi.mocked(planner.draft)).not.toHaveBeenCalled();
    expect(vi.mocked(planner.supervise!)).not.toHaveBeenCalled();
  });

  it("does NOT throw when existing manifest maxCycles matches options.maxOuterCycles", async () => {
    const outerLoopId = "ol_maxcyclesmatchtest000000000000000";
    const fakeRunId = "run_maxcyclesmatch000000000000000000";

    // Pre-write a manifest with maxCycles=3 and one completed cycle.
    await writeOuterLoopManifest(world, outerLoopId, {
      outerLoopId,
      goal: {
        workflowDefinitionHash: simpleWorkflowDefinitionHash(),
        description: "outer-loop-test.simple",
      },
      maxCycles: 3,
      cycles: [
        {
          cycleNumber: 1,
          runId: fakeRunId,
          workflowVersionId: "wv_fake",
          status: "completed",
          output: { result: "cycle1" },
        },
      ],
      // no result — loop is still in progress
    });

    const planner = plannerWithSupervise([
      { kind: "done", finalOutput: { result: "matched-ok" } },
    ]);

    // Resume with the SAME maxOuterCycles (3 == 3). Should succeed.
    const result = await runWorkflow({
      world,
      workflows: simpleWorkflow,
      input: { value: "match-test" },
      planner,
      tools: simpleToolRegistry,
      maxOuterCycles: 3,
      outerLoopId,
    });

    expect(result.status).toBe("completed");
    expect(result.output).toEqual({ result: "matched-ok" });
  });
});

// ── P2.3: maxOuterCycles validation ───────────────────────────────────────────

describe("P2.3 — runWorkflow rejects invalid maxOuterCycles", () => {
  it("throws when maxOuterCycles is 0", async () => {
    await expect(
      runWorkflow({
        world,
        workflows: simpleWorkflow,
        input: { value: "test" },
        planner: plannerWithoutSupervise(),
        tools: simpleToolRegistry,
        maxOuterCycles: 0,
      }),
    ).rejects.toThrow(/maxOuterCycles/u);
  });

  it("throws when maxOuterCycles is -1", async () => {
    await expect(
      runWorkflow({
        world,
        workflows: simpleWorkflow,
        input: { value: "test" },
        planner: plannerWithoutSupervise(),
        tools: simpleToolRegistry,
        maxOuterCycles: -1,
      }),
    ).rejects.toThrow(/maxOuterCycles/u);
  });

  it("throws when maxOuterCycles is 1.5", async () => {
    await expect(
      runWorkflow({
        world,
        workflows: simpleWorkflow,
        input: { value: "test" },
        planner: plannerWithoutSupervise(),
        tools: simpleToolRegistry,
        maxOuterCycles: 1.5,
      }),
    ).rejects.toThrow(/maxOuterCycles/u);
  });

  it("throws when maxOuterCycles is NaN", async () => {
    await expect(
      runWorkflow({
        world,
        workflows: simpleWorkflow,
        input: { value: "test" },
        planner: plannerWithoutSupervise(),
        tools: simpleToolRegistry,
        maxOuterCycles: NaN,
      }),
    ).rejects.toThrow(/maxOuterCycles/u);
  });

  it("throws when maxOuterCycles is Infinity", async () => {
    await expect(
      runWorkflow({
        world,
        workflows: simpleWorkflow,
        input: { value: "test" },
        planner: plannerWithoutSupervise(),
        tools: simpleToolRegistry,
        maxOuterCycles: Infinity,
      }),
    ).rejects.toThrow(/maxOuterCycles/u);
  });
});

// ── Gap 7: distinct workflowVersionId per cycle ────────────────────────────────

describe("Gap 7 — distinct workflowVersionId per cycle", () => {
  it("each cycle has a unique workflowVersionId even when the planner returns identical LWIR", async () => {
    // workflowVersionId is derived from requestHash, which includes outerLoop.cycleNumber
    // and outerLoop.priorCycles. These differ per cycle even when the LWIR is identical,
    // so each cycle must produce a distinct workflowVersionId.
    const planner = plannerWithSupervise([
      { kind: "continue" },
      { kind: "continue" },
      { kind: "done", finalOutput: { result: "final" } },
    ]);

    await runWorkflow({
      world,
      workflows: simpleWorkflow,
      input: { value: "version-id-test" },
      planner,
      tools: simpleToolRegistry,
      maxOuterCycles: 3,
    });

    // Read the manifest to access workflowVersionId per cycle.
    const manifestDir = join(tmpDir, "outer-loops");
    const manifestFiles = (await import("node:fs")).readdirSync(manifestDir);
    expect(manifestFiles.length).toBe(1);
    const manifest = JSON.parse(
      (await import("node:fs")).readFileSync(join(manifestDir, manifestFiles[0]!), "utf8"),
    ) as { cycles: Array<{ workflowVersionId: string }> };

    expect(manifest.cycles).toHaveLength(3);
    const versionIds = manifest.cycles.map((c) => c.workflowVersionId);
    // All version IDs must be distinct — each cycle's request differs by cycleNumber
    // and priorCycles, causing distinct requestHashes and thus distinct workflowVersionIds.
    const uniqueIds = new Set(versionIds);
    expect(uniqueIds.size).toBe(versionIds.length);
  });
});

// ── P1.3: Reuse committed supervise decision on resume ────────────────────────

describe("P1.3 — reuse committed supervise decision on resume", () => {
  it("continue path: skips planner.supervise for cycle 1 when OuterLoopCycleCompleted is already committed, advances to cycle 2", async () => {
    // The bug: crash between appendEvent(OuterLoopCycleCompleted) and
    // writeOuterLoopManifest. On resume, cycles=[] so the loop re-enters
    // cycle 1 via pendingCycleRunId. Layer A skips re-execution (RunCompleted
    // already committed), but the old code re-calls planner.supervise — which
    // for LLM planners would produce a divergent decision.
    //
    // Step 1: Run a real setup to produce a committed cycle 1 event log
    // including OuterLoopCycleCompleted{cycleNumber:1, supervise:{kind:"continue", promptNote:"X"}}.
    // Use [continue, done] with maxOuterCycles=3 so cycle 1 gets a continue.
    const setupPlanner = plannerWithSupervise([
      { kind: "continue", promptNote: "X" },
      { kind: "done", finalOutput: { result: "setup-done" } },
    ]);
    await runWorkflow({
      world,
      workflows: simpleWorkflow,
      input: { value: "p13-continue" },
      planner: setupPlanner,
      tools: simpleToolRegistry,
      maxOuterCycles: 3,
    });

    // Read the manifest to get cycle 1's runId (result.runId is cycle 2's).
    const manifestDir = join(tmpDir, "outer-loops");
    const manifestFiles = (await import("node:fs")).readdirSync(manifestDir);
    expect(manifestFiles.length).toBe(1);
    const setupManifest = JSON.parse(
      (await import("node:fs")).readFileSync(join(manifestDir, manifestFiles[0]!), "utf8"),
    ) as { cycles: Array<{ runId: string }> };
    const cycle1RunId = setupManifest.cycles[0]!.runId;

    // Verify cycle 1 has OuterLoopCycleCompleted with supervise={kind:"continue", promptNote:"X"}.
    const cycle1Events = await listEvents(world, cycle1RunId);
    const completedEvt = cycle1Events.find((e) => e.type === "OuterLoopCycleCompleted");
    expect(completedEvt).toBeDefined();
    expect((completedEvt!.payload as { supervise: { kind: string; promptNote?: string } }).supervise)
      .toEqual({ kind: "continue", promptNote: "X" });

    // Step 2: Simulate crash — new outerLoopId with cycles=[], pendingCycleRunId=cycle1RunId.
    const resumeOuterLoopId = "ol_p13continueresumetest000000000000";
    await writeOuterLoopManifest(world, resumeOuterLoopId, {
      outerLoopId: resumeOuterLoopId,
      goal: {
        workflowDefinitionHash: simpleWorkflowDefinitionHash(),
        description: "outer-loop-test.simple",
      },
      maxCycles: 3,
      cycles: [], // cycle 1 not recorded yet (crash before manifest update)
      pendingCycleRunId: cycle1RunId, // but its events are committed
    });

    // Step 3: Resume with a planner whose supervise tracks calls and provides
    // only a cycle-2 decision. If the fix works, supervise is NOT called for
    // cycle 1 (reuses committed event). It IS called once for cycle 2.
    const draftRequests: Array<{ messages?: { system?: string } }> = [];
    const resumePlanner: PlannerAdapter = {
      draft: vi.fn(async (request) => {
        draftRequests.push(request as { messages?: { system?: string } });
        return simpleLwir();
      }),
      supervise: vi.fn(async (_state) => {
        return { kind: "done", finalOutput: { result: "cycle-2-answer" } } as SuperviseDecision;
      }),
    };

    const result = await runWorkflow({
      world,
      workflows: simpleWorkflow,
      input: { value: "p13-continue" },
      planner: resumePlanner,
      tools: simpleToolRegistry,
      maxOuterCycles: 3,
      outerLoopId: resumeOuterLoopId,
    });

    expect(result.status).toBe("completed");
    expect(result.output).toEqual({ result: "cycle-2-answer" });

    // supervise called exactly once — for cycle 2 only, not cycle 1.
    expect(vi.mocked(resumePlanner.supervise!).mock.calls).toHaveLength(1);

    // The promptNote "X" from the committed cycle 1 event must be forwarded to
    // cycle 2's draft (persisted as the continue guidance).
    expect(draftRequests).toHaveLength(1);
    expect(draftRequests[0]?.messages?.system).toContain(
      "\n\n--- Prior cycle note ---\nX",
    );
  });

  it("done path: skips planner.supervise for cycle 1 and returns finalOutput from committed event", async () => {
    // The bug: OuterLoopCycleCompleted{kind:"done", finalOutput:"Z"} committed,
    // but before writeOuterLoopManifest. On resume, re-calling supervise could
    // return continue, causing the loop to incorrectly run more cycles.
    //
    // Step 1: Run a real setup to produce a committed cycle 1 event log
    // including OuterLoopCycleCompleted{cycleNumber:1, supervise:{kind:"done", finalOutput:"Z"}}.
    const setupPlanner = plannerWithSupervise([
      { kind: "done", finalOutput: "Z" },
    ]);
    await runWorkflow({
      world,
      workflows: simpleWorkflow,
      input: { value: "p13-done" },
      planner: setupPlanner,
      tools: simpleToolRegistry,
      maxOuterCycles: 2,
    });

    // Get the cycle 1 runId from the manifest.
    const manifestDir = join(tmpDir, "outer-loops");
    const manifestFiles = (await import("node:fs")).readdirSync(manifestDir);
    expect(manifestFiles.length).toBe(1);
    const setupManifest = JSON.parse(
      (await import("node:fs")).readFileSync(join(manifestDir, manifestFiles[0]!), "utf8"),
    ) as { cycles: Array<{ runId: string }> };
    const cycle1RunId = setupManifest.cycles[0]!.runId;

    // Verify OuterLoopCycleCompleted has supervise={kind:"done", finalOutput:"Z"}.
    const cycle1Events = await listEvents(world, cycle1RunId);
    const completedEvt = cycle1Events.find((e) => e.type === "OuterLoopCycleCompleted");
    expect(completedEvt).toBeDefined();
    expect((completedEvt!.payload as { supervise: { kind: string; finalOutput?: unknown } }).supervise)
      .toEqual({ kind: "done", finalOutput: "Z" });

    // Step 2: Simulate crash — new outerLoopId, cycles=[], pendingCycleRunId=cycle1RunId.
    const resumeOuterLoopId = "ol_p13doneresumetest0000000000000000";
    await writeOuterLoopManifest(world, resumeOuterLoopId, {
      outerLoopId: resumeOuterLoopId,
      goal: {
        workflowDefinitionHash: simpleWorkflowDefinitionHash(),
        description: "outer-loop-test.simple",
      },
      maxCycles: 2,
      cycles: [], // cycle 1 not recorded yet
      pendingCycleRunId: cycle1RunId,
    });

    // Step 3: Resume with a planner whose supervise must NOT be called.
    const resumePlanner: PlannerAdapter = {
      draft: vi.fn(async () => simpleLwir()),
      supervise: vi.fn(async () => {
        throw new Error("supervise must not be called when committed event says done");
      }),
    };

    const result = await runWorkflow({
      world,
      workflows: simpleWorkflow,
      input: { value: "p13-done" },
      planner: resumePlanner,
      tools: simpleToolRegistry,
      maxOuterCycles: 2,
      outerLoopId: resumeOuterLoopId,
    });

    expect(result.status).toBe("completed");
    expect(result.output).toBe("Z");

    // supervise must not have been called at all.
    expect(vi.mocked(resumePlanner.supervise!)).not.toHaveBeenCalled();
  });
});

// ── P2.2: Recover continue.promptNote across crash boundary ───────────────────

describe("P2.2 — recover continue.promptNote across crash boundary", () => {
  it("seeds promptNote from persisted cycle summary on resume so the next compile sees the supervisor's guidance", async () => {
    // Simulate a crash that occurred after cycle 1 completed and the manifest was
    // written (with the supervisor's continue decision and promptNote persisted as
    // cycles[0].summary), but before cycle 2 started. In the original process,
    // promptNote was an in-process variable set to the decision's promptNote. On
    // resume, the variable is lost. The fix seeds promptNote from cycles[-1].summary
    // before entering the loop so cycle 2's compile sees the guidance.

    const outerLoopId = "ol_p22promptnoteresumetest0000000000";
    const cycle1RunId = "run_p22promptnotecycle1000000000000";
    const fakeWvId = "wv_p22promptnotefake0000000000000000";

    // Pre-write a manifest: cycle 1 completed, summary = supervisor's promptNote,
    // no result (continue decision), no pendingCycleRunId (crash between cycles).
    await writeOuterLoopManifest(world, outerLoopId, {
      outerLoopId,
      goal: {
        workflowDefinitionHash: simpleWorkflowDefinitionHash(),
        description: "outer-loop-test.simple",
      },
      maxCycles: 3,
      cycles: [
        {
          cycleNumber: 1,
          runId: cycle1RunId,
          workflowVersionId: fakeWvId,
          status: "completed",
          output: { result: "processed:cycle1" },
          summary: "focus on X",
        },
      ],
      // no result — cycle 1 returned continue; cycle 2 not yet started
      // no pendingCycleRunId — crash happened between cycles
    });

    // Capture the draft request for cycle 2 to verify the system message.
    const draftRequests: Array<{ messages?: { system?: string } }> = [];
    const resumePlanner: PlannerAdapter = {
      draft: vi.fn(async (request) => {
        draftRequests.push(request as { messages?: { system?: string } });
        return simpleLwir();
      }),
      supervise: vi.fn(async (_state) => {
        return { kind: "done", finalOutput: { result: "cycle-2-answer" } } as SuperviseDecision;
      }),
    };

    const result = await runWorkflow({
      world,
      workflows: simpleWorkflow,
      input: { value: "p22-resume-test" },
      planner: resumePlanner,
      tools: simpleToolRegistry,
      maxOuterCycles: 3,
      outerLoopId,
    });

    expect(result.status).toBe("completed");
    expect(result.output).toEqual({ result: "cycle-2-answer" });

    // Only one draft call — cycle 2 (cycle 1 was seeded from the manifest).
    expect(draftRequests).toHaveLength(1);

    // The cycle 2 draft must receive the persisted promptNote folded into the
    // system message, using the exact separator from Spec §3.4 step 6.
    expect(draftRequests[0]?.messages?.system).toContain(
      "\n\n--- Prior cycle note ---\nfocus on X",
    );
  });
});
