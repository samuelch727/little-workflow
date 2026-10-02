import { expect, it } from "vitest";
import { createLocalHarnessDurableServices } from "../local-host/durable-services.js";
import { withTempDir } from "../test/temp.js";
import { createTaskControlTools } from "../tasks/control-tools.js";
import { createDeadlineSweeper } from "./deadline-sweeper.js";

it("times out expired continuation waits and enqueues one resume", async () => {
  await withTempDir(async (dir) => {
    const durable = createLocalHarnessDurableServices({ rootDir: dir });
    const task = await durable.tasks.reserveTask({
      sessionId: "sess_1",
      kind: "workflow",
      purpose: "background review",
    });
    const tools = createTaskControlTools({
      sessionId: "sess_1",
      originTurnId: "turn_1",
      ledger: durable.tasks,
      continuations: durable.continuations,
      resumeQueue: durable.resumeQueue,
    });
    const parked = await tools.await_tasks!.execute?.(
      { taskIds: [task.taskId], mode: "all", maxWaitMs: 1 },
      {
        toolCallId: "tool_await",
        context: { modelStepId: "step_1", sequenceIndex: 0 },
      } as never,
    ) as { continuationId: string };
    const sweeper = createDeadlineSweeper({
      durable,
      now: () => new Date("2999-01-01T00:00:00.000Z"),
    });

    const result = await sweeper.tick();
    const continuation = await durable.continuations.get(parked.continuationId);
    const resumes = await durable.resumeQueue.listOpen("sess_1");

    expect(result.timedOutContinuationWaits).toBe(1);
    expect(continuation).toMatchObject({
      state: "resume_enqueued",
      waits: [expect.objectContaining({ state: "timed_out" })],
    });
    expect(resumes).toHaveLength(1);
    expect(resumes[0]).toMatchObject({
      continuationId: parked.continuationId,
      reason: "timeout",
      terminalResultIds: [],
    });
  });
});

it("times out an await_tasks wait when its task completes after the deadline", async () => {
  await withTempDir(async (dir) => {
    const durable = createLocalHarnessDurableServices({ rootDir: dir });
    const task = await durable.tasks.reserveTask({
      sessionId: "sess_1",
      kind: "workflow",
      purpose: "background review",
    });
    const tools = createTaskControlTools({
      sessionId: "sess_1",
      originTurnId: "turn_1",
      ledger: durable.tasks,
      continuations: durable.continuations,
      resumeQueue: durable.resumeQueue,
    });
    const parked = await tools.await_tasks!.execute?.(
      { taskIds: [task.taskId], mode: "all", maxWaitMs: 1 },
      {
        toolCallId: "tool_await",
        context: { modelStepId: "step_1", sequenceIndex: 0 },
      } as never,
    ) as { continuationId: string };
    await durable.tasks.updateTaskTerminal({
      sessionId: "sess_1",
      taskId: task.taskId,
      status: "completed",
      terminalResultId: "result_late",
      updatedAt: "2999-01-01T00:00:00.000Z",
    });
    const sweeper = createDeadlineSweeper({
      durable,
      now: () => new Date("2999-01-01T00:00:01.000Z"),
    });

    const result = await sweeper.tick();
    const continuation = await durable.continuations.get(parked.continuationId);
    const resumes = await durable.resumeQueue.listOpen("sess_1");

    expect(result.readyWakeups).toBe(0);
    expect(result.timedOutContinuationWaits).toBe(1);
    expect(continuation).toMatchObject({
      state: "resume_enqueued",
      waits: [expect.objectContaining({ state: "timed_out", terminalResultIds: [] })],
    });
    expect(resumes).toHaveLength(1);
    expect(resumes[0]).toMatchObject({
      continuationId: parked.continuationId,
      reason: "timeout",
      terminalResultIds: [],
    });
  });
});

