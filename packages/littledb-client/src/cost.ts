import { priceModelCall, type ModelCallIdentity, type ModelCallUsage } from "little-workflow";

/**
 * Pricing for the littleDB **export materialization**.
 *
 * ─── The boundary this file sits on ─────────────────────────────────────────────
 *
 * little-workflow's durable log is deliberately token-only. `assertUsage`
 * (`little-workflow/src/harness/event-recorder.ts`) *rejects* a `costUsd` key on any
 * recorded usage payload, and `little-harness` never emits one
 * (`workflow-harness/session-events.ts`). That invariant is about the **receipt of
 * record**: events carry what was measured (tokens, model identity) and dollars are
 * derived exactly once, downstream, from the registry rates
 * (`little-workflow/src/pricing.ts` → `priceModelCall`).
 *
 * This module is *downstream*. It is the same class of consumer as
 * `little-workflow/src/run-report.ts`: it prices recorded tokens for an external system.
 * Stamping `costUsd` on the JSON body POSTed to littleDB therefore does **not** violate
 * the invariant — nothing here is written back into a harness event or into the durable
 * log. Two rules keep it that way, and both are pinned by tests:
 *
 *  1. **Never mutate the input.** The usage object handed in is the live object owned by
 *     the harness event / durable envelope, shared with every other sink. Enrichment
 *     always produces a *new* object; the original is returned untouched when there is
 *     nothing to add.
 *  2. **Never invent a number.** A model the registry cannot price yields no `costUsd`
 *     key at all — not a `0`. littleDB's engine treats an absent `cost_usd` as `0.0` when
 *     it sums a run (`crates/engine/src/query.rs`: `SUM(COALESCE(e.cost_usd, 0.0))`), but
 *     that is *its* choice about unknown data. Fabricating the zero here would turn
 *     "unpriced" into an affirmative claim of free.
 *
 * littleDB's figure is metrics-grade — a fast per-event number for cost-delta gates.
 * little-workflow's own materialization stays the receipt of record.
 */

/**
 * The engine reads a model call's dollars from the usage object it is given
 * (`crates/engine/src/ingest.rs`, `harness.model.responded` arm:
 * `payload.response.usage.costUsd`, falling back to `payload.usage.costUsd` then
 * `payload.costUsd`). Only ever stamp the primary path: `cost_usd` is summed **per
 * event** across a run, so a second copy anywhere in the same payload — or a
 * session-level rollup event — would double-count.
 *
 * @param modelValue the recorded model identity, expected to be
 *   `{ provider, modelId }` (`deepseek.chat` / `deepseek-v4-flash`); the provider's
 *   AI-SDK sub-model suffix is normalized by the registry lookup, not here.
 * @param usageValue the recorded token counts, token-only as the durable log requires.
 * @returns a **copy** of `usageValue` with `costUsd` added when the model is priceable;
 *   otherwise `usageValue` itself, unchanged and unpriced.
 */
export function usageWithCostUsd(modelValue: unknown, usageValue: unknown): unknown {
  if (!isRecord(usageValue)) {
    return usageValue;
  }
  const model = isRecord(modelValue) ? modelValue : undefined;
  const { costUsd } = priceModelCall(
    identityOf(model),
    {
      ...optionalNumber("inputTokens", usageValue.inputTokens),
      ...optionalNumber("outputTokens", usageValue.outputTokens),
      // Harness traces store the AI SDK usage verbatim: v6 recorded the flat fields, v7 only the details.
      ...optionalNumber("cachedInputTokens", usageValue.cachedInputTokens ?? usageDetail(usageValue.inputTokenDetails, "cacheReadTokens")),
      ...optionalNumber("reasoningTokens", usageValue.reasoningTokens ?? usageDetail(usageValue.outputTokenDetails, "reasoningTokens")),
    } satisfies ModelCallUsage,
  );
  if (costUsd === null) {
    return usageValue;
  }
  return { ...usageValue, costUsd };
}

function identityOf(model: Record<string, unknown> | undefined): ModelCallIdentity {
  return {
    ...optionalString("provider", model?.provider),
    ...optionalString("modelId", model?.modelId),
  };
}

/**
 * Present-or-absent, never `undefined`-valued: the package compiles with
 * `exactOptionalPropertyTypes`, and an explicit `undefined` is not the same as an
 * omitted field there.
 */
function optionalString<K extends string>(key: K, value: unknown): { [P in K]?: string } {
  return typeof value === "string" ? ({ [key]: value } as { [P in K]?: string }) : {};
}

function optionalNumber<K extends string>(key: K, value: unknown): { [P in K]?: number } {
  return typeof value === "number" && Number.isFinite(value)
    ? ({ [key]: value } as { [P in K]?: number })
    : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function usageDetail(details: unknown, key: string): unknown {
  return isRecord(details) ? details[key] : undefined;
}
