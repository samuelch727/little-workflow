import type { JsonObject } from "../types.js";
import type { TraceErrorEnvelope } from "./types.js";

export function createTraceErrorEnvelope(error: unknown): TraceErrorEnvelope {
  if (error instanceof Error) {
    const envelope: TraceErrorEnvelope = {
      name: error.name || "Error",
      message: error.message,
    };
    if (error.stack) {
      envelope.stack = error.stack;
    }
    if (error.cause !== undefined) {
      envelope.cause = toTraceErrorCause(error.cause);
    }
    return envelope;
  }

  return {
    name: "Error",
    message: String(error),
  };
}

function toTraceErrorCause(value: unknown): JsonObject | string | number | boolean | null {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (typeof value === "object") {
    try {
      return JSON.parse(JSON.stringify(value)) as JsonObject;
    } catch {
      return String(value);
    }
  }

  return String(value);
}
