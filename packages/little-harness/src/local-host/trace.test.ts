import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { reportHarnessOutcome } from "../outcomes/record.js";
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

async function traceFile(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "lh-trace-")), "trace.ndjson");
}

async function sequences(pathname: string): Promise<number[]> {
  const text = await readFile(pathname, "utf8");
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => (JSON.parse(line) as { sequence: number }).sequence);
}

function sessionStarted() {
  return {
    type: "harness.session.started" as const,
    sessionId: "s1",
    timestamp: new Date().toISOString(),
    metadata: {},
  };
}

describe("LocalTrace sequencing around side-channel events", () => {
  it("numbers run events from 1 and resumes across writers", async () => {
    const pathname = await traceFile();
    await new LocalTrace(pathname).append(sessionStarted());
    await new LocalTrace(pathname).append(sessionStarted());
    expect(await sequences(pathname)).toEqual([1, 2]);
  });

  it("resumes run numbering PAST an appended outcome instead of inheriting its band", async () => {
    // A new LocalTrace is constructed per prepared turn, so without the band skip the first
    // event of the turn after a thumbs-down would jump to ~3e15 and stay there forever.
    const pathname = await traceFile();
    const first = new LocalTrace(pathname);
    await first.append(sessionStarted());
    await first.append(sessionStarted());

    await reportHarnessOutcome({
      sessionId: "s1",
      tracePath: pathname,
      status: "failure",
      source: "chat-sdk",
    });

    await new LocalTrace(pathname).append(sessionStarted());

    const all = await sequences(pathname);
    expect(all[0]).toBe(1);
    expect(all[1]).toBe(2);
    expect(all[2]).toBeGreaterThan(3_000_000_000_000_000);
    expect(all[3]).toBe(3);
  });

  it("does not count side-channel lines in the no-sequence fallback", async () => {
    const pathname = await traceFile();
    await writeFile(
      pathname,
      `${JSON.stringify({ type: "legacy" })}\n${JSON.stringify({ type: "outcome.reported", sequence: 3_000_000_000_000_050 })}\n`,
      "utf8",
    );
    await new LocalTrace(pathname).append(sessionStarted());
    expect((await sequences(pathname)).at(-1)).toBe(2);
  });
});
