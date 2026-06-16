/**
 * Keyless deterministic harnesses + ticket generator for the `stub` variant.
 *
 * Lets the demo run end-to-end in CI without an API key, exercising the same
 * orchestrator fan-out + event-log harvest path as the live run.
 */

import {
  CATEGORIES,
  CHANNELS,
  PLANS,
  SENTIMENTS,
  URGENCIES,
  batchInputSchema,
  ticketArraySchema,
} from "./ticket-schema.mjs";
import { BATCH_WORKFLOW_ID, computeBatchPlan } from "./orchestrator-prompt.mjs";

/**
 * Build `count` deterministic, schema-valid tickets starting at startIndex.
 *
 * @param {{ count: number, startIndex: number }} options
 * @returns {object[]}
 */
export function buildDeterministicTickets({ count, startIndex }) {
  const tickets = [];
  for (let offset = 0; offset < count; offset += 1) {
    const n = startIndex + offset;
    const category = CATEGORIES[n % CATEGORIES.length];
    const urgency = URGENCIES[n % URGENCIES.length];
    const sentiment = SENTIMENTS[n % SENTIMENTS.length];
    const plan = PLANS[n % PLANS.length];
    const channel = CHANNELS[n % CHANNELS.length];
    const day = String((n % 28) + 1).padStart(2, "0");
    tickets.push({
      ticket_id: `STUB-${n}`,
      customer_name: `Customer ${n}`,
      customer_company: `Fake Company ${n}`,
      customer_plan: plan,
      channel,
      submitted_at: `2026-04-${day}T09:${String(n % 60).padStart(2, "0")}:00Z`,
      ticket_subject: `Sample ${category} issue #${n}`,
      ticket_body:
        `This is a deterministic placeholder ticket body for ticket ${n}. It describes a ` +
        `${category.toLowerCase()} situation with ${urgency.toLowerCase()} urgency and a ` +
        `${sentiment.toLowerCase()} tone, long enough to read like a real message.`,
      category,
      urgency,
      sentiment,
      summary: `Customer reports a ${category.toLowerCase()} issue (ticket ${n}).`,
      recommended_action: `Investigate the ${category.toLowerCase()} report and follow up with the customer.`,
      draft_reply: `Hi Customer ${n}, thanks for reaching out about this ${category.toLowerCase()} issue. We're looking into it and will update you shortly.`,
    });
  }
  return tickets;
}

/** Fixed LWIR: a single tool.call step that runs generate_batch. */
function stubBatchLwir() {
  return {
    apiVersion: "littleworkflow.dev/v0.1",
    kind: "Workflow",
    metadata: {
      name: BATCH_WORKFLOW_ID,
      version: "0.1.0-alpha",
      description: "Deterministic keyless ticket batch generator.",
    },
    input: { schema: batchInputSchema },
    output: { schema: ticketArraySchema },
    permissions: { tools: ["generate_batch"], models: [], secrets: [], network: [] },
    steps: [
      {
        id: "generate",
        uses: "tool.call",
        with: { tool: "generate_batch" },
        input: { count: "{{ input.count }}", startIndex: "{{ input.startIndex }}" },
        output: { mode: "array", schema: ticketArraySchema },
      },
    ],
  };
}

export function stubPlannerHarness() {
  return {
    harnessId: "stubTicketPlannerHarness@1.0.0",
    async run(task) {
      if (task.kind !== "plan") return { kind: "delegate_to_default" };
      return { kind: "plan", lwir: stubBatchLwir() };
    },
  };
}

export function stubOrchestratorHarness({ ticketCount, batchSize }) {
  let callSequence = 0;

  async function invoke(ctx, toolName, args) {
    const execute = ctx.tools?.[toolName]?.execute;
    if (typeof execute !== "function") {
      throw new Error(`stub orchestrator: tool '${toolName}' is not executable.`);
    }
    const callId = `${toolName}_${++callSequence}`;
    const startedAt = Date.now();
    await ctx.recorder.append({
      type: "harness.tool_call.started",
      payload: { callId, caller: "code", toolName, args },
    });
    try {
      const result = await execute(args);
      await ctx.recorder.append({
        type: "harness.tool_call.succeeded",
        payload: { callId, result, durationMs: Date.now() - startedAt },
      });
      return result;
    } catch (error) {
      await ctx.recorder.append({
        type: "harness.tool_call.failed",
        payload: {
          callId,
          error: {
            name: error instanceof Error ? error.name : "Error",
            message: error instanceof Error ? error.message : String(error),
          },
          durationMs: Date.now() - startedAt,
        },
      });
      throw error;
    }
  }

  return {
    harnessId: "stubTicketOrchestratorHarness@1.0.0",
    async run(task, ctx) {
      if (task.kind !== "orchestrate") return { kind: "delegate_to_default" };

      const plan = computeBatchPlan(ticketCount, batchSize);
      const { workflowVersionId } = await invoke(ctx, "plan_workflow", {
        workflowId: BATCH_WORKFLOW_ID,
        input: { count: plan[0]?.count ?? batchSize, startIndex: 1 },
      });

      await Promise.all(
        plan.map((batch) =>
          invoke(ctx, "run_workflow", {
            workflowVersionId,
            input: { count: batch.count, startIndex: batch.startIndex },
          }),
        ),
      );

      return {
        kind: "orchestrate",
        output: { batchesRun: plan.length, ticketsRequested: ticketCount },
      };
    },
  };
}
