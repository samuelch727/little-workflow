/**
 * Prompts + pure helpers for the two-phase hiring-candidates demo.
 *
 * Phase 1 (hiring.post.generate): a planner turns a one-step ai.generate
 * workflow into LWIR; the worker (v4-pro) invents a role and writes a marketing
 * job post as a structured object.
 *
 * Phase 2 (hiring.candidate.batch): an autonomous orchestrator (v4-pro) plans
 * the batch workflow once and fans out run_workflow per batch; each worker
 * (v4-flash) generates one batch of fake candidates for the Phase-1 role.
 *
 * Prompts live here so they can be unit-tested without a network call.
 */

import {
  SENIORITY,
  SOURCES,
  STATUSES,
  LOCATIONS,
  EDUCATION,
  candidateArraySchema,
  candidateItemSchema,
  batchInputSchema,
  postSchema,
} from "./candidate-schema.mjs";

export const POST_WORKFLOW_ID = "hiring.post.generate";
export const CANDIDATE_BATCH_WORKFLOW_ID = "hiring.candidate.batch";

/**
 * Split a total candidate count into contiguous 1-based batches.
 *
 * @param {number} total
 * @param {number} batchSize
 * @returns {{ startIndex: number, count: number }[]}
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
 * Structured input handed to the Phase-2 orchestrator harness.
 *
 * @param {object} options
 * @param {string} options.goal Raw task markdown.
 * @param {{ role_title: string, role_brief: string, key_skills: string[] }} options.role
 * @param {number} options.totalCandidateCount
 * @param {number} options.batchSize
 * @param {number} [options.startIndexBase]
 * @returns {object}
 */
export function buildOrchestratorInput({ goal, role, totalCandidateCount, batchSize, startIndexBase = 1 }) {
  return {
    goal,
    role_title: role.role_title,
    role_brief: role.role_brief,
    key_skills: role.key_skills,
    totalCandidateCount,
    batchSize,
    startIndexBase,
    workflowId: CANDIDATE_BATCH_WORKFLOW_ID,
  };
}

// ---------------------------------------------------------------------------
// Phase 1 — hiring.post.generate
// ---------------------------------------------------------------------------

const POST_PROMPT =
  "You are a senior tech recruiter + marketer. Read the Input JSON for any " +
  "`domain_hint`. Invent ONE specific, plausible open engineering/product role " +
  "at a fictional-but-believable company, then write a polished, enthusiastic " +
  "marketing-style job post for it. Return ONLY a JSON object (no prose, no " +
  "markdown fences) with exactly these fields: role_title, company, location, " +
  "seniority_focus, key_skills (5-8 strings), role_brief (2-3 sentences a " +
  "recruiter could paste into a sourcing tool), hiring_post_markdown (the full " +
  "post as Markdown: a headline, an 'About the role' section, 'What you'll do', " +
  "'What we look for', and 'Perks'). Use only fictional company/people names — " +
  "no real companies, people, emails, or contact data. `location` should be a " +
  "city + remote policy. `seniority_focus` is the seniority the role targets.";

/** Valid LWIR the Phase-1 planner adapts: one ai.generate step → post object. */
export const POST_LWIR_EXAMPLE = {
  apiVersion: "littleworkflow.dev/v0.1",
  kind: "Workflow",
  metadata: {
    name: POST_WORKFLOW_ID,
    version: "0.1.0-alpha",
    description: "Invent a role and write a marketing hiring post as a structured object.",
  },
  input: { schema: { type: "object", additionalProperties: true } },
  output: { schema: postSchema },
  permissions: { tools: [], models: ["model.post"], secrets: [], network: [] },
  steps: [
    {
      id: "write-post",
      uses: "ai.generate",
      input: "{{ input }}",
      with: { model: "model.post", prompt: POST_PROMPT },
      output: { mode: "object", schema: postSchema },
    },
  ],
};

/** Structured input handed to the Phase-1 (post) orchestrator harness. */
export function buildPostOrchestratorInput({ goal }) {
  return { goal, workflowId: POST_WORKFLOW_ID };
}

