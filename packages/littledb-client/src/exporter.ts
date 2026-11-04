import { ScoreSchema, SpanSchema, TraceSchema, type IngestBatch, type ScoreInput, type SpanInput, type TraceInput } from "./contract.js";
import { LittleDBError, type Transport } from "./http.js";

/** Something went wrong off the app's path: a dropped batch, a full queue, an unreachable server. */
export type LittleDBErrorHandler = (error: unknown, context: { readonly operation: string }) => void;

export type ExporterOptions = {
  readonly transport: Transport;
  /** Send what is queued at least this often. Default 1000 ms. */
  readonly flushIntervalMs?: number | undefined;
  /** Items (traces + spans + scores) per request. Default 500. */
  readonly maxBatch?: number | undefined;
  /** Items held in memory while LittleDB is slow or down; the oldest are dropped beyond it. Default 10 000. */
  readonly maxQueue?: number | undefined;
  /** Attempts per batch before it is dropped. Default 5. */
  readonly maxAttempts?: number | undefined;
  /** First retry delay; doubles each attempt, with jitter. Default 500 ms. */
  readonly retryBaseMs?: number | undefined;
  readonly onError: LittleDBErrorHandler;
  /** Test seam for the retry delay. */
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
};

export type ExporterStats = {
  /** Items waiting to be sent. */
  readonly queued: number;
  /** Items LittleDB accepted. */
  readonly sent: number;
  /** Items dropped: invalid, rejected by LittleDB, out of retries, or pushed out of a full queue. */
  readonly dropped: number;
};

export type Exporter = {
  /** Queue traces, spans and scores. Never throws and never waits on the network. */
  enqueue(batch: IngestBatch): void;
  /** Send everything queued so far (retrying as configured). Never throws. */
  flush(): Promise<void>;
  /** Flush, then stop the timer; later items are dropped. */
  shutdown(): Promise<void>;
  stats(): ExporterStats;
};

type Item =
  | { readonly kind: "trace"; readonly value: TraceInput }
  | { readonly kind: "span"; readonly value: SpanInput }
  | { readonly kind: "score"; readonly value: ScoreInput };

/**
 * The background half of the client: a bounded, ordered queue sent to `POST /v1/ingest` in
 * batches. Ingest is an upsert, so a batch whose response was lost can be sent again without
 * duplicating anything; that is what makes retrying safe.
 */
