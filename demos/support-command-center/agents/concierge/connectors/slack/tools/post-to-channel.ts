import { tool } from "ai";
import { tryHarnessToolContext } from "little-harness/connectors/runtime";
import { z } from "zod";
import { recordChannelPost } from "../channel-log";
import type { ConciergeSlackExtraBody } from "../connector";

export const postToChannelOutputSchema = z.object({
  kind: z.literal("channel-post"),
  connector: z.literal("slack"),
  channel: z.string(),
  summary: z.string(),
  postedAt: z.string(),
});

/**
 * Slack-only connector tool. A plain `tool({ ..., execute })` under
 * `connectors/slack/tools/` — the folder makes it Slack-only; no `extendTool` and
 * no shared base needed since the capability exists only on Slack.
 */
export const postToChannelBase = tool({
  description:
    "Post a release/ops summary to a Slack channel. Slack connector only. Use when asked to announce or post an update to a channel.",
  inputSchema: z.object({
    channel: z.string().min(1).describe("Channel name, e.g. #releases"),
    summary: z.string().min(1).describe("The message to post."),
  }),
  outputSchema: postToChannelOutputSchema,
  strict: true,
  execute: async (input: { channel: string; summary: string }, options) => {
    // The active connector endpoint arrives in the harness execution context; read it typed and
    // cast-free via `tryHarnessToolContext` (undefined when run standalone, e.g. a unit test).
    const ctx = tryHarnessToolContext<ConciergeSlackExtraBody>(options);
    const channel = input.channel || ctx?.connector?.endpoint?.threadId || "#releases";
    return recordChannelPost({ channel, summary: input.summary });
  },
});

export default postToChannelBase;
