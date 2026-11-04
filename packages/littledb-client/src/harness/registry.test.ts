import type { AgentWorkflowRegistry } from "@little-stack/harness";
import { dynamicWorkflows } from "@little-stack/workflow";
import { describe, expect, it, vi } from "vitest";
import { createLittleDB } from "../client.js";
import { fakeLittleDB } from "../test/fake-littledb.js";
import type { AgentWorkflowRecordLike } from "./registry.js";

const ctx = (sessionId: string) => ({ sessionId, turnId: "turn_1" });

function record(overrides: Partial<AgentWorkflowRecordLike> = {}): AgentWorkflowRecordLike {
  return {
    id: "refund.check",
    handle: "refund_check",
    description: "Check whether an order can be refunded.",
    inputSchema: { type: "object", properties: { orderId: { type: "string" } }, required: ["orderId"] },
    outputSchema: { type: "object" },
    tools: ["lookup_order"],
    revision: 1,
    definedAt: "2026-10-01T00:00:00.000Z",
    sessionId: "sess_a",
    ...overrides,
  };
}

function setup(options: { ownDrafts?: boolean; offline?: "none" | "stored" } = {}) {
  const fake = fakeLittleDB();
  const onError = vi.fn();
  const db = createLittleDB({ url: fake.url, apiKey: fake.apiKey, fetch: fake.fetch, onError });
  const registry = db.agentWorkflowRegistry({ harness: "support", cacheTtlMs: 0, ...options });
  return { fake, db, registry, onError };
}

describe("agentWorkflowRegistry", () => {
  it("is a registry dynamicWorkflows takes", () => {
    const { registry } = setup();
    const typed: AgentWorkflowRegistry = registry;
    expect(dynamicWorkflows({ registry }).registry).toBe(typed);
  });

  it("registers a definition as a draft with a proposal, and tells the agent", async () => {
    const { fake, registry } = setup();
    const result = await registry.defined(record(), ctx("sess_a"));
    const sent = fake.requests.find((r) => r.method === "POST" && r.path === "/v1/agent-workflows");
    expect(sent?.body).toEqual({
      harness: "support",
      handle: "refund_check",
      definition: {
        id: "refund.check",
        description: "Check whether an order can be refunded.",
        inputSchema: record().inputSchema,
        outputSchema: { type: "object" },
        tools: ["lookup_order"],
      },
      description: "Check whether an order can be refunded.",
      revision: 1,
      sessionId: "sess_a",
    });
    expect(result.metadata.littledb).toMatchObject({ status: "draft", number: 1, proposalId: expect.stringMatching(/^prp_/u) });
    expect(result.note).toMatch(/waiting for review/u);
    expect(result.note).toMatch(/refund_check/u);
  });

  it("offers a draft only to the session that made it, and the approved version to everyone", async () => {
    const { fake, registry } = setup();
    const mine = record();
    const registered = await registry.defined(mine, ctx("sess_a"));

    const own = await registry.resolve([mine], ctx("sess_a"));
    expect(own).toHaveLength(1);
    expect(own[0]).toMatchObject({ handle: "refund_check", revision: 1, metadata: { littledb: { versionId: registered.metadata.littledb.versionId, status: "draft" } } });
    expect(own[0]).not.toHaveProperty("sessionId");
    expect(await registry.resolve([mine], ctx("sess_b"))).toEqual([]);

    fake.promote("refund_check", registered.metadata.littledb.versionId);
    const other = await registry.resolve([mine], ctx("sess_b"));
    expect(other).toEqual([
      expect.objectContaining({
        id: "refund.check",
        handle: "refund_check",
        revision: 1,
        tools: ["lookup_order"],
        metadata: { littledb: expect.objectContaining({ status: "live", versionId: registered.metadata.littledb.versionId }) },
      }),
    ]);
  });

  it("keeps offering the approved version to other sessions while a revision waits for review", async () => {
    const { fake, registry } = setup();
    const v1 = await registry.defined(record(), ctx("sess_a"));
    fake.promote("refund_check", v1.metadata.littledb.versionId);
    const revised = record({ revision: 2, sessionId: "sess_c", tools: ["lookup_order", "issue_refund"] });
    const v2 = await registry.defined(revised, ctx("sess_c"));
    expect(v2.metadata.littledb.number).toBe(2);

    const forC = await registry.resolve([revised], ctx("sess_c"));
    expect(forC[0]).toMatchObject({ revision: 2, tools: ["lookup_order", "issue_refund"] });
    const forB = await registry.resolve([revised], ctx("sess_b"));
    expect(forB[0]).toMatchObject({ revision: 1, tools: ["lookup_order"] });
  });

  it("says the definition is the approved one when nothing changed", async () => {
    const { fake, registry } = setup();
    const v1 = await registry.defined(record(), ctx("sess_a"));
    fake.promote("refund_check", v1.metadata.littledb.versionId);
    const again = await registry.defined(record({ revision: 2 }), ctx("sess_b"));
    expect(again.note).toMatch(/approved version/u);
    expect(again.metadata.littledb.status).toBe("live");
  });

  it("offers no other session's workflow without LittleDB, and the last list when it has one", async () => {
    const { fake, registry, onError } = setup();
    const v1 = await registry.defined(record(), ctx("sess_a"));
    fake.promote("refund_check", v1.metadata.littledb.versionId);
    expect(await registry.resolve([record()], ctx("sess_b"))).toHaveLength(1);

    fake.override(() => ({ status: 503, body: { error: { code: "unavailable", message: "down" } } }));
    expect(await registry.resolve([record()], ctx("sess_b"))).toHaveLength(1);
    expect(onError).toHaveBeenCalledWith(expect.anything(), { operation: "agent-workflows" });

    const cold = setup();
    cold.fake.override(() => ({ status: 503, body: { error: { code: "unavailable", message: "down" } } }));
    const stored = [record(), record({ id: "other.flow", handle: "other_flow", sessionId: "sess_z" })];
    expect((await cold.registry.resolve(stored, ctx("sess_a"))).map((o) => o.handle)).toEqual(["refund_check"]);
    expect(await cold.registry.resolve(stored, ctx("sess_b"))).toEqual([]);
    const open = setup({ offline: "stored" });
    open.fake.override(() => ({ status: 503, body: { error: { code: "unavailable", message: "down" } } }));
    expect(await open.registry.resolve(stored, ctx("sess_b"))).toHaveLength(2);
  });

  it("throws from defined when LittleDB refuses, so the agent hears it was not registered", async () => {
    const { fake, registry, onError } = setup();
    fake.override((r) => (r.method === "POST" ? { status: 409, body: { error: { code: "conflict", message: "taken" } } } : undefined));
    await expect(registry.defined(record(), ctx("sess_a"))).rejects.toThrow(/taken/u);
    expect(onError).toHaveBeenCalled();
  });

  it("with ownDrafts off, offers only approved versions", async () => {
    const { registry } = setup({ ownDrafts: false });
    const result = await registry.defined(record(), ctx("sess_a"));
    expect(result.note).toMatch(/once it is approved/u);
    expect(await registry.resolve([record()], ctx("sess_a"))).toEqual([]);
  });
});

