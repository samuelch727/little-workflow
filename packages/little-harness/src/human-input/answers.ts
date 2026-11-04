import { HarnessInputError } from "../errors.js";
import { driveContinuationsForTerminalTask } from "../tasks/control-tools.js";
import type { Harness, HarnessOrchestrationServices } from "../types.js";
import { inputRequestId, inputTaskState, readInputRequest, recordInputAnswer, sessionResultsDir } from "./requests.js";
import type { HumanInputAnswer, HumanInputAnswerRecord, HumanInputRequest, HumanInputStatus } from "./types.js";

/** A question and where it stands. */
export type HumanInputRequestState = HumanInputRequest & {
  readonly status: HumanInputStatus;
} & Partial<HumanInputAnswerRecord>;

/**
 * Lists the questions the agent and its tools asked, oldest first: by default the ones still
 * waiting for an answer, in every session.
 */
export async function listInputRequests(options: {
  readonly harness: Harness<any, any>;
  readonly sessionId?: string;
  /** Default `"waiting"`. */
  readonly status?: HumanInputStatus | "all";
}): Promise<HumanInputRequestState[]> {
  const durable = requireDurable(options.harness);
  const tasks = (await durable.tasks.listTasks(options.sessionId === undefined ? {} : { sessionId: options.sessionId }))
    .filter((task) => task.kind === "input" && task.callIdentity !== undefined)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const wanted = options.status ?? "waiting";
  const states: HumanInputRequestState[] = [];
  for (const task of tasks) {
    const request = await readInputRequest(durable, task.sessionId, task.callIdentity!);
    if (request === undefined) continue;
    const state = await inputTaskState(durable, task);
    if (wanted !== "all" && state.status !== wanted) continue;
    states.push({ ...request, ...state });
  }
  return states;
}

/**
 * Records a person's answer to a question, named by its `requestId` or by the `key` a tool asked
 * it with. A turn that paused for it is then ready to continue: call `resumeParked`. Refuses a
 * different answer to a question that already has one, an answer to a cancelled question, and an
 * answer that does not fit the question's options or `answerSchema`. The same answer again
 * succeeds and changes nothing, so it is safe to retry; when the process stopped while recording
 * an answer, it finishes recording it.
 */
export async function answerInputRequest(options: {
  readonly harness: Harness<any, any>;
  readonly sessionId: string;
  readonly answer: HumanInputAnswer;
  /** Who answered, as your app knows them. Shown to the agent with the answer. */
  readonly answeredBy?: string;
} & ({ readonly requestId: string; readonly key?: undefined } | { readonly key: string; readonly requestId?: undefined })): Promise<HumanInputRequestState> {
  const durable = requireDurable(options.harness);
  const session = await options.harness.sessions.get(options.sessionId);
  if (session === undefined) {
    throw new HarnessInputError(`No session ${options.sessionId}.`, { sessionId: options.sessionId });
  }
  const requestId = typeof options.requestId === "string"
    ? options.requestId
    : typeof options.key === "string" && options.key.length > 0
      ? inputRequestId({ sessionId: session.id, key: options.key })
      : undefined;
  if (requestId === undefined) throw new HarnessInputError("Name the question by its requestId or its key.");
  const { request, task } = await recordInputAnswer({
    services: durable,
    sessionId: session.id,
    sessionDataDir: sessionResultsDir(session),
    requestId,
    answer: options.answer,
    ...(options.answeredBy === undefined ? {} : { answeredBy: options.answeredBy }),
  });
  await driveContinuationsForTerminalTask({
    sessionId: session.id,
    taskId: task.taskId,
    ledger: durable.tasks,
    continuations: durable.continuations,
    resumeQueue: durable.resumeQueue,
  });
  return { ...request, ...await inputTaskState(durable, task) };
}

function requireDurable(harness: Harness<any, any>): HarnessOrchestrationServices {
  const durable = harness.config.host.durable;
  if (durable === undefined) {
    throw new HarnessInputError("Questions for a person need a host with durable services, such as localHost.");
  }
  return durable;
}
