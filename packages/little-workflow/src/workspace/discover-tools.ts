import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, parse } from "node:path";
import { createToolRegistry, type AiSdkTool, type ToolRegistry } from "../tool-registry.js";
import { importDefault } from "./module-loader.js";

const SOURCE_EXTENSIONS = new Set([".ts", ".js", ".mts", ".mjs", ".cts", ".cjs"]);

export type DiscoveredTools = {
  readonly registry: ToolRegistry;
  readonly modulePaths: readonly string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isAiSdkTool(value: unknown): value is AiSdkTool {
  return isRecord(value) && (typeof value.execute === "function" || value.inputSchema !== undefined);
}

export async function discoverTools(
  workflowDir: string,
  workspaceRoot: string,
): Promise<DiscoveredTools> {
  const toolsDir = join(workflowDir, "tools");
  let entries: Dirent[];
  try {
    entries = await readdir(toolsDir, { withFileTypes: true });
  } catch {
    return { registry: createToolRegistry(), modulePaths: [] };
  }

  const tools: Record<string, AiSdkTool> = {};
  const modulePaths: string[] = [];
  const seen = new Map<string, string>();
  const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of sorted) {
    if (!entry.isFile()) continue;
    const { name, ext } = parse(entry.name);
    if (!SOURCE_EXTENSIONS.has(ext)) continue;
    if (name.endsWith(".test") || name.endsWith(".spec")) continue;
    const previous = seen.get(name);
    if (previous !== undefined) {
      throw new Error(
        `Tool id '${name}' is defined by multiple files (${previous}, ${entry.name}); use distinct ids.`,
      );
    }
    seen.set(name, entry.name);
    const modulePath = join(toolsDir, entry.name);
    const tool = await importDefault<AiSdkTool>(modulePath, workspaceRoot);
    if (!isAiSdkTool(tool)) {
      throw new Error(`Tool '${name}' (${modulePath}) must default-export an AI SDK tool.`);
    }
    tools[name] = tool;
    modulePaths.push(modulePath);
  }

  return { registry: createToolRegistry(tools), modulePaths };
}
