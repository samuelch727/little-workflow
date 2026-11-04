import { afterEach, describe, expect, it, vi } from "vitest";
import { createLittleDB } from "./client.js";
import type { ClaimedRun } from "./contract.js";
import { fakeLittleDB } from "./test/fake-littledb.js";

function claimed(n: number, overrides: Partial<ClaimedRun> = {}): ClaimedRun {
  return {
    runId: `run_${n}`,
    experimentId: "exp_1",
    traceId: `exp_run_${n}`,
    subjectId: "sub_support",
    itemId: `itm_${n}`,
    versionId: "ver_2",
    repetition: 0,
    attempt: 1,
    leaseUntil: "2026-10-01T00:10:00.000Z",
    subject: { kind: "harness", slug: "support" },
    version: { id: "ver_2", number: 2, content: { system: "Be brief.", model: "fast" }, externalId: null },
    item: { id: `itm_${n}`, input: { question: `q${n}` }, expected: { answer: `a${n}` }, metadata: {} },
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("evalWorker", () => {
  it("runs claimed runs, flushes their traces, then completes them with output and scores", async () => {
    const fake = fakeLittleDB();
    fake.pendingRuns.push(claimed(1), claimed(2));
    const db = createLittleDB({ url: fake.url, apiKey: fake.apiKey, fetch: fake.fetch, flushIntervalMs: 60_000 });
    const seen: unknown[] = [];
    const worker = db.evalWorker({
      subjects: ["harness:support", { kind: "workflow", slug: "orders" }],
      concurrency: 2,
      workerId: "w1",
      run: async (run) => {
        seen.push(run.trace);
        db.ingest({ traces: [{ id: run.traceId, startTime: "2026-10-01T00:00:00.000Z", ...(run.trace.versionId ? { versionId: run.trace.versionId } : {}) }] });
        return { output: { reply: `answer to ${(run.item?.input as { question: string }).question}` }, scores: [{ name: "task_success", value: 1 }] };
      },
    });
    const summary = await worker.runOnce();
    expect(summary).toEqual({ claimed: 2, completed: 2, failed: 0 });
    expect(fake.requests[0]?.body).toEqual({ workerId: "w1", subjects: ["harness:support", "workflow:orders"], limit: 2, leaseMs: 300_000 });
    expect(seen[0]).toEqual({ traceId: "exp_run_1", versionId: "ver_2", environment: "experiment", experimentId: "exp_1", datasetItemId: "itm_1" });
    // Each trace reached LittleDB before its run was completed.
    const order = fake.requests.map((r) => r.path);
    expect(order.indexOf("/v1/ingest")).toBeLessThan(order.indexOf("/v1/worker/runs/run_1/complete"));
    expect(fake.traces.has("exp_run_1")).toBe(true);
    expect(fake.completions.find((c) => c.runId === "run_2")?.body).toEqual({
      workerId: "w1",
      attempt: 1,
      traceId: "exp_run_2",
      output: { reply: "answer to q2" },
      scores: [{ name: "task_success", value: 1 }],
    });
  });

  it("completes a run that threw with its error, so LittleDB can retry it", async () => {
    const fake = fakeLittleDB();
    fake.pendingRuns.push(claimed(1));
    const db = createLittleDB({ url: fake.url, apiKey: fake.apiKey, fetch: fake.fetch });
    const worker = db.evalWorker({
      subjects: ["harness:support"],
      run: async () => {
        throw new Error("model quota exceeded");
      },
    });
    expect(await worker.runOnce()).toEqual({ claimed: 1, completed: 0, failed: 1 });
    expect(fake.completions[0]).toEqual({ runId: "run_1", body: { workerId: expect.any(String), attempt: 1, traceId: "exp_run_1", error: "model quota exceeded" } });
  });

  it("names its claim, the worker id and the attempt, on every heartbeat and completion", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const fake = fakeLittleDB();
    fake.pendingRuns.push(claimed(1, { attempt: 2 }));
    const db = createLittleDB({ url: fake.url, apiKey: fake.apiKey, fetch: fake.fetch });
    let finish = () => {};
    const worker = db.evalWorker({
      subjects: ["harness:support"],
      workerId: "w1",
      leaseMs: 30_000,
      run: () =>
        new Promise((resolve) => {
          finish = () => resolve({ output: "ok", scores: [{ name: "exact", value: 1 }] });
        }),
    });
    const once = worker.runOnce();
    await vi.waitFor(() => expect(fake.requests.some((r) => r.path === "/v1/worker/claim")).toBe(true));
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.waitFor(() => expect(fake.heartbeats).toEqual(["run_1"]));
    finish();
    expect(await once).toEqual({ claimed: 1, completed: 1, failed: 0 });
    expect(fake.requests.find((r) => r.path === "/v1/worker/runs/run_1/heartbeat")?.body).toEqual({ workerId: "w1", attempt: 2 });
    expect(fake.completions[0]?.body).toEqual({ workerId: "w1", attempt: 2, traceId: "exp_run_1", output: "ok", scores: [{ name: "exact", value: 1 }] });
  });

  it("sends only its worker id to a server that hands out no attempt", async () => {
    const fake = fakeLittleDB();
    const { attempt: _attempt, ...older } = claimed(1);
    fake.pendingRuns.push(older);
    const db = createLittleDB({ url: fake.url, apiKey: fake.apiKey, fetch: fake.fetch });
    const worker = db.evalWorker({ subjects: ["harness:support"], workerId: "w1", run: async () => ({ output: "ok" }) });
    expect(await worker.runOnce()).toEqual({ claimed: 1, completed: 1, failed: 0 });
    expect(fake.completions[0]?.body).toEqual({ workerId: "w1", traceId: "exp_run_1", output: "ok" });
  });

  it("drops a run whose completion LittleDB refused because another worker has it now", async () => {
    const fake = fakeLittleDB();
    fake.pendingRuns.push(claimed(1));
    fake.override((r) =>
      r.path.endsWith("/complete") ? { status: 409, body: { error: { code: "lease_lost", message: "This run is no longer claimed by you." } } } : undefined,
    );
    const errors: unknown[] = [];
    const db = createLittleDB({ url: fake.url, apiKey: fake.apiKey, fetch: fake.fetch, onError: (error) => errors.push(error) });
    let signal: AbortSignal | undefined;
    const worker = db.evalWorker({
      subjects: ["harness:support"],
      run: async (run) => {
        signal = run.signal;
        return { output: "too late" };
      },
    });
    expect(await worker.runOnce()).toEqual({ claimed: 1, completed: 0, failed: 1 });
    // Not retried, not reported as an error: the run is the other worker's.
    expect(fake.requests.filter((r) => r.path.endsWith("/complete"))).toHaveLength(1);
    expect(signal?.aborted).toBe(true);
    expect(errors).toEqual([]);
  });

  it("aborts a run whose lease LittleDB gave away, and does not complete it", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const fake = fakeLittleDB();
    fake.pendingRuns.push(claimed(1));
    fake.override((r) =>
      r.path.endsWith("/heartbeat") ? { status: 409, body: { error: { code: "lease_lost", message: "This run is no longer claimed by you." } } } : undefined,
    );
    const db = createLittleDB({ url: fake.url, apiKey: fake.apiKey, fetch: fake.fetch });
    let aborted = false;
    const worker = db.evalWorker({
      subjects: ["harness:support"],
      leaseMs: 30_000,
      run: (run) =>
        new Promise((resolve) => {
          run.signal.addEventListener("abort", () => {
            aborted = true;
            resolve({ output: "too late" });
          });
        }),
    });
    const once = worker.runOnce();
    await vi.waitFor(() => expect(fake.requests.some((r) => r.path === "/v1/worker/claim")).toBe(true));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await once).toEqual({ claimed: 1, completed: 0, failed: 1 });
    expect(aborted).toBe(true);
    expect(fake.completions).toEqual([]);
  });

  it("polls until stopped, keeping at most `concurrency` runs in flight", async () => {
    const fake = fakeLittleDB();
    fake.pendingRuns.push(claimed(1), claimed(2), claimed(3));
    const db = createLittleDB({ url: fake.url, apiKey: fake.apiKey, fetch: fake.fetch });
    let running = 0;
    let peak = 0;
    const worker = db.evalWorker({
      subjects: ["harness:support"],
      concurrency: 2,
      pollIntervalMs: 5,
      run: async () => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, 10));
        running -= 1;
        return { scores: [{ name: "ok", value: 1 }] };
      },
    });
    const loop = worker.start();
    await vi.waitFor(() => expect(fake.completions).toHaveLength(3), { timeout: 2_000 });
    await worker.stop();
    await loop;
    expect(peak).toBe(2);
    expect(fake.completions.map((c) => c.runId).sort()).toEqual(["run_1", "run_2", "run_3"]);
  });

  it("needs a subject", () => {
    const db = createLittleDB({ url: "http://x", apiKey: "k" });
    expect(() => db.evalWorker({ subjects: [], run: async () => {} })).toThrow(/subject/u);
  });
});
