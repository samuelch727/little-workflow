import type {
  HarnessFailureCauseCode,
  HarnessPreparedWorkflow,
  HarnessWorkflowDefinitionIdentity,
  HarnessWorkflowInheritance,
} from "../workflows.js";
import type { WorkflowLaunchTransactionInput } from "../workflow-scheduler/types.js";
import type {
  HarnessTaskId,
  HarnessTaskKind,
  HarnessTaskRecord,
  HarnessTaskReservationCoordinator,
  HarnessTaskReservationIntent,
  HarnessTaskReserveInput,
  HarnessTaskStatus,
  HarnessTerminalDiagnostic,
} from "./types.js";

export type HarnessTerminalTaskStatus = Extract<HarnessTaskStatus, "completed" | "failed" | "cancelled">;

export type HarnessTaskTerminalUpdate = HarnessTerminalDiagnostic & {
  readonly sessionId: string;
  readonly taskId: HarnessTaskId;
  readonly status: HarnessTerminalTaskStatus;
  readonly updatedAt?: string;
  readonly runId?: string;
  readonly terminalResultId?: string;
  readonly outputSummary?: string;
  readonly outputPath?: string;
  readonly error?: string;
};

export type HarnessTaskLookupInput = {
  readonly sessionId: string;
  readonly taskId: HarnessTaskId;
};

export type HarnessTaskCallIdentityLookupInput = {
  readonly sessionId: string;
  readonly callIdentity: string;
};

export type HarnessContinuationRecord = {
  readonly continuationId: string;
  readonly sessionId: string;
  readonly originTurnId: string;
  readonly modelStepId?: string;
  readonly parkedToolCallIds: readonly string[];
  readonly waits: readonly HarnessContinuationWaitRecord[];
  readonly terminalResultsByToolCallId: Readonly<Record<string, readonly string[]>>;
  readonly state: "open" | "resume_enqueued" | "closed";
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly timeoutAt?: string;
  readonly resumeQueueId?: string;
};

export type HarnessContinuationWaitOutcome = {
  readonly id: string;
  readonly state: "terminal" | "timed_out" | "cancelled";
  readonly terminalResultIds: readonly string[];
  readonly terminalAt: string;
};

export type HarnessContinuationWaitRecord = {
  readonly waitId: string;
  readonly parkedToolCallId: string;
  readonly predicate:
    | { readonly kind: "tasks"; readonly taskIds: readonly HarnessTaskId[]; readonly mode: "all" | "any"; readonly maxWaitMs?: number }
    | { readonly kind: "workflow-run"; readonly taskId: HarnessTaskId; readonly reservedRunId: string; readonly queueId: string; readonly maxWaitMs?: number }
    | { readonly kind: "tool-call"; readonly toolCallIds: readonly string[]; readonly mode: "all" | "any"; readonly maxWaitMs?: number };
  readonly state: "open" | "terminal" | "timed_out" | "cancelled";
  readonly outcomesById: Readonly<Record<string, HarnessContinuationWaitOutcome>>;
  readonly terminalResultIds: readonly string[];
  readonly terminalAt?: string;
  readonly timeoutAt?: string;
};

export type HarnessWakeupRecord = {
  readonly wakeupId: string;
  readonly sessionId: string;
  readonly originTurnId: string;
  readonly predicate: {
    readonly kind: "tasks";
    readonly taskIds: readonly HarnessTaskId[];
    readonly mode: "all" | "any";
    readonly maxWaitMs?: number;
  };
  readonly status: "armed" | "resume_enqueued" | "closed" | "timed_out";
  readonly message?: string;
  readonly createdAt: string;
  readonly timeoutAt?: string;
  readonly firedReason?: "predicate_satisfied" | "timeout";
  readonly resumeQueueId?: string;
  readonly firedAt?: string;
};