export function createExporter(options: ExporterOptions): Exporter {
  const flushIntervalMs = options.flushIntervalMs ?? 1_000;
  const maxBatch = Math.max(1, options.maxBatch ?? 500);
  const maxQueue = Math.max(maxBatch, options.maxQueue ?? 10_000);
  const maxAttempts = Math.max(1, options.maxAttempts ?? 5);
  const retryBaseMs = options.retryBaseMs ?? 500;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const queue: Item[] = [];
  let sent = 0;
  let dropped = 0;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let draining: Promise<void> | undefined;
  let overflowReported = false;

  const schedule = (delay: number) => {
    if (timer !== undefined || closed) return;
    timer = setTimeout(() => {
      timer = undefined;
      void drain();
    }, delay);
    // Tracing never keeps a process alive; call flush() or shutdown() before exiting.
    timer.unref?.();
  };

  const push = (item: Item) => {
    queue.push(item);
    if (queue.length > maxQueue) {
      const excess = queue.length - maxQueue;
      queue.splice(0, excess);
      dropped += excess;
      if (!overflowReported) {
        overflowReported = true;
        options.onError(new Error(`LittleDB ingest queue is full (${maxQueue} items); dropping the oldest.`), {
          operation: "ingest",
        });
      }
    }
  };

  const accept = (kind: Item["kind"], value: unknown): void => {
    const schema = kind === "trace" ? TraceSchema : kind === "span" ? SpanSchema : ScoreSchema;
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      dropped += 1;
      options.onError(
        new Error(`Dropped an invalid ${kind}: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`),
        { operation: "ingest" },
      );
      return;
    }
    // Keep the caller's value (dates as given), not the parsed copy.
    push({ kind, value } as Item);
  };

  async function sendBatch(items: readonly Item[]): Promise<void> {
    // LittleDB upserts each row once per request, so the same trace, span or score twice in one
    // batch (a span sent as running and then finished, a score sent again) is merged here first,
    // the way the server would merge them across requests.
    const traces = new Map<string, TraceInput>();
    const spans = new Map<string, SpanInput>();
    const scores = new Map<string, ScoreInput>();
    let anonymous = 0;
    for (const item of items) {
      if (item.kind === "trace") {
        const seen = traces.get(item.value.id);
        traces.set(item.value.id, seen === undefined ? item.value : mergeTrace(seen, item.value));
      } else if (item.kind === "span") {
        const key = `${item.value.traceId}\u0000${item.value.id}`;
        const seen = spans.get(key);
        spans.set(key, seen === undefined ? item.value : mergeSpan(seen, item.value));
      } else {
        scores.set(item.value.id ?? `\u0000${anonymous++}`, item.value);
      }
    }
    const body = {
      ...(traces.size === 0 ? {} : { traces: [...traces.values()] }),
      ...(spans.size === 0 ? {} : { spans: [...spans.values()] }),
      ...(scores.size === 0 ? {} : { scores: [...scores.values()] }),
    };
    for (let attempt = 1; ; attempt += 1) {
      try {
        await options.transport.request("POST", "/ingest", body);
        sent += items.length;
        overflowReported = false;
        return;
      } catch (error) {
        const retryable = !(error instanceof LittleDBError) || error.retryable;
        if (!retryable || attempt >= maxAttempts) {
          dropped += items.length;
          options.onError(error, { operation: "ingest" });
          return;
        }
        const delay = retryBaseMs * 2 ** (attempt - 1);
        await sleep(delay / 2 + Math.random() * (delay / 2));
      }
    }
  }

  function drain(): Promise<void> {
    if (draining !== undefined) return draining;
    // Nothing to send. (A drain that started on an empty queue used to finish before it was
    // stored, so it stayed stored: later sends never started and `flush()` spun on it forever.)
    if (queue.length === 0) return Promise.resolve();
    // A `finally` callback always runs on a later tick, so it clears what was stored here.
    draining = sendQueued().finally(() => {
      draining = undefined;
    });
    return draining;
  }

  async function sendQueued(): Promise<void> {
    while (queue.length > 0) {
      await sendBatch(queue.splice(0, maxBatch));
    }
  }

  return {
    enqueue(batch) {
      if (closed) {
        const count = (batch.traces?.length ?? 0) + (batch.spans?.length ?? 0) + (batch.scores?.length ?? 0);
        dropped += count;
        return;
      }
      try {
        for (const trace of batch.traces ?? []) accept("trace", trace);
        for (const span of batch.spans ?? []) accept("span", span);
        for (const score of batch.scores ?? []) accept("score", score);
      } catch (error) {
        options.onError(error, { operation: "ingest" });
      }
      if (queue.length >= maxBatch) {
        if (timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
        }
        void drain();
      } else if (queue.length > 0) {
        schedule(flushIntervalMs);
      }
    },
    async flush() {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      // An in-flight drain may finish before items queued after it started; drain until empty.
      while (draining !== undefined || queue.length > 0) {
        await drain();
      }
    },
    async shutdown() {
      await this.flush();
      closed = true;
    },
    stats() {
      return { queued: queue.length, sent, dropped };
    },
  };
}

/** A later trace row over an earlier one: set fields win, metadata merges, tags add up. */
function mergeTrace(earlier: TraceInput, later: TraceInput): TraceInput {
  const merged: TraceInput = { ...earlier, ...later };
  if (earlier.metadata !== undefined || later.metadata !== undefined) merged.metadata = { ...earlier.metadata, ...later.metadata };
  if (earlier.tags !== undefined || later.tags !== undefined) merged.tags = [...new Set([...(earlier.tags ?? []), ...(later.tags ?? [])])];
  return merged;
}

/** A later state of a span over an earlier one: set fields win, attributes merge. */
function mergeSpan(earlier: SpanInput, later: SpanInput): SpanInput {
  const merged: SpanInput = { ...earlier, ...later };
  if (earlier.attributes !== undefined || later.attributes !== undefined) merged.attributes = { ...earlier.attributes, ...later.attributes };
  return merged;
}
