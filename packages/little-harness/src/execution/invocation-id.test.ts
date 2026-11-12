import { MockLanguageModelV3 } from "ai/test";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { createHarness } from "../create-harness.js";
import type { HarnessSessionLog } from "../events/occurrence.js";
import { localHost } from "../local-host/index.js";
import { inMemorySessionLog } from "../remote-session/session-log-store.js";
import { remoteTool, remoteTools, remoteToolHandler, serveRemoteTools, type RemoteToolCall } from "../remote-tools/index.js";
import { harnessToolContext } from "../connectors/tool-context.js";
import { withStepToolContext } from "../runtime/step-tools.js";
import { withTempDir } from "../test/temp.js";
import { generateHarness } from "./generate-harness.js";
import { streamHarness } from "./stream-harness.js";

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
function model(parallel = false) {
  const content = (prompt: readonly { role: string }[]) => prompt.some(m => m.role === "tool")
    ? [{ type: "text" as const, text: "done" }]
    : Array.from({ length: parallel ? 2 : 1 }, (_, i) => ({ type: "tool-call" as const, toolCallId: `call_${i}`, toolName: "inspect", input: JSON.stringify({ i }) }));
  return new MockLanguageModelV3({
    doGenerate: async ({ prompt }) => { const parts = content(prompt); return { content: parts, finishReason: { unified: parts[0]!.type === "text" ? "stop" : "tool-calls", raw: "test" }, usage, warnings: [] }; },
    doStream: async ({ prompt }) => {
      const parts = content(prompt);
      return { stream: new ReadableStream({ start(c) {
        c.enqueue({ type: "stream-start", warnings: [] });
        for (const part of parts) {
          if (part.type === "text") {
            c.enqueue({ type: "text-start", id: "0" }); c.enqueue({ type: "text-delta", id: "0", delta: part.text }); c.enqueue({ type: "text-end", id: "0" });
          } else c.enqueue(part);
        }
        c.enqueue({ type: "finish", finishReason: { unified: parts[0]!.type === "text" ? "stop" : "tool-calls", raw: "test" }, usage }); c.close();
      } }) };
    },
  });
}

