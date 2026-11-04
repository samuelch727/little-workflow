import type { IFileSystem } from "just-bash";
import type { Stats } from "node:fs";
import * as nodePath from "node:path";
import { randomUUID } from "node:crypto";
import { virtualDataDir, virtualStorageKey } from "./storage-identity.js";
import type { World } from "./world-port.js";
import { WorldPathError } from "./world.js";

type FileWorld = Pick<World, "dataDir" | "files">;
export type RunFileStat = Pick<Stats, "isDirectory" | "isFile" | "isSymbolicLink" | "size" | "dev" | "ino" | "mtimeMs">;
type RemoveOptions = { recursive?: boolean; force?: boolean; maxRetries?: number; retryDelay?: number };

/** Run-owned file operations. A virtual filesystem supplies its own persistence guarantees. */
export interface RunFiles {
  readonly path: typeof nodePath.posix;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: string | Uint8Array, encoding?: "utf8"): Promise<void>;
  readdir(path: string): Promise<string[]>;
  stat(path: string): Promise<RunFileStat>;
  rename(from: string, to: string): Promise<void>;
  link(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
  rm(path: string, options?: RemoveOptions): Promise<void>;
  copyFile(from: string, to: string): Promise<void>;
  mkdtemp(prefix: string): Promise<string>;
  realpath(path: string): Promise<string>;
  writeFileDurably(path: string, data: string | Uint8Array): Promise<void>;
  syncDirectory(path: string): Promise<void>;
  ensureDirectory(path: string): Promise<void>;
  removeDirRetrySafe(path: string): Promise<void>;
  canonicalDataDir(): Promise<string>;
  /** Keep the caller's existing disk key; isolate virtual keys by filesystem object + data root. */
  storageKey(identity: string): string;
}

