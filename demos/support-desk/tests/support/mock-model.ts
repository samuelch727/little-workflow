import { APICallError } from "ai";
import { MockLanguageModelV3 } from "ai/test";

/**
 * A scripted stand-in for the support agent's model.
 *
 * One flat queue of STEPS, consumed in order across the whole episode: the harness calls the
 * model once per step, so `[{toolCalls:[…]}, {text:"…"}]` is "call these tools, then answer".
 * A queue rather than a per-turn structure because that is exactly what the harness sees, and
 * a test that scripts an episode is really scripting a sequence of model steps.
 *
 * The mock is what makes the suite hermetic without pretending: the tools, the episode
 * store, the action log, the grader, the littleDB wiring and the driver are all the real
 * ones. Only the thing that would cost money and vary between runs is replaced.
 */

export const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

/**
 * DeepSeek's recurring transport failure, synthesized: a 200 whose body never parsed, which
 * the provider therefore marks NOT retryable — so the AI SDK's own retry loop, gated on
 * `isRetryable`, walks straight past it.
 *
 * `responseBody` is omitted rather than set to `undefined`: `exactOptionalPropertyTypes` is
 * on, and the field reads back as `undefined` either way — which is the condition
 * `model-retry.ts` keys on.
 */
export function unparseableSuccessError(): APICallError {
  return new APICallError({
    message: "Failed to process successful response",
    url: "https://api.deepseek.com/v1/chat/completions",
    requestBodyValues: {},
    statusCode: 200,
    isRetryable: false,
  });
}

export type ScriptedToolCall = { readonly toolName: string; readonly input: unknown };

/** One model step: emit tool calls, or finish the turn with text. */
export type ScriptedStep =
  | { readonly toolCalls: readonly ScriptedToolCall[] }
  | { readonly text: string };

export type ScriptedModelOptions = {
  readonly steps: readonly ScriptedStep[];
  /** Used once the script runs out, so an over-long episode ends rather than hangs. */
  readonly fallbackText?: string;
};

export type ScriptedModel = MockLanguageModelV3 & {
  /** Every serialized prompt the model was handed, in order. */
  readonly prompts: string[];
  readonly calls: { steps: number };
  /**
   * Re-arm with a new script.
   *
   * Needed because a second `loadHarness` in the same process does NOT re-evaluate the agent
   * folder — jiti's module cache is process-wide, so `agent.ts` keeps the model it captured
   * on the first load. One stable instance whose script is swapped is the only way several
   * tests in one file can drive different episodes.
   */
  setScript(options: ScriptedModelOptions): void;
  /**
   * Arm a ONE-SHOT throw for the next call.
   *
   * The throw happens BEFORE the script is consumed, so a retried call replays the same
   * scripted step and the script stays aligned — which is what a real transient failure looks
   * like from here: the provider never delivered anything, so nothing moved.
   */
  failNext(error: unknown): void;
};

type Content =
  | { type: "text"; text: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; input: string };

export function scriptedModel(initial: ScriptedModelOptions): ScriptedModel {
  const prompts: string[] = [];
  const calls = { steps: 0 };
  let options = initial;
  let step = 0;
  let pendingFailure: unknown;

  function respond(prompt: unknown): { content: Content[]; finishReason: "stop" | "tool-calls" } {
    prompts.push(JSON.stringify(prompt) ?? "");

    if (pendingFailure !== undefined) {
      const failure = pendingFailure;
      pendingFailure = undefined;
      throw failure;
    }

    calls.steps += 1;
    const current = options.steps[step];
    step += 1;
    if (current === undefined || "text" in current) {
      return {
        content: [
          { type: "text", text: current?.text ?? options.fallbackText ?? "Is there anything else?" },
        ],
        finishReason: "stop",
      };
    }
    return {
      content: current.toolCalls.map((call, index) => ({
        type: "tool-call" as const,
        toolCallId: `call_${step}_${index}`,
        toolName: call.toolName,
        input: JSON.stringify(call.input),
      })),
      finishReason: "tool-calls",
    };
  }

  const model = new MockLanguageModelV3({
    provider: "test",
    modelId: "support-mock",
    doGenerate: async ({ prompt }) => {
      const { content, finishReason } = respond(prompt);
      return {
        content,
        finishReason: { unified: finishReason, raw: finishReason },
        usage,
        warnings: [],
      };
    },
    doStream: async ({ prompt }) => {
      const { content, finishReason } = respond(prompt);
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            for (const [index, part] of content.entries()) {
              if (part.type === "text") {
                const id = String(index);
                controller.enqueue({ type: "text-start", id });
                controller.enqueue({ type: "text-delta", id, delta: part.text });
                controller.enqueue({ type: "text-end", id });
              } else {
                controller.enqueue(part);
              }
            }
            controller.enqueue({
              type: "finish",
              finishReason: { unified: finishReason, raw: finishReason },
              usage,
            });
            controller.close();
          },
        }),
      };
    },
  });

  return Object.assign(model, {
    prompts,
    calls,
    setScript(next: ScriptedModelOptions) {
      options = next;
      step = 0;
      calls.steps = 0;
      pendingFailure = undefined;
      prompts.length = 0;
    },
    failNext(error: unknown) {
      pendingFailure = error;
    },
  });
}
