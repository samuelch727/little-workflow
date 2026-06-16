import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { MockLanguageModelV3 } from "ai/test";
import { tool, type UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createHarness } from "../create-harness.js";
import { HarnessInputError } from "../errors.js";
import type {
  DurableHarnessEventInput,
  HarnessPriorEventQuery,
  PersistedDurableHarnessEvent,
} from "../events/occurrence.js";
import { inputType } from "../input-types/input-type.js";
import { generateHarness } from "./generate-harness.js";
import { localHost } from "../local-host/index.js";
import { withTempDir } from "../test/temp.js";
import { streamHarness } from "./stream-harness.js";

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

function finishChunk() {
  return { type: "finish" as const, finishReason: { unified: "stop" as const, raw: "stop" }, usage };
}

function streamingTextModel(text: string) {
  return new MockLanguageModelV3({
    provider: "test",
    modelId: "test-model",
    doStream: {
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({ type: "text-start", id: "0" });
          controller.enqueue({ type: "text-delta", id: "0", delta: text });
          controller.enqueue({ type: "text-end", id: "0" });
          controller.enqueue(finishChunk());
          controller.close();
        },
      }),
    },
  });
}

function reusableStreamingTextModel(text: string) {
  return new MockLanguageModelV3({
    provider: "test",
    modelId: "test-model",
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({ type: "text-start", id: "0" });
          controller.enqueue({ type: "text-delta", id: "0", delta: text });
          controller.enqueue({ type: "text-end", id: "0" });
          controller.enqueue(finishChunk());
          controller.close();
        },
      }),
    }),
  });
}

function replayDurability(seed: readonly PersistedDurableHarnessEvent[] = []) {
  const events = [...seed];
  return {
    events,
    sink: {
      append: async (event: DurableHarnessEventInput) => {
        const persisted: PersistedDurableHarnessEvent = {
          ...event,
          eventId: `evt_${events.length + 1}`,
          sequence: events.length + 1,
          recordedAt: "2026-06-07T00:00:00.000Z",
        };
        events.push(persisted);
        return persisted;
      },
      priorEvents: async (query: HarnessPriorEventQuery = {}) =>
        events.filter((event) =>
          (query.runId === undefined || event.runId === query.runId) &&
          (query.type === undefined || event.type === query.type) &&
          (query.occurrenceId === undefined || event.occurrenceId === query.occurrenceId)
        ),
    },
  };
}

function providerToolNames(tools: unknown): string[] {
  if (Array.isArray(tools)) {
    return tools.flatMap((entry) =>
      entry && typeof entry === "object" && "name" in entry
        ? [String((entry as { name: unknown }).name)]
        : [],
    );
  }
  return Object.keys((tools ?? {}) as Record<string, unknown>);
}

