import { randomUUID } from "node:crypto";
import { ResolvedModelSchema, type Caller, type ResolvedModel } from "./contract.js";
import { evalRunOf } from "./eval-context.js";
import type { LittleDBErrorHandler } from "./exporter.js";
import type { HarnessEventLike, HarnessTracer, HarnessTracerOptions } from "./harness/tracer.js";
import { readWorkflowMemory, type ManagedMemoryOption, type WorkflowMemory } from "./memory.js";
import { isModelId } from "./models.js";
import { isRecord } from "./util.js";
import type { AgentWorkflowRegistryOptions, LittleDBAgentWorkflowRegistry } from "./harness/registry.js";
import type { Content, ContentSchema, Resolution, ResolveInput } from "./resolve.js";
import type { EvalWorker, EvalWorkerOptions } from "./worker.js";
import type { WorkflowEvalWorkerOptions } from "./workflow/eval-worker.js";
import type { TracingWorldOptions, WorldLike } from "./workflow/tracing-world.js";

/**
 * The turn a managed harness is asked about. `HarnessTurnContext` from `@little-stack/harness`
 * fits it, so `turnOptions` goes straight into `createHarness`.
 */
export type ManagedTurnLike<TExtraBody = unknown> = {
  readonly sessionId: string;
  readonly extraBody?: TExtraBody | undefined;
  readonly trigger?:
    | { readonly kind: string; readonly source?: string | undefined; readonly from?: string | undefined; readonly label?: string | undefined }
    | undefined;
  /** A parked turn continuing: the `pin` its hook returned when it parked. */
  readonly resumed?: { readonly pin?: unknown } | undefined;
};

/** What `turnOptions` tells the turn's caller (Harness `metadata`): the version the turn ran. */
export type ManagedTurnMetadata = {
  readonly littledb: {
    readonly subject: string;
    readonly versionId: string | null;
    readonly number: number | null;
    readonly mode: Resolution["mode"];
  };
};

/** The model slots a version's `model` may name, as a map or a lookup. */
export type ModelSlots<M> = Readonly<Record<string, M>> | ((slot: string) => M | undefined);

/** What the default `apply` sets: the system prompt, and the model when `models` names the slot. */
export type DefaultOverrides<M> = { system?: string; model?: M; temperature?: number };

export type ManagedHarnessOptions<C extends Content, M, O extends object, TExtraBody> = {
  /** The harness's slug in LittleDB. */
  readonly slug: string;
  /** Release channel. Default `production`. */
  readonly channel?: string | undefined;
  /**
   * The agent as your code has it, usually `{ system, model }` with `system` read from
   * `instructions.md`. It becomes version 1; after that, editing it opens a "Changed in code"
   * proposal that LittleDB carries onto the live version. It also runs when LittleDB is unreachable.
   */
  readonly bootstrap: NoInfer<C>;
  /**
   * What a version may hold, as a Zod schema. A version that does not match never runs (your
   * bootstrap does), and LittleDB checks every candidate against it before spending anything.
   */
  readonly schema?: ContentSchema<C> | undefined;
  /** The JSON Schema to send LittleDB instead of the one made from `schema`. */
  readonly jsonSchema?: Readonly<Record<string, unknown>> | undefined;
  /**
   * The models a version's `model` may name, by slot, e.g. `{ fast: anthropic("claude-haiku-5-5"),
   * smart: anthropic("claude-sonnet-5-5") }`. Without it the default `apply` never changes the model.
   */
  readonly models?: ModelSlots<M> | undefined;
  /**
   * Run the model LittleDB holds for this harness (resolve's `model`: the version's, the agent's
   * setting or the project's default) on every turn, so your code names none. Usually
   * `createModelResolver({ providers: { deepseek: createDeepSeek } })` from
   * `@little-stack/littledb/models`. A slot from `models` still wins, and without this the
   * harness's own model runs.
   */
  readonly resolveModel?: ((model: ResolvedModel) => M) | undefined;
  /**
   * Turn a version's content into the turn's options. Default: `system`, `temperature`, and
   * `model` through `models`. Throw to reject a version: the bootstrap runs instead.
   */
  readonly apply?: ((content: C, turn: ManagedTurnLike<TExtraBody>) => O) | undefined;
  /** The key that keeps someone on one version (and one side of a trial). Default the session id. */
  readonly stickyKey?: ((turn: ManagedTurnLike<TExtraBody>) => string | undefined) | undefined;
  /**
   * The workflow that started this turn, so LittleDB learns who calls the agent. Default: from a
   * `workflow` trigger's `source`.
   */
  readonly caller?: ((turn: ManagedTurnLike<TExtraBody>) => Caller | undefined) | undefined;
  /** Trace every turn into LittleDB (default), with these tracer options, or `false`. */
  readonly trace?: false | Omit<HarnessTracerOptions, "harness" | "resolution" | "resolutionFor" | "versionId" | "traceId" | "traceIdFor"> | undefined;
  /** Options for `registry`, the review of workflows the agent defines. */
  readonly agentWorkflows?: Omit<AgentWorkflowRegistryOptions, "harness"> | undefined;
};

