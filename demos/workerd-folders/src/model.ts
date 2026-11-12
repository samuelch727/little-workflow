import { MockLanguageModelV3 } from "ai/test";
type Content = Awaited<ReturnType<MockLanguageModelV3["doGenerate"]>>["content"];
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
/** Keyless deterministic model so the complete demo works offline, including tool execution. */
export function scriptedModel() {
  return new MockLanguageModelV3({ doGenerate: async ({ prompt }) => {
    const result = (content: Content) => ({ content, finishReason: { unified: "stop" as const, raw: "stop" }, usage, warnings: [] });
    const last = prompt.at(-1);
    if (last?.role === "tool") {
      if (prompt.filter(m => m.role === "user").at(-1)?.content.some(p => p.type === "text" && p.text.startsWith("fail:"))) throw new Error("Synthetic post-tool failure");
      const part = last.content[0];
      return result([{ type: "text", text: JSON.stringify(part?.type === "tool-result" ? part.output : part) }]);
    }
    const user = prompt.filter(m => m.role === "user").at(-1);
    const text = user?.content.map(p => p.type === "text" ? p.text : "").join("") ?? "";
    if (text === "system") return result([{ type: "text", text: prompt.filter(m => m.role === "system").map(m => m.content).join("\n") }]);
    if (text === "history") return result([{ type: "text", text: String(prompt.filter(m => m.role === "user").length) }]);
    const name = text.startsWith("count:") ? "word_count" : text === "counter" ? "counter" : text.startsWith("pause:") ? "wait" : "bash";
    const input = name === "word_count" ? { text: text.slice(6) } : name === "counter" ? {} : name === "wait" ? { ms: Number(text.slice(6)) } : { command: text.startsWith("fail:") ? text.slice(5) : text };
    return result([{ type: "tool-call", toolCallId: crypto.randomUUID(), toolName: name, input: JSON.stringify(input) }]);
  } });
}
