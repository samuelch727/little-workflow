import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { ResolveResponseSchema, type Caller, type CodeState, type ResolvedModel, type ResolveMode, type SubjectKind } from "./contract.js";
import { withoutModel } from "./models.js";
import { currentEvalContext, pinFor } from "./eval-context.js";
import type { LittleDBErrorHandler } from "./exporter.js";
import { LittleDBError, type Transport } from "./http.js";
import { isRecord } from "./util.js";

/** Version content as LittleDB stores it: a plain JSON object. */
export type Content = Readonly<Record<string, unknown>>;

/**
 * Checks a version's content before your app runs it. A Zod schema fits (`z.object({ ... })`).
 * Content it rejects never runs: your bootstrap runs instead and `onError` hears why.
 */
export type ContentSchema<C = Content> = {
  safeParse(value: unknown): { readonly success: true; readonly data: C } | { readonly success: false; readonly error: unknown };
};

export type ResolveInput<C = Content> = {
  readonly kind: SubjectKind;
  readonly slug: string;
  /** Release channel. Default `production`. */
  readonly channel?: string | undefined;
  /**
   * A session or user id. The same key always gets the same side of a trial, and its answer is
   * kept for the session so a promotion mid-conversation never switches its prompt. A rollback
   * still reaches it: the answer is checked again every `revalidateMs`.
   */
  readonly stickyKey?: string | undefined;
  /**
   * The config in your code. LittleDB makes it version 1 when nothing is live yet. After that a
   * change to it becomes a "Changed in code" proposal that LittleDB carries onto the live
   * version. It is also what runs when LittleDB cannot be reached.
   */
  readonly bootstrap?: NoInfer<C> | undefined;
  /**
   * The content your app can run. Content that does not match never runs, and LittleDB is told
   * the shape (as JSON Schema) so it checks every candidate against it before spending anything.
   */
  readonly schema?: ContentSchema<C> | undefined;
  /** The JSON Schema to send instead of the one made from `schema` (for a schema that is not Zod 4). */
  readonly jsonSchema?: Readonly<Record<string, unknown>> | undefined;
  /** The workflow (and step) running this harness or workflow, so LittleDB learns who calls whom. */
  readonly caller?: Caller | undefined;
};

export type Resolution<C = Content> = {
  readonly kind: SubjectKind;
  readonly slug: string;
  readonly channel: string;
  readonly subjectId: string | null;
  /** The LittleDB version to record on traces. `null` when nothing is live, LittleDB was unreachable, or its content was rejected. */
  readonly versionId: string | null;
  readonly number: number | null;
  readonly status: string | null;
  /**
   * `live`; `trial` (this key is in a trial of a candidate); `holdout` (this key is in the project
   * holdout, which keeps a small share of traffic on an older version); `none` (nothing live);
   * `pinned` (an experiment run named this version).
   */
  readonly mode: ResolveMode | "pinned";
  /** The version's content, e.g. `{ system, model }`; your bootstrap when `fallback` is `bootstrap`. */
  readonly content: C | null;
  /**
   * Set when your app is not running what LittleDB answered: `last_known` (LittleDB could not be
   * reached; the last live answer for this subject), `bootstrap` (unreachable and nothing known;
   * your code's config) or `invalid` (LittleDB's version did not match `schema`; your bootstrap).
   */
  readonly fallback?: "last_known" | "bootstrap" | "invalid";
  readonly error?: string;
  /** What LittleDB did with your bootstrap, once something is live: `changed` names the proposal it opened. */
  readonly code?: { readonly state: CodeState; readonly versionId?: string | null; readonly proposalId?: string | null };
  /**
   * A harness's model for this run, held in LittleDB: the version's, the agent's setting or the
   * project's default, and who pays (`key` or `credits`). `managedHarness({ resolveModel })` runs it.
   */
  readonly model?: ResolvedModel;
};

export type ResolverOptions = {
  readonly transport: Transport;
  readonly onError: LittleDBErrorHandler;
  /** Hear when LittleDB opened a proposal for a change in your code. Default: one `console.info` per proposal. */
  readonly onCodeChange?: ((change: CodeChange) => void) | undefined;
  /** How long an answer without a sticky key is reused. Default 30 s. */
  readonly cacheTtlMs?: number | undefined;
  /** How long an answer for a sticky key (a session) is kept. Default 1 hour. */
  readonly stickyCacheTtlMs?: number | undefined;
  /**
   * How often a session's kept answer is checked again. The session keeps its version unless that
   * version was rolled back or pulled from its trial. Default 30 s.
   */
  readonly revalidateMs?: number | undefined;
  /** Give up on LittleDB after this long and use the fallback. Default 5 s. */
  readonly timeoutMs?: number | undefined;
  /** Cached answers kept. Default 1000. */
  readonly maxEntries?: number | undefined;
  /**
   * After this many failed resolves in a row, stop asking LittleDB for `breakerCooldownMs` and
   * answer from the fallback at once, so an outage costs new sessions nothing. Default 3.
   */
  readonly breakerFailures?: number | undefined;
  /** Default 30 s. */
  readonly breakerCooldownMs?: number | undefined;
  /**
   * A JSON file that keeps the last live answer of each subject, so a process that starts during
   * an outage runs the version that was live instead of your bootstrap.
   */
  readonly lastKnownFile?: string | undefined;
};

