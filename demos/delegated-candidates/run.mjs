/**
 * delegated-candidates — the minimal, maximal-delegation counterpart to
 * hiring-candidates.
 *
 *   node run.mjs [count]        live DeepSeek run (default count = 24)
 *   node run.mjs stub [count]   keyless deterministic smoke run
 *
 * We define *only* the candidate output schema and a terse description
 * ("generate candidates data"). No inputSchema (flexible input), no planner or
 * orchestrator system prompts, no batch plan. Pro plans + orchestrates, flash is
 * the only worker model, and we hand the model nothing but a one-line goal +
 * count — then watch (in the littleDB viewer) what it chooses to do.
 *
 * Requires DEEPSEEK_API_KEY for live runs (env or the repo-root .env.local).
 */

import { writeFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import * as ai from "ai";
import { tool } from "ai";
import { createDeepSeek } from "@ai-sdk/deepseek";
import {
  createWorkflowHarness,
  createLittleWorkflow,
  createToolRegistry,
  localWorld,
  model,
  output,
  runWorkflow,
  skill,
} from "little-workflow";

import {
  candidateItemSchema,
  candidateArraySchema,
  LOCATIONS,
  EDUCATION,
  SOURCES,
  SENIORITY,
  STATUSES,
} from "./candidate-schema.mjs";
import { littledbWorld } from "./littledb-world.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const WORKFLOW_ID = "delegated.candidates";
const TAGS = ["synthetic-candidates", "delegated", "flexible-input", "littledb-test"];
const SUBRUN_TOOLS = new Set(["run_workflow", "start_workflow"]);

const isDirectRun = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (isDirectRun) {
  await main().catch((error) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exit(1);
  });
}

async function main() {
  const args = process.argv.slice(2);
  const useStub = args[0] === "stub";
  const countArg = useStub ? args[1] : args[0];
  const count = Number(countArg ?? process.env.CANDIDATE_COUNT ?? 24);
  if (!Number.isInteger(count) || count < 1) throw new Error(`Invalid count: ${countArg}`);
  const engineUrl = process.env.LITTLEDB_ENGINE_URL ?? "http://localhost:7878";

  if (!useStub) {
    await loadDotEnvLocal();
    if (!process.env.DEEPSEEK_API_KEY) {
      console.error("Set DEEPSEEK_API_KEY (or use `node run.mjs stub`).");
      process.exit(1);
    }
  }

  console.log(`# delegated-candidates [${useStub ? "stub" : "live"}]`);
  const { result, candidates, subRuns } = await runDelegatedCandidates({ useStub, count, engineUrl });

  const completed = subRuns.filter((r) => r.status === "completed").length;
  console.log(
    `status: ${result.status} | candidates: ${candidates.length} | ` +
      `sub-runs: ${subRuns.length} (${completed} completed) | events: ${result.events?.length ?? 0}`,
  );
  console.log(`Run id: ${result.runId} — open the trace in the viewer (tag: delegated).`);

  const outDir = join(here, "out");
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, "candidates.json"), JSON.stringify(candidates, null, 2));
}

/**
 * Run the delegated-candidates workflow. Returns the run result, the harvested
 * candidates, and the number of fan-out (run_workflow) calls the model made.
 * Tests pass their own `world` (e.g. a localWorld) to avoid the littleDB tee.
 */
export async function runDelegatedCandidates({
  useStub = false,
  count = 24,
  world,
  engineUrl = "http://localhost:7878",
  maxConcurrentSubRuns = Number(process.env.MAX_CONCURRENT_SUBRUNS ?? 5),
  runId = `run_delegated_candidates_${useStub ? "stub" : "live"}_${Date.now()}`,
  permissions,
  compaction,
} = {}) {
  const tags = [...TAGS, useStub ? "stub" : "deepseek"];
  const traceWorld =
    world ?? littledbWorld({ dataDir: join(here, ".little-workflow-delegated-candidates"), engineUrl });

  // The ONLY thing we hand the model: a one-line goal + count. Free-form input.
  const input = {
    goal: "Generate a diverse, realistic pool of fictional job candidates for a Senior Fullstack Engineer role.",
    count,
  };

  const setup = useStub ? buildStubSetup() : buildLiveSetup({ compaction });

  const result = await runWorkflow({
    world: traceWorld,
    // Array + orchestrator → the model can fan out; single workflow → direct run.
    ...(setup.orchestrator
      ? { workflows: [setup.workflow], orchestrator: { ...setup.orchestrator, maxConcurrentSubRuns } }
      : { workflows: setup.workflow }),
    input,
    tools: setup.tools,
    runId,
    label: "delegated-candidates",
    tags,
    ...(permissions ? { permissions } : {}),
  });

  if (typeof traceWorld.flushTee === "function") await traceWorld.flushTee();

  // The orchestrator runs the workflow via start_workflow / run_workflow; the
  // candidates land in each sub-run's output (often an artifact). Harvest those.
  const events = result.events ?? [];
  const subRunResults = await hydrateSubRunOutputs(traceWorld, harvestSubRunResults(events));
  const candidates = collectCandidates(result.output, subRunResults);
  return { result, candidates, subRuns: subRunResults };
}

