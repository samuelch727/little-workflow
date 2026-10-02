import { stableHash } from "../utils/canonical-hash.js";
import type { HarnessFailureCauseCode } from "../workflows.js";

export type HarnessTaskId = `task_${number}`;
export type HarnessTaskStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type HarnessTaskKind = "workflow" | "tool" | "bash" | "code" | "mcp";
export type HarnessTaskFailureCauseCode = HarnessFailureCauseCode;

export type HarnessTerminalDiagnostic = {
  readonly terminalCauseCode?: HarnessTaskFailureCauseCode;
  readonly terminalMessage?: string;
  readonly terminalDiagnostic?: unknown;
};

export type HarnessTaskRecord = HarnessTerminalDiagnostic & {
  readonly taskId: HarnessTaskId;
  readonly sessionId: string;
  readonly kind: HarnessTaskKind;
  readonly source?: "static" | "dynamic";
  readonly status: HarnessTaskStatus;
  readonly purpose?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly workflowId?: string;
  readonly workflowHandle?: string;
  readonly reservedRunId?: string;
  readonly queueId?: string;
  readonly callIdentity?: string;
  readonly runId?: string;
  readonly terminalResultId?: string;
  readonly outputSummary?: string;
  readonly outputPath?: string;
  readonly error?: string;
};

export type HarnessTaskReserveInput = {
  readonly sessionId: string;
  readonly kind: HarnessTaskKind;
  readonly source?: "static" | "dynamic";
  readonly purpose?: string;
  readonly workflowId?: string;
  readonly workflowHandle?: string;
  readonly reservedRunId?: string;
  readonly queueId?: string;
  readonly callIdentity?: string;
  readonly runId?: string;
};

export type HarnessCallIdentityInput = {
  readonly callerKind: "model" | "runtime" | "workflow" | "prepared" | "dynamic";
  readonly sessionId: string;
  readonly originTurnId: string;
  readonly parentTurnId?: string;
  readonly callerRunIdentity?: string;
  readonly modelStepId?: string;
  readonly modelStepToolCallCount?: number;
  readonly runtimeReplayPath?: readonly string[];
  readonly runtimeReplayScopeSize?: number;
  readonly launcherHandle: string;
  readonly toolCallId?: string;
  readonly sequenceIndex?: number;
};

export type HarnessTaskCallExecutionContext = {
  readonly toolCallId?: string;
  readonly callerRunIdentity?: string;
  readonly sequenceIndex?: number;
  readonly modelStepId?: string;
  readonly modelStepToolCallCount?: number;
  readonly runtimeReplayPath?: readonly string[];
  readonly runtimeReplayScopeSize?: number;
};

export type HarnessTaskReservationIntent = {
  readonly sessionId: string;
  readonly reservationScopeId: string;
  readonly reservationOrder: number;
  readonly scopeSize: number;
  readonly task: Omit<HarnessTaskReserveInput, "sessionId">;
};

export type HarnessTaskReservationCoordinator = {
  reserveLaunchIntent(intent: HarnessTaskReservationIntent): Promise<HarnessTaskRecord>;
};

export function harnessExecutionContext(ctx: unknown): HarnessTaskCallExecutionContext {
  const maybe = ctx as {
    readonly toolCallId?: string;
    readonly context?: {
      readonly sequenceIndex?: number;
      readonly modelStepToolCallCount?: number;
      readonly callerRunIdentity?: string;
      readonly modelStepId?: string;
      readonly runtimeReplayPath?: readonly string[];
      readonly runtimeReplayScopeSize?: number;
    };
  };
  return {
    ...(maybe.toolCallId === undefined ? {} : { toolCallId: maybe.toolCallId }),
    ...(maybe.context?.callerRunIdentity === undefined
      ? {}
      : { callerRunIdentity: maybe.context.callerRunIdentity }),
    ...(maybe.context?.sequenceIndex === undefined
      ? {}
      : { sequenceIndex: maybe.context.sequenceIndex }),
    ...(maybe.context?.modelStepId === undefined
      ? {}
      : { modelStepId: maybe.context.modelStepId }),
    ...(maybe.context?.modelStepToolCallCount === undefined
      ? {}
      : { modelStepToolCallCount: maybe.context.modelStepToolCallCount }),
    ...(maybe.context?.runtimeReplayPath === undefined
      ? {}
      : { runtimeReplayPath: maybe.context.runtimeReplayPath }),
    ...(maybe.context?.runtimeReplayScopeSize === undefined
      ? {}
      : { runtimeReplayScopeSize: maybe.context.runtimeReplayScopeSize }),
  };
}

