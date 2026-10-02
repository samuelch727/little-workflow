import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ConfigBundle, SessionConfig } from "@little-workflow/littledb/harness";
import { littledb } from "@little-workflow/littledb/harness";
import type { LanguageModel } from "ai";
import type { HarnessEvent, HarnessOutcomeSink } from "little-harness";
import { DEFAULT_MODEL_SLOT, demoRoot, modelForSlot } from "./env";

const agentDir = dirname(fileURLToPath(import.meta.url));

/** The per-run overrides a resolved managed config contributes to a `generateHarness` call. */
export type ManagedTurnOverrides = {
  readonly system: string;
  readonly model: LanguageModel;
};

export type SupportLittleDb = {
  readonly controlPlaneUrl: string;
  readonly engineUrl: string;
  readonly harnessId: string;
  readonly channel: string;
  readonly outcomeSink: HarnessOutcomeSink;
  /** Resolve managed config for `sessionId` (once per session, cached). */
  prepareSession(sessionId: string): Promise<SessionConfig>;
  /** The prompt and model this session runs on. `undefined` until `prepareSession` resolves. */
  overridesFor(sessionId: string): ManagedTurnOverrides | undefined;
  /**
   * The trace reporter's event hook, kept SEPARATE from the overrides above.
   *
   * That separation is the sealed-gate discipline made mechanical. A traffic run passes this
   * to `generateHarness` and its episodes become run history the dream reads; a gate run
   * resolves exactly the same config and deliberately does not, so gate items never enter
   * the history the optimizer learns from (`evals-research-synthesis-2026-08.md` §7). Making
   * it a second call rather than a flag means a gate run cannot leak telemetry by forgetting
   * to unset something.
   */
  reporterFor(sessionId: string): ((event: HarnessEvent) => Promise<void>) | undefined;
  configFor(sessionId: string): SessionConfig | undefined;
  flush(): Promise<void>;
};

/**
 * Read the bootstrap prompt from the SAME file `loadHarness` uses as the system prompt.
 *
 * `SUPPORT_PROMPT_FILE` (a path, absolute or relative to the demo root) seeds littleDB with
 * a DIFFERENT prompt without touching `instructions.md` — that is how `experiment/run.mjs`
 * bootstraps the deliberately-flawed v1. It affects the littleDB bootstrap ONLY: a run with
 * `LITTLEDB_URL` unset still uses `instructions.md`, and littleDB ignores the bootstrap once
 * the channel has a config version.
 */
export function bootstrapPrompt(): string {
  const override = process.env.SUPPORT_PROMPT_FILE;
  const file =
    override === undefined || override.length === 0
      ? join(agentDir, "instructions.md")
      : resolve(demoRoot, override);
  return readFileSync(file, "utf8").trim();
}

/**
 * The seed littleDB stores on the FIRST `/api/config/resolve` call for this harness+channel.
 * Every field of `ConfigBundleSchema` is required — there are no optionals — so the inert
 * ones are spelled out rather than omitted.
 */
export function bootstrapConfig(): ConfigBundle {
  return {
    prompt: bootstrapPrompt(),
    skills: [],
    modelSlot: process.env.SUPPORT_MODEL_SLOT ?? DEFAULT_MODEL_SLOT,
    toolManifest: null,
    sampling: {},
    hyperparams: {},
    memoryPolicy: null,
  };
}

/**
 * Held on `globalThis` for the same reason the model seam is: `little-harness`'s
 * `importDefault` constructs a NEW jiti instance per module, so the driver's copy of this
 * file and the one an agent module pulls in do not share a module registry — a plain
 * module-level singleton would give each of them its own resolver and its own cache.
 */
const SINGLETON = Symbol.for("support-desk.littledb");

type Holder = { [SINGLETON]?: SupportLittleDb | null };

/**
 * The littleDB handle, or `undefined` when `LITTLEDB_URL` is unset — the demo runs fully
 * without littleDB (plain `createHarness` + `instructions.md`, no reporter, no sink).
 */
export function supportLittleDb(): SupportLittleDb | undefined {
  const holder = globalThis as unknown as Holder;
  const existing = holder[SINGLETON];
  if (existing !== undefined) return existing ?? undefined;

  const controlPlaneUrl = process.env.LITTLEDB_URL;
  if (controlPlaneUrl === undefined || controlPlaneUrl.length === 0) {
    holder[SINGLETON] = null;
    return undefined;
  }

  const created = create(controlPlaneUrl);
  holder[SINGLETON] = created;
  return created;
}

/**
 * Drop the memoised handle. Tests only.
 *
 * The singleton caches the control-plane URL for the life of the process, and a test file
 * that starts a stub server on a fresh port per case would otherwise keep talking to the
 * first one. Deliberately not called by the driver: a live run has exactly one stack.
 */
export function resetSupportLittleDb(): void {
  const holder = globalThis as unknown as Holder;
  delete holder[SINGLETON];
}

function create(controlPlaneUrl: string): SupportLittleDb {
  const engineUrl = process.env.LITTLEDB_ENGINE_URL ?? "http://localhost:7878";
  const harnessId = process.env.LITTLEDB_HARNESS_ID ?? "support-desk-x";
  const channel = process.env.LITTLEDB_CHANNEL ?? "production";

  const db = littledb({
    controlPlaneUrl,
    engineUrl,
    harnessId,
    channel,
    ...(process.env.LITTLEDB_PROJECT_KEY ? { projectKey: process.env.LITTLEDB_PROJECT_KEY } : {}),
    modelFor: (slot: string) => modelForSlot(slot),
  });

  const pending = new Map<string, Promise<SessionConfig>>();
  const resolved = new Map<string, SessionConfig>();

  return {
    controlPlaneUrl,
    engineUrl,
    harnessId,
    channel,
    outcomeSink: db.outcomeSink,
    prepareSession(sessionId) {
      let inflight = pending.get(sessionId);
      if (inflight === undefined) {
        inflight = db.createSessionConfig(bootstrapConfig()).then((config) => {
          if (config.staleConfig) {
            console.warn(
              `littledb: session ${sessionId} is running on a CACHED config bundle (control plane unreachable).`,
            );
          }
          resolved.set(sessionId, config);
          return config;
        });
        pending.set(sessionId, inflight);
      }
      return inflight;
    },
    overridesFor(sessionId) {
      const config = resolved.get(sessionId);
      if (config === undefined) return undefined;
      const system = config.harnessOptions.system;
      const model = config.harnessOptions.model;
      if (typeof system !== "string" || model === undefined) return undefined;
      return { system, model };
    },
    reporterFor(sessionId) {
      const config = resolved.get(sessionId);
      return config === undefined ? undefined : (event) => config.reporter.onEvent(event);
    },
    configFor(sessionId) {
      return resolved.get(sessionId);
    },
    async flush() {
      await Promise.all([...resolved.values()].map((config) => config.reporter.flush()));
    },
  };
}
