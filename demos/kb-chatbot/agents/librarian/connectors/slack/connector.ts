import { createSlackAdapter } from "@chat-adapter/slack";
import { createMemoryState } from "@chat-adapter/state-memory";
import type { ChatSdkAdapterFactoryResult } from "little-harness/connectors";
import { chatSdkConnector } from "little-harness/connectors/runtime";
import { librarianLittleDb } from "../../littledb";

export type LibrarianExtraBody = {
  platform: "slack";
  threadId: string;
  userId: string;
  trigger: "directMessage" | "mention" | "subscribedMessage";
};

const db = librarianLittleDb();

/**
 * `adapter.create()` runs at connector LOAD time, before any message exists, and
 * `createSlackAdapter({ mode: "webhook" })` throws without a signing secret — so an
 * offline-runnable demo has to branch on credentials here rather than lazily.
 *
 * With `SLACK_SIGNING_SECRET` set this is the real Slack adapter and the webhook path
 * works. Without it, the descriptor still loads under the adapter NAME `"slack"` (which is
 * what the default session id `slack:<threadId>` is built from, on both the run and the
 * reaction side) and the demo is driven through `simulateInbound`.
 */
async function librarianAdapter(): Promise<ChatSdkAdapterFactoryResult> {
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  if (signingSecret === undefined || signingSecret.length === 0) {
    return { name: "slack" };
  }
  const botToken = process.env.SLACK_BOT_TOKEN;
  return createSlackAdapter({
    mode: "webhook",
    ...(botToken === undefined ? {} : { botToken }),
    signingSecret,
    userName: process.env.SLACK_BOT_USERNAME ?? "librarian",
  }) as unknown as ChatSdkAdapterFactoryResult;
}

/**
 * The Librarian's chat surface. The whole conversation — including a file upload — can be
 * driven offline through `simulateInbound`, because a `data`-backed attachment needs no
 * network and the adapter above degrades to a credential-free stub.
 *
 * Two things here are load-bearing for littleDB:
 *
 * - `beforeRun` resolves the session's managed config. The run pipeline AWAITS `beforeRun`
 *   before it calls `streamHarness`, and the `streamHarness` seam that carries per-session
 *   `system` / `model` / `onEvent` is synchronous — so this is where the async resolve has
 *   to happen. See `load.ts` for the other half.
 * - `reactions.sinks` sends 👍/👎 to littleDB. The session id is left at the DEFAULT
 *   (`<adapter>:<threadId>`) on BOTH sides: a custom `session` callback without a matching
 *   `reactions.session` would silently join outcomes onto a session that has no trace.
 */
export default chatSdkConnector<LibrarianExtraBody>({
  userName: process.env.SLACK_BOT_USERNAME ?? "librarian",
  adapter: { name: "slack", create: librarianAdapter },
  state: () => createMemoryState(),
  triggers: {
    directMessage: true,
    mention: { subscribe: true },
    subscribedMessage: true,
  },
  history: { source: "thread", limit: 20, fallback: "latest" },
  attachments: {
    // A knowledge-base document is text. 2 MiB is generous for one and keeps a stray
    // 200 MB video from ever being base64'd into a turn.
    maxBytes: 2 * 1024 * 1024,
    onSkipped: ({ reason, note }) => {
      console.warn(`kb-chatbot: attachment skipped (${reason}) — ${note}`);
    },
  },
  reactions: {
    ...(db === undefined ? {} : { sinks: [db.outcomeSink] }),
  },
  extraBody: ({ thread, message, trigger }) => ({
    platform: "slack",
    threadId: thread.id,
    userId: message.author.userId,
    trigger,
  }),
  beforeRun: async ({ session, thread }) => {
    await db?.prepareSession(session);
    await thread.startTyping?.("Checking the knowledge base...");
  },
});
