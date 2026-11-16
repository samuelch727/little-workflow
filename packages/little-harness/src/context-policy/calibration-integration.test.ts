import { tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { z } from "zod";
import { expect, it } from "vitest";
import { createHarness } from "../create-harness.js";
import { generateHarness } from "../execution/generate-harness.js";
import { streamHarness } from "../execution/stream-harness.js";
import { localHost } from "../local-host/index.js";
import { withTempDir } from "../test/temp.js";
import { contextRequestBytes } from "./calibration.js";
import { resolveContextRuntime } from "./prepare.js";

it("pairs generate/stream usage with the effective request after prepareStep, across calls in one session", async () => {
  await withTempDir(async dataDir => {
    const prompts: unknown[][] = [];
    const usage = (input: number) => ({ inputTokens: { total: input, noCache: 1, cacheRead: input - 1, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } });
    const model = new MockLanguageModelV3({ provider: "fixture", modelId: "measured", doGenerate: async options => {
      prompts.push(options.prompt);
      return {
      content: [{ type: "text", text: "ok" }], usage: usage(123), finishReason: { unified: "stop", raw: "stop" }, warnings: [],
    }; }, doStream: async options => {
      prompts.push(options.prompt);
      return { stream: new ReadableStream({ start(controller) {
      controller.enqueue({ type: "stream-start", warnings: [] });
      controller.enqueue({ type: "text-start", id: "t" });
      controller.enqueue({ type: "text-delta", id: "t", delta: "ok" });
      controller.enqueue({ type: "text-end", id: "t" });
      controller.enqueue({ type: "finish", usage: usage(456), finishReason: { unified: "stop", raw: "stop" } });
      controller.close();
    } }) }; } });
    const host = localHost({ dataDir });
    const harness = createHarness({ host, model, runtime: { bash: false }, tools: { ping: tool({ description: "Fixture tool so the request carries a tool schema.", inputSchema: z.object({}), execute: async () => "pong" }) }, contextPolicy: { triggerTokens: 24000, summaryModel: false } });
    const effective = { system: "Effective instructions", messages: [{ role: "user" as const, content: "actual prepared request" }] };
    const prepareStep = async () => effective;
    await generateHarness({ harness, prompt: "caller input that was replaced", session: "s", prepareStep });
    const read = async () => (await resolveContextRuntime({ sessionId: "s", runId: "probe", model, fallbackScope: host })).store.lastInputUsage!("s");
    const first = await read();
    const withoutToolSchemas = (prompt: unknown[], messages: typeof effective.messages) => contextRequestBytes({ system: (prompt[0] as {content:string}).content, messages, tools: {} });
    expect(JSON.stringify(prompts[0])).toContain("actual prepared request");
    expect(JSON.stringify(prompts[0])).not.toContain("caller input that was replaced");
    expect(first).toMatchObject({ sessionId: "s", modelId: "measured", providerId: "fixture", inputTokens: 123 });
    const fixedToolBytes = first!.requestBytes - withoutToolSchemas(prompts[0]!, effective.messages);
    expect(fixedToolBytes).toBeGreaterThan(0); // Tool schemas (the fixture tool) count toward request bytes.
    const secondEffective = { system: effective.system, messages: [{role:"user" as const,content:"second actual request ".repeat(50)}] };
    const stream = streamHarness({ harness, prompt: "different caller input", session: "s", prepareStep: async () => secondEffective });
    for await (const _ of stream.toUIMessageStream()) { /* Drain scripted stream. */ }
    await stream.finished;
    const second = await read();
    expect(second).toMatchObject({ inputTokens: 456, requestBytes: fixedToolBytes + withoutToolSchemas(prompts[1]!, secondEffective.messages) });
    expect(second!.requestHash).not.toBe(first!.requestHash);
    expect(second!.requestId).not.toBe(first!.requestId);
  });
});
