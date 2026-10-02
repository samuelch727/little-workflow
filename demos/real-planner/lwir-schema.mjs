// Permissive JSON schema for LWIR structured output.
// The full workflow validator runs downstream inside the SDK;
// here we just need enough shape constraint to enable AI SDK structured output
// without rejecting reasonable planner emissions.
import { jsonSchema } from "ai";

const lwirStepJsonSchema = {
  type: "object",
  required: ["id", "uses"],
  additionalProperties: true,
  properties: {
    id: { type: "string" },
    uses: { type: "string" },
    input: {},
    with: {},
    output: {},
    branches: { type: "array" },
    cases: { type: "array" },
  },
};

export const lwirSchema = jsonSchema({
  type: "object",
  required: ["apiVersion", "kind", "metadata", "steps"],
  additionalProperties: true,
  properties: {
    apiVersion: { type: "string" },
    kind: { type: "string" },
    metadata: {
      type: "object",
      required: ["name"],
      additionalProperties: true,
      properties: {
        name: { type: "string" },
        version: { type: "string" },
        description: { type: "string" },
      },
    },
    input: { type: "object", additionalProperties: true },
    output: { type: "object", additionalProperties: true },
    permissions: {},
    steps: {
      type: "array",
      items: lwirStepJsonSchema,
    },
  },
});
