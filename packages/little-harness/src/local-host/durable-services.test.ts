import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { stableHash } from "../utils/canonical-hash.js";
import type { WorkflowLaunchTransactionInput } from "../workflow-scheduler/types.js";
import {
  createLocalHarnessDurableServices,
  type LocalHarnessDurableServicesFaultPoint,
} from "./durable-services.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

it("persists task and continuation ledgers across service instances", async () => {
  const root = await mkdtemp(join(tmpdir(), "lh-durable-services-"));
  dirs.push(root);
  const first = createLocalHarnessDurableServices({ rootDir: root });
  const task = await first.tasks.reserveTask({ sessionId: "sess_1", kind: "workflow", purpose: "review" });
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

  const second = createLocalHarnessDurableServices({ rootDir: root });
  await expect(second.tasks.getTask({ sessionId: "sess_1", taskId: task.taskId })).resolves.toMatchObject({ taskId: task.taskId });
  await expect(second.continuations.get("cont_1")).resolves.toMatchObject({ continuationId: "cont_1" });
  await expect(second.continuations.markWaitTerminal({
    continuationId: "cont_1",
    waitId: "wait_1",
    matchedId: task.taskId,
    fromState: "open",
    toState: "terminal",
    terminalResultIds: ["result_1"],
    terminalAt: "2026-06-22T00:00:01.000Z",
    resumeQueueId: "resume_1",
    resumeReason: "predicate_satisfied",
  })).resolves.toMatchObject({ updated: true, shouldEnqueueResume: true });
  await expect(second.continuations.markWaitTerminal({
    continuationId: "cont_1",
    waitId: "wait_1",
    matchedId: task.taskId,
    fromState: "open",
    toState: "terminal",
    terminalResultIds: ["result_1"],
    terminalAt: "2026-06-22T00:00:01.000Z",
    resumeQueueId: "resume_1",
    resumeReason: "predicate_satisfied",
  })).resolves.toMatchObject({ updated: false, shouldEnqueueResume: false });
  await second.resumeQueue.ensureEnqueued({
    resumeId: "resume_1",
    continuationId: "cont_1",
    sessionId: "sess_1",
    originTurnId: "turn_1",
    reason: "predicate_satisfied",
    terminalResultIds: [],
    enqueuedAt: "2026-06-22T00:00:01.000Z",
  });
  await second.resumeQueue.ensureEnqueued({
    resumeId: "resume_1",
    continuationId: "cont_1",
    sessionId: "sess_1",
    originTurnId: "turn_1",
    reason: "predicate_satisfied",
    terminalResultIds: [],
    enqueuedAt: "2026-06-22T00:00:01.000Z",
  });
  await expect(second.resumeQueue.claimNext("sess_1")).resolves.toMatchObject({ resumeId: "resume_1" });
});

it("persists failed and cancelled task diagnostics across service instances", async () => {
  const root = await mkdtemp(join(tmpdir(), "lh-durable-services-"));
  dirs.push(root);
  const first = createLocalHarnessDurableServices({ rootDir: root });
  const failed = await first.tasks.reserveTask({ sessionId: "sess_1", kind: "workflow", purpose: "fail" });
  const cancelled = await first.tasks.reserveTask({ sessionId: "sess_1", kind: "tool", purpose: "cancel" });
  await first.tasks.markTerminal({ sessionId: "sess_1", taskId: failed.taskId }, {
    status: "failed",
    updatedAt: "2026-06-22T00:00:01.000Z",
    terminalCauseCode: "stale_workflow_definition",
    terminalMessage: "Workflow changed.",
    terminalDiagnostic: { expected: "sha256:old", actual: "sha256:new" },
  });
  await first.tasks.markTerminal({ sessionId: "sess_1", taskId: cancelled.taskId }, {
    status: "cancelled",
    updatedAt: "2026-06-22T00:00:02.000Z",
    terminalCauseCode: "cancelled",
    terminalMessage: "Cancelled by user.",
    terminalDiagnostic: { requestedBy: "task_control" },
  });

  const second = createLocalHarnessDurableServices({ rootDir: root });
  await expect(second.tasks.getTask({ sessionId: "sess_1", taskId: failed.taskId })).resolves.toMatchObject({
    status: "failed",
    terminalCauseCode: "stale_workflow_definition",
    terminalMessage: "Workflow changed.",
    terminalDiagnostic: { expected: "sha256:old", actual: "sha256:new" },
  });
  await expect(second.tasks.getTask({ sessionId: "sess_1", taskId: cancelled.taskId })).resolves.toMatchObject({
    status: "cancelled",
    terminalCauseCode: "cancelled",
    terminalMessage: "Cancelled by user.",
    terminalDiagnostic: { requestedBy: "task_control" },
  });
});

it("scopes queue ids and run ids by session", async () => {
  const root = await mkdtemp(join(tmpdir(), "lh-durable-services-"));
  dirs.push(root);
  const services = createLocalHarnessDurableServices({ rootDir: root });
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
  await services.workflowQueue.enqueue({
    sessionId: "sess_2",
    queueId: "queue_1",
    reservedRunId: "run_1",
    taskId: "task_1",
    workflowId: "candidate.review",
    handle: "candidate_review",
    status: "queued",
    source: "static",
  } as never);

  await expect(services.workflowQueue.get({ sessionId: "sess_1", queueId: "queue_1" })).resolves.toMatchObject({ sessionId: "sess_1" });
  await expect(services.workflowQueue.get({ sessionId: "sess_2", queueId: "queue_1" })).resolves.toMatchObject({ sessionId: "sess_2" });
  await expect(services.workflowQueue.getByRunId({ sessionId: "sess_1", runId: "run_1" })).resolves.toMatchObject({ sessionId: "sess_1" });
  await expect(services.workflowQueue.getByTaskId({ sessionId: "sess_2", taskId: "task_1" })).resolves.toMatchObject({ sessionId: "sess_2" });
  await services.asyncTaskQueue.enqueue({
    sessionId: "sess_1",
    queueId: "queue_1",
    taskId: "task_1",
    kind: "tool",
    handle: "score",
    status: "queued",
  } as never);
  await services.asyncTaskQueue.enqueue({
    sessionId: "sess_2",
    queueId: "queue_1",
    taskId: "task_1",
    kind: "tool",
    handle: "score",
    status: "queued",
  } as never);
  await expect(services.asyncTaskQueue.get({ sessionId: "sess_1", queueId: "queue_1" })).resolves.toMatchObject({ sessionId: "sess_1" });
  await expect(services.asyncTaskQueue.get({ sessionId: "sess_2", queueId: "queue_1" })).resolves.toMatchObject({ sessionId: "sess_2" });
});

