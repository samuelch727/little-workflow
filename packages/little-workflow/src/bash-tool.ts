import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import * as nodePath from "node:path";
import { justBashNodeExport, SubtreeFs } from "@little-stack/harness/internals";
import {
  Bash,
  InMemoryFs,
  MountableFs,
  type BashExecResult,
  type IFileSystem,
  type NetworkConfig,
} from "just-bash";
import type { BashTool } from "./harness/types.js";
import { runFilesFor } from "./run-files.js";

const DEFAULT_MAX_FILE_READ_SIZE = 10 * 1024 * 1024;

export type BashNetworkCapabilities =
  | false
  | true
  | {
    readonly allow?: readonly string[];
    readonly methods?: readonly string[];
    readonly maxRedirects?: number;
    readonly timeoutMs?: number;
    readonly maxResponseSize?: number;
    readonly denyPrivateRanges?: boolean;
    readonly dangerouslyAllowFullInternetAccess?: boolean;
  };

export type BashCapabilities = {
  readonly network?: BashNetworkCapabilities;
  readonly python?: boolean;
  readonly javascript?: boolean;
};

export type NormalizedBashCapabilities = {
  readonly network:
    | false
    | {
      readonly allowedUrlPrefixes?: readonly string[];
      readonly allowedMethods?: readonly string[];
      readonly maxRedirects?: number;
      readonly timeoutMs?: number;
      readonly maxResponseSize?: number;
      readonly denyPrivateRanges: boolean;
      readonly dangerouslyAllowFullInternetAccess?: boolean;
    };
  readonly python: boolean;
  readonly javascript: boolean;
};

export type BashScope = {
  readonly files?: IFileSystem;
  readonly cwd: string;
  readonly readableRoots: readonly { readonly path: string; readonly mode: "rw" | "ro" }[];
  readonly pathAliases?: readonly { readonly mountPath: string; readonly backingPath: string }[];
  readonly capabilities?: BashCapabilities;
};

export type BashCommandInput = {
  readonly cmd: string;
  readonly cwd?: string;
  readonly timeoutMs?: number;
};

export type BashCommandOutput = {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
};

export type SandboxedBashTool = Omit<BashTool, "execute"> & {
  readonly execute: (input: unknown) => Promise<BashCommandOutput>;
};

type MountSpec = {
  readonly mountPath: string;
  readonly backingPath: string;
  readonly mode: "rw" | "ro";
  readonly source: "alias" | "root";
};

type ResolvedBashEnvironment = {
  readonly fs: MountableFs;
  readonly mounts: readonly MountSpec[];
  readonly defaultCwd: string;
  readonly capabilities: NormalizedBashCapabilities;
};

type MountedFilesystem = IFileSystem;

export function createBashTool(scope: BashScope): SandboxedBashTool {
  let session: Promise<{
    readonly bash: Bash;
    cwd: string;
    env: Record<string, string>;
  }> | undefined;

  const sessionFor = async () => {
    if (session === undefined) {
      session = createSession(scope);
    }
    return session;
  };

  return {
    description: "Execute a sandboxed bash command in the mounted harness environment. Use to inspect files, run scripts, test code, and read memory.",
    inputSchema: {
      type: "object",
      properties: {
        cmd: { type: "string" },
        cwd: { type: "string" },
        timeoutMs: { type: "number" },
      },
      required: ["cmd"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        stdout: { type: "string" },
        stderr: { type: "string" },
        exitCode: { type: "number" },
      },
      required: ["stdout", "stderr", "exitCode"],
      additionalProperties: false,
    },
    async execute(input: unknown): Promise<BashCommandOutput> {
      const command = commandInput(input);
      const current = await sessionFor();
      const cwd = command.cwd === undefined
        ? current.cwd
        : await resolveCwd(scope, command.cwd);
      const result = await execWithTimeout(current.bash, command.cmd, {
        cwd,
        env: current.env,
        timeoutMs: command.timeoutMs,
      });
      current.env = result.env;
      current.cwd = result.env.PWD ?? cwd;
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      };
    },
  };
}

export async function validateBashCommand(
  scope: BashScope,
  input: { readonly cmd: string; readonly cwd?: string },
): Promise<void> {
  commandInput(input);
  if (input.cwd !== undefined) {
    await resolveCwd(scope, input.cwd);
  }
}

