import { InMemoryFs } from "just-bash";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBashTool, type BashScope } from "./bash-tool.js";

const disk = vi.hoisted(() => {
  const state = {
    armed: false, browser: false, calls: [] as string[],
    wrap(actual: Record<string, unknown>, prefix: string): Record<string, unknown> {
      const wrapped: Record<string, unknown> = {};
      for (const [name, value] of Object.entries(actual)) {
        if (name === "default") continue;
        wrapped[name] = typeof value === "function" ? (...args: unknown[]) => {
          if (state.armed) {
            state.calls.push(`${prefix}.${name}`);
            throw new Error(`Unexpected disk call: ${prefix}.${name}`);
          }
          return Reflect.apply(value, actual, args);
        } : name === "promises" && value !== null && typeof value === "object"
          ? state.wrap(value as Record<string, unknown>, `${prefix}.promises`) : value;
      }
      wrapped.default = wrapped;
      return wrapped;
    },
  };
  return state;
});
vi.mock("node:fs/promises", async () => disk.wrap(await vi.importActual("node:fs/promises"), "fs/promises"));
vi.mock("node:fs", async () => disk.wrap(await vi.importActual("node:fs"), "fs"));
vi.mock("@little-stack/harness/internals", async importOriginal => {
  const actual = await importOriginal<typeof import("@little-stack/harness/internals")>();
  return {
    ...actual,
    justBashNodeExport: (...args: Parameters<typeof actual.justBashNodeExport>) =>
      disk.browser ? undefined : actual.justBashNodeExport(...args),
  };
});

afterEach(() => {
  disk.armed = false;
  expect(disk.calls).toEqual([]);
  disk.calls = [];
});

async function fixture(browser: boolean) {
  disk.browser = browser;
  disk.armed = true;
  const files = new InMemoryFs();
  await files.mkdir("/data/scratch", { recursive: true });
  await files.mkdir("/data/memory", { recursive: true });
  await files.mkdir("/data/sources", { recursive: true });
  await files.writeFile("/data/memory/notes.txt", "read-only memory\n");
  await files.writeFile("/data/hidden.txt", "unmounted secret\n");
  const scope: BashScope = {
    files,
    cwd: "/mnt/scratch/own",
    readableRoots: [{ path: "/data/scratch", mode: "rw" }, { path: "/data/memory", mode: "ro" }],
    pathAliases: [
      { mountPath: "/mnt/scratch/own", backingPath: "/data/scratch" },
      { mountPath: "/mnt/memory/org", backingPath: "/data/memory" },
    ],
    capabilities: { python: false, javascript: false },
  };
  return { files, scope };
}

describe.each([false, true])("virtual Bash mounts (browser helper: %s)", browser => {
  it("writes scratch, reads read-only memory and keeps enumeration working without disk", async () => {
    const { files, scope } = await fixture(browser);
    const bash = createBashTool(scope);
    expect(await bash.execute({ cmd: "cat /mnt/memory/org/notes.txt; printf 'one\\ntwo\\n' > own.txt; cat own.txt" }))
      .toMatchObject({ exitCode: 0, stdout: "read-only memory\none\ntwo\n" });
    expect(await files.readFile("/data/scratch/own.txt")).toBe("one\ntwo\n");
    expect(await bash.execute({ cmd: "mkdir -p nested; echo nested > nested/item.txt; printf '%s\\n' *.txt; ls nested; find nested -type f" }))
      .toMatchObject({ exitCode: 0, stdout: "own.txt\nitem.txt\nnested/item.txt\n" });
    for (const cmd of [
      "echo changed > /mnt/memory/org/notes.txt",
      "rm /mnt/memory/org/notes.txt",
      "cp own.txt /mnt/memory/org/copied.txt",
      "chmod 777 /mnt/memory/org/notes.txt",
    ]) expect((await bash.execute({ cmd })).exitCode).not.toBe(0);
    expect(await files.readFile("/data/memory/notes.txt")).toBe("read-only memory\n");
    expect(await files.exists("/data/memory/copied.txt")).toBe(false);
  });

  it("stages a single-file mount without exposing its source siblings", async () => {
    const { files, scope } = await fixture(browser);
    await files.writeFile("/data/sources/public.txt", "one file\n");
    await files.writeFile("/data/sources/secret.txt", "source sibling\n");
    const bash = createBashTool({ ...scope, pathAliases: [
      ...scope.pathAliases!,
      { mountPath: ".agents/skills/one/SKILL.md", backingPath: "/data/sources/public.txt" },
    ] });
    expect(await bash.execute({ cmd: "cat .agents/skills/one/SKILL.md; ls -A .agents/skills/one" }))
      .toMatchObject({ exitCode: 0, stdout: "one file\nSKILL.md\n" });
    expect((await bash.execute({ cmd: "cat .agents/skills/one/secret.txt" })).exitCode).not.toBe(0);
    expect((await bash.execute({ cmd: "echo changed > .agents/skills/one/SKILL.md" })).exitCode).not.toBe(0);
    expect(await files.readFile("/data/sources/public.txt")).toBe("one file\n");
  });

  it("refuses an ln-created relative link before it can expose an unmounted file", async () => {
    const { files, scope } = await fixture(browser);
    const result = await createBashTool(scope).execute({
      cmd: "ln -s ../hidden.txt /mnt/scratch/own/hidden; cat /mnt/scratch/own/hidden",
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).not.toContain("unmounted secret");
    expect(await files.exists("/data/scratch/hidden")).toBe(false);
  });

  it("blocks inherited links for reads and write-through directory paths", async () => {
    const { files, scope } = await fixture(browser);
    await files.symlink("../hidden.txt", "/data/scratch/inherited");
    await files.symlink("/data/memory", "/data/scratch/directory");
    const bash = createBashTool(scope);
    for (const cmd of [
      "cat inherited", "head inherited", "cp inherited copy.txt",
      "echo changed > inherited", "echo changed > directory/notes.txt",
    ]) {
      const result = await bash.execute({ cmd });
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).not.toContain("unmounted secret");
    }
    expect(await files.readFile("/data/hidden.txt")).toBe("unmounted secret\n");
    expect(await files.readFile("/data/memory/notes.txt")).toBe("read-only memory\n");
    expect(await files.exists("/data/scratch/copy.txt")).toBe(false);
  });

  it("rejects symlink ancestors in a configured directory or single-file mount", async () => {
    const { files, scope } = await fixture(browser);
    await files.symlink("/data/memory", "/data/alias");
    for (const backingPath of ["/data/alias", "/data/alias/notes.txt"]) {
      const bash = createBashTool({ ...scope, pathAliases: [
        ...scope.pathAliases!, { mountPath: "/mnt/alias", backingPath },
      ] });
      await expect(bash.execute({ cmd: "cat /mnt/alias/notes.txt" })).rejects.toThrow(/Symlinks are not allowed/);
    }
  });

  it("preflights cp and mv subtrees instead of following nested links inside the delegate", async () => {
    const { files, scope } = await fixture(browser);
    await files.mkdir("/data/scratch/tree");
    await files.symlink("../../hidden.txt", "/data/scratch/tree/nested");
    const bash = createBashTool(scope);
    for (const cmd of ["cp -r tree copied", "mv tree moved"]) {
      const result = await bash.execute({ cmd });
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).not.toContain("unmounted secret");
    }
    expect(await files.exists("/data/scratch/tree")).toBe(true);
    expect(await files.exists("/data/scratch/moved")).toBe(false);
    expect(await files.readFile("/data/hidden.txt")).toBe("unmounted secret\n");
  });
});