it("stores result payloads per session and scopes grants by audience", async () => {
  const root = await mkdtemp(join(tmpdir(), "lh-durable-services-"));
  const dataOne = await mkdtemp(join(tmpdir(), "lh-session-one-"));
  const dataTwo = await mkdtemp(join(tmpdir(), "lh-session-two-"));
  dirs.push(root, dataOne, dataTwo);
  const services = createLocalHarnessDurableServices({ rootDir: root });

  const first = await services.results.allocate({
    sessionId: "sess_1",
    sessionDataDir: dataOne,
    kind: "workflow",
    idempotencyKey: "terminal:call_1",
  });
  const firstReplay = await services.results.allocate({
    sessionId: "sess_1",
    sessionDataDir: dataOne,
    kind: "workflow",
    idempotencyKey: "terminal:call_1",
  });
  const second = await services.results.allocate({
    sessionId: "sess_2",
    sessionDataDir: dataTwo,
    kind: "workflow",
    idempotencyKey: "terminal:call_1",
  });

  expect(first.resultId).toBe("result_1");
  expect(firstReplay).toEqual(first);
  expect(second.resultId).toBe("result_1");
  await services.results.commit({ sessionId: "sess_1", resultId: first.resultId }, { ok: true });
  await services.results.commit({ sessionId: "sess_2", resultId: second.resultId }, { ok: false });
  await expect(services.results.get({ sessionId: "sess_1", resultId: "result_1" })).resolves.toMatchObject({
    value: { ok: true },
  });
  await expect(services.results.get({ sessionId: "sess_2", resultId: "result_1" })).resolves.toMatchObject({
    value: { ok: false },
  });
  await expect(services.results.commit({ sessionId: "sess_1", resultId: first.resultId }, { ok: "conflict" })).rejects.toThrow(
    /already committed/u,
  );

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
    sessionId: "sess_2",
    resultId: "result_1",
    audience: "runtime",
  })).resolves.toMatchObject({ valid: false, causeCode: "wrong_session" });
  await expect(services.resultGrants.validateGrant({
    resultGrantId: grant.resultGrantId,
    sessionId: "sess_1",
    resultId: "result_1",
    audience: "bash",
  })).resolves.toMatchObject({ valid: false, causeCode: "wrong_audience" });
});

it("persists prepared workflow runs and keeps first terminal transition", async () => {
  const root = await mkdtemp(join(tmpdir(), "lh-durable-services-"));
  dirs.push(root);
  const first = createLocalHarnessDurableServices({ rootDir: root });
  await first.preparedWorkflowRuns.put({
    record: {
      sessionId: "sess_1",
      runPreparedCallIdentity: "call_1",
      preparedRunIdentity: "prepared_run_1",
      reservedRunId: "run_1",
      toolCallId: "tool_1",
      runtimeReplayPath: ["0"],
      workflowId: "candidate.review",
      versionId: "version_1",
      inputHash: "sha256:input",
      workflowDefinitionHash: "sha256:workflow",
      capabilityHash: "sha256:capability",
      modelToolSkillSnapshotHash: "sha256:model",
      inputShapeHash: "sha256:shape",
      status: "running",
      createdAt: "2026-06-22T00:00:00.000Z",
      updatedAt: "2026-06-22T00:00:00.000Z",
    },
  });
  await first.preparedWorkflowRuns.put({
    record: {
      sessionId: "sess_2",
      runPreparedCallIdentity: "call_1",
      preparedRunIdentity: "prepared_run_2",
      reservedRunId: "run_1",
      toolCallId: "tool_1",
      runtimeReplayPath: ["0"],
      workflowId: "candidate.review",
      versionId: "version_1",
      inputHash: "sha256:input",
      workflowDefinitionHash: "sha256:workflow",
      capabilityHash: "sha256:capability",
      modelToolSkillSnapshotHash: "sha256:model",
      inputShapeHash: "sha256:shape",
      status: "running",
      createdAt: "2026-06-22T00:00:00.000Z",
      updatedAt: "2026-06-22T00:00:00.000Z",
    },
  });

  const second = createLocalHarnessDurableServices({ rootDir: root });
  await expect(second.preparedWorkflowRuns.getByRunPreparedCallIdentity({
    sessionId: "sess_1",
    runPreparedCallIdentity: "call_1",
  })).resolves.toMatchObject({ sessionId: "sess_1", preparedRunIdentity: "prepared_run_1" });
  await expect(second.preparedWorkflowRuns.markTerminal({
    sessionId: "sess_1",
    runPreparedCallIdentity: "call_1",
    status: "failed",
    terminalResultId: "result_1",
    terminalCauseCode: "workflow_failed",
    terminalAt: "2026-06-22T00:00:01.000Z",
  })).resolves.toMatchObject({
    status: "failed",
    terminalResultId: "result_1",
    terminalCauseCode: "workflow_failed",
  });
  await expect(second.preparedWorkflowRuns.markTerminal({
    sessionId: "sess_1",
    runPreparedCallIdentity: "call_1",
    status: "completed",
    terminalResultId: "result_2",
    terminalAt: "2026-06-22T00:00:02.000Z",
  })).resolves.toMatchObject({
    status: "failed",
    terminalResultId: "result_1",
    terminalCauseCode: "workflow_failed",
  });
  await expect(second.preparedWorkflowRuns.list({
    sessionId: "sess_1",
    workflowId: "candidate.review",
    versionId: "version_1",
  })).resolves.toHaveLength(1);
});

it("allows cancellation-triggered resumes but not a cancelled resume reason", async () => {
  const root = await mkdtemp(join(tmpdir(), "lh-durable-services-"));
  dirs.push(root);
  const services = createLocalHarnessDurableServices({ rootDir: root });
  await services.continuations.put({
    continuationId: "cont_1",
    sessionId: "sess_1",
    originTurnId: "turn_1",
    parkedToolCallIds: ["tool_1"],
    waits: [{
      waitId: "wait_1",
      parkedToolCallId: "tool_1",
      predicate: { kind: "tasks", taskIds: ["task_1"], mode: "all" },
      state: "open",
      outcomesById: {},
      terminalResultIds: [],
    }],
    terminalResultsByToolCallId: {},
    state: "open",
    createdAt: "2026-06-22T00:00:00.000Z",
    updatedAt: "2026-06-22T00:00:00.000Z",
  });
  await expect(services.continuations.markWaitTerminal({
    continuationId: "cont_1",
    waitId: "wait_1",
    matchedId: "task_1",
    fromState: "open",
    toState: "cancelled",
    terminalResultIds: ["result_1"],
    terminalAt: "2026-06-22T00:00:01.000Z",
    resumeQueueId: "resume_1",
    resumeReason: "predicate_satisfied",
  })).resolves.toMatchObject({ updated: true, shouldEnqueueResume: true });

  const invalidResumeReason = {
    resumeId: "resume_2",
    continuationId: "cont_1",
    sessionId: "sess_1",
    originTurnId: "turn_1",
    // @ts-expect-error cancellation resumes use predicate_satisfied.
    reason: "cancelled",
    terminalResultIds: [],
    enqueuedAt: "2026-06-22T00:00:02.000Z",
  } satisfies Parameters<typeof services.resumeQueue.ensureEnqueued>[0];
  void invalidResumeReason;
});

