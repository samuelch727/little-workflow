import type { HarnessOutcomeEvent } from "little-harness";
import { describe, expect, it, vi } from "vitest";
import { ReportOutcomeSchema, type ReportOutcome } from "../contract.js";
import { createLittleDbOutcomeSink, toReportOutcome } from "./outcome-sink.js";

function outcome(overrides: Partial<HarnessOutcomeEvent> = {}): HarnessOutcomeEvent {
  return {
    eventId: "evt_1",
    sequence: 3_000_000_000_000_042,
    sessionId: "slack:T1",
    timestamp: "2026-08-07T00:00:00.000Z",
    status: "failure",
    source: "chat-sdk",
    metadata: { surface: { platform: "slack" } },
    ...overrides,
  };
}

describe("createLittleDbOutcomeSink", () => {
  it("maps a harness outcome onto the pinned wire contract", async () => {
    const report = vi.fn(async (_outcome: ReportOutcome) => ({ ok: true }));
    const sink = createLittleDbOutcomeSink({ report });

    await sink.deliver(
      outcome({
        stepPath: "root/draft",
        promptHash: "a".repeat(64),
        reporter: "anon_abc",
        reportKey: "k1",
        turnId: "turn_1",
        score: 0.2,
        detail: "wrong",
      }),
    );

    const sent = report.mock.calls[0]![0];
    // It still validates against the schema littleDB drift-tests against: the join keys ride
    // in `metadata`, not as new top-level fields.
    expect(ReportOutcomeSchema.parse(sent)).toBeTruthy();
    expect(sent).toEqual({
      runId: "harness_slack:T1",
      status: "failure",
      score: 0.2,
      detail: "wrong",
      metadata: {
        surface: { platform: "slack" },
        sessionId: "slack:T1",
        source: "chat-sdk",
        eventId: "evt_1",
        turnId: "turn_1",
        stepPath: "root/draft",
        promptHash: "a".repeat(64),
        reporter: "anon_abc",
        reportKey: "k1",
      },
    });
  });

  it("carries no sequence — littleDB allocates its own side-channel slot on ingest", async () => {
    const report = vi.fn(async (_outcome: ReportOutcome) => ({ ok: true }));
    await createLittleDbOutcomeSink({ report }).deliver(outcome());
    expect(report.mock.calls[0]![0]).not.toHaveProperty("sequence");
  });

  it("keys the run id the same way the trace reporter does, so the join lands", async () => {
    const report = vi.fn(async (_outcome: ReportOutcome) => ({ ok: true }));
    await createLittleDbOutcomeSink({ report }).deliver(outcome({ sessionId: "abc" }));
    expect(report.mock.calls[0]![0].runId).toBe("harness_abc");

    const custom = vi.fn(async (_outcome: ReportOutcome) => ({ ok: true }));
    await createLittleDbOutcomeSink({
      report: custom,
      runIdForSession: (id) => `run-${id}`,
    }).deliver(outcome({ sessionId: "abc" }));
    expect(custom.mock.calls[0]![0].runId).toBe("run-abc");
  });

  it("omits join keys that were never resolved instead of sending nulls", async () => {
    const report = vi.fn(async (_outcome: ReportOutcome) => ({ ok: true }));
    await createLittleDbOutcomeSink({ report }).deliver(outcome());

    const sent = report.mock.calls[0]![0];
    expect(sent.metadata).not.toHaveProperty("promptHash");
    expect(sent.metadata).not.toHaveProperty("stepPath");
    expect(sent).not.toHaveProperty("score");
    expect(sent).not.toHaveProperty("detail");
  });

  it("does not forward a retraction — the wire contract has no withdraw verb", async () => {
    const report = vi.fn(async (_outcome: ReportOutcome) => ({ ok: true }));
    const result = await createLittleDbOutcomeSink({ report }).deliver(
      outcome({ retracted: true }),
    );
    expect(report).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true });
  });

  it("passes a failing POST through as ok:false for the harness to count", async () => {
    const report = vi.fn(async (_outcome: ReportOutcome) => ({ ok: false }));
    expect(await createLittleDbOutcomeSink({ report }).deliver(outcome())).toEqual({ ok: false });
  });
});

describe("toReportOutcome", () => {
  it("preserves the harness status vocabulary verbatim", () => {
    for (const status of ["success", "failure", "partial"] as const) {
      expect(toReportOutcome(outcome({ status })).status).toBe(status);
    }
  });
});
