import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
const sourceRoot = new URL("../../", import.meta.url).href;
// Run repository source in a genuinely fresh Node process; no build output or paid provider is used.
registerHooks({ resolve(specifier, context, next) {
  if (specifier.endsWith(".js") && context.parentURL?.startsWith(sourceRoot)) {
    const candidate = new URL(specifier.slice(0, -3) + ".ts", context.parentURL);
    if (existsSync(fileURLToPath(candidate))) return next(candidate.href, context);
  }
  return next(specifier, context);
} });
const { createHarness, localHost, generateHarness, resumeParked, listInputRequests, answerInputRequest, harnessToolContext } = await import("../../index.ts");
const { tool } = await import("ai");
const { MockLanguageModelV3 } = await import("ai/test");
const { z } = await import("zod");
const [directory, stage, cap] = process.argv.slice(2);
let calls = 0;
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
const model = new MockLanguageModelV3({ provider: "test", modelId: "priced", doGenerate: async options => {
  calls++;
  const previous = options.prompt.flatMap(message => Array.isArray(message.content) ? message.content : []).filter(part => part.type === "tool-call" && part.toolName === "approve").length;
  return { content: [{ type: "tool-call", toolCallId: `approve_${previous + 1}`, toolName: "approve", input: JSON.stringify({ key: `card_${previous + 1}` }) }], finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage, warnings: [] };
} });
const approve = tool({ description: "Approval", inputSchema: z.object({ key: z.string() }), execute: async ({ key }, options) => {
  const result = await harnessToolContext(options).ask({ question: key, options: [{ id: "yes", label: "Yes" }] }, { key, wait: true });
  return result.status === "parked" ? result.output : "approved";
} });
const harness = createHarness({ host: localHost({ dataDir: directory, sandbox: "in-process" }), model, tools: { approve }, humanInput: { tool: false }, runtime: { bash: false }, turnLimits: { accounting: "logical-turn", maxSteps: cap === "cost" ? 24 : 2, maxCostUsd: cap === "cost" ? 1 : 3, price: () => cap === "cost" ? .6 : .1 } });
if (stage === "start") {
  const result = await generateHarness({ harness, session: "s", runId: "root", prompt: "Go" });
  console.log(JSON.stringify({ status: result.status, calls }));
} else {
  const [request] = await listInputRequests({ harness, sessionId: "s" });
  await answerInputRequest({ harness, sessionId: "s", requestId: request.requestId, answer: { option: "yes" } });
  const result = await resumeParked({ harness, maxAttempts: 1 });
  console.log(JSON.stringify({ status: result.resumed[0]?.result.status ?? "failed", reason: result.failed[0]?.error.reason, calls }));
}
