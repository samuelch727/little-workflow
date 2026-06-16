import { test } from "node:test";
import assert from "node:assert/strict";
import { littledbWorld } from "./littledb-world.mjs";

function fakeBaseWorld() {
  const appended = [];
  return {
    _appended: appended,
    async appendEvent(runId, event) {
      const env = { runId, ...event, seq: appended.length };
      appended.push(env);
      return env;
    },
    extraMethod() {
      return "kept";
    },
  };
}

function fakeFetch() {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 202 };
  };
  fn.calls = calls;
  return fn;
}

test("commits durably first, then tees committed envelopes to the engine /ingest", async () => {
  const base = fakeBaseWorld();
  const fetchImpl = fakeFetch();
  const world = littledbWorld({ engineUrl: "http://engine", fetchImpl, baseWorld: base });

  await world.appendEvent("run1", { type: "RunStarted", payload: {} });
  await world.appendEvent("run1", { type: "RunCompleted", payload: {} });
  await world.flushTee();

  assert.equal(base._appended.length, 2, "durable store received both events");
  const ingested = fetchImpl.calls.flatMap((c) => c.body);
  assert.equal(ingested.length, 2, "both events teed to the engine");
  assert.ok(fetchImpl.calls.every((c) => c.url.endsWith("/ingest")));
});

test("appendEvent still commits when the tee fetch throws (best-effort tee)", async () => {
  const base = fakeBaseWorld();
  const world = littledbWorld({
    engineUrl: "http://engine",
    fetchImpl: async () => {
      throw new Error("engine down");
    },
    baseWorld: base,
  });

  const env = await world.appendEvent("run1", { type: "RunStarted", payload: {} });
  await world.flushTee(); // must not throw
  assert.equal(base._appended.length, 1);
  assert.ok(env);
});

test("a non-2xx ingest response is swallowed (engine is rebuildable)", async () => {
  const base = fakeBaseWorld();
  const world = littledbWorld({
    engineUrl: "http://engine",
    fetchImpl: async () => ({ ok: false, status: 500 }),
    baseWorld: base,
  });
  await world.appendEvent("run1", { type: "RunStarted", payload: {} });
  await assert.doesNotReject(world.flushTee());
});

test("preserves the base world's other methods via spread", () => {
  const world = littledbWorld({ engineUrl: "http://e", fetchImpl: fakeFetch(), baseWorld: fakeBaseWorld() });
  assert.equal(typeof world.extraMethod, "function");
  assert.equal(world.extraMethod(), "kept");
});