/** What one session runs: LittleDB's answer, the content, and the options it became. */
export type ManagedSession<C, O> = {
  readonly resolution: Resolution<C>;
  readonly content: C;
  readonly overrides: O;
};

export type ManagedHarness<C, O> = {
  readonly slug: string;
  readonly channel: string;
  /**
   * The Harness `turnOptions` hook: `createHarness({ ..., turnOptions: support.turnOptions })`.
   * Each turn gets its session's version, and its events are traced with that version. It returns
   * the version as `metadata`, and pins it (`pin`) so a parked turn that continues runs and is
   * traced as the version it parked on, without resolving again, even if another one is live now.
   */
  readonly turnOptions: (turn: ManagedTurnLike) => Promise<
    O & { onEvent?: (event: HarnessEventLike) => Promise<void>; metadata: ManagedTurnMetadata; pin: { readonly littledb: unknown } }
  >;
  /** What a session runs (resolved now if it has not had a turn yet). For reports and tests. */
  session(sessionId: string): Promise<ManagedSession<C, O>>;
  /** The tracer behind `turnOptions`, for the trace of a session's latest turn. `undefined` with `trace: false`. */
  readonly tracer: HarnessTracer | undefined;
  /** A `dynamicWorkflows({ registry })` for this harness, so workflows the agent defines go to review. */
  readonly registry: LittleDBAgentWorkflowRegistry;
  /**
   * Run this harness's experiments here. Inside `run`, a turn of this harness runs the run's
   * version and traces into the run's trace, so `run` only calls `generateHarness`.
   */
  evalWorker(options: Omit<EvalWorkerOptions, "subjects">): EvalWorker;
};

export type ManagedWorkflowOptions<C extends Content> = {
  /** The workflow's slug in LittleDB. */
  readonly slug: string;
  readonly channel?: string | undefined;
  /** The step prompts and models as your code has them, e.g. `{ steps: { decide: { prompt, model } } }`. */
  readonly bootstrap: NoInfer<C>;
  readonly schema?: ContentSchema<C> | undefined;
  readonly jsonSchema?: Readonly<Record<string, unknown>> | undefined;
  /** Trace every run into LittleDB (default), with these options, or `false`. */
  readonly trace?: false | Omit<TracingWorldOptions, "workflow" | "resolution" | "versionId"> | undefined;
  /**
   * Managed memory the run reads, read-only: `[db.memory.org({ space: "refund-exceptions" })]`.
   * `prepare` loads it and hands back `memory.note()` for the steps that should see it; the run's
   * trace records which revisions it read.
   */
  readonly memory?: readonly ManagedMemoryOption<never>[] | readonly ManagedMemoryOption<unknown>[] | undefined;
};

/** What names a run's version again if it resumes: `versionedHarnessWorkflow` keeps it with the run. */
export type ManagedWorkflowVersion = Pick<Resolution, "subjectId" | "versionId" | "number" | "status" | "mode">;

/** One run of a managed workflow: the content to build it from, and its World wrapped for tracing. */
export type ManagedWorkflowRun<C> = {
  readonly content: C;
  readonly resolution: Resolution<C>;
  readonly version: ManagedWorkflowVersion;
  /** The memory the workflow named, as this run read it. Empty when it named none. */
  readonly memory: WorkflowMemory;
  /** Your World, traced into LittleDB with this run's version. */
  world<W extends WorldLike>(inner: W): W;
};

