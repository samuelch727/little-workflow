import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { tool } from "ai";
import {
  createWorkflowHarness,
  createLittleWorkflow,
  createToolRegistry,
  localWorld,
  model,
  runWorkflow,
} from "little-workflow";

const dataDir = process.env.DEMO_DATA_DIR;
const runId = process.env.DEMO_RUN_ID;
const phase = process.env.DEMO_PHASE;
const heartbeatPath = process.env.DEMO_HEARTBEAT_PATH;

if (!dataDir || !runId || !phase || !heartbeatPath) {
  console.error(
    "Missing env: DEMO_DATA_DIR, DEMO_RUN_ID, DEMO_PHASE, DEMO_HEARTBEAT_PATH are required.",
  );
  process.exit(2);
}

await mkdir(dirname(heartbeatPath), { recursive: true });

const inputSchema = {
  type: "object",
  required: ["candidates"],
  properties: { candidates: { type: "array" } },
};

const fixedLwir = {
  apiVersion: "littleworkflow.dev/v0.1",
  kind: "Workflow",
  metadata: {
    name: "demo.kill-and-resume",
    version: "0.1.0-alpha",
    description: "Parallel branch group for the alpha kill-and-resume demo.",
  },
  input: { schema: inputSchema },
  output: { schema: { type: "array" } },
  permissions: { tools: ["demo.score"], models: [], secrets: [], network: [] },
  steps: [
    {
      id: "review",
      uses: "parallel",
      with: {
        items: "{{ input.candidates }}",
        cardinality: { kind: "matches_items" },
        itemKey: "{{ item.id }}",
        maxBranches: 4,
        maxConcurrency: 2,
        failureMode: "all_settled",
        fanIn: { order: "input", output: "array" },
      },
      steps: [
        {
          id: "score",
          uses: "tool.call",
          with: { tool: "demo.score" },
          input: { id: "{{ item.id }}", score: "{{ item.score }}", stall: "{{ item.stall }}" },
          output: { mode: "object", schema: { type: "object" } },
        },
      ],
      output: {
        mode: "array",
        schema: {
          type: "array",
          items: {
            type: "object",
            required: ["itemKey", "status", "artifacts"],
            properties: {
              itemKey: { type: "string" },
              status: { enum: ["completed", "failed"] },
              output: { type: "object" },
              outputRef: { type: "string" },
              error: { type: "object" },
              artifacts: { type: "array", items: { type: "string" } },
            },
          },
        },
      },
    },
  ],
};

const plannerModel = model(
  { provider: "demo", modelId: "planner-stub" },
  { id: "model.planner" },
);
const plannerHarness = {
  harnessId: "demoPlannerHarness@1.0.0",
  async run(task) {
    if (task.kind === "plan") {
      return { kind: "plan", lwir: fixedLwir };
    }
    return { kind: "delegate_to_default" };
  },
};

const workflow = createLittleWorkflow({
  id: "demo.kill-and-resume",
  description: "Parallel branch group for the alpha kill-and-resume demo.",
  inputSchema,
  outputSchema: { type: "array" },
  models: [plannerModel],
  planner: {
    model: plannerModel,
    harness: plannerHarness,
  },
  globalTools: ["demo.score"],
  worker: { harness: createWorkflowHarness() },
});

const tools = createToolRegistry({
  "demo.score": tool({
    description: "Score a demo candidate and write a heartbeat for resume verification.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        score: { type: "number" },
        stall: { type: "boolean" },
      },
      required: ["id", "score", "stall"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        score: { type: ["number", "null"] },
        at: { type: "string" },
      },
      required: ["id", "score", "at"],
      additionalProperties: false,
    },
    execute: async (input, options) => {
      const id = input?.id;
      const stall = input?.stall === true;
      const stepPath = options?.scope?.stepPath;

      await writeFile(
        heartbeatPath,
        `${JSON.stringify({
          phase,
          runPid: process.pid,
          stepPath,
          branchPath: stepPath?.split(".").slice(0, -1).join("."),
          item: input,
          at: new Date().toISOString(),
        })}\n`,
        { flag: "a" },
      );

      if (phase === "initial" && stall) {
        console.error(
          `[child] branch ${stepPath ?? "unknown"} reached stall point; awaiting SIGKILL`,
        );
        await new Promise((resolve) => setTimeout(resolve, 60_000));
      }

      return {
        id,
        score: typeof input?.score === "number" ? input.score * 10 : null,
        at: new Date().toISOString(),
      };
    },
  }),
});

try {
  const result = await runWorkflow({
    world: localWorld({ dataDir }),
    workflows: workflow,
    input: {
      candidates: [
        { id: "fast-a", score: 1, stall: false },
        { id: "slow-b", score: 2, stall: true },
      ],
    },
    runId,
    tools,
  });
  console.error(
    `[child] phase=${phase} status=${result.status} events=${result.events.length}`,
  );
  process.exit(0);
} catch (error) {
  console.error(
    `[child] phase=${phase} error: ${error?.name ?? "Error"}: ${error?.message ?? String(error)}`,
  );
  process.exit(1);
}
