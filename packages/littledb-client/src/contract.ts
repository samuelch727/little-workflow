// Canonical source of truth for the littleDB control-plane wire contract.
// The littleDB service re-exports these schemas from here; a drift test in the
// littleDB repo guards against divergence between packages.
import { z } from "zod";

export const ConfigBundleSchema = z.object({
  prompt: z.string(),
  skills: z.array(z.string()),
  toolManifest: z.unknown(),
  modelSlot: z.string(),
  sampling: z.record(z.string(), z.unknown()),
  hyperparams: z.record(z.string(), z.unknown()),
  memoryPolicy: z.unknown(),
});
export type ConfigBundle = z.infer<typeof ConfigBundleSchema>;

export const ResolveConfigResponseSchema = z.object({
  configVersionId: z.string(),
  channel: z.string(),
  staleConfig: z.boolean(),
  config: ConfigBundleSchema,
});
export type ResolveConfigResponse = z.infer<typeof ResolveConfigResponseSchema>;

export const ReportOutcomeSchema = z.object({
  runId: z.string().min(1),
  status: z.enum(["success", "failure", "partial"]),
  score: z.number().optional(),
  detail: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type ReportOutcome = z.infer<typeof ReportOutcomeSchema>;
