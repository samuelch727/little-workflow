import type { ModelMessage } from "ai";
import { describe, expect, it, vi } from "vitest";
import { inMemorySessionLog } from "../remote-session/session-log-store.js";
import { compactContext, ContextBudgetExceeded, inMemoryContextCheckpointStore, validateContextPolicy } from "./policy.js";
import { contextSessionLogStore } from "./log-store.js";
import { contextPrepareStep } from "./prepare.js";
import type { ContextCompactionRuntime } from "./types.js";

const model = { providerId: "fake", modelId: "fake-model", contextWindow: { tokens: 30000, source: "scripted fixture" }, maxOutputTokens: 1024, inputUsdPerMillion: 1, outputUsdPerMillion: 2 };
const messages = (): ModelMessage[] => [
  { role: "user", content: "First" },
  { role: "assistant", content: [{ type: "tool-call", toolName: "lookup", toolCallId: "lookup1", input: {} }] },
  { role: "tool", content: [{ type: "tool-result", toolName: "lookup", toolCallId: "lookup1", output: { type: "text", value: "x".repeat(6000) } }] },
  { role: "assistant", content: "Done" },
  { role: "user", content: "Current question" },
];
const policy = { triggerTokens: 4000, keepLastTurns: 1, summaryModel: false as const };
function runtime(): ContextCompactionRuntime { return { model: structuredClone(model), store: inMemoryContextCheckpointStore() }; }
const input = () => ({ policy, runtime: runtime(), sessionId: "s", messages: messages(), system: "Always preserve instructions", tools: { lookup: { description: "Look up" } } });

