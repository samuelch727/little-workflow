#!/usr/bin/env node
/**
 * The support-desk experiment driver.
 *
 *   node experiment/run.mjs --seed              # fresh episode area, nothing else
 *   node experiment/run.mjs --traffic           # optimizer set on prompt v1: traced, graded, scored
 *   node experiment/run.mjs --gate --k 3        # gate set, measurement only, pass^k
 *   node experiment/run.mjs --dataset           # upload both sets as a LittleDB dataset
 *   node experiment/run.mjs --worker [--once]   # run LittleDB experiments (gate runs) here
 *   node experiment/run.mjs --propose <file>    # propose a prompt as a new version
 *   node experiment/run.mjs --status            # versions, proposals and datasets in LittleDB
 *
 * Flags: --limit <n>, --only <id,id,...>, --k <n>, --baseline <results.json>,
 *        --concurrency <n> (worker), --model <slot> (propose), --name <dataset>.
 *
 * Environment: LITTLEDB_URL (default http://127.0.0.1:7340), LITTLEDB_API_KEY (required),
 * LITTLEDB_HARNESS (default support-desk), LITTLEDB_CHANNEL (default production).
 *
 * The difference between the first two modes is the point of the whole file:
 *
 *   --traffic  runs the OPTIMIZER set, resolves each session's version, sends every episode
 *              to LittleDB as a trace and scores it. These episodes become the history a
 *              reviewer reads.
 *   --gate     runs the GATE set, scores nothing and traces nothing. A gate episode that
 *              reached LittleDB would become training signal for the next proposal, and the
 *              set that judges a change would be the set the change was tuned on
 *              (`evals-research-synthesis-2026-08.md` §7). The silence is enforced by never
 *              creating a tracer rather than by a flag someone can forget.
 *
 * `--dataset` uploads the gate set as the `holdout` split and the optimizer set as `dev`:
 * LittleDB gates a proposal on the holdout split, and its reviewer only ever sees dev items.
 * `--worker` is the in-app eval worker that runs those gate experiments with the real tools.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { aggregate, askGranted, gradeEpisode, readEpisode, wilsonInterval } from "./grade.mjs";

const experimentDir = dirname(fileURLToPath(import.meta.url));
const demoRoot = resolve(experimentDir, "..");
// `little-harness`'s module loader roots jiti at `process.cwd()` so an agent's bare imports
// resolve against the demo's node_modules. Run from the demo root, or nothing resolves.
process.chdir(demoRoot);

const episodesRoot = join(demoRoot, ".episodes");
const resultsDir = join(experimentDir, ".results");
const seedFile = join(demoRoot, "seed-data", "db.json");
const dataDir = join(demoRoot, ".little-harness");

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const value = (flag) => {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
};

// ── environment ────────────────────────────────────────────────────────────────────────
// Set before ANY agent module loads: `littledb.ts` reads these when it first runs.
const LITTLEDB_URL = process.env.LITTLEDB_URL || "http://127.0.0.1:7340";
const HARNESS = process.env.LITTLEDB_HARNESS ?? "support-desk";
const CHANNEL = process.env.LITTLEDB_CHANNEL ?? "production";
const SUBJECT = `harness:${HARNESS}`;
process.env.LITTLEDB_URL = LITTLEDB_URL;
process.env.LITTLEDB_HARNESS = HARNESS;
process.env.LITTLEDB_CHANNEL = CHANNEL;

/**
 * `--traffic` and `--dataset` seed LittleDB with the deliberately-flawed v1 (the first resolve
 * of a harness stores its bootstrap as version 1). `--gate` must NOT: the version under test
 * has to come back from LittleDB, or the gate is measuring a local file and the whole
 * before/after is theatre.
 */
if (has("--traffic") || has("--dataset")) {
  process.env.SUPPORT_PROMPT_FILE ??= "experiment/prompt-v1.md";
} else {
  delete process.env.SUPPORT_PROMPT_FILE;
}

// ── helpers ────────────────────────────────────────────────────────────────────────────

const heading = (text) => console.log(`\n=== ${text} ===`);
const pct = (value) => `${Math.round(value * 1000) / 10}%`;

