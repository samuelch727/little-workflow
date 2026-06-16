import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import {
  createLittleWorkflow,
  model,
  output as publicOutput,
} from "./index.js";
import type {
  Harness,
  InferWorkflowInput,
  InferWorkflowOutput,
  NormalizedSchemaDescriptor,
  OutputMode,
  Schema,
} from "./index.js";

type SchemaApi = {
  UnsupportedSchemaError: new (
    message?: string,
    options?: { value?: unknown; cause?: unknown },
  ) => Error & { value?: unknown; cause?: unknown };
  normalizeOutputMode: (value: unknown) => unknown;
  normalizeSchema: (value: unknown) => unknown;
  output: {
    text: (options?: { name?: string; description?: string }) => unknown;
    object: (options: {
      schema: unknown;
      name?: string;
      description?: string;
    }) => unknown;
    array: (options: {
      element: unknown;
      name?: string;
      description?: string;
    }) => unknown;
    choice: (options: {
      values: readonly string[];
      name?: string;
      description?: string;
    }) => unknown;
    json: (options?: {
      schema?: unknown;
      name?: string;
      description?: string;
    }) => unknown;
  };
};

async function loadSchemaApi(): Promise<Partial<SchemaApi>> {
  return import("./index.js") as Promise<Partial<SchemaApi>>;
}

const ticketSchema = {
  type: "object",
  properties: {
    summary: { type: "string" },
    priority: { enum: ["low", "high"] },
  },
  required: ["summary", "priority"],
  additionalProperties: false,
} as const;

const scoreSchema = {
  type: "object",
  properties: {
    score: { type: "number", minimum: 0, maximum: 1 },
  },
  required: ["score"],
  additionalProperties: false,
} as const;

type TicketOutput = {
  summary: string;
  priority: "low" | "high";
};

type ScoreOutput = {
  score: number;
};

const typedTicketSchema = ticketSchema as typeof ticketSchema & Schema<TicketOutput>;
const typedScoreSchema = scoreSchema as typeof scoreSchema & Schema<ScoreOutput>;

const zodTicketSchema = z.object({
  summary: z.string(),
  priority: z.enum(["low", "high"]),
});

const zodTicketJsonSchema = {
  type: "object",
  properties: {
    summary: { type: "string" },
    priority: { type: "string", enum: ["low", "high"] },
  },
  required: ["summary", "priority"],
  additionalProperties: false,
} as const;

const schemaTestHarness: Harness = {
  async run(task) {
    switch (task.kind) {
      case "plan":
        return { kind: "plan", lwir: { apiVersion: "littleworkflow.dev/v0.1" } };
      case "orchestrate":
        return { kind: "orchestrate", output: { ok: true } };
      case "execute_step":
        return { kind: "execute_step", output: task.stepInput, artifactRefs: [] };
      case "fix_step":
        return {
          kind: "fix_step",
          output: task.stepInput,
          fixedSource: "async () => ({})",
          attempts: 1,
        };
    }
  },
};
const schemaWorkerModel = model(
  { provider: "test", modelId: "schema-worker-model" },
  { description: "Schema test worker model." },
);
const schemaPlanner = {
  model: { provider: "test", modelId: "schema-planner-model" },
  harness: schemaTestHarness,
} as const;

function workflowDef<
  const TDefinition extends Omit<Parameters<typeof createLittleWorkflow>[0], "models" | "planner"> & {
    readonly models?: Parameters<typeof createLittleWorkflow>[0]["models"];
    readonly planner?: Parameters<typeof createLittleWorkflow>[0]["planner"];
  },
>(definition: TDefinition) {
  return createLittleWorkflow({
    models: [schemaWorkerModel],
    planner: schemaPlanner,
    ...definition,
  });
}

