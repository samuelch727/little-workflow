import type { PlannerConfig } from "./authoring.js";
import { sha256Digest } from "./canonical.js";
import {
  FIXED_PLAN_HARNESS_PREFIX,
  fixedPlanLwir,
  type CompilableWorkflowDefinition,
} from "./compiler.js";
import type { Harness } from "./harness/types.js";
import type { LwirStep, LwirWorkflow } from "./lwir.js";

/**
 * A plan written by hand instead of drafted by a planner model, for
 * `defineWorkflow({ plan })`. List the steps; the workflow name, input schema and output schema
 * come from the definition, and the permissions from the tools and model slots the steps use.
 */
export type FixedPlan = {
  readonly steps: readonly LwirStep[];
};

export { FIXED_PLAN_HARNESS_PREFIX, isFixedPlanPlanner } from "./compiler.js";

/**
 * Stands in for the planner model of a fixed-plan workflow. It is never called: the fixed-plan
 * harness answers the plan task itself. It only gives the planner session a stable model identity.
 */
const FIXED_PLAN_MODEL = Object.freeze({ provider: "little-workflow", modelId: "fixed-plan" });

type FixedPlanDefinition = Pick<
  CompilableWorkflowDefinition,
  "id" | "description" | "inputSchema" | "output" | "outputSchema"
>;

/** Build the planner of a workflow whose plan is fixed: a harness that returns the plan, no model call. */
export function fixedPlanPlanner(definition: FixedPlanDefinition, plan: FixedPlan | LwirWorkflow): PlannerConfig {
  if (!isRecord(plan) || !Array.isArray(plan.steps)) {
    throw new TypeError(`defineWorkflow '${definition.id}': plan must be { steps: [...] } or a complete LWIR document.`);
  }
  const lwir: LwirWorkflow = isCompleteLwir(plan) ? plan : fixedPlanLwir(definition, plan.steps);
  const harness: Harness = {
    // The plan hash is part of the harness id, so the workflow definition hash changes with the plan.
    harnessId: `${FIXED_PLAN_HARNESS_PREFIX}${sha256Digest(lwir)}`,
    async run(task) {
      if (task.kind !== "plan") return { kind: "delegate_to_default" };
      return { kind: "plan", lwir };
    },
  };
  return { model: FIXED_PLAN_MODEL, harness };
}

function isCompleteLwir(plan: FixedPlan | LwirWorkflow): plan is LwirWorkflow {
  return isRecord(plan) && typeof (plan as { readonly apiVersion?: unknown }).apiVersion === "string";
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
