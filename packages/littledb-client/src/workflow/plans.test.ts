import { describe, expect, it, vi } from "vitest";
import { createPlanUploads, structuralPlan } from "./plans.js";
import { createTransport } from "../http.js";
import { fakeLittleDB } from "../test/fake-littledb.js";
import { createLittleDB } from "../client.js";
import { testLittleDB } from "../testing.js";

const hash = `sha256:${"a".repeat(64)}`;
const plan = { apiVersion: "littleworkflow.dev/v0.1", kind: "Workflow", metadata: { name: "graph", description: "private" }, input: { schema: {} }, output: { schema: {} }, steps: [{ id: "one", uses: "code.run", input: "private", with: { source: "private" } }] };
const task = (complete = true, workflow = "graph") => ({ workflow, hash, workflowVersionId: "wfver_one", complete, read: async () => plan });
const setup = () => {
  const fake = fakeLittleDB();
  const errors = vi.fn();
  const uploads = createPlanUploads(createTransport({ ...fake }), errors);
  return { fake, errors, uploads };
};
const puts = (fake: ReturnType<typeof fakeLittleDB>) => fake.requests.filter((r) => r.method === "PUT");

describe("plan uploads", () => {
  it("defers reads, shares in-flight work, and flush includes queued reads", async () => {
    const { fake, uploads } = setup();
    const read = vi.fn(async () => plan);
    uploads.enqueue({ ...task(), read });
    uploads.enqueue({ ...task(), read });
    expect(read).not.toHaveBeenCalled();
    await uploads.flush();
    expect(read).toHaveBeenCalledTimes(1);
    expect(puts(fake)).toHaveLength(1);
    uploads.enqueue(task());
    await uploads.flush();
    expect(puts(fake)).toHaveLength(1);
  });
  it("upgrades queued incomplete uploads and isolates workflow slugs", async () => {
    const { fake, uploads } = setup();
    uploads.enqueue(task(false));
    uploads.enqueue(task(true));
    uploads.enqueue(task(true, "other"));
    await uploads.flush();
    expect(puts(fake)).toHaveLength(3);
    expect([...fake.plans.values()].map((p) => p.complete)).toEqual([true, true]);
    uploads.enqueue(task(false));
    await uploads.flush();
    expect(puts(fake)).toHaveLength(3);
  });
  it.each([400, 413])("reports %s once, contains throwing onError, and never retries remembered refusal", async (status) => {
    const fake = fakeLittleDB();
    fake.override((r) => r.method === "PUT" ? { status, body: { error: { code: "invalid" } } } : undefined);
    const errors = vi.fn((_error: unknown, _context: { operation: string }) => { throw new Error("caller error"); });
    const uploads = createPlanUploads(createTransport({ ...fake }), errors);
    uploads.enqueue(task());
    await uploads.flush();
    uploads.enqueue(task());
    await uploads.shutdown();
    expect(puts(fake)).toHaveLength(1);
    expect(errors).toHaveBeenCalledTimes(1);
    expect(errors.mock.calls[0]?.[1]).toEqual({ operation: "plan" });
  });
  it("retries transient failure only on a later run and silently ignores missing plans", async () => {
    const { fake, errors, uploads } = setup();
    fake.override((r) => r.method === "PUT" ? { status: 503, body: {} } : undefined);
    uploads.enqueue(task());
    await uploads.flush();
    expect(errors).toHaveBeenCalledTimes(1);
    fake.clearOverrides();
    uploads.enqueue(task());
    await uploads.flush();
    expect(puts(fake)).toHaveLength(2);
    uploads.enqueue({ ...task(true, "missing"), read: async () => { throw new Error("missing"); } });
    await uploads.flush();
    expect(errors).toHaveBeenCalledTimes(1);
    expect(puts(fake)).toHaveLength(2);
  });
  it("shutdown waits for deferred reads and refuses future work", async () => {
    const { fake, uploads } = setup();
    uploads.enqueue(task());
    await uploads.shutdown();
    expect(puts(fake)).toHaveLength(1);
    uploads.enqueue(task(true, "late"));
    await uploads.flush();
    expect(puts(fake)).toHaveLength(1);
  });
  it("remembers at most the last 500 stored identities", async () => {
    const { fake, uploads } = setup();
    for (let i = 0; i <= 500; i++) { uploads.enqueue(task(true, `workflow-${i}`)); await uploads.flush(); }
    uploads.enqueue(task(true, "workflow-0"));
    await uploads.flush();
    expect(puts(fake)).toHaveLength(502);
  });
  it("bounds queued reads while the server stalls", async () => {
    const { uploads, errors } = setup();
    const reads: (() => void)[] = [];
    for (let i = 0; i < 501; i++) uploads.enqueue({ ...task(true, String(i)), read: async () => { await new Promise<void>((resolve) => reads.push(resolve)); return plan; } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(reads).toHaveLength(500);
    expect(errors).toHaveBeenCalledTimes(1);
    for (const resolve of reads) resolve();
    await uploads.shutdown();
  });
  it("client lifecycle covers plans and wrappers share its cache", async () => {
    const fake = fakeLittleDB();
    const db = createLittleDB({ ...fake, flushIntervalMs: 60_000 });
    const inner = { appendEvent: async (runId: string, event: { type: string; payload: Readonly<Record<string, unknown>> }) => ({ runId, ...event, recordedAt: new Date().toISOString() }), readWorkflowVersion: async () => ({ lwir: plan }) };
    const one = db.tracingWorld(inner, { workflow: "graph" });
    const two = db.tracingWorld(inner, { workflow: "graph" });
    await one.appendEvent("one", { type: "WorkflowVersionRegistered", payload: { workflowVersionId: "wfver_one", lwirHash: hash } });
    await two.appendEvent("two", { type: "WorkflowVersionRegistered", payload: { workflowVersionId: "wfver_one", lwirHash: hash } });
    await db.shutdown();
    expect(puts(fake)).toHaveLength(1);
    expect(fake.traces.get("lw_one")?.metadata?.planHash).toBe(hash);
    expect(fake.traces.get("lw_two")?.metadata?.planHash).toBe(hash);
  });
});

it("projects only allowed structural leaves, including nested steps", () => {
  const projected = structuralPlan({ ...plan, steps: [{ id: "route", uses: "decision", needs: ["before"], maxVisits: 2, description: "private", with: { model: "model", tool: "tool", cases: [{ when: "private", to: "next", description: "private" }], default: "end", system: "private", items: "private", itemKey: "private", maxConcurrency: 2, failureMode: "all_settled", fanIn: { outputStep: "last", secret: "private" } }, steps: plan.steps }] });
  expect(JSON.stringify(projected)).not.toContain("private");
  expect(projected).toEqual({ apiVersion: plan.apiVersion, kind: plan.kind, metadata: { name: "graph" }, steps: [{ id: "route", uses: "decision", needs: ["before"], maxVisits: 2, with: { model: "model", tool: "tool", cases: [{ to: "next" }], default: "end", maxConcurrency: 2, failureMode: "all_settled", fanIn: { outputStep: "last" } }, steps: [{ id: "one", uses: "code.run" }] }] });
});

it("testLittleDB exposes plans and preserves per-slug complete upgrade and reads", async () => {
  const server = testLittleDB();
  await server.db.request("PUT", `/workflow-plans/${hash}`, { ...task(false), plan: structuralPlan(plan) });
  await server.db.request("PUT", `/workflow-plans/${hash}`, { ...task(true, "other"), plan });
  expect(server.plans.size).toBe(2);
  expect(await server.db.request("GET", `/workflow-plans/${hash}?workflow=absent`)).toMatchObject({ complete: true, workflow: "other" });
  expect(await server.db.request("GET", `/workflow-plans/${hash}?workflow=graph`)).toMatchObject({ complete: false, workflow: "graph" });
  await server.db.shutdown();
});

it("fake checks consumed shape fields and gives full/projected plans the same shape hash", async () => {
  const server = testLittleDB();
  const full = { ...plan, steps: [{ id: "route", uses: "decision", needs: ["z", "a"], maxVisits: 2, with: { cases: [{ when: "secret", to: "again" }], default: "end", model: "fast" } }] };
  const one = await server.db.request<{ shapeHash: string }>("PUT", `/workflow-plans/${hash}`, { workflow: "one", workflowVersionId: "wfver_one", complete: true, plan: full });
  const two = await server.db.request<{ shapeHash: string }>("PUT", `/workflow-plans/${hash}`, { workflow: "two", workflowVersionId: "wfver_one", complete: false, plan: structuralPlan(full) });
  expect(one.shapeHash).toBe(two.shapeHash);
  for (const step of [{ id: "x", uses: "decision", with: { cases: [{ to: 3 }] } }, { id: "x", uses: "tool.call", needs: "a" }, { id: "x", uses: "tool.call", maxVisits: 0 }, { id: "x", uses: "tool.call", with: { tool: {} } }]) {
    await expect(server.db.request("PUT", `/workflow-plans/${hash}`, { workflow: "bad", workflowVersionId: "wfver_one", complete: true, plan: { steps: [step] } })).rejects.toMatchObject({ status: 400 });
  }
  await server.db.shutdown();
});

it("remembers permanent local projection bounds without repeatedly reporting", async () => {
  const { uploads, errors, fake } = setup();
  let step: Record<string, unknown> = { id: "leaf", uses: "code.run" };
  for (let i = 0; i < 4; i++) step = { id: `level-${i}`, uses: "parallel", steps: [step] };
  const input = { ...task(false), read: async () => ({ steps: [step] }) };
  uploads.enqueue(input);
  await uploads.flush();
  uploads.enqueue(input);
  await uploads.flush();
  expect(errors).toHaveBeenCalledTimes(1);
  expect(puts(fake)).toHaveLength(0);
});

it("lists up to fifty plans by default, omits bodies, and returns empty for an unknown workflow", async () => {
  const server = testLittleDB();
  for (let i = 0; i < 51; i++) await server.db.request("PUT", `/workflow-plans/sha256:${i.toString(16).padStart(64, "0")}`, { workflow: "many", workflowVersionId: "wfver_one", complete: true, plan });
  const result = await server.db.request<{ plans: unknown[] }>("GET", "/workflow-plans?workflow=many");
  expect(result.plans).toHaveLength(50);
  for (const row of result.plans) expect(row).not.toHaveProperty("plan");
  expect(await server.db.request("GET", "/workflow-plans?workflow=absent")).toEqual({ plans: [] });
  await expect(server.db.request("GET", "/workflow-plans")).rejects.toMatchObject({ status: 400 });
  await server.db.shutdown();
});
