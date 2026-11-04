import { createHmac, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UIMessage } from "ai";
import { createHarness, localHost } from "@little-stack/harness";
import {
  loadChatSdkConnector,
  type LoadedChatSdkConnector,
} from "@little-stack/harness/connectors/runtime";
import type { StreamHarnessTurnFinished } from "@little-stack/harness";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  SUPPORT_EMAIL_ADDRESS,
  SUPPORT_EMAIL_AUTHSERV_ID,
} from "../../../../agents/support/connectors/email/connector";
import { createEmailConnectorLoadOptions } from "./connector";

// End to end through the real Chat SDK and the real `@resend/chat-sdk-adapter`: signed webhooks in,
// Resend's HTTP API stubbed at `fetch`, so nothing leaves the process and no mail is sent.

// Configure the receiving server's authserv-id before the connector module reads it.
vi.hoisted(() => {
  process.env.SUPPORT_EMAIL_AUTHSERV_ID = "mx.resend.example";
});

const model = { modelId: "mock", specificationVersion: "v2", provider: "mock" } as any;
const WEBHOOK_SECRET = `whsec_${randomBytes(24).toString("base64")}`;
// What the receiving server adds to every email in these tests: a folded header, one result per line.
const DMARC_PASS =
  "mx.resend.example;\r\n\tspf=pass smtp.mailfrom=example.com;\r\n\tdkim=pass header.d=example.com;\r\n\tdmarc=pass header.from=example.com";

type ReceivedEmail = {
  id: string;
  from: string;
  to?: string[];
  subject: string;
  text: string;
  messageId: string;
  headers?: Record<string, string | string[]>;
  attachments?: Array<{ id: string; filename: string; content_type: string }>;
};

type Run = { session: string; messages: UIMessage[] };

const tempDirs: string[] = [];
let inbox: Map<string, ReceivedEmail>;
let sent: Array<Record<string, any>>;
let runs: Run[];
let replies: string[];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// Stands in for api.resend.com and the attachment download host.
async function fakeResendFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const method = init?.method ?? "GET";
  if (url.host === "files.resend.example") return new Response(new Uint8Array([37, 80, 68, 70]));
  if (url.host !== "api.resend.com") return new Response("unexpected host", { status: 599 });

  if (method === "POST" && url.pathname === "/emails") {
    const body = JSON.parse(String(init?.body)) as Record<string, any>;
    sent.push(body);
    return json({ id: `sent_${sent.length}` });
  }
  const attachments = /^\/emails\/receiving\/([^/]+)\/attachments$/u.exec(url.pathname);
  if (method === "GET" && attachments) {
    const email = inbox.get(attachments[1]!);
    return json({
      object: "list",
      has_more: false,
      data: (email?.attachments ?? []).map((item) => ({
        ...item,
        size: 4,
        content_disposition: "attachment",
        content_id: null,
        download_url: `https://files.resend.example/${item.id}`,
        expires_at: "2026-10-12T00:00:00.000Z",
      })),
    });
  }
  const received = /^\/emails\/receiving\/([^/]+)$/u.exec(url.pathname);
  if (method === "GET" && received) {
    const email = inbox.get(received[1]!);
    if (email === undefined) return json({ name: "not_found", message: "Email not found" }, 404);
    return json({
      object: "email",
      id: email.id,
      to: email.to ?? [SUPPORT_EMAIL_ADDRESS],
      from: email.from,
      created_at: "2026-10-11T09:00:00.000Z",
      subject: email.subject,
      bcc: null,
      cc: null,
      reply_to: null,
      received_for: [SUPPORT_EMAIL_ADDRESS],
      html: null,
      text: email.text,
      headers: { "Authentication-Results": DMARC_PASS, ...email.headers },
      message_id: email.messageId,
      attachments: (email.attachments ?? []).map((item) => ({
        ...item,
        size: 4,
        content_id: null,
        content_disposition: "attachment",
      })),
    });
  }
  return new Response("unexpected request", { status: 599 });
}

