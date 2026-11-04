import { randomUUID } from "node:crypto";
import type { LocalWorld } from "./authoring.js";
import { canonicalJson } from "./canonical.js";
import { runFilesFor, type RunFiles } from "./run-files.js";
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
  const files = runFilesFor(world);
  const directory = files.path.join(world.dataDir, "workflow-versions");
  const path = workflowVersionPath(world, workflowVersion.id);
  const contents = `${canonicalJson(workflowVersion)}\n`;
  await withWriteChain(files.storageKey(files.path.resolve(path)), async () => {
    await files.ensureDirectory(directory);
    const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await files.writeFileDurably(tempPath, contents);
    try {
      await files.link(tempPath, path);
      await files.syncDirectory(directory);
    } catch (error) {
      if (!isErrno(error, "EEXIST")) {
        throw error;
      }
      const existing = await readIfPresent(files, path);
      if (existing === contents) {
        return;
      }
      throw new WorkflowVersionStoreConflictError(workflowVersion.id);
    } finally {
      await unlinkIfPresent(files, tempPath);
      await files.syncDirectory(directory);
    }
  });
}

export async function readStoredWorkflowVersion(
  world: LocalWorld,
  workflowVersionId: string,
): Promise<StoredWorkflowVersion> {
  validateWorkflowVersionId(workflowVersionId);
  return JSON.parse(await runFilesFor(world).readFile(workflowVersionPath(world, workflowVersionId), "utf8")) as StoredWorkflowVersion;
}

function workflowVersionPath(world: LocalWorld, workflowVersionId: string): string {
  validateWorkflowVersionId(workflowVersionId);
  return runFilesFor(world).path.join(world.dataDir, "workflow-versions", `${workflowVersionId}.json`);
}

function validateWorkflowVersionId(workflowVersionId: string): void {
  if (!WORKFLOW_VERSION_ID_PATTERN.test(workflowVersionId)) {
    throw new WorldPathError(`Invalid workflow version id: ${workflowVersionId}`);
  }
}

async function readIfPresent(files: RunFiles, path: string): Promise<string | undefined> {
  try {
    return await files.readFile(path, "utf8");
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    throw error;
  }
}

async function unlinkIfPresent(files: RunFiles, path: string): Promise<void> {
  try {
    await files.unlink(path);
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
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
