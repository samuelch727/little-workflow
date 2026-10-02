import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { localHost } from "../local-host/index.js";
import { validateTraceEvent } from "../trace/validate.js";
import { isSideChannelSequence } from "./sequence.js";
import { createHarnessOutcomeReporter, reportHarnessOutcome, resolvePromptHash } from "./record.js";
import type { HarnessOutcomeSink } from "./types.js";

const PROMPT_HASH = "a".repeat(64);

async function setup(): Promise<{
  dataDir: string;
  host: ReturnType<typeof localHost>;
  sessionId: string;
  tracePath: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), "lh-outcome-"));
  const dataDir = join(dir, ".little-harness");
  const host = localHost({ dataDir });
  const session = await host.sessions.getOrCreate({ id: "chat_1" });
  return { dataDir, host, sessionId: session.id, tracePath: session.trace.path! };
}

function modelCalled(sequence: number, turnId?: string) {
  return {
    schemaVersion: "lh.trace.v2",
    eventId: `evt_${sequence}`,
    sequence,
    type: "harness.model.called",
    sessionId: "chat_1",
    ...(turnId === undefined ? {} : { turnId }),
    timestamp: "2026-08-07T00:00:00.000Z",
    metadata: {
      stepNumber: 1,
      model: { provider: "test", modelId: "m" },
      request: {
        promptHash: turnId === undefined ? PROMPT_HASH : "b".repeat(64),
        system: { captured: false },
        messages: [],
        tools: [],
      },
    },
  };
}

async function readTrace(tracePath: string): Promise<Array<Record<string, any>>> {
  const text = await readFile(tracePath, "utf8");
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, any>);
}

describe("reportHarnessOutcome", () => {
  it("appends a valid outcome.reported event joined to the session and the prompt", async () => {
    const { host, sessionId, tracePath } = await setup();
    await writeFile(tracePath, `${JSON.stringify(modelCalled(1))}\n`, "utf8");

    const result = await reportHarnessOutcome({
      harness: { sessions: host.sessions } as never,
      sessionId,
      status: "failure",
      detail: "wrong answer",
      stepPath: "root/draft",
      source: "programmatic",
    });

    expect(result.recorded).toBe(true);
    expect(result.errors).toEqual([]);

    const events = await readTrace(tracePath);
    const outcome = events.at(-1)!;
    expect(outcome.type).toBe("outcome.reported");
    expect(outcome.sessionId).toBe("chat_1");
    expect(outcome.metadata).toMatchObject({
      status: "failure",
      source: "programmatic",
      stepPath: "root/draft",
      detail: "wrong answer",
      // Resolved from the session's own trace, not supplied by the caller.
      promptHash: PROMPT_HASH,
    });
    // It is a real trace event: it round-trips the trace validator.
    expect(() => validateTraceEvent(outcome)).not.toThrow();
  });

  it("takes a banded sequence that cannot collide with run events", async () => {
    const { host, sessionId, tracePath } = await setup();
    await writeFile(tracePath, `${JSON.stringify(modelCalled(1))}\n`, "utf8");

    await reportHarnessOutcome({
      harness: { sessions: host.sessions } as never,
      sessionId,
      status: "success",
    });

    const events = await readTrace(tracePath);
    expect(isSideChannelSequence(events.at(-1)!.sequence)).toBe(true);
    expect(events.at(-1)!.sequence).toBeGreaterThan(3_000_000_000_000_000);
  });

  it("OMITS join keys it cannot resolve rather than writing a placeholder", async () => {
    const { host, sessionId, tracePath } = await setup();

    await reportHarnessOutcome({
      harness: { sessions: host.sessions } as never,
      sessionId,
      status: "success",
    });

    const outcome = (await readTrace(tracePath)).at(-1)!;
    expect(outcome.metadata).not.toHaveProperty("promptHash");
    expect(outcome.metadata).not.toHaveProperty("stepPath");
    expect(outcome.metadata).not.toHaveProperty("reporter");
    expect(outcome).not.toHaveProperty("turnId");
  });

  it("prefers an explicitly supplied promptHash over the resolved one", async () => {
    const { host, sessionId, tracePath } = await setup();
    await writeFile(tracePath, `${JSON.stringify(modelCalled(1))}\n`, "utf8");

    await reportHarnessOutcome({
      harness: { sessions: host.sessions } as never,
      sessionId,
      status: "success",
      promptHash: "c".repeat(64),
    });

    expect((await readTrace(tracePath)).at(-1)!.metadata.promptHash).toBe("c".repeat(64));
  });

  it("never throws when the session does not exist — it reports the failure instead", async () => {
    const { host } = await setup();
    const result = await reportHarnessOutcome({
      harness: { sessions: host.sessions } as never,
      sessionId: "missing",
      status: "failure",
    });

    expect(result.recorded).toBe(false);
    expect(result.event).toBeUndefined();
    expect(result.errors).toEqual([{ stage: "resolve", message: "Session not found: missing" }]);
  });

  it("never throws when a sink blows up — it counts the failure and keeps the trace event", async () => {
    const { host, sessionId } = await setup();
    const exploding: HarnessOutcomeSink = {
      name: "boom",
      deliver: () => {
        throw new Error("sink is down");
      },
    };
    const rejecting: HarnessOutcomeSink = { name: "nope", deliver: async () => ({ ok: false }) };
    const working: HarnessOutcomeSink = { name: "ok", deliver: async () => ({ ok: true }) };

    const result = await reportHarnessOutcome({
      harness: { sessions: host.sessions } as never,
      sessionId,
      status: "success",
      sinks: [exploding, rejecting, working],
    });

    expect(result.recorded).toBe(true);
    expect(result.delivered).toBe(1);
    expect(result.failed).toBe(2);
    expect(result.errors).toEqual([
      { stage: "sink", sink: "boom", message: "sink is down" },
      { stage: "sink", sink: "nope", message: "Sink reported ok: false." },
    ]);
  });

  it("hands sinks the same event it recorded", async () => {
    const { host, sessionId } = await setup();
    const deliver = vi.fn(async () => ({ ok: true }));

    const result = await reportHarnessOutcome({
      harness: { sessions: host.sessions } as never,
      sessionId,
      status: "partial",
      reporter: "anon_1",
      reportKey: "k1",
      sinks: [{ name: "s", deliver }],
    });

    expect(deliver).toHaveBeenCalledWith(result.event);
    expect(result.event).toMatchObject({
      sessionId: "chat_1",
      status: "partial",
      reporter: "anon_1",
      reportKey: "k1",
    });
  });

  it("does NOT push the outcome through the harness onEvent/trace-ingest stream", async () => {
    // An outcome that also travelled the trace-ingest path would be counted twice by the
    // control plane, which ingests it through POST /api/outcomes instead.
    const { host, sessionId } = await setup();
    const onEvent = vi.fn();

    await reportHarnessOutcome({
      harness: { sessions: host.sessions, config: { onEvent } } as never,
      sessionId,
      status: "success",
    });

    expect(onEvent).not.toHaveBeenCalled();
  });

  it("records when handed a session object directly", async () => {
    const { host, tracePath } = await setup();
    const session = await host.sessions.getOrCreate({ id: "chat_1" });

    const result = await reportHarnessOutcome({ session, status: "success" });

    expect(result.recorded).toBe(true);
    expect((await readTrace(tracePath)).at(-1)!.metadata.status).toBe("success");
  });

  it("requires some way to identify the session", async () => {
    const result = await reportHarnessOutcome({ status: "success" });
    expect(result.recorded).toBe(false);
    expect(result.errors[0]?.stage).toBe("resolve");
  });
});

