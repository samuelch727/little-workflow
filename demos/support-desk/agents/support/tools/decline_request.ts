import { tool } from "ai";
import { z } from "zod";
import { nextLedgerId, runToolCall } from "../tool-context";

/**
 * Record that a request was turned down, and under which rule.
 *
 * This tool exists for a grading reason, and it is worth stating plainly. Task success in
 * this demo is read from the database's END STATE. Without a recorded declination, "the
 * agent correctly refused an out-of-window refund" and "the agent did nothing at all" leave
 * byte-identical databases — so every refusal scenario would be passed by a null agent that
 * never made a single call. That is the exact failure the ABC checklist flags in τ-bench
 * itself (empty responses counted as successes; arXiv:2507.02825), and
 * `evals-research-synthesis-2026-08.md` §7 makes "null agents must score 0 on every suite" a
 * design requirement rather than a nicety.
 *
 * Requiring a REASON CODE is what stops the opposite degenerate strategy. An agent that
 * declines everything would pass the refusal scenarios on end state alone; it cannot pass
 * the compliance predicate, which asserts the code names the rule that actually applies.
 *
 * Recording a declination is also honest support-desk practice: a refusal nobody logged is
 * invisible to the business, which is what policy §5 says.
 */
export default tool({
  description:
    "Record that you are turning a request down, with the reason code for the rule you applied. Every refusal must be recorded — a refusal you only say out loud leaves no trace and reads to the business as if you did nothing.",
  inputSchema: z.object({
    orderId: z.string().nullish().describe("The order the request was about, when there is one."),
    reason: z
      .enum([
        "out-of-window",
        "not-delivered",
        "final-sale",
        "already-refunded",
        "exchange-window",
        "unverified",
        "other",
      ])
      .describe("The rule you applied. Pick the one that actually decided it."),
    explanation: z.string().describe("One or two sentences, in the words you gave the customer."),
  }),
  execute: (input, options) =>
    runToolCall("decline_request", { ...input }, options, ({ db }) => {
      const orderId = input.orderId ?? null;
      if (orderId !== null && !db.orders.some((entry) => entry.id === orderId)) {
        throw new Error(`No such order: ${orderId}`);
      }

      const decline = {
        id: nextLedgerId("DC", db.declines),
        orderId,
        reason: input.reason,
        explanation: input.explanation,
        at: new Date().toISOString(),
      };
      db.declines.push(decline);

      return {
        result: {
          declineId: decline.id,
          orderId,
          reason: decline.reason,
          note: "Declination recorded.",
        },
        outcome: { orderId, reason: decline.reason, declineId: decline.id },
        mutated: true,
      };
    }),
});
