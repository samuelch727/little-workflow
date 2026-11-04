import { z } from "zod";
import { HarnessInputError } from "../errors.js";
import type { HarnessResultStore, HarnessTaskLedger } from "../tasks/ledger.js";
import type { HarnessTaskRecord } from "../tasks/types.js";
import { stableHash } from "../utils/canonical-hash.js";
import type {
  HumanInputAnswer,
  HumanInputAnswerRecord,
  HumanInputQuestion,
  HumanInputRequest,
  HumanInputStatus,
} from "./types.js";

/**
 * Questions for a person live in the task ledger as tasks of kind `input`, so the agent waits for
 * them with `await_tasks` like any background task. The question and the answer are stored as
 * results, keyed by request id.
 */
export type HumanInputServices = {
  readonly tasks: HarnessTaskLedger;
  readonly results: HarnessResultStore;
};

const MAX_OPTIONS = 20;

/** The data dir the results store keeps a session's values under. */
export function sessionResultsDir(session: { readonly id: string; readonly dataDir?: string | undefined }): string {
  return session.dataDir ?? session.id;
}

export function inputRequestId(identity: unknown): string {
  return `input_${stableHash(identity, { format: "base32hex" }).slice(0, 24)}`;
}

/** Records a question, once per request id: asking again with the same id returns the first. */
export async function createInputRequest(input: {
  readonly services: HumanInputServices;
  readonly sessionId: string;
  readonly sessionDataDir: string;
  readonly requestId: string;
  readonly question: HumanInputQuestion;
}): Promise<{ readonly request: HumanInputRequest; readonly created: boolean }> {
  const question = checkedQuestion(input.question);
  const existing = await readInputRequest(input.services, input.sessionId, input.requestId);
  if (existing !== undefined) return { request: existing, created: false };
  const task = await input.services.tasks.reserveTask({
    sessionId: input.sessionId,
    kind: "input",
    purpose: question.question,
    callIdentity: input.requestId,
  });
  const request: HumanInputRequest = {
    ...question,
    requestId: input.requestId,
    sessionId: input.sessionId,
    taskId: task.taskId,
    askedAt: task.createdAt,
  };
  const allocated = await input.services.results.allocate({
    kind: "input",
    sessionId: input.sessionId,
    sessionDataDir: input.sessionDataDir,
    idempotencyKey: requestKey(input.requestId),
  });
  await input.services.results.commit({ sessionId: input.sessionId, resultId: allocated.resultId }, request);
  return { request, created: true };
}

export async function readInputRequest(
  services: Pick<HumanInputServices, "results">,
  sessionId: string,
  requestId: string,
): Promise<HumanInputRequest | undefined> {
  const stored = await services.results.getByIdempotencyKey({ sessionId, idempotencyKey: requestKey(requestId) });
  return stored?.record.committedAt === undefined ? undefined : stored.value as HumanInputRequest;
}

/** The answer an `input` task finished with, read from its terminal result. */
export async function readInputAnswer(
  services: Pick<HumanInputServices, "results">,
  task: HarnessTaskRecord,
): Promise<HumanInputAnswerRecord | undefined> {
  if (task.kind !== "input" || task.terminalResultId === undefined) return undefined;
  const stored = await services.results.get({ sessionId: task.sessionId, resultId: task.terminalResultId });
  return stored === undefined ? undefined : stored.value as HumanInputAnswerRecord;
}

/**
 * Stores a person's answer and completes the question's task. Refuses a different answer to a
 * question that already has one, an answer to a cancelled question, and an answer that does not
 * fit the question. The same answer again is accepted and changes nothing, so a caller can retry;
 * after the process stopped before the task was completed, it completes it. A question whose wait
 * timed out still takes an answer.
 */
export async function recordInputAnswer(input: {
  readonly services: HumanInputServices;
  readonly sessionId: string;
  readonly sessionDataDir: string;
  readonly requestId: string;
  readonly answer: HumanInputAnswer;
  readonly answeredBy?: string;
}): Promise<{ readonly request: HumanInputRequest; readonly task: HarnessTaskRecord }> {
  const request = await readInputRequest(input.services, input.sessionId, input.requestId);
  if (request === undefined) {
    throw new HarnessInputError(`No question ${input.requestId} in session ${input.sessionId}.`, {
      requestId: input.requestId,
    });
  }
  const task = await input.services.tasks.getTask({ sessionId: input.sessionId, taskId: request.taskId });
  if (task === undefined) {
    throw new HarnessInputError(`Question ${input.requestId} has no task.`, { requestId: input.requestId });
  }
  if (task.status === "completed") {
    const earlier = await readInputAnswer(input.services, task);
    if (earlier !== undefined && stableHash(earlier.answer) === stableHash(input.answer)) return { request, task };
  }
  if (task.status === "completed" || task.status === "failed" || task.status === "cancelled") {
    throw alreadyClosed(input.requestId, task.status);
  }
  const problem = answerProblem(request, input.answer);
  if (problem !== undefined) {
    throw new HarnessInputError(`The answer does not fit question ${input.requestId}: ${problem}`, {
      requestId: input.requestId,
    });
  }
  const record: HumanInputAnswerRecord = {
    answer: input.answer,
    ...(input.answeredBy === undefined ? {} : { answeredBy: input.answeredBy }),
    answeredAt: new Date().toISOString(),
  };
  const allocated = await input.services.results.allocate({
    kind: "input",
    sessionId: input.sessionId,
    sessionDataDir: input.sessionDataDir,
    idempotencyKey: answerKey(input.requestId),
    inlineSummary: answerSummary(record),
  });
  let stored = record;
  try {
    await input.services.results.commit({ sessionId: input.sessionId, resultId: allocated.resultId }, record);
  } catch {
    // An answer was stored first: another one, or this one before the process stopped short of
    // completing the task. The same answer again finishes the job; a different one is refused.
    const earlier = (await input.services.results.get({ sessionId: input.sessionId, resultId: allocated.resultId }))
      ?.value as HumanInputAnswerRecord | undefined;
    if (earlier === undefined || stableHash(earlier.answer) !== stableHash(input.answer)) {
      throw alreadyClosed(input.requestId, "completed");
    }
    await input.services.results.commit({ sessionId: input.sessionId, resultId: allocated.resultId }, earlier);
    stored = earlier;
  }
  const terminal = await input.services.tasks.updateTaskTerminal({
    sessionId: input.sessionId,
    taskId: request.taskId,
    status: "completed",
    terminalResultId: allocated.resultId,
    outputSummary: answerSummary(stored),
  });
  if (terminal === undefined || terminal.terminalResultId !== allocated.resultId) {
    throw alreadyClosed(input.requestId, terminal?.status ?? "completed");
  }
  return { request, task: terminal };
}

