import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "./cli-core.js";
import { appendEvent, localWorld } from "./index.js";
import { materializeRunStateFromEvents } from "./run-state.js";
import { formatRunReport, runReport } from "./run-report.js";
import type { EventEnvelope, EventType } from "./world.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function event(
  runId: string,
  sequence: number,
  type: string,
  payload: Record<string, unknown>,
): EventEnvelope {
  return {
    eventId: `${runId}_${sequence}`,
    runId,
    sequence,
    type: type as EventType,
    recordedAt: new Date(`2026-08-07T00:00:${String(sequence).padStart(2, "0")}Z`).toISOString(),
    payload,
  };
}

function modelCall(
  runId: string,
  sequence: number,
  stepPath: string | undefined,
  usage: Record<string, number>,
  model: Record<string, string> | null = { provider: "openai", modelId: "gpt-4o-mini" },
): EventEnvelope {
  return event(runId, sequence, "harness.model.responded", {
    turn: 1,
    ...(stepPath === undefined ? {} : { stepPath }),
    ...(model === null ? {} : { model }),
    response: { text: "ok", usage },
  });
}

function reportForEvents(runId: string, events: readonly EventEnvelope[]) {
  return runReport(materializeRunStateFromEvents(runId, events));
}

describe("run report", () => {
  it("breaks tokens, cache-hit share, and dollars down per step", () => {
    const runId = "run_report";
    const report = reportForEvents(runId, [
      event(runId, 1, "RunStarted", { workflowVersionId: "wfver_1" }),
      event(runId, 2, "StepAttemptStarted", { stepPath: "extract", attemptId: "a1" }),
      modelCall(runId, 3, "extract", {
        inputTokens: 20_000,
        cachedInputTokens: 16_000,
        outputTokens: 10_000,
      }),
      event(runId, 4, "StepCompleted", { stepPath: "extract" }),
      event(runId, 5, "StepAttemptStarted", { stepPath: "summarize", attemptId: "a1" }),
      modelCall(runId, 6, "summarize", { inputTokens: 20_000, outputTokens: 10_000 }),
      event(runId, 7, "StepCompleted", { stepPath: "summarize" }),
      event(runId, 8, "RunCompleted", {}),
    ]);

    const extract = report.steps.find((step) => step.stepPath === "extract");
    const summarize = report.steps.find((step) => step.stepPath === "summarize");

    // extract:   4,000 uncached x $0.150/1M + 16,000 cached x $0.075/1M
    //          + 10,000 output  x $0.600/1M = $0.0078, 80% cache hit
    expect(extract?.cacheHitShare).toBeCloseTo(0.8, 12);
    expect(extract?.costUsd).toBeCloseTo(0.0078, 12);
    // summarize: no cache hits, so the full input rate applies = $0.009
    expect(summarize?.cacheHitShare).toBe(0);
    expect(summarize?.costUsd).toBeCloseTo(0.009, 12);

    expect(report.total.costUsd).toBeCloseTo(0.0168, 12);
    expect(report.total.inputTokens).toBe(40_000);
    expect(report.hasUnpricedCalls).toBe(false);
    expect(report.unattributed).toBeUndefined();
  });

  it("surfaces model calls that carry no step attribution", () => {
    const runId = "run_unattributed";
    const report = reportForEvents(runId, [
      event(runId, 1, "RunStarted", { workflowVersionId: "wfver_1" }),
      modelCall(runId, 2, undefined, { inputTokens: 20_000, outputTokens: 0 }),
      modelCall(runId, 3, "summarize", { inputTokens: 0, outputTokens: 10_000 }),
      event(runId, 4, "RunCompleted", {}),
    ]);

    expect(report.unattributed?.inputTokens).toBe(20_000);
    expect(report.unattributed?.costUsd).toBeCloseTo(0.003, 12);
    // Per-step rows plus the unattributed row reconcile with the run total.
    expect(report.total.costUsd).toBeCloseTo(0.009, 12);
  });

  it("flags unpriced calls instead of folding them into the dollar total", () => {
    const runId = "run_report_unpriced";
    const report = reportForEvents(runId, [
      event(runId, 1, "RunStarted", { workflowVersionId: "wfver_1" }),
      modelCall(runId, 2, "priced", { inputTokens: 20_000, outputTokens: 10_000 }),
      modelCall(runId, 3, "mystery", { inputTokens: 999, outputTokens: 999 }, {
        provider: "acme",
        modelId: "unknown",
      }),
      event(runId, 4, "RunCompleted", {}),
    ]);

    expect(report.hasUnpricedCalls).toBe(true);
    expect(report.total.unpricedCalls).toBe(1);
    expect(report.total.costUsd).toBeCloseTo(0.009, 12);
    expect(report.steps.find((step) => step.stepPath === "mystery")?.costUsd).toBeNull();
  });

  it("renders a table with an unpriced-call note", () => {
    const runId = "run_report_table";
    const report = reportForEvents(runId, [
      event(runId, 1, "RunStarted", { workflowVersionId: "wfver_1" }),
      modelCall(runId, 2, "extract", {
        inputTokens: 20_000,
        cachedInputTokens: 16_000,
        outputTokens: 10_000,
      }),
      modelCall(runId, 3, "mystery", { inputTokens: 10, outputTokens: 10 }, null),
      event(runId, 4, "RunCompleted", {}),
    ]);

    const table = formatRunReport(report);

    expect(table).toContain("STEP");
    expect(table).toContain("CACHE%");
    expect(table).toContain("80.0%");
    expect(table).toContain("0.007800");
    // An unpriced row reads `n/a`, never `0.000000`.
    expect(table).toContain("n/a");
    expect(table).toContain("TOTAL");
    expect(table).toContain("1 model call(s) had no registry pricing");
  });

  it("renders a sub-micro-dollar cost distinctly from a genuine zero", () => {
    // One gpt-4o-mini call with a single input token costs $0.00000015, which
    // `toFixed(6)` renders as `0.000000` — the same string a step that spent nothing
    // produces. The docs promise `n/a`, `0`, and a real number are all distinguishable,
    // so real money below the display threshold must not read as zero.
    const runId = "run_report_submicro";
    const report = reportForEvents(runId, [
      event(runId, 1, "RunStarted", { workflowVersionId: "wfver_1" }),
      modelCall(runId, 2, "tiny", { inputTokens: 1, outputTokens: 0 }),
      event(runId, 3, "RunCompleted", {}),
    ]);

    // The JSON figure stays exact — this is a rendering fix only.
    expect(report.total.costUsd).toBeCloseTo(1.5e-7, 15);

    const table = formatRunReport(report);
    expect(table).toContain("<0.000001");
    expect(table).not.toContain("0.000000");
    // Column padding is computed from the rendered strings, so the wider cell still
    // right-aligns under the header rather than overflowing it.
    const costColumn = table
      .split("\n")
      .filter((row) => row.includes("<0.000001"))
      .map((row) => row.length);
    expect(new Set(costColumn).size).toBe(1);
  });

  it("still renders a genuine zero-dollar total as 0.000000", () => {
    const runId = "run_report_zero";
    const report = reportForEvents(runId, [
      event(runId, 1, "RunStarted", { workflowVersionId: "wfver_1" }),
      modelCall(runId, 2, "free", { inputTokens: 0, outputTokens: 0 }),
      event(runId, 3, "RunCompleted", {}),
    ]);

    expect(report.total.costUsd).toBe(0);
    const table = formatRunReport(report);
    expect(table).toContain("0.000000");
    expect(table).not.toContain("<0.000001");
  });
});

