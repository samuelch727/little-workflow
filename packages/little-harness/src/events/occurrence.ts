import type { JsonObject } from "../types.js";
import type { HarnessEventType } from "./names.js";

export type DurableHarnessEventInput<TEventType extends string = HarnessEventType> = {
  readonly type: TEventType;
  readonly runId: string;
  readonly occurrenceId?: string;
  readonly payload: JsonObject;
};

export type PersistedDurableHarnessEvent<TEventType extends string = HarnessEventType> =
  DurableHarnessEventInput<TEventType> & {
    readonly eventId: string;
    readonly sequence: number;
    readonly recordedAt: string;
  };

export type TraceHarnessEventInput<TEventType extends string = HarnessEventType> = {
  readonly type: TEventType;
  readonly occurrenceId?: string;
  readonly metadata?: JsonObject;
};

export type HarnessPriorEventQuery<TEventType extends string = HarnessEventType> = {
  readonly type?: TEventType;
  readonly occurrenceId?: string;
  readonly runId?: string;
};

/**
 * The session log — the managed-agents "session" port: an append-only durable event log
 * that is the source of truth for a run (append + priorEvents). A stateless harness
 * reconstructs everything else from it.
 */
export type HarnessSessionLog<TEventType extends string = HarnessEventType> = {
  readonly append: (
    event: DurableHarnessEventInput<TEventType>,
  ) =>
    | Promise<PersistedDurableHarnessEvent<TEventType> | void>
    | PersistedDurableHarnessEvent<TEventType>
    | void;
  readonly priorEvents?: (
    query?: HarnessPriorEventQuery<TEventType>,
  ) =>
    | Promise<readonly PersistedDurableHarnessEvent<TEventType>[]>
    | readonly PersistedDurableHarnessEvent<TEventType>[];
};

/** Historical name of the session-log contract (it reads via priorEvents too, not only "sinks"). */
export type HarnessDurabilitySink<TEventType extends string = HarnessEventType> =
  HarnessSessionLog<TEventType>;

export type HarnessTraceSink<TEventType extends string = HarnessEventType> = {
  readonly append: (event: TraceHarnessEventInput<TEventType>) => Promise<void> | void;
};

export type HarnessEventOccurrence<TEventType extends string = HarnessEventType> = {
  readonly type: TEventType;
  readonly runId: string;
  readonly occurrenceId?: string;
  readonly payload?: JsonObject;
  readonly metadata?: JsonObject;
  readonly durability?: HarnessDurabilitySink<TEventType>;
  readonly trace?: HarnessTraceSink<TEventType>;
  readonly onTraceError?: (
    error: unknown,
    event: TraceHarnessEventInput<TEventType>,
  ) => Promise<void> | void;
};

export async function emitHarnessOccurrence<TEventType extends string = HarnessEventType>(
  event: HarnessEventOccurrence<TEventType>,
): Promise<void> {
  if (event.payload !== undefined && event.durability !== undefined) {
    await event.durability.append({
      type: event.type,
      runId: event.runId,
      ...(event.occurrenceId === undefined ? {} : { occurrenceId: event.occurrenceId }),
      payload: event.payload,
    });
  }

  if (event.trace === undefined) {
    return;
  }

  const traceEvent: TraceHarnessEventInput<TEventType> = {
    type: event.type,
    ...(event.occurrenceId === undefined ? {} : { occurrenceId: event.occurrenceId }),
    ...(event.metadata === undefined ? {} : { metadata: event.metadata }),
  };

  try {
    await event.trace.append(traceEvent);
  } catch (error) {
    await event.onTraceError?.(error, traceEvent);
  }
}