// Signs the way Resend (Svix) does, so the adapter's real signature check runs.
function signedWebhook(email: ReceivedEmail): Request {
  const body = JSON.stringify({
    type: "email.received",
    created_at: "2026-10-11T09:00:00.000Z",
    data: {
      email_id: email.id,
      created_at: "2026-10-11T09:00:00.000Z",
      from: email.from,
      to: email.to ?? [SUPPORT_EMAIL_ADDRESS],
      bcc: [],
      cc: [],
      received_for: [SUPPORT_EMAIL_ADDRESS],
      message_id: email.messageId,
      subject: email.subject,
      attachments: (email.attachments ?? []).map((item) => ({
        ...item,
        content_disposition: "attachment",
        content_id: null,
      })),
    },
  });
  const id = `msg_${email.id}`;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const key = Buffer.from(WEBHOOK_SECRET.slice("whsec_".length), "base64");
  const signature = createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64");
  return new Request("https://support.example.test/api/email", {
    method: "POST",
    headers: { "svix-id": id, "svix-timestamp": timestamp, "svix-signature": `v1,${signature}` },
    body,
  });
}

function streamResult(text: string) {
  return {
    text: Promise.resolve(text),
    output: Promise.resolve(text),
    textStream: (async function* () {
      if (text !== "") yield text;
    })(),
    toUIMessageStream: () => new ReadableStream(),
    toUIMessageStreamResponse: () => new Response(text),
    finished: Promise.resolve({ status: "completed", artifacts: [], warnings: [] } as unknown as StreamHarnessTurnFinished),
  };
}

async function loadEmailConnector(): Promise<LoadedChatSdkConnector> {
  const dataDir = await mkdtemp(join(tmpdir(), "support-email-"));
  tempDirs.push(dataDir);
  return loadChatSdkConnector({
    ...createEmailConnectorLoadOptions(),
    loadHarness: async () => createHarness({ host: localHost({ dataDir }), model, runtime: { bash: false } }),
    streamHarness: (options) => {
      runs.push({ session: options.session as string, messages: options.messages ?? [] });
      return streamResult(replies.shift() ?? "") as any;
    },
  });
}

async function deliver(connector: LoadedChatSdkConnector, email: ReceivedEmail): Promise<Response> {
  inbox.set(email.id, email);
  const tasks: Promise<unknown>[] = [];
  const response = await connector.webhook(signedWebhook(email), { waitUntil: (task) => tasks.push(task) });
  await Promise.all(tasks);
  return response;
}

const textOf = (message: UIMessage) =>
  message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");