/** A change in your code's bootstrap that LittleDB turned into a proposal. */
export type CodeChange = {
  readonly kind: SubjectKind;
  readonly slug: string;
  readonly channel: string;
  readonly versionId: string | null;
  readonly proposalId: string | null;
};

export type Resolver = {
  resolve<C = Content>(input: ResolveInput<C>): Promise<Resolution<C>>;
  /** Forget cached answers, so the next resolve asks LittleDB. */
  clear(): void;
};

type Entry = {
  readonly expires: number;
  readonly value: Promise<Resolution<unknown>>;
  /** A real answer, as opposed to a fallback. */
  readonly ok: boolean;
  checkedAt: number;
  revalidating?: Promise<Resolution<unknown>> | undefined;
};

type Known = Resolution<unknown>;

const FAILURE_TTL_MS = 5_000;
const jsonSchemas = new WeakMap<object, Record<string, unknown> | null>();

/** The JSON Schema LittleDB is sent for `schema`: Zod 4 makes one; anything else sends none. */
function jsonSchemaOf(input: ResolveInput<unknown>): Record<string, unknown> | undefined {
  if (input.jsonSchema !== undefined) return { ...input.jsonSchema };
  const schema = input.schema;
  if (schema === undefined || (typeof schema !== "object" && typeof schema !== "function")) return undefined;
  if (!jsonSchemas.has(schema)) {
    let made: Record<string, unknown> | null = null;
    try {
      const out = z.toJSONSchema(schema as never, { io: "input", unrepresentable: "any" });
      made = isRecord(out) ? out : null;
    } catch {
      made = null;
    }
    jsonSchemas.set(schema, made);
  }
  return jsonSchemas.get(schema) ?? undefined;
}

function problem(error: unknown): string {
  const issues = isRecord(error) && Array.isArray(error.issues) ? error.issues : undefined;
  if (issues !== undefined && issues.length > 0) {
    return issues
      .slice(0, 3)
      .map((issue) => {
        if (!isRecord(issue)) return String(issue);
        const path = Array.isArray(issue.path) && issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
        return `${path}${String(issue.message ?? "invalid")}`;
      })
      .join("; ");
  }
  return error instanceof Error ? error.message : String(error);
}

/** Worth tripping the breaker for: no answer, a timeout or a server error, not a bad request. */
function outage(error: unknown): boolean {
  return error instanceof LittleDBError ? error.retryable : !(error instanceof z.ZodError);
}

