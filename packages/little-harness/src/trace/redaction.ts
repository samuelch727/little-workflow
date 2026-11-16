import { sha256Hex } from "../ids.js";
import type { ResolvedHarnessTraceOptions } from "./types.js";

export type TraceRedactionReason = "path" | "metadataKey" | "value";

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
): { value: unknown; redacted: boolean; reason?: "value" } {
  return sanitizeValue(value, traceOptions, new WeakSet<object>());
}

function sanitizeValue(
  value: unknown,
  traceOptions: ResolvedHarnessTraceOptions | undefined,
  seen: WeakSet<object>,
  key = "",
  jsonForm = false,
): { value: unknown; redacted: boolean; reason?: "value" } {
  // Only opt-in value masking projects JSON forms; the legacy path must remain
  // byte-identical, including non-plain objects passed through unchanged.
  const projectJson = Boolean(traceOptions?.redaction.values?.length);
  if (projectJson && value !== null && (typeof value === "object" || typeof value === "function") && !isBinaryMetadataValue(value)) {
    const toJSON = (value as { toJSON?: unknown }).toJSON;
    if (!jsonForm && typeof toJSON === "function") {
      return sanitizeValue(toJSON.call(value, key), traceOptions, seen, key, true);
    }
    // JSON.stringify unboxes primitive wrappers before visiting their members. The
    // screen keeps ordinary objects off the throwing path: three caught exceptions
    // per object made a 4 MB tool result take seconds to sanitize.
    if (mayBePrimitiveWrapper(value)) {
      for (const prototype of [Number.prototype, String.prototype, Boolean.prototype]) {
        try {
          const primitive = Reflect.apply(prototype.valueOf, value, []);
          return sanitizeValue(primitive, traceOptions, seen, key, true);
        } catch { /* Not this wrapper kind. */ }
      }
    }
  }
  if (typeof value === "string") {
    const result = redactTraceText(value, traceOptions);
    return {
      value: result.text,
      redacted: result.redacted,
      ...(result.redacted ? { reason: "value" as const } : {}),
    };
  }
  if (["number", "boolean", "bigint"].includes(typeof value) && redactTraceText(String(value), traceOptions).redacted) {
    return { value: "[redacted]", redacted: true, reason: "value" };
  }
  if (Array.isArray(value)) {
    let metadataRedacted = false;
    let redacted = false;
    const sanitized = value.map((entry, index) => {
      const result = sanitizeValue(entry, traceOptions, seen, String(index));
      redacted ||= result.redacted;
      metadataRedacted ||= result.redacted && result.reason !== "value";
      return result.value;
    });
    return {
      value: sanitized,
      redacted,
      ...(redacted && !metadataRedacted ? { reason: "value" as const } : {}),
    };
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

  if (!(projectJson && value !== null && typeof value === "object") && !isPlainObject(value)) {
    return { value, redacted: false };
  }

  if (seen.has(value)) {
    return { value: "[circular]", redacted: false };
  }
  seen.add(value);

  let redacted = false;
  let metadataRedacted = false;
  const sanitized: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (projectJson && key === "toJSON" && typeof entry === "function") continue;
    const maskedKey = redactTraceText(key, traceOptions);
    redacted ||= maskedKey.redacted;
    if (
      traceOptions !== undefined &&
      redactionReasonForMetadataKey(key, traceOptions)
    ) {
      sanitized[maskedKey.text] = "[redacted]";
      redacted = true;
      metadataRedacted = true;
      continue;
    }

    const result = sanitizeValue(entry, traceOptions, seen, key);
    sanitized[maskedKey.text] = result.value;
    redacted ||= result.redacted;
    metadataRedacted ||= result.redacted && result.reason !== "value";
  }

  seen.delete(value);
  return {
    value: sanitized,
    redacted,
    ...(redacted && !metadataRedacted ? { reason: "value" as const } : {}),
  };
}

/** A cheap screen for boxed primitives. The exact test is the `valueOf` call at the call site. */
function mayBePrimitiveWrapper(value: object): boolean {
  if (value instanceof String || value instanceof Number || value instanceof Boolean) {
    return true;
  }
  const tag = Object.prototype.toString.call(value);
  return tag === "[object String]" || tag === "[object Number]" || tag === "[object Boolean]";
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

const matchers = new WeakMap<readonly string[], RegExp>();

/** Literal matching, including JSON-escaped text supplied by a tool bridge. */
export function redactTraceText(
  text: string,
  options?: ResolvedHarnessTraceOptions,
): { text: string; redacted: boolean } {
  const values = options?.redaction.values;
  if (!values?.length) return { text, redacted: false };
  let pattern = matchers.get(values);
  if (!pattern) {
    const literals = [
      ...new Set(
        values.flatMap((value) => [value, JSON.stringify(value).slice(1, -1)]),
      ),
    ]
      .filter(Boolean)
      .sort((a, b) => b.length - a.length);
    pattern = new RegExp(
      literals
        .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("|"),
      "g",
    );
    matchers.set(values, pattern);
  }
  let redacted = false;
  const output = text.replace(pattern, () => {
    redacted = true;
    return "[redacted]";
  });
  return { text: output, redacted };
}
