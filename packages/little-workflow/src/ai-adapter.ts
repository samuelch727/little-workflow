import type { LwirOutputMode, LwirStepOutput } from "./lwir.js";

type JsonRecord = Record<string, unknown>;

type AiSdkGenerateFunction = (options: JsonRecord) => Promise<unknown>;
type AiSdkOutputHelper = (options?: JsonRecord) => unknown;

export type AiSdkModuleLike = {
  readonly generateText?: AiSdkGenerateFunction;
  readonly streamText?: unknown;
  readonly jsonSchema?: (schema: unknown) => unknown;
  readonly Output?: {
    readonly text?: AiSdkOutputHelper;
    readonly object?: AiSdkOutputHelper;
    readonly array?: AiSdkOutputHelper;
    readonly choice?: AiSdkOutputHelper;
    readonly json?: AiSdkOutputHelper;
  };
};

export type AiSdkAdapterMapping = {
  readonly strategy: "generateText.output";
  readonly generateFunction: "generateText";
  readonly streamFunction?: "streamText";
  readonly outputHelpers: Partial<Record<LwirOutputMode, string>>;
};

export type AiSdkAdapter = {
  readonly moduleLike: AiSdkModuleLike;
  readonly mapping: AiSdkAdapterMapping;
};

export type GenerateWithAdapterOptions = {
  readonly model: unknown;
  readonly output: LwirStepOutput;
  readonly prompt?: string;
  readonly system?: string;
  readonly messages?: unknown;
  readonly tools?: unknown;
  readonly providerOptions?: unknown;
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
  readonly abortSignal?: AbortSignal;
  readonly timeout?: number;
  /**
   * Stream the model call via `streamText` instead of `generateText`. Streaming
   * keeps a live connection, so long-running calls (reasoning/thinking models,
   * or any call under provider load) are not truncated by the provider's
   * non-streaming response timeout. Falls back to `generateText` when the module
   * exposes no `streamText`.
   */
  readonly stream?: boolean;
};

export type AiSdkUsage = {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  /** Prompt tokens served from the provider's prefix cache (cheap, carried over). */
  readonly cachedInputTokens?: number;
  /** Output tokens spent on reasoning/thinking (distinct from the visible answer). */
  readonly reasoningTokens?: number;
};

export type AiSdkAdapterResult = {
  readonly output: unknown;
  readonly text?: string;
  /** The model's reasoning/thinking trace, when the provider exposes it (e.g. DeepSeek). */
  readonly reasoning?: string;
  readonly usage?: AiSdkUsage;
  readonly finishReason?: unknown;
  readonly providerMetadata?: unknown;
  readonly mapping: AiSdkAdapterMapping;
  readonly resultField?: "output" | "object" | "text";
  readonly raw: unknown;
};

const OUTPUT_HELPER_NAMES = ["text", "object", "array", "choice", "json"] as const;

export function resolveAiSdkMapping(moduleLike: AiSdkModuleLike): AiSdkAdapterMapping {
  if (typeof moduleLike.generateText !== "function" || !hasOutputHelpers(moduleLike)) {
    throw new TypeError(
      "AI SDK adapter requires generateText with Output helpers (Output.{text,object,array,choice,json}).",
    );
  }
  return {
    strategy: "generateText.output",
    generateFunction: "generateText",
    streamFunction: typeof moduleLike.streamText === "function" ? "streamText" : undefined,
    outputHelpers: outputHelperMapping(moduleLike.Output),
  };
}

export function createAiSdkAdapter(moduleLike: AiSdkModuleLike): AiSdkAdapter {
  return {
    moduleLike,
    mapping: resolveAiSdkMapping(moduleLike),
  };
}

export async function generateWithAdapter(
  adapter: AiSdkAdapter,
  options: GenerateWithAdapterOptions,
): Promise<AiSdkAdapterResult> {
  const request = baseRequest(options);
  const rawResult = await callGenerateText(adapter, options, request);
  const result = asRecord(rawResult);
  const resultField = resultFieldFromResult(result, options.output.mode);

  const text = safeRead(result, "text");
  const reasoning = safeRead(result, "reasoningText");
  return {
    output: outputFromResult(result, resultField),
    text: typeof text === "string" ? text : undefined,
    reasoning: typeof reasoning === "string" && reasoning.length > 0 ? reasoning : undefined,
    usage: normalizeUsage(result),
    finishReason: safeRead(result, "finishReason"),
    providerMetadata: safeRead(result, "providerMetadata"),
    mapping: adapter.mapping,
    resultField,
    raw: result,
  };
}

