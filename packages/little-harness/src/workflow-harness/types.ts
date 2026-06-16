import { HARNESS_EVENT_TYPES, type HarnessEventType } from "../events/names.js";
import type { HarnessDurabilitySink, HarnessTraceSink } from "../events/occurrence.js";
import type { HarnessRuntimeMount, JsonObject } from "../types.js";

export const WORKFLOW_HARNESS_ID = "workflowHarness@1.0.0";

export type WorkflowHarness = {
  readonly harnessId?: string;
  readonly run: (
    task: WorkflowHarnessTask,
    ctx: WorkflowHarnessContext,
  ) => Promise<WorkflowHarnessResult>;
};

export type WorkflowHarnessTask =
  | WorkflowPlanTask
  | WorkflowOrchestrateTask
  | WorkflowExecuteStepTask
  | WorkflowFixStepTask;

export type WorkflowPlanTask = {
  readonly kind: "plan";
  readonly workflowSnapshot: WorkflowDefinitionSnapshot;
  readonly input: unknown;
  readonly systemMessage?: string;
  readonly outerLoopContext?: unknown;
};

export type WorkflowOrchestrateTask = {
  readonly kind: "orchestrate";
  readonly available: readonly WorkflowDefinitionSnapshot[];
  readonly input: unknown;
};

export type WorkflowExecuteStepTask = {
  readonly kind: "execute_step";
  readonly step: WorkflowStep;
  readonly stepInput: unknown;
  readonly stepContext: WorkflowStepContext;
};

export type WorkflowStepContext = {
  readonly stepPath: string;
  readonly visitIndex: number;
  readonly attempt?: number;
  readonly toolCallScope?: JsonObject;
  readonly toolExecutionContext?: unknown;
};

export type WorkflowFixStepTask = {
  readonly kind: "fix_step";
  readonly step: WorkflowStep;
  readonly stepInput: unknown;
  readonly originalAttemptError: ErrorEnvelope;
  readonly priorFixAttempts: number;
};

export type WorkflowHarnessContext = {
  readonly scope: WorkflowHarnessScope;
  readonly session: WorkflowHarnessSessionContext;
  readonly model: ResolvedWorkflowModel;
  readonly system?: string;
  readonly tools: Readonly<Record<string, unknown>>;
  readonly memoryMounts: readonly WorkflowMemoryMount[];
  readonly scratchMounts: readonly WorkflowScratchMount[];
  readonly skills: readonly WorkflowSkillDescriptor[];
  readonly mounts: readonly HarnessRuntimeMount[];
  readonly bashCapabilities?: WorkflowBashCapabilities;
  readonly durability: WorkflowHarnessDurabilitySink;
  readonly trace?: WorkflowHarnessTraceSink;
  readonly abortSignal: AbortSignal;
  readonly permissions?: WorkflowToolPermissions;
};

export type WorkflowHarnessSessionContext = {
  readonly runId: string;
  readonly role: WorkflowHarnessRole;
  readonly task: { readonly kind: WorkflowHarnessTask["kind"] };
  readonly manifest: unknown;
  readonly manifestHash: string;
  readonly parentRunId?: string;
  readonly warnings?: readonly JsonObject[];
  readonly skillContents?: unknown;
};

export type WorkflowHarnessResult =
  | { readonly kind: "plan"; readonly lwir: unknown }
  | { readonly kind: "orchestrate"; readonly output: unknown }
  | {
      readonly kind: "execute_step";
      readonly output: unknown;
      readonly artifactRefs: readonly WorkflowArtifactRef[];
    }
  | {
      readonly kind: "fix_step";
      readonly output: unknown;
      readonly fixedSource: string;
      readonly attempts: number;
    }
  | { readonly kind: "delegate_to_default" };

export type WorkflowHarnessScope = {
  readonly runId: string;
  readonly logDir: string;
  readonly role: WorkflowHarnessRole;
  readonly parentRunId?: string;
  readonly stepPath?: string;
};

export type WorkflowHarnessRole =
  | "planner"
  | "orchestrator"
  | "worker.ai-generate"
  | "worker.code-run"
  | "worker.tool-call"
  | "fixer";

export type WorkflowStep =
  | WorkflowAiGenerateStep
  | WorkflowCodeRunStep
  | WorkflowToolCallStep
  | WorkflowDecisionStep
  | WorkflowParallelStep;

export type WorkflowAiGenerateStep = JsonObject & {
  readonly id: string;
  readonly uses: "ai.generate";
  readonly with?: {
    readonly model?: string;
    readonly prompt?: unknown;
    readonly [key: string]: unknown;
  };
  readonly output?: unknown;
};

