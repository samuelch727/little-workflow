import type { JsonObject } from "../types.js";

/**
 * Outcome vocabulary: whether a run did what it was for. A host that sends outcomes to a trace
 * store such as LittleDB maps them onto its own scores.
 */
export type HarnessOutcomeStatus = "success" | "failure" | "partial";

/** What an application (or a chat reaction) reports about a run. */
export type HarnessOutcomeInput = {
  status: HarnessOutcomeStatus;
  /**
   * True when this report WITHDRAWS an earlier report of the same `status` for the same
   * `reportKey` — a user un-reacting, for instance. The event is still appended (the trace is
   * append-only; nothing is ever erased), and the aggregation reader drops the withdrawn
   * report from its denominator.
   */
  retracted?: boolean;
  /** Optional numeric grade alongside the status. */
  score?: number;
  /** Free-text note. Keep it free of personal data — it is written to the trace verbatim. */
  detail?: string;
  /** Where the report came from, e.g. `"chat-sdk"` or `"programmatic"` (the default). */
  source?: string;
  /**
   * Pseudonymous id of whoever reported. NEVER a handle, display name or raw platform user
   * id — the chat path stores `anon_<16 hex of sha256(platform:userId)>`.
   */
  reporter?: string;
  /**
   * Stable identity of "who reported about what". Two reports sharing a `reportKey` describe
   * the same subject, so the LATEST one is authoritative when rates are computed. Omit it and
   * every report counts separately.
   */
  reportKey?: string;
  /**
   * The caller's order for reports under one `reportKey`. A higher revision supersedes a lower
   * one whichever arrives last, and two reports with the same key and revision are the same
   * report sent twice (at one revision, a retraction wins). A whole number from 0, and it needs a
   * `reportKey`. A sink that keeps state (LittleDB) fences on it, so a late, older report can't
   * overwrite a newer one. Omit it and the order reports arrive in decides, as before.
   */
  revision?: number;
  /** Workflow step path this outcome is about, when it is about one step rather than the run. */
  stepPath?: string;
  /**
   * The prompt this outcome grades. Omit it and the recorder resolves it from the session's
   * trace (the last `harness.model.called`); when it cannot be resolved the field is left OUT
   * rather than written as a placeholder.
   */
  promptHash?: string;
  /** Turn the outcome belongs to, when known. */
  turnId?: string;
  /** Extra observation-only fields merged into the trace event metadata. */
  metadata?: JsonObject;
};

/** The `outcome.reported` trace event, as the recorder wrote it. */
export type HarnessOutcomeEvent = {
  eventId: string;
  sequence: number;
  sessionId: string;
  timestamp: string;
  turnId?: string;
  status: HarnessOutcomeStatus;
  retracted?: boolean;
  score?: number;
  detail?: string;
  source: string;
  reporter?: string;
  reportKey?: string;
  revision?: number;
  stepPath?: string;
  promptHash?: string;
  metadata: JsonObject;
};

/**
 * A downstream consumer of recorded outcomes (a LittleDB score, a queue, a metrics
 * client). Sinks are best-effort: a sink that throws or returns `{ ok: false }` is COUNTED,
 * never propagated — an outcome is an observation about a run, never a gate on it.
 */
export type HarnessOutcomeSink = {
  /** Used in {@link HarnessOutcomeResult.errors} to say which sink failed. */
  readonly name?: string;
  /**
   * `stale: true` with `ok: true`: the store already holds this report's revision with a
   * retraction, or a newer revision, so nothing changed there (Harness G24).
   */
  deliver(
    event: HarnessOutcomeEvent,
  ): Promise<HarnessOutcomeDelivery | void> | HarnessOutcomeDelivery | void;
};

/** A sink's answer to one report. */
export type HarnessOutcomeDelivery = { ok: boolean; stale?: boolean };

export type HarnessOutcomeError = {
  stage: "resolve" | "trace" | "sink";
  sink?: string;
  message: string;
};

/**
 * Reporting an outcome never throws. This is what happened instead: whether the trace event
 * was written, how many sinks accepted it, and every swallowed failure.
 */
export type HarnessOutcomeResult = {
  /** True when the `outcome.reported` event was appended to the session trace. */
  recorded: boolean;
  event?: HarnessOutcomeEvent;
  delivered: number;
  /**
   * Sinks (counted in `delivered` too) that answered `stale`: their store already holds this
   * report's revision with a retraction, or a newer one, so the report didn't become current
   * there. A definite answer, so the caller doesn't send it again as it is.
   */
  stale: number;
  failed: number;
  errors: HarnessOutcomeError[];
};
