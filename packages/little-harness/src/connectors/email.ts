import type { UIMessage } from "ai";
import { sha256Hex } from "../ids.js";
import { DEFAULT_ATTACHMENT_MAX_BYTES } from "./attachments.js";
import { messageToUIMessage } from "./chat-sdk.js";
import {
  chatSdkConnector,
  type ChatSdkAdapterFactoryResult,
  type ChatSdkAttachment,
  type ChatSdkConnectorDescriptor,
  type ChatSdkConnectorOptions,
  type ChatSdkMessage,
  type ChatSdkRunContext,
  type ChatSdkWebhookOptions,
  type ConnectorHistoryPolicy,
} from "./descriptors.js";
import {
  authenticationResults,
  automatedEmailReason,
  dmarcResult,
  parseEmailAddress,
  readInboundEmail,
  senderAllowed,
  stripQuotedReply,
  type InboundEmail,
} from "./email-message.js";
import { CHAT_TURN_TRIGGER, type ChatTurnTrigger } from "./turn-trigger.js";

const DEFAULT_MAX_REPLIES_PER_THREAD = 20;
const DEFAULT_HISTORY_LIMIT = 20;
const DAY_MS = 24 * 60 * 60 * 1000;
// Providers retry webhooks for hours (Svix, behind Resend, for over a day), well past the Chat SDK's
// 10-minute default dedupe window.
const DEDUPE_TTL_MS = 3 * DAY_MS;
// Matches how long Resend's adapter remembers which thread a Message-ID belongs to.
const THREAD_STATE_TTL_MS = 30 * DAY_MS;
const QUEUE_ENTRY_TTL_MS = 30 * 60 * 1000;
const OUTBOUND_HEADERS: Readonly<Record<string, string>> = { "Auto-Submitted": "auto-replied" };
/** Where the email adapter wrapper leaves the original body for `beforeRun` to save. */
const EMAIL_RAW_KEY = "littleHarnessEmail";
const OUTBOUND_PATCHED = Symbol.for("little-harness.email.outbound-headers");

/** Why the email connector refused an inbound email without running the agent. */
export type EmailSkipReason =
  /** An auto-reply, bounce, or mailing-list message (RFC 3834). */
  | "automated"
  /** The agent's address is in neither `To` nor `Cc`. */
  | "not-addressed"
  /**
   * The sender is not on `senders.allow`, or the `From` header does not hold exactly one address or
   * the adapter reads it as a different one (the address replies would go to is then unclear).
   */
  | "sender-not-allowed"
  /** `senders.requireDmarc` is on and the email did not pass DMARC. */
  | "dmarc-not-passed"
  /** The email replies in a thread that someone else started, for example a Reply-All from Cc. */
  | "other-sender"
  /** The thread already has `maxRepliesPerThread` agent replies. */
  | "reply-limit"
  /** This agent already received an email with the same `Message-ID`. */
  | "duplicate"
  /** The connector's own `accept` hook refused it. */
  | "rejected";

/** One refused email, as handed to `onSkip`. */
export type EmailSkip = {
  readonly reason: EmailSkipReason;
  /** A short explanation. It never contains an email address. */
  readonly detail: string;
  readonly email: InboundEmail;
  readonly threadId: string;
};

/**
 * Who may trigger the agent by email. There is no default: an agent with a public address takes
 * instructions from anyone who can send mail, so the choice is always written down.
 */
export type EmailSenderPolicy = {
  /**
   * Addresses (`alice@example.com`) and domains (`@example.com`, that exact domain only) whose mail
   * may trigger the agent, or `"anyone"` for an open inbox.
   */
  allow: readonly string[] | "anyone";
  /**
   * Also require the email to pass DMARC, so a forged `From:` header cannot borrow an allowed
   * sender's identity. Default `true`, which needs `authServId`. The verdict is read from the
   * `Authentication-Results` header the receiving server adds; an email without one is refused
   * while this is on.
   */
  requireDmarc?: boolean;
  /**
   * The receiving server's id in `Authentication-Results` (its first token, `mx.example.net` in
   * `Authentication-Results: mx.example.net; dmarc=pass`). Required while `requireDmarc` is on: only
   * that server's verdicts count, because a sender can put any `Authentication-Results` header in
   * their own mail. To find it, send the agent a test email and read the authserv-ids of the
   * refused email from `onSkip` (the default `onSkip` log lists them).
   */
  authServId?: string;
};

