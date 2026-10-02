import { MockLanguageModelV3 } from "ai/test";
import { tool } from "ai";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createHarness } from "../create-harness.js";
import { generateHarness } from "../execution/generate-harness.js";
import { localHost } from "../local-host/index.js";
import { withTempDir } from "../test/temp.js";
import { remoteSessionLog } from "./client.js";
import { startSessionLogServer } from "./server.js";
import { createFileSessionLog } from "./session-log-store.js";

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

function textModel(text: string) {
  return new MockLanguageModelV3({
    provider: "test",
    modelId: "test-model",
    doGenerate: {
      content: [{ type: "text", text }],
      finishReason: { unified: "stop", raw: "stop" },
      usage,
      warnings: [],
    },
  });
}

describe("session log service", () => {
  it("appends and reads durable events over HTTP", async () => {
    const server = await startSessionLogServer();
    try {
      const log = remoteSessionLog({ baseUrl: server.url });
      const persisted = await log.append({
        type: "harness.session.started",
        runId: "run_http",
        payload: { sessionId: "s1" },
      });
      expect(persisted).toMatchObject({ runId: "run_http", sequence: 1, eventId: expect.any(String) });

      const events = await log.priorEvents!({ runId: "run_http" });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: "harness.session.started", sequence: 1 });
      expect(await log.priorEvents!({ runId: "run_other" })).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  it("rejects requests without the configured bearer token", async () => {
    const server = await startSessionLogServer({ authToken: "session-scoped-token" });
    try {
      const unauthenticated = remoteSessionLog({ baseUrl: server.url });
      await expect(
        unauthenticated.append({ type: "harness.session.started", runId: "r", payload: {} }),
      ).rejects.toThrow(/401/u);

      const authenticated = remoteSessionLog({ baseUrl: server.url, authToken: "session-scoped-token" });
      await expect(
        authenticated.append({ type: "harness.session.started", runId: "r", payload: {} }),
      ).resolves.toMatchObject({ sequence: 1 });
    } finally {
      await server.close();
    }
  });

  it("keeps /v1/health unauthenticated for load-balancer probes", async () => {
    const server = await startSessionLogServer({ authToken: "session-scoped-token" });
    try {
      const health = await fetch(`${server.url}/v1/health`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ ok: true });
    } finally {
      await server.close();
    }
  });

  it("rejects malformed JSON with 400 and oversized bodies with 413", async () => {
    const server = await startSessionLogServer({ maxBodyBytes: 1024 });
    try {
      const malformed = await fetch(`${server.url}/v1/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json",
      });
      expect(malformed.status).toBe(400);

      const oversized = await fetch(`${server.url}/v1/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "harness.session.started",
          runId: "run_big",
          payload: { blob: "x".repeat(4096) },
        }),
      });
      expect(oversized.status).toBe(413);

      // The server stays healthy afterwards.
      const ok = await remoteSessionLog({ baseUrl: server.url }).append({
        type: "harness.session.started",
        runId: "run_after",
        payload: {},
      });
      expect(ok).toMatchObject({ sequence: 1 });
    } finally {
      await server.close();
    }
  });

  it("times out a stalled append instead of hanging the turn", async () => {
    const log = remoteSessionLog({
      baseUrl: "http://localhost:9",
      timeoutMs: 50,
      fetch: ((_input: unknown, init?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), {
            once: true,
          });
        })) as typeof fetch,
    });
    await expect(
      log.append({ type: "harness.session.started", runId: "run_stall", payload: {} }),
    ).rejects.toThrow(/timeout|abort/iu);
  });

  it("survives a torn tail line in the file store instead of poisoning the log", async () => {
    await withTempDir(async (dir) => {
      const logPath = path.join(dir, "events.ndjson");
      const writer = createFileSessionLog({ path: logPath });
      await writer.append({ type: "harness.session.started", runId: "run_torn", payload: {} });
      // Simulate a crash mid-append: a partial JSON line at the end of the file.
      const { appendFile } = await import("node:fs/promises");
      await appendFile(logPath, '{"type":"harness.session.comp', "utf8");

      const reopened = createFileSessionLog({ path: logPath });
      const events = await reopened.priorEvents({ runId: "run_torn" });
      expect(events).toHaveLength(1);
      const appended = await reopened.append({
        type: "harness.session.completed",
        runId: "run_torn",
        payload: {},
      });
      expect(appended.sequence).toBe(2);

      // The append after the torn tail must start a fresh line: a third reload sees both
      // valid events, not a merged garbage line.
      const reloaded = createFileSessionLog({ path: logPath });
      const finalEvents = await reloaded.priorEvents({ runId: "run_torn" });
      expect(finalEvents.map((event) => event.sequence)).toEqual([1, 2]);
    });
  });

  it("persists events across a session-log server restart with the file store", async () => {
    await withTempDir(async (dir) => {
      const logPath = path.join(dir, "events.ndjson");
      const first = await startSessionLogServer({ store: createFileSessionLog({ path: logPath }) });
      const log = remoteSessionLog({ baseUrl: first.url });
      await log.append({ type: "harness.session.started", runId: "run_file", payload: {} });
      await log.append({
        type: "harness.session.completed",
        runId: "run_file",
        payload: {},
      });
      await first.close();

      // A brand-new server process over the same file sees the same run — the property the
      // in-memory reference store cannot provide.
      const second = await startSessionLogServer({ store: createFileSessionLog({ path: logPath }) });
      try {
        const events = await remoteSessionLog({ baseUrl: second.url }).priorEvents!({
          runId: "run_file",
        });
        expect(events).toHaveLength(2);
        expect(events.map((event) => event.sequence)).toEqual([1, 2]);
        const appended = await remoteSessionLog({ baseUrl: second.url }).append({
          type: "harness.session.started",
          runId: "run_file",
          payload: {},
        });
        expect(appended).toMatchObject({ sequence: 3 });
      } finally {
        await second.close();
      }
    });
  });

  it("lets a fresh harness process resume a run from the remote log without re-calling the model", async () => {
    const server = await startSessionLogServer();
    try {
      const messages = [
        { id: "m1", role: "user", parts: [{ type: "text", text: "Remember me." }] },
      ] as any;

      // First "process": runs the turn and records it to the remote session log.
      const firstModel = textModel("remote cached response");
      await withTempDir(async (firstDir) => {
        const harness = createHarness({
          host: localHost({ dataDir: firstDir }),
          model: firstModel,
          durability: remoteSessionLog({ baseUrl: server.url }),
        });
        const result = await generateHarness({
          harness,
          messages,
          session: "remote-resume",
          runId: "run_remote_resume",
        });
        expect(result.text).toBe("remote cached response");
      });
      expect(firstModel.doGenerateCalls).toHaveLength(1);

      // Second "process": brand-new host, data dir, and model instance — only the runId and
      // the remote log connect it to the first run. Replay must complete the turn without a
      // single provider call.
      const secondModel = textModel("should never be generated");
      await withTempDir(async (secondDir) => {
        const harness = createHarness({
          host: localHost({ dataDir: secondDir }),
          model: secondModel,
          durability: remoteSessionLog({ baseUrl: server.url }),
        });
        const resumed = await generateHarness({
          harness,
          messages,
          session: "remote-resume",
          runId: "run_remote_resume",
        });
        expect(resumed.text).toBe("remote cached response");
      });
      expect(secondModel.doGenerateCalls).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  it("replays recorded tool results from the remote log on resume", async () => {
    const server = await startSessionLogServer();
    try {
      const messages = [
        { id: "m1", role: "user", parts: [{ type: "text", text: "Add 3 and 4." }] },
      ] as any;
      const makeModel = () =>
        new MockLanguageModelV3({
          provider: "test",
          modelId: "test-model",
          doGenerate: async (options: any) => {
            const hasToolResult = options.prompt.some((message: any) =>
              Array.isArray(message.content) &&
              message.content.some((part: any) => part.type === "tool-result"));
            if (hasToolResult) {
              return {
                content: [{ type: "text", text: "the sum is 7" }],
                finishReason: { unified: "stop", raw: "stop" },
                usage,
                warnings: [],
              };
            }
            return {
              content: [
                {
                  type: "tool-call",
                  toolCallId: "call_add_1",
                  toolName: "add",
                  input: JSON.stringify({ a: 3, b: 4 }),
                },
              ],
              finishReason: { unified: "tool-calls", raw: "tool-calls" },
              usage,
              warnings: [],
            };
          },
        });

      let firstToolCalls = 0;
      await withTempDir(async (dir) => {
        const harness = createHarness({
          host: localHost({ dataDir: dir }),
          model: makeModel(),
          durability: remoteSessionLog({ baseUrl: server.url }),
          tools: {
            add: tool({
              description: "Add two numbers.",
              inputSchema: z.object({ a: z.number(), b: z.number() }),
              execute: async ({ a, b }) => {
                firstToolCalls += 1;
                return { sum: a + b };
              },
            }),
          },
        });
        const result = await generateHarness({
          harness,
          messages,
          session: "remote-tools",
          runId: "run_remote_tools",
        });
        expect(result.text).toBe("the sum is 7");
      });
      expect(firstToolCalls).toBe(1);

      // Fresh process: the tool implementation must not run again on replay. (Multi-step
      // turns re-call the model per step by design — only side effects are memoized — so
      // the assertion here is on tool execution and the final text, not provider calls.)
      let resumedToolCalls = 0;
      const resumedModel = makeModel();
      await withTempDir(async (dir) => {
        const harness = createHarness({
          host: localHost({ dataDir: dir }),
          model: resumedModel,
          durability: remoteSessionLog({ baseUrl: server.url }),
          tools: {
            add: tool({
              description: "Add two numbers.",
              inputSchema: z.object({ a: z.number(), b: z.number() }),
              execute: async ({ a, b }) => {
                resumedToolCalls += 1;
                return { sum: a + b };
              },
            }),
          },
        });
        const resumed = await generateHarness({
          harness,
          messages,
          session: "remote-tools",
          runId: "run_remote_tools",
        });
        expect(resumed.text).toBe("the sum is 7");
      });
      expect(resumedToolCalls).toBe(0);
    } finally {
      await server.close();
    }
  });
});
