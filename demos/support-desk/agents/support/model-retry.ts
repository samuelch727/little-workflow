import { APICallError, wrapLanguageModel } from "ai";
import type { LanguageModel, LanguageModelMiddleware } from "ai";

/**
 * Retry the transport failures the AI SDK refuses to retry.
 *
 * Copied from `demos/dreamer/agents/dreamer/model-retry.ts`, which is where this was first
 * needed. The demos are deliberately self-contained: one importing another's internals would
 * stop being a standalone example of what a user writes.
 *
 * DeepSeek (behind CloudFront, chunked transfer) occasionally answers a request with a
 * **200 whose body never parses**:
 *
 *     APICallError [AI_APICallError]: Failed to process successful response
 *       statusCode: 200, responseBody: undefined, isRetryable: false
 *
 * The SDK's own retry loop is gated on `error.isRetryable === true`, and the provider marks
 * this one `false` because, as far as HTTP is concerned, the call *succeeded*. So nothing
 * retries it and the error propagates out of the investigation. One experiment sweep makes
 * 100+ model calls (35 scenarios x several turns x k repeats), so even a fraction of a
 * percent per call kills a measurable share of episodes — and a scenario that died in
 * transport would be scored as a policy failure it never committed.
 *
 * The reason retrying is safe here — and the reason this is not just "retry harder" — is
 * that an unparseable 200 delivered NOTHING: no content, no tool call, no usage. There is
 * no partial application to double up on, whatever the status line said. That is why the
 * classifier keys on `responseBody == null` rather than on the status code.
 *
 * WHAT IS NOT RETRIED, deliberately:
 *   - Any 4xx that came back with a body. The provider read the request and answered; it
 *     will answer the same way in a second. That includes a well-formed refusal.
 *   - Anything raised after the caller aborted. A retry loop that fights cancellation is a
 *     hang, not a repair.
 *   - A stream that fails *mid-flight*. `wrapStream` retries only the call that returns the
 *     stream; once parts have been handed to the consumer, replaying would duplicate them.
 *     An unparseable response fails before the first part, which is the case that matters.
 */

/** The model shape `wrapLanguageModel` accepts — the spec object, not a bare model id. */
type WrappableModel = Parameters<typeof wrapLanguageModel>[0]["model"];

export type ModelRetryOptions = {
  /** Retries AFTER the first attempt. `3` means up to four calls. */
  readonly maxRetries?: number;
  /** Backoff per retry. The last entry repeats if `maxRetries` outruns the list. */
  readonly delaysMs?: readonly number[];
  /** One line per retry. Defaults to stderr, so a live run shows what happened. */
  readonly log?: (line: string) => void;
  /** Injectable so tests do not actually wait. */
  readonly sleep?: (ms: number) => Promise<void>;
};

export const DEFAULT_MAX_RETRIES = 3;
export const DEFAULT_DELAYS_MS: readonly number[] = [1_000, 2_000, 4_000];

/**
 * Socket-level failures. All of these mean the request died in transit, so the provider
 * either never saw it or never finished answering it — the same "nothing was delivered"
 * argument as the unparseable 200.
 *
 * `ENOTFOUND` is absent on purpose: a hostname that does not resolve will not resolve four
 * seconds later either, and a typo in `DEEPSEEK_BASE_URL` should fail immediately.
 */
const SOCKET_CODES: ReadonlySet<string> = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
]);

function propertyOf(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null && key in value
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/** Errors arrive wrapped as often as not, so the classifier looks down the `cause` chain. */
function errorChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current !== undefined && current !== null; depth += 1) {
    chain.push(current);
    current = propertyOf(current, "cause");
  }
  return chain;
}

function isAbort(error: unknown): boolean {
  const name = propertyOf(error, "name");
  return name === "AbortError" || name === "TimeoutError";
}

/**
 * Why this error is worth another attempt, as a phrase for the log — or `undefined` when it
 * is not. Exported because the classification IS the policy, and a test that pins the policy
 * should not have to drive a whole model to do it.
 */
