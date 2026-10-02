import { readdir } from "node:fs/promises";
import { join, parse } from "node:path";
import { HarnessInputError } from "../errors.js";
import type { HarnessWorkflow } from "../workflows.js";
import { importDefault } from "./module-loader.js";

const SOURCE_EXTENSIONS = new Set([".ts", ".js", ".mts", ".mjs", ".cts", ".cjs"]);

export async function discoverWorkflows(agentDir: string): Promise<readonly HarnessWorkflow[]> {
  const workflowsDir = join(agentDir, "workflows");
  let entries: string[];
  try {
    entries = await readdir(workflowsDir);
  } catch {
    return [];
  }

  const workflows: HarnessWorkflow[] = [];
  for (const entry of entries.sort()) {
    const { name, ext } = parse(entry);
    if (!SOURCE_EXTENSIONS.has(ext)) continue;
    if (name.endsWith(".test") || name.endsWith(".spec")) continue;
    const modulePath = join(workflowsDir, entry);
    const exported = await importDefault<Awaitable<HarnessWorkflow>>(modulePath);
    workflows.push(validateDiscoveredWorkflow(await exported, modulePath));
  }
  return workflows;
}

type Awaitable<T> = T | Promise<T>;

function validateDiscoveredWorkflow(value: unknown, modulePath: string): HarnessWorkflow {
  if (!isRecord(value)) {
    throw new HarnessInputError("Discovered workflow must default-export a workflow object.", { modulePath });
  }
  if (typeof value.id !== "string" || value.id.length === 0) {
    throw new HarnessInputError("Discovered workflow must include an id.", { modulePath });
  }
  if (value.executionMode !== "inline" && value.executionMode !== "durable") {
    throw new HarnessInputError("Discovered workflow must include executionMode.", { modulePath, workflowId: value.id });
  }
  if (typeof value.runForHarness !== "function") {
    throw new HarnessInputError("Discovered workflow must include runForHarness.", { modulePath, workflowId: value.id });
  }
  if (!isDefinitionIdentity(value.definitionIdentity)) {
    throw new HarnessInputError("Discovered workflow must include a workflow definition identity.", {
      modulePath,
      workflowId: value.id,
    });
  }
  return value as HarnessWorkflow;
}

function isDefinitionIdentity(value: unknown): boolean {
  return typeof value === "string" ||
    (isRecord(value) && value.notApplicable === true);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
