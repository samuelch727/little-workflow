import { tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { createHarness } from "../create-harness.js";
import { localHost } from "../local-host/index.js";
import { withTempDir } from "../test/temp.js";
import { runRepl } from "./repl.js";

const mcpResolverMock = vi.hoisted(() => ({ resolveHarnessMcpGateway: vi.fn() }));
vi.mock("../mcp.js", () => ({ resolveHarnessMcpGateway: mcpResolverMock.resolveHarnessMcpGateway }));
mcpResolverMock.resolveHarnessMcpGateway.mockResolvedValue({
  tools: {},
  skills: [],
  manifest: { servers: [] },
  close: async () => {},
});

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

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

function streamingTextModel(parts: readonly string[]) {
  return new MockLanguageModelV3({
    provider: "test",
    modelId: "test-model",
    doStream: {
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({ type: "text-start", id: "0" });
          for (const part of parts) controller.enqueue({ type: "text-delta", id: "0", delta: part });
          controller.enqueue({ type: "text-end", id: "0" });
          controller.enqueue({ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage });
          controller.close();
        },
      }),
    },
  });
}

it("streams one turn then exits when read returns null", async () => {
  await withTempDir(async (dir) => {
    const harness = createHarness({ host: localHost({ dataDir: dir }), model: streamingTextModel(["hello ", "from agent"]) });
    const out: string[] = [];
    const lines: (string | null)[] = ["hi", null];
    await runRepl(harness, { stdout: (t) => { out.push(t); } }, async () => (lines.length ? lines.shift()! : null));
    expect(out.join("")).toContain("hello from agent");
  });
});

it("prints reasoning and tool input/output in the interactive stream", async () => {
  await withTempDir(async (dir) => {
    let call = 0;
    const model = new MockLanguageModelV3({
      provider: "test",
      modelId: "tool-stream-model",
      doStream: async () => ({
        stream: new ReadableStream({
          start(controller) {
            call += 1;
            controller.enqueue({ type: "stream-start", warnings: [] });
            if (call === 1) {
              controller.enqueue({ type: "reasoning-start", id: "reasoning_1" });
              controller.enqueue({
                type: "reasoning-delta",
                id: "reasoning_1",
                delta: "Need to look up the customer.",
              });
              controller.enqueue({ type: "reasoning-end", id: "reasoning_1" });
              controller.enqueue({
                type: "tool-call",
                toolCallId: "call_1",
                toolName: "lookupCustomer",
                input: JSON.stringify({ customerId: "cust_123" }),
              });
              controller.enqueue({
                type: "finish",
                finishReason: { unified: "tool-calls", raw: "tool-calls" },
                usage,
              });
            } else {
              controller.enqueue({ type: "text-start", id: "text_1" });
              controller.enqueue({ type: "text-delta", id: "text_1", delta: "Customer is enterprise." });
              controller.enqueue({ type: "text-end", id: "text_1" });
              controller.enqueue({ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage });
            }
            controller.close();
          },
        }),
      }),
    });
    const harness = createHarness({
      host: localHost({ dataDir: dir }),
      model,
      tools: {
        lookupCustomer: tool({
          description: "Look up a customer.",
          inputSchema: z.object({ customerId: z.string() }),
          execute: async ({ customerId }) => ({ customerId, tier: "enterprise" }),
        }),
      },
    });
    const out: string[] = [];
    const lines: (string | null)[] = ["lookup customer", null];

    await runRepl(
      harness,
      { stdout: (text) => { out.push(text); } },
      async () => (lines.length ? lines.shift()! : null),
    );

    const output = out.join("");
    expect(output).toContain("[reasoning]\nNeed to look up the customer.");
    expect(output).toContain("[tool call: lookupCustomer]");
    expect(output).toContain('"customerId": "cust_123"');
    expect(output).toContain("[tool result: lookupCustomer]");
    expect(output).toContain('"tier": "enterprise"');
    expect(output).toContain("[assistant]\nCustomer is enterprise.");
  });
});

