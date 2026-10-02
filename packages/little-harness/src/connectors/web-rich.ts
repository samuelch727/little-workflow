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
  type ConnectorDeliveryError,
  type ConnectorDeliveryOptions,
  type ConnectorTextDeliverer,
  isWebRichConnector,
  type WebRichConnectorDescriptor,
  type WebRichRequestBody,
  type WebRichRequestContext,
  type WebRichUser,
  type WorkspaceConnectorDescriptor,
} from "./descriptors.js";
import {
  attachSessionConnector,
  selectSessionDeliveryTargets,
  webRichEndpointId,
  type SessionConnectorAttachment,
} from "./session-registry.js";
import { rejectReservedDiscoveredToolNames } from "../workspace/tool-name-policy.js";

type HarnessLoader = (agentDir: string) => Promise<Harness>;
type ConnectorToolExtensionLoader = (
  agentDir: string,
  connectorId: string,
  baseTools: ToolSet,
) => Promise<ToolSet>;

export type WebRichConnectorReference<
  TUser extends WebRichUser = WebRichUser,
  TExtraBody = unknown,
> = string | WebRichConnectorDescriptor<TUser, TExtraBody>;

export type LoadWebRichConnectorOptions<
  TUser extends WebRichUser = WebRichUser,
  TExtraBody = unknown,
> = {
  agentDir: string;
  connector: WebRichConnectorReference<TUser, TExtraBody>;
  loadHarness?: HarnessLoader;
  streamHarness?: (options: StreamHarnessOptions<any, TExtraBody>) => StreamHarnessResult<any>;
  loadConnectorToolExtensions?: ConnectorToolExtensionLoader;
  connectorId?: string;
  delivery?: ConnectorDeliveryOptions<TExtraBody>;
  /**
   * Register the fire-and-forget `afterRun` and mirror-delivery work so serverless hosts keep the
   * function alive until it settles (e.g. Vercel's `waitUntil`). Without it, behavior is
   * unchanged: the work is started but not awaited by the POST handler.
   */
  waitUntil?: (task: Promise<unknown>) => void;
  /**
   * Forwarded to `streamHarness` so MID-STREAM errors — thrown after the 200 response headers are
   * already sent — can be unmasked in the UI message stream. Without an `onError`, the stream emits
   * the generic "An error occurred." text; provide one to surface a real message (e.g. in dev).
   * Mirrors {@link StreamHarnessOptions.uiMessageStream}.
   */
  uiMessageStream?: {
    onError?: (error: unknown) => string;
  };
};

export type LoadedWebRichConnector<
  TUser extends WebRichUser = WebRichUser,
  TExtraBody = unknown,
> = {
  POST(request: Request): Promise<Response>;
  harness: Harness;
  /** The resolved descriptor this connector was loaded from, typed to the same `TUser`/`TExtraBody`. */
  readonly descriptor: WebRichConnectorDescriptor<TUser, TExtraBody>;
  connectorId?: string;
  close(): Promise<void>;
};

type WebRichErrorContext<TUser extends WebRichUser, TExtraBody> =
  Partial<WebRichRequestContext<TUser, TExtraBody>> & { request: Request; error: unknown };

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