export type HarnessWorkflowQueueRecord = HarnessTerminalDiagnostic & {
  readonly queueId: string;
  readonly sessionId: string;
  readonly workflowId: string;
  readonly handle: string;
  readonly reservedRunId: string;
  readonly taskId: HarnessTaskId;
  readonly callIdentity: string;
  readonly disposition: "await" | "start";
  readonly inputHash: string;
  readonly inputResultId: string;
  readonly sessionDataDir: string;
  readonly dataDir: string;
  readonly originTurnId: string;
  readonly parentTurnId: string;
  readonly reservationScopeId: string;
  readonly reservationOrder: number;
  readonly scopeSize: number;
  readonly toolCallId?: string;
  readonly launcherHandle?: string;
  readonly workflowDefinitionIdentity: HarnessWorkflowDefinitionIdentity;
  readonly workflowVersionId?: string;
  readonly memoryScope: "cross-session" | "session" | "none";
  readonly workflowSetMemoryKey?: string;
  readonly workflowSetDefinitionIdentities: readonly HarnessWorkflowDefinitionIdentity[];
  readonly inheritance: HarnessWorkflowInheritance;
  readonly status: "queued" | "admitted" | "running" | "completed" | "failed" | "cancelled";
  readonly source?: "static" | "dynamic";
  readonly purpose?: string;
  readonly currentStep?: string;
  readonly lastEvent?: unknown;
  readonly reservedAt: string;
  readonly createdAt: string;
  readonly queuedAt?: string;
  readonly admittedAt?: string;
  readonly startedAt?: string;
  readonly deadlineAt?: string;
  readonly queueDeadlineAt?: string;
  readonly attemptId?: string;
  readonly attemptStartedAt?: string;
  readonly attemptLeaseExpiresAt?: string;
  readonly recoverableAfterCrash?: boolean;
  readonly operationId?: string;
  readonly terminalAt?: string;
  readonly terminalResultId?: string;
  readonly dynamicPlan?: unknown;
  readonly dynamicCapabilitySnapshot?: unknown;
};

export type HarnessAsyncCapabilitySnapshot = {
  readonly implementationHash: string;
  readonly permissionHash?: string;
  readonly serverHash?: string;
  readonly sandboxHash?: string;
  readonly mountHashes?: Readonly<Record<string, string>>;
};

export type HarnessAsyncTaskQueueRecord = HarnessTerminalDiagnostic & {
  readonly queueId: string;
  readonly sessionId: string;
  readonly taskId: HarnessTaskId;
  readonly kind: Exclude<HarnessTaskKind, "workflow">;
  readonly handle: string;
  readonly callIdentity: string;
  readonly inputHash: string;
  readonly inputResultId: string;
  readonly sessionDataDir: string;
  readonly purpose?: string;
  readonly originTurnId: string;
  readonly parentTurnId: string;
  readonly reservationScopeId: string;
  readonly reservationOrder: number;
  readonly scopeSize: number;
  readonly toolCallId?: string;
  readonly permissionSnapshot?: unknown;
  readonly approvalPolicy?: "reject_ask" | "ask_becomes_deny";
  readonly capabilitySnapshot: HarnessAsyncCapabilitySnapshot;
  readonly status: "queued" | "running" | "completed" | "failed" | "cancelled";
  readonly attemptId?: string;
  readonly attemptStartedAt?: string;
  readonly attemptLeaseExpiresAt?: string;
  readonly recoverableAfterCrash?: boolean;
  readonly operationId?: string;
  readonly createdAt: string;
  readonly queuedAt?: string;
  readonly startedAt?: string;
  readonly deadlineAt?: string;
  readonly terminalAt?: string;
  readonly terminalResultId?: string;
};

export type HarnessStoredResult = {
  readonly resultId: string;
  readonly sessionId: string;
  readonly sessionDataDir: string;
  readonly idempotencyKey?: string;
  readonly kind: "tool" | "workflow" | "workflow-input" | "bash" | "code" | "mcp";
  readonly inlineSummary?: string;
  readonly outputPath?: string;
  readonly createdAt: string;
  readonly committedAt?: string;
};

export type HarnessResultAllocationInput = {
  readonly kind: HarnessStoredResult["kind"];
  readonly sessionId: string;
  readonly sessionDataDir: string;
  readonly idempotencyKey?: string;
  readonly createdAt?: string;
  readonly inlineSummary?: string;
};

