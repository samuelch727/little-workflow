import { HarnessInputError } from "../errors.js";
import type { HarnessWarning } from "../types.js";
import {
  toolInputSchemaFromWorkflowMarker,
  workflowHandleFromId,
  type HarnessWorkflow,
  type HarnessWorkflowDefinitionIdentity,
  type HarnessWorkflowInputSchema,
} from "../workflows.js";

export type ResolvedWorkflowManifestEntry = {
  readonly id: string;
  readonly handle: string;
  readonly description?: string;
  readonly executionMode: "inline" | "durable";
  readonly workflowDefinitionIdentity: HarnessWorkflowDefinitionIdentity;
  readonly launcherHandle?: string;
  readonly inputSchema: HarnessWorkflowInputSchema | undefined;
};

export type ResolvedAgentManifest = {
  readonly workflows: readonly ResolvedWorkflowManifestEntry[];
  readonly configuredToolNames: readonly string[];
  readonly mcpToolNames: readonly string[];
  readonly taskControlToolNames: readonly string[];
  readonly workflowInspectionToolNames: readonly string[];
  readonly dynamicWorkflowToolNames: readonly string[];
  readonly asyncLauncherNames: readonly string[];
  readonly warnings: readonly HarnessWarning[];
};

export type ResolveAgentManifestOptions = {
  readonly configuredToolNames?: readonly string[];
  readonly discoveredToolNames?: readonly string[];
  readonly mcpToolNames?: readonly string[];
  readonly taskControlToolNames?: readonly string[];
  readonly workflowInspectionToolNames?: readonly string[];
  readonly dynamicWorkflowToolNames?: readonly string[];
  readonly generatedLauncherNames?: readonly string[];
  readonly workflows?: readonly HarnessWorkflow[];
};

export const HARNESS_TASK_CONTROL_TOOL_NAMES = [
  "list_tasks",
  "get_task",
  "task_result",
  "await_tasks",
  "set_task_wakeup",
  "cancel_task",
] as const;

export const HARNESS_WORKFLOW_INSPECTION_TOOL_NAMES = [
  "list_workflows",
  "get_workflow",
  "get_workflow_task",
  "get_workflow_run",
] as const;

// Defined as an `as const` array (not a `Set`) so it feeds `resolveAgentManifest`'s
// `readonly string[]` categories directly, matching the task-control / inspection siblings.
export const HARNESS_DYNAMIC_WORKFLOW_TOOL_NAMES = [
  "run_ad_hoc_plan",
  "search_authored_plans",
] as const;

