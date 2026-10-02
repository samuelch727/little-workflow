import { describe, expect, it } from "vitest";
import { getModelInfoFor, modelRegistryKeys } from "./model-registry.js";
import {
  TOKENS_PER_PRICE_UNIT,
  addPricedCall,
  cacheHitShare,
  emptyUsageTotals,
  mergeUsageTotals,
  priceModelCall,
} from "./pricing.js";

describe("pricing unit convention", () => {
  it("treats registry pricing as USD per one million tokens", () => {
    expect(TOKENS_PER_PRICE_UNIT).toBe(1_000_000);
  });

  it("prices a known model with hand-computed dollars", () => {
    // openai/gpt-4o is listed at input $2.50 / output $10.00 per 1M tokens.
    // 1,000,000 input tokens  x $2.50 / 1M = $2.50
    //   500,000 output tokens x $10.00 / 1M = $5.00
    //                                 total = $7.50
    const call = priceModelCall(
      { provider: "openai", modelId: "gpt-4o" },
      { inputTokens: 1_000_000, outputTokens: 500_000 },
    );

    expect(call.costUsd).toBeCloseTo(7.5, 10);
  });

  it("prices a realistic small call with hand-computed dollars", () => {
    // openai/gpt-4o-mini is listed at input $0.15 / output $0.60 per 1M tokens.
    // 10,000 input  x $0.15 / 1M = $0.0015
    //  2,000 output x $0.60 / 1M = $0.0012
    //                     total = $0.0027
    const call = priceModelCall(
      { provider: "openai", modelId: "gpt-4o-mini" },
      { inputTokens: 10_000, outputTokens: 2_000 },
    );

    expect(call.costUsd).toBeCloseTo(0.0027, 12);
  });

  it("bills cache hits at the cached-input rate when the registry publishes one", () => {
    const pricing = getModelInfoFor("openai", "gpt-4o-mini")?.pricing;
    expect(pricing?.cachedInput).toBeDefined();

    // 10,000 total input of which 8,000 were cache hits, plus 2,000 output.
    //   2,000 uncached x $0.150 / 1M = $0.00030
    //   8,000 cached   x $0.075 / 1M = $0.00060
    //   2,000 output   x $0.600 / 1M = $0.00120
    //                          total = $0.00210
    const call = priceModelCall(
      { provider: "openai", modelId: "gpt-4o-mini" },
      { inputTokens: 10_000, cachedInputTokens: 8_000, outputTokens: 2_000 },
    );

    expect(call.uncachedInputTokens).toBe(2_000);
    expect(call.cachedInputRateFellBack).toBe(false);
    expect(call.costUsd).toBeCloseTo(0.0021, 12);
  });
});

describe("token semantics", () => {
  it("treats cached input tokens as a subset of input tokens", () => {
    const call = priceModelCall(
      { provider: "openai", modelId: "gpt-4o" },
      { inputTokens: 1_000, cachedInputTokens: 400, outputTokens: 0 },
    );

    expect(call.inputTokens).toBe(1_000);
    expect(call.uncachedInputTokens).toBe(600);
    expect(cacheHitShare(call)).toBeCloseTo(0.4, 12);
  });

  it("clamps a cached count that exceeds the reported input total", () => {
    const call = priceModelCall(
      { provider: "openai", modelId: "gpt-4o" },
      { inputTokens: 100, cachedInputTokens: 500, outputTokens: 0 },
    );

    expect(call.cachedInputTokens).toBe(100);
    expect(call.uncachedInputTokens).toBe(0);
  });

  it("does not charge reasoning tokens on top of output tokens", () => {
    const withReasoning = priceModelCall(
      { provider: "openai", modelId: "o4-mini" },
      { inputTokens: 1_000, outputTokens: 5_000, reasoningTokens: 4_000 },
    );
    const withoutReasoning = priceModelCall(
      { provider: "openai", modelId: "o4-mini" },
      { inputTokens: 1_000, outputTokens: 5_000 },
    );

    expect(withReasoning.reasoningTokens).toBe(4_000);
    expect(withReasoning.costUsd).toBe(withoutReasoning.costUsd);
  });

  it("falls back to the full input rate when a model has no published cached rate", () => {
    const pricing = getModelInfoFor("mistral", "mistral-large-latest")?.pricing;
    expect(pricing?.cachedInput).toBeUndefined();

    // mistral/mistral-large-latest is listed at input $2.00 / output $6.00 per 1M tokens
    // with no published cache-read rate, so all 1,000 input tokens bill at the full input
    // rate.
    //   1,000 input x $2.00 / 1M = $0.002
    const call = priceModelCall(
      { provider: "mistral", modelId: "mistral-large-latest" },
      { inputTokens: 1_000, cachedInputTokens: 1_000, outputTokens: 0 },
    );

    expect(call.cachedInputRateFellBack).toBe(true);
    expect(call.costUsd).toBeCloseTo(0.002, 12);
  });
});

