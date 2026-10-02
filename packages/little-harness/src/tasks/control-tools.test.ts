import { expect, it } from "vitest";
import { createLocalHarnessDurableServices } from "../local-host/durable-services.js";
import { withTempDir } from "../test/temp.js";
import { createTaskControlTools } from "./control-tools.js";
import { createInMemoryTaskLedger, createTaskReservationCoordinator } from "./ledger.js";
import type { HarnessResultStore } from "./ledger.js";
import { createDeadlineSweeper } from "../execution/deadline-sweeper.js";

function resultStoreWith(records: Record<string, { record: unknown; value: unknown }>): HarnessResultStore {
  return {
    allocate: async () => {
      throw new Error("allocate should not be called by task control tests.");
    },
    commit: async () => {
      throw new Error("commit should not be called by task control tests.");
    },
    getRecord: async (input: { sessionId: string; resultId: string }) => records[`${input.sessionId}:${input.resultId}`]?.record,
    get: async (input: { sessionId: string; resultId: string }) => records[`${input.sessionId}:${input.resultId}`],
    getByIdempotencyKey: async () => {
      throw new Error("getByIdempotencyKey should not be called by task control tests.");
    },
  } as never;
}

it("assigns incremental task ids", async () => {
  const ledger = createInMemoryTaskLedger();
  const first = await ledger.reserveTask({ sessionId: "sess_1", kind: "workflow", purpose: "first" });
  const second = await ledger.reserveTask({ sessionId: "sess_1", kind: "workflow", purpose: "second" });

  expect(first.taskId).toBe("task_1");
  expect(second.taskId).toBe("task_2");
});

it("scopes incremental task ids and call identity bindings by session", async () => {
  const ledger = createInMemoryTaskLedger();
  const first = await ledger.reserveTask({ sessionId: "sess_1", kind: "workflow", callIdentity: "call_1" });
  const second = await ledger.reserveTask({ sessionId: "sess_2", kind: "workflow", callIdentity: "call_1" });

  expect(first.taskId).toBe("task_1");
  expect(second.taskId).toBe("task_1");
  await expect(ledger.taskIdForCallIdentity({ sessionId: "sess_1", callIdentity: "call_1" })).resolves.toBe("task_1");
  await expect(ledger.taskIdForCallIdentity({ sessionId: "sess_2", callIdentity: "call_1" })).resolves.toBe("task_1");
  await expect(ledger.listTasks({ sessionId: "sess_1" })).resolves.toEqual([
    expect.objectContaining({ sessionId: "sess_1" }),
  ]);
});

it("task control tools inspect only the configured session", async () => {
  const ledger = createInMemoryTaskLedger();
  await ledger.reserveTask({ sessionId: "sess_1", kind: "workflow", purpose: "current session" });
  await ledger.reserveTask({ sessionId: "sess_2", kind: "workflow", purpose: "wrong session" });
  const tools = createTaskControlTools({ sessionId: "sess_1", ledger });

  await expect(tools.get_task!.execute?.({ taskId: "task_1" }, {} as never)).resolves.toMatchObject({
    taskId: "task_1",
    purpose: "current session",
  });
  await expect(tools.list_tasks!.execute?.({}, {} as never)).resolves.toMatchObject({
    tasks: [expect.objectContaining({ purpose: "current session" })],
  });
});

it("stores workflow task metadata needed by async launchers", async () => {
  const ledger = createInMemoryTaskLedger();
  const task = await ledger.reserveTask({
    sessionId: "sess_1",
    kind: "workflow",
    purpose: "review",
    workflowId: "candidate.review",
    workflowHandle: "candidate_review",
    reservedRunId: "run_abc",
    queueId: "queue_1",
    callIdentity: "turn_1/tool_1",
  });

  expect(task).toMatchObject({
    taskId: "task_1",
    sessionId: "sess_1",
    workflowId: "candidate.review",
    workflowHandle: "candidate_review",
    reservedRunId: "run_abc",
    queueId: "queue_1",
    callIdentity: "turn_1/tool_1",
  });
});

