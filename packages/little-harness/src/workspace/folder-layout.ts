/** Shared Node-side folder discovery. Compilation adds explicit filesystem safety checks. */
import { lstat, readdir, readFile, stat } from "node:fs/promises";
import { join, parse, relative, sep } from "node:path";
export const SOURCE_EXTENSIONS = new Set([".ts", ".js", ".mts", ".mjs", ".cts", ".cjs"]);
export const SKILL_MODULE_NAMES = ["skill.ts", "skill.mts", "skill.js", "skill.mjs"];
export const compareNames = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
export type DiscoveryOptions = { strict?: boolean };
export async function regularFile(file: string): Promise<void> {
  if (!(await lstat(file)).isFile()) throw new Error(`Expected a regular file (no symlinks): ${file}`);
}
export async function fileExists(file: string, options: DiscoveryOptions = {}): Promise<boolean> {
  try { if (options.strict) await regularFile(file); else await stat(file); return true; }
  catch (error) {
    if (!options.strict || (error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
export async function directoryEntries(dir: string, options: DiscoveryOptions = {}) {
  try {
    if (options.strict) {
      const info = await lstat(dir);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Expected a real directory: ${dir}`);
    }
    return (await readdir(dir, { withFileTypes: true })).sort((a, b) => compareNames(a.name, b.name));
  } catch (error) {
    if (!options.strict || (error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
export async function sourceFiles(dir: string, options: DiscoveryOptions = {}): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await directoryEntries(dir, options)) {
    const { name, ext } = parse(entry.name);
    if (!SOURCE_EXTENSIONS.has(ext) || name.endsWith(".test") || name.endsWith(".spec")) continue;
    const file = join(dir, entry.name);
    if (options.strict) await regularFile(file);
    files.push(file);
  }
  return files;
}
export async function skillPaths(agentDir: string, options: DiscoveryOptions = {}) {
  const skills: { dir: string; module?: string }[] = [];
  const parent = join(agentDir, "skills");
  for (const entry of await directoryEntries(parent, options)) {
    const dir = join(parent, entry.name);
    if (options.strict && entry.isSymbolicLink()) throw new Error(`Cannot bundle symlink: ${dir}`);
    if (!entry.isDirectory()) continue;
    let module: string | undefined;
    for (const name of SKILL_MODULE_NAMES) {
      const file = join(dir, name);
      if (await fileExists(file, options)) { module = file; break; }
    }
    if (module !== undefined) skills.push({ dir, module });
    else if (await fileExists(join(dir, "SKILL.md"), options)) skills.push({ dir });
  }
  return skills;
}
/** Node skips tree symlinks as before; compilation rejects them and bounds all copied bytes. */
export async function readSkillTree(root: string, options: { strict?: boolean; maxBytes?: number } = {}): Promise<Record<string, Uint8Array>> {
  const files: Record<string, Uint8Array> = Object.create(null);
  let bytes = 0;
  async function walk(dir: string) {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => compareNames(a.name, b.name))) {
      const file = join(dir, entry.name);
      if (options.strict && entry.isSymbolicLink()) throw new Error(`Cannot bundle symlink: ${file}`);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile()) {
        if (options.maxBytes !== undefined && bytes + (await lstat(file)).size > options.maxBytes) throw new Error(`Skill exceeds maxSkillBytes (${options.maxBytes}): ${root}`);
        const content = await readFile(file); bytes += content.length;
        if (options.maxBytes !== undefined && bytes > options.maxBytes) throw new Error(`Skill exceeds maxSkillBytes (${options.maxBytes}): ${root}`);
        files[relative(root, file).split(sep).join("/")] = content;
      } else if (options.strict) throw new Error(`Cannot bundle special file: ${file}`);
    }
  }
  await walk(root); return files;
}
