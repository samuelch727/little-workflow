import type { IngestBatch, ScoreSource } from "./contract.js";
import { createExporter, type ExporterStats, type LittleDBErrorHandler } from "./exporter.js";
import {
  createFeedbackApi,
  createFeedbackHandler,
  type FeedbackHandlerOptions,
  type FeedbackInput,
  type FeedbackResult,
  type FeedbackRetracted,
  type RetractFeedbackOptions,
} from "./feedback.js";
import { createOutcomeSink, type LittleDBOutcomeSink, type OutcomeSinkOptions } from "./harness/outcome-sink.js";
import {
  createHarnessTracer,
  createTurnTraceIds,
  type HarnessTracer,
  type HarnessTracerOptions,
} from "./harness/tracer.js";
import {
  createAgentWorkflowRegistry,
  type AgentWorkflowRegistryOptions,
  type LittleDBAgentWorkflowRegistry,
} from "./harness/registry.js";
import { createTransport } from "./http.js";
import {
  createManagedHarness,
  createManagedWorkflow,
  type ManagedHarness,
  type ManagedHarnessOptions,
  type ManagedWorkflow,
  type ManagedWorkflowOptions,
  type DefaultOverrides,
} from "./managed.js";
import { createManagedMemory, createMemoryLinks, type ManagedMemory } from "./memory.js";
import { createResolver, type CodeChange, type Content, type Resolution, type ResolveInput } from "./resolve.js";
import { AgentWorkflowListSchema } from "./contract.js";
import { sha256Hex } from "./util.js";
import { createEvalWorker, type EvalWorker, type EvalWorkerOptions } from "./worker.js";
import {
  createAgentWorkflowEvalWorker,
  createWorkflowEvalWorker,
  type AgentWorkflowEvalWorkerOptions,
  type WorkflowEvalWorkerOptions,
} from "./workflow/eval-worker.js";
import { createTracingWorld, type TracingWorldOptions, type WorldLike } from "./workflow/tracing-world.js";

export type LittleDBOptions = {
  /** The LittleDB server, e.g. `http://localhost:7340` (`/v1` is added when missing). */
  readonly url: string;
  /** A project API key (`ldb_...`). Sent only as a bearer token; never logged. */
  readonly apiKey: string;
  /** Your own `fetch`, for tests or proxies. */
  readonly fetch?: typeof fetch | undefined;
  /** Send queued traces, spans and scores at least this often. Default 1000 ms. */
  readonly flushIntervalMs?: number | undefined;
  /** Items per ingest request. Default 500. */
  readonly maxBatch?: number | undefined;
  /** Items held while LittleDB is unreachable; the oldest are dropped beyond it. Default 10 000. */
  readonly maxQueue?: number | undefined;
  /** Per-request timeout. Default 10 s (5 s for resolve and agent-workflow lookups). */
  readonly timeoutMs?: number | undefined;
  /** Resolve answers are reused this long (an hour for a sticky key). Default 30 s. */
  readonly resolveCacheTtlMs?: number | undefined;
  /**
   * How often a session's kept answer is checked again, so a rollback reaches sessions already
   * running. A session keeps its version through promotions. Default 30 s.
   */
  readonly revalidateMs?: number | undefined;
  /**
   * A JSON file that keeps each subject's last live answer, so a process that starts while
   * LittleDB is down runs the version that was live instead of your bootstrap.
   */
  readonly lastKnownFile?: string | undefined;
  /**
   * After this many failed resolves in a row, answer from the fallback without asking LittleDB
   * for `breakerCooldownMs` (default 3 failures, 30 s), so an outage adds no wait to new sessions.
   */
  readonly breakerFailures?: number | undefined;
  readonly breakerCooldownMs?: number | undefined;
  /** Hear when LittleDB opened a proposal for a change in your code. Default: one `console.info` per proposal. */
  readonly onCodeChange?: ((change: CodeChange) => void) | undefined;
  /**
   * Hear about problems off the app's path (dropped batches, an unreachable server). Default: a
   * `console.warn`, at most once a minute per kind of problem.
   */
  readonly onError?: LittleDBErrorHandler | undefined;
  /**
   * Keep managed memory (`db.memory.org`, `db.memory.user`) in local folders under this directory
   * instead of LittleDB: what `littleDBFromEnv` does offline, with `.littledb/memory`.
   */
  readonly localMemoryDir?: string | undefined;
};

