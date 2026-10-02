import { tool } from "ai";
import { z } from "zod";
import { lookupOrders } from "../data/store";

export const lookupOrdersInputSchema = z.object({
  customerId: z.string().min(1),
});

export const orderSchema = z.object({
  id: z.string(),
  customerId: z.string(),
  placedAt: z.string(),
  fulfillmentState: z.enum(["processing", "shipped", "delayed", "delivered"]),
  paymentState: z.enum(["authorized", "paid", "failed", "disputed"]),
  refundState: z.enum(["none", "requested", "approved", "issued", "denied"]),
  subtotalUsd: z.number(),
  taxUsd: z.number(),
  shippingUsd: z.number(),
  totalUsd: z.number(),
});

export default tool({
  description: "Return recent synthetic customer orders sorted newest first with payment, fulfillment, and refund state.",
  inputSchema: lookupOrdersInputSchema,
  outputSchema: z.array(orderSchema),
  strict: true,
  execute: async (input) => lookupOrders(input),
});
