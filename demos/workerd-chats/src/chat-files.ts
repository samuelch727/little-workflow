import { InMemoryFs, type IFileSystem } from "just-bash";

/** IFileSystem methods that change something, and which of their arguments name what changed. */
const CHANGES: Record<string, (args: unknown[]) => unknown[]> = {
  writeFile: (args) => [args[0]],
  appendFile: (args) => [args[0]],
  mkdir: (args) => [args[0]],
  rm: (args) => [args[0]],
  cp: (args) => [args[1]],
  mv: (args) => [args[0], args[1]],
  symlink: (args) => [args[1]],
  link: (args) => [args[1]],
  chmod: (args) => [args[0]],
  utimes: (args) => [args[0]],
};

/**
 * A chat's files, kept one row per file in its Durable Object's SQLite database. `open()`
 * hands out a just-bash filesystem that reads a file's row only when something reads that
 * file, and remembers which paths changed; `save()` writes back just those paths.
 *
 * Only regular files are kept: empty folders and symlinks last as long as the object stays
 * in memory.
 */
export class ChatFiles {
  private fs: InMemoryFs | undefined;
  private readonly changed = new Set<string>();

  constructor(private readonly storage: DurableObjectStorage) {
    storage.sql.exec("CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, content BLOB NOT NULL)");
  }

  open(): IFileSystem {
    const rows = this.storage.sql.exec<{ path: string }>("SELECT path FROM files").toArray();
    const fs = new InMemoryFs(Object.fromEntries(rows.map(({ path }) => [path, () => this.read(path)])));
    this.fs = fs;
    return new Proxy(fs, {
      get: (target, key, receiver) => {
        const value: unknown = Reflect.get(target, key, receiver);
        if (typeof value !== "function") return value;
        const changes = typeof key === "string" ? CHANGES[key] : undefined;
        if (changes === undefined) return value.bind(target);
        return async (...args: unknown[]) => {
          const paths = changes(args);
          for (const path of paths) {
            if (typeof path === "string") this.changed.add(path);
          }
          const result = await value.apply(target, args);
          // VirtualTrace awaits this write before exposing the event. Only this counter
          // writes through: the rest of the filesystem is saved at the end of the turn.
          for (const path of paths) {
            if (typeof path === "string" && /^\/\.little-harness\/sessions\/[^/]+\/trace\.json$/u.test(path)) {
              await this.saveTraceCounter(fs, path);
            }
          }
          return result;
        };
      },
    });
  }

  /** Writes every changed path back: the files now under it, and none of the rows it had. */
  async save(): Promise<void> {
    const fs = this.fs;
    if (fs === undefined || this.changed.size === 0) return;
    const changed = [...this.changed];
    this.changed.clear();

    const files = new Map<string, Uint8Array>();
    for (const path of changed) {
      if (!(await fs.exists(path))) continue;
      const below = (await fs.lstat(path)).isDirectory
        ? fs.getAllPaths().filter((candidate) => candidate.startsWith(`${path}/`))
        : [path];
      for (const file of below) {
        if ((await fs.lstat(file)).isFile) files.set(file, await fs.readFileBuffer(file));
      }
    }

    this.storage.transactionSync(() => {
      for (const path of changed) {
        this.storage.sql.exec("DELETE FROM files WHERE path = ?1 OR substr(path, 1, length(?2)) = ?2", path, `${path}/`);
      }
      for (const [path, content] of files) {
        const blob = content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength);
        this.storage.sql.exec("INSERT OR REPLACE INTO files (path, content) VALUES (?, ?)", path, blob);
      }
    });
  }

  private read(path: string): Uint8Array {
    const row = this.storage.sql.exec<{ content: ArrayBuffer }>("SELECT content FROM files WHERE path = ?", path).one();
    return new Uint8Array(row.content);
  }

  private async saveTraceCounter(fs: InMemoryFs, path: string): Promise<void> {
    const content = await fs.readFileBuffer(path);
    const blob = content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength);
    this.storage.sql.exec("INSERT OR REPLACE INTO files (path, content) VALUES (?, ?)", path, blob);
  }
}
