import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A stand-in LittleDB: the `/v1` endpoints the demo uses, on a real HTTP server, so
 * `@little-stack/littledb` goes over the wire exactly as it would against the real thing.
 *
 * What it makes checkable is the thing the demo most needs to be true and cannot see from
 * inside: that a `--gate` run sends NOTHING. The stub records every request, so a test can
 * assert zero ingest calls rather than trusting a flag.
 *
 * The bootstrap is echoed back as the resolved content, which is also how LittleDB behaves
 * on the first resolve for a harness, so a test can prove `SUPPORT_PROMPT_FILE` really is
 * what the agent ran on.
 */

export const STUB_API_KEY = "ldb_stub_key";

export type CapturedResolve = { slug: string; channel: string; stickyKey?: string; bootstrapSystem: string };
export type CapturedScore = { traceId: string; name: string; value?: number; comment?: string; source?: string };
export type ClaimedRun = Record<string, unknown> & { runId: string; traceId: string };

export type StubLittleDb = {
  readonly url: string;
  readonly resolves: CapturedResolve[];
  /** Ingest bodies, as sent. */
  readonly ingests: Array<{ traces?: Array<Record<string, unknown>>; spans?: Array<Record<string, unknown>>; scores?: CapturedScore[] }>;
  readonly scores: CapturedScore[];
  readonly datasets: Array<{ id: string; name: string; subject?: string }>;
  readonly items: Array<{ datasetId: string; input: unknown; expected?: unknown; metadata?: Record<string, unknown>; split?: string }>;
  readonly proposals: Array<Record<string, unknown>>;
  /** Runs the next claim hands out. */
  readonly pendingRuns: ClaimedRun[];
  readonly completions: Array<{ runId: string; body: Record<string, unknown> }>;
  /** Requests without the right API key. */
  readonly unauthorized: string[];
  close(): Promise<void>;
};

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw.length === 0 ? {} : (JSON.parse(raw) as Record<string, unknown>);
}

export async function startStubLittleDb(): Promise<StubLittleDb> {
  const state: Omit<StubLittleDb, "url" | "close"> = {
    resolves: [],
    ingests: [],
    scores: [],
    datasets: [],
    items: [],
    proposals: [],
    pendingRuns: [],
    completions: [],
    unauthorized: [],
  };

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const path = url.pathname;
      if (req.method === "GET" && path === "/healthz") return json(res, 200, { ok: true });
      if (req.headers.authorization !== `Bearer ${STUB_API_KEY}`) {
        state.unauthorized.push(`${req.method} ${path}`);
        return json(res, 401, { error: { code: "unauthorized", message: "Bad API key." } });
      }
      const body = req.method === "GET" ? {} : await readBody(req);

      if (req.method === "POST" && path === "/v1/resolve") {
        const bootstrap = (body.bootstrap ?? {}) as { system?: string; model?: string };
        state.resolves.push({
          slug: String(body.slug),
          channel: String(body.channel ?? "production"),
          ...(typeof body.stickyKey === "string" ? { stickyKey: body.stickyKey } : {}),
          bootstrapSystem: bootstrap.system ?? "",
        });
        return json(res, 200, {
          subjectId: `sub_${String(body.slug)}`,
          versionId: "ver_001",
          number: 1,
          status: "live",
          mode: "live",
          content: { system: bootstrap.system ?? "", model: bootstrap.model ?? "deepseek-v4-flash" },
          channel: body.channel ?? "production",
        });
      }
      if (req.method === "POST" && path === "/v1/ingest") {
        state.ingests.push(body as StubLittleDb["ingests"][number]);
        state.scores.push(...(((body.scores as CapturedScore[] | undefined) ?? [])));
        return json(res, 200, { ok: true });
      }
      if (req.method === "GET" && path === "/v1/datasets") return json(res, 200, { datasets: state.datasets });
      if (req.method === "POST" && path === "/v1/datasets") {
        const dataset = { id: `dst_${state.datasets.length + 1}`, name: String(body.name), ...(typeof body.subject === "string" ? { subject: body.subject } : {}) };
        state.datasets.push(dataset);
        return json(res, 201, { dataset });
      }
      const items = /^\/v1\/datasets\/([^/]+)\/items$/u.exec(path);
      if (req.method === "POST" && items !== null) {
        const added = (body.items as StubLittleDb["items"]).map((item) => ({ ...item, datasetId: items[1]! }));
        state.items.push(...added);
        return json(res, 201, { added: added.length, ids: added.map((_, i) => `itm_${i}`), holdout: added.filter((i) => i.split === "holdout").length });
      }
      if (req.method === "POST" && path === "/v1/proposals") {
        state.proposals.push(body);
        return json(res, 201, { proposal: { id: "prp_1", status: "open", kind: "prompt", risk: "low", candidateVersionId: "ver_002" } });
      }
      if (req.method === "POST" && path === "/v1/worker/claim") {
        return json(res, 200, { runs: state.pendingRuns.splice(0, Number(body.limit ?? 4)) });
      }
      const complete = /^\/v1\/worker\/runs\/([^/]+)\/complete$/u.exec(path);
      if (req.method === "POST" && complete !== null) {
        state.completions.push({ runId: complete[1]!, body });
        return json(res, 200, { run: { id: complete[1], status: body.error === undefined ? "done" : "pending" } });
      }
      if (req.method === "POST" && /^\/v1\/worker\/runs\/[^/]+\/heartbeat$/u.test(path)) return json(res, 200, { ok: true });
      return json(res, 404, { error: { code: "not_found", message: `unexpected request ${req.method} ${path}` } });
    })().catch((error: unknown) => json(res, 500, { error: { code: "internal", message: String(error) } }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;

  return {
    ...state,
    url: `http://127.0.0.1:${port}`,
    async close() {
      await new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
    },
  };
}