describe("schema normalization", () => {
  it("normalizes plain JSON Schema objects into JSON-serializable descriptors", async () => {
    const { normalizeSchema } = await loadSchemaApi();

    expect(normalizeSchema).toBeTypeOf("function");
    const normalized = normalizeSchema?.(ticketSchema);

    expect(normalized).toEqual(ticketSchema);
    expect(normalized).not.toBe(ticketSchema);
    expect(normalizeSchema?.(true)).toBe(true);
    expect(normalizeSchema?.(false)).toBe(false);
  });

  it("preserves JSON Schema property names that collide with object prototypes", async () => {
    const { normalizeSchema } = await loadSchemaApi();
    const properties = {
      constructor: { type: "number" },
      "weird-key": { type: "boolean" },
    };
    Object.defineProperty(properties, "__proto__", {
      value: { type: "string" },
      enumerable: true,
      configurable: true,
      writable: true,
    });

    const normalized = normalizeSchema?.({
      type: "object",
      properties,
    }) as {
      properties: Record<string, unknown>;
    };

    expect(Object.hasOwn(normalized.properties, "__proto__")).toBe(true);
    expect(normalized.properties.__proto__).toEqual({ type: "string" });
    expect(normalized.properties.constructor).toEqual({ type: "number" });
    expect(normalized.properties["weird-key"]).toEqual({ type: "boolean" });
  });

  it("normalizes Zod schemas into JSON Schema descriptors", async () => {
    const { normalizeSchema, output, UnsupportedSchemaError } = await loadSchemaApi();

    expect(normalizeSchema?.(zodTicketSchema)).toEqual(zodTicketJsonSchema);
    expect(output?.object({ schema: zodTicketSchema })).toEqual({
      kind: "object",
      schema: zodTicketJsonSchema,
    });
    expect(output?.json({ schema: zodTicketSchema })).toEqual({
      kind: "json",
      schema: zodTicketJsonSchema,
    });
    expect(() =>
      normalizeSchema?.(z.object({ length: z.string().transform((value) => value.length) })),
    ).toThrow(UnsupportedSchemaError);
  });

  it("rejects fake Zod-like objects without invoking their properties", async () => {
    const { normalizeSchema, UnsupportedSchemaError } = await loadSchemaApi();
    let getterCalls = 0;
    class FakeZodSchema {
      get _zod() {
        getterCalls += 1;
        return {};
      }

      toJSONSchema() {
        getterCalls += 1;
        return ticketSchema;
      }
    }

    expect(() => normalizeSchema?.(new FakeZodSchema())).toThrow(
      UnsupportedSchemaError,
    );
    expect(() =>
      normalizeSchema?.(
        Object.assign(Object.create({ constructor: { name: "ZodObject" } }), {
          _zod: {},
          toJSONSchema() {
            getterCalls += 1;
            return ticketSchema;
          },
        }),
      ),
    ).toThrow(UnsupportedSchemaError);
    expect(() =>
      normalizeSchema?.(
        Object.assign(Object.create({ constructor: { name: "ZodObject" } }), {
          _zod: Object.defineProperty({}, "traits", {
            get() {
              getterCalls += 1;
              return new Set(["ZodType"]);
            },
            enumerable: true,
          }),
        }),
      ),
    ).toThrow(UnsupportedSchemaError);
    expect(getterCalls).toBe(0);
  });

  it("normalizes AI SDK schema wrappers into JSON Schema descriptors", async () => {
    const { normalizeSchema } = await loadSchemaApi();
    const schemaSymbol = Symbol.for("vercel.ai.schema");
    let validateCalls = 0;
    const aiSdkJsonSchema = {
      [schemaSymbol]: true,
      _type: undefined,
      get jsonSchema() {
        return ticketSchema;
      },
      validate() {
        validateCalls += 1;
        return { success: true, value: {} };
      },
    };

    expect(normalizeSchema?.(aiSdkJsonSchema)).toEqual(ticketSchema);
    expect(validateCalls).toBe(0);
  });

  it("normalizes conservative AI SDK-like output shapes", async () => {
    const { normalizeOutputMode } = await loadSchemaApi();

    expect(normalizeOutputMode).toBeTypeOf("function");
    expect(
      normalizeOutputMode?.({
        type: "object",
        schema: ticketSchema,
        name: "ticketSummary",
        description: "Structured ticket summary.",
      }),
    ).toEqual({
      kind: "object",
      schema: ticketSchema,
      name: "ticketSummary",
      description: "Structured ticket summary.",
    });
    expect(
      normalizeOutputMode?.({
        type: "array",
        element: scoreSchema,
        name: "scores",
        description: "Candidate scores.",
      }),
    ).toEqual({
      kind: "array",
      element: scoreSchema,
      name: "scores",
      description: "Candidate scores.",
    });
    expect(
      normalizeOutputMode?.({
        type: "choice",
        values: ["low", "high"],
        name: "priority",
      }),
    ).toEqual({
      kind: "choice",
      values: ["low", "high"],
      name: "priority",
    });
    expect(
      normalizeOutputMode?.({
        type: "choice",
        options: ["low", "high"],
        name: "priority",
      }),
    ).toEqual({
      kind: "choice",
      values: ["low", "high"],
      name: "priority",
    });
    expect(
      normalizeOutputMode?.({
        type: "choice",
        enum: ["low", "high"],
        name: "priority",
      }),
    ).toEqual({
      kind: "choice",
      values: ["low", "high"],
      name: "priority",
    });
    expect(
      normalizeOutputMode?.({
        type: "json",
        schema: ticketSchema,
        description: "Arbitrary structured JSON.",
      }),
    ).toEqual({
      kind: "json",
      schema: ticketSchema,
      description: "Arbitrary structured JSON.",
    });
    expect(
      normalizeOutputMode?.({
        type: "text",
        name: "draft",
      }),
    ).toEqual({
      kind: "text",
      name: "draft",
    });
  });

  it("normalizes user-authored output mode shapes", async () => {
    const { normalizeOutputMode } = await loadSchemaApi();

    expect(normalizeOutputMode).toBeTypeOf("function");
    expect(normalizeOutputMode?.({ kind: "object", schema: ticketSchema })).toEqual({
      kind: "object",
      schema: ticketSchema,
    });
    expect(normalizeOutputMode?.({ kind: "array", element: scoreSchema })).toEqual({
      kind: "array",
      element: scoreSchema,
    });
    expect(normalizeOutputMode?.({ kind: "array", schema: scoreSchema })).toEqual({
      kind: "array",
      element: scoreSchema,
    });
    expect(normalizeOutputMode?.({ kind: "choice", values: ["low", "high"] })).toEqual({
      kind: "choice",
      values: ["low", "high"],
    });
    expect(normalizeOutputMode?.({ kind: "json" })).toEqual({ kind: "json" });
    expect(normalizeOutputMode?.({ kind: "text" })).toEqual({ kind: "text" });
  });

  it("builds public output helper modes for every supported mode", async () => {
    const { output } = await loadSchemaApi();

    expect(output).toBeTypeOf("object");
    expect(output?.text()).toEqual({ kind: "text" });
    expect(
      output?.object({
        schema: ticketSchema,
        name: "ticketSummary",
        description: "Structured ticket summary.",
      }),
    ).toEqual({
      kind: "object",
      schema: ticketSchema,
      name: "ticketSummary",
      description: "Structured ticket summary.",
    });
    expect(
      output?.array({
        element: scoreSchema,
        name: "scores",
      }),
    ).toEqual({
      kind: "array",
      element: scoreSchema,
      name: "scores",
    });
    expect(
      output?.choice({
        values: ["low", "high"],
        description: "Allowed priorities.",
      }),
    ).toEqual({
      kind: "choice",
      values: ["low", "high"],
      description: "Allowed priorities.",
    });
    expect(output?.json()).toEqual({ kind: "json" });
    expect(output?.json({ schema: ticketSchema })).toEqual({
      kind: "json",
      schema: ticketSchema,
    });
  });

  it("rejects unsafe public output helper options", async () => {
    const { UnsupportedSchemaError, output } = await loadSchemaApi();
    const hiddenSchemaOptions = { name: "ticketSummary" };
    const symbolOptions = { schema: ticketSchema };
    const accessorOptions = { values: ["low", "high"] };

    Object.defineProperty(hiddenSchemaOptions, "schema", {
      value: ticketSchema,
      enumerable: false,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(symbolOptions, Symbol("parser"), {
      value: () => ticketSchema,
      enumerable: true,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(accessorOptions, "description", {
      enumerable: true,
      configurable: true,
      get() {
        throw new Error("helper option accessor should not execute");
      },
    });

    expect(() => output?.text({ transform: () => "draft" } as never)).toThrow(
      UnsupportedSchemaError,
    );
    expect(() => output?.object(hiddenSchemaOptions as never)).toThrow(
      UnsupportedSchemaError,
    );
    expect(() => output?.json(symbolOptions as never)).toThrow(
      UnsupportedSchemaError,
    );
    expect(() => output?.choice(accessorOptions as never)).toThrow(
      UnsupportedSchemaError,
    );
    expect(() =>
      output?.array({ element: scoreSchema, schema: ticketSchema } as never),
    ).toThrow(UnsupportedSchemaError);
  });

  it("preserves authoring inference through public output helpers", () => {
    const textWorkflow = workflowDef({
      id: "schema-output.text",
      output: publicOutput.text(),
    });
    const objectWorkflow = workflowDef({
      id: "schema-output.object",
      output: publicOutput.object({ schema: typedTicketSchema }),
    });
    const arrayWorkflow = workflowDef({
      id: "schema-output.array",
      output: publicOutput.array({ element: typedScoreSchema }),
    });
    const choiceWorkflow = workflowDef({
      id: "schema-output.choice",
      output: publicOutput.choice({ values: ["low", "high"] as const }),
    });
    const jsonWorkflow = workflowDef({
      id: "schema-output.json",
      output: publicOutput.json({ schema: typedTicketSchema }),
    });

    expectTypeOf<InferWorkflowOutput<typeof textWorkflow>>().toEqualTypeOf<string>();
    expectTypeOf<InferWorkflowOutput<typeof objectWorkflow>>().toEqualTypeOf<
      TicketOutput
    >();
    expectTypeOf<InferWorkflowOutput<typeof arrayWorkflow>>().toEqualTypeOf<
      ScoreOutput[]
    >();
    expectTypeOf<InferWorkflowOutput<typeof choiceWorkflow>>().toEqualTypeOf<
      "low" | "high"
    >();
    expectTypeOf<InferWorkflowOutput<typeof jsonWorkflow>>().toEqualTypeOf<
      TicketOutput
    >();

    const plainObjectMode: OutputMode<unknown> = publicOutput.object({
      schema: ticketSchema,
    });
    const plainArrayMode: OutputMode<unknown[]> = publicOutput.array({
      element: scoreSchema,
    });
    const plainJsonMode: OutputMode<unknown> = publicOutput.json({
      schema: ticketSchema,
    });
    const typedObjectMode: OutputMode<TicketOutput> = publicOutput.object({
      schema: typedTicketSchema,
    });
    const zodObjectMode = publicOutput.object({
      schema: zodTicketSchema,
    });
    const zodJsonMode = publicOutput.json({
      schema: zodTicketSchema,
    });
    const unknownBrandedSchema = ticketSchema as typeof ticketSchema & Schema<unknown>;
    const unknownBrandedObjectMode: OutputMode<unknown> = publicOutput.object({
      schema: unknownBrandedSchema,
    });
    const unknownBrandedJsonMode: OutputMode<unknown> = publicOutput.json({
      schema: unknownBrandedSchema,
    });
    void plainObjectMode;
    void plainArrayMode;
    void plainJsonMode;
    void typedObjectMode;
    expectTypeOf(zodObjectMode.schema).toMatchTypeOf<NormalizedSchemaDescriptor>();
    expectTypeOf(zodObjectMode.schema).not.toMatchTypeOf<typeof zodTicketSchema>();
    expectTypeOf(zodJsonMode.schema).toMatchTypeOf<NormalizedSchemaDescriptor>();
    void unknownBrandedObjectMode;
    void unknownBrandedJsonMode;
  });

  it("preserves authoring inference through Zod schemas", () => {
    const zodWorkflow = workflowDef({
      id: "schema-output.zod",
      inputSchema: z.object({
        body: z.string(),
        attempts: z.number().int(),
      }),
      output: publicOutput.object({ schema: zodTicketSchema }),
    });

    expectTypeOf<InferWorkflowInput<typeof zodWorkflow>>().toEqualTypeOf<{
      body: string;
      attempts: number;
    }>();
    expectTypeOf<InferWorkflowOutput<typeof zodWorkflow>>().toEqualTypeOf<
      z.output<typeof zodTicketSchema>
    >();
  });

  it("accepts normalized alias output shapes at the workflow authoring boundary", () => {
    const objectWorkflow = workflowDef({
      id: "schema-output.alias-object",
      output: { type: "object", schema: ticketSchema },
    });
    const arrayWorkflow = workflowDef({
      id: "schema-output.alias-array",
      output: { kind: "array", schema: scoreSchema },
    });
    const choiceOptionsWorkflow = workflowDef({
      id: "schema-output.alias-choice-options",
      output: { type: "choice", options: ["low", "high"] as const },
    });
    const choiceEnumWorkflow = workflowDef({
      id: "schema-output.alias-choice-enum",
      output: { kind: "choice", enum: ["low", "high"] as const },
    });

    expectTypeOf<InferWorkflowOutput<typeof objectWorkflow>>().toEqualTypeOf<unknown>();
    expectTypeOf<InferWorkflowOutput<typeof arrayWorkflow>>().toEqualTypeOf<unknown[]>();
    expectTypeOf<InferWorkflowOutput<typeof choiceOptionsWorkflow>>().toEqualTypeOf<
      "low" | "high"
    >();
    expectTypeOf<InferWorkflowOutput<typeof choiceEnumWorkflow>>().toEqualTypeOf<
      "low" | "high"
    >();
  });

  it("rejects executable or non-plain schema values with UnsupportedSchemaError", async () => {
    const { UnsupportedSchemaError, normalizeOutputMode, normalizeSchema } =
      await loadSchemaApi();

    expect(UnsupportedSchemaError).toBeTypeOf("function");
    expect(normalizeSchema).toBeTypeOf("function");
    expect(normalizeOutputMode).toBeTypeOf("function");

    class ClassBackedSchema {}

    const unsupportedValues = [
      () => ticketSchema,
      ClassBackedSchema,
      new Map([["type", "object"]]),
      new Set(["object"]),
      {
        type: "object",
        transform: (input: unknown) => input,
      },
    ];

    for (const value of unsupportedValues) {
      expect(() => normalizeSchema?.(value)).toThrow(UnsupportedSchemaError);
    }

    try {
      normalizeSchema?.(unsupportedValues[4]);
      throw new Error("normalizeSchema should have rejected transform-like input.");
    } catch (error) {
      expect(error).toBeInstanceOf(UnsupportedSchemaError);
      expect(error).toMatchObject({ value: unsupportedValues[4] });
      expect((error as Error).message).toContain("transform");
    }

    expect(() =>
      normalizeOutputMode?.({
        kind: "object",
        schema: { type: "object", parse: (input: unknown) => input },
      }),
    ).toThrow(UnsupportedSchemaError);
  });

  it("rejects schema accessors without invoking them", async () => {
    const { UnsupportedSchemaError, normalizeSchema } = await loadSchemaApi();
    const schemaWithAccessor = { type: "object" };
    let accessorCalls = 0;

    Object.defineProperty(schemaWithAccessor, "properties", {
      enumerable: true,
      configurable: true,
      get() {
        accessorCalls += 1;
        return {};
      },
    });

    expect(() => normalizeSchema?.(schemaWithAccessor)).toThrow(
      UnsupportedSchemaError,
    );
    expect(accessorCalls).toBe(0);
  });

  it("rejects hidden executable schema properties", async () => {
    const { UnsupportedSchemaError, normalizeSchema } = await loadSchemaApi();
    const schemaWithHiddenParser = { type: "object" };

    Object.defineProperty(schemaWithHiddenParser, "parse", {
      value: () => ticketSchema,
      enumerable: false,
      configurable: true,
      writable: true,
    });

    expect(() => normalizeSchema?.(schemaWithHiddenParser)).toThrow(
      UnsupportedSchemaError,
    );

    try {
      normalizeSchema?.(schemaWithHiddenParser);
      throw new Error("normalizeSchema should have rejected hidden parser input.");
    } catch (error) {
      expect(error).toBeInstanceOf(UnsupportedSchemaError);
      expect((error as Error & { cause?: { path?: string } }).cause?.path).toBe(
        "$.parse",
      );
    }
  });

  it("rejects schema objects with hidden symbol properties", async () => {
    const { UnsupportedSchemaError, normalizeSchema } = await loadSchemaApi();
    const schemaWithSymbolParser = { type: "object" };

    Object.defineProperty(schemaWithSymbolParser, Symbol("parser"), {
      value: () => ticketSchema,
      enumerable: false,
      configurable: true,
      writable: true,
    });

    expect(() => normalizeSchema?.(schemaWithSymbolParser)).toThrow(
      UnsupportedSchemaError,
    );
  });

  it("rejects array schemas with extra own properties", async () => {
    const { UnsupportedSchemaError, normalizeSchema } = await loadSchemaApi();
    const enumWithHiddenParser = ["low", "high"] as string[] & { parse?: unknown };
    const enumWithAccessor = ["low", "high"];
    const symbolKey = Symbol("validator");

    Object.defineProperty(enumWithHiddenParser, "parse", {
      value: () => "low",
      enumerable: false,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(enumWithAccessor, "extra", {
      enumerable: true,
      configurable: true,
      get() {
        throw new Error("array accessor should not execute");
      },
    });
    Object.defineProperty(enumWithAccessor, symbolKey, {
      value: () => "high",
      enumerable: true,
      configurable: true,
      writable: true,
    });

    expect(() => normalizeSchema?.({ enum: enumWithHiddenParser })).toThrow(
      UnsupportedSchemaError,
    );
    expect(() => normalizeSchema?.({ enum: enumWithAccessor })).toThrow(
      UnsupportedSchemaError,
    );
  });

  it("rejects choice arrays with extra own properties", async () => {
    const { UnsupportedSchemaError, normalizeOutputMode } = await loadSchemaApi();
    const valuesWithExtraProperty = ["low", "high"] as string[] & {
      parse?: unknown;
    };
    const valuesWithSymbol = ["low", "high"];

    valuesWithExtraProperty.parse = () => "low";
    Object.defineProperty(valuesWithSymbol, Symbol("validator"), {
      value: () => "high",
      enumerable: true,
      configurable: true,
      writable: true,
    });

    expect(() =>
      normalizeOutputMode?.({ kind: "choice", values: valuesWithExtraProperty }),
    ).toThrow(UnsupportedSchemaError);
    expect(() =>
      normalizeOutputMode?.({ kind: "choice", values: valuesWithSymbol }),
    ).toThrow(UnsupportedSchemaError);
  });

  it("rejects output mode accessors without invoking them", async () => {
    const { UnsupportedSchemaError, normalizeOutputMode } = await loadSchemaApi();
    const modeWithKindAccessor = {};
    const modeWithSchemaAccessor = { kind: "object" };
    let kindAccessorCalls = 0;
    let schemaAccessorCalls = 0;

    Object.defineProperty(modeWithKindAccessor, "kind", {
      enumerable: true,
      configurable: true,
      get() {
        kindAccessorCalls += 1;
        return "text";
      },
    });
    Object.defineProperty(modeWithSchemaAccessor, "schema", {
      enumerable: true,
      configurable: true,
      get() {
        schemaAccessorCalls += 1;
        return ticketSchema;
      },
    });

    expect(() => normalizeOutputMode?.(modeWithKindAccessor)).toThrow(
      UnsupportedSchemaError,
    );
    expect(() => normalizeOutputMode?.(modeWithSchemaAccessor)).toThrow(
      UnsupportedSchemaError,
    );
    expect(kindAccessorCalls).toBe(0);
    expect(schemaAccessorCalls).toBe(0);
  });

  it("rejects hidden output mode fields", async () => {
    const { UnsupportedSchemaError, normalizeOutputMode } = await loadSchemaApi();
    const modeWithHiddenKind = {};
    const modeWithHiddenSchema = { kind: "object" };
    const modeWithHiddenMetadata = { kind: "text" };

    Object.defineProperty(modeWithHiddenKind, "kind", {
      value: "text",
      enumerable: false,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(modeWithHiddenSchema, "schema", {
      value: ticketSchema,
      enumerable: false,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(modeWithHiddenMetadata, "name", {
      value: "hidden",
      enumerable: false,
      configurable: true,
      writable: true,
    });

    expect(() => normalizeOutputMode?.(modeWithHiddenKind)).toThrow(
      UnsupportedSchemaError,
    );
    expect(() => normalizeOutputMode?.(modeWithHiddenSchema)).toThrow(
      UnsupportedSchemaError,
    );
    expect(() => normalizeOutputMode?.(modeWithHiddenMetadata)).toThrow(
      UnsupportedSchemaError,
    );
  });

  it("rejects output modes with extra executable or symbol fields", async () => {
    const { UnsupportedSchemaError, normalizeOutputMode } = await loadSchemaApi();
    const modeWithTransform = { kind: "text", transform: () => "draft" };
    const modeWithSymbol = { kind: "json" };

    Object.defineProperty(modeWithSymbol, Symbol("parser"), {
      value: () => ticketSchema,
      enumerable: true,
      configurable: true,
      writable: true,
    });

    expect(() => normalizeOutputMode?.(modeWithTransform)).toThrow(
      UnsupportedSchemaError,
    );
    expect(() => normalizeOutputMode?.(modeWithSymbol)).toThrow(
      UnsupportedSchemaError,
    );
  });

  it("ignores inherited output mode fields and metadata", async () => {
    const { UnsupportedSchemaError, normalizeOutputMode } = await loadSchemaApi();

    try {
      Object.defineProperties(Object.prototype, {
        kind: {
          value: "object",
          configurable: true,
          writable: true,
        },
        schema: {
          value: ticketSchema,
          configurable: true,
          writable: true,
        },
        name: {
          value: 42,
          configurable: true,
          writable: true,
        },
      });

      expect(() => normalizeOutputMode?.({})).toThrow(UnsupportedSchemaError);
      expect(normalizeOutputMode?.({ kind: "text" })).toEqual({ kind: "text" });
    } finally {
      delete (Object.prototype as unknown as Record<string, unknown>).kind;
      delete (Object.prototype as unknown as Record<string, unknown>).schema;
      delete (Object.prototype as unknown as Record<string, unknown>).name;
    }
  });

  it("rejects invalid output mode tags without falling back to aliases", async () => {
    const { UnsupportedSchemaError, normalizeOutputMode } = await loadSchemaApi();

    try {
      normalizeOutputMode?.({ kind: 123, type: "text" });
      throw new Error("normalizeOutputMode should have rejected invalid kind.");
    } catch (error) {
      expect(error).toBeInstanceOf(UnsupportedSchemaError);
      expect((error as Error & { cause?: { path?: string } }).cause?.path).toBe(
        "$.kind",
      );
    }

    try {
      normalizeOutputMode?.({ type: 123 });
      throw new Error("normalizeOutputMode should have rejected invalid type.");
    } catch (error) {
      expect(error).toBeInstanceOf(UnsupportedSchemaError);
      expect((error as Error & { cause?: { path?: string } }).cause?.path).toBe(
        "$.type",
      );
    }

    try {
      normalizeOutputMode?.({ kind: "text", type: 123 });
      throw new Error("normalizeOutputMode should have rejected invalid type alias.");
    } catch (error) {
      expect(error).toBeInstanceOf(UnsupportedSchemaError);
      expect((error as Error & { cause?: { path?: string } }).cause?.path).toBe(
        "$.type",
      );
    }

    try {
      normalizeOutputMode?.({ kind: "text", type: "object", schema: ticketSchema });
      throw new Error("normalizeOutputMode should have rejected conflicting tags.");
    } catch (error) {
      expect(error).toBeInstanceOf(UnsupportedSchemaError);
      expect((error as Error & { cause?: { path?: string } }).cause?.path).toBe(
        "$.type",
      );
    }
  });

  it("rejects ambiguous output mode aliases", async () => {
    const { UnsupportedSchemaError, normalizeOutputMode } = await loadSchemaApi();

    expect(() =>
      normalizeOutputMode?.({
        kind: "array",
        element: scoreSchema,
        schema: ticketSchema,
      }),
    ).toThrow(UnsupportedSchemaError);
    expect(() =>
      normalizeOutputMode?.({
        kind: "choice",
        values: ["low", "high"],
        options: ["low", "medium", "high"],
      }),
    ).toThrow(UnsupportedSchemaError);
    expect(() =>
      normalizeOutputMode?.({
        kind: "choice",
        options: ["low", "high"],
        enum: ["low", "medium", "high"],
      }),
    ).toThrow(UnsupportedSchemaError);
  });

  it("rejects cyclic schemas with UnsupportedSchemaError", async () => {
    const { UnsupportedSchemaError, normalizeSchema } = await loadSchemaApi();
    const cyclicSchema: Record<string, unknown> = { type: "object" };
    cyclicSchema.properties = cyclicSchema;

    expect(() => normalizeSchema?.(cyclicSchema)).toThrow(UnsupportedSchemaError);

    try {
      normalizeSchema?.(cyclicSchema);
      throw new Error("normalizeSchema should have rejected cyclic input.");
    } catch (error) {
      expect(error).toBeInstanceOf(UnsupportedSchemaError);
      expect((error as Error & { cause?: { path?: string } }).cause?.path).toBe(
        "$.properties",
      );
    }
  });

  it("rejects sparse arrays in schemas and choice output modes", async () => {
    const { UnsupportedSchemaError, normalizeOutputMode, normalizeSchema } =
      await loadSchemaApi();
    const sparseSchemaEnum = new Array<string>(1);
    const sparseChoices = new Array<string>(1);

    expect(() => normalizeSchema?.({ enum: sparseSchemaEnum })).toThrow(
      UnsupportedSchemaError,
    );
    expect(() =>
      normalizeOutputMode?.({ kind: "choice", values: sparseChoices }),
    ).toThrow(UnsupportedSchemaError);
  });

  it("rejects sparse arrays even when numeric values exist on the prototype", async () => {
    const { UnsupportedSchemaError, normalizeOutputMode, normalizeSchema } =
      await loadSchemaApi();
    const sparseSchemaEnum = new Array<string>(1);
    const sparseChoices = new Array<string>(1);
    const arrayPrototype = Object.create(Array.prototype);
    Object.defineProperty(arrayPrototype, "0", {
      value: "prototype-value",
      configurable: true,
      writable: true,
    });
    Object.setPrototypeOf(sparseSchemaEnum, arrayPrototype);
    Object.setPrototypeOf(sparseChoices, arrayPrototype);

    expect(() => normalizeSchema?.({ enum: sparseSchemaEnum })).toThrow(
      UnsupportedSchemaError,
    );
    expect(() =>
      normalizeOutputMode?.({ kind: "choice", values: sparseChoices }),
    ).toThrow(UnsupportedSchemaError);
  });

  it("keeps nested output-mode schema paths in UnsupportedSchemaError cause", async () => {
    const { UnsupportedSchemaError, normalizeOutputMode } = await loadSchemaApi();

    try {
      normalizeOutputMode?.({
        kind: "object",
        schema: { type: "object", parse: (input: unknown) => input },
      });
      throw new Error("normalizeOutputMode should have rejected executable schema input.");
    } catch (error) {
      expect(error).toBeInstanceOf(UnsupportedSchemaError);
      expect((error as Error & { cause?: { path?: string } }).cause?.path).toBe(
        "$.schema.parse",
      );
    }

    try {
      normalizeOutputMode?.({
        kind: "array",
        element: { type: "object", parse: (input: unknown) => input },
      });
      throw new Error("normalizeOutputMode should have rejected executable element input.");
    } catch (error) {
      expect(error).toBeInstanceOf(UnsupportedSchemaError);
      expect((error as Error & { cause?: { path?: string } }).cause?.path).toBe(
        "$.element.parse",
      );
    }

    try {
      normalizeOutputMode?.({
        kind: "array",
        schema: { type: "object", parse: (input: unknown) => input },
      });
      throw new Error("normalizeOutputMode should have rejected executable schema alias input.");
    } catch (error) {
      expect(error).toBeInstanceOf(UnsupportedSchemaError);
      expect((error as Error & { cause?: { path?: string } }).cause?.path).toBe(
        "$.schema.parse",
      );
    }
  });

  it("type-rejects arbitrary parser schemas in public output helpers", () => {
    if (false) {
      publicOutput.object({
        // @ts-expect-error output helper schemas must be JSON Schema, branded schemas, or Zod schemas.
        schema: { parse: (input: unknown) => input },
      });
      publicOutput.array({
        // @ts-expect-error output helper element schemas must be JSON Schema, branded schemas, or Zod schemas.
        element: { parse: (input: unknown) => input },
      });
      publicOutput.json({
        // @ts-expect-error output helper schemas must be JSON Schema, branded schemas, or Zod schemas.
        schema: { parse: (input: unknown) => input },
      });
    }
  });
});
