import type { ModelMessage, ToolModelMessage } from "ai";
import { driveContinuationWaits } from "../tasks/control-tools.js";
import type { HarnessContinuationRecord, HarnessContinuationWaitRecord } from "../tasks/ledger.js";
import type { HarnessTaskId } from "../tasks/types.js";
import type { HarnessOrchestrationServices } from "../types.js";
import { stableHash } from "../utils/canonical-hash.js";
import { createContinuationId, isParkedToolOutput, type ParkedToolOutput } from "./park-resume.js";
import type { HarnessParkedPending } from "./result.js";

/**
 * The step id of the tool calls a continued turn runs again before its first model step. `ask`
 * refuses to wait there: a call waits once.
 */
export const RERUN_STEP_ID = "rerun";

/** The continuation that every tool waiting in `ask` during one model step parks on. */
export function waitingContinuationId(input: {
  readonly sessionId: string;
  readonly turnId: string;
  readonly modelStepId: string;
}): string {
  return createContinuationId({
    sessionId: input.sessionId,
    originTurnId: input.turnId,
    modelStepId: input.modelStepId,
    toolCallBatchId: "waiting-tools",
    parkSequence: 0,
  });
}

export type WaitingPark = {
  readonly continuationId: string;
  readonly pending: HarnessParkedPending;
  readonly record: HarnessContinuationRecord;
  /** The continuations `await_tasks` parked on in the same step, now part of this one. */
  readonly folded: readonly string[];
};

type StepToolResult = { readonly toolCallId: string; readonly output: ParkedToolOutput };

/**
 * When tools waited in `ask` in a turn's last step, the one continuation the turn parks on: a wait
 * per waiting call, on its question, plus the waits of any `await_tasks` call in the same step,
 * so the turn continues once, after all of them. Undefined when no tool waited in `ask`.
 */
export async function waitingPark(input: {
  readonly services: Pick<HarnessOrchestrationServices, "continuations">;
  readonly sessionId: string;
  readonly turnId: string;
  readonly steps: readonly unknown[];
}): Promise<WaitingPark | undefined> {
  const modelStepId = `step_${input.steps.length}`;
  const continuationId = waitingContinuationId({ sessionId: input.sessionId, turnId: input.turnId, modelStepId });
  const parked = parkedResults(input.steps.at(-1));
  const waiting = parked.filter((result) => result.output.continuationId === continuationId);
  if (waiting.length === 0) return undefined;

  const waits: HarnessContinuationWaitRecord[] = waiting.map(({ toolCallId, output }) => ({
    waitId: `wait_${stableHash({ continuationId, toolCallId }, { format: "base32hex" }).slice(0, 16)}`,
    parkedToolCallId: toolCallId,
    predicate: { kind: "tasks", taskIds: (output.pending.taskIds ?? []) as readonly HarnessTaskId[], mode: "all" },
    state: "open",
    outcomesById: {},
    terminalResultIds: [],
    rerun: true,
  }));
  const parkedToolCallIds = waiting.map((result) => result.toolCallId);
  let terminalResultsByToolCallId: Record<string, readonly string[]> = {};
  let timeoutAt: string | undefined;
  const folded: string[] = [];
  for (const id of new Set(parked.map((result) => result.output.continuationId))) {
    if (id === continuationId) continue;
    const other = await input.services.continuations.get(id);
    if (other === undefined || other.sessionId !== input.sessionId || other.state === "closed") continue;
    waits.push(...other.waits);
    parkedToolCallIds.push(...other.parkedToolCallIds);
    terminalResultsByToolCallId = { ...terminalResultsByToolCallId, ...other.terminalResultsByToolCallId };
    if (other.timeoutAt !== undefined && (timeoutAt === undefined || other.timeoutAt < timeoutAt)) timeoutAt = other.timeoutAt;
    folded.push(id);
  }
  const now = new Date().toISOString();
  const record: HarnessContinuationRecord = {
    continuationId,
    sessionId: input.sessionId,
    originTurnId: input.turnId,
    modelStepId,
    parkedToolCallIds,
    waits,
    terminalResultsByToolCallId,
    state: "open",
    createdAt: now,
    updatedAt: now,
    ...(timeoutAt === undefined ? {} : { timeoutAt }),
  };
  const taskIds = waits.flatMap((wait) => (wait.predicate.kind === "tasks" ? wait.predicate.taskIds : []));
  return { continuationId, pending: { taskIds, mode: "all" }, record, folded };
}

/**
 * Records a waiting park once the turn's conversation is saved: the continuation, the `await_tasks`
 * continuations it took in closed so they never continue on their own, and any wait already over
 * (an answer that came during the step), which queues the resume when it was the last.
 */
export async function recordWaitingPark(
  park: WaitingPark,
  services: Pick<HarnessOrchestrationServices, "continuations" | "tasks" | "resumeQueue">,
): Promise<void> {
  await services.continuations.putIfAbsent(park.record);
  for (const id of park.folded) {
    const updatedAt = new Date().toISOString();
    const closed = await services.continuations.transition(id, "open", "closed", { updatedAt });
    if (!closed.updated) await services.continuations.transition(id, "resume_enqueued", "closed", { updatedAt });
  }
  await driveContinuationWaits({
    continuation: park.record,
    ledger: services.tasks,
    continuations: services.continuations,
    resumeQueue: services.resumeQueue,
  });
}

/**
 * A parked turn's conversation set up to run its waiting calls again: each call's parked result
 * is taken out, and the call is approved in the last message, so AI SDK runs it before the first
 * model step (its tool-approval flow), through the turn's tools and their events.
 */
export function withCallsToRunAgain(messages: readonly ModelMessage[], toolCallIds: ReadonlySet<string>): ModelMessage[] {
  if (toolCallIds.size === 0) return [...messages];
  const approvalId = (toolCallId: string) => `rerun_${toolCallId}`;
  const out: ModelMessage[] = [];
  for (const message of messages) {
    if (message.role === "assistant" && Array.isArray(message.content)) {
      out.push({
        ...message,
        content: message.content.flatMap((part) =>
          part.type === "tool-call" && toolCallIds.has(part.toolCallId)
            ? [part, { type: "tool-approval-request" as const, approvalId: approvalId(part.toolCallId), toolCallId: part.toolCallId }]
            : [part]
        ),
      });
    } else if (message.role === "tool") {
      const content = message.content.filter((part) => !(part.type === "tool-result" && toolCallIds.has(part.toolCallId)));
      if (content.length > 0) out.push({ ...message, content });
    } else {
      out.push(message);
    }
  }
  const approvals = [...toolCallIds].map((toolCallId) => ({
    type: "tool-approval-response" as const,
    approvalId: approvalId(toolCallId),
    approved: true,
  }));
  const last = out.at(-1);
  if (last?.role === "tool") {
    out[out.length - 1] = { ...last, content: [...last.content, ...approvals] } satisfies ToolModelMessage;
  } else {
    out.push({ role: "tool", content: approvals });
  }
  return out;
}

function parkedResults(step: unknown): StepToolResult[] {
  const results = isRecord(step) && Array.isArray(step.toolResults) ? step.toolResults : [];
  return results.flatMap((result) =>
    isRecord(result) && typeof result.toolCallId === "string" && isParkedToolOutput(result.output)
      ? [{ toolCallId: result.toolCallId, output: result.output }]
      : []
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
