import { describe, expect, it } from "vitest";
import { jsonSchema, tool } from "ai";
import { searchAuthoredPlans, writeAuthoredPlan } from "./authored-plans-store.js";
import { createDynamicWorkflowTools } from "./tools.js";

const echo = tool({
  description: "Echo.",
  inputSchema: jsonSchema<unknown>({ type: "object", additionalProperties: true }),
  execute: async (a: unknown) => a,
});

const stubFactory = {
  compile: () => ({
    ok: true as const,
    definitionHash: "sha256:x",
    lwir: { steps: [{}] },
    referenced: { tools: ["echo"], models: ["default"], bash: false },
    workflow: {
      id: "ad_hoc_plan",
      executionMode: "inline" as const,
      definitionIdentity: "sha256:x",
      inputSchema: { kind: "untyped" as const, allowUntypedInput: true },
      async runForHarness() {
        return {
          protocolVersion: 1 as const,
          status: "completed" as const,
          runId: "run_1",
          output: { ok: true },
        };
      },
    },
  }),
};

function makeTools(overrides = {}) {
  return createDynamicWorkflowTools({
    sessionId: "s",
    turnId: "t",
    originTurnId: "t",
    dataDir: "s/dyn",
    dynamic: {
      factory: stubFactory as never,
      exclude: [],
      limits: { maxSteps: 8, maxRuntimeMs: 120_000 },
    },
    parentSnapshot: { tools: { echo }, mcpTools: {} },
    model: { provider: "test", modelId: "test" } as never,
    authoredPlansHarnessDir: "/persistent/dynamic-plans",
    ...overrides,
  });
}

