import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarness, generateHarness, localHost, reportHarnessOutcome, type HarnessOutcomeSink } from "@little-stack/harness";
import { createReactionOutcomeHandler } from "@little-stack/harness/connectors";
import { MockLanguageModelV3 } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLittleDB } from "../client.js";
import { fakeLittleDB } from "../test/fake-littledb.js";
import { outcomeFeedback, outcomeFeedbackId, type HarnessOutcomeEventLike } from "./outcome-sink.js";
import { turnTraceId } from "./tracer.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const event = (overrides: Partial<HarnessOutcomeEventLike> = {}): HarnessOutcomeEventLike => ({
  eventId: "evt_1",
  sessionId: "sess_1",
  status: "success",
  source: "programmatic",
  metadata: {},
  ...overrides,
});

function setup() {
  const fake = fakeLittleDB();
  const onError = vi.fn();
  const db = createLittleDB({ url: fake.url, apiKey: fake.apiKey, fetch: fake.fetch, onError });
  return { fake, db, onError };
}

const sentFeedback = (fake: ReturnType<typeof fakeLittleDB>) =>
  fake.requests.filter((request) => request.path === "/v1/feedback").map((request) => request.body as Record<string, unknown>);

describe("outcomeFeedback", () => {
  const target = { traceId: "t1" };

  it("makes success a thumbs up and failure a thumbs down", () => {
    expect(outcomeFeedback(event(), "id", "thumbs", target)).toMatchObject({ traceId: "t1", id: "id", name: "thumbs", thumbs: "up" });
    expect(outcomeFeedback(event({ status: "failure" }), "id", "thumbs", target)).toMatchObject({ thumbs: "down" });
  });

  it("makes partial a rating of 3 out of 5, and a 0..1 score a rating on the same scale", () => {
    const partial = outcomeFeedback(event({ status: "partial" }), "id", "thumbs", target);
    expect(partial).toMatchObject({ name: "thumbs", rating: { value: 3, scale: 5 } });
    expect(partial.thumbs).toBeUndefined();
    expect(outcomeFeedback(event({ status: "partial", score: 0.75 }), "id", "n", target).rating).toEqual({ value: 4, scale: 5 });
    expect(outcomeFeedback(event({ status: "failure", score: 0 }), "id", "n", target).rating).toEqual({ value: 1, scale: 5 });
    const outOfRange = outcomeFeedback(event({ status: "success", score: 4 }), "id", "n", target);
    expect(outOfRange).toMatchObject({ thumbs: "up", metadata: { outcome: { score: 4 } } });
    expect(outOfRange.rating).toBeUndefined();
  });

  it("carries the detail as the comment, the reporter as the user and the outcome in metadata", () => {
    const feedback = outcomeFeedback(
      event({
        detail: "Merged two of three members.",
        reporter: "anon_0123456789abcdef",
        stepPath: "draft",
        turnId: "turn_1",
        metadata: { surface: { platform: "slack", messageId: "m1" } },
      }),
      "id",
      "thumbs",
      target,
    );
    expect(feedback).toMatchObject({
      comment: "Merged two of three members.",
      userId: "anon_0123456789abcdef",
      metadata: {
        surface: { platform: "slack", messageId: "m1" },
        outcome: { status: "success", source: "programmatic", eventId: "evt_1", stepPath: "draft", turnId: "turn_1" },
      },
    });
    expect(outcomeFeedback(event({ detail: "   " }), "id", "thumbs", target).comment).toBeUndefined();
    const big = outcomeFeedback(event({ metadata: { blob: "x".repeat(5_000) } }), "id", "thumbs", target);
    expect(big.metadata).not.toHaveProperty("blob");
  });
});

