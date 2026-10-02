import { execFile } from "node:child_process";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { startStubLittleDb, type StubLittleDb } from "./support/stub-littledb";

/**
 * The driver, as a real subprocess, against a stub littleDB stack.
 *
 * Only the model is a stand-in (installed through the same `globalThis` seam production
 * uses, via the `--import` preload). The tools, the episode store, the grader, the littleDB
 * client and its wire contract are all the real ones, so this is where the wiring gets
 * checked: does `SUPPORT_PROMPT_FILE` actually reach the control plane as the bootstrap
 * prompt, do outcomes get reported for tier A and B and not for tier C — and, the one that
 * cannot be checked from inside the demo, does `--gate` really send NOTHING.
 */

const execFileAsync = promisify(execFile);
const DEMO_ROOT = join(import.meta.dirname, "..");
const RUN_MJS = join(DEMO_ROOT, "experiment", "run.mjs");
const PRELOAD = join(DEMO_ROOT, "tests", "support", "preload-mock-model.mjs");
// A data dir of this file's own: test files run in parallel and the session store lives in
// the checkout, so a shared one means one file deleting another file's live session.
const DATA_DIR = join(tmpdir(), `support-driver-${process.pid}`);
const RESULTS_DIR = join(DEMO_ROOT, "experiment", ".results");

let stub: StubLittleDb;

beforeEach(async () => {
  stub = await startStubLittleDb();
});

afterEach(async () => {
  await stub.close();
});

afterAll(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  rmSync(join(DEMO_ROOT, ".episodes"), { recursive: true, force: true });
  rmSync(RESULTS_DIR, { recursive: true, force: true });
});

type Run = { code: number; stdout: string; stderr: string };

