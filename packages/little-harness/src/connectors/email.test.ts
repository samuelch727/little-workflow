import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UIMessage } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness } from "../create-harness.js";
import type { StreamHarnessTurnFinished } from "../execution/result.js";
import { sha256Hex } from "../ids.js";
import { localHost } from "../local-host/index.js";
import { loadChatSdkConnector } from "./chat-sdk.js";
import type { ChatSdkAttachment, ChatSdkMessage } from "./descriptors.js";
import { emailConnector, type EmailConnectorOptions, type EmailSkip } from "./email.js";
import { createTestChat, createTestMessage, createTestThread } from "./testing.js";

const model = { modelId: "mock", specificationVersion: "v2", provider: "mock" } as any;
const AGENT = "support@agents.example.com";
const THREAD = "resend:alice@example.com:0123456789abcdef";
const AUTHSERV_ID = "mx.resend.example";
const PASSING_DMARC = "mx.resend.example; spf=pass; dkim=pass; dmarc=pass header.from=example.com";
const dirs: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** The parts of Chat SDK state the email policy uses. */
class FakeState {
  readonly values = new Map<string, unknown>();
  readonly lists = new Map<string, unknown[]>();
  async setIfNotExists(key: string, value: unknown): Promise<boolean> {
    if (this.values.has(key)) return false;
    this.values.set(key, value);
    return true;
  }
  async appendToList(key: string, value: unknown, options?: { maxLength?: number }): Promise<void> {
    const list = [...(this.lists.get(key) ?? []), value];
    this.lists.set(key, options?.maxLength === undefined ? list : list.slice(-options.maxLength));
  }
  async getList(key: string): Promise<unknown[]> {
    return this.lists.get(key) ?? [];
  }
}

/** Stands in for the Chat SDK instance an adapter is initialized with. */
class FakeChatInstance {
  readonly state = new FakeState();
  readonly processed: Array<{ adapter: unknown; threadId: string; message: ChatSdkMessage }> = [];
  getState() {
    return this.state;
  }
  processMessage(adapter: unknown, threadId: string, message: ChatSdkMessage) {
    this.processed.push({ adapter, threadId, message });
    return Promise.resolve();
  }
}

/** Shaped like `@resend/chat-sdk-adapter`'s ResendAdapter, with a fake Resend client behind it. */
function fakeResendAdapter(attachmentSize?: number) {
  // Kept separately: the wrapper replaces `client.emails.send` with a header-adding version.
  const send = vi.fn(async (_payload: Record<string, unknown>) => ({ data: { id: "out_1" }, error: null }));
  const client = {
    emails: {
      send,
      receiving: {
        attachments: {
          list: vi.fn(async (_options: { emailId: string }) => ({
            data: {
              data: [
                {
                  id: "att_1",
                  filename: "receipt.pdf",
                  content_type: "application/pdf",
                  ...(attachmentSize === undefined ? {} : { size: attachmentSize }),
                  download_url: "https://files.example/receipt.pdf",
                },
              ],
            },
            error: null,
          })),
        },
      },
    },
  };
  const adapter = {
    name: "resend",
    userName: AGENT,
    chat: undefined as undefined | { processMessage: (...args: unknown[]) => unknown },
    getResend() {
      return client;
    },
    async initialize(chat: { processMessage: (...args: unknown[]) => unknown }) {
      this.chat = chat;
    },
    /** What the real adapter's handleWebhook does once it has parsed an email. */
    receive(message: ChatSdkMessage, threadId = THREAD, options?: Record<string, unknown>) {
      return this.chat!.processMessage(this, threadId, message, options);
    },
    async postMessage(threadId: string, message: { markdown: string }) {
      await client.emails.send({
        to: ["alice@example.com"],
        text: message.markdown,
        headers: { "In-Reply-To": "<root@example.com>", References: "<root@example.com>" },
      });
      return { id: "out_1", threadId, raw: {} };
    },
    async stream(threadId: string, textStream: AsyncIterable<string>) {
      let text = "";
      for await (const chunk of textStream) text += chunk;
      if (!text) throw new Error("Resend adapter received a stream with no textual content");
      return this.postMessage(threadId, { markdown: text });
    },
    startTyping(): never {
      throw new Error("startTyping is not supported by the Resend adapter");
    },
  };
  return { adapter, client, send };
}

/** How Resend's adapter reads `From` (the first `<...>`), which decides where its replies go. */
function resendAuthor(fromHeader: string): string {
  const trimmed = fromHeader.trim();
  return (/<([^>]+)>/u.exec(trimmed)?.[1] ?? trimmed).toLowerCase();
}

