import { tool } from "ai";
import { tryHarnessToolContext } from "little-harness/connectors/runtime";
import { z } from "zod";
import { recordThreadReply } from "../channel-log";
import type { ConciergeSlackExtraBody } from "../connector";

export const replyInThreadOutputSchema = z.object({
  kind: z.literal("thread-reply"),
  connector: z.literal("slack"),
  threadTs: z.string(),
  text: z.string(),
  postedAt: z.string(),
});

/**
 * Slack-only connector tool (plain `tool({ ..., execute })` under
 * `connectors/slack/tools/` — folder-scoped, no `extendTool` needed).
 */
export const replyInThreadBase = tool({
  description:
    "Reply to a specific Slack message thread. Slack connector only. Use to follow up inside an existing thread rather than posting a new channel message.",
  inputSchema: z.object({
    threadTs: z.string().min(1).describe("The Slack thread timestamp to reply under."),
    text: z.string().min(1).describe("The reply text."),
  }),
  outputSchema: replyInThreadOutputSchema,
  strict: true,
  execute: async (input: { threadTs: string; text: string }, options) => {
    // The active connector endpoint arrives in the harness execution context; read it typed and
    // cast-free via `tryHarnessToolContext` (undefined when run standalone, e.g. a unit test).
    const ctx = tryHarnessToolContext<ConciergeSlackExtraBody>(options);
    const threadTs = input.threadTs || ctx?.connector?.endpoint?.threadId || "thread";
    return recordThreadReply({ threadTs, text: input.text });
  },
});

export default replyInThreadBase;
