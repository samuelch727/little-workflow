import { test } from "node:test";
import assert from "node:assert/strict";
import {
  harvestRunWorkflowResults,
  dedupeRunWorkflowResults,
  collectCandidates,
  limitCandidateCount,
  renumberCandidates,
  validateDataset,
  toCandidateCsv,
  sumUsageFromEvents,
  distributionFor,
  summarizeEvents,
} from "./eval.mjs";

test("harvestRunWorkflowResults joins started/succeeded and keeps only sub-run tools", () => {
  const events = [
    { type: "harness.tool_call.started", payload: { callId: "c1", toolName: "plan_workflow" } },
    { type: "harness.tool_call.succeeded", payload: { callId: "c1", result: { workflowVersionId: "wv1" } } },
    { type: "harness.tool_call.started", payload: { callId: "c2", toolName: "run_workflow" } },
    {
      type: "harness.tool_call.succeeded",
      payload: { callId: "c2", result: { runId: "r2", status: "completed", output: [{ full_name: "A" }] } },
    },
  ];
  const results = harvestRunWorkflowResults(events);
  assert.equal(results.length, 1); // plan_workflow excluded
  assert.equal(results[0].runId, "r2");
  assert.equal(results[0].status, "completed");
  assert.deepEqual(results[0].args, undefined);
});

test("harvestRunWorkflowResults carries run_workflow args for batch identity", () => {
  const events = [
    {
      type: "harness.tool_call.started",
      payload: {
        callId: "c1",
        toolName: "run_workflow",
        args: { input: { startIndex: 11, count: 10 } },
      },
    },
    {
      type: "harness.tool_call.succeeded",
      payload: { callId: "c1", result: { runId: "r1", status: "completed", output: [{ full_name: "B" }] } },
    },
  ];
  const results = harvestRunWorkflowResults(events);
  assert.deepEqual(results[0].args, { input: { startIndex: 11, count: 10 } });
});

test("dedupeRunWorkflowResults keeps one completed result per batch startIndex", () => {
  const results = dedupeRunWorkflowResults([
    {
      runId: "attempt-1-batch-1",
      status: "failed",
      args: { input: { startIndex: 1 } },
      output: undefined,
    },
    {
      runId: "attempt-2-batch-1",
      status: "completed",
      args: { input: { startIndex: 1 } },
      output: [{ full_name: "A" }],
    },
    {
      runId: "attempt-1-batch-2",
      status: "completed",
      args: { input: { startIndex: 11 } },
      output: [{ full_name: "B" }],
    },
    {
      runId: "attempt-2-batch-2",
      status: "completed",
      args: { input: { startIndex: 11 } },
      output: [{ full_name: "B duplicate" }],
    },
  ]);

  assert.deepEqual(
    results.map((result) => result.runId),
    ["attempt-2-batch-1", "attempt-1-batch-2"],
  );
});

test("collectCandidates flattens bare arrays and wrapped objects, ignoring empties", () => {
  const results = [
    { output: [{ full_name: "A" }] },
    { output: { elements: [{ full_name: "B" }] } },
    { output: { candidates: [{ full_name: "C" }] } },
    { output: null },
    { output: { nope: 1 } },
  ];
  assert.deepEqual(
    collectCandidates(results).map((c) => c.full_name),
    ["A", "B", "C"],
  );
});

test("renumberCandidates assigns global sequential ids", () => {
  const out = renumberCandidates([{ candidate_id: "x" }, { candidate_id: "y" }]);
  assert.deepEqual(
    out.map((c) => c.candidate_id),
    ["CAND-0001", "CAND-0002"],
  );
});

test("limitCandidateCount keeps exactly the requested count when workers overproduce", () => {
  const out = limitCandidateCount([{ n: 1 }, { n: 2 }, { n: 3 }], 2);
  assert.deepEqual(out, [{ n: 1 }, { n: 2 }]);
});

const VALID = {
  candidate_id: "CAND-0001",
  full_name: "Ada Devlin",
  email: "a@example.com",
  location: "Remote (US)",
  headline: "Senior Backend Engineer",
  years_experience: 8,
  current_company: "Fakerly Inc",
  top_skills: ["Go", "Kafka"],
  education: "Bachelor's",
  summary: "Ledger-scaling backend engineer.",
  desired_salary_usd: 185000,
  source: "LinkedIn",
  seniority: "Senior",
  status: "Applied",
  match_score: 88,
};

test("validateDataset counts valid and invalid", () => {
  const report = validateDataset([VALID, { full_name: "Incomplete" }]);
  assert.equal(report.total, 2);
  assert.equal(report.validCount, 1);
  assert.equal(report.invalidCount, 1);
  assert.equal(report.problems.length, 1);
});

test("toCandidateCsv has a header and quotes fields containing commas", () => {
  const csv = toCandidateCsv([{ ...VALID, full_name: "Doe, Jane" }]);
  const lines = csv.trim().split("\n");
  assert.ok(lines[0].includes("candidate_id"));
  assert.ok(lines[1].includes('"Doe, Jane"'));
});

test("sumUsageFromEvents sums harness.model.responded usage and tolerates gaps", () => {
  const events = [
    { type: "harness.model.responded", payload: { response: { usage: { inputTokens: 100, outputTokens: 30 } } } },
    { type: "harness.model.responded", payload: { response: { usage: { inputTokens: 50, outputTokens: 20 } } } },
    { type: "harness.model.responded", payload: {} },
    { type: "RunStarted", payload: {} },
  ];
  assert.deepEqual(sumUsageFromEvents(events), { inputTokens: 150, outputTokens: 50 });
  assert.deepEqual(sumUsageFromEvents([]), { inputTokens: 0, outputTokens: 0 });
});

test("distributionFor counts a field and computes actual vs target shares", () => {
  const candidates = [{ seniority: "Senior" }, { seniority: "Senior" }, { seniority: "Mid" }, { seniority: "Junior" }];
  const rows = distributionFor(candidates, "seniority", { Senior: 0.5, Mid: 0.25, Junior: 0.25 });
  const senior = rows.find((r) => r.label === "Senior");
  assert.equal(senior.actual, 2);
  assert.equal(senior.actualShare, 0.5);
  assert.equal(senior.targetShare, 0.5);
});

test("summarizeEvents counts event types and flags tool failures", () => {
  const summary = summarizeEvents([
    { type: "RunStarted" },
    { type: "harness.tool_call.failed" },
    { type: "harness.tool_call.failed" },
    { type: "RunStarted" },
  ]);
  assert.equal(summary.byType.RunStarted, 2);
  assert.equal(summary.toolFailures, 2);
});