export type ScoreOptions = {
  readonly traceId: string;
  /** Score one span instead of the whole trace. */
  readonly spanId?: string | undefined;
  readonly name: string;
  readonly value?: number | undefined;
  readonly label?: string | undefined;
  readonly comment?: string | undefined;
  /** Default `app`. */
  readonly source?: ScoreSource | undefined;
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
  /** Scores are upserted by id. Default: derived from trace, span, name and source, so a retry never duplicates. */
  readonly id?: string | undefined;
};

export type LittleDB = {
  /**
   * The version to run for a harness or workflow: the live one, or a candidate when this sticky
   * key is in a trial. Cached; falls back to the last answer, then to your bootstrap, so the app
   * never waits on or fails because of LittleDB.
   */
  resolve<C = Content>(input: ResolveInput<C>): Promise<Resolution<C>>;
  /**
   * A harness whose prompt and model LittleDB manages: hand `turnOptions` to `createHarness` and
   * each turn runs its session's version (the live one, a trial candidate, or your bootstrap when
   * LittleDB is unreachable), traced with that version.
   */
  managedHarness<C extends Content, M = never, O extends object = DefaultOverrides<M>, TExtraBody = unknown>(
    options: ManagedHarnessOptions<C, M, O, TExtraBody>,
  ): ManagedHarness<C, O>;
  /** A workflow whose step prompts and models LittleDB manages: `prepare` a run, build from `content`, run in `world`. */
  managedWorkflow<C extends Content>(options: ManagedWorkflowOptions<C>): ManagedWorkflow<C>;
  /**
   * Memory LittleDB keeps: `org({ space })` for what an org shares, `user({ user })` for each
   * person. Each returns a Harness `memory()` option; changes to org memory wait in the Memory tab.
   */
  readonly memory: ManagedMemory;
  /** A harness `onEvent` hook that sends each turn as a trace. */
  harnessTracer(options: HarnessTracerOptions): HarnessTracer;
  /** Wrap a Little Workflow World so each run is also sent as a trace. */
  tracingWorld<W extends WorldLike>(inner: W, options: TracingWorldOptions): W;
  /** A `dynamicWorkflows({ registry })` that puts agent-made workflows behind review in LittleDB. */
  agentWorkflowRegistry(options: AgentWorkflowRegistryOptions): LittleDBAgentWorkflowRegistry;
  /** Run LittleDB experiments for these subjects inside this process. */
  evalWorker(options: EvalWorkerOptions): EvalWorker;
  /**
   * Run one workflow's experiments: build it from each run's version content, run it on the
   * item's input in a World traced into the run's trace, and grade the output.
   */
  workflowEvalWorker<W extends WorldLike>(options: WorkflowEvalWorkerOptions<W>): EvalWorker;
  /**
   * Run the experiments of the workflows an agent made in one harness: each run hands you the
   * proposed definition to build with Little Workflow's `agentWorkflow`, its input and a traced World.
   */
  agentWorkflowEvalWorker<W extends WorldLike>(options: AgentWorkflowEvalWorkerOptions<W>): EvalWorker;
  /** Record a score on a trace (or one of its spans). Queued like traces; returns the score's id. */
  score(options: ScoreOptions): string;
  /** Queue raw traces, spans and scores. */
  ingest(batch: IngestBatch): void;
  /**
   * Send what an end user said about a turn (a thumbs, a rating, a comment, survey answers) from
   * your backend. Sent now, not queued; throws `LittleDBError`, or `TypeError` for invalid input.
   */
  feedback(input: FeedbackInput): Promise<FeedbackResult>;
  /**
   * Withdraw every score sent with this feedback id (a user removing a reaction). With a
   * `revision`, LittleDB keeps it, so an older change to the id arriving later changes nothing.
   */
  retractFeedback(id: string, options?: RetractFeedbackOptions): Promise<FeedbackRetracted>;
  /**
   * A Fetch handler to mount on your own backend, so the browser can send feedback without the
   * API key: `authorize` names the user, the handler forwards with the key.
   */
  feedbackHandler(options: FeedbackHandlerOptions): (request: Request) => Promise<Response>;
  /** A harness outcome sink: chat reactions and reported outcomes become user feedback. */
  outcomeSink(options?: OutcomeSinkOptions): LittleDBOutcomeSink;
  /** Call any other `/v1` endpoint (datasets, experiments, proposals). Throws `LittleDBError`. */
  request<T = unknown>(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T>;
  /** Send everything queued now. Never throws. */
  flush(): Promise<void>;
  /** Flush and stop sending. Call before the process exits. */
  shutdown(): Promise<void>;
  /** Queue counters: queued, sent, dropped. */
  stats(): ExporterStats;
};

/** The default error handler: one warning a minute per operation, with no request body or key. */
function rateLimitedWarn(): LittleDBErrorHandler {
  const last = new Map<string, number>();
  return (error, { operation }) => {
    const now = Date.now();
    if ((last.get(operation) ?? 0) > now - 60_000) return;
    last.set(operation, now);
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[littledb] ${operation}: ${message}`);
  };
}

/** A stable score id, so sending the same score twice updates it instead of adding another. */
export function scoreId(traceId: string, spanId: string | undefined, name: string, source: string): string {
  return `scr_${sha256Hex([traceId, spanId ?? "", name, source].join("\n")).slice(0, 32)}`;
}

/**
 * The LittleDB client: one URL and one API key. Tracing is queued and sent in the background,
 * resolve is cached with fallbacks, so nothing here puts LittleDB on your app's critical path.
 */
export function createLittleDB(options: LittleDBOptions): LittleDB {
  if (typeof options.apiKey !== "string" || options.apiKey.length === 0) {
    throw new TypeError("createLittleDB needs an apiKey.");
  }
  const onError = options.onError ?? rateLimitedWarn();
  const transport = createTransport({
    url: options.url,
    apiKey: options.apiKey,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  const exporter = createExporter({
    transport,
    onError,
    ...(options.flushIntervalMs === undefined ? {} : { flushIntervalMs: options.flushIntervalMs }),
    ...(options.maxBatch === undefined ? {} : { maxBatch: options.maxBatch }),
    ...(options.maxQueue === undefined ? {} : { maxQueue: options.maxQueue }),
  });
  const feedbackApi = createFeedbackApi({ transport, exporter });
  const resolver = createResolver({
    transport,
    onError,
    ...(options.resolveCacheTtlMs === undefined ? {} : { cacheTtlMs: options.resolveCacheTtlMs }),
    ...(options.revalidateMs === undefined ? {} : { revalidateMs: options.revalidateMs }),
    ...(options.lastKnownFile === undefined ? {} : { lastKnownFile: options.lastKnownFile }),
    ...(options.breakerFailures === undefined ? {} : { breakerFailures: options.breakerFailures }),
    ...(options.breakerCooldownMs === undefined ? {} : { breakerCooldownMs: options.breakerCooldownMs }),
    ...(options.onCodeChange === undefined ? {} : { onCodeChange: options.onCodeChange }),
  });
  // Which trace each harness turn went to, so a workflow run a tool call started nests under it.
  const turnTraceIds = createTurnTraceIds();
  // Which memory revisions each turn loaded, and which message and trace saved a memory.
  const memoryLinks = createMemoryLinks();
  const memory = createManagedMemory({ transport, onError, links: memoryLinks, ...(options.localMemoryDir === undefined ? {} : { localDir: options.localMemoryDir }) });
  const harnessTracer = (tracerOptions: HarnessTracerOptions) => createHarnessTracer(tracerOptions, { exporter, onError, turnTraceIds, memoryLinks });
  const tracingWorld = <W extends WorldLike>(inner: W, worldOptions: TracingWorldOptions) =>
    createTracingWorld(inner, worldOptions, { exporter, onError, turnTraceIds });
  const evalWorker = (workerOptions: EvalWorkerOptions) => createEvalWorker(workerOptions, { transport, exporter, onError });
  const agentWorkflowRegistry = (registryOptions: AgentWorkflowRegistryOptions) =>
    createAgentWorkflowRegistry(registryOptions, { transport, onError, tracingWorld });
  const workflowEvalWorker = <W extends WorldLike>(workerOptions: WorkflowEvalWorkerOptions<W>) =>
    createWorkflowEvalWorker(workerOptions, { evalWorker, tracingWorld });
  const managedDeps = {
    resolve: <C>(input: ResolveInput<C>) => resolver.resolve(input),
    harnessTracer,
    tracingWorld,
    agentWorkflowRegistry,
    evalWorker,
    workflowEvalWorker,
    onError,
  };

  return {
    resolve: (input) => resolver.resolve(input),
    managedHarness: (managedOptions) => createManagedHarness(managedOptions, managedDeps),
    managedWorkflow: (managedOptions) => createManagedWorkflow(managedOptions, managedDeps),
    memory,
    harnessTracer,
    tracingWorld,
    agentWorkflowRegistry,
    evalWorker,
    workflowEvalWorker,
    agentWorkflowEvalWorker: (workerOptions) =>
      createAgentWorkflowEvalWorker(workerOptions, {
        evalWorker,
        tracingWorld,
        listHandles: async (harness) => {
          const raw = await transport.request("GET", `/agent-workflows?harness=${encodeURIComponent(harness)}`);
          return AgentWorkflowListSchema.parse(raw).workflows.map((workflow) => workflow.handle);
        },
      }),
    score(score) {
      const source = score.source ?? "app";
      const id = score.id ?? scoreId(score.traceId, score.spanId, score.name, source);
      exporter.enqueue({
        scores: [
          {
            id,
            traceId: score.traceId,
            ...(score.spanId === undefined ? {} : { spanId: score.spanId }),
            name: score.name,
            ...(score.value === undefined ? {} : { value: score.value }),
            ...(score.label === undefined ? {} : { label: score.label }),
            ...(score.comment === undefined ? {} : { comment: score.comment }),
            source,
            ...(score.metadata === undefined ? {} : { metadata: { ...score.metadata } }),
          },
        ],
      });
      return id;
    },
    ingest: (batch) => exporter.enqueue(batch),
    feedback: (input) => feedbackApi.feedback(input),
    retractFeedback: (id, options) => feedbackApi.retractFeedback(id, options),
    feedbackHandler: (handlerOptions) => createFeedbackHandler(handlerOptions, { ...feedbackApi, onError }),
    outcomeSink: (sinkOptions = {}) => createOutcomeSink(sinkOptions, { ...feedbackApi, onError }),
    request: (method, path, body) => transport.request(method, path.startsWith("/") ? path : `/${path}`, body),
    flush: () => exporter.flush(),
    shutdown: () => exporter.shutdown(),
    stats: () => exporter.stats(),
  };
}

/** Answers for a client with no LittleDB: your bootstrap runs, nothing is sent anywhere. */
const offlineFetch: typeof fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const method = init?.method ?? "GET";
  const body = (typeof init?.body === "string" ? JSON.parse(init.body) : {}) as Record<string, unknown>;
  const answer = (status: number, value: unknown) =>
    new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
  const path = url.pathname;
  if (method === "POST" && path === "/v1/resolve") {
    return answer(200, {
      subjectId: "offline",
      versionId: null,
      number: null,
      status: null,
      mode: "none",
      content: body.bootstrap ?? null,
      channel: typeof body.channel === "string" ? body.channel : "production",
    });
  }
  if (method === "POST" && path === "/v1/agent-workflows") {
    const revision = typeof body.revision === "number" ? body.revision : 1;
    return answer(200, { subjectId: "offline", versionId: `offline_${String(body.handle)}@${revision}`, number: revision, status: "draft", live: false, proposalId: null });
  }
  if (method === "GET" && path === "/v1/agent-workflows") return answer(200, { workflows: [] });
  if (method === "POST" && path === "/v1/worker/claim") return answer(200, { runs: [] });
  if (method === "POST" && path === "/v1/feedback") return answer(201, { traceId: typeof body.traceId === "string" ? body.traceId : "offline", scores: [] });
  return answer(200, {});
};

/**
 * The client for `LITTLEDB_URL` and `LITTLEDB_API_KEY`. With no `LITTLEDB_URL` it is offline:
 * every resolve answers your bootstrap, traces, scores and feedback are dropped, and managed
 * memory is local folders under `LITTLEDB_MEMORY_DIR` (default `.littledb/memory`), so the same
 * code runs with and without LittleDB.
 */
export function littleDBFromEnv(
  options: Omit<LittleDBOptions, "url" | "apiKey"> = {},
  env: Readonly<Record<string, string | undefined>> = process.env,
): LittleDB & { readonly offline: boolean } {
  const url = env.LITTLEDB_URL;
  if (url === undefined || url.length === 0) {
    const localMemoryDir = options.localMemoryDir ?? env.LITTLEDB_MEMORY_DIR ?? ".littledb/memory";
    return { ...createLittleDB({ ...options, localMemoryDir, url: "http://littledb.offline", apiKey: "offline", fetch: offlineFetch }), offline: true };
  }
  const apiKey = env.LITTLEDB_API_KEY;
  if (apiKey === undefined || apiKey.length === 0) {
    throw new TypeError("LITTLEDB_URL is set but LITTLEDB_API_KEY is not. `littledb dev` prints a local key.");
  }
  return { ...createLittleDB({ ...options, url, apiKey }), offline: false };
}
