import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { HarnessInputError } from "../../errors.js";
import { createEnvironmentToolBridge } from "../../runtime/just-bash-runtime.js";
import { createShellRuntime, type ShellCommandInput, type ShellCommandResult } from "../../runtime/shell-runtime.js";
import type { RuntimeToolBridge } from "../../runtime/tool-bridge.js";
import { resolveTraceOptions } from "../../trace/options.js";
import type {
  CreateExecutionEnvironmentOptions,
  HarnessExecutionEnvironmentFactory,
  HarnessRuntime,
  JsonObject,
} from "../../types.js";
import {
  serializeWorkspace,
  type ParentToWorkerMessage,
  type WorkerToParentMessage,
} from "./protocol.js";

export type SubprocessSandboxOptions = {
  /** Node executable for the worker. Defaults to the current process's executable. */
  nodePath?: string;
  /** Path to the compiled worker module. Defaults to the worker shipped with this package. */
  workerPath?: string;
  /**
   * Environment variables for the worker process. Replaces (never merges with) the parent
   * environment: the default is an empty environment so the parent's credentials (API keys,
   * tokens) never reach the sandbox process.
   */
  env?: Record<string, string>;
  /**
   * Extra time past a command's `timeoutMs` before the parent declares the worker
   * unresponsive and SIGKILLs it. The in-worker timeout is authoritative; this deadline
   * only fires when the worker's event loop is wedged and cannot enforce it.
   */
  watchdogGraceMs?: number;
  /**
   * Deadline for the worker to acknowledge init (`ready`) after spawn; defaults to
   * 30 000 ms. A worker that hangs during init is SIGKILLed so the command fails and the
   * next one respawns instead of blocking forever.
   */
  initTimeoutMs?: number;
};

/**
 * An execution-environment factory that runs just-bash in a child process — the
 * managed-agents "hands". The parent keeps sessions, tools, credentials, event emission,
 * and file-change tracking; the child only executes commands over the shared workspace
 * mounts and proxies js-exec tool calls back over stdio. The worker is spawned lazily on
 * the first command, so turns that never execute code never pay for a process.
 */
export function subprocessSandbox(
  sandboxOptions: SubprocessSandboxOptions = {},
): HarnessExecutionEnvironmentFactory {
  return async (options) => {
    const traceOptions = options.traceOptions ?? resolveTraceOptions(undefined, undefined);
    // Tool-call scope must come from the exec actually running in the worker, not from
    // whichever shell tool call last started: the AI SDK executes a step's tool calls
    // concurrently, while worker execs are strictly serial. The client owns attribution.
    let toolBridge: RuntimeToolBridge | undefined;
    const worker = new SubprocessWorkerClient(sandboxOptions, options, () => toolBridge);
    toolBridge = createEnvironmentToolBridge(
      options,
      traceOptions,
      (): JsonObject | undefined =>
        worker.activeParentToolCallId === undefined
          ? undefined
          : { parentToolCallId: worker.activeParentToolCallId },
    );

    const runtime: HarnessRuntime = createShellRuntime({
      workspace: options.workspace,
      toolBridge,
      runtime: options.runtime,
      emit: options.emit,
      emitToolEvents: options.emitToolEvents,
      traceOptions,
      files: options.files,
      execute: (input, context) => worker.exec(input, context.toolCallId),
      dispose: () => worker.dispose(),
    });
    return Object.assign(runtime, {
      /** Test-only introspection of the live worker (spawns one if needed). */
      __subprocessDiagnostics: () => worker.diagnostics(),
    });
  };
}