it("preserves every terminal result id for all-mode waits", async () => {
  const root = await mkdtemp(join(tmpdir(), "lh-durable-services-"));
  dirs.push(root);
  const services = createLocalHarnessDurableServices({ rootDir: root });
  await services.continuations.put({
    continuationId: "cont_1",
    sessionId: "sess_1",
    originTurnId: "turn_1",
    parkedToolCallIds: ["tool_1"],
    waits: [{
      waitId: "wait_1",
      parkedToolCallId: "tool_1",
      predicate: { kind: "tasks", taskIds: ["task_1", "task_2"], mode: "all" },
      state: "open",
      outcomesById: {},
      terminalResultIds: [],
    }],
    terminalResultsByToolCallId: {},
    state: "open",
    createdAt: "2026-06-22T00:00:00.000Z",
    updatedAt: "2026-06-22T00:00:00.000Z",
  });

  await expect(services.continuations.markWaitTerminal({
    continuationId: "cont_1",
    waitId: "wait_1",
    matchedId: "task_1",
    fromState: "open",
    toState: "terminal",
    terminalResultIds: ["result_1"],
    terminalAt: "2026-06-22T00:00:01.000Z",
    resumeQueueId: "resume_1",
    resumeReason: "predicate_satisfied",
  })).resolves.toMatchObject({ updated: true, shouldEnqueueResume: false });

  await expect(services.continuations.markWaitTerminal({
    continuationId: "cont_1",
    waitId: "wait_1",
    matchedId: "task_2",
    fromState: "open",
    toState: "terminal",
    terminalResultIds: ["result_2"],
    terminalAt: "2026-06-22T00:00:02.000Z",
    resumeQueueId: "resume_1",
    resumeReason: "predicate_satisfied",
  })).resolves.toMatchObject({
    updated: true,
    shouldEnqueueResume: true,
    record: expect.objectContaining({
      terminalResultsByToolCallId: { tool_1: ["result_1", "result_2"] },
    }),
  });
});

it("serializes concurrent task and result allocation per session", async () => {
  const root = await mkdtemp(join(tmpdir(), "lh-durable-services-"));
  const dataDir = await mkdtemp(join(tmpdir(), "lh-session-"));
  dirs.push(root, dataDir);
  const services = createLocalHarnessDurableServices({ rootDir: root });

  const tasks = await Promise.all(Array.from({ length: 8 }, (_, index) =>
    services.tasks.reserveTask({ sessionId: "sess_1", kind: "tool", purpose: `task ${index}` })
  ));
  expect(new Set(tasks.map((task) => task.taskId)).size).toBe(8);
  await expect(services.tasks.highWaterMark("sess_1")).resolves.toBe(8);

  const results = await Promise.all(Array.from({ length: 8 }, (_, index) =>
    services.results.allocate({ sessionId: "sess_1", sessionDataDir: dataDir, kind: "tool", inlineSummary: `result ${index}` })
  ));
  expect(new Set(results.map((result) => result.resultId)).size).toBe(8);
});

it("repairs missing task call-identity indexes before minting a new task id", async () => {
  const root = await mkdtemp(join(tmpdir(), "lh-durable-services-"));
  dirs.push(root);
  const first = createLocalHarnessDurableServices({
    rootDir: root,
    faultInjection: failOnce("task-reserve-after-record-write"),
  });

  await expect(first.tasks.reserveTask({
    sessionId: "sess_1",
    kind: "tool",
    callIdentity: "call_1",
  })).rejects.toThrow("injected task-reserve-after-record-write");

  const second = createLocalHarnessDurableServices({ rootDir: root });
  await expect(second.tasks.reserveTask({
    sessionId: "sess_1",
    kind: "tool",
    callIdentity: "call_1",
  })).resolves.toMatchObject({ taskId: "task_1" });
  await expect(second.tasks.reserveTask({ sessionId: "sess_1", kind: "tool" })).resolves.toMatchObject({ taskId: "task_2" });
});

it("does not reuse a task id when meta lags behind written task records", async () => {
  const root = await mkdtemp(join(tmpdir(), "lh-durable-services-"));
  dirs.push(root);
  const baseline = createLocalHarnessDurableServices({ rootDir: root });
  await baseline.tasks.reserveTask({ sessionId: "sess_1", kind: "tool" });
  const first = createLocalHarnessDurableServices({
    rootDir: root,
    faultInjection: failOnce("task-reserve-after-record-write"),
  });

  await expect(first.tasks.reserveTask({ sessionId: "sess_1", kind: "tool" })).rejects.toThrow("injected task-reserve-after-record-write");

  const second = createLocalHarnessDurableServices({ rootDir: root });
  await expect(second.tasks.reserveTask({ sessionId: "sess_1", kind: "tool" })).resolves.toMatchObject({ taskId: "task_3" });
});

it("repairs missing result idempotency indexes before minting a new result id", async () => {
  const root = await mkdtemp(join(tmpdir(), "lh-durable-services-"));
  const dataDir = await mkdtemp(join(tmpdir(), "lh-session-"));
  dirs.push(root, dataDir);
  const first = createLocalHarnessDurableServices({
    rootDir: root,
    faultInjection: failOnce("result-allocate-after-record-write"),
  });

  await expect(first.results.allocate({
    sessionId: "sess_1",
    sessionDataDir: dataDir,
    kind: "tool",
    idempotencyKey: "input:call_1",
  })).rejects.toThrow("injected result-allocate-after-record-write");

  const second = createLocalHarnessDurableServices({ rootDir: root });
  await expect(second.results.allocate({
    sessionId: "sess_1",
    sessionDataDir: dataDir,
    kind: "tool",
    idempotencyKey: "input:call_1",
  })).resolves.toMatchObject({ resultId: "result_1" });
  await expect(second.results.allocate({ sessionId: "sess_1", sessionDataDir: dataDir, kind: "tool" })).resolves.toMatchObject({ resultId: "result_2" });
});

