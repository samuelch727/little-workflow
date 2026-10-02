import { join } from "node:path";
import type { ToolSet, UIMessage } from "ai";
import { HarnessInputError } from "../errors.js";
import {
  streamHarness as defaultStreamHarness,
  type StreamHarnessOptions,
  type StreamHarnessResult,
} from "../execution/stream-harness.js";
import type { Harness } from "../types.js";
import {
  isEmptyInboundAttachments,
  NO_INBOUND_ATTACHMENTS,
  resolveInboundAttachments,
  type ResolvedInboundAttachments,
} from "./attachments.js";
import {
  isChatSdkConnector,
  type ChatSdkAdapterFactoryResult,
  type ChatSdkChatConstructor,
  type ChatSdkChatLike,
  type ChatSdkConnectorDescriptor,
  type ConnectorDeliveryError,
  type ConnectorDeliveryOptions,
  type ConnectorTextDeliverer,
  type ChatSdkErrorContext,
  type ChatSdkMessage,
  type ChatSdkMessageContext,
  type ChatSdkRunContext,
  type ChatSdkState,
  type ChatSdkThread,
  type ChatSdkWebhookOptions,
  type WorkspaceConnectorDescriptor,
} from "./descriptors.js";
import { createReactionOutcomeHandler } from "./reactions.js";
import {
  attachSessionConnector,
  chatSdkEndpointId,
  selectSessionDeliveryTargets,
  type SessionConnectorAttachment,
} from "./session-registry.js";
import { rejectReservedDiscoveredToolNames } from "../workspace/tool-name-policy.js";

type HarnessLoader = (agentDir: string) => Promise<Harness>;
type ConnectorToolExtensionLoader = (
  agentDir: string,
  connectorId: string,
  baseTools: ToolSet,
) => Promise<ToolSet>;

export type ChatSdkConnectorReference<TExtraBody = unknown> =
  | string
  | ChatSdkConnectorDescriptor<TExtraBody>;

export type LoadChatSdkConnectorOptions<TExtraBody = unknown> = {
  agentDir: string;
  connector: ChatSdkConnectorReference<TExtraBody>;
  loadHarness?: HarnessLoader;
  createChat?: ChatSdkChatConstructor;
  streamHarness?: (options: StreamHarnessOptions<any, TExtraBody>) => StreamHarnessResult<any>;
  loadConnectorToolExtensions?: ConnectorToolExtensionLoader;
  connectorId?: string;
  delivery?: ConnectorDeliveryOptions<TExtraBody>;
};

/**
 * Arguments for {@link LoadedChatSdkConnector.simulateInbound}. `trigger` selects which run pipeline
 * to drive and defaults to `"directMessage"`.
 */
export type SimulateInboundArgs = {
  trigger?: "directMessage" | "mention" | "subscribedMessage";
  thread: ChatSdkThread;
  message: ChatSdkMessage;
  context?: ChatSdkMessageContext;
};

export type LoadedChatSdkConnector<TExtraBody = unknown> = {
  chat: ChatSdkChatLike;
  adapter: ChatSdkAdapterFactoryResult;
  webhook(request: Request, options?: ChatSdkWebhookOptions): Promise<Response>;
  adapterName: string;
  harness: Harness;
  /** The resolved descriptor this connector was loaded from, typed to the same `TExtraBody`. */
  readonly descriptor: ChatSdkConnectorDescriptor<TExtraBody>;
  /**
   * Drive a synthetic inbound message through the SAME internal `run()` pipeline the real platform
   * triggers use — session resolution, history, connector tools, `extraBody`, session attachment,
   * streaming, thread posting, mirror delivery, and the `beforeRun`/`afterReply`/`onError` lifecycle
   * hooks all behave exactly as they do for a real turn. Intended for tests and offline demos.
   *
   * Unlike the real triggers, `simulateInbound` does NOT consult the descriptor's enabled-trigger
   * configuration (`triggers.directMessage` / `triggers.mention` / `triggers.subscribedMessage`): a
   * disabled trigger can still be simulated, because invoking it is an explicit developer action. Every
   * other behavior is identical to a live turn — including mention auto-subscribe when
   * `triggers.mention.subscribe` is set. `trigger` defaults to `"directMessage"`.
   *
   * Attachments work here too: put them on `args.message.attachments`. A `data`-backed attachment
   * needs no network, so a scripted driver can hand the agent a file entirely offline.
   */
  simulateInbound(args: SimulateInboundArgs): Promise<void>;
  close(): Promise<void>;
};

