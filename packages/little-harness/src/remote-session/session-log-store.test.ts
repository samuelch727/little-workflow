import { describe, expect, it, vi } from "vitest";
import * as path from "node:path";
import { withTempDir } from "../test/temp.js";

// Simulates write(2) landing partial bytes before failing (ENOSPC/EIO): the next
// appendFile call after arming writes `partial` instead of its payload and throws.
let failNextAppendWithPartial: string | undefined;

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    appendFile: (async (file: any, data: any, encoding: any) => {
      const partial = failNextAppendWithPartial;
      if (partial !== undefined) {
        failNextAppendWithPartial = undefined;
        await actual.appendFile(file, partial, encoding);
        throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
      }
      return actual.appendFile(file, data, encoding);
    }) as typeof import("node:fs/promises").appendFile,
  };
});

const { createFileSessionLog } = await import("./session-log-store.js");

describe("createFileSessionLog", () => {
  it("does not merge the retry after a failed partial append into the torn fragment", async () => {
    await withTempDir(async (dir) => {
      const logPath = path.join(dir, "events.ndjson");
      const store = createFileSessionLog({ path: logPath });

      await store.append({ type: "harness.session.started", runId: "run_partial", payload: {} });

      failNextAppendWithPartial = '{"type":"harness.sess';
      await expect(
        store.append({ type: "harness.session.completed", runId: "run_partial", payload: {} }),
      ).rejects.toThrow(/ENOSPC/u);

      // The retry is acknowledged with the same sequence the failed attempt would have used…
      const retried = await store.append({
        type: "harness.session.completed",
        runId: "run_partial",
        payload: {},
      });
      expect(retried.sequence).toBe(2);

      // …and a fresh process actually sees it: the torn fragment must not have swallowed it.
      const reopened = createFileSessionLog({ path: logPath });
      const events = await reopened.priorEvents({ runId: "run_partial" });
      expect(events.map((event) => event.sequence)).toEqual([1, 2]);
    });
  });
});
