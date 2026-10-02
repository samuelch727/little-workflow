import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A stand-in littleDB stack: the control plane's config-resolve and outcomes endpoints, and
 * the engine's trace ingest. Two real HTTP servers, so `@little-workflow/littledb`'s client
 * goes over the wire exactly as it would against the live stack — no fetch monkey-patching,
 * and the wire contract (`ResolveConfigResponseSchema` is zod-parsed with no fallback) is
 * genuinely exercised.
 *
 * What it makes checkable is the thing the demo most needs to be true and cannot see from
 * inside: that a `--gate` run sends NOTHING. The stub records every request, so a test can
 * assert zero outcomes and zero ingest calls rather than trusting a flag.
 *
 * The bootstrap prompt is echoed back as the resolved config's prompt, which is also how the
 * real control plane behaves on the first resolve for a harness+channel — so a test can prove
 * `SUPPORT_PROMPT_FILE` really is what the agent ran on.
 */

export type CapturedResolve = { harnessId: string; channel: string; bootstrapPrompt: string };
export type CapturedOutcome = { runId: string; status: string; detail?: string; metadata?: unknown };

export type StubLittleDb = {
  readonly controlPlaneUrl: string;
  readonly engineUrl: string;
  readonly resolves: CapturedResolve[];
  readonly outcomes: CapturedOutcome[];
  /** Trace-event envelopes the reporter pushed to the engine. */
  readonly ingests: unknown[];
  readonly evalRuns: unknown[];
  /** The config version handed out next. Bump it to simulate a promotion. */
  configVersionId: string;
  close(): Promise<void>;
};

async function listen(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ server: Server; url: string }> {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${port}` };
}

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
  const resolves: CapturedResolve[] = [];
  const outcomes: CapturedOutcome[] = [];
  const ingests: unknown[] = [];
  const evalRuns: unknown[] = [];
  const state = { configVersionId: "cfgv_001" };

  const engine = await listen((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/") {
        json(res, 200, { ok: true });
        return;
      }
      if (req.method === "POST" && url.pathname === "/ingest") {
        const body = await readBody(req);
        ingests.push(body);
        json(res, 200, { ok: true });
        return;
      }
      if (req.method === "POST" && url.pathname === "/harness/eval-runs") {
        evalRuns.push(await readBody(req));
        json(res, 200, { ok: true });
        return;
      }
      json(res, 404, { error: `unexpected engine request ${req.method} ${url.pathname}` });
    })();
  });

  const controlPlane = await listen((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/") {
        json(res, 200, { ok: true });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/config/resolve") {
        const body = (await readBody(req)) as {
          harnessId?: string;
          channel?: string;
          bootstrapConfig?: { prompt?: string };
        };
        resolves.push({
          harnessId: body.harnessId ?? "",
          channel: body.channel ?? "",
          bootstrapPrompt: body.bootstrapConfig?.prompt ?? "",
        });
        json(res, 200, {
          configVersionId: state.configVersionId,
          channel: body.channel ?? "production",
          staleConfig: false,
          config: {
            prompt: body.bootstrapConfig?.prompt ?? "",
            skills: [],
            toolManifest: null,
            modelSlot: "deepseek-v4-flash",
            sampling: {},
            hyperparams: {},
            memoryPolicy: null,
          },
        });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/outcomes") {
        outcomes.push((await readBody(req)) as CapturedOutcome);
        json(res, 200, { ok: true });
        return;
      }
      json(res, 404, { error: `unexpected control-plane request ${req.method} ${url.pathname}` });
    })();
  });

  return {
    controlPlaneUrl: controlPlane.url,
    engineUrl: engine.url,
    resolves,
    outcomes,
    ingests,
    evalRuns,
    get configVersionId() {
      return state.configVersionId;
    },
    set configVersionId(next: string) {
      state.configVersionId = next;
    },
    async close() {
      await Promise.all(
        [controlPlane.server, engine.server].map(
          (server) =>
            new Promise<void>((resolve) => {
              server.closeAllConnections?.();
              server.close(() => resolve());
            }),
        ),
      );
    },
  };
}