type TriggerName = ChatSdkRunContext["trigger"];
type ResolvedChatCtorModule = {
  Chat?: ChatSdkChatConstructor;
  default?: ChatSdkChatConstructor | { Chat?: ChatSdkChatConstructor };
};

/**
 * Map a Chat SDK message to a UIMessage.
 *
 * `attachments` carries the already-fetched result of {@link resolveInboundAttachments} for the
 * INBOUND message and is omitted for history entries, which stay text-only. Passing nothing
 * reproduces the original text-only mapping exactly.
 */
export function messageToUIMessage(
  message: ChatSdkMessage,
  attachments: ResolvedInboundAttachments = NO_INBOUND_ATTACHMENTS,
): UIMessage {
  return {
    id: message.id,
    role: message.author.isMe ? "assistant" : "user",
    // Cast: the `file` parts carry raw `data` alongside the AI SDK's `url`, which the
    // `FileUIPart` union does not declare. See `ChatSdkFileUIPart` for why both are needed.
    parts: [
      { type: "text", text: textWithNotes(message.text, attachments.notes) },
      ...attachments.fileParts,
    ] as UIMessage["parts"],
  };
}

/** Append the skipped-attachment notes to a message's text, if there are any. */
function textWithNotes(text: string, notes: readonly string[]): string {
  if (notes.length === 0) return text;
  const joined = notes.join("\n");
  return text.length > 0 ? `${text}\n\n${joined}` : joined;
}

/**
 * Attach the inbound message's fetched attachments to a UIMessage that some history source already
 * produced for it (thread history that includes the just-sent message, a transcript store that
 * already persisted it, or a custom history callback).
 *
 * A message that ALREADY carries a `file` part is left untouched: a custom history callback that
 * resolved attachments itself owns them, and re-attaching would duplicate the file.
 */
function withInboundAttachments(
  entry: UIMessage,
  attachments: ResolvedInboundAttachments,
): UIMessage {
  if (isEmptyInboundAttachments(attachments)) return entry;
  const parts = Array.isArray((entry as any).parts)
    ? [...((entry as any).parts as Array<{ type?: string; text?: string }>)]
    : [];
  if (parts.some((part) => part?.type === "file")) return entry;

  if (attachments.notes.length > 0) {
    const textIndex = parts.findIndex((part) => part?.type === "text");
    if (textIndex === -1) {
      parts.unshift({ type: "text", text: textWithNotes("", attachments.notes) });
    } else {
      const existing = parts[textIndex] as { type: "text"; text?: string };
      parts[textIndex] = {
        ...existing,
        text: textWithNotes(existing.text ?? "", attachments.notes),
      };
    }
  }

  return {
    ...entry,
    parts: [...parts, ...attachments.fileParts] as UIMessage["parts"],
  };
}

/**
 * Apply the inbound attachments to the history entry whose id matches the inbound message. Used
 * where a history source may have produced the inbound message itself.
 */
function applyInboundAttachmentsById(
  messages: UIMessage[],
  id: string,
  attachments: ResolvedInboundAttachments,
): UIMessage[] {
  if (isEmptyInboundAttachments(attachments)) return messages;
  return messages.map((item) => (item.id === id ? withInboundAttachments(item, attachments) : item));
}

