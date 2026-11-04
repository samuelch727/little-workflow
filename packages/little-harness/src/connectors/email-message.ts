import type { ChatSdkMessage } from "./descriptors.js";

/**
 * One inbound email, normalized from a Chat SDK email adapter's message. This is what the email
 * connector's sender policy, `accept` and `transform` hooks see.
 *
 * Addresses are bare and lower-cased (`alice@example.com`, never `Alice <Alice@Example.com>`), and
 * header names are lower-cased, so policy code never has to normalize either.
 */
export type InboundEmail = {
  /** The provider's id for this email. It is also the Chat SDK message id. */
  readonly id: string;
  /** The RFC 5322 `Message-ID` header, when the provider reports one. */
  readonly messageId?: string;
  /**
   * The sender's address, from the `From` header. Empty when that header does not hold exactly one
   * address (a list such as `a@x.com, b@y.com`, or a malformed value); the connector refuses such mail.
   */
  readonly from: string;
  /** The sender's display name, when the `From` header carried one. */
  readonly fromName?: string;
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly subject: string;
  /** The plain-text body as received, before any quote stripping. */
  readonly text: string;
  readonly html?: string;
  /**
   * Every header the provider reported, keyed by lower-cased name, with folded lines joined. A header
   * that appears more than once has its values joined with a newline here; read them one by one from
   * `headerValues`.
   */
  readonly headers: Readonly<Record<string, string>>;
  /** Every value of every header, keyed by lower-cased name, in the order the provider reported them. */
  readonly headerValues: Readonly<Record<string, readonly string[]>>;
  readonly attachments: ReadonlyArray<{ readonly name?: string; readonly mimeType?: string }>;
};

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * The bare, lower-cased address in a mailbox string: `"Alice" <Alice@Example.com>` becomes
 * `alice@example.com`, and a bare address is trimmed and lower-cased.
 */
export function parseEmailAddress(value: string): string {
  const trimmed = value.trim();
  const bracketed = /<([^<>]+)>\s*$/u.exec(trimmed);
  return (bracketed?.[1] ?? trimmed).trim().toLowerCase();
}

const ADDR_SPEC = /^[^\s<>()",;:@\\[\]]+@[^\s<>()",;:@\\[\]]+$/u;

/**
 * Blank out RFC 5322 quoted strings (each becomes `""`) and comments (each becomes a space), so that
 * their contents cannot pass for structure: a display name such as `"Smith, Alice"` or
 * `"<eve@evil.com>"`, or an `Authentication-Results` comment holding a `;`. Returns `undefined` for
 * an unterminated quote or comment.
 */
function maskQuotesAndComments(value: string): string | undefined {
  let out = "";
  let quoted = false;
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if ((quoted || depth > 0) && char === "\\") {
      index += 1;
    } else if (quoted) {
      if (char === '"') {
        quoted = false;
        out += '""';
      }
    } else if (char === "(") {
      depth += 1;
    } else if (depth > 0) {
      if (char === ")") {
        depth -= 1;
        if (depth === 0) out += " ";
      }
    } else if (char === '"') {
      quoted = true;
    } else {
      out += char;
    }
  }
  return quoted || depth > 0 ? undefined : out;
}

/**
 * The bare, lower-cased address of a `From` value that holds exactly one mailbox
 * (`Alice <alice@example.com>`, `"Smith, Alice" <alice@example.com>`, or `alice@example.com`), or
 * `undefined` for anything else: an address list, a group, an `@` outside the quotes and angle
 * brackets, or a malformed value. A sender policy must vet the one address replies go to, so an
 * ambiguous `From` is refused rather than guessed at.
 */
function singleMailbox(value: string): string | undefined {
  const masked = maskQuotesAndComments(value)?.trim();
  if (masked === undefined) return undefined;
  const open = masked.indexOf("<");
  if (open === -1) return ADDR_SPEC.test(masked) ? masked.toLowerCase() : undefined;
  const close = masked.indexOf(">");
  if (close !== masked.length - 1 || masked.lastIndexOf("<") !== open || masked.slice(0, open).includes("@")) {
    return undefined;
  }
  const address = masked.slice(open + 1, close).trim();
  return ADDR_SPEC.test(address) ? address.toLowerCase() : undefined;
}

function displayName(value: string): string | undefined {
  const match = /^\s*"?([^"<]*?)"?\s*<[^<>]+>\s*$/u.exec(value);
  const name = match?.[1]?.trim();
  return name === undefined || name.length === 0 ? undefined : name;
}

function addressList(value: unknown): string[] {
  const items = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  return items
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map(parseEmailAddress);
}