// ---------------------------------------------------------------------------
// Live setup — pro plans + orchestrates (no system prompts), flash workers.
// ---------------------------------------------------------------------------

function buildLiveSetup({ compaction } = {}) {
  const harnessOpts = compaction ? { aiSdkModule: ai, conversationCompaction: compaction } : { aiSdkModule: ai };
  const reasoningModelId = process.env.DEEPSEEK_MODEL_ID ?? "deepseek-v4-pro";
  const workerModelId = process.env.DEEPSEEK_WORKER_MODEL_ID ?? "deepseek-v4-flash";
  const baseURL = process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com/v1";
  const provider = createDeepSeek({
    apiKey: process.env.DEEPSEEK_API_KEY,
    baseURL,
    headers: { "accept-encoding": "identity" },
  });

  const pro = ai.wrapLanguageModel({
    model: provider(reasoningModelId),
    middleware: ai.defaultSettingsMiddleware({
      settings: {
        maxRetries: 5,
        providerOptions: { deepseek: { thinking: { type: "enabled" }, reasoningEffort: "high" } },
      },
    }),
  });
  const flash = ai.wrapLanguageModel({
    model: provider(workerModelId),
    middleware: ai.defaultSettingsMiddleware({
      settings: { maxRetries: 5, providerOptions: { deepseek: { thinking: { type: "disabled" } } } },
    }),
  });

  // Flash is the only worker/execution model; the slot description is the only
  // hint the (prompt-less) planner gets about how to use it.
  const flashSlot = model(flash, {
    id: "model.worker",
    description: "Fast, cheap DeepSeek flash worker (thinking off) for bulk candidate generation.",
  });

  // Instead of a hand-written system prompt, we hand the planner + orchestrator a
  // *skill*: general workflow-design judgment (decompose, fan out, coordinate
  // distinct sub-runs, right-size, honor the schema) they read when they need it.
  const designSkill = skill(join(here, "skills", "designing-workflows"));

  return {
    workflow: createLittleWorkflow({
      id: WORKFLOW_ID,
      description: "generate candidates data",
      // no inputSchema — flexible input
      output: output.array({ element: candidateItemSchema }),
      models: [flashSlot],
      planner: { model: pro, harness: createWorkflowHarness(harnessOpts), skills: [designSkill] }, // no system; skill, not prompt
      worker: { harness: createWorkflowHarness(harnessOpts) },
      workflowVersionReuseStrategy: "planner_reviewed",
    }),
    tools: createToolRegistry({}),
    // Pro orchestrates; it has plan_workflow / run_workflow available and decides
    // entirely on its own whether (and how) to fan out. No system prompt — the
    // design skill is its only guidance.
    orchestrator: { model: pro, harness: createWorkflowHarness(harnessOpts), skills: [designSkill] },
  };
}

// ---------------------------------------------------------------------------
// Stub setup — keyless, deterministic, no orchestrator (direct workflow run).
// ---------------------------------------------------------------------------

function buildStubSetup() {
  const emitCandidates = tool({
    description: "Deterministically emit N fake candidates.",
    inputSchema: { type: "object", additionalProperties: true },
    outputSchema: candidateArraySchema,
    execute: async ({ count }) => buildDeterministicCandidates(Number(count) || 1),
  });

  const fixedLwir = {
    apiVersion: "littleworkflow.dev/v0.1",
    kind: "Workflow",
    metadata: { name: WORKFLOW_ID, version: "0.1.0-alpha", description: "Deterministic stub candidates." },
    input: { schema: true }, // flexible input
    output: { schema: candidateArraySchema },
    permissions: { tools: ["emit_candidates"], models: [], secrets: [], network: [] },
    steps: [
      {
        id: "emit",
        uses: "tool.call",
        with: { tool: "emit_candidates" },
        input: { count: "{{ input.count }}" },
        output: { mode: "array", schema: candidateArraySchema },
      },
    ],
  };

  const plannerHarness = {
    harnessId: "stubDelegatedPlanner@1.0.0",
    async run(task) {
      return task.kind === "plan" ? { kind: "plan", lwir: fixedLwir } : { kind: "delegate_to_default" };
    },
  };

  return {
    workflow: createLittleWorkflow({
      id: WORKFLOW_ID,
      description: "generate candidates data",
      output: output.array({ element: candidateItemSchema }),
      models: [model({ provider: "stub", modelId: "stub-worker" }, { id: "model.worker", description: "Unused stub slot (tool.call path)." })],
      planner: { model: { provider: "stub", modelId: "stub-planner" }, harness: plannerHarness },
      globalTools: ["emit_candidates"],
      worker: { harness: createWorkflowHarness() },
      workflowVersionReuseStrategy: "planner_reviewed",
    }),
    tools: createToolRegistry({ emit_candidates: emitCandidates }),
    orchestrator: undefined, // direct run — the stub doesn't fan out
  };
}

