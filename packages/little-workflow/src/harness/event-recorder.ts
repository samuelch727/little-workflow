import type { LocalWorld } from "../authoring.js";
import { sha256Digest } from "../canonical.js";
import { checkHarnessManifestDrift, hashHarnessManifest } from "../manifests.js";
import {
  type EventInput,
  type EventEnvelope,
  type RunId,
} from "../world.js";
import type {
  ErrorEnvelope,
  ErrorEnvelopeValue,
  HarnessEventInput,
  HarnessEventRecorder,
} from "./types.js";
import { normalizeHarnessEventType } from "./event-names.js";
export { normalizeHarnessEventType } from "./event-names.js";

const HARNESS_ROLES = [
  "planner",
  "orchestrator",
  "worker.ai-generate",
  "worker.code-run",
  "worker.tool-call",
  "fixer",
] as const;
const HARNESS_TASK_KINDS = ["plan", "orchestrate", "execute_step", "fix_step"] as const;
const HARNESS_STEP_USES = ["ai.generate", "code.run", "tool.call", "decision", "parallel"] as const;

export function createHarnessEventRecorder(options: {
  readonly world: LocalWorld;
  readonly runId: RunId;
  readonly skipManifestDriftCheck?: boolean;
}): HarnessEventRecorder {
  const { world, runId, skipManifestDriftCheck = false } = options;
  return {
    async append(event: HarnessEventInput): Promise<EventEnvelope> {
      const eventType = normalizeHarnessEventType(event.type) as EventInput["type"];
      validateHarnessEvent(event, runId);
      if (eventType === "harness.session.started") {
        const manifest = event.payload.manifest;
        if (hashHarnessManifest(manifest as never) !== event.payload.manifestHash) {
          throw new TypeError("harness.session.started.payload.manifestHash does not match the manifest payload.");
        }
        if (!skipManifestDriftCheck) {
          await checkHarnessManifestDrift(world, runId, manifest as never);
        }
      }
      return world.appendEvent(runId, {
        type: eventType,
        ...(event.occurrenceId === undefined ? {} : { occurrenceId: event.occurrenceId }),
        payload: event.payload,
      });
    },
    priorEvents(candidateRunId?: RunId): Promise<readonly EventEnvelope[]> {
      return world.listEvents(candidateRunId ?? runId);
    },
  };
}

export function errorEnvelope(error: unknown): ErrorEnvelope {
  if (error instanceof Error) {
    return errorEnvelopeFromError(error, new WeakSet<object>());
  }

  const value = toJsonSafe(error, new WeakSet<object>());
  return {
    name: "NonError",
    message: messageForNonError(value),
    value,
  };
}

export function hashHarnessPrompt(input: unknown): string {
  return sha256Digest(input);
}

export function hashHarnessToolCall(input: {
  readonly caller: "model" | "code";
  readonly toolName: string;
  readonly args: unknown;
  readonly turn?: number;
  readonly callIndex?: number;
  readonly scope?: Record<string, unknown>;
}): string {
  return sha256Digest({
    caller: input.caller,
    toolName: input.toolName,
    args: input.args,
    ...(input.caller === "model" ? { turn: input.turn ?? 1 } : {}),
    ...(input.callIndex === undefined ? {} : { callIndex: input.callIndex }),
    ...(input.scope === undefined ? {} : { scope: input.scope }),
  });
}