/** Join folded header lines (RFC 5322 section 2.2.3): a line break followed by a space or tab. */
function unfold(value: string): string {
  return value.replace(/\r?\n(?=[ \t])/gu, "");
}

function lowerCaseHeaders(value: unknown): Record<string, string[]> {
  const headers: Record<string, string[]> = {};
  const add = (name: string, headerValue: string) => {
    const key = name.toLowerCase();
    (headers[key] ??= []).push(unfold(headerValue));
  };
  if (Array.isArray(value)) {
    // `[{ name, value }]`, the other common shape for parsed headers.
    for (const entry of value) {
      if (!isRecord(entry)) continue;
      const name = stringOrUndefined(entry.name ?? entry.key);
      const headerValue = entry.value;
      if (name === undefined || typeof headerValue !== "string") continue;
      add(name, headerValue);
    }
    return headers;
  }
  if (!isRecord(value)) return headers;
  for (const [name, headerValue] of Object.entries(value)) {
    const values = Array.isArray(headerValue) ? headerValue : [headerValue];
    for (const item of values) {
      if (typeof item === "string") add(name, item);
    }
  }
  return headers;
}

/**
 * Read an {@link InboundEmail} from a Chat SDK message. It understands the `raw` shape of Resend's
 * adapter (`@resend/chat-sdk-adapter`: `from`, `to`, `cc`, `subject`, `text`, `html`, `headers`,
 * `messageId`) and the snake_case variants other providers use, and falls back to the message's
 * author and text for anything `raw` does not carry.
 */
export function readInboundEmail(message: ChatSdkMessage): InboundEmail {
  const raw = isRecord(message.raw) ? message.raw : {};
  const headerValues = lowerCaseHeaders(raw.headers);
  const headers = Object.fromEntries(Object.entries(headerValues).map(([name, values]) => [name, values.join("\n")]));
  const fromHeader = stringOrUndefined(raw.from) ?? headers.from;
  const from = singleMailbox(fromHeader ?? message.author.userId) ?? "";
  const fromName = fromHeader === undefined ? undefined : displayName(fromHeader);
  const messageId = stringOrUndefined(raw.messageId) ?? stringOrUndefined(raw.message_id) ?? headers["message-id"];
  const html = stringOrUndefined(raw.html);
  const rawAttachments = Array.isArray(raw.attachments) ? raw.attachments : message.attachments ?? [];
  const attachments = rawAttachments.filter(isRecord).map((item) => {
    const name = stringOrUndefined(item.filename) ?? stringOrUndefined(item.name);
    const mimeType =
      stringOrUndefined(item.contentType) ?? stringOrUndefined(item.content_type) ?? stringOrUndefined(item.mimeType);
    return {
      ...(name === undefined ? {} : { name }),
      ...(mimeType === undefined ? {} : { mimeType }),
    };
  });
  return {
    id: message.id,
    ...(messageId === undefined ? {} : { messageId }),
    from,
    ...(fromName === undefined ? {} : { fromName }),
    to: addressList(raw.to ?? headers.to),
    cc: addressList(raw.cc ?? headers.cc),
    subject: stringOrUndefined(raw.subject) ?? headers.subject ?? "",
    text: message.text,
    ...(html === undefined ? {} : { html }),
    headers,
    headerValues,
    attachments,
  };
}

const AUTOMATED_PRECEDENCE = new Set(["bulk", "list", "junk", "auto_reply"]);
const BOUNCE_SENDERS = new Set(["mailer-daemon", "postmaster"]);

/**
 * Why an email must not get an automatic reply, or `undefined` when it may. Follows RFC 3834: no
 * reply to mail marked `Auto-Submitted` (anything but `no`), to bulk, list or junk `Precedence`, to
 * mailing-list mail (any `List-*` header), or to bounces (a null `Return-Path`, a delivery report, or
 * a `mailer-daemon`/`postmaster` sender). Answering any of these is how reply loops and backscatter
 * start.
 */
export function automatedEmailReason(email: InboundEmail): string | undefined {
  const { headers } = email;
  const autoSubmitted = headers["auto-submitted"]?.split(";")[0]?.trim().toLowerCase();
  if (autoSubmitted !== undefined && autoSubmitted !== "" && autoSubmitted !== "no") {
    return `Auto-Submitted: ${autoSubmitted}`;
  }
  const precedence = headers.precedence?.trim().toLowerCase();
  if (precedence !== undefined && AUTOMATED_PRECEDENCE.has(precedence)) {
    return `Precedence: ${precedence}`;
  }
  const listHeader = Object.keys(headers).find((name) => name.startsWith("list-"));
  if (listHeader !== undefined) return `mailing-list header ${listHeader}`;
  if (headers["x-autoreply"] !== undefined || headers["x-autorespond"] !== undefined) {
    return "auto-responder header";
  }
  if (headers["feedback-type"] !== undefined) return "abuse or feedback report";
  if (headers["return-path"]?.trim() === "<>") return "bounce (null Return-Path)";
  if (/^\s*multipart\/report\b/iu.test(headers["content-type"] ?? "")) return "delivery status report";
  const localPart = email.from.split("@")[0] ?? "";
  if (BOUNCE_SENDERS.has(localPart)) return `bounce (${localPart} sender)`;
  return undefined;
}

