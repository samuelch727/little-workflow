import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { LittleDBErrorHandler } from "./exporter.js";
import { LittleDBError, type Transport } from "./http.js";
import { clipText, sha256Hex } from "./util.js";

/**
 * Managed memory: Harness `memory()` options whose files LittleDB keeps. `db.memory.org()` is a
 * folder an org shares (company knowledge), `db.memory.user()` one per person. Each turn loads
 * its copy from LittleDB and stores what the turn changed; an org change waits for a person in
 * the Memory tab unless the space says otherwise. Offline (`littleDBFromEnv` without
 * `LITTLEDB_URL`) the same options are local folders.
 */

/** Who is in the conversation, as your sign-in knows them. `id` is yours; send a hash if LittleDB should never see real ids. */
export type MemoryPerson = { readonly id: string; readonly label?: string | undefined; readonly role?: string | undefined };

/** person: an agent's change waits for a person. after: it goes live at once and is listed. none: it goes live. */
export type MemoryReview = "person" | "after" | "none";

type FromTurn<TExtraBody, T> = (options: { readonly extraBody?: TExtraBody | undefined }) => T;

type SharedOptions<TExtraBody> = {
  /** Which org's copy this turn uses, from `extraBody`. Leave out for one org per project. Returning nothing fails the turn. */
  readonly org?: FromTurn<TExtraBody, string | null | undefined> | undefined;
  /** What the memory holds, shown to the agent every turn. Say who may change it. */
  readonly description?: string | undefined;
  /** Where the agent sees it. */
  readonly harnessDir?: string | undefined;
  /** Passed through to Harness `memory()`. */
  readonly instructions?: string | undefined;
  readonly maxIndexBytes?: number | undefined;
  readonly skill?: false | undefined;
};

export type OrgMemoryOptions<TExtraBody = unknown> = SharedOptions<TExtraBody> & {
  /** The shared folder's name, e.g. `lending-rules`. A harness and a workflow that name the same space share it. */
  readonly space: string;
  /** Who may change it from a conversation. Default: nobody (stricter than Harness's own default). */
  readonly canWrite?: FromTurn<TExtraBody, boolean | Promise<boolean>> | undefined;
  /** Default `person`. Set when the space is first seen; after that the Memory tab owns it. */
  readonly review?: MemoryReview | undefined;
  /**
   * A folder in your repo that becomes version 1 of the space: a path (from the working
   * directory), a `file:` URL (`new URL("./memory/lending-rules", import.meta.url)`), or the files
   * themselves. Later edits arrive in the Memory tab as one "Changed in code" change.
   */
  readonly seed?: string | URL | Readonly<Record<string, string>> | undefined;
  /** Who said it, so a change in the Memory tab names the person. */
  readonly by?: FromTurn<TExtraBody, MemoryPerson | null | undefined> | undefined;
};

export type UserMemoryOptions<TExtraBody = unknown> = SharedOptions<TExtraBody> & {
  /** The person this turn is for: `{ id, label? }` or an id. Returning nothing fails the turn. */
  readonly user: FromTurn<TExtraBody, MemoryPerson | string | null | undefined>;
  /** The person space's name. Default `me`. */
  readonly space?: string | undefined;
  /** Who may change it. Default: the person, always. */
  readonly canWrite?: FromTurn<TExtraBody, boolean | Promise<boolean>> | undefined;
};

/** What a load sends back to its store. */
type Cursor = { readonly lease?: string; readonly revisions: Readonly<Record<string, string>>; readonly writable: boolean };

type LoadOptionsLike<TExtraBody> = { readonly extraBody?: TExtraBody | undefined; readonly session: { readonly id: string } };
type StoreOptionsLike<TExtraBody> = LoadOptionsLike<TExtraBody> & {
  readonly changes: {
    readonly created: Readonly<Record<string, Uint8Array>>;
    readonly updated: Readonly<Record<string, Uint8Array>>;
    readonly deleted: readonly string[];
  };
  readonly cursor?: unknown;
};

const MANAGED = Symbol.for("@little-stack/littledb/memory");

/**
 * What `db.memory.org()` and `db.memory.user()` return: an ordinary Harness `memory()` option
 * (`HarnessMemoryOptions` from `@little-stack/harness` takes it), with a LittleDB backend.
 */
