import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createEventId } from "../ids.js";
import { resolveTraceOptions } from "../trace/options.js";
import { sanitizeTraceValue } from "../trace/redaction.js";
import { validateTraceEvent } from "../trace/validate.js";
import type { Harness, HarnessSession, JsonObject } from "../types.js";
import { nextSideChannelSequence } from "./sequence.js";
import type {
  HarnessOutcomeError,
  HarnessOutcomeEvent,
  HarnessOutcomeInput,
  HarnessOutcomeResult,
  HarnessOutcomeSink,
} from "./types.js";

const DEFAULT_SOURCE = "programmatic";

/** How the recorder finds the session (and therefore the trace) an outcome belongs to. */
export type HarnessOutcomeTarget = {
  /** The session being graded. Cheapest form — carries its own trace ref. */
  session?: HarnessSession;
  /** Resolve the session by id (used with `sessionId`). */
  harness?: Harness<any, any>;
  sessionId?: string;
  /** Explicit trace file, for hosts whose session does not expose `trace.path`. */
  tracePath?: string;
};

export type ReportHarnessOutcomeOptions = HarnessOutcomeTarget &
  HarnessOutcomeInput & {
    /** Best-effort downstream consumers (littleDB, queues, metrics). */
    sinks?: readonly HarnessOutcomeSink[];
    /** Injectable clock, for tests. */
    now?: () => number;
  };

/**
 * Record an application-observed outcome for a run as an `outcome.reported` trace event, then
 * hand it to any configured sinks.
 *
 * An outcome is an OBSERVATION, never a gate: this function never throws and never returns a
 * rejected promise. A missing session, an unwritable trace, a sink that blows up — each is
 * captured in {@link HarnessOutcomeResult.errors} and counted, and the run it describes is
 * untouched. Callers that care can inspect the result; callers that do not can ignore it.
 */
export async function reportHarnessOutcome(
  options: ReportHarnessOutcomeOptions,
): Promise<HarnessOutcomeResult> {
  const errors: HarnessOutcomeError[] = [];
  let target: { sessionId: string; tracePath?: string } | undefined;

  try {
    target = await resolveTarget(options);
  } catch (error) {
    errors.push({ stage: "resolve", message: errorMessage(error) });
  }

  if (target === undefined) {
    return { recorded: false, delivered: 0, failed: 0, errors };
  }

  const promptHash =
    options.promptHash ??
    (target.tracePath === undefined
      ? undefined
      : await resolvePromptHash(target.tracePath, options.turnId).catch((error: unknown) => {
          errors.push({ stage: "resolve", message: errorMessage(error) });
          return undefined;
        }));

  const traceOptions = resolveTraceOptions(undefined, undefined);
  const extraMetadata = sanitizeTraceValue(options.metadata ?? {}, traceOptions).value as JsonObject;

  const event: HarnessOutcomeEvent = {
    eventId: createEventId(),
    sequence: nextSideChannelSequence("outcome", options.now),
    sessionId: target.sessionId,
    timestamp: new Date(options.now ? options.now() : Date.now()).toISOString(),
    status: options.status,
    source: options.source ?? DEFAULT_SOURCE,
    metadata: extraMetadata,
    // Joinable fields are OMITTED when unresolved — never written as "" or "unknown", which a
    // later reader would mistake for data.
    ...(options.turnId === undefined ? {} : { turnId: options.turnId }),
    ...(options.retracted === undefined ? {} : { retracted: options.retracted }),
    ...(options.score === undefined ? {} : { score: options.score }),
    ...(options.detail === undefined ? {} : { detail: options.detail }),
    ...(options.reporter === undefined ? {} : { reporter: options.reporter }),
    ...(options.reportKey === undefined ? {} : { reportKey: options.reportKey }),
    ...(options.stepPath === undefined ? {} : { stepPath: options.stepPath }),
    ...(promptHash === undefined ? {} : { promptHash }),
  };

  let recorded = false;
  if (target.tracePath === undefined) {
    errors.push({
      stage: "trace",
      message: "Session exposes no trace path; the outcome was not recorded in a trace.",
    });
  } else {
    try {
      await appendOutcomeEvent(target.tracePath, event);
      recorded = true;
    } catch (error) {
      errors.push({ stage: "trace", message: errorMessage(error) });
    }
  }

  let delivered = 0;
  let failed = 0;
  for (const [index, sink] of (options.sinks ?? []).entries()) {
    const name = sink.name ?? `sink[${index}]`;
    try {
      const result = await sink.deliver(event);
      if (result === undefined || result.ok) {
        delivered += 1;
      } else {
        failed += 1;
        errors.push({ stage: "sink", sink: name, message: "Sink reported ok: false." });
      }
    } catch (error) {
      failed += 1;
      errors.push({ stage: "sink", sink: name, message: errorMessage(error) });
    }
  }

  return { recorded, event, delivered, failed, errors };
}

