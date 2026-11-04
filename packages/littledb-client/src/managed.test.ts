import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { answerInputRequest, createHarness, generateHarness, harnessToolContext, listInputRequests, localHost, resumeParked } from "@little-stack/harness";
import { defineWorkflow, localWorld, versionedHarnessWorkflow, type World } from "@little-stack/workflow";
import { tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { littleDBFromEnv } from "./client.js";
import type { ClaimedRun, ResolvedModel } from "./contract.js";
import { createModelResolver, ModelUnavailableError } from "./models.js";
import { testLittleDB } from "./testing.js";

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

/** A model that answers with its own name and remembers the system prompts it was sent. */
function slotModel(name: string) {
  const systems: string[] = [];
  const model = new MockLanguageModelV3({
    provider: "test",
    modelId: name,
    doGenerate: async (options) => {
      systems.push(
        options.prompt
          .filter((m) => m.role === "system")
          .map((m) => (typeof m.content === "string" ? m.content : ""))
          .join("\n"),
      );
      return { content: [{ type: "text", text: name }], finishReason: { unified: "stop", raw: "stop" }, usage, warnings: [] };
    },
  });
  return { model, systems };
}

const Support = z.object({ system: z.string().min(1), model: z.enum(["fast", "smart"]) });
const bootstrap = { system: "Code prompt.", model: "fast" as const };

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "littledb-managed-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function setup(options: Parameters<typeof testLittleDB>[0] = {}) {
  const server = testLittleDB(options);
  const fast = slotModel("fast");
  const smart = slotModel("smart");
  const support = server.db.managedHarness({
    slug: "support",
    bootstrap,
    schema: Support,
    models: { fast: fast.model, smart: smart.model },
  });
  const harness = createHarness({
    host: localHost({ dataDir: dir }),
    model: fast.model,
    runtime: { bash: false },
    turnOptions: support.turnOptions,
  });
  return { server, fast, smart, support, harness };
}

const textOf = (result: Awaited<ReturnType<typeof generateHarness>>) => (result.status === "completed" ? result.text : undefined);

