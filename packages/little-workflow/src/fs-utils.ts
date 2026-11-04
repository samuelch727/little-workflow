import { runFilesFor } from "./run-files.js";

/** Disk-only utility for project/CLI callers; run-owned paths use their World's RunFiles. */
export async function removeDirRetrySafe(path: string): Promise<void> {
  await runFilesFor({ dataDir: "/" }).removeDirRetrySafe(path);
}
