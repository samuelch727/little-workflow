import type {
  WorkflowHarnessContext,
  WorkflowHarnessResult,
  WorkflowHarnessTask,
} from "little-harness/workflow-harness";

export type {
  ErrorEnvelope,
  ResolvedWorkflowModel as ResolvedModel,
  WorkflowArtifactRef as ArtifactRef,
  WorkflowBashCapabilities,
  WorkflowDefinitionSnapshot,
  WorkflowExecuteStepTask as ExecuteStepTask,
  WorkflowFixStepTask as FixStepTask,
  WorkflowHarnessRole as HarnessRole,
  WorkflowHarnessScope as HarnessScope,
  WorkflowMemoryMount as MemoryMount,
  WorkflowOrchestrateTask as OrchestrateTask,
  WorkflowPlanTask as PlanTask,
  WorkflowScratchMount as ScratchMount,
  WorkflowSkillDescriptor as SkillDescriptor,
  WorkflowToolPermissions as ToolPermissions,
} from "little-harness/workflow-harness";

export type HarnessTask = WorkflowHarnessTask;
export type HarnessResult = WorkflowHarnessResult;
export type HarnessContext = WorkflowHarnessContext & {
  readonly bash?: BashTool;
  readonly recorder?: HarnessEventRecorder;
};
export type Harness = {
  readonly harnessId?: string;
  readonly run: (task: HarnessTask, ctx: HarnessContext) => Promise<HarnessResult>;
};

export type ToolSet = Readonly<Record<string, unknown>>;
export type OuterLoopContext = unknown;

export type ErrorEnvelopeValue =
  | null
  | boolean
  | number
  | string
  | readonly ErrorEnvelopeValue[]
  | { readonly [key: string]: ErrorEnvelopeValue };

export type HarnessEventInput = {
  readonly type: string;
  readonly occurrenceId?: string;
  readonly payload: Record<string, unknown>;
};

export type HarnessEventRecorder = {
  readonly append: (event: HarnessEventInput) => Promise<unknown>;
  readonly priorEvents: (runId?: string) => Promise<readonly unknown[]> | readonly unknown[];
};

export type BashTool = {
  readonly description?: string;
  readonly inputSchema?: unknown;
  readonly outputSchema?: unknown;
  readonly execute: (input: unknown, options?: unknown) => Promise<unknown> | unknown;
};
