import { asHarnessWorkflow, defineWorkflow } from "little-workflow";
import type { WorkflowDefinition } from "little-workflow";
import type { LanguageModel } from "ai";
import { z } from "zod";
import { dreamerModel } from "../env";

/**
 * `dream.cluster-cards` — group the sweep's incident cards into failure modes.
 *
 * The step the investigation turns on. A list of individual failures invites a proposal per
 * failure; a cluster invites ONE change that fixes the biggest group. `dominantCluster` is
 * what the proposal has to address, and everything else is explicitly not this run's job.
 */
export function createClusterCardsWorkflow(model: LanguageModel, planner?: unknown) {
  return defineWorkflow({
    id: "dream.cluster-cards",
    description:
      "Group incident cards into failure modes and name the dominant one — the cluster a single config change would fix the most of.",
    input: z.object({
      cards: z
        .array(
          z.object({
            runId: z.string().describe("The run this card came from."),
            symptom: z.string().describe("What went wrong."),
            userQuote: z.string().describe("The user's own words, verbatim."),
            wrongAnswerSummary: z.string().describe("What the assistant answered instead."),
            suspectedCause: z.string().describe("The card's suspected cause."),
          }),
        )
        .describe("Every incident card from the sweep. Do not drop any."),
    }),
    output: z.object({
      clusters: z
        .array(
          z.object({
            label: z
              .string()
              .describe("A short name for this failure mode, at most 6 words. Unique."),
            runIds: z
              .array(z.string())
              .describe("The run ids in this cluster. Every input card belongs to exactly one cluster."),
            dominantCause: z
              .string()
              .describe("The config-level cause shared by this cluster, at most 15 words."),
          }),
        )
        .describe("Ordered largest cluster first."),
      dominantCluster: z
        .string()
        .describe(
          "The `label` of the largest cluster — the one a single config change should target.",
        ),
    }),
    model,
    planner: planner ?? {
      model,
      system: [
        "Plan the smallest workflow that answers the request. One ai.generate step is enough:",
        "read `input.cards` and emit the clustering.",
        "Do not add retrieval, tool, or validation steps.",
      ].join(" "),
    },
  });
}

// See `incident-card.ts` for why the cast is required.
export default asHarnessWorkflow(
  createClusterCardsWorkflow(dreamerModel()) as unknown as WorkflowDefinition,
  { executionMode: "inline", definitionIdentity: { notApplicable: true } },
);
