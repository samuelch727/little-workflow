import {
  attachSessionConnector,
  chatSdkEndpointId,
  createTestChat,
  createTestMessage,
  createTestThread,
  listSessionConnectors,
  loadChatSdkConnector,
  loadWebRichConnector,
  type ChatSdkMessage,
  type LoadWebRichConnectorOptions,
  type SessionConnectorAttachment,
} from "little-harness/connectors/runtime";
import type {
  StreamHarnessOptions,
  StreamHarnessResult,
} from "little-harness/execution";
import {
  clearSupportMirrorDeliveries,
  listSupportMirrorDeliveries,
  type SupportMirrorDeliveryRecord,
} from "../../../../agents/support/connectors/shared/mirror-delivery";
import discordConnector from "../../../../agents/support/connectors/discord/connector";
import {
  clearSendChannelUpdates,
  listSendChannelUpdates,
  type SendChannelUpdateOutput,
} from "../../../../agents/support/connectors/discord/tools/send-channel-update";
import type { SupportDiscordExtraBody } from "../../../../agents/support/connectors/discord/connector";
import type {
  SupportWebExtraBody,
  SupportWebUser,
} from "../../../../agents/support/connectors/web-rich/connector";
import {
  createWebConnectorLoadOptions,
  SUPPORT_WEB_CONNECTOR_ID,
} from "../chat/route";
import {
  createDiscordConnectorLoadOptions,
  SUPPORT_DISCORD_CONNECTOR_ID,
} from "../discord/connector";

export const PORTABLE_DEMO_SESSION_ID = "support:portable:heliosoft";
const WEB_CONVERSATION_ID = "portable-demo-web";
const WEB_USER_ID = "demo-support-manager";
const DISCORD_THREAD_ID = "discord_thread_demo";
const DISCORD_USER_ID = "discord_demo_user";
const WEB_PORTABLE_PROMPT =
  "Start the portable HelioSoft support session. Look up HelioSoft Global and summarize the duplicate support charge context for an internal teammate.";
const DISCORD_PORTABLE_PROMPT =
  "Continue the same HelioSoft portable support session from Discord. Use the send-channel-update tool with customerId cust_enterprise_helio, urgency high, and summary: Finance approval path is ready; keep success manager copied before renewal. Then reply with the channel and audit id.";

type DemoStreamHarness = (
  options: StreamHarnessOptions<any, any>,
) => StreamHarnessResult<any>;

export type PortableTranscriptEntry = {
  connectorId: "web-rich" | "discord";
  label: string;
  direction: "inbound" | "outbound" | "tool";
  text: string;
};

export type PortableDemoResult = {
  surface: "web-rich" | "discord";
  sessionId: typeof PORTABLE_DEMO_SESSION_ID;
  connectorToolNames: string[];
  connectors: SessionConnectorAttachment[];
  mirrorDeliveries: readonly SupportMirrorDeliveryRecord[];
  channelUpdates: readonly SendChannelUpdateOutput[];
  transcript: PortableTranscriptEntry[];
  replyText?: string;
  postedText?: string;
  responseBytes?: number;
};

type PortableDemoOptions = {
  streamHarness?: DemoStreamHarness;
  loadHarness?: LoadWebRichConnectorOptions<any, any>["loadHarness"];
};

// The Discord-only connector tool the demo drives offline. The tool itself is discovered
// structurally (`connectors/discord/tools/send-channel-update.ts`); here we only simulate the model
// calling it, since there is no live model in the demo.
function portableDiscordToolStream(
  options: StreamHarnessOptions<any, SupportDiscordExtraBody>,
  onChannelUpdate?: (output: SendChannelUpdateOutput) => void,
): StreamHarnessResult<string> {
  const text = Promise.resolve().then(async () => {
    const output = await invokeSendChannelUpdate(options, {
      customerId: "cust_enterprise_helio",
      summary: "Finance approval path is ready; keep success manager copied before renewal.",
      urgency: "high",
    });
    if (output === undefined) {
      return "Discord connector turn completed, but send-channel-update was not available.";
    }
    onChannelUpdate?.(output);
    return `Discord connector update sent to ${output.channel}. Audit ${output.auditId}.`;
  });

  return textStreamResult(text, "portable-discord-demo");
}

type SendChannelUpdateInput = {
  customerId: string;
  summary: string;
  urgency: "normal" | "high";
};

type OfflineConnectorTool = {
  execute?: (
    input: SendChannelUpdateInput,
    options: unknown,
  ) => Promise<SendChannelUpdateOutput> | SendChannelUpdateOutput;
};

