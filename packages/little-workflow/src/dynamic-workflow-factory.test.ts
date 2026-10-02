import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { jsonSchema, tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import type { HarnessWorkflowRunContext } from "little-harness";
import { littleWorkflowDynamicWorkflowFactory } from "./dynamic-workflow-factory.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function ctx(dataDir: string, capabilities: unknown): HarnessWorkflowRunContext {
  return {
    protocolVersion: 1,
    workflowId: "adhoc",
    workflowHandle: "adhoc",
    definitionIdentity: "sha256:test",
    toolCallId: "call_1",
    disposition: "await",
    parentSessionId: "s",
    parentTurnId: "t",
    originTurnId: "t",
    reservedRunId: "run_adhoc_1",
    persistence: { dataDir },
    inheritance: {},
    capabilities: capabilities as never,
    observation: { recordProgress: async () => {} },
  };
}

it("compiles a valid single-tool plan and runs it once", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "adhoc-run-"));
  dirs.push(dataDir);
  const factory = littleWorkflowDynamicWorkflowFactory();
  const result = factory.compile({
    purpose: "echo",
    plan: {
      steps: [
        {
          id: "call",
          uses: "tool.call",
          tool: "echo",
          with: { v: "{{ input.v }}" },
          output: { mode: "json", schema: true },
        },
      ],
      output: { from: "call" },
    },
    input: { v: 1 },
    outputSchema: true,
    allowed: { tools: ["echo"], models: ["default"], bash: false },
    limits: { maxSteps: 8, maxRuntimeMs: 120_000 },
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.referenced.tools).toEqual(["echo"]);

  const echo = tool({
    description: "Echo.",
    inputSchema: jsonSchema({ type: "object", additionalProperties: true }),
    execute: async (a: unknown) => a,
  });
  const exec = await result.workflow.runForHarness(
    { v: 1 },
    ctx(dataDir, {
      tools: { echo },
      mcpTools: {},
      bash: {},
      code: {},
      workflows: {},
      skills: {},
      mounts: [],
      permissions: { approvalPolicy: "reject_ask" },
    }),
  );
  expect(exec.status).toBe("completed");
});

it("fails an over-budget run with causeCode 'timeout' (enforces maxRuntimeMs)", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "adhoc-timeout-"));
  dirs.push(dataDir);
  const factory = littleWorkflowDynamicWorkflowFactory();
  const compiled = factory.compile({
    purpose: "hang",
    plan: {
      steps: [
        { id: "g", uses: "ai.generate", model: "default", prompt: "hang", output: { mode: "text" } },
      ],
      output: { from: "g" },
    },
    input: {},
    outputSchema: true,
    allowed: { tools: [], models: ["default"], bash: false },
    // Tiny budget so the hanging model step trips the runtime timeout deterministically.
    limits: { maxSteps: 8, maxRuntimeMs: 50 },
  });
  expect(compiled.ok).toBe(true);
  if (!compiled.ok) return;
  // A model whose generation never settles until the run is aborted by the runtime timeout.
  const hangingModel = new MockLanguageModelV3({
    provider: "test",
    modelId: "hang",
    doGenerate: (options) =>
      new Promise((_resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("model did not abort")), 10_000);
        options.abortSignal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(new Error("aborted"));
          },
          { once: true },
        );
      }),
  });
  const exec = await compiled.workflow.runForHarness(
    {},
    ctx(dataDir, {
      tools: {},
      mcpTools: {},
      bash: {},
      code: {},
      workflows: {},
      skills: {},
      mounts: [],
      permissions: { approvalPolicy: "reject_ask" },
      models: { default: hangingModel },
    }),
  );
  expect(exec.status).toBe("failed");
  if (exec.status === "failed") expect(exec.causeCode).toBe("timeout");
});

it("rejects a plan that references a tool outside the allowed set", () => {
  const factory = littleWorkflowDynamicWorkflowFactory();
  const result = factory.compile({
    purpose: "bad",
    plan: {
      steps: [{ id: "c", uses: "tool.call", tool: "secret", with: {} }],
      output: { from: "c" },
    },
    input: {},
    outputSchema: true,
    allowed: { tools: ["echo"], models: ["default"], bash: false },
    limits: { maxSteps: 8, maxRuntimeMs: 120_000 },
  });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.causeCode).toBe("capability_not_allowed");
});

it("rejects a plan exceeding maxSteps", () => {
  const factory = littleWorkflowDynamicWorkflowFactory();
  const steps = Array.from({ length: 9 }, (_, i) => ({
    id: `s${i}`,
    uses: "tool.call" as const,
    tool: "echo",
    with: {},
  }));
  const result = factory.compile({
    purpose: "big",
    plan: { steps, output: { from: "s0" } },
    input: {},
    outputSchema: true,
    allowed: { tools: ["echo"], models: ["default"], bash: false },
    limits: { maxSteps: 8, maxRuntimeMs: 120_000 },
  });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.causeCode).toBe("plan_invalid");
});

it("runs an ai.generate plan with the default model slot threaded through capabilities", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "adhoc-gen-"));
  dirs.push(dataDir);
  const factory = littleWorkflowDynamicWorkflowFactory();
  const compiled = factory.compile({
    purpose: "generate",
    plan: {
      steps: [
        { id: "g", uses: "ai.generate", model: "default", prompt: "say hi", output: { mode: "text" } },
      ],
      output: { from: "g" },
    },
    input: {},
    outputSchema: true,
    allowed: { tools: [], models: ["default"], bash: false },
    limits: { maxSteps: 8, maxRuntimeMs: 120_000 },
  });
  expect(compiled.ok).toBe(true);
  if (!compiled.ok) return;
  const aiSdkModel = new MockLanguageModelV3({
    provider: "test",
    modelId: "gen",
    doGenerate: async () => ({
      content: [{ type: "text", text: "hi" }],
      finishReason: { unified: "stop", raw: "stop" },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 },
      },
      warnings: [],
    }),
  });
  const exec = await compiled.workflow.runForHarness(
    {},
    ctx(dataDir, {
      tools: {},
      mcpTools: {},
      bash: {},
      code: {},
      workflows: {},
      skills: {},
      mounts: [],
      permissions: { approvalPolicy: "reject_ask" },
      models: { default: aiSdkModel },
    }),
  );
  expect(exec.status).toBe("completed");
});
