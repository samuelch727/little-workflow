import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { sha256Digest } from "./canonical.js";
import { normalizeSchema } from "./schema.js";
import {
  LwirValidationError,
  UNIMPLEMENTED_FIELD_CODE,
  assertValidLwir,
  registerWorkflowVersion,
  validateLwir,
} from "./lwir.js";

const ticketSchema = {
  type: "object",
  required: ["ticketId", "transcript"],
  additionalProperties: false,
  properties: {
    ticketId: { type: "string" },
    transcript: { type: "string" },
  },
};

const summarySchema = {
  type: "object",
  required: ["summary", "severity"],
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
    severity: { type: "string", enum: ["low", "medium", "high"] },
  },
};

function workflow(overrides: Record<string, unknown> = {}) {
  return {
    apiVersion: "littleworkflow.dev/v0.1",
    kind: "Workflow",
    metadata: {
      name: "support.summarize-ticket",
      version: "0.1.0-alpha",
      description: "Summarize and classify a support ticket.",
    },
    input: { schema: ticketSchema },
    output: { schema: summarySchema },
    permissions: {
      models: ["model.structured", "model.text", "model.fast"],
      tools: ["lookupCustomer"],
      secrets: [],
      network: [],
    },
    steps: [
      {
        id: "lookup-customer",
        uses: "tool.call",
        with: {
          tool: "lookupCustomer",
          args: { accountId: "{{ input.ticketId }}" },
        },
        output: { mode: "json", schema: true },
      },
      {
        id: "summarize",
        uses: "ai.generate",
        needs: ["lookup-customer"],
        with: {
          model: "model.structured",
          prompt:
            "Summarize {{ input.transcript }} for {{ steps.lookup-customer.output.plan }}.",
        },
        output: { mode: "object", schema: summarySchema },
      },
    ],
    ...overrides,
  };
}

function codeFile(content = "export function run() { return { valid: true }; }") {
  return {
    sha256: `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`,
    content,
  };
}

