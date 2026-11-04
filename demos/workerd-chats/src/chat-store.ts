import { recordKey, type DurableJsonStore } from "@little-stack/harness/host";

/** One store per chat Durable Object. Its locks protect only this store instance. */
export class ChatStore implements DurableJsonStore {
  private readonly tails = new Map<string, Promise<void>>();

  constructor(private readonly sql: SqlStorage) {
    sql.exec("CREATE TABLE IF NOT EXISTS docs (path TEXT PRIMARY KEY, json TEXT NOT NULL)");
  }

  async readJson<T>(path: string): Promise<T | undefined> {
    const row = this.sql.exec<{ json: string }>("SELECT json FROM docs WHERE path = ?", path).toArray()[0];
    return row === undefined ? undefined : JSON.parse(row.json) as T;
  }

  async writeJson(path: string, value: unknown): Promise<void> {
    this.sql.exec("INSERT OR REPLACE INTO docs (path, json) VALUES (?, ?)", path, JSON.stringify(value));
  }

  async writeJsonDurable(path: string, value: unknown): Promise<void> {
    // DO SQLite commits writes before releasing output to the caller.
    await this.writeJson(path, value);
  }

  async remove(path: string): Promise<void> {
    this.sql.exec("DELETE FROM docs WHERE path = ?", path);
  }

  async listDir(dir: string): Promise<readonly string[]> {
    const prefix = dir.endsWith("/") ? dir : `${dir}/`;
    // Under SQLite's default BINARY collation, advancing the final ASCII slash
    // includes every suffix (including supplementary Unicode) and no sibling.
    const upper = `${prefix.slice(0, -1)}0`;
    const rows = this.sql.exec<{ path: string }>(
      "SELECT path FROM docs WHERE path >= ? AND path < ? ORDER BY path", prefix, upper,
    ).toArray();
    return [...new Set(rows.map(({ path }) => path.slice(prefix.length).split("/")[0]!).filter(Boolean))];
  }

  async withLock<T>(scope: unknown, fn: () => Promise<T>): Promise<T> {
    const key = recordKey(scope);
    const previous = this.tails.get(key) ?? Promise.resolve();
    const run = previous.then(fn);
    const tail = run.then(() => undefined, () => undefined);
    this.tails.set(key, tail);
    try {
      return await run;
    } finally {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}
