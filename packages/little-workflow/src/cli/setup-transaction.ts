import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, readFile, rename, rmdir, unlink, writeFile } from "node:fs/promises";
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

type Journal = {
  schema: 1 | 2;
  pid: number;
  files: FileChange[];
  directories: string[];
  /** Optional so journals from the first alpha setup release remain readable. */
  temporaryFiles?: { path: string; after: string }[];
  /** The initial journal owns this unique path before any atomic journal update. */
  journalTemporaryFile?: string;
  /** Keep generated links until completion so recovery can prove ownership. */
  linkedWrites?: boolean;
  captures?: { path: string; target: string; expected: string; role: "preimage" | "rollback" }[];
  /** Completion is saved before removing recovery links. */
  committed?: boolean;
};
function validJournal(journal: Journal): boolean {
  return (journal.schema === 1 || journal.schema === 2) && Number.isInteger(journal.pid) && Array.isArray(journal.files) &&
    Array.isArray(journal.directories) && journal.directories.every(dir => typeof dir === "string") &&
    journal.files.every(file => typeof file.path === "string" && typeof file.after === "string" &&
      (file.before === null || typeof file.before === "string")) &&
    (journal.temporaryFiles === undefined || (Array.isArray(journal.temporaryFiles) &&
      journal.temporaryFiles.every(file => typeof file.path === "string" && typeof file.after === "string"))) &&
    (journal.captures === undefined || (Array.isArray(journal.captures) && journal.captures.every(c =>
      typeof c.path === "string" && typeof c.target === "string" && typeof c.expected === "string" &&
      (c.role === "preimage" || c.role === "rollback")))) &&
    (journal.linkedWrites === undefined || typeof journal.linkedWrites === "boolean") &&
    (journal.committed === undefined || typeof journal.committed === "boolean");
}
async function saveJournal(root: string, journal: Journal): Promise<void> {
  // Older CLIs reject v2 instead of ignoring capture/ownership metadata and
  // applying their byte-only rollback to a newer interrupted transaction.
  journal.schema = 2;
  const path = journal.journalTemporaryFile ?? `${JOURNAL}.tmp`;
  await assertSafePath(root, path);
  await writeFile(join(root, path), JSON.stringify(journal, null, 2), { flag: "wx", mode: 0o600 });
  await rename(join(root, path), join(root, JOURNAL));
}
async function captureDestination(root: string, target: string, expected: string, role: "preimage" | "rollback", journal: Journal): Promise<string> {
  const path = `${target}.little-${randomUUID()}.capture`;
  await assertSafePath(root, path);
  if (await readText(root, path) !== null) throw new Error(`Recovery file conflict: ${path}`);
  (journal.captures ??= []).push({ path, target, expected, role });
  await saveJournal(root, journal);
  await rename(join(root, target), join(root, path));
  return path;
}
async function sameFile(root: string, first: string, second: string): Promise<boolean> {
  try {
    const [a, b] = await Promise.all([lstat(join(root, first)), lstat(join(root, second))]);
    return a.isFile() && b.isFile() && a.dev === b.dev && a.ino === b.ino;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
async function placeWithoutReplacement(root: string, source: string, target: string): Promise<boolean> {
  await assertSafePath(root, source);
  await assertSafePath(root, target);
  try { await link(join(root, source), join(root, target)); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return false; throw error; }
}
async function cleanupRecoveryFiles(root: string, journal: Journal): Promise<string[]> {
  const retained: string[] = [];
  const removable: string[] = [];
  for (const file of [...(journal.temporaryFiles ?? []), ...(journal.captures ?? []).map(c => ({ path: c.path, after: c.expected }))]) {
    if (typeof file.path !== "string" || typeof file.after !== "string") throw new Error(`Invalid ${JOURNAL}; recover manually.`);
    const current = await readText(root, file.path);
    if (current === null) continue;
    if (current !== file.after) retained.push(file.path);
    else removable.push(file.path);
  }
  // Keep all ownership evidence if any recovery file needs manual attention.
  if (!retained.length) for (const path of removable) await unlink(join(root, path));
  return retained;
}
async function ensureParents(root: string, path: string, journal: Journal, afterDirectory?: (path: string) => Promise<void>): Promise<void> {
  const parent = dirname(path);
  if (parent === ".") return;
  const components = parent.split(sep);
  let current = "";
  for (const part of components) {
    current = join(current, part);
    try { await lstat(join(root, current)); continue; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    journal.directories.push(current);
    // Save ownership intent before mkdir: recovery must also cover a process
    // killed before the next file's intent is written.
    await saveJournal(root, journal);
    try { await mkdir(join(root, current)); }
    catch (error) {
      journal.directories.pop();
      await saveJournal(root, journal);
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      continue;
    }
    await afterDirectory?.(current);
  }
}

/** Options for {@link applySetupPlan}. */
export type ApplySetupOptions = {
  /** Runs after every file is placed and before the transaction commits, for example an install. A throw rolls the files back. */
  complete?: () => Promise<void>;
};

/**
 * Interruption points the transaction tests use to simulate a crash or a concurrent edit. Not part
 * of the public scaffold API: `@little-stack/workflow/scaffold` exports only the hook-free calls.
 */
export type SetupTransactionHooks = {
  afterWrite?: (index: number) => Promise<void>;
  afterDirectory?: (path: string) => Promise<void>;
  beforeReplace?: (index: number) => Promise<void>;
  afterCapture?: (path: string) => Promise<void>;
};

/** Journaled captures and atomic no-replacement placement; preserves concurrent edits. */
export async function applySetupPlan(plan: SetupPlan, options: ApplySetupOptions = {}): Promise<void> {
  return applySetupPlanWithHooks(plan, options);
}

/** INTERNAL. {@link applySetupPlan} with test interruption hooks. */
export async function applySetupPlanWithHooks(
  plan: SetupPlan,
  options: ApplySetupOptions & SetupTransactionHooks = {},
): Promise<void> {
  if (plan.conflicts.length) throw new Error(`Resolve conflicts before applying:\n${plan.conflicts.join("\n")}`);
  if (!plan.files.length) { await options.complete?.(); return; }
  await assertSafePath(plan.root, JOURNAL);
  for (const file of plan.files) {
    if (await readText(plan.root, file.path) !== file.before) throw new Error(`Changed since preview: ${file.path}`);
  }
  await mkdir(plan.root, { recursive: true });
  const directories: string[] = [];
  try { await mkdir(join(plan.root, ".little")); directories.push(".little"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const journal: Journal = {
    schema: 2, pid: process.pid, files: [], directories, temporaryFiles: [],
    journalTemporaryFile: `${JOURNAL}.${randomUUID()}.tmp`,
    linkedWrites: true, captures: [],
  };
  // Exclusive creation also excludes two installers. Never replace an interrupted transaction.
  await writeFile(join(plan.root, JOURNAL), JSON.stringify(journal), { flag: "wx", mode: 0o600 });
  try {
    for (const [index, file] of plan.files.entries()) {
      await assertSafePath(plan.root, file.path);
      await ensureParents(plan.root, file.path, journal, options.afterDirectory);
      journal.files.push(file);
      await saveJournal(plan.root, journal);
      if (await readText(plan.root, file.path) !== file.before) throw new Error(`Concurrent edit: ${file.path}`);
      const temp = `${file.path}.little-${process.pid}.tmp`;
      await assertSafePath(plan.root, temp);
      if (await readText(plan.root, temp) !== null) throw new Error(`Temporary file conflict: ${temp}`);
      journal.temporaryFiles!.push({ path: temp, after: file.after });
      // Persist the temporary path before creating it so a killed process can
      // recover the write even when the destination still matches its preimage.
      await saveJournal(plan.root, journal);
      try { await writeFile(join(plan.root, temp), file.after, { flag: "wx" }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          // A concurrent creator owns this file; rollback must preserve it.
          journal.temporaryFiles!.pop();
          await saveJournal(plan.root, journal);
        }
        throw error;
      }
      await options.beforeReplace?.(index);
      if (file.before !== null) {
        // Capture the actual destination first: checking a path before an
        // overwriting rename cannot protect an edit made in between.
        const captured = await captureDestination(plan.root, file.path, file.before, "preimage", journal);
        if (await readText(plan.root, captured) !== file.before) throw new Error(`Concurrent edit: ${file.path}`);
      }
      // A creator/edit replacing the path during capture is never overwritten.
      if (!await placeWithoutReplacement(plan.root, temp, file.path)) throw new Error(`Concurrent edit: ${file.path}`);
      await options.afterWrite?.(index);
    }
    await options.complete?.();
    // A killed cleanup must finish the committed operation, without mistaking
    // a removed ownership link for an independently replaced destination.
    journal.committed = true;
    await saveJournal(plan.root, journal);
    const retained = await cleanupRecoveryFiles(plan.root, journal);
    if (retained.length) throw new Error(`Concurrent edits to recovery files: ${retained.join(", ")}`);
    await unlink(join(plan.root, JOURNAL));
  } catch (error) {
    const retained = await rollbackSetup(plan.root, true);
    if (retained.length) throw new Error(`${String(error)}\nRollback preserved concurrent edits: ${retained.join(", ")}. See ${JOURNAL}.`);
    throw error;
  }
}

export type SetupRecoveryResult = {
  status: "nothing-to-recover" | "rolled-back" | "completed-cleanup" | "manual-recovery-required";
  retained: string[];
};

/** Options for {@link recoverSetup}. */
export type RecoverSetupOptions = {
  /** Recover a journal this same process wrote (a failed apply rolling itself back). */
  allowOwnProcess?: boolean;
};

/** Recover only this transaction's owned files; committed journals only finish cleanup. */
export async function recoverSetup(root: string, options: RecoverSetupOptions = {}): Promise<SetupRecoveryResult> {
  return recoverSetupWithHooks(root, options);
}

/** INTERNAL. {@link recoverSetup} with the test interruption hook. */
export async function recoverSetupWithHooks(
  root: string,
  options: RecoverSetupOptions & Pick<SetupTransactionHooks, "afterCapture"> = {},
): Promise<SetupRecoveryResult> {
  const source = await readText(root, JOURNAL);
  if (source === null) return { status: "nothing-to-recover", retained: [] };
  let journal = JSON.parse(source) as Journal;
  if (!validJournal(journal)) {
    throw new Error(`Invalid ${JOURNAL}; recover manually.`);
  }
  if (!options.allowOwnProcess) {
    let alive = false;
    try { process.kill(journal.pid, 0); alive = true; } catch { /* process exited */ }
    if (alive) throw new Error(`Setup process ${journal.pid} is still running; stop it before rollback.`);
  }
  const retained: string[] = [];
  {
    // First-alpha journals used a fixed temporary path; retain their recovery.
    const path = journal.journalTemporaryFile ?? `${JOURNAL}.tmp`;
    if (typeof path !== "string" || (journal.journalTemporaryFile !== undefined &&
        !/^\.little\/setup-transaction\.json\.[0-9a-f-]{36}\.tmp$/.test(path))) {
      throw new Error(`Invalid ${JOURNAL}; recover manually.`);
    }
    const current = await readText(root, path);
    if (current !== null) {
      // Recover a complete update belonging to this transaction. Unrecognized
      // or partial snapshots stay with the journal for explicit manual recovery.
      let snapshot: Journal | undefined;
      try { snapshot = JSON.parse(current) as Journal; } catch { /* interrupted or edited write */ }
      if (snapshot && validJournal(snapshot) && snapshot.pid === journal.pid &&
          snapshot.journalTemporaryFile === journal.journalTemporaryFile &&
          current === JSON.stringify(snapshot, null, 2)) {
        // Complete snapshots may revoke ownership after an EEXIST collision.
        // Promote the update before rollback instead of acting on stale intent.
        await rename(join(root, path), join(root, JOURNAL));
        journal = snapshot;
      } else return { status: "manual-recovery-required", retained: [path] }; // Unknown ownership updates require manual recovery.
    }
  }
  for (const file of journal.committed ? [] : [...journal.files].reverse()) {
    if (typeof file.path !== "string" || typeof file.after !== "string" || (file.before !== null && typeof file.before !== "string")) {
      throw new Error(`Invalid ${JOURNAL}; recover manually.`);
    }
    const preimage = journal.captures?.find(c => c.target === file.path && c.role === "preimage");
    const generated = `${file.path}.little-${journal.pid}.tmp`;
    let current = await readText(root, file.path);
    if (current === null) {
      // A killed rollback may have captured an independently replaced file
      // before verifying its ownership. Preserve that actual destination.
      for (const capture of [...(journal.captures ?? [])].reverse()) {
        if (capture.target !== file.path || capture.role !== "rollback") continue;
        const bytes = await readText(root, capture.path);
        if (bytes === null) continue;
        if (bytes !== file.after || (journal.linkedWrites && !await sameFile(root, generated, capture.path))) {
          if (!await placeWithoutReplacement(root, capture.path, file.path)) retained.push(capture.path);
          retained.push(file.path);
          current = await readText(root, file.path);
        }
        break;
      }
      if (current !== null) continue;
    }
    // Resume a process killed after capturing the destination. A link places
    // the complete bytes atomically and refuses a concurrent destination.
    if (current === null && preimage && await readText(root, preimage.path) !== null) {
      if (!await placeWithoutReplacement(root, preimage.path, file.path)) { retained.push(file.path, preimage.path); continue; }
      current = await readText(root, file.path);
    }
    if (current === null && file.before !== null && journal.captures?.some(c => c.target === file.path && c.role === "rollback")) {
      const temp = `${file.path}.little-${randomUUID()}.rollback`;
      await assertSafePath(root, temp);
      (journal.temporaryFiles ??= []).push({ path: temp, after: file.before });
      await saveJournal(root, journal);
      await writeFile(join(root, temp), file.before, { flag: "wx" });
      if (!await placeWithoutReplacement(root, temp, file.path)) { retained.push(file.path, temp); continue; }
      current = await readText(root, file.path);
    }
    if (current === file.before) continue;
    if (current !== file.after) { retained.push(file.path); continue; }
    if (journal.linkedWrites && !await sameFile(root, generated, file.path)) { retained.push(file.path); continue; }
    let restoration = preimage?.path;
    if (file.before !== null && (!restoration || await readText(root, restoration) === null)) {
      restoration = `${file.path}.little-${randomUUID()}.rollback`;
      await assertSafePath(root, restoration);
      (journal.temporaryFiles ??= []).push({ path: restoration, after: file.before });
      await saveJournal(root, journal);
      await writeFile(join(root, restoration), file.before, { flag: "wx" });
    }
    const captured = await captureDestination(root, file.path, file.after, "rollback", journal);
    await options.afterCapture?.(file.path);
    if (await readText(root, captured) !== file.after || (journal.linkedWrites && !await sameFile(root, generated, captured))) {
      if (!await placeWithoutReplacement(root, captured, file.path)) retained.push(captured);
      retained.push(file.path);
      continue;
    }
    if (file.before !== null && !await placeWithoutReplacement(root, restoration!, file.path)) retained.push(file.path, restoration!);
  }
  retained.push(...await cleanupRecoveryFiles(root, journal));
  // The journal would otherwise keep a newly created .little directory nonempty.
  if (!retained.length) await unlink(join(root, JOURNAL));
  for (const dir of [...journal.directories].reverse()) {
    await assertSafePath(root, join(dir, "__check__"));
    try { await rmdir(join(root, dir)); } catch { /* keep nonempty user directories */ }
  }
  return {
    status: retained.length ? "manual-recovery-required"
      : journal.committed ? "completed-cleanup" : "rolled-back",
    retained,
  };
}

/** INTERNAL. The preserved paths of a recovery; callers outside this module use recoverSetup. */
export async function rollbackSetup(root: string, ownProcess = false, options: Pick<SetupTransactionHooks, "afterCapture"> = {}): Promise<string[]> {
  return (await recoverSetupWithHooks(root, { ...options, allowOwnProcess: ownProcess })).retained;
}
