import { HarnessInputError } from "../errors.js";
import { localDir } from "../local-host/local-dir.js";
import type {
  FileEntry,
  FileWriter,
  HarnessMemoryOptions,
  HarnessWarning,
  PersistentDir,
  ResolvedHarnessMemoryConfig,
} from "../types.js";

export const DEFAULT_MEMORY_HARNESS_DIR = "/persistent/memory";
export const DEFAULT_MEMORY_MAX_INDEX_BYTES = 8000;
/** Most characters of `instructions` one memory may show every turn. */
export const MAX_MEMORY_INSTRUCTIONS_CHARS = 4096;
/** Characters of a memory shown in the index; the rest stays in its file. */
export const MEMORY_INDEX_SUMMARY_CHARS = 600;
/** Larger files are listed by name only, so a stray upload is not read every turn. */
const MAX_SUMMARIZED_FILE_BYTES = 1024 * 1024;

export type ResolvedHarnessMemory<TExtraBody = unknown> = {
  persistentDirs: PersistentDir<TExtraBody>[];
  configs: ResolvedHarnessMemoryConfig[];
};

export function memory<TExtraBody = unknown>(
  options: HarnessMemoryOptions<TExtraBody>,
): HarnessMemoryOptions<TExtraBody> {
  return options;
}

export function resolveHarnessMemory<TExtraBody = unknown>(
  options: HarnessMemoryOptions<TExtraBody> | readonly HarnessMemoryOptions<TExtraBody>[] | undefined,
): ResolvedHarnessMemory<TExtraBody> {
  const layers: readonly HarnessMemoryOptions<TExtraBody>[] =
    options === undefined ? [] : Array.isArray(options) ? options : [options as HarnessMemoryOptions<TExtraBody>];
  const resolved: ResolvedHarnessMemory<TExtraBody> = { persistentDirs: [], configs: [] };
  for (const layer of layers) {
    const one = resolveMemoryLayer(layer);
    for (const other of resolved.configs) {
      if (
        other.harnessDir === one.config.harnessDir ||
        other.harnessDir.startsWith(`${one.config.harnessDir}/`) ||
        one.config.harnessDir.startsWith(`${other.harnessDir}/`)
      ) {
        throw new HarnessInputError("Each memory needs its own harnessDir, not inside another memory.", {
          harnessDir: one.config.harnessDir,
          other: other.harnessDir,
        });
      }
    }
    resolved.persistentDirs.push(one.persistentDir);
    resolved.configs.push(one.config);
  }
  return resolved;
}

/** Options the remember-tool memory took; memory is now files and a skill, so they do nothing. */
const REMOVED_MEMORY_OPTIONS = ["tool", "indexPath", "maxEntryBytes", "now"] as const;

function resolveMemoryLayer<TExtraBody>(
  options: HarnessMemoryOptions<TExtraBody>,
): { persistentDir: PersistentDir<TExtraBody>; config: ResolvedHarnessMemoryConfig } {
  for (const key of REMOVED_MEMORY_OPTIONS) {
    if ((options as Record<string, unknown>)[key] !== undefined) {
      throw new HarnessInputError(
        `Memory option ${key} was removed: memory is now files the agent changes with its file tools, plus a built-in memory skill.`,
        { option: key },
      );
    }
  }
  const harnessDir = canonicalizePersistentHarnessDir(options.harnessDir ?? DEFAULT_MEMORY_HARNESS_DIR);
  const commit = resolveMemoryCommit(options.commit);
  const maxIndexBytes = options.maxIndexBytes ?? DEFAULT_MEMORY_MAX_INDEX_BYTES;
  if (!Number.isInteger(maxIndexBytes) || maxIndexBytes <= 0) {
    throw new HarnessInputError("Memory maxIndexBytes must be a positive integer.", { maxIndexBytes });
  }
  if (options.description !== undefined && typeof options.description !== "string") {
    throw new HarnessInputError("Memory description must be a string.", { harnessDir });
  }
  if (options.instructions !== undefined) {
    if (typeof options.instructions !== "string") {
      throw new HarnessInputError("Memory instructions must be a string.", { harnessDir });
    }
    if (options.instructions.length > MAX_MEMORY_INSTRUCTIONS_CHARS) {
      throw new HarnessInputError(
        `Memory instructions must be at most ${MAX_MEMORY_INSTRUCTIONS_CHARS} characters.`,
        { harnessDir, length: options.instructions.length },
      );
    }
  }
  if (options.skill !== undefined && options.skill !== false) {
    throw new HarnessInputError(
      "Memory skill takes only false. To use your own skill, add a skill named memory to skills.",
      { harnessDir },
    );
  }
  if (options.canWrite !== undefined && typeof options.canWrite !== "function") {
    throw new HarnessInputError("Memory canWrite must be a function.", { harnessDir });
  }
  const hasSource = options.sourceDir !== undefined;
  const hasBackend = options.backend !== undefined;
  if (hasSource === hasBackend) {
    throw new HarnessInputError("Memory needs exactly one of sourceDir or backend.", { harnessDir });
  }
  if (hasBackend && typeof options.backend?.load !== "function") {
    throw new HarnessInputError("Memory backend must have a load function.", { harnessDir });
  }

  const config: ResolvedHarnessMemoryConfig = {
    harnessDir,
    commit,
    maxIndexBytes,
    skill: options.skill !== false,
  };
  const description = options.description?.trim();
  if (description) {
    config.description = description;
  }
  const instructions = options.instructions?.trim();
  if (instructions) {
    config.instructions = instructions;
  }

  let persistentDir: PersistentDir<TExtraBody>;
  if (options.backend) {
    const backend = options.backend;
    persistentDir = { harnessDir, commit, load: (loadOptions) => backend.load(loadOptions) };
    if (backend.store) {
      const store = backend.store;
      persistentDir.store = (storeOptions) => store(storeOptions);
    }
  } else {
    persistentDir = localDir({ harnessDir, sourceDir: options.sourceDir!, commit });
  }
  if (options.canWrite) {
    persistentDir.canWrite = options.canWrite;
  }
  return { persistentDir, config };
}