export const POST_ORCHESTRATOR_SYSTEM_PROMPT = `\
You coordinate a single hiring-post generation step.

You receive a JSON message with:
- goal: the full markdown task spec.
- workflowId: the id of the post workflow to use ("${POST_WORKFLOW_ID}").

Your tools:
- plan_workflow({ workflowId, input }) -> { workflowVersionId }. Call this once.
- run_workflow({ workflowVersionId, input }) -> { runId, status, outputRef,
  outputPath, outputSummary }. Call once.
- Do NOT use start_workflow or the bash tool.

Procedure:
1. Call plan_workflow once with { workflowId, input: {} }.
2. Call run_workflow once with the returned workflowVersionId and input {}. The
   hiring-post object is captured downstream through outputRef/outputPath.
3. Return a one-line summary like "post generated". The post is captured
   downstream — do NOT echo its contents.

Rules:
- Plan once, run once. If run_workflow returns status "failed", read the error,
  adjust, and retry AT MOST TWICE, then stop.
- Keep messages compact.`;

export const POST_PLANNER_SYSTEM_PROMPT = `\
You are the planner for the "${POST_WORKFLOW_ID}" workflow, which invents an open
role and writes a marketing job post for it as a single structured object.

Emit a single JSON object in Little Workflow Intermediate Representation (LWIR)
alpha shape. Required top-level keys: apiVersion ("littleworkflow.dev/v0.1"),
kind ("Workflow"), metadata.name, input.schema, output.schema, permissions
(tools/models/secrets/network arrays), and steps.

Step contract:
- Use a single "ai.generate" step.
- with.model must be exactly "model.post" (the only available model).
- The step output must be mode "object" with the post schema.
- Set step.input to "{{ input }}" so the whole input object is passed through.
- Do not invent other step uses, tools, or models.

The post object schema is:
${JSON.stringify(postSchema, null, 2)}

Use this valid LWIR as the structural pattern; adapt only as needed:
${JSON.stringify(POST_LWIR_EXAMPLE, null, 2)}

Return only valid JSON. Do not wrap the response in markdown fences or prose.`;

// ---------------------------------------------------------------------------
// Phase 2 — hiring.candidate.batch
// ---------------------------------------------------------------------------

const CANDIDATE_PROMPT =
  "You generate realistic fake job candidates who applied for a specific role. " +
  "Read the parameters from the Input JSON: `count` is how many candidates to " +
  "produce, `role_title` and `role_brief` describe the role, `key_skills` lists " +
  "skills the role screens for, `mix` gives a desired label distribution for " +
  "this batch, and `instructions` carries extra guidance. Produce exactly " +
  "`count` distinct, realistic candidate objects and return ONLY a JSON array " +
  "(no prose, no markdown fences). Each object must use exactly these fields: " +
  "candidate_id, full_name, email, location, headline, years_experience, " +
  "current_company, top_skills, education, summary, desired_salary_usd, source, " +
  "seniority, status, match_score. Allowed values — " +
  `location: ${LOCATIONS.join(" | ")}; ` +
  `education: ${EDUCATION.join(" | ")}; ` +
  `source: ${SOURCES.join(" | ")}; ` +
  `seniority: ${SENIORITY.join(" | ")}; ` +
  `status: ${STATUSES.join(" | ")}. ` +
  "years_experience and desired_salary_usd are numbers; match_score is a number " +
  "0-100 reflecting fit for the role; top_skills is an array of 3-8 skill " +
  "strings drawn from or adjacent to key_skills; summary is a 1-3 sentence " +
  "blurb. Use fake names/companies/emails only — no real people or contact " +
  "data. Vary seniority, source, status, location, salary, and match quality so " +
  "the pool looks like a real applicant funnel (a few strong, many average, " +
  "some weak); include tricky cases (over-qualified, career-changer, junior " +
  "with strong projects). candidate_id may be any placeholder; it is renumbered " +
  "downstream.";

/** Valid LWIR the Phase-2 planner adapts: one ai.generate step → candidate array. */
export const CANDIDATE_BATCH_LWIR_EXAMPLE = {
  apiVersion: "littleworkflow.dev/v0.1",
  kind: "Workflow",
  metadata: {
    name: CANDIDATE_BATCH_WORKFLOW_ID,
    version: "0.1.0-alpha",
    description: "Generate one batch of fake candidates for a role.",
  },
  input: { schema: batchInputSchema },
  output: { schema: candidateArraySchema },
  permissions: { tools: [], models: ["model.worker"], secrets: [], network: [] },
  steps: [
    {
      id: "generate-candidates",
      uses: "ai.generate",
      input: "{{ input }}",
      with: { model: "model.worker", prompt: CANDIDATE_PROMPT },
      output: { mode: "array", schema: candidateArraySchema },
    },
  ],
};

