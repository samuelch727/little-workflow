import type { IFileSystem } from "just-bash";
import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import type { EventStorage } from "./event-storage.js";
import type { EventEnvelope } from "./world.js";

const FINAL_EVENT_NAME = /^\d{10,}\.json$/u;

/**
 * Final names are the publication boundary. A filesystem's mv and persistence
 * guarantees are inherited; temporary files are never treated as committed events.
 */
export function filesystemEventStorage(fs: IFileSystem, dataDir: string): EventStorage {
  const eventsDir = posix.join(dataDir, "events");
  const runDir = (runId: string) => posix.join(eventsDir, runId);
  const finalNames = async (runId: string): Promise<string[]> => {
    const dir = runDir(runId);
    if (!(await fs.exists(dir))) return [];
    return [...await fs.readdir(dir)]
      .filter(name => FINAL_EVENT_NAME.test(name))
      .sort((left, right) => Number(left.slice(0, -5)) - Number(right.slice(0, -5)));
  };
  const list = async (runId: string): Promise<EventEnvelope[]> =>
    Promise.all((await finalNames(runId)).map(async name => {
      const event = JSON.parse(await fs.readFile(posix.join(runDir(runId), name))) as EventEnvelope;
      if (event.runId !== runId || event.sequence !== Number(name.slice(0, -5))) {
        throw new Error(`Event file does not match its run and sequence: ${runId}/${name}`);
      }
      return event;
    }));
  return {
    async findByIdempotency(runId, key) {
      return (await list(runId)).find(event => event.appendIdempotencyKey === key);
    },
    async maxSequence(runId) {
      const names = await finalNames(runId);
      return names.length === 0 ? 0 : Number(names[names.length - 1]!.slice(0, -5));
    },
    async insert(event) {
      const dir = runDir(event.runId);
      await fs.mkdir(dir, { recursive: true });
      const final = posix.join(dir, `${String(event.sequence).padStart(10, "0")}.json`);
      const temporary = `${final}.${randomUUID()}.tmp`;
      await fs.writeFile(temporary, `${JSON.stringify(event)}\n`);
      await fs.mv(temporary, final);
    },
    list,
    async listRunIds() {
      if (!(await fs.exists(eventsDir))) return [];
      const ids: string[] = [];
      for (const name of await fs.readdir(eventsDir)) {
        if ((await fs.lstat(posix.join(eventsDir, name))).isDirectory &&
          (await finalNames(name)).length > 0) ids.push(name);
      }
      return ids.sort();
    },
    async deleteAfter(runId, sequence) {
      for (const name of await finalNames(runId)) {
        if (Number(name.slice(0, -5)) > sequence) {
          await fs.rm(posix.join(runDir(runId), name));
        }
      }
    },
  };
}
