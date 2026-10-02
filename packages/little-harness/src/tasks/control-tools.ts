import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { createContinuationId, createParkedToolResult } from "../execution/park-resume.js";
import { stableHash } from "../utils/canonical-hash.js";
import type {
  HarnessContinuationLedger,
  HarnessContinuationRecord,
  HarnessResultStore,
  HarnessResumeQueue,
  HarnessTaskLedger,
  HarnessWakeupLedger,
  HarnessWakeupRecord,
} from "./ledger.js";
import type { AwaitTaskPredicate, HarnessTaskId, HarnessTaskRecord, HarnessTaskStatus } from "./types.js";

const taskIdSchema = z.string()
  .regex(/^task_\d+$/u, "Expected a task_N id.") as unknown as z.ZodType<HarnessTaskId>;

const awaitModeSchema = z.enum(["all", "any"]);

export function createTaskControlTools(config: {
  readonly sessionId: string;
  readonly originTurnId?: string;
  readonly ledger: HarnessTaskLedger;
  readonly continuations?: HarnessContinuationLedger;
  readonly resumeQueue?: HarnessResumeQueue;
  readonly wakeups?: HarnessWakeupLedger;
  readonly results?: HarnessResultStore;
  readonly modelFacingSafeOnly?: boolean;
}): ToolSet {
  const { sessionId, ledger } = config;
  const results = config.results;
  const wakeups = config.wakeups;
  const originTurnId = config.originTurnId;
  const tools: ToolSet = {
    list_tasks: tool({
      description: "List background harness tasks for the current session.",
      inputSchema: z.object({}),
      execute: async () => {
        const tasks = await ledger.listTasks({ sessionId });
        return { tasks: tasks.map(presentTask) };
      },
    }),
    get_task: tool({
      description: "Inspect one background harness task in the current session.",
      inputSchema: z.object({ taskId: taskIdSchema }),
      execute: async ({ taskId }) => {
        return presentTask(await requireTask(ledger, sessionId, taskId));
      },
    }),
    task_result: tool({
      description:
        "Read the terminal result for one background harness task in the current session. "
        + "Pass include:[\"output\"] to read back the full stored output (compact summary by default).",
      inputSchema: z.object({
        taskId: taskIdSchema,
        include: z.array(z.enum(["output"])).optional(),
      }),
      execute: async ({ taskId, include }) => {
        const task = await requireTask(ledger, sessionId, taskId);
        if (!isTerminal(task.status)) {
          return { status: "pending", taskId: task.taskId };
        }
        const presented = presentTask(task);
        if (include?.includes("output") === true && results !== undefined && task.terminalResultId !== undefined) {
          const stored = await results.get({ sessionId, resultId: task.terminalResultId });
          if (stored !== undefined) {
            return { ...presented, output: stored.value };
          }
        }
        return presented;
      },
    }),
    await_tasks: tool({
      description: "Wait until selected background harness tasks satisfy a terminal predicate.",
      inputSchema: z.object({
        taskIds: z.array(taskIdSchema).min(1),
        mode: awaitModeSchema,
        maxWaitMs: z.number().int().nonnegative().optional(),
      }),
      execute: async (input, executionOptions) => {
        return awaitTaskPredicate(ledger, sessionId, normalizePredicate(input), {
          executionOptions,
          ...(config.originTurnId === undefined ? {} : { originTurnId: config.originTurnId }),
          ...(config.continuations === undefined ? {} : { continuations: config.continuations }),
          ...(config.resumeQueue === undefined ? {} : { resumeQueue: config.resumeQueue }),
        });
      },
    }),
  };
  const wakeupTools = wakeups === undefined || originTurnId === undefined
    ? {}
    : {
        set_task_wakeup: tool({
          description: "Register a wakeup predicate for selected background harness tasks in the current session.",
          inputSchema: z.object({
            taskIds: z.array(taskIdSchema).min(1),
            mode: awaitModeSchema.default("all"),
            wakeupAt: z.string().optional(),
            maxWaitMs: z.number().int().nonnegative().optional(),
            note: z.string().optional(),
            message: z.string().optional(),
          }),
          execute: async (input) => {
            return setTaskWakeup({
              ledger,
              wakeups,
              sessionId,
              originTurnId,
              predicate: normalizePredicate(input),
              wakeupAt: input.wakeupAt,
              message: input.note ?? input.message,
            });
          },
        }),
      };
  const visibleTools = {
    ...tools,
    ...wakeupTools,
  };

  if (config.modelFacingSafeOnly === true) {
    return visibleTools;
  }

  return {
    ...visibleTools,
    cancel_task: tool({
      description: "Cancel one non-terminal background harness task in the current session.",
      inputSchema: z.object({ taskId: taskIdSchema }),
      execute: async ({ taskId }) => {
        const task = await ledger.cancelTask({ sessionId, taskId });
        if (task === undefined) {
          throw new Error(`Task ${taskId} was not found in this session.`);
        }
        // Cancellation suppresses autonomous wakeups for the cancelled task and
        // drives any open await_tasks continuation referencing it to a cancelled
        // child outcome (spec line 413 + continuation cancellation contract).
        if (task.status === "cancelled") {
          await suppressWakeupsForCancelledTask({
            sessionId,
            taskId,
            ...(wakeups === undefined ? {} : { wakeups }),
          });
          await driveContinuationsForCancelledTask({
            sessionId,
            taskId,
            ledger,
            ...(config.continuations === undefined ? {} : { continuations: config.continuations }),
            ...(config.resumeQueue === undefined ? {} : { resumeQueue: config.resumeQueue }),
          });
        }
        return presentTask(task);
      },
    }),
  };
}

