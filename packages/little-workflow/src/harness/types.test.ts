import { describe, expect, it, vi } from "vitest";
import type { Harness, HarnessContext } from "./types.js";

describe("Harness contract", () => {
  it("supports a single run method with discriminated task results", async () => {
    const harness: Harness = {
      async run(task, ctx) {
        expect(ctx.scope.role).toBe("planner");
        switch (task.kind) {
          case "plan":
            return { kind: "plan", lwir: { apiVersion: "littleworkflow.dev/v0.1" } };
          case "orchestrate":
            return { kind: "orchestrate", output: { ok: true } };
          case "execute_step":
            return { kind: "execute_step", output: task.stepInput, artifactRefs: [] };
          case "fix_step":
            return { kind: "fix_step", output: task.stepInput, fixedSource: "async () => ({})", attempts: 1 };
        }
      },
    };

    const ctx: HarnessContext = {
      scope: { runId: "run_contract", logDir: "/tmp/run_contract", role: "planner" },
      session: {
        runId: "run_contract",
        role: "planner",
        task: { kind: "plan" },
        manifest: {},
        manifestHash: "sha256:manifest",
      },
      model: { slotId: "gpt-5", providerId: "openai", modelId: "gpt-5", model: {} },
      tools: {},
      bash: { execute: vi.fn() },
      memoryMounts: [],
      scratchMounts: [],
      skills: [],
      mounts: [],
      durability: { append: vi.fn(), priorEvents: vi.fn(async () => []) },
      recorder: { append: vi.fn(), priorEvents: vi.fn(async () => []) },
      abortSignal: new AbortController().signal,
    };

    const result = await harness.run(
      { kind: "plan", workflowSnapshot: { id: "wf", description: "", inputSchema: {}, outputSchema: {}, workflowDefinitionHash: "sha256:wf" }, input: {} },
      ctx,
    );

    expect(result.kind).toBe("plan");
  });
});
