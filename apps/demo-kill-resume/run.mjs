import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { localWorld } from "little-workflow";

const here = dirname(fileURLToPath(import.meta.url));
const childScript = join(here, "child.mjs");

const baseDir = await mkdtemp(join(tmpdir(), "lwf-kill-resume-"));
const dataDir = join(baseDir, "world");
const heartbeatPath = join(baseDir, "heartbeat.jsonl");
const runId = `run_killresume_${Date.now().toString(36)}`;
const world = localWorld({ dataDir });

console.log("# Little Workflow alpha kill-and-resume demo");
console.log(`Data directory: ${dataDir}`);
console.log(`Run ID:         ${runId}`);
console.log();

async function readEvents() {
  return world.listEvents(runId);
}

async function waitForFastBranchCompleted(deadlineMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < deadlineMs) {
    const events = await readEvents();
    const found = events.find(
      (event) =>
        event.type === "ParallelBranchCompleted" &&
        event.payload?.itemKey === "fast-a",
    );
    if (found !== undefined) return found;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("fast-a branch did not complete within deadline");
}

async function runChildPhase(phase, { killAfterFastBranch = false } = {}) {
  console.log(`## phase=${phase}: spawning child`);
  const child = spawn(process.execPath, [childScript], {
    cwd: here,
    env: {
      ...process.env,
      DEMO_DATA_DIR: dataDir,
      DEMO_RUN_ID: runId,
      DEMO_PHASE: phase,
      DEMO_HEARTBEAT_PATH: heartbeatPath,
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));

  if (killAfterFastBranch) {
    try {
      await waitForFastBranchCompleted(15_000);
      console.log(`## phase=${phase}: fast-a completed; sending SIGKILL to PID ${child.pid}`);
      child.kill("SIGKILL");
    } catch (error) {
      child.kill("SIGKILL");
      await exited;
      throw error;
    }
  }

  const { code, signal } = await exited;
  console.log(`## phase=${phase}: child exited (code=${code} signal=${signal ?? "none"})`);
  return { code, signal };
}

function summarizeEvents(events) {
  return events.map((event, index) => ({
    seq: event.sequence ?? index + 1,
    type: event.type,
    stepPath: event.payload?.stepPath,
  }));
}

function eventDiff(before, after) {
  const beforeIds = new Set(before.map((e) => e.eventId));
  return after.filter((e) => !beforeIds.has(e.eventId));
}

const phaseOne = await runChildPhase("initial", { killAfterFastBranch: true });
if (phaseOne.signal !== "SIGKILL") {
  console.error("Phase 1 did not exit via SIGKILL as expected; aborting demo.");
  process.exit(1);
}

const eventsAfterKill = await readEvents();
console.log();
console.log(`# Events persisted after kill: ${eventsAfterKill.length}`);
console.table(summarizeEvents(eventsAfterKill));

const heartbeatBefore = await readFile(heartbeatPath, "utf8").catch(() => "");
const heartbeatBeforeLines = heartbeatBefore.split("\n").filter(Boolean);

const phaseTwo = await runChildPhase("resume", {});
if (phaseTwo.code !== 0) {
  console.error("Phase 2 (resume) did not complete cleanly.");
  process.exit(1);
}

const eventsAfterResume = await readEvents();
console.log();
console.log(`# Events persisted after resume: ${eventsAfterResume.length}`);
console.table(summarizeEvents(eventsAfterResume));

const newEvents = eventDiff(eventsAfterKill, eventsAfterResume);
console.log();
console.log(`# Event-stream diff (events added on resume): ${newEvents.length}`);
console.table(summarizeEvents(newEvents));

const heartbeatAfter = await readFile(heartbeatPath, "utf8").catch(() => "");
const heartbeatAfterLines = heartbeatAfter.split("\n").filter(Boolean);
const heartbeatNew = heartbeatAfterLines.slice(heartbeatBeforeLines.length);
const reRanCompletedBranch = heartbeatNew.some((line) => {
  try {
    const parsed = JSON.parse(line);
    return parsed.item?.id === "fast-a";
  } catch {
    return false;
  }
});

console.log();
console.log(
  reRanCompletedBranch
    ? "FAIL: tool handler for branch 'fast-a' ran again on resume."
    : "OK: completed branch 'fast-a' was not re-executed on resume.",
);

const finalRunCompleted = eventsAfterResume.some((event) => event.type === "RunCompleted");
console.log(
  finalRunCompleted
    ? "OK: run reached RunCompleted after resume."
    : "FAIL: run did not reach RunCompleted after resume.",
);

await rm(baseDir, { recursive: true, force: true });

if (reRanCompletedBranch || !finalRunCompleted) {
  process.exit(1);
}
