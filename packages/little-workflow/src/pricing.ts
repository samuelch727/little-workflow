import { getModelInfoFor } from "./model-registry.js";

/**
 * Registry pricing (`model-registry.json` → `pricing.input` / `pricing.output` /
 * `pricing.cachedInput`) is quoted in USD per one million tokens. Every conversion from
 * tokens to dollars in this package goes through this constant — never divide by a bare
 * literal elsewhere. `pricing.test.ts` pins the convention with hand-computed dollars.
 */
export const TOKENS_PER_PRICE_UNIT = 1_000_000;

/**
 * Per-call token counts as normalized by the harness (`normalizeAiSdkUsage`).
 *
 * Token semantics, which the cost math depends on:
 *
 * - `cachedInputTokens` is a **subset of** `inputTokens`, not an addition to it. This
 *   mirrors the provider shapes the normalizer reads from — OpenAI's
 *   `prompt_tokens_details.cached_tokens` and the AI SDK's `cachedInputTokens` are both
 *   counted inside the prompt-token total. Billable uncached input is therefore
 *   `max(0, inputTokens - cachedInputTokens)`.
 * - `reasoningTokens` is a **subset of** `outputTokens` (OpenAI's
 *   `completion_tokens_details.reasoning_tokens`). Providers bill reasoning at the normal
 *   output rate, so reasoning tokens are priced as output and are **not** charged again.
 *   The field is carried through for reporting only.
 */
export type ModelCallUsage = {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly reasoningTokens?: number;
};

/**
 * Identity of the model that served a call, as recorded on the durable event.
 *
 * `provider` is whatever the model object reported, which for every AI SDK provider is
 * `` `${providerName}.${modelType}` `` (`openai.responses`, `deepseek.chat`) rather than a
 * bare provider name. Normalizing that back to a registry key is
 * {@link getModelInfoFor}'s job — do not pre-strip it at a call site.
 */
export type ModelCallIdentity = {
  readonly provider?: string;
  readonly modelId?: string;
};

export type PricedModelCall = {
  /** Real dollars for this call, or `null` when the model has no registry pricing. */
  readonly costUsd: number | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
  readonly reasoningTokens: number;
  /** Input tokens billed at the full input rate (total input minus cache hits). */
  readonly uncachedInputTokens: number;
  /**
   * True when the cached tokens were billed at the full input rate because the registry
   * has no `cachedInput` entry for this model. The call is still priced; the cost is a
   * conservative upper bound rather than a silent discount.
   */
  readonly cachedInputRateFellBack: boolean;
};

/** Running totals for a step, a session, or a whole run. */
export type UsageTotals = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
  readonly reasoningTokens: number;
  /**
   * Summed dollars across priced calls, or `null` when the figure is not known — either
   * nothing could be priced (`pricedCalls === 0 && unpricedCalls > 0`) or the usage
   * itself could not be recovered ({@link unknownUsageTotals}). Either way an unknown
   * receipt is never mistaken for a genuine $0. A scope with no model calls at all is a
   * true `0`.
   */
  readonly costUsd: number | null;
  readonly pricedCalls: number;
  readonly unpricedCalls: number;
};

/**
 * Totals for a scope that provably made no model calls: a measured, genuine `$0`.
 *
 * Do **not** use this as a fallback for usage that could not be read — that turns
 * "unknown" into an affirmative claim of zero spend. Use {@link unknownUsageTotals}.
 */
export function emptyUsageTotals(): UsageTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    costUsd: 0,
    pricedCalls: 0,
    unpricedCalls: 0,
  };
}

/**
 * Totals for a scope whose usage could not be recovered at all.
 *
 * Identical to {@link emptyUsageTotals} except `costUsd` is `null`: the zeroes are
 * placeholders, not measurements, so the dollar figure must read as *unknown* rather than
 * as a receipt for $0.
 */
export function unknownUsageTotals(): UsageTotals {
  return { ...emptyUsageTotals(), costUsd: null };
}

/**
 * The single place a model call is converted into dollars.
 *
 * Returns `costUsd: null` when the model is absent from the registry (or carries no
 * identity on the event), so an unpriced call can never be silently reported as $0.
 */
export function priceModelCall(
  identity: ModelCallIdentity,
  usage: ModelCallUsage,
): PricedModelCall {
  const inputTokens = tokenCount(usage.inputTokens);
  const outputTokens = tokenCount(usage.outputTokens);
  const reasoningTokens = Math.min(tokenCount(usage.reasoningTokens), outputTokens);
  const cachedInputTokens = Math.min(tokenCount(usage.cachedInputTokens), inputTokens);
  const uncachedInputTokens = inputTokens - cachedInputTokens;

  const pricing = pricingFor(identity);
  if (pricing === undefined) {
    return {
      costUsd: null,
      inputTokens,
      outputTokens,
      cachedInputTokens,
      reasoningTokens,
      uncachedInputTokens,
      cachedInputRateFellBack: false,
    };
  }

  // No published cache-read rate for this model: bill cache hits at the full input rate
  // rather than inventing a discount.
  const cachedInputRate = pricing.cachedInput ?? pricing.input;
  const costUsd =
    (uncachedInputTokens * pricing.input +
      cachedInputTokens * cachedInputRate +
      outputTokens * pricing.output) /
    TOKENS_PER_PRICE_UNIT;

  return {
    costUsd,
    inputTokens,
    outputTokens,
    cachedInputTokens,
    reasoningTokens,
    uncachedInputTokens,
    cachedInputRateFellBack: pricing.cachedInput === undefined,
  };
}

/** Folds one priced call into running totals. Never coerces an unpriced call to $0. */
export function addPricedCall(totals: UsageTotals, call: PricedModelCall): UsageTotals {
  const pricedCalls = totals.pricedCalls + (call.costUsd === null ? 0 : 1);
  const unpricedCalls = totals.unpricedCalls + (call.costUsd === null ? 1 : 0);
  return {
    inputTokens: totals.inputTokens + call.inputTokens,
    outputTokens: totals.outputTokens + call.outputTokens,
    cachedInputTokens: totals.cachedInputTokens + call.cachedInputTokens,
    reasoningTokens: totals.reasoningTokens + call.reasoningTokens,
    costUsd: pricedCalls === 0 ? (unpricedCalls === 0 ? 0 : null) : (totals.costUsd ?? 0) + (call.costUsd ?? 0),
    pricedCalls,
    unpricedCalls,
  };
}

/** Merges a child scope's totals into a parent scope's totals. */
export function mergeUsageTotals(a: UsageTotals, b: UsageTotals): UsageTotals {
  const pricedCalls = a.pricedCalls + b.pricedCalls;
  const unpricedCalls = a.unpricedCalls + b.unpricedCalls;
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
    costUsd: pricedCalls === 0 ? (unpricedCalls === 0 ? 0 : null) : (a.costUsd ?? 0) + (b.costUsd ?? 0),
    pricedCalls,
    unpricedCalls,
  };
}

/** Share of input tokens served from cache, in `[0, 1]`. Zero when there was no input. */
export function cacheHitShare(totals: {
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
}): number {
  return totals.inputTokens === 0 ? 0 : totals.cachedInputTokens / totals.inputTokens;
}

function pricingFor(identity: ModelCallIdentity):
  | { readonly input: number; readonly output: number; readonly cachedInput?: number }
  | undefined {
  const { provider, modelId } = identity;
  if (typeof provider !== "string" || provider.length === 0) {
    return undefined;
  }
  if (typeof modelId !== "string" || modelId.length === 0) {
    return undefined;
  }
  return getModelInfoFor(provider, modelId)?.pricing;
}

function tokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}
