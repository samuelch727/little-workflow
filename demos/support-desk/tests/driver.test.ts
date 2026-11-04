import { execFile } from "node:child_process";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { STUB_API_KEY, startStubLittleDb, type StubLittleDb } from "./support/stub-littledb";

/**
 * The driver, as a real subprocess, against a stub LittleDB.
 *
 * Only the model is a stand-in (installed through the same `globalThis` seam production
 * uses, via the `--import` preload). The tools, the episode store, the grader, the LittleDB
 * client and its wire contract are all the real ones, so this is where the wiring gets
 * checked: does `SUPPORT_PROMPT_FILE` actually reach LittleDB as the bootstrap prompt, are
 * tier A and B episodes scored and tier C not, does the worker run what it is handed — and,
 * the one that cannot be checked from inside the demo, does `--gate` really send NOTHING.
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
        LITTLEDB_URL: stub.url,
        LITTLEDB_API_KEY: STUB_API_KEY,
        LITTLEDB_HARNESS: "support-desk-test",
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

it("refuses to run when LittleDB is unreachable", async () => {
  // A traffic run against a dead LittleDB would burn model calls on an experiment that never
  // happened: no version, no traces, no scores, nothing recorded anywhere.
  const result = await runDriver(["--traffic", "--only", "o01"], { env: { LITTLEDB_URL: "http://127.0.0.1:1" } });
  expect(result.code).not.toBe(0);
  expect(result.stdout).toContain("UNREACHABLE");
  expect(result.stderr).toContain("LittleDB is not reachable");
});

describe("--traffic", () => {
  it("runs, grades, traces, persists, and scores every tier but C", async () => {
    // One of each tier: a fair refund (v1 gets the outcome right and the process wrong), a
    // tier-B window trap (v1 refuses; pushback fires), and a tier-C trap (no scores at all).
    const result = await runDriver(["--traffic", "--only", "o01,o15,o18"]);
    expect(result.code, result.stderr).toBe(0);
    expect(stub.unauthorized).toEqual([]);

    // The bootstrap prompt really is the deliberately-flawed v1, and it reached LittleDB
    // rather than being applied locally. One resolve per session, sticky on the session.
    expect(stub.resolves).toHaveLength(3);
    expect(stub.resolves[0]?.bootstrapSystem).toContain("30 days from the order date");
    expect(stub.resolves.map((entry) => entry.slug)).toEqual(["support-desk-test", "support-desk-test", "support-desk-test"]);
    expect(stub.resolves.every((entry) => entry.stickyKey?.startsWith("sd-"))).toBe(true);
    // The bootstrap-drift guard is wired and quiet: what came back is what the file says.
    expect(result.stderr).not.toContain("does NOT match");

    const results = newestResults("traffic");
    const byId = Object.fromEntries(results.scenarios.map((record: any) => [record.id, record]));
    expect(results.versionIds).toEqual(["ver_001"]);

    // o01: the two-score split, end to end through the driver.
    expect(byId.o01).toMatchObject({ taskSuccess: true, policyCompliant: false, scored: true, traceId: `sd_${byId.o01.sessionId}` });
    // o15: v1 counts from the purchase date, refuses, and the scripted pushback fires.
    expect(byId.o15).toMatchObject({ taskSuccess: false, turnsRun: 3, scored: true });
    // o18: tier C is scored nothing at all. Its failure exists only in the transcript.
    expect(byId.o18).toMatchObject({ taskSuccess: false, scored: false });

    // Scores: the two reporting tiers, on the episodes' traces.
    const scores = Object.fromEntries(stub.scores.map((score) => [`${score.traceId}:${score.name}`, score.value]));
    expect(scores).toEqual({
      [`${byId.o01.traceId}:task_success`]: 1,
      [`${byId.o01.traceId}:policy_compliance`]: 0,
      [`${byId.o15.traceId}:task_success`]: 0,
      [`${byId.o15.traceId}:policy_compliance`]: expect.any(Number),
    });
    expect(stub.scores.every((score) => score.source === "code")).toBe(true);

    // Traces: one per episode, every turn under it, which is what makes tier C readable by a
    // later reviewer even though it was scored nothing.
    const traces = stub.ingests.flatMap((batch) => batch.traces ?? []);
    expect(new Set(traces.map((trace) => trace.id))).toEqual(new Set([byId.o01.traceId, byId.o15.traceId, byId.o18.traceId]));
    expect(traces.every((trace) => trace.harness === "support-desk-test" && trace.versionId === "ver_001")).toBe(true);
    const spans = stub.ingests.flatMap((batch) => batch.spans ?? []);
    expect(spans.filter((span) => span.traceId === byId.o15.traceId && span.type === "agent" && span.id !== "root")).toHaveLength(3);
    expect(JSON.stringify(spans)).toContain("ORD-");
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
  it("sends nothing: no score, no trace", async () => {
    const result = await runDriver(["--gate", "--only", "g01,g13"], { mockAgent: "oracle" });
    expect(result.code, result.stderr).toBe(0);

    // The version still resolves — the gate measures the version LittleDB is serving, not a
    // local file — but that is the ONLY thing that crosses the wire.
    expect(stub.resolves.length).toBeGreaterThan(0);
    expect(stub.ingests).toEqual([]);
    expect(stub.scores).toEqual([]);

    // And the trap prompt is never seeded in gate mode: a gate that graded the v1 prompt it
    // was supposed to be judging a fix against would be measuring nothing.
    expect(stub.resolves.every((entry) => !entry.bootstrapSystem.includes("30 days from the order date"))).toBe(true);

    const results = newestResults("gate");
    expect(results.scenarios.map((record: any) => record.scored)).toEqual([false, false]);
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

describe("--dataset", () => {
  it("uploads the gate set as holdout and the optimizer set as dev, for this harness", async () => {
    const result = await runDriver(["--dataset"]);
    expect(result.code, result.stderr).toBe(0);
    // The harness exists first, seeded with the v1 prompt like a traffic run.
    expect(stub.resolves[0]?.bootstrapSystem).toContain("30 days from the order date");
    expect(stub.datasets).toEqual([{ id: "dst_1", name: "support-desk-test-scenarios", subject: "harness:support-desk-test" }]);
    const holdout = stub.items.filter((item) => item.split === "holdout");
    const dev = stub.items.filter((item) => item.split === "dev");
    expect(holdout).toHaveLength(15);
    expect(dev).toHaveLength(20);
    expect(holdout.every((item) => item.metadata?.set === "gate" && String(item.metadata?.scenarioId).startsWith("g"))).toBe(true);
    expect(dev.every((item) => String(item.metadata?.scenarioId).startsWith("o"))).toBe(true);
    // The customer's words are the input; the grader's truth is the expectation.
    expect(holdout[0]).toMatchObject({ input: { id: "g01", turns: [expect.any(String)] }, expected: { id: "g01", expect: expect.any(Object) } });
    expect(result.stdout).toContain("holdout 15 (gate set), dev 20 (optimizer set)");

    // A second upload is a no-op, not a duplicate.
    const again = await runDriver(["--dataset"]);
    expect(again.code, again.stderr).toBe(0);
    expect(again.stdout).toContain("already exists");
    expect(stub.items).toHaveLength(35);
  }, 120_000);
});

describe("--worker", () => {
  it("runs the version it is handed on the item, traces the run, and completes it with scores", async () => {
    const gate = JSON.parse(readFileSync(join(DEMO_ROOT, "experiment", "gate-truth.json"), "utf8")).scenarios;
    const g01 = gate.find((scenario: any) => scenario.id === "g01");
    const { turns, ...truth } = g01;
    const instructions = readFileSync(join(DEMO_ROOT, "agents", "support", "instructions.md"), "utf8");
    stub.pendingRuns.push({
      runId: "run_1",
      experimentId: "exp_1",
      traceId: "exp_run_1",
      subjectId: "sub_support-desk-test",
      itemId: "itm_g01",
      versionId: "ver_002",
      repetition: 0,
      leaseUntil: new Date(Date.now() + 600_000).toISOString(),
      subject: { kind: "harness", slug: "support-desk-test" },
      version: { id: "ver_002", number: 2, content: { system: instructions, model: "deepseek-v4-flash" }, externalId: null },
      item: { id: "itm_g01", input: { id: "g01", turns }, expected: truth, metadata: { set: "gate" } },
    });
    const result = await runDriver(["--worker", "--once"], { mockAgent: "oracle" });
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("claimed 1, completed 1, failed 0");

    // No resolve: the worker runs the version LittleDB handed it, not the live one.
    expect(stub.resolves).toEqual([]);
    expect(stub.completions).toEqual([
      {
        runId: "run_1",
        body: expect.objectContaining({
          traceId: "exp_run_1",
          scores: [
            { name: "task_success", value: 1 },
            { name: "policy_compliance", value: 1 },
          ],
        }),
      },
    ]);
    const traces = stub.ingests.flatMap((batch) => batch.traces ?? []);
    expect(traces[0]).toMatchObject({ id: "exp_run_1", kind: "experiment", experimentId: "exp_1", versionId: "ver_002", datasetItemId: "itm_g01", environment: "experiment" });
  }, 120_000);
});

describe("--propose", () => {
  it("proposes a prompt file as a change to the live version", async () => {
    const result = await runDriver(["--propose", "agents/support/instructions.md"]);
    expect(result.code, result.stderr).toBe(0);
    expect(stub.proposals).toHaveLength(1);
    expect(stub.proposals[0]).toMatchObject({
      subject: "harness:support-desk-test",
      baseVersionId: "ver_001",
      changes: { system: expect.stringContaining("Northwind") },
      title: "Prompt from agents/support/instructions.md",
    });
    expect(result.stdout).toContain("proposal prp_1 (open)");
  }, 120_000);
});
