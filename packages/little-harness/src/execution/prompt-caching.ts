import type { SystemModelMessage } from "ai";

/**
 * Anthropic prompt caching for the agent's model calls (`createHarness({ promptCaching })`, on by
 * default). Two cache points:
 *
 * - one on the system prompt. Anthropic renders tools, then system, so the tool definitions and
 *   instructions every session repeats are read from the cache by the next session, not only the
 *   next step;
 * - Anthropic's automatic one (top-level `cache_control`) at the end of the conversation, which
 *   moves forward with each step, so a step reads everything the step before it sent.
 *
 * Both ride in `providerOptions.anthropic`. The automatic one is left out on Amazon Bedrock (a
 * model whose provider id starts with `bedrock`, such as `@ai-sdk/amazon-bedrock`'s Anthropic
 * models): Bedrock's InvokeModel rejects a top-level `cache_control` with a 400 for older Claude
 * models. The system-prompt point is kept there.
 */
const EPHEMERAL = { type: "ephemeral" } as const;

type Request = Record<string, unknown>;
type CacheControl = Record<string, unknown>;

/** Adds the two cache points to a generateText or streamText request, in place. */
export function withPromptCaching(request: Request): void {
  const providerOptions = isObject(request.providerOptions) ? request.providerOptions : {};
  const anthropic = isObject(providerOptions.anthropic) ? providerOptions.anthropic : {};
  // A caller's own cacheControl (a 1h TTL, say) wins, and the system prompt gets the same one:
  // Anthropic rejects a 5m cache point ahead of a 1h one.
  const cacheControl = isObject(anthropic.cacheControl) ? anthropic.cacheControl : EPHEMERAL;
  if (!isBedrockModel(request.model)) {
    request.providerOptions = { ...providerOptions, anthropic: { ...anthropic, cacheControl } };
  }
  request.instructions = cachedInstructions(request.instructions, cacheControl);
  const prepareStep = request.prepareStep;
  if (typeof prepareStep === "function") {
    request.prepareStep = async (event: unknown) => {
      const result: unknown = await (prepareStep as (event: unknown) => unknown)(event);
      if (!isObject(result)) return result;
      const next: Request = { ...result };
      // A step that swaps the system prompt keeps the cache point on it.
      for (const key of ["instructions", "system"] as const) {
        if (next[key] !== undefined) next[key] = cachedInstructions(next[key], cacheControl);
      }
      return next;
    };
  }
}

/**
 * The system prompt the step event reports, as the plain text the harness records. Undoes
 * `cachedInstructions`, so model-call events and replay lookups are the same with caching on or off.
 */
export function uncachedInstructions(value: unknown): unknown {
  return isCachedInstructions(value) ? value.content : value;
}

function isBedrockModel(model: unknown): boolean {
  return isObject(model) && typeof model.provider === "string" && model.provider.startsWith("bedrock");
}

function cachedInstructions(value: unknown, cacheControl: CacheControl): unknown {
  // Only a plain string prompt is marked: a caller's system messages keep their own options.
  if (typeof value !== "string" || value.length === 0) return value;
  const message: SystemModelMessage = {
    role: "system",
    content: value,
    providerOptions: { anthropic: { cacheControl } } as NonNullable<SystemModelMessage["providerOptions"]>,
  };
  return message;
}

/** A system message `cachedInstructions` made: string content, and only the cache point as options. */
function isCachedInstructions(value: unknown): value is { content: string } {
  if (!isObject(value) || value.role !== "system" || typeof value.content !== "string") return false;
  if (Object.keys(value).some((key) => key !== "role" && key !== "content" && key !== "providerOptions")) return false;
  const options = value.providerOptions;
  return (
    isObject(options) &&
    Object.keys(options).length === 1 &&
    isObject(options.anthropic) &&
    Object.keys(options.anthropic).length === 1 &&
    isObject(options.anthropic.cacheControl)
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
