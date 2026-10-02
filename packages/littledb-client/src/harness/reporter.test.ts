import { describe, expect, it, vi } from "vitest";
import { createLittleDbHarnessReporter } from "./reporter.js";
import type { HarnessEvent } from "little-harness";

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

type IngestEnvelope = { type: string; payload: Record<string, unknown> };

/** Collects the `/ingest` envelopes the reporter POSTs, ignoring the eval uploads. */
function recorder() {
  const envelopes: IngestEnvelope[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    if (Array.isArray(body) && new URL(String(url)).pathname === "/ingest") {
      envelopes.push(...(body as IngestEnvelope[]));
    }
    return new Response(null, { status: 202 });
  });
  return {
    ingested: {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      payloadOf(type: string): Record<string, unknown> {
        const envelope = envelopes.find((candidate) => candidate.type === type);
        if (envelope === undefined) {
          throw new Error(`No ${type} envelope was posted to /ingest.`);
        }
        return envelope.payload;
      },
    },
  };
}

/**
 * Reads a posted payload the way littleDB's engine does, so these tests fail if the
 * dollars ever move off the field path the engine consumes.
 *
 * Mirrors `crates/engine/src/ingest.rs`, the
 * `"HarnessModelResponded" | "harness.model.responded"` arm: `payload.response.usage`
 * (falling back to `payload.usage`) → `.costUsd`, then a last fallback to
 * `payload.costUsd`. Whatever this returns becomes the event row's `cost_usd`, which
 * `crates/engine/src/query.rs` sums per run as `SUM(COALESCE(e.cost_usd, 0.0))` — the
 * figure the cost-delta promotion gate reads.
 */
