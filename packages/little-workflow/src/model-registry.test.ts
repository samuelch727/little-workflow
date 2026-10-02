import { describe, expect, it } from "vitest";
import { modelRegistry, type ModelInfo } from "./model-registry.js";

/**
 * Provenance and staleness enforcement for `model-registry.json`.
 *
 * Why this suite exists: these rates are the arithmetic behind every dollar the product
 * reports. A wrong frontier price does not merely skew a number — it *inverts* the
 * demotion argument, because the whole claim is "the cheap model is n× cheaper than the
 * frontier one". Overstating a frontier price manufactures savings that do not exist.
 * That failure had already happened twice before this suite was written: `openai/gpt-5`
 * was listed at $20/$80 against an official $1.25/$10 (16× and 8× over), and
 * `anthropic/claude-opus-4-7` at $15/$75 against an official $5/$25 (3× over).
 *
 * The prices were correct when someone last looked. Nothing made anyone look again.
 */

/** Registry entries drift silently, so re-verification is forced on a fixed cadence. */
const MAX_PRICING_AGE_DAYS = 90;

const REGISTRY_PATH = "packages/little-workflow/src/model-registry.json";

/**
 * Entries whose rates could **not** be sourced from an official provider pricing page.
 *
 * This list is asserted to match the registry *exactly*, in both directions. That is the
 * point of hard-coding it: without the exactness check, `unverified: true` would be a
 * self-service exemption and every future unsourced rate could quietly opt out of the
 * staleness deadline. Adding an id here is a deliberate, reviewable act.
 *
 * Removing an id (by sourcing the rate) or removing the entry are both improvements.
 * Adding one should be a last resort — an absent model prices as `costUsd: null`, which
 * reports honestly as unknown, whereas an unverified rate reports a confident number
 * that nothing stands behind.
 */
const UNVERIFIED_MODEL_IDS: readonly string[] = [
  // Open weights, no single canonical vendor price — the rate depends on the host.
  "meta/llama-4-maverick",
  // Alibaba Model Studio publishes no per-1M USD rate reachable from the public docs.
  "qwen/qwen3-coder",
  // Cohere's pricing page lists Command R/R+ but no Command A rate. (The $2.50/$10 here
  // is exactly Command R+'s published price, which suggests copied provenance.)
  "cohere/command-a",
  // Azure's public rate card renders "$-" placeholders and is deployment/region
  // dependent; only the global-standard *input* rate could be corroborated.
  "azure/gpt-4o",
];

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

type Entry = readonly [id: string, info: ModelInfo];

const entries: readonly Entry[] = Object.entries(modelRegistry);

