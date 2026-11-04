import { describe, expect, it } from "vitest";
import { jsonSchema, tool } from "ai";
import { mergedTurnTools } from "../execution/turn-tools.js";
import {
  createAgentWorkflowTools,
  createDefineWorkflowTool,
  offeredAgentWorkflows,
  type AgentWorkflowToolsConfig,
} from "./agent-workflow-tools.js";
import { readAgentWorkflows, writeAgentWorkflow, type AgentWorkflowRecord } from "./agent-workflows-store.js";
import type { AgentWorkflowBindings, AgentWorkflowDefinition, AgentWorkflowRegistry } from "./types.js";

const lookup = tool({
  description: "Look up an application.",
  inputSchema: jsonSchema<unknown>({ type: "object", additionalProperties: true }),
  execute: async (a: unknown) => a,
});

const HARNESS_DIR = "/persistent/dynamic-plans";

const definition = {
  id: "lending.preapproval",
  description: "Pre-approve one application.",
  inputSchema: { type: "object", properties: { applicationId: { type: "string" } }, required: ["applicationId"] },
  outputSchema: { type: "object" },
  tools: ["lookup"],
  policy: "Refer anything the policy does not cover.",
};

function record(overrides: Partial<AgentWorkflowRecord> = {}): AgentWorkflowRecord {
  return {
    ...definition,
    handle: "lending_preapproval",
    revision: 1,
    definedAt: "2026-10-14T00:00:00.000Z",
    sessionId: "s0",
    ...overrides,
  };
}

/** A factory that records what it was asked to build and runs every workflow to `{ ok: true }`. */
function stubFactory() {
  const built: Array<{ definition: AgentWorkflowDefinition; bindings: AgentWorkflowBindings }> = [];
  const runs: Array<{ input: unknown; dataDir: string; runId: string }> = [];
  return {
    built,
    runs,
    factory: {
      compile: () => {
        throw new Error("not used");
      },
      define(definition: AgentWorkflowDefinition, bindings: AgentWorkflowBindings) {
        built.push({ definition, bindings });
        return {
          ok: true as const,
          workflow: {
            id: definition.id,
            executionMode: "inline" as const,
            definitionIdentity: "sha256:x",
            inputSchema: { kind: "json-schema" as const, schema: definition.inputSchema },
            async runForHarness(input: unknown, ctx: { persistence: { dataDir: string }; reservedRunId: string }) {
              runs.push({ input, dataDir: ctx.persistence.dataDir, runId: ctx.reservedRunId });
              return { protocolVersion: 1 as const, status: "completed" as const, runId: ctx.reservedRunId, output: { ok: true } };
            },
          },
        };
      },
    },
  };
}

function config(
  factory: ReturnType<typeof stubFactory>["factory"],
  overrides: Partial<AgentWorkflowToolsConfig> = {},
): AgentWorkflowToolsConfig {
  return {
    sessionId: "s1",
    turnId: "t1",
    originTurnId: "t1",
    dataDir: "s1/dyn",
    dynamic: {
      factory: factory as never,
      exclude: [],
      limits: { maxSteps: 8, maxRuntimeMs: 120_000 },
      models: { fast: { provider: "test", modelId: "fast" } },
      define: true,
    },
    parentSnapshot: { tools: { lookup }, mcpTools: {} },
    model: { provider: "test", modelId: "agent" } as never,
    authoredPlansHarnessDir: HARNESS_DIR,
    agentWorkflowsDataDir: "/host/agent-workflows",
    records: [],
    takenToolNames: () => new Set(["lookup", "run_ad_hoc_plan", "search_authored_plans", "define_workflow"]),
    nowIso: () => "2026-10-14T01:00:00.000Z",
    ...overrides,
  };
}

