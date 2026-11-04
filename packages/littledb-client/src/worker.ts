import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { ClaimResponseSchema, type ClaimedPin, type ClaimedRun, type CompleteRun, type SubjectKind } from "./contract.js";
import { runInEvalContext } from "./eval-context.js";
import type { Exporter, LittleDBErrorHandler } from "./exporter.js";
import { LittleDBError, type Transport } from "./http.js";

/** A harness or workflow whose experiments this worker runs: `harness:<slug>`, `workflow:<slug>`, a subject id, or `{ kind, slug }`. */
export type EvalSubject = string | { readonly kind: SubjectKind; readonly slug: string };

/** One experiment run: a version of the subject on one dataset item. */
export type EvalRun = {
  readonly runId: string;
  readonly experimentId: string;
  /** Send this run's spans to this trace; `trace` has it with the rest of the tags. */
  readonly traceId: string;
  readonly repetition: number;
  readonly leaseUntil: string;
  readonly subject: { readonly kind: SubjectKind; readonly slug: string } | null;
  /** The version to run: its `content` is what `resolve` would return for it (e.g. `{ system, model }`). */
  readonly version: ClaimedRun["version"];
  /** The dataset item: `input` to run on, `expected` to grade against. */
  readonly item: ClaimedRun["item"];
  /**
   * Agents and workflows this run must use instead of their live versions: the fix being tested
   * inside the workflow that calls it. Inside `run`, `db.resolve` (and so a managed harness) of a
   * pinned subject returns its pinned version, so you need not read this.
   */
  readonly pins: readonly ClaimedPin[];
  /** Aborted when `stop()` gives up waiting or LittleDB handed the run to another worker. */
  readonly signal: AbortSignal;
  /**
   * Spread into `harnessTracer(...)` or `tracingWorld(...)` options, so the run's spans land in
   * the run's trace, tagged with the experiment, item and version.
   */
  readonly trace: {
    readonly traceId: string;
    readonly versionId?: string;
    readonly environment: "experiment";
    readonly experimentId: string;
    readonly datasetItemId?: string;
  };
};

/** What a run returns: its output, and scores LittleDB stores on the run's trace (source `code`). */
export type EvalResult = {
  readonly output?: unknown;
  readonly scores?: CompleteRun["scores"];
};

export type EvalWorkerOptions = {
  /** Which subjects' experiments to run. A worker only claims runs it knows how to run. */
  readonly subjects: readonly EvalSubject[];
  /** Run one experiment run. Throw to fail it (LittleDB retries a failed run up to 3 attempts). */
  readonly run: (run: EvalRun) => Promise<EvalResult | void>;
  /** Runs at once. Default 1. */
  readonly concurrency?: number | undefined;
  /** How often to ask for work when there was none. Default 2 s. */
  readonly pollIntervalMs?: number | undefined;
  /** How long a claim lasts without a heartbeat; heartbeats go every third of it. Default 5 min. */
  readonly leaseMs?: number | undefined;
  /** Shown in LittleDB as the run's claimant. Default `<hostname>-<random>`. */
  readonly workerId?: string | undefined;
};

export type EvalWorkerSummary = { readonly claimed: number; readonly completed: number; readonly failed: number };

export type EvalWorker = {
  /** Poll for runs until `stop()`. Resolves once stopped. */
  start(): Promise<void>;
  /** Stop claiming, wait for runs in flight (aborting them after `graceMs`, default 60 s). */
  stop(options?: { readonly graceMs?: number }): Promise<void>;
  /** Claim up to `concurrency` runs once, run them, and report. For scripts and tests. */
  runOnce(): Promise<EvalWorkerSummary>;
};

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });

const isLeaseLost = (error: unknown) => error instanceof LittleDBError && error.code === "lease_lost";

function subjectRef(subject: EvalSubject): string {
  return typeof subject === "string" ? subject : `${subject.kind}:${subject.slug}`;
}

/**
 * Runs LittleDB experiments inside your app, which owns the tools and the model keys: claim a
 * run, run the version on the item, flush its trace, complete it with output and scores.
 */
