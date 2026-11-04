import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { HarnessResumeQueueRecord } from "../tasks/ledger.js";

/** Where a resume the caller asked for stands. */
export type CallerResumeStatus = "running" | "finished" | "parked" | "failed";

/** A resume the caller asked for by its `resumeId`, kept on disk so a repeat is answered the same. */
export type CallerResume = {
  readonly resumeId: string;
  readonly continuationId: string;
  readonly status: CallerResumeStatus;
  /** The queue record the resume claimed, to queue it again when a restart cut its run off. */
  readonly queued: HarnessResumeQueueRecord;
  readonly updatedAt: string;
};

export type SessionResumes = {
  readonly latest: CallerResume;
  /** Earlier resumes of the session, newest first, so a late repeat of one never starts another. */
  readonly earlier: ReadonlyArray<{ readonly resumeId: string; readonly status: CallerResumeStatus }>;
};

const KEPT = 50;

/** The resumes callers asked for, one file per session under the data dir. */
export function callerResumes(dataDir: string) {
  const dir = join(dataDir, "agent-server", "resumes");
  const file = (sessionId: string) => join(dir, `${encodeURIComponent(sessionId)}.json`);
  return {
    async get(sessionId: string): Promise<SessionResumes | undefined> {
      try {
        return JSON.parse(await readFile(file(sessionId), "utf8")) as SessionResumes;
      } catch {
        return undefined;
      }
    },
    async save(sessionId: string, resume: CallerResume): Promise<void> {
      const current = await this.get(sessionId);
      const earlier = current === undefined || current.latest.resumeId === resume.resumeId
        ? current?.earlier ?? []
        : [{ resumeId: current.latest.resumeId, status: current.latest.status }, ...current.earlier].slice(0, KEPT);
      const record: SessionResumes = { latest: resume, earlier };
      await mkdir(dir, { recursive: true });
      // Written whole, then renamed, so a crash never leaves half a record.
      const temporary = `${file(sessionId)}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify(record));
      await rename(temporary, file(sessionId));
    },
  };
}
