import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { createServer, type Server } from "node:net";
import * as path from "node:path";
import { promisify } from "node:util";
import { HarnessInputError } from "../errors.js";
import type { SkillGitAuth } from "../types.js";
import type { ParsedRemoteSkillSource } from "./remote-source.js";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 120_000;

export type MaterializedRemoteGitSource = {
  commitSha: string;
  snapshotDir: string;
  cacheHit: boolean;
};

export type MaterializeRemoteGitSourceOptions = {
  cacheDir?: string;
  auth?: SkillGitAuth;
};

export async function materializeRemoteGitSource(
  source: ParsedRemoteSkillSource,
  options: MaterializeRemoteGitSourceOptions = {},
): Promise<MaterializedRemoteGitSource> {
  const cacheDir = options.cacheDir ?? defaultCacheDir();
  await ensureCacheDir(cacheDir);
  const auth = resolveGitAuth(source, options.auth);
  const normalizedIdentity = normalizeRemoteIdentity(source.cloneUrl);
  const authScope = cacheScope(auth);
  const subpathScope = subpathCacheScope(source.subpath);
  const requestedRef = source.ref ?? "HEAD";

  if (isFullCommitSha(requestedRef)) {
    const snapshotDir = snapshotPath(cacheDir, normalizedIdentity, requestedRef, authScope, subpathScope);
    if (existsSync(snapshotDir)) {
      return { commitSha: requestedRef, snapshotDir, cacheHit: true };
    }
    await createSnapshot(source, requestedRef, snapshotDir, auth);
    return { commitSha: requestedRef, snapshotDir, cacheHit: false };
  }

  const commitSha = await resolveRemoteRef(source, requestedRef, auth);
  const snapshotDir = snapshotPath(cacheDir, normalizedIdentity, commitSha, authScope, subpathScope);
  if (existsSync(snapshotDir)) {
    return { commitSha, snapshotDir, cacheHit: true };
  }

  await createSnapshot(source, commitSha, snapshotDir, auth);
  return { commitSha, snapshotDir, cacheHit: false };
}

function defaultCacheDir(): string {
  return path.join(tmpdir(), "little-harness-skills-cache");
}

async function ensureCacheDir(cacheDir: string): Promise<void> {
  await mkdir(cacheDir, { recursive: true, mode: 0o700 });
  await chmod(cacheDir, 0o700);
}

async function resolveRemoteRef(
  source: ParsedRemoteSkillSource,
  requestedRef: string,
  auth: ResolvedGitAuth | undefined,
): Promise<string> {
  const stdout = await runGit(["ls-remote", source.cloneUrl, requestedRef], {
    auth,
    message: "Failed to resolve remote skill ref",
  });
  const commitSha = pickLsRemoteSha(stdout, requestedRef);
  if (commitSha !== undefined) {
    return commitSha;
  }

  if (requestedRef !== "HEAD") {
    throw new HarnessInputError("Failed to resolve remote skill ref", {
      source: source.original,
      ref: requestedRef,
    });
  }

  throw new HarnessInputError("Failed to resolve remote skill HEAD", { source: source.original });
}

function pickLsRemoteSha(stdout: string, requestedRef: string): string | undefined {
  const rows = stdout
    .split("\n")
    .map((line) => line.trim().split(/\s+/u))
    .filter((row): row is [string, string] => isFullCommitSha(row[0] ?? "") && row[1] !== undefined);

  const preferredRefs = [
    requestedRef,
    `refs/heads/${requestedRef}`,
    `refs/tags/${requestedRef}^{}`,
    `refs/tags/${requestedRef}`,
  ];
  for (const ref of preferredRefs) {
    const match = rows.find((row) => row[1] === ref);
    if (match !== undefined) {
      return match[0];
    }
  }

  return rows[0]?.[0];
}

