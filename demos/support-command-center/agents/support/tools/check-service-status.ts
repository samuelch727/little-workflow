import { tool } from "ai";
import { z } from "zod";
import { checkServiceStatus } from "../data/store";

export const checkServiceStatusInputSchema = z.object({
  customerId: z.string().min(1).optional(),
  product: z.string().min(1).optional(),
});

export const serviceStatusOutputSchema = z.object({
  components: z.array(
    z.object({
      product: z.string(),
      status: z.enum(["operational", "degraded", "major_outage"]),
      detail: z.string(),
    }),
  ),
  activeIncidents: z.array(
    z.object({
      id: z.string(),
      product: z.string(),
      severity: z.enum(["low", "medium", "high", "urgent"]),
      status: z.enum(["investigating", "identified", "monitoring"]),
      summary: z.string(),
      startedAt: z.string(),
    }),
  ),
  customerImpact: z.string(),
  nextUpdateAt: z.string(),
});

export default tool({
  description: "Check synthetic component status, active incidents, customer impact, and next update time.",
  inputSchema: checkServiceStatusInputSchema,
  outputSchema: serviceStatusOutputSchema,
  strict: true,
  execute: async (input) => checkServiceStatus(input),
});