describe("define_workflow", () => {
  it("stores the definition, counts revisions and runs it now with runWith", async () => {
    const stub = stubFactory();
    const files = fileStub();
    const { define_workflow } = createDefineWorkflowTool(config(stub.factory));

    const first = await define_workflow!.execute!({ ...definition, runWith: { applicationId: "APP-1" } }, { toolCallId: "call_0", files } as never);
    expect(first).toMatchObject({
      status: "defined",
      id: "lending.preapproval",
      tool: "lending_preapproval",
      revision: 1,
      run: { status: "completed", output: { ok: true } },
    });
    // It runs in the host-wide store, and the run id is scoped to this session, turn and call.
    expect(stub.runs).toEqual([{ input: { applicationId: "APP-1" }, dataDir: "/host/agent-workflows", runId: expect.stringMatching(/^run_lending_preapproval_[0-9a-f]{12}$/u) }]);
    expect(stub.built[0]?.bindings).toMatchObject({
      tools: { lookup },
      models: { default: { modelId: "agent" }, fast: { modelId: "fast" } },
      planner: { modelId: "agent" },
    });

    const second = await define_workflow!.execute!({ ...definition, description: "Changed." }, { toolCallId: "call_1", files } as never);
    expect(second).toMatchObject({ status: "defined", revision: 2 });
    expect(second).not.toHaveProperty("run");
    const stored = await readAgentWorkflows(files, HARNESS_DIR);
    expect(stored.map((r) => [r.handle, r.revision, r.description])).toEqual([["lending_preapproval", 2, "Changed."]]);
    expect([...files.store.keys()].filter((path) => path.includes("/history/")).sort()).toEqual([
      `${HARNESS_DIR}/workflows/history/lending_preapproval.r1.json`,
      `${HARNESS_DIR}/workflows/history/lending_preapproval.r2.json`,
    ]);
  });

  it("refuses an id whose tool name is taken, a bad id, tools the agent lacks, and a non-object input schema", async () => {
    const stub = stubFactory();
    const files = fileStub();
    const { define_workflow } = createDefineWorkflowTool(config(stub.factory));
    const call = (args: Record<string, unknown>) =>
      define_workflow!.execute!({ ...definition, ...args } as never, { toolCallId: "call_x", files } as never) as Promise<Record<string, unknown>>;

    expect(await call({ id: "lookup" })).toMatchObject({ status: "failed", message: expect.stringContaining("already one of your tools") });
    expect(await call({ id: "lending..x" })).toMatchObject({ status: "failed", message: expect.stringContaining("letters, digits") });
    expect(await call({ id: "start.loan" })).toMatchObject({ status: "failed", message: expect.stringContaining("reserved") });
    expect(await call({ tools: ["lookup", "send_email"] })).toMatchObject({ status: "failed", message: expect.stringContaining("send_email") });
    expect(await call({ inputSchema: { type: "string" } })).toMatchObject({ status: "failed", message: expect.stringContaining("inputSchema") });
    expect(stub.built).toHaveLength(0);
    expect(files.store.size).toBe(0);
  });

  it("limits the steps to the model slots the definition names", async () => {
    const stub = stubFactory();
    const files = fileStub();
    const { define_workflow } = createDefineWorkflowTool(config(stub.factory));
    expect(define_workflow?.description).toContain("default (your own model), fast");

    expect(await define_workflow!.execute!({ ...definition, models: ["fast"] }, { toolCallId: "c1", files } as never)).toMatchObject({ status: "defined" });
    expect(stub.built[0]?.bindings.models).toEqual({ fast: { provider: "test", modelId: "fast" } });
    expect((await readAgentWorkflows(files, HARNESS_DIR))[0]?.models).toEqual(["fast"]);

    expect(await define_workflow!.execute!({ ...definition, models: ["deep"] }, { toolCallId: "c2", files } as never)).toMatchObject({
      status: "failed",
      message: expect.stringContaining("default, fast"),
    });
  });

  it("may redefine a workflow it defined earlier even though its tool is offered", async () => {
    const stub = stubFactory();
    const files = fileStub();
    await writeAgentWorkflow(files, HARNESS_DIR, record());
    const { define_workflow } = createDefineWorkflowTool(
      config(stub.factory, {
        records: [record()],
        takenToolNames: () => new Set(["lookup", "lending_preapproval"]),
      }),
    );
    expect(await define_workflow!.execute!(definition as never, { toolCallId: "c", files } as never)).toMatchObject({ status: "defined", revision: 2 });
  });

  it("refuses an id whose tool name the runtime reserves", async () => {
    const stub = stubFactory();
    const files = fileStub();
    const { define_workflow } = createDefineWorkflowTool(config(stub.factory));
    expect(await define_workflow!.execute!({ ...definition, id: "bash" }, { toolCallId: "c", files } as never)).toMatchObject({
      status: "failed",
      message: expect.stringContaining("'bash', which is reserved"),
    });
    expect(files.store.size).toBe(0);
  });

  it("refuses a second id that makes the tool name of another stored workflow", async () => {
    const stub = stubFactory();
    const files = fileStub();
    const { define_workflow } = createDefineWorkflowTool(config(stub.factory));
    expect(await define_workflow!.execute!({ ...definition, id: "lending_preapproval" }, { toolCallId: "c1", files } as never)).toMatchObject({
      status: "defined",
      revision: 1,
    });
    expect(await define_workflow!.execute!(definition as never, { toolCallId: "c2", files } as never)).toMatchObject({
      status: "failed",
      message: expect.stringContaining("belongs to your workflow 'lending_preapproval'"),
    });
    const stored = await readAgentWorkflows(files, HARNESS_DIR);
    expect(stored.map((r) => [r.id, r.revision])).toEqual([["lending_preapproval", 1]]);
  });

  it("numbers a new revision past every kept one even when the current file cannot be read", async () => {
    const stub = stubFactory();
    const files = fileStub();
    await writeAgentWorkflow(files, HARNESS_DIR, record({ revision: 1, description: "First." }));
    await writeAgentWorkflow(files, HARNESS_DIR, record({ revision: 2, description: "Second." }));
    files.store.set(`${HARNESS_DIR}/workflows/lending_preapproval.json`, "{ not json");
    const { define_workflow } = createDefineWorkflowTool(config(stub.factory));

    expect(await define_workflow!.execute!(definition as never, { toolCallId: "c", files } as never)).toMatchObject({ status: "defined", revision: 3 });
    const kept = (revision: number) =>
      JSON.parse(files.store.get(`${HARNESS_DIR}/workflows/history/lending_preapproval.r${revision}.json`)!) as AgentWorkflowRecord;
    expect([kept(1).description, kept(2).description, kept(3).description]).toEqual(["First.", "Second.", definition.description]);
  });

  it("is not offered when define is off or the factory cannot build workflows", () => {
    const stub = stubFactory();
    expect(createDefineWorkflowTool(config(stub.factory, { dynamic: { ...config(stub.factory).dynamic, define: false } }))).toEqual({});
    const { define: _define, ...compileOnly } = stub.factory;
    expect(createDefineWorkflowTool(config(compileOnly as never))).toEqual({});
  });
});

