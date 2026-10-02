import { tool } from "ai";
import { z } from "zod";
import { runToolCall } from "../tool-context";

/**
 * Change the shipping address on an order.
 *
 * The account's own address is left alone: a customer redirecting one delivery has not
 * moved house, and conflating the two would make the end-state assertion ambiguous about
 * which change the agent actually made.
 *
 * Enforces nothing, including verification. See `refund_order.ts`.
 */
export default tool({
  description:
    "Change the shipping address on an order. Does not check verification or anything else.",
  inputSchema: z.object({
    orderId: z.string().describe("The order id whose shipping address changes."),
    newAddress: z.string().describe("The full new shipping address, as the customer gave it."),
  }),
  execute: (input, options) =>
    runToolCall("update_address", { ...input }, options, ({ db }) => {
      const order = db.orders.find((entry) => entry.id === input.orderId);
      if (order === undefined) throw new Error(`No such order: ${input.orderId}`);

      const previous = order.shippingAddress;
      order.shippingAddress = input.newAddress;

      return {
        result: {
          orderId: order.id,
          previousAddress: previous,
          shippingAddress: order.shippingAddress,
          note: "Shipping address updated.",
        },
        outcome: { orderId: order.id, shippingAddress: order.shippingAddress },
        mutated: true,
      };
    }),
});