export type ManagedWorkflow<C> = {
  readonly slug: string;
  readonly channel: string;
  readonly bootstrap: C;
  /** The version to run for this key (a session or user id), and a World to run it in. */
  prepare(options?: {
    readonly stickyKey?: string | undefined;
    readonly caller?: Caller | undefined;
    /** What `org` and `user` in the workflow's memory read, as a harness turn's `extraBody`. */
    readonly extraBody?: unknown;
    /**
     * A run resuming: the content it started with and the `version` `prepare` gave it then. Nothing
     * is resolved; the run is traced as that version, even if another one is live now.
     */
    readonly pinned?: { readonly content: C; readonly version?: unknown } | undefined;
  }): Promise<ManagedWorkflowRun<C>>;
  /** Run this workflow's experiments here: see `db.workflowEvalWorker`. */
  evalWorker<W extends WorldLike>(options: Omit<WorkflowEvalWorkerOptions<W>, "workflow">): EvalWorker;
};

type Deps = {
  readonly resolve: <C>(input: ResolveInput<C>) => Promise<Resolution<C>>;
  readonly harnessTracer: (options: HarnessTracerOptions) => HarnessTracer;
  readonly tracingWorld: <W extends WorldLike>(inner: W, options: TracingWorldOptions) => W;
  readonly agentWorkflowRegistry: (options: AgentWorkflowRegistryOptions) => LittleDBAgentWorkflowRegistry;
  readonly evalWorker: (options: EvalWorkerOptions) => EvalWorker;
  readonly workflowEvalWorker: <W extends WorldLike>(options: WorkflowEvalWorkerOptions<W>) => EvalWorker;
  readonly onError: LittleDBErrorHandler;
};

const MAX_SESSIONS = 10_000;
const MAX_RUN_TRACERS = 100;

function lookup<M>(models: ModelSlots<M> | undefined, slot: string): M | undefined {
  if (models === undefined) return undefined;
  return typeof models === "function" ? models(slot) : Object.prototype.hasOwnProperty.call(models, slot) ? models[slot] : undefined;
}

/** The default `apply`: a version's `system`, `temperature` and `model` slot as turn options. */
function defaultApply<M>(models: ModelSlots<M> | undefined, slug: string, warn: (message: string) => void) {
  return (content: Content): DefaultOverrides<M> => {
    const out: DefaultOverrides<M> = {};
    if (typeof content.system === "string") out.system = content.system;
    if (typeof content.temperature === "number") out.temperature = content.temperature;
    // A `provider/model` id is LittleDB's to run (`resolveModel`), not a slot.
    if (typeof content.model === "string" && !isModelId(content.model)) {
      if (models === undefined) {
        warn(`harness:${slug} runs model slot "${content.model}", but managedHarness has no \`models\`, so the harness's own model runs.`);
      } else {
        const model = lookup(models, content.model);
        if (model === undefined) throw new Error(`The version names model slot "${content.model}", which \`models\` does not have.`);
        out.model = model;
      }
    }
    return out;
  };
}

/** A workflow trigger names the workflow that called the agent. */
function triggerCaller(turn: ManagedTurnLike): Caller | undefined {
  const trigger = turn.trigger;
  if (trigger?.kind !== "workflow" || trigger.source === undefined || trigger.source.length === 0) return undefined;
  return { kind: "workflow", slug: trigger.source, ...(trigger.label === undefined ? {} : { step: trigger.label.slice(0, 200) }) };
}

