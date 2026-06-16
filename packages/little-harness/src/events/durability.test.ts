import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  findModelReplay,
  findToolReplay,
  hashHarnessPrompt,
  hashHarnessToolCall,
  sha256Digest,
} from "./durability.js";

describe("durable harness hashing", () => {
  it("hashes semantically equal model requests with the legacy sha256 prefix", () => {
    const request = {
      model: "test",
      messages: [{ role: "user", content: "hi" }],
      tools: [],
    };

    expect(hashHarnessPrompt(request)).toBe(
      hashHarnessPrompt({ tools: [], messages: request.messages, model: "test" }),
    );
    expect(hashHarnessPrompt(request)).toMatch(/^sha256:/);
  });

  it("matches Little Workflow canonical fixture vectors", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(sha256Digest({ b: 1, a: 2 })).toBe(
      "sha256:d3626ac30a87e6f7a6428233b3c68299976865fa5508e4267c5415c76af7a772",
    );
    expect(hashHarnessPrompt({ b: 1, a: 2 })).toBe(
      "sha256:d3626ac30a87e6f7a6428233b3c68299976865fa5508e4267c5415c76af7a772",
    );
    expect(sha256Digest("Lookup tool")).toBe(
      "sha256:6de1d4670c63c21ceffbf908fac2be01a0c5522a7a62b7ade27afdae04e8272d",
    );
    expect(
      sha256Digest({
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      }),
    ).toBe("sha256:3797626bd17e346de1adbbe242cd2c4e41a5956ccf7424c65cf45e2bbef10c81");
  });

  it("rejects objects with non-enumerable own data properties", () => {
    const value = { visible: true } as { visible: boolean; hidden?: string };
    Object.defineProperty(value, "hidden", {
      enumerable: false,
      value: "secret",
    });

    expect(() => canonicalJson(value)).toThrow(/Non-enumerable/);
    expect(() => sha256Digest(value)).toThrow(/Non-enumerable/);
  });

  it("rejects own getters without invoking them", () => {
    let invoked = false;
    const value = { visible: true };
    Object.defineProperty(value, "hidden", {
      enumerable: false,
      get() {
        invoked = true;
        throw new Error("getter should not run");
      },
    });

    expect(() => canonicalJson(value)).toThrow(/Accessors/);
    expect(invoked).toBe(false);
  });

  it("rejects arrays with extra own properties", () => {
    const value = ["lookup"] as string[] & { extra?: string };
    value.extra = "ignored";

    expect(() => canonicalJson(value)).toThrow(/extra own properties/);
  });

  it("rejects sparse arrays", () => {
    const value = ["first", , "third"];

    expect(() => canonicalJson(value)).toThrow(/Sparse arrays/);
  });

  it("hashes tool calls with caller as part of identity", () => {
    const args = { id: "1" };

    expect(hashHarnessToolCall({ caller: "model", toolName: "lookup", args, turn: 1 })).toBe(
      "sha256:7ca048aff19e7b85ec107abdbe08eef0b6e1fb3f77372105f01e7f3e304eb26d",
    );
    expect(hashHarnessToolCall({ caller: "model", toolName: "lookup", args, turn: 1 })).not.toBe(
      hashHarnessToolCall({ caller: "runtime", toolName: "lookup", args }),
    );
  });

  it("ignores supplied turn for runtime tool calls", () => {
    const args = { id: "1" };
    const runtimeCall = { caller: "runtime" as const, toolName: "lookup", args };

    expect(hashHarnessToolCall({ ...runtimeCall, turn: 9 })).toBe(
      hashHarnessToolCall(runtimeCall),
    );
    expect(hashHarnessToolCall(runtimeCall)).not.toBe(
      hashHarnessToolCall({ caller: "model", toolName: "lookup", args, turn: 9 }),
    );
    expect(hashHarnessToolCall(runtimeCall)).not.toBe(
      hashHarnessToolCall({ caller: "code", toolName: "lookup", args, turn: 9 }),
    );
  });

  it("returns the latest completed model replay before the next matching call", () => {
    const request = { model: "test", messages: [], tools: [] };
    const promptHash = hashHarnessPrompt(request);

    const replay = findModelReplay([
      event(1, "harness.model.called", { turn: 1, callId: "call_1", promptHash, request }),
      event(2, "harness.model.responded", { turn: 1, callId: "call_1", response: { text: "old", usage: {} } }),
      event(3, "harness.model.called", { turn: 1, callId: "call_2", promptHash, request }),
      event(4, "harness.model.responded", { turn: 1, callId: "call_2", response: { text: "new", usage: {} } }),
    ], request);

    expect(replay).toEqual({
      kind: "completed",
      turn: 1,
      callId: "call_2",
      response: { text: "new", usage: {} },
    });
  });

  it("returns inflight only for the latest matching model call", () => {
    const request = { model: "test", messages: [], tools: [] };
    const promptHash = hashHarnessPrompt(request);

    const replay = findModelReplay([
      event(1, "harness.model.called", { turn: 1, callId: "call_1", promptHash, request }),
      event(2, "harness.model.responded", { turn: 1, callId: "call_1", response: { text: "old", usage: {} } }),
      event(3, "harness.model.called", { turn: 1, callId: "call_2", promptHash, request }),
    ], request);

    expect(replay).toEqual({ kind: "inflight", turn: 1, callId: "call_2" });
  });

  it("does not replay a model call whose latest terminal event failed", () => {
    const request = { model: "test", messages: [], tools: [] };
    const promptHash = hashHarnessPrompt(request);

    const replay = findModelReplay([
      event(1, "harness.model.called", { turn: 1, callId: "call_failed", promptHash, request }),
      event(2, "harness.model.failed", {
        turn: 1,
        callId: "call_failed",
        error: { name: "Error", message: "provider down" },
      }),
    ], request);

    expect(replay).toEqual({ kind: "none" });
  });

  it("replays legacy sha256-prefixed prompt hashes", () => {
    const request = { model: "test", messages: [], tools: [] };

    const replay = findModelReplay([
      event(1, "harness.model.called", { turn: 1, callId: "call_legacy", promptHash: hashHarnessPrompt(request), request }),
      event(2, "harness.model.responded", { turn: 1, callId: "call_legacy", response: { text: "legacy", usage: {} } }),
    ], request);

    expect(replay).toEqual({
      kind: "completed",
      turn: 1,
      callId: "call_legacy",
      response: { text: "legacy", usage: {} },
    });
  });

  it("does not replay otherwise identical prompts across different step scopes", () => {
    const firstRequest = {
      model: "test",
      messages: [{ role: "user", content: "same" }],
      tools: [],
      scope: { role: "worker", stepPath: "draft" },
      step: { id: "draft", uses: "ai.generate", with: { model: "worker" } },
    };
    const secondRequest = {
      ...firstRequest,
      scope: { role: "worker", stepPath: "review" },
      step: { id: "review", uses: "ai.generate", with: { model: "worker" } },
    };

    expect(findModelReplay([
      event(1, "harness.model.called", { turn: 1, callId: "call_draft", promptHash: hashHarnessPrompt(firstRequest), request: firstRequest }),
      event(2, "harness.model.responded", { turn: 1, callId: "call_draft", response: { text: "draft", usage: {} } }),
    ], secondRequest)).toEqual({ kind: "none" });
  });

  it("does not replay unsafe legacy stripped prompt hashes into scoped requests", () => {
    const legacyRequest = { model: "test", messages: [{ role: "user", content: "same" }], tools: [] };
    const scopedRequest = {
      ...legacyRequest,
      scope: { role: "worker", stepPath: "review" },
      step: { id: "review", uses: "ai.generate", with: { model: "worker" } },
    };

    expect(findModelReplay([
      event(1, "harness.model.called", { turn: 1, callId: "call_legacy", promptHash: hashHarnessPrompt(legacyRequest), request: legacyRequest }),
      event(2, "harness.model.responded", { turn: 1, callId: "call_legacy", response: { text: "legacy", usage: {} } }),
    ], scopedRequest)).toEqual({ kind: "none" });
  });

  it("returns completed and failed tool replays using call sequence windows", () => {
    const call = { caller: "model" as const, toolName: "lookup", args: { id: "1" }, turn: 1, callIndex: 1 };
    const callId = hashHarnessToolCall(call);

    const replay = findToolReplay([
      event(1, "harness.tool_call.started", { ...call, callId }),
      event(2, "harness.tool_call.failed", { callId, error: { name: "Error", message: "old" }, durationMs: 1 }),
      event(3, "harness.tool_call.started", { ...call, callId }),
      event(4, "harness.tool_call.succeeded", { callId, result: { ok: true }, durationMs: 2 }),
    ], call);

    expect(replay).toEqual({ kind: "completed", result: { ok: true } });
  });

  it("returns failed for the latest matching terminal failed tool call", () => {
    const call = { caller: "model" as const, toolName: "lookup", args: { id: "1" }, turn: 1, callIndex: 1 };
    const callId = hashHarnessToolCall(call);

    const replay = findToolReplay([
      event(1, "harness.tool_call.started", { ...call, callId }),
      event(2, "harness.tool_call.failed", { callId, error: { name: "Error", message: "not found" }, durationMs: 1 }),
    ], call);

    expect(replay).toEqual({ kind: "failed", error: { name: "Error", message: "not found" } });
  });

  it("replays runtime tool calls without colliding with model or code callers", () => {
    const runtimeCall = { caller: "runtime" as const, toolName: "bash", args: { command: "pwd" } };
    const runtimeCallId = hashHarnessToolCall(runtimeCall);
    const events = [
      event(1, "harness.tool_call.started", { ...runtimeCall, callId: runtimeCallId }),
      event(2, "harness.tool_call.succeeded", { callId: runtimeCallId, result: { stdout: "/tmp" }, durationMs: 2 }),
    ];

    expect(findToolReplay(events, runtimeCall)).toEqual({ kind: "completed", result: { stdout: "/tmp" } });
    expect(findToolReplay(events, { caller: "model", toolName: "bash", args: { command: "pwd" }, turn: 1 })).toEqual({ kind: "none" });
    expect(findToolReplay(events, { caller: "code", toolName: "bash", args: { command: "pwd" } })).toEqual({ kind: "none" });
  });
});

function event(sequence: number, type: string, payload: Record<string, unknown>) {
  return {
    eventId: `evt_${sequence}`,
    sequence,
    type,
    runId: "run_1",
    recordedAt: "2026-06-07T00:00:00.000Z",
    payload,
  };
}
