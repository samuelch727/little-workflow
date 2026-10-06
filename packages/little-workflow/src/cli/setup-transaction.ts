import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export type FileChange = { path: string; before: string | null; after: string };
export type SetupPlan = {
  root: string;
  files: FileChange[];
  conflicts: string[];
  warnings: string[];
};
const JOURNAL = ".little/setup-transaction.json";
export const STATE = ".little/setup.json";
export const digest = (value: string) => createHash("sha256").update(value).digest("hex");

export async function readText(root: string, path: string): Promise<string | null> {
  await assertSafePath(root, path);
  try { return await readFile(join(root, path), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

/** Refuse traversal and symlinks at every existing path component, including the root. */
export async function assertSafePath(root: string, path: string): Promise<void> {
  const target = resolve(root, path);
  const rel = relative(resolve(root), target);
  if (!path || isAbsolute(path) || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) {
    throw new Error(`Path escapes project: ${path}`);
  }
  let cursor = target;
  while (true) {
    try {
      const info = await lstat(cursor);
      if (info.isSymbolicLink()) throw new Error(`Symlink conflict: ${cursor}`);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (cursor === resolve(root)) break;
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
}

type Journal = { schema: 1; pid: number; files: FileChange[]; directories: string[] };
async function saveJournal(root: string, journal: Journal): Promise<void> {
  const temp = join(root, `${JOURNAL}.tmp`);
  await writeFile(temp, JSON.stringify(journal, null, 2), { mode: 0o600 });
  await rename(temp, join(root, JOURNAL));
}
async function ensureParents(root: string, path: string, journal: Journal): Promise<void> {
  const parent = dirname(path);
  if (parent === ".") return;
  const components = parent.split(sep);
  let current = "";
  for (const part of components) {
    current = join(current, part);
    try { await mkdir(join(root, current)); journal.directories.push(current); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
}

/** Atomic per-file writes with a durable undo journal; restores only bytes this operation wrote. */
export async function applySetupPlan(
  plan: SetupPlan,
  options: { afterWrite?: (index: number) => Promise<void>; complete?: () => Promise<void> } = {},
): Promise<void> {
  if (plan.conflicts.length) throw new Error(`Resolve conflicts before applying:\n${plan.conflicts.join("\n")}`);
  if (!plan.files.length) { await options.complete?.(); return; }
  await assertSafePath(plan.root, JOURNAL);
  for (const file of plan.files) {
    if (await readText(plan.root, file.path) !== file.before) throw new Error(`Changed since preview: ${file.path}`);
  }
  await mkdir(plan.root, { recursive: true });
  await mkdir(join(plan.root, ".little"), { recursive: true });
  const journal: Journal = { schema: 1, pid: process.pid, files: [], directories: [] };
  // Exclusive creation also excludes two installers. Never replace an interrupted transaction.
  await writeFile(join(plan.root, JOURNAL), JSON.stringify(journal), { flag: "wx", mode: 0o600 });
  try {
    for (const [index, file] of plan.files.entries()) {
      await assertSafePath(plan.root, file.path);
      await ensureParents(plan.root, file.path, journal);
      journal.files.push(file);
      await saveJournal(plan.root, journal);
      if (await readText(plan.root, file.path) !== file.before) throw new Error(`Concurrent edit: ${file.path}`);
      const temp = `${file.path}.little-${process.pid}.tmp`;
      await assertSafePath(plan.root, temp);
      await writeFile(join(plan.root, temp), file.after, { flag: "wx" });
      await rename(join(plan.root, temp), join(plan.root, file.path));
      await options.afterWrite?.(index);
    }
    await options.complete?.();
    await unlink(join(plan.root, JOURNAL));
  } catch (error) {
    const retained = await rollbackSetup(plan.root, true);
    if (retained.length) throw new Error(`${String(error)}\nRollback preserved concurrent edits: ${retained.join(", ")}. See ${JOURNAL}.`);
    throw error;
  }
}

export async function rollbackSetup(root: string, ownProcess = false): Promise<string[]> {
  const source = await readText(root, JOURNAL);
  if (source === null) return [];
  const journal = JSON.parse(source) as Journal;
  if (journal.schema !== 1 || !Array.isArray(journal.files) || !Array.isArray(journal.directories)) {
    throw new Error(`Invalid ${JOURNAL}; recover manually.`);
  }
  if (!ownProcess) {
    let alive = false;
    try { process.kill(journal.pid, 0); alive = true; } catch { /* process exited */ }
    if (alive) throw new Error(`Setup process ${journal.pid} is still running; stop it before rollback.`);
  }
  const retained: string[] = [];
  for (const file of [...journal.files].reverse()) {
    if (typeof file.path !== "string" || typeof file.after !== "string" || (file.before !== null && typeof file.before !== "string")) {
      throw new Error(`Invalid ${JOURNAL}; recover manually.`);
    }
    const current = await readText(root, file.path);
    if (current === file.before) continue;
    if (current !== file.after) { retained.push(file.path); continue; }
    if (file.before === null) await unlink(join(root, file.path));
    else await writeFile(join(root, file.path), file.before);
  }
  for (const dir of [...journal.directories].reverse()) {
    await assertSafePath(root, join(dir, "__check__"));
    try { await rmdir(join(root, dir)); } catch { /* keep nonempty user directories */ }
  }
  if (!retained.length) await unlink(join(root, JOURNAL));
  return retained;
}
