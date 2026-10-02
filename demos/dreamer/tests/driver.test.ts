import { execFile } from "node:child_process";
import { readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeEach, expect, it } from "vitest";
import { formatToolTrace } from "../agents/dreamer/investigate";
import { PATCH } from "./support/investigation-script";
import {
  HARNESS_SLUG,
  QUOTE_CITE_1,
  QUOTE_CITE_2,
  startStubLittleDb,
  type StubLittleDb,
} from "./support/stub-littledb";

const execFileAsync = promisify(execFile);
const DEMO_ROOT = join(import.meta.dirname, "..");
const RUN_MJS = join(DEMO_ROOT, "run.mjs");
const PRELOAD = join(DEMO_ROOT, "tests", "support", "preload-mock-model.mjs");
// A data dir of this file's own: test files run in parallel and the session store lives in
// the checkout, so a shared one means one file deleting another file's live session.
const DATA_DIR = join(tmpdir(), `dreamer-driver-${process.pid}`);

let stub: StubLittleDb;

beforeEach(async () => {
  stub = await startStubLittleDb();
});

afterEach(async () => {
  await stub.close();
});

afterAll(async () => {
  await rm(DATA_DIR, { recursive: true, force: true });
  // Inline workflows spill their sqlite stores next to the driver's cwd, named after the
  // session. Only this file's sessions — a broader glob would delete another file's.
  for (const entry of await readdir(DEMO_ROOT)) {
    if (entry.startsWith(`dream-${HARNESS_SLUG}-`)) {
      await rm(join(DEMO_ROOT, entry), { recursive: true, force: true });
    }
  }
});

type ExecFailure = { code?: number; stdout?: string; stderr?: string };

async function runDriver(
  args: readonly string[],
  options: { env?: Record<string, string>; preloadMockModel?: boolean } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const nodeArgs = [
    ...(options.preloadMockModel === true ? ["--import", PRELOAD] : []),
    RUN_MJS,
    ...args,
  ];
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, nodeArgs, {
      cwd: DEMO_ROOT,
      env: { ...process.env, DREAMER_DATA_DIR: DATA_DIR, ...options.env },
      maxBuffer: 8 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as ExecFailure;
    return { code: failure.code ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

/** Pull the pretty-printed proposal body out of the driver's `--dry-run` output. */
function dryRunBody(stdout: string): Record<string, unknown> {
  const marker = "--- would-be proposal POST bodies";
  const start = stdout.indexOf("{", stdout.indexOf(marker));
  expect(start, "the driver must print a would-be POST body").toBeGreaterThan(-1);
  const end = stdout.lastIndexOf("}");
  return JSON.parse(stdout.slice(start, end + 1)) as Record<string, unknown>;
}

it("run.mjs refuses to start without --harness", async () => {
  const result = await runDriver([]);
  expect(result.code).toBe(2);
  expect(result.stderr).toContain("--harness <slug>");
});

/**
 * The driver loads `agents/dreamer/investigate.ts` through jiti, which pulls in `agent.ts`,
 * `env.ts`, all three tools and all three workflow modules. That chain is easy to break
 * (jiti has to be rooted at the demo root for the agent's bare imports to resolve), and
 * nothing else in the suite exercises it as a real subprocess.
 *
 * `DEEPSEEK_API_KEY=""` is what keeps this offline: an explicitly-set empty value shadows
 * any `.env.local` on the machine (`loadDreamerEnv` never overwrites a defined variable), so
 * `dreamerModel()` throws its own error before a single request is made — to a provider or
 * to a control plane.
 */
it("run.mjs loads the whole agent chain and stops at the missing model credential", async () => {
  const result = await runDriver(["--harness", "kb-librarian", "--dry-run"], {
    env: { DEEPSEEK_API_KEY: "" },
  });

  expect(result.code).not.toBe(0);
  // It got far enough to parse arguments and print the banner…
  expect(result.stdout).toContain("investigating harness 'kb-librarian'");
  expect(result.stdout).toContain("DRY RUN");
  // …and the only thing that stopped it was the credential, from `env.ts`.
  expect(result.stderr).toContain("DEEPSEEK_API_KEY");
  // Nothing resembling a module-resolution failure.
  expect(result.stderr).not.toMatch(/Cannot find (module|package)/);
  // This is the first test to make a child compile the whole agent chain, and jiti's
  // transform cache is cold on a fresh checkout: it took 5038ms on a CI runner, against
  // vitest's 5000ms default. The budget is for a cold compile, not for a hang.
}, 60_000);

/**
 * The acceptance shape, run as a real subprocess against the stub stack: `node run.mjs
 * --harness … --dry-run` walks the whole loop and prints a proposal body whose citations are
 * the fixture's user turns, character for character. Only the model is a stand-in, installed
 * through the same `globalThis` seam production uses.
 */
it("run.mjs --dry-run drives the full loop and prints a citing proposal body", async () => {
  const result = await runDriver(
    ["--harness", HARNESS_SLUG, "--control-plane", stub.controlPlaneUrl, "--dry-run"],
    { preloadMockModel: true, env: { DEEPSEEK_API_KEY: "" } },
  );

  expect(result.stderr, result.stderr).toBe("");
  expect(result.code).toBe(0);

  // The trace the driver prints is the investigation it actually ran.
  expect(result.stdout).toContain("littledb_evidence_pack  ok");
  expect(result.stdout).toContain("dream_incident_card x2");
  expect(result.stdout).toContain("dream_cluster_cards");
  expect(result.stdout).toContain("littledb_submit_proposal");
  expect(result.stdout).toContain("Dominant mode: answers omit their source");

  // Dry run: the control plane served the evidence pack and saw no POST.
  expect(stub.proposals).toHaveLength(0);

  const body = dryRunBody(result.stdout) as {
    origin: string;
    proposedConfigPatch: unknown;
    evidence: { failureSamples: Array<{ runId: string; pushback: string }> };
  };
  expect(body.origin).toBe("dreamer-agent");
  expect(body.proposedConfigPatch).toEqual(PATCH);
  expect(body.evidence.failureSamples.length).toBeGreaterThanOrEqual(2);
  expect(body.evidence.failureSamples.map((sample) => sample.runId)).toEqual([
    "run_cite_1",
    "run_cite_2",
  ]);
  expect(body.evidence.failureSamples.map((sample) => sample.pushback)).toEqual([
    QUOTE_CITE_1,
    QUOTE_CITE_2,
  ]);
}, 180_000);

it("formatToolTrace numbers the calls and totals them by tool", () => {
  const { lines, totals } = formatToolTrace([
    { type: "harness.tool_call.succeeded", toolName: "littledb_evidence_pack", step: "step_1" },
    { type: "harness.tool_call.succeeded", toolName: "dream_incident_card", step: "step_2" },
    { type: "harness.tool_call.succeeded", toolName: "dream_incident_card", step: "step_2" },
    { type: "harness.tool_call.failed", toolName: "littledb_submit_proposal", step: "step_3" },
  ]);

  expect(lines).toHaveLength(4);
  expect(lines[0]).toContain("littledb_evidence_pack  ok  [step_1]");
  expect(lines[3]).toContain("littledb_submit_proposal  FAILED  [step_3]");
  expect(totals).toContain("dream_incident_card x2");
});
