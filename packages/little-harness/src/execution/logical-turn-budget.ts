import { wrapLanguageModel, type LanguageModel, type LanguageModelUsage, type PrepareStepFunction } from "ai";
import { HarnessInputError } from "../errors.js";
import { sha256Digest } from "../events/durability.js";
import type { HarnessOrchestrationServices } from "../types.js";
import { budgetUncertain } from "../local-host/turn-budget-ledger.js";
import { isKnownBudgetUsage } from "./turn-budget.js";
import type { HarnessTurnBudgetRef } from "./turn-budget.js";
import type { HarnessTurnLimits } from "./turn-limits.js";

export async function logicalTurnBudget(input: {
  readonly limits: HarnessTurnLimits | undefined;
  readonly services: HarnessOrchestrationServices | undefined;
  readonly sessionId: string;
  readonly runId: string;
  readonly resumed?: boolean;
  readonly budgetRef?: unknown;
  readonly priorEvents: readonly { readonly type: string }[];
  readonly signal?: AbortSignal;
  readonly beforeInvocation?: () => void | Promise<void>;
}) {
  const active = input.limits?.accounting === "logical-turn";
  if (!active && input.budgetRef === undefined) return undefined;
  if (!active) budgetUncertain("A resumed logical turn cannot downgrade its budget accounting mode.");
  const ledger = input.services?.turnBudgets;
  if (!ledger) budgetUncertain("Logical-turn limits require a host with turn-budget persistence.");
  const ref = input.budgetRef === undefined
    ? { version: "lh.turn-budget.v1", sessionId: input.sessionId, originRunId: input.runId } as const
    : input.budgetRef as HarnessTurnBudgetRef;
  if (!ref || ref.version !== "lh.turn-budget.v1" || ref.sessionId !== input.sessionId || typeof ref.originRunId !== "string") budgetUncertain("The saved logical-turn budget reference is malformed.");
  if (input.resumed && input.budgetRef === undefined) budgetUncertain("This legacy continuation has no provable logical-turn budget; no new allowance is granted.");
  const limits = input.limits!;
  await ledger.open(ref, { maxSteps: limits.maxSteps ?? null, maxCostUsd: limits.maxCostUsd ?? null }, {
    create: !input.resumed && !input.priorEvents.some(event => event.type === "harness.model.called" || event.type === "harness.model.responded"),
  });
  // Only the provider call's own rejection may be attested, and only by the host. An abort, an
  // error inside a stream that began, or a stream without usage never reaches the hook.
  const refuseIfAttested = async (error: unknown, occurrenceId: string, provider: { readonly provider: string; readonly modelId: string }) => {
    const attest = limits.refusedBeforeEffect;
    if (!attest || !ledger.refuse || input.signal?.aborted || isAbort(error)) return;
    let refused = false;
    try { refused = attest(error, { provider: provider.provider, modelId: provider.modelId }) === true; } catch { refused = false; }
    if (refused) await ledger.refuse(ref, { occurrenceId });
  };
  const wrapped = new WeakMap<object, LanguageModel>();
  const wrapModel = (model: LanguageModel): LanguageModel => {
    if (typeof model !== "object" || model === null || !("doGenerate" in model) || !("doStream" in model)) budgetUncertain("Logical-turn budgets require a concrete provider model handle, including prepareStep model overrides.");
    const cached = wrapped.get(model);
    if (cached) return cached;
    const metered = wrapLanguageModel({
      model: model as Parameters<typeof wrapLanguageModel>[0]["model"],
      middleware: {
        async wrapGenerate({ doGenerate, model: provider }) {
          await input.beforeInvocation?.();
          input.signal?.throwIfAborted();
          const occurrenceId = await ledger.reserve(ref, { runId: input.runId, model: `${provider.provider}/${provider.modelId}` });
          await input.beforeInvocation?.();
          input.signal?.throwIfAborted();
          let result: Awaited<ReturnType<typeof doGenerate>>;
          try { result = await doGenerate(); }
          catch (error) { await refuseIfAttested(error, occurrenceId, provider); throw error; }
          const usage = knownUsage(result.usage);
          const pricedModel = priceIdentity(result.response?.modelId, provider.modelId);
          const costUsd = price(limits, pricedModel, usage);
          await ledger.settle(ref, { occurrenceId, usage, costUsd, pricedModel, responseDigest: responseDigest({ usage, pricedModel, finishReason: result.finishReason, responseId: result.response?.id ?? null }) });
          return result;
        },
        async wrapStream({ doStream, model: provider }) {
          await input.beforeInvocation?.();
          input.signal?.throwIfAborted();
          const occurrenceId = await ledger.reserve(ref, { runId: input.runId, model: `${provider.provider}/${provider.modelId}` });
          await input.beforeInvocation?.();
          input.signal?.throwIfAborted();
          let result: Awaited<ReturnType<typeof doStream>>;
          try { result = await doStream(); }
          catch (error) { await refuseIfAttested(error, occurrenceId, provider); throw error; }
          let settled = false;
          let pricedModel = priceIdentity(undefined, provider.modelId);
          return { ...result, stream: result.stream.pipeThrough(new TransformStream({
            async transform(part, controller) {
              if (part.type === "response-metadata" && part.modelId !== undefined) pricedModel = priceIdentity(part.modelId, provider.modelId);
              if (part.type === "finish") {
                if (settled) budgetUncertain("The model stream produced more than one usage receipt.");
                const usage = knownUsage(part.usage);
                const costUsd = price(limits, pricedModel, usage);
                await ledger.settle(ref, { occurrenceId, usage, costUsd, pricedModel, responseDigest: responseDigest({ usage, pricedModel, finishReason: part.finishReason }) });
                settled = true;
              }
              controller.enqueue(part);
            },
            flush() {
              if (!settled) budgetUncertain("The model stream ended without known usage; its reservation stays held.");
            },
          })) };
        },
      },
    });
    wrapped.set(model, metered);
    wrapped.set(metered, metered);
    return metered;
  };
  return {
    ref,
    wrapModel,
    wrapPrepareStep(prepare: PrepareStepFunction<any> | undefined): PrepareStepFunction<any> {
      return async context => {
        const result = await prepare?.(context);
        return result?.model === undefined ? result : { ...result, model: wrapModel(result.model) };
      };
    },
  };
}

