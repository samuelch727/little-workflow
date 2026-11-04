import { appendFile, readFile, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as path from "node:path";
import { withTempDir } from "../test/temp.js";

// Simulates write(2) landing partial bytes before failing (ENOSPC/EIO): the next
// appendFile call after arming writes `partial` instead of its payload and throws.
let failNextAppendWithPartial: string | undefined;
let failNextSyncForPath: string | undefined;
const synchronizedPaths: string[] = [];
const filesystemOperations: string[] = [];

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    appendFile: (async (file: any, data: any, encoding: any) => {
      filesystemOperations.push(`append:${path.resolve(String(file))}`);
      const partial = failNextAppendWithPartial;
      if (partial !== undefined) {
        failNextAppendWithPartial = undefined;
        await actual.appendFile(file, partial, encoding);
        throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
      }
      return actual.appendFile(file, data, encoding);
    }) as typeof import("node:fs/promises").appendFile,
    open: (async (file: any, flags: any, mode?: any) => {
      const handle = await actual.open(file, flags, mode);
      const openedPath = path.resolve(String(file));
      return new Proxy(handle, {
        get(target, property) {
          if (property === "sync") {
            return async () => {
              synchronizedPaths.push(openedPath);
              filesystemOperations.push(`sync:${openedPath}`);
              if (failNextSyncForPath === openedPath) {
                failNextSyncForPath = undefined;
                throw Object.assign(new Error("EINVAL: directory fsync unsupported"), { code: "EINVAL" });
              }
              return target.sync();
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    }) as typeof import("node:fs/promises").open,
  };
});

const { fileSessionLog, inMemorySessionLog } = await import("./session-log-store.js");

afterEach(() => {
  failNextAppendWithPartial = undefined;
  failNextSyncForPath = undefined;
  synchronizedPaths.length = 0;
  filesystemOperations.length = 0;
});

describe("inMemorySessionLog", () => {
  it("linearizes concurrent identical retries and rejects key reuse with different content", async () => {
    const store = inMemorySessionLog();
    const request = {
      type: "harness.session.started",
      runId: "run_memory_idempotency",
      appendIdempotencyKey: "memory-idempotency-started-v1",
      payload: { phase: "started" },
    } as const;
    const results = await Promise.all(
      Array.from({ length: 32 }, () => store.append(structuredClone(request))),
    );
    expect(new Set(results.map((event) => event.eventId)).size).toBe(1);
    expect(new Set(results.map((event) => event.sequence))).toEqual(new Set([1]));
    await expect(store.append({ ...request, payload: { phase: "different" } }))
      .rejects.toThrow(/different request/u);
    expect(await store.priorEvents({ runId: request.runId })).toEqual([results[0]]);
  });
});

describe("fileSessionLog", () => {
  it("retains append idempotency identity and conflicts across process restarts", async () => {
    await withTempDir(async (dir) => {
      const logPath = path.join(dir, "events.ndjson");
      const request = {
        type: "harness.session.started",
        runId: "run_file_idempotency",
        appendIdempotencyKey: "file-idempotency-started-v1",
        payload: { phase: "started" },
      } as const;
      const first = await fileSessionLog({ path: logPath }).append(request);
      const reopened = fileSessionLog({ path: logPath });
      await expect(reopened.append(structuredClone(request))).resolves.toEqual(first);
      await expect(reopened.append({ ...request, payload: { phase: "different" } }))
        .rejects.toThrow(/different request/u);
      expect(await reopened.priorEvents({ runId: request.runId })).toEqual([first]);
    });
  });

  it("does not merge the retry after a failed partial append into the torn fragment", async () => {
    await withTempDir(async (dir) => {
      const logPath = path.join(dir, "events.ndjson");
      const store = fileSessionLog({ path: logPath });

      await store.append({ type: "harness.session.started", runId: "run_partial", appendIdempotencyKey: "append_partial_started_0001", payload: {} });

      failNextAppendWithPartial = '{"type":"harness.sess';
      await expect(
        store.append({ type: "harness.session.completed", runId: "run_partial", appendIdempotencyKey: "append_partial_completed_0001", payload: {} }),
      ).rejects.toThrow(/ENOSPC/u);

      // The retry is acknowledged with the same sequence the failed attempt would have used…
      const retried = await store.append({
        type: "harness.session.completed",
        runId: "run_partial",
        appendIdempotencyKey: "append_partial_completed_0001",
        payload: {},
      });
      expect(retried.sequence).toBe(2);

      // …and a fresh process actually sees it: the torn fragment must not have swallowed it.
      const reopened = fileSessionLog({ path: logPath });
      const events = await reopened.priorEvents({ runId: "run_partial" });
      expect(events.map((event) => event.sequence)).toEqual([1, 2]);
      const completeLines = (await readFile(logPath, "utf8")).trimEnd().split("\n");
      expect(completeLines).toHaveLength(2);
      expect(() => completeLines.map((line) => JSON.parse(line))).not.toThrow();
    });
  });

  it("ignores and truncates only one final unterminated fragment", async () => {
    await withTempDir(async (dir) => {
      const logPath = path.join(dir, "events.ndjson");
      await fileSessionLog({ path: logPath }).append({
        type: "harness.session.started",
        runId: "run_torn_tail",
        appendIdempotencyKey: "torn-tail-started-v1",
        payload: {},
      });
      await appendFile(logPath, '{"type":"torn-tail"', "utf8");

      const reopened = fileSessionLog({ path: logPath });
      await expect(reopened.priorEvents({ runId: "run_torn_tail" }))
        .resolves.toHaveLength(1);
      const second = await reopened.append({
        type: "harness.session.completed",
        runId: "run_torn_tail",
        appendIdempotencyKey: "torn-tail-completed-v1",
        payload: {},
      });
      expect(second.sequence).toBe(2);
      const raw = await readFile(logPath, "utf8");
      expect(raw).not.toContain('"type":"torn-tail"');
      expect(raw.endsWith("\n")).toBe(true);
    });
  });

  it("fails closed on malformed complete JSON and complete normalization failures", async () => {
    await withTempDir(async (dir) => {
      const malformedPath = path.join(dir, "malformed.ndjson");
      await fileSessionLog({ path: malformedPath }).append({
        type: "harness.session.started",
        runId: "run_complete_corruption",
        appendIdempotencyKey: "complete-corruption-started-v1",
        payload: {},
      });
      await appendFile(malformedPath, "not-json\n", "utf8");
      await expect(fileSessionLog({ path: malformedPath }).priorEvents())
        .rejects.toThrow(/Invalid session-log JSON at line 2/u);

      const invalidRecordPath = path.join(dir, "invalid-record.ndjson");
      await writeFile(invalidRecordPath, "{}\n", "utf8");
      await expect(fileSessionLog({ path: invalidRecordPath }).priorEvents())
        .rejects.toThrow(/Invalid session-log record at line 1/u);

      const blankRecordPath = path.join(dir, "blank-record.ndjson");
      await writeFile(blankRecordPath, "\n", "utf8");
      await expect(fileSessionLog({ path: blankRecordPath }).priorEvents())
        .rejects.toThrow(/record at line 1 is empty/u);
    });
  });

  it("rejects a per-run sequence gap even when every record is otherwise valid", async () => {
    await withTempDir(async (dir) => {
      const logPath = path.join(dir, "events.ndjson");
      const store = fileSessionLog({ path: logPath });
      await store.append({
        type: "harness.session.started",
        runId: "run_gap",
        appendIdempotencyKey: "sequence-gap-started-v1",
        payload: {},
      });
      await store.append({
        type: "harness.session.completed",
        runId: "run_gap",
        appendIdempotencyKey: "sequence-gap-completed-v1",
        payload: {},
      });
      const records = (await readFile(logPath, "utf8")).trimEnd().split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      records[1]!.sequence = 3;
      await writeFile(logPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");

      await expect(fileSessionLog({ path: logPath }).priorEvents())
        .rejects.toThrow(/is 3.*expected 2/u);
    });
  });

  it("fsyncs file before parent directory and fails closed when directory sync is unsupported", async () => {
    await withTempDir(async (dir) => {
      const logPath = path.join(dir, "nested", "events.ndjson");
      const request = {
        type: "harness.session.started",
        runId: "run_directory_sync",
        appendIdempotencyKey: "directory-sync-started-v1",
        payload: {},
      } as const;
      const parentPath = path.resolve(path.dirname(logPath));
      failNextSyncForPath = parentPath;
      const store = fileSessionLog({ path: logPath });

      await expect(store.append(request)).rejects.toMatchObject({
        name: "FileSessionLogDurabilityError",
        target: "parent_directory",
      });
      const committedAfterLostResponse = JSON.parse(
        (await readFile(logPath, "utf8")).trimEnd(),
      );

      synchronizedPaths.length = 0;
      const replay = await store.append(structuredClone(request));
      expect(replay).toEqual(committedAfterLostResponse);
      const fileSyncIndex = synchronizedPaths.indexOf(path.resolve(logPath));
      const directorySyncIndex = synchronizedPaths.indexOf(parentPath);
      expect(fileSyncIndex).toBeGreaterThanOrEqual(0);
      expect(directorySyncIndex).toBeGreaterThan(fileSyncIndex);

      const reopened = fileSessionLog({ path: logPath });
      await expect(reopened.priorEvents({ runId: request.runId })).resolves.toEqual([replay]);
    });
  });

  it("replays the committed identity after a lost file-fsync acknowledgement", async () => {
    await withTempDir(async (dir) => {
      const logPath = path.join(dir, "events.ndjson");
      const request = {
        type: "harness.session.started",
        runId: "run_file_sync_replay",
        appendIdempotencyKey: "file-sync-replay-started-v1",
        payload: {},
      } as const;
      failNextSyncForPath = path.resolve(logPath);
      const store = fileSessionLog({ path: logPath });

      await expect(store.append(request)).rejects.toMatchObject({
        name: "FileSessionLogDurabilityError",
        target: "file",
      });
      const committedAfterLostResponse = JSON.parse(
        (await readFile(logPath, "utf8")).trimEnd(),
      );
      await expect(store.append(structuredClone(request)))
        .resolves.toEqual(committedAfterLostResponse);
      await expect(fileSessionLog({ path: logPath }).priorEvents())
        .resolves.toEqual([committedAfterLostResponse]);
    });
  });

  it("persists each newly created parent component before creating the first log file", async () => {
    await withTempDir(async (dir) => {
      const logPath = path.join(dir, "fresh", "deeper", "events.ndjson");
      const firstCreatedParent = path.resolve(path.join(dir, "fresh"));
      const firstCreatedParentContainer = path.resolve(dir);
      const immediateParent = path.resolve(path.dirname(logPath));
      const request = {
        type: "harness.session.started",
        runId: "run_nested_directory_sync",
        appendIdempotencyKey: "nested-directory-sync-started-v1",
        payload: {},
      } as const;
      failNextSyncForPath = firstCreatedParentContainer;
      const store = fileSessionLog({ path: logPath });

      await expect(store.append(request)).rejects.toMatchObject({
        name: "FileSessionLogDurabilityError",
        target: "parent_directory",
      });
      await expect(readFile(logPath)).rejects.toMatchObject({ code: "ENOENT" });

      filesystemOperations.length = 0;
      synchronizedPaths.length = 0;
      await expect(store.append(structuredClone(request))).resolves.toMatchObject({ sequence: 1 });
      const firstParentEntrySync = filesystemOperations.indexOf(`sync:${firstCreatedParentContainer}`);
      const nestedParentEntrySync = filesystemOperations.indexOf(`sync:${firstCreatedParent}`);
      const appendIndex = filesystemOperations.indexOf(`append:${path.resolve(logPath)}`);
      const fileSyncIndex = filesystemOperations.indexOf(`sync:${path.resolve(logPath)}`);
      const immediateParentSyncIndex = filesystemOperations.lastIndexOf(`sync:${immediateParent}`);
      expect(firstParentEntrySync).toBeGreaterThanOrEqual(0);
      expect(nestedParentEntrySync).toBeGreaterThan(firstParentEntrySync);
      expect(appendIndex).toBeGreaterThan(nestedParentEntrySync);
      expect(fileSyncIndex).toBeGreaterThan(appendIndex);
      expect(immediateParentSyncIndex).toBeGreaterThan(fileSyncIndex);
    });
  });
});
