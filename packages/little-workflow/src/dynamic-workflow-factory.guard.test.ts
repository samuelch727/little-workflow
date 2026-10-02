import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { HarnessWorkflowRunContext } from "little-harness";

// Mock compileWorkflow to simulate the silent-substitution case: the compiler
// falls through to synthesizeSimpleLwir and returns a VALID but DIFFERENT LWIR,
// so compiled.workflowVersion.lwirHash no longer equals the frozen plan's hash.
// The factory must refuse to run rather than execute the substituted plan.
vi.mock("./compiler.js", async (importActual) => {
  const actual = await importActual<typeof import("./compiler.js")>();
  return {
    ...actual,
    compileWorkflow: vi.fn(async () => ({
      workflowVersion: { lwirHash: "sha256:deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef" },
    })),
  };
});

const { littleWorkflowDynamicWorkflowFactory } = await import("./dynamic-workflow-factory.js");

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

it("refuses to run when the compiled plan's LWIR hash diverges from the frozen plan", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "adhoc-guard-"));
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
      models: { default: {} },
    }),
  );
  expect(exec.status).toBe("failed");
  if (exec.status !== "failed") return;
  expect(exec.causeCode).toBe("workflow_failed");
  // Distinctive message proves the GUARD fired (not a downstream execute error).
  expect(exec.message).toContain("refusing to run a substituted plan");
});
