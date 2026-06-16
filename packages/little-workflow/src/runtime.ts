import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  realpath,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve as resolvePath } from "node:path";
import { canonicalJson, sha256Digest } from "./canonical.js";
import {
  createBashTool,
  normalizeBashCapabilities,
  type BashCapabilities,
} from "./bash-tool.js";
import type { ToolRegistry } from "./tool-registry.js";
import {
  fixerManifest,
  hashHarnessManifest,
  orchestratorManifest,
  type SkillManifestIdentity,
  workerManifest,
} from "./manifests.js";
import {
  computeCompiledWorkflowVersionIdentity,
  computeCompilerValidationHash,
  lwirVersionIdForHash,
  workflowVersionLockSeedFrom,
  type WorkflowVersionLockEnvelope,
} from "./compiler-lock.js";
import {
  compileWorkflow,
  PlannerReuseUnchangedDecisionError,
  requestedOutputHashForWorkflow,
  WorkflowCompileError,
  WorkflowInputValidationError,
  WorkflowMissingToolError,
  WorkflowSchemaValidationError,
  type CompilerLifecycleEvent,
  type CompilerRevision,
  type CompilableWorkflowDefinition,
  type OrchestrationRequest,
  type PlannerAdapter,
  type WorkflowCompileResult,
} from "./compiler.js";
import { resolveExpressionValue, type ExpressionContext } from "./expressions.js";
import { model as createModelSlot, resolveModelSlots } from "./model-slots.js";
import type {
  FailedRunResult,
  InferWorkflowOutput,
  LocalWorld,
  MemoryConfig,
  Skill,
  RunResult,
  RunWorkflowOptions,
  WorkflowRunTarget,
} from "./authoring.js";
import type { LwirStep, LwirWorkflow, WorkflowVersion } from "./lwir.js";
import { materializeRunStateFromEvents } from "./run-state.js";
import { remoteSkillIdentityFromValue } from "./skills.js";
import {
  normalizeOutputMode,
  normalizeSchema,
  type NormalizedOutputMode,
  type NormalizedSchemaDescriptor,
} from "./schema.js";
import {
  createHarnessEventRecorder,
  errorEnvelope as harnessErrorEnvelope,
} from "./harness/event-recorder.js";
import { normalizeHarnessEventType } from "./harness/event-names.js";
import {
  runWorkflowHarnessWithSession,
  workflowHarness,
} from "little-harness/workflow-harness";
import type {
  ExecuteStepTask,
  FixStepTask,
  Harness,
  HarnessContext,
  HarnessResult,
  HarnessTask,
  ToolSet as HarnessToolSet,
} from "./harness/types.js";
import {
  ensureMemoryMounts,
  orchestratorAvailableWorkflowMemoryMounts,
  pipelineMemoryMounts,
  workflowMemoryMounts,
} from "./memory.js";
import {
  ensureScratchMounts,
  scratchMountsForScope,
} from "./scratch.js";
import {
  readSkillContents,
  resolveSkills,
  resolveSkillsWithWarnings,
  type WorkflowSkillWarning,
} from "./skills.js";
import {
  ArtifactHashMismatchError,
  ArtifactManifestCorruptError,
  ArtifactNotFoundError,
  type ArtifactRef,
  type EventEnvelope,
  type EventInput,
  type MaterializedRunState,
  type RunId,
} from "./world.js";
import {
  createOrchestratorTools,
  workflowSnapshotsForOrchestrator,
} from "./orchestrator.js";
import { inheritPermissions, type ToolPermissions } from "./permission.js";
import { removeDirRetrySafe } from "./fs-utils.js";
import {
  buildReuseBrief,
  selectPlannerReuseCandidates,
  validatePlannerReuseDecision,
  type PlannerReuseCandidate,
} from "./planner-reuse.js";
import {
  getPlanningDefinitionSnapshot,
} from "./workflow-definition-hash.js";
import {
  assertWorkflowVersionInputCompatible,
  concreteInputStructure,
  resolveWorkflowVersionReuseStrategy,
  type AdaptiveArrayPath,
  type WorkflowVersionReusePolicy,
} from "./workflow-version-reuse.js";
import {
  readStoredWorkflowVersion,
  registerStoredWorkflowVersion,
} from "./workflow-version-store.js";

type JsonRecord = Record<string, unknown>;
type AjvError = {
  readonly instancePath?: string;
  readonly schemaPath?: string;
  readonly message?: string;
};
type AjvInstance = {
  validate(schema: unknown, data: unknown): boolean | Promise<unknown>;
  readonly errors?: readonly AjvError[] | null;
  errorsText?(errors?: readonly AjvError[] | null): string;
};
type AjvConstructor = new (options?: Record<string, unknown>) => AjvInstance;

export type RuntimeUsage = {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly costUsd?: number;
};

export type RuntimeStepExecutionResult = {
  readonly output: unknown;
  readonly usage?: RuntimeUsage;
  readonly artifactRefs?: readonly ArtifactRef[];
  readonly metadata?: JsonRecord;
};

export type RuntimeStepContext = {
  readonly world: LocalWorld;
  readonly runId: RunId;
  readonly workflowVersionId: string;
  readonly step: LwirStep;
  readonly stepPath: string;
  readonly attempt: number;
  readonly input: unknown;
  readonly resumingAttempt?: boolean;
  readonly hasItem?: boolean;
  readonly item?: unknown;
  readonly branchPath?: string;
  readonly allowedTopLevelStepIds?: readonly string[];
  readonly signal?: AbortSignal;
};

export type RuntimeToolHandler = (
  input: unknown,
  context: RuntimeStepContext,
) => Promise<unknown> | unknown;

export type ExecuteWorkflowVersionOptions = {
  readonly world: LocalWorld;
  readonly workflowVersion: WorkflowVersion | { readonly id: string; readonly lwir: LwirWorkflow };
  readonly input: unknown;
  readonly runId?: RunId;
  readonly signal?: AbortSignal;
  readonly models?: Record<string, unknown>;
  readonly tools?: ToolRegistry;
  readonly workerHarness?: Harness;
  readonly workerTools?: HarnessToolSet;
  readonly workflowId?: string;
  readonly workflowMemory?: MemoryConfig;
  readonly bashCapabilities?: BashCapabilities;
  readonly workerSkills?: HarnessContext["skills"];
  readonly workerSkillWarnings?: readonly WorkflowSkillWarning[];
  readonly parentRunId?: RunId;
  readonly pipelineWorkflowDefinitionHashes?: readonly string[];
  readonly maxAttempts?: number;
  /** Outer-loop session ID. When set, included in RunStarted.payload.outerLoopId (Spec §3.5). */
  readonly outerLoopId?: string;
  /**
   * Runtime tool-call policy for this run's worker model. For a sub-run this is
   * the inherited policy (parent denies). Absent means unrestricted.
   */
  readonly permissions?: ToolPermissions;
};

type RuntimeHarnessContext = HarnessContext & {
  readonly bash: ReturnType<typeof createBashTool>;
  readonly recorder: ReturnType<typeof createHarnessEventRecorder>;
};

type ResolvedRoleSkills = {
  readonly skills: HarnessContext["skills"];
  readonly warnings: readonly WorkflowSkillWarning[];
};

type ExecuteWorkflowVersionInternalOptions = ExecuteWorkflowVersionOptions & {
  readonly workflowVersionReuse?: WorkflowVersionReusePolicy;
};

export type RuntimeRunResult = RuntimeCompletedRunResult | RuntimeFailedRunResult;

export type RuntimeCompletedRunResult = RuntimeRunResultBase & {
  readonly status: "completed";
  readonly output: unknown;
  readonly outputRef: ArtifactRef;
};

export type RuntimeFailedRunResult = RuntimeRunResultBase & {
  readonly status: "failed";
  readonly output?: unknown;
  readonly outputRef?: ArtifactRef;
  readonly error?: unknown;
};

type RuntimeRunResultBase = {
  readonly runId: RunId;
  readonly workflowVersionId: string;
  readonly usage: MaterializedRunState["usage"];
  readonly events: readonly EventEnvelope[];
  readonly artifacts: readonly ArtifactRef[];
  readonly state: MaterializedRunState;
};

type RuntimeState = {
  events: readonly EventEnvelope[];
  materialized: MaterializedRunState;
};

type RunnableWorkflowDefinition = WorkflowRunTarget & CompilableWorkflowDefinition;

type StepAdapterResult = {
  readonly result: RuntimeStepExecutionResult;
  readonly runtimeState: RuntimeState;
};

type StepExecutionScope = {
  readonly stepPath?: string;
  readonly visitIndex?: number;
  readonly hasItem?: boolean;
  readonly item?: unknown;
  readonly branchPath?: string;
  readonly allowedTopLevelStepIds?: readonly string[];
};

type StepWithRetry = LwirStep & {
  readonly retry?: {
    readonly maxAttempts?: unknown;
  };
};

type StepWithFixer = LwirStep & {
  readonly onFailure?: {
    readonly fixer?: {
      readonly model?: unknown;
      readonly maxAttempts?: unknown;
      readonly system?: unknown;
    };
  };
};

type FixerConfig = {
  readonly modelSlot: string;
  readonly maxAttempts: number;
  readonly system: string;
};

type ParallelConfig = {
  readonly items: string;
  readonly itemKey: string;
  readonly cardinality: {
    readonly kind: "matches_items";
  };
  readonly maxBranches: number;
  readonly maxConcurrency: number;
  readonly failureMode: "fail_fast" | "all_settled";
  readonly fanIn: {
    readonly order: "input" | "itemKey";
    readonly output: "array";
    readonly outputStep?: string;
  };
};

type ParallelBranch = {
  readonly index: number;
  readonly item: unknown;
  readonly itemKey: string;
  readonly branchPath: string;
};

type ScheduledParallelBranch = {
  readonly branchPath: string;
  readonly itemKey?: string;
  readonly branchIndex?: number;
};

type ParallelBranchResult =
  | {
      readonly index: number;
      readonly itemKey: string;
      readonly status: "fulfilled";
      readonly output: unknown;
      readonly outputRef: ArtifactRef;
      readonly artifactRefs: readonly ArtifactRef[];
    }
  | {
      readonly index: number;
      readonly itemKey: string;
      readonly status: "rejected";
      readonly error: JsonRecord;
      readonly artifactRefs: readonly ArtifactRef[];
      readonly cause: unknown;
    };

function terminalRuntimeCauseForBranchResult(
  result: ParallelBranchResult,
): unknown | undefined {
  return result.status === "rejected" && isTerminalRuntimeCause(result.cause)
    ? result.cause
    : undefined;
}

class RuntimeIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeIntegrityError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

type TerminalCancellationCauseCode = "cancelled" | "timeout";

class RuntimeCancellationError extends Error {
  readonly causeCode: TerminalCancellationCauseCode;

  constructor(causeCode: TerminalCancellationCauseCode, message: string, cause?: unknown) {
    super(message);
    this.name = causeCode === "timeout" ? "TimeoutError" : "AbortError";
    this.causeCode = causeCode;
    if (cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = cause;
    }
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

class GlobalStepSemaphore {
  private permits: number;
  private readonly waiting: Array<() => void> = [];

  constructor(max: number) {
    if (!Number.isInteger(max) || max < 1) {
      throw new TypeError(`maxConcurrentSteps must be a positive integer; got ${max}`);
    }
    this.permits = max;
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits -= 1;
      return;
    }
    return new Promise<void>((resolve) => {
      this.waiting.push(resolve);
    });
  }

  release(): void {
    const next = this.waiting.shift();
    if (next !== undefined) {
      next();
    } else {
      this.permits += 1;
    }
  }
}

const worldSemaphores = new WeakMap<object, GlobalStepSemaphore>();

function semaphoreForWorld(world: LocalWorld): GlobalStepSemaphore | undefined {
  if (world.maxConcurrentSteps === undefined) {
    return undefined;
  }
  const existing = worldSemaphores.get(world);
  if (existing !== undefined) {
    return existing;
  }
  const semaphore = new GlobalStepSemaphore(world.maxConcurrentSteps);
  worldSemaphores.set(world, semaphore);
  return semaphore;
}

function assertNotCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) {
    return;
  }
  throw cancellationErrorFor(signal);
}

function cancellationErrorFor(signal: AbortSignal): Error {
  if (signal.reason instanceof RuntimeCancellationError) {
    return signal.reason;
  }
  const causeCode = signal.reason instanceof Error && signal.reason.name === "TimeoutError"
    ? "timeout"
    : "cancelled";
  return new RuntimeCancellationError(
    causeCode,
    cancellationMessageFor(signal.reason),
    signal.reason,
  );
}

function cancellationMessageFor(reason: unknown): string {
  if (reason instanceof Error && reason.message.length > 0) {
    return reason.message;
  }
  if (typeof reason === "string" && reason.length > 0) {
    return reason;
  }
  return "Run was cancelled.";
}

function combineAbortSignals(
  left: AbortSignal | undefined,
  right: AbortSignal | undefined,
): AbortSignal | undefined {
  if (left === undefined) {
    return right;
  }
  if (right === undefined || right === left) {
    return left;
  }
  const controller = new AbortController();
  const abortFrom = (signal: AbortSignal) => {
    if (!controller.signal.aborted) {
      controller.abort(signal.reason);
    }
  };
  if (left.aborted) {
    abortFrom(left);
    return controller.signal;
  }
  if (right.aborted) {
    abortFrom(right);
    return controller.signal;
  }
  left.addEventListener("abort", () => abortFrom(left), { once: true });
  right.addEventListener("abort", () => abortFrom(right), { once: true });
  return controller.signal;
}

function isTerminalCancellationError(error: unknown): error is RuntimeCancellationError {
  return error instanceof RuntimeCancellationError;
}

function isTerminalRuntimeCause(error: unknown): boolean {
  return isTerminalCancellationError(error) || error instanceof RuntimeCauseError;
}

function shouldAttemptFixerForError(error: unknown): boolean {
  if (isTerminalCancellationError(error)) {
    return false;
  }
  if (error instanceof RuntimeCapabilityDriftError) {
    return false;
  }
  if (error instanceof RuntimeConfigError) {
    return false;
  }
  return true;
}

function isTerminalCancellationEnvelope(error: unknown): error is JsonRecord {
  return isRecord(error) && isTerminalCancellationCauseCode(error.causeCode);
}

function isTerminalRuntimeCauseEnvelope(error: unknown): error is JsonRecord {
  return isRecord(error) &&
    error.retriable === false &&
    (
      isTerminalCancellationCauseCode(error.causeCode) ||
      error.causeCode === "capability_drift" ||
      error.causeCode === "runtime_config_error" ||
      error.causeCode === "step_schema_error" ||
      error.causeCode === "max_visits_exceeded"
    );
}

function isTerminalCancellationCauseCode(
  value: unknown,
): value is TerminalCancellationCauseCode {
  return value === "cancelled" || value === "timeout";
}

