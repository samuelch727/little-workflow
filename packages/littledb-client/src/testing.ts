// `@little-stack/littledb/testing`: LittleDB in memory, for your app's tests. It answers the same
// `/v1` requests the client sends, so `managedHarness`, `resolve`, tracing and feedback run as
// they do against a server, and the test sets which version is live, starts a trial, rolls back
// or takes LittleDB down.
import { createLittleDB, type LittleDB, type LittleDBOptions } from "./client.js";
import {
  FeedbackRequestSchema,
  IngestBatchSchema,
  ResolveRequestSchema,
  type ClaimedRun,
  type ScoreInput,
  type SpanInput,
  type TraceInput,
} from "./contract.js";
import type { ResolvedModel } from "./contract.js";
import { modelOfContent } from "./models.js";
import { bucket, sha256Hex } from "./util.js";

/** A version as the test server keeps it. */
export type TestVersion = {
  readonly id: string;
  readonly number: number;
  status: "draft" | "trial" | "approved" | "retired" | "rejected";
  readonly content: Record<string, unknown>;
  readonly origin: "code" | "test";
};

type TestSubject = {
  readonly ref: string;
  readonly versions: TestVersion[];
  liveId: string | null;
  /** The bootstrap content LittleDB last saw from code. */
  codeHash: string | null;
  trial: { readonly id: string; readonly versionId: string; readonly share: number } | null;
  /** Proposals opened for changes in code. */
  readonly codeProposals: { readonly id: string; readonly versionId: string }[];
  schema?: Record<string, unknown>;
};

/** A change to managed memory waiting for a person, or decided. */
export type TestMemoryChange = {
  readonly id: string;
  readonly space: string;
  readonly org: string;
  status: "waiting" | "approved" | "rejected";
  readonly origin: "agent" | "code";
  edits: { readonly path: string; readonly op: "put" | "delete"; readonly content?: string }[];
  readonly sessionId?: string;
  by?: { readonly id: string; readonly label?: string; readonly role?: string };
  said?: string;
  traceId?: string;
};

type TestMemorySpace = {
  readonly layer: "org" | "user";
  readonly slug: string;
  review: "person" | "after" | "none";
  /** By `org\nuser`: path to text, and the seed last applied. */
  readonly copies: Map<string, { files: Map<string, { content: string; number: number }>; seedHash?: string; seedFiles?: Record<string, string> }>;
};

export type TestLittleDBOptions = Omit<LittleDBOptions, "url" | "apiKey" | "fetch"> & {
  /** Versions live from the start, by `kind:slug` (`harness:support-desk`). */
  readonly live?: Readonly<Record<string, Record<string, unknown>>> | undefined;
  /** The project's default agent model, which a harness version without one runs. Default DeepSeek Flash on your key. */
  readonly agentModel?: { readonly id: string; readonly paidBy: "key" | "credits" } | undefined;
};

