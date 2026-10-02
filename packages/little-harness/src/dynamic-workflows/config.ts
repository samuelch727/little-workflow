import { HarnessInputError } from "../errors.js";
import type { DynamicWorkflowFactory, DynamicWorkflowLimits, DynamicWorkflowsConfig } from "./types.js";

export const DEFAULT_DYNAMIC_WORKFLOW_LIMITS: DynamicWorkflowLimits = {
  maxSteps: 8,
  maxRuntimeMs: 120_000,
};

export type ResolvedDynamicWorkflows = {
  readonly factory: DynamicWorkflowFactory;
  readonly exclude: readonly string[];
  readonly limits: DynamicWorkflowLimits;
};

export function resolveDynamicWorkflows(
  input: DynamicWorkflowsConfig | undefined,
): ResolvedDynamicWorkflows | undefined {
  if (input === undefined) return undefined;
  if (
    typeof input !== "object" ||
    input === null ||
    (input as { enabled?: unknown }).enabled !== true ||
    typeof (input as { factory?: unknown }).factory !== "object" ||
    (input as { factory?: unknown }).factory === null ||
    typeof (input as { factory?: { compile?: unknown } }).factory?.compile !== "function"
  ) {
    throw new HarnessInputError(
      "dynamicWorkflows must be the result of dynamicWorkflows() from little-workflow (it injects the lowering factory). A bare `true` cannot work because little-workflow depends on little-harness.",
    );
  }
  const limits = { ...DEFAULT_DYNAMIC_WORKFLOW_LIMITS, ...(input.limits ?? {}) };
  assertPositiveInteger("limits.maxSteps", limits.maxSteps);
  assertPositiveInteger("limits.maxRuntimeMs", limits.maxRuntimeMs);
  return {
    factory: input.factory,
    exclude: input.exclude ?? [],
    limits,
  };
}

function assertPositiveInteger(field: string, value: number): void {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new HarnessInputError(
      `dynamicWorkflows ${field} must be a positive integer; got ${String(value)}. ` +
        "This bounds one-shot plans (a non-positive or non-finite value would disable the cap).",
      { field, value },
    );
  }
}
