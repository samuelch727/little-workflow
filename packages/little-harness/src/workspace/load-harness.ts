import { compareNames, fileExists } from "./folder-layout.js";
import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Harness, HarnessHost } from "../types.js";
import { assembleHarness, instantiateHarness, type HarnessDefinition } from "./assemble-harness.js";
import { discoverSkills } from "./discover-skills.js";
import { discoverTools } from "./discover-tools.js";
import { discoverWorkflows } from "./discover-workflows.js";
import { importDefault } from "./module-loader.js";
import {
  DISCOVERED_TOOL_NAME,
  RESERVED_DISCOVERED_TOOL_NAMES,
  rejectReservedDiscoveredToolNames,
} from "./tool-name-policy.js";

// The discovered tool-name policy lives in ./tool-name-policy.js so the connector discovery path can
// reuse it. Re-export it here so existing `workspace/load-harness` importers keep working.
export { DISCOVERED_TOOL_NAME, RESERVED_DISCOVERED_TOOL_NAMES, rejectReservedDiscoveredToolNames };

// Repeated factory loads sharing a data directory must also share its in-process queue.
const fallbackHosts = new Map<string, HarnessHost>();
async function fallbackHost(dataDir?: string): Promise<HarnessHost> {
  const [{ localHost }, { resolveLocalHostPaths }] = await Promise.all([
    import("../local-host/local-host.js"), import("../local-host/paths.js"),
  ]);
  const resolved = resolveLocalHostPaths(dataDir === undefined ? {} : { dataDir }).dataDir;
  let host = fallbackHosts.get(resolved);
  if (host === undefined) {
    host = localHost({ dataDir: resolved });
    fallbackHosts.set(resolved, host);
  }
  return host;
}

async function readInstructions(agentDir: string): Promise<string | undefined> {
  try {
    const text = (await readFile(join(agentDir, "instructions.md"), "utf8")).trim();
    return text.length > 0 ? text : undefined;
  } catch {
    return undefined;
  }
}

export type LoadHarnessOptions = {
  /**
   * Run the folder's agent on this host instead of the one `agent.ts` configured, for example
   * `localHost({ dataDir })` in a test or a script. The harness's sessions come from this host.
   */
  host?: HarnessHost;
  /** Node factory fallback only; existing Harness exports keep their configured host. */
  dataDir?: string;
};

/**
 * Load an agent folder into a runnable {@link Harness}. Imports `<agentDir>/agent.ts` (a Harness
 * or `(host) => Harness` factory; factories share a Node localHost per resolved dataDir), auto-discovers `tools/` and `skills/`, applies
 * `instructions.md` as the system prompt when `agent.ts` omits `system`, and shallow-merges the
 * discovered tools/skills into the harness config (inline tools win name collisions).
 */
export async function loadHarness(agentDir: string, options: LoadHarnessOptions = {}): Promise<Harness> {
  const definition = await importDefault<HarnessDefinition>(join(agentDir, "agent.ts"));
  const host = options.host ?? (typeof definition === "function"
    ? await fallbackHost(options.dataDir)
    : undefined);
  const base = await instantiateHarness(definition, host);
  const [tools, skills, workflows] = await Promise.all([
    discoverTools(agentDir),
    discoverSkills(agentDir),
    discoverWorkflows(agentDir),
  ]);
  const instructions = await readInstructions(agentDir);
  return assembleHarness(base, { tools, skills, workflows, ...(instructions === undefined ? {} : { instructions }) }, host === undefined ? options : { host });
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
  const subdirs = entries.filter((e) => e.isDirectory()).sort((a, b) => compareNames(a.name, b.name));
  for (const entry of subdirs) {
    const dir = join(agentsDir, entry.name);
    if (await fileExists(join(dir, "agent.ts"))) agents.push({ name: entry.name, dir });
  }
  return { agentsDir, agents };
}
