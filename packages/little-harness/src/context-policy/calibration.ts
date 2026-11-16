import { stableHash } from "../utils/canonical-hash.js";
import { createEventId } from "../ids.js";
import type { ContextCompactionRuntime, ContextInputUsage } from "./types.js";

export function contextRequestBytes(request: { system?: unknown; tools?: unknown; messages: readonly unknown[] }): number {
  return new TextEncoder().encode(JSON.stringify({ system: request.system ?? null, tools: request.tools ?? null, messages: request.messages })).length;
}
export function validContextInputUsage(value: unknown): value is ContextInputUsage {
  const v = value as ContextInputUsage | undefined;
  return !!v && v.version === 1 && [v.sessionId, v.modelId, v.providerId, v.requestId, v.requestHash].every(x => typeof x === "string" && x.length > 0 && x.length <= 500)
    && Number.isSafeInteger(v.requestBytes) && v.requestBytes > 0 && Number.isSafeInteger(v.inputTokens) && v.inputTokens > 0;
}
export function contextInputRequest(runtime: ContextCompactionRuntime, sessionId: string, request: { system?: unknown; tools?: unknown; messages: readonly unknown[] }): Omit<ContextInputUsage, "inputTokens"> {
  return { version: 1, sessionId, modelId: runtime.model.modelId, providerId: runtime.model.providerId, requestId: createEventId(),
    requestHash: stableHash({ system: request.system ?? null, tools: request.tools ?? null, messages: request.messages }), requestBytes: contextRequestBytes(request) };
}
export async function recordContextInputUsage(runtime: ContextCompactionRuntime, request: Omit<ContextInputUsage, "inputTokens">, result: unknown, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted || !runtime.store.recordInputUsage) return;
  const value = result as { estimated?: boolean; usage?: { estimated?: boolean; inputTokens?: number | { total?: number } } } | undefined;
  const input = value?.usage?.inputTokens;
  if (value?.estimated || value?.usage?.estimated) return;
  const sample = { ...request, inputTokens: typeof input === "number" ? input : input?.total };
  if (!validContextInputUsage(sample)) return;
  // Calibration is advisory. Storage failure must retain conservative cold-start behavior,
  // not turn a completed model response into another invocation or a failed conversation.
  try { await runtime.store.recordInputUsage(sample); } catch { /* Cold-start fallback. */ }
}
export async function contextCalibration(runtime: ContextCompactionRuntime, sessionId: string): Promise<ContextInputUsage | undefined> {
  try {
    const sample = await runtime.store.lastInputUsage?.(sessionId);
    return validContextInputUsage(sample) && sample.sessionId === sessionId && sample.modelId === runtime.model.modelId && sample.providerId === runtime.model.providerId
      && sample.modelId !== "unknown" && sample.providerId !== "unknown" ? sample : undefined;
  } catch { return undefined; }
}
