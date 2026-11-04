import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarness, generateHarness, localHost, type HarnessWorkflowRunContext } from "@little-stack/harness";
import {
  asHarnessWorkflow,
  defineWorkflow,
  dynamicWorkflows,
  localWorld,
  type DynamicWorkflowWorldContext,
  type World,
} from "@little-stack/workflow";
import { jsonSchema, tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createLittleDB } from "../client.js";
import { turnTraceId } from "../harness/tracer.js";
import { fakeLittleDB } from "../test/fake-littledb.js";
import { boundedId } from "../util.js";
import { runTraceId, type WorldEventLike, type WorldLike } from "./tracing-world.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function runContext(dataDir: string, runId: string, capabilities: unknown): HarnessWorkflowRunContext {
  return {
    protocolVersion: 1,
    workflowId: "adhoc",
    workflowHandle: "adhoc",
    definitionIdentity: "sha256:test",
    toolCallId: "call_1",
    disposition: "await",
    parentSessionId: "sess_1",
    parentTurnId: "turn_1",
    originTurnId: "turn_1",
    reservedRunId: runId,
    persistence: { dataDir },
    inheritance: {},
    capabilities: capabilities as never,
    observation: { recordProgress: async () => {} },
  };
}

function textModel(text: string) {
  return new MockLanguageModelV3({
    provider: "anthropic.messages",
    modelId: "claude-test",
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({ type: "text-start", id: "0" });
          controller.enqueue({ type: "text-delta", id: "0", delta: text });
          controller.enqueue({ type: "text-end", id: "0" });
          controller.enqueue({
            type: "finish",
            finishReason: { unified: "stop", raw: "end_turn" },
            usage: { inputTokens: { total: 300, noCache: 100, cacheRead: 200, cacheWrite: 0 }, outputTokens: { total: 7, text: 7, reasoning: 0 } },
          });
          controller.close();
        },
      }),
    }),
  });
}

const plan = {
  steps: [
    { id: "lookup", uses: "tool.call", tool: "lookup_order", with: { orderId: "{{ input.orderId }}" }, output: { mode: "json", schema: true } },
    { id: "reply", uses: "ai.generate", model: "default", prompt: "Write a one-line status for {{ steps.lookup.output.status }}.", output: { mode: "text" } },
  ],
  output: { from: "reply" },
};

async function runPlan(world: (ctx: DynamicWorkflowWorldContext) => World, runId = "run_1") {
  const dataDir = await mkdtemp(join(tmpdir(), "ldb-world-"));
  dirs.push(dataDir);
  const { factory } = dynamicWorkflows({ world });
  const compiled = factory.compile({
    purpose: "order status",
    plan,
    input: { orderId: "A1" },
    outputSchema: true,
    allowed: { tools: ["lookup_order"], models: ["default"], bash: false },
    limits: { maxSteps: 8, maxRuntimeMs: 120_000 },
  });
  if (!compiled.ok) throw new Error(compiled.message);
  const lookup = tool({
    description: "Look an order up.",
    inputSchema: jsonSchema({ type: "object", additionalProperties: true }),
    execute: async (input: unknown) => ({ ...(input as object), status: "shipped" }),
  });
  return compiled.workflow.runForHarness(
    { orderId: "A1" },
    runContext(dataDir, runId, {
      tools: { lookup_order: lookup },
      mcpTools: {},
      bash: {},
      code: {},
      workflows: {},
      skills: {},
      mounts: [],
      permissions: { approvalPolicy: "reject_ask" },
      models: { default: textModel("Order A1 has shipped.") },
    }),
  );
}

