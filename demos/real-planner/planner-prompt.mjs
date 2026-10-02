const rankingItemSchema = {
  type: "object",
  required: ["id", "score", "reasoning"],
  additionalProperties: true,
  properties: {
    id: { type: "string" },
    score: { type: "number", minimum: 0, maximum: 100 },
    reasoning: { type: "string" },
  },
};

const parallelEnvelopeArraySchema = {
  type: "array",
  items: {
    type: "object",
    required: ["itemKey", "status", "artifacts"],
    properties: {
      itemKey: { type: "string" },
      status: { enum: ["completed", "failed"] },
      output: rankingItemSchema,
      outputRef: { type: "string" },
      error: { type: "object" },
      artifacts: { type: "array", items: { type: "string" } },
    },
  },
};

export const VALID_PARALLEL_LWIR_EXAMPLE = {
  apiVersion: "littleworkflow.dev/v0.1",
  kind: "Workflow",
  metadata: { name: "candidate.review" },
  input: {
    schema: {
      type: "object",
      required: ["candidates", "jobDescription"],
      additionalProperties: false,
      properties: {
        candidates: { type: "array", items: { type: "object" } },
        jobDescription: { type: "string" },
      },
    },
  },
  output: { schema: { type: "array", items: rankingItemSchema } },
  permissions: {
    tools: [],
    models: ["model.worker"],
    secrets: [],
    network: [],
  },
  steps: [
    {
      id: "score-candidates",
      uses: "parallel",
      with: {
        items: "{{ input.candidates }}",
        itemKey: "{{ item.id }}",
        maxBranches: 10,
        maxConcurrency: 3,
        failureMode: "fail_fast",
        cardinality: { kind: "matches_items" },
        fanIn: { order: "input", output: "array", outputStep: "score-candidate" },
      },
      steps: [
        {
          id: "score-candidate",
          uses: "ai.generate",
          input: {
            candidate: "{{ item }}",
            jobDescription: "{{ input.jobDescription }}",
          },
          with: {
            model: "model.worker",
            prompt:
              "Return only a JSON object with id, score, and reasoning. Candidate id: {{ input.candidate.id }} Candidate summary: {{ input.candidate.summary }} Job description: {{ input.jobDescription }}",
          },
          output: { mode: "object", schema: rankingItemSchema },
        },
      ],
      output: { mode: "array", schema: parallelEnvelopeArraySchema },
    },
    {
      id: "rank-candidates",
      uses: "ai.generate",
      needs: ["score-candidates"],
      input: "{{ steps.score-candidates.output }}",
      with: {
        model: "model.worker",
        prompt:
          "Input is an array of branch envelopes. Extract each completed output object, sort by score descending, and return only the JSON array.",
      },
      output: { mode: "array", schema: { type: "array", items: rankingItemSchema } },
    },
  ],
};

export const PLANNER_SYSTEM_PROMPT = `\
You are the planner for a Little Workflow that ranks candidates against a job description.

Emit a single JSON object in the Little Workflow Intermediate Representation (LWIR) alpha shape.

Required top-level shape:
- apiVersion: "littleworkflow.dev/v0.1"
- kind: "Workflow"
- metadata.name
- input.schema
- output.schema
- permissions with tools, models, secrets, and network arrays
- steps array

Step contract:
- Every step must use "id", "uses", optional "needs", optional "input", "with", and "output".
- Supported step uses for this demo are only "parallel" and "ai.generate".
- Do not use "kind", "type", "map", "sort", "transform", or "core.*" for steps.
- Every step that is not a decision step must declare "output".
- Every ai.generate step's with.model must be exactly "model.worker".
- The only available model permission is "model.worker".
- Inside ai.generate prompts, reference only "{{ input.somePath }}" templates.
- Use "{{ item.* }}" only for parallel item selectors and branch step input mapping, not inside ai.generate prompts.

Parallel contract:
- A parallel step must have uses: "parallel".
- A parallel step must include with.items, with.itemKey, with.maxBranches, with.maxConcurrency, with.failureMode, with.cardinality, and with.fanIn.
- Use with.items: "{{ input.candidates }}".
- Use with.itemKey: "{{ item.id }}".
- Use with.failureMode: "fail_fast".
- Use with.cardinality: { "kind": "matches_items" }.
- Use with.fanIn: { "order": "input", "output": "array", "outputStep": "score-candidate" }.
- A parallel step output must use mode: "array" and an envelope schema with itemKey, status, artifacts, and output.

The workflow should:
1. Use one parallel step to score each candidate with an ai.generate branch step.
2. Use one final ai.generate step after the parallel step to extract completed branch outputs and return a ranked array sorted by score descending.
3. Return a final array of objects with id, score (0-100), and reasoning fields.

Use this valid LWIR as the structural pattern. Adapt names and schemas only when needed:

${JSON.stringify(VALID_PARALLEL_LWIR_EXAMPLE, null, 2)}

Return only valid JSON. Do not wrap the response in Markdown fences or explanatory text.`;
