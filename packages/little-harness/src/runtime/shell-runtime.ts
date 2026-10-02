import { tool } from "ai";
import * as path from "node:path";
import { z } from "zod";
import { diffSnapshots, snapshotFolder, type FolderSnapshot } from "../files/diff.js";
import { toHarnessPath, type ManagedRoot } from "../files/path-policy.js";
import { sha256Hex } from "../ids.js";
import { captureTraceContent } from "../trace/content.js";
import { createTraceDiff } from "../trace/diff.js";
import { createTraceErrorEnvelope } from "../trace/error.js";
import { resolveTraceOptions } from "../trace/options.js";
import { redactionReasonForPath } from "../trace/redaction.js";
import type { ResolvedHarnessTraceOptions } from "../trace/types.js";
import type {
  FileWriter,
  HarnessEvent,
  HarnessEventInput,
  HarnessRuntime,
  HarnessRuntimeOptions,
  HarnessRuntimeSystemHintsOptions,
  HarnessWorkspaceMount,
  HarnessWorkspaceSpec,
  JsonObject,
} from "../types.js";
import type { RuntimeToolBridge } from "./tool-bridge.js";

export type ShellCommandInput = { command: string; cwd?: string; timeoutMs?: number };

export type ShellCommandResult = { stdout: string; stderr: string; exitCode: number };

export type CreateShellRuntimeOptions = {
  workspace: HarnessWorkspaceSpec;
  /**
   * Runs one shell command in the execution environment. Implementations own cwd/env
   * persistence across calls (in-process just-bash keeps a live interpreter; a subprocess
   * environment keeps them in the child). Failures must be reported as a result with a
   * non-zero exitCode and the message in stderr — never thrown — so the model sees the
   * same tool-result shape from every adapter.
   */
  execute(input: ShellCommandInput, context: { toolCallId: string }): Promise<ShellCommandResult>;
  toolBridge?: RuntimeToolBridge | undefined;
  runtime?: HarnessRuntimeOptions | undefined;
  emit?: ((event: HarnessEventInput) => Promise<HarnessEvent | void>) | undefined;
  emitToolEvents?: boolean | undefined;
  /** Defaults to the harness's standard trace configuration when omitted. */
  traceOptions?: ResolvedHarnessTraceOptions | undefined;
  files: FileWriter;
  dispose?: (() => Promise<void>) | undefined;
};

/**
 * Builds a HarnessRuntime (system hints + the `bash` shell tool) around any command
 * executor. All observable behavior — harness.runtime.command.* events, tool-call events,
 * workspace file-change events — lives here once, so in-process, subprocess, and remote
 * execution environments emit identical traces.
 */
export function createShellRuntime(options: CreateShellRuntimeOptions): HarnessRuntime {
  const { workspace, toolBridge } = options;
  const traceOptions = options.traceOptions ?? resolveTraceOptions(undefined, undefined);

  return {
    systemHints(hintOptions?: HarnessRuntimeSystemHintsOptions) {
      const advertiseToolBridge =
        toolBridge !== undefined &&
        options.runtime?.bash !== false &&
        (hintOptions?.activeTools === undefined || hintOptions.activeTools.includes("bash"));
      const hints = workspaceHints(workspace);
      if (advertiseToolBridge) {
        hints.push(
          `Runtime JavaScript can call configured harness tools with js-exec. Available tools: ${
            toolBridge.toolNames.map((name) => `tools.${name}(args)`).join(", ")
          }.`,
          "For complex or batched tool calls, run js-exec and call tools.<name>(args) from JavaScript.",
        );
      }
      return hints;
    },
    shellTool() {
      return tool({
        description: "Run a bash command inside the Little Harness session filesystem.",
        inputSchema: z.object({
          command: z.string().describe("Bash command to run inside the harness filesystem."),
          cwd: z.string().optional().describe("Working directory for this command."),
          timeoutMs: z.number().optional().describe("Abort the command after this many milliseconds."),
        }),
        execute: async ({ command, cwd, timeoutMs }, executeOptions) => {
          const input: ShellCommandInput = { command };
          if (cwd !== undefined) {
            input.cwd = cwd;
          }
          if (timeoutMs !== undefined) {
            input.timeoutMs = timeoutMs;
          }
          const startedAt = Date.now();
          const toolCallId =
            isObject(executeOptions) && typeof executeOptions.toolCallId === "string"
              ? executeOptions.toolCallId
              : "runtime_bash";
          const before = options.emit ? await snapshotTrackedMounts(workspace) : undefined;
          await options.emit?.({
            type: "harness.runtime.command.started",
            metadata: input,
          });
          if (options.emitToolEvents !== false) {
            await options.emit?.({
              type: "harness.tool_call.started",
              metadata: {
                toolName: "bash",
                toolCallId,
                caller: "runtime",
                input: await captureTraceContent({
                  value: input,
                  label: "tool-input/bash",
                  files: options.files,
                  traceOptions,
                }),
              },
            });
          }
          const result = await options.execute(input, { toolCallId });
          const output: ShellCommandResult = {
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.exitCode,
          };
          const durationMs = Date.now() - startedAt;
          if (before && options.emit) {
            await emitTrackedMountChanges(
              before,
              await snapshotTrackedMounts(workspace),
              options.emit,
              traceOptions,
              options.files,
            );
          }
          await options.emit?.({
            type: result.exitCode === 0 ? "harness.runtime.command.succeeded" : "harness.runtime.command.failed",
            metadata: {
              command,
              ...(cwd === undefined ? {} : { cwd }),
              ...(timeoutMs === undefined ? {} : { timeoutMs }),
              exitCode: result.exitCode,
              durationMs,
              stdout: await captureTraceContent({
                value: result.stdout,
                label: "runtime/stdout",
                files: options.files,
                traceOptions,
                mediaType: "text/plain",
              }),
              stderr: await captureTraceContent({
                value: result.stderr,
                label: "runtime/stderr",
                files: options.files,
                traceOptions,
                mediaType: "text/plain",
              }),
            },
          });
          if (options.emitToolEvents !== false) {
            await options.emit?.({
              type: result.exitCode === 0 ? "harness.tool_call.succeeded" : "harness.tool_call.failed",
              metadata: {
                toolName: "bash",
                toolCallId,
                caller: "runtime",
                durationMs,
                output: await captureTraceContent({
                  value: output,
                  label: "tool-output/bash",
                  files: options.files,
                  traceOptions,
                }),
                ...(result.exitCode === 0
                  ? {}
                  : { error: createTraceErrorEnvelope(new Error(`Command exited with ${result.exitCode}`)) }),
              },
            });
          }

          return output;
        },
      });
    },
    ...(options.dispose === undefined ? {} : { dispose: options.dispose }),
  };
}

