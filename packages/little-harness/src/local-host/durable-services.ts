import { lstat, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { HarnessInputError } from "../errors.js";
import { HARNESS_FAILURE_CAUSE_CODES } from "../workflows.js";
import {
  agentTaskStatus,
  applyAgentGroupMemberAccountingDelta,
  assertGenericAgentTaskMutationAllowed,
  createAgentGroupAcceptedStartReceipt,
  createAgentGroupPageStateFromBinding,
  evaluateAgentGroupStartBinding,
  evaluateAgentGroupObservationProjection,
  HARNESS_AGENT_GROUP_MAX_LIFETIME_PAGE_CALLS,
  HARNESS_AGENT_GROUP_PAGE_RETENTION,
} from "../tasks/ledger.js";
import type { HarnessOrchestrationServices } from "../types.js";
import { stableHash } from "../utils/canonical-hash.js";
import { createTurnBudgetLedger } from "./turn-budget-ledger.js";
import { recordKey, type DurableJsonStore } from "./durable-store.js";
import {
  agentGroupJoinBeginOperationIdentity,
  agentGroupJoinBeginReservationInputFromBinding,
  agentGroupJoinBeginReservationPhaseRank,
  joinBeginReservationResult,
  validAgentGroupPageCallInput,
  validAgentGroupJoinBeginReservationInput,
  type AgentGroupJoinBeginOperationIdentity,
} from "../tasks/agent-group-join-begin.js";
import type {
  HarnessAgentGroupStartBinding,
  HarnessAgentGroupPendingOperationBinding,
  HarnessAgentGroupOperationResultBinding,
  HarnessAgentGroupPageCallBinding,
  HarnessAgentGroupPageProjection,
  HarnessAgentGroupPageProjectionResult,
  HarnessAgentGroupPageState,
  HarnessAgentGroupJoinBeginReservation,
  HarnessAgentGroupJoinBeginReservationResult,
  HarnessAsyncLaunchLedger,
  HarnessAsyncTaskQueueLedger,
  HarnessAsyncTaskQueueRecord,
  HarnessContinuationLedger,
  HarnessContinuationRecord,
  HarnessContinuationWaitOutcome,
  HarnessContinuationWaitRecord,
  HarnessPreparedWorkflowRecord,
  HarnessPreparedWorkflowRunRecord,
  HarnessPreparedWorkflowRunStore,
  HarnessPreparedWorkflowStore,
  HarnessResultGrant,
  HarnessResultGrantStore,
  HarnessResultStore,
  HarnessResumeQueue,
  HarnessResumeQueueRecord,
  HarnessStoredResult,
  HarnessTaskLedger,
  HarnessWakeupLedger,
  HarnessWakeupRecord,
  HarnessWorkflowLaunchLedger,
  HarnessWorkflowQueueLedger,
  HarnessWorkflowQueueRecord,
} from "../tasks/ledger.js";
import type { HarnessAgentGroupOperationResult, HarnessAgentMemberStatus } from "../agents/types.js";
import type { HarnessTaskId, HarnessTaskRecord, HarnessTaskReserveInput, HarnessTaskStatus } from "../tasks/types.js";

export type LocalHarnessDurableServicesOptions = {
  readonly rootDir: string;
  readonly faultInjection?: LocalHarnessDurableServicesFaultInjection;
};

export type LocalHarnessDurableServicesFaultInjection = {
  readonly onPoint?: (point: LocalHarnessDurableServicesFaultPoint) => Promise<void> | void;
};

export type LocalHarnessDurableServicesFaultPoint =
  | "task-reserve-after-record-write"
  | "agent-group-batch-after-journal-write"
  | "agent-group-batch-during-record-writes"
  | "agent-group-batch-after-record-writes"
  | "agent-group-start-binding-after-authority-commit"
  | "agent-group-start-binding-during-record-writes"
  | "agent-group-projection-after-authority-commit"
  | "agent-group-pending-after-alias-before-write"
  | "agent-group-pending-after-write"
  | "agent-group-result-after-alias-before-write"
  | "agent-group-page-projection-before-stage"
  | "agent-group-page-projection-during-stage"
  | "agent-group-page-projection-after-stage"
  | "agent-group-page-projection-after-result-ref-intents"
  | "agent-group-page-projection-after-authority-commit"
  | "agent-group-gc-after-prepare"
  | "agent-group-gc-after-deleting-fence"
  | "agent-group-gc-during-delete"
  | "agent-group-gc-after-delete"
  | "agent-group-gc-during-owner-cleanup"
  | "result-allocate-after-session-record-write"
  | "result-allocate-after-record-write"
  | "result-commit-after-value-write"
  | "result-commit-after-session-record-write"
  | "workflow-launch-after-input-commit"
  | "workflow-launch-after-task-reserve-before-journal"
  | "workflow-launch-after-task-reserve"
  | "workflow-launch-after-queue-enqueue"
  | "async-launch-after-input-commit"
  | "async-launch-after-task-reserve-before-journal"
  | "async-launch-after-task-reserve"
  | "async-launch-after-queue-enqueue";

const LOCK_TIMEOUT_MS = 10_000;
const LOCK_STALE_MS = 30_000;
const LOCK_HEARTBEAT_MS = 5_000;

type FileLockOwner = {
  readonly pid: number;
  readonly token: string;
  readonly acquiredAt: string;
  readonly updatedAt: string;
};

type DurableAgentGroupProjectionAuthority = Readonly<{
  schemaVersion: "little-harness.agent-group-projection.v1";
  sessionId: string;
  scopeIdentity: string;
  memberCount: number;
  records: readonly HarnessTaskRecord[];
}>;

type DurableAgentGroupPageAuthority = Readonly<{
  schemaVersion: "little-harness.agent-group-page-authority.v1";
  state: HarnessAgentGroupPageState;
  startEnvelopeDigest: string;
  mirrorThroughSequence: number;
  /** Old authorities omit this additive bounded replay index. */
  pageCallOrder?: readonly string[];
  /** Bounded tombstones prevent an evicted stable call from silently reopening. */
  expiredPageCallOrder?: readonly string[];
  /** Crash-recoverable bounded cleanup work, always a subset of tombstones. */
  pendingPageCallCleanup?: readonly string[];
  pageCallsIssued?: number;
  lastCommit?: DurableAgentGroupPageCommitIdentity;
  /** O(1) fence for the one join begin currently allowed to touch this group. */
  activeJoinBeginReservation?: DurableAgentGroupJoinBeginReservation;
}>;

type DurableAgentGroupJoinBeginReservation = Readonly<{
  schemaVersion: "little-harness.agent-group-join-begin-reservation.v1";
  input: HarnessAgentGroupJoinBeginReservation;
  phase: "reserved" | "ref_bound" | "pending" | "terminal";
  operationRef?: string;
}>;

type DurableAgentGroupTaskBatchJournal = Readonly<{
  schemaVersion: "little-harness.agent-group-task-batch.v1";
  sessionId: string;
  callIdentity: string;
  scopeIdentity: string;
  canonicalInputDigest: string;
  firstTaskNumber: number;
  lastTaskNumber: number;
  /** Exact prepared-record digest for crash/materialization validation. */
  recordsDigest: string;
  /** Immutable reservation projection digest valid after task state mutates. */
  reservationDigest: string;
  records?: readonly HarnessTaskRecord[];
  state: "prepared" | "committed";
}>;

type DurableAgentGroupPageCall = Readonly<{
  schemaVersion: "little-harness.agent-group-page-call.v1";
  input: HarnessAgentGroupPageCallBinding;
  bindingDigest: string;
  result: Readonly<{
    outcome: "applied";
    requestIdempotencyKey: string;
    startSequence: number;
    currentHighWater: number;
    minimumRetainedSequence: number;
  }>;
}>;

type DurableAgentGroupRetiredPageCall = Readonly<{
  schemaVersion: "little-harness.agent-group-retired-page-call.v1";
  sessionId: string;
  scopeIdentity: string;
  groupRef: string;
  callIdentityDigest: string;
}>;

type DurableAgentGroupOperationResult = Readonly<{
  schemaVersion: "little-harness.agent-group-operation-result.v1";
  input: HarnessAgentGroupOperationResultBinding;
  inputDigest: string;
}>;

type DurableAgentGroupPendingOperation = Readonly<{
  schemaVersion: "little-harness.agent-group-pending-operation.v1";
  input: HarnessAgentGroupPendingOperationBinding;
  inputDigest: string;
}>;

type DurableAgentGroupOperationIdempotency = Readonly<{
  schemaVersion: "little-harness.agent-group-operation-idempotency.v1";
  sessionId: string;
  scopeIdentity: string;
  groupRef: string;
  operationIdempotencyKey: string;
  operationRef: string;
  operationMode: "begin" | "continue";
  mutationInputDigest: string;
}>;

type DurableAgentGroupOperationVisibility = Readonly<{
  schemaVersion: "little-harness.agent-group-operation-visibility.v1";
  sessionId: string;
  scopeIdentity: string;
  groupRef: string;
  operationRef: string;
  resultDigest: string;
  resultVersion: number;
}>;

type DurableAgentGroupResultRefOwner = Readonly<{
  schemaVersion: "little-harness.agent-group-result-ref-owner.v1";
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

type DurableAgentGroupResultRefIntent = Readonly<{
  schemaVersion: "little-harness.agent-group-result-ref-intent.v1";
  owner: DurableAgentGroupResultRefOwner;
  requestIdempotencyKey: string;
  projectionDigest: string;
  afterSequence: number;
  throughSequence: number;
  stageDigest: string;
  commitDigest: string;
}>;

type DurableAgentGroupPageCommitIdentity = Readonly<{
  requestIdempotencyKey: string;
  projectionDigest: string;
  afterSequence: number;
  throughSequence: number;
  stageDigest: string;
  commitDigest: string;
}>;

type DurableAgentGroupPageStageIntent = Readonly<{
  schemaVersion: "little-harness.agent-group-page-stage-intent.v1";
  sessionId: string;
  scopeIdentity: string;
  groupRef: string;
  requestIdempotencyKey: string;
  pageCallIdentity: string;
  projectionDigest: string;
  afterSequence: number;
  throughSequence: number;
  sequenceDigests: readonly string[];
  stageDigest: string;
}>;

type DurableAgentGroupPageStageComplete = Readonly<{
  schemaVersion: "little-harness.agent-group-page-stage-complete.v1";
  sessionId: string;
  scopeIdentity: string;
  groupRef: string;
  requestIdempotencyKey: string;
  stageDigest: string;
}>;

type DurableAgentGroupPageMember = Readonly<{
  schemaVersion: "little-harness.agent-group-page-member.v1";
  sessionId: string;
  scopeIdentity: string;
  groupRef: string;
  memberIndex: number;
  lastSequence: number;
  resultRefPublicationSequence?: number;
  resultRefPublicationMemberRevision?: number;
  resultRefPublicationDigest?: string;
  record: HarnessTaskRecord;
  accounting: Readonly<{
    status: HarnessAgentMemberStatus;
    verifiedSucceeded: boolean;
    hasResultRef: boolean;
  }>;
}>;

type DurableAgentGroupPageSequence = Readonly<{
  schemaVersion: "little-harness.agent-group-page-sequence.v1";
  sessionId: string;
  scopeIdentity: string;
  groupRef: string;
  sequence: number;
  requestIdempotencyKey: string;
  pageDigest: string;
  /** Omitted only by legacy v1 durable records. */
  kind?: "member";
  member: DurableAgentGroupPageMember;
}> | Readonly<{
  schemaVersion: "little-harness.agent-group-page-sequence.v1";
  sessionId: string;
  scopeIdentity: string;
  groupRef: string;
  sequence: number;
  requestIdempotencyKey: string;
  pageDigest: string;
  kind: "group_control";
  groupStatus: NonNullable<HarnessTaskRecord["agentGroupStatus"]>;
  groupObservedAt: string;
  controlDigest: string;
}>;

type DurableAgentGroupPageReceipt = Readonly<{
  schemaVersion: "little-harness.agent-group-page-receipt.v1";
  sessionId: string;
  scopeIdentity: string;
  groupRef: string;
  requestIdempotencyKey: string;
  projectionDigest: string;
  afterSequence: number;
  throughSequence: number;
}>;

type DurableAgentGroupPageCommitMarker = Readonly<{
  schemaVersion: "little-harness.agent-group-page-commit.v1";
  sessionId: string;
  scopeIdentity: string;
  groupRef: string;
  identity: DurableAgentGroupPageCommitIdentity;
}>;

type DurableAgentGroupPageRefBinding = Readonly<{
  schemaVersion: "little-harness.agent-group-page-ref.v1";
  sessionId: string;
  scopeIdentity: string;
  groupRef: string;
}>;

type DurableAgentGroupGarbageCollection = Readonly<{
  schemaVersion: "little-harness.agent-group-gc.v1";
  state: "prepared" | "deleting" | "committed_cleanup" | "committed";
  sessionId: string;
  scopeIdentity: string;
  groupRef: string;
  aggregateVersion: number;
  groupObservationDigest: string;
  memberCount: number;
  membersDigest: string;
  /** Independently binds the exact first-publication owner set derived from member authority. */
  resultRefPublicationCount: number;
  resultRefPublicationsDigest: string;
  resultRefOwnersDigest: string;
  /** Present until owner cleanup is committed; final receipts are compact. */
  resultRefOwners?: readonly DurableAgentGroupResultRefOwner[];
  /** Present while group-local deletion is prepared/in progress. */
  members?: readonly Readonly<{
    taskId: HarnessTaskId;
    callIdentity: string;
    memberId: string;
    memberIndex: number;
  }>[];
  launchCallIdentity: string;
  launchCanonicalInputDigest: string;
}>;

type DurableAgentGroupRetiredStart = Readonly<{
  schemaVersion: "little-harness.agent-group-retired-start.v1";
  sessionId: string;
  scopeIdentity: string;
  groupRef: string;
  callIdentity: string;
  canonicalInputDigest: string;
}>;

export function createLocalHarnessDurableServices(
  options: LocalHarnessDurableServicesOptions,
): HarnessOrchestrationServices {
  return createDurableOrchestrationServices({
    rootDir: options.rootDir,
    store: createFileDurableStore(options.rootDir),
    ...(options.faultInjection === undefined ? {} : { faultInjection: options.faultInjection }),
  });
}

export type DurableOrchestrationServicesOptions = {
  /** Opaque path-key prefix for the ledger collections (a real directory for the file store). */
  readonly rootDir: string;
  readonly store: DurableJsonStore;
  readonly faultInjection?: LocalHarnessDurableServicesFaultInjection;
};

/** Shared ledger wiring over a pluggable store; the file and in-memory hosts both delegate here. */
export function createDurableOrchestrationServices(
  options: DurableOrchestrationServicesOptions,
): HarnessOrchestrationServices {
  const { rootDir, store } = options;
  const tasks = createTaskLedger(store, rootDir, options.faultInjection);
  const results = createResultStore(store, rootDir, options.faultInjection);
  const workflowQueue = createWorkflowQueueLedger(store, rootDir);
  const asyncTaskQueue = createAsyncTaskQueueLedger(store, rootDir);

  return {
    turnBudgets: createTurnBudgetLedger(store, rootDir),
    tasks,
    continuations: createContinuationLedger(store, rootDir),
    wakeups: createWakeupLedger(store, rootDir),
    asyncTaskQueue,
    asyncLaunches: createAsyncLaunchLedger({
      store,
      rootDir,
      tasks,
      results,
      asyncTaskQueue,
      ...(options.faultInjection === undefined ? {} : { faultInjection: options.faultInjection }),
    }),
    workflowQueue,
    workflowLaunches: createWorkflowLaunchLedger({
      store,
      rootDir,
      tasks,
      results,
      workflowQueue,
      ...(options.faultInjection === undefined ? {} : { faultInjection: options.faultInjection }),
    }),
    preparedWorkflows: createPreparedWorkflowStore(store, rootDir),
    preparedWorkflowRuns: createPreparedWorkflowRunStore(store, rootDir),
    resumeQueue: createResumeQueue(store, rootDir),
    results,
    resultGrants: createResultGrantStore(store, rootDir),
  };
}

/** File-backed store: atomic JSON writes plus cross-process lock directories under rootDir/.locks. */
export function createFileDurableStore(rootDir: string): DurableJsonStore {
  return {
    async readJson<T>(path: string) {
      await assertFileStorePathSafety(rootDir, path);
      return await readJson<T>(path);
    },
    async writeJson(path, value) {
      await assertFileStorePathSafety(rootDir, path);
      await writeJson(path, value);
    },
    async writeJsonDurable(path, value) {
      await assertFileStorePathSafety(rootDir, path);
      await writeBudgetJsonDurably(path, value);
    },
    async remove(path) {
      await assertFileStorePathSafety(rootDir, path);
      await rm(path, { force: true, recursive: true });
    },
    async listDir(dir) {
      await assertFileStorePathSafety(rootDir, dir);
      try {
        return await readdir(dir);
      } catch (error) {
        if (isNodeError(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
          return [];
        }
        throw error;
      }
    },
    async withLock(scope, fn) {
      await assertFileStorePathSafety(rootDir, rootDir);
      return withFileLock(rootDir, scope, fn);
    },
  };
}

function createTaskLedger(
  store: DurableJsonStore,
  rootDir: string,
  faultInjection: LocalHarnessDurableServicesFaultInjection | undefined,
): HarnessTaskLedger {
  return {
    async reserveTask(input) {
      return store.withLock(["task-ledger", input.sessionId], async () => {
        if (input.callIdentity !== undefined) {
          const existingTaskId = await this.taskIdForCallIdentity({
            sessionId: input.sessionId,
            callIdentity: input.callIdentity,
          });
          if (existingTaskId !== undefined) {
            const existing = await this.getTask({ sessionId: input.sessionId, taskId: existingTaskId });
            if (existing !== undefined) {
              return existing;
            }
          }
          const existingByRecord = await findTaskRecordByCallIdentity(store, rootDir, input.sessionId, input.callIdentity);
          if (existingByRecord !== undefined) {
            await this.bindTaskId({
              sessionId: input.sessionId,
              callIdentity: input.callIdentity,
              taskId: existingByRecord.taskId,
            });
            await ensureTaskHighWaterMarkAtLeast(store, rootDir, input.sessionId, taskNumber(existingByRecord.taskId));
            return existingByRecord;
          }
        }

        const nextNumber = (await this.highWaterMark(input.sessionId)) + 1;
        const taskId = `task_${nextNumber}` as HarnessTaskId;
        const now = new Date().toISOString();
        const record = compact({
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
        await store.writeJson(taskPath(rootDir, input.sessionId, taskId), record);
        await maybeInjectFault(faultInjection, "task-reserve-after-record-write");
        if (input.callIdentity !== undefined) {
          await this.bindTaskId({ sessionId: input.sessionId, callIdentity: input.callIdentity, taskId });
        }
        await store.writeJson(taskMetaPath(rootDir, input.sessionId), { highWaterMark: nextNumber });
        return record;
      });
    },
    async reserveAgentGroupTaskBatch(input) {
      return store.withLock(["task-ledger", input.sessionId], async () => {
        const journalPath = agentGroupTaskBatchJournalPath(
          rootDir,
          input.sessionId,
          input.callIdentity,
        );
        const retired = await store.readJson<DurableAgentGroupRetiredStart>(
          agentGroupRetiredStartPath(rootDir, input.sessionId, input.callIdentity),
        );
        if (retired !== undefined) {
          validateDurableAgentGroupRetiredStart(retired, input.sessionId, input.callIdentity);
          return Object.freeze({
            outcome: retired.scopeIdentity === input.scopeIdentity &&
                retired.canonicalInputDigest === input.canonicalInputDigest
              ? "inconsistent" as const
              : "conflict" as const,
            records: Object.freeze([]),
          });
        }
        const existing = await store.readJson<DurableAgentGroupTaskBatchJournal>(journalPath);
        if (existing !== undefined) {
          validateDurableAgentGroupTaskBatchJournal(existing, input.sessionId, input.callIdentity);
          const existingRecords = await durableAgentGroupTaskBatchRecords(store, rootDir, existing);
          const acceptedRecords = await readDurableAgentGroupAcceptedStartReceipt(
            store,
            rootDir,
            existing,
          );
          const replayRecords = acceptedRecords ?? existingRecords;
          if (existing.canonicalInputDigest !== input.canonicalInputDigest ||
              existing.scopeIdentity !== input.scopeIdentity) {
            return Object.freeze({ outcome: "conflict" as const, records: replayRecords });
          }
          await commitDurableAgentGroupTaskBatch(store, rootDir, existing, faultInjection);
          return Object.freeze({ outcome: "replayed" as const, records: replayRecords });
        }
        if (input.tasks.length < 1 || input.tasks.length > 10_000 ||
            input.sessionId.length === 0 || input.callIdentity.length === 0 ||
            input.scopeIdentity.length === 0 || input.canonicalInputDigest.length === 0 ||
            new Set(input.tasks.map((task) => task.callIdentity)).size !== input.tasks.length ||
            input.tasks.some((task, memberIndex) => task.kind !== "agent" ||
              task.callIdentity === undefined || task.callIdentity.length === 0 ||
              task.agentGroupScopeIdentity !== input.scopeIdentity ||
              task.agentMemberIndex !== memberIndex || task.agentMemberId !== `member_${memberIndex + 1}`)) {
          return Object.freeze({ outcome: "inconsistent" as const, records: Object.freeze([]) });
        }
        for (const task of input.tasks) {
          const binding = await store.readJson<{ readonly taskId: HarnessTaskId }>(
            callIdentityPath(rootDir, input.sessionId, task.callIdentity!),
          );
          if (binding !== undefined) {
            return Object.freeze({ outcome: "inconsistent" as const, records: Object.freeze([]) });
          }
        }
        const meta = await store.readJson<{ readonly highWaterMark: number }>(
          taskMetaPath(rootDir, input.sessionId),
        );
        const currentHighWater = meta?.highWaterMark ?? 0;
        if (!Number.isSafeInteger(currentHighWater) || currentHighWater < 0 ||
            currentHighWater + input.tasks.length > Number.MAX_SAFE_INTEGER) {
          return Object.freeze({ outcome: "inconsistent" as const, records: Object.freeze([]) });
        }
        const firstTaskNumber = currentHighWater + 1;
        const now = new Date().toISOString();
        const records = Object.freeze(input.tasks.map((task, index) =>
          durableRecordForReservedTask(
            { sessionId: input.sessionId, ...task },
            `task_${firstTaskNumber + index}` as HarnessTaskId,
            now,
          )));
        const journal = Object.freeze({
          schemaVersion: "little-harness.agent-group-task-batch.v1" as const,
          sessionId: input.sessionId,
          callIdentity: input.callIdentity,
          scopeIdentity: input.scopeIdentity,
          canonicalInputDigest: input.canonicalInputDigest,
          firstTaskNumber,
          lastTaskNumber: firstTaskNumber + records.length - 1,
          recordsDigest: stableHash(records),
          reservationDigest: stableHash(records.map(durableAgentGroupReservationProjection)),
          records,
          state: "prepared" as const,
        });
        await store.writeJson(journalPath, journal);
        // Reserve the full numeric interval before any member record is
        // materialized. A crash may leave a documented gap, never a collision.
        await store.writeJson(taskMetaPath(rootDir, input.sessionId), {
          highWaterMark: journal.lastTaskNumber,
        });
        await maybeInjectFault(faultInjection, "agent-group-batch-after-journal-write");
        await commitDurableAgentGroupTaskBatch(store, rootDir, journal, faultInjection);
        return Object.freeze({ outcome: "applied" as const, records });
      });
    },
    async getTask(input) {
      const record = await store.readJson<HarnessTaskRecord>(
        taskPath(rootDir, input.sessionId, input.taskId),
      );
      return record === undefined
        ? undefined
        : await overlayAgentGroupProjectionAuthority(store, rootDir, record);
    },
    async listTasks(filter) {
      const storedRecords = filter?.sessionId === undefined
        ? await listSessionRecords<HarnessTaskRecord>(store, rootDir, "tasks")
        : await listJsonRecords<HarnessTaskRecord>(store, taskSessionDir(rootDir, filter.sessionId));
      const records = await overlayAgentGroupProjectionAuthorities(store, rootDir, storedRecords);
      if (filter?.statuses === undefined) {
        return records;
      }
      return records.filter((record) => filter.statuses?.includes(record.status) ?? false);
    },
    async updateTask(record) {
      await store.withLock(["task-record", record.sessionId, record.taskId], async () => {
        const existing = await this.getTask({ sessionId: record.sessionId, taskId: record.taskId });
        if (existing !== undefined) assertGenericAgentTaskMutationAllowed(existing, record);
        const updated = mergeTaskUpdate(existing, record);
        await store.writeJson(taskPath(rootDir, updated.sessionId, updated.taskId), updated);
        if (updated.callIdentity !== undefined) {
          await this.bindTaskId({
            sessionId: updated.sessionId,
            callIdentity: updated.callIdentity,
            taskId: updated.taskId,
          });
        }
      });
    },
    async bindAgentGroupStart(input) {
      return store.withLock(["agent-group-ref-binding", input.groupRef], async () =>
        store.withLock(["agent-group-observation", input.sessionId, input.scopeIdentity], async () => {
          const current = (await Promise.all(input.members.map((member) =>
            this.getTask({ sessionId: input.sessionId, taskId: member.taskId }))))
            .filter((record): record is HarnessTaskRecord => record !== undefined);
          const pageRefBinding = input.observationMode === "paged_changes"
            ? await store.readJson<DurableAgentGroupPageRefBinding>(
                agentGroupPageRefPath(rootDir, input.groupRef),
              )
            : undefined;
          const collected = input.observationMode === "paged_changes"
            ? await store.readJson<DurableAgentGroupGarbageCollection>(
                agentGroupGarbageCollectionPath(rootDir, input.groupRef),
              )
            : undefined;
          if (collected !== undefined) {
            validateDurableAgentGroupGarbageCollection(collected, {
              sessionId: input.sessionId,
              groupRef: input.groupRef,
              expectedAggregateVersion: collected.aggregateVersion,
              expectedGroupObservationDigest: collected.groupObservationDigest,
            });
            return { outcome: "conflict" as const, records: Object.freeze(current) };
          }
          if (pageRefBinding !== undefined &&
              (pageRefBinding.schemaVersion !== "little-harness.agent-group-page-ref.v1" ||
                pageRefBinding.groupRef !== input.groupRef)) {
            throw new HarnessInputError("Stored Agent Group page ref binding is invalid.");
          }
          const conflictingRef = input.observationMode === "paged_changes"
            ? pageRefBinding !== undefined &&
              (pageRefBinding.sessionId !== input.sessionId ||
                pageRefBinding.scopeIdentity !== input.scopeIdentity)
            : (await this.listTasks()).some((record) =>
                record.externalAgentGroupRef === input.groupRef &&
                (record.sessionId !== input.sessionId ||
                  record.agentGroupScopeIdentity !== input.scopeIdentity));
          if (conflictingRef) {
            return { outcome: "conflict" as const, records: Object.freeze(current) };
          }
          let evaluated = evaluateAgentGroupStartBinding(input, current);
          if (evaluated.outcome === "inconsistent" && input.observationMode === "paged_changes") {
            const existingPage = await readDurableAgentGroupPageAuthority(
              store,
              rootDir,
              input.sessionId,
              input.scopeIdentity,
            );
            if (existingPage !== undefined) {
              const normalized = current.map(unbindDurableAgentGroupStartRecord);
              const reconstructed = evaluateAgentGroupStartBinding(input, normalized);
              if (reconstructed.outcome === "applied" &&
                  durableAgentGroupPageStartEnvelopeDigest(input, reconstructed.records) ===
                    existingPage.startEnvelopeDigest &&
                  current.every((record, index) =>
                    stableHash(record) === stableHash(normalized[index]) ||
                    stableHash(record) === stableHash(reconstructed.records[index]))) {
                evaluated = Object.freeze({
                  outcome: "replayed" as const,
                  records: reconstructed.records,
                });
              }
            }
          }
          if (evaluated.outcome === "applied") {
            if (input.observationMode === "paged_changes") {
              await ensureDurableAgentGroupPageStartAuthority(store, rootDir, input, evaluated.records);
            } else {
              await writeAgentGroupProjectionAuthority(store, rootDir, input, evaluated.records);
            }
            await maybeInjectFault(faultInjection, "agent-group-start-binding-after-authority-commit");
            for (const [index, record] of evaluated.records.entries()) {
              await store.writeJson(taskPath(rootDir, record.sessionId, record.taskId), record);
              if (index === Math.floor(evaluated.records.length / 2)) {
                await maybeInjectFault(faultInjection, "agent-group-start-binding-during-record-writes");
              }
            }
          } else if (evaluated.outcome === "replayed" && input.observationMode === "paged_changes") {
            const existingPage = await readDurableAgentGroupPageAuthority(
              store,
              rootDir,
              input.sessionId,
              input.scopeIdentity,
            );
            if (existingPage !== undefined) {
              const journal = input.launchCallIdentity === undefined
                ? undefined
                : await store.readJson<DurableAgentGroupTaskBatchJournal>(
                    agentGroupTaskBatchJournalPath(rootDir, input.sessionId, input.launchCallIdentity),
                  );
              if (journal === undefined) {
                return Object.freeze({ outcome: "inconsistent" as const, records: Object.freeze([]) });
              }
              validateDurableAgentGroupTaskBatchJournal(
                journal,
                input.sessionId,
                input.launchCallIdentity!,
              );
              const accepted = await readDurableAgentGroupAcceptedStartReceipt(store, rootDir, journal);
              if (accepted === undefined ||
                  durableAgentGroupPageStartEnvelopeDigest(input, accepted) !==
                    existingPage.startEnvelopeDigest) {
                return Object.freeze({ outcome: "inconsistent" as const, records: Object.freeze([]) });
              }
              const mayRepairInitialMirror = existingPage.state.aggregateVersion === 0 &&
                existingPage.mirrorThroughSequence === 0 && existingPage.lastCommit === undefined &&
                existingPage.state.groupStatus === "queued";
              if (mayRepairInitialMirror) {
                for (const record of accepted) {
                  await store.writeJson(taskPath(rootDir, record.sessionId, record.taskId), record);
                }
              }
              evaluated = Object.freeze({ outcome: "replayed" as const, records: accepted });
            } else if (evaluated.records.every((record) =>
              record.status === "queued" && record.agentGroupRevision === 0 &&
              record.agentGroupStatus === "queued" && record.externalAgentGroupRef === input.groupRef &&
              record.agentLaunchAcceptedAt === input.acceptedAt)) {
              await ensureDurableAgentGroupPageStartAuthority(store, rootDir, input, evaluated.records);
              for (const record of evaluated.records) {
                await store.writeJson(taskPath(rootDir, record.sessionId, record.taskId), record);
              }
            } else {
              return Object.freeze({ outcome: "inconsistent" as const, records: Object.freeze([]) });
            }
          }
          return evaluated;
        }));
    },
    async projectAgentGroupObservation(input) {
      return store.withLock(["agent-group-observation", input.sessionId, input.scopeIdentity], async () => {
        const current = (await Promise.all(input.members.map((member) =>
          this.getTask({ sessionId: input.sessionId, taskId: member.taskId }))))
          .filter((record): record is HarnessTaskRecord => record !== undefined);
        const evaluated = evaluateAgentGroupObservationProjection(input, current);
        if (evaluated.outcome === "applied") {
          await writeAgentGroupProjectionAuthority(store, rootDir, input, evaluated.records);
          await maybeInjectFault(faultInjection, "agent-group-projection-after-authority-commit");
          for (const record of evaluated.records) {
            await store.writeJson(taskPath(rootDir, record.sessionId, record.taskId), record);
          }
        }
        return evaluated;
      });
    },
    async getAgentGroupPageState(input) {
      return store.withLock(["agent-group-ref-binding", input.groupRef], async () => {
        const garbageCollection = await store.readJson<DurableAgentGroupGarbageCollection>(
          agentGroupGarbageCollectionPath(rootDir, input.groupRef),
        );
        if (garbageCollection !== undefined) {
          validateDurableAgentGroupGarbageCollection(garbageCollection, {
            sessionId: input.sessionId,
            groupRef: input.groupRef,
            expectedAggregateVersion: garbageCollection.aggregateVersion,
            expectedGroupObservationDigest: garbageCollection.groupObservationDigest,
          });
          if (garbageCollection.state !== "prepared") return undefined;
        }
        const binding = await readDurableAgentGroupPageRefBinding(
          store,
          rootDir,
          input.sessionId,
          input.groupRef,
        );
        if (binding === undefined) return undefined;
        return store.withLock(
          ["agent-group-observation", input.sessionId, binding.scopeIdentity],
          async () => {
            const authority = await recoverDurableAgentGroupPageMirror(
              store,
              rootDir,
              input.sessionId,
              binding.scopeIdentity,
            );
            return authority?.state;
          },
        );
      });
    },
    async reserveAgentGroupJoinBegin(input) {
      return store.withLock(["agent-group-ref-binding", input.groupRef], async () => {
        const garbageCollection = await store.readJson<DurableAgentGroupGarbageCollection>(
          agentGroupGarbageCollectionPath(rootDir, input.groupRef),
        );
        if (garbageCollection !== undefined) {
          validateDurableAgentGroupGarbageCollection(garbageCollection, {
            sessionId: input.sessionId,
            groupRef: input.groupRef,
            expectedAggregateVersion: garbageCollection.aggregateVersion,
            expectedGroupObservationDigest: garbageCollection.groupObservationDigest,
          });
          // A begin may not race a prepared, deleting, or committed GC marker.
          return Object.freeze({ outcome: "conflict" as const, phase: "reserved" as const });
        }
        const binding = await readDurableAgentGroupPageRefBinding(
          store,
          rootDir,
          input.sessionId,
          input.groupRef,
        );
        if (binding === undefined || binding.scopeIdentity !== input.scopeIdentity ||
            !validAgentGroupJoinBeginReservationInput(input)) {
          return Object.freeze({ outcome: "inconsistent" as const, phase: "reserved" as const });
        }
        return store.withLock(
          ["agent-group-observation", input.sessionId, binding.scopeIdentity],
          async () => {
            const authority = await recoverDurableAgentGroupPageMirror(
              store,
              rootDir,
              input.sessionId,
              binding.scopeIdentity,
            );
            if (authority === undefined || authority.state.groupRef !== input.groupRef ||
                authority.state.scopeIdentity !== input.scopeIdentity) {
              return Object.freeze({ outcome: "inconsistent" as const, phase: "reserved" as const });
            }
            const active = authority.activeJoinBeginReservation;
            const pageCall = await store.readJson<DurableAgentGroupPageCall>(
              agentGroupPageCallPath(
                rootDir,
                input.sessionId,
                input.scopeIdentity,
                input.pageCallIdentity,
              ),
            );
            const retiredPageCall = await store.readJson<DurableAgentGroupRetiredPageCall>(
              agentGroupRetiredPageCallPath(
                rootDir,
                input.sessionId,
                input.scopeIdentity,
                input.pageCallIdentity,
              ),
            );
            if (pageCall === undefined || retiredPageCall !== undefined ||
                authority.expiredPageCallOrder?.includes(input.pageCallIdentity) === true) {
              if (retiredPageCall !== undefined) {
                validateDurableAgentGroupRetiredPageCall(
                  retiredPageCall,
                  authority,
                  input.pageCallIdentity,
                );
              }
              return Object.freeze({ outcome: "inconsistent" as const, phase: "reserved" as const });
            }
            validateDurableAgentGroupPageCall(
              pageCall,
              input.sessionId,
              input.scopeIdentity,
              input.groupRef,
              input.pageCallIdentity,
            );
            if (pageCall.input.operationKind !== "join" ||
                pageCall.input.requestIdempotencyKey !== input.requestIdempotencyKey) {
              return Object.freeze({ outcome: "inconsistent" as const, phase: "reserved" as const });
            }
            const inferred = await inferDurableAgentGroupJoinBeginReservation(
              store,
              rootDir,
              input,
              authority.state,
            );
            if (inferred.conflict === true) {
              return Object.freeze({ outcome: "conflict" as const, phase: "reserved" as const });
            }
            if (active !== undefined &&
                active.input.operationIdempotencyKey === input.operationIdempotencyKey &&
                active.operationRef !== undefined && inferred.operationRef !== undefined &&
                active.operationRef !== inferred.operationRef) {
              return joinBeginReservationResult(active, "conflict");
            }
            if (active !== undefined &&
                active.input.operationIdempotencyKey === input.operationIdempotencyKey &&
                stableHash(active.input) !== stableHash(input)) {
              return joinBeginReservationResult(active, "conflict");
            }
            if (active !== undefined &&
                active.input.operationIdempotencyKey !== input.operationIdempotencyKey &&
                !inferred.visible) {
              return joinBeginReservationResult(active, "conflict");
            }
            const record = active !== undefined &&
                active.input.operationIdempotencyKey === input.operationIdempotencyKey
              ? durableAgentGroupJoinBeginReservationFor(input, {
                  phase: agentGroupJoinBeginReservationPhaseRank(active.phase) >=
                      agentGroupJoinBeginReservationPhaseRank(inferred.phase)
                    ? active.phase
                    : inferred.phase,
                  ...(inferred.operationRef === undefined
                    ? (active.operationRef === undefined ? {} : { operationRef: active.operationRef })
                    : { operationRef: inferred.operationRef }),
                })
              : durableAgentGroupJoinBeginReservationFor(input, inferred);
            validateDurableAgentGroupJoinBeginReservation(record);
            const visibleTerminal = record.phase === "terminal" && inferred.visible;
            const nextAuthority = { ...authority };
            if (visibleTerminal &&
                (active === undefined ||
                  active.input.operationIdempotencyKey === input.operationIdempotencyKey)) {
              delete nextAuthority.activeJoinBeginReservation;
            } else if (!visibleTerminal) {
              nextAuthority.activeJoinBeginReservation = record;
            }
            if (stableHash(nextAuthority) !== stableHash(authority)) {
              await store.writeJson(
                agentGroupPageAuthorityPath(rootDir, input.sessionId, input.scopeIdentity),
                nextAuthority,
              );
            }
            const outcome = record.phase === "reserved"
              ? active === undefined ? "applied" as const : "replayed" as const
              : record.phase;
            return joinBeginReservationResult(record, outcome);
          },
        );
      });
    },
    async bindAgentGroupPageCall(input) {
      return store.withLock(["agent-group-ref-binding", input.groupRef], async () =>
        store.withLock(
          ["agent-group-observation", input.sessionId, input.scopeIdentity],
          async () => {
          const garbageCollection = await store.readJson<DurableAgentGroupGarbageCollection>(
            agentGroupGarbageCollectionPath(rootDir, input.groupRef),
          );
          if (garbageCollection !== undefined) {
            validateDurableAgentGroupGarbageCollection(garbageCollection, {
              sessionId: input.sessionId,
              groupRef: input.groupRef,
              expectedAggregateVersion: garbageCollection.aggregateVersion,
              expectedGroupObservationDigest: garbageCollection.groupObservationDigest,
            });
            if (garbageCollection.state !== "prepared") {
              return Object.freeze({
                outcome: "inconsistent" as const,
                requestIdempotencyKey: input.requestIdempotencyKey,
                startSequence: garbageCollection.aggregateVersion,
                currentHighWater: garbageCollection.aggregateVersion,
                minimumRetainedSequence: garbageCollection.aggregateVersion,
              });
            }
          }
          let authority = await recoverDurableAgentGroupPageMirror(
            store,
            rootDir,
            input.sessionId,
            input.scopeIdentity,
          );
          const invalid = authority === undefined || authority.state.groupRef !== input.groupRef ||
            authority.state.scopeIdentity !== input.scopeIdentity || !validAgentGroupPageCallInput(input);
          if (invalid || authority === undefined) {
            return Object.freeze({
              outcome: "inconsistent" as const,
              requestIdempotencyKey: input.requestIdempotencyKey,
              startSequence: 0,
              currentHighWater: authority?.state.aggregateVersion ?? 0,
              minimumRetainedSequence: authority?.state.minimumRetainedSequence ?? 0,
            });
          }
          const activePageCallIdentity = authority.activeJoinBeginReservation?.input.pageCallIdentity;
          const path = agentGroupPageCallPath(
            rootDir,
            input.sessionId,
            input.scopeIdentity,
            input.callIdentity,
          );
          const existing = await store.readJson<DurableAgentGroupPageCall>(path);
          const bindingDigest = stableHash(input);
          const retired = await store.readJson<DurableAgentGroupRetiredPageCall>(
            agentGroupRetiredPageCallPath(rootDir, input.sessionId, input.scopeIdentity, input.callIdentity),
          );
          if (retired !== undefined) {
            validateDurableAgentGroupRetiredPageCall(retired, authority, input.callIdentity);
            return Object.freeze({
              outcome: "expired" as const,
              requestIdempotencyKey: input.requestIdempotencyKey,
              startSequence: authority.state.minimumRetainedSequence,
              currentHighWater: authority.state.aggregateVersion,
              minimumRetainedSequence: authority.state.minimumRetainedSequence,
            });
          }
          if (authority.expiredPageCallOrder?.includes(input.callIdentity) === true &&
              input.callIdentity !== activePageCallIdentity) {
            if (existing !== undefined) {
              await removeDurableAgentGroupPageCallHistory(
                store,
                rootDir,
                input.sessionId,
                input.scopeIdentity,
                input.callIdentity,
                authority.lastCommit?.requestIdempotencyKey,
              );
            }
            return Object.freeze({
              outcome: "expired" as const,
              requestIdempotencyKey: input.requestIdempotencyKey,
              startSequence: authority.state.minimumRetainedSequence,
              currentHighWater: authority.state.aggregateVersion,
              minimumRetainedSequence: authority.state.minimumRetainedSequence,
            });
          }
          if (existing !== undefined) {
            validateDurableAgentGroupPageCall(
              existing,
              input.sessionId,
              input.scopeIdentity,
              input.groupRef,
              input.callIdentity,
            );
            const recoveredAuthority = await retainDurableAgentGroupPageCall(
              store,
              rootDir,
              authority,
              input.callIdentity,
            );
            if (recoveredAuthority !== authority) {
              authority = recoveredAuthority;
              await store.writeJson(
                agentGroupPageAuthorityPath(rootDir, input.sessionId, input.scopeIdentity),
                authority,
              );
            }
            if (existing.input.canonicalInputDigest !== input.canonicalInputDigest ||
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
          if ((authority.pageCallsIssued ?? 0) >= HARNESS_AGENT_GROUP_MAX_LIFETIME_PAGE_CALLS) {
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
            const appliedResult = Object.freeze({ ...result, outcome: "applied" as const });
            await store.writeJson(path, {
              schemaVersion: "little-harness.agent-group-page-call.v1",
              input,
              bindingDigest,
              result: appliedResult,
            } satisfies DurableAgentGroupPageCall);
            authority = await retainDurableAgentGroupPageCall(
              store,
              rootDir,
              authority,
              input.callIdentity,
            );
            if (input.requestedAfterSequence === undefined &&
                startSequence > authority.state.acknowledgedSequence) {
              authority = Object.freeze({
                ...authority,
                state: Object.freeze({ ...authority.state, acknowledgedSequence: startSequence }),
              });
            }
            await store.writeJson(
              agentGroupPageAuthorityPath(rootDir, input.sessionId, input.scopeIdentity),
              authority,
            );
          }
          return result;
          },
        ));
    },
    async bindAgentGroupPendingOperation(input) {
      return store.withLock(["agent-group-ref-binding", input.groupRef], async () =>
        store.withLock(
          ["agent-group-observation", input.sessionId, input.scopeIdentity],
          async () => {
          const authority = await recoverDurableAgentGroupPageMirror(
            store,
            rootDir,
            input.sessionId,
            input.scopeIdentity,
          );
          if (authority === undefined || authority.state.groupRef !== input.groupRef ||
              authority.state.scopeIdentity !== input.scopeIdentity ||
              !validAgentGroupPendingOperationBinding(input, authority.state)) {
            return Object.freeze({ outcome: "inconsistent" as const });
          }
          const activeJoin = authority.activeJoinBeginReservation;
          const activeJoinOwned = activeJoin !== undefined &&
            (input.operationMode === "begin"
              ? activeJoin.input.operationIdempotencyKey === input.operationIdempotencyKey
              : activeJoin.operationRef !== undefined && activeJoin.operationRef === input.pending.operationRef);
          if (activeJoin !== undefined && input.operationMode === "begin" &&
              activeJoin.input.operationIdempotencyKey === input.operationIdempotencyKey) {
            const beginInput = agentGroupJoinBeginReservationInputFromBinding(input, input.operationIdempotencyKey);
            if (beginInput === undefined || stableHash(beginInput) !== stableHash(activeJoin.input)) {
              return Object.freeze({ outcome: "conflict" as const });
            }
          }
          const visibleOtherJoin = activeJoin !== undefined && !activeJoinOwned
            ? await durableVisibleAgentGroupOperationResultFor(store, rootDir, input, authority.state)
            : false;
          if (activeJoin !== undefined && !activeJoinOwned && !visibleOtherJoin) {
            return Object.freeze({ outcome: "conflict" as const });
          }
          const pendingPath = agentGroupPendingOperationPath(
            rootDir,
            input.sessionId,
            input.scopeIdentity,
            input.pending.operationRef,
          );
          const existing = await store.readJson<DurableAgentGroupPendingOperation>(pendingPath);
          if (existing !== undefined) {
            validateDurableAgentGroupPendingOperation(
              existing,
              input.sessionId,
              input.scopeIdentity,
              input.groupRef,
              input.pending.operationRef,
              authority.state,
            );
            if (input.operationMode === "begin" &&
                (existing.input.operationIdempotencyKey !== input.operationIdempotencyKey ||
                  existing.input.mutationInputDigest !== input.mutationInputDigest)) {
              return Object.freeze({ outcome: "conflict" as const });
            }
            const beginOwnership = agentGroupJoinBeginOperationIdentity(
              existing.input,
              existing.input.pending.operationRef,
            );
            const beginAliasOutcome = await ensureDurableAgentGroupBeginAlias(
              store,
              rootDir,
              beginOwnership,
            );
            if (beginAliasOutcome === "conflict") {
              return Object.freeze({ outcome: "conflict" as const });
            }
            if (!pendingOperationObservationReplayCompatible(existing.input.pending, input.pending)) {
              return Object.freeze({ outcome: "conflict" as const });
            }
            const existingVisibilityAuthorized = await durableVisibleAgentGroupOperationResultFor(
              store,
              rootDir,
              input,
              authority.state,
            );
            const advanced = await advanceDurableAgentGroupJoinBeginReservation(
              store,
              rootDir,
              authority,
              existing.input.operationIdempotencyKey,
              input.pending.operationRef,
              "pending",
              input,
              existingVisibilityAuthorized,
            );
            return advanced.outcome === "conflict"
              ? Object.freeze({ outcome: "conflict" as const })
              : Object.freeze({ outcome: "replayed" as const });
          }
          if (input.operationMode === "continue") {
            if (activeJoinOwned && activeJoin?.phase === "ref_bound" &&
                activeJoin.operationRef === input.pending.operationRef) {
              const beginOwnership = agentGroupJoinBeginOperationIdentity(
                activeJoin.input,
                input.pending.operationRef,
              );
              const beginAliasOutcome = await ensureDurableAgentGroupBeginAlias(
                store,
                rootDir,
                beginOwnership,
              );
              if (beginAliasOutcome === "conflict") {
                return Object.freeze({ outcome: "conflict" as const });
              }
              const continuationAliasPath = agentGroupOperationIdempotencyPath(
                rootDir,
                input.sessionId,
                input.scopeIdentity,
                input.operationIdempotencyKey,
              );
              const continuationAlias = await store.readJson<DurableAgentGroupOperationIdempotency>(
                continuationAliasPath,
              );
              if (continuationAlias !== undefined &&
                  (continuationAlias.schemaVersion !== "little-harness.agent-group-operation-idempotency.v1" ||
                    continuationAlias.sessionId !== input.sessionId ||
                    continuationAlias.scopeIdentity !== input.scopeIdentity ||
                    continuationAlias.groupRef !== input.groupRef ||
                    continuationAlias.operationIdempotencyKey !== input.operationIdempotencyKey ||
                    continuationAlias.operationRef !== input.pending.operationRef ||
                    continuationAlias.operationMode !== "continue" ||
                    continuationAlias.mutationInputDigest !== input.mutationInputDigest)) {
                return Object.freeze({ outcome: "conflict" as const });
              }
              const adoptedInput = Object.freeze({
                ...input,
                sessionId: activeJoin.input.sessionId,
                scopeIdentity: activeJoin.input.scopeIdentity,
                groupRef: activeJoin.input.groupRef,
                operationIdempotencyKey: activeJoin.input.operationIdempotencyKey,
                mutationInputDigest: activeJoin.input.mutationInputDigest,
                operationMode: "begin" as const,
                pageCallIdentity: activeJoin.input.pageCallIdentity,
                requestIdempotencyKey: activeJoin.input.requestIdempotencyKey,
              });
              await store.writeJson(pendingPath, {
                schemaVersion: "little-harness.agent-group-pending-operation.v1",
                input: adoptedInput,
                inputDigest: stableHash(adoptedInput),
              } satisfies DurableAgentGroupPendingOperation);
              if (continuationAlias === undefined) {
                await store.writeJson(continuationAliasPath, {
                  schemaVersion: "little-harness.agent-group-operation-idempotency.v1",
                  sessionId: input.sessionId,
                  scopeIdentity: input.scopeIdentity,
                  groupRef: input.groupRef,
                  operationIdempotencyKey: input.operationIdempotencyKey,
                  operationRef: input.pending.operationRef,
                  operationMode: input.operationMode,
                  mutationInputDigest: input.mutationInputDigest,
                } satisfies DurableAgentGroupOperationIdempotency);
              }
              const advanced = await advanceDurableAgentGroupJoinBeginReservation(
                store,
                rootDir,
                authority,
                activeJoin.input.operationIdempotencyKey,
                input.pending.operationRef,
                "pending",
                input,
                false,
              );
              return advanced.outcome === "conflict"
                ? Object.freeze({ outcome: "conflict" as const })
                : Object.freeze({ outcome: "applied" as const });
            }
            return Object.freeze({ outcome: "inconsistent" as const });
          }
          const resultPath = agentGroupOperationResultPath(
            rootDir,
            input.sessionId,
            input.scopeIdentity,
            input.pending.operationRef,
          );
          const existingResult = await store.readJson<DurableAgentGroupOperationResult>(resultPath);
          if (existingResult !== undefined) {
            validateDurableAgentGroupOperationResult(
              existingResult,
              input.sessionId,
              input.scopeIdentity,
              input.groupRef,
              input.pending.operationRef,
              authority.state,
            );
            if (existingResult.input.operationMode !== "begin" ||
                existingResult.input.operationIdempotencyKey !== input.operationIdempotencyKey ||
                existingResult.input.mutationInputDigest !== input.mutationInputDigest) {
              return Object.freeze({ outcome: "conflict" as const });
            }
            const beginOwnership = agentGroupJoinBeginOperationIdentity(
              existingResult.input,
              existingResult.input.result.operationRef,
            );
            const beginAliasOutcome = await ensureDurableAgentGroupBeginAlias(
              store,
              rootDir,
              beginOwnership,
            );
            if (beginAliasOutcome === "conflict") {
              return Object.freeze({ outcome: "conflict" as const });
            }
            const advanced = await advanceDurableAgentGroupJoinBeginReservation(
              store,
              rootDir,
              authority,
              existingResult.input.operationIdempotencyKey,
              input.pending.operationRef,
              "terminal",
              input,
              false,
            );
            return advanced.outcome === "conflict"
              ? Object.freeze({ outcome: "conflict" as const })
              : Object.freeze({ outcome: "replayed" as const });
          }
          const beginOwnership = agentGroupJoinBeginOperationIdentity(
            input,
            input.pending.operationRef,
          );
          const beginAliasOutcome = await ensureDurableAgentGroupBeginAlias(
            store,
            rootDir,
            beginOwnership,
          );
          if (beginAliasOutcome === "conflict") {
            return Object.freeze({ outcome: "conflict" as const });
          }
          if (beginAliasOutcome === "applied") {
            await maybeInjectFault(faultInjection, "agent-group-pending-after-alias-before-write");
          }
          await store.writeJson(pendingPath, {
            schemaVersion: "little-harness.agent-group-pending-operation.v1",
            input,
            inputDigest: stableHash(input),
          } satisfies DurableAgentGroupPendingOperation);
          await maybeInjectFault(faultInjection, "agent-group-pending-after-write");
          const advanced = await advanceDurableAgentGroupJoinBeginReservation(
            store,
            rootDir,
            authority,
            input.operationIdempotencyKey,
            input.pending.operationRef,
            "pending",
            input,
            false,
          );
          return advanced.outcome === "conflict"
            ? Object.freeze({ outcome: "conflict" as const })
            : Object.freeze({ outcome: "applied" as const });
          },
        ));
    },
    async bindAgentGroupOperationResult(input) {
      return store.withLock(["agent-group-ref-binding", input.groupRef], async () =>
        store.withLock(
          ["agent-group-observation", input.sessionId, input.scopeIdentity],
          async () => {
          const garbageCollection = await store.readJson<DurableAgentGroupGarbageCollection>(
            agentGroupGarbageCollectionPath(rootDir, input.groupRef),
          );
          if (garbageCollection !== undefined) {
            validateDurableAgentGroupGarbageCollection(garbageCollection, {
              sessionId: input.sessionId,
              groupRef: input.groupRef,
              expectedAggregateVersion: garbageCollection.aggregateVersion,
              expectedGroupObservationDigest: garbageCollection.groupObservationDigest,
            });
            if (garbageCollection.state !== "prepared") {
              return Object.freeze({ outcome: "inconsistent" as const });
            }
          }
          const authority = await recoverDurableAgentGroupPageMirror(
            store,
            rootDir,
            input.sessionId,
            input.scopeIdentity,
          );
          if (authority === undefined || authority.state.groupRef !== input.groupRef ||
              authority.state.scopeIdentity !== input.scopeIdentity ||
              !validAgentGroupOperationResultBinding(input, authority.state.aggregateVersion) ||
              input.result.completedAt < authority.state.launchAcceptedAt ||
              input.result.resultRefs.length > authority.state.agentMaxResultRefs ||
              (input.result.summary !== undefined && Buffer.byteLength(input.result.summary, "utf8") >
                authority.state.agentMaxGroupSummaryBytes)) {
            return Object.freeze({ outcome: "inconsistent" as const });
          }
          const activeJoin = input.result.kind === "join"
            ? authority.activeJoinBeginReservation
            : undefined;
          const activeJoinOwned = activeJoin !== undefined &&
            (input.operationMode === "begin"
              ? activeJoin.input.operationIdempotencyKey === input.operationIdempotencyKey
              : activeJoin.operationRef !== undefined && activeJoin.operationRef === input.result.operationRef);
          if (activeJoin !== undefined && input.operationMode === "begin" &&
              activeJoin.input.operationIdempotencyKey === input.operationIdempotencyKey) {
            const beginInput = agentGroupJoinBeginReservationInputFromBinding(input, input.operationIdempotencyKey);
            if (beginInput === undefined || stableHash(beginInput) !== stableHash(activeJoin.input)) {
              return Object.freeze({ outcome: "conflict" as const });
            }
          }
          const visibleOtherJoin = activeJoin !== undefined && !activeJoinOwned
            ? await durableVisibleAgentGroupOperationResultFor(store, rootDir, input, authority.state)
            : false;
          if (activeJoin !== undefined && !activeJoinOwned && !visibleOtherJoin) {
            return Object.freeze({ outcome: "conflict" as const });
          }
          const visibilityPath = agentGroupOperationVisibilityPath(
            rootDir,
            input.sessionId,
            input.scopeIdentity,
            input.result.operationRef,
          );
          const existingVisibility = await store.readJson<DurableAgentGroupOperationVisibility>(visibilityPath);
          if (existingVisibility !== undefined && !validDurableAgentGroupOperationVisibility(
            existingVisibility,
            input.sessionId,
            input.scopeIdentity,
            input.groupRef,
            input.result.operationRef,
          )) {
            throw new HarnessInputError("Stored Agent Group operation visibility authority is invalid.");
          }
          if (input.authorizeVisibility && existingVisibility === undefined &&
              !validAgentGroupOperationVisibilityAuthorization(input, authority.state)) {
            return Object.freeze({ outcome: "inconsistent" as const });
          }
          const resultPath = agentGroupOperationResultPath(
            rootDir,
            input.sessionId,
            input.scopeIdentity,
            input.result.operationRef,
          );
          const existing = await store.readJson<DurableAgentGroupOperationResult>(resultPath);
          const existingVisibilityMatchesResult = existingVisibility !== undefined &&
            existing !== undefined &&
            existingVisibility.resultDigest === existing.input.result.resultDigest &&
            existingVisibility.resultVersion === existing.input.result.resultVersion;
          if (existingVisibility !== undefined && !existingVisibilityMatchesResult) {
            throw new HarnessInputError("Stored Agent Group operation visibility authority is invalid.");
          }
          const idempotencyPath = agentGroupOperationIdempotencyPath(
            rootDir,
            input.sessionId,
            input.scopeIdentity,
            input.operationIdempotencyKey,
          );
          const idempotency = await store.readJson<DurableAgentGroupOperationIdempotency>(
            idempotencyPath,
          );
          if (idempotency !== undefined &&
              (!validDurableAgentGroupOperationIdempotency(idempotency, input) ||
                idempotency.operationRef !== input.result.operationRef)) {
            return Object.freeze({ outcome: "conflict" as const });
          }
          const pendingPath = agentGroupPendingOperationPath(
            rootDir,
            input.sessionId,
            input.scopeIdentity,
            input.result.operationRef,
          );
          const pending = existing === undefined && input.operationMode === "continue"
            ? await store.readJson<DurableAgentGroupPendingOperation>(pendingPath)
            : undefined;
          const refBoundContinuation = input.operationMode === "continue" &&
            input.result.kind === "join" && activeJoin?.phase === "ref_bound" &&
            activeJoin.operationRef === input.result.operationRef;
          if (pending !== undefined) {
            validateDurableAgentGroupPendingOperation(
              pending,
              input.sessionId,
              input.scopeIdentity,
              input.groupRef,
              input.result.operationRef,
              authority.state,
            );
          }
          if (input.authorizeVisibility && input.result.resultVersion > authority.state.aggregateVersion) {
            return Object.freeze({ outcome: "inconsistent" as const });
          }
          if (input.authorizeVisibility && input.result.kind === "join") {
            for (const resultRef of input.result.resultRefs) {
              const owner = await store.readJson<DurableAgentGroupResultRefOwner>(
                agentGroupResultRefOwnerPath(rootDir, resultRef),
              );
              if (owner === undefined || !validDurableAgentGroupResultRefOwner(owner) ||
                  owner.sessionId !== input.sessionId ||
                  owner.scopeIdentity !== input.scopeIdentity || owner.groupRef !== input.groupRef ||
                  owner.resultRef !== resultRef ||
                  owner.publicationSequence > input.result.resultVersion) {
                return Object.freeze({ outcome: "inconsistent" as const });
              }
            }
          }
          let aliasWrittenBeforeResult = false;
          if (existing === undefined && idempotency === undefined &&
              input.operationMode === "begin" && input.result.kind === "join") {
            await store.writeJson(idempotencyPath, {
              schemaVersion: "little-harness.agent-group-operation-idempotency.v1",
              sessionId: input.sessionId,
              scopeIdentity: input.scopeIdentity,
              groupRef: input.groupRef,
              operationIdempotencyKey: input.operationIdempotencyKey,
              operationRef: input.result.operationRef,
              operationMode: input.operationMode,
              mutationInputDigest: input.mutationInputDigest,
            } satisfies DurableAgentGroupOperationIdempotency);
            aliasWrittenBeforeResult = true;
            await maybeInjectFault(faultInjection, "agent-group-result-after-alias-before-write");
          }
          let applied = false;
          if (existing !== undefined) {
            validateDurableAgentGroupOperationResult(
              existing,
              input.sessionId,
              input.scopeIdentity,
              input.groupRef,
              input.result.operationRef,
              authority.state,
            );
            const replayed = existing.input.result.resultDigest === input.result.resultDigest &&
              existing.input.result.kind === input.result.kind &&
              stableHash(existing.input.result) === stableHash(input.result);
            if (!replayed || input.operationMode === "begin" &&
                (existing.input.operationMode !== "begin" ||
                  existing.input.operationIdempotencyKey !== input.operationIdempotencyKey ||
                  existing.input.mutationInputDigest !== input.mutationInputDigest)) {
              return Object.freeze({ outcome: "conflict" as const });
            }
          } else {
            if (input.operationMode !== "begin") {
              if (pending === undefined && !refBoundContinuation) {
                return Object.freeze({ outcome: "inconsistent" as const });
              }
              if (pending !== undefined && (pending.input.pending.operationRef !== input.result.operationRef ||
                  input.result.kind !== "join")) {
                return Object.freeze({ outcome: "conflict" as const });
              }
            }
            const storedInput = pending === undefined
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
                : Object.freeze({ ...input, authorizeVisibility: false })
              : Object.freeze({
                  ...input,
                  operationIdempotencyKey: pending.input.operationIdempotencyKey,
                  mutationInputDigest: pending.input.mutationInputDigest,
                  operationMode: "begin" as const,
                  authorizeVisibility: false,
                });
            await store.writeJson(resultPath, {
              schemaVersion: "little-harness.agent-group-operation-result.v1",
              input: storedInput,
              inputDigest: stableHash(storedInput),
            } satisfies DurableAgentGroupOperationResult);
            applied = true;
          }
          if (idempotency === undefined && !aliasWrittenBeforeResult) {
            await store.writeJson(idempotencyPath, {
              schemaVersion: "little-harness.agent-group-operation-idempotency.v1",
              sessionId: input.sessionId,
              scopeIdentity: input.scopeIdentity,
              groupRef: input.groupRef,
              operationIdempotencyKey: input.operationIdempotencyKey,
              operationRef: input.result.operationRef,
              operationMode: input.operationMode,
              mutationInputDigest: input.mutationInputDigest,
            } satisfies DurableAgentGroupOperationIdempotency);
            applied = true;
          }
          if (input.authorizeVisibility) {
            const visibility = {
              schemaVersion: "little-harness.agent-group-operation-visibility.v1" as const,
              sessionId: input.sessionId,
              scopeIdentity: input.scopeIdentity,
              groupRef: input.groupRef,
              operationRef: input.result.operationRef,
              resultDigest: input.result.resultDigest,
              resultVersion: input.result.resultVersion,
            };
            if (existingVisibility !== undefined && stableHash(existingVisibility) !== stableHash(visibility)) {
              return Object.freeze({ outcome: "conflict" as const });
            }
            if (existingVisibility === undefined) {
              await store.writeJson(visibilityPath, visibility);
              applied = true;
            }
          }
          if (input.result.kind === "join") {
            const reservationOperationIdempotencyKey = input.operationMode === "begin"
              ? input.operationIdempotencyKey
              : pending?.input.operationIdempotencyKey ??
                (refBoundContinuation ? activeJoin!.input.operationIdempotencyKey : input.operationIdempotencyKey);
            const advanced = await advanceDurableAgentGroupJoinBeginReservation(
              store,
              rootDir,
              authority,
              reservationOperationIdempotencyKey,
              input.result.operationRef,
              "terminal",
              pending?.input ?? input,
              input.authorizeVisibility === true || existingVisibilityMatchesResult,
            );
            if (advanced.outcome === "conflict") {
              return Object.freeze({ outcome: "conflict" as const });
            }
          }
          return Object.freeze({ outcome: applied ? "applied" as const : "replayed" as const });
          },
        ));
    },
    async projectAgentGroupPage(input) {
      return store.withLock(["agent-group-ref-binding", input.groupRef], async () =>
        store.withLock(
          ["agent-group-observation", input.sessionId, input.scopeIdentity],
          async (): Promise<HarnessAgentGroupPageProjectionResult> => {
            const garbageCollectionPath = agentGroupGarbageCollectionPath(rootDir, input.groupRef);
            const garbageCollection = await store.readJson<DurableAgentGroupGarbageCollection>(
              garbageCollectionPath,
            );
            let abandonsPreparedGarbageCollection = false;
            if (garbageCollection !== undefined) {
              validateDurableAgentGroupGarbageCollection(garbageCollection, {
                sessionId: input.sessionId,
                groupRef: input.groupRef,
                expectedAggregateVersion: garbageCollection.aggregateVersion,
                expectedGroupObservationDigest: garbageCollection.groupObservationDigest,
              });
              if (garbageCollection.sessionId !== input.sessionId ||
                  garbageCollection.scopeIdentity !== input.scopeIdentity ||
                  garbageCollection.state !== "prepared") {
                return Object.freeze({ outcome: "inconsistent" as const, records: Object.freeze([]) });
              }
              // A prepared collection has not crossed the deletion fence. A
              // later valid projection may abandon it atomically; every later
              // GC state is an irreversible restart-safe writer fence.
              abandonsPreparedGarbageCollection = true;
            }
            const recovered = await recoverDurableAgentGroupPageMirror(
              store,
              rootDir,
              input.sessionId,
              input.scopeIdentity,
            );
            if (recovered === undefined || recovered.state.groupRef !== input.groupRef ||
                recovered.state.scopeIdentity !== input.scopeIdentity) {
              return Object.freeze({ outcome: "inconsistent" as const, records: Object.freeze([]) });
            }
            let authority: DurableAgentGroupPageAuthority = recovered;
            const projectionResult = await withDurableAgentGroupResultRefLocks(
              store,
              input.changes.flatMap((change) =>
                change.kind === "group_control" || change.externalAgentResultRef === undefined
                  ? []
                  : [change.externalAgentResultRef]),
              async (): Promise<HarnessAgentGroupPageProjectionResult> => {
          for (const resultRef of new Set(input.changes.flatMap((change) =>
            change.kind === "group_control" || change.externalAgentResultRef === undefined
              ? []
              : [change.externalAgentResultRef]))) {
            await recoverDurableAgentGroupResultRefIntent(store, rootDir, resultRef);
          }
          const pageCall = await store.readJson<DurableAgentGroupPageCall>(
            agentGroupPageCallPath(
              rootDir,
              input.sessionId,
              input.scopeIdentity,
              input.pageCallIdentity,
            ),
          );
          if (pageCall === undefined) {
            return Object.freeze({ outcome: "inconsistent" as const, records: Object.freeze([]) });
          }
          validateDurableAgentGroupPageCall(
            pageCall,
            input.sessionId,
            input.scopeIdentity,
            input.groupRef,
            input.pageCallIdentity,
          );
          if (pageCall.result.requestIdempotencyKey !== input.requestIdempotencyKey ||
              pageCall.result.startSequence !== input.afterSequence) {
            return Object.freeze({ outcome: "inconsistent" as const, records: Object.freeze([]) });
          }
          const projectionDigest = stableHash(input);
          const receiptPath = agentGroupPageReceiptPath(
            rootDir,
            input.sessionId,
            input.scopeIdentity,
            input.requestIdempotencyKey,
          );
          const receipt = await store.readJson<DurableAgentGroupPageReceipt>(receiptPath);
          if (receipt !== undefined) {
            validateDurableAgentGroupPageReceipt(receipt, input.sessionId, input.scopeIdentity, input.groupRef);
            if (receipt.requestIdempotencyKey !== input.requestIdempotencyKey ||
                receipt.projectionDigest !== projectionDigest ||
                receipt.afterSequence !== input.afterSequence ||
                receipt.throughSequence !== input.throughSequence) {
              return Object.freeze({ outcome: "conflict" as const, records: Object.freeze([]) });
            }
            const marker = await readDurableAgentGroupPageCommitMarker(
              store,
              rootDir,
              input.sessionId,
              input.scopeIdentity,
              input.requestIdempotencyKey,
            );
            if (marker !== undefined && marker.identity.projectionDigest === projectionDigest &&
                marker.identity.afterSequence === input.afterSequence &&
                marker.identity.throughSequence === input.throughSequence) {
              return Object.freeze({ outcome: "replayed" as const, records: Object.freeze([]) });
            }
          }
          if (input.afterSequence < authority.state.aggregateVersion) {
            return Object.freeze({ outcome: "stale" as const, records: Object.freeze([]) });
          }
          if (input.afterSequence !== authority.state.aggregateVersion ||
              input.throughSequence !== input.afterSequence + input.changes.length ||
              input.aggregateVersion !== input.throughSequence ||
              !Number.isSafeInteger(input.aggregateVersion) || input.aggregateVersion < 0 ||
              !durableAgentGroupTransitionAllowed(authority.state.groupStatus, input.groupStatus) ||
              input.groupObservedAt < authority.state.groupObservedAt) {
            return Object.freeze({ outcome: "inconsistent" as const, records: Object.freeze([]) });
          }

          let projectedAggregate = authority.state.aggregate;
          let projectedGroupStatus = authority.state.groupStatus;
          let projectedGroupObservedAt = authority.state.groupObservedAt;
          let sawV2Control = false;
          let sawV2Member = false;
          let sawV2MemberProgress = false;
          const updatedMembers = new Map<number, DurableAgentGroupPageMember>();
          const sequenceRecords: DurableAgentGroupPageSequence[] = [];
          const resultRefOwners = new Map<string, DurableAgentGroupResultRefOwner>();
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
                  !durableAgentGroupTransitionAllowed(projectedGroupStatus, change.groupStatus)) {
                return Object.freeze({ outcome: "invalid_transition" as const, records: Object.freeze([]) });
              }
              projectedGroupStatus = change.groupStatus;
              projectedGroupObservedAt = change.groupObservedAt;
              sequenceRecords.push(Object.freeze({
                schemaVersion: "little-harness.agent-group-page-sequence.v1",
                sessionId: input.sessionId,
                scopeIdentity: input.scopeIdentity,
                groupRef: input.groupRef,
                sequence: change.sequence,
                requestIdempotencyKey: input.requestIdempotencyKey,
                pageDigest: input.pageDigest,
                kind: "group_control",
                groupStatus: change.groupStatus,
                groupObservedAt: change.groupObservedAt,
                controlDigest: change.controlDigest,
              }));
              continue;
            }
            if (change.kind === "member") {
              sawV2Member = true;
              sawV2MemberProgress ||= change.memberStatus !== "queued";
            }
            if (!Number.isSafeInteger(change.memberIndex) || change.memberIndex < 0 ||
                change.memberIndex >= authority.state.memberCount ||
                change.memberId !== `member_${change.memberIndex + 1}` ||
                agentTaskStatus(change.memberStatus) !== change.status ||
                change.verifiedSucceeded && change.memberStatus !== "succeeded" ||
                change.hasResultRef !== (change.externalAgentResultRef !== undefined) ||
                (change.externalAgentResultRef !== undefined &&
                  change.status !== "completed" && change.status !== "failed" &&
                  change.status !== "cancelled")) {
              return Object.freeze({ outcome: "inconsistent" as const, records: Object.freeze([]) });
            }
            const currentMember = updatedMembers.get(change.memberIndex) ??
              await readDurableAgentGroupPageMember(
                store,
                rootDir,
                input.sessionId,
                input.scopeIdentity,
                change.memberIndex,
              );
            if (currentMember === undefined || currentMember.groupRef !== input.groupRef ||
                currentMember.record.externalAgentTaskRef !== change.taskRef ||
                currentMember.record.agentMemberId !== change.memberId ||
                currentMember.record.agentMemberIndex !== change.memberIndex ||
                !Number.isSafeInteger(change.memberRevision) ||
                change.memberRevision <= (currentMember.record.agentMemberRevision ?? 0) ||
                !Number.isFinite(Date.parse(change.memberObservedAt)) ||
                change.memberObservedAt < (currentMember.record.agentMemberObservedAt ??
                  currentMember.record.createdAt) ||
                !durableAgentMemberTransitionAllowed(
                  currentMember.record.status,
                  change.status,
                  currentMember.record.agentMemberStateDigest,
                  change.memberStateDigest,
                )) {
              return Object.freeze({ outcome: "invalid_transition" as const, records: Object.freeze([]) });
            }
            const terminal = change.status === "completed" || change.status === "failed" ||
              change.status === "cancelled";
            const previousResultRef = currentMember.record.externalAgentResultRef;
            if (previousResultRef !== undefined && previousResultRef !== change.externalAgentResultRef) {
              return Object.freeze({ outcome: "invalid_transition" as const, records: Object.freeze([]) });
            }
            const reusesResultRef = previousResultRef !== undefined &&
              previousResultRef === change.externalAgentResultRef;
            const resultRefPublicationSequence = change.externalAgentResultRef === undefined
              ? undefined
              : reusesResultRef
                ? currentMember.resultRefPublicationSequence
                : change.sequence;
            const resultRefPublicationMemberRevision = change.externalAgentResultRef === undefined
              ? undefined
              : reusesResultRef
                ? currentMember.resultRefPublicationMemberRevision
                : change.memberRevision;
            const resultRefPublicationDigest = change.externalAgentResultRef === undefined
              ? undefined
              : reusesResultRef
                ? currentMember.resultRefPublicationDigest
                : stableHash({
                    pageDigest: input.pageDigest,
                    sequence: change.sequence,
                    memberObservationDigest: change.memberObservationDigest,
                    resultRef: change.externalAgentResultRef,
                  });
            if (change.externalAgentResultRef !== undefined) {
              if (resultRefPublicationSequence === undefined ||
                  resultRefPublicationMemberRevision === undefined ||
                  resultRefPublicationDigest === undefined) {
                return Object.freeze({ outcome: "inconsistent" as const, records: Object.freeze([]) });
              }
              const ownerBody = {
                sessionId: input.sessionId,
                scopeIdentity: input.scopeIdentity,
                groupRef: input.groupRef,
                memberId: change.memberId,
                memberIndex: change.memberIndex,
                memberRevision: resultRefPublicationMemberRevision,
                publicationSequence: resultRefPublicationSequence,
                publicationDigest: resultRefPublicationDigest,
                resultRef: change.externalAgentResultRef,
              };
              const owner = Object.freeze({
                schemaVersion: "little-harness.agent-group-result-ref-owner.v1" as const,
                ...ownerBody,
                ownerDigest: stableHash(ownerBody),
              });
              const existingOwner = resultRefOwners.get(change.externalAgentResultRef) ??
                await store.readJson<DurableAgentGroupResultRefOwner>(
                  agentGroupResultRefOwnerPath(rootDir, change.externalAgentResultRef),
                );
              if (existingOwner !== undefined &&
                  (!validDurableAgentGroupResultRefOwner(existingOwner) ||
                    existingOwner.ownerDigest !== owner.ownerDigest)) {
                return Object.freeze({ outcome: "conflict" as const, records: Object.freeze([]) });
              }
              resultRefOwners.set(change.externalAgentResultRef, owner);
            }
            const record = compact({
              ...currentMember.record,
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
              agentJoinReductionRevision: currentMember.record.agentJoinReductionRevision,
              agentJoinReductionDigest: currentMember.record.agentJoinReductionDigest,
            }) as HarnessTaskRecord;
            const accounting = Object.freeze({
              status: change.memberStatus,
              verifiedSucceeded: change.verifiedSucceeded,
              hasResultRef: change.hasResultRef,
            });
            projectedAggregate = applyAgentGroupMemberAccountingDelta(
              projectedAggregate,
              currentMember.accounting,
              accounting,
            );
            const member = Object.freeze({
              schemaVersion: "little-harness.agent-group-page-member.v1" as const,
              sessionId: input.sessionId,
              scopeIdentity: input.scopeIdentity,
              groupRef: input.groupRef,
              memberIndex: change.memberIndex,
              lastSequence: change.sequence,
              ...(resultRefPublicationDigest === undefined
                ? {}
                : {
                    resultRefPublicationSequence: resultRefPublicationSequence!,
                    resultRefPublicationMemberRevision: resultRefPublicationMemberRevision!,
                    resultRefPublicationDigest,
                  }),
              record,
              accounting,
            });
            updatedMembers.set(change.memberIndex, member);
            sequenceRecords.push(Object.freeze({
              schemaVersion: "little-harness.agent-group-page-sequence.v1",
              sessionId: input.sessionId,
              scopeIdentity: input.scopeIdentity,
              groupRef: input.groupRef,
              sequence: change.sequence,
              requestIdempotencyKey: input.requestIdempotencyKey,
              pageDigest: input.pageDigest,
              ...(change.kind === "member" ? { kind: "member" as const } : {}),
              member,
            }));
          }
          if (stableHash(projectedAggregate) !== stableHash(input.aggregate) ||
              input.changes.length === 0 &&
                (input.groupStatus !== authority.state.groupStatus ||
                  stableHash(input.aggregate) !== stableHash(authority.state.aggregate))) {
            return Object.freeze({ outcome: "conflict" as const, records: Object.freeze([]) });
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

          if (abandonsPreparedGarbageCollection && input.changes.length > 0) {
            await store.remove(garbageCollectionPath);
          }

          const sequenceDigests = Object.freeze(sequenceRecords.map((record) => stableHash(record)));
          const stageDigest = stableHash({
            domain: "little-harness.agent-group-page-stage.v1",
            sessionId: input.sessionId,
            scopeIdentity: input.scopeIdentity,
            groupRef: input.groupRef,
            requestIdempotencyKey: input.requestIdempotencyKey,
            pageCallIdentity: input.pageCallIdentity,
            projectionDigest,
            afterSequence: input.afterSequence,
            throughSequence: input.throughSequence,
            sequenceDigests,
          });
          const stageIntent = Object.freeze({
            schemaVersion: "little-harness.agent-group-page-stage-intent.v1" as const,
            sessionId: input.sessionId,
            scopeIdentity: input.scopeIdentity,
            groupRef: input.groupRef,
            requestIdempotencyKey: input.requestIdempotencyKey,
            pageCallIdentity: input.pageCallIdentity,
            projectionDigest,
            afterSequence: input.afterSequence,
            throughSequence: input.throughSequence,
            sequenceDigests,
            stageDigest,
          });
          await maybeInjectFault(faultInjection, "agent-group-page-projection-before-stage");
          await writeDurableJsonImmutable(
            store,
            agentGroupPageStageIntentPath(
              rootDir,
              input.sessionId,
              input.scopeIdentity,
              input.requestIdempotencyKey,
            ),
            stageIntent,
            "Agent Group page stage intent",
          );
          for (const [index, sequenceRecord] of sequenceRecords.entries()) {
            await writeDurableJsonImmutable(
              store,
              agentGroupPageStageSequencePath(
                rootDir,
                input.sessionId,
                input.scopeIdentity,
                input.requestIdempotencyKey,
                sequenceRecord.sequence,
              ),
              sequenceRecord,
              "Agent Group page staged sequence",
            );
            if (index === Math.floor(sequenceRecords.length / 2)) {
              await maybeInjectFault(faultInjection, "agent-group-page-projection-during-stage");
            }
          }
          await writeDurableJsonImmutable(
            store,
            agentGroupPageStageCompletePath(
              rootDir,
              input.sessionId,
              input.scopeIdentity,
              input.requestIdempotencyKey,
            ),
            {
              schemaVersion: "little-harness.agent-group-page-stage-complete.v1",
              sessionId: input.sessionId,
              scopeIdentity: input.scopeIdentity,
              groupRef: input.groupRef,
              requestIdempotencyKey: input.requestIdempotencyKey,
              stageDigest,
            } satisfies DurableAgentGroupPageStageComplete,
            "Agent Group page stage completion",
          );
          await maybeInjectFault(faultInjection, "agent-group-page-projection-after-stage");
          const lastCommit = Object.freeze({
            requestIdempotencyKey: input.requestIdempotencyKey,
            projectionDigest,
            afterSequence: input.afterSequence,
            throughSequence: input.throughSequence,
            stageDigest,
            commitDigest: stableHash({
              domain: "little-harness.agent-group-page-commit-chain.v1",
              previousCommitDigest: authority.lastCommit?.commitDigest ?? authority.startEnvelopeDigest,
              requestIdempotencyKey: input.requestIdempotencyKey,
              projectionDigest,
              afterSequence: input.afterSequence,
              throughSequence: input.throughSequence,
              stageDigest,
            }),
          });
          for (const [resultRef, owner] of resultRefOwners) {
            const existingOwner = await store.readJson<DurableAgentGroupResultRefOwner>(
              agentGroupResultRefOwnerPath(rootDir, resultRef),
            );
            if (existingOwner === undefined) {
              await writeDurableJsonImmutable(
                store,
                agentGroupResultRefIntentPath(rootDir, resultRef),
                {
                  schemaVersion: "little-harness.agent-group-result-ref-intent.v1",
                  owner,
                  requestIdempotencyKey: input.requestIdempotencyKey,
                  projectionDigest,
                  afterSequence: input.afterSequence,
                  throughSequence: input.throughSequence,
                  stageDigest,
                  commitDigest: lastCommit.commitDigest,
                } satisfies DurableAgentGroupResultRefIntent,
                "Agent Group result-reference publication intent",
              );
            }
          }
          await maybeInjectFault(faultInjection, "agent-group-page-projection-after-result-ref-intents");
          authority = Object.freeze({
            ...authority,
            state: Object.freeze({
              ...authority.state,
              aggregateVersion: input.aggregateVersion,
              groupStatus: input.groupStatus,
              aggregate: input.aggregate,
              groupObservationDigest: input.groupObservationDigest,
              groupObservedAt: input.groupObservedAt,
            }),
            lastCommit,
          });
          await store.writeJson(
            agentGroupPageAuthorityPath(rootDir, input.sessionId, input.scopeIdentity),
            authority,
          );
          await maybeInjectFault(faultInjection, "agent-group-page-projection-after-authority-commit");
          for (const [resultRef, owner] of resultRefOwners) {
            const path = agentGroupResultRefOwnerPath(rootDir, resultRef);
            const existing = await store.readJson<DurableAgentGroupResultRefOwner>(path);
            if (existing !== undefined &&
                (!validDurableAgentGroupResultRefOwner(existing) ||
                  existing.ownerDigest !== owner.ownerDigest)) {
              throw new HarnessInputError("Agent Group result-reference ownership changed after commit.");
            }
            if (existing === undefined) await store.writeJson(path, owner);
            await store.remove(agentGroupResultRefIntentPath(rootDir, resultRef));
          }
          return Object.freeze({
            outcome: "applied" as const,
            records: Object.freeze([...updatedMembers.values()].map((member) => member.record)),
          });
              },
            );
            if (projectionResult.outcome !== "applied") return projectionResult;
            const recoveredAuthority = await recoverDurableAgentGroupPageMirror(
              store,
              rootDir,
              input.sessionId,
              input.scopeIdentity,
            );
            if (recoveredAuthority === undefined) {
              throw new HarnessInputError("Agent Group page authority disappeared after commit.");
            }
            await drainDurableAgentGroupPageCallCleanup(store, rootDir, recoveredAuthority);
            await advanceDurableAgentGroupPageRetention(
              store,
              rootDir,
              input.sessionId,
              input.scopeIdentity,
            );
            return projectionResult;
          },
        ));
    },
    async collectAgentGroupGarbage(input) {
      return store.withLock(["agent-group-ref-binding", input.groupRef], async () => {
        const markerPath = agentGroupGarbageCollectionPath(rootDir, input.groupRef);
        let marker = await store.readJson<DurableAgentGroupGarbageCollection>(markerPath);
        if (marker !== undefined) {
          validateDurableAgentGroupGarbageCollection(marker, input);
          if (marker.sessionId !== input.sessionId) {
            return Object.freeze({ outcome: "conflict" as const });
          }
          if (marker.aggregateVersion !== input.expectedAggregateVersion ||
              marker.groupObservationDigest !== input.expectedGroupObservationDigest) {
            if (marker.state === "prepared") {
              const preparedMarker = marker;
              const current = await readDurableAgentGroupPageRefBinding(
                store,
                rootDir,
                preparedMarker.sessionId,
                preparedMarker.groupRef,
              );
              const authority = current === undefined
                ? undefined
                : await store.withLock(
                    ["agent-group-observation", preparedMarker.sessionId, preparedMarker.scopeIdentity],
                    async () => await recoverDurableAgentGroupPageMirror(
                      store,
                      rootDir,
                      preparedMarker.sessionId,
                      preparedMarker.scopeIdentity,
                    ),
                  );
              if (authority !== undefined &&
                  (authority.state.aggregateVersion !== preparedMarker.aggregateVersion ||
                    authority.state.groupObservationDigest !== preparedMarker.groupObservationDigest)) {
                await store.remove(markerPath);
              }
            }
            return Object.freeze({ outcome: "conflict" as const });
          }
          if (marker.state === "committed") {
            return Object.freeze({ outcome: "replayed" as const });
          }
        } else {
          const binding = await readDurableAgentGroupPageRefBinding(
            store,
            rootDir,
            input.sessionId,
            input.groupRef,
          );
          if (binding === undefined) return Object.freeze({ outcome: "inconsistent" as const });
          let preparationOutcome: "conflict" | "not_terminal" | "inconsistent" | undefined;
          marker = await store.withLock(
            ["agent-group-observation", input.sessionId, binding.scopeIdentity],
            async () => {
              const authority = await recoverDurableAgentGroupPageMirror(
                store,
                rootDir,
                input.sessionId,
                binding.scopeIdentity,
              );
              if (authority === undefined) {
                preparationOutcome = "inconsistent";
                return undefined;
              }
              if (authority.activeJoinBeginReservation !== undefined) {
                preparationOutcome = "conflict";
                return undefined;
              }
              if (authority.state.aggregateVersion !== input.expectedAggregateVersion ||
                  authority.state.groupObservationDigest !== input.expectedGroupObservationDigest) {
                preparationOutcome = "conflict";
                return undefined;
              }
              if (authority.state.groupStatus !== "satisfied" && authority.state.groupStatus !== "failed" &&
                  authority.state.groupStatus !== "cancelled") {
                preparationOutcome = "not_terminal";
                return undefined;
              }
              if (authority.state.launchCallIdentity === undefined) {
                preparationOutcome = "inconsistent";
                return undefined;
              }
              const members: Array<Readonly<{
                taskId: HarnessTaskId;
                callIdentity: string;
                memberId: string;
                memberIndex: number;
              }>> = [];
              const memberAuthorities: DurableAgentGroupPageMember[] = [];
              const expectedResultRefOwners: DurableAgentGroupResultRefOwner[] = [];
              for (let memberIndex = 0; memberIndex < authority.state.memberCount; memberIndex += 1) {
                const member = await readDurableAgentGroupPageMember(
                  store,
                  rootDir,
                  input.sessionId,
                  binding.scopeIdentity,
                  memberIndex,
                );
                if (member === undefined || member.record.callIdentity === undefined) {
                  preparationOutcome = "inconsistent";
                  return undefined;
                }
                memberAuthorities.push(member);
                members.push(Object.freeze({
                  taskId: member.record.taskId,
                  callIdentity: member.record.callIdentity,
                  memberId: `member_${memberIndex + 1}`,
                  memberIndex,
                }));
                const expectedOwner = durableAgentGroupResultRefOwnerFromMember(member);
                if (expectedOwner !== undefined) expectedResultRefOwners.push(expectedOwner);
              }
              expectedResultRefOwners.sort((left, right) =>
                left.resultRef < right.resultRef ? -1 : left.resultRef > right.resultRef ? 1 : 0);
              if (new Set(expectedResultRefOwners.map((owner) => owner.resultRef)).size !==
                  expectedResultRefOwners.length ||
                  stableHash(durableAgentGroupAggregateFromMembers(memberAuthorities)) !==
                    stableHash(authority.state.aggregate) ||
                  expectedResultRefOwners.length !== authority.state.aggregate.resultRefCount) {
                preparationOutcome = "inconsistent";
                return undefined;
              }
              const journal = await store.readJson<DurableAgentGroupTaskBatchJournal>(
                agentGroupTaskBatchJournalPath(
                  rootDir,
                  input.sessionId,
                  authority.state.launchCallIdentity,
                ),
              );
              if (journal === undefined) {
                preparationOutcome = "inconsistent";
                return undefined;
              }
              validateDurableAgentGroupTaskBatchJournal(
                journal,
                input.sessionId,
                authority.state.launchCallIdentity,
              );
              if (journal.scopeIdentity !== binding.scopeIdentity) {
                preparationOutcome = "inconsistent";
                return undefined;
              }
              const resultRefOwners = await withDurableAgentGroupResultRefLocks(
                store,
                expectedResultRefOwners.map((owner) => owner.resultRef),
                async () => {
                  const owners: DurableAgentGroupResultRefOwner[] = [];
                  for (const expectedOwner of expectedResultRefOwners) {
                    await recoverDurableAgentGroupResultRefIntent(store, rootDir, expectedOwner.resultRef);
                    const owner = await store.readJson<DurableAgentGroupResultRefOwner>(
                      agentGroupResultRefOwnerPath(rootDir, expectedOwner.resultRef),
                    );
                    if (owner === undefined || !validDurableAgentGroupResultRefOwner(owner) ||
                        owner.ownerDigest !== expectedOwner.ownerDigest) {
                      return undefined;
                    }
                    owners.push(owner);
                  }
                  return Object.freeze(owners);
                },
              );
              if (resultRefOwners === undefined) {
                preparationOutcome = "inconsistent";
                return undefined;
              }
              const prepared = Object.freeze({
                schemaVersion: "little-harness.agent-group-gc.v1" as const,
                state: "prepared" as const,
                sessionId: input.sessionId,
                scopeIdentity: binding.scopeIdentity,
                groupRef: input.groupRef,
                aggregateVersion: authority.state.aggregateVersion,
                groupObservationDigest: authority.state.groupObservationDigest,
                memberCount: authority.state.memberCount,
                membersDigest: stableHash(members),
                resultRefPublicationCount: resultRefOwners.length,
                resultRefPublicationsDigest: stableHash(
                  resultRefOwners.map(durableAgentGroupGcPublicationProjection),
                ),
                resultRefOwnersDigest: stableHash(resultRefOwners),
                members: Object.freeze(members),
                resultRefOwners,
                launchCallIdentity: authority.state.launchCallIdentity,
                launchCanonicalInputDigest: journal.canonicalInputDigest,
              } satisfies DurableAgentGroupGarbageCollection);
              await store.writeJson(markerPath, prepared);
              return prepared;
            },
          );
          if (marker === undefined) {
            return Object.freeze({ outcome: preparationOutcome ?? "inconsistent" as const });
          }
          await maybeInjectFault(faultInjection, "agent-group-gc-after-prepare");
        }
        if (marker.state === "prepared") {
          const preparedMarker = marker;
          const revalidated = await store.withLock(
            ["agent-group-observation", preparedMarker.sessionId, preparedMarker.scopeIdentity],
            async () => {
              const binding = await readDurableAgentGroupPageRefBinding(
                store,
                rootDir,
                preparedMarker.sessionId,
                preparedMarker.groupRef,
              );
              if (binding === undefined || binding.scopeIdentity !== preparedMarker.scopeIdentity) return false;
              const authority = await recoverDurableAgentGroupPageMirror(
                store,
                rootDir,
                preparedMarker.sessionId,
                preparedMarker.scopeIdentity,
              );
              if (authority?.activeJoinBeginReservation !== undefined) return false;
              const exact = authority !== undefined &&
                authority.state.aggregateVersion === preparedMarker.aggregateVersion &&
                authority.state.groupObservationDigest === preparedMarker.groupObservationDigest &&
                (authority.state.groupStatus === "satisfied" ||
                  authority.state.groupStatus === "failed" ||
                  authority.state.groupStatus === "cancelled");
              if (exact) {
                await validateDurableAgentGroupGcOwnerCompleteness(
                  store,
                  rootDir,
                  preparedMarker,
                );
              }
              return exact;
            },
          );
          if (!revalidated) {
            await store.remove(markerPath);
            return Object.freeze({ outcome: "conflict" as const });
          }
          marker = Object.freeze({ ...marker, state: "deleting" as const });
          await store.writeJson(markerPath, marker);
          await maybeInjectFault(faultInjection, "agent-group-gc-after-deleting-fence");
        }
        if (marker.state === "deleting") {
          if (marker.members === undefined || marker.resultRefOwners === undefined) {
            throw new HarnessInputError("Deleting Agent Group garbage-collection authority is incomplete.");
          }
          const deleting = marker;
          const existingBinding = await store.readJson<DurableAgentGroupPageRefBinding>(
            agentGroupPageRefPath(rootDir, deleting.groupRef),
          );
          if (existingBinding !== undefined &&
              (existingBinding.schemaVersion !== "little-harness.agent-group-page-ref.v1" ||
                existingBinding.sessionId !== deleting.sessionId ||
                existingBinding.scopeIdentity !== deleting.scopeIdentity ||
                existingBinding.groupRef !== deleting.groupRef)) {
            return Object.freeze({ outcome: "conflict" as const });
          }
          if (existingBinding !== undefined) {
            await validateDurableAgentGroupGcOwnerCompleteness(store, rootDir, deleting);
          }
          await store.withLock(
            ["agent-group-observation", deleting.sessionId, deleting.scopeIdentity],
            async () => {
              const journalPath = agentGroupTaskBatchJournalPath(
                rootDir,
                deleting.sessionId,
                deleting.launchCallIdentity,
              );
              const journal = await store.readJson<DurableAgentGroupTaskBatchJournal>(journalPath);
              if (journal !== undefined) {
                validateDurableAgentGroupTaskBatchJournal(
                  journal,
                  deleting.sessionId,
                  deleting.launchCallIdentity,
                );
                if (journal.scopeIdentity !== deleting.scopeIdentity ||
                    journal.canonicalInputDigest !== deleting.launchCanonicalInputDigest) {
                  throw new HarnessInputError("Agent Group GC batch-journal deletion binding is invalid.");
                }
              }
              await writeDurableJsonImmutable(
                store,
                agentGroupRetiredStartPath(rootDir, deleting.sessionId, deleting.launchCallIdentity),
                {
                  schemaVersion: "little-harness.agent-group-retired-start.v1",
                  sessionId: deleting.sessionId,
                  scopeIdentity: deleting.scopeIdentity,
                  groupRef: deleting.groupRef,
                  callIdentity: deleting.launchCallIdentity,
                  canonicalInputDigest: deleting.launchCanonicalInputDigest,
                } satisfies DurableAgentGroupRetiredStart,
                "Agent Group retired start receipt",
              );
              for (const [index, member] of deleting.members!.entries()) {
                const taskRecord = await store.readJson<HarnessTaskRecord>(
                  taskPath(rootDir, deleting.sessionId, member.taskId),
                );
                if (taskRecord !== undefined && (journal === undefined ||
                    !validAgentGroupLiveTaskRecord(taskRecord, journal, index) ||
                    !validDurableAgentGroupGcTaskRecord(taskRecord, deleting, member))) {
                  throw new HarnessInputError("Agent Group GC task deletion binding is invalid.");
                }
                const callBindingPath = callIdentityPath(
                  rootDir,
                  deleting.sessionId,
                  member.callIdentity,
                );
                const callBinding = await store.readJson<{ readonly taskId: HarnessTaskId }>(callBindingPath);
                if (callBinding !== undefined && callBinding.taskId !== member.taskId) {
                  throw new HarnessInputError("Agent Group GC call-identity deletion binding is invalid.");
                }
                if (taskRecord !== undefined) await store.remove(
                  taskPath(rootDir, deleting.sessionId, member.taskId),
                );
                if (callBinding !== undefined) await store.remove(callBindingPath);
                if (index === Math.floor(deleting.members!.length / 2)) {
                  await maybeInjectFault(faultInjection, "agent-group-gc-during-delete");
                }
              }
              if (journal !== undefined) {
                await store.remove(journalPath);
              }
              await removeDurableTree(store, agentGroupPageDir(
                rootDir,
                deleting.sessionId,
                deleting.scopeIdentity,
              ));
              if (existingBinding !== undefined) {
                await store.remove(agentGroupPageRefPath(rootDir, deleting.groupRef));
              }
            },
          );
          await maybeInjectFault(faultInjection, "agent-group-gc-after-delete");
          const { members: _deletedMembers, ...cleanupAuthority } = marker;
          marker = Object.freeze({ ...cleanupAuthority, state: "committed_cleanup" as const });
          await store.writeJson(markerPath, marker);
        }
        if (marker.state === "committed_cleanup") {
          if (marker.resultRefOwners === undefined) {
            throw new HarnessInputError("Agent Group GC owner-cleanup authority is incomplete.");
          }
          const cleanup = marker;
          const cleanupOwners = marker.resultRefOwners;
          await withDurableAgentGroupResultRefLocks(
            store,
            cleanupOwners.map((owner) => owner.resultRef),
            async () => {
              for (const [index, expectedOwner] of cleanupOwners.entries()) {
                const path = agentGroupResultRefOwnerPath(rootDir, expectedOwner.resultRef);
                const currentOwner = await store.readJson<DurableAgentGroupResultRefOwner>(path);
                if (currentOwner !== undefined && !validDurableAgentGroupResultRefOwner(currentOwner)) {
                  throw new HarnessInputError("Agent Group GC encountered malformed result-reference owner bytes.");
                }
                if (currentOwner !== undefined &&
                    currentOwner.ownerDigest !== expectedOwner.ownerDigest) {
                  // The old owner was already conditionally removed and the
                  // ref has since been reused. Never delete the replacement.
                  continue;
                }
                if (currentOwner !== undefined) await store.remove(path);
                if (index === Math.floor(cleanupOwners.length / 2)) {
                  await maybeInjectFault(faultInjection, "agent-group-gc-during-owner-cleanup");
                }
              }
            },
          );
          const { members: _members, resultRefOwners: _owners, ...compactReceipt } = cleanup;
          marker = Object.freeze({ ...compactReceipt, state: "committed" as const });
          await store.writeJson(markerPath, marker);
        }
        return Object.freeze({ outcome: "collected" as const });
      });
    },
    async markTerminal(input, terminal) {
      await store.withLock(["task-record", input.sessionId, input.taskId], async () => {
        const existing = await this.getTask(input);
        if (existing === undefined || isTerminal(existing.status)) {
          return;
        }
        assertGenericAgentTaskMutationAllowed(existing);
        const updated = compact({ ...existing, ...terminal }) as HarnessTaskRecord;
        await store.writeJson(taskPath(rootDir, updated.sessionId, updated.taskId), updated);
        if (updated.callIdentity !== undefined) {
          await this.bindTaskId({
            sessionId: updated.sessionId,
            callIdentity: updated.callIdentity,
            taskId: updated.taskId,
          });
        }
      });
    },
    async bindTaskId(input) {
      await store.writeJson(callIdentityPath(rootDir, input.sessionId, input.callIdentity), { taskId: input.taskId });
    },
    async taskIdForCallIdentity(input) {
      const binding = await store.readJson<{ readonly taskId: HarnessTaskId }>(callIdentityPath(rootDir, input.sessionId, input.callIdentity));
      return binding?.taskId;
    },
    async highWaterMark(sessionId) {
      return taskLedgerHighWaterMark(store, rootDir, sessionId);
    },
    async updateTaskTerminal(input) {
      return store.withLock(["task-record", input.sessionId, input.taskId], async () => {
        const existing = await this.getTask({ sessionId: input.sessionId, taskId: input.taskId });
        if (existing === undefined) {
          return undefined;
        }
        if (isTerminal(existing.status)) {
          return existing;
        }
        assertGenericAgentTaskMutationAllowed(existing);
        const updated = compact({
          ...existing,
          status: input.status,
          updatedAt: input.updatedAt ?? new Date().toISOString(),
          terminalCauseCode: input.terminalCauseCode,
          terminalMessage: input.terminalMessage,
          terminalDiagnostic: input.terminalDiagnostic,
          runId: input.runId ?? existing.runId,
          terminalResultId: input.terminalResultId,
          outputSummary: input.outputSummary,
          outputPath: input.outputPath,
          error: input.error,
        }) as HarnessTaskRecord;
        await store.writeJson(taskPath(rootDir, updated.sessionId, updated.taskId), updated);
        if (updated.callIdentity !== undefined) {
          await this.bindTaskId({
            sessionId: updated.sessionId,
            callIdentity: updated.callIdentity,
            taskId: updated.taskId,
          });
        }
        return updated;
      });
    },
    async cancelTask(input) {
      return store.withLock(["task-record", input.sessionId, input.taskId], async () => {
        const existing = await this.getTask(input);
        if (existing === undefined) {
          return undefined;
        }
        if (isTerminal(existing.status)) {
          return existing;
        }
        assertGenericAgentTaskMutationAllowed(existing);
        const updated = compact({
          ...existing,
          status: "cancelled" as const,
          updatedAt: new Date().toISOString(),
          terminalCauseCode: "cancelled" as const,
          terminalMessage: `Task ${input.taskId} cancelled.`,
          terminalDiagnostic: { cancelled: true, taskId: input.taskId },
        }) as HarnessTaskRecord;
        await store.writeJson(taskPath(rootDir, updated.sessionId, updated.taskId), updated);
        if (updated.callIdentity !== undefined) {
          await this.bindTaskId({
            sessionId: updated.sessionId,
            callIdentity: updated.callIdentity,
            taskId: updated.taskId,
          });
        }
        return updated;
      });
    },
  };
}

function mergeTaskUpdate(
  existing: HarnessTaskRecord | undefined,
  incoming: HarnessTaskRecord,
): HarnessTaskRecord {
  if (existing === undefined || !isTerminal(existing.status)) {
    return incoming;
  }
  return compact({
    ...incoming,
    ...existing,
    source: incoming.source ?? existing.source,
    purpose: incoming.purpose ?? existing.purpose,
    workflowId: incoming.workflowId ?? existing.workflowId,
    workflowHandle: incoming.workflowHandle ?? existing.workflowHandle,
    reservedRunId: incoming.reservedRunId ?? existing.reservedRunId,
    queueId: incoming.queueId ?? existing.queueId,
    callIdentity: incoming.callIdentity ?? existing.callIdentity,
    runId: incoming.runId ?? existing.runId,
  }) as HarnessTaskRecord;
}

async function writeAgentGroupProjectionAuthority(
  store: DurableJsonStore,
  rootDir: string,
  input: Readonly<{ sessionId: string; scopeIdentity: string }>,
  records: readonly HarnessTaskRecord[],
): Promise<void> {
  await store.writeJson(
    agentGroupProjectionAuthorityPath(rootDir, input.sessionId, input.scopeIdentity),
    {
      schemaVersion: "little-harness.agent-group-projection.v1",
      sessionId: input.sessionId,
      scopeIdentity: input.scopeIdentity,
      memberCount: records.length,
      records,
    } satisfies DurableAgentGroupProjectionAuthority,
  );
}

async function ensureDurableAgentGroupPageStartAuthority(
  store: DurableJsonStore,
  rootDir: string,
  input: HarnessAgentGroupStartBinding,
  records: readonly HarnessTaskRecord[],
): Promise<void> {
  const startEnvelopeDigest = durableAgentGroupPageStartEnvelopeDigest(input, records);
  const existing = await readDurableAgentGroupPageAuthority(
    store,
    rootDir,
    input.sessionId,
    input.scopeIdentity,
  );
  if (existing !== undefined) {
    if (existing.state.groupRef !== input.groupRef || existing.state.memberCount !== records.length ||
        existing.startEnvelopeDigest !== startEnvelopeDigest) {
      throw new HarnessInputError("Stored Agent Group page authority conflicts with atomic start.");
    }
    return;
  }
  const state = createAgentGroupPageStateFromBinding(input, records);
  if (state === undefined) {
    throw new HarnessInputError("Agent Group start cannot initialize its compact page authority.");
  }
  const existingBinding = await store.readJson<DurableAgentGroupPageRefBinding>(
    agentGroupPageRefPath(rootDir, input.groupRef),
  );
  if (existingBinding !== undefined &&
      (existingBinding.sessionId !== input.sessionId ||
        existingBinding.scopeIdentity !== input.scopeIdentity)) {
    throw new HarnessInputError("External Agent Group ref is already bound to another page authority.");
  }
  for (const [memberIndex, record] of records.entries()) {
    await writeDurableJsonImmutable(
      store,
      agentGroupPageMemberPath(rootDir, input.sessionId, input.scopeIdentity, memberIndex),
      {
        schemaVersion: "little-harness.agent-group-page-member.v1",
        sessionId: input.sessionId,
        scopeIdentity: input.scopeIdentity,
        groupRef: input.groupRef,
        memberIndex,
        lastSequence: 0,
        record,
        accounting: {
          status: "queued",
          verifiedSucceeded: false,
          hasResultRef: false,
        },
      } satisfies DurableAgentGroupPageMember,
      "Agent Group initial page member",
    );
  }
  await writeDurableJsonImmutable(store, agentGroupPageRefPath(rootDir, input.groupRef), {
    schemaVersion: "little-harness.agent-group-page-ref.v1",
    sessionId: input.sessionId,
    scopeIdentity: input.scopeIdentity,
    groupRef: input.groupRef,
  } satisfies DurableAgentGroupPageRefBinding, "Agent Group external page ref binding");
  await writeDurableJsonImmutable(store,
    agentGroupPageAuthorityPath(rootDir, input.sessionId, input.scopeIdentity), {
    schemaVersion: "little-harness.agent-group-page-authority.v1",
    state,
    startEnvelopeDigest,
    mirrorThroughSequence: 0,
    pageCallOrder: Object.freeze([]),
    expiredPageCallOrder: Object.freeze([]),
    pendingPageCallCleanup: Object.freeze([]),
    pageCallsIssued: 0,
  } satisfies DurableAgentGroupPageAuthority, "Agent Group initial page authority");
}

function durableAgentGroupPageStartEnvelopeDigest(
  input: HarnessAgentGroupStartBinding,
  records: readonly HarnessTaskRecord[],
): string {
  return stableHash({
    domain: "little-harness.agent-group-page-start-envelope.v1",
    sessionId: input.sessionId,
    scopeIdentity: input.scopeIdentity,
    groupRef: input.groupRef,
    acceptedAt: input.acceptedAt,
    launchCallIdentity: input.launchCallIdentity,
    members: input.members,
    policy: records.map((record) => ({
      taskId: record.taskId,
      memberId: record.agentMemberId,
      memberIndex: record.agentMemberIndex,
      taskRef: record.externalAgentTaskRef,
      joinPolicyHandle: record.agentJoinPolicyHandle,
      joinPolicyKind: record.agentJoinPolicyKind,
      joinQuorumCount: record.agentJoinQuorumCount,
      verifierHandle: record.agentVerifierHandle,
      requiredCheckSetHandle: record.agentRequiredCheckSetHandle,
      reductionPolicyHandle: record.agentReductionPolicyHandle,
      maxMemberSummaryBytes: record.agentMaxMemberSummaryBytes,
      maxGroupSummaryBytes: record.agentMaxGroupSummaryBytes,
      maxResultRefs: record.agentMaxResultRefs,
    })),
  });
}

function unbindDurableAgentGroupStartRecord(record: HarnessTaskRecord): HarnessTaskRecord {
  return compact({
    ...record,
    updatedAt: record.createdAt,
    externalAgentGroupRef: undefined,
    externalAgentTaskRef: undefined,
    agentLaunchAcceptedAt: undefined,
    agentGroupRevision: undefined,
    agentGroupStatus: undefined,
    agentGroupObservationDigest: undefined,
    agentGroupObservedAt: undefined,
    agentMemberRevision: undefined,
    agentMemberObservationDigest: undefined,
    agentMemberStateDigest: undefined,
    agentMemberObservedAt: undefined,
  }) as HarnessTaskRecord;
}

async function readDurableAgentGroupPageRefBinding(
  store: DurableJsonStore,
  rootDir: string,
  sessionId: string,
  groupRef: string,
): Promise<DurableAgentGroupPageRefBinding | undefined> {
  const binding = await store.readJson<DurableAgentGroupPageRefBinding>(
    agentGroupPageRefPath(rootDir, groupRef),
  );
  if (binding === undefined) return undefined;
  if (binding.schemaVersion !== "little-harness.agent-group-page-ref.v1" ||
      binding.groupRef !== groupRef || binding.sessionId !== sessionId ||
      binding.scopeIdentity.length === 0) {
    throw new HarnessInputError("Stored Agent Group page ref binding is invalid or belongs to another session.");
  }
  return binding;
}

function validateDurableAgentGroupGarbageCollection(
  marker: DurableAgentGroupGarbageCollection,
  input: {
    readonly sessionId: string;
    readonly groupRef: string;
    readonly expectedAggregateVersion: number;
    readonly expectedGroupObservationDigest: string;
  },
): void {
  const localDeletion = marker.state === "prepared" || marker.state === "deleting";
  if (marker.schemaVersion !== "little-harness.agent-group-gc.v1" ||
      (marker.state !== "prepared" && marker.state !== "deleting" &&
        marker.state !== "committed_cleanup" && marker.state !== "committed") ||
      marker.groupRef !== input.groupRef || marker.sessionId.length === 0 ||
      marker.scopeIdentity.length === 0 || !Number.isSafeInteger(marker.aggregateVersion) ||
      marker.aggregateVersion < 0 || marker.groupObservationDigest.length === 0 ||
      !Number.isSafeInteger(marker.memberCount) || marker.memberCount < 1 ||
      marker.membersDigest.length === 0 ||
      !Number.isSafeInteger(marker.resultRefPublicationCount) ||
      marker.resultRefPublicationCount < 0 || marker.resultRefPublicationsDigest.length === 0 ||
      marker.resultRefOwnersDigest.length === 0 ||
      marker.launchCallIdentity.length === 0 || marker.launchCanonicalInputDigest.length === 0 ||
      (localDeletion &&
        (!Array.isArray(marker.members) || marker.members.length !== marker.memberCount ||
          stableHash(marker.members) !== marker.membersDigest ||
          new Set(marker.members.map((member) => member.taskId)).size !== marker.members.length ||
          new Set(marker.members.map((member) => member.callIdentity)).size !== marker.members.length ||
          marker.members.some((member, index) =>
            !/^task_[1-9][0-9]*$/.test(member.taskId) ||
            typeof member.callIdentity !== "string" || member.callIdentity.length === 0 ||
            member.memberIndex !== index || member.memberId !== `member_${index + 1}`))) ||
      (!localDeletion && marker.members !== undefined) ||
      (marker.state !== "committed" &&
        (!Array.isArray(marker.resultRefOwners) ||
          marker.resultRefOwners.length !== marker.resultRefPublicationCount ||
          stableHash(marker.resultRefOwners.map(durableAgentGroupGcPublicationProjection)) !==
            marker.resultRefPublicationsDigest ||
          stableHash(marker.resultRefOwners) !== marker.resultRefOwnersDigest ||
          new Set(marker.resultRefOwners.map((owner) => owner.resultRef)).size !==
            marker.resultRefOwners.length ||
          new Set(marker.resultRefOwners.map((owner) => owner.memberIndex)).size !==
            marker.resultRefOwners.length ||
          marker.resultRefOwners.some((owner) =>
            !validDurableAgentGroupResultRefOwner(owner) ||
            owner.sessionId !== marker.sessionId || owner.scopeIdentity !== marker.scopeIdentity ||
            owner.groupRef !== marker.groupRef || owner.memberIndex >= marker.memberCount ||
            (marker.members !== undefined &&
              marker.members[owner.memberIndex]?.memberId !== owner.memberId)))) ||
      (marker.state === "committed" && marker.resultRefOwners !== undefined)) {
    throw new HarnessInputError("Stored Agent Group garbage-collection authority is invalid or conflicting.");
  }
}

function durableAgentGroupGcPublicationProjection(
  owner: DurableAgentGroupResultRefOwner,
): Record<string, unknown> {
  return {
    sessionId: owner.sessionId,
    scopeIdentity: owner.scopeIdentity,
    groupRef: owner.groupRef,
    memberId: owner.memberId,
    memberIndex: owner.memberIndex,
    memberRevision: owner.memberRevision,
    publicationSequence: owner.publicationSequence,
    publicationDigest: owner.publicationDigest,
    resultRef: owner.resultRef,
  };
}

function durableAgentGroupAggregateFromMembers(
  members: readonly DurableAgentGroupPageMember[],
): Readonly<Record<string, number>> {
  const aggregate = {
    memberCount: members.length,
    queuedCount: 0,
    runningCount: 0,
    succeededCount: 0,
    failedCount: 0,
    cancelledCount: 0,
    timedOutCount: 0,
    verifiedSucceededCount: 0,
    resultRefCount: 0,
  };
  for (const member of members) {
    if (member.accounting.status === "queued") aggregate.queuedCount += 1;
    else if (member.accounting.status === "running") aggregate.runningCount += 1;
    else if (member.accounting.status === "succeeded") aggregate.succeededCount += 1;
    else if (member.accounting.status === "failed") aggregate.failedCount += 1;
    else if (member.accounting.status === "cancelled") aggregate.cancelledCount += 1;
    else aggregate.timedOutCount += 1;
    if (member.accounting.verifiedSucceeded) aggregate.verifiedSucceededCount += 1;
    if (member.accounting.hasResultRef) aggregate.resultRefCount += 1;
  }
  return Object.freeze(aggregate);
}

async function validateDurableAgentGroupGcOwnerCompleteness(
  store: DurableJsonStore,
  rootDir: string,
  marker: DurableAgentGroupGarbageCollection,
): Promise<void> {
  if (marker.members === undefined || marker.resultRefOwners === undefined) {
    throw new HarnessInputError("Agent Group GC owner completeness authority is missing.");
  }
  const owners: DurableAgentGroupResultRefOwner[] = [];
  for (const [memberIndex, expectedMember] of marker.members.entries()) {
    const member = await readDurableAgentGroupPageMember(
      store,
      rootDir,
      marker.sessionId,
      marker.scopeIdentity,
      memberIndex,
    );
    if (member === undefined || member.record.taskId !== expectedMember.taskId ||
        member.record.callIdentity !== expectedMember.callIdentity ||
        member.record.agentMemberId !== expectedMember.memberId ||
        member.record.agentMemberIndex !== expectedMember.memberIndex) {
      throw new HarnessInputError("Agent Group GC member publication authority is incomplete.");
    }
    const owner = durableAgentGroupResultRefOwnerFromMember(member);
    if (owner !== undefined) owners.push(owner);
  }
  owners.sort((left, right) =>
    left.resultRef < right.resultRef ? -1 : left.resultRef > right.resultRef ? 1 : 0);
  if (new Set(owners.map((owner) => owner.resultRef)).size !== owners.length ||
      owners.length !== marker.resultRefPublicationCount ||
      stableHash(owners.map(durableAgentGroupGcPublicationProjection)) !==
        marker.resultRefPublicationsDigest ||
      stableHash(owners) !== marker.resultRefOwnersDigest ||
      stableHash(owners) !== stableHash(marker.resultRefOwners)) {
    throw new HarnessInputError("Agent Group GC result-reference owner set is incomplete or conflicting.");
  }
}

function validDurableAgentGroupGcTaskRecord(
  record: HarnessTaskRecord,
  marker: DurableAgentGroupGarbageCollection,
  member: NonNullable<DurableAgentGroupGarbageCollection["members"]>[number],
): boolean {
  return record.taskId === member.taskId && record.sessionId === marker.sessionId &&
    record.kind === "agent" && record.callIdentity === member.callIdentity &&
    record.agentGroupScopeIdentity === marker.scopeIdentity &&
    record.externalAgentGroupRef === marker.groupRef &&
    record.agentMemberId === member.memberId && record.agentMemberIndex === member.memberIndex;
}

function validateDurableAgentGroupRetiredStart(
  receipt: DurableAgentGroupRetiredStart,
  sessionId: string,
  callIdentity: string,
): void {
  if (receipt.schemaVersion !== "little-harness.agent-group-retired-start.v1" ||
      receipt.sessionId !== sessionId || receipt.callIdentity !== callIdentity ||
      receipt.scopeIdentity.length === 0 || receipt.groupRef.length === 0 ||
      receipt.canonicalInputDigest.length === 0) {
    throw new HarnessInputError("Stored Agent Group retired start receipt is invalid.");
  }
}

function validateDurableAgentGroupJoinBeginReservation(
  record: DurableAgentGroupJoinBeginReservation,
): void {
  if (record.schemaVersion !== "little-harness.agent-group-join-begin-reservation.v1" ||
      !validAgentGroupJoinBeginReservationInput(record.input) ||
      (record.phase !== "reserved" && record.phase !== "ref_bound" &&
        record.phase !== "pending" && record.phase !== "terminal") ||
      (record.phase === "reserved" && record.operationRef !== undefined) ||
      (record.phase !== "reserved" &&
        (record.operationRef === undefined || record.operationRef.length === 0))) {
    throw new HarnessInputError("Stored Agent Group join-begin reservation is invalid.");
  }
}

async function inferDurableAgentGroupJoinBeginReservation(
  store: DurableJsonStore,
  rootDir: string,
  input: HarnessAgentGroupJoinBeginReservation,
  state: HarnessAgentGroupPageState,
): Promise<Readonly<{
  phase: "reserved" | "ref_bound" | "pending" | "terminal";
  operationRef?: string;
  visible: boolean;
  conflict?: boolean;
}>> {
  const alias = await store.readJson<DurableAgentGroupOperationIdempotency>(
    agentGroupOperationIdempotencyPath(
      rootDir,
      input.sessionId,
      input.scopeIdentity,
      input.operationIdempotencyKey,
    ),
  );
  let operationRef = alias?.operationRef;
  if (alias !== undefined &&
      !validDurableAgentGroupBeginOperationIdempotency(alias, {
        sessionId: input.sessionId,
        scopeIdentity: input.scopeIdentity,
        groupRef: input.groupRef,
        operationIdempotencyKey: input.operationIdempotencyKey,
        operationRef: alias.operationRef,
        mutationInputDigest: input.mutationInputDigest,
      })) {
    return Object.freeze({ phase: "reserved" as const, visible: false, conflict: true });
  }
  if (operationRef === undefined) return Object.freeze({ phase: "reserved" as const, visible: false });
  const result = await store.readJson<DurableAgentGroupOperationResult>(
    agentGroupOperationResultPath(rootDir, input.sessionId, input.scopeIdentity, operationRef),
  );
  if (result !== undefined) {
    validateDurableAgentGroupOperationResult(
      result,
      input.sessionId,
      input.scopeIdentity,
      input.groupRef,
      operationRef,
      state,
    );
    if (result.input.operationMode !== "begin" ||
        result.input.operationIdempotencyKey !== input.operationIdempotencyKey ||
        result.input.mutationInputDigest !== input.mutationInputDigest) {
      return Object.freeze({ phase: "reserved" as const, visible: false, conflict: true });
    }
    const visibility = await store.readJson<DurableAgentGroupOperationVisibility>(
      agentGroupOperationVisibilityPath(rootDir, input.sessionId, input.scopeIdentity, operationRef),
    );
    if (visibility !== undefined &&
        (!validDurableAgentGroupOperationVisibility(
          visibility,
          input.sessionId,
          input.scopeIdentity,
          input.groupRef,
          operationRef,
        ) || visibility.resultDigest !== result.input.result.resultDigest ||
          visibility.resultVersion !== result.input.result.resultVersion)) {
      throw new HarnessInputError("Stored Agent Group operation visibility authority is invalid.");
    }
    return Object.freeze({
      phase: "terminal" as const,
      operationRef,
      visible: visibility !== undefined,
    });
  }
  const pending = await store.readJson<DurableAgentGroupPendingOperation>(
    agentGroupPendingOperationPath(rootDir, input.sessionId, input.scopeIdentity, operationRef),
  );
  if (pending !== undefined) {
    validateDurableAgentGroupPendingOperation(
      pending,
      input.sessionId,
      input.scopeIdentity,
      input.groupRef,
      operationRef,
      state,
    );
    if (pending.input.operationMode !== "begin" ||
        pending.input.operationIdempotencyKey !== input.operationIdempotencyKey ||
        pending.input.mutationInputDigest !== input.mutationInputDigest) {
      return Object.freeze({ phase: "reserved" as const, visible: false, conflict: true });
    }
  }
  return Object.freeze({
    phase: pending === undefined ? "ref_bound" as const : "pending" as const,
    operationRef,
    visible: false,
  });
}

function durableAgentGroupJoinBeginReservationFor(
  input: HarnessAgentGroupJoinBeginReservation,
  inferred: Readonly<{ phase: "reserved" | "ref_bound" | "pending" | "terminal"; operationRef?: string }>,
): DurableAgentGroupJoinBeginReservation {
  return Object.freeze({
    schemaVersion: "little-harness.agent-group-join-begin-reservation.v1" as const,
    input,
    phase: inferred.phase,
    ...(inferred.operationRef === undefined ? {} : { operationRef: inferred.operationRef }),
  });
}

async function advanceDurableAgentGroupJoinBeginReservation(
  store: DurableJsonStore,
  rootDir: string,
  authority: DurableAgentGroupPageAuthority,
  operationIdempotencyKey: string,
  operationRef: string,
  phase: "ref_bound" | "pending" | "terminal",
  bindingInput: HarnessAgentGroupPendingOperationBinding | HarnessAgentGroupOperationResultBinding | undefined,
  visibilityAuthorized: boolean,
): Promise<Readonly<{
  authority: DurableAgentGroupPageAuthority;
  outcome: "advanced" | "none" | "conflict";
}>> {
  const active = authority.activeJoinBeginReservation;
  if (active !== undefined && active.input.operationIdempotencyKey !== operationIdempotencyKey &&
      active.operationRef !== operationRef) {
    return Object.freeze({ authority, outcome: "none" as const });
  }
  const exactInput = bindingInput === undefined || bindingInput.operationMode !== "begin"
    ? undefined
    : agentGroupJoinBeginReservationInputFromBinding(bindingInput, operationIdempotencyKey);
  const record = active?.operationRef === operationRef ||
      active?.input.operationIdempotencyKey === operationIdempotencyKey
    ? active
    : undefined;
  if (record === undefined) return Object.freeze({ authority, outcome: "none" as const });
  if (exactInput !== undefined && stableHash(record.input) !== stableHash(exactInput)) {
    return Object.freeze({ authority, outcome: "conflict" as const });
  }
  if (record.operationRef !== undefined && record.operationRef !== operationRef) {
    return Object.freeze({ authority, outcome: "conflict" as const });
  }
  const effectivePhase = agentGroupJoinBeginReservationPhaseRank(record.phase) >=
      agentGroupJoinBeginReservationPhaseRank(phase)
    ? record.phase
    : phase;
  const updated = Object.freeze({
    ...record,
    phase: effectivePhase,
    operationRef,
  });
  const nextAuthority = { ...authority };
  if (effectivePhase === "terminal" && visibilityAuthorized) {
    if (active?.input.operationIdempotencyKey === updated.input.operationIdempotencyKey) {
      delete nextAuthority.activeJoinBeginReservation;
    }
  } else if (active === undefined ||
      active.input.operationIdempotencyKey === updated.input.operationIdempotencyKey) {
    nextAuthority.activeJoinBeginReservation = updated;
  }
  if (stableHash(nextAuthority) !== stableHash(authority)) {
    await store.writeJson(
      agentGroupPageAuthorityPath(
        rootDir,
        updated.input.sessionId,
        updated.input.scopeIdentity,
      ),
      nextAuthority,
    );
  }
  return Object.freeze({ authority: nextAuthority, outcome: "advanced" as const });
}

async function durableVisibleAgentGroupOperationResultFor(
  store: DurableJsonStore,
  rootDir: string,
  input: HarnessAgentGroupPendingOperationBinding | HarnessAgentGroupOperationResultBinding,
  state: HarnessAgentGroupPageState,
): Promise<boolean> {
  const operationRef = "pending" in input ? input.pending.operationRef : input.result.operationRef;
  const result = await store.readJson<DurableAgentGroupOperationResult>(
    agentGroupOperationResultPath(rootDir, input.sessionId, input.scopeIdentity, operationRef),
  );
  if (result === undefined) return false;
  validateDurableAgentGroupOperationResult(
    result,
    input.sessionId,
    input.scopeIdentity,
    input.groupRef,
    operationRef,
    state,
  );
  const visibility = await store.readJson<DurableAgentGroupOperationVisibility>(
    agentGroupOperationVisibilityPath(rootDir, input.sessionId, input.scopeIdentity, operationRef),
  );
  return visibility !== undefined && validDurableAgentGroupOperationVisibility(
    visibility,
    input.sessionId,
    input.scopeIdentity,
    input.groupRef,
    operationRef,
  ) && visibility.resultDigest === result.input.result.resultDigest &&
    visibility.resultVersion === result.input.result.resultVersion;
}

async function readDurableAgentGroupPageAuthority(
  store: DurableJsonStore,
  rootDir: string,
  sessionId: string,
  scopeIdentity: string,
): Promise<DurableAgentGroupPageAuthority | undefined> {
  const authority = await store.readJson<DurableAgentGroupPageAuthority>(
    agentGroupPageAuthorityPath(rootDir, sessionId, scopeIdentity),
  );
  if (authority === undefined) return undefined;
  const state = authority.state;
  const retainedCallIdentities = new Set(authority.pageCallOrder ?? []);
  if (authority.schemaVersion !== "little-harness.agent-group-page-authority.v1" ||
      state.sessionId !== sessionId || state.scopeIdentity !== scopeIdentity ||
      state.groupRef.length === 0 || authority.startEnvelopeDigest.length === 0 ||
      !validStoredAgentGroupStatus(state.groupStatus) ||
      !Number.isSafeInteger(state.memberCount) || state.memberCount < 1 ||
      !Number.isSafeInteger(state.aggregateVersion) || state.aggregateVersion < 0 ||
      !Number.isSafeInteger(state.minimumRetainedSequence) || state.minimumRetainedSequence < 0 ||
      state.minimumRetainedSequence > state.aggregateVersion ||
      !Number.isSafeInteger(state.acknowledgedSequence) || state.acknowledgedSequence < 0 ||
      state.acknowledgedSequence > state.aggregateVersion ||
      !Number.isSafeInteger(authority.mirrorThroughSequence) || authority.mirrorThroughSequence < 0 ||
      authority.mirrorThroughSequence > state.aggregateVersion ||
      (authority.pageCallsIssued !== undefined &&
        (!Number.isSafeInteger(authority.pageCallsIssued) || authority.pageCallsIssued < 0 ||
          authority.pageCallsIssued > HARNESS_AGENT_GROUP_MAX_LIFETIME_PAGE_CALLS ||
          authority.pageCallsIssued < (authority.pageCallOrder?.length ?? 0))) ||
      (authority.pageCallOrder !== undefined &&
        (!Array.isArray(authority.pageCallOrder) ||
          authority.pageCallOrder.length > HARNESS_AGENT_GROUP_PAGE_RETENTION ||
          new Set(authority.pageCallOrder).size !== authority.pageCallOrder.length ||
          authority.pageCallOrder.some((callIdentity) =>
            typeof callIdentity !== "string" || callIdentity.length === 0))) ||
      (authority.expiredPageCallOrder !== undefined &&
        (!Array.isArray(authority.expiredPageCallOrder) ||
          authority.expiredPageCallOrder.length > HARNESS_AGENT_GROUP_PAGE_RETENTION ||
          new Set(authority.expiredPageCallOrder).size !== authority.expiredPageCallOrder.length ||
          authority.expiredPageCallOrder.some((callIdentity) =>
            typeof callIdentity !== "string" || callIdentity.length === 0) ||
          authority.expiredPageCallOrder.some((callIdentity) =>
            retainedCallIdentities.has(callIdentity)))) ||
      (authority.pendingPageCallCleanup !== undefined &&
        (!Array.isArray(authority.pendingPageCallCleanup) ||
          authority.pendingPageCallCleanup.length > HARNESS_AGENT_GROUP_PAGE_RETENTION ||
          new Set(authority.pendingPageCallCleanup).size !== authority.pendingPageCallCleanup.length ||
          authority.pendingPageCallCleanup.some((callIdentity) =>
            typeof callIdentity !== "string" || callIdentity.length === 0 ||
            !authority.expiredPageCallOrder?.includes(callIdentity)))) ||
      (authority.activeJoinBeginReservation !== undefined &&
        (validateDurableAgentGroupJoinBeginReservation(authority.activeJoinBeginReservation),
          authority.activeJoinBeginReservation.input.sessionId !== sessionId ||
          authority.activeJoinBeginReservation.input.scopeIdentity !== scopeIdentity ||
          authority.activeJoinBeginReservation.input.groupRef !== state.groupRef)) ||
      state.aggregate.memberCount !== state.memberCount ||
      !validAgentGroupAggregate(state.aggregate) ||
      !Number.isFinite(Date.parse(state.launchAcceptedAt)) ||
      !Number.isFinite(Date.parse(state.groupObservedAt)) ||
      state.groupObservedAt < state.launchAcceptedAt ||
      state.groupObservationDigest.length === 0 ||
      authority.lastCommit !== undefined &&
        (authority.lastCommit.requestIdempotencyKey.length === 0 ||
          authority.lastCommit.projectionDigest.length === 0 ||
          authority.lastCommit.stageDigest.length === 0 ||
          authority.lastCommit.commitDigest.length === 0 ||
          !Number.isSafeInteger(authority.lastCommit.afterSequence) ||
          authority.lastCommit.afterSequence < 0 ||
          !Number.isSafeInteger(authority.lastCommit.throughSequence) ||
          authority.lastCommit.throughSequence < authority.lastCommit.afterSequence ||
          authority.lastCommit.throughSequence > state.aggregateVersion)) {
    throw new HarnessInputError("Stored Agent Group page authority is invalid.");
  }
  return authority;
}

function validateDurableAgentGroupPageCall(
  call: DurableAgentGroupPageCall,
  sessionId: string,
  scopeIdentity: string,
  groupRef: string,
  callIdentity: string,
): void {
  if (call.schemaVersion !== "little-harness.agent-group-page-call.v1" ||
      call.input.sessionId !== sessionId || call.input.scopeIdentity !== scopeIdentity ||
      call.input.groupRef !== groupRef || call.input.callIdentity !== callIdentity ||
      (call.input.operationKind !== "watch" && call.input.operationKind !== "join" &&
        call.input.operationKind !== "cancel") ||
      call.input.canonicalInputDigest.length === 0 || call.bindingDigest.length === 0 ||
      call.input.requestIdempotencyKey.length === 0 ||
      !Number.isSafeInteger(call.input.maximumChanges) || call.input.maximumChanges < 1 ||
      !Number.isSafeInteger(call.input.maximumBytes) || call.input.maximumBytes < 1 ||
      !Number.isSafeInteger(call.input.maximumCursorBytes) || call.input.maximumCursorBytes < 1 ||
      ((call.input.requestedAfterSequence === undefined) !==
        (call.input.pageCursorDigest === undefined)) ||
      (call.input.requestedAfterSequence !== undefined &&
        (!Number.isSafeInteger(call.input.requestedAfterSequence) ||
          call.input.requestedAfterSequence < 0)) ||
      (call.input.pageCursorDigest !== undefined && call.input.pageCursorDigest.length === 0) ||
      call.bindingDigest !== stableHash(call.input) || call.result.outcome !== "applied" ||
      call.result.requestIdempotencyKey !== call.input.requestIdempotencyKey ||
      !Number.isSafeInteger(call.result.startSequence) || call.result.startSequence < 0 ||
      !Number.isSafeInteger(call.result.currentHighWater) || call.result.currentHighWater < 0 ||
      !Number.isSafeInteger(call.result.minimumRetainedSequence) ||
      call.result.minimumRetainedSequence < 0 ||
      call.result.startSequence > call.result.currentHighWater ||
      call.result.minimumRetainedSequence > call.result.currentHighWater ||
      call.result.minimumRetainedSequence > call.result.startSequence) {
    throw new HarnessInputError("Stored Agent Group page-call binding is invalid.");
  }
}

function validateDurableAgentGroupRetiredPageCall(
  record: DurableAgentGroupRetiredPageCall,
  authority: DurableAgentGroupPageAuthority,
  callIdentity: string,
): void {
  if (record.schemaVersion !== "little-harness.agent-group-retired-page-call.v1" ||
      record.sessionId !== authority.state.sessionId ||
      record.scopeIdentity !== authority.state.scopeIdentity ||
      record.groupRef !== authority.state.groupRef ||
      record.callIdentityDigest !== stableHash(callIdentity)) {
    throw new HarnessInputError("Stored Agent Group retired page-call marker is invalid.");
  }
}

function validAgentGroupOperationResultBinding(
  input: HarnessAgentGroupOperationResultBinding,
  currentHighWater: number,
): boolean {
  const result = input.result;
  const body = {
    operationRef: result.operationRef,
    kind: result.kind,
    resultVersion: result.resultVersion,
    disposition: result.disposition,
    completedAt: result.completedAt,
    ...(result.summary === undefined ? {} : { summary: result.summary }),
    resultRefs: result.resultRefs,
  };
  return input.operationIdempotencyKey.length > 0 && input.mutationInputDigest.length > 0 &&
    (input.operationMode === "begin" || input.operationMode === "continue") &&
    (input.authorizeVisibility === undefined || typeof input.authorizeVisibility === "boolean") &&
    (result.kind === "join" || result.kind === "cancel") &&
    result.operationRef.length > 0 && Number.isSafeInteger(result.resultVersion) &&
    result.resultVersion >= 0 && (!input.authorizeVisibility || result.resultVersion <= currentHighWater) &&
    Number.isFinite(Date.parse(result.completedAt)) && result.resultDigest.length > 0 &&
    result.resultDigest === stableHash(body) && Array.isArray(result.resultRefs) &&
    new Set(result.resultRefs).size === result.resultRefs.length &&
    result.resultRefs.every((resultRef) => typeof resultRef === "string" && resultRef.length > 0) &&
    (result.kind === "join"
      ? result.disposition === "satisfied" || result.disposition === "deadline" ||
        result.disposition === "terminal"
      : (result.disposition === "cancelled" || result.disposition === "already_terminal") &&
        result.summary === undefined && result.resultRefs.length === 0);
}

function validAgentGroupPendingOperationBinding(
  input: HarnessAgentGroupPendingOperationBinding,
  state: HarnessAgentGroupPageState,
): boolean {
  const pending = input.pending;
  const body = {
    operationRef: pending.operationRef,
    observedAggregateVersion: pending.observedAggregateVersion,
    observedAt: pending.observedAt,
    retryAfterMs: pending.retryAfterMs,
  };
  return input.sessionId === state.sessionId && input.scopeIdentity === state.scopeIdentity &&
    input.groupRef === state.groupRef && input.operationIdempotencyKey.length > 0 &&
    input.mutationInputDigest.length > 0 &&
    (input.operationMode === "begin" || input.operationMode === "continue") &&
    pending.operationRef.length > 0 &&
    Number.isSafeInteger(pending.observedAggregateVersion) && pending.observedAggregateVersion >= 0 &&
    Number.isFinite(Date.parse(pending.observedAt)) && pending.observedAt >= state.launchAcceptedAt &&
    Number.isSafeInteger(pending.retryAfterMs) && pending.retryAfterMs >= 1 &&
    pending.retryAfterMs <= 60_000 && pending.pendingDigest.length > 0 &&
    pending.pendingDigest === stableHash(body);
}

function pendingOperationObservationReplayCompatible(
  existing: HarnessAgentGroupPendingOperationBinding["pending"],
  incoming: HarnessAgentGroupPendingOperationBinding["pending"],
): boolean {
  return existing.operationRef === incoming.operationRef &&
    incoming.observedAggregateVersion >= existing.observedAggregateVersion &&
    incoming.observedAt >= existing.observedAt;
}

function validateDurableAgentGroupOperationResult(
  record: DurableAgentGroupOperationResult,
  sessionId: string,
  scopeIdentity: string,
  groupRef: string,
  operationRef: string,
  state: HarnessAgentGroupPageState,
): void {
  if (record.schemaVersion !== "little-harness.agent-group-operation-result.v1" ||
      record.input.sessionId !== sessionId || record.input.scopeIdentity !== scopeIdentity ||
      record.input.groupRef !== groupRef || record.input.result.operationRef !== operationRef ||
      record.inputDigest.length === 0 || record.inputDigest !== stableHash(record.input) ||
      !validAgentGroupOperationResultBinding(record.input, Number.MAX_SAFE_INTEGER) ||
      record.input.result.completedAt < state.launchAcceptedAt ||
      record.input.result.resultRefs.length > state.agentMaxResultRefs ||
      (record.input.result.summary !== undefined &&
        Buffer.byteLength(record.input.result.summary, "utf8") > state.agentMaxGroupSummaryBytes)) {
    throw new HarnessInputError("Stored Agent Group operation-result authority is invalid.");
  }
}

function validateDurableAgentGroupPendingOperation(
  record: DurableAgentGroupPendingOperation,
  sessionId: string,
  scopeIdentity: string,
  groupRef: string,
  operationRef: string,
  state: HarnessAgentGroupPageState,
): void {
  if (record.schemaVersion !== "little-harness.agent-group-pending-operation.v1" ||
      record.inputDigest.length === 0 || record.inputDigest !== stableHash(record.input) ||
      record.input.sessionId !== sessionId || record.input.scopeIdentity !== scopeIdentity ||
      record.input.groupRef !== groupRef || record.input.pending.operationRef !== operationRef ||
      !validAgentGroupPendingOperationBinding(record.input, state)) {
    throw new HarnessInputError("Stored Agent Group pending-operation authority is invalid.");
  }
}

function validAgentGroupOperationVisibilityAuthorization(
  input: HarnessAgentGroupOperationResultBinding,
  state: HarnessAgentGroupPageState,
): boolean {
  const result = input.result;
  const terminal = state.groupStatus === "satisfied" || state.groupStatus === "failed" ||
    state.groupStatus === "cancelled" || state.groupStatus === "deadline";
  return result.completedAt >= state.launchAcceptedAt &&
    (result.summary === undefined || Buffer.byteLength(result.summary, "utf8") <=
      state.agentMaxGroupSummaryBytes) &&
    result.resultRefs.length <= state.agentMaxResultRefs &&
    result.resultRefs.length <= state.aggregate.resultRefCount &&
    result.resultRefs.every((resultRef) => resultRef.length > 0) &&
    (result.disposition === "satisfied"
      ? state.groupStatus === "satisfied"
      : result.disposition === "terminal"
        ? terminal && state.groupStatus !== "satisfied"
        : result.disposition === "deadline"
          ? true
          : result.disposition === "cancelled"
            ? state.groupStatus === "cancelled"
            : terminal);
}

function validDurableAgentGroupOperationIdempotency(
  record: DurableAgentGroupOperationIdempotency,
  input: HarnessAgentGroupOperationResultBinding,
): boolean {
  return record.schemaVersion === "little-harness.agent-group-operation-idempotency.v1" &&
    record.sessionId === input.sessionId && record.scopeIdentity === input.scopeIdentity &&
    record.groupRef === input.groupRef &&
    record.operationIdempotencyKey === input.operationIdempotencyKey &&
    record.operationRef.length > 0 && record.operationMode === input.operationMode &&
    record.mutationInputDigest === input.mutationInputDigest;
}

function durableAgentGroupBeginOperationIdempotency(
  input: AgentGroupJoinBeginOperationIdentity,
): DurableAgentGroupOperationIdempotency {
  return {
    schemaVersion: "little-harness.agent-group-operation-idempotency.v1",
    ...input,
    operationMode: "begin",
  };
}

function validDurableAgentGroupBeginOperationIdempotency(
  record: DurableAgentGroupOperationIdempotency,
  input: AgentGroupJoinBeginOperationIdentity,
): boolean {
  return record.schemaVersion === "little-harness.agent-group-operation-idempotency.v1" &&
    record.sessionId === input.sessionId && record.scopeIdentity === input.scopeIdentity &&
    record.groupRef === input.groupRef && record.operationIdempotencyKey === input.operationIdempotencyKey &&
    record.operationRef === input.operationRef && record.operationMode === "begin" &&
    record.mutationInputDigest === input.mutationInputDigest;
}

async function ensureDurableAgentGroupBeginAlias(
  store: DurableJsonStore,
  rootDir: string,
  input: AgentGroupJoinBeginOperationIdentity,
): Promise<"applied" | "replayed" | "conflict"> {
  const path = agentGroupOperationIdempotencyPath(
    rootDir,
    input.sessionId,
    input.scopeIdentity,
    input.operationIdempotencyKey,
  );
  const existing = await store.readJson<DurableAgentGroupOperationIdempotency>(path);
  if (existing !== undefined) {
    return validDurableAgentGroupBeginOperationIdempotency(existing, input)
      ? "replayed"
      : "conflict";
  }
  await store.writeJson(path, durableAgentGroupBeginOperationIdempotency(input));
  return "applied";
}

function validDurableAgentGroupOperationVisibility(
  record: DurableAgentGroupOperationVisibility,
  sessionId: string,
  scopeIdentity: string,
  groupRef: string,
  operationRef: string,
): boolean {
  return record.schemaVersion === "little-harness.agent-group-operation-visibility.v1" &&
    record.sessionId === sessionId && record.scopeIdentity === scopeIdentity &&
    record.groupRef === groupRef && record.operationRef === operationRef &&
    record.resultDigest.length > 0 && Number.isSafeInteger(record.resultVersion) &&
    record.resultVersion >= 0;
}

async function readDurableAgentGroupPageMember(
  store: DurableJsonStore,
  rootDir: string,
  sessionId: string,
  scopeIdentity: string,
  memberIndex: number,
): Promise<DurableAgentGroupPageMember | undefined> {
  const member = await store.readJson<DurableAgentGroupPageMember>(
    agentGroupPageMemberPath(rootDir, sessionId, scopeIdentity, memberIndex),
  );
  if (member === undefined) return undefined;
  if (!validDurableAgentGroupPageMember(member, sessionId, scopeIdentity, memberIndex)) {
    throw new HarnessInputError("Stored Agent Group page member is invalid.");
  }
  return member;
}

function validDurableAgentGroupPageMember(
  member: DurableAgentGroupPageMember,
  sessionId: string,
  scopeIdentity: string,
  memberIndex: number,
  groupRef?: string,
): boolean {
  const record = member.record;
  return member.schemaVersion === "little-harness.agent-group-page-member.v1" &&
    member.sessionId === sessionId && member.scopeIdentity === scopeIdentity &&
    Number.isSafeInteger(member.memberIndex) && member.memberIndex >= 0 &&
    member.memberIndex === memberIndex && (groupRef === undefined || member.groupRef === groupRef) &&
    member.groupRef.length > 0 && Number.isSafeInteger(member.lastSequence) && member.lastSequence >= 0 &&
    record.sessionId === sessionId && record.kind === "agent" && /^task_[1-9][0-9]*$/.test(record.taskId) &&
    record.agentGroupScopeIdentity === scopeIdentity && record.externalAgentGroupRef === member.groupRef &&
    record.agentMemberIndex === memberIndex && record.agentMemberId === `member_${memberIndex + 1}` &&
    record.externalAgentTaskRef !== undefined && record.externalAgentTaskRef.length > 0 &&
    Number.isFinite(Date.parse(record.createdAt)) && Number.isFinite(Date.parse(record.updatedAt)) &&
    Number.isSafeInteger(record.agentGroupRevision) && record.agentGroupRevision! >= 0 &&
    validStoredAgentGroupStatus(record.agentGroupStatus) &&
    typeof record.agentGroupObservationDigest === "string" && record.agentGroupObservationDigest.length > 0 &&
    Number.isFinite(Date.parse(record.agentGroupObservedAt!)) &&
    Number.isSafeInteger(record.agentMemberRevision) && record.agentMemberRevision! >= 0 &&
    typeof record.agentMemberObservationDigest === "string" && record.agentMemberObservationDigest.length > 0 &&
    typeof record.agentMemberStateDigest === "string" && record.agentMemberStateDigest.length > 0 &&
    Number.isFinite(Date.parse(record.agentMemberObservedAt!)) &&
    validStoredAgentMemberStatus(member.accounting.status) && validStoredTaskStatus(record.status) &&
    typeof member.accounting.verifiedSucceeded === "boolean" &&
    typeof member.accounting.hasResultRef === "boolean" &&
    agentTaskStatus(member.accounting.status) === record.status &&
    (!member.accounting.verifiedSucceeded || member.accounting.status === "succeeded") &&
    (record.externalAgentResultRef === undefined ||
      typeof record.externalAgentResultRef === "string" && record.externalAgentResultRef.length > 0) &&
    member.accounting.hasResultRef === (record.externalAgentResultRef !== undefined) &&
    (!member.accounting.hasResultRef || isTerminal(record.status)) &&
    (record.externalAgentResultRef === undefined
      ? member.resultRefPublicationSequence === undefined &&
        member.resultRefPublicationMemberRevision === undefined &&
        member.resultRefPublicationDigest === undefined
      : Number.isSafeInteger(member.resultRefPublicationSequence) &&
        member.resultRefPublicationSequence! >= 1 &&
        member.resultRefPublicationSequence! <= member.lastSequence &&
        Number.isSafeInteger(member.resultRefPublicationMemberRevision) &&
        member.resultRefPublicationMemberRevision! >= 1 &&
        member.resultRefPublicationMemberRevision! <= record.agentMemberRevision! &&
        member.resultRefPublicationDigest !== undefined &&
        member.resultRefPublicationDigest.length > 0) &&
    (isTerminal(record.status) ||
      record.terminalCauseCode === undefined && record.terminalMessage === undefined &&
      record.terminalDiagnostic === undefined) &&
    (record.terminalCauseCode === undefined || HARNESS_FAILURE_CAUSE_CODES.includes(record.terminalCauseCode));
}

function validStoredAgentMemberStatus(value: unknown): value is HarnessAgentMemberStatus {
  return value === "queued" || value === "running" || value === "succeeded" || value === "failed" ||
    value === "cancelled" || value === "timed_out";
}

function validStoredTaskStatus(value: unknown): value is HarnessTaskStatus {
  return value === "queued" || value === "running" || value === "completed" || value === "failed" ||
    value === "cancelled";
}

function validStoredAgentGroupStatus(value: unknown): value is NonNullable<HarnessTaskRecord["agentGroupStatus"]> {
  return value === "queued" || value === "running" || value === "satisfied" || value === "failed" ||
    value === "deadline" || value === "cancelled";
}

async function recoverDurableAgentGroupPageMirror(
  store: DurableJsonStore,
  rootDir: string,
  sessionId: string,
  scopeIdentity: string,
): Promise<DurableAgentGroupPageAuthority | undefined> {
  let authority = await readDurableAgentGroupPageAuthority(store, rootDir, sessionId, scopeIdentity);
  if (authority === undefined) return undefined;
  await finalizeDurableAgentGroupPageCommit(store, rootDir, authority);
  for (let sequence = authority.mirrorThroughSequence + 1;
    sequence <= authority.state.aggregateVersion;
    sequence += 1) {
    const change = await store.readJson<DurableAgentGroupPageSequence>(
      agentGroupPageSequencePath(rootDir, sessionId, scopeIdentity, sequence),
    );
    if (change === undefined || change.schemaVersion !== "little-harness.agent-group-page-sequence.v1" ||
        change.sessionId !== sessionId || change.scopeIdentity !== scopeIdentity ||
        change.groupRef !== authority.state.groupRef || change.sequence !== sequence) {
      throw new HarnessInputError("Committed Agent Group page sequence is missing or invalid.");
    }
    if (change.kind === "group_control") {
      if (!validStoredAgentGroupStatus(change.groupStatus) ||
          !Number.isFinite(Date.parse(change.groupObservedAt)) ||
          change.controlDigest !== stableHash({
            sequence: change.sequence,
            kind: change.kind,
            status: change.groupStatus,
            observedAt: change.groupObservedAt,
          })) {
        throw new HarnessInputError("Committed Agent Group control sequence is invalid.");
      }
      continue;
    }
    if (
        change.member.lastSequence !== sequence ||
        (change.member.record.externalAgentResultRef !== undefined &&
          change.member.resultRefPublicationSequence === change.sequence &&
          change.member.resultRefPublicationDigest !== stableHash({
            pageDigest: change.pageDigest,
            sequence: change.sequence,
            memberObservationDigest: change.member.record.agentMemberObservationDigest,
            resultRef: change.member.record.externalAgentResultRef,
          })) ||
        !validDurableAgentGroupPageMember(
          change.member,
          sessionId,
          scopeIdentity,
          change.member.memberIndex,
          authority.state.groupRef,
        )) {
      throw new HarnessInputError("Committed Agent Group page sequence is missing or invalid.");
    }
    await ensureDurableAgentGroupResultRefOwner(store, rootDir, change.member);
    await store.writeJson(
      taskPath(rootDir, sessionId, change.member.record.taskId),
      change.member.record,
    );
    await store.writeJson(
      agentGroupPageMemberPath(rootDir, sessionId, scopeIdentity, change.member.memberIndex),
      change.member,
    );
  }
  if (authority.mirrorThroughSequence !== authority.state.aggregateVersion) {
    authority = Object.freeze({
      ...authority,
      mirrorThroughSequence: authority.state.aggregateVersion,
    });
    await store.writeJson(agentGroupPageAuthorityPath(rootDir, sessionId, scopeIdentity), authority);
  }
  return authority;
}

async function ensureDurableAgentGroupResultRefOwner(
  store: DurableJsonStore,
  rootDir: string,
  member: DurableAgentGroupPageMember,
): Promise<void> {
  const owner = durableAgentGroupResultRefOwnerFromMember(member);
  if (owner === undefined) return;
  const resultRef = owner.resultRef;
  const path = agentGroupResultRefOwnerPath(rootDir, resultRef);
  let existing = await store.readJson<DurableAgentGroupResultRefOwner>(path);
  if (existing !== undefined &&
      (!validDurableAgentGroupResultRefOwner(existing) || existing.ownerDigest !== owner.ownerDigest)) {
    throw new HarnessInputError("Durable Agent Group result reference has conflicting ownership.");
  }
  if (existing !== undefined) return;
  await store.withLock(["agent-group-result-ref-owner", resultRef], async () => {
    await recoverDurableAgentGroupResultRefIntent(store, rootDir, resultRef);
    existing = await store.readJson<DurableAgentGroupResultRefOwner>(path);
    if (existing !== undefined &&
        (!validDurableAgentGroupResultRefOwner(existing) || existing.ownerDigest !== owner.ownerDigest)) {
      throw new HarnessInputError("Durable Agent Group result reference has conflicting ownership.");
    }
    if (existing === undefined) await store.writeJson(path, owner);
  });
}

function durableAgentGroupResultRefOwnerFromMember(
  member: DurableAgentGroupPageMember,
): DurableAgentGroupResultRefOwner | undefined {
  const resultRef = member.record.externalAgentResultRef;
  if (resultRef === undefined) return undefined;
  if (!isTerminal(member.record.status) || member.record.agentMemberId === undefined ||
      member.record.agentMemberIndex === undefined || member.record.agentMemberRevision === undefined ||
      member.resultRefPublicationSequence === undefined ||
      member.resultRefPublicationMemberRevision === undefined ||
      member.resultRefPublicationDigest === undefined || member.lastSequence < 1) {
    throw new HarnessInputError("Only a terminal durable Agent Group member may own a result reference.");
  }
  const ownerBody = {
    sessionId: member.sessionId,
    scopeIdentity: member.scopeIdentity,
    groupRef: member.groupRef,
    memberId: member.record.agentMemberId,
    memberIndex: member.record.agentMemberIndex,
    memberRevision: member.resultRefPublicationMemberRevision,
    publicationSequence: member.resultRefPublicationSequence,
    publicationDigest: member.resultRefPublicationDigest,
    resultRef,
  };
  const owner = Object.freeze({
    schemaVersion: "little-harness.agent-group-result-ref-owner.v1" as const,
    ...ownerBody,
    ownerDigest: stableHash(ownerBody),
  });
  return owner;
}

async function withDurableAgentGroupResultRefLocks<T>(
  store: DurableJsonStore,
  resultRefs: readonly string[],
  fn: () => Promise<T>,
): Promise<T> {
  const ordered = [...new Set(resultRefs)].sort();
  const acquire = async (index: number): Promise<T> => {
    const resultRef = ordered[index];
    if (resultRef === undefined) return await fn();
    return await store.withLock(
      ["agent-group-result-ref-owner", resultRef],
      async () => await acquire(index + 1),
    );
  };
  return await acquire(0);
}

async function recoverDurableAgentGroupResultRefIntent(
  store: DurableJsonStore,
  rootDir: string,
  resultRef: string,
): Promise<void> {
  const intentPath = agentGroupResultRefIntentPath(rootDir, resultRef);
  const intent = await store.readJson<DurableAgentGroupResultRefIntent>(intentPath);
  if (intent === undefined) return;
  validateDurableAgentGroupResultRefIntent(intent, resultRef);
  await proveDurableAgentGroupResultRefIntentSequence(store, rootDir, intent);
  const ownerPath = agentGroupResultRefOwnerPath(rootDir, resultRef);
  const existing = await store.readJson<DurableAgentGroupResultRefOwner>(ownerPath);
  if (existing !== undefined) {
    if (!validDurableAgentGroupResultRefOwner(existing) ||
        existing.ownerDigest !== intent.owner.ownerDigest) {
      throw new HarnessInputError("Prepared Agent Group result-reference intent conflicts with committed ownership.");
    }
    await store.remove(intentPath);
    return;
  }
  const authority = await readDurableAgentGroupPageAuthority(
    store,
    rootDir,
    intent.owner.sessionId,
    intent.owner.scopeIdentity,
  );
  const authorityCommitted = authority !== undefined &&
    authority.state.groupRef === intent.owner.groupRef &&
    authority.lastCommit?.requestIdempotencyKey === intent.requestIdempotencyKey &&
    authority.lastCommit.projectionDigest === intent.projectionDigest &&
    authority.lastCommit.afterSequence === intent.afterSequence &&
    authority.lastCommit.throughSequence === intent.throughSequence &&
    authority.lastCommit.stageDigest === intent.stageDigest &&
    authority.lastCommit.commitDigest === intent.commitDigest;
  const marker = authorityCommitted
    ? undefined
    : await readDurableAgentGroupPageCommitMarker(
        store,
        rootDir,
        intent.owner.sessionId,
        intent.owner.scopeIdentity,
        intent.requestIdempotencyKey,
      );
  const markerCommitted = marker !== undefined && marker.groupRef === intent.owner.groupRef &&
    marker.identity.projectionDigest === intent.projectionDigest &&
    marker.identity.afterSequence === intent.afterSequence &&
    marker.identity.throughSequence === intent.throughSequence &&
    marker.identity.stageDigest === intent.stageDigest &&
    marker.identity.commitDigest === intent.commitDigest;
  if (authorityCommitted || markerCommitted) {
    await store.writeJson(ownerPath, intent.owner);
  }
  await store.remove(intentPath);
}

async function proveDurableAgentGroupResultRefIntentSequence(
  store: DurableJsonStore,
  rootDir: string,
  intent: DurableAgentGroupResultRefIntent,
): Promise<void> {
  const owner = intent.owner;
  const committed = await store.readJson<DurableAgentGroupPageSequence>(
    agentGroupPageSequencePath(
      rootDir,
      owner.sessionId,
      owner.scopeIdentity,
      owner.publicationSequence,
    ),
  );
  const staged = await store.readJson<DurableAgentGroupPageSequence>(
    agentGroupPageStageSequencePath(
      rootDir,
      owner.sessionId,
      owner.scopeIdentity,
      intent.requestIdempotencyKey,
      owner.publicationSequence,
    ),
  );
  if (committed !== undefined && staged !== undefined &&
      stableHash(committed) !== stableHash(staged)) {
    throw new HarnessInputError("Agent Group result-reference intent sequence proofs conflict.");
  }
  const sequence = committed ?? staged;
  if (sequence === undefined ||
      sequence.schemaVersion !== "little-harness.agent-group-page-sequence.v1" ||
      sequence.sessionId !== owner.sessionId || sequence.scopeIdentity !== owner.scopeIdentity ||
      sequence.groupRef !== owner.groupRef || sequence.sequence !== owner.publicationSequence ||
      sequence.kind === "group_control" ||
      sequence.requestIdempotencyKey !== intent.requestIdempotencyKey ||
      sequence.sequence <= intent.afterSequence || sequence.sequence > intent.throughSequence ||
      !validDurableAgentGroupPageMember(
        sequence.member,
        owner.sessionId,
        owner.scopeIdentity,
        owner.memberIndex,
        owner.groupRef,
      ) || sequence.member.memberIndex !== owner.memberIndex ||
      sequence.member.record.agentMemberId !== owner.memberId ||
      sequence.member.record.agentMemberRevision !== owner.memberRevision ||
      sequence.member.resultRefPublicationSequence !== owner.publicationSequence ||
      sequence.member.resultRefPublicationMemberRevision !== owner.memberRevision ||
      sequence.member.resultRefPublicationDigest !== owner.publicationDigest ||
      sequence.member.record.externalAgentResultRef !== owner.resultRef ||
      owner.publicationDigest !== stableHash({
        pageDigest: sequence.pageDigest,
        sequence: sequence.sequence,
        memberObservationDigest: sequence.member.record.agentMemberObservationDigest,
        resultRef: owner.resultRef,
      }) || durableAgentGroupResultRefOwnerFromMember(sequence.member)?.ownerDigest !== owner.ownerDigest) {
    throw new HarnessInputError("Agent Group result-reference intent lacks its exact publication sequence proof.");
  }
}

function validateDurableAgentGroupResultRefIntent(
  intent: DurableAgentGroupResultRefIntent,
  resultRef: string,
): void {
  if (intent.schemaVersion !== "little-harness.agent-group-result-ref-intent.v1" ||
      !validDurableAgentGroupResultRefOwner(intent.owner) || intent.owner.resultRef !== resultRef ||
      intent.requestIdempotencyKey.length === 0 || intent.projectionDigest.length === 0 ||
      intent.stageDigest.length === 0 || intent.commitDigest.length === 0 ||
      !Number.isSafeInteger(intent.afterSequence) || intent.afterSequence < 0 ||
      !Number.isSafeInteger(intent.throughSequence) ||
      intent.throughSequence < intent.afterSequence ||
      intent.owner.publicationSequence <= intent.afterSequence ||
      intent.owner.publicationSequence > intent.throughSequence) {
    throw new HarnessInputError("Stored Agent Group result-reference publication intent is invalid.");
  }
}

function validDurableAgentGroupResultRefOwner(owner: DurableAgentGroupResultRefOwner): boolean {
  const body = {
    sessionId: owner.sessionId,
    scopeIdentity: owner.scopeIdentity,
    groupRef: owner.groupRef,
    memberId: owner.memberId,
    memberIndex: owner.memberIndex,
    memberRevision: owner.memberRevision,
    publicationSequence: owner.publicationSequence,
    publicationDigest: owner.publicationDigest,
    resultRef: owner.resultRef,
  };
  return owner.schemaVersion === "little-harness.agent-group-result-ref-owner.v1" &&
    owner.sessionId.length > 0 && owner.scopeIdentity.length > 0 && owner.groupRef.length > 0 &&
    Number.isSafeInteger(owner.memberIndex) && owner.memberIndex >= 0 &&
    owner.memberId === `member_${owner.memberIndex + 1}` &&
    Number.isSafeInteger(owner.memberRevision) && owner.memberRevision >= 1 &&
    Number.isSafeInteger(owner.publicationSequence) && owner.publicationSequence >= 1 &&
    owner.publicationDigest.length > 0 &&
    owner.resultRef.length > 0 && owner.ownerDigest === stableHash(body);
}

async function finalizeDurableAgentGroupPageCommit(
  store: DurableJsonStore,
  rootDir: string,
  authority: DurableAgentGroupPageAuthority,
): Promise<void> {
  const identity = authority.lastCommit;
  if (identity === undefined) return;
  const { sessionId, scopeIdentity, groupRef } = authority.state;
  const committed = await readDurableAgentGroupPageCommitMarker(
    store,
    rootDir,
    sessionId,
    scopeIdentity,
    identity.requestIdempotencyKey,
  );
  if (committed !== undefined) {
    if (committed.groupRef !== groupRef || stableHash(committed.identity) !== stableHash(identity)) {
      throw new HarnessInputError("Stored Agent Group page commit marker conflicts with authority.");
    }
    return;
  }
  const intent = await store.readJson<DurableAgentGroupPageStageIntent>(
    agentGroupPageStageIntentPath(
      rootDir,
      sessionId,
      scopeIdentity,
      identity.requestIdempotencyKey,
    ),
  );
  const complete = await store.readJson<DurableAgentGroupPageStageComplete>(
    agentGroupPageStageCompletePath(
      rootDir,
      sessionId,
      scopeIdentity,
      identity.requestIdempotencyKey,
    ),
  );
  if (intent === undefined || complete === undefined ||
      intent.schemaVersion !== "little-harness.agent-group-page-stage-intent.v1" ||
      complete.schemaVersion !== "little-harness.agent-group-page-stage-complete.v1" ||
      intent.sessionId !== sessionId || complete.sessionId !== sessionId ||
      intent.scopeIdentity !== scopeIdentity || complete.scopeIdentity !== scopeIdentity ||
      intent.groupRef !== groupRef || complete.groupRef !== groupRef ||
      intent.requestIdempotencyKey !== identity.requestIdempotencyKey ||
      complete.requestIdempotencyKey !== identity.requestIdempotencyKey ||
      intent.projectionDigest !== identity.projectionDigest ||
      intent.afterSequence !== identity.afterSequence ||
      intent.throughSequence !== identity.throughSequence ||
      intent.stageDigest !== identity.stageDigest || complete.stageDigest !== identity.stageDigest ||
      intent.sequenceDigests.length !== identity.throughSequence - identity.afterSequence) {
    throw new HarnessInputError("Committed Agent Group authority references an invalid page stage.");
  }
  for (let sequence = identity.afterSequence + 1; sequence <= identity.throughSequence; sequence += 1) {
    const staged = await store.readJson<DurableAgentGroupPageSequence>(
      agentGroupPageStageSequencePath(
        rootDir,
        sessionId,
        scopeIdentity,
        identity.requestIdempotencyKey,
        sequence,
      ),
    );
    if (staged === undefined || staged.schemaVersion !== "little-harness.agent-group-page-sequence.v1" ||
        staged.sessionId !== sessionId || staged.scopeIdentity !== scopeIdentity ||
        staged.groupRef !== groupRef || staged.sequence !== sequence ||
        staged.requestIdempotencyKey !== identity.requestIdempotencyKey ||
        stableHash(staged) !== intent.sequenceDigests[sequence - identity.afterSequence - 1]) {
      throw new HarnessInputError("Committed Agent Group page stage is missing an immutable sequence.");
    }
    if (staged.kind === "group_control") {
      if (!validStoredAgentGroupStatus(staged.groupStatus) ||
          !Number.isFinite(Date.parse(staged.groupObservedAt)) ||
          staged.controlDigest !== stableHash({
            sequence: staged.sequence,
            kind: staged.kind,
            status: staged.groupStatus,
            observedAt: staged.groupObservedAt,
          })) {
        throw new HarnessInputError("Committed Agent Group page stage has an invalid control sequence.");
      }
    } else if (staged.member.lastSequence !== sequence ||
        !validDurableAgentGroupPageMember(
          staged.member,
          sessionId,
          scopeIdentity,
          staged.member.memberIndex,
          groupRef,
        )) {
      throw new HarnessInputError("Committed Agent Group page stage has an invalid member sequence.");
    }
    await writeDurableJsonImmutable(
      store,
      agentGroupPageSequencePath(rootDir, sessionId, scopeIdentity, sequence),
      staged,
      "Agent Group committed sequence",
    );
  }
  const receipt = {
    schemaVersion: "little-harness.agent-group-page-receipt.v1" as const,
    sessionId,
    scopeIdentity,
    groupRef,
    requestIdempotencyKey: identity.requestIdempotencyKey,
    projectionDigest: identity.projectionDigest,
    afterSequence: identity.afterSequence,
    throughSequence: identity.throughSequence,
  } satisfies DurableAgentGroupPageReceipt;
  const receiptPath = agentGroupPageReceiptPath(
    rootDir,
    sessionId,
    scopeIdentity,
    identity.requestIdempotencyKey,
  );
  const existingReceipt = await store.readJson<DurableAgentGroupPageReceipt>(receiptPath);
  if (existingReceipt !== undefined && stableHash(existingReceipt) !== stableHash(receipt)) {
    throw new HarnessInputError("Stored Agent Group page receipt conflicts with committed authority.");
  }
  if (existingReceipt === undefined) await store.writeJson(receiptPath, receipt);
  const marker = {
    schemaVersion: "little-harness.agent-group-page-commit.v1" as const,
    sessionId,
    scopeIdentity,
    groupRef,
    identity,
  } satisfies DurableAgentGroupPageCommitMarker;
  const markerPath = agentGroupPageCommitPath(
    rootDir,
    sessionId,
    scopeIdentity,
    identity.requestIdempotencyKey,
  );
  const existingMarker = await store.readJson<DurableAgentGroupPageCommitMarker>(markerPath);
  if (existingMarker !== undefined && stableHash(existingMarker) !== stableHash(marker)) {
    throw new HarnessInputError("Stored Agent Group page commit marker conflicts with authority.");
  }
  if (existingMarker === undefined) await store.writeJson(markerPath, marker);
}

async function readDurableAgentGroupPageCommitMarker(
  store: DurableJsonStore,
  rootDir: string,
  sessionId: string,
  scopeIdentity: string,
  requestIdempotencyKey: string,
): Promise<DurableAgentGroupPageCommitMarker | undefined> {
  const marker = await store.readJson<DurableAgentGroupPageCommitMarker>(
    agentGroupPageCommitPath(rootDir, sessionId, scopeIdentity, requestIdempotencyKey),
  );
  if (marker === undefined) return undefined;
  if (marker.schemaVersion !== "little-harness.agent-group-page-commit.v1" ||
      marker.sessionId !== sessionId || marker.scopeIdentity !== scopeIdentity ||
      marker.identity.requestIdempotencyKey !== requestIdempotencyKey ||
      marker.groupRef.length === 0 || marker.identity.projectionDigest.length === 0 ||
      marker.identity.stageDigest.length === 0 ||
      marker.identity.commitDigest.length === 0 ||
      !Number.isSafeInteger(marker.identity.afterSequence) || marker.identity.afterSequence < 0 ||
      !Number.isSafeInteger(marker.identity.throughSequence) ||
      marker.identity.throughSequence < marker.identity.afterSequence) {
    throw new HarnessInputError("Stored Agent Group page commit marker is invalid.");
  }
  return marker;
}

function validateDurableAgentGroupPageReceipt(
  receipt: DurableAgentGroupPageReceipt,
  sessionId: string,
  scopeIdentity: string,
  groupRef: string,
): void {
  if (receipt.schemaVersion !== "little-harness.agent-group-page-receipt.v1" ||
      receipt.sessionId !== sessionId || receipt.scopeIdentity !== scopeIdentity ||
      receipt.groupRef !== groupRef || receipt.requestIdempotencyKey.length === 0 ||
      receipt.projectionDigest.length === 0 || !Number.isSafeInteger(receipt.afterSequence) ||
      receipt.afterSequence < 0 || !Number.isSafeInteger(receipt.throughSequence) ||
      receipt.throughSequence < receipt.afterSequence) {
    throw new HarnessInputError("Stored Agent Group page replay receipt is invalid.");
  }
}

async function retainDurableAgentGroupPageCall(
  store: DurableJsonStore,
  rootDir: string,
  authority: DurableAgentGroupPageAuthority,
  callIdentity: string,
): Promise<DurableAgentGroupPageAuthority> {
  let current = await drainDurableAgentGroupPageCallCleanup(store, rootDir, authority);
  if (current.pageCallOrder?.includes(callIdentity) === true ||
      current.expiredPageCallOrder?.includes(callIdentity) === true) {
    return current;
  }
  const pageCallOrder = [...(current.pageCallOrder ?? []), callIdentity];
  const activePageCallIdentity = current.activeJoinBeginReservation?.input.pageCallIdentity;
  const maxRetainedPageCalls = HARNESS_AGENT_GROUP_PAGE_RETENTION;
  const expiredCallIdentities: string[] = [];
  while (pageCallOrder.length > maxRetainedPageCalls) {
    const expiredIndex = pageCallOrder.findIndex((candidate) => candidate !== activePageCallIdentity);
    if (expiredIndex < 0) break;
    expiredCallIdentities.push(pageCallOrder.splice(expiredIndex, 1)[0]!);
  }
  const expiredPageCallOrder = [
    ...(current.expiredPageCallOrder ?? []),
    ...expiredCallIdentities,
  ];
  expiredPageCallOrder.splice(
    0,
    Math.max(0, expiredPageCallOrder.length - HARNESS_AGENT_GROUP_PAGE_RETENTION),
  );
  for (const expiredCallIdentity of expiredCallIdentities) {
    const callIdentityDigest = stableHash(expiredCallIdentity);
    await writeDurableJsonImmutable(
      store,
      agentGroupRetiredPageCallPath(
        rootDir,
        current.state.sessionId,
        current.state.scopeIdentity,
        expiredCallIdentity,
      ),
      {
        schemaVersion: "little-harness.agent-group-retired-page-call.v1",
        sessionId: current.state.sessionId,
        scopeIdentity: current.state.scopeIdentity,
        groupRef: current.state.groupRef,
        callIdentityDigest,
      } satisfies DurableAgentGroupRetiredPageCall,
      "Agent Group retired page-call marker",
    );
  }
  const retained = Object.freeze({
    ...current,
    pageCallOrder: Object.freeze(pageCallOrder),
    expiredPageCallOrder: Object.freeze(expiredPageCallOrder),
    pendingPageCallCleanup: Object.freeze([
      ...new Set([...(current.pendingPageCallCleanup ?? []), ...expiredCallIdentities]),
    ]),
    pageCallsIssued: (current.pageCallsIssued ?? 0) + 1,
  });
  // Publish the tombstone/order authority before deleting replay bytes. A
  // crash may leave harmless extra history, never a missing call that can be
  // silently rebound as new.
  await store.writeJson(
    agentGroupPageAuthorityPath(rootDir, current.state.sessionId, current.state.scopeIdentity),
    retained,
  );
  current = retained;
  return await drainDurableAgentGroupPageCallCleanup(store, rootDir, current);
}

async function drainDurableAgentGroupPageCallCleanup(
  store: DurableJsonStore,
  rootDir: string,
  authority: DurableAgentGroupPageAuthority,
): Promise<DurableAgentGroupPageAuthority> {
  const pending = authority.pendingPageCallCleanup ?? [];
  if (pending.length === 0) return authority;
  const remaining: string[] = [];
  for (const expiredCallIdentity of pending) {
    if (!await removeDurableAgentGroupPageCallHistory(
      store,
      rootDir,
      authority.state.sessionId,
      authority.state.scopeIdentity,
      expiredCallIdentity,
      authority.lastCommit?.requestIdempotencyKey,
    )) {
      remaining.push(expiredCallIdentity);
    }
  }
  const drained = Object.freeze({ ...authority, pendingPageCallCleanup: Object.freeze(remaining) });
  await store.writeJson(
    agentGroupPageAuthorityPath(rootDir, authority.state.sessionId, authority.state.scopeIdentity),
    drained,
  );
  return drained;
}

async function removeDurableAgentGroupPageCallHistory(
  store: DurableJsonStore,
  rootDir: string,
  sessionId: string,
  scopeIdentity: string,
  callIdentity: string,
  protectedRequestIdempotencyKey: string | undefined,
): Promise<boolean> {
  const callPath = agentGroupPageCallPath(rootDir, sessionId, scopeIdentity, callIdentity);
  const call = await store.readJson<DurableAgentGroupPageCall>(callPath);
  if (call === undefined) return true;
  validateDurableAgentGroupPageCall(
    call,
    sessionId,
    scopeIdentity,
    call.input.groupRef,
    callIdentity,
  );
  const requestIdempotencyKey = call.result.requestIdempotencyKey;
  if (requestIdempotencyKey === protectedRequestIdempotencyKey) {
    return false;
  }
  const receiptPath = agentGroupPageReceiptPath(
    rootDir,
    sessionId,
    scopeIdentity,
    requestIdempotencyKey,
  );
  const receipt = await store.readJson<DurableAgentGroupPageReceipt>(receiptPath);
  if (receipt === undefined) {
    await store.remove(callPath);
    return true;
  }
  validateDurableAgentGroupPageReceipt(
    receipt,
    sessionId,
    scopeIdentity,
    call.input.groupRef,
  );
  for (let sequence = receipt.afterSequence + 1; sequence <= receipt.throughSequence; sequence += 1) {
    await store.remove(agentGroupPageStageSequencePath(
      rootDir,
      sessionId,
      scopeIdentity,
      requestIdempotencyKey,
      sequence,
    ));
  }
  await Promise.all([
    store.remove(receiptPath),
    store.remove(agentGroupPageCommitPath(rootDir, sessionId, scopeIdentity, requestIdempotencyKey)),
    store.remove(agentGroupPageStageIntentPath(rootDir, sessionId, scopeIdentity, requestIdempotencyKey)),
    store.remove(agentGroupPageStageCompletePath(rootDir, sessionId, scopeIdentity, requestIdempotencyKey)),
  ]);
  await store.remove(callPath);
  return true;
}

async function advanceDurableAgentGroupPageRetention(
  store: DurableJsonStore,
  rootDir: string,
  sessionId: string,
  scopeIdentity: string,
): Promise<void> {
  const authority = await readDurableAgentGroupPageAuthority(store, rootDir, sessionId, scopeIdentity);
  if (authority === undefined || authority.mirrorThroughSequence !== authority.state.aggregateVersion) {
    throw new HarnessInputError("Agent Group replay history cannot advance ahead of its durable member mirror.");
  }
  const minimumRetainedSequence = Math.max(
    authority.state.minimumRetainedSequence,
    authority.state.aggregateVersion - HARNESS_AGENT_GROUP_PAGE_RETENTION,
  );
  if (minimumRetainedSequence === authority.state.minimumRetainedSequence) return;
  await store.writeJson(
    agentGroupPageAuthorityPath(rootDir, sessionId, scopeIdentity),
    Object.freeze({
      ...authority,
      state: Object.freeze({ ...authority.state, minimumRetainedSequence }),
    }),
  );
  for (let sequence = authority.state.minimumRetainedSequence + 1;
    sequence <= minimumRetainedSequence;
    sequence += 1) {
    await store.remove(agentGroupPageSequencePath(rootDir, sessionId, scopeIdentity, sequence));
  }
}

function validAgentGroupAggregate(aggregate: HarnessAgentGroupPageState["aggregate"]): boolean {
  const counts = [
    aggregate.memberCount,
    aggregate.queuedCount,
    aggregate.runningCount,
    aggregate.succeededCount,
    aggregate.failedCount,
    aggregate.cancelledCount,
    aggregate.timedOutCount,
    aggregate.verifiedSucceededCount,
    aggregate.resultRefCount,
  ];
  return counts.every((count) => Number.isSafeInteger(count) && count >= 0) &&
    aggregate.queuedCount + aggregate.runningCount + aggregate.succeededCount +
      aggregate.failedCount + aggregate.cancelledCount + aggregate.timedOutCount ===
      aggregate.memberCount &&
    aggregate.verifiedSucceededCount <= aggregate.succeededCount &&
    aggregate.resultRefCount <= aggregate.memberCount;
}

function durableAgentGroupTransitionAllowed(
  from: NonNullable<HarnessTaskRecord["agentGroupStatus"]>,
  to: NonNullable<HarnessTaskRecord["agentGroupStatus"]>,
): boolean {
  if (from === "queued") return true;
  if (from === "running") return to !== "queued";
  if (from === "satisfied") return to === "satisfied";
  if (from === "deadline") return to === "deadline" || to === "cancelled";
  return to === from;
}

function durableAgentMemberTransitionAllowed(
  from: HarnessTaskStatus,
  to: HarnessTaskStatus,
  currentStateDigest: string | undefined,
  incomingStateDigest: string,
): boolean {
  if (from === "queued") return true;
  if (from === "running") return to !== "queued";
  return to === from && currentStateDigest === incomingStateDigest;
}

async function overlayAgentGroupProjectionAuthorities(
  store: DurableJsonStore,
  rootDir: string,
  records: readonly HarnessTaskRecord[],
): Promise<HarnessTaskRecord[]> {
  const authorities = new Map<string, Promise<DurableAgentGroupProjectionAuthority | undefined>>();
  const pageAuthorities = new Map<string, Promise<DurableAgentGroupPageAuthority | undefined>>();
  return await Promise.all(records.map(async (record) => {
    const scopeIdentity = record.agentGroupScopeIdentity;
    if (record.kind !== "agent" || scopeIdentity === undefined) return record;
    const cacheKey = `${record.sessionId}\u0000${scopeIdentity}`;
    let pageAuthority = pageAuthorities.get(cacheKey);
    if (pageAuthority === undefined) {
      pageAuthority = readDurableAgentGroupPageAuthority(store, rootDir, record.sessionId, scopeIdentity);
      pageAuthorities.set(cacheKey, pageAuthority);
    }
    const paged = await pageAuthority;
    if (paged !== undefined) {
      return await overlayTaskFromAgentGroupPageAuthority(store, rootDir, record, paged);
    }
    let authority = authorities.get(cacheKey);
    if (authority === undefined) {
      authority = readAgentGroupProjectionAuthority(store, rootDir, record.sessionId, scopeIdentity);
      authorities.set(cacheKey, authority);
    }
    return overlayTaskFromAgentGroupAuthority(record, await authority);
  }));
}

async function overlayAgentGroupProjectionAuthority(
  store: DurableJsonStore,
  rootDir: string,
  record: HarnessTaskRecord,
): Promise<HarnessTaskRecord> {
  const scopeIdentity = record.agentGroupScopeIdentity;
  if (record.kind !== "agent" || scopeIdentity === undefined) return record;
  const paged = await readDurableAgentGroupPageAuthority(store, rootDir, record.sessionId, scopeIdentity);
  if (paged !== undefined) {
    return await overlayTaskFromAgentGroupPageAuthority(store, rootDir, record, paged);
  }
  return overlayTaskFromAgentGroupAuthority(
    record,
    await readAgentGroupProjectionAuthority(store, rootDir, record.sessionId, scopeIdentity),
  );
}

async function overlayTaskFromAgentGroupPageAuthority(
  store: DurableJsonStore,
  rootDir: string,
  record: HarnessTaskRecord,
  authority: DurableAgentGroupPageAuthority,
): Promise<HarnessTaskRecord> {
  const scopeIdentity = record.agentGroupScopeIdentity;
  const memberIndex = record.agentMemberIndex;
  if (scopeIdentity === undefined || memberIndex === undefined) return record;
  let member = await readDurableAgentGroupPageMember(
    store,
    rootDir,
    record.sessionId,
    scopeIdentity,
    memberIndex,
  );
  if (member === undefined || member.groupRef !== authority.state.groupRef) {
    throw new HarnessInputError("Stored Agent Group page authority is incomplete.");
  }
  // A committed authority may be ahead of mirrors after response loss. Read
  // only its deterministic sequence interval; no directory/member scan.
  if (authority.mirrorThroughSequence < authority.state.aggregateVersion) {
    for (let sequence = authority.mirrorThroughSequence + 1;
      sequence <= authority.state.aggregateVersion;
      sequence += 1) {
      const change = await store.readJson<DurableAgentGroupPageSequence>(
        agentGroupPageSequencePath(rootDir, record.sessionId, scopeIdentity, sequence),
      );
      if (change === undefined || change.sequence !== sequence ||
          change.groupRef !== authority.state.groupRef) {
        throw new HarnessInputError("Committed Agent Group page sequence is missing or invalid.");
      }
      if (change.kind === "group_control") continue;
      if (change.member.memberIndex === memberIndex) member = change.member;
    }
  }
  const projected = member.record;
  return compact({
    ...record,
    externalAgentGroupRef: projected.externalAgentGroupRef,
    externalAgentTaskRef: projected.externalAgentTaskRef,
    agentLaunchAcceptedAt: projected.agentLaunchAcceptedAt,
    status: projected.status,
    updatedAt: projected.updatedAt,
    outputSummary: projected.outputSummary,
    externalAgentResultRef: projected.externalAgentResultRef,
    error: projected.error,
    terminalCauseCode: projected.terminalCauseCode,
    terminalMessage: projected.terminalMessage,
    terminalDiagnostic: projected.terminalDiagnostic,
    agentGroupRevision: authority.state.aggregateVersion,
    agentGroupStatus: authority.state.groupStatus,
    agentGroupObservationDigest: authority.state.groupObservationDigest,
    agentGroupObservedAt: authority.state.groupObservedAt,
    agentMemberRevision: projected.agentMemberRevision,
    agentMemberObservationDigest: projected.agentMemberObservationDigest,
    agentMemberStateDigest: projected.agentMemberStateDigest,
    agentMemberObservedAt: projected.agentMemberObservedAt,
    agentJoinReductionRevision: projected.agentJoinReductionRevision,
    agentJoinReductionDigest: projected.agentJoinReductionDigest,
  }) as HarnessTaskRecord;
}

async function readAgentGroupProjectionAuthority(
  store: DurableJsonStore,
  rootDir: string,
  sessionId: string,
  scopeIdentity: string,
): Promise<DurableAgentGroupProjectionAuthority | undefined> {
  const authority = await store.readJson<DurableAgentGroupProjectionAuthority>(
    agentGroupProjectionAuthorityPath(rootDir, sessionId, scopeIdentity),
  );
  if (authority === undefined) return undefined;
  if (authority.schemaVersion !== "little-harness.agent-group-projection.v1" ||
      authority.sessionId !== sessionId || authority.scopeIdentity !== scopeIdentity ||
      !Number.isSafeInteger(authority.memberCount) || authority.memberCount < 1 ||
      !Array.isArray(authority.records) || authority.records.length !== authority.memberCount) {
    throw new HarnessInputError("Stored Agent Group projection authority is invalid.");
  }
  const first = authority.records[0];
  if (first === undefined || new Set(authority.records.map((record) => record.taskId)).size !== authority.records.length ||
      authority.records.some((record, index) =>
        record.sessionId !== sessionId || record.kind !== "agent" ||
        record.agentGroupScopeIdentity !== scopeIdentity || record.agentMemberIndex !== index ||
        record.agentMemberId !== `member_${index + 1}` ||
        record.agentGroupRevision !== first.agentGroupRevision ||
        record.agentGroupStatus !== first.agentGroupStatus ||
        record.agentGroupObservationDigest !== first.agentGroupObservationDigest ||
        record.agentGroupObservedAt !== first.agentGroupObservedAt ||
        record.agentJoinReductionRevision !== first.agentJoinReductionRevision ||
        record.agentJoinReductionDigest !== first.agentJoinReductionDigest)) {
    throw new HarnessInputError("Stored Agent Group projection authority is inconsistent.");
  }
  return authority;
}

function overlayTaskFromAgentGroupAuthority(
  record: HarnessTaskRecord,
  authority: DurableAgentGroupProjectionAuthority | undefined,
): HarnessTaskRecord {
  if (authority === undefined) return record;
  const projected = authority.records.find((candidate) => candidate.taskId === record.taskId);
  if (projected === undefined || projected.sessionId !== record.sessionId ||
      projected.kind !== "agent" ||
      projected.agentGroupScopeIdentity !== record.agentGroupScopeIdentity) {
    throw new HarnessInputError("Stored Agent Group projection authority is incomplete.");
  }
  return compact({
    ...record,
    externalAgentGroupRef: projected.externalAgentGroupRef,
    externalAgentTaskRef: projected.externalAgentTaskRef,
    agentLaunchAcceptedAt: projected.agentLaunchAcceptedAt,
    status: projected.status,
    updatedAt: projected.updatedAt,
    outputSummary: projected.outputSummary,
    externalAgentResultRef: projected.externalAgentResultRef,
    error: projected.error,
    terminalCauseCode: projected.terminalCauseCode,
    terminalMessage: projected.terminalMessage,
    terminalDiagnostic: projected.terminalDiagnostic,
    agentGroupRevision: projected.agentGroupRevision,
    agentGroupStatus: projected.agentGroupStatus,
    agentGroupObservationDigest: projected.agentGroupObservationDigest,
    agentGroupObservedAt: projected.agentGroupObservedAt,
    agentMemberRevision: projected.agentMemberRevision,
    agentMemberObservationDigest: projected.agentMemberObservationDigest,
    agentMemberStateDigest: projected.agentMemberStateDigest,
    agentMemberObservedAt: projected.agentMemberObservedAt,
    agentJoinReductionRevision: projected.agentJoinReductionRevision,
    agentJoinReductionDigest: projected.agentJoinReductionDigest,
  }) as HarnessTaskRecord;
}

async function findTaskRecordByCallIdentity(
  store: DurableJsonStore,
  rootDir: string,
  sessionId: string,
  callIdentity: string,
): Promise<HarnessTaskRecord | undefined> {
  const records = await listJsonRecords<HarnessTaskRecord>(store, taskSessionDir(rootDir, sessionId));
  return records.find((record) => record.callIdentity === callIdentity);
}

async function ensureTaskHighWaterMarkAtLeast(
  store: DurableJsonStore,
  rootDir: string,
  sessionId: string,
  minimum: number,
): Promise<void> {
  const current = await store.readJson<{ readonly highWaterMark: number }>(taskMetaPath(rootDir, sessionId));
  if ((current?.highWaterMark ?? 0) < minimum) {
    await store.writeJson(taskMetaPath(rootDir, sessionId), { highWaterMark: minimum });
  }
}

function createContinuationLedger(store: DurableJsonStore, rootDir: string): HarnessContinuationLedger {
  return {
    async put(record) {
      await store.writeJson(continuationPath(rootDir, record.continuationId), record);
    },
    async putIfAbsent(record) {
      return store.withLock(["continuation", record.continuationId], async () => {
        const existing = await this.get(record.continuationId);
        if (existing !== undefined) {
          return { inserted: false, record: existing };
        }
        await this.put(record);
        return { inserted: true, record };
      });
    },
    async get(continuationId) {
      return store.readJson<HarnessContinuationRecord>(continuationPath(rootDir, continuationId));
    },
    async listOpen(sessionId) {
      const records = await listJsonRecords<HarnessContinuationRecord>(store, join(rootDir, "continuations"));
      return records.filter((record) =>
        record.state === "open" && (sessionId === undefined || record.sessionId === sessionId)
      );
    },
    async markWaitTerminal(input) {
      return store.withLock(["continuation", input.continuationId], async () => {
        const record = await this.get(input.continuationId);
        if (record === undefined || record.state !== "open") {
          return { updated: false, shouldEnqueueResume: false };
        }
        const wait = record.waits.find((candidate) => candidate.waitId === input.waitId);
        if (wait === undefined || wait.state !== input.fromState) {
          return { updated: false, shouldEnqueueResume: false };
        }

        const updatedWait = updateWait(wait, input);
        const waitChanged = updatedWait !== wait;
        if (!waitChanged) {
          return { updated: false, record, shouldEnqueueResume: false };
        }

        const waits = record.waits.map((candidate) =>
          candidate.waitId === input.waitId ? updatedWait : candidate
        );
        const allWaitsClosed = waits.every((candidate) => candidate.state !== "open");
        const terminalResultsByToolCallId = {
          ...record.terminalResultsByToolCallId,
          ...(updatedWait.state === "open"
            ? {}
            : { [updatedWait.parkedToolCallId]: updatedWait.terminalResultIds }),
        };
        const updated = compact({
          ...record,
          waits,
          terminalResultsByToolCallId,
          state: allWaitsClosed ? "resume_enqueued" as const : record.state,
          resumeQueueId: allWaitsClosed ? input.resumeQueueId : record.resumeQueueId,
          updatedAt: input.terminalAt,
        }) as HarnessContinuationRecord;
        await this.put(updated);
        return { updated: true, record: updated, shouldEnqueueResume: allWaitsClosed };
      });
    },
    async transition(continuationId, from, to, patch) {
      return store.withLock(["continuation", continuationId], async () => {
        const record = await this.get(continuationId);
        if (record === undefined || record.state !== from) {
          return optionalRecord({ updated: false }, record);
        }
        const updated = compact({ ...record, ...patch, state: to }) as HarnessContinuationRecord;
        await this.put(updated);
        return { updated: true, record: updated };
      });
    },
    async delete(continuationId) {
      await store.withLock(["continuation", continuationId], async () => {
        await store.remove(continuationPath(rootDir, continuationId));
      });
    },
  };
}

function createWakeupLedger(store: DurableJsonStore, rootDir: string): HarnessWakeupLedger {
  return {
    async put(record) {
      await store.writeJson(wakeupPath(rootDir, record.wakeupId), record);
    },
    async putIfAbsent(record) {
      return store.withLock(["wakeup", record.wakeupId], async () => {
        const existing = await this.get(record.wakeupId);
        if (existing !== undefined) {
          return { inserted: false, record: existing };
        }
        await this.put(record);
        return { inserted: true, record };
      });
    },
    async listOpen(sessionId) {
      const records = await listJsonRecords<HarnessWakeupRecord>(store, join(rootDir, "wakeups"));
      return records.filter((record) =>
        record.status !== "closed"
        && (sessionId === undefined || record.sessionId === sessionId)
      );
    },
    async get(wakeupId) {
      return store.readJson<HarnessWakeupRecord>(wakeupPath(rootDir, wakeupId));
    },
    async transition(wakeupId, from, to, patch) {
      return store.withLock(["wakeup", wakeupId], async () => {
        const record = await this.get(wakeupId);
        if (record === undefined || record.status !== from) {
          return optionalRecord({ updated: false }, record);
        }
        const updated = compact({ ...record, ...patch, status: to }) as HarnessWakeupRecord;
        await this.put(updated);
        return { updated: true, record: updated };
      });
    },
  };
}

function createWorkflowQueueLedger(store: DurableJsonStore, rootDir: string): HarnessWorkflowQueueLedger {
  return {
    async enqueue(record) {
      await store.writeJson(queuePath(rootDir, "workflow-queue", record.sessionId, record.queueId), record);
    },
    async update(record) {
      await this.enqueue(record);
    },
    async withQueueCapacity(input, transaction) {
      return store.withLock(["workflow-queue-capacity", input.sessionId], async () => {
        if (await transaction.hasExistingLaunch()) {
          return { accepted: true, value: await transaction.reserve() };
        }
        const [active, queued] = await Promise.all([
          this.listRuns({ sessionId: input.sessionId, statuses: ["admitted", "running"] }),
          this.listRuns({ sessionId: input.sessionId, statuses: ["queued"] }),
        ]);
        const availableAdmissionSlots = Math.max(0, input.maxConcurrentWorkflowRuns - active.length);
        const projectedQueuedRuns = Math.max(0, queued.length + 1 - availableAdmissionSlots);
        if (projectedQueuedRuns > input.maxQueuedWorkflowRuns) {
          return { accepted: false, queuedWorkflowRuns: queued.length };
        }
        return { accepted: true, value: await transaction.reserve() };
      });
    },
    async acquireAdmissionSlot(input) {
      return store.withLock(["workflow-admission", input.sessionId], async () => {
        return store.withLock(["workflow-queue", input.sessionId, input.queueId], async () => {
          const record = await this.get(input);
          if (record === undefined || record.status !== "queued") {
            return optionalRecord({ admitted: false }, record);
          }
          const running = await this.listRuns({ sessionId: input.sessionId, statuses: ["admitted", "running"] });
          if (running.length >= input.maxConcurrentWorkflowRuns) {
            return { admitted: false, record };
          }
          const updated = compact({
            ...record,
            status: "admitted" as const,
            admittedAt: new Date().toISOString(),
            attemptLeaseExpiresAt: input.leaseExpiresAt,
          }) as HarnessWorkflowQueueRecord;
          await this.update(updated);
          return { admitted: true, record: updated };
        });
      });
    },
    async claimAdmittedForRun(input) {
      return store.withLock(["workflow-queue", input.sessionId, input.queueId], async () => {
        const record = await this.get(input);
        if (record === undefined || record.status !== "admitted" || record.taskId !== input.taskId) {
          return optionalRecord({ claimed: false }, record);
        }
        const updated = compact({
          ...record,
          status: "running" as const,
          attemptId: input.attemptId,
          startedAt: input.startedAt,
          deadlineAt: input.deadlineAt,
          attemptStartedAt: input.attemptStartedAt,
          attemptLeaseExpiresAt: input.attemptLeaseExpiresAt,
          operationId: input.operationId,
          recoverableAfterCrash: input.recoverableAfterCrash,
        }) as HarnessWorkflowQueueRecord;
        await this.update(updated);
        return { claimed: true, record: updated };
      });
    },
    async releaseAdmissionSlot() {},
    async recordProgress(input) {
      return store.withLock(["workflow-queue", input.sessionId, input.queueId], async () => {
        const record = await this.get(input);
        if (record === undefined || isWorkflowTerminal(record.status)) {
          return optionalRecord({ updated: false }, record);
        }
        const updated = compact({
          ...record,
          currentStep: input.currentStep,
          lastEvent: input.lastEvent,
        }) as HarnessWorkflowQueueRecord;
        await this.update(updated);
        return { updated: true, record: updated };
      });
    },
    async markTerminal(input, terminal) {
      return store.withLock(["workflow-queue", input.sessionId, input.queueId], async () => {
        const record = await this.get(input);
        if (record === undefined || !input.expectedStatuses.includes(record.status) || isWorkflowTerminal(record.status)) {
          return optionalRecord({ updated: false }, record);
        }
        const updated = compact({ ...record, ...terminal }) as HarnessWorkflowQueueRecord;
        await this.update(updated);
        return { updated: true, record: updated };
      });
    },
    async get(input) {
      return store.readJson<HarnessWorkflowQueueRecord>(queuePath(rootDir, "workflow-queue", input.sessionId, input.queueId));
    },
    async getByRunId(input) {
      const records = await listJsonRecords<HarnessWorkflowQueueRecord>(store, queueSessionDir(rootDir, "workflow-queue", input.sessionId));
      return records.find((record) => record.reservedRunId === input.runId);
    },
    async getByTaskId(input) {
      const records = await listJsonRecords<HarnessWorkflowQueueRecord>(store, queueSessionDir(rootDir, "workflow-queue", input.sessionId));
      return records.find((record) => record.taskId === input.taskId);
    },
    async listNonTerminal() {
      const records = await listSessionRecords<HarnessWorkflowQueueRecord>(store, rootDir, "workflow-queue");
      return records.filter((record) => !isWorkflowTerminal(record.status));
    },
    async listRuns(filter) {
      const records = filter?.sessionId === undefined
        ? await listSessionRecords<HarnessWorkflowQueueRecord>(store, rootDir, "workflow-queue")
        : await listJsonRecords<HarnessWorkflowQueueRecord>(store, queueSessionDir(rootDir, "workflow-queue", filter.sessionId));
      return records.filter((record) =>
        (filter?.workflowId === undefined || record.workflowId === filter.workflowId)
        && (filter?.source === undefined || record.source === filter.source)
        && (filter?.statuses === undefined || filter.statuses.includes(record.status))
      );
    },
  };
}

function createAsyncTaskQueueLedger(store: DurableJsonStore, rootDir: string): HarnessAsyncTaskQueueLedger {
  return {
    async enqueue(record) {
      await store.writeJson(queuePath(rootDir, "async-task-queue", record.sessionId, record.queueId), record);
    },
    async update(record) {
      await this.enqueue(record);
    },
    async claimQueued(input) {
      return store.withLock(["async-queue", input.sessionId, input.queueId], async () => {
        const record = await this.get(input);
        if (record === undefined || record.status !== "queued") {
          return optionalRecord({ claimed: false }, record);
        }
        const updated = compact({
          ...record,
          status: "running" as const,
          attemptId: input.attemptId,
          attemptStartedAt: input.attemptStartedAt,
          attemptLeaseExpiresAt: input.attemptLeaseExpiresAt,
          startedAt: input.attemptStartedAt,
          deadlineAt: input.deadlineAt,
        }) as HarnessAsyncTaskQueueRecord;
        await this.update(updated);
        return { claimed: true, record: updated };
      });
    },
    async acquireToolSlot(input) {
      return store.withLock(["async-tool-slots", input.sessionId], async () => {
        return store.withLock(["async-queue", input.sessionId, input.queueId], async () => {
          const record = await this.get(input);
          if (record === undefined || record.status !== "queued" || record.taskId !== input.taskId) {
            return optionalRecord({ acquired: false }, record);
          }
          const nonTerminal = await this.listNonTerminal({ sessionId: input.sessionId });
          const active = nonTerminal.filter((candidate) =>
            candidate.attemptLeaseExpiresAt !== undefined && leaseIsActive(candidate.attemptLeaseExpiresAt)
          );
          if (active.length >= input.maxConcurrentToolCalls) {
            return { acquired: false, record };
          }
          const updated = compact({ ...record, attemptLeaseExpiresAt: input.leaseExpiresAt }) as HarnessAsyncTaskQueueRecord;
          await this.update(updated);
          return { acquired: true, record: updated };
        });
      });
    },
    async releaseToolSlot() {},
    async markTerminal(input, terminal) {
      return store.withLock(["async-queue", input.sessionId, input.queueId], async () => {
        const record = await this.get(input);
        if (record === undefined || !input.expectedStatuses.includes(record.status) || isTaskQueueTerminal(record.status)) {
          return optionalRecord({ updated: false }, record);
        }
        const updated = compact({ ...record, ...terminal }) as HarnessAsyncTaskQueueRecord;
        await this.update(updated);
        return { updated: true, record: updated };
      });
    },
    async get(input) {
      return store.readJson<HarnessAsyncTaskQueueRecord>(queuePath(rootDir, "async-task-queue", input.sessionId, input.queueId));
    },
    async getByTaskId(input) {
      const records = await listJsonRecords<HarnessAsyncTaskQueueRecord>(store, queueSessionDir(rootDir, "async-task-queue", input.sessionId));
      return records.find((record) => record.taskId === input.taskId);
    },
    async listNonTerminal(filter) {
      const records = filter?.sessionId === undefined
        ? await listSessionRecords<HarnessAsyncTaskQueueRecord>(store, rootDir, "async-task-queue")
        : await listJsonRecords<HarnessAsyncTaskQueueRecord>(store, queueSessionDir(rootDir, "async-task-queue", filter.sessionId));
      return records.filter((record) => !isTaskQueueTerminal(record.status));
    },
  };
}

function createWorkflowLaunchLedger(config: {
  readonly store: DurableJsonStore;
  readonly rootDir: string;
  readonly tasks: HarnessTaskLedger;
  readonly results: HarnessResultStore;
  readonly workflowQueue: HarnessWorkflowQueueLedger;
  readonly faultInjection?: LocalHarnessDurableServicesFaultInjection;
}): HarnessWorkflowLaunchLedger {
  return {
    async hasLaunch(input) {
      if (await config.tasks.taskIdForCallIdentity(input) !== undefined) {
        return true;
      }
      const queueRecord = (await config.workflowQueue.listRuns({ sessionId: input.sessionId }))
        .find((record) => record.callIdentity === input.callIdentity);
      if (queueRecord !== undefined) {
        return true;
      }
      const transaction = await readLaunchTransaction(config.store, config.rootDir, "workflow", input.sessionId, input.callIdentity);
      if (transaction !== undefined) {
        return true;
      }
      return await config.tasks.taskIdForCallIdentity({
        sessionId: input.sessionId,
        callIdentity: launchTaskReservationIdentity("workflow", input.callIdentity),
      }) !== undefined;
    },
    async reserveLaunch(input) {
      return config.store.withLock(["workflow-launch", input.sessionId, input.callIdentity], async () => {
        const existing = await findExistingWorkflowLaunch(config, input);
        if (existing !== undefined) {
          assertWorkflowReplayEnvelope(input, existing.queueRecord);
          return { replay: true, ...existing };
        }

        const existingTransaction = await readLaunchTransaction(config.store, config.rootDir, "workflow", input.sessionId, input.callIdentity);
        let transaction = existingTransaction ?? await writeLaunchTransaction(config.store, config.rootDir, {
          kind: "workflow",
          sessionId: input.sessionId,
          callIdentity: input.callIdentity,
          status: "pending",
          envelopeHash: workflowLaunchEnvelopeHash(input),
          createdAt: input.reservedAt,
          updatedAt: input.reservedAt,
        });
        assertLaunchTransactionEnvelope(transaction, workflowLaunchEnvelopeHash(input));
        const inputResult = await config.results.allocate({
          sessionId: input.sessionId,
          sessionDataDir: input.sessionDataDir,
          kind: "workflow-input",
          idempotencyKey: `input:${input.callIdentity}`,
          createdAt: input.reservedAt,
        });
        if (transaction.inputResultId !== undefined && transaction.inputResultId !== inputResult.resultId) {
          throw new HarnessInputError("Workflow launch transaction input result changed during replay.", {
            sessionId: input.sessionId,
            callIdentity: input.callIdentity,
            expected: transaction.inputResultId,
            actual: inputResult.resultId,
          });
        }
        await config.results.commit({ sessionId: input.sessionId, resultId: inputResult.resultId }, input.input);
        transaction = await writeLaunchTransaction(config.store, config.rootDir, {
          ...transaction,
          inputResultId: inputResult.resultId,
          updatedAt: input.reservedAt,
        });
        await maybeInjectFault(config.faultInjection, "workflow-launch-after-input-commit");

        const taskReservationIdentity = launchTaskReservationIdentity("workflow", input.callIdentity);
        const transactionTaskId = transaction.taskId ?? await config.tasks.taskIdForCallIdentity({
          sessionId: input.sessionId,
          callIdentity: taskReservationIdentity,
        });
        let task = transactionTaskId === undefined
          ? undefined
          : await config.tasks.getTask({ sessionId: input.sessionId, taskId: transactionTaskId });
        if (transactionTaskId !== undefined && task === undefined) {
          throw new HarnessInputError("Workflow launch transaction references a missing task.", {
            sessionId: input.sessionId,
            callIdentity: input.callIdentity,
            taskId: transactionTaskId,
          });
        }
        if (task === undefined) {
          task = await config.tasks.reserveTask(compact({
            sessionId: input.sessionId,
            kind: "workflow",
            source: input.source,
            purpose: input.purpose,
            workflowId: input.workflowId,
            workflowHandle: input.handle,
            callIdentity: taskReservationIdentity,
          }) as HarnessTaskReserveInput);
          await maybeInjectFault(config.faultInjection, "workflow-launch-after-task-reserve-before-journal");
        }
        if (transaction.taskId !== task.taskId) {
          transaction = await writeLaunchTransaction(config.store, config.rootDir, {
            ...transaction,
            taskId: task.taskId,
            updatedAt: input.reservedAt,
          });
        }
        await maybeInjectFault(config.faultInjection, "workflow-launch-after-task-reserve");

        let queueRecord = transaction.queueId === undefined
          ? await config.workflowQueue.getByTaskId({ sessionId: input.sessionId, taskId: task.taskId })
          : await config.workflowQueue.get({ sessionId: input.sessionId, queueId: transaction.queueId });
        if (queueRecord !== undefined) {
          assertWorkflowReplayEnvelope(input, queueRecord);
        } else {
          const ordinal = taskNumber(task.taskId);
          queueRecord = compact({
            queueId: `queue_${ordinal}`,
            sessionId: input.sessionId,
            workflowId: input.workflowId,
            handle: input.handle,
            reservedRunId: input.reservedRunId ?? `run_${ordinal}`,
            taskId: task.taskId,
            callIdentity: input.callIdentity,
            disposition: input.disposition,
            inputHash: input.inputHash,
            inputResultId: inputResult.resultId,
            sessionDataDir: input.sessionDataDir,
            dataDir: input.dataDir,
            originTurnId: input.originTurnId,
            parentTurnId: input.parentTurnId,
            reservationScopeId: input.reservationScopeId,
            reservationOrder: input.reservationOrder,
            scopeSize: input.scopeSize,
            toolCallId: input.toolCallId,
            launcherHandle: input.launcherHandle,
            workflowDefinitionIdentity: input.workflowDefinitionIdentity,
            workflowVersionId: input.workflowVersionId,
            memoryScope: input.memoryScope,
            workflowSetMemoryKey: input.workflowSetMemoryKey,
            workflowSetDefinitionIdentities: input.workflowSetDefinitionIdentities,
            inheritance: input.inheritance,
            status: "queued" as const,
            source: input.source,
            purpose: input.purpose,
            reservedAt: input.reservedAt,
            createdAt: input.reservedAt,
            queuedAt: input.reservedAt,
            queueDeadlineAt: input.queueDeadlineAt,
            dynamicPlan: input.dynamicPlan,
            dynamicCapabilitySnapshot: input.dynamicCapabilitySnapshot,
          }) as HarnessWorkflowQueueRecord;
          await config.workflowQueue.enqueue(queueRecord);
        }
        transaction = await writeLaunchTransaction(config.store, config.rootDir, {
          ...transaction,
          queueId: queueRecord.queueId,
          reservedRunId: queueRecord.reservedRunId,
          updatedAt: input.reservedAt,
        });
        await maybeInjectFault(config.faultInjection, "workflow-launch-after-queue-enqueue");

        const currentTask = await config.tasks.getTask({ sessionId: input.sessionId, taskId: task.taskId }) ?? task;
        const boundTask = compact({
          ...currentTask,
          callIdentity: input.callIdentity,
          reservedRunId: queueRecord.reservedRunId,
          queueId: queueRecord.queueId,
        }) as HarnessTaskRecord;
        await config.tasks.updateTask(boundTask);
        await writeLaunchTransaction(config.store, config.rootDir, {
          ...transaction,
          status: "complete",
          updatedAt: input.reservedAt,
        });
        return { replay: existingTransaction !== undefined, task: boundTask, inputResult, queueRecord };
      });
    },
  };
}

function createAsyncLaunchLedger(config: {
  readonly store: DurableJsonStore;
  readonly rootDir: string;
  readonly tasks: HarnessTaskLedger;
  readonly results: HarnessResultStore;
  readonly asyncTaskQueue: HarnessAsyncTaskQueueLedger;
  readonly faultInjection?: LocalHarnessDurableServicesFaultInjection;
}): HarnessAsyncLaunchLedger {
  return {
    async reserveLaunch(input) {
      return config.store.withLock(["async-launch", input.sessionId, input.callIdentity], async () => {
        const existing = await findExistingAsyncLaunch(config, input);
        if (existing !== undefined) {
          assertAsyncReplayEnvelope(input, existing.queueRecord);
          return { replay: true, ...existing };
        }
        const now = new Date().toISOString();
        const existingTransaction = await readLaunchTransaction(config.store, config.rootDir, "async", input.sessionId, input.callIdentity);
        let transaction = existingTransaction ?? await writeLaunchTransaction(config.store, config.rootDir, {
          kind: "async",
          sessionId: input.sessionId,
          callIdentity: input.callIdentity,
          status: "pending",
          envelopeHash: asyncLaunchEnvelopeHash(input),
          createdAt: now,
          updatedAt: now,
        });
        assertLaunchTransactionEnvelope(transaction, asyncLaunchEnvelopeHash(input));
        const inputResult = await config.results.allocate({
          sessionId: input.sessionId,
          sessionDataDir: input.sessionDataDir,
          kind: input.kind,
          idempotencyKey: `input:${input.callIdentity}`,
        });
        if (transaction.inputResultId !== undefined && transaction.inputResultId !== inputResult.resultId) {
          throw new HarnessInputError("Async launch transaction input result changed during replay.", {
            sessionId: input.sessionId,
            callIdentity: input.callIdentity,
            expected: transaction.inputResultId,
            actual: inputResult.resultId,
          });
        }
        await config.results.commit({ sessionId: input.sessionId, resultId: inputResult.resultId }, input.input);
        transaction = await writeLaunchTransaction(config.store, config.rootDir, {
          ...transaction,
          inputResultId: inputResult.resultId,
          updatedAt: now,
        });
        await maybeInjectFault(config.faultInjection, "async-launch-after-input-commit");

        const taskReservationIdentity = launchTaskReservationIdentity("async", input.callIdentity);
        const transactionTaskId = transaction.taskId ?? await config.tasks.taskIdForCallIdentity({
          sessionId: input.sessionId,
          callIdentity: taskReservationIdentity,
        });
        let task = transactionTaskId === undefined
          ? undefined
          : await config.tasks.getTask({ sessionId: input.sessionId, taskId: transactionTaskId });
        if (transactionTaskId !== undefined && task === undefined) {
          throw new HarnessInputError("Async launch transaction references a missing task.", {
            sessionId: input.sessionId,
            callIdentity: input.callIdentity,
            taskId: transactionTaskId,
          });
        }
        if (task === undefined) {
          task = await config.tasks.reserveTask(compact({
            sessionId: input.sessionId,
            kind: input.kind,
            purpose: input.purpose,
            callIdentity: taskReservationIdentity,
          }) as HarnessTaskReserveInput);
          await maybeInjectFault(config.faultInjection, "async-launch-after-task-reserve-before-journal");
        }
        if (transaction.taskId !== task.taskId) {
          transaction = await writeLaunchTransaction(config.store, config.rootDir, {
            ...transaction,
            taskId: task.taskId,
            updatedAt: now,
          });
        }
        await maybeInjectFault(config.faultInjection, "async-launch-after-task-reserve");

        let queueRecord = transaction.queueId === undefined
          ? await config.asyncTaskQueue.getByTaskId({ sessionId: input.sessionId, taskId: task.taskId })
          : await config.asyncTaskQueue.get({ sessionId: input.sessionId, queueId: transaction.queueId });
        if (queueRecord !== undefined) {
          assertAsyncReplayEnvelope(input, queueRecord);
        } else {
          const ordinal = taskNumber(task.taskId);
          queueRecord = compact({
            queueId: `queue_${ordinal}`,
            sessionId: input.sessionId,
            taskId: task.taskId,
            kind: input.kind,
            handle: input.handle,
            callIdentity: input.callIdentity,
            inputHash: input.inputHash,
            inputResultId: inputResult.resultId,
            sessionDataDir: input.sessionDataDir,
            purpose: input.purpose,
            originTurnId: input.originTurnId,
            parentTurnId: input.parentTurnId,
            reservationScopeId: input.reservationScopeId,
            reservationOrder: input.reservationOrder,
            scopeSize: input.scopeSize,
            toolCallId: input.toolCallId,
            permissionSnapshot: input.permissionSnapshot,
            approvalPolicy: input.approvalPolicy,
            capabilitySnapshot: input.capabilitySnapshot,
            recoverableAfterCrash: input.recoverableAfterCrash,
            operationId: input.operationId,
            status: "queued" as const,
            createdAt: now,
            queuedAt: now,
          }) as HarnessAsyncTaskQueueRecord;
          await config.asyncTaskQueue.enqueue(queueRecord);
        }
        transaction = await writeLaunchTransaction(config.store, config.rootDir, {
          ...transaction,
          queueId: queueRecord.queueId,
          updatedAt: now,
        });
        await maybeInjectFault(config.faultInjection, "async-launch-after-queue-enqueue");

        const currentTask = await config.tasks.getTask({ sessionId: input.sessionId, taskId: task.taskId }) ?? task;
        const boundTask = compact({ ...currentTask, callIdentity: input.callIdentity, queueId: queueRecord.queueId }) as HarnessTaskRecord;
        await config.tasks.updateTask(boundTask);
        await writeLaunchTransaction(config.store, config.rootDir, {
          ...transaction,
          status: "complete",
          updatedAt: now,
        });
        return { replay: existingTransaction !== undefined, task: boundTask, inputResult, queueRecord };
      });
    },
  };
}

function createResultStore(
  store: DurableJsonStore,
  rootDir: string,
  faultInjection: LocalHarnessDurableServicesFaultInjection | undefined,
): HarnessResultStore {
  return {
    async allocate(input) {
      return store.withLock(["result-store", input.sessionId], async () => {
        if (input.idempotencyKey !== undefined) {
          const existing = await readResultByKeyIndex(store, rootDir, input.sessionId, input.idempotencyKey);
          if (existing !== undefined) {
            return reconcileResultRecord(store, rootDir, existing);
          }
          const existingByRecord = await findResultRecordByIdempotencyKey(
            store,
            rootDir,
            input.sessionId,
            input.idempotencyKey,
            input.sessionDataDir,
          );
          if (existingByRecord !== undefined) {
            await writeResultRecord(store, rootDir, existingByRecord);
            await writeResultKeyIndex(store, rootDir, existingByRecord);
            await ensureResultHighWaterMarkAtLeast(store, rootDir, input.sessionId, resultNumber(existingByRecord.resultId));
            return existingByRecord;
          }
        }
        const highWater = await resultHighWaterMark(store, rootDir, input.sessionId, input.sessionDataDir);
        const resultId = `result_${highWater + 1}`;
        const record = compact({
          resultId,
          sessionId: input.sessionId,
          sessionDataDir: input.sessionDataDir,
          idempotencyKey: input.idempotencyKey,
          kind: input.kind,
          inlineSummary: input.inlineSummary,
          createdAt: input.createdAt ?? new Date().toISOString(),
        }) as HarnessStoredResult;
        await writeResultRecord(store, rootDir, record, faultInjection);
        await maybeInjectFault(faultInjection, "result-allocate-after-record-write");
        if (input.idempotencyKey !== undefined) {
          await writeResultKeyIndex(store, rootDir, record);
        }
        await store.writeJson(resultMetaPath(rootDir, input.sessionId), { highWaterMark: highWater + 1 });
        return record;
      });
    },
    async commit(input, value, patch) {
      return store.withLock(["result-commit", input.sessionId, input.resultId], async () => {
        const found = await this.get(input);
        if (found === undefined) {
          throw new Error(`Result ${input.resultId} does not exist in session ${input.sessionId}.`);
        }
        if (found.record.committedAt !== undefined) {
          if (stableHash(found.value) !== stableHash(value)) {
            throw new Error(`Result ${input.resultId} is already committed with a different value.`);
          }
          return found.record;
        }
        if (found.value !== undefined && stableHash(found.value) !== stableHash(value)) {
          throw new Error(`Result ${input.resultId} is already committed with a different value.`);
        }
        const record = compact({
          ...found.record,
          ...patch,
          committedAt: new Date().toISOString(),
        }) as HarnessStoredResult;
        await store.writeJson(resultValuePath(record), value);
        await maybeInjectFault(faultInjection, "result-commit-after-value-write");
        await writeResultRecord(store, rootDir, record, faultInjection, "result-commit-after-session-record-write");
        if (record.idempotencyKey !== undefined) {
          await writeResultKeyIndex(store, rootDir, record);
        }
        return record;
      });
    },
    async getRecord(input) {
      const record = await readResultByIdIndex(store, rootDir, input.sessionId, input.resultId);
      return record === undefined ? undefined : reconcileResultRecord(store, rootDir, record);
    },
    async get(input) {
      const record = await readResultByIdIndex(store, rootDir, input.sessionId, input.resultId);
      if (record === undefined) {
        return undefined;
      }
      const reconciled = await reconcileResultRecord(store, rootDir, record);
      return { record: reconciled, value: await store.readJson<unknown>(resultValuePath(reconciled)) };
    },
    async getByIdempotencyKey(input) {
      const record = await readResultByKeyIndex(store, rootDir, input.sessionId, input.idempotencyKey);
      if (record === undefined) {
        // Mirror allocate's repair: a missing by-key index can be rebuilt from the surviving
        // by-result index records, so a launch-replay does not spuriously treat the
        // transaction as incomplete.
        return store.withLock(["result-store", input.sessionId], async () => {
          const repaired = await readResultByKeyIndex(store, rootDir, input.sessionId, input.idempotencyKey);
          const recovered = repaired ?? await findResultRecordByIdempotencyKey(store, rootDir, input.sessionId, input.idempotencyKey, input.sessionDataDir);
          if (recovered === undefined) {
            return undefined;
          }
          if (repaired === undefined) {
            await writeResultKeyIndex(store, rootDir, recovered);
          }
          const reconciled = await reconcileResultRecord(store, rootDir, recovered);
          return { record: reconciled, value: await store.readJson<unknown>(resultValuePath(reconciled)) };
        });
      }
      const reconciled = await reconcileResultRecord(store, rootDir, record);
      return { record: reconciled, value: await store.readJson<unknown>(resultValuePath(reconciled)) };
    },
  };
}

function createPreparedWorkflowStore(store: DurableJsonStore, rootDir: string): HarnessPreparedWorkflowStore {
  return {
    async put(input) {
      await store.writeJson(preparedWorkflowPath(rootDir, input.record.sessionId, input.record.workflowId, input.record.versionId), input.record);
    },
    async getByPrepareCallIdentity(input) {
      const records = await this.list({ sessionId: input.sessionId });
      return records.find((record) => record.prepareCallIdentity === input.prepareCallIdentity);
    },
    async getByVersionId(input) {
      const matches = (await this.list({ sessionId: input.sessionId })).filter((record) => record.versionId === input.versionId);
      if (matches.length === 0) {
        return { status: "missing" };
      }
      if (matches.length > 1) {
        return { status: "ambiguous", workflowIds: matches.map((record) => record.workflowId) };
      }
      return { status: "found", record: matches[0] as HarnessPreparedWorkflowRecord };
    },
    async get(input) {
      return store.readJson<HarnessPreparedWorkflowRecord>(preparedWorkflowPath(rootDir, input.sessionId, input.workflowId, input.versionId));
    },
    async list(filter) {
      const records = await listJsonRecords<HarnessPreparedWorkflowRecord>(store, sessionCollectionDir(rootDir, "prepared-workflows", filter.sessionId));
      return records.filter((record) => filter.workflowId === undefined || record.workflowId === filter.workflowId);
    },
  };
}

function createPreparedWorkflowRunStore(store: DurableJsonStore, rootDir: string): HarnessPreparedWorkflowRunStore {
  return {
    async put(input) {
      await store.writeJson(preparedWorkflowRunPath(rootDir, input.record.sessionId, input.record.runPreparedCallIdentity), input.record);
    },
    async getByRunPreparedCallIdentity(input) {
      return store.readJson<HarnessPreparedWorkflowRunRecord>(preparedWorkflowRunPath(rootDir, input.sessionId, input.runPreparedCallIdentity));
    },
    async markTerminal(input) {
      return store.withLock(["prepared-workflow-run", input.sessionId, input.runPreparedCallIdentity], async () => {
        const record = await this.getByRunPreparedCallIdentity(input);
        if (record === undefined) {
          throw new Error(`Prepared workflow run ${input.runPreparedCallIdentity} does not exist.`);
        }
        if (record.status !== "running") {
          return record;
        }
        const updated = compact({
          ...record,
          status: input.status,
          terminalResultId: input.terminalResultId,
          terminalCauseCode: input.terminalCauseCode,
          terminalAt: input.terminalAt,
          updatedAt: input.terminalAt,
        }) as HarnessPreparedWorkflowRunRecord;
        await this.put({ record: updated });
        return updated;
      });
    },
    async list(filter) {
      const records = await listJsonRecords<HarnessPreparedWorkflowRunRecord>(store, sessionCollectionDir(rootDir, "prepared-workflow-runs", filter.sessionId));
      return records.filter((record) =>
        (filter.workflowId === undefined || record.workflowId === filter.workflowId)
        && (filter.versionId === undefined || record.versionId === filter.versionId)
      );
    },
  };
}

function createResumeQueue(store: DurableJsonStore, rootDir: string): HarnessResumeQueue {
  return {
    async enqueue(record) {
      await store.writeJson(resumeQueuePath(rootDir, record.resumeId), record);
    },
    async ensureEnqueued(record) {
      return store.withLock(["resume-queue", record.resumeId], async () => {
        const existing = await store.readJson<HarnessResumeQueueRecord>(resumeQueuePath(rootDir, record.resumeId));
        if (existing !== undefined) {
          return { enqueued: false, record: existing };
        }
        await this.enqueue(record);
        return { enqueued: true, record };
      });
    },
    async claimNext(sessionId) {
      return store.withLock(["resume-queue-claim"], async () => {
        const now = new Date().toISOString();
        const records = (await this.listOpen(sessionId)).filter((record) => record.retryAt === undefined || record.retryAt <= now);
        const next = [...records].sort((left: HarnessResumeQueueRecord, right: HarnessResumeQueueRecord) =>
          left.enqueuedAt.localeCompare(right.enqueuedAt)
        )[0];
        if (next === undefined) {
          return undefined;
        }
        const claimed = compact({ ...next, claimedAt: new Date().toISOString() }) as HarnessResumeQueueRecord;
        await this.enqueue(claimed);
        return claimed;
      });
    },
    async claim(resumeId) {
      return store.withLock(["resume-queue-claim"], async () => {
        const record = await store.readJson<HarnessResumeQueueRecord>(resumeQueuePath(rootDir, resumeId));
        if (record === undefined || record.claimedAt !== undefined || record.completedAt !== undefined) {
          return undefined;
        }
        const claimed = compact({ ...record, claimedAt: new Date().toISOString() }) as HarnessResumeQueueRecord;
        await this.enqueue(claimed);
        return claimed;
      });
    },
    async markCompleted(resumeId, completedAt) {
      await store.withLock(["resume-queue", resumeId], async () => {
        const record = await store.readJson<HarnessResumeQueueRecord>(resumeQueuePath(rootDir, resumeId));
        if (record !== undefined) {
          await this.enqueue(compact({ ...record, completedAt }) as HarnessResumeQueueRecord);
        }
      });
    },
    async listOpen(sessionId) {
      const records = await listJsonRecords<HarnessResumeQueueRecord>(store, join(rootDir, "resume-queue"));
      return records.filter((record) =>
        record.completedAt === undefined
        && record.claimedAt === undefined
        && (sessionId === undefined || record.sessionId === sessionId)
      );
    },
  };
}

function createResultGrantStore(store: DurableJsonStore, rootDir: string): HarnessResultGrantStore {
  return {
    async mintGrant(input) {
      const createdAt = new Date().toISOString();
      const resultGrantId = `grant_${stableHash({ ...input, createdAt }, { format: "base32hex" }).slice(0, 24)}`;
      const grant = compact({ resultGrantId, createdAt, ...input }) as HarnessResultGrant;
      await store.writeJson(resultGrantPath(rootDir, resultGrantId), grant);
      return grant;
    },
    async get(resultGrantId) {
      return store.readJson<HarnessResultGrant>(resultGrantPath(rootDir, resultGrantId));
    },
    async validateGrant(input) {
      const grant = await this.get(input.resultGrantId);
      if (grant === undefined) {
        return { valid: false, causeCode: "missing" };
      }
      if (grant.sessionId !== input.sessionId) {
        return { valid: false, causeCode: "wrong_session" };
      }
      if (grant.resultId !== input.resultId) {
        return { valid: false, causeCode: "wrong_result" };
      }
      if (grant.audience !== input.audience) {
        return { valid: false, causeCode: "wrong_audience" };
      }
      if (grant.revokedAt !== undefined) {
        return { valid: false, causeCode: "revoked" };
      }
      if (grant.expiresAt !== undefined && grant.expiresAt <= (input.now ?? new Date().toISOString())) {
        return { valid: false, causeCode: "expired" };
      }
      return { valid: true, grant };
    },
    async revoke(resultGrantId, revokedAt) {
      const grant = await this.get(resultGrantId);
      if (grant !== undefined) {
        await store.writeJson(resultGrantPath(rootDir, resultGrantId), compact({ ...grant, revokedAt }));
      }
    },
  };
}

function updateWait(
  wait: HarnessContinuationWaitRecord,
  input: Parameters<HarnessContinuationLedger["markWaitTerminal"]>[0],
): HarnessContinuationWaitRecord {
  if (input.matchedId === undefined && input.toState !== "timed_out") {
    throw new Error("matchedId is required unless the whole wait timed out.");
  }
  const outcomesById = { ...wait.outcomesById };
  if (input.matchedId !== undefined) {
    outcomesById[input.matchedId] = {
      id: input.matchedId,
      state: input.toState,
      terminalResultIds: input.terminalResultIds,
      terminalAt: input.terminalAt,
    };
  }
  const nextState = evaluateWaitState(wait, outcomesById, input.toState, input.matchedId);
  const terminalResultIds = waitOutcomeResultIds(wait, outcomesById);
  if (nextState === "open" && input.matchedId !== undefined) {
    return compact({ ...wait, outcomesById, terminalResultIds }) as HarnessContinuationWaitRecord;
  }
  if (nextState === "open") {
    return wait;
  }
  return compact({
    ...wait,
    outcomesById,
    state: nextState,
    terminalResultIds,
    terminalAt: input.terminalAt,
    timeoutAt: nextState === "timed_out" ? input.terminalAt : wait.timeoutAt,
  }) as HarnessContinuationWaitRecord;
}

function evaluateWaitState(
  wait: HarnessContinuationWaitRecord,
  outcomesById: Readonly<Record<string, { readonly state: "terminal" | "timed_out" | "cancelled" }>>,
  requestedState: "terminal" | "timed_out" | "cancelled",
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
  return ids.every((id) => outcomesById[id]?.state === "cancelled" || outcomesById[id]?.state === "timed_out")
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

function waitOutcomeResultIds(
  wait: HarnessContinuationWaitRecord,
  outcomesById: Readonly<Record<string, HarnessContinuationWaitOutcome>>,
): readonly string[] {
  const predicateIds = waitPredicateIds(wait);
  const orderedResultIds = predicateIds.flatMap((id) => outcomesById[id]?.terminalResultIds ?? []);
  const extraResultIds = Object.entries(outcomesById)
    .filter(([id]) => !predicateIds.includes(id))
    .flatMap(([, outcome]) => outcome.terminalResultIds);
  return unique([
    ...orderedResultIds,
    ...wait.terminalResultIds,
    ...extraResultIds,
  ]);
}

type LaunchTransactionKind = "workflow" | "async";

type LaunchTransactionRecord = {
  readonly kind: LaunchTransactionKind;
  readonly sessionId: string;
  readonly callIdentity: string;
  readonly status: "pending" | "complete";
  readonly envelopeHash: string;
  readonly inputResultId?: string;
  readonly taskId?: HarnessTaskId;
  readonly queueId?: string;
  readonly reservedRunId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
};

type ResultIndexRecord = Pick<HarnessStoredResult, "sessionId" | "resultId" | "sessionDataDir" | "idempotencyKey">;

type WorkflowLaunchLedgerConfig = {
  readonly tasks: HarnessTaskLedger;
  readonly results: HarnessResultStore;
  readonly workflowQueue: HarnessWorkflowQueueLedger;
};

type AsyncLaunchLedgerConfig = {
  readonly tasks: HarnessTaskLedger;
  readonly results: HarnessResultStore;
  readonly asyncTaskQueue: HarnessAsyncTaskQueueLedger;
};

async function findExistingWorkflowLaunch(
  config: WorkflowLaunchLedgerConfig,
  input: Parameters<HarnessWorkflowLaunchLedger["reserveLaunch"]>[0],
): Promise<{
  readonly task: HarnessTaskRecord;
  readonly inputResult: HarnessStoredResult;
  readonly queueRecord: HarnessWorkflowQueueRecord;
} | undefined> {
  const existingTaskId = await config.tasks.taskIdForCallIdentity({
    sessionId: input.sessionId,
    callIdentity: input.callIdentity,
  });
  let queueRecord = existingTaskId === undefined
    ? undefined
    : await config.workflowQueue.getByTaskId({ sessionId: input.sessionId, taskId: existingTaskId });
  if (queueRecord === undefined) {
    queueRecord = (await config.workflowQueue.listRuns({ sessionId: input.sessionId }))
      .find((record) => record.callIdentity === input.callIdentity);
  }
  if (queueRecord === undefined) {
    return undefined;
  }
  const task = await config.tasks.getTask({ sessionId: input.sessionId, taskId: queueRecord.taskId });
  const inputResult = await config.results.getByIdempotencyKey({
    sessionId: input.sessionId,
    idempotencyKey: `input:${input.callIdentity}`,
    sessionDataDir: input.sessionDataDir,
  });
  if (task === undefined || inputResult === undefined) {
    throw new HarnessInputError("Workflow launch transaction is incomplete.", {
      sessionId: input.sessionId,
      callIdentity: input.callIdentity,
      queueId: queueRecord.queueId,
      taskId: queueRecord.taskId,
    });
  }
  if (task.callIdentity !== input.callIdentity || task.queueId !== queueRecord.queueId || task.reservedRunId !== queueRecord.reservedRunId) {
    await config.tasks.updateTask(compact({
      ...task,
      callIdentity: input.callIdentity,
      queueId: queueRecord.queueId,
      reservedRunId: queueRecord.reservedRunId,
    }) as HarnessTaskRecord);
  }
  return {
    task: await config.tasks.getTask({ sessionId: input.sessionId, taskId: queueRecord.taskId }) ?? task,
    inputResult: inputResult.record,
    queueRecord,
  };
}

async function findExistingAsyncLaunch(
  config: AsyncLaunchLedgerConfig,
  input: Parameters<HarnessAsyncLaunchLedger["reserveLaunch"]>[0],
): Promise<{
  readonly task: HarnessTaskRecord;
  readonly inputResult: HarnessStoredResult;
  readonly queueRecord: HarnessAsyncTaskQueueRecord;
} | undefined> {
  const existingTaskId = await config.tasks.taskIdForCallIdentity({
    sessionId: input.sessionId,
    callIdentity: input.callIdentity,
  });
  let queueRecord = existingTaskId === undefined
    ? undefined
    : await config.asyncTaskQueue.getByTaskId({ sessionId: input.sessionId, taskId: existingTaskId });
  if (queueRecord === undefined) {
    queueRecord = (await config.asyncTaskQueue.listNonTerminal({ sessionId: input.sessionId }))
      .find((record) => record.callIdentity === input.callIdentity);
  }
  if (queueRecord === undefined) {
    return undefined;
  }
  const task = await config.tasks.getTask({ sessionId: input.sessionId, taskId: queueRecord.taskId });
  const inputResult = await config.results.getByIdempotencyKey({
    sessionId: input.sessionId,
    idempotencyKey: `input:${input.callIdentity}`,
    sessionDataDir: input.sessionDataDir,
  });
  if (task === undefined || inputResult === undefined) {
    throw new HarnessInputError("Async launch transaction is incomplete.", {
      sessionId: input.sessionId,
      callIdentity: input.callIdentity,
      queueId: queueRecord.queueId,
      taskId: queueRecord.taskId,
    });
  }
  if (task.callIdentity !== input.callIdentity || task.queueId !== queueRecord.queueId) {
    await config.tasks.updateTask(compact({
      ...task,
      callIdentity: input.callIdentity,
      queueId: queueRecord.queueId,
    }) as HarnessTaskRecord);
  }
  return {
    task: await config.tasks.getTask({ sessionId: input.sessionId, taskId: queueRecord.taskId }) ?? task,
    inputResult: inputResult.record,
    queueRecord,
  };
}

function assertWorkflowReplayEnvelope(
  input: Parameters<HarnessWorkflowLaunchLedger["reserveLaunch"]>[0],
  record: HarnessWorkflowQueueRecord,
): void {
  assertReplayField("workflowId", input.workflowId, record.workflowId);
  assertReplayField("handle", input.handle, record.handle);
  assertReplayField("disposition", input.disposition, record.disposition);
  assertReplayField("inputHash", input.inputHash, record.inputHash);
  assertReplayField("source", input.source, record.source);
  assertReplayField("originTurnId", input.originTurnId, record.originTurnId);
  assertReplayField("reservationScopeId", input.reservationScopeId, record.reservationScopeId);
  assertReplayField("reservationOrder", input.reservationOrder, record.reservationOrder);
  assertReplayField("scopeSize", input.scopeSize, record.scopeSize);
  assertReplayField("toolCallId", input.toolCallId, record.toolCallId);
  assertReplayField("launcherHandle", input.launcherHandle, record.launcherHandle);
  assertReplayHash("workflowDefinitionIdentity", input.workflowDefinitionIdentity, record.workflowDefinitionIdentity);
  assertReplayField("workflowVersionId", input.workflowVersionId, record.workflowVersionId);
  assertReplayField("memoryScope", input.memoryScope, record.memoryScope);
  assertReplayField("workflowSetMemoryKey", input.workflowSetMemoryKey, record.workflowSetMemoryKey);
  assertReplayHash("workflowSetDefinitionIdentities", input.workflowSetDefinitionIdentities, record.workflowSetDefinitionIdentities);
  assertReplayHash("inheritance", input.inheritance, record.inheritance);
  assertReplayHash("dynamicCapabilitySnapshot", input.dynamicCapabilitySnapshot, record.dynamicCapabilitySnapshot);
}

function assertAsyncReplayEnvelope(
  input: Parameters<HarnessAsyncLaunchLedger["reserveLaunch"]>[0],
  record: HarnessAsyncTaskQueueRecord,
): void {
  assertReplayField("kind", input.kind, record.kind);
  assertReplayField("handle", input.handle, record.handle);
  assertReplayField("inputHash", input.inputHash, record.inputHash);
  assertReplayField("originTurnId", input.originTurnId, record.originTurnId);
  assertReplayField("reservationScopeId", input.reservationScopeId, record.reservationScopeId);
  assertReplayField("reservationOrder", input.reservationOrder, record.reservationOrder);
  assertReplayField("scopeSize", input.scopeSize, record.scopeSize);
  assertReplayField("toolCallId", input.toolCallId, record.toolCallId);
  assertReplayField("approvalPolicy", input.approvalPolicy, record.approvalPolicy);
  assertReplayField("recoverableAfterCrash", input.recoverableAfterCrash, record.recoverableAfterCrash);
  assertReplayField("operationId", input.operationId, record.operationId);
  assertReplayHash("permissionSnapshot", input.permissionSnapshot, record.permissionSnapshot);
  assertReplayHash("capabilitySnapshot", input.capabilitySnapshot, record.capabilitySnapshot);
}

function assertReplayField(label: string, incoming: unknown, persisted: unknown): void {
  if (incoming !== persisted) {
    throw new HarnessInputError("Replay identity mismatch for durable launch.", {
      field: label,
      incoming,
      persisted,
    });
  }
}

function assertReplayHash(label: string, incoming: unknown, persisted: unknown): void {
  if (stableHash(incoming) !== stableHash(persisted)) {
    throw new HarnessInputError("Replay identity mismatch for durable launch.", {
      field: label,
    });
  }
}

function workflowLaunchEnvelopeHash(
  input: Parameters<HarnessWorkflowLaunchLedger["reserveLaunch"]>[0],
): string {
  return stableHash({
    workflowId: input.workflowId,
    handle: input.handle,
    disposition: input.disposition,
    inputHash: input.inputHash,
    source: input.source,
    originTurnId: input.originTurnId,
    reservationScopeId: input.reservationScopeId,
    reservationOrder: input.reservationOrder,
    scopeSize: input.scopeSize,
    toolCallId: input.toolCallId,
    launcherHandle: input.launcherHandle,
    workflowDefinitionIdentity: input.workflowDefinitionIdentity,
    workflowVersionId: input.workflowVersionId,
    memoryScope: input.memoryScope,
    workflowSetMemoryKey: input.workflowSetMemoryKey,
    workflowSetDefinitionIdentities: input.workflowSetDefinitionIdentities,
    inheritance: input.inheritance,
    dynamicCapabilitySnapshot: input.dynamicCapabilitySnapshot,
  });
}

function asyncLaunchEnvelopeHash(
  input: Parameters<HarnessAsyncLaunchLedger["reserveLaunch"]>[0],
): string {
  return stableHash({
    kind: input.kind,
    handle: input.handle,
    inputHash: input.inputHash,
    originTurnId: input.originTurnId,
    reservationScopeId: input.reservationScopeId,
    reservationOrder: input.reservationOrder,
    scopeSize: input.scopeSize,
    toolCallId: input.toolCallId,
    approvalPolicy: input.approvalPolicy,
    recoverableAfterCrash: input.recoverableAfterCrash,
    operationId: input.operationId,
    permissionSnapshot: input.permissionSnapshot,
    capabilitySnapshot: input.capabilitySnapshot,
  });
}

function assertLaunchTransactionEnvelope(
  transaction: LaunchTransactionRecord,
  envelopeHash: string,
): void {
  if (transaction.envelopeHash !== envelopeHash) {
    throw new HarnessInputError("Replay identity mismatch for durable launch.", {
      field: "launchTransactionEnvelope",
    });
  }
}

function launchTaskReservationIdentity(kind: LaunchTransactionKind, callIdentity: string): string {
  return `launch-task:${kind}:${callIdentity}`;
}

async function readLaunchTransaction(
  store: DurableJsonStore,
  rootDir: string,
  kind: LaunchTransactionKind,
  sessionId: string,
  callIdentity: string,
): Promise<LaunchTransactionRecord | undefined> {
  return store.readJson<LaunchTransactionRecord>(launchTransactionPath(rootDir, kind, sessionId, callIdentity));
}

async function writeLaunchTransaction(
  store: DurableJsonStore,
  rootDir: string,
  record: LaunchTransactionRecord,
): Promise<LaunchTransactionRecord> {
  await store.writeJson(launchTransactionPath(rootDir, record.kind, record.sessionId, record.callIdentity), record);
  return record;
}

async function maybeInjectFault(
  faultInjection: LocalHarnessDurableServicesFaultInjection | undefined,
  point: LocalHarnessDurableServicesFaultPoint,
): Promise<void> {
  await faultInjection?.onPoint?.(point);
}

async function writeResultRecord(
  store: DurableJsonStore,
  rootDir: string,
  record: HarnessStoredResult,
  faultInjection?: LocalHarnessDurableServicesFaultInjection,
  faultPoint: LocalHarnessDurableServicesFaultPoint = "result-allocate-after-session-record-write",
): Promise<void> {
  await store.writeJson(resultRecordPath(record), record);
  await maybeInjectFault(faultInjection, faultPoint);
  await store.writeJson(resultIndexPath(rootDir, record.sessionId, record.resultId), resultIndexRecord(record));
}

async function readResultByIdIndex(
  store: DurableJsonStore,
  rootDir: string,
  sessionId: string,
  resultId: string,
): Promise<HarnessStoredResult | undefined> {
  const index = await store.readJson<ResultIndexRecord>(resultIndexPath(rootDir, sessionId, resultId));
  return index === undefined ? undefined : resultRecordFromIndex(store, index);
}

async function readResultByKeyIndex(
  store: DurableJsonStore,
  rootDir: string,
  sessionId: string,
  idempotencyKey: string,
): Promise<HarnessStoredResult | undefined> {
  const index = await store.readJson<ResultIndexRecord>(resultKeyPath(rootDir, sessionId, idempotencyKey));
  return index === undefined ? undefined : resultRecordFromIndex(store, index);
}

async function resultRecordFromIndex(store: DurableJsonStore, index: ResultIndexRecord): Promise<HarnessStoredResult | undefined> {
  return store.readJson<HarnessStoredResult>(resultRecordPath(index));
}

async function writeResultKeyIndex(store: DurableJsonStore, rootDir: string, record: HarnessStoredResult): Promise<void> {
  if (record.idempotencyKey !== undefined) {
    await store.writeJson(resultKeyPath(rootDir, record.sessionId, record.idempotencyKey), resultIndexRecord(record));
  }
}

function resultIndexRecord(record: HarnessStoredResult): ResultIndexRecord {
  return compact({
    sessionId: record.sessionId,
    resultId: record.resultId,
    sessionDataDir: record.sessionDataDir,
    idempotencyKey: record.idempotencyKey,
  }) as ResultIndexRecord;
}

async function reconcileResultRecord(
  store: DurableJsonStore,
  rootDir: string,
  record: HarnessStoredResult,
): Promise<HarnessStoredResult> {
  const sessionRecord = await store.readJson<HarnessStoredResult>(resultRecordPath(record));
  const resolved = bestResultRecord([record, sessionRecord].filter((candidate): candidate is HarnessStoredResult =>
    candidate !== undefined
  ));
  if (stableHash(resolved) !== stableHash(record)) {
    await writeResultRecord(store, rootDir, resolved);
    if (resolved.idempotencyKey !== undefined) {
      await writeResultKeyIndex(store, rootDir, resolved);
    }
  }
  return resolved;
}

async function resultHighWaterMark(store: DurableJsonStore, rootDir: string, sessionId: string, sessionDataDir?: string): Promise<number> {
  const meta = await store.readJson<{ readonly highWaterMark: number }>(resultMetaPath(rootDir, sessionId));
  const indexRecords = await listJsonRecords<ResultIndexRecord>(store, join(rootDir, "result-index", sessionKey(sessionId), "by-result"));
  const sessionRecords = sessionDataDir === undefined ? [] : await listSessionResultRecords(store, sessionDataDir, sessionId);
  const records = [...indexRecords, ...sessionRecords];
  const recordHighWaterMark = records.reduce((max, record) => Math.max(max, resultNumber(record.resultId)), 0);
  return Math.max(meta?.highWaterMark ?? 0, recordHighWaterMark);
}

async function findResultRecordByIdempotencyKey(
  store: DurableJsonStore,
  rootDir: string,
  sessionId: string,
  idempotencyKey: string,
  sessionDataDir?: string,
): Promise<HarnessStoredResult | undefined> {
  const indexRecords = await listJsonRecords<ResultIndexRecord>(store, join(rootDir, "result-index", sessionKey(sessionId), "by-result"));
  const indexedMatches = (await Promise.all(indexRecords
    .filter((record) => record.idempotencyKey === idempotencyKey)
    .map((record) => resultRecordFromIndex(store, record))))
    .filter((record): record is HarnessStoredResult => record !== undefined);
  const sessionRecords = sessionDataDir === undefined ? [] : await listSessionResultRecords(store, sessionDataDir, sessionId);
  const records = [...indexedMatches, ...sessionRecords];
  const matches = records.filter((record) => record.idempotencyKey === idempotencyKey);
  return matches.length === 0 ? undefined : bestResultRecord(matches);
}

async function listSessionResultRecords(
  store: DurableJsonStore,
  sessionDataDir: string,
  sessionId: string,
): Promise<readonly HarnessStoredResult[]> {
  const resultDirs = await store.listDir(join(sessionDataDir, "results"));
  const records = await Promise.all(resultDirs.map((resultDir) =>
    store.readJson<HarnessStoredResult>(join(sessionDataDir, "results", resultDir, "record.json"))
  ));
  return records.filter((record): record is HarnessStoredResult =>
    record !== undefined && record.sessionId === sessionId
  );
}

function bestResultRecord(records: readonly HarnessStoredResult[]): HarnessStoredResult {
  const [first, ...rest] = records;
  if (first === undefined) {
    throw new Error("Cannot choose a result record from an empty list.");
  }
  return rest.reduce((best, candidate) => isResultRecordNewer(candidate, best) ? candidate : best, first);
}

function isResultRecordNewer(candidate: HarnessStoredResult, current: HarnessStoredResult): boolean {
  if (candidate.committedAt !== undefined && current.committedAt === undefined) {
    return true;
  }
  if (candidate.committedAt !== undefined && current.committedAt !== undefined) {
    return candidate.committedAt >= current.committedAt;
  }
  return false;
}

async function ensureResultHighWaterMarkAtLeast(
  store: DurableJsonStore,
  rootDir: string,
  sessionId: string,
  minimum: number,
): Promise<void> {
  const current = await store.readJson<{ readonly highWaterMark: number }>(resultMetaPath(rootDir, sessionId));
  if ((current?.highWaterMark ?? 0) < minimum) {
    await store.writeJson(resultMetaPath(rootDir, sessionId), { highWaterMark: minimum });
  }
}

async function taskLedgerHighWaterMark(
  store: DurableJsonStore,
  rootDir: string,
  sessionId: string,
): Promise<number> {
  const meta = await store.readJson<{ readonly highWaterMark: number }>(taskMetaPath(rootDir, sessionId));
  const records = await listJsonRecords<HarnessTaskRecord>(store, taskSessionDir(rootDir, sessionId));
  return Math.max(
    meta?.highWaterMark ?? 0,
    records.reduce((max, record) => Math.max(max, taskNumber(record.taskId)), 0),
  );
}

function durableRecordForReservedTask(
  input: HarnessTaskReserveInput,
  taskId: HarnessTaskId,
  now: string,
): HarnessTaskRecord {
  return compact({
    taskId,
    sessionId: input.sessionId,
    kind: input.kind,
    source: input.source,
    status: "queued",
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

function validateDurableAgentGroupTaskBatchJournal(
  journal: DurableAgentGroupTaskBatchJournal,
  sessionId: string,
  callIdentity: string,
): void {
  if (journal.schemaVersion !== "little-harness.agent-group-task-batch.v1" ||
      journal.sessionId !== sessionId || journal.callIdentity !== callIdentity ||
      journal.scopeIdentity.length === 0 || journal.canonicalInputDigest.length === 0 ||
      (journal.state !== "prepared" && journal.state !== "committed") ||
      !Number.isSafeInteger(journal.firstTaskNumber) || journal.firstTaskNumber < 1 ||
      !Number.isSafeInteger(journal.lastTaskNumber) ||
      journal.lastTaskNumber < journal.firstTaskNumber ||
      journal.lastTaskNumber - journal.firstTaskNumber + 1 > 10_000 ||
      journal.recordsDigest.length === 0 ||
      journal.reservationDigest.length === 0 ||
      (journal.state === "prepared" &&
        (!Array.isArray(journal.records) ||
          journal.lastTaskNumber !== journal.firstTaskNumber + journal.records.length - 1 ||
          stableHash(journal.records) !== journal.recordsDigest ||
          stableHash(journal.records.map(durableAgentGroupReservationProjection)) !==
            journal.reservationDigest ||
          stableHash({
            domain: "little-harness.agent-group-task-batch.v1",
            sessionId: journal.sessionId,
            callIdentity: journal.callIdentity,
            scopeIdentity: journal.scopeIdentity,
            tasks: journal.records.map(durableAgentGroupReservationInput),
          }) !== journal.canonicalInputDigest ||
          new Set(journal.records.map((record) => record.callIdentity)).size !== journal.records.length ||
          journal.records.some((record, index) => !validPreparedAgentGroupReservationRecord(
            record,
            journal,
            index,
          )))) ||
      (journal.state === "committed" && journal.records !== undefined)) {
    throw new HarnessInputError("Stored Agent Group task-batch journal is invalid.");
  }
}

async function durableAgentGroupTaskBatchRecords(
  store: DurableJsonStore,
  rootDir: string,
  journal: DurableAgentGroupTaskBatchJournal,
): Promise<readonly HarnessTaskRecord[]> {
  if (journal.records !== undefined) return journal.records;
  const records = Object.freeze(await Promise.all(Array.from(
    { length: journal.lastTaskNumber - journal.firstTaskNumber + 1 },
    async (_, index) => await store.readJson<HarnessTaskRecord>(
      taskPath(rootDir, journal.sessionId, `task_${journal.firstTaskNumber + index}`),
    ),
  )));
  if (records.some((record) => record === undefined) ||
      (records as HarnessTaskRecord[]).some((record, index) =>
        !validAgentGroupLiveTaskRecord(record, journal, index)) ||
      stableHash((records as HarnessTaskRecord[]).map(durableAgentGroupReservationProjection)) !==
        journal.reservationDigest ||
      stableHash({
        domain: "little-harness.agent-group-task-batch.v1",
        sessionId: journal.sessionId,
        callIdentity: journal.callIdentity,
        scopeIdentity: journal.scopeIdentity,
        tasks: (records as HarnessTaskRecord[]).map(durableAgentGroupReservationInput),
      }) !== journal.canonicalInputDigest) {
    throw new HarnessInputError("Committed Agent Group task-batch records are missing or inconsistent.");
  }
  return records as readonly HarnessTaskRecord[];
}

async function readDurableAgentGroupAcceptedStartReceipt(
  store: DurableJsonStore,
  rootDir: string,
  journal: DurableAgentGroupTaskBatchJournal,
): Promise<readonly HarnessTaskRecord[] | undefined> {
  const authority = await readDurableAgentGroupPageAuthority(
    store,
    rootDir,
    journal.sessionId,
    journal.scopeIdentity,
  );
  if (authority === undefined) return undefined;
  if (authority.state.launchCallIdentity !== journal.callIdentity ||
      authority.state.memberCount !== journal.lastTaskNumber - journal.firstTaskNumber + 1) {
    throw new HarnessInputError("Stored Agent Group accepted-start authority conflicts with its task batch.");
  }
  const members = Object.freeze(await Promise.all(Array.from(
    { length: authority.state.memberCount },
    async (_, memberIndex) => await readDurableAgentGroupPageMember(
      store,
      rootDir,
      journal.sessionId,
      journal.scopeIdentity,
      memberIndex,
    ),
  )));
  if (members.some((member) => member === undefined)) {
    throw new HarnessInputError("Stored Agent Group accepted-start member authority is incomplete.");
  }
  const records = (members as readonly DurableAgentGroupPageMember[]).map((member) => member.record);
  const accepted = createAgentGroupAcceptedStartReceipt({
    sessionId: journal.sessionId,
    scopeIdentity: journal.scopeIdentity,
    groupRef: authority.state.groupRef,
    acceptedAt: authority.state.launchAcceptedAt,
    records,
  });
  if (accepted === undefined ||
      stableHash(accepted.map(durableAgentGroupReservationProjection)) !== journal.reservationDigest) {
    throw new HarnessInputError("Stored Agent Group accepted-start receipt is invalid.");
  }
  const binding = {
    sessionId: journal.sessionId,
    scopeIdentity: journal.scopeIdentity,
    groupRef: authority.state.groupRef,
    acceptedAt: authority.state.launchAcceptedAt,
    launchCallIdentity: journal.callIdentity,
    observationMode: "paged_changes" as const,
    members: Object.freeze(accepted.map((record, memberIndex) => Object.freeze({
      taskId: record.taskId,
      memberId: `member_${memberIndex + 1}`,
      memberIndex,
      taskRef: record.externalAgentTaskRef!,
    }))),
  };
  if (durableAgentGroupPageStartEnvelopeDigest(binding, accepted) !== authority.startEnvelopeDigest) {
    throw new HarnessInputError("Stored Agent Group accepted-start receipt conflicts with its start envelope.");
  }
  return accepted;
}

function durableAgentGroupReservationInput(record: HarnessTaskRecord): Record<string, unknown> {
  return compact({
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
  });
}

function durableAgentGroupReservationProjection(record: HarnessTaskRecord): Record<string, unknown> {
  return {
    taskId: record.taskId,
    sessionId: record.sessionId,
    createdAt: record.createdAt,
    ...durableAgentGroupReservationInput(record),
  };
}

function validPreparedAgentGroupReservationRecord(
  record: HarnessTaskRecord,
  journal: DurableAgentGroupTaskBatchJournal,
  memberIndex: number,
): boolean {
  return validAgentGroupReservationIdentityRecord(record, journal, memberIndex) &&
    record.status === "queued" && record.updatedAt === record.createdAt &&
    record.externalAgentGroupRef === undefined && record.externalAgentTaskRef === undefined &&
    record.externalAgentResultRef === undefined && record.agentGroupRevision === undefined &&
    record.agentGroupStatus === undefined && record.agentMemberRevision === undefined &&
    record.terminalResultId === undefined && record.outputSummary === undefined &&
    record.outputPath === undefined && record.error === undefined &&
    record.terminalCauseCode === undefined && record.terminalMessage === undefined &&
    record.terminalDiagnostic === undefined;
}

function validAgentGroupLiveTaskRecord(
  record: HarnessTaskRecord,
  journal: DurableAgentGroupTaskBatchJournal,
  memberIndex: number,
): boolean {
  const bound = record.externalAgentGroupRef !== undefined ||
    record.externalAgentTaskRef !== undefined || record.agentLaunchAcceptedAt !== undefined;
  const projected = record.agentGroupRevision !== undefined || record.agentGroupStatus !== undefined ||
    record.agentGroupObservationDigest !== undefined || record.agentGroupObservedAt !== undefined ||
    record.agentMemberRevision !== undefined || record.agentMemberObservationDigest !== undefined ||
    record.agentMemberStateDigest !== undefined || record.agentMemberObservedAt !== undefined;
  const terminal = record.status === "completed" || record.status === "failed" ||
    record.status === "cancelled";
  return validAgentGroupReservationIdentityRecord(record, journal, memberIndex) &&
    validStoredTaskStatus(record.status) &&
    (record.source === undefined || record.source === "static" || record.source === "dynamic") &&
    Number.isFinite(Date.parse(record.updatedAt)) && record.updatedAt >= record.createdAt &&
    (!terminal
      ? record.terminalResultId === undefined && record.error === undefined &&
        record.terminalCauseCode === undefined && record.terminalMessage === undefined &&
        record.terminalDiagnostic === undefined
      : record.terminalCauseCode === undefined || HARNESS_FAILURE_CAUSE_CODES.includes(record.terminalCauseCode)) &&
    (record.externalAgentResultRef === undefined ||
      terminal && typeof record.externalAgentResultRef === "string" &&
        record.externalAgentResultRef.length > 0) &&
    (bound
      ? typeof record.externalAgentGroupRef === "string" && record.externalAgentGroupRef.length > 0 &&
        typeof record.externalAgentTaskRef === "string" && record.externalAgentTaskRef.length > 0 &&
        Number.isFinite(Date.parse(record.agentLaunchAcceptedAt!)) &&
        record.agentLaunchAcceptedAt! >= record.createdAt && projected &&
        record.terminalResultId === undefined && record.outputPath === undefined
      : record.externalAgentGroupRef === undefined && record.externalAgentTaskRef === undefined &&
        record.agentLaunchAcceptedAt === undefined && !projected &&
        record.externalAgentResultRef === undefined) &&
    (!projected ||
      Number.isSafeInteger(record.agentGroupRevision) && record.agentGroupRevision! >= 0 &&
      validStoredAgentGroupStatus(record.agentGroupStatus) &&
      typeof record.agentGroupObservationDigest === "string" &&
        record.agentGroupObservationDigest.length > 0 &&
      Number.isFinite(Date.parse(record.agentGroupObservedAt!)) &&
      Number.isSafeInteger(record.agentMemberRevision) && record.agentMemberRevision! >= 0 &&
      typeof record.agentMemberObservationDigest === "string" &&
        record.agentMemberObservationDigest.length > 0 &&
      typeof record.agentMemberStateDigest === "string" && record.agentMemberStateDigest.length > 0 &&
      Number.isFinite(Date.parse(record.agentMemberObservedAt!))) &&
    ((record.agentJoinReductionRevision === undefined) ===
      (record.agentJoinReductionDigest === undefined)) &&
    (record.agentJoinReductionRevision === undefined ||
      Number.isSafeInteger(record.agentJoinReductionRevision) &&
      record.agentJoinReductionRevision >= 0 && record.agentJoinReductionDigest!.length > 0);
}

function validAgentGroupReservationIdentityRecord(
  record: HarnessTaskRecord,
  journal: DurableAgentGroupTaskBatchJournal,
  memberIndex: number,
): boolean {
  return record.sessionId === journal.sessionId &&
    record.taskId === `task_${journal.firstTaskNumber + memberIndex}` &&
    record.kind === "agent" && Number.isFinite(Date.parse(record.createdAt)) &&
    typeof record.callIdentity === "string" && record.callIdentity.length > 0 &&
    record.agentGroupScopeIdentity === journal.scopeIdentity &&
    record.agentMemberIndex === memberIndex && record.agentMemberId === `member_${memberIndex + 1}` &&
    typeof record.agentJoinPolicyHandle === "string" && record.agentJoinPolicyHandle.length > 0 &&
    (record.agentJoinPolicyKind === "all_success" || record.agentJoinPolicyKind === "all_terminal" ||
      record.agentJoinPolicyKind === "any_success" || record.agentJoinPolicyKind === "quorum" ||
      record.agentJoinPolicyKind === "first_verified") &&
    (record.agentJoinPolicyKind === "quorum"
      ? Number.isSafeInteger(record.agentJoinQuorumCount) && record.agentJoinQuorumCount! >= 1
      : record.agentJoinQuorumCount === undefined) &&
    (record.agentJoinPolicyKind === "first_verified"
      ? typeof record.agentVerifierHandle === "string" && record.agentVerifierHandle.length > 0 &&
        typeof record.agentRequiredCheckSetHandle === "string" &&
          record.agentRequiredCheckSetHandle.length > 0
      : record.agentVerifierHandle === undefined && record.agentRequiredCheckSetHandle === undefined) &&
    typeof record.agentReductionPolicyHandle === "string" &&
      record.agentReductionPolicyHandle.length > 0 &&
    Number.isSafeInteger(record.agentMaxMemberSummaryBytes) && record.agentMaxMemberSummaryBytes! >= 0 &&
    Number.isSafeInteger(record.agentMaxGroupSummaryBytes) && record.agentMaxGroupSummaryBytes! >= 0 &&
    Number.isSafeInteger(record.agentMaxResultRefs) && record.agentMaxResultRefs! >= 0;
}

async function commitDurableAgentGroupTaskBatch(
  store: DurableJsonStore,
  rootDir: string,
  journal: DurableAgentGroupTaskBatchJournal,
  faultInjection: LocalHarnessDurableServicesFaultInjection | undefined,
): Promise<void> {
  validateDurableAgentGroupTaskBatchJournal(journal, journal.sessionId, journal.callIdentity);
  if (journal.state === "committed") return;
  const records = await durableAgentGroupTaskBatchRecords(store, rootDir, journal);
  for (const [index, record] of records.entries()) {
    const path = taskPath(rootDir, journal.sessionId, record.taskId);
    const existing = await store.readJson<HarnessTaskRecord>(path);
    if (existing !== undefined && stableHash(existing) !== stableHash(record)) {
      throw new HarnessInputError("Agent Group task-batch record conflicts with its prepared journal.");
    }
    if (existing === undefined) await store.writeJson(path, record);
    const bindingPath = callIdentityPath(rootDir, journal.sessionId, record.callIdentity!);
    const binding = await store.readJson<{ readonly taskId: HarnessTaskId }>(bindingPath);
    if (binding !== undefined && binding.taskId !== record.taskId) {
      throw new HarnessInputError("Agent Group task-batch call identity is already bound elsewhere.");
    }
    if (binding === undefined) await store.writeJson(bindingPath, { taskId: record.taskId });
    if (index === Math.floor(records.length / 2)) {
      await maybeInjectFault(faultInjection, "agent-group-batch-during-record-writes");
    }
  }
  await maybeInjectFault(faultInjection, "agent-group-batch-after-record-writes");
  const metaPath = taskMetaPath(rootDir, journal.sessionId);
  const meta = await store.readJson<{ readonly highWaterMark: number }>(metaPath);
  const currentHighWater = meta?.highWaterMark ?? 0;
  if (!Number.isSafeInteger(currentHighWater) || currentHighWater < journal.lastTaskNumber) {
    await store.writeJson(metaPath, { highWaterMark: journal.lastTaskNumber });
  }
  const { records: _records, ...compactJournal } = journal;
  await store.writeJson(
    agentGroupTaskBatchJournalPath(rootDir, journal.sessionId, journal.callIdentity),
    { ...compactJournal, state: "committed" },
  );
}

function taskPath(rootDir: string, sessionId: string, taskId: string): string {
  return join(taskSessionDir(rootDir, sessionId), `${recordKey(taskId)}.json`);
}

function taskSessionDir(rootDir: string, sessionId: string): string {
  return sessionCollectionDir(rootDir, "tasks", sessionId);
}

function taskMetaPath(rootDir: string, sessionId: string): string {
  return join(taskSessionDir(rootDir, sessionId), "meta.json");
}

function agentGroupTaskBatchJournalPath(
  rootDir: string,
  sessionId: string,
  callIdentity: string,
): string {
  return join(
    sessionCollectionDir(rootDir, "agent-group-task-batches", sessionId),
    `${recordKey(callIdentity)}.json`,
  );
}

function agentGroupProjectionAuthorityPath(
  rootDir: string,
  sessionId: string,
  scopeIdentity: string,
): string {
  return join(
    sessionCollectionDir(rootDir, "agent-group-projections", sessionId),
    `${recordKey(scopeIdentity)}.json`,
  );
}

function agentGroupPageDir(rootDir: string, sessionId: string, scopeIdentity: string): string {
  return join(
    sessionCollectionDir(rootDir, "agent-group-pages", sessionId),
    recordKey(scopeIdentity),
  );
}

function agentGroupPageAuthorityPath(rootDir: string, sessionId: string, scopeIdentity: string): string {
  return join(agentGroupPageDir(rootDir, sessionId, scopeIdentity), "authority.json");
}

function agentGroupPageCallPath(
  rootDir: string,
  sessionId: string,
  scopeIdentity: string,
  callIdentity: string,
): string {
  return join(
    agentGroupPageDir(rootDir, sessionId, scopeIdentity),
    "page-calls",
    `${recordKey(callIdentity)}.json`,
  );
}

function agentGroupRetiredPageCallPath(
  rootDir: string,
  sessionId: string,
  scopeIdentity: string,
  callIdentity: string,
): string {
  return join(
    agentGroupPageDir(rootDir, sessionId, scopeIdentity),
    "retired-page-calls",
    `${recordKey(callIdentity)}.json`,
  );
}

function agentGroupOperationResultPath(
  rootDir: string,
  sessionId: string,
  scopeIdentity: string,
  operationRef: string,
): string {
  return join(
    agentGroupPageDir(rootDir, sessionId, scopeIdentity),
    "operation-results",
    `${recordKey(operationRef)}.json`,
  );
}

function agentGroupPendingOperationPath(
  rootDir: string,
  sessionId: string,
  scopeIdentity: string,
  operationRef: string,
): string {
  return join(
    agentGroupPageDir(rootDir, sessionId, scopeIdentity),
    "operation-pending",
    `${recordKey(operationRef)}.json`,
  );
}

function agentGroupOperationVisibilityPath(
  rootDir: string,
  sessionId: string,
  scopeIdentity: string,
  operationRef: string,
): string {
  return join(
    agentGroupPageDir(rootDir, sessionId, scopeIdentity),
    "operation-visibility",
    `${recordKey(operationRef)}.json`,
  );
}

function agentGroupOperationIdempotencyPath(
  rootDir: string,
  sessionId: string,
  scopeIdentity: string,
  operationIdempotencyKey: string,
): string {
  return join(
    agentGroupPageDir(rootDir, sessionId, scopeIdentity),
    "operation-idempotency",
    `${recordKey(operationIdempotencyKey)}.json`,
  );
}

function agentGroupResultRefOwnerPath(rootDir: string, resultRef: string): string {
  return join(rootDir, "agent-group-result-ref-owners", `${recordKey(resultRef)}.json`);
}

function agentGroupResultRefIntentPath(rootDir: string, resultRef: string): string {
  return join(rootDir, "agent-group-result-ref-intents", `${recordKey(resultRef)}.json`);
}

function agentGroupPageMemberPath(
  rootDir: string,
  sessionId: string,
  scopeIdentity: string,
  memberIndex: number,
): string {
  return join(
    agentGroupPageDir(rootDir, sessionId, scopeIdentity),
    "members",
    `${safeDurableIndex(memberIndex, "Agent Group member")}.json`,
  );
}

function agentGroupPageSequencePath(
  rootDir: string,
  sessionId: string,
  scopeIdentity: string,
  sequence: number,
): string {
  return join(
    agentGroupPageDir(rootDir, sessionId, scopeIdentity),
    "sequences",
    `${safeDurableIndex(sequence, "Agent Group sequence")}.json`,
  );
}

function agentGroupPageStageDir(
  rootDir: string,
  sessionId: string,
  scopeIdentity: string,
  requestIdempotencyKey: string,
): string {
  return join(
    agentGroupPageDir(rootDir, sessionId, scopeIdentity),
    "stages",
    recordKey(requestIdempotencyKey),
  );
}

function agentGroupPageStageIntentPath(
  rootDir: string,
  sessionId: string,
  scopeIdentity: string,
  requestIdempotencyKey: string,
): string {
  return join(
    agentGroupPageStageDir(rootDir, sessionId, scopeIdentity, requestIdempotencyKey),
    "intent.json",
  );
}

function agentGroupPageStageCompletePath(
  rootDir: string,
  sessionId: string,
  scopeIdentity: string,
  requestIdempotencyKey: string,
): string {
  return join(
    agentGroupPageStageDir(rootDir, sessionId, scopeIdentity, requestIdempotencyKey),
    "complete.json",
  );
}

function agentGroupPageStageSequencePath(
  rootDir: string,
  sessionId: string,
  scopeIdentity: string,
  requestIdempotencyKey: string,
  sequence: number,
): string {
  return join(
    agentGroupPageStageDir(rootDir, sessionId, scopeIdentity, requestIdempotencyKey),
    "sequences",
    `${safeDurableIndex(sequence, "Agent Group stage sequence")}.json`,
  );
}

function agentGroupPageReceiptPath(
  rootDir: string,
  sessionId: string,
  scopeIdentity: string,
  requestIdempotencyKey: string,
): string {
  return join(
    agentGroupPageDir(rootDir, sessionId, scopeIdentity),
    "receipts",
    `${recordKey(requestIdempotencyKey)}.json`,
  );
}

function agentGroupPageCommitPath(
  rootDir: string,
  sessionId: string,
  scopeIdentity: string,
  requestIdempotencyKey: string,
): string {
  return join(
    agentGroupPageDir(rootDir, sessionId, scopeIdentity),
    "commits",
    `${recordKey(requestIdempotencyKey)}.json`,
  );
}

function agentGroupPageRefPath(rootDir: string, groupRef: string): string {
  return join(rootDir, "agent-group-page-refs", `${recordKey(groupRef)}.json`);
}

function agentGroupGarbageCollectionPath(rootDir: string, groupRef: string): string {
  return join(rootDir, "agent-group-gc", `${recordKey(groupRef)}.json`);
}

function agentGroupRetiredStartPath(rootDir: string, sessionId: string, callIdentity: string): string {
  return join(
    sessionCollectionDir(rootDir, "agent-group-retired-starts", sessionId),
    `${recordKey(callIdentity)}.json`,
  );
}

function callIdentityPath(rootDir: string, sessionId: string, callIdentity: string): string {
  return join(taskSessionDir(rootDir, sessionId), "call-identities", `${recordKey(callIdentity)}.json`);
}

function continuationPath(rootDir: string, continuationId: string): string {
  return join(rootDir, "continuations", `${recordKey(continuationId)}.json`);
}

function wakeupPath(rootDir: string, wakeupId: string): string {
  return join(rootDir, "wakeups", `${recordKey(wakeupId)}.json`);
}

function queuePath(rootDir: string, collection: string, sessionId: string, queueId: string): string {
  return join(queueSessionDir(rootDir, collection, sessionId), `${recordKey(queueId)}.json`);
}

function queueSessionDir(rootDir: string, collection: string, sessionId: string): string {
  return sessionCollectionDir(rootDir, collection, sessionId);
}

function launchTransactionPath(
  rootDir: string,
  kind: LaunchTransactionKind,
  sessionId: string,
  callIdentity: string,
): string {
  return join(sessionCollectionDir(rootDir, "launch-transactions", sessionId), kind, `${recordKey(callIdentity)}.json`);
}

function preparedWorkflowPath(rootDir: string, sessionId: string, workflowId: string, versionId: string): string {
  return join(sessionCollectionDir(rootDir, "prepared-workflows", sessionId), `${recordKey({ workflowId, versionId })}.json`);
}

function preparedWorkflowRunPath(rootDir: string, sessionId: string, runPreparedCallIdentity: string): string {
  return join(sessionCollectionDir(rootDir, "prepared-workflow-runs", sessionId), `${recordKey(runPreparedCallIdentity)}.json`);
}

function resumeQueuePath(rootDir: string, resumeId: string): string {
  return join(rootDir, "resume-queue", `${recordKey(resumeId)}.json`);
}

function resultMetaPath(rootDir: string, sessionId: string): string {
  return join(rootDir, "result-index", sessionKey(sessionId), "meta.json");
}

function resultIndexPath(rootDir: string, sessionId: string, resultId: string): string {
  return join(rootDir, "result-index", sessionKey(sessionId), "by-result", `${recordKey(resultId)}.json`);
}

function resultKeyPath(rootDir: string, sessionId: string, idempotencyKey: string): string {
  return join(rootDir, "result-index", sessionKey(sessionId), "by-key", `${recordKey(idempotencyKey)}.json`);
}

function resultRecordPath(record: Pick<HarnessStoredResult, "sessionDataDir" | "resultId">): string {
  return join(record.sessionDataDir, "results", record.resultId, "record.json");
}

function resultValuePath(record: Pick<HarnessStoredResult, "sessionDataDir" | "resultId">): string {
  return join(record.sessionDataDir, "results", record.resultId, "value.json");
}

function resultGrantPath(rootDir: string, resultGrantId: string): string {
  return join(rootDir, "result-grants", `${recordKey(resultGrantId)}.json`);
}

function sessionCollectionDir(rootDir: string, collection: string, sessionId: string): string {
  return join(rootDir, collection, sessionKey(sessionId));
}

function sessionKey(sessionId: string): string {
  return stableHash({ kind: "session", sessionId }, { format: "base32hex" });
}

async function assertFileStorePathSafety(rootDir: string, path: string): Promise<void> {
  if (!isAbsolute(path)) {
    throw new HarnessInputError("Durable file-store paths must be absolute.");
  }
  const root = resolve(rootDir);
  const candidate = resolve(path);
  const fromRoot = relative(root, candidate);
  // Result values may intentionally live in a separately validated session
  // data directory. The store only owns and fences paths under its ledger root.
  if (fromRoot !== "" && (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot))) {
    return;
  }
  const segments = fromRoot === "" ? [] : fromRoot.split(sep).filter(Boolean);
  let current = root;
  for (let index = -1; index < segments.length; index += 1) {
    if (index >= 0) current = join(current, segments[index]!);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) {
        throw new HarnessInputError("Durable file-store paths cannot traverse symbolic links.", {
          rootDir: root,
          path: candidate,
        });
      }
      if (index < segments.length - 1 && !info.isDirectory()) {
        throw new HarnessInputError("Durable file-store path parent is not a directory.", {
          rootDir: root,
          path: candidate,
        });
      }
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return;
      throw error;
    }
  }
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function writeDurableJsonImmutable(
  store: DurableJsonStore,
  path: string,
  value: unknown,
  label: string,
): Promise<void> {
  const existing = await store.readJson<unknown>(path);
  if (existing !== undefined) {
    if (stableHash(existing) !== stableHash(value)) {
      throw new HarnessInputError(`${label} conflicts with immutable durable bytes.`);
    }
    return;
  }
  await store.writeJson(path, value);
}

async function removeDurableTree(store: DurableJsonStore, dir: string): Promise<void> {
  for (const child of await store.listDir(dir)) {
    const childPath = join(dir, child);
    if ((await store.listDir(childPath)).length > 0) {
      await removeDurableTree(store, childPath);
    } else {
      await store.remove(childPath);
    }
  }
  await store.remove(dir);
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`);
  await rename(tempPath, path);
}

/** Budget acknowledgements include data and directory durability; ordinary ledger writes stay unchanged. */
async function writeBudgetJsonDurably(path: string, value: unknown): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  // Sync the complete ancestor chain, including an existing directory from an earlier lost ack.
  for (let current = directory; ; current = dirname(current)) {
    const parent = await open(current, "r");
    try { await parent.sync(); } finally { await parent.close(); }
    if (dirname(current) === current) break;
  }
  const temporary = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.budget-tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(`${JSON.stringify(value)}\n`); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, path);
  const parent = await open(directory, "r");
  try { await parent.sync(); } finally { await parent.close(); }
}

async function withFileLock<T>(rootDir: string, scope: unknown, fn: () => Promise<T>): Promise<T> {
  const lockPath = join(rootDir, ".locks", `${recordKey(scope)}.lock`);
  await mkdir(dirname(lockPath), { recursive: true });
  const owner = createLockOwner();
  // Budget restarts must not wait beyond the acquisition timeout for a proven-dead owner.
  const recoverDeadOwner = typeof scope === "object" && scope !== null && "kind" in scope && scope.kind === "logical-turn-budget";
  await acquireLock(lockPath, owner, recoverDeadOwner);
  const stopHeartbeat = startLockHeartbeat(lockPath, owner);
  try {
    return await fn();
  } finally {
    stopHeartbeat();
    await rm(lockPath, { recursive: true, force: true });
  }
}

async function acquireLock(lockPath: string, owner: FileLockOwner, recoverDeadOwner = false): Promise<void> {
  const startedAt = Date.now();
  while (true) {
    try {
      await mkdir(lockPath);
      await writeLockOwner(lockPath, owner);
      return;
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") {
        throw error;
      }
      if (await isStaleLock(lockPath, recoverDeadOwner)) {
        await rm(lockPath, { recursive: true, force: true });
        continue;
      }
      if (Date.now() - startedAt > LOCK_TIMEOUT_MS) {
        throw new Error(`Timed out acquiring durable lock: ${lockPath}`);
      }
      await sleep(5);
    }
  }
}

async function isStaleLock(lockPath: string, recoverDeadOwner = false): Promise<boolean> {
  try {
    const ownerState = await readLockOwner(lockPath);
    if (recoverDeadOwner && ownerState.owner !== undefined && !isProcessAlive(ownerState.owner.pid)) return true;
    const info = ownerState.hasOwnerFile ? await stat(lockOwnerPath(lockPath)) : await stat(lockPath);
    if (Date.now() - info.mtimeMs <= LOCK_STALE_MS) {
      return false;
    }
    return ownerState.owner === undefined || !isProcessAlive(ownerState.owner.pid);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function createLockOwner(): FileLockOwner {
  const now = new Date().toISOString();
  return {
    pid: process.pid,
    token: `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`,
    acquiredAt: now,
    updatedAt: now,
  };
}

function startLockHeartbeat(lockPath: string, owner: FileLockOwner): () => void {
  const timer = setInterval(() => {
    void writeLockOwner(lockPath, { ...owner, updatedAt: new Date().toISOString() }).catch(() => {});
  }, LOCK_HEARTBEAT_MS);
  timer.unref();
  return () => clearInterval(timer);
}

async function writeLockOwner(lockPath: string, owner: FileLockOwner): Promise<void> {
  const ownerPath = lockOwnerPath(lockPath);
  const tempPath = `${ownerPath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(owner, null, 2)}\n`);
  await rename(tempPath, ownerPath);
}

function lockOwnerPath(lockPath: string): string {
  return join(lockPath, "owner.json");
}

async function readLockOwner(lockPath: string): Promise<{
  readonly hasOwnerFile: boolean;
  readonly owner?: FileLockOwner;
}> {
  try {
    return {
      hasOwnerFile: true,
      owner: JSON.parse(await readFile(lockOwnerPath(lockPath), "utf8")) as FileLockOwner,
    };
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return { hasOwnerFile: false };
    }
    if (error instanceof SyntaxError) {
      return { hasOwnerFile: true };
    }
    throw error;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isNodeError(error) && (error.code === "ESRCH" || error.code === "EPERM")) {
      return error.code === "EPERM";
    }
    throw error;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function listJsonRecords<T>(store: DurableJsonStore, dir: string): Promise<T[]> {
  const names = await store.listDir(dir);
  const records: T[] = [];
  for (const name of names) {
    if (!name.endsWith(".json") || name === "meta.json") {
      continue;
    }
    const record = await store.readJson<T>(join(dir, name));
    if (record !== undefined) {
      records.push(record);
    }
  }
  return records;
}

async function listSessionRecords<T>(store: DurableJsonStore, rootDir: string, collection: string): Promise<T[]> {
  const sessions = await store.listDir(join(rootDir, collection));
  const records: T[] = [];
  for (const session of sessions) {
    records.push(...await listJsonRecords<T>(store, join(rootDir, collection, session)));
  }
  return records;
}

function compact(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function optionalRecord<TBase extends Record<string, unknown>, TRecord>(
  base: TBase,
  record: TRecord | undefined,
): TBase | (TBase & { readonly record: TRecord }) {
  if (record === undefined) {
    return base;
  }
  return { ...base, record };
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function taskNumber(taskId: string): number {
  return Number(taskId.replace(/^task_/u, ""));
}

function safeDurableIndex(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new HarnessInputError(`${label} index is invalid.`);
  }
  return value;
}

function resultNumber(resultId: string): number {
  return Number(resultId.replace(/^result_/u, ""));
}

function isTerminal(status: HarnessTaskStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function isWorkflowTerminal(status: HarnessWorkflowQueueRecord["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function isTaskQueueTerminal(status: HarnessAsyncTaskQueueRecord["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function leaseIsActive(expiresAt: string | undefined): boolean {
  return expiresAt === undefined || expiresAt > new Date().toISOString();
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}
