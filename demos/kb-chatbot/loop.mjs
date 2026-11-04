/**
 * `--loop`: the full LittleDB self-improvement loop.
 *
 * NOT VERIFIED end to end by the demo author: it needs a LittleDB server with a model key for
 * its reviewer, which the offline driver deliberately does not. Every endpoint below is one
 * LittleDB's `/v1` API documents; treat the waits as generous defaults, not measured values.
 *
 * Prerequisites:
 *   - A LittleDB server (`littledb dev` serves one on http://127.0.0.1:7340 and prints a key
 *     for local apps): `LITTLEDB_URL` and `LITTLEDB_API_KEY`.
 *   - `LITTLEDB_ANTHROPIC_API_KEY` in LittleDB's own environment, or its reviewer answers 503.
 *   - `DEEPSEEK_API_KEY` here, for the Librarian itself.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const LITTLEDB_URL = (process.env.LITTLEDB_URL ?? "http://127.0.0.1:7340").replace(/\/+$/, "").replace(/\/v1$/, "");
const HARNESS = process.env.LITTLEDB_HARNESS ?? "kb-librarian";
const SUBJECT = `harness:${HARNESS}`;
const CHANNEL = process.env.LITTLEDB_CHANNEL ?? "production";
const REVIEW_TIMEOUT_MS = Number(process.env.KB_REVIEW_TIMEOUT_MS ?? 10 * 60_000);

function heading(text) {
  console.log(`\n=== ${text} ===`);
}

async function reachable(url) {
  try {
    const response = await fetch(url, { method: "GET" });
    return response.status < 500;
  } catch {
    return false;
  }
}

async function json(path, init) {
  const response = await fetch(`${LITTLEDB_URL}/v1${path}`, {
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env.LITTLEDB_API_KEY ?? ""}`,
    },
    ...init,
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!response.ok) {
    throw new Error(`${init?.method ?? "GET"} ${path} → HTTP ${response.status}: ${text.slice(0, 400)}`);
  }
  return body;
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const childEnv = () => ({
  ...process.env,
  LITTLEDB_URL,
  LITTLEDB_HARNESS: HARNESS,
  LITTLEDB_CHANNEL: CHANNEL,
});

export async function runLoop({ demoRoot }) {
  heading("0. preflight");
  const up = await reachable(`${LITTLEDB_URL}/healthz`);
  console.log(`LittleDB ${LITTLEDB_URL}: ${up ? "up" : "UNREACHABLE"}`);
  if (!up || !process.env.LITTLEDB_API_KEY) {
    console.error(
      up
        ? "\nSet LITTLEDB_API_KEY (`littledb dev` prints a key for local apps), then re-run."
        : "\nStart LittleDB first (`littledb dev`), then re-run.",
    );
    process.exitCode = 1;
    return;
  }

  heading("1. the conversation, with LittleDB wired");
  console.log(
    "Runs the offline conversation in a child process with LITTLEDB_URL set. The first",
    "\nresolve carries the bootstrap { system, model }, which becomes version 1 of the",
    "\nharness. Each turn is a trace (model calls, tool calls, tokens, cost), and the 👍/👎",
    "\nreactions become user_feedback scores on the turns they grade.",
  );
  const conversation = spawnSync(process.execPath, [join(demoRoot, "driver.mjs")], {
    cwd: demoRoot,
    stdio: "inherit",
    env: childEnv(),
  });
  if (conversation.status !== 0) {
    console.error("\nThe conversation failed; stopping before the review.");
    process.exitCode = 1;
    return;
  }

  heading("2. review");
  console.log(`POST /v1/reviews  {"subject":"${SUBJECT}"}`);
  console.log("LittleDB's reviewer reads the traces and their scores and proposes a new version.");
  const started = await json("/reviews", {
    method: "POST",
    body: JSON.stringify({ subject: SUBJECT, maxProposals: 1 }),
  });
  const deadline = Date.now() + REVIEW_TIMEOUT_MS;
  let review = await json(`/reviews/${started.id}`);
  while (review.review?.status === "running" && Date.now() < deadline) {
    await wait(5_000);
    review = await json(`/reviews/${started.id}`);
  }
  console.log(`review ${started.id}: ${review.review?.status}`);

  heading("3. find the proposal");
  const proposal = (review.proposals ?? [])[0];
  if (proposal === undefined) {
    console.error("No proposal was produced. Nothing to approve.");
    process.exitCode = 1;
    return;
  }
  console.log(`proposal ${proposal.id}: ${proposal.title} (status ${proposal.status})`);
  console.log(
    "LittleDB gates a proposal on an experiment over the harness's newest dataset when it has",
    "\none. This demo uploads no dataset, so there is no experiment to run: depending on the",
    "\nproject's policy LittleDB starts a live trial or leaves the call to a person. This loop",
    "\nmakes the call itself.",
  );

  heading("4. approve");
  console.log(`POST /v1/proposals/${proposal.id}/approve`);
  console.log("Makes the proposal's version the live one on the channel.");
  const approved = await json(`/proposals/${proposal.id}/approve`, {
    method: "POST",
    body: JSON.stringify({ note: "Approved by the kb-chatbot loop." }),
  });
  console.log(`proposal ${approved.proposal.id}: ${approved.proposal.status}`);

  heading("5. a FRESH session picks up the improved prompt");
  console.log(
    "A version is resolved once per session and kept for its lifetime, so an existing thread",
    "\nkeeps the old prompt. This opens a brand-new thread (a brand-new session) and prints the",
    "\nversion it resolved.",
  );
  const fresh = spawnSync(
    process.execPath,
    [
      join(demoRoot, "driver.mjs"),
      "--ask",
      "How quickly must I report a stolen laptop?",
      "--thread",
      `kb-thread-post-approve-${Date.now()}`,
    ],
    { cwd: demoRoot, stdio: "inherit", env: childEnv() },
  );
  process.exitCode = fresh.status === 0 ? 0 : 1;
}