describe("createDynamicWorkflowTools", () => {
  it("exposes run_ad_hoc_plan and search_authored_plans", () => {
    const tools = makeTools();
    expect(Object.keys(tools).sort()).toEqual(["run_ad_hoc_plan", "search_authored_plans"]);
  });

  it("run_ad_hoc_plan compiles + runs + returns a compact completed envelope", async () => {
    const tools = makeTools();
    const files = fileStub();
    const result = await tools.run_ad_hoc_plan!.execute!(
      {
        purpose: "echo it",
        plan: { steps: [{ id: "c", uses: "tool.call", tool: "echo", with: {} }], output: { from: "c" } },
        input: {},
        outputSchema: true,
      },
      { toolCallId: "call_1", files } as never,
    );
    // The authoring model MUST get the plan's actual result back, not a bare status envelope.
    expect(result).toMatchObject({ status: "completed", runId: expect.any(String), output: { ok: true } });
  });

  it("runs the plan with the model's tool call id, so its trace can point at that call", async () => {
    const seen: Array<{ toolCallId: string; parentSessionId: string; parentTurnId: string }> = [];
    const compile = stubFactory.compile;
    const tools = makeTools({
      dynamic: {
        factory: {
          compile: () => {
            const compiled = compile();
            return {
              ...compiled,
              workflow: {
                ...compiled.workflow,
                async runForHarness(_input: unknown, ctx: { toolCallId: string; parentSessionId: string; parentTurnId: string }) {
                  seen.push({ toolCallId: ctx.toolCallId, parentSessionId: ctx.parentSessionId, parentTurnId: ctx.parentTurnId });
                  return compiled.workflow.runForHarness();
                },
              },
            };
          },
        } as never,
        exclude: [],
        limits: { maxSteps: 8, maxRuntimeMs: 120_000 },
      },
    });
    await tools.run_ad_hoc_plan!.execute!(
      {
        purpose: "echo it",
        plan: { steps: [{ id: "c", uses: "tool.call", tool: "echo", with: {} }], output: { from: "c" } },
        input: {},
        outputSchema: true,
      },
      { toolCallId: "call_7", files: fileStub() } as never,
    );
    expect(seen).toEqual([{ toolCallId: "call_7", parentSessionId: "s", parentTurnId: "t" }]);
  });

  it("search_authored_plans recalls a plan written by a prior run", async () => {
    const tools = makeTools();
    const files = fileStub();
    await tools.run_ad_hoc_plan!.execute!(
      {
        purpose: "summarize the changelog",
        plan: { steps: [{ id: "c", uses: "tool.call", tool: "echo", with: {} }], output: { from: "c" } },
        input: {},
        outputSchema: true,
      },
      { toolCallId: "call_write", files } as never,
    );

    const found = (await tools.search_authored_plans!.execute!(
      { query: "changelog" },
      { toolCallId: "call_search", files } as never,
    )) as { plans: readonly { runId: string; purpose: string; status: string; outputSchema: unknown; plan: unknown }[] };

    expect(found.plans).toHaveLength(1);
    expect(found.plans[0]).toMatchObject({
      purpose: "summarize the changelog",
      status: "completed",
    });
    // runId = readable session/turn/toolCall prefix + a 12-hex hash of the full tuple, so a
    // long sessionId can never truncate away the discriminating suffix.
    expect(found.plans[0]!.runId).toMatch(/^run_adhoc_s_t_call_write_[0-9a-f]{12}$/);
    // The recalled record carries outputSchema so the plan can be re-submitted verbatim.
    expect(found.plans[0]!.outputSchema).toBe(true);
    expect(found.plans[0]!.plan).toBeDefined();
  });

  it("search_authored_plans returns only completed runs, the newest of each distinct plan first", async () => {
    // Every run is recorded, but failed runs and repeats of one plan would crowd the result
    // (past the inline limit it moves to a file the agent may not be able to read).
    const runs = [
      { hash: "sha256:a", status: "completed", at: "2026-10-14T01:00:00.000Z" },
      { hash: "sha256:b", status: "failed", at: "2026-10-14T02:00:00.000Z" },
      { hash: "sha256:a", status: "completed", at: "2026-10-14T03:00:00.000Z" },
      { hash: "sha256:c", status: "completed", at: "2026-10-14T02:30:00.000Z" },
    ];
    let index = 0;
    const factory = {
      compile: () => {
        const run = runs[index]!;
        return {
          ...stubFactory.compile(),
          definitionHash: run.hash,
          workflow: {
            ...stubFactory.compile().workflow,
            async runForHarness() {
              return run.status === "completed"
                ? { protocolVersion: 1 as const, status: "completed" as const, runId: "run_1", output: { ok: true } }
                : { protocolVersion: 1 as const, status: "failed" as const, runId: "run_1", causeCode: "workflow_failed" as const, message: "no" };
            },
          },
        };
      },
    };
    const files = fileStub();
    for (const run of runs) {
      const tools = makeTools({
        dynamic: { factory: factory as never, exclude: [], limits: { maxSteps: 8, maxRuntimeMs: 120_000 } },
        nowIso: () => run.at,
      });
      await tools.run_ad_hoc_plan!.execute!(
        {
          purpose: "mortgage pre-approval",
          plan: { steps: [{ id: "c", uses: "tool.call", tool: "echo", with: {} }], output: { from: "c" } },
          input: {},
          outputSchema: true,
        },
        { toolCallId: `call_${index}`, files } as never,
      );
      index += 1;
    }

    const found = (await makeTools().search_authored_plans!.execute!(
      { query: "pre-approval" },
      { toolCallId: "call_search", files } as never,
    )) as { plans: readonly { runId: string; status: string }[] };

    expect(found.plans.map((plan) => plan.runId)).toEqual([
      expect.stringMatching(/^run_adhoc_s_t_call_2_/u),
      expect.stringMatching(/^run_adhoc_s_t_call_3_/u),
    ]);
    expect(found.plans.every((plan) => plan.status === "completed")).toBe(true);
  });

  it("search_authored_plans keeps one per distinct plan before limiting, so repeats cannot hide others", async () => {
    const files = fileStub();
    const base = {
      purpose: "mortgage pre-approval",
      plan: { steps: [] },
      capabilitySnapshot: {},
      outputSchema: true,
      status: "completed" as const,
      steps: 1,
    };
    // Eleven newer runs of one plan, then one older run of another.
    for (let i = 0; i < 11; i += 1) {
      await writeAuthoredPlan(files, "/persistent/dynamic-plans", {
        ...base,
        runId: `run_a${i}`,
        definitionHash: "sha256:a",
        createdAt: `2026-10-14T${String(10 + i).padStart(2, "0")}:00:00.000Z`,
      });
    }
    await writeAuthoredPlan(files, "/persistent/dynamic-plans", {
      ...base,
      runId: "run_b",
      definitionHash: "sha256:b",
      createdAt: "2026-10-14T01:00:00.000Z",
    });

    const found = (await makeTools().search_authored_plans!.execute!(
      { query: "pre-approval" },
      { toolCallId: "call_search", files } as never,
    )) as { plans: readonly { runId: string }[] };

    expect(found.plans.map((plan) => plan.runId)).toEqual(["run_a10", "run_b"]);
  });

  it("run_ad_hoc_plan spells out the plan's shape, the template syntax and the model slots", () => {
    const tools = makeTools({
      dynamic: {
        factory: stubFactory as never,
        exclude: [],
        limits: { maxSteps: 8, maxRuntimeMs: 120_000 },
        models: { fast: { provider: "test", modelId: "fast" } },
      },
    });
    const run = tools.run_ad_hoc_plan!;
    const schema = (run.inputSchema as { jsonSchema: Record<string, any> }).jsonSchema;
    const step = schema.properties.plan.properties.steps.items;
    expect(step.properties.uses.enum).toEqual(["tool.call", "ai.generate"]);
    expect(step.properties.model.enum).toEqual(["default", "fast"]);
    expect(step.additionalProperties).toBe(false);
    expect(run.description).toContain("{{ input.<field> }}");
    expect(run.description).toContain("{{ steps.<id>.output }}");
    expect(run.description).toContain("default (your own model), fast");
  });

  it("offers configured model slots to a plan and hands their models to the run", async () => {
    const fast = { provider: "test", modelId: "fast" };
    let submittedModels: readonly string[] = [];
    let runModels: Record<string, unknown> = {};
    const factory = {
      compile: (submission: { allowed: { models: readonly string[] } }) => {
        submittedModels = submission.allowed.models;
        const compiled = stubFactory.compile();
        return {
          ...compiled,
          workflow: {
            ...compiled.workflow,
            async runForHarness(_input: unknown, ctx: { capabilities: { models?: Record<string, unknown> } }) {
              runModels = ctx.capabilities.models ?? {};
              return compiled.workflow.runForHarness();
            },
          },
        };
      },
    };
    const tools = makeTools({
      dynamic: {
        factory: factory as never,
        exclude: [],
        limits: { maxSteps: 8, maxRuntimeMs: 120_000 },
        models: { fast },
      },
    });
    await tools.run_ad_hoc_plan!.execute!(
      {
        purpose: "x",
        plan: { steps: [{ id: "c", uses: "tool.call", tool: "echo", with: {} }], output: { from: "c" } },
        input: {},
        outputSchema: true,
      },
      { toolCallId: "call_models", files: fileStub() } as never,
    );
    expect(submittedModels).toEqual(["default", "fast"]);
    expect(runModels).toMatchObject({ default: { modelId: "test" }, fast });
  });

  it("run_ad_hoc_plan returns capability_not_allowed compactly when the factory rejects", async () => {
    const rejecting = {
      compile: () => ({ ok: false as const, causeCode: "capability_not_allowed" as const, message: "nope" }),
    };
    const tools = makeTools({
      dynamic: {
        factory: rejecting as never,
        exclude: [],
        limits: { maxSteps: 8, maxRuntimeMs: 120_000 },
      },
    });
    const result = await tools.run_ad_hoc_plan!.execute!(
      { purpose: "x", plan: { steps: [], output: { from: "c" } }, input: {}, outputSchema: true },
      { toolCallId: "call_2", files: fileStub() } as never,
    );
    expect(result).toMatchObject({ status: "failed", causeCode: "capability_not_allowed" });
  });

  it("charges one-shot plan runs against the session's maxConcurrentWorkflowRuns", async () => {
    // A one-shot plan is a workflow run: 50 parallel run_ad_hoc_plan calls must not become
    // 50 concurrent runs. Same session-scoped pool as the configured workflow tools.
    const state = { inFlight: 0, peak: 0, gates: [] as Array<() => void> };
    const holdingFactory = {
      compile: () => ({
        ok: true as const,
        definitionHash: "sha256:x",
        lwir: { steps: [{}] },
        referenced: { tools: ["echo"], models: ["default"], bash: false },
        workflow: {
          id: "ad_hoc_plan",
          executionMode: "inline" as const,
          definitionIdentity: "sha256:x",
          inputSchema: { kind: "untyped" as const, allowUntypedInput: true },
          async runForHarness() {
            state.inFlight += 1;
            state.peak = Math.max(state.peak, state.inFlight);
            await new Promise<void>((resolve) => state.gates.push(resolve));
            state.inFlight -= 1;
            return { protocolVersion: 1 as const, status: "completed" as const, runId: "run_1", output: { ok: true } };
          },
        },
      }),
    };
    const tools = makeTools({
      sessionId: "sess_dynamic_fanout",
      dynamic: {
        factory: holdingFactory as never,
        exclude: [],
        limits: { maxSteps: 8, maxRuntimeMs: 120_000 },
      },
      budgets: { maxConcurrentWorkflowRuns: 2, maxQueuedWorkflowRuns: 100 },
    });

    const files = fileStub();
    const calls = Array.from({ length: 6 }, (_unused, n) =>
      tools.run_ad_hoc_plan!.execute!(
        {
          purpose: "hold",
          plan: { steps: [{ id: "c", uses: "tool.call", tool: "echo", with: {} }], output: { from: "c" } },
          input: {},
          outputSchema: true,
        },
        { toolCallId: `call_${n}`, files } as never,
      ));

    for (let released = 0; released < 6; released += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(state.inFlight).toBeLessThanOrEqual(2);
      state.gates.shift()?.();
    }

    const results = await Promise.all(calls);
    expect(results).toHaveLength(6);
    expect(state.peak).toBe(2);
    for (const result of results) {
      expect(result).toMatchObject({ status: "completed" });
    }
  });

  it("fails a one-shot plan that would queue past maxQueuedWorkflowRuns", async () => {
    const gates: Array<() => void> = [];
    const holdingFactory = {
      compile: () => ({
        ok: true as const,
        definitionHash: "sha256:x",
        lwir: { steps: [{}] },
        referenced: { tools: ["echo"], models: ["default"], bash: false },
        workflow: {
          id: "ad_hoc_plan",
          executionMode: "inline" as const,
          definitionIdentity: "sha256:x",
          inputSchema: { kind: "untyped" as const, allowUntypedInput: true },
          async runForHarness() {
            await new Promise<void>((resolve) => gates.push(resolve));
            return { protocolVersion: 1 as const, status: "completed" as const, runId: "run_1", output: { ok: true } };
          },
        },
      }),
    };
    const tools = makeTools({
      sessionId: "sess_dynamic_queue_bound",
      dynamic: {
        factory: holdingFactory as never,
        exclude: [],
        limits: { maxSteps: 8, maxRuntimeMs: 120_000 },
      },
      budgets: { maxConcurrentWorkflowRuns: 1, maxQueuedWorkflowRuns: 1 },
    });

    const files = fileStub();
    const run = (n: number) =>
      tools.run_ad_hoc_plan!.execute!(
        {
          purpose: "hold",
          plan: { steps: [{ id: "c", uses: "tool.call", tool: "echo", with: {} }], output: { from: "c" } },
          input: {},
          outputSchema: true,
        },
        { toolCallId: `call_${n}`, files } as never,
      );

    const admitted = run(0);
    const queued = run(1);
    const overflow = await run(2);
    expect(overflow).toMatchObject({ status: "failed", causeCode: "max_queued_workflow_runs" });
    expect((overflow as { message: string }).message).toContain("maxQueuedWorkflowRuns is 1");
    // The rejected call is not recorded as a running plan. (Read the store itself: the search
    // tool offers only completed plans.)
    const recorded = await searchAuthoredPlans(files, "/persistent/dynamic-plans", "hold");
    expect(recorded.map((record) => record.status)).toEqual(["running"]);

    for (let released = 0; released < 2; released += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      gates.shift()?.();
    }
    await expect(Promise.all([admitted, queued])).resolves.toMatchObject([
      { status: "completed" },
      { status: "completed" },
    ]);
  });
});

function fileStub() {
  const store = new Map<string, string>();
  return {
    async writeText(p: string, c: string) {
      store.set(p, c);
    },
    async read(p: string) {
      const v = store.get(p);
      if (v === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return { text: () => v };
    },
    async list(prefix: string) {
      return [...store.keys()].filter((k) => k.startsWith(prefix)).map((path) => ({ path }));
    },
  };
}
