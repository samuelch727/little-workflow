/**
 * Keyless deterministic generators + harnesses for the `stub` variant.
 *
 * Lets the demo run end-to-end without an API key, exercising the same two-phase
 * pipeline (post -> orchestrator fan-out -> event-log harvest -> littleDB tee)
 * as the live run, just with deterministic content via tool.call steps.
 */

import {
  SENIORITY,
  SOURCES,
  STATUSES,
  LOCATIONS,
  EDUCATION,
  candidateArraySchema,
  batchInputSchema,
  postSchema,
} from "./candidate-schema.mjs";
import {
  CANDIDATE_BATCH_WORKFLOW_ID,
  POST_WORKFLOW_ID,
  computeBatchPlan,
} from "./orchestrator-prompt.mjs";

const FIRST_NAMES = [
  "Ada", "Lin", "Marcus", "Priya", "Sofia", "Diego",
  "Wei", "Noah", "Amara", "Tariq", "Hana", "Leo",
];
const LAST_NAMES = [
  "Devlin", "Okafor", "Reyes", "Sharma", "Costa", "Nakamura",
  "Bauer", "Ivanova", "Mensah", "Klein", "Park", "Rossi",
];

/**
 * Build `count` deterministic, schema-valid candidates starting at startIndex.
 *
 * @param {{ count: number, startIndex: number, role?: { role_title?: string, key_skills?: string[] } }} options
 * @returns {object[]}
 */
export function buildDeterministicCandidates({ count, startIndex, role }) {
  const roleTitle = role?.role_title ?? "Software Engineer";
  const skills = role?.key_skills?.length ? role.key_skills : ["Communication", "Problem Solving", "Teamwork"];
  const candidates = [];
  for (let offset = 0; offset < count; offset += 1) {
    const n = startIndex + offset;
    const first = FIRST_NAMES[n % FIRST_NAMES.length];
    const last = LAST_NAMES[(n * 7) % LAST_NAMES.length];
    const seniority = SENIORITY[n % SENIORITY.length];
    const source = SOURCES[n % SOURCES.length];
    const status = STATUSES[n % STATUSES.length];
    const location = LOCATIONS[n % LOCATIONS.length];
    const education = EDUCATION[n % EDUCATION.length];
    const topSkills = [...new Set([skills[n % skills.length], skills[(n + 1) % skills.length], "Communication"])];
    candidates.push({
      candidate_id: `STUB-${n}`,
      full_name: `${first} ${last} ${n}`,
      email: `${first.toLowerCase()}.${last.toLowerCase()}${n}@example.com`,
      location,
      headline: `${seniority} ${roleTitle}`,
      years_experience: n % 18,
      current_company: `Fake Co ${n}`,
      top_skills: topSkills,
      education,
      summary: `Deterministic candidate ${n} for ${roleTitle} — ${seniority}, ${n % 18}y experience, ${source} sourced.`,
      desired_salary_usd: 90000 + (n % 12) * 12000,
      source,
      seniority,
      status,
      match_score: 40 + (n % 60),
    });
  }
  return candidates;
}

/** A canned hiring post used by the stub Phase 1. */
export function buildDeterministicPost() {
  return {
    role_title: "Senior Backend Engineer, Payments",
    company: "Fjordpay",
    location: "Remote (US) / San Francisco, CA",
    seniority_focus: "Senior",
    key_skills: ["Go", "PostgreSQL", "Kafka", "Distributed Systems", "Payments", "gRPC"],
    role_brief:
      "Senior backend engineer to own Fjordpay's ledger and payments rails. " +
      "Looking for distributed-systems depth, payments domain exposure, and a track record shipping reliable services.",
    hiring_post_markdown: [
      "# Senior Backend Engineer, Payments — Fjordpay",
      "",
      "## About the role",
      "We're building the money movement layer that thousands of businesses trust. You'll own the ledger.",
      "",
      "## What you'll do",
      "- Design and ship resilient payments services in Go.",
      "- Evolve our double-entry ledger and reconciliation pipelines.",
      "",
      "## What we look for",
      "- Strong distributed-systems fundamentals and PostgreSQL/Kafka experience.",
      "- Care about correctness, observability, and on-call quality.",
      "",
      "## Perks",
      "- Remote-first, generous equity, real ownership.",
    ].join("\n"),
  };
}

// ---------------------------------------------------------------------------
// Stub LWIR (tool.call steps — no model needed).
// ---------------------------------------------------------------------------

