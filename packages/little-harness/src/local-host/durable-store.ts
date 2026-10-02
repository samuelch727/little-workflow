import { sep } from "node:path";
import { stableHash } from "../utils/canonical-hash.js";

/** Pluggable persistence for the orchestration ledgers. Paths are opaque keys. */
export type DurableJsonStore = {
  /** Read and parse a JSON document; a missing path resolves to undefined. */
  readJson<T>(path: string): Promise<T | undefined>;
  /** Serialize and persist a JSON document; the value must survive a JSON round-trip. */
  writeJson(path: string, value: unknown): Promise<void>;
  /** Delete a document; removing a missing path is a no-op. */
  remove(path: string): Promise<void>;
  /** List the direct child names under a directory-like prefix; a missing dir lists as empty. */
  listDir(dir: string): Promise<readonly string[]>;
  /** Run `fn` while holding an exclusive lock for `scope` (keyed by `recordKey(scope)`). */
  withLock<T>(scope: unknown, fn: () => Promise<T>): Promise<T>;
};

/** Stable content-addressed key for lock scopes and record file names. */
export function recordKey(value: unknown): string {
  return stableHash({ kind: "record", value }, { format: "base32hex" });
}

export function createInMemoryDurableStore(): DurableJsonStore {
  // Documents hold serialized JSON keyed by path: the stringify/parse round-trip strips
  // undefined fields exactly like the file backend, which result-commit equality depends on.
  const documents = new Map<string, string>();
  const lockTails = new Map<string, Promise<void>>();
  return {
    async readJson<T>(path: string): Promise<T | undefined> {
      const serialized = documents.get(path);
      return serialized === undefined ? undefined : JSON.parse(serialized) as T;
    },
    async writeJson(path, value) {
      documents.set(path, JSON.stringify(value));
    },
    async remove(path) {
      documents.delete(path);
    },
    async listDir(dir) {
      const prefix = dir.endsWith(sep) ? dir : `${dir}${sep}`;
      const children = new Set<string>();
      for (const path of documents.keys()) {
        if (!path.startsWith(prefix)) {
          continue;
        }
        const [child] = path.slice(prefix.length).split(sep);
        if (child !== undefined && child !== "") {
          children.add(child);
        }
      }
      return [...children];
    },
    async withLock(scope, fn) {
      // Non-reentrant promise-chained mutex per scope key; nested ledger locks always use
      // distinct scopes, mirroring the file backend's per-scope lock directories.
      const key = recordKey(scope);
      const previous = lockTails.get(key) ?? Promise.resolve();
      const run = previous.then(() => fn());
      const tail = run.then(() => undefined, () => undefined);
      lockTails.set(key, tail);
      try {
        return await run;
      } finally {
        if (lockTails.get(key) === tail) {
          lockTails.delete(key);
        }
      }
    },
  };
}
