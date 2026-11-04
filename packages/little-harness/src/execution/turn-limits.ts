import { isStepCount, RetryError, type LanguageModelUsage, type StopCondition } from "ai";
import { HarnessInputError, LittleHarnessError } from "../errors.js";
import { parkedThisStep } from "./park-resume.js";

/**
 * Step/cost limits default to one run. Opt into logical-turn accounting to persist actual
 * provider attempts and known response cost across parks/restarts. Deadlines remain per run.
 */
export type HarnessTurnLimits = {
  /** Default run keeps legacy resets. Logical-turn persists model-attempt steps/cost through parks. */
  readonly accounting?: "run" | "logical-turn";
  /** The most model steps per run, or actual provider invocations per logical turn. */
  readonly maxSteps?: number;
  /**
   * The known response-cost threshold in US dollars, as `price` reckons it. A crossing call
   * finishes; the next provider call is blocked. This is not a prepaid hard spend cap. Needs `price`.
   */
  readonly maxCostUsd?: number;
  /** How long a run may take, in milliseconds, from when it starts. Then it stops with `Interrupted`. */
  readonly deadlineMs?: number;
  /** What one model call cost, in US dollars. Harness has no price table, so the app passes one. */
  readonly price?: (call: { readonly model: string; readonly usage: LanguageModelUsage }) => number;
  /**
   * Logical-turn accounting only. The host's word that a model call the provider rejected had no
   * effect and costs nothing, such as a provider that refuses some statuses before processing and
   * doesn't bill them. Harness asks only when the provider call itself rejects: never for an abort,
   * an error inside a stream that began, or a stream that ends without usage. On `true` the
   * reservation settles as refused, with no usage and no cost; it still takes one step. Unset,
   * every unknown attempt stays held, and a held attempt blocks a priced turn's next call.
   */
  readonly refusedBeforeEffect?: (error: unknown, call: { readonly provider: string; readonly modelId: string }) => boolean;
};

export type HarnessTurnLimitReason = "StepLimitExceeded" | "CostLimitExceeded" | "Interrupted" | "BudgetStateUnavailable";

/**
 * A turn stopped by one of its `turnLimits`, or by `stop`. Its `name` is the reason, so trace
 * readers that look at an error's name (LittleDB does) see `StepLimitExceeded`,
 * `CostLimitExceeded`, `Interrupted`, or `BudgetStateUnavailable` for unprovable accounting.
 */
export class HarnessTurnLimitError extends LittleHarnessError {
  readonly reason: HarnessTurnLimitReason;

  constructor(reason: HarnessTurnLimitReason, message: string, details?: Record<string, unknown>) {
    super(message, "harness_turn_limit", details);
    this.reason = reason;
    this.name = reason;
  }
}

/**
 * The turn's limit, when one stopped it. AI SDK wraps an error thrown on a retried model call in a
 * `RetryError`, so a limit reached after a provider error (a 529, then `StepLimitExceeded` or
 * `BudgetStateUnavailable`) is found as its `lastError`, and the turn fails with that reason.
 */
export function turnLimitCause(error: unknown): unknown {
  if (error instanceof HarnessTurnLimitError) return error;
  const last = RetryError.isInstance(error) ? error.lastError : undefined;
  return last instanceof HarnessTurnLimitError ? last : error;
}

export type TurnLimiter = {
  /** The caller's signal joined with the deadline's, or the caller's alone without a deadline. */
  readonly signal: AbortSignal | undefined;
  /** Stops the run at its step or cost limit, and remembers which. */
  readonly stopWhen: StopCondition<any> | undefined;
  /** The step count a run without its own `stopWhen` stops at. */
  readonly maxSteps: number | undefined;
  /** Starts the deadline. Call once the turn actually runs, after it has the session. */
  start(): void;
  /** Why the run stopped early, if a limit stopped it. */
  exceeded(): HarnessTurnLimitError | undefined;
  /** What the run's model calls cost so far, when there is a `price`. */
  costUsd(): number | undefined;
  dispose(): void;
};

