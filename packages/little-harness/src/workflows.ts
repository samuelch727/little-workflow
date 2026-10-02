import { createHash } from "node:crypto";
import { jsonSchema, tool, type FlexibleSchema, type ToolExecutionOptions, type ToolSet } from "ai";
import { HarnessInputError } from "./errors.js";
import {
  runWithWorkflowRunSlot,
  WorkflowQueueOverflowError,
  type WorkflowRunConcurrencyBudgets,
} from "./utils/workflow-concurrency.js";

export const HARNESS_FAILURE_CAUSE_CODES = [
  "timeout",
  "cancelled",
  "input_validation",
  "plan_invalid",
  "workflow_failed",
  "unsupported_protocol",
  "unsupported_durable_host",
  "unsupported_prepared_workflow",
  "runtime_await_would_park",
  "budget_exceeded",
  "token_budget_exceeded",
  "output_budget_exceeded",
  "capability_not_allowed",
  "replay_identity_mismatch",
  "launch_corruption",
  "queue_corruption",
  "stale_workflow_definition",
  "stale_capability_snapshot",
  "stale_prepared_handle",
  "uncertain_after_restart",
  "max_model_steps",
  "max_tool_calls",
  "max_concurrent_tool_calls",
  "max_queued_workflow_runs",
] as const;

export type HarnessFailureCauseCode = (typeof HARNESS_FAILURE_CAUSE_CODES)[number];
export type HarnessNotApplicableIdentity = {
  readonly notApplicable: true;
  readonly reason?: string;
};

export type HarnessWorkflowDefinitionIdentity = string | HarnessNotApplicableIdentity;

export type HarnessWorkflowInputSchema =
  | {
    readonly kind: "json-schema";
    readonly schema: unknown;
    readonly lossy?: boolean;
    readonly warning?: string;
  }
  | {
    readonly kind: "untyped";
    readonly allowUntypedInput: boolean;
  }
  | {
    readonly kind: "unconvertible";
    readonly error: string;
  };

export type HarnessWorkflowMountDeclaration = {
  readonly name: string;
  readonly path: string;
  readonly access: "read" | "readwrite";
};

export type HarnessWorkflowCapabilityPolicy = {
  readonly mode: "none" | "allowlist";
  readonly handles?: readonly string[];
};

export type HarnessWorkflowSkillPolicy = {
  readonly mode: "none" | "allowlist";
  readonly names?: readonly string[];
};

export type HarnessWorkflowInheritancePolicy = {
  readonly tools?: HarnessWorkflowCapabilityPolicy;
  readonly mcpTools?: HarnessWorkflowCapabilityPolicy;
  readonly bash?: HarnessWorkflowCapabilityPolicy;
  readonly code?: HarnessWorkflowCapabilityPolicy;
  readonly workflows?: HarnessWorkflowCapabilityPolicy;
  readonly skills?: HarnessWorkflowSkillPolicy;
  readonly mounts?: readonly HarnessWorkflowMountDeclaration[];
  readonly pipelineMemory?: "snapshot" | "none";
  readonly permissions?: {
    readonly mode: "snapshot" | "none";
    readonly approvalPolicy?: "reject_ask" | "ask_becomes_deny";
  };
};

export type HarnessWorkflowInheritance = HarnessWorkflowInheritancePolicy;

export const DEFAULT_WORKFLOW_INHERITANCE_POLICY = {
  tools: { mode: "none" },
  mcpTools: { mode: "none" },
  bash: { mode: "none" },
  code: { mode: "none" },
  workflows: { mode: "none" },
  skills: { mode: "none" },
  mounts: [],
  pipelineMemory: "none",
  permissions: { mode: "none", approvalPolicy: "reject_ask" },
} satisfies Required<HarnessWorkflowInheritancePolicy>;

