// Generalization probe: does the designing-workflows skill help a DIFFERENT
// domain (fictional startups, different schema) coordinate a fan-out — i.e. is
// the win a general skill effect, not overfit to candidates?
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as ai from "ai";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createWorkflowHarness, createLittleWorkflow, createToolRegistry, model, output, runWorkflow, skill } from "little-workflow";
import { littledbWorld } from "./littledb-world.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const count = Number(process.argv[2] ?? 40);
for (const p of ["../../.env.local", "../../../../.env.local"]) {
  if (!existsSync(join(here, p))) continue;
  for (const line of (await readFile(join(here, p), "utf8")).split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const provider = createDeepSeek({ apiKey: process.env.DEEPSEEK_API_KEY, baseURL: "https://api.deepseek.com/v1", headers: { "accept-encoding": "identity" } });
const pro = ai.wrapLanguageModel({ model: provider("deepseek-v4-pro"), middleware: ai.defaultSettingsMiddleware({ settings: { maxRetries: 5, providerOptions: { deepseek: { thinking: { type: "enabled" }, reasoningEffort: "high" } } } }) });
const flash = ai.wrapLanguageModel({ model: provider("deepseek-v4-flash"), middleware: ai.defaultSettingsMiddleware({ settings: { maxRetries: 5, providerOptions: { deepseek: { thinking: { type: "disabled" } } } } }) });
const flashSlot = model(flash, { id: "model.worker", description: "Fast bulk worker." });
const designSkill = skill(join(here, "skills", "designing-workflows"));

const startupSchema = {
  type: "object",
  required: ["startup_id", "name", "sector", "one_liner", "stage", "team_size"],
  additionalProperties: false,
  properties: {
    startup_id: { type: "string" },
    name: { type: "string" },
    sector: { type: "string", enum: ["Fintech", "Healthtech", "Climate", "Devtools", "Consumer", "Logistics", "AI", "Security"] },
    one_liner: { type: "string" },
    stage: { type: "string", enum: ["Pre-seed", "Seed", "Series A", "Series B"] },
    team_size: { type: "integer", minimum: 1 },
  },
};

const wf = createLittleWorkflow({
  id: "delegated.startups",
  description: "generate startup data",
  output: output.array({ element: startupSchema }),
  models: [flashSlot],
  planner: { model: pro, harness: createWorkflowHarness({ aiSdkModule: ai }), skills: [designSkill] },
  worker: { harness: createWorkflowHarness({ aiSdkModule: ai }) },
  workflowVersionReuseStrategy: "planner_reviewed",
});

const world = littledbWorld({ dataDir: join(here, ".little-workflow-generalization"), engineUrl: process.env.LITTLEDB_ENGINE_URL ?? "http://localhost:7878" });
const result = await runWorkflow({
  world,
  workflows: [wf],
  orchestrator: { model: pro, harness: createWorkflowHarness({ aiSdkModule: ai }), skills: [designSkill], maxConcurrentSubRuns: 5 },
  input: { goal: "Generate a diverse pool of fictional early-stage startups.", count },
  runId: `run_delegated_startups_live_${Date.now()}`,
  label: "delegated-startups",
  tags: ["startups", "delegated", "flexible-input", "skill-test", "deepseek"],
});
if (typeof world.flushTee === "function") await world.flushTee();

// harvest startups (by startup_id) from sub-run artifacts
const events = result.events ?? [];
const started = new Map();
for (const e of events) if (e?.type === "harness.tool_call.started" && e.payload?.callId) started.set(e.payload.callId, e.payload.toolName);
const items = [];
for (const e of events) {
  if (e?.type !== "harness.tool_call.succeeded") continue;
  if (!new Set(["run_workflow", "start_workflow"]).has(started.get(e.payload?.callId))) continue;
  let out = e.payload?.result?.output;
  const ref = e.payload?.result?.outputRef;
  if (out === undefined && typeof ref === "string" && typeof world.readArtifact === "function") {
    try { out = (await world.readArtifact(ref)).payload; } catch { /* ignore */ }
  }
  const walk = (v) => { if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === "object") { if (typeof v.startup_id === "string") items.push(v); else Object.values(v).forEach(walk); } };
  walk(out); // the resolved sub-run output (inline or read from the artifact)
}
const ids = items.map((s) => s.startup_id);
const subRuns = [...started.values()].filter((t) => t === "run_workflow" || t === "start_workflow").length;
console.log(`status: ${result.status} | requested: ${count} | distinct startups: ${new Set(ids).size} | sub-runs: ${subRuns} | run: ${result.runId}`);
console.log(`sample ids: ${ids.slice(0, 8).join(", ")}`);
