import { tool } from "ai";
import * as path from "node:path";
import { z } from "zod";
import { diffSnapshots, snapshotFolder, snapshotFs, type FolderSnapshot } from "../files/diff.js";
import { toHarnessPath, type ManagedRoot } from "../files/path-policy.js";
import { createEventId, sha256Hex } from "../ids.js";
import { createHarnessFileMutationEvents } from "../remote-session/file-events.js";
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
  HarnessExecutionTier,
  HarnessSandbox,
  HarnessRuntimeOptions,
  HarnessSandboxSystemHintsOptions,
  HarnessSandboxTiering,
  HarnessSandboxUsage,
  HarnessWorkspaceMount,
  HarnessWorkspaceSpec,
} from "../types.js";
import type { RuntimeToolBridge } from "./tool-bridge.js";

export type ShellCommandInput = { command: string; cwd?: string; timeoutMs?: number };

export type ShellCommandResult = { stdout: string; stderr: string; exitCode: number };

// Only tier delegation may forward an attempt identity. Public execute options cannot set it.
const forwardedAttemptToken = Symbol("harness.shell-attempt");
const forwardedExecutionIds = new WeakMap<object, string>();

/** Internal tier call channel; deliberately absent from package entry points. */
export async function forwardShellAttempt<T>(
  executionId: string | undefined,
  toolCallId: string,
  execute: (options: { toolCallId: string; messages: never[] }) => Promise<T>,
): Promise<T> {
  // Object spread/Object.assign preserve this opaque token; the ID stays in the private map.
  const token = {};
  const options = { toolCallId, messages: [], [forwardedAttemptToken]: token };
  if (executionId !== undefined) forwardedExecutionIds.set(token, executionId);
  try {
    return await execute(options);
  } finally {
    forwardedExecutionIds.delete(token);
  }
}

function takeExecutionId(options: unknown): string {
  if (isObject(options)) {
    const token = (options as { [forwardedAttemptToken]?: unknown })[forwardedAttemptToken];
    if (isObject(token)) {
      const forwarded = forwardedExecutionIds.get(token);
      // A token can forward an identity only once, even across copies of its options.
      forwardedExecutionIds.delete(token);
      if (forwarded !== undefined) return forwarded;
    }
  }
  return createEventId();
}

export type CreateShellRuntimeOptions = {
  workspace: HarnessWorkspaceSpec;
  /**
   * Runs one shell command in the execution environment. Implementations own cwd/env
   * persistence across calls (in-process just-bash keeps a live interpreter; a subprocess
   * environment keeps them in the child). Failures must be reported as a result with a
   * non-zero exitCode and the message in stderr — never thrown — so the model sees the
   * same tool-result shape from every adapter.
   */
  execute(input: ShellCommandInput, context: { toolCallId: string; executionId: string }): Promise<ShellCommandResult>;
  toolBridge?: RuntimeToolBridge | undefined;
  runtime?: HarnessRuntimeOptions | undefined;
  /** More lines for the system prompt about this environment, after the workspace's own. */
  hints?: readonly string[] | undefined;
  emit?: ((event: HarnessEventInput) => Promise<HarnessEvent | void>) | undefined;
  emitToolEvents?: boolean | undefined;
  /** Defaults to the harness's standard trace configuration when omitted. */
  traceOptions?: ResolvedHarnessTraceOptions | undefined;
  files: FileWriter;
  dispose?: (() => Promise<void>) | undefined;
  /**
   * The tier this environment is, for the turn's `harness.runtime.usage` event. The just-bash
   * adapters are `"tier-0"`; anything else is a real execution environment, the default.
   */
  tier?: HarnessExecutionTier | undefined;
  /** Where commands run, for the usage event's `sandbox.provider` (default `"unknown"`). */
  provider?: string | undefined;
  /**
   * The adapter's own account of what the turn used, when it has one (a remote sandbox that
   * knows its instance shape and awake time). Without it, or when it returns nothing, the
   * runtime reports `provider` and the active time it measured around each command.
   */
  usage?: (() => HarnessSandboxUsage | undefined) | undefined;
};

