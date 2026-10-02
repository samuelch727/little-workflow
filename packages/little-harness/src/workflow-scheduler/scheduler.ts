import { HarnessInputError } from "../errors.js";
import type { HarnessDurableServices } from "../types.js";
import { stableHash } from "../utils/canonical-hash.js";
import type { WorkflowLaunchTransactionInput, WorkflowReserveInput, WorkflowReserveResult } from "./types.js";
import { modelFacingWorkflowStatus } from "./types.js";

export type CreateWorkflowSchedulerOptions = {
  readonly durable: Pick<HarnessDurableServices, "workflowLaunches" | "workflowQueue" | "tasks" | "results">;
  readonly maxConcurrentWorkflowRuns: number;
  readonly maxQueuedWorkflowRuns: number;
  readonly queueDeadlineMs?: number;
  readonly now?: () => Date;
};

export type WorkflowScheduler = {
  reserve(input: WorkflowReserveInput): Promise<WorkflowReserveResult>;
};

export class WorkflowSchedulerError extends HarnessInputError {
  readonly causeCode: "max_queued_workflow_runs" | "replay_identity_mismatch";
  readonly diagnostic: Record<string, unknown>;

  constructor(
    causeCode: WorkflowSchedulerError["causeCode"],
    message: string,
    diagnostic: Record<string, unknown>,
  ) {
    super(message, { causeCode, ...diagnostic });
    this.name = "WorkflowSchedulerError";
    this.causeCode = causeCode;
    this.diagnostic = diagnostic;
  }
}

export function createWorkflowScheduler(options: CreateWorkflowSchedulerOptions): WorkflowScheduler {
  const pendingScopes = new Map<string, PendingReservationScope>();

  async function reserveNow(input: WorkflowReserveInput): Promise<WorkflowReserveResult> {
    assertReservableWorkflow(input);
    const reservedAt = (options.now?.() ?? new Date()).toISOString();
    const queueDeadlineAt = input.queueDeadlineAt ?? deadlineFrom(reservedAt, options.queueDeadlineMs);
    const transactionInput: WorkflowLaunchTransactionInput = {
      ...input,
      reservedRunId: deterministicRunId(input),
      taskKind: "workflow",
      reservedAt,
      ...(queueDeadlineAt === undefined ? {} : { queueDeadlineAt }),
    };

    const launch = await reserveLaunchWithCapacity(options, input, transactionInput);
    await drainReady(options, input.sessionId);
    const queueRecord = await options.durable.workflowQueue.get({
      sessionId: input.sessionId,
      queueId: launch.queueRecord.queueId,
    }) ?? launch.queueRecord;
    const status = queueRecord.status === "admitted" || queueRecord.status === "running" ? "admitted" : "queued";
    return {
      queueId: launch.queueRecord.queueId,
      taskId: launch.task.taskId,
      reservedRunId: launch.queueRecord.reservedRunId,
      inputResultId: launch.inputResult.resultId,
      status,
      modelFacingStatus: modelFacingWorkflowStatus(status),
    };
  }

  async function reserveLaunchWithCapacity(
    options: CreateWorkflowSchedulerOptions,
    input: WorkflowReserveInput,
    transactionInput: WorkflowLaunchTransactionInput,
  ): Promise<Awaited<ReturnType<CreateWorkflowSchedulerOptions["durable"]["workflowLaunches"]["reserveLaunch"]>>> {
    const reservation = await options.durable.workflowQueue.withQueueCapacity({
      sessionId: input.sessionId,
      maxConcurrentWorkflowRuns: options.maxConcurrentWorkflowRuns,
      maxQueuedWorkflowRuns: options.maxQueuedWorkflowRuns,
      workflowId: input.workflowId,
      handle: input.handle,
    }, {
      hasExistingLaunch: () => options.durable.workflowLaunches.hasLaunch({
        sessionId: input.sessionId,
        callIdentity: input.callIdentity,
      }),
      reserve: () => reserveLaunch(options, input, transactionInput),
    });
    if (!reservation.accepted) {
      throw new WorkflowSchedulerError("max_queued_workflow_runs", "Maximum queued workflow runs exceeded.", {
        maxQueuedWorkflowRuns: options.maxQueuedWorkflowRuns,
        queuedWorkflowRuns: reservation.queuedWorkflowRuns,
        workflowId: input.workflowId,
        handle: input.handle,
      });
    }
    return reservation.value;
  }

  async function reserveLaunch(
    options: CreateWorkflowSchedulerOptions,
    input: WorkflowReserveInput,
    transactionInput: WorkflowLaunchTransactionInput,
  ): Promise<Awaited<ReturnType<CreateWorkflowSchedulerOptions["durable"]["workflowLaunches"]["reserveLaunch"]>>> {
    try {
      return await options.durable.workflowLaunches.reserveLaunch(transactionInput);
    } catch (error) {
      if (error instanceof HarnessInputError && /replay identity mismatch/iu.test(error.message)) {
        throw new WorkflowSchedulerError("replay_identity_mismatch", error.message, {
          workflowId: input.workflowId,
          handle: input.handle,
          callIdentity: input.callIdentity,
          original: error.details,
        });
      }
      throw error;
    }
  }

  async function drainReady(options: CreateWorkflowSchedulerOptions, sessionId: string): Promise<void> {
    const queued = [...await options.durable.workflowQueue.listRuns({ sessionId, statuses: ["queued"] })]
      .sort(compareQueuedRecords);
    for (const record of queued) {
      const admission = await options.durable.workflowQueue.acquireAdmissionSlot({
        sessionId: record.sessionId,
        queueId: record.queueId,
        taskId: record.taskId,
        maxConcurrentWorkflowRuns: options.maxConcurrentWorkflowRuns,
      });
      if (!admission.admitted) {
        // acquireAdmissionSlot returns admitted:false for two reasons: genuine
        // capacity exhaustion (the record is still "queued") or a stale/non-queued
        // head left over when a concurrent instance admitted or vacated it between
        // our snapshot and the durable CAS. Only stop the pass on real capacity
        // exhaustion; otherwise keep scanning so a free slot is not stranded.
        if (admission.record?.status === "queued") {
          return;
        }
        continue;
      }
    }
  }

  function compareQueuedRecords(
    left: Awaited<ReturnType<CreateWorkflowSchedulerOptions["durable"]["workflowQueue"]["listRuns"]>>[number],
    right: Awaited<ReturnType<CreateWorkflowSchedulerOptions["durable"]["workflowQueue"]["listRuns"]>>[number],
  ): number {
    return (left.queuedAt ?? left.reservedAt).localeCompare(right.queuedAt ?? right.reservedAt)
      || compareQueueIds(left.queueId, right.queueId);
  }

  return {
    reserve(input) {
      if (input.scopeSize <= 1) {
        return reserveNow(input);
      }
      return reserveInOrder(pendingScopes, input, reserveNow);
    },
  };
}