export type TestLittleDB = {
  /** A real client, talking to the in-memory LittleDB. */
  readonly db: LittleDB;
  /**
   * Another real client of the same in-memory LittleDB, with nothing cached, as a second process
   * or a restarted one has. Its requests are recorded in `requests` too.
   */
  connect(options?: Omit<LittleDBOptions, "url" | "apiKey" | "fetch">): LittleDB;
  /** Make this content the live version of `kind:slug`; returns its version id. */
  setLive(ref: string, content: Record<string, unknown>): string;
  /** Put a candidate in a trial against the live version, for `share` of sessions (default all). Returns its version id. */
  startTrial(ref: string, content: Record<string, unknown>, share?: number): string;
  /** Stop the trial: its candidate goes back to draft, and sessions on it move to the live version at their next check. */
  stopTrial(ref: string): void;
  /** Roll the live version back to the one before it: sessions on it move off at their next check. */
  rollback(ref: string): void;
  /** Every version of `kind:slug`, oldest first. */
  versions(ref: string): readonly TestVersion[];
  /** Proposals LittleDB opened because the bootstrap in your code changed. */
  codeProposals(ref: string): readonly { readonly id: string; readonly versionId: string }[];
  /** The JSON Schema your code declared for `kind:slug`, if it sent one. */
  schemaOf(ref: string): Record<string, unknown> | undefined;
  /** Make LittleDB unreachable (every request fails) or reachable again. */
  setDown(down: boolean): void;
  /** Queue an experiment run for an eval worker to claim. */
  queueRun(run: ClaimedRun): void;
  readonly traces: ReadonlyMap<string, TraceInput>;
  spansOf(traceId: string): SpanInput[];
  readonly scores: ReadonlyMap<string, ScoreInput>;
  /** Every request the client made: method, path and body. */
  readonly requests: readonly { readonly method: string; readonly path: string; readonly body: unknown }[];
  /** Managed memory as the test LittleDB keeps it (`db.memory.org`, `db.memory.user`). */
  readonly memory: {
    /** A copy's live files: org memory by `org` (default `default`), a person's by `user`. */
    files(space: string, options?: { readonly org?: string; readonly user?: string }): Record<string, string>;
    /** Org changes waiting for a person, oldest first. */
    waiting(): readonly TestMemoryChange[];
    /** Every change, decided or not. */
    readonly changes: readonly TestMemoryChange[];
    approve(changeId: string): void;
    reject(changeId: string): void;
    /** What the Memory tab's review setting would do: `person`, `after` or `none`. */
    setReview(space: string, review: "person" | "after" | "none"): void;
    /** A member's edit in the Memory tab. */
    put(space: string, path: string, content: string, options?: { readonly org?: string }): void;
  };
};

const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map((k) => [k, (v as Record<string, unknown>)[k]]))
      : v,
  );

