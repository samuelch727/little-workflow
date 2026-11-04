import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { createHarness } from "../create-harness.js";
import { localHost } from "../local-host/index.js";
import { withTempDir } from "../test/temp.js";
import type { HarnessEvent, HarnessTurnContext } from "../types.js";
import { generateHarness } from "./generate-harness.js";
import { streamHarness } from "./stream-harness.js";

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

/** A model that answers `text` and remembers each request's prompt and temperature. */
function recordingModel(text: string, modelId = "test-model") {
  const prompts: string[] = [];
  const temperatures: (number | undefined)[] = [];
  const model = new MockLanguageModelV3({
    provider: "test",
    modelId,
    doGenerate: async (options) => {
      prompts.push(JSON.stringify(options.prompt));
      temperatures.push(options.temperature);
      return { content: [{ type: "text", text }], finishReason: { unified: "stop", raw: "stop" }, usage, warnings: [] };
    },
    doStream: async (options) => {
      prompts.push(JSON.stringify(options.prompt));
      temperatures.push(options.temperature);
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ type: "text-start", id: "0" });
            controller.enqueue({ type: "text-delta", id: "0", delta: text });
            controller.enqueue({ type: "text-end", id: "0" });
            controller.enqueue({ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage });
            controller.close();
          },
        }),
      };
    },
  });
  return { model, prompts, temperatures };
}

describe("turnOptions", () => {
  it("sets each turn's model and system prompt from its session, after the session is known", async () => {
    await withTempDir(async (dir) => {
      const base = recordingModel("base", "base-model");
      const smart = recordingModel("smart", "smart-model");
      const seen: HarnessTurnContext<{ user: string }>[] = [];
      const harness = createHarness<Record<string, never>, { user: string }>({
        host: localHost({ dataDir: dir }),
        model: base.model,
        system: "Code system.",
        turnOptions: async (turn) => {
          seen.push(turn);
          return turn.sessionId === "vip" ? { model: smart.model, system: "Version 2 system.", temperature: 0.2 } : undefined;
        },
      });

      const vip = await generateHarness({
        harness,
        prompt: "Hi",
        session: "vip",
        extraBody: { user: "u_1" },
        trigger: { kind: "message", source: "whatsapp", from: "+15550001" },
      });
      const plain = await generateHarness({ harness, prompt: "Hi", session: "plain" });

      expect(vip.status === "completed" && vip.text).toBe("smart");
      expect(plain.status === "completed" && plain.text).toBe("base");
      expect(smart.prompts[0]).toContain("Version 2 system.");
      expect(smart.prompts[0]).not.toContain("Code system.");
      expect(smart.temperatures[0]).toBe(0.2);
      expect(base.prompts[0]).toContain("Code system.");
      expect(seen.map((turn) => turn.sessionId)).toEqual(["vip", "plain"]);
      expect(seen[0]?.session.id).toBe("vip");
      expect(seen[0]?.extraBody).toEqual({ user: "u_1" });
      expect(seen[0]?.trigger).toMatchObject({ source: "whatsapp", from: "+15550001" });
    });
  });

  it("lets a call's own options win, and runs both onEvent hooks", async () => {
    await withTempDir(async (dir) => {
      const hookModel = recordingModel("hook");
      const callModel = recordingModel("call");
      const order: string[] = [];
      const harness = createHarness({
        host: localHost({ dataDir: dir }),
        model: recordingModel("base").model,
        turnOptions: () => ({
          model: hookModel.model,
          system: "Hook system.",
          onEvent: (event: HarnessEvent) => {
            if (event.type === "harness.session.completed") order.push("hook");
          },
        }),
      });

      const result = await generateHarness({
        harness,
        prompt: "Hi",
        model: callModel.model,
        onEvent: (event) => {
          if (event.type === "harness.session.completed") order.push("call");
        },
      });

      expect(result.status === "completed" && result.text).toBe("call");
      expect(hookModel.prompts).toHaveLength(0);
      expect(callModel.prompts[0]).toContain("Hook system.");
      expect(order).toEqual(["hook", "call"]);
    });
  });

  it("is awaited before a streamed turn starts", async () => {
    await withTempDir(async (dir) => {
      const later = recordingModel("from the hook");
      const hook = vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { model: later.model, system: "Resolved later." };
      });
      const harness = createHarness({ host: localHost({ dataDir: dir }), model: recordingModel("base").model, turnOptions: hook });

      // streamHarness returns at once; the hook still decides the turn's model.
      const result = streamHarness({ harness, prompt: "Hi", session: "s1" });
      expect(await result.text).toBe("from the hook");
      await result.finished;
      expect(hook).toHaveBeenCalledTimes(1);
      expect(later.prompts[0]).toContain("Resolved later.");
    });
  });

  it("fails the turn when the hook throws", async () => {
    await withTempDir(async (dir) => {
      const harness = createHarness({
        host: localHost({ dataDir: dir }),
        model: recordingModel("base").model,
        turnOptions: () => {
          throw new Error("no version");
        },
      });
      await expect(generateHarness({ harness, prompt: "Hi" })).rejects.toThrow("no version");
    });
  });
});
