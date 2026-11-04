import type { JSONValue, ModelMessage, ToolModelMessage } from "ai";
import { HarnessInputError } from "../errors.js";
import { sessionResultsDir } from "../human-input/requests.js";
import { presentTasks } from "../tasks/control-tools.js";
import type { HarnessContinuationRecord, HarnessContinuationWaitRecord } from "../tasks/ledger.js";
import type { HarnessTaskRecord } from "../tasks/types.js";
import type { BuildModelMessagesResult } from "../runtime/messages.js";
import type { HarnessOrchestrationServices, HarnessSession, HarnessTurnMetadata } from "../types.js";
import { withCallsToRunAgain } from "./waiting-tools.js";

/**
 * What a parked turn needs to continue: the system prompt and the conversation up to the tool call
 * that parked it, and what its `turnOptions` hook decided it from (`pin`) and said about it
 * (`metadata`). Kept in the results store under the continuation's id.
 */
type ParkedTurnSnapshot = {
  readonly version: 1;
  readonly budgetRef?: unknown;
  readonly budgetAccounting?: "logical-turn";
  readonly continuationId: string;
  readonly system: string;
  readonly messages: readonly ModelMessage[];
  readonly type?: string;
  readonly pin?: unknown;
  readonly metadata?: HarnessTurnMetadata;
  readonly parkedAt: string;
};

export type ParkedTurn = {
  readonly budgetRef?: unknown;
  readonly continuationId: string;
  readonly system: string;
  /**
   * The saved conversation, with each parked tool call's result replaced by what it waited for,
   * or, for a call that waited in `ask`, set up to run that call again.
   */
  readonly messages: ModelMessage[];
  readonly type?: string;
};

type Services = Pick<HarnessOrchestrationServices, "continuations" | "results" | "tasks">;

export async function saveParkedTurn(input: {
  readonly services: Pick<HarnessOrchestrationServices, "results">;
  readonly session: HarnessSession;
  readonly continuationId: string;
  readonly system: string;
  readonly messages: readonly ModelMessage[];
  readonly type?: string | undefined;
  readonly pin?: unknown;
  readonly metadata?: HarnessTurnMetadata | undefined;
  readonly budgetRef?: unknown;
}): Promise<void> {
  const idempotencyKey = snapshotKey(input.continuationId);
  const existing = await input.services.results.getByIdempotencyKey({ sessionId: input.session.id, idempotencyKey });
  if (existing?.record.committedAt !== undefined) return;
  const snapshot: ParkedTurnSnapshot = {
    version: 1,
    continuationId: input.continuationId,
    system: input.system,
    messages: jsonSafe(input.messages) as ModelMessage[],
    ...(input.type === undefined ? {} : { type: input.type }),
    ...(input.pin === undefined ? {} : { pin: jsonSafe(input.pin) }),
    ...(input.metadata === undefined ? {} : { metadata: jsonSafe(input.metadata) as HarnessTurnMetadata }),
    ...(input.budgetRef === undefined ? {} : { budgetRef: jsonSafe(input.budgetRef), budgetAccounting: "logical-turn" as const }),
    parkedAt: new Date().toISOString(),
  };
  const allocated = await input.services.results.allocate({
    kind: "continuation",
    sessionId: input.session.id,
    sessionDataDir: sessionResultsDir(input.session),
    idempotencyKey,
  });
  await input.services.results.commit({ sessionId: input.session.id, resultId: allocated.resultId }, snapshot);
}

/**
 * What a parked turn's `turnOptions` hook returned as `pin` and `metadata`, for the hook of the
 * turn that continues it. Empty when the turn saved neither, or has no saved conversation (which
 * `loadParkedTurn` refuses).
 */
export async function parkedTurnDecision(input: {
  readonly services: Pick<HarnessOrchestrationServices, "results"> | undefined;
  readonly session: HarnessSession;
  readonly continuationId: string;
}): Promise<{ readonly pin?: unknown; readonly metadata?: HarnessTurnMetadata }> {
  if (input.services === undefined) return {};
  const stored = await input.services.results.getByIdempotencyKey({
    sessionId: input.session.id,
    idempotencyKey: snapshotKey(input.continuationId),
  });
  if (stored?.record.committedAt === undefined) return {};
  const snapshot = stored.value as ParkedTurnSnapshot;
  return {
    ...(snapshot.pin === undefined ? {} : { pin: snapshot.pin }),
    ...(snapshot.metadata === undefined ? {} : { metadata: snapshot.metadata }),
  };
}

/** Internal accounting identity is read even when a completed model response can be replayed early. */
export async function parkedTurnBudgetRef(input: {
  readonly services: Pick<HarnessOrchestrationServices, "results"> | undefined;
  readonly session: HarnessSession;
  readonly continuationId: string;
}): Promise<unknown> {
  const stored = await input.services?.results.getByIdempotencyKey({ sessionId: input.session.id, idempotencyKey: snapshotKey(input.continuationId) });
  if (stored?.record.committedAt === undefined) return undefined;
  const snapshot = stored.value as ParkedTurnSnapshot;
  // A damaged logical snapshot must not look like a legacy per-run snapshot.
  if (snapshot?.budgetAccounting !== undefined && (snapshot.budgetAccounting !== "logical-turn" || snapshot.budgetRef === undefined)) return { malformedBudget: true };
  return snapshot?.budgetRef;
}

/**
 * Loads a parked turn whose wait is over. Refuses one that is still waiting, already continued,
 * or belongs to another session.
 */
