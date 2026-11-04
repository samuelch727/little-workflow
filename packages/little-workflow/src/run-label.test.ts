import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it, expect, vi } from "vitest";
import { resolveRunLabel } from "./runtime.js";
import {
  createToolRegistry,
  localWorld,
  output,
  runOrchestration,
  model,
} from "./index.js";
import type {
  SuperviseDecision,
} from "./index.js";
import type {
  LwirWorkflow,
} from "./entries/lwir.js";
import {
  createLittleWorkflow,
  listEvents,
  runWorkflowCycle,
} from "./entries/internals.js";
import type {
  Harness,
} from "./entries/internals.js";
import { runWorkflowWithLegacyPlannerAdapter } from "./runtime.js";
import type { PlannerAdapter } from "./compiler.js";
import { cleanupTempDirs, workerScopedTempPrefix } from "./test-temp.js";

const tempDirs: string[] = [];

async function tempWorld() {
  const dataDir = await mkdtemp(
    join(
      tmpdir(),
      workerScopedTempPrefix("little-workflow-run-label-", process.env.VITEST_POOL_ID),
    ),
  );
  tempDirs.push(dataDir);
  return localWorld({ dataDir });
}

afterEach(async () => {
  await cleanupTempDirs(tempDirs);
});

const workerModel = model(
  { provider: "test", modelId: "worker-model" },
  { description: "Worker model for label tests." },
);

const inputSchema = {
  type: "object",
  required: ["value"],
  additionalProperties: false,
  properties: { value: { type: "string" } },
};

const outputSchema = {
  type: "object",
  required: ["result"],
  additionalProperties: false,
  properties: { result: { type: "string" } },
};

const toolRegistry = createToolRegistry();
toolRegistry.register("echo", {
  description: "Echo input.",
  inputSchema,
  execute: async (input) => ({ result: (input as { value: string }).value }),
});

const labelWorkflow = createLittleWorkflow({
  id: "label-test.workflow",
  description: "Workflow for label/tag testing.",
  inputSchema,
  output: output.object({ schema: outputSchema }),
  models: [workerModel],
  globalTools: ["echo"],
} as unknown as Parameters<typeof createLittleWorkflow>[0]);

function echoLwir(): LwirWorkflow {
  return {
    apiVersion: "littleworkflow.dev/v0.1",
    kind: "Workflow",
    metadata: {
      name: "label-test.workflow",
      version: "0.1.0-alpha",
      description: "Workflow for label/tag testing.",
    },
    input: { schema: inputSchema },
    output: { schema: outputSchema },
    permissions: { tools: ["echo"], models: [], secrets: [], network: [] },
    steps: [
      {
        id: "echo",
        uses: "tool.call",
        with: { tool: "echo" },
        input: { value: "{{ input.value }}" },
        output: { mode: "object", schema: outputSchema },
      },
    ],
  };
}

function plannerFor(lwir: LwirWorkflow): PlannerAdapter {
  return { draft: vi.fn(async () => lwir) };
}

describe("run label resolution", () => {
  it("prefers the per-run override, then the definition label, then the id", () => {
    expect(resolveRunLabel({ runLabel: "nightly", defLabel: "screener", id: "wf1" })).toBe("nightly");
    expect(resolveRunLabel({ runLabel: undefined, defLabel: "screener", id: "wf1" })).toBe("screener");
    expect(resolveRunLabel({ runLabel: undefined, defLabel: undefined, id: "wf1" })).toBe("wf1");
  });
});

describe("RunStarted label/tags stamp", () => {
  it("stamps per-run label and tags into the RunStarted event payload", async () => {
    const world = await tempWorld();
    const result = await runWorkflowWithLegacyPlannerAdapter({
      world,
      workflows: labelWorkflow,
      input: { value: "hello" },
      planner: plannerFor(echoLwir()),
      tools: toolRegistry,
      label: "nightly",
      tags: ["exp"],
    });

    const events = await listEvents(world, result.runId);
    const runStarted = events.find((e) => e.type === "RunStarted");
    expect(runStarted).toBeDefined();
    expect(runStarted?.payload.label).toBe("nightly");
    expect(runStarted?.payload.tags).toContain("exp");
  });

  it("defaults label to the workflow id when no per-run label or definition label is set", async () => {
    const world = await tempWorld();
    const result = await runWorkflowWithLegacyPlannerAdapter({
      world,
      workflows: labelWorkflow,
      input: { value: "hello" },
      planner: plannerFor(echoLwir()),
      tools: toolRegistry,
      // no label or tags
    });

    const events = await listEvents(world, result.runId);
    const runStarted = events.find((e) => e.type === "RunStarted");
    expect(runStarted).toBeDefined();
    expect(runStarted?.payload.label).toBe("label-test.workflow");
    expect(runStarted?.payload.tags).toEqual([]);
  });
});

