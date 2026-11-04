import { tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createHarness } from "../create-harness.js";
import { HarnessInputError } from "../errors.js";
import { localHost } from "../local-host/index.js";
import { withTempDir } from "../test/temp.js";
import type { HarnessEvent } from "../types.js";
import { generateHarness } from "./generate-harness.js";
import { streamHarness } from "./stream-harness.js";
import { HarnessTurnLimitError } from "./turn-limits.js";

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

/** A model that calls `ping` until it has called it `answerAfter` times, then answers. */
function pingModel(answerAfter = Number.POSITIVE_INFINITY) {
  let calls = 0;
  const respond = () => {
    calls += 1;
    return calls > answerAfter
      ? { content: [{ type: "text" as const, text: "done" }], finishReason: { unified: "stop" as const, raw: "stop" } }
      : {
          content: [{ type: "tool-call" as const, toolCallId: `call_${calls}`, toolName: "ping", input: "{}" }],
          finishReason: { unified: "tool-calls" as const, raw: "tool-calls" },
        };
  };
  const model = new MockLanguageModelV3({
    provider: "test",
    modelId: "priced-model",
    doGenerate: async () => ({ ...respond(), usage, warnings: [] }),
    doStream: async () => {
      const response = respond();
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            for (const part of response.content) {
              if (part.type === "text") {
                controller.enqueue({ type: "text-start", id: "t" });
                controller.enqueue({ type: "text-delta", id: "t", delta: part.text });
                controller.enqueue({ type: "text-end", id: "t" });
              } else {
                controller.enqueue(part);
              }
            }
            controller.enqueue({ type: "finish", finishReason: response.finishReason, usage });
            controller.close();
          },
        }),
      };
    },
  });
  return { model, calls: () => calls };
}

const ping = (wait = 0) =>
  tool({
    description: "Ping.",
    inputSchema: z.object({}),
    execute: async (_input, { abortSignal }) => {
      if (wait > 0) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, wait);
          abortSignal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(abortSignal.reason);
          });
        });
      }
      return "pong";
    },
  });

async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected the turn to fail.");
}

describe("turnLimits", () => {
  it("stops a turn that still wants tools at maxSteps, with StepLimitExceeded in the error and the failed event", async () => {
    await withTempDir(async (dir) => {
      const scripted = pingModel();
      const events: HarnessEvent[] = [];
      const harness = createHarness({ host: localHost({ dataDir: dir }), model: scripted.model, tools: { ping: ping() } });
      const error = await failure(
        generateHarness({ harness, prompt: "Go", turnLimits: { maxSteps: 3 }, onEvent: (event) => void events.push(event) }),
      );
      expect(error).toBeInstanceOf(HarnessTurnLimitError);
      expect((error as HarnessTurnLimitError).reason).toBe("StepLimitExceeded");
      expect((error as Error).name).toBe("StepLimitExceeded");
      expect(scripted.calls()).toBe(3);
      const failed = events.find((event) => event.type === "harness.session.failed");
      expect(failed?.metadata?.reason).toBe("StepLimitExceeded");
    });
  });

  it("lets a turn that answers on its last allowed step complete", async () => {
    await withTempDir(async (dir) => {
      const scripted = pingModel(1);
      const harness = createHarness({ host: localHost({ dataDir: dir }), model: scripted.model, tools: { ping: ping() } });
      const result = await generateHarness({ harness, prompt: "Go", turnLimits: { maxSteps: 2 } });
      expect(result.status === "completed" && result.text).toBe("done");
    });
  });

  it("stops at maxCostUsd by the app's price, after the step that crossed it", async () => {
    await withTempDir(async (dir) => {
      const scripted = pingModel();
      const priced: string[] = [];
      const harness = createHarness({ host: localHost({ dataDir: dir }), model: scripted.model, tools: { ping: ping() } });
      const error = await failure(
        generateHarness({
          harness,
          prompt: "Go",
          turnLimits: {
            maxCostUsd: 0.025,
            price: ({ model }) => {
              priced.push(model);
              return 0.01;
            },
          },
        }),
      );
      expect((error as HarnessTurnLimitError).reason).toBe("CostLimitExceeded");
      expect((error as HarnessTurnLimitError).details?.costUsd).toBeCloseTo(0.03);
      expect(scripted.calls()).toBe(3);
      expect(priced).toContain("priced-model");
    });
  });

  it("interrupts a turn at its deadline, tools included", async () => {
    await withTempDir(async (dir) => {
      const scripted = pingModel();
      const harness = createHarness({ host: localHost({ dataDir: dir }), model: scripted.model, tools: { ping: ping(5_000) } });
      const started = Date.now();
      const error = await failure(generateHarness({ harness, prompt: "Go", turnLimits: { deadlineMs: 50 } }));
      expect((error as HarnessTurnLimitError).reason).toBe("Interrupted");
      expect(Date.now() - started).toBeLessThan(4_000);
    });
  });

  it("applies to streamed turns: finished rejects with the reason", async () => {
    await withTempDir(async (dir) => {
      const scripted = pingModel();
      const harness = createHarness({ host: localHost({ dataDir: dir }), model: scripted.model, tools: { ping: ping() } });
      const turn = await streamHarness({ harness, prompt: "Go", turnLimits: { maxSteps: 2 } });
      const reader = turn.toUIMessageStream().getReader();
      while (!(await reader.read()).done) {
        // Drain the stream.
      }
      const error = await failure(turn.finished);
      expect((error as HarnessTurnLimitError).reason).toBe("StepLimitExceeded");
      expect(scripted.calls()).toBe(2);
    });
  });

  it("takes the harness's default, and a turnOptions hook's own limits over it", async () => {
    await withTempDir(async (dir) => {
      const scripted = pingModel();
      const harness = createHarness({
        host: localHost({ dataDir: dir }),
        model: scripted.model,
        tools: { ping: ping() },
        turnLimits: { maxSteps: 4 },
        turnOptions: ({ sessionId }) => (sessionId === "short" ? { turnLimits: { maxSteps: 1 } } : undefined),
      });
      await failure(generateHarness({ harness, prompt: "Go", session: "long" }));
      expect(scripted.calls()).toBe(4);
      await failure(generateHarness({ harness, prompt: "Go", session: "short" }));
      expect(scripted.calls()).toBe(5);
    });
  });

  it("refuses a cost limit without a price, and limits that aren't positive", async () => {
    await withTempDir(async (dir) => {
      const harness = createHarness({ host: localHost({ dataDir: dir }), model: pingModel().model, tools: { ping: ping() } });
      await expect(generateHarness({ harness, prompt: "Go", turnLimits: { maxCostUsd: 3 } })).rejects.toBeInstanceOf(HarnessInputError);
      await expect(generateHarness({ harness, prompt: "Go", turnLimits: { maxSteps: 0 } })).rejects.toBeInstanceOf(HarnessInputError);
      await expect(generateHarness({ harness, prompt: "Go", turnLimits: { deadlineMs: -1 } })).rejects.toBeInstanceOf(HarnessInputError);
    });
  });
});
