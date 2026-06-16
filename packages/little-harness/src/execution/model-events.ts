import type { LanguageModel, ModelMessage, ToolSet } from "ai";
import { toJSONSchema } from "zod";
import { hashHarnessPrompt, sha256Digest } from "../events/durability.js";
import { sha256Hex } from "../ids.js";
import { captureTraceContent } from "../trace/content.js";
import { createTraceErrorEnvelope } from "../trace/error.js";
import type { ResolvedHarnessTraceOptions } from "../trace/types.js";
import type { FileWriter, JsonObject } from "../types.js";

export type ModelRequestedMetadataOptions = {
  stepNumber: number;
  callId?: string;
  model: LanguageModel | { provider?: string; modelId?: string };
  system: string;
  messages: ModelMessage[];
  tools: ToolSet;
  files: FileWriter;
  traceOptions: ResolvedHarnessTraceOptions;
  settings?: JsonObject | undefined;
  scope?: JsonObject;
  step?: JsonObject;
};

export type DurableModelRequest = JsonObject & {
  model: string;
  system: string;
  messages: unknown[];
  tools: JsonObject[];
  settings?: Record<string, unknown>;
  scope?: Record<string, unknown>;
  step?: unknown;
};

export type ModelRespondedMetadataOptions = {
  stepNumber: number;
  callId?: string;
  model: LanguageModel | { provider?: string; modelId?: string };
  result: unknown;
  text: string;
  files: FileWriter;
  traceOptions: ResolvedHarnessTraceOptions;
};

export type ModelFailedEventDataOptions = {
  stepNumber: number;
  callId: string;
  model: LanguageModel | { provider?: string; modelId?: string };
  durationMs: number;
  error: unknown;
  attempt?: number;
  willRetry?: boolean;
};

export async function modelCalledEventData(options: ModelRequestedMetadataOptions & { callId: string }): Promise<{
  readonly payload: JsonObject;
  readonly metadata: JsonObject;
}> {
  const metadata = await modelRequestedMetadata(options);
  const request = durableModelRequest(options);
  return {
    payload: {
      callId: options.callId,
      turn: options.stepNumber,
      promptHash: hashHarnessPrompt(request),
      request,
    },
    metadata,
  };
}

export async function modelRespondedEventData(options: ModelRespondedMetadataOptions & { callId: string }): Promise<{
  readonly payload: JsonObject;
  readonly metadata: JsonObject;
}> {
  const metadata = await modelRespondedMetadata(options);
  const result = isObject(options.result) ? options.result : {};
  const response: JsonObject = { text: options.text };
  if ("output" in result && result.output !== undefined) {
    response.output = result.output;
  }
  if (Array.isArray(result.toolCalls)) {
    response.toolCalls = result.toolCalls.filter(isJsonLike);
  }
  if (result.usage !== undefined && isJsonLike(result.usage)) {
    response.usage = result.usage;
  }
  return {
    payload: {
      callId: options.callId,
      turn: options.stepNumber,
      response,
    },
    metadata,
  };
}

export function modelFailedEventData(options: ModelFailedEventDataOptions): {
  readonly payload: JsonObject;
  readonly metadata: JsonObject;
} {
  const error = createTraceErrorEnvelope(options.error);
  return {
    payload: {
      callId: options.callId,
      turn: options.stepNumber,
      ...(options.attempt === undefined ? {} : { attempt: options.attempt }),
      ...(options.willRetry === undefined ? {} : { willRetry: options.willRetry }),
      durationMs: options.durationMs,
      error,
    },
    metadata: {
      stepNumber: options.stepNumber,
      model: modelMetadata(options.model),
      durationMs: options.durationMs,
      error,
    },
  };
}

export function toolRefsForDurableRequest(tools: ToolSet): JsonObject[] {
  return Object.entries(tools)
    .map(([toolName, toolValue]) => durableToolRef(toolName, toolValue))
    .sort((left, right) => String(left.toolName).localeCompare(String(right.toolName)));
}

export async function modelRequestedMetadata(options: ModelRequestedMetadataOptions): Promise<JsonObject> {
  return {
    stepNumber: options.stepNumber,
    model: modelMetadata(options.model),
    request: {
      promptHash: sha256Hex(stableStringify({ system: options.system, messages: options.messages })),
      system: await captureModelMessageContent({
        value: options.system,
        label: `model-request/system/step-${options.stepNumber}`,
        files: options.files,
        traceOptions: options.traceOptions,
        mediaType: "text/plain",
      }),
      messages: await Promise.all(
        options.messages.map(async (message) => ({
          role: message.role,
          content: await captureModelMessageContent({
            value: message.content,
            label: `model-request/message/step-${options.stepNumber}/${message.role}`,
            files: options.files,
            traceOptions: options.traceOptions,
          }),
        })),
      ),
      tools: Object.entries(options.tools).map(([toolName, toolValue]) => {
        const tool = toolValue as { description?: unknown; inputSchema?: unknown };
        const out: JsonObject = { toolName };
        if (typeof tool.description === "string") {
          out.descriptionHash = sha256Hex(tool.description);
        }
        if (tool.inputSchema !== undefined) {
          out.schemaHash = sha256Hex(stableStringify(tool.inputSchema));
        }
        return out;
      }),
      ...(options.settings === undefined ? {} : { settings: options.settings }),
    },
  };
}

