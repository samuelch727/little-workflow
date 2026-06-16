import { mkdir, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { HarnessPathError } from "../errors.js";
import { diffSnapshots, snapshotFolder, type FolderSnapshot } from "../files/diff.js";
import { normalizeHarnessPrefix, resolveHarnessPath } from "../files/path-policy.js";
import { sha256Hex } from "../ids.js";
import type { LocalHostPaths } from "../local-host/paths.js";
import type { LocalHarnessSession } from "../local-host/session-store.js";
import { createTraceErrorEnvelope } from "../trace/error.js";
import type {
  FileChangeSet,
  FileContent,
  HarnessSession,
  PersistentDir,
  PersistentDirCommitOptions,
  PersistentDirCommitResult,
  PersistentDirEventOptions,
  PersistenceStatus,
} from "../types.js";

export type PreparePersistentDirsOptions<TExtraBody = unknown> = {
  hostPaths: LocalHostPaths;
  session: HarnessSession;
  persistentDirs: PersistentDir<TExtraBody>[];
  extraBody?: TExtraBody | undefined;
};

export type PreparedPersistentDirs = {
  load(options?: PersistentDirEventOptions): Promise<void>;
  commit(options?: PersistentDirCommitOptions): Promise<PersistenceStatus>;
};

type LoadedDir<TExtraBody> = {
  dir: PersistentDir<TExtraBody>;
  checkoutRoot: string;
  before: FolderSnapshot;
  cursor?: unknown;
};

export async function preparePersistentDirs<TExtraBody>(
  options: PreparePersistentDirsOptions<TExtraBody>,
): Promise<PreparedPersistentDirs> {
  const loaded: LoadedDir<TExtraBody>[] = [];
  const session = options.session as LocalHarnessSession;

  return {
    async load(loadOptions = {}) {
      loaded.length = 0;
      session.setReadOnlyPersistentDirs(
        options.persistentDirs
          .filter((dir) => dir.commit === "read-only")
          .map((dir) => normalizeHarnessPrefix(dir.harnessDir)),
      );

      for (const dir of options.persistentDirs) {
        const loadedAt = Date.now();
        const resolved = resolveHarnessPath(session.paths, dir.harnessDir, "write", {
          bypassReadOnly: true,
        });
        if (resolved.root !== "persistent") {
          throw new HarnessPathError("Persistent Dir harnessDir must be inside /persistent", {
            harnessDir: dir.harnessDir,
          });
        }

        const checkoutRoot = resolved.realPath;
        await rm(checkoutRoot, { recursive: true, force: true });
        await mkdir(checkoutRoot, { recursive: true });

        const { files, cursor } = await loadDir(dir, options);
        await writeSnapshot(checkoutRoot, files);
        const before = await snapshotFolder(checkoutRoot);
        loaded.push({
          dir,
          checkoutRoot,
          cursor,
          before,
        });
        await loadOptions.emit?.({
          type: "harness.persistent_dir.loaded",
          metadata: {
            harnessDir: dir.harnessDir,
            commit: dir.commit ?? "after-turn",
            durationMs: Date.now() - loadedAt,
            fileCount: Object.keys(before).length,
            files: snapshotFileMetadata(dir.harnessDir, before),
          },
        });
      }
    },
    async commit(commitOptions = {}) {
      if (loaded.length === 0) {
        return { status: "not-configured" };
      }

      const mode = commitOptions.mode ?? "automatic";
      const commits: PersistentDirCommitResult[] = [];
      for (const item of loaded) {
        const commitMode = item.dir.commit ?? "after-turn";
        const shouldCommit =
          mode === "manual" ? commitMode === "manual" : commitMode === "after-turn";
        if (!shouldCommit) {
          commits.push({
            harnessDir: item.dir.harnessDir,
            commit: commitMode,
            status: "skipped",
          });
          continue;
        }

        const after = await snapshotFolder(item.checkoutRoot);
        const changes = diffSnapshots(item.before, after);
        const changeSummary = persistentDirChangeSummary(item.dir.harnessDir, changes, item.before);
        const commitStartedAt = Date.now();

        try {
          await commitOptions.emit?.({
            type: "harness.persistent_dir.commit.started",
            metadata: {
              harnessDir: item.dir.harnessDir,
              commit: commitMode,
              ...changeSummary,
            },
          });

          if (item.dir.store) {
            await item.dir.store({
              extraBody: options.extraBody,
              session: options.session,
              harnessDir: item.dir.harnessDir,
              changes,
              snapshot: after,
              cursor: item.cursor,
              sessionHostPaths: options.hostPaths,
            });
          } else if (item.dir.write) {
            await applyFileOperationStore(item.dir, changes, options);
          }

          commits.push({
            harnessDir: item.dir.harnessDir,
            commit: commitMode,
            status: "succeeded",
          });
          await commitOptions.emit?.({
            type: "harness.persistent_dir.commit.succeeded",
            metadata: {
              harnessDir: item.dir.harnessDir,
              commit: commitMode,
              durationMs: Date.now() - commitStartedAt,
              ...changeSummary,
            },
          });
        } catch (error) {
          commits.push({
            harnessDir: item.dir.harnessDir,
            commit: commitMode,
            status: "failed",
            error,
          });
          await commitOptions.emit?.({
            type: "harness.persistent_dir.commit.failed",
            metadata: {
              harnessDir: item.dir.harnessDir,
              commit: commitMode,
              durationMs: Date.now() - commitStartedAt,
              ...changeSummary,
              error: createTraceErrorEnvelope(error),
            },
          });
        }
      }

      const failedCommits = commits.filter((commit) => commit.status === "failed");
      return failedCommits.length
        ? { status: "failed", commits, failedCommits }
        : { status: "succeeded", commits };
    },
  };
}

async function loadDir<TExtraBody>(
  dir: PersistentDir<TExtraBody>,
  options: PreparePersistentDirsOptions<TExtraBody>,
): Promise<{ files: Record<string, FileContent>; cursor?: unknown }> {
  if (dir.load) {
    const result = await dir.load({
      extraBody: options.extraBody,
      session: options.session,
      sessionHostPaths: options.hostPaths,
    });

    if (hasFilesResult(result)) {
      return { files: result.files, cursor: result.cursor };
    }

    return { files: result };
  }

  if (dir.list && dir.read) {
    const files: Record<string, FileContent> = {};
    const entries = await dir.list({
      extraBody: options.extraBody,
      session: options.session,
      path: "",
    });

    for (const entry of entries) {
      if (entry.kind === "file") {
        files[entry.path] = await dir.read({
          extraBody: options.extraBody,
          session: options.session,
          path: entry.path,
        });
      }
    }

    return { files };
  }

  return { files: {} };
}

async function writeSnapshot(root: string, files: Record<string, FileContent>): Promise<void> {
  for (const [file, content] of Object.entries(files)) {
    const target = resolveStorageFilePath(root, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, await toUint8Array(content));
  }
}

async function applyFileOperationStore<TExtraBody>(
  dir: PersistentDir<TExtraBody>,
  changes: FileChangeSet,
  options: PreparePersistentDirsOptions<TExtraBody>,
): Promise<void> {
  for (const [file, content] of Object.entries({ ...changes.created, ...changes.updated })) {
    await dir.write?.({
      extraBody: options.extraBody,
      session: options.session,
      path: file,
      content,
    });
  }

  for (const file of changes.deleted) {
    await dir.delete?.({
      extraBody: options.extraBody,
      session: options.session,
      path: file,
    });
  }
}

async function toUint8Array(content: FileContent): Promise<Uint8Array> {
  if (typeof content === "string") {
    return new TextEncoder().encode(content);
  }

  if (content instanceof Uint8Array) {
    return content;
  }

  if (content instanceof ArrayBuffer) {
    return new Uint8Array(content);
  }

  const chunks: Uint8Array[] = [];
  const reader = content.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    if (value) {
      chunks.push(value);
    }
  }

  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function hasFilesResult(
  result: Record<string, FileContent> | { files: Record<string, FileContent>; cursor?: unknown },
): result is { files: Record<string, FileContent>; cursor?: unknown } {
  return "files" in result && typeof result.files === "object" && result.files !== null;
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

  throw new HarnessPathError("Persistent Dir file path resolves outside harnessDir", { path: file });
}

function persistentDirChangeSummary(
  harnessDir: string,
  changes: FileChangeSet,
  before: FolderSnapshot,
) {
  return {
    changeCounts: {
      created: Object.keys(changes.created).length,
      updated: Object.keys(changes.updated).length,
      deleted: changes.deleted.length,
    },
    changes: {
      created: snapshotFileMetadata(harnessDir, changes.created),
      updated: snapshotFileMetadata(harnessDir, changes.updated),
      deleted: changes.deleted.map((file) => fileMetadata(harnessDir, file, before[file])),
    },
  };
}

function snapshotFileMetadata(harnessDir: string, snapshot: FolderSnapshot) {
  return Object.entries(snapshot)
    .map(([file, content]) => fileMetadata(harnessDir, file, content))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function fileMetadata(harnessDir: string, file: string, content: Uint8Array | undefined) {
  const out: { path: string; kind: "file"; bytes?: number; sha256?: string } = {
    path: harnessFilePath(harnessDir, file),
    kind: "file",
  };
  if (content) {
    out.bytes = content.byteLength;
    out.sha256 = sha256Hex(content);
  }
  return out;
}

function harnessFilePath(harnessDir: string, file: string): string {
  return `${path.posix.normalize(harnessDir).replace(/\/$/u, "")}/${file
    .split(path.sep)
    .join("/")}`;
}