/** What an `accept` hook returns: `true` to let the email through, or `false` / a reason to refuse it. */
export type EmailAcceptResult = boolean | { skip: string };

export type EmailConnectorOptions<TExtraBody = unknown> = Omit<
  ChatSdkConnectorOptions<TExtraBody>,
  "userName" | "triggers" | "reactions"
> & {
  /** The address the agent owns, for example `support@agents.example.com`. Replies are sent from it. */
  address: string;
  /** Who may trigger the agent. See {@link EmailSenderPolicy}. */
  senders: EmailSenderPolicy;
  /** The Chat SDK bot name. Defaults to the local part of `address`. */
  userName?: string;
  /**
   * A last check of your own, after the built-in ones pass: return `false` or `{ skip: "why" }` to
   * refuse an email quietly. A refused email gets no reply, never reaches the agent or the thread's
   * history, and is reported to `onSkip` with reason `"rejected"`.
   */
  accept?: (email: InboundEmail) => EmailAcceptResult | Promise<EmailAcceptResult>;
  /**
   * The text the agent reads for an accepted email. Defaults to the body with quoted earlier
   * messages and the signature removed ({@link stripQuotedReply}). When the result differs from the
   * received body, the full original email is saved to `/session/email/<id>.txt` and the agent is
   * told where.
   */
  transform?: (email: InboundEmail) => string | Promise<string>;
  /**
   * Refuse further email in a thread once the agent has replied this many times, which stops a
   * reply loop with an auto-responder that sends no `Auto-Submitted` header. Default 20.
   */
  maxRepliesPerThread?: number;
  /**
   * Only answer email that lists `address` in `To` or `Cc`. Default `true`. One provider webhook
   * usually receives mail for a whole domain, so without this every agent on the domain would
   * answer every email. Blind-copied mail does not list the address and is refused.
   */
  requireAddressedTo?: boolean;
  /** Read a provider's message into an {@link InboundEmail}. Defaults to {@link readInboundEmail}. */
  readEmail?: (message: ChatSdkMessage) => InboundEmail;
  /** Observe refused emails. Defaults to one `console.info` line per email. Throwing is swallowed. */
  onSkip?: (skip: EmailSkip) => void | Promise<void>;
};

type EmailState = {
  setIfNotExists?: (key: string, value: unknown, ttlMs?: number) => Promise<boolean>;
  appendToList?: (key: string, value: unknown, options?: { maxLength?: number; ttlMs?: number }) => Promise<void>;
  getList?: (key: string) => Promise<unknown[]>;
};

type ProcessMessageOptions = ChatSdkWebhookOptions & {
  propagateHandlerErrors?: boolean;
  [key: string]: unknown;
};

type EmailChatInstance = {
  getState?: () => EmailState | undefined;
  processMessage: (
    adapter: unknown,
    threadId: string,
    message: unknown,
    options?: ProcessMessageOptions,
  ) => unknown;
};

/** The structural slice of a Chat SDK email adapter that the wrapper touches. */
type EmailProviderAdapter = ChatSdkAdapterFactoryResult & {
  readonly userName?: string;
  initialize?: (chat: EmailChatInstance) => Promise<void> | void;
  stream?: (threadId: string, textStream: AsyncIterable<unknown>, options?: unknown) => Promise<unknown>;
  postMessage?: (threadId: string, message: unknown) => Promise<unknown>;
  rehydrateAttachment?: (attachment: ChatSdkAttachment) => ChatSdkAttachment;
};

type ResendAttachmentData = {
  id?: string;
  filename?: string;
  content_type?: string;
  size?: number;
  download_url?: string;
};
type ResendResult<T> = { data?: T | null; error?: { message?: string } | null };
type ResendClient = {
  emails?: {
    [OUTBOUND_PATCHED]?: true;
    send?: (payload: Record<string, unknown>, options?: unknown) => Promise<unknown>;
    receiving?: {
      attachments?: {
        list?: (options: { emailId: string }) => Promise<ResendResult<{ data?: ResendAttachmentData[] }>>;
      };
    };
  };
};

