import { AsyncLocalStorage } from "node:async_hooks";
import { copyFile, cp, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { Bash, MountableFs, type BashOptions, type ExecOptions, type IFileSystem } from "just-bash";
import type {
  BashExecResult,
  BufferEncoding,
  CpOptions,
  ByteString,
  FileContent as BashFileContent,
  FsStat,
  MkdirOptions,
  RmOptions,
} from "just-bash";
import * as path from "node:path";
import { HarnessInputError } from "../errors.js";
import { snapshotFolder } from "../files/diff.js";
import { normalizeHarnessPrefix } from "../files/path-policy.js";
import { resolveTraceOptions } from "../trace/options.js";
import type { ResolvedHarnessTraceOptions } from "../trace/types.js";
import type {
  CreateSandboxOptions,
  HarnessSandboxFactory,
  HarnessSandbox,
  HarnessRuntimeMount,
  HarnessRuntimeOptions,
  HarnessWorkspaceMount,
  HarnessWorkspaceSpec,
  JsonObject,
} from "../types.js";
import { createShellRuntime } from "./shell-runtime.js";
import { createRuntimeToolBridge, type RuntimeToolBridge } from "./tool-bridge.js";
import { hasJustBashNodeBuild, justBashNodeExport } from "./just-bash-builds.js";
import { SubtreeFs } from "./subtree-fs.js";

type DirentEntry = Awaited<ReturnType<NonNullable<IFileSystem["readdirWithFileTypes"]>>>[number];
type ReadFileOption = Parameters<IFileSystem["readFile"]>[1];
type WriteFileOption = Parameters<IFileSystem["writeFile"]>[2];
type RuntimeShellInput = { command: string; cwd?: string; timeoutMs?: number };
type RuntimeShellExecutionInput = RuntimeShellInput & { cwd: string; env: Record<string, string> };

/**
 * Assembles the just-bash virtual filesystem for a workspace spec: canonical mounts (with
 * the /.agents overlay inside /session), read-only policy wrapping, /.agents runtime-mount
 * materialization, and runtime descriptor mounts. Shared by the in-process runtime and the
 * subprocess sandbox worker.
 */
export async function buildWorkspaceFs(
  workspace: HarnessWorkspaceSpec,
  runtimeDescriptorMounts: readonly HarnessRuntimeMount[],
): Promise<MountableFs> {
  const workspaceMounts = new Map<string, HarnessWorkspaceMount>();
  for (const mount of workspace.mounts) {
    workspaceMounts.set(trimTrailingSlash(mount.mountPath), mount);
  }
  // A mount's backingPath is a directory on disk, or a folder of the workspace's own
  // filesystem when the host keeps the workspace in one (virtualHost).
  const open = (backingPath: string): IFileSystem =>
    workspace.filesystem === undefined ? diskFs(backingPath) : new SubtreeFs(workspace.filesystem, backingPath);
  const agentsMount = workspaceMounts.get("/.agents");
  const agentsFs = agentsMount
    ? new PolicyFs(open(agentsMount.backingPath), {
        mountPoint: "/.agents",
        readOnly: true,
      })
    : undefined;

  const fs = new WorkspaceFs({ base: new UnmanagedRootFs() });
  for (const [mountPath, mount] of workspaceMounts) {
    if (mountPath === "/.agents") {
      continue;
    }
    // /.agents stays visible inside /session (read-only) so relative skill paths resolve
    // from the default working directory.
    const base: IFileSystem =
      mountPath === "/session" && agentsFs !== undefined
        ? new SessionFs(open(mount.backingPath), agentsFs)
        : open(mount.backingPath);
    if (mount.mode === "ro" || mount.getReadOnlyPrefixes !== undefined) {
      fs.mount(
        mountPath,
        new PolicyFs(base, {
          mountPoint: mountPath,
          ...(mount.mode === "ro" ? { readOnly: true } : {}),
          ...(mount.getReadOnlyPrefixes === undefined
            ? {}
            : { getReadOnlyPrefixes: mount.getReadOnlyPrefixes }),
        }),
      );
      continue;
    }
    fs.mount(mountPath, base);
  }
  if (agentsFs !== undefined) {
    fs.mount("/.agents", agentsFs);
  }
  const runtimeMounts = agentsMount
    ? workspace.filesystem === undefined
      ? await materializeAgentsRuntimeMounts(agentsMount.backingPath, runtimeDescriptorMounts)
      : await copyAgentsRuntimeMounts(workspace.filesystem, agentsMount.backingPath, runtimeDescriptorMounts)
    : runtimeDescriptorMounts;
  await mountRuntimeDescriptors(fs, runtimeMounts);
  return fs;
}

/**
 * Which just-bash adapter the Bash options are being built for. The two adapters differ in
 * exactly one hardening decision — see `defenseInDepthForAdapter`.
 */
export type JustBashAdapter = "in-process" | "subprocess";

/**
 * The Tier-0 hardening rule, in one place so the two adapters cannot drift apart.
 *
 * just-bash defaults `defenseInDepth` to ON, so the in-process `false` below is a deliberate
 * opt-out. That layer patches PROCESS-WIDE globals for the duration of a command
 * (`globalThis.performance`, `process.env`, `process.exit`, `Function`, `eval`, …) and gates
 * them on an AsyncLocalStorage context. Host code that runs inside an async context inherited
 * from the command therefore hits the patches too: a host AsyncHook touching
 * `globalThis.performance.now()` throws a SecurityViolationError, and Node's own fatal-error
 * path then calls the equally-blocked `process.exit`, killing the embedding process. The
 * `freeze` strategy on `JSON`/`Math` is also irreversible — restoring the patches cannot
 * unfreeze them. None of that can reach anyone from a dedicated worker process.
 *
 * The hardening a caller loses in-process is bought back by routing to the subprocess
 * adapter instead — see the `"auto"` execution-environment mode on `localHost`.
 */
export function defenseInDepthForAdapter(adapter: JustBashAdapter): boolean {
  return adapter === "subprocess";
}

/** Maps the neutral runtime toggles onto just-bash Bash options. */
export function bashOptionsForRuntime(
  fs: MountableFs,
  workingDir: string,
  runtime: HarnessRuntimeOptions | undefined,
  extras: { javascript: NonNullable<BashOptions["javascript"]>; defenseInDepth: boolean },
): BashOptions {
  const bashOptions: BashOptions = {
    fs,
    cwd: workingDir,
    python: runtime?.python ?? true,
    javascript: extras.javascript,
    defenseInDepth: extras.defenseInDepth,
  };
  if (runtime?.network === true) {
    bashOptions.network = { dangerouslyAllowFullInternetAccess: true };
  } else if (typeof runtime?.network === "object") {
    bashOptions.network = runtime.network;
  }
  return bashOptions;
}

/** What the prompt says on just-bash's browser build, which cannot run these commands. */
const BROWSER_BUILD_HINT = "python3, node (js-exec), sqlite3, tar, yq and xan are not available in this shell.";

/**
 * The in-process just-bash sandbox: Tier-0 just-bash embedded in the host process. Fast (no
 * process spawn) but a compatibility layer for trusted tool patterns, not an isolation boundary;
 * prefer `subprocessSandbox()` (or `localHost()`'s `"auto"` default) for untrusted commands.
 *
 * Like every sandbox builder it is always called and returns the per-turn factory:
 * `localHost({ sandbox: justBashSandbox() })`, `tieredSandbox({ tier0: justBashSandbox() })`.
 */
export function justBashSandbox<TExtraBody = unknown>(): HarnessSandboxFactory<TExtraBody> {
  return startJustBashSandbox;
}

async function startJustBashSandbox(
  options: CreateSandboxOptions<any>,
): Promise<HarnessSandbox> {
  const workspace = options.workspace;
  const fs = await buildWorkspaceFs(workspace, options.mounts ?? []);

  // just-bash's browser build (workerd, browsers) has no Python or JavaScript runner, and no
  // sqlite3, tar, yq or xan. Switch the runners off instead of offering commands that fail,
  // and tell the model.
  const nodeBuild = hasJustBashNodeBuild();
  const runtime: HarnessRuntimeOptions | undefined = nodeBuild
    ? options.runtime
    : { ...options.runtime, python: false, javascript: false };
  const traceOptions = options.traceOptions ?? resolveTraceOptions(undefined, undefined);
  const toolBridgeScope = new AsyncLocalStorage<JsonObject>();
  const toolBridge = createEnvironmentToolBridge(
    runtime === undefined ? options : { ...options, runtime },
    traceOptions,
    () => toolBridgeScope.getStore(),
  );
  const bash = new Bash(bashOptionsForRuntime(fs, workspace.workingDir, runtime, {
    javascript: javascriptConfig(runtime?.javascript, toolBridge),
    defenseInDepth: defenseInDepthForAdapter("in-process"),
  }));
  let currentCwd = workspace.workingDir;
  let currentEnv = bash.getEnv();

  return createShellRuntime({
    workspace,
    toolBridge,
    runtime,
    ...(nodeBuild ? {} : { hints: [BROWSER_BUILD_HINT] }),
    emit: options.emit,
    emitToolEvents: options.emitToolEvents,
    traceOptions,
    files: options.files,
    tier: "tier-0",
    provider: "just-bash",
    async execute(input, context) {
      const executionInput: RuntimeShellExecutionInput = {
        ...input,
        cwd: input.cwd ?? currentCwd,
        env: currentEnv,
      };
      const result = await toolBridgeScope.run(
        { parentToolCallId: context.toolCallId },
        () => execBashSafely(bash, executionInput, options.abortSignal),
      );
      currentEnv = result.env;
      currentCwd = result.env.PWD ?? executionInput.cwd;
      return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
    },
  });
}

/**
 * Builds the sandbox-facing tool proxy from execution-environment options, applying the
 * shared gating rules (no tools / javascript disabled / bridge disabled → no proxy).
 * Shared by every execution-environment adapter so tool exposure cannot drift.
 */
export function createEnvironmentToolBridge<TExtraBody>(
  options: CreateSandboxOptions<TExtraBody>,
  traceOptions: ResolvedHarnessTraceOptions,
  runtimeScope: () => JsonObject | undefined,
): RuntimeToolBridge | undefined {
  if (
    options.tools === undefined ||
    options.runtime?.javascript === false ||
    options.runtime?.toolBridge === false
  ) {
    return undefined;
  }
  if (options.toolContext === undefined) {
    throw new HarnessInputError(
      "toolContext is required when tools are provided to an execution environment.",
    );
  }
  return createRuntimeToolBridge({
    tools: options.tools,
    toolContext: options.toolContext,
    ...(options.runtimeToolReplay === undefined ? {} : { runtimeToolReplay: options.runtimeToolReplay }),
    ...(options.emit === undefined ? {} : { emit: options.emit }),
    files: options.files,
    traceOptions,
    runtimeScope,
    ...(options.abortSignal === undefined ? {} : { abortSignal: options.abortSignal }),
  });
}

function javascriptConfig(
  enabled: boolean | undefined,
  toolBridge: RuntimeToolBridge | undefined,
): NonNullable<BashOptions["javascript"]> {
  if (enabled === false) {
    return false;
  }
  if (toolBridge === undefined) {
    return enabled ?? true;
  }

  return {
    invokeTool: toolBridge.invokeTool,
  };
}

export async function execBashSafely(
  bash: Bash,
  input: RuntimeShellExecutionInput,
  signal: AbortSignal | undefined,
): Promise<BashExecResult> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let timeoutController: AbortController | undefined;
  let removeAbortListener: (() => void) | undefined;
  let timeoutPromise: Promise<never> | undefined;
  let timedOut = false;

  try {
    const execOptions: ExecOptions = { cwd: input.cwd, env: input.env };
    if (input.timeoutMs !== undefined) {
      timeoutController = new AbortController();
      if (signal?.aborted) {
        timeoutController.abort(signal.reason);
      } else if (signal !== undefined) {
        const onAbort = () => timeoutController?.abort(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = () => signal.removeEventListener("abort", onAbort);
      }
      timeoutPromise = new Promise((_, reject) => {
        timeout = setTimeout(() => {
          timedOut = true;
          const error = new Error(`Command timed out after ${input.timeoutMs}ms`);
          timeoutController?.abort(error);
          reject(error);
        }, input.timeoutMs);
      });
      execOptions.signal = timeoutController.signal;
    } else if (signal !== undefined) {
      execOptions.signal = signal;
    }

    const execution = bash.exec(input.command, execOptions);
    return await (timeoutPromise === undefined ? execution : Promise.race([execution, timeoutPromise]));
  } catch (error) {
    return {
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      exitCode: timedOut ? 124 : 1,
      env: input.env,
    };
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
    removeAbortListener?.();
  }
}

async function mountRuntimeDescriptors(
  fs: MountableFs,
  mounts: readonly HarnessRuntimeMount[],
): Promise<void> {
  for (const mount of await expandRuntimeMounts(mounts)) {
    const resolved = await resolveRuntimeMount(mount);
    const delegate =
      resolved.kind === "file"
        ? new SingleFileFs(diskFs(resolved.rootDir), resolved.fileName)
        : diskFs(resolved.rootDir);

    fs.mount(
      resolved.mountAt,
      mount.mode === "rw"
        ? delegate
        : new PolicyFs(delegate, {
            mountPoint: resolved.mountAt,
            readOnly: true,
          }),
    );
  }
}

/** just-bash's disk filesystem over `root`; only the Node build has one. */
function diskFs(root: string): IFileSystem {
  const ReadWriteFs = justBashNodeExport("ReadWriteFs");
  if (ReadWriteFs === undefined) {
    throw new HarnessInputError(
      "A workspace on disk needs Node: this runtime loaded just-bash's browser build, which has no disk filesystem. Keep the workspace in a just-bash filesystem with virtualHost() instead.",
      { root },
    );
  }
  return new ReadWriteFs({ root });
}

/**
 * The workspace-filesystem twin of {@link materializeAgentsRuntimeMounts}: copies each
 * `/.agents/...` runtime mount from disk into the workspace's /.agents folder.
 */
async function copyAgentsRuntimeMounts(
  filesystem: IFileSystem,
  agentsRoot: string,
  mounts: readonly HarnessRuntimeMount[],
): Promise<readonly HarnessRuntimeMount[]> {
  const remaining: HarnessRuntimeMount[] = [];
  for (const mount of mounts) {
    const relativeAgentsPath = relativeAgentsMountPath(mount.mountPath);
    if (relativeAgentsPath === undefined) {
      remaining.push(mount);
      continue;
    }
    const targetPath = path.posix.join(agentsRoot, relativeAgentsPath);
    const backingStat = await stat(mount.backingPath).catch(() => undefined);
    await filesystem.rm(targetPath, { recursive: true, force: true });
    if (backingStat?.isFile() === true || (backingStat === undefined && !hasTrailingSlash(mount.mountPath))) {
      await filesystem.mkdir(path.posix.dirname(targetPath), { recursive: true });
      await filesystem.writeFile(targetPath, await readFile(mount.backingPath));
      continue;
    }
    await filesystem.mkdir(targetPath, { recursive: true });
    for (const [file, content] of Object.entries(await snapshotFolder(mount.backingPath))) {
      const filePath = path.posix.join(targetPath, file);
      await filesystem.mkdir(path.posix.dirname(filePath), { recursive: true });
      await filesystem.writeFile(filePath, content);
    }
  }
  return remaining;
}

async function materializeAgentsRuntimeMounts(
  agentsDir: string,
  mounts: readonly HarnessRuntimeMount[],
): Promise<readonly HarnessRuntimeMount[]> {
  const remaining: HarnessRuntimeMount[] = [];
  for (const mount of mounts) {
    const relativeAgentsPath = relativeAgentsMountPath(mount.mountPath);
    if (relativeAgentsPath === undefined) {
      remaining.push(mount);
      continue;
    }
    const targetPath = path.join(agentsDir, relativeAgentsPath);
    const backingStat = await stat(mount.backingPath).catch(() => undefined);
    await rm(targetPath, { recursive: true, force: true });
    if (backingStat?.isFile() === true || (backingStat === undefined && !hasTrailingSlash(mount.mountPath))) {
      await mkdir(path.dirname(targetPath), { recursive: true });
      await copyFile(mount.backingPath, targetPath);
      continue;
    }
    await mkdir(path.dirname(targetPath), { recursive: true });
    await cp(mount.backingPath, targetPath, { recursive: true });
  }
  return remaining;
}

function relativeAgentsMountPath(mountPath: string): string | undefined {
  const normalized = path.posix.normalize(mountPath.startsWith("/") ? mountPath : `/${mountPath}`);
  const prefix = "/.agents/";
  if (!normalized.startsWith(prefix)) {
    return undefined;
  }
  return normalized.slice(prefix.length);
}

async function expandRuntimeMounts(
  mounts: readonly HarnessRuntimeMount[],
): Promise<readonly HarnessRuntimeMount[]> {
  const expanded: HarnessRuntimeMount[] = [];
  for (const mount of mounts) {
    if (isWildcardBackingPath(mount.backingPath)) {
      expanded.push(...await expandWildcardRuntimeMount(mount));
      continue;
    }
    expanded.push(mount);
  }
  return expanded;
}

async function expandWildcardRuntimeMount(
  mount: HarnessRuntimeMount,
): Promise<readonly HarnessRuntimeMount[]> {
  const wildcardIndex = mount.backingPath.indexOf("*");
  const prefix = mount.backingPath.slice(0, wildcardIndex);
  const suffix = mount.backingPath.slice(wildcardIndex + 1).replace(/^[/\\]+/u, "");
  const parent = trimTrailingHostSeparator(prefix);
  let entries: readonly string[] = [];
  try {
    entries = await readdir(parent);
  } catch {
    return [];
  }

  const expanded: HarnessRuntimeMount[] = [];
  for (const entry of [...entries].sort((left, right) => left.localeCompare(right))) {
    const backingPath = path.resolve(parent, entry, suffix);
    try {
      if (!(await stat(backingPath)).isDirectory()) {
        continue;
      }
    } catch {
      continue;
    }
    expanded.push({
      mountPath: `${trimTrailingSlash(mount.mountPath)}/${entry}`,
      backingPath,
      mode: mount.mode,
    });
  }
  return expanded;
}

function isWildcardBackingPath(backingPath: string): boolean {
  return backingPath.includes("*");
}

async function resolveRuntimeMount(
  mount: HarnessRuntimeMount,
): Promise<
  | { kind: "directory"; rootDir: string; mountAt: string }
  | { kind: "file"; rootDir: string; fileName: string; mountAt: string }
> {
  const backingStat = await stat(mount.backingPath).catch(() => undefined);
  const isFileMount = backingStat?.isFile() === true || (backingStat === undefined && !hasTrailingSlash(mount.mountPath));
  const mountAt = trimTrailingSlash(mount.mountPath);

  if (isFileMount) {
    const rootDir = path.dirname(mount.backingPath);
    await mkdir(rootDir, { recursive: true });
    return { kind: "file", rootDir, fileName: path.basename(mount.backingPath), mountAt };
  }

  await mkdir(mount.backingPath, { recursive: true });
  return { kind: "directory", rootDir: mount.backingPath, mountAt };
}

function hasTrailingSlash(value: string): boolean {
  return /\/+$/u.test(value) && trimTrailingSlash(value) !== "/";
}

function trimTrailingHostSeparator(value: string): string {
  const trimmed = value.replace(/[\\/]+$/u, "");
  return trimmed.length === 0 ? path.parse(path.resolve(value)).root : trimmed;
}

function trimTrailingSlash(value: string): string {
  const trimmed = value.replace(/\/+$/gu, "");
  return trimmed.length === 0 ? "/" : path.posix.normalize(trimmed);
}

class SingleFileFs implements IFileSystem {
  constructor(
    private readonly delegate: IFileSystem,
    private readonly fileName: string,
  ) {}

  readFile(pathname: string, options?: ReadFileOption | BufferEncoding): Promise<string> {
    return this.delegate.readFile(this.filePath(pathname), options);
  }

  readFileBytes(pathname: string): Promise<ByteString> {
    const readFileBytes = this.delegate.readFileBytes;
    if (!readFileBytes) {
      throw new Error("Mounted file delegate does not support byte reads.");
    }
    return readFileBytes.call(this.delegate, this.filePath(pathname));
  }

  readFileBuffer(pathname: string): Promise<Uint8Array> {
    return this.delegate.readFileBuffer(this.filePath(pathname));
  }

  writeFile(
    pathname: string,
    content: BashFileContent,
    options?: WriteFileOption | BufferEncoding,
  ): Promise<void> {
    return this.delegate.writeFile(this.filePath(pathname), content, options);
  }

  appendFile(
    pathname: string,
    content: BashFileContent,
    options?: WriteFileOption | BufferEncoding,
  ): Promise<void> {
    return this.delegate.appendFile(this.filePath(pathname), content, options);
  }

  async exists(pathname: string): Promise<boolean> {
    if (!isSingleFileRoot(pathname)) {
      return false;
    }
    return this.delegate.exists(this.delegatePath);
  }

  stat(pathname: string): Promise<FsStat> {
    return this.delegate.stat(this.filePath(pathname));
  }

  lstat(pathname: string): Promise<FsStat> {
    return this.delegate.lstat(this.filePath(pathname));
  }

  async mkdir(pathname: string): Promise<void> {
    throw notDirectory(pathname);
  }

  async readdir(pathname: string): Promise<string[]> {
    throw notDirectory(pathname);
  }

  async readdirWithFileTypes(pathname: string): Promise<DirentEntry[]> {
    throw notDirectory(pathname);
  }

  rm(pathname: string, options?: RmOptions): Promise<void> {
    return this.delegate.rm(this.filePath(pathname), options);
  }

  async cp(src: string, dest: string): Promise<void> {
    if (!isSingleFileRoot(src) || !isSingleFileRoot(dest)) {
      throw notFound(!isSingleFileRoot(src) ? src : dest);
    }
    await this.delegate.writeFile(this.delegatePath, await this.delegate.readFileBuffer(this.delegatePath));
  }

  async mv(src: string, dest: string): Promise<void> {
    if (!isSingleFileRoot(src) || !isSingleFileRoot(dest)) {
      throw notFound(!isSingleFileRoot(src) ? src : dest);
    }
  }

  resolvePath(base: string, pathname: string): string {
    return path.posix.resolve(base, pathname);
  }

  getAllPaths(): string[] {
    return ["/"];
  }

  chmod(pathname: string, mode: number): Promise<void> {
    return this.delegate.chmod(this.filePath(pathname), mode);
  }

  async symlink(_target: string, linkPath: string): Promise<void> {
    throw accessDenied(`Cannot create symlink in single-file mount: ${linkPath}`);
  }

  async link(existingPath: string, newPath: string): Promise<void> {
    if (!isSingleFileRoot(existingPath) || !isSingleFileRoot(newPath)) {
      throw notFound(!isSingleFileRoot(existingPath) ? existingPath : newPath);
    }
  }

  readlink(pathname: string): Promise<string> {
    return this.delegate.readlink(this.filePath(pathname));
  }

  realpath(pathname: string): Promise<string> {
    this.filePath(pathname);
    return Promise.resolve("/");
  }

  utimes(pathname: string, atime: Date, mtime: Date): Promise<void> {
    return this.delegate.utimes(this.filePath(pathname), atime, mtime);
  }

  private get delegatePath(): string {
    return `/${this.fileName}`;
  }

  private filePath(pathname: string): string {
    if (!isSingleFileRoot(pathname)) {
      throw notFound(pathname);
    }
    return this.delegatePath;
  }
}

function isSingleFileRoot(pathname: string): boolean {
  const normalized = path.posix.normalize(pathname.startsWith("/") ? pathname : `/${pathname}`);
  return normalized === "/";
}

class SessionFs implements IFileSystem {
  constructor(
    private readonly session: IFileSystem,
    private readonly agents: IFileSystem,
  ) {}

  readFile(pathname: string, options?: ReadFileOption | BufferEncoding): Promise<string> {
    const target = this.route(pathname);
    return target.fs.readFile(target.path, options);
  }

  readFileBuffer(pathname: string): Promise<Uint8Array> {
    const target = this.route(pathname);
    return target.fs.readFileBuffer(target.path);
  }

  writeFile(
    pathname: string,
    content: BashFileContent,
    options?: WriteFileOption | BufferEncoding,
  ): Promise<void> {
    const target = this.writableRoute(pathname);
    return target.fs.writeFile(target.path, content, options);
  }

  appendFile(
    pathname: string,
    content: BashFileContent,
    options?: WriteFileOption | BufferEncoding,
  ): Promise<void> {
    const target = this.writableRoute(pathname);
    return target.fs.appendFile(target.path, content, options);
  }

  exists(pathname: string): Promise<boolean> {
    const target = this.route(pathname);
    return target.fs.exists(target.path);
  }

  stat(pathname: string): Promise<FsStat> {
    const target = this.route(pathname);
    return target.fs.stat(target.path);
  }

  lstat(pathname: string): Promise<FsStat> {
    const target = this.route(pathname);
    return target.fs.lstat(target.path);
  }

  mkdir(pathname: string, options?: MkdirOptions): Promise<void> {
    const target = this.writableRoute(pathname);
    return target.fs.mkdir(target.path, options);
  }

  readdir(pathname: string): Promise<string[]> {
    const target = this.route(pathname);
    return target.fs.readdir(target.path);
  }

  readdirWithFileTypes(pathname: string): Promise<DirentEntry[]> {
    const target = this.route(pathname);
    if (!target.fs.readdirWithFileTypes) {
      return defaultReaddirWithFileTypes(target.fs, target.path);
    }
    return target.fs.readdirWithFileTypes(target.path);
  }

  rm(pathname: string, options?: RmOptions): Promise<void> {
    const target = this.writableRoute(pathname);
    return target.fs.rm(target.path, options);
  }

  async cp(src: string, dest: string, options?: CpOptions): Promise<void> {
    const source = this.route(src);
    const target = this.writableRoute(dest);
    if (source.fs === target.fs) {
      await source.fs.cp(source.path, target.path, options);
      return;
    }
    await target.fs.writeFile(target.path, await source.fs.readFileBuffer(source.path));
  }

  mv(src: string, dest: string): Promise<void> {
    const source = this.writableRoute(src);
    const target = this.writableRoute(dest);
    return source.fs.mv(source.path, target.path);
  }

  resolvePath(base: string, pathname: string): string {
    return path.posix.resolve(base, pathname);
  }

  getAllPaths(): string[] {
    return this.session.getAllPaths();
  }

  chmod(pathname: string, mode: number): Promise<void> {
    const target = this.writableRoute(pathname);
    return target.fs.chmod(target.path, mode);
  }

  symlink(target: string, linkPath: string): Promise<void> {
    const link = this.writableRoute(linkPath);
    return link.fs.symlink(target, link.path);
  }

  link(existingPath: string, newPath: string): Promise<void> {
    const existing = this.route(existingPath);
    const target = this.writableRoute(newPath);
    if (existing.fs !== target.fs) {
      throw accessDenied(`Cannot create hard link across session filesystems: ${newPath}`);
    }
    return existing.fs.link(existing.path, target.path);
  }

  readlink(pathname: string): Promise<string> {
    const target = this.route(pathname);
    return target.fs.readlink(target.path);
  }

  realpath(pathname: string): Promise<string> {
    const target = this.route(pathname);
    return target.fs.realpath(target.path);
  }

  utimes(pathname: string, atime: Date, mtime: Date): Promise<void> {
    const target = this.writableRoute(pathname);
    return target.fs.utimes(target.path, atime, mtime);
  }

  private writableRoute(pathname: string): { fs: IFileSystem; path: string } {
    const target = this.route(pathname);
    if (target.readOnly) {
      throw accessDenied("/session/.agents is read-only");
    }
    return target;
  }

  private route(pathname: string): { fs: IFileSystem; path: string; readOnly: boolean } {
    const normalized = path.posix.normalize(pathname.startsWith("/") ? pathname : `/${pathname}`);
    if (normalized === "/.agents") {
      return { fs: this.agents, path: "/", readOnly: true };
    }
    if (normalized.startsWith("/.agents/")) {
      return { fs: this.agents, path: normalized.slice("/.agents".length), readOnly: true };
    }
    return { fs: this.session, path: normalized, readOnly: false };
  }
}

type PolicyFsOptions = {
  mountPoint: string;
  readOnly?: boolean;
  getReadOnlyPrefixes?: () => readonly string[];
};

class PolicyFs implements IFileSystem {
  constructor(
    private readonly delegate: IFileSystem,
    private readonly options: PolicyFsOptions,
  ) {}

  readFile(pathname: string, options?: ReadFileOption | BufferEncoding): Promise<string> {
    return this.delegate.readFile(pathname, options);
  }

  readFileBuffer(pathname: string): Promise<Uint8Array> {
    return this.delegate.readFileBuffer(pathname);
  }

  writeFile(
    pathname: string,
    content: BashFileContent,
    options?: WriteFileOption | BufferEncoding,
  ): Promise<void> {
    this.assertWritable(pathname);
    return this.delegate.writeFile(pathname, content, options);
  }

  appendFile(
    pathname: string,
    content: BashFileContent,
    options?: WriteFileOption | BufferEncoding,
  ): Promise<void> {
    this.assertWritable(pathname);
    return this.delegate.appendFile(pathname, content, options);
  }

  exists(pathname: string): Promise<boolean> {
    return this.delegate.exists(pathname);
  }

  stat(pathname: string): Promise<FsStat> {
    return this.delegate.stat(pathname);
  }

  lstat(pathname: string): Promise<FsStat> {
    return this.delegate.lstat(pathname);
  }

  mkdir(pathname: string, options?: MkdirOptions): Promise<void> {
    this.assertWritable(pathname);
    return this.delegate.mkdir(pathname, options);
  }

  readdir(pathname: string): Promise<string[]> {
    return this.delegate.readdir(pathname);
  }

  readdirWithFileTypes(pathname: string): Promise<DirentEntry[]> {
    if (!this.delegate.readdirWithFileTypes) {
      return defaultReaddirWithFileTypes(this.delegate, pathname);
    }
    return this.delegate.readdirWithFileTypes(pathname);
  }

  rm(pathname: string, options?: RmOptions): Promise<void> {
    this.assertWritable(pathname);
    return this.delegate.rm(pathname, options);
  }

  cp(src: string, dest: string, options?: CpOptions): Promise<void> {
    this.assertWritable(dest);
    return this.delegate.cp(src, dest, options);
  }

  mv(src: string, dest: string): Promise<void> {
    this.assertWritable(src);
    this.assertWritable(dest);
    return this.delegate.mv(src, dest);
  }

  resolvePath(base: string, pathname: string): string {
    return this.delegate.resolvePath(base, pathname);
  }

  getAllPaths(): string[] {
    return this.delegate.getAllPaths();
  }

  chmod(pathname: string, mode: number): Promise<void> {
    this.assertWritable(pathname);
    return this.delegate.chmod(pathname, mode);
  }

  symlink(target: string, linkPath: string): Promise<void> {
    this.assertWritable(linkPath);
    return this.delegate.symlink(target, linkPath);
  }

  link(existingPath: string, newPath: string): Promise<void> {
    this.assertWritable(existingPath);
    this.assertWritable(newPath);
    return this.delegate.link(existingPath, newPath);
  }

  readlink(pathname: string): Promise<string> {
    return this.delegate.readlink(pathname);
  }

  realpath(pathname: string): Promise<string> {
    return this.delegate.realpath(pathname);
  }

  utimes(pathname: string, atime: Date, mtime: Date): Promise<void> {
    this.assertWritable(pathname);
    return this.delegate.utimes(pathname, atime, mtime);
  }

  private assertWritable(pathname: string): void {
    if (this.options.readOnly) {
      throw accessDenied(`${this.options.mountPoint} is read-only`);
    }

    const harnessPath = toMountedHarnessPath(this.options.mountPoint, pathname);
    for (const prefix of this.options.getReadOnlyPrefixes?.() ?? []) {
      const normalized = normalizeHarnessPrefix(prefix);
      if (harnessPath === normalized || harnessPath.startsWith(`${normalized}/`)) {
        throw accessDenied(`Persistent Dir is read-only: ${normalized}`);
      }
    }
  }
}

const SYNTHETIC_DIRS: ReadonlySet<string> = new Set(["/", "/dev"]);
const SYNTHETIC_PATHS: ReadonlySet<string> = new Set([...SYNTHETIC_DIRS, "/dev/null"]);

// A synthetic sink/EOF endpoint, not a host device mount or a general writable /dev.
function isNullDevice(pathname: string): boolean {
  return path.posix.normalize(pathname) === "/dev/null";
}

/** Guard cross-mount structural operations before MountableFs can copy/remove a source. */
class WorkspaceFs extends MountableFs {
  private syntheticPath(pathname: string): string | undefined {
    // Match MountableFs routing: root-relative paths, dot segments and trailing slashes.
    const normalized = this.resolvePath("/", pathname);
    return SYNTHETIC_PATHS.has(normalized) && !this.getMounts().some(({ mountPoint }) =>
      normalized === mountPoint || normalized.startsWith(`${mountPoint}/`)) ? normalized : undefined;
  }
  private assertStructuralOperation(operation: "move" | "copy", src: string, dest: string): void {
    const synthetic = this.syntheticPath(src) ?? this.syntheticPath(dest);
    if (synthetic !== undefined) {
      const kind = synthetic === "/dev/null" ? "endpoint" : "directory";
      throw accessDenied(`Cannot ${operation} the synthetic ${synthetic} ${kind}`);
    }
  }
  override async mv(src: string, dest: string): Promise<void> {
    this.assertStructuralOperation("move", src, dest);
    return super.mv(src, dest);
  }
  override async cp(src: string, dest: string, options?: CpOptions): Promise<void> {
    this.assertStructuralOperation("copy", src, dest);
    return super.cp(src, dest, options);
  }
}

class UnmanagedRootFs implements IFileSystem {
  async readFile(pathname: string): Promise<string> {
    if (isNullDevice(pathname)) return "";
    throw notFound(pathname);
  }

  async readFileBuffer(pathname: string): Promise<Uint8Array> {
    if (isNullDevice(pathname)) return new Uint8Array();
    throw notFound(pathname);
  }

  async writeFile(pathname: string): Promise<void> {
    if (isNullDevice(pathname)) return;
    throw accessDenied(`Unmanaged harness path is read-only: ${pathname}`);
  }

  async appendFile(pathname: string): Promise<void> {
    if (isNullDevice(pathname)) return;
    throw accessDenied(`Unmanaged harness path is read-only: ${pathname}`);
  }

  async exists(pathname: string): Promise<boolean> {
    return SYNTHETIC_PATHS.has(path.posix.normalize(pathname));
  }

  async stat(pathname: string): Promise<FsStat> {
    const normalized = path.posix.normalize(pathname);
    if (SYNTHETIC_DIRS.has(normalized)) return directoryStat();
    if (normalized === "/dev/null") return { ...directoryStat(), isDirectory: false, isFile: false, mode: 0o666 };
    throw notFound(pathname);
  }

  async lstat(pathname: string): Promise<FsStat> {
    return this.stat(pathname);
  }

  async mkdir(pathname: string, options?: MkdirOptions): Promise<void> {
    const normalized = path.posix.normalize(pathname);
    if (normalized === "/") return;
    if (normalized === "/dev") {
      if (options?.recursive) return;
      const error = new Error(`EEXIST: file already exists, mkdir '${pathname}'`) as NodeJS.ErrnoException;
      error.code = "EEXIST";
      throw error;
    }
    throw accessDenied(`Cannot create unmanaged harness path: ${pathname}`);
  }

  async readdir(pathname: string): Promise<string[]> {
    const normalized = path.posix.normalize(pathname);
    if (normalized === "/") return ["dev"];
    if (normalized === "/dev") return ["null"];
    if (normalized === "/dev/null") throw notDirectory(pathname);
    throw notFound(pathname);
  }

  async rm(pathname: string): Promise<void> {
    throw accessDenied(`Cannot remove unmanaged harness path: ${pathname}`);
  }

  async cp(_src: string, dest: string): Promise<void> {
    throw accessDenied(`Cannot copy into unmanaged harness path: ${dest}`);
  }

  async mv(_src: string, dest: string): Promise<void> {
    throw accessDenied(`Cannot move into unmanaged harness path: ${dest}`);
  }

  resolvePath(base: string, pathname: string): string {
    return path.posix.resolve(base, pathname);
  }

  getAllPaths(): string[] {
    return [...SYNTHETIC_PATHS];
  }

  async chmod(pathname: string): Promise<void> {
    throw accessDenied(`Cannot chmod unmanaged harness path: ${pathname}`);
  }

  async symlink(_target: string, linkPath: string): Promise<void> {
    throw accessDenied(`Cannot create symlink in unmanaged harness path: ${linkPath}`);
  }

  async link(_existingPath: string, newPath: string): Promise<void> {
    throw accessDenied(`Cannot create hard link in unmanaged harness path: ${newPath}`);
  }

  async readlink(pathname: string): Promise<string> {
    throw notFound(pathname);
  }

  async realpath(pathname: string): Promise<string> {
    const normalized = path.posix.normalize(pathname);
    if (SYNTHETIC_PATHS.has(normalized)) return normalized;
    throw notFound(pathname);
  }

  async utimes(pathname: string): Promise<void> {
    throw accessDenied(`Cannot update unmanaged harness path: ${pathname}`);
  }
}

async function defaultReaddirWithFileTypes(
  fs: IFileSystem,
  pathname: string,
): Promise<DirentEntry[]> {
  const names = await fs.readdir(pathname);
  return Promise.all(
    names.map(async (name) => {
      const stat = await fs.stat(path.posix.join(pathname, name));
      return {
        name,
        isFile: stat.isFile,
        isDirectory: stat.isDirectory,
        isSymbolicLink: stat.isSymbolicLink,
      };
    }),
  );
}

function toMountedHarnessPath(mountPoint: string, pathname: string): string {
  const childPath = path.posix.normalize(pathname.startsWith("/") ? pathname : `/${pathname}`);
  return path.posix.normalize(`${mountPoint}${childPath === "/" ? "" : childPath}`);
}

function directoryStat(): FsStat {
  return {
    isFile: false,
    isDirectory: true,
    isSymbolicLink: false,
    mode: 0o755,
    size: 0,
    mtime: new Date(0),
  };
}

function notFound(pathname: string): Error {
  const error = new Error(`ENOENT: no such file or directory, ${pathname}`) as NodeJS.ErrnoException;
  error.code = "ENOENT";
  return error;
}

function notDirectory(pathname: string): Error {
  const error = new Error(`ENOTDIR: not a directory, ${pathname}`) as NodeJS.ErrnoException;
  error.code = "ENOTDIR";
  return error;
}

function accessDenied(message: string): Error {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = "EACCES";
  return error;
}