export function trimTrailingSlash(value: string): string {
  const trimmed = value.replace(/\/+$/gu, "");
  return trimmed.length === 0 ? "/" : path.posix.normalize(trimmed);
}

const CANONICAL_MOUNT_PATHS = ["/session", "/artifacts", "/persistent", "/.agents"] as const;

/**
 * System hints derived from the workspace spec so custom layouts are described truthfully.
 * The canonical layout keeps its historical wording byte-for-byte: hints feed the system
 * prompt, and changing them would break promptHash replay of previously recorded runs.
 */
const CANONICAL_MOUNT_MODES = ["rw", "rw", "rw", "ro"] as const;

function workspaceHints(workspace: HarnessWorkspaceSpec): string[] {
  const mountPaths = workspace.mounts.map((mount) => trimTrailingSlash(mount.mountPath));
  const isCanonical =
    mountPaths.length === CANONICAL_MOUNT_PATHS.length &&
    CANONICAL_MOUNT_PATHS.every((mountPath, index) => mountPaths[index] === mountPath) &&
    CANONICAL_MOUNT_MODES.every((mode, index) => workspace.mounts[index]!.mode === mode);
  if (isCanonical) {
    return [
      "The harness filesystem exposes /session, /artifacts, /persistent, and /.agents.",
      "Write intermediate working files in /session and host-visible outputs in /artifacts.",
      "Configured /persistent directories may be read-write, manual-commit, or read-only; /.agents is read-only.",
    ];
  }
  const readOnlyPaths = workspace.mounts
    .filter((mount) => mount.mode === "ro")
    .map((mount) => trimTrailingSlash(mount.mountPath));
  const hints = [
    `The harness filesystem exposes ${formatPathList(mountPaths)}.`,
    `The working directory is ${workspace.workingDir}.`,
  ];
  if (readOnlyPaths.length > 0) {
    hints.push(`${formatPathList(readOnlyPaths)} ${readOnlyPaths.length === 1 ? "is" : "are"} read-only.`);
  }
  return hints;
}

function formatPathList(paths: readonly string[]): string {
  if (paths.length <= 1) {
    return paths[0] ?? "/";
  }
  if (paths.length === 2) {
    return `${paths[0]} and ${paths[1]}`;
  }
  return `${paths.slice(0, -1).join(", ")}, and ${paths[paths.length - 1]}`;
}

/** Content of every tracked mount, keyed by the mount's tracked-root label. */
export type TrackedMountSnapshot = Record<string, FolderSnapshot>;

/**
 * Snapshot every `trackChanges` mount's backing directory.
 *
 * Exported so an execution environment that mutates a mount OUTSIDE a shell command —
 * a sandbox syncing its workspace back to the host at dispose, say — can bracket that
 * write the same way the `bash` tool brackets a command, and then emit the same
 * `harness.file.*` events with {@link emitTrackedMountFileChanges}.
 */
export async function snapshotTrackedMounts(
  workspace: HarnessWorkspaceSpec,
): Promise<TrackedMountSnapshot> {
  const snapshot: TrackedMountSnapshot = {};
  for (const mount of workspace.mounts) {
    if (mount.trackChanges !== true) {
      continue;
    }
    snapshot[trackedRootLabel(mount)] = await snapshotFolder(mount.backingPath);
  }
  return snapshot;
}

