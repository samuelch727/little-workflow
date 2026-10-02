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

/** Emits a priced model call attributed to `stepPath`. */
function modelResponded(
  runId: string,
  sequence: number,
  stepPath: string,
  usage: Record<string, number>,
  // `null` records a call with no model identity at all (not the default model).
  model: Record<string, string> | null = { provider: "openai", modelId: "gpt-4o-mini" },
): EventEnvelope {
  return event(runId, sequence, "harness.model.responded" as EventType, {
    turn: 1,
    stepPath,
    ...(model === null ? {} : { model }),
    response: { text: "ok", usage },
  });
}

describe("run-state cost pricing", () => {
  it("prices model calls from registry rates rather than reading a recorded cost", () => {
    const runId = "run_priced";
    const state = materializeRunStateFromEvents(runId, [
      event(runId, 1, "RunStarted", { workflowVersionId: "wfver_123" }),
      modelResponded(runId, 2, "summarize", { inputTokens: 20_000, outputTokens: 10_000 }),
      event(runId, 3, "RunCompleted", {}),
    ]);

    // openai/gpt-4o-mini: 20,000 input x $0.15/1M = $0.003
    //                     10,000 output x $0.60/1M = $0.006  => $0.009
    expect(state.usage.inputTokens).toBe(20_000);
    expect(state.usage.outputTokens).toBe(10_000);
    expect(state.usage.costUsd).toBeCloseTo(0.009, 12);
    expect(state.usage.pricedCalls).toBe(1);
  });

  it("bills cache hits at the cached-input rate", () => {
    const runId = "run_cached";
    const state = materializeRunStateFromEvents(runId, [
      event(runId, 1, "RunStarted", { workflowVersionId: "wfver_123" }),
      modelResponded(runId, 2, "summarize", {
        inputTokens: 20_000,
        cachedInputTokens: 16_000,
        outputTokens: 10_000,
      }),
      event(runId, 3, "RunCompleted", {}),
    ]);

    //  4,000 uncached x $0.150/1M = $0.0006
    // 16,000 cached   x $0.075/1M = $0.0012
    // 10,000 output   x $0.600/1M = $0.0060  => $0.0078
    expect(state.usage.cachedInputTokens).toBe(16_000);
    expect(state.usage.costUsd).toBeCloseTo(0.0078, 12);
  });

  it("attributes usage and cost to the step that emitted each call", () => {
    const runId = "run_per_step";
    const state = materializeRunStateFromEvents(runId, [
      event(runId, 1, "RunStarted", { workflowVersionId: "wfver_123" }),
      modelResponded(runId, 2, "extract", { inputTokens: 20_000, outputTokens: 0 }),
      modelResponded(runId, 3, "summarize", { inputTokens: 0, outputTokens: 10_000 }),
      event(runId, 4, "RunCompleted", {}),
    ]);

    expect(state.steps.extract?.usage.inputTokens).toBe(20_000);
    expect(state.steps.extract?.usage.costUsd).toBeCloseTo(0.003, 12);
    expect(state.steps.summarize?.usage.outputTokens).toBe(10_000);
    expect(state.steps.summarize?.usage.costUsd).toBeCloseTo(0.006, 12);
    // Run total is the sum of the per-step totals.
    expect(state.usage.costUsd).toBeCloseTo(0.009, 12);
  });

  it("does not double-count the harness.session.completed token rollup", () => {
    const runId = "run_no_double_count";
    const state = materializeRunStateFromEvents(runId, [
      event(runId, 1, "RunStarted", { workflowVersionId: "wfver_123" }),
      modelResponded(runId, 2, "summarize", { inputTokens: 20_000, outputTokens: 10_000 }),
      // The harness re-reports the same tokens as a session rollup. Counting it would
      // double every model call in the session.
      event(runId, 3, "harness.session.completed" as EventType, {
        runId,
        usage: { inputTokens: 20_000, outputTokens: 10_000 },
      }),
      event(runId, 4, "RunCompleted", {}),
    ]);

    expect(state.usage.inputTokens).toBe(20_000);
    expect(state.usage.outputTokens).toBe(10_000);
    expect(state.usage.pricedCalls).toBe(1);
    expect(state.usage.costUsd).toBeCloseTo(0.009, 12);
  });

  it("ignores a cost figure that somehow reaches an event payload", () => {
    const runId = "run_inert_cost";
    const state = materializeRunStateFromEvents(runId, [
      event(runId, 1, "RunStarted", { workflowVersionId: "wfver_123" }),
      modelResponded(runId, 2, "summarize", {
        inputTokens: 20_000,
        outputTokens: 10_000,
        costUsd: 999,
      }),
      event(runId, 3, "RunCompleted", {}),
    ]);

    // Priced from tokens; the stray figure is inert rather than summed.
    expect(state.usage.costUsd).toBeCloseTo(0.009, 12);
  });

  it("reports an unpriced call as null cost, never as $0", () => {
    const runId = "run_unpriced";
    const state = materializeRunStateFromEvents(runId, [
      event(runId, 1, "RunStarted", { workflowVersionId: "wfver_123" }),
      modelResponded(runId, 2, "summarize", { inputTokens: 100, outputTokens: 50 }, {
        provider: "acme",
        modelId: "not-in-registry",
      }),
      event(runId, 3, "RunCompleted", {}),
    ]);

    expect(state.usage.costUsd).toBeNull();
    expect(state.usage.unpricedCalls).toBe(1);
    expect(state.usage.inputTokens).toBe(100);
    expect(state.steps.summarize?.usage.costUsd).toBeNull();
  });

  it("reports an unpriced call when the event carries no model identity", () => {
    const runId = "run_no_identity";
    const state = materializeRunStateFromEvents(runId, [
      event(runId, 1, "RunStarted", { workflowVersionId: "wfver_123" }),
      modelResponded(runId, 2, "summarize", { inputTokens: 100, outputTokens: 50 }, null),
      event(runId, 3, "RunCompleted", {}),
    ]);

    expect(state.usage.costUsd).toBeNull();
    expect(state.usage.unpricedCalls).toBe(1);
  });

  it("keeps a partial total plus an unpriced count when calls are mixed", () => {
    const runId = "run_mixed";
    const state = materializeRunStateFromEvents(runId, [
      event(runId, 1, "RunStarted", { workflowVersionId: "wfver_123" }),
      modelResponded(runId, 2, "priced", { inputTokens: 20_000, outputTokens: 10_000 }),
      modelResponded(runId, 3, "unpriced", { inputTokens: 100, outputTokens: 50 }, {
        provider: "acme",
        modelId: "not-in-registry",
      }),
      event(runId, 4, "RunCompleted", {}),
    ]);

    expect(state.usage.costUsd).toBeCloseTo(0.009, 12);
    expect(state.usage.pricedCalls).toBe(1);
    expect(state.usage.unpricedCalls).toBe(1);
    expect(state.steps.unpriced?.usage.costUsd).toBeNull();
  });

  it("reports a genuine zero for a run that made no model calls", () => {
    const runId = "run_no_calls";
    const state = materializeRunStateFromEvents(runId, [
      event(runId, 1, "RunStarted", { workflowVersionId: "wfver_123" }),
      event(runId, 2, "RunCompleted", {}),
    ]);

    expect(state.usage.costUsd).toBe(0);
    expect(state.usage.pricedCalls).toBe(0);
    expect(state.usage.unpricedCalls).toBe(0);
  });
});