export type HarnessChildCapabilities = {
  readonly tools: Readonly<Record<string, unknown>>;
  readonly mcpTools: Readonly<Record<string, unknown>>;
  readonly bash: Readonly<Record<string, unknown>>;
  /**
   * Opaque model-slot map (slot name -> raw provider model). Read by the dynamic-workflow
   * factory (`modelsFromContext`), which wraps each raw value via `model(raw, { id: slot })`.
   * Optional because the harness's own `executeWorkflowVersion` path does not populate it;
   * the dynamic-plan run context (`dynamic-workflows/tools.ts`) sets `{ default: <raw model> }`.
   */
  readonly models?: Readonly<Record<string, unknown>>;
  readonly code: Readonly<Record<string, unknown>>;
  readonly workflows: Readonly<Record<string, unknown>>;
  readonly skills: Readonly<Record<string, unknown>>;
  readonly mounts: readonly HarnessWorkflowMountDeclaration[];
  readonly pipelineMemory?: unknown;
  readonly permissions: Readonly<Record<string, unknown>> & {
    readonly approvalPolicy: "reject_ask" | "ask_becomes_deny";
  };
};

export type HarnessWorkflowParentSnapshot = {
  readonly tools?: Readonly<Record<string, unknown>>;
  readonly mcpTools?: Readonly<Record<string, unknown>>;
  readonly bash?: Readonly<Record<string, unknown>>;
  readonly code?: Readonly<Record<string, unknown>>;
  readonly workflows?: Readonly<Record<string, unknown>>;
  readonly skills?: Readonly<Record<string, unknown>>;
  readonly mounts?: readonly HarnessWorkflowMountDeclaration[];
  readonly pipelineMemory?: unknown;
  readonly permissions?: Readonly<Record<string, unknown>>;
};

export type HarnessWorkflowRunContext = {
  readonly protocolVersion: 1;
  readonly workflowId: string;
  readonly workflowHandle: string;
  readonly definitionIdentity: HarnessWorkflowDefinitionIdentity;
  readonly toolCallId: string;
  readonly disposition: "await" | "start";
  readonly parentSessionId: string;
  readonly parentTurnId: string;
  readonly originTurnId: string;
  readonly continuationId?: string;
  readonly reservedRunId: string;
  readonly persistence: {
    readonly dataDir: string;
  };
  readonly abortSignal?: AbortSignal | undefined;
  readonly executionBudget?: unknown;
  readonly inheritance: HarnessWorkflowInheritance;
  readonly capabilities?: HarnessChildCapabilities;
  readonly observation: {
    recordProgress(progress: unknown): Promise<void>;
  };
};

export type HarnessCompletedWorkflowExecution = {
  readonly protocolVersion: 1;
  readonly status: "completed";
  readonly runId: string;
  readonly output: unknown;
  readonly outputPath?: string;
  readonly summary?: string;
};

export type HarnessFailedWorkflowExecution = {
  readonly protocolVersion: 1;
  readonly status: "failed";
  readonly runId: string;
  readonly causeCode: HarnessFailureCauseCode;
  readonly message: string;
  readonly summary?: string;
};

export type HarnessCancelledWorkflowExecution = {
  readonly protocolVersion: 1;
  readonly status: "cancelled";
  readonly runId: string;
  readonly causeCode: "cancelled";
  readonly message: string;
  readonly summary?: string;
};

export type HarnessRunningWorkflowExecution = {
  readonly protocolVersion: 1;
  readonly status: "running";
  readonly runId: string;
  readonly outputPath?: string;
  readonly summary?: string;
};

export type HarnessWorkflowExecution =
  | HarnessCompletedWorkflowExecution
  | HarnessFailedWorkflowExecution
  | HarnessCancelledWorkflowExecution
  | HarnessRunningWorkflowExecution;

export type HarnessPreparedWorkflow = {
  readonly protocolVersion: 1;
  readonly workflowId: string;
  readonly versionId: string;
  readonly workflowDefinitionHash: HarnessWorkflowDefinitionIdentity;
  readonly capabilityHash: string | HarnessNotApplicableIdentity;
  readonly modelToolSkillSnapshotHash: string | HarnessNotApplicableIdentity;
  readonly inputShapeHash: string | HarnessNotApplicableIdentity;
};

export type HarnessPreparedWorkflowSnapshotEnvelope = Pick<
  HarnessPreparedWorkflow,
  "workflowId" | "workflowDefinitionHash" | "capabilityHash" | "modelToolSkillSnapshotHash" | "inputShapeHash"