let emailCounter = 0;
function inboundEmail(
  overrides: {
    id?: string;
    from?: string;
    /** The raw `From` header, when it should be more than `Alice <from>`. */
    fromHeader?: string;
    to?: readonly string[];
    text?: string;
    subject?: string;
    messageId?: string;
    headers?: Record<string, string | string[]>;
    attachments?: ChatSdkAttachment[];
  } = {},
): ChatSdkMessage {
  emailCounter += 1;
  const id = overrides.id ?? `re_${emailCounter}`;
  const fromHeader = overrides.fromHeader ?? `Alice <${overrides.from ?? "alice@example.com"}>`;
  const author = resendAuthor(fromHeader);
  const text = overrides.text ?? "Where is my order?";
  return createTestMessage({
    id,
    text,
    threadId: THREAD,
    author: { userId: author, userName: author, isMe: author === AGENT },
    attachments: overrides.attachments ?? [],
    raw: {
      id,
      messageId: overrides.messageId ?? `<${id}@mail.example.com>`,
      from: fromHeader,
      to: overrides.to ?? [AGENT],
      subject: overrides.subject ?? "Order 1234",
      text,
      headers: { "Authentication-Results": PASSING_DMARC, ...overrides.headers },
      attachments: (overrides.attachments ?? []).map((item) => ({ filename: item.name, contentType: item.mimeType })),
    },
  });
}

async function wrapped(options: Partial<EmailConnectorOptions> = {}, attachmentSize?: number) {
  const skips: EmailSkip[] = [];
  const { adapter, client, send } = fakeResendAdapter(attachmentSize);
  const descriptor = emailConnector({
    address: AGENT,
    adapter: { name: "resend", create: () => adapter },
    state: () => ({}),
    senders: { allow: ["@example.com"], authServId: AUTHSERV_ID },
    onSkip: (skip) => {
      skips.push(skip);
    },
    ...options,
  });
  const wrapper = (await descriptor.adapter.create()) as any;
  const chat = new FakeChatInstance();
  await wrapper.initialize(chat);
  return { wrapper, adapter, client, send, chat, skips };
}

