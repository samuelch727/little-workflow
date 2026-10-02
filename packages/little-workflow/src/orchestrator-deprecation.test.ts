import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLittleWorkflow, localWorld, model } from "./authoring.js";
import type { CompilableWorkflowDefinition } from "./compiler.js";
import type { Harness } from "./harness/types.js";

// The "warn once" latch lives at module scope in orchestrator.ts, so "once per process" is
// observable as "once per module instance". Each test resets the module registry first to get a
// fresh latch, then drives every orchestrator entry point and asserts a single warning.
//
// The spy is on `process.emitWarning` rather than on stderr because test-setup.ts sets
// `process.noDeprecation = true` to keep the notice out of test output; Node then swallows the
// printing, but our call into `emitWarning` still happens and is what we assert on.

const DEPRECATION_CODE = "LWF_DEP_ORCHESTRATOR";

type EmitWarningCall = readonly [string, { readonly type?: string; readonly code?: string }];

const tempDirs: string[] = [];

const testHarness: Harness = {
  async run() {
    return { kind: "plan", lwir: { apiVersion: "littleworkflow.dev/v0.1" } };
  },
};

function testWorkflow(id: string): CompilableWorkflowDefinition {
  return createLittleWorkflow({
    id,
    description: `${id} workflow`,
    inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
    outputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
    models: [model({ provider: "test", modelId: "worker" }, { id: "model.worker" })],
    planner: { model: { provider: "test", modelId: "planner" }, harness: testHarness },
  }) as CompilableWorkflowDefinition;
}

async function tempWorld() {
  const dataDir = await mkdtemp(join(tmpdir(), "little-workflow-orchestrator-deprecation-"));
  tempDirs.push(dataDir);
  return localWorld({ dataDir });
}

function deprecationCalls(spy: { readonly mock: { readonly calls: unknown } }): EmitWarningCall[] {
  const calls = spy.mock.calls as unknown[][];
  return calls.filter((call) => {
    const options = call[1] as { readonly code?: unknown } | undefined;
    return typeof options === "object"
      && options !== null
      && options.code === DEPRECATION_CODE;
  }) as unknown as EmitWarningCall[];
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("orchestrator deprecation warning", () => {
  it("warns exactly once across repeat calls and across every orchestrator entry point", async () => {
    vi.resetModules();
    const emitWarning = vi.spyOn(process, "emitWarning");
    const { createOrchestratorTools, workflowSnapshotsForOrchestrator } = await import(
      "./orchestrator.js"
    );

    const world = await tempWorld();
    const review = testWorkflow("candidate.review");
    const executeWorkflowVersion = vi.fn(async () => ({
      runId: "subrun_1",
      status: "completed" as const,
    }));

    workflowSnapshotsForOrchestrator([review]);
    expect(deprecationCalls(emitWarning)).toHaveLength(1);

    // Repeat calls, and the other entry point, must not warn again.
    workflowSnapshotsForOrchestrator([review]);
    createOrchestratorTools({ world, workflows: [review], executeWorkflowVersion });
    createOrchestratorTools({ world, workflows: [review], executeWorkflowVersion });

    expect(deprecationCalls(emitWarning)).toHaveLength(1);
  });

  it("emits a DeprecationWarning that names the replacement composition surface", async () => {
    vi.resetModules();
    const emitWarning = vi.spyOn(process, "emitWarning");
    const { createOrchestratorTools } = await import("./orchestrator.js");

    const world = await tempWorld();
    createOrchestratorTools({
      world,
      workflows: [testWorkflow("candidate.review")],
      executeWorkflowVersion: vi.fn(async () => ({
        runId: "subrun_1",
        status: "completed" as const,
      })),
    });

    const calls = deprecationCalls(emitWarning);
    expect(calls).toHaveLength(1);
    const [message, options] = calls[0] as EmitWarningCall;
    expect(options.type).toBe("DeprecationWarning");
    expect(options.code).toBe(DEPRECATION_CODE);
    expect(message).toContain("createOrchestratorTools()");
    expect(message).toContain("asHarnessWorkflow");
    expect(message).toContain("createHarness({ workflows })");
  });
});
