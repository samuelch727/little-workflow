import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getSchemaValidator,
  setSchemaCodeGenerationForTest,
  type SchemaValidator,
} from "./schema-validator.js";
import { validateAlphaJsonSchema } from "./lwir.js";

afterEach(() => {
  setSchemaCodeGenerationForTest(undefined);
  vi.unstubAllGlobals();
});

const valueCases: ReadonlyArray<{
  name: string;
  schema: unknown;
  accepted: readonly unknown[];
  rejected: readonly unknown[];
}> = [
  { name: "boolean schema", schema: true, accepted: [null, { arbitrary: [1] }], rejected: [] },
  { name: "reject-all schema", schema: false, accepted: [], rejected: [null, 1] },
  {
    name: "workflow input",
    schema: {
      type: "object", properties: { applicationId: { type: "string", minLength: 1 }, amount: { type: "integer", minimum: 1 } },
      required: ["applicationId", "amount"], additionalProperties: false,
    },
    accepted: [{ applicationId: "APP-1", amount: 5000 }],
    rejected: [{ applicationId: "APP-1" }, { applicationId: "", amount: 0 }, { applicationId: "APP-1", amount: 1, extra: true }],
  },
  {
    name: "step output array",
    schema: {
      type: "array", minItems: 1,
      items: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false },
    },
    accepted: [[{ ok: true }], [{ ok: true }, { ok: false }]],
    rejected: [[], [{ ok: "yes" }]],
  },
  {
    name: "draft-07 unique items",
    schema: { type: "array", uniqueItems: true, items: { type: "integer" } },
    accepted: [[1, 2]], rejected: [[1, 1]],
  },
  {
    name: "workflow map and propertyNames",
    schema: { type: "object", propertyNames: { type: "string", minLength: 1 }, additionalProperties: { type: "number", maximum: 10 } },
    accepted: [{ one: 1, two: 2 }, {}], rejected: [{ "": 1 }, { one: "bad" }, { one: 11 }],
  },
  {
    name: "nullable object union",
    schema: { anyOf: [{ type: "null" }, { type: "object", properties: { status: { enum: ["ready", "done"] } }, required: ["status"] }] },
    accepted: [null, { status: "ready" }], rejected: [[], { status: "unknown" }],
  },
  {
    name: "plan output union",
    schema: { anyOf: [{ type: "string" }, { type: "number", minimum: 0 }] },
    accepted: ["ready", 0], rejected: [null, -1, {}],
  },
  {
    name: "exclusive alternatives",
    schema: { oneOf: [{ type: "number" }, { type: "integer" }] },
    accepted: [1.5], rejected: [1, "1"],
  },
  {
    name: "allOf and not",
    schema: { allOf: [{ type: "integer", minimum: 0 }, { not: { const: 5 } }] },
    accepted: [0, 6], rejected: [-1, 5, "5"],
  },
  {
    name: "formats remain annotations, including nested format properties",
    schema: {
      type: "object", properties: {
        email: { type: "string", format: "email" },
        format: { type: "string", format: "date-time" },
      }, required: ["email", "format"], additionalProperties: false,
    },
    accepted: [{ email: "not an email", format: "not a date" }],
    rejected: [{ email: 123, format: "plain" }, { email: "plain" }],
  },
  {
    name: "format in literal schema data is preserved",
    schema: { enum: [{ format: "keep me" }] },
    accepted: [{ format: "keep me" }], rejected: [{}, { format: "different" }],
  },
  {
    name: "resolved draft-07 reference",
    schema: { definitions: { count: { type: "integer", minimum: 0 } }, $ref: "#/definitions/count" },
    accepted: [0, 1], rejected: [-1, "1"],
  },
];

function backend(available: boolean): SchemaValidator {
  setSchemaCodeGenerationForTest(available);
  return getSchemaValidator();
}

describe.each([["Ajv", true], ["interpreter", false]] as const)("schema validation with %s", (_name, available) => {
  for (const fixture of valueCases) {
    it(`preserves ${fixture.name} accept/reject results`, () => {
      const validator = backend(available);
      expect(validator.validateSchema(fixture.schema)).toBe(true);
      for (const value of fixture.accepted) expect(validator.validate(fixture.schema, value)).toBe(true);
      for (const value of fixture.rejected) expect(validator.validate(fixture.schema, value)).toBe(false);
    });
  }

  it("checks invalid schema shapes against draft-07", () => {
    const validator = backend(available);
    for (const schema of [{ type: "wrong-type" }, { type: "object", required: "name" }]) {
      expect(validator.validateSchema(schema)).toBe(false);
      expect(validator.errorsText(validator.errors)).toMatch(/data\/(type|required)/u);
      expect(() => validator.validate(schema, {})).toThrow(/schema is invalid/u);
    }
  });

  it("preserves the unresolved-reference phase boundary", () => {
    const validator = backend(available);
    const schema = { $ref: "#/definitions/missing" };
    // Meta-schema checking cannot resolve a reference, as with Ajv's existing contract.
    expect(validator.validateSchema(schema)).toBe(true);
    expect(() => validator.validate(schema, {})).toThrow(/ref|reference/iu);
  });

  it("reports every failing value path", () => {
    const validator = backend(available);
    expect(validator.validate({
      type: "object", properties: { score: { type: "number", minimum: 0 }, label: { type: "string" } },
    }, { score: -1, label: false })).toBe(false);
    expect(validator.errors?.map(error => error.instancePath)).toEqual(expect.arrayContaining(["/score", "/label"]));
    expect(validator.errorsText(validator.errors)).toContain("/score");
    expect(validator.errorsText(validator.errors)).toContain("/label");
  });

  it("accepts the runtime's supported map/input/output schema subset", () => {
    backend(available);
    for (const fixture of valueCases.filter(fixture => ["workflow input", "step output array", "workflow map and propertyNames", "plan output union"].includes(fixture.name))) {
      expect(validateAlphaJsonSchema(fixture.schema, "$.output")).toEqual([]);
    }
  });

  it("does not mutate or try to annotate frozen caller schemas", () => {
    const schema = Object.freeze({ type: "object", properties: Object.freeze({ format: Object.freeze({ type: "string", format: "email" }) }) });
    const original = JSON.stringify(schema);
    expect(backend(available).validate(schema, { format: "plain text" })).toBe(true);
    expect(JSON.stringify(schema)).toBe(original);
    expect(Reflect.ownKeys(schema.properties.format)).toEqual(["type", "format"]);
  });
});

it("keeps Node's Ajv messages unchanged", () => {
  const validator = backend(true);
  expect(validator.validate({ type: "object", properties: { score: { type: "number", minimum: 0 } } }, { score: -1 })).toBe(false);
  expect(validator.errorsText(validator.errors)).toBe("data/score must be >= 0");
});

it("probes once at first schema use and works when code generation is refused", async () => {
  vi.resetModules();
  const refused = vi.fn(() => { throw new EvalError("Code generation from strings disallowed"); });
  vi.stubGlobal("Function", refused);
  const fresh = await import("./schema-validator.js");
  expect(refused).not.toHaveBeenCalled();
  const validator = fresh.getSchemaValidator();
  expect(validator.validate({ type: "string" }, "yes")).toBe(true);
  expect(validator.validate({ type: "number" }, "no")).toBe(false);
  expect(fresh.getSchemaValidator()).toBe(validator);
  expect(refused.mock.calls).toEqual([["return true"]]);
});
