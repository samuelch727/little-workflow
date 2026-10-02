import { tool } from "ai";
import { z } from "zod";
import { lookupCustomer } from "../data/store";

export const lookupCustomerInputSchema = z.object({
  query: z.string().min(1),
});

export const customerProfileSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  tier: z.enum(["startup", "growth", "enterprise"]),
  health: z.enum(["healthy", "watch", "at_risk"]),
  lifetimeValueUsd: z.number(),
  products: z.array(z.string()),
  openTicketIds: z.array(z.string()),
  riskFlags: z.array(z.string()),
  preferredTone: z.string(),
});

export default tool({
  description: "Look up a synthetic customer profile by id, name, email, or open ticket id.",
  inputSchema: lookupCustomerInputSchema,
  outputSchema: customerProfileSchema.optional(),
  strict: true,
  execute: async (input) => lookupCustomer(input),
});
