import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { localWorld } from "./authoring.js";
import {
  buildPlannerRepairNote,
  buildPlanningContext,
  compileWorkflow,
  synthesizeReferenceLwir,
  synthesizeSimpleLwir,
  toOrchestrationRequest,
  type PlannerAdapter,
} from "./compiler.js";
import { createLittleWorkflow, createToolRegistry, model, output, resolveSkills, skill, validateLwir, type Harness, type JsonValue, type LwirWorkflow } from "./index.js";
import { hashHarnessManifest, plannerManifest } from "./manifests.js";

// A planner that never returns valid LWIR — forces the deterministic fallback so
// we can prove a bare workflow (no planner prompt) still compiles, keylessly.
const failingPlanner: PlannerAdapter = {
  draft: async () => ({ apiVersion: "nope", kind: "Workflow", steps: [] }),
};

const workerSlot = model(
  { provider: "test", modelId: "m" },
  { id: "model.worker", description: "Fast bulk worker." },
);

const dummyPlanner = {
  model: { provider: "test", modelId: "p" },
  harness: {
    harnessId: "dummyPlanner@1.0.0",
    async run() {
      return { kind: "plan" as const, lwir: {} };
    },
  },
};

// A "bare" workflow: only a description + output schema + a model slot. No
// inputSchema (flexible input), no planner system prompt.
function bareWorkflow(id: string, out: unknown) {
  return createLittleWorkflow({
    id,
    description: `${id} — generate data`,
    output: out,
    models: [workerSlot],
    planner: dummyPlanner,
  } as unknown as Parameters<typeof createLittleWorkflow>[0]);
}

const objSchema = (properties: Record<string, JsonValue>, required: string[]): Record<string, JsonValue> => ({
  type: "object",
  required,
  additionalProperties: false,
  properties,
});

// Several distinct domains + every output shape — so the fix can't overfit to one.
const DOMAINS = [
  {
    id: "gen.candidates",
    mode: "array",
    out: output.array({ element: objSchema({ name: { type: "string" }, seniority: { type: "string", enum: ["junior", "senior"] } }, ["name", "seniority"]) }),
  },
  {
    id: "gen.startups",
    mode: "array",
    out: output.array({ element: objSchema({ name: { type: "string" }, sector: { type: "string" }, oneLiner: { type: "string" } }, ["name", "sector", "oneLiner"]) }),
  },
  {
    id: "gen.summary",
    mode: "object",
    out: output.object({ schema: objSchema({ summary: { type: "string" }, keyPoints: { type: "array", items: { type: "string" } } }, ["summary", "keyPoints"]) }),
  },
  {
    id: "gen.headline",
    mode: "text",
    out: output.text(),
  },
  {
    id: "gen.sentiment",
    mode: "choice",
    out: output.choice({ values: ["positive", "neutral", "negative"] }),
  },
] as const;

describe("less-guidance compilation: deterministic synthesis", () => {
  for (const d of DOMAINS) {
    it(`synthesizes a valid single ai.generate step for ${d.id} (${d.mode})`, () => {
      const request = toOrchestrationRequest(bareWorkflow(d.id, d.out), {
        input: { goal: "go", count: 3 },
        requestId: `orq_${d.id}`,
      });
      const lwir = synthesizeSimpleLwir(request);
      if (lwir === undefined) throw new Error("expected a synthesized LWIR");
      expect(lwir.steps).toHaveLength(1);
      const step = lwir.steps[0];
      expect(step.uses).toBe("ai.generate");
      expect((step.with as { model?: string }).model).toBe("model.worker");
      expect((step.output as { mode?: string }).mode).toBe(d.mode);
      expect(lwir.permissions?.models).toEqual(["model.worker"]);
      expect(lwir.metadata.name).toBe(d.id);
    });

    it(`compiles ${d.id} via the fallback when the planner never returns valid LWIR`, async () => {
      const result = await compileWorkflow(bareWorkflow(d.id, d.out), {
        input: { goal: "go", count: 3 },
        tools: createToolRegistry({}),
        requestId: `orq_compile_${d.id}`,
        planner: failingPlanner,
        controls: { maxWorkflowRevisions: 1 },
      });
      expect(result.workflowVersion).toBeDefined();
      const last = result.revisions[result.revisions.length - 1];
      expect(last.valid).toBe(true);
      expect((last.lwir as { steps: { uses: string }[] }).steps[0].uses).toBe("ai.generate");
    });
  }

  it("the planning context names the available model slots and embeds a reference LWIR", () => {
    const request = toOrchestrationRequest(bareWorkflow("gen.candidates", DOMAINS[0].out), {
      input: { goal: "x", count: 2 },
      requestId: "orq_ctx",
    });
    const ctx = buildPlanningContext(request);
    expect(ctx).toContain("model.worker");
    expect(ctx).toContain("reference LWIR");
    expect(ctx).toContain('"uses": "ai.generate"');
  });
});