export type MemorySystemContextOptions = {
  /** The turn's read-only Persistent Dirs (`session.getReadOnlyPersistentDirs()`), after load. */
  readOnlyDirs: readonly string[];
  /** Whether a skill named `memory` is in this turn's skill list. */
  hasMemorySkill: boolean;
};

export type MemorySystemContext = {
  text: string | undefined;
  warnings: HarnessWarning[];
};

/**
 * What the model sees about memory every turn: for each memory, where it is, what it holds,
 * whether this turn may change it, and one line per file. The harness keeps no index file: the
 * list is built from the files, so it cannot drift from them or lose a line to a concurrent turn.
 */
export async function buildMemorySystemContext(
  configs: readonly ResolvedHarnessMemoryConfig[],
  files: FileWriter,
  options: MemorySystemContextOptions,
): Promise<MemorySystemContext> {
  const warnings: HarnessWarning[] = [];
  if (configs.length === 0) {
    return { text: undefined, warnings };
  }

  const sections: string[] = [
    "# Memory\n\nLong-term memory is kept as files in the folders below. It carries over to later conversations.",
  ];
  for (const config of configs) {
    const writable = !options.readOnlyDirs.some(
      (dir) => config.harnessDir === dir || config.harnessDir.startsWith(`${dir}/`),
    );
    const index = await buildMemoryIndex(files, config);
    if (index.omitted > 0) {
      warnings.push({
        code: "policy_warning",
        message:
          `Memory ${config.harnessDir} lists ${index.shown} of ${index.shown + index.omitted} files; ` +
          "raise maxIndexBytes or keep fewer, shorter memories.",
        metadata: {
          reason: "memory_index_truncated",
          harnessDir: config.harnessDir,
          shown: index.shown,
          omitted: index.omitted,
        },
      });
    }
    const lines = [
      `## ${config.harnessDir}`,
      config.description,
      writable
        ? "You may change this memory in this conversation." +
          (config.skill && options.hasMemorySkill
            ? " Read the memory skill before you save, change or forget anything here."
            : "")
        : "This memory is read-only in this conversation: use it, but do not change it. " +
          "If someone asks you to change it, say you can't here.",
      config.instructions,
      index.text,
    ].filter((value): value is string => typeof value === "string" && value.length > 0);
    sections.push(lines.join("\n"));
  }
  return { text: sections.join("\n\n"), warnings };
}

type MemoryIndex = { text: string; shown: number; omitted: number };

