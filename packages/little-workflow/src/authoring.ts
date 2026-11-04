import type { Harness, ToolSet } from "./harness/types.js";
import type { UsageTotals } from "./pricing.js";
import type { ArtifactRef, EventEnvelope, RunId } from "./world.js";
import { createLocalWorld } from "./world.js";
import { model as createModelSlot } from "./model-slots.js";
import { skill as createSkill, type RemoteSkillOptions, type Skill, type SkillOidcToken, type SkillRiskLevel } from "./skills.js";
import type { SuperviseDecision, SuperviseOuterLoopState } from "./compiler.js";
import type { BashCapabilities } from "./bash-tool.js";
import type { ToolPermissions } from "./permission.js";
import type { World } from "./world-port.js";
import type { WorkflowVersionReuseStrategy } from "./workflow-version-reuse.js";
import type { RunPlan } from "./run-plan.js";
import type { HarnessMcpConfig } from "@little-stack/harness";
import { normalizeSchema, output as outputBuilder } from "./schema.js";
import { createToolRegistry, type AiSdkTool, type ToolRegistry } from "./tool-registry.js";
import { runWorkflow as runWorkflowCore } from "./runtime.js";
import { fixedPlanPlanner, type FixedPlan } from "./fixed-plan.js";
import type { LwirWorkflow } from "./lwir.js";

export { isRunFailedError, RunFailedError } from "./runtime.js";
export type { FixedPlan } from "./fixed-plan.js";
export type { RunFailedCauseCode } from "./runtime.js";
export type { Skill } from "./skills.js";
export type { RemoteSkillOptions, SkillGitAuth, SkillOidcToken, SkillRiskLevel } from "./skills.js";

declare const workflowDefinitionTypes: unique symbol;

type WorkflowTypeBrand<TInput, TOutput> = {
  readonly [workflowDefinitionTypes]: {
    readonly input: (input: TInput) => TInput;
    readonly output: () => TOutput;
  };
};

export type Schema<TValue = unknown> = {
  readonly "~little-workflow/schema": {
    readonly value: TValue;
  };
};

export type StandardSchemaLike<TInput = unknown, TOutput = TInput> = {
  readonly "~standard": {
    readonly types?: {
      readonly input: TInput;
      readonly output: TOutput;
    };
  };
};

export type ParserSchemaLike<TValue = unknown> = {
  readonly parse: (input: unknown) => TValue;
};

type JsonPrimitive = string | number | boolean | null;

type JsonValue =
  | JsonPrimitive
  | { readonly [key: string]: JsonValue }
  | readonly JsonValue[];

type JsonSchemaDescriptor = boolean | { readonly [key: string]: JsonValue };

type UnknownJsonSchemaDescriptor<TValue> = [unknown] extends [TValue]
  ? JsonSchemaDescriptor
  : never;

export type InputSchemaLike<TInput = unknown> =
  | Schema<TInput>
  | StandardSchemaLike<TInput, unknown>
  | ParserSchemaLike<TInput>;

export type OutputSchemaLike<TOutput = unknown> =
  | Schema<TOutput>
  | StandardSchemaLike<unknown, TOutput>
  | ParserSchemaLike<TOutput>
  | UnknownJsonSchemaDescriptor<TOutput>;

export type SchemaLike<TValue = unknown> = InputSchemaLike<TValue> | OutputSchemaLike<TValue>;

export type ToolSelectionPolicy = "planner_selected" | "all" | "explicit_only";

export type ModelSelectionMetadata = {
  id?: string;
  description?: string;
};

export type ModelSlot<TModel = unknown> = {
  aiSdkModel: TModel;
  metadata: ModelSelectionMetadata;
};

export type PlannerConfig = {
  readonly model: unknown | ModelSlot;
  readonly harness?: Harness;
  readonly system?: string;
  readonly skills?: readonly Skill[];
  readonly skillMaxRisk?: SkillRiskLevel;
  readonly skillOidcToken?: SkillOidcToken;
  readonly tools?: ToolSet;
  readonly supervise?: (
    state: SuperviseOuterLoopState,
  ) => Promise<SuperviseDecision>;
};

export type WorkerConfig = {
  readonly harness?: Harness;
  readonly skills?: readonly Skill[];
  readonly skillMaxRisk?: SkillRiskLevel;
  readonly skillOidcToken?: SkillOidcToken;
  readonly tools?: ToolSet;
};

