import { HarnessInputError } from "../errors.js";
import { stableHash } from "../utils/canonical-hash.js";
import type {
  HarnessAgentGroupAggregate,
  HarnessAgentGroupPendingOperation,
  HarnessAgentGroupOperationResult,
  HarnessAgentMemberStatus,
} from "../agents/types.js";
import type {
  HarnessFailureCauseCode,
  HarnessPreparedWorkflow,
  HarnessWorkflowDefinitionIdentity,
  HarnessWorkflowInheritancePolicy,
} from "../workflows.js";
import type { WorkflowLaunchTransactionInput } from "../workflow-scheduler/types.js";
import type {
  HarnessTaskId,
  HarnessAsyncToolTaskKind,
  HarnessTaskFailureCauseCode,
  HarnessTaskKind,
  HarnessTaskRecord,
  HarnessTaskReservationCoordinator,
  HarnessTaskReservationIntent,
  HarnessTaskReserveInput,
  HarnessTaskStatus,
  HarnessTerminalDiagnostic,
} from "./types.js";
import {
  agentGroupJoinBeginReservationInputFromBinding,
  agentGroupJoinBeginReservationPhaseRank,
  joinBeginReservationResult,
  validAgentGroupPageCallInput,
  validAgentGroupJoinBeginReservationInput,
} from "./agent-group-join-begin.js";

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

export type HarnessAgentMemberObservationProjection = Readonly<{
  taskId: HarnessTaskId;
  memberRevision: number;
  memberObservationDigest: string;
  memberStateDigest: string;
  memberObservedAt: string;
  status: HarnessTaskStatus;
  outputSummary?: string;
  externalAgentResultRef?: string;
  error?: string;
  terminalCauseCode?: HarnessTaskFailureCauseCode;
  terminalMessage?: string;
  terminalDiagnostic?: unknown;
}>;

export type HarnessAgentGroupObservationProjection = Readonly<{
  sessionId: string;
  scopeIdentity: string;
  groupRevision: number;
  groupStatus: NonNullable<HarnessTaskRecord["agentGroupStatus"]>;
  groupObservationDigest: string;
  groupObservedAt: string;
  /** Fences join-only disposition/summary/result-ref reductions at this group revision. */
  joinReductionDigest?: string;
  members: readonly HarnessAgentMemberObservationProjection[];
}>;

export type HarnessAgentGroupObservationProjectionResult = Readonly<{
  outcome: "applied" | "replayed" | "stale" | "conflict" | "invalid_transition" | "inconsistent";
  records: readonly HarnessTaskRecord[];
}>;

/** Compact O(1) authority used by the bounded member-change observation path. */
export type HarnessAgentGroupPageState = Readonly<{
  sessionId: string;
  scopeIdentity: string;
  groupRef: string;
  launchAcceptedAt: string;
  launchCallIdentity?: string;
  memberCount: number;
  aggregateVersion: number;
  minimumRetainedSequence: number;
  acknowledgedSequence: number;
  groupStatus: NonNullable<HarnessTaskRecord["agentGroupStatus"]>;
  aggregate: HarnessAgentGroupAggregate;
  groupObservationDigest: string;
  groupObservedAt: string;
  agentJoinPolicyHandle: string;
  agentJoinPolicyKind: NonNullable<HarnessTaskRecord["agentJoinPolicyKind"]>;
  agentJoinQuorumCount?: number;
  agentVerifierHandle?: string;
  agentRequiredCheckSetHandle?: string;
  agentReductionPolicyHandle: string;
  agentMaxMemberSummaryBytes: number;
  agentMaxGroupSummaryBytes: number;
  agentMaxResultRefs: number;
}>;

export type HarnessAgentGroupMemberChangeProjection = Omit<HarnessAgentMemberObservationProjection, "taskId"> & Readonly<{
  sequence: number;
  /** Omitted only by legacy v1 callers; v2 callers always send `member`. */
  kind?: "member";
  memberId: string;
  memberIndex: number;
  taskRef: string;
  memberStatus: HarnessAgentMemberStatus;
  verifiedSucceeded: boolean;
  hasResultRef: boolean;
}>;

export type HarnessAgentGroupControlChangeProjection = Readonly<{
  sequence: number;
  kind: "group_control";
  groupStatus: NonNullable<HarnessTaskRecord["agentGroupStatus"]>;
  groupObservedAt: string;
  controlDigest: string;
}>;

export type HarnessAgentGroupChangeProjection =
  | HarnessAgentGroupMemberChangeProjection
  | HarnessAgentGroupControlChangeProjection;

export type HarnessAgentGroupPageProjection = Readonly<{
  sessionId: string;
  scopeIdentity: string;
  groupRef: string;
  requestIdempotencyKey: string;
  pageDigest: string;
  afterSequence: number;
  throughSequence: number;
  aggregateVersion: number;
  groupStatus: NonNullable<HarnessTaskRecord["agentGroupStatus"]>;
  aggregate: HarnessAgentGroupAggregate;
  groupObservationDigest: string;
  groupObservedAt: string;
  pageCallIdentity: string;
  changes: readonly HarnessAgentGroupChangeProjection[];
}>;

export type HarnessAgentGroupPageProjectionResult = Readonly<{
  outcome: HarnessAgentGroupObservationProjectionResult["outcome"];
  records: readonly HarnessTaskRecord[];
}>;

export type HarnessAgentGroupPageCallBinding = Readonly<{
  sessionId: string;
  scopeIdentity: string;
  groupRef: string;
  callIdentity: string;
  operationKind: "watch" | "join" | "cancel";
  canonicalInputDigest: string;
  requestIdempotencyKey: string;
  requestedAfterSequence?: number;
  pageCursorDigest?: string;
  maximumChanges: number;
  maximumBytes: number;
  maximumCursorBytes: number;
}>;

export type HarnessAgentGroupPageCallBindingResult = Readonly<{
  outcome: "applied" | "replayed" | "conflict" | "expired" | "exhausted" | "inconsistent";
  requestIdempotencyKey: string;
  startSequence: number;
  currentHighWater: number;
  minimumRetainedSequence: number;
}>;

/**
 * The immutable identity reserved before a paged Agent Group join reaches the
 * adapter.  This is deliberately one operation-keyed record, rather than a
 * mutable group history: if the adapter accepts a remote begin and the local
 * response is lost, the same bytes can be replayed after restart.
 */
export type HarnessAgentGroupJoinBeginReservation = Readonly<{
  sessionId: string;
  scopeIdentity: string;
  groupRef: string;
  pageCallIdentity: string;
  requestIdempotencyKey: string;
  operationIdempotencyKey: string;
  mutationInputDigest: string;
}>;

export type HarnessAgentGroupJoinBeginReservationResult = Readonly<{
  outcome: "applied" | "replayed" | "ref_bound" | "pending" | "terminal" | "conflict" | "inconsistent";
  phase: "reserved";
  operationRef?: string;
}> | Readonly<{
  outcome: "applied" | "replayed" | "ref_bound" | "pending" | "terminal" | "conflict" | "inconsistent";
  phase: "ref_bound" | "pending" | "terminal";
  operationRef: string;
}>;

export type HarnessAgentGroupOperationResultBinding = Readonly<{
  sessionId: string;
  scopeIdentity: string;
  groupRef: string;
  operationIdempotencyKey: string;
  mutationInputDigest: string;
  operationMode: "begin" | "continue";
  /** Store exact bytes immediately; visibility authorization additionally checks result-ref publication fences. */
  authorizeVisibility?: boolean;
  /** Supplied by paged join callers so the begin reservation can be advanced. */
  pageCallIdentity?: string;
  requestIdempotencyKey?: string;
  result: HarnessAgentGroupOperationResult;
}>;

/**
 * Binds the operation reference returned by a bounded begin call before a
 * terminal result exists.  A later continue may install the first immutable
 * result only through this exact pending authority.
 */
export type HarnessAgentGroupPendingOperationBinding = Readonly<{
  sessionId: string;
  scopeIdentity: string;
  groupRef: string;
  operationIdempotencyKey: string;
  mutationInputDigest: string;
  operationMode: "begin" | "continue";
  /** Supplied by paged join callers so the begin reservation can be advanced. */
  pageCallIdentity?: string;
  requestIdempotencyKey?: string;
  pending: HarnessAgentGroupPendingOperation;
}>;

export type HarnessAgentGroupPendingOperationBindingResult = Readonly<{
  outcome: "applied" | "replayed" | "conflict" | "inconsistent";
}>;

export type HarnessAgentGroupOperationResultBindingResult = Readonly<{
  outcome: "applied" | "replayed" | "conflict" | "inconsistent";
}>;

export type HarnessAgentGroupTaskBatchReservation = Readonly<{
  sessionId: string;
  callIdentity: string;
  scopeIdentity: string;
  canonicalInputDigest: string;
  tasks: readonly Omit<HarnessTaskReserveInput, "sessionId">[];
}>;

export type HarnessAgentGroupTaskBatchReservationResult = Readonly<{
  outcome: "applied" | "replayed" | "conflict" | "inconsistent";
  records: readonly HarnessTaskRecord[];
}>;

export type HarnessAgentGroupStartBinding = Readonly<{
  sessionId: string;
  scopeIdentity: string;
  groupRef: string;
  acceptedAt: string;
  launchCallIdentity?: string;
  /** Defaults to legacy_snapshot for backward-compatible custom callers. */
  observationMode?: "legacy_snapshot" | "paged_changes";
  members: readonly Readonly<{
    taskId: HarnessTaskId;
    memberId: string;
    memberIndex: number;
    taskRef: string;
  }>[];
}>;

export type HarnessAgentGroupStartBindingResult = Readonly<{
  outcome: "applied" | "replayed" | "conflict" | "inconsistent";
  records: readonly HarnessTaskRecord[];
}>;

export type HarnessAgentGroupGarbageCollectionResult = Readonly<{
  outcome: "collected" | "replayed" | "conflict" | "not_terminal" | "inconsistent";
}>;

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
  /**
   * The parked call waited in `ask(..., { wait: true })`: when the turn continues, its `execute`
   * runs again in place of being handed this wait's outcome.
   */
  readonly rerun?: boolean;
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
  readonly inheritance: HarnessWorkflowInheritancePolicy;
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
  readonly kind: HarnessAsyncToolTaskKind;
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
  readonly kind: "tool" | "workflow" | "workflow-input" | "agent" | "bash" | "code" | "mcp" | "input" | "continuation";
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
  /** Failed tries to continue the turn so far. */
  readonly attempts?: number;
  /** After a failed try, `claimNext` skips the record until this time. */
  readonly retryAt?: string;
};

export type HarnessResumeQueue = {
  enqueue(record: HarnessResumeQueueRecord): Promise<void>;
  ensureEnqueued(record: HarnessResumeQueueRecord): Promise<{ readonly enqueued: boolean; readonly record: HarnessResumeQueueRecord }>;
  claimNext(sessionId?: string): Promise<HarnessResumeQueueRecord | undefined>;
  /**
   * Claims the record `resumeId` as `claimNext` would, whatever its place in the queue. Undefined
   * when it is missing, already claimed or completed. `resumeParked` needs it for `resumeId`.
   */
  claim?(resumeId: string): Promise<HarnessResumeQueueRecord | undefined>;
  markCompleted(resumeId: string, completedAt: string): Promise<void>;
  listOpen(sessionId?: string): Promise<readonly HarnessResumeQueueRecord[]>;
};

