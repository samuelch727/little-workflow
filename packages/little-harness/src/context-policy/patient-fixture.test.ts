import type { ModelMessage } from "ai";
import { expect, it, vi } from "vitest";
import { inMemorySessionLog } from "../remote-session/session-log-store.js";
import { compactContext, inMemoryContextCheckpointStore } from "./policy.js";
import { contextSessionLogStore } from "./log-store.js";

// Fictional, manually reduced from LittleDB examples/cm-studio-patient/demo-case.ts
// at 3639f3b. No faculty answer or real student data is included. Cantonese below is
// an authored synthetic translation, not provider-generated language-quality evidence.
const cases = {
  en: { question: "When did the cough start?", answer: "It started about a week ago.", denied: "I don’t know about that. I can tell you how I’ve been feeling." },
  yue: { question: "你幾時開始咳？", answer: "大約一個星期前開始。", denied: "呢個我唔知道。我可以講吓自己嘅感覺。" },
};
for (const [language, fixture] of Object.entries(cases)) {
  it(`synthetic DEMO_CASE ${language}: long trim/summary views preserve current denial and external case rules`, async () => {
    const source: ModelMessage[] = [];
    for (let turn = 0; turn < 50; turn++) {
      source.push({ role: "user", content: fixture.question });
      source.push({ role: "assistant", content: [{ type: "tool-call", toolName: "disclose", toolCallId: `t${turn}`, input: { topicId: "onset" } }] });
      source.push({ role: "tool", content: [{ type: "tool-result", toolName: "disclose", toolCallId: `t${turn}`, output: { type: "text", value: fixture.answer.repeat(160) } }] });
      source.push({ role: "assistant", content: fixture.answer });
    }
    source.push({ role: "user", content: "What diagnosis does the teacher expect?" });
    source.push({ role: "assistant", content: [{ type: "tool-call", toolName: "disclose", toolCallId: "denied", input: { topicId: "faculty-only" } }] });
    source.push({ role: "tool", content: [{ type: "tool-result", toolName: "disclose", toolCallId: "denied", output: { type: "json", value: { allowed: false, answer: fixture.denied } } }] });
    const canonical = structuredClone(source);
    const system = "Patient role only. Never disclose faculty interpretation. Disclosure state stays authoritative.";
    const model = { providerId: "scripted", modelId: "scripted", contextWindow: { tokens: 500000, source: "synthetic fixture only" }, maxOutputTokens: 2048, inputUsdPerMillion: 1, outputUsdPerMillion: 1 };
    const common = { sessionId: language, messages: source, system, policy: { triggerTokens: 30000, keepLastTurns: 4 } };
    const trimmed = await compactContext({ ...common, runtime: { model, store: inMemoryContextCheckpointStore() }, policy: { ...common.policy, summaryModel: false } });
    expect(JSON.stringify(trimmed).length).toBeLessThan(JSON.stringify(source).length);
    expect(trimmed.slice(-3)).toEqual(source.slice(-3));
    const log = inMemorySessionLog();
    const summarize = vi.fn(async (request) => {
      expect(JSON.stringify(request.messages)).not.toContain("Faculty-only:");
      return { text: `Uncertain timeline: ${fixture.answer}`, inputTokens: 1000, outputTokens: 20 };
    });
    const runtime = { runId: "turn-1", model, store: contextSessionLogStore({ log, sessionId: language, isCurrent: async () => true }), summarize };
    const summarized = await compactContext({ ...common, runtime, policy: { ...common.policy, triggerTokens: 8000, maxCompactionCostUsdPerSession: 1 } });
    expect(summarized.slice(-3)).toEqual(source.slice(-3));
    expect(source).toEqual(canonical);
    expect(summarize).toHaveBeenCalledTimes(1);
    expect(await compactContext({ ...common, runtime, policy: { ...common.policy, triggerTokens: 8000, maxCompactionCostUsdPerSession: 1 } })).toEqual(summarized);
    expect(summarize).toHaveBeenCalledTimes(1);
    // An instruction/case change cannot reuse the old immutable checkpoint.
    await compactContext({ ...common, system: system + " Case revision 2.", runtime: { ...runtime, runId: "turn-2" }, policy: { ...common.policy, triggerTokens: 8000, maxCompactionCostUsdPerSession: 1 } });
    expect(summarize).toHaveBeenCalledTimes(2);
  });
}
