import { HarnessInputError } from "../errors.js";
import type { HarnessSessionLog } from "../events/occurrence.js";
import type { HarnessResumeQueueRecord } from "../tasks/ledger.js";
import type { Harness, HarnessEvent, HarnessTurnStart } from "../types.js";
import { createDeadlineSweeper } from "./deadline-sweeper.js";
import { runGenerateHarness } from "./generate-harness.js";
import type { HarnessInbox } from "./inbox.js";
import type { HarnessTurnResult } from "./result.js";

export type ResumeParkedOptions<TExtraBody = unknown> = {
  harness: Harness<any, TExtraBody>;
  /** Only continue this session's turns. */
  sessionId?: string;
  /**
   * Only continue the queued turn with this id (its queue record's `resumeId`), and only if it is
   * still waiting to be claimed. Needs a queue with `claim`, such as localHost's.
   */
  resumeId?: string;
  /** Continue at most this many turns. Default 10. */
  limit?: number;
  /**
   * How many times to try a turn that keeps failing to continue, for example because its model
   * call fails, before giving up on it. Steps before the failing one run again on each try,
   * unless the turn has a session log: see `sessionLog`. Default 5.
   */
  maxAttempts?: number;
  /** How long a failed turn waits before it is tried again, doubling after each failure. Default 15000. */
  retryDelayMs?: number;
  /** Passed to each continued turn, as `extraBody` is to generateHarness. */
  extraBody?: TExtraBody;
  /** Called with each continued turn's result as it finishes, for example to send the reply. */
  onResult?: (result: HarnessTurnResult<unknown>, turn: ResumedTurn) => void | Promise<void>;
  /** Called with each continued turn's events as they happen, as `onEvent` is for generateHarness. */
  onEvent?: (event: HarnessEvent, turn: ResumedTurn) => void | Promise<void>;
  /** Called once a continued turn's id and metadata are known, as `onTurnStart` is for generateHarness. */
  onTurnStart?: (start: HarnessTurnStart, turn: ResumedTurn) => void | Promise<void>;
  /**
   * Called once a turn is claimed, before it runs, with the queue record it was claimed from. When
   * it throws, the turn goes back on the queue unrun and `resumeParked` throws.
   */
  onClaim?: (turn: ResumedTurn, queued: HarnessResumeQueueRecord) => void | Promise<void>;
  /**
   * The session log a continued turn appends to and replays from, by its queue record. Each
   * continued turn runs as the run `resumeId`, so a try after a failure or a restart replays the
   * steps and tool calls that finished instead of running them again, and runs a call that
   * started and never finished again with the same `toolCallId`. Default: the harness's
   * `sessionLog`. Without either, every try runs every step again.
   */
  sessionLog?: (queued: HarnessResumeQueueRecord) => HarnessSessionLog | undefined;
  abortSignal?: AbortSignal;
  /** Awaited before each actual provider invocation, as in generateHarness. */
  beforeInvocation?: () => void | Promise<void>;
  /** Messages for the continued turns, read before each model step, as `inbox` is for generateHarness. */
  inbox?: HarnessInbox;
};

export type ResumedTurn = {
  readonly sessionId: string;
  readonly continuationId: string;
  /** Why it continued: what it waited for arrived, or its wait timed out. */
  readonly reason: HarnessResumeQueueRecord["reason"];
};

export type ResumeParkedResult = {
  readonly resumed: ReadonlyArray<ResumedTurn & { readonly result: HarnessTurnResult<unknown> }>;
  /**
   * Turns that failed to continue. One that `willRetry` stays queued, and a call after its retry
   * delay tries it again. The rest are dropped: they failed `maxAttempts` times, or can never
   * continue, for example because they parked before parked turns were saved. `attempts` counts
   * the failed tries.
   */
  readonly failed: ReadonlyArray<ResumedTurn & { readonly error: unknown; readonly willRetry: boolean; readonly attempts: number }>;
};

/**
 * Continues turns that parked in `await_tasks` and whose wait is over: the tasks finished, a person
 * answered, or `maxWaitMs` passed. Each one runs as a generateHarness turn from its saved
 * conversation, with the `await_tasks` call returning what it waited for. Call it after
 * `answerInputRequest`, and on a timer if waits have a `maxWaitMs`.
 */