/**
 * Configures the orchestrator agent for `runOrchestration({ workflows: [...], orchestrator })`.
 *
 * @deprecated The orchestrator is one of two composition surfaces and the one being retired.
 * Compose with the Harness surface instead: author each workflow with `defineWorkflow`, adapt it
 * with `asHarnessWorkflow`, and pass the adapters to `createHarness({ workflows })`. Still
 * supported in this release; scheduled to be unexported in the next minor.
 */
export type OrchestratorConfig = {
  readonly model: unknown | ModelSlot;
  readonly harness?: Harness;
  readonly system?: string;
  readonly skills?: readonly Skill[];
  readonly skillMaxRisk?: SkillRiskLevel;
  readonly skillOidcToken?: SkillOidcToken;
  readonly tools?: ToolSet;
  readonly bash?: BashCapabilities;
};

export type MemoryConfig = {
  readonly workflow?: "rw" | "ro" | "none";
  readonly org?: "rw" | "ro" | "none";
  readonly attach?: ReadonlyArray<{ readonly id: string; readonly mode: "ro" }>;
};

type TextOutputMode<TOutput> = [unknown] extends [TOutput]
  ? { kind: "text"; name?: string; description?: string }
  : [TOutput] extends [string]
    ? { kind: "text"; name?: string; description?: string }
    : never;

type ArrayOutputMode<TOutput> = [unknown] extends [TOutput]
  ? { kind: "array"; element: OutputSchemaLike<unknown>; name?: string; description?: string }
  : TOutput extends readonly (infer TElement)[]
    ? { kind: "array"; element: OutputSchemaLike<TElement>; name?: string; description?: string }
    : never;

type ChoiceOutputMode<TOutput> = [unknown] extends [TOutput]
  ? {
      kind: "choice";
      values: readonly string[];
      name?: string;
      description?: string;
    }
  : [TOutput] extends [string]
    ? {
        kind: "choice";
        values: readonly TOutput[];
        name?: string;
        description?: string;
      }
    : never;

type JsonOutputMode<TOutput> = [unknown] extends [TOutput]
  ? { kind: "json"; schema?: OutputSchemaLike<unknown>; name?: string; description?: string }
  : { kind: "json"; schema: OutputSchemaLike<TOutput>; name?: string; description?: string };

export type OutputMode<TOutput = unknown> =
  | TextOutputMode<TOutput>
  | { kind: "object"; schema: OutputSchemaLike<TOutput>; name?: string; description?: string }
  | ArrayOutputMode<TOutput>
  | ChoiceOutputMode<TOutput>
  | JsonOutputMode<TOutput>;

export type WorkflowDefinition<TInput = unknown, TOutput = unknown> = {
  id: string;
  description?: string;
  /** Human-readable label for runs of this workflow. Defaults to the workflow id if not set. */
  label?: string;
  inputSchema?: InputSchemaLike<TInput>;
  output?: OutputMode<TOutput>;
  outputSchema?: OutputSchemaLike<TOutput>;
  suggestedInputSchema?: InputSchemaLike<unknown>;
  /** Execution model slots. Empty only for a workflow with a fixed `plan` and no model steps. */
  models: readonly ModelSlot[];
  planner: PlannerConfig;
  worker?: WorkerConfig;
  memory?: MemoryConfig;
  bash?: BashCapabilities;
  /** Names of tools registered in the ToolRegistry passed to compileWorkflow/runWorkflow. */
  globalTools?: readonly string[];
  toolSelection?: ToolSelectionPolicy;
  workflowVersionReuseStrategy?: WorkflowVersionReuseStrategy;
} & WorkflowTypeBrand<TInput, TOutput>;

export type InferWorkflowInput<TWorkflow> =
  TWorkflow extends {
    readonly [workflowDefinitionTypes]: {
      readonly input: (input: infer TInput) => unknown;
    };
  }
    ? TInput
    : never;

export type InferWorkflowOutput<TWorkflow> =
  TWorkflow extends {
    readonly [workflowDefinitionTypes]: {
      readonly output: () => infer TOutput;
    };
  }
    ? TOutput
    : never;

type AuthoredWorkflow<TInput = unknown, TOutput = unknown> = WorkflowDefinitionInput &
  WorkflowTypeBrand<TInput, TOutput>;

type AnyAuthoredWorkflow = AuthoredWorkflow<any, any>;

type NonEmptyWorkflowList = readonly [AnyAuthoredWorkflow, ...AnyAuthoredWorkflow[]];

