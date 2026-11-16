import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineWorkflow, localWorld, runWorkflow } from "@little-stack/workflow";
import { tool } from "ai";
import { z } from "zod";
import { afterEach, expect, it, vi } from "vitest";
import { createLittleDB } from "../client.js";
import { fakeLittleDB } from "../test/fake-littledb.js";
import { structuralPlan } from "./plans.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });

function workflow() {
  const calls = new Map<string, number>();
  return defineWorkflow({
    id: "graph-runtime",
    input: z.object({ items: z.array(z.object({ id: z.string() })) }),
    output: z.array(z.unknown()),
    tools: {
      review: tool({ description: "Private review description", inputSchema: z.object({ id: z.string() }), execute: async ({ id }) => {
        if (id === "bad") throw new Error("scripted failed item");
        const n = (calls.get(id) ?? 0) + 1; calls.set(id, n);
        return { passed: n % 2 === 0 };
      } }),
    },
    plan: { steps: [{ id: "batch", uses: "parallel", with: {
      items: "{{ input.items }}", itemKey: "{{ item.id }}", cardinality: { kind: "matches_items" }, maxBranches: 3,
      maxConcurrency: 2, failureMode: "all_settled", fanIn: { order: "input", output: "array" },
    }, output: { mode: "array", schema: { type: "array", items: { type: "object", required: ["itemKey", "status", "artifacts"], properties: { itemKey: {}, status: {}, artifacts: {}, output: {}, error: {} } } } }, steps: [
      { id: "review", uses: "tool.call", maxVisits: 3, with: { tool: "review" }, input: { id: "{{ item.id }}" }, output: { mode: "object", schema: { type: "object" } } },
      { id: "route", uses: "decision", maxVisits: 3, needs: ["review"], with: { cases: [{ when: "{{ steps.review.lastOutput.passed }}", to: "end" }], default: "review" } },
    ] }] },
  });
}