describe("managedHarness", () => {
  it("runs each session on its version, and traces the turn with it", async () => {
    const { server, fast, smart, support, harness } = setup();
    const first = await generateHarness({ harness, prompt: "Hi", session: "s1" });
    expect(textOf(first)).toBe("fast");
    expect(fast.systems[0]).toContain("Code prompt.");

    const v2 = server.setLive("harness:support", { system: "LittleDB prompt.", model: "smart" });
    const second = await generateHarness({ harness, prompt: "Hi", session: "s2" });
    expect(textOf(second)).toBe("smart");
    expect(smart.systems[0]).toContain("LittleDB prompt.");
    expect((await support.session("s2")).resolution.versionId).toBe(v2);

    await server.db.flush();
    const rows = [...server.traces.values()];
    expect(rows.find((t) => t.sessionId === "s2")).toMatchObject({ harness: "support", versionId: v2, environment: "production" });
    expect(rows.find((t) => t.sessionId === "s1")?.versionId).toBe(server.versions("harness:support")[0]?.id);
  });

  it("tags a trial session's turns as trial traffic", async () => {
    const { server, smart, harness } = setup();
    await generateHarness({ harness, prompt: "Hi", session: "warmup" });
    const candidate = server.startTrial("harness:support", { system: "Candidate prompt.", model: "smart" }, 1);
    await generateHarness({ harness, prompt: "Hi", session: "in-trial" });
    expect(smart.systems.at(-1)).toContain("Candidate prompt.");
    await server.db.flush();
    expect([...server.traces.values()].find((t) => t.sessionId === "in-trial")).toMatchObject({ versionId: candidate, environment: "trial" });
  });

  it("runs your bootstrap when a version names a model slot the app does not have", async () => {
    const errors: string[] = [];
    const { server, fast, harness } = setup({ onError: (error) => errors.push(String(error)) });
    server.setLive("harness:support", { system: "Wants a model we do not have.", model: "huge" });
    const result = await generateHarness({ harness, prompt: "Hi", session: "s1" });
    expect(textOf(result)).toBe("fast");
    expect(fast.systems[0]).toContain("Code prompt.");
    expect(errors.join("\n")).toMatch(/content schema/u);
  });

  it("keeps answering during an outage without waiting on LittleDB", async () => {
    const { server, fast, harness } = setup({ breakerFailures: 1 });
    server.setDown(true);
    for (const session of ["a", "b", "c"]) {
      expect(textOf(await generateHarness({ harness, prompt: "Hi", session }))).toBe("fast");
    }
    expect(fast.systems.every((s) => s.includes("Code prompt."))).toBe(true);
    expect(server.requests.filter((r) => r.path === "/v1/resolve")).toHaveLength(1);
  });

  it("runs an experiment on the candidate, traced into the run's trace", async () => {
    const { server, smart, support, harness } = setup();
    await generateHarness({ harness, prompt: "Hi", session: "warmup" });
    const run: ClaimedRun = {
      runId: "run_1",
      experimentId: "exp_1",
      traceId: "trc_run_1",
      repetition: 0,
      leaseUntil: new Date(Date.now() + 60_000).toISOString(),
      subject: { kind: "harness", slug: "support" },
      version: { id: "ver_candidate", number: 9, content: { system: "Candidate under test.", model: "smart" } },
      item: { id: "item_1", input: "Can I return shoes after 40 days?" },
    };
    server.queueRun(run);
    const worker = support.evalWorker({
      run: async (claimed) => {
        const result = await generateHarness({ harness, prompt: String(claimed.item?.input), session: `eval-${claimed.runId}` });
        return { output: textOf(result) };
      },
    });
    const summary = await worker.runOnce();
    expect(summary).toEqual({ claimed: 1, completed: 1, failed: 0 });
    expect(smart.systems.at(-1)).toContain("Candidate under test.");
    expect(server.traces.get("trc_run_1")).toMatchObject({ environment: "experiment", experimentId: "exp_1", versionId: "ver_candidate" });
  });

  it("uses a pinned agent version inside a workflow's experiment run, and keeps its traces out of production", async () => {
    const { server, smart, harness } = setup();
    await generateHarness({ harness, prompt: "Hi", session: "warmup" });
    server.queueRun({
      runId: "run_2",
      experimentId: "exp_2",
      traceId: "trc_run_2",
      repetition: 0,
      leaseUntil: new Date(Date.now() + 60_000).toISOString(),
      subject: { kind: "workflow", slug: "refunds" },
      version: { id: "ver_wf", number: 2, content: { steps: {} } },
      item: { id: "item_2", input: "check" },
      pins: [{ kind: "harness", slug: "support", versionId: "ver_fix", content: { system: "The fix being tested.", model: "smart" } }],
    });
    const worker = server.db.evalWorker({
      subjects: ["workflow:refunds"],
      // The workflow's step calls the support agent.
      run: async () => ({ output: textOf(await generateHarness({ harness, prompt: "Is this refundable?", session: "wf-step" })) }),
    });
    expect(await worker.runOnce()).toMatchObject({ completed: 1 });
    expect(smart.systems.at(-1)).toContain("The fix being tested.");
    await server.db.flush();
    expect([...server.traces.values()].find((t) => t.sessionId === "wf-step")).toMatchObject({ versionId: "ver_fix", environment: "experiment" });
  });
});

