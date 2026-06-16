import { createRequire } from "node:module";
import type * as Zod from "zod";
import type { Schema } from "./authoring.js";

type JsonPrimitive = string | number | boolean | null;

export type JsonValue =
  | JsonPrimitive
  | { readonly [key: string]: JsonValue }
  | readonly JsonValue[];

export type NormalizedSchemaDescriptor =
  | boolean
  | { readonly [key: string]: JsonValue };

type JsonSchemaInput<TValue = unknown> =
  | NormalizedSchemaDescriptor
  | Schema<TValue>
  | Zod.ZodType<TValue>;

type SchemaOutputValue<TSchema> =
  TSchema extends Zod.ZodType<infer TOutput>
    ? TOutput
    : TSchema extends Schema<infer TValue>
      ? TValue
      : unknown;

type NormalizedSchemaOutput<TSchema> =
  NormalizedSchemaDescriptor & Schema<SchemaOutputValue<TSchema>>;

type OutputMetadata = {
  readonly name?: string;
  readonly description?: string;
};

export type NormalizedOutputMode =
  | ({ readonly kind: "text" } & OutputMetadata)
  | ({
      readonly kind: "object";
      readonly schema: NormalizedSchemaDescriptor;
    } & OutputMetadata)
  | ({
      readonly kind: "array";
      readonly element: NormalizedSchemaDescriptor;
    } & OutputMetadata)
  | ({
      readonly kind: "choice";
      readonly values: readonly string[];
    } & OutputMetadata)
  | ({
      readonly kind: "json";
      readonly schema?: NormalizedSchemaDescriptor;
    } & OutputMetadata);

type UnsupportedSchemaErrorOptions = {
  readonly value?: unknown;
  readonly cause?: unknown;
};

type PlainRecord = Record<string, unknown>;

type OwnDataProperty =
  | { readonly found: false }
  | { readonly found: true; readonly value: unknown };

type ChoiceValuesProperty = OwnDataProperty & { readonly path: string };

type OutputModeTag = {
  readonly value: string | undefined;
  readonly path: "$.kind" | "$.type";
};

type OutputModeContext =
  | "root"
  | "text"
  | "object"
  | "array"
  | "choice"
  | "json"
  | "helperText"
  | "helperObject"
  | "helperArray"
  | "helperChoice"
  | "helperJson";

const EXECUTABLE_SCHEMA_KEYS = new Set([
  "parse",
  "safeParse",
  "transform",
  "refine",
  "pipe",
  "execute",
  "run",
  "validate",
]);

const ROOT_OUTPUT_MODE_KEYS = new Set([
  "kind",
  "type",
  "name",
  "description",
  "schema",
  "element",
  "values",
  "options",
  "enum",
]);
const TEXT_OUTPUT_MODE_KEYS = new Set(["kind", "type", "name", "description"]);
const OBJECT_OUTPUT_MODE_KEYS = new Set([
  "kind",
  "type",
  "name",
  "description",
  "schema",
]);
const ARRAY_OUTPUT_MODE_KEYS = new Set([
  "kind",
  "type",
  "name",
  "description",
  "schema",
  "element",
]);
const CHOICE_OUTPUT_MODE_KEYS = new Set([
  "kind",
  "type",
  "name",
  "description",
  "values",
  "options",
  "enum",
]);
const JSON_OUTPUT_MODE_KEYS = OBJECT_OUTPUT_MODE_KEYS;
const HELPER_TEXT_OUTPUT_MODE_KEYS = new Set(["name", "description"]);
const HELPER_OBJECT_OUTPUT_MODE_KEYS = new Set(["name", "description", "schema"]);
const HELPER_ARRAY_OUTPUT_MODE_KEYS = new Set(["name", "description", "element"]);
const HELPER_CHOICE_OUTPUT_MODE_KEYS = new Set(["name", "description", "values"]);
const HELPER_JSON_OUTPUT_MODE_KEYS = HELPER_OBJECT_OUTPUT_MODE_KEYS;
const AI_SDK_SCHEMA_SYMBOL = Symbol.for("vercel.ai.schema");
const nodeRequire = createRequire(import.meta.url);

