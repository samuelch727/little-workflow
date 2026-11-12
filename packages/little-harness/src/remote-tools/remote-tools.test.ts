import { jsonSchema, type ToolExecutionOptions } from "ai";
import { createServer, request as httpRequest } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { listenRemoteTools } from "../server/remote-tools.js";
import { remoteTool, remoteToolHandler, remoteTools, RemoteToolError, serveRemoteTools, type RemoteToolCall } from "./index.js";
import { canonicalJson, digest } from "./protocol.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

const contract = remoteTool({ name: "lookup", description: "Look up an order", inputSchema: z.object({ id: z.string() }), outputSchema: z.object({ owner: z.string() }) });
const envelope = (extra = {}) => ({ v: 1, tool: "lookup", input: { id: "a" }, toolCallId: "call_0", invocationId: "occurrence-a", scope: "chat-a", sessionId: "chat", ...extra });
const request = (value: unknown = envelope(), headers: HeadersInit = {}) => new Request("https://tools.test", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(value) });
const auth = () => ({ id: "alice" });
const executeOptions = (extra = {}) => ({ toolCallId: "call_0", messages: [], context: undefined, ...extra }) as ToolExecutionOptions<unknown>;
const invoke = (tools: ReturnType<typeof remoteTools>, input = { id: "a" }, extra = {}) => (tools.lookup!.execute as Function)(input, executeOptions(extra));
const binding = (handler: (req: Request) => Promise<Response>) => ({ fetch: handler });