describe("managedHarness with LittleDB's model", () => {
  it.each(["key", "credits"] as const)("keeps its %s model through promotion, two parks and fresh-client restarts without resolving", async (paidBy) => {
    const original: ResolvedModel = { id: "deepseek/original", paidBy, source: "project" };
    const server = testLittleDB({ agentModel: original });
    const selected: ResolvedModel[] = [];
    const systems: string[] = [];
    const wrong = slotModel("wrong model");
    const originalModel = new MockLanguageModelV3({
      provider: "test", modelId: "original",
      doGenerate: async (options) => {
        systems.push(options.prompt.filter((m) => m.role === "system").map((m) => String(m.content)).join("\n"));
        const stage = options.prompt.filter((m) => m.role === "tool").flatMap((m) => m.content).length + 1;
        return stage <= 2 ? {
          content: [{ type: "tool-call", toolCallId: `approval_${stage}`, toolName: "approve", input: JSON.stringify({ stage }) }],
          finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage, warnings: [],
        } : { content: [{ type: "text", text: "original model" }], finishReason: { unified: "stop", raw: "stop" }, usage, warnings: [] };
      },
    });
    const approve = tool({
      inputSchema: z.object({ stage: z.number() }),
      execute: async ({ stage }, options) => {
        const asked = await harnessToolContext(options).ask!(
          { question: `Approve stage ${stage}?`, options: [{ id: "approve", label: "Approve" }] },
          { key: `stage-${stage}`, wait: true },
        );
        return asked.status === "parked" ? asked.output : `approved ${stage}`;
      },
    });
    const clients: Array<ReturnType<typeof server.connect>> = [];
    const fresh = () => {
      const client = server.connect();
      clients.push(client);
      const managed = client.managedHarness({
        slug: "provider-patient", bootstrap: { system: "Code prompt." },
        resolveModel: (model) => { selected.push(structuredClone(model)); return model.id === original.id ? originalModel : wrong.model; },
      });
      const harness = createHarness({
        host: localHost({ dataDir: dir, sandbox: "in-process" }), model: wrong.model,
        tools: { approve }, humanInput: { tool: false }, runtime: { bash: false }, turnOptions: managed.turnOptions,
      });
      return { managed, harness };
    };
    const version = server.setLive("harness:provider-patient", { system: "Original prompt." });
    let current = fresh();
    expect(await generateHarness({ harness: current.harness, session: "parked-provider", prompt: "Ask twice." })).toMatchObject({ status: "parked" });
    expect(selected).toEqual([original]);
    for (const stage of [1, 2]) {
      server.setLive("harness:provider-patient", { system: `Promoted prompt ${stage}.`, model: "deepseek/replacement" });
      current = fresh();
      const [request] = await listInputRequests({ harness: current.harness, sessionId: "parked-provider" });
      await answerInputRequest({ harness: current.harness, sessionId: "parked-provider", requestId: request!.requestId, answer: { option: "approve" } });
      const resolves = server.requests.filter((r) => r.path === "/v1/resolve").length;
      const { resumed } = await resumeParked({ harness: current.harness, sessionId: "parked-provider" });
      expect(resumed).toHaveLength(1);
      const result = resumed[0]!.result as Awaited<ReturnType<typeof generateHarness>>;
      expect(result.status).toBe(stage === 1 ? "parked" : "completed");
      if (stage === 2) expect(textOf(result)).toBe("original model");
      expect(selected).toEqual(Array.from({ length: stage + 1 }, () => original));
      expect(server.requests.filter((r) => r.path === "/v1/resolve")).toHaveLength(resolves);
      expect((await current.managed.session("parked-provider")).resolution).toMatchObject({ versionId: version, model: original });
    }
    expect(systems).toHaveLength(3);
    for (const system of systems) expect(system).toContain("Original prompt.");
    expect(wrong.systems).toEqual([]);
    for (const client of clients) await client.flush();
    const traces = [...server.traces.values()].filter((trace) => trace.sessionId === "parked-provider");
    expect(traces.length).toBeGreaterThan(0);
    for (const trace of traces) expect(trace.versionId).toBe(version);
    expect(textOf(await generateHarness({ harness: current.harness, session: "next-turn", prompt: "Now use the latest." }))).toBe("wrong model");
    expect(selected.at(-1)).toEqual({ id: "deepseek/replacement", paidBy: "key", source: "version" });
  });

  it("validates pinned descriptors and refuses missing model decisions or a removed resolver without resolving", async () => {
    const server = testLittleDB();
    const managed = () => server.connect().managedHarness({ slug: "patient", bootstrap: { system: "Code prompt." }, resolveModel: () => slotModel("original").model });
    const started = await managed().turnOptions({ sessionId: "s" });
    const snapshot = structuredClone(started.pin) as { littledb: { content: object; version: { model?: ResolvedModel }; model?: ResolvedModel | null } };
    expect(snapshot.littledb.model).toEqual({ id: "deepseek/deepseek-flash", paidBy: "key", source: "project" });
    expect(snapshot.littledb.version.model).toEqual(snapshot.littledb.model);
    const resolves = server.requests.length;
    const legacy = structuredClone(snapshot);
    delete legacy.littledb.model;
    delete legacy.littledb.version.model;
    await expect(managed().turnOptions({ sessionId: "s", resumed: { pin: legacy } })).rejects.toThrow(/no pinned model decision/u);
    for (const bad of [{ id: "fast", paidBy: "key", source: "project" }, { id: "deepseek/x", paidBy: "other", source: "project" }, { id: "deepseek/x", paidBy: "key" }, null]) {
      const pin = structuredClone(snapshot);
      (pin.littledb.version as { model: unknown }).model = bad;
      await expect(managed().turnOptions({ sessionId: "s", resumed: { pin } })).rejects.toThrow(/pinned model decision is invalid/u);
      if (bad !== null) {
        (pin.littledb as { model: unknown }).model = bad;
        await expect(managed().turnOptions({ sessionId: "s", resumed: { pin } })).rejects.toThrow(/pinned model decision is invalid/u);
      }
    }
    const inconsistent = structuredClone(snapshot);
    inconsistent.littledb.model = { id: "deepseek/different", paidBy: "credits", source: "agent" };
    await expect(managed().turnOptions({ sessionId: "s", resumed: { pin: inconsistent } })).rejects.toThrow(/inconsistent pinned model/u);
    const withoutResolver = server.connect().managedHarness({ slug: "patient", bootstrap: { system: "Changed code prompt." } });
    await expect(withoutResolver.turnOptions({ sessionId: "s", resumed: { pin: snapshot } })).rejects.toThrow(/pinned model requires resolveModel/u);
    const deepseek = provider();
    const missingKey = server.connect().managedHarness({
      slug: "patient", bootstrap: { system: "Changed code prompt." },
      resolveModel: createModelResolver({ providers: { deepseek: deepseek.factory }, keys: {}, credits: { baseURL: "https://models.example.test/v1", apiKey: "synthetic" } }),
    });
    await expect(missingKey.turnOptions({ sessionId: "s", resumed: { pin: snapshot } })).rejects.toThrow(/DEEPSEEK_API_KEY is not set/u);
    expect(deepseek.made).toEqual([]);
    expect(server.requests).toHaveLength(resolves);
  });

  it("honors a pinned code-model decision and keeps legacy named slots ahead of a new resolver", async () => {
    const server = testLittleDB();
    const code = server.connect().managedHarness({ slug: "patient", bootstrap: { system: "Code prompt." } });
    const started = await code.turnOptions({ sessionId: "code" });
    expect((started.pin as { littledb: { model: unknown } }).littledb.model).toBeNull();
    const resolver = () => { throw new Error("A code model or slot must not use the resolver."); };
    const addedResolver = server.connect().managedHarness({ slug: "patient", bootstrap: { system: "Changed prompt." }, resolveModel: resolver });
    const continued = await addedResolver.turnOptions({ sessionId: "code", resumed: { pin: started.pin } });
    expect(continued).not.toHaveProperty("model");
    expect((continued.pin as { littledb: { model: unknown } }).littledb.model).toBeNull();
    const fast = slotModel("fast");
    const slots = server.connect().managedHarness({ slug: "slot", bootstrap, models: { fast: fast.model }, resolveModel: resolver });
    const legacy = { littledb: { content: bootstrap } };
    expect((await slots.turnOptions({ sessionId: "slot", resumed: { pin: legacy } })).model).toBe(fast.model);
  });

  /** A provider factory like `createDeepSeek`: remembers how each model was made. */
  function provider() {
    const made: { modelId: string; apiKey?: string; baseURL?: string }[] = [];
    const factory = (settings: { apiKey?: string; baseURL?: string }) => (modelId: string) => {
      made.push({ modelId, ...settings });
      return slotModel(`deepseek:${modelId}`).model;
    };
    return { made, factory };
  }

  function agent(server: ReturnType<typeof testLittleDB>, resolveModel: (m: ResolvedModel) => unknown) {
    const managed = server.db.managedHarness({ slug: "patient", bootstrap: { instructions: "Be a patient." }, resolveModel: resolveModel as never });
    // The agent's code names no model: LittleDB's comes with each turn.
    const harness = createHarness({ host: localHost({ dataDir: dir }), runtime: { bash: false }, turnOptions: managed.turnOptions });
    return { managed, harness };
  }

  it("runs the project's default model on your own key when the code names none", async () => {
    const server = testLittleDB();
    const deepseek = provider();
    const { managed, harness } = agent(server, createModelResolver({ providers: { deepseek: deepseek.factory }, keys: { DEEPSEEK_API_KEY: "sk-test" } }));
    const result = await generateHarness({ harness, prompt: "Hi", session: "s1" });
    expect(textOf(result)).toBe("deepseek:deepseek-flash");
    expect(deepseek.made).toEqual([{ modelId: "deepseek-flash", apiKey: "sk-test" }]);
    expect((await managed.session("s1")).resolution.model).toEqual({ id: "deepseek/deepseek-flash", paidBy: "key", source: "project" });
  });

  it("runs a version's model, and a strict schema doesn't reject LittleDB's model key", async () => {
    const server = testLittleDB();
    const deepseek = provider();
    const managed = server.db.managedHarness({
      slug: "strict",
      bootstrap: { instructions: "Be a patient." },
      schema: z.object({ instructions: z.string() }).strict(),
      resolveModel: createModelResolver({ providers: { deepseek: deepseek.factory }, keys: { DEEPSEEK_API_KEY: "sk-test" } }) as never,
    });
    server.setLive("harness:strict", { instructions: "LittleDB's prompt.", model: "deepseek/deepseek-v9" });
    const session = await managed.session("s1");
    expect(session.resolution).toMatchObject({ mode: "live", content: { instructions: "LittleDB's prompt." }, model: { id: "deepseek/deepseek-v9", source: "version" } });
    expect(deepseek.made).toEqual([{ modelId: "deepseek-v9", apiKey: "sk-test" }]);
  });

  it("sends credit calls to LittleDB's gateway, and fails loudly without a key rather than spending credits", async () => {
    const credits = provider();
    const resolve = createModelResolver({ providers: { deepseek: credits.factory }, keys: {}, credits: { baseURL: "https://models.littledb.test/v1/", apiKey: "ldbak_x" } });
    resolve({ id: "deepseek/deepseek-flash", paidBy: "credits", source: "project" });
    expect(credits.made).toEqual([{ modelId: "deepseek-flash", apiKey: "ldbak_x", baseURL: "https://models.littledb.test/v1/deepseek" }]);
    expect(() => resolve({ id: "deepseek/deepseek-flash", paidBy: "key", source: "project" })).toThrow(/DEEPSEEK_API_KEY is not set/u);
    expect(() => resolve({ id: "openai/gpt-9", paidBy: "key", source: "version" })).toThrow(/no "openai" provider/u);
    expect(() => createModelResolver({ providers: { deepseek: credits.factory } })({ id: "deepseek/x", paidBy: "credits", source: "version" })).toThrow(ModelUnavailableError);
  });

  it("keeps a slot from models ahead of LittleDB's model", async () => {
    const { server, fast, harness } = setup();
    const result = await generateHarness({ harness, prompt: "Hi", session: "slot" });
    expect(textOf(result)).toBe("fast");
    expect(fast.systems).toHaveLength(1);
    expect((await server.db.resolve({ kind: "harness", slug: "support" })).model).toMatchObject({ source: "project" });
  });
});

