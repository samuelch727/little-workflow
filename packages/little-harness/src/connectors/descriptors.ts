import type { ToolSet, UIMessage } from "ai";
import type { HarnessOutcomeResult, HarnessOutcomeSink } from "../outcomes/types.js";
import type { Harness, HarnessSession } from "../types.js";
import type { SessionConnectorAttachment } from "./session-registry.js";
import type { ConnectorToolPolicy } from "./tool-extensions.js";

export type ConnectorKind = "chat-sdk" | "web-rich";

export type ConnectorDescriptorBase<TKind extends ConnectorKind> = {
  readonly kind: TKind;
};

export type ChatSdkAdapterFactoryResult = {
  readonly name?: string;
  readonly persistThreadHistory?: boolean;
  handleWebhook?: (request: Request, options?: ChatSdkWebhookOptions) => Promise<Response>;
};

export type ChatSdkWebhookOptions = {
  waitUntil?: (task: Promise<unknown>) => void;
  onOpenModal?: (modal: unknown, contextId: string) => Promise<{ viewId: string } | undefined>;
};

export type ChatSdkMessageAuthor = {
  userId: string;
  userName: string;
  fullName?: string;
  isBot?: boolean | "unknown";
  isMe: boolean;
};

/**
 * A file attached to a chat message, structurally matching the Chat SDK's `Attachment`. Declared
 * here (rather than imported) because the `chat` package is an optional runtime dependency — the
 * same convention as {@link ChatSdkReactionEvent}.
 *
 * The bytes come from one of two places: `data`, when the adapter already materialized them, or
 * `fetchData()`, which is also where a platform's private-URL authentication lives (a Slack file
 * URL is not publicly readable, so only `fetchData` can retrieve it). `url` alone is NOT enough for
 * the connector to inline a file — it never fetches a URL itself.
 *
 * `data` is typed `Uint8Array | Blob` and `fetchData` returns a `Uint8Array` so this type stays free
 * of Node globals; a Node `Buffer` IS a `Uint8Array`, so a real Chat SDK attachment assigns to it
 * unchanged.
 */
export type ChatSdkAttachment = {
  readonly type: "image" | "file" | "video" | "audio";
  /** Bytes the adapter already holds. Preferred over `fetchData` when present. */
  readonly data?: Uint8Array | Blob;
  /** Fetch the bytes, handling platform authentication (e.g. Slack private URLs). */
  readonly fetchData?: () => Promise<Uint8Array>;
  /** IANA media type, when the platform reports one. */
  readonly mimeType?: string;
  /** Original filename, when the platform reports one. */
  readonly name?: string;
  /** File size in bytes, when the platform reports one. Checked BEFORE any fetch. */
  readonly size?: number;
  /** Link to the file. Informational only — the connector never fetches it. */
  readonly url?: string;
  readonly width?: number;
  readonly height?: number;
  readonly fetchMetadata?: Record<string, string>;
};

/** Why an inbound attachment was not inlined into the turn. */
export type ChatSdkAttachmentSkipReason =
  /** Larger than `attachments.maxBytes` (per `attachment.size`, or the fetched byte length). */
  | "oversize"
  /** `fetchData()` rejected, or returned something that is not bytes. */
  | "fetch-failed"
  /** Neither `data` nor `fetchData` was present, so there were no bytes to inline. */
  | "no-data";

/** One attachment the connector could not inline, as handed to `attachments.onSkipped`. */
export type ChatSdkAttachmentSkip = {
  readonly reason: ChatSdkAttachmentSkipReason;
  readonly attachment: ChatSdkAttachment;
  readonly message: ChatSdkMessage;
  readonly adapterName: string;
  /** The model-visible note appended to the message text in place of the file. */
  readonly note: string;
  /** The `fetchData` rejection, for `reason: "fetch-failed"` only. */
  readonly error?: unknown;
  /** The size that exceeded the cap, for `reason: "oversize"` only. */
  readonly bytes?: number;
};

