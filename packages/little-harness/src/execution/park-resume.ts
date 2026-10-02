import type {
  HarnessContinuationRecord,
  HarnessContinuationWaitOutcome,
  HarnessContinuationWaitRecord,
  HarnessResumeQueueRecord,
} from "../tasks/ledger.js";
import { stableHash } from "../utils/canonical-hash.js";
import type { HarnessParkedPending } from "./result.js";

/**
 * The typed contract between parking tools and the harness loops. A tool that parks the turn
 * returns exactly this shape; the loops stop the step and surface a parked result. The wire
 * shape is durable data — do not change it.
 */
export type ParkedToolOutput = {
  readonly status: "parked";
  readonly continuationId: string;
  readonly pending: HarnessParkedPending;
};

export type CreateContinuationIdInput = {
  readonly sessionId?: string;
  readonly parentSessionId?: string;
  readonly originTurnId: string;
  readonly modelStepId?: string;
  readonly toolCallBatchId?: string;
  readonly parkSequence: number;
};

export type MarkWaitTerminalInput = {
  readonly continuationId: string;
  readonly waitId: string;
  readonly matchedId?: string;
  readonly fromState: "open";
  readonly toState: "terminal" | "timed_out" | "cancelled";
  readonly terminalResultIds: readonly string[];
  readonly terminalAt: string;
  readonly resumeQueueId: string;
  readonly resumeReason: HarnessResumeQueueRecord["reason"];
};

export type MarkWaitTerminalResult = {
  readonly updated: boolean;
  readonly record?: HarnessContinuationRecord;
  readonly shouldEnqueueResume: boolean;
};

export function createContinuationId(input: CreateContinuationIdInput): string {
  if (!Number.isSafeInteger(input.parkSequence) || input.parkSequence < 0) {
    throw new Error("parkSequence must be a non-negative safe integer.");
  }
  if (input.modelStepId === undefined && input.toolCallBatchId === undefined) {
    throw new Error("modelStepId or toolCallBatchId is required.");
  }
  const sessionId = input.sessionId ?? input.parentSessionId;
  if (sessionId === undefined) {
    throw new Error("sessionId is required.");
  }

  const digest = stableHash({
    kind: "little-harness.continuation",
    version: 1,
    sessionId,
    originTurnId: input.originTurnId,
    modelStepId: input.modelStepId,
    toolCallBatchId: input.toolCallBatchId,
    parkSequence: input.parkSequence,
  }, { format: "base32hex" });

  return `cont_${digest.slice(0, 32)}`;
}

export function createParkedToolResult(input: {
  readonly continuationId: string;
  readonly pending: HarnessParkedPending;
}): ParkedToolOutput {
  return {
    status: "parked",
    continuationId: input.continuationId,
    pending: input.pending,
  };
}

export function isParkedToolOutput(value: unknown): value is ParkedToolOutput {
  return isRecord(value)
    && value.status === "parked"
    && typeof value.continuationId === "string"
    && isRecord(value.pending);
}

/**
 * Finds the most recent parked tool output in a model run's steps. Shared by both harness
 * loops so park detection cannot drift between them.
 */
export function parkedResultFromSteps(
  steps: readonly unknown[] | undefined,
): ParkedToolOutput | undefined {
  for (const step of [...(steps ?? [])].reverse()) {
    const toolResults = isRecord(step) && Array.isArray(step.toolResults) ? step.toolResults : [];
    for (const result of [...toolResults].reverse()) {
      const output = isRecord(result) ? result.output : undefined;
      if (isParkedToolOutput(output)) {
        return {
          status: "parked",
          continuationId: output.continuationId,
          pending: output.pending,
        };
      }
    }
  }
  return undefined;
}