function engineCostUsd(payload: Record<string, unknown>): number | undefined {
  const response = payload.response as Record<string, unknown> | undefined;
  const usage = (response?.usage ?? payload.usage) as Record<string, unknown> | undefined;
  const cost = usage?.costUsd ?? payload.costUsd;
  return typeof cost === "number" ? cost : undefined;
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

  it("records configVersionId in the session-started metadata and the eval localConfig", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init?.body)) });
      return new Response(null, { status: 202 });
    });
    const reporter = createLittleDbHarnessReporter({
      engineUrl: "http://localhost:7878",
      harnessId: "harness_alpha",
      releaseChannel: "production",
      configVersionId: "cfgv_42",
      model: "deepseek-chat",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await reporter.onEvent(event({ type: "harness.session.started", eventId: "ev_s", sequence: 1 }));

    const ingest = calls[0]!.body as Array<{ payload: { metadata: Record<string, unknown> } }>;
    expect(ingest[0]!.payload.metadata).toMatchObject({
      releaseChannel: "production",
      configVersionId: "cfgv_42",
    });
    const evalUpload = calls[1]!.body as { localConfig: Record<string, unknown> };
    expect(evalUpload.localConfig.configVersionId).toBe("cfgv_42");
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

  it("does NOT capture file snapshots from realistic little-harness file events (no inline content)", async () => {
    // KNOWN LIMITATION: little-harness file events carry `after: { bytes, sha256 }` + `diff: { available, preview, ... }`
    // but do NOT include inline `content`/`text`/`contentBase64`. The reporter's fileSnapshotContent() returns null
    // for such events, so `files` stays empty in practice. A proper fix (engine accepts content-optional snapshots
    // carrying sha256/bytes + diff) is a tracked follow-up.
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
    // Realistic file.created event: path + after:{bytes,sha256} + diff, NO inline content
    await reporter.onEvent(
      event({
        type: "harness.file.created",
        eventId: "event_file_created",
        sequence: 2,
        metadata: {
          path: "/session/project.md",
          after: { bytes: 10, sha256: "a".repeat(64) },
          diff: {
            available: true,
            format: "unified",
            preview: "@@ -0,0 +1 @@\n+# Project\n",
            truncated: false,
          },
        },
      }),
    );
    // Realistic file.updated event: path + after:{bytes,sha256} + diff, NO inline content
    await reporter.onEvent(
      event({
        type: "harness.file.updated",
        eventId: "event_file_updated",
        sequence: 3,
        metadata: {
          path: "/session/project.md",
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

    const latestEval = posted.at(-1) as { files?: unknown[] };
    // Files stays empty because real events carry no inline content — this documents the current limitation.
    expect(latestEval.files).toEqual([]);
  });

  it("prices a model response in real dollars, at the exact field littleDB's engine reads", async () => {
    const { ingested } = recorder();
    const reporter = createLittleDbHarnessReporter({
      engineUrl: "http://localhost:7878",
      harnessId: "harness_alpha",
      // A slot label, deliberately NOT a model identity — pricing must ignore it.
      model: "planner-slot",
      fetchImpl: ingested.fetchImpl,
    });

    const responded = event({
      type: "harness.model.responded",
      eventId: "event_priced",
      sequence: 2,
      stepId: "step_1",
      metadata: {
        // The AI SDK stamps a sub-model provider suffix; the registry lookup normalizes
        // `deepseek.chat` → `deepseek`, so this pins that path through the reporter.
        model: { provider: "deepseek.chat", modelId: "deepseek-v4-flash" },
        text: { preview: "hi back" },
        usage: { inputTokens: 10, outputTokens: 4 },
      },
    });
    await reporter.onEvent(responded);

    // deepseek/deepseek-v4-flash: $0.14 in / $0.28 out per 1M tokens.
    //   (10 × 0.14 + 4 × 0.28) / 1e6 = 2.52e-6
    expect(engineCostUsd(ingested.payloadOf("harness.model.responded"))).toBeCloseTo(
      (10 * 0.14 + 4 * 0.28) / 1_000_000,
      15,
    );

    // The boundary: cost is added to the exported body only. The harness event — the
    // durable-log shape, where `assertUsage` forbids `costUsd` — is left untouched.
    expect(responded.metadata?.usage).toEqual({ inputTokens: 10, outputTokens: 4 });
  });

  it("bills cache hits at the registry's cache-read rate", async () => {
    const { ingested } = recorder();
    const reporter = createLittleDbHarnessReporter({
      engineUrl: "http://localhost:7878",
      harnessId: "harness_alpha",
      fetchImpl: ingested.fetchImpl,
    });

    await reporter.onEvent(
      event({
        type: "harness.model.responded",
        eventId: "event_cached",
        sequence: 2,
        metadata: {
          model: { provider: "deepseek.chat", modelId: "deepseek-v4-flash" },
          // cachedInputTokens is a SUBSET of inputTokens, so 200 tokens bill at the full
          // input rate and 800 at the cache-read rate.
          usage: { inputTokens: 1000, cachedInputTokens: 800, outputTokens: 500 },
        },
      }),
    );

    // (200 × 0.14 + 800 × 0.0028 + 500 × 0.28) / 1e6 = 1.7024e-4
    expect(engineCostUsd(ingested.payloadOf("harness.model.responded"))).toBeCloseTo(
      (200 * 0.14 + 800 * 0.0028 + 500 * 0.28) / 1_000_000,
      15,
    );
  });

  it("omits costUsd entirely for a model the registry cannot price — never a fabricated 0", async () => {
    const { ingested } = recorder();
    const reporter = createLittleDbHarnessReporter({
      engineUrl: "http://localhost:7878",
      harnessId: "harness_alpha",
      fetchImpl: ingested.fetchImpl,
    });

    await reporter.onEvent(
      event({
        type: "harness.model.responded",
        eventId: "event_unpriced",
        sequence: 2,
        metadata: {
          // `deepseek-chat` is the legacy alias DeepSeek retired on 2026-07-24; it has no
          // published rate, so it is deliberately absent from the registry.
          model: { provider: "deepseek.chat", modelId: "deepseek-chat" },
          usage: { inputTokens: 10, outputTokens: 4 },
        },
      }),
    );

    const payload = ingested.payloadOf("harness.model.responded");
    // Unknown must stay unknown. littleDB coalescing a missing cost_usd to 0.0 when it
    // sums a run is its call about absent data; asserting a 0 here would be a claim.
    expect(engineCostUsd(payload)).toBeUndefined();
    expect(payload.response).toEqual(
      expect.objectContaining({ usage: { inputTokens: 10, outputTokens: 4 } }),
    );
    expect(Object.keys(payload)).not.toContain("costUsd");
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