/**
 * How inbound message attachments become UIMessage `file` parts. On by default; pass
 * `attachments: false` on the descriptor to opt out entirely (the same convention as `reactions`).
 *
 * Only the CURRENT inbound message's attachments are inlined — thread/transcript history stays
 * text-only, so a long conversation does not re-fetch and re-embed every file on every turn.
 */
export type ChatSdkAttachmentOptions = {
  /**
   * Largest single attachment inlined into a turn, in bytes. Defaults to
   * `DEFAULT_ATTACHMENT_MAX_BYTES` (10 MiB). An attachment over the cap is skipped with a note in
   * the message text instead — it never fails the turn.
   */
  maxBytes?: number;
  /**
   * Observe attachments that were NOT inlined (oversize, fetch failure, no bytes). Observation
   * only: the turn already degraded to a text note, and a throw from this callback is swallowed.
   */
  onSkipped?: (skip: ChatSdkAttachmentSkip) => void | Promise<void>;
};

export type ChatSdkMessage = {
  id: string;
  text: string;
  threadId: string;
  author: ChatSdkMessageAuthor;
  attachments?: readonly ChatSdkAttachment[];
  formatted?: unknown;
  links?: readonly unknown[];
  raw?: unknown;
  userKey?: string;
};

export type ChatSdkMessageContext = {
  skipped?: ChatSdkMessage[];
  totalSinceLastHandler?: number;
  /**
   * Abort signal for the inbound message, forwarded to `streamHarness` so the run is cancelled when
   * the platform reports the message handling was aborted. Declared here (rather than read through a
   * cast) so connector authors can see it.
   */
  abortSignal?: AbortSignal;
};

export type ChatSdkThread = {
  readonly id: string;
  readonly adapter: { readonly name: string };
  readonly isDM?: boolean;
  readonly messages?: AsyncIterable<ChatSdkMessage>;
  post(message: string | AsyncIterable<string>): Promise<unknown>;
  subscribe?(): Promise<void>;
  startTyping?(status?: string): Promise<void>;
};

export type ChatSdkState = {
  connect?: () => Promise<void>;
  disconnect?: () => Promise<void>;
};

/**
 * The emoji on a reaction. The Chat SDK hands over an `EmojiValue` singleton whose `name` is a
 * normalized well-known name (`"thumbs_up"`), and the raw platform emoji separately.
 */
export type ChatSdkEmoji = string | { readonly name?: string; toString(): string };

/** The subset of a reacting user's identity this package reads. See the PII note on reactions. */
export type ChatSdkReactionAuthor = {
  readonly userId: string;
  readonly isMe?: boolean;
  readonly isBot?: boolean | "unknown";
};

/**
 * A reaction on a message, structurally matching the Chat SDK's `ReactionEvent`. Declared here
 * (rather than imported) because the `chat` package is an optional runtime dependency.
 */
export type ChatSdkReactionEvent = {
  /** True when the reaction was ADDED, false when it was removed. */
  readonly added: boolean;
  readonly emoji: ChatSdkEmoji;
  /** The raw platform emoji, e.g. `"+1"` on Slack. Used when `emoji.name` is absent. */
  readonly rawEmoji?: string;
  readonly messageId: string;
  readonly threadId: string;
  readonly thread?: ChatSdkThread;
  readonly user: ChatSdkReactionAuthor;
  /** The message reacted to, when the platform supplies it. */
  readonly message?: { readonly id?: string; readonly author?: ChatSdkReactionAuthor };
  readonly raw?: unknown;
};

/**
 * Turns a thumbs up / thumbs down in a chat surface into an `outcome.reported` trace event on
 * the session that thread belongs to.
 *
 * PII: only a PSEUDONYMOUS reporter id is stored — `anon_<16 hex of sha256(platform:userId)>` —
 * never a handle, display name, raw platform user id, or message text. Override `reporterId` to
 * supply your own pseudonym, or return `undefined` from it to store none at all.
 */
