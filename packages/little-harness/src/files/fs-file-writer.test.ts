import { InMemoryFs } from "just-bash";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildMemorySystemContext } from "../memory/memory.js";
import { createFsFileWriter } from "./fs-file-writer.js";

afterEach(() => vi.restoreAllMocks());

describe("FsFileWriter filesystem errors", () => {
  it.each(["read", "list", "remove"] as const)("gives missing %s the native code and the original message", async operation => {
    const fs = new InMemoryFs();
    const files = createFsFileWriter(fs);
    const path = "/persistent/missing/item";
    const raw = await (
      operation === "read" ? fs.readFileBuffer(path) :
        operation === "list" ? fs.readdir(path) : fs.rm(path, { recursive: false, force: false })
    ).catch(error => error as Error);
    expect(raw).toBeInstanceOf(Error);
    if (!(raw instanceof Error)) throw new Error("The missing-path operation must fail with an Error.");
    expect(raw).not.toHaveProperty("code");

    await expect(files[operation](path)).rejects.toMatchObject({ code: "ENOENT", message: raw.message });
    expect(await fs.exists("/persistent")).toBe(false);
  });

  it.each(["mkdir", "writeFile"] as const)("normalizes a write's %s failure", async operation => {
    const fs = new InMemoryFs();
    const failure = new Error("ENOSPC: original write detail");
    vi.spyOn(fs, operation).mockRejectedValue(failure);
    const files = createFsFileWriter(fs);
    await expect(files.writeText("/session/notes.md", "note")).rejects.toBe(failure);
    expect(failure).toMatchObject({ code: "ENOSPC", message: "ENOSPC: original write detail" });
  });

  it.each(["readdir", "stat"] as const)("normalizes a %s failure reached during recursive listing", async operation => {
    const fs = new InMemoryFs();
    const files = createFsFileWriter(fs);
    await files.writeText("/session/notes/nested/one.md", "one");
    const failure = new Error("EACCES: recursive entry refused");
    if (operation === "readdir") {
      const readdir = fs.readdir.bind(fs);
      vi.spyOn(fs, "readdir").mockImplementation(async path => {
        if (path === "/session/notes/nested") throw failure;
        return readdir(path);
      });
    } else {
      const stat = fs.stat.bind(fs);
      vi.spyOn(fs, "stat").mockImplementation(async path => {
        if (path === "/session/notes/nested/one.md") throw failure;
        return stat(path);
      });
    }
    await expect(files.list("/session/notes", { recursive: true })).rejects.toBe(failure);
    expect(failure).toMatchObject({ code: "EACCES", message: "EACCES: recursive entry refused" });
  });

  it("preserves an already-coded error object", async () => {
    const fs = new InMemoryFs();
    const failure = Object.assign(new Error("ENOENT: prefix does not override the code"), { code: "EIO" });
    vi.spyOn(fs, "readFileBuffer").mockRejectedValue(failure);
    await expect(createFsFileWriter(fs).read("/session/note.md")).rejects.toBe(failure);
    expect(failure.code).toBe("EIO");
  });

  it("preserves an error without an errno prefix", async () => {
    const fs = new InMemoryFs();
    const failure = new Error("storage disconnected");
    vi.spyOn(fs, "rm").mockRejectedValue(failure);
    await expect(createFsFileWriter(fs).remove("/session/note.md")).rejects.toBe(failure);
    expect(failure).not.toHaveProperty("code");
  });

  it("replaces a frozen filesystem error while preserving its message and cause", async () => {
    const fs = new InMemoryFs();
    const failure = Object.freeze(new Error("ENOENT: frozen missing folder"));
    vi.spyOn(fs, "readdir").mockRejectedValue(failure);
    await expect(createFsFileWriter(fs).list("/session/notes")).rejects.toMatchObject({
      code: "ENOENT", message: failure.message, cause: failure,
    });
  });

  it("builds an empty memory index without creating the missing memory folder", async () => {
    const fs = new InMemoryFs();
    const mkdir = vi.spyOn(fs, "mkdir");
    const context = await buildMemorySystemContext([{
      harnessDir: "/persistent/memory", commit: "after-turn", maxIndexBytes: 8000, skill: true,
    }], createFsFileWriter(fs), { readOnlyDirs: [], hasMemorySkill: true });
    expect(context.text).toContain("## /persistent/memory");
    expect(context.text).toContain("No memories yet.");
    expect(context.warnings).toEqual([]);
    expect(mkdir).not.toHaveBeenCalled();
    expect(await fs.exists("/persistent/memory")).toBe(false);
  });
});
