// An in-memory stand-in for the LittleDB `/v1` API, served through a `fetch` function. It checks
// request bodies against the contract and keeps what it was sent, so tests can assert on it.
import {
  AgentWorkflowRegistrationSchema,
  CompleteRunSchema,
  FeedbackRequestSchema,
  IngestBatchSchema,
  ResolveRequestSchema,
  type ClaimedRun,
  type FeedbackRequest,
  type ScoreInput,
  type SpanInput,
  type TraceInput,
} from "../contract.js";

export type FakeRequest = { readonly method: string; readonly path: string; readonly body: unknown; readonly authorization: string | null };

type Handler = (request: FakeRequest) => { status: number; body: unknown } | undefined;

/** A user-feedback score as the fake stores it, following the server's mapping. */
export type FakeFeedbackScore = {
  readonly id: string;
  readonly traceId: string;
  readonly spanId?: string;
  readonly feedbackId?: string;
  readonly name: string;
  readonly value?: number;
  readonly label?: string;
  readonly comment?: string;
  readonly author?: string;
  readonly survey?: string;
  readonly metadata?: Record<string, unknown>;
};

/** What a report says, as LittleDB's fence compares it: not where it lands, `at` or `metadata`. */
function feedbackDigest(body: FeedbackRequest): string {
  const comment = body.comment?.trim();
  return JSON.stringify([body.name, body.thumbs, body.rating, body.answers, comment === "" ? undefined : comment, body.survey, body.userId, body.spanId]);
}

/** One score per answer, as LittleDB maps feedback: thumbs 1/0, ratings to 0..1, labels for the rest. */
function feedbackScores(body: FeedbackRequest, traceId: string, nextId: () => string): FakeFeedbackScore[] {
  const rows: Array<Omit<FakeFeedbackScore, "id" | "traceId">> = [];
  const normalized = (value: number, scale: number) => (value - 1) / (scale - 1);
  const withComment = body.thumbs !== undefined || body.rating !== undefined;
  if (body.thumbs !== undefined) {
    rows.push({ name: body.name ?? "thumbs", value: body.thumbs === "up" ? 1 : 0, ...(body.comment === undefined ? {} : { comment: body.comment }) });
  }
  if (body.rating !== undefined) {
    const scale = body.rating.scale ?? 5;
    rows.push({
      name: body.name ?? "rating",
      value: normalized(body.rating.value, scale),
      metadata: { raw: body.rating.value, scale },
      ...(body.comment === undefined || body.thumbs !== undefined ? {} : { comment: body.comment }),
    });
  }
  if (body.comment !== undefined && !withComment) rows.push({ name: "comment", label: "comment", comment: body.comment });
  for (const answer of body.answers ?? []) {
    if ("choice" in answer) rows.push({ name: answer.question, label: answer.choice });
    else if ("text" in answer) rows.push({ name: answer.question, label: "text", comment: answer.text });
    else if (typeof answer.value === "boolean") rows.push({ name: answer.question, value: answer.value ? 1 : 0 });
    else rows.push({ name: answer.question, value: normalized(answer.value, answer.scale), metadata: { raw: answer.value, scale: answer.scale } });
  }
  return rows.map((row) => ({
    ...row,
    id: body.id === undefined ? nextId() : `fbs_${body.id}_${row.name}`,
    traceId,
    ...(body.spanId === undefined ? {} : { spanId: body.spanId }),
    ...(body.id === undefined ? {} : { feedbackId: body.id }),
    ...(body.userId === undefined ? {} : { author: body.userId }),
    ...(body.survey === undefined ? {} : { survey: body.survey }),
    metadata: {
      ...body.metadata,
      ...row.metadata,
      ...(body.userId === undefined ? {} : { userId: body.userId }),
      ...(body.id === undefined ? {} : { feedbackId: body.id }),
      ...(body.survey === undefined ? {} : { survey: body.survey }),
    },
  }));
}

type AgentWorkflowVersion = {
  id: string;
  number: number;
  status: "draft" | "live" | "retired";
  content: Record<string, unknown>;
  externalId: string | null;
};

