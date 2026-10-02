import { join } from "node:path";
import type { UIMessage } from "ai";
import { describe, expect, it, vi } from "vitest";
import { createHarness } from "../create-harness.js";
import type { StreamHarnessFinished } from "../execution/result.js";
import { localHost } from "../local-host/index.js";
import { loadChatSdkConnector } from "./chat-sdk.js";
import { chatSdkConnector } from "./descriptors.js";
import { listSessionConnectors } from "./session-registry.js";
import { createTestChat, createTestMessage, createTestThread } from "./testing.js";

const model = { modelId: "mock", specificationVersion: "v2", provider: "mock" } as any;

function harness() {
  return createHarness({ host: localHost(), model });
}

function streamResult(text = "ok", finished: Promise<StreamHarnessFinished> = finishedResult()) {
  return {
    text: Promise.resolve(text),
    output: Promise.resolve(text),
    textStream: (async function* () {
      yield text;
    })(),
    toUIMessageStream: () => new ReadableStream(),
    toUIMessageStreamResponse: () => new Response(text),
    finished,
  };
}

function finishedResult(): Promise<StreamHarnessFinished> {
  return Promise.resolve({
    session: {} as any,
    artifacts: [],
    trace: { id: "trace" },
    persistence: { status: "not-configured" },
    warnings: [],
    commitManual: async () => ({ status: "not-configured" }),
  } as any);
}

describe("createTestMessage", () => {
  it("fills sensible defaults and auto-increments ids", () => {
    const first = createTestMessage();
    const second = createTestMessage();
    expect(first.id).not.toBe(second.id);
    expect(first.text).toBe("test message");
    expect(first.author).toEqual({ userId: "test-user", userName: "tester", isMe: false });
    expect(first.threadId).toBe("test-thread");
  });

  it("maps the `text` convenience field and keeps overrides", () => {
    const message = createTestMessage({ id: "m1", text: "hello", userKey: "slack:U1" });
    expect(message).toMatchObject({ id: "m1", text: "hello", userKey: "slack:U1" });
  });
});

describe("createTestThread", () => {
  it("records streamed post text, subscribe calls, and typing statuses", async () => {
    const thread = createTestThread({ id: "T7", adapterName: "slack", isDM: true });
    expect(thread.id).toBe("T7");
    expect(thread.adapter.name).toBe("slack");
    expect(thread.isDM).toBe(true);

    async function* chunks() {
      yield "hel";
      yield "lo";
    }
    await thread.post(chunks());
    await thread.post("plain string");
    await thread.subscribe?.();
    await thread.startTyping?.("thinking");

    expect(thread.posts).toEqual(["hello", "plain string"]);
    expect(thread.subscribeCalls).toBe(1);
    expect(thread.typingStatuses).toEqual(["thinking"]);
  });

  it("exposes provided messages as a newest-first async-iterable history", async () => {
    const thread = createTestThread({
      messages: [createTestMessage({ id: "new", text: "newest" }), createTestMessage({ id: "old", text: "oldest" })],
    });
    const ids: string[] = [];
    for await (const item of thread.messages!) ids.push(item.id);
    expect(ids).toEqual(["new", "old"]);
  });
});

describe("createTestChat", () => {
  it("records trigger handlers, exposes instances, and serves 200 webhooks", async () => {
    const TestChat = createTestChat();
    const chat = new TestChat({ adapters: { slack: { name: "slack" } } });

    expect(TestChat.instances).toEqual([chat]);
    chat.onDirectMessage(() => {});
    chat.onNewMention(() => {});
    chat.onSubscribedMessage(() => {});
    expect(chat.handlers.directMessage).toHaveLength(1);
    expect(chat.handlers.mention).toHaveLength(1);
    expect(chat.handlers.subscribedMessage).toHaveLength(1);

    const response = await chat.webhooks.slack!(new Request("https://example.com"));
    expect(response.status).toBe(200);

    await chat.initialize?.();
    await chat.shutdown?.();
    expect(chat.initializeCalls).toBe(1);
    expect(chat.shutdownCalls).toBe(1);
  });
});