/** LittleDB in memory, with a client connected to it. */
export function testLittleDB(options: TestLittleDBOptions = {}): TestLittleDB {
  const { live, agentModel, ...clientOptions } = options;
  const subjects = new Map<string, TestSubject>();
  const traces = new Map<string, TraceInput>();
  const spans = new Map<string, SpanInput>();
  const scores = new Map<string, ScoreInput>();
  const requests: { method: string; path: string; body: unknown }[] = [];
  const runs: ClaimedRun[] = [];
  let down = false;
  let counter = 0;
  const nextId = (prefix: string) => `${prefix}_test_${String(++counter)}`;

  const subjectOf = (ref: string): TestSubject => {
    let found = subjects.get(ref);
    if (found === undefined) {
      found = { ref, versions: [], liveId: null, codeHash: null, trial: null, codeProposals: [] };
      subjects.set(ref, found);
    }
    return found;
  };
  const addVersion = (subject: TestSubject, content: Record<string, unknown>, status: TestVersion["status"], origin: TestVersion["origin"]) => {
    const version: TestVersion = { id: nextId("ver"), number: subject.versions.length + 1, status, content: structuredClone(content), origin };
    subject.versions.push(version);
    return version;
  };
  const byId = (subject: TestSubject, id: string | null) => subject.versions.find((v) => v.id === id);
  const makeLive = (subject: TestSubject, version: TestVersion) => {
    const before = byId(subject, subject.liveId);
    if (before !== undefined && before !== version) before.status = "retired";
    version.status = "approved";
    subject.liveId = version.id;
  };
  for (const [ref, content] of Object.entries(live ?? {})) {
    const subject = subjectOf(ref);
    const version = addVersion(subject, content, "approved", "test");
    makeLive(subject, version);
  }

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  function resolve(body: unknown): Response {
    const parsed = ResolveRequestSchema.safeParse(body);
    if (!parsed.success) return json(400, { error: { code: "bad_request", message: parsed.error.message } });
    const input = parsed.data;
    const subject = subjectOf(`${input.kind}:${input.slug}`);
    if (input.schema !== undefined) subject.schema = input.schema;
    let code: { state: string; versionId: string | null; proposalId: string | null } | undefined;
    if (input.bootstrap !== undefined) {
      const hash = sha256Hex(canonical(input.bootstrap));
      if (subject.liveId === null) {
        const version = addVersion(subject, input.bootstrap, "approved", "code");
        makeLive(subject, version);
        subject.codeHash = hash;
      } else if (subject.codeHash === null) {
        subject.codeHash = hash;
        code = { state: "in_sync", versionId: null, proposalId: null };
      } else if (subject.codeHash === hash) {
        code = { state: "in_sync", versionId: null, proposalId: null };
      } else {
        const version = addVersion(subject, input.bootstrap, "draft", "code");
        const proposal = { id: nextId("prp"), versionId: version.id };
        subject.codeProposals.push(proposal);
        subject.codeHash = hash;
        code = { state: "changed", versionId: version.id, proposalId: proposal.id };
      }
    }
    const liveVersion = byId(subject, subject.liveId);
    let chosen = liveVersion;
    let mode = liveVersion === undefined ? "none" : "live";
    const trial = subject.trial;
    if (trial !== null && input.stickyKey !== undefined && bucket(`${input.stickyKey}:${trial.id}`) < trial.share) {
      chosen = byId(subject, trial.versionId);
      mode = "trial";
    }
    let current: { versionId: string; status: string | null; revoked: boolean } | undefined;
    if (input.currentVersionId !== undefined) {
      const was = byId(subject, input.currentVersionId);
      current = { versionId: input.currentVersionId, status: was?.status ?? null, revoked: was === undefined || was.status === "rejected" || was.status === "draft" };
    }
    return json(200, {
      subjectId: `sub_${input.slug}`,
      versionId: chosen?.id ?? null,
      number: chosen?.number ?? null,
      status: chosen === undefined ? null : mode === "trial" ? "trial" : "live",
      mode,
      content: chosen?.content ?? null,
      channel: input.channel ?? "production",
      ...(current === undefined ? {} : { current }),
      ...(code === undefined ? {} : { code }),
      ...(input.kind === "harness" ? { model: modelFor(chosen?.content) } : {}),
    });
  }

  /** A harness's model as LittleDB answers it: the version's `provider/model`, else the project's default. */
  function modelFor(content: Record<string, unknown> | undefined): ResolvedModel {
    const fallback = agentModel ?? { id: "deepseek/deepseek-flash", paidBy: "key" as const };
    const own = modelOfContent(content);
    return own === undefined ? { ...fallback, source: "project" } : { id: own, paidBy: own === fallback.id ? fallback.paidBy : "key", source: "version" };
  }

  // --- Managed memory ---------------------------------------------------------------------------
  const memorySpaces = new Map<string, TestMemorySpace>();
  const memoryChanges: TestMemoryChange[] = [];
  const spaceOf = (layer: "org" | "user", slug: string, review?: "person" | "after" | "none") => {
    const key = `${layer}:${slug}`;
    let found = memorySpaces.get(key);
    if (found === undefined) {
      found = { layer, slug, review: layer === "user" ? "none" : (review ?? "person"), copies: new Map() };
      memorySpaces.set(key, found);
    }
    return found;
  };
  const copyOf = (space: TestMemorySpace, org: string, user: string) => {
    let copy = space.copies.get(`${org}\n${user}`);
    if (copy === undefined) {
      copy = { files: new Map() };
      space.copies.set(`${org}\n${user}`, copy);
    }
    return copy;
  };
  const applyEdits = (copy: { files: Map<string, { content: string; number: number }> }, edits: TestMemoryChange["edits"]) => {
    for (const e of edits) {
      if (e.op === "delete") copy.files.delete(e.path);
      else copy.files.set(e.path, { content: e.content ?? "", number: (copy.files.get(e.path)?.number ?? 0) + 1 });
    }
  };
  const revisionOf = (path: string, file: { number: number }) => `mrev_test_${sha256Hex(path).slice(0, 8)}_${String(file.number)}`;
  const encodeLease = (lease: Record<string, unknown>) => `mlease_test_${Buffer.from(JSON.stringify(lease)).toString("base64url")}`;
  const decodeLease = (token: unknown): { space: string; layer: "org" | "user"; org: string; user: string; writable: boolean; session: string } | undefined => {
    if (typeof token !== "string" || !token.startsWith("mlease_test_")) return undefined;
    try {
      return JSON.parse(Buffer.from(token.slice("mlease_test_".length), "base64url").toString()) as never;
    } catch {
      return undefined;
    }
  };
  const waitingOf = (space: string, org: string, sessionId: string) =>
    memoryChanges.find((c) => c.status === "waiting" && c.origin === "agent" && c.space === space && c.org === org && c.sessionId === sessionId);

  function memoryLoad(body: Record<string, unknown>): Response {
    const layer = body.layer === "user" ? "user" : "org";
    const slug = String(body.space);
    const org = typeof body.org === "string" && body.org.length > 0 ? body.org : "default";
    const user = layer === "user" ? String(body.user ?? "") : "";
    if (layer === "user" && user.length === 0) return json(400, { error: { code: "bad_request", message: "user memory needs a user" } });
    const space = spaceOf(layer, slug, body.review as "person" | "after" | "none" | undefined);
    const copy = copyOf(space, org, user);
    if (layer === "org" && typeof body.seedHash === "string" && copy.seedHash !== body.seedHash) {
      if (!isPlainRecord(body.seed)) return json(200, { seedWanted: true });
      const seed = body.seed as Record<string, string>;
      if (copy.seedHash === undefined && copy.files.size === 0) {
        applyEdits(copy, Object.entries(seed).map(([path, content]) => ({ path, op: "put" as const, content })));
      } else {
        const old = copy.seedFiles ?? {};
        const edits: TestMemoryChange["edits"] = [];
        for (const path of [...new Set([...Object.keys(old), ...Object.keys(seed)])].sort()) {
          if (old[path] === seed[path]) continue;
          edits.push(seed[path] === undefined ? { path, op: "delete" } : { path, op: "put", content: seed[path]! });
        }
        if (edits.length > 0) {
          if (space.review === "none") applyEdits(copy, edits);
          else memoryChanges.push({ id: nextId("mchg"), space: slug, org, status: "waiting", origin: "code", edits });
        }
      }
      copy.seedHash = body.seedHash;
      copy.seedFiles = { ...seed };
    }
    const files: Record<string, string> = {};
    const revisions: Record<string, string> = {};
    for (const [path, file] of copy.files) {
      files[path] = file.content;
      revisions[path] = revisionOf(path, file);
    }
    const own = layer === "org" ? waitingOf(slug, org, String(body.session)) : undefined;
    for (const e of own?.edits ?? []) {
      if (e.op === "delete") {
        delete files[e.path];
        delete revisions[e.path];
      } else {
        files[e.path] = e.content ?? "";
        revisions[e.path] = own!.id;
      }
    }
    const snapshot = `msnap_test_${sha256Hex(canonical([slug, org, user, revisions])).slice(0, 16)}`;
    return json(200, {
      space: { id: `msp_test_${layer}_${slug}`, layer, slug, review: space.review },
      files,
      revisions,
      snapshot,
      lease: encodeLease({ space: slug, layer, org, user, writable: body.writable === true, session: String(body.session) }),
      leaseExpiresAt: new Date(Date.now() + 7 * 24 * 3600_000).toISOString(),
    });
  }

  function memoryStore(body: Record<string, unknown>): Response {
    const lease = decodeLease(body.lease);
    if (lease === undefined) return json(400, { error: { code: "bad_lease", message: "The memory lease is not valid; load the memory again." } });
    if (!lease.writable) return json(403, { error: { code: "forbidden", message: "This turn loaded the memory read-only, so it can't change it." } });
    const space = spaceOf(lease.layer, lease.space);
    const copy = copyOf(space, lease.org, lease.user);
    const edits: TestMemoryChange["edits"] = [
      ...Object.entries({ ...(body.created as Record<string, string> | undefined), ...(body.updated as Record<string, string> | undefined) }).map(([path, content]) => ({ path, op: "put" as const, content })),
      ...((body.deleted as string[] | undefined) ?? []).map((path) => ({ path, op: "delete" as const })),
    ];
    if (edits.length === 0) return json(200, { status: "unchanged" });
    const context = {
      ...(isPlainRecord(body.by) ? { by: body.by as TestMemoryChange["by"] & object } : {}),
      ...(typeof body.said === "string" ? { said: body.said } : {}),
      ...(typeof body.traceId === "string" ? { traceId: body.traceId } : {}),
    };
    if (space.layer === "user" || space.review === "none") {
      applyEdits(copy, edits);
      return json(200, { status: "saved" });
    }
    if (space.review === "after") {
      applyEdits(copy, edits);
      const change: TestMemoryChange = { id: nextId("mchg"), space: lease.space, org: lease.org, status: "approved", origin: "agent", edits, sessionId: lease.session, ...context };
      memoryChanges.push(change);
      return json(200, { status: "saved", change: change.id });
    }
    const open = waitingOf(lease.space, lease.org, lease.session);
    if (open !== undefined) {
      const merged = new Map(open.edits.map((e) => [e.path, e]));
      for (const e of edits) merged.set(e.path, e);
      open.edits = [...merged.values()];
      Object.assign(open, context);
      return json(200, { status: "waiting", change: open.id });
    }
    const change: TestMemoryChange = { id: nextId("mchg"), space: lease.space, org: lease.org, status: "waiting", origin: "agent", edits, sessionId: lease.session, ...context };
    memoryChanges.push(change);
    return json(200, { status: "waiting", change: change.id });
  }

  function memoryPerson(method: string, url: URL): Response {
    const org = url.searchParams.get("org") || "default";
    const user = url.searchParams.get("user") ?? "";
    const spaces = [...memorySpaces.values()].filter((s) => s.layer === "user");
    if (method === "GET") {
      return json(200, {
        org,
        user,
        spaces: spaces
          .filter((s) => s.copies.has(`${org}\n${user}`))
          .map((s) => ({
            space: { slug: s.slug, description: null },
            files: [...s.copies.get(`${org}\n${user}`)!.files].map(([path, f]) => ({ path, summary: null, content: f.content, updatedAt: null })),
          })),
      });
    }
    if (url.pathname.endsWith("/files")) {
      const space = memorySpaces.get(`user:${url.searchParams.get("space") ?? "me"}`);
      const files = space?.copies.get(`${org}\n${user}`)?.files;
      const path = url.searchParams.get("path") ?? "";
      if (files === undefined || !files.has(path)) return json(404, { error: { code: "not_found", message: "Memory file not found" } });
      files.delete(path);
      return json(200, { ok: true });
    }
    let count = 0;
    for (const s of spaces) {
      count += s.copies.get(`${org}\n${user}`)?.files.size ?? 0;
      s.copies.delete(`${org}\n${user}`);
    }
    return json(200, { files: count });
  }

  const decide = (changeId: string, status: "approved" | "rejected") => {
    const change = memoryChanges.find((c) => c.id === changeId);
    if (change === undefined || change.status !== "waiting") throw new Error(`testLittleDB: no waiting memory change ${changeId}`);
    change.status = status;
    if (status === "approved") applyEdits(copyOf(spaceOf("org", change.space), change.org, ""), change.edits);
  };

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? "GET";
    const path = `${url.pathname}${url.search}`;
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    requests.push({ method, path, body });
    if (down) throw new TypeError("fetch failed: LittleDB is down (testLittleDB)");
    if (method === "POST" && path === "/v1/resolve") return resolve(body);
    if (method === "POST" && path === "/v1/ingest") {
      const parsed = IngestBatchSchema.safeParse(body);
      if (!parsed.success) return json(400, { error: { code: "bad_request", message: parsed.error.message } });
      for (const trace of parsed.data.traces ?? []) traces.set(trace.id, { ...traces.get(trace.id), ...trace });
      for (const span of parsed.data.spans ?? []) spans.set(`${span.traceId}/${span.id}`, span);
      for (const score of parsed.data.scores ?? []) scores.set(score.id ?? nextId("scr"), score);
      return json(200, {});
    }
    if (method === "POST" && path === "/v1/feedback") {
      const parsed = FeedbackRequestSchema.safeParse(body);
      if (!parsed.success) return json(400, { error: { code: "bad_request", message: parsed.error.message } });
      const traceId = parsed.data.traceId ?? [...traces.values()].filter((t) => t.sessionId === parsed.data.sessionId).at(-1)?.id;
      if (traceId === undefined) return json(404, { error: { code: "not_found", message: "That session has no trace yet." } });
      return json(201, { traceId, scores: [] });
    }
    if (method === "GET" && path.startsWith("/v1/agent-workflows")) return json(200, { workflows: [] });
    if (method === "POST" && path === "/v1/worker/claim") {
      const limit = (body as { limit?: number } | undefined)?.limit ?? 1;
      return json(200, { runs: runs.splice(0, limit) });
    }
    if (method === "POST" && /^\/v1\/worker\/runs\/[^/]+\/(complete|heartbeat)$/u.test(path)) return json(200, { ok: true });
    if (method === "POST" && path === "/v1/memory/load") return memoryLoad(isPlainRecord(body) ? body : {});
    if (method === "POST" && path === "/v1/memory/store") return memoryStore(isPlainRecord(body) ? body : {});
    if ((method === "GET" || method === "DELETE") && url.pathname.startsWith("/v1/memory/person")) return memoryPerson(method, url);
    return json(404, { error: { code: "not_found", message: `testLittleDB has no route for ${method} ${path}` } });
  };

  const db = createLittleDB({
    onError: () => {},
    ...clientOptions,
    url: "http://littledb.test",
    apiKey: "ldb_test",
    fetch: fetchImpl,
  });

  return {
    db,
    connect: (connectOptions = {}) =>
      createLittleDB({ onError: () => {}, ...clientOptions, ...connectOptions, url: "http://littledb.test", apiKey: "ldb_test", fetch: fetchImpl }),
    setLive(ref, content) {
      const subject = subjectOf(ref);
      const version = addVersion(subject, content, "approved", "test");
      makeLive(subject, version);
      return version.id;
    },
    startTrial(ref, content, share = 1) {
      const subject = subjectOf(ref);
      const version = addVersion(subject, content, "trial", "test");
      subject.trial = { id: nextId("trl"), versionId: version.id, share };
      return version.id;
    },
    stopTrial(ref) {
      const subject = subjectOf(ref);
      const candidate = subject.trial === null ? undefined : byId(subject, subject.trial.versionId);
      if (candidate?.status === "trial") candidate.status = "draft";
      subject.trial = null;
    },
    rollback(ref) {
      const subject = subjectOf(ref);
      const current = byId(subject, subject.liveId);
      if (current === undefined) return;
      const previous = [...subject.versions].reverse().find((v) => v.status === "retired");
      current.status = "rejected";
      subject.liveId = null;
      if (previous !== undefined) makeLive(subject, previous);
    },
    versions: (ref) => subjects.get(ref)?.versions ?? [],
    codeProposals: (ref) => subjects.get(ref)?.codeProposals ?? [],
    schemaOf: (ref) => subjects.get(ref)?.schema,
    setDown(value) {
      down = value;
    },
    queueRun(run) {
      runs.push(run);
    },
    traces,
    spansOf: (traceId) => [...spans.values()].filter((span) => span.traceId === traceId),
    scores,
    requests,
    memory: {
      files(space, options = {}) {
        const layer = options.user === undefined ? "org" : "user";
        const copy = memorySpaces.get(`${layer}:${space}`)?.copies.get(`${options.org ?? "default"}\n${options.user ?? ""}`);
        return Object.fromEntries([...(copy?.files ?? new Map<string, { content: string }>())].map(([path, f]) => [path, f.content]));
      },
      waiting: () => memoryChanges.filter((c) => c.status === "waiting"),
      changes: memoryChanges,
      approve: (changeId) => decide(changeId, "approved"),
      reject: (changeId) => decide(changeId, "rejected"),
      setReview(space, review) {
        spaceOf("org", space).review = review;
      },
      put(space, path, content, options = {}) {
        applyEdits(copyOf(spaceOf("org", space), options.org ?? "default", ""), [{ path, op: "put", content }]);
      },
    },
  };
}

const isPlainRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