describe("define_workflow with a registry", () => {
  it("tells the registry about each stored revision and passes its note and metadata on", async () => {
    const stub = stubFactory();
    const files = fileStub();
    const defined: Array<{ record: AgentWorkflowRecord; ctx: unknown }> = [];
    const registry: AgentWorkflowRegistry = {
      defined(record, ctx) {
        defined.push({ record, ctx });
        return { note: "Saved as a draft for review.", metadata: { versionId: "ver_1" } };
      },
      resolve: (records) => records,
    };
    const base = config(stub.factory);
    const { define_workflow } = createDefineWorkflowTool({ ...base, dynamic: { ...base.dynamic, registry } });
    expect(define_workflow?.description).toContain("may review it first");

    const result = await define_workflow!.execute!({ ...definition, runWith: { applicationId: "APP-1" } }, { toolCallId: "c1", files } as never);
    expect(result).toMatchObject({ status: "defined", revision: 1, note: "Saved as a draft for review.", run: { status: "completed" } });
    expect(defined).toEqual([
      { record: expect.objectContaining({ id: "lending.preapproval", handle: "lending_preapproval", revision: 1, sessionId: "s1" }), ctx: { sessionId: "s1", turnId: "t1" } },
    ]);
    // The first build only checks the definition; the run `runWith` starts is built for the stored revision.
    expect(stub.built.map((build) => build.bindings.record)).toEqual([
      undefined,
      { handle: "lending_preapproval", revision: 1, metadata: { versionId: "ver_1" } },
    ]);
  });

  it("keeps the definition when the registry fails, and says so", async () => {
    const stub = stubFactory();
    const files = fileStub();
    const base = config(stub.factory);
    const registry: AgentWorkflowRegistry = {
      defined() {
        throw new Error("registry offline");
      },
    };
    const { define_workflow } = createDefineWorkflowTool({ ...base, dynamic: { ...base.dynamic, registry } });
    expect(define_workflow?.description).toContain("From your next message on");
    const result = (await define_workflow!.execute!(definition as never, { toolCallId: "c1", files } as never)) as Record<string, unknown>;
    expect(result).toMatchObject({ status: "defined", revision: 1 });
    expect(String(result.note)).toContain("could not register it (registry offline)");
    expect((await readAgentWorkflows(files, HARNESS_DIR)).map((r) => r.revision)).toEqual([1]);
  });
});

