import type { UIMessage } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { beforeEach, expect, it, vi } from "vitest";
import { createHarness } from "../create-harness.js";
import { localHost } from "../local-host/index.js";
import { withTempDir } from "../test/temp.js";
import { streamHarness } from "./stream-harness.js";

const mcpResolverMock = vi.hoisted(() => ({ resolveHarnessMcpGateway: vi.fn() }));
vi.mock("../mcp.js", () => ({
  resolveHarnessMcpGateway: mcpResolverMock.resolveHarnessMcpGateway,
}));

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

beforeEach(() => {
  mcpResolverMock.resolveHarnessMcpGateway.mockReset();
  mcpResolverMock.resolveHarnessMcpGateway.mockResolvedValue({
    tools: {},
    skills: [],
    manifest: { servers: [] },
    close: async () => {},
  });
});

function streamingTextModel(parts: readonly string[]) {
  return new MockLanguageModelV3({
    provider: "test",
    modelId: "test-model",
    doStream: {
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({ type: "text-start", id: "0" });
          for (const part of parts) {
            controller.enqueue({ type: "text-delta", id: "0", delta: part });
          }
          controller.enqueue({ type: "text-end", id: "0" });
          controller.enqueue({ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage });
          controller.close();
        },
      }),
    },
  });
}

it("streamHarness().textStream yields the assistant text incrementally and matches result.text", async () => {
  await withTempDir(async (dir) => {
    const harness = createHarness({
      host: localHost({ dataDir: dir }),
      model: streamingTextModel(["Hello ", "from the ", "harness."]),
    });
    const result = streamHarness({
      harness,
      messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] }] as UIMessage[],
    });

    const chunks: string[] = [];
    for await (const delta of result.textStream) {
      chunks.push(delta);
    }
    const streamed = chunks.join("");

    expect(streamed).toBe("Hello from the harness.");
    expect(streamed).toBe(await result.text);
    expect(chunks.length).toBeGreaterThan(1); // it actually streamed in parts, not one blob
    await result.finished; // flush durability before withTempDir tears the session dir down (avoids ENOTEMPTY)
  });
});
