import { createHarness, type HarnessHost } from "@little-stack/harness";
import { jsonSchema, tool } from "ai";
import type { ChatContext } from "../../src/context.js";

// The compiler imports this function statically. The worker calls it once per chat, with
// that chat's host and trusted application context. Counters, models and tool closures are never shared across chats.
export default (host: HarnessHost, context: ChatContext) => {
  let count = 0;
  return createHarness({ host, model: context.env.createModel(), onEvent: context.onEvent, tools: {
    context_info: tool({ inputSchema: jsonSchema({ type: "object", properties: {} }), execute: async () => {
      const result = { chatSessionId: context.chatSessionId, count: ++count };
      context.onResult(result); // Only this explicit tool result is visible to the model.
      return result;
    } }),
    counter: tool({ inputSchema: jsonSchema({ type: "object", properties: {} }), execute: async () => ++count }),
  } });
};
