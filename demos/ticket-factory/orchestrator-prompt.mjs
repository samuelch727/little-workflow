/**
 * Prompts + pure helpers for the autonomous ticket-factory coordinator.
 *
 * The orchestrator (DeepSeek) receives the raw task markdown and must decompose
 * it into batched sub-runs of the `support.ticket.batch` workflow. The planner
 * (DeepSeek) turns that workflow definition into LWIR. Both prompts live here so
 * they can be unit-tested without a network call.
 */

import {
  CATEGORIES,
  CHANNELS,
  PLANS,
  SENTIMENTS,
  URGENCIES,
  batchInputSchema,
  ticketArraySchema,
  ticketItemSchema,
} from "./ticket-schema.mjs";

export const BATCH_WORKFLOW_ID = "support.ticket.batch";

/**
 * Split a total ticket count into contiguous batches.
 *
 * @param {number} total Total tickets to generate.
 * @param {number} batchSize Max tickets per batch.
 * @returns {{ startIndex: number, count: number }[]} 1-based startIndex per batch.
 */
export function computeBatchPlan(total, batchSize) {
  if (!Number.isInteger(total) || total < 1) {
    throw new Error(`computeBatchPlan: total must be a positive integer, got ${total}.`);
  }
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error(`computeBatchPlan: batchSize must be a positive integer, got ${batchSize}.`);
  }
  const batches = [];
  let startIndex = 1;
  while (startIndex <= total) {
    const count = Math.min(batchSize, total - startIndex + 1);
    batches.push({ startIndex, count });
    startIndex += count;
  }
  return batches;
}

/**
 * The structured input handed to the orchestrator harness.
 *
 * @param {object} options
 * @param {string} options.goal Raw task markdown.
 * @param {number} options.totalTicketCount
 * @param {number} options.batchSize
 * @returns {object}
 */
export function buildOrchestratorInput({ goal, totalTicketCount, batchSize }) {
  return {
    goal,
    totalTicketCount,
    batchSize,
    workflowId: BATCH_WORKFLOW_ID,
  };
}

/** Valid LWIR the planner adapts. One ai.generate step → array of tickets. */
export const BATCH_LWIR_EXAMPLE = {
  apiVersion: "littleworkflow.dev/v0.1",
  kind: "Workflow",
  metadata: {
    name: BATCH_WORKFLOW_ID,
    version: "0.1.0-alpha",
    description: "Generate one batch of fake CloudDesk support tickets.",
  },
  input: { schema: batchInputSchema },
  output: { schema: ticketArraySchema },
  permissions: { tools: [], models: ["model.worker"], secrets: [], network: [] },
  steps: [
    {
      id: "generate-tickets",
      uses: "ai.generate",
      input: "{{ input }}",
      with: {
        model: "model.worker",
        prompt:
          "You generate fake customer-support tickets for a fictional SaaS company called CloudDesk. " +
          "Read the parameters from the Input JSON below: `count` is how many tickets to produce, " +
          "`mix` gives the desired label distribution for this batch, and `instructions` carries any " +
          "extra guidance from the coordinator. Produce exactly `count` distinct, realistic ticket " +
          "objects and return ONLY a JSON array (no prose, no markdown fences). Each object must use " +
          "exactly these fields: ticket_id, customer_name, customer_company, customer_plan, channel, " +
          "submitted_at, ticket_subject, ticket_body, category, urgency, sentiment, summary, " +
          "recommended_action, draft_reply. Allowed values — " +
          `category: ${CATEGORIES.join(" | ")}; ` +
          `urgency: ${URGENCIES.join(" | ")}; ` +
          `sentiment: ${SENTIMENTS.join(" | ")}; ` +
          `customer_plan: ${PLANS.join(" | ")}; ` +
          `channel: ${CHANNELS.join(" | ")}. ` +
          "submitted_at is an ISO 8601 timestamp between 2026-04-01 and 2026-05-31. ticket_body is " +
          "30-180 words. Use fake names/companies only — no real people, emails, phone numbers, or " +
          "payment data. Vary length and wording; include some tricky cases (polite-but-urgent, " +
          "angry-but-trivial, confused billing question). ticket_id may be any placeholder; it will be " +
          "renumbered downstream.",
      },
      output: { mode: "array", schema: ticketArraySchema },
    },
  ],
};