export function fakeLittleDB(options: { readonly apiKey?: string } = {}) {
  const apiKey = options.apiKey ?? "ldb_test_key";
  const requests: FakeRequest[] = [];
  const traces = new Map<string, TraceInput>();
  const spans = new Map<string, SpanInput>();
  const scores = new Map<string, ScoreInput>();
  const feedback = new Map<string, FakeFeedbackScore>();
  // LittleDB's fence (G24): per feedback id, the highest revision applied, whether it was a
  // retraction, and what the report said.
  const feedbackRevisions = new Map<string, { revision: number; retracted: boolean; digest?: string }>();
  let feedbackCounter = 0;
  const ingestBatches: unknown[] = [];
  const agentWorkflows = new Map<string, { subjectId: string; description?: string; versions: AgentWorkflowVersion[]; trial?: Record<string, unknown> }>();
  const pendingRuns: ClaimedRun[] = [];
  const completions: Array<{ runId: string; body: unknown }> = [];
  const heartbeats: string[] = [];
  const overrides: Handler[] = [];
  let resolution: Record<string, unknown> | undefined;
  let versionCounter = 0;

  const json = (status: number, body: unknown) => ({ status, body });
  const error = (status: number, code: string, message: string) => json(status, { error: { code, message } });

  function route(request: FakeRequest): { status: number; body: unknown } {
    for (const override of overrides) {
      const answer = override(request);
      if (answer !== undefined) return answer;
    }
    const { method, path, body } = request;
    if (request.authorization !== `Bearer ${apiKey}`) return error(401, "unauthorized", "Bad API key.");
    if (method === "POST" && path === "/v1/ingest") {
      const parsed = IngestBatchSchema.safeParse(body);
      if (!parsed.success) return error(400, "bad_request", parsed.error.message);
      ingestBatches.push(body);
      const batch = body as { traces?: TraceInput[]; spans?: SpanInput[]; scores?: ScoreInput[] };
      for (const trace of batch.traces ?? []) traces.set(trace.id, { ...traces.get(trace.id), ...trace });
      for (const span of batch.spans ?? []) spans.set(`${span.traceId}/${span.id}`, span);
      for (const score of batch.scores ?? []) scores.set(score.id ?? `gen_${scores.size}`, score);
      return json(200, { traces: batch.traces?.length ?? 0, spans: batch.spans?.length ?? 0, scores: batch.scores?.length ?? 0 });
    }
    if (method === "POST" && path === "/v1/resolve") {
      const parsed = ResolveRequestSchema.safeParse(body);
      if (!parsed.success) return error(400, "bad_request", parsed.error.message);
      if (resolution !== undefined) return json(200, resolution);
      const input = parsed.data;
      return json(200, {
        subjectId: `sub_${input.slug}`,
        versionId: input.bootstrap === undefined ? null : `ver_${input.slug}_1`,
        number: input.bootstrap === undefined ? null : 1,
        status: input.bootstrap === undefined ? null : "live",
        mode: input.bootstrap === undefined ? "none" : "live",
        content: input.bootstrap ?? null,
        channel: input.channel ?? "production",
      });
    }
    if (method === "POST" && path === "/v1/agent-workflows") {
      const parsed = AgentWorkflowRegistrationSchema.safeParse(body);
      if (!parsed.success) return error(400, "bad_request", parsed.error.message);
      const input = parsed.data;
      const workflow = agentWorkflows.get(input.handle) ?? { subjectId: `sub_${input.handle}`, versions: [] };
      if (input.description !== undefined) workflow.description = input.description;
      agentWorkflows.set(input.handle, workflow);
      const live = workflow.versions.find((v) => v.status === "live");
      if (live !== undefined && JSON.stringify(live.content) === JSON.stringify(input.definition)) {
        return json(200, { subjectId: workflow.subjectId, versionId: live.id, number: live.number, status: "live", live: true, proposalId: null });
      }
      versionCounter += 1;
      const version: AgentWorkflowVersion = {
        id: `ver_${versionCounter}`,
        number: workflow.versions.length + 1,
        status: "draft",
        content: input.definition,
        externalId: input.revision === undefined ? null : `${input.handle}@${input.revision}`,
      };
      workflow.versions.push(version);
      return json(201, {
        subjectId: workflow.subjectId,
        versionId: version.id,
        number: version.number,
        status: "draft",
        live: false,
        proposalId: `prp_${versionCounter}`,
      });
    }
    if (method === "GET" && path.startsWith("/v1/agent-workflows?")) {
      const query = new URLSearchParams(path.slice(path.indexOf("?") + 1));
      const includeDrafts = query.get("includeDrafts") === "true";
      return json(200, {
        workflows: [...agentWorkflows.entries()].map(([handle, workflow]) => {
          const live = workflow.versions.find((v) => v.status === "live");
          return {
            handle,
            subjectId: workflow.subjectId,
            description: workflow.description ?? null,
            live: live === undefined ? null : { versionId: live.id, number: live.number, content: live.content, externalId: live.externalId },
            trial: workflow.trial ?? null,
            drafts: includeDrafts
              ? workflow.versions
                  .filter((v) => v.status === "draft")
                  .map((v) => ({ id: v.id, subjectId: workflow.subjectId, number: v.number, status: v.status, content: v.content, externalId: v.externalId }))
              : [],
          };
        }),
      });
    }
    if (method === "POST" && path === "/v1/feedback") {
      const parsed = FeedbackRequestSchema.safeParse(body);
      if (!parsed.success) return error(400, "bad_request", parsed.error.message);
      const input = parsed.data;
      const traceId =
        input.traceId ?? [...traces.values()].filter((trace) => trace.sessionId === input.sessionId).at(-1)?.id;
      if (traceId === undefined) return error(404, "not_found", "That session has no trace yet.");
      const rows = feedbackScores(input, traceId, () => `fbs_${String(++feedbackCounter)}`);
      const answer = json(201, {
        traceId,
        scores: rows.map((row) => ({ id: row.id, name: row.name, value: row.value ?? null, label: row.label ?? null })),
      });
      if (input.id !== undefined) {
        const fence = feedbackRevisions.get(input.id);
        const digest = feedbackDigest(input);
        if (fence !== undefined) {
          // Without a revision, below every revision; at the one applied, remove wins, the same
          // report again is a repeat, and a different one is refused.
          const stale = json(200, { traceId, scores: [], stale: true, revision: fence.revision });
          if (input.revision === undefined || fence.revision > input.revision) return stale;
          if (fence.revision === input.revision) {
            if (fence.retracted) return stale;
            if (fence.digest === digest) return answer;
            return error(409, "revision_conflict", "This revision of the feedback was already applied with different answers.");
          }
        }
        if (input.revision !== undefined) feedbackRevisions.set(input.id, { revision: input.revision, retracted: false, digest });
      }
      for (const row of rows) feedback.set(row.id, row);
      return answer;
    }
    const retract = /^\/v1\/feedback\/([^/?]+)(?:\?revision=(\d+))?$/u.exec(path);
    if (method === "DELETE" && retract !== null) {
      const id = decodeURIComponent(retract[1]!);
      const fence = feedbackRevisions.get(id);
      const revision = retract[2] === undefined ? undefined : Number(retract[2]);
      if (fence !== undefined && (revision === undefined || fence.revision > revision)) {
        return json(200, { removed: 0, stale: true, revision: fence.revision });
      }
      if (revision !== undefined) {
        if (fence?.revision === revision && fence.retracted) return json(200, { removed: 0 });
        feedbackRevisions.set(id, { revision, retracted: true });
      }
      let removed = 0;
      for (const [key, row] of feedback) {
        if (row.feedbackId === id) {
          feedback.delete(key);
          removed += 1;
        }
      }
      return json(200, { removed });
    }
    if (method === "POST" && path === "/v1/worker/claim") {
      const limit = (body as { limit?: number }).limit ?? 4;
      return json(200, { runs: pendingRuns.splice(0, limit) });
    }
    const complete = /^\/v1\/worker\/runs\/([^/]+)\/complete$/u.exec(path);
    if (method === "POST" && complete !== null) {
      const parsed = CompleteRunSchema.safeParse(body);
      if (!parsed.success) return error(400, "bad_request", parsed.error.message);
      completions.push({ runId: decodeURIComponent(complete[1]!), body });
      return json(200, { run: { id: complete[1], status: parsed.data.error === undefined ? "done" : "pending" } });
    }
    const heartbeat = /^\/v1\/worker\/runs\/([^/]+)\/heartbeat$/u.exec(path);
    if (method === "POST" && heartbeat !== null) {
      heartbeats.push(decodeURIComponent(heartbeat[1]!));
      return json(200, { ok: true });
    }
    return error(404, "not_found", `No route for ${method} ${path}`);
  }

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    const request: FakeRequest = {
      method: init?.method ?? "GET",
      path: `${url.pathname}${url.search}`,
      body,
      authorization: headers.get("authorization"),
    };
    requests.push(request);
    const answer = route(request);
    return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), {
      status: answer.status,
      headers: { "content-type": "application/json" },
    });
  };

  return {
    url: "http://littledb.test",
    apiKey,
    fetch: fetchImpl,
    requests,
    traces,
    spans,
    scores,
    /** User feedback as stored scores, by score id. */
    feedback,
    ingestBatches,
    completions,
    heartbeats,
    pendingRuns,
    /** Answer requests before the default routes; return `undefined` to fall through. */
    override(handler: Handler) {
      overrides.push(handler);
    },
    clearOverrides() {
      overrides.splice(0);
    },
    setResolution(value: Record<string, unknown> | undefined) {
      resolution = value;
    },
    /** Put an agent workflow's draft in a trial: `share` of sessions, all of them on this one arm. */
    agentTrial(handle: string, versionId: string, share: number) {
      const workflow = agentWorkflows.get(handle);
      const version = workflow?.versions.find((v) => v.id === versionId);
      if (workflow === undefined || version === undefined) throw new Error(`No agent workflow version ${handle} ${versionId}`);
      workflow.trial = {
        id: `trl_${handle}`,
        share,
        versionId,
        weight: share,
        arms: [{ versionId, weight: share, number: version.number, content: version.content, externalId: version.externalId }],
      };
    },
    /** Approve an agent workflow's draft: it becomes the live version. */
    promote(handle: string, versionId: string) {
      const workflow = agentWorkflows.get(handle);
      if (workflow === undefined) throw new Error(`No agent workflow ${handle}`);
      for (const version of workflow.versions) {
        if (version.status === "live") version.status = "retired";
        if (version.id === versionId) version.status = "live";
      }
    },
    spansOf(traceId: string): SpanInput[] {
      return [...spans.values()].filter((span) => span.traceId === traceId);
    },
  };
}

export type FakeLittleDB = ReturnType<typeof fakeLittleDB>;
