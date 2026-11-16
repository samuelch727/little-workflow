import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tool } from "ai";
import { InMemoryFs } from "just-bash";
import { z } from "zod";
import { afterEach, describe, it, expect } from "vitest";
import type { World } from "./world-port.js";
import { defineWorkflow, localWorld, runWorkflow } from "./authoring.js";
import { readWorkflowVersion } from "./run-plan.js";
import { virtualWorld } from "./world.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("World port", () => {
  it("localWorld() satisfies the World port with all required methods", () => {
    const world = localWorld({ dataDir: ".tmp-test" }) as unknown as World;
    expect(typeof world.appendEvent).toBe("function");
    expect(typeof world.listEvents).toBe("function");
    expect(typeof world.writeArtifact).toBe("function");
    expect(typeof world.readArtifact).toBe("function");
    expect(typeof world.readArtifactManifest).toBe("function");
    expect(typeof world.readWorkflowVersion).toBe("function");
  });

  it.each(["local", "virtual"] as const)("%s World reads the exact plan a run executed", async (kind) => {
    const directory = await mkdtemp(join(tmpdir(), "workflow-plan-port-"));
    directories.push(directory);
    const world = kind === "local"
      ? localWorld({ dataDir: directory })
      : virtualWorld({ fs: new InMemoryFs(), dataDir: "/plans" });
    const input = z.object({ value: z.string() });
    const workflow = defineWorkflow({
      id: "test.plan-port",
      input,
      tools: { echo: tool({ description: "Echo.", inputSchema: input, execute: async (value) => value }) },
      plan: { steps: [{
        id: "echo",
        uses: "tool.call",
        with: { tool: "echo", args: { value: "{{ input.value }}" } },
        output: { mode: "json", schema: true },
      }] },
    });
    const result = await runWorkflow(workflow, { value: "hello" }, { world });
    expect(result.status).toBe("completed");
    expect(world.readWorkflowVersion).toBeTypeOf("function");
    const stored = await world.readWorkflowVersion!(result.workflowVersionId);
    expect(stored).toEqual(await readWorkflowVersion(world, result.workflowVersionId));
    expect(stored.workflowVersionId).toBe(result.workflowVersionId);
    expect(stored.workflowId).toBe("test.plan-port");
    expect(stored.lwir.steps).toMatchObject([{ id: "echo", uses: "tool.call" }]);
    await expect(world.readWorkflowVersion!("wfver_missing")).rejects.toThrow(
      /No WorkflowVersion 'wfver_missing'.*Pass the world the run used/u,
    );
    await expect(world.readWorkflowVersion!("../escape")).rejects.toThrow("Invalid workflow version id");
  });
});