async function runDriver(
  args: readonly string[],
  options: { env?: Record<string, string>; mockAgent?: string } = {},
): Promise<Run> {
  const nodeArgs = ["--import", PRELOAD, RUN_MJS, ...args];
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, nodeArgs, {
      cwd: DEMO_ROOT,
      env: {
        ...process.env,
        SUPPORT_DATA_DIR: DATA_DIR,
        SUPPORT_MOCK_AGENT: options.mockAgent ?? "v1",
        LITTLEDB_URL: stub.controlPlaneUrl,
        LITTLEDB_ENGINE_URL: stub.engineUrl,
        LITTLEDB_HARNESS_ID: "support-desk-test",
        ...options.env,
      },
      maxBuffer: 16 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

function newestResults(mode: string): Record<string, any> {
  const files = readdirSync(RESULTS_DIR)
    .filter((name) => name.startsWith(`${mode}-`))
    .sort();
  const newest = files.at(-1);
  expect(newest, `a ${mode} results file`).toBeDefined();
  return JSON.parse(readFileSync(join(RESULTS_DIR, newest as string), "utf8"));
}

it("--seed resets the episode area and reports the clock", async () => {
  const result = await runDriver(["--seed"]);
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("26 orders, 8 customers");
  expect(result.stdout).toContain("clock 2026-08-14");
  // A driver subprocess: its startup alone can pass vitest's 5 s default when the
  // monorepo runs every suite at once.
}, 30_000);

it("refuses to run when the stack is unreachable", async () => {
  // A traffic run against a dead control plane would burn model calls on an experiment that
  // never happened: no managed config, no outcomes, nothing recorded anywhere.
  const result = await runDriver(["--traffic", "--only", "o01"], {
    env: { LITTLEDB_URL: "http://127.0.0.1:1", LITTLEDB_ENGINE_URL: "http://127.0.0.1:1" },
  });
  expect(result.code).not.toBe(0);
  expect(result.stdout).toContain("UNREACHABLE");
  expect(result.stderr).toContain("littleDB stack is not reachable");
});

describe("--traffic", () => {
  it("runs, grades, persists, and reports outcomes for every tier but C", async () => {
    // One of each tier: a fair refund (v1 gets the outcome right and the process wrong), a
    // tier-B window trap (v1 refuses; pushback fires), and a tier-C trap (no outcome at all).
    const result = await runDriver(["--traffic", "--only", "o01,o15,o18"]);
    expect(result.code, result.stderr).toBe(0);

    // The bootstrap prompt really is the deliberately-flawed v1, and it reached the control
    // plane rather than being applied locally.
    expect(stub.resolves).toHaveLength(3);
    expect(stub.resolves[0]?.bootstrapPrompt).toContain("30 days from the order date");
    expect(stub.resolves.map((entry) => entry.harnessId)).toEqual([
      "support-desk-test",
      "support-desk-test",
      "support-desk-test",
    ]);
    // The bootstrap-drift guard is wired and quiet: what came back is what the file says.
    // (littleDB seeds the bootstrap once per harness+channel and ignores it afterwards, so a
    // run against a stale slug measures a prompt nobody edited — the driver says so.)
    expect(result.stderr).not.toContain("does NOT match");

    const results = newestResults("traffic");
    const byId = Object.fromEntries(results.scenarios.map((record: any) => [record.id, record]));

    // o01: the two-score split, end to end through the driver.
    expect(byId.o01).toMatchObject({ taskSuccess: true, policyCompliant: false, reactionSent: "partial" });
    // o15: v1 counts from the purchase date, refuses, and the scripted pushback fires.
    expect(byId.o15).toMatchObject({ taskSuccess: false, turnsRun: 3, reactionSent: "failure" });
    // o18: tier C reports nothing at all. Its failure exists only in the transcript.
    expect(byId.o18).toMatchObject({ taskSuccess: false, reactionSent: null });

    // Outcomes: exactly the two reporting tiers, keyed to the same run ids the traces use.
    expect(stub.outcomes.map((outcome) => outcome.status).sort()).toEqual(["failure", "partial"]);
    const reported = stub.outcomes.map((outcome) => outcome.runId);
    expect(reported).toContain(`harness_${byId.o01.sessionId}`);
    expect(reported).not.toContain(`harness_${byId.o18.sessionId}`);

    // Telemetry: the transcripts reached the engine, which is what makes tier C readable by
    // a later dream even though it reported no outcome.
    expect(stub.ingests.length).toBeGreaterThan(0);
    expect(JSON.stringify(stub.ingests)).toContain("o18");
  }, 120_000);

  it("withholds the scripted pushback when the agent grants the ask", async () => {
    // The oracle refunds o15 on turn 1, so the customer never argues — the transcript stays
    // one turn long and no manufactured frustration reaches littleDB.
    const result = await runDriver(["--traffic", "--only", "o15"], { mockAgent: "oracle" });
    expect(result.code, result.stderr).toBe(0);
    const record = newestResults("traffic").scenarios[0];
    expect(record).toMatchObject({ taskSuccess: true, policyCompliant: true, turnsRun: 1, pushbackWithheld: 2 });
    expect(JSON.stringify(record.transcript)).not.toContain("That's not right");
  }, 120_000);
});

describe("--gate", () => {
  it("sends nothing: no outcome, no trace, no reaction", async () => {
    const result = await runDriver(["--gate", "--only", "g01,g13"], { mockAgent: "oracle" });
    expect(result.code, result.stderr).toBe(0);

    // Config still resolves — the gate measures the config littleDB is serving, not a local
    // file — but that is the ONLY thing that crosses the wire.
    expect(stub.resolves.length).toBeGreaterThan(0);
    expect(stub.outcomes).toEqual([]);
    expect(stub.ingests).toEqual([]);
    expect(stub.evalRuns).toEqual([]);

    // And the trap prompt is never seeded in gate mode: a gate that graded the v1 prompt it
    // was supposed to be judging a fix against would be measuring nothing.
    expect(stub.resolves.every((entry) => !entry.bootstrapPrompt.includes("30 days from the order date"))).toBe(true);

    const results = newestResults("gate");
    expect(results.scenarios.map((record: any) => record.reactionSent)).toEqual([null, null]);
    expect(results.overall.task.pass).toBe(2);
  }, 120_000);

  it("repeats each scenario k times and reports pass^k", async () => {
    const result = await runDriver(["--gate", "--only", "g01", "--k", "2"], { mockAgent: "oracle" });
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("pass^2 over 1 scenario(s)");
    // The honesty line: a set this small cannot resolve a small regression, and says so.
    expect(result.stdout).toContain("gross-regression gate");
    const results = newestResults("gate");
    expect(results.scenarios).toHaveLength(2);
    expect(results.passK).toMatchObject({ k: 2, scenarios: 1 });
  }, 120_000);
});
