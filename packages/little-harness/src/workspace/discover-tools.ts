import { sourceFiles } from "./folder-layout.js";
import { join, parse } from "node:path";
import type { ToolSet } from "ai";
import { importDefault } from "./module-loader.js";

/**
 * Discover an agent folder's tools from `<agentDir>/tools/*.{ts,js,...}`. Each file default-exports
 * an AI SDK tool; the tool name is the filename without extension. `*.test.*`/`*.spec.*` files are
 * skipped. Returns `{}` when there is no `tools/` directory.
 */
export async function discoverTools(agentDir: string): Promise<ToolSet> {
  const tools: ToolSet = {};
  for (const file of await sourceFiles(join(agentDir, "tools"))) {
    tools[parse(file).name] = await importDefault(file);
  }
  return tools;
}