it("pre-reserves concurrent launch intents in deterministic order", async () => {
  const ledger = createInMemoryTaskLedger();
  const coordinator = createTaskReservationCoordinator({ ledger });
  const secondCompletesFirst = coordinator.reserveLaunchIntent({
    sessionId: "sess_1",
    reservationScopeId: "turn_1/model_step_1",
    reservationOrder: 1,
    scopeSize: 2,
    task: { kind: "tool", purpose: "second", callIdentity: "call_2" },
  });
  const firstCompletesSecond = coordinator.reserveLaunchIntent({
    sessionId: "sess_1",
    reservationScopeId: "turn_1/model_step_1",
    reservationOrder: 0,
    scopeSize: 2,
    task: { kind: "tool", purpose: "first", callIdentity: "call_1" },
  });

  await expect(firstCompletesSecond).resolves.toMatchObject({ taskId: "task_1", purpose: "first" });
  await expect(secondCompletesFirst).resolves.toMatchObject({ taskId: "task_2", purpose: "second" });
});

it("atomically binds call identity during task reservation", async () => {
  const ledger = createInMemoryTaskLedger();
  const task = await ledger.reserveTask({
    sessionId: "sess_1",
    kind: "tool",
    purpose: "score",
    callIdentity: "call_identity_1",
  });

  await expect(ledger.taskIdForCallIdentity({ sessionId: "sess_1", callIdentity: "call_identity_1" })).resolves.toBe(
    task.taskId,
  );
  const replay = await ledger.reserveTask({
    sessionId: "sess_1",
    kind: "tool",
    purpose: "score replay",
    callIdentity: "call_identity_1",
  });
  expect(replay.taskId).toBe(task.taskId);
  await expect(ledger.highWaterMark("sess_1")).resolves.toBe(1);
});

it("await_tasks parks when predicate is not satisfied", async () => {
  const ledger = createInMemoryTaskLedger();
  const task = await ledger.reserveTask({ sessionId: "sess_1", kind: "workflow", purpose: "background review" });
  const tools = createTaskControlTools({ sessionId: "sess_1", ledger });

  const result = await tools.await_tasks!.execute?.(
    { taskIds: [task.taskId], mode: "all" },
    {
      toolCallId: "tool_1",
      context: { modelStepId: "step_1", sequenceIndex: 0, modelStepToolCallCount: 1 },
    } as never,
  );

  expect(result).toMatchObject({ status: "parked" });
});

it("await_tasks stores a durable continuation with a real continuation id", async () => {
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

    const result = await tools.await_tasks!.execute?.(
      { taskIds: [task.taskId], mode: "all" },
      {
        toolCallId: "tool_await",
        context: { modelStepId: "step_1", sequenceIndex: 0, modelStepToolCallCount: 1 },
      } as never,
    );
    const continuationId = (result as { continuationId?: string }).continuationId;
    const record = continuationId === undefined
      ? undefined
      : await durable.continuations.get(continuationId);

    expect(result).toMatchObject({
      status: "parked",
      continuationId: expect.stringMatching(/^cont_[0-9a-v]+$/u),
      pending: { taskIds: [task.taskId], mode: "all" },
    });
    expect(record).toMatchObject({
      continuationId,
      sessionId: "sess_1",
      originTurnId: "turn_1",
      parkedToolCallIds: ["tool_await"],
      waits: [
        expect.objectContaining({
          parkedToolCallId: "tool_await",
          predicate: { kind: "tasks", taskIds: [task.taskId], mode: "all" },
          state: "open",
        }),
      ],
    });
  });
});

it("await_tasks replay does not overwrite a progressed continuation", async () => {
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
    const executionOptions = {
      toolCallId: "tool_await",
      context: { modelStepId: "step_1", sequenceIndex: 0, modelStepToolCallCount: 1 },
    } as never;
    const first = await tools.await_tasks!.execute?.(
      { taskIds: [task.taskId], mode: "all", maxWaitMs: 1 },
      executionOptions,
    ) as { continuationId: string };
    await createDeadlineSweeper({
      durable,
      now: () => new Date("2999-01-01T00:00:00.000Z"),
    }).tick();

    await tools.await_tasks!.execute?.(
      { taskIds: [task.taskId], mode: "all", maxWaitMs: 1 },
      executionOptions,
    );

    await expect(durable.continuations.get(first.continuationId)).resolves.toMatchObject({
      state: "resume_enqueued",
      waits: [expect.objectContaining({ state: "timed_out" })],
    });
  });
});