export const PLANNER_SYSTEM_PROMPT = `\
You are the planner for the "${BATCH_WORKFLOW_ID}" workflow, which generates one
batch of fake CloudDesk customer-support tickets.

Emit a single JSON object in Little Workflow Intermediate Representation (LWIR)
alpha shape. Required top-level keys: apiVersion ("littleworkflow.dev/v0.1"),
kind ("Workflow"), metadata.name, input.schema, output.schema, permissions
(tools/models/secrets/network arrays), and steps.

Step contract:
- Use a single "ai.generate" step.
- with.model must be exactly "model.worker" (the only available model).
- The step output must be mode "array" with the ticket array schema.
- Set step.input to "{{ input }}" so the entire batch input object is passed to
  the worker. Do NOT dereference individual optional fields (the coordinator may
  omit "mix" or "instructions"); the worker reads them from the input JSON.
- Do not invent other step uses, tools, or models.

The ticket array item schema is:
${JSON.stringify(ticketItemSchema, null, 2)}

Use this valid LWIR as the structural pattern; adapt only as needed:
${JSON.stringify(BATCH_LWIR_EXAMPLE, null, 2)}

Return only valid JSON. Do not wrap the response in markdown fences or prose.`;

export const ORCHESTRATOR_SYSTEM_PROMPT = `\
You are the coordinator (orchestrator) for a fake-support-ticket generation job.

You receive a JSON message with:
- goal: the full markdown task spec describing the dataset to produce.
- totalTicketCount: how many tickets to generate in total.
- batchSize: the maximum number of tickets to request per sub-run.
- workflowId: the id of the worker workflow you must use ("${BATCH_WORKFLOW_ID}").

Your tools:
- plan_workflow({ workflowId, input }) -> { workflowVersionId }. Call this
  EXACTLY ONCE, up front, to compile the worker workflow into a reusable
  version. Reuse the returned workflowVersionId for every batch.
- run_workflow({ workflowVersionId, input }) -> { runId, status, output }. Call
  this once per batch to generate that batch's tickets.
- Do NOT use start_workflow. Do not call plan_workflow more than once — planning
  per batch wastes time and money.

Procedure:
1. Read the goal markdown. Note the allowed categories, urgency levels, and
   sentiment labels and their target distribution shares.
2. Call plan_workflow once with { workflowId, input } where input is a small
   representative batch, e.g. { count: <batchSize>, startIndex: 1 }.
3. Compute how many batches are needed: ceil(totalTicketCount / batchSize).
4. For each batch, call run_workflow with the returned workflowVersionId and
   input { count, startIndex, mix, instructions } where:
   - count: tickets for this batch (the last batch may be smaller),
   - startIndex: 1-based index of the first ticket in the batch,
   - mix: an object with desired counts per category/urgency/sentiment for this
     batch, chosen so the totals across all batches roughly match the target
     distribution in the goal,
   - instructions: one or two sentences reinforcing realism and variety.
5. You do NOT need to collect or echo the generated tickets — they are captured
   downstream from the run outputs. Once every batch has run successfully,
   return a short final summary like: batchesRun=<n>, ticketsRequested=<total>.

Rules:
- A run_workflow result has a "status". If status is "failed", read its "error"
  message, adjust if needed, and retry that batch AT MOST TWICE. If it still
  fails, leave that batch and move on — do not loop on it.
- Each batch only needs to run ONCE successfully. Never re-run a batch that
  already returned status "completed".
- Do not use the bash tool. Do not explore the filesystem.
- Stop as soon as every batch has either a completed run or has exhausted its
  retries. Keep messages compact and do not paste ticket contents back.
- Be truthful in your final summary: report only batches that actually returned
  status "completed". Do not claim success for failed or un-run batches.`;