export function createResolver(options: ResolverOptions): Resolver {
  const cacheTtlMs = options.cacheTtlMs ?? 30_000;
  const stickyTtlMs = options.stickyCacheTtlMs ?? 3_600_000;
  const revalidateMs = options.revalidateMs ?? 30_000;
  const maxEntries = options.maxEntries ?? 1_000;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const breakerFailures = Math.max(1, options.breakerFailures ?? 3);
  const breakerCooldownMs = options.breakerCooldownMs ?? 30_000;
  const cache = new Map<string, Entry>();
  const lastKnown = new Map<string, Known>();
  const announced = new Set<string>();
  const onCodeChange =
    options.onCodeChange ??
    ((change: CodeChange) =>
      console.info(
        `[littledb] ${change.kind}:${change.slug} changed in your code. LittleDB opened proposal ${change.proposalId ?? "(none)"} to carry the change onto the live version; until it ships, the live version keeps running.`,
      ));
  let failures = 0;
  let openUntil = 0;
  let fileLoaded = false;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;

  const remember = (key: string, entry: Entry) => {
    cache.delete(key);
    cache.set(key, entry);
    while (cache.size > maxEntries) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  };

  const subjectKeyOf = (kind: string, slug: string, channel: string) => `${kind}\u0000${slug}\u0000${channel}`;

  function loadFile(): void {
    if (fileLoaded || options.lastKnownFile === undefined) return;
    fileLoaded = true;
    try {
      const saved = JSON.parse(readFileSync(options.lastKnownFile, "utf8")) as { entries?: Record<string, unknown> };
      for (const [key, value] of Object.entries(saved.entries ?? {})) {
        if (!isRecord(value) || typeof value.versionId !== "string" || !isRecord(value.content)) continue;
        if (!lastKnown.has(key)) lastKnown.set(key, value as unknown as Known);
      }
    } catch (error) {
      if (!(isRecord(error) && error.code === "ENOENT")) options.onError(error, { operation: "resolve.lastKnownFile" });
    }
  }

  function scheduleSave(): void {
    const file = options.lastKnownFile;
    if (file === undefined || saveTimer !== undefined) return;
    saveTimer = setTimeout(() => {
      saveTimer = undefined;
      const entries = Object.fromEntries(
        [...lastKnown].map(([key, r]) => [
          key,
          { kind: r.kind, slug: r.slug, channel: r.channel, subjectId: r.subjectId, versionId: r.versionId, number: r.number, status: r.status, mode: r.mode, content: r.content },
        ]),
      );
      const tmp = `${file}.${process.pid}.tmp`;
      void mkdir(dirname(file), { recursive: true })
        .then(() => writeFile(tmp, `${JSON.stringify({ savedAt: new Date().toISOString(), entries }, null, 2)}\n`))
        .then(() => rename(tmp, file))
        .catch((error: unknown) => options.onError(error, { operation: "resolve.lastKnownFile" }));
    }, 1_000);
    saveTimer.unref?.();
  }

  function keepLive(subjectKey: string, value: Known): void {
    // Only a live answer is a safe fallback: a trial candidate or a held-out version is meant for a few keys.
    if (value.mode !== "live" || value.versionId === null) return;
    loadFile();
    if (lastKnown.get(subjectKey)?.versionId !== value.versionId) {
      lastKnown.set(subjectKey, value);
      scheduleSave();
    } else {
      lastKnown.set(subjectKey, value);
    }
  }

  function bootstrapAnswer(input: ResolveInput<unknown>, channel: string, error: string, fallback: "bootstrap" | "invalid"): Known {
    return {
      kind: input.kind,
      slug: input.slug,
      channel,
      subjectId: null,
      versionId: null,
      number: null,
      status: null,
      mode: "none",
      content: input.bootstrap ?? null,
      ...(input.bootstrap === undefined && fallback === "bootstrap" ? {} : { fallback }),
      error,
    };
  }

  /**
   * Content as the app runs it: checked against `schema` when there is one. A harness version's
   * `provider/model` is LittleDB's (the answer's `model`), so a schema that doesn't allow it is
   * checked without it.
   */
  function checked(input: ResolveInput<unknown>, content: unknown): { ok: true; content: unknown } | { ok: false; error: string } {
    if (input.schema === undefined || content === null) return { ok: true, content };
    const result = input.schema.safeParse(content);
    if (result.success) return { ok: true, content: result.data };
    const bare = input.kind === "harness" ? withoutModel(content) : content;
    if (bare !== content) {
      const again = input.schema.safeParse(bare);
      if (again.success) return { ok: true, content: again.data };
    }
    return { ok: false, error: problem(result.error) };
  }

  function unreachable(input: ResolveInput<unknown>, channel: string, message: string): Known {
    loadFile();
    const known = lastKnown.get(subjectKeyOf(input.kind, input.slug, channel));
    if (known !== undefined) {
      const content = checked(input, known.content);
      if (content.ok) return { ...known, content: content.content, fallback: "last_known", error: message };
    }
    return bootstrapAnswer(input, channel, message, "bootstrap");
  }

  async function fetchResolution(
    input: ResolveInput<unknown>,
    channel: string,
    currentVersionId?: string,
  ): Promise<{ value: Known; ok: boolean; revoked?: boolean }> {
    const subjectKey = subjectKeyOf(input.kind, input.slug, channel);
    const now = Date.now();
    if (openUntil > now) {
      const seconds = Math.ceil((openUntil - now) / 1000);
      return { value: unreachable(input, channel, `LittleDB is unreachable; asking again in ${seconds} s.`), ok: false };
    }
    try {
      const schema = jsonSchemaOf(input);
      const raw = await options.transport.request(
        "POST",
        "/resolve",
        {
          kind: input.kind,
          slug: input.slug,
          channel,
          ...(input.stickyKey === undefined ? {} : { stickyKey: input.stickyKey }),
          ...(input.bootstrap === undefined ? {} : { bootstrap: input.bootstrap }),
          ...(schema === undefined ? {} : { schema }),
          ...(currentVersionId === undefined ? {} : { currentVersionId }),
          ...(input.caller === undefined ? {} : { caller: input.caller }),
        },
        { timeoutMs },
      );
      const parsed = ResolveResponseSchema.parse(raw);
      failures = 0;
      openUntil = 0;
      const { current, code, model, ...answer } = parsed;
      if (code?.state === "changed") {
        const id = code.proposalId ?? code.versionId ?? subjectKey;
        if (!announced.has(id)) {
          announced.add(id);
          try {
            onCodeChange({ kind: input.kind, slug: input.slug, channel, versionId: code.versionId ?? null, proposalId: code.proposalId ?? null });
          } catch {
            /* a notice must never fail a resolve */
          }
        }
      }
      const content = checked(input, answer.content);
      if (!content.ok) {
        const message = `Version ${answer.number ?? "?"} of ${input.kind}:${input.slug} does not match your content schema (${content.error}); running your bootstrap.`;
        options.onError(new Error(message), { operation: "resolve" });
        return { value: bootstrapAnswer(input, channel, message, "invalid"), ok: false };
      }
      const value: Known = {
        kind: input.kind,
        slug: input.slug,
        ...answer,
        content: content.content,
        channel: answer.channel,
        ...(code == null ? {} : { code: { state: code.state, versionId: code.versionId ?? null, proposalId: code.proposalId ?? null } }),
        ...(model === undefined ? {} : { model }),
      };
      keepLive(subjectKey, value);
      return { value, ok: true, ...(current == null ? {} : { revoked: current.revoked }) };
    } catch (error) {
      options.onError(error, { operation: "resolve" });
      if (outage(error)) {
        failures += 1;
        if (failures >= breakerFailures) openUntil = Date.now() + breakerCooldownMs;
      }
      return { value: unreachable(input, channel, error instanceof Error ? error.message : String(error)), ok: false };
    }
  }

  /** The kept answer for a session, checked again: replaced only when its version was rolled back. */
  function revalidate(key: string, entry: Entry, input: ResolveInput<unknown>, channel: string): Promise<Resolution<unknown>> {
    entry.revalidating ??= (async () => {
      const kept = await entry.value;
      try {
        if (kept.versionId === null) {
          // Nothing was live when the session started: take what is live now.
          const fresh = await fetchResolution(input, channel);
          if (fresh.ok) {
            remember(key, { expires: Date.now() + stickyTtlMs, value: Promise.resolve(fresh.value), ok: true, checkedAt: Date.now() });
            return fresh.value;
          }
          return kept;
        }
        const fresh = await fetchResolution(input, channel, kept.versionId);
        if (fresh.ok && fresh.revoked === true) {
          remember(key, { expires: Date.now() + stickyTtlMs, value: Promise.resolve(fresh.value), ok: true, checkedAt: Date.now() });
          return fresh.value;
        }
        return kept;
      } finally {
        entry.checkedAt = Date.now();
        entry.revalidating = undefined;
      }
    })();
    return entry.revalidating;
  }

  return {
    resolve<C>(input: ResolveInput<C>): Promise<Resolution<C>> {
      const channel = input.channel ?? "production";
      const generic = input as ResolveInput<unknown>;
      // Inside an experiment run, a pinned subject runs the version the run names.
      const pin = pinFor(input.kind, input.slug);
      if (pin !== undefined) {
        const content = checked(generic, pin.content);
        if (!content.ok) {
          return Promise.reject(
            new TypeError(`Experiment run ${currentEvalContext()?.runId ?? ""} pins ${input.kind}:${input.slug} to content your schema rejects: ${content.error}`),
          );
        }
        return Promise.resolve({
          kind: input.kind,
          slug: input.slug,
          channel,
          subjectId: null,
          versionId: pin.versionId,
          number: null,
          status: "pinned",
          mode: "pinned",
          content: content.content as C,
          ...(pin.model === undefined ? {} : { model: pin.model }),
        });
      }
      const key = `${input.kind}\u0000${input.slug}\u0000${channel}\u0000${input.stickyKey ?? ""}`;
      const now = Date.now();
      const hit = cache.get(key);
      if (hit !== undefined && hit.expires > now) {
        remember(key, hit);
        if (input.stickyKey !== undefined && hit.ok && now - hit.checkedAt >= revalidateMs) {
          return revalidate(key, hit, generic, channel) as Promise<Resolution<C>>;
        }
        return hit.value as Promise<Resolution<C>>;
      }
      const ttl = input.stickyKey === undefined ? cacheTtlMs : stickyTtlMs;
      const value = fetchResolution(generic, channel).then(({ value, ok }) => {
        // A fallback is retried soon; a real answer is kept for the session.
        if (!ok) remember(key, { expires: Date.now() + FAILURE_TTL_MS, value: Promise.resolve(value), ok: false, checkedAt: Date.now() });
        return value;
      });
      remember(key, { expires: now + ttl, value, ok: true, checkedAt: now });
      return value as Promise<Resolution<C>>;
    },
    clear() {
      cache.clear();
    },
  };
}