type EmailRawStash = { originalText: string; file: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const warned = new Set<string>();
function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`little-harness: ${message}`);
}

/** Who started a Resend thread (`resend:<sender>:<hash>`), or `undefined` for other thread ids. */
function resendThreadSender(threadId: string): string | undefined {
  const match = /^resend:([^:]+):[^:]+$/u.exec(threadId);
  return match?.[1]?.toLowerCase();
}

function sessionFileName(id: string): string {
  const safe = id.replace(/[^A-Za-z0-9._-]/gu, "_").slice(0, 80);
  return safe.length > 0 && !/^\.+$/u.test(safe) ? safe : sha256Hex(id).slice(0, 16);
}

/**
 * The admission policy that runs before the Chat SDK sees an email. It lives below the connector
 * hooks on purpose: the Chat SDK stores every message it dispatches in thread history, records a
 * dedupe key and may subscribe the thread before any connector hook runs, so a refusal at the hook
 * level would still leave a blocked sender's text in the agent's history.
 */
function createEmailPolicy<TExtraBody>(options: EmailConnectorOptions<TExtraBody>) {
  const address = parseEmailAddress(options.address);
  const authServId = options.senders.authServId?.trim() ?? "";
  if (options.senders.requireDmarc !== false && authServId === "") {
    throw new Error(
      `emailConnector(${address}): senders.authServId is required while senders.requireDmarc is on. ` +
        "It is the first token of the Authentication-Results header your receiving mail server adds " +
        '("mx.example.net" in "Authentication-Results: mx.example.net; dmarc=pass header.from=example.com"). ' +
        "Only that server's verdicts can be trusted, because a sender can put any Authentication-Results header " +
        'in their own mail. To find it, set authServId to a placeholder such as "unknown", send the agent a test ' +
        "email from an ordinary mailbox on senders.allow, and read the authserv-ids that the refused email's onSkip log lists. If " +
        "your provider adds no Authentication-Results header, set senders.requireDmarc to false knowingly: the " +
        "allowlist alone then trusts the From header, which anyone can forge.",
    );
  }
  const maxReplies = options.maxRepliesPerThread ?? DEFAULT_MAX_REPLIES_PER_THREAD;
  const readEmail = options.readEmail ?? readInboundEmail;
  const seen = new Map<string, number>();
  const replies = new Map<string, number>();
  let state: EmailState | undefined;

  const seenKey = (messageId: string) => `little-harness:email:${address}:seen:${messageId}`;
  const repliesKey = (threadId: string) => `little-harness:email:${address}:replies:${threadId}`;

  async function markSeen(messageId: string): Promise<boolean> {
    if (state?.setIfNotExists !== undefined) {
      return state.setIfNotExists(seenKey(messageId), true, DEDUPE_TTL_MS);
    }
    const now = Date.now();
    const previous = seen.get(messageId);
    if (previous !== undefined && now - previous < DEDUPE_TTL_MS) return false;
    seen.set(messageId, now);
    return true;
  }

  async function replyCount(threadId: string): Promise<number> {
    if (state?.getList !== undefined) return (await state.getList(repliesKey(threadId))).length;
    return replies.get(threadId) ?? 0;
  }

  async function skipFor(
    email: InboundEmail,
    message: ChatSdkMessage,
    threadId: string,
    adapterName: string,
  ): Promise<Omit<EmailSkip, "email" | "threadId"> | undefined> {
    const automated = automatedEmailReason(email);
    if (automated !== undefined) return { reason: "automated", detail: automated };
    if (options.requireAddressedTo !== false && ![...email.to, ...email.cc].includes(address)) {
      return { reason: "not-addressed", detail: "the agent's address is not in To or Cc" };
    }
    if (email.from === "") {
      return { reason: "sender-not-allowed", detail: "the From header does not hold exactly one address" };
    }
    // The adapter reads `From` itself and replies to its own reading (Resend's takes the first
    // `<...>`, even inside a quoted display name). When the two readings differ, the policy below
    // would vet one address while the reply went to another.
    const author = message.author?.userId?.trim().toLowerCase();
    if (author !== undefined && author.includes("@") && author !== email.from) {
      return { reason: "sender-not-allowed", detail: "the adapter reads the From header as a different address" };
    }
    const { senders } = options;
    if (senders.allow !== "anyone" && !senderAllowed(email.from, senders.allow)) {
      return { reason: "sender-not-allowed", detail: "the sender is not on senders.allow" };
    }
    if (senders.requireDmarc !== false) {
      const dmarc = dmarcResult(email, { authServId });
      if (dmarc !== "pass") {
        return { reason: "dmarc-not-passed", detail: dmarc === "none" ? noVerdictDetail(email) : "the email failed DMARC" };
      }
    }
    // Resend's adapter files a reply under whichever thread its References name, and always answers
    // the person who started that thread. Without this check, anyone holding a thread's Message-ID
    // could write into another sender's session.
    const starter = adapterName === "resend" ? resendThreadSender(threadId) : undefined;
    if (starter !== undefined && starter !== email.from) {
      return { reason: "other-sender", detail: "the email replies in a thread that another sender started" };
    }
    const count = await replyCount(threadId);
    if (count >= maxReplies) {
      return { reason: "reply-limit", detail: `the agent already replied ${count} times in this thread` };
    }
    if (email.messageId !== undefined && !(await markSeen(email.messageId))) {
      return { reason: "duplicate", detail: "this Message-ID was already handled" };
    }
    const accepted = await options.accept?.(email);
    if (accepted === false) return { reason: "rejected", detail: "accept() returned false" };
    if (isRecord(accepted)) return { reason: "rejected", detail: accepted.skip };
    return undefined;
  }

  async function report(skip: EmailSkip): Promise<void> {
    try {
      if (options.onSkip === undefined) {
        console.info(`little-harness: email ${skip.email.id} skipped (${skip.reason}): ${skip.detail}`);
      } else {
        await options.onSkip(skip);
      }
    } catch {
      /* Skip observers must not turn a quiet refusal into a failure. */
    }
  }

  /** Why no counted DMARC verdict was found, naming the authserv-ids the email does carry. */
  function noVerdictDetail(email: InboundEmail): string {
    // Only host-name-like ids, so the detail never carries an address a sender planted.
    const ids = [...new Set(authenticationResults(email).map((header) => header.authServId))]
      .filter((id) => /^[a-z0-9][a-z0-9.-]*$/u.test(id))
      .slice(0, 5);
    return (
      `no Authentication-Results header from authserv-id "${authServId}" carries a DMARC verdict ` +
      `(authserv-ids in this email: ${ids.length === 0 ? "none" : ids.join(", ")}). Check senders.authServId, ` +
      "or set senders.requireDmarc to false if your provider never adds the header"
    );
  }

  /** Rewrite the accepted message's text to what the agent should read. */
  async function prepare(message: ChatSdkMessage, email: InboundEmail): Promise<void> {
    const body = options.transform === undefined
      ? stripQuotedReply(email.text, { subject: email.subject }).text
      : await options.transform(email);
    // A subject-only (or attachment-only) email would otherwise reach the agent as an empty message.
    const subject = email.subject.trim();
    const text = body.trim() !== "" ? body : subject !== "" ? subject : "(This email has no subject or text.)";
    if (text === email.text) return;
    if (email.text.trim() === "" || !isRecord(message.raw)) {
      message.text = text;
      return;
    }
    const file = `/session/email/${sessionFileName(email.id)}.txt`;
    const stash: EmailRawStash = { originalText: email.text, file };
    message.raw[EMAIL_RAW_KEY] = stash;
    const change = options.transform === undefined
      ? "Quoted text and signatures were removed from this email."
      : "This email was edited before it reached you.";
    message.text = `${text}\n\n[${change} The full email is saved at ${file}]`;
  }

  return {
    address,
    setState(next: EmailState | undefined) {
      state = next;
    },
    /** Decide whether the Chat SDK may see this message; rewrites it in place when it may. */
    async admit(message: ChatSdkMessage, threadId: string, adapterName: string): Promise<boolean> {
      // The Chat SDK drops the agent's own mail itself.
      if (message.author?.isMe === true) return true;
      const email = readEmail(message);
      const skip = await skipFor(email, message, threadId, adapterName);
      if (skip !== undefined) {
        await report({ ...skip, email, threadId });
        return false;
      }
      await prepare(message, email);
      return true;
    },
    async recordReply(threadId: string): Promise<void> {
      if (state?.appendToList !== undefined) {
        await state.appendToList(repliesKey(threadId), Date.now(), {
          maxLength: maxReplies + 1,
          ttlMs: THREAD_STATE_TTL_MS,
        });
        return;
      }
      replies.set(threadId, (replies.get(threadId) ?? 0) + 1);
    },
  };
}