it("times out a partially-satisfied mode:all continuation wait (one member terminal, sibling still running)", async () => {
  await withTempDir(async (dir) => {
    const durable = createLocalHarnessDurableServices({ rootDir: dir });
    const a = await durable.tasks.reserveTask({ sessionId: "sess_1", kind: "workflow", purpose: "completes" });
    const b = await durable.tasks.reserveTask({ sessionId: "sess_1", kind: "workflow", purpose: "never terminalizes" });
    const tools = createTaskControlTools({
      sessionId: "sess_1",
      originTurnId: "turn_1",
      ledger: durable.tasks,
      continuations: durable.continuations,
      resumeQueue: durable.resumeQueue,
    });
    const parked = await tools.await_tasks!.execute?.(
      { taskIds: [a.taskId, b.taskId], mode: "all", maxWaitMs: 1 },
      {
        toolCallId: "tool_await",
        context: { modelStepId: "step_1", sequenceIndex: 0 },
      } as never,
    ) as { continuationId: string };
    // Only A terminalizes; B stays pending. A partially-satisfied mode:"all" wait must STILL time
    // out at maxWaitMs — the old code returned true from drivePredicateSatisfiedWait after marking
    // A, skipping the timeout branch and stranding the parent forever.
    await durable.tasks.updateTaskTerminal({
      sessionId: "sess_1",
      taskId: a.taskId,
      status: "completed",
      terminalResultId: "result_a",
    });
    const sweeper = createDeadlineSweeper({
      durable,
      now: () => new Date("2999-01-01T00:00:00.000Z"),
    });

    const result = await sweeper.tick();
    const continuation = await durable.continuations.get(parked.continuationId);
    const resumes = await durable.resumeQueue.listOpen("sess_1");

    expect(result.timedOutContinuationWaits).toBe(1);
    expect(continuation).toMatchObject({
      state: "resume_enqueued",
      waits: [expect.objectContaining({ state: "timed_out" })],
    });
    expect(resumes).toHaveLength(1);
    expect(resumes[0]).toMatchObject({ continuationId: parked.continuationId, reason: "timeout" });
  });
});

it("marks armed wakeups ready when their task predicate is satisfied", async () => {
  await withTempDir(async (dir) => {
    const durable = createLocalHarnessDurableServices({ rootDir: dir });
    const task = await durable.tasks.reserveTask({
      sessionId: "sess_1",
      kind: "workflow",
      purpose: "background review",
    });
    const tools = createTaskControlTools({
      sessionId: "sess_1",
      originTurnId: "turn_1",
      ledger: durable.tasks,
      wakeups: durable.wakeups,
    });
    const armed = await tools.set_task_wakeup!.execute?.(
      { taskIds: [task.taskId], mode: "all" },
      {} as never,
    ) as { wakeupId: string };
    await durable.tasks.updateTaskTerminal({
      sessionId: "sess_1",
      taskId: task.taskId,
      status: "completed",
      terminalResultId: "result_1",
      updatedAt: "2026-06-22T00:00:01.000Z",
    });
    const sweeper = createDeadlineSweeper({
      durable,
      now: () => new Date("2026-06-22T00:00:02.000Z"),
    });

    const result = await sweeper.tick();
    const wakeup = await durable.wakeups.get(armed.wakeupId);

    expect(result.readyWakeups).toBe(1);
    expect(wakeup).toMatchObject({
      status: "resume_enqueued",
      firedReason: "predicate_satisfied",
      firedAt: "2026-06-22T00:00:02.000Z",
      resumeQueueId: expect.stringMatching(/^wakeup_resume_[0-9a-v]+$/u),
    });
  });
});

it("marks expired armed wakeups timed out", async () => {
  await withTempDir(async (dir) => {
    const durable = createLocalHarnessDurableServices({ rootDir: dir });
    const task = await durable.tasks.reserveTask({
      sessionId: "sess_1",
      kind: "workflow",
      purpose: "background review",
    });
    const tools = createTaskControlTools({
      sessionId: "sess_1",
      originTurnId: "turn_1",
      ledger: durable.tasks,
      wakeups: durable.wakeups,
    });
    const armed = await tools.set_task_wakeup!.execute?.(
      { taskIds: [task.taskId], mode: "all", maxWaitMs: 1 },
      {} as never,
    ) as { wakeupId: string };
    const sweeper = createDeadlineSweeper({
      durable,
      now: () => new Date("2999-01-01T00:00:00.000Z"),
    });

    const result = await sweeper.tick();
    const wakeup = await durable.wakeups.get(armed.wakeupId);

    expect(result.timedOutWakeups).toBe(1);
    expect(wakeup).toMatchObject({
      status: "timed_out",
      firedReason: "timeout",
      firedAt: "2999-01-01T00:00:00.000Z",
    });
    await expect(durable.wakeups.listOpen("sess_1")).resolves.toEqual([
      expect.objectContaining({
        wakeupId: armed.wakeupId,
        status: "timed_out",
        firedReason: "timeout",
      }),
    ]);
  });
});

