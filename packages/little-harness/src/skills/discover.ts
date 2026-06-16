import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import * as path from "node:path";
import { HarnessInputError } from "../errors.js";
import type { ResolvedRemoteSkillSource, ResolvedSkill, RemoteSkillOptions } from "../types.js";
import type { ParsedRemoteSkillSource } from "./remote-source.js";

type DiscoveredSkill = {
  name: string;
  displayName?: string;
  description: string;
  internal: boolean;
  root: string;
  skillPath: string;
};

const MAX_DISCOVERY_FILES = 5000;
const MAX_SELECTED_SKILLS = 32;
const MAX_SKILL_FILES = 256;
const MAX_SKILL_FILE_BYTES = 1024 * 1024;
const MAX_SKILL_TOTAL_BYTES = 4 * 1024 * 1024;
const MAX_SKILL_DEPTH = 16;
const REMOTE_SKILL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const WINDOWS_RESERVED_NAMES = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "COM1",
  "COM2",
  "COM3",
  "COM4",
  "COM5",
  "COM6",
  "COM7",
  "COM8",
  "COM9",
  "LPT1",
  "LPT2",
  "LPT3",
  "LPT4",
  "LPT5",
  "LPT6",
  "LPT7",
  "LPT8",
  "LPT9",
]);

export async function discoverRemoteSkills(
  source: ParsedRemoteSkillSource,
  snapshotDir: string,
  options: Pick<RemoteSkillOptions, "skills"> & { readonly commitSha?: string } = {},
): Promise<ResolvedSkill[]> {
  const root = resolveSnapshotRoot(snapshotDir, source.subpath);
  const discovered = await findSkillDirectories(root);
  const requested = options.skills?.filter((item) => item.trim().length > 0);
  const selected = requested !== undefined && requested.length > 0
    ? selectRequested(discovered, requested)
    : discovered.filter((item) => !item.internal);

  if (selected.length === 0) {
    throw new HarnessInputError("No valid skills found in remote source", {
      source: source.original,
      discovered: discovered.map((item) => item.name),
    });
  }
  if (selected.length > MAX_SELECTED_SKILLS) {
    throw new HarnessInputError("Remote source has too many selected skills", {
      source: source.original,
      selected: selected.length,
      maxSelectedSkills: MAX_SELECTED_SKILLS,
    });
  }

  const out: ResolvedSkill[] = [];
  for (const item of selected) {
    const files = await readTree(item.root);
    out.push({
      name: item.name,
      description: item.description,
      harnessDir: `.agents/skills/${item.name}`,
      files,
      ...(options.commitSha === undefined
        ? {}
        : { source: remoteSkillSourceMetadata(source, item, options.commitSha, files) }),
    });
  }
  return out;
}

function remoteSkillSourceMetadata(
  source: ParsedRemoteSkillSource,
  skill: DiscoveredSkill,
  commitSha: string,
  files: Record<string, Uint8Array>,
): ResolvedRemoteSkillSource {
  return {
    type: "remote-git",
    original: source.original,
    cloneUrl: source.cloneUrl,
    provider: source.provider,
    ...(source.host === undefined ? {} : { host: source.host }),
    ...(source.ownerRepo === undefined ? {} : { ownerRepo: source.ownerRepo }),
    ...(source.ref === undefined ? {} : { ref: source.ref }),
    ...(source.subpath === undefined ? {} : { subpath: source.subpath }),
    commitSha,
    selectedSkill: skill.name,
    skillPath: skill.skillPath,
    contentHash: hashSkillFiles(files),
  };
}

function selectRequested(discovered: readonly DiscoveredSkill[], requested: readonly string[]) {
  const selected: DiscoveredSkill[] = [];
  const missing: string[] = [];

  for (const request of requested) {
    const normalized = normalizeName(request);
    const match = discovered.find((item) =>
      normalizeName(item.name) === normalized ||
      (item.displayName !== undefined && normalizeName(item.displayName) === normalized)
    );
    if (match === undefined) {
      missing.push(request);
    } else if (!selected.includes(match)) {
      selected.push(match);
    }
  }

  if (missing.length > 0) {
    throw new HarnessInputError(
      `Requested remote skills were not found: ${missing.join(", ")}. Discovered: ${discovered
        .map((item) => item.name)
        .join(", ")}`,
      {
      missing,
      discovered: discovered.map((item) => item.name),
      },
    );
  }

  return selected;
}

