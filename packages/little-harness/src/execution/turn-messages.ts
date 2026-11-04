import { createHash } from "node:crypto";
import type { UIMessage } from "ai";
import { HarnessInputError } from "../errors.js";

/** How a turn's messages can be given to `generateHarness` and `streamHarness`. */
export type HarnessTurnMessages = {
  /** One user message, as plain text. Use this or `messages`, not both. */
  prompt?: string;
  messages?: UIMessage[];
  type?: string;
  input?: unknown;
};

/**
 * The options with `prompt` turned into one user UI message. Messages without `parts` (the AI
 * SDK's `{ role, content }` shape) are refused here with a clear error, instead of failing deep
 * inside the AI SDK.
 */
export function withTurnMessages<T extends HarnessTurnMessages>(options: T): Omit<T, "prompt"> {
  const { prompt, ...rest } = options;
  if (prompt !== undefined) {
    if (options.messages !== undefined) {
      throw new HarnessInputError("Pass `prompt` or `messages`, not both.");
    }
    if (options.type !== undefined || options.input !== undefined) {
      throw new HarnessInputError("Pass `prompt` or `type` + `input`, not both.");
    }
    if (typeof prompt !== "string" || prompt.trim().length === 0) {
      throw new HarnessInputError("`prompt` must be non-empty text.");
    }
    const id = `prompt_${createHash("sha256").update(prompt).digest("hex").slice(0, 16)}`;
    return { ...rest, messages: [{ id, role: "user", parts: [{ type: "text", text: prompt }] }] };
  }
  options.messages?.forEach((message, index) => {
    if (!Array.isArray((message as Partial<UIMessage> | undefined)?.parts)) {
      throw new HarnessInputError(
        `messages[${index}] has no \`parts\`. Pass UI messages ({ id, role, parts }), or \`prompt\` for one text message.`,
        { index },
      );
    }
  });
  return rest;
}
