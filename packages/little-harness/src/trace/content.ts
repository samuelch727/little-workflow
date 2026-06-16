import { sha256Hex } from "../ids.js";
import type { FileWriter } from "../types.js";
import {
  redactionReasonForMetadataKey,
  redactionReasonForPath,
  sanitizeTraceValue,
} from "./redaction.js";
import type { ResolvedHarnessTraceOptions, TraceContentRef } from "./types.js";

export type CaptureTraceContentOptions = {
  value: unknown;
  label: string;
  files: FileWriter;
  traceOptions: ResolvedHarnessTraceOptions;
  path?: string;
  metadataKey?: string;
  mediaType?: string;
};

export async function captureTraceContent(
  options: CaptureTraceContentOptions,
): Promise<TraceContentRef> {
  if (!options.traceOptions.enabled) {
    return { captured: false };
  }

  const redactionReason =
    redactionReasonForPath(options.path, options.traceOptions) ??
    redactionReasonForMetadataKey(options.metadataKey, options.traceOptions);
  if (redactionReason) {
    return {
      captured: false,
      redacted: true,
      redactionReason,
    };
  }

  if (options.value instanceof Uint8Array) {
    return {
      captured: false,
      bytes: options.value.byteLength,
      sha256: sha256Hex(options.value),
      mediaType: options.mediaType ?? "application/octet-stream",
    };
  }

  const sanitized = sanitizeTraceValue(options.value, options.traceOptions);
  const serialized = serializeTraceValue(sanitized.value, options.mediaType);
  if (!serialized) {
    return { captured: false };
  }

  const preview = serialized.text.slice(0, options.traceOptions.content.previewBytes);
  const base: TraceContentRef = {
    captured: true,
    preview,
    truncated: serialized.bytes > options.traceOptions.content.maxInlineBytes,
    bytes: serialized.bytes,
    sha256: sha256Hex(serialized.bytesContent),
    mediaType: serialized.mediaType,
    ...(sanitized.redacted ? { redacted: true, redactionReason: "metadataKey" } : {}),
  };

  if (serialized.bytes <= options.traceOptions.content.maxInlineBytes) {
    return base;
  }

  const path = `/artifacts/trace/${safePathSegment(options.label)}/${sha256Hex(
    serialized.bytesContent,
  ).slice(0, 16)}.${serialized.extension}`;
  await options.files.writeText(path, serialized.text, {
    mediaType: serialized.mediaType,
    source: "trace",
    artifact: {
      metadata: {
        traceContent: true,
        label: options.label,
        bytes: serialized.bytes,
      },
    },
  });

  return {
    ...base,
    contentRef: path,
  };
}

type SerializedTraceValue = {
  text: string;
  bytes: number;
  bytesContent: Uint8Array;
  mediaType: string;
  extension: string;
};

function serializeTraceValue(
  value: unknown,
  mediaType: string | undefined,
): SerializedTraceValue | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value === "string") {
    return serializedText(value, mediaType ?? "text/plain", extensionForMediaType(mediaType) ?? "txt");
  }

  if (value instanceof Uint8Array) {
    return undefined;
  }

  try {
    const text = JSON.stringify(value, null, 2);
    return text === undefined ? undefined : serializedText(text, mediaType ?? "application/json", "json");
  } catch {
    return undefined;
  }
}

function serializedText(text: string, mediaType: string, extension: string): SerializedTraceValue {
  const bytesContent = new TextEncoder().encode(text);
  return {
    text,
    bytes: bytesContent.byteLength,
    bytesContent,
    mediaType,
    extension,
  };
}

function extensionForMediaType(mediaType: string | undefined): string | undefined {
  switch (mediaType) {
    case "application/json":
      return "json";
    case "text/plain":
      return "txt";
    default:
      return undefined;
  }
}

function safePathSegment(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9._:-]/g, "_").replace(/\.\.+/g, "_");
  return safe.length > 0 ? safe.slice(0, 96) : "content";
}
