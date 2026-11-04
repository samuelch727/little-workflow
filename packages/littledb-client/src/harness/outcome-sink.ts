import type { LittleDBErrorHandler } from "../exporter.js";
import type { FeedbackApi, FeedbackInput } from "../feedback.js";
import { LittleDBError } from "../http.js";
import { clipText, isRecord, sha256Hex } from "../util.js";
import { turnTraceId, type HarnessTracer } from "./tracer.js";

/**
 * The parts of a recorded harness outcome the sink reads. `HarnessOutcomeEvent` from
 * `@little-stack/harness` fits it, so the sink goes straight into `reactions: { sinks }`,
 * `reportHarnessOutcome({ sinks })` or `createHarnessOutcomeReporter({ sinks })`.
 */
export type HarnessOutcomeEventLike = {
  readonly eventId: string;
  readonly sessionId: string;
  readonly turnId?: string | undefined;
  readonly status: "success" | "failure" | "partial";
  readonly retracted?: boolean | undefined;
  readonly score?: number | undefined;
  readonly detail?: string | undefined;
  readonly source?: string | undefined;
  readonly reporter?: string | undefined;
  readonly reportKey?: string | undefined;
  readonly revision?: number | undefined;
  readonly stepPath?: string | undefined;
  readonly promptHash?: string | undefined;
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
};

export type OutcomeSinkOptions = {
  /** The sink's name in `HarnessOutcomeResult.errors`. Default `littledb`. */
  readonly name?: string | undefined;
  /**
   * The score name every outcome is sent under, so one stream of outcomes is one signal in
   * LittleDB. Default `thumbs`.
   */
  readonly feedbackName?: string | undefined;
  /**
   * The tracer that traced these sessions. Pass it when it has its own trace ids (`traceIdFor`
   * or `traceId`), and so an outcome with no turn goes to the session's latest trace it wrote.
   * Without it a turn maps to `turnTraceId(sessionId, turnId)`, and an outcome with no turn to
   * the session's latest trace in LittleDB.
   */
  readonly tracer?: Pick<HarnessTracer, "traceIdFor" | "traceIdForTurn"> | undefined;
};

/** A `HarnessOutcomeSink` that sends outcomes to LittleDB as user feedback. */
export type LittleDBOutcomeSink = {
  readonly name: string;
  /**
   * Never throws: a failure is reported to `onError` and answered with `{ ok: false }`.
   * `stale: true`: LittleDB already holds this report's revision with a retraction, or a newer
   * one, so nothing changed there.
   */
  deliver(event: HarnessOutcomeEventLike): Promise<{ ok: boolean; stale?: boolean }>;
};

/** Outcome statuses remembered per report, for the polarity check on a retraction. */
const MAX_REMEMBERED = 10_000;
const MAX_METADATA_CHARS = 2_000;

/** The feedback id of an outcome report: one per session and `reportKey`. */
export function outcomeFeedbackId(sessionId: string, reportKey: string): string {
  return `fbo_${sha256Hex(JSON.stringify([sessionId, reportKey])).slice(0, 32)}`;
}

/**
 * Harness outcomes (app reports and chat reactions) as LittleDB user feedback.
 *
 * `success` is a thumbs up and `failure` a thumbs down. `partial` is a rating of 3 out of 5
 * (0.5), and a `score` between 0 and 1 is a rating on the same 1..5 scale (the exact score is
 * kept in `metadata.outcome.score`). `detail` is the comment, `reporter` the user id, and
 * `reportKey` the stable id, so a changed reaction replaces the earlier one. A retraction
 * withdraws it, unless the same reporter has since reported the other way (a 👎 → 👍 toggle
 * whose trailing "👎 removed" arrives last).
 *
 * With a `revision`, LittleDB orders the reports under one `reportKey` itself (Harness G24): it
 * keeps the highest revision it has applied, a retraction's included, and answers an older one
 * without changing anything. The sink answers that `{ ok: true, stale: true }`. At one revision a
 * retraction wins, and a different report there is refused (`{ ok: false }`, through `onError`).
 * The sink then sends a retraction as it is, without its own check of what it last sent.
 */
