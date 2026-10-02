import { describe, expect, it } from "vitest";
import { aggregateOutcomes, foldOutcomeReports, outcomeEventFromTrace } from "./aggregate.js";
import type { HarnessOutcomeEvent, HarnessOutcomeStatus } from "./types.js";

let sequence = 3_000_000_000_000_001;

function outcome(
  status: HarnessOutcomeStatus,
  overrides: Partial<HarnessOutcomeEvent> = {},
): HarnessOutcomeEvent {
  sequence += 1;
  return {
    eventId: `evt_${sequence}`,
    sequence,
    sessionId: "slack:T1",
    timestamp: new Date(sequence).toISOString(),
    status,
    source: "chat-sdk",
    metadata: {},
    ...overrides,
  };
}

describe("outcome folding", () => {
  it("counts every report separately when nothing shares a reportKey", () => {
    const folded = foldOutcomeReports([outcome("success"), outcome("failure")]);
    expect(folded.counted).toHaveLength(2);
    expect(folded.supersededCount).toBe(0);
  });

  it("lets the LATEST report for a reportKey win — a thumbs-down toggled to a thumbs-up", () => {
    const down = outcome("failure", { reportKey: "k1" });
    const up = outcome("success", { reportKey: "k1" });
    const folded = foldOutcomeReports([down, up]);

    expect(folded.counted).toHaveLength(1);
    expect(folded.counted[0]?.status).toBe("success");
    // Every report is retained as its own event; only authority is decided at read time.
    expect(folded.eventCount).toBe(2);
    expect(folded.supersededCount).toBe(1);
  });

  it("withdraws a report when its own polarity is retracted (a user un-reacting)", () => {
    const down = outcome("failure", { reportKey: "k1" });
    const undo = outcome("failure", { reportKey: "k1", retracted: true });
    const folded = foldOutcomeReports([down, undo]);

    expect(folded.counted).toHaveLength(0);
    expect(folded.retractedCount).toBe(1);
    expect(folded.clearedCount).toBe(1);
  });

  it("ignores a retraction whose polarity is no longer live, whichever order it arrives in", () => {
    // Slack sends "👎 removed" and "👍 added" as two events with no guaranteed order. The
    // trailing retraction of the OLD polarity must not wipe the new verdict.
    const down = outcome("failure", { reportKey: "k1" });
    const up = outcome("success", { reportKey: "k1" });
    const removeDown = outcome("failure", { reportKey: "k1", retracted: true });

    const removedLast = foldOutcomeReports([down, up, removeDown]);
    expect(removedLast.counted).toHaveLength(1);
    expect(removedLast.counted[0]?.status).toBe("success");
    expect(removedLast.clearedCount).toBe(0);

    const removedFirst = foldOutcomeReports([down, removeDown, up]);
    expect(removedFirst.counted).toHaveLength(1);
    expect(removedFirst.counted[0]?.status).toBe("success");
  });

  it("keeps two raters on the same message distinct", () => {
    const a = outcome("failure", { reportKey: "msg:anon_a" });
    const b = outcome("success", { reportKey: "msg:anon_b" });
    expect(foldOutcomeReports([a, b]).counted).toHaveLength(2);
  });

  it("orders by sequence, not by array order", () => {
    const first = outcome("failure", { reportKey: "k1" });
    const second = outcome("success", { reportKey: "k1" });
    expect(foldOutcomeReports([second, first]).counted[0]?.status).toBe("success");
  });
});

describe("outcome aggregation", () => {
  it("reports a success rate with its sample size at every level", () => {
    const report = aggregateOutcomes([
      outcome("success", { promptHash: "p1" }),
      outcome("failure", { promptHash: "p1" }),
      outcome("success", { promptHash: "p2", stepPath: "root/draft" }),
    ]);

    expect(report.overall).toEqual({ n: 3, success: 2, failure: 1, partial: 0, successRate: 2 / 3 });
    expect(report.byPromptHash).toEqual([
      { key: "p1", n: 2, success: 1, failure: 1, partial: 0, successRate: 0.5 },
      { key: "p2", n: 1, success: 1, failure: 0, partial: 0, successRate: 1 },
    ]);
    expect(report.byStepPath).toEqual([
      { key: "root/draft", n: 1, success: 1, failure: 0, partial: 0, successRate: 1 },
    ]);
    expect(report.unattributed).toEqual({ withoutPromptHash: 0, withoutStepPath: 2 });
  });

  it("computes rates from the FOLDED population and shows what was folded away", () => {
    const report = aggregateOutcomes([
      outcome("failure", { reportKey: "k1", promptHash: "p1" }),
      outcome("success", { reportKey: "k1", promptHash: "p1" }),
    ]);

    expect(report.eventCount).toBe(2);
    expect(report.countedCount).toBe(1);
    expect(report.supersededCount).toBe(1);
    expect(report.overall).toEqual({ n: 1, success: 1, failure: 0, partial: 0, successRate: 1 });
  });

  it("returns a null rate rather than a fabricated zero when there is no sample", () => {
    const report = aggregateOutcomes([]);
    expect(report.overall).toEqual({ n: 0, success: 0, failure: 0, partial: 0, successRate: null });
    expect(report.byPromptHash).toEqual([]);
  });
});

describe("reading outcomes back from a trace", () => {
  it("splits known fields from caller metadata", () => {
    const event = outcomeEventFromTrace({
      schemaVersion: "lh.trace.v2",
      eventId: "evt_1",
      sequence: 3_000_000_000_000_100,
      type: "outcome.reported",
      sessionId: "slack:T1",
      turnId: "turn_1",
      timestamp: "2026-08-07T00:00:00.000Z",
      metadata: {
        status: "failure",
        source: "chat-sdk",
        promptHash: "p1",
        reportKey: "k1",
        reporter: "anon_abc",
        surface: { platform: "slack" },
      },
    });

    expect(event).toEqual({
      eventId: "evt_1",
      sequence: 3_000_000_000_000_100,
      sessionId: "slack:T1",
      turnId: "turn_1",
      timestamp: "2026-08-07T00:00:00.000Z",
      status: "failure",
      source: "chat-sdk",
      promptHash: "p1",
      reportKey: "k1",
      reporter: "anon_abc",
      metadata: { surface: { platform: "slack" } },
    });
  });

  it("ignores non-outcome events and outcomes with an unknown status", () => {
    const base = {
      schemaVersion: "lh.trace.v2" as const,
      eventId: "evt_1",
      sequence: 1,
      sessionId: "s",
      timestamp: "2026-08-07T00:00:00.000Z",
    };
    expect(
      outcomeEventFromTrace({ ...base, type: "harness.session.started", metadata: {} }),
    ).toBeUndefined();
    expect(
      outcomeEventFromTrace({ ...base, type: "outcome.reported", metadata: { status: "meh" } }),
    ).toBeUndefined();
  });
});