describe("remote tools", () => {
  it("freezes contracts, validates both construction boundaries, rejects duplicates and reserved names", () => {
    expect(Object.isFrozen(contract)).toBe(true);
    expect(() => remoteTool({ name: "x", description: "x", inputSchema: jsonSchema({ type: "object" }) })).toThrow(/validator/);
    expect(() => remoteTool({ name: "x", description: "x", inputSchema: { "~standard": { version: 1, vendor: "broken" } } as any })).toThrow(/validator/);
    expect(() => remoteTool({ ...contract, name: undefined as any })).toThrow(/invalid/);
    const forged = { ...contract, inputSchema: jsonSchema({ type: "object" }) };
    expect(() => serveRemoteTools({ tools: [remoteToolHandler(forged, () => ({}))], authenticate: auth })).toThrow(/validator/);
    expect(() => remoteTools([contract, contract], { endpoint: "https://x.test", scope: "s" })).toThrow(/Duplicate/);
    expect(() => serveRemoteTools({ tools: [], authenticate: undefined as any })).toThrow(/authenticate/);
    for (const name of ["bash", "checkpoint", "spawn_agent", "__proto__", "ask_person", "bad.name", "x".repeat(65)]) {
      expect(() => remoteTool({ ...contract, name })).toThrow(/reserved or invalid/);
    }
  });

  it("round trips validated input/output and separates verified principal from host context", async () => {
    const seen: unknown[] = [];
    const server = serveRemoteTools({ authenticate: req => req.headers.get("x-user-token") === "verified-alice" ? auth() : undefined,
      tools: [remoteToolHandler(contract, (input, ctx) => { seen.push({ input, ...ctx }); return { owner: ctx.principal.id }; })] });
    const tools = remoteTools([contract], { endpoint: binding(server), scope: "do-id", headers: call => ({ "x-user-token": "verified-alice", "x-call": call.toolCallId }), context: async call => ({ principal: { id: "mallory" }, scope: call.scope }) });
    expect(await invoke(tools)).toEqual({ owner: "alice" });
    expect(seen[0]).toMatchObject({ input: { id: "a" }, principal: { id: "alice" }, context: { principal: { id: "mallory" } }, call: { scope: "do-id", sessionId: "standalone", toolCallId: "call_0", dedupeKey: undefined } });
    expect((seen[0] as any).call).not.toHaveProperty("headers");
    expect((seen[0] as any).call).not.toHaveProperty("context");
  });

  it.each([
    { label: "Date", output: { owner: "alice", createdAt: new Date("2026-11-05T00:00:00.000Z") }, expected: { owner: "alice", createdAt: "2026-11-05T00:00:00.000Z" } },
    { label: "undefined properties", output: { owner: "alice", optional: undefined, nested: { omit: undefined, keep: true }, values: [undefined, 1] }, expected: { owner: "alice", nested: { keep: true }, values: [null, 1] } },
  ])("serializes database output with $label like JSON.stringify", async ({ output, expected }) => {
    const wireContract = remoteTool({ name: "lookup", description: "Database row", inputSchema: contract.inputSchema });
    const onError = vi.fn();
    const handler = serveRemoteTools({ authenticate: auth, onError, tools: [remoteToolHandler(wireContract, () => output)] });
    expect(await invoke(remoteTools([wireContract], { scope: "s", endpoint: binding(handler) }))).toEqual(expected);
    expect(onError).not.toHaveBeenCalled();
  });

  it("converts Date/toJSON before validating the output wire schema", async () => {
    const toJSON = vi.fn((key: string) => ({ owner: "alice", createdAt: new Date("2026-11-05T00:00:00.000Z"), optional: undefined, key }));
    class DatabaseRow { toJSON = toJSON; }
    const wireContract = remoteTool({ ...contract, outputSchema: z.strictObject({ owner: z.string(), createdAt: z.string().datetime(), key: z.literal("output") }) });
    const handler = serveRemoteTools({ authenticate: auth, tools: [remoteToolHandler(wireContract, (() => new DatabaseRow()) as any)] });
    expect(await invoke(remoteTools([wireContract], { scope: "s", endpoint: binding(handler) }))).toEqual({ owner: "alice", createdAt: "2026-11-05T00:00:00.000Z", key: "output" });
    expect(toJSON).toHaveBeenCalledExactlyOnceWith("output");
  });

  it.each([
    { label: "BigInt", value: 1n, reason: /BigInt/u },
    { label: "Infinity", value: Infinity, reason: /non-finite/u },
    { label: "NaN", value: NaN, reason: /non-finite/u },
    { label: "class without toJSON", value: new (class PrivateRow { owner = "private-row-value"; })(), reason: /class instances.*toJSON/u },
  ])("rejects unsupported output $label generically and reports its reason to server onError", async ({ value, reason }) => {
    const wireContract = remoteTool({ name: "lookup", description: "Database row", inputSchema: contract.inputSchema });
    const onError = vi.fn();
    const handler = serveRemoteTools({ authenticate: auth, onError, tools: [remoteToolHandler(wireContract, () => ({ private: "private-row-value", value }))] });
    await expect(invoke(remoteTools([wireContract], { scope: "s", endpoint: binding(handler) }))).rejects.toThrow("The tool failed.");
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]![0]).toBeInstanceOf(TypeError);
    expect(onError.mock.calls[0]![0].message).toMatch(reason);
    expect(onError.mock.calls[0]![0].message).not.toContain("private-row-value");
  });

  it("serializes client context/envelope with Date/toJSON and omitted undefined fields", async () => {
    let observed: unknown;
    let body = "";
    class Context { toJSON(key: string) { return { key, since: new Date("2026-11-05T00:00:00.000Z"), userId: undefined }; } }
    const handler = serveRemoteTools({ authenticate: auth, tools: [remoteToolHandler(contract, (_input, ctx) => { observed = ctx.context; return { owner: "alice" }; })] });
    const tools = remoteTools([contract], { scope: "s", context: () => new Context() as any, endpoint: { fetch: async req => {
      body = await req.clone().text();
      return handler(req);
    } } });
    expect(await invoke(tools)).toEqual({ owner: "alice" });
    expect(observed).toEqual({ key: "context", since: "2026-11-05T00:00:00.000Z" });
    expect(body).not.toContain("userId");
  });

  it("rejects an unsupported context before sending without exposing its private value", async () => {
    const fetch = vi.fn();
    const tools = remoteTools([contract], { scope: "s", endpoint: { fetch }, context: () => ({ private: "private-context-value", value: 1n }) as any });
    await expect(invoke(tools)).rejects.toThrow("The remote tool request could not be prepared. No call was sent.");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps canonical identity hashing strict and never invokes toJSON", async () => {
    const toJSON = vi.fn(() => ({ safe: true }));
    for (const value of [new Date(), { optional: undefined }, 1n, Infinity, { toJSON }]) {
      expect(() => canonicalJson(value)).toThrow();
      await expect(digest(value)).rejects.toThrow();
    }
    expect(toJSON).not.toHaveBeenCalled();
    expect(await digest({ b: 2, a: 1 })).toBe(await digest({ a: 1, b: 2 }));
  });

  it("wrong or throwing auth fails closed and another user's resource is refused", async () => {
    const run = vi.fn(() => ({ owner: "bob" }));
    for (const authenticate of [() => undefined, () => { throw new Error("auth-secret"); }]) {
      const handler = serveRemoteTools({ authenticate, tools: [remoteToolHandler(contract, run)], onError: () => { throw new Error("logger-secret"); } });
      expect((await handler(request())).status).toBe(401);
      await expect(invoke(remoteTools([contract], { endpoint: binding(handler), scope: "s" }))).rejects.toThrow("(401)");
    }
    expect(run).not.toHaveBeenCalled();
    const handler = serveRemoteTools({ authenticate: auth, tools: [remoteToolHandler(contract, (_input, ctx) => {
      if (ctx.principal.id !== "bob") throw new RemoteToolError("You cannot access that order.", "forbidden");
      return { owner: "bob" };
    })] });
    await expect(invoke(remoteTools([contract], { endpoint: binding(handler), scope: "s", context: { user: "bob" } }))).rejects.toThrow("You cannot access that order.");
  });

  it("validates async input and output and never executes invalid input", async () => {
    const execute = vi.fn(() => ({ owner: "alice" }));
    const server = serveRemoteTools({ authenticate: auth, tools: [remoteToolHandler(contract, execute)] });
    expect((await server(request(envelope({ input: { id: 1 } })))).status).toBe(400);
    expect(execute).not.toHaveBeenCalled();
    const asyncContract = remoteTool({ ...contract, inputSchema: z.object({ id: z.string().refine(async x => x === "a") }) });
    const asyncServer = serveRemoteTools({ authenticate: auth, tools: [remoteToolHandler(asyncContract, execute)] });
    expect((await asyncServer(request())).status).toBe(200);
    expect((await asyncServer(request(envelope({ input: { id: "wrong" } })))).status).toBe(400);
    const invalidOutput = serveRemoteTools({ authenticate: auth, tools: [remoteToolHandler(contract, (() => ({ owner: 12 })) as any)] });
    await expect(invoke(remoteTools([contract], { endpoint: binding(invalidOutput), scope: "s" }))).rejects.toThrow("The tool failed.");
    // A structurally supplied plain JSON validator is supported, including its transformed value.
    const schema = jsonSchema<{ id: string }>({ type: "object" }, { validate: async () => ({ success: true, value: { id: "a" } }) });
    const validated = serveRemoteTools({ authenticate: auth, tools: [remoteToolHandler(remoteTool({ ...contract, inputSchema: schema }), execute)] });
    expect((await validated(request(envelope({ input: null })))).status).toBe(200);
    expect(execute).toHaveBeenLastCalledWith({ id: "a" }, expect.anything());
  });

  it("exposes deliberate errors only; unexpected errors reach metadata-only diagnostics", async () => {
    const report = vi.fn();
    const handler = serveRemoteTools({ authenticate: auth, onError: report, tools: [remoteToolHandler(contract, () => { throw new Error("sk-secret-password"); })] });
    const result = await handler(request(envelope({ context: { token: "host-secret" } }), { authorization: "Bearer credential-secret" }));
    expect(await result.text()).toBe('{"ok":false,"error":{"message":"The tool failed."}}');
    expect(report).toHaveBeenCalledOnce();
    const call = report.mock.calls[0]![1];
    expect(JSON.stringify(call)).not.toMatch(/secret|headers|context|input":/);
    const handler2 = serveRemoteTools({ authenticate: auth, onError: () => { throw new Error("log-secret"); }, tools: [remoteToolHandler(contract, () => { throw new Error("secret"); })] });
    expect(await (await handler2(request())).json()).toMatchObject({ ok: false, error: { message: "The tool failed." } });
    expect(() => new RemoteToolError("x".repeat(501))).toThrow();
    expect(() => new RemoteToolError("safe", "BAD CODE")).toThrow();
  });

  it.each([
    [500, '{"error":"sk-secret"}', "application/json"], [200, "<html>sk-secret</html>", "text/html"],
    [200, "{broken sk-secret", "application/json"], [200, '{"ok":false,"error":{"message":"sk-secret","code":"INVALID"}}', "application/json"],
    [200, '{"ok":false,"error":{"message":"sk-secret","stack":"oops"}}', "application/json"],
  ])("redacts untrusted response %s/%s", async (status, body, contentType) => {
    const tools = remoteTools([contract], { scope: "s", endpoint: { fetch: () => new Response(body, { status, headers: { "content-type": contentType } }) } });
    await expect(invoke(tools)).rejects.toThrow(/remote tool/i);
    try { await invoke(tools); } catch (error) { expect(String(error)).not.toMatch(/sk-secret|broken|html|stack/); }
  });

  it("cancels a wrong-content-type body without reading it", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }), { headers: { "content-type": "text/html" } });
    const read = vi.spyOn(response.body!, "getReader");
    await expect(invoke(remoteTools([contract], { scope: "s", endpoint: { fetch: () => response } }))).rejects.toThrow("The remote tool call failed.");
    expect(cancel).toHaveBeenCalledOnce();
    expect(read).not.toHaveBeenCalled();
  });

  it("keeps a throwing client hook private and reports that no request was sent", async () => {
    const fetch = vi.fn();
    const tools = remoteTools([contract], { scope: "s", endpoint: { fetch }, headers: () => { throw new Error("private-hook-credential"); } });
    await expect(invoke(tools)).rejects.toThrow(/^The remote tool request could not be prepared\. No call was sent\.$/u);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("distinguishes a timeout during preparation from an uncertain sent call", async () => {
    const fetch = vi.fn();
    const tools = remoteTools([contract], { scope: "s", endpoint: { fetch }, timeoutMs: 10, headers: () => new Promise(() => {}) });
    await expect(invoke(tools)).rejects.toThrow("The remote tool timed out before sending. No call was sent.");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("checks method, content type, version, envelope and tool before execution", async () => {
    const execute = vi.fn();
    const handler = serveRemoteTools({ authenticate: auth, tools: [remoteToolHandler(contract, execute)] });
    expect((await handler(new Request("https://tools.test"))).status).toBe(405);
    expect((await handler(new Request("https://tools.test", { method: "POST", body: "{}" }))).status).toBe(415);
    expect((await handler(request(envelope({ v: 2 })))).status).toBe(409);
    expect((await handler(request(envelope({ injected: true })))).status).toBe(400);
    expect((await handler(request(envelope({ tool: "missing" })))).status).toBe(404);
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([true, false])("bounds actual chunked request and response bytes (Content-Length %s)", async declared => {
    const stream = (text: string) => new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode(text.slice(0, 10))); c.enqueue(new TextEncoder().encode(text.slice(10))); c.close(); } });
    const execute = vi.fn();
    const server = serveRemoteTools({ authenticate: auth, maxRequestBytes: 20, tools: [remoteToolHandler(contract, execute)] });
    const req = new Request("https://tools.test", { method: "POST", headers: { "content-type": "application/json", ...(declared ? { "content-length": "100" } : {}) }, body: stream(" ".repeat(100)), duplex: "half" } as RequestInit);
    expect((await server(req)).status).toBe(413);
    expect(execute).not.toHaveBeenCalled();
    const tools = remoteTools([contract], { scope: "s", maxResponseBytes: 20, endpoint: { fetch: () => new Response(stream("sk-secret".repeat(100)), { headers: { "content-type": "application/json", ...(declared ? { "content-length": "900" } : {}) } }) } });
    await expect(invoke(tools)).rejects.toThrow("The remote tool call failed.");
    const fetch = vi.fn();
    await expect(invoke(remoteTools([contract], { scope: "s", maxRequestBytes: 20, endpoint: { fetch } }))).rejects.toThrow("too large");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses nonloopback plaintext and credentials embedded in a URL", () => {
    expect(() => remoteTools([contract], { scope: "s", endpoint: "http://example.com" })).toThrow(/HTTPS/);
    expect(() => remoteTools([contract], { scope: "s", endpoint: "https://user:pass@example.com" })).toThrow();
  });

  it("refuses every 3xx in memory without reading headers/body, following or retrying", async () => {
    for (let status = 300; status < 400; status += 1) {
      const destination = vi.fn();
      const readHeaders = vi.fn(() => { throw new Error("Redirect headers must stay unread."); });
      const readBody = vi.fn(() => { throw new Error("Redirect body must stay unread."); });
      const fetch = vi.fn(async (req: Request) => {
        if (req.url.endsWith("/destination")) destination({ headers: req.headers, body: await req.text() });
        expect(req.redirect).toBe("manual");
        expect(req.headers.get("authorization")).toBe("Bearer memory-service-proof");
        expect(req.headers.get("x-user-token")).toBe("memory-user-proof");
        expect(JSON.parse(await req.text()).input).toEqual({ id: "private-memory-write-body" });
        return Object.defineProperties({}, {
          status: { value: status }, type: { value: "basic" },
          headers: { get: readHeaders }, body: { get: readBody },
        }) as Response;
      });
      const tools = remoteTools([contract], { scope: "s", endpoint: { fetch },
        headers: { authorization: "Bearer memory-service-proof", "x-user-token": "memory-user-proof" },
      });
      await expect(invoke(tools, { id: "private-memory-write-body" })).rejects.toThrow(`The remote tool server refused the call (${status}).`);
      expect(fetch).toHaveBeenCalledOnce();
      expect(destination).not.toHaveBeenCalled();
      expect(readHeaders).not.toHaveBeenCalled();
      expect(readBody).not.toHaveBeenCalled();
    }
  });

  it.each([0, 200])("refuses opaqueredirect before reading headers/body (status %s)", async status => {
    const readHeaders = vi.fn(() => { throw new Error("Opaque redirect headers must stay unread."); });
    const readBody = vi.fn(() => { throw new Error("Opaque redirect body must stay unread."); });
    const fetch = vi.fn((req: Request) => {
      expect(req.redirect).toBe("manual");
      return Object.defineProperties({}, {
        status: { value: status }, type: { value: "opaqueredirect" },
        headers: { get: readHeaders }, body: { get: readBody },
      }) as Response;
    });
    await expect(invoke(remoteTools([contract], { scope: "s", endpoint: { fetch } }))).rejects.toThrow(`The remote tool server refused the call (${status}).`);
    expect(fetch).toHaveBeenCalledOnce();
    expect(readHeaders).not.toHaveBeenCalled();
    expect(readBody).not.toHaveBeenCalled();
  });

  it("Node refuses real redirects without forwarding any request, credentials or body", async () => {
    const targetRequests: unknown[] = [];
    const initialRequests: { status: number; authorization: string | undefined; userToken: string | string[] | undefined; body: string; method: string | undefined }[] = [];
    const target = createServer(async (req, res) => {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      targetRequests.push({ headers: req.headers, body: Buffer.concat(chunks).toString() });
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true,"output":{"owner":"unexpected-destination"}}');
    });
    await new Promise<void>(resolve => target.listen(0, "127.0.0.1", resolve));
    const targetPort = (target.address() as { port: number }).port;
    const server = createServer(async (req, res) => {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const status = Number(req.url!.slice(1));
      initialRequests.push({ status, authorization: req.headers.authorization, userToken: req.headers["x-user-token"], body: Buffer.concat(chunks).toString(), method: req.method });
      res.writeHead(status, { location: `http://127.0.0.1:${targetPort}/destination` });
      res.end("private-redirect-response-body");
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as { port: number }).port;
      for (const status of [300, 301, 302, 303, 304, 305, 306, 307, 308, 399]) {
        const tools = remoteTools([contract], { scope: "s", endpoint: `http://127.0.0.1:${port}/${status}`,
          headers: { authorization: "Bearer node-service-proof", "x-user-token": "node-user-proof" },
        });
        await expect(invoke(tools, { id: "private-node-write-body" })).rejects.toThrow(`The remote tool server refused the call (${status}).`);
      }
      expect(initialRequests).toHaveLength(10);
      for (const req of initialRequests) {
        expect(req.method).toBe("POST");
        expect(req.authorization).toBe("Bearer node-service-proof");
        expect(req.userToken).toBe("node-user-proof");
        expect(JSON.parse(req.body).input).toEqual({ id: "private-node-write-body" });
      }
      expect(targetRequests).toEqual([]);
    } finally {
      server.closeAllConnections(); target.closeAllConnections();
      await Promise.all([new Promise<void>(resolve => server.close(() => resolve())), new Promise<void>(resolve => target.close(() => resolve()))]);
    }
  });

  it("derives versioned principal/scope/session/tool/kind identities and a canonical validated-input digest", async () => {
    const calls: RemoteToolCall[] = [];
    const second = remoteTool({ ...contract, name: "lookup2" });
    let principal = "alice";
    const handler = serveRemoteTools({ authenticate: () => ({ id: principal }), tools: [contract, second].map(c => remoteToolHandler(c, (_input, ctx) => { calls.push(ctx.call); return { owner: principal }; })) });
    for (const extra of [{}, {}, { invocationId: "turn-2" }, { scope: "chat-b" }, { tool: "lookup2" }, { sessionId: "other" }, { invocationId: undefined, idempotencyKey: "occurrence-a" }, { invocationId: undefined, idempotencyKey: undefined }]) {
      expect((await handler(request(envelope(extra)))).status).toBe(200);
    }
    principal = "bob";
    await handler(request());
    expect(calls[0]!.dedupeKey).toBe(calls[1]!.dedupeKey);
    expect(calls[0]!.dedupeKey).toBe(await digest(["lh.remote-tool.dedupe.v1", "invocation", "alice", "chat-a", "chat", "lookup", "occurrence-a"]));
    expect(new Set(calls.filter((_, i) => i !== 1 && i !== 7).map(c => c.dedupeKey)).size).toBe(7);
    expect(calls[7]!.dedupeKey).toBeUndefined();
    expect(calls[0]!.inputDigest).toBe(await digest({ id: "a" }));
    expect(await digest({ b: 2, a: 1 })).toBe(await digest({ a: 1, b: 2 }));
  });

  it("a write store rejects reuse of a dedupe key with a different digest", async () => {
    const writes = new Map<string, string>();
    const handler = serveRemoteTools({ authenticate: auth, tools: [remoteToolHandler(contract, (_input, { call }) => {
      const key = call.dedupeKey;
      if (!key) throw new RemoteToolError("Provide a business key.");
      if (writes.has(key) && writes.get(key) !== call.inputDigest) throw new RemoteToolError("Idempotency input mismatch.");
      writes.set(key, call.inputDigest);
      return { owner: "alice" };
    })] });
    expect(await (await handler(request())).json()).toMatchObject({ ok: true });
    expect(await (await handler(request())).json()).toMatchObject({ ok: true });
    expect(writes.size).toBe(1);
    expect(await (await handler(request(envelope({ input: { id: "b" } })))).json()).toMatchObject({ ok: false, error: { message: "Idempotency input mismatch." } });
  });

  it("times out even an uncooperative binding, states uncertainty, and preserves a terminal turn abort", async () => {
    const endpoint = { fetch: () => new Promise<Response>(() => {}) };
    await expect(invoke(remoteTools([contract], { scope: "s", endpoint, timeoutMs: 10 }))).rejects.toThrow("may or may not have run");
    const controller = new AbortController();
    const reason = new Error("terminal-turn-abort");
    const result = invoke(remoteTools([contract], { scope: "s", endpoint }), { id: "a" }, { abortSignal: controller.signal });
    controller.abort(reason);
    await expect(result).rejects.toBe(reason);
  });

  it("the portable export reaches no Node runtime module", async () => {
    const seen = new Set<string>();
    async function visit(file: string): Promise<void> {
      if (seen.has(file)) return;
      seen.add(file);
      const source = await readFile(file, "utf8");
      // Type-only imports are erased. Bare ai is validated again by real-workerd demo tests.
      for (const match of source.matchAll(/(?:import|export)\s+(?!type\b)[^;]*?from\s+["']([^"']+)["']/gu)) {
        expect(match[1]).not.toMatch(/^node:/);
        if (match[1]!.startsWith(".")) await visit(resolve(dirname(file), match[1]!.replace(/\.js$/u, ".ts")));
      }
    }
    await visit(fileURLToPath(new URL("./index.ts", import.meta.url)));
    expect(seen.size).toBeGreaterThanOrEqual(5);
  });
});

