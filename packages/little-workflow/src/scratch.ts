import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { HarnessScope } from "./harness/types.js";

export type ScratchMount = {
  readonly mountPath: string;
  readonly backingPath: string;
  readonly mode: "rw" | "ro";
};

export function scratchMountsForScope(scope: HarnessScope): readonly ScratchMount[] {
  if (scope.role === "orchestrator" || scope.role === "planner") {
    return plannerOrOrchestratorScratchMounts(scope);
  }
  return workerScratchMounts(scope);
}

export async function ensureScratchMounts(mounts: readonly ScratchMount[]): Promise<void> {
  await Promise.all(
    mounts
      .filter((mount) => !isPatternPath(mount.backingPath))
      .map((mount) => mkdir(mount.backingPath, { recursive: true })),
  );
}

function plannerOrOrchestratorScratchMounts(scope: HarnessScope): readonly ScratchMount[] {
  const mounts: ScratchMount[] = [
    {
      mountPath: "/mnt/scratch/own/",
      backingPath: ownRunScratchPath(scope),
      mode: "rw",
    },
  ];
  if (scope.role === "planner" && scope.parentRunId !== undefined) {
    mounts.push({
      mountPath: "/mnt/scratch/from-orchestrator/",
      backingPath: join(parentRunLogDir(scope), "scratch"),
      mode: "ro",
    });
  }
  return mounts;
}

function workerScratchMounts(scope: HarnessScope): readonly ScratchMount[] {
  const stepPath = stepPathForScope(scope);
  const mounts: ScratchMount[] = [
    {
      mountPath: "/mnt/scratch/own/",
      backingPath: join(scope.logDir, "steps", stepPath, "scratch"),
      mode: "rw",
    },
    {
      mountPath: "/mnt/scratch/from-planner/",
      backingPath: ownRunScratchPath(scope),
      mode: "ro",
    },
  ];
  if (scope.parentRunId !== undefined) {
    mounts.push({
      mountPath: "/mnt/scratch/from-orchestrator/",
      backingPath: join(parentRunLogDir(scope), "scratch"),
      mode: "ro",
    });
  }
  mounts.push({
    mountPath: "/mnt/scratch/peer-steps/",
    backingPath: join(scope.logDir, "steps", "*", "scratch"),
    mode: "ro",
  });
  return mounts;
}

function ownRunScratchPath(scope: HarnessScope): string {
  return join(scope.logDir, "scratch");
}

function parentRunLogDir(scope: HarnessScope): string {
  return dirname(dirname(scope.logDir));
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