export type LocalWorldOptions = {
  dataDir?: string;
  /**
   * Global cap on in-flight step attempts across all parallel groups in a run.
   * Targets local compute saturation when running compute-heavy workflows.
   * Default: undefined (unlimited). A sensible value for most workflows is
   * `os.availableParallelism()`.
   */
  maxConcurrentSteps?: number;
};

export type LocalWorld = World; // kind === "local-world"

export type RunResult<TOutput = unknown> = RunResultBase & {
  status: "completed";
  output: TOutput;
  /** How this run got its plan: drafted, kept, adapted or fixed, and whether the planner model was called. */
  plan: RunPlan;
};

/** INTERNAL. A completed run as the runtime builds it; `runWorkflow` adds `plan`. */
export type UnplannedRunResult<TOutput = unknown> = Omit<RunResult<TOutput>, "plan">;

export type FailedRunResult = RunResultBase & {
  status: "failed";
  output?: unknown;
};

type RunResultBase = {
  runId: string;
  workflowVersionId: string;
  /**
   * Real tokens and real dollars for the run, priced from the model registry.
   * `costUsd` is `null` when the run made model calls that could not be priced at all —
   * check `unpricedCalls` to tell an under-reported receipt from a genuine $0.
   */
  usage: UsageTotals;
  events: readonly EventEnvelope[];
  artifacts: readonly ArtifactRef[];
};

export type WorkflowRunTarget = AnyAuthoredWorkflow | WorkflowRunList;
type WorkflowRunList = NonEmptyWorkflowList;

export type WorkflowRunProgressEvent = {
  readonly currentStep?: string;
  readonly lastEvent?: unknown;
};

type InferRunWorkflowInput<TWorkflow extends WorkflowRunTarget> =
  TWorkflow extends WorkflowRunList ? unknown : InferWorkflowInput<TWorkflow>;

/**
 * How a run started, recorded as `trigger` on its `RunStarted` event for trace readers such as
 * LittleDB. A run without one started from the app's own code. `asHarnessWorkflow` sets
 * `{ kind: "harness", sessionId, turnId, toolCallId }`: the harness tool call that started it.
 */
export type RunTrigger = {
  /** A short word: `harness`, `api`, `schedule`, `webhook`, or your own. */
  readonly kind: string;
  /** Where it came from: a route (`POST /loans`), a schedule id, a harness slug. */
  readonly source?: string;
  /** Who asked for it, as the channel names them. */
  readonly from?: string;
  /** A short label for people. */
  readonly label?: string;
  /** With kind `harness`: the harness session, turn and tool call that started the run. */
  readonly sessionId?: string;
  readonly turnId?: string;
  readonly toolCallId?: string;
};

/**
 * Options for `runWorkflow(workflow, input, options)` and its sugar `workflow.run(input, options)`.
 * Every field is optional: `world` defaults to `localWorld()` (`.little-workflow` in the working
 * directory) and `tools` to the tools declared on the workflow.
 */
export type RunWorkflowOptions = {
  /** Where the run's events and artifacts are stored. Defaults to `localWorld()`. */
  readonly world?: World;
  /** Reuse an id to resume or replay that run. Omitted, a fresh `run_<uuid>` is used. */
  readonly runId?: RunId;
  readonly timeout?: string | number;
  readonly signal?: AbortSignal;
  /** Tools for this run. Defaults to the tools declared on the workflow. */
  readonly tools?: ToolRegistry;
  readonly mcp?: HarnessMcpConfig;
  readonly bash?: BashCapabilities;
  readonly maxAttempts?: number;
  readonly maxOuterCycles?: number;
  readonly outerLoopId?: string;
  /** Human-readable label for this run. Overrides the workflow definition label and defaults to the workflow id. */
  readonly label?: string;
  /** Free-form tags for filtering in the trace store. */
  readonly tags?: readonly string[];
  /** How this run started, recorded on its `RunStarted` event. Child runs record `parentRunId` instead. */
  readonly trigger?: RunTrigger;
  readonly workflowVersionReuseStrategy?: WorkflowVersionReuseStrategy;
  /**
   * Receives step lifecycle progress after runtime StepScheduled,
   * StepAttemptStarted, StepFailed, and StepCompleted events are recorded.
   */
  readonly progress?: (event: WorkflowRunProgressEvent) => void | Promise<void>;
  /**
   * Runtime tool-call policy for the model (allow/deny/ask over tool names).
   * Governs the orchestrator's own tool calls; every sub-run inherits the
   * parent's denies, so a delegated worker can never re-enable a forbidden
   * tool. Absent means unrestricted (the compile-time tool contract still
   * applies).
   */
  readonly permissions?: ToolPermissions;
};