export type ChatSdkReactionOutcomeOptions = {
  /** Emoji names counted as a success. Default: `["thumbs_up", "+1"]`. */
  positive?: readonly string[];
  /** Emoji names counted as a failure. Default: `["thumbs_down", "-1"]`. */
  negative?: readonly string[];
  /**
   * What a REMOVED reaction means. `"retract"` (default) records a retraction that withdraws
   * the matching report from the aggregation reader's denominator; `"ignore"` drops it.
   */
  onRemoved?: "retract" | "ignore";
  /**
   * The harness session this reaction is feedback on. Defaults to `<adapter>:<threadId>` —
   * the same session id the connector's run pipeline defaults to. Return `undefined` to skip.
   */
  session?: (
    event: ChatSdkReactionEvent,
    context: { adapterName: string },
  ) => string | undefined | Promise<string | undefined>;
  /** Pseudonymous reporter id. See the PII note above. */
  reporterId?: (
    event: ChatSdkReactionEvent,
    context: { adapterName: string },
  ) => string | undefined;
  /** Best-effort downstream consumers of the outcome (e.g. littleDB's `reportOutcome`). */
  sinks?: readonly HarnessOutcomeSink[];
  /** Observe what was recorded, including swallowed delivery failures. Never throws onward. */
  onOutcome?: (
    result: HarnessOutcomeResult,
    event: ChatSdkReactionEvent,
  ) => void | Promise<void>;
};

export type ChatSdkChatLike = {
  webhooks: Record<string, (request: Request, options?: ChatSdkWebhookOptions) => Promise<Response>>;
  initialize?: () => Promise<void>;
  shutdown?: () => Promise<void>;
  onDirectMessage?: (
    handler: (
      thread: ChatSdkThread,
      message: ChatSdkMessage,
      channel?: unknown,
      context?: ChatSdkMessageContext,
    ) => Promise<void> | void,
  ) => void;
  onNewMention?: (
    handler: (
      thread: ChatSdkThread,
      message: ChatSdkMessage,
      context?: ChatSdkMessageContext,
    ) => Promise<void> | void,
  ) => void;
  onSubscribedMessage?: (
    handler: (
      thread: ChatSdkThread,
      message: ChatSdkMessage,
      context?: ChatSdkMessageContext,
    ) => Promise<void> | void,
  ) => void;
  /**
   * Register a handler for every reaction. The Chat SDK also offers an emoji-filtered overload;
   * only the unfiltered form is declared here because the connector classifies emoji itself
   * (so an adapter that normalizes differently still reaches the classifier).
   */
  onReaction?: (handler: (event: ChatSdkReactionEvent) => Promise<void> | void) => void;
  transcripts?: {
    list(query: {
      userKey: string;
      limit: number;
      threadId?: string;
      platforms?: string[];
    }): Promise<Array<{ id: string; text: string; role?: "assistant" | "user"; platformMessageId?: string }>>;
  };
  close?: () => Promise<void>;
};

export type ChatSdkChatConstructor = new (config: Record<string, unknown>) => ChatSdkChatLike;

export type ConnectorHistoryPolicy<TExtraBody = unknown> =
  | "latest"
  | { source: "thread"; limit: number; fallback?: "latest" }
  | { source: "transcript"; limit: number; fallback?: "latest" }
  // The custom callback owns history entirely, so it receives the run context WITHOUT `messages`
  // (there is nothing resolved yet to hand it) rather than a fabricated empty array.
  | ((ctx: Omit<ChatSdkRunContext<TExtraBody>, "messages">) => Promise<UIMessage[]>);