// Verifies the *equipped planner* path (A) independently of the synthesis
// fallback (B): a planner that returns valid LWIR must compile WITHOUT falling
// back, and the plan task it receives must carry the capability context.
describe("less-guidance compilation: the equipped planner", () => {
  function capturingPlanner(lwir: unknown) {
    const calls: { systemMessage?: string }[] = [];
    return {
      calls,
      config: {
        model: { provider: "test", modelId: "p" },
        harness: {
          harnessId: "capturingPlanner@1.0.0",
          async run(task: { systemMessage?: string }) {
            calls.push(task);
            return { kind: "plan" as const, lwir };
          },
        },
      },
    };
  }

  const summarySchema = objSchema({ summary: { type: "string" } }, ["summary"]);

  it("uses the planner's valid LWIR with no fallback, and wires the capabilities + reference into the plan task (tool-less)", async () => {
    const plannerLwir = {
      apiVersion: "littleworkflow.dev/v0.1",
      kind: "Workflow",
      metadata: { name: "gen.summary" },
      input: { schema: true },
      output: { schema: summarySchema },
      permissions: { tools: [], models: ["model.worker"], secrets: [], network: [] },
      steps: [{ id: "planner_authored", uses: "ai.generate", input: "{{ input }}", with: { model: "model.worker" }, output: { mode: "object", schema: summarySchema } }],
    };
    const planner = capturingPlanner(plannerLwir);
    const wf = createLittleWorkflow({
      id: "gen.summary",
      description: "summarize",
      output: output.object({ schema: summarySchema }),
      models: [workerSlot],
      planner: planner.config,
    } as unknown as Parameters<typeof createLittleWorkflow>[0]);

    const result = await compileWorkflow(wf, { input: { text: "x" }, requestId: "orq_planner_toolless" });
    // compiled on the planner's first valid draft — no synthesis fallback revision
    expect(result.revisions).toHaveLength(1);
    expect((result.revisions[0].lwir as { steps: { id: string }[] }).steps[0].id).toBe("planner_authored");
    // the plan task carried the capabilities + the reference LWIR
    expect(planner.calls).toHaveLength(1);
    expect(planner.calls[0].systemMessage).toContain("model.worker");
    expect(planner.calls[0].systemMessage).toContain("reference LWIR");
  });

  it("synthesizeReferenceLwir gives a tool-registering workflow a VALID tool.call -> ai.generate skeleton", () => {
    const outSchema = objSchema({ status: { type: "string" }, summary: { type: "string" } }, ["status", "summary"]);
    const tools = createToolRegistry({
      lookupOrder: { description: "look up an order", inputSchema: { type: "object", additionalProperties: true }, execute: async () => ({}) },
      issueRefund: { description: "issue a refund", inputSchema: { type: "object", additionalProperties: true }, execute: async () => ({}) },
    });
    const wf = createLittleWorkflow({
      id: "billing.refund",
      description: "process a customer refund",
      output: output.object({ schema: outSchema }),
      models: [workerSlot],
      globalTools: ["lookupOrder", "issueRefund"],
      planner: dummyPlanner,
    } as unknown as Parameters<typeof createLittleWorkflow>[0]);
    const request = toOrchestrationRequest(wf, { input: {}, tools, requestId: "orq_ref_skeleton" });

    // The deterministic single-step synthesis stays gated for tool workflows (it would be a wrong fallback)...
    expect(synthesizeSimpleLwir(request)).toBeUndefined();
    // ...but the planner now gets a VALID reference skeleton showing the format + how to call a tool.
    const skeleton = synthesizeReferenceLwir(request);
    expect(skeleton).toBeDefined();
    expect(validateLwir(skeleton).findings).toEqual([]);
    const steps = (skeleton as LwirWorkflow).steps;
    expect(steps.some((s) => s.uses === "tool.call")).toBe(true);
    expect(steps.some((s) => s.uses === "ai.generate")).toBe(true);
  });

  it("buildPlanningContext shows each tool's input schema + description so the planner builds correct args", () => {
    const tools = createToolRegistry({
      lookupOrder: { description: "look up an order by id", inputSchema: objSchema({ orderId: { type: "string" } }, ["orderId"]), execute: async () => ({}) },
    });
    const wf = createLittleWorkflow({
      id: "billing.refund",
      description: "refund",
      output: output.object({ schema: objSchema({ ok: { type: "boolean" } }, ["ok"]) }),
      models: [workerSlot],
      globalTools: ["lookupOrder"],
      planner: dummyPlanner,
    } as unknown as Parameters<typeof createLittleWorkflow>[0]);
    const ctx = buildPlanningContext(toOrchestrationRequest(wf, { input: {}, tools, requestId: "orq_sig" }));
    expect(ctx).toContain("lookupOrder");
    expect(ctx).toContain("orderId"); // the tool's input schema is shown, not just the name
    expect(ctx).toContain("look up an order by id"); // and its description
  });

  it("synthesizeReferenceLwir maps tool args from the tool's input schema, not the whole input", () => {
    const tools = createToolRegistry({
      lookupOrder: { description: "look up", inputSchema: objSchema({ orderId: { type: "string" } }, ["orderId"]), execute: async () => ({}) },
    });
    const wf = createLittleWorkflow({
      id: "billing.refund",
      description: "refund",
      output: output.object({ schema: objSchema({ ok: { type: "boolean" } }, ["ok"]) }),
      models: [workerSlot],
      globalTools: ["lookupOrder"],
      planner: dummyPlanner,
    } as unknown as Parameters<typeof createLittleWorkflow>[0]);
    const skeleton = synthesizeReferenceLwir(toOrchestrationRequest(wf, { input: {}, tools, requestId: "orq_args" }));
    expect(validateLwir(skeleton).findings).toEqual([]);
    const toolStep = (skeleton as LwirWorkflow).steps.find((s) => s.uses === "tool.call");
    // Per-field args matching the tool's schema — NOT the strict-schema-breaking whole input.
    expect(toolStep?.with?.args).toEqual({ orderId: "{{ input.orderId }}" });
  });

  it("buildPlannerRepairNote surfaces each validation error + the rejected draft for the model to fix", () => {
    const note = buildPlannerRepairNote({
      previousLwir: { apiVersion: "WRONG/v0", kind: "NotAWorkflow", steps: "nope" },
      findings: [
        { severity: "error", code: "apiVersion", path: "$.apiVersion", message: "apiVersion must be littleworkflow.dev/v0.1" },
        { severity: "error", code: "steps", path: "$.steps", message: "steps must be an array" },
      ],
    });
    expect(note).toContain("REJECTED");
    expect(note).toContain("$.apiVersion: apiVersion must be littleworkflow.dev/v0.1");
    expect(note).toContain("$.steps: steps must be an array");
    expect(note).toContain("WRONG/v0"); // includes the rejected draft to anchor the fix
  });

  it("feeds a rejected draft's findings into the planner's NEXT revision (repair loop actually repairs)", async () => {
    const outSchema = objSchema({ ok: { type: "boolean" } }, ["ok"]);
    const validLwir = {
      apiVersion: "littleworkflow.dev/v0.1",
      kind: "Workflow",
      metadata: { name: "repair.test" },
      input: { schema: true },
      output: { schema: outSchema },
      permissions: { tools: [], models: ["model.worker"], secrets: [], network: [] },
      steps: [{ id: "gen", uses: "ai.generate", input: "{{ input }}", with: { model: "model.worker" }, output: { mode: "object", schema: outSchema } }],
    };
    const invalidLwir = { apiVersion: "WRONG/v0", kind: "NotAWorkflow", steps: "not-an-array" };
    const systemMessages: string[] = [];
    const capturingHarness = {
      harnessId: "capture@1.0.0",
      async run(task: { readonly systemMessage?: string }) {
        systemMessages.push(String(task.systemMessage ?? ""));
        return { kind: "plan" as const, lwir: systemMessages.length === 1 ? invalidLwir : validLwir };
      },
    };
    const wf = createLittleWorkflow({
      id: "repair.test",
      description: "test repair feedback",
      output: output.object({ schema: outSchema }),
      models: [workerSlot],
      planner: { model: { provider: "test", modelId: "p" }, harness: capturingHarness },
    } as unknown as Parameters<typeof createLittleWorkflow>[0]);

    const result = await compileWorkflow(wf, { input: {}, requestId: "orq_repair", maxWorkflowRevisions: 3 });

    // The planner was re-invoked for revision 2 (not replayed), and that prompt carried
    // the revision-1 findings so the model could correct them.
    expect(systemMessages.length).toBeGreaterThanOrEqual(2);
    expect(systemMessages[1]).toContain("REJECTED");
    expect(systemMessages[1]).toMatch(/apiVersion|steps/);
    // Compiled on the corrected revision 2 — not the deterministic fallback.
    expect(result.revisions).toHaveLength(2);
    expect(result.revisions[1].valid).toBe(true);
  });

  it("compiles a tool-registering workflow via the planner (synthesis is gated out; capabilities still wired)", async () => {
    const outSchema = objSchema({ ok: { type: "boolean" } }, ["ok"]);
    const plannerLwir = {
      apiVersion: "littleworkflow.dev/v0.1",
      kind: "Workflow",
      metadata: { name: "with.tool" },
      input: { schema: true },
      output: { schema: outSchema },
      permissions: { tools: ["lookup"], models: ["model.worker"], secrets: [], network: [] },
      steps: [
        { id: "look", uses: "tool.call", with: { tool: "lookup", args: {} }, output: { mode: "json", schema: true } },
        { id: "gen", uses: "ai.generate", needs: ["look"], input: "{{ input }}", with: { model: "model.worker" }, output: { mode: "object", schema: outSchema } },
      ],
    };
    const planner = capturingPlanner(plannerLwir);
    const tools = createToolRegistry({
      lookup: { description: "look up", inputSchema: { type: "object", additionalProperties: true }, execute: async () => ({}) },
    });
    const wf = createLittleWorkflow({
      id: "with.tool",
      description: "do a thing with a tool",
      output: output.object({ schema: outSchema }),
      models: [workerSlot],
      globalTools: ["lookup"],
      planner: planner.config,
    } as unknown as Parameters<typeof createLittleWorkflow>[0]);

    const result = await compileWorkflow(wf, { input: {}, tools, requestId: "orq_planner_tool" });
    expect(result.workflowVersion).toBeDefined();
    expect(result.revisions).toHaveLength(1); // planner succeeded; nothing to fall back to
    // capability context lists the tool + model AND now includes a valid LWIR skeleton
    // (tool.call -> ai.generate) so the planner is never left to author the format blind.
    expect(planner.calls[0].systemMessage).toContain("lookup");
    expect(planner.calls[0].systemMessage).toContain("model.worker");
    expect(planner.calls[0].systemMessage).toContain("LWIR skeleton");
    expect(planner.calls[0].systemMessage).toContain("littleworkflow.dev/v0.1");
    expect(planner.calls[0].systemMessage).toContain("tool.call");
  });

  it("defaults a missing planner harness to workflowHarness identity in the planner manifest", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "little-workflow-default-planner-harness-"));
    const world = localWorld({ dataDir });
    const wf = createLittleWorkflow({
      id: "default.planner.harness",
      description: "compile with the default planner harness",
      output: output.text(),
      models: [workerSlot],
      planner: { model: { provider: "test", modelId: "planner" } },
    } as unknown as Parameters<typeof createLittleWorkflow>[0]);

    try {
      await expect(compileWorkflow(wf, {
        input: { text: "x" },
        requestId: "orq_default_planner_harness",
        plannerHarnessRuntime: {
          world,
          runId: "run_default_planner_harness",
          logDir: join(dataDir, "logs"),
          memoryMounts: [],
          scratchMounts: [],
          skills: [],
        },
      })).rejects.toThrow(/Unsupported model version|model/u);

      const events = await world.listEvents("run_default_planner_harness");
      const started = events.find((event) => event.type === "harness.session.started");
      expect(started?.payload.manifest).toMatchObject({
        harnessId: "workflowHarness@1.0.0",
      });
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("keeps planner runtime bash cwd at own scratch when skills are present", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "little-workflow-planner-runtime-skill-cwd-"));
    const world = localWorld({ dataDir });
    const skillDir = join(dataDir, "skills", "planner-guide");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      "---\nname: planner-guide\ndescription: Inspect planner runtime cwd.\n---\n\nUse this skill.\n",
      "utf8",
    );
    const [plannerSkill] = await resolveSkills([skill(skillDir)], { baseDir: dataDir });
    const wf = createLittleWorkflow({
      id: "planner.runtime.skill.cwd",
      description: "compile with planner runtime skills",
      outputSchema: true,
      models: [workerSlot],
      planner: {
        model: { provider: "test", modelId: "planner" },
        harness: {
          harnessId: "skillCwdPlanner@1.0.0",
          async run(task, ctx) {
            if (task.kind !== "plan") {
              return { kind: "delegate_to_default" as const };
            }
            await expect(ctx.bash?.execute({ cmd: "pwd" })).resolves.toMatchObject({
              exitCode: 0,
              stdout: "/mnt/scratch/own\n",
            });
            await expect(ctx.bash?.execute({ cmd: "cat .agents/skills/planner-guide/SKILL.md" })).resolves.toMatchObject({
              exitCode: 0,
              stdout: expect.stringContaining("name: planner-guide"),
            });
            return {
              kind: "plan" as const,
              lwir: {
                apiVersion: "littleworkflow.dev/v0.1",
                kind: "Workflow",
                metadata: { name: "planner.runtime.skill.cwd" },
                input: { schema: true },
                output: { schema: true },
                permissions: { tools: [], models: [], secrets: [], network: [] },
                steps: [],
              },
            };
          },
        } satisfies Harness & { readonly harnessId: string },
      },
    } as unknown as Parameters<typeof createLittleWorkflow>[0]);

    try {
      const result = await compileWorkflow(wf, {
        input: { text: "x" },
        requestId: "orq_planner_runtime_skill_cwd",
        plannerHarnessRuntime: {
          world,
          runId: "run_planner_runtime_skill_cwd",
          logDir: join(dataDir, "logs"),
          memoryMounts: [],
          scratchMounts: [{
            mountPath: "/mnt/scratch/own/",
            backingPath: join(dataDir, "scratch", "own"),
            mode: "rw",
          }],
          skills: [plannerSkill!],
        },
      });

      expect(result.workflowVersion.lwir).toMatchObject({
        metadata: { name: "planner.runtime.skill.cwd" },
      });
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("falls back to workflowHarness when a planner harness delegates", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "little-workflow-delegated-planner-harness-"));
    const world = localWorld({ dataDir });
    const wf = createLittleWorkflow({
      id: "delegated.planner.harness",
      description: "compile through delegated planner harness",
      output: output.text(),
      models: [workerSlot],
      planner: {
        model: { provider: "test", modelId: "planner" },
        harness: {
          harnessId: "delegatingPlanner@1.0.0",
          async run() {
            return { kind: "delegate_to_default" as const };
          },
        },
      },
    } as unknown as Parameters<typeof createLittleWorkflow>[0]);

    try {
      await expect(compileWorkflow(wf, {
        input: { text: "x" },
        requestId: "orq_delegated_planner_harness",
        plannerHarnessRuntime: {
          world,
          runId: "run_delegated_planner_harness",
          logDir: join(dataDir, "logs"),
          memoryMounts: [],
          scratchMounts: [],
          skills: [],
        },
      })).rejects.toThrow(/Unsupported model version|model/u);

      const sessionHarnessIds = (await world.listEvents("run_delegated_planner_harness"))
        .filter((event) => event.type === "harness.session.started")
        .map((event) => (event.payload.manifest as { harnessId?: string } | undefined)?.harnessId);
      expect(sessionHarnessIds).toContain("delegatingPlanner@1.0.0");
      expect(sessionHarnessIds).toContain("workflowHarness@1.0.0");
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("drift-checks planner harness manifests when compiling with a runtime recorder", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "little-workflow-planner-manifest-drift-"));
    const world = localWorld({ dataDir });
    const outSchema = objSchema({ ok: { type: "boolean" } }, ["ok"]);
    const plannerLwir = {
      apiVersion: "littleworkflow.dev/v0.1",
      kind: "Workflow",
      metadata: { name: "planner.manifest.drift" },
      input: { schema: true },
      output: { schema: outSchema },
      permissions: { tools: [], models: ["model.worker"], secrets: [], network: [] },
      steps: [{
        id: "gen",
        uses: "ai.generate",
        with: { model: "model.worker" },
        output: { mode: "object", schema: outSchema },
      }],
    };
    const wf = createLittleWorkflow({
      id: "planner.manifest.drift",
      description: "compile with a drifted planner harness manifest",
      output: output.object({ schema: outSchema }),
      models: [workerSlot],
      planner: {
        model: { provider: "test", modelId: "planner" },
        harness: {
          harnessId: "currentPlanner@1.0.0",
          async run() {
            return { kind: "plan" as const, lwir: plannerLwir };
          },
        },
      },
    } as unknown as Parameters<typeof createLittleWorkflow>[0]);
    const storedManifest = plannerManifest({
      harnessId: "stalePlanner@1.0.0",
      plannerModelSlotId: "planner",
      workflowDefinitionHash: "sha256:stale",
    });

    try {
      await world.appendEvent("run_planner_manifest_drift", {
        type: "harness.session.started" as never,
        payload: {
          runId: "run_planner_manifest_drift",
          role: "planner",
          task: { kind: "plan" },
          manifest: storedManifest,
          manifestHash: hashHarnessManifest(storedManifest),
        },
      });

      await expect(compileWorkflow(wf, {
        input: { text: "x" },
        requestId: "orq_planner_manifest_drift",
        plannerHarnessRuntime: {
          world,
          runId: "run_planner_manifest_drift",
          logDir: join(dataDir, "logs"),
          memoryMounts: [],
          scratchMounts: [],
          skills: [],
        },
      })).rejects.toMatchObject({ name: "CapabilityDriftError" });
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