/**
 * Options for {@link runOrchestration}: the run options plus the workflows the orchestrator agent
 * may plan and run, the shared input, and the orchestrator config.
 *
 * @deprecated The orchestrator composition surface is being retired. Compose workflows with
 * `asHarnessWorkflow` + `createHarness({ workflows })` instead.
 */
export type RunOrchestrationOptions<TWorkflows extends WorkflowRunList = WorkflowRunList> =
  Omit<RunWorkflowOptions, "maxOuterCycles" | "outerLoopId"> & {
    readonly workflows: TWorkflows;
    readonly input: unknown;
    readonly orchestrator: OrchestratorConfig;
    /** Cap on concurrently running sub-workflow runs. Default 10. */
    readonly maxConcurrentSubRuns?: number;
  };

type BaseRunWorkflowRequest<TWorkflow extends WorkflowRunTarget> = Omit<RunWorkflowOptions, "world"> & {
  world: LocalWorld;
  workflows: TWorkflow;
  input: NoInfer<InferRunWorkflowInput<TWorkflow>>;
  maxConcurrentSubRuns?: number;
};

type SingleRunWorkflowRequest<TWorkflow extends AnyAuthoredWorkflow> = BaseRunWorkflowRequest<TWorkflow> & {
  orchestrator?: never;
};

type MultiRunWorkflowRequest<TWorkflows extends WorkflowRunList> = BaseRunWorkflowRequest<TWorkflows> & {
  orchestrator: OrchestratorConfig;
};

/**
 * INTERNAL. The runtime's single request object (world, workflow or workflows, input, run options)
 * that `runWorkflow` and `runOrchestration` build. Not a public calling convention.
 */
export type RunWorkflowRequest<TWorkflow extends WorkflowRunTarget = WorkflowRunTarget> =
  TWorkflow extends WorkflowRunList
    ? MultiRunWorkflowRequest<TWorkflow>
    : TWorkflow extends AnyAuthoredWorkflow
      ? SingleRunWorkflowRequest<TWorkflow>
      : never;

export type RuntimeOptions = {
  world?: LocalWorld;
  plugins?: unknown[];
  skills?: unknown[];
  mcp?: HarnessMcpConfig;
};

type WorkflowDefinitionInput = {
  id: string;
  description?: string;
  /** Rules the runtime adds, word for word, to the system prompt of every `ai.generate` step. */
  policy?: string;
  /** Human-readable label for runs of this workflow. Defaults to the workflow id if not set. */
  label?: string;
  inputSchema?: unknown;
  output?: LooseOutputModeInput;
  outputSchema?: unknown;
  suggestedInputSchema?: unknown;
  models: readonly ModelSlot[];
  planner: PlannerConfig;
  worker?: WorkerConfig;
  memory?: MemoryConfig;
  bash?: BashCapabilities;
  globalTools?: readonly string[];
  toolSelection?: ToolSelectionPolicy;
  workflowVersionReuseStrategy?: WorkflowVersionReuseStrategy;
  workflowVersionReuse?: never;
};

type LooseOutputModeTag<TKind extends string> =
  | { readonly kind: TKind; readonly type?: TKind }
  | { readonly type: TKind };

type LooseOutputModeInput =
  | (LooseOutputModeTag<"text"> & {
      readonly name?: string;
      readonly description?: string;
    })
  | (LooseOutputModeTag<"object"> & {
      readonly schema: unknown;
      readonly name?: string;
      readonly description?: string;
    })
  | (LooseOutputModeTag<"array"> & {
      readonly name?: string;
      readonly description?: string;
    } & (
      | { readonly element: unknown; readonly schema?: never }
      | { readonly schema: unknown; readonly element?: never }
    ))
  | (LooseOutputModeTag<"choice"> & {
      readonly name?: string;
      readonly description?: string;
    } & (
      | { readonly values: readonly string[]; readonly options?: never; readonly enum?: never }
      | { readonly options: readonly string[]; readonly values?: never; readonly enum?: never }
      | { readonly enum: readonly string[]; readonly values?: never; readonly options?: never }
    ))
  | (LooseOutputModeTag<"json"> & {
      readonly schema?: unknown;
      readonly name?: string;
      readonly description?: string;
    });

type StandardSchemaTypes<TSchema> = TSchema extends {
  "~standard": {
    types?: infer TTypes;
  };
}
  ? NonNullable<TTypes>
  : never;

