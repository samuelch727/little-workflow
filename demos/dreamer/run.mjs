#!/usr/bin/env node
/**
 * dreamer driver.
 *
 *   node run.mjs --harness kb-librarian
 *   node run.mjs --harness kb-librarian --control-plane http://localhost:3000
 *   node run.mjs --harness kb-librarian --dry-run
 *
 * Runs ONE investigation against a live littleDB control plane and prints what the agent
 * did: the tool-call trace, and the proposal it submitted (or, with `--dry-run`, the body it
 * would have submitted).
 *
 * The loop itself lives in `agents/dreamer/investigate.ts`, which the tests drive directly.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const demoRoot = dirname(fileURLToPath(import.meta.url));
// `little-harness`'s module loader roots jiti at `process.cwd()` so an agent's bare imports
// resolve against the app's node_modules. Run from the demo root, or nothing resolves.
process.chdir(demoRoot);

const argv = process.argv.slice(2);

function optionValue(name) {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

const harness = optionValue("--harness");
const dryRun = argv.includes("--dry-run");
const controlPlaneUrl = optionValue("--control-plane");

if (harness === undefined || harness.length === 0) {
  console.error("Usage: node run.mjs --harness <slug> [--control-plane URL] [--dry-run]");
  process.exit(2);
}

const jiti = createJiti(join(demoRoot, "_dreamer_root_.js"), { interopDefault: false });
const { formatToolTrace, runInvestigation } = await jiti.import(
  join(demoRoot, "agents", "dreamer", "investigate.ts"),
);

console.log(`dreamer — investigating harness '${harness}'`);
console.log(
  `control plane: ${controlPlaneUrl ?? process.env.LITTLEDB_URL ?? "http://localhost:3000 (default)"}`,
);
console.log(
  dryRun
    ? "mode:          DRY RUN — nothing will be submitted."
    : "mode:          live — a proposal will be submitted.",
);

const result = await runInvestigation({
  harness,
  dryRun,
  ...(controlPlaneUrl === undefined ? {} : { controlPlaneUrl }),
});

const { lines, totals } = formatToolTrace(result.toolCalls);
console.log(`\n--- tool calls (${result.toolCalls.length}) ---`);
for (const line of lines) console.log(line);
if (totals.length > 0) console.log(`  totals: ${totals}`);

console.log("\n--- the dreamer's report ---");
console.log(result.text.trim() || "(no text)");

if (dryRun) {
  console.log(`\n--- would-be proposal POST bodies (${result.dryRunSubmissions.length}) ---`);
  if (result.dryRunSubmissions.length === 0) {
    console.log("(none — the agent never called littledb_submit_proposal)");
  }
  for (const body of result.dryRunSubmissions) {
    console.log(JSON.stringify(body, null, 2));
  }
  process.exitCode = result.dryRunSubmissions.length > 0 ? 0 : 1;
} else {
  const calls = result.toolCalls.filter((call) => call.toolName === "littledb_submit_proposal");
  console.log("\n--- submission ---");
  console.log(`littledb_submit_proposal calls: ${calls.length}`);
  console.log(`POSTs that reached the control plane: ${result.submitAttempts[harness] ?? 0}`);
  for (const proposal of result.submittedProposals) {
    console.log(`ACCEPTED  proposal id: ${proposal.proposalId ?? "(not named in the response)"}`);
  }
  if (result.submittedProposals.length === 0) {
    console.log("No proposal was accepted. See the report above for why.");
  }
  process.exitCode = result.submittedProposals.length > 0 ? 0 : 1;
}

console.log(`\nsession: ${result.session?.id ?? "(unknown)"}`);
