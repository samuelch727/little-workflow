import { createLocalWorld, type World, type EventEnvelope, type EventInput, type RunId } from "little-workflow";
import { usageWithCostUsd } from "./cost.js";

export interface RunSummary {
  run_id: string;
  root_run_id?: string;
  label?: string | null;
  tags?: string[];
  status?: string | null;
  started_at?: string;
  input_tokens?: number;
  output_tokens?: number;
  cost_usd?: number;
  model_id?: string | null;
}

export interface RunDetail {
  summary: RunSummary;
  events: unknown[];
}

export interface TraceNode {
  run: RunSummary;
  events: unknown[];
  children: TraceNode[];
}

export interface ListRunsOptions {
  from?: string;
  to?: string;
  label?: string;
  tags?: string[];
  status?: string;
  model?: string;
  limit?: number;
}

export interface SearchOptions {
  q?: string;
  jsonKey?: string;
  jsonValue?: string;
  limit?: number;
}

export interface LittleDbOptions {
  dataDir: string;
  engineUrl: string;
  fetchImpl?: typeof fetch;
}

export type LittleDbWorld = World & {
  flushTee(): Promise<void>;
  listRuns(options?: ListRunsOptions): Promise<RunSummary[]>;
  loadRun(runId: RunId | string): Promise<RunDetail | null>;
  loadTraceTree(rootRunId: RunId | string): Promise<TraceNode | null>;
  search(options: SearchOptions): Promise<RunSummary[]>;
};

/**
 * The teed copy of a durable envelope, priced for littleDB's engine.
 *
 * The World's event log is token-only (`assertUsage` rejects `costUsd` outright), so a
 * teed `harness.model.responded` otherwise lands in littleDB with `cost_usd = 0` and the
 * cost-delta gate reports `no-cost-recorded` however much traffic ran. The tee is an
 * export materialization exactly like the harness reporter, so the dollars are added
 * here — never to the envelope itself, which is what `appendEvent` durably committed and
 * hands back to the caller. Every level touched is copied.
 *
 * Only `payload.response.usage.costUsd` is stamped: littleDB sums `cost_usd` per event
 * over a run, so any second copy of the figure would double-count it.
 */
function envelopeForTee(env: EventEnvelope): EventEnvelope {
  if (env.type !== "harness.model.responded") {
    return env;
  }
  const payload = env.payload as Record<string, unknown>;
  const response = payload.response;
  if (typeof response !== "object" || response === null || Array.isArray(response)) {
    return env;
  }
  const usage = (response as Record<string, unknown>).usage;
  if (usage === undefined) {
    return env;
  }
  const priced = usageWithCostUsd(payload.model, usage);
  if (priced === usage) {
    return env;
  }
  return {
    ...env,
    payload: { ...payload, response: { ...(response as Record<string, unknown>), usage: priced } },
  } as EventEnvelope;
}

function engineUrl(base: string, path: string): URL {
  return new URL(path, base.endsWith("/") ? base : `${base}/`);
}

function setParam(url: URL, key: string, value: string | number | undefined): void {
  if (value !== undefined) {
    url.searchParams.set(key, String(value));
  }
}

async function fetchJson<T>(doFetch: typeof fetch, url: URL, notFoundAsNull = false): Promise<T | null> {
  const response = await doFetch(url.toString());
  if (notFoundAsNull && response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`littleDB query failed with HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

export function littleDB(opts: LittleDbOptions): LittleDbWorld {
  const local = createLocalWorld({ dataDir: opts.dataDir });
  const doFetch = opts.fetchImpl ?? fetch;
  const buffer: unknown[] = [];
  let draining: Promise<void> | null = null;

  const drain = async (): Promise<void> => {
    while (buffer.length > 0) {
      const batch = buffer.splice(0, buffer.length);
      try {
        const response = await doFetch(`${opts.engineUrl}/ingest`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(batch),
        });
        if (!response.ok) {
          throw new Error(`littleDB ingest failed with HTTP ${response.status}`);
        }
      } catch {
        // best-effort: drop. Engine is rebuildable via backfill.
      }
    }
  };

  const scheduleDrain = (): void => {
    // Keep `draining` set until the drain (incl. its in-flight fetch) settles,
    // so flushTee() can reliably await an in-progress tee. Cleared in finally.
    draining ??= Promise.resolve()
      .then(() => drain())
      .finally(() => {
        draining = null;
      });
  };

  return {
    ...local,
    async appendEvent(runId: RunId, event: EventInput) {
      const env = await local.appendEvent(runId, event); // DURABLE FIRST
      buffer.push(envelopeForTee(env)); // tee AFTER commit, priced for the engine
      scheduleDrain();
      return env; // the durable envelope, returned exactly as committed
    },
    async flushTee() {
      await (draining ?? Promise.resolve());
      await drain();
    },
    async listRuns(options: ListRunsOptions = {}) {
      const url = engineUrl(opts.engineUrl, "/runs");
      setParam(url, "from", options.from);
      setParam(url, "to", options.to);
      setParam(url, "label", options.label);
      if (options.tags !== undefined && options.tags.length > 0) {
        setParam(url, "tags", options.tags.join(","));
      }
      setParam(url, "status", options.status);
      setParam(url, "model", options.model);
      setParam(url, "limit", options.limit);
      return (await fetchJson<RunSummary[]>(doFetch, url)) ?? [];
    },
    async loadRun(runId: RunId | string) {
      const url = engineUrl(opts.engineUrl, `/runs/${encodeURIComponent(String(runId))}`);
      return await fetchJson<RunDetail>(doFetch, url, true);
    },
    async loadTraceTree(rootRunId: RunId | string) {
      const url = engineUrl(opts.engineUrl, `/traces/${encodeURIComponent(String(rootRunId))}`);
      return await fetchJson<TraceNode>(doFetch, url, true);
    },
    async search(options: SearchOptions) {
      const url = engineUrl(opts.engineUrl, "/search");
      setParam(url, "q", options.q);
      setParam(url, "json_key", options.jsonKey);
      setParam(url, "json_value", options.jsonValue);
      setParam(url, "limit", options.limit);
      return (await fetchJson<RunSummary[]>(doFetch, url)) ?? [];
    },
  };
}
