import { createSlackAdapter } from "@chat-adapter/slack";
import { createMemoryState } from "@chat-adapter/state-memory";
import { chatSdkConnector } from "little-harness/connectors/runtime";
import { conciergeSessionIdFromRecord } from "../shared/session-id";

export type ConciergeSlackExtraBody = {
  platform: "slack";
  threadId: string;
  userId: string;
  trigger: "directMessage" | "mention" | "subscribedMessage";
  sessionId?: string;
};

/**
 * Real Slack connector via `@chat-adapter/slack`. Tokens are read from the
 * environment at request time, so the connector constructs fine without
 * credentials (the demo verifies it through the simulate route; live Slack setup
 * is documented in SLACK_SETUP.md). The agent's Slack-only tools live in
 * `connectors/slack/tools/`.
 */
export default chatSdkConnector<ConciergeSlackExtraBody>({
  userName: process.env.SLACK_BOT_USERNAME ?? "relay",
  adapter: {
    name: "slack",
    create: () =>
      createSlackAdapter({
        mode: "webhook",
        botToken: process.env.SLACK_BOT_TOKEN,
        signingSecret: process.env.SLACK_SIGNING_SECRET,
        userName: process.env.SLACK_BOT_USERNAME ?? "relay",
      }),
  },
  state: () => createMemoryState(),
  // The global `list-releases` tool is structurally available everywhere; Slack opts
  // out of it (stays focused on posting, not browsing) — a connector tool blacklist.
  toolPolicy: { deny: ["list-releases"] },
  triggers: {
    directMessage: true,
    mention: { subscribe: true },
    subscribedMessage: true,
  },
  history: { source: "thread", limit: 20, fallback: "latest" },
  session: ({ thread, message }) =>
    conciergeSessionIdFromRecord(message.raw) ?? `concierge:slack:${thread.id}`,
  extraBody: ({ thread, message, trigger }) => {
    const sessionId = conciergeSessionIdFromRecord(message.raw);
    return {
      platform: "slack",
      threadId: thread.id,
      userId: message.author.userId,
      trigger,
      ...(sessionId === undefined ? {} : { sessionId }),
    };
  },
  beforeRun: async ({ thread }) => {
    await thread.startTyping?.("Checking release status...");
  },
});