describe("managedHarness, a parked turn", () => {
  /** A slot model that asks to change the margin, waiting for approval, then answers as `name`. */
  function waitingSlot(name: string) {
    const systems: string[] = [];
    const model = new MockLanguageModelV3({
      provider: "test",
      modelId: name,
      doGenerate: async (options) => {
        systems.push(options.prompt.filter((m) => m.role === "system").map((m) => (typeof m.content === "string" ? m.content : "")).join("\n"));
        return options.prompt.some((m) => m.role === "tool")
          ? { content: [{ type: "text", text: name }], finishReason: { unified: "stop", raw: "stop" }, usage, warnings: [] }
          : {
              content: [{ type: "tool-call", toolCallId: "call_1", toolName: "change", input: JSON.stringify({ to: ".05" }) }],
              finishReason: { unified: "tool-calls", raw: "tool-calls" },
              usage,
              warnings: [],
            };
      },
    });
    return { model, systems };
  }

  const change = tool({
    description: "Change the margin.",
    inputSchema: z.object({ to: z.string() }),
    execute: async ({ to }, options) => {
      const asked = await harnessToolContext(options).ask!(
        { question: `Change the margin to ${to}?`, options: [{ id: "approve", label: "Approve" }] },
        { key: "card", wait: true },
      );
      return asked.status === "parked" ? asked.output : `changed to ${to}`;
    },
  });

  it("continues on the version it parked on after another goes live, and after a restart, without resolving again", async () => {
    const server = testLittleDB();
    const fast = waitingSlot("fast");
    const smart = waitingSlot("smart");
    // Each call is a process: its own client, with nothing cached.
    const clients: Array<ReturnType<typeof server.connect>> = [];
    const managed = () => {
      const client = server.connect();
      clients.push(client);
      return client.managedHarness({ slug: "support", bootstrap, schema: Support, models: { fast: fast.model, smart: smart.model } });
    };
    const harnessOf = (support: ReturnType<typeof managed>) => createHarness({
      host: localHost({ dataDir: dir, sandbox: "in-process" }),
      model: fast.model,
      tools: { change },
      humanInput: { tool: false },
      runtime: { bash: false },
      turnOptions: support.turnOptions,
    });
    const resolves = () => server.requests.filter((r) => r.path === "/v1/resolve").length;

    const v1 = server.setLive("harness:support", { system: "Version one.", model: "fast" });
    const first = await managed().turnOptions({ sessionId: "probe" });
    expect(first.metadata).toEqual({ littledb: { subject: "harness:support", versionId: v1, number: expect.any(Number), mode: "live" } });

    // Parked, then version two goes live, in the same process or across a restart. The same
    // process keeps a session on its version anyway; a restarted one has nothing cached.
    for (const [session, restart] of [["a", false], ["b", true]] as const) {
      server.setLive("harness:support", { system: "Version one.", model: "fast" });
      let support = managed();
      let harness = harnessOf(support);
      expect(await generateHarness({ harness, prompt: "Lower the margin.", session })).toMatchObject({ status: "parked" });
      const parkedOn = (await support.session(session)).resolution.versionId;
      server.setLive("harness:support", { system: "Version two.", model: "smart" });
      if (restart) {
        support = managed();
        harness = harnessOf(support);
      }
      const [request] = await listInputRequests({ harness, sessionId: session });
      await answerInputRequest({ harness, sessionId: session, requestId: request!.requestId, answer: { option: "approve" } });
      const before = resolves();
      const { resumed } = await resumeParked({ harness, sessionId: session });
      expect(textOf(resumed[0]!.result as Awaited<ReturnType<typeof generateHarness>>)).toBe("fast");
      expect(fast.systems.at(-1)).toContain("Version one.");
      expect(resolves()).toBe(before);
      expect((await support.session(session)).resolution.versionId).toBe(parkedOn);
      for (const client of clients) await client.flush();
      const traces = [...server.traces.values()].filter((t) => t.sessionId === session);
      expect(traces.length).toBeGreaterThan(0);
      for (const trace of traces) expect(trace.versionId, session).toBe(parkedOn);
    }
    expect(smart.systems).toEqual([]);
  });

  it("refuses a pin of its own it can't read, and resolves as usual without one", async () => {
    const { server, support } = setup();
    const v2 = server.setLive("harness:support", { system: "LittleDB prompt.", model: "smart" });
    await expect(support.turnOptions({ sessionId: "s", resumed: { pin: { littledb: { content: "not content" } } } })).rejects.toThrow(/pinned/u);
    await expect(support.turnOptions({ sessionId: "s", resumed: { pin: { littledb: { content: bootstrap, version: { mode: "sideways" } } } } }))
      .rejects.toThrow(/pinned/u);
    expect((await support.turnOptions({ sessionId: "s", resumed: { pin: { someoneElse: 1 } } })).metadata.littledb.versionId).toBe(v2);
  });
});

