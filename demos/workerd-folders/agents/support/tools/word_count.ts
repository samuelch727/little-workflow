import { jsonSchema, tool } from "ai";
export default tool({
  description: "Count words in text.",
  inputSchema: jsonSchema<{ text: string }>({ type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false }),
  execute: async ({ text }) => ({ count: text.trim() ? text.trim().split(/\s+/u).length : 0 }),
});