export type ManagedMemoryOption<TExtraBody = unknown> = {
  readonly harnessDir: string;
  readonly description?: string;
  readonly instructions?: string;
  readonly maxIndexBytes?: number;
  readonly skill?: false;
  readonly canWrite: FromTurn<TExtraBody, boolean | Promise<boolean>>;
  readonly backend?: {
    readonly load: (options: LoadOptionsLike<TExtraBody>) => Promise<{ files: Record<string, string>; cursor: Cursor }>;
    readonly store: (options: StoreOptionsLike<TExtraBody>) => Promise<void>;
  };
  readonly [MANAGED]: ManagedMemoryInfo<TExtraBody>;
};

type ManagedMemoryInfo<TExtraBody> = {
  readonly layer: "org" | "user";
  readonly space: string;
  readonly description: string | undefined;
  /** Read it without a harness (a workflow's `prepare`): read-only. */
  read(options: { readonly extraBody?: TExtraBody | undefined; readonly sessionId: string; readonly subject?: string }): Promise<LoadedMemory>;
};

/** One memory as a turn or run loaded it. */
export type LoadedMemory = {
  readonly layer: "org" | "user";
  readonly space: string;
  readonly description: string | undefined;
  readonly files: Readonly<Record<string, string>>;
  /** What the trace records: exactly these revisions. Undefined offline or from the last known copy. */
  readonly snapshot: string | undefined;
};

/** A person's memory as your app shows it to them (`db.memory.handler`, `GET`). */
export type PersonMemory = {
  readonly spaces: readonly {
    readonly space: string;
    readonly description: string | null;
    readonly files: readonly { readonly path: string; readonly summary: string | null; readonly content: string; readonly updatedAt: string | null }[];
  }[];
};

export type MemoryHandlerOptions = {
  /** Your session check: the person asking, or `null` to refuse with 401. */
  readonly authorize: (request: Request) => { readonly user: string; readonly org?: string | undefined } | null | undefined | Promise<{ readonly user: string; readonly org?: string | undefined } | null | undefined>;
};

export type ManagedMemory = {
  /** A folder an org shares, such as company knowledge. Read-only in conversations unless `canWrite`. */
  org<TExtraBody = unknown>(options: OrgMemoryOptions<TExtraBody>): ManagedMemoryOption<TExtraBody>;
  /** One folder per person: what the agent learns about them. Saves as it goes. */
  user<TExtraBody = unknown>(options: UserMemoryOptions<TExtraBody>): ManagedMemoryOption<TExtraBody>;
  /**
   * A Fetch handler for your backend, so a person sees and forgets their own memory without the
   * key: `GET` lists it, `DELETE ?space=&path=` forgets a file, `DELETE ?all=true` forgets everything.
   */
  handler(options: MemoryHandlerOptions): (request: Request) => Promise<Response>;
  /** Forget everything a person's memory holds, in every person space (when they delete their account). */
  forgetUser(options: { readonly user: string; readonly org?: string | undefined }): Promise<{ files: number }>;
};

// --- What the tracer and the memory share -------------------------------------------------------

export type MemoryLoadLink = {
  readonly layer: "org" | "user";
  readonly space: string;
  readonly spaceId?: string | undefined;
  readonly snapshot?: string | undefined;
  readonly review?: MemoryReview | undefined;
  readonly writable: boolean;
  readonly files: number;
  /** Each loaded file's revision, by its path in the memory: which version a step read. */
  readonly revisions?: Readonly<Record<string, string>> | undefined;
  /** Loaded from the last known copy or offline, not from LittleDB. */
  readonly fallback?: "last_known" | "empty" | "offline" | undefined;
};

export type MemoryStoreLink = { readonly space: string; readonly status: "saved" | "waiting" | "unchanged" | "not_saved"; readonly change?: string | undefined };

/**
 * One client's tracers and memories, joined by session: the tracer says which harness, trace and
 * message a turn is, so a store can say where a memory came from; the memory says which
 * revisions a turn loaded and what its store did, so the trace can show it.
 */
