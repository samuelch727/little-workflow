import { expect, it } from "vitest";
import type { HarnessWorkflow, HarnessWorkflowInputSchema } from "../workflows.js";
import { resolveAgentManifest } from "./resolve-agent-manifest.js";

function workflow(
  id = "candidate.review",
  inputSchema: HarnessWorkflowInputSchema = { kind: "json-schema", schema: { type: "object" } },
): HarnessWorkflow {
  return {
    id,
    inputSchema,
    executionMode: "inline",
    definitionIdentity: `sha256:${id}`,
    runForHarness: async (_input, ctx) => ({
      protocolVersion: 1,
      status: "completed",
      runId: ctx.reservedRunId,
      output: "ok",
    }),
  };
}

it("returns workflow manifest entries with handles, launcher handles, identity, and warnings", () => {
  const manifest = resolveAgentManifest({
    workflows: [
      workflow("candidate.review", {
        kind: "json-schema",
        schema: { type: "object", properties: { id: { type: "string" } } },
        lossy: true,
      }),
    ],
  });

  expect(manifest.workflows).toEqual([
    {
      id: "candidate.review",
      handle: "candidate_review",
      executionMode: "inline",
      workflowDefinitionIdentity: "sha256:candidate.review",
      launcherHandle: "start_candidate_review",
      inputSchema: {
        kind: "json-schema",
        schema: { type: "object", properties: { id: { type: "string" } } },
        lossy: true,
      },
    },
  ]);
  expect(manifest.asyncLauncherNames).toEqual(["start_candidate_review"]);
  expect(manifest.warnings).toHaveLength(1);
});

it("rejects workflow handles that collide with configured or discovered tools", () => {
  expect(() =>
    resolveAgentManifest({
      configuredToolNames: ["candidate_review"],
      workflows: [workflow()],
    })
  ).toThrow(/collides/i);

  expect(() =>
    resolveAgentManifest({
      discoveredToolNames: ["candidate_review"],
      workflows: [workflow()],
    })
  ).toThrow(/collides/i);
});

it("rejects workflow handles that collide with MCP tools", () => {
  expect(() =>
    resolveAgentManifest({
      mcpToolNames: ["candidate_review"],
      workflows: [workflow()],
    })
  ).toThrow(/collides/i);
});

it("rejects MCP tools that collide with configured or discovered tools", () => {
  expect(() =>
    resolveAgentManifest({
      configuredToolNames: ["lookup_order"],
      mcpToolNames: ["lookup_order"],
    })
  ).toThrow(/collides/i);

  expect(() =>
    resolveAgentManifest({
      discoveredToolNames: ["lookup_order"],
      mcpToolNames: ["lookup_order"],
    })
  ).toThrow(/collides/i);
});

it("rejects collisions with task-control and workflow-inspection tools", () => {
  expect(() =>
    resolveAgentManifest({
      configuredToolNames: ["list_tasks"],
      taskControlToolNames: ["list_tasks"],
    })
  ).toThrow(/collides/i);

  expect(() =>
    resolveAgentManifest({
      mcpToolNames: ["get_workflow_run"],
      workflowInspectionToolNames: ["get_workflow_run"],
    })
  ).toThrow(/collides/i);

  expect(() =>
    resolveAgentManifest({
      taskControlToolNames: ["candidate_review"],
      workflows: [workflow()],
    })
  ).toThrow(/collides/i);
});

it("rejects externally supplied names that use the generated launcher prefix", () => {
  for (const options of [
    { configuredToolNames: ["start_candidate_review"] },
    { discoveredToolNames: ["start_candidate_review"] },
    { mcpToolNames: ["start_candidate_review"] },
    { taskControlToolNames: ["start_candidate_review"] },
    { workflowInspectionToolNames: ["start_candidate_review"] },
    { workflows: [workflow("start.candidate")] },
  ]) {
    expect(() => resolveAgentManifest(options)).toThrow(/reserved start_/i);
  }
});

it("allows generated async launcher names to use the generated launcher prefix", () => {
  expect(
    resolveAgentManifest({
      workflows: [workflow()],
      generatedLauncherNames: ["start_other"],
    }).asyncLauncherNames,
  ).toEqual(["start_candidate_review", "start_other"]);
});

it("rejects duplicate generated async launcher names", () => {
  expect(() =>
    resolveAgentManifest({
      workflows: [workflow()],
      generatedLauncherNames: ["start_candidate_review"],
    })
  ).toThrow(/not unique/i);
});

it("rejects unconvertible and implicitly untyped workflow schemas", () => {
  expect(() =>
    resolveAgentManifest({
      workflows: [workflow("candidate.review", { kind: "unconvertible", error: "Cannot convert recursive schema." })],
    })
  ).toThrow(/recursive schema/i);

  expect(() =>
    resolveAgentManifest({
      workflows: [workflow("candidate.review", { kind: "untyped", allowUntypedInput: false })],
    })
  ).toThrow(/explicitly allowed/i);
});

it("rejects workflows without structural definition identity", () => {
  expect(() =>
    resolveAgentManifest({
      workflows: [{ ...workflow(), definitionIdentity: undefined } as unknown as HarnessWorkflow],
    })
  ).toThrow(/definition identity/i);
});