describe("offeredAgentWorkflows", () => {
  const ctx = { sessionId: "s2", turnId: "t9" };

  it("offers every stored definition without a registry or without resolve", async () => {
    const records = [record()];
    expect((await offeredAgentWorkflows(records, undefined, ctx)).offers).toBe(records);
    expect((await offeredAgentWorkflows(records, { defined: () => undefined }, ctx)).offers).toBe(records);
  });

  it("offers what resolve returns, which may be another revision or the registry's own definition", async () => {
    const seen: unknown[] = [];
    const registry: AgentWorkflowRegistry = {
      async resolve(records, context) {
        seen.push({ handles: records.map((r) => r.handle), context });
        return [{ ...definition, handle: "lending_preapproval", revision: 7, metadata: { versionId: "ver_7" } }];
      },
    };
    const { offers, warnings } = await offeredAgentWorkflows([record({ revision: 9 })], registry, ctx);
    expect(seen).toEqual([{ handles: ["lending_preapproval"], context: ctx }]);
    expect(warnings).toEqual([]);
    expect(offers.map((offer) => [offer.handle, offer.revision])).toEqual([["lending_preapproval", 7]]);

    const stub = stubFactory();
    const { tools } = createAgentWorkflowTools(config(stub.factory, { records: offers }));
    expect(tools.lending_preapproval?.description).toContain("revision 7");
    expect(stub.built[0]?.bindings.record).toEqual({ handle: "lending_preapproval", revision: 7, metadata: { versionId: "ver_7" } });
  });

  it("offers nothing, with a warning, when resolve fails", async () => {
    const registry: AgentWorkflowRegistry = {
      resolve() {
        throw new Error("timed out");
      },
    };
    const { offers, warnings } = await offeredAgentWorkflows([record()], registry, ctx);
    expect(offers).toEqual([]);
    expect(warnings.map((warning) => warning.message)).toEqual([expect.stringContaining("could not resolve them (timed out)")]);
    const bad = await offeredAgentWorkflows([record()], { resolve: () => "nope" as never }, ctx);
    expect(bad.offers).toEqual([]);
    expect(bad.warnings).toHaveLength(1);
  });
});

