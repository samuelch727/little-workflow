import { tool } from "ai";
import { z } from "zod";
import { evaluateRefundPolicy } from "../data/store";

export const evaluateRefundPolicyInputSchema = z.object({
  customerId: z.string().min(1),
  orderId: z.string().min(1),
  requestedAmountUsd: z.number().nonnegative().optional(),
  reason: z.string().min(1),
});

export const refundPolicyOutputSchema = z.object({
  eligibility: z.enum(["ineligible", "eligible", "eligible_with_approval"]),
  maximumRefundUsd: z.number(),
  requiresApproval: z.boolean(),
  policyCitations: z.array(z.string()),
  riskNotes: z.array(z.string()),
  recommendedResolution: z.string(),
});

export default tool({
  description: "Evaluate deterministic refund eligibility, approval needs, policy citations, risk notes, and resolution.",
  inputSchema: evaluateRefundPolicyInputSchema,
  outputSchema: refundPolicyOutputSchema,
  strict: true,
  execute: async (input) => evaluateRefundPolicy(input),
});
