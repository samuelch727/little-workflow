import { createDiscordAdapter } from "@chat-adapter/discord";
import { createMemoryState } from "@chat-adapter/state-memory";
import { chatSdkConnector } from "little-harness/connectors/runtime";
import { recordSupportMirrorDelivery } from "../shared/mirror-delivery";
import { supportSessionIdFromRecord } from "../shared/session-id";

export type SupportDiscordExtraBody = {
  platform: "discord";
  threadId: string;
  userId: string;
  trigger: "directMessage" | "mention" | "subscribedMessage";
  sessionId?: string;
};

export default chatSdkConnector<SupportDiscordExtraBody>({
  userName: process.env.BOT_USERNAME ?? "support-command-center",
  adapter: {
    name: "discord",
    create: () =>
      createDiscordAdapter({
        userName: process.env.BOT_USERNAME ?? "Support Command Center",
      }),
  },
  state: () => createMemoryState(),
  // Availability is structural: the global support `tools/*` plus this connector's own
  // `connectors/discord/tools/send-channel-update`. Discord opts OUT of the two heavier
  // escalation/refund tools (they belong in the web console, not a channel thread) with a
  // targeted `deny` — no exhaustive whitelist needed. `send-channel-update` is Discord-only
  // purely by folder structure, so the web connector never sees it.
  toolPolicy: { deny: ["evaluate-refund-policy", "create-escalation"] },
  // Descriptor-owned mirror posting: when a run on another surface mirrors into this Discord
  // connector, the harness calls this `deliver`. In the demo it records to the shared outbox; in
  // production it would post to the Discord thread.
  deliver: recordSupportMirrorDelivery,
  triggers: {
    directMessage: true,
    mention: { subscribe: true },
    subscribedMessage: true,
  },
  history: { source: "thread", limit: 20, fallback: "latest" },
  session: ({ thread, message }) =>
    supportSessionIdFromRecord(message.raw) ?? `support:discord:${thread.id}`,
  extraBody: ({ thread, message, trigger }) => {
    const sessionId = supportSessionIdFromRecord(message.raw);
    return {
      platform: "discord",
      threadId: thread.id,
      userId: message.author.userId,
      trigger,
      ...(sessionId === undefined ? {} : { sessionId }),
    };
  },
  beforeRun: async ({ thread }) => {
    await thread.startTyping?.("Checking support context...");
  },
});
