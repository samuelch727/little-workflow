import { rm } from "node:fs/promises";

type RmOptions = {
  recursive: true;
  force: true;
  maxRetries: number;
  retryDelay: number;
};

const RM_RETRY_OPTIONS: RmOptions = {
  recursive: true,
  force: true,
  maxRetries: 3,
  retryDelay: 50,
};

export async function cleanupTempDirs(tempDirs: string[]): Promise<void> {
  const dirs = tempDirs.splice(0);
  await Promise.all(dirs.map((dir) => rm(dir, RM_RETRY_OPTIONS)));
}

export function workerScopedTempPrefix(base: string, poolId?: string): string {
  const workerLabel = (poolId ?? "worker").trim() || "worker";
  return `${base}${process.pid}-${workerLabel}-`;
}
