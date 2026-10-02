import { readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { init, parse } from "es-module-lexer";
import { sha256Digest } from "../canonical.js";
import { createWorkflowJiti } from "./module-loader.js";

export type ImportGraphHashOptions = {
  readonly workspaceRoot: string;
  readonly entries: readonly string[];
  readonly sourceIdentity?: string;
};

export type ImportGraphHashResult = {
  readonly hash: string;
  readonly hasDynamicOrUnresolvedLocal: boolean;
  readonly unresolved: readonly string[];
  readonly dynamic: readonly string[];
};

const PARSE_EXTENSIONS = new Set([".ts", ".js", ".mts", ".mjs", ".cts", ".cjs"]);
const CJS_REQUIRE_PATTERN = /\brequire\s*\(\s*["']([^"']+)["']\s*\)/gu;

export async function hashImportGraph(options: ImportGraphHashOptions): Promise<ImportGraphHashResult> {
  await init;
  const workspaceRoot = resolve(options.workspaceRoot);
  const workspaceReal = await realpath(workspaceRoot);
  const jiti = createWorkflowJiti(workspaceRoot);
  const visited = new Set<string>();
  const files: Array<{ path: string; hash: string }> = [];
  const externals = new Map<string, string>();
  const unresolved: string[] = [];
  const dynamic: string[] = [];

  async function visit(filePath: string, includeLocalSource: boolean): Promise<void> {
    const actual = await resolveExistingFile(filePath);
    if (actual === undefined) {
      unresolved.push(filePath);
      return;
    }
    const real = await realpath(actual);
    if (visited.has(real)) return;
    visited.add(real);

    const shouldHashSource = includeLocalSource || isUnder(real, workspaceReal);
    if (!shouldHashSource) {
      const identity = await packageIdentityFor(real);
      externals.set(identity, identity);
      return;
    }

    const contents = await readFile(real, "utf8");
    files.push({ path: normalizeRelative(workspaceReal, real), hash: sha256Digest(contents) });

    if (!PARSE_EXTENSIONS.has(extname(real))) return;
    const [imports] = parse(contents);
    for (const entry of imports) {
      const specifier = entry.n;
      if (entry.d > -1) {
        dynamic.push(`${normalizeRelative(workspaceReal, real)}:${specifier ?? "<dynamic>"}`);
        continue;
      }
      if (specifier === undefined) continue;
      await resolveAndVisit(specifier, real);
    }

    for (const match of contents.matchAll(CJS_REQUIRE_PATTERN)) {
      const specifier = match[1];
      if (specifier !== undefined) await resolveAndVisit(specifier, real);
    }
  }

  async function resolveAndVisit(specifier: string, parent: string): Promise<void> {
    const isLocal = isLocalSpecifier(specifier);
    let resolved: string | undefined;
    try {
      resolved = jiti.esmResolve(specifier, pathToFileURL(parent).href);
    } catch {
      resolved = await resolveLocalFallback(specifier, parent);
    }
    if (resolved === undefined) {
      if (isLocal) unresolved.push(`${normalizeRelative(workspaceReal, parent)}:${specifier}`);
      else externals.set(specifier, specifier);
      return;
    }

    const path = pathFromResolved(resolved);
    if (path === undefined) {
      externals.set(`${specifier}@${resolved}`, `${specifier}@${resolved}`);
      return;
    }
    const includeLocalSource = shouldIncludeLocalSource(specifier, path);
    await visit(path, includeLocalSource);
  }

  for (const entry of options.entries) {
    await visit(entry, true);
  }

  const snapshot = {
    files: files.sort((a, b) => a.path.localeCompare(b.path)),
    externals: [...externals.values()].sort(),
    dynamic: [...dynamic].sort(),
    unresolved: [...unresolved].sort(),
    sourceIdentity: options.sourceIdentity ?? "",
  };
  return {
    hash: sha256Digest(snapshot),
    hasDynamicOrUnresolvedLocal: dynamic.length > 0 || unresolved.length > 0,
    unresolved: snapshot.unresolved,
    dynamic: snapshot.dynamic,
  };
}

function pathFromResolved(resolved: string): string | undefined {
  if (resolved.startsWith("file:")) return fileURLToPath(resolved);
  if (isAbsolute(resolved)) return resolved;
  return undefined;
}

async function resolveExistingFile(filePath: string): Promise<string | undefined> {
  const direct = await existingFile(filePath);
  if (direct !== undefined) return direct;
  const parsedExt = extname(filePath);
  if (parsedExt === ".js" || parsedExt === ".mjs" || parsedExt === ".cjs") {
    const base = filePath.slice(0, -parsedExt.length);
    for (const ext of [".ts", ".mts", ".cts"]) {
      const candidate = await existingFile(`${base}${ext}`);
      if (candidate !== undefined) return candidate;
    }
  }
  return undefined;
}

async function existingFile(filePath: string): Promise<string | undefined> {
  try {
    const stats = await stat(filePath);
    return stats.isFile() ? filePath : undefined;
  } catch {
    return undefined;
  }
}

async function resolveLocalFallback(specifier: string, parent: string): Promise<string | undefined> {
  if (!isLocalSpecifier(specifier)) return undefined;
  const base = resolve(dirname(parent), specifier);
  const direct = await resolveExistingFile(base);
  if (direct !== undefined) return direct;
  for (const ext of [".ts", ".js", ".mts", ".mjs", ".cts", ".cjs"]) {
    const withExt = await resolveExistingFile(`${base}${ext}`);
    if (withExt !== undefined) return withExt;
  }
  for (const ext of [".ts", ".js", ".mts", ".mjs", ".cts", ".cjs"]) {
    const index = await resolveExistingFile(join(base, `index${ext}`));
    if (index !== undefined) return index;
  }
  return undefined;
}

function isLocalSpecifier(specifier: string): boolean {
  return isPathLocalSpecifier(specifier) || specifier.startsWith("file:");
}

function isPathLocalSpecifier(specifier: string): boolean {
  return specifier.startsWith("./") || specifier.startsWith("../") || specifier.startsWith("/");
}

function shouldIncludeLocalSource(specifier: string, resolvedPath: string): boolean {
  if (isPathLocalSpecifier(specifier)) return true;
  if (specifier.startsWith("file:")) return false;
  return !hasNodeModulesSegment(resolvedPath);
}

function hasNodeModulesSegment(path: string): boolean {
  return path.split(sep).includes("node_modules");
}

function isUnder(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}${sep}`);
}

function normalizeRelative(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

async function packageIdentityFor(path: string): Promise<string> {
  let dir = dirname(path);
  while (true) {
    try {
      const packageJson = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as {
        name?: unknown;
        version?: unknown;
      };
      // Never fold an absolute, machine-specific path into the identity; a
      // nameless package falls back to a portable basename label so the hash
      // stays stable across machines/checkout locations.
      const name = typeof packageJson.name === "string" ? packageJson.name : basename(dir);
      const version = typeof packageJson.version === "string" ? packageJson.version : "0.0.0";
      return `${name}@${version}`;
    } catch {
      const parent = dirname(dir);
      if (parent === dir) return basename(dirname(path));
      dir = parent;
    }
  }
}