it("runs a real fixed plan with decisions, looping branches and failure; a new client reads the kept plan", async () => {
  const dir = await mkdtemp(join(tmpdir(), "graph-runtime-")); dirs.push(dir);
  const inner = localWorld({ dataDir: dir });
  const fake = fakeLittleDB();
  const make = () => createLittleDB({ url: fake.url, apiKey: fake.apiKey, fetch: fake.fetch, onError: () => {} });
  const db = make();
  const wf = workflow();
  const first = await runWorkflow(wf, { items: [{ id: "good" }, { id: "bad" }] }, { world: db.tracingWorld(inner, { workflow: "graph-runtime" }), runId: "run_graph_1", maxAttempts: 1 });
  await db.flush();
  expect(first.status).toBe("completed");
  const put = fake.requests.filter((r) => r.method === "PUT");
  expect(put).toHaveLength(1);
  const body = put[0]!.body as { plan: Record<string, unknown>; complete: boolean };
  expect(body.complete).toBe(true);
  const traces = [...fake.traces.values()];
  const hash = traces[0]!.metadata?.planHash;
  expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/u);
  const spans = [...fake.spans.values()];
  expect(spans.find((s) => s.type === "workflow")?.attributes).toMatchObject({ planHash: hash, workflow: "graph-runtime" });
  const batch = spans.find((s) => s.type === "step" && s.attributes?.stepPath === "batch")!;
  expect(batch.attributes?.branches).toEqual([{ index: 0, key: "good", status: "ok" }, { index: 1, key: "bad", status: "error" }]);
  const routes = spans.filter((s) => s.type === "step" && s.attributes?.stepId === "route");
  expect(routes.map((s) => s.attributes?.chosen)).toEqual(["review", "end"]);
  expect(routes.map((s) => s.attributes?.visit)).toEqual([0, 1]);
  expect(routes[0]?.attributes).toMatchObject({ uses: "decision", stepKey: "batch.route", branchOf: "batch", branchIndex: 0, branchKey: "good" });
  const projected = structuralPlan(body.plan);
  process.stdout.write(`graph-runtime plan UTF-8 bytes ${JSON.stringify({ complete: Buffer.byteLength(JSON.stringify(body.plan)), incomplete: Buffer.byteLength(JSON.stringify(projected)) })}\n`);
  await db.shutdown();

  const next = make();
  const second = await runWorkflow(wf, { items: [{ id: "good" }, { id: "bad" }] }, { world: next.tracingWorld(inner, { workflow: "graph-runtime", captureContent: false }), runId: "run_graph_2", maxAttempts: 1 });
  await next.flush();
  expect(second.status).toBe("completed");
  const events = await inner.listEvents("run_graph_2");
  expect(events.some((e) => e.type === "PlannerDraftedWorkflow")).toBe(false);
  const puts = fake.requests.filter((r) => r.method === "PUT");
  expect(puts).toHaveLength(2);
  expect(puts[1]!.body).toMatchObject({ complete: false, plan: projected });
  const secondSpans = [...fake.spans.values()].filter((s) => s.traceId === "lw_run_graph_2");
  expect(secondSpans.some((s) => s.attributes?.chosen === "end")).toBe(true);
  for (const s of secondSpans) {
    expect(s.attributes?.branchKey).toBeUndefined();
    if (Array.isArray(s.attributes?.branches)) for (const b of s.attributes.branches) expect(b).not.toHaveProperty("key");
  }
  if (process.env.GRAPH_EVIDENCE_PATH) await writeFile(process.env.GRAPH_EVIDENCE_PATH, JSON.stringify({
    plans: puts.map((p) => p.body), traces: [...fake.traces.values()], spans, secondSpans,
    bytes: { complete: Buffer.byteLength(JSON.stringify(body.plan)), incomplete: Buffer.byteLength(JSON.stringify(projected)),
      completeRequest: Buffer.byteLength(JSON.stringify(puts[0]!.body)), incompleteRequest: Buffer.byteLength(JSON.stringify(puts[1]!.body)) },
  }, null, 2));
  await next.shutdown();
  const oldClient = make();
  const legacy = new Proxy(inner, { get(target, key) {
    if (key === "readWorkflowVersion") return undefined;
    const value: unknown = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  await runWorkflow(wf, { items: [{ id: "good" }, { id: "bad" }] }, { world: oldClient.tracingWorld(legacy, { workflow: "graph-runtime" }), runId: "run_graph_3", maxAttempts: 1 });
  await oldClient.shutdown();
  expect(fake.requests.filter((r) => r.method === "PUT")).toHaveLength(2);
});

it.each(["unreachable", "413"])("plan upload %s cannot fail a real run, even with a throwing onError", async (failure) => {
  const dir = await mkdtemp(join(tmpdir(), "graph-runtime-failure-")); dirs.push(dir);
  const fake = fakeLittleDB();
  const error = vi.fn(() => { throw new Error("callback fails too"); });
  fake.override((r) => {
    if (r.method !== "PUT") return undefined;
    if (failure === "unreachable") throw new TypeError("fetch failed");
    return { status: 413, body: { error: { code: "too_large", message: "too large" } } };
  });
  const db = createLittleDB({ url: fake.url, apiKey: fake.apiKey, fetch: fake.fetch, onError: error });
  const world = db.tracingWorld(localWorld({ dataDir: dir }), { workflow: "graph-runtime" });
  const wf = workflow();
  expect((await runWorkflow(wf, { items: [{ id: "good" }] }, { world, runId: "run_failure_1", maxAttempts: 1 })).status).toBe("completed");
  await db.flush();
  expect(error).toHaveBeenCalledTimes(1);
  expect(error.mock.calls[0]).toEqual([expect.any(Error), { operation: "plan" }]);
  expect((await runWorkflow(wf, { items: [{ id: "good" }] }, { world, runId: "run_failure_2", maxAttempts: 1 })).status).toBe("completed");
  await db.shutdown();
  expect(fake.requests.filter((r) => r.method === "PUT")).toHaveLength(failure === "413" ? 1 : 2);
});


it.each([true, false])("a real retried group preserves structural keys and branch identity (capture=%s)", async (captureContent) => {
  const dir = await mkdtemp(join(tmpdir(), "graph-retry-")); dirs.push(dir);
  const fake = fakeLittleDB();
  const db = createLittleDB({ url: fake.url, apiKey: fake.apiKey, fetch: fake.fetch });
  let calls = 0;
  const wf = defineWorkflow({
    id: "graph-retry", input: z.object({ items: z.array(z.object({ id: z.string() })) }), output: z.array(z.unknown()),
    tools: { work: tool({ description: "scripted retry", inputSchema: z.object({}), execute: async () => {
      if (++calls === 1) throw new Error("retry the group");
      return { ok: true };
    } }) },
    plan: { steps: [{ id: "batch", uses: "parallel", retry: { maxAttempts: 2 }, with: {
      items: "{{ input.items }}", itemKey: "{{ item.id }}", cardinality: { kind: "matches_items" },
      maxBranches: 1, maxConcurrency: 1, failureMode: "fail_fast", fanIn: { order: "input", output: "array" },
    }, output: { mode: "array", schema: { type: "array", items: { type: "object", required: ["itemKey", "status", "artifacts"], properties: { itemKey: {}, status: {}, artifacts: {}, output: {}, error: {} } } } }, steps: [
      { id: "work", uses: "tool.call", retry: { maxAttempts: 1 }, with: { tool: "work" }, input: {}, output: { mode: "object", schema: { type: "object" } } },
    ] }] },
  });
  const result = await runWorkflow(wf, { items: [{ id: "a/b" }] }, {
    world: db.tracingWorld(localWorld({ dataDir: dir }), { workflow: "graph-retry", captureContent }), runId: "run_retried", maxAttempts: 1,
  });
  await db.shutdown();
  expect(result.status).toBe("completed");
  expect(calls).toBe(2);
  const spans = [...fake.spans.values()];
  const groups = spans.filter((s) => s.type === "step" && s.attributes?.stepId === "batch");
  expect(groups.map((s) => s.attributes?.attempt)).toEqual([1, 2]);
  const steps = spans.filter((s) => s.type === "step" && s.attributes?.stepId === "work");
  expect(steps.map((s) => s.attributes?.stepPath)).toEqual(["batch[a%2Fb].work", "batch@attempt_2[a%2Fb].work"]);
  for (const step of steps) {
    expect(step.attributes).toMatchObject({ branchOf: groups[0]!.attributes!.stepPath, stepKey: "batch.work" });
    if (!captureContent) expect(step.attributes?.branchKey).toBeUndefined();
  }
});