describe("alpha LWIR validation", () => {
  it("accepts a valid workflow and registers a stable workflow version hash", () => {
    const lwir = workflow();

    expect(validateLwir(lwir)).toEqual({ valid: true, findings: [] });

    const version = registerWorkflowVersion(lwir);
    expect(version.id).toMatch(/^wfver_[0-9a-f]{16}$/);
    expect(version.hash).toBe(sha256Digest(lwir));
    expect(version.canonicalizer).toBe("little-workflow-canonical-json@alpha");
    expect(registerWorkflowVersion({ ...workflow(), steps: lwir.steps }).hash).toBe(
      version.hash,
    );
  });

  it("accepts renamed step types and rejects legacy aliases", () => {
    const codeContent =
      "export async function run({ input }) { return { summary: input.transcript, severity: 'low' }; }";

    const acceptsRenamedTool = validateLwir(
      workflow({
        steps: [
          {
            id: "lookup-customer",
            uses: "tool.call",
            with: {
              tool: "lookupCustomer",
              args: { accountId: "{{ input.ticketId }}" },
            },
            output: { mode: "json", schema: true },
          },
          {
            id: "summarize",
            uses: "ai.generate",
            needs: ["lookup-customer"],
            with: {
              model: "model.structured",
              prompt:
                "Summarize {{ input.transcript }} for {{ steps.lookup-customer.output.plan }}.",
            },
            output: { mode: "object", schema: summarySchema },
          },
        ],
      }),
    );
    expect(acceptsRenamedTool).toEqual({ valid: true, findings: [] });

    const acceptsRenamedCode = validateLwir(
      workflow({
        steps: [
          {
            id: "compute-summary",
            uses: "code.run",
            with: {
              entrypoint: "index.ts",
              files: {
                "index.ts": codeFile(codeContent),
              },
              sandbox: {
                network: "deny",
                env: "deny",
                fs: "deny",
              },
            },
            output: { mode: "object", schema: summarySchema },
          },
        ],
      }),
    );
    expect(acceptsRenamedCode).toEqual({ valid: true, findings: [] });

    const rejectsLegacyTool = validateLwir(
      workflow({
        steps: [
          {
            id: "lookup-customer",
            uses: "tool",
            with: {
              tool: "lookupCustomer",
              args: { accountId: "{{ input.ticketId }}" },
            },
            output: { mode: "json", schema: true },
          },
        ],
      }),
    );
    expect(rejectsLegacyTool.valid).toBe(false);
    expect(rejectsLegacyTool.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "step.invalid_type",
          path: "$.steps[0].uses",
        }),
      ]),
    );

    const rejectsLegacyCode = validateLwir(
      workflow({
        steps: [
          {
            id: "compute-summary",
            uses: "code.ts",
            with: {
              entrypoint: "index.ts",
              files: {
                "index.ts": codeFile(codeContent),
              },
              sandbox: {
                network: "deny",
                env: "deny",
                fs: "deny",
              },
            },
            output: { mode: "object", schema: summarySchema },
          },
        ],
      }),
    );
    expect(rejectsLegacyCode.valid).toBe(false);
    expect(rejectsLegacyCode.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "step.invalid_type",
          path: "$.steps[0].uses",
        }),
      ]),
    );
  });

  it("returns compact schema findings for invalid top-level shape", () => {
    const result = validateLwir({
      apiVersion: "littleworkflow.dev/v0.1",
      kind: "Workflow",
      metadata: { name: "broken" },
      input: {},
      output: { schema: true },
      steps: "not an array",
    });

    expect(result.valid).toBe(false);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "schema.invalid",
          path: "$.input",
          severity: "error",
        }),
        expect.objectContaining({
          code: "schema.invalid",
          path: "$.steps",
          severity: "error",
        }),
      ]),
    );
  });

  it("rejects duplicate step IDs, missing dependencies, and cycles", () => {
    const result = validateLwir(
      workflow({
        steps: [
          { id: "a", uses: "tool.call", needs: ["c"], output: { mode: "json" } },
          { id: "a", uses: "tool.call", output: { mode: "json" } },
          { id: "b", uses: "tool.call", needs: ["missing"], output: { mode: "json" } },
          { id: "c", uses: "tool.call", needs: ["a"], output: { mode: "json" } },
        ],
      }),
    );

    expect(result.valid).toBe(false);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "step.duplicate_id", path: "$.steps[1].id" }),
        expect.objectContaining({
          code: "step.missing_dependency",
          path: "$.steps[2].needs[0]",
        }),
        expect.objectContaining({ code: "lwir.invalid_cycle", path: "$.steps" }),
      ]),
    );
  });

  it("rejects unsafe or malformed template expressions", () => {
    const result = validateLwir(
      workflow({
        steps: [
          {
            id: "unsafe",
            uses: "ai.generate",
            with: {
              prompt: "{{ input.transcript; process.exit(1) }}",
            },
            output: { mode: "text" },
          },
        ],
      }),
    );

    expect(result.valid).toBe(false);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "expression.invalid",
          path: "$.steps[0].with.prompt",
        }),
      ]),
    );
  });

  it("rejects JavaScript-like method calls and malformed function expressions", () => {
    const result = validateLwir(
      workflow({
        steps: [
          {
            id: "method-call",
            uses: "ai.generate",
            with: {
              model: "model.text",
              prompt: "{{ input.profile.toString() }}",
            },
            output: { mode: "text" },
          },
          {
            id: "empty-hash",
            uses: "ai.generate",
            with: {
              model: "model.text",
              prompt: "{{ sha256() }}",
            },
            output: { mode: "text" },
          },
          {
            id: "short-coalesce",
            uses: "ai.generate",
            with: {
              model: "model.text",
              prompt: "{{ coalesce(input.name) }}",
            },
            output: { mode: "text" },
          },
        ],
      }),
    );

    expect(result.valid).toBe(false);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "expression.invalid",
          path: "$.steps[0].with.prompt",
        }),
        expect.objectContaining({
          code: "expression.invalid",
          path: "$.steps[1].with.prompt",
        }),
        expect.objectContaining({
          code: "expression.invalid",
          path: "$.steps[2].with.prompt",
        }),
      ]),
    );
  });

  it("accepts the documented expression subset across with and input fields", () => {
    const result = validateLwir(
      workflow({
        steps: [
          {
            id: "extract",
            uses: "tool.call",
            with: {
              tool: "lookupCustomer",
              args: { accountId: "{{ input.ticketId }}" },
            },
            output: { mode: "json", schema: true },
          },
          {
            id: "summarize",
            uses: "ai.generate",
            needs: ["extract"],
            with: {
              model: "model.text",
              prompt:
                "Score {{ steps.extract.output.score >= 80 }} for {{ coalesce(steps.extract.output.name, \"unknown\") }}.",
            },
            input: {
              stableId: "{{ sha256(input.ticketId, steps.extract.output.name) }}",
            },
            output: { mode: "text" },
          },
        ],
      }),
    );

    expect(result).toEqual({ valid: true, findings: [] });
  });

  it("validates expressions in step input fields", () => {
    const result = validateLwir(
      workflow({
        steps: [
          {
            id: "bad-input",
            uses: "ai.generate",
            with: {
              model: "model.text",
              prompt: "Draft a reply.",
            },
            input: {
              value: "{{ input.ticketId.constructor }}",
            },
            output: { mode: "text" },
          },
        ],
      }),
    );

    expect(result.valid).toBe(false);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "expression.invalid",
          path: "$.steps[0].input.value",
        }),
      ]),
    );
  });

  it("rejects item expressions outside parallel branch item contexts", () => {
    const result = validateLwir(
      workflow({
        steps: [
          {
            id: "summarize",
            uses: "ai.generate",
            with: {
              model: "model.text",
              prompt: "Score {{ item.candidateId }} {{ item == null }}.",
            },
            output: { mode: "text" },
          },
          {
            id: "fallback",
            uses: "ai.generate",
            with: {
              model: "model.text",
              prompt: "{{ coalesce(item, input.fallback) }}",
            },
            output: { mode: "text" },
          },
        ],
      }),
    );

    expect(result.valid).toBe(false);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "expression.invalid",
          path: "$.steps[0].with.prompt",
        }),
        expect.objectContaining({
          code: "expression.invalid",
          path: "$.steps[1].with.prompt",
        }),
      ]),
    );
  });

  it("rejects numeric steps indexes because runtime step references use ids", () => {
    const result = validateLwir(
      workflow({
        steps: [
          {
            id: "load",
            uses: "tool.call",
            with: { tool: "lookupCustomer" },
            output: { mode: "object", schema: { type: "object" } },
          },
          {
            id: "summarize",
            uses: "ai.generate",
            needs: ["load"],
            with: {
              model: "model.text",
              prompt: "Summarize {{ steps[0].output.plan }}.",
            },
            output: { mode: "text" },
          },
        ],
      }),
    );

    expect(result.valid).toBe(false);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "expression.invalid",
          path: "$.steps[1].with.prompt",
        }),
      ]),
    );
  });

  it("rejects unsupported output modes and missing schema evidence", () => {
    const result = validateLwir(
      workflow({
        steps: [
          { id: "xml", uses: "ai.generate", output: { mode: "xml" } },
          { id: "object", uses: "ai.generate", output: { mode: "object" } },
          { id: "array", uses: "ai.generate", output: { mode: "array" } },
          { id: "choice", uses: "ai.generate", output: { mode: "choice" } },
        ],
      }),
    );

    expect(result.valid).toBe(false);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "output.invalid", path: "$.steps[0].output" }),
        expect.objectContaining({
          code: "output.missing_schema",
          path: "$.steps[1].output.schema",
        }),
        expect.objectContaining({
          code: "output.missing_schema",
          path: "$.steps[2].output.schema",
        }),
        expect.objectContaining({
          code: "output.missing_values",
          path: "$.steps[3].output.values",
        }),
      ]),
    );
  });

  it("rejects invalid output metadata before adapter mapping", () => {
    const result = validateLwir(
      workflow({
        steps: [
          {
            id: "bad-metadata",
            uses: "ai.generate",
            with: { model: "model.text", prompt: "Draft." },
            output: {
              mode: "json",
              name: 123,
              description: false,
            },
          },
        ],
      }),
    );

    expect(result.valid).toBe(false);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "output.invalid_metadata",
          path: "$.steps[0].output.name",
        }),
        expect.objectContaining({
          code: "output.invalid_metadata",
          path: "$.steps[0].output.description",
        }),
      ]),
    );
  });

  it("accepts documented ai.generate output modes", () => {
    expect(
      validateLwir(
        workflow({
          steps: [
            {
              id: "generate-object",
              uses: "ai.generate",
              with: { model: "model.text" },
              output: { mode: "object", schema: summarySchema },
            },
            {
              id: "generate-array",
              uses: "ai.generate",
              needs: ["generate-object"],
              with: { model: "model.text" },
              output: {
                mode: "array",
                schema: { type: "array", items: { type: "string" } },
              },
            },
          {
            id: "generate-choice",
            uses: "ai.generate",
            needs: ["generate-array"],
            with: { model: "model.text" },
            output: { mode: "choice", values: ["approve", "reject"] },
          },
          {
            id: "generate-text",
            uses: "ai.generate",
            needs: ["generate-choice"],
            with: { model: "model.text" },
            output: { mode: "text" },
          },
        ],
      }),
    ),
    ).toEqual({ valid: true, findings: [] });
  });

  it("rejects malformed JSON Schema subset values", () => {
    const result = validateLwir(
      workflow({
        input: { schema: { type: "wat" } },
        steps: [
          {
            id: "bad-schema",
            uses: "ai.generate",
            with: { model: "model.structured" },
            output: {
              mode: "object",
              schema: {
                type: "object",
                required: ["name"],
                properties: [],
              },
            },
          },
        ],
      }),
    );

    expect(result.valid).toBe(false);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "schema.invalid", path: "$.input.schema" }),
        expect.objectContaining({
          code: "schema.invalid",
          path: "$.steps[0].output.schema",
        }),
      ]),
    );
  });

  it("rejects unsupported schema formats, loose unions, and inconsistent bounds", () => {
    const result = validateLwir(
      workflow({
        input: { schema: { type: "string", format: "email" } },
        output: {
          schema: {
            oneOf: [
              { type: "object", properties: { a: { type: "string" } } },
              { type: "object", properties: { b: { type: "string" } } },
            ],
          },
        },
        steps: [
          {
            id: "bad-bounds",
            uses: "ai.generate",
            with: { model: "model.structured" },
            output: {
              mode: "object",
              schema: {
                type: "object",
                required: ["missing"],
                properties: {
                  value: { type: "string", minLength: 5, maxLength: 2 },
                },
              },
            },
          },
        ],
      }),
    );

    expect(result.valid).toBe(false);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "schema.invalid", path: "$.input.schema" }),
        expect.objectContaining({ code: "schema.invalid", path: "$.output.schema" }),
        expect.objectContaining({
          code: "schema.invalid",
          path: "$.steps[0].output.schema",
        }),
      ]),
    );
  });

  it("rejects required schemas without matching properties and unsupported type-array unions", () => {
    const result = validateLwir(
      workflow({
        input: {
          schema: {
            type: "object",
            required: ["ticketId"],
          },
        },
        output: {
          schema: {
            type: ["object", "string"],
          },
        },
        steps: [
          {
            id: "summarize",
            uses: "ai.generate",
            with: { model: "model.text", prompt: "Draft a summary." },
            output: { mode: "text" },
          },
        ],
      }),
    );

    expect(result.valid).toBe(false);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "schema.invalid", path: "$.input.schema" }),
        expect.objectContaining({ code: "schema.invalid", path: "$.output.schema" }),
      ]),
    );
  });

  it("accepts pure-annotation schema keywords in every nested schema position", () => {
    // `zod`'s `.describe()` emits `description`, and `.meta({ title, examples })` emits the
    // other two. Rejecting them made every described schema fail at registration, which is
    // the whole of LIT-43. Annotations constrain nothing, so they are legal wherever a
    // schema is — including the recursion paths with their own shape logic (`items`,
    // `additionalProperties`, and `anyOf` branches, which must still discriminate).
    const annotated = {
      type: "object",
      title: "Ticket",
      description: "A support ticket.",
      required: ["ticketId", "tags", "route"],
      additionalProperties: false,
      properties: {
        ticketId: {
          type: "string",
          description: "The upstream ticket identifier.",
          title: "Ticket id",
          examples: ["TIN-13"],
        },
        tags: {
          type: "array",
          description: "Free-form labels.",
          items: { type: "string", description: "One label." },
        },
        route: {
          anyOf: [
            {
              type: "object",
              description: "Escalate to a human.",
              required: ["kind", "assignee"],
              properties: {
                kind: { type: "string", const: "human", description: "Discriminator." },
                assignee: { type: "string", description: "Who picks it up." },
              },
            },
            {
              type: "object",
              description: "Answer automatically.",
              required: ["kind", "reply"],
              properties: {
                kind: { type: "string", const: "auto", description: "Discriminator." },
                reply: { type: "string", description: "What to send." },
              },
            },
          ],
        },
      },
    };
    const bag = {
      type: "object",
      description: "An open-ended bag.",
      additionalProperties: { type: "string", description: "Any extra value." },
    };

    const lwir = workflow({
      input: { schema: annotated },
      output: { schema: bag },
      steps: [
        {
          id: "summarize",
          uses: "ai.generate",
          with: { model: "model.structured", prompt: "Summarize {{ input.ticketId }}." },
          output: { mode: "object", schema: bag },
        },
      ],
    });

    expect(validateLwir(lwir)).toEqual({ valid: true, findings: [] });
    // registerWorkflowVersion is the only way to mint a WorkflowVersion, so this is the
    // gate every execution path goes through.
    expect(registerWorkflowVersion(lwir).id).toMatch(/^wfver_[0-9a-f]{16}$/);
  });

  it("rejects schema keywords that assert unimplemented runtime behaviour", () => {
    // The other side of the annotation boundary: `default` promises value substitution and
    // `readOnly`/`deprecated` promise access/lifecycle enforcement. No Ajv instance here is
    // built with `useDefaults` and nothing enforces access, so accepting them would be a
    // declaration the runtime silently drops.
    for (const [keyword, value] of [
      ["default", "unset"],
      ["readOnly", true],
      ["writeOnly", true],
      ["deprecated", true],
    ] as const) {
      const result = validateLwir(
        workflow({
          input: {
            schema: {
              type: "object",
              required: ["ticketId"],
              properties: { ticketId: { type: "string", [keyword]: value } },
            },
          },
        }),
      );

      expect(result.valid).toBe(false);
      expect(result.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "schema.invalid",
            path: "$.input.schema",
            message: `Unsupported JSON Schema keyword '${keyword}' in alpha LWIR.`,
          }),
        ]),
      );
    }
  });

  it("still rejects annotation keywords whose value has the wrong JSON Schema type", () => {
    const result = validateLwir(
      workflow({
        input: {
          schema: {
            type: "object",
            required: ["ticketId"],
            properties: { ticketId: { type: "string", description: 42 } },
          },
        },
      }),
    );

    expect(result.valid).toBe(false);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "schema.invalid", path: "$.input.schema" }),
      ]),
    );
  });

  it("accepts the propertyNames map shape zod emits for z.record(), in every nested position", () => {
    // Derived from zod rather than hand-copied: the fixture is what the installed zod
    // ACTUALLY emits today, so it cannot drift away from the construct it stands for.
    // Before LIT-53 each of these failed with "Unsupported JSON Schema keyword
    // 'propertyNames' in alpha LWIR" — the dreamer's config-ab workflow had to ship
    // `z.looseObject` to get a map-shaped input past compile time at all.
    const stringKeyed = normalizeSchema(z.record(z.string(), z.string()));
    expect(stringKeyed).toEqual({
      type: "object",
      propertyNames: { type: "string" },
      additionalProperties: { type: "string" },
    });

    // The dreamer's shape: a record nested under a named property, values themselves
    // objects, plus `.describe()` on the map (LIT-43's annotations, on this keyword).
    const dreamerConfig = normalizeSchema(
      z.object({
        variants: z
          .record(
            z.string(),
            z.object({ prompt: z.string(), temperature: z.number() }),
          )
          .describe("Config bundles keyed by version id."),
      }),
    );
    expect(dreamerConfig).toMatchObject({
      properties: {
        variants: {
          type: "object",
          propertyNames: { type: "string" },
          description: "Config bundles keyed by version id.",
        },
      },
    });

    const lwir = workflow({
      input: { schema: dreamerConfig },
      output: { schema: stringKeyed },
      steps: [
        {
          id: "summarize",
          uses: "ai.generate",
          with: { model: "model.structured", prompt: "Compare the variants." },
          // A record in a step's own output contract, and one nested inside an array's
          // items — the recursion paths with their own shape logic.
          output: {
            mode: "object",
            schema: {
              type: "object",
              required: ["labels"],
              properties: {
                labels: { type: "array", items: stringKeyed },
              },
            },
          },
        },
      ],
    });

    expect(validateLwir(lwir)).toEqual({ valid: true, findings: [] });
    // registerWorkflowVersion is the only way to mint a WorkflowVersion, so this is the
    // gate every execution path goes through.
    expect(registerWorkflowVersion(lwir).id).toMatch(/^wfver_[0-9a-f]{16}$/);
  });

  it("accepts the key-constrained record forms whose key schema stays inside the subset", () => {
    // Enum keys carry a `required` listing every key and NO `properties` object — zod's
    // exhaustive-record semantics. Ajv enforces that `required` on its own, which is why
    // the map-shape carve-out is honest rather than a hole. `z.partialRecord` is the same
    // shape without `required`, and `.min(1)` keys land on `minLength`, already supported.
    const exhaustive = normalizeSchema(z.record(z.enum(["fast", "cheap"]), z.number()));
    expect(exhaustive).toEqual({
      type: "object",
      propertyNames: { type: "string", enum: ["fast", "cheap"] },
      additionalProperties: { type: "number" },
      required: ["fast", "cheap"],
    });

    for (const schema of [
      exhaustive,
      normalizeSchema(z.partialRecord(z.enum(["fast", "cheap"]), z.number())),
      normalizeSchema(z.record(z.string().min(1), z.string())),
    ]) {
      const lwir = workflow({ input: { schema } });
      expect(validateLwir(lwir)).toEqual({ valid: true, findings: [] });
      expect(registerWorkflowVersion(lwir).id).toMatch(/^wfver_[0-9a-f]{16}$/);
    }
  });

  it("rejects key schemas outside the subset, and keeps the required rule for non-map objects", () => {
    // The boundary, both ways. `pattern` is out of the subset wherever it appears, so a
    // regex-keyed record is rejected with the standard message — the key schema recurses
    // through the same validator as everything else and gets no exemption.
    const regexKeyed = normalizeSchema(z.record(z.string().regex(/^cfg_/u), z.string()));
    expect(regexKeyed).toMatchObject({ propertyNames: { pattern: "^cfg_" } });

    const rejectedKeys = validateLwir(workflow({ input: { schema: regexKeyed } }));
    expect(rejectedKeys.valid).toBe(false);
    expect(rejectedKeys.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "schema.invalid",
          path: "$.input.schema",
          message: "Unsupported JSON Schema keyword 'pattern' in alpha LWIR.",
        }),
      ]),
    );

    // A number-keyed record passes the subset walk but could never accept data: JSON keys
    // are strings, so Ajv would reject every non-empty instance at run time. Reject it here.
    const numberKeyed = normalizeSchema(z.record(z.number(), z.string()));
    const rejectedNumberKeys = validateLwir(workflow({ input: { schema: numberKeyed } }));
    expect(rejectedNumberKeys.valid).toBe(false);
    expect(rejectedNumberKeys.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "schema.invalid",
          path: "$.input.schema",
          message: expect.stringContaining("JSON object keys are strings"),
        }),
      ]),
    );

    // A `propertyNames` that is not a schema at all is rejected too — here by the Ajv
    // meta-schema check that runs before the subset walk, so the message is Ajv's.
    const notASchema = validateLwir(
      workflow({ input: { schema: { type: "object", propertyNames: "string" } } }),
    );
    expect(notASchema.valid).toBe(false);
    expect(notASchema.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "schema.invalid",
          path: "$.input.schema",
          message: expect.stringContaining("propertyNames"),
        }),
      ]),
    );

    // And the carve-out really is scoped to map shapes: `required` with neither
    // `properties` nor `propertyNames` still fails with the message it always did.
    const bareRequired = validateLwir(
      workflow({ input: { schema: { type: "object", required: ["ticketId"] } } }),
    );
    expect(bareRequired.valid).toBe(false);
    expect(bareRequired.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "schema.invalid",
          path: "$.input.schema",
          message: "JSON Schema required keys must have a matching properties object.",
        }),
      ]),
    );
  });

  it("requires tool permissions, AI model slots, and constrained code.run config", () => {
    const result = validateLwir(
      workflow({
        steps: [
          {
            id: "missing-tool",
            uses: "tool.call",
            with: {},
            output: { mode: "json", schema: true },
          },
          {
            id: "disallowed-tool",
            uses: "tool.call",
            with: { tool: "sendEmail" },
            output: { mode: "json", schema: true },
          },
          {
            id: "missing-model",
            uses: "ai.generate",
            with: { prompt: "Summarize." },
            output: { mode: "object", schema: summarySchema },
          },
          {
            id: "disallowed-model",
            uses: "ai.generate",
            with: { model: "worker.unregistered", prompt: "Draft." },
            output: { mode: "text" },
          },
          {
            id: "unsafe-code",
            uses: "code.run",
            with: {
              entrypoint: "main.ts",
              sandbox: {
                network: "allow",
              },
              files: {
                "main.ts": {
                  sha256: "sha256:abc",
                  content: "export function run() { return {}; }",
                },
              },
            },
            output: { mode: "object", schema: summarySchema },
          },
        ],
      }),
    );

    expect(result.valid).toBe(false);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "tool.missing",
          path: "$.steps[0].with.tool",
        }),
        expect.objectContaining({
          code: "tool.disallowed",
          path: "$.steps[1].with.tool",
        }),
        expect.objectContaining({
          code: "model.missing",
          path: "$.steps[2].with.model",
        }),
        expect.objectContaining({
          code: "model.disallowed",
          path: "$.steps[3].with.model",
        }),
        expect.objectContaining({
          code: "code.invalid_sandbox",
          path: "$.steps[4].with.sandbox.network",
        }),
      ]),
    );
  });

  it("requires code.run source hashes, safe paths, entrypoint membership, and sandbox policy", () => {
    const result = validateLwir(
      workflow({
        steps: [
          {
            id: "unsafe-code",
            uses: "code.run",
            with: {
              entrypoint: "../main.ts",
              files: {
                "../main.ts": codeFile(),
                "worker.ts": {
                  sha256: codeFile("export const value = 1;").sha256,
                  content: "export const value = 2;",
                },
              },
            },
            output: { mode: "object", schema: summarySchema },
          },
        ],
      }),
    );

    expect(result.valid).toBe(false);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "code.invalid_entrypoint",
          path: "$.steps[0].with.entrypoint",
        }),
        expect.objectContaining({
          code: "code.invalid_file_path",
          path: "$.steps[0].with.files[\"../main.ts\"]",
        }),
        expect.objectContaining({
          code: "code.invalid_file_hash",
          path: "$.steps[0].with.files[\"worker.ts\"].sha256",
        }),
        expect.objectContaining({
          code: "code.missing_sandbox",
          path: "$.steps[0].with.sandbox",
        }),
      ]),
    );
  });

  it("accepts constrained code.run steps with pinned source and denied sandbox", () => {
    const result = validateLwir(
      workflow({
        steps: [
          {
            id: "validate-summary",
            uses: "code.run",
            with: {
              entrypoint: "main.ts",
              sandbox: { network: "deny" },
              files: {
                "main.ts": codeFile(),
              },
            },
            output: { mode: "object", schema: summarySchema },
          },
        ],
      }),
    );

    expect(result).toEqual({ valid: true, findings: [] });
  });

  it("accepts onFailure.fixer on code step with known model", () => {
    const result = validateLwir(
      workflow({
        steps: [
          {
            id: "validate-summary",
            uses: "code.run",
            with: {
              entrypoint: "main.ts",
              sandbox: { network: "deny" },
              files: {
                "main.ts": codeFile(),
              },
            },
            onFailure: {
              fixer: {
                model: "model.fast",
                maxAttempts: 3,
                system: "Fix the code to satisfy the output schema.",
              },
            },
            output: { mode: "object", schema: summarySchema },
          },
        ],
      }),
    );

    expect(result).toEqual({ valid: true, findings: [] });
  });

  it("rejects fixer on non-code steps", () => {
    const result = validateLwir(
      workflow({
        steps: [
          {
            id: "lookup",
            uses: "tool.call",
            with: { tool: "lookupCustomer" },
            onFailure: {
              fixer: {
                model: "model.fast",
                maxAttempts: 1,
                system: "Fix.",
              },
            },
            output: { mode: "json", schema: true },
          },
        ],
      }),
    );

    expect(result.valid).toBe(false);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "fixer.unsupported_step",
          path: "$.steps[0].onFailure.fixer",
        }),
      ]),
    );
  });

  it("rejects unknown fixer model slot", () => {
    const result = validateLwir(
      workflow({
        steps: [
          {
            id: "validate-summary",
            uses: "code.run",
            with: {
              entrypoint: "main.ts",
              sandbox: { network: "deny" },
              files: {
                "main.ts": codeFile(),
              },
            },
            onFailure: {
              fixer: {
                model: "model.unknown",
                maxAttempts: 2,
                system: "Fix.",
              },
            },
            output: { mode: "object", schema: summarySchema },
          },
        ],
      }),
    );

    expect(result.valid).toBe(false);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "fixer.model.disallowed",
          path: "$.steps[0].onFailure.fixer.model",
        }),
      ]),
    );
  });

  it("rejects non-positive fixer maxAttempts", () => {
    const result = validateLwir(
      workflow({
        steps: [
          {
            id: "validate-summary",
            uses: "code.run",
            with: {
              entrypoint: "main.ts",
              sandbox: { network: "deny" },
              files: {
                "main.ts": codeFile(),
              },
            },
            onFailure: {
              fixer: {
                model: "model.fast",
                maxAttempts: 0,
                system: "Fix.",
              },
            },
            output: { mode: "object", schema: summarySchema },
          },
        ],
      }),
    );

    expect(result.valid).toBe(false);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "fixer.max_attempts_invalid",
          path: "$.steps[0].onFailure.fixer.maxAttempts",
        }),
      ]),
    );
  });

  it("rejects code.run sandbox environment and filesystem grants", () => {
    const result = validateLwir(
      workflow({
        steps: [
          {
            id: "unsafe-sandbox",
            uses: "code.run",
            with: {
              entrypoint: "main.ts",
              sandbox: { network: "deny", env: "allow", fs: "allow" },
              files: {
                "main.ts": codeFile(),
              },
            },
            output: { mode: "object", schema: summarySchema },
          },
        ],
      }),
    );

    expect(result.valid).toBe(false);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "code.invalid_sandbox",
          path: "$.steps[0].with.sandbox.env",
        }),
        expect.objectContaining({
          code: "code.invalid_sandbox",
          path: "$.steps[0].with.sandbox.fs",
        }),
      ]),
    );
  });

  it("validates bounded parallel branch policy", () => {
    const result = validateLwir(
      workflow({
        steps: [
          {
            id: "review-candidates",
            uses: "parallel",
            with: {
              items: "{{ input.candidates }}",
              itemKey: "{{ item.candidateId }}",
              cardinality: { kind: "matches_items" },
              maxBranches: 25,
              maxConcurrency: 5,
              failureMode: "all_settled",
              fanIn: { order: "input", output: "array" },
            },
            steps: [
              {
                id: "score-candidate",
                uses: "ai.generate",
                with: {
                  model: "model.fast",
                  prompt: "Score {{ item }}.",
                },
                output: {
                  mode: "object",
                  schema: {
                    type: "object",
                    required: ["candidateId", "score"],
                    properties: {
                      candidateId: { type: "string" },
                      score: { type: "number" },
                    },
                  },
                },
              },
            ],
            output: {
              mode: "array",
              schema: {
                type: "array",
                items: {
                  type: "object",
                  required: ["itemKey", "status", "output", "outputRef", "artifacts"],
                  properties: {
                    itemKey: { type: "string" },
                    status: { const: "completed" },
                    output: {
                      type: "object",
                      required: ["candidateId", "score"],
                      properties: {
                        candidateId: { type: "string" },
                        score: { type: "number" },
                      },
                    },
                    outputRef: { type: "string" },
                    artifacts: { type: "array", items: { type: "string" } },
                  },
                },
              },
            },
          },
        ],
      }),
    );

    expect(result).toEqual({ valid: true, findings: [] });
  });

  it("requires parallel cardinality to match items", () => {
    const missingCardinality = validateLwir(
      workflow({
        steps: [
          {
            id: "review-candidates",
            uses: "parallel",
            with: {
              items: "{{ input.candidates }}",
              itemKey: "{{ item.candidateId }}",
              maxBranches: 25,
              maxConcurrency: 5,
              failureMode: "all_settled",
              fanIn: { order: "input", output: "array" },
            },
            steps: [
              {
                id: "score-candidate",
                uses: "ai.generate",
                with: {
                  model: "model.fast",
                  prompt: "Score {{ item }}.",
                },
                output: {
                  mode: "object",
                  schema: {
                    type: "object",
                    required: ["candidateId", "score"],
                    properties: {
                      candidateId: { type: "string" },
                      score: { type: "number" },
                    },
                  },
                },
              },
            ],
            output: {
              mode: "array",
              schema: {
                type: "array",
                items: {
                  type: "object",
                  required: ["itemKey", "status", "output", "outputRef", "artifacts"],
                  properties: {
                    itemKey: { type: "string" },
                    status: { const: "completed" },
                    output: {
                      type: "object",
                      required: ["candidateId", "score"],
                      properties: {
                        candidateId: { type: "string" },
                        score: { type: "number" },
                      },
                    },
                    outputRef: { type: "string" },
                    artifacts: { type: "array", items: { type: "string" } },
                  },
                },
              },
            },
          },
        ],
      }),
    );

    expect(missingCardinality.valid).toBe(false);
    expect(missingCardinality.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "parallel.invalid_cardinality",
          path: "$.steps[0].with.cardinality.kind",
        }),
      ]),
    );

    const matchingItemsCardinality = validateLwir(
      workflow({
        steps: [
          {
            id: "review-candidates",
            uses: "parallel",
            with: {
              items: "{{ input.candidates }}",
              itemKey: "{{ item.candidateId }}",
              cardinality: { kind: "matches_items" },
              maxBranches: 25,
              maxConcurrency: 5,
              failureMode: "all_settled",
              fanIn: { order: "input", output: "array" },
            },
            steps: [
              {
                id: "score-candidate",
                uses: "ai.generate",
                with: {
                  model: "model.fast",
                  prompt: "Score {{ item }}.",
                },
                output: {
                  mode: "object",
                  schema: {
                    type: "object",
                    required: ["candidateId", "score"],
                    properties: {
                      candidateId: { type: "string" },
                      score: { type: "number" },
                    },
                  },
                },
              },
            ],
            output: {
              mode: "array",
              schema: {
                type: "array",
                items: {
                  type: "object",
                  required: ["itemKey", "status", "output", "outputRef", "artifacts"],
                  properties: {
                    itemKey: { type: "string" },
                    status: { const: "completed" },
                    output: {
                      type: "object",
                      required: ["candidateId", "score"],
                      properties: {
                        candidateId: { type: "string" },
                        score: { type: "number" },
                      },
                    },
                    outputRef: { type: "string" },
                    artifacts: { type: "array", items: { type: "string" } },
                  },
                },
              },
            },
          },
        ],
      }),
    );

    expect(matchingItemsCardinality).toEqual({ valid: true, findings: [] });

    const rawItemSchema = validateLwir(
      workflow({
        steps: [
          {
            id: "review-candidates",
            uses: "parallel",
            with: {
              items: "{{ input.candidates }}",
              itemKey: "{{ item.candidateId }}",
              cardinality: { kind: "matches_items" },
              maxBranches: 25,
              maxConcurrency: 5,
              failureMode: "all_settled",
              fanIn: { order: "input", output: "array" },
            },
            steps: [
              {
                id: "score-candidate",
                uses: "ai.generate",
                with: {
                  model: "model.fast",
                  prompt: "Score {{ item }}.",
                },
                output: {
                  mode: "object",
                  schema: {
                    type: "object",
                    required: ["candidateId", "score"],
                    properties: {
                      candidateId: { type: "string" },
                      score: { type: "number" },
                    },
                  },
                },
              },
            ],
            output: {
              mode: "array",
              schema: {
                type: "array",
                items: {
                  type: "object",
                  required: ["candidateId", "score"],
                  properties: {
                    candidateId: { type: "string" },
                    score: { type: "number" },
                  },
                },
              },
            },
          },
        ],
      }),
    );

    expect(rawItemSchema.valid).toBe(false);
    expect(rawItemSchema.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "parallel.invalid_fan_in",
          path: "$.steps[0].output.schema.items",
        }),
      ]),
    );

    const missingArtifactsSchema = validateLwir(
      workflow({
        steps: [
          {
            id: "review-candidates",
            uses: "parallel",
            with: {
              items: "{{ input.candidates }}",
              itemKey: "{{ item.candidateId }}",
              cardinality: { kind: "matches_items" },
              maxBranches: 25,
              maxConcurrency: 5,
              failureMode: "all_settled",
              fanIn: { order: "input", output: "array" },
            },
            steps: [
              {
                id: "score-candidate",
                uses: "ai.generate",
                with: {
                  model: "model.fast",
                  prompt: "Score {{ item }}.",
                },
                output: {
                  mode: "object",
                  schema: {
                    type: "object",
                    required: ["candidateId", "score"],
                    properties: {
                      candidateId: { type: "string" },
                      score: { type: "number" },
                    },
                  },
                },
              },
            ],
            output: {
              mode: "array",
              schema: {
                type: "array",
                items: {
                  type: "object",
                  required: ["itemKey", "status", "output"],
                  properties: {
                    itemKey: { type: "string" },
                    status: { const: "completed" },
                    output: {
                      type: "object",
                      required: ["candidateId", "score"],
                      properties: {
                        candidateId: { type: "string" },
                        score: { type: "number" },
                      },
                    },
                  },
                },
              },
            },
          },
        ],
      }),
    );

    expect(missingArtifactsSchema.valid).toBe(false);
    expect(missingArtifactsSchema.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "parallel.invalid_fan_in",
          path: "$.steps[0].output.schema.items",
        }),
      ]),
    );

    const invalid = validateLwir(
      workflow({
        steps: [
          {
            id: "review-candidates",
            uses: "parallel",
            with: {
              items: "{{ input.candidates }}",
              itemKey: "{{ item.candidateId }}",
              cardinality: { kind: "matches_items" },
              maxBranches: 3,
              maxConcurrency: 4,
              failureMode: "sometimes",
              fanIn: { order: "random", output: "array" },
            },
            steps: [],
            output: {
              mode: "array",
              schema: {
                type: "array",
                items: {
                  type: "object",
                  required: ["itemKey", "status", "output", "outputRef", "artifacts"],
                  properties: {
                    itemKey: { type: "string" },
                    status: { const: "completed" },
                    output: {
                      type: "object",
                      required: ["candidateId", "score"],
                      properties: {
                        candidateId: { type: "string" },
                        score: { type: "number" },
                      },
                    },
                    outputRef: { type: "string" },
                    artifacts: { type: "array", items: { type: "string" } },
                  },
                },
              },
            },
          },
        ],
      }),
    );

    expect(invalid.valid).toBe(false);
    expect(invalid.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "parallel.invalid_concurrency",
          path: "$.steps[0].with.maxConcurrency",
        }),
        expect.objectContaining({
          code: "parallel.invalid_failure_mode",
          path: "$.steps[0].with.failureMode",
        }),
        expect.objectContaining({
          code: "parallel.invalid_fan_in",
          path: "$.steps[0].with.fanIn.order",
        }),
        expect.objectContaining({
          code: "parallel.missing_steps",
          path: "$.steps[0].steps",
        }),
      ]),
    );
  });

  it("allows parallel branch steps to reference declared top-level dependencies", () => {
    const result = validateLwir(
      workflow({
        steps: [
          {
            id: "lookup-customer",
            uses: "tool.call",
            with: { tool: "lookupCustomer" },
            output: { mode: "object", schema: summarySchema },
          },
          {
            id: "review-candidates",
            uses: "parallel",
            needs: ["lookup-customer"],
            with: {
              items: "{{ input.candidates }}",
              itemKey: "{{ item.candidateId }}",
              cardinality: { kind: "matches_items" },
              maxBranches: 25,
              maxConcurrency: 5,
              failureMode: "all_settled",
              fanIn: { order: "input", output: "array" },
            },
            steps: [
              {
                id: "score-candidate",
                uses: "ai.generate",
                needs: ["lookup-customer"],
                with: {
                  model: "model.fast",
                  prompt: "Score {{ item }} for {{ steps.lookup-customer.output.summary }}.",
                },
                output: {
                  mode: "object",
                  schema: {
                    type: "object",
                    required: ["candidateId", "score"],
                    properties: {
                      candidateId: { type: "string" },
                      score: { type: "number" },
                    },
                  },
                },
              },
            ],
            output: {
              mode: "array",
              schema: {
                type: "array",
                items: {
                  type: "object",
                  required: ["itemKey", "status", "output", "outputRef", "artifacts"],
                  properties: {
                    itemKey: { type: "string" },
                    status: { const: "completed" },
                    output: {
                      type: "object",
                      required: ["candidateId", "score"],
                      properties: {
                        candidateId: { type: "string" },
                        score: { type: "number" },
                      },
                    },
                    outputRef: { type: "string" },
                    artifacts: { type: "array", items: { type: "string" } },
                  },
                },
              },
            },
          },
        ],
      }),
    );

    expect(result).toEqual({ valid: true, findings: [] });
  });

  it("rejects branch references to top-level steps not needed by the parent parallel step", () => {
    const result = validateLwir(
      workflow({
        steps: [
          {
            id: "review-candidates",
            uses: "parallel",
            with: {
              items: "{{ input.candidates }}",
              itemKey: "{{ item.candidateId }}",
              cardinality: { kind: "matches_items" },
              maxBranches: 25,
              maxConcurrency: 5,
              failureMode: "all_settled",
              fanIn: { order: "input", output: "array" },
            },
            steps: [
              {
                id: "score-candidate",
                uses: "ai.generate",
                needs: ["lookup-customer"],
                with: {
                  model: "model.fast",
                  prompt: "Score {{ item }} for {{ steps.lookup-customer.output.summary }}.",
                },
                output: {
                  mode: "object",
                  schema: {
                    type: "object",
                    required: ["candidateId", "score"],
                    properties: {
                      candidateId: { type: "string" },
                      score: { type: "number" },
                    },
                  },
                },
              },
            ],
            output: { mode: "array", schema: { type: "array" } },
          },
          {
            id: "lookup-customer",
            uses: "tool.call",
            with: { tool: "lookupCustomer" },
            output: { mode: "object", schema: summarySchema },
          },
        ],
      }),
    );

    expect(result.valid).toBe(false);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "step.missing_dependency",
          path: "$.steps[0].steps[0].needs[0]",
        }),
        expect.objectContaining({
          code: "step.missing_dependency",
          path: "$.steps[0].steps[0].with.prompt",
        }),
      ]),
    );
  });

  it("rejects nested parallel steps in alpha", () => {
    const result = validateLwir(
      workflow({
        steps: [
          {
            id: "review-candidates",
            uses: "parallel",
            with: {
              items: "{{ input.candidates }}",
              itemKey: "{{ item.candidateId }}",
              cardinality: { kind: "matches_items" },
              maxBranches: 25,
              maxConcurrency: 5,
              failureMode: "all_settled",
              fanIn: { order: "input", output: "array" },
            },
            steps: [
              {
                id: "nested-review",
                uses: "parallel",
                with: {
                  items: "{{ item.notes }}",
                  itemKey: "{{ item.id }}",
                  cardinality: { kind: "matches_items" },
                  maxBranches: 5,
                  maxConcurrency: 2,
                  failureMode: "all_settled",
                  fanIn: { order: "input", output: "array" },
                },
                steps: [
                  {
                    id: "score-note",
                    uses: "tool.call",
                    with: { tool: "lookupCustomer" },
                    output: { mode: "object", schema: summarySchema },
                  },
                ],
                output: { mode: "array", schema: { type: "array" } },
              },
            ],
            output: { mode: "array", schema: { type: "array" } },
          },
        ],
      }),
    );

    expect(result.valid).toBe(false);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "parallel.nested_unsupported",
          path: "$.steps[0].steps[0].uses",
        }),
      ]),
    );
  });

  it("rejects step ids with runtime path delimiters", () => {
    const result = validateLwir(
      workflow({
        steps: [
          {
            id: "review[a].score",
            uses: "tool.call",
            with: { tool: "lookupCustomer" },
            output: { mode: "object", schema: summarySchema },
          },
          {
            id: "safe-parent",
            uses: "parallel",
            with: {
              items: "{{ input.candidates }}",
              itemKey: "{{ item.id }}",
              cardinality: { kind: "matches_items" },
              maxBranches: 10,
              maxConcurrency: 2,
              failureMode: "fail_fast",
              fanIn: { order: "input", output: "array" },
            },
            steps: [
              {
                id: "nested.score",
                uses: "tool.call",
                with: { tool: "lookupCustomer" },
                output: { mode: "object", schema: summarySchema },
              },
            ],
            output: { mode: "array", schema: { type: "array" } },
          },
        ],
      }),
    );

    expect(result.valid).toBe(false);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "step.invalid_id",
          path: "$.steps[0].id",
        }),
        expect.objectContaining({
          code: "step.invalid_id",
          path: "$.steps[1].steps[0].id",
        }),
      ]),
    );
  });

  it("rejects step ids reserved for retry branch paths", () => {
    const result = validateLwir(
      workflow({
        steps: [
          {
            id: "review@attempt_2",
            uses: "tool.call",
            with: { tool: "lookupCustomer" },
            output: { mode: "object", schema: summarySchema },
          },
          {
            id: "review@attempt_tmp",
            uses: "tool.call",
            with: { tool: "lookupCustomer" },
            output: { mode: "object", schema: summarySchema },
          },
        ],
      }),
    );

    expect(result.valid).toBe(false);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "step.invalid_id",
          path: "$.steps[0].id",
        }),
        expect.objectContaining({
          code: "step.invalid_id",
          path: "$.steps[1].id",
        }),
      ]),
    );
  });

  it("requires parallel item keys to depend on each branch item", () => {
    const result = validateLwir(
      workflow({
        steps: [
          {
            id: "review-candidates",
            uses: "parallel",
            with: {
              items: "{{ input.candidates }}",
              itemKey: "{{ input.ticketId }}",
              cardinality: { kind: "matches_items" },
              maxBranches: 10,
              maxConcurrency: 2,
              failureMode: "fail_fast",
              fanIn: { order: "input", output: "object" },
            },
            steps: [
              {
                id: "score-candidate",
                uses: "ai.generate",
                with: {
                  model: "model.fast",
                  prompt: "Score {{ item }}.",
                },
                output: {
                  mode: "object",
                  schema: {
                    type: "object",
                    properties: { score: { type: "number" } },
                  },
                },
              },
            ],
            output: { mode: "array", schema: { type: "array" } },
          },
        ],
      }),
    );

    expect(result.valid).toBe(false);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "parallel.invalid_item_key",
          path: "$.steps[0].with.itemKey",
        }),
        expect.objectContaining({
          code: "parallel.invalid_fan_in",
          path: "$.steps[0].with.fanIn.output",
        }),
      ]),
    );
  });

  it("rejects item expressions on the parent parallel step input", () => {
    const result = validateLwir(
      workflow({
        steps: [
          {
            id: "review-candidates",
            uses: "parallel",
            input: "{{ item.candidateId }}",
            with: {
              items: "{{ input.candidates }}",
              itemKey: "{{ item.candidateId }}",
              cardinality: { kind: "matches_items" },
              maxBranches: 10,
              maxConcurrency: 2,
              failureMode: "fail_fast",
              fanIn: { order: "input", output: "array" },
            },
            steps: [
              {
                id: "score-candidate",
                uses: "ai.generate",
                with: {
                  model: "model.fast",
                  prompt: "Score {{ item }}.",
                },
                output: {
                  mode: "object",
                  schema: {
                    type: "object",
                    required: ["candidateId", "score"],
                    properties: {
                      candidateId: { type: "string" },
                      score: { type: "number" },
                    },
                  },
                },
              },
            ],
            output: { mode: "array", schema: { type: "array" } },
          },
        ],
      }),
    );

    expect(result.valid).toBe(false);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "expression.invalid",
          path: "$.steps[0].input",
        }),
      ]),
    );
  });

  it("requires parallel output mode to match array fan-in", () => {
    const result = validateLwir(
      workflow({
        steps: [
          {
            id: "review-candidates",
            uses: "parallel",
            with: {
              items: "{{ input.candidates }}",
              itemKey: "{{ item.candidateId }}",
              cardinality: { kind: "matches_items" },
              maxBranches: 10,
              maxConcurrency: 2,
              failureMode: "fail_fast",
              fanIn: { order: "input", output: "array" },
            },
            steps: [
              {
                id: "score-candidate",
                uses: "ai.generate",
                with: { model: "model.text", prompt: "Score {{ item }}." },
                output: { mode: "text" },
              },
            ],
            output: { mode: "text" },
          },
        ],
      }),
    );

    expect(result.valid).toBe(false);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "output.invalid_for_step",
          path: "$.steps[0].output.mode",
        }),
      ]),
    );
  });

  it("rejects fanIn.outputStep pointing to a decision step (§2.7)", () => {
    const result = validateLwir(
      workflow({
        permissions: { tools: ["worker", "review"] },
        steps: [
          {
            id: "batch",
            uses: "parallel",
            with: {
              items: "{{ input.candidates }}",
              itemKey: "{{ item.id }}",
              cardinality: { kind: "matches_items" },
              maxBranches: 5,
              maxConcurrency: 2,
              failureMode: "fail_fast",
              fanIn: { order: "input", output: "array", outputStep: "route" },
            },
            steps: [
              {
                id: "worker",
                uses: "tool.call",
                with: { tool: "worker" },
                output: { mode: "object", schema: { type: "object" } },
              },
              {
                id: "route",
                uses: "decision",
                needs: ["worker"],
                with: { cases: [], default: "end" },
              },
            ],
            output: { mode: "array", schema: { type: "array" } },
          },
        ],
      }),
    );

    expect(result.valid).toBe(false);
    expect(result.findings.some((f) => f.code === "parallel.fan_in_output_step_invalid")).toBe(true);
  });

  it("rejects fanIn.outputStep pointing to a step not in the branch (§2.7)", () => {
    const result = validateLwir(
      workflow({
        permissions: { tools: ["worker", "review"] },
        steps: [
          {
            id: "batch",
            uses: "parallel",
            with: {
              items: "{{ input.candidates }}",
              itemKey: "{{ item.id }}",
              cardinality: { kind: "matches_items" },
              maxBranches: 5,
              maxConcurrency: 2,
              failureMode: "fail_fast",
              fanIn: { order: "input", output: "array", outputStep: "nonexistent" },
            },
            steps: [
              {
                id: "worker",
                uses: "tool.call",
                with: { tool: "worker" },
                output: { mode: "object", schema: { type: "object" } },
              },
            ],
            output: { mode: "array", schema: { type: "array" } },
          },
        ],
      }),
    );

    expect(result.valid).toBe(false);
    expect(result.findings.some((f) => f.code === "parallel.fan_in_output_step_invalid")).toBe(true);
  });

  it("accepts fanIn.outputStep pointing to a valid non-decision branch step (§2.7)", () => {
    const result = validateLwir(
      workflow({
        steps: [
          {
            id: "lookup-customer",
            uses: "tool.call",
            with: { tool: "lookupCustomer" },
            output: { mode: "object", schema: summarySchema },
          },
          {
            id: "batch",
            uses: "parallel",
            needs: ["lookup-customer"],
            with: {
              items: "{{ input.candidates }}",
              itemKey: "{{ item.id }}",
              cardinality: { kind: "matches_items" },
              maxBranches: 5,
              maxConcurrency: 2,
              failureMode: "fail_fast",
              fanIn: { order: "input", output: "array", outputStep: "worker" },
            },
            steps: [
              {
                id: "worker",
                uses: "tool.call",
                with: { tool: "lookupCustomer" },
                maxVisits: 3,
                output: { mode: "object", schema: { type: "object" } },
              },
              {
                id: "route",
                uses: "decision",
                needs: ["worker"],
                maxVisits: 3,
                with: {
                  cases: [{ when: "{{ steps.worker.lastOutput.done }}", to: "end" }],
                  default: "worker",
                },
              },
            ],
            output: { mode: "array", schema: { type: "array" } },
          },
        ],
      }),
    );

    // The fanIn.outputStep pointing to a valid non-decision step must NOT emit
    // parallel.fan_in_output_step_invalid. Other findings from the wider workflow
    // config (output schema mismatch, etc.) are not relevant to this check.
    expect(result.findings.every((f) => f.code !== "parallel.fan_in_output_step_invalid")).toBe(true);
  });

  it("returns an immutable registered workflow version snapshot", () => {
    const lwir = workflow();
    const version = registerWorkflowVersion(lwir);

    (lwir.steps as unknown[]).push({
      id: "mutated",
      uses: "ai.generate",
      with: { model: "model.text", prompt: "changed" },
      output: { mode: "text" },
    });
    lwir.metadata.description = "changed after registration";

    expect(version.lwir.steps.map((step) => step.id)).toEqual([
      "lookup-customer",
      "summarize",
    ]);
    expect(version.lwir.metadata.description).toBe(
      "Summarize and classify a support ticket.",
    );
    expect(version.hash).toBe(sha256Digest(version.lwir));
    expect(() => {
      (version.lwir.steps as unknown[]).push({});
    }).toThrow(TypeError);
    expect(Object.isFrozen(version)).toBe(true);
    expect(() => {
      (version as { hash: string }).hash = "sha256:mutated";
    }).toThrow(TypeError);
  });

  it("requires expression step references to declare needs and produce typed JSON", () => {
    const result = validateLwir(
      workflow({
        steps: [
          {
            id: "load",
            uses: "tool.call",
            with: { tool: "lookupCustomer" },
            output: { mode: "json" },
          },
          {
            id: "summarize",
            uses: "ai.generate",
            with: {
              model: "model.structured",
              prompt: "Summarize {{ steps.load.output.plan }} and {{ steps.missing.output }}.",
            },
            output: { mode: "object", schema: summarySchema },
          },
        ],
      }),
    );

    expect(result.valid).toBe(false);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "step.undeclared_dependency",
          path: "$.steps[1].with.prompt",
        }),
        expect.objectContaining({
          code: "step.missing_dependency",
          path: "$.steps[1].with.prompt",
        }),
        expect.objectContaining({
          code: "output.missing_schema",
          path: "$.steps[0].output.schema",
        }),
      ]),
    );
  });

  it("requires bracket-form expression step references to declare needs", () => {
    const result = validateLwir(
      workflow({
        steps: [
          {
            id: "load",
            uses: "tool.call",
            with: { tool: "lookupCustomer" },
            output: { mode: "json" },
          },
          {
            id: "summarize",
            uses: "ai.generate",
            with: {
              model: "model.structured",
              prompt:
                "Summarize {{ steps[\"load\"].output.plan }} and {{ steps[\"missing\"].output }}.",
            },
            output: { mode: "object", schema: summarySchema },
          },
        ],
      }),
    );

    expect(result.valid).toBe(false);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "step.undeclared_dependency",
          path: "$.steps[1].with.prompt",
        }),
        expect.objectContaining({
          code: "step.missing_dependency",
          path: "$.steps[1].with.prompt",
        }),
        expect.objectContaining({
          code: "output.missing_schema",
          path: "$.steps[0].output.schema",
        }),
      ]),
    );
  });

  it("does not treat step references inside expression string literals as dependencies", () => {
    const result = validateLwir(
      workflow({
        steps: [
          {
            id: "summarize",
            uses: "ai.generate",
            with: {
              model: "model.text",
              prompt: "{{ coalesce(input.ticketId, \"steps['load'].output.plan\") }}",
            },
            output: { mode: "text" },
          },
        ],
      }),
    );

    expect(result).toEqual({ valid: true, findings: [] });
  });

  it("throws validation errors with findings", () => {
    expect(() => assertValidLwir({})).toThrow(LwirValidationError);
    try {
      assertValidLwir({});
      throw new Error("assertValidLwir should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(LwirValidationError);
      expect((error as LwirValidationError).findings.length).toBeGreaterThan(0);
    }
  });

  it("accepts sensitive: true on step metadata without warning", () => {
    const result = validateLwir(
      workflow({
        steps: [
          {
            id: "process-sensitive",
            uses: "ai.generate",
            with: { model: "model.text", prompt: "Process this." },
            output: { mode: "text" },
            sensitive: true,
          },
        ],
      }),
    );

    expect(result.valid).toBe(true);
    expect(result.findings).toEqual([]);
  });

  describe("decision step shape validation", () => {
    // Helper: minimal ai.generate step for use as a decision source/target.
    function aiStep(id: string, needs?: string[]) {
      return {
        id,
        uses: "ai.generate",
        ...(needs ? { needs } : {}),
        with: { model: "model.text", prompt: "Draft." },
        output: { mode: "text" },
      };
    }

    it("accepts a decision step with cases and default", () => {
      const w = workflow({
        steps: [
          aiStep("a"),
          {
            id: "route",
            uses: "decision",
            needs: ["a"],
            with: {
              cases: [{ when: "{{ steps.a.output.ok }}", to: "b" }],
              default: "end",
            },
          },
          aiStep("b"),
        ],
      });
      expect(validateLwir(w).valid).toBe(true);
    });

    it("rejects a decision step missing default", () => {
      const w = workflow({
        steps: [
          aiStep("a"),
          {
            id: "route",
            uses: "decision",
            needs: ["a"],
            with: {
              cases: [{ when: "{{ steps.a.output.ok }}", to: "b" }],
            },
          },
          aiStep("b"),
        ],
      });
      const r = validateLwir(w);
      expect(r.valid).toBe(false);
      expect(r.findings.some((f) => f.code === "decision.default_required")).toBe(true);
    });

    it("rejects a decision step with non-string default", () => {
      const w = workflow({
        steps: [
          aiStep("a"),
          {
            id: "route",
            uses: "decision",
            needs: ["a"],
            with: {
              cases: [{ when: "{{ steps.a.output.ok }}", to: "b" }],
              default: 42,
            },
          },
          aiStep("b"),
        ],
      });
      const r = validateLwir(w);
      expect(r.valid).toBe(false);
      expect(r.findings.some((f) => f.code === "decision.default_required")).toBe(true);
    });

    it("rejects a decision step referencing an unknown target", () => {
      const w = workflow({
        steps: [
          aiStep("a"),
          {
            id: "route",
            uses: "decision",
            needs: ["a"],
            with: {
              cases: [{ when: "{{ steps.a.output.ok }}", to: "ghost" }],
              default: "end",
            },
          },
        ],
      });
      const r = validateLwir(w);
      expect(r.valid).toBe(false);
      expect(r.findings.some((f) => f.code === "decision.target_not_in_scope")).toBe(true);
    });

    it("accepts a decision step with to: 'end' as a sentinel", () => {
      const w = workflow({
        steps: [
          aiStep("a"),
          {
            id: "route",
            uses: "decision",
            needs: ["a"],
            with: {
              cases: [{ when: "{{ steps.a.output.ok }}", to: "end" }],
              default: "end",
            },
          },
        ],
      });
      expect(validateLwir(w).valid).toBe(true);
    });

    it("rejects a decision case missing when or to", () => {
      const w = workflow({
        steps: [
          aiStep("a"),
          {
            id: "route",
            uses: "decision",
            needs: ["a"],
            with: {
              cases: [{ to: "b" }],
              default: "end",
            },
          },
          aiStep("b"),
        ],
      });
      const r = validateLwir(w);
      expect(r.valid).toBe(false);
      expect(r.findings.some((f) => f.code === "decision.case_invalid")).toBe(true);
    });

    it("P2.5 — rejects a decision cases[].when that is a plain string without {{ }} wrapping", () => {
      // "steps.x.ok" is a raw path reference — always truthy at runtime, should be rejected
      const w = workflow({
        steps: [
          aiStep("a"),
          {
            id: "route",
            uses: "decision",
            needs: ["a"],
            with: {
              cases: [{ when: "steps.a.output.ok", to: "b" }],
              default: "end",
            },
          },
          aiStep("b"),
        ],
      });
      const r = validateLwir(w);
      expect(r.valid).toBe(false);
      expect(
        r.findings.some(
          (f) => f.code.startsWith("expression.") && f.path === "$.steps[1].with.cases[0].when",
        ),
      ).toBe(true);
    });

    it("P2.5 — accepts a decision cases[].when with a valid {{ }} expression", () => {
      const w = workflow({
        steps: [
          aiStep("a"),
          {
            id: "route",
            uses: "decision",
            needs: ["a"],
            with: {
              cases: [{ when: "{{ steps.a.output.ok }}", to: "b" }],
              default: "end",
            },
          },
          aiStep("b"),
        ],
      });
      expect(validateLwir(w).valid).toBe(true);
    });

    it("P2.5 — accepts a decision cases[].when using {{ item.* }} inside a parallel branch", () => {
      // A decision step inside a parallel branch may legitimately route on item state.
      // The validator must honor context.allowItemExpressions rather than hard-coding false.
      const w = workflow({
        steps: [
          {
            id: "process-items",
            uses: "parallel",
            with: {
              items: "{{ input.candidates }}",
              itemKey: "{{ item.candidateId }}",
              cardinality: { kind: "matches_items" },
              maxBranches: 25,
              maxConcurrency: 5,
              failureMode: "all_settled",
              fanIn: { order: "input", output: "array" },
            },
            steps: [
              aiStep("classify"),
              {
                id: "route",
                uses: "decision",
                needs: ["classify"],
                with: {
                  cases: [{ when: "{{ item.kind == 'urgent' }}", to: "end" }],
                  default: "end",
                },
              },
            ],
            output: { mode: "array", schema: { type: "array" } },
          },
        ],
      });
      const r = validateLwir(w);
      const decisionExpressionFindings = r.findings.filter(
        (f) => f.code.startsWith("expression.") && f.path.includes("cases[0].when"),
      );
      expect(decisionExpressionFindings).toHaveLength(0);
    });

    it("P2.5 — rejects a top-level decision cases[].when using {{ item.* }} outside parallel", () => {
      // item.* is never in scope at top level — should still produce a finding after the fix.
      const w = workflow({
        steps: [
          aiStep("a"),
          {
            id: "route",
            uses: "decision",
            needs: ["a"],
            with: {
              cases: [{ when: "{{ item.kind == 'urgent' }}", to: "b" }],
              default: "end",
            },
          },
          aiStep("b"),
        ],
      });
      const r = validateLwir(w);
      expect(
        r.findings.some(
          (f) => f.code.startsWith("expression.") && f.path === "$.steps[1].with.cases[0].when",
        ),
      ).toBe(true);
    });
  });

  describe("maxVisits field and cycle validation", () => {
    function aiStep(id: string, overrides: Record<string, unknown> = {}) {
      return {
        id,
        uses: "ai.generate",
        with: { model: "model.text", prompt: "Draft." },
        output: { mode: "text" },
        ...overrides,
      };
    }

    function decisionStep(id: string, overrides: Record<string, unknown> = {}) {
      return {
        id,
        uses: "decision",
        ...overrides,
      };
    }

    it("accepts maxVisits in [1, 100]", () => {
      const w = workflow({
        steps: [
          { ...aiStep("a"), maxVisits: 3 },
          aiStep("b", { needs: ["a"] }),
        ],
      });
      expect(validateLwir(w).valid).toBe(true);
    });

    it("rejects maxVisits === 0", () => {
      const w = workflow({
        steps: [
          { ...aiStep("a"), maxVisits: 0 },
        ],
      });
      const r = validateLwir(w);
      expect(r.valid).toBe(false);
      expect(r.findings.some((f) => f.code.includes("max_visits"))).toBe(true);
    });

    it("rejects maxVisits === 101", () => {
      const w = workflow({
        steps: [
          { ...aiStep("a"), maxVisits: 101 },
        ],
      });
      const r = validateLwir(w);
      expect(r.valid).toBe(false);
      expect(r.findings.some((f) => f.code.includes("max_visits"))).toBe(true);
    });

    it("rejects maxVisits as a non-integer", () => {
      const w = workflow({
        steps: [
          { ...aiStep("a"), maxVisits: 2.5 },
        ],
      });
      const r = validateLwir(w);
      expect(r.valid).toBe(false);
      expect(r.findings.some((f) => f.code.includes("max_visits"))).toBe(true);
    });

    it("rejects a cycle where some step on the cycle has maxVisits < 2", () => {
      // worker (maxVisits default=1) → review (maxVisits=2) → route (decision, default→worker)
      const w = workflow({
        steps: [
          // worker has maxVisits=1 (default), so cycle is invalid
          aiStep("worker"),
          aiStep("review", { needs: ["worker"], maxVisits: 2 }),
          decisionStep("route", {
            needs: ["review"],
            with: {
              cases: [],
              default: "worker",
            },
            maxVisits: 2,
          }),
        ],
      });
      const r = validateLwir(w);
      expect(r.valid).toBe(false);
      expect(r.findings.some((f) => f.code === "lwir.invalid_cycle")).toBe(true);
    });

    it("accepts a cycle when decision is on it and all cycle steps have maxVisits >= 2", () => {
      const w = workflow({
        steps: [
          aiStep("worker", { maxVisits: 5 }),
          aiStep("review", { needs: ["worker"], maxVisits: 5 }),
          decisionStep("route", {
            needs: ["review"],
            with: {
              cases: [{ when: "{{ steps.review.lastOutput.ok }}", to: "end" }],
              default: "worker",
            },
            maxVisits: 5,
          }),
        ],
      });
      expect(validateLwir(w).valid).toBe(true);
    });

    it("accepts a self-loop (decision -> itself) if maxVisits >= 2", () => {
      // step A (decision) with a case pointing back to itself, default goes to end
      const w = workflow({
        steps: [
          decisionStep("gate", {
            with: {
              cases: [{ when: "{{ input.ticketId }}", to: "gate" }],
              default: "end",
            },
            maxVisits: 3,
          }),
        ],
      });
      expect(validateLwir(w).valid).toBe(true);
    });

    it("rejects a self-loop (decision -> itself) if maxVisits < 2", () => {
      const w = workflow({
        steps: [
          decisionStep("gate", {
            with: {
              cases: [{ when: "{{ input.ticketId }}", to: "gate" }],
              default: "end",
            },
            // maxVisits defaults to 1, which is < 2
          }),
        ],
      });
      const r = validateLwir(w);
      expect(r.valid).toBe(false);
      expect(r.findings.some((f) => f.code === "lwir.invalid_cycle")).toBe(true);
    });

    // P2.4 — subcycle-without-decision tests
    describe("P2.4 — subcycle-without-decision", () => {
      // Graph: A→B (A.needs=[B]), B→A (B.needs=[A]), B→C (C.needs=[B]), C→B (decision case to=B)
      // The full SCC is {A,B,C}. The OLD code passes this (hasDecision=true via C).
      // The NEW code removes C from the subgraph, finds residual SCC {A,B} (no decision) → invalid.
      it("P2.4 rejects an SCC whose sub-cycle A→B→A contains no decision step", () => {
        const w = workflow({
          steps: [
            aiStep("A", { needs: ["B"], maxVisits: 2 }),
            aiStep("B", { needs: ["A"], maxVisits: 2 }),
            decisionStep("C", {
              needs: ["B"],
              with: {
                cases: [{ when: "{{ true }}", to: "B" }],
                default: "end",
              },
              maxVisits: 2,
            }),
          ],
        });
        const r = validateLwir(w);
        expect(r.valid).toBe(false);
        const cycleFindings = r.findings.filter((f) => f.code === "lwir.invalid_cycle");
        expect(cycleFindings.length).toBeGreaterThan(0);
        // The residual SCC that fires must mention A and B, but NOT C
        const residualFinding = cycleFindings.find(
          (f) => f.message.includes("A") && f.message.includes("B"),
        );
        expect(residualFinding).toBeDefined();
        expect(residualFinding!.message).not.toMatch(/\bC\b/);
      });

      // Positive baseline: A→B→A where B is a decision. After removing B, residual = {A} only. Passes.
      it("P2.4 accepts a two-step cycle A→B→A when B is the decision step", () => {
        const w = workflow({
          steps: [
            aiStep("A", { needs: ["B"], maxVisits: 3 }),
            decisionStep("B", {
              needs: ["A"],
              with: {
                cases: [{ when: "{{ true }}", to: "A" }],
                default: "end",
              },
              maxVisits: 3,
            }),
          ],
        });
        expect(validateLwir(w).valid).toBe(true);
      });
    });
  });

  it("rejects sensitive: non-boolean value", () => {
    const result = validateLwir(
      workflow({
        steps: [
          {
            id: "bad-sensitive-string",
            uses: "ai.generate",
            with: { model: "model.text", prompt: "Draft." },
            output: { mode: "text" },
            sensitive: "yes",
          },
          {
            id: "bad-sensitive-number",
            uses: "ai.generate",
            with: { model: "model.text", prompt: "Draft." },
            output: { mode: "text" },
            sensitive: 1,
          },
        ],
      }),
    );

    expect(result.valid).toBe(false);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "step.sensitive_must_be_boolean",
          path: "$.steps[0].sensitive",
        }),
        expect.objectContaining({
          code: "step.sensitive_must_be_boolean",
          path: "$.steps[1].sensitive",
        }),
      ]),
    );
  });

  describe("output_ambiguous_for_multi_visit (Layer A §2.5)", () => {
    function aiStep(id: string, overrides: Record<string, unknown> = {}) {
      return {
        id,
        uses: "ai.generate",
        with: { model: "model.text", prompt: "Draft." },
        output: { mode: "text" },
        ...overrides,
      };
    }

    it("rejects {{ steps.X.output }} on a step with maxVisits > 1", () => {
      const w = workflow({
        steps: [
          { ...aiStep("worker"), maxVisits: 3 },
          {
            ...aiStep("summarize", { needs: ["worker"] }),
            with: { model: "model.text", prompt: "Summarize {{ steps.worker.output }}." },
          },
        ],
      });
      const r = validateLwir(w);
      expect(r.valid).toBe(false);
      expect(
        r.findings.some((f) => f.code === "lwir.output_ambiguous_for_multi_visit"),
      ).toBe(true);
    });

    it("accepts {{ steps.X.lastOutput }} on a step with maxVisits > 1", () => {
      const w = workflow({
        steps: [
          { ...aiStep("worker"), maxVisits: 3 },
          {
            ...aiStep("summarize", { needs: ["worker"] }),
            with: {
              model: "model.text",
              prompt: "Summarize {{ steps.worker.lastOutput }}.",
            },
          },
        ],
      });
      expect(validateLwir(w).valid).toBe(true);
    });

    it("accepts {{ steps.X.allVisits }} on a step with maxVisits > 1", () => {
      const w = workflow({
        steps: [
          { ...aiStep("worker"), maxVisits: 3 },
          {
            ...aiStep("summarize", { needs: ["worker"] }),
            with: {
              model: "model.text",
              prompt: "History: {{ steps.worker.allVisits }}.",
            },
          },
        ],
      });
      expect(validateLwir(w).valid).toBe(true);
    });

    it("accepts {{ steps.X.output }} on a step with maxVisits === 1 (default)", () => {
      const w = workflow({
        steps: [
          aiStep("worker"),
          {
            ...aiStep("summarize", { needs: ["worker"] }),
            with: {
              model: "model.text",
              prompt: "Summarize {{ steps.worker.output }}.",
            },
          },
        ],
      });
      expect(validateLwir(w).valid).toBe(true);
    });

    it("accepts {{ steps.X.output }} on a step with maxVisits === 1 explicit", () => {
      const w = workflow({
        steps: [
          { ...aiStep("worker"), maxVisits: 1 },
          {
            ...aiStep("summarize", { needs: ["worker"] }),
            with: {
              model: "model.text",
              prompt: "Summarize {{ steps.worker.output }}.",
            },
          },
        ],
      });
      expect(validateLwir(w).valid).toBe(true);
    });

    it("rejects {{ steps.X.output }} via bracket-form reference on multi-visit step", () => {
      const w = workflow({
        steps: [
          { ...aiStep("worker"), maxVisits: 2 },
          {
            ...aiStep("summarize", { needs: ["worker"] }),
            with: {
              model: "model.text",
              prompt: "Summarize {{ steps[\"worker\"].output }}.",
            },
          },
        ],
      });
      const r = validateLwir(w);
      expect(r.valid).toBe(false);
      expect(
        r.findings.some((f) => f.code === "lwir.output_ambiguous_for_multi_visit"),
      ).toBe(true);
    });

    it("does not emit output_ambiguous when no output property is accessed", () => {
      // Accessing steps.X directly (no .output property)
      const w = workflow({
        steps: [
          { ...aiStep("worker"), maxVisits: 3 },
          {
            ...aiStep("summarize", { needs: ["worker"] }),
            with: {
              model: "model.text",
              prompt: "Summarize {{ steps.worker.lastOutput }}.",
            },
          },
        ],
      });
      const r = validateLwir(w);
      expect(r.findings.some((f) => f.code === "lwir.output_ambiguous_for_multi_visit")).toBe(
        false,
      );
    });
  });

  // P2.6 — lastOutput / allVisits back-edge reference without needs
  describe("P2.6 — lastOutput/allVisits back-edge refs without needs", () => {
    function aiStep(id: string, overrides: Record<string, unknown> = {}) {
      return {
        id,
        uses: "ai.generate",
        with: { model: "model.text", prompt: "Draft." },
        output: { mode: "text" },
        ...overrides,
      };
    }

    function decisionStep(id: string, overrides: Record<string, unknown> = {}) {
      return {
        id,
        uses: "decision",
        ...overrides,
      };
    }

    // Test 1 — positive: worker→review→route (decision back to worker).
    // Worker uses steps.review.lastOutput without declaring review in needs.
    // This is a legitimate back-edge: BFS from review reaches worker via review→route→worker.
    // Expected: NO step.undeclared_dependency for steps.review.lastOutput in worker.
    it("P2.6 accepts steps.review.lastOutput in worker without needs when review can reach worker via back-edge", () => {
      const w = workflow({
        steps: [
          aiStep("worker", {
            maxVisits: 5,
            with: {
              model: "model.text",
              // worker reads prior review feedback on round 2+
              prompt: "Address feedback: {{ steps.review.lastOutput }}.",
            },
            // No needs: review declared — it's a back-edge from a prior cycle iteration
          }),
          aiStep("review", {
            needs: ["worker"],
            maxVisits: 5,
            with: { model: "model.text", prompt: "Review the draft." },
          }),
          decisionStep("route", {
            needs: ["review"],
            maxVisits: 5,
            with: {
              cases: [{ when: "{{ steps.review.lastOutput.ok }}", to: "end" }],
              default: "worker",
            },
          }),
        ],
      });
      const r = validateLwir(w);
      // No undeclared_dependency for steps.review.lastOutput in worker
      expect(
        r.findings.some(
          (f) =>
            f.code === "step.undeclared_dependency" &&
            f.message.includes("worker") &&
            f.message.includes("review"),
        ),
      ).toBe(false);
      // Workflow as a whole must be valid
      expect(r.valid).toBe(true);
    });

    // Test 1b — same shape but with allVisits instead of lastOutput
    it("P2.6 accepts steps.review.allVisits in worker without needs when review can reach worker via back-edge", () => {
      const w = workflow({
        steps: [
          aiStep("worker", {
            maxVisits: 5,
            with: {
              model: "model.text",
              prompt: "Address all feedback: {{ steps.review.allVisits }}.",
            },
          }),
          aiStep("review", {
            needs: ["worker"],
            maxVisits: 5,
            with: { model: "model.text", prompt: "Review the draft." },
          }),
          decisionStep("route", {
            needs: ["review"],
            maxVisits: 5,
            with: {
              cases: [{ when: "{{ steps.review.lastOutput.ok }}", to: "end" }],
              default: "worker",
            },
          }),
        ],
      });
      const r = validateLwir(w);
      expect(
        r.findings.some(
          (f) =>
            f.code === "step.undeclared_dependency" &&
            f.message.includes("worker") &&
            f.message.includes("review"),
        ),
      ).toBe(false);
      expect(r.valid).toBe(true);
    });

    // Test 2 — negative: preserve existing behavior for plain output reference.
    // Step Y uses steps.x.output without declaring x in needs in a linear workflow.
    // Expected: step.undeclared_dependency still fires.
    it("P2.6 still emits step.undeclared_dependency for plain output reference without needs", () => {
      const w = workflow({
        steps: [
          aiStep("x"),
          aiStep("y", {
            with: {
              model: "model.text",
              prompt: "Summarize {{ steps.x.output }}.",
            },
            // deliberately no needs: ["x"]
          }),
        ],
      });
      const r = validateLwir(w);
      expect(
        r.findings.some(
          (f) =>
            f.code === "step.undeclared_dependency" &&
            f.message.includes("y") &&
            f.message.includes("x"),
        ),
      ).toBe(true);
    });

    // Test 3 — negative: lastOutput referenced from a step NOT in a common cycle.
    // Linear workflow: x → y (y reads steps.x.lastOutput without needs).
    // x has maxVisits=2 so lastOutput is semantically valid, but there is no
    // back-edge from x to y, so the BFS from x cannot reach y → finding still fires.
    it("P2.6 still emits step.undeclared_dependency for lastOutput when referenced step cannot reach referencing step", () => {
      const w = workflow({
        steps: [
          aiStep("x", { maxVisits: 2 }),
          aiStep("y", {
            with: {
              model: "model.text",
              prompt: "Summarize {{ steps.x.lastOutput }}.",
            },
            // deliberately no needs: ["x"] and no cycle back to y
          }),
        ],
      });
      const r = validateLwir(w);
      expect(
        r.findings.some(
          (f) =>
            f.code === "step.undeclared_dependency" &&
            f.message.includes("y") &&
            f.message.includes("x"),
        ),
      ).toBe(true);
    });
  });

  describe("P1.2 — decision_target_referenced_by_needs validator", () => {
    function aiStep(id: string, overrides: Record<string, unknown> = {}) {
      return {
        id,
        uses: "ai.generate",
        with: { model: "worker.text", prompt: "Draft." },
        output: { mode: "text" },
        ...overrides,
      };
    }

    // Test 1 — positive: step Y has needs: [X] and X is a decision target (cases[].to)
    // with non-empty needs. X could be excluded from scheduling indefinitely → Y deadlocks.
    it("P1.2 emits decision_target_referenced_by_needs when Y depends on a decision target X that has non-empty needs", () => {
      // Workflow: a → route (cases: to=x, default=end), x (needs: [a]), y (needs: [x])
      // x is a decision target AND x has needs: [a]. y declaring needs: [x] may deadlock
      // because x is excluded from normal scheduling once route's needs are satisfied.
      const w = workflow({
        steps: [
          aiStep("a"),
          {
            id: "route",
            uses: "decision",
            needs: ["a"],
            with: {
              cases: [{ when: "{{ steps.a.output.ok }}", to: "x" }],
              default: "end",
            },
          },
          aiStep("x", { needs: ["a"] }),
          aiStep("y", { needs: ["x"] }),
        ],
      });
      const r = validateLwir(w);
      expect(
        r.findings.some((f) => f.code === "lwir.decision_target_referenced_by_needs"),
      ).toBe(true);
      const finding = r.findings.find((f) => f.code === "lwir.decision_target_referenced_by_needs");
      expect(finding?.message).toContain("x");
      expect(finding?.message).toContain("y");
    });

    // Test 2 — negative: back-edge loop where the decision target X has needs: []
    // (X always runs on first iteration → Y depending on X is safe).
    it("P1.2 does NOT emit decision_target_referenced_by_needs for back-edge loop entry with needs: []", () => {
      // Classic back-edge loop: worker (needs=[]) → review (needs=[worker]) → route (default=worker)
      // worker is a decision target but has needs:[] → always runs first → review never deadlocks.
      const w = workflow({
        steps: [
          aiStep("worker", { maxVisits: 3 }),
          aiStep("review", { needs: ["worker"], maxVisits: 3 }),
          {
            id: "route",
            uses: "decision",
            needs: ["review"],
            maxVisits: 3,
            with: {
              cases: [{ when: "{{ steps.review.lastOutput.passed }}", to: "end" }],
              default: "worker",
            },
          },
        ],
      });
      const r = validateLwir(w);
      expect(
        r.findings.some((f) => f.code === "lwir.decision_target_referenced_by_needs"),
      ).toBe(false);
    });

    // Test 3 — negative: Y is itself a decision target (so the loop pattern is self-consistent).
    it("P1.2 does NOT emit when Y is itself a decision target", () => {
      // a → route (cases: to=x, to=y), x (needs=[a]), y (needs=[x])
      // y is also a decision target — its own scheduling is decision-controlled too.
      const w = workflow({
        steps: [
          aiStep("a"),
          {
            id: "route",
            uses: "decision",
            needs: ["a"],
            with: {
              cases: [
                { when: "{{ steps.a.output.ok }}", to: "x" },
                { when: "{{ steps.a.output.fast }}", to: "y" },
              ],
              default: "end",
            },
          },
          aiStep("x", { needs: ["a"] }),
          aiStep("y", { needs: ["x"] }),
        ],
      });
      const r = validateLwir(w);
      // y is a decision target itself — the finding for y should not fire
      expect(
        r.findings.some(
          (f) =>
            f.code === "lwir.decision_target_referenced_by_needs" &&
            f.message.includes("'y'"),
        ),
      ).toBe(false);
    });
  });
});