async function resolveDescriptor<TUser extends WebRichUser, TExtraBody>(
  agentDir: string,
  connector: WebRichConnectorReference<TUser, TExtraBody>,
): Promise<WebRichConnectorDescriptor<TUser, TExtraBody>> {
  const descriptor =
    typeof connector === "string" ? await loadDescriptorById(agentDir, connector) : connector;
  if (!isWebRichConnector(descriptor)) {
    throw new HarnessInputError("Connector must be a web-rich connector descriptor.", {
      kind: typeof descriptor === "object" && descriptor !== null ? descriptor.kind : undefined,
    });
  }
  return descriptor as WebRichConnectorDescriptor<TUser, TExtraBody>;
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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUIMessageArray(value: unknown): value is UIMessage[] {
  return Array.isArray(value) && value.every((item) => isObject(item));
}

async function parseBody(request: Request): Promise<WebRichRequestBody> {
  let value: unknown;
  try {
    value = await request.json();
  } catch (error) {
    throw new HarnessInputError("Request body must be valid JSON.", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }

  if (!isObject(value) || typeof value.id !== "string" || !isUIMessageArray(value.messages)) {
    throw new HarnessInputError('Request body must include "id" and "messages".', {
      idType: isObject(value) ? typeof value.id : undefined,
      messagesType: isObject(value) ? typeof value.messages : undefined,
    });
  }

  return value as WebRichRequestBody;
}

async function callOnError<TUser extends WebRichUser, TExtraBody>(
  descriptor: WebRichConnectorDescriptor<TUser, TExtraBody>,
  ctx: WebRichErrorContext<TUser, TExtraBody>,
): Promise<void> {
  await descriptor.onError?.(ctx);
}

async function safeCallOnError<TUser extends WebRichUser, TExtraBody>(
  descriptor: WebRichConnectorDescriptor<TUser, TExtraBody>,
  ctx: WebRichErrorContext<TUser, TExtraBody>,
): Promise<void> {
  try {
    await callOnError(descriptor, ctx);
  } catch {
    /* The response has already been returned; avoid surfacing async observer failures. */
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function statusResponse(status: number, error?: unknown): Response {
  // In dev, surface the failure text in the body so a broken route is debuggable straight from the
  // client. Production stays bodyless so internal error messages are never leaked to end users.
  if (error !== undefined && process.env.NODE_ENV !== "production") {
    return new Response(errorMessage(error), { status });
  }
  return new Response(null, { status });
}

/**
 * Observe a route error and produce its HTTP response. Always runs the descriptor's `onError`
 * (best-effort). When the descriptor declares NO `onError`, logs a single-line default so a failing
 * route is never completely silent — this default is UNCONDITIONAL (not dev-only). The error text is
 * added to the response body only in dev (see {@link statusResponse}).
 */
async function respondToRouteError<TUser extends WebRichUser, TExtraBody>(
  descriptor: WebRichConnectorDescriptor<TUser, TExtraBody>,
  status: number,
  phase: "parse" | "authenticate" | "run",
  ctx: WebRichErrorContext<TUser, TExtraBody>,
): Promise<Response> {
  await safeCallOnError(descriptor, ctx);
  if (descriptor.onError === undefined) {
    console.error(
      `little-harness: web-rich route error (phase=${phase}, status=${status}): ${errorMessage(ctx.error)}`,
    );
  }
  return statusResponse(status, ctx.error);
}

async function resolveHistory<TUser extends WebRichUser>(
  descriptor: WebRichConnectorDescriptor<TUser, any>,
  base: { request: Request; body: WebRichRequestBody; user: TUser },
): Promise<UIMessage[]> {
  const policy = descriptor.history ?? { source: "request" };

  if (typeof policy === "function") {
    return policy(base);
  }

  if (policy.source === "server") {
    return policy.load(base);
  }

  return base.body.messages;
}

function observeFinished<TUser extends WebRichUser, TExtraBody>(
  descriptor: WebRichConnectorDescriptor<TUser, TExtraBody>,
  runContext: WebRichRequestContext<TUser, TExtraBody>,
  result: StreamHarnessResult<any>,
): Promise<void> {
  return (async () => {
    try {
      const finished = await result.finished;
      try {
        await descriptor.afterRun?.({ ...runContext, finished });
      } catch (error) {
        await safeCallOnError(descriptor, { ...runContext, request: runContext.request, error });
      }
    } catch (error) {
      await safeCallOnError(descriptor, { ...runContext, request: runContext.request, error });
    }
  })();
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

function observeMirrorDelivery<TExtraBody>(
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
  return (async () => {
    try {
      await result.finished;
    } catch {
      return;
    }

    try {
      const text = await result.text;
      const targets = await selectSessionDeliveryTargets(context.session, context.active);
      await Promise.all(targets.map(async (target) => {
        let deliver: ConnectorTextDeliverer<TExtraBody> | undefined;
        try {
          deliver = await resolveTargetDeliverer(target, delivery, agentDir, delivererCache);
        } catch (error) {
          await callDeliveryOnError(delivery, error, { ...context, target, text });
          return;
        }
        if (deliver === undefined) return;
        try {
          await deliver({ ...context, target, text });
        } catch (error) {
          await callDeliveryOnError(delivery, error, { ...context, target, text });
        }
      }));
    } catch (error) {
      await callDeliveryOnError(delivery, error, context);
    }
  })();
}

// A descriptor-object reference infers `TUser`/`TExtraBody` from the descriptor; a string reference
// is resolved from disk at runtime and cannot be checked against a compile-time descriptor, so it is
// intentionally typed `unknown` (the documented semantic).
export function loadWebRichConnector<
  TUser extends WebRichUser = WebRichUser,
  TExtraBody = unknown,
>(
  options: LoadWebRichConnectorOptions<TUser, TExtraBody> & {
    connector: WebRichConnectorDescriptor<TUser, TExtraBody>;
  },
): Promise<LoadedWebRichConnector<TUser, TExtraBody>>;
export function loadWebRichConnector(
  options: LoadWebRichConnectorOptions<WebRichUser, unknown> & { connector: string },
): Promise<LoadedWebRichConnector<WebRichUser, unknown>>;
// Final GENERAL overload matching the implementation signature so previously-compiling call shapes
// still resolve: an explicit generic paired with a string ref
// (`loadWebRichConnector<TUser, MyBody>({ connector: "web" })`) and a value typed as the exported
// `LoadWebRichConnectorOptions<TUser, T>` (whose `connector` is the `string | descriptor` union,
// matching neither narrowed overload above). The two specific overloads are still tried first, so
// descriptor-first inference — and the `unknown` fallback for bare string refs — is unchanged.
export function loadWebRichConnector<
  TUser extends WebRichUser = WebRichUser,
  TExtraBody = unknown,
>(
  options: LoadWebRichConnectorOptions<TUser, TExtraBody>,
): Promise<LoadedWebRichConnector<TUser, TExtraBody>>;
export async function loadWebRichConnector<
  TUser extends WebRichUser = WebRichUser,
  TExtraBody = unknown,
>(
  options: LoadWebRichConnectorOptions<TUser, TExtraBody>,
): Promise<LoadedWebRichConnector<TUser, TExtraBody>> {
  const descriptor = await resolveDescriptor(options.agentDir, options.connector);
  const loadHarness = options.loadHarness ?? loadDefaultHarness;
  const runStreamHarness = options.streamHarness ?? defaultStreamHarness;
  const loadConnectorTools = options.loadConnectorToolExtensions ?? loadConnectorToolExtensionsById;
  const harness = await loadHarness(options.agentDir);
  const connectorId = typeof options.connector === "string" ? options.connector : options.connectorId;
  if (typeof options.connector !== "string" && options.connectorId === undefined) {
    console.warn(
      "little-harness: a web-rich connector descriptor was loaded without `connectorId`. " +
        "Connector-scoped tools, session attachment, and mirror delivery are disabled. " +
        'Pass `connectorId: "<id>"` (or a string connector reference) to enable them.',
    );
  }
  const previousActive = options.delivery?.previousActive;
  const delivererCache = new Map<string, ConnectorTextDeliverer<TExtraBody> | undefined>();
  const descriptorTools = descriptor.tools;
  if (descriptorTools !== undefined) {
    rejectReservedDiscoveredToolNames(Object.keys(descriptorTools));
  }
  let folderExtensions: ToolSet | undefined;
  if (connectorId !== undefined) {
    try {
      folderExtensions = await loadConnectorFolderExtensions(
        loadConnectorTools,
        options.agentDir,
        connectorId,
        harness.config.tools,
        typeof options.connector === "string",
      );
    } catch (error) {
      await callDeliveryOnError(options.delivery, error, {});
      throw error;
    }
  }
  const connectorTools = mergeConnectorTools(descriptorTools, folderExtensions);

  return {
    harness,
    descriptor,
    ...(connectorId === undefined ? {} : { connectorId }),
    async close() {},
    async POST(request) {
      let body: WebRichRequestBody | undefined;
      let user: TUser | undefined;
      let session: string | undefined;
      let messages: UIMessage[] | undefined;
      let extraBody: TExtraBody | undefined;

      try {
        body = await parseBody(request.clone());
      } catch (error) {
        return respondToRouteError(descriptor, 400, "parse", { request, error });
      }

      try {
        const authenticated = await descriptor.authenticate(request);
        if (authenticated === null) {
          const error = new HarnessInputError("Authentication failed.");
          return respondToRouteError(descriptor, 401, "authenticate", { request, body, error });
        }
        user = authenticated;

        session = await descriptor.session({ request, body, user });
        messages = await resolveHistory(descriptor, { request, body, user });
        extraBody = await descriptor.extraBody?.({ request, body, user });
        const activeEndpoint = connectorId === undefined ? undefined : {
          id: webRichEndpointId(user.id, body.id),
          platform: "web",
          threadId: body.id,
          userId: user.id,
        };
        const activeConnector = connectorId === undefined ? undefined : {
          id: connectorId,
          kind: "web-rich",
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
              kind: "web-rich",
              delivery: "active",
              endpoint: activeEndpoint,
            },
            previousActive === undefined ? undefined : { previousActive },
          );

        const runContext: WebRichRequestContext<TUser, TExtraBody> = {
          request,
          body,
          user,
          harness: harness as any,
          session,
          messages,
          ...(extraBody === undefined ? {} : { extraBody }),
        };

        await descriptor.beforeRun?.(runContext);
        const result = runStreamHarness({
          harness: harness as any,
          messages,
          session,
          ...(extraBody === undefined ? {} : { extraBody }),
          abortSignal: request.signal,
          ...(activeConnector === undefined ? {} : { connector: activeConnector }),
          ...(connectorTools === undefined ? {} : { connectorTools }),
          ...(descriptor.toolPolicy === undefined ? {} : { toolPolicy: descriptor.toolPolicy }),
          ...(options.uiMessageStream === undefined ? {} : { uiMessageStream: options.uiMessageStream }),
        });
        const finishedTask = observeFinished(descriptor, runContext, result);
        options.waitUntil?.(finishedTask);
        if (sessionRecord !== undefined && activeAttachment !== undefined) {
          const mirrorTask = observeMirrorDelivery(
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
          options.waitUntil?.(mirrorTask);
        }
        return result.toUIMessageStreamResponse();
      } catch (error) {
        return respondToRouteError(descriptor, 500, "run", {
          request,
          error,
          ...(body === undefined ? {} : { body }),
          ...(user === undefined ? {} : { user }),
          harness: harness as any,
          ...(session === undefined ? {} : { session }),
          ...(messages === undefined ? {} : { messages }),
          ...(extraBody === undefined ? {} : { extraBody }),
        });
      }
    },
  };
}