type EmailPolicy = ReturnType<typeof createEmailPolicy>;

function resendClient(adapter: EmailProviderAdapter): ResendClient | undefined {
  // `@resend/chat-sdk-adapter` keeps its Resend client behind a lazily-initialized `getResend()`.
  // It is not public API, so every use below is feature-detected.
  const getResend = (adapter as { getResend?: () => unknown }).getResend;
  if (typeof getResend !== "function") return undefined;
  try {
    const client = getResend.call(adapter);
    return isRecord(client) ? (client as ResendClient) : undefined;
  } catch {
    return undefined;
  }
}

/** Mark every email the client sends `Auto-Submitted: auto-replied`. Returns false when it cannot. */
function patchOutboundHeaders(client: ResendClient | undefined): boolean {
  const emails = client?.emails;
  if (emails === undefined) return false;
  if (emails[OUTBOUND_PATCHED] === true) return true;
  const send = emails.send;
  if (typeof send !== "function") return false;
  emails.send = (payload, options) => {
    const headers = isRecord(payload.headers) ? payload.headers : {};
    return send.call(emails, { ...payload, headers: { ...OUTBOUND_HEADERS, ...headers } }, options);
  };
  emails[OUTBOUND_PATCHED] = true;
  return true;
}

async function downloadResendAttachment(
  client: ResendClient,
  emailId: string,
  index: number,
  attachment: ChatSdkAttachment,
  maxBytes: number,
): Promise<Uint8Array> {
  const list = client.emails?.receiving?.attachments?.list;
  if (typeof list !== "function") throw new Error("This Resend client cannot list received attachments.");
  const response = await list.call(client.emails?.receiving?.attachments, { emailId });
  if (response.error) throw new Error(response.error.message ?? "Resend could not list the attachments.");
  const items = response.data?.data ?? [];
  const sameName = (item: ResendAttachmentData) =>
    (attachment.name === undefined || item.filename === attachment.name) &&
    (attachment.mimeType === undefined || item.content_type === attachment.mimeType);
  const byIndex = items[index];
  const match = byIndex !== undefined && sameName(byIndex) ? byIndex : items.find(sameName);
  if (match?.download_url === undefined) throw new Error("Resend did not return this attachment.");
  // Resend reports the size before the download, so an oversized file never crosses the network.
  if (typeof match.size === "number" && match.size > maxBytes) {
    throw new Error(`The attachment is ${match.size} bytes, over the ${maxBytes}-byte attachments.maxBytes cap.`);
  }
  const download = await fetch(match.download_url);
  if (!download.ok) throw new Error(`Attachment download failed with status ${download.status}.`);
  return new Uint8Array(await download.arrayBuffer());
}