> & {
  readonly exampleInputHash: string;
};

export type HarnessWorkflowPrepareContext = Omit<HarnessWorkflowRunContext, "disposition" | "reservedRunId"> & {
  readonly prepareId: string;
  readonly prepareCallIdentity: string;
  readonly prepareSnapshot: HarnessPreparedWorkflowSnapshotEnvelope;
};

export type HarnessWorkflow = {
  readonly id: string;
  readonly description?: string;
  readonly inputSchema?: HarnessWorkflowInputSchema | undefined;
  readonly executionMode: "inline" | "durable";
  readonly definitionIdentity: HarnessWorkflowDefinitionIdentity;
  readonly inheritancePolicy?: HarnessWorkflowInheritancePolicy | undefined;
  runForHarness(input: unknown, ctx: HarnessWorkflowRunContext): Promise<HarnessWorkflowExecution>;
  prepareForHarness?(
    input: unknown,
    ctx: HarnessWorkflowPrepareContext,
  ): Promise<HarnessPreparedWorkflow>;
  runPreparedForHarness?(
    prepared: HarnessPreparedWorkflow,
    input: unknown,
    ctx: HarnessWorkflowRunContext,
  ): Promise<HarnessWorkflowExecution>;
};

export type ResolveHarnessWorkflowToolsOptions = {
  readonly sessionId: string;
  readonly turnId: string;
  readonly originTurnId: string;
  readonly dataDir: string;
  readonly abortSignal?: AbortSignal | undefined;
  readonly parentSnapshot?: HarnessWorkflowParentSnapshot | undefined;
  /**
   * The session's workflow-run admission budgets. All workflow tools of a session share one
   * bound (see `utils/workflow-concurrency.ts`), so a model emitting N parallel workflow tool
   * calls never gets more than `maxConcurrentWorkflowRuns` runs in flight. Omitted budgets
   * fall back to the harness defaults — never to "unbounded".
   */
  readonly budgets?: WorkflowRunConcurrencyBudgets | undefined;
};

const HARNESS_TOOL_HANDLE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/u;
const MAX_RESERVED_WORKFLOW_RUN_ID_LENGTH = 128;
const harnessFailureCauseCodeSet = new Set<string>(HARNESS_FAILURE_CAUSE_CODES);

export function workflowHandleFromId(id: string): string {
  const segments = id.split(".");
  if (segments.length === 0 || segments.some((segment) => segment.length === 0)) {
    throw new HarnessInputError("Workflow id must produce a valid workflow handle.", {
      workflowId: id,
    });
  }
  const handle = segments.map((segment) => segment.replace(/[^A-Za-z0-9_]/gu, "_")).join("_");
  if (!HARNESS_TOOL_HANDLE.test(handle)) {
    throw new HarnessInputError("Workflow id must produce a valid workflow handle.", {
      workflowId: id,
      workflowHandle: handle,
    });
  }
  return handle;
}

export function toolInputSchemaFromWorkflowMarker(
  marker: HarnessWorkflowInputSchema | undefined,
): FlexibleSchema<unknown> {
  if (marker === undefined) {
    throw new HarnessInputError(
      "Workflow inputSchema is required. Use the explicit untyped input marker to allow untyped input.",
    );
  }
  if (marker.kind === "json-schema") {
    return jsonSchema<unknown>(marker.schema as never);
  }
  if (marker.kind === "untyped") {
    if (marker.allowUntypedInput !== true) {
      throw new HarnessInputError("Workflow untyped input must be explicitly allowed.");
    }
    return jsonSchema<unknown>({
      type: "object",
      additionalProperties: true,
    });
  }
  if (marker.kind === "unconvertible") {
    throw new HarnessInputError(marker.error);
  }
  throw new HarnessInputError("Workflow input schema marker is not convertible to a tool schema.");
}

export function workflowToolDescription(workflow: HarnessWorkflow): string {
  const description = workflow.description ?? `Run the ${workflow.id} workflow.`;
  const warning = workflow.inputSchema?.kind === "json-schema" ? workflow.inputSchema.warning : undefined;
  if (warning === undefined || warning.length === 0) {
    return description;
  }
  return `${description}\n\nWorkflow input schema warning: ${warning}`;
}

