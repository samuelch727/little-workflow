import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { UIMessage } from "ai";
import { convertToModelMessages } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness } from "../create-harness.js";
import { HarnessInputError } from "../errors.js";
import type { StreamHarnessFinished } from "../execution/result.js";
import { localHost } from "../local-host/index.js";
import { aggregateLocalOutcomes } from "../trace/inspect.js";
import { stageChatMessages } from "../execution/stage-message.js";
import {
  chatSdkConnector,
  webRichConnector,
  type ChatSdkAttachment,
  type ChatSdkAttachmentOptions,
  type ChatSdkAttachmentSkip,
  type ChatSdkChatLike,
  type ChatSdkMessage,
  type ChatSdkMessageContext,
  type ChatSdkReactionEvent,
  type ChatSdkThread,
  type ConnectorHistoryPolicy,
} from "./descriptors.js";
import { loadConnectorToolExtensions } from "./discovery.js";
import { loadChatSdkConnector, messageToUIMessage } from "./chat-sdk.js";
import {
  attachSessionConnector,
  listSessionConnectors,
} from "./session-registry.js";
import { createTestChat, createTestMessage, createTestThread } from "./testing.js";

const model = { modelId: "mock", specificationVersion: "v2", provider: "mock" } as any;
const descriptorPath = resolve(import.meta.dirname, "descriptors.ts");
const toolExtensionsPath = resolve(import.meta.dirname, "tool-extensions.ts");
const dirs: string[] = [];

