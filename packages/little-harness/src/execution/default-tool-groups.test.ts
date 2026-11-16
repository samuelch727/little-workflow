import { tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { expect, it } from "vitest";
import { z } from "zod";
import { createHarness } from "../create-harness.js";
import { localHost } from "../local-host/index.js";
import { virtualHost } from "../virtual-host/virtual-host.js";
import { withTempDir } from "../test/temp.js";
import type { CreateHarnessOptions, HarnessHost, HarnessEvent } from "../types.js";
import type { HarnessWorkflow } from "../workflows.js";
import { generateHarness } from "./generate-harness.js";

const tasks = ["list_tasks", "get_task", "task_result", "await_tasks", "set_task_wakeup"];
const workflows = ["list_workflows", "get_workflow", "get_workflow_task", "get_workflow_run"];
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
const custom = tool({ description: "A custom tool.", inputSchema: z.object({}), execute: async () => "ok" });
const workflow: HarnessWorkflow = {
  id: "sample", description: "Sample workflow.", inputSchema: { kind: "json-schema", schema: { type: "object", properties: {} } },
  executionMode: "inline", definitionIdentity: "sha256:sample",
  runForHarness: async (_input, ctx) => ({ protocolVersion: 1, status: "completed", runId: ctx.reservedRunId, output: {} }),
};
async function offered(host: HarnessHost, options: Partial<CreateHarnessOptions> = {}, taskId?: string) {
  const definitions: unknown[] = [];
  const prompts: string[] = [];
  const events: HarnessEvent[] = [];
  const model = new MockLanguageModelV3({ doGenerate: async request => {
    definitions.push(request.tools); prompts.push(JSON.stringify(request.prompt));
    return { content: taskId && definitions.length === 1
      ? [{ type: "tool-call" as const, toolCallId: "read_task", toolName: "get_task", input: JSON.stringify({ taskId }) }]
      : [{ type: "text" as const, text: "done" }], finishReason: { unified: taskId && definitions.length === 1 ? "tool-calls" as const : "stop" as const, raw: "stop" }, usage, warnings: [] };
  } });
  const harness = createHarness({ host, model, tools: { custom }, ...options, onEvent: event => { events.push(event); } });
  const result = await generateHarness({ harness, session: "session", prompt: "Inspect tools." });
  expect(result.status).toBe("completed");
  const names = (definitions[0] as { name: string }[]).map(t => t.name).sort();
  const called = events.find(event => event.type === "harness.model.called");
  expect(((called?.metadata?.request as { tools: { toolName: string }[] }).tools).map(t => t.toolName).sort()).toEqual(names);
  return { names, bytes: Buffer.byteLength(JSON.stringify(definitions[0])), prompts };
}

it.each(["local", "virtual"] as const)("sends exactly custom and bash by default on %s, including empty workflows", async kind => {
  await withTempDir(async dir => {
    const host = kind === "local" ? localHost({ dataDir: dir }) : virtualHost();
    expect((await offered(host)).names).toEqual(["bash", "custom"]);
    expect((await offered(host, { workflows: [] })).names).toEqual(["bash", "custom"]);
    const before = await offered(host, { taskTools: true, workflowTools: true });
    const after = await offered(host);
    expect(before.names).toEqual(["bash", "custom", ...tasks, ...workflows].sort());
    expect(after.bytes).toBeLessThan(before.bytes);
    console.info(`${kind} serialized model definitions: before=${before.bytes}, after=${after.bytes}`);
  });
});

it.each([
  ["workflow", { workflows: [workflow] }, ["sample", ...tasks, ...workflows]],
  ["human input", { humanInput: true }, ["ask_person", ...tasks]],
  ["hidden human input", { humanInput: { tool: false } }, tasks],
  ["hidden human input without tasks", { humanInput: { tool: false }, taskTools: false }, []],
  ["explicit tasks", { taskTools: true }, tasks],
  ["explicit workflows", { workflowTools: true }, workflows],
  ["disabled workflows with workflow", { workflowTools: false, workflows: [workflow] }, ["sample", ...tasks]],
  ["disabled tasks with workflow", { taskTools: false, workflows: [workflow] }, ["sample", ...workflows]],
] as const)("offers the exact %s group to the model", async (_label, options, expected) => {
  await withTempDir(async dir => {
    expect((await offered(localHost({ dataDir: dir }), options as Partial<CreateHarnessOptions>)).names).toEqual(["bash", "custom", ...expected].sort());
  });
});

it("dynamic workflows alone offer their own tools, not inspection or task tools", async () => {
  const result = await offered(virtualHost(), { dynamicWorkflows: { enabled: true, factory: {
    compile: () => { throw new Error("not called"); }, define: () => { throw new Error("not called"); },
  } } });
  expect(result.names).toEqual(["bash", "custom", "define_workflow", "run_ad_hoc_plan", "search_authored_plans"].sort());
});

it("rejects contradictory task configuration and retains reserved names", async () => {
  const host = virtualHost();
  // The default tool name is filled in, not printed as "undefined".
  for (const humanInput of [true, {}, { description: "Ask the owner." }] as const) {
    expect(() => createHarness({ host, model: "test", humanInput, taskTools: false })).toThrow(/humanInput tool ask_person;/);
  }
  expect(() => createHarness({ host, model: "test", humanInput: { toolName: "ask_customer" }, taskTools: false })).toThrow(/(?=.*taskTools)(?=.*humanInput)(?=.*ask_customer)(?=.*Leave taskTools out)(?=.*humanInput.tool: false)/);
  expect(() => createHarness({ host, model: "test", humanInput: true, taskTools: false })).toThrow(/(?=.*taskTools)(?=.*humanInput)/);
  for (const name of ["taskTools", "workflowTools"] as const) {
    expect(() => createHarness({ host, model: "test", [name]: "yes" } as unknown as CreateHarnessOptions)).toThrow(new RegExp(name));
  }
  await expect(offered(host, { tools: { list_tasks: custom } })).rejects.toThrow(/collides|reserved/);
  await expect(offered(host, { workflows: [{ ...workflow, id: "list_tasks" }] })).rejects.toThrow(/collides|reserved/);
});

it("host-reserved tool tasks do not change defaults, but explicit task tools can read them", async () => {
  await withTempDir(async dir => {
    const host = localHost({ dataDir: dir });
    const launch = await host.durable!.asyncLaunches.reserveLaunch({
      sessionId: "session", kind: "tool", handle: "host_tool", purpose: "host-reserved task", callIdentity: "host-call",
      input: {}, inputHash: "sha256:input", sessionDataDir: dir, originTurnId: "host-turn", parentTurnId: "host-turn",
      reservationScopeId: "host-scope", reservationOrder: 0, scopeSize: 1, capabilitySnapshot: { implementationHash: "sha256:tool" },
    });
    expect((await offered(host)).names).toEqual(["bash", "custom"]);
    const explicit = await offered(host, { taskTools: true }, launch.task.taskId);
    expect(explicit.names).toEqual(["bash", "custom", ...tasks].sort());
    expect(explicit.prompts[1]).toContain("host-reserved task");
    expect(explicit.prompts[1]).toContain(launch.task.taskId);
  });
});


it("agents alone offer group and task tools without workflow tools", async () => {
  const unused = async (): Promise<never> => { throw new Error("launcher must not be called"); };
  const result = await offered(virtualHost(), { agents: {
    launcher: { startAgentGroup: unused, watchAgentGroup: unused, joinAgentGroup: unused, cancelAgentGroup: unused },
    profiles: [{ handle: "worker", resourcesHandle: "cpu", secretsHandle: "none", toolsHandle: "code", networkHandle: "none", priorityHandle: "interactive" }],
    joinPolicies: [{ handle: "all", policy: { kind: "all_success" } }], defaultJoinPolicyHandle: "all",
    reductionPolicies: [{ handle: "bounded", maxMemberSummaryBytes: 128, maxGroupSummaryBytes: 256, maxResultRefs: 4 }], defaultReductionPolicyHandle: "bounded",
  } });
  expect(result.names).toEqual(["bash", "custom", ...tasks, "start_agent_group", "spawn_agent", "watch_agent_group", "join_agent_group", "cancel_agent_group"].sort());
});

it("uses durable services carried only by the prepared turn for explicit task tools", async () => {
  const { durable: _durable, ...host } = virtualHost();
  expect((await offered(host, { taskTools: true })).names).toEqual(["bash", "custom", ...tasks].sort());
});
