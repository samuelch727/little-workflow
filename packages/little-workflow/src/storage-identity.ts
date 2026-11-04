import type { IFileSystem } from "just-bash";
import { posix } from "node:path";

const namespaces = new WeakMap<IFileSystem, number>();
let nextNamespace = 0;

/** Filesystem-backed Worlds use POSIX paths rooted at /, independent of cwd. */
export function virtualDataDir(dataDir: string): string {
  if (dataDir.includes("\0") || dataDir.includes("\\")) {
    throw new TypeError("A virtual World dataDir must be a POSIX path without NUL or backslashes.");
  }
  return posix.resolve("/", dataDir);
}

/** Wrapping a World preserves this identity; wrapping its filesystem does not. */
export function virtualStorageKey(files: IFileSystem, dataDir: string, identity: string): string {
  let namespace = namespaces.get(files);
  if (namespace === undefined) {
    namespace = ++nextNamespace;
    namespaces.set(files, namespace);
  }
  return JSON.stringify(["virtual-world", namespace, virtualDataDir(dataDir), identity]);
}
