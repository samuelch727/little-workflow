import { describe, expect, it } from "vitest";
import { resolveLocalHostPaths, sessionPaths } from "../local-host/paths.js";
import { withTempDir } from "../test/temp.js";
import { createLocalFileWriter } from "./file-writer.js";

describe("FileWriter", () => {
  it("writes, reads, lists, and removes files in /session", async () => {
    await withTempDir(async (dir) => {
      const paths = sessionPaths(resolveLocalHostPaths({ dataDir: dir }, dir), "chat");
      const files = createLocalFileWriter(paths);

      const ref = await files.writeText("/session/notes/one.md", "hello");
      expect(ref.path).toBe("/session/notes/one.md");
      expect((await files.read("/session/notes/one.md")).text()).toBe("hello");
      expect((await files.list("/session/notes")).map((entry) => entry.path)).toEqual([
        "/session/notes/one.md",
      ]);

      await files.remove("/session/notes/one.md");
      await expect(files.read("/session/notes/one.md")).rejects.toThrow(/ENOENT/);
    });
  });

  it("marks artifact writes when path is under /artifacts", async () => {
    await withTempDir(async (dir) => {
      const paths = sessionPaths(resolveLocalHostPaths({ dataDir: dir }, dir), "chat");
      const files = createLocalFileWriter(paths);

      const ref = await files.writeJSON("/artifacts/report/data.json", { ok: true });
      expect(ref.artifact?.path).toBe("/artifacts/report/data.json");
      expect(ref.mediaType).toBe("application/json");
    });
  });

  it("rejects raw host paths and traversal", async () => {
    await withTempDir(async (dir) => {
      const paths = sessionPaths(resolveLocalHostPaths({ dataDir: dir }, dir), "chat");
      const files = createLocalFileWriter(paths);

      await expect(files.writeText("/tmp/outside.txt", "x")).rejects.toThrow(/managed root/);
      await expect(files.writeText("/session/../outside.txt", "x")).rejects.toThrow(/traversal/);
    });
  });

  it("does not expose a /skills managed root", async () => {
    await withTempDir(async (dir) => {
      const paths = sessionPaths(resolveLocalHostPaths({ dataDir: dir }, dir), "chat");
      const files = createLocalFileWriter(paths);

      await expect(files.read("/skills/foo/SKILL.md")).rejects.toThrow(/managed root/);
      await expect(files.list("/skills")).rejects.toThrow(/managed root/);
    });
  });
});