function raceSignal<T>(
  operation: () => Promise<T> | T,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (signal === undefined) {
    return Promise.resolve(operation());
  }
  assertNotCancelled(signal);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let onAbort: (() => void) | undefined;
    const cleanup = () => {
      if (onAbort !== undefined) {
        signal.removeEventListener("abort", onAbort);
      }
    };
    onAbort = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(cancellationErrorFor(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    let promise: Promise<T>;
    try {
      promise = Promise.resolve(operation());
    } catch (error) {
      settled = true;
      cleanup();
      reject(error);
      return;
    }
    promise.then(
      (value) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
}

const DEFAULT_MAX_ATTEMPTS = 1;
const ALPHA_MAX_BRANCHES = 100;
const LOCK_OWNER_GRACE_MS = 30_000;
const INLINE_OUTPUT_THRESHOLD_BYTES = 256_000;
const nodeRequire = createRequire(import.meta.url);
const activeRunExecutions = new Set<string>();

let cachedAjv: AjvInstance | undefined;

function inlineOutputForEvent(value: unknown): unknown {
  if (value === undefined) return undefined;
  const serialized = canonicalJson(value);
  return serialized.length > INLINE_OUTPUT_THRESHOLD_BYTES ? undefined : value;
}

type LockedRuntimeWorkflowVersion = WorkflowVersion & {
  readonly lwirVersionId: string;
  readonly lwirHash: string;
  readonly lock: WorkflowVersionLockEnvelope;
};

export async function executeWorkflowVersion(
  options: ExecuteWorkflowVersionOptions,
): Promise<RuntimeRunResult> {
  return executeWorkflowVersionWithReusePolicy(options);
}

async function executeWorkflowVersionWithReusePolicy(
  options: ExecuteWorkflowVersionInternalOptions,
): Promise<RuntimeRunResult> {
  const runId = options.runId ?? `run_${randomUUID()}`;
  const executionOptions: ExecuteWorkflowVersionInternalOptions = options.workerHarness === undefined
    ? { ...options, workerHarness: workflowHarness }
    : options;
  return withRunExecutionFence(options.world, runId, () =>
    executeWorkflowVersionUnlocked(executionOptions, runId)
  );
}

type RunWorkflowLegacyPlannerOptions<TWorkflow extends WorkflowRunTarget = WorkflowRunTarget> =
  RunWorkflowOptions<TWorkflow> & {
    readonly planner?: PlannerAdapter;
  };

/**
 * Resolves the human-readable label for a run.
 * Priority: per-run override → workflow definition label → workflow id.
 */
export function resolveRunLabel(input: { runLabel?: string; defLabel?: string; id: string }): string {
  return input.runLabel ?? input.defLabel ?? input.id;
}

export async function runWorkflow<TWorkflow extends WorkflowRunTarget = WorkflowRunTarget>(
  options: RunWorkflowOptions<TWorkflow>,
): Promise<RunResult<InferWorkflowOutput<TWorkflow>>> {
  return runWorkflowInternal(options as RunWorkflowLegacyPlannerOptions<TWorkflow>, false);
}

export async function runWorkflowWithLegacyPlannerAdapter<
  TWorkflow extends WorkflowRunTarget = WorkflowRunTarget,
>(
  options: RunWorkflowLegacyPlannerOptions<TWorkflow>,
): Promise<RunResult<InferWorkflowOutput<TWorkflow>>> {
  return runWorkflowInternal(options, true);
}

async function runWorkflowInternal<TWorkflow extends WorkflowRunTarget = WorkflowRunTarget>(
  options: RunWorkflowLegacyPlannerOptions<TWorkflow>,
  allowLegacyPlannerAdapter: boolean,
): Promise<RunResult<InferWorkflowOutput<TWorkflow>>> {
  if (!allowLegacyPlannerAdapter) {
    assertNoLegacyPlannerOption(options);
    assertWorkflowModelsOption(options.workflows);
  }
  if (options.maxOuterCycles !== undefined) {
    const v = options.maxOuterCycles;
    if (!Number.isInteger(v) || v < 1) {
      throw new Error(
        `runWorkflow: maxOuterCycles must be a positive integer >= 1 (got ${String(v)}).`,
      );
    }
  }
  const workflows = options.workflows;
  if (Array.isArray(workflows)) {
    if ((options.maxOuterCycles ?? 1) > 1) {
      throw new RunFailedError({
        runId: options.runId ?? "uncompiled",
        workflowVersionId: "uncompiled",
        causeCode: "runtime_config_error",
        message:
          "runtime_config_error: outer_loop_not_supported_for_workflow_arrays — " +
          "runWorkflow orchestration mode does not support maxOuterCycles.",
      });
    }
    const runId = options.runId ?? `run_${randomUUID()}`;
    return withRunExecutionFence(options.world, runId, async () =>
      runOrchestratedWorkflowUnfenced(
        workflows as readonly RunnableWorkflowDefinition[],
        options,
        runId,
      )
    ) as Promise<RunResult<InferWorkflowOutput<TWorkflow>>>;
  }

  const workflow = workflows;
  assertSingleWorkflow(workflow);

  if ((options.maxOuterCycles ?? 1) > 1) {
    let outerLoopPlanner = allowLegacyPlannerAdapter
      ? legacyPlannerAdapterFromRunWorkflowOptions(options) ??
        plannerAdapterFromWorkflowSupervise(workflow)
      : plannerAdapterFromWorkflowSupervise(workflow);
    if (outerLoopPlanner === undefined && options.outerLoopId !== undefined) {
      outerLoopPlanner = replayOnlyOuterLoopPlannerAdapter();
    }
    if (outerLoopPlanner === undefined) {
      throw new RunFailedError({
        runId: options.runId ?? "uncompiled",
        workflowVersionId: "uncompiled",
        causeCode: "runtime_config_error",
        message:
          "runtime_config_error: outer_loop_requested_without_supervise_adapter — " +
          "maxOuterCycles > 1 requires workflow.planner.supervise.",
      });
    }
    const { runOuterLoop } = await import("./outer-loop.js");
    return runOuterLoop({
      world: options.world,
      workflow: workflow as CompilableWorkflowDefinition,
      input: options.input,
      planner: outerLoopPlanner,
      tools: options.tools,
      maxAttempts: options.maxAttempts,
      maxOuterCycles: options.maxOuterCycles!,
      outerLoopId: options.outerLoopId,
      signal: options.signal,
      timeout: options.timeout,
      bash: options.bash,
      label: options.label,
      tags: options.tags,
      workflowVersionReuseStrategy: options.workflowVersionReuseStrategy,
    }) as Promise<RunResult<InferWorkflowOutput<TWorkflow>>>;
  }

  const runId = options.runId ?? `run_${randomUUID()}`;
  return withRunExecutionFence(options.world, runId, async () => {
    return runWorkflowCycleUnfenced(workflow, options, runId, undefined, undefined);
  }) as Promise<RunResult<InferWorkflowOutput<TWorkflow>>>;
}

function assertWorkflowModelsOption(workflows: unknown): void {
  const workflowList = Array.isArray(workflows) ? workflows : [workflows];
  for (const workflow of workflowList) {
    const models = isRecord(workflow) ? workflow.models : undefined;
    if (Array.isArray(models) && models.length > 0) {
      continue;
    }
    const workflowId = isRecord(workflow) && typeof workflow.id === "string"
      ? workflow.id
      : "unknown";
    throw new Error(
      `runWorkflow requires workflow.models to include at least one model slot (workflow '${workflowId}').`,
    );
  }
}

function legacyPlannerAdapterFromRunWorkflowOptions(
  options: unknown,
): PlannerAdapter | undefined {
  if (!isRecord(options)) {
    return undefined;
  }
  const planner = options.planner;
  if (!isRecord(planner)) {
    return undefined;
  }
  const hasDraft = typeof planner.draft === "function";
  const hasSupervise = typeof planner.supervise === "function";
  if (!hasDraft && !hasSupervise) {
    return undefined;
  }
  return planner as PlannerAdapter;
}

function plannerAdapterFromWorkflowSupervise(
  workflow: unknown,
): PlannerAdapter | undefined {
  if (!isRecord(workflow)) {
    return undefined;
  }
  const planner = workflow.planner;
  if (!isRecord(planner)) {
    return undefined;
  }
  const supervise = planner.supervise;
  if (typeof supervise !== "function") {
    return undefined;
  }
  return {
    draft: async () => {
      throw new Error(
        "outer-loop supervise adapter draft() should not be called when workflow.planner is configured.",
      );
    },
    supervise: supervise as PlannerAdapter["supervise"],
  };
}

function replayOnlyOuterLoopPlannerAdapter(): PlannerAdapter {
  return {
    async draft(): Promise<never> {
      throw new Error(
        "outer-loop replay requires a persisted done manifest when workflow.planner.supervise is unavailable.",
      );
    },
  };
}

function assertNoLegacyPlannerOption(options: unknown): void {
  if (!isRecord(options) || !Object.hasOwn(options, "planner")) {
    return;
  }
  throw new Error("runWorkflow no longer accepts top-level planner; use workflow.planner.harness.");
}

export type RunWorkflowCycleOptions = {
  readonly world: LocalWorld;
  readonly workflow: CompilableWorkflowDefinition;
  readonly input: unknown;
  readonly planner?: PlannerAdapter;
  readonly tools?: ToolRegistry;
  readonly maxAttempts?: number;
  readonly runId: RunId;
  readonly signal?: AbortSignal;
  readonly timeout?: string | number;
  /** Outer-loop context injected into the OrchestrationRequest. */
  readonly outerLoop?: import("./compiler.js").WorkflowCompileOptions["outerLoop"];
  /** Folded into the OrchestrationRequest.messages.system before the hash. */
  readonly promptNote?: string;
  /** Outer-loop session ID. When set, included in RunStarted.payload.outerLoopId (Spec §3.5). */
  readonly outerLoopId?: string;
  /** Parent run id for sub-runs spawned by an orchestrator run. */
  readonly parentRunId?: RunId;
  /** Pipeline workflow definition hashes for shared pipeline memory mounts. */
  readonly pipelineWorkflowDefinitionHashes?: readonly string[];
  readonly workflowVersionReuseStrategy?: import("./workflow-version-reuse.js").WorkflowVersionReuseStrategy;
  readonly preResolvedWorkerSkills?: HarnessContext["skills"];
  readonly preResolvedWorkerSkillWarnings?: readonly WorkflowSkillWarning[];
  readonly bash?: BashCapabilities;
  /** Human-readable label stamped into RunStarted.payload.label. */
  readonly label?: string;
  /** Free-form tags stamped into RunStarted.payload.tags. */
  readonly tags?: readonly string[];
};

async function runOrchestratedWorkflowUnfenced(
  workflows: readonly RunnableWorkflowDefinition[],
  options: {
    readonly world: LocalWorld;
    readonly input: unknown;
    readonly tools?: ToolRegistry;
    readonly maxAttempts?: number;
    readonly signal?: AbortSignal;
    readonly orchestrator?: unknown;
    readonly maxConcurrentSubRuns?: number;
    readonly bash?: BashCapabilities;
    readonly label?: string;
    readonly tags?: readonly string[];
    readonly permissions?: ToolPermissions;
  },
  runId: RunId,
): Promise<RunResult<unknown>> {
  const orchestrator = options.orchestrator;
  if (!isRecord(orchestrator)) {
    throw new Error("runWorkflow requires orchestrator config when workflows is an array.");
  }
  const harness = propertyValue(orchestrator, "harness");
  if (harness !== undefined && typeof (harness as Harness).run !== "function") {
    throw new Error("runWorkflow orchestrator.harness must implement run(task, ctx).");
  }
  const orchestratorHarness = harness === undefined ? workflowHarness : harness as Harness;
  const orchestratorModelBinding = propertyValue(orchestrator, "model");
  if (orchestratorModelBinding === undefined) {
    throw new Error("runWorkflow orchestrator.model is required for workflow arrays.");
  }
  const orchestratorSystem = stringProperty(orchestrator, "system");
  const orchestratorBashCapabilities = bashCapabilitiesFromUnknown(
    propertyValue(orchestrator, "bash"),
  ) ?? options.bash;
  const maxConcurrentSubRuns = numberProperty(orchestrator, "maxConcurrentSubRuns") ??
    options.maxConcurrentSubRuns ??
    10;
  if (!Number.isInteger(maxConcurrentSubRuns) || maxConcurrentSubRuns < 1) {
    throw new Error("runWorkflow maxConcurrentSubRuns must be an integer >= 1.");
  }

  const resolvedWorkflowEntries = await Promise.all(
    workflows.map(async (workflow) => {
      const plannerResolvedSkills = await resolveRoleSkillsWithWarnings(
        isRecord(workflow.planner) ? workflow.planner.skills : undefined,
        options.world,
        roleSkillResolveDefaults(workflow.planner, options.signal),
      );
      const workerResolvedSkills = await resolveRoleSkillsWithWarnings(
        isRecord(workflow.worker) ? workflow.worker.skills : undefined,
        options.world,
        roleSkillResolveDefaults(workflow.worker, options.signal),
      );
      return {
        workflow: workflowWithResolvedSkillIdentities(workflow, plannerResolvedSkills.skills, workerResolvedSkills.skills),
        plannerSkills: plannerResolvedSkills.skills,
        plannerSkillWarnings: plannerResolvedSkills.warnings,
        workerSkills: workerResolvedSkills.skills,
        workerSkillWarnings: workerResolvedSkills.warnings,
      };
    }),
  );
  const workflowsWithResolvedSkills = resolvedWorkflowEntries.map((entry) => entry.workflow);
  const plannerSkillsByWorkflowId = new Map(
    resolvedWorkflowEntries.map((entry) => [entry.workflow.id, entry.plannerSkills]),
  );
  const workerSkillsByWorkflowId = new Map(
    resolvedWorkflowEntries.map((entry) => [entry.workflow.id, entry.workerSkills]),
  );
  const plannerSkillWarningsByWorkflowId = new Map(
    resolvedWorkflowEntries.map((entry) => [entry.workflow.id, entry.plannerSkillWarnings]),
  );
  const workerSkillWarningsByWorkflowId = new Map(
    resolvedWorkflowEntries.map((entry) => [entry.workflow.id, entry.workerSkillWarnings]),
  );
  const available = workflowSnapshotsForOrchestrator(workflowsWithResolvedSkills, options.tools);
  const pipelineWorkflowDefinitionHashes = available.map((entry) => entry.workflowDefinitionHash);
  const model = isModelSlot(orchestratorModelBinding)
    ? orchestratorModelBinding.aiSdkModel
    : orchestratorModelBinding;
  const orchestratorModelSlotId = isModelSlot(orchestratorModelBinding)
    ? stringProperty(orchestratorModelBinding.metadata, "id") ??
      stringProperty(model, "modelId") ??
      "orchestrator"
    : stringProperty(model, "modelId") ?? "orchestrator";

  const logDir = resolvePath(options.world.dataDir, "runs", runId);
  const orchestratorScope: HarnessContext["scope"] = {
    runId,
    logDir,
    role: "orchestrator",
  };
  const orchestratorMemoryMounts = [
    ...pipelineMemoryMounts({
      world: options.world,
      workflowDefinitionHashes: pipelineWorkflowDefinitionHashes,
      mode: "rw",
    }),
    ...orchestratorAvailableWorkflowMemoryMounts({
      world: options.world,
      workflows: available,
    }),
  ];
  const orchestratorScratchMounts = scratchMountsForScope(orchestratorScope);
  await ensureScratchMounts(orchestratorScratchMounts);
  await ensureMemoryMounts(orchestratorMemoryMounts);
  const orchestratorResolvedSkills = await resolveRoleSkillsWithWarnings(
    propertyValue(orchestrator, "skills"),
    options.world,
    roleSkillResolveDefaults(orchestrator, options.signal),
  );
  const orchestratorSkills = orchestratorResolvedSkills.skills;
  const orchestratorSkillWarnings = orchestratorResolvedSkills.warnings;
  let plannerPlanCallCount = 0;

  const orchestratorToolSet = createOrchestratorTools({
    world: options.world,
    workflows: workflowsWithResolvedSkills,
    tools: options.tools,
    maxConcurrentSubRuns,
    resultStore: {
      backingDir: join(logDir, "scratch", "workflow-results"),
      mountDir: "/mnt/scratch/own/workflow-results",
    },
    planWorkflow: async ({ workflow, input, tools, signal }) => {
      const combinedSignal = combineAbortSignals(options.signal, signal);
      const workflowBashCapabilities = bashCapabilitiesForWorkflow(workflow, options.bash);
      plannerPlanCallCount += 1;
      const plannerRunId = `run_planner_${sha256Digest({
        orchestratorRunId: runId,
        workflowId: workflow.id,
        planCall: plannerPlanCallCount,
      }).slice(7, 23)}`;
      const plannerLogDir = runLogDir(options.world, plannerRunId, runId);
      const plannerSkills = plannerSkillsByWorkflowId.get(workflow.id);
      if (plannerSkills === undefined) {
        throw new RuntimeConfigError(
          `runtime_config_error: resolved planner skills missing for workflow '${workflow.id}'.`,
        );
      }
      const plannerSkillWarnings = plannerSkillWarningsByWorkflowId.get(workflow.id) ?? [];
      const plannerMemoryMounts = [
        ...workflowMemoryMounts({
          world: options.world,
          workflowId: workflow.id,
          memory: workflow.memory,
        }),
        ...pipelineMemoryMounts({
          world: options.world,
          workflowDefinitionHashes: pipelineWorkflowDefinitionHashes,
          mode: "ro",
          includeOrg: false,
        }),
      ];
      const plannerScope: HarnessContext["scope"] = {
        runId: plannerRunId,
        parentRunId: runId,
        logDir: plannerLogDir,
        role: "planner",
      };
      const plannerScratchMounts = scratchMountsForScope(plannerScope);
      await ensureScratchMounts(plannerScratchMounts);
      await ensureMemoryMounts(plannerMemoryMounts);
        const compiled = await compileWorkflow(workflow, {
          input,
          tools,
          bash: workflowBashCapabilities,
	        plannerHarnessRuntime: {
	          world: options.world,
	          runId: plannerRunId,
	          parentRunId: runId,
	          logDir: plannerLogDir,
	          memoryMounts: plannerMemoryMounts,
	          scratchMounts: plannerScratchMounts,
	          skills: plannerSkills,
	          skillWarnings: plannerSkillWarnings,
	          bashCapabilities: workflowBashCapabilities,
	          abortSignal: combinedSignal,
	        },
		      });
        await registerStoredWorkflowVersion(options.world, compiled.workflowVersion);
        return compiled;
		    },
    readWorkflowVersion: async (workflowVersionId) => {
      try {
        return await readStoredWorkflowVersion(options.world, workflowVersionId);
      } catch (error) {
        if (isErrno(error, "ENOENT")) {
          return undefined;
        }
        throw error;
      }
    },
    executeWorkflowVersion: async (runOptions) => {
      const combinedSignal = combineAbortSignals(options.signal, runOptions.signal);
      const workerSkills = workerSkillsByWorkflowId.get(runOptions.workflow.id);
      if (workerSkills === undefined) {
        throw new RuntimeConfigError(
          `runtime_config_error: resolved worker skills missing for workflow '${runOptions.workflow.id}'.`,
        );
      }
      const workerSkillWarnings = workerSkillWarningsByWorkflowId.get(runOptions.workflow.id) ?? [];
      try {
        const workflowBashCapabilities = bashCapabilitiesForWorkflow(
          runOptions.workflow,
          options.bash,
        );
        validateRunInputAgainstWorkflowSchema(runOptions.workflow, runOptions.input);
        const runtimeModels = runtimeModelsForWorkflow(runOptions.workflow);
        const workerConfig = runtimeWorkerConfigForWorkflow(runOptions.workflow);
        // Sub-run inheritance: the worker gets the parent's denies, so a
        // delegated run can never re-enable a tool the parent forbade.
        const inheritedPermissions: ToolPermissions | undefined =
          options.permissions === undefined
            ? undefined
            : {
                ruleset: inheritPermissions(options.permissions.ruleset, []),
                ...(options.permissions.onAsk === undefined
                  ? {}
                  : { onAsk: options.permissions.onAsk }),
              };
        const runtimeResult = await executeWorkflowVersionWithReusePolicy({
          world: runOptions.world,
          workflowVersion: runOptions.workflowVersion as ExecuteWorkflowVersionOptions["workflowVersion"],
          input: runOptions.input,
          runId: runOptions.runId,
          models: runtimeModels,
          tools: runOptions.tools,
          maxAttempts: options.maxAttempts,
	          signal: combinedSignal,
          workflowVersionReuse: runOptions.workflowVersionReuse,
          ...(workerConfig.workerHarness === undefined ? {} : { workerHarness: workerConfig.workerHarness }),
          workflowId: runOptions.workflow.id,
          workflowMemory: runOptions.workflow.memory,
          parentRunId: runId,
          pipelineWorkflowDefinitionHashes,
          workerSkills,
          workerSkillWarnings,
          bashCapabilities: workflowBashCapabilities,
          ...(inheritedPermissions === undefined ? {} : { permissions: inheritedPermissions }),
        });
        if (runtimeResult.status === "failed") {
          return {
            runId: runtimeResult.runId,
            status: "failed" as const,
            ...(runtimeResult.output === undefined ? {} : { output: runtimeResult.output }),
            ...(runtimeResult.outputRef === undefined ? {} : { outputRef: runtimeResult.outputRef }),
            artifacts: runtimeResult.artifacts,
            error: {
              message: errorMessageFromRuntimeResult(runtimeResult),
            },
          };
        }
        return {
          runId: runtimeResult.runId,
          status: "completed" as const,
          ...(runtimeResult.output === undefined ? {} : { output: runtimeResult.output }),
          outputRef: runtimeResult.outputRef,
          artifacts: runtimeResult.artifacts,
        };
      } catch (error) {
        if (error instanceof RunFailedError) {
          return {
            runId: error.runId,
            status: "failed" as const,
            ...(error.result?.output === undefined ? {} : { output: error.result.output }),
            ...(error.result?.artifacts === undefined ? {} : { artifacts: error.result.artifacts }),
            // Surface the failure reason so an orchestrator agent can adapt its
            // next call instead of blindly retrying the same failing input.
            error: { message: error.message },
          };
        }
        throw error;
      }
    },
  });

  const recorder = createHarnessEventRecorder({ world: options.world, runId });
  const orchestratorTools = {
    ...(options.tools?.toRecord() ?? {}),
    ...(isRecord(propertyValue(orchestrator, "tools"))
      ? propertyValue(orchestrator, "tools") as Record<string, unknown>
      : {}),
    ...orchestratorToolSet,
  };
  const harnessContext = {
    scope: orchestratorScope,
    session: {
      runId,
      role: "orchestrator" as const,
      task: { kind: "orchestrate" as const },
      manifest: {},
      manifestHash: sha256Digest({}),
      ...(orchestratorSkillWarnings.length === 0 ? {} : { warnings: orchestratorSkillWarnings }),
    },
    model: {
      slotId: orchestratorModelSlotId,
      providerId: stringProperty(model, "providerId") ?? stringProperty(model, "provider") ?? "runtime",
      modelId: stringProperty(model, "modelId") ?? orchestratorModelSlotId,
      model,
    },
    ...(orchestratorSystem === undefined ? {} : { system: orchestratorSystem }),
    tools: orchestratorTools,
    bash: createBashTool(
      withBashCapabilities(
        bashScopeForHarness(
          logDir,
          orchestratorMemoryMounts,
          orchestratorScratchMounts,
          orchestratorSkills,
        ),
        orchestratorBashCapabilities,
      ),
    ),
    memoryMounts: orchestratorMemoryMounts,
    scratchMounts: orchestratorScratchMounts,
    skills: orchestratorSkills,
    mounts: harnessRuntimeMounts(
      orchestratorMemoryMounts,
      orchestratorScratchMounts,
      orchestratorSkills,
    ),
    ...(orchestratorBashCapabilities === undefined ? {} : { bashCapabilities: orchestratorBashCapabilities }),
    durability: {
      append: async (event) => {
        const eventWithWarnings = eventWithSessionWarnings(event, orchestratorSkillWarnings);
        await recorder.append({
          type: eventWithWarnings.type,
          ...(eventWithWarnings.occurrenceId === undefined ? {} : { occurrenceId: eventWithWarnings.occurrenceId }),
          payload: eventWithWarnings.payload,
        });
      },
      priorEvents: async (query) => {
        const events = await recorder.priorEvents(query?.runId ?? runId);
        const queryType = query?.type;
        return queryType === undefined
          ? events as never
          : events.filter((event) => isEventEnvelope(event) && normalizeHarnessEventType(event.type) ===
            normalizeHarnessEventType(queryType)) as never;
      },
    },
    recorder,
    abortSignal: options.signal ?? new AbortController().signal,
    // The policy gates the orchestrator's own tool calls (plan/run/start). Each
    // sub-run inherits the parent's denies below, at the executeWorkflowVersion
    // delegate. Planner (bash-only) and fixer (internal) are intentionally not
    // gated — the policy targets the autonomous, delegating actors.
    ...(options.permissions === undefined ? {} : { permissions: workflowToolPermissions(options.permissions) }),
  } as RuntimeHarnessContext;

  const manifest = orchestratorManifest({
    harnessId: harnessIdFor(orchestratorHarness),
    orchestratorModelSlotId,
    ...(orchestratorSystem === undefined ? {} : { systemPrompt: orchestratorSystem }),
    skills: orchestratorSkills.map(skillManifestIdentity),
    availableWorkflows: available.map((entry) => ({
      id: entry.id,
      definitionHash: entry.workflowDefinitionHash,
    })),
    toolRegistry: options.tools,
    memoryStoreIds: orchestratorMemoryMounts.map((mount) => mount.storeId),
    bashCapabilities: orchestratorBashCapabilities,
    maxConcurrentSubRuns,
  });

  await options.world.appendEvent(runId, {
    type: "RunStarted",
    payload: stripUndefined({
      workflowVersionId: "orchestrated",
      input: options.input,
      label: resolveRunLabel({ runLabel: options.label, id: "orchestrated" }),
      tags: options.tags ?? [],
    }),
  });
  const manifestHash = hashHarnessManifest(manifest);
  const skillContents = orchestratorSkills.length === 0
    ? undefined
    : await readSkillContents(orchestratorSkills);
  const runHarnessContext: RuntimeHarnessContext = {
    ...harnessContext,
    session: {
      runId,
      role: "orchestrator",
      task: { kind: "orchestrate" },
      manifest,
      manifestHash,
      ...(orchestratorSkillWarnings.length === 0 ? {} : { warnings: orchestratorSkillWarnings }),
      ...(skillContents === undefined ? {} : { skillContents }),
    },
  };

  const sessionWrappedOrchestratorHarness: Harness = {
    ...(orchestratorHarness.harnessId === undefined ? {} : { harnessId: orchestratorHarness.harnessId }),
    run: async (task, ctx) => {
      const taskResult = await orchestratorHarness.run(task, ctx);
      if (taskResult.kind === "delegate_to_default" && orchestratorHarness === workflowHarness) {
        throw new RuntimeConfigError(
          "runtime_config_error: orchestrator harness delegated to default without an orchestrator default runtime.",
        );
      }
      if (taskResult.kind !== "orchestrate" && taskResult.kind !== "delegate_to_default") {
        throw new RuntimeConfigError(
          `runtime_config_error: orchestrator harness returned '${taskResult.kind}' for orchestrate task.`,
        );
      }
      return taskResult;
    },
  };

  const taskResult = await raceSignal(
    () => runWorkflowHarnessWithSession(
      sessionWrappedOrchestratorHarness as never,
      {
        kind: "orchestrate",
        available,
        input: options.input,
      } as never,
      runHarnessContext as never,
    ) as Promise<HarnessResult>,
    options.signal,
  );

  const orchestratorResult = taskResult.kind === "delegate_to_default"
    ? await runDelegatedDefaultOrchestratorHarness()
    : taskResult;
  if (orchestratorResult.kind !== "orchestrate") {
    throw new RuntimeConfigError(
      `runtime_config_error: orchestrator harness returned '${orchestratorResult.kind}' for orchestrate task.`,
    );
  }

  const events = await options.world.listEvents(runId);
  const state = materializeRunStateFromEvents(runId, events);
  return {
    runId,
    workflowVersionId: "orchestrated",
    status: "completed",
    output: orchestratorResult.output,
    usage: state.usage,
    events,
    artifacts: [],
  };

  async function runDelegatedDefaultOrchestratorHarness(): Promise<HarnessResult> {
    const defaultManifest = { ...manifest, harnessId: harnessIdFor(workflowHarness) };
    const defaultRecorder = createHarnessEventRecorder({
      world: options.world,
      runId,
      skipManifestDriftCheck: true,
    });
    const defaultHarnessContext = {
      ...runHarnessContext,
      recorder: defaultRecorder,
      durability: {
        append: async (event: { readonly type: string; readonly occurrenceId?: string; readonly payload: Record<string, unknown> }) => {
          const eventWithWarnings = eventWithSessionWarnings(event, orchestratorSkillWarnings);
          await defaultRecorder.append({
            type: eventWithWarnings.type,
            ...(eventWithWarnings.occurrenceId === undefined ? {} : { occurrenceId: eventWithWarnings.occurrenceId }),
            payload: eventWithWarnings.payload,
          });
        },
        priorEvents: async (query?: { readonly runId?: string; readonly type?: string }) => {
          const events = await defaultRecorder.priorEvents(query?.runId ?? runId);
          const queryType = query?.type;
          return queryType === undefined
            ? events as never
            : events.filter((event) => isEventEnvelope(event) && normalizeHarnessEventType(event.type) ===
              normalizeHarnessEventType(queryType)) as never;
        },
      },
      session: {
        runId,
        role: "orchestrator" as const,
        task: { kind: "orchestrate" as const },
        manifest: defaultManifest,
        manifestHash: hashHarnessManifest(defaultManifest),
        ...(orchestratorSkillWarnings.length === 0 ? {} : { warnings: orchestratorSkillWarnings }),
        ...(skillContents === undefined ? {} : { skillContents }),
      },
    };
    const result = await runWorkflowHarnessWithSession(
      workflowHarness as never,
      {
        kind: "orchestrate",
        available,
        input: options.input,
      } as never,
      defaultHarnessContext as never,
    );
    if (result.kind === "delegate_to_default") {
      throw new RuntimeConfigError(
        "runtime_config_error: workflowHarness delegated orchestrator task to default runtime.",
      );
    }
    return result;
  }
}

function runtimeModelsForWorkflow(
  workflow: CompilableWorkflowDefinition,
): Record<string, unknown> {
  const resolved = resolveModelSlots(workflow.models ?? []);
  const models: Record<string, unknown> = {};
  for (const slot of resolved) {
    models[slot.slotId] = createModelSlot(slot.aiSdkModel, slot.metadata);
  }
  return models;
}

function runtimeWorkerConfigForWorkflow(
  workflow: CompilableWorkflowDefinition,
): { readonly workerHarness: Harness } {
  const workerConfig = workflow.worker;
  const workerHarness = isRecord(workerConfig) && isHarness(workerConfig.harness)
    ? workerConfig.harness
    : workflowHarness;

  return { workerHarness };
}

function isHarness(value: unknown): value is Harness {
  return isRecord(value) && typeof (value as Harness).run === "function";
}

function workflowWithResolvedSkillIdentities<TWorkflow extends CompilableWorkflowDefinition>(
  workflow: TWorkflow,
  plannerSkills: HarnessContext["skills"],
  workerSkills: HarnessContext["skills"],
): TWorkflow {
  const plannerSkillIdentities = workflowSkillIdentitiesFromResolved(plannerSkills);
  const workerSkillIdentities = workflowSkillIdentitiesFromResolved(workerSkills);

  return {
    ...workflow,
    ...(isRecord(workflow.planner)
      ? {
          planner: {
            ...workflow.planner,
            skills: plannerSkillIdentities,
          },
        }
      : {}),
    ...(isRecord(workflow.worker)
      ? {
          worker: {
            ...workflow.worker,
            skills: workerSkillIdentities,
          },
        }
      : {}),
  };
}

function workflowSkillIdentitiesFromResolved(
  skills: HarnessContext["skills"],
): readonly Skill[] {
  return skills
    .filter((entry) => stringProperty(entry, "origin") !== "org")
    .map((entry) => {
      const remote = remoteSkillIdentityFromValue(propertyValue(entry, "remote"));
      return {
        kind: "skill" as const,
        source: skillSourceForIdentity(entry),
        name: entry.name,
        frontmatterHash: skillFrontmatterHash(entry),
        ...(remote === undefined ? {} : { remote }),
      };
    });
}

function skillSourceForIdentity(
  skill: HarnessContext["skills"][number],
): string {
  const source = stringProperty(skill, "source") ?? stringProperty(skill, "bodyPath");
  if (source !== undefined && source.length > 0) {
    return source;
  }
  throw new RuntimeConfigError(
    `runtime_config_error: resolved skill '${skill.name}' is missing source path.`,
  );
}

async function resolveRoleSkills(
  value: unknown,
  world: LocalWorld,
  options: {
    readonly signal?: AbortSignal;
    readonly skillMaxRisk?: unknown;
    readonly skillOidcToken?: unknown;
  } = {},
): Promise<HarnessContext["skills"]> {
  return resolveSkills((Array.isArray(value) ? value : []) as never, {
    baseDir: process.cwd(),
    orgSkillDir: resolvePath(world.dataDir, "memory", "org", "skills"),
    skillsCacheDir: resolvePath(world.dataDir, "skills-cache"),
    signal: options.signal,
    ...(isSkillRiskLevel(options.skillMaxRisk) ? { skillMaxRisk: options.skillMaxRisk } : {}),
    ...(isSkillOidcToken(options.skillOidcToken) ? { skillOidcToken: options.skillOidcToken } : {}),
  });
}

async function resolveRoleSkillsWithWarnings(
  value: unknown,
  world: LocalWorld,
  options: {
    readonly signal?: AbortSignal;
    readonly skillMaxRisk?: unknown;
    readonly skillOidcToken?: unknown;
  } = {},
): Promise<ResolvedRoleSkills> {
  const result = await resolveSkillsWithWarnings((Array.isArray(value) ? value : []) as never, {
    baseDir: process.cwd(),
    orgSkillDir: resolvePath(world.dataDir, "memory", "org", "skills"),
    skillsCacheDir: resolvePath(world.dataDir, "skills-cache"),
    signal: options.signal,
    ...(isSkillRiskLevel(options.skillMaxRisk) ? { skillMaxRisk: options.skillMaxRisk } : {}),
    ...(isSkillOidcToken(options.skillOidcToken) ? { skillOidcToken: options.skillOidcToken } : {}),
  });
  return {
    skills: result.skills,
    warnings: result.warnings,
  };
}

function roleSkillResolveDefaults(
  roleConfig: unknown,
  signal?: AbortSignal,
): {
  readonly signal?: AbortSignal;
  readonly skillMaxRisk?: unknown;
  readonly skillOidcToken?: unknown;
} {
  return {
    signal,
    ...(isRecord(roleConfig) && propertyValue(roleConfig, "skillMaxRisk") !== undefined
      ? { skillMaxRisk: propertyValue(roleConfig, "skillMaxRisk") }
      : {}),
    ...(isRecord(roleConfig) && propertyValue(roleConfig, "skillOidcToken") !== undefined
      ? { skillOidcToken: propertyValue(roleConfig, "skillOidcToken") }
      : {}),
  };
}

function isSkillRiskLevel(value: unknown): value is "NONE" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" {
  return value === "NONE" || value === "LOW" || value === "MEDIUM" || value === "HIGH" || value === "CRITICAL";
}

function isSkillOidcToken(value: unknown): value is string | (() => string | undefined | Promise<string | undefined>) {
  return value === undefined || typeof value === "string" || typeof value === "function";
}

async function workerHarnessEnvironment(
  options: ExecuteWorkflowVersionOptions,
  scope: HarnessContext["scope"],
  includeSkills: boolean,
): Promise<{
  readonly memoryMounts: HarnessContext["memoryMounts"];
  readonly scratchMounts: HarnessContext["scratchMounts"];
  readonly skills: HarnessContext["skills"];
  readonly skillWarnings: readonly WorkflowSkillWarning[];
}> {
  const workflowId = options.workflowId ?? "workflow";
  const workflowMode = options.workflowMemory?.workflow;
  const memoryMounts = [
    ...workflowMemoryMounts({
      world: options.world,
      workflowId,
      memory: {
        ...options.workflowMemory,
        workflow: workflowMode === "none" ? "none" : "ro",
      },
    }),
    ...(options.pipelineWorkflowDefinitionHashes === undefined
      ? []
      : pipelineMemoryMounts({
          world: options.world,
          workflowDefinitionHashes: options.pipelineWorkflowDefinitionHashes,
          mode: options.parentRunId === undefined ? "rw" : "ro",
          includeOrg: false,
        })),
  ];
  const scratchMounts = scratchMountsForScope(scope);
  await ensureScratchMounts(scratchMounts.filter((mount) => mount.mode === "rw"));
  await ensureMemoryMounts(memoryMounts);
  return {
    memoryMounts,
    scratchMounts,
    skills: includeSkills ? (options.workerSkills ?? []) : [],
    skillWarnings: includeSkills ? (options.workerSkillWarnings ?? []) : [],
  };
}

function createRuntimeHarnessContext(options: {
  readonly world: LocalWorld;
  readonly runId: RunId;
  readonly scope: HarnessContext["scope"];
  readonly taskKind: "execute_step" | "fix_step";
  readonly manifest: unknown;
  readonly model: HarnessContext["model"];
  readonly system?: string;
  readonly tools: HarnessContext["tools"];
  readonly memoryMounts: HarnessContext["memoryMounts"];
  readonly scratchMounts: HarnessContext["scratchMounts"];
  readonly skills: HarnessContext["skills"];
  readonly skillWarnings?: readonly WorkflowSkillWarning[];
  readonly recorder: ReturnType<typeof createHarnessEventRecorder>;
  readonly abortSignal: AbortSignal;
  readonly bashCapabilities?: BashCapabilities;
  readonly permissions?: ToolPermissions;
}): RuntimeHarnessContext {
  return {
    scope: options.scope,
    session: {
      runId: options.runId,
      role: options.scope.role,
      task: { kind: options.taskKind },
      manifest: options.manifest,
      manifestHash: hashHarnessManifest(options.manifest as never),
      ...(options.scope.parentRunId === undefined ? {} : { parentRunId: options.scope.parentRunId }),
      ...(options.skillWarnings === undefined || options.skillWarnings.length === 0 ? {} : { warnings: options.skillWarnings }),
    },
    model: options.model,
    ...(options.system === undefined ? {} : { system: options.system }),
    tools: options.tools,
    memoryMounts: options.memoryMounts,
    scratchMounts: options.scratchMounts,
    skills: options.skills,
    mounts: harnessRuntimeMounts(
      options.memoryMounts,
      options.scratchMounts,
      options.skills,
    ),
    ...(options.bashCapabilities === undefined ? {} : { bashCapabilities: options.bashCapabilities }),
    durability: {
      append: async (event) => {
        const eventWithWarnings = eventWithSessionWarnings(event, options.skillWarnings);
        await options.recorder.append({
          type: eventWithWarnings.type,
          ...(eventWithWarnings.occurrenceId === undefined ? {} : { occurrenceId: eventWithWarnings.occurrenceId }),
          payload: eventWithWarnings.payload,
        });
      },
      priorEvents: async (query) => {
        const events = await options.recorder.priorEvents(query?.runId ?? options.runId);
        const queryType = query?.type;
        return queryType === undefined
          ? events as never
          : events.filter((event) => isEventEnvelope(event) && normalizeHarnessEventType(event.type) ===
            normalizeHarnessEventType(queryType)) as never;
      },
    },
    abortSignal: options.abortSignal,
    ...(options.permissions === undefined ? {} : { permissions: workflowToolPermissions(options.permissions) }),
    bash: createBashTool(
      withBashCapabilities(
        bashScopeForHarness(
          options.scope.logDir,
          options.memoryMounts,
          options.scratchMounts,
          options.skills,
        ),
        options.bashCapabilities,
      ),
    ),
    recorder: options.recorder,
  };
}

function eventWithSessionWarnings<TEvent extends { readonly type: string; readonly payload: Record<string, unknown> }>(
  event: TEvent,
  warnings: readonly WorkflowSkillWarning[] | undefined,
): TEvent {
  if (
    normalizeHarnessEventType(event.type) !== "harness.session.started" ||
    warnings === undefined ||
    warnings.length === 0 ||
    propertyValue(event.payload, "warnings") !== undefined
  ) {
    return event;
  }
  return {
    ...event,
    payload: {
      ...event.payload,
      warnings,
    },
  };
}

function harnessRuntimeMounts(
  memoryMounts: HarnessContext["memoryMounts"],
  scratchMounts: HarnessContext["scratchMounts"],
  skills: HarnessContext["skills"],
): HarnessContext["mounts"] {
  return [
    ...memoryMounts.map((mount) => ({
      mountPath: mount.mountPath,
      backingPath: mount.backingPath,
      mode: mount.mode,
    })),
    ...scratchMounts.map((mount) => ({
      mountPath: mount.mountPath,
      backingPath: mount.backingPath,
      mode: mount.mode,
    })),
    ...skills.flatMap((skill) => {
      const mountPath = stringProperty(skill, "mountPath");
      const backingPath = skillBackingPath(skill);
      if (mountPath === undefined || backingPath === undefined) {
        return [];
      }
      return [{ mountPath, backingPath, mode: "ro" as const }];
    }),
  ];
}

function workflowToolPermissions(
  permissions: ToolPermissions,
): NonNullable<HarnessContext["permissions"]> {
  return permissions as NonNullable<HarnessContext["permissions"]>;
}

function runLogDir(
  world: LocalWorld,
  runId: RunId,
  parentRunId?: RunId,
): string {
  if (parentRunId === undefined) {
    return resolvePath(world.dataDir, "runs", runId);
  }
  return resolvePath(world.dataDir, "runs", parentRunId, "sub-runs", runId);
}

function skillFrontmatterHash(
  skill: { readonly name: string; readonly frontmatterHash?: unknown },
): string {
  if (typeof skill.frontmatterHash === "string" && skill.frontmatterHash.length > 0) {
    return skill.frontmatterHash;
  }
  return sha256Digest({ name: skill.name });
}

function skillManifestIdentity(skill: { readonly name: string; readonly frontmatterHash?: unknown }): SkillManifestIdentity {
  const remote = remoteSkillIdentityFromValue(propertyValue(skill, "remote"));
  return {
    name: skill.name,
    frontmatterHash: skillFrontmatterHash(skill),
    ...(remote === undefined ? {} : { remote }),
  };
}

function bashScopeForHarness(
  cwd: string,
  memoryMounts: readonly HarnessContext["memoryMounts"][number][],
  scratchMounts: readonly HarnessContext["scratchMounts"][number][],
  skills: HarnessContext["skills"],
): Parameters<typeof createBashTool>[0] {
  const ownScratch = scratchMounts.find((mount) => mount.mountPath === "/mnt/scratch/own/");
  const readableRoots = mergedReadableRoots([
    ...(ownScratch === undefined ? [{ path: cwd, mode: "rw" as const }] : []),
    ...memoryMounts.map((mount) => ({ path: rootPathForMount(mount.backingPath), mode: mount.mode })),
    ...scratchMounts.map((mount) => ({ path: rootPathForMount(mount.backingPath), mode: mount.mode })),
    ...skillBashRoots(skills),
  ]);
  const pathAliases = [
    ...memoryMounts.map((mount) => ({ mountPath: mount.mountPath, backingPath: mount.backingPath })),
    ...scratchMounts.map((mount) => ({ mountPath: mount.mountPath, backingPath: mount.backingPath })),
    ...skillBashAliases(skills),
  ];
  return {
    cwd: ownScratch?.mountPath ?? cwd,
    readableRoots,
    ...(pathAliases.length === 0 ? {} : { pathAliases }),
  };
}

function withBashCapabilities(
  scope: Parameters<typeof createBashTool>[0],
  capabilities: BashCapabilities | undefined,
): Parameters<typeof createBashTool>[0] {
  return capabilities === undefined ? scope : { ...scope, capabilities };
}

function mergedReadableRoots(
  roots: ReadonlyArray<{ readonly path: string; readonly mode: "rw" | "ro" }>,
): ReadonlyArray<{ readonly path: string; readonly mode: "rw" | "ro" }> {
  const merged = new Map<string, "rw" | "ro">();
  for (const root of roots) {
    const existing = merged.get(root.path);
    if (existing === "rw" || root.mode === "rw") {
      merged.set(root.path, "rw");
    } else {
      merged.set(root.path, "ro");
    }
  }
  return [...merged.entries()].map(([path, mode]) => ({ path, mode }));
}

function skillBashRoots(
  skills: HarnessContext["skills"],
): ReadonlyArray<{ readonly path: string; readonly mode: "ro" }> {
  const roots: Array<{ readonly path: string; readonly mode: "ro" }> = [];
  for (const skill of skills) {
    const backingPath = skillBackingPath(skill);
    if (backingPath === undefined || backingPath.includes("*")) {
      continue;
    }
    roots.push({ path: backingPath, mode: "ro" });
  }
  return roots;
}

function skillBashAliases(
  skills: HarnessContext["skills"],
): ReadonlyArray<{ readonly mountPath: string; readonly backingPath: string }> {
  const aliases: Array<{ readonly mountPath: string; readonly backingPath: string }> = [];
  for (const skill of skills) {
    const mountPath = stringProperty(skill, "mountPath");
    const backingPath = skillBackingPath(skill);
    if (
      mountPath === undefined ||
      backingPath === undefined ||
      mountPath.includes("*") ||
      backingPath.includes("*")
    ) {
      continue;
    }
    aliases.push({ mountPath, backingPath });
  }
  return aliases;
}

function skillBackingPath(skill: HarnessContext["skills"][number]): string | undefined {
  const backingPath = stringProperty(skill, "backingPath");
  if (backingPath !== undefined) {
    return backingPath;
  }
  const source = stringProperty(skill, "source");
  if (source !== undefined) {
    return source;
  }
  return stringProperty(skill, "bodyPath");
}

function bashCapabilitiesForWorkflow(
  workflow: Pick<CompilableWorkflowDefinition, "bash">,
  fallback: BashCapabilities | undefined,
): BashCapabilities | undefined {
  return workflow.bash ?? fallback;
}

function bashCapabilitiesFromUnknown(value: unknown): BashCapabilities | undefined {
  return isRecord(value) ? value as BashCapabilities : undefined;
}

function rootPathForMount(backingPath: string): string {
  const wildcardIndex = backingPath.indexOf("*");
  if (wildcardIndex === -1) {
    return backingPath;
  }
  const prefix = backingPath.slice(0, wildcardIndex);
  return prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
}

/**
 * Run a single compile-then-execute cycle inside its own run execution fence.
 * Used by the outer-loop scheduler to drive per-cycle runs with the correct
 * outerLoop context and promptNote.
 */
export async function runWorkflowCycle(
  options: RunWorkflowCycleOptions,
): Promise<RunResult<unknown>> {
  return withRunExecutionFence(options.world, options.runId, () =>
    runWorkflowCycleUnfenced(
      options.workflow,
      options,
      options.runId,
      options.outerLoop,
      options.promptNote,
      options.outerLoopId,
    )
  );
}

function plannerReuseDecisionBlocks(
  candidate: PlannerReuseCandidate | undefined,
  currentPlanningDefinitionSnapshot: unknown,
  currentRequestedOutputHash: string | undefined,
  currentCapabilities?: PlannerReuseCapabilityContext,
): readonly string[] {
  if (candidate === undefined) {
    return [];
  }
  const blocks: string[] = [];
  const candidateLock = propertyValue(candidate.workflowVersion, "lock");
  const priorLockRequestedOutputHash = stringProperty(candidateLock, "requestedOutputHash");
  const priorSnapshotRequestedOutputHash = stringProperty(
    candidate.planningDefinitionSnapshot,
    "requestedOutputHash",
  );
  const priorCandidateRequestedOutputHash =
    priorSnapshotRequestedOutputHash ?? priorLockRequestedOutputHash;
  const comparableCurrentRequestedOutputHash = priorSnapshotRequestedOutputHash === undefined
    ? currentRequestedOutputHash
    : stringProperty(currentPlanningDefinitionSnapshot, "requestedOutputHash") ??
      currentRequestedOutputHash;
  if (
    priorCandidateRequestedOutputHash !== undefined &&
    comparableCurrentRequestedOutputHash !== undefined &&
    priorCandidateRequestedOutputHash !== comparableCurrentRequestedOutputHash
  ) {
    blocks.push("requested output contract changed");
  }
  if (currentCapabilities !== undefined) {
    blocks.push(
      ...plannerReuseCapabilityBlocks(
        candidate,
        currentPlanningDefinitionSnapshot,
        currentCapabilities,
      ),
    );
  }
  return [...new Set(blocks)];
}

type PlannerReuseCapabilityContext = {
  readonly tools?: ToolRegistry;
  readonly models: Record<string, unknown>;
  readonly workerHarness?: Harness;
  readonly bashCapabilities?: BashCapabilities;
};

function plannerReuseCapabilityBlocks(
  candidate: PlannerReuseCandidate,
  currentPlanningDefinitionSnapshot: unknown,
  currentCapabilities: PlannerReuseCapabilityContext,
): readonly string[] {
  const blocks: string[] = [];
  const workflowVersion = candidate.workflowVersion as ExecuteWorkflowVersionOptions["workflowVersion"];
  const lwir = propertyValue(candidate.workflowVersion, "lwir");
  const permissions = propertyValue(lwir, "permissions");
  const capabilityManifest = propertyValue(
    propertyValue(candidate.workflowVersion, "lock"),
    "capabilityManifest",
  );
  const priorWorkerHarnessId = stringProperty(
    propertyValue(capabilityManifest, "workerHarness"),
    "harnessId",
  );
  const currentWorkerHarnessId = currentCapabilities.workerHarness === undefined
    ? undefined
    : harnessIdFor(currentCapabilities.workerHarness);
  const requiresWorkerHarness =
    workflowUsesStepType(lwir, "ai.generate") || workflowUsesStepType(lwir, "code.run");
  const usesToolCall = workflowUsesStepType(lwir, "tool.call");
  const usesWorkerHarnessStep = requiresWorkerHarness || usesToolCall;
  const usesBashBackedWorkerStep = requiresWorkerHarness ||
    (usesToolCall && (priorWorkerHarnessId !== undefined || currentWorkerHarnessId !== undefined));
  for (const toolName of stringArrayProperty(permissions, "tools")) {
    const currentPlanningTool = planningToolSnapshot(currentPlanningDefinitionSnapshot, toolName);
    if (
      currentPlanningTool === undefined ||
      propertyValue(currentPlanningTool, "registered") !== true
    ) {
      blocks.push(`tool '${toolName}' unavailable`);
      continue;
    }
    const descriptor = toolDescriptorFromRegistry(currentCapabilities.tools, toolName);
    if (descriptor === undefined) {
      blocks.push(`tool '${toolName}' unavailable`);
      continue;
    }
    try {
      assertToolCapabilityLockFromDescriptor(workflowVersion, toolName, descriptor);
      assertToolApprovalSupportedFromDescriptor(toolName, descriptor);
    } catch {
      blocks.push(`tool '${toolName}' unavailable`);
    }
  }
  for (const modelSlot of stringArrayProperty(permissions, "models")) {
    if (!Object.hasOwn(currentCapabilities.models, modelSlot)) {
      blocks.push(`model '${modelSlot}' unavailable`);
      continue;
    }
    try {
      assertModelCapabilityLock(
        workflowVersion,
        modelSlot,
        currentCapabilities.models[modelSlot],
      );
    } catch {
      blocks.push(`model '${modelSlot}' unavailable`);
    }
  }
  if (usesWorkerHarnessStep) {
    if (
      (requiresWorkerHarness || priorWorkerHarnessId !== undefined) &&
      currentWorkerHarnessId === undefined
    ) {
      blocks.push("worker harness unavailable");
    } else if (
      (priorWorkerHarnessId !== undefined || currentWorkerHarnessId !== undefined) &&
      priorWorkerHarnessId !== currentWorkerHarnessId
    ) {
      blocks.push("worker harness changed");
    }
  }
  if (usesBashBackedWorkerStep) {
    const priorBash = propertyValue(capabilityManifest, "bash");
    const currentBash = normalizeBashCapabilities(currentCapabilities.bashCapabilities);
    if (priorBash !== undefined && canonicalJson(priorBash) !== canonicalJson(currentBash)) {
      blocks.push("bash capability changed");
    }
  }
  return [...new Set(blocks)];
}

function planningToolSnapshot(
  currentPlanningDefinitionSnapshot: unknown,
  toolName: string,
): JsonRecord | undefined {
  const tools = propertyValue(currentPlanningDefinitionSnapshot, "plannerVisibleTools");
  if (!Array.isArray(tools)) {
    return undefined;
  }
  return tools.find((tool): tool is JsonRecord =>
    isRecord(tool) && propertyValue(tool, "name") === toolName
  );
}

function workflowUsesStepType(lwir: unknown, uses: string): boolean {
  return stepsUseStepType(propertyValue(lwir, "steps"), uses);
}

function stepsUseStepType(steps: unknown, uses: string): boolean {
  if (!Array.isArray(steps)) {
    return false;
  }
  return steps.some((step) =>
    isRecord(step) &&
    (
      propertyValue(step, "uses") === uses ||
      stepsUseStepType(propertyValue(step, "steps"), uses)
    )
  );
}

async function materializePlannerReuseDetails(options: {
  readonly logDir: string;
  readonly candidate: PlannerReuseCandidate;
}): Promise<{ readonly mountPath: string; readonly backingPath: string; readonly mode: "ro" }> {
  const backingRoot = join(options.logDir, "planner-reuse");
  const candidateDir = join(backingRoot, options.candidate.workflowVersionId);
  await mkdir(candidateDir, { recursive: true });
  const workflowVersion = isRecord(options.candidate.workflowVersion)
    ? options.candidate.workflowVersion
    : {};
  await Promise.all([
    writePlannerReuseJson(
      join(candidateDir, "lwir.json"),
      propertyValue(workflowVersion, "lwir") ?? null,
    ),
    writePlannerReuseJson(
      join(candidateDir, "lock.json"),
      propertyValue(workflowVersion, "lock") ?? null,
    ),
    writePlannerReuseJson(
      join(candidateDir, "planning-definition-snapshot.json"),
      options.candidate.planningDefinitionSnapshot ?? null,
    ),
    writeFile(
      join(candidateDir, "prior-input-summary.md"),
      [
        `# Prior Input Summary`,
        ``,
        `WorkflowVersion: ${options.candidate.workflowVersionId}`,
        `Run: ${options.candidate.runId}`,
        `Input hash: ${
          stringProperty(propertyValue(workflowVersion, "lock"), "inputHash") ?? "unknown"
        }`,
        `Input structure hash: ${
          stringProperty(propertyValue(workflowVersion, "lock"), "plannedInputStructureHash") ?? "unknown"
        }`,
        ``,
      ].join("\n"),
      "utf8",
    ),
    writeFile(
      join(candidateDir, "prior-output-summary.md"),
      [
        `# Prior Output Summary`,
        ``,
        `WorkflowVersion: ${options.candidate.workflowVersionId}`,
        `Run: ${options.candidate.runId}`,
        `Output: ${summaryLine(options.candidate.priorOutput)}`,
        ``,
      ].join("\n"),
      "utf8",
    ),
    writeFile(
      join(candidateDir, "feedback-summary.md"),
      [
        `# Feedback Summary`,
        ``,
        `No structured feedback is attached to this candidate.`,
        ``,
      ].join("\n"),
      "utf8",
    ),
  ]);
  return {
    mountPath: "/planner/reuse/",
    backingPath: backingRoot,
    mode: "ro",
  };
}

async function writePlannerReuseJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${canonicalJson(value)}\n`, "utf8");
}

function summaryLine(value: unknown): string {
  if (value === undefined) {
    return "not recorded";
  }
  const json = canonicalJson(value);
  return json.length <= 240 ? json : `${json.slice(0, 237)}...`;
}

function plannerReuseDecisionRecordedPayload(options: {
  readonly decision: ReturnType<typeof validatePlannerReuseDecision>;
  readonly input: unknown;
  readonly candidateBriefHash?: string;
  readonly resultingWorkflowVersionId: string;
}): JsonRecord {
  return stripUndefined({
    decisionKind: options.decision.kind,
    rationale: options.decision.rationale,
    inputHash: sha256Digest(options.input),
    inputStructure: concreteInputStructure(options.input),
    candidateBriefHash: options.candidateBriefHash,
    resultingWorkflowVersionId: options.resultingWorkflowVersionId,
    ...(options.decision.kind === "reuse_unchanged"
      ? {
          candidateWorkflowVersionId: options.decision.workflowVersionId,
          acknowledgedWarnings: options.decision.acknowledgedWarnings ?? [],
        }
      : {}),
    ...(options.decision.kind === "adapt"
      ? {
          baseWorkflowVersionId: options.decision.baseWorkflowVersionId,
          candidateWorkflowVersionId: options.decision.baseWorkflowVersionId,
        }
      : {}),
  });
}

async function executePartialPlannerReuseReplay(options: {
  readonly world: LocalWorld;
  readonly workflow: CompilableWorkflowDefinition;
  readonly input: unknown;
  readonly tools?: ToolRegistry;
  readonly maxAttempts?: number;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly startedAt: number;
  readonly runId: RunId;
  readonly outerLoopId?: string;
  readonly parentRunId?: RunId;
  readonly pipelineWorkflowDefinitionHashes?: readonly string[];
  readonly preResolvedWorkerSkills?: HarnessContext["skills"];
  readonly preResolvedWorkerSkillWarnings?: readonly WorkflowSkillWarning[];
  readonly bash?: BashCapabilities;
  readonly workflowVersionId: string;
}): Promise<RunResult<unknown>> {
  const workerResolvedSkills = options.preResolvedWorkerSkills === undefined
    ? await resolveRoleSkillsWithWarnings(
      isRecord(options.workflow.worker) ? options.workflow.worker.skills : undefined,
      options.world,
      roleSkillResolveDefaults(options.workflow.worker, options.signal),
    )
    : {
        skills: options.preResolvedWorkerSkills,
        warnings: options.preResolvedWorkerSkillWarnings ?? [],
      };
  const workerSkills = workerResolvedSkills.skills;
  const workerSkillWarnings = workerResolvedSkills.warnings;
  const workflowForExecution = workflowWithResolvedSkillIdentities(
    options.workflow,
    [],
    workerSkills,
  );
  const workflowVersion = await readStoredWorkflowVersion(
    options.world,
    options.workflowVersionId,
  );
  await appendPlannerReuseRegistrationIfMissing(
    options.world,
    options.runId,
    workflowVersion as ExecuteWorkflowVersionOptions["workflowVersion"],
  );
  if (isSignalAborted(options.signal)) {
    const result = await appendCancelledRun(
      options.world,
      options.runId,
      "cancelled",
      options.workflowVersionId,
      options.parentRunId,
    );
    throw runFailedErrorFromRuntime(result, result.events, "cancelled");
  }
  const executionTimeoutMs = remainingTimeoutMs(options.timeoutMs, options.startedAt);
  if (executionTimeoutMs !== undefined && executionTimeoutMs <= 0) {
    const result = await appendCancelledRun(
      options.world,
      options.runId,
      "timeout",
      options.workflowVersionId,
      options.parentRunId,
    );
    throw runFailedErrorFromRuntime(result, result.events, "timeout");
  }
  const workerConfig = runtimeWorkerConfigForWorkflow(workflowForExecution);
  const executionCancellation = cancellationControllerFor(executionTimeoutMs, options.signal);
  void executionCancellation.promise.catch(() => undefined);
  const runtimeResult = await executeWorkflowVersionUnlocked({
    world: options.world,
    workflowVersion: workflowVersion as ExecuteWorkflowVersionOptions["workflowVersion"],
    input: options.input,
    runId: options.runId,
    models: runtimeModelsForWorkflow(workflowForExecution),
    tools: options.tools,
    ...(workerConfig.workerHarness === undefined ? {} : { workerHarness: workerConfig.workerHarness }),
    workflowId: workflowForExecution.id,
    workflowMemory: workflowForExecution.memory,
    bashCapabilities: bashCapabilitiesForWorkflow(workflowForExecution, options.bash),
    workerSkills,
    workerSkillWarnings,
    ...(options.parentRunId === undefined ? {} : { parentRunId: options.parentRunId }),
    ...(options.pipelineWorkflowDefinitionHashes === undefined
      ? {}
      : { pipelineWorkflowDefinitionHashes: options.pipelineWorkflowDefinitionHashes }),
    maxAttempts: options.maxAttempts,
    signal: executionCancellation.signal,
    outerLoopId: options.outerLoopId,
  }, options.runId).finally(() => executionCancellation.dispose());

  if (runtimeResult.status === "failed") {
    const failedResult = {
      runId: runtimeResult.runId,
      workflowVersionId: runtimeResult.workflowVersionId,
      status: "failed",
      ...("output" in runtimeResult ? { output: runtimeResult.output } : {}),
      usage: runtimeResult.usage,
      events: runtimeResult.events,
      artifacts: runtimeResult.artifacts,
    } satisfies FailedRunResult;
    throw runFailedErrorFromRuntime(failedResult, runtimeResult.events);
  }
  return {
    runId: runtimeResult.runId,
    workflowVersionId: runtimeResult.workflowVersionId,
    status: "completed",
    output: runtimeResult.output,
    usage: runtimeResult.usage,
    events: runtimeResult.events,
    artifacts: runtimeResult.artifacts,
  } satisfies RunResult<unknown>;
}

async function appendPlannerReuseRegistrationIfMissing(
  world: LocalWorld,
  runId: RunId,
  workflowVersion: ExecuteWorkflowVersionOptions["workflowVersion"],
): Promise<void> {
  const events = await world.listEvents(runId);
  if (events.some((event) => event.type === "WorkflowVersionRegistered")) {
    return;
  }
  await appendEventPrefix(world, runId, [
    {
      type: "WorkflowVersionRegistered",
      payload: workflowVersionRegisteredPayload(workflowVersion, workflowVersion.id),
    },
  ]);
}

async function runWorkflowCycleUnfenced(
  workflow: CompilableWorkflowDefinition,
  options: {
    readonly world: LocalWorld;
    readonly input: unknown;
    readonly planner?: PlannerAdapter;
    readonly tools?: ToolRegistry;
    readonly maxAttempts?: number;
    readonly signal?: AbortSignal;
    readonly timeout?: string | number;
    readonly parentRunId?: RunId;
    readonly pipelineWorkflowDefinitionHashes?: readonly string[];
    readonly workflowVersionReuseStrategy?: import("./workflow-version-reuse.js").WorkflowVersionReuseStrategy;
    readonly preResolvedWorkerSkills?: HarnessContext["skills"];
    readonly preResolvedWorkerSkillWarnings?: readonly WorkflowSkillWarning[];
    readonly bash?: BashCapabilities;
    readonly label?: string;
    readonly tags?: readonly string[];
    readonly permissions?: ToolPermissions;
  },
  runId: RunId,
  outerLoop: import("./compiler.js").WorkflowCompileOptions["outerLoop"] | undefined,
  promptNote: string | undefined,
  outerLoopId: string | undefined = undefined,
): Promise<RunResult<unknown>> {
    const startedAt = Date.now();
    const timeoutMs = timeoutMsFor(options.timeout);
    const existingTerminalFailure = await existingRunWorkflowTerminalFailure(
      options.world,
      runId,
      options.input,
      true,
    );
    if (existingTerminalFailure !== undefined) {
      throw existingTerminalFailure;
    }
    const existingTerminalCompletion = await existingRunWorkflowTerminalCompletion(
      options.world,
      runId,
      options.input,
      workflow,
    );
    if (existingTerminalCompletion !== undefined) {
      return existingTerminalCompletion;
    }
    if (isSignalAborted(options.signal)) {
      const result = await appendCancelledRun(
        options.world,
        runId,
        "cancelled",
        "uncompiled",
        options.parentRunId,
      );
      throw runFailedErrorFromRuntime(result, result.events, "cancelled");
    }
    if (timeoutMs !== undefined && timeoutMs <= 0) {
      const result = await appendCancelledRun(
        options.world,
        runId,
        "timeout",
        "uncompiled",
        options.parentRunId,
      );
      throw runFailedErrorFromRuntime(result, result.events, "timeout");
    }
    const partialReuseWorkflowVersionId = plannerReuseRecordedWorkflowVersionId(
      await options.world.listEvents(runId),
      options.input,
    );
    if (partialReuseWorkflowVersionId !== undefined) {
      return executePartialPlannerReuseReplay({
        world: options.world,
        workflow,
        input: options.input,
        tools: options.tools,
        maxAttempts: options.maxAttempts,
        signal: options.signal,
        timeoutMs,
        startedAt,
        runId,
        outerLoopId,
        parentRunId: options.parentRunId,
        pipelineWorkflowDefinitionHashes: options.pipelineWorkflowDefinitionHashes,
        preResolvedWorkerSkills: options.preResolvedWorkerSkills,
        preResolvedWorkerSkillWarnings: options.preResolvedWorkerSkillWarnings,
        bash: options.bash,
        workflowVersionId: partialReuseWorkflowVersionId,
      });
    }
    if (options.planner === undefined && workflow.planner === undefined) {
      throw new Error("runWorkflow requires workflow.planner harness config in alpha.");
    }

    const logDir = runLogDir(options.world, runId, options.parentRunId);
    const plannerResolvedSkills = await resolveRoleSkillsWithWarnings(
      isRecord(workflow.planner) ? workflow.planner.skills : undefined,
      options.world,
      roleSkillResolveDefaults(workflow.planner, options.signal),
    );
    const workerResolvedSkills = options.preResolvedWorkerSkills === undefined
      ? await resolveRoleSkillsWithWarnings(
        isRecord(workflow.worker) ? workflow.worker.skills : undefined,
        options.world,
        roleSkillResolveDefaults(workflow.worker, options.signal),
      )
      : {
          skills: options.preResolvedWorkerSkills,
          warnings: options.preResolvedWorkerSkillWarnings ?? [],
        };
    const plannerSkills = plannerResolvedSkills.skills;
    const plannerSkillWarnings = plannerResolvedSkills.warnings;
    const workerSkills = workerResolvedSkills.skills;
    const workerSkillWarnings = workerResolvedSkills.warnings;
    const workflowForCompile = workflowWithResolvedSkillIdentities(
      workflow,
      plannerSkills,
      workerSkills,
    );
    const bashCapabilities = bashCapabilitiesForWorkflow(workflowForCompile, options.bash);
    const plannerMemoryMounts = [
      ...workflowMemoryMounts({
        world: options.world,
        workflowId: workflowForCompile.id,
        memory: workflowForCompile.memory,
      }),
      ...(options.pipelineWorkflowDefinitionHashes === undefined
        ? []
        : pipelineMemoryMounts({
            world: options.world,
            workflowDefinitionHashes: options.pipelineWorkflowDefinitionHashes,
            mode: options.parentRunId === undefined ? "rw" : "ro",
            includeOrg: false,
          })),
    ];
    const plannerScope: HarnessContext["scope"] = {
      runId,
      ...(options.parentRunId === undefined ? {} : { parentRunId: options.parentRunId }),
      logDir,
      role: "planner",
    };
    const basePlannerScratchMounts = scratchMountsForScope(plannerScope);

    const reuseStrategy = resolveWorkflowVersionReuseStrategy({
      call: options.workflowVersionReuseStrategy,
      workflow: workflow.workflowVersionReuseStrategy,
    });
    const reuseCandidates = reuseStrategy === "planner_reviewed"
      ? await selectPlannerReuseCandidates(options.world, { workflowId: workflowForCompile.id })
      : [];
    const briefedReuseCandidate = reuseCandidates[0];
    const validReuseDecisionCandidates = briefedReuseCandidate === undefined
      ? []
      : [briefedReuseCandidate];
    const currentPlanningDefinitionSnapshot =
      reuseStrategy === "planner_reviewed" && briefedReuseCandidate !== undefined
        ? getPlanningDefinitionSnapshot(workflowForCompile, options.tools)
        : undefined;
    const currentRequestedOutputHash =
      reuseStrategy === "planner_reviewed" && briefedReuseCandidate !== undefined
        ? requestedOutputHashForWorkflow(workflowForCompile)
        : undefined;
    const reuseDetailMount = briefedReuseCandidate === undefined
      ? undefined
      : await materializePlannerReuseDetails({
          logDir,
          candidate: briefedReuseCandidate,
        });
    const plannerScratchMounts = reuseDetailMount === undefined
      ? basePlannerScratchMounts
      : [...basePlannerScratchMounts, reuseDetailMount];
    await ensureScratchMounts(plannerScratchMounts);
    await ensureMemoryMounts(plannerMemoryMounts);
    const reuseBrief = reuseStrategy === "planner_reviewed" && briefedReuseCandidate !== undefined
      ? buildReuseBrief({
          candidate: briefedReuseCandidate,
          currentPlanningDefinitionSnapshot,
          mountedRoot: "/planner/reuse",
        })
      : undefined;
    const promptNoteForCompile = reuseBrief === undefined
      ? promptNote
      : [promptNote, reuseBrief.text].filter((entry): entry is string =>
          typeof entry === "string" && entry.length > 0
        ).join("\n\n");

    const cancellation = cancellationControllerFor(timeoutMs, options.signal);
    const compilerLifecycle = compilerLifecycleRecorderFor(options.world, runId);
    let compiled: Awaited<ReturnType<typeof compileWorkflow>> | undefined;
    let reuseUnchangedDecision: Extract<
      ReturnType<typeof validatePlannerReuseDecision>,
      { readonly kind: "reuse_unchanged" }
    > | undefined;
    let reuseUnchangedCandidate: PlannerReuseCandidate | undefined;
    try {
      compiled = await wrapCompilerFailure(
        runId,
        options.world,
        raceCancellable(
          runId,
          "uncompiled",
          options.world,
          compileWorkflow(workflowForCompile, {
            input: options.input,
            ...(options.planner === undefined ? {} : { planner: options.planner }),
            tools: options.tools,
            bash: bashCapabilities,
            outerLoop,
            promptNote: promptNoteForCompile,
            plannerHarnessRuntime: {
              world: options.world,
              runId,
              ...(options.parentRunId === undefined ? {} : { parentRunId: options.parentRunId }),
              logDir,
              memoryMounts: plannerMemoryMounts,
              scratchMounts: plannerScratchMounts,
              skills: plannerSkills,
              skillWarnings: plannerSkillWarnings,
              bashCapabilities,
              abortSignal: cancellation.signal,
            },
            onCompilerLifecycleEvent: compilerLifecycle.record,
          }),
          cancellation,
          () => compilerLifecycle.flush(),
          options.parentRunId,
        ),
        options.parentRunId,
      );
    } catch (error) {
      if (error instanceof PlannerReuseUnchangedDecisionError && reuseStrategy === "planner_reviewed") {
        const decision = validatePlannerReuseDecision(
          {
            kind: "reuse_unchanged",
            workflowVersionId: error.workflowVersionId,
            rationale: error.rationale,
            acknowledgedWarnings: error.acknowledgedWarnings,
          },
          {
            candidates: validReuseDecisionCandidates,
            warnings: reuseBrief?.warnings ?? [],
            blocks: plannerReuseDecisionBlocks(
              validReuseDecisionCandidates.find((entry) =>
                entry.workflowVersionId === error.workflowVersionId
              ),
              currentPlanningDefinitionSnapshot,
              currentRequestedOutputHash,
              {
                tools: options.tools,
                models: runtimeModelsForWorkflow(workflowForCompile),
                workerHarness: runtimeWorkerConfigForWorkflow(workflowForCompile).workerHarness,
                bashCapabilities,
              },
            ),
          },
        );
        if (decision.kind !== "reuse_unchanged") {
          throw new Error("Planner reuse decision validation returned an unexpected decision kind.");
        }
        const candidate = validReuseDecisionCandidates.find((entry) =>
          entry.workflowVersionId === decision.workflowVersionId
        );
        if (candidate === undefined) {
          throw new Error(
            `Planner reuse decision references a missing candidate: ${decision.workflowVersionId}`,
          );
        }
        reuseUnchangedDecision = decision;
        reuseUnchangedCandidate = candidate;
      } else {
        throw error;
      }
    } finally {
      cancellation.dispose();
    }
    const runLabel = resolveRunLabel({
      runLabel: options.label,
      defLabel: (workflow as { readonly label?: string }).label,
      id: workflow.id,
    });
    const runTags = options.tags ?? [];
    if (reuseUnchangedDecision !== undefined && reuseUnchangedCandidate !== undefined) {
      const candidateWorkflowVersion = await readStoredWorkflowVersion(
        options.world,
        reuseUnchangedDecision.workflowVersionId,
      );
      await wrapCompilerFailure(
        runId,
        options.world,
        Promise.resolve().then(() =>
          validateRunInputAgainstLwirSchema(candidateWorkflowVersion.lwir, options.input)
        ),
      );
      await appendEventPrefix(options.world, runId, [
        {
          type: "PlannerReuseDecisionRecorded",
          payload: stripUndefined({
            decisionKind: reuseUnchangedDecision.kind,
            candidateWorkflowVersionId: reuseUnchangedDecision.workflowVersionId,
            rationale: reuseUnchangedDecision.rationale,
            acknowledgedWarnings: reuseUnchangedDecision.acknowledgedWarnings ?? [],
            inputHash: sha256Digest(options.input),
            inputStructure: concreteInputStructure(options.input),
            candidateBriefHash: reuseBrief?.briefHash,
            resultingWorkflowVersionId: reuseUnchangedDecision.workflowVersionId,
          }),
        },
        {
          type: "WorkflowVersionRegistered",
          payload: workflowVersionRegisteredPayload(
            candidateWorkflowVersion as ExecuteWorkflowVersionOptions["workflowVersion"],
            reuseUnchangedDecision.workflowVersionId,
          ),
        },
        {
          type: "RunStarted",
          payload: stripUndefined({
            workflowVersionId: reuseUnchangedDecision.workflowVersionId,
            input: options.input,
            parentRunId: options.parentRunId,
            outerLoopId,
            label: runLabel,
            tags: runTags,
          }),
        },
      ]);
      if (isSignalAborted(options.signal)) {
        const result = await appendCancelledRun(
          options.world,
          runId,
          "cancelled",
          reuseUnchangedDecision.workflowVersionId,
          options.parentRunId,
        );
        throw runFailedErrorFromRuntime(result, result.events, "cancelled");
      }

      const executionTimeoutMs = remainingTimeoutMs(timeoutMs, startedAt);
      if (executionTimeoutMs !== undefined && executionTimeoutMs <= 0) {
        const result = await appendCancelledRun(
          options.world,
          runId,
          "timeout",
          reuseUnchangedDecision.workflowVersionId,
          options.parentRunId,
        );
        throw runFailedErrorFromRuntime(result, result.events, "timeout");
      }
      const runtimeModels = runtimeModelsForWorkflow(workflowForCompile);
      const workerConfig = runtimeWorkerConfigForWorkflow(workflowForCompile);
      const executionCancellation = cancellationControllerFor(executionTimeoutMs, options.signal);
      void executionCancellation.promise.catch(() => undefined);
      const runtimeResult = await executeWorkflowVersionUnlocked({
        world: options.world,
        workflowVersion: candidateWorkflowVersion as ExecuteWorkflowVersionOptions["workflowVersion"],
        input: options.input,
        runId,
        models: runtimeModels,
        tools: options.tools,
        ...(workerConfig.workerHarness === undefined ? {} : { workerHarness: workerConfig.workerHarness }),
        workflowId: workflowForCompile.id,
        workflowMemory: workflowForCompile.memory,
        bashCapabilities,
        workerSkills,
        workerSkillWarnings,
        ...(options.parentRunId === undefined ? {} : { parentRunId: options.parentRunId }),
        ...(options.pipelineWorkflowDefinitionHashes === undefined
          ? {}
          : { pipelineWorkflowDefinitionHashes: options.pipelineWorkflowDefinitionHashes }),
        maxAttempts: options.maxAttempts,
        signal: executionCancellation.signal,
        outerLoopId,
        ...(options.permissions === undefined ? {} : { permissions: options.permissions }),
      }, runId).finally(() => executionCancellation.dispose());

      if (runtimeResult.status === "failed") {
        const failedResult = {
          runId: runtimeResult.runId,
          workflowVersionId: runtimeResult.workflowVersionId,
          status: "failed",
          ...("output" in runtimeResult ? { output: runtimeResult.output } : {}),
          usage: runtimeResult.usage,
          events: runtimeResult.events,
          artifacts: runtimeResult.artifacts,
        } satisfies FailedRunResult;
        throw runFailedErrorFromRuntime(failedResult, runtimeResult.events);
      }
      return {
        runId: runtimeResult.runId,
        workflowVersionId: runtimeResult.workflowVersionId,
        status: "completed",
        output: runtimeResult.output,
        usage: runtimeResult.usage,
        events: runtimeResult.events,
        artifacts: runtimeResult.artifacts,
      } satisfies RunResult<unknown>;
    }
    if (compiled === undefined) {
      throw new Error("Workflow compile did not produce a WorkflowVersion.");
    }
    const validatedPlannerReuseDecision = compiled.plannerReuseDecision === undefined
      ? undefined
      : validatePlannerReuseDecision(
          {
            ...compiled.plannerReuseDecision,
            lwir: compiled.workflowVersion.lwir,
          },
          {
            candidates: validReuseDecisionCandidates,
            warnings: reuseBrief?.warnings ?? [],
          },
        );
    await registerStoredWorkflowVersion(options.world, compiled.workflowVersion);
    const plannerReuseDecisionEvent = validatedPlannerReuseDecision === undefined
      ? undefined
      : {
          type: "PlannerReuseDecisionRecorded" as const,
          payload: plannerReuseDecisionRecordedPayload({
            decision: validatedPlannerReuseDecision,
            input: options.input,
            candidateBriefHash: reuseBrief?.briefHash,
            resultingWorkflowVersionId: compiled.workflowVersion.id,
          }),
        };
    await appendCompiledWorkflowStartEvents(
      options,
      runId,
      compiled,
      outerLoopId,
      plannerReuseDecisionEvent,
      runLabel,
      runTags,
    );
    if (isSignalAborted(options.signal)) {
      const result = await appendCancelledRun(
        options.world,
        runId,
        "cancelled",
        compiled.workflowVersion.id,
        options.parentRunId,
      );
      throw runFailedErrorFromRuntime(result, result.events, "cancelled");
    }

    const executionTimeoutMs = remainingTimeoutMs(timeoutMs, startedAt);
    if (executionTimeoutMs !== undefined && executionTimeoutMs <= 0) {
      const result = await appendCancelledRun(
        options.world,
        runId,
        "timeout",
        compiled.workflowVersion.id,
        options.parentRunId,
      );
      throw runFailedErrorFromRuntime(result, result.events, "timeout");
    }
    const runtimeModels = runtimeModelsForWorkflow(workflowForCompile);
    const workerConfig = runtimeWorkerConfigForWorkflow(workflowForCompile);
    const executionCancellation = cancellationControllerFor(executionTimeoutMs, options.signal);
    void executionCancellation.promise.catch(() => undefined);
    const runtimeResult = await executeWorkflowVersionUnlocked({
      world: options.world,
      workflowVersion: compiled.workflowVersion,
      input: options.input,
      runId,
      models: runtimeModels,
      tools: options.tools,
      ...(workerConfig.workerHarness === undefined ? {} : { workerHarness: workerConfig.workerHarness }),
      workflowId: workflowForCompile.id,
      workflowMemory: workflowForCompile.memory,
      bashCapabilities,
      workerSkills,
      workerSkillWarnings,
      ...(options.parentRunId === undefined ? {} : { parentRunId: options.parentRunId }),
      ...(options.pipelineWorkflowDefinitionHashes === undefined
        ? {}
        : { pipelineWorkflowDefinitionHashes: options.pipelineWorkflowDefinitionHashes }),
      maxAttempts: options.maxAttempts,
      signal: executionCancellation.signal,
      outerLoopId,
      ...(options.permissions === undefined ? {} : { permissions: options.permissions }),
    }, runId).finally(() => executionCancellation.dispose());

    if (runtimeResult.status === "failed") {
      const failedResult = {
        runId: runtimeResult.runId,
        workflowVersionId: runtimeResult.workflowVersionId,
        status: "failed",
        ...("output" in runtimeResult ? { output: runtimeResult.output } : {}),
        usage: runtimeResult.usage,
        events: runtimeResult.events,
        artifacts: runtimeResult.artifacts,
      } satisfies FailedRunResult;
      throw runFailedErrorFromRuntime(failedResult, runtimeResult.events);
    }
    return {
      runId: runtimeResult.runId,
      workflowVersionId: runtimeResult.workflowVersionId,
      status: "completed",
      output: runtimeResult.output,
      usage: runtimeResult.usage,
      events: runtimeResult.events,
      artifacts: runtimeResult.artifacts,
    } satisfies RunResult<unknown>;
}

export type RunFailedCauseCode =
  | "input_schema_error"
  | "planner_validation_exhausted"
  | "capability_drift"
  | "runtime_config_error"
  | "step_schema_error"
  | "step_failed"
  | "max_visits_exceeded"
  | "timeout"
  | "cancelled"
  | "outer_loop_exhausted";

export class RunFailedError extends Error {
  readonly runId: string;
  readonly workflowVersionId: string;
  readonly failedStepPath?: string;
  readonly causeCode: RunFailedCauseCode;
  readonly result?: FailedRunResult;
  readonly outerLoopId?: string;
  readonly lastCycleOutput?: unknown;

  constructor(options: {
    readonly runId: string;
    readonly workflowVersionId: string;
    readonly causeCode: RunFailedCauseCode;
    readonly failedStepPath?: string;
    readonly message?: string;
    readonly result?: FailedRunResult;
    readonly outerLoopId?: string;
    readonly lastCycleOutput?: unknown;
  }) {
    super(options.message ?? `Run '${options.runId}' failed.`);
    this.name = "RunFailedError";
    this.runId = options.runId;
    this.workflowVersionId = options.workflowVersionId;
    this.failedStepPath = options.failedStepPath;
    this.causeCode = options.causeCode;
    this.result = options.result;
    this.outerLoopId = options.outerLoopId;
    this.lastCycleOutput = options.lastCycleOutput;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

class RuntimeCauseError extends Error {
  readonly causeCode: Extract<
    RunFailedCauseCode,
    "capability_drift" | "runtime_config_error" | "step_schema_error" | "max_visits_exceeded"
  >;

  constructor(
    name: string,
    causeCode: RuntimeCauseError["causeCode"],
    message: string,
  ) {
    super(message);
    this.name = name;
    this.causeCode = causeCode;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

class RuntimeCapabilityDriftError extends RuntimeCauseError {
  constructor(message: string) {
    super("CapabilityDriftError", "capability_drift", message);
  }
}

class RuntimeConfigError extends RuntimeCauseError {
  constructor(message: string) {
    super("RuntimeConfigError", "runtime_config_error", message);
  }
}

class RuntimeStepSchemaError extends RuntimeCauseError {
  constructor(message: string) {
    super("StepSchemaError", "step_schema_error", message);
  }
}

export class RuntimeMaxVisitsError extends RuntimeCauseError {
  readonly failedStepPath: string;
  constructor(message: string, failedStepPath: string) {
    super("MaxVisitsExceededError", "max_visits_exceeded", message);
    this.failedStepPath = failedStepPath;
  }
}

/**
 * Compute the step path for a step, appending a `.visit[N]` suffix when
 * `step.maxVisits > 1`. When `maxVisits === 1` (DAG default) the path is
 * unchanged so existing event logs remain compatible.
 *
 * @param step        - The LWIR step descriptor.
 * @param parentPath  - Prefix for the path: `""` for top-level steps,
 *                      `branchPath` for steps inside a parallel branch.
 * @param visitIndex  - 0-based visit counter for the current execution.
 */
export function stepPathFor(step: LwirStep, parentPath: string, visitIndex: number): string {
  const base = parentPath === "" ? step.id : `${parentPath}.${step.id}`;
  return (step.maxVisits ?? 1) > 1 ? `${base}.visit[${visitIndex}]` : base;
}

/**
 * Derive the current visit index for `(parentPath, step)` by counting
 * completed `.visit[N]` step paths in the materialized state. Returns 0
 * if no visits have been committed yet.
 */
export function visitIndexFor(
  step: LwirStep,
  parentPath: string,
  state: MaterializedRunState,
): number {
  if ((step.maxVisits ?? 1) <= 1) {
    return 0;
  }
  const prefix = parentPath === "" ? `${step.id}.visit[` : `${parentPath}.${step.id}.visit[`;
  let count = 0;
  for (const [stepPath, stepState] of Object.entries(state.steps)) {
    if (stepPath.startsWith(prefix) && stepState.status === "completed") {
      count += 1;
    }
  }
  return count;
}

function assertSingleWorkflow(
  workflow: WorkflowRunTarget,
): asserts workflow is RunnableWorkflowDefinition {
  if (Array.isArray(workflow)) {
    throw new Error("runWorkflow orchestration mode arrives after alpha.");
  }
  if (isRecord(workflow) && "workflows" in workflow) {
    throw new Error("runWorkflow only supports a single workflow in alpha.");
  }
}


async function appendCancelledRun(
  world: LocalWorld,
  runId: RunId,
  causeCode: "cancelled" | "timeout",
  workflowVersionId = "uncompiled",
  parentRunId?: RunId,
): Promise<FailedRunResult> {
  return appendRunWorkflowFailed(
    world,
    runId,
    causeCode,
    causeCode === "timeout" ? "Run timed out." : "Run was cancelled.",
    workflowVersionId,
    parentRunId,
  );
}

async function appendRunWorkflowFailed(
  world: LocalWorld,
  runId: RunId,
  causeCode: RunFailedCauseCode,
  message: string,
  workflowVersionId = "uncompiled",
  parentRunId?: RunId,
): Promise<FailedRunResult> {
  const existingTerminalFailure = await existingRunWorkflowTerminalFailure(world, runId);
  if (existingTerminalFailure !== undefined) {
    if (existingTerminalFailure.result !== undefined) {
      return existingTerminalFailure.result;
    }
    const terminalEvents = await world.listEvents(runId);
    return failedRunResultFromState(
      runId,
      materializeRunStateFromEvents(runId, terminalEvents),
      terminalEvents,
    );
  }
  const events = await world.listEvents(runId);
  const shouldAppendRunStarted = !hasRunStartedEvent(events);
  if (
    events.length > 0 &&
    !isPlanningOnlyRunLog(events) &&
    !isPartialPreRuntimeFailureLog(events, workflowVersionId)
  ) {
    throw new Error(`Run '${runId}' already has events and cannot record a pre-runtime failure.`);
  }
  if (shouldAppendRunStarted) {
    await world.appendEvent(runId, {
      type: "RunStarted",
      payload: stripUndefined({ workflowVersionId, parentRunId }),
    });
  }
  await world.appendEvent(runId, {
    type: "RunFailed",
    payload: {
      workflowVersionId,
      error: {
        name: errorNameForCauseCode(causeCode),
        message,
        causeCode,
        retriable: false,
      },
    },
  });
  const failedEvents = await world.listEvents(runId);
  return failedRunResultFromState(
    runId,
    materializeRunStateFromEvents(runId, failedEvents),
    failedEvents,
  );
}

function isPartialPreRuntimeFailureLog(
  events: readonly EventEnvelope[],
  workflowVersionId: string,
): boolean {
  const last = events.at(-1);
  return last?.type === "RunStarted" &&
    last.payload.workflowVersionId === workflowVersionId &&
    events.slice(0, -1).every(isPreRuntimeStartPrefixEvent);
}

function isPreRuntimeStartPrefixEvent(event: EventEnvelope): boolean {
  return isPlanningLifecycleEvent(event) || event.type === "WorkflowVersionRegistered";
}

function isPlanningOnlyRunLog(events: readonly EventEnvelope[]): boolean {
  return events.length > 0 && events.every(isPlanningLifecycleEvent);
}

function isPlanningLifecycleEvent(event: EventEnvelope): boolean {
  return event.type === "OrchestrationRequested" ||
    event.type === "PlannerStarted" ||
    event.type === "PlannerDraftedWorkflow" ||
    event.type === "WorkflowValidationFailed" ||
    event.type === "WorkflowValidationSucceeded" ||
    event.type === "PlannerReuseDecisionRecorded" ||
    event.type.startsWith("Harness") ||
    normalizeHarnessEventType(event.type).startsWith("harness.") ||
    isPlannerHarnessSessionEvent(event);
}

function isPlannerHarnessSessionEvent(event: EventEnvelope): boolean {
  const eventType = normalizeHarnessEventType(event.type);
  if (eventType === "harness.session.started") {
    return event.payload.role === "planner";
  }
  if (eventType === "harness.session.completed" || eventType === "harness.session.failed") {
    return true;
  }
  return false;
}

async function existingRunWorkflowTerminalFailure(
  world: LocalWorld,
  runId: RunId,
  input?: unknown,
  validateInput = false,
): Promise<RunFailedError | undefined> {
  const events = await world.listEvents(runId);
  if (events.length === 0) {
    return undefined;
  }
  const state = materializeRunStateFromEvents(runId, events);
  if (state.status === "failed" && !hasRunStartedEvent(events)) {
    throw new RuntimeIntegrityError(`Run '${runId}' is missing RunStarted.`);
  }
  const causeCode = terminalRunWorkflowCauseCode(state, events);
  if (causeCode === undefined) {
    return undefined;
  }
  if (validateInput) {
    assertRunInputMatches(events, input);
  }
  await assertFailedRunArtifactsValid(world, runId, state, events);
  return runFailedErrorFromRuntime(
    failedRunResultFromState(runId, state, events),
    events,
    causeCode,
  );
}

async function existingRunWorkflowTerminalCompletion(
  world: LocalWorld,
  runId: RunId,
  input: unknown,
  workflow: CompilableWorkflowDefinition,
): Promise<RunResult | undefined> {
  const events = await world.listEvents(runId);
  if (events.length === 0) {
    return undefined;
  }
  const state = materializeRunStateFromEvents(runId, events);
  if (state.status !== "completed") {
    return undefined;
  }
  assertRunInputPersistedAndMatches(events, input);
  const result = await completedRunResultFromState(world, runId, state, events);
  validateJsonSchema(authoredWorkflowOutputSchema(workflow), result.output, "Workflow output");
  return result;
}

function terminalRunWorkflowCauseCode(
  state: MaterializedRunState,
  events: readonly EventEnvelope[],
): RunFailedCauseCode | undefined {
  if (state.status !== "failed" || !isRecord(state.error)) {
    return undefined;
  }
  const causeCode = causeCodeFor(state.error);
  if (isRunFailedCauseCode((state.error as JsonRecord).causeCode)) {
    return causeCode;
  }
  const legacyCauseCode = legacyPreRuntimeTerminalCauseCode(state, events);
  if (legacyCauseCode !== undefined) {
    return legacyCauseCode;
  }
  if (
    events.some((event) => event.type === "RunFailed") &&
    events.some((event) => event.type === "StepFailed")
  ) {
    return "step_failed";
  }
  return undefined;
}

function authoredWorkflowOutputSchema(
  workflow: CompilableWorkflowDefinition,
): NormalizedSchemaDescriptor {
  const output = normalizeOutputMode(workflow.output ?? {
    kind: "object",
    schema: workflow.outputSchema ?? true,
  });
  return outputSchemaFromMode(output);
}

function outputSchemaFromMode(output: NormalizedOutputMode): NormalizedSchemaDescriptor {
  switch (output.kind) {
    case "text":
      return { type: "string" };
    case "object":
      return output.schema;
    case "array":
      return { type: "array", items: output.element };
    case "choice":
      return { type: "string", enum: [...output.values] };
    case "json":
      return output.schema ?? true;
  }
}

function legacyPreRuntimeTerminalCauseCode(
  state: MaterializedRunState,
  events: readonly EventEnvelope[],
): RunFailedCauseCode | undefined {
  if (
    state.workflowVersionId !== "uncompiled" ||
    events.some((event) => event.type === "StepFailed")
  ) {
    return undefined;
  }
  const runFailed = [...events].reverse().find((event) => event.type === "RunFailed");
  if (runFailed?.payload.workflowVersionId !== "uncompiled") {
    return undefined;
  }
  const error = isRecord(runFailed.payload.error) ? runFailed.payload.error : {};
  if (isRunFailedCauseCode(error.causeCode)) {
    return error.causeCode;
  }
  if (error.name === "AbortError") {
    return "cancelled";
  }
  if (error.name === "TimeoutError") {
    return "timeout";
  }
  return undefined;
}

function failedRunResultFromState(
  runId: RunId,
  state: MaterializedRunState,
  events: readonly EventEnvelope[],
): FailedRunResult {
  return {
    runId,
    workflowVersionId: state.workflowVersionId ?? "uncompiled",
    status: "failed",
    ...("output" in state ? { output: state.output } : {}),
    usage: state.usage,
    events,
    artifacts: state.artifacts,
  };
}

async function assertFailedRunArtifactsValid(
  world: LocalWorld,
  runId: RunId,
  state: MaterializedRunState,
  events: readonly EventEnvelope[],
): Promise<void> {
  for (const ref of uniqueRefs(state.artifacts)) {
    const artifact = await world.readArtifact(ref);
    if (artifact.manifest.runId !== runId) {
      throw new Error(`Artifact '${ref}' does not belong to run '${runId}'.`);
    }
  }
  await assertCompletedEventArtifactOwnershipValid(world, runId, events);
}

async function completedRunResultFromState(
  world: LocalWorld,
  runId: RunId,
  state: MaterializedRunState,
  events: readonly EventEnvelope[],
): Promise<RunResult> {
  await assertCompletedRunArtifactsValid(world, runId, state, events);
  return {
    runId,
    workflowVersionId: state.workflowVersionId ?? "uncompiled",
    status: "completed",
    output: "output" in state
      ? state.output
      : state.outputRef === undefined
        ? undefined
        : (await world.readArtifact(state.outputRef)).payload,
    usage: state.usage,
    events,
    artifacts: state.artifacts,
  };
}

async function assertCompletedRunArtifactsValid(
  world: LocalWorld,
  runId: RunId,
  state: MaterializedRunState,
  events: readonly EventEnvelope[],
): Promise<void> {
  if (state.outputRef === undefined) {
    throw new Error("Completed run is missing a final output artifact.");
  }
  const refs = uniqueRefs([state.outputRef, ...state.artifacts]);
  let outputPayload: unknown;
  for (const ref of refs) {
    const artifact = await world.readArtifact(ref);
    if (artifact.manifest.runId !== runId) {
      throw new Error(`Artifact '${ref}' does not belong to run '${runId}'.`);
    }
    if (ref === state.outputRef) {
      outputPayload = artifact.payload;
    }
  }
  if ("output" in state && sha256Digest(state.output) !== sha256Digest(outputPayload)) {
    throw new RuntimeIntegrityError("RunCompleted output does not match output artifact.");
  }
  assertRunOutputRefMatchesTerminalStep(state, events);
  await assertCompletedEventArtifactOwnershipValid(world, runId, events);
}

function assertRunOutputRefMatchesTerminalStep(
  state: MaterializedRunState,
  events: readonly EventEnvelope[],
): void {
  const terminalStepPath = runCompletedTerminalStepPath(events);
  if (terminalStepPath === undefined) {
    throw new RuntimeIntegrityError("Completed run is missing terminal step metadata.");
  }
  const terminalStepOutputRef = state.steps[terminalStepPath]?.outputRef;
  if (terminalStepOutputRef === undefined) {
    throw new RuntimeIntegrityError("Completed run is missing terminal step output artifact.");
  }
  if (state.outputRef !== terminalStepOutputRef) {
    throw new RuntimeIntegrityError(
      `Run outputRef '${state.outputRef}' does not match terminal step outputRef '${terminalStepOutputRef}'.`,
    );
  }
}

function runCompletedTerminalStepPath(
  events: readonly EventEnvelope[],
): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === "RunCompleted") {
      return stringProperty(event.payload, "terminalStepPath");
    }
  }
  return undefined;
}

async function assertCompletedEventArtifactOwnershipValid(
  world: LocalWorld,
  runId: RunId,
  events: readonly EventEnvelope[],
): Promise<void> {
  for (const event of events) {
    if (event.type === "ArtifactCreated") {
      const ref = artifactRefFromValue(event.payload.artifactRef);
      if (ref === undefined) {
        continue;
      }
      const artifact = await world.readArtifact(ref);
      if (artifact.manifest.runId !== runId) {
        throw new Error(`Artifact '${ref}' does not belong to run '${runId}'.`);
      }
      const stepPath = stringProperty(event.payload, "stepPath");
      if (stepPath !== undefined && artifact.manifest.stepPath !== stepPath) {
        throw new Error(`Artifact '${ref}' does not belong to step '${stepPath}'.`);
      }
      continue;
    }
    if (event.type !== "StepCompleted") {
      continue;
    }
    const stepPath = stringProperty(event.payload, "stepPath");
    if (stepPath === undefined) {
      continue;
    }
    const outputRef = artifactRefFromValue(event.payload.outputRef);
    const refs = uniqueRefs([
      ...(outputRef === undefined ? [] : [outputRef]),
      ...artifactRefsFromValue(event.payload.artifactRefs),
    ]);
    const attempt = numberProperty(event.payload, "attempt") ?? 1;
    const allowDescendantStepPaths = parallelGroupStartedFor(stepPath, attempt, events);
    await assertResultArtifactRefs(
      world,
      runId,
      stepPath,
      refs,
      allowDescendantStepPaths,
      true,
      attempt,
      scheduledBranchPathsFor(events, stepPath, attempt),
    );
    if (outputRef !== undefined && Object.hasOwn(event.payload, "output")) {
      const outputArtifact = await world.readArtifact(outputRef);
      if (sha256Digest(event.payload.output) !== sha256Digest(outputArtifact.payload)) {
        throw new RuntimeIntegrityError("StepCompleted output does not match output artifact.");
      }
    }
  }
}

function errorNameForCauseCode(causeCode: RunFailedCauseCode): string {
  switch (causeCode) {
    case "timeout":
      return "TimeoutError";
    case "cancelled":
      return "AbortError";
    case "input_schema_error":
      return "InputSchemaError";
    case "planner_validation_exhausted":
      return "ValidationError";
    case "capability_drift":
      return "CapabilityDriftError";
    case "runtime_config_error":
      return "RuntimeConfigError";
    case "step_schema_error":
      return "StepSchemaError";
    case "step_failed":
      return "StepFailedError";
    case "max_visits_exceeded":
      return "MaxVisitsExceededError";
    case "outer_loop_exhausted":
      return "OuterLoopExhaustedError";
  }
}

function runFailedErrorFromRuntime(
  result: FailedRunResult,
  events: readonly EventEnvelope[],
  causeCodeOverride?: RunFailedCauseCode,
): RunFailedError {
  const runFailed = [...events].reverse().find((event) => event.type === "RunFailed");
  const error = isRecord(runFailed?.payload.error) ? runFailed.payload.error : {};
  const causeCode = causeCodeOverride ?? causeCodeFor(error);
  // For max_visits_exceeded the failedStepPath is embedded in the RunFailed error envelope
  // (there is no StepFailed event for an overshoot — the visit was never started).
  let failedStepPath: string | undefined;
  if (causeCode === "max_visits_exceeded" && typeof error.failedStepPath === "string") {
    failedStepPath = error.failedStepPath;
  } else {
    const failedStep = failedStepPathAppliesToCause(causeCode)
      ? [...events].reverse().find((event) => event.type === "StepFailed")
      : undefined;
    failedStepPath = typeof failedStep?.payload.stepPath === "string"
      ? failedStep.payload.stepPath
      : undefined;
  }
  return new RunFailedError({
    runId: result.runId,
    workflowVersionId: result.workflowVersionId,
    failedStepPath,
    causeCode,
    message: typeof error.message === "string" ? error.message : undefined,
    result,
  });
}

function failedStepPathAppliesToCause(causeCode: RunFailedCauseCode): boolean {
  return causeCode !== "timeout" && causeCode !== "cancelled";
}

function failedStepPathForError(error: unknown): string | undefined {
  if (error instanceof RuntimeMaxVisitsError) {
    return error.failedStepPath;
  }
  return undefined;
}

function causeCodeFor(error: Record<string, unknown>): RunFailedCauseCode {
  if (isRunFailedCauseCode(error.causeCode)) {
    return error.causeCode;
  }
  return "step_failed";
}

function isRunFailedCauseCode(value: unknown): value is RunFailedCauseCode {
  return value === "input_schema_error" ||
    value === "planner_validation_exhausted" ||
    value === "capability_drift" ||
    value === "runtime_config_error" ||
    value === "step_schema_error" ||
    value === "step_failed" ||
    value === "max_visits_exceeded" ||
    value === "timeout" ||
    value === "cancelled" ||
    value === "outer_loop_exhausted";
}

async function wrapCompilerFailure<T>(
  runId: RunId,
  world: LocalWorld,
  promise: Promise<T>,
  parentRunId?: RunId,
): Promise<T> {
  try {
    return await promise;
  } catch (error) {
    if (error instanceof RunFailedError) {
      throw error;
    }
    if (error instanceof WorkflowInputValidationError) {
      const result = await appendRunWorkflowFailed(
        world,
        runId,
        "input_schema_error",
        error.message,
        "uncompiled",
        parentRunId,
      );
      throw runFailedErrorFromRuntime(result, result.events, "input_schema_error");
    }
    if (error instanceof WorkflowCompileError) {
      await appendWorkflowCompileFailureEvents(world, runId, error);
      const result = await appendRunWorkflowFailed(
        world,
        runId,
        "planner_validation_exhausted",
        error.message,
        "uncompiled",
        parentRunId,
      );
      throw runFailedErrorFromRuntime(result, result.events, "planner_validation_exhausted");
    }
    if (error instanceof WorkflowSchemaValidationError) {
      const message = error instanceof Error ? error.message : "Planner validation failed.";
      const result = await appendRunWorkflowFailed(
        world,
        runId,
        "planner_validation_exhausted",
        message,
        "uncompiled",
        parentRunId,
      );
      throw runFailedErrorFromRuntime(result, result.events, "planner_validation_exhausted");
    }
    if (error instanceof WorkflowMissingToolError) {
      const message = error instanceof Error ? error.message : "Tool not registered.";
      const result = await appendRunWorkflowFailed(
        world,
        runId,
        "runtime_config_error",
        message,
        "uncompiled",
        parentRunId,
      );
      throw runFailedErrorFromRuntime(result, result.events, "runtime_config_error");
    }
    throw error;
  }
}

type CancellationController = {
  readonly promise: Promise<never>;
  readonly signal: AbortSignal;
  dispose(): void;
};

class RunCancellationSignal extends Error {
  readonly causeCode: "cancelled" | "timeout";

  constructor(causeCode: "cancelled" | "timeout", message: string) {
    super(message);
    this.name = "RunCancellationSignal";
    this.causeCode = causeCode;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function cancellationControllerFor(
  timeoutMs: number | undefined,
  signal: AbortSignal | undefined,
): CancellationController {
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  const promise = new Promise<never>((_, reject) => {
    if (timeoutMs !== undefined) {
      timeoutId = setTimeout(() => {
        const runtimeError = new Error("Run timed out.");
        runtimeError.name = "TimeoutError";
        controller.abort(runtimeError);
        reject(new RunCancellationSignal("timeout", "Run timed out."));
      }, timeoutMs);
    }
    if (signal !== undefined) {
      abortListener = () => {
        const runtimeError = new Error("Run was cancelled.");
        runtimeError.name = "AbortError";
        controller.abort(runtimeError);
        reject(new RunCancellationSignal("cancelled", "Run was cancelled."));
      };
      signal.addEventListener("abort", abortListener, { once: true });
    }
  });
  return {
    promise,
    signal: controller.signal,
    dispose() {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
      if (abortListener !== undefined) {
        signal?.removeEventListener("abort", abortListener);
      }
    },
  };
}

async function raceCancellable<T>(
  runId: RunId,
  workflowVersionId: string,
  world: LocalWorld,
  promise: Promise<T>,
  cancellation: CancellationController,
  beforeCancel?: () => Promise<void>,
  parentRunId?: RunId,
): Promise<T> {
  try {
    return await Promise.race([promise, cancellation.promise]);
  } catch (error) {
    if (error instanceof RunCancellationSignal) {
      await beforeCancel?.();
      const result = await appendCancelledRun(
        world,
        runId,
        error.causeCode,
        workflowVersionId,
        parentRunId,
      );
      throw runFailedErrorFromRuntime(result, result.events, error.causeCode);
    }
    throw error;
  }
}

function timeoutMsFor(timeout: string | number | undefined): number | undefined {
  if (timeout === undefined) {
    return undefined;
  }
  if (typeof timeout === "number") {
    return timeout;
  }
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/u.exec(timeout.trim());
  if (match?.[1] === undefined) {
    throw new Error(`Invalid timeout '${timeout}'.`);
  }
  const value = Number(match[1]);
  const unit = match[2] ?? "ms";
  switch (unit) {
    case "ms":
      return value;
    case "s":
      return value * 1_000;
    case "m":
      return value * 60_000;
    case "h":
      return value * 3_600_000;
  }
}

function remainingTimeoutMs(timeoutMs: number | undefined, startedAt: number): number | undefined {
  if (timeoutMs === undefined) {
    return undefined;
  }
  return timeoutMs - (Date.now() - startedAt);
}

function isSignalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

async function executeWorkflowVersionUnlocked(
  options: ExecuteWorkflowVersionInternalOptions,
  runId: RunId,
): Promise<RuntimeRunResult> {
  const lockedWorkflowVersion = options.workflowVersion;
  assertLockedWorkflowVersion(lockedWorkflowVersion);
  assertNoNestedParallelSteps(lockedWorkflowVersion.lwir.steps);
  const workflowVersionId = lockedWorkflowVersion.id;
  await registerStoredWorkflowVersion(options.world, lockedWorkflowVersion);
  let events = await options.world.listEvents(runId);

  if (events.length === 0) {
    validateRunInputAgainstLwirSchema(lockedWorkflowVersion.lwir, options.input);
    assertWorkflowVersionInputMatches(
      lockedWorkflowVersion,
      options.input,
      options.workflowVersionReuse,
    );
    events = await appendRunStartEvents(options, runId, workflowVersionId);
  }

  let state = materializeRunStateFromEvents(runId, events);
  assertWorkflowVersionMatches(state, workflowVersionId, lockedWorkflowVersion.hash, events);
  if (state.status === "pending" && !hasRunStartedEvent(events)) {
    if (
      isRegisteredOnlyRunLog(
        events,
        workflowVersionRegisteredPayload(lockedWorkflowVersion, workflowVersionId),
      )
    ) {
      validateRunInputAgainstLwirSchema(lockedWorkflowVersion.lwir, options.input);
      const reuseDecision = plannerReuseUnchangedDecisionFor(events, workflowVersionId);
      if (reuseDecision === undefined) {
        assertWorkflowVersionInputMatches(
          lockedWorkflowVersion,
          options.input,
          options.workflowVersionReuse,
        );
      } else {
        assertPlannerReuseDecisionInputHashMatches(
          reuseDecision,
          sha256Digest(options.input),
        );
      }
      events = await appendRunStartedEvent(options, runId, workflowVersionId, events);
      state = materializeRunStateFromEvents(runId, events);
    } else {
      throw new RuntimeIntegrityError(`Run '${runId}' is missing RunStarted.`);
    }
  }
  assertRunInputMatches(events, options.input);
  assertParallelBranchFactsScheduledForWorkflow(options.workflowVersion.lwir, events);
  await assertCompletedStepArtifactsValid(
    options.world,
    options.workflowVersion.lwir,
    runId,
    state,
    events,
  );
  await assertCompletedParallelReplayMatchesInput(options, runId, workflowVersionId, state, events);
  const invocationStartEventCount = events.length;
  if (state.status === "completed") {
    assertWorkflowStepIdsSafe(options.workflowVersion.lwir.steps);
    const completedFinalStep = finalOutputStep(options.workflowVersion.lwir.steps);
    await assertRunOutputArtifactValid(options.world, runId, completedFinalStep?.id, state);
    return completedRunResult(
      options.world,
      options.workflowVersion.lwir,
      runId,
      workflowVersionId,
      state,
      events,
    );
  }
  if (state.status === "failed" && isTerminalCancellationEnvelope(state.error)) {
    return runResult(runId, workflowVersionId, state, events);
  }

  await assertCompletedStepArtifactsValid(
    options.world,
    options.workflowVersion.lwir,
    runId,
    state,
    events,
  );

  let runtimeState: RuntimeState = { events, materialized: state };
  let executedStep = false;

  try {
    assertNotCancelled(options.signal);
    assertWorkflowVersionExecutionCapabilitiesCompatible({
      ...options,
      workflowVersion: lockedWorkflowVersion,
    }, {
      strictWorkerHarnessPresence: events.some((event) =>
        event.type === "PlannerReuseDecisionRecorded"
      ),
    });
    assertWorkflowStepIdsSafe(options.workflowVersion.lwir.steps);
    const dagFinalStep = finalOutputStep(options.workflowVersion.lwir.steps);
    assertTerminalOutputContractCompatible(options.workflowVersion.lwir, dagFinalStep);
    const allSteps = options.workflowVersion.lwir.steps;
    // completedForNeeds tracks which steps have at least one completed visit (for needs resolution).
    const completedForNeeds = completedStepIds(allSteps, state);
    // remaining: steps that haven't started their first visit.
    const remaining = new Set(
      allSteps.map((step) => step.id).filter((stepId) => !completedForNeeds.has(stepId)),
    );

    // For replay: if a decision step committed a routing target that hasn't started its next
    // visit, prime the forced-next pointer so the scheduler resumes at the correct step.
    let forcedNextStepId: string | null = pendingDecisionTarget(allSteps, state, events);

    // When resuming from a pending decision, the downstream steps of the forced target may
    // already be in completedForNeeds (they ran in a prior iteration) and therefore absent
    // from `remaining`.  Re-add their transitive downstream steps so that the main loop can
    // continue scheduling after the forced step executes — mirroring the re-add done inside
    // the loop after a decision step runs (lines below that call transitiveDownstreamOf).
    if (forcedNextStepId !== null) {
      for (const stepId of transitiveDownstreamOf(allSteps, forcedNextStepId)) {
        remaining.add(stepId);
      }
    }

    // Track the most-recently-executed non-decision step path so we can determine the
    // final output when the workflow terminates via to:"end".
    let lastNonDecisionStepPath: string | undefined;
    // Initialise lastNonDecisionStepPath from already-committed state for replay.
    for (const [stepPath, stepState] of Object.entries(state.steps)) {
      if (stepState.status === "completed") {
        const stepId = stepState.stepPath.split(".")[0];
        const lwirStep = allSteps.find((s) => s.id === stepId);
        if (lwirStep !== undefined && lwirStep.uses !== "decision") {
          lastNonDecisionStepPath = stepPath;
        }
      }
    }

    mainLoop: while (true) {
      assertNotCancelled(options.signal);
      let nextStep: LwirStep | undefined;

      if (forcedNextStepId !== null) {
        // Decision routing: run the forced target step next.
        nextStep = allSteps.find((s) => s.id === forcedNextStepId);
        if (nextStep === undefined) {
          throw new Error(
            `Decision target '${forcedNextStepId}' not found in workflow steps.`,
          );
        }
        forcedNextStepId = null;
        // Remove from remaining — for back-edge loops, transitiveDownstreamOf will re-add
        // the forced step's downstream dependents (including the forced step itself if it
        // is downstream of itself via a cycle, but not the forced step directly).
        remaining.delete(nextStep.id);
      } else {
        // Needs-based scheduling: find a step whose needs are all satisfied.
        // Exclude decision targets whose controlling decision step is currently runnable —
        // they must wait until the decision routes to them via forcedNextStepId.
        const decisionTargets = activeDecisionTargetIds(allSteps, completedForNeeds);
        nextStep = allSteps.find((step) => {
          if (!remaining.has(step.id)) {
            return false;
          }
          if (decisionTargets.has(step.id)) {
            return false; // wait for the decision step to route to this target
          }
          return (step.needs ?? []).every((need) => completedForNeeds.has(need));
        });
        if (nextStep === undefined) {
          if (remaining.size > 0) {
            throw new Error(
              "No runnable LWIR step found; dependencies are incomplete or cyclic.",
            );
          }
          break mainLoop;
        }
        remaining.delete(nextStep.id);
      }

      // Compute the step path before execution (needed to look up decision output after).
      const visitIndexBefore = visitIndexFor(nextStep, "", runtimeState.materialized);
      const executingStepPath = stepPathFor(nextStep, "", visitIndexBefore);

      runtimeState = await executeStep(
        options,
        runId,
        workflowVersionId,
        nextStep,
        dagFinalStep?.id,
        runtimeState,
      );
      state = runtimeState.materialized;
      assertNotCancelled(options.signal);
      executedStep = true;

      if (nextStep.uses === "decision") {
        // Read the decision's chosen target from the committed output.
        const decisionState = state.steps[executingStepPath];
        const decisionOutput = decisionState !== undefined
          ? await outputValueForCompletedStep(options.world, decisionState)
          : undefined;
        const chosen = isRecord(decisionOutput) && typeof decisionOutput.chosen === "string"
          ? decisionOutput.chosen
          : undefined;
        if (chosen === undefined) {
          throw new Error(
            `Decision step '${nextStep.id}' did not produce a valid chosen target.`,
          );
        }
        // Remove all unchosen decision targets from remaining so they are excluded from
        // subsequent needs-based scheduling (only the chosen branch runs).
        const decisionCfg = nextStep.with as {
          cases?: ReadonlyArray<{ when: string; to: string }>;
          default: string;
        };
        const allDecisionTargets = new Set([
          ...(decisionCfg.cases ?? []).map((c) => c.to),
          decisionCfg.default,
        ]);
        for (const target of allDecisionTargets) {
          if (target !== chosen && target !== "end") {
            remaining.delete(target);
          }
        }
        if (chosen === "end") {
          break mainLoop;
        }
        forcedNextStepId = chosen;
        // For back-edge loops: re-add the transitive downstream steps of the chosen
        // target to the scheduling pool so they run again after the forced step.
        for (const stepId of transitiveDownstreamOf(allSteps, chosen)) {
          remaining.add(stepId);
        }
      } else {
        // Mark as completed for needs-satisfaction tracking.
        completedForNeeds.add(nextStep.id);
        lastNonDecisionStepPath = executingStepPath;
      }
    }

    // Determine the final output step. If the workflow terminated via a decision to:"end",
    // the last committed non-decision step is the output source.
    const terminalStepPath =
      dagFinalStep !== undefined ? finalStepPathFor(dagFinalStep, state) : lastNonDecisionStepPath;
    const finalState =
      terminalStepPath !== undefined ? state.steps[terminalStepPath] : undefined;
    const finalOutputRef = finalState?.outputRef;

    if (finalState === undefined || finalOutputRef === undefined) {
      throw new Error("Completed run is missing a final output artifact.");
    }
    const finalOutput = await outputValueForCompletedStep(options.world, finalState);
    validateWorkflowOutput(options.workflowVersion.lwir, finalOutput);
    assertNotCancelled(options.signal);

    if (executedStep || state.status !== "completed") {
      runtimeState = await record(runtimeState, options.world, runId, {
        type: "RunCompleted",
        payload: {
          workflowVersionId,
          output: finalOutput,
          outputRef: finalOutputRef,
          terminalStepPath: finalState.stepPath,
        },
      });
      state = runtimeState.materialized;
    }

    return runResult(runId, workflowVersionId, state, runtimeState.events);
  } catch (error) {
    if (isReplayIntegrityError(error)) {
      throw error;
    }
    runtimeState = await loadRuntimeState(options.world, runId);
    if (
      runtimeState.materialized.status === "failed" &&
      runtimeState.events.length === invocationStartEventCount
    ) {
      return runResult(runId, workflowVersionId, runtimeState.materialized, runtimeState.events);
    }
    runtimeState = await record(runtimeState, options.world, runId, {
      type: "RunFailed",
      payload: { workflowVersionId, error: errorEnvelope(error, false) },
    });
    return runResult(runId, workflowVersionId, runtimeState.materialized, runtimeState.events);
  }
}

function assertWorkflowVersionInputMatches(
  workflowVersion: LockedRuntimeWorkflowVersion,
  input: unknown,
  policy: WorkflowVersionReusePolicy | undefined,
): void {
  if (workflowVersion.lock.inputBinding !== "required") {
    return;
  }
  try {
    assertWorkflowVersionInputCompatible({
      policy: policy ?? "exact",
      plannedInputHash: workflowVersion.lock.inputHash,
      plannedInputStructure: workflowVersion.lock.plannedInputStructure,
      plannedInputStructureHash: workflowVersion.lock.plannedInputStructureHash,
      runInput: input,
      adaptiveArrayPaths: adaptiveArrayPathsForWorkflow(workflowVersion.lwir),
    });
  } catch (error) {
    const message = error instanceof Error
      ? error.message
      : "WorkflowVersion planned input does not match run input.";
    if (message === "WorkflowVersion planned input hash does not match run input.") {
      throw new RuntimeIntegrityError("WorkflowVersion inputHash does not match run input.");
    }
    throw new RuntimeIntegrityError(message);
  }
}

function assertWorkflowVersionExecutionCapabilitiesCompatible(
  options: ExecuteWorkflowVersionOptions & { readonly workflowVersion: LockedRuntimeWorkflowVersion },
  context: { readonly strictWorkerHarnessPresence?: boolean } = {},
): void {
  const strictWorkerHarnessPresence = context.strictWorkerHarnessPresence === true;
  if (!strictWorkerHarnessPresence) {
    return;
  }
  const lwir = options.workflowVersion.lwir;
  const capabilityManifest = propertyValue(options.workflowVersion.lock, "capabilityManifest");
  const priorWorkerHarnessId = stringProperty(
    propertyValue(capabilityManifest, "workerHarness"),
    "harnessId",
  );
  const currentWorkerHarnessId = options.workerHarness === undefined
    ? undefined
    : harnessIdFor(options.workerHarness);
  const requiresWorkerHarness =
    workflowUsesStepType(lwir, "ai.generate") || workflowUsesStepType(lwir, "code.run");
  const usesToolCall = workflowUsesStepType(lwir, "tool.call");
  const usesWorkerHarnessStep = requiresWorkerHarness || usesToolCall;
  if (usesWorkerHarnessStep) {
    if (
      (
        (strictWorkerHarnessPresence && requiresWorkerHarness) ||
        priorWorkerHarnessId !== undefined
      ) &&
      currentWorkerHarnessId === undefined
    ) {
      throw new RuntimeCapabilityDriftError(
        "capability_drift: worker harness unavailable for locked WorkflowVersion. Re-run runWorkflow() to compile a fresh WorkflowVersion against the current capability set.",
      );
    }
    const shouldCompareWorkerHarness =
      priorWorkerHarnessId !== undefined ||
      (strictWorkerHarnessPresence && currentWorkerHarnessId !== undefined);
    if (
      shouldCompareWorkerHarness &&
      priorWorkerHarnessId !== currentWorkerHarnessId
    ) {
      throw new RuntimeCapabilityDriftError(
        "capability_drift: worker harness changed for locked WorkflowVersion. Re-run runWorkflow() to compile a fresh WorkflowVersion against the current capability set.",
      );
    }
  }

  const usesBashBackedWorkerStep = requiresWorkerHarness ||
    (usesToolCall && (priorWorkerHarnessId !== undefined || currentWorkerHarnessId !== undefined));
  if (!usesBashBackedWorkerStep) {
    return;
  }
  const priorBash = propertyValue(capabilityManifest, "bash");
  const currentBash = normalizeBashCapabilities(options.bashCapabilities);
  if (priorBash !== undefined && canonicalJson(priorBash) !== canonicalJson(currentBash)) {
    throw new RuntimeCapabilityDriftError(
      "capability_drift: bash capability changed for locked WorkflowVersion. Re-run runWorkflow() to compile a fresh WorkflowVersion against the current capability set.",
    );
  }
}

function adaptiveArrayPathsForWorkflow(workflow: LwirWorkflow): readonly AdaptiveArrayPath[] {
  const paths: AdaptiveArrayPath[] = [];
  collectAdaptiveArrayPaths(workflow.steps, paths);
  return paths;
}

function collectAdaptiveArrayPaths(
  steps: readonly LwirStep[],
  paths: AdaptiveArrayPath[],
): void {
  for (const step of steps) {
    if (step.uses === "parallel") {
      const config = configFor(step);
      const cardinality = propertyValue(config, "cardinality");
      const path = typeof config.items === "string"
        ? simpleInputPathExpression(config.items)
        : undefined;
      if (
        path !== undefined &&
        isRecord(cardinality) &&
        cardinality.kind === "matches_items" &&
        typeof config.maxBranches === "number" &&
        Number.isInteger(config.maxBranches)
      ) {
        paths.push({ path, maxBranches: config.maxBranches });
      }
    }
    collectAdaptiveArrayPaths(step.steps ?? [], paths);
  }
}

function simpleInputPathExpression(value: string): readonly string[] | undefined {
  const match = /^\s*\{\{\s*input((?:\.[A-Za-z_$][\w$-]*)+)\s*\}\}\s*$/u.exec(value);
  const suffix = match?.[1];
  if (suffix === undefined) {
    return undefined;
  }
  return suffix.slice(1).split(".");
}

async function withRunExecutionFence<T>(
  world: LocalWorld,
  runId: RunId,
  fn: () => Promise<T>,
): Promise<T> {
  const key = `${await canonicalWorldDataDir(world.dataDir)}:${runId}`;
  if (activeRunExecutions.has(key)) {
    throw new Error(`Run '${runId}' is already executing in this process.`);
  }
  activeRunExecutions.add(key);
  let releaseLock: (() => Promise<void>) | undefined;
  try {
    releaseLock = await acquireRunExecutionLock(world, runId);
    return await fn();
  } finally {
    try {
      if (releaseLock !== undefined) {
        await releaseLock();
      }
    } finally {
      activeRunExecutions.delete(key);
    }
  }
}

async function acquireRunExecutionLock(
  world: LocalWorld,
  runId: RunId,
): Promise<() => Promise<void>> {
  const locksDir = resolvePath(world.dataDir, "locks");
  const lockName = runExecutionLockName(runId);
  const lockDir = resolvePath(locksDir, lockName);
  const ownerToken = randomUUID();
  await mkdir(locksDir, { recursive: true });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await mkdir(lockDir);
      await writeRunExecutionLockOwner(lockDir, ownerToken);
      return async () => {
        if (await runExecutionLockOwnerMatches(lockDir, ownerToken)) {
          await removeDirRetrySafe(lockDir);
        }
      };
    } catch (error) {
      if (!isErrno(error, "EEXIST")) {
        throw error;
      }
      const releaseRecoveryLock = await acquireRunExecutionRecoveryLock(
        locksDir,
        lockName,
        ownerToken,
        runId,
      );
      try {
        const lockSnapshot = await readRunExecutionLockSnapshot(lockDir);
        if (!(await isRunExecutionLockStale(lockDir, lockSnapshot))) {
          throw new Error(`Run '${runId}' is already executing.`);
        }
        const claimedDir = resolvePath(locksDir, `${lockName}.${ownerToken}.${attempt}.stale`);
        try {
          await rename(lockDir, claimedDir);
        } catch (claimError) {
          await removeDirRetrySafe(claimedDir);
          if (isErrno(claimError, "ENOENT")) {
            continue;
          }
          throw claimError;
        }
        if (!(await runExecutionLockSnapshotMatches(claimedDir, lockSnapshot))) {
          await restoreClaimedRunExecutionLock(claimedDir, lockDir);
          throw new Error(`Run '${runId}' is already executing.`);
        }
        await removeDirRetrySafe(claimedDir);
      } finally {
        await releaseRecoveryLock();
      }
    }
  }
  throw new Error(`Run '${runId}' is already executing.`);
}

async function acquireRunExecutionRecoveryLock(
  locksDir: string,
  lockName: string,
  ownerToken: string,
  runId: RunId,
): Promise<() => Promise<void>> {
  const recoveryDir = resolvePath(locksDir, `${lockName}.recovering`);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await mkdir(recoveryDir);
      await writeRunExecutionLockOwner(recoveryDir, ownerToken);
      return async () => {
        if (await runExecutionLockOwnerMatches(recoveryDir, ownerToken)) {
          await removeDirRetrySafe(recoveryDir);
        }
      };
    } catch (error) {
      if (!isErrno(error, "EEXIST")) {
        throw error;
      }
      const lockSnapshot = await readRunExecutionLockSnapshot(recoveryDir);
      if (!(await isRunExecutionLockStale(recoveryDir, lockSnapshot))) {
        throw new Error(`Run '${runId}' is already executing.`);
      }
      const claimedDir = resolvePath(
        locksDir,
        `${lockName}.${ownerToken}.${attempt}.recovering.stale`,
      );
      try {
        await rename(recoveryDir, claimedDir);
      } catch (claimError) {
        await removeDirRetrySafe(claimedDir);
        if (isErrno(claimError, "ENOENT")) {
          continue;
        }
        throw claimError;
      }
      if (!(await runExecutionLockSnapshotMatches(claimedDir, lockSnapshot))) {
        await restoreClaimedRunExecutionLock(claimedDir, recoveryDir);
        throw new Error(`Run '${runId}' is already executing.`);
      }
      await removeDirRetrySafe(claimedDir);
    }
  }
  throw new Error(`Run '${runId}' is already executing.`);
}

async function writeRunExecutionLockOwner(lockDir: string, ownerToken: string): Promise<void> {
  await writeFile(
    resolvePath(lockDir, "owner.json"),
    canonicalJson({ pid: process.pid, token: ownerToken, createdAt: new Date().toISOString() }),
    "utf8",
  );
}

async function readRunExecutionLockOwnerSnapshot(lockDir: string): Promise<string | undefined> {
  try {
    return await readFile(resolvePath(lockDir, "owner.json"), "utf8");
  } catch {
    return undefined;
  }
}

type RunExecutionLockSnapshot = {
  readonly owner: string | undefined;
  readonly dev: number;
  readonly ino: number;
  readonly mtimeMs: number;
};

async function readRunExecutionLockSnapshot(
  lockDir: string,
): Promise<RunExecutionLockSnapshot | undefined> {
  try {
    const lockStats = await stat(lockDir);
    return {
      owner: await readRunExecutionLockOwnerSnapshot(lockDir),
      dev: lockStats.dev,
      ino: lockStats.ino,
      mtimeMs: lockStats.mtimeMs,
    };
  } catch {
    return undefined;
  }
}

async function isRunExecutionLockStale(
  lockDir: string,
  snapshot?: RunExecutionLockSnapshot,
): Promise<boolean> {
  snapshot ??= await readRunExecutionLockSnapshot(lockDir);
  let owner: unknown;
  if (snapshot === undefined) {
    return false;
  }
  if (snapshot.owner === undefined) {
    return Date.now() - snapshot.mtimeMs > LOCK_OWNER_GRACE_MS;
  }
  try {
    owner = JSON.parse(snapshot.owner);
  } catch {
    return true;
  }
  if (!isRecord(owner) || !Number.isInteger(owner.pid) || (owner.pid as number) <= 0) {
    return true;
  }
  return !isProcessRunning(owner.pid as number);
}

async function runExecutionLockOwnerMatches(
  lockDir: string,
  ownerToken: string,
): Promise<boolean> {
  try {
    const owner = JSON.parse(await readFile(resolvePath(lockDir, "owner.json"), "utf8"));
    return isRecord(owner) && owner.token === ownerToken;
  } catch {
    return false;
  }
}

async function runExecutionLockSnapshotMatches(
  lockDir: string,
  expected: RunExecutionLockSnapshot | undefined,
): Promise<boolean> {
  const actual = await readRunExecutionLockSnapshot(lockDir);
  return actual !== undefined &&
    expected !== undefined &&
    actual.dev === expected.dev &&
    actual.ino === expected.ino &&
    actual.mtimeMs === expected.mtimeMs &&
    actual.owner === expected.owner;
}

async function restoreClaimedRunExecutionLock(
  claimedDir: string,
  lockDir: string,
): Promise<void> {
  try {
    await rename(claimedDir, lockDir);
  } catch (error) {
    if (!isErrno(error, "ENOENT")) {
      throw error;
    }
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isErrno(error, "ESRCH") || isErrno(error, "EINVAL")) {
      return false;
    }
    return true;
  }
}

function runExecutionLockName(runId: RunId): string {
  return sha256Digest(runId).replace(/[^A-Za-z0-9_-]/gu, "_");
}

async function canonicalWorldDataDir(dataDir: string): Promise<string> {
  try {
    return await realpath(dataDir);
  } catch {
    return canonicalMissingPath(dataDir);
  }
}

async function canonicalMissingPath(path: string): Promise<string> {
  const absolute = resolvePath(path);
  const missingSegments: string[] = [];
  let current = absolute;
  while (!(await pathExists(current))) {
    missingSegments.unshift(basename(current));
    const parent = dirname(current);
    if (parent === current) {
      return absolute;
    }
    current = parent;
  }
  return resolvePath(await realpath(current), ...missingSegments);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return isRecord(error) && error.code === code;
}

function assertLockedWorkflowVersion(
  workflowVersion: ExecuteWorkflowVersionOptions["workflowVersion"],
): asserts workflowVersion is LockedRuntimeWorkflowVersion {
  if (
    typeof (workflowVersion as Partial<WorkflowVersion>).hash !== "string" ||
    !isRecord((workflowVersion as { readonly lock?: unknown }).lock)
  ) {
    throw new Error(
      "executeWorkflowVersion requires a locked WorkflowVersion with hash and capability locks.",
    );
  }
  assertWorkflowVersionLockConsistent(workflowVersion as LockedRuntimeWorkflowVersion);
}

async function appendRunStartEvents(
  options: ExecuteWorkflowVersionOptions,
  runId: RunId,
  workflowVersionId: string,
): Promise<readonly EventEnvelope[]> {
  let runtimeState = emptyRuntimeState(runId);
  runtimeState = await record(runtimeState, options.world, runId, {
    type: "WorkflowVersionRegistered",
    payload: workflowVersionRegisteredPayload(options.workflowVersion, workflowVersionId),
  });
  runtimeState = await record(runtimeState, options.world, runId, {
    type: "RunStarted",
    payload: stripUndefined({
      workflowVersionId,
      input: options.input,
      parentRunId: options.parentRunId,
      outerLoopId: options.outerLoopId,
    }),
  });
  return runtimeState.events;
}

function validateRunInputAgainstWorkflowSchema(
  workflow: CompilableWorkflowDefinition,
  input: unknown,
): void {
  validateRunInputAgainstSchema(workflow.inputSchema ?? true, input);
}

function validateRunInputAgainstLwirSchema(
  workflow: LwirWorkflow,
  input: unknown,
): void {
  const schema = isRecord(workflow.input) && Object.hasOwn(workflow.input, "schema")
    ? workflow.input.schema
    : true;
  validateRunInputAgainstSchema(schema, input);
}

function validateRunInputAgainstSchema(schemaLike: unknown, input: unknown): void {
  const schema = normalizeSchema(schemaLike);
  try {
    validateJsonSchema(schema, input, "Workflow input");
  } catch (error) {
    if (error instanceof RuntimeStepSchemaError) {
      throw new WorkflowInputValidationError(error.message);
    }
    throw error;
  }
}

function errorMessageFromRuntimeResult(result: RuntimeFailedRunResult): string {
  const error = isRecord(result.error) ? result.error : undefined;
  if (typeof error?.message === "string") {
    return error.message;
  }
  if (typeof result.error === "string") {
    return result.error;
  }
  return "Workflow run failed.";
}

async function appendCompiledWorkflowStartEvents(
  options: { readonly world: LocalWorld; readonly input: unknown; readonly parentRunId?: RunId },
  runId: RunId,
  compiled: WorkflowCompileResult,
  outerLoopId?: string,
  plannerReuseDecisionEvent?: EventInput,
  label?: string,
  tags?: readonly string[],
): Promise<void> {
  const expectedEvents = [
    ...compilerLifecycleEvents(compiled.request, compiled.revisions, compiled),
    ...(plannerReuseDecisionEvent === undefined ? [] : [plannerReuseDecisionEvent]),
    {
      type: "WorkflowVersionRegistered",
      payload: workflowVersionRegisteredPayload(
        compiled.workflowVersion,
        compiled.workflowVersion.id,
      ),
    },
    {
      type: "RunStarted",
      payload: stripUndefined({
        workflowVersionId: compiled.workflowVersion.id,
        input: options.input,
        parentRunId: options.parentRunId,
        outerLoopId,
        label,
        tags,
      }),
    },
  ] satisfies readonly EventInput[];
  await appendEventPrefix(options.world, runId, expectedEvents);
}

function workflowVersionRegisteredPayload(
  workflowVersion: ExecuteWorkflowVersionOptions["workflowVersion"],
  workflowVersionId: string,
): JsonRecord {
  const lockValue = propertyValue(workflowVersion, "lock");
  const lock = isRecord(lockValue) ? workflowVersionLockEnvelope(lockValue) : undefined;
  return stripUndefined({
    workflowVersionId,
    workflowVersionHash: stringProperty(workflowVersion, "hash") ?? lock?.workflowVersionHash,
    lwirVersionId: stringProperty(workflowVersion, "lwirVersionId") ?? lock?.lwirVersionId,
    lwirHash: stringProperty(workflowVersion, "lwirHash") ?? lock?.lwirHash,
    requestId: lock?.requestId,
    requestHash: lock?.requestHash,
    inputHash: lock?.inputHash,
    plannedInputStructure: lock?.plannedInputStructure,
    plannedInputStructureHash: lock?.plannedInputStructureHash,
    workflowDefinitionHash: lock?.workflowDefinitionHash,
    inputSchemaHash: lock?.inputSchemaHash,
    requestedOutputHash: lock?.requestedOutputHash,
    capabilityManifestHash: lock?.capabilityManifestHash,
    planningDefinitionSnapshotHash: lock?.planningDefinitionSnapshotHash,
    validationHash: lock?.validationHash,
  });
}

async function appendWorkflowCompileFailureEvents(
  world: LocalWorld,
  runId: RunId,
  error: WorkflowCompileError,
): Promise<void> {
  await appendEventPrefix(
    world,
    runId,
    compilerLifecycleEvents(error.request, error.revisions),
  );
}

async function appendCompilerLifecycleEvent(
  world: LocalWorld,
  runId: RunId,
  event: CompilerLifecycleEvent,
): Promise<void> {
  if (event.type === "OrchestrationRequested") {
    await appendEventPrefix(world, runId, [
      compilerLifecycleEventInput(event),
      compilerLifecycleEventInput({
        type: "PlannerStarted",
        request: event.request,
        revision: 1,
      }),
    ]);
    return;
  }
  const input = compilerLifecycleEventInput(event);
  const existingEvents = await world.listEvents(runId);
  if (existingEvents.some((existing) => eventMatchesInput(existing, input))) {
    return;
  }
  if (hasRunStartedEvent(existingEvents) || isRegisteredOnlyRunLog(existingEvents)) {
    return;
  }
  await world.appendEvent(runId, input);
}

function compilerLifecycleRecorderFor(
  world: LocalWorld,
  runId: RunId,
): {
  readonly record: (event: CompilerLifecycleEvent) => Promise<void>;
  readonly flush: () => Promise<void>;
} {
  let chain: Promise<void> = Promise.resolve();
  return {
    record(event) {
      chain = chain.then(() => appendCompilerLifecycleEvent(world, runId, event));
      return chain;
    },
    flush() {
      return chain;
    },
  };
}

async function appendEventPrefix(
  world: LocalWorld,
  runId: RunId,
  expectedEvents: readonly EventInput[],
): Promise<void> {
  const existingEvents = await world.listEvents(runId);
  if (existingEvents.length === 0) {
    let runtimeState = emptyRuntimeState(runId);
    for (const event of expectedEvents) {
      runtimeState = await record(runtimeState, world, runId, event);
    }
    return;
  }
  const expectedRegistration = expectedEvents
    .find((event) => event.type === "WorkflowVersionRegistered")
    ?.payload as JsonRecord | undefined;
  if (
    hasRunStartedEvent(existingEvents) ||
    isRegisteredOnlyRunLog(existingEvents, expectedRegistration)
  ) {
    return;
  }
  if (existingEvents.every(isPlanningLifecycleEvent)) {
    let runtimeState: RuntimeState = {
      events: existingEvents,
      materialized: materializeRunStateFromEvents(runId, existingEvents),
    };
    for (const expected of expectedEvents) {
      const exists = runtimeState.events.some((event) => eventMatchesInput(event, expected));
      if (!exists) {
        runtimeState = await record(runtimeState, world, runId, expected);
      }
    }
    return;
  }
  if (
    existingEvents.length > expectedEvents.length ||
    !existingEvents.every((event, index) => eventMatchesInput(event, expectedEvents[index]))
  ) {
    return;
  }

  let runtimeState: RuntimeState = {
    events: existingEvents,
    materialized: materializeRunStateFromEvents(runId, existingEvents),
  };
  for (const event of expectedEvents.slice(existingEvents.length)) {
    runtimeState = await record(runtimeState, world, runId, event);
  }
}

function eventMatchesInput(event: EventEnvelope, expected: EventInput | undefined): boolean {
  if (expected === undefined || event.type !== expected.type) {
    return false;
  }
  if (canonicalJson(event.payload) === canonicalJson(expected.payload)) {
    return true;
  }
  return event.type === "WorkflowVersionRegistered" &&
    workflowVersionRegisteredPayloadMatches(event.payload, expected.payload);
}

function workflowVersionRegisteredPayloadMatches(
  actual: JsonRecord,
  expected: JsonRecord,
): boolean {
  if (
    typeof actual.workflowVersionId !== "string" ||
    actual.workflowVersionId !== expected.workflowVersionId ||
    typeof actual.workflowVersionHash !== "string" ||
    actual.workflowVersionHash !== expected.workflowVersionHash
  ) {
    return false;
  }
  for (const [key, value] of Object.entries(actual)) {
    if (!Object.hasOwn(expected, key)) {
      return false;
    }
    if (canonicalJson(value) !== canonicalJson(expected[key])) {
      return false;
    }
  }
  return true;
}

function compilerLifecycleEvents(
  request: OrchestrationRequest,
  revisions: readonly CompilerRevision[],
  compiled?: WorkflowCompileResult,
): readonly EventInput[] {
  const events: EventInput[] = [compilerLifecycleEventInput({
    type: "OrchestrationRequested",
    request,
  })];

  for (const revision of revisions) {
    events.push(compilerLifecycleEventInput({
      type: "PlannerStarted",
      request,
      revision: revision.revision,
    }));
    events.push(compilerLifecycleEventInput({
      type: "PlannerDraftedWorkflow",
      request,
      revision,
    }));
    if (revision.valid) {
      events.push(compilerLifecycleEventInput({
        type: "WorkflowValidationSucceeded",
        request,
        revision,
        workflowVersion: compiled?.workflowVersion,
      } as CompilerLifecycleEvent));
    } else {
      events.push(compilerLifecycleEventInput({
        type: "WorkflowValidationFailed",
        request,
        revision,
      }));
    }
  }
  return events;
}

function compilerLifecycleEventInput(event: CompilerLifecycleEvent): EventInput {
  switch (event.type) {
    case "OrchestrationRequested":
      return {
        type: "OrchestrationRequested",
        payload: stripUndefined({
          requestId: event.request.requestId,
          requestHash: event.request.locks.requestHash,
          inputHash: event.request.locks.inputHash,
          plannedInputStructure: event.request.locks.plannedInputStructure,
          plannedInputStructureHash: event.request.locks.plannedInputStructureHash,
          workflowDefinitionHash: event.request.locks.workflowDefinitionHash,
          inputSchemaHash: event.request.locks.inputSchemaHash,
          requestedOutputHash: event.request.locks.requestedOutputHash,
          capabilityManifestHash: sha256Digest(event.request.capabilityManifest),
          workflowId: event.request.metadata.name,
          description: event.request.metadata.description,
          maxWorkflowRevisions: event.request.controls.maxWorkflowRevisions,
        }),
      };
    case "PlannerStarted":
      return {
        type: "PlannerStarted",
        payload: {
          requestId: event.request.requestId,
          revision: event.revision,
          repair: event.revision > 1,
        },
      };
    case "PlannerDraftedWorkflow": {
      return {
        type: "PlannerDraftedWorkflow",
        payload: {
          requestId: event.request.requestId,
          revision: event.revision.revision,
          valid: event.revision.valid,
          lwirHash: sha256Digest(event.revision.lwir),
          lwir: event.revision.lwir,
        },
      };
    }
    case "WorkflowValidationFailed":
      return {
        type: "WorkflowValidationFailed",
        payload: {
          requestId: event.request.requestId,
          revision: event.revision.revision,
          findings: event.revision.findings,
        },
      };
    case "WorkflowValidationSucceeded":
      return {
        type: "WorkflowValidationSucceeded",
        payload: stripUndefined({
          requestId: event.request.requestId,
          revision: event.revision.revision,
          lwirHash: sha256Digest(event.revision.lwir),
          workflowVersionId: event.workflowVersion.id,
          lwirVersionId: event.workflowVersion.lwirVersionId,
          validationHash: event.workflowVersion.lock.validationHash,
        }),
      };
  }
}

async function appendRunStartedEvent(
  options: ExecuteWorkflowVersionOptions,
  runId: RunId,
  workflowVersionId: string,
  events: readonly EventEnvelope[],
): Promise<readonly EventEnvelope[]> {
  const runtimeState = await record(
    {
      events,
      materialized: materializeRunStateFromEvents(runId, events),
    },
    options.world,
    runId,
    {
      type: "RunStarted",
      payload: stripUndefined({
        workflowVersionId,
        input: options.input,
        parentRunId: options.parentRunId,
        outerLoopId: options.outerLoopId,
      }),
    },
  );
  return runtimeState.events;
}

function hasRunStartedEvent(events: readonly EventEnvelope[]): boolean {
  return events.some((event) => event.type === "RunStarted");
}

function isRegisteredOnlyRunLog(
  events: readonly EventEnvelope[],
  expectedRegistrationPayload?: JsonRecord,
): boolean {
  const registrationEvents = events.filter((event) => event.type === "WorkflowVersionRegistered");
  if (registrationEvents.length === 0) {
    return false;
  }
  if (!events.every((event) =>
    event.type === "WorkflowVersionRegistered" || isPlanningLifecycleEvent(event)
  )) {
    return false;
  }
  if (expectedRegistrationPayload === undefined) {
    return registrationEvents.every((event) => isMinimalWorkflowVersionRegistrationPayload(event.payload));
  }
  return registrationEvents.every((event) =>
    workflowVersionRegisteredPayloadMatches(event.payload, expectedRegistrationPayload)
  );
}

function isMinimalWorkflowVersionRegistrationPayload(payload: JsonRecord): boolean {
  return typeof payload.workflowVersionId === "string" &&
    typeof payload.workflowVersionHash === "string" &&
    Object.keys(payload).every((key) => key === "workflowVersionId" || key === "workflowVersionHash");
}

function plannerReuseRecordedWorkflowVersionId(
  events: readonly EventEnvelope[],
  input: unknown,
): string | undefined {
  if (
    events.length === 0 ||
    hasRunStartedEvent(events) ||
    !events.every((event) =>
      event.type === "WorkflowVersionRegistered" || isPlanningLifecycleEvent(event)
    )
  ) {
    return undefined;
  }
  const registrationWorkflowVersionId = stringProperty(
    events.find((event) => event.type === "WorkflowVersionRegistered")?.payload,
    "workflowVersionId",
  );
  const reuseDecision = plannerReuseDecisionFor(events, registrationWorkflowVersionId);
  if (reuseDecision === undefined) {
    return undefined;
  }
  const workflowVersionId = stringProperty(reuseDecision.payload, "resultingWorkflowVersionId");
  if (workflowVersionId === undefined) {
    return undefined;
  }
  if (
    registrationWorkflowVersionId !== undefined &&
    registrationWorkflowVersionId !== workflowVersionId
  ) {
    return undefined;
  }
  assertPlannerReuseDecisionInputHashMatches(reuseDecision, sha256Digest(input));
  return workflowVersionId;
}

function plannerReuseDecisionFor(
  events: readonly EventEnvelope[],
  workflowVersionId: string | undefined,
): EventEnvelope | undefined {
  return events.find((event) =>
    event.type === "PlannerReuseDecisionRecorded" &&
    typeof event.payload.resultingWorkflowVersionId === "string" &&
    (
      workflowVersionId === undefined ||
      event.payload.resultingWorkflowVersionId === workflowVersionId
    )
  );
}

function plannerReuseUnchangedDecisionFor(
  events: readonly EventEnvelope[],
  workflowVersionId: string,
): EventEnvelope | undefined {
  return events.find((event) =>
    event.type === "PlannerReuseDecisionRecorded" &&
    event.payload.decisionKind === "reuse_unchanged" &&
    event.payload.resultingWorkflowVersionId === workflowVersionId &&
    (
      event.payload.candidateWorkflowVersionId === undefined ||
      event.payload.candidateWorkflowVersionId === workflowVersionId
    )
  );
}

function assertPlannerReuseDecisionInputHashMatches(
  event: EventEnvelope,
  expectedInputHash: string,
): void {
  if (event.payload.inputHash !== expectedInputHash) {
    throw new RuntimeIntegrityError(
      "Planner reuse decision inputHash does not match run input.",
    );
  }
}

function assertWorkflowVersionLockConsistent(
  workflowVersion: LockedRuntimeWorkflowVersion,
): void {
  const lock = workflowVersionLockEnvelope(workflowVersion.lock);
  const lwirHash = sha256Digest(workflowVersion.lwir);
  const lwirVersionId = lwirVersionIdForHash(lwirHash);
  if (
    workflowVersion.canonicalizer !== "little-workflow-canonical-json@alpha" ||
    lock.workflowVersionId !== workflowVersion.id ||
    lock.workflowVersionHash !== workflowVersion.hash ||
    lock.lwirVersionId !== lwirVersionId ||
    lock.lwirHash !== lwirHash ||
    workflowVersion.lwirVersionId !== lwirVersionId ||
    workflowVersion.lwirHash !== lwirHash ||
    workflowVersion.canonicalJson !== canonicalJson(workflowVersion.lwir)
  ) {
    throw new Error("WorkflowVersion lock mismatch.");
  }
  const capabilityManifestHash = sha256Digest(lock.capabilityManifest);
  if (lock.capabilityManifestHash !== capabilityManifestHash) {
    throw new Error("WorkflowVersion lock mismatch.");
  }
  const validationHash = computeCompilerValidationHash({
    canonicalizer: workflowVersion.canonicalizer,
    lwirVersionId,
    lwirHash,
    requestId: lock.requestId,
    requestHash: lock.requestHash,
    inputHash: lock.inputHash,
    plannedInputStructureHash: lock.plannedInputStructureHash,
    workflowDefinitionHash: lock.workflowDefinitionHash,
    inputSchemaHash: lock.inputSchemaHash,
    requestedOutputHash: lock.requestedOutputHash,
    capabilityManifestHash,
  });
  if (lock.validationHash !== validationHash) {
    throw new Error("WorkflowVersion lock mismatch.");
  }
  const identity = computeCompiledWorkflowVersionIdentity({
    canonicalizer: workflowVersion.canonicalizer,
    lwirVersionId,
    lwirHash,
    lockSeed: workflowVersionLockSeedFrom(lock),
  });
  if (
    identity.workflowVersionId !== workflowVersion.id ||
    identity.workflowVersionHash !== workflowVersion.hash
  ) {
    throw new Error("WorkflowVersion lock mismatch.");
  }
}

function workflowVersionLockEnvelope(lock: unknown): WorkflowVersionLockEnvelope {
  if (!isRecord(lock)) {
    throw new Error("WorkflowVersion lock mismatch.");
  }
  const requiredStrings = [
    "workflowVersionId",
    "workflowVersionHash",
    "lwirVersionId",
    "lwirHash",
    "requestId",
    "requestHash",
    "inputHash",
    "plannedInputStructureHash",
    "workflowDefinitionHash",
    "inputSchemaHash",
    "requestedOutputHash",
    "capabilityManifestHash",
    "validationHash",
  ];
  for (const key of requiredStrings) {
    if (typeof lock[key] !== "string") {
      throw new Error("WorkflowVersion lock mismatch.");
    }
  }
  if (!Array.isArray(lock.modelSlots) || !Array.isArray(lock.tools)) {
    throw new Error("WorkflowVersion lock mismatch.");
  }
  if (
    lock.planningDefinitionSnapshotHash !== undefined &&
    typeof lock.planningDefinitionSnapshotHash !== "string"
  ) {
    throw new Error("WorkflowVersion lock mismatch.");
  }
  if (
    Object.hasOwn(lock, "planningDefinitionSnapshot") &&
    lock.planningDefinitionSnapshotHash !== undefined &&
    sha256Digest(lock.planningDefinitionSnapshot) !== lock.planningDefinitionSnapshotHash
  ) {
    throw new Error("WorkflowVersion lock mismatch.");
  }
  if (
    !Object.hasOwn(lock, "requestedOutput") ||
    !Object.hasOwn(lock, "capabilityManifest") ||
    !Object.hasOwn(lock, "plannedInputStructure")
  ) {
    throw new Error("WorkflowVersion lock mismatch.");
  }
  return lock as unknown as WorkflowVersionLockEnvelope;
}

function assertWorkflowVersionMatches(
  state: MaterializedRunState,
  workflowVersionId: string,
  workflowVersionHash: string,
  events: readonly EventEnvelope[],
): void {
  if (state.workflowVersionId !== undefined && state.workflowVersionId !== workflowVersionId) {
    throw new Error(
      `WorkflowVersion mismatch for run '${state.runId}': expected ${state.workflowVersionId}, received ${workflowVersionId}.`,
    );
  }
  const registeredHash = registeredWorkflowVersionHash(events);
  if (registeredHash !== undefined && registeredHash !== workflowVersionHash) {
    throw new Error(
      `WorkflowVersion hash mismatch for run '${state.runId}': expected ${registeredHash}, received ${workflowVersionHash}.`,
    );
  }
}

function assertRunInputMatches(events: readonly EventEnvelope[], input: unknown): void {
  const persistedInput = runStartedInput(events);
  if (persistedInput !== undefined) {
    if (sha256Digest(persistedInput) !== sha256Digest(input)) {
      throw new RuntimeIntegrityError(
        "Run input mismatch: existing run was started with different input.",
      );
    }
    return;
  }
  const requestedInputHash = orchestrationRequestedInputHash(events);
  if (requestedInputHash !== undefined && requestedInputHash !== sha256Digest(input)) {
    throw new RuntimeIntegrityError(
      "Run input mismatch: existing run was requested with different input.",
    );
  }
}

function assertRunInputPersistedAndMatches(
  events: readonly EventEnvelope[],
  input: unknown,
): void {
  const started = events.find((event) => event.type === "RunStarted");
  if (started === undefined || !Object.hasOwn(started.payload, "input")) {
    throw new RuntimeIntegrityError("Completed run is missing persisted input.");
  }
  if (sha256Digest(started.payload.input) !== sha256Digest(input)) {
    throw new RuntimeIntegrityError(
      "Run input mismatch: existing run was started with different input.",
    );
  }
}

function runStartedInput(events: readonly EventEnvelope[]): unknown {
  const started = events.find((event) => event.type === "RunStarted");
  if (started === undefined || !Object.hasOwn(started.payload, "input")) {
    return undefined;
  }
  return started.payload.input;
}

function orchestrationRequestedInputHash(events: readonly EventEnvelope[]): string | undefined {
  const requested = events.find((event) => event.type === "OrchestrationRequested");
  return typeof requested?.payload.inputHash === "string" ? requested.payload.inputHash : undefined;
}

function registeredWorkflowVersionHash(events: readonly EventEnvelope[]): string | undefined {
  for (const event of events) {
    if (
      event.type === "WorkflowVersionRegistered" &&
      typeof event.payload.workflowVersionHash === "string"
    ) {
      return event.payload.workflowVersionHash;
    }
  }
  return undefined;
}

async function assertCompletedStepArtifactsValid(
  world: LocalWorld,
  workflow: LwirWorkflow,
  runId: RunId,
  state: MaterializedRunState,
  events: readonly EventEnvelope[],
): Promise<void> {
  for (const stepState of Object.values(state.steps)) {
    if (stepState.status !== "completed") {
      continue;
    }
    const refs = uniqueRefs([
      ...(stepState.outputRef === undefined ? [] : [stepState.outputRef]),
      ...stepState.artifactRefs,
    ]);
    if (stepState.outputRef !== undefined && "output" in stepState) {
      const outputArtifact = await world.readArtifact(stepState.outputRef);
      if (sha256Digest(stepState.output) !== sha256Digest(outputArtifact.payload)) {
        throw new RuntimeIntegrityError(
          "StepCompleted output does not match output artifact.",
        );
      }
    }
    assertStepSchemaHashMetadataValid(workflow, stepState.stepPath, stepState, events);
    await assertResultArtifactRefs(
      world,
      runId,
      stepState.stepPath,
      refs,
      lwirUsesForStepPath(workflow, stepState.stepPath) === "parallel",
      true,
      stepState.attempts.length,
      scheduledBranchPathsFor(events, stepState.stepPath, stepState.attempts.length),
    );
  }
}

function assertStepSchemaHashMetadataValid(
  workflow: LwirWorkflow,
  stepPath: string,
  stepState: MaterializedRunState["steps"][string],
  events: readonly EventEnvelope[],
): void {
  const step = lwirStepForStepPath(workflow, stepPath);
  if (step === undefined) {
    return;
  }
  const expectedHash = stepOutputSchemaHash(step.output);
  const validatedHash = latestStepOutputValidatedSchemaHash(events, stepPath);
  const completedHash = isRecord(stepState.metadata)
    ? stringProperty(stepState.metadata, "schemaHash")
    : undefined;

  if (validatedHash !== undefined && validatedHash !== expectedHash) {
    throw new RuntimeIntegrityError(
      `StepOutputValidated schemaHash for step '${stepPath}' does not match WorkflowVersion contract.`,
    );
  }
  if (completedHash !== undefined && completedHash !== expectedHash) {
    throw new RuntimeIntegrityError(
      `StepCompleted schemaHash for step '${stepPath}' does not match WorkflowVersion contract.`,
    );
  }
  if (
    validatedHash !== undefined &&
    completedHash !== undefined &&
    validatedHash !== completedHash
  ) {
    throw new RuntimeIntegrityError(
      `Step schemaHash metadata mismatch for step '${stepPath}'.`,
    );
  }
}

function latestStepOutputValidatedSchemaHash(
  events: readonly EventEnvelope[],
  stepPath: string,
): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (
      event?.type === "StepOutputValidated" &&
      event.payload.stepPath === stepPath
    ) {
      return stringProperty(event.payload, "schemaHash");
    }
  }
  return undefined;
}

function lwirStepForStepPath(
  workflow: LwirWorkflow,
  stepPath: string,
): LwirStep | undefined {
  if (isTopLevelStepPath(stepPath)) {
    return workflow.steps.find((step) => step.id === stepPath);
  }
  // Handle visit-indexed top-level paths: "<stepId>.visit[N]"
  const topLevelVisitMatch = /^([^.[]+)\.visit\[\d+\]$/.exec(stepPath);
  if (topLevelVisitMatch !== null) {
    return workflow.steps.find((step) => step.id === topLevelVisitMatch[1]);
  }
  const delimiter = "].";
  const delimiterIndex = stepPath.lastIndexOf(delimiter);
  if (delimiterIndex === -1) {
    return undefined;
  }
  const branchPath = stepPath.slice(0, delimiterIndex + 1);
  const stepId = stepPath.slice(delimiterIndex + delimiter.length);
  for (const step of workflow.steps) {
    if (
      step.uses === "parallel" &&
      parallelAttemptFromBranchPath(step.id, branchPath) !== undefined
    ) {
      // Strip visit suffix from branch-local step path too, if present.
      const branchStepId = stepId.replace(/\.visit\[\d+\]$/, "");
      return step.steps?.find((candidate) => candidate.id === branchStepId);
    }
  }
  return undefined;
}

async function assertRunOutputArtifactValid(
  world: LocalWorld,
  runId: RunId,
  stepPath: string | undefined,
  state: MaterializedRunState,
): Promise<void> {
  if (state.outputRef === undefined) {
    throw new Error("Completed run is missing a final output artifact.");
  }
  const artifact = await world.readArtifact(state.outputRef);
  if (artifact.manifest.runId !== runId) {
    throw new Error(`Artifact '${state.outputRef}' does not belong to run '${runId}'.`);
  }
  if (stepPath !== undefined && artifact.manifest.stepPath !== stepPath) {
    throw new Error(`Artifact '${state.outputRef}' does not belong to step '${stepPath}'.`);
  }
  if (stepPath !== undefined) {
    const finalStep = state.steps[stepPath];
    if (finalStep?.outputRef !== undefined && finalStep.outputRef !== state.outputRef) {
      throw new RuntimeIntegrityError(
        `Run outputRef '${state.outputRef}' does not match final step outputRef '${finalStep.outputRef}'.`,
      );
    }
  }
  if ("output" in state && sha256Digest(state.output) !== sha256Digest(artifact.payload)) {
    throw new RuntimeIntegrityError("RunCompleted output does not match output artifact.");
  }
}

async function executeStep(
  options: ExecuteWorkflowVersionOptions,
  runId: RunId,
  workflowVersionId: string,
  step: LwirStep,
  finalStepPath: string | undefined,
  runtimeState: RuntimeState,
  scope: StepExecutionScope = {},
): Promise<RuntimeState> {
  let currentState = runtimeState;
  // Determine visit index: provided via scope (parallel branch) or derived from state (top-level).
  const parentPath = scope.branchPath ?? "";
  const visitIndex = scope.visitIndex ?? visitIndexFor(step, parentPath, currentState.materialized);
  // Check for max-visits overshoot before scheduling the visit.
  const cap = step.maxVisits ?? 1;
  if (cap > 1 && visitIndex >= cap) {
    const overshootPath = stepPathFor(step, parentPath, visitIndex);
    throw new RuntimeMaxVisitsError(
      `Step '${step.id}' has reached its maxVisits cap of ${cap}.`,
      overshootPath,
    );
  }
  const stepPath = scope.stepPath ?? stepPathFor(step, parentPath, visitIndex);

  if (!Object.hasOwn(currentState.materialized.steps, stepPath)) {
    currentState = await record(currentState, options.world, runId, {
      type: "StepScheduled",
      payload: { stepPath, stepId: step.id, uses: step.uses },
    });
  }

  const maxAttempts = maxAttemptsFor(step, options);
  const stepState = currentState.materialized.steps[stepPath];
  const existingAttempts = stepState?.attempts.length ?? 0;
  const resumingAttempt = isResumableRunningAttempt(step, stepState, scope);
  if (hasNonTerminalAttempt(stepState) && !resumingAttempt) {
    throw new RuntimeIntegrityError(
      `Step '${step.id}' has a non-terminal attempt and cannot be retried safely.`,
    );
  }
  const terminalRuntimeError = terminalRuntimeErrorForStep(stepState);
  if (terminalRuntimeError !== undefined) {
    throw terminalRuntimeError;
  }
  if (!resumingAttempt && existingAttempts >= maxAttempts) {
    throw new Error(`Step '${step.id}' exhausted ${maxAttempts} attempt(s).`);
  }

  const firstAttempt = resumingAttempt ? existingAttempts : existingAttempts + 1;
  const outputContract = snapshotStepOutputContract(step.output);
  for (let attempt = firstAttempt; attempt <= maxAttempts; attempt += 1) {
    assertNotCancelled(options.signal);
    const isResumingCurrentAttempt = resumingAttempt && attempt === firstAttempt;
    if (!isResumingCurrentAttempt) {
      currentState = await record(currentState, options.world, runId, {
        type: "StepAttemptStarted",
        payload: { stepPath, stepId: step.id, attempt, attemptId: `attempt_${attempt}` },
      });
    }

    const input = await resolveStepInput(
      options.world,
      step,
      options.workflowVersion.lwir,
      options.input,
      currentState.materialized,
      scope,
    );
    const context: RuntimeStepContext = {
      world: options.world,
      runId,
      workflowVersionId,
      step,
      stepPath,
      attempt,
      input,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(isResumingCurrentAttempt ? { resumingAttempt: true } : {}),
      ...(scope.hasItem === true ? { hasItem: true, item: scope.item } : {}),
      ...(scope.branchPath === undefined ? {} : { branchPath: scope.branchPath }),
      ...(scope.allowedTopLevelStepIds === undefined
        ? {}
        : { allowedTopLevelStepIds: scope.allowedTopLevelStepIds }),
    };

    try {
      assertNotCancelled(options.signal);
      const semaphore = step.uses !== "parallel" ? semaphoreForWorld(options.world) : undefined;
      if (semaphore !== undefined) {
        await semaphore.acquire();
      }
      let adapterResult: StepAdapterResult;
      try {
        adapterResult = await executeStepAdapter(
          options,
          step,
          context,
          currentState,
          outputContract,
        );
      } finally {
        semaphore?.release();
      }
      assertNotCancelled(options.signal);
      currentState = adapterResult.runtimeState;
      const result = adapterResult.result;
      return await finalizeStepSuccess(
        options,
        runId,
        step,
        stepPath,
        attempt,
        finalStepPath,
        outputContract,
        result,
        currentState,
      );
    } catch (error) {
      if (isReplayIntegrityError(error)) {
        throw error;
      }
      currentState = await loadRuntimeState(options.world, runId);
      const retriable = !isTerminalRuntimeCause(error) && attempt < maxAttempts;
      currentState = await record(currentState, options.world, runId, {
        type: "StepFailed",
        payload: {
          stepPath,
          stepId: step.id,
          attempt,
          attemptId: `attempt_${attempt}`,
          error: errorEnvelope(error, retriable),
        },
      });
      const fixed = shouldAttemptFixerForError(error)
        ? await maybeRecoverCodeStepWithFixer({
            options,
            runId,
            workflowVersionId,
            step,
            stepPath,
            attempt,
            context,
            outputContract,
            finalStepPath,
            runtimeState: currentState,
            originalError: error,
          })
        : undefined;
      if (fixed !== undefined) {
        return fixed;
      }
      if (!retriable) {
        throw error;
      }
    }
  }

  throw new Error(`Step '${step.id}' exhausted without producing output.`);
}

async function finalizeStepSuccess(
  options: ExecuteWorkflowVersionOptions,
  runId: RunId,
  step: LwirStep,
  stepPath: string,
  attempt: number,
  finalStepPath: string | undefined,
  outputContract: LwirStep["output"],
  result: RuntimeStepExecutionResult,
  runtimeState: RuntimeState,
): Promise<RuntimeState> {
  const output = normalizeStepOutputForContract(result.output, outputContract);
  validateStepOutput(step, output, outputContract);
  if (stepPath === finalStepPath) {
    validateWorkflowOutput(options.workflowVersion.lwir, output);
  }
  const outputArtifact = await options.world.writeArtifact({
    runId,
    stepPath,
    name: "output",
    payload: output,
    contentType: contentTypeFor(output),
  });
  const artifactRefs = uniqueRefs([
    outputArtifact.artifactRef,
    ...(result.artifactRefs ?? []),
  ]);

  let currentState = await record(runtimeState, options.world, runId, {
    type: "ArtifactCreated",
    payload: {
      stepPath,
      artifactRef: outputArtifact.artifactRef,
      name: outputArtifact.name,
      contentType: outputArtifact.contentType,
    },
  });
  currentState = await record(currentState, options.world, runId, {
    type: "StepOutputValidated",
    payload: stripUndefined({
      stepPath,
      outputRef: outputArtifact.artifactRef,
      outputMode: outputContract?.mode,
      schemaHash: stepOutputSchemaHash(outputContract),
    }),
  });
  await assertResultArtifactRefs(
    options.world,
    runId,
    stepPath,
    result.artifactRefs ?? [],
    step.uses === "parallel",
    false,
    attempt,
    scheduledBranchPathsFor(currentState.events, stepPath, attempt),
  );
  currentState = await record(currentState, options.world, runId, {
    type: "StepCompleted",
    payload: stripUndefined({
      stepPath,
      stepId: step.id,
      attempt,
      output: inlineOutputForEvent(output),
      outputRef: outputArtifact.artifactRef,
      artifactRefs,
      metadata: stripUndefined({
        ...result.metadata,
        uses: step.uses,
        outputMode: outputContract?.mode,
        schemaHash: stepOutputSchemaHash(outputContract),
      }),
    }),
  });
  return currentState;
}

function normalizeStepOutputForContract(output: unknown, contract: LwirStep["output"]): unknown {
  if (contract?.mode !== "array" || Array.isArray(output) || !isRecord(output)) {
    return output;
  }
  for (const key of ["items", "elements", "candidates", "data"]) {
    const value = output[key];
    if (Array.isArray(value)) {
      return value;
    }
  }
  return output;
}

async function maybeRecoverCodeStepWithFixer(input: {
  readonly options: ExecuteWorkflowVersionOptions;
  readonly runId: RunId;
  readonly workflowVersionId: string;
  readonly step: LwirStep;
  readonly stepPath: string;
  readonly attempt: number;
  readonly context: RuntimeStepContext;
  readonly outputContract: LwirStep["output"];
  readonly finalStepPath: string | undefined;
  readonly runtimeState: RuntimeState;
  readonly originalError: unknown;
}): Promise<RuntimeState | undefined> {
  const { options, runId, workflowVersionId, step, stepPath, attempt, context } = input;
  if (step.uses !== "code.run") {
    return undefined;
  }
  const harness = options.workerHarness;
  if (harness === undefined) {
    return undefined;
  }
  const fixer = fixerConfigForStep(step);
  if (fixer === undefined) {
    return undefined;
  }
  const priorFixAttempts = fixerAttemptsForStep(input.runtimeState.events, stepPath);
  if (priorFixAttempts >= fixer.maxAttempts) {
    return undefined;
  }

  assertAllowedModel(options.workflowVersion.lwir, fixer.modelSlot);
  if (!Object.hasOwn(options.models ?? {}, fixer.modelSlot)) {
    throw new RuntimeCapabilityDriftError(
      `capability_drift: model '${fixer.modelSlot}' is not registered for fixer on step '${step.id}'. Re-run runWorkflow() to compile a fresh WorkflowVersion against the current capability set.`,
    );
  }
  const modelBinding = options.models?.[fixer.modelSlot];
  assertModelCapabilityLock(options.workflowVersion, fixer.modelSlot, modelBinding);
  const model = isModelSlot(modelBinding) ? modelBinding.aiSdkModel : modelBinding;

  const mergedTools = {
    ...(options.tools?.toRecord() ?? {}),
    ...(options.workerTools ?? {}),
  } as Record<string, unknown>;
  const lock = workflowVersionLock(options.workflowVersion);
  const workflowDefinitionHash = lock?.workflowDefinitionHash ??
    sha256Digest({
      workflowVersionId: options.workflowVersion.id,
      lwirHash: sha256Digest(options.workflowVersion.lwir),
    });
  const logDir = runLogDir(options.world, context.runId, options.parentRunId);
  const recorder = createHarnessEventRecorder({ world: options.world, runId: context.runId });
  const fixerScope: HarnessContext["scope"] = {
    runId: context.runId,
    ...(options.parentRunId === undefined ? {} : { parentRunId: options.parentRunId }),
    logDir,
    role: "fixer",
    stepPath: context.stepPath,
  };
  const harnessEnvironment = await workerHarnessEnvironment(options, fixerScope, true);
  const manifest = fixerManifest({
    harnessId: harnessIdFor(harness),
    workflowDefinitionHash,
    workflowVersionId,
    stepPath: context.stepPath,
    stepConfig: step,
    modelSlotId: fixer.modelSlot,
    systemPrompt: fixer.system,
    allowedTools: Object.keys(mergedTools).sort(),
    skills: harnessEnvironment.skills.map(skillManifestIdentity),
    memoryStoreIds: harnessEnvironment.memoryMounts.map((mount) => mount.storeId),
    bashCapabilities: options.bashCapabilities,
    fixerModelSlotId: fixer.modelSlot,
    fixerSystem: fixer.system,
    fixerMaxAttempts: fixer.maxAttempts,
  });
  const harnessContext = createRuntimeHarnessContext({
    world: options.world,
    runId: context.runId,
    scope: fixerScope,
    taskKind: "fix_step",
    manifest,
    model: {
      slotId: fixer.modelSlot,
      providerId:
        stringProperty(model, "providerId") ??
        stringProperty(model, "provider") ??
        "runtime",
      modelId: stringProperty(model, "modelId") ?? fixer.modelSlot,
      model,
    },
    system: fixer.system,
    tools: mergedTools,
    memoryMounts: harnessEnvironment.memoryMounts,
    scratchMounts: harnessEnvironment.scratchMounts,
    skills: harnessEnvironment.skills,
    skillWarnings: harnessEnvironment.skillWarnings,
    recorder,
    abortSignal: context.signal ?? new AbortController().signal,
    bashCapabilities: options.bashCapabilities,
  });

  const task = {
    kind: "fix_step",
    step: step as FixStepTask["step"],
    stepInput: context.input,
    originalAttemptError: harnessErrorEnvelope(input.originalError),
    priorFixAttempts,
  } satisfies FixStepTask;
  let taskResult = await runWorkerHarnessTaskWithSessionEvents(
    context.runId,
    harnessContext,
    manifest,
    "fix_step",
    harness,
    task,
    options.signal,
  );
  if (taskResult.kind === "delegate_to_default") {
    if (harness === workflowHarness) {
      throw new RuntimeConfigError(
        `runtime_config_error: fixer harness delegated step '${step.id}' to default runtime, but no default fixer runtime is available.`,
      );
    }
    const defaultManifest = fixerManifest({
      harnessId: harnessIdFor(workflowHarness),
      workflowDefinitionHash,
      workflowVersionId,
      stepPath: context.stepPath,
      stepConfig: step,
      modelSlotId: fixer.modelSlot,
      systemPrompt: fixer.system,
      allowedTools: Object.keys(mergedTools).sort(),
      skills: harnessEnvironment.skills.map(skillManifestIdentity),
      memoryStoreIds: harnessEnvironment.memoryMounts.map((mount) => mount.storeId),
      bashCapabilities: options.bashCapabilities,
      fixerModelSlotId: fixer.modelSlot,
      fixerSystem: fixer.system,
      fixerMaxAttempts: fixer.maxAttempts,
    });
    const defaultHarnessContext = createRuntimeHarnessContext({
      world: options.world,
      runId: context.runId,
      scope: fixerScope,
      taskKind: "fix_step",
      manifest: defaultManifest,
      model: harnessContext.model,
      system: fixer.system,
      tools: mergedTools,
      memoryMounts: harnessEnvironment.memoryMounts,
      scratchMounts: harnessEnvironment.scratchMounts,
      skills: harnessEnvironment.skills,
      skillWarnings: harnessEnvironment.skillWarnings,
      recorder: createHarnessEventRecorder({
        world: options.world,
        runId: context.runId,
        skipManifestDriftCheck: true,
      }),
      abortSignal: context.signal ?? new AbortController().signal,
      bashCapabilities: options.bashCapabilities,
    });
    taskResult = await runWorkerHarnessTaskWithSessionEvents(
      context.runId,
      defaultHarnessContext,
      defaultManifest,
      "fix_step",
      workflowHarness,
      task,
      options.signal,
    );
    if (taskResult.kind === "delegate_to_default") {
      throw new RuntimeConfigError(
        `runtime_config_error: workflowHarness delegated fixer step '${step.id}' to default runtime.`,
      );
    }
  }
  if (taskResult.kind !== "fix_step") {
    throw new RuntimeConfigError(
      `runtime_config_error: worker harness returned '${taskResult.kind}' for fixer on step '${step.id}'.`,
    );
  }

  const fixedResult: RuntimeStepExecutionResult = {
    output: taskResult.output,
    metadata: stripUndefined({
      fixedSource: taskResult.fixedSource,
      fixerAttempts: taskResult.attempts,
    }),
  };
  return finalizeStepSuccess(
    options,
    runId,
    step,
    stepPath,
    attempt,
    input.finalStepPath,
    input.outputContract,
    fixedResult,
    input.runtimeState,
  );
}

function fixerConfigForStep(step: LwirStep): FixerConfig | undefined {
  const fixer = (step as StepWithFixer).onFailure?.fixer;
  if (fixer === undefined) {
    return undefined;
  }

  if (typeof fixer.model !== "string" || fixer.model.length === 0) {
    throw new RuntimeConfigError(
      `runtime_config_error: fixer model is required for step '${step.id}'.`,
    );
  }
  if (
    typeof fixer.maxAttempts !== "number" ||
    !Number.isInteger(fixer.maxAttempts) ||
    fixer.maxAttempts < 1
  ) {
    throw new RuntimeConfigError(
      `runtime_config_error: fixer maxAttempts must be a positive integer for step '${step.id}'.`,
    );
  }
  if (typeof fixer.system !== "string" || fixer.system.length === 0) {
    throw new RuntimeConfigError(
      `runtime_config_error: fixer system prompt is required for step '${step.id}'.`,
    );
  }

  return {
    modelSlot: fixer.model,
    maxAttempts: fixer.maxAttempts,
    system: fixer.system,
  };
}

function fixerAttemptsForStep(
  events: readonly EventEnvelope[],
  stepPath: string,
): number {
  return events.filter((event) => {
    if (normalizeHarnessEventType(event.type) !== "harness.session.started" || event.payload.role !== "fixer") {
      return false;
    }
    const manifest = propertyValue(event.payload, "manifest");
    return isRecord(manifest) && stringProperty(manifest, "stepPath") === stepPath;
  }).length;
}

async function executeStepAdapter(
  options: ExecuteWorkflowVersionOptions,
  step: LwirStep,
  context: RuntimeStepContext,
  runtimeState: RuntimeState,
  outputContract: LwirStep["output"],
): Promise<StepAdapterResult> {
  if (step.uses === "ai.generate") {
    return executeAiStep(options, step, context, runtimeState, outputContract);
  }
  if (step.uses === "tool.call") {
    const harnessResult = await maybeExecuteDirectStepWithWorkerHarness(
      options,
      step,
      context,
      runtimeState,
    );
    if (harnessResult !== undefined) {
      return harnessResult;
    }
    return executeToolStep(options, step, context, runtimeState);
  }
  if (step.uses === "code.run") {
    const harnessResult = await maybeExecuteDirectStepWithWorkerHarness(
      options,
      step,
      context,
      runtimeState,
    );
    if (harnessResult !== undefined) {
      return harnessResult;
    }
    throw new RuntimeCapabilityDriftError(
      `capability_drift: worker harness is required for code.run step '${step.id}'. Re-run runWorkflow() to compile a fresh WorkflowVersion against the current capability set.`,
    );
  }
  if (step.uses === "parallel") {
    return executeParallelStep(options, step, context, runtimeState);
  }
  if (step.uses === "decision") {
    return executeDecisionStep(options, step, context, runtimeState);
  }
  throw new Error(`Unsupported serial runtime step type: ${step.uses}.`);
}

async function maybeExecuteDirectStepWithWorkerHarness(
  options: ExecuteWorkflowVersionOptions,
  step: LwirStep,
  context: RuntimeStepContext,
  runtimeState: RuntimeState,
): Promise<StepAdapterResult | undefined> {
  const harness = options.workerHarness;
  if (harness === undefined) {
    return undefined;
  }

  const mergedTools = {
    ...(options.tools?.toRecord() ?? {}),
    ...(options.workerTools ?? {}),
  } as Record<string, unknown>;
  const scopedTools = scopedWorkerTools(
    step,
    mergedTools,
    options.workflowVersion,
    options.tools,
    context.input,
  );
  const allowedTools = Object.keys(scopedTools).sort();
  const lock = workflowVersionLock(options.workflowVersion);
  const workflowDefinitionHash = lock?.workflowDefinitionHash ??
    sha256Digest({
      workflowVersionId: options.workflowVersion.id,
      lwirHash: sha256Digest(options.workflowVersion.lwir),
    });
  const logDir = runLogDir(options.world, context.runId, options.parentRunId);
  const recorder = createHarnessEventRecorder({ world: options.world, runId: context.runId });
  const workerScope: HarnessContext["scope"] = {
    runId: context.runId,
    ...(options.parentRunId === undefined ? {} : { parentRunId: options.parentRunId }),
    logDir,
    role: step.uses === "tool.call" ? "worker.tool-call" : "worker.code-run",
    stepPath: context.stepPath,
  };
  const harnessEnvironment = await workerHarnessEnvironment(options, workerScope, true);
  const manifest = workerManifest({
    harnessId: harnessIdFor(harness),
    workflowDefinitionHash,
    workflowVersionId: options.workflowVersion.id,
    stepPath: context.stepPath,
    stepConfig: step,
    allowedTools,
    skills: harnessEnvironment.skills.map(skillManifestIdentity),
    memoryStoreIds: harnessEnvironment.memoryMounts.map((mount) => mount.storeId),
    bashCapabilities: options.bashCapabilities,
  });
  const harnessContext = createRuntimeHarnessContext({
    world: options.world,
    runId: context.runId,
    scope: workerScope,
    taskKind: "execute_step",
    manifest,
    model: {
      slotId: "worker.direct",
      providerId: "runtime",
      modelId: "runtime",
      model: {},
    },
    tools: scopedTools,
    memoryMounts: harnessEnvironment.memoryMounts,
    scratchMounts: harnessEnvironment.scratchMounts,
    skills: harnessEnvironment.skills,
    skillWarnings: harnessEnvironment.skillWarnings,
    recorder,
    abortSignal: context.signal ?? new AbortController().signal,
    bashCapabilities: options.bashCapabilities,
    // Inherited runtime policy (parent denies) for a delegated sub-run.
    permissions: options.permissions,
  });

  const taskVisitIndex = visitIndexFromStepPath(context.stepPath);
  const task = {
    kind: "execute_step",
    step: step as ExecuteStepTask["step"],
    stepInput: context.input,
    stepContext: {
      stepPath: context.stepPath,
      visitIndex: taskVisitIndex,
      attempt: context.attempt,
      toolCallScope: toolCallScopeForRuntimeContext(context),
      toolExecutionContext: toolExecutionContextForHarness(context),
    },
  } satisfies ExecuteStepTask;
  let taskResult = await runWorkerHarnessTaskWithSessionEvents(
    context.runId,
    harnessContext,
    manifest,
    "execute_step",
    harness,
    task,
    options.signal,
  );

  if (taskResult.kind === "delegate_to_default") {
    if (harness === workflowHarness) {
      throw new RuntimeConfigError(
        `runtime_config_error: worker harness delegated direct step '${step.id}' to default runtime, but no default worker direct runtime is available.`,
      );
    }
    const defaultManifest = workerManifest({
      harnessId: harnessIdFor(workflowHarness),
      workflowDefinitionHash,
      workflowVersionId: options.workflowVersion.id,
      stepPath: context.stepPath,
      stepConfig: step,
      allowedTools,
      skills: harnessEnvironment.skills.map(skillManifestIdentity),
      memoryStoreIds: harnessEnvironment.memoryMounts.map((mount) => mount.storeId),
      bashCapabilities: options.bashCapabilities,
    });
    const defaultHarnessContext = createRuntimeHarnessContext({
      world: options.world,
      runId: context.runId,
      scope: workerScope,
      taskKind: "execute_step",
      manifest: defaultManifest,
      model: harnessContext.model,
      tools: scopedTools,
      memoryMounts: harnessEnvironment.memoryMounts,
      scratchMounts: harnessEnvironment.scratchMounts,
      skills: harnessEnvironment.skills,
      skillWarnings: harnessEnvironment.skillWarnings,
      recorder: createHarnessEventRecorder({
        world: options.world,
        runId: context.runId,
        skipManifestDriftCheck: true,
      }),
      abortSignal: context.signal ?? new AbortController().signal,
      bashCapabilities: options.bashCapabilities,
      permissions: options.permissions,
    });
    taskResult = await runWorkerHarnessTaskWithSessionEvents(
      context.runId,
      defaultHarnessContext,
      defaultManifest,
      "execute_step",
      workflowHarness,
      task,
      options.signal,
    );
    if (taskResult.kind === "delegate_to_default") {
      throw new RuntimeConfigError(
        `runtime_config_error: worker harness delegated direct step '${step.id}' to default runtime, but no default worker direct runtime is available.`,
      );
    }
  }
  if (taskResult.kind !== "execute_step") {
    throw new RuntimeConfigError(
      `runtime_config_error: worker harness returned '${taskResult.kind}' for direct step '${step.id}'.`,
    );
  }
  return {
    result: {
      output: taskResult.output,
      artifactRefs: taskResult.artifactRefs,
    },
    runtimeState,
  };
}

function toolCallScopeForRuntimeContext(context: RuntimeStepContext): JsonRecord {
  return stripUndefined({
    branchPath: context.branchPath,
    hasItem: context.hasItem,
    resumingAttempt: context.resumingAttempt,
  });
}

function toolExecutionContextForHarness(context: RuntimeStepContext): RuntimeStepContext {
  return {
    ...context,
    step: cloneJsonLike(context.step),
    input: cloneJsonLike(context.input),
    ...(context.hasItem === true ? { item: cloneJsonLike(context.item) } : {}),
  };
}

async function maybeExecuteAiStepWithWorkerHarness(
  options: ExecuteWorkflowVersionOptions,
  step: LwirStep,
  context: RuntimeStepContext,
  runtimeState: RuntimeState,
  modelSlot: string,
  model: unknown,
): Promise<StepAdapterResult | undefined> {
  const harness = options.workerHarness;
  if (harness === undefined) {
    return undefined;
  }

  const mergedTools = {
    ...(options.tools?.toRecord() ?? {}),
    ...(options.workerTools ?? {}),
  } as Record<string, unknown>;
  const scopedTools = scopedAiWorkerTools(mergedTools, options.workflowVersion, options.tools);
  const lock = workflowVersionLock(options.workflowVersion);
  const workflowDefinitionHash = lock?.workflowDefinitionHash ??
    sha256Digest({
      workflowVersionId: options.workflowVersion.id,
      lwirHash: sha256Digest(options.workflowVersion.lwir),
    });
  const logDir = runLogDir(options.world, context.runId, options.parentRunId);
  const recorder = createHarnessEventRecorder({ world: options.world, runId: context.runId });
  const workerScope: HarnessContext["scope"] = {
    runId: context.runId,
    ...(options.parentRunId === undefined ? {} : { parentRunId: options.parentRunId }),
    logDir,
    role: "worker.ai-generate",
    stepPath: context.stepPath,
  };
  const harnessEnvironment = await workerHarnessEnvironment(options, workerScope, true);
  const manifest = workerManifest({
    harnessId: harnessIdFor(harness),
    workflowDefinitionHash,
    workflowVersionId: options.workflowVersion.id,
    stepPath: context.stepPath,
    stepConfig: step,
    modelSlotId: modelSlot,
    allowedTools: Object.keys(scopedTools).sort(),
    skills: harnessEnvironment.skills.map(skillManifestIdentity),
    memoryStoreIds: harnessEnvironment.memoryMounts.map((mount) => mount.storeId),
    bashCapabilities: options.bashCapabilities,
  });
  const harnessContext = createRuntimeHarnessContext({
    world: options.world,
    runId: context.runId,
    scope: workerScope,
    taskKind: "execute_step",
    manifest,
    model: {
      slotId: modelSlot,
      providerId:
        stringProperty(model, "providerId") ??
        stringProperty(model, "provider") ??
        "runtime",
      modelId: stringProperty(model, "modelId") ?? modelSlot,
      model,
    },
    tools: scopedTools,
    memoryMounts: harnessEnvironment.memoryMounts,
    scratchMounts: harnessEnvironment.scratchMounts,
    skills: harnessEnvironment.skills,
    skillWarnings: harnessEnvironment.skillWarnings,
    recorder,
    abortSignal: context.signal ?? new AbortController().signal,
    bashCapabilities: options.bashCapabilities,
    // Inherited runtime policy (parent denies) for a delegated sub-run.
    permissions: options.permissions,
  });

  const taskVisitIndex = visitIndexFromStepPath(context.stepPath);
  const task = {
    kind: "execute_step",
    step: step as ExecuteStepTask["step"],
    stepInput: context.input,
    stepContext: {
      stepPath: context.stepPath,
      visitIndex: taskVisitIndex,
      attempt: context.attempt,
      toolCallScope: toolCallScopeForRuntimeContext(context),
      toolExecutionContext: toolExecutionContextForHarness(context),
    },
  } satisfies ExecuteStepTask;
  let taskResult = await runWorkerHarnessTaskWithSessionEvents(
    context.runId,
    harnessContext,
    manifest,
    "execute_step",
    harness,
    task,
    options.signal,
  );

  if (taskResult.kind === "delegate_to_default") {
    if (harness === workflowHarness) {
      throw new RuntimeConfigError(
        `runtime_config_error: worker harness delegated ai.generate step '${step.id}' to default runtime, but no default worker ai runtime is available.`,
      );
    }
    const defaultManifest = workerManifest({
      harnessId: harnessIdFor(workflowHarness),
      workflowDefinitionHash,
      workflowVersionId: options.workflowVersion.id,
      stepPath: context.stepPath,
      stepConfig: step,
      modelSlotId: modelSlot,
      allowedTools: Object.keys(scopedTools).sort(),
      skills: harnessEnvironment.skills.map(skillManifestIdentity),
      memoryStoreIds: harnessEnvironment.memoryMounts.map((mount) => mount.storeId),
      bashCapabilities: options.bashCapabilities,
    });
    const defaultHarnessContext = createRuntimeHarnessContext({
      world: options.world,
      runId: context.runId,
      scope: workerScope,
      taskKind: "execute_step",
      manifest: defaultManifest,
      model: harnessContext.model,
      tools: scopedTools,
      memoryMounts: harnessEnvironment.memoryMounts,
      scratchMounts: harnessEnvironment.scratchMounts,
      skills: harnessEnvironment.skills,
      skillWarnings: harnessEnvironment.skillWarnings,
      recorder: createHarnessEventRecorder({
        world: options.world,
        runId: context.runId,
        skipManifestDriftCheck: true,
      }),
      abortSignal: context.signal ?? new AbortController().signal,
      bashCapabilities: options.bashCapabilities,
      permissions: options.permissions,
    });
    taskResult = await runWorkerHarnessTaskWithSessionEvents(
      context.runId,
      defaultHarnessContext,
      defaultManifest,
      "execute_step",
      workflowHarness,
      task,
      options.signal,
    );
    if (taskResult.kind === "delegate_to_default") {
      throw new RuntimeConfigError(
        `runtime_config_error: worker harness delegated ai.generate step '${step.id}' to default runtime, but no default worker ai runtime is available.`,
      );
    }
  }
  if (taskResult.kind !== "execute_step") {
    throw new RuntimeConfigError(
      `runtime_config_error: worker harness returned '${taskResult.kind}' for ai step '${step.id}'.`,
    );
  }
  return {
    result: {
      output: taskResult.output,
      artifactRefs: taskResult.artifactRefs,
    },
    runtimeState,
  };
}

async function runWorkerHarnessTaskWithSessionEvents(
  runId: RunId,
  context: RuntimeHarnessContext,
  manifest: ReturnType<typeof workerManifest> | ReturnType<typeof fixerManifest>,
  taskKind: "execute_step" | "fix_step",
  harness: Harness,
  task: HarnessTask,
  signal: AbortSignal | undefined,
): Promise<HarnessResult> {
  const skillContents = context.skills.length === 0
    ? undefined
    : await readSkillContents(context.skills);
  const runContext: RuntimeHarnessContext = {
    ...context,
    session: {
      runId,
      role: context.scope.role,
      task: { kind: taskKind },
      ...(context.scope.parentRunId === undefined ? {} : { parentRunId: context.scope.parentRunId }),
      manifest,
      manifestHash: hashHarnessManifest(manifest),
      ...(context.session.warnings === undefined ? {} : { warnings: context.session.warnings }),
      ...(skillContents === undefined ? {} : { skillContents }),
    },
  };
  try {
    return await raceSignal(
      () => runWorkflowHarnessWithSession(
        harness as never,
        task as never,
        runContext as never,
      ) as Promise<HarnessResult>,
      signal,
    );
  } catch (error) {
    throw classifyHarnessRuntimeError(error);
  }
}

function classifyHarnessRuntimeError(error: unknown): unknown {
  if (!(error instanceof Error)) {
    return error;
  }
  if (
    /^Workflow tool '.+' is not executable\.$/u.test(error.message) ||
    /^Workflow code\.run (step|file|entrypoint)/u.test(error.message)
  ) {
    const wrapped = new RuntimeConfigError(error.message);
    (wrapped as Error & { cause?: unknown }).cause = error;
    return wrapped;
  }
  return error;
}

function harnessIdFor(harness: Harness): string {
  const id = propertyValue(harness, "harnessId");
  return typeof id === "string" && id.length > 0 ? id : "customHarness@unknown";
}

function scopedWorkerTools(
  step: LwirStep,
  tools: Record<string, unknown>,
  workflowVersion: ExecuteWorkflowVersionOptions["workflowVersion"],
  registry: ToolRegistry | undefined,
  stepInput?: unknown,
): Record<string, unknown> {
  if (step.uses === "tool.call") {
    const toolName = toolNameForStep(step);
    if (toolName === undefined) {
      throw new RuntimeConfigError(
        `runtime_config_error: step '${step.id}' must define with.tool for tool execution.`,
      );
    }
    assertAllowedTool(workflowVersion.lwir, toolName);
    const tool = tools[toolName];
    if (tool === undefined) {
      throw new RuntimeCapabilityDriftError(
        `capability_drift: tool '${toolName}' is not registered for step '${step.id}'. Re-run runWorkflow() to compile a fresh WorkflowVersion against the current capability set.`,
      );
    }
    const descriptor = toolDescriptorFromRegistry(registry, toolName);
    if (descriptor === undefined) {
      throw new RuntimeCapabilityDriftError(
        `capability_drift: tool '${toolName}' is not registered for step '${step.id}'. Re-run runWorkflow() to compile a fresh WorkflowVersion against the current capability set.`,
      );
    }
    assertToolCapabilityLockFromDescriptor(workflowVersion, toolName, descriptor);
    validateToolInputFromDescriptor(toolName, descriptor, stepInput);
    assertToolApprovalSupportedFromDescriptor(toolName, descriptor);
    return { [toolName]: tool };
  }
  if (step.uses !== "code.run") {
    return tools;
  }
  const allowedToolNames = workflowVersion.lwir.permissions?.tools ?? [];
  const scoped: Record<string, unknown> = {};
  for (const toolName of allowedToolNames) {
    const tool = tools[toolName];
    if (tool === undefined) {
      throw new RuntimeCapabilityDriftError(
        `capability_drift: tool '${toolName}' is not registered for step '${step.id}'. Re-run runWorkflow() to compile a fresh WorkflowVersion against the current capability set.`,
      );
    }
    const descriptor = toolDescriptorFromRegistry(registry, toolName);
    if (descriptor === undefined) {
      throw new RuntimeCapabilityDriftError(
        `capability_drift: tool '${toolName}' is not registered for step '${step.id}'. Re-run runWorkflow() to compile a fresh WorkflowVersion against the current capability set.`,
      );
    }
    assertToolCapabilityLockFromDescriptor(workflowVersion, toolName, descriptor);
    assertToolApprovalSupportedFromDescriptor(toolName, descriptor);
    scoped[toolName] = tool;
  }
  return scoped;
}

function scopedAiWorkerTools(
  tools: Record<string, unknown>,
  workflowVersion: ExecuteWorkflowVersionOptions["workflowVersion"],
  registry: ToolRegistry | undefined,
): Record<string, unknown> {
  const allowedToolNames = workflowVersion.lwir.permissions?.tools ?? [];
  const scoped: Record<string, unknown> = {};
  for (const toolName of allowedToolNames) {
    const tool = tools[toolName];
    if (tool === undefined) {
      throw new RuntimeCapabilityDriftError(
        `capability_drift: tool '${toolName}' is not registered for ai.generate. Re-run runWorkflow() to compile a fresh WorkflowVersion against the current capability set.`,
      );
    }
    const descriptor = toolDescriptorFromRegistry(registry, toolName);
    if (descriptor === undefined) {
      throw new RuntimeCapabilityDriftError(
        `capability_drift: tool '${toolName}' is not registered for ai.generate. Re-run runWorkflow() to compile a fresh WorkflowVersion against the current capability set.`,
      );
    }
    assertToolCapabilityLockFromDescriptor(workflowVersion, toolName, descriptor);
    assertToolApprovalSupportedFromDescriptor(toolName, descriptor);
    scoped[toolName] = tool;
  }
  return scoped;
}

function toolNameForStep(step: LwirStep): string | undefined {
  const value = step.with?.tool;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function visitIndexFromStepPath(stepPath: string): number {
  const match = /\.visit\[(\d+)\]$/u.exec(stepPath);
  if (match === null) {
    return 0;
  }
  const value = Number.parseInt(match[1] as string, 10);
  return Number.isFinite(value) ? value : 0;
}

async function executeDecisionStep(
  options: ExecuteWorkflowVersionOptions,
  step: LwirStep,
  context: RuntimeStepContext,
  runtimeState: RuntimeState,
): Promise<StepAdapterResult> {
  const cfg = step.with as {
    cases?: ReadonlyArray<{ when: string; to: string }>;
    default: string;
  };
  const scope = scopeFromContext(context);
  const expressionContext = await expressionContextFor(
    options.world,
    step,
    options.workflowVersion.lwir,
    options.input,
    runtimeState.materialized,
    scope,
  );
  for (const c of cfg.cases ?? []) {
    const result = Boolean(resolveExpressionValue(c.when, expressionContext));
    if (result) {
      return {
        result: { output: { chosen: c.to }, artifactRefs: [], metadata: { uses: "decision" } },
        runtimeState,
      };
    }
  }
  return {
    result: {
      output: { chosen: cfg.default },
      artifactRefs: [],
      metadata: { uses: "decision" },
    },
    runtimeState,
  };
}

async function executeParallelStep(
  options: ExecuteWorkflowVersionOptions,
  step: LwirStep,
  context: RuntimeStepContext,
  runtimeState: RuntimeState,
): Promise<StepAdapterResult> {
  const config = parallelConfigFor(step);
  const branches = await parallelBranchesFor(
    options,
    step,
    context,
    runtimeState.materialized,
    config,
  );

  let currentState = runtimeState;
  if (!parallelGroupStartedFor(context.stepPath, context.attempt, currentState.events)) {
    currentState = await record(currentState, options.world, context.runId, {
      type: "ParallelGroupStarted",
      payload: {
        stepPath: context.stepPath,
        stepId: step.id,
        attempt: context.attempt,
        attemptId: attemptIdFor(context.attempt),
        branchCount: branches.length,
        maxConcurrency: config.maxConcurrency,
        failureMode: config.failureMode,
      },
    });
  }
  assertParallelBranchFactsScheduled(context.stepPath, context.attempt, currentState.events);

  const branchResults = new Array<ParallelBranchResult | undefined>(branches.length);
  let failFastCause: unknown;
  let fatalCause: unknown;
  for (const branch of branches) {
    const previousResult = await previousOrResumableBranchResultFor(
      options.world,
      step,
      context.stepPath,
      context.attempt,
      branch,
      currentState.materialized,
      currentState.events,
      context.resumingAttempt === true,
    );
    if (previousResult !== undefined) {
      branchResults[branch.index] = previousResult;
      currentState = await recordMissingParallelBranchTerminal(
        currentState,
        options.world,
        context.runId,
        context.stepPath,
        step.id,
        context.attempt,
        branch,
        previousResult,
      );
      const terminalCause = terminalRuntimeCauseForBranchResult(previousResult);
      if (terminalCause !== undefined) {
        fatalCause = terminalCause;
        continue;
      }
      if (config.failureMode === "fail_fast" && previousResult.status === "rejected") {
        failFastCause = previousResult.cause;
      }
    }
  }
  let nextBranchIndex = 0;

  const worker = async (): Promise<void> => {
    while (nextBranchIndex < branches.length) {
      assertNotCancelled(options.signal);
      if (fatalCause !== undefined) {
        return;
      }
      if (config.failureMode === "fail_fast" && failFastCause !== undefined) {
        return;
      }
      const branch = branches[nextBranchIndex];
      nextBranchIndex += 1;
      if (branch === undefined) {
        return;
      }
      if (branchResults[branch.index] !== undefined) {
        continue;
      }
      assertNotCancelled(options.signal);

      let branchState = await loadRuntimeState(options.world, context.runId);
      assertParallelBranchFactsScheduled(context.stepPath, context.attempt, branchState.events);
      if (
        !parallelBranchScheduledFor(
          context.stepPath,
          branch.branchPath,
          context.attempt,
          branchState.events,
        )
      ) {
        branchState = await record(branchState, options.world, context.runId, {
          type: "ParallelBranchScheduled",
          payload: {
            stepPath: context.stepPath,
            attempt: context.attempt,
            attemptId: attemptIdFor(context.attempt),
            branchPath: branch.branchPath,
            itemKey: branch.itemKey,
            branchIndex: branch.index,
          },
        });
      }

      try {
        if (context.resumingAttempt === true) {
          const settledResult = await branchResultFromStateForResume(
            options.world,
            step,
            branch,
            branchState.materialized,
            branchState.events,
          );
          if (settledResult !== undefined) {
            branchResults[branch.index] = settledResult;
            if (settledResult.status === "fulfilled") {
              branchState = await record(branchState, options.world, context.runId, {
                type: "ParallelBranchCompleted",
                payload: {
                  stepPath: context.stepPath,
                  attempt: context.attempt,
                  attemptId: attemptIdFor(context.attempt),
                  branchPath: branch.branchPath,
                  itemKey: branch.itemKey,
                  branchIndex: branch.index,
                  outputRef: settledResult.outputRef,
                  artifactRefs: settledResult.artifactRefs,
                },
              });
            } else {
              branchState = await record(branchState, options.world, context.runId, {
                type: "ParallelBranchFailed",
                payload: {
                  stepPath: context.stepPath,
                  attempt: context.attempt,
                  attemptId: attemptIdFor(context.attempt),
                  branchPath: branch.branchPath,
                  itemKey: branch.itemKey,
                  branchIndex: branch.index,
                  error: settledResult.error,
                  artifactRefs: settledResult.artifactRefs,
                },
              });
              const terminalCause = terminalRuntimeCauseForBranchResult(settledResult);
              if (terminalCause !== undefined) {
                if (fatalCause === undefined) {
                  fatalCause = terminalCause;
                }
                return;
              }
              if (config.failureMode === "fail_fast" && failFastCause === undefined) {
                failFastCause = settledResult.cause;
              }
            }
            if (config.failureMode === "fail_fast" && settledResult.status === "rejected") {
              return;
            }
            continue;
          }
        }

        const branchOutput = await executeParallelBranch(
          options,
          context,
          step,
          branch,
          branchState,
        );
        branchResults[branch.index] = {
          index: branch.index,
          itemKey: branch.itemKey,
          status: "fulfilled",
          output: branchOutput.output,
          outputRef: branchOutput.outputRef,
          artifactRefs: branchOutput.artifactRefs,
        };
        branchState = await record(branchOutput.runtimeState, options.world, context.runId, {
          type: "ParallelBranchCompleted",
          payload: {
            stepPath: context.stepPath,
            attempt: context.attempt,
            attemptId: attemptIdFor(context.attempt),
            branchPath: branch.branchPath,
            itemKey: branch.itemKey,
            branchIndex: branch.index,
            outputRef: branchOutput.outputRef,
            artifactRefs: branchOutput.artifactRefs,
          },
        });
      } catch (error) {
        if (isReplayIntegrityError(error)) {
          if (fatalCause === undefined) {
            fatalCause = error;
          }
          return;
        }
        branchState = await loadRuntimeState(options.world, context.runId);
        const rejected = {
          index: branch.index,
          itemKey: branch.itemKey,
          status: "rejected",
          error: errorEnvelope(error, false),
          artifactRefs: artifactRefsForBranch(branchState.events, branch.branchPath),
          cause: error,
        } satisfies ParallelBranchResult;
        branchResults[branch.index] = rejected;
        if (config.failureMode === "fail_fast" && failFastCause === undefined) {
          failFastCause = error;
        }
        await record(branchState, options.world, context.runId, {
          type: "ParallelBranchFailed",
          payload: {
            stepPath: context.stepPath,
            attempt: context.attempt,
            attemptId: attemptIdFor(context.attempt),
            branchPath: branch.branchPath,
            itemKey: branch.itemKey,
            branchIndex: branch.index,
            error: rejected.error,
            artifactRefs: rejected.artifactRefs,
          },
        });
        if (isTerminalRuntimeCause(error)) {
          if (fatalCause === undefined) {
            fatalCause = error;
          }
          return;
        }
        if (config.failureMode === "fail_fast") {
          return;
        }
      }
    }
  };

  const workerCount = Math.min(config.maxConcurrency, branches.length);
  const workerSettlements = await Promise.allSettled(
    Array.from({ length: workerCount }, () => worker()),
  );
  assertNotCancelled(options.signal);
  currentState = await loadRuntimeState(options.world, context.runId);
  const rejectedWorker = workerSettlements.find((settlement) => settlement.status === "rejected");
  if (fatalCause !== undefined) {
    throw fatalCause;
  }
  if (rejectedWorker?.status === "rejected") {
    throw rejectedWorker.reason;
  }

  if (failFastCause !== undefined) {
    if (
      !parallelGroupTerminalFor(
        context.stepPath,
        context.attempt,
        "ParallelGroupFailed",
        currentState.events,
      )
    ) {
      currentState = await record(currentState, options.world, context.runId, {
        type: "ParallelGroupFailed",
        payload: {
          stepPath: context.stepPath,
          stepId: step.id,
          attempt: context.attempt,
          attemptId: attemptIdFor(context.attempt),
          error: errorEnvelope(failFastCause, false),
        },
      });
    }
    throw failFastCause;
  }

  const output = parallelFanInOutput(config, branchResults);
  if (
    !parallelGroupTerminalFor(
      context.stepPath,
      context.attempt,
      "ParallelGroupCompleted",
      currentState.events,
    )
  ) {
    currentState = await record(currentState, options.world, context.runId, {
      type: "ParallelGroupCompleted",
      payload: {
        stepPath: context.stepPath,
        stepId: step.id,
        attempt: context.attempt,
        attemptId: attemptIdFor(context.attempt),
        branchCount: branches.length,
        fanInOrder: config.fanIn.order,
      },
    });
  }
  return {
    result: {
      output,
      artifactRefs: branchArtifactRefs(branchResults),
      metadata: { branchCount: branches.length, fanInOrder: config.fanIn.order },
    },
    runtimeState: currentState,
  };
}

async function executeParallelBranch(
  options: ExecuteWorkflowVersionOptions,
  parentContext: RuntimeStepContext,
  parallelStep: LwirStep,
  branch: ParallelBranch,
  runtimeState: RuntimeState,
): Promise<{
  readonly output: unknown;
  readonly outputRef: ArtifactRef;
  readonly artifactRefs: readonly ArtifactRef[];
  readonly runtimeState: RuntimeState;
}> {
  const branchSteps = parallelStep.steps ?? [];
  // DAG final step (non-decision terminal). May be undefined for decision-terminated branches.
  const dagFinalStep = finalOutputStep(branchSteps);
  const completedForNeeds = completedStepIdsForScope(
    branchSteps,
    runtimeState.materialized,
    branch.branchPath,
    parallelStep.needs ?? [],
  );
  const remaining = new Set(
    branchSteps.map((step) => step.id).filter((stepId) => !completedForNeeds.has(stepId)),
  );
  let currentState = runtimeState;

  // For crash-and-resume: prime forced routing from the last committed decision in this branch.
  let forcedNextStepId: string | null = pendingDecisionTargetForScope(
    branchSteps,
    currentState.materialized,
    currentState.events,
    branch.branchPath,
  );

  // Mirror top-level fix (lines 1537-1541): on resume, the forced target's transitive downstream
  // may have already been removed from `remaining` (because earlier visits completed and
  // completedStepIdsForScope filtered them out). Re-add them so the branch loop can continue
  // scheduling after the forced step runs — otherwise the loop exits with stale output.
  if (forcedNextStepId !== null) {
    for (const stepId of transitiveDownstreamOf(branchSteps, forcedNextStepId)) {
      remaining.add(stepId);
    }
  }

  // Track the most-recently-committed non-decision step path for branch output resolution.
  let lastNonDecisionStepPath: string | undefined;
  for (const [stepPath, stepState] of Object.entries(currentState.materialized.steps)) {
    if (
      stepState.status === "completed" &&
      stepPath.startsWith(`${branch.branchPath}.`)
    ) {
      const localPath = stepPath.slice(branch.branchPath.length + 1);
      const localStepId = localPath.split(".")[0];
      const branchStep = branchSteps.find((s) => s.id === localStepId);
      if (branchStep !== undefined && branchStep.uses !== "decision") {
        lastNonDecisionStepPath = stepPath;
      }
    }
  }

  branchLoop: while (true) {
    assertNotCancelled(options.signal);
    let nextStep: LwirStep | undefined;

    if (forcedNextStepId !== null) {
      nextStep = branchSteps.find((s) => s.id === forcedNextStepId);
      if (nextStep === undefined) {
        throw new Error(
          `Decision target '${forcedNextStepId}' not found in branch '${branch.branchPath}'.`,
        );
      }
      forcedNextStepId = null;
      remaining.delete(nextStep.id);
    } else {
      // Exclude decision targets whose controlling decision step is currently runnable —
      // they must wait until the decision routes to them via forcedNextStepId.
      const decisionTargets = activeDecisionTargetIds(branchSteps, completedForNeeds);
      nextStep = branchSteps.find((candidate) => {
        if (!remaining.has(candidate.id)) {
          return false;
        }
        if (decisionTargets.has(candidate.id)) {
          return false; // wait for the decision step to route to this target
        }
        return (candidate.needs ?? []).every((need) => completedForNeeds.has(need));
      });
      if (nextStep === undefined) {
        if (remaining.size > 0) {
          throw new Error(
            `No runnable LWIR branch step found for '${branch.branchPath}'; dependencies are incomplete or cyclic.`,
          );
        }
        break branchLoop;
      }
      remaining.delete(nextStep.id);
    }

    // Compute the step path before execution (needed to look up decision output after run).
    const visitIndexBefore = visitIndexFor(nextStep, branch.branchPath, currentState.materialized);
    // Use stepPathFor which handles both single-visit (returns "branch.stepId") and
    // multi-visit (returns "branch.stepId.visit[N]") correctly.
    const executingStepPath = stepPathFor(nextStep, branch.branchPath, visitIndexBefore);

    currentState = await executeStep(
      options,
      parentContext.runId,
      parentContext.workflowVersionId,
      nextStep,
      undefined,
      currentState,
      {
        // Provide stepPath explicitly so executeStep uses the precomputed path.
        stepPath: executingStepPath,
        branchPath: branch.branchPath,
        allowedTopLevelStepIds: parallelStep.needs ?? [],
        hasItem: true,
        item: branch.item,
      },
    );

    if (nextStep.uses === "decision") {
      const decisionState = currentState.materialized.steps[executingStepPath];
      const decisionOutput = decisionState !== undefined
        ? await outputValueForCompletedStep(options.world, decisionState)
        : undefined;
      const chosen = isRecord(decisionOutput) && typeof decisionOutput.chosen === "string"
        ? decisionOutput.chosen
        : undefined;
      if (chosen === undefined) {
        throw new Error(
          `Decision step '${nextStep.id}' did not produce a valid chosen target.`,
        );
      }
      // Remove all unchosen decision targets from remaining.
      const decisionCfg = nextStep.with as {
        cases?: ReadonlyArray<{ when: string; to: string }>;
        default: string;
      };
      const allDecisionTargets = new Set([
        ...(decisionCfg.cases ?? []).map((c) => c.to),
        decisionCfg.default,
      ]);
      for (const target of allDecisionTargets) {
        if (target !== chosen && target !== "end") {
          remaining.delete(target);
        }
      }
      if (chosen === "end") {
        break branchLoop;
      }
      forcedNextStepId = chosen;
      // Re-add transitive downstream steps for back-edge loop body re-scheduling.
      for (const stepId of transitiveDownstreamOf(branchSteps, chosen)) {
        remaining.add(stepId);
      }
    } else {
      completedForNeeds.add(nextStep.id);
      lastNonDecisionStepPath = executingStepPath;
    }
  }
  assertNotCancelled(options.signal);

  // Determine the branch's final output step path.
  // Resolution order (§2.7):
  //   1. If fanIn.outputStep is set, use the most-recently-completed visit of that step.
  //   2. Otherwise, use lastNonDecisionStepPath (most-recently-committed non-decision step).
  //   3. Legacy fallback: if dagFinalStep is defined and no decision paths exist, use it.
  const parallelFanInConfig = parallelStep.with as
    | { fanIn?: { outputStep?: string } }
    | undefined;
  const explicitOutputStep = parallelFanInConfig?.fanIn?.outputStep;

  let finalStatePath: string | undefined;
  if (typeof explicitOutputStep === "string") {
    // Explicit outputStep: find the most-recently-completed visit of the named step.
    const outputStepDef = branchSteps.find((s) => s.id === explicitOutputStep);
    if (outputStepDef !== undefined) {
      const base = `${branch.branchPath}.${explicitOutputStep}`;
      if ((outputStepDef.maxVisits ?? 1) > 1) {
        const vi = visitIndexFor(outputStepDef, branch.branchPath, currentState.materialized) - 1;
        if (vi >= 0) {
          finalStatePath = `${branch.branchPath}.${stepPathSuffix(outputStepDef, vi)}`;
        }
      } else {
        finalStatePath = base;
      }
    }
  } else if (lastNonDecisionStepPath !== undefined) {
    finalStatePath = lastNonDecisionStepPath;
  } else if (dagFinalStep !== undefined) {
    finalStatePath = `${branch.branchPath}.${dagFinalStep.id}`;
    if (!Object.hasOwn(currentState.materialized.steps, finalStatePath)) {
      // Multi-visit dag final step.
      const vi = visitIndexFor(dagFinalStep, branch.branchPath, currentState.materialized) - 1;
      if (vi >= 0) {
        finalStatePath = `${branch.branchPath}.${stepPathSuffix(dagFinalStep, vi)}`;
      }
    }
  }

  const finalState = finalStatePath !== undefined
    ? currentState.materialized.steps[finalStatePath]
    : undefined;
  if (finalState?.status !== "completed") {
    throw new Error(`Parallel branch '${branch.branchPath}' is missing final output.`);
  }
  if (finalState.outputRef === undefined) {
    throw new Error(`Parallel branch '${branch.branchPath}' is missing final output artifact.`);
  }
  return {
    output: await outputValueForCompletedStep(options.world, finalState),
    outputRef: finalState.outputRef,
    artifactRefs: artifactRefsForBranch(currentState.events, branch.branchPath),
    runtimeState: currentState,
  };
}

/**
 * Compute the path suffix for a step within a parent path at a given visit index.
 * For single-visit steps: just the step id. For multi-visit: "stepId.visit[N]".
 */
function stepPathSuffix(step: LwirStep, visitIndex: number): string {
  return (step.maxVisits ?? 1) > 1 ? `${step.id}.visit[${visitIndex}]` : step.id;
}

/**
 * Branch-scoped version of pendingDecisionTarget: scans events for the most recent
 * decision completion within a given branch that has a pending unstarted target visit.
 */
function pendingDecisionTargetForScope(
  steps: readonly LwirStep[],
  state: MaterializedRunState,
  events: readonly EventEnvelope[],
  branchPath: string,
): string | null {
  const branchPrefix = `${branchPath}.`;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event === undefined || event.type !== "StepCompleted") {
      continue;
    }
    const stepPath = stringProperty(event.payload, "stepPath");
    if (stepPath === undefined || !stepPath.startsWith(branchPrefix)) {
      continue;
    }
    const metadata = event.payload.metadata;
    if (!isRecord(metadata) || metadata.uses !== "decision") {
      continue;
    }
    const output = event.payload.output;
    if (!isRecord(output) || typeof output.chosen !== "string") {
      continue;
    }
    const chosen = output.chosen as string;
    if (chosen === "end") {
      return null;
    }
    const targetStep = steps.find((s) => s.id === chosen);
    if (targetStep === undefined) {
      return null;
    }
    const nextVisitIndex = visitIndexFor(targetStep, branchPath, state);
    const nextPath = `${branchPath}.${stepPathSuffix(targetStep, nextVisitIndex)}`;
    if (!Object.hasOwn(state.steps, nextPath)) {
      return chosen;
    }
    return null;
  }
  return null;
}

async function assertResultArtifactRefs(
  world: LocalWorld,
  runId: RunId,
  stepPath: string,
  refs: readonly ArtifactRef[],
  allowDescendantStepPaths = false,
  verifyPayload = false,
  descendantAttempt?: number,
  allowedDescendantBranchPaths: readonly string[] = [],
): Promise<void> {
  for (const ref of refs) {
    const manifest = verifyPayload
      ? (await world.readArtifact(ref)).manifest
      : await world.readArtifactManifest(ref);
    if (manifest.runId !== runId) {
      throw new Error(`Artifact '${ref}' does not belong to run '${runId}'.`);
    }
    if (
      manifest.stepPath !== stepPath &&
      (!allowDescendantStepPaths ||
        manifest.stepPath === undefined ||
        !isDescendantStepPath(
          stepPath,
          manifest.stepPath,
          descendantAttempt,
          allowedDescendantBranchPaths,
        ))
    ) {
      throw new Error(`Artifact '${ref}' does not belong to step '${stepPath}'.`);
    }
  }
}

function isDescendantStepPath(
  parentStepPath: string,
  childStepPath: string,
  attempt?: number,
  allowedBranchPaths: readonly string[] = [],
): boolean {
  if (attempt !== undefined) {
    const branchPrefix = attempt === 1
      ? `${parentStepPath}[`
      : `${parentStepPath}@attempt_${attempt}[`;
    if (!childStepPath.startsWith(branchPrefix)) {
      return false;
    }
  } else if (
    !childStepPath.startsWith(`${parentStepPath}[`) &&
    !childStepPath.startsWith(`${parentStepPath}@attempt_`)
  ) {
    return false;
  }
  return allowedBranchPaths.length === 0
    ? false
    : allowedBranchPaths.some((branchPath) =>
      childStepPath === branchPath || childStepPath.startsWith(`${branchPath}.`)
    );
}

function scheduledBranchPathsFor(
  events: readonly EventEnvelope[],
  parentStepPath: string,
  attempt: number,
): readonly string[] {
  return scheduledBranchesFor(events, parentStepPath, attempt).map((branch) => branch.branchPath);
}

function scheduledBranchesFor(
  events: readonly EventEnvelope[],
  parentStepPath: string,
  attempt: number,
): readonly ScheduledParallelBranch[] {
  const branchesByPath = new Map<string, ScheduledParallelBranch>();
  const pathsByIndex = new Map<number, string>();
  const pathsByItemKey = new Map<string, string>();
  for (const event of events) {
    if (
      event.type === "ParallelBranchScheduled" &&
      event.payload.stepPath === parentStepPath &&
      eventAttemptMatches(event.payload, attempt)
    ) {
      const branchPath = stringProperty(event.payload, "branchPath");
      if (branchPath === undefined) {
        continue;
      }
      const scheduled: ScheduledParallelBranch = stripUndefined({
        branchPath,
        itemKey: stringProperty(event.payload, "itemKey"),
        branchIndex: branchIndexProperty(event.payload),
      }) as ScheduledParallelBranch;
      const existing = branchesByPath.get(branchPath);
      if (existing !== undefined) {
        if (
          existing.itemKey !== scheduled.itemKey ||
          existing.branchIndex !== scheduled.branchIndex
        ) {
          throw new RuntimeIntegrityError(
            `Conflicting ParallelBranchScheduled event for '${branchPath}'.`,
          );
        }
        throw new RuntimeIntegrityError(
          `Duplicate ParallelBranchScheduled event for '${branchPath}'.`,
        );
      }
      if (scheduled.branchIndex !== undefined) {
        const existingPath = pathsByIndex.get(scheduled.branchIndex);
        if (existingPath !== undefined && existingPath !== branchPath) {
          throw new RuntimeIntegrityError(
            `Conflicting ParallelBranchScheduled event for branch index ${scheduled.branchIndex}.`,
          );
        }
        pathsByIndex.set(scheduled.branchIndex, branchPath);
      }
      if (scheduled.itemKey !== undefined) {
        const existingPath = pathsByItemKey.get(scheduled.itemKey);
        if (existingPath !== undefined && existingPath !== branchPath) {
          throw new RuntimeIntegrityError(
            `Conflicting ParallelBranchScheduled event for itemKey '${scheduled.itemKey}'.`,
          );
        }
        pathsByItemKey.set(scheduled.itemKey, branchPath);
      }
      branchesByPath.set(branchPath, scheduled);
    }
  }
  return [...branchesByPath.values()];
}

function assertParallelBranchFactsScheduled(
  parentStepPath: string,
  attempt: number,
  events: readonly EventEnvelope[],
): void {
  const scheduled = new Set(
    scheduledBranchesFor(events, parentStepPath, attempt).map((branch) => branch.branchPath),
  );

  for (const event of events) {
    const branchPath = parallelBranchFactPath(parentStepPath, attempt, event);
    if (branchPath !== undefined && !scheduled.has(branchPath)) {
      throw new RuntimeIntegrityError(
        `Branch fact for '${branchPath}' exists without a matching ParallelBranchScheduled.`,
      );
    }
  }
}

function assertParallelBranchFactsScheduledForWorkflow(
  workflow: LwirWorkflow,
  events: readonly EventEnvelope[],
): void {
  for (const step of workflow.steps) {
    if (step.uses !== "parallel") {
      continue;
    }
    for (const attempt of parallelAttemptsForStep(step.id, events)) {
      assertParallelBranchFactsScheduled(step.id, attempt, events);
    }
  }
}

async function assertCompletedParallelReplayMatchesInput(
  options: ExecuteWorkflowVersionOptions,
  runId: RunId,
  workflowVersionId: string,
  state: MaterializedRunState,
  events: readonly EventEnvelope[],
): Promise<void> {
  for (const step of options.workflowVersion.lwir.steps) {
    if (step.uses !== "parallel") {
      continue;
    }
    const stepState = state.steps[step.id];
    if (stepState?.status !== "completed") {
      continue;
    }
    const attempt = stepState.attempts.length;
    if (attempt < 1) {
      throw new RuntimeIntegrityError(
        `Completed parallel step '${step.id}' is missing attempt history.`,
      );
    }
    const config = parallelConfigFor(step);
    const expectedBranches = await parallelBranchesFor(
      options,
      step,
      {
        world: options.world,
        runId,
        workflowVersionId,
        step,
        stepPath: step.id,
        attempt,
        input: options.input,
      },
      state,
      config,
    );
    assertScheduledBranchesMatchExpected(
      step.id,
      attempt,
      scheduledBranchesFor(events, step.id, attempt),
      expectedBranches,
    );

    const results = new Array<ParallelBranchResult | undefined>(expectedBranches.length);
    for (const branch of expectedBranches) {
      const result = await previousBranchResultFor(
        options.world,
        step,
        step.id,
        attempt,
        branch,
        state,
        events,
      );
      if (result === undefined) {
        throw new RuntimeIntegrityError(
          `Expected branch path '${branch.branchPath}' is missing a terminal result.`,
        );
      }
      results[branch.index] = result;
    }

    const expectedOutput = parallelFanInOutput(config, results);
    const actualOutput = await outputValueForCompletedStep(options.world, stepState);
    if (sha256Digest(actualOutput) !== sha256Digest(expectedOutput)) {
      throw new RuntimeIntegrityError(
        `Parallel fan-in output for step '${step.id}' does not match branch terminal results.`,
      );
    }
  }
}

function assertScheduledBranchesMatchExpected(
  parentStepPath: string,
  attempt: number,
  scheduledBranches: readonly ScheduledParallelBranch[],
  expectedBranches: readonly ParallelBranch[],
): void {
  const scheduledByPath = new Map(
    scheduledBranches.map((branch) => [branch.branchPath, branch] as const),
  );
  for (const scheduled of scheduledBranches) {
    const expected = expectedBranches.find((branch) => branch.branchPath === scheduled.branchPath);
    if (expected === undefined) {
      throw new RuntimeIntegrityError(
        `Scheduled branch path '${scheduled.branchPath}' does not match expected branch path for '${parentStepPath}' attempt ${attempt}.`,
      );
    }
    if (scheduled.itemKey !== undefined && scheduled.itemKey !== expected.itemKey) {
      throw new RuntimeIntegrityError(
        `Scheduled branch path '${scheduled.branchPath}' has itemKey '${scheduled.itemKey}', expected '${expected.itemKey}'.`,
      );
    }
    if (scheduled.branchIndex !== undefined && scheduled.branchIndex !== expected.index) {
      throw new RuntimeIntegrityError(
        `Scheduled branch path '${scheduled.branchPath}' has branchIndex ${scheduled.branchIndex}, expected ${expected.index}.`,
      );
    }
  }
  for (const expected of expectedBranches) {
    if (!scheduledByPath.has(expected.branchPath)) {
      throw new RuntimeIntegrityError(
        `Expected branch path '${expected.branchPath}' was not scheduled for '${parentStepPath}' attempt ${attempt}.`,
      );
    }
  }
}

function parallelAttemptsForStep(
  parentStepPath: string,
  events: readonly EventEnvelope[],
): readonly number[] {
  const attempts = new Set<number>([1]);
  for (const event of events) {
    const stepPath = stringProperty(event.payload, "stepPath");
    if (stepPath === parentStepPath) {
      attempts.add(numberProperty(event.payload, "attempt") ?? 1);
      continue;
    }
    const stepPathAttempt = stepPath === undefined
      ? undefined
      : parallelAttemptFromBranchPath(parentStepPath, stepPath);
    if (stepPathAttempt !== undefined) {
      attempts.add(stepPathAttempt);
    }
    const branchPath = stringProperty(event.payload, "branchPath");
    const branchPathAttempt = branchPath === undefined
      ? undefined
      : parallelAttemptFromBranchPath(parentStepPath, branchPath);
    if (branchPathAttempt !== undefined) {
      attempts.add(branchPathAttempt);
    }
  }
  return [...attempts].sort((left, right) => left - right);
}

function parallelAttemptFromBranchPath(
  parentStepPath: string,
  branchPath: string,
): number | undefined {
  if (branchPath.startsWith(`${parentStepPath}[`)) {
    return 1;
  }
  const prefix = `${parentStepPath}@attempt_`;
  if (!branchPath.startsWith(prefix)) {
    return undefined;
  }
  const rest = branchPath.slice(prefix.length);
  const match = /^(\d+)\[/u.exec(rest);
  if (match?.[1] === undefined) {
    return undefined;
  }
  const attempt = Number(match[1]);
  return Number.isSafeInteger(attempt) && attempt > 0 ? attempt : undefined;
}

function parallelBranchFactPath(
  parentStepPath: string,
  attempt: number,
  event: EventEnvelope,
): string | undefined {
  if (
    (event.type === "ParallelBranchCompleted" || event.type === "ParallelBranchFailed") &&
    event.payload.stepPath === parentStepPath &&
    eventAttemptMatches(event.payload, attempt)
  ) {
    return stringProperty(event.payload, "branchPath");
  }

  const stepPath = stringProperty(event.payload, "stepPath");
  if (stepPath === undefined) {
    return undefined;
  }
  return branchPathFromDescendantStepPath(parentStepPath, attempt, stepPath);
}

function branchPathFromDescendantStepPath(
  parentStepPath: string,
  attempt: number,
  stepPath: string,
): string | undefined {
  const prefix = `${parallelAttemptPath(parentStepPath, attempt)}[`;
  if (!stepPath.startsWith(prefix)) {
    return undefined;
  }
  const closingIndex = stepPath.indexOf("]", prefix.length);
  if (closingIndex === -1) {
    return undefined;
  }
  const branchPath = stepPath.slice(0, closingIndex + 1);
  return stepPath.startsWith(`${branchPath}.`) ? branchPath : undefined;
}

function lwirUsesForStepPath(
  workflow: LwirWorkflow,
  stepPath: string,
): LwirStep["uses"] | undefined {
  if (!isTopLevelStepPath(stepPath)) {
    return undefined;
  }
  return workflow.steps.find((step) => step.id === stepPath)?.uses;
}

function validateStepOutput(
  step: LwirStep,
  output: unknown,
  contract: LwirStep["output"],
): void {
  if (contract === undefined) {
    return;
  }
  const label = `Step '${step.id}' output`;
  switch (contract.mode) {
    case "text":
      if (typeof output !== "string") {
        throw new RuntimeStepSchemaError(`${label} does not match text output mode.`);
      }
      return;
    case "choice":
      if (typeof output !== "string" || !(contract.values ?? []).includes(output)) {
        throw new RuntimeStepSchemaError(`${label} does not match choice output mode.`);
      }
      return;
    case "object":
      if (!isRecord(output)) {
        throw new RuntimeStepSchemaError(`${label} does not match object output mode.`);
      }
      validateJsonSchema(contract.schema, output, label);
      return;
    case "array":
      if (!Array.isArray(output)) {
        throw new RuntimeStepSchemaError(`${label} does not match array output mode.`);
      }
      validateJsonSchema(contract.schema, output, label);
      return;
    case "json":
      if (contract.schema !== undefined) {
        validateJsonSchema(contract.schema, output, label);
      }
      return;
  }
}

function snapshotStepOutputContract(contract: LwirStep["output"]): LwirStep["output"] {
  return contract === undefined ? undefined : deepFreezeJsonLike(cloneJsonLike(contract));
}

function cloneJsonLike<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => cloneJsonLike(item)) as T;
  }
  if (isRecord(value)) {
    const clone: JsonRecord = {};
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) {
        clone[key] = cloneJsonLike(item);
      }
    }
    return clone as T;
  }
  return value;
}

function deepFreezeJsonLike<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const item of value) {
      deepFreezeJsonLike(item);
    }
    return Object.freeze(value) as T;
  }
  if (isRecord(value)) {
    for (const item of Object.values(value)) {
      deepFreezeJsonLike(item);
    }
    return Object.freeze(value) as T;
  }
  return value;
}

function stepOutputSchemaHash(contract: LwirStep["output"]): string | undefined {
  if (contract === undefined) {
    return undefined;
  }
  switch (contract.mode) {
    case "text":
      return sha256Digest({ type: "string" });
    case "choice":
      return sha256Digest({ type: "string", enum: [...(contract.values ?? [])] });
    case "object":
    case "array":
    case "json":
      return contract.schema === undefined ? undefined : sha256Digest(contract.schema);
  }
}

function validateWorkflowOutput(workflow: LwirWorkflow, output: unknown): void {
  validateJsonSchema(workflow.output.schema, output, "Workflow output");
}

function assertWorkflowStepIdsSafe(steps: readonly LwirStep[]): void {
  for (const step of steps) {
    if (/[.[\]]/u.test(step.id)) {
      throw new Error(
        `Step id '${step.id}' contains a reserved path delimiter: '.', '[', or ']'.`,
      );
    }
    if (/@attempt_/u.test(step.id)) {
      throw new Error(`Step id '${step.id}' contains reserved retry path marker '@attempt_N'.`);
    }
    assertWorkflowStepIdsSafe(step.steps ?? []);
  }
}

function assertNoNestedParallelSteps(
  steps: readonly LwirStep[],
  insideParallel = false,
): void {
  for (const step of steps) {
    if (insideParallel && step.uses === "parallel") {
      throw new RuntimeIntegrityError(
        `Nested parallel steps are not supported in alpha runtime: '${step.id}'.`,
      );
    }
    assertNoNestedParallelSteps(step.steps ?? [], insideParallel || step.uses === "parallel");
  }
}

function assertTerminalOutputContractCompatible(
  workflow: LwirWorkflow,
  finalStep: LwirStep | undefined,
): void {
  if (finalStep?.output === undefined) {
    return;
  }
  const workflowType = schemaPrimaryType(workflow.output.schema);
  const stepType = outputPrimaryType(finalStep.output);
  if (workflowType === undefined || stepType === undefined || workflowType === stepType) {
    return;
  }
  throw new RuntimeStepSchemaError(
    `Terminal step '${finalStep.id}' output mode '${finalStep.output.mode}' is incompatible with workflow output schema type '${workflowType}'.`,
  );
}

function schemaPrimaryType(schema: NormalizedSchemaDescriptor | undefined): string | undefined {
  if (!isRecord(schema)) {
    return undefined;
  }
  const type = schema.type;
  if (typeof type === "string") {
    return type;
  }
  if (Array.isArray(type) && type.length === 1 && typeof type[0] === "string") {
    return type[0];
  }
  return undefined;
}

function outputPrimaryType(output: NonNullable<LwirStep["output"]>): string | undefined {
  switch (output.mode) {
    case "text":
    case "choice":
      return "string";
    case "object":
      return "object";
    case "array":
      return "array";
    case "json":
      return schemaPrimaryType(output.schema);
  }
}

function validateJsonSchema(
  schema: NormalizedSchemaDescriptor | undefined,
  value: unknown,
  label: string,
): void {
  if (schema === undefined || schema === true) {
    return;
  }
  if (schema === false) {
    throw new RuntimeStepSchemaError(`${label} schema rejects all values.`);
  }
  const ajv = getAjv();
  const valid = ajv.validate(schema, value);
  if (valid !== true) {
    throw new RuntimeStepSchemaError(
      `${label} does not match schema: ${
        ajv.errorsText?.(ajv.errors) ?? "schema validation failed"
      }`,
    );
  }
}

async function executeAiStep(
  options: ExecuteWorkflowVersionOptions,
  step: LwirStep,
  context: RuntimeStepContext,
  runtimeState: RuntimeState,
  outputContract: LwirStep["output"],
): Promise<StepAdapterResult> {
  const rawConfig = configFor(step);
  const modelSlot = stringConfig(rawConfig, "model", step.id);
  assertAllowedModel(options.workflowVersion.lwir, modelSlot);
  if (!Object.hasOwn(options.models ?? {}, modelSlot)) {
    throw new RuntimeCapabilityDriftError(
      `capability_drift: model '${modelSlot}' is not registered for step '${step.id}'. Re-run runWorkflow() to compile a fresh WorkflowVersion against the current capability set.`,
    );
  }
  const modelBinding = options.models?.[modelSlot];
  assertModelCapabilityLock(options.workflowVersion, modelSlot, modelBinding);
  const model = isModelSlot(modelBinding) ? modelBinding.aiSdkModel : modelBinding;
  const harnessResult = await maybeExecuteAiStepWithWorkerHarness(
    options,
    step,
    context,
    runtimeState,
    modelSlot,
    model,
  );
  if (harnessResult !== undefined) {
    return harnessResult;
  }
  throw new RuntimeCapabilityDriftError(
    `capability_drift: worker harness is required for ai.generate step '${step.id}'. Re-run runWorkflow() to compile a fresh WorkflowVersion against the current capability set.`,
  );
}

function assertAllowedModel(workflow: LwirWorkflow, modelSlot: string): void {
  const allowedModels = workflow.permissions?.models ?? [];
  if (!allowedModels.includes(modelSlot)) {
    throw new RuntimeCapabilityDriftError(
      `capability_drift: model '${modelSlot}' is not allowed by this WorkflowVersion. Re-run runWorkflow() to compile a fresh WorkflowVersion against the current capability set.`,
    );
  }
}

async function executeToolStep(
  options: ExecuteWorkflowVersionOptions,
  step: LwirStep,
  context: RuntimeStepContext,
  runtimeState: RuntimeState,
): Promise<StepAdapterResult> {
  const config = configFor(step);
  const toolName = stringConfig(config, "tool", step.id);
  assertAllowedTool(options.workflowVersion.lwir, toolName);

  const registry = options.tools;
  const descriptor = toolDescriptorFromRegistry(registry, toolName);
  const toolHandler = toolHandlerFromRegistry(registry, toolName);

  if (descriptor === undefined) {
    throw new RuntimeCapabilityDriftError(
      `capability_drift: tool '${toolName}' is not registered for step '${step.id}'. Re-run runWorkflow() to compile a fresh WorkflowVersion against the current capability set.`,
    );
  }
  if (toolHandler === undefined) {
    throw new RuntimeConfigError(
      `runtime_config_error: tool '${toolName}' has no handler in the provided registry.`,
    );
  }

  assertToolCapabilityLockFromDescriptor(options.workflowVersion, toolName, descriptor);
  validateToolInputFromDescriptor(toolName, descriptor, context.input);
  assertToolApprovalSupportedFromDescriptor(toolName, descriptor);

  let currentState = await record(runtimeState, options.world, context.runId, {
    type: "ToolCallStarted",
    payload: {
      stepPath: context.stepPath,
      stepId: step.id,
      attempt: context.attempt,
      tool: toolName,
    },
  });
  assertNotCancelled(options.signal);
  const output = await raceSignal(
    () => toolHandler(context.input, context),
    options.signal,
  );
  assertNotCancelled(options.signal);
  currentState = await record(currentState, options.world, context.runId, {
    type: "ToolCallCompleted",
    payload: {
      stepPath: context.stepPath,
      stepId: step.id,
      attempt: context.attempt,
      tool: toolName,
    },
  });
  return { result: { output }, runtimeState: currentState };
}

function toolDescriptorFromRegistry(
  registry: ToolRegistry | undefined,
  toolName: string,
): {
  readonly description: string;
  readonly inputSchema?: unknown;
  readonly outputSchema?: unknown;
  readonly needsApproval?: boolean | ((args: any, options?: any) => boolean | PromiseLike<boolean>);
} | undefined {
  const tool = registry?.get(toolName);
  if (tool === undefined) {
    return undefined;
  }
  const description = typeof tool.description === "string" ? tool.description : "";
  return {
    description,
    ...(tool.inputSchema === undefined ? {} : { inputSchema: tool.inputSchema }),
    ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
    ...(tool.needsApproval === undefined ? {} : { needsApproval: tool.needsApproval }),
  };
}

function toolHandlerFromRegistry(
  registry: ToolRegistry | undefined,
  toolName: string,
): RuntimeToolHandler | undefined {
  const tool = registry?.get(toolName);
  if (tool === undefined || typeof tool.execute !== "function") {
    return undefined;
  }
  return (input, context) => {
    const abortSignal = context.signal ?? new AbortController().signal;
    const options = {
      ...context,
      toolCallId: `${context.runId}:${context.stepPath}:attempt-${context.attempt}`,
      messages: [],
      abortSignal,
      experimental_context: context,
    };
    return tool.execute?.(input, options);
  };
}

function assertToolApprovalSupportedFromDescriptor(
  toolName: string,
  descriptor: {
    readonly description: string;
    readonly inputSchema?: unknown;
    readonly outputSchema?: unknown;
    readonly needsApproval?: boolean | ((args: any, options?: any) => boolean | PromiseLike<boolean>);
  },
): void {
  const needsApproval = descriptor.needsApproval;
  if (needsApproval === undefined || needsApproval === false) {
    return;
  }
  throw new RuntimeConfigError(
    `runtime_config_error: tool '${toolName}' requires approval, but alpha runtime approvals are not implemented.`,
  );
}

function assertAllowedTool(workflow: LwirWorkflow, toolName: string): void {
  const allowedTools = workflow.permissions?.tools ?? [];
  if (!allowedTools.includes(toolName)) {
    throw new RuntimeCapabilityDriftError(
      `capability_drift: tool '${toolName}' is not allowed by this WorkflowVersion. Re-run runWorkflow() to compile a fresh WorkflowVersion against the current capability set.`,
    );
  }
}

function assertModelCapabilityLock(
  workflowVersion: ExecuteWorkflowVersionOptions["workflowVersion"],
  modelSlot: string,
  modelBinding: unknown,
): void {
  const lock = workflowVersionLock(workflowVersion);
  if (lock === undefined) {
    return;
  }
  const expectedIndex = lock.modelSlots.findIndex((slot) => slot.slotId === modelSlot);
  const expected = expectedIndex === -1 ? undefined : lock.modelSlots[expectedIndex];
  if (expected === undefined) {
    throw new RuntimeCapabilityDriftError(
      `capability_drift: model '${modelSlot}' is missing from WorkflowVersion lock. Re-run runWorkflow() to compile a fresh WorkflowVersion against the current capability set.`,
    );
  }
  const metadataHashes = runtimeModelMetadataCandidates(modelSlot, modelBinding)
    .map((metadata) => sha256Digest(safeModelMetadata(metadata)));
  const model = isModelSlot(modelBinding) ? modelBinding.aiSdkModel : modelBinding;
  const modelIdentityHash = sha256Digest(modelIdentityFor(modelSlot, model));
  if (
    !metadataHashes.includes(expected.metadataHash) ||
    modelIdentityHash !== expected.modelIdentityHash
  ) {
    throw new RuntimeCapabilityDriftError(
      `capability_drift: model '${modelSlot}' does not match WorkflowVersion lock. Re-run runWorkflow() to compile a fresh WorkflowVersion against the current capability set.`,
    );
  }
}

function runtimeModelMetadataCandidates(
  modelSlot: string,
  modelBinding: unknown,
): readonly JsonRecord[] {
  if (isModelSlot(modelBinding)) {
    return [createModelSlot(
      modelBinding.aiSdkModel,
      modelBinding.metadata as Parameters<typeof createModelSlot>[1],
    ).metadata];
  }
  const implicitMetadata = createModelSlot(modelBinding).metadata;
  const explicitSlotMetadata = createModelSlot(modelBinding, { id: modelSlot }).metadata;
  return [implicitMetadata, explicitSlotMetadata];
}

function assertToolCapabilityLockFromDescriptor(
  workflowVersion: ExecuteWorkflowVersionOptions["workflowVersion"],
  toolName: string,
  descriptor: {
    readonly description: string;
    readonly inputSchema?: unknown;
    readonly outputSchema?: unknown;
    readonly needsApproval?: boolean | ((args: any, options?: any) => boolean | PromiseLike<boolean>);
  },
): void {
  const lock = workflowVersionLock(workflowVersion);
  if (lock === undefined) {
    return;
  }
  const expected = lock.tools.find((entry) => entry.name === toolName && entry.scope === "global");
  if (expected === undefined) {
    throw new RuntimeCapabilityDriftError(
      `capability_drift: tool '${toolName}' is missing from WorkflowVersion lock. Re-run runWorkflow() to compile a fresh WorkflowVersion against the current capability set.`,
    );
  }
  const description = descriptor.description;
  const inputSchema = descriptor.inputSchema;
  const normalizedInputSchema =
    inputSchema === undefined ? undefined : normalizeSchema(inputSchema);
  const inputSchemaHash =
    normalizedInputSchema === undefined ? undefined : sha256Digest(normalizedInputSchema);
  const outputSchema = descriptor.outputSchema;
  const normalizedOutputSchema =
    outputSchema === undefined ? undefined : normalizeSchema(outputSchema);
  const outputSchemaHash =
    normalizedOutputSchema === undefined ? undefined : sha256Digest(normalizedOutputSchema);
  if (expected.approvalRequired === true) {
    throw new RuntimeConfigError(
      `runtime_config_error: tool '${toolName}' requires approval, but alpha runtime approvals are not implemented.`,
    );
  }
  if (
    sha256Digest(description) !== expected.descriptionHash ||
    inputSchemaHash !== expected.inputSchemaHash ||
    outputSchemaHash !== expected.outputSchemaHash
  ) {
    throw new RuntimeCapabilityDriftError(
      `capability_drift: tool '${toolName}' does not match WorkflowVersion lock. Re-run runWorkflow() to compile a fresh WorkflowVersion against the current capability set.`,
    );
  }
}

function validateToolInputFromDescriptor(
  toolName: string,
  descriptor: {
    readonly description: string;
    readonly inputSchema?: unknown;
    readonly outputSchema?: unknown;
    readonly needsApproval?: boolean | ((args: any, options?: any) => boolean | PromiseLike<boolean>);
  },
  input: unknown,
): void {
  const inputSchema = descriptor.inputSchema;
  if (inputSchema === undefined) {
    return;
  }
  const normalizedInputSchema = normalizeSchema(inputSchema);
  try {
    validateJsonSchema(normalizedInputSchema, input, `Tool '${toolName}' input`);
  } catch (error) {
    if (error instanceof RuntimeStepSchemaError) {
      throw new RuntimeConfigError(error.message);
    }
    throw error;
  }
}

function parallelConfigFor(step: LwirStep): ParallelConfig {
  const config = configFor(step);
  const fanIn = propertyValue(config, "fanIn");
  const cardinality = propertyValue(config, "cardinality");
  const maxBranches = config.maxBranches;
  const maxConcurrency = config.maxConcurrency;
  if (
    typeof config.items !== "string" ||
    typeof config.itemKey !== "string" ||
    !isRecord(cardinality) ||
    cardinality.kind !== "matches_items" ||
    typeof maxBranches !== "number" ||
    !Number.isInteger(maxBranches) ||
    maxBranches < 1 ||
    maxBranches > ALPHA_MAX_BRANCHES ||
    typeof maxConcurrency !== "number" ||
    !Number.isInteger(maxConcurrency) ||
    maxConcurrency < 1 ||
    maxConcurrency > maxBranches ||
    (config.failureMode !== "fail_fast" && config.failureMode !== "all_settled") ||
    !isRecord(fanIn) ||
    (fanIn.order !== "input" && fanIn.order !== "itemKey") ||
    fanIn.output !== "array"
  ) {
    throw new RuntimeConfigError(`Parallel step '${step.id}' has invalid runtime config.`);
  }
  return {
    items: config.items,
    itemKey: config.itemKey,
    cardinality: { kind: "matches_items" },
    maxBranches,
    maxConcurrency,
    failureMode: config.failureMode,
    fanIn: {
      order: fanIn.order,
      output: fanIn.output,
      ...(typeof fanIn.outputStep === "string" ? { outputStep: fanIn.outputStep } : {}),
    },
  };
}

async function parallelBranchesFor(
  options: ExecuteWorkflowVersionOptions,
  step: LwirStep,
  context: RuntimeStepContext,
  state: MaterializedRunState,
  config: ParallelConfig,
): Promise<readonly ParallelBranch[]> {
  const scope = scopeFromContext(context);
  const itemsContext = await expressionContextFor(
    options.world,
    step,
    options.workflowVersion.lwir,
    options.input,
    state,
    scope,
  );
  const items = resolveExpressionValue(
    config.items,
    itemsContext,
  );
  if (!Array.isArray(items)) {
    throw new RuntimeConfigError(
      `Parallel step '${step.id}' items expression must resolve to an array.`,
    );
  }
  if (items.length > config.maxBranches) {
    throw new RuntimeConfigError(
      `Parallel step '${step.id}' resolved ${items.length} item(s), exceeding maxBranches ${config.maxBranches}.`,
    );
  }

  const itemKeys = new Set<string>();
  const branches: ParallelBranch[] = [];
  for (const [index, item] of items.entries()) {
    const itemContext = await expressionContextFor(
      options.world,
      step,
      options.workflowVersion.lwir,
      options.input,
      state,
      {
        ...scope,
        hasItem: true,
        item,
      },
    );
    const itemKey = resolveExpressionValue(
      config.itemKey,
      itemContext,
    );
    if (typeof itemKey !== "string" || itemKey.length === 0) {
      throw new RuntimeConfigError(
        `Parallel step '${step.id}' itemKey must resolve to a non-empty string.`,
      );
    }
    if (itemKeys.has(itemKey)) {
      throw new RuntimeConfigError(`Duplicate itemKey '${itemKey}' in parallel step '${step.id}'.`);
    }
    itemKeys.add(itemKey);
    branches.push({
      index,
      item,
      itemKey,
      branchPath: `${parallelAttemptPath(context.stepPath, context.attempt)}[${
        encodeBranchPathKey(itemKey)
      }]`,
    });
  }
  return branches;
}

function parallelAttemptPath(stepPath: string, attempt: number): string {
  return attempt === 1 ? stepPath : `${stepPath}@attempt_${attempt}`;
}

function attemptIdFor(attempt: number): string {
  return `attempt_${attempt}`;
}

function parallelGroupStartedFor(
  parentStepPath: string,
  attempt: number,
  events: readonly EventEnvelope[],
): boolean {
  return events.some((event) =>
    event.type === "ParallelGroupStarted" &&
    event.payload.stepPath === parentStepPath &&
    eventAttemptMatches(event.payload, attempt)
  );
}

function parallelBranchScheduledFor(
  parentStepPath: string,
  branchPath: string,
  attempt: number,
  events: readonly EventEnvelope[],
): boolean {
  return events.some((event) =>
    event.type === "ParallelBranchScheduled" &&
    event.payload.stepPath === parentStepPath &&
    event.payload.branchPath === branchPath &&
    eventAttemptMatches(event.payload, attempt)
  );
}

function parallelGroupTerminalFor(
  parentStepPath: string,
  attempt: number,
  type: "ParallelGroupCompleted" | "ParallelGroupFailed",
  events: readonly EventEnvelope[],
): boolean {
  return events.some((event) =>
    event.type === type &&
    event.payload.stepPath === parentStepPath &&
    eventAttemptMatches(event.payload, attempt)
  );
}

function eventAttemptMatches(payload: unknown, attempt: number): boolean {
  const eventAttempt = propertyValue(payload, "attempt");
  return eventAttempt === attempt || (attempt === 1 && eventAttempt === undefined);
}

function parallelFanInOutput(
  config: ParallelConfig,
  results: readonly (ParallelBranchResult | undefined)[],
): readonly unknown[] {
  if (results.some((result) => result === undefined)) {
    throw new RuntimeIntegrityError("Parallel branch results are incomplete.");
  }
  const present = results.filter((result): result is ParallelBranchResult => result !== undefined);
  const ordered = [...present].sort((left, right) => {
    if (config.fanIn.order === "itemKey") {
      return left.itemKey < right.itemKey ? -1 : left.itemKey > right.itemKey ? 1 : 0;
    }
    return left.index - right.index;
  });

  return ordered.map((result) => {
    if (result.status === "rejected") {
      if (config.failureMode === "fail_fast") {
        throw result.cause;
      }
      return {
        itemKey: result.itemKey,
        status: "failed",
        error: result.error,
        artifacts: result.artifactRefs,
      };
    }
    return {
      itemKey: result.itemKey,
      status: "completed",
      output: result.output,
      outputRef: result.outputRef,
      artifacts: result.artifactRefs,
    };
  });
}

function branchArtifactRefs(
  results: readonly (ParallelBranchResult | undefined)[],
): readonly ArtifactRef[] {
  const refs = results.flatMap((result) => result?.artifactRefs ?? []);
  return uniqueRefs(refs);
}

async function previousBranchResultFor(
  world: LocalWorld,
  parallelStep: LwirStep,
  parentStepPath: string,
  attempt: number,
  branch: ParallelBranch,
  state: MaterializedRunState,
  events: readonly EventEnvelope[],
): Promise<ParallelBranchResult | undefined> {
  const terminalEvent = previousBranchTerminalEvent(parentStepPath, branch.branchPath, attempt, events);
  if (terminalEvent?.type === "ParallelBranchFailed") {
    const errorValue = propertyValue(terminalEvent.payload, "error");
    const error = isRecord(errorValue)
      ? errorValue
      : { message: "Parallel branch failed.", retriable: false };
    return {
      index: branch.index,
      itemKey: branch.itemKey,
      status: "rejected",
      error,
      artifactRefs: artifactRefsForBranch(events, branch.branchPath),
      cause: errorCauseFromEnvelope(error),
    };
  }

  if (terminalEvent?.type === "ParallelBranchCompleted") {
    return fulfilledBranchResultFromState(world, parallelStep, branch, state, events);
  }
  return undefined;
}

async function previousOrResumableBranchResultFor(
  world: LocalWorld,
  parallelStep: LwirStep,
  parentStepPath: string,
  attempt: number,
  branch: ParallelBranch,
  state: MaterializedRunState,
  events: readonly EventEnvelope[],
  allowResumableStepState: boolean,
): Promise<ParallelBranchResult | undefined> {
  const previous = await previousBranchResultFor(
    world,
    parallelStep,
    parentStepPath,
    attempt,
    branch,
    state,
    events,
  );
  if (previous !== undefined || !allowResumableStepState) {
    return previous;
  }
  return branchResultFromStateForResume(world, parallelStep, branch, state, events);
}

async function recordMissingParallelBranchTerminal(
  runtimeState: RuntimeState,
  world: LocalWorld,
  runId: RunId,
  parentStepPath: string,
  parentStepId: string,
  attempt: number,
  branch: ParallelBranch,
  result: ParallelBranchResult,
): Promise<RuntimeState> {
  if (previousBranchTerminalEvent(parentStepPath, branch.branchPath, attempt, runtimeState.events)) {
    return runtimeState;
  }
  if (result.status === "fulfilled") {
    return record(runtimeState, world, runId, {
      type: "ParallelBranchCompleted",
      payload: {
        stepPath: parentStepPath,
        stepId: parentStepId,
        attempt,
        attemptId: attemptIdFor(attempt),
        branchPath: branch.branchPath,
        itemKey: branch.itemKey,
        branchIndex: branch.index,
        outputRef: result.outputRef,
        artifactRefs: result.artifactRefs,
      },
    });
  }
  return record(runtimeState, world, runId, {
    type: "ParallelBranchFailed",
    payload: {
      stepPath: parentStepPath,
      stepId: parentStepId,
      attempt,
      attemptId: attemptIdFor(attempt),
      branchPath: branch.branchPath,
      itemKey: branch.itemKey,
      branchIndex: branch.index,
      error: result.error,
      artifactRefs: result.artifactRefs,
    },
  });
}

function previousBranchTerminalEvent(
  parentStepPath: string,
  branchPath: string,
  attempt: number,
  events: readonly EventEnvelope[],
): EventEnvelope | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (
      event !== undefined &&
      (event.type === "ParallelBranchCompleted" || event.type === "ParallelBranchFailed") &&
      event.payload.stepPath === parentStepPath &&
      event.payload.branchPath === branchPath &&
      eventAttemptMatches(event.payload, attempt)
    ) {
      return event;
    }
  }
  return undefined;
}

async function branchResultFromStateForResume(
  world: LocalWorld,
  parallelStep: LwirStep,
  branch: ParallelBranch,
  state: MaterializedRunState,
  events: readonly EventEnvelope[],
): Promise<ParallelBranchResult | undefined> {
  const fulfilled = await fulfilledBranchResultFromState(world, parallelStep, branch, state, events);
  if (fulfilled !== undefined) {
    return fulfilled;
  }
  const branchPrefix = `${branch.branchPath}.`;
  const failedStep = Object.values(state.steps).find((step) =>
    step.stepPath.startsWith(branchPrefix) && step.status === "failed"
  );
  if (failedStep === undefined) {
    return undefined;
  }
  const error = isRecord(failedStep.error)
    ? failedStep.error
    : { message: "Parallel branch failed.", retriable: false };
  if (error.retriable === true) {
    return undefined;
  }
  return {
    index: branch.index,
    itemKey: branch.itemKey,
    status: "rejected",
    error,
    artifactRefs: artifactRefsForBranch(events, branch.branchPath),
    cause: errorCauseFromEnvelope(error),
  };
}

async function fulfilledBranchResultFromState(
  world: LocalWorld,
  parallelStep: LwirStep,
  branch: ParallelBranch,
  state: MaterializedRunState,
  events: readonly EventEnvelope[],
): Promise<ParallelBranchResult | undefined> {
  const finalStep = finalOutputStep(parallelStep.steps ?? []);
  if (finalStep === undefined) {
    return undefined;
  }
  const finalState = state.steps[`${branch.branchPath}.${finalStep.id}`];
  if (finalState?.status !== "completed" || finalState.outputRef === undefined) {
    return undefined;
  }
  return {
    index: branch.index,
    itemKey: branch.itemKey,
    status: "fulfilled",
    output: await outputValueForCompletedStep(world, finalState),
    outputRef: finalState.outputRef,
    artifactRefs: artifactRefsForBranch(events, branch.branchPath),
  };
}

async function outputValueForCompletedStep(
  world: LocalWorld,
  step: MaterializedRunState["steps"][string],
): Promise<unknown> {
  if (step.outputRef === undefined) {
    return "output" in step ? step.output : undefined;
  }
  const artifactPayload = (await world.readArtifact(step.outputRef)).payload;
  if ("output" in step && sha256Digest(step.output) !== sha256Digest(artifactPayload)) {
    throw new RuntimeIntegrityError(
      "StepCompleted output does not match output artifact.",
    );
  }
  return artifactPayload;
}

function artifactRefsFromValue(value: unknown): readonly ArtifactRef[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((ref): ref is ArtifactRef =>
    typeof ref === "string" && ref.startsWith("artifact://")
  );
}

function artifactRefFromValue(value: unknown): ArtifactRef | undefined {
  return typeof value === "string" && value.startsWith("artifact://")
    ? value as ArtifactRef
    : undefined;
}

function errorCauseFromEnvelope(error: JsonRecord): Error {
  if (isTerminalCancellationCauseCode(error.causeCode)) {
    return new RuntimeCancellationError(
      error.causeCode,
      typeof error.message === "string" ? error.message : "Run was cancelled.",
    );
  }
  if (error.causeCode === "capability_drift") {
    return new RuntimeCapabilityDriftError(
      typeof error.message === "string" ? error.message : "Capability drift.",
    );
  }
  if (error.causeCode === "runtime_config_error") {
    return new RuntimeConfigError(
      typeof error.message === "string" ? error.message : "Runtime config error.",
    );
  }
  if (error.causeCode === "step_schema_error") {
    return new RuntimeStepSchemaError(
      typeof error.message === "string" ? error.message : "Step output schema validation failed.",
    );
  }
  const cause = new Error(
    typeof error.message === "string" ? error.message : "Parallel branch failed.",
  );
  if (typeof error.name === "string") {
    cause.name = error.name;
  }
  return cause;
}

function encodeBranchPathKey(itemKey: string): string {
  return encodeURIComponent(itemKey).replace(/\./gu, "%2E");
}

async function record(
  runtimeState: RuntimeState,
  world: LocalWorld,
  runId: RunId,
  event: EventInput,
): Promise<RuntimeState> {
  await world.appendEvent(runId, event);
  const events = await world.listEvents(runId);
  return {
    events,
    materialized: materializeRunStateFromEvents(runId, events),
  };
}

async function loadRuntimeState(world: LocalWorld, runId: RunId): Promise<RuntimeState> {
  const events = await world.listEvents(runId);
  return {
    events,
    materialized: materializeRunStateFromEvents(runId, events),
  };
}

function emptyRuntimeState(runId: RunId): RuntimeState {
  return {
    events: [],
    materialized: materializeRunStateFromEvents(runId, []),
  };
}

function completedStepIds(
  steps: readonly LwirStep[],
  state: MaterializedRunState,
): Set<string> {
  const completed = new Set<string>();
  for (const step of steps) {
    if ((step.maxVisits ?? 1) <= 1) {
      // Single-visit step: path is just step.id
      if (state.steps[step.id]?.status === "completed") {
        completed.add(step.id);
      }
    } else {
      // Multi-visit step: check for any completed visit (e.g. worker.visit[0])
      const visitPrefix = `${step.id}.visit[`;
      for (const [stepPath, stepState] of Object.entries(state.steps)) {
        if (stepPath.startsWith(visitPrefix) && stepState.status === "completed") {
          completed.add(step.id);
          break;
        }
      }
    }
  }
  return completed;
}

/**
 * Return the set of step IDs that are transitively downstream (via needs edges) of
 * the given root step, NOT including the root itself. Used to re-add loop-body steps
 * to the scheduling pool after a decision routes back to a prior step (back-edge).
 */
function transitiveDownstreamOf(steps: readonly LwirStep[], rootId: string): Set<string> {
  const result = new Set<string>();
  const frontier = new Set([rootId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const step of steps) {
      if (!result.has(step.id) && !frontier.has(step.id)) {
        if ((step.needs ?? []).some((need) => frontier.has(need))) {
          result.add(step.id);
          frontier.add(step.id);
          changed = true;
        }
      }
    }
  }
  return result;
}

/**
 * For crash-and-resume of decision workflows: scan the committed event log to find
 * the most recent decision-step completion whose chosen target hasn't started its
 * next visit yet. Returns the target step id, or null if no pending routing exists.
 *
 * Only considers top-level decision events. Branch-scoped paths (those whose stepPath
 * contains a "[" before any ".visit[" marker — e.g. "scan[k_item1].route") are skipped
 * to prevent cross-scope contamination when a parallel branch decision happens to name
 * the same step id as a top-level step.
 */
function pendingDecisionTarget(
  steps: readonly LwirStep[],
  state: MaterializedRunState,
  events: readonly EventEnvelope[],
): string | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event === undefined || event.type !== "StepCompleted") {
      continue;
    }
    const stepPath = stringProperty(event.payload, "stepPath");
    if (typeof stepPath !== "string") {
      continue;
    }
    // Skip branch-scoped events.  Top-level paths are either plain step ids ("worker")
    // or visit-indexed ids ("worker.visit[0]").  Branch paths always contain "[" before
    // ".visit[" — e.g. "scan[k_item1].route" or "scan[k_item1].route.visit[0]".
    // The distinguishing rule: if the path contains "[" at all, strip the ".visit[N]"
    // suffix and check whether the remainder still contains "[".  If so, it is a branch path.
    const pathWithoutVisit = stepPath.replace(/\.visit\[\d+\]$/, "");
    if (pathWithoutVisit.includes("[")) {
      continue; // branch-scoped — skip
    }
    const metadata = event.payload.metadata;
    if (!isRecord(metadata) || metadata.uses !== "decision") {
      continue;
    }
    const output = event.payload.output;
    if (!isRecord(output) || typeof output.chosen !== "string") {
      continue;
    }
    const chosen = output.chosen as string;
    if (chosen === "end") {
      return null;
    }
    const targetStep = steps.find((s) => s.id === chosen);
    if (targetStep === undefined) {
      return null;
    }
    // The target step's next visit index is the current completed-visit count.
    const nextVisitIndex = visitIndexFor(targetStep, "", state);
    const nextPath = stepPathFor(targetStep, "", nextVisitIndex);
    if (!Object.hasOwn(state.steps, nextPath)) {
      // Target step hasn't started this visit yet — this is the pending routing.
      return chosen;
    }
    // Target step's visit has already started or completed; no pending routing.
    return null;
  }
  return null;
}

/**
 * Compute the most recent committed step path for a DAG final step (one that may have
 * maxVisits > 1 in principle, but in practice is always visit[0] for terminal DAG steps).
 */
function finalStepPathFor(step: LwirStep, state: MaterializedRunState): string | undefined {
  const directPath = step.id;
  if (Object.hasOwn(state.steps, directPath)) {
    return directPath;
  }
  // Check for visit-indexed path (maxVisits > 1).
  const visitIndex = visitIndexFor(step, "", state);
  if (visitIndex === 0) {
    return undefined;
  }
  return stepPathFor(step, "", visitIndex - 1);
}

function completedStepIdsForScope(
  steps: readonly LwirStep[],
  state: MaterializedRunState,
  branchPath: string,
  allowedTopLevelStepIds: readonly string[],
): Set<string> {
  const completed = new Set<string>();
  const branchStepIds = new Set(steps.map((step) => step.id));
  const allowedTopLevelSteps = new Set(allowedTopLevelStepIds);
  for (const [stepPath, step] of Object.entries(state.steps)) {
    if (
      step.status === "completed" &&
      isTopLevelStepPath(stepPath) &&
      allowedTopLevelSteps.has(stepPath) &&
      !branchStepIds.has(stepPath)
    ) {
      completed.add(stepPath);
    }
  }
  for (const step of steps) {
    if ((step.maxVisits ?? 1) <= 1) {
      // Single-visit branch step: path is "<branchPath>.<stepId>"
      if (state.steps[`${branchPath}.${step.id}`]?.status === "completed") {
        completed.add(step.id);
      }
    } else {
      // Multi-visit branch step: check for any completed visit path
      const visitPrefix = `${branchPath}.${step.id}.visit[`;
      for (const [stepPath, stepState] of Object.entries(state.steps)) {
        if (stepPath.startsWith(visitPrefix) && stepState.status === "completed") {
          completed.add(step.id);
          break;
        }
      }
    }
  }
  return completed;
}

function artifactRefsForBranch(
  events: readonly EventEnvelope[],
  branchPath: string,
): readonly ArtifactRef[] {
  const refs = new Set<ArtifactRef>();
  const branchPrefix = `${branchPath}.`;
  for (const event of events) {
    if (event.type !== "StepCompleted") {
      continue;
    }
    const stepPath = stringProperty(event.payload, "stepPath");
    if (stepPath === undefined || !stepPath.startsWith(branchPrefix)) {
      continue;
    }
    const outputRef = artifactRefFromValue(event.payload.outputRef);
    if (outputRef !== undefined) {
      refs.add(outputRef);
    }
    for (const ref of artifactRefsFromValue(event.payload.artifactRefs)) {
      refs.add(ref);
    }
  }
  return [...refs];
}

async function resolveStepInput(
  world: LocalWorld,
  step: LwirStep,
  workflow: LwirWorkflow,
  workflowInput: unknown,
  state: MaterializedRunState,
  scope: StepExecutionScope = {},
): Promise<unknown> {
  const expressionContext = await expressionContextFor(
    world,
    step,
    workflow,
    workflowInput,
    state,
    scope,
  );
  if (step.input !== undefined) {
    return resolveExpressionValue(step.input, expressionContext);
  }
  const config = step.with;
  if (isRecord(config) && config.args !== undefined) {
    return resolveExpressionValue(config.args, expressionContext);
  }
  return scope.hasItem === true ? scope.item : workflowInput;
}

async function resolveStepConfig(
  world: LocalWorld,
  config: JsonRecord,
  step: LwirStep,
  workflow: LwirWorkflow,
  workflowInput: unknown,
  state: MaterializedRunState,
  scope: StepExecutionScope = {},
): Promise<JsonRecord> {
  const expressionContext = await expressionContextFor(
    world,
    step,
    workflow,
    workflowInput,
    state,
    scope,
  );
  return resolveExpressionValue(config, expressionContext) as JsonRecord;
}

async function expressionContextFor(
  world: LocalWorld,
  step: LwirStep,
  workflow: LwirWorkflow,
  workflowInput: unknown,
  state: MaterializedRunState,
  scope: StepExecutionScope = {},
): Promise<ExpressionContext> {
  return {
    input: workflowInput,
    ...(scope.hasItem === true ? { item: scope.item } : {}),
    step,
    workflow,
    steps: await stepOutputs(
      world,
      state,
      scope.branchPath,
      scope.allowedTopLevelStepIds,
    ),
  };
}

function scopeFromContext(context: RuntimeStepContext): StepExecutionScope {
  return {
    ...(context.hasItem === true ? { hasItem: true, item: context.item } : {}),
    ...(context.branchPath === undefined ? {} : { branchPath: context.branchPath }),
    ...(context.allowedTopLevelStepIds === undefined
      ? {}
      : { allowedTopLevelStepIds: context.allowedTopLevelStepIds }),
  };
}

async function stepOutputs(
  world: LocalWorld,
  state: MaterializedRunState,
  branchPath?: string,
  allowedTopLevelStepIds: readonly string[] = [],
): Promise<Record<string, { readonly output?: unknown; readonly visits?: readonly unknown[] }>> {
  const outputs: Record<
    string,
    { readonly output?: unknown; readonly visits?: readonly unknown[] }
  > = Object.create(null) as Record<
    string,
    { readonly output?: unknown; readonly visits?: readonly unknown[] }
  >;
  const branchPrefix = branchPath === undefined ? undefined : `${branchPath}.`;
  if (branchPrefix !== undefined) {
    const allowedTopLevelSteps = new Set(allowedTopLevelStepIds);
    for (const [stepPath, step] of Object.entries(state.steps)) {
      if (
        step.status === "completed" &&
        isTopLevelStepPath(stepPath) &&
        allowedTopLevelSteps.has(stepPath)
      ) {
        outputs[stepPath] = await stepOutputEnvelope(world, step);
      }
    }
  }
  // Collect all completed step paths, grouping multi-visit paths by stepId.
  // Multi-visit paths have the shape "<prefix?><stepId>.visit[N]".
  // We aggregate these into { visits: [output0, output1, ...] } keyed by stepId.
  const visitBuffers = new Map<string, { index: number; output: unknown }[]>();
  for (const [stepPath, step] of Object.entries(state.steps)) {
    if (step.status !== "completed") {
      continue;
    }
    const rawKey = branchPrefix === undefined
      ? stepPath
      : stepPath.startsWith(branchPrefix)
        ? stepPath.slice(branchPrefix.length)
        : undefined;
    if (rawKey === undefined) {
      continue;
    }
    // Detect multi-visit suffix: "<stepId>.visit[N]"
    const visitMatch = /^(.+)\.visit\[(\d+)\]$/.exec(rawKey);
    if (visitMatch !== null) {
      const stepId = visitMatch[1];
      const visitIndex = Number(visitMatch[2]);
      if (stepId === undefined) {
        continue;
      }
      let buffer = visitBuffers.get(stepId);
      if (buffer === undefined) {
        buffer = [];
        visitBuffers.set(stepId, buffer);
      }
      const output = await outputValueForCompletedStep(world, step);
      buffer.push({ index: visitIndex, output });
    } else {
      outputs[rawKey] = await stepOutputEnvelope(world, step);
    }
  }
  // Emit aggregated visit entries sorted by visit index.
  for (const [stepId, entries] of visitBuffers) {
    entries.sort((a, b) => a.index - b.index);
    const visits = entries.map((e) => e.output);
    const lastOutput = visits[visits.length - 1];
    outputs[stepId] = { output: lastOutput, visits };
  }
  return outputs;
}

async function stepOutputEnvelope(
  world: LocalWorld,
  step: MaterializedRunState["steps"][string],
): Promise<{ readonly output?: unknown }> {
  return "output" in step || step.outputRef !== undefined
    ? { output: await outputValueForCompletedStep(world, step) }
    : {};
}

function isTopLevelStepPath(stepPath: string): boolean {
  return !stepPath.includes(".") && !stepPath.includes("[") && !stepPath.includes("@attempt_");
}

function finalOutputStep(steps: readonly LwirStep[]): LwirStep | undefined {
  const needed = new Set<string>();
  // Also collect all decision step targets so we can treat them as "potentially needed".
  const decisionTargets = new Set<string>();
  for (const step of steps) {
    for (const need of step.needs ?? []) {
      needed.add(need);
    }
    if (step.uses === "decision") {
      const cfg = step.with as {
        cases?: ReadonlyArray<{ to: string }>;
        default?: string;
      } | undefined;
      for (const c of cfg?.cases ?? []) {
        if (typeof c.to === "string" && c.to !== "end") {
          decisionTargets.add(c.to);
        }
      }
      if (typeof cfg?.default === "string" && cfg.default !== "end") {
        decisionTargets.add(cfg.default);
      }
    }
  }
  // Decision steps never produce workflow output — exclude them from terminal-step consideration.
  // Also exclude steps that are decision targets (they are conditional branches, not unconditional
  // terminal steps). If any decision targets exist, rely on lastNonDecisionStepPath at runtime.
  const terminalSteps = steps.filter(
    (step) => !needed.has(step.id) && step.uses !== "decision" && !decisionTargets.has(step.id),
  );
  if (terminalSteps.length > 1) {
    throw new Error(
      `Ambiguous terminal steps: ${terminalSteps.map((step) => step.id).join(", ")}.`,
    );
  }
  return terminalSteps[0];
}

function maxAttemptsFor(step: LwirStep, options: ExecuteWorkflowVersionOptions): number {
  const stepAttempts = (step as StepWithRetry).retry?.maxAttempts;
  if (Number.isInteger(stepAttempts) && (stepAttempts as number) > 0) {
    return stepAttempts as number;
  }
  if (Number.isInteger(options.maxAttempts) && (options.maxAttempts as number) > 0) {
    return options.maxAttempts as number;
  }
  return DEFAULT_MAX_ATTEMPTS;
}

function hasNonTerminalAttempt(
  stepState: MaterializedRunState["steps"][string] | undefined,
): boolean {
  return stepState?.attempts.some((attempt) => attempt.status !== "failed") ?? false;
}

function terminalRuntimeErrorForStep(
  stepState: MaterializedRunState["steps"][string] | undefined,
): Error | undefined {
  const lastAttempt = stepState?.attempts.at(-1);
  const error = lastAttempt?.error ?? stepState?.error;
  if (
    lastAttempt?.status === "failed" &&
    isTerminalRuntimeCauseEnvelope(error)
  ) {
    return errorCauseFromEnvelope(error);
  }
  return undefined;
}

function isResumableRunningAttempt(
  _step: LwirStep,
  stepState: MaterializedRunState["steps"][string] | undefined,
  _scope: StepExecutionScope,
): boolean {
  if (stepState?.status !== "running") return false;
  const lastAttempt = stepState.attempts.at(-1);
  if (lastAttempt?.status !== "running") return false;
  return stepState.attempts.slice(0, -1).every((attempt) => attempt.status === "failed");
}

function runResult(
  runId: RunId,
  workflowVersionId: string,
  state: MaterializedRunState,
  events: readonly EventEnvelope[],
): RuntimeRunResult {
  const base = {
    runId,
    workflowVersionId: state.workflowVersionId ?? workflowVersionId,
    usage: state.usage,
    events,
    artifacts: state.artifacts,
    state,
  };

  if (state.status === "failed") {
    return {
      ...base,
      status: "failed",
      ...("output" in state ? { output: state.output } : {}),
      ...(state.outputRef === undefined ? {} : { outputRef: state.outputRef }),
      ...(state.error === undefined ? {} : { error: state.error }),
    };
  }

  if (state.outputRef === undefined) {
    throw new Error("Completed runtime result is missing outputRef.");
  }

  return {
    ...base,
    status: "completed",
    output: state.output,
    outputRef: state.outputRef,
  };
}

async function completedRunResult(
  world: LocalWorld,
  workflow: LwirWorkflow,
  runId: RunId,
  workflowVersionId: string,
  state: MaterializedRunState,
  events: readonly EventEnvelope[],
): Promise<RuntimeCompletedRunResult> {
  if (state.outputRef === undefined) {
    throw new Error("Completed runtime result is missing outputRef.");
  }
  const output = "output" in state
    ? state.output
    : (await world.readArtifact(state.outputRef)).payload;
  validateWorkflowOutput(workflow, output);
  return {
    runId,
    workflowVersionId: state.workflowVersionId ?? workflowVersionId,
    usage: state.usage,
    events,
    artifacts: state.artifacts,
    state,
    status: "completed",
    output,
    outputRef: state.outputRef,
  };
}

function errorEnvelope(error: unknown, retriable: boolean): JsonRecord {
  if (error instanceof Error) {
    return stripUndefined({
      name: error.name,
      message: error.message,
      causeCode: runtimeCauseCodeFor(error),
      failedStepPath: failedStepPathForError(error),
      retriable,
    });
  }
  return {
    message: String(error),
    retriable,
  };
}

function runtimeCauseCodeFor(error: Error): RunFailedCauseCode | undefined {
  if (isTerminalCancellationError(error)) {
    return error.causeCode;
  }
  if (error instanceof RuntimeCauseError) {
    return error.causeCode;
  }
  return undefined;
}

function isReplayIntegrityError(error: unknown): boolean {
  return error instanceof ArtifactNotFoundError ||
    error instanceof ArtifactHashMismatchError ||
    error instanceof ArtifactManifestCorruptError ||
    error instanceof RuntimeIntegrityError;
}

function usagePayload(usage: RuntimeUsage | undefined): JsonRecord | undefined {
  if (usage === undefined) {
    return undefined;
  }
  return stripUndefined({
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    costUsd: usage.costUsd,
  });
}

function workflowVersionLock(
  workflowVersion: ExecuteWorkflowVersionOptions["workflowVersion"],
):
  | {
      readonly workflowDefinitionHash?: string;
      readonly modelSlots: readonly {
        readonly slotId: string;
        readonly metadataHash: string;
        readonly modelIdentityHash: string;
      }[];
      readonly tools: readonly {
        readonly name: string;
        readonly scope: string;
        readonly descriptionHash: string;
        readonly inputSchemaHash?: string;
        readonly outputSchemaHash?: string;
        readonly approvalRequired?: true;
      }[];
    }
  | undefined {
  const lock = propertyValue(workflowVersion, "lock");
  if (!isRecord(lock)) {
    return undefined;
  }
  return {
    ...(typeof lock.workflowDefinitionHash === "string"
      ? { workflowDefinitionHash: lock.workflowDefinitionHash }
      : {}),
    modelSlots: Array.isArray(lock.modelSlots)
      ? lock.modelSlots.filter(isModelSlotLock)
      : [],
    tools: Array.isArray(lock.tools) ? lock.tools.filter(isToolLock) : [],
  };
}

function isModelSlotLock(value: unknown): value is {
  readonly slotId: string;
  readonly metadataHash: string;
  readonly modelIdentityHash: string;
} {
  return isRecord(value) &&
    typeof value.slotId === "string" &&
    typeof value.metadataHash === "string" &&
    typeof value.modelIdentityHash === "string";
}

function isToolLock(value: unknown): value is {
  readonly name: string;
  readonly scope: string;
  readonly descriptionHash: string;
  readonly inputSchemaHash?: string;
  readonly outputSchemaHash?: string;
  readonly approvalRequired?: true;
} {
  return isRecord(value) &&
    typeof value.name === "string" &&
    typeof value.scope === "string" &&
    typeof value.descriptionHash === "string" &&
    (value.inputSchemaHash === undefined || typeof value.inputSchemaHash === "string") &&
    (value.outputSchemaHash === undefined || typeof value.outputSchemaHash === "string") &&
    (value.approvalRequired === undefined || value.approvalRequired === true);
}

function isModelSlot(value: unknown): value is {
  readonly aiSdkModel: unknown;
  readonly metadata: JsonRecord;
} {
  return isRecord(value) && "aiSdkModel" in value && isRecord(value.metadata);
}

function safeModelMetadata(metadata: JsonRecord): unknown {
  return stripUndefined({
    id: metadata.id,
    description: metadata.description,
  });
}

function modelIdentityFor(
  slotId: string,
  model: unknown,
): unknown {
  const providerId = stringLikeProperty(model, "provider") ?? stringLikeProperty(model, "providerId");
  const modelId = stringLikeProperty(model, "modelId");
  if (providerId === undefined || modelId === undefined) {
    return { slotId };
  }
  return { providerId, modelId };
}

function propertyValue(value: unknown, key: string): unknown {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    return undefined;
  }
  return Object.hasOwn(value, key) ? (value as Record<string, unknown>)[key] : undefined;
}

function stringProperty(value: unknown, key: string): string | undefined {
  const property = propertyValue(value, key);
  if (typeof property === "string") {
    return property;
  }
  if (typeof property === "number" || typeof property === "boolean") {
    return String(property);
  }
  return undefined;
}

function stringArrayProperty(value: unknown, key: string): readonly string[] {
  const property = propertyValue(value, key);
  return Array.isArray(property) && property.every((entry) => typeof entry === "string")
    ? property
    : [];
}

function stringLikeProperty(value: unknown, key: string): string | undefined {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    return undefined;
  }
  const property = (value as Record<string, unknown>)[key];
  if (typeof property === "string") {
    return property;
  }
  if (typeof property === "number" || typeof property === "boolean") {
    return String(property);
  }
  return undefined;
}

function numberProperty(value: unknown, key: string): number | undefined {
  const property = propertyValue(value, key);
  return typeof property === "number" && Number.isSafeInteger(property) && property > 0
    ? property
    : undefined;
}

function branchIndexProperty(value: unknown): number | undefined {
  const property = propertyValue(value, "branchIndex");
  return typeof property === "number" && Number.isSafeInteger(property) && property >= 0
    ? property
    : undefined;
}

function getAjv(): AjvInstance {
  if (cachedAjv !== undefined) {
    return cachedAjv;
  }

  const ajvModule = nodeRequire("ajv") as
    | AjvConstructor
    | { readonly default?: AjvConstructor };
  const Ajv = typeof ajvModule === "function" ? ajvModule : ajvModule.default;
  if (Ajv === undefined) {
    throw new TypeError("Ajv default export is unavailable.");
  }
  cachedAjv = new Ajv({ allErrors: true, strict: false, validateSchema: true });
  return cachedAjv;
}

function configFor(step: LwirStep): JsonRecord {
  return isRecord(step.with) ? step.with : {};
}

function stringConfig(config: JsonRecord, key: string, stepId: string): string {
  const value = config[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Step '${stepId}' requires string config '${key}'.`);
  }
  return value;
}

function contentTypeFor(value: unknown): string {
  return typeof value === "string" ? "text/plain" : "application/json";
}

function uniqueRefs(refs: readonly ArtifactRef[]): readonly ArtifactRef[] {
  return [...new Set(refs)];
}

function stripUndefined<T extends JsonRecord>(value: T): JsonRecord {
  const result: JsonRecord = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) {
      result[key] = item;
    }
  }
  return result;
}

function isEventEnvelope(value: unknown): value is EventEnvelope {
  return isRecord(value) && typeof value.type === "string" && isRecord(value.payload);
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Returns the set of step ids that are targets of any decision step in `steps`
 * whose needs are all satisfied by `completedForNeeds`. A decision target is only
 * "active" (and therefore should be excluded from normal needs-based scheduling)
 * when its controlling decision step is itself runnable — i.e. the decision step's
 * needs are all completed. This preserves back-edge loop semantics where the loop
 * entry (e.g. `worker`) has needs:[] and its decision step (e.g. `route` with
 * needs:[review]) is not yet runnable on the first iteration.
 */
function activeDecisionTargetIds(
  steps: readonly LwirStep[],
  completedForNeeds: ReadonlySet<string>,
): Set<string> {
  const targets = new Set<string>();
  for (const step of steps) {
    if (step.uses !== "decision" || !isRecord(step.with)) continue;
    // Only activate the exclusion when the decision step's own needs are all satisfied.
    const decisionNeeds = step.needs ?? [];
    if (!decisionNeeds.every((need) => completedForNeeds.has(need))) continue;
    const cfg = step.with as { cases?: ReadonlyArray<{ to?: unknown }>; default?: unknown };
    for (const c of cfg.cases ?? []) {
      if (typeof c?.to === "string" && c.to !== "end") targets.add(c.to);
    }
    if (typeof cfg.default === "string" && cfg.default !== "end") targets.add(cfg.default);
  }
  return targets;
}