describe("outcomeSink", () => {
  it("sends an outcome on a turn to the trace the tracer writes for that turn", async () => {
    const { fake, db } = setup();
    const sink = db.outcomeSink();
    expect(sink.name).toBe("littledb");
    expect(await sink.deliver(event({ turnId: "turn_9", reportKey: "review:1", reporter: "u_1" }))).toEqual({ ok: true });
    expect(sentFeedback(fake)).toEqual([
      expect.objectContaining({
        traceId: turnTraceId("sess_1", "turn_9"),
        id: outcomeFeedbackId("sess_1", "review:1"),
        name: "thumbs",
        thumbs: "up",
        userId: "u_1",
      }),
    ]);
  });

  it("sends an outcome with no turn to the session's latest trace", async () => {
    const { fake, db } = setup();
    db.ingest({ traces: [{ id: "lh_latest", sessionId: "sess_1", startTime: "2026-10-01T00:00:00.000Z" }] });
    await db.outcomeSink({ feedbackName: "user_feedback" }).deliver(event({ status: "failure" }));
    expect(sentFeedback(fake)[0]).toMatchObject({ sessionId: "sess_1", name: "user_feedback", thumbs: "down" });
    expect([...fake.feedback.values()][0]).toMatchObject({ traceId: "lh_latest", name: "user_feedback", value: 0 });
  });

  it("asks the tracer it is given for the trace ids", async () => {
    const { fake, db } = setup();
    const tracer = { traceIdFor: () => "custom_latest", traceIdForTurn: (sessionId: string, turnId: string) => `custom_${sessionId}_${turnId}` };
    const sink = db.outcomeSink({ tracer, name: "feedback" });
    await sink.deliver(event({ turnId: "t" }));
    await sink.deliver(event({ eventId: "evt_2" }));
    expect(sentFeedback(fake).map((body) => body.traceId)).toEqual(["custom_sess_1_t", "custom_latest"]);
    expect(sink.name).toBe("feedback");
  });

  it("withdraws a report when it is retracted", async () => {
    const { fake, db } = setup();
    const sink = db.outcomeSink();
    await sink.deliver(event({ turnId: "t", reportKey: "k" }));
    expect(fake.feedback.size).toBe(1);
    expect(await sink.deliver(event({ turnId: "t", reportKey: "k", retracted: true }))).toEqual({ ok: true });
    expect(fake.requests.at(-1)).toMatchObject({ method: "DELETE", path: `/v1/feedback/${outcomeFeedbackId("sess_1", "k")}` });
    expect(fake.feedback.size).toBe(0);
  });

  it("keeps a toggled reaction: a trailing removal of the old one withdraws nothing", async () => {
    const { fake, db } = setup();
    const sink = db.outcomeSink();
    await sink.deliver(event({ reportKey: "k", turnId: "t", status: "success" }));
    await sink.deliver(event({ reportKey: "k", turnId: "t", status: "failure" }));
    await sink.deliver(event({ reportKey: "k", turnId: "t", status: "success", retracted: true }));
    expect(fake.requests.some((request) => request.method === "DELETE")).toBe(false);
    expect([...fake.feedback.values()].map((score) => score.value)).toEqual([0]);
  });

  it("withdraws a report it did not see sent (after a restart), and treats a retraction with no key as done", async () => {
    const { fake, db } = setup();
    expect(await db.outcomeSink().deliver(event({ reportKey: "k", retracted: true }))).toEqual({ ok: true });
    expect(fake.requests.at(-1)?.method).toBe("DELETE");
    const before = fake.requests.length;
    expect(await db.outcomeSink().deliver(event({ retracted: true }))).toEqual({ ok: true });
    expect(fake.requests).toHaveLength(before);
  });

  it("sends a report's revision, so LittleDB turns away a late, older one", async () => {
    const { fake, db } = setup();
    const sink = db.outcomeSink();
    const id = outcomeFeedbackId("sess_1", "k");
    // A down at 2 lands first; the up at 1, whose answer was lost, lands after it.
    expect(await sink.deliver(event({ reportKey: "k", turnId: "t", status: "failure", revision: 2 }))).toEqual({ ok: true });
    expect(await sink.deliver(event({ reportKey: "k", turnId: "t", status: "success", revision: 1 }))).toEqual({ ok: true, stale: true });
    expect(sentFeedback(fake).map((body) => body.revision)).toEqual([2, 1]);
    expect([...fake.feedback.values()].map((score) => score.value)).toEqual([0]);
    // The same report again, from a retry that recorded a new event: a repeat, not a conflict.
    expect(await sink.deliver(event({ eventId: "evt_retry", reportKey: "k", turnId: "t", status: "failure", revision: 2 }))).toEqual({ ok: true });
    // A different report at the same revision is refused.
    expect(await sink.deliver(event({ reportKey: "k", turnId: "t", status: "success", revision: 2 }))).toEqual({ ok: false });
    expect([...fake.feedback.values()].map((score) => score.value)).toEqual([0]);
    // A retraction goes with its revision, and keeps it: the down at 2 retried later stays out.
    expect(await sink.deliver(event({ reportKey: "k", turnId: "t", status: "failure", retracted: true, revision: 3 }))).toEqual({ ok: true });
    expect(fake.requests.at(-1)).toMatchObject({ method: "DELETE", path: `/v1/feedback/${id}?revision=3` });
    expect(await sink.deliver(event({ reportKey: "k", turnId: "t", status: "failure", revision: 2 }))).toEqual({ ok: true, stale: true });
    expect(await sink.deliver(event({ reportKey: "k", turnId: "t", status: "failure", retracted: true, revision: 2 }))).toEqual({ ok: true, stale: true });
    // Without a revision, below every revision: it changes nothing on this id.
    expect(await sink.deliver(event({ reportKey: "k", turnId: "t", status: "failure" }))).toEqual({ ok: true, stale: true });
    expect(fake.feedback.size).toBe(0);
  });

  it("with a revision, sends a retraction whatever it last sent, and LittleDB decides", async () => {
    const { fake, db } = setup();
    const sink = db.outcomeSink();
    await sink.deliver(event({ reportKey: "k", turnId: "t", status: "success", revision: 1 }));
    await sink.deliver(event({ reportKey: "k", turnId: "t", status: "failure", revision: 2 }));
    // The up's removal, numbered after the down: it withdraws the down, as the caller ordered.
    await sink.deliver(event({ reportKey: "k", turnId: "t", status: "success", retracted: true, revision: 3 }));
    expect(fake.requests.at(-1)?.method).toBe("DELETE");
    expect(fake.feedback.size).toBe(0);
    // Numbered before the down, the same removal changes nothing.
    await sink.deliver(event({ reportKey: "j", turnId: "t", status: "failure", revision: 5 }));
    await sink.deliver(event({ reportKey: "j", turnId: "t", status: "success", retracted: true, revision: 4 }));
    expect([...fake.feedback.values()].map((score) => score.value)).toEqual([0]);
  });

  it("never throws: a failure is reported and answered with ok: false", async () => {
    const { fake, db, onError } = setup();
    fake.override(() => ({ status: 503, body: { error: { code: "unavailable", message: "down" } } }));
    const sink = db.outcomeSink();
    await expect(sink.deliver(event({ turnId: "t" }))).resolves.toEqual({ ok: false });
    await expect(sink.deliver(event({ reportKey: "k", retracted: true }))).resolves.toEqual({ ok: false });
    const broken = db.outcomeSink({
      tracer: {
        traceIdFor: () => undefined,
        traceIdForTurn: () => {
          throw new Error("no such turn");
        },
      },
    });
    await expect(broken.deliver(event({ turnId: "t" }))).resolves.toEqual({ ok: false });
    expect(onError).toHaveBeenCalledTimes(3);
    expect(onError.mock.calls.every(([, context]) => context.operation === "feedback")).toBe(true);
  });
});

