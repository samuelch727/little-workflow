import type { ToolSet } from "ai";
import type { Harness, HarnessHost, SkillInput } from "../types.js";
import type { HarnessWorkflow } from "../workflows.js";
import { HarnessInputError } from "../errors.js";
import { HARNESS_AGENT_GROUP_TOOL_NAMES } from "../agents/tools.js";
import { HARNESS_TASK_CONTROL_TOOL_NAMES, HARNESS_WORKFLOW_INSPECTION_TOOL_NAMES, resolveAgentManifest } from "./resolve-agent-manifest.js";
import { rejectReservedDiscoveredToolNames } from "./tool-name-policy.js";

/** A factory creates chat-local tools/model/config using the host supplied by the application. */
export type HarnessDefinition = Harness | ((host: HarnessHost) => Harness | Promise<Harness>);
export type CompiledHarnessOptions = { host: HarnessHost };

export async function instantiateHarness(definition: HarnessDefinition, host?: HarnessHost): Promise<Harness> {
  if (typeof definition === "function") {
    if (host === undefined) throw new HarnessInputError("An agent factory requires an explicit host.");
    definition = await definition(host);
  }
  if (definition?.config === undefined) throw new HarnessInputError("agent.ts must default-export a Harness or a host factory.");
  return definition;
}

/** Shared by Node discovery and static compilation: inline tools and system take precedence. */
export function assembleHarness(
  base: Harness,
  { tools, skills, workflows, instructions }: { tools: ToolSet; skills: SkillInput[]; workflows: readonly HarnessWorkflow[]; instructions?: string },
  options: { host?: HarnessHost } = {},
): Harness {
  rejectReservedDiscoveredToolNames(Object.keys(tools));
  const system = base.config.system ?? instructions;
  const mergedWorkflows = [...(base.config.workflows ?? []), ...workflows];
  resolveAgentManifest({
    configuredToolNames: Object.keys(base.config.tools),
    discoveredToolNames: Object.keys(tools),
    taskControlToolNames: HARNESS_TASK_CONTROL_TOOL_NAMES,
    workflowInspectionToolNames: HARNESS_WORKFLOW_INSPECTION_TOOL_NAMES,
    agentGroupToolNames: base.config.agents ? HARNESS_AGENT_GROUP_TOOL_NAMES : [],
    workflows: mergedWorkflows,
  });
  return {
    ...base,
    ...(options.host === undefined ? {} : { sessions: options.host.sessions }),
    config: {
      ...base.config,
      ...(options.host === undefined ? {} : { host: options.host }),
      ...(system === undefined ? {} : { system }),
      tools: { ...tools, ...base.config.tools },
      skills: [...base.config.skills, ...skills],
      workflows: mergedWorkflows,
    },
  };
}