export function createTurnLimiter(
  limits: HarnessTurnLimits | undefined,
  abortSignal: AbortSignal | undefined,
  defaultModel: string,
): TurnLimiter {
  if (limits === undefined) {
    return {
      signal: abortSignal,
      stopWhen: undefined,
      maxSteps: undefined,
      start() {},
      exceeded: () => undefined,
      costUsd: () => undefined,
      dispose() {},
    };
  }
  check(limits);
  const { maxSteps, maxCostUsd, deadlineMs, price } = limits;
  let reason: HarnessTurnLimitError | undefined;
  let spent: number | undefined;
  const deadline = deadlineMs === undefined ? undefined : new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stopAtStep = maxSteps === undefined ? undefined : isStepCount(maxSteps);

  const stopWhen: StopCondition<any> = async (options) => {
    const { steps } = options;
    if (price !== undefined && limits.accounting !== "logical-turn") {
      spent = steps.reduce((sum, step) => sum + price({ model: step.response?.modelId ?? defaultModel, usage: step.usage }), 0);
    }
    // A step that ended the turn on its own (an answer, or a park) is not stopped by a limit.
    const wantsMore = (steps.at(-1)?.toolCalls.length ?? 0) > 0 && !parkedThisStep(options);
    if (!wantsMore) return false;
    if (limits.accounting !== "logical-turn" && maxCostUsd !== undefined && spent !== undefined && spent >= maxCostUsd) {
      reason ??= new HarnessTurnLimitError(
        "CostLimitExceeded",
        `The turn reached its cost limit of $${maxCostUsd} (it spent $${spent.toFixed(4)}).`,
        { maxCostUsd, costUsd: spent, steps: steps.length },
      );
      return true;
    }
    if (stopAtStep !== undefined && (await stopAtStep(options))) {
      reason ??= new HarnessTurnLimitError(
        "StepLimitExceeded",
        `The turn reached its limit of ${maxSteps} model steps.`,
        { maxSteps, steps: steps.length },
      );
      return true;
    }
    return false;
  };

  return {
    signal: deadline === undefined
      ? abortSignal
      : abortSignal === undefined ? deadline.signal : AbortSignal.any([abortSignal, deadline.signal]),
    stopWhen,
    maxSteps,
    start() {
      if (deadline === undefined || timer !== undefined) return;
      timer = setTimeout(() => {
        reason ??= new HarnessTurnLimitError("Interrupted", `The turn took longer than ${deadlineMs} ms.`, { deadlineMs });
        deadline.abort(reason);
      }, deadlineMs);
      timer.unref?.();
    },
    exceeded: () => reason,
    costUsd: () => spent,
    dispose() {
      clearTimeout(timer);
    },
  };
}

function check(limits: HarnessTurnLimits): void {
  const { maxSteps, maxCostUsd, deadlineMs, price } = limits;
  if (limits.accounting !== undefined && limits.accounting !== "run" && limits.accounting !== "logical-turn") throw new HarnessInputError("Unknown turnLimits.accounting mode.");
  if (maxSteps !== undefined && (!Number.isSafeInteger(maxSteps) || maxSteps < 1)) {
    throw new HarnessInputError("turnLimits.maxSteps must be a positive whole number.", { maxSteps });
  }
  if (maxCostUsd !== undefined && (!Number.isFinite(maxCostUsd) || maxCostUsd <= 0)) {
    throw new HarnessInputError("turnLimits.maxCostUsd must be a positive number of US dollars.", { maxCostUsd });
  }
  if (maxCostUsd !== undefined && typeof price !== "function") {
    throw new HarnessInputError("turnLimits.maxCostUsd needs turnLimits.price: Harness has no price table.", { maxCostUsd });
  }
  if (deadlineMs !== undefined && (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1)) {
    throw new HarnessInputError("turnLimits.deadlineMs must be a positive whole number of milliseconds.", { deadlineMs });
  }
  if (limits.refusedBeforeEffect !== undefined && typeof limits.refusedBeforeEffect !== "function") {
    throw new HarnessInputError("turnLimits.refusedBeforeEffect must be a function.");
  }
  if (limits.refusedBeforeEffect !== undefined && limits.accounting !== "logical-turn") {
    throw new HarnessInputError("turnLimits.refusedBeforeEffect needs accounting: \"logical-turn\"; run accounting keeps no reservations.");
  }
}
