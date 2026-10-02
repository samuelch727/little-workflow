import { HarnessInputError } from "../errors.js";

/**
 * Session-scoped admission control for workflow runs launched *from a turn's tool calls*
 * (the "inline" path: the model emits N workflow tool calls and the AI SDK executes them in
 * parallel). Without this, a model emitting 50 parallel workflow tool calls gets 50
 * concurrent runs — the durable path's `maxConcurrentWorkflowRuns` budget only ever bound
 * runs that go through the workflow queue ledger (`local-host/durable-services.ts`) and the
 * scheduler (`workflow-scheduler/`).
 *
 * SEMANTICS ARE MATCHED TO THE DURABLE PATH:
 *   - state is keyed by `sessionId` (the ledger locks on `["workflow-admission", sessionId]`
 *     and counts `listRuns({ sessionId })`), so all workflow tools of a session share one
 *     bound — a per-tool gate would still allow `tools x limit` concurrent runs;
 *   - the limit is supplied *per acquisition*, exactly like the
 *     `maxConcurrentWorkflowRuns` argument of `acquireAdmissionSlot`, so two harnesses with
 *     different budgets and one session id behave sanely;
 *   - the queue bound uses the ledger's own formula (see `withQueueCapacity`):
 *     `projectedQueued = max(0, queued + 1 - max(0, limit - active))`, rejected when it
 *     exceeds `maxQueuedWorkflowRuns`.
 *
 * Excess calls WAIT for a slot (FIFO) rather than failing: model-issued tool calls must not
 * fail because of pacing. Only the queue bound fails, and it names the budget.
 *
 * The waiting algorithm is ported from the concurrency gate the (now deprecated)
 * orchestrator used for `maxConcurrentSubRuns` (`little-workflow` `src/orchestrator.ts:587`)
 * — retiring that surface must not lose the bound. It is extended here with a per-acquire
 * limit, the queue bound, and a synchronous fast path (an uncontended call invokes the task
 * in the caller's own tick, so a single workflow tool call gains no latency).
 *
 * The registry entry is deleted as soon as a session has no active and no waiting run, so
 * the module-level map holds only in-flight sessions.
 */

export const DEFAULT_MAX_CONCURRENT_WORKFLOW_RUNS = 10;
export const DEFAULT_MAX_QUEUED_WORKFLOW_RUNS = 100;

/** The workflow-budget fields this gate reads (a subset of `HarnessWorkflowBudgets`). */
export type WorkflowRunConcurrencyBudgets = {
  readonly maxConcurrentWorkflowRuns?: number | undefined;
  readonly maxQueuedWorkflowRuns?: number | undefined;
};

/**
 * Thrown (synchronously, before the workflow is started) when admitting one more run would
 * push the session's queue past `maxQueuedWorkflowRuns`. Callers turn this into a failed
 * workflow execution with causeCode `max_queued_workflow_runs` — the same causeCode the
 * durable scheduler raises — so the turn survives and the model can pace itself.
 */
export class WorkflowQueueOverflowError extends HarnessInputError {
  readonly causeCode = "max_queued_workflow_runs" as const;
  readonly maxQueuedWorkflowRuns: number;
  readonly queuedWorkflowRuns: number;

  constructor(maxQueuedWorkflowRuns: number, queuedWorkflowRuns: number, details: Record<string, unknown> = {}) {
    super(
      `Maximum queued workflow runs exceeded: maxQueuedWorkflowRuns is ${maxQueuedWorkflowRuns} `
      + `and ${queuedWorkflowRuns} workflow runs are already queued for this session. `
      + "Wait for the runs in flight to finish before launching more, or raise the "
      + "maxQueuedWorkflowRuns workflow budget.",
      { causeCode: "max_queued_workflow_runs", maxQueuedWorkflowRuns, queuedWorkflowRuns, ...details },
    );
    this.name = "WorkflowQueueOverflowError";
    this.maxQueuedWorkflowRuns = maxQueuedWorkflowRuns;
    this.queuedWorkflowRuns = queuedWorkflowRuns;
  }
}

type SessionWorkflowSlots = {
  /** Runs holding a slot (started, not yet settled). */
  active: number;
  /** FIFO resolvers for calls waiting on a slot; each is handed a slot on release. */
  readonly waiters: Array<() => void>;
};