describe("RunStarted label/tags — outer-loop path", () => {
  it("stamps label and tags into the first cycle's RunStarted when using outer-loop mode", async () => {
    const world = await tempWorld();
    const decisions: SuperviseDecision[] = [
      { kind: "done", finalOutput: { result: "nightly-done" } },
    ];
    let decisionIndex = 0;
    const outerLoopPlanner: PlannerAdapter = {
      draft: vi.fn(async () => echoLwir()),
      supervise: vi.fn(async () => {
        const d = decisions[decisionIndex++];
        if (d === undefined) {
          throw new Error(`supervise called more times than expected`);
        }
        return d;
      }),
    };

    const result = await runWorkflowWithLegacyPlannerAdapter({
      world,
      workflows: labelWorkflow,
      input: { value: "hello" },
      planner: outerLoopPlanner,
      tools: toolRegistry,
      maxOuterCycles: 2,
      label: "nightly",
      tags: ["exp"],
    });

    // The result runId is the final cycle's runId.
    const events = await listEvents(world, result.runId);
    const runStarted = events.find((e) => e.type === "RunStarted");
    expect(runStarted).toBeDefined();
    expect(runStarted?.payload.label).toBe("nightly");
    expect(runStarted?.payload.tags).toContain("exp");
  });
});

describe("RunStarted label/tags — orchestration path", () => {
  it("stamps label and tags into the top-level RunStarted for an orchestrated (array) run", async () => {
    const world = await tempWorld();
    let subRunId: string | undefined;

    const plannerHarness: Harness = {
      run: async (task) => {
        if (task.kind !== "plan") {
          return { kind: "delegate_to_default" };
        }
        return { kind: "plan", lwir: echoLwir() };
      },
    };
    const orchestratorHarness: Harness = {
      run: async (task, ctx) => {
        if (task.kind !== "orchestrate") {
          return { kind: "delegate_to_default" };
        }
        const planTool = ctx.tools.plan_workflow as { execute?: (input: unknown) => Promise<unknown> };
        const runTool = ctx.tools.run_workflow as { execute?: (input: unknown) => Promise<unknown> };
        const planned = await planTool.execute?.({ workflowId: "label-test.workflow", input: { value: "hello" } }) as { workflowVersionId: string };
        const runResult = await runTool.execute?.({ workflowVersionId: planned.workflowVersionId, input: { value: "hello" } });
        subRunId = (runResult as { runId?: string } | undefined)?.runId;
        return { kind: "orchestrate", output: runResult };
      },
    };

    const workflowForOrchestration = createLittleWorkflow({
      id: "label-test.workflow",
      description: "Workflow for label/tag testing.",
      inputSchema,
      output: output.object({ schema: outputSchema }),
      models: [workerModel],
      globalTools: ["echo"],
      planner: {
        model: { provider: "test", modelId: "planner-model" },
        harness: plannerHarness,
      },
    } as unknown as Parameters<typeof createLittleWorkflow>[0]);

    const orchRunId = "run_label_orchestration_test";
    await runOrchestration({
      world,
      workflows: [workflowForOrchestration],
      orchestrator: {
        model: { provider: "test", modelId: "orchestrator-model" },
        harness: orchestratorHarness,
      },
      input: { value: "hello" },
      tools: toolRegistry,
      runId: orchRunId,
      label: "nightly",
      tags: ["exp"],
    });

    const events = await listEvents(world, orchRunId);
    const runStarted = events.find((e) => e.type === "RunStarted");
    expect(runStarted).toBeDefined();
    expect(runStarted?.payload.label).toBe("nightly");
    expect(runStarted?.payload.tags).toContain("exp");

    expect(subRunId).toBeDefined();
    const subRunEvents = await listEvents(world, subRunId!);
    const subRunStarted = subRunEvents.find((e) => e.type === "RunStarted");
    expect(subRunStarted).toBeDefined();
    expect(subRunStarted?.payload.parentRunId).toBe(orchRunId);
  });

  it("stamps parentRunId into failed sub-run RunStarted events", async () => {
    const world = await tempWorld();
    const runId = "run_failed_child_start";
    const parentRunId = "run_failed_parent";

    await expect(runWorkflowCycle({
      world,
      workflow: labelWorkflow,
      input: { value: 123 },
      planner: plannerFor(echoLwir()),
      tools: toolRegistry,
      runId,
      parentRunId,
    })).rejects.toThrow();

    const events = await listEvents(world, runId);
    const runStarted = events.find((e) => e.type === "RunStarted");
    expect(runStarted).toBeDefined();
    expect(runStarted?.payload.parentRunId).toBe(parentRunId);
  });
});