// Harness generated tools wrap AI SDK tool execution and inject
// context.modelStepId/sequenceIndex/modelStepToolCallCount/runtimeReplayPath.
// Providers and the AI SDK do not supply these fields by default.
export function createCallIdentity(input: HarnessCallIdentityInput): string {
  const hasRuntimeReplayPath = (input.runtimeReplayPath?.length ?? 0) > 0;
  if (input.callerKind === "dynamic" && input.toolCallId === undefined && !hasRuntimeReplayPath) {
    throw new Error("Dynamic calls require either a provider toolCallId or a deterministic runtimeReplayPath.");
  }
  if (
    (input.callerKind === "model" || (input.callerKind === "dynamic" && !hasRuntimeReplayPath))
    && (input.modelStepId === undefined
      || input.sequenceIndex === undefined
      || input.modelStepToolCallCount === undefined)
  ) {
    throw new Error(
      "Model-originated calls require Harness-injected modelStepId, sequenceIndex, and modelStepToolCallCount.",
    );
  }
  if ((input.callerKind === "runtime" || input.callerKind === "workflow" || input.callerKind === "prepared") && !hasRuntimeReplayPath) {
    throw new Error(`${input.callerKind} calls require a deterministic runtimeReplayPath.`);
  }
  if (
    (input.callerKind === "runtime" || input.callerKind === "workflow" || input.callerKind === "prepared")
    && input.runtimeReplayScopeSize === undefined
  ) {
    throw new Error(`${input.callerKind} calls require a sealed runtimeReplayScopeSize.`);
  }
  if (input.callerKind === "dynamic" && hasRuntimeReplayPath && input.runtimeReplayScopeSize === undefined) {
    throw new Error("Runtime-originated dynamic calls require a sealed runtimeReplayScopeSize.");
  }
  if (
    (input.callerKind === "workflow" || input.callerKind === "prepared")
    && (input.callerRunIdentity?.length ?? 0) === 0
  ) {
    throw new Error(`${input.callerKind}-originated calls require callerRunIdentity.`);
  }
  return stableHash({
    callerKind: input.callerKind,
    sessionId: input.sessionId,
    originTurnId: input.originTurnId,
    callerRunIdentity: input.callerRunIdentity,
    modelStepId: input.modelStepId,
    runtimeReplayPath: input.runtimeReplayPath ?? [],
    runtimeReplayScopeSize: input.runtimeReplayScopeSize,
    launcherHandle: input.launcherHandle,
    toolCallId: input.toolCallId,
    sequenceIndex: input.sequenceIndex,
    modelStepToolCallCount: input.modelStepToolCallCount,
  });
}

export function reservationScopeFromExecutionContext(input: {
  callerKind: HarnessCallIdentityInput["callerKind"];
  sessionId: string;
  originTurnId: string;
  callerRunIdentity?: string;
  modelStepId?: string;
  modelStepToolCallCount?: number;
  runtimeReplayPath?: readonly string[];
  runtimeReplayScopeSize?: number;
  sequenceIndex?: number;
}) {
  if (input.callerKind === "model" || (input.callerKind === "dynamic" && (input.runtimeReplayPath?.length ?? 0) === 0)) {
    if (
      input.modelStepId === undefined
      || input.sequenceIndex === undefined
      || input.modelStepToolCallCount === undefined
    ) {
      throw new Error(
        "Model-originated reservations require Harness-injected modelStepId, sequenceIndex, and sealed modelStepToolCallCount.",
      );
    }
    return {
      scopeId: stableHash({ sessionId: input.sessionId, originTurnId: input.originTurnId, modelStepId: input.modelStepId }),
      order: input.sequenceIndex,
      scopeSize: input.modelStepToolCallCount,
    };
  }
  const runtimeReplayPath = input.runtimeReplayPath;
  if (runtimeReplayPath === undefined || runtimeReplayPath.length === 0) {
    throw new Error(`${input.callerKind} reservations require deterministic runtimeReplayPath.`);
  }
  if (
    (input.callerKind === "workflow" || input.callerKind === "prepared")
    && (input.callerRunIdentity?.length ?? 0) === 0
  ) {
    throw new Error(`${input.callerKind} reservations require callerRunIdentity.`);
  }
  const order = deterministicOrdinalFromReplayPath(runtimeReplayPath);
  if (input.runtimeReplayScopeSize === undefined || input.runtimeReplayScopeSize <= order) {
    throw new Error("Runtime reservations require a sealed runtimeReplayScopeSize larger than the replay ordinal.");
  }
  return {
    scopeId: stableHash({
      sessionId: input.sessionId,
      originTurnId: input.originTurnId,
      callerKind: input.callerKind,
      callerRunIdentity: input.callerRunIdentity,
      runtimeReplayPath: runtimeReplayPath.slice(0, -1),
    }),
    order,
    scopeSize: input.runtimeReplayScopeSize,
  };
}

function deterministicOrdinalFromReplayPath(path: readonly string[]) {
  const ordinal = path.at(-1);
  if (ordinal === undefined || !/^\d+$/u.test(ordinal)) {
    throw new Error("Runtime replay paths used for sibling launch reservation must end with a deterministic numeric ordinal.");
  }
  return Number(ordinal);
}

export type AwaitTaskPredicate = {
  readonly taskIds: readonly HarnessTaskId[];
  readonly mode: "all" | "any";
  readonly maxWaitMs?: number;
};

export class HarnessLaunchCorruptionError extends Error {
  readonly causeCode: HarnessTaskFailureCauseCode;
  readonly diagnostic?: unknown;

  constructor(
    message: string,
    options?: {
      readonly causeCode?: Extract<HarnessTaskFailureCauseCode, "launch_corruption" | "queue_corruption">;
      readonly diagnostic?: unknown;
    },
  ) {
    super(message);
    this.name = "HarnessLaunchCorruptionError";
    this.causeCode = options?.causeCode ?? "launch_corruption";
    if (options?.diagnostic !== undefined) {
      this.diagnostic = options.diagnostic;
    }
  }
}
