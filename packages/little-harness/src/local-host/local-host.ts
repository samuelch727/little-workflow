import type {
  HarnessEvent,
  HarnessEventInput,
  HarnessSandboxFactory,
  HarnessHost,
  HarnessOrchestrationServices,
  PersistentDir,
} from "../types.js";
import { preparePersistentDirs } from "../persistent-dir/commit.js";
import { stageResolvedSkills } from "../skills/stage-skills.js";
import { createLocalHarnessDurableServices } from "./durable-services.js";
import {
  resolveSandbox,
  type HarnessSandboxMode,
} from "./execution-environment.js";
import { LocalSessionQueue, type LocalSessionQueueOptions } from "./queue.js";
import { turnSandboxOptions } from "./sandbox-options.js";
import { resolveLocalHostPaths, type LocalHostPathOptions } from "./paths.js";
import { LocalSessionStore, type LocalHarnessSession } from "./session-store.js";
import { LocalTrace } from "./trace.js";
import { localSessionWorkspace } from "./workspace-spec.js";

export type LocalHostOptions<TExtraBody = unknown> = LocalHostPathOptions &
  LocalSessionQueueOptions & {
    /**
     * The sandbox agent (bash) commands run in: a built-in mode, or a sandbox builder such as
     * `subprocessSandbox()`, `tieredSandbox({ ... })` or an adapter's, to run them elsewhere
     * without changing session or tool wiring.
     *
     * Defaults to `"auto"`, which keeps Tier-0 just-bash in the host process only for turns
     * that can neither execute model-authored code nor reach the network, and takes the
     * subprocess sandbox otherwise. `"in-process"` forces the in-process path for every turn:
     * a compatibility layer for trusted tool patterns, not an isolation boundary.
     */
    sandbox?:
      | HarnessSandboxMode
      | HarnessSandboxFactory<TExtraBody>;
    /**
     * Orchestration services (durable ledgers) backing tasks, continuations, wakeups, and
     * workflow queues. Defaults to the file-backed ledgers under the host's data dir;
     * inject an alternative (database-backed, in-memory, …) to coordinate turns through
     * another store without changing session or sandbox wiring.
     */
    orchestration?: HarnessOrchestrationServices;
  };

export function localHost<TExtraBody = unknown>(
  options: LocalHostOptions<TExtraBody> = {},
): HarnessHost<TExtraBody> {
  const paths = resolveLocalHostPaths(options);
  const sessions = new LocalSessionStore<TExtraBody>(paths);
  const queue = new LocalSessionQueue(options);
  const durable =
    options.orchestration ?? createLocalHarnessDurableServices({ rootDir: paths.dataDir });

  return {
    kind: "local",
    sessions,
    durable,
    dataDir: paths.dataDir,
    runExclusive(session, runOptions, fn) {
      return queue.run(session.id, fn, { rejectIfBusy: runOptions.rejectIfBusy ?? false });
    },
    async prepareTurn({ session, turnId, persistentDirs, extraBody }) {
      // localHost only ever hands out LocalHarnessSession instances, so the adapter may
      // recover its own concrete session type here.
      const localSession = session as LocalHarnessSession;
      const trace = new LocalTrace(localSession.paths.traceFile);
      const preparedPersistentDirs = await preparePersistentDirs({
        hostPaths: paths,
        session: localSession,
        roots: localSession.paths,
        persistentDirs: persistentDirs as PersistentDir<TExtraBody>[],
        extraBody,
      });
      const emit = async (event: PreparedTurnEvent) =>
        preparedTurnEmit(trace, session.id, event);

      return {
        files: session.files,
        dataDir: paths.dataDir,
        trace: trace.ref,
        orchestration: durable,
        emit,
        stageSkills: (skills) => stageResolvedSkills(localSession.paths.root, skills),
        loadPersistentDirs: preparedPersistentDirs.load,
        commitPersistentDirs: preparedPersistentDirs.commit,
        createSandbox: async (runtimeOptions) => {
          const environmentOptions = turnSandboxOptions(
            session,
            localSessionWorkspace(localSession),
            emit,
            runtimeOptions,
          );
          const createEnvironment = resolveSandbox(
            options.sandbox,
            environmentOptions.runtime,
          );
          return createEnvironment(environmentOptions);
        },
      };
    },
  };
}

type PreparedTurnEvent = HarnessEventInput;

async function preparedTurnEmit(
  trace: LocalTrace,
  sessionId: string,
  event: PreparedTurnEvent,
): Promise<HarnessEvent> {
  return trace.append({
    ...event,
    sessionId,
    timestamp: new Date().toISOString(),
  });
}