it("merges connector tools and applies the connector toolPolicy to the REPL model turn", async () => {
  await withTempDir(async (dir) => {
    let seenToolNames: string[] = [];
    const model = new MockLanguageModelV3({
      provider: "test",
      modelId: "repl-connector-model",
      doStream: async (options) => {
        seenToolNames = providerToolNames(options.tools);
        return {
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({ type: "stream-start", warnings: [] });
              controller.enqueue({ type: "text-start", id: "0" });
              controller.enqueue({ type: "text-delta", id: "0", delta: "ok" });
              controller.enqueue({ type: "text-end", id: "0" });
              controller.enqueue({ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage });
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
        alpha: tool({ description: "alpha", inputSchema: z.object({}), execute: async () => "a" }),
        beta: tool({ description: "beta", inputSchema: z.object({}), execute: async () => "b" }),
      },
    });
    const lines: (string | null)[] = ["hi", null];

    await runRepl(
      harness,
      { stdout: () => {} },
      async () => (lines.length ? lines.shift()! : null),
      {
        connectorTools: {
          sendChannelUpdate: tool({
            description: "Send a channel update (connector-only).",
            inputSchema: z.object({ text: z.string() }),
            execute: async () => ({ ok: true }),
          }),
        },
        toolPolicy: { deny: ["beta"] },
      },
    );

    // Base executable tools + connector tools reach the model, narrowed by the deny policy.
    expect(seenToolNames).toContain("alpha");
    expect(seenToolNames).toContain("sendChannelUpdate");
    expect(seenToolNames).not.toContain("beta");
  });
});

it("keeps the interactive loop alive and rolls back failed user turns", async () => {
  await withTempDir(async (dir) => {
    let call = 0;
    let secondPrompt = "";
    const model = new MockLanguageModelV3({
      provider: "test",
      modelId: "failing-model",
      doStream: async (options) => {
        call += 1;
        if (call === 1) {
          throw new Error("model unavailable");
        }
        secondPrompt = JSON.stringify(options.prompt);
        return {
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({ type: "stream-start", warnings: [] });
              controller.enqueue({ type: "text-start", id: "text_1" });
              controller.enqueue({ type: "text-delta", id: "text_1", delta: "recovered" });
              controller.enqueue({ type: "text-end", id: "text_1" });
              controller.enqueue({ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage });
              controller.close();
            },
          }),
        };
      },
    });
    const harness = createHarness({ host: localHost({ dataDir: dir }), model });
    const out: string[] = [];
    const lines: (string | null)[] = ["first fails", "second works", ":exit"];

    await runRepl(
      harness,
      { stdout: (text) => { out.push(text); } },
      async () => (lines.length ? lines.shift()! : null),
    );

    const output = out.join("");
    expect(output).toContain("[error]\nmodel unavailable");
    expect(output.match(/\[error\]/gu)).toHaveLength(1);
    expect(output).toContain("[assistant]\nrecovered");
    expect(secondPrompt).not.toContain("first fails");
    expect(secondPrompt).toContain("second works");
    expect(output.match(/\nyou> /gu)).toHaveLength(3);
  });
});