async function createSnapshot(
  source: ParsedRemoteSkillSource,
  commitSha: string,
  snapshotDir: string,
  auth: ResolvedGitAuth | undefined,
): Promise<void> {
  if (existsSync(snapshotDir)) {
    return;
  }

  await mkdir(path.dirname(snapshotDir), { recursive: true, mode: 0o700 });
  const tmpRoot = await mkdtemp(path.join(tmpdir(), "little-harness-skill-clone-"));
  const cloneDir = path.join(tmpRoot, "repo");
  try {
    await mkdir(cloneDir, { recursive: true, mode: 0o700 });
    await runGit(initArgs(cloneDir), { auth, message: "Failed to initialize remote skill source" });
    await runGit(remoteAddArgs(cloneDir, source.cloneUrl), {
      auth,
      message: "Failed to configure remote skill source",
    });
    if (source.subpath !== undefined && source.subpath.length > 0) {
      await runGit(sparseCheckoutArgs(cloneDir, source.subpath), {
        auth,
        message: "Failed to configure sparse checkout for remote skill source",
      });
    }
    await runGit(fetchArgs(cloneDir, "origin", commitSha), {
      auth,
      message: "Failed to fetch remote skill source",
    });
    await runGit(["-C", cloneDir, "checkout", "--quiet", "--detach", "FETCH_HEAD"], {
      auth,
      message: "Failed to checkout remote skill source",
    });
    await rm(path.join(cloneDir, ".git"), { recursive: true, force: true });
    try {
      await rename(cloneDir, snapshotDir);
    } catch (error) {
      if (!existsSync(snapshotDir)) {
        throw error;
      }
    }
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
}

export type ResolvedGitAuth = {
  token: string;
  headerScope: string;
  credentialScope: GitCredentialScope;
};

type GitCredentialScope = {
  protocol: "https";
  host: string;
  path: string;
};

type GitInvocation = {
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  configPath?: string;
  authFilePaths?: string[];
  cleanup: () => Promise<void>;
};

function resolveGitAuth(
  source: ParsedRemoteSkillSource,
  explicitAuth: SkillGitAuth | undefined,
): ResolvedGitAuth | undefined {
  const token = explicitAuth?.type === "bearer" ? explicitAuth.token : envTokenForSource(source);
  const credentialScope = credentialScopeForSource(source);
  if (token === undefined || token.length === 0 || credentialScope === undefined) {
    return undefined;
  }

  return {
    token,
    headerScope: `https://${credentialScope.host}/`,
    credentialScope,
  };
}

function envTokenForSource(source: ParsedRemoteSkillSource): string | undefined {
  if (source.host === undefined || !isHttpsRemote(source.cloneUrl)) {
    return undefined;
  }
  const token = process.env.LITTLE_SKILLS_GIT_TOKEN;
  if (token === undefined || token.length === 0) {
    return undefined;
  }
  const allowedHosts = (process.env.LITTLE_SKILLS_GIT_TOKEN_HOSTS ?? "")
    .split(/[,\s]+/u)
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 0);
  if (!allowedHosts.includes(source.host.toLowerCase())) {
    return undefined;
  }
  return token;
}

function isHttpsRemote(cloneUrl: string): boolean {
  try {
    return new URL(cloneUrl).protocol === "https:";
  } catch {
    return false;
  }
}

function credentialScopeForSource(source: ParsedRemoteSkillSource): GitCredentialScope | undefined {
  try {
    const url = new URL(source.cloneUrl);
    if (url.protocol !== "https:" || url.hostname.length === 0) {
      return undefined;
    }
    const repoPath = normalizedCredentialPath(url.pathname);
    if (repoPath === undefined || repoPath.length === 0) {
      return undefined;
    }
    return {
      protocol: "https",
      host: url.host.toLowerCase(),
      path: repoPath,
    };
  } catch {
    return undefined;
  }
}

