import { describe, expect, expectTypeOf, it } from "vitest";
import {
  isWorkflowDurableHarnessEventType,
  WORKFLOW_HARNESS_ID,
  type WorkflowArtifactRef,
  type WorkflowStep,
  workflowDurableHarnessEventTypes,
  workflowHarnessEventTypes,
} from "./index.js";

describe("workflow-harness protocol", () => {
  it("exports the default workflow harness identity", () => {
    expect(WORKFLOW_HARNESS_ID).toBe("workflowHarness@1.0.0");
  });

  it("uses dotted event names for trace and durability", () => {
    expect(workflowDurableHarnessEventTypes).toContain("harness.session.started");
    expect(workflowDurableHarnessEventTypes).toContain("harness.model.responded");
    expect(workflowDurableHarnessEventTypes).toContain("harness.execute_step.started");
    expect(workflowHarnessEventTypes).toContain("harness.runtime.command.started");
    expect(workflowHarnessEventTypes.filter((type) => type === "harness.execute_step.started")).toHaveLength(1);
    expect(new Set(workflowHarnessEventTypes).size).toBe(workflowHarnessEventTypes.length);
  });

  it("narrows durable workflow harness event names", () => {
    expect(isWorkflowDurableHarnessEventType("harness.model.called")).toBe(true);
    expect(isWorkflowDurableHarnessEventType("harness.execute_step.succeeded")).toBe(true);
    expect(isWorkflowDurableHarnessEventType("harness.filesystem.mounted")).toBe(false);
    expect(isWorkflowDurableHarnessEventType(undefined)).toBe(false);
  });

  it("types workflow artifacts and steps for custom harness authors", () => {
    expectTypeOf<"artifact://art_1">().toMatchTypeOf<WorkflowArtifactRef>();
    expectTypeOf<"art_1">().not.toMatchTypeOf<WorkflowArtifactRef>();

    const step: WorkflowStep = {
      id: "draft",
      uses: "ai.generate",
      with: { prompt: "Draft." },
    };

    if (step.uses === "ai.generate") {
      expectTypeOf(step.with?.prompt).toEqualTypeOf<unknown>();
    }

    const codeStep: WorkflowStep = {
      id: "run",
      uses: "code.run",
      with: {
        entrypoint: "main.ts",
        files: {
          "main.ts": {
            content: "export default async function main() { return 'ok'; }",
            sha256: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
          },
        },
        sandbox: { network: "deny", env: false, fs: "deny" },
      },
    };

    if (codeStep.uses === "code.run") {
      expectTypeOf(codeStep.with.entrypoint).toEqualTypeOf<string>();
      expectTypeOf(codeStep.with.files["main.ts"]?.content).toEqualTypeOf<string | undefined>();
      expectTypeOf(codeStep.with.files["main.ts"]?.sha256).toEqualTypeOf<`sha256:${string}` | undefined>();
      expectTypeOf(codeStep.with.sandbox.network).toEqualTypeOf<"deny" | false>();
    }

    const parallel = {
      id: "review",
      uses: "parallel",
      steps: [{ id: "score", uses: "tool.call", with: { tool: "score" } }],
    } satisfies WorkflowStep;

    expect(parallel.steps[0]?.uses).toBe("tool.call");
  });
});
