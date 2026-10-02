import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Harness } from "../types.js";
import { discoverSkills } from "./discover-skills.js";
import { discoverTools } from "./discover-tools.js";
import { discoverWorkflows } from "./discover-workflows.js";
import { importDefault } from "./module-loader.js";
import {
  HARNESS_TASK_CONTROL_TOOL_NAMES,
  HARNESS_WORKFLOW_INSPECTION_TOOL_NAMES,
  resolveAgentManifest,
} from "./resolve-agent-manifest.js";
import {
  DISCOVERED_TOOL_NAME,
  RESERVED_DISCOVERED_TOOL_NAMES,
  rejectReservedDiscoveredToolNames,
} from "./tool-name-policy.js";

// The discovered tool-name policy lives in ./tool-name-policy.js so the connector discovery path can
// reuse it. Re-export it here so existing `workspace/load-harness` importers keep working.
export { DISCOVERED_TOOL_NAME, RESERVED_DISCOVERED_TOOL_NAMES, rejectReservedDiscoveredToolNames };

async function fileExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function readInstructions(agentDir: string): Promise<string | undefined> {
  try {
    const text = (await readFile(join(agentDir, "instructions.md"), "utf8")).trim();
    return text.length > 0 ? text : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Load an agent folder into a runnable {@link Harness}. Imports `<agentDir>/agent.ts` (a plain
 * `createHarness(...)` default export), auto-discovers `tools/` and `skills/`, applies
 * `instructions.md` as the system prompt when `agent.ts` omits `system`, and shallow-merges the
 * discovered tools/skills into the harness config (inline tools win name collisions).
 */
export async function loadHarness(agentDir: string): Promise<Harness> {
  const base = await importDefault<Harness>(join(agentDir, "agent.ts"));
  const [tools, skills, workflows] = await Promise.all([
    discoverTools(agentDir),
    discoverSkills(agentDir),
    discoverWorkflows(agentDir),
  ]);
  rejectReservedDiscoveredToolNames(Object.keys(tools));
  const system = base.config.system ?? (await readInstructions(agentDir));
  const mergedWorkflows = [...(base.config.workflows ?? []), ...workflows];
  resolveAgentManifest({
    configuredToolNames: Object.keys(base.config.tools),
    discoveredToolNames: Object.keys(tools),
    taskControlToolNames: HARNESS_TASK_CONTROL_TOOL_NAMES,
    workflowInspectionToolNames: HARNESS_WORKFLOW_INSPECTION_TOOL_NAMES,
    workflows: mergedWorkflows,
  });
  return {
    ...base,
    config: {
      ...base.config,
      ...(system === undefined ? {} : { system }),
      tools: { ...tools, ...base.config.tools },
      skills: [...base.config.skills, ...skills],
      workflows: mergedWorkflows,
    },
  };
}

export type WorkspaceAgent = { readonly name: string; readonly dir: string };

/**
 * Enumerate the agents in a workspace. Reads `little-harness.json` (`{ "agents": "agents" }` by
 * default) from `root` and returns each immediate subdirectory of the agents dir that has an `agent.ts`.
 */
export async function loadWorkspace(
  root: string = process.cwd(),
): Promise<{ agentsDir: string; agents: WorkspaceAgent[] }> {
  let agentsRel = "agents";
  try {
    const marker = JSON.parse(await readFile(join(root, "little-harness.json"), "utf8")) as { agents?: string };
    if (typeof marker.agents === "string" && marker.agents.length > 0) agentsRel = marker.agents;
  } catch {
    /* default to "agents" */
  }
  const agentsDir = join(root, agentsRel);
  let entries: Dirent[];
  try {
    entries = await readdir(agentsDir, { withFileTypes: true });
  } catch {
    return { agentsDir, agents: [] };
  }
  const agents: WorkspaceAgent[] = [];
  const subdirs = entries.filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of subdirs) {
    const dir = join(agentsDir, entry.name);
    if (await fileExists(join(dir, "agent.ts"))) agents.push({ name: entry.name, dir });
  }
  return { agentsDir, agents };
}