async function invokeSendChannelUpdate(
  options: StreamHarnessOptions<any, SupportDiscordExtraBody>,
  input: SendChannelUpdateInput,
): Promise<SendChannelUpdateOutput | undefined> {
  const sendChannelUpdate = options.connectorTools?.["send-channel-update"] as
    | OfflineConnectorTool
    | undefined;
  // The real `streamHarness` spreads the harness execution context (session/files/connector/…) into a
  // tool's `execute` options; the tool reads it back via `tryHarnessToolContext`. Offline we simulate
  // one model tool-call, so hand it the same minimal shape (the active `connector` carries the typed
  // endpoint the tool needs).
  return sendChannelUpdate?.execute?.(input, {
    connector: options.connector,
    session: {},
    files: {},
  });
}

function textStreamResult(text: Promise<string>, traceId: string): StreamHarnessResult<string> {
  return {
    text,
    output: text,
    textStream: (async function* () {
      yield await text;
    })(),
    toUIMessageStream: () => new ReadableStream({ start: (controller) => controller.close() }),
    toUIMessageStreamResponse: () => new Response(""),
    finished: text.then(() => ({
      status: "completed" as const,
      session: {} as any,
      artifacts: [],
      trace: { id: traceId },
      persistence: { status: "not-configured" as const },
      warnings: [],
      commitManual: async () => ({ status: "not-configured" as const }),
    })),
  };
}

async function waitForMirrorDelivery(sessionId: string, sourceConnectorId: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (
      listSupportMirrorDeliveries().some(
        (item) => item.sessionId === sessionId && item.sourceConnectorId === sourceConnectorId,
      )
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function sessionConnectors(
  harness: { sessions: { getOrCreate(options: { id: string }): Promise<any> } },
): Promise<SessionConnectorAttachment[]> {
  const session = await harness.sessions.getOrCreate({ id: PORTABLE_DEMO_SESSION_ID });
  return listSessionConnectors(session);
}

export async function runPortableWebTurn(
  options: PortableDemoOptions = {},
): Promise<PortableDemoResult> {
  clearSupportMirrorDeliveries();
  const loadOptions = createWebConnectorLoadOptions();
  const loaded = await loadWebRichConnector<SupportWebUser, SupportWebExtraBody>({
    ...loadOptions,
    streamHarness: options.streamHarness ?? loadOptions.streamHarness,
    ...(options.loadHarness === undefined ? {} : { loadHarness: options.loadHarness }),
  });

  // MANUAL REGISTRY CONTROL (the one place the demo drives the registry by hand): seed the Discord
  // thread as a `mirror` target BEFORE the very first web turn, so the web reply fans out to Discord
  // even though Discord has not been an active surface yet. `chatSdkEndpointId` builds the same
  // endpoint id the Discord loader will use, so the later Discord turn re-attaches this exact record
  // instead of creating a duplicate. Subsequent hand-off is automatic via `previousActive: "mirror"`.
  const session = await loaded.harness.sessions.getOrCreate({ id: PORTABLE_DEMO_SESSION_ID });
  await attachSessionConnector(session, {
    connectorId: SUPPORT_DISCORD_CONNECTOR_ID,
    kind: "chat-sdk",
    delivery: "mirror",
    endpoint: {
      id: chatSdkEndpointId("discord", DISCORD_THREAD_ID),
      platform: "discord",
      threadId: DISCORD_THREAD_ID,
      userId: DISCORD_USER_ID,
      label: "Discord demo thread",
    },
  });

  const response = await loaded.POST(
    new Request("https://support.example.test/api/chat", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-support-user-id": WEB_USER_ID,
        "x-harness-session-id": PORTABLE_DEMO_SESSION_ID,
      },
      body: JSON.stringify({
        id: WEB_CONVERSATION_ID,
        sessionId: PORTABLE_DEMO_SESSION_ID,
        messages: [
          { id: "portable_web_user", role: "user", parts: [{ type: "text", text: WEB_PORTABLE_PROMPT }] },
        ],
      }),
    }),
  );
  const responseText = await response.text();
  await waitForMirrorDelivery(PORTABLE_DEMO_SESSION_ID, SUPPORT_WEB_CONNECTOR_ID);
  const mirrorDeliveries = listSupportMirrorDeliveries();
  const replyText =
    mirrorDeliveries.find((item) => item.sourceConnectorId === SUPPORT_WEB_CONNECTOR_ID)?.text ??
    responseText;
  await loaded.close();

  return {
    surface: SUPPORT_WEB_CONNECTOR_ID,
    sessionId: PORTABLE_DEMO_SESSION_ID,
    connectorToolNames: [],
    connectors: await sessionConnectors(loaded.harness),
    mirrorDeliveries,
    channelUpdates: listSendChannelUpdates(),
    transcript: [
      {
        connectorId: SUPPORT_WEB_CONNECTOR_ID,
        label: "Web operator",
        direction: "inbound",
        text: WEB_PORTABLE_PROMPT,
      },
      {
        connectorId: SUPPORT_WEB_CONNECTOR_ID,
        label: "Harness reply",
        direction: "outbound",
        text: replyText,
      },
    ],
    replyText,
    responseBytes: responseText.length,
  };
}