let cachedZod: typeof Zod | undefined;

export class UnsupportedSchemaError extends TypeError {
  readonly value?: unknown;

  constructor(message: string, options: UnsupportedSchemaErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = "UnsupportedSchemaError";
    this.value = options.value;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function normalizeSchema(value: unknown): NormalizedSchemaDescriptor {
  return normalizeSchemaAt(value, value, "$");
}

function normalizeSchemaAt(
  value: unknown,
  root: unknown,
  path: string,
): NormalizedSchemaDescriptor {
  if (typeof value === "boolean") {
    return value;
  }

  const zodSchema = normalizeZodSchemaAt(value, root, path);
  if (zodSchema !== undefined) {
    return zodSchema;
  }

  const aiSdkSchema = normalizeAiSdkSchemaAt(value, root, path);
  if (aiSdkSchema !== undefined) {
    return aiSdkSchema;
  }

  if (!isPlainRecord(value)) {
    throw unsupported(
      "Unsupported schema: expected a plain JSON Schema object or boolean schema.",
      root,
      path,
    );
  }

  return cloneJsonValue(value, path, root, new WeakMap()) as NormalizedSchemaDescriptor;
}

function normalizeZodSchemaAt(
  value: unknown,
  root: unknown,
  path: string,
): NormalizedSchemaDescriptor | undefined {
  if (value === null || typeof value !== "object" || isPlainRecord(value)) {
    return undefined;
  }
  const z = getZod();
  if (!hasZodDataBrand(value) || !(value instanceof z.ZodType)) {
    return undefined;
  }

  let jsonSchema: unknown;
  try {
    jsonSchema = z.toJSONSchema(value as Zod.ZodType, {
      target: "draft-7",
      cycles: "throw",
      reused: "inline",
    });
  } catch (error) {
    throw new UnsupportedSchemaError(
      "Unsupported schema: Zod schema cannot be converted to JSON Schema.",
      {
        value: root,
        cause: { path, error },
      },
    );
  }

  return cloneJsonValue(
    omitGeneratedJsonSchemaDialect(jsonSchema),
    path,
    root,
    new WeakMap(),
  ) as NormalizedSchemaDescriptor;
}

function normalizeAiSdkSchemaAt(
  value: unknown,
  root: unknown,
  path: string,
): NormalizedSchemaDescriptor | undefined {
  if (value === null || typeof value !== "object") {
    return undefined;
  }
  const marker = Object.getOwnPropertyDescriptor(value, AI_SDK_SCHEMA_SYMBOL);
  if (marker === undefined || !("value" in marker) || marker.value !== true) {
    return undefined;
  }
  const jsonSchemaDescriptor = Object.getOwnPropertyDescriptor(value, "jsonSchema");
  if (jsonSchemaDescriptor === undefined) {
    throw unsupported(
      "Unsupported AI SDK schema: jsonSchema is required.",
      root,
      `${path}.jsonSchema`,
    );
  }
  const jsonSchema = "value" in jsonSchemaDescriptor
    ? jsonSchemaDescriptor.value
    : jsonSchemaDescriptor.get?.call(value);
  return normalizeSchemaAt(jsonSchema, root, `${path}.jsonSchema`);
}

function getZod(): typeof Zod {
  if (cachedZod !== undefined) {
    return cachedZod;
  }
  cachedZod = nodeRequire("zod") as typeof Zod;
  return cachedZod;
}

function hasZodDataBrand(value: object): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(value, "_zod");
  if (descriptor === undefined || !("value" in descriptor)) {
    return false;
  }
  const zodState = descriptor.value;
  if (!isPlainRecord(zodState)) {
    return false;
  }
  const traits = Object.getOwnPropertyDescriptor(zodState, "traits");
  return traits !== undefined &&
    "value" in traits &&
    traits.value instanceof Set &&
    (traits.value.has("ZodType") || traits.value.has("$ZodType"));
}

function omitGeneratedJsonSchemaDialect(value: unknown): unknown {
  if (!isPlainRecord(value) || !Object.hasOwn(value, "$schema")) {
    return value;
  }
  const { $schema: _schema, ...schema } = value;
  return schema;
}

export function normalizeOutputMode(value: unknown): NormalizedOutputMode {
  if (!isPlainRecord(value)) {
    throw unsupported("Unsupported output mode: expected a plain object.", value, "$");
  }

  validateOutputModeOwnProperties(value, "$", "root");
  const tag = outputModeTag(value);
  const mode = tag.value;
  const metadata = normalizeMetadata(value, value);

  if (mode === "text") {
    validateOutputModeOwnProperties(value, "$", "text");
    return { kind: "text", ...metadata };
  }

  if (mode === "object") {
    validateOutputModeOwnProperties(value, "$", "object");
    const schema = readOwnDataProperty(
      value,
      "schema",
      value,
      "$.schema",
      "output mode",
    );

    if (!schema.found) {
      throw unsupported(
        "Unsupported object output mode: schema is required.",
        value,
        "$.schema",
      );
    }

    return {
      kind: "object",
      schema: normalizeSchemaAt(schema.value, value, "$.schema"),
      ...metadata,
    };
  }

  if (mode === "array") {
    validateOutputModeOwnProperties(value, "$", "array");
    const element = readOwnDataProperty(
      value,
      "element",
      value,
      "$.element",
      "output mode",
    );
    const schemaAlias = readOwnDataProperty(
      value,
      "schema",
      value,
      "$.schema",
      "output mode",
    );
    const elementKey = element.found ? "element" : "schema";
    const elementOrSchema = element.found ? element : schemaAlias;

    if (element.found && schemaAlias.found) {
      throw unsupported(
        "Unsupported array output mode: element and schema aliases are ambiguous.",
        value,
        "$.schema",
      );
    }

    if (!elementOrSchema.found || elementOrSchema.value === undefined) {
      throw unsupported(
        "Unsupported array output mode: element schema is required.",
        value,
        `$.${elementKey}`,
      );
    }

    return {
      kind: "array",
      element: normalizeSchemaAt(elementOrSchema.value, value, `$.${elementKey}`),
      ...metadata,
    };
  }

  if (mode === "choice") {
    validateOutputModeOwnProperties(value, "$", "choice");
    const values = choiceValues(value, value);

    if (!values.found || !Array.isArray(values.value)) {
      throw unsupported(
        "Unsupported choice output mode: values must be an array of strings.",
        value,
        values.path,
      );
    }
    const valuesArray = cloneStringArray(values.value, values.path, value);

    return {
      kind: "choice",
      values: valuesArray,
      ...metadata,
    };
  }

  if (mode === "json") {
    validateOutputModeOwnProperties(value, "$", "json");
    const schema = readOwnDataProperty(
      value,
      "schema",
      value,
      "$.schema",
      "output mode",
    );
    if (schema.found && schema.value !== undefined) {
      return {
        kind: "json",
        schema: normalizeSchemaAt(schema.value, value, "$.schema"),
        ...metadata,
      };
    }

    return { kind: "json", ...metadata };
  }

  throw unsupported(
    "Unsupported output mode: expected text, object, array, choice, or json.",
    value,
    tag.path,
  );
}

type TextOutputOptions = OutputMetadata;

type ObjectOutputOptions<TSchema extends JsonSchemaInput> = {
  readonly schema: TSchema;
} & OutputMetadata;

type ArrayOutputOptions<TElement extends JsonSchemaInput> = {
  readonly element: TElement;
} & OutputMetadata;

type ChoiceOutputOptions<TValues extends readonly string[]> = {
  readonly values: TValues;
} & OutputMetadata;

type JsonOutputOptions = OutputMetadata & {
  readonly schema?: undefined;
};

type JsonOutputSchemaOptions<TSchema extends JsonSchemaInput> = {
  readonly schema: TSchema;
} & OutputMetadata;

function jsonOutput(): { readonly kind: "json" } & OutputMetadata;
function jsonOutput(options: JsonOutputOptions): { readonly kind: "json" } & OutputMetadata;
function jsonOutput<const TSchema extends JsonSchemaInput>(
  options: JsonOutputSchemaOptions<TSchema>,
): {
  readonly kind: "json";
  readonly schema: NormalizedSchemaOutput<TSchema>;
} & OutputMetadata;
function jsonOutput<const TSchema extends JsonSchemaInput>(
  options: JsonOutputOptions | JsonOutputSchemaOptions<TSchema> = {},
): (
  | ({ readonly kind: "json" } & OutputMetadata)
  | ({
      readonly kind: "json";
      readonly schema: NormalizedSchemaOutput<TSchema>;
    } & OutputMetadata)
) {
  const optionsRecord = assertPlainOutputOptions(options);
  validateOutputModeOwnProperties(optionsRecord, "$", "helperJson");
  const schema = readOwnDataProperty(
    optionsRecord,
    "schema",
    options,
    "$.schema",
    "output mode",
  );

  return normalizeOutputMode({
    kind: "json",
    ...(schema.found ? { schema: schema.value } : {}),
    ...definedMetadata(optionsRecord),
  }) as
    | ({ readonly kind: "json" } & OutputMetadata)
    | ({
        readonly kind: "json";
        readonly schema: NormalizedSchemaOutput<TSchema>;
      } & OutputMetadata);
}

export const output = {
  text(options: TextOutputOptions = {}): { readonly kind: "text" } & OutputMetadata {
    const optionsRecord = assertPlainOutputOptions(options);
    validateOutputModeOwnProperties(optionsRecord, "$", "helperText");

    return normalizeOutputMode({ kind: "text", ...definedMetadata(optionsRecord) }) as {
      readonly kind: "text";
    } & OutputMetadata;
  },

  object<const TSchema extends JsonSchemaInput>(
    options: ObjectOutputOptions<TSchema>,
  ): {
    readonly kind: "object";
    readonly schema: NormalizedSchemaOutput<TSchema>;
  } & OutputMetadata {
    const optionsRecord = assertPlainOutputOptions(options);
    validateOutputModeOwnProperties(optionsRecord, "$", "helperObject");
    const schema = readRequiredOutputOption(optionsRecord, "schema");

    return normalizeOutputMode({
      kind: "object",
      schema,
      ...definedMetadata(optionsRecord),
    }) as {
      readonly kind: "object";
      readonly schema: NormalizedSchemaOutput<TSchema>;
    } & OutputMetadata;
  },

  array<const TElement extends JsonSchemaInput>(
    options: ArrayOutputOptions<TElement>,
  ): {
    readonly kind: "array";
    readonly element: NormalizedSchemaOutput<TElement>;
  } & OutputMetadata {
    const optionsRecord = assertPlainOutputOptions(options);
    validateOutputModeOwnProperties(optionsRecord, "$", "helperArray");
    const element = readRequiredOutputOption(optionsRecord, "element");

    return normalizeOutputMode({
      kind: "array",
      element,
      ...definedMetadata(optionsRecord),
    }) as {
      readonly kind: "array";
      readonly element: NormalizedSchemaOutput<TElement>;
    } & OutputMetadata;
  },

  choice<const TValues extends readonly string[]>(
    options: ChoiceOutputOptions<TValues>,
  ): { readonly kind: "choice"; readonly values: TValues } & OutputMetadata {
    const optionsRecord = assertPlainOutputOptions(options);
    validateOutputModeOwnProperties(optionsRecord, "$", "helperChoice");
    const values = readRequiredOutputOption(optionsRecord, "values");

    return normalizeOutputMode({
      kind: "choice",
      values,
      ...definedMetadata(optionsRecord),
    }) as { readonly kind: "choice"; readonly values: TValues } & OutputMetadata;
  },
  json: jsonOutput,
} as const;

function outputModeTag(value: PlainRecord): OutputModeTag {
  const kind = readOwnDataProperty(value, "kind", value, "$.kind", "output mode");
  const type = readOwnDataProperty(value, "type", value, "$.type", "output mode");

  if (kind.found) {
    if (typeof kind.value !== "string") {
      throw unsupported(
        "Unsupported output mode: kind must be a string.",
        value,
        "$.kind",
      );
    }

    if (type.found) {
      if (typeof type.value !== "string") {
        throw unsupported(
          "Unsupported output mode: type must be a string.",
          value,
          "$.type",
        );
      }
      if (type.value !== kind.value) {
        throw unsupported(
          "Unsupported output mode: kind and type aliases must match.",
          value,
          "$.type",
        );
      }
    }

    return { value: kind.value, path: "$.kind" };
  }

  if (type.found) {
    if (typeof type.value !== "string") {
      throw unsupported(
        "Unsupported output mode: type must be a string.",
        value,
        "$.type",
      );
    }

    return { value: type.value, path: "$.type" };
  }

  return { value: undefined, path: "$.kind" };
}

function choiceValues(value: PlainRecord, root: unknown): ChoiceValuesProperty {
  const values = readOwnDataProperty(value, "values", root, "$.values", "output mode");
  const options = readOwnDataProperty(value, "options", root, "$.options", "output mode");
  const enumValues = readOwnDataProperty(value, "enum", root, "$.enum", "output mode");
  const aliasCount = Number(values.found) + Number(options.found) + Number(enumValues.found);

  if (aliasCount > 1) {
    throw unsupported(
      "Unsupported choice output mode: values, options, and enum aliases are ambiguous.",
      root,
      options.found ? "$.options" : "$.enum",
    );
  }

  if (values.found) {
    return { ...values, path: "$.values" };
  }

  if (options.found) {
    return { ...options, path: "$.options" };
  }

  if (enumValues.found) {
    return { ...enumValues, path: "$.enum" };
  }

  return { found: false, path: "$.values" };
}

function normalizeMetadata(value: PlainRecord, root: unknown): OutputMetadata {
  const metadata: { name?: string; description?: string } = {};
  const name = readOwnDataProperty(value, "name", root, "$.name", "output mode");
  const description = readOwnDataProperty(
    value,
    "description",
    root,
    "$.description",
    "output mode",
  );

  if (name.found && name.value !== undefined) {
    if (typeof name.value !== "string") {
      throw unsupported(
        "Unsupported output mode metadata: name must be a string.",
        root,
        "$.name",
      );
    }
    metadata.name = name.value;
  }

  if (description.found && description.value !== undefined) {
    if (typeof description.value !== "string") {
      throw unsupported(
        "Unsupported output mode metadata: description must be a string.",
        root,
        "$.description",
      );
    }
    metadata.description = description.value;
  }

  return metadata;
}

function definedMetadata(value: PlainRecord): OutputMetadata {
  return normalizeMetadata(value, value);
}

function validateOutputModeOwnProperties(
  value: PlainRecord,
  path: string,
  context: OutputModeContext,
): void {
  const allowedKeys = outputModeAllowedKeys(context);

  for (const symbolKey of Object.getOwnPropertySymbols(value)) {
    if (Object.hasOwn(value, symbolKey)) {
      throw unsupported(
        "Unsupported output mode: symbol keys are not supported.",
        value,
        path,
      );
    }
  }

  for (const key of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) {
      continue;
    }

    const propertyPath = pathForKey(path, key);
    if (!("value" in descriptor)) {
      throw unsupported(
        "Unsupported output mode: accessors are not supported.",
        value,
        propertyPath,
      );
    }
    if (!descriptor.enumerable) {
      throw unsupported(
        "Unsupported output mode: non-enumerable properties are not supported.",
        value,
        propertyPath,
      );
    }
    if (!allowedKeys.has(key)) {
      throw unsupported(
        "Unsupported output mode: unknown properties are not supported.",
        value,
        propertyPath,
      );
    }
    if (EXECUTABLE_SCHEMA_KEYS.has(key) && typeof descriptor.value === "function") {
      throw unsupported(
        `Unsupported output mode executable field at ${propertyPath}: executable transforms are not supported.`,
        value,
        propertyPath,
      );
    }
  }
}