export function parkedThisStep(options: { readonly steps: readonly unknown[] }): boolean {
  return parkedResultFromSteps(options.steps) !== undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function shouldResumeProviderStep(input: {
  readonly parkedToolCallIds: readonly string[];
  readonly terminalToolCallIds?: readonly string[];
  readonly terminalResultsByToolCallId?: Readonly<Record<string, readonly string[]>>;
}): boolean {
  const terminalToolCallIds = new Set([
    ...(input.terminalToolCallIds ?? []),
    ...Object.keys(input.terminalResultsByToolCallId ?? {}),
  ]);
  return input.parkedToolCallIds.length > 0
    && input.parkedToolCallIds.every((toolCallId) => terminalToolCallIds.has(toolCallId));
}

export function markWaitTerminal(
  record: HarnessContinuationRecord,
  input: MarkWaitTerminalInput,
): MarkWaitTerminalResult {
  if (record.continuationId !== input.continuationId || record.state !== "open") {
    return { updated: false, record, shouldEnqueueResume: false };
  }

  const wait = record.waits.find((candidate) => candidate.waitId === input.waitId);
  if (wait === undefined || wait.state !== input.fromState) {
    return { updated: false, record, shouldEnqueueResume: false };
  }

  const updatedWait = markSingleWaitTerminal(wait, input);
  if (updatedWait === wait) {
    return { updated: false, record, shouldEnqueueResume: false };
  }

  const waits = record.waits.map((candidate) =>
    candidate.waitId === input.waitId ? updatedWait : candidate
  );
  const terminalResultsByToolCallId = {
    ...record.terminalResultsByToolCallId,
    ...(updatedWait.state === "open"
      ? {}
      : { [updatedWait.parkedToolCallId]: updatedWait.terminalResultIds }),
  };
  const shouldResume = shouldResumeProviderStep({
    parkedToolCallIds: record.parkedToolCallIds,
    terminalResultsByToolCallId,
  });
  const updatedRecord: HarnessContinuationRecord = {
    ...record,
    waits,
    terminalResultsByToolCallId,
    state: shouldResume ? "resume_enqueued" : record.state,
    updatedAt: input.terminalAt,
    ...(shouldResume
      ? { resumeQueueId: input.resumeQueueId }
      : record.resumeQueueId === undefined
        ? {}
        : { resumeQueueId: record.resumeQueueId }),
  };

  return {
    updated: true,
    record: updatedRecord,
    shouldEnqueueResume: shouldResume,
  };
}

export function markContinuationWaitTerminal(
  record: HarnessContinuationRecord,
  input: {
    readonly waitId: string;
    readonly matchedId?: string;
    readonly toState?: "terminal" | "timed_out" | "cancelled";
    readonly terminalResultIds: readonly string[];
    readonly terminalAt: string;
    readonly resumeQueueId?: string;
    readonly resumeReason?: HarnessResumeQueueRecord["reason"];
  },
): HarnessContinuationRecord {
  const wait = record.waits.find((candidate) => candidate.waitId === input.waitId);
  const matchedId = input.matchedId ?? (wait === undefined ? undefined : waitPredicateIds(wait)[0]);
  return markWaitTerminal(record, {
    continuationId: record.continuationId,
    waitId: input.waitId,
    ...(matchedId === undefined ? {} : { matchedId }),
    fromState: "open",
    toState: input.toState ?? "terminal",
    terminalResultIds: input.terminalResultIds,
    terminalAt: input.terminalAt,
    resumeQueueId: input.resumeQueueId ?? `${record.continuationId}:resume`,
    resumeReason: input.resumeReason ?? "predicate_satisfied",
  }).record ?? record;
}

export function shouldEnqueueResumeForLateCompletion(input: {
  readonly record: HarnessContinuationRecord;
  readonly waitId: string;
}): boolean;
export function shouldEnqueueResumeForLateCompletion(
  record: HarnessContinuationRecord,
  matchedId: string,
): boolean;
export function shouldEnqueueResumeForLateCompletion(
  inputOrRecord: {
    readonly record: HarnessContinuationRecord;
    readonly waitId: string;
  } | HarnessContinuationRecord,
  matchedId?: string,
): boolean {
  const record = "record" in inputOrRecord ? inputOrRecord.record : inputOrRecord;
  const waitId = "record" in inputOrRecord ? inputOrRecord.waitId : matchedId;
  if (record.state !== "open") {
    return false;
  }
  const wait = record.waits.find((candidate) =>
    candidate.waitId === waitId || (waitId !== undefined && waitPredicateIds(candidate).includes(waitId))
  );
  return wait?.state === "open";
}

function markSingleWaitTerminal(
  wait: HarnessContinuationWaitRecord,
  input: MarkWaitTerminalInput,
): HarnessContinuationWaitRecord {
  if (input.matchedId === undefined && input.toState !== "timed_out") {
    throw new Error("matchedId is required unless the whole wait timed out.");
  }

  const outcomesById: Record<string, HarnessContinuationWaitOutcome> = {
    ...wait.outcomesById,
  };
  if (input.matchedId !== undefined) {
    outcomesById[input.matchedId] = {
      id: input.matchedId,
      state: input.toState,
      terminalResultIds: input.terminalResultIds,
      terminalAt: input.terminalAt,
    };
  }

  const nextState = waitStateAfterTerminal(wait, outcomesById, input.toState, input.matchedId);
  const terminalResultIds = waitTerminalResultIds(wait, outcomesById, input);
  if (nextState === "open" && input.matchedId !== undefined) {
    return compact({ ...wait, outcomesById, terminalResultIds });
  }
  if (nextState === "open") {
    return wait;
  }

  return {
    ...wait,
    outcomesById,
    state: nextState,
    terminalResultIds,
    terminalAt: input.terminalAt,
    ...(nextState === "timed_out"
      ? { timeoutAt: input.terminalAt }
      : wait.timeoutAt === undefined
        ? {}
        : { timeoutAt: wait.timeoutAt }),
  };
}

function waitStateAfterTerminal(
  wait: HarnessContinuationWaitRecord,
  outcomesById: Readonly<Record<string, HarnessContinuationWaitOutcome>>,
  requestedState: MarkWaitTerminalInput["toState"],
  matchedId: string | undefined,
): HarnessContinuationWaitRecord["state"] {
  if (matchedId === undefined && requestedState === "timed_out") {
    return "timed_out";
  }

  const ids = waitPredicateIds(wait);
  const outcomes = ids.map((id) => outcomesById[id]).filter((outcome) => outcome !== undefined);
  const mode = wait.predicate.kind === "workflow-run" ? "all" : wait.predicate.mode;
  if (mode === "all") {
    if (outcomes.some((outcome) => outcome.state === "cancelled")) {
      return "cancelled";
    }
    if (outcomes.some((outcome) => outcome.state === "timed_out")) {
      return "timed_out";
    }
    return ids.every((id) => outcomesById[id]?.state === "terminal") ? "terminal" : "open";
  }

  if (outcomes.some((outcome) => outcome.state === "terminal")) {
    return "terminal";
  }
  return ids.every((id) =>
    outcomesById[id]?.state === "cancelled" || outcomesById[id]?.state === "timed_out"
  )
    ? requestedState
    : "open";
}

function waitPredicateIds(wait: HarnessContinuationWaitRecord): readonly string[] {
  if (wait.predicate.kind === "tasks") {
    return wait.predicate.taskIds;
  }
  if (wait.predicate.kind === "tool-call") {
    return wait.predicate.toolCallIds;
  }
  return [wait.predicate.taskId];
}

function waitTerminalResultIds(
  wait: HarnessContinuationWaitRecord,
  outcomesById: Readonly<Record<string, HarnessContinuationWaitOutcome>>,
  input: MarkWaitTerminalInput,
): readonly string[] {
  if (input.matchedId === undefined && input.toState === "timed_out") {
    return unique([...wait.terminalResultIds, ...input.terminalResultIds]);
  }

  const predicateIds = waitPredicateIds(wait);
  const orderedResultIds = predicateIds.flatMap((id) => outcomesById[id]?.terminalResultIds ?? []);
  const extraResultIds = Object.entries(outcomesById)
    .filter(([id]) => !predicateIds.includes(id))
    .flatMap(([, outcome]) => outcome.terminalResultIds);
  return unique([...orderedResultIds, ...wait.terminalResultIds, ...extraResultIds]);
}

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as T;
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}