export function resolveAgentManifest(options: ResolveAgentManifestOptions): ResolvedAgentManifest {
  const configuredToolNames = sortedUnique(options.configuredToolNames ?? []);
  const discoveredToolNames = sortedUnique(options.discoveredToolNames ?? []);
  const toolNames = sortedUnique([
    ...(options.configuredToolNames ?? []),
    ...(options.discoveredToolNames ?? []),
  ]);
  const mcpToolNames = sortedUnique(options.mcpToolNames ?? []);
  const taskControlToolNames = sortedUnique(options.taskControlToolNames ?? []);
  const workflowInspectionToolNames = sortedUnique(options.workflowInspectionToolNames ?? []);
  const dynamicWorkflowToolNames = sortedUnique(options.dynamicWorkflowToolNames ?? []);
  const warnings: HarnessWarning[] = [];

  for (const [label, names] of [
    ["configured tool", configuredToolNames],
    ["discovered tool", discoveredToolNames],
    ["MCP tool", mcpToolNames],
    ["task-control tool", taskControlToolNames],
    ["workflow-inspection tool", workflowInspectionToolNames],
    ["dynamic-workflow tool", dynamicWorkflowToolNames],
  ] as const) {
    rejectReservedStartNames(label, names);
  }

  const workflowEntries = (options.workflows ?? []).map((workflow) => {
    const handle = workflowHandleFromId(workflow.id);
    rejectReservedStartNames("workflow", [handle]);
    if (!isDefinitionIdentity(workflow.definitionIdentity)) {
      throw new HarnessInputError("Workflow must include a workflow definition identity.", {
        workflowId: workflow.id,
      });
    }
    validateWorkflowInputSchema(workflow);
    if (workflow.inputSchema?.kind === "json-schema" && workflow.inputSchema.lossy === true) {
      warnings.push({
        code: "provider_warning",
        message: `Workflow '${workflow.id}' uses a lossy input schema marker.`,
        metadata: { workflowId: workflow.id, workflowHandle: handle },
      });
    }
    return {
      id: workflow.id,
      handle,
      ...(workflow.description === undefined ? {} : { description: workflow.description }),
      executionMode: workflow.executionMode,
      workflowDefinitionIdentity: workflow.definitionIdentity,
      launcherHandle: `start_${handle}`,
      inputSchema: workflow.inputSchema,
    } satisfies ResolvedWorkflowManifestEntry;
  });

  rejectCollisions("MCP tool", mcpToolNames, "configured tool", toolNames);
  rejectDuplicates("workflow handle", workflowEntries.map((entry) => entry.handle));
  rejectCollisions("workflow", workflowEntries.map((entry) => entry.handle), "configured tool", toolNames);
  rejectCollisions("workflow", workflowEntries.map((entry) => entry.handle), "MCP tool", mcpToolNames);

  const workflowHandles = workflowEntries.map((entry) => entry.handle);
  rejectCollisions("task-control tool", taskControlToolNames, "configured tool", toolNames);
  rejectCollisions("task-control tool", taskControlToolNames, "MCP tool", mcpToolNames);
  rejectCollisions("task-control tool", taskControlToolNames, "workflow", workflowHandles);
  rejectCollisions("workflow-inspection tool", workflowInspectionToolNames, "configured tool", toolNames);
  rejectCollisions("workflow-inspection tool", workflowInspectionToolNames, "MCP tool", mcpToolNames);
  rejectCollisions("workflow-inspection tool", workflowInspectionToolNames, "workflow", workflowHandles);
  rejectCollisions("workflow-inspection tool", workflowInspectionToolNames, "task-control tool", taskControlToolNames);
  rejectCollisions("dynamic-workflow tool", dynamicWorkflowToolNames, "configured tool", toolNames);
  rejectCollisions("dynamic-workflow tool", dynamicWorkflowToolNames, "MCP tool", mcpToolNames);
  rejectCollisions("dynamic-workflow tool", dynamicWorkflowToolNames, "workflow", workflowHandles);
  rejectCollisions("dynamic-workflow tool", dynamicWorkflowToolNames, "task-control tool", taskControlToolNames);
  rejectCollisions("dynamic-workflow tool", dynamicWorkflowToolNames, "workflow-inspection tool", workflowInspectionToolNames);

  const rawAsyncLauncherNames = [
    ...workflowEntries.map((entry) => entry.launcherHandle).filter((value): value is string => value !== undefined),
    ...(options.generatedLauncherNames ?? []),
  ];
  rejectDuplicates("async launcher", rawAsyncLauncherNames);
  const asyncLauncherNames = sortedUnique(rawAsyncLauncherNames);
  rejectCollisions("async launcher", asyncLauncherNames, "configured tool", toolNames);
  rejectCollisions("async launcher", asyncLauncherNames, "MCP tool", mcpToolNames);
  rejectCollisions("async launcher", asyncLauncherNames, "task-control tool", taskControlToolNames);
  rejectCollisions("async launcher", asyncLauncherNames, "workflow-inspection tool", workflowInspectionToolNames);
  rejectCollisions("async launcher", asyncLauncherNames, "dynamic-workflow tool", dynamicWorkflowToolNames);
  rejectCollisions("async launcher", asyncLauncherNames, "workflow", workflowHandles);

  return {
    workflows: workflowEntries,
    configuredToolNames: toolNames,
    mcpToolNames,
    taskControlToolNames,
    workflowInspectionToolNames,
    dynamicWorkflowToolNames,
    asyncLauncherNames,
    warnings,
  };
}

function validateWorkflowInputSchema(workflow: HarnessWorkflow): void {
  try {
    toolInputSchemaFromWorkflowMarker(workflow.inputSchema);
  } catch (error) {
    throw new HarnessInputError(
      error instanceof Error ? error.message : "Workflow input schema is not model-tool compatible.",
      { workflowId: workflow.id },
    );
  }
}

function rejectReservedStartNames(label: string, names: readonly string[]): void {
  for (const name of names) {
    if (name.startsWith("start_")) {
      throw new HarnessInputError(`${label} name uses reserved start_ prefix.`, { toolName: name });
    }
  }
}

function rejectDuplicates(label: string, names: readonly string[]): void {
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) {
      throw new HarnessInputError(`${label} is not unique.`, { toolName: name });
    }
    seen.add(name);
  }
}

function rejectCollisions(
  leftLabel: string,
  leftNames: readonly string[],
  rightLabel: string,
  rightNames: readonly string[],
): void {
  const right = new Set(rightNames);
  for (const name of leftNames) {
    if (right.has(name)) {
      throw new HarnessInputError(`${leftLabel} name collides with ${rightLabel}.`, { toolName: name });
    }
  }
}

function sortedUnique(names: readonly string[]): string[] {
  return [...new Set(names)].sort();
}

function isDefinitionIdentity(value: unknown): value is HarnessWorkflowDefinitionIdentity {
  return typeof value === "string" ||
    (isRecord(value) && value.notApplicable === true);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