function buildDeterministicCandidates(count) {
  const pick = (arr, i) => arr[i % arr.length];
  const companies = ["Northwind", "Acme", "Globex", "Initech", "Umbrella", "Hooli"];
  return Array.from({ length: count }, (_, i) => {
    const n = i + 1;
    return {
      candidate_id: `CAND-${String(n).padStart(4, "0")}`,
      full_name: `Candidate ${n}`,
      email: `candidate${n}@example.com`,
      location: pick(LOCATIONS, i),
      headline: `Senior Fullstack Engineer #${n}`,
      years_experience: 2 + (i % 12),
      current_company: pick(companies, i),
      top_skills: ["TypeScript", "React", "Node.js"],
      education: pick(EDUCATION, i),
      summary: `Deterministic stub candidate ${n} for the delegated-candidates demo.`,
      desired_salary_usd: 120000 + (i % 8) * 5000,
      source: pick(SOURCES, i),
      seniority: pick(SENIORITY, i),
      status: pick(STATUSES, i),
      match_score: 50 + (i % 50),
    };
  });
}

// ---------------------------------------------------------------------------
// Harvest — candidates live in result.output (direct/stub run) or in the
// orchestrator's sub-run outputs (start_workflow / run_workflow), which are
// often artifacts. Pair Started↔Succeeded, read artifacts, walk for candidates.
// ---------------------------------------------------------------------------

function harvestSubRunResults(events) {
  const startedByCallId = new Map();
  for (const e of events) {
    if (e?.type === "harness.tool_call.started" && e.payload?.callId !== undefined) {
      startedByCallId.set(e.payload.callId, e.payload.toolName);
    }
  }
  const results = [];
  for (const e of events) {
    if (e?.type !== "harness.tool_call.succeeded") continue;
    if (!SUBRUN_TOOLS.has(startedByCallId.get(e.payload?.callId))) continue;
    const r = e.payload?.result ?? {};
    results.push({ runId: r.runId, status: r.status, output: r.output, outputRef: r.outputRef });
  }
  return results;
}

async function hydrateSubRunOutputs(world, results) {
  const hydrated = [];
  for (const r of results) {
    if (r.output !== undefined || typeof r.outputRef !== "string" || typeof world.readArtifact !== "function") {
      hydrated.push(r);
      continue;
    }
    try {
      const artifact = await world.readArtifact(r.outputRef);
      hydrated.push({ ...r, output: artifact.payload });
    } catch {
      hydrated.push(r);
    }
  }
  return hydrated;
}

function collectCandidates(rootOutput, subRunResults) {
  const out = [];
  const isCandidate = (x) => x && typeof x === "object" && typeof x.candidate_id === "string";
  const walk = (val) => {
    if (Array.isArray(val)) {
      val.forEach(walk);
    } else if (isCandidate(val)) {
      out.push(val);
    } else if (val && typeof val === "object") {
      if (Array.isArray(val.runs)) val.runs.forEach(walk);
      if (val.output !== undefined) walk(val.output);
      if (val.candidates !== undefined) walk(val.candidates);
    }
  };
  walk(rootOutput);
  for (const r of subRunResults) walk(r.output);
  const seen = new Set();
  return out.filter((c) => !seen.has(c.candidate_id) && seen.add(c.candidate_id));
}

async function loadDotEnvLocal() {
  if (process.env.DEEPSEEK_API_KEY) return;
  const candidates = [
    join(here, ".env.local"),
    join(here, "..", "..", ".env.local"), // worktree root
    join(here, "..", "..", "..", "..", ".env.local"), // main repo root
  ];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    const text = await readFile(path, "utf8");
    for (const line of text.split("\n")) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (!match) continue;
      const [, key, rawValue] = match;
      if (process.env[key] !== undefined) continue;
      process.env[key] = rawValue.replace(/^["']|["']$/g, "");
    }
  }
}