function validateHarnessEvent(event: HarnessEventInput, runId: RunId): void {
  const eventType = normalizeHarnessEventType(event.type);
  const payload = assertRecord(event.payload, `${eventType}.payload`);
  switch (eventType) {
    case "harness.session.started": {
      assertMatchingRunId(payload.runId, runId, "harness.session.started.payload.runId");
      assertOneOf(payload.role, HARNESS_ROLES, "harness.session.started.payload.role");
      const task = assertRecord(payload.task, "harness.session.started.payload.task");
      assertOneOf(task.kind, HARNESS_TASK_KINDS, "harness.session.started.payload.task.kind");
      assertRecord(payload.manifest, "harness.session.started.payload.manifest");
      assertString(payload.manifestHash, "harness.session.started.payload.manifestHash");
      if (payload.parentRunId !== undefined) {
        assertString(payload.parentRunId, "harness.session.started.payload.parentRunId");
      }
      return;
    }
    case "harness.session.completed": {
      assertMatchingRunId(payload.runId, runId, "harness.session.completed.payload.runId");
      assertUsage(payload.usage, "harness.session.completed.payload.usage");
      return;
    }
    case "harness.session.failed": {
      assertMatchingRunId(payload.runId, runId, "harness.session.failed.payload.runId");
      assertErrorEnvelopePayload(payload.error, "harness.session.failed.payload.error");
      return;
    }
    case "harness.model.called": {
      if (payload.callId !== undefined) {
        assertString(payload.callId, "harness.model.called.payload.callId");
      }
      assertPositiveInteger(payload.turn, "harness.model.called.payload.turn");
      const promptHash = assertString(payload.promptHash, "harness.model.called.payload.promptHash");
      const request = assertRecord(payload.request, "harness.model.called.payload.request");
      assertString(request.model, "harness.model.called.payload.request.model");
      const messages = assertArray(request.messages, "harness.model.called.payload.request.messages");
      messages.forEach((message, index) => {
        assertHarnessModelRequestMessage(
          message,
          `harness.model.called.payload.request.messages[${index}]`,
        );
      });
      const tools = assertArray(request.tools, "harness.model.called.payload.request.tools");
      tools.forEach((tool, index) => {
        assertHarnessModelRequestTool(tool, `harness.model.called.payload.request.tools[${index}]`);
      });
      if (hashHarnessPrompt(request) !== promptHash) {
        throw new TypeError("harness.model.called.payload.promptHash does not match request payload.");
      }
      return;
    }
    case "harness.model.responded": {
      if (payload.callId !== undefined) {
        assertString(payload.callId, "harness.model.responded.payload.callId");
      }
      assertPositiveInteger(payload.turn, "harness.model.responded.payload.turn");
      const response = assertRecord(payload.response, "harness.model.responded.payload.response");
      if (response.text !== undefined) {
        assertString(response.text, "harness.model.responded.payload.response.text");
      }
      if (response.toolCalls !== undefined) {
        const toolCalls = assertArray(
          response.toolCalls,
          "harness.model.responded.payload.response.toolCalls",
        );
        toolCalls.forEach((toolCall, index) => {
          assertHarnessModelResponseToolCall(
            toolCall,
            `harness.model.responded.payload.response.toolCalls[${index}]`,
          );
        });
      }
      if (payload.model !== undefined) {
        assertHarnessModelIdentity(payload.model, "harness.model.responded.payload.model");
      }
      assertUsage(response.usage, "harness.model.responded.payload.response.usage");
      return;
    }
    case "harness.model.failed": {
      if (payload.callId !== undefined) {
        assertString(payload.callId, "harness.model.failed.payload.callId");
      }
      assertPositiveInteger(payload.turn, "harness.model.failed.payload.turn");
      if (payload.attempt !== undefined) {
        assertPositiveInteger(payload.attempt, "harness.model.failed.payload.attempt");
      }
      if (payload.willRetry !== undefined) {
        assertBoolean(payload.willRetry, "harness.model.failed.payload.willRetry");
      }
      assertErrorEnvelopePayload(payload.error, "harness.model.failed.payload.error");
      assertNonNegativeNumber(payload.durationMs, "harness.model.failed.payload.durationMs");
      return;
    }
    case "harness.tool_call.started": {
      assertString(payload.callId, "harness.tool_call.started.payload.callId");
      const caller = assertString(payload.caller, "harness.tool_call.started.payload.caller");
      if (caller !== "model" && caller !== "code") {
        throw new TypeError('harness.tool_call.started.payload.caller must be "model" or "code".');
      }
      if (caller === "model") {
        assertPositiveInteger(payload.turn, "harness.tool_call.started.payload.turn");
      } else if (payload.turn !== undefined) {
        throw new TypeError("harness.tool_call.started.payload.turn must be absent when caller is code.");
      }
      if (payload.callIndex !== undefined) {
        assertPositiveInteger(payload.callIndex, "harness.tool_call.started.payload.callIndex");
      }
      if (payload.scope !== undefined) {
        assertRecord(payload.scope, "harness.tool_call.started.payload.scope");
      }
      assertString(payload.toolName, "harness.tool_call.started.payload.toolName");
      assertOwnPayloadField(payload, "args", "harness.tool_call.started.payload.args");
      return;
    }
    case "harness.tool_call.succeeded": {
      assertString(payload.callId, "harness.tool_call.succeeded.payload.callId");
      assertOwnPayloadField(payload, "result", "harness.tool_call.succeeded.payload.result");
      if (hasWorkflowHarnessToolCallPayload(payload)) {
        assertWorkflowHarnessToolCallPayload(payload, "harness.tool_call.succeeded.payload");
        if (payload.durationMs !== undefined) {
          assertNonNegativeNumber(payload.durationMs, "harness.tool_call.succeeded.payload.durationMs");
        }
        return;
      }
      assertNonNegativeNumber(payload.durationMs, "harness.tool_call.succeeded.payload.durationMs");
      return;
    }
    case "harness.tool_call.failed": {
      assertString(payload.callId, "harness.tool_call.failed.payload.callId");
      assertErrorEnvelopePayload(payload.error, "harness.tool_call.failed.payload.error");
      if (hasWorkflowHarnessToolCallPayload(payload)) {
        assertWorkflowHarnessToolCallPayload(payload, "harness.tool_call.failed.payload");
        if (payload.durationMs !== undefined) {
          assertNonNegativeNumber(payload.durationMs, "harness.tool_call.failed.payload.durationMs");
        }
        return;
      }
      assertNonNegativeNumber(payload.durationMs, "harness.tool_call.failed.payload.durationMs");
      return;
    }
    case "harness.execute_step.started": {
      assertString(payload.stepPath, "harness.execute_step.started.payload.stepPath");
      if (hasWorkflowHarnessExecuteStepPayload(payload)) {
        assertWorkflowHarnessExecuteStepPayload(payload, "harness.execute_step.started.payload");
        return;
      }
      const stepKind = assertString(payload.stepKind, "harness.execute_step.started.payload.stepKind");
      if (stepKind !== "code.run" && stepKind !== "tool.call" && stepKind !== "decision") {
        throw new TypeError(
          'harness.execute_step.started.payload.stepKind must be "code.run", "tool.call", or "decision".',
        );
      }
      assertString(payload.inputHash, "harness.execute_step.started.payload.inputHash");
      return;
    }
    case "harness.execute_step.succeeded": {
      assertString(payload.stepPath, "harness.execute_step.succeeded.payload.stepPath");
      if (hasWorkflowHarnessExecuteStepPayload(payload)) {
        assertWorkflowHarnessExecuteStepPayload(payload, "harness.execute_step.succeeded.payload");
        assertOwnPayloadField(payload, "output", "harness.execute_step.succeeded.payload.output");
        return;
      }
      assertString(payload.outputHash, "harness.execute_step.succeeded.payload.outputHash");
      assertNonNegativeNumber(payload.durationMs, "harness.execute_step.succeeded.payload.durationMs");
      return;
    }
    default:
      throw new TypeError(`Unsupported harness event type: ${String(event.type)}.`);
  }
}

