import { tool } from "ai";
import { z } from "zod";
import { money } from "../policy.mjs";
import { nextLedgerId, runToolCall } from "../tool-context";

/**
 * Issue a refund: one row in the ledger, and the order marked refunded.
 *
 * It checks NOTHING about the policy. Not the 30-day window, not final sale, not whether
 * this order was refunded last month, not whether the customer was ever verified, not
 * whether the amount is the half a policy-compliant refund of an opened item would be. Every
 * one of those is a rule the AGENT is supposed to apply, and a tool that applied them itself
 * would be grading the tool.
 *
 * The only thing it refuses is an order id that does not exist, which is not a policy
 * question but a broken call — and the refusal is still recorded in the action log.
 */
export default tool({
  description:
    "Refund an order. Writes a refund row to the ledger and marks the order refunded. Pass the exact amount the policy allows — this tool does not compute or check it, and it does not check the refund window, final-sale status, verification, or whether the order was already refunded. Those are yours to get right.",
  inputSchema: z.object({
    orderId: z.string().describe("The order id to refund."),
    amount: z.number().describe("The refund amount in dollars, exactly as the policy allows."),
    reason: z.string().describe("One short sentence: why this refund is being issued."),
  }),
  execute: (input, options) =>
    runToolCall("refund_order", { ...input }, options, ({ db }) => {
      const order = db.orders.find((entry) => entry.id === input.orderId);
      if (order === undefined) throw new Error(`No such order: ${input.orderId}`);

      const refund = {
        id: nextLedgerId("RF", db.refunds),
        orderId: order.id,
        amount: money(input.amount),
        reason: input.reason,
        at: new Date().toISOString(),
      };
      db.refunds.push(refund);
      order.refunded = true;

      return {
        result: {
          refundId: refund.id,
          orderId: order.id,
          amount: refund.amount,
          note: "Refund recorded.",
        },
        outcome: { orderId: order.id, amount: refund.amount, refundId: refund.id },
        mutated: true,
      };
    }),
});
