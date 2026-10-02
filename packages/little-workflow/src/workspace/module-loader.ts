import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createJiti, type Jiti } from "jiti";

export function createWorkflowJiti(workspaceRoot: string): Jiti {
  return createJiti(pathToFileURL(join(resolve(workspaceRoot), "_jiti_root_.js")).href, {
    interopDefault: false,
    moduleCache: false,
    tsconfigPaths: true,
  });
}

export async function importDefault<T = unknown>(
  modulePath: string,
  workspaceRoot: string,
): Promise<T> {
  const jiti = createWorkflowJiti(workspaceRoot);
  const abs = resolve(modulePath);
  const mod = (await jiti.import(abs)) as { default?: T };
  if (mod.default === undefined) {
    throw new Error(`Workflow module '${abs}' must have a default export.`);
  }
  return mod.default;
}
