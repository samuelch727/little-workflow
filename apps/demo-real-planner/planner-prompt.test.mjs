import assert from "node:assert/strict";
import test from "node:test";
import { validateLwir } from "little-workflow";
import {
  PLANNER_SYSTEM_PROMPT,
  VALID_PARALLEL_LWIR_EXAMPLE,
} from "./planner-prompt.mjs";

test("planner prompt example is valid alpha LWIR", () => {
  assert.deepEqual(validateLwir(VALID_PARALLEL_LWIR_EXAMPLE), {
    valid: true,
    findings: [],
  });
});

test("planner prompt forbids common non-alpha workflow shapes", () => {
  assert.match(PLANNER_SYSTEM_PROMPT, /"uses": "parallel"/u);
  assert.match(PLANNER_SYSTEM_PROMPT, /"uses": "ai\.generate"/u);
  assert.match(PLANNER_SYSTEM_PROMPT, /Do not use "kind", "type", "map", "sort", "transform", or "core\.\*" for steps/u);
});

test("planner prompt keeps item templates out of ai.generate prompts", () => {
  assert.doesNotMatch(PLANNER_SYSTEM_PROMPT, /prompt templates only.*item\.somePath/iu);
  assert.match(PLANNER_SYSTEM_PROMPT, /Inside ai\.generate prompts, reference only "\{\{ input\.[^"]+ \}\}"/u);
  assert.match(PLANNER_SYSTEM_PROMPT, /Use "\{\{ item\.\* \}\}" only for parallel item selectors/u);
});

// ---------------------------------------------------------------------------
// Task 5: generateLwirFromPlanner (v6 structured output)
// ---------------------------------------------------------------------------

import { generateLwirFromPlanner } from "./run.mjs";

test("generateLwirFromPlanner (v6 structured output) passes output: Output.object({schema}) to streamText", async () => {
  const captured = { request: undefined };
  const fakeStreamText = (request) => {
    captured.request = request;
    const lwir = {
      apiVersion: "littleworkflow.dev/v0.1",
      kind: "Workflow",
      metadata: { name: "fake.workflow" },
      steps: [{ id: "s", uses: "ai.generate" }],
    };
    return {
      text: Promise.resolve(JSON.stringify(lwir)),
      usage: Promise.resolve({ inputTokens: 1, outputTokens: 1 }),
      output: Promise.resolve(lwir),
    };
  };
  const lwir = await generateLwirFromPlanner({
    model: { providerId: "demo", modelId: "demo" },
    task: { workflowSnapshot: { id: "demo" } },
    streamText: fakeStreamText,
  });
  assert.ok(captured.request, "streamText was called with a request");
  assert.ok(captured.request.output, "request includes output field");
  assert.equal(lwir.kind, "Workflow");
});
