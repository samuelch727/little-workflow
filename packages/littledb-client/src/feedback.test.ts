import { describe, expect, it, vi } from "vitest";
import { createLittleDB } from "./client.js";
import { feedbackId } from "./feedback.js";
import { LittleDBError } from "./http.js";
import { fakeLittleDB } from "./test/fake-littledb.js";

const at = "2026-10-01T00:00:00.000Z";

function setup(options: { onError?: (error: unknown, context: { operation: string }) => void } = {}) {
  const fake = fakeLittleDB();
  const db = createLittleDB({ url: fake.url, apiKey: fake.apiKey, fetch: fake.fetch, onError: options.onError ?? (() => {}) });
  return { fake, db };
}

/** A browser request to the app's own feedback route. */
function browser(method: string, body?: unknown, init: { url?: string; headers?: Record<string, string> } = {}): Request {
  return new Request(init.url ?? "https://app.example.com/api/feedback", {
    method,
    headers: { "content-type": "application/json", ...init.headers },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
}

describe("feedback", () => {
  it("posts what the user said with the key as a bearer token, and returns LittleDB's scores", async () => {
    const { fake, db } = setup();
    const result = await db.feedback({
      traceId: "lh_turn_1",
      userId: "u_3f2a",
      id: feedbackId("u_3f2a", "msg_17"),
      thumbs: "down",
      comment: "Didn't say when I'd get my money",
      metadata: { surface: "web" },
    });
    expect(result).toEqual({ traceId: "lh_turn_1", scores: [{ id: expect.any(String), name: "thumbs", value: 0, label: null }] });
    const sent = fake.requests.find((request) => request.path === "/v1/feedback");
    expect(sent).toMatchObject({ method: "POST", authorization: `Bearer ${fake.apiKey}` });
    expect(sent?.body).toEqual({
      traceId: "lh_turn_1",
      userId: "u_3f2a",
      id: feedbackId("u_3f2a", "msg_17"),
      thumbs: "down",
      comment: "Didn't say when I'd get my money",
      metadata: { surface: "web" },
    });
    expect([...fake.feedback.values()][0]).toMatchObject({ comment: "Didn't say when I'd get my money", author: "u_3f2a" });
  });

  it("replaces an answer sent again with the same id", async () => {
    const { fake, db } = setup();
    const id = feedbackId("u_1", "msg_1");
    await db.feedback({ traceId: "t1", id, thumbs: "up" });
    await db.feedback({ traceId: "t1", id, thumbs: "down" });
    expect([...fake.feedback.values()].map((score) => score.value)).toEqual([0]);
  });

  it("sends a survey's answers, each as its own score", async () => {
    const { fake, db } = setup();
    const result = await db.feedback({
      traceId: "t1",
      survey: "csat-v1",
      answers: [
        { question: "resolved", value: true },
        { question: "ease", value: 4, scale: 5 },
        { question: "reason", choice: "too slow" },
        { question: "anything_else", text: "More examples, please." },
      ],
    });
    expect(result.scores.map((score) => [score.name, score.value, score.label])).toEqual([
      ["resolved", 1, null],
      ["ease", 0.75, null],
      ["reason", null, "too slow"],
      ["anything_else", null, "text"],
    ]);
    expect([...fake.feedback.values()].every((score) => score.survey === "csat-v1")).toBe(true);
  });

  it("sends the queued traces first when it names only a session, so the latest turn is there", async () => {
    const { db } = setup();
    db.ingest({ traces: [{ id: "lh_latest", sessionId: "sess_9", startTime: at }] });
    const result = await db.feedback({ sessionId: "sess_9", rating: { value: 5 } });
    expect(result.traceId).toBe("lh_latest");
    expect(result.scores[0]).toMatchObject({ name: "rating", value: 1 });
  });

  it("refuses feedback it can tell is invalid without asking LittleDB", async () => {
    const { fake, db } = setup();
    await expect(db.feedback({ thumbs: "up" })).rejects.toThrow(/traceId or a sessionId/u);
    await expect(db.feedback({ traceId: "t1" })).rejects.toThrow(/thumbs, a rating, a comment or answers/u);
    await expect(db.feedback({ traceId: "t1", rating: { value: 6 } })).rejects.toThrow(/rating\.value/u);
    await expect(db.feedback({ traceId: "t1", rating: { value: 3, scale: 11 } })).rejects.toThrow(TypeError);
    await expect(db.feedback({ traceId: "t1", comment: "x".repeat(4001) })).rejects.toThrow(/comment/u);
    await expect(
      db.feedback({ traceId: "t1", answers: [{ question: "q", value: true, text: "both" } as never] }),
    ).rejects.toThrow(/answers\.0/u);
    await expect(db.feedback({ traceId: "t1", answers: [{ question: "q", value: 3 } as never] })).rejects.toThrow(TypeError);
    expect(fake.requests).toHaveLength(0);
  });

  it("throws LittleDBError when LittleDB fails, without the key", async () => {
    const { fake, db } = setup();
    fake.override((request) => (request.path === "/v1/feedback" ? { status: 503, body: { error: { code: "unavailable", message: "busy" } } } : undefined));
    const error = (await db.feedback({ traceId: "t1", thumbs: "up" }).catch((e: unknown) => e)) as LittleDBError;
    expect(error).toBeInstanceOf(LittleDBError);
    expect(error).toMatchObject({ status: 503, retryable: true });
    expect(error.message).not.toContain(fake.apiKey);
  });
});

describe("retractFeedback", () => {
  it("withdraws every score sent with the id", async () => {
    const { fake, db } = setup();
    const id = feedbackId("u_1", "msg_1");
    await db.feedback({ traceId: "t1", id, thumbs: "up", rating: { value: 4 } });
    expect(fake.feedback.size).toBe(2);
    expect(await db.retractFeedback(id)).toEqual({ removed: 2 });
    expect(fake.feedback.size).toBe(0);
    expect(fake.requests.at(-1)).toMatchObject({ method: "DELETE", path: `/v1/feedback/${id}`, authorization: `Bearer ${fake.apiKey}` });
    await expect(db.retractFeedback("")).rejects.toThrow(TypeError);
  });

  it("orders changes to one id by revision: an older one, arriving late, changes nothing", async () => {
    const { fake, db } = setup();
    const id = feedbackId("u_1", "msg_1");
    await db.feedback({ traceId: "t1", id, thumbs: "down", revision: 20 });
    expect(await db.feedback({ traceId: "t1", id, thumbs: "up", revision: 10 })).toMatchObject({ stale: true, revision: 20, scores: [] });
    expect([...fake.feedback.values()].map((score) => score.value)).toEqual([0]);
    // At the revision applied, the same report is a repeat and a different one is refused.
    expect(await db.feedback({ traceId: "t1", id, thumbs: "down", revision: 20, metadata: { attempt: 2 } })).not.toHaveProperty("stale");
    await expect(db.feedback({ traceId: "t1", id, thumbs: "up", revision: 20 })).rejects.toMatchObject({ status: 409 });
    expect(await db.retractFeedback(id, { revision: 30 })).toEqual({ removed: 1 });
    expect(fake.requests.at(-1)).toMatchObject({ method: "DELETE", path: `/v1/feedback/${id}?revision=30` });
    // The retraction is kept: the down at 20, retried after it, stays out.
    expect(await db.feedback({ traceId: "t1", id, thumbs: "down", revision: 20 })).toMatchObject({ stale: true });
    expect(await db.retractFeedback(id, { revision: 25 })).toEqual({ removed: 0, stale: true, revision: 30 });
    // Without a revision, below every revision.
    expect(await db.retractFeedback(id)).toEqual({ removed: 0, stale: true, revision: 30 });
    expect(fake.feedback.size).toBe(0);
    await expect(db.feedback({ traceId: "t1", thumbs: "up", revision: 1 })).rejects.toThrow(/revision/u);
    await expect(db.feedback({ traceId: "t1", id, thumbs: "up", revision: 1.5 })).rejects.toThrow(TypeError);
    await expect(db.retractFeedback(id, { revision: -1 })).rejects.toThrow(TypeError);
  });
});

describe("feedbackId", () => {
  it("is stable per user and message, and users never share one", () => {
    expect(feedbackId("u_1", "msg_1")).toBe(feedbackId("u_1", "msg_1"));
    expect(feedbackId("u_1", "msg_1")).not.toBe(feedbackId("u_2", "msg_1"));
    expect(feedbackId("a:b", "c")).not.toBe(feedbackId("a", "b:c"));
    expect(feedbackId("u".repeat(500), "m".repeat(500)).length).toBeLessThanOrEqual(200);
  });
});

describe("feedbackHandler", () => {
  const signedIn = () => ({ userId: "u_signed_in" });

  it("refuses a request authorize does not accept, before reading it or calling LittleDB", async () => {
    const { fake, db } = setup();
    const handler = db.feedbackHandler({ authorize: () => null });
    const response = await handler(browser("POST", { traceId: "t1", thumbs: "up" }));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: { code: "unauthorized", message: expect.any(String) } });
    expect(fake.requests).toHaveLength(0);
  });

  it("stores the user authorize names, never the one in the body, and scopes ids to that user", async () => {
    const { fake, db } = setup();
    const authorize = vi.fn(signedIn);
    const handler = db.feedbackHandler({ authorize });
    const response = await handler(browser("POST", { traceId: "t1", userId: "u_someone_else", id: "msg_1", thumbs: "up" }));
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ traceId: "t1", scores: [{ name: "thumbs", value: 1 }] });
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(fake.requests[0]?.body).toMatchObject({ userId: "u_signed_in", id: feedbackId("u_signed_in", "msg_1") });
    expect(JSON.stringify(fake.requests[0]?.body)).not.toContain("u_someone_else");
  });

  it("maps a message id to a trace with resolveTrace, and makes it the default id", async () => {
    const { fake, db } = setup();
    const resolveTrace = vi.fn(({ messageId }: { messageId?: string | undefined }) => (messageId === "msg_7" ? "lh_turn_7" : undefined));
    const handler = db.feedbackHandler({ authorize: signedIn, resolveTrace });
    const ok = await handler(browser("POST", { messageId: "msg_7", thumbs: "down", comment: "Wrong file." }));
    expect(ok.status).toBe(201);
    expect(fake.requests[0]?.body).toMatchObject({ traceId: "lh_turn_7", id: feedbackId("u_signed_in", "msg_7"), comment: "Wrong file." });
    expect(resolveTrace).toHaveBeenCalledWith({ messageId: "msg_7" }, expect.objectContaining({ userId: "u_signed_in" }));
    const unknown = await handler(browser("POST", { messageId: "msg_404", thumbs: "up" }));
    expect(unknown.status).toBe(404);
    expect(fake.requests).toHaveLength(1);
  });

  it("can send a survey to the session's latest trace", async () => {
    const { fake, db } = setup();
    db.ingest({ traces: [{ id: "lh_last", sessionId: "sess_1", startTime: at }] });
    const handler = db.feedbackHandler({ authorize: signedIn, resolveTrace: ({ sessionId }) => (sessionId === undefined ? null : { sessionId }) });
    const response = await handler(
      browser("POST", { sessionId: "sess_1", id: "survey", survey: "end-of-chat", answers: [{ question: "resolved", value: false }] }),
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ traceId: "lh_last" });
    expect(fake.requests.find((request) => request.path === "/v1/feedback")?.body).toMatchObject({ sessionId: "sess_1", survey: "end-of-chat" });
  });

  it("refuses a messageId when nothing on the server can resolve it", async () => {
    const { fake, db } = setup();
    const response = await db.feedbackHandler({ authorize: signedIn })(browser("POST", { messageId: "m1", thumbs: "up" }));
    expect(response.status).toBe(400);
    expect(fake.requests).toHaveLength(0);
  });

  it("answers 400 with the problem for invalid feedback or a body that is not JSON", async () => {
    const { fake, db } = setup();
    const handler = db.feedbackHandler({ authorize: signedIn });
    const empty = await handler(browser("POST", { traceId: "t1" }));
    expect(empty.status).toBe(400);
    expect(((await empty.json()) as { error: { message: string } }).error.message).toMatch(/thumbs, a rating/u);
    expect((await handler(browser("POST", "{not json"))).status).toBe(400);
    expect((await handler(browser("POST", [1, 2]))).status).toBe(400);
    expect((await handler(browser("POST", { traceId: "t1", thumbs: "sideways" }))).status).toBe(400);
    expect(fake.requests).toHaveLength(0);
  });

  it("refuses bodies over the limit, whether declared or streamed", async () => {
    const { fake, db } = setup();
    const handler = db.feedbackHandler({ authorize: signedIn });
    const declared = browser("POST", { traceId: "t1", thumbs: "up" }, { headers: { "content-length": String(64 * 1024) } });
    expect((await handler(declared)).status).toBe(413);
    const big = { traceId: "t1", thumbs: "up", metadata: { padding: "x".repeat(17 * 1024) } };
    expect((await handler(browser("POST", big))).status).toBe(413);

    const bytes = new TextEncoder().encode(JSON.stringify(big));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let offset = 0; offset < bytes.length; offset += 1024) controller.enqueue(bytes.slice(offset, offset + 1024));
        controller.close();
      },
    });
    const undeclared = new Request("https://app.example.com/api/feedback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: stream,
      duplex: "half",
    } as RequestInit);
    expect(undeclared.headers.get("content-length")).toBeNull();
    expect((await handler(undeclared)).status).toBe(413);

    const small = db.feedbackHandler({ authorize: signedIn, maxBodyBytes: 64 });
    expect((await small(browser("POST", { traceId: "t1", thumbs: "up", comment: "a".repeat(80) }))).status).toBe(413);
    expect(fake.requests).toHaveLength(0);
  });

  it("wants JSON, and only POST and DELETE", async () => {
    const { db } = setup();
    const handler = db.feedbackHandler({ authorize: signedIn });
    const form = await handler(browser("POST", "thumbs=up", { headers: { "content-type": "text/plain" } }));
    expect(form.status).toBe(415);
    const get = await handler(new Request("https://app.example.com/api/feedback"));
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toBe("POST, DELETE");
  });

  it("withdraws feedback on DELETE, by ?id= or by body, only within the signed-in user's ids", async () => {
    const { fake, db } = setup();
    const handler = db.feedbackHandler({ authorize: signedIn });
    await handler(browser("POST", { traceId: "t1", id: "msg_1", thumbs: "up" }));
    await handler(browser("POST", { traceId: "t1", id: "msg_2", thumbs: "down" }));

    const byQuery = await handler(browser("DELETE", undefined, { url: "https://app.example.com/api/feedback?id=msg_1" }));
    expect(byQuery.status).toBe(200);
    expect(await byQuery.json()).toEqual({ removed: 1 });
    expect(fake.requests.at(-1)).toMatchObject({ method: "DELETE", path: `/v1/feedback/${feedbackId("u_signed_in", "msg_1")}` });

    const other = db.feedbackHandler({ authorize: () => ({ userId: "u_other" }) });
    expect(await (await other(browser("DELETE", { id: "msg_2" }))).json()).toEqual({ removed: 0 });
    expect(fake.feedback.size).toBe(1);

    expect(await (await handler(browser("DELETE", { id: "msg_2" }))).json()).toEqual({ removed: 1 });
    expect(fake.feedback.size).toBe(0);
    expect((await handler(browser("DELETE", {}))).status).toBe(400);
    expect((await db.feedbackHandler({ authorize: () => null })(browser("DELETE", { id: "msg_2" }))).status).toBe(401);
  });

  it("answers with a short message of its own when LittleDB fails, never its body or the key", async () => {
    const onError = vi.fn();
    const { fake, db } = setup({ onError });
    const handler = db.feedbackHandler({ authorize: signedIn });
    fake.override((request) =>
      request.path === "/v1/feedback"
        ? { status: 500, body: { error: { code: "internal", message: `stack trace near ${fake.apiKey} in postgres://db.example.com` } } }
        : undefined,
    );
    const response = await handler(browser("POST", { traceId: "t1", thumbs: "up" }));
    expect(response.status).toBe(502);
    const text = await response.text();
    expect(text).not.toContain(fake.apiKey);
    expect(text).not.toContain("postgres");
    expect(JSON.parse(text)).toEqual({ error: { code: "unavailable", message: "Feedback could not be saved right now." } });
    expect(onError).toHaveBeenCalledWith(expect.any(LittleDBError), { operation: "feedback" });

    fake.clearOverrides();
    const noTrace = await handler(browser("POST", { sessionId: "sess_none", thumbs: "up" }));
    expect(noTrace.status).toBe(404);
  });

  it("answers 500 when authorize throws", async () => {
    const onError = vi.fn();
    const { db } = setup({ onError });
    const handler = db.feedbackHandler({
      authorize: () => {
        throw new Error("session store down");
      },
    });
    const response = await handler(browser("POST", { traceId: "t1", thumbs: "up" }));
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("session store down");
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("needs an authorize function", () => {
    const { db } = setup();
    expect(() => db.feedbackHandler({} as never)).toThrow(/authorize/u);
  });
});
