import { createServer, type ServerResponse, type IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { serveRemoteTools, type RemoteToolPrincipal, type ServeRemoteToolsOptions } from "../remote-tools/server.js";

export type ListenRemoteToolsOptions<P extends RemoteToolPrincipal = RemoteToolPrincipal> = ServeRemoteToolsOptions<P> & {
  port: number;
  host?: string;
};

/** Plain Node listener. Cancellation follows the outgoing response and incomplete uploads. */
export async function listenRemoteTools<P extends RemoteToolPrincipal>(options: ListenRemoteToolsOptions<P>) {
  const handler = serveRemoteTools(options);
  const server = createServer((req, res) => { void respond(req, res, handler); });
  const host = options.host ?? "127.0.0.1";
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, host, () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Remote tool listener has no TCP address.");
  const hostname = host.includes(":") ? `[${host}]` : host;
  return {
    server,
    url: `http://${hostname}:${address.port}`,
    port: address.port,
    close: () => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeIdleConnections(); }),
  };
}

async function respond(req: IncomingMessage, res: ServerResponse, handler: (request: Request) => Promise<Response>): Promise<void> {
  const controller = new AbortController();
  const abort = () => controller.abort(new DOMException("Client disconnected", "AbortError"));
  const responseClosed = () => { if (!res.writableFinished) abort(); };
  const requestClosed = () => { if (!req.complete) abort(); };
  const cleanup = () => {
    res.off("close", responseClosed);
    req.off("close", requestClosed);
    res.off("finish", cleanup);
  };
  res.on("close", responseClosed);
  req.on("close", requestClosed);
  res.once("finish", cleanup);
  try {
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (Array.isArray(value)) for (const entry of value) headers.append(name, entry);
      else if (value !== undefined) headers.set(name, value);
    }
    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    const request = new Request(`http://localhost${req.url?.startsWith("/") ? req.url : "/"}`, {
      method: req.method ?? "GET", headers, signal: controller.signal,
      ...(hasBody ? { body: Readable.toWeb(req) as ReadableStream<Uint8Array>, duplex: "half" as const } : {}),
    });
    const response = await handler(request);
    if (res.destroyed) return;
    res.writeHead(response.status, Object.fromEntries(response.headers));
    // Response lifetime remains observable through end/finish. No generic agent-server adapter.
    res.end(new Uint8Array(await response.arrayBuffer()));
    if (!res.writableFinished && !res.destroyed) {
      await new Promise<void>(resolve => { res.once("finish", resolve); res.once("close", resolve); });
    }
  } catch {
    if (!res.destroyed && !res.headersSent) res.writeHead(500, { "content-type": "application/json" });
    if (!res.destroyed) res.end('{"ok":false,"error":{"message":"The tool failed."}}');
  } finally { cleanup(); }
}
