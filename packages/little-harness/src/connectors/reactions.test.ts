import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createHarness } from "../create-harness.js";
import { localHost } from "../local-host/index.js";
import { aggregateOutcomes, outcomeEventFromTrace } from "../outcomes/aggregate.js";
import type { HarnessOutcomeSink } from "../outcomes/types.js";
import type { ChatSdkReactionEvent } from "./descriptors.js";
import {
  classifyReaction,
  createReactionOutcomeHandler,
  pseudonymousReporterId,
} from "./reactions.js";

const model = { modelId: "mock", specificationVersion: "v2", provider: "mock" } as any;

async function harnessWithSession(sessionId = "slack:T1") {
  const dataDir = join(await mkdtemp(join(tmpdir(), "lh-reactions-")), ".little-harness");
  const harness = createHarness({ host: localHost({ dataDir }), model });
  const session = await harness.sessions.getOrCreate({ id: sessionId });
  return { harness, tracePath: session.trace.path! };
}

function reaction(
  overrides: Partial<Record<keyof ChatSdkReactionEvent, unknown>> = {},
): ChatSdkReactionEvent {
  return {
    added: true,
    emoji: { name: "thumbs_down", toString: () => ":-1:" },
    rawEmoji: "-1",
    messageId: "m1",
    threadId: "T1",
    user: { userId: "U1", isMe: false },
    message: { id: "m1", author: { userId: "BOT", isMe: true } },
    ...overrides,
  } as ChatSdkReactionEvent;
}

async function outcomesIn(tracePath: string) {
  const text = await readFile(tracePath, "utf8").catch(() => "");
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as any)
    .map((event) => outcomeEventFromTrace(event))
    .filter((event): event is NonNullable<typeof event> => event !== undefined);
}

describe("classifyReaction", () => {
  it("reads a thumbs up as success and a thumbs down as failure", () => {
    expect(classifyReaction(reaction({ emoji: { name: "thumbs_up", toString: () => "" } }))).toBe(
      "success",
    );
    expect(classifyReaction(reaction())).toBe("failure");
  });

  it("accepts raw platform spellings the SDK did not normalize", () => {
    expect(classifyReaction(reaction({ emoji: ":+1:", rawEmoji: "+1" }))).toBe("success");
    expect(classifyReaction(reaction({ emoji: "👎", rawEmoji: "👎" }))).toBe("failure");
  });

  it("ignores every emoji that is not a configured verdict", () => {
    expect(classifyReaction(reaction({ emoji: "tada", rawEmoji: "🎉" }))).toBeUndefined();
  });

  it("honours a custom vocabulary", () => {
    const options = { positive: ["ship_it"], negative: ["rotating_light"] };
    expect(classifyReaction(reaction({ emoji: "ship_it" }), options)).toBe("success");
    // The defaults are REPLACED, not extended, when a vocabulary is supplied.
    expect(classifyReaction(reaction({ emoji: "thumbs_up", rawEmoji: "+1" }), options)).toBeUndefined();
  });
});

describe("pseudonymousReporterId", () => {
  it("is a stable pseudonym that contains no handle or raw user id", () => {
    const id = pseudonymousReporterId("slack", "U0123SAM");
    expect(id).toMatch(/^anon_[0-9a-f]{16}$/u);
    expect(id).toBe(pseudonymousReporterId("slack", "U0123SAM"));
    expect(id).not.toContain("U0123SAM");
    expect(pseudonymousReporterId("discord", "U0123SAM")).not.toBe(id);
  });
});

