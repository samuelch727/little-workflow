import type { FileEntry, FileWriter, HarnessEvent, JsonObject, PersistentDir } from "../types.js";

type TurnEvent = Omit<HarnessEvent, "timestamp" | "sessionId">;

const MOUNTS = [
  { root: "session", harnessDir: "/session", source: "session", writable: true },
  { root: "artifacts", harnessDir: "/artifacts", source: "runtime", writable: true },
  { root: "agents", harnessDir: "/.agents", source: "skill", writable: false },
  { root: "persistent", harnessDir: "/persistent", source: "persistent_dir", writable: true },
] as const;

export async function emitMountedFiles(
  files: FileWriter,
  emit: (event: TurnEvent) => Promise<unknown>,
  options: { persistentDirs?: Pick<PersistentDir, "commit">[] } = {},
): Promise<void> {
  const persistentCommit = mountCommitMetadata(options.persistentDirs ?? []);
  for (const mount of MOUNTS) {
    const mountedFiles = await listMount(files, mount.harnessDir);
    await emit({
      type: "harness.filesystem.mounted",
      metadata: {
        root: mount.root,
        harnessDir: mount.harnessDir,
        source: mount.source,
        writable: mount.writable,
        ...(mount.root === "persistent" && persistentCommit ? { commit: persistentCommit } : {}),
        fileCount: mountedFiles.filter((entry) => entry.kind === "file").length,
        files: mountedFiles,
      },
    });
  }
}

function mountCommitMetadata(
  persistentDirs: Pick<PersistentDir, "commit">[],
): "after-turn" | "manual" | "read-only" | undefined {
  if (persistentDirs.length === 0) {
    return undefined;
  }

  const commits = new Set(persistentDirs.map((dir) => dir.commit ?? "after-turn"));
  return commits.size === 1 ? [...commits][0] : undefined;
}

async function listMount(files: FileWriter, harnessDir: string): Promise<JsonObject[]> {
  try {
    const entries = await files.list(harnessDir, { recursive: true });
    return entries.map(fileEntryMetadata);
  } catch {
    return [];
  }
}

function fileEntryMetadata(entry: FileEntry): JsonObject {
  return {
    path: entry.path,
    kind: entry.kind,
    ...(entry.bytes === undefined ? {} : { bytes: entry.bytes }),
  };
}
