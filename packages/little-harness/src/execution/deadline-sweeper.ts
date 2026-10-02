import type { HarnessDurableServices } from "../types.js";
import { stableHash } from "../utils/canonical-hash.js";
import type {
  HarnessContinuationRecord,
  HarnessContinuationWaitRecord,
  HarnessTaskLedger,
  HarnessWakeupRecord,
} from "../tasks/ledger.js";
import type { HarnessTaskId, HarnessTaskRecord } from "../tasks/types.js";

export type DeadlineSweeper = {
  tick(): Promise<DeadlineSweeperTickResult>;
};

export type DeadlineSweeperTickResult = {
  readonly timedOutContinuationWaits: number;
  readonly readyWakeups: number;
  readonly timedOutWakeups: number;
};

export function createDeadlineSweeper(options: {
  readonly durable: Pick<HarnessDurableServices, "continuations" | "resumeQueue" | "tasks" | "wakeups">;
  readonly now?: () => Date;
}): DeadlineSweeper {
  return {
    async tick() {
      const now = (options.now?.() ?? new Date()).toISOString();
      let timedOutContinuationWaits = 0;
      let readyWakeups = 0;
      let timedOutWakeups = 0;
      const continuations = await options.durable.continuations.listOpen();

      for (const continuation of continuations) {
        for (const wait of continuation.waits) {
          if (wait.state !== "open") {
            continue;
          }
          // Re-evaluate the awaited predicate for SATISFACTION before the
          // timeout check, so a task that terminalizes after park (the normal
          // async case) resumes the continuation as predicate_satisfied rather
          // than firing a misleading timeout. Late terminal outcomes after the
          // wait deadline do not satisfy the predicate; timeout wins there.
          // Mirrors driveAlreadySatisfiedTaskWait.
          if (await drivePredicateSatisfiedWait(options.durable, continuation, wait, now)) {
            continue;
          }
          const timeoutAt = wait.timeoutAt ?? continuation.timeoutAt;
          if (timeoutAt === undefined || timeoutAt > now) {
            continue;
          }
          const resumeId = resumeQueueId({
            sessionId: continuation.sessionId,
            continuationId: continuation.continuationId,
            originTurnId: continuation.originTurnId,
            reason: "timeout",
          });
          const marked = await options.durable.continuations.markWaitTerminal({
            continuationId: continuation.continuationId,
            waitId: wait.waitId,
            fromState: "open",
            toState: "timed_out",
            terminalResultIds: [],
            terminalAt: now,
            resumeQueueId: resumeId,
            resumeReason: "timeout",
          });
          if (!marked.updated) {
            continue;
          }
          timedOutContinuationWaits += 1;
          if (marked.shouldEnqueueResume && marked.record !== undefined) {
            await options.durable.resumeQueue.ensureEnqueued({
              resumeId,
              continuationId: marked.record.continuationId,
              sessionId: marked.record.sessionId,
              originTurnId: marked.record.originTurnId,
              reason: "timeout",
              terminalResultIds: [],
              enqueuedAt: now,
            });
          }
        }
      }

      const wakeups = await options.durable.wakeups.listOpen();
      for (const wakeup of wakeups) {
        if (wakeup.status !== "armed") {
          continue;
        }
        const predicate = await inspectWakeupPredicate(options.durable.tasks, wakeup, wakeup.timeoutAt);
        if (predicate.cancelled) {
          await options.durable.wakeups.transition(
            wakeup.wakeupId,
            "armed",
            "closed",
            { firedAt: now },
          );
          continue;
        }
        if (predicate.satisfied) {
          const resumeQueueId = wakeupResumeQueueId({
            sessionId: wakeup.sessionId,
            wakeupId: wakeup.wakeupId,
            originTurnId: wakeup.originTurnId,
            reason: "predicate_satisfied",
          });
          const marked = await options.durable.wakeups.transition(
            wakeup.wakeupId,
            "armed",
            "resume_enqueued",
            { firedAt: now, firedReason: "predicate_satisfied", resumeQueueId },
          );
          if (marked.updated) {
            readyWakeups += 1;
          }
          continue;
        }
        if (wakeup.timeoutAt !== undefined && wakeup.timeoutAt <= now) {
          const marked = await options.durable.wakeups.transition(
            wakeup.wakeupId,
            "armed",
            "timed_out",
            { firedAt: now, firedReason: "timeout" },
          );
          if (marked.updated) {
            timedOutWakeups += 1;
          }
        }
      }

      return { timedOutContinuationWaits, readyWakeups, timedOutWakeups };
    },
  };
}

function resumeQueueId(input: {
  readonly sessionId: string;
  readonly continuationId: string;
  readonly originTurnId: string;
  readonly reason: "timeout" | "predicate_satisfied";
}): string {
  return `resume_${stableHash(input, { format: "base32hex" }).slice(0, 24)}`;
}

function waitPredicateTaskIds(
  predicate: HarnessContinuationWaitRecord["predicate"],
): { readonly taskIds: readonly HarnessTaskId[]; readonly mode: "all" | "any" } | undefined {
  if (predicate.kind === "tasks") {
    return { taskIds: predicate.taskIds, mode: predicate.mode };
  }
  if (predicate.kind === "workflow-run") {
    return { taskIds: [predicate.taskId], mode: "all" };
  }
  return undefined;
}

