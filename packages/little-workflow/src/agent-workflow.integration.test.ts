import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { jsonSchema, tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { createHarness, generateHarness, localHost, type AgentWorkflowRegistry } from "@little-stack/harness";
import { localWorld } from "./authoring.js";
import { dynamicWorkflows, type DynamicWorkflowWorldContext } from "./dynamic-workflow.js";
import type { World } from "./world-port.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

const policy = "Approve only applicants whose credit score is over 700.";

const definition = {
  id: "demo.loan",
  description: "Decide one loan application.",
  inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false },
  outputSchema: { type: "string" },
  tools: ["fetch_credit_report", "record_decision"],
  policy,
};

/**
 * One scripted model plays all three parts: the agent (offered its tools, through doGenerate),
 * the planner (offered only bash, through doStream; it returns the LWIR skeleton its prompt
 * carries) and the plan's model step (no tools, through doStream).
 */
function scriptedModel(agentTurns: Array<(tools: string[]) => unknown>) {
  const calls = { agent: [] as string[][], planner: 0, steps: [] as string[] };
  let turn = 0;
  const model = new MockLanguageModelV4({
    provider: "test",
    modelId: "scripted",
    doGenerate: async (options) => {
      const tools = (options.tools ?? []).map((entry) => entry.name).sort();
      calls.agent.push(tools);
      const next = agentTurns[turn];
      turn += 1;
      const call = next?.(tools);
      return {
        content: call === undefined ? [{ type: "text", text: "done" }] : [call as never],
        finishReason: call === undefined ? { unified: "stop", raw: "stop" } : { unified: "tool-calls", raw: "tool-calls" },
        usage,
        warnings: [],
      };
    },
    doStream: async (options) => {
      const tools = (options.tools ?? []).map((entry) => entry.name);
      if (tools.includes("bash")) {
        calls.planner += 1;
        return textStream(skeletonFrom(options.prompt));
      }
      calls.steps.push(promptText(options.prompt));
      return textStream("Approved.");
    },
  });
  return { model, calls };
}

function toolCall(toolName: string, input: unknown, toolCallId = "call_0") {
  return { type: "tool-call", toolCallId, toolName, input: JSON.stringify(input) };
}

it("a workflow the agent defines plans once, runs now, and is a tool in the next session that keeps the plan", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "agent-wf-"));
  dirs.push(dataDir);
  let recorded = 0;
  const tools = {
    fetch_credit_report: tool({
      description: "Fetch the applicant's credit report.",
      inputSchema: jsonSchema<{ name: string }>({ type: "object", properties: { name: { type: "string" } }, required: ["name"] }),
      execute: async () => ({ score: 712 }),
    }),
    record_decision: tool({
      description: "Record the decision in the loan system.",
      inputSchema: jsonSchema<{ name: string }>({ type: "object", properties: { name: { type: "string" } }, required: ["name"] }),
      execute: async () => {
        recorded += 1;
        return { recorded: true };
      },
    }),
  };
  const { model, calls } = scriptedModel([
    // Session one: define the workflow and run it on the first application.
    () => toolCall("define_workflow", { ...definition, runWith: { name: "Ada" } }),
    () => undefined,
    // Session two: the workflow is now a tool of its own.
    (offered) => (offered.includes("demo_loan") ? toolCall("demo_loan", { name: "Bo" }) : undefined),
    () => undefined,
  ]);
  const harness = createHarness({
    host: localHost({ dataDir }),
    model,
    tools,
    runtime: { bash: false },
    dynamicWorkflows: dynamicWorkflows(),
  });

  const first = await generateHarness({ harness, session: "first", type: "job", input: {} });
  expect(first.status).toBe("completed");
  expect(calls.agent[0]).toContain("define_workflow");
  expect(calls.agent[0]).not.toContain("demo_loan");
  const defined = toolResults(model.doGenerateCalls[1]?.prompt, "define_workflow")[0] as Record<string, unknown>;
  expect(defined).toMatchObject({ status: "defined", id: "demo.loan", tool: "demo_loan", revision: 1 });
  expect(defined.run).toMatchObject({ status: "completed", output: "Approved." });
  expect(calls.planner).toBe(1);
  // The policy reached the model step word for word.
  expect(calls.steps[0]).toContain(policy);

  const stored = JSON.parse(await readFile(join(dataDir, "dynamic-plans", "workflows", "demo_loan.json"), "utf8"));
  expect(stored).toMatchObject({ id: "demo.loan", handle: "demo_loan", revision: 1, tools: definition.tools, policy });

  const second = await generateHarness({ harness, session: "second", type: "job", input: {} });
  expect(second.status).toBe("completed");
  expect(calls.agent[2]).toContain("demo_loan");
  const ran = toolResults(model.doGenerateCalls[3]?.prompt, "demo_loan")[0] as Record<string, unknown>;
  expect(ran).toMatchObject({ status: "completed", output: "Approved." });
  // Same host, new session: the plan from session one is kept, with no second planner call.
  expect(calls.planner).toBe(1);
  expect(calls.steps).toHaveLength(2);
  expect(recorded).toBe(0);
});

