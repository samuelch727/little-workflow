import type { IFileSystem } from "just-bash";
import { readdir, readFile, stat } from "node:fs/promises";
import * as path from "node:path";
import { sha256Hex } from "../ids.js";
import type { FileChangeSet } from "../types.js";

export type FolderSnapshot = Record<string, Uint8Array>;

export async function snapshotFolder(root: string): Promise<FolderSnapshot> {
  const snapshot: FolderSnapshot = {};
  await collect(root, "", snapshot);
  return snapshot;
}

/**
 * {@link snapshotFolder} for a folder of a just-bash filesystem: every file under `root`,
 * keyed by its path relative to `root` with "/" separators. A missing folder is empty.
 */
export async function snapshotFs(fs: IFileSystem, root: string): Promise<FolderSnapshot> {
  const snapshot: FolderSnapshot = {};
  if (!(await fs.exists(root))) {
    return snapshot;
  }
  const walk = async (dir: string, relative: string): Promise<void> => {
    for (const name of [...(await fs.readdir(dir))].sort()) {
      const full = path.posix.join(dir, name);
      const next = relative ? `${relative}/${name}` : name;
      const stat = await fs.lstat(full);
      if (stat.isDirectory) {
        await walk(full, next);
      } else if (stat.isFile) {
        snapshot[next] = await fs.readFileBuffer(full);
      }
    }
  };
  await walk(root, "");
  return snapshot;
}

export function diffSnapshots(before: FolderSnapshot, after: FolderSnapshot): FileChangeSet {
  const created: FileChangeSet["created"] = {};
  const updated: FileChangeSet["updated"] = {};
  const deleted: string[] = [];

  for (const [file, content] of Object.entries(after)) {
    if (!(file in before)) {
      created[file] = content;
      continue;
    }

    if (sha256Hex(before[file]!) !== sha256Hex(content)) {
      updated[file] = content;
    }
  }

  for (const file of Object.keys(before)) {
    if (!(file in after)) {
      deleted.push(file);
    }
  }

  return { created, updated, deleted };
}

export async function fileSize(pathname: string): Promise<number | undefined> {
  try {
    return (await stat(pathname)).size;
  } catch {
    return undefined;
  }
}

async function collect(
  root: string,
  relative: string,
  snapshot: FolderSnapshot,
): Promise<void> {
  let entries;
  try {
    entries = await readdir(path.join(root, relative), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }

  for (const entry of entries) {
    const next = relative ? path.join(relative, entry.name) : entry.name;
    if (entry.isDirectory()) {
      await collect(root, next, snapshot);
    } else if (entry.isFile()) {
      snapshot[next.split(path.sep).join("/")] = await readFile(path.join(root, next));
    }
  }
}
