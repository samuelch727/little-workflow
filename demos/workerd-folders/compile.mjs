import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { compileHarnessWorkspace } from "@little-stack/harness/compiler";
const root = fileURLToPath(new URL(".", import.meta.url));
const moduleDir = fileURLToPath(new URL("src/", import.meta.url));
await writeFile(new URL("src/agents.generated.ts", import.meta.url), await compileHarnessWorkspace(root, { moduleDir }));