afterEach(async () => {
  FakeChat.last = undefined;
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

class FakeChat {
  static last: FakeChat | undefined;
  webhooks: Record<string, (request: Request) => Promise<Response>>;
  directHandlers: Array<
    (
      thread: ChatSdkThread,
      message: ChatSdkMessage,
      channel?: unknown,
      context?: ChatSdkMessageContext,
    ) => Promise<void> | void
  > = [];
  mentionHandlers: Array<
    (
      thread: ChatSdkThread,
      message: ChatSdkMessage,
      context?: ChatSdkMessageContext,
    ) => Promise<void> | void
  > = [];
  subscribedHandlers: Array<
    (
      thread: ChatSdkThread,
      message: ChatSdkMessage,
      context?: ChatSdkMessageContext,
    ) => Promise<void> | void
  > = [];
  reactionHandlers: Array<(event: ChatSdkReactionEvent) => Promise<void> | void> = [];
  close = vi.fn(async () => {});

  constructor(readonly config: Record<string, any>) {
    FakeChat.last = this;
    this.webhooks = Object.fromEntries(
      Object.keys(config.adapters).map((name) => [name, async () => new Response(`webhook:${name}`)]),
    );
  }

  get transcripts() {
    return this.config.transcripts;
  }

  onDirectMessage(
    handler: (
      thread: ChatSdkThread,
      message: ChatSdkMessage,
      channel?: unknown,
      context?: ChatSdkMessageContext,
    ) => Promise<void> | void,
  ) {
    this.directHandlers.push(handler);
  }

  onNewMention(
    handler: (
      thread: ChatSdkThread,
      message: ChatSdkMessage,
      context?: ChatSdkMessageContext,
    ) => Promise<void> | void,
  ) {
    this.mentionHandlers.push(handler);
  }

  onSubscribedMessage(
    handler: (
      thread: ChatSdkThread,
      message: ChatSdkMessage,
      context?: ChatSdkMessageContext,
    ) => Promise<void> | void,
  ) {
    this.subscribedHandlers.push(handler);
  }

  onReaction(handler: (event: ChatSdkReactionEvent) => Promise<void> | void) {
    this.reactionHandlers.push(handler);
  }
}

/** A FakeChat without `onReaction`, standing in for an adapter that has no reaction events. */
class FakeChatWithoutReactions extends FakeChat {
  override onReaction = undefined as never;
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

function harness() {
  return createHarness({ host: localHost(), model });
}

// Isolates the session store per test so the shared on-disk `.little-harness` store cannot
// leak mirror attachments between mirror-delivery tests that reuse a session id.
function isolatedHarness(agentDir: string) {
  return createHarness({ host: localHost({ dataDir: join(agentDir, ".data") }), model });
}

function harnessWithTools() {
  return createHarness({
    host: localHost(),
    model,
    tools: {
      addReaction: {
        description: "Base reaction tool.",
        inputSchema: {} as any,
        execute: async () => ({ ok: true }),
      },
    } as any,
  });
}

function message(id: string, text: string, isMe = false, userKey?: string): ChatSdkMessage {
  return {
    id,
    text,
    threadId: "T1",
    ...(userKey === undefined ? {} : { userKey }),
    author: {
      userId: isMe ? "bot" : "u1",
      userName: isMe ? "support" : "sam",
      isMe,
    },
  };
}

function thread(messages?: ChatSdkMessage[]): ChatSdkThread & { posted: unknown[]; subscribed: number } {
  const result: any = {
    id: "T1",
    adapter: { name: "slack" },
    posted: [],
    subscribed: 0,
    async post(value: unknown) {
      this.posted.push(value);
      return { id: "sent_1" };
    },
    async subscribe() {
      this.subscribed += 1;
    },
  } as any;

  if (messages !== undefined) {
    result.messages = {
      async *[Symbol.asyncIterator]() {
        for (const item of messages) yield item;
      },
    };
  }

  return result;
}

async function tmpAgent() {
  const dir = await mkdtemp(join(tmpdir(), "lh-chat-sdk-"));
  dirs.push(dir);
  return join(dir, "agents", "support");
}

describe("messageToUIMessage", () => {
  it("maps Chat SDK message text and author direction to UIMessage text parts", () => {
    expect(messageToUIMessage(message("m1", "hello"))).toEqual({
      id: "m1",
      role: "user",
      parts: [{ type: "text", text: "hello" }],
    });
    expect(messageToUIMessage(message("m2", "done", true))).toEqual({
      id: "m2",
      role: "assistant",
      parts: [{ type: "text", text: "done" }],
    });
  });
});

describe("loadChatSdkConnector", () => {
  it("loads connector tool extensions for string connector ids and passes active connector context to streamHarness", async () => {
    const agent = await tmpAgent();
    await mkdir(join(agent, "connectors", "slack", "tools"), { recursive: true });
    await writeFile(
      join(agent, "connectors", "slack", "connector.ts"),
      `import { chatSdkConnector } from ${JSON.stringify(descriptorPath)};
       export default chatSdkConnector({
         userName: "support",
         adapter: { name: "slack", create: () => ({ name: "slack" }) },
         state: () => ({}),
         session: () => "slack:active"
       });`,
    );
    await writeFile(
      join(agent, "connectors", "slack", "tools", "addReaction.ts"),
      `import { extendTool } from ${JSON.stringify(toolExtensionsPath)};
       export default extendTool({} as any, { description: "Slack reaction tool." });`,
    );
    const calls: Array<{ connector: unknown; connectorTools: unknown }> = [];

    await loadChatSdkConnector({
      agentDir: agent,
      connector: "slack",
      loadHarness: async () => harnessWithTools(),
      loadConnectorToolExtensions,
      createChat: FakeChat,
      streamHarness: (options) => {
        calls.push({
          connector: options.connector,
          connectorTools: options.connectorTools,
        });
        return streamResult();
      },
    });

    await FakeChat.last!.directHandlers[0]!(thread(), message("m1", "hi", false, "slack:U1"));

    expect(calls[0]?.connector).toEqual({
      id: "slack",
      kind: "chat-sdk",
      endpoint: {
        id: "slack:T1",
        platform: "slack",
        threadId: "T1",
        userId: "slack:U1",
      },
    });
    expect(calls[0]?.connectorTools).toMatchObject({
      addReaction: { description: "Slack reaction tool." },
    });
  });

  it("passes the connector descriptor's toolPolicy to streamHarness", async () => {
    const agent = await tmpAgent();
    await mkdir(join(agent, "connectors", "slack"), { recursive: true });
    await writeFile(
      join(agent, "connectors", "slack", "connector.ts"),
      `import { chatSdkConnector } from ${JSON.stringify(descriptorPath)};
       export default chatSdkConnector({
         userName: "support",
         adapter: { name: "slack", create: () => ({ name: "slack" }) },
         state: () => ({}),
         session: () => "slack:active",
         toolPolicy: { deny: ["evaluate-refund-policy"] }
       });`,
    );
    const calls: Array<{ toolPolicy: unknown }> = [];

    await loadChatSdkConnector({
      agentDir: agent,
      connector: "slack",
      loadHarness: async () => harnessWithTools(),
      loadConnectorToolExtensions,
      createChat: FakeChat,
      streamHarness: (options) => {
        calls.push({ toolPolicy: options.toolPolicy });
        return streamResult();
      },
    });

    await FakeChat.last!.directHandlers[0]!(thread(), message("m1", "hi", false, "slack:U1"));

    expect(calls[0]?.toolPolicy).toEqual({ deny: ["evaluate-refund-policy"] });
  });

  it("attaches the active Chat SDK endpoint in the session registry", async () => {
    const agent = await tmpAgent();
    await mkdir(join(agent, "connectors", "slack"), { recursive: true });
    await writeFile(
      join(agent, "connectors", "slack", "connector.ts"),
      `import { chatSdkConnector } from ${JSON.stringify(descriptorPath)};
       export default chatSdkConnector({
         userName: "support",
         adapter: { name: "slack", create: () => ({ name: "slack" }) },
         state: () => ({}),
         session: () => "slack:active"
       });`,
    );
    // Refactored to the new test/simulation helpers (createTestChat + createTestThread +
    // createTestMessage) driven through `simulateInbound` — proving the helpers exercise the full run
    // pipeline end to end.
    const loaded = await loadChatSdkConnector({
      agentDir: agent,
      connector: "slack",
      loadHarness: async () => harness(),
      createChat: createTestChat(),
      streamHarness: () => streamResult(),
    });

    await loaded.simulateInbound({
      thread: createTestThread({ id: "T1" }),
      message: createTestMessage({ text: "hi", userKey: "slack:U1" }),
    });

    const session = await loaded.harness.sessions.get("slack:active");
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

  it("delivers final assistant text to registered mirror connector deliverers", async () => {
    const agent = await tmpAgent();
    await mkdir(join(agent, "connectors", "slack"), { recursive: true });
    await writeFile(
      join(agent, "connectors", "slack", "connector.ts"),
      `import { chatSdkConnector } from ${JSON.stringify(descriptorPath)};
       export default chatSdkConnector({
         userName: "support",
         adapter: { name: "slack", create: () => ({ name: "slack" }) },
         state: () => ({}),
         session: () => "slack:mirror"
       });`,
    );
    const deliver = vi.fn(async () => {});
    const loaded = await loadChatSdkConnector({
      agentDir: agent,
      connector: "slack",
      delivery: { deliverers: { discord: deliver } },
      loadHarness: async () => harness(),
      createChat: FakeChat,
      streamHarness: () => streamResult("mirrored reply"),
    });
    const session = await loaded.harness.sessions.getOrCreate({ id: "slack:mirror" });
    const mirror = await attachSessionConnector(session, {
      connectorId: "discord",
      kind: "chat-sdk",
      delivery: "mirror",
      endpoint: { id: "discord:thread", platform: "discord", threadId: "thread", userId: "u2" },
    });

    await FakeChat.last!.directHandlers[0]!(thread(), message("m1", "hi", false, "slack:U1"));

    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({
      session: expect.objectContaining({ id: "slack:mirror" }),
      sessionId: "slack:mirror",
      text: "mirrored reply",
      target: mirror,
      active: expect.objectContaining({ connectorId: "slack", delivery: "active" }),
    }));
  });

  it("does not deliver mirrors when text resolves but finished rejects", async () => {
    const agent = await tmpAgent();
    await mkdir(join(agent, "connectors", "slack"), { recursive: true });
    await writeFile(
      join(agent, "connectors", "slack", "connector.ts"),
      `import { chatSdkConnector } from ${JSON.stringify(descriptorPath)};
       export default chatSdkConnector({
         userName: "support",
         adapter: { name: "slack", create: () => ({ name: "slack" }) },
         state: () => ({}),
         session: () => "slack:mirror"
       });`,
    );
    const finished = Promise.reject(new Error("finished failed")) as Promise<StreamHarnessFinished>;
    finished.catch(() => {});
    const deliver = vi.fn(async () => {});
    const loaded = await loadChatSdkConnector({
      agentDir: agent,
      connector: "slack",
      delivery: { deliverers: { discord: deliver } },
      loadHarness: async () => harness(),
      createChat: FakeChat,
      streamHarness: () => streamResult("should not mirror", finished),
    });
    const session = await loaded.harness.sessions.getOrCreate({ id: "slack:mirror" });
    await attachSessionConnector(session, {
      connectorId: "discord",
      kind: "chat-sdk",
      delivery: "mirror",
      endpoint: { id: "discord:thread", platform: "discord", threadId: "thread", userId: "u2" },
    });

    const run = FakeChat.last!.directHandlers[0]!(thread(), message("m1", "hi", false, "slack:U1"));
    await expect(run).rejects.toThrow(/finished failed/u);

    expect(deliver).not.toHaveBeenCalled();
  });

  it("reports mirror selection errors through delivery.onError without failing the active handler", async () => {
    const deliver = vi.fn(async () => {});
    const deliveryError = vi.fn(async (_ctx: any) => {});
    const testHarness = harness();
    const getOrCreateSession = testHarness.sessions.getOrCreate.bind(testHarness.sessions);
    let failRegistryRead = false;
    testHarness.sessions.getOrCreate = async (options) => {
      const sessionRecord = await getOrCreateSession(options);
      const read = sessionRecord.files.read.bind(sessionRecord.files);
      sessionRecord.files.read = async (path, readOptions) => {
        if (failRegistryRead) {
          throw new Error("registry failed");
        }
        return read(path, readOptions);
      };
      return sessionRecord;
    };
    const loaded = await loadChatSdkConnector({
      agentDir: "agents/support",
      connectorId: "slack",
      connector: chatSdkConnector({
        userName: "support",
        adapter: { name: "slack", create: () => ({ name: "slack" }) },
        state: () => ({}),
        session: () => "slack:mirror",
        afterReply: async () => {
          failRegistryRead = true;
        },
      }),
      delivery: { deliverers: { discord: deliver }, onError: deliveryError },
      loadHarness: async () => testHarness,
      loadConnectorToolExtensions: async (_agentDir, _connectorId, baseTools) => baseTools,
      createChat: FakeChat,
      streamHarness: () => streamResult("mirrored reply"),
    });
    const session = await loaded.harness.sessions.getOrCreate({ id: "slack:mirror" });
    await attachSessionConnector(session, {
      connectorId: "discord",
      kind: "chat-sdk",
      delivery: "mirror",
      endpoint: { id: "discord:thread", platform: "discord", threadId: "thread", userId: "u2" },
    });

    await expect(
      FakeChat.last!.directHandlers[0]!(thread(), message("m1", "hi", false, "slack:U1")),
    ).resolves.toBeUndefined();

    expect(deliver).not.toHaveBeenCalled();
    expect(deliveryError.mock.calls.map(([ctx]) => ((ctx as any).error as Error).message)).toEqual([
      "registry failed",
    ]);
  });

  it("runs direct descriptor objects without connectorId and skips extension loading and session attachment", async () => {
    const calls: Array<{ connector: unknown; connectorTools: unknown }> = [];
    const loaded = await loadChatSdkConnector({
      agentDir: "agents/support",
      connector: chatSdkConnector({
        userName: "support",
        adapter: { name: "slack", create: () => ({ name: "slack" }) },
        state: () => ({}),
        session: () => "direct:T1",
      }),
      loadHarness: async () => harness(),
      createChat: FakeChat,
      streamHarness: (options) => {
        calls.push({ connector: options.connector, connectorTools: options.connectorTools });
        return streamResult();
      },
    });

    await FakeChat.last!.directHandlers[0]!(thread(), message("m1", "hi"));

    expect(calls).toEqual([{ connector: undefined, connectorTools: undefined }]);
    await expect(loaded.harness.sessions.get("direct:T1")).resolves.toBeUndefined();
  });

  it("constructs Chat with one adapter and state, connects state, registers configured triggers, and delegates webhooks", async () => {
    const connect = vi.fn(async () => {});
    const loaded = await loadChatSdkConnector({
      agentDir: "agents/support",
      connector: chatSdkConnector({
        userName: "support",
        adapter: { name: "slack", create: () => ({ name: "slack" }) },
        state: () => ({ connect }),
        triggers: { directMessage: true, mention: true, subscribedMessage: true },
      }),
      loadHarness: async () => harness(),
      createChat: FakeChat,
      streamHarness: () => streamResult(),
    });

    expect(loaded.adapterName).toBe("slack");
    expect(loaded.adapter).toEqual({ name: "slack" });
    expect(connect).toHaveBeenCalledOnce();
    expect(Object.keys(FakeChat.last!.config.adapters)).toEqual(["slack"]);
    expect(FakeChat.last!.config.adapters.slack).toEqual({ name: "slack" });
    expect(FakeChat.last!.config.state).toEqual({ connect });
    expect(FakeChat.last!.directHandlers).toHaveLength(1);
    expect(FakeChat.last!.mentionHandlers).toHaveLength(1);
    expect(FakeChat.last!.subscribedHandlers).toHaveLength(1);

    const response = await loaded.webhook(new Request("https://example.com"));
    expect(await response.text()).toBe("webhook:slack");
  });

  it("resolves string connector ids and rejects non-Chat SDK descriptors", async () => {
    const agent = await tmpAgent();
    await mkdir(join(agent, "connectors"), { recursive: true });
    await writeFile(
      join(agent, "connectors", "slack.ts"),
      `import { chatSdkConnector } from ${JSON.stringify(descriptorPath)};
       export default chatSdkConnector({
         userName: "support",
         adapter: { name: "slack", create: () => ({ name: "slack" }) },
         state: () => ({})
       });`,
    );
    await writeFile(
      join(agent, "connectors", "web.ts"),
      `import { webRichConnector } from ${JSON.stringify(descriptorPath)};
       export default webRichConnector({
         authenticate: async () => ({ id: "u1" }),
         session: ({ body, user }) => user.id + ":" + body.id
       });`,
    );

    await expect(
      loadChatSdkConnector({
        agentDir: agent,
        connector: "slack",
        loadHarness: async () => harness(),
        createChat: FakeChat,
        streamHarness: () => streamResult(),
      }),
    ).resolves.toMatchObject({ adapterName: "slack" });

    await expect(
      loadChatSdkConnector({
        agentDir: agent,
        connector: "web",
        loadHarness: async () => harness(),
        createChat: FakeChat,
        streamHarness: () => streamResult(),
      }),
    ).rejects.toThrow(HarnessInputError);
  });

  it("reports a friendly setup error when Chat SDK is not installed", async () => {
    await expect(
      loadChatSdkConnector({
        agentDir: "agents/support",
        connector: chatSdkConnector({
          userName: "support",
          adapter: { name: "slack", create: () => ({ name: "slack" }) },
          state: () => ({}),
        }),
        loadHarness: async () => harness(),
        streamHarness: () => streamResult(),
      }),
    ).rejects.toThrow(HarnessInputError);
    await expect(
      loadChatSdkConnector({
        agentDir: "agents/support",
        connector: chatSdkConnector({
          userName: "support",
          adapter: { name: "slack", create: () => ({ name: "slack" }) },
          state: () => ({}),
        }),
        loadHarness: async () => harness(),
        streamHarness: () => streamResult(),
      }),
    ).rejects.toThrow(/Install the "chat" package/u);
  });

  it("defaults direct messages and mentions on while subscribed messages stay off", async () => {
    await loadChatSdkConnector({
      agentDir: "agents/support",
      connector: chatSdkConnector({
        userName: "support",
        adapter: { name: "slack", create: () => ({ name: "slack" }) },
        state: () => ({}),
      }),
      loadHarness: async () => harness(),
      createChat: FakeChat,
      streamHarness: () => streamResult(),
    });

    expect(FakeChat.last!.directHandlers).toHaveLength(1);
    expect(FakeChat.last!.mentionHandlers).toHaveLength(1);
    expect(FakeChat.last!.subscribedHandlers).toHaveLength(0);
  });

  it("only registers explicitly enabled triggers when defaults are disabled", async () => {
    await loadChatSdkConnector({
      agentDir: "agents/support",
      connector: chatSdkConnector({
        userName: "support",
        adapter: { name: "slack", create: () => ({ name: "slack" }) },
        state: () => ({}),
        triggers: { directMessage: false, mention: false, subscribedMessage: true },
      }),
      loadHarness: async () => harness(),
      createChat: FakeChat,
      streamHarness: () => streamResult(),
    });

    expect(FakeChat.last!.directHandlers).toHaveLength(0);
    expect(FakeChat.last!.mentionHandlers).toHaveLength(0);
    expect(FakeChat.last!.subscribedHandlers).toHaveLength(1);
  });

  it("uses adapter-namespaced sessions and reverses newest-first thread history before streaming", async () => {
    const calls: Array<{ session?: string; messages: UIMessage[] | undefined; extraBody: unknown }> = [];
    await loadChatSdkConnector({
      agentDir: "agents/support",
      connector: chatSdkConnector({
        userName: "support",
        adapter: { name: "slack", create: () => ({ name: "slack" }) },
        state: () => ({}),
        triggers: { directMessage: true },
        history: { source: "thread", limit: 2, fallback: "latest" },
        extraBody: () => ({ connector: "slack" }),
      }),
      loadHarness: async () => harness(),
      createChat: FakeChat,
      streamHarness: (options) => {
        calls.push({
          session: options.session as string,
          messages: options.messages,
          extraBody: options.extraBody,
        });
        return streamResult();
      },
    });

    const t = thread([message("new", "newest"), message("old", "oldest"), message("ignored", "ignored")]);
    await FakeChat.last!.directHandlers[0]!(t, message("current", "current"), undefined, { skipped: [] });

    expect(calls[0]?.session).toBe("slack:T1");
    // Oldest-first thread history plus the inbound message appended at the end.
    expect(calls[0]?.messages?.map((item) => item.id)).toEqual(["old", "new", "current"]);
    expect(calls[0]?.extraBody).toEqual({ connector: "slack" });
    expect(t.posted).toHaveLength(1);
  });

  it("falls back to the latest message when thread history is unavailable", async () => {
    const calls: Array<{ messages: UIMessage[] | undefined }> = [];
    await loadChatSdkConnector({
      agentDir: "agents/support",
      connector: chatSdkConnector({
        userName: "support",
        adapter: { name: "slack", create: () => ({ name: "slack" }) },
        state: () => ({}),
      }),
      loadHarness: async () => harness(),
      createChat: FakeChat,
      streamHarness: (options) => {
        calls.push({ messages: options.messages });
        return streamResult();
      },
    });

    await FakeChat.last!.directHandlers[0]!(thread(), message("current", "current"));

    expect(calls[0]?.messages?.map((item) => item.id)).toEqual(["current"]);
  });

  it("keeps the latest message for explicit thread history with fallback when thread history is unavailable or empty", async () => {
    const calls: Array<{ messages: UIMessage[] | undefined }> = [];
    await loadChatSdkConnector({
      agentDir: "agents/support",
      connector: chatSdkConnector({
        userName: "support",
        adapter: { name: "slack", create: () => ({ name: "slack" }) },
        state: () => ({}),
        history: { source: "thread", limit: 2, fallback: "latest" },
      }),
      loadHarness: async () => harness(),
      createChat: FakeChat,
      streamHarness: (options) => {
        calls.push({ messages: options.messages });
        return streamResult();
      },
    });

    await FakeChat.last!.directHandlers[0]!(thread(), message("unavailable", "current"));
    await FakeChat.last!.directHandlers[0]!(thread([]), message("empty", "current"));

    expect(calls.map((call) => call.messages?.map((item) => item.id))).toEqual([
      ["unavailable"],
      ["empty"],
    ]);
  });

  it("throws only when the thread has no messages iterable and no fallback is configured", async () => {
    await loadChatSdkConnector({
      agentDir: "agents/support",
      connector: chatSdkConnector({
        userName: "support",
        adapter: { name: "slack", create: () => ({ name: "slack" }) },
        state: () => ({}),
        history: { source: "thread", limit: 2 },
      }),
      loadHarness: async () => harness(),
      createChat: FakeChat,
      streamHarness: () => streamResult(),
    });

    // No `thread.messages` iterable at all → history is genuinely unavailable → throws.
    await expect(
      FakeChat.last!.directHandlers[0]!(thread(), message("unavailable", "current")),
    ).rejects.toThrow(/Thread history is unavailable/u);
  });

  it("treats an empty-but-present thread as a new conversation, yielding just the inbound even without a fallback", async () => {
    const calls: Array<{ messages: UIMessage[] | undefined }> = [];
    await loadChatSdkConnector({
      agentDir: "agents/support",
      connector: chatSdkConnector({
        userName: "support",
        adapter: { name: "slack", create: () => ({ name: "slack" }) },
        state: () => ({}),
        history: { source: "thread", limit: 2 },
      }),
      loadHarness: async () => harness(),
      createChat: FakeChat,
      streamHarness: (options) => {
        calls.push({ messages: options.messages });
        return streamResult();
      },
    });

    // An empty iterable is the first turn of a brand-new conversation, not an unavailable thread:
    // `threadHistory` returns `[]`, `appendInboundIfMissing` yields `[inbound]`, and no error is
    // thrown even though there is no `fallback: "latest"`.
    await expect(
      FakeChat.last!.directHandlers[0]!(thread([]), message("empty", "current")),
    ).resolves.toBeUndefined();

    expect(calls[0]?.messages?.map((item) => item.id)).toEqual(["empty"]);
  });

  it("appends the inbound message to thread history only when it is not already present", async () => {
    const calls: Array<{ messages: UIMessage[] | undefined }> = [];
    await loadChatSdkConnector({
      agentDir: "agents/support",
      connector: chatSdkConnector({
        userName: "support",
        adapter: { name: "slack", create: () => ({ name: "slack" }) },
        state: () => ({}),
        history: { source: "thread", limit: 5, fallback: "latest" },
      }),
      loadHarness: async () => harness(),
      createChat: FakeChat,
      streamHarness: (options) => {
        calls.push({ messages: options.messages });
        return streamResult();
      },
    });

    // Absent case: inbound "current" is not in the thread, so it is appended at the end.
    await FakeChat.last!.directHandlers[0]!(
      thread([message("m2", "second"), message("m1", "first")]),
      message("current", "current"),
    );
    // Present case: the thread already contains the inbound id, so it is not duplicated.
    await FakeChat.last!.directHandlers[0]!(
      thread([message("current", "current"), message("m1", "first")]),
      message("current", "current"),
    );

    expect(calls[0]?.messages?.map((item) => item.id)).toEqual(["m1", "m2", "current"]);
    expect(calls[1]?.messages?.map((item) => item.id)).toEqual(["m1", "current"]);
  });

  it("loads transcript history by user key, thread id, and adapter platform", async () => {
    const calls: Array<{ messages: UIMessage[] | undefined }> = [];
    await loadChatSdkConnector({
      agentDir: "agents/support",
      connector: chatSdkConnector({
        userName: "support",
        adapter: { name: "slack", create: () => ({ name: "slack" }) },
        state: () => ({}),
        triggers: { directMessage: true },
        history: { source: "transcript", limit: 2, fallback: "latest" },
      }),
      loadHarness: async () => harness(),
      createChat: FakeChat,
      streamHarness: (options) => {
        calls.push({ messages: options.messages });
        return streamResult();
      },
    });
    FakeChat.last!.config.transcripts = {
      list: vi.fn(async () => [
        { id: "old", text: "oldest", role: "assistant" },
        { id: "new", text: "newest", role: "user" },
      ]),
    };

    await FakeChat.last!.directHandlers[0]!(thread(), message("current", "current", false, "slack:U1"));

    expect(FakeChat.last!.config.transcripts.list).toHaveBeenCalledWith({
      userKey: "slack:U1",
      limit: 2,
      threadId: "T1",
      platforms: ["slack"],
    });
    // The inbound message ("current") is appended since it is not among the transcript ids.
    expect(calls[0]?.messages?.map((item) => [item.id, item.role])).toEqual([
      ["old", "assistant"],
      ["new", "user"],
      ["current", "user"],
    ]);
  });

  it("does not duplicate the inbound when a persisted transcript entry's platformMessageId matches it", async () => {
    const calls: Array<{ messages: UIMessage[] | undefined }> = [];
    await loadChatSdkConnector({
      agentDir: "agents/support",
      connector: chatSdkConnector({
        userName: "support",
        adapter: { name: "slack", create: () => ({ name: "slack" }) },
        state: () => ({}),
        triggers: { directMessage: true },
        history: { source: "transcript", limit: 3, fallback: "latest" },
      }),
      loadHarness: async () => harness(),
      createChat: FakeChat,
      streamHarness: (options) => {
        calls.push({ messages: options.messages });
        return streamResult();
      },
    });
    // The store already persisted the inbound: it appears with its OWN transcript-record id ("t2")
    // but carries the platform message id ("current") as platformMessageId. The dedupe must match on
    // platformMessageId (not the mapped UIMessage id, which is "t2"), so the inbound is not appended.
    FakeChat.last!.config.transcripts = {
      list: vi.fn(async () => [
        { id: "t1", text: "earlier", role: "user" },
        { id: "t2", text: "current text", role: "user", platformMessageId: "current" },
      ]),
    };

    await FakeChat.last!.directHandlers[0]!(
      thread(),
      message("current", "current text", false, "slack:U1"),
    );

    expect(calls[0]?.messages?.map((item) => item.id)).toEqual(["t1", "t2"]);
  });

  it("falls back to latest for transcript history when userKey is missing and fallback is configured", async () => {
    const calls: Array<{ messages: UIMessage[] | undefined }> = [];
    await loadChatSdkConnector({
      agentDir: "agents/support",
      connector: chatSdkConnector({
        userName: "support",
        adapter: { name: "slack", create: () => ({ name: "slack" }) },
        state: () => ({}),
        history: { source: "transcript", limit: 2, fallback: "latest" },
      }),
      loadHarness: async () => harness(),
      createChat: FakeChat,
      streamHarness: (options) => {
        calls.push({ messages: options.messages });
        return streamResult();
      },
    });

    await FakeChat.last!.directHandlers[0]!(thread(), message("current", "current"));

    expect(calls[0]?.messages?.map((item) => item.id)).toEqual(["current"]);
  });

  it("falls back to latest when transcript access is unavailable and fallback is configured", async () => {
    const calls: Array<{ messages: UIMessage[] | undefined }> = [];
    class ThrowingTranscriptsChat extends FakeChat {
      override get transcripts(): never {
        throw new Error("transcripts unavailable");
      }
    }
    await loadChatSdkConnector({
      agentDir: "agents/support",
      connector: chatSdkConnector({
        userName: "support",
        adapter: { name: "slack", create: () => ({ name: "slack" }) },
        state: () => ({}),
        history: { source: "transcript", limit: 2, fallback: "latest" },
      }),
      loadHarness: async () => harness(),
      createChat: ThrowingTranscriptsChat,
      streamHarness: (options) => {
        calls.push({ messages: options.messages });
        return streamResult();
      },
    });

    await ThrowingTranscriptsChat.last!.directHandlers[0]!(thread(), message("current", "current", false, "u1"));

    expect(calls[0]?.messages?.map((item) => item.id)).toEqual(["current"]);
  });

  it("keeps the latest message when transcript history is empty without fallback", async () => {
    const calls: Array<{ messages: UIMessage[] | undefined }> = [];
    await loadChatSdkConnector({
      agentDir: "agents/support",
      connector: chatSdkConnector({
        userName: "support",
        adapter: { name: "slack", create: () => ({ name: "slack" }) },
        state: () => ({}),
        history: { source: "transcript", limit: 2 },
      }),
      loadHarness: async () => harness(),
      createChat: FakeChat,
      streamHarness: (options) => {
        calls.push({ messages: options.messages });
        return streamResult();
      },
    });
    FakeChat.last!.config.transcripts = {
      list: vi.fn(async () => []),
    };

    await expect(
      FakeChat.last!.directHandlers[0]!(thread(), message("current", "current", false, "slack:U1")),
    ).resolves.toBeUndefined();

    expect(calls[0]?.messages?.map((item) => item.id)).toEqual(["current"]);
  });

  it("falls back to the latest message when transcript history is empty and fallback is configured", async () => {
    const calls: Array<{ messages: UIMessage[] | undefined }> = [];
    await loadChatSdkConnector({
      agentDir: "agents/support",
      connector: chatSdkConnector({
        userName: "support",
        adapter: { name: "slack", create: () => ({ name: "slack" }) },
        state: () => ({}),
        history: { source: "transcript", limit: 2, fallback: "latest" },
      }),
      loadHarness: async () => harness(),
      createChat: FakeChat,
      streamHarness: (options) => {
        calls.push({ messages: options.messages });
        return streamResult();
      },
    });
    FakeChat.last!.config.transcripts = {
      list: vi.fn(async () => []),
    };

    await FakeChat.last!.directHandlers[0]!(
      thread(),
      message("current", "current", false, "slack:U1"),
    );

    expect(calls[0]?.messages?.map((item) => item.id)).toEqual(["current"]);
  });

  it("throws a friendly error when transcript history is unavailable without fallback", async () => {
    class ThrowingTranscriptsChat extends FakeChat {
      override get transcripts(): never {
        throw new Error("transcripts unavailable");
      }
    }
    await loadChatSdkConnector({
      agentDir: "agents/support",
      connector: chatSdkConnector({
        userName: "support",
        adapter: { name: "slack", create: () => ({ name: "slack" }) },
        state: () => ({}),
        history: { source: "transcript", limit: 2 },
      }),
      loadHarness: async () => harness(),
      createChat: ThrowingTranscriptsChat,
      streamHarness: () => streamResult(),
    });

    await expect(
      ThrowingTranscriptsChat.last!.directHandlers[0]!(thread(), message("current", "current", false, "u1")),
    ).rejects.toThrow(HarnessInputError);
  });

  it("hands a custom history callback the run context without a fabricated messages array", async () => {
    let received: Record<string, unknown> | undefined;
    await loadChatSdkConnector({
      agentDir: "agents/support",
      connector: chatSdkConnector({
        userName: "support",
        adapter: { name: "slack", create: () => ({ name: "slack" }) },
        state: () => ({}),
        history: async (ctx) => {
          received = ctx as unknown as Record<string, unknown>;
          return [];
        },
      }),
      loadHarness: async () => harness(),
      createChat: FakeChat,
      streamHarness: () => streamResult(),
    });

    await FakeChat.last!.directHandlers[0]!(thread(), message("m1", "hi"));

    expect(received).toBeDefined();
    expect("messages" in received!).toBe(false);
    expect(received!.session).toBe("slack:T1");
  });

  it("exposes descriptor-provided connector tools even without a connectorId", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const calls: Array<{ connectorTools: any }> = [];
    try {
      await loadChatSdkConnector({
        agentDir: "agents/support",
        connector: chatSdkConnector({
          userName: "support",
          adapter: { name: "slack", create: () => ({ name: "slack" }) },
          state: () => ({}),
          tools: {
            postToChannel: {
              description: "Descriptor-provided tool.",
              inputSchema: {} as any,
              execute: async () => ({ ok: true }),
            },
          } as any,
        }),
        loadHarness: async () => harness(),
        createChat: FakeChat,
        streamHarness: (options) => {
          calls.push({ connectorTools: options.connectorTools });
          return streamResult();
        },
      });

      await FakeChat.last!.directHandlers[0]!(thread(), message("m1", "hi"));
    } finally {
      warn.mockRestore();
    }

    expect(calls[0]?.connectorTools).toMatchObject({
      postToChannel: { description: "Descriptor-provided tool." },
    });
  });

  it("merges descriptor tools with folder extensions, letting folder extensions win per name", async () => {
    const agent = await tmpAgent();
    await mkdir(join(agent, "connectors", "slack", "tools"), { recursive: true });
    await writeFile(
      join(agent, "connectors", "slack", "connector.ts"),
      `import { chatSdkConnector } from ${JSON.stringify(descriptorPath)};
       export default chatSdkConnector({
         userName: "support",
         adapter: { name: "slack", create: () => ({ name: "slack" }) },
         state: () => ({})
       });`,
    );
    await writeFile(
      join(agent, "connectors", "slack", "tools", "addReaction.ts"),
      `import { extendTool } from ${JSON.stringify(toolExtensionsPath)};
       export default extendTool({} as any, { description: "Folder reaction tool." });`,
    );
    const calls: Array<{ connectorTools: any }> = [];

    await loadChatSdkConnector({
      agentDir: agent,
      connectorId: "slack",
      connector: chatSdkConnector({
        userName: "support",
        adapter: { name: "slack", create: () => ({ name: "slack" }) },
        state: () => ({}),
        session: () => "slack:tools",
        tools: {
          addReaction: {
            description: "Descriptor reaction tool.",
            inputSchema: {} as any,
            execute: async () => ({ ok: true }),
          },
          descriptorOnly: {
            description: "Descriptor-only tool.",
            inputSchema: {} as any,
            execute: async () => ({ ok: true }),
          },
        } as any,
      }),
      loadHarness: async () => harnessWithTools(),
      loadConnectorToolExtensions,
      createChat: FakeChat,
      streamHarness: (options) => {
        calls.push({ connectorTools: options.connectorTools });
        return streamResult();
      },
    });

    await FakeChat.last!.directHandlers[0]!(thread(), message("m1", "hi", false, "slack:U1"));

    expect(calls[0]?.connectorTools.addReaction.description).toBe("Folder reaction tool.");
    expect(calls[0]?.connectorTools.descriptorOnly.description).toBe("Descriptor-only tool.");
  });

  it("rejects descriptor-provided tools that claim a reserved name", async () => {
    await expect(
      loadChatSdkConnector({
        agentDir: "agents/support",
        connectorId: "slack",
        connector: chatSdkConnector({
          userName: "support",
          adapter: { name: "slack", create: () => ({ name: "slack" }) },
          state: () => ({}),
          tools: {
            bash: {
              description: "Should be rejected.",
              inputSchema: {} as any,
              execute: async () => ({ ok: true }),
            },
          } as any,
        }),
        loadHarness: async () => harness(),
        loadConnectorToolExtensions: async (_agentDir, _connectorId, baseTools) => baseTools,
        createChat: FakeChat,
        streamHarness: () => streamResult(),
      }),
    ).rejects.toThrow(HarnessInputError);
  });

  it("tolerates a missing connector folder for a descriptor object with connectorId (npm/inline connector)", async () => {
    // A real agent dir with NO `connectors/` folder: an npm-distributed or inline descriptor carries
    // its tools programmatically, so a missing folder must resolve to {} extensions rather than
    // throwing "Connector not found." when connectorId is set.
    const agent = await tmpAgent();
    const calls: Array<{ connectorTools: any }> = [];
    await loadChatSdkConnector({
      agentDir: agent,
      connectorId: "slack",
      connector: chatSdkConnector({
        userName: "support",
        adapter: { name: "slack", create: () => ({ name: "slack" }) },
        state: () => ({}),
        session: () => "slack:tools",
        tools: {
          postToChannel: {
            description: "Descriptor-provided tool.",
            inputSchema: {} as any,
            execute: async () => ({ ok: true }),
          },
        } as any,
      }),
      loadHarness: async () => harness(),
      loadConnectorToolExtensions,
      createChat: FakeChat,
      streamHarness: (options) => {
        calls.push({ connectorTools: options.connectorTools });
        return streamResult();
      },
    });

    await FakeChat.last!.directHandlers[0]!(thread(), message("m1", "hi", false, "slack:U1"));

    expect(calls[0]?.connectorTools).toMatchObject({
      postToChannel: { description: "Descriptor-provided tool." },
    });
  });

  it("loads a tools-only connector folder for a descriptor object with connectorId (no connector module)", async () => {
    // A `connectors/<id>/` folder that ships ONLY `tools/*` — no `connector.*` module, so discovery
    // finds no candidate and the string loader throws "Connector not found.". A descriptor object with
    // connectorId must still pick up those on-disk tools, and the folder wins per-name over descriptor.
    const agent = await tmpAgent();
    await mkdir(join(agent, "connectors", "slack", "tools"), { recursive: true });
    await writeFile(
      join(agent, "connectors", "slack", "tools", "post-to-channel.ts"),
      `export default { description: "Folder tool.", execute: async () => ({ ok: true }) };`,
    );
    const calls: Array<{ connectorTools: any }> = [];

    await loadChatSdkConnector({
      agentDir: agent,
      connectorId: "slack",
      connector: chatSdkConnector({
        userName: "support",
        adapter: { name: "slack", create: () => ({ name: "slack" }) },
        state: () => ({}),
        session: () => "slack:tools",
        tools: {
          "post-to-channel": {
            description: "Descriptor tool.",
            inputSchema: {} as any,
            execute: async () => ({ ok: true }),
          },
          descriptorOnly: {
            description: "Descriptor-only tool.",
            inputSchema: {} as any,
            execute: async () => ({ ok: true }),
          },
        } as any,
      }),
      loadHarness: async () => harness(),
      loadConnectorToolExtensions,
      createChat: FakeChat,
      streamHarness: (options) => {
        calls.push({ connectorTools: options.connectorTools });
        return streamResult();
      },
    });

    await FakeChat.last!.directHandlers[0]!(thread(), message("m1", "hi", false, "slack:U1"));

    // The folder tool is loaded even without a connector module; folder wins per-name over the
    // descriptor, and the descriptor-only tool is still merged in.
    expect(calls[0]?.connectorTools["post-to-channel"].description).toBe("Folder tool.");
    expect(calls[0]?.connectorTools.descriptorOnly.description).toBe("Descriptor-only tool.");
  });

  it("keeps the hard error when a STRING connector ref's tool loader reports the connector as not found", async () => {
    // A string ref explicitly named a folder connector, so a "Connector not found." from the tool
    // loader must stay fatal (unlike the descriptor-object case above).
    const agent = await tmpAgent();
    await mkdir(join(agent, "connectors"), { recursive: true });
    await writeFile(
      join(agent, "connectors", "slack.ts"),
      `import { chatSdkConnector } from ${JSON.stringify(descriptorPath)};
       export default chatSdkConnector({
         userName: "support",
         adapter: { name: "slack", create: () => ({ name: "slack" }) },
         state: () => ({})
       });`,
    );

    await expect(
      loadChatSdkConnector({
        agentDir: agent,
        connector: "slack",
        loadHarness: async () => harness(),
        loadConnectorToolExtensions: async () => {
          throw new HarnessInputError("Connector not found.");
        },
        createChat: FakeChat,
        streamHarness: () => streamResult(),
      }),
    ).rejects.toThrow(/Connector not found/u);
  });

  it("subscribes on mention when configured and calls lifecycle hooks around reply completion", async () => {
    const beforeRun = vi.fn();
    const afterReply = vi.fn();
    // Refactored to the new test/simulation helpers, driving the mention trigger via `simulateInbound`
    // and asserting the recorder on `createTestThread`.
    const loaded = await loadChatSdkConnector({
      agentDir: "agents/support",
      connector: chatSdkConnector({
        userName: "support",
        adapter: { name: "slack", create: () => ({ name: "slack" }) },
        state: () => ({}),
        triggers: { mention: { subscribe: true } },
        beforeRun,
        afterReply,
      }),
      loadHarness: async () => harness(),
      createChat: createTestChat(),
      streamHarness: () => streamResult(),
    });

    const t = createTestThread();
    await loaded.simulateInbound({ trigger: "mention", thread: t, message: createTestMessage({ text: "hi" }) });

    expect(t.subscribeCalls).toBe(1);
    expect(beforeRun).toHaveBeenCalledOnce();
    expect(afterReply).toHaveBeenCalledOnce();
  });

  it("reports setup, stream, post, and finished errors through onError", async () => {
    const onError = vi.fn(async (_ctx: any) => {});
    const disconnect = vi.fn(async () => {});
    await expect(
      loadChatSdkConnector({
        agentDir: "agents/support",
        connector: chatSdkConnector({
          userName: "support",
          adapter: { name: "slack", create: () => ({ name: "slack" }) },
          state: () => ({
            disconnect,
            connect: async () => {
              throw new Error("connect failed");
            },
          }),
          onError,
        }),
        loadHarness: async () => harness(),
        createChat: FakeChat,
        streamHarness: () => streamResult(),
      }),
    ).rejects.toThrow(/connect failed/u);
    expect(FakeChat.last!.close).toHaveBeenCalledOnce();
    expect(disconnect).toHaveBeenCalledOnce();

    await loadChatSdkConnector({
      agentDir: "agents/support",
      connector: chatSdkConnector({
        userName: "support",
        adapter: { name: "slack", create: () => ({ name: "slack" }) },
        state: () => ({}),
        onError,
      }),
      loadHarness: async () => harness(),
      createChat: FakeChat,
      streamHarness: () => {
        throw new Error("stream failed");
      },
    });
    await expect(FakeChat.last!.directHandlers[0]!(thread(), message("m1", "hi"))).rejects.toThrow(/stream failed/u);

    await loadChatSdkConnector({
      agentDir: "agents/support",
      connector: chatSdkConnector({
        userName: "support",
        adapter: { name: "slack", create: () => ({ name: "slack" }) },
        state: () => ({}),
        onError,
      }),
      loadHarness: async () => harness(),
      createChat: FakeChat,
      streamHarness: () => streamResult(),
    });
    const postFailureThread = thread();
    postFailureThread.post = async () => {
      throw new Error("post failed");
    };
    await expect(FakeChat.last!.directHandlers[0]!(postFailureThread, message("m2", "hi"))).rejects.toThrow(
      /post failed/u,
    );

    await loadChatSdkConnector({
      agentDir: "agents/support",
      connector: chatSdkConnector({
        userName: "support",
        adapter: { name: "slack", create: () => ({ name: "slack" }) },
        state: () => ({}),
        onError,
      }),
      loadHarness: async () => harness(),
      createChat: FakeChat,
      streamHarness: () => ({
        ...streamResult(),
        finished: Promise.reject(new Error("finished failed")),
      }),
    });
    await expect(FakeChat.last!.directHandlers[0]!(thread(), message("m3", "hi"))).rejects.toThrow(
      /finished failed/u,
    );

    expect(onError).toHaveBeenCalledTimes(4);
    expect(onError.mock.calls.map(([ctx]) => ((ctx as any).error as Error).message)).toEqual([
      "connect failed",
      "stream failed",
      "post failed",
      "finished failed",
    ]);
    expect(onError.mock.calls.map(([ctx]) => (ctx as any).phase)).toEqual([
      "setup",
      "run",
      "run",
      "run",
    ]);
    expect("thread" in onError.mock.calls[0]![0]).toBe(false);
    expect(onError.mock.calls[1]![0]).toMatchObject({ phase: "run", session: "slack:T1" });
    expect(onError.mock.calls[3]![0]).toMatchObject({ sent: { id: "sent_1" } });
  });

  it("preserves setup errors when descriptor onError rejects", async () => {
    const onError = vi.fn(async () => {
      throw new Error("observer failed");
    });

    await expect(
      loadChatSdkConnector({
        agentDir: "agents/support",
        connector: chatSdkConnector({
          userName: "support",
          adapter: { name: "slack", create: () => ({ name: "slack" }) },
          state: () => ({
            connect: async () => {
              throw new Error("connect failed");
            },
          }),
          onError,
        }),
        loadHarness: async () => harness(),
        createChat: FakeChat,
        streamHarness: () => streamResult(),
      }),
    ).rejects.toThrow(/connect failed/u);

    expect(onError).toHaveBeenCalledOnce();
  });

  it("preserves run errors when descriptor onError rejects", async () => {
    const onError = vi.fn(async () => {
      throw new Error("observer failed");
    });
    await loadChatSdkConnector({
      agentDir: "agents/support",
      connector: chatSdkConnector({
        userName: "support",
        adapter: { name: "slack", create: () => ({ name: "slack" }) },
        state: () => ({}),
        onError,
      }),
      loadHarness: async () => harness(),
      createChat: FakeChat,
      streamHarness: () => {
        throw new Error("stream failed");
      },
    });

    await expect(FakeChat.last!.directHandlers[0]!(thread(), message("m1", "hi"))).rejects.toThrow(
      /stream failed/u,
    );
    expect(onError).toHaveBeenCalledOnce();
  });

  it("passes abort signals to streamHarness, rejects missing webhooks, and closes chat plus state", async () => {
    const disconnect = vi.fn(async () => {});
    const abortController = new AbortController();
    const calls: Array<{ abortSignal: AbortSignal | undefined }> = [];
    const loaded = await loadChatSdkConnector({
      agentDir: "agents/support",
      connector: chatSdkConnector({
        userName: "support",
        adapter: { name: "slack", create: () => ({ name: "slack" }) },
        state: () => ({ disconnect }),
      }),
      loadHarness: async () => harness(),
      createChat: FakeChat,
      streamHarness: (options) => {
        calls.push({ abortSignal: options.abortSignal });
        return streamResult();
      },
    });

    await FakeChat.last!.directHandlers[0]!(thread(), message("m1", "hi"), undefined, {
      abortSignal: abortController.signal,
    });
    expect(calls[0]?.abortSignal).toBe(abortController.signal);

    delete FakeChat.last!.webhooks.slack;
    await expect(loaded.webhook(new Request("https://example.com"))).rejects.toThrow(HarnessInputError);

    const chat = FakeChat.last!;
    await loaded.close();
    expect(chat.close).toHaveBeenCalledOnce();
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it("uses Chat SDK initialize and shutdown when the Chat implementation exposes them", async () => {
    class InitializingChat extends FakeChat {
      initialize = vi.fn(async () => {});
      shutdown = vi.fn(async () => {});
    }
    const connect = vi.fn(async () => {});
    const disconnect = vi.fn(async () => {});

    const loaded = await loadChatSdkConnector({
      agentDir: "agents/support",
      connector: chatSdkConnector({
        userName: "support",
        adapter: { name: "slack", create: () => ({ name: "slack" }) },
        state: () => ({ connect, disconnect }),
      }),
      loadHarness: async () => harness(),
      createChat: InitializingChat,
      streamHarness: () => streamResult(),
    });

    const chat = FakeChat.last as InitializingChat;
    expect(chat.initialize).toHaveBeenCalledOnce();
    expect(connect).not.toHaveBeenCalled();

    await loaded.close();

    expect(chat.shutdown).toHaveBeenCalledOnce();
    expect(chat.close).not.toHaveBeenCalled();
    expect(disconnect).not.toHaveBeenCalled();
  });

  it("disconnects connected state after Chat SDK shutdown", async () => {
    class ShuttingDownChat extends FakeChat {
      shutdown = vi.fn(async () => {});
    }
    const connect = vi.fn(async () => {});
    const disconnect = vi.fn(async () => {});

    const loaded = await loadChatSdkConnector({
      agentDir: "agents/support",
      connector: chatSdkConnector({
        userName: "support",
        adapter: { name: "slack", create: () => ({ name: "slack" }) },
        state: () => ({ connect, disconnect }),
      }),
      loadHarness: async () => harness(),
      createChat: ShuttingDownChat,
      streamHarness: () => streamResult(),
    });

    const chat = FakeChat.last as ShuttingDownChat;
    expect(connect).toHaveBeenCalledOnce();

    await loaded.close();

    expect(chat.shutdown).toHaveBeenCalledOnce();
    expect(chat.close).not.toHaveBeenCalled();
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it("falls back to a mirror target's descriptor deliver when no explicit deliverer is registered", async () => {
    const agent = await tmpAgent();
    await mkdir(join(agent, "connectors", "slack"), { recursive: true });
    await writeFile(
      join(agent, "connectors", "slack", "connector.ts"),
      `import { chatSdkConnector } from ${JSON.stringify(descriptorPath)};
       export default chatSdkConnector({
         userName: "support",
         adapter: { name: "slack", create: () => ({ name: "slack" }) },
         state: () => ({}),
         session: () => "slack:mirror"
       });`,
    );
    await mkdir(join(agent, "connectors", "discord"), { recursive: true });
    await writeFile(
      join(agent, "connectors", "discord", "connector.ts"),
      `import { chatSdkConnector } from ${JSON.stringify(descriptorPath)};
       export default chatSdkConnector({
         userName: "support",
         adapter: { name: "discord", create: () => ({ name: "discord" }) },
         state: () => ({}),
         deliver: async (ctx) => {
           globalThis.__wp1ChatMirror.push({ text: ctx.text, target: ctx.target.connectorId });
         }
       });`,
    );
    (globalThis as any).__wp1ChatMirror = [];
    const loaded = await loadChatSdkConnector({
      agentDir: agent,
      connector: "slack",
      loadHarness: async () => isolatedHarness(agent),
      createChat: FakeChat,
      streamHarness: () => streamResult("mirrored via descriptor"),
    });
    const session = await loaded.harness.sessions.getOrCreate({ id: "slack:mirror" });
    await attachSessionConnector(session, {
      connectorId: "discord",
      kind: "chat-sdk",
      delivery: "mirror",
      endpoint: { id: "discord:thread", platform: "discord", threadId: "thread", userId: "u2" },
    });

    await FakeChat.last!.directHandlers[0]!(thread(), message("m1", "hi", false, "slack:U1"));

    expect((globalThis as any).__wp1ChatMirror).toEqual([
      { text: "mirrored via descriptor", target: "discord" },
    ]);
    delete (globalThis as any).__wp1ChatMirror;
  });

  it("prefers an explicit deliverer over a mirror target's descriptor deliver", async () => {
    const agent = await tmpAgent();
    await mkdir(join(agent, "connectors", "slack"), { recursive: true });
    await writeFile(
      join(agent, "connectors", "slack", "connector.ts"),
      `import { chatSdkConnector } from ${JSON.stringify(descriptorPath)};
       export default chatSdkConnector({
         userName: "support",
         adapter: { name: "slack", create: () => ({ name: "slack" }) },
         state: () => ({}),
         session: () => "slack:mirror"
       });`,
    );
    await mkdir(join(agent, "connectors", "discord"), { recursive: true });
    await writeFile(
      join(agent, "connectors", "discord", "connector.ts"),
      `import { chatSdkConnector } from ${JSON.stringify(descriptorPath)};
       export default chatSdkConnector({
         userName: "support",
         adapter: { name: "discord", create: () => ({ name: "discord" }) },
         state: () => ({}),
         deliver: async () => {
           globalThis.__wp1ChatMirror.push({ text: "descriptor", target: "discord" });
         }
       });`,
    );
    (globalThis as any).__wp1ChatMirror = [];
    const explicit = vi.fn(async () => {});
    const loaded = await loadChatSdkConnector({
      agentDir: agent,
      connector: "slack",
      delivery: { deliverers: { discord: explicit } },
      loadHarness: async () => isolatedHarness(agent),
      createChat: FakeChat,
      streamHarness: () => streamResult("mirrored reply"),
    });
    const session = await loaded.harness.sessions.getOrCreate({ id: "slack:mirror" });
    await attachSessionConnector(session, {
      connectorId: "discord",
      kind: "chat-sdk",
      delivery: "mirror",
      endpoint: { id: "discord:thread", platform: "discord", threadId: "thread", userId: "u2" },
    });

    await FakeChat.last!.directHandlers[0]!(thread(), message("m1", "hi", false, "slack:U1"));

    expect(explicit).toHaveBeenCalledOnce();
    expect((globalThis as any).__wp1ChatMirror).toEqual([]);
    delete (globalThis as any).__wp1ChatMirror;
  });

  it("reports a mirror target descriptor load failure through delivery.onError and skips it", async () => {
    const agent = await tmpAgent();
    await mkdir(join(agent, "connectors", "slack"), { recursive: true });
    await writeFile(
      join(agent, "connectors", "slack", "connector.ts"),
      `import { chatSdkConnector } from ${JSON.stringify(descriptorPath)};
       export default chatSdkConnector({
         userName: "support",
         adapter: { name: "slack", create: () => ({ name: "slack" }) },
         state: () => ({}),
         session: () => "slack:mirror"
       });`,
    );
    const onError = vi.fn(async (_ctx: any) => {});
    const loaded = await loadChatSdkConnector({
      agentDir: agent,
      connector: "slack",
      delivery: { onError },
      loadHarness: async () => isolatedHarness(agent),
      createChat: FakeChat,
      streamHarness: () => streamResult("mirrored reply"),
    });
    const session = await loaded.harness.sessions.getOrCreate({ id: "slack:mirror" });
    await attachSessionConnector(session, {
      connectorId: "ghost",
      kind: "chat-sdk",
      delivery: "mirror",
      endpoint: { id: "ghost:thread", platform: "ghost", threadId: "thread", userId: "u2" },
    });

    await expect(
      FakeChat.last!.directHandlers[0]!(thread(), message("m1", "hi", false, "slack:U1")),
    ).resolves.toBeUndefined();

    expect(onError).toHaveBeenCalledTimes(1);
    const [ctx] = onError.mock.calls[0]!;
    expect(((ctx as any).error as Error).message).toMatch(/Connector not found/u);
    expect((ctx as any).target.connectorId).toBe("ghost");
  });

  it("warns for a Chat SDK descriptor object without connectorId but not when it is provided", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await loadChatSdkConnector({
        agentDir: "agents/support",
        connector: chatSdkConnector({
          userName: "support",
          adapter: { name: "slack", create: () => ({ name: "slack" }) },
          state: () => ({}),
        }),
        loadHarness: async () => harness(),
        createChat: FakeChat,
        streamHarness: () => streamResult(),
      });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain("connectorId");

      warn.mockClear();
      await loadChatSdkConnector({
        agentDir: "agents/support",
        connectorId: "slack",
        connector: chatSdkConnector({
          userName: "support",
          adapter: { name: "slack", create: () => ({ name: "slack" }) },
          state: () => ({}),
        }),
        loadHarness: async () => harness(),
        loadConnectorToolExtensions: async (_agentDir, _connectorId, baseTools) => baseTools,
        createChat: FakeChat,
        streamHarness: () => streamResult(),
      });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("chat reaction outcome capture", () => {
  const PROMPT_HASH = "d".repeat(64);

  function modelCalledLine(sessionId: string): string {
    return `${JSON.stringify({
      schemaVersion: "lh.trace.v2",
      eventId: "evt_1",
      sequence: 1,
      type: "harness.model.called",
      sessionId,
      timestamp: "2026-08-07T00:00:00.000Z",
      metadata: {
        stepNumber: 1,
        model: { provider: "mock", modelId: "mock" },
        request: {
          promptHash: PROMPT_HASH,
          system: { captured: false },
          messages: [],
          tools: [],
        },
      },
    })}\n`;
  }

  function thumbs(name: "thumbs_up" | "thumbs_down", added = true): ChatSdkReactionEvent {
    return {
      added,
      emoji: { name, toString: () => `:${name}:` },
      rawEmoji: name === "thumbs_up" ? "+1" : "-1",
      messageId: "sent_1",
      threadId: "T1",
      user: { userId: "U1", isMe: false },
      message: { id: "sent_1", author: { userId: "bot", isMe: true } },
    };
  }

  async function loadedSurface(reactions?: false | Record<string, unknown>) {
    const agent = await tmpAgent();
    const dataDir = join(agent, ".data");
    const built = createHarness({ host: localHost({ dataDir }), model });
    await loadChatSdkConnector({
      agentDir: agent,
      connectorId: "slack",
      connector: chatSdkConnector({
        userName: "support",
        adapter: { name: "slack", create: () => ({ name: "slack" }) },
        state: () => ({}),
        ...(reactions === undefined ? {} : { reactions: reactions as never }),
      }),
      loadHarness: async () => built,
      loadConnectorToolExtensions: async (_agentDir, _connectorId, baseTools) => baseTools,
      createChat: FakeChat,
      streamHarness: () => streamResult("here you go"),
    });
    return { agent, dataDir, harness: built };
  }

  it("turns a thumbs-down on a reply into outcome.reported the reader can rate per promptHash", async () => {
    const { dataDir, harness: built } = await loadedSurface();

    // A real turn on the surface — this is what creates the session the reaction joins to.
    await FakeChat.last!.directHandlers[0]!(thread(), message("m1", "hi"));

    // The model call behind that reply (streamHarness is stubbed here, so it writes no trace).
    const session = await built.sessions.getOrCreate({ id: "slack:T1" });
    await appendFile(session.trace.path!, modelCalledLine("slack:T1"), "utf8");

    expect(FakeChat.last!.reactionHandlers).toHaveLength(1);
    await FakeChat.last!.reactionHandlers[0]!(thumbs("thumbs_down"));

    const report = await aggregateLocalOutcomes({ dataDir });
    expect(report.sessionIds).toEqual(["slack:T1"]);
    expect(report.eventCount).toBe(1);
    expect(report.overall).toEqual({ n: 1, success: 0, failure: 1, partial: 0, successRate: 0 });
    expect(report.byPromptHash).toEqual([
      { key: PROMPT_HASH, n: 1, success: 0, failure: 1, partial: 0, successRate: 0 },
    ]);
  });

  it("keeps the run's own trace numbering intact after an outcome is appended", async () => {
    const { dataDir, harness: built } = await loadedSurface();
    await FakeChat.last!.directHandlers[0]!(thread(), message("m1", "hi"));
    const session = await built.sessions.getOrCreate({ id: "slack:T1" });
    await appendFile(session.trace.path!, modelCalledLine("slack:T1"), "utf8");

    await FakeChat.last!.reactionHandlers[0]!(thumbs("thumbs_down"));

    const prepared = await localHost({ dataDir }).prepareTurn({
      session: await localHost({ dataDir }).sessions.getOrCreate({ id: "slack:T1" }),
      turnId: "turn_2",
      persistentDirs: [],
    });
    const next = await prepared.emit({ type: "harness.session.started", metadata: {} });
    expect(next.sequence).toBe(2);
  });

  it("a thumbs-down toggled to a thumbs-up nets one success with a sample size of one", async () => {
    const { dataDir } = await loadedSurface();
    await FakeChat.last!.directHandlers[0]!(thread(), message("m1", "hi"));
    const handler = FakeChat.last!.reactionHandlers[0]!;

    await handler(thumbs("thumbs_down"));
    await handler(thumbs("thumbs_down", false));
    await handler(thumbs("thumbs_up"));

    const report = await aggregateLocalOutcomes({ dataDir });
    expect(report.eventCount).toBe(3);
    expect(report.countedCount).toBe(1);
    expect(report.overall).toEqual({ n: 1, success: 1, failure: 0, partial: 0, successRate: 1 });
  });

  it("registers no reaction handler when the connector opts out", async () => {
    await loadedSurface(false);
    expect(FakeChat.last!.reactionHandlers).toHaveLength(0);
  });

  it("loads normally against an adapter that has no reaction events", async () => {
    const agent = await tmpAgent();
    const built = createHarness({ host: localHost({ dataDir: join(agent, ".data") }), model });
    const loaded = await loadChatSdkConnector({
      agentDir: agent,
      connectorId: "slack",
      connector: chatSdkConnector({
        userName: "support",
        adapter: { name: "slack", create: () => ({ name: "slack" }) },
        state: () => ({}),
      }),
      loadHarness: async () => built,
      loadConnectorToolExtensions: async (_agentDir, _connectorId, baseTools) => baseTools,
      createChat: FakeChatWithoutReactions,
      streamHarness: () => streamResult(),
    });
    expect(loaded.adapterName).toBe("slack");
  });
});

describe("inbound message attachments", () => {
  type InboundRunOptions = {
    text?: string;
    userKey?: string;
    attachments?: readonly ChatSdkAttachment[];
    /** The descriptor's `attachments` setting. */
    attachmentOptions?: false | ChatSdkAttachmentOptions;
    history?: ConnectorHistoryPolicy;
    transcripts?: ChatSdkChatLike["transcripts"];
    /** Newest-first thread history, as the Chat SDK yields it. */
    threadMessages?: ChatSdkMessage[];
  };

  function textAttachment(overrides: Partial<ChatSdkAttachment> = {}): ChatSdkAttachment {
    return {
      type: "file",
      name: "notes.txt",
      mimeType: "text/plain",
      data: new TextEncoder().encode("hello kb"),
      ...overrides,
    };
  }

  function fileParts(uiMessage: UIMessage): any[] {
    return (uiMessage.parts as any[]).filter((part) => part?.type === "file");
  }

  /** Drive one simulated inbound turn and return the messages `streamHarness` was handed. */
  async function runInbound(options: InboundRunOptions = {}) {
    const agent = await tmpAgent();
    const built = isolatedHarness(agent);
    const captured: Array<UIMessage[] | undefined> = [];
    const loaded = await loadChatSdkConnector({
      agentDir: agent,
      connectorId: "slack",
      connector: chatSdkConnector({
        userName: "support",
        adapter: { name: "slack", create: () => ({ name: "slack" }) },
        state: () => ({}),
        session: () => "slack:attachments",
        history: options.history ?? "latest",
        ...(options.attachmentOptions === undefined ? {} : { attachments: options.attachmentOptions }),
        ...(options.transcripts === undefined ? {} : { chat: { transcripts: options.transcripts } }),
      }),
      loadHarness: async () => built,
      loadConnectorToolExtensions: async (_agentDir, _connectorId, baseTools) => baseTools,
      createChat: FakeChat,
      streamHarness: (streamOptions) => {
        captured.push(streamOptions.messages as UIMessage[] | undefined);
        return streamResult();
      },
    });

    const inbound: ChatSdkMessage = {
      ...message("m1", options.text ?? "what does this say?", false, options.userKey),
      ...(options.attachments === undefined ? {} : { attachments: options.attachments }),
    };
    await loaded.simulateInbound({ thread: thread(options.threadMessages), message: inbound });

    return { messages: captured[0] ?? [], harness: built };
  }

  it("maps a data-backed attachment into a file part carrying the data URL and the raw bytes", async () => {
    const { messages } = await runInbound({ attachments: [textAttachment()] });

    expect(messages).toHaveLength(1);
    const parts = messages[0]!.parts as any[];
    expect(parts[0]).toEqual({ type: "text", text: "what does this say?" });
    expect(parts[1]).toMatchObject({
      type: "file",
      mediaType: "text/plain",
      filename: "notes.txt",
      // `convertToModelMessages` forwards `url` to the provider, so the data URL is what puts the
      // file in the model's context.
      url: `data:text/plain;base64,${Buffer.from("hello kb").toString("base64")}`,
    });
    // ...and the raw bytes ride alongside for message staging, which reads `data`.
    expect(new TextDecoder().decode(parts[1].data)).toBe("hello kb");
  });

  it("converts to a model message with the file intact", async () => {
    const { messages } = await runInbound({ attachments: [textAttachment()] });

    // The other half of the contract: what the model actually receives when the app stages
    // nothing (no `chat.stageMessage`), so the file parts survive into `convertToModelMessages`.
    expect(await convertToModelMessages(messages)).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "what does this say?" },
          {
            type: "file",
            mediaType: "text/plain",
            filename: "notes.txt",
            // AI SDK 7 file parts carry tagged data; a data URL stays a `url` reference.
            data: {
              type: "url",
              url: new URL(`data:text/plain;base64,${Buffer.from("hello kb").toString("base64")}`),
            },
          },
        ],
      },
    ]);
  });

  it("hands the attachment to chat.stageMessage as an input file", async () => {
    const { messages, harness: built } = await runInbound({ attachments: [textAttachment()] });
    const session = await built.sessions.getOrCreate({ id: "slack:attachments" });
    const seen: Array<{ name: string; mediaType: string | undefined }> = [];

    const staged = await stageChatMessages({
      messages,
      session,
      files: session.files,
      chat: {
        stageMessage: async ({ message: staging, inputFiles, files }) => {
          seen.push(...inputFiles.map((file) => ({ name: file.name, mediaType: file.mediaType })));
          return {
            stagedFiles: await Promise.all(
              inputFiles.map((file) =>
                files.write(`/session/user-input/${staging.id}/${file.safeName}`, file.content),
              ),
            ),
            notice: "File staged.",
          };
        },
      },
    });

    expect(seen).toEqual([{ name: "notes.txt", mediaType: "text/plain" }]);
    expect(staged.notices).toEqual(["File staged."]);
    expect((await session.files.read("/session/user-input/m1/notes.txt")).text()).toBe("hello kb");
  });

  it("fetches bytes through fetchData for platforms that authenticate the download", async () => {
    const fetchData = vi.fn(async () => Buffer.from("private body"));
    const { messages } = await runInbound({
      attachments: [
        {
          type: "file",
          name: "private.pdf",
          mimeType: "application/pdf",
          url: "https://files.slack.com/private/T1/private.pdf",
          fetchData,
        },
      ],
    });

    expect(fetchData).toHaveBeenCalledTimes(1);
    const part = fileParts(messages[0]!)[0];
    expect(part).toMatchObject({ type: "file", mediaType: "application/pdf", filename: "private.pdf" });
    expect(new TextDecoder().decode(part.data)).toBe("private body");
  });

  it("skips an attachment whose reported size exceeds the cap without ever fetching it", async () => {
    const fetchData = vi.fn(async () => new Uint8Array(0));
    const { messages } = await runInbound({
      attachments: [
        {
          type: "video",
          name: "huge.mov",
          mimeType: "video/quicktime",
          size: 24 * 1024 * 1024,
          fetchData,
        },
      ],
    });

    expect(fetchData).not.toHaveBeenCalled();
    expect(messages[0]!.parts).toEqual([
      {
        type: "text",
        text: 'what does this say?\n\n[attachment "huge.mov" was not attached: 24 MB exceeds the 10 MB limit]',
      },
    ]);
  });

  it("skips an attachment that only turns out oversized after fetching, honouring a custom maxBytes", async () => {
    const { messages } = await runInbound({
      attachments: [textAttachment({ name: "big.txt", data: new TextEncoder().encode("0123456789") })],
      attachmentOptions: { maxBytes: 4 },
    });

    expect(messages[0]!.parts).toEqual([
      {
        type: "text",
        text: 'what does this say?\n\n[attachment "big.txt" was not attached: 10 B exceeds the 4 B limit]',
      },
    ]);
  });

  it("degrades to a note when fetchData fails and reports the error to onSkipped only", async () => {
    const skips: ChatSdkAttachmentSkip[] = [];
    const { messages } = await runInbound({
      attachments: [
        {
          type: "file",
          name: "gone.pdf",
          mimeType: "application/pdf",
          fetchData: async () => {
            throw new Error("403 for https://files.slack.com/private?t=SECRET");
          },
        },
      ],
      attachmentOptions: {
        onSkipped: (skip) => {
          skips.push(skip);
        },
      },
    });

    // The turn still runs, with the missing file described in the text.
    expect(messages[0]!.parts).toEqual([
      { type: "text", text: 'what does this say?\n\n[attachment "gone.pdf" could not be fetched]' },
    ]);
    // The failure detail never reaches the model — a platform error can carry a signed URL.
    expect(JSON.stringify(messages)).not.toContain("SECRET");
    expect(skips).toHaveLength(1);
    expect(skips[0]).toMatchObject({
      reason: "fetch-failed",
      adapterName: "slack",
      note: '[attachment "gone.pdf" could not be fetched]',
    });
    expect((skips[0]!.error as Error).message).toContain("403");
    expect(skips[0]!.attachment.name).toBe("gone.pdf");
    expect(skips[0]!.message.id).toBe("m1");
  });

  it("survives an onSkipped observer that throws", async () => {
    const { messages } = await runInbound({
      attachments: [textAttachment({ name: "big.txt" })],
      attachmentOptions: {
        maxBytes: 1,
        onSkipped: () => {
          throw new Error("observer exploded");
        },
      },
    });

    expect(messages[0]!.parts).toEqual([
      {
        type: "text",
        text: 'what does this say?\n\n[attachment "big.txt" was not attached: 8 B exceeds the 1 B limit]',
      },
    ]);
  });

  it("notes an attachment the platform exposes only as a URL", async () => {
    const { messages } = await runInbound({
      attachments: [
        { type: "image", name: "photo.png", mimeType: "image/png", url: "https://example.com/photo.png" },
      ],
    });

    expect(messages[0]!.parts).toEqual([
      {
        type: "text",
        text: 'what does this say?\n\n[attachment "photo.png" was not attached: the platform provided no file data]',
      },
    ]);
  });

  it("inlines nothing when the connector opts out with `attachments: false`", async () => {
    const fetchData = vi.fn(async () => new TextEncoder().encode("nope"));
    const { messages } = await runInbound({
      attachments: [{ type: "file", name: "notes.txt", mimeType: "text/plain", fetchData }],
      attachmentOptions: false,
    });

    expect(fetchData).not.toHaveBeenCalled();
    expect(messages[0]!.parts).toEqual([{ type: "text", text: "what does this say?" }]);
  });

  it("leaves a message with no attachments identical to the text-only mapping", async () => {
    const { messages } = await runInbound();

    expect(messages).toEqual([
      { id: "m1", role: "user", parts: [{ type: "text", text: "what does this say?" }] },
    ]);
  });

  it("attaches to the inbound entry inside thread history and leaves earlier messages text-only", async () => {
    const echoed: ChatSdkMessage = {
      ...message("m1", "what does this say?"),
      attachments: [textAttachment({ name: "new.txt" })],
    };
    const older: ChatSdkMessage = {
      ...message("m0", "here is an older upload"),
      attachments: [textAttachment({ name: "old.txt" })],
    };

    const { messages } = await runInbound({
      attachments: [
        textAttachment({ name: "new.txt" }),
        { type: "file", name: "huge.bin", mimeType: "application/octet-stream", size: 24 * 1024 * 1024 },
      ],
      history: { source: "thread", limit: 10 },
      threadMessages: [echoed, older],
    });

    expect(messages).toHaveLength(2);
    // History is text-only: the older message's own attachment is never re-fetched or re-embedded.
    expect(messages[0]!.parts).toEqual([{ type: "text", text: "here is an older upload" }]);
    const parts = messages[1]!.parts as any[];
    expect(parts[0]).toEqual({
      type: "text",
      text: 'what does this say?\n\n[attachment "huge.bin" was not attached: 24 MB exceeds the 10 MB limit]',
    });
    expect(parts[1]).toMatchObject({ type: "file", filename: "new.txt" });
    expect(fileParts(messages[1]!)).toHaveLength(1);
  });

  it("re-attaches the files to a transcript entry that already persisted the inbound message", async () => {
    const { messages } = await runInbound({
      attachments: [textAttachment()],
      userKey: "slack:U1",
      history: { source: "transcript", limit: 10 },
      transcripts: {
        list: async () => [
          { id: "t1", text: "what does this say?", role: "user", platformMessageId: "m1" },
        ],
      },
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]!.id).toBe("t1");
    expect(fileParts(messages[0]!)[0]).toMatchObject({ type: "file", filename: "notes.txt" });
  });

  it("applies the files to a custom history callback's inbound entry", async () => {
    const { messages } = await runInbound({
      attachments: [textAttachment()],
      history: async (ctx) =>
        [
          { id: "older", role: "user", parts: [{ type: "text", text: "earlier" }] },
          { id: ctx.message.id, role: "user", parts: [{ type: "text", text: ctx.message.text }] },
        ] as UIMessage[],
    });

    expect(fileParts(messages[0]!)).toHaveLength(0);
    expect(fileParts(messages[1]!)[0]).toMatchObject({ type: "file", filename: "notes.txt" });
  });

  it("never duplicates a file a custom history callback already resolved itself", async () => {
    const { messages } = await runInbound({
      attachments: [textAttachment()],
      history: async (ctx) =>
        [
          {
            id: ctx.message.id,
            role: "user",
            parts: [
              { type: "text", text: ctx.message.text },
              { type: "file", mediaType: "text/plain", filename: "own.txt", url: "data:text/plain;base64,b3du" },
            ],
          },
        ] as UIMessage[],
    });

    expect(fileParts(messages[0]!)).toHaveLength(1);
    expect(fileParts(messages[0]!)[0]).toMatchObject({ filename: "own.txt" });
  });
});