async function findSkillDirectories(root: string): Promise<DiscoveredSkill[]> {
  const out: DiscoveredSkill[] = [];
  await walk(root, { maxFiles: MAX_DISCOVERY_FILES }, async (entryPath, relativePath) => {
    if (path.basename(entryPath) !== "SKILL.md") {
      return;
    }
    await assertFileWithinLimit(entryPath, "Remote skill manifest");
    const markdown = await readFile(entryPath, "utf8");
    const metadata = parseSkillFrontmatter(markdown);
    if (metadata.name === undefined || metadata.description === undefined) {
      return;
    }
    const name = validateRemoteSkillName(metadata.name, relativePath);
    out.push({
      name,
      ...(metadata.displayName === undefined ? {} : { displayName: metadata.displayName }),
      description: metadata.description,
      internal: metadata.internal,
      root: path.dirname(entryPath),
      skillPath: path.dirname(relativePath) === "." ? "" : path.dirname(relativePath),
    });
  });
  assertNoCanonicalNameCollisions(out);
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function hashSkillFiles(files: Record<string, Uint8Array>): string {
  const hash = createHash("sha256");
  for (const [filePath, contents] of Object.entries(files).sort(([left], [right]) => left.localeCompare(right))) {
    hash.update(filePath, "utf8");
    hash.update("\0", "utf8");
    hash.update(contents);
    hash.update("\0", "utf8");
  }
  return `sha256:${hash.digest("hex")}`;
}

function validateRemoteSkillName(name: string, manifestPath: string): string {
  const trimmed = name.trim();
  if (
    trimmed.length === 0 ||
    trimmed !== name ||
    name.normalize("NFC") !== name ||
    !REMOTE_SKILL_NAME_PATTERN.test(name) ||
    name.endsWith(".") ||
    trimmed === "." ||
    trimmed === ".." ||
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    isWindowsReservedName(name)
  ) {
    throw new HarnessInputError("Invalid remote skill name", {
      name,
      manifest: manifestPath,
    });
  }
  return name;
}

function assertNoCanonicalNameCollisions(discovered: readonly DiscoveredSkill[]): void {
  const seen = new Map<string, string>();
  for (const item of discovered) {
    const canonical = canonicalRemoteSkillName(item.name);
    const existing = seen.get(canonical);
    if (existing !== undefined) {
      throw new HarnessInputError("Remote skill names collide after canonicalization", {
        names: [existing, item.name],
      });
    }
    seen.set(canonical, item.name);
  }
}

function canonicalRemoteSkillName(name: string): string {
  return name.normalize("NFC").toLowerCase();
}

function isWindowsReservedName(name: string): boolean {
  return WINDOWS_RESERVED_NAMES.has(name.split(".")[0]!.toUpperCase());
}

type WalkLimits = {
  maxFiles: number;
  files?: number;
};

async function walk(
  root: string,
  limits: WalkLimits,
  visit: (filePath: string, relativePath: string) => Promise<void>,
  relative = "",
): Promise<void> {
  assertDepthWithinLimit(relative);
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  for (const entry of entries) {
    const next = relative ? path.join(relative, entry.name) : entry.name;
    if (entry.isDirectory()) {
      await walk(root, limits, visit, next);
    } else if (entry.isFile()) {
      limits.files = (limits.files ?? 0) + 1;
      if (limits.files > limits.maxFiles) {
        throw new HarnessInputError("Remote skill source exceeds file count limit", {
          maxFiles: limits.maxFiles,
        });
      }
      await visit(path.join(root, next), next.split(path.sep).join("/"));
    }
  }
}

function resolveSnapshotRoot(snapshotDir: string, subpath: string | undefined): string {
  if (subpath === undefined || subpath.length === 0) {
    return snapshotDir;
  }
  const root = path.resolve(snapshotDir, subpath);
  const relative = path.relative(snapshotDir, root);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new HarnessInputError("Remote skill subpath resolves outside snapshot", { subpath });
  }
  return root;
}

