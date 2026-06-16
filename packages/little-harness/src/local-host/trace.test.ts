import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LocalTrace } from "./trace.js";

describe("LocalTrace", () => {
  it("writes validated versioned trace events with event ids and sequences", async () => {
    const dir = await mkdtemp(join(tmpdir(), "little-harness-trace-"));
    const trace = new LocalTrace(join(dir, "trace.ndjson"));

    await trace.append({
      type: "harness.session.started",
      sessionId: "chat_123",
      timestamp: "2026-06-03T00:00:00.000Z",
      metadata: { turnId: "turn_1" },
    });
    await trace.append({
      type: "harness.model.called",
      sessionId: "chat_123",
      turnId: "turn_1",
      timestamp: "2026-06-03T00:00:01.000Z",
      metadata: {
        stepNumber: 1,
        model: { provider: "test", modelId: "test-model" },
        request: {
          promptHash: "hash",
          system: { captured: false },
          messages: [{ role: "user", content: { captured: false } }],
          tools: [],
        },
      },
    });

    const events = (await readFile(join(dir, "trace.ndjson"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(events).toEqual([
      expect.objectContaining({
        schemaVersion: "lh.trace.v2",
        eventId: expect.stringMatching(/^evt_/),
        sequence: 1,
        type: "harness.session.started",
        sessionId: "chat_123",
        timestamp: "2026-06-03T00:00:00.000Z",
      }),
      expect.objectContaining({
        schemaVersion: "lh.trace.v2",
        eventId: expect.stringMatching(/^evt_/),
        sequence: 2,
        type: "harness.model.called",
        sessionId: "chat_123",
        turnId: "turn_1",
        timestamp: "2026-06-03T00:00:01.000Z",
      }),
    ]);
    expect(events[0].eventId).not.toBe(events[1].eventId);
  });

  it("rejects unknown event types before writing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "little-harness-trace-invalid-"));
    const trace = new LocalTrace(join(dir, "trace.ndjson"));

    await expect(
      trace.append({
        type: "workflow.started",
        sessionId: "chat_123",
        timestamp: "2026-06-03T00:00:00.000Z",
      } as never),
    ).rejects.toThrow(/type/);
  });
});