function normalizePredicate(input: {
  readonly taskIds: readonly HarnessTaskId[];
  readonly mode: "all" | "any";
  readonly maxWaitMs?: number | undefined;
}): AwaitTaskPredicate {
  return {
    taskIds: input.taskIds,
    mode: input.mode,
    ...(input.maxWaitMs === undefined ? {} : { maxWaitMs: input.maxWaitMs }),
  };
}

async function setTaskWakeup(options: {
  readonly ledger: HarnessTaskLedger;
  readonly wakeups: HarnessWakeupLedger;
  readonly sessionId: string;
  readonly originTurnId: string;
  readonly predicate: AwaitTaskPredicate;
  readonly wakeupAt?: string | undefined;
  readonly message?: string | undefined;
}) {
  await Promise.all(options.predicate.taskIds.map((taskId) =>
    requireTask(options.ledger, options.sessionId, taskId)
  ));
  const createdAt = new Date().toISOString();
  const timeoutAt = wakeupTimeoutAt({
    createdAt,
    maxWaitMs: options.predicate.maxWaitMs,
    wakeupAt: options.wakeupAt,
  });
  const record = compactRecord({
    wakeupId: createWakeupId({
      sessionId: options.sessionId,
      originTurnId: options.originTurnId,
      predicate: options.predicate,
      wakeupAt: options.wakeupAt,
      message: options.message,
    }),
    sessionId: options.sessionId,
    originTurnId: options.originTurnId,
    predicate: compactRecord({
      kind: "tasks" as const,
      taskIds: options.predicate.taskIds,
      mode: options.predicate.mode,
      maxWaitMs: options.predicate.maxWaitMs,
    }),
    status: "armed" as const,
    message: options.message,
    createdAt,
    timeoutAt,
  }) as HarnessWakeupRecord;
  const stored = await options.wakeups.putIfAbsent(record);
  assertCompatibleWakeup(record, stored.record);

  return compactRecord({
    status: stored.record.status,
    wakeupId: stored.record.wakeupId,
    pending: {
      taskIds: stored.record.predicate.taskIds,
      mode: stored.record.predicate.mode,
    },
    firedAt: stored.record.firedAt,
    firedReason: stored.record.firedReason,
    resumeQueueId: stored.record.resumeQueueId,
  });
}

function createWakeupId(input: {
  readonly sessionId: string;
  readonly originTurnId: string;
  readonly predicate: AwaitTaskPredicate;
  readonly wakeupAt?: string | undefined;
  readonly message?: string | undefined;
}): string {
  return `wakeup_${stableHash(input, { format: "base32hex" }).slice(0, 24)}`;
}

function wakeupTimeoutAt(input: {
  readonly createdAt: string;
  readonly maxWaitMs?: number | undefined;
  readonly wakeupAt?: string | undefined;
}): string | undefined {
  if (input.wakeupAt !== undefined) {
    const wakeupAtMs = Date.parse(input.wakeupAt);
    if (!Number.isFinite(wakeupAtMs)) {
      throw new Error(`Invalid wakeupAt timestamp: ${input.wakeupAt}`);
    }
    return new Date(wakeupAtMs).toISOString();
  }
  if (input.maxWaitMs === undefined) {
    return undefined;
  }
  return new Date(Date.parse(input.createdAt) + input.maxWaitMs).toISOString();
}