it("repairs a missing by-key index when reading a result by idempotency key", async () => {
  const root = await mkdtemp(join(tmpdir(), "lh-durable-services-"));
  const dataDir = await mkdtemp(join(tmpdir(), "lh-session-"));
  dirs.push(root, dataDir);
  const services = createLocalHarnessDurableServices({ rootDir: root });
  const allocated = await services.results.allocate({
    sessionId: "sess_1",
    sessionDataDir: dataDir,
    kind: "workflow-input",
    idempotencyKey: "input:call_1",
  });
  await services.results.commit({ sessionId: "sess_1", resultId: allocated.resultId }, { hello: "world" });

  // Lose ONLY the by-key index file (the by-result index + session record survive).
  const indexRoot = join(root, "result-index");
  const [sessionDir] = await readdir(indexRoot);
  const byKeyDir = join(indexRoot, sessionDir!, "by-key");
  const [byKeyFile] = await readdir(byKeyDir);
  await rm(join(byKeyDir, byKeyFile!));

  const reopened = createLocalHarnessDurableServices({ rootDir: root });
  const found = await reopened.results.getByIdempotencyKey({ sessionId: "sess_1", idempotencyKey: "input:call_1" });
  expect(found?.record.resultId).toBe(allocated.resultId);
  expect(found?.value).toEqual({ hello: "world" });

  // The repair rewrote the by-key index so a subsequent read no longer needs the fallback.
  await expect(readdir(byKeyDir)).resolves.toHaveLength(1);
});

it("repairs by-key reads from the session record when the entire rootDir result index is lost", async () => {
  const root = await mkdtemp(join(tmpdir(), "lh-durable-services-"));
  const dataDir = await mkdtemp(join(tmpdir(), "lh-session-"));
  dirs.push(root, dataDir);
  const services = createLocalHarnessDurableServices({ rootDir: root });
  const allocated = await services.results.allocate({
    sessionId: "sess_1",
    sessionDataDir: dataDir,
    kind: "workflow-input",
    idempotencyKey: "input:call_1",
  });
  await services.results.commit({ sessionId: "sess_1", resultId: allocated.resultId }, { hello: "world" });

  // Lose the ENTIRE rootDir result index (both by-key and by-result). Only the source-of-truth
  // session record under <sessionDataDir>/results survives.
  await rm(join(root, "result-index"), { recursive: true, force: true });

  const reopened = createLocalHarnessDurableServices({ rootDir: root });
  // Without sessionDataDir the index-only repair cannot recover (the bug that wedged launch replay).
  await expect(
    reopened.results.getByIdempotencyKey({ sessionId: "sess_1", idempotencyKey: "input:call_1" }),
  ).resolves.toBeUndefined();
  // With sessionDataDir (which the launch callers now thread through), it recovers from the
  // session record, symmetric with allocate's self-heal.
  const found = await reopened.results.getByIdempotencyKey({
    sessionId: "sess_1",
    idempotencyKey: "input:call_1",
    sessionDataDir: dataDir,
  });
  expect(found?.record.resultId).toBe(allocated.resultId);
  expect(found?.value).toEqual({ hello: "world" });
});

it("does not reuse a result id when meta lags behind written result records", async () => {
  const root = await mkdtemp(join(tmpdir(), "lh-durable-services-"));
  const dataDir = await mkdtemp(join(tmpdir(), "lh-session-"));
  dirs.push(root, dataDir);
  const baseline = createLocalHarnessDurableServices({ rootDir: root });
  await baseline.results.allocate({ sessionId: "sess_1", sessionDataDir: dataDir, kind: "tool" });
  const first = createLocalHarnessDurableServices({
    rootDir: root,
    faultInjection: failOnce("result-allocate-after-record-write"),
  });

  await expect(first.results.allocate({ sessionId: "sess_1", sessionDataDir: dataDir, kind: "tool" })).rejects.toThrow("injected result-allocate-after-record-write");

  const second = createLocalHarnessDurableServices({ rootDir: root });
  await expect(second.results.allocate({ sessionId: "sess_1", sessionDataDir: dataDir, kind: "tool" })).resolves.toMatchObject({ resultId: "result_3" });
});

it("repairs session-only result records before minting a new result id", async () => {
  const root = await mkdtemp(join(tmpdir(), "lh-durable-services-"));
  const dataDir = await mkdtemp(join(tmpdir(), "lh-session-"));
  dirs.push(root, dataDir);
  const baseline = createLocalHarnessDurableServices({ rootDir: root });
  await baseline.results.allocate({ sessionId: "sess_1", sessionDataDir: dataDir, kind: "tool" });
  const first = createLocalHarnessDurableServices({
    rootDir: root,
    faultInjection: failOnce("result-allocate-after-session-record-write"),
  });

  await expect(first.results.allocate({
    sessionId: "sess_1",
    sessionDataDir: dataDir,
    kind: "tool",
    idempotencyKey: "input:call_2",
  })).rejects.toThrow("injected result-allocate-after-session-record-write");

  const second = createLocalHarnessDurableServices({ rootDir: root });
  await expect(second.results.allocate({
    sessionId: "sess_1",
    sessionDataDir: dataDir,
    kind: "tool",
    idempotencyKey: "input:call_2",
  })).resolves.toMatchObject({ resultId: "result_2" });
  await expect(second.results.allocate({ sessionId: "sess_1", sessionDataDir: dataDir, kind: "tool" })).resolves.toMatchObject({ resultId: "result_3" });
});

it("keeps result commits first-writer-wins under concurrent conflicting commits", async () => {
  const root = await mkdtemp(join(tmpdir(), "lh-durable-services-"));
  const dataDir = await mkdtemp(join(tmpdir(), "lh-session-"));
  dirs.push(root, dataDir);
  const services = createLocalHarnessDurableServices({ rootDir: root });
  const result = await services.results.allocate({ sessionId: "sess_1", sessionDataDir: dataDir, kind: "tool" });

  const commits = await Promise.allSettled([
    services.results.commit({ sessionId: "sess_1", resultId: result.resultId }, { value: "first" }),
    services.results.commit({ sessionId: "sess_1", resultId: result.resultId }, { value: "second" }),
  ]);

  expect(commits.filter((commit) => commit.status === "fulfilled")).toHaveLength(1);
  expect(commits.filter((commit) => commit.status === "rejected")).toHaveLength(1);
});

it("rolls result commit metadata forward after crashing after value write", async () => {
  const root = await mkdtemp(join(tmpdir(), "lh-durable-services-"));
  const dataDir = await mkdtemp(join(tmpdir(), "lh-session-"));
  dirs.push(root, dataDir);
  const setup = createLocalHarnessDurableServices({ rootDir: root });
  const result = await setup.results.allocate({ sessionId: "sess_1", sessionDataDir: dataDir, kind: "tool" });
  const first = createLocalHarnessDurableServices({
    rootDir: root,
    faultInjection: failOnce("result-commit-after-value-write"),
  });

  await expect(first.results.commit({ sessionId: "sess_1", resultId: result.resultId }, { value: "first" }))
    .rejects.toThrow("injected result-commit-after-value-write");

  const second = createLocalHarnessDurableServices({ rootDir: root });
  await expect(second.results.commit({ sessionId: "sess_1", resultId: result.resultId }, { value: "first" }))
    .resolves.toMatchObject({ resultId: result.resultId, committedAt: expect.any(String) });
  await expect(second.results.commit({ sessionId: "sess_1", resultId: result.resultId }, { value: "second" }))
    .rejects.toThrow(/different value/i);
});

