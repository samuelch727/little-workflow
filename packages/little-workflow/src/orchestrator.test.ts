import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLittleWorkflow, localWorld, model } from "./authoring.js";
import type { CompilableWorkflowDefinition } from "./compiler.js";
import type { Harness } from "./harness/types.js";
import {
  createOrchestratorTools,
  workflowSnapshotsForOrchestrator,
} from "./orchestrator.js";
import { getWorkflowDefinitionHash } from "./workflow-definition-hash.js";

const tempDirs: string[] = [];

const testHarness: Harness = {
  async run() {
    return { kind: "plan", lwir: { apiVersion: "littleworkflow.dev/v0.1" } };
  },
};

const testModel = model(
  { provider: "test", modelId: "worker" },
  { id: "model.worker" },
);

const testPlanner = {
  model: { provider: "test", modelId: "planner" },
  harness: testHarness,
};

async function tempWorld() {
  const dataDir = await mkdtemp(join(tmpdir(), "little-workflow-orchestrator-"));
  tempDirs.push(dataDir);
  return localWorld({ dataDir });
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function workflow(
  id: string,
  description = `${id} workflow`,
): CompilableWorkflowDefinition {
  return createLittleWorkflow({
    id,
    description,
    inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
    outputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
    models: [testModel],
    planner: testPlanner,
  }) as CompilableWorkflowDefinition;
}

describe("workflowSnapshotsForOrchestrator", () => {
  it("returns sorted workflow snapshots including definition hashes", () => {
    const alpha = workflow("alpha.workflow", "Alpha");
    const zeta = workflow("zeta.workflow", "Zeta");

    const snapshots = workflowSnapshotsForOrchestrator([zeta, alpha]);
    expect(snapshots.map((entry) => entry.id)).toEqual(["alpha.workflow", "zeta.workflow"]);
    expect(snapshots[0]).toMatchObject({
      id: "alpha.workflow",
      description: "Alpha",
    });
    expect(snapshots[0]?.workflowDefinitionHash).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });

  it("includes suggested input schemas in available workflow snapshots", () => {
    const review = createLittleWorkflow({
      id: "candidate.review",
      description: "Candidate review",
      inputSchema: true,
      suggestedInputSchema: {
        type: "object",
        properties: { files: { type: "array" } },
      },
      outputSchema: true,
      models: [testModel],
      planner: testPlanner,
    }) as CompilableWorkflowDefinition & { readonly suggestedInputSchema?: unknown };

    const snapshots = workflowSnapshotsForOrchestrator([review]);

    expect(snapshots[0]).toMatchObject({
      inputSchema: true,
      suggestedInputSchema: {
        type: "object",
        properties: { files: { type: "array" } },
      },
    });
  });
});

describe("createOrchestratorTools", () => {
  it("describes planned workflow tools as reusable for same-shape inputs without stale planner-reviewed wording", async () => {
    const world = await tempWorld();
    const review = workflow("candidate.review");
    const tools = createOrchestratorTools({
      world,
      workflows: [review],
      executeWorkflowVersion: vi.fn(async () => ({
        runId: "subrun_description",
        status: "completed" as const,
      })),
    });

    expect(tools.plan_workflow.description).toContain("representative workflow input");
    expect(tools.plan_workflow.description).not.toContain("until planner-reviewed reuse is implemented");
    expect(tools.run_workflow.description).toContain("input must be structure-compatible");
    expect(tools.run_workflow.description).not.toContain("until planner-reviewed reuse is implemented");
  });

  it("plan_workflow invokes one workflow planner and returns a workflowVersionId", async () => {
    const world = await tempWorld();
    const review = workflow("candidate.review");
    const planWorkflow = vi.fn(async () => ({
      workflowVersion: { id: "wfver_review_v1", lwir: { apiVersion: "littleworkflow.dev/v0.1" } },
    }));
    const executeWorkflowVersion = vi.fn(async () => ({
      runId: "subrun_1",
      status: "completed" as const,
      output: { ok: true },
    }));
    const tools = createOrchestratorTools({
      world,
      workflows: [review],
      planWorkflow,
      executeWorkflowVersion,
      createRunId: () => "subrun_1",
    });

    const result = await tools.plan_workflow.execute?.({
      workflowId: "candidate.review",
      input: { value: "candidate-1" },
    });

    expect(planWorkflow).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ workflowVersionId: "wfver_review_v1" });
  });

  it("run_workflow executes a locked version with a new sub-run id", async () => {
    const world = await tempWorld();
    const review = workflow("candidate.review");
    const planWorkflow = vi.fn(async () => ({
      workflowVersion: { id: "wfver_review_v2", lwir: { apiVersion: "littleworkflow.dev/v0.1" } },
    }));
    const executeWorkflowVersion = vi.fn(async ({ runId }: { runId: string }) => ({
      runId,
      status: "completed" as const,
      output: { reviewed: true },
    }));
    let runNumber = 0;
    const tools = createOrchestratorTools({
      world,
      workflows: [review],
      planWorkflow,
      executeWorkflowVersion,
      createRunId: () => {
        runNumber += 1;
        return `subrun_${runNumber}`;
      },
    });

    await tools.plan_workflow.execute?.({
      workflowId: "candidate.review",
      input: { value: "candidate-2" },
    });

    const run = await tools.run_workflow.execute?.({
      workflowVersionId: "wfver_review_v2",
      input: { value: "candidate-3" },
    });

    expect(executeWorkflowVersion).toHaveBeenCalledTimes(1);
    expect(run).toEqual({
      runId: "subrun_1",
      status: "completed",
      output: { reviewed: true },
    });
  });

  it("recovers a planned WorkflowVersion from durable storage after plan_workflow replay", async () => {
    const world = await tempWorld();
    const review = workflow("candidate.review");
    const storedWorkflowVersion = {
      id: "wfver_review_recovered",
      lwir: { apiVersion: "littleworkflow.dev/v0.1" },
      lock: { workflowDefinitionHash: getWorkflowDefinitionHash(review) },
    };
    const readWorkflowVersion = vi.fn(async () => storedWorkflowVersion);
    const executeWorkflowVersion = vi.fn(async ({ runId, workflow, workflowVersion }: {
      readonly runId: string;
      readonly workflow: CompilableWorkflowDefinition;
      readonly workflowVersion: unknown;
    }) => ({
      runId,
      status: "completed" as const,
      output: {
        workflowId: workflow.id,
        workflowVersion,
      },
    }));
    const tools = createOrchestratorTools({
      world,
      workflows: [review],
      readWorkflowVersion,
      executeWorkflowVersion,
      createRunId: () => "subrun_recovered",
    });

    const run = await tools.run_workflow.execute?.({
      workflowVersionId: "wfver_review_recovered",
      input: { value: "candidate-3" },
    });

    expect(readWorkflowVersion).toHaveBeenCalledWith("wfver_review_recovered");
    expect(executeWorkflowVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        workflow: review,
        workflowVersion: storedWorkflowVersion,
        runId: "subrun_recovered",
        workflowVersionReuse: "structure",
      }),
    );
    expect(run).toEqual({
      runId: "subrun_recovered",
      status: "completed",
      output: {
        workflowId: "candidate.review",
        workflowVersion: storedWorkflowVersion,
      },
    });
  });

  it("run_workflow reuses a durable subRunId supplied by the harness", async () => {
    const world = await tempWorld();
    const review = workflow("candidate.review");
    const planWorkflow = vi.fn(async () => ({
      workflowVersion: { id: "wfver_review_v2", lwir: { apiVersion: "littleworkflow.dev/v0.1" } },
    }));
    const executeWorkflowVersion = vi.fn(async ({ runId }: { runId: string }) => ({
      runId,
      status: "completed" as const,
      output: { reviewed: true },
    }));
    const tools = createOrchestratorTools({
      world,
      workflows: [review],
      planWorkflow,
      executeWorkflowVersion,
      createRunId: () => "subrun_random",
    });

    await tools.plan_workflow.execute?.({
      workflowId: "candidate.review",
      input: { value: "candidate-2" },
    });

    const run = await tools.run_workflow.execute?.({
      workflowVersionId: "wfver_review_v2",
      input: { value: "candidate-3" },
      subRunId: "run_durable_123456",
    });

    expect(executeWorkflowVersion).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run_durable_123456" }),
    );
    expect(run).toEqual({
      runId: "run_durable_123456",
      status: "completed",
      output: { reviewed: true },
    });
  });

  it("passes AI SDK tool abort signals to planner and sub-run delegates", async () => {
    const world = await tempWorld();
    const review = workflow("candidate.review");
    const controller = new AbortController();
    const planWorkflow = vi.fn(async ({ signal }: { readonly signal?: AbortSignal }) => {
      expect(signal).toBe(controller.signal);
      return {
        workflowVersion: { id: "wfver_review_signal", lwir: { apiVersion: "littleworkflow.dev/v0.1" } },
      };
    });
    const executeWorkflowVersion = vi.fn(async ({ runId, signal }: { readonly runId: string; readonly signal?: AbortSignal }) => {
      expect(signal).toBe(controller.signal);
      return {
        runId,
        status: "completed" as const,
        output: { reviewed: true },
      };
    });
    const tools = createOrchestratorTools({
      world,
      workflows: [review],
      planWorkflow,
      executeWorkflowVersion,
      createRunId: () => "subrun_signal",
    });

    await tools.plan_workflow.execute?.(
      { workflowId: "candidate.review", input: { value: "candidate-2" } },
      { abortSignal: controller.signal },
    );
    await tools.run_workflow.execute?.(
      { workflowVersionId: "wfver_review_signal", input: { value: "candidate-3" } },
      { abortSignal: controller.signal },
    );

    expect(planWorkflow).toHaveBeenCalledTimes(1);
    expect(executeWorkflowVersion).toHaveBeenCalledTimes(1);
  });

  it("stores model-facing sub-run output in mounted scratch instead of returning it inline", async () => {
    const world = await tempWorld();
    const review = workflow("candidate.review");
    const output = [
      { candidate_id: "CAND-0001", full_name: "Ada Lovelace", score: 98 },
      { candidate_id: "CAND-0002", full_name: "Grace Hopper", score: 96 },
    ];
    const resultStore = {
      backingDir: join(world.dataDir, "runs", "run_orchestrator", "scratch", "workflow-results"),
      mountDir: "/mnt/scratch/own/workflow-results",
    };
    const tools = createOrchestratorTools({
      world,
      workflows: [review],
      planWorkflow: vi.fn(async () => ({
        workflowVersion: { id: "wfver_review_compact", lwir: { apiVersion: "littleworkflow.dev/v0.1" } },
      })),
      executeWorkflowVersion: vi.fn(async ({ runId }: { runId: string }) => ({
        runId,
        status: "completed" as const,
        output,
        outputRef: "artifact://art_candidates" as const,
        artifacts: ["artifact://art_candidates" as const],
      })),
      createRunId: () => "subrun_1",
      resultStore,
    });

    await tools.plan_workflow.execute?.({
      workflowId: "candidate.review",
      input: { value: "seed" },
    });

    const run = await tools.run_workflow.execute?.(
      {
        workflowVersionId: "wfver_review_compact",
        input: { value: "batch" },
      },
      { caller: "model" },
    );

    expect(run).toMatchObject({
      runId: "subrun_1",
      status: "completed",
      outputRef: "artifact://art_candidates",
      outputPath: "/mnt/scratch/own/workflow-results/subrun_1/output.json",
      outputSummary: {
        kind: "array",
        itemCount: 2,
        sizeBytes: expect.any(Number),
        sha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      },
      artifacts: ["artifact://art_candidates"],
    });
    expect(run).not.toHaveProperty("output");
    await expect(
      readFile(join(resultStore.backingDir, "subrun_1", "output.json"), "utf8")
        .then((text) => JSON.parse(text) as unknown),
    ).resolves.toEqual(output);
  });

  it("run_workflow executes planned versions with structure-compatible reuse", async () => {
    const world = await tempWorld();
    const review = workflow("candidate.review", "Candidate review");
    const planWorkflow = vi.fn(async () => ({
      workflowVersion: { id: "wfver_review_policy", lwir: { apiVersion: "littleworkflow.dev/v0.1" } },
    }));
    const executeWorkflowVersion = vi.fn(async () => ({
      runId: "subrun_policy",
      status: "completed" as const,
      output: { reviewed: true },
    }));
    const tools = createOrchestratorTools({
      world,
      workflows: [review],
      planWorkflow,
      executeWorkflowVersion,
      createRunId: () => "subrun_policy",
    });

    await tools.plan_workflow.execute?.({
      workflowId: "candidate.review",
      input: { value: "candidate-1" },
    });
    await tools.run_workflow.execute?.({
      workflowVersionId: "wfver_review_policy",
      input: { value: "candidate-2" },
    });

    expect(executeWorkflowVersion).toHaveBeenCalledWith(
      expect.objectContaining({ workflowVersionReuse: "structure" }),
    );
  });

  it("run_workflow ignores legacy call-level reuse policy", async () => {
    const world = await tempWorld();
    const review = workflow("candidate.review", "Candidate review");
    const planWorkflow = vi.fn(async () => ({
      workflowVersion: { id: "wfver_review_override", lwir: { apiVersion: "littleworkflow.dev/v0.1" } },
    }));
    const executeWorkflowVersion = vi.fn(async () => ({
      runId: "subrun_override",
      status: "completed" as const,
      output: { reviewed: true },
    }));
    const tools = createOrchestratorTools({
      world,
      workflows: [review],
      // @ts-expect-error old deterministic policy is no longer part of the orchestrator API.
      workflowVersionReuse: "exact",
      planWorkflow,
      executeWorkflowVersion,
      createRunId: () => "subrun_override",
    });

    await tools.plan_workflow.execute?.({
      workflowId: "candidate.review",
      input: { value: "candidate-1" },
    });
    await tools.run_workflow.execute?.({
      workflowVersionId: "wfver_review_override",
      input: { value: "candidate-2" },
    });

    expect(executeWorkflowVersion).toHaveBeenCalledWith(
      expect.objectContaining({ workflowVersionReuse: "structure" }),
    );
  });

  it("start_workflow delegates to plan then run", async () => {
    const world = await tempWorld();
    const review = workflow("candidate.review");
    const planWorkflow = vi.fn(async () => ({
      workflowVersion: { id: "wfver_review_v3", lwir: { apiVersion: "littleworkflow.dev/v0.1" } },
    }));
    const executeWorkflowVersion = vi.fn(async ({ runId }: { runId: string }) => ({
      runId,
      status: "completed" as const,
      output: { final: true },
    }));
    const tools = createOrchestratorTools({
      world,
      workflows: [review],
      planWorkflow,
      executeWorkflowVersion,
      createRunId: () => "subrun_start_1",
    });

    const result = await tools.start_workflow.execute?.({
      workflowId: "candidate.review",
      input: { value: "candidate-4" },
    });

    expect(planWorkflow).toHaveBeenCalledTimes(1);
    expect(executeWorkflowVersion).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      workflowVersionId: "wfver_review_v3",
      runId: "subrun_start_1",
      status: "completed",
      output: { final: true },
    });
  });

  it("rejects unknown workflow ids", async () => {
    const world = await tempWorld();
    const review = workflow("candidate.review");
    const tools = createOrchestratorTools({
      world,
      workflows: [review],
      planWorkflow: vi.fn(async () => ({
        workflowVersion: { id: "wfver_review_v4", lwir: { apiVersion: "littleworkflow.dev/v0.1" } },
      })),
      executeWorkflowVersion: vi.fn(async () => ({
        runId: "subrun_unknown",
        status: "completed" as const,
        output: { ok: true },
      })),
    });

    await expect(tools.plan_workflow.execute?.({
      workflowId: "candidate.scoring",
      input: { value: "candidate-5" },
    })).rejects.toThrow(/Unknown workflow id/u);
  });

  it("queues sub-runs beyond maxConcurrentSubRuns", async () => {
    const world = await tempWorld();
    const review = workflow("candidate.review");
    const planWorkflow = vi.fn(async () => ({
      workflowVersion: { id: "wfver_review_v5", lwir: { apiVersion: "littleworkflow.dev/v0.1" } },
    }));
    let active = 0;
    let peak = 0;
    const executeWorkflowVersion = vi.fn(async ({ runId }: { runId: string }) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 25));
      active -= 1;
      return {
        runId,
        status: "completed" as const,
        output: { ok: true, runId },
      };
    });

    let runNumber = 0;
    const tools = createOrchestratorTools({
      world,
      workflows: [review],
      planWorkflow,
      executeWorkflowVersion,
      maxConcurrentSubRuns: 2,
      createRunId: () => {
        runNumber += 1;
        return `subrun_q_${runNumber}`;
      },
    });

    await tools.plan_workflow.execute?.({
      workflowId: "candidate.review",
      input: { value: "seed" },
    });

    await Promise.all(
      [1, 2, 3, 4, 5].map(() =>
        tools.run_workflow.execute?.({
          workflowVersionId: "wfver_review_v5",
          input: { value: "batch" },
        })),
    );

    expect(peak).toBeLessThanOrEqual(2);
    expect(executeWorkflowVersion).toHaveBeenCalledTimes(5);
  });
});
