import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { runWorkerLiveCall } from "./run.mjs";

describe("runWorkerLiveCall (v6 structured output)", () => {
  it("uses Output.object for object mode", async () => {
    const captured = { request: undefined };
    const fakeStreamText = (request) => {
      captured.request = request;
      return {
        text: Promise.resolve('{"ok":true}'),
        usage: Promise.resolve({ inputTokens: 1, outputTokens: 1 }),
        output: Promise.resolve({ ok: true }),
      };
    };
    const result = await runWorkerLiveCall({
      model: { providerId: "demo", modelId: "demo" },
      prompt: "p",
      outputMode: "object",
      schema: { type: "object", properties: { ok: { type: "boolean" } } },
      streamText: fakeStreamText,
    });
    assert.ok(captured.request, "streamText was called");
    assert.ok(captured.request.output, "request.output set (structured output)");
    assert.deepEqual(result.output, { ok: true });
  });

  it("uses Output.object with top-level array schema for array mode", async () => {
    const captured = { request: undefined };
    const fakeStreamText = (request) => {
      captured.request = request;
      return {
        text: Promise.resolve('[1,2,3]'),
        usage: Promise.resolve({ inputTokens: 1, outputTokens: 1 }),
        output: Promise.resolve([1, 2, 3]),
      };
    };
    const result = await runWorkerLiveCall({
      model: { providerId: "demo", modelId: "demo" },
      prompt: "p",
      outputMode: "array",
      schema: { type: "array", items: { type: "number" } },
      streamText: fakeStreamText,
    });
    assert.ok(captured.request.output, "request.output set");
    assert.deepEqual(result.output, [1, 2, 3]);
  });

  it("uses Output.text for text mode", async () => {
    const captured = { request: undefined };
    const fakeStreamText = (request) => {
      captured.request = request;
      return {
        text: Promise.resolve("hello"),
        usage: Promise.resolve({ inputTokens: 1, outputTokens: 1 }),
        output: Promise.resolve("hello"),
      };
    };
    const result = await runWorkerLiveCall({
      model: { providerId: "demo", modelId: "demo" },
      prompt: "p",
      outputMode: "text",
      streamText: fakeStreamText,
    });
    assert.ok(captured.request.output, "request.output set (Output.text)");
    assert.equal(result.text, "hello");
  });
});
