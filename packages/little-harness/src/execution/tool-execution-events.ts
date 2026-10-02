import type { ToolExecutionEndEvent, ToolExecutionStartEvent } from "ai";

/**
 * The shape the trace and durable-replay layers read for a model-driven tool call.
 *
 * AI SDK 7 tool-execution events carry neither the model step number nor a `success` flag:
 * the outcome lives in a `toolOutput` discriminated union and the duration in
 * `toolExecutionMs`. Durable replay keys tool calls by step (`turn = stepNumber + 1`), so the
 * harness loops track the current model step from `onStepStart` and normalize each event here.
 */
export type HarnessToolExecutionEvent = {
  readonly stepNumber: number | undefined;
  readonly toolCall: ToolExecutionStartEvent["toolCall"];
  readonly success?: boolean;
  readonly durationMs?: number;
  readonly output?: unknown;
  readonly error?: unknown;
};

export function harnessToolExecutionStart(
  event: ToolExecutionStartEvent,
  stepNumber: number | undefined,
): HarnessToolExecutionEvent {
  return { stepNumber, toolCall: event.toolCall };
}

export function harnessToolExecutionEnd(
  event: ToolExecutionEndEvent,
  stepNumber: number | undefined,
): HarnessToolExecutionEvent {
  const base = { stepNumber, toolCall: event.toolCall, durationMs: event.toolExecutionMs };
  return event.toolOutput.type === "tool-error"
    ? { ...base, success: false, error: event.toolOutput.error }
    : { ...base, success: true, output: event.toolOutput.output };
}
