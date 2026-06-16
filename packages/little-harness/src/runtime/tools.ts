import type { ToolSet } from "ai";
import { sha256Hex } from "../ids.js";
import type {
  FileRef,
  HarnessToolExecutionContext,
  HarnessToolResultSpoolingOptions,
  JsonObject,
} from "../types.js";

const DEFAULT_MAX_INLINE_BYTES = 16 * 1024;
const DEFAULT_PREVIEW_BYTES = 512;
const DEFAULT_OUTPUT_DIR = "/artifacts/tool-results";

export function wrapToolsWithHarnessContext<TTools extends ToolSet, TExtraBody>(
  tools: TTools,
  ctx: HarnessToolExecutionContext<TExtraBody>,
): TTools {
  const wrapped: Record<string, unknown> = {};

  for (const [name, harnessTool] of Object.entries(tools)) {
    const original = harnessTool as Record<string, unknown>;
    const execute = original.execute;
    wrapped[name] = {
      ...original,
      execute:
        typeof execute === "function"
          ? async (input: unknown, options: unknown) => {
              const executeOptions: Record<string, unknown> = { ...(isObject(options) ? options : {}), ...ctx };
              const toolCallId = typeof executeOptions.toolCallId === "string" ? executeOptions.toolCallId : undefined;
              const replayState = ctx.toolReplay?.get(toolCallId);
              if (replayState?.replay.kind === "completed") {
                return replayState.replay.result;
              }
              if (replayState?.replay.kind === "failed") {
                throw errorFromReplayEnvelope(replayState.replay.error);
              }
              if (replayState?.replay.kind === "inflight" && replayState.callId !== undefined) {
                executeOptions.toolCallId = replayState.callId;
              }
              const result = await execute(input, executeOptions);
              return spoolToolResultIfNeeded(name, result, executeOptions, ctx);
            }
          : undefined,
    };
  }

  return wrapped as TTools;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorFromReplayEnvelope(value: unknown): Error {
  const envelope = isObject(value) ? value : {};
  const error = new Error(typeof envelope.message === "string" ? envelope.message : "Harness tool call failed.");
  error.name = typeof envelope.name === "string" ? envelope.name : "Error";
  return Object.assign(error, envelope);
}

async function spoolToolResultIfNeeded<TExtraBody>(
  toolName: string,
  result: unknown,
  executeOptions: Record<string, unknown>,
  ctx: HarnessToolExecutionContext<TExtraBody>,
): Promise<unknown> {
  const policy = resolveSpoolingPolicy(ctx.toolResultSpooling);
  if (!policy) {
    return result;
  }

  const serialized = serializeToolResult(result);
  if (!serialized || serialized.bytes <= policy.maxInlineBytes) {
    return result;
  }

  const toolCallId = typeof executeOptions.toolCallId === "string" ? executeOptions.toolCallId : undefined;
  const path = `${policy.outputDir}/${safePathSegment(toolName)}/${safePathSegment(
    toolCallId ?? fallbackResultId(toolName, serialized.text),
  )}.${serialized.extension}`;
  const ref = await ctx.files.writeText(path, serialized.text, {
    mediaType: serialized.mediaType,
    metadata: {
      spooledToolResult: true,
      toolName,
      bytes: serialized.bytes,
    },
  });

  return spooledResult(toolName, toolCallId, ref, serialized, policy);
}

type ResolvedSpoolingPolicy = {
  maxInlineBytes: number;
  previewBytes: number;
  outputDir: string;
};

function resolveSpoolingPolicy(
  options: HarnessToolResultSpoolingOptions | undefined,
): ResolvedSpoolingPolicy | undefined {
  if (options === false) {
    return undefined;
  }

  return {
    maxInlineBytes: options?.maxInlineBytes ?? DEFAULT_MAX_INLINE_BYTES,
    previewBytes: options?.previewBytes ?? DEFAULT_PREVIEW_BYTES,
    outputDir: trimTrailingSlashes(options?.outputDir ?? DEFAULT_OUTPUT_DIR),
  };
}

type SerializedToolResult = {
  text: string;
  bytes: number;
  mediaType: string;
  extension: string;
  summary: ToolResultContentSummary;
};

function serializeToolResult(result: unknown): SerializedToolResult | undefined {
  if (result === undefined) {
    return undefined;
  }

  if (typeof result === "string") {
    return serializedText(result, "text/plain", "txt", parseJsonText(result));
  }

  if (result instanceof Uint8Array) {
    return undefined;
  }

  try {
    const text = JSON.stringify(result, null, 2);
    return text === undefined ? undefined : serializedText(text, "application/json", "json", parseJsonText(text));
  } catch {
    return undefined;
  }
}

function serializedText(
  text: string,
  mediaType: string,
  extension: string,
  parsedJson: ParsedJson,
): SerializedToolResult {
  return {
    text,
    bytes: new TextEncoder().encode(text).byteLength,
    mediaType,
    extension,
    summary: summarizeSerializedText(text, parsedJson),
  };
}

function spooledResult(
  toolName: string,
  toolCallId: string | undefined,
  ref: FileRef,
  serialized: SerializedToolResult,
  policy: ResolvedSpoolingPolicy,
): JsonObject {
  const out: JsonObject = {
    type: "harness.tool_result_file",
    toolName,
    path: ref.path,
    bytes: serialized.bytes,
    mediaType: serialized.mediaType,
    truncated: true,
    summary: serialized.summary,
    preview: serialized.text.slice(0, policy.previewBytes),
    message: `Tool result exceeded ${policy.maxInlineBytes} bytes and was written to ${ref.path}; ${describeSummary(
      serialized.summary,
    )}; read that file for the full result.`,
  };

  if (toolCallId !== undefined) {
    out.toolCallId = toolCallId;
  }
  if (ref.sha256 !== undefined) {
    out.sha256 = ref.sha256;
  }

  return out;
}

function safePathSegment(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9._:-]/g, "_").replace(/\.\.+/g, "_");
  return safe.length > 0 ? safe.slice(0, 96) : "unknown";
}