it("rejects conflicting result commit after crashing after committed session record write", async () => {
  const root = await mkdtemp(join(tmpdir(), "lh-durable-services-"));
  const dataDir = await mkdtemp(join(tmpdir(), "lh-session-"));
  dirs.push(root, dataDir);
  const setup = createLocalHarnessDurableServices({ rootDir: root });
  const result = await setup.results.allocate({ sessionId: "sess_1", sessionDataDir: dataDir, kind: "tool" });
  const first = createLocalHarnessDurableServices({
    rootDir: root,
    faultInjection: failOnce("result-commit-after-session-record-write"),
  });

  await expect(first.results.commit({ sessionId: "sess_1", resultId: result.resultId }, { value: "first" }))
    .rejects.toThrow("injected result-commit-after-session-record-write");

  const second = createLocalHarnessDurableServices({ rootDir: root });
  await expect(second.results.commit({ sessionId: "sess_1", resultId: result.resultId }, { value: "second" }))
    .rejects.toThrow(/different value/i);
  await expect(second.results.commit({ sessionId: "sess_1", resultId: result.resultId }, { value: "first" }))
    .resolves.toMatchObject({ resultId: result.resultId, committedAt: expect.any(String) });
});

it("repairs stale result key and index from a committed session record before recommit", async () => {
  const root = await mkdtemp(join(tmpdir(), "lh-durable-services-"));
  const dataDir = await mkdtemp(join(tmpdir(), "lh-session-"));
  dirs.push(root, dataDir);
  const setup = createLocalHarnessDurableServices({ rootDir: root });
  const result = await setup.results.allocate({
    sessionId: "sess_1",
    sessionDataDir: dataDir,
    kind: "tool",
    idempotencyKey: "terminal:call_1",
  });
  const first = createLocalHarnessDurableServices({
    rootDir: root,
    faultInjection: failOnce("result-commit-after-session-record-write"),
  });

  await expect(first.results.commit(
    { sessionId: "sess_1", resultId: result.resultId },
    { value: "first" },
    { inlineSummary: "summary", outputPath: "/tmp/output.json" },
  )).rejects.toThrow("injected result-commit-after-session-record-write");

  const second = createLocalHarnessDurableServices({ rootDir: root });
  await expect(second.results.getByIdempotencyKey({
    sessionId: "sess_1",
    idempotencyKey: "terminal:call_1",
  })).resolves.toMatchObject({
    record: {
      resultId: result.resultId,
      committedAt: expect.any(String),
      inlineSummary: "summary",
      outputPath: "/tmp/output.json",
    },
    value: { value: "first" },
  });
  await expect(second.results.commit({ sessionId: "sess_1", resultId: result.resultId }, { value: "first" }))
    .resolves.toMatchObject({
      resultId: result.resultId,
      committedAt: expect.any(String),
      inlineSummary: "summary",
      outputPath: "/tmp/output.json",
    });
});

it("keeps root result indexes as lookup pointers without committed metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "lh-durable-services-"));
  const dataDir = await mkdtemp(join(tmpdir(), "lh-session-"));
  dirs.push(root, dataDir);
  const services = createLocalHarnessDurableServices({ rootDir: root });
  const result = await services.results.allocate({
    sessionId: "sess_1",
    sessionDataDir: dataDir,
    kind: "tool",
    idempotencyKey: "terminal:call_1",
  });

  await services.results.commit(
    { sessionId: "sess_1", resultId: result.resultId },
    { value: "first" },
    { inlineSummary: "summary", outputPath: "/tmp/output.json" },
  );

  const rootIndexJson = await readJsonFiles(join(root, "result-index"));
  expect(rootIndexJson).not.toContain("summary");
  expect(rootIndexJson).not.toContain("/tmp/output.json");
  expect(rootIndexJson).not.toContain("inlineSummary");
  expect(rootIndexJson).not.toContain("outputPath");
  await expect(services.results.getByIdempotencyKey({
    sessionId: "sess_1",
    idempotencyKey: "terminal:call_1",
  })).resolves.toMatchObject({
    record: {
      inlineSummary: "summary",
      outputPath: "/tmp/output.json",
      committedAt: expect.any(String),
    },
  });
});

it("keeps task terminal writes first-writer-wins under concurrent terminal updates", async () => {
  const root = await mkdtemp(join(tmpdir(), "lh-durable-services-"));
  dirs.push(root);
  const services = createLocalHarnessDurableServices({ rootDir: root });
  const task = await services.tasks.reserveTask({ sessionId: "sess_1", kind: "tool" });

  const updates = await Promise.all([
    services.tasks.updateTaskTerminal({
      sessionId: "sess_1",
      taskId: task.taskId,
      status: "failed",
      terminalCauseCode: "workflow_failed",
      terminalMessage: "failed",
    }),
    services.tasks.updateTaskTerminal({
      sessionId: "sess_1",
      taskId: task.taskId,
      status: "cancelled",
      terminalCauseCode: "cancelled",
      terminalMessage: "cancelled",
    }),
  ]);

  expect(new Set(updates.map((update) => update?.status)).size).toBe(1);
});

it("does not let a stale task update overwrite terminal state", async () => {
  const root = await mkdtemp(join(tmpdir(), "lh-durable-services-"));
  dirs.push(root);
  const services = createLocalHarnessDurableServices({ rootDir: root });
  const task = await services.tasks.reserveTask({ sessionId: "sess_1", kind: "workflow" });

  await services.tasks.updateTaskTerminal({
    sessionId: "sess_1",
    taskId: task.taskId,
    status: "failed",
    terminalCauseCode: "workflow_failed",
    terminalMessage: "failed",
  });
  await services.tasks.updateTask({ ...task, queueId: "queue_1", callIdentity: "call_1" });

  await expect(services.tasks.getTask({ sessionId: "sess_1", taskId: task.taskId })).resolves.toMatchObject({
    status: "failed",
    terminalCauseCode: "workflow_failed",
    queueId: "queue_1",
    callIdentity: "call_1",
  });
});