export function createManagedHarness<C extends Content, M, O extends object, TExtraBody>(
  options: ManagedHarnessOptions<C, M, O, TExtraBody>,
  deps: Deps,
): ManagedHarness<C, O> {
  if (typeof options.slug !== "string" || options.slug.length === 0) throw new TypeError("managedHarness needs the harness's slug.");
  const channel = options.channel ?? "production";
  const warned = new Set<string>();
  const warn = (message: string) => {
    if (warned.has(message)) return;
    warned.add(message);
    deps.onError(new Error(message), { operation: "managedHarness" });
  };
  const apply = (options.apply ?? defaultApply(options.models, options.slug, warn)) as (content: C, turn: ManagedTurnLike<TExtraBody>) => O;
  type Session = ManagedSession<C, O> & { readonly modelDecision: ResolvedModel | null };
  const sessions = new Map<string, Session>();
  const runTracers = new Map<string, HarnessTracer>();
  const tracer =
    options.trace === false
      ? undefined
      : deps.harnessTracer({
          ...(options.trace ?? {}),
          harness: options.slug,
          resolutionFor: (sessionId) => sessions.get(sessionId)?.resolution,
        });
  let registry: LittleDBAgentWorkflowRegistry | undefined;

  /** LittleDB's model for the turn, unless `apply` already chose one (a slot). A missing key fails the turn. */
  const withModel = (overrides: O, resolution: Resolution<C>): Pick<Session, "overrides" | "modelDecision"> => {
    if (options.resolveModel === undefined || resolution.model === undefined || (overrides as { model?: unknown }).model !== undefined) return { overrides, modelDecision: null };
    return { overrides: { ...overrides, model: options.resolveModel(resolution.model) }, modelDecision: resolution.model };
  };

  const keep = (sessionId: string, session: Session) => {
    sessions.delete(sessionId);
    sessions.set(sessionId, session);
    while (sessions.size > MAX_SESSIONS) {
      const oldest = sessions.keys().next().value;
      if (oldest === undefined) break;
      sessions.delete(oldest);
    }
  };

  async function prepare(turn: ManagedTurnLike<TExtraBody>): Promise<Session> {
    const pinned = pinOf<C>(options.slug, turn.resumed?.pin);
    if (pinned !== undefined) {
      // A parked turn continuing: what it parked on, resolved again by nothing. A pinned version
      // the app can no longer run fails the turn rather than run something else under its name.
      let resolution = pinnedResolution<C>("harness", options.slug, channel, pinned);
      const applied = apply(pinned.content, turn);
      let decision: Pick<Session, "overrides" | "modelDecision">;
      if (pinned.model !== undefined && pinned.model !== null) {
        const model = pinned.model;
        if (resolution.model !== undefined && (resolution.model.id !== model.id || resolution.model.paidBy !== model.paidBy || resolution.model.source !== model.source)) {
          throw new TypeError(`managedHarness "${options.slug}": this parked turn has inconsistent pinned model decisions.`);
        }
        if (options.resolveModel === undefined) throw new TypeError(`managedHarness "${options.slug}": this parked turn's pinned model requires resolveModel.`);
        resolution = { ...resolution, model };
        decision = { overrides: { ...applied, model: options.resolveModel(model) }, modelDecision: model };
      } else if (pinned.model === null) {
        // This turn used a code model or named slot. Adding resolveModel later must not select
        // a previously unused project model during continuation.
        decision = { overrides: applied, modelDecision: null };
      } else {
        // Old named-slot pins remain usable. An old prompt-only pin cannot prove which model
        // or payer resolveModel used; never resolve the current setting to fill the gap.
        if (options.resolveModel !== undefined && (applied as { model?: unknown }).model === undefined && resolution.model === undefined) {
          throw new TypeError(`managedHarness "${options.slug}": this parked turn has no pinned model decision.`);
        }
        decision = withModel(applied, resolution);
      }
      const session = { resolution, content: pinned.content, ...decision };
      keep(turn.sessionId, session);
      return session;
    }
    const caller = options.caller === undefined ? triggerCaller(turn) : options.caller(turn);
    const resolution = await deps.resolve<C>({
      kind: "harness",
      slug: options.slug,
      channel,
      stickyKey: options.stickyKey === undefined ? turn.sessionId : options.stickyKey(turn),
      bootstrap: options.bootstrap,
      ...(options.schema === undefined ? {} : { schema: options.schema }),
      ...(options.jsonSchema === undefined ? {} : { jsonSchema: options.jsonSchema }),
      ...(caller === undefined ? {} : { caller }),
    });
    const content = resolution.content ?? options.bootstrap;
    let session: Session;
    try {
      session = { resolution, content, ...withModel(apply(content, turn), resolution) };
    } catch (error) {
      if (content === options.bootstrap) throw error;
      // A version the app cannot run never runs: the bootstrap does, and the trace says so.
      const message = `Version ${resolution.number ?? "?"} of harness:${options.slug} cannot run (${error instanceof Error ? error.message : String(error)}); running your bootstrap.`;
      deps.onError(new Error(message), { operation: "managedHarness" });
      session = {
        resolution: { ...resolution, versionId: null, number: null, status: null, mode: "none", content: options.bootstrap, fallback: "invalid", error: message },
        content: options.bootstrap,
        ...withModel(apply(options.bootstrap, turn), resolution),
      };
    }
    keep(turn.sessionId, session);
    return session;
  }

  /** The tracer of an experiment run of this harness: every turn in the run's trace. */
  function runTracer(): HarnessTracer | undefined {
    const run = evalRunOf("harness", options.slug);
    if (run === undefined || options.trace === false) return undefined;
    let found = runTracers.get(run.runId);
    if (found === undefined) {
      found = deps.harnessTracer({ ...(options.trace ?? {}), harness: options.slug, ...run.trace });
      runTracers.set(run.runId, found);
      while (runTracers.size > MAX_RUN_TRACERS) {
        const oldest = runTracers.keys().next().value;
        if (oldest === undefined) break;
        runTracers.delete(oldest);
      }
    }
    return found;
  }

  return {
    slug: options.slug,
    channel,
    async turnOptions(turn) {
      const session = await prepare(turn as ManagedTurnLike<TExtraBody>);
      const traced = runTracer() ?? tracer;
      const { resolution } = session;
      const decided = {
        metadata: { littledb: { subject: `harness:${options.slug}`, versionId: resolution.versionId, number: resolution.number, mode: resolution.mode } },
        pin: { littledb: { content: session.content, version: versionOf(resolution), model: session.modelDecision === null ? null : { ...session.modelDecision } } },
      };
      return traced === undefined ? { ...session.overrides, ...decided } : { ...session.overrides, ...decided, onEvent: traced.onEvent };
    },
    async session(sessionId) {
      return sessions.get(sessionId) ?? prepare({ sessionId });
    },
    tracer,
    get registry() {
      registry ??= deps.agentWorkflowRegistry({ ...(options.agentWorkflows ?? {}), harness: options.slug });
      return registry;
    },
    evalWorker(workerOptions) {
      return deps.evalWorker({ ...workerOptions, subjects: [{ kind: "harness", slug: options.slug }] });
    },
  };
}

