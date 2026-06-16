import { sha256Hex } from "../ids.js";
import type { ResolvedHarnessTraceOptions } from "./types.js";

export type TraceRedactionReason = "path" | "metadataKey";

export function redactionReasonForPath(
  pathname: string | undefined,
  traceOptions: ResolvedHarnessTraceOptions,
): "path" | undefined {
  if (!pathname) {
    return undefined;
  }

  const normalized = normalizeHarnessPath(pathname);
  for (const redacted of traceOptions.redaction.paths) {
    const redactedPath = normalizeHarnessPath(redacted);
    if (normalized === redactedPath || normalized.startsWith(`${redactedPath}/`)) {
      return "path";
    }
  }

  return undefined;
}

export function redactionReasonForMetadataKey(
  key: string | undefined,
  traceOptions: ResolvedHarnessTraceOptions,
): "metadataKey" | undefined {
  if (!key) {
    return undefined;
  }

  const normalized = key.toLowerCase();
  return traceOptions.redaction.metadataKeys.some((candidate) => candidate.toLowerCase() === normalized)
    ? "metadataKey"
    : undefined;
}

export function sanitizeTraceValue(
  value: unknown,
  traceOptions?: ResolvedHarnessTraceOptions,
): { value: unknown; redacted: boolean } {
  return sanitizeValue(value, traceOptions, new WeakSet<object>());
}

function sanitizeValue(
  value: unknown,
  traceOptions: ResolvedHarnessTraceOptions | undefined,
  seen: WeakSet<object>,
): { value: unknown; redacted: boolean } {
  if (Array.isArray(value)) {
    let redacted = false;
    const sanitized = value.map((entry) => {
      const result = sanitizeValue(entry, traceOptions, seen);
      redacted ||= result.redacted;
      return result.value;
    });
    return { value: sanitized, redacted };
  }

  if (isBinaryMetadataValue(value)) {
    const bytes = bytesForBinaryValue(value);
    return {
      value: {
        binary: true,
        bytes: bytes.byteLength,
        sha256: sha256Hex(bytes),
      },
      redacted: false,
    };
  }

  if (!isPlainObject(value)) {
    return { value, redacted: false };
  }

  if (seen.has(value)) {
    return { value: "[circular]", redacted: false };
  }
  seen.add(value);

  let redacted = false;
  const sanitized: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (traceOptions !== undefined && redactionReasonForMetadataKey(key, traceOptions)) {
      sanitized[key] = "[redacted]";
      redacted = true;
      continue;
    }

    const result = sanitizeValue(entry, traceOptions, seen);
    sanitized[key] = result.value;
    redacted ||= result.redacted;
  }

  seen.delete(value);
  return { value: sanitized, redacted };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === "[object Object]";
}

function isBinaryMetadataValue(value: unknown): value is ArrayBuffer | ArrayBufferView {
  return value instanceof ArrayBuffer || ArrayBuffer.isView(value);
}

function bytesForBinaryValue(value: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

function normalizeHarnessPath(pathname: string): string {
  return `/${pathname.split("/").filter(Boolean).join("/")}`;
}