it("keeps continuation wait updates first-writer-safe under concurrent child completions", async () => {
  const root = await mkdtemp(join(tmpdir(), "lh-durable-services-"));
  dirs.push(root);
  const services = createLocalHarnessDurableServices({ rootDir: root });
  await services.continuations.put({
    continuationId: "cont_1",
    sessionId: "sess_1",
    originTurnId: "turn_1",
    parkedToolCallIds: ["tool_1"],
    waits: [{
      waitId: "wait_1",
      parkedToolCallId: "tool_1",
      predicate: { kind: "tasks", taskIds: ["task_1", "task_2"], mode: "all" },
      state: "open",
      outcomesById: {},
      terminalResultIds: [],
    }],
    terminalResultsByToolCallId: {},
    state: "open",
    createdAt: "2026-06-22T00:00:00.000Z",
    updatedAt: "2026-06-22T00:00:00.000Z",
  });

  await Promise.all([
    services.continuations.markWaitTerminal({
      continuationId: "cont_1",
      waitId: "wait_1",
      matchedId: "task_1",
      fromState: "open",
      toState: "terminal",
      terminalResultIds: ["result_1"],
      terminalAt: "2026-06-22T00:00:01.000Z",
      resumeQueueId: "resume_1",
      resumeReason: "predicate_satisfied",
    }),
    services.continuations.markWaitTerminal({
      continuationId: "cont_1",
      waitId: "wait_1",
      matchedId: "task_2",
      fromState: "open",
      toState: "terminal",
      terminalResultIds: ["result_2"],
      terminalAt: "2026-06-22T00:00:02.000Z",
      resumeQueueId: "resume_1",
      resumeReason: "predicate_satisfied",
    }),
  ]);

  await expect(services.continuations.get("cont_1")).resolves.toMatchObject({
    state: "resume_enqueued",
    terminalResultsByToolCallId: { tool_1: ["result_1", "result_2"] },
  });
});

it("recovers a stale durable file lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "lh-durable-services-"));
  dirs.push(root);
  const lockPath = join(root, ".locks", `${recordKey(["task-ledger", "sess_1"])}.lock`);
  await mkdir(lockPath, { recursive: true });
  const staleTime = new Date(Date.now() - 60_000);
  await utimes(lockPath, staleTime, staleTime);

  const services = createLocalHarnessDurableServices({ rootDir: root });

  await expect(services.tasks.reserveTask({
    sessionId: "sess_1",
    kind: "tool",
    purpose: "recover after worker crash",
  })).resolves.toMatchObject({ taskId: "task_1" });
});

it("recovers a stale durable file lock with corrupt owner metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "lh-durable-services-"));
  dirs.push(root);
  const lockPath = join(root, ".locks", `${recordKey(["task-ledger", "sess_1"])}.lock`);
  const ownerPath = join(lockPath, "owner.json");
  await mkdir(lockPath, { recursive: true });
  await writeFile(ownerPath, "{not-json");
  const staleTime = new Date(Date.now() - 60_000);
  await utimes(ownerPath, staleTime, staleTime);

  const services = createLocalHarnessDurableServices({ rootDir: root });

  await expect(services.tasks.reserveTask({
    sessionId: "sess_1",
    kind: "tool",
    purpose: "recover corrupt stale owner",
  })).resolves.toMatchObject({ taskId: "task_1" });
});

it("transitions a wakeup only once under concurrent callers", async () => {
  const root = await mkdtemp(join(tmpdir(), "lh-durable-services-"));
  dirs.push(root);
  const services = createLocalHarnessDurableServices({ rootDir: root });
  await services.wakeups.put({
    wakeupId: "wakeup_1",
    sessionId: "sess_1",
    originTurnId: "turn_1",
    predicate: { kind: "tasks", taskIds: ["task_1"], mode: "all" },
    status: "armed",
    createdAt: "2026-06-22T00:00:00.000Z",
  });

  const transitions = await Promise.all([
    services.wakeups.transition("wakeup_1", "armed", "resume_enqueued", { resumeQueueId: "resume_1" }),
    services.wakeups.transition("wakeup_1", "armed", "resume_enqueued", { resumeQueueId: "resume_2" }),
  ]);

  expect(transitions.filter((transition) => transition.updated)).toHaveLength(1);
  await expect(services.wakeups.get("wakeup_1")).resolves.toMatchObject({ status: "resume_enqueued" });
});

it("does not overwrite a progressed wakeup when putIfAbsent is replayed", async () => {
  const root = await mkdtemp(join(tmpdir(), "lh-durable-services-"));
  dirs.push(root);
  const services = createLocalHarnessDurableServices({ rootDir: root });
  const record = {
    wakeupId: "wakeup_1",
    sessionId: "sess_1",
    originTurnId: "turn_1",
    predicate: { kind: "tasks" as const, taskIds: ["task_1" as const], mode: "all" as const },
    status: "armed" as const,
    createdAt: "2026-06-22T00:00:00.000Z",
  };

  await expect(services.wakeups.putIfAbsent(record)).resolves.toMatchObject({ inserted: true });
  await services.wakeups.transition("wakeup_1", "armed", "resume_enqueued", { resumeQueueId: "resume_1" });
  await expect(services.wakeups.putIfAbsent({
    ...record,
    createdAt: "2026-06-22T00:00:01.000Z",
  })).resolves.toMatchObject({
    inserted: false,
    record: { status: "resume_enqueued", resumeQueueId: "resume_1" },
  });
  await expect(services.wakeups.get("wakeup_1")).resolves.toMatchObject({
    status: "resume_enqueued",
    resumeQueueId: "resume_1",
  });
});

it("enqueues and claims resume records only once under concurrent workers", async () => {
  const root = await mkdtemp(join(tmpdir(), "lh-durable-services-"));
  dirs.push(root);
  const services = createLocalHarnessDurableServices({ rootDir: root });
  const record = {
    resumeId: "resume_1",
    continuationId: "cont_1",
    sessionId: "sess_1",
    originTurnId: "turn_1",
    reason: "predicate_satisfied" as const,
    terminalResultIds: ["result_1"],
    enqueuedAt: "2026-06-22T00:00:00.000Z",
  };

  const enqueues = await Promise.all([
    services.resumeQueue.ensureEnqueued(record),
    services.resumeQueue.ensureEnqueued(record),
  ]);
  expect(enqueues.filter((enqueue) => enqueue.enqueued)).toHaveLength(1);

  const claims = await Promise.all([
    services.resumeQueue.claimNext(),
    services.resumeQueue.claimNext("sess_1"),
  ]);
  expect(claims.filter((claim) => claim !== undefined)).toHaveLength(1);
});

it("rejects workflow launch replay when the persisted envelope changed", async () => {
  const root = await mkdtemp(join(tmpdir(), "lh-durable-services-"));
  const dataDir = await mkdtemp(join(tmpdir(), "lh-session-"));
  dirs.push(root, dataDir);
  const services = createLocalHarnessDurableServices({ rootDir: root });
  const base = workflowLaunchInput({ sessionDataDir: dataDir });

  await services.workflowLaunches.reserveLaunch(base);

  await expect(services.workflowLaunches.reserveLaunch({
    ...base,
    input: { changed: true },
    inputHash: "sha256:changed",
  })).rejects.toThrow(/replay identity mismatch/i);
});

