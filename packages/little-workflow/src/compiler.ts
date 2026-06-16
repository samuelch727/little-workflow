import { createRequire } from "node:module";
import {
  runWorkflowHarnessWithSession,
  workflowHarness,
} from "little-harness/workflow-harness";
import type { LocalWorld, ModelSlot, ToolSelectionPolicy } from "./authoring.js";
import { canonicalJson, sha256Digest } from "./canonical.js";
import {
  model as createModelSlot,
  resolveModelSlots,
  type ResolvedModelSlot,
} from "./model-slots.js";
import type { ToolRegistry } from "./tool-registry.js";
import {
  createBashTool,
  normalizeBashCapabilities,
  type BashCapabilities,
  type NormalizedBashCapabilities,
} from "./bash-tool.js";
import {
  createHarnessEventRecorder,
} from "./harness/event-recorder.js";
import { normalizeHarnessEventType } from "./harness/event-names.js";
import { hashHarnessManifest, plannerManifest, type SkillManifestIdentity } from "./manifests.js";
import { readSkillContents, remoteSkillIdentityFromValue } from "./skills.js";
import {
  computeCompiledWorkflowVersionIdentity,
  computeCompilerValidationHash,
} from "./compiler-lock.js";
import type {
  Harness,
  HarnessContext,
  HarnessEventInput,
  HarnessEventRecorder,
  MemoryMount,
  ScratchMount,
  SkillDescriptor,
} from "./harness/types.js";
import type { EventEnvelope, RunId } from "./world.js";
import {
  getPlanningDefinitionSnapshot,
  getWorkflowDefinitionHash,
  getWorkflowDefinitionSnapshot,
  type PlanningDefinitionSnapshot,
  type WorkflowDefinitionSnapshotInput,
} from "./workflow-definition-hash.js";
import {
  concreteInputStructure,
  type ConcreteInputStructure,
  type WorkflowVersionReuseStrategy,
} from "./workflow-version-reuse.js";
import {
  registerWorkflowVersion,
  validateAlphaJsonSchema,
  validateLwir,
  type LwirStepOutput,
  type LwirValidationFinding,
  type LwirWorkflow,
  type WorkflowVersion,
} from "./lwir.js";
import {
  normalizeOutputMode,
  normalizeSchema,
  type NormalizedOutputMode,
  type NormalizedSchemaDescriptor,
} from "./schema.js";

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

export type CompilableWorkflowDefinition = WorkflowDefinitionSnapshotInput & {
  readonly suggestedInputSchema?: unknown;
  readonly workflowVersionReuseStrategy?: WorkflowVersionReuseStrategy;
};

export type OrchestrationRequestOuterLoop = {
  readonly cycleNumber: number;
  readonly maxCycles: number;
  readonly isFinalCycle: boolean;
  readonly priorCycles: ReadonlyArray<{
    readonly cycleNumber: number;
    readonly status: "completed" | "failed";
    readonly output: unknown;
    readonly summary?: string;
  }>;
};

export type OrchestrationRequest = {
  readonly apiVersion: "littleworkflow.dev/v0.1";
  readonly kind: "OrchestrationRequest";
  readonly requestId: string;
  readonly actor?: unknown;
  readonly metadata: {
    readonly name: string;
    readonly description?: string;
  };
  readonly messages: {
    readonly user: string;
    readonly system?: string;
  };
  readonly input: unknown;
  readonly inputSchema: NormalizedSchemaDescriptor;
  readonly suggestedInputSchema?: NormalizedSchemaDescriptor;
  readonly requestedOutput: CompilerOutputMode;
  readonly capabilityManifest: CapabilityManifest;
  readonly controls: {
    readonly maxWorkflowRevisions: number;
  };
  readonly outerLoop?: OrchestrationRequestOuterLoop;
  readonly locks: CompilerRequestLocks;
};

export type CompilerOutputMode =
  | { readonly mode: "text"; readonly name?: string; readonly description?: string }
  | {
      readonly mode: "object";
      readonly schema: NormalizedSchemaDescriptor;
      readonly name?: string;
      readonly description?: string;
    }
  | {
      readonly mode: "array";
      readonly schema: NormalizedSchemaDescriptor;
      readonly name?: string;
      readonly description?: string;
    }
  | {
      readonly mode: "choice";
      readonly values: readonly string[];
      readonly name?: string;
      readonly description?: string;
    }
  | {
      readonly mode: "json";
      readonly schema?: NormalizedSchemaDescriptor;
      readonly name?: string;
      readonly description?: string;
    };

export type CapabilityManifest = {
  readonly stepTypes: readonly ["ai.generate", "tool.call", "code.run", "parallel", "decision"];
  readonly toolSelection: ToolSelectionPolicy;
  readonly tools: readonly ToolSnapshot[];
  readonly models: readonly ModelSlotSnapshot[];
  readonly modelSlots: readonly string[];
  readonly workerHarness?: {
    readonly harnessId: string;
  };
  readonly secrets: readonly string[];
  readonly network: {
    readonly default: "deny";
    readonly allow: readonly string[];
  };
  readonly bash: NormalizedBashCapabilities;
};

export type ToolScope = "global";

export type ToolSnapshot = {
  readonly name: string;
  readonly scope: ToolScope;
  readonly description?: string;
  readonly inputSchema?: NormalizedSchemaDescriptor;
  readonly outputSchema?: NormalizedSchemaDescriptor;
  readonly approvalRequired?: true;
  readonly descriptionHash: string;
  readonly inputSchemaHash?: string;
  readonly outputSchemaHash?: string;
};

export type ModelSlotSnapshot = {
  readonly slotId: string;
  readonly role: string;
  readonly metadata: unknown;
  readonly modelIdentity: unknown;
  readonly metadataHash: string;
  readonly modelIdentityHash: string;
};

export type ModelSlotLock = {
  readonly slotId: string;
  readonly role: string;
  readonly metadataHash: string;
  readonly modelIdentityHash: string;
};

export type CompilerRequestLocks = {
  readonly requestHash: string;
  readonly inputHash: string;
  readonly plannedInputStructure: ConcreteInputStructure;
  readonly plannedInputStructureHash: string;
  readonly workflowDefinitionHash: string;
  readonly inputSchemaHash: string;
  readonly requestedOutputHash: string;
  readonly capabilityManifest: CapabilityManifest;
  readonly modelSlots: readonly ModelSlotLock[];
  readonly tools: readonly ToolSnapshot[];
};

export type PlannerRepairContext = {
  readonly previousLwir: unknown;
  readonly findings: readonly LwirValidationFinding[];
};

export type SuperviseOuterLoopState = {
  readonly goal: { readonly workflowDefinitionHash: string; readonly description: string };
  readonly cycles: ReadonlyArray<{
    readonly cycleNumber: number;
    readonly workflowVersionId: string;
    readonly runId: string;
    readonly status: "completed" | "failed";
    readonly output: unknown;
    readonly summary?: string;
  }>;
};

export type SuperviseDecision =
  | { readonly kind: "done"; readonly finalOutput: unknown }
  | { readonly kind: "continue"; readonly promptNote?: string };

export type PlannerAdapter = {
  draft(
    request: OrchestrationRequest,
    repair?: PlannerRepairContext,
  ): Promise<unknown>;
  supervise?(state: SuperviseOuterLoopState): Promise<SuperviseDecision>;
};

export type CompilerRevision = {
  readonly revision: number;
  readonly lwir: unknown;
  readonly valid: boolean;
  readonly findings: readonly LwirValidationFinding[];
};

