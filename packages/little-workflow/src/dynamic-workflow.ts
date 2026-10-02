import type { DynamicWorkflowsConfig, DynamicWorkflowLimits } from "little-harness";
import { littleWorkflowDynamicWorkflowFactory } from "./dynamic-workflow-factory.js";

export function dynamicWorkflows(
  options: { exclude?: readonly string[]; limits?: Partial<DynamicWorkflowLimits> } = {},
): DynamicWorkflowsConfig {
  return {
    enabled: true,
    factory: littleWorkflowDynamicWorkflowFactory(),
    ...(options.exclude ? { exclude: options.exclude } : {}),
    ...(options.limits ? { limits: options.limits } : {}),
  };
}

export { littleWorkflowDynamicWorkflowFactory } from "./dynamic-workflow-factory.js";
export type { AdHocPlan, AdHocPlanStep } from "./dynamic-workflow-plan.js";
