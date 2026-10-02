import { afterEach, describe, it, expect, vi } from "vitest";
import { closeEventStoresForTest } from "little-workflow";
import { littleDB } from "./index.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

afterEach(() => {
  closeEventStoresForTest();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("Tracing World", () => {
  it("commits locally and tees committed events; survives engine being down", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "tracing-"));
    const fetchMock = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const world = littleDB({ dataDir, engineUrl: "http://localhost:7878", fetchImpl: fetchMock });
    const env = await world.appendEvent("run_a", { type: "RunStarted", payload: { workflowVersionId: "wv_1" } });
    expect(env.sequence).toBe(1);            // local commit succeeded
    await world.flushTee();                  // drain the tee buffer
    expect(fetchMock).toHaveBeenCalled();    // tee attempted
    const events = await world.listEvents("run_a");
    expect(events).toHaveLength(1);          // engine-down did NOT break local append
  });

  it("continues draining events appended while a tee request is in flight", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "tracing-"));
    const first = deferred<Response>();
    const second = deferred<Response>();
    const fetchMock = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const world = littleDB({
      dataDir,
      engineUrl: "http://localhost:7878",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await world.appendEvent("run_a", { type: "RunStarted", payload: { workflowVersionId: "wv_1" } });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    await world.appendEvent("run_a", { type: "RunCompleted", payload: { output: 1 } });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    first.resolve(new Response(null, { status: 202 }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    second.resolve(new Response(null, { status: 202 }));
    await world.flushTee();
  });

  it("exposes run and search query helpers over the engine HTTP API", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "tracing-"));
    const seen: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      seen.push(`${url.pathname}${url.search}`);
      if (url.pathname === "/runs") {
        return Response.json([{ run_id: "run_a", model_id: "gpt-4" }]);
      }
      if (url.pathname === "/runs/run_a") {
        return Response.json({ summary: { run_id: "run_a" }, events: [] });
      }
      if (url.pathname === "/traces/root_a") {
        return Response.json({ run: { run_id: "root_a" }, events: [], children: [] });
      }
      if (url.pathname === "/search") {
        return Response.json([{ run_id: "run_search" }]);
      }
      return new Response(null, { status: 404 });
    });
    const world = littleDB({
      dataDir,
      engineUrl: "http://localhost:7878/",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await expect(world.listRuns({ model: "gpt-4", tags: ["alpha", "beta"], limit: 5 })).resolves.toEqual([
      { run_id: "run_a", model_id: "gpt-4" },
    ]);
    await expect(world.loadRun("run_a")).resolves.toEqual({ summary: { run_id: "run_a" }, events: [] });
    await expect(world.loadTraceTree("root_a")).resolves.toEqual({ run: { run_id: "root_a" }, events: [], children: [] });
    await expect(world.search({ q: "needle", jsonKey: "language", jsonValue: "English", limit: 2 })).resolves.toEqual([
      { run_id: "run_search" },
    ]);

    expect(seen).toEqual([
      "/runs?tags=alpha%2Cbeta&model=gpt-4&limit=5",
      "/runs/run_a",
      "/traces/root_a",
      "/search?q=needle&json_key=language&json_value=English&limit=2",
    ]);
  });

  it("prices teed model responses without touching the durable envelope", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "tracing-"));
    const teed: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      teed.push(...(JSON.parse(String(init?.body)) as Array<{ type: string; payload: Record<string, unknown> }>));
      return new Response(null, { status: 202 });
    });
    const world = littleDB({
      dataDir,
      engineUrl: "http://localhost:7878",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const usage = { inputTokens: 1000, outputTokens: 250 };
    const env = await world.appendEvent("run_cost", {
      type: "harness.model.responded",
      payload: {
        callId: "call_1",
        turn: 1,
        model: { provider: "deepseek.chat", modelId: "deepseek-v4-pro" },
        response: { text: "ok", usage },
      },
    });
    await world.flushTee();

    // deepseek/deepseek-v4-pro: $0.435 in / $0.87 out per 1M tokens.
    //   (1000 × 0.435 + 250 × 0.87) / 1e6 = 6.525e-4
    const posted = teed.find((candidate) => candidate.type === "harness.model.responded");
    const postedUsage = (posted?.payload.response as { usage: Record<string, unknown> }).usage;
    expect(postedUsage.costUsd).toBeCloseTo((1000 * 0.435 + 250 * 0.87) / 1_000_000, 15);

    // The durable half is untouched: `assertUsage` forbids costUsd on a recorded usage
    // payload, and the envelope handed back to the caller is the one that was committed.
    const durableUsage = (env.payload.response as { usage: Record<string, unknown> }).usage;
    expect(durableUsage).not.toHaveProperty("costUsd");
    expect(usage).toEqual({ inputTokens: 1000, outputTokens: 250 });
    const [stored] = await world.listEvents("run_cost");
    expect((stored!.payload.response as { usage: Record<string, unknown> }).usage).not.toHaveProperty("costUsd");
  });

  it("returns null for missing run and trace lookups", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "tracing-"));
    const fetchMock = vi.fn(async () => new Response(null, { status: 404 }));
    const world = littleDB({
      dataDir,
      engineUrl: "http://localhost:7878",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await expect(world.loadRun("missing")).resolves.toBeNull();
    await expect(world.loadTraceTree("missing")).resolves.toBeNull();
  });
});
