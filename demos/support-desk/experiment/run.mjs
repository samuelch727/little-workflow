#!/usr/bin/env node
/**
 * The support-desk experiment driver.
 *
 *   node experiment/run.mjs --seed              # fresh episode area, nothing else
 *   node experiment/run.mjs --traffic           # optimizer set on prompt v1 → graded, reacted
 *   node experiment/run.mjs --gate --k 3        # gate set, measurement only, pass^k
 *   node experiment/run.mjs --status            # harness metrics + live channel pointer
 *
 * Flags: --limit <n>, --only <id,id,...>, --k <n>, --baseline <results.json>.
 *
 * It runs against harness slug `support-desk-x`. Two modes, and the difference between them
 * is the point of the whole file:
 *
 *   --traffic  runs the OPTIMIZER set, reports an outcome per tier, and streams traces to
 *              littleDB. These episodes become the run history the dream reads.
 *   --gate     runs the GATE set, reports nothing and streams nothing. A gate episode that
 *              reached littleDB would become training signal for the next dream, and the
 *              set that judges a change would be the set the change was tuned on
 *              (`evals-research-synthesis-2026-08.md` §7). The silence is enforced by not
 *              wiring the reporter at all rather than by a flag someone can forget.
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
// Set before ANY agent module loads: `littledb.ts` reads these at import time.
const CONTROL_PLANE = process.env.LITTLEDB_URL ?? "http://localhost:3000";
const ENGINE = process.env.LITTLEDB_ENGINE_URL ?? "http://localhost:7878";
const HARNESS_ID = process.env.LITTLEDB_HARNESS_ID ?? "support-desk-x";
const CHANNEL = process.env.LITTLEDB_CHANNEL ?? "production";
process.env.LITTLEDB_URL = CONTROL_PLANE;
process.env.LITTLEDB_ENGINE_URL = ENGINE;
process.env.LITTLEDB_HARNESS_ID = HARNESS_ID;
process.env.LITTLEDB_CHANNEL = CHANNEL;

/**
 * `--traffic` seeds littleDB with the deliberately-flawed v1. `--gate` must NOT: the config
 * under test has to come back from littleDB, or the gate is measuring a local file and the
 * whole before/after is theatre.
 */
if (has("--traffic")) {
  process.env.SUPPORT_PROMPT_FILE ??= "experiment/prompt-v1.md";
} else {
  delete process.env.SUPPORT_PROMPT_FILE;
}

const apiHeaders = {
  "content-type": "application/json",
  ...(process.env.LITTLEDB_PROJECT_KEY ? { "x-api-key": process.env.LITTLEDB_PROJECT_KEY } : {}),
};

// ── helpers ────────────────────────────────────────────────────────────────────────────

const heading = (text) => console.log(`\n=== ${text} ===`);
const pct = (value) => `${Math.round(value * 1000) / 10}%`;

