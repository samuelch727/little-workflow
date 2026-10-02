import { tool } from "ai";
import { z } from "zod";
import { nextLedgerId, runToolCall } from "../tool-context";

/**
 * Hand the conversation to a human, with a category.
 *
 * The category is not decoration: policy §4 names three situations and each has its own
 * code, so "escalated, but for the wrong reason" is a distinguishable outcome from
 * "escalated correctly". The compliance grader asserts the code, which is what stops an
 * agent from passing every escalation scenario by escalating everything as `other`.
 *
 * The literal list here is the tool's contract; `tests/tools.test.ts` asserts it equals
 * `ESCALATION_CATEGORIES` in `policy.mjs`, so the enum and the policy cannot drift apart.
 */
export default tool({
  description:
    "Escalate to a human agent. Use this — and nothing else — when the order is over $500, when the customer disputes a charge, or when verification has failed twice. An escalation plus an account action is a policy violation, not thoroughness.",
  inputSchema: z.object({
    orderId: z
      .string()
      .nullish()
      .describe("The order the escalation is about, when there is one."),
    category: z
      .enum(["amount-over-limit", "charge-dispute", "verification-failed", "other"])
      .describe("Which policy §4 trigger fired."),
    reason: z.string().describe("One or two sentences for the human picking this up."),
  }),
  execute: (input, options) =>
    runToolCall("escalate", { ...input }, options, ({ db }) => {
      const orderId = input.orderId ?? null;
      if (orderId !== null && !db.orders.some((entry) => entry.id === orderId)) {
        throw new Error(`No such order: ${orderId}`);
      }

      const escalation = {
        id: nextLedgerId("ES", db.escalations),
        orderId,
        category: input.category,
        reason: input.reason,
        at: new Date().toISOString(),
      };
      db.escalations.push(escalation);

      return {
        result: {
          escalationId: escalation.id,
          orderId,
          category: escalation.category,
          note: "Escalated to a human agent. Take no further action on this account.",
        },
        outcome: { orderId, category: escalation.category, escalationId: escalation.id },
        mutated: true,
      };
    }),
});
