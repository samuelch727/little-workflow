import type {
  ChatSdkChatLike,
  ChatSdkMessage,
  ChatSdkMessageContext,
  ChatSdkThread,
  ChatSdkWebhookOptions,
} from "./descriptors.js";

/**
 * In-memory test/simulation doubles for the Chat SDK connector surface.
 *
 * These helpers implement the structural `ChatSdkChatLike` / `ChatSdkThread` / `ChatSdkMessage`
 * contracts with no platform dependency, so a connector descriptor can be driven end to end from a
 * unit test or an offline demo without a real Chat SDK installation. They are wired to satisfy the
 * loader's structural types with ZERO casts in user code, e.g.:
 *
 * ```ts
 * const loaded = await loadChatSdkConnector({
 *   agentDir,
 *   connector: myDescriptor,
 *   connectorId: "slack",
 *   createChat: createTestChat(),
 * });
 * await loaded.simulateInbound({
 *   thread: createTestThread(),
 *   message: createTestMessage({ text: "hello" }),
 * });
 * ```
 *
 * They are intended for tests and offline demos only — not for production traffic.
 */

async function drainTextStream(stream: AsyncIterable<string>): Promise<string> {
  let text = "";
  for await (const chunk of stream) {
    text += chunk;
  }
  return text;
}

let testMessageCounter = 0;

export type CreateTestMessageOptions = Partial<ChatSdkMessage> & { text?: string };

/**
 * Build a {@link ChatSdkMessage} with sensible defaults for tests/offline demos. The `id`
 * auto-increments (`test-message-1`, `test-message-2`, ...) and the author defaults to a non-bot,
 * not-me user. Any field can be overridden; `text` is accepted for convenience and maps to
 * `message.text`.
 *
 * To simulate a file upload, pass `attachments` — a `data`-backed attachment is inlined with no
 * network access at all:
 *
 * ```ts
 * createTestMessage({
 *   text: "what does this say?",
 *   attachments: [
 *     { type: "file", name: "notes.txt", mimeType: "text/plain", data: new TextEncoder().encode("hi") },
 *   ],
 * });
 * ```
 *
 * For tests and offline demos only.
 */
export function createTestMessage(options: CreateTestMessageOptions = {}): ChatSdkMessage {
  const { id, text, threadId, author, ...rest } = options;
  return {
    id: id ?? `test-message-${(testMessageCounter += 1)}`,
    text: text ?? "test message",
    threadId: threadId ?? "test-thread",
    author: author ?? {
      userId: "test-user",
      userName: "tester",
      isMe: false,
    },
    ...rest,
  };
}

export type CreateTestThreadOptions = {
  id?: string;
  adapterName?: string;
  isDM?: boolean;
  messages?: ChatSdkMessage[];
};

/**
 * A {@link ChatSdkThread} test double whose side effects are recorded instead of hitting a platform:
 * - `posts` collects the text handed to `post()` (a streamed `AsyncIterable<string>` is drained and
 *   concatenated into a single entry; a plain string is recorded as-is);
 * - `subscribeCalls` counts `subscribe()` invocations;
 * - `typingStatuses` records every `startTyping(status)` argument.
 */
export type TestThread = ChatSdkThread & {
  posts: string[];
  subscribeCalls: number;
  typingStatuses: Array<string | undefined>;
};

/**
 * Build a {@link ChatSdkThread} test double that records what a connector run posts back. `post()`
 * drains a streamed reply (or accepts a plain string) into `posts`; `subscribe()` and `startTyping()`
 * are no-op recorders (`subscribeCalls` / `typingStatuses`). Pass `messages` to expose a
 * newest-first thread history for `history: { source: "thread" }` policies.
 *
 * For tests and offline demos only.
 */
export function createTestThread(options: CreateTestThreadOptions = {}): TestThread {
  const messages = options.messages;
  const thread: TestThread = {
    id: options.id ?? "test-thread",
    adapter: { name: options.adapterName ?? "test-adapter" },
    ...(options.isDM === undefined ? {} : { isDM: options.isDM }),
    ...(messages === undefined
      ? {}
      : {
          messages: {
            async *[Symbol.asyncIterator](): AsyncIterator<ChatSdkMessage> {
              for (const item of messages) yield item;
            },
          },
        }),
    posts: [],
    subscribeCalls: 0,
    typingStatuses: [],
    async post(value: string | AsyncIterable<string>): Promise<unknown> {
      const text = typeof value === "string" ? value : await drainTextStream(value);
      thread.posts.push(text);
      return { id: `test-post-${thread.posts.length}` };
    },
    async subscribe(): Promise<void> {
      thread.subscribeCalls += 1;
    },
    async startTyping(status?: string): Promise<void> {
      thread.typingStatuses.push(status);
    },
  };
  return thread;
}

