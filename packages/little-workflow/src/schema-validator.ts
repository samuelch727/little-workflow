import AjvModule from "ajv";
import draft07 from "ajv/lib/refs/json-schema-draft-07.json" with { type: "json" };
import { Validator, type OutputUnit, type Schema } from "@cfworker/json-schema";

export type SchemaValidationError = {
  readonly instancePath?: string;
  readonly schemaPath?: string;
  readonly message?: string;
};

/** The synchronous surface already used by the compiler, LWIR and runtime. */
export type SchemaValidator = {
  validate(schema: unknown, value: unknown): boolean | Promise<unknown>;
  validateSchema(schema: unknown): boolean | Promise<unknown>;
  readonly errors?: readonly SchemaValidationError[] | null;
  errorsText(errors?: readonly SchemaValidationError[] | null): string;
};

let codeGenerationAvailable: boolean | undefined;
let codeGenerationForTest: boolean | undefined;
let nodeValidator: SchemaValidator | undefined;
let interpretedValidator: SchemaValidator | undefined;

/** Internal test hook: exercise the same interpreter that a restricted runtime selects. */
export function setSchemaCodeGenerationForTest(available: boolean | undefined): void {
  codeGenerationForTest = available;
}

function canGenerateCode(): boolean {
  if (codeGenerationAvailable === undefined) {
    try {
      // The sole capability probe allowed by the workerd plan. Never runs at module load.
      new Function("return true");
      codeGenerationAvailable = true;
    } catch {
      codeGenerationAvailable = false;
    }
  }
  return codeGenerationAvailable;
}

export function getSchemaValidator(): SchemaValidator {
  if (codeGenerationForTest ?? canGenerateCode()) {
    if (nodeValidator === undefined) {
      type Constructor = new (options: Record<string, unknown>) => SchemaValidator;
      const imported = AjvModule as unknown as Constructor | { readonly default?: Constructor };
      const Ajv = typeof imported === "function" ? imported : imported.default;
      if (Ajv === undefined) throw new TypeError("Ajv default export is unavailable.");
      // Keep the exact Node options and return Ajv itself, including its errors/messages.
      nodeValidator = new Ajv({ allErrors: true, strict: false, validateSchema: true });
    }
    return nodeValidator;
  }
  return interpretedValidator ??= new InterpretedSchemaValidator();
}

class InterpretedSchemaValidator implements SchemaValidator {
  errors: readonly SchemaValidationError[] | null = null;
  private readonly meta = new Validator(withoutFormats(draft07), "7", false);
  private readonly validators = new WeakMap<object, Validator>();

  validateSchema(schema: unknown): boolean {
    const result = this.meta.validate(schema);
    this.errors = result.valid ? null : result.errors.map(errorForAjvSurface);
    return result.valid;
  }

  validate(schema: unknown, value: unknown): boolean {
    if (!this.validateSchema(schema)) {
      throw new Error(`schema is invalid: ${this.errorsText(this.errors)}`);
    }
    let validator = typeof schema === "object" && schema !== null
      ? this.validators.get(schema)
      : undefined;
    if (validator === undefined) {
      validator = new Validator(withoutFormats(schema), "7", false);
      if (typeof schema === "object" && schema !== null) this.validators.set(schema, validator);
    }
    const result = validator.validate(value);
    this.errors = result.valid ? null : result.errors.map(errorForAjvSurface);
    return result.valid;
  }

  errorsText(errors: readonly SchemaValidationError[] | null | undefined = this.errors): string {
    if (errors === null || errors === undefined || errors.length === 0) return "No errors";
    return errors.map(error => `data${error.instancePath ?? ""} ${error.message ?? "schema validation failed"}`).join(", ");
  }
}

function errorForAjvSurface(error: OutputUnit): SchemaValidationError {
  return {
    instancePath: error.instanceLocation === "#" ? "" : error.instanceLocation.replace(/^#/u, ""),
    schemaPath: error.keywordLocation,
    message: error.error,
  };
}

const schemaMaps = new Set(["$defs", "definitions", "properties", "patternProperties", "dependentSchemas"]);
const schemaArrays = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
const schemaValues = new Set([
  "additionalItems", "unevaluatedItems", "contains", "additionalProperties", "unevaluatedProperties",
  "propertyNames", "not", "if", "then", "else", "contentSchema",
]);

/** Clone because cfworker annotates schemas. Only schema keywords lose format, never data keys. */
function withoutFormats(schema: unknown): Schema | boolean {
  if (typeof schema === "boolean") return schema;
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
    // Validation of the draft-07 meta-schema rejects these before constructing a value validator.
    return schema as Schema;
  }
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "format") continue;
    if (schemaMaps.has(key) && isRecord(value)) {
      copy[key] = Object.fromEntries(Object.entries(value).map(([name, child]) => [name, withoutFormats(child)]));
    } else if (schemaArrays.has(key) && Array.isArray(value)) {
      copy[key] = value.map(withoutFormats);
    } else if (key === "items") {
      copy[key] = Array.isArray(value) ? value.map(withoutFormats) : withoutFormats(value);
    } else if (key === "dependencies" && isRecord(value)) {
      copy[key] = Object.fromEntries(Object.entries(value).map(([name, child]) => [
        name, Array.isArray(child) ? structuredClone(child) : withoutFormats(child),
      ]));
    } else if (schemaValues.has(key)) {
      copy[key] = withoutFormats(value);
    } else {
      copy[key] = structuredClone(value);
    }
  }
  return copy as Schema;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
