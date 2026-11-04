import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { HarnessTurnStart } from "../types.js";

/**
 * Each session's latest turn as it started (its `turnId` and `turnOptions` metadata), one file
 * per session under the data dir, so `GET /sessions/:id/turn` can say which turn it is after a
 * restart too.
 */
export function latestTurns(dataDir: string) {
  const dir = join(dataDir, "agent-server", "turns");
  const file = (sessionId: string) => join(dir, `${encodeURIComponent(sessionId)}.json`);
  return {
    async get(sessionId: string): Promise<HarnessTurnStart | undefined> {
      try {
        return JSON.parse(await readFile(file(sessionId), "utf8")) as HarnessTurnStart;
      } catch {
        return undefined;
      }
    },
    async save(turn: HarnessTurnStart): Promise<void> {
      await mkdir(dir, { recursive: true });
      // Written whole, then renamed, so a crash never leaves half a record.
      const temporary = `${file(turn.sessionId)}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(turn));
      await rename(temporary, file(turn.sessionId));
    },
  };
}
