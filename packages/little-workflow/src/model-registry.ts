import { existsSync, readFileSync } from "node:fs";

export type ModelInfo = {
  readonly description: string;
  readonly capabilities: readonly string[];
  /**
   * USD per {@link TOKENS_PER_PRICE_UNIT} (one million) tokens.
   *
   * `input` is the **full, uncached** input rate — the "cache miss" column where a
   * provider publishes one. `cachedInput` is the provider's published cache-read /
   * cache-hit rate. `cachedInput` is **optional on purpose**: a model whose cache-read
   * rate could not be sourced from official pricing omits the field, and
   * `priceModelCall` then bills cache hits at the full `input` rate. Never fill this in
   * from memory — a wrong cache rate silently misstates cache-spread economics.
   *
   * Three real-world pricing shapes this per-token schema cannot express. Where an entry
   * is affected, the rate recorded here is the one stated below and the shortfall is a
   * known under-report, not a modelling accident:
   *
   * - **Tiered by prompt size.** `google/gemini-2.5-pro` is listed at its ≤200k-token
   *   tier ($1.25 / $10.00); prompts above 200k tokens bill at $2.50 / $15.00. A single
   *   rate pair cannot carry the breakpoint, so long-prompt Gemini spend is under-stated.
   * - **Cache storage billed per hour.** Gemini's context cache adds a *storage* fee of
   *   $4.50 (Pro) / $1.00 (Flash) per 1M tokens **per hour** on top of the per-token
   *   cache-read rate. That is a function of wall-clock time, not of tokens, so no
   *   per-token registry can represent it. `cachedInput` here is the read rate only.
   * - **Per-request fees.** `perplexity/sonar-pro` charges $5–$12 per 1,000 requests for
   *   search context in addition to tokens. Only the token rates are recorded.
   *
   * One provider-side token-accounting mismatch is also worth knowing about, because it
   * would corrupt costs rather than merely under-state them: **AWS Bedrock reports cache
   * reads additively** (`input + cacheRead` are disjoint counts), whereas
   * `priceModelCall` encodes the OpenAI/AI-SDK convention that `cachedInputTokens` is a
   * *subset of* `inputTokens`. If Bedrock-reported usage is ever fed in directly, the
   * normalizer — not this table — must reconcile it first.
   */
  readonly pricing: {
    readonly input: number;
    readonly output: number;
    readonly cachedInput?: number;
    readonly currency: "USD";
  };
  readonly contextWindow: number;
  /**
   * URL of the **official provider pricing page** the rates above were read from.
   *
   * Required on every priced entry and mutually exclusive with {@link unverified}: a
   * rate either has a citation or is openly marked as uncited. Nothing in between —
   * an unsourced number that looks sourced is the exact defect this field exists to
   * prevent. `model-registry.test.ts` enforces the invariant.
   */
  readonly pricingSource?: string;
  /**
   * `true` when no official published rate could be sourced for this model, so the
   * numbers above are inherited from an earlier revision of this file and are **not**
   * evidence of anything. Such an entry carries no {@link pricingSource}, and its id
   * must appear in the explicit allowlist in `model-registry.test.ts` — a *new*
   * unsourced entry therefore fails the suite rather than quietly joining the exempt
   * class.
   *
   * Prefer removing an entry over marking it unverified when the model is delisted:
   * an absent model prices as `costUsd: null` plus an `unpricedCalls` increment, which
   * reports as "unknown" rather than as a confident wrong number.
   */
  readonly unverified?: true;
  /**
   * ISO calendar date (`YYYY-MM-DD`, UTC) on which {@link pricingSource} was last read
   * and the rates confirmed. Required on every sourced entry; omitted on
   * {@link unverified} entries, which have nothing to have been verified against.
   *
   * This is the input to the staleness check in `model-registry.test.ts`. Bump it only
   * after actually re-reading the provider's page — copying a newer date forward
   * without re-checking defeats the whole mechanism.
   */
  readonly pricingVerifiedAt?: string;
};

const MODEL_REGISTRY = readModelRegistry();

/**
 * The bundled registry, as a plain record.
 *
 * Exposed so the provenance and staleness suite can audit **every** entry rather than
 * only the ones some test happens to look up. Production pricing goes through
 * {@link getModelInfoFor}, which applies the provider-id normalization below.
 */
export const modelRegistry: Readonly<Record<string, ModelInfo>> = MODEL_REGISTRY;

/**
 * Registry keys to try for one `(providerId, modelId)` pair, **most specific first**.
 *
 * The AI SDK does not report a bare provider name. Every provider package stamps its
 * language models with `` `${providerName}.${modelType}` `` — `@ai-sdk/openai` emits
 * `openai.responses` (what `openai("gpt-4o-mini")` returns), `openai.chat`,
 * `openai.completion`, …; `@ai-sdk/deepseek` emits `deepseek.chat`. Registry keys are
 * written against the bare provider (`openai/gpt-4o-mini`), so a literal lookup misses
 * every real model and reports it as unpriced.
 *
 * Trailing dot-segments are therefore stripped from the **provider portion only**, one at
 * a time, until a match is found or no dots remain. The model id is never touched: model
 * ids legitimately contain dots (`gpt-4.1`, `claude-3.5-haiku`) and stripping the joined
 * string would corrupt them.
 *
 * Why this cannot match a *wrong* entry:
 *
 * - Candidates are proper dot-segment prefixes of the reported provider, never
 *   substrings or fuzzy matches — `openai.responses` can only reach `openai`, never
 *   `azure` or `amazon`.
 * - The model id must still match exactly, so a provider prefix alone never prices
 *   anything.
 * - The unstripped key is tried first, so a registry entry literally named
 *   `foo.bar/model` shadows `foo/model` for a model reported as `foo.bar`.
 * - A model absent from the registry under every candidate still returns `undefined`,
 *   which {@link priceModelCall} reports as `costUsd: null` plus an unpriced call.
 *
 * The suffix set is deliberately not enumerated: it is provider-specific and grows with
 * every new modality the AI SDK adds.
 */
export function modelRegistryKeys(providerId: string, modelId: string): readonly string[] {
  const keys: string[] = [];
  let provider = providerId;
  for (;;) {
    keys.push(`${provider}/${modelId}`.toLowerCase());
    const lastDot = provider.lastIndexOf(".");
    if (lastDot <= 0) {
      return keys;
    }
    provider = provider.slice(0, lastDot);
  }
}

/**
 * Looks a model up in the registry, normalizing the AI SDK's sub-model provider suffixes.
 * See {@link modelRegistryKeys} for the normalization contract.
 *
 * `registry` exists so the lookup order can be tested against a registry that actually
 * contains a dotted provider key; production callers always use the bundled registry.
 */
export function getModelInfoFor(
  providerId: string,
  modelId: string,
  registry: Readonly<Record<string, ModelInfo>> = MODEL_REGISTRY,
): ModelInfo | undefined {
  for (const key of modelRegistryKeys(providerId, modelId)) {
    const info = registry[key];
    if (info !== undefined) {
      return info;
    }
  }
  return undefined;
}

function readModelRegistry(): Readonly<Record<string, ModelInfo>> {
  for (const url of modelRegistryUrls()) {
    if (!existsSync(url)) {
      continue;
    }
    return JSON.parse(readFileSync(url, "utf8")) as Readonly<Record<string, ModelInfo>>;
  }
  throw new Error("Unable to locate model-registry.json.");
}

function modelRegistryUrls(): readonly URL[] {
  return [
    new URL("./model-registry.json", import.meta.url),
    new URL("../src/model-registry.json", import.meta.url),
  ];
}
