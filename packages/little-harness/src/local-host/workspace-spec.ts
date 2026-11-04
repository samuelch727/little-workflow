import type { IFileSystem } from "just-bash";
import type { HarnessRootDirs } from "../files/path-policy.js";
import type { HarnessSession, HarnessWorkspaceSpec } from "../types.js";
import type { LocalHarnessSession } from "./session-store.js";

/**
 * The canonical Little Harness workspace layout (/session, /artifacts, /persistent,
 * /.agents) backed by a local session's directories. Hosts hand this spec to whichever
 * execution-environment factory is configured; the factory never sees the session itself.
 */
export function localSessionWorkspace(session: LocalHarnessSession): HarnessWorkspaceSpec {
  return harnessWorkspace(session, session.paths);
}

/**
 * The canonical layout over any session's four roots: directories on disk, or, with
 * `filesystem`, folders of that just-bash filesystem.
 */
export function harnessWorkspace(
  session: HarnessSession,
  roots: HarnessRootDirs,
  filesystem?: IFileSystem,
): HarnessWorkspaceSpec {
  return {
    sessionId: session.id,
    workingDir: "/session",
    mounts: [
      {
        mountPath: "/session",
        backingPath: roots.sessionDir,
        mode: "rw",
        trackChanges: true,
      },
      {
        mountPath: "/artifacts",
        backingPath: roots.artifactsDir,
        mode: "rw",
        trackChanges: true,
      },
      {
        mountPath: "/persistent",
        backingPath: roots.persistentCheckoutDir,
        mode: "rw",
        trackChanges: true,
        getReadOnlyPrefixes: () => session.getReadOnlyPersistentDirs(),
      },
      {
        mountPath: "/.agents",
        backingPath: roots.agentsDir,
        mode: "ro",
      },
    ],
    ...(filesystem === undefined ? {} : { filesystem }),
  };
}
