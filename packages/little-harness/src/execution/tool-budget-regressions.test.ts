import { expect, it } from "vitest";
import { tool } from "ai";
import { z } from "zod";
import { MockLanguageModelV3 } from "ai/test";
import { InMemoryFs } from "just-bash";
import { createHarness, DEFAULT_WORKFLOW_BUDGETS } from "../create-harness.js";
import { virtualHost } from "../virtual-host/virtual-host.js";
import { generateHarness } from "./generate-harness.js";
import { streamHarness } from "./stream-harness.js";
import { executeWithToolBudget, turnToolBudget } from "./tool-budget.js";
import { wrapToolsWithHarnessContext } from "../runtime/tools.js";
import { runWithCallerToolContext, withStepToolContext } from "../runtime/step-tools.js";
import type { HarnessWarning } from "../types.js";

for (const path of ["model", "step"] as const) for (const deadline of [undefined, 1000]) for (const gated of [false, true]) for (const turnSignal of [false, true]) {
  it(`${path} signal aborts mid-execution (deadline=${deadline}, gate=${gated}, turnSignal=${turnSignal})`, async () => {
    const signal = new AbortController();
    const turn = new AbortController();
    let received: AbortSignal | undefined;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const original = { ping: tool({ inputSchema: z.object({}), execute: async (_input, options) => {
      received = options.abortSignal;
      started();
      return new Promise((_resolve, reject) => options.abortSignal?.addEventListener("abort", () => reject(options.abortSignal?.reason), { once: true }));
    } }) };
    const ctx = { ...(turnSignal ? { abortSignal: turn.signal } : {}), ...(gated ? turnToolBudget({ ...DEFAULT_WORKFLOW_BUDGETS, ...(deadline === undefined ? {} : { toolDeadlineMs: deadline }) }, []) : {}) } as any;
    const tools = path === "model" ? wrapToolsWithHarnessContext(original, ctx) : withStepToolContext(original, { sessionId: "test", onceDir: "/unused" });
    const invoke = () => (tools.ping as any).execute({}, { abortSignal: signal.signal, toolCallId: "test", messages: [] });
    const pending = path === "step" ? runWithCallerToolContext(ctx, invoke) : invoke();
    const rejected = expect(pending).rejects.toThrow("source stopped");
    await ready;
    expect(received).toBeDefined();
    expect(received?.aborted).toBe(false);
    signal.abort(new Error("source stopped"));
    await rejected;
    expect(received?.aborted).toBe(true);
  });
}

for (const mode of ["generate", "stream"] as const) for (const scope of ["harness", "call"] as const) for (const maxSteps of [3, 30]) {
  it(`${mode} ${scope} hard maxSteps=${maxSteps} keeps precedence over soft default`, async () => {
    let calls = 0;
    const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
    const content = () => [{ type: "tool-call" as const, toolCallId: `call_${++calls}`, toolName: "ping", input: "{}" }];
    const finishReason = { unified: "tool-calls" as const, raw: "tool-calls" };
    const model = new MockLanguageModelV3({
      doGenerate: async () => ({ content: content(), usage, finishReason, warnings: [] }),
      doStream: async () => ({ stream: new ReadableStream({ start(controller) {
        for (const part of content()) controller.enqueue(part);
        controller.enqueue({ type: "finish", finishReason, usage }); controller.close();
      } }) }),
    });
    const harness = createHarness({ host: virtualHost({ fs: new InMemoryFs() }), model, ...(scope === "harness" ? { turnLimits: { maxSteps } } : {}), runtime: { bash: false, javascript: false, python: false, toolBridge: false }, tools: { ping: tool({ inputSchema: z.object({}), execute: async () => "pong" }) } });
    const options = { harness, prompt: "go", stopWhen: () => false, ...(scope === "call" ? { turnLimits: { maxSteps } } : {}) };
    if (mode === "generate") await expect(generateHarness(options)).rejects.toMatchObject({ reason: "StepLimitExceeded" });
    else {
      const turn = await streamHarness(options);
      const failure = expect(turn.finished).rejects.toMatchObject({ reason: "StepLimitExceeded" });
      try { for await (const _ of turn.toUIMessageStream()) {} } catch {}
      await failure;
    }
    expect(calls).toBe(maxSteps);
  });
}

it("warns once per policy in a turn, independently for count and deadline", async () => {
  const warnings: HarnessWarning[] = [];
  const ctx = turnToolBudget({ ...DEFAULT_WORKFLOW_BUDGETS, maxToolCallsPerTurn: 2, toolDeadlineMs: 5 }, warnings);
  for (let i = 0; i < 5; i++) {
    await expect(executeWithToolBudget(ctx, "slow", undefined, async () => new Promise<void>((resolve) => setTimeout(resolve, 15)))).rejects.toThrow();
  }
  expect(warnings.map((w) => w.metadata?.policy).sort()).toEqual(["maxToolCallsPerTurn", "toolDeadlineMs"]);
});
