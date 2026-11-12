import type { RemoteToolContract } from "./contract.js";
import { isObject, RemoteToolError, uniqueContracts } from "./contract.js";
import {
  BodyTooLarge, DEFAULT_MAX_REQUEST_BYTES, digest, positiveLimit, readBounded, transportJson,
  validRequest, type RemoteToolRequest,
} from "./protocol.js";

export type RemoteToolPrincipal = { id: string; [key: string]: unknown };
/** Safe metadata for execution and diagnostics: no headers, credentials, input or context. */
export type RemoteToolCall = Omit<RemoteToolRequest, "v" | "input" | "context"> & {
  dedupeKey: string | undefined;
  inputDigest: string;
};
export type RemoteToolHandlerContext<P extends RemoteToolPrincipal = RemoteToolPrincipal> = {
  principal: P;
  /** Host assertions, never a substitute for the verified principal. */
  context: unknown;
  call: Readonly<RemoteToolCall>;
  signal: AbortSignal;
};
export type RemoteToolHandler<I = any, O = any, P extends RemoteToolPrincipal = any> = {
  contract: RemoteToolContract<I, O>;
  execute: (input: I, context: RemoteToolHandlerContext<P>) => O | PromiseLike<O>;
};

export function remoteToolHandler<I, O, P extends RemoteToolPrincipal = RemoteToolPrincipal>(
  contract: RemoteToolContract<I, O>,
  execute: RemoteToolHandler<I, O, P>["execute"],
): RemoteToolHandler<I, O, P> {
  uniqueContracts([contract]);
  if (typeof execute !== "function") throw new Error("A remote tool handler requires execute.");
  return Object.freeze({ contract, execute });
}

export type ServeRemoteToolsOptions<P extends RemoteToolPrincipal = RemoteToolPrincipal> = {
  tools: readonly RemoteToolHandler<any, any, P>[];
  authenticate: (request: Request) => P | undefined | PromiseLike<P | undefined>;
  onError?: (error: unknown, call: Readonly<RemoteToolCall> | undefined) => void | PromiseLike<void>;
  maxRequestBytes?: number;
};

/** A Fetch handler usable in Node, Next.js routes, Hono, Bun or a workerd service. */
export function serveRemoteTools<P extends RemoteToolPrincipal>(options: ServeRemoteToolsOptions<P>): (request: Request) => Promise<Response> {
  if (typeof options.authenticate !== "function") throw new Error("Remote tools require authenticate.");
  uniqueContracts(options.tools.map(handler => handler.contract));
  const handlers = new Map(options.tools.map(handler => [handler.contract.name, remoteToolHandler(handler.contract, handler.execute)]));
  const maxBytes = positiveLimit(options.maxRequestBytes, DEFAULT_MAX_REQUEST_BYTES);
  const report = async (error: unknown, call?: Readonly<RemoteToolCall>) => {
    try { await options.onError?.(error, call); } catch { /* Diagnostics cannot change the boundary. */ }
  };
  return async request => {
    if (request.method !== "POST") return refused(405, { allow: "POST" });
    if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") return refused(415);
    let envelope: unknown;
    try { envelope = JSON.parse(await readBounded(request, maxBytes)); }
    catch (error) { return refused(error instanceof BodyTooLarge ? 413 : 400); }
    if (isObject(envelope) && Object.hasOwn(envelope, "v") && envelope.v !== 1) return refused(409);
    if (!validRequest(envelope)) return refused(400);

    let principal: P | undefined;
    try { principal = await options.authenticate(request); }
    catch (error) { await report(error); return refused(401); }
    if (!isObject(principal) || typeof principal.id !== "string" || principal.id.length === 0) return refused(401);
    const handler = handlers.get(envelope.tool);
    if (handler === undefined) return refused(404);
    let input: unknown;
    try {
      const validated = await handler.contract.inputSchema.validate!(envelope.input);
      if (!validated.success) return refused(400);
      input = validated.value;
    } catch (error) { await report(error); return refused(400); }

    let call: Readonly<RemoteToolCall> | undefined;
    try {
      const { tool, toolCallId, scope, sessionId, invocationId, idempotencyKey } = envelope;
      const kind = invocationId !== undefined ? "invocation" : "workflow-step";
      const id = invocationId ?? idempotencyKey;
      call = Object.freeze({
        tool, toolCallId, scope, sessionId,
        ...(invocationId === undefined ? {} : { invocationId }),
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
        dedupeKey: id === undefined ? undefined : await digest(["lh.remote-tool.dedupe.v1", kind, principal.id, scope, sessionId, tool, id]),
        inputDigest: await digest(input),
      });
      request.signal.throwIfAborted();
      let serialized = serializeOutput(await handler.execute(input, { principal, context: envelope.context, call, signal: request.signal }));
      if (handler.contract.outputSchema !== undefined) {
        // Validate the value that will actually cross the wire, including Date/toJSON conversion.
        const validated = await handler.contract.outputSchema.validate!(serialized.output);
        if (!validated.success) throw new Error("Remote tool output validation failed.");
        serialized = serializeOutput(validated.value);
      }
      return new Response(serialized.body, { headers: { "content-type": "application/json" } });
    } catch (error) {
      if (error instanceof RemoteToolError) {
        return Response.json({ ok: false, error: { message: error.message, ...(error.code === undefined ? {} : { code: error.code }) } });
      }
      await report(error, call);
      return Response.json({ ok: false, error: { message: "The tool failed." } });
    }
  };
}

function serializeOutput(output: unknown): { body: string; output: unknown } {
  const body = transportJson({ ok: true, output });
  const wire = JSON.parse(body) as { output?: unknown };
  if (!Object.hasOwn(wire, "output")) throw new TypeError("Remote tool output must produce a JSON value.");
  return { body, output: wire.output };
}

function refused(status: number, headers?: HeadersInit): Response {
  return Response.json({ ok: false, error: { message: "The remote tool request was refused." } }, { status, ...(headers === undefined ? {} : { headers }) });
}