export type HarnessPreparedWorkflowRecord = {
  readonly sessionId: string;
  readonly workflowId: string;
  readonly versionId: string;
  readonly prepareCallIdentity: string;
  readonly prepareId: string;
  readonly prepareToolCallId: string;
  readonly runtimeReplayPath: readonly string[];
  readonly exampleInputHash: string;
  readonly workflowDefinitionHash: string | { readonly notApplicable: true; readonly reason?: string };
  readonly capabilityHash: string | { readonly notApplicable: true; readonly reason?: string };
  readonly modelToolSkillSnapshotHash: string | { readonly notApplicable: true; readonly reason?: string };
  readonly inputShapeHash: string | { readonly notApplicable: true; readonly reason?: string };
  readonly handle: HarnessPreparedWorkflow;
  readonly createdAt: string;
};

export type HarnessPreparedWorkflowLookup =
  | { readonly status: "found"; readonly record: HarnessPreparedWorkflowRecord }
  | { readonly status: "missing" }
  | { readonly status: "ambiguous"; readonly workflowIds: readonly string[] };

export type HarnessPreparedWorkflowStore = {
  put(input: { readonly record: HarnessPreparedWorkflowRecord }): Promise<void>;
  getByPrepareCallIdentity(input: { readonly sessionId: string; readonly prepareCallIdentity: string }): Promise<HarnessPreparedWorkflowRecord | undefined>;
  getByVersionId(input: { readonly sessionId: string; readonly versionId: string }): Promise<HarnessPreparedWorkflowLookup>;
  get(input: { readonly sessionId: string; readonly workflowId: string; readonly versionId: string }): Promise<HarnessPreparedWorkflowRecord | undefined>;
  list(filter: { readonly sessionId: string; readonly workflowId?: string }): Promise<readonly HarnessPreparedWorkflowRecord[]>;
};

export type HarnessPreparedWorkflowRunRecord = {
  readonly sessionId: string;
  readonly runPreparedCallIdentity: string;
  readonly preparedRunIdentity: string;
  readonly reservedRunId: string;
  readonly toolCallId: string;
  readonly runtimeReplayPath: readonly string[];
  readonly workflowId: string;
  readonly versionId: string;
  readonly inputHash: string;
  readonly workflowDefinitionHash: string | { readonly notApplicable: true; readonly reason?: string };
  readonly capabilityHash: string | { readonly notApplicable: true; readonly reason?: string };
  readonly modelToolSkillSnapshotHash: string | { readonly notApplicable: true; readonly reason?: string };
  readonly inputShapeHash: string | { readonly notApplicable: true; readonly reason?: string };
  readonly status: "running" | "completed" | "failed" | "cancelled";
  readonly terminalResultId?: string;
  readonly terminalCauseCode?: HarnessFailureCauseCode;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly terminalAt?: string;
};

export type HarnessPreparedWorkflowRunStore = {
  put(input: { readonly record: HarnessPreparedWorkflowRunRecord }): Promise<void>;
  getByRunPreparedCallIdentity(input: { readonly sessionId: string; readonly runPreparedCallIdentity: string }): Promise<HarnessPreparedWorkflowRunRecord | undefined>;
  markTerminal(input: {
    readonly sessionId: string;
    readonly runPreparedCallIdentity: string;
    readonly terminalResultId: string;
    readonly status: "completed" | "failed" | "cancelled";
    readonly terminalCauseCode?: HarnessFailureCauseCode;
    readonly terminalAt: string;
  }): Promise<HarnessPreparedWorkflowRunRecord>;
  list(filter: { readonly sessionId: string; readonly workflowId?: string; readonly versionId?: string }): Promise<readonly HarnessPreparedWorkflowRunRecord[]>;
};

export type HarnessResumeQueueRecord = {
  readonly resumeId: string;
  readonly continuationId: string;
  readonly sessionId: string;
  readonly originTurnId: string;
  readonly reason: "predicate_satisfied" | "timeout";
  readonly terminalResultIds: readonly string[];
  readonly enqueuedAt: string;
  readonly claimedAt?: string;
  readonly completedAt?: string;
};

export type HarnessResumeQueue = {
  enqueue(record: HarnessResumeQueueRecord): Promise<void>;
  ensureEnqueued(record: HarnessResumeQueueRecord): Promise<{ readonly enqueued: boolean; readonly record: HarnessResumeQueueRecord }>;
  claimNext(sessionId?: string): Promise<HarnessResumeQueueRecord | undefined>;
  markCompleted(resumeId: string, completedAt: string): Promise<void>;
  listOpen(sessionId?: string): Promise<readonly HarnessResumeQueueRecord[]>;
};