export type MemoryLinks = {
  turn(sessionId: string, turn: { readonly subject?: string; readonly traceId?: string; readonly said?: string }): void;
  turnOf(sessionId: string): { readonly subject?: string; readonly traceId?: string; readonly said?: string } | undefined;
  loaded(sessionId: string, harnessDir: string, link: MemoryLoadLink): void;
  loadOf(sessionId: string, harnessDir: string): MemoryLoadLink | undefined;
  stored(sessionId: string, harnessDir: string, link: MemoryStoreLink): void;
  storeOf(sessionId: string, harnessDir: string): MemoryStoreLink | undefined;
  /** The memories the session's turns loaded, by folder: where a step's paths belong. */
  loadsOf(sessionId: string): readonly { readonly harnessDir: string; readonly link: MemoryLoadLink }[];
  /** A step (its span) wrote or deleted a memory file, so the store can say which step each change came from. */
  wrote(sessionId: string, harnessDir: string, path: string, spanId: string): void;
  /** The steps that changed this memory's files since its last store, by path; taking them clears them. */
  takeSteps(sessionId: string, harnessDir: string): Record<string, string>;
};

const MAX_LINKS = 10_000;

function bounded<V>(): { get(key: string): V | undefined; set(key: string, value: V): void } {
  const map = new Map<string, V>();
  return {
    get: (key) => map.get(key),
    set(key, value) {
      map.delete(key);
      map.set(key, value);
      while (map.size > MAX_LINKS) {
        const oldest = map.keys().next().value;
        if (oldest === undefined) break;
        map.delete(oldest);
      }
    },
  };
}

export function createMemoryLinks(): MemoryLinks {
  const turns = bounded<{ subject?: string; traceId?: string; said?: string }>();
  const loads = bounded<MemoryLoadLink>();
  const stores = bounded<MemoryStoreLink>();
  const dirs = bounded<string[]>();
  const steps = bounded<Record<string, string>>();
  const key = (sessionId: string, harnessDir: string) => `${sessionId}\u0000${harnessDir}`;
  return {
    turn(sessionId, turn) {
      turns.set(sessionId, { ...turns.get(sessionId), ...turn });
    },
    turnOf: (sessionId) => turns.get(sessionId),
    loaded(sessionId, harnessDir, link) {
      loads.set(key(sessionId, harnessDir), link);
      const known = dirs.get(sessionId) ?? [];
      dirs.set(sessionId, known.includes(harnessDir) ? known : [...known, harnessDir]);
    },
    loadOf: (sessionId, harnessDir) => loads.get(key(sessionId, harnessDir)),
    stored: (sessionId, harnessDir, link) => stores.set(key(sessionId, harnessDir), link),
    storeOf: (sessionId, harnessDir) => stores.get(key(sessionId, harnessDir)),
    loadsOf: (sessionId) =>
      (dirs.get(sessionId) ?? []).flatMap((harnessDir) => {
        const link = loads.get(key(sessionId, harnessDir));
        return link === undefined ? [] : [{ harnessDir, link }];
      }),
    wrote(sessionId, harnessDir, path, spanId) {
      steps.set(key(sessionId, harnessDir), { ...steps.get(key(sessionId, harnessDir)), [path]: spanId });
    },
    takeSteps(sessionId, harnessDir) {
      const taken = steps.get(key(sessionId, harnessDir)) ?? {};
      steps.set(key(sessionId, harnessDir), {});
      return taken;
    },
  };
}

// --- Seeds -------------------------------------------------------------------------------------

type Seed = { readonly hash: string; readonly files: Record<string, string> };

function readFolder(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      if (name.startsWith(".")) continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else out[relative(root, full).split(sep).join("/")] = readFileSync(full, "utf8");
    }
  };
  walk(root);
  return out;
}

function seedFiles(seed: OrgMemoryOptions["seed"]): Record<string, string> | undefined {
  if (seed === undefined) return undefined;
  if (typeof seed === "string" || seed instanceof URL) {
    const root = typeof seed === "string" ? resolve(seed) : fileURLToPath(seed);
    if (!existsSync(root)) throw new TypeError(`db.memory.org: the seed folder ${root} does not exist.`);
    return readFolder(root);
  }
  return { ...seed };
}

function seedOf(files: Record<string, string>): Seed {
  const entries = Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return { hash: `seed_${sha256Hex(JSON.stringify(entries)).slice(0, 40)}`, files };
}

// --- The helpers -------------------------------------------------------------------------------

