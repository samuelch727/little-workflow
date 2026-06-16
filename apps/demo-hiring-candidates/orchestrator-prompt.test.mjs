import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeBatchPlan,
  buildOrchestratorInput,
  buildPostOrchestratorInput,
  CANDIDATE_BATCH_WORKFLOW_ID,
  POST_WORKFLOW_ID,
} from "./orchestrator-prompt.mjs";

test("computeBatchPlan splits a total into evenly-sized contiguous batches", () => {
  const plan = computeBatchPlan(100, 10);
  assert.equal(plan.length, 10);
  assert.deepEqual(plan[0], { startIndex: 1, count: 10 });
  assert.deepEqual(plan[9], { startIndex: 91, count: 10 });
});

test("computeBatchPlan makes the final batch smaller when it doesn't divide evenly", () => {
  const plan = computeBatchPlan(95, 10);
  assert.equal(plan.length, 10);
  assert.deepEqual(plan.at(-1), { startIndex: 91, count: 5 });
  assert.equal(
    plan.reduce((sum, b) => sum + b.count, 0),
    95,
  );
});

test("computeBatchPlan returns one batch when total < batchSize", () => {
  assert.deepEqual(computeBatchPlan(7, 10), [{ startIndex: 1, count: 7 }]);
});

test("computeBatchPlan rejects invalid arguments", () => {
  assert.throws(() => computeBatchPlan(0, 10));
  assert.throws(() => computeBatchPlan(10, 0));
  assert.throws(() => computeBatchPlan(1.5, 10));
});

test("buildOrchestratorInput carries the role, counts, and workflow id", () => {
  const input = buildOrchestratorInput({
    goal: "GOAL-MD",
    role: { role_title: "Backend Engineer, Payments", role_brief: "ships ledgers", key_skills: ["Go", "Kafka"] },
    totalCandidateCount: 100,
    batchSize: 10,
    startIndexBase: 51,
  });
  assert.equal(input.goal, "GOAL-MD");
  assert.equal(input.role_title, "Backend Engineer, Payments");
  assert.equal(input.role_brief, "ships ledgers");
  assert.deepEqual(input.key_skills, ["Go", "Kafka"]);
  assert.equal(input.totalCandidateCount, 100);
  assert.equal(input.batchSize, 10);
  assert.equal(input.startIndexBase, 51);
  assert.equal(input.workflowId, CANDIDATE_BATCH_WORKFLOW_ID);
});

test("buildPostOrchestratorInput carries the goal and the post workflow id", () => {
  const input = buildPostOrchestratorInput({ goal: "GOAL-MD" });
  assert.equal(input.goal, "GOAL-MD");
  assert.equal(input.workflowId, POST_WORKFLOW_ID);
});