export function createManagedWorkflow<C extends Content>(options: ManagedWorkflowOptions<C>, deps: Deps): ManagedWorkflow<C> {
  if (typeof options.slug !== "string" || options.slug.length === 0) throw new TypeError("managedWorkflow needs the workflow's slug.");
  const channel = options.channel ?? "production";
  return {
    slug: options.slug,
    channel,
    bootstrap: options.bootstrap,
    async prepare(prepareOptions = {}) {
      const pinned = prepareOptions.pinned;
      const resolution =
        pinned === undefined
          ? await deps.resolve<C>({
              kind: "workflow",
              slug: options.slug,
              channel,
              ...(prepareOptions.stickyKey === undefined ? {} : { stickyKey: prepareOptions.stickyKey }),
              bootstrap: options.bootstrap,
              ...(options.schema === undefined ? {} : { schema: options.schema }),
              ...(options.jsonSchema === undefined ? {} : { jsonSchema: options.jsonSchema }),
              ...(prepareOptions.caller === undefined ? {} : { caller: prepareOptions.caller }),
            })
          : pinnedResolution("workflow", options.slug, channel, pinned);
      const content = resolution.content ?? options.bootstrap;
      const trace = options.trace;
      const memory = await readWorkflowMemory(options.memory ?? [], {
        extraBody: prepareOptions.extraBody,
        sessionId: prepareOptions.stickyKey ?? `run_${randomUUID()}`,
        subject: `workflow:${options.slug}`,
      });
      const memoryMetadata = memory.loaded.map((m) => ({ layer: m.layer, space: m.space, files: Object.keys(m.files).length, ...(m.snapshot === undefined ? {} : { snapshot: m.snapshot }) }));
      return {
        content,
        resolution,
        version: versionOf(resolution),
        memory,
        world<W extends WorldLike>(inner: W): W {
          if (trace === false) return inner;
          // An experiment run of this workflow traces into the run's own trace.
          const run = evalRunOf("workflow", options.slug);
          return deps.tracingWorld(inner, {
            ...(trace ?? {}),
            workflow: options.slug,
            ...(run === undefined ? { resolution } : run.trace),
            ...(memoryMetadata.length === 0 ? {} : { metadata: { ...(trace === undefined ? {} : trace.metadata), memory: memoryMetadata } }),
          });
        },
      };
    },
    evalWorker(workerOptions) {
      return deps.workflowEvalWorker({ ...workerOptions, workflow: options.slug });
    },
  };
}

