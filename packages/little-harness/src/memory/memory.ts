import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { tool, zodSchema, type ToolSet } from "ai";
import { z } from "zod";
import { HarnessInputError } from "../errors.js";
import { sha256Hex } from "../ids.js";
import {
  localDir,
  resolveLocalDirSource,
  type LocalDirSource,
} from "../local-host/local-dir.js";
import type { LocalHostPaths } from "../local-host/paths.js";
import type {
  FileContent,
  FileWriter,
  HarnessMemoryOptions,
  PersistentDir,
  PersistentDirLoadResult,
  ResolvedHarnessMemoryConfig,
} from "../types.js";

export const DEFAULT_MEMORY_HARNESS_DIR = "/persistent/memory";
export const DEFAULT_MEMORY_INDEX_PATH = "MEMORY.md";
export const DEFAULT_MEMORY_TOOL_NAME = "remember";
export const DEFAULT_MEMORY_MAX_INDEX_BYTES = 8000;
export const DEFAULT_MEMORY_MAX_ENTRY_BYTES = 4000;

const DEFAULT_MEMORY_TOOL_DESCRIPTION =
  "Save a durable memory that should be available in future Little Harness turns.";
const TRUNCATION_MARKER = "\n\n[Memory index truncated]\n";
const MEMORY_TOOL_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const RESERVED_MEMORY_TOOL_NAMES = new Set(["bash", "__proto__", "constructor", "prototype"]);
const memoryIndexQueues = new Map<string, Promise<void>>();
const memorySourceStoreQueues = new Map<string, Promise<void>>();

type RememberInput = {
  memory: string;
  reason?: string | undefined;
  topic?: string | undefined;
  tags?: string[] | undefined;
};
type RememberOutput = { ok: true; path: string; indexPath: string; message: string };

type MemoryToolExecutionOptions = {
  files?: FileWriter;
};
type MemoryLocalDirCursor = {
  loadedIndex?: string | undefined;
};

export type ResolvedHarnessMemory<TExtraBody = unknown> = {
  persistentDirs: PersistentDir<TExtraBody>[];
  tools: ToolSet;
  configs: ResolvedHarnessMemoryConfig[];
};

export function memory<TExtraBody = unknown>(
  options: HarnessMemoryOptions<TExtraBody>,
): HarnessMemoryOptions<TExtraBody> {
  return options;
}