function outputModeAllowedKeys(context: OutputModeContext): ReadonlySet<string> {
  switch (context) {
    case "root":
      return ROOT_OUTPUT_MODE_KEYS;
    case "text":
      return TEXT_OUTPUT_MODE_KEYS;
    case "object":
      return OBJECT_OUTPUT_MODE_KEYS;
    case "array":
      return ARRAY_OUTPUT_MODE_KEYS;
    case "choice":
      return CHOICE_OUTPUT_MODE_KEYS;
    case "json":
      return JSON_OUTPUT_MODE_KEYS;
    case "helperText":
      return HELPER_TEXT_OUTPUT_MODE_KEYS;
    case "helperObject":
      return HELPER_OBJECT_OUTPUT_MODE_KEYS;
    case "helperArray":
      return HELPER_ARRAY_OUTPUT_MODE_KEYS;
    case "helperChoice":
      return HELPER_CHOICE_OUTPUT_MODE_KEYS;
    case "helperJson":
      return HELPER_JSON_OUTPUT_MODE_KEYS;
  }
}

function cloneJsonValue(
  value: unknown,
  path: string,
  root: unknown,
  seen: WeakMap<object, string>,
): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw unsupported("Unsupported schema: numbers must be finite.", root, path);
    }
    return value;
  }

  if (typeof value === "function") {
    const message = isClassConstructor(value)
      ? "Unsupported schema: class constructors are not JSON-serializable."
      : "Unsupported schema: functions are not JSON-serializable.";
    throw unsupported(message, root, path);
  }

  if (typeof value === "bigint" || typeof value === "symbol" || value === undefined) {
    throw unsupported("Unsupported schema: value is not JSON-serializable.", root, path);
  }

  if (value instanceof Map) {
    throw unsupported("Unsupported schema: Map values are not JSON-serializable.", root, path);
  }

  if (value instanceof Set) {
    throw unsupported("Unsupported schema: Set values are not JSON-serializable.", root, path);
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) {
      throw unsupported("Unsupported schema: cyclic references are not JSON-serializable.", root, path);
    }
    seen.set(value, path);
    validateArrayOwnProperties(value, path, root, "schema");
    const clone: JsonValue[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const itemPath = `${path}[${index}]`;
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined) {
        throw unsupported(
          "Unsupported schema: sparse arrays are not JSON-serializable.",
          root,
          itemPath,
        );
      }
      if (!("value" in descriptor)) {
        throw unsupported(
          "Unsupported schema: accessors are not JSON-serializable.",
          root,
          itemPath,
        );
      }
      Object.defineProperty(clone, index, {
        value: cloneJsonValue(descriptor.value, itemPath, root, seen),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    seen.delete(value);
    return clone;
  }

  if (!isPlainRecord(value)) {
    throw unsupported(
      "Unsupported schema: class instances and non-plain objects are not JSON-serializable.",
      root,
      path,
    );
  }

  if (seen.has(value)) {
    throw unsupported("Unsupported schema: cyclic references are not JSON-serializable.", root, path);
  }
  seen.set(value, path);

  const clone: Record<string, JsonValue> = {};

  for (const symbolKey of Object.getOwnPropertySymbols(value)) {
    if (Object.hasOwn(value, symbolKey)) {
      throw unsupported(
        "Unsupported schema: symbol keys are not JSON-serializable.",
        root,
        path,
      );
    }
  }

  for (const key of Object.getOwnPropertyNames(value)) {
    const propertyPath = pathForKey(path, key);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) {
      continue;
    }
    if (!("value" in descriptor)) {
      throw unsupported(
        "Unsupported schema: accessors are not JSON-serializable.",
        root,
        propertyPath,
      );
    }
    const nestedValue = descriptor.value;
    if (EXECUTABLE_SCHEMA_KEYS.has(key) && typeof nestedValue === "function") {
      throw unsupported(
        `Unsupported schema transform at ${propertyPath}: executable transforms are not supported.`,
        root,
        propertyPath,
      );
    }
    if (!descriptor.enumerable) {
      throw unsupported(
        "Unsupported schema: non-enumerable properties are not JSON-serializable.",
        root,
        propertyPath,
      );
    }
    Object.defineProperty(clone, key, {
      value: cloneJsonValue(nestedValue, propertyPath, root, seen),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }

  seen.delete(value);
  return clone;
}

function cloneStringArray(value: readonly unknown[], path: string, root: unknown): string[] {
  validateArrayOwnProperties(value, path, root, "choice");
  const clone = new Array<string>(value.length);
  for (let index = 0; index < value.length; index += 1) {
    const itemPath = `${path}[${index}]`;
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined) {
      throw unsupported(
        "Unsupported choice output mode: values must not be sparse.",
        root,
        itemPath,
      );
    }
    if (!("value" in descriptor)) {
      throw unsupported(
        "Unsupported choice output mode: values must not contain accessors.",
        root,
        itemPath,
      );
    }
    const option = descriptor.value;
    if (typeof option !== "string") {
      throw unsupported(
        "Unsupported choice output mode: values must be an array of strings.",
        root,
        itemPath,
      );
    }
    Object.defineProperty(clone, index, {
      value: option,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return clone;
}

function validateArrayOwnProperties(
  value: readonly unknown[],
  path: string,
  root: unknown,
  context: "schema" | "choice",
): void {
  for (const symbolKey of Object.getOwnPropertySymbols(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, symbolKey);
    if (descriptor !== undefined) {
      throw unsupported(
        context === "schema"
          ? "Unsupported schema: array symbol keys are not JSON-serializable."
          : "Unsupported choice output mode: values must not contain symbol keys.",
        root,
        path,
      );
    }
  }

  for (const key of Object.getOwnPropertyNames(value)) {
    if (key === "length" || isCanonicalArrayIndex(key, value.length)) {
      continue;
    }

    throw unsupported(
      context === "schema"
        ? "Unsupported schema: arrays must not contain extra properties."
        : "Unsupported choice output mode: values must not contain extra properties.",
      root,
      pathForKey(path, key),
    );
  }
}

function assertPlainOutputOptions(value: unknown): PlainRecord {
  if (!isPlainRecord(value)) {
    throw unsupported("Unsupported output helper options: expected a plain object.", value, "$");
  }
  return value;
}

function readRequiredOutputOption(value: PlainRecord, key: string): unknown {
  const property = readOwnDataProperty(value, key, value, `$.${key}`, "output mode");
  if (!property.found) {
    throw unsupported(
      `Unsupported output helper options: ${key} is required.`,
      value,
      `$.${key}`,
    );
  }
  return property.value;
}

function readOwnDataProperty(
  value: PlainRecord,
  key: string,
  root: unknown,
  path: string,
  context: "schema" | "output mode",
): OwnDataProperty {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);

  if (descriptor === undefined) {
    return { found: false };
  }
  if (!("value" in descriptor)) {
    const message =
      context === "schema"
        ? "Unsupported schema: accessors are not JSON-serializable."
        : "Unsupported output mode: accessors are not supported.";
    throw unsupported(message, root, path);
  }
  return { found: true, value: descriptor.value };
}

function isPlainRecord(value: unknown): value is PlainRecord {
  if (value === null || typeof value !== "object") {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isClassConstructor(value: Function): boolean {
  return Function.prototype.toString.call(value).startsWith("class ");
}

function pathForKey(path: string, key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

function isCanonicalArrayIndex(key: string, length: number): boolean {
  if (!/^(0|[1-9]\d*)$/.test(key)) {
    return false;
  }

  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < length;
}

function unsupported(message: string, value: unknown, path: string): UnsupportedSchemaError {
  return new UnsupportedSchemaError(message, {
    value,
    cause: { path },
  });
}