export async function modelRespondedMetadata(options: ModelRespondedMetadataOptions): Promise<JsonObject> {
  const result = isObject(options.result) ? options.result : {};
  const out: JsonObject = {
    stepNumber: options.stepNumber,
    model: modelMetadata(options.model),
    text: await captureModelMessageContent({
      value: options.text,
      label: `model-response/text/step-${options.stepNumber}`,
      files: options.files,
      traceOptions: options.traceOptions,
      mediaType: "text/plain",
    }),
  };

  if (typeof result.finishReason === "string") {
    out.finishReason = result.finishReason;
  }
  if (typeof result.rawFinishReason === "string") {
    out.rawFinishReason = result.rawFinishReason;
  }
  if (result.usage !== undefined && isJsonLike(result.usage)) {
    out.usage = result.usage;
  }
  if (result.providerMetadata !== undefined && isJsonLike(result.providerMetadata)) {
    out.providerMetadata = result.providerMetadata;
  }
  if (Array.isArray(result.warnings)) {
    out.warnings = result.warnings as JsonObject[];
  }
  const reasoning = reasoningValue(result);
  if (reasoning !== undefined) {
    out.reasoning = options.traceOptions.content.captureReasoning
      ? await captureTraceContent({
          value: reasoning,
          label: `model-response/reasoning/step-${options.stepNumber}`,
          files: options.files,
          traceOptions: options.traceOptions,
          mediaType: typeof reasoning === "string" ? "text/plain" : "application/json",
        })
      : { captured: false };
  }
  if (Array.isArray(result.toolCalls)) {
    out.toolCalls = await Promise.all(
      result.toolCalls.map(async (toolCall) =>
        modelToolCallMetadata(toolCall, {
          stepNumber: options.stepNumber,
          files: options.files,
          traceOptions: options.traceOptions,
        }),
      ),
    );
  }
  if (Array.isArray(result.sources)) {
    out.sources = result.sources.filter(isJsonLike) as JsonObject[];
  }
  if (Array.isArray(result.files)) {
    out.generatedFiles = result.files.map(generatedFileMetadata).filter(Boolean) as JsonObject[];
  }

  return out;
}

export function durableModelRequest(options: ModelRequestedMetadataOptions): DurableModelRequest {
  const request: DurableModelRequest = {
    model: modelIdForDurableRequest(options.model),
    system: options.system,
    messages: toDurableJson(options.messages),
    tools: toolRefsForDurableRequest(options.tools),
  } as DurableModelRequest;
  if (options.settings !== undefined) {
    request.settings = toDurableJson(options.settings) as Record<string, unknown>;
  }
  if (options.scope !== undefined) {
    request.scope = toDurableJson(options.scope) as Record<string, unknown>;
  }
  if (options.step !== undefined) {
    request.step = toDurableJson(options.step);
  }
  return request;
}

function modelIdForDurableRequest(model: LanguageModel | { provider?: string; modelId?: string }): string {
  const value = model as { modelId?: unknown };
  return typeof value.modelId === "string" ? value.modelId : "unknown";
}

function durableToolRef(toolName: string, toolValue: unknown): JsonObject {
  const tool = isObject(toolValue) ? toolValue : {};
  const out: JsonObject = { toolName };
  if (typeof tool.description === "string") {
    out.descriptionHash = sha256Digest(tool.description);
  }
  const inputSchemaHash = hashNormalizedToolSchema(tool.inputSchema);
  if (inputSchemaHash !== undefined) {
    out.inputSchemaHash = inputSchemaHash;
  }
  const outputSchemaHash = hashNormalizedToolSchema(tool.outputSchema);
  if (outputSchemaHash !== undefined) {
    out.outputSchemaHash = outputSchemaHash;
  }
  return out;
}

function hashNormalizedToolSchema(schema: unknown): string | undefined {
  if (schema === undefined) {
    return undefined;
  }
  try {
    return sha256Digest(normalizeToolSchema(schema));
  } catch {
    return undefined;
  }
}

function normalizeToolSchema(schema: unknown): unknown {
  if (isAiSdkSchema(schema)) {
    return normalizeToolSchema(schema.jsonSchema);
  }
  if (isZodSchema(schema)) {
    return stripJsonSchemaDialect(toJSONSchema(schema as never));
  }
  return clonePlainJson(schema);
}