/**
 * True when `address` matches the allow list. An entry is either a full address
 * (`alice@example.com`) or a domain written as `@example.com`; a domain entry matches that exact
 * domain only, not its subdomains. Matching ignores case.
 */
export function senderAllowed(address: string, allow: readonly string[]): boolean {
  const normalized = address.trim().toLowerCase();
  const domain = normalized.slice(normalized.lastIndexOf("@"));
  return allow.some((entry) => {
    const rule = entry.trim().toLowerCase();
    return rule.startsWith("@") ? rule === domain : rule === normalized;
  });
}

export type DmarcResult = "pass" | "fail" | "none";

/**
 * The DMARC result that the receiving mail server recorded in the email's `Authentication-Results`
 * headers.
 *
 * Only headers whose authserv-id (their first token) is `authServId` count. A sender can put any
 * `Authentication-Results` header in their own mail, so a header from any other server, or from no
 * server, proves nothing (RFC 8601 section 5). Folded headers are read whole, and each header is
 * read on its own.
 *
 * - `"pass"` when at least one counted verdict is `dmarc=pass` and none says otherwise. A verdict
 *   that names a `header.from` domain must match the sender's domain.
 * - `"fail"` when any counted verdict is not a pass, so a forged pass next to the receiving server's
 *   real failure still fails.
 * - `"none"` when no counted header carries a DMARC verdict, including when `authServId` is blank.
 */
