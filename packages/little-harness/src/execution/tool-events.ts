import { captureTraceContent } from "../trace/content.js";
import { createTraceErrorEnvelope } from "../trace/error.js";
import type { ResolvedHarnessTraceOptions } from "../trace/types.js";
import type { FileWriter, JsonObject } from "../types.js";

export type ToolCallMetadataInput = {
    stepNumber?: number | undefined;
    toolCall: { toolName: string; toolCallId: string; input?: unknown };
    caller?: "model" | "code" | "runtime" | string | undefined;
    callIndex?: number | undefined;
    scope?: JsonObject | undefined;
    success?: boolean | undefined;
    durationMs?: number | undefined;
    error?: unknown;
    output?: unknown;
    result?: unknown;
};

export async function toolCallEventData(
  event: ToolCallMetadataInput & { caller: "model" | "code" | "runtime" | string },
  files: FileWriter,
  traceOptions: ResolvedHarnessTraceOptions,
): Promise<{ readonly payload: JsonObject; readonly metadata: JsonObject }> {
  const metadata = await toolCallMetadata(event, files, traceOptions);
  const output = toolOutput(event);
  const payload: JsonObject = {
    callId: event.toolCall.toolCallId,
    caller: event.caller,
    toolName: event.toolCall.toolName,
    args: "input" in event.toolCall ? event.toolCall.input : undefined,
  };
  if (event.stepNumber !== undefined) {
    payload.turn = event.stepNumber + 1;
  }
  if (event.callIndex !== undefined) {
    payload.callIndex = event.callIndex;
  }
  if (event.scope !== undefined) {
    payload.scope = event.scope;
  }
  if (event.durationMs !== undefined) {
    payload.durationMs = event.durationMs;
  }
  if (output !== undefined) {
    payload.result = output;
  }
  if (event.success === false) {
    payload.error = createTraceErrorEnvelope(event.error);
  }
  return { payload, metadata };
}

export async function toolCallMetadata(
  event: ToolCallMetadataInput,
  files: FileWriter,
  traceOptions: ResolvedHarnessTraceOptions,
): Promise<JsonObject> {
  const metadata: JsonObject = {
    toolName: event.toolCall.toolName,
    toolCallId: event.toolCall.toolCallId,
    caller: event.caller ?? "model",
  };
  if (event.stepNumber !== undefined) {
    metadata.stepId = `step_${event.stepNumber + 1}`;
  }

  if ("input" in event.toolCall && traceOptions.content.captureToolInputs) {
    metadata.input = await captureTraceContent({
      value: event.toolCall.input,
      label: `tool-input/${event.toolCall.toolName}`,
      files,
      traceOptions,
    });
  }

  const output = toolOutput(event);
  if (output !== undefined && traceOptions.content.captureToolOutputs) {
    metadata.output = await captureTraceContent({
      value: output,
      label: `tool-output/${event.toolCall.toolName}`,
      files,
      traceOptions,
    });
    const spooled = spooledOutputMetadata(output);
    if (spooled) {
      metadata.spooled = spooled;
    }
  }

  if (event.durationMs !== undefined) {
    metadata.durationMs = event.durationMs;
  }
  if (event.success === false) {
    metadata.error = createTraceErrorEnvelope(event.error);
  }
  return metadata;
}

function toolOutput(event: ToolCallMetadataInput): unknown {
  const dynamicEvent = event as Record<string, unknown>;
  return "output" in dynamicEvent
    ? dynamicEvent.output
    : "result" in dynamicEvent
      ? dynamicEvent.result
      : undefined;
}

function spooledOutputMetadata(output: unknown): JsonObject | undefined {
  if (!isObject(output) || output.type !== "harness.tool_result_file" || typeof output.path !== "string") {
    return undefined;
  }

  const out: JsonObject = { path: output.path };
  if (typeof output.bytes === "number") {
    out.bytes = output.bytes;
  }
  if (typeof output.sha256 === "string") {
    out.sha256 = output.sha256;
  }
  if (typeof output.mediaType === "string") {
    out.mediaType = output.mediaType;
  }
  return out;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
