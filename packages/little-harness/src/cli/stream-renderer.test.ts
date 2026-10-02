import { expect, it } from "vitest";
import { renderUiMessageStream } from "./stream-renderer.js";

async function render(chunks: readonly Record<string, unknown>[]): Promise<string> {
  const written: string[] = [];
  await renderUiMessageStream(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(chunk);
        }
        controller.close();
      },
    }),
    (text) => {
      written.push(text);
    },
  );
  return written.join("");
}

it("labels assistant and reasoning sections while preserving streamed newlines", async () => {
  await expect(
    render([
      { type: "text-start", id: "text_1" },
      { type: "text-delta", id: "text_1", delta: "Hello\n" },
      { type: "text-delta", id: "text_1", delta: "there" },
      { type: "text-end", id: "text_1" },
      { type: "reasoning-start", id: "reasoning_1" },
      {
        type: "reasoning-delta",
        id: "reasoning_1",
        delta: "Checking account\nstate.",
      },
      { type: "reasoning-end", id: "reasoning_1" },
    ]),
  ).resolves.toBe("[assistant]\nHello\nthere\n\n[reasoning]\nChecking account\nstate.\n");
});

it("ignores empty text and reasoning deltas without printing a section header", async () => {
  await expect(
    render([
      { type: "text-start", id: "text_1" },
      { type: "text-delta", id: "text_1", delta: "" },
      { type: "reasoning-start", id: "reasoning_1" },
      { type: "reasoning-delta", id: "reasoning_1", delta: "" },
      { type: "reasoning-end", id: "reasoning_1" },
    ]),
  ).resolves.toBe("");
});

it("prints tool input and output for UI message tool chunks", async () => {
  await expect(
    render([
      {
        type: "tool-input-available",
        toolCallId: "call_1",
        toolName: "lookupCustomer",
        input: { customerId: "cust_123", includeOrders: true },
      },
      {
        type: "tool-output-available",
        toolCallId: "call_1",
        toolName: "lookupCustomer",
        output: { status: "active", tier: "enterprise" },
      },
    ]),
  ).resolves.toBe(
    [
      "[tool call: lookupCustomer]",
      "input:",
      '{',
      '  "customerId": "cust_123",',
      '  "includeOrders": true',
      '}',
      "",
      "[tool result: lookupCustomer]",
      "output:",
      '{',
      '  "status": "active",',
      '  "tier": "enterprise"',
      '}',
      "",
    ].join("\n"),
  );
});

it("prints null tool outputs as null", async () => {
  await expect(
    render([
      {
        type: "tool-input-available",
        toolCallId: "call_null",
        toolName: "findOptionalAccount",
        input: { accountId: "missing" },
      },
      {
        type: "tool-output-available",
        toolCallId: "call_null",
        toolName: "findOptionalAccount",
        output: null,
      },
    ]),
  ).resolves.toBe(
    [
      "[tool call: findOptionalAccount]",
      "input:",
      "{",
      '  "accountId": "missing"',
      "}",
      "",
      "[tool result: findOptionalAccount]",
      "output:",
      "null",
      "",
    ].join("\n"),
  );
});

it("prints finalized tool input once after streamed input deltas", async () => {
  await expect(
    render([
      { type: "tool-input-start", toolCallId: "call_2", toolName: "searchOrders" },
      { type: "tool-input-delta", toolCallId: "call_2", inputTextDelta: '{"query":"' },
      {
        type: "tool-input-delta",
        toolCallId: "call_2",
        inputTextDelta: 'late shipment"}',
      },
      {
        type: "tool-input-available",
        toolCallId: "call_2",
        toolName: "searchOrders",
        input: { query: "late shipment" },
      },
      {
        type: "tool-output-available",
        toolCallId: "call_2",
        output: [{ orderId: "ord_1", status: "delayed" }],
      },
    ]),
  ).resolves.toBe(
    [
      "[tool call: searchOrders]",
      "input:",
      "{",
      '  "query": "late shipment"',
      "}",
      "",
      "[tool result: searchOrders]",
      "output:",
      "[",
      "  {",
      '    "orderId": "ord_1",',
      '    "status": "delayed"',
      "  }",
      "]",
      "",
    ].join("\n"),
  );
});

