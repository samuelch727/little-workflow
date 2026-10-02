import { describe, expect, it } from "vitest";
import {
  SIDE_CHANNEL_BASE,
  SIDE_CHANNEL_MIN,
  isSideChannelSequence,
  nextSideChannelSequence,
} from "./sequence.js";

describe("side-channel sequence allocation", () => {
  it("mirrors littleDB's reserved bands so the two planes agree on the numbering", () => {
    expect(SIDE_CHANNEL_BASE.outcome).toBe(3_000_000_000_000_000);
    expect(SIDE_CHANNEL_BASE.judge).toBe(4_000_000_000_000_000);
    expect(SIDE_CHANNEL_MIN).toBe(SIDE_CHANNEL_BASE.outcome);
  });

  it("allocates inside the outcome band, clear of run sequences and of judge scores", () => {
    const sequence = nextSideChannelSequence("outcome");
    expect(sequence).toBeGreaterThan(SIDE_CHANNEL_BASE.outcome);
    expect(sequence).toBeLessThan(SIDE_CHANNEL_BASE.judge);
    expect(Number.isSafeInteger(sequence)).toBe(true);
    // A run would need >3e15 events to reach the band.
    expect(isSideChannelSequence(1)).toBe(false);
    expect(isSideChannelSequence(999_999)).toBe(false);
    expect(isSideChannelSequence(sequence)).toBe(true);
  });

  it("is strictly increasing within a process even inside one millisecond", () => {
    const frozenClock = () => 1_800_000_000_000;
    const first = nextSideChannelSequence("outcome", frozenClock);
    const second = nextSideChannelSequence("outcome", frozenClock);
    const third = nextSideChannelSequence("outcome", frozenClock);
    expect(second).toBeGreaterThan(first);
    expect(third).toBeGreaterThan(second);
  });

  it("never re-issues a slot when the clock jumps backwards", () => {
    const ahead = nextSideChannelSequence("outcome", () => 1_900_000_000_000);
    const behind = nextSideChannelSequence("outcome", () => 1_000_000_000_000);
    expect(behind).toBeGreaterThan(ahead);
  });
});