/** Read a possibly-throwing AI SDK result getter, returning undefined on throw. */
function safeRead(result: JsonRecord, key: string): unknown {
  try {
    return result[key];
  } catch {
    return undefined;
  }
}

function hasOutputHelpers(moduleLike: AiSdkModuleLike): boolean {
  return OUTPUT_HELPER_NAMES.every(
    (name) => typeof moduleLike.Output?.[name] === "function",
  );
}

function outputHelperMapping(
  output: AiSdkModuleLike["Output"],
): Partial<Record<LwirOutputMode, string>> {
  const mapping: Partial<Record<LwirOutputMode, string>> = {};
  for (const name of OUTPUT_HELPER_NAMES) {
    if (typeof output?.[name] === "function") {
      mapping[name] = `Output.${name}`;
    }
  }
  return mapping;
}

function baseRequest(options: GenerateWithAdapterOptions): JsonRecord {
  return stripUndefined({
    model: options.model,
    prompt: options.prompt,
    system: options.system,
    messages: options.messages,
    tools: options.tools,
    providerOptions: options.providerOptions,
    temperature: options.temperature,
    maxOutputTokens: options.maxOutputTokens,
    abortSignal: options.abortSignal,
    timeout: options.timeout,
  });
}

async function callGenerateText(
  adapter: AiSdkAdapter,
  options: GenerateWithAdapterOptions,
  request: JsonRecord,
): Promise<unknown> {
  const output = outputSpec(adapter.moduleLike, options.output);
  const streamText = adapter.moduleLike.streamText as
    | ((opts: JsonRecord) => unknown)
    | undefined;

  if (options.stream === true && typeof streamText === "function") {
    return resolveStreamResult(streamText({ ...request, output }), options.output.mode);
  }

  const generateText = adapter.moduleLike.generateText;
  if (typeof generateText !== "function") {
    throw new TypeError("AI SDK generateText is unavailable.");
  }
  return generateText({ ...request, output });
}

/**
 * Drain a `streamText` result into a plain record shaped like a `generateText`
 * result, so the rest of the adapter (output/usage/finish-reason extraction)
 * works unchanged. Awaiting the aggregate promises consumes the stream.
 */
async function resolveStreamResult(stream: unknown, mode: LwirOutputMode): Promise<JsonRecord> {
  if (!isRecord(stream)) {
    throw new TypeError("AI SDK streamText did not return a result object.");
  }
  const record: JsonRecord = {};
  record.text = await settleValue((stream as JsonRecord).text);
  record.reasoningText = await settleValue((stream as JsonRecord).reasoningText);
  record.toolCalls = await settleValue((stream as JsonRecord).toolCalls);
  const usage = (await settleValue((stream as JsonRecord).totalUsage)) ??
    (await settleValue((stream as JsonRecord).usage));
  if (usage !== undefined) {
    record.totalUsage = usage;
  }
  record.finishReason = await settleValue((stream as JsonRecord).finishReason);
  record.providerMetadata = await settleValue((stream as JsonRecord).providerMetadata);
  if (mode !== "text") {
    const outputPromise = (stream as JsonRecord).output ?? (stream as JsonRecord).experimental_output;
    record.output = await settleValue(outputPromise);
  }
  return record;
}

/** Resolve a value-or-promise, mapping rejection (e.g. NoObjectGenerated when the model called tools) to undefined. */
function settleValue(value: unknown): Promise<unknown> {
  return Promise.resolve(value).then((resolved) => resolved, () => undefined);
}


function outputSpec(moduleLike: AiSdkModuleLike, output: LwirStepOutput): unknown {
  const helpers = moduleLike.Output;
  const metadata = {
    name: readOutputMetadata(output, "name"),
    description: readOutputMetadata(output, "description"),
  };

  if (output.mode === "text") {
    requireHelper(helpers, "text");
    return helpers!.text!();
  }

  if (output.mode === "choice") {
    requireHelper(helpers, "choice");
    return helpers!.choice!(stripUndefined({ options: output.values, ...metadata }));
  }

  if (output.mode === "json") {
    requireHelper(helpers, "json");
    return helpers!.json!(stripUndefined(metadata));
  }

  // object AND array both go through Output.object with the (wrapped) schema.
  // Output.array wraps the schema as `{ elements: T[] }`, which breaks providers
  // (e.g. DeepSeek) that return a raw top-level JSON array; Output.object with a
  // `type: "array"` schema accepts the raw array. Plain JSON schemas must be
  // wrapped with the AI SDK `jsonSchema()` helper or `asSchema()` rejects them.
  requireHelper(helpers, "object");
  return helpers!.object!(
    stripUndefined({ schema: wrapJsonSchema(moduleLike, output.schema), ...metadata }),
  );
}

