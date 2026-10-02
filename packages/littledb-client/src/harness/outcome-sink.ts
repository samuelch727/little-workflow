import type { HarnessOutcomeEvent, HarnessOutcomeSink } from "little-harness";
import type { ReportOutcome } from "../contract.js";

/**
 * The default session → run id mapping. It MUST match the trace reporter's
 * (`createLittleDbHarnessReporter`, whose `runIdForSession` default is the same), or an
 * outcome would land on a run id that has no trace and the join would be silently empty.
 */
export const defaultRunIdForSession = (sessionId: string): string => `harness_${sessionId}`;

export type LittleDbOutcomeSinkOptions = {
  /** Anything with littleDB's `reportOutcome` shape — a `littledb()` handle, or a bare reporter. */
  report: (outcome: ReportOutcome) => Promise<{ ok: boolean }>;
  /** Override when the trace reporter was constructed with a custom `runIdForSession`. */
  runIdForSession?: (sessionId: string) => string;
  /** Sink name surfaced in `HarnessOutcomeResult.errors`. */
  name?: string;
};

/**
 * Adapt a harness `outcome.reported` event onto littleDB's `POST /api/outcomes`.
 *
 * Direction of dependency: `little-harness` never imports this package, so the wiring lives
 * here — the harness records the outcome and hands it to sinks, and this sink is what turns it
 * into the control-plane call. It is intentionally the ONLY path an outcome takes to littleDB:
 * `outcome.reported` is deliberately kept off the trace-ingest stream
 * (`createLittleDbHarnessReporter.onEvent`), because an event that arrived through both would
 * be counted twice.
 *
 * The wire envelope carries NO sequence. littleDB allocates one server-side from its reserved
 * side-channel band (`viewer/src/server/sideChannelSequence.ts`, base 3e15) when it ingests,
 * so this producer cannot collide with real trace events or with judge scores by construction.
 *
 * The join keys travel in `metadata` — `stepPath`, `promptHash`, `sessionId` and friends — and
 * NOT as new top-level fields, because `ReportOutcomeSchema` is the pinned wire contract that
 * littleDB drift-tests against.
 */
export function createLittleDbOutcomeSink(
  options: LittleDbOutcomeSinkOptions,
): HarnessOutcomeSink {
  const runIdForSession = options.runIdForSession ?? defaultRunIdForSession;
  return {
    name: options.name ?? "littledb",
    async deliver(event: HarnessOutcomeEvent) {
      // A retraction (a user removing their reaction) has no representation in the wire
      // contract — there is no "withdraw" verb — so it is recorded in the local trace and
      // applied by the local aggregation reader, but not sent onward. Reported as delivered
      // rather than failed: nothing went wrong, there was simply nothing to send.
      if (event.retracted === true) {
        return { ok: true };
      }
      return options.report(toReportOutcome(event, runIdForSession));
    },
  };
}

/** Map a recorded harness outcome onto the littleDB wire envelope. */
export function toReportOutcome(
  event: HarnessOutcomeEvent,
  runIdForSession: (sessionId: string) => string = defaultRunIdForSession,
): ReportOutcome {
  return {
    runId: runIdForSession(event.sessionId),
    status: event.status,
    ...(event.score === undefined ? {} : { score: event.score }),
    ...(event.detail === undefined ? {} : { detail: event.detail }),
    metadata: {
      ...event.metadata,
      sessionId: event.sessionId,
      source: event.source,
      eventId: event.eventId,
      // Unresolved join keys are OMITTED, never written as null/"" — a placeholder in the
      // control plane reads as data to whoever queries it next.
      ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
      ...(event.stepPath === undefined ? {} : { stepPath: event.stepPath }),
      ...(event.promptHash === undefined ? {} : { promptHash: event.promptHash }),
      ...(event.reporter === undefined ? {} : { reporter: event.reporter }),
      ...(event.reportKey === undefined ? {} : { reportKey: event.reportKey }),
    },
  };
}
