import { describe, expect, it } from "vitest";
import {
  canonicalHarnessEventRequestDigest,
  createHarnessAppendIdempotencyKey,
  emitHarnessOccurrence,
  normalizeDurableHarnessEventInput,
} from "./occurrence.js";

describe("emitHarnessOccurrence", () => {
  it("derives stable phase-specific append keys distinct from causal occurrence ids", () => {
    const base = {
      runId: "run_1",
      logicalEventId: "model-call-1",
    } as const;
    const called = createHarnessAppendIdempotencyKey({
      ...base,
      eventType: "harness.model.called",
    });
    expect(called).toBe(createHarnessAppendIdempotencyKey({
      ...base,
      eventType: "harness.model.called",
    }));
    expect(called).not.toBe("model-call-1");
    expect(called).not.toBe(createHarnessAppendIdempotencyKey({
      ...base,
      eventType: "harness.model.responded",
    }));
  });

  it("normalizes wire JSON before producing a canonical request digest", () => {
    const input = {
      type: "harness.session.started",
      runId: "run_1",
      appendIdempotencyKey: "append-normalization-0001",
      payload: { keep: true, omitted: undefined, array: [1, undefined] },
    };
    const normalized = normalizeDurableHarnessEventInput(input);
    expect(normalized.payload).toEqual({ keep: true, array: [1, null] });
    expect(canonicalHarnessEventRequestDigest(input)).toBe(
      canonicalHarnessEventRequestDigest(normalized),
    );
    expect(() => normalizeDurableHarnessEventInput({ ...input, futureField: true }))
      .toThrow(/unknown field/u);
  });

  it("normalizes sparse arrays exactly as a JSON transport would", () => {
    const values = ["first", , undefined, "last"];
    const normalized = normalizeDurableHarnessEventInput({
      type: "harness.session.started",
      runId: "run_1",
      appendIdempotencyKey: "append-sparse-array-0001",
      payload: { values },
    });

    expect(normalized.payload).toEqual({ values: ["first", null, null, "last"] });
  });

  it("rejects accessors without invoking them", () => {
    let invoked = false;
    const payload = Object.defineProperty({}, "secret", {
      enumerable: true,
      get() {
        invoked = true;
        throw new Error("getter should not run");
      },
    });

    expect(() => normalizeDurableHarnessEventInput({
      type: "harness.session.started",
      runId: "run_1",
      appendIdempotencyKey: "append-accessor-0001",
      payload,
    })).toThrow(/enumerable data property/u);
    expect(invoked).toBe(false);
  });

  it("rejects hidden, symbol, and custom array fields that cannot cross the wire", () => {
    const hidden = Object.defineProperty({ visible: true }, "hidden", {
      enumerable: false,
      value: "secret",
    });
    const symbol = { visible: true } as Record<PropertyKey, unknown>;
    symbol[Symbol("secret")] = true;
    const customArray = [1, 2] as number[] & { extra?: boolean };
    customArray.extra = true;
    const base = {
      type: "harness.session.started",
      runId: "run_1",
      appendIdempotencyKey: "append-shape-validation-0001",
    } as const;

    expect(() => normalizeDurableHarnessEventInput({ ...base, payload: hidden }))
      .toThrow(/enumerable data property/u);
    expect(() => normalizeDurableHarnessEventInput({ ...base, payload: symbol }))
      .toThrow(/symbol/u);
    expect(() => normalizeDurableHarnessEventInput({ ...base, payload: { customArray } }))
      .toThrow(/custom or symbol fields/u);
  });

  it("preserves JSON object keys named __proto__ as data", () => {
    const payload = JSON.parse('{"__proto__":{"safe":true}}') as Record<string, unknown>;
    const normalized = normalizeDurableHarnessEventInput({
      type: "harness.session.started",
      runId: "run_1",
      appendIdempotencyKey: "append-proto-key-0001",
      payload,
    });

    const normalizedPayload = normalized.payload;
    expect(normalizedPayload).toBeDefined();
    if (normalizedPayload === undefined) throw new Error("expected inline payload");
    expect(Object.hasOwn(normalizedPayload, "__proto__")).toBe(true);
    expect(normalizedPayload["__proto__"]).toEqual({ safe: true });
    expect(Object.getPrototypeOf(normalizedPayload)).toBe(Object.prototype);
  });

  it("projects one logical occurrence to durability and trace sinks", async () => {
    const durable: unknown[] = [];
    const trace: unknown[] = [];

    await emitHarnessOccurrence({
      type: "harness.model.called",
      runId: "run_1",
      appendIdempotencyKey: "append_occurrence_0001",
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
        appendIdempotencyKey: "append_occurrence_0001",
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
      appendIdempotencyKey: "append_occurrence_0002",
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
