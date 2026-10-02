/**
 * hiring-candidates — generate a marketing hiring post + a pool of fake
 * candidates with DeepSeek, teeing the whole trace into littleDB.
 *
 *   node run.mjs [count]        live DeepSeek run (default count = 100)
 *   node run.mjs stub [count]   keyless deterministic smoke run
 *
 * Phase 1 (hiring.post.generate): planner + worker = deepseek-v4-pro. Invents a
 * role and writes a marketing job post as a structured object.
 * Phase 2 (hiring.candidate.batch): orchestrator + planner = deepseek-v4-pro,
 * workers = deepseek-v4-flash. The orchestrator plans once and fans out
 * run_workflow per batch; each worker generates one batch of candidates.
 *
 * Both phases share one littleDB tracing World, so every event tees to the
 * engine (default http://localhost:7878). Requires DEEPSEEK_API_KEY for live
 * runs (read from env or the repo-root .env.local).
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
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
  listEvents,
  model,
  runWorkflow,
} from "little-workflow";

import {
  candidateItemSchema,
  postSchema,
  batchInputSchema,
} from "./candidate-schema.mjs";
import {
  CANDIDATE_BATCH_WORKFLOW_ID,
  POST_WORKFLOW_ID,
  POST_PLANNER_SYSTEM_PROMPT,
  POST_ORCHESTRATOR_SYSTEM_PROMPT,
  CANDIDATE_PLANNER_SYSTEM_PROMPT,
  CANDIDATE_ORCHESTRATOR_SYSTEM_PROMPT,
  buildOrchestratorInput,
  buildPostOrchestratorInput,
  computeBatchPlan,
} from "./orchestrator-prompt.mjs";
import {
  collectCandidates,
  dedupeRunWorkflowResults,
  distributionReport,
  harvestRunWorkflowResults,
  limitCandidateCount,
  renumberCandidates,
  sumUsageFromEvents,
  summarizeEvents,
  toCandidateCsv,
  validateDataset,
} from "./eval.mjs";
import {
  buildDeterministicCandidates,
  buildDeterministicPost,
  stubCandidatePlannerHarness,
  stubOrchestratorHarness,
  stubPostOrchestratorHarness,
  stubPostPlannerHarness,
} from "./stub.mjs";
import { isPostOutput, resolveRole } from "./role.mjs";
import { littledbWorld } from "./littledb-world.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const TAGS = ["hiring", "synthetic-candidates", "littledb-test"];

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
  const candidateCount = Number(countArg ?? process.env.CANDIDATE_COUNT ?? 100);
  if (!Number.isInteger(candidateCount) || candidateCount < 1) {
    throw new Error(`Invalid candidate count: ${countArg}`);
  }
  const batchSize = Number(process.env.CANDIDATE_BATCH_SIZE ?? 10);
  const sessionChunk = Number(process.env.SESSION_CHUNK ?? Math.min(candidateCount, 50));
  const maxConcurrentSubRuns = Number(process.env.MAX_CONCURRENT_SUBRUNS ?? 5);
  const maxAttempts = Number(process.env.WORKER_MAX_ATTEMPTS ?? 3);
  // DeepSeek occasionally returns the transient "Failed to process successful
  // response"; retry the whole orchestrator session a few times (matches
  // ticket-factory) so one or two blips don't abort the run.
  const sessionAttempts = Number(process.env.SESSION_MAX_ATTEMPTS ?? 3);
  const engineUrl = process.env.LITTLEDB_ENGINE_URL ?? "http://localhost:7878";

  if (!useStub) {
    await loadDotEnvLocal();
    if (!process.env.DEEPSEEK_API_KEY) {
      console.error("Set DEEPSEEK_API_KEY (or use `node run.mjs stub`).");
      process.exit(1);
    }
  }

  const goal = await readFile(join(here, "spec", "task.md"), "utf8");
  const liveModels = useStub ? undefined : buildLiveModels();
  const tags = [...TAGS, useStub ? "stub" : "deepseek"];
  const candidateSessions = computeBatchPlan(candidateCount, sessionChunk);

  console.log(`# hiring-candidates [${useStub ? "stub" : "live"}]`);
  console.log(
    `Candidates: ${candidateCount} | batch size: ${batchSize} | ` +
      `batches: ${computeBatchPlan(candidateCount, batchSize).length} | ` +
      `sessions: ${candidateSessions.length} (chunk ${sessionChunk}) | concurrency: ${maxConcurrentSubRuns}`,
  );
  if (liveModels) {
    console.log(
      `Models: post + orchestrator + planner=${liveModels.reasoningModelId} (thinking on), ` +
        `candidate workers=${liveModels.workerModelId} (thinking off)`,
    );
  }
  console.log(`Engine: ${engineUrl} | tags: ${tags.join(", ")}`);
  console.log();

  const world = littledbWorld({
    dataDir: join(here, ".little-workflow-hiring-candidates"),
    engineUrl,
  });

  const startedAt = Date.now();

  // -- Phase 1: hiring post (orchestrated: plan + run once) -----------------
  const postSetup = buildPostSetup({ useStub, liveModels });
  const postRunId = `run_hiring_post_${useStub ? "stub" : "live"}_${Date.now()}`;
  console.log("-- Phase 1: hiring post --");
  const postResult = await runWorkflow({
    world,
    workflows: [postSetup.workflow],
    orchestrator: { ...postSetup.orchestrator, maxConcurrentSubRuns: 1 },
    input: buildPostOrchestratorInput({ goal }),
    tools: postSetup.tools,
    maxAttempts,
    runId: postRunId,
    label: "hiring-post",
    tags,
  });
  const postEvents = postResult.events ?? (await listEvents(world, postRunId).catch(() => []));
  const postSubRuns = await hydrateRunWorkflowResults(world, harvestRunWorkflowResults(postEvents));
  const postSubRun = postSubRuns.find((r) => isPostOutput(r.output));
  if (!isPostOutput(postSubRun?.output)) {
    console.error("Phase 1 produced no usable role; using a default role.");
  }
  const role = resolveRole(postSubRun?.output);
  console.log(`Role: ${role.role_title} @ ${role.company ?? "?"} (${postResult.status})`);
  console.log();

  // -- Phase 2: candidate fan-out ------------------------------------------
  console.log("-- Phase 2: candidate fan-out --");
  const candidateRootRunIds = [];
  const candidateEvents = [];
  const harvestedRunResults = [];
  const candidateSessionStatuses = [];
  for (const [sessionIndex, session] of candidateSessions.entries()) {
    const sessionNumber = sessionIndex + 1;
    if (candidateSessions.length > 1) {
      console.log(
        `Candidate session ${sessionNumber}/${candidateSessions.length}: ` +
          `${session.count} candidates starting at ${session.startIndex}`,
      );
    }

    const candidateSetup = buildCandidateSetup({
      useStub,
      liveModels,
      role,
      candidateCount: session.count,
      batchSize,
      startIndexBase: session.startIndex,
    });

    let candidateResult;
    let successfulRunId;
    const attemptRunIds = [];
    for (let attempt = 1; attempt <= sessionAttempts; attempt += 1) {
      const candidateRunId =
        `run_hiring_candidates_${useStub ? "stub" : "live"}_s${sessionNumber}_a${attempt}_${Date.now()}`;
      attemptRunIds.push(candidateRunId);
      candidateRootRunIds.push(candidateRunId);
      try {
        candidateResult = await runWorkflow({
          world,
          workflows: [candidateSetup.workflow],
          orchestrator: { ...candidateSetup.orchestrator, maxConcurrentSubRuns },
          input: buildOrchestratorInput({
            goal,
            role,
            totalCandidateCount: session.count,
            batchSize,
            startIndexBase: session.startIndex,
          }),
          tools: candidateSetup.tools,
          maxAttempts,
          runId: candidateRunId,
          label: "fake-candidates",
          tags,
        });
        successfulRunId = candidateRunId;
        break;
      } catch (error) {
        console.error(
          `Candidate session ${sessionNumber} attempt ${attempt}/${sessionAttempts} failed: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
        candidateResult = undefined;
      }
    }
    if (candidateResult && candidateResult.status !== "completed") {
      console.error(`Candidate session ${sessionNumber} status: ${candidateResult.status}`);
    }
    candidateSessionStatuses.push(candidateResult?.status ?? "did-not-complete");

    const eventsByRunId = new Map();
    if (candidateResult?.events !== undefined && successfulRunId !== undefined) {
      eventsByRunId.set(successfulRunId, candidateResult.events);
    }
    for (const runId of attemptRunIds) {
      const attemptEvents =
        eventsByRunId.get(runId) ?? (await listEvents(world, runId).catch(() => []));
      candidateEvents.push(...attemptEvents);
      harvestedRunResults.push(...harvestRunWorkflowResults(attemptEvents));
    }
  }

  // -- Harvest --------------------------------------------------------------
  const runResults = await hydrateRunWorkflowResults(world, dedupeRunWorkflowResults(harvestedRunResults));
  const candidates = renumberCandidates(limitCandidateCount(collectCandidates(runResults), candidateCount));

  const orchestratorUsage = sumUsageFromEvents(candidateEvents);
  const workerUsage = { inputTokens: 0, outputTokens: 0 };
  for (const runResult of runResults) {
    if (typeof runResult.runId !== "string") continue;
    try {
      const usage = sumUsageFromEvents(await listEvents(world, runResult.runId));
      workerUsage.inputTokens += usage.inputTokens;
      workerUsage.outputTokens += usage.outputTokens;
    } catch {
      // stub/tool.call sub-runs may have no model events; ignore.
    }
  }
  const postUsage = sumUsageFromEvents(postEvents);
  orchestratorUsage.inputTokens += postUsage.inputTokens;
  orchestratorUsage.outputTokens += postUsage.outputTokens;
  if (typeof postSubRun?.runId === "string") {
    try {
      const subUsage = sumUsageFromEvents(await listEvents(world, postSubRun.runId));
      orchestratorUsage.inputTokens += subUsage.inputTokens;
      orchestratorUsage.outputTokens += subUsage.outputTokens;
    } catch {
      // ignore
    }
  }

  const candidateStatus = candidateSessionStatuses.every((status) => status === "completed")
    ? "completed"
    : candidates.length > 0
      ? "partial"
      : "did-not-complete";
  const elapsedMs = Date.now() - startedAt;

  // -- Write deliverables ---------------------------------------------------
  const outDir = join(here, "out");
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, "fake_candidates.json"), JSON.stringify(candidates, null, 2) + "\n", "utf8");
  await writeFile(join(outDir, "hiring_post.md"), `${role.hiring_post_markdown ?? "(no post)"}\n`, "utf8");
  await writeFile(join(outDir, "candidate_summary.csv"), toCandidateCsv(candidates), "utf8");
  await writeFile(join(outDir, "role.json"), JSON.stringify(role, null, 2) + "\n", "utf8");

  // -- Tee + verify littleDB ------------------------------------------------
  await world.flushTee();
  const ingestion = await verifyLittleDb({ world, engineUrl, tags, postRunId, candidateRootRunIds, role });

  printReport({
    useStub,
    role,
    candidateCount,
    batchSize,
    runResults,
    candidates,
    validation: validateDataset(candidates),
    distribution: distributionReport(candidates),
    eventSummary: summarizeEvents(candidateEvents),
    orchestratorUsage,
    workerUsage,
    elapsedMs,
    outDir,
    ingestion,
    postStatus: postResult.status,
    candidateStatus,
  });
}

async function hydrateRunWorkflowResults(world, results) {
  const hydrated = [];
  for (const result of results ?? []) {
    if (result?.output !== undefined || typeof result?.outputRef !== "string") {
      hydrated.push(result);
      continue;
    }
    try {
      const artifact = await world.readArtifact(result.outputRef);
      hydrated.push({ ...result, output: artifact.payload });
    } catch {
      hydrated.push(result);
    }
  }
  return hydrated;
}

// ---------------------------------------------------------------------------
// Live model setup (DeepSeek via the SDK bash harness).
// ---------------------------------------------------------------------------

function buildLiveModels() {
  const reasoningModelId = process.env.DEEPSEEK_MODEL_ID ?? "deepseek-v4-pro";
  const workerModelId = process.env.DEEPSEEK_WORKER_MODEL_ID ?? "deepseek-v4-flash";
  const baseURL = process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com/v1";
  const provider = createDeepSeek({
    apiKey: process.env.DEEPSEEK_API_KEY,
    baseURL,
    headers: { "accept-encoding": "identity" },
  });

  // Reasoning tier (post writer + orchestrator + planner): thinking ON.
  const reasoningModel = ai.wrapLanguageModel({
    model: provider(reasoningModelId),
    middleware: ai.defaultSettingsMiddleware({
      settings: {
        maxRetries: 5,
        providerOptions: { deepseek: { thinking: { type: "enabled" }, reasoningEffort: "high" } },
      },
    }),
  });

  // Worker tier (bulk candidate generation): thinking OFF, cheap + parallel.
  const workerModel = ai.wrapLanguageModel({
    model: provider(workerModelId),
    middleware: ai.defaultSettingsMiddleware({
      settings: { maxRetries: 5, providerOptions: { deepseek: { thinking: { type: "disabled" } } } },
    }),
  });

  return { reasoningModel, workerModel, reasoningModelId, workerModelId };
}

// ---------------------------------------------------------------------------
// Phase setups (live + stub).
// ---------------------------------------------------------------------------

function buildPostSetup({ useStub, liveModels }) {
  if (!useStub) {
    const postSlot = model(liveModels.reasoningModel, {
      id: "model.post",
      description: "DeepSeek v4 pro that invents a role and writes a marketing hiring post.",
    });
    return {
      workflow: createLittleWorkflow({
        id: POST_WORKFLOW_ID,
        description: "Invent a role and write a marketing hiring post as a structured object.",
        inputSchema: { type: "object", additionalProperties: true },
        output: { kind: "object", schema: postSchema },
        models: [postSlot],
        planner: {
          model: liveModels.reasoningModel,
          harness: createWorkflowHarness({ aiSdkModule: ai }),
          system: POST_PLANNER_SYSTEM_PROMPT,
        },
        worker: { harness: createWorkflowHarness({ aiSdkModule: ai }) },
      }),
      tools: createToolRegistry({}),
      orchestrator: {
        model: liveModels.reasoningModel,
        harness: createWorkflowHarness({ aiSdkModule: ai }),
        system: POST_ORCHESTRATOR_SYSTEM_PROMPT,
      },
    };
  }

  const generatePost = tool({
    description: "Deterministically return a fixed hiring post object.",
    inputSchema: { type: "object", additionalProperties: true },
    outputSchema: postSchema,
    execute: async () => buildDeterministicPost(),
  });
  const stubSlot = model(
    { provider: "stub", modelId: "stub-post" },
    { id: "model.post", description: "Unused stub model slot (tool.call path)." },
  );
  return {
    workflow: createLittleWorkflow({
      id: POST_WORKFLOW_ID,
      description: "Deterministic keyless hiring post.",
      inputSchema: { type: "object", additionalProperties: true },
      output: { kind: "object", schema: postSchema },
      models: [stubSlot],
      planner: { model: { provider: "stub", modelId: "stub-post-planner" }, harness: stubPostPlannerHarness() },
      globalTools: ["generate_post"],
      worker: { harness: createWorkflowHarness() },
    }),
    tools: createToolRegistry({ generate_post: generatePost }),
    orchestrator: {
      model: { provider: "stub", modelId: "stub-post-orchestrator" },
      harness: stubPostOrchestratorHarness(),
    },
  };
}

function buildCandidateSetup({ useStub, liveModels, role, candidateCount, batchSize, startIndexBase = 1 }) {
  if (!useStub) {
    const workerSlot = model(liveModels.workerModel, {
      id: "model.worker",
      description: "DeepSeek v4 flash worker (thinking off) that generates candidate batches.",
    });
    return {
      workflow: createLittleWorkflow({
        id: CANDIDATE_BATCH_WORKFLOW_ID,
        description: "Generate one batch of realistic fake candidates as a JSON array.",
        inputSchema: batchInputSchema,
        output: { kind: "array", element: candidateItemSchema },
        models: [workerSlot],
        planner: {
          model: liveModels.reasoningModel,
          harness: createWorkflowHarness({ aiSdkModule: ai }),
          system: CANDIDATE_PLANNER_SYSTEM_PROMPT,
        },
        worker: { harness: createWorkflowHarness({ aiSdkModule: ai }) },
      }),
      tools: createToolRegistry({}),
      orchestrator: {
        model: liveModels.reasoningModel,
        harness: createWorkflowHarness({ aiSdkModule: ai }),
        system: CANDIDATE_ORCHESTRATOR_SYSTEM_PROMPT,
      },
    };
  }

  const generateBatch = tool({
    description: "Deterministically generate a batch of fake candidates.",
    inputSchema: batchInputSchema,
    outputSchema: { type: "array", items: candidateItemSchema },
    execute: async ({ count, startIndex, role_title, role_brief, key_skills }) =>
      buildDeterministicCandidates({
        count: Number(count) || 0,
        startIndex: Number(startIndex) || 1,
        role: { role_title, role_brief, key_skills },
      }),
  });
  const stubSlot = model(
    { provider: "stub", modelId: "stub-worker" },
    { id: "model.worker", description: "Unused stub model slot (tool.call path)." },
  );
  return {
    workflow: createLittleWorkflow({
      id: CANDIDATE_BATCH_WORKFLOW_ID,
      description: "Deterministic keyless candidate batch generator.",
      inputSchema: batchInputSchema,
      output: { kind: "array", element: candidateItemSchema },
      models: [stubSlot],
      planner: { model: { provider: "stub", modelId: "stub-cand-planner" }, harness: stubCandidatePlannerHarness() },
      globalTools: ["generate_batch"],
      worker: { harness: createWorkflowHarness() },
    }),
    tools: createToolRegistry({ generate_batch: generateBatch }),
    orchestrator: {
      model: { provider: "stub", modelId: "stub-orchestrator" },
      harness: stubOrchestratorHarness({ totalCandidateCount: candidateCount, batchSize, role, startIndexBase }),
    },
  };
}

// ---------------------------------------------------------------------------
// littleDB verification.
// ---------------------------------------------------------------------------

async function verifyLittleDb({ world, engineUrl, tags, postRunId, candidateRootRunIds, role }) {
  const SEARCH_LIMIT = 200;
  const report = { reachable: false };
  try {
    // Two distinct buffers: world.flushTee() (already awaited by the caller)
    // drains the demo's in-process tee into the engine's /ingest; POST /flush
    // tells the engine to seal its in-memory segment so the rows are queryable.
    const flush = await fetch(`${engineUrl}/flush`, { method: "POST" });
    report.flushOk = flush.ok;
    const tagged = await world.listRuns({ tags, limit: 500 });
    report.reachable = true;
    report.taggedRuns = tagged.length;
    report.sawPostRun = tagged.some((r) => r.run_id === postRunId || r.label === "hiring-post");
    const candidateRunIds = new Set(candidateRootRunIds);
    report.sawCandidateRoot = tagged.some((r) => candidateRunIds.has(r.run_id));
    report.traceChildren = 0;
    for (const runId of candidateRunIds) {
      const tree = await world.loadTraceTree(runId).catch(() => undefined);
      report.traceChildren += tree?.children?.length ?? 0;
    }
    const skill = role.key_skills?.[0] ?? "engineer";
    const hits = await world.search({ q: skill, limit: SEARCH_LIMIT });
    report.searchTerm = skill;
    report.searchHits = hits.length;
    report.searchCapped = hits.length >= SEARCH_LIMIT;
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
  }
  return report;
}

// ---------------------------------------------------------------------------
// Reporting.
// ---------------------------------------------------------------------------

function printReport(report) {
  const {
    useStub,
    role,
    candidateCount,
    runResults,
    candidates,
    validation,
    distribution,
    eventSummary,
    orchestratorUsage,
    workerUsage,
    elapsedMs,
    outDir,
    ingestion,
    postStatus,
    candidateStatus,
  } = report;

  const completedRuns = runResults.filter((r) => r.status === "completed").length;
  const totalTokens =
    orchestratorUsage.inputTokens + orchestratorUsage.outputTokens + workerUsage.inputTokens + workerUsage.outputTokens;

  console.log();
  console.log("=== Role ===");
  console.log(`${role.role_title}${role.company ? ` @ ${role.company}` : ""}`);
  console.log(`Skills: ${(role.key_skills ?? []).join(", ")}`);
  console.log();

  console.log("=== Fan-out ===");
  console.log(`Phase 1 (post): ${postStatus} | Phase 2 (candidates): ${candidateStatus}`);
  console.log(`sub-run calls: ${runResults.length} (completed: ${completedRuns})`);
  console.log();

  console.log("=== Dataset ===");
  console.log(`Candidates produced: ${candidates.length} / ${candidateCount} requested`);
  console.log(
    `Schema-valid: ${validation.validCount}/${validation.total} ` +
      `(${pct(validation.total === 0 ? 0 : validation.validCount / validation.total)})`,
  );
  if (validation.invalidCount > 0) {
    console.log(`Invalid: ${validation.invalidCount}. First problems:`);
    for (const entry of validation.problems.slice(0, 5)) {
      console.log(`  [#${entry.index}] ${entry.problems.join("; ")}`);
    }
  }
  console.log();

  console.log("=== Distribution (actual vs target) ===");
  for (const field of ["seniority", "source", "status"]) {
    console.log(`  ${field}:`);
    for (const row of distribution[field]) {
      console.log(
        `    ${row.label.padEnd(18)} ${String(row.actual).padStart(4)}  ` +
          `${pct(row.actualShare)} (target ${pct(row.targetShare)})`,
      );
    }
  }
  console.log();

  console.log("=== littleDB ingestion ===");
  if (ingestion.reachable) {
    console.log(`flush: ${ingestion.flushOk ? "ok" : "failed"}`);
    console.log(`tagged runs in engine: ${ingestion.taggedRuns}`);
    console.log(`saw hiring-post run: ${ingestion.sawPostRun} | candidate root: ${ingestion.sawCandidateRoot}`);
    console.log(`candidate trace children (sub-runs): ${ingestion.traceChildren}`);
    console.log(`search "${ingestion.searchTerm}": ${ingestion.searchHits}${ingestion.searchCapped ? "+" : ""} hit(s)`);
  } else {
    console.log(`engine unreachable: ${ingestion.error ?? "unknown"}`);
    console.log("(events still committed durably; backfill with `littledb import` later.)");
  }
  console.log();

  console.log("=== SDK performance ===");
  console.log(`Wall-clock: ${(elapsedMs / 1000).toFixed(1)}s`);
  // NOTE: planner steps run as separate `run_planner_*` sub-runs (v4-pro,
  // thinking on). Their tokens are committed durably to littleDB but are not
  // summed here, so this subtotal undercounts the true reasoning cost.
  console.log(
    `Tokens — orchestrator+post in/out: ${orchestratorUsage.inputTokens}/${orchestratorUsage.outputTokens}, ` +
      `candidate workers in/out: ${workerUsage.inputTokens}/${workerUsage.outputTokens}, ` +
      `subtotal: ${totalTokens} (excludes planner sub-runs)`,
  );
  console.log(`Event types: ${Object.keys(eventSummary.byType).join(", ")}`);
  console.log(`Tool-call failures: ${eventSummary.toolFailures} | fixer invocations: ${eventSummary.fixerInvocations}`);
  console.log();

  console.log("=== Output files ===");
  console.log(`  ${join(outDir, "fake_candidates.json")}`);
  console.log(`  ${join(outDir, "hiring_post.md")}`);
  console.log(`  ${join(outDir, "candidate_summary.csv")}`);
  console.log(`Mode: ${useStub ? "stub (keyless)" : "live (DeepSeek)"}`);
}

function pct(share) {
  return `${(share * 100).toFixed(1)}%`;
}

// ---------------------------------------------------------------------------
// Minimal .env.local loader (searches demo dir, worktree root, main repo root).
// ---------------------------------------------------------------------------

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
