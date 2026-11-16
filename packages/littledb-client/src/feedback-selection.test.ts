import { describe, expect, it } from "vitest";
import { createLittleDB } from "./client.js";
import { FeedbackRequestSchema, FeedbackResultSchema, FeedbackSelectionSchema } from "./contract.js";
import { checkFeedback, feedbackId, type FeedbackInput } from "./feedback.js";
import { fakeLittleDB } from "./test/fake-littledb.js";
import { testLittleDB } from "./testing.js";

const at = "2026-10-01T00:00:00.000Z";
const passage = { quote: "bad", start: 7, end: 10 };
const request = (method: string, body?: unknown, query = "") => new Request(`https://app.example.test/feedback${query}`, {
  method,
  headers: { "content-type": "application/json" },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
function setup() {
  const fake = fakeLittleDB();
  const db = createLittleDB({ url: fake.url, apiKey: fake.apiKey, fetch: fake.fetch, onError: () => {} });
  return { fake, db };
}

describe("selection contract", () => {
  it.each(["quote", "prefix", "suffix", "path", "ref"])("rejects lone surrogates in %s before sending feedback", (field) => {
    for (const value of ["\ud800", "\udc00", "\ud800x", "x\udc00", "\ud800\ud800", "\udc00\udc00"]) {
      const selection = { quote: "passage", [field]: field === "path" ? `/${value}` : value };
      expect(FeedbackSelectionSchema.safeParse(selection).success).toBe(false);
      expect(checkFeedback({ traceId: "t1", thumbs: "down", selection })).toEqual({
        ok: false, error: `selection.${field}: Must not contain lone UTF-16 surrogates.`,
      });
    }
  });

  it("accepts paired surrogates and ordinary Unicode in every selection string", () => {
    const selection = { quote: "你好😀", prefix: "🙂前", suffix: "後🙂", path: "/你好😀", ref: "step:😀" };
    expect(FeedbackSelectionSchema.parse(selection)).toEqual(selection);
    expect(checkFeedback({ traceId: "t1", thumbs: "down", selection }).ok).toBe(true);
  });

  it("accepts the boundary limits and normalizes reason codes", () => {
    const selection = { quote: "q".repeat(2000), prefix: "p".repeat(64), suffix: "s".repeat(64), start: 0, end: 2000, path: `/${"p".repeat(199)}`, ref: "r".repeat(200) };
    expect(FeedbackSelectionSchema.parse(selection)).toEqual(selection);
    expect(FeedbackSelectionSchema.parse({ path: "" })).toEqual({ path: "" });
    expect(FeedbackSelectionSchema.parse({ path: "/a~1b/~0c/0" })).toEqual({ path: "/a~1b/~0c/0" });
    expect(FeedbackSelectionSchema.parse({ ref: "step:1" })).toEqual({ ref: "step:1" });
    const parsed = FeedbackRequestSchema.parse({ traceId: "t1", thumbs: "down", selection, tags: [" wrong ", "wrong", "other"], expected: "e".repeat(4000), role: "r".repeat(50), unknown: "ignored" });
    expect(parsed.tags).toEqual(["wrong", "other"]);
    expect(parsed).not.toHaveProperty("unknown");
    expect(FeedbackRequestSchema.safeParse({ traceId: "t1", comment: "a", tags: Array.from({ length: 10 }, () => "t".repeat(50)) }).success).toBe(true);
  });

  it.each([
    {}, { quote: "" }, { quote: "q".repeat(2001) }, { quote: "q", prefix: "p".repeat(65) },
    { quote: "q", suffix: "s".repeat(65) }, { path: "p" }, { path: "/bad~escape" }, { path: `/${"p".repeat(200)}` },
    { ref: "" }, { ref: "r".repeat(201) }, { quote: "q", start: -1 }, { quote: "q", start: 0.5 },
    { quote: "q", end: -1 }, { quote: "q", end: 0.5 }, { quote: "q", start: 2, end: 1 },
    { quote: "q", start: Number.MAX_SAFE_INTEGER + 1 }, { quote: "q", surprise: true },
  ])("refuses an invalid selection %j", (selection) => {
    expect(FeedbackSelectionSchema.safeParse(selection).success).toBe(false);
  });

  it.each([{ tags: [""] }, { tags: ["   "] }, { tags: ["t".repeat(51)] }, { tags: Array(11).fill("t") }, { expected: "" }, { expected: "e".repeat(4001) }, { role: "" }, { role: "r".repeat(51) }])("enforces first-class field limits %j", (fields) => {
    expect(FeedbackRequestSchema.safeParse({ traceId: "t1", thumbs: "down", ...fields }).success).toBe(false);
  });

  it("still needs a real feedback signal and parses all five anchor statuses", () => {
    expect(FeedbackRequestSchema.safeParse({ traceId: "t1", selection: passage, tags: ["wrong"], expected: "better", role: "expert" }).success).toBe(false);
    for (const status of ["exact", "loose", "position", "pending", "not_found"]) {
      expect(FeedbackResultSchema.parse({ traceId: "t1", scores: [], selection: { anchor: { status } } }).selection?.anchor.status).toBe(status);
    }
  });
});

describe("highlight ids", () => {
  it("pins the existing id and makes stable ids from quote, start, path and ref only", () => {
    expect(feedbackId("u_1", "msg_1")).toBe("fb_f6b5f06a54c3373284c6f22e1ca84659");
    expect(feedbackId("u_1", "msg_1", undefined)).toBe(feedbackId("u_1", "msg_1"));
    const id = feedbackId("u_1", "msg_1", passage);
    expect(id).not.toBe(feedbackId("u_1", "msg_1"));
    expect(id).toBe(feedbackId("u_1", "msg_1", { ...passage, prefix: "nearby", suffix: "context", end: 11 }));
    expect(id).not.toBe(feedbackId("other", "msg_1", passage));
    for (const selection of [{ ...passage, quote: "other" }, { ...passage, start: 8 }, { ...passage, path: "/answer" }, { ...passage, ref: "step:1" }]) {
      expect(id).not.toBe(feedbackId("u_1", "msg_1", selection));
    }
    expect(feedbackId("u", "m", { ref: "step:1" })).toBe(feedbackId("u", "m", { ref: "step:1" }));
  });
});

describe("fake feedback detail", () => {
  it("keeps legacy metadata intact for trusted direct server callers", async () => {
    const { db, fake } = setup();
    const metadata = { role: "instructor", correction: { expected: "legacy correction" }, reasons: ["wrong"] };
    await db.feedback({ traceId: "t1", thumbs: "down", metadata });
    expect(fake.requests[0]?.body).toMatchObject({ metadata });
  });

  it("stores first-class detail on every answer and returns an exact or unmatched anchor", async () => {
    const { fake, db } = setup();
    db.ingest({ traces: [{ id: "t1", startTime: at, output: { answer: "你好🙂 bad answer", keep: "unchanged" } }] });
    await db.flush();
    const selection = { ...passage, path: "/answer" };
    const result = await db.feedback({ traceId: "t1", selection, thumbs: "down", answers: [{ question: "wrong", value: true }], tags: [" factual ", "factual"], expected: "good", role: "expert" });
    expect(result.selection).toEqual({ anchor: { status: "exact", start: 5, end: 8, path: "/answer" } });
    for (const row of fake.feedback.values()) expect(row).toMatchObject({ selection, tags: ["factual"], expected: "good", role: "expert", anchor: result.selection!.anchor });
    expect((await db.feedback({ traceId: "t1", selection: { quote: "missing" }, thumbs: "down" })).selection).toEqual({ anchor: { status: "not_found" } });
    expect(await db.feedback({ traceId: "t1", selection: { path: "/answer" }, thumbs: "down" })).not.toHaveProperty("selection");
  });

  it("the public testing entry anchors trace and named-span string leaves too", async () => {
    const server = testLittleDB();
    server.db.ingest({ traces: [{ id: "t1", startTime: at, output: { "a/b": ["bad"] } }], spans: [{ traceId: "t1", id: "s1", name: "tool", startTime: at, output: "span bad" }] });
    await server.db.flush();
    expect((await server.db.feedback({ traceId: "t1", selection: { quote: "bad", path: "/a~1b/0" }, thumbs: "down" })).selection?.anchor).toEqual({ status: "exact", start: 0, end: 3, path: "/a~1b/0" });
    expect((await server.db.feedback({ traceId: "t1", spanId: "s1", selection: { quote: "bad" }, thumbs: "down" })).selection?.anchor).toEqual({ status: "exact", start: 5, end: 8, path: "" });
    expect((await server.db.feedback({ traceId: "t1", selection: { quote: "missing" }, thumbs: "down" })).selection?.anchor.status).toBe("not_found");
    expect(await server.db.feedback({ traceId: "t1", selection: { ref: "step" }, thumbs: "down" })).not.toHaveProperty("selection");
  });

  it.each([
    { selection: { quote: "different" } }, { selection: { ...passage, prefix: "p" } }, { selection: { ...passage, suffix: "s" } },
    { selection: { ...passage, start: 8 } }, { selection: { ...passage, end: 11 } }, { selection: { ...passage, path: "/answer" } },
    { selection: { ...passage, ref: "step" } }, { tags: ["other"] }, { expected: "different" }, { role: "other" },
  ])("conflicts at the same revision when new report content changes: %j", async (change) => {
    const { db, fake } = setup();
    const input: FeedbackInput = { traceId: "t1", id: "fixed-id", thumbs: "down", revision: 20, selection: passage, tags: ["wrong"], expected: "better", role: "expert" };
    await db.feedback(input);
    expect(await db.feedback({ ...input, metadata: { attempt: 2 } })).not.toHaveProperty("stale");
    await expect(db.feedback({ ...input, ...change })).rejects.toMatchObject({ status: 409, code: "revision_conflict" });
    expect([...fake.feedback.values()][0]).toMatchObject({ selection: passage, tags: ["wrong"], expected: "better", role: "expert" });
  });

  it("keeps equal-revision withdrawals and withdraw-before-first-report fences", async () => {
    const { db, fake } = setup();
    const input = { traceId: "t1", id: "highlight", thumbs: "down" as const, selection: passage, revision: 10 };
    await db.feedback(input);
    expect(await db.retractFeedback("highlight", { revision: 10 })).toEqual({ removed: 1 });
    expect(await db.feedback(input)).toMatchObject({ stale: true, revision: 10, scores: [] });
    expect(await db.retractFeedback("before", { revision: 20 })).toEqual({ removed: 0 });
    expect(await db.feedback({ ...input, id: "before", revision: 20 })).toMatchObject({ stale: true, revision: 20 });
    expect(await db.feedback({ ...input, revision: undefined })).toMatchObject({ stale: true, revision: 10 });
    expect(fake.feedback.size).toBe(0);
  });

  it("repeats the original anchor with the same report and revision, even if the fake output changes", async () => {
    const { db, fake } = setup();
    db.ingest({ traces: [{ id: "t1", startTime: at, output: "bad" }] });
    await db.flush();
    const input = { traceId: "t1", id: "highlight", thumbs: "down" as const, selection: { quote: "bad" }, revision: 10 };
    const first = await db.feedback(input);
    expect(first.selection?.anchor.status).toBe("exact");
    db.ingest({ traces: [{ id: "t1", startTime: at, output: "updated" }] });
    await db.flush();
    expect(await db.feedback({ ...input, metadata: { attempt: 2 } })).toEqual(first);
    expect([...fake.feedback.values()][0]?.anchor).toEqual(first.selection!.anchor);
  });
});

describe("highlight feedbackHandler", () => {
  it.each([undefined, "expert"])("uses only authorize's role (%s), stripping both legacy browser fields", async (role) => {
    const { db, fake } = setup();
    const handler = db.feedbackHandler({ authorize: () => ({ userId: "student", ...(role === undefined ? {} : { role }) }) });
    const response = await handler(request("POST", { traceId: "t1", id: "m1", thumbs: "down", role: "instructor", metadata: { role: "instructor", correction: { expected: "spoofed" }, reasons: ["wrong"], surface: "web" } }));
    expect(response.status).toBe(201);
    expect(fake.requests[0]?.body).toMatchObject({ userId: "student", metadata: { reasons: ["wrong"], surface: "web" } });
    const sent = fake.requests[0]!.body as FeedbackInput;
    expect(sent.role).toBe(role);
    expect(sent.metadata).not.toHaveProperty("role");
    expect(sent.metadata).not.toHaveProperty("correction");
    expect([...fake.feedback.values()][0]?.role).toBe(role);
  });

  it("passes new fields and anchor through, and withdraws only the selected highlight", async () => {
    const { db, fake } = setup();
    db.ingest({ traces: [{ id: "t1", startTime: at, output: "before bad after other" }] });
    await db.flush();
    const handler = db.feedbackHandler({ authorize: () => ({ userId: "u", role: "expert" }), resolveTrace: () => "t1" });
    const send = (selection?: typeof passage) => handler(request("POST", { messageId: "m1", thumbs: "down", selection, tags: ["wrong"], expected: "better" }));
    await send();
    const response = await send(passage);
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ selection: { anchor: { status: "exact", start: 7, end: 10, path: "" } } });
    await send({ quote: "other", start: 17, end: 22 });
    expect(fake.feedback.size).toBe(3);
    expect(fake.requests.find((r) => r.path === "/v1/feedback" && (r.body as FeedbackInput).selection !== undefined)?.body).toMatchObject({ id: feedbackId("u", "m1", passage), selection: passage, tags: ["wrong"], expected: "better", role: "expert" });
    expect(await (await handler(request("DELETE", { messageId: "m1", selection: passage }))).json()).toEqual({ removed: 1 });
    expect(fake.feedback.size).toBe(2);
    expect([...fake.feedback.values()].some((row) => row.feedbackId === feedbackId("u", "m1"))).toBe(true);
  });

  it("forwards stale and revision on POST and DELETE, including body and query revisions", async () => {
    const { db, fake } = setup();
    const handler = db.feedbackHandler({ authorize: () => ({ userId: "u" }) });
    await handler(request("POST", { traceId: "t1", id: "m1", selection: passage, thumbs: "down", revision: 10 }));
    const stale = await handler(request("POST", { traceId: "t1", id: "m1", selection: passage, thumbs: "up", revision: 9 }));
    expect(stale.status).toBe(200);
    expect(await stale.json()).toMatchObject({ scores: [], stale: true, revision: 10 });
    const conflict = await handler(request("POST", { traceId: "t1", id: "m1", selection: passage, thumbs: "up", revision: 10 }));
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: { code: "revision_conflict" } });
    const withdrawal = await handler(request("DELETE", { id: "m1", selection: passage, revision: 11 }));
    expect(await withdrawal.json()).toEqual({ removed: 1 });
    expect(fake.requests.at(-1)?.path).toBe(`/v1/feedback/${feedbackId("u", "m1", passage)}?revision=11`);
    expect(await (await handler(request("DELETE", { id: "m1", selection: passage, revision: 10 }))).json()).toEqual({ removed: 0, stale: true, revision: 11 });
    await handler(request("POST", { traceId: "t1", id: "whole", thumbs: "up", revision: 0 }));
    expect(await (await handler(request("DELETE", undefined, "?id=whole&revision=1"))).json()).toEqual({ removed: 1 });
    expect(await (await handler(request("DELETE", undefined, "?id=whole&revision=0"))).json()).toEqual({ removed: 0, stale: true, revision: 1 });
  });

  it("passes successful revision results and pending anchors through too", async () => {
    const { db, fake } = setup();
    fake.override((r) => r.path === "/v1/feedback" ? { status: 201, body: { traceId: "t1", scores: [], revision: 12, selection: { anchor: { status: "pending" } } } } : r.method === "DELETE" ? { status: 200, body: { removed: 1, revision: 13 } } : undefined);
    const handler = db.feedbackHandler({ authorize: () => ({ userId: "u" }) });
    const response = await handler(request("POST", { traceId: "t1", id: "m", selection: passage, thumbs: "down", revision: 12 }));
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ traceId: "t1", scores: [], revision: 12, selection: { anchor: { status: "pending" } } });
    expect(await (await handler(request("DELETE", { id: "m", revision: 13 }))).json()).toEqual({ removed: 1, revision: 13 });
  });

  it("rejects invalid selections and revisions without calling LittleDB", async () => {
    const { db, fake } = setup();
    const handler = db.feedbackHandler({ authorize: () => ({ userId: "u" }) });
    expect((await handler(request("POST", { traceId: "t1", id: "m", thumbs: "down", selection: { quote: "q", unknown: true } }))).status).toBe(400);
    expect((await handler(request("DELETE", { id: "m", selection: {} }))).status).toBe(400);
    for (const revision of [-1, 1.5, "bad", null, Number.MAX_SAFE_INTEGER + 1]) expect((await handler(request("DELETE", { id: "m", revision }))).status).toBe(400);
    expect((await handler(request("DELETE", undefined, "?id=m&revision="))).status).toBe(400);
    expect(fake.requests).toHaveLength(0);
  });
});