export type HarnessTaskLedger = {
  reserveTask(input: HarnessTaskReserveInput): Promise<HarnessTaskRecord>;
  getTask(input: HarnessTaskLookupInput): Promise<HarnessTaskRecord | undefined>;
  listTasks(filter?: { readonly sessionId?: string; readonly statuses?: readonly HarnessTaskStatus[] }): Promise<readonly HarnessTaskRecord[]>;
  updateTask(record: HarnessTaskRecord): Promise<void>;
  /** Optional atomic O(N) reservation required by paged Agent Groups. */
  reserveAgentGroupTaskBatch?(
    input: HarnessAgentGroupTaskBatchReservation,
  ): Promise<HarnessAgentGroupTaskBatchReservationResult>;
  /** Optional capability required only when `createHarness({ agents })` is enabled. */
  bindAgentGroupStart?(
    input: HarnessAgentGroupStartBinding,
  ): Promise<HarnessAgentGroupStartBindingResult>;
  /** Optional capability required only when `createHarness({ agents })` is enabled. */
  projectAgentGroupObservation?(
    input: HarnessAgentGroupObservationProjection,
  ): Promise<HarnessAgentGroupObservationProjectionResult>;
  /** Optional O(1) lookup required by paged Agent Group launchers. */
  getAgentGroupPageState?(input: {
    readonly sessionId: string;
    readonly groupRef: string;
  }): Promise<HarnessAgentGroupPageState | undefined>;
  /** Atomically binds one control call to a stable page checkpoint before launcher I/O. */
  bindAgentGroupPageCall?(
    input: HarnessAgentGroupPageCallBinding,
  ): Promise<HarnessAgentGroupPageCallBindingResult>;
  /** Reserves the exact paged join begin identity before launcher I/O. */
  reserveAgentGroupJoinBegin?(
    input: HarnessAgentGroupJoinBeginReservation,
  ): Promise<HarnessAgentGroupJoinBeginReservationResult>;
  /** Binds immutable join/cancel visible bytes and validates result-ref ownership. */
  bindAgentGroupOperationResult?(
    input: HarnessAgentGroupOperationResultBinding,
  ): Promise<HarnessAgentGroupOperationResultBindingResult>;
  /** Binds the exact pending operation reference returned by a begin call. */
  bindAgentGroupPendingOperation?(
    input: HarnessAgentGroupPendingOperationBinding,
  ): Promise<HarnessAgentGroupPendingOperationBindingResult>;
  /** Optional O(changes) projection required by paged Agent Group launchers. */
  projectAgentGroupPage?(
    input: HarnessAgentGroupPageProjection,
  ): Promise<HarnessAgentGroupPageProjectionResult>;
  /** Explicit whole-group terminal CAS collection for bounded durable lifecycle. */
  collectAgentGroupGarbage?(input: {
    readonly sessionId: string;
    readonly groupRef: string;
    readonly expectedAggregateVersion: number;
    readonly expectedGroupObservationDigest: string;
  }): Promise<HarnessAgentGroupGarbageCollectionResult>;
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
    readonly kind: HarnessAsyncToolTaskKind;
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
  readonly agentGroupPages: Map<string, InMemoryAgentGroupPageAuthority>;
  readonly agentGroupBatchReservations: Map<string, Readonly<{
    canonicalInputDigest: string;
    records: readonly HarnessTaskRecord[];
  }>>;
};

type InMemoryAgentGroupPageAuthority = {
  state: HarnessAgentGroupPageState;
  readonly taskIdsByMemberIndex: readonly HarnessTaskId[];
  readonly accountingByMemberIndex: Array<Readonly<{
    status: HarnessAgentMemberStatus;
    verifiedSucceeded: boolean;
    hasResultRef: boolean;
  }>>;
  readonly requestDigests: Map<string, string>;
  readonly pageCalls: Map<string, Readonly<{
    canonicalInputDigest: string;
    bindingDigest: string;
    operationKind: "watch" | "join" | "cancel";
    result: HarnessAgentGroupPageCallBindingResult;
  }>>;
  readonly pageCallOrder: string[];
  readonly expiredPageCallOrder: string[];
  readonly expiredPageCalls: Set<string>;
  readonly retiredPageCallDigests: Set<string>;
  pageCallsIssued: number;
  readonly operationResults: Map<string, Readonly<{
    beginOperationIdempotencyKey: string;
    beginMutationInputDigest: string;
    resultDigest: string;
    result: HarnessAgentGroupOperationResult;
    visibilityAuthorized: boolean;
  }>>;
  readonly pendingOperations: Map<string, Readonly<{
    operationIdempotencyKey: string;
    mutationInputDigest: string;
    pending: HarnessAgentGroupPendingOperation;
  }>>;
  readonly operationRefsByIdempotencyKey: Map<string, Readonly<{
    operationRef: string;
    operationMode: "begin" | "continue";
    mutationInputDigest: string;
  }>>;
  activeJoinBeginReservation?: Readonly<{
    input: HarnessAgentGroupJoinBeginReservation;
    phase: "reserved" | "ref_bound" | "pending" | "terminal";
    operationRef?: string;
  }>;
};

/**
 * A page resume point is intentionally finite. The compact authority and the
 * latest member image survive indefinitely; only replay/cursor history is
 * bounded. A cursorless call always reopens at the current durable high-water.
 */
export const HARNESS_AGENT_GROUP_PAGE_RETENTION = 4_096;
export const HARNESS_AGENT_GROUP_MAX_LIFETIME_PAGE_CALLS = 65_536;

type AgentGroupResultRefOwner = Readonly<{
  sessionId: string;
  scopeIdentity: string;
  groupRef: string;
  memberId: string;
  memberIndex: number;
  memberRevision: number;
  publicationSequence: number;
  publicationDigest: string;
  resultRef: string;
  ownerDigest: string;
}>;

/** @internal Shared atomic start-binding evaluator for orchestration backends. */
export function evaluateAgentGroupStartBinding(
  input: HarnessAgentGroupStartBinding,
  current: readonly HarnessTaskRecord[],
): HarnessAgentGroupStartBindingResult {
  const records = Object.freeze([...current]);
  if (records.length === 0 || records.length !== input.members.length ||
      !Number.isFinite(Date.parse(input.acceptedAt)) || input.groupRef.length === 0) {
    return Object.freeze({ outcome: "inconsistent", records });
  }
  if (records.some((record, index) => {
    const member = input.members[index]!;
    return record.taskId !== member.taskId || record.sessionId !== input.sessionId ||
      record.kind !== "agent" ||
      record.agentGroupScopeIdentity !== input.scopeIdentity ||
      record.agentMemberId !== member.memberId || record.agentMemberIndex !== member.memberIndex ||
      member.memberId !== `member_${index + 1}` || member.memberIndex !== index ||
      member.taskRef.length === 0 || input.acceptedAt < record.createdAt;
  })) {
    return Object.freeze({ outcome: "inconsistent", records });
  }
  const bound = records.filter((record) => record.externalAgentGroupRef !== undefined);
  if (bound.length > 0) {
    if (bound.length !== records.length) return Object.freeze({ outcome: "inconsistent", records });
    const replayed = records.every((record, index) =>
      record.externalAgentGroupRef === input.groupRef &&
      record.externalAgentTaskRef === input.members[index]!.taskRef &&
      record.agentLaunchAcceptedAt === input.acceptedAt);
    return Object.freeze({ outcome: replayed ? "replayed" : "conflict", records });
  }
  if (records.some((record) => record.status !== "queued")) {
    return Object.freeze({ outcome: "inconsistent", records });
  }
  const groupDigest = stableHash({ status: "queued", acceptedAt: input.acceptedAt });
  return Object.freeze({
    outcome: "applied",
    records: Object.freeze(records.map((record, index) => definedRecord({
      ...record,
      updatedAt: input.acceptedAt,
      externalAgentGroupRef: input.groupRef,
      externalAgentTaskRef: input.members[index]!.taskRef,
      agentLaunchAcceptedAt: input.acceptedAt,
      agentGroupRevision: 0,
      agentGroupStatus: "queued",
      agentGroupObservationDigest: groupDigest,
      agentGroupObservedAt: input.acceptedAt,
      agentMemberRevision: 0,
      agentMemberObservationDigest: stableHash({
        status: "queued",
        acceptedAt: input.acceptedAt,
        index,
      }),
      agentMemberStateDigest: stableHash({ status: "queued" }),
      agentMemberObservedAt: input.acceptedAt,
    }) as HarnessTaskRecord)),
  });
}

/** @internal Rebuilds the immutable accepted-start receipt from mutable member images. */
export function createAgentGroupAcceptedStartReceipt(input: Readonly<{
  sessionId: string;
  scopeIdentity: string;
  groupRef: string;
  acceptedAt: string;
  records: readonly HarnessTaskRecord[];
}>): readonly HarnessTaskRecord[] | undefined {
  if (input.records.length === 0 || input.records.some((record, memberIndex) =>
    record.sessionId !== input.sessionId || record.agentGroupScopeIdentity !== input.scopeIdentity ||
    record.externalAgentGroupRef !== input.groupRef || record.agentLaunchAcceptedAt !== input.acceptedAt ||
    record.agentMemberIndex !== memberIndex || record.agentMemberId !== `member_${memberIndex + 1}` ||
    record.externalAgentTaskRef === undefined || record.externalAgentTaskRef.length === 0)) {
    return undefined;
  }
  const reservations = Object.freeze(input.records.map((record) =>
    recordForReservedTask(taskReservationInputFromRecord(record), record.taskId, record.createdAt)));
  const evaluated = evaluateAgentGroupStartBinding({
    sessionId: input.sessionId,
    scopeIdentity: input.scopeIdentity,
    groupRef: input.groupRef,
    acceptedAt: input.acceptedAt,
    observationMode: "paged_changes",
    members: Object.freeze(input.records.map((record, memberIndex) => Object.freeze({
      taskId: record.taskId,
      memberId: `member_${memberIndex + 1}`,
      memberIndex,
      taskRef: record.externalAgentTaskRef!,
    }))),
  }, reservations);
  return evaluated.outcome === "applied" ? evaluated.records : undefined;
}

function validInMemoryAgentGroupPendingOperationBinding(
  input: HarnessAgentGroupPendingOperationBinding,
  launchAcceptedAt: string,
): boolean {
  const pending = input.pending;
  const body = {
    operationRef: pending.operationRef,
    observedAggregateVersion: pending.observedAggregateVersion,
    observedAt: pending.observedAt,
    retryAfterMs: pending.retryAfterMs,
  };
  const valid = input.operationIdempotencyKey.length > 0 && input.mutationInputDigest.length > 0 &&
    (input.operationMode === "begin" || input.operationMode === "continue") &&
    pending.operationRef.length > 0 && Number.isSafeInteger(pending.observedAggregateVersion) &&
    pending.observedAggregateVersion >= 0 &&
    Number.isFinite(Date.parse(pending.observedAt)) && pending.observedAt >= launchAcceptedAt &&
    Number.isSafeInteger(pending.retryAfterMs) && pending.retryAfterMs >= 1 &&
    pending.retryAfterMs <= 60_000 && pending.pendingDigest.length > 0 &&
    pending.pendingDigest === stableHash(body);
  return valid;
}