export function normalizeBashCapabilities(
  capabilities: BashCapabilities | undefined,
): NormalizedBashCapabilities {
  const network = capabilities?.network ?? false;
  return {
    network: normalizeNetworkCapabilities(network),
    python: capabilities?.python ?? true,
    javascript: capabilities?.javascript ?? true,
  };
}

function normalizeNetworkCapabilities(
  network: BashNetworkCapabilities,
): NormalizedBashCapabilities["network"] {
  if (network === false) {
    return false;
  }
  if (network === true) {
    return {
      allowedUrlPrefixes: ["https://"],
      allowedMethods: ["GET", "HEAD"],
      denyPrivateRanges: true,
    };
  }
  return {
    ...(network.allow === undefined ? {} : { allowedUrlPrefixes: sortedStrings(network.allow) }),
    ...(network.methods === undefined ? {} : { allowedMethods: sortedStrings(network.methods) }),
    ...(network.maxRedirects === undefined ? {} : { maxRedirects: network.maxRedirects }),
    ...(network.timeoutMs === undefined ? {} : { timeoutMs: network.timeoutMs }),
    ...(network.maxResponseSize === undefined ? {} : { maxResponseSize: network.maxResponseSize }),
    denyPrivateRanges: network.denyPrivateRanges ?? true,
    ...(network.dangerouslyAllowFullInternetAccess === undefined
      ? {}
      : { dangerouslyAllowFullInternetAccess: network.dangerouslyAllowFullInternetAccess }),
  };
}

async function createSession(scope: BashScope): Promise<{
  readonly bash: Bash;
  cwd: string;
  env: Record<string, string>;
}> {
  const environment = await createBashEnvironment(scope);
  const bash = new Bash({
    fs: environment.fs,
    cwd: environment.defaultCwd,
    network: networkForJustBash(environment.capabilities.network),
    python: justBashNodeExport("ReadWriteFs") === undefined ? false : environment.capabilities.python,
    javascript: justBashNodeExport("ReadWriteFs") === undefined ? false : environment.capabilities.javascript,
    defenseInDepth: true,
    executionLimits: {
      maxCommandCount: 10_000,
      maxLoopIterations: 10_000,
      maxCallDepth: 128,
    },
  });

  return {
    bash,
    cwd: environment.defaultCwd,
    env: bash.getEnv(),
  };
}

async function createBashEnvironment(scope: BashScope): Promise<ResolvedBashEnvironment> {
  const fs = new MountableFs({ base: new InMemoryFs() });
  const mounts = await mountSpecsForScope(scope);
  for (const mount of mounts) {
    if (isNestedReadonlyAlias(mount, mounts, ioForScope(scope).path)) {
      continue;
    }
    const paths = ioForScope(scope).path;
    const nestedAliases = mount.mode === "rw"
      ? mounts.filter((candidate) => mostSpecificWritableContainer(candidate, mounts, paths) === mount)
      : [];
    const mountPoint = await filesystemMountFor(mount, mount.mountPath, scope.files);
    fs.mount(
      mountPoint.mountAt,
      nestedAliases.length === 0
        ? mountPoint.filesystem
        : await filesystemWithNestedAliases(mount, nestedAliases, scope.files),
    );
  }

  return {
    fs,
    mounts,
    defaultCwd: await resolveCwdFromMounts(scope.cwd, mounts, ioForScope(scope).path),
    capabilities: normalizeBashCapabilities(scope.capabilities),
  };
}

async function isolatedSingleFileMount(
  mount: MountSpec,
  mountPath: string,
): Promise<{ readonly rootDir: string; readonly mountAt: string }> {
  const io = ioForScope({});
  const normalizedMountPath = trimTrailingSlash(mountPath);
  const rootDir = await io.mkdtemp(join(tmpdir(), "little-workflow-bash-file-mount-"));
  await io.copyFile(mount.backingPath, join(rootDir, basename(normalizedMountPath)));
  return {
    rootDir,
    mountAt: dirname(normalizedMountPath),
  };
}