async function awaitTaskPredicate(
  ledger: HarnessTaskLedger,
  sessionId: string,
  predicate: AwaitTaskPredicate,
  options: {
    readonly executionOptions?: unknown;
    readonly originTurnId?: string;
    readonly continuations?: HarnessContinuationLedger;
    readonly resumeQueue?: HarnessResumeQueue;
  } = {},
) {
  const tasks = await Promise.all(predicate.taskIds.map((taskId) => requireTask(ledger, sessionId, taskId)));
  const terminalTasks = tasks.filter((task) => isTerminal(task.status));
  const satisfied = predicate.mode === "all"
    ? terminalTasks.length === tasks.length
    : terminalTasks.length > 0;

  if (!satisfied) {
    if (options.continuations !== undefined && options.originTurnId !== undefined) {
      return parkTaskPredicate({
        sessionId,
        originTurnId: options.originTurnId,
        predicate,
        ledger,
        continuations: options.continuations,
        ...(options.resumeQueue === undefined ? {} : { resumeQueue: options.resumeQueue }),
        executionOptions: options.executionOptions,
      });
    }
    return {
      status: "parked" as const,
      pending: {
        taskIds: predicate.taskIds,
        mode: predicate.mode,
      },
    };
  }

  return {
    status: "satisfied" as const,
    tasks: terminalTasks.map(presentTask),
  };
}

async function parkTaskPredicate(options: {
  readonly sessionId: string;
  readonly originTurnId: string;
  readonly predicate: AwaitTaskPredicate;
  readonly ledger: HarnessTaskLedger;
  readonly continuations: HarnessContinuationLedger;
  readonly resumeQueue?: HarnessResumeQueue;
  readonly executionOptions?: unknown;
}) {
  const execution = parseToolExecutionOptions(options.executionOptions);
  const createdAt = new Date().toISOString();
  const continuationId = createContinuationId({
    sessionId: options.sessionId,
    originTurnId: options.originTurnId,
    modelStepId: execution.modelStepId,
    parkSequence: execution.sequenceIndex,
  });
  const waitId = `wait_${stableHash({
    continuationId,
    toolCallId: execution.toolCallId,
    taskIds: options.predicate.taskIds,
    mode: options.predicate.mode,
  }, { format: "base32hex" }).slice(0, 16)}`;
  const timeoutAt = options.predicate.maxWaitMs === undefined
    ? undefined
    : new Date(Date.parse(createdAt) + options.predicate.maxWaitMs).toISOString();
  const record = compactRecord({
    continuationId,
    sessionId: options.sessionId,
    originTurnId: options.originTurnId,
    modelStepId: execution.modelStepId,
    parkedToolCallIds: [execution.toolCallId],
    waits: [
      compactRecord({
        waitId,
        parkedToolCallId: execution.toolCallId,
        predicate: {
          kind: "tasks" as const,
          taskIds: options.predicate.taskIds,
          mode: options.predicate.mode,
          ...(options.predicate.maxWaitMs === undefined ? {} : { maxWaitMs: options.predicate.maxWaitMs }),
        },
        state: "open" as const,
        outcomesById: {},
        terminalResultIds: [],
        timeoutAt,
      }),
    ],
    terminalResultsByToolCallId: {},
    state: "open" as const,
    createdAt,
    updatedAt: createdAt,
    timeoutAt,
  }) as HarnessContinuationRecord;

  const stored = await options.continuations.putIfAbsent(record);
  assertCompatibleContinuation(record, stored.record);
  await driveAlreadySatisfiedTaskWait({
    sessionId: options.sessionId,
    predicate: options.predicate,
    waitId,
    ledger: options.ledger,
    continuations: options.continuations,
    ...(options.resumeQueue === undefined ? {} : { resumeQueue: options.resumeQueue }),
    continuation: stored.record,
  });
  return createParkedToolResult({
    continuationId,
    pending: {
      taskIds: options.predicate.taskIds,
      mode: options.predicate.mode,
    },
  });
}