/** Where a question's task stands, with the answer once there is one. */
export async function inputTaskState(
  services: Pick<HumanInputServices, "results">,
  task: HarnessTaskRecord,
): Promise<{ readonly status: HumanInputStatus } & Partial<HumanInputAnswerRecord>> {
  if (task.status === "cancelled" || task.status === "failed") return { status: "cancelled" };
  const answered = task.status === "completed" ? await readInputAnswer(services, task) : undefined;
  return answered === undefined ? { status: "waiting" } : { status: "answered", ...answered };
}

/** What the model sees for an `input` task: its question, and the answer once there is one. */
export async function presentInputTask(
  services: Pick<HumanInputServices, "results">,
  task: HarnessTaskRecord,
): Promise<Record<string, unknown>> {
  return { taskId: task.taskId, kind: "input", question: task.purpose, ...await inputTaskState(services, task) };
}

function answerProblem(request: HumanInputRequest, answer: HumanInputAnswer): string | undefined {
  if (typeof answer !== "object" || answer === null) return "the answer must be an object.";
  if (answer.option === undefined && answer.text === undefined && answer.value === undefined) {
    return "give an option, text or a value.";
  }
  if (answer.text !== undefined && typeof answer.text !== "string") return "text must be a string.";
  const options = request.options ?? [];
  if (answer.option !== undefined) {
    if (!options.some((option) => option.id === answer.option)) {
      return `option must be one of ${options.map((option) => option.id).join(", ") || "(none offered)"}.`;
    }
  } else if (options.length > 0 && request.allowFreeform !== true && request.answerSchema === undefined) {
    return `pick one of ${options.map((option) => option.id).join(", ")}.`;
  }
  if (request.answerSchema !== undefined) {
    if (answer.value === undefined) return "value is required.";
    const parsed = z.fromJSONSchema(request.answerSchema as Parameters<typeof z.fromJSONSchema>[0]).safeParse(answer.value);
    if (!parsed.success) {
      return parsed.error.issues
        .map((issue) => `${issue.path.length > 0 ? `${issue.path.join(".")}: ` : ""}${issue.message}`)
        .join("; ");
    }
  }
  return undefined;
}

function checkedQuestion(question: HumanInputQuestion): HumanInputQuestion {
  if (typeof question.question !== "string" || question.question.trim().length === 0) {
    throw new HarnessInputError("A question needs text.");
  }
  const options = question.options ?? [];
  if (options.length > MAX_OPTIONS) throw new HarnessInputError(`Offer at most ${MAX_OPTIONS} options.`);
  const ids = new Set<string>();
  for (const option of options) {
    if (typeof option.id !== "string" || option.id.length === 0 || typeof option.label !== "string") {
      throw new HarnessInputError("Each option needs an id and a label.");
    }
    if (ids.has(option.id)) throw new HarnessInputError(`Option id '${option.id}' is used twice.`);
    ids.add(option.id);
  }
  if (question.answerSchema !== undefined) {
    try {
      z.fromJSONSchema(question.answerSchema as Parameters<typeof z.fromJSONSchema>[0]);
    } catch (error) {
      throw new HarnessInputError(`answerSchema is not a usable JSON Schema: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return {
    question: question.question,
    ...(options.length === 0 ? {} : { options: options.map(({ id, label }) => ({ id, label })) }),
    ...(question.allowFreeform === undefined ? {} : { allowFreeform: question.allowFreeform }),
    ...(question.to === undefined ? {} : { to: question.to }),
    ...(question.answerSchema === undefined ? {} : { answerSchema: question.answerSchema }),
  };
}

function answerSummary(record: HumanInputAnswerRecord): string {
  const text = JSON.stringify(record.answer);
  const summary = record.answeredBy === undefined ? `Answered: ${text}` : `Answered by ${record.answeredBy}: ${text}`;
  return summary.length > 500 ? `${summary.slice(0, 500)}…` : summary;
}

function alreadyClosed(requestId: string, status: string): HarnessInputError {
  const reason = status === "cancelled" ? "was cancelled" : status === "failed" ? "is closed" : "already has an answer";
  return new HarnessInputError(`Question ${requestId} ${reason}.`, { requestId, status });
}

function requestKey(requestId: string): string {
  return `input-request:${requestId}`;
}

function answerKey(requestId: string): string {
  return `input-answer:${requestId}`;
}
