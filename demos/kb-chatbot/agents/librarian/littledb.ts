import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ConfigBundle, SessionConfig } from "@little-workflow/littledb/harness";
import { littledb } from "@little-workflow/littledb/harness";
import type { LanguageModel } from "ai";
import { skill } from "little-harness";
import type { HarnessEvent, HarnessOutcomeSink, SkillInput } from "little-harness";
import { demoRoot, DEFAULT_MODEL_SLOT, modelForSlot } from "./env";

const agentDir = dirname(fileURLToPath(import.meta.url));

/**
 * The subset of a resolved session config that a per-run `streamHarness` call can actually
 * apply. `system` and `model` are on `HarnessAgentOptions`, which `StreamHarnessOptions`
 * extends, and `resolveTurnConfig` merges them over the harness config for that turn.
 * `skills` is NOT on `HarnessAgentOptions` — see `warnAboutSkills` below.
 */
export type ManagedTurnOverrides = {
  readonly system: string;
  readonly model: LanguageModel;
  readonly onEvent: (event: HarnessEvent) => Promise<void>;
};

export type LibrarianLittleDb = {
  readonly controlPlaneUrl: string;
  readonly engineUrl: string;
  readonly harnessId: string;
  readonly outcomeSink: HarnessOutcomeSink;
  /**
   * Resolve managed config for `sessionId` (once per session, cached), so the SYNC
   * `streamHarness` seam has something to read by the time the run starts. Call this from
   * the connector's `beforeRun`, which the run pipeline awaits before `streamHarness`.
   */
  prepareSession(sessionId: string): Promise<SessionConfig>;
  /** Sync lookup for the `streamHarness` wrapper. `undefined` until `prepareSession` resolves. */
  overridesFor(sessionId: string): ManagedTurnOverrides | undefined;
  /** The pinned config version for a session, for reporting. */
  configFor(sessionId: string): SessionConfig | undefined;
  flush(): Promise<void>;
};

/**
 * Read the bootstrap prompt from the SAME file `loadHarness` uses as the system prompt.
 *
 * `LIBRARIAN_PROMPT_FILE` (a path, absolute or relative to the demo root) seeds littleDB
 * with a DIFFERENT prompt without touching `instructions.md` — that is how
 * `experiment/run.mjs` bootstraps the deliberately-flawed v1. It affects the littleDB
 * bootstrap ONLY: a run with `LITTLEDB_URL` unset still uses `instructions.md`, and
 * littleDB ignores the bootstrap once the channel has a config version.
 */
export function bootstrapPrompt(): string {
  const override = process.env.LIBRARIAN_PROMPT_FILE;
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
    modelSlot: process.env.KB_CHATBOT_MODEL_SLOT ?? DEFAULT_MODEL_SLOT,
    // Inert in the harness adapter today: nothing maps these onto harness options.
    toolManifest: null,
    sampling: {},
    hyperparams: {},
    memoryPolicy: null,
  };
}

/**
 * Managed config resolves ONCE PER SESSION, but `createHarness` builds ONE instance with
 * static options and `loadChatSdkConnector` loads ONE agent folder. The seam that makes
 * per-session config expressible is the injectable `streamHarness`, which accepts a
 * per-run `system` / `model` / `onEvent`. That seam is SYNCHRONOUS, so the async resolve
 * has to have already happened: `prepareSession` runs in the connector's awaited
 * `beforeRun`, and the wrapper reads the cache synchronously.
 *
 * Held on `globalThis` because `little-harness`'s `importDefault` constructs a NEW jiti
 * instance per module — `connectors/slack/connector.ts` (loaded by connector discovery)
 * and `load.ts` (loaded by the driver) do not share a module registry, so a plain
 * module-level singleton would give each of them its own resolver and its own cache.
 */
const SINGLETON = Symbol.for("kb-chatbot.librarian.littledb");

type Holder = { [SINGLETON]?: LibrarianLittleDb | null };

/**
 * The littleDB handle, or `undefined` when `LITTLEDB_URL` is unset — the demo runs fully
 * without littleDB (plain `createHarness` + `instructions.md`, no reporter, no sink).
 */
export function librarianLittleDb(): LibrarianLittleDb | undefined {
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

function create(controlPlaneUrl: string): LibrarianLittleDb {
  const engineUrl = process.env.LITTLEDB_ENGINE_URL ?? "http://localhost:7878";
  const harnessId = process.env.LITTLEDB_HARNESS_ID ?? "kb-librarian";
  const channel = process.env.LITTLEDB_CHANNEL ?? "production";

  const db = littledb({
    controlPlaneUrl,
    engineUrl,
    harnessId,
    channel,
    ...(process.env.LITTLEDB_PROJECT_KEY ? { projectKey: process.env.LITTLEDB_PROJECT_KEY } : {}),
    modelFor: (slot: string) => modelForSlot(slot),
    // Provided from day one: a bundle carrying skills with no resolver THROWS in
    // `bundleToHarnessOptions`, and a promoted config can add skills at any time.
    skillFor: (name: string): SkillInput => skill(join(agentDir, "skills", name)),
  });

  const sessions = new Map<string, Promise<SessionConfig>>();
  const resolved = new Map<string, SessionConfig>();

  return {
    controlPlaneUrl,
    engineUrl,
    harnessId,
    outcomeSink: db.outcomeSink,
    prepareSession(sessionId) {
      let pending = sessions.get(sessionId);
      if (pending === undefined) {
        pending = db.createSessionConfig(bootstrapConfig()).then((config) => {
          warnAboutSkills(config);
          if (config.staleConfig) {
            console.warn(
              `littledb: session ${sessionId} is running on a CACHED config bundle (control plane unreachable).`,
            );
          }
          resolved.set(sessionId, config);
          return config;
        });
        sessions.set(sessionId, pending);
      }
      return pending;
    },
    overridesFor(sessionId) {
      const config = resolved.get(sessionId);
      if (config === undefined) return undefined;
      const system = config.harnessOptions.system;
      const model = config.harnessOptions.model;
      if (typeof system !== "string" || model === undefined) return undefined;
      return { system, model, onEvent: (event) => config.reporter.onEvent(event) };
    },
    configFor(sessionId) {
      return resolved.get(sessionId);
    },
    async flush() {
      await Promise.all([...resolved.values()].map((config) => config.reporter.flush()));
    },
  };
}

/**
 * A promoted bundle with a non-empty `skills` list RESOLVES fine (that is what `skillFor`
 * is for) and then has nowhere to go: `skills` is on `CreateHarnessOptions` only, not on
 * `HarnessAgentOptions`, so no per-run call can apply it. Silently unapplied is worse than
 * a throw, so the demo says so out loud.
 */
function warnAboutSkills(config: SessionConfig): void {
  const skills = config.harnessOptions.skills ?? [];
  if (skills.length === 0) return;
  console.warn(
    `littledb: managed config ${config.configVersionId} carries ${skills.length} skill(s), ` +
      "which a per-session harness override CANNOT apply (skills are construction-time only). " +
      "They are being ignored for this session.",
  );
}
