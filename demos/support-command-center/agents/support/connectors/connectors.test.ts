import { join } from "node:path";
import { discoverConnectors, loadConnectorToolExtensions } from "little-harness/connectors";
import { describe, expect, test } from "vitest";
import discord from "./discord/connector";
import webRich from "./web-rich/connector";

const agentDir = join(import.meta.dirname, "..");

function message(overrides: Record<string, unknown> = {}) {
  return {
    id: "msg_1",
    text: "Customer acme is asking about a delayed shipment.",
    threadId: "thread_1",
    author: {
      userId: "discord_user_1",
      userName: "sam",
      fullName: "Sam Support",
      isMe: false,
    },
    ...overrides,
  } as never;
}

describe("web-rich connector", () => {
  test("uses a stable support-operator identity and session key", async () => {
    const request = new Request("https://support.example.test/api/chat", {
      headers: {
        "x-support-user-id": "operator_7",
        "x-support-user-name": "Avery Support",
      },
    });
    const body = { id: "conversation_42", messages: [] };
    const user = await webRich.authenticate(request);

    expect(webRich.kind).toBe("web-rich");
    expect(user).toEqual({
      id: "operator_7",
      name: "Avery Support",
      email: "support.manager@example.com",
    });
    expect(await webRich.session({ request, body, user: user! })).toBe(
      "support:web:operator_7:conversation_42",
    );
  });

  test("derives server-owned extra body for the web surface", async () => {
    const request = new Request("https://support.example.test/api/chat");
    const body = { id: "conversation_99", messages: [] };
    const user = (await webRich.authenticate(request))!;

    await expect(Promise.resolve(webRich.extraBody?.({ request, body, user }))).resolves.toEqual({
      platform: "web",
      userId: "demo-support-manager",
      conversationId: "conversation_99",
      channel: "support-command-center",
    });
  });

  test("accepts an explicit portable session id for the web surface", async () => {
    const request = new Request("https://support.example.test/api/chat", {
      headers: { "x-harness-session-id": "support:portable:helio" },
    });
    const body = { id: "conversation_99", messages: [] };
    const user = (await webRich.authenticate(request))!;

    await expect(Promise.resolve(webRich.session({ request, body, user }))).resolves.toBe(
      "support:portable:helio",
    );
  });
});

describe("support connector tool policy", () => {
  test("web takes the full structural toolset; Discord narrows it with a targeted deny", () => {
    // The web console needs no policy: it exposes every global support tool by structure, and
    // `send-channel-update` lives under connectors/discord/tools/ so it is never web-visible.
    expect(webRich.toolPolicy).toBeUndefined();

    // Discord opts out of the two heavier escalation/refund tools with a blacklist — no whitelist.
    expect(discord.toolPolicy).toEqual({ deny: ["evaluate-refund-policy", "create-escalation"] });
  });

  test("both connectors carry a descriptor-owned mirror deliverer", () => {
    expect(webRich.deliver).toEqual(expect.any(Function));
    expect(discord.deliver).toEqual(expect.any(Function));
  });
});

describe("discord connector", () => {
  test("declares a Discord Chat SDK adapter and support triggers", () => {
    expect(discord.kind).toBe("chat-sdk");
    expect(discord.adapter.name).toBe("discord");
    expect(discord.triggers).toEqual({
      directMessage: true,
      mention: { subscribe: true },
      subscribedMessage: true,
    });
  });

  test("derives Discord extra body from thread and message context", async () => {
    const thread = {
      id: "discord_thread_1",
      adapter: { name: "discord" },
      post: async () => ({}),
    };
    const extra = await discord.extraBody?.({
      harness: {} as never,
      chat: {} as never,
      adapterName: "discord",
      thread,
      message: message(),
      trigger: "mention",
    });

    expect(extra).toEqual({
      platform: "discord",
      threadId: "discord_thread_1",
      userId: "discord_user_1",
      trigger: "mention",
    });
  });

  test("accepts an explicit portable session id for Discord-style messages", async () => {
    const thread = {
      id: "discord_thread_1",
      adapter: { name: "discord" },
      post: async () => ({}),
    };

    await expect(
      Promise.resolve(discord.session?.({
        harness: {} as never,
        chat: {} as never,
        adapterName: "discord",
        thread,
        message: message({
          raw: { harnessSessionId: "support:portable:helio" },
        }),
        trigger: "mention",
      } as never)),
    ).resolves.toBe("support:portable:helio");
  });
});

describe("connector discovery showcase", () => {
  test("discovers only the nested demo connectors", async () => {
    await expect(discoverConnectors(agentDir)).resolves.toEqual([
      expect.objectContaining({ id: "discord", kind: "chat-sdk" }),
      expect.objectContaining({ id: "web-rich", kind: "web-rich" }),
    ]);
  });

  test("exposes a Discord-only connector tool extension", async () => {
    const discordTools = await loadConnectorToolExtensions(agentDir, "discord", {});
    const webTools = await loadConnectorToolExtensions(agentDir, "web-rich", {});
    const sendChannelUpdate = discordTools["send-channel-update"] as {
      execute?: (
        input: { customerId: string; summary: string; urgency: "normal" | "high" },
        options: unknown,
      ) => Promise<unknown>;
    };

    expect(sendChannelUpdate?.execute).toEqual(expect.any(Function));
    expect(webTools).toEqual({});
    await expect(
      sendChannelUpdate.execute?.(
        {
          customerId: "cust_enterprise_helio",
          summary: "Refund approval is ready for review.",
          urgency: "high",
        },
        {
          // The harness spreads session/files (plus the active connector) into a tool's execute
          // options; tryHarnessToolContext reads the typed endpoint back from that shape.
          session: {},
          files: {},
          connector: {
            id: "discord",
            endpoint: { threadId: "discord_thread_1", userId: "discord_user_1" },
          },
        },
      ),
    ).resolves.toMatchObject({
      delivered: true,
      connector: "discord",
      channel: "discord_thread_1",
      audience: "internal_support",
    });
  });
});