it("a registry keeps a new definition from other sessions until it approves it, and a World factory stores every run", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "agent-wf-registry-"));
  dirs.push(dataDir);
  const tools = {
    fetch_credit_report: tool({
      description: "Fetch the applicant's credit report.",
      inputSchema: jsonSchema<{ name: string }>({ type: "object", properties: { name: { type: "string" } }, required: ["name"] }),
      execute: async () => ({ score: 712 }),
    }),
    record_decision: tool({
      description: "Record the decision in the loan system.",
      inputSchema: jsonSchema<{ name: string }>({ type: "object", properties: { name: { type: "string" } }, required: ["name"] }),
      execute: async () => ({ recorded: true }),
    }),
  };
  // A review service in miniature: a definition is a draft until approved; the session that
  // wrote it may still use its own draft.
  const approved = new Set<string>();
  const registered: string[] = [];
  const registry: AgentWorkflowRegistry = {
    defined(record) {
      registered.push(`${record.handle}@${record.revision}`);
      return { note: "Saved as a draft for review.", metadata: { versionId: `draft_${record.revision}` } };
    },
    resolve(records, ctx) {
      return records
        .filter((record) => approved.has(record.handle) || record.sessionId === ctx.sessionId)
        .map((record) => ({ ...record, metadata: { versionId: approved.has(record.handle) ? "live_1" : `draft_${record.revision}` } }));
    },
  };
  const runs: Array<DynamicWorkflowWorldContext & { events: string[] }> = [];
  const world = (ctx: DynamicWorkflowWorldContext): World => {
    const inner = localWorld({ dataDir: ctx.dataDir });
    const run = { ...ctx, events: [] as string[] };
    runs.push(run);
    return {
      ...inner,
      async appendEvent(runId, event) {
        const envelope = await inner.appendEvent(runId, event);
        run.events.push(envelope.type);
        return envelope;
      },
    };
  };
  const { model, calls } = scriptedModel([
    // Session one defines the workflow and runs it now.
    () => toolCall("define_workflow", { ...definition, runWith: { name: "Ada" } }),
    () => undefined,
    // Session two: not approved yet, so it is not a tool here.
    () => undefined,
    // Session three, after approval: it is.
    (offered) => (offered.includes("demo_loan") ? toolCall("demo_loan", { name: "Bo" }) : undefined),
    () => undefined,
  ]);
  const harness = createHarness({
    host: localHost({ dataDir }),
    model,
    tools,
    runtime: { bash: false },
    dynamicWorkflows: dynamicWorkflows({ registry, world }),
  });

  await generateHarness({ harness, session: "first", type: "job", input: {} });
  const defined = toolResults(model.doGenerateCalls[1]?.prompt, "define_workflow")[0] as Record<string, unknown>;
  expect(defined).toMatchObject({ status: "defined", revision: 1, note: "Saved as a draft for review.", run: { status: "completed" } });
  expect(registered).toEqual(["demo_loan@1"]);
  expect(runs[0]).toMatchObject({
    kind: "defined",
    workflowId: "demo.loan",
    handle: "demo_loan",
    sessionId: "first",
    dataDir: join(dataDir, "agent-workflows"),
    revision: 1,
    metadata: { versionId: "draft_1" },
    definition: { id: "demo.loan", policy },
  });
  expect(runs[0]?.events).toContain("RunStarted");
  expect(runs[0]?.events).toContain("RunCompleted");

  await generateHarness({ harness, session: "second", type: "job", input: {} });
  expect(calls.agent[2]).not.toContain("demo_loan");

  approved.add("demo_loan");
  await generateHarness({ harness, session: "third", type: "job", input: {} });
  expect(calls.agent[3]).toContain("demo_loan");
  const ran = toolResults(model.doGenerateCalls[4]?.prompt, "demo_loan")[0] as Record<string, unknown>;
  expect(ran).toMatchObject({ status: "completed", output: "Approved." });
  expect(runs[1]).toMatchObject({ kind: "defined", handle: "demo_loan", sessionId: "third", metadata: { versionId: "live_1" } });
  // The World wraps the same store, so the plan from session one is kept.
  expect(calls.planner).toBe(1);
});