type TestDirectMessageHandler = (
  thread: ChatSdkThread,
  message: ChatSdkMessage,
  channel?: unknown,
  context?: ChatSdkMessageContext,
) => Promise<void> | void;

type TestMentionHandler = (
  thread: ChatSdkThread,
  message: ChatSdkMessage,
  context?: ChatSdkMessageContext,
) => Promise<void> | void;

type TestSubscribedHandler = (
  thread: ChatSdkThread,
  message: ChatSdkMessage,
  context?: ChatSdkMessageContext,
) => Promise<void> | void;

/**
 * The trigger handlers a {@link TestChat} recorded during loading, exposed so a test can drive a run
 * directly (`chat.handlers.directMessage[0]!(thread, message)`) when it does not want to go through
 * `loaded.simulateInbound(...)`.
 */
export type TestChatHandlers = {
  directMessage: TestDirectMessageHandler[];
  mention: TestMentionHandler[];
  subscribedMessage: TestSubscribedHandler[];
};

/**
 * A {@link ChatSdkChatLike} test-double instance produced by {@link createTestChat}. The lifecycle and
 * trigger-registration methods are declared as required (rather than the optional members they refine
 * on `ChatSdkChatLike`) so tests can invoke them without optional-chaining.
 */
export type TestChat = ChatSdkChatLike & {
  readonly config: Record<string, unknown>;
  readonly handlers: TestChatHandlers;
  initializeCalls: number;
  shutdownCalls: number;
  initialize(): Promise<void>;
  shutdown(): Promise<void>;
  onDirectMessage(handler: TestDirectMessageHandler): void;
  onNewMention(handler: TestMentionHandler): void;
  onSubscribedMessage(handler: TestSubscribedHandler): void;
};

/**
 * The constructor returned by {@link createTestChat}. Assignable to `ChatSdkChatConstructor`, and also
 * exposes the constructed `instances` so a test using `loadChatSdkConnector` can reach the recorded
 * handlers cast-free (e.g. `const TestChat = createTestChat(); ...; TestChat.instances[0]!.handlers`).
 */
export type TestChatConstructor = (new (config: Record<string, unknown>) => TestChat) & {
  readonly instances: TestChat[];
};

/**
 * Build a `ChatSdkChatConstructor` test double. The class satisfies `ChatSdkChatLike` with:
 * - no-op webhooks (each registered adapter name maps to a handler returning a `200` `Response`);
 * - `onDirectMessage` / `onNewMention` / `onSubscribedMessage` that record their handlers on the
 *   instance's `handlers` record (also collected on the constructor's `instances` array);
 * - no-op `initialize` / `shutdown` (invocation counts recorded).
 *
 * Adapter names for the webhook map are taken from the constructed `config.adapters` (as the loader
 * passes them) plus any `options.adapterName`.
 *
 * For tests and offline demos only.
 */
export function createTestChat(options: { adapterName?: string } = {}): TestChatConstructor {
  const instances: TestChat[] = [];

  class TestChatImpl {
    static readonly instances = instances;
    readonly config: Record<string, unknown>;
    readonly webhooks: Record<
      string,
      (request: Request, options?: ChatSdkWebhookOptions) => Promise<Response>
    >;
    readonly handlers: TestChatHandlers = {
      directMessage: [],
      mention: [],
      subscribedMessage: [],
    };
    initializeCalls = 0;
    shutdownCalls = 0;

    constructor(config: Record<string, unknown>) {
      this.config = config;
      const adapterNames = new Set<string>();
      if (options.adapterName !== undefined) adapterNames.add(options.adapterName);
      const adapters = config.adapters;
      if (adapters !== null && typeof adapters === "object") {
        for (const name of Object.keys(adapters)) adapterNames.add(name);
      }
      if (adapterNames.size === 0) adapterNames.add("test-adapter");
      this.webhooks = Object.fromEntries(
        [...adapterNames].map((name) => [
          name,
          async () => new Response(null, { status: 200 }),
        ]),
      );
      instances.push(this);
    }

    async initialize(): Promise<void> {
      this.initializeCalls += 1;
    }

    async shutdown(): Promise<void> {
      this.shutdownCalls += 1;
    }

    onDirectMessage(handler: TestDirectMessageHandler): void {
      this.handlers.directMessage.push(handler);
    }

    onNewMention(handler: TestMentionHandler): void {
      this.handlers.mention.push(handler);
    }

    onSubscribedMessage(handler: TestSubscribedHandler): void {
      this.handlers.subscribedMessage.push(handler);
    }
  }

  return TestChatImpl;
}
