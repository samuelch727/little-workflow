import { asHarnessWorkflow, defineWorkflow } from "little-workflow";
import type { WorkflowDefinition } from "little-workflow";
import type { LanguageModel } from "ai";
import { z } from "zod";
import { dreamerModel } from "../env";

/**
 * A config bundle as the evidence pack carries it. `z.looseObject` rather than `z.record`:
 * a record emits a `propertyNames` JSON Schema keyword, which alpha LWIR rejects outright
 * ("Unsupported JSON Schema keyword 'propertyNames'"), so a record-typed workflow input
 * fails at compile time rather than at authoring time. Naming `prompt` explicitly is also
 * the better schema — it is the field the comparison actually turns on — while the loose
 * object still round-trips `modelSlot`, `sampling`, `skills` and the rest untouched.
 */
const configBundle = z.looseObject({
  prompt: z.string().describe("The system prompt this config version runs on."),
});

const versionMetrics = z.object({
  configVersionId: z.string().describe("The config version these numbers belong to."),
  runCount: z.number().describe("Runs served by this version."),
  withOutcome: z.number().describe("Of those, how many carry an outcome at all."),
  successRate: z
    .number()
    .nullable()
    .describe("Success rate over the runs WITH an outcome, or null when nothing was observed."),
});

/**
 * `dream.config-ab` — compare two config versions the harness has actually run on.
 *
 * Reached for when the evidence pack shows more than one version with real traffic: the
 * difference between them is a natural experiment the harness already ran, and it is
 * cheaper evidence than any new hypothesis. It answers what BEHAVIOUR the wording change
 * produced — the metrics are the prompt, not the answer.
 */
export function createConfigAbWorkflow(model: LanguageModel, planner?: unknown) {
  return defineWorkflow({
    id: "dream.config-ab",
    description:
      "Compare two config versions the harness has run on: what behavioural difference their wording implies, and which hypothesis the metrics support.",
    input: z.object({
      configA: configBundle.describe("The first config bundle, copied from the evidence pack."),
      configB: configBundle.describe("The second config bundle, copied from the evidence pack."),
      metricsA: versionMetrics.describe("The metrics row for configA's version."),
      metricsB: versionMetrics.describe("The metrics row for configB's version."),
    }),
    output: z.object({
      behavioralDifference: z
        .string()
        .describe(
          "What the agent would DO differently under B than under A, at most 40 words. Describe behaviour, not wording.",
        ),
      hypothesis: z
        .string()
        .describe(
          "One testable claim about why the rates differ, at most 30 words. Say plainly when the run counts are too small to support any claim.",
        ),
    }),
    model,
    planner: planner ?? {
      model,
      system: [
        "Plan the smallest workflow that answers the request. One ai.generate step is enough:",
        "read the two configs and their metrics and emit the comparison.",
        "Do not add retrieval, tool, or validation steps.",
      ].join(" "),
    },
  });
}

// See `incident-card.ts` for why the cast is required.
export default asHarnessWorkflow(
  createConfigAbWorkflow(dreamerModel()) as unknown as WorkflowDefinition,
  { executionMode: "inline", definitionIdentity: { notApplicable: true } },
);
