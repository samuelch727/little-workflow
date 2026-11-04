import type { JSONSchema7 } from "ai";
import type { ParkedToolOutput } from "../execution/park-resume.js";
import type { HarnessSession } from "../types.js";
import type { HarnessTaskId } from "../tasks/types.js";

/** One choice offered with a question. */
export type HumanInputOption = {
  readonly id: string;
  readonly label: string;
};

/** What the agent (or a tool, through `ask`) asks. */
export type HumanInputQuestion = {
  readonly question: string;
  readonly options?: readonly HumanInputOption[];
  /** Whether a free-text answer is accepted when `options` are given. Default false. */
  readonly allowFreeform?: boolean;
  /** Who should answer, in the app's own terms ("underwriter", an email address). Informational. */
  readonly to?: string;
  /** A JSON Schema the answer's `value` must match. */
  readonly answerSchema?: JSONSchema7;
};

/** A question waiting for, or holding, a person's answer. */
export type HumanInputRequest = HumanInputQuestion & {
  readonly requestId: string;
  readonly sessionId: string;
  readonly taskId: HarnessTaskId;
  readonly askedAt: string;
};

/**
 * A person's answer. Give `option` (one of the question's option ids), `text`, or `value` (checked
 * against `answerSchema`); `text` can also go with `option` as a note.
 */
export type HumanInputAnswer = {
  readonly option?: string;
  readonly text?: string;
  readonly value?: unknown;
};

export type HumanInputAnswerRecord = {
  readonly answer: HumanInputAnswer;
  readonly answeredBy?: string;
  readonly answeredAt: string;
};

export type HumanInputOptions = {
  /**
   * Whether the agent gets the `ask_person` tool. Default true. Set false to let only your own
   * tools ask, through `ask` in their execution context.
   */
  readonly tool?: boolean;
  /** The tool's name. Default `ask_person`. */
  readonly toolName?: string;
  /** The tool's description, to tell the agent when to ask and whom. */
  readonly description?: string;
  /**
   * Sends a new question to a person: a Slack message, an email, a row in your own inbox. Called
   * once per question. The answer comes back through `answerInputRequest`. When it throws, the
   * question still stands and the agent is told delivery failed.
   */
  readonly deliver?: (request: HumanInputRequest, context: { readonly session: HarnessSession }) => void | Promise<void>;
};

/** Where a question stands, as `ask` and `listInputRequests` return it. */
export type HumanInputStatus = "waiting" | "answered" | "cancelled";

/** What `ask` in a tool's execution context returns. */
export type HumanInputAsked = {
  readonly requestId: string;
  readonly taskId: HarnessTaskId;
  /** `parked` only with `wait: true`, while the question has no answer. */
  readonly status: HumanInputStatus | "parked";
  /** The person's answer, once there is one. */
  readonly answer?: HumanInputAnswer;
  readonly answeredBy?: string;
  /** Why sending the question failed, when `deliver` threw. The question still stands. */
  readonly deliveryError?: string;
  /** With status `parked`: return this from the tool, and the turn pauses until the answer. */
  readonly output?: ParkedToolOutput;
};

export type HumanInputAskOptions = {
  /**
   * What makes two questions the same. By default a tool asking the same question again in the
   * same session gets the first question back, with its answer once there is one. Give a key to
   * ask the same words again as a new question, or to match a reworded one.
   */
  readonly key?: string;
  /**
   * Wait for the answer in this tool call. While the question has no answer, `ask` returns status
   * `parked` with an `output`: return it from the tool, and the turn pauses after this step, as
   * it does in `await_tasks`. Once every question the step waits on has an answer, the turn
   * continues by running this tool call's `execute` again, with the same `toolCallId` and input
   * and the continuing turn's `extraBody`, and this `ask` returns the answer. So the tool must be
   * safe to run again up to its `ask`. A call waits once: in that second run, a new question
   * with `wait` fails the call, and the agent can call the tool again. Only for a tool the agent
   * called.
   */
  readonly wait?: boolean;
};

/** `ask` in a tool's execution context, when the harness has `humanInput`. */
export type HumanInputAsk = (question: HumanInputQuestion, options?: HumanInputAskOptions) => Promise<HumanInputAsked>;