export type ChatSdkRunContext<TExtraBody = unknown> = {
  harness: Harness;
  chat: ChatSdkChatLike;
  adapterName: string;
  thread: ChatSdkThread;
  message: ChatSdkMessage;
  messageContext?: ChatSdkMessageContext;
  trigger: "directMessage" | "mention" | "subscribedMessage";
  session: string;
  messages: UIMessage[];
  extraBody?: TExtraBody;
  sent?: unknown;
};

export type ChatSdkSetupErrorContext<TExtraBody = unknown> = {
  phase: "setup";
  error: unknown;
  adapterName: string;
  harness?: Harness;
  chat?: ChatSdkChatLike;
};

export type ChatSdkRunErrorContext<TExtraBody = unknown> =
  Partial<Pick<ChatSdkRunContext<TExtraBody>, "session" | "messages" | "extraBody" | "sent">> &
    Omit<ChatSdkRunContext<TExtraBody>, "session" | "messages" | "extraBody" | "sent"> & {
      phase: "run";
      error: unknown;
    };

export type ChatSdkErrorContext<TExtraBody = unknown> =
  | ChatSdkSetupErrorContext<TExtraBody>
  | ChatSdkRunErrorContext<TExtraBody>;

export type ChatSdkConnectorOptions<TExtraBody = unknown> = {
  userName: string;
  adapter: {
    name: string;
    create: () => ChatSdkAdapterFactoryResult | Promise<ChatSdkAdapterFactoryResult>;
  };
  state: () => ChatSdkState | Promise<ChatSdkState>;
  triggers?: {
    directMessage?: boolean;
    mention?: boolean | { subscribe?: boolean };
    subscribedMessage?: boolean;
  };
  /**
   * Capture thumbs up / thumbs down reactions as run outcomes. On by default (like the
   * directMessage trigger) whenever the chat instance exposes `onReaction`; pass `false` to
   * opt out. Capturing is observation-only — it appends an `outcome.reported` trace event and
   * can never fail, block, or alter a run.
   */
  reactions?: false | ChatSdkReactionOutcomeOptions;
  /**
   * Inline files attached to the inbound message as UIMessage `file` parts, so they reach
   * `chat.stageMessage` (which can write them into the session filesystem) and the model's context.
   * On by default (like the directMessage trigger); pass `false` to opt out, or an options object to
   * tune the per-file size cap. See {@link ChatSdkAttachmentOptions}.
   */
  attachments?: false | ChatSdkAttachmentOptions;
  session?: (
    ctx: Omit<ChatSdkRunContext<TExtraBody>, "session" | "messages">,
  ) => string | Promise<string>;
  history?: ConnectorHistoryPolicy<TExtraBody>;
  extraBody?: (
    ctx: Omit<ChatSdkRunContext<TExtraBody>, "session" | "messages" | "extraBody">,
  ) => TExtraBody | Promise<TExtraBody>;
  beforeRun?: (ctx: ChatSdkRunContext<TExtraBody>) => void | Promise<void>;
  afterReply?: (ctx: ChatSdkRunContext<TExtraBody>) => void | Promise<void>;
  onError?: (ctx: ChatSdkErrorContext<TExtraBody>) => void | Promise<void>;
  /**
   * Platform posting for when this connector is the *mirror target* of another surface's run.
   * Written once on the descriptor so mirror delivery reaches this connector without every route
   * re-declaring a deliverer. An explicit `delivery.deliverers[connectorId]` on the active
   * surface's loader still wins over this.
   *
   * Typed `ConnectorTextDeliverer<unknown>` (NOT `<TExtraBody>`): mirror delivery invokes this
   * deliverer with the ACTIVE (posting) surface's `extraBody`, which is that other connector's body
   * shape — not this descriptor's own `TExtraBody`. So `ctx.extraBody` belongs to the active surface
   * and cannot be assumed to match this connector's body type; a deliverer that needs the active
   * body must narrow `unknown` itself.
   */
  deliver?: ConnectorTextDeliverer<unknown>;
  chat?: Record<string, unknown>;
  /**
   * Connector-only tools carried programmatically on the descriptor, so an npm-distributed connector
   * (or an inline descriptor with no `connectors/<id>/tools/` folder on disk) can still ship tools.
   * These are exposed even when no `connectorId` is set. Folder-discovered `connectors/<id>/tools/*`
   * extensions win per-name over descriptor tools. Tool names are validated with the same
   * reserved/invalid-name policy as folder tools, and an execute-less descriptor tool acts as an
   * abstract base only when a folder extension implements it (mirroring the structural model).
   */
  tools?: ToolSet;
  /**
   * Optional per-connector tool access policy. Tool availability is otherwise derived from
   * structure (executable `tools/*` are global; `connectors/<id>/tools/*` are connector-only).
   * Use `allow` to expose only a subset, or `deny` to hide specific tools from this connector.
   *
   * Scope: this policy filters the agent's own structure-derived tools (global `tools/*` plus
   * this connector's tools). It does NOT cover the `bash` runtime tool (disable that with
   * `runtime: { bash: false }`) nor MCP / workflow tools. `allow` / `deny` entries that match no
   * agent or connector tool are ignored.
   */
  toolPolicy?: ConnectorToolPolicy;
};