for (const api of ["generate", "stream"] as const) {
  const run = async (harness: ReturnType<typeof createHarness>, session: string, runId?: string) => {
    const opts = { harness, session, prompt: "inspect", ...(runId === undefined ? {} : { runId }) };
    if (api === "generate") return generateHarness(opts);
    return streamHarness(opts).finished;
  };
  describe(`${api} invocation identity`, () => {
    it("a turn-wide abort during a remote call stays terminal and never starts another model step", async () => {
      await withTempDir(async dir => {
        const log = inMemorySessionLog();
        const controller = new AbortController();
        let entered!: () => void;
        const started = new Promise<void>(resolve => { entered = resolve; });
        const contract = remoteTool({ name: "inspect", description: "inspect", inputSchema: z.object({ i: z.number() }) });
        const handler = serveRemoteTools({ authenticate: () => ({ id: "alice" }), tools: [remoteToolHandler(contract, async (_input, { signal }) => {
          entered();
          await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
          return { ok: true };
        })] });
        const harness = createHarness({ host: localHost({ dataDir: dir }), runtime: { bash: false }, model: model(), sessionLog: log,
          tools: remoteTools([contract], { endpoint: { fetch: handler }, scope: "s" }),
        });
        const opts = { harness, session: "s", prompt: "inspect", abortSignal: controller.signal };
        const result = api === "generate" ? generateHarness(opts) : streamHarness(opts).finished;
        await started;
        controller.abort(new Error("stop-remote-turn"));
        await expect(result).rejects.toThrow();
        expect(log.events.filter(event => event.type === "harness.model.called")).toHaveLength(1);
      });
    });

    it("isolates concurrent calls and reused provider call IDs across turns and sessions without a session log", async () => {
      await withTempDir(async dir => {
        const ids: (string | undefined)[] = [];
        const harness = createHarness({ host: localHost({ dataDir: dir }), runtime: { bash: false }, model: model(true), tools: {
          inspect: tool({ inputSchema: z.object({ i: z.number() }), execute: async (_input, options) => {
            const before = harnessToolContext(options).invocationId;
            await new Promise(resolve => setTimeout(resolve, 5));
            expect(harnessToolContext(options).invocationId).toBe(before);
            ids.push(before); return { ok: true };
          } }),
        } });
        // Even the same explicit runId cannot recover an identity without retained events.
        await run(harness, "s", "unlogged-run"); await run(harness, "s", "unlogged-run"); await run(harness, "other");
        expect(ids).toHaveLength(6);
        expect(ids.every(id => typeof id === "string" && id.startsWith("evt_"))).toBe(true);
        expect(new Set(ids).size).toBe(6);
      });
    });

    it.each([true, false])("an inflight replay preserves only an actually retained occurrence (retained=%s)", async retained => {
      await withTempDir(async dir => {
        const log = inMemorySessionLog();
        let refuseSuccess = true;
        let legacy = false;
        const sessionLog: HarnessSessionLog = {
          append: async event => {
            if (refuseSuccess && event.type === "harness.tool_call.succeeded") throw new Error("lost-success-record");
            return log.append(event);
          },
          priorEvents: async query => (await log.priorEvents(query)).map(event => {
            if (!legacy || event.type !== "harness.tool_call.started") return event;
            const { occurrenceId: _occurrenceId, ...withoutOccurrence } = event;
            return withoutOccurrence;
          }),
        };
        const calls: RemoteToolCall[] = [];
        const contract = remoteTool({ name: "inspect", description: "inspect", inputSchema: z.object({ i: z.number() }) });
        const handler = serveRemoteTools({ authenticate: () => ({ id: "alice" }), tools: [remoteToolHandler(contract, (_input, { call }) => { calls.push(call); return { ok: true }; })] });
        const harness = createHarness({ host: localHost({ dataDir: dir }), runtime: { bash: false }, model: model(), sessionLog,
          tools: remoteTools([contract], { endpoint: { fetch: handler }, scope: "chat-a" }),
        });
        await expect(run(harness, "s", "same-run")).rejects.toThrow("lost-success-record");
        expect(calls).toHaveLength(1);
        expect(calls[0]!.invocationId).toMatch(/^evt_/);
        refuseSuccess = false;
        legacy = !retained;
        expect(await run(harness, "s", "same-run")).toMatchObject({ status: "completed" });
        expect(calls).toHaveLength(2);
        expect(calls[1]!.invocationId).toBe(retained ? calls[0]!.invocationId : undefined);
        expect(calls[1]!.dedupeKey).toBe(retained ? calls[0]!.dedupeKey : undefined);
      });
    });

    it("a nested workflow step gets its own key and never inherits the parent model invocation", async () => {
      await withTempDir(async dir => {
        let parentId: string | undefined;
        let stepOptions: unknown;
        const step = withStepToolContext({ nested: tool({ inputSchema: z.object({}), execute: async (_input, options) => { stepOptions = options; return {}; } }) }, { sessionId: "s", onceDir: `${dir}/once` });
        const harness = createHarness({ host: localHost({ dataDir: dir }), runtime: { bash: false }, model: model(), tools: {
          inspect: tool({ inputSchema: z.object({ i: z.number() }), execute: async (_input, options) => {
            parentId = harnessToolContext(options).invocationId;
            return (step.nested!.execute as Function)({}, { toolCallId: "workflow-step" });
          } }),
        } });
        await run(harness, "s");
        expect(parentId).toMatch(/^evt_/);
        expect(harnessToolContext(stepOptions).invocationId).toBeUndefined();
        expect(harnessToolContext(stepOptions).idempotencyKey).toMatch(/^idem_/);
      });
    });

    it("a remote result uses the ordinary harness events and large-result spooling", async () => {
      await withTempDir(async dir => {
        const log = inMemorySessionLog();
        const contract = remoteTool({ name: "inspect", description: "inspect", inputSchema: z.object({ i: z.number() }) });
        const output = "REMOTE_RESULT_SENTINEL".repeat(2000);
        const handler = serveRemoteTools({ authenticate: () => ({ id: "alice" }), tools: [remoteToolHandler(contract, () => output)] });
        const harness = createHarness({ host: localHost({ dataDir: dir }), runtime: { bash: false }, model: model(), sessionLog: log,
          tools: remoteTools([contract], { endpoint: { fetch: handler }, scope: "s" }) as ToolSet,
        });
        await run(harness, "s");
        const events = log.events.filter(e => e.type.startsWith("harness.tool_call."));
        expect(events.map(e => e.type)).toEqual(["harness.tool_call.started", "harness.tool_call.succeeded"]);
        expect(events[1]!.occurrenceId).toBe(events[0]!.occurrenceId);
        const session = await harness.config.host.sessions.getOrCreate({ id: "s" });
        const files = await session.files.list("/artifacts/tool-results/inspect", { recursive: true });
        expect(files).toHaveLength(1);
        expect(await (await session.files.read(files[0]!.path)).text()).toBe(output);
      });
    });
  });
}