it("await_tasks immediately resumes when the task completes during continuation persistence", async () => {
  await withTempDir(async (dir) => {
    const durable = createLocalHarnessDurableServices({ rootDir: dir });
    const task = await durable.tasks.reserveTask({
      sessionId: "sess_1",
      kind: "workflow",
      purpose: "background review",
    });
    const continuations = {
      ...durable.continuations,
      async putIfAbsent(record: Parameters<typeof durable.continuations.putIfAbsent>[0]) {
        const result = await durable.continuations.putIfAbsent(record);
        await durable.tasks.updateTaskTerminal({
          sessionId: "sess_1",
          taskId: task.taskId,
          status: "completed",
          terminalResultId: "result_1",
          updatedAt: "2026-06-22T00:00:01.000Z",
        });
        return result;
      },
    };
    const tools = createTaskControlTools({
      sessionId: "sess_1",
      originTurnId: "turn_1",
      ledger: durable.tasks,
      continuations,
      resumeQueue: durable.resumeQueue,
    });

    const parked = await tools.await_tasks!.execute?.(
      { taskIds: [task.taskId], mode: "all" },
      {
        toolCallId: "tool_await",
        context: { modelStepId: "step_1", sequenceIndex: 0, modelStepToolCallCount: 1 },
      } as never,
    ) as { continuationId: string };
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

it("set_task_wakeup persists an armed wakeup and returns without parking the turn", async () => {
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

    const result = await tools.set_task_wakeup!.execute?.(
      { taskIds: [task.taskId], mode: "all", maxWaitMs: 1000, note: "review completion" },
      {} as never,
    );
    const wakeups = await durable.wakeups.listOpen("sess_1");

    expect(result).toMatchObject({
      status: "armed",
      wakeupId: expect.stringMatching(/^wakeup_[0-9a-v]+$/u),
      pending: { taskIds: [task.taskId], mode: "all" },
    });
    expect(wakeups).toHaveLength(1);
    expect(wakeups[0]).toMatchObject({
      sessionId: "sess_1",
      originTurnId: "turn_1",
      predicate: { kind: "tasks", taskIds: [task.taskId], mode: "all", maxWaitMs: 1000 },
      status: "armed",
      message: "review completion",
    });
  });
});

it("set_task_wakeup is available in the durable model-facing safe tool set", async () => {
  await withTempDir(async (dir) => {
    const durable = createLocalHarnessDurableServices({ rootDir: dir });
    const tools = createTaskControlTools({
      sessionId: "sess_1",
      originTurnId: "turn_1",
      ledger: durable.tasks,
      wakeups: durable.wakeups,
      modelFacingSafeOnly: true,
    });

    expect(tools.set_task_wakeup).toBeDefined();
    expect(tools.cancel_task).toBeUndefined();
  });
});

it("get_task exposes compact terminal diagnostics for failed tasks", async () => {
  const ledger = createInMemoryTaskLedger();
  const task = await ledger.reserveTask({ sessionId: "sess_1", kind: "workflow", purpose: "background review" });
  await ledger.updateTaskTerminal({
    sessionId: "sess_1",
    taskId: task.taskId,
    status: "failed",
    terminalCauseCode: "workflow_failed",
    terminalMessage: "Review failed",
    terminalDiagnostic: {
      message: "Review failed",
      stack: "large stack should not leak",
      nested: { reason: "bad input" },
    },
  });
  const tools = createTaskControlTools({ sessionId: "sess_1", ledger });

  await expect(tools.get_task!.execute?.({ taskId: task.taskId }, {} as never)).resolves.toMatchObject({
    status: "failed",
    terminalCauseCode: "workflow_failed",
    terminalMessage: "Review failed",
    terminalDiagnostic: { message: "Review failed", nested: "[object]" },
  });
});

it("task_result exposes terminal diagnostics for failed tasks", async () => {
  const ledger = createInMemoryTaskLedger();
  const task = await ledger.reserveTask({ sessionId: "sess_1", kind: "workflow", purpose: "background review" });
  await ledger.updateTaskTerminal({
    sessionId: "sess_1",
    taskId: task.taskId,
    status: "failed",
    terminalCauseCode: "workflow_failed",
    terminalMessage: "Review failed",
    terminalDiagnostic: { detail: "bad input" },
  });
  const tools = createTaskControlTools({ sessionId: "sess_1", ledger });

  await expect(tools.task_result!.execute?.({ taskId: task.taskId }, {} as never)).resolves.toMatchObject({
    status: "failed",
    terminalCauseCode: "workflow_failed",
    terminalMessage: "Review failed",
    terminalDiagnostic: { detail: "bad input" },
  });
});

it("task_result returns full output when include:[\"output\"] requested", async () => {
  const ledger = createInMemoryTaskLedger();
  const task = await ledger.reserveTask({ sessionId: "sess_1", kind: "tool", purpose: "score" });
  const storedValue = { score: 42, rationale: "x".repeat(2048) };
  await ledger.updateTaskTerminal({
    sessionId: "sess_1",
    taskId: task.taskId,
    status: "completed",
    terminalResultId: "result_1",
    outputSummary: "score: 42",
  });
  const results = resultStoreWith({
    "sess_1:result_1": { record: { resultId: "result_1", sessionId: "sess_1" }, value: storedValue },
  });
  const tools = createTaskControlTools({ sessionId: "sess_1", ledger, results });

  await expect(
    tools.task_result!.execute?.({ taskId: task.taskId, include: ["output"] }, {} as never),
  ).resolves.toMatchObject({ output: storedValue });

  // Compact by default: no include => no full output.
  await expect(
    tools.task_result!.execute?.({ taskId: task.taskId }, {} as never),
  ).resolves.not.toHaveProperty("output");
});

it("get_task and list_tasks do not leak internal scheduling fields to the model", async () => {
  const ledger = createInMemoryTaskLedger();
  await ledger.reserveTask({
    sessionId: "sess_1",
    kind: "workflow",
    purpose: "review",
    workflowId: "candidate.review",
    workflowHandle: "candidate_review",
    reservedRunId: "run_abc",
    queueId: "queue_1",
    callIdentity: "turn_1/tool_1",
  });
  const tools = createTaskControlTools({ sessionId: "sess_1", ledger });

  const got = await tools.get_task!.execute?.({ taskId: "task_1" }, {} as never);
  expect(got).not.toHaveProperty("callIdentity");
  expect(got).not.toHaveProperty("queueId");
  expect(got).not.toHaveProperty("sessionId");
  expect(got).toHaveProperty("runId", "run_abc");

  const listed = await tools.list_tasks!.execute?.({}, {} as never) as { tasks: Record<string, unknown>[] };
  expect(listed.tasks[0]).not.toHaveProperty("callIdentity");
  expect(listed.tasks[0]).not.toHaveProperty("queueId");
  expect(listed.tasks[0]).not.toHaveProperty("sessionId");
});

it("cancel_task is idempotent and returns cancelled terminal diagnostics", async () => {
  const ledger = createInMemoryTaskLedger();
  const task = await ledger.reserveTask({ sessionId: "sess_1", kind: "workflow", purpose: "background review" });
  const tools = createTaskControlTools({ sessionId: "sess_1", ledger });

  await expect(tools.cancel_task!.execute?.({ taskId: task.taskId }, {} as never)).resolves.toMatchObject({
    status: "cancelled",
    terminalCauseCode: "cancelled",
    terminalMessage: "Task task_1 cancelled.",
    terminalDiagnostic: { cancelled: true, taskId: "task_1" },
  });
  await expect(tools.cancel_task!.execute?.({ taskId: task.taskId }, {} as never)).resolves.toMatchObject({
    status: "cancelled",
    terminalCauseCode: "cancelled",
  });
});

it("cancel_task closes an armed wakeup that references only the cancelled task", async () => {
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

    const wakeup = await durable.wakeups.get(armed.wakeupId);
    expect(wakeup?.status).toBe("closed");
    await expect(durable.wakeups.listOpen("sess_1")).resolves.toEqual([]);
  });
});