export type WorkflowCodeRunStep = JsonObject & {
  readonly id: string;
  readonly uses: "code.run";
  readonly with: WorkflowCodeRunConfig;
  readonly output?: unknown;
};

export type WorkflowCodeRunConfig = {
  readonly entrypoint: string;
  readonly files: WorkflowCodeRunFiles;
  readonly sandbox: WorkflowCodeRunSandboxPolicy;
  readonly [key: string]: unknown;
};

export type WorkflowCodeRunFiles = Readonly<Record<string, WorkflowCodeRunFile>>;

export type WorkflowCodeRunFile = {
  readonly content: string;
  readonly sha256: `sha256:${string}`;
  readonly [key: string]: unknown;
};

export type WorkflowCodeRunSandboxPolicy = {
  readonly network: "deny" | false;
  readonly env?: "deny" | false;
  readonly fs?: "deny" | false;
  readonly [key: string]: unknown;
};

export type WorkflowToolCallStep = JsonObject & {
  readonly id: string;
  readonly uses: "tool.call";
  readonly with?: {
    readonly tool?: string;
    readonly args?: unknown;
    readonly [key: string]: unknown;
  };
  readonly output?: unknown;
};

export type WorkflowDecisionStep = JsonObject & {
  readonly id: string;
  readonly uses: "decision";
  readonly output?: unknown;
};

export type WorkflowParallelStep = JsonObject & {
  readonly id: string;
  readonly uses: "parallel";
  readonly steps: readonly WorkflowStep[];
  readonly output?: unknown;
};

export type WorkflowDefinitionSnapshot = {
  readonly id: string;
  readonly description: string;
  readonly inputSchema: unknown;
  readonly suggestedInputSchema?: unknown;
  readonly outputSchema: unknown;
  readonly workflowDefinitionHash: string;
};

export type WorkflowBashCapabilities = {
  readonly network?: false | true | Record<string, unknown>;
  readonly python?: boolean;
  readonly javascript?: boolean;
};

export type WorkflowMemoryMount = {
  readonly storeId: string;
  readonly mountPath: string;
  readonly backingPath: string;
  readonly mode: "rw" | "ro";
};

export type WorkflowScratchMount = {
  readonly mountPath: string;
  readonly backingPath: string;
  readonly mode: "rw" | "ro";
};

export type WorkflowSkillDescriptor = {
  readonly name: string;
  readonly description: string;
  readonly bodyPath: string;
  readonly auxFiles?: readonly string[];
  readonly model?: string;
  readonly allowedTools?: readonly string[];
  readonly [key: string]: unknown;
};

export type ResolvedWorkflowModel = {
  readonly slotId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly model: unknown;
  readonly [key: string]: unknown;
};

export type WorkflowArtifactRef = `artifact://${string}`;

export type WorkflowToolPermissions = {
  readonly ruleset: readonly WorkflowPermissionRule[];
  readonly onAsk?: (request: {
    readonly tool: string;
    readonly args: unknown;
  }) => Promise<boolean>;
};

export type WorkflowPermissionRule = {
  readonly tool: string;
  readonly action: "allow" | "deny" | "ask";
};

export type ErrorEnvelope = {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
  readonly cause?: unknown;
  readonly [key: string]: unknown;
};

export type WorkflowHarnessEventType =
  | HarnessEventType
  | "harness.execute_step.started"
  | "harness.execute_step.succeeded";

export const workflowHarnessEventTypes: readonly WorkflowHarnessEventType[] = [
  ...HARNESS_EVENT_TYPES,
  "harness.execute_step.started",
  "harness.execute_step.succeeded",
];

export const workflowDurableHarnessEventTypes = [
  "harness.session.started",
  "harness.session.completed",
  "harness.session.failed",
  "harness.model.called",
  "harness.model.responded",
  "harness.model.failed",
  "harness.tool_call.started",
  "harness.tool_call.succeeded",
  "harness.tool_call.failed",
  "harness.execute_step.started",
  "harness.execute_step.succeeded",
] as const;

export type WorkflowDurableHarnessEventType =
  (typeof workflowDurableHarnessEventTypes)[number];

export type WorkflowHarnessDurabilitySink =
  HarnessDurabilitySink<WorkflowDurableHarnessEventType>;
export type WorkflowHarnessTraceSink = HarnessTraceSink<WorkflowHarnessEventType>;

const workflowDurableHarnessEventTypeSet = new Set<string>(
  workflowDurableHarnessEventTypes,
);

export function isWorkflowDurableHarnessEventType(
  value: unknown,
): value is WorkflowDurableHarnessEventType {
  return typeof value === "string" && workflowDurableHarnessEventTypeSet.has(value);
}