type StandardSchemaInput<TSchema> =
  [StandardSchemaTypes<TSchema>] extends [never]
    ? never
    : StandardSchemaTypes<TSchema> extends { input: infer TInput }
      ? TInput
      : never;

type StandardSchemaOutput<TSchema> =
  [StandardSchemaTypes<TSchema>] extends [never]
    ? never
    : StandardSchemaTypes<TSchema> extends { output: infer TOutput }
      ? TOutput
      : never;

type InferSchemaInput<TSchema> =
  [StandardSchemaInput<TSchema>] extends [never]
    ? TSchema extends { _input: infer TInput }
      ? TInput
      : TSchema extends Schema<infer TValue>
        ? TValue
        : TSchema extends { readonly parse: (input: unknown) => infer TOutput }
          ? TOutput
          : unknown
    : StandardSchemaInput<TSchema>;

type InferSchemaOutput<TSchema> =
  [StandardSchemaOutput<TSchema>] extends [never]
    ? TSchema extends { _output: infer TOutput }
      ? TOutput
      : TSchema extends Schema<infer TValue>
        ? TValue
        : TSchema extends { readonly parse: (input: unknown) => infer TOutput }
          ? TOutput
          : unknown
    : StandardSchemaOutput<TSchema>;

type OutputModeTagOf<TOutput> = TOutput extends { readonly kind: infer TKind }
  ? TKind
  : TOutput extends { readonly type: infer TType }
    ? TType
    : never;

type OutputArraySchema<TOutput> = TOutput extends { readonly element: infer TElementSchema }
  ? TElementSchema
  : TOutput extends { readonly schema: infer TElementSchema }
    ? TElementSchema
    : never;

type OutputChoiceValues<TOutput> = TOutput extends {
  readonly values: infer TValues extends readonly unknown[];
}
  ? TValues
  : TOutput extends { readonly options: infer TOptions extends readonly unknown[] }
    ? TOptions
    : TOutput extends { readonly enum: infer TEnum extends readonly unknown[] }
      ? TEnum
      : readonly unknown[];

type InferOutputMode<TOutput> = OutputModeTagOf<TOutput> extends "text"
  ? string
  : OutputModeTagOf<TOutput> extends "object"
    ? TOutput extends { readonly schema: infer TSchema }
      ? InferSchemaOutput<TSchema>
      : unknown
    : OutputModeTagOf<TOutput> extends "array"
      ? InferSchemaOutput<OutputArraySchema<TOutput>>[]
      : OutputModeTagOf<TOutput> extends "choice"
        ? OutputChoiceValues<TOutput>[number]
        : OutputModeTagOf<TOutput> extends "json"
          ? TOutput extends { readonly schema: infer TSchema }
            ? InferSchemaOutput<TSchema>
            : unknown
          : unknown;

type InferDefinitionInput<TDefinition> = TDefinition extends {
  readonly inputSchema: infer TSchema;
}
  ? InferSchemaInput<TSchema>
  : unknown;

type InferDefinitionOutput<TDefinition> = TDefinition extends { readonly output: infer TOutput }
  ? InferOutputMode<TOutput>
  : TDefinition extends { readonly outputSchema: infer TSchema }
    ? InferSchemaOutput<TSchema>
    : unknown;

export function createLittleWorkflow<const TDefinition extends WorkflowDefinitionInput>(
  definition: TDefinition,
): TDefinition &
  WorkflowTypeBrand<InferDefinitionInput<TDefinition>, InferDefinitionOutput<TDefinition>>;
export function createLittleWorkflow(definition: WorkflowDefinitionInput): WorkflowDefinitionInput {
  return definition;
}

/**
 * What `defineWorkflow` takes. Name the workflow, give its `input` and `output` schemas, and say
 * how it gets a plan: a `model` (or several `models`) that a planner drafts a plan for, or a fixed
 * `plan` you write yourself.
 */