const SPACE = /^[a-z0-9][a-z0-9_.-]{0,63}$/u;
const REVIEW_NOTE =
  "A person reviews changes to this memory before other conversations use them. After you save a change here, tell the person it is waiting for review.";
const decoder = new TextDecoder();

type Spec<TExtraBody> = {
  readonly layer: "org" | "user";
  readonly space: string;
  readonly harnessDir: string;
  readonly description: string | undefined;
  readonly review: MemoryReview | undefined;
  readonly org: (extraBody: TExtraBody | undefined) => string;
  readonly person: (extraBody: TExtraBody | undefined) => MemoryPerson | undefined;
  readonly by: (extraBody: TExtraBody | undefined) => MemoryPerson | undefined;
  readonly canWrite: FromTurn<TExtraBody, boolean | Promise<boolean>>;
  readonly seed: () => Seed | undefined;
};

type Deps = {
  readonly transport: Transport;
  readonly onError: LittleDBErrorHandler;
  readonly links: MemoryLinks;
  /** Keep memory in local folders here instead of LittleDB. */
  readonly localDir?: string | undefined;
};

type LoadAnswer =
  | { seedWanted: true }
  | {
      seedWanted?: undefined;
      space: { id: string; layer: "org" | "user"; slug: string; review: MemoryReview };
      files: Record<string, string>;
      revisions: Record<string, string>;
      snapshot: string;
      lease: string;
    };

type StoreAnswer = { status: "saved" | "waiting" | "unchanged"; change?: string };

const isPerson = (value: unknown): value is MemoryPerson => typeof value === "object" && value !== null && typeof (value as { id?: unknown }).id === "string";

function checkKey(value: string, what: string): string {
  if (value.length === 0 || value.length > 200 || value.includes("/") || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`db.memory: ${what} must be 1 to 200 characters with no "/" or control characters.`);
  }
  return value;
}

