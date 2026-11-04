import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createLittleDB } from "./client.js";
import { createTransport } from "./http.js";
import { createResolver } from "./resolve.js";
import { fakeLittleDB } from "./test/fake-littledb.js";
import { testLittleDB } from "./testing.js";

const support = { system: "Answer refunds within 30 days.", model: "smart" } as const;

afterEach(() => {
  vi.useRealTimers();
});

describe("resolve fallbacks", () => {
  it("never falls back to a trial candidate: only a live answer is kept as last known", async () => {
    const fake = fakeLittleDB();
    const resolver = createResolver({ transport: createTransport({ url: fake.url, apiKey: fake.apiKey, fetch: fake.fetch }), onError: () => {}, cacheTtlMs: 0, stickyCacheTtlMs: 0 });
    const answer = (versionId: string, mode: string) =>
      fake.setResolution({ subjectId: "sub_1", versionId, number: 1, status: mode === "live" ? "approved" : "trial", mode, content: { system: versionId }, channel: "production" });

    answer("ver_live", "live");
    await resolver.resolve({ kind: "harness", slug: "support", stickyKey: "a" });
    answer("ver_candidate", "trial");
    await resolver.resolve({ kind: "harness", slug: "support", stickyKey: "b" });

    fake.override(() => ({ status: 503, body: { error: { code: "unavailable", message: "down" } } }));
    const during = await resolver.resolve({ kind: "harness", slug: "support", stickyKey: "c", bootstrap: support });
    expect(during).toMatchObject({ fallback: "last_known", versionId: "ver_live", mode: "live", content: { system: "ver_live" } });
  });

  it("reads the project holdout and traces it as holdout traffic", async () => {
    const fake = fakeLittleDB();
    fake.setResolution({ subjectId: "sub_1", versionId: "ver_old", number: 3, status: "retired", mode: "holdout", content: support, channel: "production" });
    const db = createLittleDB({ url: fake.url, apiKey: fake.apiKey, fetch: fake.fetch, onError: () => {} });
    const resolution = await db.resolve({ kind: "harness", slug: "support", stickyKey: "held" });
    expect(resolution).toMatchObject({ mode: "holdout", versionId: "ver_old" });
    expect(resolution.fallback).toBeUndefined();

    const tracer = db.harnessTracer({ harness: "support", resolution });
    await tracer.onEvent({ type: "harness.session.started", sessionId: "held", turnId: "t1", timestamp: "2026-10-21T00:00:00.000Z" });
    await db.flush();
    expect([...fake.traces.values()][0]).toMatchObject({ environment: "holdout", versionId: "ver_old" });
  });

  it("keeps the live answer in a file, so a new process that starts during an outage runs it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "littledb-last-known-"));
    try {
      const file = join(dir, "last-known.json");
      const live = testLittleDB({ live: { "harness:support": { ...support, system: "Version from LittleDB." } }, lastKnownFile: file });
      await live.db.resolve({ kind: "harness", slug: "support", bootstrap: support });
      await vi.waitFor(async () => expect(JSON.parse(await readFile(file, "utf8")).entries).toBeDefined(), { timeout: 3_000 });

      const restarted = testLittleDB({ lastKnownFile: file });
      restarted.setDown(true);
      const resolution = await restarted.db.resolve({ kind: "harness", slug: "support", bootstrap: support });
      expect(resolution).toMatchObject({ fallback: "last_known", content: { system: "Version from LittleDB." } });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("stops asking LittleDB after repeated failures, then asks again after the cool-down", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const server = testLittleDB({ breakerFailures: 2, breakerCooldownMs: 30_000, resolveCacheTtlMs: 0 });
    server.setDown(true);
    for (const key of ["a", "b", "c", "d"]) {
      await server.db.resolve({ kind: "harness", slug: "support", stickyKey: key, bootstrap: support });
    }
    const resolves = () => server.requests.filter((r) => r.path === "/v1/resolve").length;
    expect(resolves()).toBe(2);
    const skipped = await server.db.resolve({ kind: "harness", slug: "support", stickyKey: "e", bootstrap: support });
    expect(skipped).toMatchObject({ fallback: "bootstrap", content: support });
    expect(skipped.error).toMatch(/asking again in \d+ s/u);

    vi.setSystemTime(Date.now() + 31_000);
    server.setDown(false);
    const back = await server.db.resolve({ kind: "harness", slug: "support", stickyKey: "f", bootstrap: support });
    expect(back.fallback).toBeUndefined();
    expect(resolves()).toBe(3);
  });
});

describe("sessions keep their version until it is rolled back", () => {
  it("keeps a session on its version through a promotion, and moves it off a rollback", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const server = testLittleDB({ revalidateMs: 30_000 });
    const v1 = (await server.db.resolve({ kind: "harness", slug: "support", stickyKey: "s1", bootstrap: support })).versionId;
    const v2 = server.setLive("harness:support", { ...support, system: "Version 2." });

    vi.setSystemTime(Date.now() + 31_000);
    const afterPromotion = await server.db.resolve({ kind: "harness", slug: "support", stickyKey: "s1", bootstrap: support });
    expect(afterPromotion.versionId).toBe(v1);
    const newSession = await server.db.resolve({ kind: "harness", slug: "support", stickyKey: "s2", bootstrap: support });
    expect(newSession.versionId).toBe(v2);

    // v2 is rolled back: s2 was on it and moves to v1 at its next check.
    server.rollback("harness:support");
    vi.setSystemTime(Date.now() + 31_000);
    const afterRollback = await server.db.resolve({ kind: "harness", slug: "support", stickyKey: "s2", bootstrap: support });
    expect(afterRollback.versionId).toBe(v1);
    const lastCheck = server.requests.filter((r) => r.path === "/v1/resolve").at(-1)?.body as Record<string, unknown>;
    expect(lastCheck.currentVersionId).toBe(v2);
  });

  it("moves a session off a trial candidate when the trial stops", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const server = testLittleDB({ revalidateMs: 30_000 });
    const live = (await server.db.resolve({ kind: "harness", slug: "support", stickyKey: "s1", bootstrap: support })).versionId;
    const candidate = server.startTrial("harness:support", { ...support, system: "Candidate." });
    expect((await server.db.resolve({ kind: "harness", slug: "support", stickyKey: "s2", bootstrap: support })).versionId).toBe(candidate);

    server.stopTrial("harness:support");
    vi.setSystemTime(Date.now() + 31_000);
    const after = await server.db.resolve({ kind: "harness", slug: "support", stickyKey: "s2", bootstrap: support });
    expect(after).toMatchObject({ versionId: live, mode: "live" });
  });

  it("answers from the session's kept version between checks, without a request", async () => {
    const server = testLittleDB();
    await server.db.resolve({ kind: "harness", slug: "support", stickyKey: "s1", bootstrap: support });
    await server.db.resolve({ kind: "harness", slug: "support", stickyKey: "s1", bootstrap: support });
    expect(server.requests.filter((r) => r.path === "/v1/resolve")).toHaveLength(1);
  });
});