async function buildMemoryIndex(
  files: FileWriter,
  config: ResolvedHarnessMemoryConfig,
): Promise<MemoryIndex> {
  let entries: FileEntry[];
  try {
    entries = await files.list(config.harnessDir, { recursive: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      entries = [];
    } else {
      throw error;
    }
  }
  // Hidden files (.gitkeep, .DS_Store) are not memories; they stay mounted but are not listed.
  const memoryFiles = entries
    .filter((entry) => entry.kind === "file" && entry.path.startsWith(`${config.harnessDir}/`))
    .map((entry) => ({ ...entry, relative: entry.path.slice(config.harnessDir.length + 1) }))
    .filter((entry) => !entry.relative.split("/").some((part) => part.startsWith(".")))
    .sort((left, right) => (left.relative < right.relative ? -1 : left.relative > right.relative ? 1 : 0));
  if (memoryFiles.length === 0) {
    return { text: "No memories yet.", shown: 0, omitted: 0 };
  }

  const header = "Files (one line each):";
  const lines: string[] = [];
  let bytes = utf8Bytes(header);
  let omitted = 0;
  for (const file of memoryFiles) {
    if (omitted > 0) {
      omitted += 1;
      continue;
    }
    const summary =
      file.bytes !== undefined && file.bytes > MAX_SUMMARIZED_FILE_BYTES
        ? undefined
        : memorySummary((await files.read(file.path)).content);
    const line = summary === undefined ? `- ${file.relative}` : `- ${file.relative}: ${summary}`;
    const lineBytes = utf8Bytes(line) + 1;
    if (bytes + lineBytes > config.maxIndexBytes) {
      omitted = 1;
      continue;
    }
    lines.push(line);
    bytes += lineBytes;
  }
  if (omitted > 0) {
    lines.push(`- … ${omitted} more not shown. List ${config.harnessDir} to see them.`);
  }
  return { text: [header, ...lines].join("\n"), shown: memoryFiles.length - omitted, omitted };
}

/**
 * One line for a memory file: its frontmatter `description` when it has one, else the start of
 * its text. It keeps the memory's own words, collapsing only whitespace, because later turns
 * often act on this line without opening the file. Binary files get no summary.
 */
export function memorySummary(content: Uint8Array): string | undefined {
  if (content.includes(0)) {
    return undefined;
  }
  const text = new TextDecoder().decode(content);
  const { frontmatter, body } = splitFrontmatter(text);
  const description = frontmatter === undefined ? undefined : frontmatterValue(frontmatter, "description");
  const source = description ?? body.replace(/^#{1,6}[ \t]+/gm, "");
  const line = source.replace(/\s+/g, " ").trim();
  if (line.length === 0) {
    return undefined;
  }
  return line.length <= MEMORY_INDEX_SUMMARY_CHARS ? line : `${line.slice(0, MEMORY_INDEX_SUMMARY_CHARS)}…`;
}

function splitFrontmatter(text: string): { frontmatter: string | undefined; body: string } {
  const normalized = text.replace(/^﻿/, "");
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(normalized);
  if (!match) {
    return { frontmatter: undefined, body: normalized };
  }
  return { frontmatter: match[1] ?? "", body: normalized.slice(match[0].length) };
}

function frontmatterValue(frontmatter: string, key: string): string | undefined {
  const lines = frontmatter.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const match = new RegExp(`^${key}:[ \\t]*(.*)$`).exec(lines[i]!);
    if (!match) {
      continue;
    }
    let value = (match[1] ?? "").trim();
    if (value === "|" || value === ">" || value === "|-" || value === ">-" || value === "") {
      // A block value: the indented lines that follow.
      const block: string[] = [];
      for (let j = i + 1; j < lines.length && /^[ \t]+\S/.test(lines[j]!); j += 1) {
        block.push(lines[j]!.trim());
      }
      value = block.join(" ");
    } else if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.startsWith('"') ? unquoteDouble(value) : value.slice(1, -1).replace(/''/g, "'");
    }
    return value.length > 0 ? value : undefined;
  }
  return undefined;
}

function unquoteDouble(value: string): string {
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "string" ? parsed : value.slice(1, -1);
  } catch {
    return value.slice(1, -1);
  }
}

export function canonicalizePersistentHarnessDir(value: string): string {
  if (!value.startsWith("/") || value.includes("\0")) {
    throw new HarnessInputError("Memory harnessDir must be an absolute /persistent path.", {
      harnessDir: value,
    });
  }

  const parts: string[] = [];
  for (const part of value.split("/")) {
    if (part === "" || part === ".") {
      continue;
    }
    if (part === "..") {
      if (parts.length <= 1) {
        throw new HarnessInputError("Memory harnessDir must stay under /persistent.", {
          harnessDir: value,
        });
      }
      parts.pop();
    } else {
      parts.push(part);
    }
  }

  const normalized = `/${parts.join("/")}`;
  if (normalized === "/persistent" || !normalized.startsWith("/persistent/")) {
    throw new HarnessInputError("Memory harnessDir must stay under /persistent.", {
      harnessDir: value,
    });
  }
  return normalized;
}

function resolveMemoryCommit(value: HarnessMemoryOptions["commit"]): ResolvedHarnessMemoryConfig["commit"] {
  const commit = value ?? "after-turn";
  if (commit === "after-turn" || commit === "manual" || commit === "read-only") {
    return commit;
  }
  throw new HarnessInputError("Memory commit must be after-turn, manual, or read-only.", {
    commit,
  });
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