export type WorkflowCompileOptions = {
  readonly input: unknown;
  readonly planner?: PlannerAdapter;
  readonly tools?: ToolRegistry;
  readonly requestId?: string;
  readonly actor?: unknown;
  readonly controls?: {
    readonly maxWorkflowRevisions?: number;
  };
  readonly maxWorkflowRevisions?: number;
  readonly outerLoop?: OrchestrationRequestOptions["outerLoop"];
  readonly promptNote?: string;
  readonly bash?: BashCapabilities;
  readonly onCompilerLifecycleEvent?: (
    event: CompilerLifecycleEvent,
  ) => Promise<void> | void;
  readonly plannerHarnessRuntime?: PlannerHarnessRuntimeContext;
};

export type PlannerHarnessRuntimeContext = {
  readonly world: LocalWorld;
  readonly runId: RunId;
  readonly parentRunId?: RunId;
  readonly logDir: string;
  readonly memoryMounts: readonly MemoryMount[];
  readonly scratchMounts: readonly ScratchMount[];
  readonly skills: readonly SkillDescriptor[];
  readonly skillWarnings?: readonly Record<string, unknown>[];
  readonly bashCapabilities?: BashCapabilities;
  readonly abortSignal?: AbortSignal;
};

export type OrchestrationRequestOptions = {
  readonly input: unknown;
  readonly tools?: ToolRegistry;
  readonly requestId?: string;
  readonly actor?: unknown;
  readonly controls?: {
    readonly maxWorkflowRevisions?: number;
  };
  readonly maxWorkflowRevisions?: number;
  readonly outerLoop?: Omit<OrchestrationRequestOuterLoop, "isFinalCycle"> & { readonly isFinalCycle?: boolean };
  readonly promptNote?: string;
  readonly bash?: BashCapabilities;
};

export type WorkflowCompileResult = {
  readonly request: OrchestrationRequest;
  readonly workflowVersion: CompiledWorkflowVersion;
  readonly revisions: readonly CompilerRevision[];
  readonly lock: WorkflowVersionLock;
  readonly plannerReuseDecision?: PlannerCompileReuseDecision;
};

export type PlannerCompileReuseDecision =
  | {
      readonly kind: "adapt";
      readonly baseWorkflowVersionId: string;
      readonly rationale: string;
    }
  | {
      readonly kind: "draft_fresh";
      readonly rationale: string;
    };

export type CompilerLifecycleEvent =
  | {
      readonly type: "OrchestrationRequested";
      readonly request: OrchestrationRequest;
    }
  | {
      readonly type: "PlannerStarted";
      readonly request: OrchestrationRequest;
      readonly revision: number;
      readonly repair?: PlannerRepairContext;
    }
  | {
      readonly type: "PlannerDraftedWorkflow";
      readonly request: OrchestrationRequest;
      readonly revision: CompilerRevision;
    }
  | {
      readonly type: "WorkflowValidationFailed";
      readonly request: OrchestrationRequest;
      readonly revision: CompilerRevision;
    }
  | {
      readonly type: "WorkflowValidationSucceeded";
      readonly request: OrchestrationRequest;
      readonly revision: CompilerRevision;
      readonly workflowVersion: CompiledWorkflowVersion;
    };

export type CompiledWorkflowVersion = Omit<WorkflowVersion, "id" | "hash"> & {
  readonly id: string;
  readonly hash: string;
  readonly lwirVersionId: string;
  readonly lwirHash: string;
  readonly lock: WorkflowVersionLock;
};

export type WorkflowVersionLock = {
  readonly workflowVersionId: string;
  readonly workflowVersionHash: string;
  readonly lwirVersionId: string;
  readonly lwirHash: string;
  readonly requestId: string;
  readonly requestHash: string;
  readonly inputHash: string;
  readonly plannedInputStructure: ConcreteInputStructure;
  readonly plannedInputStructureHash: string;
  readonly inputBinding?: "required";
  readonly workflowDefinitionHash: string;
  readonly planningDefinitionSnapshot?: PlanningDefinitionSnapshot;
  readonly planningDefinitionSnapshotHash?: string;
  readonly inputSchemaHash: string;
  readonly requestedOutput: CompilerOutputMode;
  readonly requestedOutputHash: string;
  readonly capabilityManifest: CapabilityManifest;
  readonly capabilityManifestHash: string;
  readonly modelSlots: readonly ModelSlotLock[];
  readonly tools: readonly ToolSnapshot[];
  readonly validationHash: string;
};

const ALPHA_STEP_TYPES = [
  "ai.generate",
  "tool.call",
  "code.run",
  "parallel",
  "decision",
] as const;
const DEFAULT_MAX_WORKFLOW_REVISIONS = 3;
const nodeRequire = createRequire(import.meta.url);

let cachedAjv: AjvInstance | undefined;

type OrchestrationRequestBody = Omit<OrchestrationRequest, "requestId" | "locks"> & {
  readonly locks: Omit<CompilerRequestLocks, "requestHash">;
};
type OrchestrationRequestHashInput = Omit<OrchestrationRequest, "locks"> & {
  readonly locks: Omit<CompilerRequestLocks, "requestHash">;
};
type CompilerWorkflowVersionLockSeed = Omit<
  WorkflowVersionLock,
  "workflowVersionId" | "workflowVersionHash"
>;

export class WorkflowInputValidationError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowInputValidationError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class WorkflowSchemaValidationError extends TypeError {
  readonly findings: readonly LwirValidationFinding[];