it("cancel_task closes a mode:all wakeup when one referenced task is cancelled", async () => {
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

    await tools.cancel_task!.execute?.({ taskId: toCancel.taskId }, {} as never);

    const wakeup = await durable.wakeups.get(armed.wakeupId);
    expect(wakeup?.status).toBe("closed");
    await expect(durable.wakeups.listOpen("sess_1")).resolves.toEqual([]);
  });
});

it("cancel_task leaves all-mode wakeups armed when the selected task was already completed", async () => {
  await withTempDir(async (dir) => {
    const durable = createLocalHarnessDurableServices({ rootDir: dir });
    const completed = await durable.tasks.reserveTask({
      sessionId: "sess_1",
      kind: "workflow",
      purpose: "already completed",
    });
    const running = await durable.tasks.reserveTask({
      sessionId: "sess_1",
      kind: "workflow",
      purpose: "still running",
    });
    await durable.tasks.updateTaskTerminal({
      sessionId: "sess_1",
      taskId: completed.taskId,
      status: "completed",
      terminalResultId: "result_completed",
      updatedAt: "2026-06-22T00:00:01.000Z",
    });
    const tools = createTaskControlTools({
      sessionId: "sess_1",
      originTurnId: "turn_1",
      ledger: durable.tasks,
      wakeups: durable.wakeups,
    });
    const armed = await tools.set_task_wakeup!.execute?.(
      { taskIds: [completed.taskId, running.taskId], mode: "all" },
      {} as never,
    ) as { wakeupId: string };

    await tools.cancel_task!.execute?.({ taskId: completed.taskId }, {} as never);

    const wakeup = await durable.wakeups.get(armed.wakeupId);
    expect(wakeup?.status).toBe("armed");

    await durable.tasks.updateTaskTerminal({
      sessionId: "sess_1",
      taskId: running.taskId,
      status: "completed",
      terminalResultId: "result_running",
      updatedAt: "2026-06-22T00:00:02.000Z",
    });
    await createDeadlineSweeper({
      durable,
      now: () => new Date("2026-06-22T00:00:03.000Z"),
    }).tick();

    await expect(durable.wakeups.get(armed.wakeupId)).resolves.toMatchObject({
      status: "resume_enqueued",
      firedReason: "predicate_satisfied",
    });
  });
});

