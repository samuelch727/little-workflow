/**
 * ticket-factory — autonomous coordinator from a markdown spec.
 *
 *   node run.mjs [count]        live DeepSeek run (default count = 20)
 *   node run.mjs stub [count]   keyless deterministic smoke run
 *
 * Hands the raw task markdown to a fully autonomous orchestrator (DeepSeek via
 * the SDK's bash harness). The orchestrator plans the support.ticket.batch
 * workflow once and fans out run_workflow across batches. The generated tickets
 * are harvested from the durable event log, renumbered, validated, and written
 * to support_tickets_fake.json + support_tickets_answer_key.csv.
 *
 * Requires DEEPSEEK_API_KEY (read from env or ../../.env.local) for live runs.
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
  localWorld,
  model,
  runWorkflow,
} from "little-workflow";

import {
  batchInputSchema,
  ticketArraySchema,
} from "./ticket-schema.mjs";
import {
  BATCH_WORKFLOW_ID,
  ORCHESTRATOR_SYSTEM_PROMPT,
  PLANNER_SYSTEM_PROMPT,
  buildOrchestratorInput,
  computeBatchPlan,
} from "./orchestrator-prompt.mjs";
import {
  collectTickets,
  distributionReport,
  harvestRunWorkflowResults,
  renumberTickets,
  summarizeEvents,
  sumUsageFromEvents,
  toAnswerKeyCsv,
  validateDataset,
} from "./eval.mjs";
import {
  buildDeterministicTickets,
  stubOrchestratorHarness,
  stubPlannerHarness,
} from "./stub.mjs";

const here = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Guard: only run when invoked directly.
// ---------------------------------------------------------------------------

const isDirectRun = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (isDirectRun) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  });
}

async function main() {
  const args = process.argv.slice(2);
  const useStub = args[0] === "stub";
  const countArg = useStub ? args[1] : args[0];
  const ticketCount = Number(countArg ?? process.env.TICKET_COUNT ?? 20);
  if (!Number.isInteger(ticketCount) || ticketCount < 1) {
    throw new Error(`Invalid ticket count: ${countArg}`);
  }
  const batchSize = Number(process.env.TICKET_BATCH_SIZE ?? 10);
  const maxConcurrentSubRuns = Number(process.env.MAX_CONCURRENT_SUBRUNS ?? 4);
  // Retry transient worker failures (e.g. DeepSeek AI_APICallError "Failed to
  // process successful response") instead of failing the batch on the first hit.
  const maxAttempts = Number(process.env.WORKER_MAX_ATTEMPTS ?? 3);
  // A coordinator session can die on a transient model-call error; retry it a
  // few times so one blip does not abort the whole run.
  const sessionAttempts = Number(process.env.SESSION_MAX_ATTEMPTS ?? 3);
  // A single orchestrator session feeds every batch's output back into its
  // context, so a large total would overflow the model window and the 32-turn
  // budget. Split the total across sequential coordinator sessions of at most
  // `sessionChunk` tickets each; results are merged and renumbered globally.
  const sessionChunk = Number(process.env.SESSION_CHUNK ?? Math.min(ticketCount, 100));

  if (!useStub) {
    await loadDotEnvLocal();
    if (!process.env.DEEPSEEK_API_KEY) {
      console.error("Set DEEPSEEK_API_KEY (or use `node run.mjs stub`).");
      process.exit(1);
    }
  }

  const goal = await readFile(join(here, "spec", "task.md"), "utf8");
  const sessions = computeBatchPlan(ticketCount, sessionChunk);
  const liveSetup = useStub ? undefined : buildLiveSetup();

  console.log(`# ticket-factory [${useStub ? "stub" : "live"}]`);
  console.log(
    `Tickets requested: ${ticketCount} | batch size: ${batchSize} | ` +
      `sessions: ${sessions.length} (chunk ${sessionChunk})`,
  );
  console.log(`Max concurrent sub-runs: ${maxConcurrentSubRuns} | worker maxAttempts: ${maxAttempts}`);
  if (liveSetup !== undefined) {
    console.log(
      `Models: orchestrator/planner=${liveSetup.modelInfo.reasoning} (thinking on), ` +
        `worker=${liveSetup.modelInfo.worker} (thinking off)`,
    );
  }
  console.log();

  const world = localWorld({
    dataDir: join(here, ".little-workflow-ticket-factory"),
    maxConcurrentSteps: maxConcurrentSubRuns,
  });

  const startedAt = Date.now();
  const allRunResults = [];
  const rawTickets = [];
  const orchestratorUsage = { inputTokens: 0, outputTokens: 0 };
  const workerUsage = { inputTokens: 0, outputTokens: 0 };
  const sessionSummaries = [];
  const eventSummary = { byType: {}, fixerInvocations: 0, toolFailures: 0 };
  let totalBatchesPlanned = 0;

  // Run one coordinator session (with transient-failure retries), harvesting
  // tickets + usage from the committed event log.
  const runSession = async (session, index) => {
    const sessionCount = session.count;
    const setup = useStub ? buildStubSetup({ ticketCount: sessionCount, batchSize }) : liveSetup;

    let result;
    let lastRunId;
    for (let attempt = 1; attempt <= sessionAttempts; attempt += 1) {
      lastRunId = `run_demo_ticket_factory_${useStub ? "stub" : "live"}_s${index + 1}_a${attempt}_${Date.now()}`;
      try {
        result = await runWorkflow({
          world,
          workflows: [setup.workflow],
          orchestrator: { ...setup.orchestrator, maxConcurrentSubRuns },
          input: buildOrchestratorInput({ goal, totalTicketCount: sessionCount, batchSize }),
          tools: setup.tools,
          maxAttempts,
          runId: lastRunId,
        });
        break;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Session ${index + 1} attempt ${attempt}/${sessionAttempts} failed: ${message}`);
        result = undefined;
      }
    }
    if (result !== undefined && result.status !== "completed") {
      console.error(`Session ${index + 1} status: ${result.status}`);
    }

    // Prefer the successful result's events; otherwise salvage the last
    // attempt's committed event log from disk.
    const events = result?.events ?? await listEvents(world, lastRunId).catch(() => []);
    const runResults = harvestRunWorkflowResults(events);
    const ou = sumUsageFromEvents(events);
    const wu = { inputTokens: 0, outputTokens: 0 };
    for (const runResult of runResults) {
      if (typeof runResult.runId !== "string") continue;
      try {
        const usage = sumUsageFromEvents(await listEvents(world, runResult.runId));
        wu.inputTokens += usage.inputTokens;
        wu.outputTokens += usage.outputTokens;
      } catch {
        // sub-run log may not exist for stub/tool.call paths; ignore.
      }
    }
    const tickets = collectTickets(runResults);
    const completed = runResults.filter((r) => r.status === "completed").length;
    console.log(
      `   session ${index + 1}: ${tickets.length} tickets, ${completed}/${runResults.length} sub-runs ok | ` +
        `tokens — coordinator in/out ${ou.inputTokens}/${ou.outputTokens}, ` +
        `workers in/out ${wu.inputTokens}/${wu.outputTokens}`,
    );
    return {
      batchesPlanned: computeBatchPlan(sessionCount, batchSize).length,
      runResults,
      tickets,
      orchestratorUsage: ou,
      workerUsage: wu,
      summary: result?.output ?? `session ${index + 1} did not complete`,
      events: summarizeEvents(events),
    };
  };

  // Sessions run in parallel (bounded), so worker fan-out across the whole job
  // can use the configured concurrency rather than one session at a time.
  const sessionConcurrency = Number(process.env.SESSION_CONCURRENCY ?? sessions.length);
  console.log(`Coordinator-session concurrency: ${Math.min(sessionConcurrency, sessions.length)}`);
  console.log();
  const outcomes = await mapWithConcurrency(sessions, sessionConcurrency, runSession);

  for (const outcome of outcomes) {
    totalBatchesPlanned += outcome.batchesPlanned;
    allRunResults.push(...outcome.runResults);
    for (const ticket of outcome.tickets) rawTickets.push(ticket);
    orchestratorUsage.inputTokens += outcome.orchestratorUsage.inputTokens;
    orchestratorUsage.outputTokens += outcome.orchestratorUsage.outputTokens;
    workerUsage.inputTokens += outcome.workerUsage.inputTokens;
    workerUsage.outputTokens += outcome.workerUsage.outputTokens;
    sessionSummaries.push(outcome.summary);
    eventSummary.fixerInvocations += outcome.events.fixerInvocations;
    eventSummary.toolFailures += outcome.events.toolFailures;
    for (const [type, count] of Object.entries(outcome.events.byType)) {
      eventSummary.byType[type] = (eventSummary.byType[type] ?? 0) + count;
    }
  }

  const elapsedMs = Date.now() - startedAt;
  const tickets = renumberTickets(rawTickets);

  // Write deliverables.
  const outDir = join(here, "out");
  await mkdir(outDir, { recursive: true });
  const jsonPath = join(outDir, "support_tickets_fake.json");
  const csvPath = join(outDir, "support_tickets_answer_key.csv");
  await writeFile(jsonPath, JSON.stringify(tickets, null, 2) + "\n", "utf8");
  await writeFile(csvPath, toAnswerKeyCsv(tickets), "utf8");

  const totalTokens =
    orchestratorUsage.inputTokens +
    orchestratorUsage.outputTokens +
    workerUsage.inputTokens +
    workerUsage.outputTokens;

  printReport({
    ticketCount,
    sessions: sessions.length,
    totalBatchesPlanned,
    runResults: allRunResults,
    tickets,
    validation: validateDataset(tickets),
    distribution: distributionReport(tickets),
    eventSummary,
    orchestratorUsage,
    workerUsage,
    totalTokens,
    elapsedMs,
    jsonPath,
    csvPath,
    coordinatorSummary: sessionSummaries.length === 1
      ? sessionSummaries[0]
      : `${sessionSummaries.length} coordinator sessions completed`,
  });
}

// ---------------------------------------------------------------------------
// Live setup (DeepSeek via SDK bash harness for all three roles).
// ---------------------------------------------------------------------------

function buildLiveSetup() {
  // Reasoning model for the roles that plan/coordinate; fast cheap model for the
  // parallel worker agents that just generate ticket content.
  const reasoningModelId = process.env.DEEPSEEK_MODEL_ID ?? "deepseek-v4-pro";
  const workerModelId = process.env.DEEPSEEK_WORKER_MODEL_ID ?? "deepseek-v4-flash";
  const baseURL = process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com/v1";
  const provider = createDeepSeek({
    apiKey: process.env.DEEPSEEK_API_KEY,
    baseURL,
    headers: { "accept-encoding": "identity" },
  });

  // Orchestrator + planner: pro model with thinking ON (they reason about how to
  // decompose the spec and design the LWIR).
  const reasoningModel = ai.wrapLanguageModel({
    model: provider(reasoningModelId),
    middleware: ai.defaultSettingsMiddleware({
      settings: {
        // Extra retries absorb DeepSeek's transient "Failed to process
        // successful response" hiccups on the coordinator/planner calls.
        maxRetries: 5,
        providerOptions: {
          deepseek: { thinking: { type: "enabled" }, reasoningEffort: "high" },
        },
      },
    }),
  });

  // Worker agents: flash model with thinking OFF (bulk content generation; cheap
  // + fast, run in parallel).
  const workerModel = ai.wrapLanguageModel({
    model: provider(workerModelId),
    middleware: ai.defaultSettingsMiddleware({
      settings: {
        maxRetries: 5,
        providerOptions: { deepseek: { thinking: { type: "disabled" } } },
      },
    }),
  });

  const workerSlot = model(workerModel, {
    id: "model.worker",
    description: "DeepSeek v4 flash worker (thinking off) that generates ticket batches.",
  });

  const workflow = createLittleWorkflow({
    id: BATCH_WORKFLOW_ID,
    description:
      "Generate one batch of realistic fake CloudDesk support tickets as a JSON array.",
    inputSchema: batchInputSchema,
    output: { kind: "array", element: ticketArraySchema.items },
    models: [workerSlot],
    planner: {
      model: reasoningModel,
      harness: createWorkflowHarness({ aiSdkModule: ai }),
      system: PLANNER_SYSTEM_PROMPT,
    },
    worker: { harness: createWorkflowHarness({ aiSdkModule: ai }) },
  });

  return {
    workflow,
    tools: createToolRegistry({}),
    orchestrator: {
      model: reasoningModel,
      harness: createWorkflowHarness({ aiSdkModule: ai }),
      system: ORCHESTRATOR_SYSTEM_PROMPT,
    },
    modelInfo: { reasoning: reasoningModelId, worker: workerModelId },
  };
}

// ---------------------------------------------------------------------------
// Stub setup (keyless, deterministic).
// ---------------------------------------------------------------------------

function buildStubSetup({ ticketCount, batchSize }) {
  const generateBatchTool = tool({
    description: "Deterministically generate a batch of fake tickets.",
    inputSchema: batchInputSchema,
    outputSchema: ticketArraySchema,
    execute: async ({ count, startIndex }) =>
      buildDeterministicTickets({ count: Number(count) || 0, startIndex: Number(startIndex) || 1 }),
  });

  const stubWorkerSlot = model(
    { provider: "stub", modelId: "stub-worker" },
    { id: "model.worker", description: "Unused stub model slot (tool.call path)." },
  );

  const workflow = createLittleWorkflow({
    id: BATCH_WORKFLOW_ID,
    description: "Deterministic keyless ticket batch generator.",
    inputSchema: batchInputSchema,
    output: { kind: "array", element: ticketArraySchema.items },
    models: [stubWorkerSlot],
    planner: {
      model: { provider: "stub", modelId: "stub-planner" },
      harness: stubPlannerHarness(),
    },
    globalTools: ["generate_batch"],
    worker: { harness: createWorkflowHarness() },
  });

  return {
    workflow,
    tools: createToolRegistry({ generate_batch: generateBatchTool }),
    orchestrator: {
      model: { provider: "stub", modelId: "stub-orchestrator" },
      harness: stubOrchestratorHarness({ ticketCount, batchSize }),
    },
  };
}

// ---------------------------------------------------------------------------
// Reporting.
// ---------------------------------------------------------------------------

function printReport(report) {
  const {
    ticketCount,
    sessions,
    totalBatchesPlanned,
    runResults,
    tickets,
    validation,
    distribution,
    eventSummary,
    orchestratorUsage,
    workerUsage,
    totalTokens,
    elapsedMs,
    jsonPath,
    csvPath,
    coordinatorSummary,
  } = report;

  console.log("=== Coordinator summary ===");
  console.log(JSON.stringify(coordinatorSummary, null, 2));
  console.log();

  const completedRuns = runResults.filter((r) => r.status === "completed").length;
  console.log("=== Fan-out ===");
  console.log(`Coordinator sessions: ${sessions}`);
  console.log(`Batches planned: ${totalBatchesPlanned}`);
  console.log(`sub-run calls: ${runResults.length} (completed: ${completedRuns})`);
  console.log();

  console.log("=== Dataset ===");
  console.log(`Tickets produced: ${tickets.length} / ${ticketCount} requested`);
  console.log(
    `Schema-valid: ${validation.validCount}/${validation.total} ` +
      `(${pct(validation.total === 0 ? 0 : validation.validCount / validation.total)})`,
  );
  if (validation.invalidCount > 0) {
    console.log(`Invalid tickets: ${validation.invalidCount}. First problems:`);
    for (const entry of validation.problems.slice(0, 5)) {
      console.log(`  [#${entry.index}] ${entry.problems.join("; ")}`);
    }
  }
  console.log(`IDs unique: ${new Set(tickets.map((t) => t.ticket_id)).size === tickets.length}`);
  console.log();

  console.log("=== Distribution (actual vs target) ===");
  for (const field of ["category", "urgency", "sentiment"]) {
    console.log(`  ${field}:`);
    for (const row of distribution[field]) {
      console.log(
        `    ${row.label.padEnd(18)} ${String(row.actual).padStart(4)}  ` +
          `${pct(row.actualShare)} (target ${pct(row.targetShare)})`,
      );
    }
  }
  console.log();

  console.log("=== SDK performance ===");
  console.log(`Wall-clock: ${(elapsedMs / 1000).toFixed(1)}s`);
  console.log(
    `Tokens — orchestrator in/out: ${orchestratorUsage.inputTokens}/${orchestratorUsage.outputTokens}, ` +
      `workers in/out: ${workerUsage.inputTokens}/${workerUsage.outputTokens}, total: ${totalTokens}`,
  );
  if (tickets.length > 0) {
    console.log(`Tokens per ticket: ${(totalTokens / tickets.length).toFixed(0)}`);
  }
  console.log(`Fixer invocations: ${eventSummary.fixerInvocations}`);
  console.log(`Tool-call failures (orchestrator): ${eventSummary.toolFailures}`);
  console.log(`Orchestrator event types: ${Object.keys(eventSummary.byType).join(", ")}`);
  console.log();

  console.log("=== Output files ===");
  console.log(`  ${jsonPath}`);
  console.log(`  ${csvPath}`);
}

function pct(share) {
  return `${(share * 100).toFixed(1)}%`;
}

/**
 * Map over items with a bounded number of concurrent workers, preserving order.
 *
 * @template T, R
 * @param {readonly T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const poolSize = Math.max(1, Math.min(limit || 1, items.length));
  const workers = Array.from({ length: poolSize }, async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) break;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// Minimal .env.local loader (no dependency).
// ---------------------------------------------------------------------------

async function loadDotEnvLocal() {
  if (process.env.DEEPSEEK_API_KEY) return;
  const candidates = [
    join(here, ".env.local"),
    join(here, "..", "..", ".env.local"),
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
