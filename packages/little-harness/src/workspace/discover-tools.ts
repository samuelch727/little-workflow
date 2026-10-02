import { readdir } from "node:fs/promises";
import { join, parse } from "node:path";
import type { ToolSet } from "ai";
import { importDefault } from "./module-loader.js";

const SOURCE_EXTENSIONS = new Set([".ts", ".js", ".mts", ".mjs", ".cts", ".cjs"]);

/**
 * Discover an agent folder's tools from `<agentDir>/tools/*.{ts,js,...}`. Each file default-exports
 * an AI SDK tool; the tool name is the filename without extension. `*.test.*`/`*.spec.*` files are
 * skipped. Returns `{}` when there is no `tools/` directory.
 */
export async function discoverTools(agentDir: string): Promise<ToolSet> {
  const toolsDir = join(agentDir, "tools");
  let entries: string[];
  try {
    entries = await readdir(toolsDir);
  } catch {
    return {};
  }
  const tools: ToolSet = {};
  for (const entry of entries.sort()) {
    const { name, ext } = parse(entry);
    if (!SOURCE_EXTENSIONS.has(ext)) continue;
    if (name.endsWith(".test") || name.endsWith(".spec")) continue;
    tools[name] = await importDefault(join(toolsDir, entry));
  }
  return tools;
}
