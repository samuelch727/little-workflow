import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BATCH_LWIR_EXAMPLE,
  BATCH_WORKFLOW_ID,
  buildOrchestratorInput,
  computeBatchPlan,
} from "./orchestrator-prompt.mjs";

test("computeBatchPlan splits evenly", () => {
  assert.deepEqual(computeBatchPlan(20, 10), [
    { startIndex: 1, count: 10 },
    { startIndex: 11, count: 10 },
  ]);
});

test("computeBatchPlan handles a short final batch", () => {
  const plan = computeBatchPlan(25, 10);
  assert.deepEqual(plan, [
    { startIndex: 1, count: 10 },
    { startIndex: 11, count: 10 },
    { startIndex: 21, count: 5 },
  ]);
  assert.equal(plan.reduce((sum, b) => sum + b.count, 0), 25);
});

test("computeBatchPlan single batch", () => {
  assert.deepEqual(computeBatchPlan(5, 10), [{ startIndex: 1, count: 5 }]);
});

test("computeBatchPlan rejects bad input", () => {
  assert.throws(() => computeBatchPlan(0, 10));
  assert.throws(() => computeBatchPlan(10, 0));
});

test("buildOrchestratorInput carries goal, counts, and workflow id", () => {
  const input = buildOrchestratorInput({ goal: "spec", totalTicketCount: 20, batchSize: 10 });
  assert.equal(input.goal, "spec");
  assert.equal(input.totalTicketCount, 20);
  assert.equal(input.batchSize, 10);
  assert.equal(input.workflowId, BATCH_WORKFLOW_ID);
});

test("BATCH_LWIR_EXAMPLE has the expected single ai.generate step shape", () => {
  assert.equal(BATCH_LWIR_EXAMPLE.steps.length, 1);
  const [step] = BATCH_LWIR_EXAMPLE.steps;
  assert.equal(step.uses, "ai.generate");
  assert.equal(step.with.model, "model.worker");
  assert.equal(step.output.mode, "array");
});
