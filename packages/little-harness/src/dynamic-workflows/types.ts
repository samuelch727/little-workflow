import type { HarnessWorkflow } from "../workflows.js";

export type DynamicWorkflowLimits = {
  readonly maxSteps: number;
  readonly maxRuntimeMs: number;
};

export type DynamicAllowedCapabilities = {
  readonly tools: readonly string[]; // parent-snapshot tool + MCP handle names, minus exclude
  readonly models: readonly string[]; // ["default"]
  readonly bash: boolean; // parent snapshot has bash, and not excluded
};

export type DynamicPlanSubmission = {
  readonly purpose: string;
  readonly reasonConfiguredWorkflowsDoNotFit?: string;
  readonly plan: unknown; // untrusted, model-authored step-DAG
  readonly input: unknown;
  readonly outputSchema: unknown; // JSON schema (or true)
  readonly allowed: DynamicAllowedCapabilities;
  readonly limits: DynamicWorkflowLimits;
};

export type DynamicReferencedCapabilities = {
  readonly tools: readonly string[];
  readonly models: readonly string[];
  readonly bash: boolean;
};

export type DynamicCompileResult =
  | {
      readonly ok: true;
      readonly workflow: HarnessWorkflow;
      readonly definitionHash: string; // == workflow.definitionIdentity
      readonly lwir: unknown; // frozen LwirWorkflow (for the artifact record)
      readonly referenced: DynamicReferencedCapabilities;
    }
  | {
      readonly ok: false;
      readonly causeCode: "plan_invalid" | "capability_not_allowed";
      readonly message: string;
      readonly findings?: readonly unknown[];
    };

export interface DynamicWorkflowFactory {
  compile(submission: DynamicPlanSubmission): DynamicCompileResult;
}

export type DynamicWorkflowsConfig = {
  readonly enabled: true;
  readonly factory: DynamicWorkflowFactory;
  readonly exclude?: readonly string[];
  readonly limits?: Partial<DynamicWorkflowLimits>;
};
