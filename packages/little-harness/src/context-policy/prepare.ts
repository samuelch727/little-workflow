import type { ModelMessage, PrepareStepFunction } from "ai";
import type { ContextCompactionHost, ContextCompactionRuntime, ContextInputUsage, ContextPolicy } from "./types.js";
import { compactContext, ContextBudgetExceeded, inMemoryContextCheckpointStore } from "./policy.js";
import { validContextInputUsage } from "./calibration.js";

const ephemeralUsage = new WeakMap<object, Map<string, ContextInputUsage>>();

export async function resolveContextRuntime(input: {
  host?: ContextCompactionHost;
  sessionId: string;
  runId: string;
  model: unknown;
  maxOutputTokens?: number;
  fallbackScope?: object;
}): Promise<ContextCompactionRuntime> {
  const handle = input.model as { provider?: string; modelId?: string };
  const modelId = typeof input.model === "string" ? input.model : handle.modelId ?? "unknown";
  const providerId = handle.provider ?? "unknown";
  if (input.host) {
    const resolved = await input.host.forSession({ sessionId: input.sessionId, runId: input.runId, modelId, providerId, ...(input.maxOutputTokens === undefined ? {} : { maxOutputTokens: input.maxOutputTokens }) });
    const runtime = { ...resolved, model: { ...resolved.model, ...(input.maxOutputTokens === undefined ? {} : { maxOutputTokens: input.maxOutputTokens }) } };
    if (!runtime.summarize) return { ...runtime, runId: input.runId };
    let attempted = false;
    return { ...runtime, runId: input.runId, summarize: async request => {
      if (attempted) throw new Error("summary_attempt_limit_per_turn");
      attempted = true;
      return runtime.summarize!(request);
    } };
  }
  const store = inMemoryContextCheckpointStore();
  if (input.fallbackScope) {
    let sessions = ephemeralUsage.get(input.fallbackScope);
    if (!sessions) { sessions = new Map(); ephemeralUsage.set(input.fallbackScope, sessions); }
    const usage = sessions;
    // Across calls retain only bounded calibration metadata, not ephemeral checkpoints.
    store.lastInputUsage = async sessionId => {
      const sample = sessionId === input.sessionId ? usage.get(sessionId) : undefined;
      return sample ? structuredClone(sample) : undefined;
    };
    store.recordInputUsage = async sample => {
      if (!validContextInputUsage(sample) || sample.sessionId !== input.sessionId) return;
      usage.delete(input.sessionId); usage.set(input.sessionId, structuredClone(sample));
      if (usage.size > 128) usage.delete(usage.keys().next().value!);
    };
  }
  return { store, model: { modelId, providerId, maxOutputTokens: input.maxOutputTokens ?? 0 } };
}
/** App hook + runtime hints + inbox first, context projection second, invocation guard last.
 * A hook may not switch the model underneath an admitted window/pricing contract.
 */
export function contextPrepareStep(input: {
  prepareStep: PrepareStepFunction<any>;
  policy?: false | ContextPolicy | undefined;
  runtime: ContextCompactionRuntime;
  sessionId: string;
  system?: unknown;
  tools?: unknown;
  signal?: AbortSignal;
  onPrepared?: (stepNumber: number, request: { system?: unknown; tools?: unknown; messages: readonly ModelMessage[] }) => void;
}): PrepareStepFunction<any> {
  if (!input.policy) return input.prepareStep;
  return async event => {
    const result = await input.prepareStep(event);
    const change = result as { model?: { modelId?: string; provider?: string }; messages?: ModelMessage[]; system?: unknown } | undefined;
    if (change?.model && (change.model.modelId !== input.runtime.model.modelId || change.model.provider !== input.runtime.model.providerId)) throw new ContextBudgetExceeded("model_changed_after_admission", 0, 0);
    const messages = await compactContext({
      policy: input.policy,
      runtime: input.runtime,
      sessionId: input.sessionId,
      messages: change?.messages ?? event.messages,
      system: change?.system ?? input.system,
      tools: input.tools,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    input.onPrepared?.(event.stepNumber, { messages, system: change?.system ?? input.system, tools: input.tools });
    return { ...result, messages: [...messages] };
  };
}
