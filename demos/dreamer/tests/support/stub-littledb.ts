import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

/**
 * A stand-in for the LIT-52 littleDB seam: the control plane's evidence-pack and proposals
 * endpoints, and the engine's run store. Two real HTTP servers, so the agent's tools go over
 * the wire exactly as they would against the live stack — no fetch monkey-patching.
 *
 * The proposal endpoint implements the part of the contract the dreamer has to survive: it
 * re-reads every cited run and checks the quoted `pushback` against the real transcript,
 * answering 422 with `{error, unverifiedClaim: {runId, pushback}}` when a quote is not there.
 */

export const HARNESS_SLUG = "kb-librarian";
export const PRODUCTION_CONFIG_VERSION = "cfgv_002";

/** The two verbatim user turns a correct investigation ends up citing. */
export const QUOTE_CITE_1 = "where does that number come from?";
export const QUOTE_CITE_2 = "you didn't say which document that's from";
export const QUOTE_PARTIAL = "that's only half the answer — what about carry-over?";
/** The pushback at the very END of a transcript long enough to be truncated. */
export const QUOTE_LONG_TAIL = "none of that answered which document says so";

const BASE_PROMPT = [
  "You are the Librarian, the knowledge-base assistant for Northwind Systems.",
  "",
  "The company knowledge base lives at `/persistent/knowledge`.",
  "Answer from what those documents actually say. Be brief.",
].join("\n");

type StubRun = {
  readonly runId: string;
  readonly startedAt: string;
  readonly engineStatus: string | null;
  readonly configVersionId: string;
  readonly outcome: { status: string; source: string; quote?: string } | null;
  readonly pushbackQuote?: string;
  readonly answerBeforePushback?: string;
  /** The engine-side transcript. `JSON.stringify` of this is what a citation is checked against. */
  readonly events: unknown[];
};

function turn(userText: string, assistantText: string): unknown[] {
  return [
    { type: "harness.model.called", payload: { messages: [{ role: "user", content: userText }] } },
    { type: "harness.model.responded", payload: { response: { text: assistantText } } },
  ];
}

export const STUB_RUNS: readonly StubRun[] = [
  {
    runId: "run_cite_1",
    startedAt: "2026-08-11T09:00:00.000Z",
    engineStatus: "completed",
    configVersionId: PRODUCTION_CONFIG_VERSION,
    outcome: { status: "failure", source: "inferred", quote: QUOTE_CITE_1 },
    pushbackQuote: QUOTE_CITE_1,
    answerBeforePushback: "You get 20 vacation days a year.",
    events: [
      ...turn("how many vacation days do I get?", "You get 20 vacation days a year."),
      ...turn(QUOTE_CITE_1, "Sorry — that is from vacation-policy.md."),
    ],
  },
  {
    runId: "run_cite_2",
    startedAt: "2026-08-11T09:10:00.000Z",
    engineStatus: "completed",
    configVersionId: PRODUCTION_CONFIG_VERSION,
    outcome: { status: "failure", source: "inferred", quote: QUOTE_CITE_2 },
    pushbackQuote: QUOTE_CITE_2,
    answerBeforePushback: "Carry-over is capped at 5 days.",
    events: [
      ...turn("can I carry vacation days over?", "Carry-over is capped at 5 days."),
      ...turn(QUOTE_CITE_2, "It is in vacation-policy.md."),
    ],
  },
  {
    runId: "run_cite_3",
    startedAt: "2026-08-11T09:20:00.000Z",
    engineStatus: "completed",
    configVersionId: PRODUCTION_CONFIG_VERSION,
    // Explicit failure with NO pushback quote: the outcome was reported, not inferred.
    outcome: { status: "failure", source: "explicit" },
    events: turn("what is the parental leave policy?", "Parental leave is 12 weeks."),
  },
  {
    runId: "run_partial_1",
    startedAt: "2026-08-11T09:30:00.000Z",
    engineStatus: "completed",
    configVersionId: PRODUCTION_CONFIG_VERSION,
    outcome: { status: "partial", source: "inferred", quote: QUOTE_PARTIAL },
    pushbackQuote: QUOTE_PARTIAL,
    answerBeforePushback: "You accrue 20 days a year.",
    events: [
      ...turn("tell me about vacation", "You accrue 20 days a year."),
      ...turn(QUOTE_PARTIAL, "Carry-over is capped at 5 days."),
    ],
  },
  {
    runId: "run_ok_1",
    startedAt: "2026-08-11T09:40:00.000Z",
    engineStatus: "completed",
    configVersionId: PRODUCTION_CONFIG_VERSION,
    outcome: { status: "success", source: "explicit" },
    events: turn("who do I email about laptops?", "security@northwind.example.\nSource: it-policy.md"),
  },
  {
    runId: "run_ok_2",
    startedAt: "2026-08-11T09:50:00.000Z",
    engineStatus: "completed",
    configVersionId: "cfgv_001",
    outcome: { status: "success", source: "explicit" },
    events: turn("what is the expense limit?", "250 USD.\nSource: expenses.md"),
  },
  {
    // A long thread: its event log is far past `littledb_load_run`'s character budget, and
    // the pushback that has to be citable is the LAST thing in it.
    runId: "run_long_1",
    startedAt: "2026-08-11T09:55:00.000Z",
    engineStatus: "completed",
    configVersionId: PRODUCTION_CONFIG_VERSION,
    outcome: { status: "failure", source: "inferred", quote: QUOTE_LONG_TAIL },
    pushbackQuote: QUOTE_LONG_TAIL,
    answerBeforePushback: "The limit is 250 USD.",
    events: [
      ...Array.from({ length: 60 }, (_unused, n) =>
        turn(
          `filler question ${n} ${"x".repeat(200)}`,
          `filler answer ${n} ${"y".repeat(200)}`,
        )).flat(),
      ...turn(QUOTE_LONG_TAIL, "It is in expenses.md."),
    ],
  },
  {
    runId: "run_unlabelled",
    startedAt: "2026-08-11T10:00:00.000Z",
    engineStatus: "completed",
    configVersionId: PRODUCTION_CONFIG_VERSION,
    // Nothing observed this run. Not evidence of anything.
    outcome: null,
    events: turn("is the office open on Friday?", "Yes."),
  },
];