function isAiSdkSchema(schema: unknown): schema is { jsonSchema: unknown } {
  return isObject(schema) && Reflect.get(schema, Symbol.for("vercel.ai.schema")) === true && "jsonSchema" in schema;
}

function isZodSchema(schema: unknown): boolean {
  return isObject(schema) && "_zod" in schema && typeof schema.toJSONSchema === "function";
}

function stripJsonSchemaDialect(schema: unknown): unknown {
  if (!isObject(schema)) {
    return schema;
  }
  const { $schema: _schema, ...rest } = schema;
  return rest;
}

function clonePlainJson(value: unknown): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "string" || typeof value === "number") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => clonePlainJson(item));
  }
  if (isObject(value)) {
    const out: JsonObject = {};
    for (const key of Object.keys(value)) {
      out[key] = clonePlainJson(value[key]);
    }
    return out;
  }
  throw new TypeError("Unsupported schema value.");
}

function toDurableJson(value: unknown): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "string" || typeof value === "number") {
    return value;
  }
  if (value === undefined) {
    return null;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "function" || typeof value === "symbol") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => toDurableJson(item));
  }
  if (value instanceof Uint8Array) {
    return { type: "bytes", base64: Buffer.from(value).toString("base64") };
  }
  if (value instanceof ArrayBuffer) {
    return { type: "bytes", base64: Buffer.from(value).toString("base64") };
  }
  if (isObject(value)) {
    const out: JsonObject = {};
    for (const key of Object.keys(value).sort()) {
      const item = toDurableJson(value[key]);
      if (item !== undefined) {
        out[key] = item;
      }
    }
    return out;
  }
  return String(value);
}

async function captureModelMessageContent(options: {
  value: unknown;
  label: string;
  files: FileWriter;
  traceOptions: ResolvedHarnessTraceOptions;
  mediaType?: string;
}) {
  if (!options.traceOptions.content.captureModelMessages) {
    return { captured: false };
  }

  return captureTraceContent(options);
}

async function modelToolCallMetadata(
  toolCall: unknown,
  options: {
    stepNumber: number;
    files: FileWriter;
    traceOptions: ResolvedHarnessTraceOptions;
  },
): Promise<JsonObject> {
  const value = isObject(toolCall) ? toolCall : {};
  const out: JsonObject = {};
  if (typeof value.toolName === "string") {
    out.toolName = value.toolName;
  }
  if (typeof value.toolCallId === "string") {
    out.toolCallId = value.toolCallId;
  }
  if ("input" in value) {
    out.input = options.traceOptions.content.captureToolInputs
      ? await captureTraceContent({
          value: value.input,
          label: `model-response/tool-call-input/step-${options.stepNumber}`,
          files: options.files,
          traceOptions: options.traceOptions,
        })
      : { captured: false };
  }
  return out;
}

function generatedFileMetadata(file: unknown): JsonObject | undefined {
  if (!isObject(file)) {
    return undefined;
  }

  const bytes = generatedFileBytes(file);
  const out: JsonObject = {};
  if (typeof file.mediaType === "string") {
    out.mediaType = file.mediaType;
  }
  if (bytes) {
    out.bytes = bytes.byteLength;
    out.sha256 = sha256Hex(bytes);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function generatedFileBytes(file: Record<string, unknown>): Uint8Array | undefined {
  if (file.uint8Array instanceof Uint8Array) {
    return file.uint8Array;
  }
  if (typeof file.base64 === "string") {
    return Buffer.from(file.base64, "base64");
  }
  return undefined;
}

function reasoningValue(result: Record<string, unknown>): unknown {
  if (typeof result.reasoningText === "string") {
    return result.reasoningText;
  }
  if (typeof result.reasoning === "string") {
    return result.reasoning;
  }
  if (Array.isArray(result.reasoning) && result.reasoning.length > 0) {
    return result.reasoning;
  }
  return undefined;
}

function modelMetadata(model: LanguageModel | { provider?: string; modelId?: string }): JsonObject {
  const value = model as { provider?: unknown; modelId?: unknown };
  const out: JsonObject = {};
  if (typeof value.provider === "string") {
    out.provider = value.provider;
  }
  if (typeof value.modelId === "string") {
    out.modelId = value.modelId;
  }
  return out;
}

function stableStringify(value: unknown): string {
  try {
    return JSON.stringify(value, replacer) ?? "";
  } catch {
    return String(value);
  }
}

function replacer(_key: string, value: unknown): unknown {
  if (typeof value === "function") {
    return "[function]";
  }
  if (typeof value === "symbol") {
    return value.toString();
  }
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonLike(value: unknown): value is JsonObject | JsonObject[] {
  return typeof value === "object" && value !== null;
}
