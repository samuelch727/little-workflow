import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { LocalWorld } from "./authoring.js";
import { canonicalJson } from "./canonical.js";
import type { WorkflowVersion } from "./lwir.js";
import { WorldPathError } from "./world.js";

const WORKFLOW_VERSION_ID_PATTERN = /^wfver_[A-Za-z0-9_-]{1,80}$/u;
const writeChains = new Map<string, Promise<unknown>>();

export type StoredWorkflowVersion = WorkflowVersion & {
  readonly lwirVersionId?: string;
  readonly lwirHash?: string;
  readonly lock?: {
    readonly planningDefinitionSnapshotHash?: string;
    readonly [key: string]: unknown;
  };
  readonly [key: string]: unknown;
};

export class WorkflowVersionStoreConflictError extends Error {
  constructor(workflowVersionId: string) {
    super(`Stored WorkflowVersion conflict for id: ${workflowVersionId}`);
    this.name = "WorkflowVersionStoreConflictError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export async function registerStoredWorkflowVersion(
  world: LocalWorld,
  workflowVersion: StoredWorkflowVersion,
): Promise<void> {
  validateWorkflowVersionId(workflowVersion.id);
  const directory = join(world.dataDir, "workflow-versions");
  const path = workflowVersionPath(world, workflowVersion.id);
  const contents = `${canonicalJson(workflowVersion)}\n`;
  await withWriteChain(resolve(path), async () => {
    await ensureDirectory(directory);
    const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFileDurably(tempPath, contents);
    try {
      await link(tempPath, path);
      await syncDirectory(directory);
    } catch (error) {
      if (!isErrno(error, "EEXIST")) {
        throw error;
      }
      const existing = await readIfPresent(path);
      if (existing === contents) {
        return;
      }
      throw new WorkflowVersionStoreConflictError(workflowVersion.id);
    } finally {
      await unlinkIfPresent(tempPath);
      await syncDirectory(directory);
    }
  });
}

export async function readStoredWorkflowVersion(
  world: LocalWorld,
  workflowVersionId: string,
): Promise<StoredWorkflowVersion> {
  validateWorkflowVersionId(workflowVersionId);
  return JSON.parse(await readFile(workflowVersionPath(world, workflowVersionId), "utf8")) as StoredWorkflowVersion;
}

function workflowVersionPath(world: LocalWorld, workflowVersionId: string): string {
  validateWorkflowVersionId(workflowVersionId);
  return join(world.dataDir, "workflow-versions", `${workflowVersionId}.json`);
}

function validateWorkflowVersionId(workflowVersionId: string): void {
  if (!WORKFLOW_VERSION_ID_PATTERN.test(workflowVersionId)) {
    throw new WorldPathError(`Invalid workflow version id: ${workflowVersionId}`);
  }
}

async function readIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

async function writeFileDurably(path: string, data: string): Promise<void> {
  const handle = await open(path, "w");
  try {
    await handle.writeFile(data, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function unlinkIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!isErrno(error, "ENOENT")) {
      throw error;
    }
  }
}

async function ensureDirectory(path: string): Promise<void> {
  const missingDirectories = await findMissingDirectories(path);
  await mkdir(path, { recursive: true });
  await syncDirectory(path);
  await syncDirectory(dirname(path));
  await Promise.all(
    missingDirectories.map((directory) => syncDirectory(dirname(directory))),
  );
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function findMissingDirectories(path: string): Promise<readonly string[]> {
  const missingDirectories: string[] = [];
  for (const directory of directoryChain(path)) {
    try {
      const entry = await stat(directory);
      if (!entry.isDirectory()) {
        throw new WorldPathError(`Expected directory path, received file path: ${directory}`);
      }
    } catch (error) {
      if (!isErrno(error, "ENOENT")) {
        throw error;
      }
      missingDirectories.push(directory);
    }
  }
  return missingDirectories;
}

function directoryChain(path: string): readonly string[] {
  const directories: string[] = [];
  let current = resolve(path);
  while (true) {
    directories.unshift(current);
    const parent = dirname(current);
    if (parent === current) {
      return directories;
    }
    current = parent;
  }
}

function withWriteChain<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = writeChains.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(fn);
  writeChains.set(key, next);
  return next.finally(() => {
    if (writeChains.get(key) === next) {
      writeChains.delete(key);
    }
  });
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