export type ChatSdkConnectorDescriptor<TExtraBody = unknown> =
  ConnectorDescriptorBase<"chat-sdk"> & ChatSdkConnectorOptions<TExtraBody>;

export type WebRichUser = { id: string; name?: string; email?: string };

export type WebRichRequestBody = {
  id: string;
  messages: UIMessage[];
  [key: string]: unknown;
};

export type WebRichRequestContext<
  TUser extends WebRichUser = WebRichUser,
  TExtraBody = unknown,
> = {
  request: Request;
  body: WebRichRequestBody;
  user: TUser;
  harness: Harness<any, TExtraBody>;
  session: string;
  messages: UIMessage[];
  extraBody?: TExtraBody;
};

export type WebRichHistoryPolicy<TUser extends WebRichUser = WebRichUser> =
  | { source: "request" }
  | {
      source: "server";
      load: (
        ctx: Omit<WebRichRequestContext<TUser>, "messages" | "session" | "extraBody" | "harness">,
      ) => Promise<UIMessage[]>;
    }
  | ((
      ctx: Omit<WebRichRequestContext<TUser>, "messages" | "session" | "extraBody" | "harness">,
    ) => Promise<UIMessage[]>);

export type WebRichConnectorOptions<
  TUser extends WebRichUser = WebRichUser,
  TExtraBody = unknown,