export function resolveGitAuthForTest(
  source: ParsedRemoteSkillSource,
  explicitAuth?: SkillGitAuth,
): ResolvedGitAuth | undefined {
  return resolveGitAuth(source, explicitAuth);
}

async function runGit(
  args: readonly string[],
  options: { auth: ResolvedGitAuth | undefined; message: string },
): Promise<string> {
  const invocation = await prepareGitInvocation(args, options.auth);
  try {
    const { stdout } = await execFileAsync("git", invocation.args, {
      cwd: invocation.cwd,
      env: invocation.env,
      maxBuffer: 10 * 1024 * 1024,
      timeout: GIT_TIMEOUT_MS,
    });
    return stdout.trim();
  } catch (error) {
    throw new HarnessInputError(options.message, {
      stderr: redactSecrets(stderrFromError(error), options.auth?.token),
    });
  } finally {
    await invocation.cleanup();
  }
}

async function prepareGitInvocation(
  args: readonly string[],
  auth: ResolvedGitAuth | undefined,
): Promise<GitInvocation> {
  const neutralContext = await createNeutralGitContext();
  const env: NodeJS.ProcessEnv = {
    ...sanitizedGitEnv(process.env),
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_LFS_SKIP_SMUDGE: "1",
    GIT_TERMINAL_PROMPT: "0",
    HOME: neutralContext.home,
    XDG_CONFIG_HOME: path.join(neutralContext.home, ".config"),
  };

  if (auth === undefined) {
    return {
      args: [...args],
      env,
      cwd: neutralContext.cwd,
      cleanup: neutralContext.cleanup,
    };
  }

  validateGitConfigValue(auth.token, "Git auth token");
  validateGitConfigValue(auth.headerScope, "Git auth scope");

  const authContext = await createGitAuthContext(auth);

  return {
    args: [...args],
    env: {
      ...env,
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "credential.helper",
      GIT_CONFIG_VALUE_0: `!${authContext.helperPath}`,
      GIT_CONFIG_KEY_1: "credential.useHttpPath",
      GIT_CONFIG_VALUE_1: "true",
      LITTLE_HARNESS_GIT_AUTH_CLIENT: authContext.clientPath,
      LITTLE_HARNESS_GIT_AUTH_NODE: process.execPath,
      LITTLE_HARNESS_GIT_AUTH_SOCKET: authContext.socketPath,
    },
    cwd: neutralContext.cwd,
    authFilePaths: [authContext.helperPath, authContext.clientPath],
    cleanup: async () => {
      await authContext.cleanup();
      await neutralContext.cleanup();
    },
  };
}

export async function prepareGitInvocationForTest(
  args: readonly string[],
  auth: ResolvedGitAuth | undefined,
): Promise<GitInvocation> {
  return prepareGitInvocation(args, auth);
}

function cloneArgs(
  cloneUrl: string,
  cloneDir: string,
  options: { shallow: boolean } = { shallow: true },
): string[] {
  const args = [
    "clone",
    "--quiet",
    "--no-checkout",
  ];
  if (options.shallow) {
    args.push("--depth=1", "--single-branch");
  }
  args.push("--filter=blob:none", "--no-tags");
  args.push(cloneUrl, cloneDir);
  return args;
}

export function cloneArgsForTest(cloneUrl: string, cloneDir: string): string[] {
  return cloneArgs(cloneUrl, cloneDir);
}

function initArgs(cloneDir: string): string[] {
  return ["init", "--quiet", cloneDir];
}

function remoteAddArgs(cloneDir: string, cloneUrl: string): string[] {
  return ["-C", cloneDir, "remote", "add", "origin", cloneUrl];
}

function fetchArgs(cloneDir: string, remote: string, commitSha: string): string[] {
  return [
    "-C",
    cloneDir,
    "fetch",
    "--quiet",
    "--depth=1",
    "--filter=blob:none",
    "--no-tags",
    remote,
    commitSha,
  ];
}