export async function resumeParked<TExtraBody = unknown>(
  options: ResumeParkedOptions<TExtraBody>,
): Promise<ResumeParkedResult> {
  const durable = options.harness.config.host.durable;
  if (durable === undefined) {
    throw new HarnessInputError("resumeParked needs a host with durable services, such as localHost.");
  }
  const limit = options.limit ?? 10;
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new HarnessInputError("resumeParked limit must be a positive whole number.", { limit });
  }
  const maxAttempts = options.maxAttempts ?? 5;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new HarnessInputError("resumeParked maxAttempts must be a positive whole number.", { maxAttempts });
  }
  if (options.resumeId !== undefined && durable.resumeQueue.claim === undefined) {
    throw new HarnessInputError("resumeParked resumeId needs a resume queue with claim, such as localHost's.");
  }
  const retryDelayMs = options.retryDelayMs ?? 15_000;
  if (!Number.isFinite(retryDelayMs) || retryDelayMs < 0) {
    throw new HarnessInputError("resumeParked retryDelayMs must be zero or more.", { retryDelayMs });
  }
  // Queues the turns whose tasks finished or whose wait timed out.
  await createDeadlineSweeper({ durable }).tick();

  const resumed: Array<ResumedTurn & { readonly result: HarnessTurnResult<unknown> }> = [];
  const failed: Array<ResumedTurn & { readonly error: unknown; readonly willRetry: boolean; readonly attempts: number }> = [];
  const retry: HarnessResumeQueueRecord[] = [];
  try {
    while (resumed.length + failed.length < limit && options.abortSignal?.aborted !== true) {
      // With a resumeId, that one turn only.
      if (options.resumeId !== undefined && resumed.length + failed.length > 0) break;
      const queued = options.resumeId === undefined
        ? await durable.resumeQueue.claimNext(options.sessionId)
        : await durable.resumeQueue.claim!(options.resumeId);
      if (queued === undefined) break;
      const turn: ResumedTurn = {
        sessionId: queued.sessionId,
        continuationId: queued.continuationId,
        reason: queued.reason,
      };
      try {
        await options.onClaim?.(turn, queued);
      } catch (error) {
        const { claimedAt: _claimedAt, ...unclaimed } = queued;
        await durable.resumeQueue.enqueue(unclaimed);
        throw error;
      }
      let result: HarnessTurnResult<unknown>;
      const sessionLog = options.sessionLog?.(queued);
      try {
        const session = await options.harness.sessions.get(queued.sessionId);
        if (session === undefined) {
          throw new HarnessInputError(`No session ${queued.sessionId}.`, { sessionId: queued.sessionId });
        }
        result = await runGenerateHarness(
          {
            harness: options.harness,
            session,
            runId: queued.resumeId,
            ...(sessionLog === undefined ? {} : { sessionLog }),
            ...(options.extraBody === undefined ? {} : { extraBody: options.extraBody }),
            ...(options.abortSignal === undefined ? {} : { abortSignal: options.abortSignal }),
            ...(options.inbox === undefined ? {} : { inbox: options.inbox }),
            ...(options.beforeInvocation === undefined ? {} : { beforeInvocation: options.beforeInvocation }),
            ...(options.onEvent === undefined ? {} : { onEvent: (event: HarnessEvent) => options.onEvent!(event, turn) }),
            ...(options.onTurnStart === undefined ? {} : { onTurnStart: (start: HarnessTurnStart) => options.onTurnStart!(start, turn) }),
          },
          { continuationId: queued.continuationId },
        );
      } catch (error) {
        // A turn that can never continue (no saved conversation, already continued) leaves the
        // queue. Anything else, such as a model call that failed, is tried again after a delay
        // that doubles each time, until it has failed maxAttempts times: each try repeats the
        // steps before the failure. A turn stopped by abortSignal does not count as a try.
        // Boolean(): the loop condition narrowed `aborted`, but the turn may have aborted since.
        const aborted = Boolean(options.abortSignal?.aborted);
        const attempts = (queued.attempts ?? 0) + (aborted ? 0 : 1);
        const willRetry = !(error instanceof HarnessInputError) && (aborted || attempts < maxAttempts);
        if (willRetry) {
          retry.push(aborted ? queued : {
            ...queued,
            attempts,
            retryAt: new Date(Date.now() + retryDelayMs * 2 ** (attempts - 1)).toISOString(),
          });
        } else {
          await durable.resumeQueue.markCompleted(queued.resumeId, new Date().toISOString());
        }
        failed.push({ ...turn, error, willRetry, attempts });
        continue;
      }
      await durable.resumeQueue.markCompleted(queued.resumeId, new Date().toISOString());
      resumed.push({ ...turn, result });
      await options.onResult?.(result, turn);
    }
  } finally {
    for (const queued of retry) {
      const { claimedAt: _claimedAt, ...unclaimed } = queued;
      await durable.resumeQueue.enqueue(unclaimed);
    }
  }
  return { resumed, failed };
}

