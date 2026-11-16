/** Explicit, shallow workspace discovery. A workspace is an agents/ directory, not a project root. */
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { AGENT_ENTRY_FILES, IGNORED_DIRS, bundleAgent, type BundleResult } from "./index.js";
import { NAME_PATTERN } from "../protocol.js";

export type WorkspaceBundleResult = BundleResult & { readonly folder: string };

export function validateWorkspaceNames(folders: readonly string[]): void {
  const names = folders.map((name) => name.toLowerCase());
  if (new Set(names).size !== names.length) throw new Error("Workspace agent names collide after lowercasing.");
  if (names.some((name) => !NAME_PATTERN.test(name))) throw new Error("Workspace folder names must be valid agent names (1–63 lowercase letters, digits, ., _ or -).");
}

export async function bundleWorkspace(folder: string): Promise<WorkspaceBundleResult[]> {
  const root = resolve(folder);
  const entries = await readdir(root, { withFileTypes: true });
  const folders: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, "en"))) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || IGNORED_DIRS.has(entry.name)) continue;
    const files = await readdir(join(root, entry.name));
    if (AGENT_ENTRY_FILES.some((file) => files.includes(file))) folders.push(entry.name);
  }
  if (folders.length === 0) throw new Error(`No agent folders found directly under ${root}.`);
  validateWorkspaceNames(folders);
  const results: WorkspaceBundleResult[] = [];
  // Build everything before the caller can upload anything. Reuse the single-agent compiler.
  for (const name of folders) {
    const folder = join(root, name);
    results.push({ ...await bundleAgent(folder), folder });
  }
  return results;
}