export type HarnessTaskLedger = {
  reserveTask(input: HarnessTaskReserveInput): Promise<HarnessTaskRecord>;
  getTask(input: HarnessTaskLookupInput): Promise<HarnessTaskRecord | undefined>;
  listTasks(filter?: { readonly sessionId?: string; readonly statuses?: readonly HarnessTaskStatus[] }): Promise<readonly HarnessTaskRecord[]>;
  updateTask(record: HarnessTaskRecord): Promise<void>;
  markTerminal(
    input: { readonly sessionId: string; readonly taskId: HarnessTaskId },
    terminal: Pick<HarnessTaskRecord, "status" | "updatedAt" | "terminalResultId" | "outputSummary" | "outputPath" | "error" | "terminalCauseCode" | "terminalMessage" | "terminalDiagnostic">,
  ): Promise<void>;
  bindTaskId(input: { readonly sessionId: string; readonly callIdentity: string; readonly taskId: HarnessTaskId }): Promise<void>;
  taskIdForCallIdentity(input: HarnessTaskCallIdentityLookupInput): Promise<HarnessTaskId | undefined>;
  highWaterMark(sessionId: string): Promise<number>;
  updateTaskTerminal(input: HarnessTaskTerminalUpdate): Promise<HarnessTaskRecord | undefined>;
  cancelTask(input: HarnessTaskLookupInput): Promise<HarnessTaskRecord | undefined>;
};

export type HarnessContinuationLedger = {
  put(record: HarnessContinuationRecord): Promise<void>;
  putIfAbsent(record: HarnessContinuationRecord): Promise<{
    readonly inserted: boolean;
    readonly record: HarnessContinuationRecord;
  }>;
  get(continuationId: string): Promise<HarnessContinuationRecord | undefined>;
  listOpen(sessionId?: string): Promise<readonly HarnessContinuationRecord[]>;
  markWaitTerminal(input: {
    readonly continuationId: string;
    readonly waitId: string;
    readonly matchedId?: string;
    readonly fromState: "open";
    readonly toState: "terminal" | "timed_out" | "cancelled";
    readonly terminalResultIds: readonly string[];
    readonly terminalAt: string;
    readonly resumeQueueId: string;
    readonly resumeReason: "predicate_satisfied" | "timeout";
  }): Promise<{
    readonly updated: boolean;
    readonly record?: HarnessContinuationRecord;
    readonly shouldEnqueueResume: boolean;
  }>;
  transition(
    continuationId: string,
    from: HarnessContinuationRecord["state"],
    to: HarnessContinuationRecord["state"],
    patch?: Partial<Omit<HarnessContinuationRecord, "continuationId" | "state">>,
  ): Promise<{ readonly updated: boolean; readonly record?: HarnessContinuationRecord }>;
  delete(continuationId: string): Promise<void>;
};

export type HarnessWakeupLedger = {
  put(record: HarnessWakeupRecord): Promise<void>;
  putIfAbsent(record: HarnessWakeupRecord): Promise<{
    readonly inserted: boolean;
    readonly record: HarnessWakeupRecord;
  }>;
  listOpen(sessionId?: string): Promise<readonly HarnessWakeupRecord[]>;
  get(wakeupId: string): Promise<HarnessWakeupRecord | undefined>;
  transition(
    wakeupId: string,
    from: HarnessWakeupRecord["status"],
    to: HarnessWakeupRecord["status"],
    patch?: Partial<Omit<HarnessWakeupRecord, "wakeupId" | "status">>,
  ): Promise<{ readonly updated: boolean; readonly record?: HarnessWakeupRecord }>;
};

