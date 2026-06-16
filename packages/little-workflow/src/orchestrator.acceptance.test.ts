import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLittleWorkflow,
  createToolRegistry,
  listEvents,
  localWorld,
  model,
  output,
  runWorkflow,
} from "./index.js";
import type { Harness, LwirWorkflow } from "./index.js";

const tempDirs: string[] = [];

async function tempWorld() {
  const dataDir = await mkdtemp(join(tmpdir(), "little-workflow-orchestrator-acceptance-"));
  tempDirs.push(dataDir);
  return localWorld({ dataDir });
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const candidateInputSchema = {
  type: "object",
  required: ["candidateId"],
  additionalProperties: false,
  properties: {
    candidateId: { type: "string" },
  },
};

const candidateOutputSchema = {
  type: "object",
  required: ["candidateId"],
  additionalProperties: false,
  properties: {
    candidateId: { type: "string" },
  },
};

const candidateWorkerModel = model(
  { provider: "test", modelId: "candidate-worker-model" },
  { description: "Candidate worker model for orchestrator acceptance tests." },
);

function candidateReviewLwir(): LwirWorkflow {
  return {
    apiVersion: "littleworkflow.dev/v0.1",
    kind: "Workflow",
    metadata: {
      name: "candidate.review",
      version: "0.1.0-alpha",
      description: "Review a single candidate.",
    },
    input: { schema: candidateInputSchema },
    output: { schema: candidateOutputSchema },
    permissions: { tools: ["emitCandidate"], models: [], secrets: [], network: [] },
    steps: [
      {
        id: "emitCandidate",
        uses: "tool.call",
        with: { tool: "emitCandidate" },
        input: { candidateId: "{{ input.candidateId }}" },
        output: { mode: "object", schema: candidateOutputSchema },
      },
    ],
  };
}

describe("orchestrator fan-out acceptance", () => {
  it("plans once and runs 50 structure-compatible sub-runs via run_workflow with bounded concurrency", async () => {
    const world = await tempWorld();
    const plannerHarness = {
      harnessId: "plannerHarness@1.0.0",
      run: vi.fn<Harness["run"]>(async (task) => {
        if (task.kind !== "plan") {
          return { kind: "delegate_to_default" };
        }
        return { kind: "plan", lwir: candidateReviewLwir() };
      }),
    } satisfies Harness & { readonly harnessId: string };

    let activeToolCalls = 0;
    let peakToolCalls = 0;
    const toolRegistry = createToolRegistry();
    toolRegistry.register("emitCandidate", {
      description: "Return candidate output payload.",
      inputSchema: candidateInputSchema,
      execute: async (input) => {
        activeToolCalls += 1;
        peakToolCalls = Math.max(peakToolCalls, activeToolCalls);
        await new Promise((resolve) => setTimeout(resolve, 10));
        activeToolCalls -= 1;
        return input;
      },
    });

    const orchestratorHarness = {
      harnessId: "orchestratorHarness@1.0.0",
      run: vi.fn<Harness["run"]>(async (task, ctx) => {
        if (task.kind !== "orchestrate") {
          return { kind: "delegate_to_default" };
        }
        const plan = ctx.tools.plan_workflow as { execute?: (input: unknown) => Promise<unknown> };
        const run = ctx.tools.run_workflow as { execute?: (input: unknown) => Promise<unknown> };
        if (typeof plan?.execute !== "function" || typeof run?.execute !== "function") {
          throw new Error("orchestrator tools were not injected.");
        }
        const executePlan = plan.execute;
        const executeRun = run.execute;

        const candidates = Array.from({ length: 50 }, (_, index) => `candidate-${index + 1}`);
        const planned = await executePlan({
          workflowId: "candidate.review",
          input: { candidateId: candidates[0] },
        }) as { workflowVersionId: string };
        const runs = await Promise.all(
          candidates.map((candidateId) => executeRun({
            workflowVersionId: planned.workflowVersionId,
            input: { candidateId },
          })),
        );
        return {
          kind: "orchestrate",
          output: { workflowVersionId: planned.workflowVersionId, runs },
        };
      }),
    } satisfies Harness & { readonly harnessId: string };

    const candidateWorkflow = createLittleWorkflow({
      id: "candidate.review",
      description: "Review one candidate against criteria.",
      inputSchema: candidateInputSchema,
      output: output.object({ schema: candidateOutputSchema }),
      models: [candidateWorkerModel],
      planner: {
        model: { provider: "test", modelId: "planner-model" },
        harness: plannerHarness,
      },
      workflowVersionReuseStrategy: "planner_reviewed",
      globalTools: ["emitCandidate"],
    });

    const result = await runWorkflow({
      world,
      workflows: [candidateWorkflow],
      orchestrator: {
        model: { provider: "test", modelId: "orchestrator-model" },
        harness: orchestratorHarness,
      },
      input: { batch: "candidate-reviews" },
      tools: toolRegistry,
      maxConcurrentSubRuns: 10,
      runId: "run_orchestrator_fanout_50",
    });

    expect(result.status).toBe("completed");
    const outputPayload = result.output as {
      workflowVersionId: string;
      runs: Array<{
        runId: string;
        status: "completed" | "failed";
        output?: { candidateId: string };
      }>;
    };
    expect(outputPayload.workflowVersionId).toMatch(/^wfver_/u);
    expect(outputPayload.runs).toHaveLength(50);
    expect(outputPayload.runs.every((run) => run.status === "completed")).toBe(true);
    expect(new Set(outputPayload.runs.map((run) => run.runId)).size).toBe(50);
    expect(outputPayload.runs[0]?.output).toEqual({ candidateId: "candidate-1" });
    expect(outputPayload.runs[49]?.output).toEqual({ candidateId: "candidate-50" });
    expect(plannerHarness.run).toHaveBeenCalledTimes(1);
    expect(peakToolCalls).toBeLessThanOrEqual(10);

    const subRunEvents = await Promise.all(
      outputPayload.runs.map((run) => listEvents(world, run.runId)),
    );
    expect(subRunEvents.every((events) => events.some((event) => event.type === "RunCompleted"))).toBe(true);
  }, 120000);
});