export function transientReason(error: unknown): string | undefined {
  const chain = errorChain(error);
  if (chain.some(isAbort)) return undefined;

  for (const link of chain) {
    if (!APICallError.isInstance(link)) continue;
    // The observed failure: a response that carried no body at all. Nothing was delivered,
    // so nothing can be double-applied by asking again — whatever the status line claimed.
    if (link.responseBody == null) {
      return `empty response body (HTTP ${link.statusCode ?? "unknown"})`;
    }
    if (link.statusCode !== undefined && link.statusCode >= 500) {
      return `HTTP ${link.statusCode}`;
    }
    // A 4xx (or any other answered call) is the provider's considered reply. Stop here
    // rather than fall through to the socket check: this error is explained.
    return undefined;
  }

  for (const link of chain) {
    const code = propertyOf(link, "code");
    if (typeof code === "string" && SOCKET_CODES.has(code)) return `socket error ${code}`;
  }

  // undici surfaces a dead connection as `TypeError: fetch failed` with the real cause
  // nested; the nested cause is usually one of the codes above, but not always.
  const message = propertyOf(error, "message");
  if (typeof message === "string" && message.includes("fetch failed")) return "fetch failed";

  return undefined;
}

type ResolvedConfig = Required<ModelRetryOptions>;

function resolveConfig(options: ModelRetryOptions): ResolvedConfig {
  return {
    maxRetries: options.maxRetries ?? DEFAULT_MAX_RETRIES,
    delaysMs: options.delaysMs ?? DEFAULT_DELAYS_MS,
    log: options.log ?? ((line) => void process.stderr.write(`${line}\n`)),
    sleep: options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
  };
}

async function runWithRetry<T>(
  label: "doGenerate" | "doStream",
  // `PromiseLike`, not `Promise`: that is what the middleware hands over.
  call: () => PromiseLike<T>,
  abortSignal: AbortSignal | undefined,
  config: ResolvedConfig,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await call();
    } catch (error) {
      const reason = transientReason(error);
      if (reason === undefined) throw error;
      // Checked after classification, not before: a request cancelled mid-flight often
      // fails as a socket error, and retrying a cancelled call is how a stop button hangs.
      if (abortSignal?.aborted === true) throw error;
      if (attempt >= config.maxRetries) throw error;

      const delayMs = config.delaysMs[Math.min(attempt, config.delaysMs.length - 1)] ?? 0;
      config.log(
        `[support-desk] model ${label} failed: ${reason} — retrying in ${delayMs}ms ` +
          `(attempt ${attempt + 2} of ${config.maxRetries + 1})`,
      );
      await config.sleep(delayMs);
    }
  }
}

/**
 * Both halves are load-bearing, and covering only one is the easy mistake:
 *
 *   - `wrapGenerate` covers the dreamer's own turns — `generateHarness` runs them through
 *     `generateText`, which calls `doGenerate`. That is the path in the observed stack.
 *   - `wrapStream` covers the template workflows' `ai.generate` steps and their planner
 *     drafts — the workflow harness prefers `streamText` when the AI SDK module exposes it
 *     (`packages/little-harness/src/workflow-harness/workflow-harness.ts`), so every one of
 *     the sweep's 61 calls arrives at `doStream`, not `doGenerate`.
 */
export function modelRetryMiddleware(options: ModelRetryOptions = {}): LanguageModelMiddleware {
  const config = resolveConfig(options);
  return {
    specificationVersion: "v3",
    wrapGenerate: ({ doGenerate, params }) =>
      runWithRetry("doGenerate", doGenerate, params.abortSignal, config),
    wrapStream: ({ doStream, params }) =>
      runWithRetry("doStream", doStream, params.abortSignal, config),
  };
}

/**
 * Wrap a model so its transport blips are retried.
 *
 * Transparent by construction: a model that does not throw a transient error behaves
 * exactly as it did unwrapped, which is why the mock seam can be wrapped too (see
 * `supportModel()`) — and why the end-to-end test can prove the wrapper is really in the
 * path instead of asserting that a file exists.
 */
export function withModelRetry(model: LanguageModel, options: ModelRetryOptions = {}): LanguageModel {
  // A bare model id has no `doGenerate` to wrap; the provider resolves it later.
  if (typeof model === "string") return model;
  // `LanguageModel` still admits the retired V2 spec, which `wrapLanguageModel` no longer
  // takes. Nothing in this demo produces one: the provider returns V3 and the test seam
  // installs `MockLanguageModelV3`.
  return wrapLanguageModel({
    model: model as WrappableModel,
    middleware: modelRetryMiddleware(options),
  });
}
