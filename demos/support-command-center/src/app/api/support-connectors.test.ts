import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UIMessage } from "ai";
import { createHarness, localHost } from "little-harness";
import {
  attachSessionConnector,
  listSessionConnectors,
  loadWebRichConnector,
} from "little-harness/connectors";
import type { StreamHarnessFinished } from "little-harness/execution";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  clearSupportMirrorDeliveries,
  listSupportMirrorDeliveries,
  recordSupportMirrorDelivery,
} from "../../../agents/support/connectors/shared/mirror-delivery";
import discordConnector from "../../../agents/support/connectors/discord/connector";
import webRichConnector from "../../../agents/support/connectors/web-rich/connector";
import {
  createWebConnectorLoadOptions,
  SUPPORT_WEB_CONNECTOR_ID,
} from "./chat/route";
import {
  createDiscordConnectorLoadOptions,
  SUPPORT_DISCORD_CONNECTOR_ID,
} from "./discord/connector";

const model = { modelId: "mock", specificationVersion: "v2", provider: "mock" } as any;
const requestMessages: UIMessage[] = [
  { id: "m1", role: "user", parts: [{ type: "text", text: "Show the customer status." }] },
];
const tempDirs: string[] = [];
type ToolDemoRouteModule = typeof import("./discord/tool-demo/route");
type ChatDemoRunnerModule = typeof import("./chat-demo/runner");

async function mockSupportHarness() {
  const dataDir = await mkdtemp(join(tmpdir(), "support-demo-harness-"));
  tempDirs.push(dataDir);
  return createHarness({ host: localHost({ dataDir }), model });
}

beforeEach(() => {
  clearSupportMirrorDeliveries();
});

