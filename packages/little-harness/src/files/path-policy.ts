import * as path from "node:path";
import { HarnessPathError } from "../errors.js";
import type { LocalSessionPaths } from "../local-host/paths.js";

export type ManagedRoot = "session" | "artifacts" | "persistent" | "agents";

export type ResolvedHarnessPath = {
  root: ManagedRoot;
  harnessPath: string;
  relativePath: string;
  realPath: string;
};

export type HarnessPathPolicy = {
  readOnlyPersistentDirs?: readonly string[];
  bypassReadOnly?: boolean | undefined;
};

const ROOTS: Record<ManagedRoot, string> = {
  session: "/session",
  artifacts: "/artifacts",
  persistent: "/persistent",
  agents: "/.agents",
};

export function resolveHarnessPath(
  paths: LocalSessionPaths,
  harnessPath: string,
  operation: "read" | "write" | "delete" | "list",
  policy: HarnessPathPolicy = {},
): ResolvedHarnessPath {
  if (!harnessPath.startsWith("/")) {
    throw new HarnessPathError("Harness paths must be absolute", { path: harnessPath });
  }

  if (harnessPath.includes("\0")) {
    throw new HarnessPathError("Harness paths cannot contain NUL bytes", { path: harnessPath });
  }

  if (harnessPath.split("/").includes("..")) {
    throw new HarnessPathError("Harness paths cannot use traversal segments", {
      path: harnessPath,
    });
  }

  const normalized = path.posix.normalize(harnessPath);
  const root = findRoot(normalized);
  if (!root) {
    throw new HarnessPathError("Harness path must be inside a managed root", {
      path: harnessPath,
      roots: Object.values(ROOTS),
    });
  }

  if (root === "agents" && operation !== "read" && operation !== "list") {
    throw new HarnessPathError("Skills are read-only", { path: harnessPath });
  }

  if (
    root === "persistent" &&
    !policy.bypassReadOnly &&
    (operation === "write" || operation === "delete") &&
    isInsideReadOnlyPersistentDir(normalized, policy.readOnlyPersistentDirs ?? [])
  ) {
    throw new HarnessPathError("Persistent Dir is read-only", { path: harnessPath });
  }

  const relativePath = normalized === ROOTS[root] ? "" : normalized.slice(ROOTS[root].length + 1);
  const rootDir =
    root === "session"
      ? paths.sessionDir
      : root === "artifacts"
        ? paths.artifactsDir
        : root === "persistent"
          ? paths.persistentCheckoutDir
          : paths.agentsDir;

  return {
    root,
    harnessPath: normalized,
    relativePath,
    realPath: path.join(rootDir, relativePath),
  };
}

export function toHarnessPath(root: ManagedRoot, relativePath: string): string {
  const clean = relativePath.split(path.sep).join("/");
  return clean ? `${ROOTS[root]}/${clean}` : ROOTS[root];
}

function findRoot(harnessPath: string): ManagedRoot | undefined {
  for (const [root, prefix] of Object.entries(ROOTS) as Array<[ManagedRoot, string]>) {
    if (harnessPath === prefix || harnessPath.startsWith(`${prefix}/`)) {
      return root;
    }
  }

  return undefined;
}

function isInsideReadOnlyPersistentDir(
  harnessPath: string,
  readOnlyPersistentDirs: readonly string[],
): boolean {
  return readOnlyPersistentDirs.some((dir) => {
    const normalized = normalizeHarnessPrefix(dir);
    return harnessPath === normalized || harnessPath.startsWith(`${normalized}/`);
  });
}

export function normalizeHarnessPrefix(harnessPath: string): string {
  const normalized = path.posix.normalize(harnessPath);
  return normalized === "/" ? normalized : normalized.replace(/\/+$/u, "");
}