async function filesystemMountFor(
  mount: MountSpec,
  mountPath = mount.mountPath,
  files?: IFileSystem,
): Promise<{ readonly mountAt: string; readonly filesystem: MountedFilesystem }> {
  const io = ioForScope({ files });
  // FS roots must be directories. A single-file mount is staged into an
  // isolated directory under the advertised basename so source siblings stay hidden.
  if (files !== undefined) {
    // SubtreeFs confines lexical paths; its delegate also has to refuse symlink
    // traversal, matching the disk adapters' allowSymlinks:false behavior.
    const guarded = symlinkFreeFilesystem(files, mount.backingPath);
    const backingIsFile = (await guarded.stat(mount.backingPath).catch(error => {
      if (missingFile(error)) return undefined;
      throw error;
    }))?.isFile === true;
    let view: IFileSystem;
    if (backingIsFile) {
      view = new InMemoryFs({ [`/${nodePath.posix.basename(mountPath)}`]: await guarded.readFileBuffer(mount.backingPath) });
    } else {
      await guarded.mkdir(mount.backingPath, { recursive: true });
      view = new SubtreeFs(guarded, mount.backingPath);
    }
    return {
      mountAt: backingIsFile ? nodePath.posix.dirname(trimTrailingSlash(mountPath)) : trimTrailingSlash(mountPath),
      filesystem: mount.mode === "ro" ? readOnlyFilesystem(view) : view,
    };
  }
  const backingIsFile = (await io.stat(mount.backingPath).catch(() => undefined))?.isFile() === true;
  const fileMount = backingIsFile ? await isolatedSingleFileMount(mount, mountPath) : undefined;
  const rootDir = fileMount?.rootDir ?? mount.backingPath;
  await io.mkdir(rootDir, { recursive: true });
  const ReadWriteFs = justBashNodeExport("ReadWriteFs");
  const OverlayFs = justBashNodeExport("OverlayFs");
  if (ReadWriteFs === undefined || OverlayFs === undefined) {
    throw new TypeError("Disk bash mounts need just-bash's Node build; use a World with files on workerd.");
  }
  return {
    mountAt: fileMount?.mountAt ?? trimTrailingSlash(mountPath),
    filesystem: mount.mode === "rw"
      ? new ReadWriteFs({
        root: rootDir,
        allowSymlinks: false,
        maxFileReadSize: DEFAULT_MAX_FILE_READ_SIZE,
      })
      : new OverlayFs({
        root: rootDir,
        mountPoint: "/",
        readOnly: true,
        allowSymlinks: false,
        maxFileReadSize: DEFAULT_MAX_FILE_READ_SIZE,
      }),
  };
}

async function filesystemWithNestedAliases(
  container: MountSpec,
  aliases: readonly MountSpec[],
  files?: IFileSystem,
): Promise<MountedFilesystem> {
  const containerMount = await filesystemMountFor(container, container.mountPath, files);
  const fs = new MountableFs({
    base: containerMount.filesystem,
  });
  for (const alias of aliases) {
    const mountPoint = await filesystemMountFor(
      alias,
      `/${relativeVirtualPath(container.mountPath, alias.mountPath)}`,
      files,
    );
    fs.mount(mountPoint.mountAt, mountPoint.filesystem);
  }
  return fs;
}

async function mountSpecsForScope(scope: BashScope): Promise<readonly MountSpec[]> {
  const specs: MountSpec[] = [];
  const aliases = scope.pathAliases ?? [];
  const paths = ioForScope(scope).path;

  for (const alias of aliases) {
    const mountPath = aliasMountPathForScope(scope.cwd, alias.mountPath, paths);
    if (alias.backingPath.includes("*")) {
      specs.push(...await expandWildcardAlias({ ...alias, mountPath }, scope.readableRoots, scope.files));
      continue;
    }
    specs.push({
      mountPath,
      backingPath: alias.backingPath,
      mode: modeForBackingPath(alias.backingPath, scope.readableRoots, paths),
      source: "alias",
    });
  }

  for (const root of scope.readableRoots) {
    if (aliases.some((alias) =>
      !alias.backingPath.includes("*") && pathContains(root.path, alias.backingPath, paths)
    )) {
      continue;
    }
    specs.push({
      mountPath: root.path,
      backingPath: root.path,
      mode: root.mode,
      source: "root",
    });
  }

  const deduped = [...dedupeMountSpecs(specs, paths)]
    .sort((left, right) => left.mountPath.length - right.mountPath.length);
  return deduped;
}

function aliasMountPathForScope(cwd: string, mountPath: string, paths = nodePath): string {
  if (paths.isAbsolute(mountPath)) {
    return mountPath;
  }
  return `${trimTrailingSlash(cwd)}/${mountPath}`;
}