async function driveAlreadySatisfiedTaskWait(options: {
  readonly sessionId: string;
  readonly predicate: AwaitTaskPredicate;
  readonly waitId: string;
  readonly ledger: HarnessTaskLedger;
  readonly continuations: HarnessContinuationLedger;
  readonly resumeQueue?: HarnessResumeQueue;
  readonly continuation: HarnessContinuationRecord;
}): Promise<void> {
  if (options.continuation.state !== "open") {
    return;
  }
  const tasks = await Promise.all(options.predicate.taskIds.map((taskId) =>
    options.ledger.getTask({ sessionId: options.sessionId, taskId })
  ));
  if (tasks.some((task) => task === undefined)) {
    return;
  }
  const presentTasks = tasks as HarnessTaskRecord[];
  const wait = options.continuation.waits.find((entry) => entry.waitId === options.waitId);
  const timeoutAt = wait?.timeoutAt ?? options.continuation.timeoutAt;
  const now = new Date().toISOString();
  const terminalTasks = presentTasks
    .filter((task) => isTerminal(task.status))
    .filter((task) => terminalOutcomeSatisfiesWait(task, now, timeoutAt));
  // Drive whenever any member is terminal and let markWaitTerminal/evaluateWaitState decide the
  // outcome: a mode:"all" wait short-circuits to "cancelled" as soon as one member is cancelled,
  // and stays "open" for [completed, running]. A mode:"all" "all-terminal" precheck here would
  // strand the parent when one member is cancelled while a sibling is still running.
  if (terminalTasks.length === 0) {
    return;
  }

  const resumeQueueId = `resume_${stableHash({
    sessionId: options.sessionId,
    continuationId: options.continuation.continuationId,
    originTurnId: options.continuation.originTurnId,
    reason: "predicate_satisfied",
  }, { format: "base32hex" }).slice(0, 24)}`;
  for (const task of terminalTasks) {
    const marked = await options.continuations.markWaitTerminal({
      continuationId: options.continuation.continuationId,
      waitId: options.waitId,
      matchedId: task.taskId,
      fromState: "open",
      toState: task.status === "cancelled" ? "cancelled" : "terminal",
      terminalResultIds: task.terminalResultId === undefined ? [] : [task.terminalResultId],
      terminalAt: task.updatedAt ?? now,
      resumeQueueId,
      resumeReason: "predicate_satisfied",
    });
    if (marked.shouldEnqueueResume && marked.record !== undefined && options.resumeQueue !== undefined) {
      await options.resumeQueue.ensureEnqueued({
        resumeId: resumeQueueId,
        continuationId: marked.record.continuationId,
        sessionId: marked.record.sessionId,
        originTurnId: marked.record.originTurnId,
        reason: "predicate_satisfied",
        terminalResultIds: marked.record.waits.flatMap((wait) => wait.terminalResultIds),
        enqueuedAt: now,
      });
      return;
    }
    if (!marked.updated) {
      return;
    }
  }
}

function terminalOutcomeSatisfiesWait(
  task: HarnessTaskRecord,
  now: string,
  timeoutAt: string | undefined,
): boolean {
  const terminalAt = task.updatedAt ?? now;
  return timeoutAt === undefined || terminalAt <= timeoutAt;
}

async function suppressWakeupsForCancelledTask(options: {
  readonly sessionId: string;
  readonly taskId: HarnessTaskId;
  readonly wakeups?: HarnessWakeupLedger;
}): Promise<void> {
  if (options.wakeups === undefined) {
    return;
  }
  const open = await options.wakeups.listOpen(options.sessionId);
  for (const wakeup of open) {
    if (wakeup.status !== "armed" || !wakeup.predicate.taskIds.includes(options.taskId)) {
      continue;
    }
    // For mode:"all", a single cancelled member makes the predicate impossible.
    // For mode:"any", keep the wakeup armed while any sibling can still satisfy it.
    if (
      wakeup.predicate.mode === "all"
      || wakeup.predicate.taskIds.every((taskId) => taskId === options.taskId)
    ) {
      await options.wakeups.transition(wakeup.wakeupId, "armed", "closed", {
        firedAt: new Date().toISOString(),
      });
    }
  }
}

async function driveContinuationsForCancelledTask(options: {
  readonly sessionId: string;
  readonly taskId: HarnessTaskId;
  readonly ledger: HarnessTaskLedger;
  readonly continuations?: HarnessContinuationLedger;
  readonly resumeQueue?: HarnessResumeQueue;
}): Promise<void> {
  if (options.continuations === undefined) {
    return;
  }
  const open = await options.continuations.listOpen(options.sessionId);
  for (const continuation of open) {
    if (continuation.state !== "open") {
      continue;
    }
    for (const wait of continuation.waits) {
      if (wait.state !== "open") {
        continue;
      }
      const predicate = waitPredicateAsTasks(wait.predicate);
      if (predicate === undefined || !predicate.taskIds.includes(options.taskId)) {
        continue;
      }
      await driveAlreadySatisfiedTaskWait({
        sessionId: options.sessionId,
        predicate,
        waitId: wait.waitId,
        ledger: options.ledger,
        continuations: options.continuations,
        ...(options.resumeQueue === undefined ? {} : { resumeQueue: options.resumeQueue }),
        continuation,
      });
    }
  }
}

