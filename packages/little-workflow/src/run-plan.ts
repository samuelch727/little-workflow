import { join } from "node:path";
import type { LwirWorkflow } from "./lwir.js";
import { readStoredWorkflowVersion } from "./workflow-version-store.js";
import type { EventEnvelope } from "./world.js";
import type { World } from "./world-port.js";

/** How a run got the plan it ran. Every completed `runWorkflow` result carries one as `result.plan`. */
export type RunPlan = {
  /**
   * - `"drafted"`: the planner wrote a new plan for this run.
   * - `"kept"`: an earlier plan ran unchanged.
   * - `"adapted"`: the planner changed an earlier plan.
   * - `"fixed"`: the workflow's own `plan` ran.
   */
  readonly kind: "drafted" | "kept" | "adapted" | "fixed";
  /**
   * Whether this run called the planner model. False for a fixed plan, and for a plan kept because
   * nothing the planner reads changed since it was written.
   */
  readonly plannerCalled: boolean;
  /** The WorkflowVersion that ran. Read its steps with `readWorkflowVersion(world, id)`. */
  readonly workflowVersionId: string;
  /** For `"kept"` and `"adapted"`: the earlier WorkflowVersion the plan came from. */
  readonly previousWorkflowVersionId?: string;
  /** Why an earlier plan was kept, adapted or replaced, when one was considered. */
  readonly rationale?: string;
};

/** A stored WorkflowVersion: the plan one or more runs executed. */
export type StoredWorkflowPlan = {
  readonly workflowVersionId: string;
  readonly workflowId: string;
  /** The plan as an LWIR document. Its `steps` are what the run executed. */
  readonly lwir: LwirWorkflow;
};

/** INTERNAL. Work out `result.plan` from a run's events. */
export function runPlanFromEvents(
  events: readonly EventEnvelope[],
  options: { readonly workflowVersionId: string; readonly fixedPlan: boolean },
): RunPlan {
  const decision = [...events].reverse().find((event) => event.type === "PlannerReuseDecisionRecorded")?.payload;
  const plannerCalled = !options.fixedPlan && events.some((event) => event.type === "PlannerStarted");
  const rationale = typeof decision?.rationale === "string" ? decision.rationale : undefined;
  const previousWorkflowVersionId = typeof decision?.candidateWorkflowVersionId === "string"
    ? decision.candidateWorkflowVersionId
    : undefined;
  const kind: RunPlan["kind"] = options.fixedPlan
    ? "fixed"
    : decision?.decisionKind === "reuse_unchanged"
      ? "kept"
      : decision?.decisionKind === "adapt"
        ? "adapted"
        : "drafted";
  return {
    kind,
    plannerCalled,
    workflowVersionId: options.workflowVersionId,
    ...(kind === "kept" || kind === "adapted") && previousWorkflowVersionId !== undefined
      ? { previousWorkflowVersionId }
      : {},
    ...(rationale === undefined || options.fixedPlan ? {} : { rationale }),
  };
}

/**
 * Read the plan a run executed, by its WorkflowVersion id (`result.workflowVersionId` or
 * `result.plan.workflowVersionId`), from the world the run used.
 */
export async function readWorkflowVersion(world: World, workflowVersionId: string): Promise<StoredWorkflowPlan> {
  let stored: Awaited<ReturnType<typeof readStoredWorkflowVersion>>;
  try {
    stored = await readStoredWorkflowVersion(world, workflowVersionId);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      throw new Error(
        `No WorkflowVersion '${workflowVersionId}' in ${join(world.dataDir, "workflow-versions")}. ` +
          "Pass the world the run used.",
      );
    }
    throw error;
  }
  return {
    workflowVersionId: stored.id,
    workflowId: stored.lwir.metadata.name,
    lwir: stored.lwir,
  };
}
