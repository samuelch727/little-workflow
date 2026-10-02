import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createLocalHarnessDurableServices,
  type LocalHarnessDurableServicesFaultPoint,
} from "../local-host/durable-services.js";
import { createWorkflowScheduler } from "./scheduler.js";
import type { WorkflowReserveInput } from "./types.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

type SchedulerLimits = {
  readonly maxConcurrentWorkflowRuns: number;
  readonly maxQueuedWorkflowRuns: number;
  readonly queueDeadlineMs?: number;
  readonly now?: () => Date;
};

async function createTestScheduler(limits: SchedulerLimits) {
  const rootDir = await mkdtemp(join(tmpdir(), "lh-workflow-scheduler-"));
  const sessionDataDir = await mkdtemp(join(tmpdir(), "lh-workflow-session-"));
  dirs.push(rootDir, sessionDataDir);
  const durable = createLocalHarnessDurableServices({ rootDir });
  const scheduler = createWorkflowScheduler({ durable, ...limits });
  return { durable, rootDir, scheduler, sessionDataDir };
}

function createSchedulerAtRoot(rootDir: string, limits: SchedulerLimits) {
  const durable = createLocalHarnessDurableServices({ rootDir });
  const scheduler = createWorkflowScheduler({ durable, ...limits });
  return { durable, scheduler };
}

function reserveInput(
  sessionDataDir: string,
  overrides: Partial<WorkflowReserveInput> = {},
): WorkflowReserveInput {
  return {
    sessionId: "sess_1",
    workflowId: "candidate.review",
    handle: "candidate_review",
    disposition: "start",
    input: { candidateId: "C1" },
    inputHash: "sha256:input-1",
    sessionDataDir,
    dataDir: join(sessionDataDir, "workflows", "candidate_review"),
    originTurnId: "turn_1",
    parentTurnId: "turn_1",
    callIdentity: "turn_1/model_step_1/tool_1",
    reservationScopeId: "turn_1/model_step_1",
    reservationOrder: 0,
    scopeSize: 1,
    workflowDefinitionIdentity: "sha256:def",
    memoryScope: "cross-session",
    workflowSetMemoryKey: "workflow-set:sha256:def",
    workflowSetDefinitionIdentities: ["sha256:def"],
    inheritance: {
      permissions: {
        mode: "none",
        approvalPolicy: "reject_ask",
      },
      tools: {
        mode: "allowlist",
        handles: ["score_candidate"],
      },
      mcpTools: {
        mode: "none",
        handles: [],
      },
      skills: {
        mode: "allowlist",
        names: ["evidence-rubric"],
      },
      mounts: [
        {
          name: "workflow-results",
          path: ".little-harness/results",
          access: "read",
        },
      ],
    },
    source: "static",
    ...overrides,
  };
}

