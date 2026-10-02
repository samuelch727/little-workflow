#!/usr/bin/env node
/**
 * The dream-catch experiment driver.
 *
 *   node experiment/run.mjs --seed                 # install the adversarial KB
 *   node experiment/run.mjs --traffic              # run every scenario on prompt v1, grade, react
 *   node experiment/run.mjs --dream                # ask littleDB to reflect; print the proposed diff
 *   node experiment/run.mjs --promote <proposalId> # canary, then promote
 *   node experiment/run.mjs --retest               # rerun the scenarios; BEFORE/AFTER table
 *   node experiment/run.mjs --gate                 # HELD-OUT set, k attempts each, no telemetry
 *   node experiment/run.mjs --status               # harness metrics
 *
 * Flags: --limit <n> (first n scenarios), --only <id,id,...>, --baseline <results.json>,
 * and for `--gate`: --k <n>, --prompt-file <path>, --dry-run.
 *
 * This is a SEPARATE driver from `driver.mjs` — the polished demo is untouched. It borrows
 * that file's mechanics (jiti load, reaction-aware test chat, `simulateInbound`) and adds
 * multi-turn scenarios, auto-grading, and result persistence.
 *
 * It runs against harness slug `kb-librarian-x`, never the demo's `kb-librarian`.
 *
 * TWO SCENARIO SETS, and the difference is the whole point of `--gate`:
 *
 *   ground-truth.json  the OPTIMIZER set. `--traffic` runs it, its failures are what the
 *                      dream reads, and `--retest` re-asks it. Re-asking the set that
 *                      produced the fix measures memorisation as much as repair.
 *   gate-truth.json    the HELD-OUT set. Only `--gate` asks it, and a gate run reports no
 *                      outcome and reaches no trace plane, so nothing it sees can ever
 *                      become dream evidence. It is also run k times per scenario (pass^k),
 *                      because one sample of a stochastic model is not a measurement.
 *
 * Grading lives in `grade.mjs` so it can be unit-tested without this file's live paths.
 */
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import {
  aggregateScenario,
  gradeAnswer,
  gradeExchanges,
  pct,
  renderGateBeforeAfter,
  renderGateStats,
  renderGateVerdicts,
  renderTable,
  summarizeGate,
  summarizeRuns,
} from "./grade.mjs";
import { assertNoLittleDbEnv, scrubLittleDbEnv } from "./offline.mjs";

export { citedFiles, gradeAnswer, gradeAnswer as grade, keywordPresent } from "./grade.mjs";

const experimentDir = dirname(fileURLToPath(import.meta.url));
const demoRoot = resolve(experimentDir, "..");
// `little-harness`'s module loader roots jiti at `process.cwd()` so an agent's bare imports
// resolve against the demo's node_modules. Run from the demo root, or nothing resolves.
process.chdir(demoRoot);

const kbSourceDir = join(experimentDir, "kb");
const knowledgeDir = join(demoRoot, "knowledge");
const dataDir = join(demoRoot, ".little-harness");
const resultsDir = join(experimentDir, ".results");
const groundTruthFile = join(experimentDir, "ground-truth.json");
const gateTruthFile = join(experimentDir, "gate-truth.json");

/** Present in the adversarial KB and in NO other seed — the "did you run --seed?" sentinel. */
const SENTINEL = "hr/policies/2026/time-off-rev3_FINAL.md";

/**
 * The gate's own sentinel. LIT-64 added a trap pair (`remote-work.md` + this file) that the
 * optimizer set never touches, so a `knowledge/` seeded before LIT-64 satisfies SENTINEL and
 * still makes gt7/gt8 unwinnable — a failure for the wrong reason, which is exactly what a
 * sentinel exists to prevent.
 */
const GATE_SENTINEL = "hr/policies/2026/hybrid-working-rev2.md";

const ADAPTER = "slack";

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
const HARNESS_ID = process.env.LITTLEDB_HARNESS_ID ?? "kb-librarian-x";
const CHANNEL = process.env.LITTLEDB_CHANNEL ?? "production";
process.env.LITTLEDB_URL = CONTROL_PLANE;
process.env.LITTLEDB_ENGINE_URL = ENGINE;
process.env.LITTLEDB_HARNESS_ID = HARNESS_ID;
// `runDream` looks up the channel named "production" specifically. Pin it.
process.env.LITTLEDB_CHANNEL = CHANNEL;

// `--traffic` seeds littleDB with the deliberately-flawed v1. `--retest` must NOT: the
// promoted prompt has to come back from littleDB, or the retest proves nothing.
if (has("--traffic")) {
  process.env.LIBRARIAN_PROMPT_FILE ??= "experiment/prompt-v1.md";
} else {
  delete process.env.LIBRARIAN_PROMPT_FILE;
}

const apiHeaders = {
  "content-type": "application/json",
  ...(process.env.LITTLEDB_PROJECT_KEY ? { "x-api-key": process.env.LITTLEDB_PROJECT_KEY } : {}),
};

// ── small helpers ──────────────────────────────────────────────────────────────────────