const MODES: readonly string[] = ["live", "trial", "holdout", "none", "pinned"];

/** What names a resolution's version again: kept with a resumed run, or a parked turn's pin. */
function versionOf(resolution: Resolution<unknown>): ManagedWorkflowVersion & Pick<Resolution, "model"> {
  return {
    subjectId: resolution.subjectId,
    versionId: resolution.versionId,
    number: resolution.number,
    status: resolution.status,
    mode: resolution.mode,
    ...(resolution.model === undefined ? {} : { model: { ...resolution.model } }),
  };
}

/**
 * The content and version a parked turn of this harness pinned (`pin.littledb`), or undefined when
 * the turn has no pin of ours. A pin of ours without content is refused.
 */
function pinOf<C>(slug: string, pin: unknown): { readonly content: C; readonly version?: unknown; readonly model?: ResolvedModel | null } | undefined {
  if (!isRecord(pin) || !Object.hasOwn(pin, "littledb")) return undefined;
  const ours = pin.littledb;
  if (!isRecord(ours) || !isRecord(ours.content)) {
    throw new TypeError(`managedHarness "${slug}": the version this parked turn was pinned to is not one turnOptions returned.`);
  }
  return { content: ours.content as C, version: ours.version, ...(Object.hasOwn(ours, "model") ? { model: ours.model === null ? null : pinnedModel(ours.model, "harness", slug) } : {}) };
}

function pinnedModel(value: unknown, kind: "workflow" | "harness", slug: string): ResolvedModel {
  const parsed = ResolvedModelSchema.safeParse(value);
  if (!parsed.success || !isModelId(parsed.data.id)) throw new TypeError(`managed${kind === "workflow" ? "Workflow" : "Harness"} "${slug}": the pinned model decision is invalid.`);
  return parsed.data;
}

/**
 * The resolution a resumed run or a continued turn had, from the `version` kept with it. A pin
 * without one (its source gave none) is traced as `pinned` with no version; one that names a
 * version wrongly is refused, so the run fails rather than being traced as some other version.
 */
function pinnedResolution<C>(
  kind: "workflow" | "harness",
  slug: string,
  channel: string,
  pinned: { readonly content: C; readonly version?: unknown },
): Resolution<C> {
  const base = { kind, slug, channel, content: pinned.content };
  if (pinned.version === undefined) {
    return { ...base, subjectId: null, versionId: null, number: null, status: null, mode: "pinned" };
  }
  const v = pinned.version;
  const nullOr = (value: unknown, type: "string" | "number") => value === null || typeof value === type;
  if (
    !isRecord(v) ||
    !nullOr(v.subjectId, "string") ||
    !nullOr(v.versionId, "string") ||
    !nullOr(v.number, "number") ||
    !nullOr(v.status, "string") ||
    typeof v.mode !== "string" ||
    !MODES.includes(v.mode)
  ) {
    throw new TypeError(
      kind === "workflow"
        ? `managedWorkflow "${slug}": the version this run was pinned to is not one prepare() returned.`
        : `managedHarness "${slug}": the version this parked turn was pinned to is not one turnOptions returned.`,
    );
  }
  return {
    ...base,
    subjectId: v.subjectId as string | null,
    versionId: v.versionId as string | null,
    number: v.number as number | null,
    status: v.status as string | null,
    mode: v.mode as Resolution["mode"],
    ...(Object.hasOwn(v, "model") ? { model: pinnedModel(v.model, kind, slug) } : {}),
  };
}
