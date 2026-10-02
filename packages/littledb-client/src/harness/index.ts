import type { LanguageModel } from "ai";
import type { CreateHarnessOptions, HarnessOutcomeSink, SkillInput } from "little-harness";
import { createConfigResolver, type ConfigCache } from "./config.js";
import { createOutcomeReporter } from "./outcome.js";
import { createLittleDbOutcomeSink } from "./outcome-sink.js";
import { createLittleDbHarnessReporter, type LittleDbHarnessReporter } from "./reporter.js";
import type { ConfigBundle, ReportOutcome } from "../contract.js";

export * from "./config.js";
export * from "./outcome.js";
export * from "./outcome-sink.js";
export * from "../contract.js";

/** Resolve a model instance from a managed config's `modelSlot`. */
export type ModelForSlot = (slot: string) => LanguageModel | undefined;
/** Resolve a skill input from a managed config's skill name (optional). */
export type SkillForName = (name: string) => SkillInput;

/** The subset of CreateHarnessOptions that managed config controls at construction time. */
export type ManagedHarnessOptions = Pick<CreateHarnessOptions, "system" | "model" | "skills">;

/**
 * Map a resolved ConfigBundle to the harness options it governs. Pure — the
 * replay-safe injection point is harness construction (before the model loop),
 * so this is applied once per session, never mid-run.
 */
export function bundleToHarnessOptions(
  bundle: ConfigBundle,
  resolvers: { modelFor: ModelForSlot; skillFor?: SkillForName },
): ManagedHarnessOptions {
  const model = resolvers.modelFor(bundle.modelSlot);
  if (!model) throw new Error(`littledb: could not resolve model slot "${bundle.modelSlot}"`);
  let skills: SkillInput[];
  if (bundle.skills.length > 0 && !resolvers.skillFor) {
    throw new Error(
      `littledb: managed config requires a skillFor resolver to apply skills [${bundle.skills.join(", ")}], but none was provided`,
    );
  }
  skills = resolvers.skillFor ? bundle.skills.map((name) => resolvers.skillFor!(name)) : [];
  return { system: bundle.prompt, model, skills };
}

export interface LittleDbOptions {
  /** Per-project API key. Omit when targeting a local control plane (local mode). */
  projectKey?: string;
  controlPlaneUrl: string;
  engineUrl: string;
  harnessId: string;
  channel?: string;
  modelFor: ModelForSlot;
  skillFor?: SkillForName;
  fetchImpl?: typeof fetch;
  cache?: ConfigCache;
}

export interface SessionConfig {
  configVersionId: string;
  channel: string;
  staleConfig: boolean;
  /** Apply onto createHarness(): system + model + skills resolved from managed config. */
  harnessOptions: ManagedHarnessOptions;
  /** Trace reporter pre-wired with this session's configVersionId + channel. */
  reporter: LittleDbHarnessReporter;
}

export interface LittleDb {
  /**
   * Resolve managed config for a new session (first link uses `bootstrapConfig`),
   * returning the harness options to build with and a trace reporter that records
   * the pinned configVersionId.
   */
  createSessionConfig(bootstrapConfig: ConfigBundle): Promise<SessionConfig>;
  reportOutcome(outcome: ReportOutcome): Promise<{ ok: boolean }>;
  /**
   * Hand this to the harness (`reportHarnessOutcome({ sinks: [db.outcomeSink] })`, or a chat
   * connector's `reactions.sinks`) and every recorded `outcome.reported` reaches littleDB via
   * {@link reportOutcome}, keyed to the same `runId` the trace reporter uses.
   */
  readonly outcomeSink: HarnessOutcomeSink;
}

/**
 * The managed-config entry point: resolve config from littleDB, inject it into a
 * harness at construction, export traces carrying the pinned configVersionId, and
 * report run outcomes. Config is resolved ONCE per session (the replay-safe point);
 * on resume the caller passes the recorded configVersionId back (a resolveByVersion
 * path for full replay parity is a documented follow-up).
 */
export function littledb(options: LittleDbOptions): LittleDb {
  const channel = options.channel ?? "production";
  const resolver = createConfigResolver({
    controlPlaneUrl: options.controlPlaneUrl,
    ...(options.projectKey ? { projectKey: options.projectKey } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.cache ? { cache: options.cache } : {}),
  });
  const outcomes = createOutcomeReporter({
    controlPlaneUrl: options.controlPlaneUrl,
    ...(options.projectKey ? { projectKey: options.projectKey } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });

  return {
    async createSessionConfig(bootstrapConfig) {
      const resolved = await resolver.resolve({ harnessId: options.harnessId, channel, bootstrapConfig });
      const harnessOptions = bundleToHarnessOptions(resolved.config, {
        modelFor: options.modelFor,
        ...(options.skillFor ? { skillFor: options.skillFor } : {}),
      });
      const reporter = createLittleDbHarnessReporter({
        engineUrl: options.engineUrl,
        harnessId: options.harnessId,
        releaseChannel: resolved.channel,
        configVersionId: resolved.configVersionId,
        model: resolved.config.modelSlot,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      });
      return {
        configVersionId: resolved.configVersionId,
        channel: resolved.channel,
        staleConfig: resolved.staleConfig,
        harnessOptions,
        reporter,
      };
    },
    reportOutcome(outcome) {
      return outcomes.report(outcome);
    },
    outcomeSink: createLittleDbOutcomeSink({ report: (outcome) => outcomes.report(outcome) }),
  };
}