it("does not interleave parallel streamed tool inputs", async () => {
  await expect(
    render([
      { type: "tool-input-start", toolCallId: "call_a", toolName: "alpha" },
      { type: "tool-input-start", toolCallId: "call_b", toolName: "beta" },
      { type: "tool-input-delta", toolCallId: "call_a", inputTextDelta: '{"a":' },
      { type: "tool-input-delta", toolCallId: "call_b", inputTextDelta: '{"b":' },
      { type: "tool-input-delta", toolCallId: "call_a", inputTextDelta: "1}" },
      { type: "tool-input-delta", toolCallId: "call_b", inputTextDelta: "2}" },
      {
        type: "tool-input-available",
        toolCallId: "call_a",
        toolName: "alpha",
        input: { a: 1 },
      },
      {
        type: "tool-input-available",
        toolCallId: "call_b",
        toolName: "beta",
        input: { b: 2 },
      },
      { type: "tool-output-available", toolCallId: "call_a", output: { ok: "a" } },
      { type: "tool-output-available", toolCallId: "call_b", output: { ok: "b" } },
    ]),
  ).resolves.toBe(
    [
      "[tool call: alpha]",
      "input:",
      "{",
      '  "a": 1',
      "}",
      "",
      "[tool call: beta]",
      "input:",
      "{",
      '  "b": 2',
      "}",
      "",
      "[tool result: alpha]",
      "output:",
      "{",
      '  "ok": "a"',
      "}",
      "",
      "[tool result: beta]",
      "output:",
      "{",
      '  "ok": "b"',
      "}",
      "",
    ].join("\n"),
  );
});

it("prints stream-level errors as labeled blocks", async () => {
  await expect(
    render([
      { type: "text-start", id: "text_1" },
      { type: "text-delta", id: "text_1", delta: "Partial reply" },
      { type: "error", errorText: "Model stream failed" },
    ]),
  ).resolves.toBe("[assistant]\nPartial reply\n\n[error]\nModel stream failed\n");
});

it("prints stream read failures as labeled errors", async () => {
  const written: string[] = [];
  let pulls = 0;
  await expect(
    renderUiMessageStream(
      new ReadableStream({
        pull(controller) {
          pulls += 1;
          if (pulls === 1) {
            controller.enqueue({ type: "text-delta", id: "text_1", delta: "Partial reply" });
            return;
          }
          controller.error(new Error("Connection dropped"));
        },
      }),
      (text) => {
        written.push(text);
      },
    ),
  ).resolves.toMatchObject({ assistantText: "Partial reply", streamFailed: true });
  expect(written.join("")).toBe("[assistant]\nPartial reply\n\n[error]\nConnection dropped\n");
});

it("prints tool input errors with the rejected input payload", async () => {
  await expect(
    render([
      {
        type: "tool-input-error",
        toolCallId: "call_4",
        toolName: "lookupCustomer",
        input: { customerId: 123 },
        errorText: "Invalid input: customerId must be a string",
      },
    ]),
  ).resolves.toBe(
    [
      "[tool error: lookupCustomer]",
      "error:",
      "Invalid input: customerId must be a string",
      "input:",
      "{",
      '  "customerId": 123',
      "}",
      "",
    ].join("\n"),
  );
});

it("prints tool input errors without error text defensively", async () => {
  await expect(
    render([
      {
        type: "tool-input-error",
        toolCallId: "call_4b",
        toolName: "lookupCustomer",
        input: { customerId: 123 },
      },
    ]),
  ).resolves.toBe(
    [
      "[tool error: lookupCustomer]",
      "input:",
      "{",
      '  "customerId": 123',
      "}",
      "",
    ].join("\n"),
  );
});

it("does not reprint rejected tool input when a later result chunk includes input", async () => {
  await expect(
    render([
      {
        type: "tool-input-error",
        toolCallId: "call_4c",
        toolName: "lookupCustomer",
        input: { customerId: 123 },
        errorText: "Invalid input: customerId must be a string",
      },
      {
        type: "tool-result",
        toolCallId: "call_4c",
        toolName: "lookupCustomer",
        input: { customerId: 123 },
        output: { recovered: true },
      },
    ]),
  ).resolves.toBe(
    [
      "[tool error: lookupCustomer]",
      "error:",
      "Invalid input: customerId must be a string",
      "input:",
      "{",
      '  "customerId": 123',
      "}",
      "",
      "[tool result: lookupCustomer]",
      "output:",
      "{",
      '  "recovered": true',
      "}",
      "",
    ].join("\n"),
  );
});

