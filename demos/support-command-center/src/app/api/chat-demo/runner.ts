import type { UIMessage } from "ai";
import { randomUUID } from "node:crypto";
import {
  createTestChat,
  createTestMessage,
  createTestThread,
  loadChatSdkConnector,
  loadWebRichConnector,
  type ConnectorToolPolicy,
  type LoadWebRichConnectorOptions,
} from "little-harness/connectors/runtime";
import type {
  StreamHarnessOptions,
  StreamHarnessResult,
} from "little-harness/execution";
import discordConnector from "../../../../agents/support/connectors/discord/connector";
import type { SupportDiscordExtraBody } from "../../../../agents/support/connectors/discord/connector";
import type { SendChannelUpdateOutput } from "../../../../agents/support/connectors/discord/tools/send-channel-update";
import webRichConnector from "../../../../agents/support/connectors/web-rich/connector";
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

export const CHAT_DEMO_SESSION_ID = "support:chat-demo";
const WEB_CONVERSATION_ID = "chat-demo-web";
const WEB_USER_ID = "demo-web-user";
const DISCORD_THREAD_ID = "chat_demo_discord_thread";
const DISCORD_USER_ID = "discord_demo_user";

// The support agent's global `tools/*` — the structure-derived base toolset every connector starts
// from. Each connector's descriptor `toolPolicy` narrows this (web keeps all of them; Discord denies
// the two escalation/refund tools). Connector-only tools (e.g. Discord's `send-channel-update`) are
// added structurally by the loader, not listed here. This mirrors what the harness computes via
// `resolveConnectorTools` + `applyConnectorToolPolicy` at run time; the demo reports it directly
// because it runs offline without a live agent harness.
const SUPPORT_BASE_TOOL_NAMES = [
  "lookup-customer",
  "lookup-orders",
  "check-service-status",
  "summarize-ticket-history",
  "evaluate-refund-policy",
  "create-escalation",
] as const;

export type ConnectorChatRole = "user" | "assistant" | "tool";

export type ConnectorChatMessage = {
  id: string;
  role: ConnectorChatRole;
  connectorId: "web-rich" | "discord";
  text: string;
  toolName?: "send-channel-update";
};

export type ConnectorChatDemoResult = {
  surface: "web-rich" | "discord";
  sessionId: string;
  messages: ConnectorChatMessage[];
  availableTools: string[];
};

export type ConnectorChatDemoInput = {
  message: string;
};

type DemoStreamHarness = (
  options: StreamHarnessOptions<any, any>,
) => StreamHarnessResult<any>;

type RunnerOptions = {
  streamHarness?: DemoStreamHarness;
  loadHarness?: LoadWebRichConnectorOptions<any, any>["loadHarness"];
};

/**
 * Apply a connector's {@link ConnectorToolPolicy} to a set of tool names, mirroring
 * `applyConnectorToolPolicy` (deny wins over allow; unknown names ignored) so the demo can report the
 * connector's effective toolset without a live harness.
 */
function applyPolicyToNames(
  names: readonly string[],
  policy: ConnectorToolPolicy | undefined,
): string[] {
  const allow = policy?.allow === undefined ? undefined : new Set(policy.allow);
  const deny = new Set(policy?.deny ?? []);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const name of names) {
    if (seen.has(name)) continue;
    seen.add(name);
    if (allow !== undefined && !allow.has(name)) continue;
    if (deny.has(name)) continue;
    result.push(name);
  }
  return result;
}

function webMessage(text: string): UIMessage {
  return {
    id: "chat_demo_web_user",
    role: "user",
    parts: [{ type: "text", text }],
  };
}

function chatDemoSessionId(): string {
  return `${CHAT_DEMO_SESSION_ID}:${randomUUID()}`;
}

function validateMessage(input: ConnectorChatDemoInput): string {
  if (typeof input.message !== "string") {
    throw new Error("Message is required.");
  }
  const message = input.message.trim();
  if (message.length === 0) {
    throw new Error("Message is required.");
  }
  return message.slice(0, 2_000);
}

function isToolInventoryQuestion(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes("tool") &&
    (normalized.includes("available") || normalized.includes("have"));
}

