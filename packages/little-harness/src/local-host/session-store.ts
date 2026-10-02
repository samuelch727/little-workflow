import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import type {
  ArtifactRef,
  FileWriter,
  GetOrCreateSessionOptions,
  HarnessSession,
  HarnessSessionManager,
  HarnessSessionStatus,
  TraceRef,
} from "../types.js";
import { createGeneratedSessionId, sessionKeyToPathKey } from "../ids.js";
import { createLocalFileWriter } from "../files/file-writer.js";
import { sessionPaths, type LocalHostPaths, type LocalSessionPaths } from "./paths.js";

export type LocalHarnessSession = HarnessSession & {
  pathKey: string;
  paths: LocalSessionPaths;
};

export class LocalSessionStore<TExtraBody = unknown>
  implements HarnessSessionManager<TExtraBody>
{
  constructor(private readonly paths: LocalHostPaths) {}

  async getOrCreate(
    options: GetOrCreateSessionOptions<TExtraBody> = {},
  ): Promise<LocalHarnessSession> {
    const id = options.id ?? createGeneratedSessionId();
    const pathKey = sessionKeyToPathKey(id);
    const paths = sessionPaths(this.paths, pathKey);

    await ensureSessionDirs(paths);

    const existing = await readStatus(paths.statusFile);
    const status =
      existing ??
      ({
        id,
        state: "idle",
        pathKey,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        stagedMessageIds: [],
      } satisfies HarnessSessionStatus);

    if (!existing) {
      await writeStatus(paths.statusFile, status);
    }

    return createLocalHarnessSession(id, pathKey, paths, status);
  }

  async get(id: string): Promise<LocalHarnessSession | undefined> {
    const pathKey = sessionKeyToPathKey(id);
    const paths = sessionPaths(this.paths, pathKey);
    const status = await readStatus(paths.statusFile);

    if (!status) {
      return undefined;
    }

    return createLocalHarnessSession(id, pathKey, paths, status);
  }
}

async function ensureSessionDirs(paths: LocalSessionPaths): Promise<void> {
  await Promise.all([
    mkdir(paths.sessionDir, { recursive: true }),
    mkdir(paths.artifactsDir, { recursive: true }),
    mkdir(paths.persistentCheckoutDir, { recursive: true }),
    mkdir(paths.agentsDir, { recursive: true }),
    mkdir(paths.turnsDir, { recursive: true }),
  ]);
}

async function readStatus(pathname: string): Promise<HarnessSessionStatus | undefined> {
  try {
    return JSON.parse(await readFile(pathname, "utf8")) as HarnessSessionStatus;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    // A truncated/partial status.json (e.g. a crash mid-write) is treated as absent so the
    // session can be recreated rather than becoming permanently unreopenable.
    if (error instanceof SyntaxError) {
      return undefined;
    }
    throw error;
  }
}

async function writeStatus(pathname: string, status: HarnessSessionStatus): Promise<void> {
  // Atomic temp-file-then-rename, matching the durability layer's writeJson, so a crash
  // mid-write never leaves a truncated status.json for a reader to observe.
  const tempPath = `${pathname}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tempPath, JSON.stringify(status, null, 2), "utf8");
  await rename(tempPath, pathname);
}

function createLocalHarnessSession(
  id: string,
  pathKey: string,
  paths: LocalSessionPaths,
  initialStatus: HarnessSessionStatus,
): LocalHarnessSession {
  let statusCache = initialStatus;
  let readOnlyPersistentDirs: readonly string[] = [];
  const files: FileWriter = createLocalFileWriter(paths, {
    getReadOnlyPersistentDirs: () => readOnlyPersistentDirs,
  });
  const trace: TraceRef = { id: `trace_${pathKey}`, path: paths.traceFile };

  return {
    id,
    pathKey,
    paths,
    dataDir: paths.root,
    files,
    artifacts: {
      async list() {
        const entries = await files.list("/artifacts", { recursive: true });
        return entries
          .filter((entry) => entry.kind === "file")
          .map((entry) => {
            const artifact: ArtifactRef = { id: entry.path, path: entry.path };
            if (entry.bytes !== undefined) {
              artifact.bytes = entry.bytes;
            }
            return artifact;
          });
      },
      async read(artifactPath, options) {
        if (artifactPath !== "/artifacts" && !artifactPath.startsWith("/artifacts/")) {
          throw new Error(`Artifact paths must be inside /artifacts: ${artifactPath}`);
        }
        return files.read(artifactPath, options);
      },
    },
    trace,
    async status() {
      statusCache = (await readStatus(paths.statusFile)) ?? statusCache;
      return statusCache;
    },
    async setStatus(patch) {
      const current = (await readStatus(paths.statusFile)) ?? statusCache;
      statusCache = {
        id: patch.id ?? current.id,
        state: patch.state ?? current.state,
        pathKey: patch.pathKey ?? current.pathKey,
        createdAt: patch.createdAt ?? current.createdAt,
        updatedAt: new Date().toISOString(),
        stagedMessageIds: patch.stagedMessageIds ?? current.stagedMessageIds,
      };
      await writeStatus(paths.statusFile, statusCache);
    },
    async markMessageStaged(messageId) {
      const current = (await readStatus(paths.statusFile)) ?? statusCache;
      if (current.stagedMessageIds.includes(messageId)) {
        return;
      }

      statusCache = {
        ...current,
        stagedMessageIds: [...current.stagedMessageIds, messageId],
        updatedAt: new Date().toISOString(),
      };
      await writeStatus(paths.statusFile, statusCache);
    },
    setReadOnlyPersistentDirs(harnessDirs) {
      readOnlyPersistentDirs = [...harnessDirs];
    },
    getReadOnlyPersistentDirs() {
      return readOnlyPersistentDirs;
    },
  };
}