function fallbackResultId(toolName: string, text: string): string {
  return `result_${sha256Hex(`${toolName}:${Date.now()}:${text}`).slice(0, 12)}`;
}

function trimTrailingSlashes(value: string): string {
  const trimmed = value.replace(/\/+$/g, "");
  return trimmed.length > 0 ? trimmed : DEFAULT_OUTPUT_DIR;
}

type ToolResultContentSummary = {
  format: "text" | "json";
  characters: number;
  lines: number;
  structure?: JsonStructure;
};

type JsonStructure =
  | { type: "null" | "boolean" | "number" | "string" }
  | { type: "array"; length: number; element?: JsonStructure; sampled?: number; truncated?: true }
  | { type: "object"; keys?: JsonObjectKeyStructure[]; truncatedKeys?: number; truncated?: true }
  | { type: "union"; variants: JsonStructure[] };

type JsonObjectKeyStructure = {
  name: string;
  value: JsonStructure;
  optional?: true;
};

type ParsedJson = { ok: true; value: unknown } | { ok: false };

const MAX_JSON_STRUCTURE_DEPTH = 4;
const MAX_JSON_OBJECT_KEYS = 12;
const MAX_JSON_ARRAY_SAMPLES = 3;

function summarizeSerializedText(text: string, parsedJson: ParsedJson): ToolResultContentSummary {
  const base = {
    characters: [...text].length,
    lines: countLogicalLines(text),
  };

  if (parsedJson.ok) {
    return {
      ...base,
      format: "json",
      structure: describeJsonStructure(parsedJson.value, MAX_JSON_STRUCTURE_DEPTH),
    };
  }

  return {
    ...base,
    format: "text",
  };
}