async function api(path, init) {
  const response = await fetch(`${CONTROL_PLANE}${path}`, { headers: apiHeaders, ...init });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${init?.method ?? "GET"} ${path} → HTTP ${response.status}: ${text.slice(0, 500)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function reachable(url) {
  try {
    return (await fetch(url, { method: "GET" })).status < 500;
  } catch {
    return false;
  }
}

/** Hard-fail rather than silently running with no managed config and no outcomes. */
async function requireStack() {
  const [controlPlaneUp, engineUp] = await Promise.all([
    reachable(CONTROL_PLANE),
    reachable(`${ENGINE}/`),
  ]);
  console.log(`control plane ${CONTROL_PLANE}: ${controlPlaneUp ? "up" : "UNREACHABLE"}`);
  console.log(`engine        ${ENGINE}: ${engineUp ? "up" : "UNREACHABLE"}`);
  if (!controlPlaneUp || !engineUp) {
    throw new Error(
      "The littleDB stack is not reachable. Without it there is no managed config and no " +
        "outcomes — the run would burn model calls on an experiment that never happened.",
    );
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
  return { ...episode, supportLittleDb: littledb.supportLittleDb };
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

/** One scenario, once. Returns the graded record. */
async function runOne({ modules, scenario, seedDb, runStamp, mode, trial }) {
  const suffix = trial === undefined ? "" : `-k${trial}`;
  const sessionId = `sd-${scenario.id}${suffix}-${runStamp}`;
  const episodeDir = join(episodesRoot, `${mode}-${runStamp}`, `${scenario.id}${suffix}`);

  const episode = await modules.runEpisode({
    sessionId,
    episodeDir,
    turns: scenario.turns,
    telemetry: mode !== "gate",
    // Scripted pushback is withheld once the customer's ask HAS been granted: nobody argues
    // with an agent that just did what they wanted, and a transcript full of manufactured
    // frustration would poison both the outcome metric and littleDB's pushback detector.
    shouldSendTurn: () => {
      const { db } = readEpisode(episodeDir);
      return !askGranted(scenario, seedDb, db);
    },
  });

  const { db, actions } = readEpisode(episodeDir);
  const { task, policy } = gradeEpisode({ scenario, seed: seedDb, db, actions });

  // The live session is handed back BESIDE the record rather than on it: the record is
  // written to disk verbatim, and a `HarnessSession` carries functions and a trace handle
  // that have no business in a results file.
  return {
    session: episode.session,
    record: {
    id: scenario.id,
    tier: scenario.tier,
    kind: scenario.kind,
    trial: trial ?? 1,
    sessionId,
    runId: `harness_${sessionId}`,
    episodeDir,
    configVersionId: episode.configVersionId,
    taskSuccess: task.pass,
    policyCompliant: policy.pass,
    taskFailures: task.checks.filter((check) => !check.ok).map((check) => `${check.name}: ${check.detail}`),
    policyFailures: policy.failed,
    ruleVerdicts: Object.fromEntries(policy.rules.map((rule) => [rule.id, rule.status])),
    toolCalls: episode.toolCalls,
    turnsRun: episode.turns.length,
    pushbackFired: episode.turns.length > 1,
    pushbackWithheld: episode.turnsWithheld,
      reactionSent: null,
      transcript: episode.turns,
    },
  };
}

/**
 * The reaction, as a graded verdict rather than a customer's mood.
 *
 * A real customer thumbs-down a refusal they disagree with, correct or not. Standing in for
 * that here would make the success metric a popularity score, so — exactly as in
 * `demos/kb-chatbot` — the reaction reports the GRADE. The three-way split uses the outcome
 * vocabulary honestly: an episode that reached the right end state through a policy
 * violation is genuinely partial, and collapsing it into a success would hide the failure
 * mode this whole demo exists to measure.
 */
function verdictStatus(record) {
  if (!record.taskSuccess) return "failure";
  return record.policyCompliant ? "success" : "partial";
}

async function runSet(mode) {
  const k = Number(value("--k") ?? 1);
  heading(`${mode}: preflight`);
  await requireStack();
  const { file, scenarios } = loadScenarios(mode);
  console.log(`harness slug: ${HARNESS_ID} (channel ${CHANNEL})`);
  console.log(`scenario set: experiment/${file} — ${scenarios.length} scenario(s)`);
  console.log(`bootstrap prompt: ${process.env.SUPPORT_PROMPT_FILE ?? "(none — managed config only)"}`);
  console.log(
    mode === "gate"
      ? `telemetry: OFF, outcomes: NONE (sealed gate), trials per scenario: ${k}`
      : "telemetry: ON, outcomes: per tier (A/B report, C reports nothing)",
  );

  const seedDb = JSON.parse(readFileSync(seedFile, "utf8"));
  const modules = await agentModules();
  const db = modules.supportLittleDb();
  const runStamp = Date.now().toString(36);
  const records = [];

  heading(`${mode}: episodes`);
  for (const [index, scenario] of scenarios.entries()) {
    for (let trial = 1; trial <= (mode === "gate" ? k : 1); trial += 1) {
      const label = `[${index + 1}/${scenarios.length}${k > 1 && mode === "gate" ? ` k${trial}` : ""}] ${scenario.id} (tier ${scenario.tier}, ${scenario.kind})`;
      process.stdout.write(`${label} … `);
      const { record, session } = await runOne({
        modules,
        scenario,
        seedDb,
        runStamp,
        mode,
        ...(mode === "gate" && k > 1 ? { trial } : {}),
      });

      // Outcomes ride the same path a chat reaction would. Tier C sends none, on purpose:
      // its failures exist only in the conversation text, and whether the dream can read
      // them is the question that tier is asking.
      if (mode !== "gate" && scenario.reaction === "auto") {
        const status = verdictStatus(record);
        await modules.reportEpisodeOutcome({
          session,
          status,
          detail: [...record.taskFailures, ...record.policyFailures].join("; ") || "graded pass",
          reporter: `rater-${scenario.id}`,
        });
        record.reactionSent = status;
      }

      records.push(record);
      console.log(
        `task ${record.taskSuccess ? "PASS" : "FAIL"} / policy ${record.policyCompliant ? "PASS" : "FAIL"}` +
          `${record.pushbackFired ? ` +${record.turnsRun - 1} pushback` : ""}` +
          `${record.reactionSent === null ? "" : ` → ${record.reactionSent}`}`,
      );
      if (records.length === 1) warnIfBootstrapDrifted(record, db);
    }
  }
  await db?.flush();

  const summary = summarize(records, mode, k);
  printVerdicts(records);
  printTables(summary, mode);
  printRuleFailures(records);
  const file2 = persist(summary, records, mode);
  console.log(`\nresults: ${file2}`);
  compareToBaseline(records, mode);
  return records;
}

/**
 * littleDB stores the bootstrap prompt on the FIRST resolve for a harness+channel and
 * ignores it ever after. A later edit to `prompt-v1.md` is therefore a silent no-op, and the
 * run is measuring a prompt nobody is looking at — the whole before/after rests on v1 being
 * what that file says, so this is worth saying out loud rather than discovering afterwards.
 *
 * Learned in `demos/kb-chatbot`, which grew the same guard for the same reason.
 */
function warnIfBootstrapDrifted(record, db) {
  const promptFile = process.env.SUPPORT_PROMPT_FILE;
  if (promptFile === undefined || record.configVersionId === null) return;
  const wanted = readFileSync(resolve(demoRoot, promptFile), "utf8").trim();
  const live = db?.configFor(record.sessionId)?.harnessOptions?.system;
  if (live === undefined || live === wanted) return;
  console.warn(
    `\n  ⚠ the live config (${record.configVersionId}) does NOT match ${promptFile}.\n` +
      "    littleDB seeds the bootstrap once per harness+channel and ignores it afterwards,\n" +
      "    so this run is NOT on the prompt in that file. Use a fresh LITTLEDB_HARNESS_ID to reseed.\n",
  );
}

function summarize(records, mode, k) {
  return {
    mode,
    startedAt: new Date().toISOString(),
    harnessId: HARNESS_ID,
    channel: CHANNEL,
    promptFile: process.env.SUPPORT_PROMPT_FILE ?? null,
    configVersionIds: [...new Set(records.map((record) => record.configVersionId).filter(Boolean))],
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
    ["id", "tier", "kind", "task", "policy", "turns", "tools", "reaction", "first failure"],
    ...records.map((record) => [
      record.trial > 1 ? `${record.id}#${record.trial}` : record.id,
      record.tier,
      record.kind,
      record.taskSuccess ? "PASS" : "FAIL",
      record.policyCompliant ? "PASS" : "FAIL",
      String(record.turnsRun),
      record.toolCalls.join(",") || "(none)",
      record.reactionSent ?? "-",
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
  console.log(`baseline: ${baseline.startedAt} (${baseline.mode}) on config ${baseline.configVersionIds.join(", ") || "n/a"}`);
}

async function status() {
  heading("status");
  console.log(JSON.stringify(await api(`/api/harnesses/${HARNESS_ID}/metrics`), null, 2));
  const config = await api(`/api/harnesses/${HARNESS_ID}/config`).catch(() => undefined);
  if (config !== undefined) {
    for (const channel of config.channels ?? []) {
      console.log(`channel ${channel.name} → ${channel.configVersionId}`);
    }
  }
}

function help() {
  console.log(
    [
      `support-desk experiment driver (harness slug: ${HARNESS_ID})`,
      "",
      "  --seed              reset the episode area and the harness session store",
      "  --traffic           run the OPTIMIZER set on prompt v1: grade, react, persist",
      "  --gate [--k <n>]    run the GATE set: no reactions, no telemetry, pass^k",
      "  --status            harness metrics and the live channel pointer",
      "",
      "  --limit <n>         first n scenarios only",
      "  --only <id,...>     named scenarios only",
      "  --baseline <file>   compare against this results file instead of the previous run",
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
  } else if (has("--status")) {
    await status();
  } else {
    help();
  }
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