export function createEvalWorker(
  options: EvalWorkerOptions,
  deps: { readonly transport: Transport; readonly exporter: Exporter; readonly onError: LittleDBErrorHandler },
): EvalWorker {
  if (options.subjects.length === 0) throw new TypeError("evalWorker needs at least one subject.");
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? 1));
  const pollIntervalMs = options.pollIntervalMs ?? 2_000;
  const leaseMs = Math.max(10_000, options.leaseMs ?? 300_000);
  const workerId = options.workerId ?? `${hostname()}-${randomUUID().slice(0, 8)}`;
  const subjects = options.subjects.map(subjectRef);
  const inFlight = new Map<string, { readonly done: Promise<boolean>; readonly abort: AbortController }>();
  let stopping: AbortController | undefined;
  let loop: Promise<void> | undefined;

  async function claim(limit: number): Promise<readonly ClaimedRun[]> {
    try {
      const raw = await deps.transport.request("POST", "/worker/claim", { workerId, subjects, limit, leaseMs });
      return ClaimResponseSchema.parse(raw).runs;
    } catch (error) {
      deps.onError(error, { operation: "worker.claim" });
      return [];
    }
  }

  /** Report a run. Resolves `false` when LittleDB handed the run to another worker, so this report was dropped. */
  async function complete(runId: string, body: CompleteRun): Promise<boolean> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await deps.transport.request("POST", `/worker/runs/${encodeURIComponent(runId)}/complete`, body);
        return true;
      } catch (error) {
        if (isLeaseLost(error)) return false;
        const retryable = !(error instanceof LittleDBError) || error.retryable;
        if (!retryable || attempt >= 4) {
          // The lease lapses and LittleDB hands the run out again.
          deps.onError(error, { operation: "worker.complete" });
          return true;
        }
        await sleep(500 * 2 ** (attempt - 1));
      }
    }
  }

  /** Run one claimed run to completion. Resolves `true` when it completed without an error. */
  async function execute(claimed: ClaimedRun): Promise<boolean> {
    const abort = new AbortController();
    let leaseLost = false;
    const loseLease = () => {
      leaseLost = true;
      abort.abort(new Error("LittleDB handed this run to another worker."));
    };
    // Every heartbeat and the completion name this claim, so LittleDB refuses them once the run is another worker's.
    const claim = { workerId, ...(claimed.attempt === undefined ? {} : { attempt: claimed.attempt }) };
    const heartbeat = setInterval(() => {
      void deps.transport
        .request("POST", `/worker/runs/${encodeURIComponent(claimed.runId)}/heartbeat`, claim)
        .catch((error: unknown) => {
          if (isLeaseLost(error)) {
            loseLease();
          } else {
            deps.onError(error, { operation: "worker.heartbeat" });
          }
        });
    }, Math.max(1_000, Math.floor(leaseMs / 3)));
    heartbeat.unref?.();
    const run: EvalRun = {
      runId: claimed.runId,
      experimentId: claimed.experimentId,
      traceId: claimed.traceId,
      repetition: claimed.repetition,
      leaseUntil: claimed.leaseUntil,
      subject: claimed.subject,
      version: claimed.version,
      item: claimed.item,
      pins: claimed.pins ?? [],
      signal: abort.signal,
      trace: {
        traceId: claimed.traceId,
        ...(claimed.version?.id === undefined ? {} : { versionId: claimed.version.id }),
        environment: "experiment",
        experimentId: claimed.experimentId,
        ...(claimed.item?.id === undefined ? {} : { datasetItemId: claimed.item.id }),
      },
    };
    const entry = { abort, done: Promise.resolve(false) };
    inFlight.set(claimed.runId, entry);
    try {
      let result: EvalResult | void = undefined;
      let failure: unknown;
      try {
        // Everything the run calls sees its pins and traces as experiment traffic (eval-context.ts).
        // The run's own subject is pinned to the run's version, so a managed harness runs the candidate.
        const self: ClaimedPin[] =
          claimed.subject !== null && claimed.version !== null
            ? [
                {
                  kind: claimed.subject.kind,
                  slug: claimed.subject.slug,
                  versionId: claimed.version.id,
                  content: claimed.version.content,
                  ...(claimed.version.model === undefined ? {} : { model: claimed.version.model }),
                },
              ]
            : [];
        result = await runInEvalContext(
          {
            runId: claimed.runId,
            experimentId: claimed.experimentId,
            traceId: claimed.traceId,
            subject: claimed.subject,
            trace: run.trace,
            pins: [...self, ...run.pins.filter((pin) => !self.some((s) => s.kind === pin.kind && s.slug === pin.slug))],
          },
          () => options.run(run),
        );
      } catch (error) {
        failure = error;
      }
      clearInterval(heartbeat);
      if (leaseLost) return false;
      // The trace must be in LittleDB before the run is marked done.
      await deps.exporter.flush();
      if (failure !== undefined) {
        const message = failure instanceof Error ? failure.message || failure.name : String(failure);
        if (!(await complete(claimed.runId, { ...claim, traceId: claimed.traceId, error: message.slice(0, 10_000) }))) loseLease();
        return false;
      }
      const reported = await complete(claimed.runId, {
        ...claim,
        traceId: claimed.traceId,
        ...(result?.output === undefined ? {} : { output: result.output }),
        ...(result?.scores === undefined ? {} : { scores: result.scores }),
      });
      // LittleDB dropped the result: the run is another worker's.
      if (!reported) loseLease();
      return reported;
    } finally {
      clearInterval(heartbeat);
      inFlight.delete(claimed.runId);
    }
  }

  function track(claimed: ClaimedRun): Promise<boolean> {
    const done = execute(claimed).catch((error: unknown) => {
      deps.onError(error, { operation: "worker.run" });
      return false;
    });
    const entry = inFlight.get(claimed.runId);
    if (entry !== undefined) inFlight.set(claimed.runId, { ...entry, done });
    return done;
  }

  return {
    start() {
      if (loop !== undefined) return loop;
      stopping = new AbortController();
      const signal = stopping.signal;
      loop = (async () => {
        while (!signal.aborted) {
          const free = concurrency - inFlight.size;
          if (free <= 0) {
            await Promise.race([...inFlight.values()].map((entry) => entry.done));
            continue;
          }
          const runs = await claim(free);
          if (signal.aborted && runs.length === 0) break;
          for (const claimed of runs) void track(claimed);
          if (runs.length === 0) await sleep(pollIntervalMs, signal);
        }
      })().finally(() => {
        loop = undefined;
      });
      return loop;
    },

    async stop(stopOptions = {}) {
      stopping?.abort();
      await loop;
      const pending = [...inFlight.values()];
      if (pending.length === 0) return;
      const graceMs = stopOptions.graceMs ?? 60_000;
      const settled = Promise.allSettled(pending.map((entry) => entry.done));
      const timedOut = await Promise.race([settled.then(() => false), sleep(graceMs).then(() => true)]);
      if (timedOut) {
        for (const entry of pending) entry.abort.abort(new Error("The eval worker stopped."));
        await settled;
      }
    },

    async runOnce() {
      const runs = await claim(concurrency);
      const results = await Promise.all(runs.map((claimed) => track(claimed)));
      const completed = results.filter(Boolean).length;
      return { claimed: runs.length, completed, failed: runs.length - completed };
    },
  };
}