export function dmarcResult(email: InboundEmail, options: { authServId: string }): DmarcResult {
  const wantedServer = options.authServId.trim().toLowerCase();
  if (wantedServer === "") return "none";
  const senderDomain = email.from.slice(email.from.lastIndexOf("@") + 1);
  let passed = false;
  for (const header of readAuthenticationResults(email)) {
    if (header.authServId !== wantedServer) continue;
    // Fail closed on the receiving server's own header: one we cannot parse, or any verdict other
    // than a pass anywhere in it (even inside a comment or quoted string, where sender-controlled
    // text could otherwise hide it), fails.
    const anyVerdicts = [...header.unfolded.matchAll(/(?:^|[\s;(])dmarc\s*=\s*([a-z]+)/giu)];
    if (header.results === undefined || anyVerdicts.some((match) => match[1]?.toLowerCase() !== "pass")) {
      return "fail";
    }
    for (const result of header.results) {
      const verdict = /^dmarc\s*=\s*([a-z]+)/iu.exec(result)?.[1]?.toLowerCase();
      if (verdict === undefined) continue;
      const headerFrom = /\bheader\.from\s*=\s*(\S+)/iu.exec(result)?.[1]?.toLowerCase();
      if (verdict !== "pass" || (headerFrom !== undefined && headerFrom !== senderDomain)) return "fail";
      passed = true;
    }
  }
  return passed ? "pass" : "none";
}

/**
 * The email's `Authentication-Results` headers, one entry per header: its authserv-id (the first
 * token, lower-cased; a version number may follow it) and its results (`spf=pass ...`,
 * `dmarc=pass header.from=example.com`), unfolded and with comments and quoted strings blanked out.
 * A header with an unterminated comment or quoted string has no results. Log the `authServId`s of a
 * test email from `onSkip` to find your receiving server's id.
 */
export function authenticationResults(email: InboundEmail): Array<{ authServId: string; results: string[] }> {
  return readAuthenticationResults(email).map((header) => ({ authServId: header.authServId, results: header.results ?? [] }));
}

function readAuthenticationResults(email: InboundEmail) {
  // `?.` because a custom `readEmail` written in JavaScript may leave `headerValues` out.
  const values = email.headerValues?.["authentication-results"] ?? [];
  return values.map((value) => {
    const unfolded = unfold(value);
    const masked = maskQuotesAndComments(unfolded);
    const [id = "", ...results] = (masked ?? unfolded).split(";");
    return {
      authServId: id.trim().split(/[\s(]/u)[0]?.toLowerCase() ?? "",
      results: masked === undefined ? undefined : results.map((result) => result.trim()).filter((result) => result !== ""),
      unfolded,
    };
  });
}

export type StrippedReply = {
  /** The new part of the message: what the sender wrote this time. */
  text: string;
  /** What was removed: the quoted earlier messages and the signature. Empty when nothing was. */
  removed: string;
};

const REPLY_HEADER_PATTERNS = [
  /^\s*-{2,}\s*Original Message\s*-{2,}\s*$/iu,
  /^\s*On\b.{0,300}\bwrote:\s*$/iu,
  /^\s*Le\b.{0,300}\ba écrit\s*:\s*$/iu,
  /^\s*Am\b.{0,300}\bschrieb\b.{0,200}:\s*$/iu,
  /^\s*El\b.{0,300}\bescribió:\s*$/iu,
];
const HEADER_BLOCK_START = /^\s*\*?(From|De|Von)\s*:\*?\s*\S/iu;
const HEADER_BLOCK_FIELD = /^\s*\*?(Sent|Date|To|Subject|Envoyé|Gesendet|Enviado)\s*:/iu;
const FORWARD_MARKER = /forwarded message|begin forwarded message/iu;
const FORWARD_SUBJECT = /^\s*(fwd?|fw)\s*:/iu;
const MOBILE_FOOTER = /^\s*(Sent from my \S.*|Sent from (Outlook|Mail|Yahoo Mail) for \S.*|Get Outlook for \S.*)$/iu;
const SEPARATOR_LINE = /^\s*[_-]{5,}\s*$/u;

function isReplyHeader(lines: readonly string[], index: number): boolean {
  const line = lines[index] ?? "";
  if (REPLY_HEADER_PATTERNS.some((pattern) => pattern.test(line))) return true;
  // Gmail wraps a long attribution over two lines: "On Mon, 6 Oct 2026 at 10:00, Alice <a@x.com>"
  // then "wrote:".
  const next = lines[index + 1];
  if (/^\s*On\b/iu.test(line) && next !== undefined && /(^|\s)wrote:\s*$/iu.test(next)) {
    return `${line} ${next}`.length <= 400;
  }
  if (HEADER_BLOCK_START.test(line)) {
    // An Outlook-style "From: / Sent: / To:" block, unless it introduces a forwarded message.
    const before = lines.slice(Math.max(0, index - 2), index).join("\n");
    if (FORWARD_MARKER.test(before)) return false;
    return lines.slice(index + 1, index + 5).some((field) => HEADER_BLOCK_FIELD.test(field));
  }
  return false;
}

function trailingQuoteStart(lines: readonly string[]): number | undefined {
  let start: number | undefined;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? "";
    if (line.trim() === "") continue;
    if (!line.trimStart().startsWith(">")) break;
    start = index;
  }
  return start;
}

/**
 * Remove the quoted earlier messages and the signature from a plain-text reply, so an agent reads
 * only what the sender wrote this time. The earlier messages are already in the conversation
 * history, so re-reading the whole quoted chain on every turn only costs tokens and widens the
 * surface for injected instructions.
 *
 * It cuts at the first reply attribution ("On … wrote:", "-----Original Message-----", an Outlook
 * "From:/Sent:" block, and their French, German and Spanish forms), at a trailing block of `>`
 * lines, at an RFC 3676 `-- ` signature separator, and drops a trailing "Sent from my iPhone"-style
 * footer. Inline replies between quoted lines are kept. A forward (a `Fwd:`/`FW:` subject, or a
 * "Forwarded message" marker) is left alone, because the forwarded mail is the content. When
 * stripping would leave nothing, the original text is returned unchanged.
 */
export function stripQuotedReply(text: string, options: { subject?: string } = {}): StrippedReply {
  if (options.subject !== undefined && FORWARD_SUBJECT.test(options.subject)) {
    return { text, removed: "" };
  }
  const lines = text.split(/\r?\n/u);
  let cut = lines.length;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line === "-- " || line.trimEnd() === "--" || isReplyHeader(lines, index)) {
      cut = index;
      break;
    }
  }
  const quoteStart = trailingQuoteStart(lines.slice(0, cut));
  if (quoteStart !== undefined) cut = quoteStart;

  const kept = lines.slice(0, cut);
  const isTrailingNoise = (line: string) => line.trim() === "" || MOBILE_FOOTER.test(line) || SEPARATOR_LINE.test(line);
  while (kept.length > 0 && isTrailingNoise(kept.at(-1) ?? "")) {
    kept.pop();
  }
  const keptText = kept.join("\n").trim();
  if (keptText.length === 0) return { text, removed: "" };
  const removed = lines.slice(kept.length).join("\n").trim();
  return { text: keptText, removed };
}