async function expandWildcardAlias(
  alias: { readonly mountPath: string; readonly backingPath: string },
  roots: readonly { readonly path: string; readonly mode: "rw" | "ro" }[],
  files?: IFileSystem,
): Promise<readonly MountSpec[]> {
  const io = ioForScope({ files });
  const wildcardIndex = alias.backingPath.indexOf("*");
  const prefix = alias.backingPath.slice(0, wildcardIndex);
  const suffix = alias.backingPath.slice(wildcardIndex + 1);
  const parent = trimTrailingSlash(prefix);
  let entries: readonly string[] = [];
  try {
    entries = await io.readdir(parent);
  } catch {
    return [];
  }

  const specs: MountSpec[] = [];
  for (const entry of entries) {
    const backingPath = io.path.resolve(parent, entry, suffix.replace(/^[/\\]+/u, ""));
    try {
      if (!(await io.stat(backingPath)).isDirectory()) {
        continue;
      }
    } catch {
      continue;
    }
    specs.push({
      mountPath: `${trimTrailingSlash(alias.mountPath)}/${entry}`,
      backingPath,
      mode: modeForBackingPath(backingPath, roots, io.path),
      source: "alias",
    });
  }
  return specs;
}

function isNestedReadonlyAlias(
  spec: MountSpec,
  specs: readonly MountSpec[],
  paths = nodePath,
): boolean {
  return spec.source === "alias" &&
    spec.mode === "ro" &&
    mostSpecificWritableContainer(spec, specs, paths) !== undefined;
}

function mostSpecificWritableContainer(
  spec: MountSpec,
  specs: readonly MountSpec[],
  paths = nodePath,
): MountSpec | undefined {
  return [...specs]
    .filter((candidate) =>
      candidate.mode === "rw" &&
      trimTrailingSlash(candidate.mountPath) !== trimTrailingSlash(spec.mountPath) &&
      virtualPathContains(candidate.mountPath, spec.mountPath) &&
      !pathContains(candidate.backingPath, spec.backingPath, paths)
    )
    .sort((left, right) => right.mountPath.length - left.mountPath.length)[0];
}

function relativeVirtualPath(from: string, to: string): string {
  const fromParts = trimTrailingSlash(from).split("/").filter(Boolean);
  const toParts = trimTrailingSlash(to).split("/").filter(Boolean);
  return toParts.slice(fromParts.length).join("/");
}

function modeForBackingPath(
  backingPath: string,
  roots: readonly { readonly path: string; readonly mode: "rw" | "ro" }[],
  paths = nodePath,
): "rw" | "ro" {
  const match = [...roots]
    .filter((root) => pathContains(root.path, backingPath, paths))
    .sort((left, right) => right.path.length - left.path.length)[0];
  return match?.mode ?? "ro";
}

function dedupeMountSpecs(specs: readonly MountSpec[], paths = nodePath): readonly MountSpec[] {
  const byMount = new Map<string, MountSpec>();
  for (const spec of specs) {
    byMount.set(trimTrailingSlash(spec.mountPath), {
      ...spec,
      mountPath: trimTrailingSlash(spec.mountPath),
      backingPath: paths.resolve(spec.backingPath),
    });
  }
  return [...byMount.values()];
}

async function resolveCwd(scope: BashScope, cwd: string): Promise<string> {
  return resolveCwdFromMounts(cwd, await mountSpecsForScope(scope), ioForScope(scope).path);
}

async function resolveCwdFromMounts(cwd: string, mounts: readonly MountSpec[], paths = nodePath): Promise<string> {
  const virtualCwd = toVirtualPath(cwd, mounts, paths);
  if (virtualCwd === "/") {
    return virtualCwd;
  }
  const mount = mostSpecificMountForVirtualPath(virtualCwd, mounts);
  if (mount?.mode !== "rw") {
    throw new TypeError("cwd must be inside a writable mount.");
  }
  return virtualCwd;
}

function toVirtualPath(path: string, mounts: readonly MountSpec[], paths = nodePath): string {
  if (!paths.isAbsolute(path)) {
    return normalizeVirtualPath(path);
  }
  const physical = paths.resolve(path);
  const mount = [...mounts]
    .filter((candidate) => pathContains(candidate.backingPath, physical, paths))
    .sort((left, right) => right.backingPath.length - left.backingPath.length)[0];
  if (mount === undefined) {
    return normalizeVirtualPath(path);
  }
  const rest = paths.relative(mount.backingPath, physical).split(paths.sep).filter(Boolean).join("/");
  return normalizeVirtualPath(rest.length === 0 ? mount.mountPath : `${mount.mountPath}/${rest}`);
}