/**
 * Builds a HarnessSandbox (system hints + the `bash` shell tool) around any command
 * executor. All observable behavior — harness.runtime.command.* events, tool-call events,
 * workspace file-change events — lives here once, so in-process, subprocess, and remote
 * execution environments emit identical traces.
 * Tier tool wrappers must preserve all execute-option keys (including symbols), either
 * by passing options through or shallow-copying them with spread/Object.assign. Rebuilding
 * only named fields or serializing options drops the private one-use correlation token.
 */
export function createShellRuntime(options: CreateShellRuntimeOptions): HarnessSandbox {
  const { workspace, toolBridge } = options;
  const traceOptions = options.traceOptions ?? resolveTraceOptions(undefined, undefined);
  const tier: HarnessExecutionTier = options.tier ?? "next-tier";
  // What the turn used, measured here so every adapter reports it the same way.
  let commands = 0;
  let activeMs = 0;

  return {
    systemHints(hintOptions?: HarnessSandboxSystemHintsOptions) {
      const advertiseToolBridge =
        toolBridge !== undefined &&
        options.runtime?.bash !== false &&
        (hintOptions?.activeTools === undefined || hintOptions.activeTools.includes("bash"));
      const hints = [...workspaceHints(workspace), ...(options.hints ?? [])];
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
          const executionId = takeExecutionId(executeOptions);
          const toolCallId =
            isObject(executeOptions) && typeof executeOptions.toolCallId === "string" && executeOptions.toolCallId.length > 0
              ? executeOptions.toolCallId
              : "runtime_bash"; // Keep the historical direct-call tool-bridge replay scope stable.
          const before = options.emit ? await snapshotTrackedMounts(workspace) : undefined;
          await options.emit?.({
            type: "harness.runtime.command.started",
            occurrenceId: executionId,
            metadata: { ...input, toolCallId, executionId },
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
          const result = await options.execute(input, { toolCallId, executionId });
          const output: ShellCommandResult = {
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.exitCode,
          };
          const durationMs = Date.now() - startedAt;
          commands += 1;
          activeMs += durationMs;
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
            occurrenceId: executionId,
            metadata: {
              command,
              toolCallId,
              executionId,
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
    usage() {
      return options.usage?.() ?? { provider: options.provider ?? "unknown", activeMs };
    },
    tiering(): HarnessSandboxTiering {
      return {
        tier,
        commands: tier === "tier-0" ? { tier0: commands, nextTier: 0, denied: 0 } : { tier0: 0, nextTier: commands, denied: 0 },
        escalations: 0,
      };
    },
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
 * Snapshot every `trackChanges` mount's backing directory (or folder, when the workspace
 * lives in a just-bash filesystem).
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
    snapshot[trackedRootLabel(mount)] =
      workspace.filesystem === undefined
        ? await snapshotFolder(mount.backingPath)
        : await snapshotFs(workspace.filesystem, mount.backingPath);
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
      const harnessPath = trackedHarnessPath(root, file);
      for (const event of createHarnessFileMutationEvents({
        occurrenceId: createEventId(),
        kind: "deleted",
        file: { path: harnessPath },
        source: "tool",
        before: binaryMetadata(beforeSnapshot[file]!),
        diff: { available: false, reason: "content_unavailable" },
      })) await emit(event);
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
  const after = binaryMetadata(content);
  const diff = redactionReasonForPath(harnessPath, traceOptions)
    ? { available: false as const, reason: "redacted" as const }
    : await createTraceDiff(before, content, traceOptions, { files, path: harnessPath });
  const artifact = root === "artifacts"
    ? {
          id: harnessPath,
          path: harnessPath,
          bytes: content.byteLength,
          sha256: sha256Hex(content),
      }
    : undefined;
  for (const event of createHarnessFileMutationEvents({
    occurrenceId: createEventId(),
    kind: type === "harness.file.created" ? "created" : "updated",
    file: { path: harnessPath, bytes: after.bytes, sha256: after.sha256 },
    source: "tool",
    ...(before === undefined ? {} : { before: binaryMetadata(before) }),
    after,
    diff,
    ...(artifact === undefined ? {} : { artifact }),
  })) await emit(event);
}

function binaryMetadata(content: Uint8Array): { bytes: number; sha256: string } {
  return { bytes: content.byteLength, sha256: sha256Hex(content) };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