export function validateHarnessWorkflowExecution(value: unknown): HarnessWorkflowExecution {
  if (!isRecord(value)) {
    throw new HarnessInputError("Workflow execution must be an object.");
  }
  if (value.protocolVersion !== 1) {
    throw new HarnessInputError("Unsupported workflow execution protocol version.", {
      protocolVersion: value.protocolVersion,
    });
  }
  if (
    value.status !== "completed" &&
    value.status !== "failed" &&
    value.status !== "cancelled" &&
    value.status !== "running"
  ) {
    throw new HarnessInputError("Unsupported status in workflow execution.", {
      status: value.status,
    });
  }
  if (typeof value.runId !== "string" || value.runId.length === 0) {
    throw new HarnessInputError("Workflow execution must include a runId.");
  }
  if (
    value.causeCode !== undefined &&
    (typeof value.causeCode !== "string" || !harnessFailureCauseCodeSet.has(value.causeCode))
  ) {
    throw new HarnessInputError("Unsupported workflow failure causeCode.", {
      causeCode: value.causeCode,
    });
  }
  if (value.status === "completed" && !Object.hasOwn(value, "output")) {
    throw new HarnessInputError("Completed workflow execution must include output.");
  }
  if (value.status === "failed") {
    if (typeof value.causeCode !== "string" || !harnessFailureCauseCodeSet.has(value.causeCode)) {
      throw new HarnessInputError("Failed workflow execution must include a supported causeCode.");
    }
  }
  if (value.status === "cancelled") {
    if (value.causeCode !== "cancelled") {
      throw new HarnessInputError("Cancelled workflow execution must include causeCode 'cancelled'.");
    }
  }
  if (
    (value.status === "failed" || value.status === "cancelled") &&
    (typeof value.message !== "string" || value.message.length === 0)
  ) {
    throw new HarnessInputError(`${value.status} workflow execution must include a message.`);
  }
  if (value.summary !== undefined && typeof value.summary !== "string") {
    throw new HarnessInputError("Workflow execution summary must be a string.");
  }
  if (value.outputPath !== undefined && typeof value.outputPath !== "string") {
    throw new HarnessInputError("Workflow execution outputPath must be a string.");
  }
  if ((value.status === "failed" || value.status === "cancelled") && value.outputPath !== undefined) {
    throw new HarnessInputError(`${value.status} workflow execution must not include outputPath.`);
  }
  return value as HarnessWorkflowExecution;
}

export function resolveWorkflowInheritance(
  policy: HarnessWorkflowInheritancePolicy | undefined,
  parentSnapshot: HarnessWorkflowParentSnapshot,
): HarnessChildCapabilities {
  const effectivePolicy = workflowInheritancePolicy(policy);
  return {
    tools: selectHandleCapabilities("tool", effectivePolicy.tools, parentSnapshot.tools),
    mcpTools: selectHandleCapabilities("MCP tool", effectivePolicy.mcpTools, parentSnapshot.mcpTools),
    bash: selectHandleCapabilities("bash capability", effectivePolicy.bash, parentSnapshot.bash),
    code: selectHandleCapabilities("code capability", effectivePolicy.code, parentSnapshot.code),
    workflows: selectHandleCapabilities("workflow", effectivePolicy.workflows, parentSnapshot.workflows),
    skills: selectSkillCapabilities(effectivePolicy.skills, parentSnapshot.skills),
    mounts: [...(effectivePolicy.mounts ?? [])],
    pipelineMemory:
      effectivePolicy.pipelineMemory === "snapshot"
        ? parentSnapshot.pipelineMemory
        : undefined,
    permissions:
      effectivePolicy.permissions?.mode === "snapshot"
        ? {
          ...(parentSnapshot.permissions ?? {}),
          approvalPolicy:
            effectivePolicy.permissions.approvalPolicy ??
            approvalPolicyFromParent(parentSnapshot.permissions?.approvalPolicy) ??
            "reject_ask",
        }
        : {
          approvalPolicy: effectivePolicy.permissions?.approvalPolicy ?? "reject_ask",
        },
  };
}

