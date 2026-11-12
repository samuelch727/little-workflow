import { jsonSchema, tool } from "ai";
export default tool({
  description: "Wait briefly and report the execution interval (concurrency demo).",
  inputSchema: jsonSchema<{ ms: number }>({ type: "object", properties: { ms: { type: "integer", minimum: 0, maximum: 1000 } }, required: ["ms"], additionalProperties: false }),
  execute: async ({ ms }) => {
    const started = Date.now();
    await new Promise(resolve => setTimeout(resolve, ms));
    return { started, ended: Date.now() };
  },
});