function mostSpecificMountForVirtualPath(
  path: string,
  mounts: readonly MountSpec[],
): MountSpec | undefined {
  return [...mounts]
    .filter((mount) => virtualPathContains(mount.mountPath, path))
    .sort((left, right) => right.mountPath.length - left.mountPath.length)[0];
}

function networkForJustBash(
  network: NormalizedBashCapabilities["network"],
): NetworkConfig | undefined {
  if (network === false) {
    return undefined;
  }
  return {
    ...(network.allowedUrlPrefixes === undefined ? {} : { allowedUrlPrefixes: [...network.allowedUrlPrefixes] }),
    ...(network.allowedMethods === undefined ? {} : { allowedMethods: [...network.allowedMethods] }),
    ...(network.maxRedirects === undefined ? {} : { maxRedirects: network.maxRedirects }),
    ...(network.timeoutMs === undefined ? {} : { timeoutMs: network.timeoutMs }),
    ...(network.maxResponseSize === undefined ? {} : { maxResponseSize: network.maxResponseSize }),
    denyPrivateRanges: network.denyPrivateRanges,
    ...(network.dangerouslyAllowFullInternetAccess === undefined
      ? {}
      : { dangerouslyAllowFullInternetAccess: network.dangerouslyAllowFullInternetAccess }),
  };
}

