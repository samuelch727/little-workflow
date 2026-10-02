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
import type { HarnessMcpConfig } from "little-harness";
import { normalizeSchema, output as outputBuilder } from "./schema.js";
import { createToolRegistry, type AiSdkTool, type ToolRegistry } from "./tool-registry.js";
import { runWorkflow as runWorkflowCore } from "./runtime.js";

export { RunFailedError } from "./runtime.js";
export type { RunFailedCauseCode } from "./runtime.js";
export type {
  HarnessMcpCapabilityManifest,
  HarnessMcpClient,
  HarnessMcpClientOptions,
  HarnessMcpConfig,
  HarnessMcpGatewayConfig,
  HarnessMcpServerConfig,
  HarnessMcpToolPolicy,
  HarnessMcpToolSchema,
  HarnessMcpToolSchemas,
  HarnessMcpTransportConfig,
  ResolvedHarnessMcpGateway,
} from "little-harness";
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
 * Configures the orchestrator agent for `runWorkflow({ workflows: [...], orchestrator })`.
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
  models: NonEmptyModelSlotList;
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

type NonEmptyModelSlotList = readonly [ModelSlot, ...ModelSlot[]];

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
};

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

type BaseRunWorkflowOptions<TWorkflow extends WorkflowRunTarget> = {
  world: LocalWorld;
  workflows: TWorkflow;
  input: NoInfer<InferRunWorkflowInput<TWorkflow>>;
  runId?: RunId;
  timeout?: string | number;
  signal?: AbortSignal;
  tools?: import("./tool-registry.js").ToolRegistry;
  mcp?: HarnessMcpConfig;
  bash?: BashCapabilities;
  maxAttempts?: number;
  maxOuterCycles?: number;
  outerLoopId?: string;
  maxConcurrentSubRuns?: number;
  /** Human-readable label for this run. Overrides the workflow definition label and defaults to the workflow id. */
  label?: string;
  /** Free-form tags for filtering in the trace store. */
  tags?: readonly string[];
  workflowVersionReuseStrategy?: WorkflowVersionReuseStrategy;
  /**
   * Receives step lifecycle progress after runtime StepScheduled,
   * StepAttemptStarted, StepFailed, and StepCompleted events are recorded.
   */
  progress?: (event: WorkflowRunProgressEvent) => void | Promise<void>;
  /**
   * Runtime tool-call policy for the model (allow/deny/ask over tool names).
   * Governs the orchestrator's own tool calls; every sub-run inherits the
   * parent's denies, so a delegated worker can never re-enable a forbidden
   * tool. Absent means unrestricted (the compile-time tool contract still
   * applies).
   */
  permissions?: ToolPermissions;
};

type SingleRunWorkflowOptions<TWorkflow extends AnyAuthoredWorkflow> = BaseRunWorkflowOptions<TWorkflow> & {
  orchestrator?: never;
};

type MultiRunWorkflowOptions<TWorkflows extends WorkflowRunList> = BaseRunWorkflowOptions<TWorkflows> & {
  /**
   * @deprecated Passing an array of workflows plus an `orchestrator` config selects the
   * deprecated orchestrator composition surface (`plan_workflow` / `run_workflow` /
   * `start_workflow`). Compose with `asHarnessWorkflow` + `createHarness({ workflows })` instead.
   * `runWorkflow` with a single workflow is not deprecated.
   */
  orchestrator: OrchestratorConfig;
};

export type RunWorkflowOptions<TWorkflow extends WorkflowRunTarget = WorkflowRunTarget> =
  TWorkflow extends WorkflowRunList
    ? MultiRunWorkflowOptions<TWorkflow>
    : TWorkflow extends AnyAuthoredWorkflow
      ? SingleRunWorkflowOptions<TWorkflow>
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
  /** Human-readable label for runs of this workflow. Defaults to the workflow id if not set. */
  label?: string;
  inputSchema?: unknown;
  output?: LooseOutputModeInput;
  outputSchema?: unknown;
  suggestedInputSchema?: unknown;
  models: NonEmptyModelSlotList;
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

export type DefineWorkflowInput = {
  readonly id: string;
  readonly description?: string;
  readonly label?: string;
  /** A schema for the workflow's input (mapped onto `inputSchema`). */
  readonly input?: unknown;
  /** A plain schema (array/object/text inferred) or an explicit `output.*` mode. */
  readonly output?: unknown;
  /** A single AI-SDK model for the worker(s); wrapped into a one-slot `models` tuple. */
  readonly model: unknown;
  /** Optional planner override: a bare model (lifted into a PlannerConfig) or a full PlannerConfig. */
  readonly planner?: unknown;
  /** Inline tools keyed by name; built into a registry, names exposed via `globalTools`. */
  readonly tools?: Record<string, AiSdkTool>;
  readonly worker?: WorkerConfig;
  readonly memory?: MemoryConfig;
  readonly bash?: BashCapabilities;
};

const inlineToolRegistryByWorkflow = new WeakMap<object, ToolRegistry>();

/** The tool registry built from a `defineWorkflow` definition's inline `tools`, if any. */
export function inlineToolRegistryFor(workflow: object): ToolRegistry | undefined {
  return inlineToolRegistryByWorkflow.get(workflow);
}

