import type { HarnessRuntimeMount, HarnessRuntimeOptions, HarnessWorkspaceSpec } from "../../types.js";

/**
 * Wire protocol between the subprocess-sandbox parent and its worker: newline-delimited
 * JSON over stdio. The worker holds only the workspace mount table and runtime toggles —
 * no session objects, no tool implementations, no credentials. Tool calls flow back to the
 * parent's tool proxy as `tool_call`/`tool_result` pairs.
 */
export type SerializedWorkspaceMount = {
  readonly mountPath: string;
  readonly backingPath: string;
  readonly mode: "rw" | "ro";
  readonly trackChanges?: boolean;
  /** Static snapshot of the mount's dynamic read-only prefixes, taken at spawn time. */
  readonly readOnlyPrefixes?: readonly string[];
};

export type SerializedWorkspaceSpec = {
  readonly sessionId: string;
  readonly workingDir: string;
  readonly mounts: readonly SerializedWorkspaceMount[];
};

export type SubprocessRuntimeToggles = Pick<
  HarnessRuntimeOptions,
  "python" | "javascript" | "network"
>;

export type ParentToWorkerMessage =
  | {
      readonly type: "init";
      readonly id: number;
      readonly workspace: SerializedWorkspaceSpec;
      readonly runtime: SubprocessRuntimeToggles;
      readonly mounts: readonly HarnessRuntimeMount[];
      readonly toolBridge: boolean;
    }
  | {
      readonly type: "exec";
      readonly id: number;
      readonly command: string;
      readonly cwd?: string;
      readonly timeoutMs?: number;
    }
  | { readonly type: "tool_result"; readonly id: number; readonly ok: true; readonly resultJson: string }
  | { readonly type: "tool_result"; readonly id: number; readonly ok: false; readonly message: string }
  | { readonly type: "diag"; readonly id: number };

export type WorkerToParentMessage =
  | { readonly type: "ready"; readonly id: number }
  | {
      readonly type: "exec_result";
      readonly id: number;
      readonly stdout: string;
      readonly stderr: string;
      readonly exitCode: number;
    }
  | { readonly type: "tool_call"; readonly id: number; readonly path: string; readonly argsJson: string }
  | {
      readonly type: "diag_result";
      readonly id: number;
      readonly pid: number;
      readonly envKeys: readonly string[];
    }
  | { readonly type: "fatal"; readonly message: string };

export function serializeWorkspace(workspace: HarnessWorkspaceSpec): SerializedWorkspaceSpec {
  return {
    sessionId: workspace.sessionId,
    workingDir: workspace.workingDir,
    mounts: workspace.mounts.map((mount) => ({
      mountPath: mount.mountPath,
      backingPath: mount.backingPath,
      mode: mount.mode,
      ...(mount.trackChanges === undefined ? {} : { trackChanges: mount.trackChanges }),
      ...(mount.getReadOnlyPrefixes === undefined
        ? {}
        : { readOnlyPrefixes: [...mount.getReadOnlyPrefixes()] }),
    })),
  };
}

export function deserializeWorkspace(workspace: SerializedWorkspaceSpec): HarnessWorkspaceSpec {
  return {
    sessionId: workspace.sessionId,
    workingDir: workspace.workingDir,
    mounts: workspace.mounts.map((mount) => ({
      mountPath: mount.mountPath,
      backingPath: mount.backingPath,
      mode: mount.mode,
      ...(mount.trackChanges === undefined ? {} : { trackChanges: mount.trackChanges }),
      ...(mount.readOnlyPrefixes === undefined
        ? {}
        : { getReadOnlyPrefixes: () => mount.readOnlyPrefixes! }),
    })),
  };
}