it("rejects workflow launch replay when inherited capabilities changed", async () => {
  const root = await mkdtemp(join(tmpdir(), "lh-durable-services-"));
  const dataDir = await mkdtemp(join(tmpdir(), "lh-session-"));
  dirs.push(root, dataDir);
  const services = createLocalHarnessDurableServices({ rootDir: root });
  const base = workflowLaunchInput({ sessionDataDir: dataDir });

  await services.workflowLaunches.reserveLaunch(base);

  await expect(services.workflowLaunches.reserveLaunch({
    ...base,
    inheritance: {
      ...base.inheritance,
      tools: { mode: "allowlist", handles: ["different_tool"] },
    },
  })).rejects.toThrow(/replay identity mismatch/i);
});

it("rolls a workflow launch forward after crashing after task reservation", async () => {
  const root = await mkdtemp(join(tmpdir(), "lh-durable-services-"));
  const dataDir = await mkdtemp(join(tmpdir(), "lh-session-"));
  dirs.push(root, dataDir);
  const base = workflowLaunchInput({ sessionDataDir: dataDir });
  const first = createLocalHarnessDurableServices({
    rootDir: root,
    faultInjection: failOnce("workflow-launch-after-task-reserve-before-journal"),
  });

  await expect(first.workflowLaunches.reserveLaunch(base)).rejects.toThrow("injected workflow-launch-after-task-reserve-before-journal");
  await expect(first.tasks.taskIdForCallIdentity({
    sessionId: base.sessionId,
    callIdentity: base.callIdentity,
  })).resolves.toBeUndefined();
  await expect(first.workflowQueue.listRuns({ sessionId: base.sessionId })).resolves.toHaveLength(0);

  const second = createLocalHarnessDurableServices({ rootDir: root });
  await expect(second.workflowLaunches.reserveLaunch({
    ...base,
    input: { candidateId: "C2" },
    inputHash: "sha256:changed",
  })).rejects.toThrow(/replay identity mismatch/i);
  await expect(second.workflowQueue.listRuns({ sessionId: base.sessionId })).resolves.toHaveLength(0);

  const replay = await second.workflowLaunches.reserveLaunch(base);

  expect(replay).toMatchObject({
    replay: true,
    task: { taskId: "task_1", callIdentity: base.callIdentity, queueId: "queue_1" },
    queueRecord: { taskId: "task_1", queueId: "queue_1", callIdentity: base.callIdentity },
    inputResult: { resultId: "result_1" },
  });
  await expect(second.tasks.listTasks({ sessionId: base.sessionId })).resolves.toHaveLength(1);
});

it("rejects async launch replay when the persisted envelope changed", async () => {
  const root = await mkdtemp(join(tmpdir(), "lh-durable-services-"));
  const dataDir = await mkdtemp(join(tmpdir(), "lh-session-"));
  dirs.push(root, dataDir);
  const services = createLocalHarnessDurableServices({ rootDir: root });
  const base = asyncLaunchInput({ sessionDataDir: dataDir });

  await services.asyncLaunches.reserveLaunch(base);

  await expect(services.asyncLaunches.reserveLaunch({
    ...base,
    input: { candidateId: "C2" },
    inputHash: "sha256:changed",
  })).rejects.toThrow(/replay identity mismatch/i);
});

it("rolls an async launch forward after crashing after task reservation", async () => {
  const root = await mkdtemp(join(tmpdir(), "lh-durable-services-"));
  const dataDir = await mkdtemp(join(tmpdir(), "lh-session-"));
  dirs.push(root, dataDir);
  const base = asyncLaunchInput({ sessionDataDir: dataDir });
  const first = createLocalHarnessDurableServices({
    rootDir: root,
    faultInjection: failOnce("async-launch-after-task-reserve-before-journal"),
  });

  await expect(first.asyncLaunches.reserveLaunch(base)).rejects.toThrow("injected async-launch-after-task-reserve-before-journal");
  await expect(first.tasks.taskIdForCallIdentity({
    sessionId: base.sessionId,
    callIdentity: base.callIdentity,
  })).resolves.toBeUndefined();
  await expect(first.asyncTaskQueue.listNonTerminal({ sessionId: base.sessionId })).resolves.toHaveLength(0);

  const second = createLocalHarnessDurableServices({ rootDir: root });
  await expect(second.asyncLaunches.reserveLaunch({
    ...base,
    input: { candidateId: "C2" },
    inputHash: "sha256:changed",
  })).rejects.toThrow(/replay identity mismatch/i);
  await expect(second.asyncTaskQueue.listNonTerminal({ sessionId: base.sessionId })).resolves.toHaveLength(0);

  const replay = await second.asyncLaunches.reserveLaunch(base);

  expect(replay).toMatchObject({
    replay: true,
    task: { taskId: "task_1", callIdentity: base.callIdentity, queueId: "queue_1" },
    queueRecord: { taskId: "task_1", queueId: "queue_1", callIdentity: base.callIdentity },
    inputResult: { resultId: "result_1" },
  });
  await expect(second.tasks.listTasks({ sessionId: base.sessionId })).resolves.toHaveLength(1);
});

it("does not over-admit workflow or async task queue slots", async () => {
  const root = await mkdtemp(join(tmpdir(), "lh-durable-services-"));
  dirs.push(root);
  const services = createLocalHarnessDurableServices({ rootDir: root });
  await services.workflowQueue.enqueue({ sessionId: "sess_1", queueId: "queue_1", taskId: "task_1", reservedRunId: "run_1", workflowId: "a", handle: "a", status: "queued" } as never);
  await services.workflowQueue.enqueue({ sessionId: "sess_1", queueId: "queue_2", taskId: "task_2", reservedRunId: "run_2", workflowId: "b", handle: "b", status: "queued" } as never);

  const workflowResults = await Promise.all([
    services.workflowQueue.acquireAdmissionSlot({ sessionId: "sess_1", queueId: "queue_1", taskId: "task_1", maxConcurrentWorkflowRuns: 1 }),
    services.workflowQueue.acquireAdmissionSlot({ sessionId: "sess_1", queueId: "queue_2", taskId: "task_2", maxConcurrentWorkflowRuns: 1 }),
  ]);
  expect(workflowResults.filter((result) => result.admitted)).toHaveLength(1);

  await services.asyncTaskQueue.enqueue({ sessionId: "sess_1", queueId: "queue_1", taskId: "task_1", kind: "tool", handle: "a", status: "queued" } as never);
  await services.asyncTaskQueue.enqueue({ sessionId: "sess_1", queueId: "queue_2", taskId: "task_2", kind: "tool", handle: "b", status: "queued" } as never);
  const asyncResults = await Promise.all([
    services.asyncTaskQueue.acquireToolSlot({ sessionId: "sess_1", queueId: "queue_1", taskId: "task_1", maxConcurrentToolCalls: 1, leaseExpiresAt: "2999-01-01T00:00:00.000Z" }),
    services.asyncTaskQueue.acquireToolSlot({ sessionId: "sess_1", queueId: "queue_2", taskId: "task_2", maxConcurrentToolCalls: 1, leaseExpiresAt: "2999-01-01T00:00:00.000Z" }),
  ]);
  expect(asyncResults.filter((result) => result.acquired)).toHaveLength(1);
});

