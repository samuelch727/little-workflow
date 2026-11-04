import { InMemoryFs, type IFileSystem } from "just-bash";
import * as path from "node:path";
import { createFsFileWriter } from "../files/fs-file-writer.js";
import { FILESYSTEM_ROOT_DIRS } from "../files/path-policy.js";
import { filesystemStorage } from "../files/storage.js";
import { createGeneratedSessionId, sessionKeyToPathKey } from "../ids.js";
import { createDurableOrchestrationServices } from "../local-host/durable-services.js";
import { createInMemoryDurableStore, type DurableJsonStore } from "../local-host/durable-store.js";
import { LocalSessionQueue, type LocalSessionQueueOptions } from "../local-host/queue.js";
import { turnSandboxOptions } from "../local-host/sandbox-options.js";
import { enrichTraceEvent } from "../local-host/trace.js";
import { harnessWorkspace } from "../local-host/workspace-spec.js";
import { preparePersistentDirs } from "../persistent-dir/commit.js";
import { justBashSandbox } from "../runtime/just-bash-runtime.js";
import { stageResolvedSkills } from "../skills/stage-skills.js";
import { resolveTraceOptions } from "../trace/options.js";
import type {
  ArtifactRef,
  GetOrCreateSessionOptions,
  HarnessEvent,
  HarnessEventInput,
  HarnessHost,
  HarnessOrchestrationServices,
  HarnessSandboxFactory,
  HarnessSession,
  HarnessSessionManager,
  HarnessSessionStatus,
  PersistentDir,
} from "../types.js";
import type { VirtualHostPaths } from "./paths.js";

export type { VirtualHostPaths } from "./paths.js";

/** Where virtualHost keeps a session's status and trace position, outside the agent's view. */
export const VIRTUAL_HOST_STATE_DIR = "/.little-harness";

export type VirtualHostOptions<TExtraBody = unknown> = LocalSessionQueueOptions & {
  /**
   * The just-bash filesystem a session works in. Its root holds the workspace (/session,
   * /artifacts, /persistent, /.agents), and the host keeps the session's status and trace
   * position under /.little-harness, which bash never sees. Save the filesystem and you have
   * saved the session.
   *
   * One filesystem is one workspace: every session this host opens works in it, which suits
   * a host per chat (a Durable Object per chat on workerd). Pass a function to give each
   * session a filesystem of its own; it should return the same filesystem for the same id.
   * Defaults to a new `InMemoryFs` per session, kept for the life of the host.
   */
  fs?: IFileSystem | ((sessionId: string) => IFileSystem | Promise<IFileSystem>);
  /**
   * Storage for localDir() and memory folders, under /.little-harness/data. Defaults to
   * the session's fs. A shared filesystem shares folders between sessions, without
   * providing transactions across those sessions. Like fs, a factory is cached per id.
   */
  dataFs?: IFileSystem | ((sessionId: string) => IFileSystem | Promise<IFileSystem>);
  /**
   * Backs human input, parked turns, tasks and workflow queues. Defaults to memory, so they
   * last as long as the host; point it at durable storage (Durable Object storage, a database)
   * to keep them across restarts.
   */
  store?: DurableJsonStore;
  /** Orchestration services built some other way. Takes precedence over `store`. */
  orchestration?: HarnessOrchestrationServices;
  /**
   * The sandbox bash commands run in. Defaults to `justBashSandbox()` over the filesystem,
   * which on workerd has no python3, node or sqlite3. A sandbox that needs real directories
   * (`subprocessSandbox`) refuses this host's workspace; to escalate a turn to a real machine,
   * use one that copies the files there.
   */
  sandbox?: HarnessSandboxFactory<TExtraBody>;
};

/**
 * A host with no disk: each session's workspace and state live in a just-bash filesystem you
 * hand it. Use it where Node's filesystem is missing or unwanted, such as workerd, where a
 * Durable Object per chat keeps that chat's filesystem. Routing chats, saving filesystems and
 * running processes stay with your app.
 */
