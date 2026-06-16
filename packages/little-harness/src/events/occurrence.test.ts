import { describe, expect, it } from "vitest";
import { emitHarnessOccurrence } from "./occurrence.js";

describe("emitHarnessOccurrence", () => {
  it("projects one logical occurrence to durability and trace sinks", async () => {
    const durable: unknown[] = [];
    const trace: unknown[] = [];

    await emitHarnessOccurrence({
      type: "harness.model.called",
      runId: "run_1",
      occurrenceId: "occ_1",
      payload: { turn: 1, request: { model: "test", messages: [], tools: [] } },
      metadata: {
        stepNumber: 1,
        request: { messages: [{ role: "user", content: { ref: "r1" } }] },
      },
      durability: {
        append: async (event) => {
          durable.push(event);
        },
      },
      trace: {
        append: async (event) => {
          trace.push(event);
        },
      },
    });

    expect(durable).toEqual([
      {
        type: "harness.model.called",
        runId: "run_1",
        occurrenceId: "occ_1",
        payload: { turn: 1, request: { model: "test", messages: [], tools: [] } },
      },
    ]);
    expect(trace).toEqual([
      {
        type: "harness.model.called",
        occurrenceId: "occ_1",
        metadata: {
          stepNumber: 1,
          request: { messages: [{ role: "user", content: { ref: "r1" } }] },
        },
      },
    ]);
  });

  it("does not fail durable emission when the trace sink fails", async () => {
    const durable: unknown[] = [];
    const traceErrors: unknown[] = [];

    await emitHarnessOccurrence({
      type: "harness.session.started",
      runId: "run_1",
      occurrenceId: "occ_trace_fail",
      payload: { runId: "run_1" },
      metadata: { runId: "run_1" },
      durability: {
        append: async (event) => {
          durable.push(event);
        },
      },
      trace: {
        append: async () => {
          throw new Error("trace unavailable");
        },
      },
      onTraceError: async (error) => {
        traceErrors.push(error);
      },
    });

    expect(durable).toHaveLength(1);
    expect(traceErrors).toHaveLength(1);
  });
});