export type HarnessWorkflowQueueLedger = {
  enqueue(record: HarnessWorkflowQueueRecord): Promise<void>;
  update(record: HarnessWorkflowQueueRecord): Promise<void>;
  withQueueCapacity<T>(input: {
    readonly sessionId: string;
    readonly workflowId: string;
    readonly handle: string;
    readonly maxConcurrentWorkflowRuns: number;
    readonly maxQueuedWorkflowRuns: number;
  }, transaction: {
    readonly hasExistingLaunch: () => Promise<boolean>;
    readonly reserve: () => Promise<T>;
  }): Promise<{
    readonly accepted: true;
    readonly value: T;
  } | {
    readonly accepted: false;
    readonly queuedWorkflowRuns: number;
  }>;
  acquireAdmissionSlot(input: {
    readonly sessionId: string;
    readonly queueId: string;
    readonly taskId: HarnessTaskId;
    readonly maxConcurrentWorkflowRuns: number;
    readonly leaseExpiresAt?: string;
  }): Promise<{ readonly admitted: boolean; readonly record?: HarnessWorkflowQueueRecord }>;
  claimAdmittedForRun(input: {
    readonly sessionId: string;
    readonly queueId: string;
    readonly taskId: HarnessTaskId;
    readonly attemptId: string;
    readonly startedAt: string;
    readonly deadlineAt?: string;
    readonly attemptStartedAt: string;
    readonly attemptLeaseExpiresAt?: string;
    readonly operationId?: string;
    readonly recoverableAfterCrash?: boolean;
  }): Promise<{ readonly claimed: boolean; readonly record?: HarnessWorkflowQueueRecord }>;
  releaseAdmissionSlot(input: { readonly sessionId: string; readonly queueId: string }, reason: "completed" | "failed" | "cancelled"): Promise<void>;
  recordProgress(input: {
    readonly sessionId: string;
    readonly queueId: string;
    readonly currentStep?: string;
    readonly lastEvent?: unknown;
    readonly updatedAt: string;
  }): Promise<{ readonly updated: boolean; readonly record?: HarnessWorkflowQueueRecord }>;
  markTerminal(input: {
    readonly sessionId: string;
    readonly queueId: string;
    readonly expectedStatuses: readonly HarnessWorkflowQueueRecord["status"][];
  }, terminal: {
    readonly status: "completed" | "failed" | "cancelled";
    readonly terminalAt: string;
    readonly terminalResultId?: string;
    readonly terminalCauseCode?: HarnessFailureCauseCode;
    readonly terminalMessage?: string;
    readonly terminalDiagnostic?: unknown;
    readonly currentStep?: string;
    readonly lastEvent?: unknown;
  }): Promise<{ readonly updated: boolean; readonly record?: HarnessWorkflowQueueRecord }>;
  get(input: { readonly sessionId: string; readonly queueId: string }): Promise<HarnessWorkflowQueueRecord | undefined>;
  getByRunId(input: { readonly sessionId: string; readonly runId: string }): Promise<HarnessWorkflowQueueRecord | undefined>;
  getByTaskId(input: { readonly sessionId: string; readonly taskId: HarnessTaskId }): Promise<HarnessWorkflowQueueRecord | undefined>;
  listNonTerminal(): Promise<readonly HarnessWorkflowQueueRecord[]>;
  listRuns(filter?: {
    readonly sessionId?: string;
    readonly workflowId?: string;
    readonly statuses?: readonly HarnessWorkflowQueueRecord["status"][];
    readonly source?: "static" | "dynamic";
  }): Promise<readonly HarnessWorkflowQueueRecord[]>;
};

export type HarnessWorkflowLaunchLedger = {
  hasLaunch(input: { readonly sessionId: string; readonly callIdentity: string }): Promise<boolean>;
  reserveLaunch(input: WorkflowLaunchTransactionInput): Promise<{
    readonly replay: boolean;
    readonly task: HarnessTaskRecord;
    readonly inputResult: HarnessStoredResult;
    readonly queueRecord: HarnessWorkflowQueueRecord;
  }>;
};

