import { describe, expect, it, vi } from "vitest";
import { Buffer } from "node:buffer";
import { createLittleDbHarnessReporter } from "./reporter.js";
import type { HarnessEvent } from "../types.js";

function event(overrides: Partial<HarnessEvent>): HarnessEvent {
  return {
    schemaVersion: "lh.trace.v2",
    eventId: "event_1",
    sequence: 1,
    type: "harness.session.started",
    sessionId: "session_1",
    timestamp: "2026-06-06T00:00:00.000Z",
    metadata: {},
    ...overrides,
  } as HarnessEvent;
}

describe("createLittleDbHarnessReporter", () => {
  it("posts harness.session.started and an initial eval upload on session start", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init?.body)) });
      return new Response(null, { status: 202 });
    });
    const reporter = createLittleDbHarnessReporter({
      engineUrl: "http://localhost:7878",
      harnessId: "harness_alpha",
      releaseChannel: "development",
      model: "deepseek-v4-flash",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await reporter.onEvent(event({ type: "harness.session.started", eventId: "event_started", sequence: 1 }));

    expect(calls.map((call) => new URL(call.url).pathname)).toEqual(["/ingest", "/harness/eval-runs"]);
    expect(calls[0]?.body).toEqual([
      expect.objectContaining({
        eventId: "event_started",
        runId: "harness_session_1",
        sequence: 1,
        type: "harness.session.started",
        recordedAt: "2026-06-06T00:00:00.000Z",
      }),
    ]);
    expect(calls[1]?.body).toMatchObject({
      harnessId: "harness_alpha",
      sessionId: "session_1",
      runId: "harness_session_1",
      rootRunId: "harness_session_1",
      releaseChannel: "development",
      localConfig: {
        model: "deepseek-v4-flash",
        provider: "little-harness",
        replayTranscript: [],
      },
      files: [],
      toolManifest: null,
      integrationPatches: [],
    });
  });

  it("translates model and tool events into littleDB harness trace events", async () => {
    const posted: unknown[] = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      posted.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 202 });
    });
    const reporter = createLittleDbHarnessReporter({
      engineUrl: "http://localhost:7878",
      harnessId: "harness_alpha",
      releaseChannel: "development",
      model: "deepseek-v4-flash",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await reporter.onEvent(event({ type: "harness.session.started", eventId: "event_started", sequence: 1 }));
    await reporter.onEvent(
      event({
        type: "harness.model.called",
        eventId: "event_model_requested",
        sequence: 2,
        stepId: "step_1",
        metadata: {
          model: { provider: "deepseek", modelId: "deepseek-v4-flash" },
          request: {
            system: { preview: "system prompt" },
            messages: [{ role: "user", content: { preview: "hello" } }],
          },
        },
      }),
    );
    await reporter.onEvent(
      event({
        type: "harness.model.responded",
        eventId: "event_model_responded",
        sequence: 3,
        stepId: "step_1",
        metadata: {
          model: { provider: "deepseek", modelId: "deepseek-v4-flash" },
          text: { preview: "hi back" },
          usage: { inputTokens: 10, outputTokens: 4 },
          durationMs: 123,
        },
      }),
    );
    await reporter.onEvent(
      event({
        type: "harness.tool_call.started",
        eventId: "event_tool_started",
        sequence: 4,
        metadata: {
          toolName: "lookup",
          toolCallId: "call_1",
          input: { preview: "{\"q\":\"abc\"}" },
        },
      }),
    );
    await reporter.onEvent(
      event({
        type: "harness.tool_call.succeeded",
        eventId: "event_tool_succeeded",
        sequence: 5,
        metadata: {
          toolName: "lookup",
          toolCallId: "call_1",
          input: { preview: "{\"q\":\"abc\"}" },
          output: { preview: "{\"ok\":true}" },
          durationMs: -12,
        },
      }),
    );
    await reporter.onEvent(
      event({
        type: "harness.model.failed",
        eventId: "event_model_failed",
        sequence: 6,
        stepId: "step_2",
        metadata: {
          error: {
            name: "HarnessModelCallTimeoutError",
            message: "Model call timed out.",
            causeCode: "model_call_timeout",
          },
          durationMs: 250,
        },
      }),
    );

    const ingestBodies = posted.filter((body) => Array.isArray(body)).flat() as Array<Record<string, unknown>>;
    expect(ingestBodies.map((body) => body.type)).toEqual([
      "harness.session.started",
      "harness.model.called",
      "harness.model.responded",
      "harness.tool_call.started",
      "harness.tool_call.succeeded",
      "harness.model.failed",
    ]);
    expect(ingestBodies[1]).toMatchObject({
      payload: {
        turn: 2,
        promptHash: expect.stringMatching(/^sha256:/),
        request: {
          model: "deepseek-v4-flash",
          messages: [{ role: "user", content: "hello" }],
          tools: [],
        },
      },
    });
    expect(ingestBodies[2]).toMatchObject({
      runId: "harness_session_1",
      type: "harness.model.responded",
      payload: {
        callId: "step_1",
        turn: 3,
        response: {
          model: "deepseek-v4-flash",
          text: "hi back",
          output: "hi back",
          usage: { inputTokens: 10, outputTokens: 4 },
        },
      },
    });
    expect(ingestBodies[3]).toMatchObject({
      payload: {
        callId: "call_1",
        caller: "model",
        turn: 4,
        toolName: "lookup",
        args: { q: "abc" },
      },
    });
    expect(ingestBodies[4]).toMatchObject({
      payload: {
        callId: "call_1",
        toolName: "lookup",
        result: { ok: true },
        durationMs: 0,
      },
    });
    expect(ingestBodies[5]).toMatchObject({
      payload: {
        callId: "step_2",
        turn: 6,
        error: {
          name: "HarnessModelCallTimeoutError",
          causeCode: "model_call_timeout",
        },
        durationMs: 250,
      },
    });
    const latestEval = posted.at(-1) as { localConfig?: { replayTranscript?: unknown[] } };
    expect(latestEval.localConfig?.replayTranscript).toHaveLength(4);
  });

  it("accumulates managed eval file snapshots from actual file event content without contentBase64", async () => {
    const posted: unknown[] = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      posted.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 202 });
    });
    const reporter = createLittleDbHarnessReporter({
      engineUrl: "http://localhost:7878",
      harnessId: "harness_alpha",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await reporter.onEvent(event({ type: "harness.session.started", eventId: "event_started", sequence: 1 }));
    await reporter.onEvent(
      event({
        type: "harness.file.created",
        eventId: "event_file_created",
        sequence: 2,
        metadata: {
          path: "/session/project.md",
          mediaType: "text/markdown",
          content: "# Project\n",
          after: { bytes: 10, sha256: "a".repeat(64) },
        },
      }),
    );
    await reporter.onEvent(
      event({
        type: "harness.file.updated",
        eventId: "event_file_updated",
        sequence: 3,
        metadata: {
          path: "/session/project.md",
          mediaType: "text/markdown",
          after: { bytes: 17, sha256: "b".repeat(64) },
          diff: {
            available: true,
            format: "unified",
            preview: "@@ -1 +1\n-# Project\n+# Project updated\n",
            truncated: false,
          },
        },
      }),
    );

    const latestEval = posted.at(-1) as { files?: Array<{ path: string; boundaryId: string; mediaType?: string; contentBase64: string }> };
    expect(latestEval.files).toEqual([
      expect.objectContaining({
        path: "/session/project.md",
        boundaryId: "event_2:after",
        mediaType: "text/markdown",
      }),
    ]);
    expect(Buffer.from(latestEval.files?.[0]?.contentBase64 ?? "", "base64").toString("utf8")).toBe("# Project\n");
  });

  it("keeps harness execution alive when littleDB is unavailable", async () => {
    const reporter = createLittleDbHarnessReporter({
      engineUrl: "http://localhost:7878",
      harnessId: "harness_alpha",
      fetchImpl: vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    });

    await expect(reporter.onEvent(event({ type: "harness.session.started" }))).resolves.toBeUndefined();
  });
});