describe("managedWorkflow", () => {
  it("prepares a run's content and traces its World with the version", async () => {
    const server = testLittleDB({ live: { "workflow:refunds": { steps: { decide: { prompt: "LittleDB step prompt.", model: "smart" } } } } });
    const refunds = server.db.managedWorkflow({
      slug: "refunds",
      bootstrap: { steps: { decide: { prompt: "Code step prompt.", model: "fast" } } },
    });
    const run = await refunds.prepare({ stickyKey: "s1" });
    expect(run.content).toMatchObject({ steps: { decide: { prompt: "LittleDB step prompt." } } });
    const appended: string[] = [];
    const world = run.world({
      appendEvent: async (runId: string, event: { readonly type: string; readonly payload: Readonly<Record<string, unknown>> }) => {
        appended.push(event.type);
        return { runId, type: event.type, recordedAt: "2026-10-21T00:00:00.000Z", payload: event.payload };
      },
    });
    await world.appendEvent("r1", { type: "RunStarted", payload: { input: {} } });
    await server.db.flush();
    expect(appended).toEqual(["RunStarted"]);
    expect([...server.traces.values()][0]).toMatchObject({ workflow: "refunds", versionId: run.resolution.versionId, environment: "production" });
  });
});

describe("managedWorkflow resumed runs", () => {
  it("traces a pinned run as the version it started on, without resolving again", async () => {
    const server = testLittleDB({ live: { "workflow:refunds": { steps: { decide: { prompt: "New live prompt.", model: "smart" } } } } });
    const refunds = server.db.managedWorkflow({
      slug: "refunds",
      bootstrap: { steps: { decide: { prompt: "Code step prompt.", model: "fast" } } },
    });
    const first = await refunds.prepare({ stickyKey: "s1" });
    expect(first.version).toMatchObject({ versionId: first.resolution.versionId, mode: "live" });
    const started = { steps: { decide: { prompt: "Old prompt.", model: "fast" } } };
    const resolves = server.requests.length;

    const resumed = await refunds.prepare({ stickyKey: "s1", pinned: { content: started, version: { ...first.version, versionId: "ver_old" } } });

    expect(server.requests.slice(resolves).filter((r) => r.path.includes("resolve"))).toEqual([]);
    expect(resumed.content).toEqual(started);
    expect(resumed.resolution).toMatchObject({ versionId: "ver_old", mode: "live", content: started });
    const world = resumed.world({
      appendEvent: async (runId: string, event: { readonly type: string; readonly payload: Readonly<Record<string, unknown>> }) => ({
        runId,
        type: event.type,
        recordedAt: "2026-10-30T00:00:00.000Z",
        payload: event.payload,
      }),
    });
    await world.appendEvent("r1", { type: "RunStarted", payload: { input: {} } });
    await server.db.flush();
    expect([...server.traces.values()][0]).toMatchObject({ workflow: "refunds", versionId: "ver_old", environment: "production" });
  });

  it("resumes a harness workflow run on its version after another went live, traced as that version", async () => {
    const server = testLittleDB();
    type Notes = { greeting: string; check: boolean };
    const notes = server.db.managedWorkflow<Notes>({ slug: "notes", bootstrap: { greeting: "Hello", check: false } });
    const calls: string[] = [];
    const build = (content: Notes) => {
      const step = (id: string, needs: readonly string[], text: string) => ({
        id,
        ...(needs.length === 0 ? {} : { needs }),
        uses: "tool.call",
        with: { tool: id, args: { text } },
        output: { mode: "json", schema: true },
      });
      const record = (name: string) =>
        tool({ description: name, inputSchema: z.object({ text: z.string() }), execute: async ({ text }) => (calls.push(`${name}:${text}`), { text }) });
      return defineWorkflow({
        id: "notes",
        description: "Write a note.",
        input: z.object({ name: z.string() }),
        tools: { note: record("note"), check: record("check"), send: record("send") },
        plan: {
          steps: [
            step("note", [], `${content.greeting} {{ input.name }}`),
            ...(content.check ? [step("check", ["note"], "check")] : []),
            step("send", [content.check ? "check" : "note"], "send"),
          ],
        } as never,
      });
    };
    // The process dies once `note` completes: every later write fails.
    let crash = true;
    const crashing = (inner: World): World => {
      let dead = false;
      return {
        kind: inner.kind,
        dataDir: inner.dataDir,
        async appendEvent(runId, event) {
          if (dead) throw new Error("process crashed");
          const written = await inner.appendEvent(runId, event);
          if (crash && event.type === "StepCompleted" && event.payload.stepId === "note") dead = true;
          return written;
        },
        listEvents: (runId) => inner.listEvents(runId),
        writeArtifact: (input) => inner.writeArtifact(input),
        readArtifact: (ref) => inner.readArtifact(ref),
        readArtifactManifest: (ref) => inner.readArtifactManifest(ref),
      };
    };
    const ctx = {
      protocolVersion: 1,
      workflowId: "notes",
      workflowHandle: "notes",
      definitionIdentity: "sha256:test",
      toolCallId: "tool_1",
      disposition: "await",
      parentSessionId: "s1",
      parentTurnId: "turn_1",
      originTurnId: "turn_1",
      reservedRunId: "run_notes_tool_1",
      persistence: { dataDir: dir },
      observation: { recordProgress: async () => undefined },
      inheritance: {},
    } as never;
    const adapter = () => versionedHarnessWorkflow(notes, build, { world: () => crashing(localWorld({ dataDir: dir })) });

    expect(await adapter().runForHarness({ name: "Ada" }, ctx)).toMatchObject({ status: "failed", message: "process crashed" });
    const started = server.versions("workflow:notes")[0]!.id;
    crash = false;
    server.setLive("workflow:notes", { greeting: "Hi", check: true });

    expect(await adapter().runForHarness({ name: "Ada" }, ctx)).toMatchObject({ status: "completed" });
    await server.db.flush();
    expect(calls).toEqual(["note:Hello Ada", "send:send"]);
    const traced = [...server.traces.values()].filter((t) => t.workflow === "notes");
    expect(traced.length).toBeGreaterThan(0);
    expect(traced.every((t) => t.versionId === started)).toBe(true);
  });

  it("traces a pinned run without a version as pinned, and refuses one that names a version wrongly", async () => {
    const server = testLittleDB();
    const refunds = server.db.managedWorkflow({ slug: "refunds", bootstrap: { steps: {} } });
    const resumed = await refunds.prepare({ pinned: { content: { steps: { a: 1 } } } });
    expect(resumed.resolution).toMatchObject({ versionId: null, mode: "pinned", content: { steps: { a: 1 } } });
    await expect(refunds.prepare({ pinned: { content: { steps: {} }, version: "ver_1" } })).rejects.toThrow(/not one prepare\(\) returned/u);
    await expect(
      refunds.prepare({ pinned: { content: { steps: {} }, version: { subjectId: null, versionId: 7, number: null, status: null, mode: "live" } } }),
    ).rejects.toThrow(/not one prepare\(\) returned/u);
  });
});

describe("littleDBFromEnv", () => {
  it("runs offline without LITTLEDB_URL: the bootstrap runs and nothing is sent", async () => {
    const db = littleDBFromEnv({}, {});
    expect(db.offline).toBe(true);
    const resolution = await db.resolve({ kind: "harness", slug: "support", bootstrap });
    expect(resolution).toMatchObject({ content: bootstrap, versionId: null, mode: "none" });
    expect(resolution.fallback).toBeUndefined();
    db.ingest({ traces: [{ id: "t1", startTime: Date.now() }] });
    await db.shutdown();
  });

  it("needs an API key with a URL", () => {
    expect(() => littleDBFromEnv({}, { LITTLEDB_URL: "http://localhost:7340" })).toThrow(/LITTLEDB_API_KEY/u);
  });
});
