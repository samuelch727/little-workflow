import type { LanguageModelUsage } from "ai";

/** Trusted, opaque identity persisted with every continuation of one logical turn. */
export type HarnessTurnBudgetRef = {
  readonly version: "lh.turn-budget.v1";
  readonly sessionId: string;
  readonly originRunId: string;
};
export type HarnessTurnBudgetCaps = { readonly maxSteps: number | null; readonly maxCostUsd: number | null };
export type HarnessTurnBudgetReceipt = {
  readonly occurrenceId: string;
  readonly runId: string;
  readonly model: string;
  /**
   * A reservation is not proof that a provider was called or billed. `refused` is a reservation
   * the host attested had no effect (`turnLimits.refusedBeforeEffect`): no usage, no cost, one step.
   */
  readonly state: "reserved" | "settled" | "refused";
  /** Who said a refused attempt was free. Only the host can. */
  readonly refusal?: "host-attested";
  readonly usage?: LanguageModelUsage;
  readonly costUsd?: number;
  readonly responseDigest?: string;
  /** Response-reported model identity used by the trusted price callback. */
  readonly pricedModel?: string;
};
export type HarnessTurnBudgetState = {
  readonly ref: HarnessTurnBudgetRef;
  readonly caps: HarnessTurnBudgetCaps;
  readonly steps: number;
  /** Only known, settled response usage; never presents an uncertain reservation as spend. */
  readonly costUsd: number;
  readonly receipts: readonly HarnessTurnBudgetReceipt[];
};
export type HarnessTurnBudgetLedger = {
  open(ref: HarnessTurnBudgetRef, caps: HarnessTurnBudgetCaps, options: { readonly create: boolean }): Promise<void>;
  reserve(ref: HarnessTurnBudgetRef, call: { readonly runId: string; readonly model: string }): Promise<string>;
  settle(ref: HarnessTurnBudgetRef, response: { readonly occurrenceId: string; readonly usage: LanguageModelUsage; readonly costUsd: number; readonly responseDigest: string; readonly pricedModel: string }): Promise<void>;
  /**
   * Settles a held reservation as a host-attested refusal: no usage, no cost, still one step.
   * Optional; a ledger without it keeps every unknown attempt held.
   */
  refuse?(ref: HarnessTurnBudgetRef, refusal: { readonly occurrenceId: string }): Promise<void>;
  inspect(ref: HarnessTurnBudgetRef): Promise<HarnessTurnBudgetState>;
};

/** Known normalized usage, including coherent totals; missing provider totals are not free calls. */
export function isKnownBudgetUsage(value: unknown): value is LanguageModelUsage {
  const usage = value as LanguageModelUsage | undefined;
  const count = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
  if (!usage || !count(usage.inputTokens) || !count(usage.outputTokens) || !count(usage.totalTokens) || usage.totalTokens !== usage.inputTokens + usage.outputTokens ||
    !usage.inputTokenDetails || !usage.outputTokenDetails) return false;
  const input = [usage.inputTokenDetails.noCacheTokens, usage.inputTokenDetails.cacheReadTokens, usage.inputTokenDetails.cacheWriteTokens];
  const output = [usage.outputTokenDetails.textTokens, usage.outputTokenDetails.reasoningTokens];
  if ([...input, ...output].some(n => n !== undefined && !count(n))) return false;
  return input.reduce<number>((sum, n) => sum + (n ?? 0), 0) <= usage.inputTokens && output.reduce<number>((sum, n) => sum + (n ?? 0), 0) <= usage.outputTokens;
}
