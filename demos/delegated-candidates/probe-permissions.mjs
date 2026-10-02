/**
 * probe-permissions — a LIVE check that the runtime permission policy is actually
 * exercised (not a no-op) end-to-end through the orchestrated demo.
 *
 *   node probe-permissions.mjs [count]
 *
 * The policy is intentionally non-empty and fires on real tool calls:
 *   - deny `secret_admin_tool`  → a tool nobody calls; proves a deny in the
 *     ruleset does not break the real flow.
 *   - ask  `*_workflow`         → the orchestrator MUST plan/run workflows, so the
 *     gate fires on its real tool calls; onAsk auto-approves and counts them.
 *
 * A passing run shows: status completed, candidates produced, AND onAsk fired
 * (gate is live). Sub-runs inherit only the parent's denies — verified
 * deterministically in runtime.test.ts; here we confirm the live flow survives.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
const asked = [];

const { result, candidates, subRuns } = await runDelegatedCandidates({
  count,
  permissions: {
    ruleset: [
      { tool: "secret_admin_tool", action: "deny" },
      { tool: "*_workflow", action: "ask" },
    ],
    onAsk: async (request) => {
      asked.push(request.tool);
      return true; // auto-approve so the real flow completes
    },
  },
});

const distinct = [...new Set(asked)].sort();
console.log(
  `status: ${result.status} | candidates: ${candidates.length} | ` +
    `sub-runs: ${subRuns.length} (${subRuns.filter((r) => r.status === "completed").length} completed)`,
);
console.log(`permission gate fired (onAsk) ${asked.length}x on: ${distinct.join(", ") || "(none)"}`);

if (result.status !== "completed") {
  console.error("REGRESSION: run did not complete with the policy active.");
  process.exit(1);
}
if (asked.length === 0) {
  console.error("INCONCLUSIVE: the gate never fired — policy may not be reaching the orchestrator.");
  process.exit(1);
}
console.log("OK — policy active, gate fired on real tool calls, flow completed.");
