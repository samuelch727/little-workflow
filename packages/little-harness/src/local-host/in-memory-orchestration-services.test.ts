import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { WorkflowLaunchTransactionInput } from "../workflow-scheduler/types.js";
import { createFileDurableStore, type LocalHarnessDurableServicesFaultPoint } from "./durable-services.js";
import { createInMemoryDurableStore, type DurableJsonStore } from "./durable-store.js";
import { createInMemoryOrchestrationServices } from "./in-memory-orchestration-services.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

type StoreCase = {
  readonly name: string;
  readonly create: () => Promise<{ readonly store: DurableJsonStore; readonly base: string }>;
};

const storeCases: readonly StoreCase[] = [
  {
    name: "in-memory store",
    create: async () => ({ store: createInMemoryDurableStore(), base: "/contract" }),
  },
  {
    name: "file store",
    create: async () => {
      const base = await mkdtemp(join(tmpdir(), "lh-durable-store-"));
      dirs.push(base);
      return { store: createFileDurableStore(base), base };
    },
  },
];

for (const storeCase of storeCases) {
  it(`${storeCase.name} round-trips JSON, drops undefined fields, and removes idempotently`, async () => {
    const { store, base } = await storeCase.create();
    const path = join(base, "records", "record.json");
    await expect(store.readJson(path)).resolves.toBeUndefined();
    await store.writeJson(path, { keep: 1, drop: undefined, nested: { kept: "x", gone: undefined } });
    await expect(store.readJson(path)).resolves.toEqual({ keep: 1, nested: { kept: "x" } });
    const value = await store.readJson<Record<string, unknown>>(path);
    expect(value !== undefined && "drop" in value).toBe(false);
    expect(value !== undefined && "gone" in (value.nested as Record<string, unknown>)).toBe(false);
    await store.remove(path);
    await expect(store.readJson(path)).resolves.toBeUndefined();
    await store.remove(path);
    await expect(store.readJson(path)).resolves.toBeUndefined();
  });

  it(`${storeCase.name} lists direct children at each nesting depth`, async () => {
    const { store, base } = await storeCase.create();
    await store.writeJson(join(base, "sessions", "s1", "results", "result_1", "record.json"), { ordinal: 1 });
    await store.writeJson(join(base, "sessions", "s1", "results", "result_2", "record.json"), { ordinal: 2 });
    await store.writeJson(join(base, "sessions", "s1", "meta.json"), { highWaterMark: 2 });
    await expect(store.listDir(join(base, "sessions"))).resolves.toEqual(["s1"]);
    expect([...await store.listDir(join(base, "sessions", "s1"))].sort()).toEqual(["meta.json", "results"]);
    expect([...await store.listDir(join(base, "sessions", "s1", "results"))].sort()).toEqual(["result_1", "result_2"]);
    await expect(store.listDir(join(base, "missing"))).resolves.toEqual([]);
  });

  it(`${storeCase.name} serializes same-scope lock sections and interleaves distinct scopes`, async () => {
    const { store } = await storeCase.create();
    const events: string[] = [];
    let releaseFirst = (): void => {};
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = store.withLock(["scope", "a"], async () => {
      events.push("first-start");
      await gate;
      events.push("first-end");
    });
    await waitFor(() => events.includes("first-start"));
    const second = store.withLock(["scope", "a"], async () => {
      events.push("second-start");
    });
    await expect(store.withLock(["scope", "b"], async () => "other-done")).resolves.toBe("other-done");
    expect(events).toEqual(["first-start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(["first-start", "first-end", "second-start"]);
  });

  it(`${storeCase.name} releases the lock after a failed section`, async () => {
    const { store } = await storeCase.create();
    await expect(store.withLock(["scope", "fail"], async () => {
      throw new Error("boom");
    })).rejects.toThrow("boom");
    await expect(store.withLock(["scope", "fail"], async () => "recovered")).resolves.toBe("recovered");
  });
}

it("reserves tasks idempotently by call identity and keeps the first terminal state", async () => {
  const services = createInMemoryOrchestrationServices();
  const first = await services.tasks.reserveTask({ sessionId: "sess_1", kind: "tool", callIdentity: "call_1" });
  const replay = await services.tasks.reserveTask({ sessionId: "sess_1", kind: "tool", callIdentity: "call_1" });
  expect(replay.taskId).toBe(first.taskId);
  await expect(services.tasks.highWaterMark("sess_1")).resolves.toBe(1);
  await services.tasks.markTerminal({ sessionId: "sess_1", taskId: first.taskId }, {
    status: "failed",
    updatedAt: "2026-06-22T00:00:01.000Z",
    terminalCauseCode: "workflow_failed",
    terminalMessage: "failed",
  });
  await services.tasks.markTerminal({ sessionId: "sess_1", taskId: first.taskId }, {
    status: "cancelled",
    updatedAt: "2026-06-22T00:00:02.000Z",
    terminalCauseCode: "cancelled",
    terminalMessage: "cancelled",
  });
  await expect(services.tasks.getTask({ sessionId: "sess_1", taskId: first.taskId })).resolves.toMatchObject({
    status: "failed",
    terminalCauseCode: "workflow_failed",
  });
});

it("serializes concurrent in-memory task reservations", async () => {
  const services = createInMemoryOrchestrationServices();
  const tasks = await Promise.all(Array.from({ length: 8 }, (_, index) =>
    services.tasks.reserveTask({ sessionId: "sess_1", kind: "tool", purpose: `task ${index}` })
  ));
  expect(new Set(tasks.map((task) => task.taskId)).size).toBe(8);
  await expect(services.tasks.highWaterMark("sess_1")).resolves.toBe(8);
});

it("accepts queued workflow runs up to maxQueuedWorkflowRuns and rejects past it", async () => {
  const services = createInMemoryOrchestrationServices();
  const capacity = {
    sessionId: "sess_1",
    workflowId: "candidate.review",
    handle: "candidate_review",
    maxConcurrentWorkflowRuns: 0,
    maxQueuedWorkflowRuns: 1,
  };
  const accepted = await services.workflowQueue.withQueueCapacity(capacity, {
    hasExistingLaunch: async () => false,
    reserve: async () => {
      await services.workflowQueue.enqueue({
        sessionId: "sess_1",
        queueId: "queue_1",
        reservedRunId: "run_1",
        taskId: "task_1",
        workflowId: "candidate.review",
        handle: "candidate_review",
        status: "queued",
        source: "static",
      } as never);
      return "reserved";
    },
  });
  expect(accepted).toMatchObject({ accepted: true, value: "reserved" });
  const rejected = await services.workflowQueue.withQueueCapacity(capacity, {
    hasExistingLaunch: async () => false,
    reserve: async () => {
      throw new Error("must not reserve past queue capacity");
    },
  });
  expect(rejected).toEqual({ accepted: false, queuedWorkflowRuns: 1 });
});

it("replays a workflow launch reservation with the same task and result ids", async () => {
  const services = createInMemoryOrchestrationServices();
  const base = workflowLaunchInput({ sessionDataDir: "/in-memory/session-data" });
  const first = await services.workflowLaunches.reserveLaunch(base);
  expect(first).toMatchObject({
    replay: false,
    task: { taskId: "task_1", callIdentity: base.callIdentity, queueId: "queue_1" },
    queueRecord: { taskId: "task_1", queueId: "queue_1", callIdentity: base.callIdentity },
    inputResult: { resultId: "result_1" },
  });
  const replay = await services.workflowLaunches.reserveLaunch(base);
  expect(replay).toMatchObject({
    replay: true,
    task: { taskId: "task_1", callIdentity: base.callIdentity, queueId: "queue_1" },
    queueRecord: { taskId: "task_1", queueId: "queue_1" },
    inputResult: { resultId: "result_1" },
  });
  await expect(services.tasks.listTasks({ sessionId: base.sessionId })).resolves.toHaveLength(1);
});

it("orders resume queue claims by enqueue time and completes them once", async () => {
  const services = createInMemoryOrchestrationServices();
  const record = (resumeId: string, enqueuedAt: string) => ({
    resumeId,
    continuationId: "cont_1",
    sessionId: "sess_1",
    originTurnId: "turn_1",
    reason: "predicate_satisfied" as const,
    terminalResultIds: [],
    enqueuedAt,
  });
  await services.resumeQueue.enqueue(record("resume_2", "2026-06-22T00:00:01.000Z"));
  await services.resumeQueue.enqueue(record("resume_1", "2026-06-22T00:00:00.000Z"));
  await expect(services.resumeQueue.claimNext("sess_1")).resolves.toMatchObject({ resumeId: "resume_1" });
  await services.resumeQueue.markCompleted("resume_1", "2026-06-22T00:00:02.000Z");
  await expect(services.resumeQueue.claimNext("sess_1")).resolves.toMatchObject({ resumeId: "resume_2" });
  await services.resumeQueue.markCompleted("resume_2", "2026-06-22T00:00:03.000Z");
  await expect(services.resumeQueue.claimNext("sess_1")).resolves.toBeUndefined();
  await expect(services.resumeQueue.listOpen("sess_1")).resolves.toHaveLength(0);
});

it("allocates results idempotently and enforces commit value equality", async () => {
  const services = createInMemoryOrchestrationServices();
  const sessionDataDir = "/in-memory/session-data";
  const first = await services.results.allocate({
    sessionId: "sess_1",
    sessionDataDir,
    kind: "tool",
    idempotencyKey: "terminal:call_1",
  });
  const replay = await services.results.allocate({
    sessionId: "sess_1",
    sessionDataDir,
    kind: "tool",
    idempotencyKey: "terminal:call_1",
  });
  expect(first.resultId).toBe("result_1");
  expect(replay).toEqual(first);
  await services.results.commit({ sessionId: "sess_1", resultId: first.resultId }, { ok: true, extra: undefined });
  // The undefined field is stripped by the store round-trip, so an equal recommit succeeds…
  await expect(services.results.commit({ sessionId: "sess_1", resultId: first.resultId }, { ok: true }))
    .resolves.toMatchObject({ resultId: first.resultId, committedAt: expect.any(String) });
  // …while a conflicting value is rejected.
  await expect(services.results.commit({ sessionId: "sess_1", resultId: first.resultId }, { ok: false }))
    .rejects.toThrow(/different value/i);
  await expect(services.results.get({ sessionId: "sess_1", resultId: first.resultId })).resolves.toMatchObject({
    value: { ok: true },
  });
});

it("mints, validates, and revokes result grants", async () => {
  const services = createInMemoryOrchestrationServices();
  const grant = await services.resultGrants.mintGrant({
    sessionId: "sess_1",
    resultId: "result_1",
    audience: "runtime",
  });
  await expect(services.resultGrants.validateGrant({
    resultGrantId: grant.resultGrantId,
    sessionId: "sess_1",
    resultId: "result_1",
    audience: "runtime",
  })).resolves.toMatchObject({ valid: true });
  await expect(services.resultGrants.validateGrant({
    resultGrantId: grant.resultGrantId,
    sessionId: "sess_1",
    resultId: "result_1",
    audience: "bash",
  })).resolves.toMatchObject({ valid: false, causeCode: "wrong_audience" });
  await services.resultGrants.revoke(grant.resultGrantId, "2026-06-22T00:00:01.000Z");
  await expect(services.resultGrants.validateGrant({
    resultGrantId: grant.resultGrantId,
    sessionId: "sess_1",
    resultId: "result_1",
    audience: "runtime",
  })).resolves.toMatchObject({ valid: false, causeCode: "revoked" });
});

it("shares writes between two facades over one store", async () => {
  const store = createInMemoryDurableStore();
  const first = createInMemoryOrchestrationServices({ store });
  const second = createInMemoryOrchestrationServices({ store });
  const task = await first.tasks.reserveTask({
    sessionId: "sess_1",
    kind: "workflow",
    purpose: "review",
    callIdentity: "call_1",
  });
  await expect(second.tasks.getTask({ sessionId: "sess_1", taskId: task.taskId })).resolves.toMatchObject({
    taskId: task.taskId,
  });
  await expect(second.tasks.reserveTask({ sessionId: "sess_1", kind: "workflow", callIdentity: "call_1" }))
    .resolves.toMatchObject({ taskId: task.taskId });
  await first.continuations.put({
    continuationId: "cont_1",
    sessionId: "sess_1",
    originTurnId: "turn_1",
    parkedToolCallIds: ["tool_1"],
    waits: [{
      waitId: "wait_1",
      parkedToolCallId: "tool_1",
      predicate: { kind: "tasks", taskIds: [task.taskId], mode: "all" },
      state: "open",
      outcomesById: {},
      terminalResultIds: [],
    }],
    terminalResultsByToolCallId: {},
    state: "open",
    createdAt: "2026-06-22T00:00:00.000Z",
    updatedAt: "2026-06-22T00:00:00.000Z",
  });
  await expect(second.continuations.get("cont_1")).resolves.toMatchObject({ continuationId: "cont_1" });

  const isolated = createInMemoryOrchestrationServices();
  await expect(isolated.tasks.getTask({ sessionId: "sess_1", taskId: task.taskId })).resolves.toBeUndefined();
});

it("supports fault injection and repair over a shared in-memory store", async () => {
  const store = createInMemoryDurableStore();
  const first = createInMemoryOrchestrationServices({
    store,
    faultInjection: failOnce("task-reserve-after-record-write"),
  });
  await expect(first.tasks.reserveTask({ sessionId: "sess_1", kind: "tool", callIdentity: "call_1" }))
    .rejects.toThrow("injected task-reserve-after-record-write");

  const second = createInMemoryOrchestrationServices({ store });
  await expect(second.tasks.reserveTask({ sessionId: "sess_1", kind: "tool", callIdentity: "call_1" }))
    .resolves.toMatchObject({ taskId: "task_1" });
  await expect(second.tasks.reserveTask({ sessionId: "sess_1", kind: "tool" })).resolves.toMatchObject({ taskId: "task_2" });
});

function workflowLaunchInput(
  overrides: Partial<WorkflowLaunchTransactionInput> = {},
): WorkflowLaunchTransactionInput {
  return {
    sessionId: "sess_1",
    workflowId: "candidate.review",
    handle: "candidate_review",
    disposition: "start",
    input: { candidateId: "C1" },
    inputHash: "sha256:input",
    sessionDataDir: "/in-memory/session-data",
    dataDir: "/in-memory/session-data/workflows/candidate_review",
    originTurnId: "turn_1",
    parentTurnId: "turn_1",
    callIdentity: "call_1",
    reservationScopeId: "scope_1",
    reservationOrder: 0,
    scopeSize: 1,
    workflowDefinitionIdentity: "sha256:workflow",
    memoryScope: "none",
    workflowSetDefinitionIdentities: [],
    inheritance: {},
    taskKind: "workflow",
    reservedAt: "2026-06-22T00:00:00.000Z",
    ...overrides,
  };
}

function failOnce(point: LocalHarnessDurableServicesFaultPoint) {
  let failed = false;
  return {
    onPoint(candidate: LocalHarnessDurableServicesFaultPoint) {
      if (!failed && candidate === point) {
        failed = true;
        throw new Error(`injected ${point}`);
      }
    },
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > 5_000) {
      throw new Error("Timed out waiting for condition.");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

it("backs a real localHost turn as the injected orchestration services", async () => {
  const { MockLanguageModelV3 } = await import("ai/test");
  const { createHarness } = await import("../create-harness.js");
  const { generateHarness } = await import("../execution/generate-harness.js");
  const { localHost } = await import("./local-host.js");

  const dir = await mkdtemp(join(tmpdir(), "lh-inmem-host-"));
  dirs.push(dir);
  const orchestration = createInMemoryOrchestrationServices();
  const host = localHost({ dataDir: dir, orchestration });
  expect(host.durable).toBe(orchestration);

  const harness = createHarness({
    host,
    model: new MockLanguageModelV3({
      provider: "test",
      modelId: "test-model",
      doGenerate: {
        content: [{ type: "text", text: "in-memory ok" }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
        warnings: [],
      },
    }),
  });
  const result = await generateHarness({
    harness,
    messages: [
      { id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] },
    ] as any,
    session: "in-memory-orchestration",
  });
  expect(result.text).toBe("in-memory ok");
});