describe("declared content", () => {
  const Support = z.object({ system: z.string().min(1), model: z.enum(["fast", "smart"]) });

  it("sends the content shape as JSON Schema and returns typed content", async () => {
    const server = testLittleDB();
    const resolution = await server.db.resolve({ kind: "harness", slug: "support", bootstrap: support, schema: Support });
    const model: "fast" | "smart" | undefined = resolution.content?.model;
    expect(model).toBe("smart");
    expect(server.schemaOf("harness:support")).toMatchObject({ type: "object", properties: { model: { enum: ["fast", "smart"] } } });
  });

  it("never runs a version that does not match: the bootstrap runs and onError says why", async () => {
    const errors: string[] = [];
    const server = testLittleDB({ live: { "harness:support": { system: "Hi", model: "huge" } }, onError: (error) => errors.push(String(error)) });
    const resolution = await server.db.resolve({ kind: "harness", slug: "support", bootstrap: support, schema: Support });
    expect(resolution).toMatchObject({ fallback: "invalid", versionId: null, content: support });
    expect(errors.join("\n")).toMatch(/model/u);
  });
});

describe("changes in code", () => {
  it("tells you once when LittleDB opened a proposal for an edit in your code", async () => {
    const changes: unknown[] = [];
    const server = testLittleDB({ onCodeChange: (change) => changes.push(change), resolveCacheTtlMs: 0 });
    await server.db.resolve({ kind: "harness", slug: "support", bootstrap: support });
    const edited = { ...support, system: "Answer refunds within 45 days." };
    const first = await server.db.resolve({ kind: "harness", slug: "support", bootstrap: edited });
    await server.db.resolve({ kind: "harness", slug: "support", bootstrap: edited });
    expect(first.code).toMatchObject({ state: "changed" });
    // The live version keeps running until the proposal ships.
    expect(first.content).toEqual(support);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ kind: "harness", slug: "support", proposalId: server.codeProposals("harness:support")[0]?.id });
  });

  it("passes the calling workflow through", async () => {
    const server = testLittleDB();
    await server.db.resolve({ kind: "harness", slug: "income-verifier", caller: { kind: "workflow", slug: "loan-desk", step: "verify" } });
    expect(server.requests[0]?.body).toMatchObject({ caller: { kind: "workflow", slug: "loan-desk", step: "verify" } });
  });
});