export async function loadParkedTurn(input: {
  readonly services: Services;
  readonly session: HarnessSession;
  readonly continuationId: string;
}): Promise<ParkedTurn> {
  const record = await input.services.continuations.get(input.continuationId);
  if (record === undefined || record.sessionId !== input.session.id) {
    throw new HarnessInputError(`No parked turn ${input.continuationId} in session ${input.session.id}.`, {
      continuationId: input.continuationId,
    });
  }
  if (record.state === "open") {
    throw new HarnessInputError(`Parked turn ${input.continuationId} is still waiting.`, {
      continuationId: input.continuationId,
    });
  }
  if (record.state === "closed") {
    throw new HarnessInputError(`Parked turn ${input.continuationId} was already continued.`, {
      continuationId: input.continuationId,
    });
  }
  const stored = await input.services.results.getByIdempotencyKey({
    sessionId: input.session.id,
    idempotencyKey: snapshotKey(input.continuationId),
  });
  if (stored?.record.committedAt === undefined) {
    throw new HarnessInputError(`Parked turn ${input.continuationId} has no saved conversation to continue.`, {
      continuationId: input.continuationId,
    });
  }
  const snapshot = stored.value as ParkedTurnSnapshot;
  const outputs = new Map<string, unknown>();
  const runAgain = new Set<string>();
  for (const wait of record.waits) {
    if (wait.rerun === true) runAgain.add(wait.parkedToolCallId);
    else outputs.set(wait.parkedToolCallId, await waitOutcome(input.services, record, wait));
  }
  return {
    continuationId: input.continuationId,
    ...(snapshot.budgetRef === undefined ? {} : { budgetRef: snapshot.budgetRef }),
    system: snapshot.system,
    messages: withCallsToRunAgain(snapshot.messages.map((message) => withToolOutputs(message, outputs)), runAgain),
    ...(snapshot.type === undefined ? {} : { type: snapshot.type }),
  };
}

/** The model input for a continued turn, in the shape `buildModelMessages` returns. */
export function resumedModelMessages(
  turn: ParkedTurn,
  config: { readonly inputTypes?: Readonly<Record<string, { readonly output?: unknown }>> | undefined },
): BuildModelMessagesResult {
  const output = turn.type === undefined ? undefined : config.inputTypes?.[turn.type]?.output;
  return {
    system: turn.system,
    messages: turn.messages,
    warnings: [],
    ...(output === undefined ? {} : { output }),
  };
}

export function requireOrchestration(
  orchestration: HarnessOrchestrationServices | undefined,
): HarnessOrchestrationServices {
  if (orchestration === undefined) {
    throw new HarnessInputError("Continuing a parked turn needs a host with durable services, such as localHost.");
  }
  return orchestration;
}

/** Marks a parked turn as continued, so it is not continued twice. */
export async function closeParkedTurn(services: Pick<Services, "continuations">, continuationId: string): Promise<void> {
  await services.continuations.transition(continuationId, "resume_enqueued", "closed", {
    updatedAt: new Date().toISOString(),
  });
}

/** What the parked `await_tasks` call returns once its wait is over, in the shape it returns live. */
async function waitOutcome(
  services: Services,
  record: HarnessContinuationRecord,
  wait: HarnessContinuationWaitRecord,
): Promise<Record<string, unknown>> {
  const predicate = wait.predicate;
  if (predicate.kind === "tool-call") {
    return { status: wait.state === "timed_out" ? "timed_out" : "satisfied" };
  }
  const taskIds = predicate.kind === "tasks" ? predicate.taskIds : [predicate.taskId];
  const mode = predicate.kind === "tasks" ? predicate.mode : "all";
  const tasks = (await Promise.all(taskIds.map((taskId) =>
    services.tasks.getTask({ sessionId: record.sessionId, taskId })
  ))).filter((task): task is HarnessTaskRecord => task !== undefined);
  const terminal = tasks.filter((task) => isTerminal(task.status));
  const pending = taskIds.filter((taskId) => !terminal.some((task) => task.taskId === taskId));
  return {
    status: wait.state === "timed_out" ? "timed_out" : "satisfied",
    ...(pending.length === 0 ? {} : { pending: { taskIds: pending, mode } }),
    tasks: await presentTasks(terminal, services.results),
  };
}

function withToolOutputs(message: ModelMessage, outputs: ReadonlyMap<string, unknown>): ModelMessage {
  if (message.role !== "tool" || !Array.isArray(message.content)) return message;
  const content: ToolModelMessage["content"] = message.content.map((part) =>
    part.type === "tool-result" && outputs.has(part.toolCallId)
      ? { ...part, output: { type: "json" as const, value: outputs.get(part.toolCallId) as JSONValue } }
      : part
  );
  return { ...message, content };
}

/** Binary parts as base64 and URLs as text, so the conversation survives a trip through JSON. */
function jsonSafe(value: unknown): unknown {
  if (value instanceof Uint8Array) return Buffer.from(value).toString("base64");
  if (value instanceof ArrayBuffer) return Buffer.from(value).toString("base64");
  if (value instanceof URL) return value.toString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).filter(([, entry]) => entry !== undefined).map(([key, entry]) => [key, jsonSafe(entry)]),
    );
  }
  return value;
}

function isTerminal(status: HarnessTaskRecord["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function snapshotKey(continuationId: string): string {
  return `parked-turn:${continuationId}`;
}
