import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { HarnessInputError } from "../errors.js";
import type { HarnessDurableServices, HarnessOrchestrationServices } from "../types.js";
import { stableHash } from "../utils/canonical-hash.js";
import { recordKey, type DurableJsonStore } from "./durable-store.js";
import type {
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

export function createLocalHarnessDurableServices(
  options: LocalHarnessDurableServicesOptions,
): HarnessDurableServices {
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
    readJson,
    writeJson,
    async remove(path) {
      await rm(path, { force: true });
    },
    async listDir(dir) {
      try {
        return await readdir(dir);
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") {
          return [];
        }
        throw error;
      }
    },
    async withLock(scope, fn) {
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
    async getTask(input) {
      return store.readJson<HarnessTaskRecord>(taskPath(rootDir, input.sessionId, input.taskId));
    },
    async listTasks(filter) {
      const records = filter?.sessionId === undefined
        ? await listSessionRecords<HarnessTaskRecord>(store, rootDir, "tasks")
        : await listJsonRecords<HarnessTaskRecord>(store, taskSessionDir(rootDir, filter.sessionId));
      if (filter?.statuses === undefined) {
        return records;
      }
      return records.filter((record) => filter.statuses?.includes(record.status) ?? false);
    },
    async updateTask(record) {
      await store.withLock(["task-record", record.sessionId, record.taskId], async () => {
        const existing = await this.getTask({ sessionId: record.sessionId, taskId: record.taskId });
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
    async markTerminal(input, terminal) {
      await store.withLock(["task-record", input.sessionId, input.taskId], async () => {
        const existing = await this.getTask(input);
        if (existing === undefined || isTerminal(existing.status)) {
          return;
        }
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
      const meta = await store.readJson<{ readonly highWaterMark: number }>(taskMetaPath(rootDir, sessionId));
      const records = await listJsonRecords<HarnessTaskRecord>(store, taskSessionDir(rootDir, sessionId));
      const recordHighWaterMark = records.reduce((max, record) => Math.max(max, taskNumber(record.taskId)), 0);
      return Math.max(meta?.highWaterMark ?? 0, recordHighWaterMark);
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
        const records = await this.listOpen(sessionId);
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

function taskPath(rootDir: string, sessionId: string, taskId: string): string {
  return join(taskSessionDir(rootDir, sessionId), `${recordKey(taskId)}.json`);
}

function taskSessionDir(rootDir: string, sessionId: string): string {
  return sessionCollectionDir(rootDir, "tasks", sessionId);
}

function taskMetaPath(rootDir: string, sessionId: string): string {
  return join(taskSessionDir(rootDir, sessionId), "meta.json");
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

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`);
  await rename(tempPath, path);
}

async function withFileLock<T>(rootDir: string, scope: unknown, fn: () => Promise<T>): Promise<T> {
  const lockPath = join(rootDir, ".locks", `${recordKey(scope)}.lock`);
  await mkdir(dirname(lockPath), { recursive: true });
  const owner = createLockOwner();
  await acquireLock(lockPath, owner);
  const stopHeartbeat = startLockHeartbeat(lockPath, owner);
  try {
    return await fn();
  } finally {
    stopHeartbeat();
    await rm(lockPath, { recursive: true, force: true });
  }
}

async function acquireLock(lockPath: string, owner: FileLockOwner): Promise<void> {
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
      if (await isStaleLock(lockPath)) {
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

async function isStaleLock(lockPath: string): Promise<boolean> {
  try {
    const ownerState = await readLockOwner(lockPath);
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
