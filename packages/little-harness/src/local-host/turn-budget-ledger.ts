import { join } from "node:path";
import { HarnessTurnLimitError } from "../execution/turn-limits.js";
import { isKnownBudgetUsage } from "../execution/turn-budget.js";
import type { HarnessTurnBudgetCaps, HarnessTurnBudgetLedger, HarnessTurnBudgetRef, HarnessTurnBudgetState } from "../execution/turn-budget.js";
import { canonicalJson } from "../events/durability.js";
import { recordKey, type DurableJsonStore } from "./durable-store.js";

const MAX_RECEIPTS = 10_000;
export function budgetUncertain(message: string): never {
  throw new HarnessTurnLimitError("BudgetStateUnavailable", message, { accounting: "logical-turn", budgetState: "uncertain" });
}
function validRef(ref: HarnessTurnBudgetRef): boolean {
  return ref?.version === "lh.turn-budget.v1" && [ref.sessionId, ref.originRunId].every(value => typeof value === "string" && value.length > 0 && value.length <= 1024);
}
function readState(value: unknown, ref: HarnessTurnBudgetRef): HarnessTurnBudgetState {
  const state = value as HarnessTurnBudgetState | undefined;
  if (!state || !validRef(state.ref) || canonicalJson(state.ref) !== canonicalJson(ref) || !state.caps ||
    !Number.isSafeInteger(state.steps) || state.steps < 0 || !Number.isFinite(state.costUsd) || state.costUsd < 0 ||
    !Array.isArray(state.receipts) || state.receipts.length !== state.steps || state.receipts.length > MAX_RECEIPTS ||
    !(state.caps.maxSteps === null || Number.isSafeInteger(state.caps.maxSteps) && state.caps.maxSteps > 0) ||
    !(state.caps.maxCostUsd === null || Number.isFinite(state.caps.maxCostUsd) && state.caps.maxCostUsd > 0)) budgetUncertain("The logical turn's saved budget is missing or malformed.");
  let cost = 0;
  for (const [index, receipt] of state.receipts.entries()) {
    if (!receipt || typeof receipt !== "object") budgetUncertain("The logical turn's occurrence ledger is malformed.");
    if (receipt.occurrenceId !== `${ref.originRunId}:model:${index + 1}` || typeof receipt.runId !== "string" || receipt.runId.length === 0 || receipt.runId.length > 1024 || typeof receipt.model !== "string" || receipt.model.length === 0 || receipt.model.length > 2048 ||
      !["reserved", "settled", "refused"].includes(receipt.state)) budgetUncertain("The logical turn's occurrence ledger is malformed.");
    if (receipt.state === "refused" && (receipt.refusal !== "host-attested" || ["usage", "costUsd", "responseDigest", "pricedModel"].some(key => key in receipt))) budgetUncertain("The logical turn's refused attempt is malformed.");
    if (receipt.state !== "refused" && "refusal" in receipt) budgetUncertain("The logical turn's occurrence ledger is malformed.");
    if (receipt.state === "settled") {
      if (typeof receipt.pricedModel !== "string" || receipt.pricedModel.length === 0 || receipt.pricedModel.length > 2048 || typeof receipt.costUsd !== "number" || !Number.isFinite(receipt.costUsd) || receipt.costUsd < 0 || typeof receipt.responseDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(receipt.responseDigest) || !isKnownBudgetUsage(receipt.usage)) budgetUncertain("The logical turn's settled usage is malformed.");
      cost += receipt.costUsd;
    }
  }
  if (Math.abs(cost - state.costUsd) > 1e-10) budgetUncertain("The logical turn's saved spend does not match its receipts.");
  return state;
}
export function createTurnBudgetLedger(store: DurableJsonStore, rootDir: string): HarnessTurnBudgetLedger {
  const path = (ref: HarnessTurnBudgetRef) => join(rootDir, "turn-budgets", `${recordKey(ref)}.json`);
  const locked = async <T>(ref: HarnessTurnBudgetRef, fn: (state: HarnessTurnBudgetState | undefined, write: (state: HarnessTurnBudgetState) => Promise<void>) => Promise<T>): Promise<T> => {
    if (!validRef(ref)) budgetUncertain("The logical turn has no valid budget identity.");
    const write = store.writeJsonDurable;
    if (!write) budgetUncertain("Logical-turn accounting needs a store with durable write acknowledgements.");
    return store.withLock({ kind: "logical-turn-budget", ref }, async () => {
      const anchorPath = join(rootDir, "turn-budget-origins", `${recordKey(ref)}.json`);
      let raw: unknown;
      let anchor: unknown;
      try { raw = await store.readJson<unknown>(path(ref)); anchor = await store.readJson<unknown>(anchorPath); }
      catch { budgetUncertain("The logical turn's persisted accounting could not be read."); }
      const state = raw === undefined ? undefined : readState(raw, ref);
      if (state === undefined && anchor !== undefined || state !== undefined && anchor === undefined) budgetUncertain("Required logical-turn accounting state is missing; no new allowance is granted.");
      if (state && canonicalJson(anchor) !== canonicalJson({ ref, caps: state.caps })) budgetUncertain("The logical turn's origin journal conflicts with its accounting state.");
      return fn(state, async value => {
        if (state === undefined) await write.call(store, anchorPath, { ref, caps: value.caps });
        await write.call(store, path(ref), value);
      });
    }).catch(error => {
      if (error instanceof HarnessTurnLimitError) throw error;
      budgetUncertain("Logical-turn accounting was not durably acknowledged; no fresh allowance is granted.");
    });
  };
  return {
    async open(ref, caps, options) {
      await locked(ref, async (state, write) => {
        if (state) {
          if (canonicalJson(caps) !== canonicalJson(state.caps)) budgetUncertain("A logical turn cannot change its saved budget limits.");
          return;
        }
        if (!options.create) budgetUncertain("The resumed logical turn has no saved budget; it receives no new allowance.");
        const fresh = { ref, caps, steps: 0, costUsd: 0, receipts: [] };
        readState(fresh, ref);
        await write(fresh);
      });
    },
    async reserve(ref, call) {
      return locked(ref, async (state, write) => {
        if (!state) budgetUncertain("The logical turn's budget disappeared before its model call.");
        // A reserved occurrence already consumes one step, even if its usage is unknown.
        // Count-only limits need no usage proof. A spend ceiling still requires it;
        // an HTTP status or a retryable error is never a zero-cost receipt.
        if (state.caps.maxCostUsd !== null && state.receipts.some(receipt => receipt.state === "reserved")) budgetUncertain("A model reservation has no known response usage; no fresh allowance is granted.");
        if (state.caps.maxCostUsd !== null && state.costUsd >= state.caps.maxCostUsd) throw new HarnessTurnLimitError("CostLimitExceeded", `The turn reached its cumulative cost limit of $${state.caps.maxCostUsd}.`, { costUsd: state.costUsd, steps: state.steps });
        if (state.caps.maxSteps !== null && state.steps >= state.caps.maxSteps) throw new HarnessTurnLimitError("StepLimitExceeded", `The turn reached its cumulative limit of ${state.caps.maxSteps} model calls.`, { steps: state.steps });
        if (state.steps >= MAX_RECEIPTS) budgetUncertain("The logical turn exhausted its occurrence ledger capacity.");
        if (!call.runId || call.runId.length > 1024 || !call.model || call.model.length > 2048) budgetUncertain("Invalid model occurrence identity.");
        const occurrenceId = `${ref.originRunId}:model:${state.steps + 1}`;
        await write({ ...state, steps: state.steps + 1, receipts: [...state.receipts, { occurrenceId, runId: call.runId, model: call.model, state: "reserved" }] });
        return occurrenceId;
      });
    },
    async settle(ref, response) {
      await locked(ref, async (state, write) => {
        if (!state) budgetUncertain("The logical turn's budget disappeared before response accounting.");
        if (typeof response.pricedModel !== "string" || response.pricedModel.length === 0 || response.pricedModel.length > 2048 || !Number.isFinite(response.costUsd) || response.costUsd < 0 || !/^sha256:[a-f0-9]{64}$/.test(response.responseDigest) || !isKnownBudgetUsage(response.usage)) budgetUncertain("The model response has no valid known price.");
        const index = state.receipts.findIndex(receipt => receipt.occurrenceId === response.occurrenceId);
        const receipt = state.receipts[index];
        if (!receipt) budgetUncertain("A response has no prior durable model reservation.");
        if (receipt.state === "refused") budgetUncertain("Conflicting response accounting for one model occurrence.");
        if (receipt.state === "settled") {
          if (receipt.pricedModel !== response.pricedModel || receipt.responseDigest !== response.responseDigest || receipt.costUsd !== response.costUsd || canonicalJson(receipt.usage) !== canonicalJson(JSON.parse(JSON.stringify(response.usage)))) budgetUncertain("Conflicting response accounting for one model occurrence.");
          return;
        }
        const receipts = [...state.receipts];
        receipts[index] = { ...receipt, ...response, state: "settled" };
        const updated = { ...state, costUsd: state.costUsd + response.costUsd, receipts };
        readState(updated, ref);
        await write(updated);
      });
    },
    async refuse(ref, refusal) {
      await locked(ref, async (state, write) => {
        if (!state) budgetUncertain("The logical turn's budget disappeared before refusal accounting.");
        const index = state.receipts.findIndex(receipt => receipt.occurrenceId === refusal.occurrenceId);
        const receipt = state.receipts[index];
        if (!receipt) budgetUncertain("A refusal has no prior durable model reservation.");
        if (receipt.state === "refused") return;
        if (receipt.state === "settled") budgetUncertain("Conflicting refusal for a model occurrence with known usage.");
        const receipts = [...state.receipts];
        receipts[index] = { occurrenceId: receipt.occurrenceId, runId: receipt.runId, model: receipt.model, state: "refused", refusal: "host-attested" };
        const updated = { ...state, receipts };
        readState(updated, ref);
        await write(updated);
      });
    },
    async inspect(ref) {
      return locked(ref, async state => { if (!state) budgetUncertain("The logical turn's budget is missing."); return state; });
    },
  };
}
