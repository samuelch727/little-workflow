import { createHarness, type HarnessHost } from "@little-stack/harness";
import { jsonSchema, tool } from "ai";
import { scriptedModel } from "../../src/model.js";

// The compiler imports this function statically. The worker calls it once per chat, with
// that chat's host. Counters, models and tool closures are never shared across chats.
export default (host: HarnessHost) => {
  let count = 0;
  return createHarness({ host, model: scriptedModel(), tools: {
    counter: tool({ inputSchema: jsonSchema({ type: "object", properties: {} }), execute: async () => ++count }),
  } });
};