it("times out a wakeup when matching tasks complete after the deadline", async () => {
  await withTempDir(async (dir) => {
    const durable = createLocalHarnessDurableServices({ rootDir: dir });
    const task = await durable.tasks.reserveTask({
      sessionId: "sess_1",
      kind: "workflow",
      purpose: "background review",
    });
    const tools = createTaskControlTools({
      sessionId: "sess_1",
      originTurnId: "turn_1",
      ledger: durable.tasks,
      wakeups: durable.wakeups,
    });
    const armed = await tools.set_task_wakeup!.execute?.(
      { taskIds: [task.taskId], mode: "all", wakeupAt: "2026-06-22T00:00:01.000Z" },
      {} as never,
    ) as { wakeupId: string };
    await durable.tasks.updateTaskTerminal({
      sessionId: "sess_1",
      taskId: task.taskId,
      status: "completed",
      terminalResultId: "result_1",
      updatedAt: "2026-06-22T00:00:02.000Z",
    });
    const sweeper = createDeadlineSweeper({
      durable,
      now: () => new Date("2026-06-22T00:00:03.000Z"),
    });

    const result = await sweeper.tick();
    const wakeup = await durable.wakeups.get(armed.wakeupId);

    expect(result.readyWakeups).toBe(0);
    expect(result.timedOutWakeups).toBe(1);
    expect(wakeup).toMatchObject({
      status: "timed_out",
      firedReason: "timeout",
      firedAt: "2026-06-22T00:00:03.000Z",
    });
  });
});

it("resumes a parked await_tasks continuation when its task completes after park", async () => {
  await withTempDir(async (dir) => {
    const durable = createLocalHarnessDurableServices({ rootDir: dir });
    const task = await durable.tasks.reserveTask({
      sessionId: "sess_1",
      kind: "workflow",
      purpose: "background review",
    });
    const tools = createTaskControlTools({
      sessionId: "sess_1",
      originTurnId: "turn_1",
      ledger: durable.tasks,
      continuations: durable.continuations,
      resumeQueue: durable.resumeQueue,
    });
    // Park: no maxWaitMs, task still pending => parks open, no resume.
    const parked = await tools.await_tasks!.execute?.(
      { taskIds: [task.taskId], mode: "all" },
      {
        toolCallId: "tool_await",
        context: { modelStepId: "step_1", sequenceIndex: 0 },
      } as never,
    ) as { continuationId: string };

    // Task completes AFTER park returns (the normal async case).
    await durable.tasks.updateTaskTerminal({
      sessionId: "sess_1",
      taskId: task.taskId,
      status: "completed",
      terminalResultId: "result_1",
      updatedAt: "2026-06-22T00:00:01.000Z",
    });

    await createDeadlineSweeper({
      durable,
      now: () => new Date("2026-06-22T00:00:02.000Z"),
    }).tick();

    const continuation = await durable.continuations.get(parked.continuationId);
    const resumes = await durable.resumeQueue.listOpen("sess_1");

    expect(continuation).toMatchObject({
      state: "resume_enqueued",
      waits: [expect.objectContaining({ state: "terminal", terminalResultIds: ["result_1"] })],
    });
    expect(resumes).toHaveLength(1);
    expect(resumes[0]).toMatchObject({
      continuationId: parked.continuationId,
      reason: "predicate_satisfied",
      terminalResultIds: ["result_1"],
    });
  });
});

