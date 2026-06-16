import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { HarnessPathError } from "../errors.js";
import type { FileChangeSet, FileContent, PersistentDir } from "../types.js";
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
    __localSource: options.sourceDir,
    async load(loadOptions) {
      const root = resolveLocalDirSource(
        options.sourceDir,
        requireHostPaths(loadOptions.sessionHostPaths),
        loadOptions.extraBody,
      );
      return readFolder(root);
    },
    async store(storeOptions) {
      if ((options.commit ?? "after-turn") === "read-only") {
        return;
      }

      const root = resolveLocalDirSource(
        options.sourceDir,
        requireHostPaths(storeOptions.sessionHostPaths),
        storeOptions.extraBody,
      );
      await applyChanges(root, storeOptions.changes);
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
    return path.resolve(hostPaths.dataDir, value);
  }

  return resolveProjectDirSource(value.path, hostPaths.projectRoot);
}

function requireHostPaths(value: unknown): LocalHostPaths {
  if (!value || typeof value !== "object" || !("dataDir" in value) || !("projectRoot" in value)) {
    throw new Error("localDir requires Local Host path context");
  }
  return value as LocalHostPaths;
}

async function readFolder(root: string): Promise<Record<string, FileContent>> {
  const files: Record<string, FileContent> = {};
  await collect(root, "", files);
  return files;
}

async function collect(
  root: string,
  relative: string,
  out: Record<string, FileContent>,
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
      await collect(root, next, out);
    } else if (entry.isFile()) {
      out[next.split(path.sep).join("/")] = await readFile(path.join(root, next));
    }
  }
}

async function applyChanges(root: string, changes: FileChangeSet): Promise<void> {
  await mkdir(root, { recursive: true });

  for (const [file, content] of Object.entries({ ...changes.created, ...changes.updated })) {
    const target = resolveStorageFilePath(root, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }

  for (const file of changes.deleted) {
    await rm(resolveStorageFilePath(root, file), { force: true });
  }
}

function resolveStorageFilePath(root: string, file: string): string {
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