export function fetchArgsForTest(cloneDir: string, remote: string, commitSha: string): string[] {
  return fetchArgs(cloneDir, remote, commitSha);
}

function sparseCheckoutArgs(cloneDir: string, subpath: string): string[] {
  return ["-C", cloneDir, "sparse-checkout", "set", "--no-cone", subpath];
}

export function sparseCheckoutArgsForTest(cloneDir: string, subpath: string): string[] {
  return sparseCheckoutArgs(cloneDir, subpath);
}

type GitAuthContext = {
  helperPath: string;
  clientPath: string;
  socketPath: string;
  cleanup: () => Promise<void>;
};

type NeutralGitContext = {
  cwd: string;
  home: string;
  cleanup: () => Promise<void>;
};

async function createNeutralGitContext(): Promise<NeutralGitContext> {
  const tmpRoot = await mkdtemp(path.join(tmpdir(), "little-harness-git-"));
  await chmod(tmpRoot, 0o700);
  const cwd = path.join(tmpRoot, "cwd");
  const home = path.join(tmpRoot, "home");
  await Promise.all([
    mkdir(cwd, { recursive: true, mode: 0o700 }),
    mkdir(home, { recursive: true, mode: 0o700 }),
  ]);
  return {
    cwd,
    home,
    cleanup: async () => {
      await rm(tmpRoot, { recursive: true, force: true });
    },
  };
}

async function createGitAuthContext(auth: ResolvedGitAuth): Promise<GitAuthContext> {
  const tmpRoot = await mkdtemp(path.join(tmpdir(), "little-harness-git-auth-"));
  await chmod(tmpRoot, 0o700);
  const helperPath = path.join(tmpRoot, "credential-helper.sh");
  const clientPath = path.join(tmpRoot, "credential-client.cjs");
  const socketPath = path.join(tmpRoot, "credential.sock");
  const server = await startCredentialServer(socketPath, auth);

  await writeFile(helperPath, credentialHelperScript(), { encoding: "utf8", mode: 0o700 });
  await writeFile(clientPath, credentialClientScript(), { encoding: "utf8", mode: 0o700 });

  return {
    helperPath,
    clientPath,
    socketPath,
    cleanup: async () => {
      await closeServer(server);
      await rm(tmpRoot, { recursive: true, force: true });
    },
  };
}

async function startCredentialServer(socketPath: string, auth: ResolvedGitAuth): Promise<Server> {
  const server = createServer((socket) => {
    let request = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      request += chunk;
    });
    socket.on("end", () => {
      socket.end(credentialResponse(auth, request));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  server.unref();
  return server;
}

function credentialResponse(auth: ResolvedGitAuth, request: string): string {
  const parsed = parseCredentialRequest(request);
  if (
    parsed.protocol !== auth.credentialScope.protocol ||
    parsed.host?.toLowerCase() !== auth.credentialScope.host ||
    normalizedCredentialPath(parsed.path) !== auth.credentialScope.path
  ) {
    return "";
  }
  return `username=x-access-token\npassword=${auth.token}\n\n`;
}

export function credentialResponseForTest(auth: ResolvedGitAuth, request: string): string {
  return credentialResponse(auth, request);
}

function parseCredentialRequest(request: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of request.split("\n")) {
    const index = line.indexOf("=");
    if (index <= 0) {
      continue;
    }
    out[line.slice(0, index)] = line.slice(index + 1);
  }
  return out;
}

function normalizedCredentialPath(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return stripLeadingSlash(stripGitSuffix(value));
}

function stripLeadingSlash(value: string): string {
  return value.replace(/^\/+/u, "");
}

function stripGitSuffix(value: string): string {
  return value.replace(/\.git$/iu, "");
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

function credentialHelperScript(): string {
  return `#!/bin/sh
if [ "$1" != "get" ]; then
  exit 0
fi
exec "$LITTLE_HARNESS_GIT_AUTH_NODE" "$LITTLE_HARNESS_GIT_AUTH_CLIENT"
`;
}

function credentialClientScript(): string {
  return `"use strict";
const net = require("node:net");
const socketPath = process.env.LITTLE_HARNESS_GIT_AUTH_SOCKET;
if (!socketPath) {
  process.exit(1);
}
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdin += chunk;
});
process.stdin.on("end", () => {
  const socket = net.createConnection(socketPath);
  socket.on("data", (chunk) => {
    process.stdout.write(chunk);
  });
  socket.on("error", (error) => {
    process.stderr.write(error.message);
    process.exit(1);
  });
  socket.on("end", () => {
    process.exit(0);
  });
  socket.end(stdin);
});
`;
}

function validateGitConfigValue(value: string, label: string): void {
  if (/[\0\r\n]/u.test(value)) {
    throw new HarnessInputError(`${label} contains unsupported characters.`);
  }
}

function sanitizedGitEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (
      key.startsWith("GIT_") ||
      key === "SSH_ASKPASS" ||
      key === "SSH_AUTH_SOCK" ||
      key === "SSH_AGENT_PID" ||
      key === "LITTLE_SKILLS_GIT_TOKEN" ||
      key === "LITTLE_SKILLS_GIT_TOKEN_HOSTS"
    ) {
      continue;
    }
    out[key] = value;
  }
  return out;
}

