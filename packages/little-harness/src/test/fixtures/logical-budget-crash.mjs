import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const sourceRoot = new URL("../../", import.meta.url).href;
registerHooks({ resolve(specifier, context, next) {
  if (specifier.endsWith(".js") && context.parentURL?.startsWith(sourceRoot)) {
    const candidate = new URL(specifier.slice(0, -3) + ".ts", context.parentURL);
    if (existsSync(fileURLToPath(candidate))) return next(candidate.href, context);
  }
  return next(specifier, context);
} });
const { createHarness, localHost, generateHarness } = await import("../../index.ts");
const { createFileDurableStore, createDurableOrchestrationServices } = await import("../../local-host/durable-services.ts");
const { fileSessionLog } = await import("../../remote-session/session-log-store.ts");
const { MockLanguageModelV3 } = await import("ai/test");
const [directory, stage] = process.argv.slice(2);
let calls = 0;
const exit = () => { console.log(JSON.stringify({ interrupted: stage, calls })); process.exit(0); };
const store = createFileDurableStore(join(directory, "durable"));
const write = store.writeJsonDurable.bind(store);
store.writeJsonDurable = async (path, value) => {
  if (value.receipts?.[0]?.state === "settled" && stage === "before-settle") exit();
  await write(path, value);
  if (value.receipts?.[0]?.state === "settled" && stage === "after-settle") exit();
};
const orchestration = createDurableOrchestrationServices({ rootDir: join(directory, "durable"), store });
const log = fileSessionLog({ path: join(directory, "events.ndjson") });
const sessionLog = { priorEvents: log.priorEvents, append: async event => {
  const saved = await log.append(event);
  if (event.type === "harness.model.responded" && stage === "after-response") exit();
  return saved;
} };
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
const model = new MockLanguageModelV3({ modelId: "priced", doGenerate: async () => { calls++; return { content: [{ type: "text", text: "done" }], finishReason: { unified: "stop", raw: "stop" }, usage, warnings: [] }; } });
const harness = createHarness({ host: localHost({ dataDir: directory, orchestration }), model, sessionLog, runtime: { bash: false }, turnLimits: { accounting: "logical-turn", maxSteps: 3, maxCostUsd: 3, price: () => .5 } });
try {
  const result = await generateHarness({ harness, session: "s", runId: "root", prompt: "Go" });
  const state = await orchestration.turnBudgets.inspect({ version: "lh.turn-budget.v1", sessionId: "s", originRunId: "root" });
  console.log(JSON.stringify({ status: result.status, calls, steps: state.steps, costUsd: state.costUsd }));
} catch (error) {
  const state = await orchestration.turnBudgets.inspect({ version: "lh.turn-budget.v1", sessionId: "s", originRunId: "root" });
  console.log(JSON.stringify({ reason: error.reason, calls, steps: state.steps, costUsd: state.costUsd }));
}