it("cancel_task drives an open await_tasks continuation to a cancelled child outcome", async () => {
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
      wakeups: durable.wakeups,
    });
    const parked = await tools.await_tasks!.execute?.(
      { taskIds: [task.taskId], mode: "all" },
      {
        toolCallId: "tool_await",
        context: { modelStepId: "step_1", sequenceIndex: 0 },
      } as never,
    ) as { continuationId: string };

    await tools.cancel_task!.execute?.({ taskId: task.taskId }, {} as never);

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

it("cancel_task after an await_tasks deadline does not resume the wait as cancelled", async () => {
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
      wakeups: durable.wakeups,
    });
    const parked = await tools.await_tasks!.execute?.(
      { taskIds: [task.taskId], mode: "all", maxWaitMs: 1 },
      {
        toolCallId: "tool_await",
        context: { modelStepId: "step_1", sequenceIndex: 0 },
      } as never,
    ) as { continuationId: string };

    await new Promise((resolve) => setTimeout(resolve, 5));
    await tools.cancel_task!.execute?.({ taskId: task.taskId }, {} as never);

    await createDeadlineSweeper({
      durable,
      now: () => new Date("2999-01-01T00:00:00.000Z"),
    }).tick();

    const continuation = await durable.continuations.get(parked.continuationId);
    const resumes = await durable.resumeQueue.listOpen("sess_1");

    expect(continuation).toMatchObject({
      state: "resume_enqueued",
      waits: [expect.objectContaining({ state: "timed_out" })],
    });
    expect(resumes).toHaveLength(1);
    expect(resumes[0]).toMatchObject({
      continuationId: parked.continuationId,
      reason: "timeout",
    });
  });
});

it("cancel_task drives a multi-member mode:all await_tasks to cancelled even with a running sibling", async () => {
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
      continuations: durable.continuations,
      resumeQueue: durable.resumeQueue,
      wakeups: durable.wakeups,
    });
    const parked = await tools.await_tasks!.execute?.(
      { taskIds: [toCancel.taskId, running.taskId], mode: "all" },
      {
        toolCallId: "tool_await",
        context: { modelStepId: "step_1", sequenceIndex: 0 },
      } as never,
    ) as { continuationId: string };

    // The sibling `running` is still pending; the old mode:"all" all-terminal precheck would
    // refuse to record the cancelled outcome and the parent would hang. It must resume now.
    await tools.cancel_task!.execute?.({ taskId: toCancel.taskId }, {} as never);

    const continuation = await durable.continuations.get(parked.continuationId);
    const resumes = await durable.resumeQueue.listOpen("sess_1");

    expect(continuation).toMatchObject({
      state: "resume_enqueued",
      waits: [expect.objectContaining({ state: "cancelled" })],
    });
    expect(resumes).toHaveLength(1);
  });
});
