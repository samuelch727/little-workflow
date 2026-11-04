import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  HarnessAppendIdempotencyConflictError,
  HarnessSessionEventValidationError,
  normalizePersistedDurableHarnessEvent,
  type HarnessPriorEventQuery,
} from "../events/occurrence.js";
import type { HarnessEventType } from "../events/names.js";
import {
  REMOTE_SESSION_LOG_PROTOCOL_VERSION,
  RemoteSessionProtocolError,
  parseRemoteAppendRequest,
} from "./protocol.js";
import { inMemorySessionLog, type SessionLogStore } from "./session-log-store.js";

export type SessionLogServerOptions = {
  /** Backing store; defaults to an in-memory log (see fileSessionLog for a durable one). */
  store?: SessionLogStore;
  /** Bind host; defaults to 127.0.0.1. */
  host?: string;
  /** Bind port; defaults to 0 (ephemeral). */
  port?: number;
  /** When set, requests must carry `Authorization: Bearer <token>`. */
  authToken?: string;
  /** Maximum accepted request-body size in bytes; larger requests get 413. Defaults to 4 MiB. */
  maxBodyBytes?: number;
};

export type SessionLogServer = {
  readonly url: string;
  readonly store: SessionLogStore;
  close(): Promise<void>;
};

const DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024;

/** Strict HTTP reference service for the versioned Harness Session protocol. */
export async function startSessionLogServer(
  options: SessionLogServerOptions = {},
): Promise<SessionLogServer> {
  const store = options.store ?? inMemorySessionLog();
  const server = createServer((request, response) => {
    void handleRequest(store, options, request, response);
  });

  const host = options.host ?? "127.0.0.1";
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Session log server failed to bind a TCP address.");
  }

  return {
    url: `http://${connectableHost(host)}:${address.port}`,
    store,
    close: () => closeServer(server),
  };
}

function connectableHost(bindHost: string): string {
  if (bindHost === "0.0.0.0") return "127.0.0.1";
  if (bindHost === "::") return "[::1]";
  return bindHost.includes(":") ? `[${bindHost}]` : bindHost;
}

async function handleRequest(
  store: SessionLogStore,
  options: SessionLogServerOptions,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  try {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "GET" && url.pathname === "/v1/health") {
      if ([...url.searchParams].length !== 0) {
        sendError(response, 400, "invalid_query", "health route accepts no query fields");
        return;
      }
      sendJson(response, 200, {
        schemaVersion: REMOTE_SESSION_LOG_PROTOCOL_VERSION,
        ok: true,
      });
      return;
    }
    if (options.authToken !== undefined && !isAuthorized(request, options.authToken)) {
      sendError(response, 401, "unauthorized", "valid bearer authorization is required");
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/events") {
      if ([...url.searchParams].length !== 0) {
        sendError(response, 400, "invalid_query", "append route accepts no query fields");
        return;
      }
      if (!isJsonContentType(request.headers["content-type"])) {
        sendError(response, 415, "unsupported_media_type", "content-type must be application/json");
        return;
      }
      let body: string;
      try {
        body = await readBody(request, options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES);
      } catch (error) {
        if (error instanceof BodyTooLargeError) {
          sendError(response, 413, "body_too_large", "request body too large");
          request.destroy();
          return;
        }
        throw error;
      }
      let untrusted: unknown;
      try {
        untrusted = JSON.parse(body);
      } catch {
        sendError(response, 400, "invalid_json", "request body is not valid JSON");
        return;
      }
      let appendRequest;
      try {
        appendRequest = parseRemoteAppendRequest(untrusted);
      } catch (error) {
        if (
          error instanceof RemoteSessionProtocolError ||
          error instanceof HarnessSessionEventValidationError
        ) {
          sendError(response, 400, "invalid_event", error.message);
          return;
        }
        throw error;
      }
      try {
        const persisted = normalizePersistedDurableHarnessEvent(
          await store.append(appendRequest.event),
        );
        sendJson(response, 200, {
          schemaVersion: REMOTE_SESSION_LOG_PROTOCOL_VERSION,
          event: persisted,
        });
      } catch (error) {
        if (error instanceof HarnessAppendIdempotencyConflictError) {
          sendError(response, 409, "append_idempotency_conflict", error.message);
          return;
        }
        if (error instanceof HarnessSessionEventValidationError) {
          sendError(response, 400, "invalid_event", error.message);
          return;
        }
        throw error;
      }
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/events") {
      let query: HarnessPriorEventQuery;
      try {
        query = parseReplayQuery(url);
      } catch (error) {
        sendError(
          response,
          400,
          "invalid_query",
          error instanceof Error ? error.message : "invalid replay query",
        );
        return;
      }
      const events = (await store.priorEvents(query)).map((event) =>
        normalizePersistedDurableHarnessEvent(event));
      sendJson(response, 200, {
        schemaVersion: REMOTE_SESSION_LOG_PROTOCOL_VERSION,
        events,
      });
      return;
    }

    sendError(response, 404, "not_found", "route not found");
  } catch {
    // Store internals must not leak to clients.
    sendError(response, 500, "internal_error", "internal error");
  }
}