const slotsBySession = new Map<string, SessionWorkflowSlots>();

/**
 * Runs `task` under the session's workflow-run slot budget. Returns the task's result
 * unchanged; queues (awaits a slot) when the session is saturated. Throws
 * {@link WorkflowQueueOverflowError} — before `task` is ever invoked — when the session's
 * queue is already at `maxQueuedWorkflowRuns`.
 */
export function runWithWorkflowRunSlot<T>(
  sessionId: string,
  budgets: WorkflowRunConcurrencyBudgets | undefined,
  task: () => Promise<T>,
): Promise<T> {
  const limit = concurrencyLimit(budgets?.maxConcurrentWorkflowRuns);
  const maxQueued = queueLimit(budgets?.maxQueuedWorkflowRuns);
  const slots = slotsForSession(sessionId);

  const availableSlots = Math.max(0, limit - slots.active);
  const projectedQueuedRuns = Math.max(0, slots.waiters.length + 1 - availableSlots);
  if (projectedQueuedRuns > maxQueued) {
    const queuedWorkflowRuns = slots.waiters.length;
    deleteWhenIdle(sessionId, slots);
    throw new WorkflowQueueOverflowError(maxQueued, queuedWorkflowRuns, { sessionId });
  }

  if (slots.active < limit && slots.waiters.length === 0) {
    // Fast path: uncontended. Not `async`, so `task()` runs in the caller's tick and a
    // single workflow tool call behaves exactly as it did before the gate existed.
    slots.active += 1;
    return settle(sessionId, slots, task);
  }
  return runQueued(sessionId, slots, task);
}

/** Test/diagnostic view of a session's slot state; `undefined` once the session is idle. */
export function workflowRunSlotSnapshot(
  sessionId: string,
): { readonly active: number; readonly queued: number } | undefined {
  const slots = slotsBySession.get(sessionId);
  return slots === undefined ? undefined : { active: slots.active, queued: slots.waiters.length };
}

async function runQueued<T>(
  sessionId: string,
  slots: SessionWorkflowSlots,
  task: () => Promise<T>,
): Promise<T> {
  // The releasing run hands its slot over rather than decrementing, so `active` is already
  // accounted for when this resolves — no window where a newcomer could steal the slot.
  await new Promise<void>((resolve) => slots.waiters.push(resolve));
  return settle(sessionId, slots, task);
}

function settle<T>(sessionId: string, slots: SessionWorkflowSlots, task: () => Promise<T>): Promise<T> {
  let running: Promise<T>;
  try {
    running = task();
  } catch (error) {
    // A task that throws synchronously must not strand its slot.
    release(sessionId, slots);
    throw error;
  }
  return running.then(
    (value) => {
      release(sessionId, slots);
      return value;
    },
    (error: unknown) => {
      release(sessionId, slots);
      throw error;
    },
  );
}

function release(sessionId: string, slots: SessionWorkflowSlots): void {
  const next = slots.waiters.shift();
  if (next !== undefined) {
    next();
    return;
  }
  slots.active = Math.max(0, slots.active - 1);
  deleteWhenIdle(sessionId, slots);
}

function slotsForSession(sessionId: string): SessionWorkflowSlots {
  const existing = slotsBySession.get(sessionId);
  if (existing !== undefined) {
    return existing;
  }
  const created: SessionWorkflowSlots = { active: 0, waiters: [] };
  slotsBySession.set(sessionId, created);
  return created;
}

function deleteWhenIdle(sessionId: string, slots: SessionWorkflowSlots): void {
  if (slots.active === 0 && slots.waiters.length === 0 && slotsBySession.get(sessionId) === slots) {
    slotsBySession.delete(sessionId);
  }
}

/**
 * A blocking await path cannot honour a limit below 1 (nothing would ever release), so a
 * missing/invalid budget falls back to the default and anything lower is clamped to 1.
 */
function concurrencyLimit(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_MAX_CONCURRENT_WORKFLOW_RUNS;
  }
  return Math.max(1, Math.floor(value));
}

function queueLimit(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_MAX_QUEUED_WORKFLOW_RUNS;
  }
  return Math.max(0, Math.floor(value));
}
