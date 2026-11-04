import { HarnessPersistenceError } from "../errors.js";

/**
 * The first required session-log append that failed inside an AI SDK step or tool callback.
 * AI SDK runs those callbacks through a notify helper that swallows what they throw, so the
 * turn keeps the failure here instead: it runs no further tool or model step and fails rather
 * than reporting completion.
 */
export type RequiredRecordFailure<TEvent> = {
  /** Zero-based model step of a failed `harness.model.responded` append. */
  stepNumber?: number;
  /** That exact append, retried once when it closed the final step. */
  event?: TEvent;
  /** Set once the turn tried to go on after the failure, which rules the retry out. */
  laterStep: boolean;
  error: unknown;
};

export type RequiredRecords<TEvent> = {
  readonly failure: RequiredRecordFailure<TEvent> | undefined;
  /** Keeps a failure unless an earlier one is already kept. */
  fail(failure: RequiredRecordFailure<TEvent>): void;
  /** Forgets the kept failure, after its append was retried successfully. */
  clear(): void;
  /** Throws the kept failure, if any: nothing more may run once a required record failed. */
  throwIfFailed(): void;
  /** Runs a callback's required append, keeping its failure before rethrowing it. */
  record(append: () => Promise<void>): Promise<void>;
  /**
   * Runs a model tool call's `harness.tool_call.started` append from `onToolExecutionStart`.
   * The tool waits on it in `acknowledgeToolStart`, so it never runs unrecorded even though
   * AI SDK swallows the callback's failure.
   */
  recordToolStart(toolCallId: string, append: () => Promise<void>): Promise<void>;
  /** Resolves once the call's start is acknowledged and no required record has failed. */
  acknowledgeToolStart(toolCallId: string | undefined, toolName: string): Promise<void>;
  /** Whether the call passed `acknowledgeToolStart`, so it ran and its outcome is recorded. */
  ran(toolCallId: string): boolean;
};

export function requiredRecords<TEvent>(): RequiredRecords<TEvent> {
  let failure: RequiredRecordFailure<TEvent> | undefined;
  const toolStarts = new Map<string, Promise<void>>();
  const acknowledged = new Set<string>();

  const records: RequiredRecords<TEvent> = {
    get failure() {
      return failure;
    },
    fail(next) {
      failure ??= next;
    },
    clear() {
      failure = undefined;
    },
    throwIfFailed() {
      if (failure !== undefined) {
        failure.laterStep = true;
        throw failure.error;
      }
    },
    async record(append) {
      try {
        await append();
      } catch (error) {
        records.fail({ laterStep: false, error });
        throw error;
      }
    },
    recordToolStart(toolCallId, append) {
      acknowledged.delete(toolCallId);
      const started = records.record(async () => {
        records.throwIfFailed();
        await append();
      });
      toolStarts.set(toolCallId, started);
      return started;
    },
    async acknowledgeToolStart(toolCallId, toolName) {
      const started = toolCallId === undefined ? undefined : toolStarts.get(toolCallId);
      if (toolCallId === undefined || started === undefined) {
        const error = new HarnessPersistenceError(
          `Tool '${toolName}' has no recorded start for this model call, so it does not run.`,
          { toolName, ...(toolCallId === undefined ? {} : { toolCallId }) },
        );
        records.fail({ laterStep: false, error });
        throw error;
      }
      await started;
      records.throwIfFailed();
      acknowledged.add(toolCallId);
    },
    ran(toolCallId) {
      return acknowledged.has(toolCallId);
    },
  };
  return records;
}

/**
 * Settles a kept failure once the model loop has returned. A failed `harness.model.responded`
 * append that closed the final step, with nothing run after it, is retried exactly once; any
 * other failure, or a retry that fails too, fails the turn.
 */
export async function settleRequiredRecords<TEvent>(
  records: RequiredRecords<TEvent>,
  finalStepNumber: number,
  emit: (event: TEvent) => Promise<void>,
): Promise<void> {
  const failure = records.failure;
  if (failure === undefined) return;
  if (!failure.laterStep && failure.event !== undefined && failure.stepNumber === finalStepNumber) {
    try {
      await emit(failure.event);
      records.clear();
      return;
    } catch {
      // The exact retry is bounded to one attempt. Preserve the original
      // stage code if the transport remains unavailable.
    }
  }
  throw failure.error;
}