export type HarnessAsyncTaskQueueLedger = {
  enqueue(record: HarnessAsyncTaskQueueRecord): Promise<void>;
  update(record: HarnessAsyncTaskQueueRecord): Promise<void>;
  claimQueued(input: {
    readonly sessionId: string;
    readonly queueId: string;
    readonly attemptId: string;
    readonly attemptStartedAt: string;
    readonly attemptLeaseExpiresAt: string;
    readonly deadlineAt?: string;
  }): Promise<{ readonly claimed: boolean; readonly record?: HarnessAsyncTaskQueueRecord }>;
  acquireToolSlot(input: {
    readonly sessionId: string;
    readonly queueId: string;
    readonly taskId: HarnessTaskId;
    readonly maxConcurrentToolCalls: number;
    readonly leaseExpiresAt?: string;
  }): Promise<{ readonly acquired: boolean; readonly record?: HarnessAsyncTaskQueueRecord }>;
  releaseToolSlot(input: { readonly sessionId: string; readonly queueId: string }, reason: "completed" | "failed" | "cancelled"): Promise<void>;
  markTerminal(input: {
    readonly sessionId: string;
    readonly queueId: string;
    readonly expectedStatuses: readonly HarnessAsyncTaskQueueRecord["status"][];
  }, terminal: {
    readonly status: "completed" | "failed" | "cancelled";
    readonly terminalAt: string;
    readonly terminalResultId?: string;
    readonly terminalCauseCode?: HarnessFailureCauseCode;
    readonly terminalMessage?: string;
    readonly terminalDiagnostic?: unknown;
  }): Promise<{ readonly updated: boolean; readonly record?: HarnessAsyncTaskQueueRecord }>;
  get(input: { readonly sessionId: string; readonly queueId: string }): Promise<HarnessAsyncTaskQueueRecord | undefined>;
  getByTaskId(input: { readonly sessionId: string; readonly taskId: HarnessTaskId }): Promise<HarnessAsyncTaskQueueRecord | undefined>;
  listNonTerminal(filter?: { readonly sessionId?: string }): Promise<readonly HarnessAsyncTaskQueueRecord[]>;
};

export type HarnessAsyncLaunchLedger = {
  reserveLaunch(input: {
    readonly sessionId: string;
    readonly kind: Exclude<HarnessTaskKind, "workflow">;
    readonly handle: string;
    readonly purpose?: string;
    readonly callIdentity: string;
    readonly input: unknown;
    readonly inputHash: string;
    readonly sessionDataDir: string;
    readonly originTurnId: string;
    readonly parentTurnId: string;
    readonly reservationScopeId: string;
    readonly reservationOrder: number;
    readonly scopeSize: number;
    readonly toolCallId?: string;
    readonly capabilitySnapshot: HarnessAsyncCapabilitySnapshot;
    readonly recoverableAfterCrash?: boolean;
    readonly operationId?: string;
    readonly permissionSnapshot?: unknown;
    readonly approvalPolicy?: "reject_ask" | "ask_becomes_deny";
  }): Promise<{
    readonly replay: boolean;
    readonly task: HarnessTaskRecord;
    readonly inputResult: HarnessStoredResult;
    readonly queueRecord: HarnessAsyncTaskQueueRecord;
  }>;
};

export type HarnessResultStore = {
  allocate(input: HarnessResultAllocationInput): Promise<HarnessStoredResult>;
  commit(
    input: { readonly sessionId: string; readonly resultId: string },
    value: unknown,
    patch?: Partial<Omit<HarnessStoredResult, "resultId" | "sessionId" | "sessionDataDir">>,
  ): Promise<HarnessStoredResult>;
  getRecord(input: { readonly sessionId: string; readonly resultId: string }): Promise<HarnessStoredResult | undefined>;
  get(input: { readonly sessionId: string; readonly resultId: string }): Promise<{ readonly record: HarnessStoredResult; readonly value: unknown } | undefined>;
  getByIdempotencyKey(input: { readonly sessionId: string; readonly idempotencyKey: string; readonly sessionDataDir?: string }): Promise<{ readonly record: HarnessStoredResult; readonly value: unknown } | undefined>;
};

export type HarnessResultGrant = {
  readonly resultGrantId: string;
  readonly sessionId: string;
  readonly resultId: string;
  readonly audience: "runtime" | "bash" | "code";
  readonly mountedOutputPath?: string;
  readonly expiresAt?: string;
  readonly createdAt: string;
  readonly revokedAt?: string;
};

