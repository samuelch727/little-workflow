import { test } from "node:test";
import assert from "node:assert/strict";
import {
  collectTickets,
  distributionFor,
  harvestRunWorkflowResults,
  renumberTickets,
  summarizeEvents,
  sumUsageFromEvents,
  toAnswerKeyCsv,
  validateDataset,
} from "./eval.mjs";

test("harvestRunWorkflowResults joins started + succeeded by callId", () => {
  const events = [
    { type: "harness.tool_call.started", payload: { callId: "a", toolName: "plan_workflow" } },
    { type: "harness.tool_call.succeeded", payload: { callId: "a", result: { workflowVersionId: "wv" } } },
    { type: "harness.tool_call.started", payload: { callId: "b", toolName: "run_workflow" } },
    { type: "harness.tool_call.succeeded", payload: { callId: "b", result: { runId: "r1", status: "completed", output: [{ x: 1 }] } } },
  ];
  const results = harvestRunWorkflowResults(events);
  assert.equal(results.length, 1);
  assert.equal(results[0].runId, "r1");
  assert.deepEqual(results[0].output, [{ x: 1 }]);
});

test("harvestRunWorkflowResults also captures start_workflow results", () => {
  const events = [
    { type: "harness.tool_call.started", payload: { callId: "c", toolName: "start_workflow" } },
    { type: "harness.tool_call.succeeded", payload: { callId: "c", result: { runId: "r2", status: "completed", output: [{ y: 2 }] } } },
  ];
  const results = harvestRunWorkflowResults(events);
  assert.equal(results.length, 1);
  assert.deepEqual(results[0].output, [{ y: 2 }]);
});

test("collectTickets flattens arrays and unwraps common envelopes", () => {
  const results = [
    { output: [{ a: 1 }, { a: 2 }] },
    { output: { elements: [{ a: 3 }] } },
    { output: { tickets: [{ a: 4 }] } },
    { output: null },
  ];
  assert.equal(collectTickets(results).length, 4);
});

test("renumberTickets assigns sequential ids", () => {
  const tickets = renumberTickets([{ ticket_id: "x" }, { ticket_id: "y" }]);
  assert.deepEqual(tickets.map((t) => t.ticket_id), ["TICKET-0001", "TICKET-0002"]);
});

test("validateDataset counts valid and invalid", () => {
  const tickets = [
    { ticket_id: "TICKET-0001" }, // invalid (missing fields)
  ];
  const report = validateDataset(tickets);
  assert.equal(report.total, 1);
  assert.equal(report.validCount, 0);
  assert.equal(report.invalidCount, 1);
});

test("distributionFor computes actual shares", () => {
  const tickets = [
    { category: "Billing" },
    { category: "Billing" },
    { category: "Onboarding" },
  ];
  const rows = distributionFor(tickets, "category", { Billing: 0.5, Onboarding: 0.5 });
  const billing = rows.find((r) => r.label === "Billing");
  assert.equal(billing.actual, 2);
  assert.ok(Math.abs(billing.actualShare - 2 / 3) < 1e-9);
});

test("sumUsageFromEvents totals model usage", () => {
  const events = [
    { type: "harness.model.responded", payload: { response: { usage: { inputTokens: 10, outputTokens: 5 } } } },
    { type: "harness.model.responded", payload: { response: { usage: { inputTokens: 3, outputTokens: 2 } } } },
  ];
  assert.deepEqual(sumUsageFromEvents(events), { inputTokens: 13, outputTokens: 7 });
});

test("summarizeEvents counts types and failures", () => {
  const events = [
    { type: "harness.tool_call.failed" },
    { type: "harness.tool_call.succeeded" },
    { type: "harness.tool_call.succeeded" },
  ];
  const summary = summarizeEvents(events);
  assert.equal(summary.toolFailures, 1);
  assert.equal(summary.byType["harness.tool_call.succeeded"], 2);
});

test("toAnswerKeyCsv writes a header and escapes commas/quotes", () => {
  const csv = toAnswerKeyCsv([
    { ticket_id: "TICKET-0001", category: "Billing", urgency: "High", sentiment: "Angry", summary: "a, b", recommended_action: 'say "hi"' },
  ]);
  const lines = csv.trim().split("\n");
  assert.equal(lines[0], "ticket_id,category,urgency,sentiment,summary,recommended_action");
  assert.ok(lines[1].includes('"a, b"'));
  assert.ok(lines[1].includes('"say ""hi"""'));
});
