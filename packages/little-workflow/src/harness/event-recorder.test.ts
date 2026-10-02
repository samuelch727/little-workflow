import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { localWorld } from "../authoring.js";
import { listEvents } from "../world.js";
import {
  createHarnessEventRecorder,
  errorEnvelope,
  hashHarnessPrompt,
  normalizeHarnessEventType,
} from "./event-recorder.js";

const tempDirs: string[] = [];

async function tempWorld() {
  const dataDir = await mkdtemp(join(tmpdir(), "little-workflow-harness-recorder-"));
  tempDirs.push(dataDir);
  return localWorld({ dataDir });
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("Harness event recorder", () => {
  it("decodes legacy PascalCase harness event names for replay", () => {
    expect(normalizeHarnessEventType("HarnessSessionStarted")).toBe("harness.session.started");
    expect(normalizeHarnessEventType("HarnessModelCalled")).toBe("harness.model.called");
    expect(normalizeHarnessEventType("HarnessToolCallSucceeded")).toBe("harness.tool_call.succeeded");
    expect(normalizeHarnessEventType("harness.session.started")).toBe("harness.session.started");
  });

  it("normalizes legacy session started appends to dotted events before persistence", async () => {
    const world = await tempWorld();
    const runId = "run_harness_recorder_session";
    const recorder = createHarnessEventRecorder({ world, runId });
    const manifest = {
      harnessId: "testHarness@1.0.0",
      role: "planner",
      model: { providerId: "openai", modelId: "gpt-5" },
    };
    const manifestHash = hashHarnessPrompt(manifest);

    await recorder.append({
      type: "HarnessSessionStarted",
      payload: {
        runId,
        role: "planner",
        task: { kind: "plan" },
        manifest,
        manifestHash,
      },
    });

    await expect(listEvents(world, runId)).resolves.toMatchObject([
      {
        type: "harness.session.started",
        payload: {
          runId,
          role: "planner",
          task: { kind: "plan" },
          manifest,
          manifestHash,
        },
      },
    ]);
  });

  it("records model call and response events in order", async () => {
    const world = await tempWorld();
    const runId = "run_harness_recorder_model";
    const recorder = createHarnessEventRecorder({ world, runId });
    const request = {
      model: "gpt-5",
      messages: [{ role: "user", content: "Plan it" }],
      tools: [{ toolName: "bash", schemaHash: "sha256:schema" }],
    };

    await recorder.append({
      type: "HarnessModelCalled",
      payload: {
        turn: 1,
        promptHash: hashHarnessPrompt(request),
        request,
      },
    });
    await recorder.append({
      type: "HarnessModelResponded",
      payload: {
        turn: 1,
        response: {
          text: "ok",
          toolCalls: [],
          usage: { inputTokens: 10, outputTokens: 2 },
        },
      },
    });

    const events = await listEvents(world, runId);
    expect(events.map((event) => event.type)).toEqual([
      "harness.model.called",
      "harness.model.responded",
    ]);
    expect(events.map((event) => event.sequence)).toEqual([1, 2]);
    expect(events[0]?.payload).toMatchObject({ turn: 1, request });
    expect(events[1]?.payload).toMatchObject({
      turn: 1,
      response: { text: "ok", usage: { inputTokens: 10, outputTokens: 2 } },
    });
  });

  it("records model failure events", async () => {
    const world = await tempWorld();
    const runId = "run_harness_recorder_model_failed";
    const recorder = createHarnessEventRecorder({ world, runId });

    await recorder.append({
      type: "HarnessModelFailed",
      payload: {
        callId: "call_1",
        turn: 1,
        error: {
          name: "HarnessModelCallTimeoutError",
          message: "Model call timed out after 10ms.",
          causeCode: "model_call_timeout",
        },
        durationMs: 10,
      },
    });

    const events = await listEvents(world, runId);
    expect(events.map((event) => event.type)).toEqual(["harness.model.failed"]);
    expect(events[0]?.payload).toMatchObject({
      callId: "call_1",
      turn: 1,
      error: {
        name: "HarnessModelCallTimeoutError",
        causeCode: "model_call_timeout",
      },
      durationMs: 10,
    });
  });

  it("records code caller tool call events without a turn", async () => {
    const world = await tempWorld();
    const runId = "run_harness_recorder_code_tool";
    const recorder = createHarnessEventRecorder({ world, runId });

    await recorder.append({
      type: "HarnessToolCallStarted",
      payload: {
        callId: "call_code_1",
        caller: "code",
        toolName: "lookup",
        args: { id: "ticket-1" },
      },
    });
    await recorder.append({
      type: "HarnessToolCallSucceeded",
      payload: {
        callId: "call_code_1",
        result: { title: "Ticket 1" },
        durationMs: 3,
      },
    });

    const events = await listEvents(world, runId);
    expect(events.map((event) => event.type)).toEqual([
      "harness.tool_call.started",
      "harness.tool_call.succeeded",
    ]);
    expect(events[0]?.payload).toMatchObject({
      callId: "call_code_1",
      caller: "code",
      toolName: "lookup",
      args: { id: "ticket-1" },
    });
    expect(events[0]?.payload).not.toHaveProperty("turn");
  });

  it("records workflowHarness tool-call success payloads without durationMs", async () => {
    const world = await tempWorld();
    const runId = "run_harness_recorder_workflow_tool_success";
    const recorder = createHarnessEventRecorder({ world, runId });

    await recorder.append({
      type: "harness.tool_call.succeeded",
      payload: {
        callId: "call_1",
        caller: "code",
        toolName: "lookup",
        args: { ticketId: "TIN-1" },
        callIndex: 1,
        result: { summary: "ok" },
        scope: { stepPath: "lookup", visitIndex: 0 },
      },
    });

    const events = await listEvents(world, runId);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({
      caller: "code",
      toolName: "lookup",
      result: { summary: "ok" },
    });
  });

  it("persists occurrence ids for durable replay and trace correlation", async () => {
    const world = await tempWorld();
    const runId = "run_harness_recorder_occurrence";
    const recorder = createHarnessEventRecorder({ world, runId });
    const occurrenceId = "occ_tool_1";

    await recorder.append({
      type: "harness.tool_call.started",
      occurrenceId,
      payload: {
        callId: "call_1",
        caller: "code",
        toolName: "lookup",
        args: { ticketId: "TIN-1" },
        callIndex: 1,
        scope: { stepPath: "lookup", visitIndex: 0 },
      },
    });
    await recorder.append({
      type: "harness.tool_call.succeeded",
      occurrenceId,
      payload: {
        callId: "call_1",
        caller: "code",
        toolName: "lookup",
        args: { ticketId: "TIN-1" },
        callIndex: 1,
        result: { summary: "ok" },
        scope: { stepPath: "lookup", visitIndex: 0 },
      },
    });

    const events = await listEvents(world, runId);
    expect(events.map((event) => event.occurrenceId)).toEqual([occurrenceId, occurrenceId]);
    await expect(recorder.priorEvents()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ occurrenceId }),
    ]));
  });

  it("records workflowHarness execute-step events with stepId and uses payloads", async () => {
    const world = await tempWorld();
    const runId = "run_harness_recorder_workflow_execute";
    const recorder = createHarnessEventRecorder({ world, runId });

    await recorder.append({
      type: "harness.execute_step.started",
      payload: {
        runId,
        stepId: "compute",
        uses: "code.run",
        stepPath: "compute.visit[0]",
        visitIndex: 0,
      },
    });
    await recorder.append({
      type: "harness.execute_step.succeeded",
      payload: {
        runId,
        stepId: "compute",
        uses: "code.run",
        stepPath: "compute.visit[0]",
        visitIndex: 0,
        output: { final: "ok" },
      },
    });

    const events = await listEvents(world, runId);
    expect(events.map((event) => event.type)).toEqual([
      "harness.execute_step.started",
      "harness.execute_step.succeeded",
    ]);
    expect(events[0]?.payload).toMatchObject({
      stepId: "compute",
      uses: "code.run",
      visitIndex: 0,
    });
    expect(events[1]?.payload).toMatchObject({
      stepId: "compute",
      output: { final: "ok" },
    });
  });

  it("returns prior events for resume lookup", async () => {
    const world = await tempWorld();
    const runId = "run_harness_recorder_prior";
    const otherRunId = "run_harness_recorder_other";
    const recorder = createHarnessEventRecorder({ world, runId });
    const otherRecorder = createHarnessEventRecorder({ world, runId: otherRunId });

    const request = { model: "gpt-5", messages: [], tools: [] };
    await recorder.append({
      type: "HarnessModelCalled",
      payload: {
        turn: 1,
        promptHash: hashHarnessPrompt(request),
        request,
      },
    });
    await otherRecorder.append({
      type: "HarnessSessionStarted",
      payload: {
        runId: otherRunId,
        role: "worker.code-run",
        task: { kind: "execute_step" },
        manifest: { harnessId: "other" },
        manifestHash: hashHarnessPrompt({ harnessId: "other" }),
      },
    });

    await expect(recorder.priorEvents()).resolves.toMatchObject([
      { runId, type: "harness.model.called" },
    ]);
    await expect(recorder.priorEvents(otherRunId)).resolves.toMatchObject([
      { runId: otherRunId, type: "harness.session.started" },
    ]);
  });

  it("errorEnvelope captures Error name/message/stack and non-Error values safely", () => {
    const error = new TypeError("bad input");
    const errorResult = errorEnvelope(error);

    expect(errorResult).toMatchObject({
      name: "TypeError",
      message: "bad input",
    });
    expect(errorResult).toHaveProperty("stack");

    expect(errorEnvelope("plain failure")).toEqual({
      name: "NonError",
      message: "plain failure",
      value: "plain failure",
    });
    expect(errorEnvelope({ code: "E_FAIL" })).toEqual({
      name: "NonError",
      message: '{"code":"E_FAIL"}',
      value: { code: "E_FAIL" },
    });
  });

  it("errorEnvelope preserves custom Error fields", () => {
    const error = new Error("cancelled");
    Object.assign(error, {
      causeCode: "cancelled",
      retriable: false,
      context: { stepPath: "summarize" },
    });

    expect(errorEnvelope(error)).toMatchObject({
      name: "Error",
      message: "cancelled",
      causeCode: "cancelled",
      retriable: false,
      context: { stepPath: "summarize" },
    });
  });

  it("errorEnvelope handles cyclic Error causes", () => {
    const error = new Error("cycle");
    Object.assign(error, { cause: error });

    expect(errorEnvelope(error)).toMatchObject({
      name: "Error",
      message: "cycle",
      cause: "[Circular]",
    });
  });

  it("rejects malformed harness events before persistence", async () => {
    const world = await tempWorld();
    const runId = "run_harness_recorder_invalid";
    const recorder = createHarnessEventRecorder({ world, runId });

    await expect(
      recorder.append({
        type: "HarnessModelCalled",
        payload: {},
      }),
    ).rejects.toThrow(/harness\.model\.called\.payload\.turn/u);

    await expect(listEvents(world, runId)).resolves.toEqual([]);
  });

  describe("malformed model event regression matrix", () => {
    const baseModelRequest = {
      model: "gpt-5",
      messages: [{ role: "user", content: "Plan it" }],
      tools: [{ toolName: "lookup" }],
    };
    const baseModelResponse = {
      text: "ok",
      toolCalls: [{ toolName: "lookup", args: { id: "ticket-1" } }],
      usage: { inputTokens: 3, outputTokens: 1 },
    };

    const inheritedContentMessage = Object.create({ content: "inherited" }) as Record<string, unknown>;
    inheritedContentMessage.role = "user";

    const inheritedRoleMessage = Object.create({ role: "user" }) as Record<string, unknown>;
    inheritedRoleMessage.content = "hello";

    const inheritedRequestToolName = Object.create({ toolName: "lookup" }) as Record<string, unknown>;
    inheritedRequestToolName.schemaHash = "sha256:schema";

    const inheritedArgsToolCall = Object.create({ args: {} }) as Record<string, unknown>;
    inheritedArgsToolCall.toolName = "lookup";

    const inheritedResponseToolName = Object.create({ toolName: "lookup" }) as Record<string, unknown>;
    inheritedResponseToolName.args = {};

    const modelCalledMalformedCases = [
      {
        name: "rejects null request message",
        request: { ...baseModelRequest, messages: [null] },
        error: /harness\.model\.called\.payload\.request\.messages\[0\] must be an object/u,
      },
      {
        name: "rejects string request message",
        request: { ...baseModelRequest, messages: ["hello"] },
        error: /harness\.model\.called\.payload\.request\.messages\[0\] must be an object/u,
      },
      {
        name: "rejects numeric request message",
        request: { ...baseModelRequest, messages: [1] },
        error: /harness\.model\.called\.payload\.request\.messages\[0\] must be an object/u,
      },
      {
        name: "rejects array request message",
        request: { ...baseModelRequest, messages: [[]] },
        error: /harness\.model\.called\.payload\.request\.messages\[0\] must be an object/u,
      },
      {
        name: "rejects request message without role",
        request: { ...baseModelRequest, messages: [{ content: "hello" }] },
        error: /harness\.model\.called\.payload\.request\.messages\[0\]\.role/u,
      },
      {
        name: "rejects request message with empty role",
        request: { ...baseModelRequest, messages: [{ role: "", content: "hello" }] },
        error: /harness\.model\.called\.payload\.request\.messages\[0\]\.role/u,
      },
      {
        name: "rejects request message with numeric role",
        request: { ...baseModelRequest, messages: [{ role: 1, content: "hello" }] },
        error: /harness\.model\.called\.payload\.request\.messages\[0\]\.role/u,
      },
      {
        name: "rejects request message with boolean role",
        request: { ...baseModelRequest, messages: [{ role: false, content: "hello" }] },
        error: /harness\.model\.called\.payload\.request\.messages\[0\]\.role/u,
      },
      {
        name: "rejects request message with inherited role",
        request: { ...baseModelRequest, messages: [inheritedRoleMessage] },
        error: /harness\.model\.called\.payload\.request\.messages\[0\]\.role must be present/u,
      },
      {
        name: "rejects request message without content",
        request: { ...baseModelRequest, messages: [{ role: "user" }] },
        error: /harness\.model\.called\.payload\.request\.messages\[0\]\.content must be present/u,
      },
      {
        name: "rejects request message with inherited content",
        request: { ...baseModelRequest, messages: [inheritedContentMessage] },
        error: /harness\.model\.called\.payload\.request\.messages\[0\]\.content must be present/u,
      },
      {
        name: "rejects second malformed request message",
        request: { ...baseModelRequest, messages: [{ role: "system", content: "context" }, { role: "" }] },
        error: /harness\.model\.called\.payload\.request\.messages\[1\]\.role/u,
      },
      {
        name: "rejects null request tool",
        request: { ...baseModelRequest, tools: [null] },
        error: /harness\.model\.called\.payload\.request\.tools\[0\] must be an object/u,
      },
      {
        name: "rejects string request tool",
        request: { ...baseModelRequest, tools: ["lookup"] },
        error: /harness\.model\.called\.payload\.request\.tools\[0\] must be an object/u,
      },
      {
        name: "rejects numeric request tool",
        request: { ...baseModelRequest, tools: [1] },
        error: /harness\.model\.called\.payload\.request\.tools\[0\] must be an object/u,
      },
      {
        name: "rejects array request tool",
        request: { ...baseModelRequest, tools: [[]] },
        error: /harness\.model\.called\.payload\.request\.tools\[0\] must be an object/u,
      },
      {
        name: "rejects request tool without toolName",
        request: { ...baseModelRequest, tools: [{ schemaHash: "sha256:schema" }] },
        error: /harness\.model\.called\.payload\.request\.tools\[0\]\.toolName/u,
      },
      {
        name: "rejects request tool with empty toolName",
        request: { ...baseModelRequest, tools: [{ toolName: "" }] },
        error: /harness\.model\.called\.payload\.request\.tools\[0\]\.toolName/u,
      },
      {
        name: "rejects request tool with whitespace toolName",
        request: { ...baseModelRequest, tools: [{ toolName: "   " }] },
        error: /harness\.model\.called\.payload\.request\.tools\[0\]\.toolName/u,
      },
      {
        name: "rejects request tool with numeric toolName",
        request: { ...baseModelRequest, tools: [{ toolName: 1 }] },
        error: /harness\.model\.called\.payload\.request\.tools\[0\]\.toolName/u,
      },
      {
        name: "rejects request tool with boolean toolName",
        request: { ...baseModelRequest, tools: [{ toolName: false }] },
        error: /harness\.model\.called\.payload\.request\.tools\[0\]\.toolName/u,
      },
      {
        name: "rejects request tool with inherited toolName",
        request: { ...baseModelRequest, tools: [inheritedRequestToolName] },
        error: /harness\.model\.called\.payload\.request\.tools\[0\]\.toolName must be present/u,
      },
      {
        name: "rejects second malformed request tool",
        request: { ...baseModelRequest, tools: [{ toolName: "lookup" }, { toolName: "" }] },
        error: /harness\.model\.called\.payload\.request\.tools\[1\]\.toolName/u,
      },
    ] as const;

    it.each(modelCalledMalformedCases)("$name", async ({ request, error }) => {
      const world = await tempWorld();
      const runId = "run_harness_recorder_invalid_model_called";
      const recorder = createHarnessEventRecorder({ world, runId });

      await expect(
        recorder.append({
          type: "HarnessModelCalled",
          payload: {
            turn: 1,
            promptHash: "sha256:malformed-request",
            request,
          },
        } as never),
      ).rejects.toThrow(error);

      await expect(listEvents(world, runId)).resolves.toEqual([]);
    });

    it("rejects harness.model.called when promptHash does not match request payload", async () => {
      const world = await tempWorld();
      const runId = "run_harness_recorder_prompt_hash_mismatch";
      const recorder = createHarnessEventRecorder({ world, runId });

      await expect(
        recorder.append({
          type: "HarnessModelCalled",
          payload: {
            turn: 1,
            promptHash: "sha256:wrong",
            request: baseModelRequest,
          },
        } as never),
      ).rejects.toThrow(/promptHash does not match request payload/u);
      await expect(listEvents(world, runId)).resolves.toEqual([]);
    });

    const modelRespondedMalformedCases = [
      {
        name: "rejects null response tool call",
        response: { ...baseModelResponse, toolCalls: [null] },
        error: /harness\.model\.responded\.payload\.response\.toolCalls\[0\] must be an object/u,
      },
      {
        name: "rejects string response tool call",
        response: { ...baseModelResponse, toolCalls: ["lookup"] },
        error: /harness\.model\.responded\.payload\.response\.toolCalls\[0\] must be an object/u,
      },
      {
        name: "rejects numeric response tool call",
        response: { ...baseModelResponse, toolCalls: [1] },
        error: /harness\.model\.responded\.payload\.response\.toolCalls\[0\] must be an object/u,
      },
      {
        name: "rejects array response tool call",
        response: { ...baseModelResponse, toolCalls: [[]] },
        error: /harness\.model\.responded\.payload\.response\.toolCalls\[0\] must be an object/u,
      },
      {
        name: "rejects response tool call without toolName",
        response: { ...baseModelResponse, toolCalls: [{ args: {} }] },
        error: /harness\.model\.responded\.payload\.response\.toolCalls\[0\]\.toolName/u,
      },
      {
        name: "rejects response tool call with empty toolName",
        response: { ...baseModelResponse, toolCalls: [{ toolName: "", args: {} }] },
        error: /harness\.model\.responded\.payload\.response\.toolCalls\[0\]\.toolName/u,
      },
      {
        name: "rejects response tool call with whitespace toolName",
        response: { ...baseModelResponse, toolCalls: [{ toolName: "  ", args: {} }] },
        error: /harness\.model\.responded\.payload\.response\.toolCalls\[0\]\.toolName/u,
      },
      {
        name: "rejects response tool call with numeric toolName",
        response: { ...baseModelResponse, toolCalls: [{ toolName: 1, args: {} }] },
        error: /harness\.model\.responded\.payload\.response\.toolCalls\[0\]\.toolName/u,
      },
      {
        name: "rejects response tool call with boolean toolName",
        response: { ...baseModelResponse, toolCalls: [{ toolName: false, args: {} }] },
        error: /harness\.model\.responded\.payload\.response\.toolCalls\[0\]\.toolName/u,
      },
      {
        name: "rejects response tool call with inherited toolName",
        response: { ...baseModelResponse, toolCalls: [inheritedResponseToolName] },
        error: /harness\.model\.responded\.payload\.response\.toolCalls\[0\]\.toolName must be present/u,
      },
      {
        name: "rejects response tool call without args",
        response: { ...baseModelResponse, toolCalls: [{ toolName: "lookup" }] },
        error: /harness\.model\.responded\.payload\.response\.toolCalls\[0\]\.args must be present/u,
      },
      {
        name: "rejects response tool call with inherited args",
        response: { ...baseModelResponse, toolCalls: [inheritedArgsToolCall] },
        error: /harness\.model\.responded\.payload\.response\.toolCalls\[0\]\.args must be present/u,
      },
      {
        name: "rejects second malformed response tool call",
        response: {
          ...baseModelResponse,
          toolCalls: [{ toolName: "lookup", args: {} }, { toolName: "" }],
        },
        error: /harness\.model\.responded\.payload\.response\.toolCalls\[1\]\.toolName/u,
      },
      {
        name: "rejects model response usage costUsd zero",
        response: { ...baseModelResponse, usage: { inputTokens: 3, outputTokens: 1, costUsd: 0 } },
        error: /harness\.model\.responded\.payload\.response\.usage\.costUsd must be absent/u,
      },
      {
        name: "rejects model response usage costUsd positive",
        response: { ...baseModelResponse, usage: { inputTokens: 3, outputTokens: 1, costUsd: 0.01 } },
        error: /harness\.model\.responded\.payload\.response\.usage\.costUsd must be absent/u,
      },
      {
        name: "rejects model response usage costUsd null",
        response: { ...baseModelResponse, usage: { inputTokens: 3, outputTokens: 1, costUsd: null } },
        error: /harness\.model\.responded\.payload\.response\.usage\.costUsd must be absent/u,
      },
      {
        name: "rejects model response usage costUsd string",
        response: { ...baseModelResponse, usage: { inputTokens: 3, outputTokens: 1, costUsd: "0" } },
        error: /harness\.model\.responded\.payload\.response\.usage\.costUsd must be absent/u,
      },
      {
        name: "rejects model response usage costUsd undefined when present",
        response: {
          ...baseModelResponse,
          usage: { inputTokens: 3, outputTokens: 1, costUsd: undefined },
        },
        error: /harness\.model\.responded\.payload\.response\.usage\.costUsd must be absent/u,
      },
      {
        name: "rejects model response usage costUsd object",
        response: { ...baseModelResponse, usage: { inputTokens: 3, outputTokens: 1, costUsd: {} } },
        error: /harness\.model\.responded\.payload\.response\.usage\.costUsd must be absent/u,
      },
      {
        name: "rejects model response usage costUsd array",
        response: { ...baseModelResponse, usage: { inputTokens: 3, outputTokens: 1, costUsd: [] } },
        error: /harness\.model\.responded\.payload\.response\.usage\.costUsd must be absent/u,
      },
      {
        name: "rejects model response usage costUsd negative",
        response: { ...baseModelResponse, usage: { inputTokens: 3, outputTokens: 1, costUsd: -1 } },
        error: /harness\.model\.responded\.payload\.response\.usage\.costUsd must be absent/u,
      },
      {
        name: "rejects model response usage costUsd NaN",
        response: { ...baseModelResponse, usage: { inputTokens: 3, outputTokens: 1, costUsd: Number.NaN } },
        error: /harness\.model\.responded\.payload\.response\.usage\.costUsd must be absent/u,
      },
    ] as const;

    it.each(modelRespondedMalformedCases)("$name", async ({ response, error }) => {
      const world = await tempWorld();
      const runId = "run_harness_recorder_invalid_model_responded";
      const recorder = createHarnessEventRecorder({ world, runId });

      await expect(
        recorder.append({
          type: "HarnessModelResponded",
          payload: {
            turn: 1,
            response,
          },
        } as never),
      ).rejects.toThrow(error);

      await expect(listEvents(world, runId)).resolves.toEqual([]);
    });
  });

  it("rejects code caller tool events with a turn", async () => {
    const world = await tempWorld();
    const runId = "run_harness_recorder_code_turn";
    const recorder = createHarnessEventRecorder({ world, runId });

    await expect(
      recorder.append({
        type: "HarnessToolCallStarted",
        payload: {
          turn: 1,
          callId: "call_code_with_turn",
          caller: "code",
          toolName: "lookup",
          args: { id: "ticket-1" },
        },
      }),
    ).rejects.toThrow(/harness\.tool_call\.started\.payload\.turn must be absent/u);

    await expect(listEvents(world, runId)).resolves.toEqual([]);
  });

  it("rejects unknown harness event types before persistence", async () => {
    const world = await tempWorld();
    const runId = "run_harness_recorder_unknown_type";
    const recorder = createHarnessEventRecorder({ world, runId });

    await expect(
      recorder.append({
        type: "HarnessFutureEvent",
        payload: {},
      } as never),
    ).rejects.toThrow(/Unsupported harness event type/u);

    await expect(listEvents(world, runId)).resolves.toEqual([]);
  });

  it("rejects session payload runId mismatches", async () => {
    const world = await tempWorld();
    const runId = "run_harness_recorder_scope";
    const recorder = createHarnessEventRecorder({ world, runId });

    await expect(
      recorder.append({
        type: "HarnessSessionStarted",
        payload: {
          runId: "run_harness_recorder_other",
          role: "planner",
          task: { kind: "plan" },
          manifest: { harnessId: "testHarness@1.0.0" },
          manifestHash: hashHarnessPrompt({ harnessId: "testHarness@1.0.0" }),
        },
      }),
    ).rejects.toThrow(/harness\.session\.started\.payload\.runId must match recorder runId/u);

    await expect(listEvents(world, runId)).resolves.toEqual([]);
  });

  it("rejects harness session drift when a resumed session manifest changes", async () => {
    const world = await tempWorld();
    const runId = "run_harness_recorder_manifest_drift";
    const recorder = createHarnessEventRecorder({ world, runId });

    const firstManifest = {
      harnessId: "testHarness@1.0.0",
      plannerModelSlotId: "gpt-5",
      systemPromptHash: hashHarnessPrompt("plan"),
      skillsHash: hashHarnessPrompt([]),
      workflowDefinitionHash: "sha256:wf",
      globalToolsHash: hashHarnessPrompt([]),
      memoryStoreIds: ["org"],
    };
    await recorder.append({
      type: "HarnessSessionStarted",
      payload: {
        runId,
        role: "planner",
        task: { kind: "plan" },
        manifest: firstManifest,
        manifestHash: hashHarnessPrompt(firstManifest),
      },
    });

    const secondManifest = {
      ...firstManifest,
      plannerModelSlotId: "gpt-4o-mini",
    };
    await expect(
      recorder.append({
        type: "HarnessSessionStarted",
        payload: {
          runId,
          role: "planner",
          task: { kind: "plan" },
          manifest: secondManifest,
          manifestHash: hashHarnessPrompt(secondManifest),
        },
      }),
    ).rejects.toMatchObject({
      name: "CapabilityDriftError",
      causeCode: "capability_drift",
    });
  });

  it("drift-checks dotted session started appends", async () => {
    const world = await tempWorld();
    const runId = "run_harness_recorder_dotted_manifest_drift";
    const recorder = createHarnessEventRecorder({ world, runId });

    const firstManifest = {
      harnessId: "testHarness@1.0.0",
      plannerModelSlotId: "gpt-5",
      systemPromptHash: hashHarnessPrompt("plan"),
      skillsHash: hashHarnessPrompt([]),
      workflowDefinitionHash: "sha256:wf",
      globalToolsHash: hashHarnessPrompt([]),
      memoryStoreIds: ["org"],
    };
    await recorder.append({
      type: "HarnessSessionStarted",
      payload: {
        runId,
        role: "planner",
        task: { kind: "plan" },
        manifest: firstManifest,
        manifestHash: hashHarnessPrompt(firstManifest),
      },
    });

    const secondManifest = {
      ...firstManifest,
      plannerModelSlotId: "gpt-4o-mini",
    };
    await expect(
      recorder.append({
        type: "harness.session.started",
        payload: {
          runId,
          role: "planner",
          task: { kind: "plan" },
          manifest: secondManifest,
          manifestHash: hashHarnessPrompt(secondManifest),
        },
      }),
    ).rejects.toMatchObject({
      name: "CapabilityDriftError",
      causeCode: "capability_drift",
    });
  });

  it("can skip manifest drift checks for explicit fallback sessions while still recording starts", async () => {
    const world = await tempWorld();
    const runId = "run_harness_recorder_fallback_skip_drift";
    const recorder = createHarnessEventRecorder({ world, runId });

    const delegatedManifest = {
      harnessId: "delegateHarness@1.0.0",
      workflowDefinitionHash: "sha256:wf",
      workflowVersionId: "wfver_1",
      stepPath: "stepA",
      stepConfigHash: "sha256:step",
      skillsHash: hashHarnessPrompt([]),
      allowedToolsHash: hashHarnessPrompt(["lookup"]),
      memoryStoreIds: [],
    };
    await recorder.append({
      type: "HarnessSessionStarted",
      payload: {
        runId,
        role: "worker.tool-call",
        task: { kind: "execute_step" },
        manifest: delegatedManifest,
        manifestHash: hashHarnessPrompt(delegatedManifest),
      },
    });

    const fallbackRecorder = createHarnessEventRecorder({
      world,
      runId,
      skipManifestDriftCheck: true,
    });
    const fallbackManifest = {
      ...delegatedManifest,
      harnessId: "workflowHarness@1.0.0",
    };
    await fallbackRecorder.append({
      type: "HarnessSessionStarted",
      payload: {
        runId,
        role: "worker.tool-call",
        task: { kind: "execute_step" },
        manifest: fallbackManifest,
        manifestHash: hashHarnessPrompt(fallbackManifest),
      },
    });

    const started = (await listEvents(world, runId))
      .filter((event) => event.type === "harness.session.started");
    expect(started).toHaveLength(2);
    expect(started.map((event) => (event.payload.manifest as { harnessId?: string }).harnessId)).toEqual([
      "delegateHarness@1.0.0",
      "workflowHarness@1.0.0",
    ]);
  });

  it("rejects invalid session roles before persistence", async () => {
    const world = await tempWorld();
    const runId = "run_harness_recorder_bad_role";
    const recorder = createHarnessEventRecorder({ world, runId });

    await expect(
      recorder.append({
        type: "HarnessSessionStarted",
        payload: {
          runId,
          role: "worker",
          task: { kind: "execute_step" },
          manifest: { harnessId: "testHarness@1.0.0" },
          manifestHash: hashHarnessPrompt({ harnessId: "testHarness@1.0.0" }),
        },
      }),
    ).rejects.toThrow(/harness\.session\.started\.payload\.role/u);

    await expect(listEvents(world, runId)).resolves.toEqual([]);
  });

  it("rejects invalid session task kinds before persistence", async () => {
    const world = await tempWorld();
    const runId = "run_harness_recorder_bad_task";
    const recorder = createHarnessEventRecorder({ world, runId });

    await expect(
      recorder.append({
        type: "HarnessSessionStarted",
        payload: {
          runId,
          role: "planner",
          task: { kind: "execute" },
          manifest: { harnessId: "testHarness@1.0.0" },
          manifestHash: hashHarnessPrompt({ harnessId: "testHarness@1.0.0" }),
        },
      }),
    ).rejects.toThrow(/harness\.session\.started\.payload\.task\.kind/u);

    await expect(listEvents(world, runId)).resolves.toEqual([]);
  });

  it("rejects a recorded cost on session usage so cost can only be derived downstream", async () => {
    const world = await tempWorld();
    const runId = "run_harness_recorder_session_cost";
    const recorder = createHarnessEventRecorder({ world, runId });

    // Session usage used to permit costUsd. It no longer does: keeping every dollar
    // figure out of the durable log is what makes double-pricing unrepresentable.
    await expect(
      recorder.append({
        type: "HarnessSessionCompleted",
        payload: { runId, usage: { inputTokens: 3, outputTokens: 1, costUsd: 0 } },
      }),
    ).rejects.toThrow(/harness\.session\.completed\.payload\.usage\.costUsd must be absent/u);

    await expect(listEvents(world, runId)).resolves.toEqual([]);
  });

  it("accepts token-only session usage including cache and reasoning counts", async () => {
    const world = await tempWorld();
    const runId = "run_harness_recorder_session_tokens";
    const recorder = createHarnessEventRecorder({ world, runId });

    await recorder.append({
      type: "HarnessSessionCompleted",
      payload: {
        runId,
        usage: { inputTokens: 3, outputTokens: 1, cachedInputTokens: 2, reasoningTokens: 1 },
      },
    });

    await expect(listEvents(world, runId)).resolves.toHaveLength(1);
  });

  it("hashHarnessPrompt returns sha256 digest and is stable", () => {
    const left = hashHarnessPrompt({
      messages: [{ role: "user", content: "hello" }],
      tools: [{ toolName: "bash", schemaHash: "sha256:schema" }],
    });
    const right = hashHarnessPrompt({
      tools: [{ schemaHash: "sha256:schema", toolName: "bash" }],
      messages: [{ content: "hello", role: "user" }],
    });

    expect(left).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(right).toBe(left);
  });
});
