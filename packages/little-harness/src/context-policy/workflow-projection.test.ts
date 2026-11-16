import type { ModelMessage } from "ai";
import { expect, it } from "vitest";
import { compactContext, inMemoryContextCheckpointStore } from "./policy.js";

const source = (): ModelMessage[] => [
  { role: "user", content: "Keep the task and permissions exactly." },
  ...[1, 2, 3].flatMap((n): ModelMessage[] => [
    { role: "assistant", content: [{ type: "tool-call", toolCallId: `c${n}`, toolName: "lookup", input: { id: n } }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: `c${n}`, toolName: "lookup", output: { type: "json", value: { id: `record-${n}`, status: "ok", body: "資料 content ".repeat(500), decision: "retain", artifact: "/artifacts/exact" } } }] },
  ]),
];
const input = () => ({ sessionId: "s", messages: source(), policy: { triggerTokens: 2000, summaryModel: false as const }, runtime: {
  store: inMemoryContextCheckpointStore(), model: { modelId: "fake", providerId: "fake", maxOutputTokens: 100, contextWindow: { tokens: 100000, source: "fixture" } },
} });
it("projects earlier completed Workflow JSON leaves, preserving current round, protocol and canonical input", async () => {
  const i = input(), canonical = structuredClone(i.messages);
  const projected = await compactContext({ ...i, projectCompletedWorkflowRounds: true });
  expect(projected[0]).toEqual(canonical[0]);
  expect(projected.slice(-2)).toEqual(canonical.slice(-2));
  expect(projected[1]).toEqual(canonical[1]);
  expect(projected[2]).toMatchObject({ content: [{ toolCallId: "c1", output: { type: "json", value: { id: "record-1", status: "ok", decision: "retain", artifact: "/artifacts/exact", body: expect.stringContaining("canonical result c1") } } }] });
  expect(i.messages).toEqual(canonical);
  expect(JSON.stringify(projected).length).toBeLessThan(JSON.stringify(canonical).length / 2);
  // The exact same single-turn history remains protected in ordinary Harness calls.
  expect(await compactContext(input())).toEqual(canonical);
});
it("retains approvals, pending calls, error output and semantic metadata", async () => {
  const i = input();
  const call = { role: "assistant" as const, content: [{ type: "tool-call" as const, toolCallId: "pending", toolName: "lookup", input: {} }] };
  const projected = await compactContext({ ...i, messages: [...i.messages, call], projectCompletedWorkflowRounds: true });
  expect(projected.at(-1)).toEqual(call);
  const error = source();
  error[2] = { role: "tool", content: [{ type: "tool-result", toolCallId: "c1", toolName: "lookup", output: { type: "error-text", value: "error ".repeat(1000) } }] };
  expect((await compactContext({ ...input(), messages: error, projectCompletedWorkflowRounds: true }))[2]).toEqual(error[2]);
  const approval = [...i.messages, { role: "assistant", content: [{ type: "tool-approval-request", approvalId: "approval", toolCallId: "pending" }] }] as ModelMessage[];
  expect(await compactContext({ ...input(), messages: approval, projectCompletedWorkflowRounds: true })).toEqual(approval);
});
