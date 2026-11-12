import { sourceFiles } from "./folder-layout.js";
import { join } from "node:path";
import { validateDiscoveredWorkflow } from "./validate-workflow.js";
import type { HarnessWorkflow } from "../workflows.js";
import { importDefault } from "./module-loader.js";

export async function discoverWorkflows(agentDir: string): Promise<readonly HarnessWorkflow[]> {
  const workflows: HarnessWorkflow[] = [];
  for (const modulePath of await sourceFiles(join(agentDir, "workflows"))) {
    const exported = await importDefault<Awaitable<HarnessWorkflow>>(modulePath);
    workflows.push(validateDiscoveredWorkflow(await exported, modulePath));
  }
  return workflows;
}

type Awaitable<T> = T | Promise<T>;