function pendingOperationObservationReplayCompatible(
  existing: HarnessAgentGroupPendingOperation,
  incoming: HarnessAgentGroupPendingOperation,
): boolean {
  return existing.operationRef === incoming.operationRef &&
    incoming.observedAggregateVersion >= existing.observedAggregateVersion &&
    incoming.observedAt >= existing.observedAt;
}

/** @internal Shared atomic-projection evaluator for orchestration backends. */
export function evaluateAgentGroupObservationProjection(
  input: HarnessAgentGroupObservationProjection,
  current: readonly HarnessTaskRecord[],
): HarnessAgentGroupObservationProjectionResult {
  const records = Object.freeze([...current]);
  if (records.length === 0 || records.length !== input.members.length ||
      !Number.isSafeInteger(input.groupRevision) || input.groupRevision < 1 ||
      input.groupObservationDigest.length === 0 || !Number.isFinite(Date.parse(input.groupObservedAt))) {
    return Object.freeze({ outcome: "inconsistent", records });
  }
  const first = records[0]!;
  if (records.some((record, index) =>
    record.taskId !== input.members[index]!.taskId || record.sessionId !== input.sessionId ||
    record.kind !== "agent" || record.agentGroupScopeIdentity !== input.scopeIdentity ||
    record.agentMemberIndex !== index || record.agentMemberId !== `member_${index + 1}` ||
    record.agentGroupRevision !== first.agentGroupRevision ||
    record.agentGroupStatus !== first.agentGroupStatus ||
    record.agentGroupObservationDigest !== first.agentGroupObservationDigest ||
    record.agentGroupObservedAt !== first.agentGroupObservedAt ||
    record.agentJoinReductionRevision !== first.agentJoinReductionRevision ||
    record.agentJoinReductionDigest !== first.agentJoinReductionDigest)) {
    return Object.freeze({ outcome: "inconsistent", records });
  }

  const currentGroupRevision = first.agentGroupRevision ?? 0;
  const currentGroupStatus = first.agentGroupStatus ?? "queued";
  if (input.groupRevision < currentGroupRevision) {
    return Object.freeze({ outcome: "stale", records });
  }
  if (input.groupRevision === currentGroupRevision) {
    const snapshotReplayed = first.agentGroupObservationDigest === input.groupObservationDigest &&
      input.members.every((member, index) => {
        const record = records[index]!;
        return record.agentMemberRevision === member.memberRevision &&
          record.agentMemberObservationDigest === member.memberObservationDigest;
      });
    if (!snapshotReplayed) return Object.freeze({ outcome: "conflict", records });
    if (input.joinReductionDigest === undefined) {
      return Object.freeze({ outcome: "replayed", records });
    }
    if (first.agentJoinReductionRevision === undefined) {
      const joinReductionDigest = input.joinReductionDigest;
      return Object.freeze({
        outcome: "applied",
        records: Object.freeze(records.map((record) => Object.freeze({
          ...record,
          agentJoinReductionRevision: input.groupRevision,
          agentJoinReductionDigest: joinReductionDigest,
        }))),
      });
    }
    const reductionReplayed = first.agentJoinReductionRevision === input.groupRevision &&
      first.agentJoinReductionDigest === input.joinReductionDigest;
    return Object.freeze({ outcome: reductionReplayed ? "replayed" : "conflict", records });
  }
  if (!allowedAgentGroupTransition(currentGroupStatus, input.groupStatus) ||
      (first.agentGroupObservedAt !== undefined && input.groupObservedAt < first.agentGroupObservedAt) ||
      records.some((record) => input.groupObservedAt < record.createdAt)) {
    return Object.freeze({ outcome: "invalid_transition", records });
  }

  const updated: HarnessTaskRecord[] = [];
  for (const [index, member] of input.members.entries()) {
    const record = records[index]!;
    if (!Number.isSafeInteger(member.memberRevision) || member.memberRevision < 1 ||
        member.memberObservationDigest.length === 0 || member.memberStateDigest.length === 0 ||
        !Number.isFinite(Date.parse(member.memberObservedAt)) || member.memberObservedAt < record.createdAt ||
        (record.agentMemberObservedAt !== undefined && member.memberObservedAt < record.agentMemberObservedAt)) {
      return Object.freeze({ outcome: "inconsistent", records });
    }
    const currentMemberRevision = record.agentMemberRevision ?? 0;
    if (member.memberRevision < currentMemberRevision) {
      return Object.freeze({ outcome: "stale", records });
    }
    if (member.memberRevision === currentMemberRevision) {
      if (record.agentMemberObservationDigest !== member.memberObservationDigest) {
        return Object.freeze({ outcome: "conflict", records });
      }
    } else if (!allowedAgentMemberTransition(
      record.status,
      member.status,
      record.agentMemberStateDigest,
      member.memberStateDigest,
    )) {
      return Object.freeze({ outcome: "invalid_transition", records });
    }
    updated.push(definedRecord({
      ...record,
      status: member.status,
      updatedAt: member.memberObservedAt,
      outputSummary: member.outputSummary,
      externalAgentResultRef: member.externalAgentResultRef,
      error: member.error,
      terminalCauseCode: member.terminalCauseCode,
      terminalMessage: member.terminalMessage,
      terminalDiagnostic: member.terminalDiagnostic,
      agentGroupRevision: input.groupRevision,
      agentGroupStatus: input.groupStatus,
      agentGroupObservationDigest: input.groupObservationDigest,
      agentGroupObservedAt: input.groupObservedAt,
      agentMemberRevision: member.memberRevision,
      agentMemberObservationDigest: member.memberObservationDigest,
      agentMemberStateDigest: member.memberStateDigest,
      agentMemberObservedAt: member.memberObservedAt,
      agentJoinReductionRevision: input.joinReductionDigest === undefined
        ? undefined
        : input.groupRevision,
      agentJoinReductionDigest: input.joinReductionDigest,
    }) as HarnessTaskRecord);
  }
  return Object.freeze({ outcome: "applied", records: Object.freeze(updated) });
}

function allowedAgentGroupTransition(
  from: NonNullable<HarnessTaskRecord["agentGroupStatus"]>,
  to: NonNullable<HarnessTaskRecord["agentGroupStatus"]>,
): boolean {
  if (from === "queued") return true;
  if (from === "running") return to !== "queued";
  if (from === "satisfied") return to === "satisfied";
  if (from === "deadline") return to === "deadline" || to === "cancelled";
  return to === from;
}

function allowedAgentMemberTransition(
  from: HarnessTaskStatus,
  to: HarnessTaskStatus,
  currentStateDigest: string | undefined,
  incomingStateDigest: string,
): boolean {
  if (from === "queued") return true;
  if (from === "running") return to !== "queued";
  return to === from && currentStateDigest === incomingStateDigest;
}

/** @internal Stable Agent Group member-to-task status projection. */
export function agentTaskStatus(status: HarnessAgentMemberStatus): HarnessTaskStatus {
  if (status === "queued") return "queued";
  if (status === "running") return "running";
  if (status === "succeeded") return "completed";
  if (status === "cancelled") return "cancelled";
  return "failed";
}

function initialAgentGroupAggregate(memberCount: number): HarnessAgentGroupAggregate {
  return Object.freeze({
    memberCount,
    queuedCount: memberCount,
    runningCount: 0,
    succeededCount: 0,
    failedCount: 0,
    cancelledCount: 0,
    timedOutCount: 0,
    verifiedSucceededCount: 0,
    resultRefCount: 0,
  });
}

type AgentGroupMemberAccounting = Readonly<{
  status: HarnessAgentMemberStatus;
  verifiedSucceeded: boolean;
  hasResultRef: boolean;
}>;

/** @internal O(1) aggregate delta shared by in-memory and durable page authorities. */
export function applyAgentGroupMemberAccountingDelta(
  aggregate: HarnessAgentGroupAggregate,
  previous: AgentGroupMemberAccounting,
  next: AgentGroupMemberAccounting,
): HarnessAgentGroupAggregate {
  const counts = { ...aggregate };
  const field = (status: HarnessAgentMemberStatus): keyof HarnessAgentGroupAggregate => {
    if (status === "queued") return "queuedCount";
    if (status === "running") return "runningCount";
    if (status === "succeeded") return "succeededCount";
    if (status === "failed") return "failedCount";
    if (status === "cancelled") return "cancelledCount";
    return "timedOutCount";
  };
  const previousField = field(previous.status);
  const nextField = field(next.status);
  counts[previousField] -= 1;
  counts[nextField] += 1;
  counts.verifiedSucceededCount += Number(next.verifiedSucceeded) - Number(previous.verifiedSucceeded);
  counts.resultRefCount += Number(next.hasResultRef) - Number(previous.hasResultRef);
  return Object.freeze(counts);
}

/** @internal Builds the compact page authority committed beside an atomic start binding. */
export function createAgentGroupPageStateFromBinding(
  input: HarnessAgentGroupStartBinding,
  records: readonly HarnessTaskRecord[],
): HarnessAgentGroupPageState | undefined {
  const first = records[0];
  if (first === undefined || first.agentJoinPolicyHandle === undefined ||
      first.agentJoinPolicyKind === undefined || first.agentReductionPolicyHandle === undefined ||
      first.agentMaxMemberSummaryBytes === undefined || first.agentMaxGroupSummaryBytes === undefined ||
      first.agentMaxResultRefs === undefined || first.agentGroupObservationDigest === undefined ||
      first.agentGroupObservedAt === undefined) {
    return undefined;
  }
  return Object.freeze({
    sessionId: input.sessionId,
    scopeIdentity: input.scopeIdentity,
    groupRef: input.groupRef,
    launchAcceptedAt: input.acceptedAt,
    ...(input.launchCallIdentity === undefined ? {} : { launchCallIdentity: input.launchCallIdentity }),
    memberCount: records.length,
    aggregateVersion: 0,
    minimumRetainedSequence: 0,
    acknowledgedSequence: 0,
    groupStatus: "queued",
    aggregate: initialAgentGroupAggregate(records.length),
    groupObservationDigest: first.agentGroupObservationDigest,
    groupObservedAt: first.agentGroupObservedAt,
    agentJoinPolicyHandle: first.agentJoinPolicyHandle,
    agentJoinPolicyKind: first.agentJoinPolicyKind,
    ...(first.agentJoinQuorumCount === undefined ? {} : { agentJoinQuorumCount: first.agentJoinQuorumCount }),
    ...(first.agentVerifierHandle === undefined ? {} : { agentVerifierHandle: first.agentVerifierHandle }),
    ...(first.agentRequiredCheckSetHandle === undefined
      ? {}
      : { agentRequiredCheckSetHandle: first.agentRequiredCheckSetHandle }),
    agentReductionPolicyHandle: first.agentReductionPolicyHandle,
    agentMaxMemberSummaryBytes: first.agentMaxMemberSummaryBytes,
    agentMaxGroupSummaryBytes: first.agentMaxGroupSummaryBytes,
    agentMaxResultRefs: first.agentMaxResultRefs,
  });
}