type PendingReservation = {
  readonly input: WorkflowReserveInput;
  readonly resolve: (result: WorkflowReserveResult) => void;
  readonly reject: (error: unknown) => void;
};

type PendingReservationScope = {
  readonly sessionId: string;
  readonly reservationScopeId: string;
  readonly scopeSize: number;
  readonly reservations: Map<number, PendingReservation>;
  flushed: boolean;
};

function reserveInOrder(
  pendingScopes: Map<string, PendingReservationScope>,
  input: WorkflowReserveInput,
  reserveNow: (input: WorkflowReserveInput) => Promise<WorkflowReserveResult>,
): Promise<WorkflowReserveResult> {
  const scopeKey = `${input.sessionId}\0${input.reservationScopeId}`;
  let scope = pendingScopes.get(scopeKey);
  if (scope === undefined) {
    scope = {
      sessionId: input.sessionId,
      reservationScopeId: input.reservationScopeId,
      scopeSize: input.scopeSize,
      reservations: new Map(),
      flushed: false,
    };
    pendingScopes.set(scopeKey, scope);
  }
  if (scope.scopeSize !== input.scopeSize) {
    return Promise.reject(new HarnessInputError("Reservation scope metadata changed before it was sealed.", {
      reservationScopeId: input.reservationScopeId,
    }));
  }
  if (scope.reservations.has(input.reservationOrder)) {
    return Promise.reject(new HarnessInputError("Duplicate workflow reservation order.", {
      reservationScopeId: input.reservationScopeId,
      reservationOrder: input.reservationOrder,
    }));
  }
  const promise = new Promise<WorkflowReserveResult>((resolve, reject) => {
    scope.reservations.set(input.reservationOrder, { input, resolve, reject });
  });
  if (!scope.flushed && scope.reservations.size === scope.scopeSize) {
    scope.flushed = true;
    void flushReservationScope(scope, reserveNow).finally(() => {
      pendingScopes.delete(scopeKey);
    });
  }
  return promise;
}

async function flushReservationScope(
  scope: PendingReservationScope,
  reserveNow: (input: WorkflowReserveInput) => Promise<WorkflowReserveResult>,
): Promise<void> {
  for (let order = 0; order < scope.scopeSize; order++) {
    const reservation = scope.reservations.get(order);
    if (reservation === undefined) {
      const error = new HarnessInputError("Workflow reservation scope is missing an order.", {
        reservationScopeId: scope.reservationScopeId,
        reservationOrder: order,
      });
      for (const pending of scope.reservations.values()) {
        pending.reject(error);
      }
      return;
    }
    try {
      reservation.resolve(await reserveNow(reservation.input));
    } catch (error) {
      reservation.reject(error);
    }
  }
}

function assertReservableWorkflow(input: WorkflowReserveInput): void {
  if (input.workflowDefinitionIdentity === undefined) {
    throw new HarnessInputError("Workflow definition identity is required for durable workflow reservation.", {
      workflowId: input.workflowId,
      handle: input.handle,
    });
  }
}

function deadlineFrom(reservedAt: string, queueDeadlineMs: number | undefined): string | undefined {
  if (queueDeadlineMs === undefined) {
    return undefined;
  }
  return new Date(Date.parse(reservedAt) + queueDeadlineMs).toISOString();
}

function compareQueueIds(left: string, right: string): number {
  const leftOrdinal = queueOrdinal(left);
  const rightOrdinal = queueOrdinal(right);
  if (leftOrdinal !== undefined && rightOrdinal !== undefined && leftOrdinal !== rightOrdinal) {
    return leftOrdinal - rightOrdinal;
  }
  return left.localeCompare(right);
}

function queueOrdinal(queueId: string): number | undefined {
  const match = /^queue_(\d+)$/u.exec(queueId);
  return match === null ? undefined : Number(match[1]);
}

function deterministicRunId(input: WorkflowReserveInput): string {
  const hash = stableHash({
    workflowId: input.workflowId,
    handle: input.handle,
    callIdentity: input.callIdentity,
    reservationScopeId: input.reservationScopeId,
    reservationOrder: input.reservationOrder,
    scopeSize: input.scopeSize,
    disposition: input.disposition,
    inputHash: input.inputHash,
    sessionId: input.sessionId,
    originTurnId: input.originTurnId,
    workflowDefinitionIdentity: input.workflowDefinitionIdentity,
    workflowVersionId: input.workflowVersionId,
  }, { format: "base32hex" });
  return `run_${hash.slice(0, 24)}`;
}