export const CANDIDATE_PLANNER_SYSTEM_PROMPT = `\
You are the planner for the "${CANDIDATE_BATCH_WORKFLOW_ID}" workflow, which
generates one batch of fake job candidates for a role.

Emit a single JSON object in Little Workflow Intermediate Representation (LWIR)
alpha shape. Required top-level keys: apiVersion ("littleworkflow.dev/v0.1"),
kind ("Workflow"), metadata.name, input.schema, output.schema, permissions
(tools/models/secrets/network arrays), and steps.

Step contract:
- Use a single "ai.generate" step.
- with.model must be exactly "model.worker" (the only available model).
- The step output must be mode "array" with the candidate array schema.
- Set step.input to "{{ input }}" so the entire batch input object is passed to
  the worker. Do NOT dereference individual optional fields (the coordinator may
  omit "mix" or "instructions"); the worker reads them from the input JSON.
- Do not invent other step uses, tools, or models.

The candidate array item schema is:
${JSON.stringify(candidateItemSchema, null, 2)}

Use this valid LWIR as the structural pattern; adapt only as needed:
${JSON.stringify(CANDIDATE_BATCH_LWIR_EXAMPLE, null, 2)}

Return only valid JSON. Do not wrap the response in markdown fences or prose.`;

export const CANDIDATE_ORCHESTRATOR_SYSTEM_PROMPT = `\
You are the coordinator (orchestrator) for a fake-candidate generation job.

You receive a JSON message with:
- goal: the full markdown task spec describing the dataset to produce.
- role_title, role_brief, key_skills: the open role candidates applied for.
- totalCandidateCount: how many candidates to generate in this coordinator session.
- batchSize: the maximum number of candidates to request per sub-run.
- startIndexBase: the global 1-based index for this session's first candidate.
- workflowId: the id of the worker workflow you must use ("${CANDIDATE_BATCH_WORKFLOW_ID}").

Your tools:
- plan_workflow({ workflowId, input }) -> { workflowVersionId }. Call this
  EXACTLY ONCE, up front, to compile the worker workflow into a reusable
  version. Reuse the returned workflowVersionId for every same-shape batch.
- run_workflow({ workflowVersionId, input }) -> { runId, status, outputRef,
  outputPath, outputSummary }. Call this once per batch to generate that batch's
  candidates. The full candidate batch is written to outputPath; do not read it
  unless you need to inspect a failed or suspicious batch.
- Do NOT use start_workflow. Do not call plan_workflow more than once.

Procedure:
1. Read the goal and the role. Note the allowed seniority, source, and status
   vocabularies and their rough target distribution.
2. Call plan_workflow once with { workflowId, input } where input is a small
   representative batch using the EXACT same object shape you will use for every
   run_workflow input, including count, startIndex, role_title, role_brief,
   key_skills, mix, and instructions.
3. Compute how many batches are needed: ceil(totalCandidateCount / batchSize).
4. For each batch, call run_workflow with the returned workflowVersionId and
   input { count, startIndex, role_title, role_brief, key_skills, mix,
   instructions } where:
   - count: candidates for this batch (the last batch may be smaller),
   - startIndex: global 1-based index of the first candidate in the batch
     (start at startIndexBase, then add each prior batch's count),
   - role_title, role_brief, key_skills: copied from the message so the worker
     generates candidates for THIS role,
   - mix: desired counts per seniority/source/status for this batch, chosen so
     the totals across all batches roughly match a realistic applicant funnel,
   - instructions: one or two sentences reinforcing realism and variety.
   Keep the object structure identical to the plan input and every other batch:
   include all seniority/source/status labels in mix, using 0 where needed.
5. You do NOT need to collect or echo the generated candidates — they are
   captured downstream from the run outputs. Once every batch has run
   successfully, return a short final summary like: batchesRun=<n>,
   candidatesRequested=<total>.

Rules:
- A run_workflow result has a "status". If status is "failed", read its "error"
  message, adjust if needed, and retry that batch AT MOST TWICE. If it still
  fails, leave that batch and move on — do not loop on it.
- Each batch only needs to run ONCE successfully. Never re-run a batch that
  already returned status "completed".
- Do not use the bash tool. Do not explore the filesystem.
- Keep messages compact; do not paste candidate contents back.
- Be truthful in your final summary: report only batches that actually returned
  status "completed".`;