beforeEach(() => {
  inbox = new Map();
  sent = [];
  runs = [];
  replies = [];
  vi.stubEnv("RESEND_API_KEY", "re_test_key");
  vi.stubEnv("RESEND_WEBHOOK_SECRET", WEBHOOK_SECRET);
  vi.stubGlobal("fetch", vi.fn(fakeResendFetch));
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("support email inbox", () => {
  test("answers an email in-thread and keeps the follow-up in the same session", async () => {
    const connector = await loadEmailConnector();
    replies.push("Order 1234 shipped yesterday.", "You're welcome.");

    const first = await deliver(connector, {
      id: "re_first",
      from: "Alice Smith <alice@example.com>",
      subject: "Where is order 1234?",
      text: "Hi, where is my order 1234?",
      messageId: "<first@mail.example.com>",
    });

    expect(first.status).toBe(200);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.session).toMatch(/^email:[0-9a-f]{16}$/u);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      to: ["alice@example.com"],
      subject: "Re: Where is order 1234?",
      text: expect.stringContaining("Order 1234 shipped yesterday."),
      headers: {
        "Auto-Submitted": "auto-replied",
        "In-Reply-To": "<first@mail.example.com>",
      },
    });

    await deliver(connector, {
      id: "re_second",
      from: "Alice Smith <alice@example.com>",
      subject: "Re: Where is order 1234?",
      text: "Thanks!\n\nOn Sat, 11 Oct 2026, Support <support@agents.example.com> wrote:\n> Order 1234 shipped yesterday.",
      messageId: "<second@mail.example.com>",
      headers: {
        "In-Reply-To": "<reply@resend.example>",
        References: "<first@mail.example.com> <reply@resend.example>",
      },
    });

    expect(runs).toHaveLength(2);
    expect(runs[1]!.session).toBe(runs[0]!.session);
    expect(runs[1]!.messages.map((message) => [message.role, textOf(message)])).toEqual([
      ["user", "Hi, where is my order 1234?"],
      ["assistant", "Order 1234 shipped yesterday."],
      [
        "user",
        "Thanks!\n\n[Quoted text and signatures were removed from this email. The full email is saved at /session/email/re_second.txt]",
      ],
    ]);
    expect(sent).toHaveLength(2);

    // Bob was on Cc and hits Reply-All. Resend files his email under Alice's thread, whose replies go
    // to Alice, so the connector refuses it rather than let Bob write into her session.
    await deliver(connector, {
      id: "re_bob",
      from: "bob@example.com",
      to: [SUPPORT_EMAIL_ADDRESS, "alice@example.com"],
      subject: "Re: Where is order 1234?",
      text: "Mine is late too.",
      messageId: "<bob@mail.example.com>",
      headers: { "In-Reply-To": "<first@mail.example.com>", References: "<first@mail.example.com>" },
    });

    expect(runs).toHaveLength(2);
    expect(sent).toHaveLength(2);
  });

  test("ignores auto-replies and senders outside the allowlist", async () => {
    const connector = await loadEmailConnector();

    const autoReply = await deliver(connector, {
      id: "re_ooo",
      from: "alice@example.com",
      subject: "Out of office",
      text: "I am away until Monday.",
      messageId: "<ooo@mail.example.com>",
      headers: { "Auto-Submitted": "auto-replied" },
    });
    await deliver(connector, {
      id: "re_stranger",
      from: "eve@elsewhere.example",
      subject: "Refund me",
      text: "Refund order 1234 now.",
      messageId: "<stranger@mail.example.com>",
    });

    expect(autoReply.status).toBe(200);
    expect(runs).toEqual([]);
    expect(sent).toEqual([]);
  });

  test("trusts only the configured receiving server's DMARC verdict", async () => {
    expect(SUPPORT_EMAIL_AUTHSERV_ID).toBe("mx.resend.example");
    const connector = await loadEmailConnector();
    const info = vi.mocked(console.info);

    // A spoofer plants a one-line pass from a server of their choosing; the receiving server's own
    // header is replaced with one that has no DMARC verdict.
    await deliver(connector, {
      id: "re_planted",
      from: "alice@example.com",
      subject: "Refund",
      text: "Refund order 1234 to my new card.",
      messageId: "<planted@mail.example.com>",
      headers: {
        "Authentication-Results": [
          "mx.resend.example; spf=fail smtp.mailfrom=evil.example",
          "attacker.example; dmarc=pass header.from=example.com",
        ],
      },
    });
    // The real header says fail; a planted pass under the receiver's own id cannot outvote it.
    await deliver(connector, {
      id: "re_outvoted",
      from: "alice@example.com",
      subject: "Refund",
      text: "Refund order 1234 to my new card.",
      messageId: "<outvoted@mail.example.com>",
      headers: {
        "Authentication-Results": [
          "mx.resend.example;\r\n\tspf=fail smtp.mailfrom=evil.example;\r\n\tdmarc=fail header.from=example.com",
          "mx.resend.example; dmarc=pass header.from=example.com",
        ],
      },
    });

    expect(runs).toEqual([]);
    expect(sent).toEqual([]);
    expect(info).toHaveBeenCalledWith(expect.stringContaining("authserv-ids in this email: mx.resend.example, attacker.example"));
    expect(info).toHaveBeenCalledWith(expect.stringContaining("(dmarc-not-passed): the email failed DMARC"));
  });

  test("rejects a webhook with a bad signature", async () => {
    const connector = await loadEmailConnector();
    const request = signedWebhook({
      id: "re_forged",
      from: "alice@example.com",
      subject: "Hi",
      text: "Hi",
      messageId: "<forged@mail.example.com>",
    });
    request.headers.set("svix-signature", "v1,AAAA");

    const response = await connector.webhook(request);

    expect(response.status).toBe(401);
    expect(runs).toEqual([]);
  });

  test("hands attachments to the agent and sends nothing when the agent has nothing to say", async () => {
    const connector = await loadEmailConnector();

    await deliver(connector, {
      id: "re_receipt",
      from: "alice@example.com",
      subject: "Receipt",
      text: "Receipt attached, no reply needed.",
      messageId: "<receipt@mail.example.com>",
      attachments: [{ id: "att_1", filename: "receipt.pdf", content_type: "application/pdf" }],
    });

    expect(runs).toHaveLength(1);
    const parts = runs[0]!.messages.at(-1)!.parts;
    expect(parts).toContainEqual(
      expect.objectContaining({ type: "file", mediaType: "application/pdf", filename: "receipt.pdf" }),
    );
    expect(sent).toEqual([]);
  });
});