afterEach(async () => {
  clearSupportMirrorDeliveries();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("support connector route wiring", () => {
  test("loads web and Discord connectors by descriptor + connectorId so discovery features are active", () => {
    const webOptions = createWebConnectorLoadOptions();
    const discordOptions = createDiscordConnectorLoadOptions();

    expect(SUPPORT_WEB_CONNECTOR_ID).toBe("web-rich");
    expect(SUPPORT_DISCORD_CONNECTOR_ID).toBe("discord");
    // Typed descriptor object + connectorId (not a bare string id): infers the generics and still
    // enables connector-scoped tools, session attachment, and mirror delivery.
    expect(webOptions.connector).toBe(webRichConnector);
    expect(webOptions.connectorId).toBe(SUPPORT_WEB_CONNECTOR_ID);
    expect(discordOptions.connector).toBe(discordConnector);
    expect(discordOptions.connectorId).toBe(SUPPORT_DISCORD_CONNECTOR_ID);
  });

  test("uses the first-class mirror flow: previousActive + descriptor-owned deliverers", () => {
    const webOptions = createWebConnectorLoadOptions();
    const discordOptions = createDiscordConnectorLoadOptions();

    // Deliverers moved onto the connector descriptors; the load options only carry the
    // previousActive:"mirror" hand-off policy plus an onError sink.
    expect(webOptions.delivery?.previousActive).toBe("mirror");
    expect(discordOptions.delivery?.previousActive).toBe("mirror");
    expect(webOptions.delivery?.deliverers).toBeUndefined();
    expect(discordOptions.delivery?.deliverers).toBeUndefined();
    expect(webOptions.delivery?.onError).toEqual(expect.any(Function));
    expect(discordOptions.delivery?.onError).toEqual(expect.any(Function));
    expect(webRichConnector.deliver).toEqual(expect.any(Function));
    expect(discordConnector.deliver).toEqual(expect.any(Function));
  });

  test("routes rely on descriptor toolPolicy instead of route-level activeTools overrides", () => {
    expect(createWebConnectorLoadOptions().streamHarness).toBeUndefined();
    expect(createDiscordConnectorLoadOptions().streamHarness).toBeUndefined();
    // Web needs no policy (full structural toolset); Discord narrows with a targeted deny.
    expect(webRichConnector.toolPolicy).toBeUndefined();
    expect(discordConnector.toolPolicy).toEqual({
      deny: ["evaluate-refund-policy", "create-escalation"],
    });
  });

  test("chat demo routes return clean 400 JSON for invalid request bodies", async () => {
    const [webRoute, discordRoute] = await Promise.all([
      import("./chat-demo/web/route"),
      import("./chat-demo/discord/route"),
    ]);

    for (const route of [webRoute, discordRoute]) {
      const nonJson = await route.POST(new Request("https://support.example.test/api/chat-demo", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not-json",
      }));
      await expect(nonJson.json()).resolves.toEqual({ error: "Message is required." });
      expect(nonJson.status).toBe(400);

      const missingMessage = await route.POST(jsonRequest({}));
      await expect(missingMessage.json()).resolves.toEqual({ error: "Message is required." });
      expect(missingMessage.status).toBe(400);
    }
  });

  test("mirror delivery records can be scoped without clearing other chat demo runs", async () => {
    await recordSupportMirrorDelivery({
      sessionId: "support:chat-demo:a",
      session: {} as any,
      active: { connectorId: "web-rich", delivery: "active", endpoint: {} } as any,
      target: { connectorId: "discord", delivery: "mirror", endpoint: { threadId: "a" } } as any,
      text: "Reply A",
    } as any);
    await recordSupportMirrorDelivery({
      sessionId: "support:chat-demo:b",
      session: {} as any,
      active: { connectorId: "web-rich", delivery: "active", endpoint: {} } as any,
      target: { connectorId: "discord", delivery: "mirror", endpoint: { threadId: "b" } } as any,
      text: "Reply B",
    } as any);

    clearSupportMirrorDeliveries({ sessionId: "support:chat-demo:a" });

    expect(listSupportMirrorDeliveries()).toEqual([
      expect.objectContaining({ sessionId: "support:chat-demo:b", text: "Reply B" }),
    ]);
  });

  test("runs a Discord connector-specific tool demo without exposing that tool to web-rich", async () => {
    const routeModule = (await import("./discord/tool-demo/route").catch(
      (error: unknown) => error as Error,
    )) as ToolDemoRouteModule | Error;

    expect(routeModule).not.toBeInstanceOf(Error);
    if (routeModule instanceof Error) return;

    const result = await routeModule.runDiscordConnectorToolDemo();

    expect(result).toMatchObject({
      connectorId: "discord",
      toolName: "send-channel-update",
      webRichExposesTool: false,
      output: {
        delivered: true,
        connector: "discord",
        channel: "discord_thread_demo",
        audience: "internal_support",
      },
    });
    expect(result.discordToolNames).toContain("send-channel-update");
    expect(result.webRichToolNames).not.toContain("send-channel-update");
  });

  test("runs web and Discord-style connector turns against one portable session", async () => {
    const runnerModule = (await import("./portable-demo/runner").catch(
      (error: unknown) => error as Error,
    )) as typeof import("./portable-demo/runner") | Error;

    expect(runnerModule).not.toBeInstanceOf(Error);
    if (runnerModule instanceof Error) return;

    const harness = await mockSupportHarness();
    const loadHarness = async () => harness;
    const web = await runnerModule.runPortableWebTurn({
      loadHarness,
      streamHarness: () => streamResult("Web reply for the shared session."),
    });
    const discord = await runnerModule.runPortableDiscordTurn({
      loadHarness,
      streamHarness: (options) => {
        expect(options.session).toBe(runnerModule.PORTABLE_DEMO_SESSION_ID);
        expect(options.connectorTools).toHaveProperty("send-channel-update");
        return streamResult("Discord reply for the shared session.");
      },
    });

    expect(web.sessionId).toBe(runnerModule.PORTABLE_DEMO_SESSION_ID);
    expect(web.replyText).toBe("Web reply for the shared session.");
    expect(web.transcript).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          connectorId: "web-rich",
          direction: "inbound",
          text: expect.stringContaining("Start the portable HelioSoft support session"),
        }),
        expect.objectContaining({
          connectorId: "web-rich",
          direction: "outbound",
          text: "Web reply for the shared session.",
        }),
      ]),
    );
    expect(discord.sessionId).toBe(runnerModule.PORTABLE_DEMO_SESSION_ID);
    expect(discord.postedText).toBe("Discord reply for the shared session.");
    expect(discord.replyText).toBe("Discord reply for the shared session.");
    expect(discord.transcript).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          connectorId: "discord",
          direction: "inbound",
          text: expect.stringContaining("Continue the same HelioSoft portable support session"),
        }),
        expect.objectContaining({
          connectorId: "discord",
          direction: "outbound",
          text: "Discord reply for the shared session.",
        }),
      ]),
    );
    expect(discord.connectorToolNames).toContain("send-channel-update");
    expect(discord.connectors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ connectorId: "discord", delivery: "active" }),
        expect.objectContaining({ connectorId: "web-rich", delivery: "mirror" }),
      ]),
    );
  }, 20_000);

  test("chat demo returns visible messages and only Discord has connector-specific tool output", async () => {
    const runnerModule = (await import("./chat-demo/runner").catch(
      (error: unknown) => error as Error,
    )) as ChatDemoRunnerModule | Error;

    expect(runnerModule).not.toBeInstanceOf(Error);
    if (runnerModule instanceof Error) return;

    const harness = await mockSupportHarness();
    const loadHarness = async () => harness;
    const web = await runnerModule.runWebChatDemoTurn(
      { message: "Summarize HelioSoft duplicate support charge." },
      { loadHarness, streamHarness: () => streamResult("Web assistant reply.") },
    );
    const discord = await runnerModule.runDiscordChatDemoTurn({
      message: "Post a Discord update for HelioSoft refund approval.",
    }, {
      loadHarness,
    });

    expect(web.messages).toEqual([
      expect.objectContaining({ role: "user", connectorId: "web-rich" }),
      expect.objectContaining({ role: "assistant", connectorId: "web-rich", text: "Web assistant reply." }),
    ]);
    expect(
      listSupportMirrorDeliveries().filter((delivery) => delivery.sessionId === web.sessionId),
    ).toEqual([]);
    expect(web.messages.some((message) => message.role === "tool")).toBe(false);
    expect(discord.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "user", connectorId: "discord" }),
        expect.objectContaining({
          role: "tool",
          connectorId: "discord",
          toolName: "send-channel-update",
          text: expect.stringContaining("discord_cust_enterprise_helio_discord_demo_user_high"),
        }),
        expect.objectContaining({
          role: "assistant",
          connectorId: "discord",
          text: expect.stringContaining("Discord connector update sent"),
        }),
      ]),
    );
  }, 20_000);

  test("chat demo answers available-tool questions per active connector", async () => {
    const runnerModule = (await import("./chat-demo/runner").catch(
      (error: unknown) => error as Error,
    )) as ChatDemoRunnerModule | Error;

    expect(runnerModule).not.toBeInstanceOf(Error);
    if (runnerModule instanceof Error) return;

    const harness = await mockSupportHarness();
    const loadHarness = async () => harness;
    const web = await runnerModule.runWebChatDemoTurn(
      { message: "What tools are available to you in the web connector?" },
      { loadHarness, streamHarness: () => streamResult("Unexpected live model answer.") },
    );
    const discord = await runnerModule.runDiscordChatDemoTurn({
      message: "What tools are available to you in the Discord connector?",
    }, {
      loadHarness,
    });

    const webReply = web.messages.find((message) => message.role === "assistant")?.text ?? "";
    const discordReply = discord.messages.find((message) => message.role === "assistant")?.text ?? "";

    expect(web.availableTools).toEqual([
      "lookup-customer",
      "lookup-orders",
      "check-service-status",
      "summarize-ticket-history",
      "evaluate-refund-policy",
      "create-escalation",
    ]);
    expect(discord.availableTools).toEqual([
      "lookup-customer",
      "lookup-orders",
      "check-service-status",
      "summarize-ticket-history",
      "send-channel-update",
    ]);
    expect(webReply).toContain("evaluate-refund-policy");
    expect(webReply).toContain("create-escalation");
    expect(webReply).not.toContain("send-channel-update");
    expect(discordReply).toContain("send-channel-update");
    expect(discordReply).not.toContain("evaluate-refund-policy");
    expect(discord.messages.some((message) => message.role === "tool")).toBe(false);
  });

  test("web connector attaches the active endpoint and mirrors successful text to Discord", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "support-demo-web-"));
    tempDirs.push(dataDir);
    const harness = createHarness({ host: localHost({ dataDir }), model });
    const loaded = await loadWebRichConnector({
      ...createWebConnectorLoadOptions(),
      loadHarness: async () => harness,
      streamHarness: () => streamResult("The refund path is ready."),
    });
    const session = await loaded.harness.sessions.getOrCreate({
      id: "support:web:operator_1:conversation_1",
    });
    await attachSessionConnector(session, {
      connectorId: "discord",
      kind: "chat-sdk",
      delivery: "mirror",
      endpoint: {
        id: "discord:thread_1",
        platform: "discord",
        threadId: "thread_1",
        userId: "discord_user_1",
      },
    });

    await loaded.POST(jsonRequest(
      { id: "conversation_1", messages: requestMessages },
      { "x-support-user-id": "operator_1" },
    ));
    for (let attempt = 0; attempt < 10 && listSupportMirrorDeliveries().length === 0; attempt += 1) {
      await flushPromises();
    }

    await expect(listSessionConnectors(session)).resolves.toEqual([
      expect.objectContaining({ connectorId: "discord", delivery: "mirror" }),
      expect.objectContaining({
        connectorId: "web-rich",
        delivery: "active",
        endpoint: expect.objectContaining({
          id: "operator_1:conversation_1",
          platform: "web",
          threadId: "conversation_1",
          userId: "operator_1",
        }),
      }),
    ]);
    expect(listSupportMirrorDeliveries()).toEqual([
      expect.objectContaining({
        connectorId: "discord",
        sourceConnectorId: "web-rich",
        sessionId: "support:web:operator_1:conversation_1",
        text: "The refund path is ready.",
        targetEndpoint: expect.objectContaining({ threadId: "thread_1" }),
      }),
    ]);
  });
});

function jsonRequest(body: unknown, headers: HeadersInit = {}): Request {
  return new Request("https://support.example.test/api/chat", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
  });
}

function streamResult(text: string) {
  return {
    text: Promise.resolve(text),
    output: Promise.resolve(text),
    textStream: (async function* () {
      yield text;
    })(),
    toUIMessageStream: () => new ReadableStream(),
    toUIMessageStreamResponse: vi.fn(() => new Response(text)),
    finished: Promise.resolve({
      status: "completed",
      session: {} as any,
      artifacts: [],
      trace: { id: "trace" },
      persistence: { status: "not-configured" },
      warnings: [],
      commitManual: async () => ({ status: "not-configured" }),
    } satisfies StreamHarnessFinished),
  };
}

async function flushPromises() {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
}