/**
 * Regression guard for one recurring defect shape: a field the schema validates
 * and the runtime silently ignores. These assert the *loud* behaviour — that
 * declaring an unimplemented field fails validation and names itself — because
 * silent acceptance is the bug, and only a test that demands noise prevents it
 * from coming back. A fourth instance belongs here.
 */
describe("declared but unimplemented fields", () => {
  function unimplementedFindings(result: ReturnType<typeof validateLwir>) {
    return result.findings.filter((f) => f.code === UNIMPLEMENTED_FIELD_CODE);
  }

  it("rejects a non-empty permissions.secrets instead of installing nothing", () => {
    const result = validateLwir(
      workflow({
        permissions: {
          models: ["model.structured", "model.text", "model.fast"],
          tools: ["lookupCustomer"],
          secrets: ["licenseApiKey"],
          network: [],
        },
      }),
    );

    expect(result.valid).toBe(false);
    expect(unimplementedFindings(result)).toEqual([
      expect.objectContaining({
        severity: "error",
        code: UNIMPLEMENTED_FIELD_CODE,
        path: "$.permissions.secrets",
      }),
    ]);
    // The message must name the field and say what to do instead — the planner
    // repair loop reads it verbatim.
    expect(unimplementedFindings(result)[0]?.message).toContain("permissions.secrets");
    expect(unimplementedFindings(result)[0]?.message).toContain("silently ignored");
  });

  it("rejects a non-empty permissions.network instead of installing nothing", () => {
    const result = validateLwir(
      workflow({
        permissions: {
          models: ["model.structured", "model.text", "model.fast"],
          tools: ["lookupCustomer"],
          secrets: [],
          network: ["https://api.example.com"],
        },
      }),
    );

    expect(result.valid).toBe(false);
    expect(unimplementedFindings(result)).toEqual([
      expect.objectContaining({
        code: UNIMPLEMENTED_FIELD_CODE,
        path: "$.permissions.network",
      }),
    ]);
  });

  it("still accepts empty secrets and network arrays, which grant nothing", () => {
    const result = validateLwir(
      workflow({
        permissions: {
          models: ["model.structured", "model.text", "model.fast"],
          tools: ["lookupCustomer"],
          secrets: [],
          network: [],
        },
      }),
    );

    expect(result).toEqual({ valid: true, findings: [] });
  });

  it("rejects onFailure.repair mode escalate rather than degrading it to no repair", () => {
    const result = validateLwir(
      workflow({
        steps: [
          {
            id: "summarize",
            uses: "ai.generate",
            with: { model: "model.text", prompt: "Summarize {{ input.transcript }}." },
            onFailure: { repair: { mode: "escalate", maxAttempts: 2 } },
            output: { mode: "object", schema: summarySchema },
          },
        ],
      }),
    );

    expect(result.valid).toBe(false);
    expect(unimplementedFindings(result)).toEqual([
      expect.objectContaining({
        code: UNIMPLEMENTED_FIELD_CODE,
        path: "$.steps[0].onFailure.repair.mode",
      }),
    ]);
    expect(unimplementedFindings(result)[0]?.message).toContain('"self"');
  });

  // The fourth instance, found while fixing the first three: `repair.model` is
  // validated (shape + allowlist) and never read — the repair loop resolves the
  // step's own `with.model`. Rejecting escalate while still accepting escalate's
  // parameter would leave the same defect inside the config object being fixed.
  it("rejects onFailure.repair.model, which the repair loop never reads", () => {
    const result = validateLwir(
      workflow({
        steps: [
          {
            id: "summarize",
            uses: "ai.generate",
            with: { model: "model.text", prompt: "Summarize {{ input.transcript }}." },
            onFailure: { repair: { mode: "self", maxAttempts: 2, model: "model.structured" } },
            output: { mode: "object", schema: summarySchema },
          },
        ],
      }),
    );

    expect(result.valid).toBe(false);
    expect(unimplementedFindings(result)).toEqual([
      expect.objectContaining({
        code: UNIMPLEMENTED_FIELD_CODE,
        path: "$.steps[0].onFailure.repair.model",
      }),
    ]);
    // An allowlisted model must not also draw `repair.model_disallowed`, and a
    // malformed one must not draw `repair.model.missing` — one field, one
    // instruction, or the planner gets contradictory repair advice.
    expect(result.findings.map((f) => f.code)).toEqual([UNIMPLEMENTED_FIELD_CODE]);
  });

  it("reports only the unimplemented finding for a malformed repair.model", () => {
    const result = validateLwir(
      workflow({
        steps: [
          {
            id: "summarize",
            uses: "ai.generate",
            with: { model: "model.text", prompt: "Summarize {{ input.transcript }}." },
            onFailure: { repair: { mode: "self", maxAttempts: 2, model: "" } },
            output: { mode: "object", schema: summarySchema },
          },
        ],
      }),
    );

    expect(result.findings.map((f) => f.code)).toEqual([UNIMPLEMENTED_FIELD_CODE]);
  });

  it("still accepts onFailure.repair mode self, which the runtime implements", () => {
    const result = validateLwir(
      workflow({
        steps: [
          {
            id: "summarize",
            uses: "ai.generate",
            with: { model: "model.text", prompt: "Summarize {{ input.transcript }}." },
            onFailure: { repair: { mode: "self", maxAttempts: 2 } },
            output: { mode: "object", schema: summarySchema },
          },
        ],
      }),
    );

    expect(result).toEqual({ valid: true, findings: [] });
  });

  it("rejects a step cache declaration, which had no runtime semantics", () => {
    const result = validateLwir(
      workflow({
        steps: [
          {
            id: "summarize",
            uses: "ai.generate",
            with: { model: "model.text", prompt: "Summarize {{ input.transcript }}." },
            cache: { enabled: true, key: "{{ sha256(input.ticketId) }}" },
            output: { mode: "object", schema: summarySchema },
          },
        ],
      }),
    );

    expect(result.valid).toBe(false);
    expect(unimplementedFindings(result)).toEqual([
      expect.objectContaining({
        code: UNIMPLEMENTED_FIELD_CODE,
        path: "$.steps[0].cache",
      }),
    ]);
  });

  it("rejects a step cache declaration inside a parallel branch", () => {
    const result = validateLwir(
      workflow({
        steps: [
          {
            id: "fan-out",
            uses: "parallel",
            with: { over: "{{ input.transcript }}", as: "item" },
            steps: [
              {
                id: "score",
                uses: "ai.generate",
                with: { model: "model.text", prompt: "Score {{ item }}." },
                cache: { key: "{{ sha256(item) }}" },
                output: { mode: "text" },
              },
            ],
            output: { mode: "object", schema: summarySchema },
          },
        ],
      }),
    );

    expect(result.valid).toBe(false);
    expect(
      unimplementedFindings(result).map((f) => f.path),
    ).toContain("$.steps[0].steps[0].cache");
  });

  it("blocks an unimplemented declaration from ever reaching the runtime", () => {
    // registerWorkflowVersion is the only way to mint a WorkflowVersion, and it
    // runs assertValidLwir — so rejection here closes every execution path.
    expect(() =>
      registerWorkflowVersion(
        workflow({
          permissions: {
            models: ["model.structured", "model.text", "model.fast"],
            tools: ["lookupCustomer"],
            secrets: ["licenseApiKey"],
            network: [],
          },
        }),
      ),
    ).toThrow(LwirValidationError);
  });
});