it("define_workflow refuses tools the agent does not have and a schema the runtime cannot use", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "agent-wf-bad-"));
  dirs.push(dataDir);
  const { model } = scriptedModel([
    () => toolCall("define_workflow", { ...definition, tools: ["fetch_credit_report", "send_email"] }, "call_a"),
    () => toolCall("define_workflow", { ...definition, outputSchema: { type: "strng" } }, "call_b"),
    () => undefined,
  ]);
  const harness = createHarness({
    host: localHost({ dataDir }),
    model,
    tools: {
      fetch_credit_report: tool({
        description: "Fetch the applicant's credit report.",
        inputSchema: jsonSchema({ type: "object" }),
        execute: async () => ({ score: 712 }),
      }),
      record_decision: tool({
        description: "Record the decision.",
        inputSchema: jsonSchema({ type: "object" }),
        execute: async () => ({ recorded: true }),
      }),
    },
    runtime: { bash: false },
    dynamicWorkflows: dynamicWorkflows(),
  });

  const result = await generateHarness({ harness, session: "bad", type: "job", input: {} });
  expect(result.status).toBe("completed");
  const results = toolResults(model.doGenerateCalls[2]?.prompt, "define_workflow") as Array<Record<string, unknown>>;
  expect(results[0]).toMatchObject({ status: "failed" });
  expect(String(results[0]?.message)).toContain("send_email");
  expect(results[1]).toMatchObject({ status: "failed" });
  expect(String(results[1]?.message)).toContain("outputSchema");
});

it("dynamicWorkflows({ define: false }) leaves define_workflow out", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "agent-wf-off-"));
  dirs.push(dataDir);
  const { model, calls } = scriptedModel([() => undefined]);
  const harness = createHarness({
    host: localHost({ dataDir }),
    model,
    tools: {},
    runtime: { bash: false },
    dynamicWorkflows: dynamicWorkflows({ define: false }),
  });
  await generateHarness({ harness, session: "off", type: "job", input: {} });
  expect(calls.agent[0]).toContain("run_ad_hoc_plan");
  expect(calls.agent[0]).not.toContain("define_workflow");
});

function textStream(text: string) {
  return {
    stream: new ReadableStream({
      start(controller) {
        for (const part of [
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "0" },
          { type: "text-delta", id: "0", delta: text },
          { type: "text-end", id: "0" },
          { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
        ]) {
          controller.enqueue(part);
        }
        controller.close();
      },
    }),
  } as never;
}

function promptText(prompt: unknown): string {
  return (prompt as ReadonlyArray<{ readonly content: unknown }>)
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : (message.content as ReadonlyArray<{ readonly text?: string }>).map((part) => part.text ?? "").join(""),
    )
    .join("\n");
}

// The planner prompt carries a valid LWIR skeleton for the workflow; the scripted planner returns it.
function skeletonFrom(prompt: unknown): string {
  const text = promptText(prompt);
  const marker = "no prose or markdown fences:\n";
  const start = text.indexOf("{", text.indexOf(marker));
  return text.slice(start, text.indexOf("\n}", start) + 2);
}

/** The values a tool returned to the model, read from the next model call's prompt. */
function toolResults(prompt: unknown, toolName: string): unknown[] {
  const out: unknown[] = [];
  if (!Array.isArray(prompt)) return out;
  for (const message of prompt) {
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const p = part as { type?: string; toolName?: string; output?: unknown };
      if (p.type !== "tool-result" || p.toolName !== toolName) continue;
      const output = p.output as { value?: unknown } | undefined;
      out.push(output && typeof output === "object" && "value" in output ? output.value : output);
    }
  }
  return out;
}