function priceIdentity(reported: unknown, configured: string): string {
  const identity = reported === undefined ? configured : reported;
  if (typeof identity !== "string" || identity.length === 0 || identity.length > 2048) budgetUncertain("The model response has no valid pricing identity; its reservation stays held.");
  return identity;
}

function price(limits: HarnessTurnLimits, model: string, usage: LanguageModelUsage): number {
  if (!limits.price) return 0; // A step-only budget makes no priced-cost claim.
  let cost: number;
  try { cost = limits.price({ model, usage }); } catch { budgetUncertain("The model response could not be priced; its reservation stays held."); }
  if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) budgetUncertain("The model response has unknown or invalid pricing; its reservation stays held.");
  return cost;
}

function knownUsage(raw: unknown): LanguageModelUsage {
  const usage = raw as { inputTokens?: { total?: number; noCache?: number; cacheRead?: number; cacheWrite?: number }; outputTokens?: { total?: number; text?: number; reasoning?: number } } | undefined;
  const input = usage?.inputTokens;
  const output = usage?.outputTokens;
  if (!input || !output || !validCount(input.total) || !validCount(output.total) ||
    [input.noCache, input.cacheRead, input.cacheWrite, output.text, output.reasoning].some(value => value !== undefined && !validCount(value))) budgetUncertain("The model response has missing or invalid token usage; its reservation stays held.");
  const normalized: LanguageModelUsage = {
    inputTokens: input.total,
    outputTokens: output.total,
    totalTokens: input.total! + output.total!,
    inputTokenDetails: { noCacheTokens: input.noCache, cacheReadTokens: input.cacheRead, cacheWriteTokens: input.cacheWrite },
    outputTokenDetails: { textTokens: output.text, reasoningTokens: output.reasoning },
  };
  if (!isKnownBudgetUsage(normalized)) budgetUncertain("The model response has inconsistent token usage; its reservation stays held.");
  return normalized;
}
/** Optional compatibility fields are absent in persisted JSON; hash the same representation. */
function responseDigest(value: unknown): string { return sha256Digest(JSON.parse(JSON.stringify(value))); }
function isAbort(error: unknown): boolean { return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"); }
function validCount(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }

/** Cancellation/required-record fences also apply without opting into persistent budgets. */
export function modelInvocationGuard(input: { readonly signal?: AbortSignal; readonly beforeInvocation?: () => void | Promise<void>; readonly requireConcrete?: boolean }) {
  const wrapped = new WeakMap<object, LanguageModel>();
  const guard = async () => { await input.beforeInvocation?.(); input.signal?.throwIfAborted(); };
  const wrapModel = (model: LanguageModel): LanguageModel => {
    // Preserve legacy alias/default-provider resolution. AI SDK owns alias cancellation.
    if (typeof model !== "object" || model === null || !("doGenerate" in model) || !("doStream" in model)) {
      if (input.requireConcrete) throw new HarnessInputError("beforeInvocation requires a concrete provider model handle, including prepareStep model overrides.");
      return model;
    }
    const cached = wrapped.get(model); if (cached) return cached;
    const guarded = wrapLanguageModel({ model: model as Parameters<typeof wrapLanguageModel>[0]["model"], middleware: {
      wrapGenerate: async ({ doGenerate }) => { await guard(); return doGenerate(); },
      wrapStream: async ({ doStream }) => { await guard(); return doStream(); },
    } });
    wrapped.set(model, guarded); wrapped.set(guarded, guarded); return guarded;
  };
  return {
    wrapModel,
    wrapPrepareStep(prepare: PrepareStepFunction<any> | undefined): PrepareStepFunction<any> {
      return async context => {
        const result = await prepare?.(context);
        await guard();
        return result?.model === undefined ? result : { ...result, model: wrapModel(result.model) };
      };
    },
  };
}