describe("agent workflows LittleDB is trying out", () => {
  const revised = record({ revision: 2, sessionId: "sess_a", description: "Check refunds, and say why when one is refused." });

  it("routes a share of sessions to the trial candidate, the way LittleDB splits traffic", async () => {
    const { fake, registry } = setup();
    const v1 = await registry.defined(record(), ctx("sess_a"));
    fake.promote("refund_check", v1.metadata.littledb.versionId);
    const v2 = await registry.defined(revised, ctx("sess_a"));
    fake.agentTrial("refund_check", v2.metadata.littledb.versionId, 0.5);

    const statuses = new Map<string, number>();
    for (let i = 0; i < 200; i++) {
      const [offer] = await registry.resolve([], ctx(`sess_${i}`));
      const status = offer?.metadata?.littledb.status ?? "none";
      statuses.set(status, (statuses.get(status) ?? 0) + 1);
    }
    expect(statuses.get("trial")).toBeGreaterThan(60);
    expect(statuses.get("live")).toBeGreaterThan(60);

    // A session keeps what it was offered.
    const first = await registry.resolve([], ctx("sess_7"));
    const again = await registry.resolve([], ctx("sess_7"));
    expect(again[0]?.metadata?.littledb.versionId).toBe(first[0]?.metadata?.littledb.versionId);
  });

  it("bases a redefinition on the version the session was offered", async () => {
    const { fake, registry } = setup();
    const v1 = await registry.defined(record(), ctx("sess_a"));
    fake.promote("refund_check", v1.metadata.littledb.versionId);
    await registry.resolve([], ctx("sess_b"));
    await registry.defined(record({ revision: 2, sessionId: "sess_b", description: "Changed." }), ctx("sess_b"));
    const sent = fake.requests.filter((r) => r.method === "POST" && r.path === "/v1/agent-workflows").at(-1);
    expect(sent?.body).toMatchObject({ baseVersionId: v1.metadata.littledb.versionId, revision: 2 });
  });

  it("traces a run with the version its turn was offered", async () => {
    const { fake, db, registry } = setup();
    const v1 = await registry.defined(record(), ctx("sess_a"));
    fake.promote("refund_check", v1.metadata.littledb.versionId);
    const v2 = await registry.defined(revised, ctx("sess_a"));
    const factory = registry.world(() => ({
      appendEvent: async (runId: string, event: { readonly type: string; readonly payload: Readonly<Record<string, unknown>> }) => ({
        runId,
        type: event.type,
        recordedAt: "2026-10-21T00:00:00.000Z",
        payload: event.payload,
      }),
    }));
    const world = factory({
      kind: "defined",
      handle: "refund_check",
      runId: "run_9",
      dataDir: "/tmp",
      metadata: { littledb: { versionId: v2.metadata.littledb.versionId, status: "trial" } },
    });
    await world.appendEvent("run_9", { type: "RunStarted", payload: { input: {} } });
    await db.flush();
    expect([...fake.traces.values()][0]).toMatchObject({
      workflow: "refund_check",
      workflowOrigin: "agent",
      harness: "support",
      versionId: v2.metadata.littledb.versionId,
      environment: "trial",
    });
  });
});
