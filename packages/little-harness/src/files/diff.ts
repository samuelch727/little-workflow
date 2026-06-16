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