export function createOutcomeSink(
  options: OutcomeSinkOptions,
  deps: FeedbackApi & { readonly onError: LittleDBErrorHandler },
): LittleDBOutcomeSink {
  const feedbackName = options.feedbackName ?? "thumbs";
  const live = new Map<string, HarnessOutcomeEventLike["status"]>();

  const remember = (id: string, status: HarnessOutcomeEventLike["status"]) => {
    live.delete(id);
    live.set(id, status);
    while (live.size > MAX_REMEMBERED) {
      const oldest = live.keys().next().value;
      if (oldest === undefined) break;
      live.delete(oldest);
    }
  };

  const target = (event: HarnessOutcomeEventLike): { traceId: string } | { sessionId: string } => {
    if (event.turnId !== undefined) {
      return {
        traceId:
          options.tracer === undefined
            ? turnTraceId(event.sessionId, event.turnId)
            : options.tracer.traceIdForTurn(event.sessionId, event.turnId),
      };
    }
    const latest = options.tracer?.traceIdFor(event.sessionId);
    return latest === undefined ? { sessionId: event.sessionId } : { traceId: latest };
  };

  return {
    name: options.name ?? "littledb",
    async deliver(event) {
      try {
        const id = outcomeFeedbackId(event.sessionId, event.reportKey ?? event.eventId);
        if (event.retracted === true) {
          // Without a reportKey there is no earlier report this one could name.
          if (event.reportKey === undefined) return { ok: true };
          const revision = event.revision;
          const current = live.get(id);
          if (revision === undefined && current !== undefined && current !== event.status) return { ok: true };
          live.delete(id);
          try {
            const retracted = await deps.retractFeedback(id, revision === undefined ? {} : { revision });
            if (retracted.stale === true) return { ok: true, stale: true };
          } catch (error) {
            // Never sent, or already withdrawn: either way nothing is left to retract.
            if (!(error instanceof LittleDBError && error.status === 404)) throw error;
          }
          return { ok: true };
        }
        remember(id, event.status);
        const sent = await deps.feedback(outcomeFeedback(event, id, feedbackName, target(event)));
        return sent.stale === true ? { ok: true, stale: true } : { ok: true };
      } catch (error) {
        deps.onError(error, { operation: "feedback" });
        return { ok: false };
      }
    },
  };
}

/** The feedback one outcome becomes. */
export function outcomeFeedback(
  event: HarnessOutcomeEventLike,
  id: string,
  name: string,
  target: { traceId: string } | { sessionId: string },
): FeedbackInput {
  const score =
    typeof event.score === "number" && Number.isFinite(event.score) && event.score >= 0 && event.score <= 1
      ? event.score
      : undefined;
  const verdict: Pick<FeedbackInput, "thumbs" | "rating"> =
    score !== undefined
      ? { rating: { value: 1 + Math.round(score * 4), scale: 5 } }
      : event.status === "partial"
        ? { rating: { value: 3, scale: 5 } }
        : { thumbs: event.status === "success" ? "up" : "down" };
  const extra = smallMetadata(event.metadata);
  return {
    ...target,
    id,
    ...(event.revision === undefined ? {} : { revision: event.revision }),
    name,
    ...verdict,
    ...(event.reporter === undefined || event.reporter.length === 0 ? {} : { userId: clipText(event.reporter, 200) }),
    ...(event.detail === undefined || event.detail.trim().length === 0 ? {} : { comment: clipText(event.detail, 4000) }),
    metadata: {
      ...extra,
      outcome: {
        status: event.status,
        eventId: event.eventId,
        ...(event.source === undefined ? {} : { source: event.source }),
        ...(event.score === undefined ? {} : { score: event.score }),
        ...(event.stepPath === undefined ? {} : { stepPath: event.stepPath }),
        ...(event.promptHash === undefined ? {} : { promptHash: event.promptHash }),
        ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
      },
    },
  };
}

/** The outcome's own metadata (a reaction's `surface`, for example), when it is small. */
function smallMetadata(metadata: HarnessOutcomeEventLike["metadata"]): Record<string, unknown> {
  if (!isRecord(metadata)) return {};
  try {
    return JSON.stringify(metadata).length <= MAX_METADATA_CHARS ? { ...metadata } : {};
  } catch {
    return {};
  }
}
