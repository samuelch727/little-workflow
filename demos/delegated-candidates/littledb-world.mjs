/**
 * Minimal littleDB tracing World — a drop-in Little Workflow `World` that commits
 * durably first (local SQLite event store) and then tees each committed event
 * envelope to the Rust littledb-engine's HTTP /ingest endpoint, best-effort.
 *
 * Mirrors the @little-workflow/littledb client's tee logic; inlined here so the
 * demo doesn't pull a cross-repo dependency (which would risk a second
 * `little-workflow` instance). It exercises the identical engine API, and adds
 * listRuns/loadTraceTree/search helpers so the run can verify ingestion.
 */

import { createLocalWorld } from "little-workflow";

function engineUrlFor(base, path) {
  return new URL(path, base.endsWith("/") ? base : `${base}/`);
}

function setParam(url, key, value) {
  if (value !== undefined) url.searchParams.set(key, String(value));
}

async function fetchJson(doFetch, url, notFoundAsNull = false) {
  const response = await doFetch(url.toString());
  if (notFoundAsNull && response.status === 404) return null;
  if (!response.ok) throw new Error(`littleDB query failed with HTTP ${response.status}`);
  return response.json();
}

/**
 * @param {{ dataDir?: string, engineUrl: string, fetchImpl?: typeof fetch, baseWorld?: object }} opts
 */
export function littledbWorld(opts) {
  const local = opts.baseWorld ?? createLocalWorld({ dataDir: opts.dataDir });
  const doFetch = opts.fetchImpl ?? fetch;
  const engineUrl = opts.engineUrl;
  const buffer = [];
  let draining = null;

  const drain = async () => {
    while (buffer.length > 0) {
      const batch = buffer.splice(0, buffer.length);
      try {
        const response = await doFetch(`${engineUrl}/ingest`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(batch),
        });
        if (!response.ok) {
          throw new Error(`littleDB ingest failed with HTTP ${response.status}`);
        }
      } catch {
        // Best-effort: drop. The engine is a derived store, rebuildable via backfill.
      }
    }
  };

  const scheduleDrain = () => {
    // Keep `draining` set until the in-flight drain settles so flushTee() can await it.
    draining ??= Promise.resolve()
      .then(() => drain())
      .finally(() => {
        draining = null;
      });
  };

  return {
    ...local,
    async appendEvent(runId, event) {
      const env = await local.appendEvent(runId, event); // DURABLE FIRST
      buffer.push(env); // tee AFTER commit
      scheduleDrain();
      return env;
    },
    async flushTee() {
      await (draining ?? Promise.resolve());
      await drain();
    },
    async listRuns(options = {}) {
      const url = engineUrlFor(engineUrl, "/runs");
      setParam(url, "label", options.label);
      if (options.tags?.length) setParam(url, "tags", options.tags.join(","));
      setParam(url, "status", options.status);
      setParam(url, "model", options.model);
      setParam(url, "limit", options.limit);
      return (await fetchJson(doFetch, url)) ?? [];
    },
    async loadTraceTree(rootRunId) {
      return fetchJson(doFetch, engineUrlFor(engineUrl, `/traces/${encodeURIComponent(String(rootRunId))}`), true);
    },
    async search(options = {}) {
      const url = engineUrlFor(engineUrl, "/search");
      setParam(url, "q", options.q);
      setParam(url, "json_key", options.jsonKey);
      setParam(url, "json_value", options.jsonValue);
      setParam(url, "limit", options.limit);
      return (await fetchJson(doFetch, url)) ?? [];
    },
  };
}