describe("streamHarness", () => {
  it("rejects finished with HarnessInputError when no harness or call model is configured", async () => {
    await withTempDir(async (dir) => {
      const harness = createHarness({
        host: localHost({ dataDir: dir }),
        system: "Missing model.",
      } as any);

      const result = streamHarness({ harness, type: "job", input: {} });
      void Promise.resolve(result.text).catch(() => undefined);
      void Promise.resolve(result.output).catch(() => undefined);

      await expect(result.finished).rejects.toThrow(HarnessInputError);
      await expect(result.finished).rejects.toThrow(/model/i);
    });
  });

  it("supports per-call model, system, temperature, and runtime overrides", async () => {
    await withTempDir(async (dir) => {
      const defaultModel = streamingTextModel("default stream");
      let seenPrompt = "";
      let seenTemperature: number | undefined;
      let seenToolNames: string[] = [];
      const requestModel = new MockLanguageModelV3({
        provider: "test",
        modelId: "request-stream-model",
        doStream: async (options) => {
          seenPrompt = JSON.stringify(options.prompt);
          seenTemperature = options.temperature;
          seenToolNames = providerToolNames(options.tools);
          return {
            stream: new ReadableStream({
              start(controller) {
                controller.enqueue({ type: "stream-start", warnings: [] });
                controller.enqueue({ type: "text-start", id: "0" });
                controller.enqueue({ type: "text-delta", id: "0", delta: "request stream" });
                controller.enqueue({ type: "text-end", id: "0" });
                controller.enqueue(finishChunk());
                controller.close();
              },
            }),
          };
        },
      });
      const harness = createHarness({
        host: localHost({ dataDir: dir }),
        model: defaultModel,
        system: "Default stream system.",
      });

      const result = streamHarness({
        harness,
        messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "Hi" }] }] as any,
        model: requestModel,
        system: "Request stream system.",
        temperature: 0.3,
        runtime: { bash: false },
      });

      expect(await result.text).toBe("request stream");
      await result.finished;
      expect(defaultModel.doStreamCalls).toHaveLength(0);
      expect(requestModel.doStreamCalls).toHaveLength(1);
      expect(seenPrompt).toContain("Request stream system.");
      expect(seenPrompt).not.toContain("Default stream system.");
      expect(seenTemperature).toBe(0.3);
      expect(seenToolNames).not.toContain("bash");
    });
  });

  it("returns an AI SDK compatible UI message stream response and finished metadata", async () => {
    await withTempDir(async (dir) => {
      const harness = createHarness({ host: localHost({ dataDir: dir }), model: streamingTextModel("hello") });
      const messages = [
        { id: "m1", role: "user", parts: [{ type: "text", text: "Hi" }] },
      ] as UIMessage[];

      const result = streamHarness({ harness, messages, session: "chat" });
      const response = result.toUIMessageStreamResponse();
      const body = await response.text();
      const finished = await result.finished;

      expect(response).toBeInstanceOf(Response);
      expect(body).toContain("hello");
      expect(await result.text).toBe("hello");
      expect(finished.session.id).toBe("chat");
      expect(finished.persistence.status).toBe("not-configured");
    });
  });

  it("does not persist trace events when harness trace is disabled but still calls onEvent", async () => {
    await withTempDir(async (dir) => {
      const events: any[] = [];
      const harness = createHarness({
        host: localHost({ dataDir: dir }),
        model: streamingTextModel("hello"),
        trace: false,
        onEvent: (event) => {
          events.push(event);
        },
      });

      const result = streamHarness({
        harness,
        messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "Hi" }] }] as UIMessage[],
        session: "stream-trace-disabled",
      });
      const finished = await result.finished;

      await expect(readFile(finished.trace.path!, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            schemaVersion: "lh.trace.v2",
            sequence: 1,
            type: "harness.session.started",
            sessionId: "stream-trace-disabled",
          }),
          expect.objectContaining({
            schemaVersion: "lh.trace.v2",
            type: "harness.model.responded",
            sessionId: "stream-trace-disabled",
          }),
        ]),
      );
    });
  });

  it("keeps the same-session lock until the stream finishes", async () => {
    await withTempDir(async (dir) => {
      let streamController!: ReadableStreamDefaultController<any>;
      let streamStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        streamStarted = resolve;
      });
      const model = new MockLanguageModelV3({
        provider: "test",
        modelId: "test-model",
        doStream: async () => ({
          stream: new ReadableStream({
            start(controller) {
              streamController = controller;
              streamController.enqueue({ type: "stream-start", warnings: [] });
              streamController.enqueue({ type: "text-start", id: "0" });
              streamController.enqueue({ type: "text-delta", id: "0", delta: "streaming" });
              streamStarted();
            },
          }),
        }),
        doGenerate: {
          content: [{ type: "text", text: "generated" }],
          finishReason: { unified: "stop", raw: "stop" },
          usage,
          warnings: [],
        },
      });
      const harness = createHarness({ host: localHost({ dataDir: dir }), model });

      const stream = streamHarness({
        harness,
        messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "Start" }] }] as UIMessage[],
        session: "same",
      });
      await started;
      let generateFinished = false;
      const generate = generateHarness({ harness, type: "job", input: {}, session: "same" }).then(() => {
        generateFinished = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(generateFinished).toBe(false);

      streamController.enqueue({ type: "text-end", id: "0" });
      streamController.enqueue(finishChunk());
      streamController.close();

      await stream.finished;
      await generate;
      expect(generateFinished).toBe(true);
    });
  });

  it("commits after-turn Persistent Dir changes after the stream finishes", async () => {
    await withTempDir(async (dir) => {
      const stored: unknown[] = [];
      const harness = createHarness({
        host: localHost({ dataDir: dir }),
        model: streamingTextModel("done"),
        persistentDirs: [
          {
            harnessDir: "/persistent/memory",
            load: () => ({}),
            store: ({ changes }) => {
              stored.push(changes);
            },
          },
        ],
        inputTypes: {
          job: inputType({
            description: "Write memory.",
            toMessages: async ({ files }) => {
              await files.writeText("/persistent/memory/stream.txt", "stream");
              return [{ role: "user", content: "Write stream memory" }];
            },
          }),
        },
      });

      const result = streamHarness({ harness, type: "job", input: {}, session: "job" });
      await result.finished;

      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({
        created: { "stream.txt": expect.any(Uint8Array) },
        updated: {},
        deleted: [],
      });
    });
  });

  it("continues the default streaming agent loop after tool calls", async () => {
    await withTempDir(async (dir) => {
      let call = 0;
      const model = new MockLanguageModelV3({
        provider: "test",
        modelId: "stream-tool-loop",
        doStream: async () => {
          call += 1;
          return {
            stream: new ReadableStream({
              start(controller) {
                controller.enqueue({ type: "stream-start", warnings: [] });
                if (call === 1) {
                  controller.enqueue({
                    type: "tool-call",
                    toolCallId: "call_1",
                    toolName: "writeArtifact",
                    input: JSON.stringify({ text: "stream" }),
                  });
                  controller.enqueue({
                    type: "finish",
                    finishReason: { unified: "tool-calls", raw: "tool-calls" },
                    usage,
                  });
                } else {
                  controller.enqueue({ type: "text-start", id: "0" });
                  controller.enqueue({ type: "text-delta", id: "0", delta: "stream final" });
                  controller.enqueue({ type: "text-end", id: "0" });
                  controller.enqueue(finishChunk());
                }
                controller.close();
              },
            }),
          };
        },
      });
      const harness = createHarness({
        host: localHost({ dataDir: dir }),
        model,
        tools: {
          writeArtifact: tool({
            description: "Write an artifact.",
            inputSchema: z.object({ text: z.string() }),
            execute: async ({ text }, ctx: any) => {
              await ctx.files.writeText("/artifacts/stream/out.txt", text);
              return { ok: true };
            },
          }),
        },
      });

      const result = streamHarness({
        harness,
        messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "Run tool." }] }] as UIMessage[],
        session: "stream-tool-loop",
      });

      expect(await result.text).toBe("stream final");
      await result.finished;
      expect(model.doStreamCalls).toHaveLength(2);
      const session = await harness.sessions.get("stream-tool-loop");
      expect((await session!.files.read("/artifacts/stream/out.txt")).text()).toBe("stream");
    });
  });

  it("exposes configured tools to the runtime bridge during streaming when only bash is active for the provider", async () => {
    await withTempDir(async (dir) => {
      let call = 0;
      const events: any[] = [];
      const model = new MockLanguageModelV3({
        provider: "test",
        modelId: "stream-runtime-bridge-active-bash",
        doStream: async () => {
          call += 1;
          return {
            stream: new ReadableStream({
              start(controller) {
                controller.enqueue({ type: "stream-start", warnings: [] });
                if (call === 1) {
                  controller.enqueue({
                    type: "tool-call",
                    toolCallId: "call_bash",
                    toolName: "bash",
                    input: JSON.stringify({
                      command: "js-exec -c 'console.log((await tools.add({a:19,b:23})).sum)'",
                    }),
                  });
                  controller.enqueue({
                    type: "finish",
                    finishReason: { unified: "tool-calls", raw: "tool-calls" },
                    usage,
                  });
                } else {
                  controller.enqueue({ type: "text-start", id: "0" });
                  controller.enqueue({ type: "text-delta", id: "0", delta: "stream final after bridge" });
                  controller.enqueue({ type: "text-end", id: "0" });
                  controller.enqueue(finishChunk());
                }
                controller.close();
              },
            }),
          };
        },
      });
      const harness = createHarness({
        host: localHost({ dataDir: dir }),
        model,
        tools: {
          add: tool({
            description: "Add two numbers.",
            inputSchema: z.object({ a: z.number(), b: z.number() }),
            execute: async ({ a, b }) => ({ sum: a + b }),
          }),
        },
        onEvent: (event) => {
          events.push(event);
        },
      });

      const result = streamHarness({
        harness,
        messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "Use bash." }] }] as UIMessage[],
        session: "stream-runtime-bridge-active-bash",
        activeTools: ["bash"],
      });

      expect(await result.text).toBe("stream final after bridge");
      const finished = await result.finished;
      expect(finished.session.id).toBe("stream-runtime-bridge-active-bash");
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "harness.tool_call.started",
            metadata: expect.objectContaining({ caller: "runtime", toolName: "add" }),
          }),
          expect.objectContaining({
            type: "harness.tool_call.succeeded",
            metadata: expect.objectContaining({
              caller: "runtime",
              toolName: "add",
              output: expect.objectContaining({ preview: expect.stringContaining("\"sum\": 42") }),
            }),
          }),
        ]),
      );
    });
  });

  it("does not advertise runtime bridge calls during streaming when activeTools excludes bash", async () => {
    await withTempDir(async (dir) => {
      let seenPrompt = "";
      const model = new MockLanguageModelV3({
        provider: "test",
        modelId: "stream-runtime-bridge-inactive-bash-hints",
        doStream: async (options) => {
          seenPrompt = JSON.stringify(options.prompt);
          return {
            stream: new ReadableStream({
              start(controller) {
                controller.enqueue({ type: "stream-start", warnings: [] });
                controller.enqueue({ type: "text-start", id: "0" });
                controller.enqueue({ type: "text-delta", id: "0", delta: "stream no bridge hint" });
                controller.enqueue({ type: "text-end", id: "0" });
                controller.enqueue(finishChunk());
                controller.close();
              },
            }),
          };
        },
      });
      const harness = createHarness({
        host: localHost({ dataDir: dir }),
        model,
        tools: {
          add: tool({
            description: "Add two numbers.",
            inputSchema: z.object({ a: z.number(), b: z.number() }),
            execute: async ({ a, b }) => ({ sum: a + b }),
          }),
        },
      });

      const result = streamHarness({
        harness,
        messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "No bash." }] }] as UIMessage[],
        session: "stream-runtime-bridge-inactive-bash-hints",
        activeTools: ["add"],
      });

      expect(await result.text).toBe("stream no bridge hint");
      await result.finished;
      expect(seenPrompt).not.toContain("js-exec");
      expect(seenPrompt).not.toContain("tools.add");
    });
  });

  it("does not advertise runtime bridge calls during streaming when prepareStep activeTools excludes bash", async () => {
    await withTempDir(async (dir) => {
      let seenPrompt = "";
      let seenToolNames: string[] = [];
      const model = new MockLanguageModelV3({
        provider: "test",
        modelId: "stream-runtime-bridge-prepare-step-inactive-bash-hints",
        doStream: async (options) => {
          seenPrompt = JSON.stringify(options.prompt);
          seenToolNames = providerToolNames(options.tools);
          return {
            stream: new ReadableStream({
              start(controller) {
                controller.enqueue({ type: "stream-start", warnings: [] });
                controller.enqueue({ type: "text-start", id: "0" });
                controller.enqueue({ type: "text-delta", id: "0", delta: "stream prepare step no bridge hint" });
                controller.enqueue({ type: "text-end", id: "0" });
                controller.enqueue(finishChunk());
                controller.close();
              },
            }),
          };
        },
      });
      const harness = createHarness({
        host: localHost({ dataDir: dir }),
        model,
        tools: {
          add: tool({
            description: "Add two numbers.",
            inputSchema: z.object({ a: z.number(), b: z.number() }),
            execute: async ({ a, b }) => ({ sum: a + b }),
          }),
        },
      });

      const result = streamHarness({
        harness,
        messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "No bash." }] }] as UIMessage[],
        session: "stream-runtime-bridge-prepare-step-inactive-bash-hints",
        prepareStep: () => ({ activeTools: ["add"] }) as any,
      });

      expect(await result.text).toBe("stream prepare step no bridge hint");
      await result.finished;
      expect(seenToolNames).toEqual(["add"]);
      expect(seenPrompt).not.toContain("js-exec");
      expect(seenPrompt).not.toContain("tools.add");
    });
  });

  it("keeps activeTools hint gating during streaming when prepareStep returns undefined overrides", async () => {
    await withTempDir(async (dir) => {
      let seenPrompt = "";
      let seenToolNames: string[] = [];
      const model = new MockLanguageModelV3({
        provider: "test",
        modelId: "stream-runtime-bridge-prepare-step-undefined-hints",
        doStream: async (options) => {
          seenPrompt = JSON.stringify(options.prompt);
          seenToolNames = providerToolNames(options.tools);
          return {
            stream: new ReadableStream({
              start(controller) {
                controller.enqueue({ type: "stream-start", warnings: [] });
                controller.enqueue({ type: "text-start", id: "0" });
                controller.enqueue({ type: "text-delta", id: "0", delta: "stream undefined prepare step no bridge hint" });
                controller.enqueue({ type: "text-end", id: "0" });
                controller.enqueue(finishChunk());
                controller.close();
              },
            }),
          };
        },
      });
      const harness = createHarness({
        host: localHost({ dataDir: dir }),
        model,
        system: "Keep this stream base system.",
        tools: {
          add: tool({
            description: "Add two numbers.",
            inputSchema: z.object({ a: z.number(), b: z.number() }),
            execute: async ({ a, b }) => ({ sum: a + b }),
          }),
        },
      });

      const result = streamHarness({
        harness,
        messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "No bash." }] }] as UIMessage[],
        session: "stream-runtime-bridge-prepare-step-undefined-hints",
        activeTools: ["add"],
        prepareStep: () => ({ activeTools: undefined, system: undefined }) as any,
      });

      expect(await result.text).toBe("stream undefined prepare step no bridge hint");
      await result.finished;
      expect(seenToolNames).toEqual(["add"]);
      expect(seenPrompt).toContain("Keep this stream base system.");
      expect(seenPrompt).not.toContain("js-exec");
      expect(seenPrompt).not.toContain("tools.add");
    });
  });

  it("emits per-step model telemetry during streaming tool loops", async () => {
    await withTempDir(async (dir) => {
      let call = 0;
      const events: any[] = [];
      const model = new MockLanguageModelV3({
        provider: "test",
        modelId: "stream-step-telemetry",
        doStream: async () => {
          call += 1;
          return {
            stream: new ReadableStream({
              start(controller) {
                controller.enqueue({ type: "stream-start", warnings: [] });
                if (call === 1) {
                  controller.enqueue({
                    type: "tool-call",
                    toolCallId: "call_1",
                    toolName: "lookup",
                    input: JSON.stringify({ query: "alpha" }),
                  });
                  controller.enqueue({
                    type: "finish",
                    finishReason: { unified: "tool-calls", raw: "tool-calls" },
                    usage,
                  });
                } else {
                  controller.enqueue({ type: "text-start", id: "0" });
                  controller.enqueue({ type: "text-delta", id: "0", delta: "stream final" });
                  controller.enqueue({ type: "text-end", id: "0" });
                  controller.enqueue(finishChunk());
                }
                controller.close();
              },
            }),
          };
        },
      });
      const harness = createHarness({
        host: localHost({ dataDir: dir }),
        model,
        tools: {
          lookup: tool({
            description: "Lookup data.",
            inputSchema: z.object({ query: z.string() }),
            execute: async () => ({ value: 42 }),
          }),
        },
        onEvent: (event) => {
          events.push(event);
        },
      });

      const result = streamHarness({
        harness,
        messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "Lookup." }] }] as UIMessage[],
        session: "stream-step-telemetry",
      });

      expect(await result.text).toBe("stream final");
      await result.finished;

      const requested = events.filter((event) => event.type === "harness.model.called");
      const responded = events.filter((event) => event.type === "harness.model.responded");
      expect(requested.map((event) => event.stepId)).toEqual(["step_1", "step_2"]);
      expect(responded.map((event) => event.stepId)).toEqual(["step_1", "step_2"]);
      expect(responded[0]).toMatchObject({
        metadata: {
          finishReason: "tool-calls",
          toolCalls: [
            expect.objectContaining({
              toolName: "lookup",
              toolCallId: "call_1",
              input: expect.objectContaining({ captured: true }),
            }),
          ],
        },
      });
      expect(responded[1]).toMatchObject({
        metadata: {
          finishReason: "stop",
          text: expect.objectContaining({ preview: "stream final" }),
        },
      });
    });
  });

  it("emits durable model call and response payloads during streaming", async () => {
    await withTempDir(async (dir) => {
      const durable: unknown[] = [];
      const harness = createHarness({
        host: localHost({ dataDir: dir }),
        model: streamingTextModel("stream durable"),
        durability: {
          append: async (event) => {
            durable.push(event);
          },
        },
      });

      const result = streamHarness({
        harness,
        messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "Hi" }] }] as UIMessage[],
        session: "stream-durable-model",
        runId: "run_stream_durable_model",
      });

      expect(await result.text).toBe("stream durable");
      await result.finished;

      const called = durable.find(
        (event) => (event as { type?: string }).type === "harness.model.called",
      ) as { runId?: string; occurrenceId?: string; payload?: { callId?: string; turn?: number } };
      const responded = durable.find(
        (event) => (event as { type?: string }).type === "harness.model.responded",
      ) as {
        runId?: string;
        occurrenceId?: string;
        payload?: { callId?: string; turn?: number; response?: { text?: string } };
      };

      expect(called).toMatchObject({
        runId: "run_stream_durable_model",
        occurrenceId: expect.any(String),
        payload: expect.objectContaining({
          callId: expect.any(String),
          turn: 1,
        }),
      });
      expect(responded).toMatchObject({
        runId: "run_stream_durable_model",
        occurrenceId: called.occurrenceId,
        payload: expect.objectContaining({
          callId: called.payload?.callId,
          turn: 1,
          response: expect.objectContaining({ text: "stream durable" }),
        }),
      });
    });
  });

  it("replays a completed single stream response for the same runId without calling the provider again", async () => {
    await withTempDir(async (dir) => {
      const durability = replayDurability();
      const model = streamingTextModel("cached stream");
      const harness = createHarness({
        host: localHost({ dataDir: dir }),
        model,
        durability: durability.sink,
      });
      const messages = [{ id: "m1", role: "user", parts: [{ type: "text", text: "Cache stream." }] }] as UIMessage[];

      const first = streamHarness({ harness, messages, session: "stream-replay", runId: "run_stream_replay" });
      expect(await first.text).toBe("cached stream");
      await first.finished;

      const second = streamHarness({ harness, messages, session: "stream-replay", runId: "run_stream_replay" });
      expect(await second.text).toBe("cached stream");
      const replayBody = await second.toUIMessageStreamResponse().text();
      expect(replayBody).toContain('"type":"text-start"');
      expect(replayBody).toContain('"type":"text-delta"');
      expect(replayBody).toContain('"type":"text-end"');
      await second.finished;

      expect(model.doStreamCalls).toHaveLength(1);
    });
  });

  it("does not replay a completed stream response when activeTools changes", async () => {
    await withTempDir(async (dir) => {
      const durability = replayDurability();
      const model = reusableStreamingTextModel("active-tools-sensitive stream");
      const harness = createHarness({
        host: localHost({ dataDir: dir }),
        model,
        durability: durability.sink,
        tools: {
          lookup: tool({
            description: "Lookup data.",
            inputSchema: z.object({ query: z.string() }),
            execute: async () => ({ value: 42 }),
          }),
        },
      });
      const messages = [
        { id: "m1", role: "user", parts: [{ type: "text", text: "Active tools sensitive stream." }] },
      ] as UIMessage[];

      const first = streamHarness({
        harness,
        messages,
        session: "stream-active-tools-replay",
        runId: "run_stream_active_tools_replay",
        activeTools: ["lookup"],
      });
      expect(await first.text).toBe("active-tools-sensitive stream");
      await first.finished;

      const second = streamHarness({
        harness,
        messages,
        session: "stream-active-tools-replay",
        runId: "run_stream_active_tools_replay",
        activeTools: ["bash"],
      });
      expect(await second.text).toBe("active-tools-sensitive stream");
      await second.finished;

      expect(model.doStreamCalls).toHaveLength(2);
      expect(
        durability.events
          .filter((event) => event.type === "harness.model.called")
          .map((event) => (event.payload as { request?: { settings?: { activeTools?: string[] } } }).request?.settings?.activeTools),
      ).toEqual([["lookup"], ["bash"]]);
    });
  });

  it("does not replay a completed stream response when activeTools changes from empty to omitted", async () => {
    await withTempDir(async (dir) => {
      const durability = replayDurability();
      const model = reusableStreamingTextModel("empty-active-tools-sensitive stream");
      const harness = createHarness({
        host: localHost({ dataDir: dir }),
        model,
        durability: durability.sink,
        tools: {
          lookup: tool({
            description: "Lookup data.",
            inputSchema: z.object({ query: z.string() }),
            execute: async () => ({ value: 42 }),
          }),
        },
      });
      const messages = [
        { id: "m1", role: "user", parts: [{ type: "text", text: "Empty active tools stream." }] },
      ] as UIMessage[];

      const first = streamHarness({
        harness,
        messages,
        session: "stream-empty-active-tools-replay",
        runId: "run_stream_empty_active_tools_replay",
        activeTools: [],
      });
      expect(await first.text).toBe("empty-active-tools-sensitive stream");
      await first.finished;

      const second = streamHarness({
        harness,
        messages,
        session: "stream-empty-active-tools-replay",
        runId: "run_stream_empty_active_tools_replay",
      });
      expect(await second.text).toBe("empty-active-tools-sensitive stream");
      await second.finished;

      expect(model.doStreamCalls).toHaveLength(2);
      const firstModelCall = durability.events.find((event) => event.type === "harness.model.called");
      expect(
        (firstModelCall?.payload as { request?: { settings?: { activeTools?: string[] } } } | undefined)
          ?.request?.settings?.activeTools,
      ).toEqual([]);
    });
  });

  it("replays a completed stream response when activeTools order and duplicates change", async () => {
    await withTempDir(async (dir) => {
      const durability = replayDurability();
      const model = reusableStreamingTextModel("active-tools-set stream");
      const harness = createHarness({
        host: localHost({ dataDir: dir }),
        model,
        durability: durability.sink,
        tools: {
          lookup: tool({
            description: "Lookup data.",
            inputSchema: z.object({ query: z.string() }),
            execute: async () => ({ value: 42 }),
          }),
        },
      });
      const messages = [
        { id: "m1", role: "user", parts: [{ type: "text", text: "Active tools set stream." }] },
      ] as UIMessage[];

      const first = streamHarness({
        harness,
        messages,
        session: "stream-active-tools-set-replay",
        runId: "run_stream_active_tools_set_replay",
        activeTools: ["lookup", "bash", "lookup"],
      });
      expect(await first.text).toBe("active-tools-set stream");
      await first.finished;

      const second = streamHarness({
        harness,
        messages,
        session: "stream-active-tools-set-replay",
        runId: "run_stream_active_tools_set_replay",
        activeTools: ["bash", "lookup"],
      });
      expect(await second.text).toBe("active-tools-set stream");
      await second.finished;

      expect(model.doStreamCalls).toHaveLength(1);
    });
  });

  it("does not replay a completed stream response when prepareStep changes activeTools", async () => {
    await withTempDir(async (dir) => {
      const durability = replayDurability();
      const model = reusableStreamingTextModel("prepare-step-active-tools stream");
      const harness = createHarness({
        host: localHost({ dataDir: dir }),
        model,
        durability: durability.sink,
        tools: {
          lookup: tool({
            description: "Lookup data.",
            inputSchema: z.object({ query: z.string() }),
            execute: async () => ({ value: 42 }),
          }),
        },
      });
      const messages = [
        { id: "m1", role: "user", parts: [{ type: "text", text: "Prepare step active tools stream." }] },
      ] as UIMessage[];

      const first = streamHarness({
        harness,
        messages,
        session: "stream-prepare-step-active-tools-replay",
        runId: "run_stream_prepare_step_active_tools_replay",
        prepareStep: () => ({ activeTools: ["lookup"] }) as any,
      });
      expect(await first.text).toBe("prepare-step-active-tools stream");
      await first.finished;

      const second = streamHarness({
        harness,
        messages,
        session: "stream-prepare-step-active-tools-replay",
        runId: "run_stream_prepare_step_active_tools_replay",
        prepareStep: () => ({ activeTools: ["bash"] }) as any,
      });
      expect(await second.text).toBe("prepare-step-active-tools stream");
      await second.finished;

      expect(model.doStreamCalls).toHaveLength(2);
      const preparedActiveTools = durability.events
        .filter((event) => event.type === "harness.model.called")
        .map((event) => (event.payload as { request?: { settings?: { activeTools?: string[] } } }).request?.settings?.activeTools);
      expect(preparedActiveTools).toEqual([["lookup"], ["bash"]]);
    });
  });

  it("does not replay a completed stream response when toolChoice changes", async () => {
    await withTempDir(async (dir) => {
      const durability = replayDurability();
      const model = reusableStreamingTextModel("tool-choice-sensitive stream");
      const harness = createHarness({
        host: localHost({ dataDir: dir }),
        model,
        durability: durability.sink,
        tools: {
          lookup: tool({
            description: "Lookup data.",
            inputSchema: z.object({ query: z.string() }),
            execute: async () => ({ value: 42 }),
          }),
        },
      });
      const messages = [
        { id: "m1", role: "user", parts: [{ type: "text", text: "Tool choice sensitive stream." }] },
      ] as UIMessage[];

      const first = streamHarness({
        harness,
        messages,
        session: "stream-tool-choice-replay",
        runId: "run_stream_tool_choice_replay",
        toolChoice: "auto",
      });
      expect(await first.text).toBe("tool-choice-sensitive stream");
      await first.finished;

      const second = streamHarness({
        harness,
        messages,
        session: "stream-tool-choice-replay",
        runId: "run_stream_tool_choice_replay",
        toolChoice: { type: "tool", toolName: "lookup" } as any,
      });
      expect(await second.text).toBe("tool-choice-sensitive stream");
      await second.finished;

      expect(model.doStreamCalls).toHaveLength(2);
    });
  });

  it("reuses an inflight stream callId and appends only the terminal event after a crash window", async () => {
    await withTempDir(async (dir) => {
      const initial = replayDurability();
      const firstHarness = createHarness({
        host: localHost({ dataDir: path.join(dir, "first") }),
        model: streamingTextModel("before crash"),
        durability: initial.sink,
      });
      const messages = [{ id: "m1", role: "user", parts: [{ type: "text", text: "Resume stream." }] }] as UIMessage[];
      const first = streamHarness({ harness: firstHarness, messages, session: "stream-crash", runId: "run_stream_crash" });
      expect(await first.text).toBe("before crash");
      await first.finished;

      const called = initial.events.find((event) => event.type === "harness.model.called");
      expect(called).toBeDefined();
      const crashWindow = replayDurability([called!]);
      const model = streamingTextModel("after crash");
      const harness = createHarness({
        host: localHost({ dataDir: path.join(dir, "second") }),
        model,
        durability: crashWindow.sink,
      });

      const result = streamHarness({ harness, messages, session: "stream-crash", runId: "run_stream_crash" });
      expect(await result.text).toBe("after crash");
      await result.finished;

      const modelEvents = crashWindow.events.filter((event) => event.type.startsWith("harness.model."));
      const responded = crashWindow.events.find((event) => event.type === "harness.model.responded");
      expect(model.doStreamCalls).toHaveLength(1);
      expect(modelEvents.filter((event) => event.type === "harness.model.called")).toHaveLength(1);
      expect(responded).toMatchObject({
        occurrenceId: called!.occurrenceId,
        payload: expect.objectContaining({
          callId: (called!.payload as { callId?: string }).callId,
          turn: (called!.payload as { turn?: number }).turn,
          response: expect.objectContaining({ text: "after crash" }),
        }),
      });
    });
  });

  it("starts a fresh stream model call after a prior terminal model failure", async () => {
    await withTempDir(async (dir) => {
      const durability = replayDurability();
      const failingHarness = createHarness({
        host: localHost({ dataDir: path.join(dir, "failed") }),
        model: new MockLanguageModelV3({
          provider: "test",
          modelId: "test-model",
          doGenerate: async () => {
            throw new Error("provider down");
          },
        }),
        durability: durability.sink,
      });
      const messages = [{ id: "m1", role: "user", parts: [{ type: "text", text: "Retry stream." }] }] as UIMessage[];

      await expect(
        generateHarness({ harness: failingHarness, messages, session: "stream-terminal-failed", runId: "run_stream_terminal_failed" }),
      ).rejects.toThrow("provider down");

      const failedCall = durability.events.find((event) => event.type === "harness.model.called");
      const model = streamingTextModel("stream recovered");
      const harness = createHarness({
        host: localHost({ dataDir: path.join(dir, "recovered") }),
        model,
        durability: durability.sink,
      });

      const result = streamHarness({ harness, messages, session: "stream-terminal-failed", runId: "run_stream_terminal_failed" });
      expect(await result.text).toBe("stream recovered");
      await result.finished;

      const modelCalled = durability.events.filter((event) => event.type === "harness.model.called");
      const recoveredResponse = durability.events.find(
        (event) =>
          event.type === "harness.model.responded" &&
          (event.payload as { response?: { text?: string } }).response?.text === "stream recovered",
      );

      expect(model.doStreamCalls).toHaveLength(1);
      expect(modelCalled).toHaveLength(2);
      expect((recoveredResponse!.payload as { callId?: string }).callId).not.toBe(
        (failedCall!.payload as { callId?: string }).callId,
      );
      expect(recoveredResponse).toMatchObject({
        payload: expect.objectContaining({
          response: expect.objectContaining({ text: "stream recovered" }),
        }),
      });
    });
  });

  it("reuses an inflight second stream model call in a tool loop without appending a duplicate called event", async () => {
    await withTempDir(async (dir) => {
      const initial = replayDurability();
      let firstProviderCalls = 0;
      const firstHarness = createHarness({
        host: localHost({ dataDir: path.join(dir, "first") }),
        model: new MockLanguageModelV3({
          provider: "test",
          modelId: "stream-tool-loop-replay",
          doStream: async () => {
            firstProviderCalls += 1;
            return {
              stream: new ReadableStream({
                start(controller) {
                  controller.enqueue({ type: "stream-start", warnings: [] });
                  if (firstProviderCalls === 1) {
                    controller.enqueue({
                      type: "tool-call",
                      toolCallId: "call_1",
                      toolName: "lookup",
                      input: JSON.stringify({ query: "alpha" }),
                    });
                    controller.enqueue({
                      type: "finish",
                      finishReason: { unified: "tool-calls", raw: "tool-calls" },
                      usage,
                    });
                  } else {
                    controller.enqueue({ type: "text-start", id: "0" });
                    controller.enqueue({ type: "text-delta", id: "0", delta: "first stream final" });
                    controller.enqueue({ type: "text-end", id: "0" });
                    controller.enqueue(finishChunk());
                  }
                  controller.close();
                },
              }),
            };
          },
        }),
        durability: initial.sink,
        tools: {
          lookup: tool({
            description: "Lookup data.",
            inputSchema: z.object({ query: z.string() }),
            execute: async () => ({ value: 42 }),
          }),
        },
      });
      const messages = [{ id: "m1", role: "user", parts: [{ type: "text", text: "Lookup stream." }] }] as UIMessage[];

      const first = streamHarness({ harness: firstHarness, messages, session: "stream-second-step-crash", runId: "run_stream_second_step_crash" });
      expect(await first.text).toBe("first stream final");
      await first.finished;
      const secondCalled = initial.events.filter((event) => event.type === "harness.model.called")[1];
      expect(secondCalled).toBeDefined();

      const crashWindow = replayDurability([secondCalled!]);
      let providerCalls = 0;
      const harness = createHarness({
        host: localHost({ dataDir: path.join(dir, "second") }),
        model: new MockLanguageModelV3({
          provider: "test",
          modelId: "stream-tool-loop-replay",
          doStream: async () => {
            providerCalls += 1;
            return {
              stream: new ReadableStream({
                start(controller) {
                  controller.enqueue({ type: "stream-start", warnings: [] });
                  if (providerCalls === 1) {
                    controller.enqueue({
                      type: "tool-call",
                      toolCallId: "call_1",
                      toolName: "lookup",
                      input: JSON.stringify({ query: "alpha" }),
                    });
                    controller.enqueue({
                      type: "finish",
                      finishReason: { unified: "tool-calls", raw: "tool-calls" },
                      usage,
                    });
                  } else {
                    controller.enqueue({ type: "text-start", id: "0" });
                    controller.enqueue({ type: "text-delta", id: "0", delta: "resumed stream final" });
                    controller.enqueue({ type: "text-end", id: "0" });
                    controller.enqueue(finishChunk());
                  }
                  controller.close();
                },
              }),
            };
          },
        }),
        durability: crashWindow.sink,
        tools: {
          lookup: tool({
            description: "Lookup data.",
            inputSchema: z.object({ query: z.string() }),
            execute: async () => ({ value: 42 }),
          }),
        },
      });

      const result = streamHarness({ harness, messages, session: "stream-second-step-crash", runId: "run_stream_second_step_crash" });
      expect(await result.text).toBe("resumed stream final");
      await result.finished;

      const modelCalled = crashWindow.events.filter((event) => event.type === "harness.model.called");
      const resumedResponse = crashWindow.events.find(
        (event) =>
          event.type === "harness.model.responded" &&
          (event.payload as { callId?: string }).callId === (secondCalled!.payload as { callId?: string }).callId,
      );

      expect(providerCalls).toBe(2);
      expect(modelCalled).toHaveLength(2);
      expect(resumedResponse).toMatchObject({
        occurrenceId: secondCalled!.occurrenceId,
        payload: expect.objectContaining({
          callId: (secondCalled!.payload as { callId?: string }).callId,
          response: expect.objectContaining({ text: "resumed stream final" }),
        }),
      });
    });
  });

  it("mounts skills for streaming turns and exposes manual commit on finished", async () => {
    await withTempDir(async (dir) => {
      const skillRoot = path.join(dir, "skills", "stream-skill");
      await mkdir(skillRoot, { recursive: true });
      await writeFile(
        path.join(skillRoot, "SKILL.md"),
        "---\nname: stream-skill\ndescription: Streaming skill.\n---\n\nUse stream context.",
        "utf8",
      );
      const stored: unknown[] = [];
      const harness = createHarness({
        host: localHost({ dataDir: path.join(dir, "harness") }),
        model: streamingTextModel("stream done"),
        skills: [skillRoot],
        persistentDirs: [
          {
            harnessDir: "/persistent/manual",
            commit: "manual",
            load: () => ({}),
            store: ({ changes }) => {
              stored.push(changes);
            },
          },
        ],
        inputTypes: {
          job: inputType({
            description: "Read mounted streaming skill.",
            toMessages: async ({ files }) => {
              await files.read("/.agents/skills/stream-skill/SKILL.md");
              await files.writeText("/persistent/manual/stream.md", "manual stream");
              return [{ role: "user", content: "Stream manual commit." }];
            },
          }),
        },
      });

      const result = streamHarness({ harness, type: "job", input: {}, session: "stream-manual" });
      const finished = await result.finished;

      expect(await result.text).toBe("stream done");
      expect(stored).toHaveLength(0);
      await finished.commitManual();
      expect(stored).toHaveLength(1);
    });
  });
});