/** Hard-fail rather than silently running with no versions, no traces and no scores. */
async function requireStack() {
  const base = LITTLEDB_URL.replace(/\/+$/u, "").replace(/\/v1$/u, "");
  let up = false;
  try {
    up = (await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(5_000) })).ok;
  } catch {
    up = false;
  }
  console.log(`LittleDB ${base}: ${up ? "up" : "UNREACHABLE"}`);
  if (!up) {
    throw new Error(
      "LittleDB is not reachable. Without it there is no version to run and nowhere to send " +
        "traces and scores: the run would burn model calls on an experiment that never happened.",
    );
  }
  if (!process.env.LITTLEDB_API_KEY) {
    throw new Error("Set LITTLEDB_API_KEY (`littledb dev` prints a key for local apps).");
  }
}

function loadScenarios(mode) {
  const file = mode === "gate" ? "gate-truth.json" : "optimizer-truth.json";
  const parsed = JSON.parse(readFileSync(join(experimentDir, file), "utf8"));
  let scenarios = parsed.scenarios;
  const only = value("--only");
  if (only !== undefined) {
    const wanted = new Set(only.split(",").map((id) => id.trim()));
    scenarios = scenarios.filter((scenario) => wanted.has(scenario.id));
    const missing = [...wanted].filter((id) => !scenarios.some((s) => s.id === id));
    if (missing.length > 0) throw new Error(`unknown scenario id(s): ${missing.join(", ")}`);
  }
  const limit = value("--limit");
  if (limit !== undefined) scenarios = scenarios.slice(0, Number(limit));
  if (scenarios.length === 0) throw new Error("no scenarios selected");
  return { file, scenarios };
}

function jitiFor() {
  return createJiti(join(demoRoot, "_experiment_root_.js"), { interopDefault: false });
}

async function agentModules() {
  const jiti = jitiFor();
  const [episode, littledb] = await Promise.all([
    jiti.import(join(demoRoot, "agents", "support", "run-episode.ts")),
    jiti.import(join(demoRoot, "agents", "support", "littledb.ts")),
  ]);
  return { ...episode, ...littledb };
}

// ── phases ─────────────────────────────────────────────────────────────────────────────

