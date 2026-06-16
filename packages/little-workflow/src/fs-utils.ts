import { rm } from "node:fs/promises";

const RETRY_SAFE_RM_OPTIONS = {
  recursive: true,
  force: true,
  maxRetries: 3,
  retryDelay: 50,
} as const satisfies NonNullable<Parameters<typeof rm>[1]>;

export async function removeDirRetrySafe(path: string): Promise<void> {
  await rm(path, RETRY_SAFE_RM_OPTIONS);
}