export type HarnessOutcomeReporterOptions = {
  harness?: Harness<any, any>;
  session?: HarnessSession;
  sinks?: readonly HarnessOutcomeSink[];
  /** Default `source` for reports made through this reporter. */
  source?: string;
};

export type HarnessOutcomeReporter = {
  report(
    input: HarnessOutcomeInput & { sessionId?: string; session?: HarnessSession },
  ): Promise<HarnessOutcomeResult>;
};

/**
 * The programmatic feedback hook: bind a harness (and its sinks) once, then report outcomes
 * for any of its sessions. `report()` inherits every guarantee of
 * {@link reportHarnessOutcome} — it never throws.
 */
export function createHarnessOutcomeReporter(
  options: HarnessOutcomeReporterOptions,
): HarnessOutcomeReporter {
  return {
    report(input) {
      const { sessionId, session, ...rest } = input;
      // An explicit `sessionId` addresses a specific session, so it must not silently fall
      // back to the reporter's default session object.
      const resolvedSession = session ?? (sessionId === undefined ? options.session : undefined);
      return reportHarnessOutcome({
        ...rest,
        source: rest.source ?? options.source ?? DEFAULT_SOURCE,
        ...(options.harness === undefined ? {} : { harness: options.harness }),
        ...(resolvedSession === undefined ? {} : { session: resolvedSession }),
        ...(sessionId === undefined ? {} : { sessionId }),
        ...(options.sinks === undefined ? {} : { sinks: options.sinks }),
      });
    },
  };
}

async function resolveTarget(
  options: HarnessOutcomeTarget,
): Promise<{ sessionId: string; tracePath?: string }> {
  if (options.session !== undefined) {
    const tracePath = options.tracePath ?? options.session.trace?.path;
    return {
      sessionId: options.session.id,
      ...(tracePath === undefined ? {} : { tracePath }),
    };
  }

  if (options.sessionId === undefined) {
    throw new Error("reportHarnessOutcome requires either `session` or `sessionId`.");
  }

  if (options.tracePath !== undefined) {
    return { sessionId: options.sessionId, tracePath: options.tracePath };
  }

  if (options.harness === undefined) {
    throw new Error(
      "reportHarnessOutcome requires `harness` (or `tracePath`) to resolve a session by id.",
    );
  }

  const session = await options.harness.sessions.get(options.sessionId);
  if (session === undefined) {
    throw new Error(`Session not found: ${options.sessionId}`);
  }
  const tracePath = session.trace?.path;
  return {
    sessionId: session.id,
    ...(tracePath === undefined ? {} : { tracePath }),
  };
}

async function appendOutcomeEvent(tracePath: string, event: HarnessOutcomeEvent): Promise<void> {
  const traceEvent = validateTraceEvent({
    schemaVersion: "lh.trace.v2",
    eventId: event.eventId,
    sequence: event.sequence,
    type: "outcome.reported",
    sessionId: event.sessionId,
    timestamp: event.timestamp,
    ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
    metadata: outcomeMetadata(event),
  });
  await mkdir(dirname(tracePath), { recursive: true });
  await appendFile(tracePath, `${JSON.stringify(traceEvent)}\n`, "utf8");
}

/** The trace-event metadata for an outcome: known fields first, caller extras merged after. */
export function outcomeMetadata(event: HarnessOutcomeEvent): JsonObject {
  return {
    ...event.metadata,
    status: event.status,
    source: event.source,
    ...(event.retracted === undefined ? {} : { retracted: event.retracted }),
    ...(event.score === undefined ? {} : { score: event.score }),
    ...(event.detail === undefined ? {} : { detail: event.detail }),
    ...(event.reporter === undefined ? {} : { reporter: event.reporter }),
    ...(event.reportKey === undefined ? {} : { reportKey: event.reportKey }),
    ...(event.stepPath === undefined ? {} : { stepPath: event.stepPath }),
    ...(event.promptHash === undefined ? {} : { promptHash: event.promptHash }),
  };
}

/**
 * Best-effort promptHash join: the hash of the most recent `harness.model.called` in the
 * session's trace (optionally narrowed to one turn), which is the prompt that produced the
 * reply a user is most likely reacting to.
 *
 * Deliberately imprecise: a reaction on an OLDER message still resolves to the latest prompt
 * of that turn/session. The chat path records the reacted-to platform message id in the event
 * metadata so a later reader can re-attribute more exactly. Returns `undefined` — never a
 * placeholder — when no model call is present.
 */
export async function resolvePromptHash(
  tracePath: string,
  turnId?: string,
): Promise<string | undefined> {
  const text = await readFile(tracePath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });

  const lines = text.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line === undefined || line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObject(parsed) || parsed.type !== "harness.model.called") continue;
    if (turnId !== undefined && parsed.turnId !== turnId) continue;
    const metadata = isObject(parsed.metadata) ? parsed.metadata : undefined;
    const request = isObject(metadata?.request) ? metadata.request : undefined;
    if (typeof request?.promptHash === "string" && request.promptHash.length > 0) {
      return request.promptHash;
    }
  }

  return undefined;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