describe("AI SDK sub-model provider ids", () => {
  // These are the literal `.provider` strings the installed provider packages stamp on
  // their language models — verified against @ai-sdk/openai 3.0.65 and
  // @ai-sdk/deepseek 2.0.39, not invented for the test. Registry keys are bare
  // (`openai/gpt-4o-mini`), so without normalization every real model is unpriced.

  it("prices the model `openai(\"gpt-4o-mini\")` actually returns", () => {
    // `openai(id)` returns the responses model, whose `.provider` is "openai.responses".
    const call = priceModelCall(
      { provider: "openai.responses", modelId: "gpt-4o-mini" },
      { inputTokens: 10_000, outputTokens: 2_000 },
    );

    expect(call.costUsd).toBeCloseTo(0.0027, 12);
  });

  it.each(["openai.responses", "openai.chat", "openai.completion"])(
    "prices a call reported by %s identically to the bare provider",
    (provider) => {
      const bare = priceModelCall(
        { provider: "openai", modelId: "gpt-4o" },
        { inputTokens: 1_000_000, outputTokens: 500_000 },
      );
      const suffixed = priceModelCall(
        { provider, modelId: "gpt-4o" },
        { inputTokens: 1_000_000, outputTokens: 500_000 },
      );

      expect(suffixed.costUsd).toBe(bare.costUsd);
    },
  );

  it("prices deepseek.chat, this project's primary provider", () => {
    // deepseek/deepseek-v4-flash is listed at input (cache miss) $0.14 / output $0.28 per
    // 1M tokens.
    //   1,000,000 input  x $0.14 / 1M = $0.14
    //   1,000,000 output x $0.28 / 1M = $0.28
    //                           total = $0.42
    const call = priceModelCall(
      { provider: "deepseek.chat", modelId: "deepseek-v4-flash" },
      { inputTokens: 1_000_000, outputTokens: 1_000_000 },
    );

    expect(call.costUsd).toBeCloseTo(0.42, 10);
  });

  it("keeps a genuinely unknown model unpriced even when its provider carries a suffix", () => {
    expect(
      priceModelCall({ provider: "acme.chat", modelId: "nope" }, { inputTokens: 1, outputTokens: 1 })
        .costUsd,
    ).toBeNull();
  });

  it("still requires an exact model id — a known provider alone never prices a call", () => {
    expect(
      priceModelCall(
        { provider: "openai.responses", modelId: "gpt-9-imaginary" },
        { inputTokens: 1, outputTokens: 1 },
      ).costUsd,
    ).toBeNull();
  });

  it("tries the unstripped key first, so a dotted registry entry is reachable", () => {
    const dotted = {
      description: "dotted",
      capabilities: [],
      pricing: { input: 1, output: 1, currency: "USD" },
      contextWindow: 1,
      // Synthetic lookup-order fixture, not a real model: it is deliberately marked
      // unverified rather than carrying a fabricated pricingSource. It never reaches the
      // bundled registry, so the provenance suite does not see it.
      unverified: true,
    } as const;
    const bare = { ...dotted, description: "bare" } as const;

    // Both keys present: the exact match wins.
    expect(
      getModelInfoFor("foo.bar", "model", { "foo.bar/model": dotted, "foo/model": bare })
        ?.description,
    ).toBe("dotted");
    // Only the stripped key present: the fallback finds it.
    expect(getModelInfoFor("foo.bar", "model", { "foo/model": bare })?.description).toBe("bare");
    // Neither: still undefined, never a near-miss.
    expect(getModelInfoFor("foo.bar", "model", { "foo/other": bare })).toBeUndefined();
  });

  it("strips only the provider, never a model id that contains dots", () => {
    expect(modelRegistryKeys("openai.responses", "gpt-4.1")).toEqual([
      "openai.responses/gpt-4.1",
      "openai/gpt-4.1",
    ]);
  });

  it("strips one dot-segment at a time and never produces an empty provider", () => {
    expect(modelRegistryKeys("a.b.c", "m")).toEqual(["a.b.c/m", "a.b/m", "a/m"]);
    expect(modelRegistryKeys("openai", "m")).toEqual(["openai/m"]);
    expect(modelRegistryKeys(".leading", "m")).toEqual([".leading/m"]);
  });
});

