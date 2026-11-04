import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { jsonSchema, tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { createHarness } from "../create-harness.js";
import { localHost } from "../local-host/local-host.js";
import type { HarnessEvent } from "../types.js";
import { generateHarness } from "./generate-harness.js";
import { streamHarness } from "./stream-harness.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

const lookup = tool({
  description: "Look up an application.",
  inputSchema: jsonSchema<{ id: string }>({ type: "object", properties: { id: { type: "string" } }, required: ["id"] }),
  execute: async ({ id }) => ({ id, status: "open" }),
});

type Call = { prompt: unknown[]; providerOptions: unknown; tools: unknown };

/** A model that calls `lookup` once and then answers, recording what each call was sent. */
function recordingModel(provider = "test") {
  const calls: Call[] = [];
  const record = (options: { prompt: unknown; providerOptions?: unknown; tools?: unknown }) =>
    calls.push({ prompt: options.prompt as unknown[], providerOptions: options.providerOptions, tools: options.tools });
  const reply = () =>
    calls.length % 2 === 1
      ? { type: "tool-call" as const, toolCallId: `call_${calls.length}`, toolName: "lookup", input: JSON.stringify({ id: "APP-1" }) }
      : { type: "text" as const, text: "done" };
  const model = new MockLanguageModelV4({
    provider,
    modelId: "recording",
    doGenerate: async (options) => {
      record(options);
      const part = reply();
      return {
        content: [part],
        finishReason: part.type === "tool-call" ? { unified: "tool-calls", raw: "tool_use" } : { unified: "stop", raw: "stop" },
        usage,
        warnings: [],
      };
    },
    doStream: async (options) => {
      record(options);
      const part = reply();
      const parts =
        part.type === "tool-call"
          ? [part]
          : [
              { type: "text-start", id: "0" },
              { type: "text-delta", id: "0", delta: part.text },
              { type: "text-end", id: "0" },
            ];
      return {
        stream: new ReadableStream({
          start(controller) {
            for (const chunk of [
              { type: "stream-start", warnings: [] },
              ...parts,
              {
                type: "finish",
                finishReason: part.type === "tool-call" ? { unified: "tool-calls", raw: "tool_use" } : { unified: "stop", raw: "stop" },
                usage,
              },
            ]) {
              controller.enqueue(chunk);
            }
            controller.close();
          },
        }),
      } as never;
    },
  });
  return { model, calls };
}

async function harnessWith(options: { promptCaching?: boolean; events?: HarnessEvent[]; provider?: string } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "prompt-caching-"));
  dirs.push(dataDir);
  const { model, calls } = recordingModel(options.provider);
  const harness = createHarness({
    host: localHost({ dataDir }),
    model,
    system: "You review loan applications.",
    tools: { lookup },
    runtime: { bash: false },
    ...(options.promptCaching === undefined ? {} : { promptCaching: options.promptCaching }),
    ...(options.events === undefined ? {} : { onEvent: (event: HarnessEvent) => void options.events!.push(event) }),
  });
  return { harness, calls };
}

const ask = (text: string) => [{ id: "m1", role: "user" as const, parts: [{ type: "text" as const, text }] }];

function systemMessage(call: Call | undefined) {
  return call?.prompt[0] as { role: string; content: string; providerOptions?: unknown };
}

describe("prompt caching", () => {
  it("puts a cache point on the system prompt and turns on Anthropic's automatic one, on every step", async () => {
    const { harness, calls } = await harnessWith();
    const result = await generateHarness({ harness, session: "a", messages: ask("Review APP-1.") });

    expect(result.status).toBe("completed");
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(systemMessage(call)).toMatchObject({
        role: "system",
        content: expect.stringContaining("You review loan applications."),
        providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
      });
      expect(call.providerOptions).toMatchObject({ anthropic: { cacheControl: { type: "ephemeral" } } });
    }
  });

  it("sends the same tools and system prompt in every session, so the next session reads the cache", async () => {
    const { harness, calls } = await harnessWith();
    await generateHarness({ harness, session: "first", messages: ask("Review APP-1.") });
    await generateHarness({ harness, session: "second", messages: ask("Review APP-2.") });

    expect(calls).toHaveLength(4);
    expect(JSON.stringify(systemMessage(calls[2]))).toBe(JSON.stringify(systemMessage(calls[0])));
    expect(JSON.stringify(calls[2]?.tools)).toBe(JSON.stringify(calls[0]?.tools));
  });

  it("records the same model-call events with caching on or off", async () => {
    const hashes: string[][] = [];
    for (const promptCaching of [true, false]) {
      const events: HarnessEvent[] = [];
      const { harness } = await harnessWith({ promptCaching, events });
      await generateHarness({ harness, session: "a", messages: ask("Review APP-1.") });
      hashes.push(
        events
          .filter((event) => event.type === "harness.model.called")
          .map((event) => String((event as { metadata?: { request?: { promptHash?: unknown } } }).metadata?.request?.promptHash)),
      );
    }
    expect(hashes[0]).toHaveLength(2);
    expect(hashes[0]).toEqual(hashes[1]);
  });

  it("sends no cache points with promptCaching: false", async () => {
    const { harness, calls } = await harnessWith({ promptCaching: false });
    await generateHarness({ harness, session: "a", messages: ask("Review APP-1.") });

    expect(systemMessage(calls[0])?.providerOptions).toBeUndefined();
    expect(calls[0]?.providerOptions).toBeUndefined();
  });

  it("leaves out the automatic cache point on Amazon Bedrock and keeps the system prompt's", async () => {
    const { harness, calls } = await harnessWith({ provider: "bedrock.anthropic.messages" });
    await generateHarness({ harness, session: "a", messages: ask("Review APP-1.") });

    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(systemMessage(call)?.providerOptions).toEqual({ anthropic: { cacheControl: { type: "ephemeral" } } });
      expect(call.providerOptions).toBeUndefined();
    }
  });

  it("keeps a caller's own Anthropic options and TTL, and gives the system prompt the same TTL", async () => {
    const { harness, calls } = await harnessWith();
    await generateHarness({
      harness,
      session: "a",
      messages: ask("Review APP-1."),
      providerOptions: { anthropic: { cacheControl: { type: "ephemeral", ttl: "1h" }, disableParallelToolUse: true } },
    });

    expect(calls[0]?.providerOptions).toEqual({
      anthropic: { cacheControl: { type: "ephemeral", ttl: "1h" }, disableParallelToolUse: true },
    });
    expect(systemMessage(calls[0])?.providerOptions).toEqual({ anthropic: { cacheControl: { type: "ephemeral", ttl: "1h" } } });
  });

  it("keeps the cache point when prepareStep swaps the system prompt", async () => {
    const { harness, calls } = await harnessWith();
    await generateHarness({
      harness,
      session: "a",
      messages: ask("Review APP-1."),
      prepareStep: async () => ({ system: "Answer briefly." }),
    });

    expect(systemMessage(calls[1])).toMatchObject({
      content: expect.stringContaining("Answer briefly."),
      providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
    });
  });

  it("caches streamed turns the same way", async () => {
    const { harness, calls } = await harnessWith();
    const streaming = streamHarness({ harness, session: "a", messages: ask("Review APP-1.") });
    await streaming.text;
    expect((await streaming.finished).status).toBe("completed");

    expect(calls).toHaveLength(2);
    expect(systemMessage(calls[1])?.providerOptions).toEqual({ anthropic: { cacheControl: { type: "ephemeral" } } });
    expect(calls[1]?.providerOptions).toMatchObject({ anthropic: { cacheControl: { type: "ephemeral" } } });
  });
});
