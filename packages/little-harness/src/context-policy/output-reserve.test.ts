import { MockLanguageModelV3 } from "ai/test";
import { expect, it } from "vitest";
import { createHarness } from "../create-harness.js";
import { generateHarness } from "../execution/generate-harness.js";
import { streamHarness } from "../execution/stream-harness.js";
import { localHost } from "../local-host/index.js";
import { withTempDir } from "../test/temp.js";
import { inMemoryContextCheckpointStore } from "./policy.js";

it("sends the same effective output bound to the host and provider for generate/stream", async () => {
  await withTempDir(async dataDir => {
    const reserved: number[] = [], invoked: number[] = [];
    const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
    const model = new MockLanguageModelV3({ provider: "fixture", modelId: "fixture", doGenerate: async options => {
      invoked.push(options.maxOutputTokens!);
      return { content: [{ type: "text", text: "ok" }], usage, finishReason: { unified: "stop", raw: "stop" }, warnings: [] };
    }, doStream: async options => {
      invoked.push(options.maxOutputTokens!);
      return { stream: new ReadableStream({ start(controller) {
        controller.enqueue({ type: "stream-start", warnings: [] });
        controller.enqueue({ type: "text-start", id: "t" });
        controller.enqueue({ type: "text-delta", id: "t", delta: "ok" });
        controller.enqueue({ type: "text-end", id: "t" });
        controller.enqueue({ type: "finish", usage, finishReason: { unified: "stop", raw: "stop" } });
        controller.close();
      } }) };
    } });
    const host = localHost({ dataDir });
    host.contextCompaction = { forSession: async input => {
      reserved.push(input.maxOutputTokens!);
      return { store: inMemoryContextCheckpointStore(), model: { providerId: "fixture", modelId: "fixture", maxOutputTokens: 9999 } };
    } };
    const harness = createHarness({ host, model, runtime: { bash: false }, maxOutputTokens: 1000,
      contextPolicy: { triggerTokens: 10000, summaryModel: false }, turnOptions: () => ({ maxOutputTokens: 2000 }) });
    await generateHarness({ harness, prompt: "Hi", session: "generate" });
    const stream = streamHarness({ harness, prompt: "Hi", session: "stream", maxOutputTokens: 3000 });
    for await (const _ of stream.toUIMessageStream()) { /* Drain synthetic stream. */ }
    await stream.finished;
    expect(reserved).toEqual([2000, 3000]);
    expect(invoked).toEqual([2000, 3000]);
  });
});