export type HarnessResultGrantStore = {
  mintGrant(input: {
    readonly sessionId: string;
    readonly resultId: string;
    readonly audience: HarnessResultGrant["audience"];
    readonly mountedOutputPath?: string;
    readonly expiresAt?: string;
  }): Promise<HarnessResultGrant>;
  get(resultGrantId: string): Promise<HarnessResultGrant | undefined>;
  validateGrant(input: {
    readonly resultGrantId: string;
    readonly sessionId: string;
    readonly resultId: string;
    readonly audience: HarnessResultGrant["audience"];
    readonly now?: string;
  }): Promise<{ readonly valid: true; readonly grant: HarnessResultGrant } | { readonly valid: false; readonly causeCode: "missing" | "wrong_session" | "wrong_result" | "wrong_audience" | "expired" | "revoked" }>;
  revoke(resultGrantId: string, revokedAt: string): Promise<void>;
};

type SessionLedgerState = {
  nextTaskNumber: number;
  readonly records: Map<HarnessTaskId, HarnessTaskRecord>;
  readonly callIdentityBindings: Map<string, HarnessTaskId>;
};

export function createInMemoryTaskLedger(): HarnessTaskLedger {
  const sessions = new Map<string, SessionLedgerState>();

  const sessionState = (sessionId: string) => {
    let state = sessions.get(sessionId);
    if (state === undefined) {
      state = {
        nextTaskNumber: 1,
        records: new Map(),
        callIdentityBindings: new Map(),
      };
      sessions.set(sessionId, state);
    }
    return state;
  };

  return {
    async reserveTask(input) {
      const state = sessionState(input.sessionId);
      if (input.callIdentity !== undefined) {
        const existingTaskId = state.callIdentityBindings.get(input.callIdentity);
        if (existingTaskId !== undefined) {
          const existing = state.records.get(existingTaskId);
          if (existing !== undefined) {
            return existing;
          }
        }
      }

      const taskId = `task_${state.nextTaskNumber}` as HarnessTaskId;
      state.nextTaskNumber += 1;
      const now = new Date().toISOString();
      const record = definedRecord({
        taskId,
        sessionId: input.sessionId,
        kind: input.kind,
        source: input.source,
        status: "queued" as const,
        purpose: input.purpose,
        createdAt: now,
        updatedAt: now,
        workflowId: input.workflowId,
        workflowHandle: input.workflowHandle,
        reservedRunId: input.reservedRunId,
        queueId: input.queueId,
        callIdentity: input.callIdentity,
        runId: input.runId,
      }) as HarnessTaskRecord;
      state.records.set(taskId, record);
      if (input.callIdentity !== undefined) {
        state.callIdentityBindings.set(input.callIdentity, taskId);
      }
      return record;
    },
    async listTasks(input) {
      const allRecords = input?.sessionId === undefined
        ? [...sessions.values()].flatMap((state) => [...state.records.values()])
        : [...sessionState(input.sessionId).records.values()];
      if (input?.statuses === undefined) {
        return allRecords;
      }
      return allRecords.filter((record) => input.statuses?.includes(record.status) ?? false);
    },
    async getTask(input) {
      return sessionState(input.sessionId).records.get(input.taskId);
    },
    async updateTask(record) {
      const state = sessionState(record.sessionId);
      state.records.set(record.taskId, record);
      if (record.callIdentity !== undefined) {
        state.callIdentityBindings.set(record.callIdentity, record.taskId);
      }
    },
    async markTerminal(input, terminal) {
      const state = sessionState(input.sessionId);
      const existing = state.records.get(input.taskId);
      if (existing === undefined || isTerminal(existing.status)) {
        return;
      }
      state.records.set(input.taskId, definedRecord({
        ...existing,
        ...terminal,
      }) as HarnessTaskRecord);
    },
    async bindTaskId(input) {
      sessionState(input.sessionId).callIdentityBindings.set(input.callIdentity, input.taskId);
    },
    async taskIdForCallIdentity(input) {
      return sessionState(input.sessionId).callIdentityBindings.get(input.callIdentity);
    },
    async highWaterMark(sessionId) {
      return sessionState(sessionId).nextTaskNumber - 1;
    },
    async updateTaskTerminal(input) {
      const state = sessionState(input.sessionId);
      const existing = state.records.get(input.taskId);
      if (existing === undefined) {
        return undefined;
      }
      const updated = definedRecord({
        ...existing,
        status: input.status,
        updatedAt: new Date().toISOString(),
        terminalCauseCode: input.terminalCauseCode,
        terminalMessage: input.terminalMessage,
        terminalDiagnostic: input.terminalDiagnostic,
        runId: input.runId ?? existing.runId,
        terminalResultId: input.terminalResultId,
        outputSummary: input.outputSummary,
        outputPath: input.outputPath,
        error: input.error,
      }) as HarnessTaskRecord;
      state.records.set(input.taskId, updated);
      return updated;
    },
    async cancelTask(input) {
      const state = sessionState(input.sessionId);
      const existing = state.records.get(input.taskId);
      if (existing === undefined) {
        return undefined;
      }
      if (isTerminal(existing.status)) {
        return existing;
      }
      const updated = definedRecord({
        ...existing,
        status: "cancelled" as const,
        updatedAt: new Date().toISOString(),
        terminalCauseCode: "cancelled" as const,
        terminalMessage: `Task ${input.taskId} cancelled.`,
        terminalDiagnostic: { cancelled: true, taskId: input.taskId },
      }) as HarnessTaskRecord;
      state.records.set(input.taskId, updated);
      return updated;
    },
  };
}

