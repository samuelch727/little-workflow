import { tool } from "ai";
import { z } from "zod";
import { fetchRun } from "../littledb-api";

/**
 * How much of a run's event log to hand back in one tool result. The run detail is returned
 * verbatim — the control plane verifies quoted pushback against the real transcript, so any
 * rewriting here would produce citations that cannot be grounded — which means the only
 * safe way to bound it is to drop whole events, and to say so when that happens.
 */
const MAX_EVENT_CHARACTERS = 24_000;

/**
 * Read ONE run from the littleDB engine: `GET {engineUrl}/runs/{runId}` — the same route
 * `@little-workflow/littledb`'s own `loadRun` calls, returning `{ summary, events }`.
 *
 * This is the drill-down, and it is what a rejected citation is fixed from: the exact user
 * turn lives in these events, character for character.
 */
export default tool({
  description:
    "Load one run's full detail from the littleDB engine: its summary and its event log, verbatim. Use it to drill into a run an incident card left ambiguous, and — when a proposal is rejected with an unverified claim — to find the EXACT wording of the user's pushback so the citation can be corrected.",
  inputSchema: z.object({
    runId: z.string().describe("The run id, exactly as it appears in the evidence pack."),
  }),
  execute: async ({ runId }) => {
    const detail = (await fetchRun(runId)) as { summary?: unknown; events?: unknown };
    const events = Array.isArray(detail.events) ? detail.events : [];

    // Keep whole events from the END until the character budget is spent, then restore
    // chronological order.
    //
    // The direction is load-bearing. This tool's whole purpose is finding the exact wording
    // of a user's pushback, and pushback is by definition the LATEST thing in a run — it is
    // the turn correcting the answer. Dropping the tail to fit the budget would make a long
    // run's citation permanently unrepairable: the agent re-reads the run, cannot find the
    // quote, and is pushed into abandoning a claim that was true all along.
    //
    // Truncating WITHIN an event is never an option either: it would corrupt the very
    // strings a citation has to match character for character.
    const tail: unknown[] = [];
    let characters = 0;
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const rendered = JSON.stringify(events[index]) ?? "null";
      if (characters + rendered.length > MAX_EVENT_CHARACTERS && tail.length > 0) break;
      tail.push(events[index]);
      characters += rendered.length;
    }
    const kept = tail.reverse();

    return {
      runId,
      summary: detail.summary ?? null,
      eventCount: events.length,
      ...(kept.length === events.length
        ? {}
        : {
            truncated: {
              kept: kept.length,
              of: events.length,
              note: "The OLDEST whole events were dropped to fit the tool-result budget; the events returned are the most recent ones, unmodified.",
            },
          }),
      events: kept,
    };
  },
});
