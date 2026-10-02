/**
 * probe-compaction — a LIVE check that deterministic conversation compaction is
 * active in the real model loop without breaking the flow.
 *
 *   node probe-compaction.mjs [count]
 *
 * Runs the orchestrated demo with an aggressively low compaction threshold and
 * then scans the recorded model calls for the elision marker. Note: the demo's
 * orchestrator tool results are compact metadata by design, so there may be
 * little bulk to elide in a short run — the deterministic firing proof lives in
 * harness/conversation-compaction.test.ts + the workflow-harness loop test. Here we
 * confirm (a) the run still completes with compaction in the path, and (b)
 * report how many model calls were compacted, if any.
 */
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { listEvents, localWorld } from "little-workflow";
import { runDelegatedCandidates } from "./run.mjs";

const here = dirname(fileURLToPath(import.meta.url));

if (!process.env.DEEPSEEK_API_KEY) {
  for (const path of [
    join(here, ".env.local"),
    join(here, "..", "..", ".env.local"),
    join(here, "..", "..", "..", "..", ".env.local"),
  ]) {
    if (!existsSync(path)) continue;
    const text = await readFile(path, "utf8");
    for (const line of text.split("\n")) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (!match || process.env[match[1]] !== undefined) continue;
      process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
    }
  }
}
if (!process.env.DEEPSEEK_API_KEY) {
  console.error("Set DEEPSEEK_API_KEY (or place it in the repo-root .env.local).");
  process.exit(1);
}

const count = Number(process.argv[2] ?? 12);
const dataDir = await mkdtemp(join(tmpdir(), "demo-compaction-probe-"));
const world = localWorld({ dataDir });

try {
  const runId = `run_compaction_probe_${count}`;
  const { result, candidates, subRuns } = await runDelegatedCandidates({
    count,
    world,
    runId,
    // Aggressively low so any accumulated bulk is elided; recent turns kept so
    // the model retains working context.
    compaction: { maxChars: 1_500, keepRecentMessages: 4, minElideChars: 150 },
  });

  // Scan every run's model calls for the elision marker.
  const runIds = [runId, ...subRuns.map((r) => r.runId).filter(Boolean)];
  let compactedCalls = 0;
  let modelCalls = 0;
  for (const id of runIds) {
    const events = await listEvents(world, id).catch(() => []);
    for (const event of events) {
      if (event.type !== "harness.model.called") continue;
      modelCalls += 1;
      if (JSON.stringify(event.payload?.request?.messages ?? "").includes("context-compacted")) {
        compactedCalls += 1;
      }
    }
  }

  console.log(
    `status: ${result.status} | candidates: ${candidates.length} | ` +
      `sub-runs: ${subRuns.length} (${subRuns.filter((r) => r.status === "completed").length} completed)`,
  );
  console.log(`model calls: ${modelCalls} | compacted (elision marker present): ${compactedCalls}`);

  if (result.status !== "completed") {
    console.error("REGRESSION: run did not complete with compaction active in the path.");
    process.exit(1);
  }
  console.log(
    compactedCalls > 0
      ? "OK — compaction fired live and the flow completed."
      : "OK — flow completed with compaction active (no bulk large enough to elide this run; " +
        "firing is proven deterministically in the harness tests).",
  );
} finally {
  await rm(dataDir, { recursive: true, force: true });
}