function waitPredicateAsTasks(
  predicate: HarnessContinuationRecord["waits"][number]["predicate"],
): AwaitTaskPredicate | undefined {
  if (predicate.kind === "tasks") {
    return { taskIds: predicate.taskIds, mode: predicate.mode };
  }
  if (predicate.kind === "workflow-run") {
    return { taskIds: [predicate.taskId], mode: "all" };
  }
  return undefined;
}

function assertCompatibleContinuation(
  expected: HarnessContinuationRecord,
  actual: HarnessContinuationRecord,
): void {
  const expectedWait = expected.waits[0];
  const actualWait = actual.waits.find((wait) => wait.waitId === expectedWait?.waitId);
  if (
    actual.sessionId !== expected.sessionId
    || actual.originTurnId !== expected.originTurnId
    || JSON.stringify(actual.parkedToolCallIds) !== JSON.stringify(expected.parkedToolCallIds)
    || expectedWait === undefined
    || actualWait === undefined
    || JSON.stringify(actualWait.predicate) !== JSON.stringify(expectedWait.predicate)
  ) {
    throw new Error(`Continuation ${expected.continuationId} already exists with a different park identity.`);
  }
}

function assertCompatibleWakeup(
  expected: HarnessWakeupRecord,
  actual: HarnessWakeupRecord,
): void {
  if (
    actual.sessionId !== expected.sessionId
    || actual.originTurnId !== expected.originTurnId
    || JSON.stringify(actual.predicate) !== JSON.stringify(expected.predicate)
  ) {
    throw new Error(`Wakeup ${expected.wakeupId} already exists with a different wakeup identity.`);
  }
}

function parseToolExecutionOptions(options: unknown): {
  readonly toolCallId: string;
  readonly modelStepId: string;
  readonly sequenceIndex: number;
} {
  const value = typeof options === "object" && options !== null ? options as Record<string, unknown> : {};
  const experimental = typeof value.context === "object" && value.context !== null
    ? value.context as Record<string, unknown>
    : {};
  const sequenceIndex = typeof experimental.sequenceIndex === "number" && Number.isSafeInteger(experimental.sequenceIndex)
    ? experimental.sequenceIndex
    : 0;
  return {
    toolCallId: typeof value.toolCallId === "string" ? value.toolCallId : `tool_${sequenceIndex + 1}`,
    modelStepId: typeof experimental.modelStepId === "string" ? experimental.modelStepId : "step_1",
    sequenceIndex,
  };
}

async function requireTask(
  ledger: HarnessTaskLedger,
  sessionId: string,
  taskId: HarnessTaskId,
): Promise<HarnessTaskRecord> {
  const task = await ledger.getTask({ sessionId, taskId });
  if (task === undefined) {
    throw new Error(`Task ${taskId} was not found in this session.`);
  }
  return task;
}

// Compact, model-safe projection. Never spread the raw HarnessTaskRecord: it
// carries internal-only fields (sessionId, callIdentity, queueId, reservedRunId)
// that must not appear in model-facing results. Mirrors the allowlist in
// workflows-inspection.ts presentWorkflow/runView.
function presentTask(task: HarnessTaskRecord): Record<string, unknown> {
  return definedRecord({
    taskId: task.taskId,
    status: task.status,
    kind: task.kind,
    source: task.source,
    purpose: task.purpose,
    workflowId: task.workflowId,
    workflowHandle: task.workflowHandle,
    runId: task.reservedRunId ?? task.runId,
    outputSummary: task.outputSummary,
    outputPath: task.outputPath,
    terminalResultId: task.terminalResultId,
    error: task.error,
    ...(isTerminal(task.status)
      ? {
          terminalCauseCode: task.terminalCauseCode,
          terminalMessage: task.terminalMessage,
          terminalDiagnostic: compactTerminalDiagnostic(task.terminalDiagnostic),
        }
      : {}),
  });
}

function compactTerminalDiagnostic(diagnostic: unknown): unknown {
  if (diagnostic === undefined || diagnostic === null) {
    return diagnostic;
  }
  if (typeof diagnostic !== "object") {
    return diagnostic;
  }
  if (Array.isArray(diagnostic)) {
    return "[array]";
  }

  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(diagnostic as Record<string, unknown>)) {
    if (key === "stack") {
      continue;
    }
    if (value === null || value === undefined || typeof value !== "object") {
      output[key] = value;
    } else if (Array.isArray(value)) {
      output[key] = "[array]";
    } else {
      output[key] = "[object]";
    }
  }
  return output;
}

function isTerminal(status: HarnessTaskStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function definedRecord(input: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) {
      output[key] = value;
    }
  }
  return output;
}

function compactRecord(input: Record<string, unknown>): Record<string, unknown> {
  return definedRecord(input);
}
