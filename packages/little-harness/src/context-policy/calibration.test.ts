import type { ModelMessage } from "ai";
import { expect, it, vi } from "vitest";
import { contextInputRequest, contextRequestBytes, recordContextInputUsage } from "./calibration.js";
import { compactContext, inMemoryContextCheckpointStore } from "./policy.js";
import { contextSessionLogStore } from "./log-store.js";
import { inMemorySessionLog } from "../remote-session/session-log-store.js";

const model = { modelId: "model", providerId: "provider", maxOutputTokens: 1024, contextWindow: { tokens: 100000, source: "fixture" } };
const history = (value: string): ModelMessage[] => [
  { role: "user", content: "earlier" },
  { role: "assistant", content: [{ type: "tool-call", toolCallId: "c", toolName: "lookup", input: {} }] },
  { role: "tool", content: [{ type: "tool-result", toolCallId: "c", toolName: "lookup", output: { type: "text", value } }] },
  { role: "assistant", content: "done" }, { role: "user", content: "current" },
];
const policy = { triggerTokens: 2400, keepLastTurns: 1, summaryModel: false as const };

for (const [text, ratio] of [["English text ".repeat(450), 1 / 4], ["廣東話內容".repeat(400), 1 / 3]] as const) {
  it(`uses measured per-request input/bytes for the soft trigger (${ratio})`, async () => {
    const runtime = { model, store: inMemoryContextCheckpointStore() };
    const messages = history(text);
    const request = contextInputRequest(runtime, "s", { messages });
    const inputTokens = Math.floor(request.requestBytes * ratio);
    await recordContextInputUsage(runtime, request, { usage: { inputTokens }, totalUsage: { inputTokens: 9999999 } });
    expect(await runtime.store.lastInputUsage!("s")).toEqual({ ...request, inputTokens });
    expect(await compactContext({ runtime, sessionId: "s", messages, policy })).toBe(messages);
    const larger = history(text.repeat(2));
    const projected = await compactContext({ runtime, sessionId: "s", messages: larger, policy });
    expect(JSON.stringify(projected)).toContain("canonical result c");
    const checkpoint = (await runtime.store.list!())[0]!;
    expect(checkpoint).toMatchObject({ estimator: "last-input-ratio-v1", beforeBytes: contextRequestBytes({ messages: larger }), calibration: { ...request, inputTokens } });
    expect(checkpoint.beforeTokens).toBe(Math.ceil(checkpoint.beforeBytes! * inputTokens / request.requestBytes));
  });
}
it("keeps cold start and the hard bound conservative; rejects invalid/cross-session/model samples", async () => {
  const runtime = { model, store: inMemoryContextCheckpointStore() };
  const messages = history("text ".repeat(1200));
  expect(await compactContext({ runtime, sessionId: "s", messages, policy })).not.toEqual(messages);
  const request = contextInputRequest(runtime, "s", { messages });
  await recordContextInputUsage(runtime, request, { usage: { inputTokens: 100 } });
  const hardRuntime = { ...runtime, model: { ...model, contextWindow: { tokens: 7000, source: "fixture" } } };
  const required: ModelMessage[] = [{ role: "user", content: "x".repeat(9000) }];
  await expect(compactContext({ runtime: hardRuntime, sessionId: "s", policy, messages: required })).rejects.toMatchObject({ reason: "irreducible_context", tokens: contextRequestBytes({ messages: required }) });
  const foreign = { ...request, sessionId: "other", inputTokens: 1 };
  const foreignStore = { ...inMemoryContextCheckpointStore(), lastInputUsage: async () => foreign };
  expect(await compactContext({ runtime: { ...runtime, store: foreignStore }, sessionId: "s", messages, policy })).not.toEqual(messages);
  for (const sample of [{ ...request, inputTokens: 0 }, { ...request, inputTokens: NaN }, { ...request, modelId: "other", inputTokens: 1 }]) {
    const store = { ...inMemoryContextCheckpointStore(), lastInputUsage: async () => sample };
    expect(await compactContext({ runtime: { ...runtime, store }, sessionId: "s", messages, policy })).not.toEqual(messages);
  }
});
it("restores the last matching sample after restart and keeps committed views stable as calibration changes", async () => {
  const log = inMemorySessionLog();
  const make = () => ({ model, store: contextSessionLogStore({ log, sessionId: "s", isCurrent: async () => true }) });
  const messages = history("English ".repeat(1000));
  const initial = await compactContext({ runtime: make(), sessionId: "s", messages, policy });
  const request = contextInputRequest(make(), "s", { messages: initial });
  await recordContextInputUsage(make(), request, { usage: { inputTokens: 10 } });
  expect(await make().store.lastInputUsage!("s")).toMatchObject({ requestHash: request.requestHash, requestBytes: request.requestBytes, inputTokens: 10 });
  expect(await compactContext({ runtime: make(), sessionId: "s", messages, policy })).toEqual(initial);
  // Identical payloads on later actual calls still become the latest sample, rather than
  // deduplicating back into an older position in the append-only log.
  const second = contextInputRequest(make(), "s", { messages: [{ role: "user", content: "second" }] });
  await recordContextInputUsage(make(), second, { usage: { inputTokens: 20 } });
  const again = contextInputRequest(make(), "s", { messages: initial });
  await recordContextInputUsage(make(), again, { usage: { inputTokens: 10 } });
  expect(await make().store.lastInputUsage!("s")).toMatchObject({ requestId: again.requestId, inputTokens: 10 });
});
it("ignores missing/estimated/cancelled usage and treats calibration-store failure as cold start", async () => {
  const recordInputUsage = vi.fn();
  const runtime = { model, store: { ...inMemoryContextCheckpointStore(), recordInputUsage } };
  const request = contextInputRequest(runtime, "s", { messages: [] });
  for (const result of [{ totalUsage: { inputTokens: 123 } }, { usage: { inputTokens: 0 } }, { usage: { inputTokens: 10, estimated: true } }]) await recordContextInputUsage(runtime, request, result);
  await recordContextInputUsage(runtime, request, { usage: { inputTokens: 10 } }, AbortSignal.abort());
  expect(recordInputUsage).not.toHaveBeenCalled();
  const messages = history("text ".repeat(1200));
  const store = { ...runtime.store, lastInputUsage: async () => { throw new Error("unavailable"); } };
  expect(await compactContext({ runtime: { ...runtime, store }, sessionId: "s", messages, policy })).not.toEqual(messages);
});