describe("reaction outcome handler", () => {
  it("lands a thumbs-down in the trace as outcome.reported, joined to the session", async () => {
    const { harness, tracePath } = await harnessWithSession();
    const handle = createReactionOutcomeHandler({ harness, adapterName: "slack" });

    await handle(reaction());

    const [outcome] = await outcomesIn(tracePath);
    expect(outcome).toMatchObject({
      sessionId: "slack:T1",
      status: "failure",
      source: "chat-sdk",
      reporter: pseudonymousReporterId("slack", "U1"),
    });
    expect(outcome?.metadata).toEqual({
      surface: {
        platform: "slack",
        threadId: "T1",
        messageId: "m1",
        reaction: "thumbs_down",
        added: true,
      },
    });
  });

  it("stores no handle, display name, or raw user id anywhere in the event", async () => {
    const { harness, tracePath } = await harnessWithSession();
    const handle = createReactionOutcomeHandler({ harness, adapterName: "slack" });

    await handle(
      reaction({ user: { userId: "U0123SAM", isMe: false }, raw: { user_name: "sam" } }),
    );

    const written = await readFile(tracePath, "utf8");
    expect(written).not.toContain("U0123SAM");
    expect(written).not.toContain("sam");
  });

  it("skips the bot's own reaction and reactions on messages the agent did not write", async () => {
    const { harness, tracePath } = await harnessWithSession();
    const handle = createReactionOutcomeHandler({ harness, adapterName: "slack" });

    await handle(reaction({ user: { userId: "BOT", isMe: true } }));
    await handle(reaction({ message: { id: "m1", author: { userId: "U2", isMe: false } } }));

    expect(await outcomesIn(tracePath)).toHaveLength(0);
  });

  it("still records when the platform does not attach the reacted-to message", async () => {
    const { harness, tracePath } = await harnessWithSession();
    const handle = createReactionOutcomeHandler({ harness, adapterName: "slack" });

    await handle(reaction({ message: undefined }));

    expect(await outcomesIn(tracePath)).toHaveLength(1);
  });

  it("a thumbs-down toggled to a thumbs-up nets one success with a sample size of one", async () => {
    const { harness, tracePath } = await harnessWithSession();
    const handle = createReactionOutcomeHandler({ harness, adapterName: "slack" });

    // Slack's toggle: the 👎 is removed and a 👍 is added.
    await handle(reaction());
    await handle(reaction({ added: false }));
    await handle(reaction({ emoji: { name: "thumbs_up", toString: () => "" }, rawEmoji: "+1" }));

    const events = await outcomesIn(tracePath);
    // Every report is retained — the trace is append-only.
    expect(events).toHaveLength(3);

    const report = aggregateOutcomes(events);
    expect(report.overall).toEqual({ n: 1, success: 1, failure: 0, partial: 0, successRate: 1 });
  });

  it("nets to nothing when a lone thumbs-down is simply un-clicked", async () => {
    const { harness, tracePath } = await harnessWithSession();
    const handle = createReactionOutcomeHandler({ harness, adapterName: "slack" });

    await handle(reaction());
    await handle(reaction({ added: false }));

    const report = aggregateOutcomes(await outcomesIn(tracePath));
    expect(report.eventCount).toBe(2);
    expect(report.overall.n).toBe(0);
    expect(report.overall.successRate).toBeNull();
  });

  it("counts a double-click of the same reaction once", async () => {
    const { harness, tracePath } = await harnessWithSession();
    const handle = createReactionOutcomeHandler({ harness, adapterName: "slack" });

    await handle(reaction());
    await handle(reaction());

    const report = aggregateOutcomes(await outcomesIn(tracePath));
    expect(report.eventCount).toBe(2);
    expect(report.overall).toEqual({ n: 1, success: 0, failure: 1, partial: 0, successRate: 0 });
  });

  it("keeps two raters on the same message as two data points", async () => {
    const { harness, tracePath } = await harnessWithSession();
    const handle = createReactionOutcomeHandler({ harness, adapterName: "slack" });

    await handle(reaction({ user: { userId: "U1", isMe: false } }));
    await handle(
      reaction({
        user: { userId: "U2", isMe: false },
        emoji: { name: "thumbs_up", toString: () => "" },
        rawEmoji: "+1",
      }),
    );

    const report = aggregateOutcomes(await outcomesIn(tracePath));
    expect(report.overall).toEqual({ n: 2, success: 1, failure: 1, partial: 0, successRate: 0.5 });
  });

  it("drops removals entirely when onRemoved is 'ignore'", async () => {
    const { harness, tracePath } = await harnessWithSession();
    const handle = createReactionOutcomeHandler({
      harness,
      adapterName: "slack",
      reactions: { onRemoved: "ignore" },
    });

    await handle(reaction());
    await handle(reaction({ added: false }));

    const report = aggregateOutcomes(await outcomesIn(tracePath));
    expect(report.eventCount).toBe(1);
    expect(report.overall.n).toBe(1);
  });

  it("delivers to sinks and reports the result without ever throwing", async () => {
    const { harness } = await harnessWithSession();
    const deliver = vi.fn(async () => ({ ok: true }));
    const sink: HarnessOutcomeSink = { name: "littledb", deliver };
    const onOutcome = vi.fn();
    const handle = createReactionOutcomeHandler({
      harness,
      adapterName: "slack",
      reactions: { sinks: [sink], onOutcome },
    });

    await handle(reaction());

    expect(deliver).toHaveBeenCalledTimes(1);
    expect(onOutcome.mock.calls[0]?.[0]).toMatchObject({ recorded: true, delivered: 1, failed: 0 });
  });

  it("swallows a broken session lookup — a reaction can never break the chat handler", async () => {
    const brokenHarness = {
      sessions: {
        get: async () => {
          throw new Error("store is down");
        },
      },
    } as never;
    const handle = createReactionOutcomeHandler({ harness: brokenHarness, adapterName: "slack" });

    await expect(handle(reaction())).resolves.toBeUndefined();
  });

  it("swallows a throwing onOutcome observer", async () => {
    const { harness } = await harnessWithSession();
    const handle = createReactionOutcomeHandler({
      harness,
      adapterName: "slack",
      reactions: {
        onOutcome: () => {
          throw new Error("observer exploded");
        },
      },
    });

    await expect(handle(reaction())).resolves.toBeUndefined();
  });

  it("honours a custom session resolver and a custom pseudonym", async () => {
    const { harness, tracePath } = await harnessWithSession("custom-session");
    const handle = createReactionOutcomeHandler({
      harness,
      adapterName: "slack",
      reactions: {
        session: () => "custom-session",
        reporterId: () => "rater_7",
      },
    });

    await handle(reaction());

    const [outcome] = await outcomesIn(tracePath);
    expect(outcome).toMatchObject({ sessionId: "custom-session", reporter: "rater_7" });
  });

  it("skips entirely when a custom session resolver cannot attribute the thread", async () => {
    const { harness, tracePath } = await harnessWithSession();
    const handle = createReactionOutcomeHandler({
      harness,
      adapterName: "slack",
      reactions: { session: () => undefined },
    });

    await handle(reaction());

    // No silent fallback to `<adapter>:<threadId>`: the resolver owns the mapping.
    expect(await outcomesIn(tracePath)).toHaveLength(0);
  });

  it("records no reporter when the app opts out, but still separates raters", async () => {
    const { harness, tracePath } = await harnessWithSession();
    const handle = createReactionOutcomeHandler({
      harness,
      adapterName: "slack",
      reactions: { reporterId: () => undefined },
    });

    await handle(reaction({ user: { userId: "U1", isMe: false } }));
    await handle(reaction({ user: { userId: "U2", isMe: false } }));

    const events = await outcomesIn(tracePath);
    expect(events.every((event) => event.reporter === undefined)).toBe(true);
    expect(aggregateOutcomes(events).overall.n).toBe(2);
  });
});