/** @internal Launched Agent Group tasks are mutated only by the fenced projection path. */
export function assertGenericAgentTaskMutationAllowed(
  existing: HarnessTaskRecord,
  incoming?: HarnessTaskRecord,
): void {
  if (existing.kind !== "agent" || existing.externalAgentGroupRef === undefined) return;
  if (incoming !== undefined && stableHash(existing) === stableHash(incoming)) return;
  throw new HarnessInputError(
    "Launched Agent Group tasks cannot be mutated through generic task operations; " +
    "use cancel_agent_group or a revision-fenced launcher observation.",
    { taskId: existing.taskId, agentGroupRef: existing.externalAgentGroupRef },
  );
}

function inMemoryJoinBeginPhase(
  authority: InMemoryAgentGroupPageAuthority,
  operationIdempotencyKey: string,
): Readonly<{
  phase: "reserved" | "ref_bound" | "pending" | "terminal";
  operationRef?: string;
}> {
  const ref = authority.operationRefsByIdempotencyKey.get(operationIdempotencyKey);
  if (ref === undefined) return Object.freeze({ phase: "reserved" as const });
  const result = authority.operationResults.get(ref.operationRef);
  if (result !== undefined) {
    return Object.freeze({ phase: "terminal" as const, operationRef: ref.operationRef });
  }
  return Object.freeze({
    phase: authority.pendingOperations.has(ref.operationRef)
      ? "pending" as const
      : "ref_bound" as const,
    operationRef: ref.operationRef,
  });
}

function updateInMemoryJoinBeginReservation(
  authority: InMemoryAgentGroupPageAuthority,
  operationIdempotencyKey: string,
  phase: "ref_bound" | "pending" | "terminal",
  operationRef: string,
  input?: HarnessAgentGroupJoinBeginReservation,
): void {
  const active = authority.activeJoinBeginReservation;
  if (active === undefined ||
      active.input.operationIdempotencyKey !== operationIdempotencyKey && active.operationRef !== operationRef ||
      active.operationRef !== undefined && active.operationRef !== operationRef) {
    return;
  }
  if (input !== undefined && stableHash(active.input) !== stableHash(input)) {
    throw new HarnessInputError("Agent Group join reservation identity changed after adapter I/O.");
  }
  const effectivePhase = agentGroupJoinBeginReservationPhaseRank(active.phase) >=
      agentGroupJoinBeginReservationPhaseRank(phase)
    ? active.phase
    : phase;
  const updated = Object.freeze({ ...active, phase: effectivePhase, operationRef });
  if (effectivePhase === "terminal" && authority.operationResults.get(operationRef)?.visibilityAuthorized === true) {
    delete authority.activeJoinBeginReservation;
  } else {
    authority.activeJoinBeginReservation = updated;
  }
}

function overlayInMemoryAgentGroupPageAuthority(
  record: HarnessTaskRecord,
  authority: InMemoryAgentGroupPageAuthority | undefined,
): HarnessTaskRecord {
  if (authority === undefined) return record;
  return definedRecord({
    ...record,
    agentGroupRevision: authority.state.aggregateVersion,
    agentGroupStatus: authority.state.groupStatus,
    agentGroupObservationDigest: authority.state.groupObservationDigest,
    agentGroupObservedAt: authority.state.groupObservedAt,
  }) as HarnessTaskRecord;
}

function recordForReservedTask(
  input: HarnessTaskReserveInput,
  taskId: HarnessTaskId,
  now: string,
): HarnessTaskRecord {
  return definedRecord({
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
    externalAgentGroupRef: input.externalAgentGroupRef,
    externalAgentTaskRef: input.externalAgentTaskRef,
    agentLaunchAcceptedAt: input.agentLaunchAcceptedAt,
    agentMemberId: input.agentMemberId,
    agentMemberIndex: input.agentMemberIndex,
    agentGroupScopeIdentity: input.agentGroupScopeIdentity,
    agentJoinPolicyHandle: input.agentJoinPolicyHandle,
    agentJoinPolicyKind: input.agentJoinPolicyKind,
    agentJoinQuorumCount: input.agentJoinQuorumCount,
    agentVerifierHandle: input.agentVerifierHandle,
    agentRequiredCheckSetHandle: input.agentRequiredCheckSetHandle,
    agentGroupRevision: input.agentGroupRevision,
    agentGroupStatus: input.agentGroupStatus,
    agentGroupObservationDigest: input.agentGroupObservationDigest,
    agentGroupObservedAt: input.agentGroupObservedAt,
    agentMemberRevision: input.agentMemberRevision,
    agentMemberObservationDigest: input.agentMemberObservationDigest,
    agentMemberStateDigest: input.agentMemberStateDigest,
    agentMemberObservedAt: input.agentMemberObservedAt,
    agentJoinReductionRevision: input.agentJoinReductionRevision,
    agentJoinReductionDigest: input.agentJoinReductionDigest,
    agentReductionPolicyHandle: input.agentReductionPolicyHandle,
    agentMaxMemberSummaryBytes: input.agentMaxMemberSummaryBytes,
    agentMaxGroupSummaryBytes: input.agentMaxGroupSummaryBytes,
    agentMaxResultRefs: input.agentMaxResultRefs,
  }) as HarnessTaskRecord;
}

function taskReservationInputFromRecord(record: HarnessTaskRecord): HarnessTaskReserveInput {
  return definedRecord({
    sessionId: record.sessionId,
    kind: record.kind,
    source: record.source,
    purpose: record.purpose,
    workflowId: record.workflowId,
    workflowHandle: record.workflowHandle,
    reservedRunId: record.reservedRunId,
    queueId: record.queueId,
    callIdentity: record.callIdentity,
    runId: record.runId,
    agentMemberId: record.agentMemberId,
    agentMemberIndex: record.agentMemberIndex,
    agentGroupScopeIdentity: record.agentGroupScopeIdentity,
    agentJoinPolicyHandle: record.agentJoinPolicyHandle,
    agentJoinPolicyKind: record.agentJoinPolicyKind,
    agentJoinQuorumCount: record.agentJoinQuorumCount,
    agentVerifierHandle: record.agentVerifierHandle,
    agentRequiredCheckSetHandle: record.agentRequiredCheckSetHandle,
    agentReductionPolicyHandle: record.agentReductionPolicyHandle,
    agentMaxMemberSummaryBytes: record.agentMaxMemberSummaryBytes,
    agentMaxGroupSummaryBytes: record.agentMaxGroupSummaryBytes,
    agentMaxResultRefs: record.agentMaxResultRefs,
  }) as HarnessTaskReserveInput;
}

