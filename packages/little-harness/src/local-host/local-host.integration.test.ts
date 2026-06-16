import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { createHarness } from "../create-harness.js";
import { generateHarness } from "../execution/generate-harness.js";
import { withTempDir } from "../test/temp.js";
import { localHost } from "./index.js";

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

function delayedModel(delayMs: number) {
  return new MockLanguageModelV3({
    provider: "test",
    modelId: "delay",
    doGenerate: async () => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return {
        content: [{ type: "text", text: "ok" }],
        finishReason: { unified: "stop", raw: "stop" },
        usage,
        warnings: [],
      };
    },
  });
}

describe("Local Host integration", () => {
  it("queues same-session turns and allows different sessions", async () => {
    await withTempDir(async (dir) => {
      const harness = createHarness({
        host: localHost({ dataDir: dir }),
        model: delayedModel(30),
      });

      const started = Date.now();
      await Promise.all([
        generateHarness({ harness, type: "x", input: {}, session: "same" }),
        generateHarness({ harness, type: "x", input: {}, session: "same" }),
        generateHarness({ harness, type: "x", input: {}, session: "other" }),
      ]);
      const elapsed = Date.now() - started;

      expect(elapsed).toBeGreaterThanOrEqual(55);
      expect(elapsed).toBeLessThan(250);
    });
  });
});
