import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createJiti } from "jiti";
import { HarnessInputError } from "../errors.js";

/**
 * Import the default export of a `.ts`/`.js` module by absolute path via jiti, so agent folders can
 * be loaded at runtime without a build step. Throws if there is no default export.
 *
 * The jiti instance is rooted at the current working directory (the user's project), NOT at this
 * package, so an agent's bare imports — `from "little-harness"`, `from "@ai-sdk/..."` — resolve
 * against the user's `node_modules`. (Rooting at `import.meta.url` would resolve from inside the
 * installed little-harness package, where those specifiers do not exist.)
 */
export async function importDefault<T = unknown>(modulePath: string): Promise<T> {
  const jiti = createJiti(pathToFileURL(join(process.cwd(), "_jiti_root_.js")).href, { interopDefault: false });
  const abs = resolve(modulePath); // jiti treats a relative path as a bare specifier; resolve to absolute first
  const mod = (await jiti.import(abs)) as { default?: T };
  if (mod.default === undefined) {
    throw new HarnessInputError("Agent module must have a default export.", { path: abs });
  }
  return mod.default;
}
