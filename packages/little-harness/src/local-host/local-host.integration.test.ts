import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { createHarness } from "../create-harness.js";
import { generateHarness } from "../execution/generate-harness.js";
import { withTempDir } from "../test/temp.js";
import { localHost } from "./index.js";

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

/**
 * Settle window that exists only so a *broken* queue has time to reveal an extra model call.
 * Under correct queueing the state asserted after it ("exactly two calls in flight") holds until
 * the test releases a gate, so a slow machine can never turn a passing run into a failing one.
 */
const SETTLE_MS = 50;

type Deferred = { readonly promise: Promise<void>; readonly resolve: () => void };

function createDeferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((settleGate) => {
    resolve = settleGate;
  });
  return { promise, resolve };
}

type ModelArrival = {
  /** Turn tag, carried in the request payload so each call is identifiable. */
  readonly tag: string;
  /** In-flight `doGenerate` calls at the instant this one arrived, itself included. */
  readonly inFlightOnArrival: number;
};

/**
 * A model whose calls block until the test releases them by tag. Turn interleaving is therefore
 * driven by explicit events rather than wall-clock delays: the test can prove two calls genuinely
 * overlap (both in flight at the same instant) and that a third cannot start until it lets the
 * earlier one finish, with no dependence on how loaded the machine is.
 */
function createGatedModel(tags: readonly string[]) {
  const arrivals: ModelArrival[] = [];
  const gates = new Map<string, Deferred>();
  const arrivalWaiters = new Set<() => void>();
  let inFlight = 0;
  let peakInFlight = 0;

  const gateFor = (tag: string): Deferred => {
    const existing = gates.get(tag);
    if (existing) {
      return existing;
    }
    const created = createDeferred();
    gates.set(tag, created);
    return created;
  };

  const model = new MockLanguageModelV3({
    provider: "test",
    modelId: "gated",
    doGenerate: async ({ prompt }) => {
      const serialized = JSON.stringify(prompt);
      const tag = tags.find((candidate) => serialized.includes(candidate));
      if (tag === undefined) {
        throw new Error(`Gated model saw a request with no known tag: ${serialized}`);
      }

      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      arrivals.push({ tag, inFlightOnArrival: inFlight });
      for (const notify of [...arrivalWaiters]) {
        notify();
      }

      try {
        await gateFor(tag).promise;
        return {
          content: [{ type: "text", text: "ok" }],
          finishReason: { unified: "stop", raw: "stop" },
          usage,
          warnings: [],
        };
      } finally {
        inFlight -= 1;
      }
    },
  });

  return {
    model,
    arrivals: (): readonly ModelArrival[] => arrivals,
    inFlight: () => inFlight,
    peakInFlight: () => peakInFlight,
    release: (tag: string) => gateFor(tag).resolve(),
    /** Resolves once `count` calls have arrived; vitest's test timeout is the only backstop. */
    waitForArrivals: (count: number) =>
      new Promise<void>((resolve) => {
        const check = () => {
          if (arrivals.length < count) {
            return;
          }
          arrivalWaiters.delete(check);
          resolve();
        };
        arrivalWaiters.add(check);
        check();
      }),
  };
}

describe("Local Host integration", () => {
  it("queues same-session turns and allows different sessions", async () => {
    await withTempDir(async (dir) => {
      const gate = createGatedModel(["same-a", "same-b", "other"]);
      const harness = createHarness({
        host: localHost({ dataDir: dir }),
        model: gate.model,
      });

      const turns = [
        generateHarness({ harness, type: "x", input: { tag: "same-a" }, session: "same" }),
        generateHarness({ harness, type: "x", input: { tag: "same-b" }, session: "same" }),
        generateHarness({ harness, type: "x", input: { tag: "other" }, session: "other" }),
      ];

      // Exactly two turns can reach the model: the "other" session's, plus whichever of the two
      // "same" turns took the session lock first. Which of the pair wins is not guaranteed (the
      // first caller creates the session, the second loads it), so neither is named here. The
      // third turn is blocked by the session lock, so waiting for two arrivals cannot deadlock.
      await gate.waitForArrivals(2);
      await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));

      const overlapping = [...gate.arrivals()];
      expect(overlapping).toHaveLength(2);
      expect(gate.inFlight()).toBe(2);
      // The second call arrived while the first was still in flight: a real overlap, not two calls
      // that merely landed near each other in time.
      expect(overlapping.map((arrival) => arrival.inFlightOnArrival)).toEqual([1, 2]);
      expect(overlapping.map((arrival) => arrival.tag)).toContain("other");
      const sameSessionArrivals = overlapping.filter((arrival) => arrival.tag.startsWith("same-"));
      expect(sameSessionArrivals).toHaveLength(1);
      const ranFirst = sameSessionArrivals[0]!.tag;

      // Releasing the same-session turn that ran lets its queued sibling start — and only then.
      gate.release(ranFirst);
      await gate.waitForArrivals(3);

      const queued = gate.arrivals()[2]!;
      expect(queued.tag).toBe(ranFirst === "same-a" ? "same-b" : "same-a");
      // It arrived next to the still-gated "other" turn and nothing else, so its same-session
      // predecessor had to finish before it started: the queueing guarantee, stated positively.
      expect(queued.inFlightOnArrival).toBe(2);
      expect(gate.inFlight()).toBe(2);

      gate.release("other");
      gate.release(queued.tag);

      const results = await Promise.all(turns);
      expect(results.map((result) => result.status)).toEqual([
        "completed",
        "completed",
        "completed",
      ]);
      expect(gate.peakInFlight()).toBe(2);
    });
  });
});