async function loadDefaultChatConstructor(): Promise<ChatSdkChatConstructor> {
  const moduleName = "chat";
  let module: ResolvedChatCtorModule;
  try {
    module = (await import(
      /* @vite-ignore */ /* webpackIgnore: true */ moduleName
    )) as ResolvedChatCtorModule;
  } catch (error) {
    throw new HarnessInputError('Install the "chat" package to load Chat SDK connectors.', {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  const defaultExport = module.default;
  const Chat =
    module.Chat ??
    (typeof defaultExport === "function" ? defaultExport : defaultExport?.Chat);
  if (typeof Chat !== "function") {
    throw new HarnessInputError('Chat SDK module must export a "Chat" constructor.');
  }
  return Chat;
}

async function loadDefaultHarness(agentDir: string): Promise<Harness> {
  const moduleName = "../workspace/index.js";
  const module = (await import(/* @vite-ignore */ /* webpackIgnore: true */ moduleName)) as {
    loadHarness: HarnessLoader;
  };
  return module.loadHarness(agentDir);
}

async function loadDescriptorById(
  agentDir: string,
  connectorId: string,
): Promise<WorkspaceConnectorDescriptor> {
  const moduleName = "./discovery.js";
  const module = (await import(/* @vite-ignore */ /* webpackIgnore: true */ moduleName)) as {
    loadConnectorDescriptor: (
      agentDir: string,
      connectorId: string,
    ) => Promise<WorkspaceConnectorDescriptor>;
  };
  return module.loadConnectorDescriptor(agentDir, connectorId);
}

async function loadConnectorToolExtensionsById(
  agentDir: string,
  connectorId: string,
  baseTools: ToolSet,
): Promise<ToolSet> {
  const moduleName = "./discovery.js";
  const module = (await import(/* @vite-ignore */ /* webpackIgnore: true */ moduleName)) as {
    loadConnectorToolExtensions: (
      agentDir: string,
      connectorId: string,
      baseTools: ToolSet,
    ) => Promise<ToolSet>;
  };
  return module.loadConnectorToolExtensions(agentDir, connectorId, baseTools);
}

async function loadConnectorToolExtensionsFromDirById(
  agentDir: string,
  connectorId: string,
  baseTools: ToolSet,
): Promise<ToolSet> {
  const moduleName = "./discovery.js";
  const module = (await import(/* @vite-ignore */ /* webpackIgnore: true */ moduleName)) as {
    loadConnectorToolExtensionsFromDir: (toolsDir: string, baseTools: ToolSet) => Promise<ToolSet>;
  };
  return module.loadConnectorToolExtensionsFromDir(
    join(agentDir, "connectors", connectorId, "tools"),
    baseTools,
  );
}

async function resolveDescriptor<TExtraBody>(
  agentDir: string,
  connector: ChatSdkConnectorReference<TExtraBody>,
): Promise<ChatSdkConnectorDescriptor<TExtraBody>> {
  const descriptor =
    typeof connector === "string" ? await loadDescriptorById(agentDir, connector) : connector;
  if (!isChatSdkConnector(descriptor)) {
    throw new HarnessInputError("Connector must be a Chat SDK connector descriptor.", {
      kind: typeof descriptor === "object" && descriptor !== null ? descriptor.kind : undefined,
    });
  }
  return descriptor;
}

/**
 * Merge descriptor-provided connector tools with folder-discovered extensions. Folder extensions win
 * per-name (`{ ...descriptor, ...folder }`). Returns `undefined` only when there is neither source,
 * so a connector with no tools passes `connectorTools: undefined` (unchanged behavior). Downstream,
 * `streamHarness` filters execute-less tools via `resolveConnectorTools`, so an execute-less
 * descriptor tool is exposed only when a folder extension implements it.
 */
function mergeConnectorTools(
  descriptorTools: ToolSet | undefined,
  folderExtensions: ToolSet | undefined,
): ToolSet | undefined {
  if (descriptorTools === undefined && folderExtensions === undefined) {
    return undefined;
  }
  return { ...(descriptorTools ?? {}), ...(folderExtensions ?? {}) };
}

function isConnectorNotFoundError(error: unknown): boolean {
  return error instanceof HarnessInputError && error.message === "Connector not found.";
}

/**
 * Load folder-discovered tool extensions for `connectorId`, tolerating a MISSING connector folder
 * only when the connector reference is a descriptor OBJECT. An npm-distributed or inline descriptor
 * carries its tools on the descriptor itself and may ship with no `connector.*` module on disk, so a
 * "Connector not found." here just means discovery found no connector candidate. A STRING reference,
 * by contrast, explicitly named a folder connector, so a missing folder stays a hard error. Only the
 * "Connector not found." HarnessInputError is handled; every other error propagates unchanged.
 *
 * Even without a connector module, a `connectors/<id>/tools/` folder can still exist — so instead of
 * silently dropping those on-disk tools, the swallow path loads them directly from that dir (a
 * missing dir → `{}`). String-reference semantics are unchanged.
 */
async function loadConnectorFolderExtensions(
  loadConnectorTools: ConnectorToolExtensionLoader,
  agentDir: string,
  connectorId: string,
  baseTools: ToolSet,
  referenceIsString: boolean,
): Promise<ToolSet> {
  try {
    return await loadConnectorTools(agentDir, connectorId, baseTools);
  } catch (error) {
    if (!referenceIsString && isConnectorNotFoundError(error)) {
      return loadConnectorToolExtensionsFromDirById(agentDir, connectorId, baseTools);
    }
    throw error;
  }
}

function latestMessage(
  message: ChatSdkMessage,
  attachments: ResolvedInboundAttachments,
): UIMessage[] {
  return [messageToUIMessage(message, attachments)];
}

async function threadHistory(
  thread: ChatSdkThread,
  limit: number,
): Promise<UIMessage[] | undefined> {
  // `undefined` is reserved for "this thread cannot provide history at all" — there is no
  // `thread.messages` iterable — which is what drives the fallback/throw path. An empty-but-present
  // iterable is a real answer: the first turn of a brand-new conversation. It returns `[]`, and
  // `appendInboundIfMissing` then yields just the inbound message rather than erroring on what is a
  // legitimate new conversation.
  if (thread.messages === undefined) return undefined;
  // `thread.messages` is assumed to yield NEWEST-FIRST (the Chat SDK convention): we take the first
  // `limit` items then `.reverse()` so the returned array is oldest-first, matching how a model
  // expects a conversation transcript to read. An adapter that yields oldest-first would produce
  // reversed history — adapters that break the convention should use a custom history callback.
  const messages: UIMessage[] = [];
  for await (const item of thread.messages) {
    messages.push(messageToUIMessage(item));
    if (messages.length >= limit) break;
  }
  return messages.reverse();
}

/**
 * Append the inbound message to resolved thread/transcript history when it is not already present,
 * so a history source that omits the just-sent message does not silently drop what the user said.
 * The inbound message is matched by `id`; only appended for `thread`/`transcript` sources (never for
 * `latest` — which already IS the inbound message — nor for custom callbacks, which own history).
 *
 * When the history source DID include the inbound message, the fetched attachments are applied to
 * that entry instead, so a thread history that echoes back the just-sent message still carries its
 * files (and the notes for the files that were skipped).
 */
function appendInboundIfMissing(
  messages: UIMessage[],
  message: ChatSdkMessage,
  attachments: ResolvedInboundAttachments,
): UIMessage[] {
  if (messages.some((item) => item.id === message.id)) {
    return applyInboundAttachmentsById(messages, message.id, attachments);
  }
  return [...messages, messageToUIMessage(message, attachments)];
}

type TranscriptEntry = {
  id: string;
  text: string;
  role?: "assistant" | "user";
  platformMessageId?: string;
};

function transcriptToUIMessage(item: TranscriptEntry): UIMessage {
  return {
    id: item.id,
    role: item.role ?? "user",
    parts: [{ type: "text", text: item.text }],
  };
}

/**
 * Map transcript history to UI messages and append the inbound message when the store did not
 * already persist it. Transcript entries carry BOTH their own transcript-record `id` and the
 * platform's message id as `platformMessageId`; the inbound `message.id` is a PLATFORM id, so a
 * persisted inbound shows up with a *different* `id` but a matching `platformMessageId`. The
 * presence check therefore runs on the RAW entries (matching `id` OR `platformMessageId`) — checking
 * only the mapped UIMessage `id`, as the shared `appendInboundIfMissing` does, never sees a
 * persisted inbound (because `transcriptToUIMessage` drops `platformMessageId`) and would duplicate
 * what the user just said.
 */
function appendInboundToTranscript(
  entries: TranscriptEntry[],
  message: ChatSdkMessage,
  attachments: ResolvedInboundAttachments,
): UIMessage[] {
  const mapped = entries.map(transcriptToUIMessage);
  const persistedIndex = entries.findIndex(
    (entry) => entry.id === message.id || entry.platformMessageId === message.id,
  );
  if (persistedIndex === -1) {
    return [...mapped, messageToUIMessage(message, attachments)];
  }
  // A transcript store keeps text, not files, so the persisted inbound entry is where the fetched
  // attachments have to be re-attached — matched positionally because its transcript-record `id`
  // differs from the platform message id.
  const persisted = mapped[persistedIndex];
  if (persisted !== undefined) {
    mapped[persistedIndex] = withInboundAttachments(persisted, attachments);
  }
  return mapped;
}

async function transcriptHistory(
  chat: ChatSdkChatLike,
  thread: ChatSdkThread,
  message: ChatSdkMessage,
  limit: number,
): Promise<TranscriptEntry[] | undefined> {
  if (message.userKey === undefined) return undefined;
  let transcripts: ChatSdkChatLike["transcripts"];
  try {
    transcripts = chat.transcripts;
  } catch (error) {
    throw new HarnessInputError("Transcript history is unavailable.", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  if (transcripts === undefined) return undefined;
  // Return the RAW entries (not mapped UI messages) so the dedupe in `appendInboundToTranscript` can
  // still see `platformMessageId`, which the UI-message mapping drops.
  return transcripts.list({
    userKey: message.userKey,
    limit,
    threadId: thread.id,
    platforms: [thread.adapter.name],
  });
}

/**
 * Resolve the turn's messages.
 *
 * `attachments` holds the inbound message's already-fetched files and is applied ONLY to the inbound
 * message, whichever history source produced it. Attachments on older messages are deliberately not
 * inlined: history is text-only by design here, and re-embedding every file on every turn would
 * re-fetch them from the platform and grow the request without bound.
 */
async function resolveHistory<TExtraBody>(
  descriptor: ChatSdkConnectorDescriptor<TExtraBody>,
  base: Omit<ChatSdkRunContext<TExtraBody>, "messages" | "extraBody">,
  attachments: ResolvedInboundAttachments,
): Promise<UIMessage[]> {
  const policy = descriptor.history ?? { source: "thread", limit: 20, fallback: "latest" };

  if (typeof policy === "function") {
    // The custom callback owns history: hand it the run context without a fabricated `messages`.
    // The one exception is the inbound message's own attachments — the callback cannot fetch them
    // under this connector's cap/failure policy, so they are applied to the entry carrying the
    // inbound id. A callback that resolved files itself keeps them (see `withInboundAttachments`).
    return applyInboundAttachmentsById(await policy(base), base.message.id, attachments);
  }

  if (policy === "latest") {
    return latestMessage(base.message, attachments);
  }

  if (policy.source === "thread") {
    const messages = await threadHistory(base.thread, policy.limit);
    if (messages !== undefined) return appendInboundIfMissing(messages, base.message, attachments);
    if (policy.fallback === "latest") return latestMessage(base.message, attachments);
    throw new HarnessInputError("Thread history is unavailable.", {
      adapterName: base.adapterName,
      threadId: base.thread.id,
    });
  }

  if (policy.source === "transcript") {
    let entries: TranscriptEntry[] | undefined;
    try {
      entries = await transcriptHistory(base.chat, base.thread, base.message, policy.limit);
    } catch (error) {
      if (policy.fallback === "latest") return latestMessage(base.message, attachments);
      throw error;
    }
    if (entries !== undefined && entries.length > 0) {
      return appendInboundToTranscript(entries, base.message, attachments);
    }
    if (policy.fallback === "latest") return latestMessage(base.message, attachments);
    if (entries !== undefined) return latestMessage(base.message, attachments);
    throw new HarnessInputError("Transcript history requires message.userKey and chat.transcripts.");
  }

  return [];
}

async function safeCallOnError<TExtraBody>(
  descriptor: ChatSdkConnectorDescriptor<TExtraBody>,
  ctx: ChatSdkErrorContext<TExtraBody>,
): Promise<void> {
  try {
    await descriptor.onError?.(ctx);
  } catch {
    /* Error observers must not mask the original setup/run failure. */
  }
}

async function closeChat(
  chat: ChatSdkChatLike | undefined,
  state: ChatSdkState | undefined,
  disconnectState: boolean,
): Promise<void> {
  let closeError: unknown;
  try {
    if (typeof chat?.shutdown === "function") {
      await chat.shutdown();
    } else {
      await chat?.close?.();
    }
  } catch (error) {
    closeError = error;
  }

  if (disconnectState) {
    try {
      await state?.disconnect?.();
    } catch (error) {
      closeError ??= error;
    }
  }

  if (closeError !== undefined) {
    throw closeError;
  }
}

async function closeAfterSetupFailure(
  chat: ChatSdkChatLike | undefined,
  state: ChatSdkState | undefined,
  disconnectState: boolean,
): Promise<void> {
  try {
    await closeChat(chat, state, disconnectState);
  } catch {
    /* Preserve the original setup error. */
  }
}

async function initializeChat(chat: ChatSdkChatLike, state: ChatSdkState): Promise<void> {
  if (typeof chat.initialize === "function") {
    await chat.initialize();
    return;
  }
  await state.connect?.();
}

function mentionShouldSubscribe<TExtraBody>(
  descriptor: ChatSdkConnectorDescriptor<TExtraBody>,
): boolean {
  return typeof descriptor.triggers?.mention === "object" && descriptor.triggers.mention.subscribe === true;
}

function enabledTriggers<TExtraBody>(descriptor: ChatSdkConnectorDescriptor<TExtraBody>) {
  return {
    directMessage: descriptor.triggers?.directMessage !== false,
    mention: descriptor.triggers?.mention !== false,
    subscribedMessage: descriptor.triggers?.subscribedMessage === true,
  };
}

async function callDeliveryOnError<TExtraBody>(
  delivery: ConnectorDeliveryOptions<TExtraBody> | undefined,
  error: unknown,
  context: Omit<ConnectorDeliveryError<TExtraBody>, "error">,
): Promise<void> {
  try {
    await delivery?.onError?.({ ...context, error });
  } catch {
    /* Delivery observers must not fail the active response. */
  }
}

async function resolveTargetDeliverer<TExtraBody>(
  target: SessionConnectorAttachment,
  delivery: ConnectorDeliveryOptions<TExtraBody> | undefined,
  agentDir: string,
  cache: Map<string, ConnectorTextDeliverer<TExtraBody> | undefined>,
): Promise<ConnectorTextDeliverer<TExtraBody> | undefined> {
  const explicit = delivery?.deliverers?.[target.connectorId];
  if (explicit !== undefined) return explicit;
  if (cache.has(target.connectorId)) return cache.get(target.connectorId);
  const descriptor = await loadDescriptorById(agentDir, target.connectorId);
  const deliver = descriptor.deliver as ConnectorTextDeliverer<TExtraBody> | undefined;
  cache.set(target.connectorId, deliver);
  return deliver;
}

async function deliverMirrors<TExtraBody>(
  delivery: ConnectorDeliveryOptions<TExtraBody> | undefined,
  result: StreamHarnessResult<any>,
  context: {
    session: Awaited<ReturnType<Harness["sessions"]["getOrCreate"]>>;
    sessionId: string;
    active: SessionConnectorAttachment;
    extraBody?: TExtraBody;
  },
  agentDir: string,
  delivererCache: Map<string, ConnectorTextDeliverer<TExtraBody> | undefined>,
): Promise<void> {
  try {
    const text = await result.text;
    const targets = await selectSessionDeliveryTargets(context.session, context.active);
    await Promise.all(targets.map(async (target) => {
      let deliver: ConnectorTextDeliverer<TExtraBody> | undefined;
      try {
        deliver = await resolveTargetDeliverer(target, delivery, agentDir, delivererCache);
      } catch (error) {
        await callDeliveryOnError(delivery, error, { ...context, text, target });
        return;
      }
      if (deliver === undefined) return;
      try {
        await deliver({
          ...context,
          text,
          target,
        });
      } catch (error) {
        await callDeliveryOnError(delivery, error, { ...context, text, target });
      }
    }));
  } catch (error) {
    await callDeliveryOnError(delivery, error, context);
  }
}

// A descriptor-object reference infers `TExtraBody` from the descriptor; a string reference is
// resolved from disk at runtime and cannot be checked against a compile-time descriptor, so it is
// intentionally typed `unknown` (the documented semantic).
export function loadChatSdkConnector<TExtraBody = unknown>(
  options: LoadChatSdkConnectorOptions<TExtraBody> & {
    connector: ChatSdkConnectorDescriptor<TExtraBody>;
  },
): Promise<LoadedChatSdkConnector<TExtraBody>>;
export function loadChatSdkConnector(
  options: LoadChatSdkConnectorOptions<unknown> & { connector: string },
): Promise<LoadedChatSdkConnector<unknown>>;
// Final GENERAL overload matching the implementation signature so previously-compiling call shapes
// still resolve: an explicit generic paired with a string ref
// (`loadChatSdkConnector<MyBody>({ connector: "discord" })`) and a value typed as the exported
// `LoadChatSdkConnectorOptions<T>` (whose `connector` is the `string | descriptor` union, matching
// neither narrowed overload above). The two specific overloads are still tried first, so
// descriptor-first inference — and the `unknown` fallback for bare string refs — is unchanged.
export function loadChatSdkConnector<TExtraBody = unknown>(
  options: LoadChatSdkConnectorOptions<TExtraBody>,
): Promise<LoadedChatSdkConnector<TExtraBody>>;
export async function loadChatSdkConnector<TExtraBody = unknown>(
  options: LoadChatSdkConnectorOptions<TExtraBody>,
): Promise<LoadedChatSdkConnector<TExtraBody>> {
  const descriptor = await resolveDescriptor(options.agentDir, options.connector);
  const loadHarness = options.loadHarness ?? loadDefaultHarness;
  const runStreamHarness = options.streamHarness ?? defaultStreamHarness;
  const loadConnectorTools = options.loadConnectorToolExtensions ?? loadConnectorToolExtensionsById;
  const connectorId = typeof options.connector === "string" ? options.connector : options.connectorId;
  if (typeof options.connector !== "string" && options.connectorId === undefined) {
    console.warn(
      "little-harness: a Chat SDK connector descriptor was loaded without `connectorId`. " +
        "Connector-scoped tools, session attachment, and mirror delivery are disabled. " +
        'Pass `connectorId: "<id>"` (or a string connector reference) to enable them.',
    );
  }
  const previousActive = options.delivery?.previousActive;
  const delivererCache = new Map<string, ConnectorTextDeliverer<TExtraBody> | undefined>();
  let harness: Harness | undefined;
  let chat: ChatSdkChatLike | undefined;
  let state: ChatSdkState | undefined;
  let disconnectState = false;
  let connectorTools: ToolSet | undefined;
  let adapter: ChatSdkAdapterFactoryResult;
  const adapterName = descriptor.adapter.name;

  try {
    harness = await loadHarness(options.agentDir);
    const descriptorTools = descriptor.tools;
    if (descriptorTools !== undefined) {
      rejectReservedDiscoveredToolNames(Object.keys(descriptorTools));
    }
    const folderExtensions = connectorId === undefined
      ? undefined
      : await loadConnectorFolderExtensions(
        loadConnectorTools,
        options.agentDir,
        connectorId,
        harness.config.tools,
        typeof options.connector === "string",
      );
    connectorTools = mergeConnectorTools(descriptorTools, folderExtensions);
    const [resolvedAdapter, resolvedState, Chat] = await Promise.all([
      descriptor.adapter.create(),
      descriptor.state(),
      options.createChat === undefined ? loadDefaultChatConstructor() : Promise.resolve(options.createChat),
    ]);
    adapter = resolvedAdapter;
    state = resolvedState;
    chat = new Chat({
      ...(descriptor.chat ?? {}),
      userName: descriptor.userName,
      adapters: { [adapterName]: adapter },
      state,
    });
    disconnectState = typeof chat.initialize !== "function";
    await initializeChat(chat, state);
  } catch (error) {
    await closeAfterSetupFailure(chat, state, disconnectState);
    await safeCallOnError<TExtraBody>(descriptor, {
      phase: "setup",
      error,
      ...(harness === undefined ? {} : { harness }),
      ...(chat === undefined ? {} : { chat }),
      adapterName,
    });
    throw error;
  }

  const activeTriggers = enabledTriggers(descriptor);

  const run = async (
    trigger: TriggerName,
    thread: ChatSdkThread,
    message: ChatSdkMessage,
    messageContext?: ChatSdkMessageContext,
  ) => {
    let session: string | undefined;
    let messages: UIMessage[] | undefined;
    let extraBody: TExtraBody | undefined;
    let sent: unknown;
    try {
      if (trigger === "mention" && mentionShouldSubscribe(descriptor)) {
        await thread.subscribe?.();
      }

      const contextWithoutMessages = {
        harness,
        chat,
        adapterName,
        thread,
        message,
        trigger,
        ...(messageContext === undefined ? {} : { messageContext }),
      };
      session =
        (await descriptor.session?.(contextWithoutMessages as any)) ??
        `${thread.adapter.name}:${thread.id}`;
      const base = { ...contextWithoutMessages, session };
      // Files attached to THIS message, fetched once per turn (never throws — an unavailable file
      // degrades to a note in the message text). They reach `chat.stageMessage` and the model
      // through the inbound message's `file` parts.
      const inboundAttachments = await resolveInboundAttachments({
        message,
        adapterName,
        ...(descriptor.attachments === undefined ? {} : { attachments: descriptor.attachments }),
      });
      messages = await resolveHistory<TExtraBody>(descriptor, base as any, inboundAttachments);
      extraBody = await descriptor.extraBody?.({ ...base, messages } as any);
      const activeEndpoint = connectorId === undefined ? undefined : {
        id: chatSdkEndpointId(adapterName, thread.id),
        platform: adapterName,
        threadId: thread.id,
        userId: message.userKey ?? message.author.userId,
      };
      const activeConnector = connectorId === undefined ? undefined : {
        id: connectorId,
        kind: "chat-sdk",
        endpoint: activeEndpoint,
      };
      const sessionRecord = connectorId === undefined
        ? undefined
        : await harness.sessions.getOrCreate({
          id: session,
          ...(extraBody === undefined ? {} : { extraBody }),
        });
      const activeAttachment = sessionRecord === undefined || activeEndpoint === undefined || connectorId === undefined
        ? undefined
        : await attachSessionConnector(
          sessionRecord,
          {
            connectorId,
            kind: "chat-sdk",
            delivery: "active",
            endpoint: activeEndpoint,
          },
          previousActive === undefined ? undefined : { previousActive },
        );
      const runContext: ChatSdkRunContext<TExtraBody> = {
        ...base,
        harness: harness as any,
        messages,
        ...(extraBody === undefined ? {} : { extraBody }),
      };

      await descriptor.beforeRun?.(runContext);
      const abortSignal = messageContext?.abortSignal;
      const result = runStreamHarness({
        harness: harness as any,
        messages,
        session,
        ...(extraBody === undefined ? {} : { extraBody }),
        ...(abortSignal === undefined ? {} : { abortSignal }),
        ...(activeConnector === undefined ? {} : { connector: activeConnector }),
        ...(connectorTools === undefined ? {} : { connectorTools }),
        ...(descriptor.toolPolicy === undefined ? {} : { toolPolicy: descriptor.toolPolicy }),
      });
      sent = await thread.post(result.textStream);
      await descriptor.afterReply?.({ ...runContext, sent });
      await result.finished;
      if (sessionRecord !== undefined && activeAttachment !== undefined) {
        await deliverMirrors(
          options.delivery,
          result,
          {
            session: sessionRecord,
            sessionId: session,
            active: activeAttachment,
            ...(extraBody === undefined ? {} : { extraBody }),
          },
          options.agentDir,
          delivererCache,
        );
      }
    } catch (error) {
      await safeCallOnError<TExtraBody>(descriptor, {
        phase: "run",
        error,
        harness,
        chat,
        adapterName,
        thread,
        message,
        trigger,
        ...(messageContext === undefined ? {} : { messageContext }),
        ...(session === undefined ? {} : { session }),
        ...(messages === undefined ? {} : { messages }),
        ...(extraBody === undefined ? {} : { extraBody }),
        ...(sent === undefined ? {} : { sent }),
      });
      throw error;
    }
  };

  if (activeTriggers.directMessage) {
    chat.onDirectMessage?.((thread, message, _channel, context) =>
      run("directMessage", thread, message, context),
    );
  }

  if (activeTriggers.mention) {
    chat.onNewMention?.((thread, message, context) => run("mention", thread, message, context));
  }

  if (activeTriggers.subscribedMessage) {
    chat.onSubscribedMessage?.((thread, message, context) =>
      run("subscribedMessage", thread, message, context),
    );
  }

  // Outcome capture: a thumbs up/down on one of this agent's replies becomes an
  // `outcome.reported` trace event on the session behind that thread. Registered like the
  // triggers above (on unless `reactions: false`), and entirely observation-only — the handler
  // swallows its own failures and touches nothing the run depends on.
  if (descriptor.reactions !== false && typeof chat.onReaction === "function") {
    chat.onReaction(
      createReactionOutcomeHandler({
        harness,
        adapterName,
        ...(descriptor.reactions === undefined ? {} : { reactions: descriptor.reactions }),
      }),
    );
  }

  return {
    chat,
    adapter,
    adapterName,
    harness,
    descriptor,
    async simulateInbound(args) {
      // Reuse the exact `run()` pipeline the registered triggers call. This deliberately skips the
      // enabled-trigger gate (which only decides whether `chat.on*` handlers are registered) so a
      // disabled trigger can still be exercised offline.
      await run(args.trigger ?? "directMessage", args.thread, args.message, args.context);
    },
    async webhook(request, webhookOptions) {
      const handler = chat.webhooks[adapterName];
      if (handler === undefined) {
        throw new HarnessInputError("Chat SDK webhook handler is missing.", { adapterName });
      }
      return handler(request, webhookOptions);
    },
    async close() {
      await closeChat(chat, state, disconnectState);
    },
  };
}
