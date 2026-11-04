import * as path from "node:path";
import { tool, zodSchema, type ToolSet } from "ai";
import { z } from "zod";
import { HarnessInputError } from "../errors.js";
import type { FileWriter, HarnessSession, ResolvedHarnessMemoryConfig } from "../types.js";

/** The file tools a harness with memory adds when bash is off. */
export const MEMORY_FILE_TOOL_NAMES = ["list_files", "read_file", "write_file", "delete_file"] as const;

/** Most bytes read_file returns and write_file accepts. */
const MAX_FILE_BYTES = 256 * 1024;

type FileToolExecutionOptions = {
  files?: FileWriter;
  session?: HarnessSession;
};

/**
 * Plain file tools for an agent without bash, limited to its memory folders. They are not memory
 * tools: they list, read, write and delete files, and the memory skill says how to use them. A
 * folder that is read-only this turn refuses writes here as it does in bash.
 */
export function createMemoryFileTools(configs: readonly ResolvedHarnessMemoryConfig[]): ToolSet {
  const dirs = configs.map((config) => config.harnessDir);
  const where = dirs.join(", ");
  const pathSchema = z.string().min(1).max(512).describe(`An absolute path inside ${where}.`);

  return {
    list_files: tool({
      description: `List the files in your memory folders (${where}), or in one folder inside them.`,
      inputSchema: zodSchema(z.object({ path: pathSchema.optional() })),
      execute: async (input: { path?: string | undefined }, options) => {
        const files = requireFiles(options);
        const roots = input.path === undefined ? dirs : [resolveMemoryPath(input.path, dirs).path];
        const out: Array<{ path: string; bytes?: number }> = [];
        for (const root of roots) {
          for (const entry of await listOrEmpty(files, root)) {
            if (entry.kind === "file") {
              out.push(entry.bytes === undefined ? { path: entry.path } : { path: entry.path, bytes: entry.bytes });
            }
          }
        }
        return { files: out.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0)) };
      },
    }),
    read_file: tool({
      description: `Read a text file in your memory folders (${where}).`,
      inputSchema: zodSchema(z.object({ path: pathSchema })),
      execute: async (input: { path: string }, options) => {
        const target = resolveMemoryPath(input.path, dirs).path;
        const data = await requireFiles(options).read(target).catch((error: unknown) => {
          throw (error as NodeJS.ErrnoException).code === "ENOENT"
            ? new HarnessInputError(`No file at ${target}.`)
            : error;
        });
        if (data.content.byteLength > MAX_FILE_BYTES) {
          return {
            path: target,
            content: new TextDecoder().decode(data.content.subarray(0, MAX_FILE_BYTES)),
            truncated: true,
          };
        }
        return { path: target, content: data.text() };
      },
    }),
    write_file: tool({
      description:
        `Create or replace a text file in your memory folders (${where}). ` +
        "The content replaces the whole file.",
      inputSchema: zodSchema(
        z.object({
          path: pathSchema,
          content: z.string().max(MAX_FILE_BYTES),
        }),
      ),
      execute: async (input: { path: string; content: string }, options) => {
        const target = resolveMemoryPath(input.path, dirs);
        assertWritable(target, options);
        const ref = await requireFiles(options).writeText(target.path, input.content, {
          mediaType: target.path.endsWith(".md") ? "text/markdown" : "text/plain",
        });
        return { ok: true, path: ref.path, bytes: ref.bytes };
      },
    }),
    delete_file: tool({
      description: `Delete a file in your memory folders (${where}).`,
      inputSchema: zodSchema(z.object({ path: pathSchema })),
      execute: async (input: { path: string }, options) => {
        const target = resolveMemoryPath(input.path, dirs);
        assertWritable(target, options);
        await requireFiles(options).remove(target.path).catch((error: unknown) => {
          throw (error as NodeJS.ErrnoException).code === "ENOENT"
            ? new HarnessInputError(`No file at ${target.path}.`)
            : error;
        });
        return { ok: true, path: target.path };
      },
    }),
  };
}

function resolveMemoryPath(raw: string, dirs: readonly string[]): { path: string; dir: string } {
  const value = raw.trim();
  if (!value.startsWith("/") || value.includes("\0")) {
    throw new HarnessInputError(`Use an absolute path inside ${dirs.join(", ")}.`, { path: raw });
  }
  const normalized = path.posix.normalize(value).replace(/\/+$/u, "");
  const dir = dirs.find((candidate) => normalized === candidate || normalized.startsWith(`${candidate}/`));
  if (dir === undefined) {
    throw new HarnessInputError(`${raw} is outside your memory folders: ${dirs.join(", ")}.`, { path: raw });
  }
  return { path: normalized, dir };
}

function assertWritable(target: { path: string; dir: string }, options: unknown): void {
  const session = (options as FileToolExecutionOptions).session;
  const readOnly = session?.getReadOnlyPersistentDirs() ?? [];
  if (readOnly.some((dir) => target.dir === dir || target.dir.startsWith(`${dir}/`))) {
    throw new HarnessInputError(`${target.dir} is read-only in this conversation; nothing was changed.`);
  }
  if (target.path === target.dir) {
    throw new HarnessInputError(`${target.path} is a memory folder, not a file.`);
  }
}

function requireFiles(options: unknown): FileWriter {
  const files = (options as FileToolExecutionOptions).files;
  if (!files) {
    throw new HarnessInputError("Memory file tools need Little Harness file context.");
  }
  return files;
}

async function listOrEmpty(files: FileWriter, dir: string) {
  try {
    return await files.list(dir, { recursive: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}