> = {
  authenticate: (request: Request) => TUser | null | Promise<TUser | null>;
  session: (ctx: { request: Request; body: WebRichRequestBody; user: TUser }) => string | Promise<string>;
  history?: WebRichHistoryPolicy<TUser>;
  extraBody?: (ctx: { request: Request; body: WebRichRequestBody; user: TUser }) => TExtraBody | Promise<TExtraBody>;
  beforeRun?: (ctx: WebRichRequestContext<TUser, TExtraBody>) => void | Promise<void>;
  afterRun?: (ctx: WebRichRequestContext<TUser, TExtraBody> & { finished: unknown }) => void | Promise<void>;
  onError?: (
    ctx: Partial<WebRichRequestContext<TUser, TExtraBody>> & { request: Request; error: unknown },
  ) => void | Promise<void>;
  /**
   * Platform posting for when this connector is the *mirror target* of another surface's run.
   * Written once on the descriptor so mirror delivery reaches this connector without every route
   * re-declaring a deliverer. An explicit `delivery.deliverers[connectorId]` on the active
   * surface's loader still wins over this.
   *
   * Typed `ConnectorTextDeliverer<unknown>` (NOT `<TExtraBody>`): mirror delivery invokes this
   * deliverer with the ACTIVE (posting) surface's `extraBody`, which is that other connector's body
   * shape — not this descriptor's own `TExtraBody`. So `ctx.extraBody` belongs to the active surface
   * and cannot be assumed to match this connector's body type; a deliverer that needs the active
   * body must narrow `unknown` itself.
   */
  deliver?: ConnectorTextDeliverer<unknown>;
  /**
   * Connector-only tools carried programmatically on the descriptor, so an npm-distributed connector
   * (or an inline descriptor with no `connectors/<id>/tools/` folder on disk) can still ship tools.
   * These are exposed even when no `connectorId` is set. Folder-discovered `connectors/<id>/tools/*`
   * extensions win per-name over descriptor tools. Tool names are validated with the same
   * reserved/invalid-name policy as folder tools, and an execute-less descriptor tool acts as an
   * abstract base only when a folder extension implements it (mirroring the structural model).
   */
  tools?: ToolSet;
  /**
   * Optional per-connector tool access policy. Tool availability is otherwise derived from
   * structure (executable `tools/*` are global; `connectors/<id>/tools/*` are connector-only).
   * Use `allow` to expose only a subset, or `deny` to hide specific tools from this connector.
   *
   * Scope: this policy filters the agent's own structure-derived tools (global `tools/*` plus
   * this connector's tools). It does NOT cover the `bash` runtime tool (disable that with
   * `runtime: { bash: false }`) nor MCP / workflow tools. `allow` / `deny` entries that match no
   * agent or connector tool are ignored.
   */
  toolPolicy?: ConnectorToolPolicy;
};

export type WebRichConnectorDescriptor<
  TUser extends WebRichUser = WebRichUser,
  TExtraBody = unknown,
> = ConnectorDescriptorBase<"web-rich"> & WebRichConnectorOptions<TUser, TExtraBody>;

export type WorkspaceConnectorDescriptor =
  | ChatSdkConnectorDescriptor<any>
  | WebRichConnectorDescriptor<any, any>;

export type ConnectorTextDeliveryContext<TExtraBody = unknown> = {
  session: HarnessSession;
  sessionId: string;
  text: string;
  target: SessionConnectorAttachment;
  active: SessionConnectorAttachment;
  extraBody?: TExtraBody;
};

export type ConnectorTextDeliverer<TExtraBody = unknown> = (
  ctx: ConnectorTextDeliveryContext<TExtraBody>,
) => void | Promise<void>;

export type ConnectorDeliveryError<TExtraBody = unknown> = {
  error: unknown;
} & Partial<ConnectorTextDeliveryContext<TExtraBody>>;

export type ConnectorDeliveryOptions<TExtraBody = unknown> = {
  deliverers?: Record<string, ConnectorTextDeliverer<TExtraBody>>;
  onError?: (error: ConnectorDeliveryError<TExtraBody>) => void | Promise<void>;
  /**
   * How to demote the surface that was previously `active` when this run takes over. Threaded
   * into `attachSessionConnector`. Defaults to `"passive"`; pass `"mirror"` so the previous
   * surface keeps receiving mirrored replies from this surface.
   */
  previousActive?: "passive" | "mirror";
};

export function chatSdkConnector<TExtraBody = unknown>(
  options: ChatSdkConnectorOptions<TExtraBody>,
): ChatSdkConnectorDescriptor<TExtraBody> {
  return { kind: "chat-sdk", ...options };
}

export function webRichConnector<TUser extends WebRichUser = WebRichUser, TExtraBody = unknown>(
  options: WebRichConnectorOptions<TUser, TExtraBody>,
): WebRichConnectorDescriptor<TUser, TExtraBody> {
  return { kind: "web-rich", ...options };
}

export function isChatSdkConnector(value: unknown): value is ChatSdkConnectorDescriptor<any> {
  return typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "chat-sdk";
}

export function isWebRichConnector(value: unknown): value is WebRichConnectorDescriptor<any, any> {
  return typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "web-rich";
}
