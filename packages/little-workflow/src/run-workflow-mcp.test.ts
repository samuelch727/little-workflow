import { tool } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  createLittleWorkflow,
  createToolRegistry,
  executeWorkflowVersion,
  localWorld,
  model,
  output,
  readStoredWorkflowVersion,
  runWorkflow,
  type Harness,
  type HarnessContext,
  type LwirWorkflow,
} from "./index.js";
import { cleanupTempDirs, workerScopedTempPrefix } from "./test-temp.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mcpResolverMock = vi.hoisted(() => ({
  resolveHarnessMcpGateway: vi.fn(),
}));

vi.mock("little-harness", async (importOriginal) => ({
  ...(await importOriginal<typeof import("little-harness")>()),
  resolveHarnessMcpGateway: mcpResolverMock.resolveHarnessMcpGateway,
}));

const tempDirs: string[] = [];

async function tempWorld() {
  const dataDir = await mkdtemp(
    join(
      tmpdir(),
      workerScopedTempPrefix("little-workflow-run-workflow-mcp-", process.env.VITEST_POOL_ID),
    ),
  );
  tempDirs.push(dataDir);
  return localWorld({ dataDir });
}

afterEach(async () => {
  await cleanupTempDirs(tempDirs);
});

const workerModel = model(
  { provider: "test", modelId: "worker-model" },
  { description: "Worker model for MCP tests." },
);

const outputSchema = {
  type: "object",
  required: ["summary"],
  additionalProperties: false,
  properties: { summary: { type: "string" } },
};

function mcpToolLwir(
  name = "support.mcp",
  input: unknown = { server: "figma", tool: "search", args: { query: "{{ input.query }}" } },
): LwirWorkflow {
  return {
    apiVersion: "littleworkflow.dev/v0.1",
    kind: "Workflow",
    metadata: { name, version: "0.1.0-alpha" },
    input: { schema: true },
    output: { schema: outputSchema },
    permissions: { tools: ["mcp_call_tool"], models: [], secrets: [], network: [] },
    steps: [
      {
        id: "search",
        uses: "tool.call",
        with: { tool: "mcp_call_tool" },
        input,
        output: { mode: "object", schema: outputSchema },
      },
    ],
  };
}

function mockResolvedMcp(
  close = vi.fn(async () => {}),
  callToolExecute: (input: unknown, options?: unknown) => unknown | Promise<unknown> = async () => ({ summary: "from mcp" }),
  toolDescription = "Search Figma files.",
) {
  mcpResolverMock.resolveHarnessMcpGateway.mockResolvedValueOnce({
    tools: {
      mcp_call_tool: tool({
        description: "Call a visible MCP tool.",
        inputSchema: z.object({
          server: z.string(),
          tool: z.string(),
          args: z.unknown().optional(),
        }),
        execute: callToolExecute,
      }),
      mcp_list_tools: tool({
        description: "List visible MCP tools.",
        inputSchema: z.object({}),
      }),
    },
    skills: [
      {
        name: "figma-mcp",
        description: "Use the Figma MCP server.",
        harnessDir: ".agents/skills/figma-mcp",
        files: {
          "SKILL.md": new TextEncoder().encode(
            "---\nname: figma-mcp\ndescription: Use the Figma MCP server.\n---\nUse mcp_call_tool.",
          ),
        },
      },
    ],
    manifest: {
      gateway: { listToolName: "mcp_list_tools", callToolName: "mcp_call_tool" },
      servers: [
        {
          id: "figma",
          description: "Figma.",
          transport: { type: "http", url: "https://mcp.example.test/figma" },
          guide: {
            name: "figma-mcp",
            description: "Use the Figma MCP server.",
            bodyHash: "sha256:guide-a",
          },
          tools: [
            {
              serverId: "figma",
              sourceName: "search",
              visibleName: "search",
              description: toolDescription,
              inputSchemaHash: "sha256:input-a",
            },
          ],
        },
      ],
    },
    close,
  });
  return close;
}