export function createInMemoryTaskLedger(): HarnessTaskLedger {
  const sessions = new Map<string, SessionLedgerState>();
  const resultRefOwners = new Map<string, AgentGroupResultRefOwner>();
  const collectedAgentGroups = new Map<string, Readonly<{
    sessionId: string;
    aggregateVersion: number;
    groupObservationDigest: string;
  }>>();
  const retiredAgentGroupStarts = new Map<string, Readonly<{
    scopeIdentity: string;
    canonicalInputDigest: string;
  }>>();

  const sessionState = (sessionId: string) => {
    let state = sessions.get(sessionId);
    if (state === undefined) {
      state = {
        nextTaskNumber: 1,
        records: new Map(),
        callIdentityBindings: new Map(),
        agentGroupPages: new Map(),
        agentGroupBatchReservations: new Map(),
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
        externalAgentGroupRef: input.externalAgentGroupRef,
        externalAgentTaskRef: input.externalAgentTaskRef,
        agentLaunchAcceptedAt: input.agentLaunchAcceptedAt,
        agentMemberId: input.agentMemberId,
        agentMemberIndex: input.agentMemberIndex,
        agentGroupScopeIdentity: input.agentGroupScopeIdentity,
        agentJoinPolicyHandle: input.agentJoinPolicyHandle,
        agentJoinPolicyKind: input.agentJoinPolicyKind,
        agentJoinQuorumCount: input.agentJoinQuorumCount,
        agentVerifierHandle: input.agentVerifierHandle,
        agentRequiredCheckSetHandle: input.agentRequiredCheckSetHandle,
        agentGroupRevision: input.agentGroupRevision,
        agentGroupStatus: input.agentGroupStatus,
        agentGroupObservationDigest: input.agentGroupObservationDigest,
        agentGroupObservedAt: input.agentGroupObservedAt,
        agentMemberRevision: input.agentMemberRevision,
        agentMemberObservationDigest: input.agentMemberObservationDigest,
        agentMemberStateDigest: input.agentMemberStateDigest,
        agentMemberObservedAt: input.agentMemberObservedAt,
        agentJoinReductionRevision: input.agentJoinReductionRevision,
        agentJoinReductionDigest: input.agentJoinReductionDigest,
        agentReductionPolicyHandle: input.agentReductionPolicyHandle,
        agentMaxMemberSummaryBytes: input.agentMaxMemberSummaryBytes,
        agentMaxGroupSummaryBytes: input.agentMaxGroupSummaryBytes,
        agentMaxResultRefs: input.agentMaxResultRefs,
      }) as HarnessTaskRecord;
      state.records.set(taskId, record);
      if (input.callIdentity !== undefined) {
        state.callIdentityBindings.set(input.callIdentity, taskId);
      }
      return record;
    },
    async reserveAgentGroupTaskBatch(input) {
      const state = sessionState(input.sessionId);
      const retired = retiredAgentGroupStarts.get(`${input.sessionId}\u0000${input.callIdentity}`);
      if (retired !== undefined) {
        return Object.freeze({
          outcome: retired.scopeIdentity === input.scopeIdentity &&
              retired.canonicalInputDigest === input.canonicalInputDigest
            ? "inconsistent" as const
            : "conflict" as const,
          records: Object.freeze([]),
        });
      }
      const existing = state.agentGroupBatchReservations.get(input.callIdentity);
      if (existing !== undefined) {
        const authority = [...state.agentGroupPages.values()].find((candidate) =>
          candidate.state.scopeIdentity === input.scopeIdentity &&
          candidate.state.launchCallIdentity === input.callIdentity);
        if (authority !== undefined) {
          const liveRecords = authority.taskIdsByMemberIndex.map((taskId) => state.records.get(taskId))
            .filter((record): record is HarnessTaskRecord => record !== undefined);
          const accepted = createAgentGroupAcceptedStartReceipt({
            sessionId: input.sessionId,
            scopeIdentity: input.scopeIdentity,
            groupRef: authority.state.groupRef,
            acceptedAt: authority.state.launchAcceptedAt,
            records: liveRecords,
          });
          if (accepted === undefined || accepted.length !== existing.records.length) {
            return Object.freeze({ outcome: "inconsistent" as const, records: Object.freeze([]) });
          }
          return Object.freeze({
            outcome: existing.canonicalInputDigest === input.canonicalInputDigest
              ? "replayed" as const
              : "conflict" as const,
            records: accepted,
          });
        }
        return Object.freeze({
          outcome: existing.canonicalInputDigest === input.canonicalInputDigest
            ? "replayed" as const
            : "conflict" as const,
          records: existing.records,
        });
      }
      if (input.tasks.length < 1 || input.tasks.length > 10_000 ||
          input.callIdentity.length === 0 || input.scopeIdentity.length === 0 ||
          input.canonicalInputDigest.length === 0 ||
          new Set(input.tasks.map((task) => task.callIdentity)).size !== input.tasks.length ||
          input.tasks.some((task, memberIndex) => task.kind !== "agent" ||
            task.callIdentity === undefined || task.callIdentity.length === 0 ||
            task.agentGroupScopeIdentity !== input.scopeIdentity ||
            task.agentMemberIndex !== memberIndex || task.agentMemberId !== `member_${memberIndex + 1}` ||
            state.callIdentityBindings.has(task.callIdentity))) {
        return Object.freeze({ outcome: "inconsistent" as const, records: Object.freeze([]) });
      }
      const now = new Date().toISOString();
      const records = Object.freeze(input.tasks.map((task) => {
        const taskId = `task_${state.nextTaskNumber}` as HarnessTaskId;
        state.nextTaskNumber += 1;
        return recordForReservedTask({ sessionId: input.sessionId, ...task }, taskId, now);
      }));
      for (const record of records) {
        state.records.set(record.taskId, record);
        state.callIdentityBindings.set(record.callIdentity!, record.taskId);
      }
      state.agentGroupBatchReservations.set(input.callIdentity, Object.freeze({
        canonicalInputDigest: input.canonicalInputDigest,
        records,
      }));
      return Object.freeze({ outcome: "applied" as const, records });
    },
    async listTasks(input) {
      const requestedSessionId = input?.sessionId;
      const requestedState = requestedSessionId === undefined ? undefined : sessionState(requestedSessionId);
      const allRecords = requestedState === undefined
        ? [...sessions.values()].flatMap((state) => [...state.records.values()].map((record) =>
            overlayInMemoryAgentGroupPageAuthority(
              record,
              record.externalAgentGroupRef === undefined
                ? undefined
                : state.agentGroupPages.get(record.externalAgentGroupRef),
            )))
        : [...requestedState.records.values()].map((record) =>
            overlayInMemoryAgentGroupPageAuthority(
              record,
              record.externalAgentGroupRef === undefined
                ? undefined
                : requestedState.agentGroupPages.get(record.externalAgentGroupRef),
            ));
      if (input?.statuses === undefined) {
        return allRecords;
      }
      return allRecords.filter((record) => input.statuses?.includes(record.status) ?? false);
    },
    async getTask(input) {
      const state = sessionState(input.sessionId);
      const record = state.records.get(input.taskId);
      return record === undefined
        ? undefined
        : overlayInMemoryAgentGroupPageAuthority(
            record,
            record.externalAgentGroupRef === undefined
              ? undefined
              : state.agentGroupPages.get(record.externalAgentGroupRef),
          );
    },
    async updateTask(record) {
      const state = sessionState(record.sessionId);
      const existing = state.records.get(record.taskId);
      if (existing !== undefined) assertGenericAgentTaskMutationAllowed(existing, record);
      state.records.set(record.taskId, record);
      if (record.callIdentity !== undefined) {
        state.callIdentityBindings.set(record.callIdentity, record.taskId);
      }
    },
    async bindAgentGroupStart(input) {
      const state = sessionState(input.sessionId);
      const current = input.members.map((member) => state.records.get(member.taskId))
        .filter((record): record is HarnessTaskRecord => record !== undefined);
      if (collectedAgentGroups.has(input.groupRef)) {
        return Object.freeze({ outcome: "conflict" as const, records: Object.freeze(current) });
      }
      const conflictingRef = [...sessions.values()].some((candidateState) =>
        [...candidateState.records.values()].some((record) =>
          record.externalAgentGroupRef === input.groupRef &&
          (record.sessionId !== input.sessionId ||
            record.agentGroupScopeIdentity !== input.scopeIdentity)));
      if (conflictingRef) {
        return Object.freeze({ outcome: "conflict" as const, records: Object.freeze(current) });
      }
      let evaluated = evaluateAgentGroupStartBinding(input, current);
      if (evaluated.outcome === "applied") {
        for (const record of evaluated.records) state.records.set(record.taskId, record);
      }
      if ((evaluated.outcome === "applied" || evaluated.outcome === "replayed") &&
          input.observationMode === "paged_changes") {
        const existingAuthority = state.agentGroupPages.get(input.groupRef);
        if (existingAuthority === undefined) {
          if (evaluated.outcome === "replayed" && !evaluated.records.every((record) =>
            record.status === "queued" && record.agentGroupRevision === 0 &&
            record.agentGroupStatus === "queued" && record.agentLaunchAcceptedAt === input.acceptedAt)) {
            return Object.freeze({ outcome: "inconsistent" as const, records: Object.freeze([]) });
          }
          const pageState = createAgentGroupPageStateFromBinding(input, evaluated.records);
          if (pageState === undefined) {
            return Object.freeze({ outcome: "inconsistent" as const, records: evaluated.records });
          }
          state.agentGroupPages.set(input.groupRef, {
            state: pageState,
            taskIdsByMemberIndex: Object.freeze(evaluated.records.map((record) => record.taskId)),
            accountingByMemberIndex: evaluated.records.map(() => Object.freeze({
              status: "queued" as const,
              verifiedSucceeded: false,
              hasResultRef: false,
            })),
            requestDigests: new Map(),
            pageCalls: new Map(),
            pageCallOrder: [],
            expiredPageCallOrder: [],
            expiredPageCalls: new Set(),
            retiredPageCallDigests: new Set(),
            pageCallsIssued: 0,
            operationResults: new Map(),
            pendingOperations: new Map(),
            operationRefsByIdempotencyKey: new Map(),
          });
        } else if (existingAuthority.state.scopeIdentity !== input.scopeIdentity ||
            existingAuthority.taskIdsByMemberIndex.length !== input.members.length) {
          return Object.freeze({ outcome: "conflict" as const, records: evaluated.records });
        } else if (evaluated.outcome === "replayed") {
          const accepted = createAgentGroupAcceptedStartReceipt({
            sessionId: input.sessionId,
            scopeIdentity: input.scopeIdentity,
            groupRef: input.groupRef,
            acceptedAt: existingAuthority.state.launchAcceptedAt,
            records: current,
          });
          if (accepted === undefined) {
            return Object.freeze({ outcome: "inconsistent" as const, records: Object.freeze([]) });
          }
          evaluated = Object.freeze({ outcome: "replayed" as const, records: accepted });
        }
      }
      return evaluated;
    },
    async bindAgentGroupPendingOperation(input) {
      const state = sessionState(input.sessionId);
      const authority = state.agentGroupPages.get(input.groupRef);
      if (authority === undefined || authority.state.scopeIdentity !== input.scopeIdentity ||
          !validInMemoryAgentGroupPendingOperationBinding(input, authority.state.launchAcceptedAt)) {
        return Object.freeze({ outcome: "inconsistent" as const });
      }
      const existingRef = authority.operationRefsByIdempotencyKey.get(input.operationIdempotencyKey);
      const existingPending = authority.pendingOperations.get(input.pending.operationRef);
      const active = authority.activeJoinBeginReservation;
      const activeOwned = active !== undefined &&
        (input.operationMode === "begin"
          ? active.input.operationIdempotencyKey === input.operationIdempotencyKey
          : active.operationRef === input.pending.operationRef);
      const existingOperation = authority.operationResults.get(input.pending.operationRef);
      if (active !== undefined && input.operationMode === "begin" &&
          active.input.operationIdempotencyKey === input.operationIdempotencyKey) {
        const beginInput = agentGroupJoinBeginReservationInputFromBinding(input, input.operationIdempotencyKey);
        if (beginInput === undefined || stableHash(beginInput) !== stableHash(active.input)) {
          return Object.freeze({ outcome: "conflict" as const });
        }
      }
      const visibleHistorical = existingOperation?.visibilityAuthorized === true &&
        existingOperation.beginOperationIdempotencyKey === input.operationIdempotencyKey;
      if (active !== undefined && !activeOwned && !visibleHistorical) {
        return Object.freeze({ outcome: "conflict" as const });
      }
      if (input.operationMode === "continue") {
        if (existingPending === undefined) {
          if (activeOwned && active?.phase === "ref_bound" &&
              active.operationRef === input.pending.operationRef) {
            authority.pendingOperations.set(input.pending.operationRef, Object.freeze({
              operationIdempotencyKey: active.input.operationIdempotencyKey,
              mutationInputDigest: active.input.mutationInputDigest,
              pending: input.pending,
            }));
            authority.operationRefsByIdempotencyKey.set(active.input.operationIdempotencyKey, Object.freeze({
              operationRef: input.pending.operationRef,
              operationMode: "begin" as const,
              mutationInputDigest: active.input.mutationInputDigest,
            }));
            authority.operationRefsByIdempotencyKey.set(input.operationIdempotencyKey, Object.freeze({
              operationRef: input.pending.operationRef,
              operationMode: "continue" as const,
              mutationInputDigest: input.mutationInputDigest,
            }));
            updateInMemoryJoinBeginReservation(
              authority,
              active.input.operationIdempotencyKey,
              "pending",
              input.pending.operationRef,
            );
            return Object.freeze({ outcome: "applied" as const });
          }
          return Object.freeze({ outcome: "inconsistent" as const });
        }
        updateInMemoryJoinBeginReservation(
          authority,
          input.operationIdempotencyKey,
          "pending",
          input.pending.operationRef,
        );
        return pendingOperationObservationReplayCompatible(existingPending.pending, input.pending)
          ? Object.freeze({ outcome: "replayed" as const })
          : Object.freeze({ outcome: "conflict" as const });
      }
      if (existingRef !== undefined &&
          (existingRef.operationRef !== input.pending.operationRef ||
            existingRef.operationMode !== "begin" ||
            existingRef.mutationInputDigest !== input.mutationInputDigest)) {
        return Object.freeze({ outcome: "conflict" as const });
      }
      if (existingOperation !== undefined) {
        updateInMemoryJoinBeginReservation(
          authority,
          input.operationIdempotencyKey,
          "terminal",
          input.pending.operationRef,
          input.operationMode !== "begin"
            ? undefined
            : agentGroupJoinBeginReservationInputFromBinding(
                input,
                existingOperation.beginOperationIdempotencyKey,
                existingOperation.beginMutationInputDigest,
              ),
        );
        return existingOperation.beginOperationIdempotencyKey === input.operationIdempotencyKey &&
            existingOperation.beginMutationInputDigest === input.mutationInputDigest
          ? Object.freeze({ outcome: "replayed" as const })
          : Object.freeze({ outcome: "conflict" as const });
      }
      if (existingPending !== undefined) {
        return existingPending.operationIdempotencyKey === input.operationIdempotencyKey &&
            existingPending.mutationInputDigest === input.mutationInputDigest &&
            pendingOperationObservationReplayCompatible(existingPending.pending, input.pending)
          ? Object.freeze({ outcome: "replayed" as const })
          : Object.freeze({ outcome: "conflict" as const });
      }
      authority.pendingOperations.set(input.pending.operationRef, Object.freeze({
        operationIdempotencyKey: input.operationIdempotencyKey,
        mutationInputDigest: input.mutationInputDigest,
        pending: input.pending,
      }));
      authority.operationRefsByIdempotencyKey.set(input.operationIdempotencyKey, Object.freeze({
        operationRef: input.pending.operationRef,
        operationMode: "begin" as const,
        mutationInputDigest: input.mutationInputDigest,
      }));
      updateInMemoryJoinBeginReservation(
        authority,
        input.operationIdempotencyKey,
        "pending",
        input.pending.operationRef,
        input.operationMode !== "begin"
          ? undefined
          : agentGroupJoinBeginReservationInputFromBinding(input, input.operationIdempotencyKey),
      );
      return Object.freeze({ outcome: "applied" as const });
    },
    async projectAgentGroupObservation(input) {
      const state = sessionState(input.sessionId);
      const current = input.members.map((member) => state.records.get(member.taskId))
        .filter((record): record is HarnessTaskRecord => record !== undefined);
      const evaluated = evaluateAgentGroupObservationProjection(input, current);
      if (evaluated.outcome === "applied") {
        for (const record of evaluated.records) state.records.set(record.taskId, record);
      }
      return evaluated;
    },
    async getAgentGroupPageState(input) {
      return sessionState(input.sessionId).agentGroupPages.get(input.groupRef)?.state;
    },
    async reserveAgentGroupJoinBegin(input) {
      const state = sessionState(input.sessionId);
      const authority = state.agentGroupPages.get(input.groupRef);
      if (authority === undefined || authority.state.scopeIdentity !== input.scopeIdentity ||
          !validAgentGroupJoinBeginReservationInput(input)) {
        return Object.freeze({ outcome: "inconsistent" as const, phase: "reserved" as const });
      }
      if (collectedAgentGroups.has(input.groupRef)) {
        return Object.freeze({ outcome: "conflict" as const, phase: "reserved" as const });
      }
      const pageCall = authority.pageCalls.get(input.pageCallIdentity);
      if (pageCall === undefined ||
          authority.expiredPageCalls.has(input.pageCallIdentity) ||
          authority.retiredPageCallDigests.has(stableHash(input.pageCallIdentity)) ||
          pageCall.operationKind !== "join" ||
          pageCall.result.requestIdempotencyKey !== input.requestIdempotencyKey) {
        return Object.freeze({ outcome: "inconsistent" as const, phase: "reserved" as const });
      }
      const inferred = inMemoryJoinBeginPhase(authority, input.operationIdempotencyKey);
      const active = authority.activeJoinBeginReservation;
      if (active !== undefined &&
          active.input.operationIdempotencyKey === input.operationIdempotencyKey) {
        if (stableHash(active.input) !== stableHash(input)) {
          return joinBeginReservationResult(active, "conflict");
        }
        const effectivePhase = agentGroupJoinBeginReservationPhaseRank(active.phase) >=
            agentGroupJoinBeginReservationPhaseRank(inferred.phase)
          ? active.phase
          : inferred.phase;
        const record = Object.freeze({
          ...active,
          phase: effectivePhase,
          ...(inferred.operationRef === undefined
            ? (active.operationRef === undefined ? {} : { operationRef: active.operationRef })
            : { operationRef: inferred.operationRef }),
        });
        const visibleHistoricalTerminal = inferred.phase === "terminal" &&
          authority.operationResults.get(inferred.operationRef ?? "")?.visibilityAuthorized === true;
        if (visibleHistoricalTerminal) {
          delete authority.activeJoinBeginReservation;
        } else {
          authority.activeJoinBeginReservation = record;
        }
        return joinBeginReservationResult(record, record.phase === "ref_bound"
          ? "ref_bound"
          : record.phase === "pending"
            ? "pending"
            : record.phase === "terminal"
              ? "terminal"
              : "replayed");
      }
      const visibleHistoricalTerminal = inferred.phase === "terminal" &&
        authority.operationResults.get(inferred.operationRef ?? "")?.visibilityAuthorized === true;
      if (active !== undefined && !visibleHistoricalTerminal) {
        return joinBeginReservationResult(active, "conflict");
      }
      const record = Object.freeze({ input, ...inferred });
      if (!visibleHistoricalTerminal) {
        authority.activeJoinBeginReservation = record;
      }
      return joinBeginReservationResult(record, inferred.phase === "reserved" ? "applied" : inferred.phase);
    },
    async bindAgentGroupPageCall(input) {
      const state = sessionState(input.sessionId);
      const authority = state.agentGroupPages.get(input.groupRef);
      const invalid = authority === undefined || authority.state.scopeIdentity !== input.scopeIdentity ||
        !validAgentGroupPageCallInput(input);
      if (invalid || authority === undefined) {
        return Object.freeze({
          outcome: "inconsistent" as const,
          requestIdempotencyKey: input.requestIdempotencyKey,
          startSequence: 0,
          currentHighWater: authority?.state.aggregateVersion ?? 0,
          minimumRetainedSequence: authority?.state.minimumRetainedSequence ?? 0,
        });
      }
      const bindingDigest = stableHash(input);
      const existing = authority.pageCalls.get(input.callIdentity);
      const activePageCallIdentity = authority.activeJoinBeginReservation?.input.pageCallIdentity;
      if (existing !== undefined) {
        if (existing.canonicalInputDigest !== input.canonicalInputDigest ||
            existing.bindingDigest !== bindingDigest) {
          return Object.freeze({ ...existing.result, outcome: "conflict" as const });
        }
        if (existing.result.startSequence < authority.state.minimumRetainedSequence &&
            input.callIdentity !== activePageCallIdentity) {
          return Object.freeze({
            ...existing.result,
            outcome: "expired" as const,
            currentHighWater: authority.state.aggregateVersion,
            minimumRetainedSequence: authority.state.minimumRetainedSequence,
          });
        }
        return Object.freeze({
          ...existing.result,
          outcome: "replayed" as const,
        });
      }
      const callIdentityDigest = stableHash(input.callIdentity);
      if (authority.expiredPageCalls.has(input.callIdentity) ||
          authority.retiredPageCallDigests.has(callIdentityDigest)) {
        return Object.freeze({
          outcome: "expired" as const,
          requestIdempotencyKey: input.requestIdempotencyKey,
          startSequence: authority.state.minimumRetainedSequence,
          currentHighWater: authority.state.aggregateVersion,
          minimumRetainedSequence: authority.state.minimumRetainedSequence,
        });
      }
      if (authority.pageCallsIssued >= HARNESS_AGENT_GROUP_MAX_LIFETIME_PAGE_CALLS) {
        return Object.freeze({
          outcome: "exhausted" as const,
          requestIdempotencyKey: input.requestIdempotencyKey,
          startSequence: authority.state.aggregateVersion,
          currentHighWater: authority.state.aggregateVersion,
          minimumRetainedSequence: authority.state.minimumRetainedSequence,
        });
      }
      const currentHighWater = authority.state.aggregateVersion;
      const minimumRetainedSequence = authority.state.minimumRetainedSequence;
      const startSequence = input.requestedAfterSequence ?? currentHighWater;
      const outcome = startSequence < minimumRetainedSequence
        ? "expired" as const
        : startSequence > currentHighWater
          ? "inconsistent" as const
          : "applied" as const;
      const result = Object.freeze({
        outcome,
        requestIdempotencyKey: input.requestIdempotencyKey,
        startSequence,
        currentHighWater,
        minimumRetainedSequence,
      });
      if (outcome === "applied") {
        authority.pageCalls.set(input.callIdentity, Object.freeze({
          canonicalInputDigest: input.canonicalInputDigest,
          bindingDigest,
          operationKind: input.operationKind,
          result,
        }));
        authority.pageCallsIssued += 1;
        authority.pageCallOrder.push(input.callIdentity);
        while (authority.pageCallOrder.length > HARNESS_AGENT_GROUP_PAGE_RETENTION) {
          const expiredIndex = authority.pageCallOrder.findIndex((callIdentity) =>
            callIdentity !== activePageCallIdentity);
          if (expiredIndex < 0) break;
          const [expiredCallIdentity] = authority.pageCallOrder.splice(expiredIndex, 1);
          if (expiredCallIdentity !== undefined) {
            authority.pageCalls.delete(expiredCallIdentity);
            authority.retiredPageCallDigests.add(stableHash(expiredCallIdentity));
            authority.expiredPageCalls.add(expiredCallIdentity);
            authority.expiredPageCallOrder.push(expiredCallIdentity);
          }
        }
        while (authority.expiredPageCallOrder.length > HARNESS_AGENT_GROUP_PAGE_RETENTION) {
          const forgottenCallIdentity = authority.expiredPageCallOrder.shift();
          if (forgottenCallIdentity !== undefined) authority.expiredPageCalls.delete(forgottenCallIdentity);
        }
        if (input.requestedAfterSequence === undefined &&
            startSequence > authority.state.acknowledgedSequence) {
          authority.state = Object.freeze({
            ...authority.state,
            acknowledgedSequence: startSequence,
          });
        }
      }
      return result;
    },
    async bindAgentGroupOperationResult(input) {
      const state = sessionState(input.sessionId);
      const authority = state.agentGroupPages.get(input.groupRef);
      const result = input.result;
      const resultBody = {
        operationRef: result.operationRef,
        kind: result.kind,
        resultVersion: result.resultVersion,
        disposition: result.disposition,
        completedAt: result.completedAt,
        ...(result.summary === undefined ? {} : { summary: result.summary }),
        resultRefs: result.resultRefs,
      };
      if (authority === undefined || authority.state.scopeIdentity !== input.scopeIdentity ||
          input.operationIdempotencyKey.length === 0 || input.mutationInputDigest.length === 0 ||
          (input.operationMode !== "begin" && input.operationMode !== "continue") ||
          (input.authorizeVisibility !== undefined && typeof input.authorizeVisibility !== "boolean") ||
          (result.kind !== "join" && result.kind !== "cancel") ||
          result.operationRef.length === 0 || !Number.isSafeInteger(result.resultVersion) ||
          result.resultVersion < 0 ||
          !Number.isFinite(Date.parse(result.completedAt)) ||
          result.completedAt < authority.state.launchAcceptedAt ||
          result.resultDigest.length === 0 || result.resultDigest !== stableHash(resultBody) ||
          !Array.isArray(result.resultRefs) || new Set(result.resultRefs).size !== result.resultRefs.length ||
          result.resultRefs.some((resultRef) => resultRef.length === 0) ||
          result.resultRefs.length > authority.state.agentMaxResultRefs ||
          (result.summary !== undefined && new TextEncoder().encode(result.summary).byteLength >
            authority.state.agentMaxGroupSummaryBytes) ||
          (result.kind === "join" &&
            result.disposition !== "satisfied" && result.disposition !== "deadline" &&
            result.disposition !== "terminal") ||
          (result.kind === "cancel" &&
            result.disposition !== "cancelled" && result.disposition !== "already_terminal") ||
          (result.kind === "cancel" &&
            (result.summary !== undefined || result.resultRefs.length !== 0))) {
        return Object.freeze({ outcome: "inconsistent" as const });
      }
      const existingRef = authority.operationRefsByIdempotencyKey.get(input.operationIdempotencyKey);
      if (existingRef !== undefined &&
          (existingRef.operationRef !== result.operationRef ||
            existingRef.operationMode !== input.operationMode ||
            existingRef.mutationInputDigest !== input.mutationInputDigest)) {
        return Object.freeze({ outcome: "conflict" as const });
      }
      const existingOperation = authority.operationResults.get(result.operationRef);
      const pendingOperation = authority.pendingOperations.get(result.operationRef);
      const activeJoin = authority.activeJoinBeginReservation;
      const refBoundContinuation = input.operationMode === "continue" && result.kind === "join" &&
        activeJoin?.phase === "ref_bound" && activeJoin.operationRef === result.operationRef;
      if (result.kind === "join" && authority.activeJoinBeginReservation !== undefined) {
        const active = authority.activeJoinBeginReservation;
        if (active !== undefined && input.operationMode === "begin" &&
            active.input.operationIdempotencyKey === input.operationIdempotencyKey) {
          const beginInput = agentGroupJoinBeginReservationInputFromBinding(input, input.operationIdempotencyKey);
          if (beginInput === undefined || stableHash(beginInput) !== stableHash(active.input)) {
            return Object.freeze({ outcome: "conflict" as const });
          }
        }
        const activeOwned = active !== undefined &&
          (input.operationMode === "begin"
            ? active.input.operationIdempotencyKey === input.operationIdempotencyKey
            : active.operationRef === result.operationRef);
        const visibleHistorical = existingOperation?.visibilityAuthorized === true &&
          existingOperation.beginOperationIdempotencyKey === input.operationIdempotencyKey;
        if (!activeOwned && !visibleHistorical) {
          return Object.freeze({ outcome: "conflict" as const });
        }
      }
      if (input.operationMode === "continue" && existingOperation === undefined) {
        if (pendingOperation === undefined && !refBoundContinuation) {
          return Object.freeze({ outcome: "inconsistent" as const });
        }
        if (pendingOperation !== undefined &&
            (result.kind !== "join" || pendingOperation.pending.operationRef !== result.operationRef)) {
          return Object.freeze({ outcome: "conflict" as const });
        }
      }
      const visibilityValid = (alreadyAuthorized = false) => !input.authorizeVisibility || alreadyAuthorized ||
        result.resultVersion <= authority.state.aggregateVersion &&
        result.resultRefs.length <= authority.state.aggregate.resultRefCount &&
        (result.disposition === "satisfied"
          ? authority.state.groupStatus === "satisfied"
          : result.disposition === "terminal"
            ? authority.state.groupStatus !== "satisfied" &&
              (authority.state.groupStatus === "failed" || authority.state.groupStatus === "cancelled" ||
                authority.state.groupStatus === "deadline")
            : result.disposition === "cancelled"
              ? authority.state.groupStatus === "cancelled"
              : result.disposition === "already_terminal"
                ? authority.state.groupStatus === "satisfied" || authority.state.groupStatus === "failed" ||
                  authority.state.groupStatus === "cancelled" || authority.state.groupStatus === "deadline"
                : true) &&
        (result.kind !== "join" || result.resultRefs.every((resultRef) => {
          const owner = resultRefOwners.get(resultRef);
          return owner !== undefined && owner.sessionId === input.sessionId &&
            owner.scopeIdentity === input.scopeIdentity && owner.groupRef === input.groupRef &&
            owner.publicationSequence <= result.resultVersion;
        }));
      if (existingOperation !== undefined) {
        const replayed = existingOperation.resultDigest === result.resultDigest &&
          existingOperation.result.kind === result.kind &&
          stableHash(existingOperation.result) === stableHash(result);
        if (!replayed || input.operationMode === "begin" &&
            (existingOperation.beginOperationIdempotencyKey !== input.operationIdempotencyKey ||
              existingOperation.beginMutationInputDigest !== input.mutationInputDigest)) {
          return Object.freeze({ outcome: "conflict" as const });
        }
        if (!visibilityValid(existingOperation.visibilityAuthorized)) {
          return Object.freeze({ outcome: "inconsistent" as const });
        }
        if (existingRef === undefined) {
          authority.operationRefsByIdempotencyKey.set(input.operationIdempotencyKey, Object.freeze({
            operationRef: result.operationRef,
            operationMode: input.operationMode,
            mutationInputDigest: input.mutationInputDigest,
          }));
        }
        if (input.authorizeVisibility && !existingOperation.visibilityAuthorized) {
          authority.operationResults.set(result.operationRef, Object.freeze({
            ...existingOperation,
            visibilityAuthorized: true,
          }));
          if (result.kind === "join") {
            updateInMemoryJoinBeginReservation(
              authority,
              input.operationIdempotencyKey,
              "terminal",
              result.operationRef,
            );
          }
          return Object.freeze({ outcome: "applied" as const });
        }
        return Object.freeze({ outcome: "replayed" as const });
      }
      if (!visibilityValid()) return Object.freeze({ outcome: "inconsistent" as const });
      const storedInput = pendingOperation === undefined
        ? refBoundContinuation
          ? Object.freeze({
              ...input,
              sessionId: activeJoin!.input.sessionId,
              scopeIdentity: activeJoin!.input.scopeIdentity,
              groupRef: activeJoin!.input.groupRef,
              operationIdempotencyKey: activeJoin!.input.operationIdempotencyKey,
              mutationInputDigest: activeJoin!.input.mutationInputDigest,
              operationMode: "begin" as const,
              pageCallIdentity: activeJoin!.input.pageCallIdentity,
              requestIdempotencyKey: activeJoin!.input.requestIdempotencyKey,
              authorizeVisibility: false,
            })
          : input
        : Object.freeze({
            ...input,
            operationIdempotencyKey: pendingOperation.operationIdempotencyKey,
            mutationInputDigest: pendingOperation.mutationInputDigest,
            operationMode: "begin" as const,
            authorizeVisibility: false,
          });
      authority.operationResults.set(result.operationRef, Object.freeze({
        beginOperationIdempotencyKey: storedInput.operationIdempotencyKey,
        beginMutationInputDigest: storedInput.mutationInputDigest,
        resultDigest: result.resultDigest,
        result,
        visibilityAuthorized: input.authorizeVisibility === true,
      }));
      authority.operationRefsByIdempotencyKey.set(input.operationIdempotencyKey, Object.freeze({
        operationRef: result.operationRef,
        operationMode: input.operationMode,
        mutationInputDigest: input.mutationInputDigest,
      }));
      if (result.kind === "join") {
        const reservationOperationIdempotencyKey = input.operationMode === "begin"
          ? input.operationIdempotencyKey
          : pendingOperation?.operationIdempotencyKey ??
            (refBoundContinuation ? activeJoin!.input.operationIdempotencyKey : input.operationIdempotencyKey);
        updateInMemoryJoinBeginReservation(
          authority,
          reservationOperationIdempotencyKey,
          "terminal",
          result.operationRef,
          input.operationMode !== "begin"
            ? undefined
            : agentGroupJoinBeginReservationInputFromBinding(
                input,
                storedInput.operationIdempotencyKey,
                storedInput.mutationInputDigest,
              ),
        );
      }
      return Object.freeze({ outcome: "applied" as const });
    },
    async projectAgentGroupPage(input) {
      const state = sessionState(input.sessionId);
      const authority = state.agentGroupPages.get(input.groupRef);
      if (authority === undefined || authority.state.scopeIdentity !== input.scopeIdentity ||
          input.requestIdempotencyKey.length === 0 || input.pageDigest.length === 0 ||
          input.groupObservationDigest.length === 0 || input.pageCallIdentity.length === 0 ||
          !Number.isFinite(Date.parse(input.groupObservedAt))) {
        return Object.freeze({ outcome: "inconsistent" as const, records: Object.freeze([]) });
      }
      const pageCall = authority.pageCalls.get(input.pageCallIdentity);
      if (pageCall === undefined ||
          pageCall.result.requestIdempotencyKey !== input.requestIdempotencyKey ||
          pageCall.result.startSequence !== input.afterSequence) {
        return Object.freeze({ outcome: "inconsistent" as const, records: Object.freeze([]) });
      }
      const projectionDigest = stableHash(input);
      const replayDigest = authority.requestDigests.get(input.requestIdempotencyKey);
      if (replayDigest !== undefined) {
        return Object.freeze({
          outcome: replayDigest === projectionDigest ? "replayed" as const : "conflict" as const,
          records: Object.freeze([]),
        });
      }
      if (input.afterSequence < authority.state.aggregateVersion) {
        return Object.freeze({ outcome: "stale" as const, records: Object.freeze([]) });
      }
      if (input.afterSequence !== authority.state.aggregateVersion ||
          input.throughSequence !== input.afterSequence + input.changes.length ||
          input.aggregateVersion !== input.throughSequence ||
          !Number.isSafeInteger(input.aggregateVersion) || input.aggregateVersion < 0) {
        return Object.freeze({ outcome: "inconsistent" as const, records: Object.freeze([]) });
      }
      if (!allowedAgentGroupTransition(authority.state.groupStatus, input.groupStatus) ||
          input.groupObservedAt < authority.state.groupObservedAt) {
        return Object.freeze({ outcome: "invalid_transition" as const, records: Object.freeze([]) });
      }

      let projectedAggregate = authority.state.aggregate;
      let projectedGroupStatus = authority.state.groupStatus;
      let projectedGroupObservedAt = authority.state.groupObservedAt;
      let sawV2Control = false;
      let sawV2Member = false;
      let sawV2MemberProgress = false;
      const accountingUpdates = new Map<number, AgentGroupMemberAccounting>();
      const updatedByTaskId = new Map<HarnessTaskId, HarnessTaskRecord>();
      const pendingResultRefOwners = new Map<string, AgentGroupResultRefOwner>();
      for (const [offset, change] of input.changes.entries()) {
        if (change.sequence !== input.afterSequence + offset + 1) {
          return Object.freeze({ outcome: "inconsistent" as const, records: Object.freeze([]) });
        }
        if (change.kind === "group_control") {
          sawV2Control = true;
          if (change.controlDigest.length === 0 ||
              change.controlDigest !== stableHash({
                sequence: change.sequence,
                kind: change.kind,
                status: change.groupStatus,
                observedAt: change.groupObservedAt,
              }) ||
              !Number.isFinite(Date.parse(change.groupObservedAt)) ||
              change.groupObservedAt < projectedGroupObservedAt ||
              !allowedAgentGroupTransition(projectedGroupStatus, change.groupStatus)) {
            return Object.freeze({ outcome: "invalid_transition" as const, records: Object.freeze([]) });
          }
          projectedGroupStatus = change.groupStatus;
          projectedGroupObservedAt = change.groupObservedAt;
          continue;
        }
        if (change.kind === "member") {
          sawV2Member = true;
          sawV2MemberProgress ||= change.memberStatus !== "queued";
        }
        if (!Number.isSafeInteger(change.memberIndex) || change.memberIndex < 0 ||
            change.memberIndex >= authority.taskIdsByMemberIndex.length ||
            change.memberId !== `member_${change.memberIndex + 1}` ||
            agentTaskStatus(change.memberStatus) !== change.status ||
            change.verifiedSucceeded && change.memberStatus !== "succeeded" ||
            change.hasResultRef !== (change.externalAgentResultRef !== undefined) ||
            (change.externalAgentResultRef !== undefined &&
              change.status !== "completed" && change.status !== "failed" &&
              change.status !== "cancelled")) {
          return Object.freeze({ outcome: "inconsistent" as const, records: Object.freeze([]) });
        }
        const taskId = authority.taskIdsByMemberIndex[change.memberIndex]!;
        const current = updatedByTaskId.get(taskId) ?? state.records.get(taskId);
        if (current === undefined || current.externalAgentTaskRef !== change.taskRef ||
            current.agentMemberId !== change.memberId || current.agentMemberIndex !== change.memberIndex ||
            !Number.isSafeInteger(change.memberRevision) ||
            change.memberRevision <= (current.agentMemberRevision ?? 0) ||
            !Number.isFinite(Date.parse(change.memberObservedAt)) ||
            change.memberObservedAt < (current.agentMemberObservedAt ?? current.createdAt) ||
            !allowedAgentMemberTransition(
              current.status,
              change.status,
              current.agentMemberStateDigest,
              change.memberStateDigest,
            )) {
          return Object.freeze({ outcome: "invalid_transition" as const, records: Object.freeze([]) });
        }
        const terminal = change.status === "completed" || change.status === "failed" ||
          change.status === "cancelled";
        const previousResultRef = current.externalAgentResultRef;
        if (previousResultRef !== undefined && previousResultRef !== change.externalAgentResultRef) {
          return Object.freeze({ outcome: "invalid_transition" as const, records: Object.freeze([]) });
        }
        if (change.externalAgentResultRef !== undefined) {
          const existingOwner = pendingResultRefOwners.get(change.externalAgentResultRef) ??
            resultRefOwners.get(change.externalAgentResultRef);
          if (previousResultRef === change.externalAgentResultRef) {
            if (existingOwner === undefined || existingOwner.sessionId !== input.sessionId ||
                existingOwner.scopeIdentity !== input.scopeIdentity ||
                existingOwner.groupRef !== input.groupRef ||
                existingOwner.memberId !== change.memberId ||
                existingOwner.memberIndex !== change.memberIndex) {
              return Object.freeze({ outcome: "conflict" as const, records: Object.freeze([]) });
            }
            pendingResultRefOwners.set(change.externalAgentResultRef, existingOwner);
          } else {
            const ownerBody = {
              sessionId: input.sessionId,
              scopeIdentity: input.scopeIdentity,
              groupRef: input.groupRef,
              memberId: change.memberId,
              memberIndex: change.memberIndex,
              memberRevision: change.memberRevision,
              publicationSequence: change.sequence,
              publicationDigest: stableHash({
                pageDigest: input.pageDigest,
                sequence: change.sequence,
                memberObservationDigest: change.memberObservationDigest,
                resultRef: change.externalAgentResultRef,
              }),
              resultRef: change.externalAgentResultRef,
            };
            const owner = Object.freeze({ ...ownerBody, ownerDigest: stableHash(ownerBody) });
            if (existingOwner !== undefined && existingOwner.ownerDigest !== owner.ownerDigest) {
              return Object.freeze({ outcome: "conflict" as const, records: Object.freeze([]) });
            }
            pendingResultRefOwners.set(change.externalAgentResultRef, owner);
          }
          if (existingOwner !== undefined && existingOwner.resultRef !== change.externalAgentResultRef) {
            return Object.freeze({ outcome: "conflict" as const, records: Object.freeze([]) });
          }
        }
        const updated = definedRecord({
          ...current,
          status: change.status,
          updatedAt: change.memberObservedAt,
          outputSummary: change.outputSummary,
          externalAgentResultRef: change.externalAgentResultRef,
          error: change.error,
          terminalCauseCode: terminal ? change.terminalCauseCode : undefined,
          terminalMessage: terminal ? change.terminalMessage : undefined,
          terminalDiagnostic: terminal ? change.terminalDiagnostic : undefined,
          agentGroupRevision: input.aggregateVersion,
          agentGroupStatus: input.groupStatus,
          agentGroupObservationDigest: input.groupObservationDigest,
          agentGroupObservedAt: input.groupObservedAt,
          agentMemberRevision: change.memberRevision,
          agentMemberObservationDigest: change.memberObservationDigest,
          agentMemberStateDigest: change.memberStateDigest,
          agentMemberObservedAt: change.memberObservedAt,
          agentJoinReductionRevision: current.agentJoinReductionRevision,
          agentJoinReductionDigest: current.agentJoinReductionDigest,
        }) as HarnessTaskRecord;
        updatedByTaskId.set(taskId, updated);
        const nextAccounting = Object.freeze({
          status: change.memberStatus,
          verifiedSucceeded: change.verifiedSucceeded,
          hasResultRef: change.hasResultRef,
        });
        const previousAccounting = accountingUpdates.get(change.memberIndex) ??
          authority.accountingByMemberIndex[change.memberIndex]!;
        projectedAggregate = applyAgentGroupMemberAccountingDelta(
          projectedAggregate,
          previousAccounting,
          nextAccounting,
        );
        accountingUpdates.set(change.memberIndex, nextAccounting);
      }
      if (stableHash(projectedAggregate) !== stableHash(input.aggregate)) {
        return Object.freeze({ outcome: "inconsistent" as const, records: Object.freeze([]) });
      }
      const memberStatusChangeRequiresControl = sawV2Member &&
        input.groupStatus !== authority.state.groupStatus &&
        !(sawV2MemberProgress && authority.state.groupStatus === "queued" &&
          input.groupStatus === "running");
      if ((sawV2Control || memberStatusChangeRequiresControl) &&
          (projectedGroupStatus !== input.groupStatus ||
          projectedGroupObservedAt > input.groupObservedAt)) {
        return Object.freeze({ outcome: "conflict" as const, records: Object.freeze([]) });
      }
      if (input.changes.length === 0 &&
          (input.groupStatus !== authority.state.groupStatus ||
            stableHash(input.aggregate) !== stableHash(authority.state.aggregate))) {
        return Object.freeze({ outcome: "conflict" as const, records: Object.freeze([]) });
      }
      for (const record of updatedByTaskId.values()) state.records.set(record.taskId, record);
      for (const [resultRef, owner] of pendingResultRefOwners) resultRefOwners.set(resultRef, owner);
      for (const [memberIndex, accounting] of accountingUpdates) {
        authority.accountingByMemberIndex[memberIndex] = accounting;
      }
      authority.state = Object.freeze({
        ...authority.state,
        aggregateVersion: input.aggregateVersion,
        minimumRetainedSequence: Math.max(
          authority.state.minimumRetainedSequence,
          input.aggregateVersion - HARNESS_AGENT_GROUP_PAGE_RETENTION,
        ),
        groupStatus: input.groupStatus,
        aggregate: input.aggregate,
        groupObservationDigest: input.groupObservationDigest,
        groupObservedAt: input.groupObservedAt,
      });
      authority.requestDigests.set(input.requestIdempotencyKey, projectionDigest);
      // Bounded replay memory. Cursors older than this window must be expired by
      // the adapter before they can reach projection.
      if (authority.requestDigests.size > HARNESS_AGENT_GROUP_PAGE_RETENTION) {
        const oldest = authority.requestDigests.keys().next().value as string | undefined;
        if (oldest !== undefined) authority.requestDigests.delete(oldest);
      }
      return Object.freeze({
        outcome: "applied" as const,
        records: Object.freeze([...updatedByTaskId.values()]),
      });
    },
    async collectAgentGroupGarbage(input) {
      const collectionKey = input.groupRef;
      const state = sessionState(input.sessionId);
      const authority = state.agentGroupPages.get(input.groupRef);
      if (authority === undefined) {
        const collected = collectedAgentGroups.get(collectionKey);
        return Object.freeze({
          outcome: collected === undefined
            ? "inconsistent" as const
            : collected.sessionId === input.sessionId &&
                collected.aggregateVersion === input.expectedAggregateVersion &&
                collected.groupObservationDigest === input.expectedGroupObservationDigest
              ? "replayed" as const
          : "conflict" as const,
        });
      }
      if (authority.activeJoinBeginReservation !== undefined) {
        return Object.freeze({ outcome: "conflict" as const });
      }
      if (authority.state.aggregateVersion !== input.expectedAggregateVersion ||
          authority.state.groupObservationDigest !== input.expectedGroupObservationDigest) {
        return Object.freeze({ outcome: "conflict" as const });
      }
      if (authority.state.groupStatus !== "satisfied" && authority.state.groupStatus !== "failed" &&
          authority.state.groupStatus !== "cancelled") {
        return Object.freeze({ outcome: "not_terminal" as const });
      }
      if (authority.state.launchCallIdentity === undefined) {
        // Pre-GC authorities did not persist the start identity. Refuse to
        // collect them because no compact receipt could permanently fence an
        // exact old start from reaching the launcher again.
        return Object.freeze({ outcome: "inconsistent" as const });
      }
      for (const [resultRef, owner] of resultRefOwners) {
        if (owner.sessionId === input.sessionId && owner.groupRef === input.groupRef) {
          resultRefOwners.delete(resultRef);
        }
      }
      if (authority.state.launchCallIdentity !== undefined) {
        const reservation = state.agentGroupBatchReservations.get(authority.state.launchCallIdentity);
        if (reservation !== undefined) {
          retiredAgentGroupStarts.set(
            `${input.sessionId}\u0000${authority.state.launchCallIdentity}`,
            Object.freeze({
              scopeIdentity: authority.state.scopeIdentity,
              canonicalInputDigest: reservation.canonicalInputDigest,
            }),
          );
        }
        state.agentGroupBatchReservations.delete(authority.state.launchCallIdentity);
      }
      for (const taskId of authority.taskIdsByMemberIndex) {
        const record = state.records.get(taskId);
        if (record?.callIdentity !== undefined) state.callIdentityBindings.delete(record.callIdentity);
        state.records.delete(taskId);
      }
      state.agentGroupPages.delete(input.groupRef);
      collectedAgentGroups.set(collectionKey, Object.freeze({
        sessionId: input.sessionId,
        aggregateVersion: input.expectedAggregateVersion,
        groupObservationDigest: input.expectedGroupObservationDigest,
      }));
      return Object.freeze({ outcome: "collected" as const });
    },
    async markTerminal(input, terminal) {
      const state = sessionState(input.sessionId);
      const existing = state.records.get(input.taskId);
      if (existing === undefined || isTerminal(existing.status)) {
        return;
      }
      assertGenericAgentTaskMutationAllowed(existing);
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
      if (isTerminal(existing.status)) return existing;
      assertGenericAgentTaskMutationAllowed(existing);
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
      assertGenericAgentTaskMutationAllowed(existing);
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