function stubPostLwir() {
  return {
    apiVersion: "littleworkflow.dev/v0.1",
    kind: "Workflow",
    metadata: { name: POST_WORKFLOW_ID, version: "0.1.0-alpha", description: "Deterministic keyless hiring post." },
    input: { schema: { type: "object", additionalProperties: true } },
    output: { schema: postSchema },
    permissions: { tools: ["generate_post"], models: [], secrets: [], network: [] },
    steps: [
      {
        id: "write-post",
        uses: "tool.call",
        with: { tool: "generate_post" },
        input: "{{ input }}",
        output: { mode: "object", schema: postSchema },
      },
    ],
  };
}

function stubBatchLwir() {
  return {
    apiVersion: "littleworkflow.dev/v0.1",
    kind: "Workflow",
    metadata: {
      name: CANDIDATE_BATCH_WORKFLOW_ID,
      version: "0.1.0-alpha",
      description: "Deterministic keyless candidate batch generator.",
    },
    input: { schema: batchInputSchema },
    output: { schema: candidateArraySchema },
    permissions: { tools: ["generate_batch"], models: [], secrets: [], network: [] },
    steps: [
      {
        id: "generate",
        uses: "tool.call",
        with: { tool: "generate_batch" },
        input: "{{ input }}",
        output: { mode: "array", schema: candidateArraySchema },
      },
    ],
  };
}

export function stubPostPlannerHarness() {
  return {
    harnessId: "stubHiringPostPlannerHarness@1.0.0",
    async run(task) {
      if (task.kind !== "plan") return { kind: "delegate_to_default" };
      return { kind: "plan", lwir: stubPostLwir() };
    },
  };
}

export function stubCandidatePlannerHarness() {
  return {
    harnessId: "stubCandidatePlannerHarness@1.0.0",
    async run(task) {
      if (task.kind !== "plan") return { kind: "delegate_to_default" };
      return { kind: "plan", lwir: stubBatchLwir() };
    },
  };
}

/**
 * Build an `invoke(ctx, toolName, args)` that executes an orchestrator tool and
 * records harness.tool_call.* events, so the live event-log harvest path is
 * exercised by the stub too.
 */
function makeInvoke() {
  let callSequence = 0;
  return async function invoke(ctx, toolName, args) {
    const execute = ctx.tools?.[toolName]?.execute;
    if (typeof execute !== "function") {
      throw new Error(`stub orchestrator: tool '${toolName}' is not executable.`);
    }
    const callId = `${toolName}_${(callSequence += 1)}`;
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
  };
}

/** Stub Phase-1 orchestrator: plan the post workflow once, run it once. */
export function stubPostOrchestratorHarness() {
  const invoke = makeInvoke();
  return {
    harnessId: "stubPostOrchestratorHarness@1.0.0",
    async run(task, ctx) {
      if (task.kind !== "orchestrate") return { kind: "delegate_to_default" };
      const { workflowVersionId } = await invoke(ctx, "plan_workflow", {
        workflowId: POST_WORKFLOW_ID,
        input: {},
      });
      await invoke(ctx, "run_workflow", { workflowVersionId, input: {} });
      return { kind: "orchestrate", output: { postGenerated: true } };
    },
  };
}

/**
 * Stub Phase-2 orchestrator: plan once, then fan out run_workflow per batch.
 *
 * @param {{ totalCandidateCount: number, batchSize: number, role: object, startIndexBase?: number }} options
 */
export function stubOrchestratorHarness({ totalCandidateCount, batchSize, role, startIndexBase = 1 }) {
  const invoke = makeInvoke();

  return {
    harnessId: "stubCandidateOrchestratorHarness@1.0.0",
    async run(task, ctx) {
      if (task.kind !== "orchestrate") return { kind: "delegate_to_default" };

      const plan = computeBatchPlan(totalCandidateCount, batchSize);
      const seed = { role_title: role.role_title, role_brief: role.role_brief, key_skills: role.key_skills };
      const { workflowVersionId } = await invoke(ctx, "plan_workflow", {
        workflowId: CANDIDATE_BATCH_WORKFLOW_ID,
        input: { count: plan[0]?.count ?? batchSize, startIndex: startIndexBase, ...seed },
      });

      await Promise.all(
        plan.map((batch) =>
          invoke(ctx, "run_workflow", {
            workflowVersionId,
            input: { count: batch.count, startIndex: startIndexBase + batch.startIndex - 1, ...seed },
          }),
        ),
      );

      return {
        kind: "orchestrate",
        output: { batchesRun: plan.length, candidatesRequested: totalCandidateCount },
      };
    },
  };
}
