import { InMemoryFs } from "just-bash";
import { describe, expect, it } from "vitest";
import { snapshotFs } from "../files/diff.js";
import { SubtreeFs } from "./subtree-fs.js";

describe("SubtreeFs", () => {
  it("shows one folder of a filesystem as its root, and never climbs out of it", async () => {
    const outer = new InMemoryFs({ "/session/a.txt": "a", "/secret.txt": "s" });
    const view = new SubtreeFs(outer, "/session");

    expect(await view.readFile("/a.txt")).toBe("a");
    expect(await view.readFile("/../secret.txt").catch(() => "missing")).toBe("missing");
    await view.mkdir("/dir/deep", { recursive: true });
    await view.writeFile("/dir/deep/b.txt", "b");
    expect(await outer.readFile("/session/dir/deep/b.txt")).toBe("b");
    expect(view.getAllPaths()).toEqual(expect.arrayContaining(["/", "/a.txt", "/dir/deep/b.txt"]));
    expect(view.getAllPaths()).not.toContain("/secret.txt");
    expect((await view.readdirWithFileTypes("/")).map((entry) => entry.name).sort()).toEqual(["a.txt", "dir"]);

    await view.symlink("/a.txt", "/link");
    expect(await view.readlink("/link")).toBe("/a.txt");
    expect(await outer.readlink("/session/link")).toBe("/session/a.txt");
    expect(await view.realpath("/link")).toBe("/a.txt");

    await view.mv("/a.txt", "/moved.txt");
    expect(await outer.exists("/session/moved.txt")).toBe(true);
  });

  it("snapshots a folder of a filesystem by relative path", async () => {
    const fs = new InMemoryFs({ "/persistent/notes/todo.md": "- one", "/persistent/notes/sub/x.txt": "x" });

    const snapshot = await snapshotFs(fs, "/persistent/notes");

    expect(Object.keys(snapshot).sort()).toEqual(["sub/x.txt", "todo.md"]);
    expect(new TextDecoder().decode(snapshot["todo.md"])).toBe("- one");
    expect(await snapshotFs(fs, "/persistent/missing")).toEqual({});
  });
});