export function resolveHarnessWorkflowTools(
  workflows: readonly HarnessWorkflow[] | undefined,
  options: ResolveHarnessWorkflowToolsOptions,
): ToolSet {
  const tools: ToolSet = {};
  if (workflows === undefined || workflows.length === 0) {
    return tools;
  }
  for (const workflow of workflows) {
    const name = workflowHandleFromId(workflow.id);
    if (Object.hasOwn(tools, name)) {
      throw new HarnessInputError("Workflow tool handle is not unique.", {
        workflowId: workflow.id,
        workflowHandle: name,
      });
    }
    const inputSchema = toolInputSchemaFromWorkflowMarker(workflow.inputSchema);
    const inheritance = workflowInheritancePolicy(workflow.inheritancePolicy);
    const capabilities = resolveWorkflowInheritance(inheritance, options.parentSnapshot ?? {});
    tools[name] = tool({
      description: workflowToolDescription(workflow),
      inputSchema,
      execute: async (input, executeOptions) => {
        const ctx = workflowRunContext(workflow, name, options, executeOptions, inheritance, capabilities);
        // Admission control for the tool-call path: the slot is held only around the run
        // itself, so validation/compaction never occupies a slot. Excess parallel calls wait
        // their turn; only a queue past the budget fails, and it says which budget.
        let raw: HarnessWorkflowExecution;
        try {
          raw = await runWithWorkflowRunSlot(
            options.sessionId,
            options.budgets,
            () => workflow.runForHarness(input, ctx),
          );
        } catch (error) {
          if (error instanceof WorkflowQueueOverflowError) {
            return {
              status: "failed",
              runId: ctx.reservedRunId,
              causeCode: error.causeCode,
              message: error.message,
            };
          }
          throw error;
        }
        const execution = validateHarnessWorkflowExecution(raw);
        if (workflow.executionMode === "inline" && execution.status === "running") {
          return {
            status: "failed",
            runId: execution.runId,
            causeCode: "unsupported_protocol",
            message: "Inline workflows must complete or fail within the tool call.",
          };
        }
        if (execution.status === "running" && execution.runId !== ctx.reservedRunId) {
          return {
            status: "failed",
            runId: ctx.reservedRunId,
            causeCode: "launch_corruption",
            message: "Running workflow execution returned a runId that does not match the reserved run id.",
          };
        }
        return compactWorkflowExecution(execution);
      },
    });
  }
  return tools;
}

function workflowRunContext(
  workflow: HarnessWorkflow,
  workflowHandle: string,
  options: ResolveHarnessWorkflowToolsOptions,
  executeOptions: ToolExecutionOptions<unknown>,
  inheritance: HarnessWorkflowInheritance,
  capabilities: HarnessChildCapabilities,
): HarnessWorkflowRunContext {
  const toolCallId = executeOptions.toolCallId ?? `${workflowHandle}_manual`;
  return {
    protocolVersion: 1,
    workflowId: workflow.id,
    workflowHandle,
    definitionIdentity: workflow.definitionIdentity,
    toolCallId,
    disposition: "await",
    parentSessionId: options.sessionId,
    parentTurnId: options.turnId,
    originTurnId: options.originTurnId,
    reservedRunId: reservedWorkflowRunId(workflowHandle, toolCallId),
    persistence: { dataDir: options.dataDir },
    abortSignal: executeOptions.abortSignal ?? options.abortSignal,
    inheritance,
    capabilities,
    observation: {
      async recordProgress() {},
    },
  };
}

function compactWorkflowExecution(execution: HarnessWorkflowExecution): Record<string, unknown> {
  if (execution.status === "completed") {
    const result: Record<string, unknown> = {
      status: "completed",
      runId: execution.runId,
    };
    if (execution.summary !== undefined) {
      result.outputSummary = execution.summary;
    }
    if (execution.outputPath !== undefined) {
      result.outputPath = execution.outputPath;
    }
    return result;
  }
  if (execution.status === "failed" || execution.status === "cancelled") {
    const result: Record<string, unknown> = {
      status: execution.status,
      runId: execution.runId,
      causeCode: execution.causeCode,
      message: execution.message,
    };
    // The protocol has always allowed `summary` on a failed/cancelled execution (the validator
    // bans only `outputPath` there); forward it so a producer can explain the failure.
    if (execution.summary !== undefined) {
      result.outputSummary = execution.summary;
    }
    return result;
  }
  return {
    status: "running",
    runId: execution.runId,
    outputSummary: execution.summary,
    outputPath: execution.outputPath,
  };
}

