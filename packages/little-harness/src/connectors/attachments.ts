import type {
  ChatSdkAttachment,
  ChatSdkAttachmentOptions,
  ChatSdkAttachmentSkip,
  ChatSdkMessage,
} from "./descriptors.js";

/**
 * Largest single attachment inlined into a turn by default: 10 MiB. A chat platform will happily
 * accept a 500 MB video; inlining one would blow the request body, the provider's file limit, and
 * the bill, so the default caps what crosses into a model turn and leaves the rest as a note.
 */
export const DEFAULT_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

/** Media type used when the platform reported none — the safest generic binary type. */
const DEFAULT_MEDIA_TYPE = "application/octet-stream";

/**
 * A UIMessage `file` part carrying BOTH representations the harness reads downstream:
 *
 * - `url` — a base64 `data:` URL. This is the field `convertToModelMessages` forwards to the
 *   provider (AI SDK v6 `FileUIPart` has no `data` field), so it is what puts the file in the
 *   model's context.
 * - `data` — the raw bytes. This is the field `extractInputFiles` (message staging) reads; a part
 *   with only a `url` is skipped by staging, so the bytes are carried alongside rather than
 *   base64-decoded again by every `stageMessage` hook.
 *
 * Both are populated from one fetch. The duplication costs ~2.4x the file's size in memory for the
 * lifetime of the turn's message array, which is what the `maxBytes` cap bounds.
 */
export type ChatSdkFileUIPart = {
  readonly type: "file";
  readonly mediaType: string;
  readonly filename: string;
  readonly url: string;
  readonly data: Uint8Array;
};

/**
 * The inbound message's attachments after fetching: the `file` parts to attach, plus model-visible
 * notes standing in for every attachment that could not be inlined.
 */
export type ResolvedInboundAttachments = {
  readonly fileParts: readonly ChatSdkFileUIPart[];
  readonly notes: readonly string[];
};

/** The empty result — no attachments, or attachment handling turned off. */
export const NO_INBOUND_ATTACHMENTS: ResolvedInboundAttachments = { fileParts: [], notes: [] };

export type ResolveInboundAttachmentsOptions = {
  message: ChatSdkMessage;
  adapterName: string;
  /** The descriptor's `attachments` setting. `false` disables inlining entirely. */
  attachments?: false | ChatSdkAttachmentOptions;
};

/** True when nothing needs to be applied to the inbound message. */
export function isEmptyInboundAttachments(resolved: ResolvedInboundAttachments): boolean {
  return resolved.fileParts.length === 0 && resolved.notes.length === 0;
}

/**
 * Fetch the inbound message's attachments and turn them into UIMessage `file` parts.
 *
 * NEVER throws and never rejects. A file the platform will not hand over is a degraded turn, not a
 * failed one: the user still asked a question, and the agent should answer it while being told which
 * file is missing. Every skip therefore produces a note (appended to the message text by the caller)
 * and an optional `onSkipped` observation, and the turn continues.
 */
export async function resolveInboundAttachments(
  options: ResolveInboundAttachmentsOptions,
): Promise<ResolvedInboundAttachments> {
  const config = options.attachments;
  if (config === false) return NO_INBOUND_ATTACHMENTS;

  const attachments = options.message.attachments;
  if (attachments === undefined || attachments.length === 0) return NO_INBOUND_ATTACHMENTS;

  const maxBytes = config?.maxBytes ?? DEFAULT_ATTACHMENT_MAX_BYTES;
  const fileParts: ChatSdkFileUIPart[] = [];
  const notes: string[] = [];

  const skip = async (
    attachment: ChatSdkAttachment,
    note: string,
    detail: Pick<ChatSdkAttachmentSkip, "reason"> & Partial<ChatSdkAttachmentSkip>,
  ): Promise<void> => {
    notes.push(note);
    try {
      await config?.onSkipped?.({
        ...detail,
        attachment,
        message: options.message,
        adapterName: options.adapterName,
        note,
      });
    } catch {
      /* Skip observers must not fail the turn the skip already degraded. */
    }
  };

  for (const [index, attachment] of attachments.entries()) {
    const name = attachmentName(attachment, index);

    // Pre-fetch cap: when the platform reports a size, an oversized file never crosses the network.
    if (typeof attachment.size === "number" && attachment.size > maxBytes) {
      await skip(attachment, oversizeNote(name, attachment.size, maxBytes), {
        reason: "oversize",
        bytes: attachment.size,
      });
      continue;
    }

    let bytes: Uint8Array | undefined;
    try {
      bytes = await attachmentBytes(attachment);
    } catch (error) {
      // The note deliberately omits the error text: a `fetchData` failure on Slack can carry a
      // signed URL or token in its message, and this string goes into the model's context.
      await skip(attachment, `[attachment "${name}" could not be fetched]`, {
        reason: "fetch-failed",
        error,
      });
      continue;
    }

    if (bytes === undefined) {
      await skip(
        attachment,
        `[attachment "${name}" was not attached: the platform provided no file data]`,
        { reason: "no-data" },
      );
      continue;
    }

    // Post-fetch cap: platforms that report no `size` (or report it wrong) are still bounded.
    if (bytes.byteLength > maxBytes) {
      await skip(attachment, oversizeNote(name, bytes.byteLength, maxBytes), {
        reason: "oversize",
        bytes: bytes.byteLength,
      });
      continue;
    }

    const mediaType = normalizeMediaType(attachment.mimeType);
    fileParts.push({
      type: "file",
      mediaType,
      filename: name,
      url: `data:${mediaType};base64,${Buffer.from(bytes).toString("base64")}`,
      data: bytes,
    });
  }

  return { fileParts, notes };
}

/** The filename used for the part and for every note about it. */
function attachmentName(attachment: ChatSdkAttachment, index: number): string {
  const name = attachment.name?.trim();
  return name !== undefined && name.length > 0 ? name : `attachment-${index + 1}`;
}

function normalizeMediaType(mimeType: string | undefined): string {
  const trimmed = mimeType?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : DEFAULT_MEDIA_TYPE;
}

function oversizeNote(name: string, bytes: number, maxBytes: number): string {
  return `[attachment "${name}" was not attached: ${formatBytes(bytes)} exceeds the ${formatBytes(maxBytes)} limit]`;
}

/**
 * Read an attachment's bytes: `data` when the adapter already holds them, else `fetchData()`.
 * `undefined` means "no bytes available" — including an attachment that carries only a `url`, which
 * the connector deliberately does not fetch itself (a Slack file URL is private, and `fetchData` is
 * the only path that authenticates).
 */
async function attachmentBytes(attachment: ChatSdkAttachment): Promise<Uint8Array | undefined> {
  if (attachment.data !== undefined) return toBytes(attachment.data);
  if (typeof attachment.fetchData === "function") return toBytes(await attachment.fetchData());
  return undefined;
}

async function toBytes(value: unknown): Promise<Uint8Array | undefined> {
  // A Node `Buffer` is a `Uint8Array`, so this covers both.
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (typeof (value as Blob | undefined)?.arrayBuffer === "function") {
    return new Uint8Array(await (value as Blob).arrayBuffer());
  }
  return undefined;
}

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = value >= 10 || Number.isInteger(value) ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unit]}`;
}