describe("simulateInbound", () => {
  it("drives a full turn end to end: posts the reply and writes the active session attachment", async () => {
    const calls: Array<{ session?: string; messages: UIMessage[] | undefined }> = [];
    const loaded = await loadChatSdkConnector({
      agentDir: "agents/support",
      connectorId: "slack",
      connector: chatSdkConnector({
        userName: "support",
        adapter: { name: "slack", create: () => ({ name: "slack" }) },
        state: () => ({}),
        session: () => "slack:simulated",
      }),
      loadHarness: async () => harness(),
      loadConnectorToolExtensions: async (_agentDir, _connectorId, baseTools) => baseTools,
      createChat: createTestChat(),
      streamHarness: (options) => {
        calls.push({ session: options.session as string, messages: options.messages });
        return streamResult("simulated reply");
      },
    });

    const thread = createTestThread({ id: "T1" });
    await loaded.simulateInbound({
      thread,
      message: createTestMessage({ text: "hi there", userKey: "slack:U1" }),
    });

    // Reply posted through the same run pipeline as a real trigger.
    expect(thread.posts).toEqual(["simulated reply"]);
    expect(calls[0]?.session).toBe("slack:simulated");

    // Active connector endpoint attached to the resolved session.
    const session = await loaded.harness.sessions.get("slack:simulated");
    expect(session).toBeDefined();
    expect(await listSessionConnectors(session!)).toMatchObject([
      {
        connectorId: "slack",
        kind: "chat-sdk",
        delivery: "active",
        endpoint: {
          id: "slack:T1",
          platform: "slack",
          threadId: "T1",
          userId: "slack:U1",
        },
      },
    ]);
  });

  it("defaults the trigger to directMessage", async () => {
    const triggers: string[] = [];
    const loaded = await loadChatSdkConnector({
      agentDir: "agents/support",
      connectorId: "slack",
      connector: chatSdkConnector({
        userName: "support",
        adapter: { name: "slack", create: () => ({ name: "slack" }) },
        state: () => ({}),
        session: () => "slack:default-trigger",
        beforeRun: (ctx) => {
          triggers.push(ctx.trigger);
        },
      }),
      loadHarness: async () => harness(),
      loadConnectorToolExtensions: async (_agentDir, _connectorId, baseTools) => baseTools,
      createChat: createTestChat(),
      streamHarness: () => streamResult(),
    });

    await loaded.simulateInbound({ thread: createTestThread(), message: createTestMessage() });

    expect(triggers).toEqual(["directMessage"]);
  });

  it("drives a custom trigger and bypasses the enabled-trigger gate", async () => {
    const triggers: string[] = [];
    const afterReply = vi.fn();
    const TestChat = createTestChat();
    const loaded = await loadChatSdkConnector({
      agentDir: "agents/support",
      connectorId: "slack",
      connector: chatSdkConnector({
        userName: "support",
        adapter: { name: "slack", create: () => ({ name: "slack" }) },
        state: () => ({}),
        session: () => "slack:custom-trigger",
        // subscribedMessage is NOT enabled here, so no live handler is registered; simulateInbound
        // must still be able to drive it as an explicit developer action.
        triggers: { subscribedMessage: false, mention: { subscribe: true } },
        beforeRun: (ctx) => {
          triggers.push(ctx.trigger);
        },
        afterReply,
      }),
      loadHarness: async () => harness(),
      loadConnectorToolExtensions: async (_agentDir, _connectorId, baseTools) => baseTools,
      createChat: TestChat,
      streamHarness: () => streamResult(),
    });

    // No subscribed-message handler was registered on the chat (trigger disabled)...
    expect(TestChat.instances[0]!.handlers.subscribedMessage).toHaveLength(0);

    // ...but simulateInbound still runs the subscribedMessage pipeline.
    await loaded.simulateInbound({ trigger: "subscribedMessage", thread: createTestThread(), message: createTestMessage() });

    // A mention run auto-subscribes because triggers.mention.subscribe is set.
    const mentionThread = createTestThread();
    await loaded.simulateInbound({ trigger: "mention", thread: mentionThread, message: createTestMessage() });

    expect(triggers).toEqual(["subscribedMessage", "mention"]);
    expect(mentionThread.subscribeCalls).toBe(1);
    expect(afterReply).toHaveBeenCalledTimes(2);
  });

  it("drives the recorded chat handlers directly without simulateInbound (cast-free instance access)", async () => {
    const posted: string[] = [];
    const TestChat = createTestChat();
    await loadChatSdkConnector({
      agentDir: "agents/support",
      connectorId: "slack",
      connector: chatSdkConnector({
        userName: "support",
        adapter: { name: "slack", create: () => ({ name: "slack" }) },
        state: () => ({}),
        session: () => "slack:handlers",
      }),
      loadHarness: async () => harness(),
      loadConnectorToolExtensions: async (_agentDir, _connectorId, baseTools) => baseTools,
      createChat: TestChat,
      streamHarness: () => streamResult("via handler"),
    });

    const chat = TestChat.instances[0]!;
    const thread = createTestThread();
    await chat.handlers.directMessage[0]!(thread, createTestMessage({ text: "hi" }));

    posted.push(...thread.posts);
    expect(posted).toEqual(["via handler"]);
  });

  it("typechecks with zero casts when wiring the helpers into loadChatSdkConnector", async () => {
    // The point of this test is that it COMPILES: createTestChat()/createTestThread()/
    // createTestMessage() satisfy the loader's structural types with no `as` casts in user code.
    const loaded = await loadChatSdkConnector({
      agentDir: "agents/support",
      connectorId: "slack",
      connector: chatSdkConnector({
        userName: "support",
        adapter: { name: "slack", create: () => ({ name: "slack" }) },
        state: () => ({}),
        session: () => "slack:typecheck",
      }),
      loadHarness: async () => harness(),
      loadConnectorToolExtensions: async (_agentDir, _connectorId, baseTools) => baseTools,
      createChat: createTestChat({ adapterName: "slack" }),
      streamHarness: () => streamResult(),
    });

    const thread = createTestThread({ id: "T1", adapterName: "slack", isDM: true });
    await loaded.simulateInbound({ thread, message: createTestMessage({ text: "hi" }) });

    expect(thread.posts).toEqual(["ok"]);
  });
});