describe("Node remote tools listener cancellation", () => {
  it("round trips database Date/undefined values over Node and reports refused BigInt privately", async () => {
    const wireContract = remoteTool({ name: "lookup", description: "Database row", inputSchema: contract.inputSchema });
    const onError = vi.fn();
    const listener = await listenRemoteTools({ port: 0, authenticate: auth, onError, tools: [remoteToolHandler(wireContract, ({ id }) => ({
      owner: "alice", createdAt: new Date("2026-11-05T00:00:00.000Z"), optional: undefined,
      ...(id === "bigint" ? { count: 1n } : {}),
    }))] });
    try {
      const tools = remoteTools([wireContract], { scope: "s", endpoint: listener.url });
      expect(await invoke(tools)).toEqual({ owner: "alice", createdAt: "2026-11-05T00:00:00.000Z" });
      expect(onError).not.toHaveBeenCalled();
      await expect(invoke(tools, { id: "bigint" })).rejects.toThrow("The tool failed.");
      expect(onError).toHaveBeenCalledOnce();
      expect(onError.mock.calls[0]![0].message).toMatch(/BigInt/u);
    } finally { await listener.close(); }
  });

  it("a full POST with a delayed handler and a normally completed response never aborts", async () => {
    let signal: AbortSignal | undefined;
    const listener = await listenRemoteTools({ port: 0, authenticate: auth, tools: [remoteToolHandler(contract, async (_input, ctx) => {
      signal = ctx.signal;
      await new Promise(resolve => setTimeout(resolve, 40));
      expect(ctx.signal.aborted).toBe(false);
      return { owner: "alice" };
    })] });
    try {
      const result = await fetch(listener.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(envelope()) });
      expect(await result.json()).toMatchObject({ ok: true });
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(signal?.aborted).toBe(false);
    } finally { await listener.close(); }
  });

  it("ordinary response completion removes cancellation listeners without firing an abort", async () => {
    let signal: AbortSignal | undefined;
    let response: import("node:http").ServerResponse | undefined;
    const listener = await listenRemoteTools({ port: 0, authenticate: auth, tools: [remoteToolHandler(contract, (_input, ctx) => {
      signal = ctx.signal;
      return { owner: "alice" };
    })] });
    listener.server.on("request", (_req, res) => { response = res; });
    try {
      const result = await fetch(listener.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(envelope()) });
      expect(await result.json()).toMatchObject({ ok: true });
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(signal?.aborted).toBe(false);
      expect(response?.listeners("close")).toHaveLength(0);
    } finally { await listener.close(); }
  });

  it("disconnect after upload aborts execute cooperatively", async () => {
    const started = deferred<AbortSignal>();
    const aborted = deferred<void>();
    const listener = await listenRemoteTools({ port: 0, authenticate: auth, tools: [remoteToolHandler(contract, async (_input, { signal }) => {
      started.resolve(signal);
      await new Promise<void>(resolve => signal.addEventListener("abort", () => { aborted.resolve(); resolve(); }, { once: true }));
      return { owner: "alice" };
    })] });
    try {
      const req = httpRequest(listener.url, { method: "POST", headers: { "content-type": "application/json" } });
      req.on("error", () => undefined);
      req.end(JSON.stringify(envelope()));
      const signal = await started.promise;
      expect(signal.aborted).toBe(false);
      req.destroy();
      await aborted.promise;
      expect(signal.aborted).toBe(true);
    } finally { await listener.close(); }
  });

  it("a truncated upload never authenticates or runs a tool and does not poison the next request", async () => {
    const abort = vi.spyOn(AbortController.prototype, "abort");
    const authenticate = vi.fn(auth);
    const execute = vi.fn(() => ({ owner: "alice" }));
    const listener = await listenRemoteTools({ port: 0, authenticate, tools: [remoteToolHandler(contract, execute)] });
    try {
      const req = httpRequest(listener.url, { method: "POST", headers: { "content-type": "application/json", "content-length": "10000" } });
      req.on("error", () => undefined);
      req.write('{"v":1,');
      await new Promise(resolve => setTimeout(resolve, 20));
      req.destroy();
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(authenticate).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
      // No execute signal can be observed before a complete validated envelope. Observe the
      // adapter's actual abort instead: the truncated request must cancel before auth/effects.
      expect(abort.mock.calls.some(([reason]) => reason instanceof DOMException && reason.message === "Client disconnected")).toBe(true);
      const response = await fetch(listener.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(envelope()) });
      expect(await response.json()).toMatchObject({ ok: true });
    } finally { abort.mockRestore(); await listener.close(); }
  });
});
