import { describe, expect, it, vi } from "vitest";
import { createLittleDB, scoreId } from "./client.js";
import { createExporter } from "./exporter.js";
import { LittleDBError, apiBase, createTransport } from "./http.js";
import { createResolver } from "./resolve.js";
import { fakeLittleDB } from "./test/fake-littledb.js";
import { toLittleDBUsage } from "./util.js";

const at = "2026-10-01T00:00:00.000Z";

describe("transport", () => {
  it("accepts the server URL with or without /v1", () => {
    expect(apiBase("http://h:7340")).toBe("http://h:7340/v1");
    expect(apiBase("http://h:7340/")).toBe("http://h:7340/v1");
    expect(apiBase("http://h:7340/v1/")).toBe("http://h:7340/v1");
    expect(() => apiBase("  ")).toThrow(TypeError);
  });

  it("sends the key as a bearer token and maps LittleDB errors", async () => {
    const fake = fakeLittleDB();
    const transport = createTransport({ url: fake.url, apiKey: fake.apiKey, fetch: fake.fetch });
    const error = await transport.request("GET", "/nope").catch((e: unknown) => e);
    expect(fake.requests[0]?.authorization).toBe(`Bearer ${fake.apiKey}`);
    expect(error).toBeInstanceOf(LittleDBError);
    expect(error).toMatchObject({ status: 404, code: "not_found", retryable: false });
    expect(String((error as Error).message)).not.toContain(fake.apiKey);
  });

  it("reports a connection failure as a retryable network error", async () => {
    const transport = createTransport({
      url: "http://x",
      apiKey: "ldb_secret",
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    });
    const error = (await transport.request("POST", "/ingest", {}).catch((e: unknown) => e)) as LittleDBError;
    expect(error).toMatchObject({ status: 0, code: "network", retryable: true });
    expect(error.message).not.toContain("ldb_secret");
  });
});

