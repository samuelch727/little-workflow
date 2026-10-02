#!/usr/bin/env node
/**
 * kb-chatbot driver.
 *
 *   node driver.mjs            # offline: no littleDB, scripted conversation, PASS/FAIL
 *   node driver.mjs --loop     # the full littleDB self-improvement loop (needs the stack)
 *
 * The offline mode drives the SAME `run()` pipeline a real Slack message would, through
 * `simulateInbound`, with a `data`-backed attachment so the file upload needs no network.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const demoRoot = dirname(fileURLToPath(import.meta.url));
// `little-harness`'s module loader roots jiti at `process.cwd()` so an agent's bare imports
// resolve against the app's node_modules. Run from the demo root, or nothing resolves.
process.chdir(demoRoot);

const repoRoot = resolve(demoRoot, "..", "..");
const knowledgeDir = join(demoRoot, "knowledge");
const seedDir = join(demoRoot, "seed-knowledge");
const dataDir = join(demoRoot, ".little-harness");
const littleHarnessCli = join(repoRoot, "packages", "little-harness", "dist", "cli.js");

const argv = process.argv.slice(2);
const args = new Set(argv);
const keepState = args.has("--keep-state");

function optionValue(name) {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

const ADAPTER = "slack";
const THREAD_A = "kb-thread-a";
const THREAD_B = "kb-thread-b";

/** The document the driver uploads mid-conversation. Nothing in the seed KB answers it. */
const UPLOAD_NAME = "lost-laptop.md";
const UPLOAD_TEXT = `# Lost or stolen laptop

Northwind Systems security team (fictional sample document).

## Reporting

- Report a lost or stolen laptop to security@northwind.example within **4 hours** of
  noticing it is gone. There is no exception for weekends.
- File incident form **SEC-19** in the same message. A report without SEC-19 does not
  start the remote-wipe clock.

## What happens next

1. Security remote-wipes the device and revokes its certificates.
2. Your manager is notified; you are not charged for the hardware.
3. A replacement is shipped within two business days.
`;

const results = [];
let stepNumber = 0;

function step(title) {
  stepNumber += 1;
  const label = `Step ${stepNumber}: ${title}`;
  console.log(`\n--- ${label} ---`);
  return label;
}

function check(label, passed, detail) {
  results.push({ label, passed });
  console.log(`${passed ? "PASS" : "FAIL"}  ${label}${detail ? `\n      ${detail}` : ""}`);
}

