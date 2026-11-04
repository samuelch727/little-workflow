import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { HarnessSession } from "../types.js";
import { HarnessInputError } from "../errors.js";
import { createParkedToolResult } from "../execution/park-resume.js";
import { RERUN_STEP_ID, waitingContinuationId } from "../execution/waiting-tools.js";
import {
  createInputRequest,
  inputRequestId,
  inputTaskState,
  readInputRequest,
  type HumanInputServices,
} from "./requests.js";
import type {
  HumanInputAsk,
  HumanInputOptions,
  HumanInputQuestion,
  HumanInputRequest,
} from "./types.js";

export const DEFAULT_ASK_PERSON_TOOL_NAME = "ask_person";

const DEFAULT_DESCRIPTION =
  "Ask a person a question. It returns at once with a taskId; the person answers later. " +
  "Keep working on whatever does not need the answer. When you need it, call await_tasks with " +
  "the taskId: it returns the answer if there is one, and otherwise pauses this conversation until " +
  "the person replies, then continues it. Offer options when the answer is a choice.";

const askInput = z.object({
  question: z.string().min(1).describe("The question, with what the person needs to answer it."),
  options: z
    .array(z.object({ id: z.string().min(1), label: z.string().min(1) }))
    .max(20)
    .optional()
    .describe("Choices to offer; the answer comes back as the chosen id."),
  allowFreeform: z.boolean().optional().describe("Also accept a written answer when options are given."),
  to: z.string().optional().describe("Who should answer, if the instructions name someone."),
  answerSchema: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("A JSON Schema for a structured answer, returned as `value`."),
});

/** Records the question and sends it out, once per request id. */
async function askPerson(input: {
  readonly services: HumanInputServices;
  readonly session: HarnessSession;
  readonly sessionDataDir: string;
  readonly requestId: string;
  readonly question: HumanInputQuestion;
  readonly deliver?: HumanInputOptions["deliver"];
}): Promise<{ readonly request: HumanInputRequest; readonly deliveryError?: string }> {
  const { request, created } = await createInputRequest({
    services: input.services,
    sessionId: input.session.id,
    sessionDataDir: input.sessionDataDir,
    requestId: input.requestId,
    question: input.question,
  });
  if (!created || input.deliver === undefined) return { request };
  try {
    await input.deliver(request, { session: input.session });
    return { request };
  } catch (error) {
    return { request, deliveryError: error instanceof Error ? error.message : String(error) };
  }
}

export type HumanInputTurn = {
  readonly tools: ToolSet;
  readonly ask: HumanInputAsk;
};

/** The model tool call an `ask` is made in, which `wait` needs. */
export type AskCall = { readonly toolCallId: string; readonly modelStepId: string };

/** On a turn's `ask`: the same `ask`, bound to one tool call. The tool wrapper hands that to the call. */
export const ASK_FOR_CALL: unique symbol = Symbol("little-harness.askForCall");

export type CallAwareAsk = HumanInputAsk & { readonly [ASK_FOR_CALL]?: (call: AskCall) => HumanInputAsk };

export function createHumanInputTurn(config: {
  readonly options: HumanInputOptions;
  readonly services: HumanInputServices;
  readonly session: HarnessSession;
  readonly sessionDataDir: string;
  readonly turnId: string;
}): HumanInputTurn {
  const ask = (requestId: string, question: HumanInputQuestion) =>
    askPerson({
      services: config.services,
      session: config.session,
      sessionDataDir: config.sessionDataDir,
      requestId,
      question,
      ...(config.options.deliver === undefined ? {} : { deliver: config.options.deliver }),
    });
  const tools: ToolSet = config.options.tool === false
    ? {}
    : {
        [config.options.toolName ?? DEFAULT_ASK_PERSON_TOOL_NAME]: tool({
          description: config.options.description ?? DEFAULT_DESCRIPTION,
          inputSchema: askInput,
          execute: async (input, executeOptions) => {
            // Each call is its own question, even when the agent repeats the words.
            const requestId = inputRequestId({
              sessionId: config.session.id,
              turnId: config.turnId,
              toolCallId: executeOptions.toolCallId,
            });
            const { request, deliveryError } = await ask(requestId, input as HumanInputQuestion);
            return {
              status: "asked",
              taskId: request.taskId,
              ...(deliveryError === undefined
                ? {}
                : { delivery: "failed", message: `The question is recorded, but sending it failed: ${deliveryError}` }),
            };
          },
        }),
      };
  // A tool asking again in a later turn, after the answer came, gets the same question back.
  const askFor = (call: AskCall | undefined): HumanInputAsk => async (question, options = {}) => {
    if (options.key !== undefined && (typeof options.key !== "string" || options.key.length === 0)) {
      throw new HarnessInputError("ask() key must be non-empty text.");
    }
    const wait = options.wait === true;
    if (wait && call === undefined) {
      throw new HarnessInputError("ask() with wait works only in a tool the agent called.");
    }
    const requestId = inputRequestId({
      sessionId: config.session.id,
      ...(options.key === undefined ? { question } : { key: options.key }),
    });
    // A call that runs again after its answer finds that question answered; it can't wait anew.
    if (wait && call?.modelStepId === RERUN_STEP_ID
      && await readInputRequest(config.services, config.session.id, requestId) === undefined) {
      throw new HarnessInputError(
        "This tool call already waited for a person once. Call the tool again to ask a new question.",
      );
    }
    const { request, deliveryError } = await ask(requestId, question);
    const task = await config.services.tasks.getTask({ sessionId: config.session.id, taskId: request.taskId });
    const state = task === undefined ? { status: "waiting" as const } : await inputTaskState(config.services, task);
    const asked = {
      requestId: request.requestId,
      taskId: request.taskId,
      ...(state.answer === undefined ? {} : { answer: state.answer }),
      ...(state.answeredBy === undefined ? {} : { answeredBy: state.answeredBy }),
      ...(deliveryError === undefined ? {} : { deliveryError }),
    };
    if (!wait || state.status !== "waiting") return { ...asked, status: state.status };
    // Every call of the step that waits parks on the step's one continuation, made when the step ends.
    return {
      ...asked,
      status: "parked",
      output: createParkedToolResult({
        continuationId: waitingContinuationId({
          sessionId: config.session.id,
          turnId: config.turnId,
          modelStepId: call!.modelStepId,
        }),
        pending: { taskIds: [request.taskId], mode: "all" },
      }),
    };
  };
  const turnAsk: CallAwareAsk = Object.assign(askFor(undefined), { [ASK_FOR_CALL]: askFor });
  return { tools, ask: turnAsk };
}