describe("exporter", () => {
  const trace = (id: string) => ({ id, startTime: at });

  it("sends queued items in batches of maxBatch, in order", async () => {
    const fake = fakeLittleDB();
    const transport = createTransport({ url: fake.url, apiKey: fake.apiKey, fetch: fake.fetch });
    const exporter = createExporter({ transport, onError: () => {}, maxBatch: 2, flushIntervalMs: 60_000 });
    exporter.enqueue({ traces: [trace("t1")] });
    exporter.enqueue({ traces: [trace("t2"), trace("t3")] });
    await exporter.flush();
    exporter.enqueue({ scores: [{ traceId: "t1", name: "ok", value: 1 }] });
    await exporter.flush();
    expect(fake.ingestBatches.length).toBeGreaterThanOrEqual(2);
    expect([...fake.traces.keys()]).toEqual(["t1", "t2", "t3"]);
    expect(exporter.stats()).toEqual({ queued: 0, sent: 4, dropped: 0 });
  });

  it("retries a batch LittleDB could not take, then sends it", async () => {
    const fake = fakeLittleDB();
    let failures = 2;
    fake.override((request) => (request.path === "/v1/ingest" && failures-- > 0 ? { status: 503, body: { error: { code: "unavailable", message: "busy" } } } : undefined));
    const transport = createTransport({ url: fake.url, apiKey: fake.apiKey, fetch: fake.fetch });
    const sleep = vi.fn(async () => {});
    const exporter = createExporter({ transport, onError: () => {}, sleep });
    exporter.enqueue({ traces: [trace("t1")] });
    await exporter.flush();
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(fake.traces.has("t1")).toBe(true);
  });

  it("drops a batch LittleDB rejects, and invalid items before sending, and says so", async () => {
    const fake = fakeLittleDB();
    fake.override((request) => (request.path === "/v1/ingest" ? { status: 400, body: { error: { code: "bad_request", message: "no" } } } : undefined));
    const transport = createTransport({ url: fake.url, apiKey: fake.apiKey, fetch: fake.fetch });
    const onError = vi.fn();
    const exporter = createExporter({ transport, onError });
    exporter.enqueue({ traces: [trace("t1")], scores: [{ traceId: "t1", name: "no value" } as never] });
    await exporter.flush();
    expect(exporter.stats()).toEqual({ queued: 0, sent: 0, dropped: 2 });
    expect(onError).toHaveBeenCalledTimes(2);
    expect(onError.mock.calls.every(([, context]) => context.operation === "ingest")).toBe(true);
  });

  it("keeps the newest items when the queue overflows", async () => {
    const fake = fakeLittleDB();
    const transport = createTransport({ url: fake.url, apiKey: fake.apiKey, fetch: fake.fetch });
    const onError = vi.fn();
    const exporter = createExporter({ transport, onError, maxBatch: 10, maxQueue: 10, flushIntervalMs: 60_000 });
    // Each enqueue below maxBatch waits for the timer; push 12 in one call to overflow.
    exporter.enqueue({ traces: Array.from({ length: 12 }, (_, i) => trace(`t${i}`)) });
    await exporter.flush();
    expect(exporter.stats().dropped).toBe(2);
    expect(fake.traces.has("t0")).toBe(false);
    expect(fake.traces.has("t11")).toBe(true);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("merges repeats of one trace, span or score in a batch, since LittleDB upserts a row once per request", async () => {
    const fake = fakeLittleDB();
    const transport = createTransport({ url: fake.url, apiKey: fake.apiKey, fetch: fake.fetch });
    const exporter = createExporter({ transport, onError: () => {}, flushIntervalMs: 60_000 });
    exporter.enqueue({
      traces: [{ id: "t1", startTime: at, tags: ["a"], metadata: { x: 1 } }],
      spans: [{ traceId: "t1", id: "s1", name: "turn", status: "running", startTime: at, attributes: { a: 1 } }],
      scores: [{ id: "sc1", traceId: "t1", name: "ok", value: 0 }],
    });
    exporter.enqueue({
      traces: [{ id: "t1", startTime: at, userId: "u", tags: ["b"], metadata: { y: 2 } }],
      spans: [{ traceId: "t1", id: "s1", name: "turn", status: "ok", startTime: at, endTime: at, output: "done", attributes: { b: 2 } }],
      scores: [{ id: "sc1", traceId: "t1", name: "ok", value: 1 }],
    });
    await exporter.flush();
    expect(fake.ingestBatches).toEqual([
      {
        traces: [{ id: "t1", startTime: at, userId: "u", tags: ["a", "b"], metadata: { x: 1, y: 2 } }],
        spans: [{ traceId: "t1", id: "s1", name: "turn", status: "ok", startTime: at, endTime: at, output: "done", attributes: { a: 1, b: 2 } }],
        scores: [{ id: "sc1", traceId: "t1", name: "ok", value: 1 }],
      },
    ]);
    expect(exporter.stats().sent).toBe(6);
  });

  it("keeps sending after a scheduled send finds the queue already empty", async () => {
    const fake = fakeLittleDB();
    const transport = createTransport({ url: fake.url, apiKey: fake.apiKey, fetch: fake.fetch });
    const exporter = createExporter({ transport, onError: () => {}, flushIntervalMs: 5 });
    exporter.enqueue({ traces: [trace("t1")] });
    const flushing = exporter.flush();
    exporter.enqueue({ traces: [trace("t2")] }); // schedules a send for later
    await flushing; // sends both
    await new Promise((resolve) => setTimeout(resolve, 20)); // the scheduled send finds nothing to do
    exporter.enqueue({ traces: [trace("t3")] });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect([...fake.traces.keys()]).toEqual(["t1", "t2", "t3"]);
    await exporter.flush(); // returns: before the fix it spun forever on a finished drain
  });

  it("drops items after shutdown", async () => {
    const fake = fakeLittleDB();
    const transport = createTransport({ url: fake.url, apiKey: fake.apiKey, fetch: fake.fetch });
    const exporter = createExporter({ transport, onError: () => {} });
    await exporter.shutdown();
    exporter.enqueue({ traces: [trace("late")] });
    await exporter.flush();
    expect(fake.traces.size).toBe(0);
    expect(exporter.stats().dropped).toBe(1);
  });
});

describe("resolve", () => {
  it("returns the live version, makes the bootstrap v1, and caches the answer", async () => {
    const fake = fakeLittleDB();
    const db = createLittleDB({ url: fake.url, apiKey: fake.apiKey, fetch: fake.fetch });
    const bootstrap = { system: "Be kind.", model: "fast" };
    const first = await db.resolve({ kind: "harness", slug: "support", stickyKey: "s1", bootstrap });
    const second = await db.resolve({ kind: "harness", slug: "support", stickyKey: "s1", bootstrap });
    expect(first).toMatchObject({ versionId: "ver_support_1", mode: "live", content: bootstrap, channel: "production" });
    expect(second).toBe(first);
    expect(fake.requests.filter((r) => r.path === "/v1/resolve")).toHaveLength(1);
    expect(fake.requests[0]?.body).toMatchObject({ kind: "harness", slug: "support", stickyKey: "s1", bootstrap });
  });

  it("falls back to the last answer, then to the bootstrap, when LittleDB is down", async () => {
    const fake = fakeLittleDB();
    const transport = createTransport({ url: fake.url, apiKey: fake.apiKey, fetch: fake.fetch });
    const onError = vi.fn();
    const resolver = createResolver({ transport, onError, cacheTtlMs: 0 });
    const live = await resolver.resolve({ kind: "harness", slug: "a", bootstrap: { system: "x" } });
    expect(live.fallback).toBeUndefined();
    fake.override(() => ({ status: 503, body: { error: { code: "unavailable", message: "down" } } }));
    resolver.clear();
    const lastKnown = await resolver.resolve({ kind: "harness", slug: "a", bootstrap: { system: "x" } });
    expect(lastKnown).toMatchObject({ fallback: "last_known", versionId: live.versionId, content: { system: "x" } });
    const fresh = await resolver.resolve({ kind: "harness", slug: "b", bootstrap: { system: "y" } });
    expect(fresh).toMatchObject({ fallback: "bootstrap", versionId: null, mode: "none", content: { system: "y" } });
    expect(onError).toHaveBeenCalledWith(expect.any(LittleDBError), { operation: "resolve" });
  });

  it("keeps a sticky key on the version it got, and asks again for a new key", async () => {
    const fake = fakeLittleDB();
    const db = createLittleDB({ url: fake.url, apiKey: fake.apiKey, fetch: fake.fetch });
    fake.setResolution({ subjectId: "sub", versionId: "ver_2", number: 2, status: "trial", mode: "trial", content: { system: "new" }, channel: "production" });
    const trial = await db.resolve({ kind: "harness", slug: "s", stickyKey: "session-1" });
    fake.setResolution({ subjectId: "sub", versionId: "ver_1", number: 1, status: "live", mode: "live", content: { system: "old" }, channel: "production" });
    expect(await db.resolve({ kind: "harness", slug: "s", stickyKey: "session-1" })).toBe(trial);
    expect((await db.resolve({ kind: "harness", slug: "s", stickyKey: "session-2" })).versionId).toBe("ver_1");
  });
});

describe("score", () => {
  it("derives a stable id so a retried score updates instead of duplicating", async () => {
    const fake = fakeLittleDB();
    const db = createLittleDB({ url: fake.url, apiKey: fake.apiKey, fetch: fake.fetch });
    const a = db.score({ traceId: "t1", name: "task_success", value: 1 });
    const b = db.score({ traceId: "t1", name: "task_success", value: 0, comment: "regraded" });
    expect(a).toBe(b);
    expect(a).toBe(scoreId("t1", undefined, "task_success", "app"));
    expect(db.score({ traceId: "t1", name: "task_success", value: 1, source: "judge" })).not.toBe(a);
    await db.flush();
    expect(fake.scores.get(a)).toMatchObject({ value: 0, comment: "regraded", source: "app" });
    await db.shutdown();
  });

  it("refuses to start without an API key", () => {
    expect(() => createLittleDB({ url: "http://x", apiKey: "" })).toThrow(/apiKey/);
  });

  it("warns at most once a minute per operation by default, without the key", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const db = createLittleDB({
        url: "http://x",
        apiKey: "ldb_hidden",
        fetch: async () => {
          throw new TypeError("connect ECONNREFUSED");
        },
      });
      await db.resolve({ kind: "harness", slug: "a" });
      await db.resolve({ kind: "harness", slug: "b" });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain("resolve");
      expect(String(warn.mock.calls[0]?.[0])).not.toContain("ldb_hidden");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("usage", () => {
  it("takes cache reads and writes out of the AI SDK's input total", () => {
    expect(
      toLittleDBUsage({ inputTokens: 1000, outputTokens: 50, inputTokenDetails: { noCacheTokens: 100, cacheReadTokens: 800, cacheWriteTokens: 100 } }),
    ).toEqual({ inputTokens: 100, outputTokens: 50, cacheReadTokens: 800, cacheWriteTokens: 100 });
    expect(toLittleDBUsage({ inputTokens: 1000, outputTokens: 5, cachedInputTokens: 600 })).toEqual({
      inputTokens: 400,
      outputTokens: 5,
      cacheReadTokens: 600,
    });
    expect(toLittleDBUsage(undefined)).toBeUndefined();
  });
});
