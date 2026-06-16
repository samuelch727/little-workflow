import { describe, expect, it } from "vitest";
import type { EventEnvelope, EventType } from "./world.js";
import { materializeRunStateFromEvents } from "./run-state.js";

function event(
  runId: string,
  sequence: number,
  type: EventType | string,
  payload: Record<string, unknown>,
): EventEnvelope {
  return {
    eventId: `${runId}_${sequence}_${type}`,
    runId,
    sequence,
    type: type as EventType,
    recordedAt: new Date(`2026-05-22T00:00:${String(sequence).padStart(2, "0")}Z`).toISOString(),
    payload,
  };
}

describe("run-state harness materialization", () => {
  it("adds HarnessSessionCompleted usage into run usage totals", () => {
    const runId = "run_harness_usage";
    const state = materializeRunStateFromEvents(runId, [
      event(runId, 1, "RunStarted", { workflowVersionId: "wfver_123" }),
      event(runId, 2, "HarnessSessionCompleted", {
        runId,
        usage: { inputTokens: 11, outputTokens: 5, costUsd: 0.015 },
      }),
      event(runId, 3, "HarnessSessionCompleted", {
        runId,
        usage: { inputTokens: 7, outputTokens: 3, costUsd: 0.01 },
      }),
      event(runId, 4, "RunCompleted", {}),
    ]);

    expect(state.usage).toEqual({
      inputTokens: 18,
      outputTokens: 8,
      costUsd: 0.025,
    });
  });

  it("adds dotted harness.session.completed usage into run usage totals", () => {
    const runId = "run_harness_dotted_usage";
    const state = materializeRunStateFromEvents(runId, [
      event(runId, 1, "RunStarted", { workflowVersionId: "wfver_123" }),
      event(runId, 2, "harness.session.completed" as EventType, {
        runId,
        usage: { inputTokens: 3, outputTokens: 2, costUsd: 0.004 },
      }),
      event(runId, 3, "RunCompleted", {}),
    ]);

    expect(state.usage).toEqual({
      inputTokens: 3,
      outputTokens: 2,
      costUsd: 0.004,
    });
  });
});