function assertRecord(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function assertArray(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${path} must be an array.`);
  }
  return value;
}

function assertString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${path} must be a non-empty string.`);
  }
  return value;
}

function assertNonBlankString(value: unknown, path: string): string {
  const text = assertString(value, path);
  if (text.trim().length === 0) {
    throw new TypeError(`${path} must be a non-empty string.`);
  }
  return text;
}

function assertHarnessModelRequestMessage(value: unknown, path: string): void {
  const message = assertRecord(value, path);
  assertOwnPayloadField(message, "role", `${path}.role`);
  assertString(message.role, `${path}.role`);
  assertOwnPayloadField(message, "content", `${path}.content`);
}

function assertHarnessModelRequestTool(value: unknown, path: string): void {
  const tool = assertRecord(value, path);
  assertOwnPayloadField(tool, "toolName", `${path}.toolName`);
  assertNonBlankString(tool.toolName, `${path}.toolName`);
}

function assertHarnessModelResponseToolCall(value: unknown, path: string): void {
  const toolCall = assertRecord(value, path);
  assertOwnPayloadField(toolCall, "toolName", `${path}.toolName`);
  assertNonBlankString(toolCall.toolName, `${path}.toolName`);
  assertOwnPayloadField(toolCall, "args", `${path}.args`);
}