export function runFilesFor(world: FileWorld): RunFiles {
  const fs = world.files;
  const path = fs === undefined ? nodePath : nodePath.posix;
  function readFile(target: string, encoding: "utf8"): Promise<string>;
  function readFile(target: string): Promise<Uint8Array>;
  async function readFile(target: string, encoding?: "utf8"): Promise<string | Uint8Array> {
    if (fs === undefined) return encoding === undefined ? (await diskFiles()).readFile(target) : (await diskFiles()).readFile(target, encoding);
    return encoding === undefined ? fs.readFileBuffer(target) : fs.readFile(target);
  }
  const files: RunFiles = {
    path,
    async mkdir(target, options) {
      if (fs === undefined) await (await diskFiles()).mkdir(target, options);
      else await fs.mkdir(target, options);
    },
    readFile,
    async writeFile(target, data, encoding) {
      if (fs === undefined) await (await diskFiles()).writeFile(target, data, encoding);
      else await fs.writeFile(target, data);
    },
    readdir: async (target) => fs === undefined ? (await diskFiles()).readdir(target) : fs.readdir(target),
    async stat(target) {
      if (fs === undefined) return (await diskFiles()).stat(target);
      const entry = await fs.stat(target);
      return {
        isDirectory: () => entry.isDirectory,
        isFile: () => entry.isFile,
        isSymbolicLink: () => entry.isSymbolicLink,
        size: entry.size,
        dev: 0,
        ino: 0,
        mtimeMs: entry.mtime.getTime(),
      };
    },
    rename: async (from, to) => fs === undefined ? (await diskFiles()).rename(from, to) : fs.mv(from, to),
    link: async (from, to) => fs === undefined ? (await diskFiles()).link(from, to) : fs.link(from, to),
    unlink: async (target) => fs === undefined ? (await diskFiles()).unlink(target) : fs.rm(target),
    async rm(target, options) {
      if (fs === undefined) await (await diskFiles()).rm(target, options);
      else await fs.rm(target, {
        ...(options?.recursive === undefined ? {} : { recursive: options.recursive }),
        ...(options?.force === undefined ? {} : { force: options.force }),
      });
    },
    async copyFile(from, to) {
      if (fs === undefined) await (await diskFiles()).copyFile(from, to);
      else await fs.writeFile(to, await fs.readFileBuffer(from));
    },
    async mkdtemp(prefix) {
      if (fs === undefined) return (await diskFiles()).mkdtemp(prefix);
      const directory = `${prefix}${randomUUID()}`;
      await fs.mkdir(directory);
      return directory;
    },
    realpath: async (target) => fs === undefined ? (await diskFiles()).realpath(target) : fs.realpath(target),
    async writeFileDurably(target, data) {
      if (fs !== undefined) {
        await fs.writeFile(target, data);
        return;
      }
      const handle = await (await diskFiles()).open(target, "w");
      try {
        await handle.writeFile(data, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
    },
    async syncDirectory(target) {
      if (fs !== undefined) return;
      const handle = await (await diskFiles()).open(target, "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    },
    async ensureDirectory(target) {
      if (fs !== undefined) {
        let current = path.resolve(target);
        while (true) {
          if (await fs.exists(current)) {
            if (!(await fs.stat(current)).isDirectory) {
              throw new WorldPathError(`Expected directory path, received file path: ${current}`);
            }
          }
          const parent = path.dirname(current);
          if (parent === current) break;
          current = parent;
        }
        await fs.mkdir(target, { recursive: true });
        return;
      }
      const missing: string[] = [];
      let current = path.resolve(target);
      const chain: string[] = [];
      while (true) {
        chain.unshift(current);
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
      }
      for (const directory of chain) {
        try {
          if (!(await files.stat(directory)).isDirectory()) {
            throw new WorldPathError(`Expected directory path, received file path: ${directory}`);
          }
        } catch (error) {
          if (!isErrno(error, "ENOENT")) throw error;
          missing.push(directory);
        }
      }
      await files.mkdir(target, { recursive: true });
      await files.syncDirectory(target);
      await files.syncDirectory(path.dirname(target));
      await Promise.all(missing.map((directory) => files.syncDirectory(path.dirname(directory))));
    },
    async removeDirRetrySafe(target) {
      await files.rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    },
    async canonicalDataDir() {
      if (fs !== undefined) return virtualDataDir(world.dataDir);
      try {
        return await files.realpath(world.dataDir);
      } catch {
        const absolute = path.resolve(world.dataDir);
        const missing: string[] = [];
        let current = absolute;
        while (true) {
          try {
            await files.stat(current);
            break;
          } catch {
            missing.unshift(path.basename(current));
            const parent = path.dirname(current);
            if (parent === current) return absolute;
            current = parent;
          }
        }
        return path.resolve(await files.realpath(current), ...missing);
      }
    },
    storageKey: (identity) => fs === undefined ? identity : virtualStorageKey(fs, world.dataDir, identity),
  };
  if (fs === undefined) return files;
  // just-bash filesystems use errno-prefixed messages but do not consistently
  // expose .code. Give both adapters the same error port without changing the
  // original message or the disk adapter's errors.
  return new Proxy(files, {
    get(target, key, receiver) {
      const value: unknown = Reflect.get(target, key, receiver);
      if (typeof value !== "function" || key === "storageKey") return value;
      return (...args: unknown[]) => Promise.resolve()
        .then(() => value.apply(target, args))
        .catch((error: unknown) => { throw filesystemError(error); });
    },
  });
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function filesystemError(error: unknown): unknown {
  if (!(error instanceof Error) || ("code" in error && error.code !== undefined)) return error;
  const code = /^(E[A-Z0-9_]+):/u.exec(error.message)?.[1];
  if (code === undefined) return error;
  try {
    return Object.assign(error, { code });
  } catch {
    return Object.assign(new Error(error.message, { cause: error }), { code });
  }
}

/** Resolve Node only when a disk adapter operation is actually used. */
function diskFiles(): Promise<typeof import("node:fs/promises")> {
  return import("node:fs/promises");
}