// Re-reads the tasks referenced by an open task/workflow-run wait and, if the
// predicate is now satisfied (treating cancelled as a terminal child per spec),
// transitions the wait to terminal/cancelled with a predicate_satisfied resume.
// Uses the same resume id and compare-and-set path as the at-park drive
// (control-tools.driveAlreadySatisfiedTaskWait) so park-time and sweep-time are
// idempotent. Returns true ONLY when a resume was enqueued (the wait closed), so the caller
// skips the timeout branch; returns false when the wait is still open (e.g. a partial mode:"all"
// where one member is terminal and a sibling is still pending) so the caller still evaluates
// `timeoutAt` and can fire the timeout.
async function drivePredicateSatisfiedWait(
  durable: Pick<HarnessDurableServices, "continuations" | "resumeQueue" | "tasks">,
  continuation: HarnessContinuationRecord,
  wait: HarnessContinuationWaitRecord,
  now: string,
): Promise<boolean> {
  const referenced = waitPredicateTaskIds(wait.predicate);
  if (referenced === undefined) {
    return false;
  }
  const records = await Promise.all(referenced.taskIds.map((taskId) =>
    durable.tasks.getTask({ sessionId: continuation.sessionId, taskId })
  ));
  if (records.some((record) => record === undefined)) {
    return false;
  }
  const presentTasks = records as HarnessTaskRecord[];
  const timeoutAt = wait.timeoutAt ?? continuation.timeoutAt;
  const terminalTasks = presentTasks
    .filter((task) => isTerminalTaskStatus(task.status))
    .filter((task) => terminalOutcomeSatisfiesWait(task, now, timeoutAt));
  // Drive whenever any member is terminal; markWaitTerminal/evaluateWaitState decide the outcome
  // (mode:"all" short-circuits to "cancelled" on any cancelled member; stays "open" otherwise).
  // A mode:"all" "all-terminal" precheck here would strand the parent on a cancelled member.
  if (terminalTasks.length === 0) {
    return false;
  }

  const resumeId = resumeQueueId({
    sessionId: continuation.sessionId,
    continuationId: continuation.continuationId,
    originTurnId: continuation.originTurnId,
    reason: "predicate_satisfied",
  });
  for (const task of terminalTasks) {
    const marked = await durable.continuations.markWaitTerminal({
      continuationId: continuation.continuationId,
      waitId: wait.waitId,
      matchedId: task.taskId,
      fromState: "open",
      toState: task.status === "cancelled" ? "cancelled" : "terminal",
      terminalResultIds: task.terminalResultId === undefined ? [] : [task.terminalResultId],
      terminalAt: task.updatedAt ?? now,
      resumeQueueId: resumeId,
      resumeReason: "predicate_satisfied",
    });
    if (marked.shouldEnqueueResume && marked.record !== undefined) {
      await durable.resumeQueue.ensureEnqueued({
        resumeId,
        continuationId: marked.record.continuationId,
        sessionId: marked.record.sessionId,
        originTurnId: marked.record.originTurnId,
        reason: "predicate_satisfied",
        terminalResultIds: marked.record.waits.flatMap((entry) => entry.terminalResultIds),
        enqueuedAt: now,
      });
      return true;
    }
    if (!marked.updated) {
      return false;
    }
  }
  // The wait did not close (e.g. a partial mode:"all": one member terminal, a sibling still
  // pending). Return false so the caller still evaluates `timeoutAt` and can fire the timeout —
  // otherwise the wait's maxWaitMs would never be honored and the parent would strand forever.
  return false;
}

function isTerminalTaskStatus(status: HarnessTaskRecord["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function terminalOutcomeSatisfiesWait(
  task: HarnessTaskRecord,
  now: string,
  timeoutAt: string | undefined,
): boolean {
  const terminalAt = task.updatedAt ?? now;
  return timeoutAt === undefined || terminalAt <= timeoutAt;
}

function wakeupResumeQueueId(input: {
  readonly sessionId: string;
  readonly wakeupId: string;
  readonly originTurnId: string;
  readonly reason: "predicate_satisfied";
}): string {
  return `wakeup_resume_${stableHash(input, { format: "base32hex" }).slice(0, 24)}`;
}

async function inspectWakeupPredicate(
  tasks: HarnessTaskLedger,
  wakeup: HarnessWakeupRecord,
  deadlineAt?: string,
): Promise<{ readonly satisfied: boolean; readonly cancelled: boolean }> {
  const records = await Promise.all(wakeup.predicate.taskIds.map((taskId) =>
    tasks.getTask({ sessionId: wakeup.sessionId, taskId })
  ));
  if (records.some((record) => record === undefined)) {
    return { satisfied: false, cancelled: false };
  }
  const presentTasks = records as HarnessTaskRecord[];
  // Cancellation suppresses autonomous wakeups for the cancelled task (spec
  // line 413): a cancelled task does NOT satisfy an armed wakeup, so a
  // mode:'all' wakeup with a cancelled member never fires predicate_satisfied,
  // and a mode:'any' wakeup is not driven by the cancellation alone. (The
  // await/continuation path keeps treating cancelled as a terminal child.)
  const terminalTasks = presentTasks.filter((task) =>
    task.status === "completed" || task.status === "failed"
  ).filter((task) =>
    deadlineAt === undefined || task.updatedAt <= deadlineAt
  );
  const cancelledTasks = presentTasks.filter((task) => task.status === "cancelled");
  const cancelled = wakeup.predicate.mode === "all"
    ? cancelledTasks.length > 0
    : cancelledTasks.length === presentTasks.length;
  const satisfied = wakeup.predicate.mode === "all"
    ? terminalTasks.length === presentTasks.length
    : terminalTasks.length > 0;
  return { satisfied, cancelled };
}
