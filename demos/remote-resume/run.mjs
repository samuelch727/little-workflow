// Demo: the managed-agents ports working together across real process boundaries.
//
//   1. A session-log server holds the durable event log (file-backed store).
//   2. A harness child process runs two turns with the subprocess sandbox, then SIGKILLs
//      itself — no graceful shutdown.
//   3. The session-log server is RESTARTED over the same file, proving the log survives
//      log-server death too.
//   4. A fresh harness child (new pid, new data dir — only runId + log URL shared) resumes:
//      the completed text turn replays with ZERO provider calls, and the multi-step turn's
//      tool side effects are not re-executed.
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createFileSessionLog, startSessionLogServer } from "little-harness";

const childScript = fileURLToPath(new URL("./child.mjs", import.meta.url));
const baseDir = await mkdtemp(join(tmpdir(), "lh-remote-resume-"));
const eventLogPath = join(baseDir, "events.ndjson");
const authToken = "demo-session-log-token";
const failures = [];

function check(label, ok, detail = "") {
  console.log(`${ok ? "OK" : "FAIL"}: ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(label);
}

async function runChild(phase, serverUrl) {
  const resultPath = join(baseDir, `result-${phase}.json`);
  const child = spawn(process.execPath, [childScript], {
    env: {
      ...process.env,
      DEMO_PHASE: phase,
      DEMO_SERVER_URL: serverUrl,
      DEMO_AUTH_TOKEN: authToken,
      DEMO_DATA_DIR: join(baseDir, `data-${phase}`),
      DEMO_RESULT_PATH: resultPath,
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
  const exit = await new Promise((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });
  let result;
  try {
    result = JSON.parse(await readFile(resultPath, "utf8"));
  } catch {
    console.error(
      `FAIL: phase ${phase} produced no result (exit ${JSON.stringify(exit)}); state kept at ${baseDir}`,
    );
    process.exit(1);
  }
  return { exit, result };
}

// Phase 1: record the run, then die hard.
const firstServer = await startSessionLogServer({
  store: createFileSessionLog({ path: eventLogPath }),
  authToken,
});
console.log(`session-log server (phase 1) at ${firstServer.url}`);
const initial = await runChild("initial", firstServer.url);
check("phase 1 exited via SIGKILL (no graceful shutdown)", initial.exit.signal === "SIGKILL");
check(
  "phase 1 completed both turns",
  initial.result.turnAText === "remembered across processes" &&
    initial.result.turnBText === "the sum is 7",
  JSON.stringify(initial.result),
);
await firstServer.close();

// Phase 2: a brand-new server process over the same file, and a brand-new harness process.
const secondServer = await startSessionLogServer({
  store: createFileSessionLog({ path: eventLogPath }),
  authToken,
});
console.log(`session-log server (phase 2, restarted) at ${secondServer.url}`);
const resumed = await runChild("resume", secondServer.url);
await secondServer.close();

check("phase 2 exited cleanly", resumed.exit.code === 0);
check(
  "resumed turns return the recorded results",
  resumed.result.turnAText === initial.result.turnAText &&
    resumed.result.turnBText === initial.result.turnBText,
  JSON.stringify(resumed.result),
);
check(
  "completed text turn resumed with ZERO provider calls",
  resumed.result.turnAModelCalls === 0,
  `turnAModelCalls=${resumed.result.turnAModelCalls}`,
);
check(
  "tool side effects were not re-executed on resume",
  resumed.result.addToolExecutions === 0,
  `addToolExecutions=${resumed.result.addToolExecutions}`,
);

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed; state kept at ${baseDir}`);
  process.exit(1);
}
await rm(baseDir, { recursive: true, force: true });
console.log("\nAll checks passed: kill-and-resume across processes via the remote session log.");
