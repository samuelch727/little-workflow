/**
 * `--loop`: the full littleDB self-improvement loop.
 *
 * NOT VERIFIED by the demo author — it needs the littleDB stack running, which the
 * offline driver deliberately does not. Every endpoint and every wait below is written
 * against the routes in the littleDB repo (`viewer/src/routes/api`, `viewer/src/server`);
 * treat the timings as the documented defaults, not as measured values.
 *
 * Prerequisites:
 *   - littleDB control plane on http://localhost:3000 and engine on http://localhost:7878
 *     (`docker compose up` in the littledb repo — compose forwards the model env vars).
 *   - `DEEPSEEK_API_KEY` in the littleDB container env, or `POST /dream` answers 503.
 *   - `JUDGE_MODEL` pinned to a concrete model id (not an alias) in the littleDB env, or
 *     the judge scheduler stays off and `judgeAvg` is empty.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const CONTROL_PLANE = process.env.LITTLEDB_URL ?? "http://localhost:3000";
const ENGINE = process.env.LITTLEDB_ENGINE_URL ?? "http://localhost:7878";
const HARNESS_ID = process.env.LITTLEDB_HARNESS_ID ?? "kb-librarian";
const CHANNEL = process.env.LITTLEDB_CHANNEL ?? "production";

/** littleDB's registry sync tick (`LITTLEDB_SYNC_INTERVAL_MS`, default 15s). */
const SYNC_TICK_MS = Number(process.env.LITTLEDB_SYNC_INTERVAL_MS ?? 15_000);
/** littleDB's judge pass interval (`LITTLEDB_JUDGE_INTERVAL_MS`, default 60s). */
const JUDGE_TICK_MS = Number(process.env.LITTLEDB_JUDGE_INTERVAL_MS ?? 60_000);

const headers = {
  "content-type": "application/json",
  ...(process.env.LITTLEDB_PROJECT_KEY ? { "x-api-key": process.env.LITTLEDB_PROJECT_KEY } : {}),
};

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
  const response = await fetch(`${CONTROL_PLANE}${path}`, { headers, ...init });
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

export async function runLoop({ demoRoot }) {
  heading("0. preflight");
  const controlPlaneUp = await reachable(CONTROL_PLANE);
  const engineUp = await reachable(`${ENGINE}/`);
  console.log(`control plane ${CONTROL_PLANE}: ${controlPlaneUp ? "up" : "UNREACHABLE"}`);
  console.log(`engine        ${ENGINE}: ${engineUp ? "up" : "UNREACHABLE"}`);
  if (!controlPlaneUp || !engineUp) {
    console.error(
      "\nStart the littleDB stack first (`docker compose up` in the littledb repo), then re-run.",
    );
    process.exitCode = 1;
    return;
  }

  heading("1. the conversation, with littleDB wired");
  console.log(
    "Runs the offline conversation in a child process with LITTLEDB_URL set. The FIRST",
    "\n/api/config/resolve call carries `bootstrapConfig` — that is what seeds the harness",
    "\nand its production channel in littleDB. Traces stream to the engine through the",
    "\nreporter, cost is stamped per model response, and the 👍/👎 reach /api/outcomes",
    "\nthrough the outcome sink.",
  );
  const conversation = spawnSync(process.execPath, [join(demoRoot, "driver.mjs")], {
    cwd: demoRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      LITTLEDB_URL: CONTROL_PLANE,
      LITTLEDB_ENGINE_URL: ENGINE,
      LITTLEDB_HARNESS_ID: HARNESS_ID,
      LITTLEDB_CHANNEL: CHANNEL,
    },
  });
  if (conversation.status !== 0) {
    console.error("\nThe conversation failed; stopping before the dream.");
    process.exitCode = 1;
    return;
  }

  heading("2. wait for the registry sync tick and one judge pass");
  console.log(
    `Runs land in the engine immediately, but the control plane picks them up on its sync`,
    `\ntick (~${Math.round(SYNC_TICK_MS / 1000)}s) and scores them on its judge pass (~${Math.round(JUDGE_TICK_MS / 1000)}s).`,
    "\nThe judge re-scans only the newest 50 COMPLETED runs engine-wide each pass, so on a busy",
    "\nengine these runs can age out of the window before they are ever scored.",
  );
  await wait(SYNC_TICK_MS + 2_000);
  await wait(JUDGE_TICK_MS + 5_000);

  heading("3. dream");
  console.log(`POST /api/harnesses/${HARNESS_ID}/dream`);
  console.log("(the same thing the Dream button in the littleDB UI does)");
  const dream = await json(`/api/harnesses/${HARNESS_ID}/dream`, { method: "POST" });
  console.log(JSON.stringify(dream, null, 2).slice(0, 2000));

  heading("4. find the proposal");
  const proposals = await json(`/api/proposals`);
  const list = Array.isArray(proposals) ? proposals : (proposals.proposals ?? []);
  const proposal = list.find((entry) => entry.status === "open" || entry.status === "proposed") ?? list[0];
  if (proposal === undefined) {
    console.error("No proposal was produced. Nothing to canary or promote.");
    process.exitCode = 1;
    return;
  }
  console.log(`proposal ${proposal.id} — status ${proposal.status}`);

  heading("5. canary");
  console.log(`POST /api/proposals/${proposal.id}/action  {"action":"canary","channel":"${CHANNEL}"}`);
  console.log("Splits the channel 50/50 between the base and the proposed config version.");
  console.log(JSON.stringify(
    await json(`/api/proposals/${proposal.id}/action`, {
      method: "POST",
      body: JSON.stringify({ action: "canary", channel: CHANNEL }),
    }),
  ));

  heading("6. promote");
  console.log(`POST /api/proposals/${proposal.id}/action  {"action":"promote","channel":"${CHANNEL}"}`);
  console.log(
    "Points the channel at the proposed config version. `{\"action\":\"auto-promote\"}` instead",
    "\nconsults the promotion policy and returns the unmet gates without changing anything when",
    "\nthe five-gate receipt is incomplete — a fallback to human, not an error.",
  );
  console.log(JSON.stringify(
    await json(`/api/proposals/${proposal.id}/action`, {
      method: "POST",
      body: JSON.stringify({ action: "promote", channel: CHANNEL }),
    }),
  ));

  heading("7. a FRESH session picks up the improved prompt");
  console.log(
    "Managed config is resolved once per session and pinned for its lifetime, so an existing",
    "\nthread keeps the old prompt forever. This opens a brand-new thread — a brand-new session —",
    "\nand prints the configVersionId it pinned.",
  );
  const fresh = spawnSync(
    process.execPath,
    [
      join(demoRoot, "driver.mjs"),
      "--ask",
      "How quickly must I report a stolen laptop?",
      "--thread",
      `kb-thread-post-promote-${Date.now()}`,
    ],
    {
      cwd: demoRoot,
      stdio: "inherit",
      env: {
        ...process.env,
        LITTLEDB_URL: CONTROL_PLANE,
        LITTLEDB_ENGINE_URL: ENGINE,
        LITTLEDB_HARNESS_ID: HARNESS_ID,
        LITTLEDB_CHANNEL: CHANNEL,
      },
    },
  );
  process.exitCode = fresh.status === 0 ? 0 : 1;
}