describe("runWorkflow MCP integration", () => {
  beforeEach(() => {
    mcpResolverMock.resolveHarnessMcpGateway.mockReset();
  });

  it("resolves runWorkflow({ mcp }) into normal planner and worker tools and guide skills, then closes the gateway", async () => {
    const close = mockResolvedMcp();
    const world = await tempWorld();
    const plannerContexts: HarnessContext[] = [];
    const workerContexts: HarnessContext[] = [];
    const plannerHarness = {
      harnessId: "plannerHarness@1.0.0",
      run: vi.fn<Harness["run"]>(async (task, ctx) => {
        plannerContexts.push(ctx);
        expect(Object.keys(ctx.tools).sort()).toEqual(["mcp_call_tool", "mcp_list_tools"]);
        expect(ctx.skills.map((entry) => entry.name)).toEqual(["figma-mcp"]);
        return task.kind === "plan" ? { kind: "plan", lwir: mcpToolLwir() } : { kind: "delegate_to_default" };
      }),
    } satisfies Harness & { readonly harnessId: string };
    const workerHarness = {
      harnessId: "workerHarness@1.0.0",
      run: vi.fn<Harness["run"]>(async (task, ctx) => {
        workerContexts.push(ctx);
        expect(Object.keys(ctx.tools)).toEqual(["mcp_call_tool"]);
        expect(ctx.skills.map((entry) => entry.name)).toEqual(["figma-mcp"]);
        return task.kind === "execute_step"
          ? { kind: "execute_step", output: { summary: "from worker" }, artifactRefs: [] }
          : { kind: "delegate_to_default" };
      }),
    } satisfies Harness & { readonly harnessId: string };
    const registry = createToolRegistry();
    const workflow = createLittleWorkflow({
      id: "support.mcp",
      description: "Use MCP.",
      output: output.object({ schema: outputSchema }),
      models: [workerModel],
      globalTools: ["mcp_call_tool"],
      planner: {
        model: { provider: "test", modelId: "planner" },
        harness: plannerHarness,
      },
      worker: { harness: workerHarness },
    } as unknown as Parameters<typeof createLittleWorkflow>[0]);
    const mcp = {
      servers: [
        {
          id: "figma",
          description: "Figma.",
          transport: { type: "http" as const, url: "https://mcp.example.test" },
        },
      ],
    };

    const result = await runWorkflow({
      world,
      workflows: workflow,
      input: { query: "alpha" },
      tools: registry,
      runId: "run_mcp_single",
      mcp,
    });

    expect(result.output).toEqual({ summary: "from worker" });
    expect(mcpResolverMock.resolveHarnessMcpGateway).toHaveBeenCalledWith(mcp);
    expect(registry.names()).toEqual([]);
    expect(plannerContexts).toHaveLength(1);
    expect(workerContexts).toHaveLength(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("closes the gateway when planning fails", async () => {
    const close = mockResolvedMcp();
    const world = await tempWorld();
    const plannerHarness = {
      harnessId: "plannerHarness@1.0.0",
      run: vi.fn<Harness["run"]>(async () => {
        throw new Error("planner failed after MCP resolution");
      }),
    } satisfies Harness & { readonly harnessId: string };
    const workflow = createLittleWorkflow({
      id: "support.mcp-fails",
      description: "Fail after MCP.",
      output: output.object({ schema: outputSchema }),
      models: [workerModel],
      planner: {
        model: { provider: "test", modelId: "planner" },
        harness: plannerHarness,
      },
    } as unknown as Parameters<typeof createLittleWorkflow>[0]);

    await expect(runWorkflow({
      world,
      workflows: workflow,
      input: {},
      runId: "run_mcp_failure",
      mcp: { servers: [] },
    })).rejects.toThrow(/planner failed after MCP resolution/u);

    expect(close).toHaveBeenCalledTimes(1);
  });

  it("closes the gateway when MCP setup fails after resolving the client", async () => {
    const close = mockResolvedMcp();
    const world = await tempWorld();
    const registry = createToolRegistry({
      mcp_call_tool: tool({
        description: "Existing app tool that collides with the MCP gateway.",
        inputSchema: z.object({}),
      }),
    });
    const workflow = createLittleWorkflow({
      id: "support.mcp-collision",
      description: "Collide after MCP resolution.",
      output: output.object({ schema: outputSchema }),
      models: [workerModel],
      planner: {
        model: { provider: "test", modelId: "planner" },
        harness: {
          harnessId: "plannerHarness@1.0.0",
          run: vi.fn<Harness["run"]>(async () => {
            throw new Error("planner should not run after MCP collision");
          }),
        },
      },
    } as unknown as Parameters<typeof createLittleWorkflow>[0]);

    await expect(runWorkflow({
      world,
      workflows: workflow,
      input: {},
      tools: registry,
      runId: "run_mcp_collision_cleanup",
      mcp: { servers: [] },
    })).rejects.toThrow(/already registered/u);

    expect(close).toHaveBeenCalledTimes(1);
  });

  it("executes MCP gateway tools through the default workflow tool.call path", async () => {
    const mcpCall = vi.fn(async () => ({ summary: "from default gateway" }));
    const close = mockResolvedMcp(vi.fn(async () => {}), mcpCall);
    const world = await tempWorld();
    const plannerHarness = {
      harnessId: "plannerHarness@1.0.0",
      run: vi.fn<Harness["run"]>(async (task) => {
        return task.kind === "plan"
          ? {
              kind: "plan",
              lwir: mcpToolLwir("support.mcp-default", {
                server: "figma",
                tool: "search",
                args: { query: "alpha" },
              }),
            }
          : { kind: "delegate_to_default" };
      }),
    } satisfies Harness & { readonly harnessId: string };
    const workflow = createLittleWorkflow({
      id: "support.mcp-default",
      description: "Use MCP through the default tool.call executor.",
      output: output.object({ schema: outputSchema }),
      models: [workerModel],
      globalTools: ["mcp_call_tool"],
      planner: {
        model: { provider: "test", modelId: "planner" },
        harness: plannerHarness,
      },
    } as unknown as Parameters<typeof createLittleWorkflow>[0]);

    const result = await runWorkflow({
      world,
      workflows: workflow,
      input: { query: "alpha" },
      tools: createToolRegistry(),
      runId: "run_mcp_default_tool_call",
      mcp: { servers: [] },
    });

    expect(result.output).toEqual({ summary: "from default gateway" });
    expect(mcpCall).toHaveBeenCalledWith(
      { server: "figma", tool: "search", args: { query: "alpha" } },
      expect.anything(),
    );
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("replays a completed runWorkflow run without resolving MCP again", async () => {
    const close = mockResolvedMcp(vi.fn(async () => {}), async () => ({ summary: "from completed run" }));
    const world = await tempWorld();
    const plannerHarness = {
      harnessId: "plannerHarness@1.0.0",
      run: vi.fn<Harness["run"]>(async (task) => {
        return task.kind === "plan"
          ? {
              kind: "plan",
              lwir: mcpToolLwir("support.mcp-run-replay", {
                server: "figma",
                tool: "search",
                args: { query: "alpha" },
              }),
            }
          : { kind: "delegate_to_default" };
      }),
    } satisfies Harness & { readonly harnessId: string };
    const workflow = createLittleWorkflow({
      id: "support.mcp-run-replay",
      description: "Replay a completed MCP-backed run.",
      output: output.object({ schema: outputSchema }),
      models: [workerModel],
      globalTools: ["mcp_call_tool"],
      planner: {
        model: { provider: "test", modelId: "planner" },
        harness: plannerHarness,
      },
    } as unknown as Parameters<typeof createLittleWorkflow>[0]);
    const mcp = { servers: [] };

    const first = await runWorkflow({
      world,
      workflows: workflow,
      input: { query: "alpha" },
      tools: createToolRegistry(),
      runId: "run_mcp_completed_replay",
      mcp,
    });

    mcpResolverMock.resolveHarnessMcpGateway.mockRejectedValueOnce(new Error("mcp server down"));
    const replay = await runWorkflow({
      world,
      workflows: workflow,
      input: { query: "alpha" },
      tools: createToolRegistry(),
      runId: "run_mcp_completed_replay",
      mcp,
    });

    expect(replay.output).toEqual(first.output);
    expect(mcpResolverMock.resolveHarnessMcpGateway).toHaveBeenCalledTimes(1);
    expect(plannerHarness.run).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("replays a completed executeWorkflowVersion run without resolving MCP again", async () => {
    const close = mockResolvedMcp(vi.fn(async () => {}), async () => ({ summary: "from direct replay" }));
    const world = await tempWorld();
    const plannerHarness = {
      harnessId: "plannerHarness@1.0.0",
      run: vi.fn<Harness["run"]>(async (task) => {
        return task.kind === "plan"
          ? {
              kind: "plan",
              lwir: mcpToolLwir("support.mcp-direct-replay", {
                server: "figma",
                tool: "search",
                args: { query: "alpha" },
              }),
            }
          : { kind: "delegate_to_default" };
      }),
    } satisfies Harness & { readonly harnessId: string };
    const workflow = createLittleWorkflow({
      id: "support.mcp-direct-replay",
      description: "Replay a completed direct execution.",
      output: output.object({ schema: outputSchema }),
      models: [workerModel],
      globalTools: ["mcp_call_tool"],
      planner: {
        model: { provider: "test", modelId: "planner" },
        harness: plannerHarness,
      },
    } as unknown as Parameters<typeof createLittleWorkflow>[0]);
    const mcp = { servers: [] };

    const first = await runWorkflow({
      world,
      workflows: workflow,
      input: { query: "alpha" },
      tools: createToolRegistry(),
      runId: "run_mcp_direct_completed_replay",
      mcp,
    });
    const stored = await readStoredWorkflowVersion(world, first.workflowVersionId);

    mcpResolverMock.resolveHarnessMcpGateway.mockRejectedValueOnce(new Error("mcp server down"));
    const replay = await executeWorkflowVersion({
      world,
      workflowVersion: stored,
      input: { query: "alpha" },
      tools: createToolRegistry(),
      runId: "run_mcp_direct_completed_replay",
      mcp,
    });

    expect(replay.output).toEqual(first.output);
    expect(mcpResolverMock.resolveHarnessMcpGateway).toHaveBeenCalledTimes(1);
    expect(plannerHarness.run).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("rejects direct locked execution when MCP capabilities change", async () => {
    const firstClose = mockResolvedMcp(vi.fn(async () => {}), async () => ({ summary: "first" }), "Search Figma files.");
    const secondClose = mockResolvedMcp(vi.fn(async () => {}), async () => ({ summary: "second" }), "Search Figma files and comments.");
    const world = await tempWorld();
    const plannerHarness = {
      harnessId: "plannerHarness@1.0.0",
      run: vi.fn<Harness["run"]>(async (task) => {
        return task.kind === "plan"
          ? {
              kind: "plan",
              lwir: mcpToolLwir("support.mcp-direct-drift", {
                server: "figma",
                tool: "search",
                args: { query: "alpha" },
              }),
            }
          : { kind: "delegate_to_default" };
      }),
    } satisfies Harness & { readonly harnessId: string };
    const workflow = createLittleWorkflow({
      id: "support.mcp-direct-drift",
      description: "Detect direct MCP drift.",
      output: output.object({ schema: outputSchema }),
      models: [workerModel],
      globalTools: ["mcp_call_tool"],
      planner: {
        model: { provider: "test", modelId: "planner" },
        harness: plannerHarness,
      },
    } as unknown as Parameters<typeof createLittleWorkflow>[0]);

    const first = await runWorkflow({
      world,
      workflows: workflow,
      input: { query: "alpha" },
      tools: createToolRegistry(),
      runId: "run_mcp_direct_drift_compile",
      mcp: { servers: [] },
    });
    const stored = await readStoredWorkflowVersion(world, first.workflowVersionId);

    const drift = await executeWorkflowVersion({
      world,
      workflowVersion: stored,
      input: { query: "alpha" },
      tools: createToolRegistry(),
      runId: "run_mcp_direct_drift_execute",
      mcp: { servers: [] },
    });

    expect(drift.status).toBe("failed");
    if (drift.status !== "failed") {
      throw new Error("Expected MCP capability drift to produce a failed runtime result.");
    }
    expect(drift.error).toMatchObject({
      causeCode: "capability_drift",
      message: expect.stringMatching(/MCP capability changed/u),
    });
    expect(firstClose).toHaveBeenCalledTimes(1);
    expect(secondClose).toHaveBeenCalledTimes(1);
  });

  it("blocks planner-reviewed reuse when MCP capabilities change", async () => {
    const firstClose = mockResolvedMcp(vi.fn(async () => {}), async () => ({ summary: "first" }), "Search Figma files.");
    const secondClose = mockResolvedMcp(vi.fn(async () => {}), async () => ({ summary: "second" }), "Search Figma files and comments.");
    const world = await tempWorld();
    let firstWorkflowVersionId = "";
    let planCalls = 0;
    const plannerHarness = {
      harnessId: "plannerHarness@1.0.0",
      run: vi.fn<Harness["run"]>(async (task) => {
        if (task.kind !== "plan") {
          return { kind: "delegate_to_default" };
        }
        planCalls += 1;
        if (planCalls === 1) {
          return {
            kind: "plan",
            lwir: mcpToolLwir("support.mcp-reuse", {
              server: "figma",
              tool: "search",
              args: { query: "alpha" },
            }),
          };
        }
        return {
          kind: "plan",
          lwir: {
            kind: "reuse_unchanged",
            workflowVersionId: firstWorkflowVersionId,
            rationale: "MCP shape should still be compatible.",
          },
        };
      }),
    } satisfies Harness & { readonly harnessId: string };
    const workflow = createLittleWorkflow({
      id: "support.mcp-reuse",
      description: "Use MCP with planner-reviewed reuse.",
      output: output.object({ schema: outputSchema }),
      models: [workerModel],
      globalTools: ["mcp_call_tool"],
      workflowVersionReuseStrategy: "planner_reviewed",
      planner: {
        model: { provider: "test", modelId: "planner" },
        harness: plannerHarness,
      },
    } as unknown as Parameters<typeof createLittleWorkflow>[0]);

    const first = await runWorkflow({
      world,
      workflows: workflow,
      input: { query: "alpha" },
      tools: createToolRegistry(),
      runId: "run_mcp_reuse_first",
      mcp: { servers: [] },
    });
    firstWorkflowVersionId = first.workflowVersionId;

    await expect(runWorkflow({
      world,
      workflows: workflow,
      input: { query: "beta" },
      tools: createToolRegistry(),
      runId: "run_mcp_reuse_second",
      mcp: { servers: [] },
    })).rejects.toThrow(/reuse_unchanged is blocked.*MCP capability changed/u);

    expect(firstClose).toHaveBeenCalledTimes(1);
    expect(secondClose).toHaveBeenCalledTimes(1);
  });

  it("passes MCP tools and guide skills to orchestrator contexts and delegated sub-runs", async () => {
    const close = mockResolvedMcp();
    const world = await tempWorld();
    const plannerHarness = {
      harnessId: "plannerHarness@1.0.0",
      run: vi.fn<Harness["run"]>(async (task, ctx) => {
        expect(Object.keys(ctx.tools).sort()).toEqual(["mcp_call_tool", "mcp_list_tools"]);
        expect(ctx.skills.map((entry) => entry.name)).toEqual(["figma-mcp"]);
        return task.kind === "plan" ? { kind: "plan", lwir: mcpToolLwir("support.mcp-orchestrated") } : { kind: "delegate_to_default" };
      }),
    } satisfies Harness & { readonly harnessId: string };
    const workerHarness = {
      harnessId: "workerHarness@1.0.0",
      run: vi.fn<Harness["run"]>(async (task, ctx) => {
        expect(Object.keys(ctx.tools)).toEqual(["mcp_call_tool"]);
        expect(ctx.skills.map((entry) => entry.name)).toEqual(["figma-mcp"]);
        return task.kind === "execute_step"
          ? { kind: "execute_step", output: { summary: "from sub-run" }, artifactRefs: [] }
          : { kind: "delegate_to_default" };
      }),
    } satisfies Harness & { readonly harnessId: string };
    const orchestratorHarness = {
      harnessId: "orchestratorHarness@1.0.0",
      run: vi.fn<Harness["run"]>(async (task, ctx) => {
        expect(task.kind).toBe("orchestrate");
        expect(Object.keys(ctx.tools).sort()).toEqual([
          "mcp_call_tool",
          "mcp_list_tools",
          "plan_workflow",
          "run_workflow",
          "start_workflow",
        ]);
        expect(ctx.skills.map((entry) => entry.name)).toEqual(["figma-mcp"]);
        const planTool = ctx.tools.plan_workflow as {
          execute(input: { workflowId: string; input: unknown }, options?: unknown): Promise<{ workflowVersionId: string }>;
        };
        const runTool = ctx.tools.run_workflow as {
          execute(input: { workflowVersionId: string; input: unknown }, options?: unknown): Promise<{ output?: unknown }>;
        };
        const planned = await planTool.execute({ workflowId: "support.mcp-orchestrated", input: { query: "alpha" } });
        const run = await runTool.execute({ workflowVersionId: planned.workflowVersionId, input: { query: "alpha" } });
        return { kind: "orchestrate", output: run.output };
      }),
    } satisfies Harness & { readonly harnessId: string };
    const workflow = createLittleWorkflow({
      id: "support.mcp-orchestrated",
      description: "Use MCP in a sub-run.",
      output: output.object({ schema: outputSchema }),
      models: [workerModel],
      globalTools: ["mcp_call_tool"],
      planner: {
        model: { provider: "test", modelId: "planner" },
        harness: plannerHarness,
      },
      worker: { harness: workerHarness },
    } as unknown as Parameters<typeof createLittleWorkflow>[0]);
    const mcp = {
      servers: [
        {
          id: "figma",
          description: "Figma.",
          transport: { type: "http" as const, url: "https://mcp.example.test" },
        },
      ],
    };

    const result = await runWorkflow({
      world,
      workflows: [workflow],
      input: { query: "alpha" },
      runId: "run_mcp_orchestrated",
      mcp,
      orchestrator: {
        model: { provider: "test", modelId: "orchestrator" },
        harness: orchestratorHarness,
      },
    });

    expect(result.output).toEqual({ summary: "from sub-run" });
    expect(mcpResolverMock.resolveHarnessMcpGateway).toHaveBeenCalledTimes(1);
    expect(plannerHarness.run).toHaveBeenCalledTimes(1);
    expect(workerHarness.run).toHaveBeenCalledTimes(1);
    expect(orchestratorHarness.run).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });
});