function trackedRootLabel(mount: HarnessWorkspaceMount): string {
  return trimTrailingSlash(mount.mountPath).replace(/^\/+/u, "");
}

/**
 * Re-diff the tracked mounts against `before` and emit the resulting
 * `harness.file.created` / `.updated` / `.deleted` events.
 *
 * `after` defaults to a fresh snapshot, so the ordinary use is: snapshot, mutate the
 * backing directories, call this. Comparison is by content hash (files/diff.ts), so
 * rewriting identical bytes emits nothing.
 */
export async function emitTrackedMountFileChanges(options: {
  workspace: HarnessWorkspaceSpec;
  before: TrackedMountSnapshot;
  after?: TrackedMountSnapshot | undefined;
  emit: (event: HarnessEventInput) => Promise<HarnessEvent | void>;
  files: FileWriter;
  traceOptions?: ResolvedHarnessTraceOptions | undefined;
}): Promise<void> {
  await emitTrackedMountChanges(
    options.before,
    options.after ?? (await snapshotTrackedMounts(options.workspace)),
    options.emit,
    options.traceOptions ?? resolveTraceOptions(undefined, undefined),
    options.files,
  );
}

async function emitTrackedMountChanges(
  before: TrackedMountSnapshot,
  after: TrackedMountSnapshot,
  emit: (event: HarnessEventInput) => Promise<HarnessEvent | void>,
  traceOptions: ResolvedHarnessTraceOptions,
  files: FileWriter,
): Promise<void> {
  for (const [root, beforeSnapshot] of Object.entries(before)) {
    const changes = diffSnapshots(beforeSnapshot, after[root] ?? {});

    for (const [file, content] of Object.entries(changes.created)) {
      await emitWrittenFileEvents(root, file, undefined, content, "harness.file.created", emit, traceOptions, files);
    }

    for (const [file, content] of Object.entries(changes.updated)) {
      await emitWrittenFileEvents(root, file, beforeSnapshot[file], content, "harness.file.updated", emit, traceOptions, files);
    }

    for (const file of changes.deleted) {
      await emit({
        type: "harness.file.deleted",
        metadata: {
          path: trackedHarnessPath(root, file),
          root,
          source: "tool",
          before: binaryMetadata(beforeSnapshot[file]!),
          diff: { available: false, reason: "content_unavailable" },
        },
      });
    }
  }
}

// "agents" is deliberately absent: the /.agents mount's label is ".agents" (which the
// generic branch maps correctly), while a custom /agents mount must NOT be rewritten to
// /.agents by the ManagedRoot special case.
const MANAGED_ROOT_LABELS: ReadonlySet<string> = new Set(["session", "artifacts", "persistent"]);

function trackedHarnessPath(root: string, file: string): string {
  if (MANAGED_ROOT_LABELS.has(root)) {
    return toHarnessPath(root as ManagedRoot, file);
  }
  const clean = file.split(path.sep).join("/");
  return clean ? `/${root}/${clean}` : `/${root}`;
}

async function emitWrittenFileEvents(
  root: string,
  file: string,
  before: Uint8Array | undefined,
  content: Uint8Array,
  type: "harness.file.created" | "harness.file.updated",
  emit: (event: HarnessEventInput) => Promise<HarnessEvent | void>,
  traceOptions: ResolvedHarnessTraceOptions,
  files: FileWriter,
): Promise<void> {
  const harnessPath = trackedHarnessPath(root, file);
  const metadata = await runtimeFileMetadata(root, harnessPath, before, content, traceOptions, files);

  await emit({ type, metadata });
  await emit({ type: "harness.file.written_by_tool", metadata });

  if (root === "artifacts") {
    await emit({
      type: "harness.artifact.created",
      metadata: {
        ...metadata,
        artifact: {
          id: harnessPath,
          path: harnessPath,
          bytes: content.byteLength,
          sha256: sha256Hex(content),
        },
      },
    });
  }
}

async function runtimeFileMetadata(
  root: string,
  harnessPath: string,
  before: Uint8Array | undefined,
  content: Uint8Array,
  traceOptions: ResolvedHarnessTraceOptions,
  files: FileWriter,
): Promise<JsonObject> {
  return {
    path: harnessPath,
    root,
    bytes: content.byteLength,
    sha256: sha256Hex(content),
    source: "tool",
    ...(before ? { before: binaryMetadata(before) } : {}),
    after: binaryMetadata(content),
    diff: redactionReasonForPath(harnessPath, traceOptions)
      ? { available: false as const, reason: "redacted" as const }
      : await createTraceDiff(before, content, traceOptions, { files, path: harnessPath }),
  };
}

function binaryMetadata(content: Uint8Array): { bytes: number; sha256: string } {
  return { bytes: content.byteLength, sha256: sha256Hex(content) };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
