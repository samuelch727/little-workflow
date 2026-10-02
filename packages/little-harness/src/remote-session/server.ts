import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { DurableHarnessEventInput, HarnessPriorEventQuery } from "../events/occurrence.js";
import type { HarnessEventType } from "../events/names.js";
import { createInMemorySessionLog, type SessionLogStore } from "./session-log-store.js";

export type SessionLogServerOptions = {
  /** Backing store; defaults to an in-memory log (see createFileSessionLog for a durable one). */
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

/**
 * A minimal HTTP session-log service: the append-only event log lives behind two routes
 * (`POST /v1/events`, `GET /v1/events?runId=...`), decoupled from every harness process.
 * Any number of stateless harnesses can append to and replay from the same log, which is
 * what makes kill-and-resume work across process (and machine) boundaries. This server is
 * a reference implementation — pass a durable `store` (e.g. createFileSessionLog) and an
 * `authToken` before pointing real workloads at it.
 */
export async function startSessionLogServer(
  options: SessionLogServerOptions = {},
): Promise<SessionLogServer> {
  const store = options.store ?? createInMemorySessionLog();
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
  if (bindHost === "0.0.0.0") {
    return "127.0.0.1";
  }
  if (bindHost === "::") {
    return "[::1]";
  }
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
      // Health stays unauthenticated so load balancers can probe liveness.
      sendJson(response, 200, { ok: true });
      return;
    }
    if (options.authToken !== undefined && !isAuthorized(request, options.authToken)) {
      sendJson(response, 401, { error: "unauthorized" });
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/events") {
      let body: string;
      try {
        body = await readBody(request, options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES);
      } catch (error) {
        if (error instanceof BodyTooLargeError) {
          sendJson(response, 413, { error: "request body too large" });
          request.destroy();
          return;
        }
        throw error;
      }
      let event: DurableHarnessEventInput;
      try {
        event = JSON.parse(body) as DurableHarnessEventInput;
      } catch {
        sendJson(response, 400, { error: "invalid json" });
        return;
      }
      if (
        typeof event.type !== "string" ||
        typeof event.runId !== "string" ||
        typeof event.payload !== "object" ||
        event.payload === null ||
        Array.isArray(event.payload)
      ) {
        sendJson(response, 400, { error: "invalid event" });
        return;
      }
      const persisted = await store.append(event);
      sendJson(response, 200, { event: persisted });
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/events") {
      const query: HarnessPriorEventQuery = {
        ...(url.searchParams.has("runId") ? { runId: url.searchParams.get("runId")! } : {}),
        ...(url.searchParams.has("type")
          ? { type: url.searchParams.get("type") as HarnessEventType }
          : {}),
        ...(url.searchParams.has("occurrenceId")
          ? { occurrenceId: url.searchParams.get("occurrenceId")! }
          : {}),
      };
      const events = await store.priorEvents(query);
      sendJson(response, 200, { events });
      return;
    }

    sendJson(response, 404, { error: "not found" });
  } catch {
    // Store internals must not leak to clients.
    sendJson(response, 500, { error: "internal error" });
  }
}

function isAuthorized(request: IncomingMessage, authToken: string): boolean {
  const header = request.headers.authorization;
  if (header === undefined) {
    return false;
  }
  // Hash both sides so timingSafeEqual gets equal-length buffers and the comparison
  // leaks nothing about the token's length or content.
  const presented = createHash("sha256").update(header).digest();
  const expected = createHash("sha256").update(`Bearer ${authToken}`).digest();
  return timingSafeEqual(presented, expected);
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
  });
  response.end(text);
}

class BodyTooLargeError extends Error {}

function readBody(request: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const declared = Number(request.headers["content-length"]);
    if (Number.isFinite(declared) && declared > maxBytes) {
      reject(new BodyTooLargeError());
      return;
    }
    const chunks: Buffer[] = [];
    let received = 0;
    request.on("data", (chunk: Buffer) => {
      received += chunk.byteLength;
      if (received > maxBytes) {
        reject(new BodyTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