describe("outcomeSink with Little Harness", () => {
  async function harness() {
    const dir = await mkdtemp(join(tmpdir(), "ldb-outcomes-"));
    dirs.push(dir);
    return { dir, model: new MockLanguageModelV3({
      doGenerate: async () => ({
        content: [{ type: "text", text: "Done." }],
        finishReason: { unified: "stop", raw: "end_turn" },
        usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
        warnings: [],
      }),
    }) };
  }

  it("takes a reported outcome to the turn the tracer traced", async () => {
    const { fake, db } = setup();
    const { dir, model } = await harness();
    const tracer = db.harnessTracer({ harness: "support" });
    const agent = createHarness({ host: localHost({ dataDir: dir }), model, runtime: { bash: false }, onEvent: tracer.onEvent });
    const result = await generateHarness({ harness: agent, session: "ticket:1", prompt: "Hi" });
    const sink: HarnessOutcomeSink = db.outcomeSink({ tracer });
    const reported = await reportHarnessOutcome({ session: result.session, status: "partial", detail: "Half right.", sinks: [sink] });
    expect(reported).toMatchObject({ delivered: 1, failed: 0 });
    expect(sentFeedback(fake)[0]).toMatchObject({
      traceId: tracer.traceIdFor("ticket:1"),
      rating: { value: 3, scale: 5 },
      comment: "Half right.",
      metadata: { outcome: { source: "programmatic", status: "partial" } },
    });
  });

  it("turns chat reactions into thumbs, and keeps the latest one when a person changes their mind", async () => {
    const { fake, db } = setup();
    const { dir, model } = await harness();
    const tracer = db.harnessTracer({ harness: "support" });
    const agent = createHarness({ host: localHost({ dataDir: dir }), model, runtime: { bash: false }, onEvent: tracer.onEvent });
    await generateHarness({ harness: agent, session: "slack:T1", prompt: "Hi" });
    const onReaction = createReactionOutcomeHandler({
      harness: agent,
      adapterName: "slack",
      reactions: { sinks: [db.outcomeSink({ tracer })] },
    });
    const react = (emoji: string, added: boolean) =>
      onReaction({ added, emoji, messageId: "m1", threadId: "T1", user: { userId: "U1" }, message: { author: { isMe: true } } } as never);

    await react("thumbs_up", true);
    expect([...fake.feedback.values()]).toEqual([
      expect.objectContaining({ traceId: tracer.traceIdFor("slack:T1"), name: "thumbs", value: 1, author: expect.stringMatching(/^anon_[0-9a-f]{16}$/u) }),
    ]);
    await react("thumbs_down", true);
    await react("thumbs_up", false);
    expect([...fake.feedback.values()].map((score) => score.value)).toEqual([0]);
    await react("thumbs_down", false);
    expect(fake.feedback.size).toBe(0);
  });
});
