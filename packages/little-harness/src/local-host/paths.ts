import { join, relative, resolve } from "node:path";
import { HarnessPathError } from "../errors.js";

export type LocalHostPathOptions = {
  dataDir?: string;
  projectRoot?: string;
};

export type LocalHostPaths = {
  dataDir: string;
  projectRoot: string;
  sessionsDir: string;
  persistentDir: string;
  locksDir: string;
};

export type LocalSessionPaths = {
  root: string;
  sessionDir: string;
  artifactsDir: string;
  persistentCheckoutDir: string;
  agentsDir: string;
  turnsDir: string;
  traceFile: string;
  statusFile: string;
};

export function resolveLocalHostPaths(
  options: LocalHostPathOptions,
  cwd = process.cwd(),
): LocalHostPaths {
  const dataDir = resolve(cwd, options.dataDir ?? ".little-harness");
  const projectRoot = resolve(cwd, options.projectRoot ?? cwd);

  return {
    dataDir,
    projectRoot,
    sessionsDir: join(dataDir, "sessions"),
    persistentDir: join(dataDir, "persistent"),
    locksDir: join(dataDir, "locks"),
  };
}

export function sessionPaths(paths: LocalHostPaths, pathKey: string): LocalSessionPaths {
  const root = join(paths.sessionsDir, pathKey);
  return {
    root,
    sessionDir: join(root, "session"),
    artifactsDir: join(root, "artifacts"),
    persistentCheckoutDir: join(root, "persistent"),
    agentsDir: join(root, ".agents"),
    turnsDir: join(root, "turns"),
    traceFile: join(root, "trace.ndjson"),
    statusFile: join(root, "status.json"),
  };
}

export function assertInsideRoot(path: string, root: string, label: string): string {
  const resolvedPath = resolve(path);
  const resolvedRoot = resolve(root);
  const rel = relative(resolvedRoot, resolvedPath);

  if (rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"))) {
    return resolvedPath;
  }

  throw new HarnessPathError(`${label} resolves outside projectRoot`, {
    path: resolvedPath,
    projectRoot: resolvedRoot,
  });
}

export function resolveProjectDirSource(input: string, projectRoot: string): string {
  return assertInsideRoot(resolve(projectRoot, input), projectRoot, "projectDir");
}