/** A workflow authored via {@link defineWorkflow}: the full definition plus a typed `run` method. */
export type DefinedWorkflow<TInput = unknown, TOutput = unknown> = WorkflowDefinition<TInput, TOutput> & {
  /** Run this workflow against a typed input, defaulting the world and inline tool registry. */
  run(input: TInput, options?: ErgonomicRunWorkflowOptions): Promise<RunResult<TOutput>>;
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
 * Ergonomic, eve-style front door over {@link createLittleWorkflow}: a single `model`,
 * plain `input`/`output` schemas, and inline `tools` are normalized into the
 * fully-specified shape the runtime already expects (a `models` tuple, a synthesized
 * `planner`, an inferred `OutputMode`, and `globalTools`). The input/output schema types
 * flow through to the brand, so `runWorkflow(def, input).output` is fully typed. The engine
 * is unchanged.
 */
export function defineWorkflow<const TDefinition extends DefineWorkflowInput>(
  options: TDefinition,
): DefinedWorkflow<DefineWorkflowInputOf<TDefinition>, DefineWorkflowOutputOf<TDefinition>> {
  const registry = options.tools === undefined ? undefined : createToolRegistry(options.tools);
  const normalized: WorkflowDefinitionInput = {
    id: options.id,
    ...(options.description === undefined ? {} : { description: options.description }),
    ...(options.label === undefined ? {} : { label: options.label }),
    ...(options.input === undefined ? {} : { inputSchema: options.input }),
    ...(options.output === undefined ? {} : { output: inferOutputMode(options.output) }),
    models: [model(options.model)] as readonly [ModelSlot, ...ModelSlot[]],
    planner: normalizePlanner(options),
    ...(options.worker === undefined ? {} : { worker: options.worker }),
    ...(options.memory === undefined ? {} : { memory: options.memory }),
    ...(options.bash === undefined ? {} : { bash: options.bash }),
    ...(registry === undefined ? {} : { globalTools: registry.names() }),
  };
  const workflow = createLittleWorkflow(normalized);
  if (registry !== undefined) {
    inlineToolRegistryByWorkflow.set(workflow as object, registry);
  }
  return Object.assign(workflow, {
    run(input: unknown, runOptions?: ErgonomicRunWorkflowOptions) {
      return runWorkflowCore(
        buildRunWorkflowOptions(workflow as AnyAuthoredWorkflow, input as never, runOptions),
      );
    },
  }) as unknown as DefinedWorkflow<
    DefineWorkflowInputOf<TDefinition>,
    DefineWorkflowOutputOf<TDefinition>
  >;
}

function normalizePlanner(options: DefineWorkflowInput): PlannerConfig {
  if (isPlannerConfig(options.planner)) {
    return options.planner;
  }
  return { model: options.planner ?? options.model };
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

/** Ergonomic `runWorkflow(def, input, opts?)` options: everything but the implied workflow/input, with an optional world. */
export type ErgonomicRunWorkflowOptions = Omit<
  RunWorkflowOptions<AnyAuthoredWorkflow>,
  "workflows" | "input" | "world"
> & { readonly world?: LocalWorld };

/** Build the runtime's options object for the ergonomic two-arg `runWorkflow(def, input)` form. */
export function buildRunWorkflowOptions<TWorkflow extends AnyAuthoredWorkflow>(
  workflow: TWorkflow,
  input: InferWorkflowInput<TWorkflow>,
  options?: ErgonomicRunWorkflowOptions,
): RunWorkflowOptions<TWorkflow> {
  const { world, tools, ...rest } = options ?? {};
  const resolvedTools = tools ?? inlineToolRegistryFor(workflow);
  return {
    world: world ?? localWorld(),
    workflows: workflow,
    input,
    ...(resolvedTools === undefined ? {} : { tools: resolvedTools }),
    ...rest,
  } as RunWorkflowOptions<TWorkflow>;
}

/**
 * Run a workflow. Accepts the power-user options object **or** the ergonomic
 * `runWorkflow(def, input, opts?)` form (defaults the world + inline tool registry).
 */
export async function runWorkflow<TWorkflow extends WorkflowRunTarget = WorkflowRunTarget>(
  options: RunWorkflowOptions<TWorkflow>,
): Promise<RunResult<InferWorkflowOutput<TWorkflow>>>;
export async function runWorkflow<TWorkflow extends AnyAuthoredWorkflow>(
  workflow: TWorkflow,
  input: InferWorkflowInput<TWorkflow>,
  options?: ErgonomicRunWorkflowOptions,
): Promise<RunResult<InferWorkflowOutput<TWorkflow>>>;
export async function runWorkflow(
  optionsOrWorkflow: RunWorkflowOptions<WorkflowRunTarget> | AnyAuthoredWorkflow,
  input?: unknown,
  options?: ErgonomicRunWorkflowOptions,
): Promise<RunResult<unknown>> {
  if (isRunWorkflowOptionsObject(optionsOrWorkflow)) {
    return runWorkflowCore<WorkflowRunTarget>(optionsOrWorkflow);
  }
  return runWorkflowCore(
    buildRunWorkflowOptions(optionsOrWorkflow, input as never, options),
  );
}

function isRunWorkflowOptionsObject(
  value: RunWorkflowOptions<WorkflowRunTarget> | AnyAuthoredWorkflow,
): value is RunWorkflowOptions<WorkflowRunTarget> {
  return typeof value === "object" && value !== null && "workflows" in value;
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
