/**
 * Sequence allocation for *side-channel* trace events — events an observer writes onto an
 * existing run after the fact (`outcome.reported`) rather than events the run emitted.
 *
 * ── Why a reserved band ──────────────────────────────────────────────────────
 * A trace is an append-only NDJSON stream whose ordering key is `sequence`; run events are
 * numbered 1, 2, 3, … by the host's trace writer, which resumes from the last sequence it
 * finds in the file. If an outcome simply took "last + 1" it would (a) tie with a run event
 * appended concurrently, and (b) permanently shift every later run event's numbering.
 *
 * So outcomes take their slot from a reserved band far above any real trace sequence, and
 * `LocalTrace.readLastSequence` skips the band when it resumes run numbering. The bases are
 * the same ones littleDB reserves in `viewer/src/server/sideChannelSequence.ts`, so a locally
 * traced outcome and a control-plane-ingested one occupy the same numeric neighbourhood:
 *
 *     sequence = SIDE_CHANNEL_BASE.outcome + (ms since 2020-01-01, strictly increasing)
 *
 * Why it cannot collide:
 *   - with run trace events: those start at 1 and increment per event, so a session would
 *     need >3e15 events to reach the band;
 *   - with littleDB's judge scores: that producer owns band 4e15, 1e15 away;
 *   - within this process: the slot is strictly increasing (see `last`), so a burst of
 *     outcomes — including a thumbs-down toggled to a thumbs-up in the same millisecond —
 *     gets distinct, correctly ordered sequences.
 *
 * Everything stays below `Number.MAX_SAFE_INTEGER` (9.007e15) because sequences cross the
 * wire as JSON numbers.
 *
 * Residual risk, accepted deliberately and inherited from the littleDB scheme: two separate
 * processes writing an outcome for the same session in the same millisecond can allocate the
 * same sequence. Both lines are still appended (append-only file, distinct `eventId`s), and
 * the aggregation reader keys on `eventId`/`reportKey`, not on sequence — so the cost is a
 * tie in ordering, never a lost or corrupted event.
 */

/** Slot origin. Keeps the offset small (~2e11 today) instead of ~1.8e12. */
const SIDE_CHANNEL_EPOCH_MS = Date.UTC(2020, 0, 1);

/** Reserved band per side-channel producer, mirroring littleDB. Bands are 1e15 apart. */
export const SIDE_CHANNEL_BASE = {
  outcome: 3_000_000_000_000_000,
  judge: 4_000_000_000_000_000,
} as const;

export type SideChannelKind = keyof typeof SIDE_CHANNEL_BASE;

/** Lowest sequence reserved for side-channel events; real trace events stay below it. */
export const SIDE_CHANNEL_MIN = SIDE_CHANNEL_BASE.outcome;

/**
 * Last slot handed out by this process, shared across kinds so allocation is strictly
 * increasing regardless of which producer asks — and so a clock that goes backwards (NTP
 * correction, container clock skew) can never re-issue a slot.
 */
let last = 0;

/** Allocate the next non-colliding sequence for a side-channel trace event. */
export function nextSideChannelSequence(
  kind: SideChannelKind,
  now: () => number = Date.now,
): number {
  const slot = Math.max(now() - SIDE_CHANNEL_EPOCH_MS, last + 1);
  last = slot;
  return SIDE_CHANNEL_BASE[kind] + slot;
}

/** True for a sequence allocated by {@link nextSideChannelSequence}. */
export function isSideChannelSequence(sequence: number): boolean {
  return sequence >= SIDE_CHANNEL_MIN;
}