export function resolveSubprocessWorkerPath(explicit?: string): string {
  if (explicit !== undefined) {
    if (!existsSync(explicit)) {
      throw new HarnessInputError("Subprocess sandbox worker module not found.", {
        workerPath: explicit,
      });
    }
    return explicit;
  }
  const moduleWorkerPath = fileURLToPath(new URL("./worker.js", import.meta.url));
  // Running from TypeScript sources (tests): swap the package's OWN src segment for dist.
  // Anchored to the module tail so a repo checked out under some other src/ directory
  // cannot match first.
  const srcTail = join("src", "sandbox", "subprocess", "worker.js");
  const distTail = join("dist", "sandbox", "subprocess", "worker.js");
  const candidates = [moduleWorkerPath];
  if (moduleWorkerPath.endsWith(srcTail)) {
    candidates.push(
      `${moduleWorkerPath.slice(0, moduleWorkerPath.length - srcTail.length)}${distTail}`,
    );
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new HarnessInputError(
    "Subprocess sandbox worker module not found; build little-harness (pnpm build) first. " +
      "Bundlers do not include the worker automatically — bundled consumers must pass " +
      "subprocessSandbox({ workerPath }) pointing at the worker module.",
    { candidates },
  );
}

const DEFAULT_WATCHDOG_GRACE_MS = 5000;
const DEFAULT_INIT_TIMEOUT_MS = 30_000;

type PendingExec = {
  settle(result: ShellCommandResult): void;
};

type PendingDiag = {
  resolve(result: { pid: number; envKeys: readonly string[] }): void;
  reject(error: Error): void;
};

class SubprocessWorkerClient {
  private child: ChildProcessWithoutNullStreams | undefined;
  private ready: Promise<void> | undefined;
  private nextMessageId = 0;
  private pendingExecs = new Map<number, PendingExec>();
  private pendingDiags = new Map<number, PendingDiag>();
  private resolveReady: (() => void) | undefined;
  private rejectReady: ((error: Error) => void) | undefined;
  private execChain: Promise<unknown> = Promise.resolve();
  private stderrTail = "";
  private disposed = false;
  private initTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * The parent tool-call id of the exec currently running in the worker. Execs are strictly
   * serial, so the in-flight exec owns tool-call attribution until it settles.
   */
  private inFlightParentToolCallId: string | undefined;

  constructor(
    private readonly sandboxOptions: SubprocessSandboxOptions,
    private readonly environmentOptions: CreateExecutionEnvironmentOptions<unknown>,
    private readonly getToolBridge: () => RuntimeToolBridge | undefined,
  ) {}

  get activeParentToolCallId(): string | undefined {
    return this.inFlightParentToolCallId;
  }

  async exec(input: ShellCommandInput, parentToolCallId?: string): Promise<ShellCommandResult> {
    const run = this.execChain.then(() => this.execNow(input, parentToolCallId));
    this.execChain = run.catch(() => undefined);
    return run;
  }

  async diagnostics(): Promise<{ pid: number; envKeys: readonly string[] }> {
    await this.ensureStarted();
    if (this.child === undefined) {
      throw new Error("Sandbox worker exited before diagnostics could be sent.");
    }
    const id = this.allocateMessageId();
    return new Promise((resolve, reject) => {
      this.pendingDiags.set(id, { resolve, reject });
      this.send({ type: "diag", id });
    });
  }

  private async execNow(
    input: ShellCommandInput,
    parentToolCallId: string | undefined,
  ): Promise<ShellCommandResult> {
    try {
      await this.ensureStarted();
    } catch (error) {
      return failureResult(error);
    }
    const child = this.child;
    if (child === undefined) {
      return failureResult(new Error("Sandbox worker exited before the command could be sent."));
    }
    const id = this.allocateMessageId();
    const message: ParentToWorkerMessage = {
      type: "exec",
      id,
      command: input.command,
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    };
    this.inFlightParentToolCallId = parentToolCallId;
    try {
      return await new Promise<ShellCommandResult>((resolve) => {
        let watchdog: ReturnType<typeof setTimeout> | undefined;
        this.pendingExecs.set(id, {
          settle: (result) => {
            if (watchdog !== undefined) {
              clearTimeout(watchdog);
            }
            resolve(result);
          },
        });
        if (input.timeoutMs !== undefined) {
          // The worker enforces timeoutMs itself; this parent-side deadline only fires when
          // the worker's event loop is wedged (e.g. synchronous guest code) and the in-worker
          // timer can never run. Kill it so the next command respawns a fresh worker.
          const graceMs = this.sandboxOptions.watchdogGraceMs ?? DEFAULT_WATCHDOG_GRACE_MS;
          watchdog = setTimeout(() => {
            const pending = this.pendingExecs.get(id);
            if (pending === undefined) {
              return;
            }
            this.pendingExecs.delete(id);
            if (this.child === child) {
              this.child = undefined;
              this.ready = undefined;
              // The killed worker's exit handler skips recovery once ownership is reset,
              // so settle every other pending call (diagnostics, stray execs) here.
              this.failAllPending("Sandbox worker was killed after becoming unresponsive.");
            }
            child.kill("SIGKILL");
            resolve({
              stdout: "",
              stderr: `Command timed out after ${input.timeoutMs}ms (sandbox worker unresponsive).`,
              exitCode: 124,
            });
          }, input.timeoutMs + graceMs);
          watchdog.unref?.();
        }
        this.send(message);
      });
    } finally {
      this.inFlightParentToolCallId = undefined;
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const child = this.child;
    this.child = undefined;
    this.ready = undefined;
    if (child === undefined || child.exitCode !== null || child.signalCode !== null) {
      // Never spawned, or already exited — waiting for an 'exit' event would hang forever.
      this.failAllPending("Sandbox worker was disposed.");
      return;
    }
    await new Promise<void>((resolve) => {
      const finish = () => resolve();
      child.once("exit", finish);
      child.stdin.end();
      const killTimer = setTimeout(() => {
        child.kill("SIGKILL");
      }, 2000);
      killTimer.unref?.();
      child.once("exit", () => clearTimeout(killTimer));
    });
    this.failAllPending("Sandbox worker was disposed.");
  }

  private async ensureStarted(): Promise<void> {
    if (this.disposed) {
      throw new Error("Sandbox worker was disposed.");
    }
    if (this.ready !== undefined) {
      return this.ready;
    }

    const workerPath = resolveSubprocessWorkerPath(this.sandboxOptions.workerPath);
    const child = spawn(this.sandboxOptions.nodePath ?? process.execPath, [workerPath], {
      // Empty env by default: the sandbox process must never inherit parent credentials.
      env: this.sandboxOptions.env ?? {},
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    // A write racing a worker death lands on a closed pipe; without a listener the EPIPE
    // 'error' event would crash the host process. The 'exit' handler below owns recovery.
    child.stdin.on("error", () => {});
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderrTail = `${this.stderrTail}${chunk}`.slice(-4000);
    });
    const onWorkerGone = (description: string) => {
      // Only the worker that currently owns the client state may reset it; a late exit
      // from an already-replaced or disposed worker must not fail the successor's calls.
      if (this.child !== child) {
        return;
      }
      // Reset so the next command spawns a fresh worker (re-reading the workspace's
      // read-only prefixes) instead of writing into a dead child's stdin forever.
      this.child = undefined;
      this.ready = undefined;
      this.failAllPending(description);
    };
    child.on("exit", () => {
      onWorkerGone(
        `Sandbox worker exited unexpectedly.${this.stderrTail ? ` stderr: ${this.stderrTail}` : ""}`,
      );
    });
    child.on("error", (error) => {
      onWorkerGone(`Sandbox worker failed to start: ${error.message}`);
    });
    const rl = createInterface({ input: child.stdout, terminal: false });
    rl.on("line", (line) => this.handleLine(child, line));

    const initId = this.allocateMessageId();
    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    // A worker that hangs during init (before ready) would otherwise block the first
    // command forever — the exec watchdog only arms after init completes.
    this.initTimer = setTimeout(() => {
      if (this.child !== child || this.resolveReady === undefined) {
        return;
      }
      this.child = undefined;
      this.ready = undefined;
      this.failAllPending(
        `Sandbox worker did not initialize within ${
          this.sandboxOptions.initTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS
        }ms.`,
      );
      child.kill("SIGKILL");
    }, this.sandboxOptions.initTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS);
    this.initTimer.unref?.();
    const initTimer = this.initTimer;
    child.once("exit", () => clearTimeout(initTimer));
    const abortSignal = this.environmentOptions.abortSignal;
    if (abortSignal !== undefined) {
      const onAbort = () => child.kill("SIGKILL");
      if (abortSignal.aborted) {
        onAbort();
      } else {
        abortSignal.addEventListener("abort", onAbort, { once: true });
        child.once("exit", () => abortSignal.removeEventListener("abort", onAbort));
      }
    }
    this.send({
      type: "init",
      id: initId,
      workspace: serializeWorkspace(this.environmentOptions.workspace),
      runtime: {
        ...(this.environmentOptions.runtime?.python === undefined
          ? {}
          : { python: this.environmentOptions.runtime.python }),
        ...(this.environmentOptions.runtime?.javascript === undefined
          ? {}
          : { javascript: this.environmentOptions.runtime.javascript }),
        ...(this.environmentOptions.runtime?.network === undefined
          ? {}
          : { network: this.environmentOptions.runtime.network }),
      },
      mounts: this.environmentOptions.mounts ?? [],
      toolBridge: this.getToolBridge() !== undefined,
    });
    return this.ready;
  }

  private handleLine(child: ChildProcessWithoutNullStreams, line: string): void {
    if (this.child !== child) {
      // A replaced or disposed worker's buffered output must not touch the successor's
      // state; its pending calls were already settled when the worker was retired.
      return;
    }
    if (line.trim().length === 0) {
      return;
    }
    let message: WorkerToParentMessage;
    try {
      message = JSON.parse(line) as WorkerToParentMessage;
    } catch {
      return;
    }
    if (message.type === "ready") {
      if (this.initTimer !== undefined) {
        clearTimeout(this.initTimer);
        this.initTimer = undefined;
      }
      this.resolveReady?.();
      this.resolveReady = undefined;
      this.rejectReady = undefined;
      return;
    }
    if (message.type === "exec_result") {
      const pending = this.pendingExecs.get(message.id);
      if (pending !== undefined) {
        this.pendingExecs.delete(message.id);
        pending.settle({
          stdout: message.stdout,
          stderr: message.stderr,
          exitCode: message.exitCode,
        });
      }
      return;
    }
    if (message.type === "tool_call") {
      void this.handleToolCall(child, message.id, message.path, message.argsJson);
      return;
    }
    if (message.type === "diag_result") {
      const pending = this.pendingDiags.get(message.id);
      if (pending !== undefined) {
        this.pendingDiags.delete(message.id);
        pending.resolve({ pid: message.pid, envKeys: message.envKeys });
      }
      return;
    }
    if (message.type === "fatal") {
      // A worker-reported error (e.g. an init failure) leaves the child alive but useless;
      // retire it so the next command respawns instead of reusing a wedged ready promise.
      this.child = undefined;
      this.ready = undefined;
      this.failAllPending(`Sandbox worker error: ${message.message}`);
      child.kill("SIGKILL");
    }
  }

  private async handleToolCall(
    child: ChildProcessWithoutNullStreams,
    id: number,
    path: string,
    argsJson: string,
  ): Promise<void> {
    // Replies must go only to the worker that asked: a respawned successor restarts its
    // tool-call ids at 1, so a late result from a retired worker's invocation would
    // otherwise be delivered to the wrong call.
    const sendToOwner = (message: ParentToWorkerMessage) => {
      if (this.child === child) {
        this.send(message);
      }
    };
    const toolBridge = this.getToolBridge();
    if (toolBridge === undefined) {
      sendToOwner({ type: "tool_result", id, ok: false, message: "Runtime tools are not available." });
      return;
    }
    try {
      const resultJson = await toolBridge.invokeTool(path, argsJson);
      sendToOwner({ type: "tool_result", id, ok: true, resultJson });
    } catch (error) {
      sendToOwner({
        type: "tool_result",
        id,
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private failAllPending(message: string): void {
    const error = new Error(message);
    const rejectReady = this.rejectReady;
    this.rejectReady = undefined;
    this.resolveReady = undefined;
    rejectReady?.(error);
    for (const [id, pending] of this.pendingExecs) {
      this.pendingExecs.delete(id);
      pending.settle(failureResult(error));
    }
    for (const [id, pending] of this.pendingDiags) {
      this.pendingDiags.delete(id);
      pending.reject(error);
    }
  }

  private send(message: ParentToWorkerMessage): void {
    this.child?.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private allocateMessageId(): number {
    this.nextMessageId += 1;
    return this.nextMessageId;
  }
}

function failureResult(error: unknown): ShellCommandResult {
  return {
    stdout: "",
    stderr: error instanceof Error ? error.message : String(error),
    exitCode: 1,
  };
}