it("prints tool output errors with the tool name remembered from input", async () => {
  await expect(
    render([
      {
        type: "tool-input-available",
        toolCallId: "call_5",
        toolName: "lookupCustomer",
        input: { customerId: "cust_123" },
      },
      {
        type: "tool-output-error",
        toolCallId: "call_5",
        errorText: "Customer service unavailable",
      },
    ]),
  ).resolves.toBe(
    [
      "[tool call: lookupCustomer]",
      "input:",
      "{",
      '  "customerId": "cust_123"',
      "}",
      "",
      "[tool error: lookupCustomer]",
      "error:",
      "Customer service unavailable",
      "",
    ].join("\n"),
  );
});

it("prints text-stream tool errors with the failed input payload", async () => {
  await expect(
    render([
      {
        type: "tool-error",
        toolCallId: "call_5b",
        toolName: "lookupCustomer",
        input: { customerId: "cust_missing" },
        error: new Error("Customer not found"),
      },
    ]),
  ).resolves.toBe(
    [
      "[tool error: lookupCustomer]",
      "error:",
      "Customer not found",
      "input:",
      "{",
      '  "customerId": "cust_missing"',
      "}",
      "",
    ].join("\n"),
  );
});

it("does not duplicate text-stream tool-error input after tool-input-end", async () => {
  await expect(
    render([
      { type: "tool-input-start", id: "call_5c", toolName: "lookupCustomer" },
      { type: "tool-input-delta", id: "call_5c", delta: '{"customerId":"cust_missing"}' },
      { type: "tool-input-end", id: "call_5c" },
      {
        type: "tool-error",
        toolCallId: "call_5c",
        toolName: "lookupCustomer",
        input: { customerId: "cust_missing" },
        error: new Error("Customer not found"),
      },
    ]),
  ).resolves.toBe(
    [
      "[tool call: lookupCustomer]",
      "input:",
      "{",
      '  "customerId": "cust_missing"',
      "}",
      "",
      "[tool error: lookupCustomer]",
      "error:",
      "Customer not found",
      "",
    ].join("\n"),
  );
});

it("does not duplicate text-stream tool-call input after tool-input-end", async () => {
  await expect(
    render([
      { type: "tool-input-start", id: "call_6", toolName: "lookupCustomer" },
      { type: "tool-input-delta", id: "call_6", delta: '{"customerId":"cust_123"}' },
      { type: "tool-input-end", id: "call_6" },
      {
        type: "tool-call",
        toolCallId: "call_6",
        toolName: "lookupCustomer",
        input: { customerId: "cust_123" },
      },
    ]),
  ).resolves.toBe(
    [
      "[tool call: lookupCustomer]",
      "input:",
      "{",
      '  "customerId": "cust_123"',
      "}",
      "",
    ].join("\n"),
  );
});

it("skips preliminary tool outputs and prints the final output", async () => {
  await expect(
    render([
      {
        type: "tool-input-available",
        toolCallId: "call_7",
        toolName: "slowLookup",
        input: { id: "1" },
      },
      {
        type: "tool-output-available",
        toolCallId: "call_7",
        output: { progress: 50 },
        preliminary: true,
      },
      { type: "tool-output-available", toolCallId: "call_7", output: { done: true } },
    ]),
  ).resolves.toBe(
    [
      "[tool call: slowLookup]",
      "input:",
      "{",
      '  "id": "1"',
      "}",
      "",
      "[tool result: slowLookup]",
      "output:",
      "{",
      '  "done": true',
      "}",
      "",
    ].join("\n"),
  );
});

it("prints denied tool output as a labeled block", async () => {
  await expect(
    render([
      {
        type: "tool-input-available",
        toolCallId: "call_8",
        toolName: "deleteAccount",
        input: { id: "1" },
      },
      { type: "tool-output-denied", toolCallId: "call_8" },
    ]),
  ).resolves.toBe(
    [
      "[tool call: deleteAccount]",
      "input:",
      "{",
      '  "id": "1"',
      "}",
      "",
      "[tool denied: deleteAccount]",
      "output:",
      "(denied)",
      "",
    ].join("\n"),
  );
});

it("prints tool-result input when no earlier tool input chunk was streamed", async () => {
  await expect(
    render([
      {
        type: "tool-result",
        toolCallId: "call_3",
        toolName: "calculateRefund",
        input: { orderId: "ord_1" },
        output: { refundCents: 4200 },
      },
    ]),
  ).resolves.toBe(
    [
      "[tool call: calculateRefund]",
      "input:",
      "{",
      '  "orderId": "ord_1"',
      "}",
      "",
      "[tool result: calculateRefund]",
      "output:",
      "{",
      '  "refundCents": 4200',
      "}",
      "",
    ].join("\n"),
  );
});