function formatToolInventory(
  connectorLabel: string,
  baseTools: readonly string[],
  connectorTools: readonly string[],
): string {
  const connectorToolList = connectorTools.length === 0 ? "none" : connectorTools.join(", ");
  return [
    `Tools available to me in the ${connectorLabel} connector:`,
    "",
    `Base support tools: ${baseTools.join(", ")}.`,
    `Connector-specific tools: ${connectorToolList}.`,
  ].join("\n");
}

function textHarnessResult(text: string, traceId: string): StreamHarnessResult<string> {
  return {
    text: Promise.resolve(text),
    output: Promise.resolve(text),
    textStream: (async function* () {
      yield text;
    })(),
    toUIMessageStream: () => new ReadableStream({ start: (controller) => controller.close() }),
    toUIMessageStreamResponse: () => new Response(text),
    finished: Promise.resolve({
      status: "completed" as const,
      session: {} as any,
      artifacts: [],
      trace: { id: traceId },
      persistence: { status: "not-configured" as const },
      warnings: [],
      commitManual: async () => ({ status: "not-configured" as const }),
    }),
  };
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

// Simulate a single model tool-call offline. The real `streamHarness` spreads the harness execution
// context (session/files/connector/…) into a tool's `execute` options; the tool reads it back via
// `tryHarnessToolContext`, so hand it the same minimal shape (the active `connector` carries the
// typed endpoint the tool needs).
async function invokeSendChannelUpdate(
  options: StreamHarnessOptions<any, SupportDiscordExtraBody>,
  input: SendChannelUpdateInput,
): Promise<SendChannelUpdateOutput | undefined> {
  const sendChannelUpdate = options.connectorTools?.["send-channel-update"] as
    | OfflineConnectorTool
    | undefined;
  return sendChannelUpdate?.execute?.(input, {
    connector: options.connector,
    session: {},
    files: {},
  });
}

function discordToolStream(
  options: StreamHarnessOptions<any, SupportDiscordExtraBody>,
  message: string,
  onChannelUpdate: (output: SendChannelUpdateOutput) => void,
): StreamHarnessResult<string> {
  const text = Promise.resolve().then(async () => {
    const output = await invokeSendChannelUpdate(options, {
      customerId: "cust_enterprise_helio",
      summary: message,
      urgency: "high",
    });
    if (output === undefined) {
      return "I can answer here, but the Discord connector tool was not available.";
    }
    onChannelUpdate(output);
    return `Discord connector update sent to ${output.channel}. Audit ${output.auditId}.`;
  });

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
      trace: { id: "chat-demo-discord" },
      persistence: { status: "not-configured" as const },
      warnings: [],
      commitManual: async () => ({ status: "not-configured" as const }),
    })),
  };
}

export async function runWebChatDemoTurn(
  input: ConnectorChatDemoInput,
  options: RunnerOptions = {},
): Promise<ConnectorChatDemoResult> {
  const message = validateMessage(input);
  const sessionId = chatDemoSessionId();
  const availableTools = applyPolicyToNames(SUPPORT_BASE_TOOL_NAMES, webRichConnector.toolPolicy);
  const loadOptions = createWebConnectorLoadOptions();
  const inventoryReplyText = isToolInventoryQuestion(message)
    ? formatToolInventory("web-rich", availableTools, [])
    : undefined;
  const streamHarness: DemoStreamHarness | undefined = inventoryReplyText !== undefined
    ? () => textHarnessResult(inventoryReplyText, "chat-demo-web-tools")
    : options.streamHarness;
  const loaded = await loadWebRichConnector<SupportWebUser, SupportWebExtraBody>({
    ...loadOptions,
    streamHarness,
    ...(options.loadHarness === undefined ? {} : { loadHarness: options.loadHarness }),
  });

  let replyText: string;
  try {
    const response = await loaded.POST(
      new Request("https://support.example.test/api/chat-demo/web", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-support-user-id": WEB_USER_ID,
          "x-harness-session-id": sessionId,
        },
        body: JSON.stringify({
          id: WEB_CONVERSATION_ID,
          sessionId,
          messages: [webMessage(message)],
        }),
      }),
    );
    // The demo stream harnesses return the reply as the response body, so reading it back is enough
    // to display the assistant turn offline (a live model would stream the AI SDK UI-message protocol).
    const protocolText = await response.text();
    replyText = inventoryReplyText ?? protocolText;
  } finally {
    await loaded.close();
  }

  return {
    surface: SUPPORT_WEB_CONNECTOR_ID,
    sessionId,
    availableTools,
    messages: [
      { id: "web-user", role: "user", connectorId: SUPPORT_WEB_CONNECTOR_ID, text: message },
      {
        id: "web-assistant",
        role: "assistant",
        connectorId: SUPPORT_WEB_CONNECTOR_ID,
        text: replyText,
      },
    ],
  };
}

