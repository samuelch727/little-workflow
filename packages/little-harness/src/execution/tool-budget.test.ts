import { modelStepBudget } from "./model-step-budget.js";
import { tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createHarness } from "../create-harness.js";
import { HarnessInputError } from "../errors.js";
import { virtualHost } from "../virtual-host/virtual-host.js";
import { InMemoryFs } from "just-bash";
import { executeWithToolBudget, turnToolBudget } from "./tool-budget.js";
import { DEFAULT_WORKFLOW_BUDGETS } from "../create-harness.js";
import type { HarnessWarning } from "../types.js";
import { localHost } from "../local-host/index.js";
import { withTempDir } from "../test/temp.js";
import { generateHarness } from "./generate-harness.js";
import { streamHarness } from "./stream-harness.js";

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

/** A model that calls `ping` until it has called it `answerAfter` times, then answers. */
function pingModel(answerAfter = Number.POSITIVE_INFINITY, parallel = 1, toolName = "ping", input = "{}") {
  let calls = 0;
  const respond = () => {
    calls += 1;
    return calls > answerAfter
      ? { content: [{ type: "text" as const, text: "done" }], finishReason: { unified: "stop" as const, raw: "stop" } }
      : {
          content: Array.from({ length: parallel }, (_, i) => ({ type: "tool-call" as const, toolCallId: `call_${calls}_${i}`, toolName, input })),
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

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const ping = (execute: () => Promise<unknown>) => tool({ description: "ping", inputSchema: z.object({}), execute });

for (const hostKind of ["virtual", "local"] as const) for (const mode of ["generate", "stream"] as const) {
  describe(`${hostKind} ${mode} tool budgets`, () => {
    const run = async (harness: ReturnType<typeof createHarness>) => {
      if (mode === "generate") return generateHarness({ harness, session: "chat", prompt: "go" });
      const stream = streamHarness({ harness, session: "chat", prompt: "go" });
      // Drain stream so the model loop is not backpressured.
      const result = await stream;
      const drain = (async () => { for await (const _ of result.toUIMessageStream()) {} })();
      const finished = await result.finished;
      await drain;
      return finished;
    };
    it.each([false, "late", "array"] as const)("caps model steps with caller stopWhen %s", async (variant) => {
      await withTempDir(async (dir) => {
        const script = pingModel(20);
        let executed = 0;
        const harness = createHarness({ host: hostKind === "virtual" ? virtualHost({ fs: new InMemoryFs() }) : localHost({ dataDir: dir }), model: script.model, runtime: { bash: false, python: false, javascript: false, toolBridge: false }, tools: { ping: ping(async () => { executed++; return "ok"; }) }, workflowBudgets: { maxModelSteps: 2 } });
        const stopWhen = variant === "array" ? [() => false, () => false] : variant === "late" ? ({ steps }: { steps: unknown[] }) => steps.length >= 10 : () => false;
        const turn = mode === "generate" ? await generateHarness({ harness, prompt: "go", stopWhen }) : await streamHarness({ harness, prompt: "go", stopWhen });
        if ("finished" in turn) {
          for await (const _ of turn.toUIMessageStream()) {}
          await turn.finished;
        }
        expect(script.calls()).toBe(2);
        expect(executed).toBe(2);
      });
    });
    it("counts bash plus nested bridge calls without a one-slot deadlock", async () => {
      await withTempDir(async (dir) => {
        let executed = 0;
        const harness = createHarness({
          host: hostKind === "virtual" ? virtualHost({ fs: new InMemoryFs() }) : localHost({ dataDir: dir }),
          model: pingModel(1, 1, "bash", JSON.stringify({ command: "js-exec -c 'await tools.ping({}); await tools.ping({})'" })).model,
          tools: { ping: ping(async () => { executed++; return "pong"; }) },
          workflowBudgets: { maxToolCallsPerTurn: 2, maxConcurrentToolCalls: 1, toolDeadlineMs: 2000 },
        });
        const result = await run(harness);
        expect(executed).toBe(1);
        expect(result.warnings.some((w) => w.message.includes("tool-call budget"))).toBe(true);
        expect(result.warnings.some((w) => w.message.includes("toolDeadlineMs"))).toBe(false);
      });
    });
    it("counts parallel and throwing calls across model steps", async () => {
      await withTempDir(async (dir) => {
        let executed = 0;
        const harness = createHarness({ host: hostKind === "virtual" ? virtualHost({ fs: new InMemoryFs() }) : localHost({ dataDir: dir }), model: pingModel(3, 5).model, runtime: { bash: false, python: false, javascript: false, toolBridge: false }, tools: { ping: ping(async () => { executed++; throw new Error("tool failed"); }) }, workflowBudgets: { maxToolCallsPerTurn: 2 } });
        const result = await run(harness);
        expect(executed).toBe(2);
        expect(result.status).toBe("completed");
        expect(result.warnings.some((w) => w.message.includes("tool-call budget"))).toBe(true);
      });
    });
    it("serializes all five calls with a one-slot turn", async () => {
      await withTempDir(async (dir) => {
        let active = 0, peak = 0, executed = 0;
        const harness = createHarness({ host: hostKind === "virtual" ? virtualHost({ fs: new InMemoryFs() }) : localHost({ dataDir: dir }), model: pingModel(1, 5).model, runtime: { bash: false, python: false, javascript: false, toolBridge: false }, tools: { ping: ping(async () => { peak = Math.max(peak, ++active); await wait(5); active--; executed++; return "pong"; }) }, workflowBudgets: { maxConcurrentToolCalls: 1 } });
        expect((await run(harness)).status).toBe("completed");
        expect(peak).toBe(1); expect(executed).toBe(5);
      });
    });
    it("abandons a signal-ignoring result at its deadline", async () => {
      await withTempDir(async (dir) => {
        let finish!: () => void;
        const pending = new Promise<void>((resolve) => { finish = resolve; });
        const harness = createHarness({ host: hostKind === "virtual" ? virtualHost({ fs: new InMemoryFs() }) : localHost({ dataDir: dir }), model: pingModel(1).model, runtime: { bash: false, python: false, javascript: false, toolBridge: false }, tools: { ping: ping(async () => { await pending; return "late"; }) }, workflowBudgets: { toolDeadlineMs: 20 } });
        try {
          const result = await run(harness);
          expect(result.status).toBe("completed");
          expect(result.warnings.some((w) => w.message.includes("toolDeadlineMs"))).toBe(true);
        } finally { finish(); }
      });
    });
  });
}

it("keeps timed-out underlying slots occupied and bounds queued calls", async () => {
  const warnings: HarnessWarning[] = [];
  const ctx = turnToolBudget({ ...DEFAULT_WORKFLOW_BUDGETS, maxConcurrentToolCalls: 1, toolDeadlineMs: 15 }, warnings);
  let invoked = 0, release!: () => void;
  const a = executeWithToolBudget(ctx, "a", undefined, async () => { invoked++; await new Promise<void>((r) => { release = r; }); });
  const b = executeWithToolBudget(ctx, "b", undefined, async () => { invoked++; });
  await expect(a).rejects.toThrow("toolDeadlineMs");
  await expect(b).rejects.toThrow("toolDeadlineMs");
  expect(invoked).toBe(1);
  release();
  await wait(0);
  await expect(executeWithToolBudget(ctx, "c", undefined, async () => "ok")).resolves.toBe("ok");
});

it("shares a chain slot for nested bridge calls without permitting sibling fanout", async () => {
  const ctx = turnToolBudget({ ...DEFAULT_WORKFLOW_BUDGETS, maxConcurrentToolCalls: 1 }, []);
  let active = 0, peak = 0;
  await executeWithToolBudget(ctx, "bash", undefined, async () => {
    await Promise.all([1, 2, 3].map(() => executeWithToolBudget(ctx, "bridge", undefined, async () => {
      peak = Math.max(peak, ++active); await wait(2); active--;
    })));
  });
  expect(peak).toBe(1);
});

it("abort removes a waiter without leaking a slot", async () => {
  const ctx = turnToolBudget({ ...DEFAULT_WORKFLOW_BUDGETS, maxConcurrentToolCalls: 1 }, []);
  let release!: () => void;
  const a = executeWithToolBudget(ctx, "a", undefined, async () => new Promise<void>((r) => { release = r; }));
  await wait(0);
  const controller = new AbortController();
  const b = executeWithToolBudget(ctx, "b", controller.signal, async () => "bad");
  controller.abort(new Error("stop"));
  await expect(b).rejects.toThrow("stop");
  release(); await a;
  await expect(executeWithToolBudget(ctx, "c", undefined, async () => "ok")).resolves.toBe("ok");
});

it("rejects invalid public tool budgets", () => {
  for (const workflowBudgets of [{ maxModelSteps: 0 }, { maxToolCallsPerTurn: -1 }, { maxConcurrentToolCalls: 0 }, { toolDeadlineMs: 0 }, { toolDeadlineMs: Infinity }]) {
    expect(() => createHarness({ host: virtualHost({ fs: new InMemoryFs() }), model: pingModel(0).model, workflowBudgets })).toThrow(HarnessInputError);
  }
});

it("resets counters per turn and supports zero calls", async () => {
  const budgets = { ...DEFAULT_WORKFLOW_BUDGETS, maxToolCallsPerTurn: 1 };
  const one = turnToolBudget(budgets, []);
  await executeWithToolBudget(one, "ping", undefined, async () => "ok");
  await expect(executeWithToolBudget(one, "ping", undefined, async () => "bad")).rejects.toThrow("budget");
  await expect(executeWithToolBudget(turnToolBudget(budgets, []), "ping", undefined, async () => "new turn")).resolves.toBe("new turn");
  await expect(executeWithToolBudget(turnToolBudget({ ...budgets, maxToolCallsPerTurn: 0 }, []), "ping", undefined, async () => "bad")).rejects.toThrow("budget");
});

it("restores each subprocess command's chain rather than worker-start context", async () => {
  await withTempDir(async (dir) => {
    let calls = 0;
    const harness = createHarness({
      host: localHost({ dataDir: dir, sandbox: "subprocess" }),
      model: pingModel(2, 1, "bash", JSON.stringify({ command: "js-exec -c 'await tools.ping({})'" })).model,
      tools: { ping: ping(async () => { calls++; return "pong"; }) },
      workflowBudgets: { maxConcurrentToolCalls: 1, toolDeadlineMs: 3000 },
    });
    const result = await generateHarness({ harness, prompt: "go" });
    expect(calls).toBe(2);
    expect(result.warnings).toEqual([]);
  });
});

it("retains a parent slot while an abandoned nested child is still running", async () => {
  const ctx = turnToolBudget({ ...DEFAULT_WORKFLOW_BUDGETS, maxConcurrentToolCalls: 1, toolDeadlineMs: 30 }, []);
  let finish!: () => void;
  const outer = executeWithToolBudget(ctx, "bash", undefined, async () => {
    await executeWithToolBudget(ctx, "child", undefined, async () => new Promise<void>((r) => { finish = r; })).catch(() => {});
  });
  await expect(outer).rejects.toThrow("toolDeadlineMs");
  let ran = false;
  await expect(executeWithToolBudget(ctx, "next", undefined, async () => { ran = true; })).rejects.toThrow("toolDeadlineMs");
  expect(ran).toBe(false);
  finish(); await wait(0);
  await expect(executeWithToolBudget(ctx, "after", undefined, async () => "ok")).resolves.toBe("ok");
});

it("labels cap and caller separately, with cap precedence and no text-only false attribution", async () => {
  const reasons: string[] = [];
  const event = (n: number, tools = true) => ({ steps: Array.from({ length: n }, () => ({ toolCalls: tools ? [{}] : [] })) }) as any;
  const both = modelStepBudget(2, () => true, (reason) => reasons.push(reason));
  expect(await both(event(2))).toBe(true);
  expect(reasons).toEqual(["step-limit"]);
  reasons.length = 0;
  expect(await both(event(1))).toBe(true);
  expect(reasons).toEqual(["stop-condition"]);
  reasons.length = 0;
  expect(await both(event(2, false))).toBe(true);
  expect(reasons).toEqual([]);
});