export type DefineWorkflowInput = {
  /** Stable identifier; hashed into the workflow definition hash. */
  readonly id: string;
  /** Shown to the planner, and used as the tool description by `asHarnessWorkflow`. */
  readonly description?: string;
  /**
   * Rules every model step must follow, such as a lending policy. The runtime adds this text, word
   * for word, to the system prompt of every `ai.generate` step, whoever wrote the plan. The planner
   * sees it too, and a changed policy sends a saved plan back to the planner for review.
   */
  readonly policy?: string;
  /** Human-readable run label; defaults to the workflow id. */
  readonly label?: string;
  /** The input schema (Zod, Standard Schema or JSON Schema). Validated at run start. */
  readonly input?: unknown;
  /** A schema hint shown to the planner. Not used to validate input. */
  readonly suggestedInput?: unknown;
  /** A plain schema (array/object/text inferred) or an explicit `output.*` mode. */
  readonly output?: unknown;
  /** One AI SDK model (or `model(...)` slot) for the workflow's steps. Use `models` for several. */
  readonly model?: unknown;
  /**
   * Several model slots the plan chooses between by slot id, for example
   * `[model(fast, { id: "fast" }), model(deep, { id: "deep" })]`. Use `model` for one.
   */
  readonly models?: readonly unknown[];
  /**
   * The planner: a bare model, a `model(...)` slot, or a full `PlannerConfig` (system prompt,
   * skills, custom harness, outer-loop `supervise`). Defaults to the first model.
   */
  readonly planner?: unknown;
  /**
   * A fixed plan: run these steps instead of asking a planner model. `{ steps }` is completed from
   * this definition (name, input and output schemas); a complete LWIR document is used as written.
   * A fixed-plan workflow needs no `model` unless its steps call one.
   */
  readonly plan?: FixedPlan | LwirWorkflow;
  /**
   * The tools the plan may call: AI SDK tools keyed by name, a `ToolRegistry`, or the names of
   * tools the run supplies (through `runWorkflow(..., { tools })` or the `mcp` gateway).
   */
  readonly tools?: Record<string, AiSdkTool> | ToolRegistry | readonly string[];
  /** Which declared tools the plan may reference. Default `"planner_selected"`. */
  readonly toolSelection?: ToolSelectionPolicy;
  /** Whether the planner may reuse a prior compiled version. Default `"planner_reviewed"`. */
  readonly workflowVersionReuseStrategy?: WorkflowVersionReuseStrategy;
  readonly worker?: WorkerConfig;
  readonly memory?: MemoryConfig;
  readonly bash?: BashCapabilities;
};

const inlineToolRegistryByWorkflow = new WeakMap<object, ToolRegistry>();

function definitionPolicy(options: DefineWorkflowInput): string {
  if (typeof options.policy !== "string" || options.policy.trim().length === 0) {
    throw new TypeError(`defineWorkflow '${options.id}': policy must be a non-empty string.`);
  }
  return options.policy;
}

/** The tool registry built from a `defineWorkflow` definition's inline `tools`, if any. */
export function inlineToolRegistryFor(workflow: object): ToolRegistry | undefined {
  return inlineToolRegistryByWorkflow.get(workflow);
}

/** A workflow authored via {@link defineWorkflow}: the full definition plus a typed `run` method. */
export type DefinedWorkflow<TInput = unknown, TOutput = unknown> = WorkflowDefinition<TInput, TOutput> & {
  /** Sugar for `runWorkflow(workflow, input, options)`: the same options and result. */
  run(input: TInput, options?: RunWorkflowOptions): Promise<RunResult<TOutput>>;
};

type DefineWorkflowInputOf<TDefinition> = TDefinition extends { readonly input: infer TInputSchema }
  ? InferSchemaInput<TInputSchema>
  : unknown;

type DefineWorkflowOutputOf<TDefinition> = TDefinition extends { readonly output: infer TOutputValue }
  ? TOutputValue extends { readonly kind: string }
    ? InferOutputMode<TOutputValue>
    : InferSchemaOutput<TOutputValue>
  : unknown;

/**
 * Define a workflow. Plain `input`/`output` schemas, one `model` or several `models`, an optional
 * `planner`, a fixed `plan`, and the workflow's `tools` are normalized into the shape the runtime
 * runs (model slots, a planner config, an output mode and the declared tool names). The schema
 * types flow through, so `runWorkflow(workflow, input).output` is typed.
 */
