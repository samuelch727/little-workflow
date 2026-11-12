import { tool, type JSONValue, type Tool, type ToolExecutionOptions } from "ai";
import { tryHarnessToolContext } from "../connectors/tool-context.js";
import type { HarnessToolExecutionContext } from "../types.js";
import { isObject, RemoteToolError, uniqueContracts, validError, type RemoteToolContract } from "./contract.js";
import {
  DEFAULT_MAX_REQUEST_BYTES, DEFAULT_MAX_RESPONSE_BYTES, positiveLimit, readBounded, transportJson,
  validRequest, type RemoteToolRequest,
} from "./protocol.js";

export type RemoteToolClientCall = Readonly<Omit<RemoteToolRequest, "v" | "input" | "context"> & {
  harness: HarnessToolExecutionContext | undefined;
}>;
export type RemoteToolClientOptions = {
  endpoint: string | { fetch(request: Request): Response | PromiseLike<Response> };
  scope: string;
  headers?: HeadersInit | ((call: RemoteToolClientCall) => HeadersInit | PromiseLike<HeadersInit>);
  context?: JSONValue | ((call: RemoteToolClientCall) => JSONValue | undefined | PromiseLike<JSONValue | undefined>);
  timeoutMs?: number;
  maxRequestBytes?: number;
  maxResponseBytes?: number;
};
type RemoteToolSet<C extends readonly RemoteToolContract[]> = {
  [T in C[number] as T["name"]]: T extends RemoteToolContract<infer I, infer O> ? Tool<I, O> : never;
};

/** Builds model tools without listing/discovering tools or importing their implementation. */
export function remoteTools<const C extends readonly RemoteToolContract[]>(contracts: C, options: RemoteToolClientOptions): RemoteToolSet<C> {
  const byName = uniqueContracts(contracts);
  const timeoutMs = positiveLimit(options.timeoutMs, 60_000);
  const maxRequestBytes = positiveLimit(options.maxRequestBytes, DEFAULT_MAX_REQUEST_BYTES);
  const maxResponseBytes = positiveLimit(options.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES);
  if (typeof options.scope !== "string" || options.scope.length === 0 || options.scope.length > 2048) throw new Error("Remote tools require a bounded, nonempty scope.");
  const endpoint = options.endpoint;
  let url = "https://remote-tools.invalid/";
  if (typeof endpoint === "string") {
    const parsed = new URL(endpoint);
    if (parsed.username || parsed.password || parsed.hash ||
      parsed.protocol !== "https:" && !(parsed.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname))) {
      throw new Error("Remote tool endpoints require HTTPS, except loopback HTTP, without URL credentials or fragments.");
    }
    url = parsed.href;
  } else if (typeof endpoint?.fetch !== "function") throw new Error("Remote tools require a URL or fetch binding.");

  return Object.fromEntries([...byName.values()].map(contract => [contract.name, tool({
    description: contract.description,
    inputSchema: contract.inputSchema,
    execute: async (input: unknown, executeOptions: ToolExecutionOptions<unknown>) => {
      const harness = tryHarnessToolContext(executeOptions);
      const turnSignal = harness?.abortSignal ?? executeOptions.abortSignal;
      turnSignal?.throwIfAborted();
      const call: RemoteToolClientCall = Object.freeze({
        tool: contract.name, toolCallId: executeOptions.toolCallId, scope: options.scope,
        sessionId: harness?.session.id ?? "standalone", harness,
        ...(harness?.invocationId === undefined ? {} : { invocationId: harness.invocationId }),
        ...(harness?.idempotencyKey === undefined ? {} : { idempotencyKey: harness.idempotencyKey }),
      });
      const controller = new AbortController();
      let timedOut = false;
      let sent = false;
      let rejectAbort!: (reason: unknown) => void;
      const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
      const onAbort = () => { controller.abort(turnSignal?.reason); rejectAbort(turnSignal?.reason ?? new DOMException("Aborted", "AbortError")); };
      turnSignal?.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort(new DOMException("Timed out", "TimeoutError"));
        rejectAbort(controller.signal.reason);
      }, timeoutMs);
      try {
        return await Promise.race([aborted, (async () => {
          const headers = new Headers(typeof options.headers === "function" ? await options.headers(call) : options.headers);
          headers.set("content-type", "application/json");
          const context = typeof options.context === "function" ? await options.context(call) : options.context;
          const { harness: _harness, ...wireCall } = call;
          const envelope = { v: 1, ...wireCall, input, ...(context === undefined ? {} : { context }) };
          const body = transportJson(envelope);
          if (new TextEncoder().encode(body).byteLength > maxRequestBytes) throw new RemoteToolError("The remote tool request is too large.");
          if (!validRequest(JSON.parse(body))) throw new RemoteToolError("The remote tool call is invalid.");
          controller.signal.throwIfAborted();
          // One portable policy for URL and service-binding endpoints, including workerd.
          const request = new Request(url, { method: "POST", headers, body, redirect: "manual", signal: controller.signal });
          sent = true;
          const response = await (typeof endpoint === "string" ? fetch(request) : endpoint.fetch(request));
          if (response.type === "opaqueredirect" || response.status >= 300 && response.status < 400) {
            // Never inspect Location or the body, follow the redirect, or retry the call.
            throw new RemoteToolError(`The remote tool server refused the call (${response.status}).`);
          }
          if (response.status !== 200) {
            await response.body?.cancel().catch(() => undefined);
            throw new RemoteToolError(`The remote tool server refused the call (${response.status}).`);
          }
          if (response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
            await response.body?.cancel().catch(() => undefined);
            throw new Error("Invalid remote content type.");
          }
          const result: unknown = JSON.parse(await readBounded(response, maxResponseBytes));
          if (!isObject(result)) throw new Error("Invalid remote response.");
          if (result.ok === false && Object.keys(result).length === 2 && validError(result.error)) throw new RemoteToolError(result.error.message, result.error.code);
          if (result.ok !== true || Object.keys(result).length !== 2 || !Object.hasOwn(result, "output")) throw new Error("Invalid remote response.");
          if (contract.outputSchema !== undefined) {
            const validated = await contract.outputSchema.validate!(result.output);
            if (!validated.success) throw new Error("Invalid remote output.");
            return validated.value;
          }
          return result.output;
        })()]);
      } catch (error) {
        // A turn abort remains terminal and is never converted into a recoverable tool result.
        turnSignal?.throwIfAborted();
        if (timedOut) throw new RemoteToolError(sent
          ? "The remote tool timed out. The call may or may not have run; check its outcome before retrying a write."
          : "The remote tool timed out before sending. No call was sent.", "timeout");
        if (error instanceof RemoteToolError) throw error;
        if (!sent) throw new RemoteToolError("The remote tool request could not be prepared. No call was sent.");
        throw new RemoteToolError("The remote tool call failed. Its outcome may be unknown.");
      } finally {
        clearTimeout(timer);
        turnSignal?.removeEventListener("abort", onAbort);
      }
    },
  })])) as RemoteToolSet<C>;
}