function hasWorkflowHarnessExecuteStepPayload(payload: Record<string, unknown>): boolean {
  return Object.hasOwn(payload, "stepId") || Object.hasOwn(payload, "uses") || Object.hasOwn(payload, "visitIndex");
}

function assertWorkflowHarnessExecuteStepPayload(payload: Record<string, unknown>, path: string): void {
  assertString(payload.stepId, `${path}.stepId`);
  assertOneOf(payload.uses, HARNESS_STEP_USES, `${path}.uses`);
  assertNonNegativeInteger(payload.visitIndex, `${path}.visitIndex`);
  if (payload.runId !== undefined) {
    assertString(payload.runId, `${path}.runId`);
  }
}

function hasWorkflowHarnessToolCallPayload(payload: Record<string, unknown>): boolean {
  return Object.hasOwn(payload, "caller") ||
    Object.hasOwn(payload, "toolName") ||
    Object.hasOwn(payload, "callIndex") ||
    Object.hasOwn(payload, "scope");
}

function assertWorkflowHarnessToolCallPayload(payload: Record<string, unknown>, path: string): void {
  const caller = assertString(payload.caller, `${path}.caller`);
  if (caller !== "model" && caller !== "code") {
    throw new TypeError(`${path}.caller must be "model" or "code".`);
  }
  assertNonBlankString(payload.toolName, `${path}.toolName`);
  assertOwnPayloadField(payload, "args", `${path}.args`);
  if (payload.callIndex !== undefined) {
    assertPositiveInteger(payload.callIndex, `${path}.callIndex`);
  }
  if (caller === "model") {
    assertPositiveInteger(payload.turn, `${path}.turn`);
  } else if (payload.turn !== undefined) {
    throw new TypeError(`${path}.turn must be absent when caller is code.`);
  }
  if (payload.scope !== undefined) {
    assertRecord(payload.scope, `${path}.scope`);
  }
}

function assertOneOf<const T extends readonly [string, ...string[]]>(
  value: unknown,
  allowed: T,
  path: string,
): T[number] {
  const text = assertString(value, path);
  if (!(allowed as readonly string[]).includes(text)) {
    throw new TypeError(`${path} must be one of: ${allowed.join(", ")}.`);
  }
  return text;
}

function assertMatchingRunId(value: unknown, runId: RunId, path: string): void {
  const payloadRunId = assertString(value, path);
  if (payloadRunId !== runId) {
    throw new TypeError(`${path} must match recorder runId.`);
  }
}

function assertPositiveInteger(value: unknown, path: string): number {
  if (!Number.isInteger(value) || typeof value !== "number" || value < 1) {
    throw new TypeError(`${path} must be a 1-indexed integer.`);
  }
  return value;
}

function assertNonNegativeNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${path} must be a non-negative finite number.`);
  }
  return value;
}

function assertNonNegativeInteger(value: unknown, path: string): number {
  if (!Number.isInteger(value) || typeof value !== "number" || value < 0) {
    throw new TypeError(`${path} must be a zero-indexed integer.`);
  }
  return value;
}

function assertBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    throw new TypeError(`${path} must be a boolean.`);
  }
  return value;
}

function assertOwnPayloadField(payload: Record<string, unknown>, key: string, path: string): void {
  if (!Object.hasOwn(payload, key)) {
    throw new TypeError(`${path} must be present.`);
  }
}

/**
 * Recorded usage is token-only, on every event that carries it.
 *
 * Cost is derived downstream, in exactly one place, from these tokens and the model
 * registry (`pricing.ts`). Rejecting `costUsd` here is what makes double-pricing
 * unrepresentable: a dollar figure can never enter the durable log, so the run
 * materializer has nothing to sum and must price. `harness.model.responded` already
 * enforced this via an `allowCost: false` option; the rule now holds for every usage
 * payload, and the opt-out is gone.
 */
function assertUsage(value: unknown, path: string): void {
  const usage = assertRecord(value, path);
  assertNonNegativeNumber(usage.inputTokens, `${path}.inputTokens`);
  assertNonNegativeNumber(usage.outputTokens, `${path}.outputTokens`);
  if (usage.cachedInputTokens !== undefined) {
    assertNonNegativeNumber(usage.cachedInputTokens, `${path}.cachedInputTokens`);
  }
  if (usage.reasoningTokens !== undefined) {
    assertNonNegativeNumber(usage.reasoningTokens, `${path}.reasoningTokens`);
  }
  if (Object.hasOwn(usage, "costUsd")) {
    throw new TypeError(`${path}.costUsd must be absent.`);
  }
}

/** Model identity recorded alongside a model response, used to price the call. */
function assertHarnessModelIdentity(value: unknown, path: string): void {
  const model = assertRecord(value, path);
  if (model.provider !== undefined) {
    assertString(model.provider, `${path}.provider`);
  }
  if (model.modelId !== undefined) {
    assertString(model.modelId, `${path}.modelId`);
  }
}

function assertErrorEnvelopePayload(value: unknown, path: string): void {
  const error = assertRecord(value, path);
  assertString(error.name, `${path}.name`);
  assertString(error.message, `${path}.message`);
}

function errorEnvelopeFromError(error: Error, seen: WeakSet<object>): ErrorEnvelope {
  if (seen.has(error)) {
    return { name: error.name || "Error", message: "[Circular]" };
  }

  seen.add(error);
  try {
    const envelope: Record<string, ErrorEnvelopeValue | undefined> = {
      name: error.name || "Error",
      message: error.message,
    };
    if (typeof error.stack === "string") {
      envelope.stack = error.stack;
    }
    const cause = (error as { readonly cause?: unknown }).cause;
    if (cause !== undefined) {
      envelope.cause = toJsonSafe(cause, seen);
    }

    const errorProperties = error as unknown as Record<string, unknown>;
    for (const key of Object.keys(error).sort()) {
      if (key === "cause" || key === "message" || key === "name" || key === "stack") {
        continue;
      }
      envelope[key] = toJsonSafe(errorProperties[key], seen);
    }
    return envelope as ErrorEnvelope;
  } finally {
    seen.delete(error);
  }
}

function messageForNonError(value: ErrorEnvelopeValue): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function toJsonSafe(value: unknown, seen: WeakSet<object>): ErrorEnvelopeValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : String(value);
  }
  if (typeof value === "bigint" || typeof value === "symbol" || typeof value === "function") {
    return String(value);
  }
  if (value === undefined) {
    return "undefined";
  }
  if (typeof value !== "object") {
    return String(value);
  }
  if (seen.has(value)) {
    return "[Circular]";
  }
  if (value instanceof Error) {
    return errorEnvelopeFromError(value, seen) as ErrorEnvelopeValue;
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry) => toJsonSafe(entry, seen));
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype === Object.prototype || prototype === null) {
      const output: Record<string, ErrorEnvelopeValue> = {};
      for (const key of Object.keys(value).sort()) {
        output[key] = toJsonSafe((value as Record<string, unknown>)[key], seen);
      }
      return output;
    }

    return String(value);
  } finally {
    seen.delete(value);
  }
}