describe("createHarnessOutcomeReporter", () => {
  it("binds a harness and its sinks once, then reports for any session", async () => {
    const { host, sessionId, tracePath } = await setup();
    const deliver = vi.fn(async () => ({ ok: true }));
    const reporter = createHarnessOutcomeReporter({
      harness: { sessions: host.sessions } as never,
      sinks: [{ name: "s", deliver }],
      source: "app",
    });

    const result = await reporter.report({ sessionId, status: "success", score: 1 });

    expect(result.recorded).toBe(true);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect((await readTrace(tracePath)).at(-1)!.metadata).toMatchObject({
      source: "app",
      score: 1,
    });
  });
});

describe("resolvePromptHash", () => {
  it("returns the most recent model call's prompt hash", async () => {
    const { tracePath } = await setup();
    await writeFile(
      tracePath,
      `${JSON.stringify(modelCalled(1, "turn_1"))}\n${JSON.stringify(modelCalled(2))}\n`,
      "utf8",
    );
    expect(await resolvePromptHash(tracePath)).toBe(PROMPT_HASH);
  });

  it("narrows to a turn when one is given", async () => {
    const { tracePath } = await setup();
    await writeFile(
      tracePath,
      `${JSON.stringify(modelCalled(1, "turn_1"))}\n${JSON.stringify(modelCalled(2))}\n`,
      "utf8",
    );
    expect(await resolvePromptHash(tracePath, "turn_1")).toBe("b".repeat(64));
  });

  it("returns undefined — never a placeholder — when nothing can be resolved", async () => {
    const { tracePath } = await setup();
    expect(await resolvePromptHash(tracePath)).toBeUndefined();
    await writeFile(tracePath, "not json\n", "utf8");
    expect(await resolvePromptHash(tracePath)).toBeUndefined();
  });
});
