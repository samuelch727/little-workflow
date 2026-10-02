import { tool } from "ai";
import { z } from "zod";
import { nextLedgerId, runToolCall } from "../tool-context";

/**
 * Send a replacement: one row in the exchanges ledger.
 *
 * Like every other mutating tool here it enforces nothing — not the 14-day window, not
 * delivery, not verification. See `refund_order.ts` for why.
 */
export default tool({
  description:
    "Exchange an item for a replacement. Writes an exchange row. Does not check the exchange window, delivery status, or verification.",
  inputSchema: z.object({
    orderId: z.string().describe("The order id to exchange."),
    replacementItem: z
      .string()
      .optional()
      .describe("What to send instead. Defaults to the same item."),
    reason: z.string().describe("One short sentence: why this exchange is being made."),
  }),
  execute: (input, options) =>
    runToolCall("exchange_item", { ...input }, options, ({ db }) => {
      const order = db.orders.find((entry) => entry.id === input.orderId);
      if (order === undefined) throw new Error(`No such order: ${input.orderId}`);

      const exchange = {
        id: nextLedgerId("EX", db.exchanges),
        orderId: order.id,
        replacementItem: input.replacementItem ?? order.item,
        reason: input.reason,
        at: new Date().toISOString(),
      };
      db.exchanges.push(exchange);

      return {
        result: {
          exchangeId: exchange.id,
          orderId: order.id,
          replacementItem: exchange.replacementItem,
          note: "Exchange recorded.",
        },
        outcome: { orderId: order.id, exchangeId: exchange.id },
        mutated: true,
      };
    }),
});