async function execWithTimeout(
  bash: Bash,
  cmd: string,
  options: {
    readonly cwd: string;
    readonly env: Record<string, string>;
    readonly timeoutMs?: number;
  },
): Promise<BashExecResult> {
  const controller = new AbortController();
  const timer = options.timeoutMs === undefined
    ? undefined
    : setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    return await bash.exec(cmd, {
      cwd: options.cwd,
      env: options.env,
      signal: controller.signal,
      rawScript: true,
    });
  } catch (error) {
    return {
      stdout: "",
      stderr: error instanceof Error ? `${error.message}\n` : `${String(error)}\n`,
      exitCode: controller.signal.aborted ? 124 : 1,
      env: options.env,
    };
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function commandInput(input: unknown): BashCommandInput {
  if (!isRecord(input)) {
    throw new TypeError("bash input must be an object.");
  }
  const cmd = input.cmd;
  if (typeof cmd !== "string" || cmd.length === 0) {
    throw new TypeError("bash input must include a non-empty cmd string.");
  }
  const cwd = input.cwd;
  if (cwd !== undefined && typeof cwd !== "string") {
    throw new TypeError("bash input cwd must be a string when provided.");
  }
  const timeoutMs = input.timeoutMs;
  if (
    timeoutMs !== undefined &&
    (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs < 0)
  ) {
    throw new TypeError("bash input timeoutMs must be a non-negative finite number when provided.");
  }
  return {
    cmd,
    ...(cwd === undefined ? {} : { cwd }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
}

function pathContains(rootPath: string, candidatePath: string, paths = nodePath): boolean {
  const relativePath = paths.relative(paths.resolve(rootPath), paths.resolve(candidatePath));
  return relativePath === "" || (!relativePath.startsWith("..") && !paths.isAbsolute(relativePath));
}

function ioForScope(scope: Pick<BashScope, "files">) {
  return runFilesFor({ dataDir: "/", ...(scope.files === undefined ? {} : { files: scope.files }) });
}

const READ_ONLY_MUTATIONS = new Set([
  "writeFile", "appendFile", "mkdir", "rm", "cp", "mv", "chmod", "symlink", "link", "utimes",
]);

const SINGLE_PATH_OPERATIONS = new Set([
  "readFile", "readFileBytes", "readFileBuffer", "writeFile", "appendFile", "exists",
  "stat", "lstat", "mkdir", "readdir", "readdirWithFileTypes", "chmod", "readlink",
  "realpath", "utimes",
]);

/** A Bash-only delegate: it never replaces the World's filesystem identity. */
function symlinkFreeFilesystem(delegate: IFileSystem, backingRoot: string): IFileSystem {
  const paths = nodePath.posix;
  const root = paths.resolve("/", backingRoot);
  const refused = (path: string) => Object.assign(
    new Error(`Symlinks are not allowed in virtual Bash mounts: ${path}`), { code: "ELOOP" },
  );
  const assertPath = async (pathname: unknown): Promise<string> => {
    if (typeof pathname !== "string" || pathname.includes("\0")) throw refused(String(pathname));
    const normalized = paths.resolve("/", pathname);
    if (normalized !== root && !normalized.startsWith(root === "/" ? "/" : `${root}/`)) {
      throw Object.assign(new Error("Path is outside the virtual Bash mount"), { code: "EACCES" });
    }
    let current = "/";
    // Check ancestors outside the mounted folder too: its root may itself be
    // reached through a link supplied by the application's filesystem.
    for (const part of ["", ...normalized.split("/").filter(Boolean)]) {
      current = paths.join(current, part);
      try {
        if ((await delegate.lstat(current)).isSymbolicLink) throw refused(current);
      } catch (error) {
        if (missingFile(error)) break;
        throw error;
      }
    }
    return normalized;
  };
  const assertTree = async (pathname: unknown): Promise<void> => {
    const normalized = await assertPath(pathname);
    let entry;
    try {
      entry = await delegate.lstat(normalized);
    } catch (error) {
      if (missingFile(error)) return;
      throw error;
    }
    if (entry.isSymbolicLink) throw refused(normalized);
    if (entry.isDirectory) {
      for (const name of await delegate.readdir(normalized)) {
        await assertTree(paths.join(normalized, name));
      }
    }
  };
  return new Proxy(delegate, {
    get(target, key) {
      // Enumerating lexical names does not follow links. Actual path access is
      // checked separately, and SubtreeFs translates only this mount's names.
      if (key === "getAllPaths") return () => delegate.getAllPaths().filter(candidate => {
        const normalized = paths.resolve("/", candidate);
        return normalized === root || normalized.startsWith(root === "/" ? "/" : `${root}/`);
      });
      if (key === "resolvePath") return paths.resolve;
      if (key === "symlink") return async (_target: string, link: string) => { throw refused(link); };
      const value: unknown = Reflect.get(target, key);
      if (typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        if (typeof key === "string" && SINGLE_PATH_OPERATIONS.has(key)) {
          await assertPath(args[0]);
        } else if (key === "cp" || key === "mv") {
          // These methods may recurse inside the delegate without reentering
          // this proxy. Inspect both existing trees before handing them off.
          await assertTree(args[0]);
          await assertTree(args[1]);
        } else if (key === "rm") {
          await assertTree(args[0]);
        } else if (key === "link") {
          await assertTree(args[0]);
          await assertPath(args[1]);
        } else {
          throw Object.assign(new Error(`Unsupported virtual Bash filesystem operation: ${String(key)}`), { code: "EACCES" });
        }
        return Reflect.apply(value, target, args);
      };
    },
  });
}

function missingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    (("code" in error && error.code === "ENOENT") ||
      ("message" in error && typeof error.message === "string" && error.message.startsWith("ENOENT:")));
}

function readOnlyFilesystem(fs: IFileSystem): IFileSystem {
  return new Proxy(fs, {
    get(target, key, receiver) {
      if (typeof key === "string" && READ_ONLY_MUTATIONS.has(key)) {
        return async () => { throw Object.assign(new Error("Read-only filesystem"), { code: "EROFS" }); };
      }
      const value: unknown = Reflect.get(target, key, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function virtualPathContains(rootPath: string, candidatePath: string): boolean {
  const root = trimTrailingSlash(normalizeVirtualPath(rootPath));
  const candidate = normalizeVirtualPath(candidatePath);
  return candidate === root || candidate.startsWith(`${root}/`);
}

function normalizeVirtualPath(path: string): string {
  const parts: string[] = [];
  for (const part of path.replace(/\\/g, "/").split("/")) {
    if (part.length === 0 || part === ".") {
      continue;
    }
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return `/${parts.join("/")}`;
}

function trimTrailingSlash(path: string): string {
  const normalized = normalizeVirtualPath(path);
  return normalized.length > 1 ? normalized.replace(/\/+$/u, "") : normalized;
}

function sortedStrings(values: readonly string[]): readonly string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (typeof value === "object" || typeof value === "function") && value !== null;
}