function seed() {
  heading("seed");
  rmSync(episodesRoot, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(episodesRoot, { recursive: true });
  const db = JSON.parse(readFileSync(seedFile, "utf8"));
  console.log(`episode area reset: ${episodesRoot}`);
  console.log(`harness sessions reset: ${dataDir}`);
  console.log(
    `seed: ${db.orders.length} orders, ${db.customers.length} customers, ` +
      `${db.refunds.length} existing refund(s), clock ${db.asOf}`,
  );
  console.log("\nNext: node experiment/verify-truth.mjs, then node experiment/run.mjs --traffic");
}

/**
 * One scenario, once: run the episode, grade it, return the record. With `version` and
 * `tracer` it runs the version an eval worker was handed, into the experiment run's trace.
 */
async function runOne({ modules, scenario, seedDb, sessionId, episodeDir, telemetry, version, tracer, trial }) {
  const episode = await modules.runEpisode({
    sessionId,
    episodeDir,
    turns: scenario.turns,
    telemetry,
    ...(version === undefined ? {} : { version }),
    ...(tracer === undefined ? {} : { tracer }),
    // Scripted pushback is withheld once the customer's ask HAS been granted: nobody argues
    // with an agent that just did what they wanted, and a transcript full of manufactured
    // frustration would poison both the scores and LittleDB's pushback detector.
    shouldSendTurn: () => {
      const { db } = readEpisode(episodeDir);
      return !askGranted(scenario, seedDb, db);
    },
  });

  const { db, actions } = readEpisode(episodeDir);
  const { task, policy } = gradeEpisode({ scenario, seed: seedDb, db, actions });

  return {
    id: scenario.id,
    tier: scenario.tier,
    kind: scenario.kind,
    trial: trial ?? 1,
    sessionId,
    traceId: episode.traceId,
    episodeDir,
    versionId: episode.versionId,
    taskSuccess: task.pass,
    policyCompliant: policy.pass,
    taskFailures: task.checks.filter((check) => !check.ok).map((check) => `${check.name}: ${check.detail}`),
    policyFailures: policy.failed,
    ruleVerdicts: Object.fromEntries(policy.rules.map((rule) => [rule.id, rule.status])),
    toolCalls: episode.toolCalls,
    turnsRun: episode.turns.length,
    pushbackFired: episode.turns.length > 1,
    pushbackWithheld: episode.turnsWithheld,
    scored: false,
    transcript: episode.turns,
  };
}

async function runSet(mode) {
  const k = Number(value("--k") ?? 1);
  heading(`${mode}: preflight`);
  await requireStack();
  const { file, scenarios } = loadScenarios(mode);
  console.log(`harness: ${HARNESS} (channel ${CHANNEL})`);
  console.log(`scenario set: experiment/${file} — ${scenarios.length} scenario(s)`);
  console.log(`bootstrap prompt: ${process.env.SUPPORT_PROMPT_FILE ?? "(none — the live version only)"}`);
  console.log(
    mode === "gate"
      ? `traces: OFF, scores: NONE (sealed gate), trials per scenario: ${k}`
      : "traces: ON, scores: task_success + policy_compliance for tiers A and B (C scores nothing)",
  );

  const seedDb = JSON.parse(readFileSync(seedFile, "utf8"));
  const modules = await agentModules();
  const db = modules.supportLittleDb();
  const runStamp = Date.now().toString(36);
  const records = [];

  heading(`${mode}: episodes`);
  try {
    for (const [index, scenario] of scenarios.entries()) {
      for (let trial = 1; trial <= (mode === "gate" ? k : 1); trial += 1) {
        const label = `[${index + 1}/${scenarios.length}${k > 1 && mode === "gate" ? ` k${trial}` : ""}] ${scenario.id} (tier ${scenario.tier}, ${scenario.kind})`;
        process.stdout.write(`${label} … `);
        const suffix = mode === "gate" && k > 1 ? `-k${trial}` : "";
        const record = await runOne({
          modules,
          scenario,
          seedDb,
          sessionId: `sd-${scenario.id}${suffix}-${runStamp}`,
          episodeDir: join(episodesRoot, `${mode}-${runStamp}`, `${scenario.id}${suffix}`),
          telemetry: mode !== "gate",
          ...(mode === "gate" && k > 1 ? { trial } : {}),
        });

        // Scores are the graded verdict, on the episode's trace. Tier C sends none, on
        // purpose: its failures exist only in the conversation text, and whether a reviewer
        // can read them there is the question that tier is asking.
        if (mode !== "gate" && scenario.reaction === "auto" && record.traceId !== null) {
          record.scored = modules.scoreEpisode({
            traceId: record.traceId,
            taskSuccess: record.taskSuccess,
            policyCompliant: record.policyCompliant,
            taskFailures: record.taskFailures,
            policyFailures: record.policyFailures,
          });
        }

        records.push(record);
        console.log(
          `task ${record.taskSuccess ? "PASS" : "FAIL"} / policy ${record.policyCompliant ? "PASS" : "FAIL"}` +
            `${record.pushbackFired ? ` +${record.turnsRun - 1} pushback` : ""}` +
            `${record.scored ? " → scored" : ""}`,
        );
        if (records.length === 1) await warnIfBootstrapDrifted(record, db);
      }
    }
  } finally {
    await db?.shutdown();
  }

  const summary = summarize(records, mode, k);
  printVerdicts(records);
  printTables(summary, mode);
  printRuleFailures(records);
  const file2 = persist(summary, records, mode);
  console.log(`\nresults: ${file2}`);
  if (mode !== "gate" && records.some((record) => record.traceId !== null)) {
    console.log(`traces: one per episode in LittleDB (${LITTLEDB_URL}), ids sd_<sessionId>`);
  }
  compareToBaseline(records, mode);
  return records;
}

/**
 * LittleDB stores the bootstrap prompt on the FIRST resolve for a harness and ignores it
 * ever after. A later edit to `prompt-v1.md` is therefore a silent no-op, and the run is
 * measuring a prompt nobody is looking at — the whole before/after rests on v1 being what
 * that file says, so this is worth saying out loud rather than discovering afterwards.
 */
async function warnIfBootstrapDrifted(record, db) {
  const promptFile = process.env.SUPPORT_PROMPT_FILE;
  if (promptFile === undefined || record.versionId === null || db === undefined) return;
  const wanted = readFileSync(resolve(demoRoot, promptFile), "utf8").trim();
  const live = (await db.prepareSession(record.sessionId)).content.system;
  if (live === wanted) return;
  console.warn(
    `\n  ⚠ the live version (${record.versionId}) does NOT match ${promptFile}.\n` +
      "    LittleDB stores the bootstrap once per harness and ignores it afterwards,\n" +
      "    so this run is NOT on the prompt in that file. Use a fresh LITTLEDB_HARNESS to reseed.\n",
  );
}

function summarize(records, mode, k) {
  return {
    mode,
    startedAt: new Date().toISOString(),
    harness: HARNESS,
    channel: CHANNEL,
    promptFile: process.env.SUPPORT_PROMPT_FILE ?? null,
    versionIds: [...new Set(records.map((record) => record.versionId).filter(Boolean))],
    ...aggregate(records, { k: mode === "gate" ? k : 1 }),
  };
}

function renderTable(rows) {
  const widths = rows[0].map((_, column) =>
    Math.max(...rows.map((row) => String(row[column]).length)),
  );
  for (const [index, row] of rows.entries()) {
    console.log(row.map((cell, column) => String(cell).padEnd(widths[column])).join("  "));
    if (index === 0) console.log(widths.map((width) => "-".repeat(width)).join("  "));
  }
}

function printVerdicts(records) {
  heading("verdicts");
  renderTable([
    ["id", "tier", "kind", "task", "policy", "turns", "tools", "scored", "first failure"],
    ...records.map((record) => [
      record.trial > 1 ? `${record.id}#${record.trial}` : record.id,
      record.tier,
      record.kind,
      record.taskSuccess ? "PASS" : "FAIL",
      record.policyCompliant ? "PASS" : "FAIL",
      String(record.turnsRun),
      record.toolCalls.join(",") || "(none)",
      record.scored ? "yes" : "-",
      (record.taskFailures[0] ?? record.policyFailures[0] ?? "-").slice(0, 60),
    ]),
  ]);
}

function printTables(summary, mode) {
  heading("by tier");
  renderTable([
    ["tier", "n", "task", "policy", "both"],
    ...Object.entries(summary.tiers).map(([tier, stats]) => [
      tier,
      String(stats.n),
      `${stats.task.pass}/${stats.n} ${pct(stats.task.rate)}`,
      `${stats.policy.pass}/${stats.n} ${pct(stats.policy.rate)}`,
      `${stats.both.pass}/${stats.n} ${pct(stats.both.rate)}`,
    ]),
  ]);

  heading("by kind");
  renderTable([
    ["kind", "n", "task", "policy"],
    ...Object.entries(summary.kinds).map(([kind, stats]) => [
      kind,
      String(stats.n),
      `${stats.task.pass}/${stats.n} ${pct(stats.task.rate)}`,
      `${stats.policy.pass}/${stats.n} ${pct(stats.policy.rate)}`,
    ]),
  ]);

  const { overall } = summary;
  heading("overall");
  console.log(
    `task success:      ${overall.task.pass}/${overall.n} = ${pct(overall.task.rate)} ` +
      `(95% Wilson ${pct(overall.taskInterval.low)}–${pct(overall.taskInterval.high)})`,
  );
  console.log(
    `policy compliance: ${overall.policy.pass}/${overall.n} = ${pct(overall.policy.rate)} ` +
      `(95% Wilson ${pct(overall.policyInterval.low)}–${pct(overall.policyInterval.high)})`,
  );
  console.log(`both:              ${overall.both.pass}/${overall.n} = ${pct(overall.both.rate)}`);

  if (summary.passK !== null) {
    const { passK } = summary;
    console.log(
      `\npass^${passK.k} over ${passK.scenarios} scenario(s): ` +
        `task ${passK.task.pass}/${passK.scenarios} = ${pct(passK.task.rate)}, ` +
        `policy ${passK.policy.pass}/${passK.scenarios} = ${pct(passK.policy.rate)}` +
        `${passK.skipped > 0 ? ` (${passK.skipped} scenario(s) had fewer than ${passK.k} trials and were excluded)` : ""}`,
    );
  }

  if (mode === "gate") {
    // Said out loud so a 15-item result is never quoted as a shipping receipt. CLT error
    // bars are wrong this far below a few hundred items, so the honest statement of what
    // this set can resolve is the width of its own interval (Bowyer et al., ICML 2025;
    // Miller, Nov 2024 on minimum detectable effect).
    const half = wilsonInterval(overall.task.pass, overall.n).halfWidth;
    console.log(
      `\nThis gate has ${overall.n} item(s). Its 95% interval is ±${pct(half)}, so it cannot ` +
        `resolve a regression smaller than roughly that — it is a gross-regression gate, not a ` +
        `non-inferiority receipt. Growing it toward 150+ items is what buys a real one.`,
    );
  }
}

function printRuleFailures(records) {
  const counts = {};
  for (const record of records) {
    for (const [rule, status] of Object.entries(record.ruleVerdicts)) {
      if (status === "fail") counts[rule] = (counts[rule] ?? 0) + 1;
    }
  }
  const rows = Object.entries(counts).sort((left, right) => right[1] - left[1]);
  if (rows.length === 0) return;
  heading("policy rules violated");
  renderTable([["rule", "episodes"], ...rows.map(([rule, n]) => [rule, String(n)])]);
}

function persist(summary, records, mode) {
  mkdirSync(resultsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = join(resultsDir, `${mode}-${stamp}.json`);
  writeFileSync(file, `${JSON.stringify({ ...summary, scenarios: records }, null, 2)}\n`);
  return file;
}

function latestResults(mode) {
  const explicit = value("--baseline");
  if (explicit !== undefined) return JSON.parse(readFileSync(resolve(explicit), "utf8"));
  if (!existsSync(resultsDir)) return undefined;
  const files = readdirSync(resultsDir)
    .filter((name) => name.startsWith(`${mode}-`) && name.endsWith(".json"))
    .sort();
  // The newest file is the run that just finished, so the baseline is the one before it.
  const previous = files.at(-2);
  return previous === undefined ? undefined : JSON.parse(readFileSync(join(resultsDir, previous), "utf8"));
}

function compareToBaseline(records, mode) {
  const baseline = latestResults(mode);
  if (baseline === undefined) return;
  heading("before / after");
  const before = new Map(baseline.scenarios.map((record) => [`${record.id}#${record.trial}`, record]));
  const rows = [["id", "tier", "task", "policy"]];
  let beforeTask = 0;
  let afterTask = 0;
  let beforePolicy = 0;
  let afterPolicy = 0;
  let compared = 0;
  for (const record of records) {
    const prior = before.get(`${record.id}#${record.trial}`);
    if (prior === undefined) continue;
    compared += 1;
    if (prior.taskSuccess) beforeTask += 1;
    if (record.taskSuccess) afterTask += 1;
    if (prior.policyCompliant) beforePolicy += 1;
    if (record.policyCompliant) afterPolicy += 1;
    const change = (was, now) => (was === now ? "=" : now ? "FIXED" : "REGRESSED");
    rows.push([
      record.id,
      record.tier,
      `${prior.taskSuccess ? "PASS" : "FAIL"} → ${record.taskSuccess ? "PASS" : "FAIL"} ${change(prior.taskSuccess, record.taskSuccess)}`,
      `${prior.policyCompliant ? "PASS" : "FAIL"} → ${record.policyCompliant ? "PASS" : "FAIL"} ${change(prior.policyCompliant, record.policyCompliant)}`,
    ]);
  }
  if (compared === 0) {
    console.log("(no comparable scenarios in the baseline)");
    return;
  }
  renderTable(rows);
  console.log(
    `\ntask success      ${beforeTask}/${compared} → ${afterTask}/${compared}` +
      `   policy compliance ${beforePolicy}/${compared} → ${afterPolicy}/${compared}`,
  );
  console.log(`baseline: ${baseline.startedAt} (${baseline.mode}) on version ${(baseline.versionIds ?? []).join(", ") || "n/a"}`);
}

/** The LittleDB client the agent modules use, for the modes that call the API directly. */
async function littleDb(modules) {
  const handle = modules.supportLittleDb();
  if (handle === undefined) throw new Error("Set LITTLEDB_URL.");
  return handle;
}

/** Make sure the harness exists in LittleDB (the first resolve stores the bootstrap as v1). */
async function ensureHarness(modules, handle) {
  const resolution = await handle.db.resolve({ kind: "harness", slug: HARNESS, channel: CHANNEL, bootstrap: modules.bootstrapContent() });
  if (resolution.fallback !== undefined) throw new Error(`LittleDB could not resolve ${SUBJECT}: ${resolution.error}`);
  return resolution;
}

/**
 * A scenario as a dataset item: what the customer says is the input; everything the grader
 * needs is the expectation. The worker puts them back together.
 */
function scenarioItem(scenario, set) {
  const { turns, ...truth } = scenario;
  return {
    input: { id: scenario.id, turns },
    expected: truth,
    metadata: { scenarioId: scenario.id, tier: scenario.tier, kind: scenario.kind, set },
    split: set === "gate" ? "holdout" : "dev",
  };
}

function scenarioFromItem(item) {
  const input = item?.input;
  if (input === null || typeof input !== "object" || !Array.isArray(input.turns)) {
    throw new Error(`Dataset item ${item?.id ?? "?"} is not a support-desk scenario (no turns).`);
  }
  return { ...(item.expected ?? {}), ...input };
}

async function dataset() {
  heading("dataset: preflight");
  await requireStack();
  const modules = await agentModules();
  const handle = await littleDb(modules);
  const name = value("--name") ?? `${HARNESS}-scenarios`;
  try {
    const resolution = await ensureHarness(modules, handle);
    console.log(`harness: ${HARNESS} (live version ${resolution.number ?? "none"})`);
    const { datasets } = await handle.db.request("GET", "/datasets");
    const existing = datasets.find((entry) => entry.name === name);
    if (existing !== undefined) {
      console.log(`dataset "${name}" already exists (${existing.id}); nothing uploaded. Use --name for another.`);
      return;
    }
    const read = (file) => JSON.parse(readFileSync(join(experimentDir, file), "utf8")).scenarios;
    const gate = read("gate-truth.json").map((scenario) => scenarioItem(scenario, "gate"));
    const optimizer = read("optimizer-truth.json").map((scenario) => scenarioItem(scenario, "optimizer"));
    const { dataset: created } = await handle.db.request("POST", "/datasets", {
      name,
      subject: SUBJECT,
      description: "Support-desk scenarios. holdout: the sealed gate set; dev: the optimizer set a reviewer may read.",
    });
    const added = await handle.db.request("POST", `/datasets/${created.id}/items`, { items: [...gate, ...optimizer] });
    heading("dataset");
    console.log(`dataset "${name}" (${created.id}) for ${SUBJECT}`);
    console.log(`items: ${added.added} — holdout ${added.holdout} (gate set), dev ${added.added - added.holdout} (optimizer set)`);
    console.log("A proposal for this harness is now gated on the holdout split; run --worker to execute it.");
  } finally {
    await handle.shutdown();
  }
}

async function worker() {
  heading("worker: preflight");
  await requireStack();
  const modules = await agentModules();
  const handle = await littleDb(modules);
  const seedDb = JSON.parse(readFileSync(seedFile, "utf8"));
  const stamp = Date.now().toString(36);
  const concurrency = Number(value("--concurrency") ?? 1);
  console.log(`runs experiments for ${SUBJECT}, ${concurrency} at a time${has("--once") ? ", until none are left" : " (Ctrl-C to stop)"}`);

  const evalWorker = handle.db.evalWorker({
    subjects: [SUBJECT],
    concurrency,
    run: async (run) => {
      const scenario = scenarioFromItem(run.item);
      const content = modules.versionContent(run.version?.content);
      const tracer = handle.db.harnessTracer({ harness: HARNESS, name: "episode", ...run.trace });
      const record = await runOne({
        modules,
        scenario,
        seedDb,
        sessionId: `sd-${scenario.id}-${run.runId}`,
        episodeDir: join(episodesRoot, `worker-${stamp}`, `${scenario.id}-${run.runId}`),
        telemetry: true,
        version: { content, versionId: run.version?.id ?? null },
        tracer: { onEvent: tracer.onEvent, traceId: run.traceId },
      });
      console.log(
        `${run.experimentId} v${run.version?.number ?? "?"} ${scenario.id}: ` +
          `task ${record.taskSuccess ? "PASS" : "FAIL"} / policy ${record.policyCompliant ? "PASS" : "FAIL"}`,
      );
      const comment = (failures) => (failures.length === 0 ? {} : { comment: failures.join("; ").slice(0, 10_000) });
      return {
        output: { reply: record.transcript.at(-1)?.assistant ?? "", toolCalls: record.toolCalls, turns: record.turnsRun },
        scores: [
          { name: "task_success", value: record.taskSuccess ? 1 : 0, ...comment(record.taskFailures) },
          { name: "policy_compliance", value: record.policyCompliant ? 1 : 0, ...comment(record.policyFailures) },
        ],
      };
    },
  });

  heading("worker: runs");
  try {
    if (has("--once")) {
      let total = { claimed: 0, completed: 0, failed: 0 };
      for (;;) {
        const round = await evalWorker.runOnce();
        total = { claimed: total.claimed + round.claimed, completed: total.completed + round.completed, failed: total.failed + round.failed };
        if (round.claimed === 0) break;
      }
      console.log(`\nclaimed ${total.claimed}, completed ${total.completed}, failed ${total.failed}`);
    } else {
      const stop = () => void evalWorker.stop();
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      await evalWorker.start();
    }
  } finally {
    await handle.shutdown();
  }
}

async function propose() {
  const file = value("--propose");
  if (file === undefined) throw new Error("--propose needs a prompt file.");
  heading("propose: preflight");
  await requireStack();
  const modules = await agentModules();
  const handle = await littleDb(modules);
  try {
    const resolution = await ensureHarness(modules, handle);
    const system = readFileSync(resolve(demoRoot, file), "utf8").trim();
    const model = value("--model");
    const { proposal } = await handle.db.request("POST", "/proposals", {
      subject: SUBJECT,
      ...(resolution.versionId === null ? {} : { baseVersionId: resolution.versionId }),
      changes: { system, ...(model === undefined ? {} : { model }) },
      title: `Prompt from ${file}`,
      body: `Proposed by experiment/run.mjs --propose ${file}.`,
    });
    heading("propose");
    console.log(`proposal ${proposal.id} (${proposal.status}) for ${SUBJECT}: version ${proposal.candidateVersionId} against v${resolution.number}`);
    console.log("LittleDB starts a gate experiment on the dataset's holdout split; run --worker to execute it.");
  } finally {
    await handle.shutdown();
  }
}

async function status() {
  heading("status");
  await requireStack();
  const modules = await agentModules();
  const handle = await littleDb(modules);
  try {
    const detail = await handle.db.request("GET", `/subjects/${encodeURIComponent(SUBJECT)}`);
    const byId = new Map(detail.versions.map((version) => [version.id, version]));
    for (const release of detail.releases) {
      const live = byId.get(release.liveVersionId);
      const trial = byId.get(release.trialVersionId);
      console.log(
        `channel ${release.channel}: live v${live?.number ?? "-"}` +
          `${trial === undefined ? "" : `, trial v${trial.number} at ${Math.round((release.trialWeight ?? 0) * 100)}%`}`,
      );
    }
    console.log(`versions: ${detail.versions.map((version) => `v${version.number} ${version.status}`).join(", ") || "none"}`);
    for (const proposal of detail.proposals.slice(0, 10)) console.log(`proposal ${proposal.id} ${proposal.status}: ${proposal.title}`);
    for (const entry of detail.datasets) console.log(`dataset ${entry.id}: ${entry.name}`);
  } finally {
    await handle.shutdown();
  }
}

function help() {
  console.log(
    [
      `support-desk experiment driver (LittleDB harness: ${HARNESS})`,
      "",
      "  --seed                  reset the episode area and the harness session store",
      "  --traffic               run the OPTIMIZER set on prompt v1: trace, grade, score, persist",
      "  --gate [--k <n>]        run the GATE set: no scores, no traces, pass^k",
      "  --dataset [--name <n>]  upload the gate set (holdout) and the optimizer set (dev)",
      "  --worker [--once]       run LittleDB experiments for this harness here",
      "  --propose <file>        propose a prompt file as the next version [--model <slot>]",
      "  --status                versions, proposals and datasets in LittleDB",
      "",
      "  --limit <n>             first n scenarios only",
      "  --only <id,...>         named scenarios only",
      "  --baseline <file>       compare against this results file instead of the previous run",
      "  --concurrency <n>       worker runs at once (default 1)",
      "",
      "  LITTLEDB_URL, LITTLEDB_API_KEY, LITTLEDB_HARNESS, LITTLEDB_CHANNEL",
      "  SUPPORT_MODEL_SLOT: deepseek-v4-flash (default), deepseek-v4-pro, claude-haiku-5-5, claude-sonnet-5-5",
      "",
      "  node experiment/verify-truth.mjs   ground the scenarios against the seed data",
    ].join("\n"),
  );
}

// ── entry point ────────────────────────────────────────────────────────────────────────

try {
  if (has("--seed")) {
    seed();
  } else if (has("--traffic")) {
    await runSet("traffic");
  } else if (has("--gate")) {
    await runSet("gate");
  } else if (has("--dataset")) {
    await dataset();
  } else if (has("--worker")) {
    await worker();
  } else if (has("--propose")) {
    await propose();
  } else if (has("--status")) {
    await status();
  } else {
    help();
  }
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
