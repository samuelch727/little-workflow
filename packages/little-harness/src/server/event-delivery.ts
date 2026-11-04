import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { HarnessEvent, HarnessTurnMetadata } from "../types.js";

/** Where a turn's events go: the app's URL, and headers to send with each batch. */
export type TurnEventSink = {
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
};

/**
 * The turn an ending event is about: its Harness `turnId` (on each of its Harness events too) and
 * what the harness's `turnOptions` hook said about it. Absent when the turn ended before it started.
 */
export type EndedTurn = { readonly turnId?: string; readonly metadata?: HarnessTurnMetadata };

/**
 * One event of a turn as the server delivers it. `text-delta` carries the reply's text as it
 * streams (several model deltas joined); `turn.*` say how the turn ended; the rest are the
 * turn's Harness events as `onEvent` sees them.
 */
export type DeliveredTurnEvent =
  | { readonly type: "text-delta"; readonly text: string }
  | { readonly type: "turn.message"; readonly messageId: string; readonly dispatchId: string; readonly state: "accepted" | "claimed" | "read" | "unread"; readonly runId?: string; readonly stepNumber?: number; readonly occurrenceId?: string }
  /** `resumeId` when the caller continued the turn through `POST /sessions/:id/resume`. */
  | { readonly type: "turn.resumed"; readonly continuationId: string; readonly resumeId?: string }
  | ({ readonly type: "turn.finished"; readonly text: string } & EndedTurn)
  | ({ readonly type: "turn.parked"; readonly continuationId: string; readonly pending: unknown } & EndedTurn)
  | ({ readonly type: "turn.failed"; readonly error: string; readonly reason?: string } & EndedTurn)
  /** Messages staged for the turn that it ended before reading: send them as a new turn. */
  | { readonly type: "turn.unread"; readonly messages: readonly string[] }
  | { readonly type: "harness"; readonly event: HarnessEvent };

/** The Harness events worth sending: the turn's life, its model calls (with usage) and its tool calls. */
const DELIVERED = new Set([
  "harness.session.started",
  "harness.session.completed",
  "harness.session.failed",
  "harness.model.responded",
  "harness.model.failed",
  "harness.tool_call.started",
  "harness.tool_call.succeeded",
  "harness.tool_call.failed",
]);

export function deliversHarnessEvent(event: HarnessEvent): boolean {
  return DELIVERED.has(event.type);
}

export type TurnEventDelivery = {
  push(event: DeliveredTurnEvent): void;
  /** Sends what is buffered and waits for every batch to be delivered or given up on. */
  close(): Promise<void>;
};

/**
 * Sends one turn's events to its sink in batches, every `intervalMs` (text deltas in a batch are
 * joined), in order, each batch tried until it is accepted (a 2xx) or `attempts` run out. Each
 * batch is `{ sessionId, deliveryId, events }`. A turn's run has one `deliveryId` (a continued
 * turn gets a new one), and its events are numbered from 1 by `seq`, so the receiver can drop
 * repeats: delivery is at least once.
 */
export function createTurnEventDelivery(
  sink: TurnEventSink,
  context: {
    readonly sessionId: string;
    readonly log: (line: string) => void;
    readonly intervalMs?: number;
    readonly attempts?: number;
    readonly retryDelayMs?: number;
  },
): TurnEventDelivery {
  const intervalMs = context.intervalMs ?? 250;
  const attempts = context.attempts ?? 6;
  const retryDelayMs = context.retryDelayMs ?? 500;
  const deliveryId = randomUUID();
  let seq = 0;
  let buffer: Array<DeliveredTurnEvent & { seq: number }> = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sending: Promise<void> = Promise.resolve();

  const send = async (events: ReadonlyArray<DeliveredTurnEvent & { seq: number }>) => {
    const body = JSON.stringify({ sessionId: context.sessionId, deliveryId, events });
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const response = await fetch(sink.url, {
          method: "POST",
          headers: { ...sink.headers, "content-type": "application/json" },
          body,
        });
        if (response.ok) return;
        context.log(`[events] session ${context.sessionId}: ${sink.url} answered ${response.status} (try ${attempt} of ${attempts})`);
      } catch (error) {
        context.log(`[events] session ${context.sessionId}: sending failed (try ${attempt} of ${attempts}): ${error instanceof Error ? error.message : String(error)}`);
      }
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, retryDelayMs * 2 ** (attempt - 1)));
    }
    context.log(`[events] session ${context.sessionId}: gave up on events ${events[0]?.seq} to ${events.at(-1)?.seq}`);
  };

  const flush = () => {
    clearTimeout(timer);
    timer = undefined;
    if (buffer.length === 0) return;
    const batch = buffer;
    buffer = [];
    sending = sending.then(() => send(batch));
  };

  return {
    push(event) {
      const last = buffer.at(-1);
      if (event.type === "text-delta" && last?.type === "text-delta") {
        buffer[buffer.length - 1] = { ...last, text: last.text + event.text };
      } else {
        seq += 1;
        buffer.push({ ...event, seq });
      }
      const terminal = event.type === "turn.finished" || event.type === "turn.parked" || event.type === "turn.failed";
      if (terminal) flush();
      else timer ??= setTimeout(flush, intervalMs);
    },
    async close() {
      flush();
      await sending;
    },
  };
}

/** A parked turn's sink, kept on disk so the turn reports to the same place when it continues. */
export function parkedSinks(dataDir: string) {
  const dir = join(dataDir, "agent-server", "event-sinks");
  const file = (sessionId: string) => join(dir, `${encodeURIComponent(sessionId)}.json`);
  return {
    async save(sessionId: string, sink: TurnEventSink): Promise<void> {
      await mkdir(dir, { recursive: true });
      // The headers can hold the app's credentials: readable by this user only.
      await writeFile(file(sessionId), JSON.stringify(sink), { mode: 0o600 });
      await chmod(file(sessionId), 0o600);
    },
    async load(sessionId: string): Promise<TurnEventSink | undefined> {
      try {
        return JSON.parse(await readFile(file(sessionId), "utf8")) as TurnEventSink;
      } catch {
        return undefined;
      }
    },
    async remove(sessionId: string): Promise<void> {
      await rm(file(sessionId), { force: true });
    },
  };
}

/** A request's `events`: undefined when it sent none, null when what it sent is not a sink. */
export function sinkFrom(value: unknown): TurnEventSink | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { url, headers } = value as { url?: unknown; headers?: unknown };
  if (typeof url !== "string") return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  } catch {
    return null;
  }
  if (headers === undefined) return { url };
  if (typeof headers !== "object" || headers === null || Array.isArray(headers)) return null;
  const entries = Object.entries(headers);
  if (!entries.every(([, entry]) => typeof entry === "string")) return null;
  return { url, headers: Object.fromEntries(entries) as Record<string, string> };
}