describe("unknown models are never priced at $0", () => {
  it("returns a null cost for a model absent from the registry", () => {
    const call = priceModelCall(
      { provider: "acme", modelId: "not-a-real-model" },
      { inputTokens: 1_000, outputTokens: 1_000 },
    );

    expect(call.costUsd).toBeNull();
    expect(call.inputTokens).toBe(1_000);
  });

  it("returns a null cost when the event carries no model identity", () => {
    expect(priceModelCall({}, { inputTokens: 10, outputTokens: 10 }).costUsd).toBeNull();
  });

  it("keeps run totals null while every call is unpriced", () => {
    let totals = emptyUsageTotals();
    totals = addPricedCall(
      totals,
      priceModelCall({ provider: "acme", modelId: "nope" }, { inputTokens: 5, outputTokens: 5 }),
    );

    expect(totals.costUsd).toBeNull();
    expect(totals.pricedCalls).toBe(0);
    expect(totals.unpricedCalls).toBe(1);
  });

  it("distinguishes a genuine zero-call run from an unpriced one", () => {
    const noCalls = emptyUsageTotals();

    expect(noCalls.costUsd).toBe(0);
    expect(noCalls.unpricedCalls).toBe(0);
  });

  it("reports a partial total plus an unpriced count when calls are mixed", () => {
    let totals = emptyUsageTotals();
    totals = addPricedCall(
      totals,
      priceModelCall(
        { provider: "openai", modelId: "gpt-4o" },
        { inputTokens: 1_000_000, outputTokens: 0 },
      ),
    );
    totals = addPricedCall(
      totals,
      priceModelCall({ provider: "acme", modelId: "nope" }, { inputTokens: 5, outputTokens: 5 }),
    );

    expect(totals.costUsd).toBeCloseTo(2.5, 10);
    expect(totals.pricedCalls).toBe(1);
    expect(totals.unpricedCalls).toBe(1);
    expect(totals.inputTokens).toBe(1_000_005);
  });
});

describe("totals merge", () => {
  it("sums tokens and dollars across scopes", () => {
    const a = addPricedCall(
      emptyUsageTotals(),
      priceModelCall(
        { provider: "openai", modelId: "gpt-4o" },
        { inputTokens: 1_000_000, outputTokens: 0 },
      ),
    );
    const b = addPricedCall(
      emptyUsageTotals(),
      priceModelCall(
        { provider: "openai", modelId: "gpt-4o" },
        { inputTokens: 0, outputTokens: 500_000 },
      ),
    );

    const merged = mergeUsageTotals(a, b);

    expect(merged.costUsd).toBeCloseTo(7.5, 10);
    expect(merged.pricedCalls).toBe(2);
  });

  it("keeps a merged total null when neither scope could be priced", () => {
    const unpriced = addPricedCall(
      emptyUsageTotals(),
      priceModelCall({ provider: "acme", modelId: "nope" }, { inputTokens: 1, outputTokens: 1 }),
    );

    expect(mergeUsageTotals(unpriced, unpriced).costUsd).toBeNull();
  });
});
