import * as path from "node:path";
import { HarnessInputError, HarnessPathError } from "../errors.js";
import { diskStorage, filesystemStorage, type WorkspaceStorage } from "../files/storage.js";
import type { FileChangeSet, PersistentDir } from "../types.js";
import type { VirtualHostPaths } from "../virtual-host/paths.js";
import { resolveProjectDirSource, type LocalHostPaths } from "./paths.js";

export type ProjectDirRef = { kind: "projectDir"; path: string };

export type LocalDirSource<TExtraBody = unknown> =
  | string
  | ProjectDirRef
  | ((options: { extraBody?: TExtraBody | undefined }) => string | ProjectDirRef);

export type LocalDirOptions<TExtraBody = unknown> = {
  harnessDir: string;
  sourceDir: LocalDirSource<TExtraBody>;
  commit?: "after-turn" | "manual" | "read-only";
  /** Whether a turn may change the folder; see `PersistentDir.canWrite`. */
  canWrite?: PersistentDir<TExtraBody>["canWrite"];
};

export function projectDir(pathname: string): ProjectDirRef {
  return { kind: "projectDir", path: pathname };
}

export function customDir<TExtraBody = unknown>(
  dir: PersistentDir<TExtraBody>,
): PersistentDir<TExtraBody> {
  return dir;
}

export function localDir<TExtraBody = unknown>(
  options: LocalDirOptions<TExtraBody>,
): PersistentDir<TExtraBody> & { __localSource: LocalDirSource<TExtraBody> } {
  return {
    harnessDir: options.harnessDir,
    commit: options.commit ?? "after-turn",
    ...(options.canWrite === undefined ? {} : { canWrite: options.canWrite }),
    __localSource: options.sourceDir,
    async load(loadOptions) {
      const { root, storage } = resolveSourceStorage(
        options.sourceDir,
        requireHostPaths(loadOptions.sessionHostPaths),
        loadOptions.extraBody,
      );
      return storage.snapshot(root);
    },
    async store(storeOptions) {
      if ((options.commit ?? "after-turn") === "read-only") {
        return;
      }

      const { root, storage } = resolveSourceStorage(
        options.sourceDir,
        requireHostPaths(storeOptions.sessionHostPaths),
        storeOptions.extraBody,
      );
      await applyChanges(storage, root, storeOptions.changes);
    },
  };
}

export function resolveLocalDirSource<TExtraBody>(
  source: LocalDirSource<TExtraBody>,
  hostPaths: LocalHostPaths,
  extraBody: TExtraBody | undefined,
): string {
  const value = typeof source === "function" ? source({ extraBody }) : source;

  if (typeof value === "string") {
    if (typeof source === "function") {
      return resolveComputedSource(value, hostPaths.dataDir);
    }
    return path.resolve(hostPaths.dataDir, value);
  }

  return resolveProjectDirSource(value.path, hostPaths.projectRoot);
}

/**
 * A `sourceDir` function is usually built from request data such as a user id, so its result must
 * name a folder inside `dataDir`: an id like `../company` must not reach another folder.
 */
function resolveComputedSource(value: string, dataDir: string): string {
  if (path.isAbsolute(value) || value.includes("\0") || value.split(/[\\/]/).includes("..")) {
    throw new HarnessPathError(
      "A sourceDir function must return a relative path without .. segments",
      { sourceDir: value },
    );
  }

  const target = path.resolve(dataDir, value);
  const rel = path.relative(path.resolve(dataDir), target);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new HarnessPathError("A sourceDir function result must resolve to a folder inside dataDir", {
      sourceDir: value,
      dataDir,
    });
  }
  return target;
}

function requireHostPaths(value: unknown): LocalHostPaths | VirtualHostPaths {
  if (value && typeof value === "object" && "kind" in value && value.kind === "virtual" &&
    "dataFs" in value && "dataRoot" in value) {
    return value as VirtualHostPaths;
  }
  if (!value || typeof value !== "object" || !("dataDir" in value) || !("projectRoot" in value)) {
    throw new HarnessInputError("localDir() and projectDir() need localHost: they keep the dir in a folder on disk. On virtualHost, give the Persistent Dir its own load and store.");
  }
  return value as LocalHostPaths;
}

function resolveSourceStorage<TExtraBody>(
  source: LocalDirSource<TExtraBody>,
  hostPaths: LocalHostPaths | VirtualHostPaths,
  extraBody: TExtraBody | undefined,
): { root: string; storage: WorkspaceStorage } {
  if ("dataDir" in hostPaths) {
    return { root: resolveLocalDirSource(source, hostPaths, extraBody), storage: diskStorage() };
  }
  const value = typeof source === "function" ? source({ extraBody }) : source;
  if (typeof value !== "string") {
    throw new HarnessInputError("projectDir() needs localHost(): virtualHost() has no project folder on disk.");
  }
  if (path.posix.isAbsolute(value) || value.includes("\0") || value.includes("\\") ||
    value.split("/").includes("..")) {
    throw new HarnessPathError("On virtualHost(), sourceDir must be a relative POSIX path without .. segments", {
      sourceDir: value,
    });
  }
  const root = path.posix.resolve(hostPaths.dataRoot, value);
  const relative = path.posix.relative(hostPaths.dataRoot, root);
  if (relative === "" || relative === ".." || relative.startsWith("../") || path.posix.isAbsolute(relative)) {
    throw new HarnessPathError("sourceDir must resolve to a folder inside dataRoot", { sourceDir: value });
  }
  return { root, storage: filesystemStorage(hostPaths.dataFs) };
}

async function applyChanges(storage: WorkspaceStorage, root: string, changes: FileChangeSet): Promise<void> {
  await storage.makeDir(root);

  for (const [file, content] of Object.entries({ ...changes.created, ...changes.updated })) {
    await storage.writeFile(resolveStorageFilePath(storage.path, root, file), content);
  }

  for (const file of changes.deleted) {
    await storage.removeFile(resolveStorageFilePath(storage.path, root, file));
  }
}

function resolveStorageFilePath(path: WorkspaceStorage["path"], root: string, file: string): string {
  if (file.startsWith("/") || file.includes("\0") || file.split(/[\\/]/).includes("..")) {
    throw new HarnessPathError("Persistent Dir file paths must be relative", { path: file });
  }

  const target = path.resolve(root, file);
  const rel = path.relative(path.resolve(root), target);
  if (rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"))) {
    return target;
  }

  throw new HarnessPathError("Persistent Dir file path resolves outside sourceDir", { path: file });
}