export function virtualHost<TExtraBody = unknown>(
  options: VirtualHostOptions<TExtraBody> = {},
): HarnessHost<TExtraBody> {
  const filesystems = new Map<string, Promise<IFileSystem>>();
  const dataFilesystems = new Map<string, Promise<IFileSystem>>();
  const fsFor = (sessionId: string): Promise<IFileSystem> => {
    let fs = filesystems.get(sessionId);
    if (fs === undefined) {
      const given = options.fs;
      fs = Promise.resolve(
        given === undefined ? new InMemoryFs() : typeof given === "function" ? given(sessionId) : given,
      );
      filesystems.set(sessionId, fs);
    }
    return fs;
  };
  const sessions = new VirtualSessionStore<TExtraBody>(fsFor, (sessionId) => {
    filesystems.delete(sessionId);
    dataFilesystems.delete(sessionId);
  });
  const dataFsFor = (sessionId: string): Promise<IFileSystem> => {
    let fs = dataFilesystems.get(sessionId);
    if (fs === undefined) {
      const given = options.dataFs;
      fs = given === undefined
        ? fsFor(sessionId)
        : Promise.resolve(typeof given === "function" ? given(sessionId) : given);
      dataFilesystems.set(sessionId, fs);
    }
    return fs;
  };
  const queue = new LocalSessionQueue(options);
  const durable =
    options.orchestration ??
    createDurableOrchestrationServices({
      rootDir: "/virtual",
      store: options.store ?? createInMemoryDurableStore(),
    });
  const traceOptions = resolveTraceOptions(undefined, undefined);
  const sandbox = options.sandbox ?? justBashSandbox<TExtraBody>();

  return {
    kind: "virtual",
    sessions,
    durable,
    runExclusive(session, runOptions, fn) {
      return queue.run(session.id, fn, { rejectIfBusy: runOptions.rejectIfBusy ?? false });
    },
    async prepareTurn({ session, persistentDirs, extraBody }) {
      const fs = await fsFor(session.id);
      const storage = filesystemStorage(fs);
      const trace = new VirtualTrace(fs, statePaths(sessionKeyToPathKey(session.id)).trace);
      const hostPaths: VirtualHostPaths = {
        kind: "virtual",
        dataFs: await dataFsFor(session.id),
        dataRoot: `${VIRTUAL_HOST_STATE_DIR}/data`,
      };
      const preparedPersistentDirs = await preparePersistentDirs({
        session,
        roots: FILESYSTEM_ROOT_DIRS,
        storage,
        hostPaths,
        persistentDirs: persistentDirs as PersistentDir<TExtraBody>[],
        extraBody,
      });
      const emit = (event: HarnessEventInput): Promise<HarnessEvent> =>
        trace.append({ ...event, sessionId: session.id, timestamp: new Date().toISOString() }, traceOptions);

      return {
        files: session.files,
        trace: session.trace,
        dataDir: hostPaths.dataRoot,
        dataFs: hostPaths.dataFs,
        orchestration: durable,
        emit,
        stageSkills: (skills) => stageResolvedSkills("/", skills, storage),
        loadPersistentDirs: preparedPersistentDirs.load,
        commitPersistentDirs: preparedPersistentDirs.commit,
        createSandbox: (runtimeOptions) =>
          sandbox(
            turnSandboxOptions(
              session,
              harnessWorkspace(session, FILESYSTEM_ROOT_DIRS, fs),
              emit,
              runtimeOptions,
            ),
          ),
      };
    },
  };
}

type StatePaths = { dir: string; status: string; trace: string };

function statePaths(pathKey: string): StatePaths {
  const dir = path.posix.join(VIRTUAL_HOST_STATE_DIR, "sessions", pathKey);
  return { dir, status: `${dir}/status.json`, trace: `${dir}/trace.json` };
}

class VirtualSessionStore<TExtraBody> implements HarnessSessionManager<TExtraBody> {
  constructor(
    private readonly fsFor: (sessionId: string) => Promise<IFileSystem>,
    private readonly forget: (sessionId: string) => void,
  ) {}

  async getOrCreate(options: GetOrCreateSessionOptions<TExtraBody> = {}): Promise<HarnessSession> {
    const id = options.id ?? createGeneratedSessionId();
    const pathKey = sessionKeyToPathKey(id);
    const fs = await this.fsFor(id);
    const paths = statePaths(pathKey);

    await ensureSessionRoots(fs, paths);

    const existing = await readJson<HarnessSessionStatus>(fs, paths.status);
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
      await fs.writeFile(paths.status, JSON.stringify(status, null, 2));
    }

    return createVirtualSession(id, pathKey, fs, paths, status);
  }

  async get(id: string): Promise<HarnessSession | undefined> {
    const pathKey = sessionKeyToPathKey(id);
    const fs = await this.fsFor(id);
    const paths = statePaths(pathKey);
    const status = await readJson<HarnessSessionStatus>(fs, paths.status);
    if (!status) {
      this.forget(id);
      return undefined;
    }
    // A saved filesystem may contain only regular files. Reopening an existing
    // session must restore its empty roots before callers resume or list artifacts.
    await ensureSessionRoots(fs, paths);
    return createVirtualSession(id, pathKey, fs, paths, status);
  }
}

