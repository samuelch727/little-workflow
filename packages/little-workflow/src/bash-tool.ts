import { copyFile, mkdir, mkdtemp, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  Bash,
  InMemoryFs,
  MountableFs,
  OverlayFs,
  ReadWriteFs,
  type BashExecResult,
  type NetworkConfig,
} from "just-bash";
import type { BashTool } from "./harness/types.js";

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

type MountedFilesystem = MountableFs | OverlayFs | ReadWriteFs;

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
    python: environment.capabilities.python,
    javascript: environment.capabilities.javascript,
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
    if (isNestedReadonlyAlias(mount, mounts)) {
      continue;
    }
    const nestedAliases = mount.mode === "rw"
      ? mounts.filter((candidate) => mostSpecificWritableContainer(candidate, mounts) === mount)
      : [];
    const mountPoint = await filesystemMountFor(mount);
    fs.mount(
      mountPoint.mountAt,
      nestedAliases.length === 0
        ? mountPoint.filesystem
        : await filesystemWithNestedAliases(mount, nestedAliases),
    );
  }

  return {
    fs,
    mounts,
    defaultCwd: await resolveCwdFromMounts(scope.cwd, mounts),
    capabilities: normalizeBashCapabilities(scope.capabilities),
  };
}

async function isolatedSingleFileMount(
  mount: MountSpec,
  mountPath: string,
): Promise<{ readonly rootDir: string; readonly mountAt: string }> {
  const normalizedMountPath = trimTrailingSlash(mountPath);
  const rootDir = await mkdtemp(join(tmpdir(), "little-workflow-bash-file-mount-"));
  await copyFile(mount.backingPath, join(rootDir, basename(normalizedMountPath)));
  return {
    rootDir,
    mountAt: dirname(normalizedMountPath),
  };
}

async function filesystemMountFor(
  mount: MountSpec,
  mountPath = mount.mountPath,
): Promise<{ readonly mountAt: string; readonly filesystem: MountedFilesystem }> {
  // FS roots must be directories. A single-file mount is staged into an
  // isolated directory under the advertised basename so source siblings stay hidden.
  const backingIsFile = (await stat(mount.backingPath).catch(() => undefined))?.isFile() === true;
  const fileMount = backingIsFile ? await isolatedSingleFileMount(mount, mountPath) : undefined;
  const rootDir = fileMount?.rootDir ?? mount.backingPath;
  await mkdir(rootDir, { recursive: true });
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
): Promise<MountedFilesystem> {
  const fs = new MountableFs({
    base: new ReadWriteFs({
      root: container.backingPath,
      allowSymlinks: false,
      maxFileReadSize: DEFAULT_MAX_FILE_READ_SIZE,
    }),
  });
  for (const alias of aliases) {
    const mountPoint = await filesystemMountFor(
      alias,
      `/${relativeVirtualPath(container.mountPath, alias.mountPath)}`,
    );
    fs.mount(mountPoint.mountAt, mountPoint.filesystem);
  }
  return fs;
}