  constructor(findings: readonly LwirValidationFinding[]) {
    super(findings.map((finding) => `${finding.path}: ${finding.message}`).join("; "));
    this.name = "WorkflowSchemaValidationError";
    this.findings = findings;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class WorkflowCompileError extends Error {
  readonly request: OrchestrationRequest;
  readonly revisions: readonly CompilerRevision[];

  constructor(request: OrchestrationRequest, revisions: readonly CompilerRevision[]) {
    super("Planner did not produce valid LWIR within maxWorkflowRevisions.");
    this.name = "WorkflowCompileError";
    this.request = request;
    this.revisions = revisions;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class PlannerReuseUnchangedDecisionError extends Error {
  readonly workflowVersionId: string;
  readonly rationale: string;
  readonly acknowledgedWarnings?: readonly string[];

  constructor(options: {
    readonly workflowVersionId: string;
    readonly rationale: string;
    readonly acknowledgedWarnings?: readonly string[];
  }) {
    super(
      "Planner selected reuse_unchanged; runtime integration must handle workflow version reuse.",
    );
    this.name = "PlannerReuseUnchangedDecisionError";
    this.workflowVersionId = options.workflowVersionId;
    this.rationale = options.rationale;
    this.acknowledgedWarnings = options.acknowledgedWarnings;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class WorkflowMissingToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowMissingToolError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function toOrchestrationRequest(
  workflow: CompilableWorkflowDefinition,
  options: OrchestrationRequestOptions,
): OrchestrationRequest {
  const inputSchema = workflow.inputSchema === undefined
    ? true
    : normalizeSchema(workflow.inputSchema);
  const suggestedInputSchema = workflow.suggestedInputSchema === undefined
    ? undefined
    : normalizeSchema(workflow.suggestedInputSchema);
  const requestedOutput = compileOutputMode(workflow);
  validateSchemaForRequest(inputSchema, "$.inputSchema");
  if (suggestedInputSchema !== undefined) {
    validateSchemaForRequest(suggestedInputSchema, "$.suggestedInputSchema");
  }
  validateSchemaForRequest(requestedOutputSchema(requestedOutput), "$.requestedOutput.schema");
  const models = modelSlotEntries(workflow);
  const modelLocks = models.map((entry) => entry.lock);
  const tools = allToolSnapshots(workflow, options.tools);
  const maxWorkflowRevisions = maxWorkflowRevisionsFor(options);
  const bashCapabilities = options.bash ?? workflow.bash;
  const workerHarness = workerHarnessCapability(workflow);
  const input = canonicalClone(options.input);
  validateInputAgainstSchema(input, inputSchema);
  const inputHash = sha256Digest(input);
  const plannedInputStructure = concreteInputStructure(input);
  const plannedInputStructureHash = sha256Digest(plannedInputStructure);
  const capabilityManifest = {
    stepTypes: ALPHA_STEP_TYPES,
    toolSelection: workflow.toolSelection ?? "planner_selected",
    tools,
    models: models.map((entry) => entry.snapshot),
    modelSlots: modelLocks.map((slot) => slot.slotId),
    ...(workerHarness === undefined ? {} : { workerHarness }),
    secrets: [],
    network: { default: "deny", allow: [] },
    bash: normalizeBashCapabilities(bashCapabilities),
  } satisfies CapabilityManifest;
  const requestBody = {
    apiVersion: "littleworkflow.dev/v0.1",
    kind: "OrchestrationRequest",
    ...(options.actor === undefined ? {} : { actor: options.actor }),
    metadata: stripUndefined({
      name: workflow.id,
      description: workflow.description,
    }) as OrchestrationRequest["metadata"],
    messages: {
      user: workflow.description ?? workflow.id,
      ...(options.promptNote !== undefined
        ? { system: `\n\n--- Prior cycle note ---\n${options.promptNote}` }
        : {}),
    },
    input,
    inputSchema,
    ...(suggestedInputSchema === undefined ? {} : { suggestedInputSchema }),
    requestedOutput,
    capabilityManifest,
    controls: { maxWorkflowRevisions },
    ...(options.outerLoop === undefined
      ? {}
      : {
          outerLoop: {
            ...options.outerLoop,
            isFinalCycle:
              options.outerLoop.isFinalCycle ??
              options.outerLoop.cycleNumber === options.outerLoop.maxCycles,
          },
        }),
    locks: {
      inputHash,
      plannedInputStructure,
      plannedInputStructureHash,
      workflowDefinitionHash: getWorkflowDefinitionHash(workflow, options.tools),
      inputSchemaHash: sha256Digest(inputSchema),
      requestedOutputHash: sha256Digest(requestedOutput),
      capabilityManifest,
      modelSlots: modelLocks,
      tools,
    },
  } satisfies OrchestrationRequestBody;
  const requestBodyHash = sha256Digest(requestBody);
  const requestHashInput = {
    ...requestBody,
    requestId: options.requestId ?? requestIdFor(requestBodyHash),
  } satisfies OrchestrationRequestHashInput;
  const requestHash = sha256Digest(requestHashInput);
  const request = {
    ...requestHashInput,
    locks: {
      ...requestHashInput.locks,
      requestHash,
    },
  } satisfies OrchestrationRequest;
  return deepFreeze(canonicalClone(request));
}

export function requestedOutputHashForWorkflow(
  workflow: CompilableWorkflowDefinition,
): string {
  return sha256Digest(compileOutputMode(workflow));
}

export async function compileWorkflow(
  workflow: CompilableWorkflowDefinition,
  options: WorkflowCompileOptions,
): Promise<WorkflowCompileResult> {
  const request = toOrchestrationRequest(workflow, options);
  const planner = plannerAdapterForCompile(workflow, options, request);
  await options.onCompilerLifecycleEvent?.({
    type: "OrchestrationRequested",
    request,
  });
  validateInputAgainstSchema(request.input, request.inputSchema);

  const revisions: CompilerRevision[] = [];
  let repair: PlannerRepairContext | undefined;
  for (let revision = 1; revision <= request.controls.maxWorkflowRevisions; revision += 1) {
    await options.onCompilerLifecycleEvent?.({
      type: "PlannerStarted",
      request,
      revision,
      ...(repair === undefined ? {} : { repair }),
    });
    const plannerOutput = await planner.draft(request, repair);
    const unwrappedPlannerOutput = unwrapPlannerDecision(plannerOutput);
    const { lwir, plannerReuseDecision } = unwrappedPlannerOutput;
    const validation = validateLwir(lwir);
    const findings = validation.valid ? validateRequestBinding(lwir, request) : validation.findings;
    const findingSnapshot = deepFreeze(canonicalClone(findings));
    const lwirSnapshot = snapshotRevisionValue(lwir, findingSnapshot);
    const record: CompilerRevision = deepFreeze({
      revision,
      lwir: lwirSnapshot,
      valid: findingSnapshot.length === 0,
      findings: findingSnapshot,
    });
    revisions.push(record);
    await options.onCompilerLifecycleEvent?.({
      type: "PlannerDraftedWorkflow",
      request,
      revision: record,
    });

    if (record.valid) {
      return await finalizeValidLwir({ record, request, revisions, options, workflow, plannerReuseDecision });
    }

    await options.onCompilerLifecycleEvent?.({
      type: "WorkflowValidationFailed",
      request,
      revision: record,
    });
    repair = deepFreeze({
      previousLwir: record.lwir,
      findings: record.findings,
    });
  }

  // Deterministic floor. A workflow that just needs a model to produce its
  // declared output has an obvious plan: a single ai.generate step. If the LLM
  // planner couldn't produce valid LWIR within its revisions, fall back to that
  // synthesized plan so a bare workflow (description + output schema + a model
  // slot, no planner prompt) still compiles instead of hard-failing.
  const synthesized = synthesizeSimpleLwir(request);
  if (synthesized !== undefined) {
    const validation = validateLwir(synthesized);
    const findings = validation.valid ? validateRequestBinding(synthesized, request) : validation.findings;
    if (findings.length === 0) {
      const record: CompilerRevision = deepFreeze({
        revision: revisions.length + 1,
        lwir: snapshotRevisionValue(synthesized, deepFreeze([])),
        valid: true,
        findings: deepFreeze([]),
      });
      revisions.push(record);
      await options.onCompilerLifecycleEvent?.({
        type: "PlannerDraftedWorkflow",
        request,
        revision: record,
      });
      return await finalizeValidLwir({ record, request, revisions, options, workflow });
    }
  }

  throw new WorkflowCompileError(request, deepFreeze([...revisions]));
}

/**
 * Build the {@link WorkflowCompileResult} from a validated LWIR revision —
 * registers the workflow version, computes the lock + identity, and emits the
 * success lifecycle event. Shared by the planner path and the deterministic
 * synthesis fallback.
 */
async function finalizeValidLwir(args: {
  readonly record: CompilerRevision;
  readonly request: OrchestrationRequest;
  readonly revisions: readonly CompilerRevision[];
  readonly options: WorkflowCompileOptions;
  readonly workflow: CompilableWorkflowDefinition;
  readonly plannerReuseDecision?: PlannerCompileReuseDecision;
}): Promise<WorkflowCompileResult> {
  const { record, request, revisions, options, workflow, plannerReuseDecision } = args;
  const baseWorkflowVersion = registerWorkflowVersion(record.lwir);
  const capabilityManifestHash = sha256Digest(request.capabilityManifest);
  const planningDefinitionSnapshot = getPlanningDefinitionSnapshot(workflow, options.tools);
  const planningDefinitionSnapshotHash = sha256Digest(planningDefinitionSnapshot);
  const validationHash = computeCompilerValidationHash({
    canonicalizer: baseWorkflowVersion.canonicalizer,
    lwirVersionId: baseWorkflowVersion.id,
    lwirHash: baseWorkflowVersion.hash,
    requestId: request.requestId,
    requestHash: request.locks.requestHash,
    inputHash: request.locks.inputHash,
    plannedInputStructureHash: request.locks.plannedInputStructureHash,
    workflowDefinitionHash: request.locks.workflowDefinitionHash,
    inputSchemaHash: request.locks.inputSchemaHash,
    requestedOutputHash: request.locks.requestedOutputHash,
    capabilityManifestHash,
  });
  const lockSeed: CompilerWorkflowVersionLockSeed = deepFreeze({
    lwirVersionId: baseWorkflowVersion.id,
    lwirHash: baseWorkflowVersion.hash,
    requestId: request.requestId,
    requestHash: request.locks.requestHash,
    inputHash: request.locks.inputHash,
    plannedInputStructure: request.locks.plannedInputStructure,
    plannedInputStructureHash: request.locks.plannedInputStructureHash,
    inputBinding: "required",
    workflowDefinitionHash: request.locks.workflowDefinitionHash,
    planningDefinitionSnapshot,
    planningDefinitionSnapshotHash,
    inputSchemaHash: request.locks.inputSchemaHash,
    requestedOutput: request.requestedOutput,
    requestedOutputHash: request.locks.requestedOutputHash,
    capabilityManifest: request.capabilityManifest,
    capabilityManifestHash,
    modelSlots: request.locks.modelSlots,
    tools: request.locks.tools,
    validationHash,
  });
  const { workflowVersionHash, workflowVersionId } = computeCompiledWorkflowVersionIdentity({
    canonicalizer: baseWorkflowVersion.canonicalizer,
    lwirVersionId: baseWorkflowVersion.id,
    lwirHash: baseWorkflowVersion.hash,
    lockSeed,
  });
  const lock = deepFreeze({
    workflowVersionId,
    workflowVersionHash,
    ...lockSeed,
  });
  const workflowVersion = deepFreeze({
    ...baseWorkflowVersion,
    id: workflowVersionId,
    hash: workflowVersionHash,
    lwirVersionId: baseWorkflowVersion.id,
    lwirHash: baseWorkflowVersion.hash,
    lock,
  });
  await options.onCompilerLifecycleEvent?.({
    type: "WorkflowValidationSucceeded",
    request,
    revision: record,
    workflowVersion,
  });
  return {
    request,
    workflowVersion,
    revisions: deepFreeze([...revisions]),
    lock,
    ...(plannerReuseDecision === undefined ? {} : { plannerReuseDecision }),
  };
}

/**
 * Synthesize the obvious single-step LWIR for a workflow that needs a model to
 * produce its declared output: one `ai.generate` step bound to the first
 * available model slot, passing the whole input through, emitting the requested
 * output schema. Returns `undefined` when there is no model slot to bind (then
 * the workflow genuinely needs a planner-authored plan). Used both as the LLM
 * planner's reference example and as the deterministic compile fallback.
 */
export function synthesizeSimpleLwir(request: OrchestrationRequest): LwirWorkflow | undefined {
  const modelSlots = request.capabilityManifest.modelSlots;
  // The obvious single-model plan applies only when the workflow needs a model to
  // produce its output and registers no tools. A workflow that registers tools
  // likely needs to call them, so a tool-less single step would be valid but
  // wrong — defer those to the planner instead of synthesizing.
  if (modelSlots.length === 0 || request.capabilityManifest.tools.length > 0) {
    return undefined;
  }
  const modelSlot = modelSlots[0];
  const requested = request.requestedOutput;
  const outputSchema = requestedOutputSchema(requested);
  const description = request.metadata.description;
  return {
    apiVersion: "littleworkflow.dev/v0.1",
    kind: "Workflow",
    metadata: {
      name: request.metadata.name,
      version: "0.1.0-alpha",
      ...(description === undefined ? {} : { description }),
    },
    input: { schema: request.inputSchema },
    output: { schema: outputSchema },
    permissions: { tools: [], models: [modelSlot], secrets: [], network: [] },
    steps: [
      {
        id: "generate",
        uses: "ai.generate",
        input: "{{ input }}",
        with: { model: modelSlot, ...(description === undefined ? {} : { prompt: description }) },
        output: stepOutputForRequested(requested),
      },
    ],
  } as LwirWorkflow;
}

/** The ai.generate step output that produces the workflow's requested output. */
function stepOutputForRequested(requested: CompilerOutputMode): LwirStepOutput {
  switch (requested.mode) {
    case "object":
    case "array":
      return { mode: requested.mode, schema: requested.schema };
    case "choice":
      return { mode: "choice", values: requested.values };
    case "json":
      return { mode: "json", schema: requested.schema ?? true };
    case "text":
      return { mode: "text" };
  }
}

/**
 * The planning context handed to the planner every compile: the concrete model
 * slots / tools / step types it may bind, and — when the workflow is
 * synthesizable — a complete valid reference LWIR to adapt. This is what lets a
 * workflow compile with no developer-authored planner prompt.
 */
export function buildPlanningContext(request: OrchestrationRequest): string {
  const manifest = request.capabilityManifest;
  const lines: string[] = [];
  lines.push("Available capabilities for this workflow (use ONLY these ids — never invent model or tool ids):");
  lines.push(`- model slots (set as a step's with.model): ${manifest.modelSlots.length === 0 ? "(none)" : manifest.modelSlots.join(", ")}`);
  lines.push(`- tools (set as a tool.call step's with.tool): ${manifest.tools.length === 0 ? "(none)" : manifest.tools.map((t) => t.name).join(", ")}`);
  lines.push(`- step types (a step's uses): ${manifest.stepTypes.join(", ")}`);
  const reference = synthesizeSimpleLwir(request);
  if (reference !== undefined) {
    lines.push("");
    lines.push(
      "A valid reference LWIR for THIS workflow is below. It already satisfies the output contract — return it as-is, or adapt it (e.g. add steps) if the task needs more. Return ONLY the LWIR JSON, no prose or markdown fences:",
    );
    lines.push(JSON.stringify(reference, null, 2));
  }
  return lines.join("\n");
}

function composePlanningContext(planningContext: string, priorNote: string | undefined): string {
  return priorNote === undefined ? planningContext : `${planningContext}\n\n${priorNote}`;
}

function unwrapPlannerDecision(value: unknown): {
  readonly lwir: unknown;
  readonly plannerReuseDecision?: PlannerCompileReuseDecision;
} {
  if (!isRecord(value) || typeof value.kind !== "string") {
    return { lwir: value };
  }

  switch (value.kind) {
    case "adapt":
      return {
        lwir: value.lwir,
        plannerReuseDecision: {
          kind: "adapt",
          baseWorkflowVersionId: stringDecisionValue(value.baseWorkflowVersionId),
          rationale: stringDecisionValue(value.rationale),
        },
      };
    case "draft_fresh":
      return {
        lwir: value.lwir,
        plannerReuseDecision: {
          kind: "draft_fresh",
          rationale: stringDecisionValue(value.rationale),
        },
      };
    case "reuse_unchanged":
      throw new PlannerReuseUnchangedDecisionError({
        workflowVersionId: stringDecisionValue(value.workflowVersionId),
        rationale: stringDecisionValue(value.rationale),
        acknowledgedWarnings: stringArrayDecisionValue(value.acknowledgedWarnings),
      });
    default:
      return { lwir: value };
  }
}

function stringDecisionValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function stringArrayDecisionValue(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? value
    : undefined;
}

function plannerAdapterForCompile(
  workflow: CompilableWorkflowDefinition,
  options: WorkflowCompileOptions,
  request: OrchestrationRequest,
): PlannerAdapter {
  const plannerConfig = workflow.planner;
  if (plannerConfig === undefined) {
    if (options.planner !== undefined) {
      return options.planner;
    }
    throw new Error("compileWorkflow requires a planner adapter in alpha.");
  }

  const harness = isHarnessLike(plannerConfig.harness)
    ? plannerConfig.harness
    : workflowHarness;

  const resolvedModel = resolvePlannerModelSlot(plannerConfig.model);
  const runtime = options.plannerHarnessRuntime;
  const plannerBashCapabilities = runtime?.bashCapabilities ?? options.bash ?? workflow.bash;
  const harnessRunId = runtime?.runId ?? `compile:${request.requestId}`;
  const recorder = runtime === undefined
    ? createInMemoryHarnessRecorder(harnessRunId)
    : createHarnessEventRecorder({ world: runtime.world, runId: runtime.runId });
  const tools = options.tools?.toRecord() ?? {};
  const context = {
    scope: {
      runId: harnessRunId,
      ...(runtime?.parentRunId === undefined ? {} : { parentRunId: runtime.parentRunId }),
      logDir: runtime?.logDir ?? `/tmp/little-workflow/compile/${request.requestId}`,
      role: "planner",
    },
    model: {
      slotId: resolvedModel.slotId,
      providerId: resolvedModel.providerId ?? "runtime",
      modelId: resolvedModel.modelId ?? resolvedModel.slotId,
      model: resolvedModel.aiSdkModel,
    },
    ...(plannerConfig.system === undefined ? {} : { system: plannerConfig.system }),
    tools,
    bash: runtime === undefined
      ? createBashTool({
          cwd: process.cwd(),
          readableRoots: [{ path: process.cwd(), mode: "rw" }],
          ...(plannerBashCapabilities === undefined ? {} : { capabilities: plannerBashCapabilities }),
        })
      : createBashTool(plannerBashScope(runtime)),
    memoryMounts: runtime?.memoryMounts ?? [],
    scratchMounts: runtime?.scratchMounts ?? [],
    skills: runtime?.skills ?? [],
    recorder,
    session: {
      runId: harnessRunId,
      role: "planner" as const,
      task: { kind: "plan" as const },
      manifest: {},
      manifestHash: sha256Digest({}),
      ...(runtime?.parentRunId === undefined ? {} : { parentRunId: runtime.parentRunId }),
      ...(runtime?.skillWarnings === undefined || runtime.skillWarnings.length === 0 ? {} : { warnings: runtime.skillWarnings }),
    },
    mounts: runtime === undefined
      ? []
      : plannerHarnessMounts(runtime),
    durability: {
      append: async (event) => {
        const eventWithWarnings = eventWithSessionWarnings(event, runtime?.skillWarnings);
        await recorder.append({
          type: eventWithWarnings.type,
          ...(eventWithWarnings.occurrenceId === undefined ? {} : { occurrenceId: eventWithWarnings.occurrenceId }),
          payload: eventWithWarnings.payload,
        });
      },
      priorEvents: async (query) => {
        const events = await recorder.priorEvents(query?.runId);
        const queryType = query?.type;
        return queryType === undefined
          ? events as never
          : events.filter((event) => isEventEnvelope(event) && normalizeHarnessEventType(event.type) ===
            normalizeHarnessEventType(queryType)) as never;
      },
    },
    abortSignal: runtime?.abortSignal ?? new AbortController().signal,
  } as HarnessContext & {
    readonly recorder: HarnessEventRecorder;
    readonly bash: ReturnType<typeof createBashTool>;
  };

  return {
    async draft(requestInput): Promise<unknown> {
      const task = {
        kind: "plan" as const,
        workflowSnapshot: {
          id: workflow.id,
          description: workflow.description ?? "",
          inputSchema: requestInput.inputSchema,
          ...(requestInput.suggestedInputSchema === undefined
            ? {}
            : { suggestedInputSchema: requestInput.suggestedInputSchema }),
          outputSchema: requestedOutputSchema(requestInput.requestedOutput),
          workflowDefinitionHash: requestInput.locks.workflowDefinitionHash,
        },
        input: requestInput.input,
        // Always give the planner the concrete capabilities + a valid reference
        // LWIR for this workflow, so it can author a plan with no dev-provided
        // system prompt. Any prior-cycle note is appended after.
        systemMessage: composePlanningContext(
          buildPlanningContext(requestInput),
          requestInput.messages.system,
        ),
        ...(requestInput.outerLoop === undefined
          ? {}
          : { outerLoopContext: requestInput.outerLoop }),
      };
      const manifest = plannerManifest({
        harnessId: harnessIdFor(harness),
        plannerModelSlotId: resolvedModel.slotId,
        ...(plannerConfig.system === undefined ? {} : { systemPrompt: plannerConfig.system }),
        skills: context.skills.map(skillManifestIdentity),
        workflowDefinitionHash: requestInput.locks.workflowDefinitionHash,
        toolRegistry: options.tools,
        memoryStoreIds: context.memoryMounts.map((mount) => mount.storeId),
        bashCapabilities: plannerBashCapabilities,
        ...(requestInput.outerLoop === undefined ? {} : { outerLoopContext: requestInput.outerLoop }),
      });

      const manifestHash = hashHarnessManifest(manifest);
      const skillContents = context.skills.length === 0
        ? undefined
        : await readSkillContents(context.skills);
      const harnessContext = {
        ...context,
        session: {
          runId: context.scope.runId,
          role: "planner" as const,
          task: { kind: "plan" as const },
          ...(context.scope.parentRunId === undefined ? {} : { parentRunId: context.scope.parentRunId }),
          manifest,
          manifestHash,
          ...(runtime?.skillWarnings === undefined || runtime.skillWarnings.length === 0 ? {} : { warnings: runtime.skillWarnings }),
          ...(skillContents === undefined ? {} : { skillContents }),
        },
      };

      let result = await raceAbortSignal(
        runWorkflowHarnessWithSession(harness as never, task as never, harnessContext as never),
        context.abortSignal,
      );
      if (result.kind === "delegate_to_default") {
        if (harness === workflowHarness) {
          throw new Error(
            "planner harness delegated to default, but no default planner adapter is available in compileWorkflow.",
          );
        }
        const defaultManifest = plannerManifest({
          harnessId: harnessIdFor(workflowHarness),
          plannerModelSlotId: resolvedModel.slotId,
          ...(plannerConfig.system === undefined ? {} : { systemPrompt: plannerConfig.system }),
          skills: context.skills.map(skillManifestIdentity),
          workflowDefinitionHash: requestInput.locks.workflowDefinitionHash,
          toolRegistry: options.tools,
          memoryStoreIds: context.memoryMounts.map((mount) => mount.storeId),
          bashCapabilities: plannerBashCapabilities,
          ...(requestInput.outerLoop === undefined ? {} : { outerLoopContext: requestInput.outerLoop }),
        });
        const defaultRecorder = runtime === undefined
          ? recorder
          : createHarnessEventRecorder({
              world: runtime.world,
              runId: runtime.runId,
              skipManifestDriftCheck: true,
            });
        const defaultHarnessContext = {
          ...harnessContext,
          recorder: defaultRecorder,
          durability: {
            append: async (event: { readonly type: string; readonly occurrenceId?: string; readonly payload: Record<string, unknown> }) => {
              const eventWithWarnings = eventWithSessionWarnings(event, runtime?.skillWarnings);
              await defaultRecorder.append({
                type: eventWithWarnings.type,
                ...(eventWithWarnings.occurrenceId === undefined ? {} : { occurrenceId: eventWithWarnings.occurrenceId }),
                payload: eventWithWarnings.payload,
              });
            },
            priorEvents: async (query?: { readonly runId?: string; readonly type?: string }) => {
              const events = await defaultRecorder.priorEvents(query?.runId);
              const queryType = query?.type;
              return queryType === undefined
                ? events as never
                : events.filter((event) => isEventEnvelope(event) && normalizeHarnessEventType(event.type) ===
                  normalizeHarnessEventType(queryType)) as never;
            },
          },
          session: {
            runId: context.scope.runId,
            role: "planner" as const,
            task: { kind: "plan" as const },
            ...(context.scope.parentRunId === undefined ? {} : { parentRunId: context.scope.parentRunId }),
            manifest: defaultManifest,
            manifestHash: hashHarnessManifest(defaultManifest),
            ...(runtime?.skillWarnings === undefined || runtime.skillWarnings.length === 0 ? {} : { warnings: runtime.skillWarnings }),
            ...(skillContents === undefined ? {} : { skillContents }),
          },
        };
        result = await raceAbortSignal(
          runWorkflowHarnessWithSession(workflowHarness as never, task as never, defaultHarnessContext as never),
          context.abortSignal,
        );
      }
      if (result.kind !== "plan") {
        throw new Error(
          `planner harness returned '${result.kind}' for plan task.`,
        );
      }
      return result.lwir;
    },
  };
}

function harnessIdFor(harness: Harness): string {
  const id = isRecord(harness) ? (harness as Record<string, unknown>).harnessId : undefined;
  return typeof id === "string" && id.length > 0 ? id : "customHarness@unknown";
}

function workerHarnessCapability(
  workflow: CompilableWorkflowDefinition,
): CapabilityManifest["workerHarness"] {
  const worker = workflow.worker;
  if (isRecord(worker) && isHarnessLike(worker.harness)) {
    return { harnessId: harnessIdFor(worker.harness) };
  }
  return { harnessId: harnessIdFor(workflowHarness) };
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

function plannerBashScope(runtime: PlannerHarnessRuntimeContext): Parameters<typeof createBashTool>[0] {
  const ownScratch = runtime.scratchMounts.find((mount) => mount.mountPath === "/mnt/scratch/own/");
  const readableRoots = mergedReadableRoots([
    ...(ownScratch === undefined ? [{ path: runtime.logDir, mode: "rw" as const }] : []),
    ...runtime.memoryMounts
      .filter((mount) => !mount.backingPath.includes("*"))
      .map((mount) => ({ path: mount.backingPath, mode: mount.mode })),
    ...runtime.scratchMounts
      .filter((mount) => !mount.backingPath.includes("*"))
      .map((mount) => ({ path: mount.backingPath, mode: mount.mode })),
    ...runtime.skills
      .map((skill) => stringProperty(skill, "source") ?? stringProperty(skill, "bodyPath"))
      .filter((path): path is string => typeof path === "string" && !path.includes("*"))
      .map((path) => ({ path, mode: "ro" as const })),
  ]);
  const pathAliases = [
    ...runtime.memoryMounts
      .filter((mount) => !mount.backingPath.includes("*"))
      .map((mount) => ({ mountPath: mount.mountPath, backingPath: mount.backingPath })),
    ...runtime.scratchMounts
      .filter((mount) => !mount.backingPath.includes("*"))
      .map((mount) => ({ mountPath: mount.mountPath, backingPath: mount.backingPath })),
    ...runtime.skills
      .map((skill) => {
        const mountPath = stringProperty(skill, "mountPath");
        const backingPath = stringProperty(skill, "source") ?? stringProperty(skill, "bodyPath");
        return { mountPath, backingPath };
      })
      .filter((entry): entry is { mountPath: string; backingPath: string } =>
        typeof entry.mountPath === "string" &&
        typeof entry.backingPath === "string" &&
        !entry.mountPath.includes("*") &&
        !entry.backingPath.includes("*")
      ),
  ];
  return {
    cwd: ownScratch?.mountPath ?? runtime.logDir,
    readableRoots,
    ...(runtime.bashCapabilities === undefined ? {} : { capabilities: runtime.bashCapabilities }),
    ...(pathAliases.length === 0 ? {} : { pathAliases }),
  };
}

function plannerHarnessMounts(
  runtime: PlannerHarnessRuntimeContext,
): NonNullable<Parameters<typeof workflowHarness.run>[1]>["mounts"] {
  return [
    ...runtime.memoryMounts.map((mount) => ({
      mountPath: mount.mountPath,
      backingPath: mount.backingPath,
      mode: mount.mode,
    })),
    ...runtime.scratchMounts.map((mount) => ({
      mountPath: mount.mountPath,
      backingPath: mount.backingPath,
      mode: mount.mode,
    })),
    ...runtime.skills.flatMap((skill) => {
      const mountPath = stringProperty(skill, "mountPath");
      const backingPath = stringProperty(skill, "source") ?? stringProperty(skill, "bodyPath");
      if (
        mountPath === undefined ||
        backingPath === undefined ||
        mountPath.includes("*") ||
        backingPath.includes("*")
      ) {
        return [];
      }
      return [{ mountPath, backingPath, mode: "ro" as const }];
    }),
  ];
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

function raceAbortSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(abortError());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function abortError(): Error {
  const error = new Error("Planner harness execution aborted.");
  error.name = "AbortError";
  return error;
}

function resolvePlannerModelSlot(value: unknown): ResolvedModelSlot {
  const slot = isModelSlot(value) ? value : createModelSlot(value ?? {});
  const [resolved] = resolveModelSlots([slot]);
  if (resolved === undefined) {
    throw new Error("planner model slot resolution failed.");
  }
  return resolved;
}

function isHarnessLike(value: unknown): value is Harness {
  return isRecord(value) && typeof value.run === "function";
}

function createInMemoryHarnessRecorder(runId: string): HarnessEventRecorder {
  let sequence = 0;
  const events: Array<{
    readonly eventId: string;
    readonly runId: string;
	    readonly sequence: number;
	    readonly type: HarnessEventInput["type"];
	    readonly occurrenceId?: string;
	    readonly recordedAt: string;
	    readonly payload: Record<string, unknown>;
  }> = [];

  return {
    async append(event) {
      sequence += 1;
      const envelope = {
        eventId: `inmem_${sequence}`,
        runId,
	        sequence,
	        type: event.type,
	        ...(event.occurrenceId === undefined ? {} : { occurrenceId: event.occurrenceId }),
	        recordedAt: new Date(0).toISOString(),
	        payload: event.payload,
      };
      events.push(envelope);
      return envelope;
    },
    priorEvents() {
      return events;
    },
  };
}

function eventWithSessionWarnings<TEvent extends { readonly type: string; readonly payload: Record<string, unknown> }>(
  event: TEvent,
  warnings: readonly Record<string, unknown>[] | undefined,
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

function compileOutputMode(workflow: CompilableWorkflowDefinition): CompilerOutputMode {
  const output = workflow.output ?? {
    kind: "object",
    schema: workflow.outputSchema ?? true,
  };
  const normalized = normalizeOutputMode(output);
  return compilerOutputFromNormalized(normalized);
}

function compilerOutputFromNormalized(output: NormalizedOutputMode): CompilerOutputMode {
  const metadata = stripUndefined({
    name: output.name,
    description: output.description,
  });

  switch (output.kind) {
    case "text":
      return { mode: "text", ...metadata };
    case "object":
      return { mode: "object", schema: output.schema, ...metadata };
    case "array":
      return { mode: "array", schema: { type: "array", items: output.element }, ...metadata };
    case "choice":
      return { mode: "choice", values: output.values, ...metadata };
    case "json":
      return output.schema === undefined
        ? { mode: "json", ...metadata }
        : { mode: "json", schema: output.schema, ...metadata };
  }
}

type ModelSlotEntry = {
  readonly lock: ModelSlotLock;
  readonly snapshot: ModelSlotSnapshot;
};

function modelSlotEntries(workflow: CompilableWorkflowDefinition): readonly ModelSlotEntry[] {
  const slots = resolveModelSlots(uniqueModelSlots([...(workflow.models ?? [])].filter(isModelSlot)));
  return slots.map((slot, index) => {
    const role = "model";
    const metadata = safeModelMetadata(slot.metadata);
    const modelIdentity = modelIdentityFor(slot, index);
    const metadataHash = sha256Digest(metadata);
    const modelIdentityHash = sha256Digest(modelIdentity);
    return {
      lock: {
        slotId: slot.slotId,
        role,
        metadataHash,
        modelIdentityHash,
      },
      snapshot: {
        slotId: slot.slotId,
        role,
        metadata,
        modelIdentity,
        metadataHash,
        modelIdentityHash,
      },
    };
  });
}

function uniqueModelSlots(slots: readonly ModelSlot[]): readonly ModelSlot[] {
  const unique: ModelSlot[] = [];
  for (const slot of slots) {
    if (!unique.includes(slot)) {
      unique.push(slot);
    }
  }
  return unique;
}

function globalToolSnapshots(
  workflow: CompilableWorkflowDefinition,
  registry: ToolRegistry | undefined,
): readonly ToolSnapshot[] {
  const names = workflow.globalTools ?? [];
  if (names.length === 0) {
    return [];
  }
  return [...names].sort().map((name) => {
    const tool = registry?.get(name);
    if (tool === undefined) {
      throw new WorkflowMissingToolError(`tool '${name}' is not registered`);
    }
    const description = typeof tool.description === "string" ? tool.description : "";
    const inputSchema = tool.inputSchema;
    const normalizedInputSchema = inputSchema === undefined ? undefined : normalizeSchema(inputSchema);
    if (normalizedInputSchema !== undefined) {
      validateSchemaForRequest(normalizedInputSchema, `$.tools.${name}.inputSchema`);
    }
    const outputSchema = tool.outputSchema;
    const normalizedOutputSchema = outputSchema === undefined ? undefined : normalizeSchema(outputSchema);
    if (normalizedOutputSchema !== undefined) {
      validateSchemaForRequest(normalizedOutputSchema, `$.tools.${name}.outputSchema`);
    }
    const needsApproval = tool.needsApproval;
    const approvalRequired =
      needsApproval !== undefined && needsApproval !== false ? true : undefined;
    return stripUndefined({
      name,
      scope: "global" as ToolScope,
      description,
      inputSchema: normalizedInputSchema,
      outputSchema: normalizedOutputSchema,
      approvalRequired,
      descriptionHash: sha256Digest(description),
      inputSchemaHash:
        normalizedInputSchema === undefined ? undefined : sha256Digest(normalizedInputSchema),
      outputSchemaHash:
        normalizedOutputSchema === undefined ? undefined : sha256Digest(normalizedOutputSchema),
    }) as ToolSnapshot;
  });
}

function allToolSnapshots(
  workflow: CompilableWorkflowDefinition,
  registry: ToolRegistry | undefined,
): readonly ToolSnapshot[] {
  return [...globalToolSnapshots(workflow, registry)].sort(compareToolSnapshots);
}

function compareToolSnapshots(left: ToolSnapshot, right: ToolSnapshot): number {
  const nameOrder = left.name.localeCompare(right.name);
  return nameOrder === 0 ? left.scope.localeCompare(right.scope) : nameOrder;
}

function toolSnapshots(
  tools: Record<string, unknown>,
  scope: ToolScope = "global",
): readonly ToolSnapshot[] {
  return Object.keys(tools)
    .sort()
    .map((name) => {
      const tool = tools[name];
      const descriptionValue = toolPropertyValue(tool, "description");
      const description = typeof descriptionValue === "string"
        ? descriptionValue
        : "";
      const inputSchema = toolPropertyValue(tool, "inputSchema");
      const normalizedInputSchema =
        inputSchema === undefined ? undefined : normalizeSchema(inputSchema);
      if (normalizedInputSchema !== undefined) {
        validateSchemaForRequest(normalizedInputSchema, `$.tools.${name}.inputSchema`);
      }
      const outputSchema = toolPropertyValue(tool, "outputSchema");
      const normalizedOutputSchema =
        outputSchema === undefined ? undefined : normalizeSchema(outputSchema);
      if (normalizedOutputSchema !== undefined) {
        validateSchemaForRequest(normalizedOutputSchema, `$.tools.${name}.outputSchema`);
      }
      return stripUndefined({
        name,
        scope,
        description,
        inputSchema: normalizedInputSchema,
        outputSchema: normalizedOutputSchema,
        approvalRequired: scope === "global" && toolRequiresApproval(tool) ? true : undefined,
        descriptionHash: sha256Digest(description),
        inputSchemaHash:
          normalizedInputSchema === undefined ? undefined : sha256Digest(normalizedInputSchema),
        outputSchemaHash:
          normalizedOutputSchema === undefined ? undefined : sha256Digest(normalizedOutputSchema),
      }) as ToolSnapshot;
    });
}

function toolRequiresApproval(tool: unknown): boolean {
  const value = toolPropertyValue(tool, "needsApproval");
  return value !== undefined && value !== false;
}

function toolPropertyValue(tool: unknown, key: string): unknown {
  if ((typeof tool !== "object" && typeof tool !== "function") || tool === null) {
    return undefined;
  }
  return Object.hasOwn(tool, key) ? (tool as Record<string, unknown>)[key] : undefined;
}

function safeModelMetadata(metadata: ModelSlot["metadata"]): unknown {
  return stripUndefined({
    id: metadata.id,
    description: metadata.description,
  });
}

function modelIdentityFor(slot: ResolvedModelSlot, _index: number): unknown {
  if (slot.providerId === undefined || slot.modelId === undefined) {
    return { slotId: slot.slotId };
  }
  return stripUndefined({
    providerId: slot.providerId,
    modelId: slot.modelId,
  });
}

export function snapshotWorkflowDefinition(
  workflow: CompilableWorkflowDefinition,
  registry: ToolRegistry | undefined,
): unknown {
  return getWorkflowDefinitionSnapshot(workflow, registry);
}

function validateInputAgainstSchema(input: unknown, schema: NormalizedSchemaDescriptor): void {
  if (schema === true) {
    return;
  }
  if (schema === false) {
    throw new WorkflowInputValidationError("Input schema rejects all values.");
  }
  const ajv = getAjv();
  const valid = ajv.validate(schema, input);
  if (valid !== true) {
    const message = typeof ajv.errorsText === "function"
      ? ajv.errorsText(ajv.errors)
      : "Input does not match workflow input schema.";
    throw new WorkflowInputValidationError(message);
  }
}

function validateSchemaForRequest(
  schema: NormalizedSchemaDescriptor,
  path: string,
): void {
  const findings = validateAlphaJsonSchema(schema, path);
  if (findings.length > 0) {
    throw new WorkflowSchemaValidationError(deepFreeze(canonicalClone(findings)));
  }
}

function validateRequestBinding(
  lwir: unknown,
  request: OrchestrationRequest,
): readonly LwirValidationFinding[] {
  const findings: LwirValidationFinding[] = [];
  if (!isRecord(lwir)) {
    return [
      bindingFinding("binding.invalid", "$", "LWIR document must be an object."),
    ];
  }

  if (!isRecord(lwir.metadata) || lwir.metadata.name !== request.metadata.name) {
    findings.push(
      bindingFinding(
        "binding.workflow_name_mismatch",
        "$.metadata.name",
        "LWIR workflow name must match the orchestration request.",
      ),
    );
  }

  if (
    !isRecord(lwir.input) ||
    sha256Digest(lwir.input.schema) !== request.locks.inputSchemaHash
  ) {
    findings.push(
      bindingFinding(
        "binding.input_schema_mismatch",
        "$.input.schema",
        "LWIR input schema must match the orchestration request input schema.",
      ),
    );
  }

  const expectedOutputSchema = requestedOutputSchema(request.requestedOutput);
  if (
    !isRecord(lwir.output) ||
    sha256Digest(lwir.output.schema) !== sha256Digest(expectedOutputSchema)
  ) {
    findings.push(
      bindingFinding(
        "binding.output_schema_mismatch",
        "$.output.schema",
        "LWIR output schema must match the orchestration request output schema.",
      ),
    );
  }

  const allowedModels = new Set(request.capabilityManifest.modelSlots);
  const allowedWorkflowTools = new Set(
    request.capabilityManifest.toolSelection === "explicit_only"
      ? []
      : request.capabilityManifest.tools
        .filter((tool) => tool.scope === "global")
        .map((tool) => tool.name),
  );
  const allowedSecrets = new Set(request.capabilityManifest.secrets);
  const allowedNetwork = new Set(request.capabilityManifest.network.allow);
  validatePermissionSubset(
    lwir.permissions,
    "models",
    allowedModels,
    "binding.model_disallowed",
    findings,
  );
  validatePermissionSubset(
    lwir.permissions,
    "tools",
    allowedWorkflowTools,
    "binding.tool_disallowed",
    findings,
  );
  validatePermissionSubset(
    lwir.permissions,
    "secrets",
    allowedSecrets,
    "binding.secret_disallowed",
    findings,
  );
  validatePermissionSubset(
    lwir.permissions,
    "network",
    allowedNetwork,
    "binding.network_disallowed",
    findings,
  );
  validateBoundStepReferences(lwir.steps, "$.steps", allowedModels, allowedWorkflowTools, findings);

  return findings;
}

function requestedOutputSchema(output: CompilerOutputMode): NormalizedSchemaDescriptor {
  switch (output.mode) {
    case "text":
      return { type: "string" };
    case "object":
      return output.schema;
    case "array":
      return output.schema;
    case "choice":
      return { type: "string", enum: [...output.values] };
    case "json":
      return output.schema ?? true;
  }
}

function validatePermissionSubset(
  permissions: unknown,
  key: "models" | "tools" | "secrets" | "network",
  allowedValues: ReadonlySet<string>,
  code: string,
  findings: LwirValidationFinding[],
): void {
  if (!isRecord(permissions) || !Array.isArray(permissions[key])) {
    return;
  }
  const values = permissions[key];
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (typeof value === "string" && !allowedValues.has(value)) {
      findings.push(
        bindingFinding(
          code,
          `$.permissions.${key}[${index}]`,
          `${key.slice(0, -1)} '${value}' is not available in the orchestration request.`,
        ),
      );
    }
  }
}

function validateBoundStepReferences(
  steps: unknown,
  path: string,
  allowedModels: ReadonlySet<string>,
  allowedWorkflowTools: ReadonlySet<string>,
  findings: LwirValidationFinding[],
): void {
  if (!Array.isArray(steps)) {
    return;
  }
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    if (!isRecord(step)) {
      continue;
    }
    const stepPath = `${path}[${index}]`;
    if (
      step.uses === "ai.generate" &&
      isRecord(step.with) &&
      typeof step.with.model === "string" &&
      !allowedModels.has(step.with.model)
    ) {
      findings.push(
        bindingFinding(
          "binding.model_disallowed",
          `${stepPath}.with.model`,
          `Model '${step.with.model}' is not available in the orchestration request.`,
        ),
      );
    }
    if (
      step.uses === "tool.call" &&
      isRecord(step.with) &&
      typeof step.with.tool === "string" &&
      !allowedWorkflowTools.has(step.with.tool)
    ) {
      findings.push(
        bindingFinding(
          "binding.tool_disallowed",
          `${stepPath}.with.tool`,
          `Tool '${step.with.tool}' is not available in the orchestration request.`,
        ),
      );
    }
    validateBoundStepReferences(step.steps, `${stepPath}.steps`, allowedModels, allowedWorkflowTools, findings);
  }
}

function bindingFinding(code: string, path: string, message: string): LwirValidationFinding {
  return { severity: "error", code, path, message };
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

function maxWorkflowRevisionsFor(options: OrchestrationRequestOptions): number {
  const value = options.maxWorkflowRevisions ?? options.controls?.maxWorkflowRevisions;
  return Number.isInteger(value) && value !== undefined && value > 0
    ? value
    : DEFAULT_MAX_WORKFLOW_REVISIONS;
}

function requestIdFor(requestHash: string): string {
  const hashHex = requestHash.startsWith("sha256:")
    ? requestHash.slice("sha256:".length)
    : sha256Digest(requestHash).slice("sha256:".length);
  return `orq_${hashHex.slice(0, 16)}`;
}

function snapshotRevisionValue(
  value: unknown,
  findings: readonly LwirValidationFinding[],
): unknown {
  try {
    return deepFreeze(canonicalClone(value));
  } catch (error) {
    const nonHashableFinding = findings.find((finding) => finding.code === "lwir.non_hashable");
    if (nonHashableFinding === undefined) {
      throw error;
    }
    return deepFreeze(canonicalClone(stripUndefined({
      kind: "NonHashablePlannerOutput",
      valueType: typeof value,
      constructorName: constructorNameFor(value),
      finding: nonHashableFinding,
    })));
  }
}

function canonicalClone<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}

function constructorNameFor(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const prototype = Object.getPrototypeOf(value) as { readonly constructor?: unknown } | null;
  const constructor = prototype?.constructor;
  return typeof constructor === "function" && typeof constructor.name === "string"
    ? constructor.name
    : undefined;
}

function isModelSlot(value: unknown): value is ModelSlot {
  return isRecord(value) && "aiSdkModel" in value && "metadata" in value;
}

function stripUndefined<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => stripUndefined(item)) as T;
  }

  if (isRecord(value)) {
    const result: JsonRecord = {};
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) {
        result[key] = stripUndefined(item);
      }
    }
    return result as T;
  }

  return value;
}

function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const item of value) {
      deepFreeze(item);
    }
    return Object.freeze(value) as T;
  }

  if (isRecord(value)) {
    for (const item of Object.values(value)) {
      deepFreeze(item);
    }
    return Object.freeze(value) as T;
  }

  return value;
}

function stringProperty(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const candidate = value[key];
  return typeof candidate === "string" ? candidate : undefined;
}

function propertyValue(value: unknown, key: string): unknown {
  if (!isRecord(value)) {
    return undefined;
  }
  return Object.hasOwn(value, key) ? value[key] : undefined;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEventEnvelope(value: unknown): value is EventEnvelope {
  return isRecord(value) && typeof value.type === "string" && isRecord(value.payload);
}
