import type { UIMessage } from "ai";
import { sanitizeTraceValue } from "../trace/redaction.js";
import type { ResolvedHarnessTraceOptions } from "../trace/types.js";
import type {
  FileContent,
  FileWriter,
  HarnessChatOptions,
  HarnessEvent,
  HarnessSession,
  InputFile,
} from "../types.js";

export type StageChatMessagesOptions<TExtraBody = unknown> = {
  messages: UIMessage[];
  session: HarnessSession;
  files: FileWriter;
  chat?: HarnessChatOptions<TExtraBody>;
  extraBody?: TExtraBody | undefined;
  abortSignal?: AbortSignal | undefined;
  restage?: boolean;
  emit?: (event: Omit<HarnessEvent, "timestamp" | "sessionId">) => Promise<void>;
  traceOptions?: ResolvedHarnessTraceOptions;
};

export type StageChatMessagesResult = {
  notices: string[];
  stagedMessageIds: string[];
  stripStagedFileParts: boolean;
};

export async function stageChatMessages<TExtraBody>(
  options: StageChatMessagesOptions<TExtraBody>,
): Promise<StageChatMessagesResult> {
  if (!options.chat?.stageMessage) {
    return { notices: [], stagedMessageIds: [], stripStagedFileParts: false };
  }

  const status = await options.session.status();
  const alreadyStaged = new Set(options.restage ? [] : status.stagedMessageIds);
  const notices: string[] = [];
  const stagedMessageIds: string[] = [];
  let stripStagedFileParts = false;

  for (const message of options.messages) {
    if (message.role !== "user") {
      continue;
    }

    const id = message.id ?? stableMessageId(message);
    if (!hasFileParts(message)) {
      continue;
    }

    if (alreadyStaged.has(id)) {
      stripStagedFileParts = true;
      continue;
    }

    const inputFiles = extractInputFiles(message);
    if (inputFiles.length === 0) {
      continue;
    }

    const result = await options.chat.stageMessage({
      message,
      inputFiles,
      files: options.files,
      session: options.session,
      extraBody: options.extraBody,
      abortSignal: options.abortSignal,
    });

    if (result.notice) {
      notices.push(result.notice);
    }
    if (result.notice || (result.stagedFiles?.length ?? 0) > 0) {
      stripStagedFileParts = true;
    }

    for (const file of result.stagedFiles ?? []) {
      const resultMetadata = options.traceOptions
        ? sanitizeTraceValue(result.metadata, options.traceOptions).value
        : result.metadata;
      await options.emit?.({
        type: "harness.file.staged_from_message",
        metadata: {
          ...(isRecord(resultMetadata) ? resultMetadata : {}),
          messageId: id,
          path: file.path,
          root: rootFromPath(file.path),
          source: "user-message",
          originalName: file.originalName,
          mediaType: file.mediaType,
          bytes: file.bytes,
          ...(file.sha256 ? { sha256: file.sha256 } : {}),
          after: fileMetadata(file),
        },
      });
    }

    await markMessageStaged(options.session, id);
    stagedMessageIds.push(id);
  }

  return { notices, stagedMessageIds, stripStagedFileParts };
}

function hasFileParts(message: UIMessage): boolean {
  const parts = Array.isArray((message as any).parts)
    ? ((message as any).parts as Array<{ type?: string }>)
    : [];
  return parts.some((part) => part?.type === "file");
}

function extractInputFiles(message: UIMessage): InputFile[] {
  const parts = Array.isArray((message as any).parts) ? (message as any).parts : [];
  const files: InputFile[] = [];

  for (const [index, part] of parts.entries()) {
    if (part?.type !== "file") {
      continue;
    }

    const content = part.data ?? part.file ?? part.content;
    if (content === undefined) {
      continue;
    }

    const name = part.filename ?? part.name ?? `file-${index}`;
    const file: InputFile = {
      name,
      safeName: safeFileName(name),
      content: content as FileContent,
    };
    if (part.mediaType !== undefined) {
      file.mediaType = part.mediaType;
    }
    files.push(file);
  }

  return files;
}

function safeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^_+/, "") || "file";
}

function stableMessageId(message: UIMessage): string {
  return `message_${JSON.stringify(message).length}`;
}

async function markMessageStaged(session: HarnessSession, id: string): Promise<void> {
  const local = session as HarnessSession & {
    markMessageStaged?: (messageId: string) => Promise<void>;
  };
  await local.markMessageStaged?.(id);
}

function fileMetadata(file: { bytes?: number; sha256?: string }): { bytes?: number; sha256?: string } {
  const out: { bytes?: number; sha256?: string } = {};
  if (file.bytes !== undefined) {
    out.bytes = file.bytes;
  }
  if (file.sha256 !== undefined) {
    out.sha256 = file.sha256;
  }
  return out;
}

function rootFromPath(pathname: string): string | undefined {
  return pathname.split("/").filter(Boolean)[0];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
