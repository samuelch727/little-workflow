import { asHarnessWorkflow, defineWorkflow } from "little-workflow";
import type { WorkflowDefinition } from "little-workflow";
import { z } from "zod";
import { librarianModel } from "../env";

const model = librarianModel();

/**
 * Summarize an uploaded document and produce the one line it should occupy in the
 * knowledge-base catalog.
 *
 * It is a workflow rather than a plain tool on purpose: it exercises workflow-in-chat and
 * the capped `outputSummary` a completed run now surfaces to the calling model, which is
 * how the Librarian knows what to tell the user it ingested. The workflow itself is
 * deliberately one generation — the interesting part is the boundary, not the plan.
 */
const ingestFile = defineWorkflow({
  id: "kb.ingest-file",
  description:
    "Summarize an uploaded knowledge-base document and produce its one-line catalog entry.",
  input: z.object({
    filename: z.string().describe("Name of the uploaded knowledge-base document."),
    content: z.string().describe("The full text of the uploaded document."),
  }),
  output: z.object({
    summary: z.string().describe("ONE sentence describing what the document covers."),
    catalogLine: z
      .string()
      .describe(
        "A single markdown list item of the exact form: - `<filename>` — <one-sentence summary>",
      ),
  }),
  model,
  planner: {
    model,
    system: [
      "Plan the smallest workflow that answers the request. One ai.generate step is enough:",
      "read `input.content` and emit the structured output.",
      "Do not add retrieval, tool, or validation steps.",
    ].join(" "),
  },
});

// The `as unknown as WorkflowDefinition` cast is NOT incidental: `defineWorkflow` returns a
// `DefinedWorkflow<TInput, TOutput>` whose type brand is invariant, so it does not assign to
// the un-parameterized `WorkflowDefinition` that `asHarnessWorkflow` takes — the documented
// `defineWorkflow -> asHarnessWorkflow -> createHarness({ workflows })` composition does not
// typecheck without it. The SDK's own `loadWorkflow` writes exactly the same cast
// (packages/little-workflow/src/workspace/load-workflow.ts:139).
export default asHarnessWorkflow(ingestFile as unknown as WorkflowDefinition, {
  executionMode: "inline",
  // Inline, demo-local, and never resumed across a definition change, so there is no
  // durable identity to protect. `loadWorkflow(folder)` is the path that derives a real
  // content hash — it wants a `workflows/<name>/workflow.ts` FOLDER, which the harness's
  // own `workflows/*.ts` file discovery does not use.
  definitionIdentity: { notApplicable: true },
});