function parseReplayQuery(url: URL): HarnessPriorEventQuery {
  const allowed = new Set([
    "runId",
    "type",
    "occurrenceId",
    "operationId",
    "taskId",
    "attemptId",
    "afterSequence",
    "limit",
  ]);
  for (const [key] of url.searchParams) {
    if (!allowed.has(key)) throw new TypeError(`unknown query field ${key}`);
    if (url.searchParams.getAll(key).length !== 1) throw new TypeError(`duplicate query field ${key}`);
  }
  return {
    ...optionalQueryString(url, "runId"),
    ...optionalQueryString(url, "occurrenceId"),
    ...optionalQueryString(url, "operationId"),
    ...optionalQueryString(url, "taskId"),
    ...optionalQueryString(url, "attemptId"),
    ...(url.searchParams.has("type")
      ? { type: boundedQueryString(url, "type") as HarnessEventType }
      : {}),
    ...optionalQueryInteger(url, "afterSequence", 0, Number.MAX_SAFE_INTEGER),
    ...optionalQueryInteger(url, "limit", 1, 10_000),
  };
}

function optionalQueryString<Name extends string>(
  url: URL,
  name: Name,
): { [Key in Name]?: string } {
  return (url.searchParams.has(name)
    ? { [name]: boundedQueryString(url, name) }
    : {}) as { [Key in Name]?: string };
}

function boundedQueryString(url: URL, name: string): string {
  const value = url.searchParams.get(name);
  if (value === null || value.length === 0 || value.length > 2_048 || value.includes("\0")) {
    throw new TypeError(`invalid query field ${name}`);
  }
  return value;
}

function optionalQueryInteger<Name extends string>(
  url: URL,
  name: Name,
  minimum: number,
  maximum: number,
): { [Key in Name]?: number } {
  if (!url.searchParams.has(name)) return {};
  const raw = url.searchParams.get(name)!;
  if (!/^(?:0|[1-9][0-9]*)$/u.test(raw)) throw new TypeError(`invalid query field ${name}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`invalid query field ${name}`);
  }
  return { [name]: value } as { [Key in Name]?: number };
}

function isJsonContentType(header: string | undefined): boolean {
  return header?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

function isAuthorized(request: IncomingMessage, authToken: string): boolean {
  const header = request.headers.authorization;
  if (header === undefined) return false;
  const presented = createHash("sha256").update(header).digest();
  const expected = createHash("sha256").update(`Bearer ${authToken}`).digest();
  return timingSafeEqual(presented, expected);
}

function sendError(response: ServerResponse, status: number, code: string, message: string): void {
  sendJson(response, status, {
    schemaVersion: REMOTE_SESSION_LOG_PROTOCOL_VERSION,
    error: { code, message },
  });
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent) {
    response.end();
    return;
  }
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(text);
}

class BodyTooLargeError extends Error {}

function readBody(request: IncomingMessage, maxBytes: number): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new TypeError("maxBodyBytes must be a positive safe integer");
  }
  return new Promise((resolve, reject) => {
    const declared = Number(request.headers["content-length"]);
    if (Number.isFinite(declared) && declared > maxBytes) {
      reject(new BodyTooLargeError());
      return;
    }
    const chunks: Buffer[] = [];
    let received = 0;
    let settled = false;
    request.on("data", (chunk: Buffer) => {
      if (settled) return;
      received += chunk.byteLength;
      if (received > maxBytes) {
        settled = true;
        reject(new BodyTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (!settled) {
        settled = true;
        resolve(Buffer.concat(chunks).toString("utf8"));
      }
    });
    request.on("error", (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