export async function runPortableDiscordTurn(
  options: PortableDemoOptions = {},
): Promise<PortableDemoResult> {
  clearSendChannelUpdates();
  let connectorToolNames: string[] = [];
  const localChannelUpdates: SendChannelUpdateOutput[] = [];
  const loadOptions = createDiscordConnectorLoadOptions();
  // Swap the real Discord adapter/state for inert doubles so no live workspace is contacted; the
  // connector otherwise runs exactly as configured (session id, history, tools, mirror delivery).
  const demoDiscordConnector = {
    ...discordConnector,
    adapter: { name: "discord", create: () => ({ name: "discord" }) },
    state: () => ({}),
  };
  const runStreamHarness: DemoStreamHarness = (streamOptions) => {
    connectorToolNames = Object.keys(streamOptions.connectorTools ?? {});
    if (options.streamHarness !== undefined) {
      return options.streamHarness(streamOptions);
    }
    return portableDiscordToolStream(streamOptions, (output) => localChannelUpdates.push(output));
  };
  const loaded = await loadChatSdkConnector<SupportDiscordExtraBody>({
    ...loadOptions,
    connector: demoDiscordConnector,
    connectorId: SUPPORT_DISCORD_CONNECTOR_ID,
    // `createTestChat` is assignable to `ChatSdkChatConstructor` with zero casts and records the
    // registered trigger handlers so `simulateInbound` can drive the real run pipeline offline.
    createChat: createTestChat({ adapterName: "discord" }),
    streamHarness: runStreamHarness,
    ...(options.loadHarness === undefined ? {} : { loadHarness: options.loadHarness }),
  });

  const message: ChatSdkMessage = createTestMessage({
    id: "discord_message_demo",
    text: DISCORD_PORTABLE_PROMPT,
    threadId: DISCORD_THREAD_ID,
    userKey: DISCORD_USER_ID,
    raw: { harnessSessionId: PORTABLE_DEMO_SESSION_ID },
    author: { userId: DISCORD_USER_ID, userName: "sam-discord", fullName: "Sam Discord", isMe: false },
  });
  const thread = createTestThread({ id: DISCORD_THREAD_ID, adapterName: "discord", messages: [message] });
  // Drives the SAME run pipeline a live Discord trigger uses: `previousActive: "mirror"` (on the
  // load options) demotes the previously-active web surface to `mirror`, so this Discord reply fans
  // back out to the web console.
  await loaded.simulateInbound({ thread, message });
  await waitForMirrorDelivery(PORTABLE_DEMO_SESSION_ID, SUPPORT_DISCORD_CONNECTOR_ID);
  const mirrorDeliveries = listSupportMirrorDeliveries();
  const channelUpdates = localChannelUpdates.length > 0 ? localChannelUpdates : listSendChannelUpdates();
  const postedText = thread.posts.at(-1);
  await loaded.close();

  return {
    surface: SUPPORT_DISCORD_CONNECTOR_ID,
    sessionId: PORTABLE_DEMO_SESSION_ID,
    connectorToolNames,
    connectors: await sessionConnectors(loaded.harness),
    mirrorDeliveries,
    channelUpdates,
    transcript: [
      {
        connectorId: SUPPORT_DISCORD_CONNECTOR_ID,
        label: "Discord teammate",
        direction: "inbound",
        text: DISCORD_PORTABLE_PROMPT,
      },
      ...channelUpdates.map((update): PortableTranscriptEntry => ({
        connectorId: SUPPORT_DISCORD_CONNECTOR_ID,
        label: "Discord connector tool",
        direction: "tool",
        text: `${update.message} Audit ${update.auditId}.`,
      })),
      ...(postedText === undefined
        ? []
        : [{
            connectorId: SUPPORT_DISCORD_CONNECTOR_ID,
            label: "Harness reply",
            direction: "outbound",
            text: postedText,
          } satisfies PortableTranscriptEntry]),
    ],
    replyText: postedText,
    postedText,
  };
}
