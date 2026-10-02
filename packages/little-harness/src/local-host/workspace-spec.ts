import type { HarnessWorkspaceSpec } from "../types.js";
import type { LocalHarnessSession } from "./session-store.js";

/**
 * The canonical Little Harness workspace layout (/session, /artifacts, /persistent,
 * /.agents) backed by a local session's directories. Hosts hand this spec to whichever
 * execution-environment factory is configured; the factory never sees the session itself.
 */
export function localSessionWorkspace(session: LocalHarnessSession): HarnessWorkspaceSpec {
  return {
    sessionId: session.id,
    workingDir: "/session",
    mounts: [
      {
        mountPath: "/session",
        backingPath: session.paths.sessionDir,
        mode: "rw",
        trackChanges: true,
      },
      {
        mountPath: "/artifacts",
        backingPath: session.paths.artifactsDir,
        mode: "rw",
        trackChanges: true,
      },
      {
        mountPath: "/persistent",
        backingPath: session.paths.persistentCheckoutDir,
        mode: "rw",
        trackChanges: true,
        getReadOnlyPrefixes: () => session.getReadOnlyPersistentDirs(),
      },
      {
        mountPath: "/.agents",
        backingPath: session.paths.agentsDir,
        mode: "ro",
      },
    ],
  };
}
