import { tool } from "ai";
import { z } from "zod";
import { fetchEvidencePack, isFailureRun, resolveHarnessSlug } from "../littledb-api";

/**
 * The first call of every investigation: everything littleDB already knows about this
 * harness — its production config, per-config-version metrics, and a sample of recent runs
 * annotated with outcomes.
 *
 * The pack is returned VERBATIM. `pushbackQuote` and `outcome.quote` are the exact user
 * turns the control plane will verify a citation against, so nothing here rewrites, joins
 * or paraphrases them — a digest would manufacture quotes that fail verification. The only
 * thing added is `failureRunIds`, a mechanically derived pointer list (no text at all).
 */
export default tool({
  description:
    "Fetch the littleDB evidence pack for a harness: its production config bundle, per-config-version metrics (success rate, explicit vs inferred outcome counts), and recent runs annotated with their outcome and — where the user pushed back — the exact pushback quote and the answer it was correcting. Call this FIRST; every other tool works off it.",
  inputSchema: z.object({
    harness: z
      .string()
      .optional()
      .describe("Harness slug. Omit to use the harness this investigation was started for."),
  }),
  execute: async ({ harness }) => {
    const slug = resolveHarnessSlug(harness);
    const pack = await fetchEvidencePack(slug);
    return {
      ...pack,
      // Derived, not digested: ids only. Failure and partial runs are the ones worth a card.
      failureRunIds: pack.runs.filter(isFailureRun).map((run) => run.runId),
      unlabelledRunIds: pack.runs.filter((run) => run.outcome === null).map((run) => run.runId),
    };
  },
});
