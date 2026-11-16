import { describe, expect, it } from "vitest";
import type { IngestBatch } from "../contract.js";
import { createTracingWorld, type WorldLike } from "./tracing-world.js";

function recorder(captureContent = true, fixed = false) {
  const batches: IngestBatch[] = [];
  const uploads: unknown[] = [];
  const inner: WorldLike = { appendEvent: async (runId, event) => ({ runId, ...event, recordedAt: new Date().toISOString() }) };
  const world = createTracingWorld(inner, { workflow: "returns", captureContent, ...(fixed ? { traceId: "fixed" } : {}), metadata: { planHash: "wrong" } }, {
    exporter: { enqueue: (b) => batches.push(b), flush: async () => {}, shutdown: async () => {}, stats: () => ({ queued: 0, sent: 0, dropped: 0 }) },
    onError: () => { throw new Error("callback"); },
    plans: { enqueue: (x: unknown) => uploads.push(x), flush: async () => {}, shutdown: async () => {} },
  });
  const send = (type: string, payload: Record<string, unknown>, run = "run") => world.appendEvent(run, { type, payload });
  const spans = () => batches.flatMap((b) => b.spans ?? []);
  const traces = () => batches.flatMap((b) => b.traces ?? []);
  const latest = (path: string) => spans().filter((s) => s.type === "step" && s.attributes?.stepPath === path).at(-1)!;
  return { send, latest, spans, traces, uploads };
}
const hash = `sha256:${"a".repeat(64)}`;

