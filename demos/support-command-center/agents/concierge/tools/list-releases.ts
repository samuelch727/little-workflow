import { tool } from "ai";
import { z } from "zod";
import { getReleaseStatus, listReleaseVersions } from "../data/releases";

/**
 * Shared GLOBAL tool — it has an `execute` and lives in `tools/`, so structure makes
 * it available on every connector by default. The Slack connector opts out of it via
 * its descriptor `toolPolicy: { deny: ["list-releases"] }` (Slack stays focused on
 * posting, not browsing) — demonstrating the blacklist.
 */
export default tool({
  description: "List all known release versions with their stage and health.",
  inputSchema: z.object({}),
  outputSchema: z.object({
    releases: z.array(
      z.object({ version: z.string(), stage: z.string(), health: z.string() }),
    ),
  }),
  execute: async () => ({
    releases: listReleaseVersions().map((version) => {
      const release = getReleaseStatus(version);
      return { version: release.version, stage: release.stage, health: release.health };
    }),
  }),
});