export function resolveHarnessMemory<TExtraBody = unknown>(
  options: HarnessMemoryOptions<TExtraBody> | undefined,
  userTools: ToolSet,
): ResolvedHarnessMemory<TExtraBody> {
  if (!options) {
    return { persistentDirs: [], tools: {}, configs: [] };
  }

  const harnessDir = canonicalizePersistentHarnessDir(options.harnessDir ?? DEFAULT_MEMORY_HARNESS_DIR);
  const commit = resolveMemoryCommit(options.commit);
  const indexPath = canonicalizeMemoryIndexPath(options.indexPath ?? DEFAULT_MEMORY_INDEX_PATH);
  const maxIndexBytes = options.maxIndexBytes ?? DEFAULT_MEMORY_MAX_INDEX_BYTES;
  const maxEntryBytes = options.maxEntryBytes ?? DEFAULT_MEMORY_MAX_ENTRY_BYTES;
  const toolName = resolveToolName(options, commit);
  validateMemoryOptions({ maxIndexBytes, maxEntryBytes, toolName });
  const config: ResolvedHarnessMemoryConfig = {
    harnessDir,
    commit,
    indexPath,
    maxIndexBytes,
    maxEntryBytes,
  };

  if (options.instructions !== undefined) {
    config.instructions = options.instructions;
  }
  if (toolName !== undefined) {
    config.toolName = toolName;
  }

  const tools = Object.create(null) as ToolSet;
  if (toolName !== undefined) {
    if (Object.prototype.hasOwnProperty.call(userTools, toolName)) {
      throw new HarnessInputError("Memory tool name collides with an existing user tool.", {
        toolName,
      });
    }

    Object.defineProperty(tools, toolName, {
      value: createRememberTool({
        config,
        description:
          options.tool && typeof options.tool === "object" && options.tool.description !== undefined
            ? options.tool.description
            : DEFAULT_MEMORY_TOOL_DESCRIPTION,
        now: options.now ?? (() => new Date()),
      }),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }

  return {
    persistentDirs: [
      memoryLocalDir({
        harnessDir,
        sourceDir: options.sourceDir,
        commit,
        indexPath,
        maxIndexBytes,
      }),
    ],
    tools,
    configs: [config],
  };
}

function memoryLocalDir<TExtraBody>(options: {
  harnessDir: string;
  sourceDir: LocalDirSource<TExtraBody>;
  commit: ResolvedHarnessMemoryConfig["commit"];
  indexPath: string;
  maxIndexBytes: number;
}): PersistentDir<TExtraBody> {
  const dir = localDir({
    harnessDir: options.harnessDir,
    sourceDir: options.sourceDir,
    commit: options.commit,
  });

  return {
    ...dir,
    async load(loadOptions) {
      const result = await dir.load?.(loadOptions);
      const files = memoryLoadFiles(result);
      return {
        files,
        cursor: {
          loadedIndex: await fileContentToText(files[options.indexPath]),
        } satisfies MemoryLocalDirCursor,
      };
    },
    async store(storeOptions) {
      if (options.commit === "read-only") {
        return;
      }

      const changedIndex =
        storeOptions.changes.created[options.indexPath] ??
        storeOptions.changes.updated[options.indexPath];
      if (!changedIndex) {
        await dir.store?.(storeOptions);
        return;
      }

      const sourceRoot = resolveLocalDirSource(
        options.sourceDir,
        requireMemoryHostPaths(storeOptions.sessionHostPaths),
        storeOptions.extraBody,
      );
      const queueKey = `${sourceRoot}\0${options.indexPath}`;
      await withMemorySourceStoreLock(queueKey, async () => {
        const currentIndex = await readSourceMemoryIndex(sourceRoot, options.indexPath);
        const loadedIndex = isMemoryLocalDirCursor(storeOptions.cursor)
          ? storeOptions.cursor.loadedIndex
          : undefined;
        const mergedIndex = mergeMemoryIndexes(
          currentIndex,
          new TextDecoder().decode(changedIndex),
          loadedIndex,
          options.maxIndexBytes,
        );
        const changes = {
          ...storeOptions.changes,
          created: { ...storeOptions.changes.created },
          updated: { ...storeOptions.changes.updated },
        };
        if (Object.prototype.hasOwnProperty.call(changes.created, options.indexPath)) {
          changes.created[options.indexPath] = new TextEncoder().encode(mergedIndex);
        } else {
          changes.updated[options.indexPath] = new TextEncoder().encode(mergedIndex);
        }
        await dir.store?.({ ...storeOptions, changes });
      });
    },
  };
}

export async function buildMemorySystemContext(
  configs: readonly ResolvedHarnessMemoryConfig[],
  files: FileWriter,
): Promise<string | undefined> {
  if (configs.length === 0) {
    return undefined;
  }

  const sections: string[] = [];
  for (const config of configs) {
    const indexPath = joinHarnessPath(config.harnessDir, config.indexPath);
    const index = await readMemoryIndex(files, indexPath);
    const lines = [
      `Long-term memory is mounted at ${config.harnessDir}.`,
      memoryInstructions(config),
      index === undefined
        ? undefined
        : `Current ${config.indexPath}:\n${boundMemoryIndex(index, config.maxIndexBytes, {
            retain: "tail",
          })}`,
    ].filter((value): value is string => typeof value === "string" && value.length > 0);
    sections.push(lines.join("\n\n"));
  }

  return sections.length === 0 ? undefined : ["# Memory", ...sections].join("\n\n");
}

function createRememberTool(options: {
  config: ResolvedHarnessMemoryConfig;
  description: string;
  now: () => Date;
}) {
  const inputSchema = z.object({
    memory: normalizedString()
      .refine((value) => value.length > 0, "Memory must not be blank.")
      .refine(
        (value) => utf8Bytes(value) <= options.config.maxEntryBytes,
        `Memory must be at most ${options.config.maxEntryBytes} bytes.`,
      ),
    reason: normalizedString().refine((value) => utf8Bytes(value) <= 1000).optional(),
    topic: normalizedString().refine((value) => utf8Bytes(value) <= 120).optional(),
    tags: z
      .array(
        normalizedString()
          .refine((value) => value.length > 0)
          .refine((value) => utf8Bytes(value) <= 40),
      )
      .max(8)
      .optional(),
  });

  return tool({
    description: options.description,
    inputSchema: zodSchema(inputSchema),
    execute: async (input: RememberInput, executeOptions): Promise<RememberOutput> => {
      const files = (executeOptions as MemoryToolExecutionOptions).files;
      if (!files) {
        throw new HarnessInputError("Memory tool requires Little Harness file context.");
      }

      const normalized = normalizeRememberInput(input);
      validateRememberInput(normalized, options.config.maxEntryBytes);
      const now = options.now();
      const timestamp = now.toISOString();
      const date = timestamp.slice(0, 10);
      const slug = slugify(normalized.topic ?? normalized.memory);
      const hash = sha256Hex(JSON.stringify({ timestamp, input: normalized })).slice(0, 12);
      const entryPath = joinHarnessPath(
        options.config.harnessDir,
        `entries/${date}/${slug}-${hash}.md`,
      );
      const indexPath = joinHarnessPath(options.config.harnessDir, options.config.indexPath);
      const entryInput: RememberInput & { timestamp: string } = {
        memory: normalized.memory,
        timestamp,
      };
      if (normalized.reason !== undefined) {
        entryInput.reason = normalized.reason;
      }
      if (normalized.topic !== undefined) {
        entryInput.topic = normalized.topic;
      }
      if (normalized.tags !== undefined) {
        entryInput.tags = normalized.tags;
      }
      const entry = formatMemoryEntry(entryInput);

      await files.writeText(entryPath, entry, { mediaType: "text/markdown" });

      await withMemoryIndexLock(indexPath, async () => {
        const existingIndex = await readMemoryIndex(files, indexPath);
        const index = updateMemoryIndex(existingIndex, {
          date,
          memory: normalized.memory,
          topic: normalized.topic,
          path: entryPath.slice(options.config.harnessDir.length + 1),
        }, options.config.maxIndexBytes);
        await files.writeText(indexPath, index, { mediaType: "text/markdown" });
      });

      return {
        ok: true,
        path: entryPath,
        indexPath,
        message: `Saved memory to ${entryPath}.`,
      };
    },
  });
}

function resolveToolName<TExtraBody>(
  options: HarnessMemoryOptions<TExtraBody>,
  commit: ResolvedHarnessMemoryConfig["commit"],
): string | undefined {
  if (commit === "read-only" || options.tool === false) {
    return undefined;
  }

  return typeof options.tool === "object" && options.tool.name !== undefined
    ? options.tool.name
    : DEFAULT_MEMORY_TOOL_NAME;
}

function validateMemoryOptions(options: {
  maxIndexBytes: number;
  maxEntryBytes: number;
  toolName: string | undefined;
}): void {
  if (!Number.isInteger(options.maxIndexBytes) || options.maxIndexBytes <= 0) {
    throw new HarnessInputError("Memory maxIndexBytes must be a positive integer.", {
      maxIndexBytes: options.maxIndexBytes,
    });
  }
  if (!Number.isInteger(options.maxEntryBytes) || options.maxEntryBytes <= 0) {
    throw new HarnessInputError("Memory maxEntryBytes must be a positive integer.", {
      maxEntryBytes: options.maxEntryBytes,
    });
  }
  if (options.toolName !== undefined && !isValidMemoryToolName(options.toolName)) {
    throw new HarnessInputError("Memory tool name is invalid.", { toolName: options.toolName });
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

function canonicalizeMemoryIndexPath(value: string): string {
  if (value.length === 0 || value.startsWith("/") || value.includes("\0")) {
    throw new HarnessInputError("Memory indexPath must be a relative file path inside the memory directory.", {
      indexPath: value,
    });
  }

  const parts: string[] = [];
  for (const part of value.split(/[\\/]/)) {
    if (part === "" || part === ".") {
      continue;
    }
    if (part === "..") {
      if (parts.length === 0) {
        throw new HarnessInputError("Memory indexPath must stay inside the memory directory.", {
          indexPath: value,
        });
      }
      parts.pop();
    } else {
      parts.push(part);
    }
  }

  if (parts.length === 0) {
    throw new HarnessInputError("Memory indexPath must be a relative file path inside the memory directory.", {
      indexPath: value,
    });
  }
  return parts.join("/");
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

function isValidMemoryToolName(value: string): boolean {
  return MEMORY_TOOL_NAME.test(value) && !RESERVED_MEMORY_TOOL_NAMES.has(value);
}

function normalizedString() {
  return z.string().transform(normalizeText);
}

function normalizeRememberInput(input: RememberInput): RememberInput {
  const out: RememberInput = {
    memory: normalizeText(input.memory),
  };
  const reason = optionalNormalizedText(input.reason);
  const topic = optionalNormalizedText(input.topic);
  const tags = input.tags?.map(normalizeText).filter((tag) => tag.length > 0);
  if (reason !== undefined) {
    out.reason = reason;
  }
  if (topic !== undefined) {
    out.topic = topic;
  }
  if (tags !== undefined && tags.length > 0) {
    out.tags = tags;
  }
  return out;
}

function validateRememberInput(input: RememberInput, maxEntryBytes: number): void {
  if (input.memory.length === 0) {
    throw new HarnessInputError("Memory must not be blank.");
  }
  if (utf8Bytes(input.memory) > maxEntryBytes) {
    throw new HarnessInputError(`Memory must be at most ${maxEntryBytes} bytes.`);
  }
  if (input.reason !== undefined && utf8Bytes(input.reason) > 1000) {
    throw new HarnessInputError("Memory reason must be at most 1000 bytes.");
  }
  if (input.topic !== undefined && utf8Bytes(input.topic) > 120) {
    throw new HarnessInputError("Memory topic must be at most 120 bytes.");
  }
  if (input.tags !== undefined) {
    if (input.tags.length > 8) {
      throw new HarnessInputError("Memory tags must contain at most 8 entries.");
    }
    if (input.tags.some((tag) => utf8Bytes(tag) > 40)) {
      throw new HarnessInputError("Memory tags must be at most 40 bytes each.");
    }
  }
}

async function readMemoryIndex(files: FileWriter, path: string): Promise<string | undefined> {
  try {
    return (await files.read(path)).text();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function memoryLoadFiles(
  result: PersistentDirLoadResult | undefined,
): Record<string, FileContent> {
  if (!result) {
    return {};
  }
  const maybeResult = result as { files?: unknown };
  if (isFileMap(maybeResult.files)) {
    return maybeResult.files;
  }
  return result as Record<string, FileContent>;
}

async function fileContentToText(content: FileContent | undefined): Promise<string | undefined> {
  if (content === undefined) {
    return undefined;
  }
  if (typeof content === "string") {
    return content;
  }
  if (content instanceof Uint8Array) {
    return new TextDecoder().decode(content);
  }
  if (content instanceof ArrayBuffer) {
    return new TextDecoder().decode(new Uint8Array(content));
  }

  const chunks: Uint8Array[] = [];
  const reader = content.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    if (value) {
      chunks.push(value);
    }
  }
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(out);
}

function isFileMap(value: unknown): value is Record<string, FileContent> {
  return (
    value !== null &&
    typeof value === "object" &&
    !(value instanceof Uint8Array) &&
    !(value instanceof ArrayBuffer) &&
    !("getReader" in value)
  );
}

function isMemoryLocalDirCursor(value: unknown): value is MemoryLocalDirCursor {
  return value !== null && typeof value === "object" && "loadedIndex" in value;
}

function requireMemoryHostPaths(value: unknown): LocalHostPaths {
  if (!value || typeof value !== "object" || !("dataDir" in value) || !("projectRoot" in value)) {
    throw new Error("memory localDir requires Local Host path context");
  }
  return value as LocalHostPaths;
}

async function readSourceMemoryIndex(
  sourceRoot: string,
  indexPath: string,
): Promise<string | undefined> {
  try {
    return await readFile(path.join(sourceRoot, indexPath), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function withMemoryIndexLock<T>(indexPath: string, fn: () => Promise<T>): Promise<T> {
  const previous = memoryIndexQueues.get(indexPath) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(fn);
  const queued = run.then(
    () => undefined,
    () => undefined,
  );
  memoryIndexQueues.set(indexPath, queued);

  try {
    return await run;
  } finally {
    if (memoryIndexQueues.get(indexPath) === queued) {
      memoryIndexQueues.delete(indexPath);
    }
  }
}

async function withMemorySourceStoreLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = memorySourceStoreQueues.get(key) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(fn);
  const queued = run.then(
    () => undefined,
    () => undefined,
  );
  memorySourceStoreQueues.set(key, queued);

  try {
    return await run;
  } finally {
    if (memorySourceStoreQueues.get(key) === queued) {
      memorySourceStoreQueues.delete(key);
    }
  }
}

function memoryInstructions(config: ResolvedHarnessMemoryConfig): string | undefined {
  if (config.instructions === false) {
    return undefined;
  }
  if (config.instructions !== undefined) {
    return config.instructions;
  }
  if (config.toolName !== undefined) {
    return `Use ${config.toolName} to save durable facts, preferences, decisions, and user-approved context that should be available in future turns.`;
  }
  if (config.commit !== "read-only") {
    return `Write durable memory files under ${config.harnessDir} to save durable facts, preferences, decisions, and user-approved context that should be available in future turns.`;
  }
  return "Use this read-only memory as durable context from previous work. Do not try to write to it.";
}

function formatMemoryEntry(input: RememberInput & { timestamp: string }): string {
  const metadata = [
    "---",
    `createdAt: ${yamlString(input.timestamp)}`,
    input.topic ? `topic: ${yamlString(input.topic)}` : undefined,
    input.tags && input.tags.length > 0 ? `tags: [${input.tags.map(quoteYamlString).join(", ")}]` : undefined,
    "---",
  ].filter((value): value is string => value !== undefined);
  const body = [input.memory, input.reason ? `Reason: ${input.reason}` : undefined].filter(
    (value): value is string => value !== undefined && value.length > 0,
  );
  return `${metadata.join("\n")}\n\n${body.join("\n\n")}\n`;
}

function updateMemoryIndex(
  existing: string | undefined,
  entry: { date: string; memory: string; topic: string | undefined; path: string },
  maxBytes: number,
): string {
  const title = "# Memory Index";
  const summary = oneLine(entry.memory).slice(0, 160);
  const label = entry.topic && entry.topic.length > 0 ? entry.topic : summary;
  const line = `- ${entry.date}: [${markdownLabel(label)}](${markdownUrl(entry.path)}) - ${markdownLabel(summary)}`;
  const existingLines = memoryIndexBulletLines(existing).filter(
    (existingLine) => !existingLine.includes(`](${entry.path})`),
  );
  const bounded = boundMemoryIndex([title, line, ...existingLines].join("\n"), maxBytes, {
    retain: "head",
  });
  return appendTrailingNewlineWithinLimit(bounded, maxBytes);
}

function mergeMemoryIndexes(
  currentSourceIndex: string | undefined,
  changedCheckoutIndex: string,
  loadedCheckoutIndex: string | undefined,
  maxBytes: number,
): string {
  const title = memoryIndexTitle(
    changedCheckoutIndex || currentSourceIndex || loadedCheckoutIndex || "# Memory Index",
  );
  const loadedKeys = new Set(memoryIndexBulletLines(loadedCheckoutIndex).map(memoryIndexBulletKey));
  const newCheckoutBullets = memoryIndexBulletLines(changedCheckoutIndex).filter(
    (bullet) => !loadedKeys.has(memoryIndexBulletKey(bullet)),
  );
  const seen = new Set<string>();
  const bullets: string[] = [];
  for (const bullet of [
    ...newCheckoutBullets,
    ...memoryIndexBulletLines(currentSourceIndex),
  ]) {
    const key = memoryIndexBulletKey(bullet);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    bullets.push(bullet);
  }

  const bounded = boundMemoryIndex([title, ...bullets].join("\n"), maxBytes, {
    retain: "head",
  });
  return appendTrailingNewlineWithinLimit(bounded, maxBytes);
}

function memoryIndexBulletKey(line: string): string {
  return /\]\(([^)]+)\)/.exec(line)?.[1] ?? line;
}

function appendTrailingNewlineWithinLimit(text: string, maxBytes: number): string {
  const trimmed = text.trimEnd();
  if (utf8Bytes(`${trimmed}\n`) <= maxBytes) {
    return `${trimmed}\n`;
  }
  return truncateUtf8Suffix(trimmed, Math.max(0, maxBytes - utf8Bytes("\n"))).trimEnd() + "\n";
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug.length > 0 ? slug : "memory";
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function quoteYamlString(value: string): string {
  return yamlString(value);
}

function yamlString(value: string): string {
  return JSON.stringify(normalizeText(value));
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function optionalNormalizedText(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = normalizeText(value);
  return normalized.length > 0 ? normalized : undefined;
}

function markdownLabel(value: string): string {
  return normalizeText(value)
    .replace(/\\/g, "\\\\")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)")
    .replace(/:/g, " -");
}

function markdownUrl(value: string): string {
  return encodeURI(normalizeText(value)).replace(/\)/g, "%29").replace(/\(/g, "%28");
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function boundMemoryIndex(
  text: string,
  maxBytes: number,
  options: { retain: "head" | "tail" },
): string {
  if (utf8Bytes(text) <= maxBytes) {
    return text.trimEnd();
  }

  const title = memoryIndexTitle(text);
  const bullets =
    options.retain === "head" ? memoryIndexBulletLines(text) : memoryIndexBulletLines(text).reverse();
  if (bullets.length === 0) {
    const bounded = formatBoundMemoryIndex(title, true, []);
    return utf8Bytes(bounded) <= maxBytes ? bounded : truncateUtf8Suffix(bounded, maxBytes);
  }

  const kept: string[] = [];
  let omitted = false;

  for (const bullet of bullets) {
    const candidate = formatBoundMemoryIndex(title, kept.length === bullets.length ? false : true, [
      ...kept,
      bullet,
    ]);
    if (utf8Bytes(candidate) <= maxBytes) {
      kept.push(bullet);
    } else {
      omitted = true;
    }
  }

  if (kept.length === 0 && bullets.length > 0) {
    const firstBullet = bullets[0]!;
    const prefix = formatBoundMemoryIndex(title, true, []);
    const separatorBytes = utf8Bytes("\n");
    const availableBytes = maxBytes - utf8Bytes(prefix) - separatorBytes;
    if (availableBytes > 0) {
      return `${prefix}\n${utf8Prefix(firstBullet, availableBytes)}`.trimEnd();
    }
  }

  const bounded = formatBoundMemoryIndex(
    title,
    omitted,
    options.retain === "head" ? kept : kept.reverse(),
  );
  if (utf8Bytes(bounded) <= maxBytes) {
    return bounded;
  }

  return truncateUtf8Suffix(bounded, maxBytes);
}

function formatBoundMemoryIndex(title: string, omitted: boolean, bullets: readonly string[]): string {
  return [title, omitted ? TRUNCATION_MARKER.trim() : undefined, ...bullets]
    .filter((line): line is string => line !== undefined && line.length > 0)
    .join("\n");
}

function memoryIndexTitle(text: string): string {
  const firstLine = text.trim().split("\n")[0]?.trim();
  return firstLine?.startsWith("#") ? firstLine : "# Memory Index";
}

function memoryIndexBulletLines(text: string | undefined): string[] {
  if (!text) {
    return [];
  }
  return text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.startsWith("- "));
}

function truncateUtf8Suffix(text: string, maxBytes: number): string {
  let bytes = utf8Bytes(text);
  let out = text;
  const chars = Array.from(out);
  while (bytes > maxBytes && chars.length > 0) {
    const char = chars.pop()!;
    const nextBytes = utf8Bytes(char);
    bytes -= nextBytes;
    out = chars.join("");
  }
  return out;
}

function utf8Prefix(text: string, maxBytes: number): string {
  let bytes = 0;
  let out = "";
  for (const char of Array.from(text)) {
    const nextBytes = utf8Bytes(char);
    if (bytes + nextBytes > maxBytes) {
      break;
    }
    bytes += nextBytes;
    out += char;
  }
  return out;
}

function joinHarnessPath(root: string, relative: string): string {
  return `${trimTrailingSlashes(root)}/${trimSlashes(relative)}`;
}

function trimTrailingSlashes(value: string): string {
  const trimmed = value.replace(/\/+$/g, "");
  return trimmed.length > 0 ? trimmed : "/";
}

function trimSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, "");
}