it("drops a completed turn with empty assistant text from conversation history", async () => {
  await withTempDir(async (dir) => {
    let call = 0;
    let secondPrompt = "";
    const model = new MockLanguageModelV3({
      provider: "test",
      modelId: "empty-then-text",
      doStream: async (options) => {
        call += 1;
        if (call === 1) {
          return {
            stream: new ReadableStream({
              start(controller) {
                controller.enqueue({ type: "stream-start", warnings: [] });
                controller.enqueue({ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage });
                controller.close();
              },
            }),
          };
        }
        secondPrompt = JSON.stringify(options.prompt);
        return {
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({ type: "stream-start", warnings: [] });
              controller.enqueue({ type: "text-start", id: "text_1" });
              controller.enqueue({ type: "text-delta", id: "text_1", delta: "ok" });
              controller.enqueue({ type: "text-end", id: "text_1" });
              controller.enqueue({ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage });
              controller.close();
            },
          }),
        };
      },
    });
    const harness = createHarness({ host: localHost({ dataDir: dir }), model });
    const lines: (string | null)[] = ["first", "second", ":exit"];

    await runRepl(harness, { stdout: () => {} }, async () => (lines.length ? lines.shift()! : null));

    // The empty first turn must not be recorded as an assistant message (no empty text part
    // that a strict provider could reject on the next turn) or left as a dangling user turn.
    const promptRoles = (JSON.parse(secondPrompt) as Array<{ role: string }>)
      .map((m) => m.role)
      .filter((role) => role !== "system");
    expect(promptRoles).toEqual(["user"]);
  });
});

it("exits on :exit without invoking the model", async () => {
  await withTempDir(async (dir) => {
    const model = streamingTextModel(["x"]);
    const harness = createHarness({ host: localHost({ dataDir: dir }), model });
    let reads = 0;
    await runRepl(harness, { stdout: () => {} }, async () => {
      reads += 1;
      return reads === 1 ? ":exit" : null;
    });
    expect(reads).toBe(1);
  });
});

it("prints parked continuation summaries and returns to the prompt", async () => {
  await withTempDir(async (dir) => {
    const harness = createHarness({ host: localHost({ dataDir: dir }), model: streamingTextModel(["unexpected"]) });
    const out: string[] = [];
    const lines: (string | null)[] = ["wait", null];
    const stream = vi.fn(() => ({
      text: Promise.resolve(""),
      output: Promise.resolve(""),
      textStream: (async function* () {})(),
      toUIMessageStream: () => new ReadableStream({
        start(controller) {
          controller.close();
        },
      }),
      toUIMessageStreamResponse: () => new Response(),
      finished: Promise.resolve({
        status: "parked",
        continuationId: "cont_1",
        pending: { taskIds: ["task_1"], mode: "all" },
        session: {} as never,
        artifacts: [],
        trace: {} as never,
        warnings: [],
      }),
    }));

    await runRepl(
      harness,
      { stdout: (t) => { out.push(t); } },
      async () => (lines.length ? lines.shift()! : null),
      { streamHarness: stream } as never,
    );

    expect(stream).toHaveBeenCalledOnce();
    expect(out.join("")).toContain("Parked: cont_1 waiting for task_1");
    expect(out.join("")).not.toContain("unexpected");
  });
});

it("drains parked turn stream output before printing the parked summary", async () => {
  await withTempDir(async (dir) => {
    const harness = createHarness({ host: localHost({ dataDir: dir }), model: streamingTextModel(["unexpected"]) });
    const out: string[] = [];
    const lines: (string | null)[] = ["wait", null];
    const stream = vi.fn(() => ({
      text: Promise.resolve(""),
      output: Promise.resolve(""),
      textStream: (async function* () {})(),
      toUIMessageStream: () => new ReadableStream({
        async start(controller) {
          await new Promise((resolve) => setTimeout(resolve, 5));
          controller.enqueue({ type: "text-delta", id: "text_1", delta: "before park" });
          controller.close();
        },
      }),
      toUIMessageStreamResponse: () => new Response(),
      finished: Promise.resolve({
        status: "parked",
        continuationId: "cont_2",
        pending: { taskIds: ["task_2"], mode: "all" },
        session: {} as never,
        artifacts: [],
        trace: {} as never,
        warnings: [],
      }),
    }));

    await runRepl(
      harness,
      { stdout: (text) => { out.push(text); } },
      async () => (lines.length ? lines.shift()! : null),
      { streamHarness: stream } as never,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));

    const output = out.join("");
    expect(output.indexOf("[assistant]\nbefore park")).toBeLessThan(output.indexOf("Parked: cont_2 waiting for task_2"));
  });
});
