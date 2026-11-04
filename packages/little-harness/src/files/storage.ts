import type { IFileSystem } from "just-bash";
import { mkdir, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { snapshotFolder, snapshotFs, type FolderSnapshot } from "./diff.js";
import type { ResolvedHarnessPath } from "./path-policy.js";

/**
 * The few file operations a host's turn helpers (skill staging, Persistent Dir checkouts)
 * need, over the disk (`localHost`) or over a just-bash filesystem (`virtualHost`).
 */
export type WorkspaceStorage = {
  readonly kind: "disk" | "filesystem";
  /** Path rules for this storage: the platform's for disk, POSIX for a just-bash filesystem. */
  readonly path: typeof path.posix;
  /** Where a harness path lives in this storage. */
  locate(resolved: ResolvedHarnessPath): string;
  /** Delete a file or folder and everything in it; a missing one is fine. */
  removeTree(target: string): Promise<void>;
  /** Delete one file; unlike removeTree, refuses a directory. */
  removeFile(target: string): Promise<void>;
  makeDir(target: string): Promise<void>;
  /** Write a file, making its parent folders first. */
  writeFile(target: string, content: Uint8Array): Promise<void>;
  snapshot(root: string): Promise<FolderSnapshot>;
};

export function diskStorage(): WorkspaceStorage {
  return {
    kind: "disk",
    path,
    locate: (resolved) => resolved.realPath,
    removeTree: (target) => rm(target, { recursive: true, force: true }),
    removeFile: (target) => rm(target, { force: true }),
    makeDir: async (target) => {
      await mkdir(target, { recursive: true });
    },
    async writeFile(target, content) {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content);
    },
    snapshot: snapshotFolder,
  };
}

export function filesystemStorage(fs: IFileSystem): WorkspaceStorage {
  return {
    kind: "filesystem",
    path: path.posix,
    // The filesystem's root is the workspace root, so a harness path is its own location.
    locate: (resolved) => resolved.harnessPath,
    removeTree: (target) => fs.rm(target, { recursive: true, force: true }),
    removeFile: (target) => fs.rm(target, { force: true }),
    makeDir: (target) => fs.mkdir(target, { recursive: true }),
    async writeFile(target, content) {
      await fs.mkdir(path.posix.dirname(target), { recursive: true });
      await fs.writeFile(target, content);
    },
    snapshot: (root) => snapshotFs(fs, root),
  };
}