export function createTaskReservationCoordinator(
  config: { readonly ledger: Pick<HarnessTaskLedger, "reserveTask"> },
): HarnessTaskReservationCoordinator {
  const scopes = new Map<string, PendingReservationScope>();

  return {
    reserveLaunchIntent(intent) {
      validateIntent(intent);
      const scopeKey = `${intent.sessionId}\u0000${intent.reservationScopeId}`;
      let scope = scopes.get(scopeKey);
      if (scope === undefined) {
        scope = {
          sessionId: intent.sessionId,
          scopeSize: intent.scopeSize,
          intents: new Map(),
          waiters: new Map(),
          flushed: false,
        };
        scopes.set(scopeKey, scope);
      }
      if (scope.sessionId !== intent.sessionId || scope.scopeSize !== intent.scopeSize) {
        return Promise.reject(new Error("Reservation scope metadata changed before the scope was sealed."));
      }
      if (scope.intents.has(intent.reservationOrder)) {
        return Promise.reject(new Error(`Duplicate reservation order ${intent.reservationOrder}.`));
      }

      scope.intents.set(intent.reservationOrder, intent);
      const promise = new Promise<HarnessTaskRecord>((resolve, reject) => {
        scope.waiters.set(intent.reservationOrder, { resolve, reject });
      });

      if (!scope.flushed && scope.intents.size === scope.scopeSize) {
        scope.flushed = true;
        void flushScope(config.ledger, scope).finally(() => {
          scopes.delete(scopeKey);
        });
      }
      return promise;
    },
  };
}

type PendingReservationScope = {
  readonly sessionId: string;
  readonly scopeSize: number;
  readonly intents: Map<number, HarnessTaskReservationIntent>;
  readonly waiters: Map<number, {
    resolve(record: HarnessTaskRecord): void;
    reject(error: unknown): void;
  }>;
  flushed: boolean;
};

async function flushScope(
  ledger: Pick<HarnessTaskLedger, "reserveTask">,
  scope: PendingReservationScope,
): Promise<void> {
  for (let order = 0; order < scope.scopeSize; order += 1) {
    const waiter = scope.waiters.get(order);
    const intent = scope.intents.get(order);
    if (waiter === undefined || intent === undefined) {
      const error = new Error(`Reservation scope is missing order ${order}.`);
      for (const pendingWaiter of scope.waiters.values()) {
        pendingWaiter.reject(error);
      }
      return;
    }
    try {
      const record = await ledger.reserveTask({ sessionId: intent.sessionId, ...intent.task });
      waiter.resolve(record);
    } catch (error) {
      waiter.reject(error);
    }
  }
}

function validateIntent(intent: HarnessTaskReservationIntent): void {
  if (!Number.isInteger(intent.reservationOrder) || intent.reservationOrder < 0) {
    throw new Error("reservationOrder must be a non-negative integer.");
  }
  if (!Number.isInteger(intent.scopeSize) || intent.scopeSize <= 0) {
    throw new Error("scopeSize must be a positive integer.");
  }
  if (intent.reservationOrder >= intent.scopeSize) {
    throw new Error("reservationOrder must be smaller than scopeSize.");
  }
}

function isTerminal(status: HarnessTaskStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function definedRecord(input: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) {
      output[key] = value;
    }
  }
  return output;
}