describe("createWorkflowScheduler reserve", () => {
  it("queues launches when maxConcurrentWorkflowRuns is saturated", async () => {
    const { durable, scheduler, sessionDataDir } = await createTestScheduler({
      maxConcurrentWorkflowRuns: 1,
      maxQueuedWorkflowRuns: 2,
    });

    const first = await scheduler.reserve(reserveInput(sessionDataDir, {
      workflowId: "candidate.review.primary",
      handle: "candidate_review_primary",
      callIdentity: "turn_1/model_step_1/tool_1",
      inputHash: "sha256:input-1",
    }));
    const second = await scheduler.reserve(reserveInput(sessionDataDir, {
      workflowId: "candidate.review.backup",
      handle: "candidate_review_backup",
      callIdentity: "turn_1/model_step_1/tool_2",
      input: { candidateId: "C2" },
      inputHash: "sha256:input-2",
    }));

    expect(first).toMatchObject({ status: "admitted", modelFacingStatus: "running" });
    expect(second).toMatchObject({ status: "queued", modelFacingStatus: "queued" });
    await expect(durable.workflowQueue.listRuns({ sessionId: "sess_1", statuses: ["admitted"] })).resolves.toHaveLength(1);
    await expect(durable.workflowQueue.listRuns({ sessionId: "sess_1", statuses: ["queued"] })).resolves.toHaveLength(1);
  });

  it("rejects when the durable queue is full", async () => {
    const { durable, scheduler, sessionDataDir } = await createTestScheduler({
      maxConcurrentWorkflowRuns: 0,
      maxQueuedWorkflowRuns: 1,
    });

    await scheduler.reserve(reserveInput(sessionDataDir, {
      workflowId: "candidate.review.primary",
      handle: "candidate_review_primary",
      callIdentity: "turn_1/model_step_1/tool_1",
    }));

    await expect(scheduler.reserve(reserveInput(sessionDataDir, {
      workflowId: "candidate.review.backup",
      handle: "candidate_review_backup",
      callIdentity: "turn_1/model_step_1/tool_2",
      input: { candidateId: "C2" },
      inputHash: "sha256:input-2",
    }))).rejects.toMatchObject({
      details: expect.objectContaining({
        causeCode: "max_queued_workflow_runs",
        maxQueuedWorkflowRuns: 1,
      }),
    });
    await expect(durable.workflowQueue.listRuns({ sessionId: "sess_1" })).resolves.toHaveLength(1);
    await expect(durable.tasks.listTasks({ sessionId: "sess_1" })).resolves.toHaveLength(1);
  });

  it("replays by callIdentity with the same task, queue, run, and input result ids after restart", async () => {
    const { rootDir, scheduler, sessionDataDir } = await createTestScheduler({
      maxConcurrentWorkflowRuns: 1,
      maxQueuedWorkflowRuns: 10,
    });
    const first = await scheduler.reserve(reserveInput(sessionDataDir));
    const { scheduler: restarted } = createSchedulerAtRoot(rootDir, {
      maxConcurrentWorkflowRuns: 1,
      maxQueuedWorkflowRuns: 10,
    });

    const replay = await restarted.reserve(reserveInput(sessionDataDir, { replay: true }));

    expect(replay).toMatchObject({
      taskId: first.taskId,
      queueId: first.queueId,
      reservedRunId: first.reservedRunId,
      inputResultId: first.inputResultId,
    });
  });

  it("replays an existing queued call even when the durable queue is full", async () => {
    const { scheduler, sessionDataDir } = await createTestScheduler({
      maxConcurrentWorkflowRuns: 0,
      maxQueuedWorkflowRuns: 1,
    });
    const first = await scheduler.reserve(reserveInput(sessionDataDir));

    const replay = await scheduler.reserve(reserveInput(sessionDataDir, { replay: true }));

    expect(replay).toEqual(first);
  });

  it("does not let replay=true bypass capacity for a brand-new call identity", async () => {
    const { durable, scheduler, sessionDataDir } = await createTestScheduler({
      maxConcurrentWorkflowRuns: 0,
      maxQueuedWorkflowRuns: 1,
    });
    await scheduler.reserve(reserveInput(sessionDataDir, {
      callIdentity: "turn_1/model_step_1/tool_1",
    }));

    await expect(scheduler.reserve(reserveInput(sessionDataDir, {
      callIdentity: "turn_1/model_step_1/tool_2",
      input: { candidateId: "C2" },
      inputHash: "sha256:input-2",
      replay: true,
    }))).rejects.toMatchObject({
      details: expect.objectContaining({ causeCode: "max_queued_workflow_runs" }),
    });
    await expect(durable.workflowQueue.listRuns({ sessionId: "sess_1" })).resolves.toHaveLength(1);
    await expect(durable.tasks.listTasks({ sessionId: "sess_1" })).resolves.toHaveLength(1);
    await expect(durable.results.getByIdempotencyKey({
      sessionId: "sess_1",
      idempotencyKey: "input:turn_1/model_step_1/tool_2",
    })).resolves.toBeUndefined();
  });

  it("assigns incremental task ids by reservation order even when a later launch reaches reserve first", async () => {
    const { scheduler, sessionDataDir } = await createTestScheduler({
      maxConcurrentWorkflowRuns: 1,
      maxQueuedWorkflowRuns: 10,
    });

    const laterLaunch = scheduler.reserve(reserveInput(sessionDataDir, {
      callIdentity: "turn_1/model_step_1/tool_2",
      reservationOrder: 1,
      scopeSize: 2,
      input: { candidateId: "C2" },
      inputHash: "sha256:input-2",
    }));
    const earlierLaunch = scheduler.reserve(reserveInput(sessionDataDir, {
      callIdentity: "turn_1/model_step_1/tool_1",
      reservationOrder: 0,
      scopeSize: 2,
    }));

    await expect(earlierLaunch).resolves.toMatchObject({ taskId: "task_1" });
    await expect(laterLaunch).resolves.toMatchObject({ taskId: "task_2" });
  });

  it("rejects missing workflowDefinitionIdentity", async () => {
    const { durable, scheduler, sessionDataDir } = await createTestScheduler({
      maxConcurrentWorkflowRuns: 1,
      maxQueuedWorkflowRuns: 10,
    });

    await expect(scheduler.reserve(reserveInput(sessionDataDir, {
      workflowDefinitionIdentity: undefined as never,
    }))).rejects.toThrow(/workflow definition identity/i);
    await expect(durable.workflowQueue.listRuns({ sessionId: "sess_1" })).resolves.toHaveLength(0);
    await expect(durable.tasks.listTasks({ sessionId: "sess_1" })).resolves.toHaveLength(0);
  });

  it("rejects replay with changed inputHash without minting new task, result, or queue records", async () => {
    const { durable, scheduler, sessionDataDir } = await createTestScheduler({
      maxConcurrentWorkflowRuns: 1,
      maxQueuedWorkflowRuns: 10,
    });
    const first = await scheduler.reserve(reserveInput(sessionDataDir));
    const originalInputResult = await durable.results.getByIdempotencyKey({
      sessionId: "sess_1",
      idempotencyKey: "input:turn_1/model_step_1/tool_1",
    });

    await expect(scheduler.reserve(reserveInput(sessionDataDir, {
      input: { candidateId: "changed" },
      inputHash: "sha256:changed",
      replay: true,
    }))).rejects.toMatchObject({
      details: expect.objectContaining({ causeCode: "replay_identity_mismatch" }),
    });

    await expect(durable.tasks.listTasks({ sessionId: "sess_1" })).resolves.toHaveLength(1);
    await expect(durable.workflowQueue.listRuns({ sessionId: "sess_1" })).resolves.toHaveLength(1);
    await expect(durable.results.getByIdempotencyKey({
      sessionId: "sess_1",
      idempotencyKey: "input:turn_1/model_step_1/tool_1",
    })).resolves.toMatchObject({ record: { resultId: first.inputResultId } });
    expect(originalInputResult?.record.resultId).toBe(first.inputResultId);
  });

  it("rejects replay identity mismatch before admitting the queued workflow", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "lh-workflow-scheduler-"));
    const sessionDataDir = await mkdtemp(join(tmpdir(), "lh-workflow-session-"));
    dirs.push(rootDir, sessionDataDir);
    const queueOnly = createSchedulerAtRoot(rootDir, {
      maxConcurrentWorkflowRuns: 0,
      maxQueuedWorkflowRuns: 10,
    });
    const queued = await queueOnly.scheduler.reserve(reserveInput(sessionDataDir));
    expect(queued.status).toBe("queued");

    const admitting = createSchedulerAtRoot(rootDir, {
      maxConcurrentWorkflowRuns: 1,
      maxQueuedWorkflowRuns: 10,
    });
    await expect(admitting.scheduler.reserve(reserveInput(sessionDataDir, {
      input: { candidateId: "changed" },
      inputHash: "sha256:changed",
      replay: true,
    }))).rejects.toMatchObject({
      details: expect.objectContaining({ causeCode: "replay_identity_mismatch" }),
    });

    await expect(admitting.durable.workflowQueue.get({ sessionId: "sess_1", queueId: queued.queueId })).resolves.toMatchObject({
      status: "queued",
    });
  });

  it("rejects replay with changed inheritance before queue or admission mutation", async () => {
    const { durable, scheduler, sessionDataDir } = await createTestScheduler({
      maxConcurrentWorkflowRuns: 1,
      maxQueuedWorkflowRuns: 10,
    });
    await scheduler.reserve(reserveInput(sessionDataDir));
    const before = await durable.workflowQueue.listRuns({ sessionId: "sess_1" });

    await expect(scheduler.reserve(reserveInput(sessionDataDir, {
      inheritance: {
        permissions: { mode: "none", approvalPolicy: "reject_ask" },
        tools: { mode: "allowlist", handles: ["different_tool"] },
      },
      replay: true,
    }))).rejects.toMatchObject({
      details: expect.objectContaining({ causeCode: "replay_identity_mismatch" }),
    });

    await expect(durable.workflowQueue.listRuns({ sessionId: "sess_1" })).resolves.toEqual(before);
    await expect(durable.tasks.listTasks({ sessionId: "sess_1" })).resolves.toHaveLength(1);
  });

  it("rejects replay with changed workflowDefinitionIdentity before queue or admission mutation", async () => {
    const { durable, scheduler, sessionDataDir } = await createTestScheduler({
      maxConcurrentWorkflowRuns: 1,
      maxQueuedWorkflowRuns: 10,
    });
    await scheduler.reserve(reserveInput(sessionDataDir));
    const before = await durable.workflowQueue.listRuns({ sessionId: "sess_1" });

    await expect(scheduler.reserve(reserveInput(sessionDataDir, {
      workflowDefinitionIdentity: "sha256:different-def",
      replay: true,
    }))).rejects.toMatchObject({
      details: expect.objectContaining({ causeCode: "replay_identity_mismatch" }),
    });

    await expect(durable.workflowQueue.listRuns({ sessionId: "sess_1" })).resolves.toEqual(before);
    await expect(durable.tasks.listTasks({ sessionId: "sess_1" })).resolves.toHaveLength(1);
  });

  it("derives queueDeadlineAt from reservedAt when queueDeadlineMs is configured and queueDeadlineAt is omitted", async () => {
    const queueDeadlineMs = 45_000;
    const { durable, scheduler, sessionDataDir } = await createTestScheduler({
      maxConcurrentWorkflowRuns: 1,
      maxQueuedWorkflowRuns: 10,
      queueDeadlineMs,
    });
    await scheduler.reserve(reserveInput(sessionDataDir, {
      workflowId: "candidate.review.primary",
      handle: "candidate_review_primary",
      callIdentity: "turn_1/model_step_1/tool_1",
    }));

    const queued = await scheduler.reserve(reserveInput(sessionDataDir, {
      workflowId: "candidate.review.backup",
      handle: "candidate_review_backup",
      callIdentity: "turn_1/model_step_1/tool_2",
      input: { candidateId: "C2" },
      inputHash: "sha256:input-2",
    }));
    const record = await durable.workflowQueue.get({ sessionId: "sess_1", queueId: queued.queueId });

    expect(record).toMatchObject({ status: "queued", queueDeadlineAt: expect.any(String) });
    expect(new Date(record?.queueDeadlineAt ?? 0).getTime()).toBe(
      new Date(record?.reservedAt ?? 0).getTime() + queueDeadlineMs,
    );
  });

  it("does not admit beyond maxConcurrentWorkflowRuns across two scheduler instances on the same durable root", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "lh-workflow-scheduler-"));
    const sessionDataDir = await mkdtemp(join(tmpdir(), "lh-workflow-session-"));
    dirs.push(rootDir, sessionDataDir);
    const first = createSchedulerAtRoot(rootDir, {
      maxConcurrentWorkflowRuns: 1,
      maxQueuedWorkflowRuns: 10,
    });
    const second = createSchedulerAtRoot(rootDir, {
      maxConcurrentWorkflowRuns: 1,
      maxQueuedWorkflowRuns: 10,
    });

    const results = await Promise.all([
      first.scheduler.reserve(reserveInput(sessionDataDir, {
        callIdentity: "turn_1/model_step_1/tool_1",
        inputHash: "sha256:input-1",
      })),
      second.scheduler.reserve(reserveInput(sessionDataDir, {
        callIdentity: "turn_1/model_step_1/tool_2",
        input: { candidateId: "C2" },
        inputHash: "sha256:input-2",
      })),
    ]);

    expect(results.filter((result) => result.status === "admitted")).toHaveLength(1);
    await expect(first.durable.workflowQueue.listRuns({ sessionId: "sess_1", statuses: ["admitted"] })).resolves.toHaveLength(1);
  });

  it("does not enqueue past maxQueuedWorkflowRuns under concurrent new launches", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "lh-workflow-scheduler-"));
    const sessionDataDir = await mkdtemp(join(tmpdir(), "lh-workflow-session-"));
    dirs.push(rootDir, sessionDataDir);
    const first = createSchedulerAtRoot(rootDir, {
      maxConcurrentWorkflowRuns: 0,
      maxQueuedWorkflowRuns: 1,
    });
    const second = createSchedulerAtRoot(rootDir, {
      maxConcurrentWorkflowRuns: 0,
      maxQueuedWorkflowRuns: 1,
    });

    const results = await Promise.allSettled([
      first.scheduler.reserve(reserveInput(sessionDataDir, {
        callIdentity: "turn_1/model_step_1/tool_1",
        inputHash: "sha256:input-1",
      })),
      second.scheduler.reserve(reserveInput(sessionDataDir, {
        callIdentity: "turn_1/model_step_1/tool_2",
        input: { candidateId: "C2" },
        inputHash: "sha256:input-2",
      })),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    await expect(first.durable.workflowQueue.listRuns({ sessionId: "sess_1", statuses: ["queued"] })).resolves.toHaveLength(1);
  });

  it("accounts for available admission slots when limiting concurrent queued launches", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "lh-workflow-scheduler-"));
    const sessionDataDir = await mkdtemp(join(tmpdir(), "lh-workflow-session-"));
    dirs.push(rootDir, sessionDataDir);
    const first = createSchedulerAtRoot(rootDir, {
      maxConcurrentWorkflowRuns: 1,
      maxQueuedWorkflowRuns: 1,
    });
    const second = createSchedulerAtRoot(rootDir, {
      maxConcurrentWorkflowRuns: 1,
      maxQueuedWorkflowRuns: 1,
    });
    const third = createSchedulerAtRoot(rootDir, {
      maxConcurrentWorkflowRuns: 1,
      maxQueuedWorkflowRuns: 1,
    });

    const results = await Promise.allSettled([
      first.scheduler.reserve(reserveInput(sessionDataDir, {
        callIdentity: "turn_1/model_step_1/tool_1",
        inputHash: "sha256:input-1",
      })),
      second.scheduler.reserve(reserveInput(sessionDataDir, {
        callIdentity: "turn_1/model_step_1/tool_2",
        input: { candidateId: "C2" },
        inputHash: "sha256:input-2",
      })),
      third.scheduler.reserve(reserveInput(sessionDataDir, {
        callIdentity: "turn_1/model_step_1/tool_3",
        input: { candidateId: "C3" },
        inputHash: "sha256:input-3",
      })),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(2);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    await expect(first.durable.workflowQueue.listRuns({ sessionId: "sess_1", statuses: ["admitted"] })).resolves.toHaveLength(1);
    await expect(first.durable.workflowQueue.listRuns({ sessionId: "sess_1", statuses: ["queued"] })).resolves.toHaveLength(1);
  });

  it("replays concurrent duplicate call identities instead of rejecting the second as queue-full", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "lh-workflow-scheduler-"));
    const sessionDataDir = await mkdtemp(join(tmpdir(), "lh-workflow-session-"));
    dirs.push(rootDir, sessionDataDir);
    const first = createSchedulerAtRoot(rootDir, {
      maxConcurrentWorkflowRuns: 0,
      maxQueuedWorkflowRuns: 1,
    });
    const second = createSchedulerAtRoot(rootDir, {
      maxConcurrentWorkflowRuns: 0,
      maxQueuedWorkflowRuns: 1,
    });

    const results = await Promise.all([
      first.scheduler.reserve(reserveInput(sessionDataDir)),
      second.scheduler.reserve(reserveInput(sessionDataDir)),
    ]);

    expect(results[1]).toEqual(results[0]);
    await expect(first.durable.workflowQueue.listRuns({ sessionId: "sess_1", statuses: ["queued"] })).resolves.toHaveLength(1);
    await expect(first.durable.tasks.listTasks({ sessionId: "sess_1" })).resolves.toHaveLength(1);
  });

  it("rolls forward a pending pre-queue launch replay even after another queue item fills capacity", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "lh-workflow-scheduler-"));
    const sessionDataDir = await mkdtemp(join(tmpdir(), "lh-workflow-session-"));
    dirs.push(rootDir, sessionDataDir);
    const faultedDurable = createLocalHarnessDurableServices({
      rootDir,
      faultInjection: failOnce("workflow-launch-after-task-reserve-before-journal"),
    });
    const faulted = createWorkflowScheduler({
      durable: faultedDurable,
      maxConcurrentWorkflowRuns: 0,
      maxQueuedWorkflowRuns: 1,
    });

    await expect(faulted.reserve(reserveInput(sessionDataDir, {
      callIdentity: "turn_1/model_step_1/tool_1",
    }))).rejects.toThrow("injected workflow-launch-after-task-reserve-before-journal");

    const filler = createSchedulerAtRoot(rootDir, {
      maxConcurrentWorkflowRuns: 0,
      maxQueuedWorkflowRuns: 1,
    });
    await filler.scheduler.reserve(reserveInput(sessionDataDir, {
      callIdentity: "turn_1/model_step_1/tool_2",
      input: { candidateId: "C2" },
      inputHash: "sha256:input-2",
    }));

    const recovery = createSchedulerAtRoot(rootDir, {
      maxConcurrentWorkflowRuns: 0,
      maxQueuedWorkflowRuns: 1,
    });
    await expect(recovery.scheduler.reserve(reserveInput(sessionDataDir, {
      callIdentity: "turn_1/model_step_1/tool_1",
      replay: true,
    }))).resolves.toMatchObject({ taskId: "task_1", queueId: "queue_1" });
    await expect(recovery.durable.workflowQueue.listRuns({ sessionId: "sess_1", statuses: ["queued"] })).resolves.toHaveLength(2);
  });

  it("admits the oldest queued workflow before a newly reserved workflow", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "lh-workflow-scheduler-"));
    const sessionDataDir = await mkdtemp(join(tmpdir(), "lh-workflow-session-"));
    dirs.push(rootDir, sessionDataDir);
    const queueOnly = createSchedulerAtRoot(rootDir, {
      maxConcurrentWorkflowRuns: 0,
      maxQueuedWorkflowRuns: 10,
    });
    const older = await queueOnly.scheduler.reserve(reserveInput(sessionDataDir, {
      callIdentity: "turn_1/model_step_1/tool_1",
      inputHash: "sha256:input-1",
    }));
    expect(older.status).toBe("queued");

    const admitting = createSchedulerAtRoot(rootDir, {
      maxConcurrentWorkflowRuns: 1,
      maxQueuedWorkflowRuns: 10,
    });
    const newer = await admitting.scheduler.reserve(reserveInput(sessionDataDir, {
      callIdentity: "turn_1/model_step_1/tool_2",
      input: { candidateId: "C2" },
      inputHash: "sha256:input-2",
    }));

    await expect(admitting.durable.workflowQueue.get({ sessionId: "sess_1", queueId: older.queueId })).resolves.toMatchObject({
      status: "admitted",
    });
    await expect(admitting.durable.workflowQueue.get({ sessionId: "sess_1", queueId: newer.queueId })).resolves.toMatchObject({
      status: "queued",
    });
    expect(newer.status).toBe("queued");
  });

  it("admits a still-queued record when the FIFO head went non-queued mid-drain", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "lh-workflow-scheduler-"));
    const sessionDataDir = await mkdtemp(join(tmpdir(), "lh-workflow-session-"));
    dirs.push(rootDir, sessionDataDir);
    const queueOnly = createSchedulerAtRoot(rootDir, {
      maxConcurrentWorkflowRuns: 0,
      maxQueuedWorkflowRuns: 10,
    });
    const a = await queueOnly.scheduler.reserve(reserveInput(sessionDataDir, {
      callIdentity: "turn_1/model_step_1/tool_1",
      inputHash: "sha256:input-1",
    }));
    const b = await queueOnly.scheduler.reserve(reserveInput(sessionDataDir, {
      callIdentity: "turn_1/model_step_1/tool_2",
      input: { candidateId: "C2" },
      inputHash: "sha256:input-2",
    }));
    expect(a.status).toBe("queued");
    expect(b.status).toBe("queued");

    const admittingDurable = createLocalHarnessDurableServices({ rootDir });
    const realAcquire = admittingDurable.workflowQueue.acquireAdmissionSlot.bind(admittingDurable.workflowQueue);
    let drovenHead = false;
    // Simulate a concurrent scheduler instance vacating the FIFO head (A): on the
    // first acquire for A, admit A out-of-band and drive it to a terminal state so
    // its admission slot is free again, then delegate (A is no longer "queued").
    admittingDurable.workflowQueue.acquireAdmissionSlot = async (input) => {
      if (!drovenHead && input.queueId === a.queueId) {
        drovenHead = true;
        const head = await admittingDurable.workflowQueue.get({ sessionId: "sess_1", queueId: a.queueId });
        if (head !== undefined) {
          await admittingDurable.workflowQueue.update({ ...head, status: "completed" });
        }
      }
      return realAcquire(input);
    };
    const admitting = createWorkflowScheduler({
      durable: admittingDurable,
      maxConcurrentWorkflowRuns: 1,
      maxQueuedWorkflowRuns: 10,
    });

    await admitting.reserve(reserveInput(sessionDataDir, {
      callIdentity: "turn_1/model_step_1/tool_3",
      input: { candidateId: "C3" },
      inputHash: "sha256:input-3",
    }));

    await expect(admittingDurable.workflowQueue.get({ sessionId: "sess_1", queueId: b.queueId })).resolves.toMatchObject({
      status: "admitted",
    });
  });

  it("admits an admittable queued record even when an earlier snapshot record was admitted concurrently", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "lh-workflow-scheduler-"));
    const sessionDataDir = await mkdtemp(join(tmpdir(), "lh-workflow-session-"));
    dirs.push(rootDir, sessionDataDir);
    const queueOnly = createSchedulerAtRoot(rootDir, {
      maxConcurrentWorkflowRuns: 0,
      maxQueuedWorkflowRuns: 10,
    });
    const a = await queueOnly.scheduler.reserve(reserveInput(sessionDataDir, {
      callIdentity: "turn_1/model_step_1/tool_1",
      inputHash: "sha256:input-1",
    }));
    const b = await queueOnly.scheduler.reserve(reserveInput(sessionDataDir, {
      callIdentity: "turn_1/model_step_1/tool_2",
      input: { candidateId: "C2" },
      inputHash: "sha256:input-2",
    }));
    expect(a.status).toBe("queued");
    expect(b.status).toBe("queued");

    const admittingDurable = createLocalHarnessDurableServices({ rootDir });
    const realListRuns = admittingDurable.workflowQueue.listRuns.bind(admittingDurable.workflowQueue);
    let queuedReadCount = 0;
    // Simulate two concurrent reserve() calls with divergent snapshots. The first
    // queued-only read is the withQueueCapacity check; the SECOND is the drain snapshot.
    // On that drain snapshot we capture it FIRST (A still queued), THEN admit A
    // out-of-band, THEN return the already-captured stale snapshot, so the loop hits
    // stale-A before reaching B.
    admittingDurable.workflowQueue.listRuns = async (input) => {
      const queuedOnly = input?.statuses?.length === 1 && input.statuses[0] === "queued";
      if (queuedOnly) {
        queuedReadCount += 1;
        if (queuedReadCount === 2) {
          const snapshot = await realListRuns(input);
          await admittingDurable.workflowQueue.acquireAdmissionSlot({
            sessionId: "sess_1",
            queueId: a.queueId,
            taskId: a.taskId,
            maxConcurrentWorkflowRuns: 2,
          });
          return snapshot;
        }
      }
      return realListRuns(input);
    };
    const admitting = createWorkflowScheduler({
      durable: admittingDurable,
      maxConcurrentWorkflowRuns: 2,
      maxQueuedWorkflowRuns: 10,
    });

    await admitting.reserve(reserveInput(sessionDataDir, {
      callIdentity: "turn_1/model_step_1/tool_3",
      input: { candidateId: "C3" },
      inputHash: "sha256:input-3",
    }));

    await expect(admittingDurable.workflowQueue.get({ sessionId: "sess_1", queueId: a.queueId })).resolves.toMatchObject({
      status: "admitted",
    });
    await expect(admittingDurable.workflowQueue.get({ sessionId: "sess_1", queueId: b.queueId })).resolves.toMatchObject({
      status: "admitted",
    });
  });

  it("uses numeric queue ids as FIFO tie-breakers when queuedAt timestamps match", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "lh-workflow-scheduler-"));
    const sessionDataDir = await mkdtemp(join(tmpdir(), "lh-workflow-session-"));
    dirs.push(rootDir, sessionDataDir);
    const fixedNow = () => new Date("2026-06-22T00:00:00.000Z");
    const queueOnly = createSchedulerAtRoot(rootDir, {
      maxConcurrentWorkflowRuns: 0,
      maxQueuedWorkflowRuns: 20,
      now: fixedNow,
    });

    const queued = [];
    for (let index = 1; index <= 10; index++) {
      queued.push(await queueOnly.scheduler.reserve(reserveInput(sessionDataDir, {
        workflowId: `candidate.review.${index}`,
        handle: `candidate_review_${index}`,
        callIdentity: `turn_1/model_step_1/tool_${index}`,
        input: { candidateId: `C${index}` },
        inputHash: `sha256:input-${index}`,
        dataDir: join(sessionDataDir, "workflows", `candidate_review_${index}`),
      })));
    }
    expect(queued.map((result) => result.queueId)).toEqual([
      "queue_1",
      "queue_2",
      "queue_3",
      "queue_4",
      "queue_5",
      "queue_6",
      "queue_7",
      "queue_8",
      "queue_9",
      "queue_10",
    ]);
    expect(queued.every((result) => result.status === "queued")).toBe(true);

    const admitting = createSchedulerAtRoot(rootDir, {
      maxConcurrentWorkflowRuns: 2,
      maxQueuedWorkflowRuns: 20,
      now: fixedNow,
    });
    const newest = await admitting.scheduler.reserve(reserveInput(sessionDataDir, {
      workflowId: "candidate.review.11",
      handle: "candidate_review_11",
      callIdentity: "turn_1/model_step_1/tool_11",
      input: { candidateId: "C11" },
      inputHash: "sha256:input-11",
      dataDir: join(sessionDataDir, "workflows", "candidate_review_11"),
    }));
    const records = await admitting.durable.workflowQueue.listRuns({ sessionId: "sess_1" });
    const statusesByQueueId = new Map(records.map((record) => [record.queueId, record.status]));

    expect(newest).toMatchObject({ queueId: "queue_11", status: "queued" });
    expect(statusesByQueueId.get("queue_1")).toBe("admitted");
    expect(statusesByQueueId.get("queue_2")).toBe("admitted");
    expect(statusesByQueueId.get("queue_10")).toBe("queued");
    expect(statusesByQueueId.get("queue_11")).toBe("queued");
  });
});

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