it("resumes a parked await_tasks continuation with a cancelled child outcome when its task is cancelled", async () => {
  await withTempDir(async (dir) => {
    const durable = createLocalHarnessDurableServices({ rootDir: dir });
    const task = await durable.tasks.reserveTask({
      sessionId: "sess_1",
      kind: "workflow",
      purpose: "background review",
    });
    const tools = createTaskControlTools({
      sessionId: "sess_1",
      originTurnId: "turn_1",
      ledger: durable.tasks,
      continuations: durable.continuations,
      resumeQueue: durable.resumeQueue,
    });
    const parked = await tools.await_tasks!.execute?.(
      { taskIds: [task.taskId], mode: "all" },
      {
        toolCallId: "tool_await",
        context: { modelStepId: "step_1", sequenceIndex: 0 },
      } as never,
    ) as { continuationId: string };

    await durable.tasks.cancelTask({ sessionId: "sess_1", taskId: task.taskId });

    await createDeadlineSweeper({
      durable,
      now: () => new Date("2026-06-22T00:00:02.000Z"),
    }).tick();

    const continuation = await durable.continuations.get(parked.continuationId);
    const resumes = await durable.resumeQueue.listOpen("sess_1");

    expect(continuation).toMatchObject({
      state: "resume_enqueued",
      waits: [expect.objectContaining({ state: "cancelled" })],
    });
    expect(resumes).toHaveLength(1);
    expect(resumes[0]).toMatchObject({
      continuationId: parked.continuationId,
      reason: "predicate_satisfied",
    });
  });
});

it("does not fire an armed wakeup for a cancelled task", async () => {
  await withTempDir(async (dir) => {
    const durable = createLocalHarnessDurableServices({ rootDir: dir });
    const task = await durable.tasks.reserveTask({
      sessionId: "sess_1",
      kind: "workflow",
      purpose: "background review",
    });
    const tools = createTaskControlTools({
      sessionId: "sess_1",
      originTurnId: "turn_1",
      ledger: durable.tasks,
      wakeups: durable.wakeups,
    });
    const armed = await tools.set_task_wakeup!.execute?.(
      { taskIds: [task.taskId], mode: "all" },
      {} as never,
    ) as { wakeupId: string };
    await tools.cancel_task!.execute?.({ taskId: task.taskId }, {} as never);
    const sweeper = createDeadlineSweeper({
      durable,
      now: () => new Date("2026-06-22T00:00:02.000Z"),
    });

    const result = await sweeper.tick();
    const wakeup = await durable.wakeups.get(armed.wakeupId);

    expect(result.readyWakeups).toBe(0);
    expect(wakeup?.firedReason).not.toBe("predicate_satisfied");
    expect(wakeup?.status).not.toBe("resume_enqueued");
  });
});

it("closes a mode:all wakeup when the sweeper observes a cancelled member", async () => {
  await withTempDir(async (dir) => {
    const durable = createLocalHarnessDurableServices({ rootDir: dir });
    const toCancel = await durable.tasks.reserveTask({
      sessionId: "sess_1",
      kind: "workflow",
      purpose: "to cancel",
    });
    const running = await durable.tasks.reserveTask({
      sessionId: "sess_1",
      kind: "workflow",
      purpose: "still running",
    });
    const tools = createTaskControlTools({
      sessionId: "sess_1",
      originTurnId: "turn_1",
      ledger: durable.tasks,
      wakeups: durable.wakeups,
    });
    const armed = await tools.set_task_wakeup!.execute?.(
      { taskIds: [toCancel.taskId, running.taskId], mode: "all" },
      {} as never,
    ) as { wakeupId: string };
    await durable.tasks.cancelTask({ sessionId: "sess_1", taskId: toCancel.taskId });

    const result = await createDeadlineSweeper({
      durable,
      now: () => new Date("2026-06-22T00:00:02.000Z"),
    }).tick();
    const wakeup = await durable.wakeups.get(armed.wakeupId);

    expect(result.readyWakeups).toBe(0);
    expect(result.timedOutWakeups).toBe(0);
    expect(wakeup).toMatchObject({
      status: "closed",
      firedAt: "2026-06-22T00:00:02.000Z",
    });
  });
});
