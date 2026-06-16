import { tool } from "ai";
import {
  createWorkflowHarness,
  createLittleWorkflow,
  createToolRegistry,
  localWorld,
  model,
  output,
  runWorkflow,
} from "little-workflow";

const CANDIDATE_COUNT = 30;
const candidates = Array.from({ length: CANDIDATE_COUNT }, (_, index) => `candidate-${index + 1}`);
var callSequence = 0;
let activeToolCalls = 0;
let peakToolCalls = 0;

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
  required: ["candidateId", "label"],
  additionalProperties: false,
  properties: {
    candidateId: { type: "string" },
    label: { type: "string" },
  },
};

const candidateWorkerModel = model(
  { provider: "demo", modelId: "worker-stub" },
  { id: "model.worker", description: "Worker model slot for orchestrator fan-out demo." },
);

const fixedLwir = {
  apiVersion: "littleworkflow.dev/v0.1",
  kind: "Workflow",
  metadata: {
    name: "demo.orchestrator.candidate.review",
    version: "0.1.0-alpha",
    description: "Deterministic candidate review for orchestrator fan-out demo.",
  },
  input: { schema: candidateInputSchema },
  output: { schema: candidateOutputSchema },
  permissions: { tools: ["demo.emitCandidate"], models: [], secrets: [], network: [] },
  steps: [
    {
      id: "emit",
      uses: "tool.call",
      with: { tool: "demo.emitCandidate" },
      input: { candidateId: "{{ input.candidateId }}" },
      output: { mode: "object", schema: candidateOutputSchema },
    },
  ],
};

const plannerHarness = {
  harnessId: "demoPlannerHarness@1.0.0",
  async run(task) {
    if (task.kind !== "plan") {
      return { kind: "delegate_to_default" };
    }
    return { kind: "plan", lwir: fixedLwir };
  },
};

const orchestratorHarness = {
  harnessId: "demoOrchestratorHarness@1.0.0",
  async run(task, ctx) {
    if (task.kind !== "orchestrate") {
      return { kind: "delegate_to_default" };
    }

    const { workflowVersionId } = await invokeOrchestratorTool(
      ctx,
      "plan_workflow",
      {
        workflowId: "demo.orchestrator.candidate.review",
        input: { candidateId: "seed-candidate" },
      },
    );

    const runs = await Promise.all(
      candidates.map((candidateId) =>
        invokeOrchestratorTool(
          ctx,
          "run_workflow",
          {
            workflowVersionId,
            input: { candidateId },
          },
        )),
    );

    return {
      kind: "orchestrate",
      output: {
        workflowVersionId,
        runCount: runs.length,
        runs,
      },
    };
  },
};

const workflow = createLittleWorkflow({
  id: "demo.orchestrator.candidate.review",
  description: "Review one candidate.",
  inputSchema: candidateInputSchema,
  output: output.object({ schema: candidateOutputSchema }),
  models: [candidateWorkerModel],
  planner: {
    model: { provider: "demo", modelId: "planner-stub" },
    harness: plannerHarness,
  },
  globalTools: ["demo.emitCandidate"],
  worker: { harness: createWorkflowHarness() },
});

const tools = createToolRegistry({
  "demo.emitCandidate": tool({
    description: "Return candidate review payload.",
    inputSchema: candidateInputSchema,
    outputSchema: candidateOutputSchema,
    execute: async ({ candidateId }) => {
      activeToolCalls += 1;
      peakToolCalls = Math.max(peakToolCalls, activeToolCalls);
      await new Promise((resolve) => setTimeout(resolve, 15));
      activeToolCalls -= 1;
      return {
        candidateId,
        label: `reviewed:${candidateId}`,
      };
    },
  }),
});

const world = localWorld({
  dataDir: ".little-workflow-demo-orchestrator-fanout",
});
const runId = `run_demo_orchestrator_fanout_${Date.now()}`;

console.log(`# demo-orchestrator-fanout`);
console.log(`Candidates: ${CANDIDATE_COUNT}`);
console.log(`maxConcurrentSubRuns: 10`);
console.log();

const result = await runWorkflow({
  world,
  workflows: [workflow],
  orchestrator: {
    model: { provider: "demo", modelId: "orchestrator-stub" },
    harness: orchestratorHarness,
  },
  input: { batch: "demo" },
  tools,
  maxConcurrentSubRuns: 10,
  runId,
});

if (result.status !== "completed") {
  throw new Error(`Expected completed status, received: ${result.status}`);
}

const outputPayload = result.output;
if (typeof outputPayload !== "object" || outputPayload === null) {
  throw new Error("Expected orchestrator output object.");
}

const runs = Array.isArray(outputPayload.runs) ? outputPayload.runs : [];
if (runs.length !== CANDIDATE_COUNT) {
  throw new Error(`Expected ${CANDIDATE_COUNT} runs, received ${runs.length}.`);
}

const failed = runs.filter((run) => run?.status !== "completed");
if (failed.length > 0) {
  throw new Error(`Expected all sub-runs to complete, found ${failed.length} failures.`);
}
if (new Set(runs.map((run) => run.runId)).size !== CANDIDATE_COUNT) {
  throw new Error("Expected each sub-run to have a unique runId.");
}
const badOutputs = runs.filter((run) => {
  const output = run?.output;
  return (
    output === undefined ||
    output.candidateId !== undefined && typeof output.candidateId !== "string" ||
    output.label !== `reviewed:${output.candidateId}`
  );
});
if (badOutputs.length > 0) {
  throw new Error(`Expected reviewed output payloads for all runs, found ${badOutputs.length} mismatch(es).`);
}
if (peakToolCalls > 10) {
  throw new Error(`Expected peak parallel sub-runs <= 10, observed ${peakToolCalls}.`);
}

const eventTypes = result.events.map((event) => event.type);
const workflowCalls = result.events.filter(
  (event) =>
    event.type === "harness.tool_call.started" &&
    event.payload.toolName === "run_workflow",
);

console.log(`Run ID: ${result.runId}`);
console.log(`Sub-runs completed: ${runs.length}/${CANDIDATE_COUNT}`);
console.log(`run_workflow tool calls: ${workflowCalls.length}`);
console.log(`Peak active sub-run tool calls: ${peakToolCalls}`);
console.log(`Events: ${result.events.length}`);
console.log(`Event types: ${[...new Set(eventTypes)].join(", ")}`);

function executableTool(candidate, name) {
  const execute = candidate?.execute;
  if (typeof execute !== "function") {
    throw new Error(`Missing orchestrator tool execute() for '${name}'.`);
  }
  return execute;
}

async function invokeOrchestratorTool(ctx, toolName, args) {
  const execute = executableTool(ctx.tools[toolName], toolName);
  const callId = `${toolName}_${++callSequence}`;
  const startedAt = Date.now();
  await ctx.recorder.append({
    type: "harness.tool_call.started",
    payload: {
      callId,
      caller: "code",
      toolName,
      args,
    },
  });
  try {
    const result = await execute(args);
    await ctx.recorder.append({
      type: "harness.tool_call.succeeded",
      payload: {
        callId,
        result,
        durationMs: Date.now() - startedAt,
      },
    });
    return result;
  } catch (error) {
    await ctx.recorder.append({
      type: "harness.tool_call.failed",
      payload: {
        callId,
        error: {
          name: error instanceof Error ? error.name : "Error",
          message: error instanceof Error ? error.message : String(error),
        },
        durationMs: Date.now() - startedAt,
      },
    });
    throw error;
  }
}