export async function runDiscordChatDemoTurn(
  input: ConnectorChatDemoInput,
  options: RunnerOptions = {},
): Promise<ConnectorChatDemoResult> {
  const message = validateMessage(input);
  const sessionId = chatDemoSessionId();
  const channelUpdates: SendChannelUpdateOutput[] = [];
  let availableTools: string[] = [];
  const loadOptions = createDiscordConnectorLoadOptions();
  // Swap the real Discord adapter/state for inert doubles so no live workspace is contacted.
  const demoDiscordConnector = {
    ...discordConnector,
    adapter: { name: "discord", create: () => ({ name: "discord" }) },
    state: () => ({}),
  };
  const runStreamHarness: DemoStreamHarness = (streamOptions) => {
    const connectorToolNames = Object.keys(streamOptions.connectorTools ?? {});
    // Effective toolset = the agent's base tools plus this connector's structural tools, narrowed by
    // the descriptor's toolPolicy — no whitelist, so `send-channel-update` shows up only because it
    // lives in `connectors/discord/tools/`.
    availableTools = applyPolicyToNames(
      [...SUPPORT_BASE_TOOL_NAMES, ...connectorToolNames],
      discordConnector.toolPolicy,
    );
    if (isToolInventoryQuestion(message)) {
      const baseTools = availableTools.filter((toolName) => !connectorToolNames.includes(toolName));
      const connectorTools = connectorToolNames.filter((toolName) => availableTools.includes(toolName));
      return textHarnessResult(
        formatToolInventory("Discord", baseTools, connectorTools),
        "chat-demo-discord-tools",
      );
    }
    if (options.streamHarness !== undefined) return options.streamHarness(streamOptions);
    return discordToolStream(streamOptions, message, (output) => channelUpdates.push(output));
  };
  const loaded = await loadChatSdkConnector<SupportDiscordExtraBody>({
    ...loadOptions,
    connector: demoDiscordConnector,
    connectorId: SUPPORT_DISCORD_CONNECTOR_ID,
    // Zero-cast Chat SDK double; records the trigger handlers so `simulateInbound` can run the pipeline.
    createChat: createTestChat({ adapterName: "discord" }),
    streamHarness: runStreamHarness,
    ...(options.loadHarness === undefined ? {} : { loadHarness: options.loadHarness }),
  });

  const discordMessage = createTestMessage({
    id: "chat_demo_discord_user",
    text: message,
    threadId: DISCORD_THREAD_ID,
    userKey: DISCORD_USER_ID,
    raw: { harnessSessionId: sessionId },
    author: {
      userId: DISCORD_USER_ID,
      userName: "discord-teammate",
      fullName: "Discord Teammate",
      isMe: false,
    },
  });
  const thread = createTestThread({
    id: DISCORD_THREAD_ID,
    adapterName: "discord",
    messages: [discordMessage],
  });
  await loaded.simulateInbound({ thread, message: discordMessage });
  await loaded.close();

  const postedText = thread.posts.at(-1) ?? "No Discord response was posted.";
  const update = channelUpdates.at(-1);
  const messages: ConnectorChatMessage[] = [
    { id: "discord-user", role: "user", connectorId: SUPPORT_DISCORD_CONNECTOR_ID, text: message },
  ];
  if (update !== undefined) {
    messages.push({
      id: "discord-tool",
      role: "tool",
      connectorId: SUPPORT_DISCORD_CONNECTOR_ID,
      toolName: "send-channel-update",
      text: `${update.message} Audit ${update.auditId}.`,
    });
  }
  messages.push({
    id: "discord-assistant",
    role: "assistant",
    connectorId: SUPPORT_DISCORD_CONNECTOR_ID,
    text: postedText,
  });

  return {
    surface: SUPPORT_DISCORD_CONNECTOR_ID,
    sessionId,
    availableTools,
    messages,
  };
}
