import type { HarnessEvent, HarnessEventInput, HarnessHost, PersistentDir } from "../types.js";
import { preparePersistentDirs } from "../persistent-dir/commit.js";
import {
  createJustBashRuntime,
  type CreateJustBashRuntimeOptions,
} from "../runtime/just-bash-runtime.js";
import { stageResolvedSkills } from "../skills/stage-skills.js";
import { LocalSessionQueue, type LocalSessionQueueOptions } from "./queue.js";
import { resolveLocalHostPaths, type LocalHostPathOptions } from "./paths.js";
import { LocalSessionStore, type LocalHarnessSession } from "./session-store.js";
import { LocalTrace } from "./trace.js";

export type LocalHostOptions = LocalHostPathOptions & LocalSessionQueueOptions;

export function localHost<TExtraBody = unknown>(
  options: LocalHostOptions = {},
): HarnessHost<TExtraBody> {
  const paths = resolveLocalHostPaths(options);
  const sessions = new LocalSessionStore<TExtraBody>(paths);
  const queue = new LocalSessionQueue(options);

  return {
    kind: "local",
    sessions,
    runExclusive(session, _runOptions, fn) {
      return queue.run(session.id, fn);
    },
    async prepareTurn({ session, turnId, persistentDirs, extraBody }) {
      const localSession = session as LocalHarnessSession;
      const trace = new LocalTrace(localSession.paths.traceFile);
      const preparedPersistentDirs = await preparePersistentDirs({
        hostPaths: paths,
        session,
        persistentDirs: persistentDirs as PersistentDir<TExtraBody>[],
        extraBody,
      });
      const emit = async (event: PreparedTurnEvent) =>
        preparedTurnEmit(trace, session.id, event);

      return {
        files: session.files,
        trace: trace.ref,
        emit,
        stageSkills: (skills) => stageResolvedSkills(localSession.paths.root, skills),
        loadPersistentDirs: preparedPersistentDirs.load,
        commitPersistentDirs: preparedPersistentDirs.commit,
        createRuntime: async (runtimeOptions) => {
          const justBashOptions: CreateJustBashRuntimeOptions = {
            session: localSession,
            files: session.files,
            emit: runtimeOptions.emit ?? emit,
          };
          if (runtimeOptions.tools !== undefined) {
            justBashOptions.tools = runtimeOptions.tools;
          }
          if (runtimeOptions.toolContext !== undefined) {
            justBashOptions.toolContext = runtimeOptions.toolContext;
          }
          if (runtimeOptions.runtimeToolReplay !== undefined) {
            justBashOptions.runtimeToolReplay = runtimeOptions.runtimeToolReplay;
          }
          if (runtimeOptions.runtime !== undefined) {
            justBashOptions.runtime = runtimeOptions.runtime;
          }
          if (runtimeOptions.mounts !== undefined) {
            justBashOptions.mounts = runtimeOptions.mounts;
          }
          if (runtimeOptions.emitToolEvents !== undefined) {
            justBashOptions.emitToolEvents = runtimeOptions.emitToolEvents;
          }
          if (runtimeOptions.traceOptions !== undefined) {
            justBashOptions.traceOptions = runtimeOptions.traceOptions;
          }
          if (runtimeOptions.extraBody !== undefined) {
            justBashOptions.extraBody = runtimeOptions.extraBody;
          }
          if (runtimeOptions.abortSignal !== undefined) {
            justBashOptions.abortSignal = runtimeOptions.abortSignal;
          }
          return createJustBashRuntime(justBashOptions);
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
