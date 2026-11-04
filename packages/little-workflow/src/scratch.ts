import * as nodePath from "node:path";
import { runFilesFor } from "./run-files.js";
import type { World } from "./world-port.js";
import type { HarnessScope } from "./harness/types.js";

export type ScratchMount = {
  readonly mountPath: string;
  readonly backingPath: string;
  readonly mode: "rw" | "ro";
};

export function scratchMountsForScope(
  scope: HarnessScope,
  world: Pick<World, "dataDir" | "files"> = { dataDir: "/" },
): readonly ScratchMount[] {
  const path = runFilesFor(world).path;
  if (scope.role === "orchestrator" || scope.role === "planner") {
    return plannerOrOrchestratorScratchMounts(scope, path);
  }
  return workerScratchMounts(scope, path);
}

export async function ensureScratchMounts(
  mounts: readonly ScratchMount[],
  world: Pick<World, "dataDir" | "files"> = { dataDir: "/" },
): Promise<void> {
  await Promise.all(
    mounts
      .filter((mount) => !isPatternPath(mount.backingPath))
      .map((mount) => runFilesFor(world).mkdir(mount.backingPath, { recursive: true })),
  );
}

function plannerOrOrchestratorScratchMounts(scope: HarnessScope, path: typeof nodePath.posix): readonly ScratchMount[] {
  const mounts: ScratchMount[] = [
    {
      mountPath: "/mnt/scratch/own/",
      backingPath: ownRunScratchPath(scope, path),
      mode: "rw",
    },
  ];
  if (scope.role === "planner" && scope.parentRunId !== undefined) {
    mounts.push({
      mountPath: "/mnt/scratch/from-orchestrator/",
      backingPath: path.join(parentRunLogDir(scope, path), "scratch"),
      mode: "ro",
    });
  }
  return mounts;
}

function workerScratchMounts(scope: HarnessScope, path: typeof nodePath.posix): readonly ScratchMount[] {
  const stepPath = stepPathForScope(scope);
  const mounts: ScratchMount[] = [
    {
      mountPath: "/mnt/scratch/own/",
      backingPath: path.join(scope.logDir, "steps", stepPath, "scratch"),
      mode: "rw",
    },
    {
      mountPath: "/mnt/scratch/from-planner/",
      backingPath: ownRunScratchPath(scope, path),
      mode: "ro",
    },
  ];
  if (scope.parentRunId !== undefined) {
    mounts.push({
      mountPath: "/mnt/scratch/from-orchestrator/",
      backingPath: path.join(parentRunLogDir(scope, path), "scratch"),
      mode: "ro",
    });
  }
  mounts.push({
    mountPath: "/mnt/scratch/peer-steps/",
    backingPath: path.join(scope.logDir, "steps", "*", "scratch"),
    mode: "ro",
  });
  return mounts;
}

function ownRunScratchPath(scope: HarnessScope, path: typeof nodePath.posix): string {
  return path.join(scope.logDir, "scratch");
}

function parentRunLogDir(scope: HarnessScope, path: typeof nodePath.posix): string {
  return path.dirname(path.dirname(scope.logDir));
}

function stepPathForScope(scope: HarnessScope): string {
  if (scope.stepPath === undefined || scope.stepPath.length === 0) {
    throw new TypeError(`Harness scope for role '${scope.role}' requires stepPath.`);
  }
  return encodeURIComponent(scope.stepPath).replace(/\*/gu, "%2A");
}

function isPatternPath(path: string): boolean {
  return path.split(/[\\/]/u).includes("*");
}