describe("createAgentWorkflowTools", () => {
  it("offers each stored workflow as a tool with its input schema, and runs it in the host-wide store", async () => {
    const stub = stubFactory();
    const { tools, warnings } = createAgentWorkflowTools(config(stub.factory, { records: [record({ revision: 3 })] }));
    expect(warnings).toEqual([]);
    expect(Object.keys(tools)).toEqual(["lending_preapproval"]);
    expect(tools.lending_preapproval?.description).toContain("Pre-approve one application.");
    expect(tools.lending_preapproval?.description).toContain("revision 3");
    const result = await tools.lending_preapproval!.execute!({ applicationId: "APP-2" }, { toolCallId: "call_0" } as never);
    expect(result).toMatchObject({ status: "completed", output: { ok: true } });
    expect(stub.runs[0]?.dataDir).toBe("/host/agent-workflows");
    // The factory is told which revision it builds.
    expect(stub.built[0]?.bindings.record).toEqual({ handle: "lending_preapproval", revision: 3 });
  });

  it("gives the same tool call different run ids in different sessions", async () => {
    const stub = stubFactory();
    for (const sessionId of ["a", "b"]) {
      const { tools } = createAgentWorkflowTools(config(stub.factory, { sessionId, records: [record()] }));
      await tools.lending_preapproval!.execute!({ applicationId: "APP-2" }, { toolCallId: "call_0" } as never);
    }
    expect(new Set(stub.runs.map((run) => run.runId)).size).toBe(2);
  });

  it("leaves out, with a warning, a workflow whose name is taken or whose tools are gone", () => {
    const stub = stubFactory();
    const { tools, warnings } = createAgentWorkflowTools(
      config(stub.factory, {
        records: [
          record(),
          record({ id: "lending.other", handle: "lending_other", tools: ["lookup", "send_email"] }),
          record({ id: "lending.deep", handle: "lending_deep", models: ["deep"] }),
        ],
        takenToolNames: () => new Set(["lookup", "lending_preapproval"]),
      }),
    );
    expect(tools).toEqual({});
    expect(warnings.map((warning) => warning.message)).toEqual([
      expect.stringContaining("'lending_preapproval' is taken"),
      expect.stringContaining("send_email"),
      expect.stringContaining("model slots this agent no longer has (deep)"),
    ]);
  });

  it("leaves out, with a warning, a stored workflow named after a reserved tool, so the turn still assembles", () => {
    const stub = stubFactory();
    const { tools, warnings } = createAgentWorkflowTools(
      config(stub.factory, { records: [record({ id: "bash", handle: "bash" }), record()] }),
    );
    expect(Object.keys(tools)).toEqual(["lending_preapproval"]);
    expect(warnings.map((warning) => warning.message)).toEqual([expect.stringContaining("'bash', which is reserved")]);
    expect(() => mergedTurnTools({ lookup }, tools, "agent-defined workflow")).not.toThrow();
  });

  it("leaves out, with a warning, a stored file define_workflow would refuse or whose build throws", async () => {
    const files = fileStub();
    await writeAgentWorkflow(files, HARNESS_DIR, record());
    // Well-formed JSON in the wrong shape is not loaded at all.
    await writeAgentWorkflow(files, HARNESS_DIR, record({ id: "lending.fast", handle: "lending_fast", models: "fast" as never }));
    expect((await readAgentWorkflows(files, HARNESS_DIR)).map((r) => r.handle)).toEqual(["lending_preapproval"]);

    const stub = stubFactory();
    const factory = {
      ...stub.factory,
      define(definition: AgentWorkflowDefinition, bindings: AgentWorkflowBindings) {
        if (definition.id === "lending.throws") throw new Error("boom");
        return stub.factory.define(definition, bindings);
      },
    };
    const { tools, warnings } = createAgentWorkflowTools(
      config(factory, {
        records: [
          record({ id: "lending.other", handle: "renamed" }),
          record({ id: "lending..x", handle: "lending__x" }),
          record({ id: "lending.text", handle: "lending_text", inputSchema: { type: "string" } }),
          record({ id: "lending.throws", handle: "lending_throws" }),
          record(),
        ],
      }),
    );
    expect(Object.keys(tools)).toEqual(["lending_preapproval"]);
    expect(warnings.map((warning) => warning.message)).toEqual([
      expect.stringContaining("'renamed' does not match its id"),
      expect.stringContaining("letters, digits"),
      expect.stringContaining("inputSchema"),
      expect.stringContaining("'lending.throws' is not offered this turn: boom"),
    ]);
  });
});

function fileStub() {
  const store = new Map<string, string>();
  return {
    store,
    async writeText(p: string, c: string) {
      store.set(p, c);
    },
    async read(p: string) {
      const v = store.get(p);
      if (v === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return { text: () => v };
    },
    // Recursive, like a FileWriter list with `recursive: true`: history files must be skipped.
    async list(prefix: string) {
      return [...store.keys()].filter((k) => k.startsWith(prefix)).map((path) => ({ path }));
    },
  };
}