export function createManagedMemory(deps: Deps): ManagedMemory {
  const lastKnown = bounded<Record<string, string>>();

  async function request<T>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<T> {
    try {
      return await deps.transport.request<T>(method, path, body);
    } catch (error) {
      if (!(error instanceof LittleDBError) || !error.retryable) throw error;
      return await deps.transport.request<T>(method, path, body);
    }
  }

  async function load<TExtraBody>(spec: Spec<TExtraBody>, options: LoadOptionsLike<TExtraBody>, subject?: string) {
    const extraBody = options.extraBody;
    const org = spec.org(extraBody);
    const person = spec.person(extraBody);
    const writable = (await spec.canWrite({ extraBody })) === true;
    const turn = deps.links.turnOf(options.session.id);
    const seed = spec.seed();
    const memoryKey = `${spec.layer}\u0000${spec.space}\u0000${org}\u0000${person?.id ?? ""}`;
    const input = {
      layer: spec.layer,
      space: spec.space,
      org,
      ...(person === undefined ? {} : { user: person.id, ...(person.label === undefined ? {} : { userLabel: person.label }) }),
      session: options.session.id,
      ...((subject ?? turn?.subject) === undefined ? {} : { subject: subject ?? turn?.subject }),
      ...(spec.description === undefined ? {} : { description: clipText(spec.description, 2000) }),
      harnessDir: spec.harnessDir,
      ...(spec.review === undefined ? {} : { review: spec.review }),
      writable,
      ...(seed === undefined ? {} : { seedHash: seed.hash }),
    };
    try {
      let answer = await request<LoadAnswer>("POST", "/memory/load", input);
      if (answer.seedWanted) answer = await request<LoadAnswer>("POST", "/memory/load", { ...input, seed: seed?.files ?? {} });
      if (answer.seedWanted) throw new LittleDBError("LittleDB asked for the seed twice.", 500, "seed_loop");
      lastKnown.set(memoryKey, answer.files);
      deps.links.loaded(options.session.id, spec.harnessDir, {
        layer: spec.layer,
        space: spec.space,
        spaceId: answer.space.id,
        snapshot: answer.snapshot,
        review: answer.space.review,
        writable,
        files: Object.keys(answer.files).length,
        revisions: answer.revisions,
      });
      const cursor: Cursor = { lease: answer.lease, revisions: answer.revisions, writable };
      return { files: answer.files, cursor, snapshot: answer.snapshot as string | undefined };
    } catch (error) {
      // A mistake in the code (a bad space name, a key without ingest) should be seen; an outage
      // shouldn't stop the conversation: the last copy this process had, or none.
      if (error instanceof LittleDBError && !error.retryable) throw error;
      deps.onError(error, { operation: "memory.load" });
      const files = lastKnown.get(memoryKey);
      deps.links.loaded(options.session.id, spec.harnessDir, {
        layer: spec.layer,
        space: spec.space,
        writable,
        files: Object.keys(files ?? {}).length,
        fallback: files === undefined ? "empty" : "last_known",
      });
      const cursor: Cursor = { revisions: {}, writable };
      return { files: { ...(files ?? {}) }, cursor, snapshot: undefined };
    }
  }

  async function store<TExtraBody>(spec: Spec<TExtraBody>, options: StoreOptionsLike<TExtraBody>) {
    const cursor = options.cursor as Cursor | undefined;
    const created = Object.fromEntries(Object.entries(options.changes.created).map(([p, bytes]) => [p, decoder.decode(bytes)]));
    const updated = Object.fromEntries(Object.entries(options.changes.updated).map(([p, bytes]) => [p, decoder.decode(bytes)]));
    const deleted = [...options.changes.deleted];
    const paths = [...Object.keys(created), ...Object.keys(updated), ...deleted];
    if (paths.length === 0) return;
    if (cursor?.lease === undefined) {
      deps.links.stored(options.session.id, spec.harnessDir, { space: spec.space, status: "not_saved" });
      deps.onError(
        new Error(`memory ${spec.space}: this turn loaded it while LittleDB was unreachable, so its changes (${paths.join(", ")}) were not saved.`),
        { operation: "memory.store" },
      );
      return;
    }
    const base: Record<string, string> = {};
    for (const path of [...Object.keys(updated), ...deleted]) {
      const revision = cursor.revisions[path];
      if (revision !== undefined) base[path] = revision;
    }
    const turn = deps.links.turnOf(options.session.id);
    const by = spec.layer === "user" ? spec.person(options.extraBody) : spec.by(options.extraBody);
    // The step (span) in this turn's trace that wrote each file, when the tracer saw it.
    const wrote = deps.links.takeSteps(options.session.id, spec.harnessDir);
    const steps = Object.fromEntries(paths.flatMap((path) => (wrote[path] === undefined ? [] : [[path, wrote[path]]])));
    const answer = await request<StoreAnswer>("POST", "/memory/store", {
      lease: cursor.lease,
      created,
      updated,
      deleted,
      base,
      ...(turn?.subject === undefined ? {} : { subject: turn.subject }),
      ...(turn?.traceId === undefined ? {} : { traceId: turn.traceId }),
      ...(turn?.said === undefined ? {} : { said: clipText(turn.said, 4000) }),
      ...(Object.keys(steps).length === 0 ? {} : { steps }),
      ...(by === undefined ? {} : { by: { id: by.id, ...(by.label === undefined ? {} : { label: by.label }), ...(by.role === undefined ? {} : { role: by.role }) } }),
    });
    deps.links.stored(options.session.id, spec.harnessDir, { space: spec.space, status: answer.status, ...(answer.change === undefined ? {} : { change: answer.change }) });
  }

  /** Offline: the folder this turn's copy lives in, seeded the first time. */
  function localFolder<TExtraBody>(spec: Spec<TExtraBody>, extraBody: TExtraBody | undefined): string {
    const root = resolve(deps.localDir!);
    const org = encodeURIComponent(spec.org(extraBody));
    const folder =
      spec.layer === "org"
        ? join(root, "org", org, spec.space)
        : join(root, "people", org, encodeURIComponent(spec.person(extraBody)!.id), spec.space);
    if (!existsSync(folder)) {
      mkdirSync(folder, { recursive: true });
      for (const [path, content] of Object.entries(spec.seed()?.files ?? {})) {
        const target = join(folder, ...path.split("/"));
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, content);
      }
    }
    return folder;
  }

  function option<TExtraBody>(spec: Spec<TExtraBody>, shared: SharedOptions<TExtraBody>): ManagedMemoryOption<TExtraBody> {
    const instructions = [spec.layer === "org" && (spec.review ?? "person") === "person" && deps.localDir === undefined ? REVIEW_NOTE : undefined, shared.instructions?.trim()]
      .filter((s): s is string => s !== undefined && s.length > 0)
      .join("\n\n");
    const info: ManagedMemoryInfo<TExtraBody> = {
      layer: spec.layer,
      space: spec.space,
      description: spec.description,
      async read({ extraBody, sessionId, subject }) {
        if (deps.localDir !== undefined) {
          const folder = localFolder(spec, extraBody);
          return { layer: spec.layer, space: spec.space, description: spec.description, files: readFolder(folder), snapshot: undefined };
        }
        const readOnly: Spec<TExtraBody> = { ...spec, canWrite: () => false };
        const loaded = await load(readOnly, { ...(extraBody === undefined ? {} : { extraBody }), session: { id: sessionId } }, subject);
        return { layer: spec.layer, space: spec.space, description: spec.description, files: loaded.files, snapshot: loaded.snapshot };
      },
    };
    const base = {
      harnessDir: spec.harnessDir,
      ...(spec.description === undefined ? {} : { description: spec.description }),
      ...(instructions.length === 0 ? {} : { instructions }),
      ...(shared.maxIndexBytes === undefined ? {} : { maxIndexBytes: shared.maxIndexBytes }),
      ...(shared.skill === false ? { skill: false as const } : {}),
      canWrite: spec.canWrite,
      [MANAGED]: info,
    };
    if (deps.localDir !== undefined) {
      // A folder per copy, read at load and written at store (Harness's own sourceDir must live in its dataDir).
      return {
        ...base,
        backend: {
          load: async ({ extraBody }) => ({ files: readFolder(localFolder(spec, extraBody)), cursor: { revisions: {}, writable: true } }),
          store: async ({ extraBody, changes }) => {
            const folder = localFolder(spec, extraBody);
            for (const [path, bytes] of [...Object.entries(changes.created), ...Object.entries(changes.updated)]) {
              const target = join(folder, ...path.split("/"));
              mkdirSync(dirname(target), { recursive: true });
              writeFileSync(target, bytes);
            }
            for (const path of changes.deleted) rmSync(join(folder, ...path.split("/")), { force: true });
          },
        },
      };
    }
    return {
      ...base,
      backend: {
        load: async (options) => {
          const { files, cursor } = await load(spec, options);
          return { files, cursor };
        },
        store: (options) => store(spec, options),
      },
    };
  }

  function orgOf<TExtraBody>(fn: SharedOptions<TExtraBody>["org"], helper: string) {
    return (extraBody: TExtraBody | undefined): string => {
      if (fn === undefined) return "default";
      const org = fn({ extraBody });
      if (typeof org !== "string" || org.length === 0) throw new TypeError(`${helper}: org returned nothing for this turn, so it can't tell whose memory to load.`);
      return checkKey(org, "org");
    };
  }

  return {
    org<TExtraBody = unknown>(options: OrgMemoryOptions<TExtraBody>) {
      if (typeof options?.space !== "string" || !SPACE.test(options.space)) {
        throw new TypeError("db.memory.org needs a space: lowercase letters, digits, '.', '_' or '-', up to 64.");
      }
      if (options.review !== undefined && !["person", "after", "none"].includes(options.review)) {
        throw new TypeError('db.memory.org: review is "person", "after" or "none".');
      }
      let seed: Seed | null | undefined;
      const by = options.by;
      const spec: Spec<TExtraBody> = {
        layer: "org",
        space: options.space,
        harnessDir: options.harnessDir ?? `/persistent/org/${options.space}`,
        description: options.description,
        review: options.review,
        org: orgOf(options.org, "db.memory.org"),
        person: () => undefined,
        by: (extraBody) => {
          const who = by?.({ extraBody });
          return isPerson(who) ? who : undefined;
        },
        canWrite: options.canWrite ?? (() => false),
        seed: () => {
          if (seed === undefined) {
            const files = seedFiles(options.seed);
            seed = files === undefined ? null : seedOf(files);
          }
          return seed ?? undefined;
        },
      };
      return option(spec, options);
    },

    user<TExtraBody = unknown>(options: UserMemoryOptions<TExtraBody>) {
      if (typeof options?.user !== "function") throw new TypeError("db.memory.user needs user: ({ extraBody }) => ({ id, label }).");
      const space = options.space ?? "me";
      if (!SPACE.test(space)) throw new TypeError("db.memory.user: space is lowercase letters, digits, '.', '_' or '-', up to 64.");
      const userFn = options.user;
      const person = (extraBody: TExtraBody | undefined): MemoryPerson => {
        const who = userFn({ extraBody });
        const found = typeof who === "string" ? { id: who } : isPerson(who) ? who : undefined;
        if (found === undefined || found.id.length === 0) throw new TypeError("db.memory.user: user returned nobody for this turn, so it can't tell whose memory to load.");
        checkKey(found.id, "user id");
        return found;
      };
      const spec: Spec<TExtraBody> = {
        layer: "user",
        space,
        harnessDir: options.harnessDir ?? (space === "me" ? "/persistent/me" : `/persistent/me-${space}`),
        description: options.description,
        review: undefined,
        org: orgOf(options.org, "db.memory.user"),
        person,
        by: person,
        canWrite: options.canWrite ?? (() => true),
        seed: () => undefined,
      };
      return option(spec, options);
    },

    handler(options) {
      if (typeof options?.authorize !== "function") throw new TypeError("db.memory.handler needs an authorize(request) function.");
      const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
      const problem = (status: number, code: string, message: string) => reply(status, { error: { code, message } });
      return async (request) => {
        try {
          if (request.method !== "GET" && request.method !== "DELETE") return problem(405, "method_not_allowed", "GET lists your memory; DELETE forgets it.");
          const who = await options.authorize(request);
          if (who === null || who === undefined || typeof who.user !== "string" || who.user.length === 0) return problem(401, "unauthorized", "Sign in to see your memory.");
          const query = new URLSearchParams({ user: who.user, ...(who.org === undefined ? {} : { org: who.org }) });
          const url = new URL(request.url, "http://localhost");
          if (deps.localDir !== undefined) return localHandler(request.method, url, who);
          if (request.method === "GET") {
            const raw = await deps.transport.request<{ spaces: { space: { slug: string; description: string | null }; files: { path: string; summary: string | null; content: string; updatedAt: string | null }[] }[] }>(
              "GET",
              `/memory/person?${query}`,
            );
            const out: PersonMemory = {
              spaces: raw.spaces.map((s) => ({
                space: s.space.slug,
                description: s.space.description,
                files: s.files.map((f) => ({ path: f.path, summary: f.summary, content: f.content, updatedAt: f.updatedAt })),
              })),
            };
            return reply(200, out);
          }
          const path = url.searchParams.get("path");
          if (path !== null) {
            query.set("space", url.searchParams.get("space") ?? "me");
            query.set("path", path);
            await deps.transport.request("DELETE", `/memory/person/files?${query}`);
            return reply(200, { forgotten: path });
          }
          if (url.searchParams.get("all") !== "true") return problem(400, "bad_request", "Say what to forget: ?space=&path= for one file, or ?all=true for everything.");
          const result = await deps.transport.request<{ files: number }>("DELETE", `/memory/person?${query}`);
          return reply(200, { forgotten: "all", files: result.files });
        } catch (error) {
          if (error instanceof LittleDBError && error.status === 404) return problem(404, "not_found", "There is no such memory.");
          deps.onError(error, { operation: "memory.handler" });
          return problem(502, "unavailable", "Memory is unavailable right now.");
        }
      };
    },

    async forgetUser(options) {
      const query = new URLSearchParams({ user: checkKey(options.user, "user"), ...(options.org === undefined ? {} : { org: options.org }) });
      if (deps.localDir !== undefined) return { files: forgetLocal(options) };
      return await deps.transport.request<{ files: number }>("DELETE", `/memory/person?${query}`);
    },
  };

  // --- Offline: a person's folders under <localDir>/people/<org>/<user>/<space> ---------------------

  function personDir(who: { readonly user: string; readonly org?: string | undefined }): string {
    return join(resolve(deps.localDir!), "people", encodeURIComponent(who.org ?? "default"), encodeURIComponent(checkKey(who.user, "user")));
  }

  function forgetLocal(who: { readonly user: string; readonly org?: string | undefined }): number {
    const dir = personDir(who);
    if (!existsSync(dir)) return 0;
    const spaces = readdirSync(dir).filter((name) => statSync(join(dir, name)).isDirectory());
    const files = spaces.reduce((n, space) => n + Object.keys(readFolder(join(dir, space))).length, 0);
    rmSync(dir, { recursive: true, force: true });
    return files;
  }

  function localHandler(method: string, url: URL, who: { readonly user: string; readonly org?: string | undefined }): Response {
    const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
    const dir = personDir(who);
    if (method === "GET") {
      const spaces = existsSync(dir) ? readdirSync(dir).filter((name) => statSync(join(dir, name)).isDirectory()).sort() : [];
      const out: PersonMemory = {
        spaces: spaces.map((space) => ({
          space,
          description: null,
          files: Object.entries(readFolder(join(dir, space))).map(([path, content]) => ({
            path,
            summary: localSummary(content),
            content,
            updatedAt: statSync(join(dir, space, ...path.split("/"))).mtime.toISOString(),
          })),
        })),
      };
      return reply(200, out);
    }
    const path = url.searchParams.get("path");
    if (path !== null) {
      const space = url.searchParams.get("space") ?? "me";
      const parts = path.split("/");
      if (!SPACE.test(space) || parts.some((part) => part === "" || part === "." || part === "..")) return reply(400, { error: { code: "bad_request", message: "Not a memory path." } });
      const target = join(dir, space, ...parts);
      if (!existsSync(target)) return reply(404, { error: { code: "not_found", message: "There is no such memory." } });
      rmSync(target, { force: true });
      return reply(200, { forgotten: path });
    }
    if (url.searchParams.get("all") !== "true") return reply(400, { error: { code: "bad_request", message: "Say what to forget: ?space=&path= for one file, or ?all=true for everything." } });
    return reply(200, { forgotten: "all", files: forgetLocal(who) });
  }
}