export function defineWorkflow<const TDefinition extends DefineWorkflowInput>(
  options: TDefinition,
): DefinedWorkflow<DefineWorkflowInputOf<TDefinition>, DefineWorkflowOutputOf<TDefinition>> {
  const tools = definitionTools(options);
  const models = definitionModelSlots(options);
  const base = {
    id: options.id,
    ...(options.description === undefined ? {} : { description: options.description }),
    ...(options.policy === undefined ? {} : { policy: definitionPolicy(options) }),
    ...(options.label === undefined ? {} : { label: options.label }),
    ...(options.input === undefined ? {} : { inputSchema: options.input }),
    ...(options.suggestedInput === undefined ? {} : { suggestedInputSchema: options.suggestedInput }),
    ...(options.output === undefined ? {} : { output: inferOutputMode(options.output) }),
  };
  const normalized: WorkflowDefinitionInput = {
    ...base,
    models,
    planner: definitionPlanner(options, base, models),
    ...(options.worker === undefined ? {} : { worker: options.worker }),
    ...(options.memory === undefined ? {} : { memory: options.memory }),
    ...(options.bash === undefined ? {} : { bash: options.bash }),
    ...(tools.names === undefined ? {} : { globalTools: tools.names }),
    ...(options.toolSelection === undefined ? {} : { toolSelection: options.toolSelection }),
    ...(options.workflowVersionReuseStrategy === undefined
      ? {}
      : { workflowVersionReuseStrategy: options.workflowVersionReuseStrategy }),
  };
  const workflow = createLittleWorkflow(normalized);
  if (tools.registry !== undefined) {
    inlineToolRegistryByWorkflow.set(workflow as object, tools.registry);
  }
  return Object.assign(workflow, {
    run(input: unknown, runOptions?: RunWorkflowOptions) {
      return runWorkflowCore(
        buildRunWorkflowOptions(workflow as AnyAuthoredWorkflow, input as never, runOptions),
      );
    },
  }) as unknown as DefinedWorkflow<
    DefineWorkflowInputOf<TDefinition>,
    DefineWorkflowOutputOf<TDefinition>
  >;
}

function definitionModelSlots(options: DefineWorkflowInput): readonly ModelSlot[] {
  if (options.model !== undefined && options.models !== undefined) {
    throw new TypeError(`defineWorkflow '${options.id}': pass either model or models, not both.`);
  }
  if (options.models !== undefined) {
    if (!Array.isArray(options.models) || options.models.length === 0) {
      throw new TypeError(`defineWorkflow '${options.id}': models must list at least one model.`);
    }
    return options.models.map(toModelSlot);
  }
  if (options.model !== undefined) {
    return [toModelSlot(options.model)];
  }
  if (options.plan !== undefined) {
    return [];
  }
  throw new TypeError(
    `defineWorkflow '${options.id}': set model (or models) so a planner can draft the plan, or plan to fix it.`,
  );
}

function definitionPlanner(
  options: DefineWorkflowInput,
  base: Parameters<typeof fixedPlanPlanner>[0],
  models: readonly ModelSlot[],
): PlannerConfig {
  if (options.plan !== undefined) {
    if (options.planner !== undefined) {
      throw new TypeError(`defineWorkflow '${options.id}': a fixed plan replaces the planner; pass plan or planner, not both.`);
    }
    return fixedPlanPlanner(base, options.plan);
  }
  if (isPlannerConfig(options.planner)) {
    return options.planner;
  }
  return { model: options.planner ?? options.model ?? models[0] };
}

function definitionTools(options: DefineWorkflowInput): {
  readonly registry?: ToolRegistry;
  readonly names?: readonly string[];
} {
  const tools = options.tools;
  if (tools === undefined) {
    return {};
  }
  if (Array.isArray(tools)) {
    if (!tools.every((name) => typeof name === "string" && name.length > 0)) {
      throw new TypeError(`defineWorkflow '${options.id}': tool names must be non-empty strings.`);
    }
    return { names: [...tools] };
  }
  const registry = isToolRegistry(tools) ? tools : createToolRegistry(tools as Record<string, AiSdkTool>);
  return { registry, names: registry.names() };
}

function isToolRegistry(value: unknown): value is ToolRegistry {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Partial<ToolRegistry>).names === "function" &&
    typeof (value as Partial<ToolRegistry>).get === "function" &&
    typeof (value as Partial<ToolRegistry>).snapshotForManifest === "function"
  );
}

function toModelSlot(value: unknown): ModelSlot {
  return isModelSlot(value) ? value : model(value);
}

function isModelSlot(value: unknown): value is ModelSlot {
  return typeof value === "object" && value !== null && "aiSdkModel" in value && "metadata" in value;
}

function isPlannerConfig(value: unknown): value is PlannerConfig {
  return typeof value === "object" && value !== null && "model" in value;
}

function inferOutputMode(value: unknown): LooseOutputModeInput {
  if (isOutputModeInput(value)) {
    return value;
  }
  const descriptor = normalizeSchema(value);
  if (typeof descriptor === "object" && descriptor !== null) {
    const type = (descriptor as { readonly type?: unknown }).type;
    if (type === "array") {
      const items = (descriptor as { readonly items?: unknown }).items;
      return outputBuilder.array({ element: (items === undefined ? true : items) as never });
    }
    if (type === "string") {
      return outputBuilder.text();
    }
    if (type === "object") {
      return outputBuilder.object({ schema: descriptor as never });
    }
  }
  return outputBuilder.object({ schema: descriptor as never });
}