it("does not let workflow admission overwrite a terminal queue record", async () => {
  const root = await mkdtemp(join(tmpdir(), "lh-durable-services-"));
  dirs.push(root);
  const services = createLocalHarnessDurableServices({ rootDir: root });
  await services.workflowQueue.enqueue({
    sessionId: "sess_1",
    queueId: "queue_1",
    taskId: "task_1",
    reservedRunId: "run_1",
    workflowId: "a",
    handle: "a",
    callIdentity: "call_1",
    disposition: "start",
    inputHash: "sha256:input",
    inputResultId: "result_1",
    sessionDataDir: "/tmp/session",
    dataDir: "/tmp/session/workflow",
    originTurnId: "turn_1",
    parentTurnId: "turn_1",
    reservationScopeId: "scope_1",
    reservationOrder: 0,
    scopeSize: 1,
    workflowDefinitionIdentity: "sha256:def",
    memoryScope: "none",
    workflowSetDefinitionIdentities: [],
    inheritance: {},
    status: "queued",
    reservedAt: "2026-06-22T00:00:00.000Z",
    createdAt: "2026-06-22T00:00:00.000Z",
  } as never);

  await Promise.all([
    services.workflowQueue.acquireAdmissionSlot({
      sessionId: "sess_1",
      queueId: "queue_1",
      taskId: "task_1",
      maxConcurrentWorkflowRuns: 1,
    }),
    services.workflowQueue.markTerminal({
      sessionId: "sess_1",
      queueId: "queue_1",
      expectedStatuses: ["queued", "admitted"],
    }, {
      status: "completed",
      terminalAt: "2026-06-22T00:00:01.000Z",
    }),
  ]);

  await expect(services.workflowQueue.get({ sessionId: "sess_1", queueId: "queue_1" })).resolves.toMatchObject({
    status: "completed",
  });
});

it("does not let async tool-slot acquisition overwrite a terminal queue record", async () => {
  const root = await mkdtemp(join(tmpdir(), "lh-durable-services-"));
  dirs.push(root);
  const services = createLocalHarnessDurableServices({ rootDir: root });
  await services.asyncTaskQueue.enqueue({
    sessionId: "sess_1",
    queueId: "queue_1",
    taskId: "task_1",
    kind: "tool",
    handle: "score",
    callIdentity: "call_1",
    inputHash: "sha256:input",
    inputResultId: "result_1",
    sessionDataDir: "/tmp/session",
    originTurnId: "turn_1",
    parentTurnId: "turn_1",
    reservationScopeId: "scope_1",
    reservationOrder: 0,
    scopeSize: 1,
    capabilitySnapshot: { implementationHash: "sha256:tool" },
    status: "queued",
    createdAt: "2026-06-22T00:00:00.000Z",
  } as never);

  await Promise.all([
    services.asyncTaskQueue.acquireToolSlot({
      sessionId: "sess_1",
      queueId: "queue_1",
      taskId: "task_1",
      maxConcurrentToolCalls: 1,
      leaseExpiresAt: "2999-01-01T00:00:00.000Z",
    }),
    services.asyncTaskQueue.markTerminal({
      sessionId: "sess_1",
      queueId: "queue_1",
      expectedStatuses: ["queued"],
    }, {
      status: "completed",
      terminalAt: "2026-06-22T00:00:01.000Z",
    }),
  ]);

  await expect(services.asyncTaskQueue.get({ sessionId: "sess_1", queueId: "queue_1" })).resolves.toMatchObject({
    status: "completed",
  });
});

it("claims a queued async record only once under concurrent workers", async () => {
  const root = await mkdtemp(join(tmpdir(), "lh-durable-services-"));
  dirs.push(root);
  const services = createLocalHarnessDurableServices({ rootDir: root });
  await services.asyncTaskQueue.enqueue({ sessionId: "sess_1", queueId: "queue_1", taskId: "task_1", kind: "tool", handle: "score", status: "queued" } as never);

  const claims = await Promise.all([
    services.asyncTaskQueue.claimQueued({
      sessionId: "sess_1",
      queueId: "queue_1",
      attemptId: "attempt_1",
      attemptStartedAt: "2026-06-22T00:00:00.000Z",
      attemptLeaseExpiresAt: "2999-01-01T00:00:00.000Z",
    }),
    services.asyncTaskQueue.claimQueued({
      sessionId: "sess_1",
      queueId: "queue_1",
      attemptId: "attempt_2",
      attemptStartedAt: "2026-06-22T00:00:00.000Z",
      attemptLeaseExpiresAt: "2999-01-01T00:00:00.000Z",
    }),
  ]);

  expect(claims.filter((result) => result.claimed)).toHaveLength(1);
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
    sessionDataDir: "/tmp/lh-session",
    dataDir: "/tmp/lh-session/workflows/candidate_review",
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

type AsyncLaunchInput = Parameters<ReturnType<typeof createLocalHarnessDurableServices>["asyncLaunches"]["reserveLaunch"]>[0];

function asyncLaunchInput(overrides: Partial<AsyncLaunchInput> = {}): AsyncLaunchInput {
  return {
    sessionId: "sess_1",
    kind: "tool",
    handle: "score_candidate",
    purpose: "score",
    callIdentity: "call_1",
    input: { candidateId: "C1" },
    inputHash: "sha256:input",
    sessionDataDir: "/tmp/lh-session",
    originTurnId: "turn_1",
    parentTurnId: "turn_1",
    reservationScopeId: "scope_1",
    reservationOrder: 0,
    scopeSize: 1,
    capabilitySnapshot: { implementationHash: "sha256:tool" },
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

async function readJsonFiles(dir: string): Promise<string> {
  let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return "";
  }
  const contents = await Promise.all(entries.map(async (entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return readJsonFiles(path);
    }
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      return "";
    }
    return readFile(path, "utf8");
  }));
  return contents.join("\n");
}

function recordKey(value: unknown): string {
  return stableHash({ kind: "record", value }, { format: "base32hex" });
}