function requireHelper(
  helpers: AiSdkModuleLike["Output"],
  name: "text" | "object" | "array" | "choice" | "json",
): void {
  if (typeof helpers?.[name] !== "function") {
    throw new TypeError(`AI SDK Output.${name} helper is unavailable.`);
  }
}

/**
 * Wrap a plain JSON-schema object with the AI SDK `jsonSchema()` helper so
 * `asSchema()` accepts it. Zod schemas and already-branded AI SDK schemas pass
 * through unchanged. When the module exposes no `jsonSchema` helper (older SDK
 * or a test double), the schema is returned as-is.
 */
function wrapJsonSchema(moduleLike: AiSdkModuleLike, schema: unknown): unknown {
  if (typeof moduleLike.jsonSchema !== "function") {
    return schema;
  }
  if (!isPlainJsonSchemaObject(schema)) {
    return schema;
  }
  return moduleLike.jsonSchema(schema);
}

function isPlainJsonSchemaObject(schema: unknown): boolean {
  if (!isRecord(schema)) {
    return false;
  }
  if ((schema as Record<symbol, unknown>)[Symbol.for("vercel.ai.schema")] === true) {
    return false;
  }
  if (typeof (schema as { parse?: unknown }).parse === "function") {
    return false;
  }
  if (typeof (schema as { safeParse?: unknown }).safeParse === "function") {
    return false;
  }
  const jsonSchemaKeys = [
    "$ref", "$defs", "type", "properties", "items", "required",
    "additionalProperties", "enum", "const", "anyOf", "oneOf", "allOf",
  ];
  return jsonSchemaKeys.some((key) => Object.hasOwn(schema, key));
}


function outputFromResult(
  result: JsonRecord,
  resultField: AiSdkAdapterResult["resultField"],
): unknown {
  if (resultField === undefined) {
    return undefined;
  }
  // `result.output` is a getter that throws AI_NoOutputGeneratedError when the
  // model emitted tool calls instead of a final structured output. In an agent
  // loop that is expected: the caller continues with the tool calls. Treat a
  // throw as "no output yet" rather than failing the whole turn.
  try {
    return result[resultField];
  } catch {
    return undefined;
  }
}

function resultFieldFromResult(
  result: JsonRecord,
  mode: LwirOutputMode,
): AiSdkAdapterResult["resultField"] {
  if ("output" in result) {
    return "output";
  }
  if ("object" in result) {
    return "object";
  }
  if (mode === "text" && "text" in result) {
    return "text";
  }
  return undefined;
}

function normalizeUsage(result: JsonRecord): AiSdkUsage | undefined {
  const usage = isRecord(result.totalUsage) ? result.totalUsage : result.usage;
  if (!isRecord(usage)) {
    return undefined;
  }

  return stripUndefined({
    inputTokens: numberValue(usage.inputTokens, usage.promptTokens),
    outputTokens: numberValue(usage.outputTokens, usage.completionTokens),
    totalTokens: numberValue(usage.totalTokens),
    cachedInputTokens: numberValue(
      usage.cachedInputTokens,
      nestedNumber(usage, "inputTokenDetails", "cachedTokens"),
      nestedNumber(usage, "promptTokensDetails", "cachedTokens"),
    ),
    reasoningTokens: numberValue(
      nestedNumber(usage, "outputTokenDetails", "reasoningTokens"),
      usage.reasoningTokens,
      nestedNumber(usage, "completionTokensDetails", "reasoningTokens"),
    ),
  }) as AiSdkUsage;
}

/** Read a number nested one level under an object-valued key, e.g. usage.outputTokenDetails.reasoningTokens. */
function nestedNumber(rec: JsonRecord, outer: string, inner: string): unknown {
  const nested = rec[outer];
  return isRecord(nested) ? nested[inner] : undefined;
}

function readOutputMetadata(output: LwirStepOutput, key: "name" | "description"): unknown {
  return (output as unknown as JsonRecord)[key];
}

function numberValue(...values: readonly unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function stripUndefined(value: JsonRecord): JsonRecord {
  const result: JsonRecord = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) {
      result[key] = item;
    }
  }
  return result;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): JsonRecord {
  if (!isRecord(value)) {
    throw new TypeError("AI SDK adapter expected an object result.");
  }
  return value;
}
