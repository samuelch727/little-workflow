import type { IFileSystem } from "just-bash";
import * as path from "node:path";
import type {
  FileData,
  FileEntry,
  FileWriter,
  ListFilesOptions,
  RemoveFileOptions,
} from "../types.js";
import { toUint8Array, writtenFileRef } from "./file-writer.js";
import { filesystemError } from "./filesystem-error.js";
import { FILESYSTEM_ROOT_DIRS, resolveHarnessPath } from "./path-policy.js";

export type FsFileWriterOptions = {
  getReadOnlyPersistentDirs?: () => readonly string[];
};

/**
 * The session FileWriter for a workspace kept in one just-bash filesystem: the same path rules
 * as the local writer (four managed roots, /.agents read-only, read-only Persistent Dirs), with
 * the harness path as the file's own path in `fs`.
 */
export function createFsFileWriter(fs: IFileSystem, options: FsFileWriterOptions = {}): FileWriter {
  const write: FileWriter["write"] = async (targetPath, content, writeOptions = {}) => {
    try {
      const resolved = resolveHarnessPath(FILESYSTEM_ROOT_DIRS, targetPath, "write", {
        readOnlyPersistentDirs: options.getReadOnlyPersistentDirs?.() ?? [],
      });
      const bytes = await toUint8Array(content);
      await fs.mkdir(path.posix.dirname(resolved.harnessPath), { recursive: true });
      await fs.writeFile(resolved.harnessPath, bytes);
      return writtenFileRef(resolved, bytes, writeOptions);
    } catch (error) {
      throw filesystemError(error);
    }
  };

  return {
    write,
    writeText: (targetPath, text, writeOptions) => write(targetPath, text, writeOptions),
    writeJSON: (targetPath, value, writeOptions) =>
      write(targetPath, JSON.stringify(value, null, 2), {
        ...writeOptions,
        mediaType: writeOptions?.mediaType ?? "application/json",
      }),
    async read(targetPath): Promise<FileData> {
      try {
        const resolved = resolveHarnessPath(FILESYSTEM_ROOT_DIRS, targetPath, "read");
        const content = await fs.readFileBuffer(resolved.harnessPath);
        return {
          path: resolved.harnessPath,
          content,
          text: () => new TextDecoder().decode(content),
          json: <T>() => JSON.parse(new TextDecoder().decode(content)) as T,
        };
      } catch (error) {
        throw filesystemError(error);
      }
    },
    async list(targetPath, listOptions: ListFilesOptions = {}): Promise<FileEntry[]> {
      try {
        const resolved = resolveHarnessPath(FILESYSTEM_ROOT_DIRS, targetPath, "list");
        const out: FileEntry[] = [];
        await collect(fs, resolved.harnessPath, out, listOptions.recursive ?? false);
        return out;
      } catch (error) {
        throw filesystemError(error);
      }
    },
    async remove(targetPath, removeOptions: RemoveFileOptions = {}): Promise<void> {
      try {
        const resolved = resolveHarnessPath(FILESYSTEM_ROOT_DIRS, targetPath, "delete", {
          readOnlyPersistentDirs: options.getReadOnlyPersistentDirs?.() ?? [],
        });
        await fs.rm(resolved.harnessPath, { recursive: removeOptions.recursive ?? false, force: false });
      } catch (error) {
        throw filesystemError(error);
      }
    },
  };
}

async function collect(
  fs: IFileSystem,
  dir: string,
  out: FileEntry[],
  recursive: boolean,
): Promise<void> {
  for (const name of await fs.readdir(dir)) {
    const entryPath = path.posix.join(dir, name);
    const stat = await fs.stat(entryPath);
    if (stat.isDirectory) {
      out.push({ path: entryPath, kind: "directory" });
      if (recursive) {
        await collect(fs, entryPath, out, recursive);
      }
    } else if (stat.isFile) {
      out.push({ path: entryPath, kind: "file", bytes: stat.size });
    }
  }
}
