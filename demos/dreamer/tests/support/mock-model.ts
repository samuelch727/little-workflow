import { APICallError } from "ai";
import { MockLanguageModelV3 } from "ai/test";

/**
 * A mock model that serves BOTH sides of the dreamer.
 *
 * The agent and its template workflows resolve the same model (`dreamerModel()`), so one
 * mock instance receives the dreamer's own turn, each workflow's planner draft, and each
 * workflow's `ai.generate` step. It routes on the serialized prompt: the dreamer's turn is
 * the only one carrying `instructions.md`, and each workflow names itself in the planning
 * context and in its generate-step prompt.
 *
 * The planner drafts are deliberately answered with the workflow's OUTPUT rather than a
 * plan. That is not laziness: an unparseable draft is what drives `compileWorkflow` to its
 * deterministic `synthesizeSimpleLwir` fallback, which is the exact single-`ai.generate`
 * plan these templates are specified to be — so the test exercises the real compile path
 * without hand-authoring LWIR.
 */

export const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

/**
 * DeepSeek's recurring transport failure, synthesized: a 200 whose body never parsed, which
 * the provider therefore marks NOT retryable — so the AI SDK's own retry loop, gated on
 * `isRetryable`, walks straight past it and the error escapes the investigation.
 *
 * `responseBody` is omitted rather than set to `undefined`: `exactOptionalPropertyTypes` is
 * on, and the field reads back as `undefined` either way — which is the condition the retry
 * wrapper keys on.
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

/** Which side of the dreamer a scripted call belongs to. */
export type ScriptedTarget = "dreamer" | "workflow";

export type ScriptedToolCall = { readonly toolName: string; readonly input: unknown };

/** One model step of the dreamer's own turn: emit tool calls, or finish with text. */
export type ScriptedTurn =
  | { readonly toolCalls: readonly ScriptedToolCall[] }
  | { readonly text: string };

export type ScriptedModelOptions = {
  /** The dreamer's own turn, step by step. Exhausting it finishes with `fallbackText`. */
  readonly turns: readonly ScriptedTurn[];
  /** Answer for a workflow call, given the serialized prompt. Return a value to stringify. */
  readonly workflowOutput?: (promptText: string) => unknown;
  readonly fallbackText?: string;
};

export type ScriptedModel = MockLanguageModelV3 & {
  readonly calls: { dreamerTurns: number; workflowCalls: number };
  /**
   * Re-arm the model with a new script.
   *
   * Needed because a second `loadHarness` in the same process does NOT re-evaluate the agent
   * folder: `little-harness`'s `importDefault` builds a fresh jiti instance per call, but
   * jiti's module cache is process-wide, so `agent.ts` and every `workflows/*.ts` keep the
   * model they captured on the FIRST load. One stable model instance whose script is
   * swapped is therefore the only way several tests in one file can drive different runs.
   */
  setScript(options: ScriptedModelOptions): void;
  /**
   * Arm a ONE-SHOT throw for the next call of the given kind.
   *
   * The throw happens BEFORE the script is consumed, so a retried call replays the same
   * scripted turn and the script stays aligned — which is exactly what a real transient
   * failure looks like from here: the provider never delivered anything, so nothing moved.
   */
  failNext(target: ScriptedTarget, error: unknown): void;
};

/** The marker that identifies the dreamer's own turn: the first line of `instructions.md`. */
const DREAMER_MARKER = "You are the Dreamer.";

type Content =
  | { type: "text"; text: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; input: string };

export function scriptedModel(initial: ScriptedModelOptions): ScriptedModel {
  const calls = { dreamerTurns: 0, workflowCalls: 0 };
  const pendingFailures: Record<ScriptedTarget, unknown> = { dreamer: undefined, workflow: undefined };
  let options = initial;
  let step = 0;

  function respond(prompt: unknown): { content: Content[]; finishReason: "stop" | "tool-calls" } {
    const promptText = JSON.stringify(prompt) ?? "";
    const target: ScriptedTarget = promptText.includes(DREAMER_MARKER) ? "dreamer" : "workflow";

    // Before anything is counted or consumed: a transient failure delivered nothing.
    const pending = pendingFailures[target];
    if (pending !== undefined) {
      pendingFailures[target] = undefined;
      throw pending;
    }

    if (target === "workflow") {
      calls.workflowCalls += 1;
      const value = options.workflowOutput?.(promptText) ?? {};
      return {
        content: [{ type: "text", text: JSON.stringify(value) }],
        finishReason: "stop",
      };
    }

    calls.dreamerTurns += 1;
    const turn = options.turns[step];
    step += 1;
    if (turn === undefined || "text" in turn) {
      return {
        content: [{ type: "text", text: turn?.text ?? options.fallbackText ?? "Investigation complete." }],
        finishReason: "stop",
      };
    }
    return {
      content: turn.toolCalls.map((call, index) => ({
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
    modelId: "dreamer-mock",
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
    calls,
    setScript(next: ScriptedModelOptions) {
      options = next;
      step = 0;
      calls.dreamerTurns = 0;
      calls.workflowCalls = 0;
      pendingFailures.dreamer = undefined;
      pendingFailures.workflow = undefined;
    },
    failNext(target: ScriptedTarget, error: unknown) {
      pendingFailures[target] = error;
    },
  });
}

/** Extract the first `"runId":"..."` the workflow prompt carries, so a card can echo it. */
export function runIdFromPrompt(promptText: string): string {
  return /\\?"runId\\?":\s*\\?"([A-Za-z0-9_-]+)\\?"/.exec(promptText)?.[1] ?? "run_unknown";
}