async function ensureSessionRoots(fs: IFileSystem, paths: StatePaths): Promise<void> {
  await Promise.all(
    [...Object.values(FILESYSTEM_ROOT_DIRS), paths.dir].map((dir) => fs.mkdir(dir, { recursive: true })),
  );
}

function createVirtualSession(
  id: string,
  pathKey: string,
  fs: IFileSystem,
  paths: StatePaths,
  initialStatus: HarnessSessionStatus,
): HarnessSession {
  let statusCache = initialStatus;
  let readOnlyPersistentDirs: readonly string[] = [];
  const files = createFsFileWriter(fs, { getReadOnlyPersistentDirs: () => readOnlyPersistentDirs });
  const writeStatus = async (status: HarnessSessionStatus) => {
    statusCache = status;
    await fs.writeFile(paths.status, JSON.stringify(status, null, 2));
  };

  return {
    id,
    dataDir: path.posix.join(VIRTUAL_HOST_STATE_DIR, "data", "sessions", pathKey),
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
      async read(artifactPath, readOptions) {
        if (artifactPath !== "/artifacts" && !artifactPath.startsWith("/artifacts/")) {
          throw new Error(`Artifact paths must be inside /artifacts: ${artifactPath}`);
        }
        return files.read(artifactPath, readOptions);
      },
    },
    trace: { id: `trace_${pathKey}` },
    async status() {
      statusCache = (await readJson<HarnessSessionStatus>(fs, paths.status)) ?? statusCache;
      return statusCache;
    },
    async setStatus(patch) {
      const current = (await readJson<HarnessSessionStatus>(fs, paths.status)) ?? statusCache;
      await writeStatus({
        id: patch.id ?? current.id,
        state: patch.state ?? current.state,
        pathKey: patch.pathKey ?? current.pathKey,
        createdAt: patch.createdAt ?? current.createdAt,
        updatedAt: new Date().toISOString(),
        stagedMessageIds: patch.stagedMessageIds ?? current.stagedMessageIds,
      });
    },
    async markMessageStaged(messageId) {
      const current = (await readJson<HarnessSessionStatus>(fs, paths.status)) ?? statusCache;
      if (current.stagedMessageIds.includes(messageId)) {
        return;
      }
      await writeStatus({
        ...current,
        stagedMessageIds: [...current.stagedMessageIds, messageId],
        updatedAt: new Date().toISOString(),
      });
    },
    setReadOnlyPersistentDirs(harnessDirs) {
      readOnlyPersistentDirs = [...harnessDirs];
    },
    getReadOnlyPersistentDirs() {
      return readOnlyPersistentDirs;
    },
  };
}

/**
 * Numbers a session's trace events and keeps the last number in the filesystem, so a session
 * saved and reopened later carries on from it. The events themselves go to the harness's
 * `onEvent`; this host stores none of them.
 */
class VirtualTrace {
  private sequence: number | undefined;
  private saved: Promise<void> = Promise.resolve();

  constructor(
    private readonly fs: IFileSystem,
    private readonly file: string,
  ) {}

  async append(
    event: HarnessEvent,
    traceOptions: ReturnType<typeof resolveTraceOptions>,
  ): Promise<HarnessEvent> {
    this.sequence ??= (await readJson<{ sequence?: number }>(this.fs, this.file))?.sequence ?? 0;
    this.sequence += 1;
    const sequence = this.sequence;
    const enriched = enrichTraceEvent(event, sequence, traceOptions);
    // Writes are chained so a slow filesystem can never land an older number last.
    this.saved = this.saved
      .catch(() => undefined)
      .then(() => this.fs.writeFile(this.file, JSON.stringify({ sequence })));
    await this.saved;
    return enriched;
  }
}

async function readJson<T>(fs: IFileSystem, file: string): Promise<T | undefined> {
  if (!(await fs.exists(file))) {
    return undefined;
  }
  try {
    return JSON.parse(await fs.readFile(file)) as T;
  } catch (error) {
    // A truncated file (a save cut short) reads as missing, as localHost treats status.json.
    if (error instanceof SyntaxError) {
      return undefined;
    }
    throw error;
  }
}