function heading(text) {
  console.log(`\n=== ${text} ===`);
}

async function api(path, init) {
  const response = await fetch(`${CONTROL_PLANE}${path}`, { headers: apiHeaders, ...init });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!response.ok) {
    throw new Error(
      `${init?.method ?? "GET"} ${path} → HTTP ${response.status}: ${text.slice(0, 500)}`,
    );
  }
  return body;
}

async function reachable(url) {
  try {
    const response = await fetch(url, { method: "GET" });
    return response.status < 500;
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

function requireSeededKnowledge() {
  if (existsSync(join(knowledgeDir, SENTINEL))) return;
  throw new Error(
    `The adversarial KB is not installed (${SENTINEL} missing under knowledge/). ` +
      "Run `node experiment/run.mjs --seed` first — otherwise the agent bootstraps the " +
      "4-file demo seed and every scenario fails for the wrong reason.",
  );
}

/**
 * A `knowledge/` seeded before LIT-64 has the optimizer set's KB but not the gate's trap
 * pair, which would make gt7/gt8 unanswerable — the gate would score a strategy failure that
 * is really a missing document.
 */
function requireGateKnowledge() {
  if (existsSync(join(knowledgeDir, GATE_SENTINEL))) return;
  throw new Error(
    `The gate's KB additions are not installed (${GATE_SENTINEL} missing under knowledge/). ` +
      "Re-run `node experiment/run.mjs --seed`: the KB gained a trap pair in LIT-64 " +
      "(remote-work.md + hybrid-working-rev2.md) and a knowledge/ seeded before that is stale.",
  );
}

function loadScenarios(file = groundTruthFile) {
  const parsed = JSON.parse(readFileSync(file, "utf8"));
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
  return scenarios;
}

// ── connector plumbing (mechanics cribbed from driver.mjs) ──────────────────────────────

/**
 * `createTestChat()` implements the three MESSAGE triggers but not `onReaction`, and the
 * connector registers its reaction handler only when `typeof chat.onReaction === "function"`.
 * This subclass adds the one missing method and keeps the recorded handlers reachable.
 */
function createReactionAwareTestChat(createTestChat) {
  const Base = createTestChat();
  const reactionHandlers = [];
  class ReactionAwareTestChat extends Base {
    onReaction(handler) {
      reactionHandlers.push(handler);
    }
  }
  ReactionAwareTestChat.reactionHandlers = reactionHandlers;
  return ReactionAwareTestChat;
}

function reactionEvent({ threadId, messageId, emoji, userId }) {
  return {
    added: true,
    emoji,
    rawEmoji: emoji,
    messageId,
    threadId,
    user: { userId, isMe: false, isBot: false },
    // A reaction on a message the ASSISTANT did not write is dropped by the classifier, so
    // the synthetic event has to name the bot as the author.
    message: { id: messageId, author: { userId: "librarian-bot", isMe: true } },
  };
}

function jitiFor() {
  return createJiti(join(demoRoot, "_experiment_root_.js"), { interopDefault: false });
}

async function loadConnector(ChatCtor) {
  const module = await jitiFor().import(join(demoRoot, "agents", "librarian", "load.ts"));
  return module.loadLibrarianConnector({ createChat: ChatCtor });
}

async function littleDbHandle() {
  const module = await jitiFor().import(join(demoRoot, "agents", "librarian", "littledb.ts"));
  return module.librarianLittleDb();
}

// ── phases ─────────────────────────────────────────────────────────────────────────────

function seed() {
  heading("seed");
  // Mirrors driver.mjs's resetState: the live KB, the harness data dir, and the inline
  // workflow event stores that land beside the demo as `slack:<threadId>/`.
  rmSync(knowledgeDir, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
  for (const entry of readdirSync(demoRoot, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.startsWith(`${ADAPTER}:`)) {
      rmSync(join(demoRoot, entry.name), { recursive: true, force: true });
    }
  }
  cpSync(kbSourceDir, knowledgeDir, { recursive: true });
  const files = countFiles(knowledgeDir);
  console.log(`installed ${files} file(s) from experiment/kb into ${knowledgeDir}`);
  console.log(`sentinel present: ${existsSync(join(knowledgeDir, SENTINEL))}`);
}

function countFiles(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    total += entry.isDirectory() ? countFiles(join(dir, entry.name)) : 1;
  }
  return total;
}

/**
 * One scenario = one fresh thread = one session = one run in the engine.
 *
 * `turns[0]` is graded. The frustration follow-ups fire ONLY when it failed: arguing with a
 * correct answer would be theatre, and the skip is recorded so the tally stays honest.
 */
async function runScenario({ connector, ChatCtor, scenario, runStamp, testing, db }) {
  const { createTestMessage, createTestThread } = testing;
  const threadId = `x-${scenario.id}-${runStamp}`;
  const sessionId = `${ADAPTER}:${threadId}`;
  // `thread.messages` is the history source (newest-first, see chat-sdk.ts `threadHistory`).
  // The test double iterates THIS array on every turn, so mutating it is how a multi-turn
  // conversation gets its context.
  const history = [];
  const thread = createTestThread({
    id: threadId,
    adapterName: ADAPTER,
    isDM: true,
    messages: history,
  });

  const exchanges = [];
  let firstAnswer = "";
  let verdict;

  for (const [index, text] of scenario.turns.entries()) {
    if (index > 0 && verdict.pass) break; // only argue with a failure
    const message = createTestMessage({
      id: `${threadId}-m${index + 1}`,
      threadId,
      text,
    });
    history.unshift(message);
    await connector.simulateInbound({ thread, message });
    const answer = thread.posts.at(-1) ?? "";
    history.unshift({
      id: `${threadId}-p${index + 1}`,
      text: answer,
      threadId,
      author: { userId: "librarian-bot", userName: "librarian", isMe: true },
    });
    exchanges.push({ user: text, assistant: answer });
    if (index === 0) {
      firstAnswer = answer;
      verdict = gradeAnswer(answer, scenario);
    }
  }

  // Reactions ride the same path the demo uses: the connector's own reaction handler, which
  // reports through littleDB's outcome sink. Tier C sends none, on purpose.
  let reactionSent = null;
  if (scenario.reaction === "auto" || scenario.reaction === "up" || scenario.reaction === "down") {
    const emoji =
      scenario.reaction === "auto"
        ? verdict.pass
          ? "thumbs_up"
          : "thumbs_down"
        : scenario.reaction === "up"
          ? "thumbs_up"
          : "thumbs_down";
    for (const handler of ChatCtor.reactionHandlers) {
      await handler(
        reactionEvent({
          threadId,
          messageId: `${threadId}-p1`,
          emoji,
          userId: `rater-${scenario.id}`,
        }),
      );
    }
    reactionSent = emoji;
  }

  const config = db?.configFor(sessionId);
  return {
    id: scenario.id,
    tier: scenario.tier,
    kind: scenario.kind,
    sessionId,
    runId: `harness_${sessionId}`,
    pass: verdict.pass,
    cited: verdict.cited,
    expected: verdict.expected,
    missing: verdict.missing,
    citedTrap: verdict.citedTrap,
    turnsRun: exchanges.length,
    frustrationFired: exchanges.length > 1,
    frustrationSkipped: scenario.turns.length > 1 && exchanges.length === 1,
    reactionSent,
    configVersionId: config?.configVersionId ?? null,
    firstAnswer,
    finalAnswer: exchanges.at(-1)?.assistant ?? "",
    exchanges,
  };
}

async function runTraffic(mode) {
  heading(`${mode}: preflight`);
  await requireStack();
  requireSeededKnowledge();
  const scenarios = loadScenarios();
  console.log(`harness slug: ${HARNESS_ID} (channel ${CHANNEL})`);
  console.log(
    `bootstrap prompt: ${process.env.LIBRARIAN_PROMPT_FILE ?? "(none — managed config only)"}`,
  );
  console.log(`scenarios: ${scenarios.length} — ${scenarios.map((s) => s.id).join(", ")}`);

  const testing = await import("little-harness/connectors");
  const ChatCtor = createReactionAwareTestChat(testing.createTestChat);
  const connector = await loadConnector(ChatCtor);
  const db = await littleDbHandle();
  const runStamp = Date.now().toString(36);
  const records = [];

  try {
    heading(`${mode}: conversations`);
    for (const [index, scenario] of scenarios.entries()) {
      process.stdout.write(
        `[${index + 1}/${scenarios.length}] ${scenario.id} (tier ${scenario.tier}, ${scenario.kind}) … `,
      );
      const record = await runScenario({ connector, ChatCtor, scenario, runStamp, testing, db });
      records.push(record);
      console.log(
        `${record.pass ? "PASS" : "FAIL"}${record.frustrationFired ? " +frustration" : ""}` +
          `${record.reactionSent ? ` ${record.reactionSent === "thumbs_up" ? "👍" : "👎"}` : " (no reaction)"}`,
      );
      if (index === 0) warnIfBootstrapDrifted(record, db);
    }
    await db?.flush();
  } finally {
    await connector.close();
  }

  const summary = summarize(records, mode);
  printTable(records);
  printTierStats(summary);
  const file = persist(summary, records, mode);
  console.log(`\nresults: ${file}`);

  if (mode === "retest") printBeforeAfter(records);
  return records;
}

/**
 * littleDB stores the bootstrap prompt on the FIRST resolve for a harness+channel and
 * ignores it ever after. A later edit to prompt-v1.md is therefore a silent no-op — worth
 * saying out loud, since the whole before/after rests on v1 being what the file says.
 */
function warnIfBootstrapDrifted(record, db) {
  const promptFile = process.env.LIBRARIAN_PROMPT_FILE;
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

function summarize(records, mode) {
  return {
    mode,
    startedAt: new Date().toISOString(),
    harnessId: HARNESS_ID,
    channel: CHANNEL,
    promptFile: process.env.LIBRARIAN_PROMPT_FILE ?? null,
    configVersionIds: [...new Set(records.map((r) => r.configVersionId).filter(Boolean))],
    ...summarizeRuns(records),
  };
}

function printTable(records) {
  heading("verdicts");
  console.log(
    renderTable([
      ["id", "tier", "kind", "verdict", "cited", "expected", "missing", "turns", "reaction"],
      ...records.map((record) => [
        record.id,
        record.tier,
        record.kind,
        record.pass ? "PASS" : "FAIL",
        record.cited.join(" ") || "(none)",
        record.expected,
        record.missing.join(" ") || "-",
        String(record.turnsRun),
        record.reactionSent ?? "-",
      ]),
    ]),
  );
}

function printTierStats(summary) {
  heading("by tier");
  console.log("tier  n   pass  rate    reacted  frustration-turns-fired");
  for (const tier of Object.keys(summary.tiers).sort()) {
    const stats = summary.tiers[tier];
    console.log(
      `${tier.padEnd(4)}  ${String(stats.n).padEnd(3)} ${String(stats.pass).padEnd(5)} ` +
        `${pct(stats.rate).padEnd(7)} ${String(stats.withReaction).padEnd(8)} ${stats.frustration}`,
    );
  }
  console.log("\nkind  n   pass  rate");
  for (const kind of Object.keys(summary.kinds).sort()) {
    const stats = summary.kinds[kind];
    console.log(
      `${kind.padEnd(4)}  ${String(stats.n).padEnd(3)} ${String(stats.pass).padEnd(5)} ${pct(stats.rate)}`,
    );
  }
  console.log(
    `\noverall: ${summary.overall.pass}/${summary.overall.n} = ${pct(summary.overall.rate)}`,
  );
  const invisible = (summary.tiers.C?.n ?? 0);
  if (invisible > 0) {
    console.log(
      `${invisible} tier-C thread(s) sent NO reaction: their failures are invisible to the ` +
        "success-rate metric and exist only in the conversation text.",
    );
  }
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
  const newest = files.at(-1);
  return newest === undefined
    ? undefined
    : JSON.parse(readFileSync(join(resultsDir, newest), "utf8"));
}

function printBeforeAfter(records) {
  const baseline = latestResults("traffic");
  if (baseline === undefined) {
    console.log("\n(no --traffic results to compare against; run --traffic first)");
    return;
  }
  heading("before / after");
  const before = new Map(baseline.scenarios.map((record) => [record.id, record]));
  const rows = [["id", "tier", "kind", "before", "after", "change"]];
  let beforePass = 0;
  let afterPass = 0;
  let compared = 0;
  for (const record of records) {
    const prior = before.get(record.id);
    if (prior === undefined) continue;
    compared += 1;
    if (prior.pass) beforePass += 1;
    if (record.pass) afterPass += 1;
    const change = prior.pass === record.pass ? "=" : record.pass ? "FIXED" : "REGRESSED";
    rows.push([
      record.id,
      record.tier,
      record.kind,
      prior.pass ? "PASS" : "FAIL",
      record.pass ? "PASS" : "FAIL",
      change,
    ]);
  }
  console.log(renderTable(rows));
  console.log(
    `\nsuccess rate ${beforePass}/${compared} (${pct(beforePass / compared)}) → ` +
      `${afterPass}/${compared} (${pct(afterPass / compared)})`,
  );
  console.log(`baseline: ${baseline.startedAt} on config ${baseline.configVersionIds.join(", ")}`);
}

// ── the gate: held-out scenarios, k attempts each, and no trace plane ───────────────────

/**
 * A gate run must be MEASUREMENT-ONLY. Reading the promoted prompt from the control plane is
 * fine — that is the same read `--status` does — but nothing about the run itself may reach
 * littleDB: no session config resolve, no event reporter, no outcome sink, no engine run.
 * If gate conversations became dream evidence, the held-out set would stop being held out
 * the first time anyone ran `--dream` again.
 *
 * The mechanism is the environment, and it lives in `offline.mjs` so it can be tested
 * without loading this driver. See that file for why deleting the variables is stronger than
 * passing an option.
 */

/**
 * The promoted prompt, read straight off the control plane. Deliberately NOT via the agent's
 * littleDB handle: this is a plain HTTP GET, it happens before the environment is scrubbed,
 * and it creates no session and no run.
 */
async function fetchChannelPrompt() {
  if (!(await reachable(CONTROL_PLANE))) {
    throw new Error(
      `gate: the control plane at ${CONTROL_PLANE} is unreachable, so the promoted prompt ` +
        "cannot be read. The engine is NOT needed for a gate run — start the control plane, " +
        "or measure a local prompt with --prompt-file experiment/prompt-v1.md.",
    );
  }
  const config = await api(`/api/harnesses/${HARNESS_ID}/config`);
  const channel = (config.channels ?? []).find((entry) => entry.name === CHANNEL);
  if (channel?.configVersionId === undefined || channel.configVersionId === null) {
    throw new Error(
      `gate: harness ${HARNESS_ID} has no config version on channel ${CHANNEL} yet. Run ` +
        "--traffic first (it seeds the bootstrap), or gate a local prompt with " +
        "--prompt-file experiment/prompt-v1.md.",
    );
  }
  const version = (config.versions ?? []).find((entry) => entry.id === channel.configVersionId);
  if (version === undefined) {
    throw new Error(`gate: config version ${channel.configVersionId} is not in the config response`);
  }
  let bundle;
  try {
    bundle = JSON.parse(version.configJson);
  } catch {
    throw new Error(`gate: config version ${channel.configVersionId} does not parse as JSON`);
  }
  if (typeof bundle.prompt !== "string" || bundle.prompt.length === 0) {
    throw new Error(`gate: config version ${channel.configVersionId} carries no prompt`);
  }
  if (channel.weightsJson !== null && channel.weightsJson !== undefined) {
    console.warn(
      `  ⚠ channel ${CHANNEL} is CANARYING (${channel.weightsJson}). The gate pins the channel\n` +
        `    pointer ${channel.configVersionId} and ignores the split — a measurement run that\n` +
        "    sampled two prompts would report the average of two different systems.\n",
    );
  }
  return {
    kind: "channel",
    prompt: bundle.prompt.trim(),
    configVersionId: channel.configVersionId,
    modelSlot: bundle.modelSlot ?? null,
    canary: channel.weightsJson ?? null,
    file: null,
  };
}

/**
 * The promoted bundle names a model SLOT, and `--retest` runs on whatever model that slot
 * resolves to. A gate that silently ran the agent's default model instead would not be
 * comparable with the retest it exists to check, so the slot is resolved here through the
 * agent's own map. `env.ts` imports nothing from `littledb.ts`.
 */
async function modelForPromotedSlot(slot) {
  const env = await jitiFor().import(join(demoRoot, "agents", "librarian", "env.ts"));
  const model = env.modelForSlot(slot);
  if (model === undefined) {
    throw new Error(
      `gate: the promoted config names model slot "${slot}", which agents/librarian/env.ts ` +
        "does not know. Refusing to silently run a different model.",
    );
  }
  return model;
}

/**
 * The gate's connector, built WITHOUT `loadLibrarianConnector`.
 *
 * That helper exists to wire littleDB's per-session overrides and its end-of-turn flush;
 * both are exactly what a gate run must not do. This is the same `loadChatSdkConnector` call
 * minus littleDB, with the measured prompt (and model) injected through the identical
 * `streamHarness` seam, so the agent, its tools, its persistent knowledge dir, and the run
 * pipeline are the ones the demo uses.
 */
async function loadGateConnector(ChatCtor, overrides) {
  const { streamHarness } = await import("little-harness");
  const { loadChatSdkConnector } = await import("little-harness/connectors");
  return loadChatSdkConnector({
    agentDir: join(demoRoot, "agents", "librarian"),
    connector: "slack",
    createChat: ChatCtor,
    streamHarness: (streamOptions) => streamHarness({ ...streamOptions, ...overrides }),
  });
}

/**
 * One attempt at one scenario, in its own thread.
 *
 * `gradeTurn: "final"` (tier P) always runs every turn — the pushback IS the measurement.
 * Otherwise the follow-ups fire only after a failure, as in `--traffic`, and the FIRST answer
 * is graded either way.
 */
async function runGateAttempt({ connector, testing, scenario, runStamp, attempt }) {
  const { createTestMessage, createTestThread } = testing;
  const threadId = `g-${scenario.id}-${runStamp}-a${attempt}`;
  const history = [];
  const thread = createTestThread({
    id: threadId,
    adapterName: ADAPTER,
    isDM: true,
    messages: history,
  });

  const gradeTurn = scenario.gradeTurn ?? "first";
  const exchanges = [];
  for (const [index, text] of scenario.turns.entries()) {
    if (index > 0 && gradeTurn === "first" && gradeAnswer(exchanges[0].assistant, scenario).pass) {
      break;
    }
    const message = createTestMessage({ id: `${threadId}-m${index + 1}`, threadId, text });
    history.unshift(message);
    await connector.simulateInbound({ thread, message });
    const answer = thread.posts.at(-1) ?? "";
    history.unshift({
      id: `${threadId}-p${index + 1}`,
      text: answer,
      threadId,
      author: { userId: "librarian-bot", userName: "librarian", isMe: true },
    });
    exchanges.push({ user: text, assistant: answer });
  }

  // No reaction is sent, on purpose and structurally: the gate's chat double has no
  // `onReaction`, so the connector never registered a handler to call.
  return { attempt, sessionId: `${ADAPTER}:${threadId}`, ...gradeExchanges(exchanges, scenario) };
}

/**
 * A deterministic stand-in for the model, so `--gate --dry-run` exercises argument parsing,
 * the k-loop, grading, pass^k aggregation, every table, and persistence with no API key, no
 * stack, and no network. Scenario ids fall into three behaviours — always right, right on the
 * first attempt only, always wrong — so a dry run always contains a scenario where pass^k and
 * pass^1 disagree, which is the arithmetic worth eyeballing.
 */
function dryRunAttempt(scenario, attempt) {
  const seed = [...scenario.id].reduce((total, char) => total + char.charCodeAt(0), 0);
  const behaviour = seed % 3;
  const right = behaviour === 0 || (behaviour === 1 && attempt === 1);
  const cite = basename(right ? scenario.mustCite : (scenario.trap ?? "catalog.md"));
  const body = right
    ? scenario.mustContain.join(" ")
    : "the knowledge base does not appear to cover that";
  const answer = `(dry run — no model was called) ${body}\nSource: ${cite}`;
  const gradeTurn = scenario.gradeTurn ?? "first";
  const turns = gradeTurn === "final" || !right ? scenario.turns : scenario.turns.slice(0, 1);
  const exchanges = turns.map((turn) => ({ user: turn, assistant: answer }));
  return {
    attempt,
    sessionId: `(dry-run)`,
    ...gradeExchanges(exchanges, scenario),
  };
}

function gateBaseline() {
  const explicit = value("--baseline");
  if (explicit !== undefined) {
    const file = resolve(explicit);
    return { file, data: JSON.parse(readFileSync(file, "utf8")) };
  }
  if (!existsSync(resultsDir)) return undefined;
  const files = readdirSync(resultsDir)
    .filter((name) => name.startsWith("gate-") && name.endsWith(".json"))
    .sort();
  const newest = files.at(-1);
  if (newest === undefined) return undefined;
  const file = join(resultsDir, newest);
  return { file, data: JSON.parse(readFileSync(file, "utf8")) };
}

async function runGate() {
  const k = Number(value("--k") ?? 3);
  if (!Number.isInteger(k) || k < 1) throw new Error("--k must be a positive integer");
  const dryRun = has("--dry-run");
  const promptFileFlag = value("--prompt-file");

  heading("gate: preflight");
  if (dryRun) {
    // A dry run never reads the KB, so demanding a seeded one would only make the offline
    // mechanics check impossible on a fresh checkout.
    console.log("knowledge:    (not checked — a dry run reads no documents)");
  } else {
    requireSeededKnowledge();
    requireGateKnowledge();
  }
  const scenarios = loadScenarios(gateTruthFile);
  for (const scenario of scenarios) {
    if (scenario.reaction !== null) {
      throw new Error(
        `gate scenario ${scenario.id} carries reaction "${scenario.reaction}" — the gate is ` +
          "measurement-only and must never report an outcome.",
      );
    }
  }
  console.log(`harness slug: ${HARNESS_ID} (channel ${CHANNEL})`);
  console.log(`scenarios:    ${scenarios.length} × k=${k} = ${scenarios.length * k} conversation(s)`);

  // Read the config BEFORE scrubbing: this is the one control-plane touch a gate run makes.
  let promptSource;
  if (promptFileFlag !== undefined) {
    const file = resolve(demoRoot, promptFileFlag);
    promptSource = {
      kind: "file",
      prompt: readFileSync(file, "utf8").trim(),
      configVersionId: null,
      modelSlot: null,
      canary: null,
      file,
    };
    console.log(`prompt:       ${file} (a LOCAL file, not the promoted config)`);
  } else if (dryRun) {
    promptSource = {
      kind: "none",
      prompt: null,
      configVersionId: null,
      modelSlot: null,
      canary: null,
      file: null,
    };
    console.log("prompt:       (dry run — no model is called, so no prompt is resolved)");
  } else {
    console.log(`prompt:       reading ${CONTROL_PLANE}/api/harnesses/${HARNESS_ID}/config`);
    promptSource = await fetchChannelPrompt();
    console.log(
      `              config version ${promptSource.configVersionId}, model slot ` +
        `${promptSource.modelSlot ?? "(none in bundle)"}`,
    );
  }

  const scrubbed = scrubLittleDbEnv(process.env);
  assertNoLittleDbEnv(process.env, "after scrubbing");
  console.log(
    `offline:      removed ${scrubbed.length} LITTLEDB_* var(s) from the environment` +
      `${scrubbed.length === 0 ? "" : ` — ${scrubbed.join(", ")}`}`,
  );

  let connector;
  let testing;
  let modelSlotApplied = null;
  if (!dryRun) {
    // Resolve the handle BEFORE the agent loads: with the environment scrubbed this pins the
    // process-wide holder to null, so `connectors/slack/connector.ts` — which calls the same
    // function at module scope — cannot get a live one either.
    if ((await littleDbHandle()) !== undefined) {
      throw new Error("gate: littleDB resolved despite the scrub; refusing to run.");
    }
    testing = await import("little-harness/connectors");
    // The PLAIN test chat, not the reaction-aware subclass `--traffic` uses: it has no
    // `onReaction`, so the connector never registers a reaction handler at all.
    const ChatCtor = testing.createTestChat();
    const overrides = {};
    if (promptSource.prompt !== null) overrides.system = promptSource.prompt;
    if (promptSource.modelSlot !== null) {
      overrides.model = await modelForPromotedSlot(promptSource.modelSlot);
      modelSlotApplied = promptSource.modelSlot;
    }
    connector = await loadGateConnector(ChatCtor, overrides);
    assertNoLittleDbEnv(process.env, "after loading the agent");
    if ((await littleDbHandle()) !== undefined) {
      throw new Error("gate: littleDB became live while loading the agent; refusing to run.");
    }
    console.log(
      "offline:      librarianLittleDb() === undefined — no session resolve, no event " +
        "reporter, no outcome sink, no engine run",
    );
    console.log(
      `offline:      chat double is createTestChat() with no onReaction — ${ChatCtor.name ?? "chat"} ` +
        "cannot deliver a reaction even if one were sent",
    );
  }

  const runStamp = Date.now().toString(36);
  const results = [];
  try {
    heading(`gate: ${scenarios.length} scenario(s) × ${k} attempt(s)`);
    for (const [index, scenario] of scenarios.entries()) {
      process.stdout.write(
        `[${index + 1}/${scenarios.length}] ${scenario.id} (tier ${scenario.tier}, ${scenario.kind}) … `,
      );
      const attempts = [];
      for (let attempt = 1; attempt <= k; attempt += 1) {
        attempts.push(
          dryRun
            ? dryRunAttempt(scenario, attempt)
            : await runGateAttempt({ connector, testing, scenario, runStamp, attempt }),
        );
      }
      const aggregate = aggregateScenario(scenario, attempts);
      results.push(aggregate);
      console.log(
        `${aggregate.passK ? "PASS" : "FAIL"} ${aggregate.passCount}/${k}` +
          `${aggregate.capitulatedAny ? " (capitulated after pushback)" : ""}`,
      );
    }
  } finally {
    if (connector !== undefined) await connector.close();
  }

  heading("gate verdicts");
  console.log(renderGateVerdicts(results));
  heading("gate rates");
  const summary = summarizeGate(results);
  console.log(renderGateStats(summary));

  const baseline = gateBaseline();
  const payload = {
    mode: "gate",
    dryRun,
    startedAt: new Date().toISOString(),
    gateFile: basename(gateTruthFile),
    harnessId: HARNESS_ID,
    channel: CHANNEL,
    k,
    prompt: {
      source: promptSource.kind,
      configVersionId: promptSource.configVersionId,
      modelSlot: promptSource.modelSlot,
      modelSlotApplied,
      file: promptSource.file,
      canaryWeights: promptSource.canary,
    },
    offline: {
      scrubbedEnv: scrubbed,
      littleDbHandle: dryRun ? "(agent not loaded — dry run)" : "undefined",
      reactionsSent: 0,
      chatDouble: dryRun ? "(none — dry run)" : "createTestChat (no onReaction)",
    },
    ...summary,
    scenarios: results,
  };
  const file = persistGate(payload, dryRun);
  console.log(`\nresults: ${file}`);

  if (baseline !== undefined) {
    if (Boolean(baseline.data.dryRun) !== dryRun) {
      console.log(
        `\n(not comparing against ${baseline.file}: one side is a dry run and the other is a ` +
          "live run — the numbers do not mean the same thing)",
      );
    } else {
      heading("before / after");
      if (baseline.data.k !== k) {
        console.warn(
          `  ⚠ baseline ran k=${baseline.data.k}, this run k=${k}. pass^k is not comparable ` +
            "across different k; read the pass^1 line instead.\n",
        );
      }
      console.log(renderGateBeforeAfter(payload, baseline.data));
      console.log(`\nbaseline: ${baseline.file}\n          ${describeGateRun(baseline.data)}`);
      console.log(`this run: ${describeGateRun(payload)}`);
    }
  } else {
    console.log("\n(no earlier gate results to compare against — this run is the baseline)");
  }
  return results;
}

/** One line naming when a gate result was taken and which prompt it measured. */
function describeGateRun(result) {
  const prompt = result.prompt ?? {};
  const on =
    prompt.source === "channel"
      ? `config version ${prompt.configVersionId}`
      : prompt.source === "file"
        ? `local prompt file ${prompt.file}`
        : "no prompt (stub answers)";
  return `${result.startedAt}, k=${result.k}, ${on}${result.dryRun ? " — DRY RUN" : ""}`;
}

function persistGate(payload, dryRun) {
  mkdirSync(resultsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  // A dry run is deliberately NOT named `gate-*`: it must never be picked up as the newest
  // gate baseline by a later real run.
  const file = join(resultsDir, `${dryRun ? "dryrun-gate" : "gate"}-${stamp}.json`);
  writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`);
  return file;
}

async function dream() {
  heading("dream");
  await requireStack();
  console.log(`POST /api/harnesses/${HARNESS_ID}/dream`);
  const result = await api(`/api/harnesses/${HARNESS_ID}/dream`, { method: "POST" });
  console.log(`proposal:  ${result.proposalId}`);
  console.log(`proposed:  ${result.proposedConfigVersionId}`);
  console.log(`promotion: ${JSON.stringify(result.promotion)}`);

  const proposals = await api("/api/proposals");
  const list = Array.isArray(proposals) ? proposals : (proposals.proposals ?? []);
  const proposal = list.find((entry) => entry.id === result.proposalId);
  if (proposal !== undefined) {
    heading("rationale");
    console.log(proposal.rationale);
    if (proposal.evidenceJson) {
      heading("evidence the dream cited");
      console.log(proposal.evidenceJson);
    }
    heading("prompt diff (base → proposed)");
    printPromptDiff(
      await api(`/api/harnesses/${HARNESS_ID}/config`),
      proposal.baseConfigVersionId,
      proposal.proposedConfigVersionId,
    );
  }
  console.log(`\nNext: node experiment/run.mjs --promote ${result.proposalId}`);
}

function printPromptDiff(config, baseId, proposedId) {
  const byId = new Map(config.versions.map((version) => [version.id, version]));
  const promptOf = (id) => {
    const version = byId.get(id);
    if (version === undefined) return undefined;
    try {
      return JSON.parse(version.configJson).prompt ?? "";
    } catch {
      return undefined;
    }
  };
  const base = promptOf(baseId);
  const proposed = promptOf(proposedId);
  if (base === undefined || proposed === undefined) {
    console.log("(could not read both config versions)");
    return;
  }
  mkdirSync(resultsDir, { recursive: true });
  const baseFile = join(resultsDir, `.diff-base-${baseId}.md`);
  const proposedFile = join(resultsDir, `.diff-proposed-${proposedId}.md`);
  writeFileSync(baseFile, `${base}\n`);
  writeFileSync(proposedFile, `${proposed}\n`);
  try {
    execFileSync("diff", ["-u", "--label", "prompt-v1", "--label", "proposed", baseFile, proposedFile], {
      encoding: "utf8",
    });
    console.log("(identical — the dream changed something other than the prompt)");
  } catch (error) {
    // `diff` exits 1 when the files differ — that is the expected path.
    if (error.status === 1) console.log(error.stdout);
    else throw error;
  }
}

async function promote(proposalId) {
  if (proposalId === undefined) throw new Error("usage: --promote <proposalId>");
  heading("canary");
  console.log(
    await api(`/api/proposals/${proposalId}/action`, {
      method: "POST",
      body: JSON.stringify({ action: "canary", channel: CHANNEL }),
    }).then(JSON.stringify),
  );
  console.log(`channel ${CHANNEL} now splits 50/50 between the base and the proposed version.`);

  heading("promote");
  console.log(
    await api(`/api/proposals/${proposalId}/action`, {
      method: "POST",
      body: JSON.stringify({ action: "promote", channel: CHANNEL }),
    }).then(JSON.stringify),
  );
  const config = await api(`/api/harnesses/${HARNESS_ID}/config`);
  const channel = config.channels.find((entry) => entry.name === CHANNEL);
  console.log(`channel ${CHANNEL} → ${channel?.configVersionId} (weights cleared: ${channel?.weightsJson === null})`);
  console.log("\nNext: node experiment/run.mjs --retest");
}

async function status() {
  heading("status");
  const metrics = await api(`/api/harnesses/${HARNESS_ID}/metrics`);
  console.log(JSON.stringify(metrics, null, 2));
  const config = await api(`/api/harnesses/${HARNESS_ID}/config`).catch(() => undefined);
  if (config !== undefined) {
    for (const channel of config.channels) {
      console.log(`channel ${channel.name} → ${channel.configVersionId}`);
    }
  }
}

function help() {
  console.log(
    [
      "dream-catch experiment driver (harness slug: kb-librarian-x)",
      "",
      "  --seed                 wipe knowledge/ and install experiment/kb",
      "  --traffic              run the OPTIMIZER set on prompt v1, grade, react, persist results",
      "  --dream                POST /dream; print the proposal, rationale, and prompt diff",
      "  --promote <proposalId> canary, then promote",
      "  --retest               rerun the OPTIMIZER set on the promoted config; BEFORE/AFTER table",
      "  --gate                 run the HELD-OUT set (gate-truth.json) k times per scenario;",
      "                         pass^k and pass^1, no reactions, no trace plane",
      "  --status               harness metrics and the live channel pointer",
      "",
      "  --limit <n>            first n scenarios only",
      "  --only <id,id,...>     named scenarios only",
      "  --baseline <file>      compare against this results file instead of the newest",
      "",
      "  --k <n>                --gate only: attempts per scenario (default 3). A scenario",
      "                         passes only if ALL k attempts pass.",
      "  --prompt-file <path>   --gate only: measure a local prompt file instead of the",
      "                         promoted config (e.g. experiment/prompt-v1.md for a baseline)",
      "  --dry-run              --gate only: no model, no stack. A deterministic stub answers",
      "                         every turn so the mechanics can be checked offline.",
    ].join("\n"),
  );
}

// ── entry point ────────────────────────────────────────────────────────────────────────

try {
  if (has("--seed")) {
    seed();
  } else if (has("--traffic") || has("--retest")) {
    await runTraffic(has("--retest") ? "retest" : "traffic");
  } else if (has("--gate")) {
    await runGate();
  } else if (has("--dream")) {
    await dream();
  } else if (has("--promote")) {
    await promote(value("--promote"));
  } else if (has("--status")) {
    await status();
  } else {
    help();
  }
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
