import { describe, expect, it } from "vitest";
import { createLocalFileWriter } from "../files/file-writer.js";
import { sessionPaths, type LocalHostPaths } from "../local-host/paths.js";
import { resolveTraceOptions } from "../trace/options.js";
import type { HarnessEvent } from "../types.js";
import { withTempDir } from "../test/temp.js";
import { createEventedFileWriter } from "./evented-file-writer.js";

describe("createEventedFileWriter", () => {
  it("emits before after metadata and bounded text diffs for file updates", async () => {
    await withTempDir(async (dir) => {
      const paths: LocalHostPaths = {
        dataDir: dir,
        projectRoot: dir,
        sessionsDir: `${dir}/sessions`,
        persistentDir: `${dir}/persistent`,
        locksDir: `${dir}/locks`,
      };
      const base = createLocalFileWriter(sessionPaths(paths, "chat_123"));
      const events: Array<Omit<HarnessEvent, "timestamp" | "sessionId">> = [];
      const files = createEventedFileWriter(
        base,
        async (event) => {
          events.push(event);
        },
        { defaultSource: "agent", traceOptions: resolveTraceOptions(undefined, undefined) },
      );

      await files.writeText("/session/note.md", "old line\nsame\n");
      await files.writeText("/session/note.md", "new line\nsame\n");

      const updated = events.find((event) => event.type === "harness.file.updated");
      expect(updated).toMatchObject({
        metadata: {
          path: "/session/note.md",
          root: "session",
          source: "agent",
          before: { bytes: 14, sha256: expect.any(String) },
          after: { bytes: 14, sha256: expect.any(String) },
          diff: {
            available: true,
            format: "unified",
            preview: expect.stringContaining("-old line"),
          },
        },
      });
      expect((updated?.metadata?.diff as { preview?: string }).preview).toContain("+new line");
    });
  });

  it("does not emit diff previews for redacted paths", async () => {
    await withTempDir(async (dir) => {
      const paths: LocalHostPaths = {
        dataDir: dir,
        projectRoot: dir,
        sessionsDir: `${dir}/sessions`,
        persistentDir: `${dir}/persistent`,
        locksDir: `${dir}/locks`,
      };
      const base = createLocalFileWriter(sessionPaths(paths, "chat_123"));
      const events: Array<Omit<HarnessEvent, "timestamp" | "sessionId">> = [];
      const files = createEventedFileWriter(
        base,
        async (event) => {
          events.push(event);
        },
        {
          defaultSource: "agent",
          traceOptions: resolveTraceOptions(
            { redaction: { paths: ["/persistent/secrets"] } },
            undefined,
          ),
        },
      );

      await files.writeText("/persistent/secrets/key.txt", "old-secret");
      await files.writeText("/persistent/secrets/key.txt", "new-secret");

      const updated = events.find((event) => event.type === "harness.file.updated");
      expect(updated).toMatchObject({
        metadata: {
          path: "/persistent/secrets/key.txt",
          diff: { available: false, reason: "redacted" },
        },
      });
      expect(JSON.stringify(updated?.metadata)).not.toContain("new-secret");
      expect(JSON.stringify(updated?.metadata)).not.toContain("old-secret");
    });
  });

  it("stores large text diffs under trace artifacts", async () => {
    await withTempDir(async (dir) => {
      const paths: LocalHostPaths = {
        dataDir: dir,
        projectRoot: dir,
        sessionsDir: `${dir}/sessions`,
        persistentDir: `${dir}/persistent`,
        locksDir: `${dir}/locks`,
      };
      const base = createLocalFileWriter(sessionPaths(paths, "chat_123"));
      const events: Array<Omit<HarnessEvent, "timestamp" | "sessionId">> = [];
      const files = createEventedFileWriter(
        base,
        async (event) => {
          events.push(event);
        },
        {
          defaultSource: "agent",
          traceOptions: resolveTraceOptions(
            { fileDiffs: { maxInlineBytes: 24, maxBytesToDiff: 4096 } },
            undefined,
          ),
        },
      );

      await files.writeText("/session/large-diff.md", "before\n");
      await files.writeText("/session/large-diff.md", `${"after line\n".repeat(40)}`);

      const diff = events.find((event) => event.type === "harness.file.updated")?.metadata
        ?.diff as { contentRef?: string; preview?: string; truncated?: boolean };
      expect(diff).toMatchObject({
        contentRef: expect.stringMatching(/^\/artifacts\/trace\/file-diffs\//u),
        truncated: true,
      });
      expect(diff.preview?.length).toBeLessThanOrEqual(24);
      expect((await base.read(diff.contentRef!)).text()).toContain("+after line");
    });
  });

  it("records deleted file metadata without deleted contents", async () => {
    await withTempDir(async (dir) => {
      const paths: LocalHostPaths = {
        dataDir: dir,
        projectRoot: dir,
        sessionsDir: `${dir}/sessions`,
        persistentDir: `${dir}/persistent`,
        locksDir: `${dir}/locks`,
      };
      const base = createLocalFileWriter(sessionPaths(paths, "chat_123"));
      const events: Array<Omit<HarnessEvent, "timestamp" | "sessionId">> = [];
      const files = createEventedFileWriter(
        base,
        async (event) => {
          events.push(event);
        },
        { defaultSource: "agent", traceOptions: resolveTraceOptions(undefined, undefined) },
      );

      await files.writeText("/persistent/memory/delete-me.md", "secret old content");
      await files.remove("/persistent/memory/delete-me.md");

      const deleted = events.find((event) => event.type === "harness.file.deleted");
      expect(deleted).toMatchObject({
        metadata: {
          path: "/persistent/memory/delete-me.md",
          root: "persistent",
          source: "agent",
          before: { bytes: 18, sha256: expect.any(String) },
          diff: { available: false, reason: "content_unavailable" },
        },
      });
      expect(JSON.stringify(deleted?.metadata)).not.toContain("secret old content");
    });
  });

  it("emits per-file deletion metadata for recursive directory removes", async () => {
    await withTempDir(async (dir) => {
      const paths: LocalHostPaths = {
        dataDir: dir,
        projectRoot: dir,
        sessionsDir: `${dir}/sessions`,
        persistentDir: `${dir}/persistent`,
        locksDir: `${dir}/locks`,
      };
      const base = createLocalFileWriter(sessionPaths(paths, "chat_123"));
      const events: Array<Omit<HarnessEvent, "timestamp" | "sessionId">> = [];
      const files = createEventedFileWriter(
        base,
        async (event) => {
          events.push(event);
        },
        { defaultSource: "agent", traceOptions: resolveTraceOptions(undefined, undefined) },
      );

      await files.writeText("/session/remove-me/a.txt", "alpha");
      await files.writeText("/session/remove-me/nested/b.txt", "beta");
      events.length = 0;

      await files.remove("/session/remove-me", { recursive: true });

      const deleted = events.filter((event) => event.type === "harness.file.deleted");
      expect(deleted).toHaveLength(2);
      expect(deleted).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            metadata: expect.objectContaining({
              path: "/session/remove-me/a.txt",
              root: "session",
              before: { bytes: 5, sha256: expect.any(String) },
            }),
          }),
          expect.objectContaining({
            metadata: expect.objectContaining({
              path: "/session/remove-me/nested/b.txt",
              root: "session",
              before: { bytes: 4, sha256: expect.any(String) },
            }),
          }),
        ]),
      );
      expect(deleted.some((event) => event.metadata?.path === "/session/remove-me")).toBe(false);
    });
  });
});