function workflowInheritancePolicy(
  policy: HarnessWorkflowInheritancePolicy | undefined,
): HarnessWorkflowInheritancePolicy {
  return {
    tools: policy?.tools ?? DEFAULT_WORKFLOW_INHERITANCE_POLICY.tools,
    mcpTools: policy?.mcpTools ?? DEFAULT_WORKFLOW_INHERITANCE_POLICY.mcpTools,
    bash: policy?.bash ?? DEFAULT_WORKFLOW_INHERITANCE_POLICY.bash,
    code: policy?.code ?? DEFAULT_WORKFLOW_INHERITANCE_POLICY.code,
    workflows: policy?.workflows ?? DEFAULT_WORKFLOW_INHERITANCE_POLICY.workflows,
    skills: policy?.skills ?? DEFAULT_WORKFLOW_INHERITANCE_POLICY.skills,
    mounts: policy?.mounts ?? DEFAULT_WORKFLOW_INHERITANCE_POLICY.mounts,
    pipelineMemory: policy?.pipelineMemory ?? DEFAULT_WORKFLOW_INHERITANCE_POLICY.pipelineMemory,
    permissions: policy?.permissions ?? DEFAULT_WORKFLOW_INHERITANCE_POLICY.permissions,
  };
}

function selectHandleCapabilities(
  label: string,
  policy: HarnessWorkflowCapabilityPolicy | undefined,
  parentCapabilities: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> {
  if (policy?.mode !== "allowlist") {
    return {};
  }
  return selectNamedCapabilities(label, policy.handles ?? [], parentCapabilities);
}

function selectSkillCapabilities(
  policy: HarnessWorkflowSkillPolicy | undefined,
  parentCapabilities: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> {
  if (policy?.mode !== "allowlist") {
    return {};
  }
  return selectNamedCapabilities("skill", policy.names ?? [], parentCapabilities);
}

function selectNamedCapabilities(
  label: string,
  names: readonly string[],
  parentCapabilities: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> {
  const selected: Record<string, unknown> = {};
  for (const name of names) {
    if (parentCapabilities === undefined || !Object.hasOwn(parentCapabilities, name)) {
      throw new HarnessInputError(`Workflow inheritance ${label} '${name}' is not present in the parent manifest.`);
    }
    selected[name] = parentCapabilities[name];
  }
  return selected;
}

function approvalPolicyFromParent(value: unknown): "reject_ask" | "ask_becomes_deny" | undefined {
  return value === "reject_ask" || value === "ask_becomes_deny" ? value : undefined;
}

function reservedWorkflowRunId(workflowHandle: string, toolCallId: string): string {
  if (/^[A-Za-z0-9_]+$/u.test(toolCallId)) {
    const simple = `run_${workflowHandle}_${toolCallId}`;
    if (simple.length <= MAX_RESERVED_WORKFLOW_RUN_ID_LENGTH) {
      return simple;
    }
  }

  const base = `run_${workflowHandle}_`;
  const hash = createHash("sha256").update(toolCallId).digest("hex").slice(0, 12);
  const safePrefix = toolCallId.replace(/[^A-Za-z0-9_]/gu, "_").replace(/^_+/u, "") || "call";
  const prefixBudget = Math.max(1, MAX_RESERVED_WORKFLOW_RUN_ID_LENGTH - base.length - hash.length - 1);
  const boundedPrefix = safePrefix.slice(0, prefixBudget);
  const reservedRunId = `${base}${boundedPrefix}_${hash}`;
  if (!/^run_[A-Za-z0-9_]+$/u.test(reservedRunId) || reservedRunId.length > MAX_RESERVED_WORKFLOW_RUN_ID_LENGTH) {
    throw new HarnessInputError("Reserved workflow run id is not persistence safe.", {
      workflowHandle,
    });
  }
  return reservedRunId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