describe("tracingWorld", () => {
  it("sends a run as a trace: the run, its steps, and the model and tool calls under them", async () => {
    const fake = fakeLittleDB();
    const db = createLittleDB({ url: fake.url, apiKey: fake.apiKey, fetch: fake.fetch });
    const result = await runPlan((ctx) =>
      db.tracingWorld(localWorld({ dataDir: ctx.dataDir }), {
        workflow: ctx.handle,
        origin: ctx.kind === "defined" ? "agent" : "planner",
        harness: "support",
      }),
    );
    expect(result.status).toBe("completed");
    await db.flush();

    const traceId = runTraceId("run_1");
    expect(fake.traces.get(traceId)).toMatchObject({
      kind: "workflow",
      workflow: "adhoc",
      workflowOrigin: "planner",
      harness: "support",
      // From the run's trigger: the harness session, turn and tool call that started it.
      sessionId: "sess_1",
      parentTraceId: turnTraceId("sess_1", "turn_1"),
      parentSpanId: boundedId("tool", "turn_1", "call_1"),
      trigger: { kind: "harness", sessionId: "sess_1", turnId: "turn_1", toolCallId: "call_1" },
      environment: "production",
      metadata: { runId: "run_1" },
    });
    const spans = fake.spansOf(traceId);
    const root = spans.find((span) => span.id === "root");
    expect(root).toMatchObject({ type: "workflow", status: "ok", input: { orderId: "A1" } });
    expect(root?.endTime).toBeDefined();

    const steps = spans.filter((span) => span.type === "step");
    expect(steps.map((span) => [span.name, span.status, span.parentId])).toEqual([
      ["lookup", "ok", "root"],
      ["reply", "ok", "root"],
    ]);
    expect(steps[0]?.output).toMatchObject({ orderId: "A1", status: "shipped" });

    const llm = spans.find((span) => span.type === "llm");
    expect(llm).toMatchObject({
      parentId: steps[1]?.id,
      status: "ok",
      model: "claude-test",
      provider: "anthropic",
      usage: { inputTokens: 100, outputTokens: 7, cacheReadTokens: 200 },
    });
    expect((llm?.output as { text: string }).text).toBe("Order A1 has shipped.");
    const toolSpan = spans.find((span) => span.type === "tool");
    expect(toolSpan).toMatchObject({ name: "lookup_order", parentId: steps[0]?.id, status: "ok" });
    expect(spans.every((span) => span.status !== "running")).toBe(true);
  });

  it("is still the inner World: reads go to it, and a failing LittleDB never fails the run", async () => {
    const fake = fakeLittleDB();
    fake.override(() => ({ status: 400, body: { error: { code: "bad_request", message: "refused" } } }));
    const onError = vi.fn();
    const db = createLittleDB({ url: fake.url, apiKey: fake.apiKey, fetch: fake.fetch, onError });
    let wrapped: World | undefined;
    let inner: World | undefined;
    const result = await runPlan((ctx) => {
      inner = localWorld({ dataDir: ctx.dataDir });
      wrapped = db.tracingWorld(inner, { workflow: "orders", traceId: "fixed_trace" });
      return wrapped;
    });
    expect(result.status).toBe("completed");
    expect(wrapped?.dataDir).toBe(inner?.dataDir);
    const events = await wrapped!.listEvents("run_1");
    expect(events.map((e) => e.type)).toContain("RunCompleted");
    await db.shutdown();
    expect(onError).toHaveBeenCalledWith(expect.anything(), { operation: "ingest" });
  });

  it("tags an eval run's trace with the experiment and version", async () => {
    const fake = fakeLittleDB();
    const db = createLittleDB({ url: fake.url, apiKey: fake.apiKey, fetch: fake.fetch });
    await runPlan((ctx) =>
      db.tracingWorld(localWorld({ dataDir: ctx.dataDir }), {
        workflow: "orders",
        traceId: "exp_run_9",
        versionId: "ver_3",
        environment: "experiment",
        experimentId: "exp_1",
        datasetItemId: "itm_4",
      }),
    );
    await db.flush();
    expect([...fake.traces.keys()]).toEqual(["exp_run_9"]);
    expect(fake.traces.get("exp_run_9")).toMatchObject({ kind: "experiment", versionId: "ver_3", experimentId: "exp_1", datasetItemId: "itm_4", workflowOrigin: "code" });
  });

  it("nests a run a harness tool call started under that turn's trace and tool span, in its session", async () => {
    const fake = fakeLittleDB();
    const db = createLittleDB({ url: fake.url, apiKey: fake.apiKey, fetch: fake.fetch });
    const dataDir = await mkdtemp(join(tmpdir(), "ldb-nested-"));
    dirs.push(dataDir);
    const lookupInput = z.object({ orderId: z.string() });
    const lookup = defineWorkflow({
      id: "orders.lookup",
      input: lookupInput,
      tools: { find: tool({ description: "Find an order.", inputSchema: lookupInput, execute: async ({ orderId }) => ({ orderId, status: "shipped" }) }) },
      plan: {
        steps: [{ id: "find", uses: "tool.call", with: { tool: "find", args: { orderId: "{{ input.orderId }}" } }, output: { mode: "json", schema: true } }],
      },
    });
    // The World needs no session or turn: the run's trigger says which tool call started it.
    const world = db.tracingWorld(localWorld({ dataDir: join(dataDir, "runs") }), { workflow: "orders.lookup", harness: "support" });
    let calls = 0;
    const model = new MockLanguageModelV3({
      provider: "anthropic.messages",
      modelId: "claude-test",
      doGenerate: async () => {
        calls += 1;
        const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
        return calls === 1
          ? {
              content: [{ type: "tool-call", toolCallId: "call_lookup", toolName: "orders_lookup", input: JSON.stringify({ orderId: "A1" }) }],
              finishReason: { unified: "tool-calls", raw: "tool_use" },
              usage,
              warnings: [],
            }
          : { content: [{ type: "text", text: "A1 shipped." }], finishReason: { unified: "stop", raw: "end_turn" }, usage, warnings: [] };
      },
    });
    // A tracer with its own trace ids: the run still finds its turn's trace.
    const tracer = db.harnessTracer({ harness: "support", traceIdFor: (sessionId, turnId) => `mine_${sessionId}_${turnId}` });
    const harness = createHarness({
      host: localHost({ dataDir: join(dataDir, "host") }),
      model,
      runtime: { bash: false },
      onEvent: tracer.onEvent,
      workflows: [asHarnessWorkflow(lookup, { definitionIdentity: "sha256:orders-lookup", world })],
    });
    const result = await generateHarness({
      harness,
      session: "wa_1",
      prompt: "Where is order A1?",
      trigger: { kind: "message", source: "whatsapp", from: "+15550100" },
    });
    expect(result.status).toBe("completed");
    await db.flush();

    const turnTrace = tracer.traceIdFor("wa_1")!;
    expect(turnTrace).toMatch(/^mine_wa_1_turn_/u);
    expect(fake.traces.get(turnTrace)?.trigger).toEqual({ kind: "message", source: "whatsapp", from: "+15550100" });
    const toolSpan = fake.spansOf(turnTrace).find((span) => span.type === "tool");
    expect(toolSpan?.id).toBe(boundedId("tool", turnTrace.slice("mine_wa_1_".length), "call_lookup"));

    const runTraces = [...fake.traces.values()].filter((trace) => trace.kind === "workflow");
    expect(runTraces).toHaveLength(1);
    expect(runTraces[0]).toMatchObject({
      workflow: "orders.lookup",
      sessionId: "wa_1",
      parentTraceId: turnTrace,
      parentSpanId: toolSpan?.id,
      trigger: { kind: "harness", sessionId: "wa_1", turnId: turnTrace.slice("mine_wa_1_".length), toolCallId: "call_lookup" },
    });
  });

  it("points a child run at its parent run's trace and session, and keeps a fixed trace's row as the first run left it", async () => {
    const fake = fakeLittleDB();
    const db = createLittleDB({ url: fake.url, apiKey: fake.apiKey, fetch: fake.fetch });
    let sequence = 0;
    const inner: WorldLike = {
      appendEvent: async (runId, event): Promise<WorldEventLike> => ({ runId, ...event, recordedAt: new Date().toISOString(), sequence: ++sequence }),
    };
    const world = db.tracingWorld(inner, { workflow: "orders" });
    const harnessStarted = { kind: "harness", sessionId: "sess_1", turnId: "turn_1", toolCallId: "call_1" };
    await world.appendEvent("run_parent", { type: "WorkflowVersionRegistered", payload: { workflowVersionId: "wv_1" } });
    await world.appendEvent("run_parent", { type: "RunStarted", payload: { workflowVersionId: "wv_1", trigger: harnessStarted } });
    await world.appendEvent("run_child", { type: "WorkflowVersionRegistered", payload: { workflowVersionId: "wv_2" } });
    await world.appendEvent("run_child", { type: "RunStarted", payload: { workflowVersionId: "wv_2", parentRunId: "run_parent" } });

    const fixed = db.tracingWorld(inner, { workflow: "orders", traceId: "exp_run_3" });
    await fixed.appendEvent("run_a", { type: "RunStarted", payload: { workflowVersionId: "wv_1" } });
    await fixed.appendEvent("run_b", { type: "RunStarted", payload: { workflowVersionId: "wv_1", trigger: harnessStarted } });
    await db.flush();

    // No tracer from this client saw the turn, so the parent is the turn's default trace id.
    expect(fake.traces.get(runTraceId("run_parent"))).toMatchObject({
      sessionId: "sess_1",
      parentTraceId: turnTraceId("sess_1", "turn_1"),
      parentSpanId: boundedId("tool", "turn_1", "call_1"),
      trigger: harnessStarted,
    });
    expect(fake.traces.get(runTraceId("run_child"))).toMatchObject({
      sessionId: "sess_1",
      parentTraceId: runTraceId("run_parent"),
      trigger: { kind: "workflow", runId: "run_parent" },
    });
    expect(fake.traces.get(runTraceId("run_child"))?.parentSpanId).toBeUndefined();
    const fixedRow = fake.traces.get("exp_run_3");
    expect(fixedRow?.metadata).toEqual({ runId: "run_a" });
    expect(fixedRow?.trigger).toBeUndefined();
    expect(fixedRow?.parentTraceId).toBeUndefined();
  });

  it("keeps each run's steps and calls apart when runs share one trace", async () => {
    const fake = fakeLittleDB();
    const db = createLittleDB({ url: fake.url, apiKey: fake.apiKey, fetch: fake.fetch });
    // Each run numbers its own events, as a World does.
    const sequences = new Map<string, number>();
    const inner: WorldLike = {
      appendEvent: async (runId, event): Promise<WorldEventLike> => {
        sequences.set(runId, (sequences.get(runId) ?? 0) + 1);
        return { runId, ...event, recordedAt: new Date().toISOString(), sequence: sequences.get(runId)! };
      },
    };
    const world = db.tracingWorld(inner, { workflow: "orders", traceId: "exp_shared" });
    for (const runId of ["run_a", "run_b"]) {
      const step = { stepPath: "lookup", attempt: 1 };
      await world.appendEvent(runId, { type: "RunStarted", payload: { input: { order: runId } } });
      await world.appendEvent(runId, { type: "StepAttemptStarted", payload: { ...step, stepId: "lookup" } });
      await world.appendEvent(runId, { type: "ToolCallStarted", payload: { ...step, tool: "orders.get" } });
      await world.appendEvent(runId, { type: "ToolCallCompleted", payload: { ...step, tool: "orders.get" } });
      // Ids a model provider numbers per call, so every run has them.
      await world.appendEvent(runId, { type: "harness.model.called", payload: { callId: "model_1", request: { model: "m", messages: [], scope: step } } });
      await world.appendEvent(runId, { type: "harness.model.responded", payload: { callId: "model_1", response: { text: runId } } });
      await world.appendEvent(runId, { type: "harness.tool_call.started", payload: { callId: "call_1", toolName: "lookup_order", scope: step } });
      await world.appendEvent(runId, { type: "harness.tool_call.succeeded", payload: { callId: "call_1", result: runId } });
      await world.appendEvent(runId, { type: "StepCompleted", payload: { ...step, output: { found: runId } } });
      await world.appendEvent(runId, { type: "RunCompleted", payload: { output: runId } });
    }
    await db.flush();

    const spans = fake.spansOf("exp_shared");
    const steps = spans.filter((span) => span.type === "step");
    expect(steps.map((span) => [span.parentId, span.output])).toEqual([
      ["root", { found: "run_a" }],
      [boundedId("run", "run_b"), { found: "run_b" }],
    ]);
    for (const type of ["llm", "tool"] as const) {
      const calls = spans.filter((span) => span.type === type);
      // One model call and two tool calls (the step's own, and the model's) per run, each under its own run's step.
      expect(calls).toHaveLength(type === "llm" ? 2 : 4);
      expect(new Set(calls.map((span) => span.parentId))).toEqual(new Set(steps.map((span) => span.id)));
    }
  });
});