function isOutputModeInput(value: unknown): value is LooseOutputModeInput {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { readonly kind?: unknown }).kind === "string"
  );
}

/** INTERNAL. Build the runtime request for `runWorkflow(workflow, input, options)`. */
export function buildRunWorkflowOptions<TWorkflow extends AnyAuthoredWorkflow>(
  workflow: TWorkflow,
  input: InferWorkflowInput<TWorkflow>,
  options?: RunWorkflowOptions,
): RunWorkflowRequest<TWorkflow> {
  const { world, tools, ...rest } = options ?? {};
  const resolvedTools = tools ?? inlineToolRegistryFor(workflow);
  return {
    world: world ?? localWorld(),
    workflows: workflow,
    input,
    ...(resolvedTools === undefined ? {} : { tools: resolvedTools }),
    ...rest,
  } as RunWorkflowRequest<TWorkflow>;
}

/**
 * Run one workflow and return its typed result. `options.world` defaults to `localWorld()` and
 * `options.tools` to the tools declared on the workflow; `workflow.run(input, options)` is the same
 * call. A failed run throws {@link RunFailedError}; test for it with `isRunFailedError(error)`.
 */
export async function runWorkflow<TWorkflow extends AnyAuthoredWorkflow>(
  workflow: TWorkflow,
  input: InferWorkflowInput<TWorkflow>,
  options?: RunWorkflowOptions,
): Promise<RunResult<InferWorkflowOutput<TWorkflow>>> {
  if (Array.isArray(workflow)) {
    throw new TypeError(
      "runWorkflow runs one workflow. Compose several with asHarnessWorkflow + createHarness({ workflows }), or use the deprecated runOrchestration({ workflows, orchestrator, input }).",
    );
  }
  if (typeof workflow === "object" && workflow !== null && "workflows" in workflow && !("id" in workflow)) {
    throw new TypeError(
      "runWorkflow(options) was removed: call runWorkflow(workflow, input, { world, ... }). For a workflow array use runOrchestration(options).",
    );
  }
  return runWorkflowCore(buildRunWorkflowOptions(workflow, input, options)) as Promise<
    RunResult<InferWorkflowOutput<TWorkflow>>
  >;
}

/**
 * Let an orchestrator agent plan and run several workflows (`plan_workflow` / `run_workflow` /
 * `start_workflow`) for one input. `world` defaults to `localWorld()`.
 *
 * @deprecated The orchestrator composition surface is being retired. Adapt each workflow with
 * `asHarnessWorkflow` and pass them to `createHarness({ workflows })` from `@little-stack/harness`.
 * Calling this emits a one-time `DeprecationWarning` (`LWF_DEP_ORCHESTRATOR`).
 */
export async function runOrchestration<TWorkflows extends WorkflowRunList>(
  options: RunOrchestrationOptions<TWorkflows>,
): Promise<Omit<RunResult<unknown>, "plan">> {
  if (!Array.isArray(options.workflows) || options.workflows.length === 0) {
    throw new TypeError(
      "runOrchestration requires a non-empty workflows array. Run a single workflow with runWorkflow(workflow, input).",
    );
  }
  const { world, ...rest } = options;
  return runWorkflowCore({
    ...rest,
    world: world ?? localWorld(),
  } as unknown as RunWorkflowRequest<TWorkflows>) as Promise<Omit<RunResult<unknown>, "plan">>;
}

export function model<const TModel = unknown>(
  aiSdkModel: TModel,
  metadata: ModelSelectionMetadata = {},
): ModelSlot<TModel> {
  return createModelSlot(aiSdkModel, metadata);
}

export function createRuntime(_options: RuntimeOptions = {}): never {
  throw new Error("createRuntime arrives after alpha; use runWorkflow() for v0.1.0-alpha.");
}

export function localWorld(options: LocalWorldOptions = {}): LocalWorld {
  return createLocalWorld({
    dataDir: options.dataDir ?? ".little-workflow",
    ...(options.maxConcurrentSteps !== undefined
      ? { maxConcurrentSteps: options.maxConcurrentSteps }
      : {}),
  });
}

export function skill(pathOrUrl: string, options?: RemoteSkillOptions): Skill {
  return createSkill(pathOrUrl, options);
}
