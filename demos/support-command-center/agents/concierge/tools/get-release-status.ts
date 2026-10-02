import { tool } from "ai";
import { z } from "zod";
import { getReleaseStatus } from "../data/releases";

export const releaseSnapshotSchema = z.object({
  version: z.string(),
  stage: z.string(),
  health: z.enum(["healthy", "degraded", "down"]),
  metrics: z.array(
    z.object({
      label: z.string(),
      value: z.string(),
      trend: z.enum(["up", "down", "flat"]),
    }),
  ),
  incidents: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      severity: z.string(),
      status: z.string(),
    }),
  ),
});

/**
 * Shared base tool, available on every connector. Returns the deploy/release
 * status for a version (stage, health, key metrics, open incidents).
 */
export default tool({
  description:
    "Look up the deploy/release status — stage, health, key metrics, and open incidents — for a release version. Omit the version to get the latest release.",
  inputSchema: z.object({ version: z.string().optional() }),
  outputSchema: z.object({ release: releaseSnapshotSchema }),
  strict: true,
  execute: async ({ version }) => ({ release: getReleaseStatus(version) }),
});