function stderrFromError(error: unknown): string {
  if (typeof error === "object" && error !== null && "stderr" in error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    if (typeof stderr === "string") {
      return stderr;
    }
    if (stderr instanceof Uint8Array) {
      return new TextDecoder().decode(stderr);
    }
  }
  return "";
}

function redactSecrets(value: string, token: string | undefined): string {
  if (token === undefined || token.length === 0) {
    return value;
  }
  return value.split(token).join("[REDACTED]");
}

function snapshotPath(
  cacheDir: string,
  normalizedIdentity: string,
  commitSha: string,
  authScope: string,
  subpathScope: string,
): string {
  return path.join(cacheDir, "snapshots", hash(normalizedIdentity), authScope, subpathScope, commitSha);
}

function cacheScope(auth: ResolvedGitAuth | undefined): string {
  if (auth === undefined) {
    return "public";
  }
  return `auth-${hash(`${auth.headerScope}\0${auth.token}`)}`;
}

function subpathCacheScope(subpath: string | undefined): string {
  const normalized = normalizeSubpath(subpath);
  if (normalized === "") {
    return "root";
  }
  return `subpath-${hash(normalized)}`;
}

function normalizeSubpath(subpath: string | undefined): string {
  if (subpath === undefined || subpath.length === 0) {
    return "";
  }
  const normalized = path.posix.normalize(subpath.replace(/\\/gu, "/"));
  return normalized.replace(/^\/+/u, "").replace(/\/+$/u, "").replace(/^\.$/u, "");
}

export function cacheScopeForTest(auth: ResolvedGitAuth): string {
  return cacheScope(auth);
}

export function snapshotPathForTest(
  cacheDir: string,
  source: ParsedRemoteSkillSource,
  auth: SkillGitAuth | undefined,
): string {
  return snapshotPath(
    cacheDir,
    normalizeRemoteIdentity(source.cloneUrl),
    source.ref ?? "HEAD",
    cacheScope(resolveGitAuth(source, auth)),
    subpathCacheScope(source.subpath),
  );
}

function normalizeRemoteIdentity(cloneUrl: string): string {
  try {
    const url = new URL(cloneUrl);
    url.username = "";
    url.password = "";
    url.hash = "";
    url.search = "";
    url.hostname = url.hostname.toLowerCase();
    return url.toString();
  } catch {
    return cloneUrl.replace(/^[^@\s]+@/u, "git@");
  }
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function isFullCommitSha(value: string): boolean {
  return /^[a-f0-9]{40}$/iu.test(value);
}
