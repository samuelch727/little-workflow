import type {
  CreateExecutionEnvironmentOptions,
  HarnessEvent,
  HarnessEventInput,
  HarnessExecutionEnvironmentFactory,
  HarnessHost,
  HarnessOrchestrationServices,
  PersistentDir,
} from "../types.js";
import { preparePersistentDirs } from "../persistent-dir/commit.js";
import { stageResolvedSkills } from "../skills/stage-skills.js";
import { createLocalHarnessDurableServices } from "./durable-services.js";
import {
  resolveExecutionEnvironment,
  type HarnessExecutionEnvironmentMode,
} from "./execution-environment.js";
import { LocalSessionQueue, type LocalSessionQueueOptions } from "./queue.js";
import { resolveLocalHostPaths, type LocalHostPathOptions } from "./paths.js";
import { LocalSessionStore, type LocalHarnessSession } from "./session-store.js";
import { LocalTrace } from "./trace.js";
import { localSessionWorkspace } from "./workspace-spec.js";

export type LocalHostOptions<TExtraBody = unknown> = LocalHostPathOptions &
  LocalSessionQueueOptions & {
    /**
     * Execution environment used for runtime (bash) turns: a built-in mode, or a factory to
     * run agent commands elsewhere (subprocess, remote, …) without changing session or tool
     * wiring.
     *
     * Defaults to `"auto"`, which keeps Tier-0 just-bash in the host process only for turns
     * that can neither execute model-authored code nor reach the network, and takes the
     * subprocess sandbox otherwise. `"in-process"` forces the in-process path for every turn:
     * a compatibility layer for trusted tool patterns, not an isolation boundary.
     */
    executionEnvironment?:
      | HarnessExecutionEnvironmentMode
      | HarnessExecutionEnvironmentFactory<TExtraBody>;
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
        persistentDirs: persistentDirs as PersistentDir<TExtraBody>[],
        extraBody,
      });
      const emit = async (event: PreparedTurnEvent) =>
        preparedTurnEmit(trace, session.id, event);

      return {
        files: session.files,
        trace: trace.ref,
        orchestration: durable,
        emit,
        stageSkills: (skills) => stageResolvedSkills(localSession.paths.root, skills),
        loadPersistentDirs: preparedPersistentDirs.load,
        commitPersistentDirs: preparedPersistentDirs.commit,
        createRuntime: async (runtimeOptions) => {
          const environmentOptions: CreateExecutionEnvironmentOptions<TExtraBody> = {
            workspace: localSessionWorkspace(localSession),
            files: session.files,
            emit: runtimeOptions.emit ?? emit,
          };
          if (runtimeOptions.tools !== undefined) {
            environmentOptions.tools = runtimeOptions.tools;
            // The environment factory never sees the session, so the host supplies the
            // default execution context for bridge-invoked tools.
            environmentOptions.toolContext = runtimeOptions.toolContext ?? {
              session,
              files: session.files,
              artifacts: session.artifacts,
              ...(runtimeOptions.extraBody === undefined
                ? {}
                : { extraBody: runtimeOptions.extraBody }),
              ...(runtimeOptions.abortSignal === undefined
                ? {}
                : { abortSignal: runtimeOptions.abortSignal }),
            };
          }
          if (runtimeOptions.runtimeToolReplay !== undefined) {
            environmentOptions.runtimeToolReplay = runtimeOptions.runtimeToolReplay;
          }
          if (runtimeOptions.runtime !== undefined) {
            environmentOptions.runtime = runtimeOptions.runtime;
          }
          if (runtimeOptions.mounts !== undefined) {
            environmentOptions.mounts = runtimeOptions.mounts;
          }
          if (runtimeOptions.emitToolEvents !== undefined) {
            environmentOptions.emitToolEvents = runtimeOptions.emitToolEvents;
          }
          if (runtimeOptions.traceOptions !== undefined) {
            environmentOptions.traceOptions = runtimeOptions.traceOptions;
          }
          if (runtimeOptions.extraBody !== undefined) {
            environmentOptions.extraBody = runtimeOptions.extraBody;
          }
          if (runtimeOptions.abortSignal !== undefined) {
            environmentOptions.abortSignal = runtimeOptions.abortSignal;
          }
          const createEnvironment = resolveExecutionEnvironment(
            options.executionEnvironment,
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