describe("little report CLI", () => {
  async function worldWithRun(runId: string): Promise<string> {
    const dataDir = await mkdtemp(join(tmpdir(), "little-report-cli-"));
    tempDirs.push(dataDir);
    const world = localWorld({ dataDir });
    await appendEvent(world, runId, {
      type: "RunStarted",
      payload: { workflowVersionId: "wfver_report" },
    });
    await appendEvent(world, runId, {
      type: "harness.model.responded" as EventType,
      payload: {
        turn: 1,
        stepPath: "summarize",
        model: { provider: "openai", modelId: "gpt-4o-mini" },
        response: {
          text: "ok",
          usage: { inputTokens: 20_000, cachedInputTokens: 16_000, outputTokens: 10_000 },
        },
      },
    });
    await appendEvent(world, runId, { type: "RunCompleted", payload: {} });
    return dataDir;
  }

  it("emits JSON by default", async () => {
    const runId = "run_cli_report_json";
    const dataDir = await worldWithRun(runId);
    let out = "";

    const code = await runCli(["report", runId, "--data-dir", dataDir], {
      stdout: (text) => {
        out += text;
      },
    });

    expect(code).toBe(0);
    const parsed = JSON.parse(out) as {
      runId: string;
      steps: { stepPath: string; costUsd: number; cacheHitShare: number }[];
      total: { costUsd: number };
    };
    expect(parsed.runId).toBe(runId);
    expect(parsed.steps[0]?.stepPath).toBe("summarize");
    expect(parsed.steps[0]?.cacheHitShare).toBeCloseTo(0.8, 12);
    expect(parsed.total.costUsd).toBeCloseTo(0.0078, 12);
  });

  it("renders a table with --table", async () => {
    const runId = "run_cli_report_table";
    const dataDir = await worldWithRun(runId);
    let out = "";

    const code = await runCli(["report", runId, "--table", "--data-dir", dataDir], {
      stdout: (text) => {
        out += text;
      },
    });

    expect(code).toBe(0);
    expect(out).toContain("summarize");
    expect(out).toContain("80.0%");
    expect(out).toContain("0.007800");
  });

  it("reports usage errors for a malformed invocation", async () => {
    let err = "";
    const code = await runCli(["report"], {
      stderr: (text) => {
        err += text;
      },
    });

    expect(code).toBe(1);
    expect(err).toContain("Usage: little report <run-id>");
  });
});
