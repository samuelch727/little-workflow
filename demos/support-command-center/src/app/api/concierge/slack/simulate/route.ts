import {
  createTestChat,
  createTestMessage,
  createTestThread,
  loadChatSdkConnector,
  type LoadChatSdkConnectorOptions,
} from "little-harness/connectors/runtime";
import {
  streamHarness,
  type StreamHarnessOptions,
  type StreamHarnessResult,
} from "little-harness/execution";
import slackConnector from "../../../../../../agents/concierge/connectors/slack/connector";
import {
  clearChannelFeed,
  listChannelFeed,
  type ChannelFeedEntry,
} from "../../../../../../agents/concierge/connectors/slack/channel-log";
import {
  createConciergeSlackConnectorLoadOptions,
  CONCIERGE_SLACK_CONNECTOR_ID,
} from "../connector";

export const CONCIERGE_SLACK_SIM_SESSION = "concierge:slack:sim";
const SIM_THREAD_ID = "C0RELEASES";
const SIM_USER_ID = "U0TEAMMATE";

type DemoStreamHarness = (options: StreamHarnessOptions<any, any>) => StreamHarnessResult<any>;

export type SlackSimulationResult = {
  sessionId: string;
  userMessage: string;
  reply: string;
  channelFeed: ChannelFeedEntry[];
  connectorTools: string[];
};

function validateMessage(message: string): string {
  const trimmed = message.trim();
  if (trimmed.length === 0) throw new Error("Message is required.");
  return trimmed.slice(0, 2_000);
}

/**
 * Drives a synthetic Slack message through the real concierge Slack connector using the SDK test
 * helpers: `createTestChat` stands in for `@chat-adapter/slack` (no live workspace) and
 * `loaded.simulateInbound(...)` runs the SAME pipeline a real Slack event would — session id,
 * `thread`-source history (the loader now appends the inbound message itself), the Slack-only tools,
 * and thread posting. By default it runs the real DeepSeek harness (so the model actually calls the
 * Slack tools); tests pass a `streamHarness` override to stay offline.
 */
export async function runConciergeSlackSimulation(
  input: { message: string },
  options: {
    streamHarness?: DemoStreamHarness;
    loadHarness?: LoadChatSdkConnectorOptions<unknown>["loadHarness"];
  } = {},
): Promise<SlackSimulationResult> {
  const message = validateMessage(input.message);
  clearChannelFeed();

  const loadOptions = createConciergeSlackConnectorLoadOptions();
  const baseStreamHarness: DemoStreamHarness = loadOptions.streamHarness ?? streamHarness;

  // Swap the real Slack adapter for an inert one so no live workspace is contacted.
  const simConnector = {
    ...slackConnector,
    adapter: { name: "slack", create: () => ({ name: "slack" }) },
    state: () => ({}),
  };

  let connectorTools: string[] = [];
  const runStreamHarness: DemoStreamHarness = (streamOptions) => {
    connectorTools = Object.keys(streamOptions.connectorTools ?? {});
    if (options.streamHarness !== undefined) return options.streamHarness(streamOptions);
    return baseStreamHarness(streamOptions);
  };

  const loaded = await loadChatSdkConnector({
    ...loadOptions,
    connector: simConnector,
    connectorId: CONCIERGE_SLACK_CONNECTOR_ID,
    createChat: createTestChat({ adapterName: "slack" }),
    streamHarness: runStreamHarness,
    ...(options.loadHarness === undefined ? {} : { loadHarness: options.loadHarness }),
  });

  const inbound = createTestMessage({
    id: "slack_sim_user_message",
    text: message,
    threadId: SIM_THREAD_ID,
    userKey: SIM_USER_ID,
    raw: { harnessSessionId: CONCIERGE_SLACK_SIM_SESSION },
    author: {
      userId: SIM_USER_ID,
      userName: "teammate",
      fullName: "Slack Teammate",
      isMe: false,
    },
  });
  const thread = createTestThread({ id: SIM_THREAD_ID, adapterName: "slack", messages: [inbound] });

  try {
    await loaded.simulateInbound({ thread, message: inbound });
  } finally {
    await loaded.close();
  }

  return {
    sessionId: CONCIERGE_SLACK_SIM_SESSION,
    userMessage: message,
    reply: thread.posts.at(-1) ?? "No Slack reply was posted.",
    channelFeed: [...listChannelFeed()],
    connectorTools,
  };
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { message?: unknown };
  const message = typeof body.message === "string" ? body.message : "";
  try {
    const result = await runConciergeSlackSimulation({ message });
    return Response.json(result);
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 400 });
  }
}