describe("emailConnector adapter wrapper", () => {
  it("hands an accepted email to the Chat SDK through the wrapper, with quoted text removed", async () => {
    const { wrapper, adapter, chat, skips } = await wrapped();
    const message = inboundEmail({
      id: "re_quoted",
      text: "Yes, refund it please.\n\nOn Mon, 6 Oct 2026, Support <support@agents.example.com> wrote:\n> Shall I refund it?",
    });

    await adapter.receive(message);

    expect(skips).toEqual([]);
    expect(chat.processed).toHaveLength(1);
    expect(chat.processed[0]!.adapter).toBe(wrapper);
    expect(chat.processed[0]!.message.text).toBe(
      "Yes, refund it please.\n\n[Quoted text and signatures were removed from this email. The full email is saved at /session/email/re_quoted.txt]",
    );
    expect((message.raw as Record<string, unknown>).littleHarnessEmail).toEqual({
      originalText: "Yes, refund it please.\n\nOn Mon, 6 Oct 2026, Support <support@agents.example.com> wrote:\n> Shall I refund it?",
      file: "/session/email/re_quoted.txt",
    });
  });

  it("leaves a message with nothing to strip unchanged", async () => {
    const { adapter, chat } = await wrapped();
    const message = inboundEmail({ text: "Where is my order?" });
    await adapter.receive(message);
    expect(chat.processed[0]!.message.text).toBe("Where is my order?");
    expect((message.raw as Record<string, unknown>).littleHarnessEmail).toBeUndefined();
  });

  it.each([
    ["automated", { headers: { "Auto-Submitted": "auto-replied" } }],
    ["automated", { headers: { "List-Id": "<news.example.com>" } }],
    ["automated", { from: "mailer-daemon@example.com" }],
    ["not-addressed", { to: ["sales@agents.example.com"] }],
    ["sender-not-allowed", { from: "eve@evil.example" }],
    ["dmarc-not-passed", { headers: { "Authentication-Results": "mx.resend.example; dmarc=fail" } }],
  ] as const)("refuses %s mail quietly", async (reason, overrides) => {
    const { adapter, chat, skips } = await wrapped();
    await adapter.receive(inboundEmail(overrides));
    expect(chat.processed).toEqual([]);
    expect(skips.map((skip) => skip.reason)).toEqual([reason]);
    expect(skips[0]!.threadId).toBe(THREAD);
    expect(skips[0]!.detail).not.toContain("@");
  });

  it("refuses mail without a DMARC verdict unless requireDmarc is off", async () => {
    const strict = await wrapped();
    const noVerdict = { headers: { "Authentication-Results": "mx.resend.example; spf=pass" } };
    await strict.adapter.receive(inboundEmail(noVerdict));
    expect(strict.skips.map((skip) => skip.reason)).toEqual(["dmarc-not-passed"]);

    const relaxed = await wrapped({ senders: { allow: ["@example.com"], requireDmarc: false } });
    await relaxed.adapter.receive(inboundEmail(noVerdict));
    expect(relaxed.chat.processed).toHaveLength(1);
  });

  it("refuses to start without authServId while requireDmarc is on", () => {
    const options = { address: AGENT, adapter: { name: "resend", create: () => ({ name: "resend" }) }, state: () => ({}) };
    expect(() => emailConnector({ ...options, senders: { allow: ["@example.com"] } })).toThrow(
      /senders\.authServId is required while senders\.requireDmarc is on.*onSkip/su,
    );
    expect(() => emailConnector({ ...options, senders: { allow: "anyone", authServId: " " } })).toThrow(/authServId/u);
    expect(() => emailConnector({ ...options, senders: { allow: "anyone", requireDmarc: false } })).not.toThrow();
  });

  it("refuses a passing Authentication-Results header that another server or the sender wrote", async () => {
    const { adapter, chat, skips } = await wrapped();
    await adapter.receive(
      inboundEmail({ headers: { "Authentication-Results": "attacker.example; dmarc=pass header.from=example.com" } }),
    );
    expect(chat.processed).toEqual([]);
    expect(skips.map((skip) => skip.reason)).toEqual(["dmarc-not-passed"]);
    expect(skips[0]!.detail).toContain('authserv-id "mx.resend.example"');
    expect(skips[0]!.detail).toContain("authserv-ids in this email: attacker.example");
  });

  it("reads folded Authentication-Results headers, and a planted pass cannot outvote a folded failure", async () => {
    const folded = (verdict: string) =>
      `mx.resend.example;\r\n\tspf=pass smtp.mailfrom=example.com;\r\n\tdkim=pass header.d=example.com;\r\n\tdmarc=${verdict} header.from=example.com`;
    const { adapter, chat, skips } = await wrapped();

    await adapter.receive(inboundEmail({ headers: { "Authentication-Results": folded("pass") } }));
    expect(chat.processed).toHaveLength(1);

    await adapter.receive(
      inboundEmail({
        headers: {
          "Authentication-Results": [folded("fail"), "mx.resend.example; dmarc=pass header.from=example.com"],
        },
      }),
    );
    expect(chat.processed).toHaveLength(1);
    expect(skips.map((skip) => [skip.reason, skip.detail])).toEqual([["dmarc-not-passed", "the email failed DMARC"]]);
  });

  it("refuses a From that is not exactly one address, or that the adapter reads differently", async () => {
    const { adapter, chat, skips } = await wrapped({ senders: { allow: "anyone", authServId: AUTHSERV_ID } });
    // The harness would vet ceo@example.com while Resend's adapter replies to eve@evil.com.
    await adapter.receive(inboundEmail({ fromHeader: '"<eve@evil.com>" <ceo@example.com>' }), "resend:eve@evil.com:0a");
    await adapter.receive(inboundEmail({ fromHeader: "eve@evil.com, ceo@example.com" }));
    await adapter.receive(inboundEmail({ fromHeader: "Eve <eve@evil.com>, Ceo <ceo@example.com>" }));
    expect(chat.processed).toEqual([]);
    expect(skips.map((skip) => [skip.reason, skip.detail])).toEqual([
      ["sender-not-allowed", "the adapter reads the From header as a different address"],
      ["sender-not-allowed", "the From header does not hold exactly one address"],
      ["sender-not-allowed", "the From header does not hold exactly one address"],
    ]);
  });

  it("lets anyone in with senders.allow = 'anyone'", async () => {
    const { adapter, chat } = await wrapped({ senders: { allow: "anyone", authServId: AUTHSERV_ID } });
    await adapter.receive(
      inboundEmail({
        from: "stranger@elsewhere.example",
        headers: { "Authentication-Results": "mx.resend.example; dmarc=pass header.from=elsewhere.example" },
      }),
      "resend:stranger@elsewhere.example:0123456789abcdef",
    );
    expect(chat.processed).toHaveLength(1);
  });

  it("refuses a reply filed under a thread that another sender started", async () => {
    const { adapter, chat, skips } = await wrapped();
    // Bob, on Cc of Alice's email, hits Reply-All: Resend files it under Alice's thread.
    await adapter.receive(inboundEmail({ from: "bob@example.com", to: [AGENT, "alice@example.com"] }));
    expect(chat.processed).toEqual([]);
    expect(skips.map((skip) => [skip.reason, skip.detail])).toEqual([
      ["other-sender", "the email replies in a thread that another sender started"],
    ]);

    await adapter.receive(inboundEmail({ from: "bob@example.com" }), "resend:bob@example.com:fedcba9876543210");
    expect(chat.processed).toHaveLength(1);
  });

  it("checks who started the thread whenever the adapter itself is Resend's", async () => {
    const { adapter } = fakeResendAdapter();
    const skips: EmailSkip[] = [];
    const descriptor = emailConnector({
      address: AGENT,
      adapter: { name: "email", create: () => adapter },
      state: () => ({}),
      senders: { allow: ["@example.com"], authServId: AUTHSERV_ID },
      onSkip: (skip) => {
        skips.push(skip);
      },
    });
    const wrapper = (await descriptor.adapter.create()) as any;
    await wrapper.initialize(new FakeChatInstance());
    await adapter.receive(inboundEmail({ from: "bob@example.com" }));
    expect(skips.map((skip) => skip.reason)).toEqual(["other-sender"]);
  });

  it("refuses a second email with the same Message-ID", async () => {
    const { adapter, chat, skips } = await wrapped();
    await adapter.receive(inboundEmail({ id: "re_a", messageId: "<same@example.com>" }));
    await adapter.receive(inboundEmail({ id: "re_b", messageId: "<same@example.com>" }));
    expect(chat.processed).toHaveLength(1);
    expect(skips.map((skip) => skip.reason)).toEqual(["duplicate"]);
  });

  it("applies the accept hook after the built-in checks", async () => {
    const accept = vi.fn((email: { subject: string }) =>
      email.subject.startsWith("[ticket]") ? true : { skip: "no ticket tag" },
    );
    const { adapter, chat, skips } = await wrapped({ accept });
    await adapter.receive(inboundEmail({ subject: "hello" }));
    await adapter.receive(inboundEmail({ subject: "[ticket] broken" }));
    await adapter.receive(inboundEmail({ headers: { Precedence: "bulk" } }));
    expect(chat.processed).toHaveLength(1);
    expect(skips.map((skip) => [skip.reason, skip.detail])).toEqual([
      ["rejected", "no ticket tag"],
      ["automated", "Precedence: bulk"],
    ]);
    expect(accept).toHaveBeenCalledTimes(2);
  });

  it("gives the agent the subject when the email has no text", async () => {
    const { adapter, chat } = await wrapped();
    await adapter.receive(inboundEmail({ text: "", subject: "Please call me back" }));
    await adapter.receive(inboundEmail({ text: "  \n", subject: "" }));
    expect(chat.processed.map((entry) => entry.message.text)).toEqual([
      "Please call me back",
      "(This email has no subject or text.)",
    ]);
  });

  it("uses a custom transform for the text the agent reads", async () => {
    const { adapter, chat } = await wrapped({ transform: (email) => email.text.toUpperCase() });
    await adapter.receive(inboundEmail({ id: "re_upper", text: "hi there" }));
    expect(chat.processed[0]!.message.text).toBe(
      "HI THERE\n\n[This email was edited before it reached you. The full email is saved at /session/email/re_upper.txt]",
    );
  });

  it("passes the agent's own mail through for the Chat SDK to drop", async () => {
    const { adapter, chat, skips } = await wrapped();
    await adapter.receive(inboundEmail({ from: AGENT, to: ["alice@example.com"] }));
    expect(chat.processed).toHaveLength(1);
    expect(skips).toEqual([]);
  });

  it("registers the handling task with waitUntil", async () => {
    const { adapter, chat } = await wrapped();
    const tasks: Array<Promise<unknown>> = [];
    adapter.receive(inboundEmail(), THREAD, { waitUntil: (task: Promise<unknown>) => tasks.push(task) });
    expect(tasks).toHaveLength(1);
    await tasks[0];
    expect(chat.processed).toHaveLength(1);
  });

  it("marks replies Auto-Submitted and keeps the adapter's threading headers", async () => {
    const { wrapper, send } = await wrapped();
    await wrapper.stream(THREAD, (async function* () {
      yield "Your refund ";
      yield { type: "markdown_text", text: "is on its way." };
    })());
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toMatchObject({
      text: "Your refund is on its way.",
      headers: {
        "Auto-Submitted": "auto-replied",
        "In-Reply-To": "<root@example.com>",
        References: "<root@example.com>",
      },
    });
  });

  it("sends nothing for an empty reply instead of throwing", async () => {
    const { wrapper, send } = await wrapped();
    const result = await wrapper.stream(THREAD, (async function* () {
      yield "  ";
    })());
    expect(send).not.toHaveBeenCalled();
    expect(result).toMatchObject({ threadId: THREAD, raw: { skipped: "empty-reply" } });
    expect(result.id).toMatch(/^little-harness-no-reply:/u);
  });

  it("stops answering a thread after maxRepliesPerThread replies", async () => {
    const { wrapper, adapter, chat, skips } = await wrapped({ maxRepliesPerThread: 1 });
    await adapter.receive(inboundEmail());
    await wrapper.stream(THREAD, (async function* () {
      yield "First reply";
    })());
    await adapter.receive(inboundEmail());
    await adapter.receive(inboundEmail(), "resend:alice@example.com:another-thread");
    expect(chat.processed.map((entry) => entry.threadId)).toEqual([THREAD, "resend:alice@example.com:another-thread"]);
    expect(skips.map((skip) => skip.reason)).toEqual(["reply-limit"]);
  });

  it("ignores typing indicators and keeps thread history in state", async () => {
    const { wrapper } = await wrapped();
    await expect(wrapper.startTyping(THREAD)).resolves.toBeUndefined();
    expect(wrapper.persistThreadHistory).toBe(true);
    expect(wrapper.name).toBe("resend");
    expect(wrapper.userName).toBe(AGENT);
  });

  it("gives Resend attachments a fetchData that downloads them", async () => {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1, 2, 3])));
    vi.stubGlobal("fetch", fetchMock);
    const { wrapper, adapter, client, chat } = await wrapped();
    await adapter.receive(
      inboundEmail({ id: "re_files", attachments: [{ type: "file", name: "receipt.pdf", mimeType: "application/pdf" }] }),
    );

    const attachment = chat.processed[0]!.message.attachments![0]!;
    expect(attachment.fetchMetadata).toEqual({ resendEmailId: "re_files", resendAttachmentIndex: "0" });
    await expect(attachment.fetchData!()).resolves.toEqual(new Uint8Array([1, 2, 3]));
    expect(client.emails.receiving.attachments.list).toHaveBeenCalledWith({ emailId: "re_files" });
    expect(fetchMock).toHaveBeenCalledWith("https://files.example/receipt.pdf");

    // A message rehydrated from the Chat SDK queue gets its fetchData back.
    const { fetchData: _dropped, ...serialized } = attachment;
    const rehydrated = wrapper.rehydrateAttachment(serialized);
    await expect(rehydrated.fetchData()).resolves.toEqual(new Uint8Array([1, 2, 3]));
  });

  it("does not download a Resend attachment that is over attachments.maxBytes", async () => {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1, 2, 3])));
    vi.stubGlobal("fetch", fetchMock);
    const { adapter, chat } = await wrapped({ attachments: { maxBytes: 1024 } }, 5 * 1024 * 1024);
    await adapter.receive(
      inboundEmail({ id: "re_big", attachments: [{ type: "file", name: "receipt.pdf", mimeType: "application/pdf" }] }),
    );
    const attachment = chat.processed[0]!.message.attachments![0]!;
    await expect(attachment.fetchData!()).rejects.toThrow(/over the 1024-byte attachments\.maxBytes cap/u);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("warns once when the adapter's send client cannot be marked Auto-Submitted", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const descriptor = emailConnector({
      address: AGENT,
      adapter: { name: "imap", create: () => ({ name: "imap-test-adapter" }) },
      state: () => ({}),
      senders: { allow: "anyone", requireDmarc: false },
    });
    const wrapper = (await descriptor.adapter.create()) as any;
    await wrapper.initialize(new FakeChatInstance());
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("not marked Auto-Submitted: auto-replied"));
  });
});

