import { tool } from "ai";
import { z } from "zod";
import { createEscalation } from "../data/store";

export const createEscalationInputSchema = z.object({
  customerId: z.string().min(1),
  severity: z.enum(["low", "medium", "high", "urgent"]),
  team: z.enum(["billing", "fulfillment", "engineering", "success"]),
  summary: z.string().min(1),
  evidence: z.array(z.string().min(1)),
});

export const escalationOutputSchema = z.object({
  escalationId: z.string().startsWith("esc_"),
  ownerTeam: z.enum(["billing", "fulfillment", "engineering", "success"]),
  priority: z.enum(["P0", "P1", "P2", "P3"]),
  sla: z.string(),
  discordSummary: z.string(),
  nextSteps: z.array(z.string()),
});

export default tool({
  description: "Create a deterministic escalation with owner team, priority, SLA, Discord-ready summary, and next steps.",
  inputSchema: createEscalationInputSchema,
  outputSchema: escalationOutputSchema,
  strict: true,
  execute: async (input) => createEscalation(input),
});