describe("workflow graph facts", () => {
  it("resends plan metadata on registration without a trigger, and keeps a nested run off the trace", async () => {
    const r = recorder(true, true);
    const plan = { steps: [] };
    await r.send("PlannerDraftedWorkflow", { valid: true, lwirHash: hash, lwir: plan });
    await r.send("WorkflowVersionRegistered", { lwirHash: hash, workflowVersionId: "wfver_1" });
    await r.send("RunStarted", { trigger: { kind: "schedule" } });
    expect(r.traces().at(-1)?.metadata?.planHash).toBe(hash);
    expect(r.uploads).toHaveLength(1);
    expect(await (r.uploads[0] as { read(): Promise<unknown> }).read()).toBe(plan);
    await r.send("WorkflowVersionRegistered", { lwirHash: "nested", workflowVersionId: "wfver_2" }, "nested");
    expect(r.traces().at(-1)?.metadata?.planHash).toBe(hash);
    expect(r.spans().at(-1)?.attributes?.planHash).toBe("nested");
    for (const span of r.spans().filter((s) => s.type === "workflow")) expect(span.attributes?.workflow).toBe("returns");
  });

  it.each([true, false])("records the page's chosen, visit and branch values (capture=%s)", async (capture) => {
    const r = recorder(capture);
    await r.send("StepScheduled", { stepPath: "check-items", uses: "parallel" });
    await r.send("StepAttemptStarted", { stepPath: "check-items", stepId: "check-items", attempt: 1 });
    for (const [index, key] of [[2, "pack"], [0, "jacket"], [1, "stove"]] as const) {
      const branchPath = `check-items[${key}]`;
      await r.send("ParallelBranchScheduled", { stepPath: "check-items", branchPath, branchIndex: index, itemKey: key, attempt: 1 });
      await r.send("StepScheduled", { stepPath: `${branchPath}.lookup`, uses: "tool.call" });
      await r.send("StepAttemptStarted", { stepPath: `${branchPath}.lookup`, stepId: "lookup", attempt: 1 });
      expect(r.latest(`${branchPath}.lookup`).attributes).toMatchObject({ stepId: "lookup", stepKey: "check-items.lookup", uses: "tool.call", branchOf: "check-items", branchIndex: index });
      expect(r.latest(`${branchPath}.lookup`).attributes?.branchKey).toBe(capture ? key : undefined);
      if (index !== 2) await r.send(index === 1 ? "ParallelBranchFailed" : "ParallelBranchCompleted", { stepPath: "check-items", branchPath, branchIndex: index, itemKey: key, attempt: 1 });
    }
    await r.send("StepFailed", { stepPath: "check-items", attempt: 1, error: { message: "aborted" } });
    expect(r.latest("check-items").attributes).toMatchObject({ branchCount: 3, branchFailed: 1, branchRunning: 1 });
    expect(r.latest("check-items").attributes?.branches).toEqual([
      { index: 0, ...(capture ? { key: "jacket" } : {}), status: "ok" },
      { index: 1, ...(capture ? { key: "stove" } : {}), status: "error" },
      { index: 2, ...(capture ? { key: "pack" } : {}), status: "running" },
    ]);
    await r.send("StepScheduled", { stepPath: "route.visit[1]", uses: "decision" });
    await r.send("StepAttemptStarted", { stepPath: "route.visit[1]", stepId: "route", attempt: 2 });
    await r.send("StepCompleted", { stepPath: "route.visit[1]", output: { chosen: "reply" } });
    expect(r.latest("route.visit[1]").attributes).toMatchObject({ stepId: "route", stepKey: "route", uses: "decision", visit: 1, attempt: 2, chosen: "reply" });
    if (!capture) expect(r.latest("route.visit[1]").output).toBeUndefined();
  });

  it("uses delimiter-aware longest branch prefix and isolates retried parallel summaries", async () => {
    const r = recorder();
    await r.send("ParallelBranchScheduled", { stepPath: "outer", branchPath: "outer[a]", branchIndex: 0, itemKey: "a", attempt: 1 });
    await r.send("ParallelBranchScheduled", { stepPath: "outer[a].inner", branchPath: "outer[a].inner@attempt_2[b]", branchIndex: 1, itemKey: "b", attempt: 2 });
    await r.send("StepAttemptStarted", { stepPath: "outer[a].inner@attempt_2[b].work", stepId: "work", attempt: 1 });
    expect(r.latest("outer[a].inner@attempt_2[b].work").attributes).toMatchObject({ branchOf: "outer[a].inner", branchIndex: 1 });
    await r.send("StepAttemptStarted", { stepPath: "outer[a]suffix.work", stepId: "work", attempt: 1 });
    expect(r.latest("outer[a]suffix.work").attributes?.branchOf).toBeUndefined();
    await r.send("ParallelBranchScheduled", { stepPath: "outer", branchPath: "outer@attempt_2[c]", branchIndex: 0, itemKey: "c", attempt: 2 });
    await r.send("StepAttemptStarted", { stepPath: "outer", stepId: "outer", attempt: 2 });
    await r.send("RunFailed", { error: { message: "aborted" } });
    expect(r.latest("outer").attributes).toMatchObject({ branchCount: 1, branchFailed: 0, branchRunning: 1 });
    expect(r.latest("outer").attributes?.branches).toEqual([{ index: 0, key: "c", status: "running" }]);
  });
  it.each([true, false])("preserves retried ancestor paths and derives nested keys from ids (capture=%s)", async (capture) => {
    const r = recorder(capture);
    await r.send("StepAttemptStarted", { stepPath: "outer", stepId: "outer", attempt: 2 });
    await r.send("ParallelBranchScheduled", { stepPath: "outer", branchPath: "outer@attempt_2[a.b]", branchIndex: 0, itemKey: "a.b", attempt: 2 });
    const inner = "outer@attempt_2[a.b].inner";
    await r.send("StepAttemptStarted", { stepPath: inner, stepId: "inner", attempt: 1 });
    await r.send("ParallelBranchScheduled", { stepPath: inner, branchPath: `${inner}[x%2Fy]`, branchIndex: 1, itemKey: "x/y", attempt: 1 });
    const child = `${inner}[x%2Fy].work.visit[1]`;
    await r.send("StepAttemptStarted", { stepPath: child, stepId: "work", attempt: 2 });
    expect(r.latest(child).attributes).toMatchObject({ branchOf: r.latest(inner).attributes?.stepPath, stepKey: "outer.inner.work", visit: 1, attempt: 2 });
    expect(r.latest(inner).attributes).toMatchObject({ branchOf: "outer", stepKey: "outer.inner" });
    expect(r.latest(child).attributes?.planHash).toBeUndefined();
    expect(r.latest(child).attributes?.invocationKey).toBeUndefined();
    if (!capture) expect(r.latest(child).attributes?.branchKey).toBeUndefined();
  });

  it("omits a child's structural key when its group's key is unknown", async () => {
    const r = recorder();
    await r.send("ParallelBranchScheduled", { stepPath: "missing", branchPath: "missing[a]", branchIndex: 0 });
    await r.send("StepAttemptStarted", { stepPath: "missing[a].inner", stepId: "inner" });
    expect(r.latest("missing[a].inner").attributes?.stepKey).toBeUndefined();
    await r.send("ParallelBranchScheduled", { stepPath: "missing[a].inner", branchPath: "missing[a].inner[b]", branchIndex: 0 });
    await r.send("StepAttemptStarted", { stepPath: "missing[a].inner[b].work", stepId: "work" });
    expect(r.latest("missing[a].inner[b].work").attributes?.stepKey).toBeUndefined();
    await r.send("StepAttemptStarted", { stepPath: "no-branch[a].work", stepId: "work" });
    expect(r.latest("no-branch[a].work").attributes?.stepKey).toBeUndefined();
  });

  it.each([true, false])("keeps exact attempt totals beyond the branch list cap (capture=%s)", async (capture) => {
    const r = recorder(capture);
    await r.send("StepScheduled", { stepPath: "batch", uses: "parallel" });
    await r.send("StepAttemptStarted", { stepPath: "batch", stepId: "batch", attempt: 2 });
    // An earlier attempt must not contribute to the current totals.
    await r.send("ParallelBranchFailed", { stepPath: "batch", branchPath: "batch[old]", branchIndex: 0, itemKey: "old", attempt: 1 });
    for (let index = 124; index >= 0; index--) {
      const payload = { stepPath: "batch", branchPath: `batch@attempt_2[item-${index}]`, branchIndex: index, itemKey: `item-${index}`, attempt: 2 };
      await r.send("ParallelBranchScheduled", payload);
      if (index < 120) await r.send("ParallelBranchCompleted", payload);
      else if (index < 123) await r.send("ParallelBranchFailed", payload);
    }
    await r.send("StepFailed", { stepPath: "batch", attempt: 2, error: { message: "partial" } });
    const attrs = r.latest("batch").attributes!;
    expect(attrs).toMatchObject({ branchCount: 125, branchFailed: 3, branchRunning: 2 });
    expect(attrs.branches).toEqual(Array.from({ length: 100 }, (_, index) => ({ index, status: "ok", ...(capture ? { key: `item-${index}` } : {}) })));
  });

  it.each([true, false])("emits a complete zero tuple for an empty parallel summary (capture=%s)", async (capture) => {
    const r = recorder(capture);
    await r.send("StepScheduled", { stepPath: "empty", uses: "parallel" });
    await r.send("StepAttemptStarted", { stepPath: "empty", stepId: "empty", attempt: 1 });
    await r.send("StepCompleted", { stepPath: "empty" });
    expect(r.latest("empty").attributes).toMatchObject({ branches: [], branchCount: 0, branchFailed: 0, branchRunning: 0 });
  });

});