function resetState() {
  rmSync(knowledgeDir, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
  // Inline workflows get `persistence.dataDir = "<sessionId>/workflows"` — a RELATIVE path
  // (turn-tools.ts:88) that `localWorld` resolves against `process.cwd()` — so their sqlite
  // event stores land HERE, beside the demo, not under `.little-harness/`.
  for (const entry of readdirSync(demoRoot, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.startsWith(`${ADAPTER}:`)) {
      rmSync(join(demoRoot, entry.name), { recursive: true, force: true });
    }
  }
  cpSync(seedDir, knowledgeDir, { recursive: true });
}

function readKnowledge(name) {
  const path = join(knowledgeDir, name);
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

function citesSource(text, filename) {
  const escaped = filename.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`source\\s*:?\\s*\`?\\S*${escaped}`, "i").test(text);
}

/** Read `outcome.reported` events out of the local trace of a given session id. */
function traceOutcomes(sessionId) {
  const sessionsDir = join(dataDir, "sessions");
  if (!existsSync(sessionsDir)) return [];
  for (const entry of readdirSync(sessionsDir)) {
    const traceFile = join(sessionsDir, entry, "trace.ndjson");
    if (!existsSync(traceFile)) continue;
    const events = readFileSync(traceFile, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
    if (events.some((event) => event.sessionId === sessionId)) {
      // The recorded event carries `status` inside `metadata`, not at the top level —
      // the trace envelope is `{eventId, sequence, type, sessionId, timestamp, metadata}`.
      return events
        .filter((event) => event.type === "outcome.reported")
        .map((event) => ({ ...event, status: event.metadata?.status }));
    }
  }
  return [];
}

/**
 * `createTestChat()` implements the three MESSAGE triggers but not `onReaction`, and the
 * connector registers its reaction handler only when `typeof chat.onReaction === "function"`
 * — so the shipped test double cannot exercise the reactions surface at all. This subclass
 * adds the one missing method and keeps the recorded handlers reachable.
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

/** Load `agents/librarian/load.ts` (and, through it, the connector) with a test Chat. */
async function loadConnector(ChatCtor) {
  const jiti = createJiti(join(demoRoot, "_driver_root_.js"), { interopDefault: false });
  const module = await jiti.import(join(demoRoot, "agents", "librarian", "load.ts"));
  return { connector: await module.loadLibrarianConnector({ createChat: ChatCtor }), module };
}

/**
 * One turn on one thread. Used by `--loop` to open a FRESH session after a promotion:
 * managed config is pinned per session, so an improved prompt is only visible to a
 * session created after the promote.
 */
async function runSingleTurn(question, threadId) {
  const { createTestChat, createTestMessage, createTestThread } = await import(
    "little-harness/connectors"
  );
  const ChatCtor = createReactionAwareTestChat(createTestChat);
  const { connector } = await loadConnector(ChatCtor);
  try {
    const thread = createTestThread({ id: threadId, adapterName: ADAPTER, isDM: true });
    await connector.simulateInbound({
      thread,
      message: createTestMessage({ threadId, text: question }),
    });
    console.log(thread.posts.at(-1) ?? "(no reply)");
    const jiti = createJiti(join(demoRoot, "_driver_root_.js"), { interopDefault: false });
    const { librarianLittleDb } = await jiti.import(
      join(demoRoot, "agents", "librarian", "littledb.ts"),
    );
    const config = librarianLittleDb()?.configFor(`${ADAPTER}:${threadId}`);
    if (config !== undefined) {
      console.log(
        `\npinned configVersionId: ${config.configVersionId} (channel ${config.channel}${config.staleConfig ? ", STALE" : ""})`,
      );
    }
  } finally {
    await connector.close();
  }
}

async function runOffline() {
  if (!keepState) resetState();

  const { createTestChat, createTestMessage, createTestThread } = await import(
    "little-harness/connectors"
  );
  const ChatCtor = createReactionAwareTestChat(createTestChat);
  const { connector } = await loadConnector(ChatCtor);

  try {
    // ── 1. A question the seed knowledge base answers ────────────────────────────────
    let label = step("ask a question answered by a seed document");
    const threadA = createTestThread({ id: THREAD_A, adapterName: ADAPTER, isDM: true });
    await connector.simulateInbound({
      thread: threadA,
      message: createTestMessage({
        id: "msg-a1",
        threadId: THREAD_A,
        text: "How many vacation days do I get, and how many carry over?",
      }),
    });
    const answer1 = threadA.posts.at(-1) ?? "";
    console.log(`> ${answer1.replace(/\n/g, "\n> ")}`);
    check(
      label,
      /\b20\b/.test(answer1) && citesSource(answer1, "vacation-policy.md"),
      "expects the 20-day accrual and a `Source: vacation-policy.md` citation",
    );

    // ── 2. Upload a new document ─────────────────────────────────────────────────────
    label = step("upload a document and watch it get ingested");
    await connector.simulateInbound({
      thread: threadA,
      message: createTestMessage({
        id: "msg-a2",
        threadId: THREAD_A,
        text: "Please add this document to the knowledge base.",
        attachments: [
          {
            type: "file",
            name: UPLOAD_NAME,
            mimeType: "text/markdown",
            data: new TextEncoder().encode(UPLOAD_TEXT),
          },
        ],
      }),
    });
    const answer2 = threadA.posts.at(-1) ?? "";
    console.log(`> ${answer2.replace(/\n/g, "\n> ")}`);
    const ingestedDoc = readKnowledge(UPLOAD_NAME);
    const catalog = readKnowledge("catalog.md") ?? "";
    check(
      label,
      ingestedDoc !== undefined && ingestedDoc.includes("SEC-19") && catalog.includes(UPLOAD_NAME),
      `knowledge/${UPLOAD_NAME} committed: ${ingestedDoc !== undefined}; catalog.md lists it: ${catalog.includes(UPLOAD_NAME)}`,
    );

    // ── 3. A question only the new document answers, from a DIFFERENT thread ─────────
    label = step("ask a question only the new document answers (fresh thread, shared KB)");
    const threadB = createTestThread({ id: THREAD_B, adapterName: ADAPTER, isDM: true });
    await connector.simulateInbound({
      thread: threadB,
      message: createTestMessage({
        id: "msg-b1",
        threadId: THREAD_B,
        text: "My laptop was stolen. How fast must I report it, and which form do I file?",
      }),
    });
    const answer3 = threadB.posts.at(-1) ?? "";
    console.log(`> ${answer3.replace(/\n/g, "\n> ")}`);
    check(
      label,
      /SEC-19/i.test(answer3) && /\b4\b/.test(answer3) && citesSource(answer3, UPLOAD_NAME),
      `expects "4 hours", "SEC-19", and a \`Source: ${UPLOAD_NAME}\` citation`,
    );

    // ── 4. Reactions become outcomes ─────────────────────────────────────────────────
    label = step("react 👍 and 👎 so the replies become outcomes");
    const handlers = ChatCtor.reactionHandlers;
    if (handlers.length === 0) {
      check(label, false, "the connector registered no reaction handler");
    } else {
      for (const handler of handlers) {
        await handler(
          reactionEvent({ threadId: THREAD_A, messageId: "post-a1", emoji: "thumbs_up", userId: "rater-1" }),
        );
        await handler(
          reactionEvent({ threadId: THREAD_B, messageId: "post-b1", emoji: "thumbs_down", userId: "rater-2" }),
        );
      }
      const statusesA = traceOutcomes(`${ADAPTER}:${THREAD_A}`).map((event) => event.status);
      const statusesB = traceOutcomes(`${ADAPTER}:${THREAD_B}`).map((event) => event.status);
      check(
        label,
        statusesA.includes("success") && statusesB.includes("failure"),
        `${ADAPTER}:${THREAD_A} → [${statusesA.join(", ") || "none"}]; ${ADAPTER}:${THREAD_B} → [${statusesB.join(", ") || "none"}]`,
      );
    }

    // ── 5. The aggregation the CLI reports ───────────────────────────────────────────
    label = step("little-harness outcomes");
    const report = execFileSync(
      process.execPath,
      [littleHarnessCli, "outcomes", "--data-dir", dataDir],
      { encoding: "utf8", cwd: demoRoot },
    ).trim();
    console.log(report);
    let parsed;
    try {
      parsed = JSON.parse(report);
    } catch {
      parsed = undefined;
    }
    const reported = countReports(parsed);
    check(label, reported >= 2, `aggregated ${reported} report(s); expected at least the two reactions`);
  } finally {
    await connector.close();
  }
}

/** Counted reports in the `OutcomeReport` the CLI prints (`overall.n`). */
function countReports(report) {
  if (report === null || typeof report !== "object") return 0;
  return Number(report.overall?.n ?? report.countedCount ?? 0);
}

const askText = optionValue("--ask");

if (args.has("--loop")) {
  const { runLoop } = await import("./loop.mjs");
  await runLoop({ demoRoot, dataDir, knowledgeDir });
} else if (askText !== undefined) {
  await runSingleTurn(askText, optionValue("--thread") ?? "kb-thread-fresh");
} else {
  console.log("kb-chatbot — offline mode.");
  console.log(`knowledge base: ${knowledgeDir}`);
  console.log(`harness data:   ${dataDir}`);
  console.log(
    process.env.LITTLEDB_URL
      ? "littleDB:       WIRED (managed config + trace reporter + outcome sink)."
      : "littleDB:       off (LITTLEDB_URL unset) — plain createHarness + instructions.md.",
  );
  await runOffline();

  console.log("\n=== summary ===");
  for (const result of results) {
    console.log(`${result.passed ? "PASS" : "FAIL"}  ${result.label}`);
  }
  const failed = results.filter((result) => !result.passed).length;
  console.log(`${results.length - failed}/${results.length} steps passed.`);
  process.exitCode = failed === 0 ? 0 : 1;
}