function resendAttachment(
  client: ResendClient,
  attachment: ChatSdkAttachment,
  emailId: string,
  index: number,
  maxBytes: number,
): ChatSdkAttachment {
  return {
    ...attachment,
    fetchMetadata: { ...attachment.fetchMetadata, resendEmailId: emailId, resendAttachmentIndex: String(index) },
    fetchData: () => downloadResendAttachment(client, emailId, index, attachment, maxBytes),
  };
}

/**
 * Wrap a Chat SDK email adapter so that it:
 * - runs the email admission policy before the Chat SDK sees a message (see {@link createEmailPolicy});
 * - keeps thread history in Chat SDK state (`persistThreadHistory`), because email providers have no
 *   history API;
 * - sends nothing for an empty reply, where Resend's adapter throws;
 * - marks outbound mail `Auto-Submitted: auto-replied` (Resend);
 * - gives inbound attachments a `fetchData` that downloads them (Resend), so they reach the agent;
 * - ignores typing indicators, which email has no equivalent for.
 */
function withEmailPolicy(inner: EmailProviderAdapter, policy: EmailPolicy, maxBytes: number): EmailProviderAdapter {
  const adapterName = inner.name ?? "email";
  let client: ResendClient | undefined;
  let wrapper: EmailProviderAdapter;

  const withAttachmentBytes = (message: ChatSdkMessage) => {
    if (client === undefined || message.attachments === undefined || message.attachments.length === 0) return;
    const resend = client;
    message.attachments = message.attachments.map((attachment, index) =>
      attachment.data !== undefined || attachment.fetchData !== undefined
        ? attachment
        : resendAttachment(resend, attachment, message.id, index, maxBytes),
    );
  };

  const proxyChat = (chat: EmailChatInstance): EmailChatInstance =>
    new Proxy(chat, {
      get(target, property) {
        if (property === "processMessage") {
          return (adapter: unknown, threadId: string, messageOrFactory: unknown, options?: ProcessMessageOptions) => {
            const { waitUntil, ...rest } = options ?? {};
            const task = (async () => {
              const message = (typeof messageOrFactory === "function"
                ? await (messageOrFactory as () => unknown)()
                : messageOrFactory) as ChatSdkMessage;
              if (!(await policy.admit(message, threadId, adapterName))) return;
              withAttachmentBytes(message);
              // Hand the Chat SDK the wrapper, not the inner adapter, so the thread it builds posts
              // through the wrapper and keeps history in state.
              await target.processMessage(adapter === inner ? wrapper : adapter, threadId, message, rest);
            })();
            const tracked = task.catch((error: unknown) => {
              console.error("little-harness: email message handling failed", error);
            });
            waitUntil?.(rest.propagateHandlerErrors === true ? task : tracked);
            return task;
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

  const overrides: Record<PropertyKey, unknown> = {
    persistThreadHistory: true,
    async initialize(chat: EmailChatInstance) {
      policy.setState(chat.getState?.());
      await inner.initialize?.call(inner, proxyChat(chat));
      if (adapterName === "resend") client = resendClient(inner);
      if (!patchOutboundHeaders(client)) {
        warnOnce(
          `outbound-headers:${adapterName}`,
          `the "${adapterName}" email adapter does not expose its send client, so replies are not marked ` +
            "Auto-Submitted: auto-replied and other auto-responders may answer them.",
        );
      }
    },
    async stream(threadId: string, textStream: AsyncIterable<unknown>, options?: unknown) {
      let text = "";
      for await (const chunk of textStream) {
        if (typeof chunk === "string") {
          text += chunk;
        } else if (isRecord(chunk) && chunk.type === "markdown_text" && typeof chunk.text === "string") {
          text += chunk.text;
        }
      }
      if (text.trim() === "") {
        // An agent that ends its turn without text sends no email. Returning a result (rather than
        // nothing) stops the Chat SDK from falling back to posting a placeholder message.
        return { id: `little-harness-no-reply:${Date.now()}`, threadId, raw: { skipped: "empty-reply" } };
      }
      const sent = typeof inner.stream === "function"
        ? await inner.stream.call(inner, threadId, singleChunk(text), options)
        : await inner.postMessage?.call(inner, threadId, { markdown: text });
      await policy.recordReply(threadId);
      return sent;
    },
    async postMessage(threadId: string, message: unknown) {
      if (typeof message === "string" && message.trim() === "") {
        return { id: `little-harness-no-reply:${Date.now()}`, threadId, raw: { skipped: "empty-reply" } };
      }
      const sent = await inner.postMessage?.call(inner, threadId, message);
      await policy.recordReply(threadId);
      return sent;
    },
    async startTyping() {
      /* Email has no typing indicator; Resend's adapter throws here, which would fail the run. */
    },
    rehydrateAttachment(attachment: ChatSdkAttachment): ChatSdkAttachment {
      const emailId = attachment.fetchMetadata?.resendEmailId;
      const index = Number(attachment.fetchMetadata?.resendAttachmentIndex);
      if (client !== undefined && emailId !== undefined && Number.isInteger(index)) {
        return resendAttachment(client, attachment, emailId, index, maxBytes);
      }
      return inner.rehydrateAttachment?.call(inner, attachment) ?? attachment;
    },
  };

  wrapper = new Proxy(inner, {
    get(target, property) {
      if (Object.hasOwn(overrides, property)) return overrides[property];
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
    has(target, property) {
      return Object.hasOwn(overrides, property) || Reflect.has(target, property);
    },
  });
  return wrapper;
}

async function* singleChunk(text: string): AsyncIterable<string> {
  yield text;
}

/**
 * Thread history for email: the Chat SDK keeps it in state (email providers have no history API),
 * already quote-stripped by the wrapper. Empty entries, which an agent turn without text leaves
 * behind, are dropped because some model providers reject empty messages.
 */
function emailThreadHistory<TExtraBody>(limit: number): ConnectorHistoryPolicy<TExtraBody> {
  return async ({ thread, message }) => {
    const earlier: UIMessage[] = [];
    if (thread.messages !== undefined && limit > 1) {
      for await (const item of thread.messages) {
        if (item.id === message.id || item.text.trim() === "") continue;
        earlier.push(messageToUIMessage(item));
        if (earlier.length >= limit - 1) break;
      }
    }
    return [...earlier.reverse(), messageToUIMessage(message)];
  };
}

function renderSavedEmail(email: InboundEmail, originalText: string): string {
  const lines = [
    `From: ${email.fromName === undefined ? email.from : `${email.fromName} <${email.from}>`}`,
    `To: ${email.to.join(", ")}`,
    ...(email.cc.length > 0 ? [`Cc: ${email.cc.join(", ")}`] : []),
    `Subject: ${email.subject}`,
    ...(email.messageId === undefined ? [] : [`Message-ID: ${email.messageId}`]),
  ];
  return `${lines.join("\n")}\n\n${originalText}\n`;
}

/** Save the full original email into the session when the agent was given a shortened one. */
async function saveOriginalEmail<TExtraBody>(ctx: ChatSdkRunContext<TExtraBody>): Promise<void> {
  const stash = isRecord(ctx.message.raw) ? ctx.message.raw[EMAIL_RAW_KEY] : undefined;
  if (!isRecord(stash) || typeof stash.file !== "string" || typeof stash.originalText !== "string") return;
  try {
    const session = await ctx.harness.sessions.getOrCreate({
      id: ctx.session,
      ...(ctx.extraBody === undefined ? {} : { extraBody: ctx.extraBody }),
    });
    await session.files.writeText(stash.file, renderSavedEmail(readInboundEmail(ctx.message), stash.originalText));
  } catch (error) {
    console.warn("little-harness: could not save the original email to the session", error);
  }
}

/**
 * Give an agent its own email address. Drop the result into an agent folder as
 * `connectors/email/connector.ts`; it is an ordinary Chat SDK connector, so discovery, the loaders,
 * connector tools, `toolPolicy` and mirror delivery all work unchanged.
 *
 * ```ts
 * // agents/support/connectors/email/connector.ts
 * import { createResendAdapter } from "@resend/chat-sdk-adapter";
 * import { createRedisState } from "@chat-adapter/state-redis";
 * import { emailConnector } from "@little-stack/harness/connectors/runtime";
 *
 * export default emailConnector({
 *   address: "support@agents.example.com",
 *   adapter: {
 *     name: "resend",
 *     create: () => createResendAdapter({ fromAddress: "support@agents.example.com" }),
 *   },
 *   state: () => createRedisState(),
 *   // authServId: the id your receiving server writes in Authentication-Results (see EmailSenderPolicy).
 *   senders: { allow: ["@example.com"], authServId: "mx.your-receiver.example" },
 * });
 * ```
 *
 * Every email setting that differs from chat is already made: a new email and every reply in its
 * thread trigger the agent, there are no reactions or typing indicators, each email thread is one
 * session whose id carries no address, thread history is kept in Chat SDK state with quoted text
 * removed, and webhook retries are deduplicated for three days. Before the Chat SDK sees an email,
 * the connector refuses auto-replies, bounces and list mail, mail not addressed to `address`,
 * a `From` that is not exactly one address, senders outside `senders` (and, by default, mail that
 * does not pass DMARC per the `senders.authServId` server), replies from someone other than
 * the person who started the thread, and threads over `maxRepliesPerThread`. Refused mail gets no reply and is reported to `onSkip`.
 *
 * `state` must be durable (Redis, Postgres) outside local development: thread mapping, history,
 * dedupe and reply counts live there, so in-memory state turns every reply into a new conversation
 * after a restart.
 */
export function emailConnector<TExtraBody = unknown>(
  options: EmailConnectorOptions<TExtraBody>,
): ChatSdkConnectorDescriptor<TExtraBody> {
  const {
    address: _address,
    senders: _senders,
    userName,
    accept: _accept,
    transform: _transform,
    maxRepliesPerThread: _maxReplies,
    requireAddressedTo: _requireAddressedTo,
    readEmail: _readEmail,
    onSkip: _onSkip,
    adapter,
    beforeRun,
    chat,
    ...connectorOptions
  } = options;
  const policy = createEmailPolicy(options);
  const { attachments } = connectorOptions;
  const maxBytes = (attachments === false ? undefined : attachments?.maxBytes) ?? DEFAULT_ATTACHMENT_MAX_BYTES;
  const descriptor = chatSdkConnector<TExtraBody>({
    session: ({ thread }) => `email:${sha256Hex(thread.id).slice(0, 16)}`,
    history: emailThreadHistory<TExtraBody>(DEFAULT_HISTORY_LIMIT),
    ...connectorOptions,
    userName: userName ?? policy.address.split("@")[0] ?? policy.address,
    adapter: {
      name: adapter.name,
      create: async () => withEmailPolicy((await adapter.create()) as EmailProviderAdapter, policy, maxBytes),
    },
    // A first email arrives as a mention; every reply in its thread arrives as a subscribed message.
    triggers: { directMessage: false, mention: { subscribe: true }, subscribedMessage: true },
    reactions: false,
    beforeRun: async (ctx) => {
      if (ctx.harness.config.runtime?.bash !== false) {
        warnOnce(
          "email-bash",
          `the email connector for ${policy.address} runs an agent with the bash tool enabled. Anyone allowed to ` +
            "email it can ask for shell commands; set `runtime: { bash: false }` in agent.ts unless it needs them.",
        );
      }
      await saveOriginalEmail(ctx);
      await beforeRun?.(ctx);
    },
    chat: {
      dedupeTtlMs: DEDUPE_TTL_MS,
      // Queue a second email that arrives mid-run instead of dropping it.
      concurrency: { strategy: "queue", maxQueueSize: 20, queueEntryTtlMs: QUEUE_ENTRY_TTL_MS },
      history: { thread: { maxMessages: 100, ttlMs: THREAD_STATE_TTL_MS } },
      ...chat,
    },
  });
  // Traces show an email turn by its sender and subject, under `email` whatever the provider.
  return Object.assign(descriptor, { [CHAT_TURN_TRIGGER]: emailTurnTrigger(options.readEmail ?? readInboundEmail) });
}

function emailTurnTrigger(readEmail: (message: ChatSdkMessage) => InboundEmail): ChatTurnTrigger {
  return (message) => {
    const email = readEmail(message);
    const subject = email.subject.trim();
    return {
      kind: "message",
      source: "email",
      ...(email.from === "" ? {} : { from: email.from }),
      ...(subject === "" ? {} : { label: subject }),
    };
  };
}