describe("RunStarted trigger", () => {
  const trigger = { kind: "api", source: "POST /labels", from: "ops@example.com" };

  it("records the run's trigger on its RunStarted, and a rerun of the run keeps that one RunStarted", async () => {
    const world = await tempWorld();
    const runId = "run_trigger_rerun";
    const options = {
      world,
      workflows: labelWorkflow,
      input: { value: "hello" },
      planner: plannerFor(echoLwir()),
      tools: toolRegistry,
      runId,
      trigger,
    };
    const first = await runWorkflowWithLegacyPlannerAdapter(options);
    const again = await runWorkflowWithLegacyPlannerAdapter(options);

    expect(again.output).toEqual(first.output);
    const started = (await listEvents(world, runId)).filter((e) => e.type === "RunStarted");
    expect(started).toHaveLength(1);
    expect(started[0]?.payload.trigger).toEqual(trigger);
    expect(started[0]?.payload.label).toBe("label-test.workflow");
  });

  it("leaves RunStarted without a trigger when the run has none", async () => {
    const world = await tempWorld();
    const result = await runWorkflowWithLegacyPlannerAdapter({
      world,
      workflows: labelWorkflow,
      input: { value: "hello" },
      planner: plannerFor(echoLwir()),
      tools: toolRegistry,
    });
    const runStarted = (await listEvents(world, result.runId)).find((e) => e.type === "RunStarted");
    expect(runStarted?.payload).not.toHaveProperty("trigger");
  });

  it("records it on a run that fails before it starts", async () => {
    const world = await tempWorld();
    const runId = "run_trigger_bad_input";
    await expect(runWorkflowWithLegacyPlannerAdapter({
      world,
      workflows: labelWorkflow,
      input: { value: 123 } as never,
      planner: plannerFor(echoLwir()),
      tools: toolRegistry,
      runId,
      trigger,
    })).rejects.toThrow();
    const runStarted = (await listEvents(world, runId)).find((e) => e.type === "RunStarted");
    expect(runStarted?.payload.trigger).toEqual(trigger);
  });

  it("keeps a World's maxConcurrentSteps shared by runs that each have a trigger", async () => {
    const world = localWorld({ dataDir: (await tempWorld()).dataDir, maxConcurrentSteps: 1 });
    let running = 0;
    let most = 0;
    const slowTools = createToolRegistry();
    slowTools.register("echo", {
      description: "Echo input, slowly.",
      inputSchema,
      execute: async (input) => {
        running += 1;
        most = Math.max(most, running);
        await new Promise((resolve) => setTimeout(resolve, 50));
        running -= 1;
        return { result: (input as { value: string }).value };
      },
    });
    await Promise.all(["a", "b"].map((value) => runWorkflowWithLegacyPlannerAdapter({
      world,
      workflows: labelWorkflow,
      input: { value },
      planner: plannerFor(echoLwir()),
      tools: slowTools,
      trigger,
    })));
    expect(most).toBe(1);
  });

  it("gives an orchestrated run the trigger and its sub-runs only parentRunId", async () => {
    const world = await tempWorld();
    let subRunId: string | undefined;
    const plannerHarness: Harness = {
      run: async (task) => (task.kind === "plan" ? { kind: "plan", lwir: echoLwir() } : { kind: "delegate_to_default" }),
    };
    const orchestratorHarness: Harness = {
      run: async (task, ctx) => {
        if (task.kind !== "orchestrate") return { kind: "delegate_to_default" };
        const planTool = ctx.tools.plan_workflow as { execute?: (input: unknown) => Promise<unknown> };
        const runTool = ctx.tools.run_workflow as { execute?: (input: unknown) => Promise<unknown> };
        const planned = await planTool.execute?.({ workflowId: "label-test.workflow", input: { value: "hello" } }) as { workflowVersionId: string };
        const runResult = await runTool.execute?.({ workflowVersionId: planned.workflowVersionId, input: { value: "hello" } });
        subRunId = (runResult as { runId?: string } | undefined)?.runId;
        return { kind: "orchestrate", output: runResult };
      },
    };
    const workflowForOrchestration = createLittleWorkflow({
      id: "label-test.workflow",
      description: "Workflow for label/tag testing.",
      inputSchema,
      output: output.object({ schema: outputSchema }),
      models: [workerModel],
      globalTools: ["echo"],
      planner: { model: { provider: "test", modelId: "planner-model" }, harness: plannerHarness },
    } as unknown as Parameters<typeof createLittleWorkflow>[0]);

    const orchRunId = "run_trigger_orchestration";
    await runOrchestration({
      world,
      workflows: [workflowForOrchestration],
      orchestrator: { model: { provider: "test", modelId: "orchestrator-model" }, harness: orchestratorHarness },
      input: { value: "hello" },
      tools: toolRegistry,
      runId: orchRunId,
      trigger,
    });

    const runStarted = (await listEvents(world, orchRunId)).find((e) => e.type === "RunStarted");
    expect(runStarted?.payload.trigger).toEqual(trigger);
    expect(subRunId).toBeDefined();
    const subRunStarted = (await listEvents(world, subRunId!)).find((e) => e.type === "RunStarted");
    expect(subRunStarted?.payload.parentRunId).toBe(orchRunId);
    expect(subRunStarted?.payload).not.toHaveProperty("trigger");
  });
});
