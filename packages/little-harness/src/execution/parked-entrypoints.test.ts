import { MockLanguageModelV3 } from "ai/test";
import { tool } from "ai";
import { z } from "zod";
import { expect, it } from "vitest";
import { createHarness } from "../create-harness.js";
import { localHost } from "../local-host/index.js";
import { withTempDir } from "../test/temp.js";
import { generateHarness } from "./generate-harness.js";
import { streamHarness } from "./stream-harness.js";
import { createParkedToolResult } from "./park-resume.js";

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};
const call = { type: "tool-call" as const, toolCallId: "wait-1", toolName: "wait_for_work", input: "{}" };
const finishReason = { unified: "tool-calls" as const, raw: "tool-calls" };

for (const mode of ["generate", "stream"] as const) {
  it(`returns a parked discriminant through ${mode} without completed-only fields`, async () => {
    await withTempDir(async (dir) => {
      const model = new MockLanguageModelV3({
        doGenerate: { content: [call], finishReason, usage, warnings: [] },
        doStream: { stream: new ReadableStream({ start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue(call);
          controller.enqueue({ type: "finish", finishReason, usage });
          controller.close();
        } }) },
      });
      const harness = createHarness({
        host: localHost({ dataDir: dir, sandbox: "in-process" }), model,
        tools: { wait_for_work: tool({
          description: "Park until the pending task settles.", inputSchema: z.object({}),
          execute: async () => createParkedToolResult({ continuationId: "continuation-1", pending: { taskIds: ["task-1"] } }),
        }) },
      });
      const options = { harness, messages: [{ id: "message-1", role: "user" as const, parts: [{ type: "text" as const, text: "wait for work" }] }] };
      const result = mode === "generate" ? await generateHarness(options) : await (async () => {
        const streaming = streamHarness(options);
        await streaming.text;
        return streaming.finished;
      })();
      expect(result).toMatchObject({ status: "parked", continuationId: "continuation-1", pending: { taskIds: ["task-1"] } });
      expect(result).not.toHaveProperty("output");
      expect(result).not.toHaveProperty("commitManual");
      expect(result).not.toHaveProperty("persistence");
      expect(mode === "generate" ? model.doGenerateCalls : model.doStreamCalls).toHaveLength(1);
    });
  });
}