function parseIsoDateUtc(value: string): number | undefined {
  if (!ISO_DATE.test(value)) {
    return undefined;
  }
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function ageInDays(verifiedAtMs: number, nowMs: number): number {
  return Math.floor((nowMs - verifiedAtMs) / 86_400_000);
}

/** Fails once with every offender listed — re-verification should be one pass, not N. */
function expectNoProblems(problems: readonly string[], remedy: string): void {
  if (problems.length === 0) {
    return;
  }
  throw new Error(
    `${problems.length} model-registry problem(s) in ${REGISTRY_PATH}:\n` +
      problems.map((problem) => `  - ${problem}`).join("\n") +
      `\n\n${remedy}`,
  );
}

describe("model registry provenance", () => {
  it("is non-empty, so an empty file can never vacuously satisfy this suite", () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  it("records an official pricing source and a verification date on every priced entry", () => {
    const problems: string[] = [];
    for (const [id, info] of entries) {
      if (info.unverified === true) {
        if (info.pricingSource !== undefined) {
          problems.push(`${id}: marked unverified but also carries a pricingSource`);
        }
        if (info.pricingVerifiedAt !== undefined) {
          problems.push(`${id}: marked unverified but also carries a pricingVerifiedAt`);
        }
        continue;
      }
      if (typeof info.pricingSource !== "string" || info.pricingSource.length === 0) {
        problems.push(`${id}: missing "pricingSource" (and not marked "unverified": true)`);
      } else if (!info.pricingSource.startsWith("https://")) {
        problems.push(`${id}: pricingSource is not an https URL: ${info.pricingSource}`);
      }
      if (typeof info.pricingVerifiedAt !== "string") {
        problems.push(`${id}: missing "pricingVerifiedAt" (and not marked "unverified": true)`);
      } else if (parseIsoDateUtc(info.pricingVerifiedAt) === undefined) {
        problems.push(
          `${id}: pricingVerifiedAt is not a YYYY-MM-DD calendar date: ${info.pricingVerifiedAt}`,
        );
      }
    }

    expectNoProblems(
      problems,
      `Every entry must either cite the provider's official pricing page\n` +
        `("pricingSource" + "pricingVerifiedAt") or openly declare "unverified": true\n` +
        `and be listed in UNVERIFIED_MODEL_IDS in this file. An unsourced number that\n` +
        `looks sourced is the defect this check exists to prevent.`,
    );
  });

  it("never dates a verification in the future", () => {
    const nowMs = Date.now();
    const problems: string[] = [];
    for (const [id, info] of entries) {
      const verifiedAt = info.pricingVerifiedAt;
      if (verifiedAt === undefined) {
        continue;
      }
      const verifiedAtMs = parseIsoDateUtc(verifiedAt);
      if (verifiedAtMs !== undefined && verifiedAtMs > nowMs + 86_400_000) {
        problems.push(`${id}: pricingVerifiedAt ${verifiedAt} is in the future`);
      }
    }
    expectNoProblems(
      problems,
      `A future date buys the entry extra time without anyone having checked it.`,
    );
  });

  it("keeps the unverified set exactly equal to the reviewed allowlist", () => {
    const actual = entries.filter(([, info]) => info.unverified === true).map(([id]) => id).sort();
    // Exact equality in both directions on purpose: a new unsourced entry must fail here
    // rather than silently inherit the staleness exemption.
    expect(actual).toEqual([...UNVERIFIED_MODEL_IDS].sort());
  });

  it("states rates that are internally coherent", () => {
    const problems: string[] = [];
    for (const [id, { pricing }] of entries) {
      for (const field of ["input", "output"] as const) {
        const rate = pricing[field];
        if (!Number.isFinite(rate) || rate <= 0) {
          problems.push(`${id}: pricing.${field} must be a positive finite number, got ${rate}`);
        }
      }
      if (pricing.cachedInput !== undefined) {
        if (!Number.isFinite(pricing.cachedInput) || pricing.cachedInput < 0) {
          problems.push(
            `${id}: pricing.cachedInput must be a non-negative finite number, got ${pricing.cachedInput}`,
          );
        } else if (pricing.cachedInput > pricing.input) {
          problems.push(
            `${id}: pricing.cachedInput (${pricing.cachedInput}) exceeds pricing.input ` +
              `(${pricing.input}) — a cache hit is never dearer than a cache miss, so one of ` +
              `the two rates is wrong or they are swapped`,
          );
        }
      }
      if (pricing.currency !== "USD") {
        problems.push(`${id}: pricing.currency must be "USD", got ${String(pricing.currency)}`);
      }
    }
    expectNoProblems(problems, `Re-read the provider's pricing page for the entries above.`);
  });
});

describe("model registry staleness", () => {
  /**
   * The durable half of the fix. Correcting today's rates is worth little on its own:
   * this issue recurs precisely because nothing forces a second look.
   *
   * Why 90 days: both defects this suite was written for drifted by an order of
   * magnitude well inside a single quarter, and at least one listed provider (DeepSeek)
   * publicly announces "a significant increase expected" without dating it. A quarter is
   * short enough that a wrong rate cannot survive a full reporting period, and long
   * enough that re-verification is a few minutes, four times a year.
   *
   * **This test failing on an unrelated PR is the mechanism working, not a flake.** Do
   * not extend the window or skip the test to get green. Open each `pricingSource` URL,
   * confirm or correct the rates, and bump `pricingVerifiedAt` — the failure message
   * names every entry and its URL so the whole sweep is one pass.
   */
  it(`re-verifies every sourced entry at least every ${MAX_PRICING_AGE_DAYS} days`, () => {
    const nowMs = Date.now();
    const stale: string[] = [];

    for (const [id, info] of entries) {
      if (info.unverified === true) {
        continue;
      }
      const verifiedAt = info.pricingVerifiedAt;
      if (typeof verifiedAt !== "string") {
        // Shape is reported by the provenance suite above; nothing to age here.
        continue;
      }
      const verifiedAtMs = parseIsoDateUtc(verifiedAt);
      if (verifiedAtMs === undefined) {
        continue;
      }
      const age = ageInDays(verifiedAtMs, nowMs);
      if (age > MAX_PRICING_AGE_DAYS) {
        stale.push(
          `${id} — last verified ${verifiedAt} (${age} days ago, limit ${MAX_PRICING_AGE_DAYS}); ` +
            `re-read ${info.pricingSource ?? "(no source recorded)"}`,
        );
      }
    }

    expectNoProblems(
      stale,
      `These rates are the arithmetic behind every USD figure the product reports, so a\n` +
        `stale one does not just skew a number — it inverts the "model X is n× cheaper\n` +
        `than model Y" argument built on top of it.\n\n` +
        `To fix, for each entry listed above:\n` +
        `  1. Open its pricingSource URL and read the current input / output / cache-read\n` +
        `     rates (per 1M tokens, USD).\n` +
        `  2. Correct "pricing" in ${REGISTRY_PATH} if the provider changed them, and\n` +
        `     update any test that hand-computes dollars from that entry's rates.\n` +
        `  3. If the model has been delisted, delete the entry — anything referencing it\n` +
        `     then prices as costUsd: null plus an unpricedCalls increment, which reports\n` +
        `     honestly as unknown instead of silently mispricing.\n` +
        `  4. Set "pricingVerifiedAt" to today (YYYY-MM-DD) — only after actually looking.\n\n` +
        `Do not raise MAX_PRICING_AGE_DAYS (in ${"packages/little-workflow/src/model-registry.test.ts"})\n` +
        `to make this pass. The deadline is the feature.`,
    );
  });
});