function parseSkillFrontmatter(markdown: string): {
  name?: string;
  displayName?: string;
  description?: string;
  internal: boolean;
} {
  if (!markdown.startsWith("---\n")) {
    return { internal: false };
  }

  const end = markdown.indexOf("\n---", 4);
  if (end === -1) {
    return { internal: false };
  }

  const out: { name?: string; displayName?: string; description?: string; internal: boolean } = {
    internal: false,
  };
  let inMetadata = false;

  for (const line of markdown.slice(4, end).split("\n")) {
    if (/^metadata:\s*$/u.test(line)) {
      inMetadata = true;
      continue;
    }

    const nestedInternal = /^  internal:\s*(true|false)\s*$/iu.exec(line);
    if (inMetadata && nestedInternal !== null) {
      out.internal = nestedInternal[1]?.toLowerCase() === "true";
      continue;
    }

    if (!line.startsWith(" ")) {
      inMetadata = false;
    }

    const match = /^([a-zA-Z0-9_.-]+):\s*(.*)$/u.exec(line);
    if (match === null) {
      continue;
    }

    const key = match[1];
    const value = (match[2] ?? "").replace(/^["']|["']$/g, "");
    if (key === "name") {
      out.name = value;
    } else if (key === "display_name" || key === "displayName") {
      out.displayName = value;
    } else if (key === "description") {
      out.description = value;
    } else if (key === "metadata.internal") {
      out.internal = value.toLowerCase() === "true";
    }
  }

  return out;
}

type ReadTreeState = {
  files: number;
  bytes: number;
};

async function readTree(
  root: string,
  relative = "",
  state: ReadTreeState = { files: 0, bytes: 0 },
): Promise<Record<string, Uint8Array>> {
  assertDepthWithinLimit(relative);
  const files: Record<string, Uint8Array> = {};
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  for (const entry of entries) {
    const next = relative ? path.join(relative, entry.name) : entry.name;
    if (entry.isDirectory()) {
      Object.assign(files, await readTree(root, next, state));
    } else if (entry.isFile()) {
      state.files += 1;
      if (state.files > MAX_SKILL_FILES) {
        throw new HarnessInputError("Remote skill exceeds file count limit", {
          maxFiles: MAX_SKILL_FILES,
        });
      }
      const filePath = path.join(root, next);
      const fileStat = await assertFileWithinLimit(filePath, "Remote skill file", next);
      state.bytes += fileStat.size;
      if (state.bytes > MAX_SKILL_TOTAL_BYTES) {
        throw new HarnessInputError("Remote skill exceeds total size limit", {
          maxBytes: MAX_SKILL_TOTAL_BYTES,
        });
      }
      files[next.split(path.sep).join("/")] = await readFile(filePath);
    }
  }
  return files;
}

async function assertFileWithinLimit(
  filePath: string,
  label: string,
  relativePath = path.basename(filePath),
): Promise<{ size: number }> {
  const fileStat = await stat(filePath);
  if (fileStat.size > MAX_SKILL_FILE_BYTES) {
    throw new HarnessInputError(`${label} exceeds file size limit`, {
      file: relativePath.split(path.sep).join("/"),
      bytes: fileStat.size,
      maxBytes: MAX_SKILL_FILE_BYTES,
    });
  }
  return { size: fileStat.size };
}

function assertDepthWithinLimit(relative: string): void {
  if (relative.length === 0) {
    return;
  }
  const depth = relative.split(path.sep).filter((segment) => segment.length > 0).length;
  if (depth > MAX_SKILL_DEPTH) {
    throw new HarnessInputError("Remote skill source exceeds directory depth limit", {
      maxDepth: MAX_SKILL_DEPTH,
    });
  }
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase();
}