function parseJsonText(text: string): ParsedJson {
  if (!looksLikeJsonText(text)) {
    return { ok: false };
  }

  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

function looksLikeJsonText(text: string): boolean {
  const first = text.trimStart()[0];
  return first !== undefined && `{["-0123456789tfn`.includes(first);
}

function countLogicalLines(text: string): number {
  if (text.length === 0) {
    return 0;
  }

  const newlines = text.match(/\r\n|\r|\n/g)?.length ?? 0;
  return newlines + (/\r\n|\r|\n$/u.test(text) ? 0 : 1);
}

function describeJsonStructure(value: unknown, depth: number): JsonStructure {
  if (value === null) {
    return { type: "null" };
  }

  const valueType = typeof value;
  if (valueType === "boolean" || valueType === "number" || valueType === "string") {
    return { type: valueType };
  }

  if (Array.isArray(value)) {
    if (depth <= 0) {
      return { type: "array", length: value.length, truncated: true };
    }

    const sampledValues = value.slice(0, MAX_JSON_ARRAY_SAMPLES);
    const element = mergeJsonStructures(
      sampledValues.map((item) => describeJsonStructure(item, depth - 1)),
    );
    const structure: JsonStructure = { type: "array", length: value.length };
    if (element !== undefined) {
      structure.element = element;
    }
    if (value.length > sampledValues.length) {
      structure.sampled = sampledValues.length;
    }
    return structure;
  }

  if (valueType === "object") {
    if (depth <= 0) {
      return { type: "object", truncated: true };
    }

    const entries = Object.entries(value as Record<string, unknown>);
    const visibleEntries = entries.slice(0, MAX_JSON_OBJECT_KEYS);
    const structure: JsonStructure = {
      type: "object",
      keys: visibleEntries.map(([name, childValue]) => ({
        name,
        value: describeJsonStructure(childValue, depth - 1),
      })),
    };
    if (entries.length > visibleEntries.length) {
      structure.truncatedKeys = entries.length - visibleEntries.length;
    }
    return structure;
  }

  return { type: "string" };
}

function mergeJsonStructures(shapes: JsonStructure[]): JsonStructure | undefined {
  if (shapes.length === 0) {
    return undefined;
  }
  if (shapes.length === 1) {
    return shapes[0];
  }

  const firstType = shapes[0]!.type;
  if (shapes.every((shape) => shape.type === firstType)) {
    if (firstType === "object") {
      return mergeObjectStructures(shapes as Array<Extract<JsonStructure, { type: "object" }>>);
    }
    if (firstType === "array") {
      return mergeArrayStructures(shapes as Array<Extract<JsonStructure, { type: "array" }>>);
    }
    return shapes[0];
  }

  const variants: JsonStructure[] = [];
  for (const shape of shapes) {
    if (!variants.some((variant) => structuresAreEqual(variant, shape))) {
      variants.push(shape);
    }
  }

  return { type: "union", variants };
}

function mergeObjectStructures(shapes: Array<Extract<JsonStructure, { type: "object" }>>): JsonStructure {
  const keys = new Map<string, { values: JsonStructure[]; count: number; optional: boolean }>();

  for (const shape of shapes) {
    for (const key of shape.keys ?? []) {
      const existing = keys.get(key.name);
      if (existing) {
        existing.values.push(key.value);
        existing.count += 1;
        existing.optional ||= key.optional === true;
      } else {
        keys.set(key.name, {
          values: [key.value],
          count: 1,
          optional: key.optional === true,
        });
      }
    }
  }

  const mergedKeys: JsonObjectKeyStructure[] = [];
  for (const [name, key] of keys) {
    const value = mergeJsonStructures(key.values);
    if (!value) {
      continue;
    }
    const out: JsonObjectKeyStructure = { name, value };
    if (key.optional || key.count < shapes.length) {
      out.optional = true;
    }
    mergedKeys.push(out);
  }

  return { type: "object", keys: mergedKeys };
}

function mergeArrayStructures(shapes: Array<Extract<JsonStructure, { type: "array" }>>): JsonStructure {
  const element = mergeJsonStructures(
    shapes.flatMap((shape) => (shape.element === undefined ? [] : [shape.element])),
  );
  const maxLength = Math.max(...shapes.map((shape) => shape.length));
  const out: JsonStructure = { type: "array", length: maxLength };
  if (element !== undefined) {
    out.element = element;
  }
  return out;
}

function structuresAreEqual(left: JsonStructure, right: JsonStructure): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function describeSummary(summary: ToolResultContentSummary): string {
  const size = `${summary.lines} ${summary.lines === 1 ? "line" : "lines"}, ${summary.characters} ${
    summary.characters === 1 ? "character" : "characters"
  }`;
  if (summary.format === "json" && summary.structure) {
    return `summary: JSON ${describeJsonStructureForMessage(summary.structure)} (${size})`;
  }
  return `summary: text (${size})`;
}

function describeJsonStructureForMessage(structure: JsonStructure): string {
  const text = describeJsonStructureForMessageUnbounded(structure);
  return text.length > 300 ? `${text.slice(0, 297)}...` : text;
}

function describeJsonStructureForMessageUnbounded(structure: JsonStructure): string {
  if (structure.type === "array") {
    const element = structure.element ? ` of ${describeJsonStructureForMessageUnbounded(structure.element)}` : "";
    return `array[${structure.length}]${element}`;
  }
  if (structure.type === "object") {
    const keys = structure.keys?.map(
      (key) => `${key.name}${key.optional ? "?" : ""}: ${describeJsonStructureForMessageUnbounded(key.value)}`,
    );
    const suffix = structure.truncatedKeys ? `, ...${structure.truncatedKeys} more` : "";
    return `object{${[...(keys ?? []), suffix].filter(Boolean).join(", ")}}`;
  }
  if (structure.type === "union") {
    return structure.variants.map(describeJsonStructureForMessageUnbounded).join(" | ");
  }
  return structure.type;
}