export function evidencePackFixture(engineUrl: string): unknown {
  return {
    harness: { slug: HARNESS_SLUG, productionConfigVersionId: PRODUCTION_CONFIG_VERSION },
    baseConfig: {
      prompt: BASE_PROMPT,
      skills: [],
      toolManifest: null,
      modelSlot: "deepseek-v4-flash",
      sampling: {},
      hyperparams: {},
      memoryPolicy: null,
    },
    metrics: [
      // Kept consistent with STUB_RUNS: 7 runs on the production version, 6 of them
      // carrying an outcome (run_unlabelled carries none), 1 of those a success.
      {
        configVersionId: PRODUCTION_CONFIG_VERSION,
        runCount: 7,
        withOutcome: 6,
        successRate: 1 / 6,
        explicitOutcomes: 2,
        inferredOutcomes: 4,
      },
      {
        configVersionId: "cfgv_001",
        runCount: 1,
        withOutcome: 1,
        successRate: 1,
        explicitOutcomes: 1,
        inferredOutcomes: 0,
      },
    ],
    runs: STUB_RUNS.map(({ events: _events, ...run }) => run),
    engineUrl,
  };
}

export type CapturedProposal = {
  readonly slug: string;
  readonly body: Record<string, unknown>;
  readonly status: number;
};

export type StubLittleDb = {
  readonly controlPlaneUrl: string;
  readonly engineUrl: string;
  /** Every POST /proposals the servers saw, in order, with the status they answered. */
  readonly proposals: CapturedProposal[];
  /** Every GET /runs/:id the engine served, in order. */
  readonly runReads: string[];
  close(): Promise<void>;
};

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{
  server: Server;
  url: string;
}> {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${port}` };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(text);
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw.length === 0 ? {} : (JSON.parse(raw) as Record<string, unknown>);
}

type FailureSample = { runId?: unknown; pushback?: unknown };

/**
 * The mechanical verification the real control plane performs: the quoted `pushback` has to
 * appear, character for character, in the cited run's transcript.
 */
export function verifyClaims(
  samples: readonly FailureSample[],
): { runId: string; pushback: string } | undefined {
  for (const sample of samples) {
    if (typeof sample.runId !== "string" || typeof sample.pushback !== "string") continue;
    const run = STUB_RUNS.find((candidate) => candidate.runId === sample.runId);
    const transcript = run === undefined ? "" : JSON.stringify(run.events);
    if (!transcript.includes(sample.pushback)) {
      return { runId: sample.runId, pushback: sample.pushback };
    }
  }
  return undefined;
}

export async function startStubLittleDb(): Promise<StubLittleDb> {
  const proposals: CapturedProposal[] = [];
  const runReads: string[] = [];

  const engine = await listen((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const match = /^\/runs\/([^/]+)$/.exec(url.pathname);
    if (req.method === "GET" && match) {
      const runId = decodeURIComponent(match[1] ?? "");
      runReads.push(runId);
      const run = STUB_RUNS.find((candidate) => candidate.runId === runId);
      if (run === undefined) {
        json(res, 404, { error: "not found" });
        return;
      }
      json(res, 200, {
        summary: {
          run_id: run.runId,
          status: run.engineStatus,
          started_at: run.startedAt,
        },
        events: run.events,
      });
      return;
    }
    json(res, 404, { error: `unexpected engine request ${req.method} ${url.pathname}` });
  });

  const controlPlane = await listen((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const packMatch = /^\/api\/harnesses\/([^/]+)\/evidence-pack$/.exec(url.pathname);
      if (req.method === "GET" && packMatch) {
        const slug = decodeURIComponent(packMatch[1] ?? "");
        if (slug !== HARNESS_SLUG) {
          json(res, 404, { error: "unknown harness" });
          return;
        }
        json(res, 200, evidencePackFixture(engine.url));
        return;
      }

      const proposalMatch = /^\/api\/harnesses\/([^/]+)\/proposals$/.exec(url.pathname);
      if (req.method === "POST" && proposalMatch) {
        const slug = decodeURIComponent(proposalMatch[1] ?? "");
        const body = await readBody(req);
        const evidence = (body.evidence ?? {}) as { failureSamples?: unknown };
        const samples = Array.isArray(evidence.failureSamples) ? evidence.failureSamples : [];

        const unverified = verifyClaims(samples as FailureSample[]);
        if (unverified !== undefined) {
          proposals.push({ slug, body, status: 422 });
          json(res, 422, {
            error: "A quoted claim could not be verified against the cited run.",
            unverifiedClaim: unverified,
          });
          return;
        }

        proposals.push({ slug, body, status: 201 });
        json(res, 201, { proposalId: `cpr_stub_${proposals.length}`, status: "open" });
        return;
      }

      json(res, 404, { error: `unexpected control-plane request ${req.method} ${url.pathname}` });
    })();
  });

  return {
    controlPlaneUrl: controlPlane.url,
    engineUrl: engine.url,
    proposals,
    runReads,
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