/** A file's line in a list: its frontmatter description, else its first line of text. */
function localSummary(content: string): string | null {
  const front = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(content);
  const description = front ? /^description:[ \t]*(.+)$/mu.exec(front[1]!)?.[1]?.trim() : undefined;
  if (description) return description.replace(/^"(.*)"$/u, "$1");
  const body = front ? content.slice(front[0].length) : content;
  return body.split("\n").map((line) => line.trim()).find((line) => line.length > 0)?.slice(0, 200) ?? null;
}

// --- Workflows ----------------------------------------------------------------------------------

const NOTE_MAX_BYTES = 64 * 1024;

/** The memories a managed workflow named, read for one run, and the note its steps can be given. */
export type WorkflowMemory = {
  readonly loaded: readonly LoadedMemory[];
  /** The memory as text for a step's system prompt: each space, its description, and its files. */
  note(): string;
};

export async function readWorkflowMemory(
  memories: readonly ManagedMemoryOption<never>[] | readonly ManagedMemoryOption<unknown>[],
  options: { readonly extraBody?: unknown; readonly sessionId: string; readonly subject: string },
): Promise<WorkflowMemory> {
  const loaded: LoadedMemory[] = [];
  for (const memory of memories as readonly ManagedMemoryOption<unknown>[]) {
    const info = memory[MANAGED];
    if (info === undefined) throw new TypeError("managedWorkflow memory takes db.memory.org(...) or db.memory.user(...).");
    loaded.push(await info.read({ extraBody: options.extraBody, sessionId: options.sessionId, subject: options.subject }));
  }
  return {
    loaded,
    note() {
      const parts = ["# Memory", "What the organization has learned, kept in LittleDB. Use it; it is read-only here."];
      for (const m of loaded) {
        parts.push(`## ${m.space}`);
        if (m.description !== undefined) parts.push(m.description);
        const paths = Object.keys(m.files).sort();
        if (paths.length === 0) parts.push("No memories yet.");
        for (const path of paths) parts.push(`### ${path}\n${m.files[path]}`);
      }
      const text = parts.join("\n\n");
      const bytes = Buffer.byteLength(text);
      return bytes <= NOTE_MAX_BYTES ? text : `${Buffer.from(text).subarray(0, NOTE_MAX_BYTES).toString("utf8")}\n\n(Cut at ${NOTE_MAX_BYTES / 1024} KB.)`;
    },
  };
}

/** Whether a value is one of these options (for a memory array that mixes in your own). */
export function isManagedMemory(value: unknown): value is ManagedMemoryOption<unknown> {
  return typeof value === "object" && value !== null && MANAGED in value;
}
