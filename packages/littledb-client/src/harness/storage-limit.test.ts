import { describe, expect, it } from "vitest";
import type { SpanInput, TraceInput } from "../contract.js";
import { contentValue } from "../util.js";
import { createHarnessTracer } from "./tracer.js";

const omitted = {
  captured: false, truncated: true, unavailableReason: "storage_limit", storageLimitBytes: 1000,
  bytes: 2000, sha256: "a".repeat(64), preview: '{"looks":"complete"}',
};
const missing = { unavailable: true, reason: "storage_limit", storageLimitBytes: 1000, bytes: 2000, sha256: "a".repeat(64) };

describe("declared trace storage limits", () => {
  it("does not parse a known-unavailable preview as a business value", () => {
    expect(contentValue(omitted)).toBeUndefined();
    // Ordinary captured references retain the existing reader contract in this bounded patch.
    expect(contentValue({ captured: true, preview: '{"ordinary":true}' })).toEqual({ ordinary: true });
  });

  it.each([undefined, "shared"])("projects an unavailable request/reply without preview or stale root content (%s)", async traceId => {
    const spans: SpanInput[] = [], traces: TraceInput[] = [];
    const tracer = createHarnessTracer({ harness: "bounded", ...(traceId ? { traceId } : {}) }, {
      exporter: { enqueue: (batch: { spans?: SpanInput[]; traces?: TraceInput[] }) => { spans.push(...(batch.spans ?? [])); traces.push(...(batch.traces ?? [])); } } as never,
      onError: () => {},
    });
    const event = (type: string, metadata: Record<string, unknown> = {}, turnId = "current", stepId = "step1") => tracer.onEvent({ type, metadata, sessionId: "s", turnId, stepId, timestamp: "2026-11-01T00:00:00.000Z" });
    await event("harness.model.called", { request: { messages: [{ role: "user", content: { captured: true, preview: "Prior known question" } }] } }, "prior");
    await event("harness.model.responded", { text: { captured: true, preview: "Prior known reply" } }, "prior");
    await event("harness.session.completed", {}, "prior");
    await event("harness.model.called", { request: { messages: [{ role: "user", content: omitted }] } });
    await event("harness.model.responded", { text: omitted });
    // A later known segment cannot make an omitted part of this turn complete.
    await event("harness.model.responded", { text: { captured: true, preview: "Known final segment" } }, "current", "step2");
    await event("harness.session.completed");
    const turn = spans.filter(span => span.type === "agent" && span.attributes?.turnId === "current").at(-1)!;
    expect(turn.input).toEqual(missing);
    expect(turn.output).toEqual(missing);
    expect(turn.output).not.toHaveProperty("preview");
    expect(turn.output).not.toHaveProperty("contentRef");
    expect(traces.at(-1)?.output).toEqual(missing);
    expect(traces.at(-1)?.input).toEqual(traceId ? "Prior known question" : missing);
    expect(spans.filter(span => span.type === "llm").at(-1)?.output).toEqual({ text: "Known final segment" });
    if (traceId) {
      await event("harness.model.responded", { text: { captured: true, preview: "Next complete turn" } }, "next");
      await event("harness.session.completed", {}, "next");
      expect(traces.at(-1)?.output).toBe("Next complete turn");
    }
  });
});