async function mountSpecsForScope(scope: BashScope): Promise<readonly MountSpec[]> {
  const specs: MountSpec[] = [];
  const aliases = scope.pathAliases ?? [];

  for (const alias of aliases) {
    const mountPath = aliasMountPathForScope(scope.cwd, alias.mountPath);
    if (alias.backingPath.includes("*")) {
      specs.push(...await expandWildcardAlias({ ...alias, mountPath }, scope.readableRoots));
      continue;
    }
    specs.push({
      mountPath,
      backingPath: alias.backingPath,
      mode: modeForBackingPath(alias.backingPath, scope.readableRoots),
      source: "alias",
    });
  }

  for (const root of scope.readableRoots) {
    if (aliases.some((alias) =>
      !alias.backingPath.includes("*") && pathContains(root.path, alias.backingPath)
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

  const deduped = [...dedupeMountSpecs(specs)]
    .sort((left, right) => left.mountPath.length - right.mountPath.length);
  return deduped;
}

function aliasMountPathForScope(cwd: string, mountPath: string): string {
  if (isAbsolute(mountPath)) {
    return mountPath;
  }
  return `${trimTrailingSlash(cwd)}/${mountPath}`;
}

async function expandWildcardAlias(
  alias: { readonly mountPath: string; readonly backingPath: string },
  roots: readonly { readonly path: string; readonly mode: "rw" | "ro" }[],
): Promise<readonly MountSpec[]> {
  const wildcardIndex = alias.backingPath.indexOf("*");
  const prefix = alias.backingPath.slice(0, wildcardIndex);
  const suffix = alias.backingPath.slice(wildcardIndex + 1);
  const parent = trimTrailingSlash(prefix);
  let entries: readonly string[] = [];
  try {
    entries = await readdir(parent);
  } catch {
    return [];
  }

  const specs: MountSpec[] = [];
  for (const entry of entries) {
    const backingPath = resolve(parent, entry, suffix.replace(/^[/\\]+/u, ""));
    try {
      if (!(await stat(backingPath)).isDirectory()) {
        continue;
      }
    } catch {
      continue;
    }
    specs.push({
      mountPath: `${trimTrailingSlash(alias.mountPath)}/${entry}`,
      backingPath,
      mode: modeForBackingPath(backingPath, roots),
      source: "alias",
    });
  }
  return specs;
}

function isNestedReadonlyAlias(
  spec: MountSpec,
  specs: readonly MountSpec[],
): boolean {
  return spec.source === "alias" &&
    spec.mode === "ro" &&
    mostSpecificWritableContainer(spec, specs) !== undefined;
}

function mostSpecificWritableContainer(
  spec: MountSpec,
  specs: readonly MountSpec[],
): MountSpec | undefined {
  return [...specs]
    .filter((candidate) =>
      candidate.mode === "rw" &&
      trimTrailingSlash(candidate.mountPath) !== trimTrailingSlash(spec.mountPath) &&
      virtualPathContains(candidate.mountPath, spec.mountPath) &&
      !pathContains(candidate.backingPath, spec.backingPath)
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
): "rw" | "ro" {
  const match = [...roots]
    .filter((root) => pathContains(root.path, backingPath))
    .sort((left, right) => right.path.length - left.path.length)[0];
  return match?.mode ?? "ro";
}

function dedupeMountSpecs(specs: readonly MountSpec[]): readonly MountSpec[] {
  const byMount = new Map<string, MountSpec>();
  for (const spec of specs) {
    byMount.set(trimTrailingSlash(spec.mountPath), {
      ...spec,
      mountPath: trimTrailingSlash(spec.mountPath),
      backingPath: resolve(spec.backingPath),
    });
  }
  return [...byMount.values()];
}

async function resolveCwd(scope: BashScope, cwd: string): Promise<string> {
  return resolveCwdFromMounts(cwd, await mountSpecsForScope(scope));
}

async function resolveCwdFromMounts(cwd: string, mounts: readonly MountSpec[]): Promise<string> {
  const virtualCwd = toVirtualPath(cwd, mounts);
  if (virtualCwd === "/") {
    return virtualCwd;
  }
  const mount = mostSpecificMountForVirtualPath(virtualCwd, mounts);
  if (mount?.mode !== "rw") {
    throw new TypeError("cwd must be inside a writable mount.");
  }
  return virtualCwd;
}

function toVirtualPath(path: string, mounts: readonly MountSpec[]): string {
  if (!isAbsolute(path)) {
    return normalizeVirtualPath(path);
  }
  const physical = resolve(path);
  const mount = [...mounts]
    .filter((candidate) => pathContains(candidate.backingPath, physical))
    .sort((left, right) => right.backingPath.length - left.backingPath.length)[0];
  if (mount === undefined) {
    return normalizeVirtualPath(path);
  }
  const rest = relative(mount.backingPath, physical).split(sep).filter(Boolean).join("/");
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

function pathContains(rootPath: string, candidatePath: string): boolean {
  const relativePath = relative(resolve(rootPath), resolve(candidatePath));
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
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
