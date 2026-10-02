import { tool } from "ai";
import { z } from "zod";
import { summarizeTicketHistory } from "../data/store";

export const summarizeTicketHistoryInputSchema = z.object({
  customerId: z.string().min(1),
  ticketId: z.string().min(1).optional(),
});

export const ticketHistoryOutputSchema = z.object({
  timeline: z.array(
    z.object({
      ticketId: z.string(),
      at: z.string(),
      actor: z.enum(["customer", "support", "system"]),
      summary: z.string(),
    }),
  ),
  sentimentTrend: z.string(),
  priorPromises: z.array(z.string()),
  unresolvedAsks: z.array(z.string()),
});

export default tool({
  description: "Summarize chronological synthetic ticket history, sentiment trend, prior promises, and unresolved asks.",
  inputSchema: summarizeTicketHistoryInputSchema,
  outputSchema: ticketHistoryOutputSchema,
  strict: true,
  execute: async (input) => summarizeTicketHistory(input),
});
