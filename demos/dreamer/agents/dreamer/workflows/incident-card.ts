import { asHarnessWorkflow, defineWorkflow } from "little-workflow";
import type { WorkflowDefinition } from "little-workflow";
import type { LanguageModel } from "ai";
import { z } from "zod";
import { dreamerModel } from "../env";

/**
 * `dream.incident-card` — turn ONE failed run into a compact incident card.
 *
 * This is the unit the sweep fans out over. It is deliberately ONE `ai.generate` step and a
 * ~100-token output: the agent calls it once per failure run, so the whole sweep has to fit
 * in the investigating turn's context. A card that summarised freely would blow that budget
 * on the third run.
 *
 * `userQuote` is the one field that must be copied rather than written. It is what a
 * proposal ends up citing, and the control plane verifies citations against the real
 * transcript — a paraphrase here becomes an unverifiable claim three steps later.
 */
export function createIncidentCardWorkflow(model: LanguageModel, planner?: unknown) {
  return defineWorkflow({
    id: "dream.incident-card",
    description:
      "Read one failed run and emit a compact incident card: the symptom, the user's own words, what the assistant answered instead, and the single most likely cause.",
    input: z.object({
      runId: z.string().describe("The run id this transcript belongs to."),
      transcript: z
        .string()
        .describe("The run's conversation, or the failing exchange from it, as text."),
      outcome: z
        .string()
        .describe(
          "The recorded outcome and where it came from, e.g. 'failure (inferred from user pushback)' or 'failure (explicit)'.",
        ),
      configVersionId: z
        .string()
        .optional()
        .describe("The config version this run was served by, if known."),
    }),
    output: z.object({
      runId: z.string().describe("Echo `input.runId` back, unchanged."),
      symptom: z.string().describe("What went wrong, at most 12 words."),
      userQuote: z
        .string()
        .describe(
          "The user's own words showing the failure, copied VERBATIM from the transcript — no paraphrase, no trimming, no re-punctuation. Empty string if the user never said anything about it.",
        ),
      wrongAnswerSummary: z
        .string()
        .describe("What the assistant answered instead, at most 20 words."),
      suspectedCause: z
        .string()
        .describe(
          "The single most likely cause, at most 15 words. Blame the CONFIG (a missing instruction, a wrong default, an absent constraint), not the user.",
        ),
      configVersionId: z
        .string()
        .optional()
        .describe("Echo `input.configVersionId` back when it was supplied."),
    }),
    model,
    planner: planner ?? {
      model,
      system: [
        "Plan the smallest workflow that answers the request. One ai.generate step is enough:",
        "read `input.transcript` and emit the structured card.",
        "Do not add retrieval, tool, or validation steps.",
      ].join(" "),
    },
  });
}

// The `as unknown as WorkflowDefinition` cast is NOT incidental: `defineWorkflow` returns a
// `DefinedWorkflow<TInput, TOutput>` whose type brand is invariant, so it does not assign to
// the un-parameterized `WorkflowDefinition` that `asHarnessWorkflow` takes. The SDK's own
// `loadWorkflow` writes exactly the same cast
// (packages/little-workflow/src/workspace/load-workflow.ts).
export default asHarnessWorkflow(
  createIncidentCardWorkflow(dreamerModel()) as unknown as WorkflowDefinition,
  {
    executionMode: "inline",
    // Inline, demo-local, and never resumed across a definition change, so there is no
    // durable identity to protect. `loadWorkflow(folder)` is the path that derives a real
    // content hash — it wants a `workflows/<name>/workflow.ts` FOLDER, which the harness's
    // own `workflows/*.ts` file discovery does not use.
    definitionIdentity: { notApplicable: true },
  },
);
