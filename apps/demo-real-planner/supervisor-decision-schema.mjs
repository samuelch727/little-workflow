// JSON Schema for the supervisor decision. The supervisor returns either a
// `done` decision (with finalOutput) or a `continue` decision (with an
// optional promptNote that steers the next cycle).
import { jsonSchema } from "ai";

const rawSchema = {
  type: "object",
  required: ["kind"],
  oneOf: [
    {
      type: "object",
      required: ["kind", "finalOutput"],
      additionalProperties: false,
      properties: {
        kind: { const: "done" },
        finalOutput: {}, // permissive — supervisor may return any shape; downstream validation reshapes
      },
    },
    {
      type: "object",
      required: ["kind"],
      additionalProperties: false,
      properties: {
        kind: { const: "continue" },
        promptNote: { type: "string" },
      },
    },
  ],
};

export const supervisorDecisionSchema = jsonSchema(rawSchema);
export const supervisorDecisionRawSchema = rawSchema;