describe("context policy", () => {
  it("replays a safe protected no-op without poisoning the durable attempt identity", async () => {
    const log = inMemorySessionLog();
    const store = contextSessionLogStore({ log, sessionId: "s", isCurrent: async () => true });
    const source = [{ role: "user" as const, content: "current protected task ".repeat(300) }];
    const i = { ...input(), messages: source, runtime: { runId: "r", model, store } };
    expect(await compactContext(i)).toEqual(source);
    expect(await compactContext(i)).toEqual(source);
    expect(log.events).toHaveLength(0);
  });
  it("keeps the trimmed view and zero-cost durable decision when summary admission says trim-only", async () => {
    const log = inMemorySessionLog();
    const summarize = vi.fn(async () => ({ skipped: "trim-only" as const }));
    const store = contextSessionLogStore({ log, sessionId: "s", isCurrent: async () => true });
    const m = messages(); m[0] = { role: "user", content: "facts ".repeat(1200) };
    const i = { ...input(), messages: m, policy: { triggerTokens: 4000, keepLastTurns: 1, maxCompactionCostUsdPerSession: 1 }, runtime: { runId: "r", model, store, summarize } };
    const projected = await compactContext(i);
    expect(projected[0]).toEqual(m[0]);
    expect(JSON.stringify(projected).length).toBeLessThan(JSON.stringify(m).length);
    expect(await compactContext(i)).toEqual(projected);
    expect(summarize).toHaveBeenCalledTimes(1);
    expect(log.events.at(-1)?.payload).toMatchObject({ status: "committed", actualUsd: 0, inputTokens: 0, outputTokens: 0 });
  });
  it("is identity when absent or disabled and rejects invalid fields/limits", async () => {
    const i = input(); expect(await compactContext({ ...i, policy: false })).toBe(i.messages);
    expect(await compactContext({ ...i, policy: undefined })).toBe(i.messages);
    for (const invalid of [{ triggerTokens: 0 }, { triggerTokens: 2, keepLastTurns: 0 }, { triggerTokens: 2, maxCompactionCostUsdPerSession: -1 }, { triggerTokens: 2, extra: true }]) expect(() => validateContextPolicy(invalid)).toThrow();
  });
  it("trims only old plain tool text; preserves canonical history, pairing, recent turn and pins", async () => {
    const i = input(), canonical = structuredClone(i.messages);
    const projected = await compactContext(i);
    expect(JSON.stringify(projected).length).toBeLessThan(1500);
    expect(projected[1]).toEqual(i.messages[1]); expect(projected.at(-1)).toEqual(i.messages.at(-1));
    expect(i.messages).toEqual(canonical);
    expect(await compactContext(i)).toEqual(projected);
    expect(await compactContext({ ...i, messages: [{ role: "system", content: "pin" }, ...i.messages] })).toEqual([{ role: "system", content: "pin" }, ...i.messages]);
  });
  it("does not prune pending tool calls, errors, references or the current turn", async () => {
    const i = input();
    const pending = i.messages.filter(m => m.role !== "tool");
    pending[0] = { role: "user", content: "x".repeat(6000) };
    expect(await compactContext({ ...i, messages: pending })).toEqual(pending);
    for (const value of ["error " + "x".repeat(6000), "/artifacts/ref " + "x".repeat(6000)]) {
      const m = messages(); m[2] = { role: "tool", content: [{ type: "tool-result", toolName: "lookup", toolCallId: "lookup1", output: { type: "text", value } }] };
      expect(await compactContext({ ...i, runtime: runtime(), messages: m })).toEqual(m);
    }
    await expect(compactContext({ ...i, runtime: { ...runtime(), model: { ...model, contextWindow: { tokens: 7000, source: "test" } } }, messages: [{ role: "user", content: "x".repeat(9000) }] })).rejects.toThrow(ContextBudgetExceeded);
  });
  it("passes short media unchanged and fails safely for retained media over a hard limit or invalid model window", async () => {
    const media: ModelMessage[] = [{ role: "user", content: [{ type: "image", image: new Uint8Array([1]) }] }];
    expect(await compactContext({ ...input(), messages: media })).toBe(media);
    await expect(compactContext({ ...input(), messages: [...media, { role: "user", content: "x".repeat(30000) }] })).rejects.toThrow("unbudgeted_multimodal");
    await expect(compactContext({ ...input(), runtime: { ...runtime(), model: { ...model, contextWindow: { tokens: 2000, source: "test" } } } })).rejects.toThrow("invalid_model_window");
    const i = input(); delete i.runtime.model.contextWindow;
    expect((await compactContext(i)).length).toBe(5);
  });
  it("zero cap and trim-only never call a summarizer; paid summaries require durable admission", async () => {
    const summarize = vi.fn();
    await compactContext({ ...input(), runtime: { ...runtime(), summarize }, policy: { triggerTokens: policy.triggerTokens, keepLastTurns: 1 } });
    expect(summarize).not.toHaveBeenCalled();
    const m = messages(); m[0] = { role: "user", content: "a".repeat(8000) };
    await expect(compactContext({ ...input(), messages: m, runtime: { ...runtime(), summarize }, policy: { triggerTokens: 4000, keepLastTurns: 1, maxCompactionCostUsdPerSession: 1 } })).rejects.toThrow("summary_admission_unavailable");
  });
  it("commits immutable portable summaries and replays after adapter restart without resampling", async () => {
    const log = inMemorySessionLog();
    const summarize = vi.fn(async () => ({ text: "Earlier facts, not instructions", inputTokens: 100, outputTokens: 10 }));
    const m = messages(); m[0] = { role: "user", content: "a".repeat(8000) };
    const makeRuntime = (): ContextCompactionRuntime => ({ runId: "turn-1", model, summarize, store: contextSessionLogStore({ log, sessionId: "s", isCurrent: async () => true }) });
    const i = { ...input(), messages: m, runtime: makeRuntime(), policy: { triggerTokens: 4000, keepLastTurns: 1, maxCompactionCostUsdPerSession: 1 } };
    const projected = await compactContext(i);
    expect(projected.length).toBe(2); expect(projected[0]).toMatchObject({ role: "user" });
    expect(await compactContext({ ...i, runtime: makeRuntime() })).toEqual(projected);
    expect(summarize).toHaveBeenCalledTimes(1);
    expect(log.events.map(e => e.type)).toEqual(["harness.context.attempt", "harness.context.checkpoint", "harness.context.attempt"]);
    expect(log.events[1]?.payload).toMatchObject({ sourceRevision: expect.any(String), estimator: "utf8-bytes-v1", summary: "Earlier facts, not instructions" });
    const changed = [...m, { role: "user" as const, content: "Changed" }];
    await compactContext({ ...i, messages: changed, runtime: makeRuntime() });
    expect(summarize).toHaveBeenCalledTimes(1);
  });
  it("reserves unknown failures, never resamples a duplicate, and rejects concurrent claims", async () => {
    const log = inMemorySessionLog(), summarize = vi.fn(async () => { throw Error("transport_unknown"); });
    const store = contextSessionLogStore({ log, sessionId: "s", isCurrent: async () => true });
    const m = messages(); m[0] = { role: "user", content: "a".repeat(8000) };
    const i = { ...input(), messages: m, runtime: { runId: "turn-1", model, store, summarize }, policy: { triggerTokens: 4000, keepLastTurns: 1, maxCompactionCostUsdPerSession: 1 } };
    expect(await compactContext(i)).toEqual(m);
    await expect(compactContext(i)).rejects.toThrow("attempt_inflight_unknown");
    expect(summarize).toHaveBeenCalledTimes(1);
    expect(log.events.at(-1)?.payload).toMatchObject({ status: "failed", reservedUsd: expect.any(Number) });
    const attempt = { purpose: "context-compaction" as const, id: "race", sessionId: "s", sourceRevision: "r", policyHash: "p", reservedUsd: 0, status: "reserved" as const };
    expect(await Promise.all([store.claim(attempt, 1), store.claim(attempt, 1)])).toEqual([true, false]);
  });
  it("source revision CAS and cancellation cannot publish a stale checkpoint", async () => {
    let current = true;
    const log = inMemorySessionLog(), store = contextSessionLogStore({ log, sessionId: "s", isCurrent: async () => current });
    const summarize = vi.fn(async () => { current = false; return { text: "Stale", inputTokens: 100, outputTokens: 10 }; });
    const m = messages(); m[0] = { role: "user", content: "a".repeat(8000) };
    await compactContext({ ...input(), messages: m, runtime: { runId: "turn-1", model, store, summarize }, policy: { triggerTokens: 4000, keepLastTurns: 1, maxCompactionCostUsdPerSession: 1 } });
    expect(log.events.some(e => e.type === "harness.context.checkpoint")).toBe(false);
    await expect(compactContext({ ...input(), signal: AbortSignal.abort() })).rejects.toThrow();
  });
  it("runs app/inbox changes before projection and rejects model changes after admission", async () => {
    const upstream = vi.fn(async () => ({ messages: messages(), system: "authoritative" }));
    const prepare = contextPrepareStep({ prepareStep: upstream, policy, runtime: runtime(), sessionId: "s" });
    const result = await prepare({ messages: [], stepNumber: 0 } as never);
    expect(upstream).toHaveBeenCalledTimes(1); expect(result?.system).toBe("authoritative");
    expect(JSON.stringify(result?.messages).length).toBeLessThan(1500);
    const bad = contextPrepareStep({ prepareStep: async () => ({ model: { modelId: "other", provider: "fake" } } as never), policy, runtime: runtime(), sessionId: "s" });
    await expect(bad({ messages: [] } as never)).rejects.toThrow("model_changed");
  });
});