function streamResult(text = "ok") {
  return {
    text: Promise.resolve(text),
    output: Promise.resolve(text),
    textStream: (async function* () {
      yield text;
    })(),
    toUIMessageStream: () => new ReadableStream(),
    toUIMessageStreamResponse: () => new Response(text),
    finished: Promise.resolve({ status: "completed", artifacts: [], warnings: [] } as unknown as StreamHarnessTurnFinished),
  };
}

async function tmpAgent(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "little-harness-email-"));
  dirs.push(dir);
  return dir;
}

describe("emailConnector descriptor", () => {
  it("sets the email triggers, no reactions, and Chat SDK settings for retries and queued mail", () => {
    const descriptor = emailConnector({
      address: "Support@Agents.Example.com",
      adapter: { name: "resend", create: () => ({ name: "resend" }) },
      state: () => ({}),
      senders: { allow: ["@example.com"], authServId: AUTHSERV_ID },
      chat: { logger: "silent" },
    });
    expect(descriptor.kind).toBe("chat-sdk");
    expect(descriptor.userName).toBe("support");
    expect(descriptor.triggers).toEqual({ directMessage: false, mention: { subscribe: true }, subscribedMessage: true });
    expect(descriptor.reactions).toBe(false);
    expect(descriptor.chat).toMatchObject({
      logger: "silent",
      dedupeTtlMs: 3 * 24 * 60 * 60 * 1000,
      concurrency: { strategy: "queue" },
      history: { thread: { maxMessages: 100 } },
    });
  });

  it("runs one session per email thread with no address in its id, and saves the original email", async () => {
    const agentDir = await tmpAgent();
    const harness = createHarness({ host: localHost({ dataDir: join(agentDir, ".data") }), model });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const seen: Array<{ session: string; messages: UIMessage[]; trigger: unknown }> = [];
    const userBeforeRun = vi.fn();
    const descriptor = emailConnector({
      address: AGENT,
      adapter: { name: "resend", create: () => ({ name: "resend" }) },
      state: () => ({}),
      senders: { allow: ["@example.com"], authServId: AUTHSERV_ID },
      beforeRun: userBeforeRun,
    });
    const loaded = await loadChatSdkConnector({
      agentDir,
      connector: descriptor,
      connectorId: "email",
      loadHarness: async () => harness,
      createChat: createTestChat(),
      streamHarness: (options) => {
        seen.push({ session: options.session as string, messages: options.messages as UIMessage[], trigger: options.trigger });
        return streamResult("On it.") as any;
      },
    });

    const original = "Any update?\n\nOn Mon, Support <support@agents.example.com> wrote:\n> We are looking into it.";
    const message = inboundEmail({ id: "re_saved", text: original });
    message.text = "Any update?\n\n[Quoted text and signatures were removed from this email. The full email is saved at /session/email/re_saved.txt]";
    (message.raw as Record<string, unknown>).littleHarnessEmail = { originalText: original, file: "/session/email/re_saved.txt" };
    const history = [
      createTestMessage({ id: "agent-1", text: "We are looking into it.", author: { userId: "self", userName: AGENT, isMe: true } }),
      createTestMessage({ id: "no-reply", text: "", author: { userId: "self", userName: AGENT, isMe: true } }),
      createTestMessage({ id: "re_first", text: "My order is late.", author: { userId: "alice@example.com", userName: "alice", isMe: false } }),
    ];
    const thread = createTestThread({ id: THREAD, adapterName: "resend", messages: [message, ...history] });

    await loaded.simulateInbound({ trigger: "subscribedMessage", thread, message });

    const sessionId = `email:${sha256Hex(THREAD).slice(0, 16)}`;
    expect(seen[0]!.session).toBe(sessionId);
    expect(seen[0]!.session).not.toContain("@");
    expect(seen[0]!.messages.map((item) => [item.role, (item.parts[0] as { text: string }).text])).toEqual([
      ["user", "My order is late."],
      ["assistant", "We are looking into it."],
      ["user", message.text],
    ]);
    expect(thread.posts).toEqual(["On it."]);
    expect(thread.typingStatuses).toEqual([]);
    expect(userBeforeRun).toHaveBeenCalledTimes(1);
    // Traces show an email turn by its sender and subject, not by the provider.
    expect(seen[0]!.trigger).toEqual({ kind: "message", source: "email", from: "alice@example.com", label: "Order 1234" });

    const session = await harness.sessions.get(sessionId);
    const saved = await session!.files.read("/session/email/re_saved.txt");
    expect(saved.text()).toBe(
      `From: Alice <alice@example.com>\nTo: ${AGENT}\nSubject: Order 1234\nMessage-ID: <re_saved@mail.example.com>\n\n${original}\n`,
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("runs an agent with the bash tool enabled"));
  });
});
