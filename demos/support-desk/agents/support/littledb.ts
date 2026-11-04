import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createLittleDB, type HarnessTracer, type LittleDB, type Resolution } from "@little-stack/littledb";
import type { LanguageModel } from "ai";
import { defaultModelSlot, demoRoot, modelForSlot } from "./env";

const agentDir = dirname(fileURLToPath(import.meta.url));

/**
 * What a LittleDB version of this agent holds: the system prompt and a model slot. It is a
 * plain object, so a reviewer (or the LittleDB UI) can propose a new prompt or a new model
 * as a version without touching the code.
 */
export type SupportVersionContent = {
  readonly system: string;
  readonly model: string;
};

/** The per-run overrides a version contributes to a `generateHarness` call. */
export type SupportTurnOverrides = {
  readonly system: string;
  readonly model: LanguageModel;
};

export type SupportSession = {
  readonly resolution: Resolution;
  readonly content: SupportVersionContent;
  readonly overrides: SupportTurnOverrides;
};

export type SupportLittleDb = {
  readonly db: LittleDB;
  readonly url: string;
  /** The harness slug in LittleDB. */
  readonly harness: string;
  readonly channel: string;
  /** Resolve the version this session runs on (once per session; the answer is sticky). */
  prepareSession(sessionId: string): Promise<SupportSession>;
  /**
   * A tracer that sends the session's episode to LittleDB as ONE trace, each turn a child of
   * its root, so the episode's scores sit on the whole conversation.
   *
   * Kept apart from `prepareSession` on purpose. A traffic run asks for it and its episodes
   * become history the reviewer reads; a gate run resolves exactly the same version and
   * never asks, so gate episodes never reach LittleDB. Making it a second call rather than a
   * flag means a gate run cannot leak traces by forgetting to unset something.
   */
  tracerFor(sessionId: string, resolution: Resolution): HarnessTracer;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
};

/**
 * Read the bootstrap prompt from the SAME file `loadHarness` uses as the system prompt.
 *
 * `SUPPORT_PROMPT_FILE` (a path, absolute or relative to the demo root) seeds LittleDB with
 * a DIFFERENT prompt without touching `instructions.md`: that is how `experiment/run.mjs`
 * bootstraps the deliberately-flawed v1. It affects the LittleDB bootstrap only: a run with
 * `LITTLEDB_URL` unset still uses `instructions.md`, and LittleDB ignores the bootstrap once
 * the harness has a live version.
 */
export function bootstrapPrompt(): string {
  const override = process.env.SUPPORT_PROMPT_FILE;
  const file =
    override === undefined || override.length === 0
      ? join(agentDir, "instructions.md")
      : resolve(demoRoot, override);
  return readFileSync(file, "utf8").trim();
}

/** Version 1 of the agent, sent with every resolve; LittleDB stores it the first time only. */
export function bootstrapContent(): SupportVersionContent {
  return { system: bootstrapPrompt(), model: defaultModelSlot() };
}

/** A version's content as this demo reads it. Throws on a version it cannot run. */
export function versionContent(content: Readonly<Record<string, unknown>> | null | undefined): SupportVersionContent {
  const system = content?.system;
  const model = content?.model;
  if (typeof system !== "string" || system.trim().length === 0) {
    throw new Error("The LittleDB version has no `system` prompt.");
  }
  if (typeof model !== "string") throw new Error("The LittleDB version has no `model` slot.");
  return { system, model };
}

/** The prompt and model a version runs with. Unknown model slots fail loudly. */
export function overridesFor(content: SupportVersionContent): SupportTurnOverrides {
  const model = modelForSlot(content.model);
  if (model === undefined) throw new Error(`The LittleDB version names an unknown model slot "${content.model}".`);
  return { system: content.system, model };
}

/** The trace id of one episode. */
export function episodeTraceId(sessionId: string): string {
  return `sd_${sessionId}`.slice(0, 200);
}

/**
 * Held on `globalThis` for the same reason the model seam is: `little-harness`'s
 * `importDefault` constructs a NEW jiti instance per module, so the driver's copy of this
 * file and the one an agent module pulls in do not share a module registry.
 */
const SINGLETON = Symbol.for("support-desk.littledb");

type Holder = { [SINGLETON]?: SupportLittleDb | null };

/**
 * The LittleDB handle, or `undefined` when `LITTLEDB_URL` is unset: the demo runs fully
 * without LittleDB (plain `createHarness` + `instructions.md`, no traces, no scores).
 */
export function supportLittleDb(): SupportLittleDb | undefined {
  const holder = globalThis as unknown as Holder;
  const existing = holder[SINGLETON];
  if (existing !== undefined) return existing ?? undefined;

  const url = process.env.LITTLEDB_URL;
  if (url === undefined || url.length === 0) {
    holder[SINGLETON] = null;
    return undefined;
  }

  const created = create(url);
  holder[SINGLETON] = created;
  return created;
}

/** Drop the memoised handle. Tests only: a stub server on a fresh port per case. */
export function resetSupportLittleDb(): void {
  const holder = globalThis as unknown as Holder;
  delete holder[SINGLETON];
}

function create(url: string): SupportLittleDb {
  const apiKey = process.env.LITTLEDB_API_KEY;
  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error("LITTLEDB_URL is set but LITTLEDB_API_KEY is not. `littledb dev` prints a local key.");
  }
  const harness = process.env.LITTLEDB_HARNESS ?? "support-desk";
  const channel = process.env.LITTLEDB_CHANNEL ?? "production";
  const db = createLittleDB({ url, apiKey });
  const sessions = new Map<string, Promise<SupportSession>>();

  return {
    db,
    url,
    harness,
    channel,
    prepareSession(sessionId) {
      let pending = sessions.get(sessionId);
      if (pending === undefined) {
        pending = db
          .resolve({ kind: "harness", slug: harness, channel, stickyKey: sessionId, bootstrap: bootstrapContent() })
          .then((resolution) => {
            if (resolution.fallback !== undefined) {
              console.warn(
                `littledb: session ${sessionId} runs on the ${resolution.fallback === "last_known" ? "last known version" : "bootstrap"} (LittleDB unreachable: ${resolution.error ?? "unknown error"}).`,
              );
            }
            const content = versionContent(resolution.content);
            return { resolution, content, overrides: overridesFor(content) };
          });
        sessions.set(sessionId, pending);
      }
      return pending;
    },
    tracerFor(sessionId, resolution) {
      return db.harnessTracer({ harness, resolution, traceId: episodeTraceId(sessionId), name: "episode" });
    },
    flush: () => db.flush(),
    shutdown: () => db.shutdown(),
  };
}
