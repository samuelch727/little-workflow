import { mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { localHost } from "../local-host/index.js";
import { withTempDir } from "../test/temp.js";
import { createWorkflowRuntime } from "./runtime.js";

describe("createWorkflowRuntime", () => {
  it("mounts Workflow memory and scratch under /mnt and skills under .agents/skills", async () => {
    await withTempDir(async (dir) => {
      const memory = path.join(dir, "memory");
      const scratch = path.join(dir, "scratch");
      const skill = path.join(dir, "skills", "review", "SKILL.md");
      await mkdir(memory, { recursive: true });
      await mkdir(scratch, { recursive: true });
      await mkdir(path.dirname(skill), { recursive: true });
      await writeFile(path.join(memory, "note.md"), "memory", "utf8");
      await writeFile(path.join(scratch, "todo.md"), "scratch", "utf8");
      await writeFile(skill, "---\nname: review\ndescription: Review.\n---\n\nBody", "utf8");

      const host = localHost({ dataDir: path.join(dir, "host") });
      const session = await host.sessions.getOrCreate({ id: "workflow-runtime" });
      const prepared = await host.prepareTurn({ session, turnId: "turn_1", persistentDirs: [] });
      const runtime = await createWorkflowRuntime({
        prepared,
        mounts: [
          { mountPath: "/mnt/memory/workflow/", backingPath: memory, mode: "ro" },
          { mountPath: "/mnt/scratch/own/", backingPath: scratch, mode: "rw" },
          { mountPath: ".agents/skills/review/SKILL.md", backingPath: skill, mode: "ro" },
        ],
      });

      const result = await (runtime.shellTool() as any).execute(
        {
          cmd: "cat /mnt/memory/workflow/note.md && cat /mnt/scratch/own/todo.md && cat .agents/skills/review/SKILL.md && test ! -e /mnt/skills/review/SKILL.md",
        },
        {},
      );

      expect(result).toMatchObject({ exitCode: 0 });
      expect(String(result.stdout)).toContain("memory");
      expect(String(result.stdout)).toContain("scratch");
      expect(String(result.stdout)).toContain("Body");
      expect(runtime.systemHints().join("\n")).toContain(".agents/skills");
      expect(runtime.systemHints().join("\n")).not.toContain("/mnt/skills");
    });
  });

  it("accepts both Workflow cmd input and Little Harness command input", async () => {
    await withTempDir(async (dir) => {
      const host = localHost({ dataDir: dir });
      const session = await host.sessions.getOrCreate({ id: "cmd-compat" });
      const prepared = await host.prepareTurn({ session, turnId: "turn_1", persistentDirs: [] });
      const runtime = await createWorkflowRuntime({ prepared, mounts: [] });

      await expect((runtime.shellTool() as any).execute({ cmd: "pwd" }, {})).resolves.toMatchObject({
        exitCode: 0,
      });
      await expect((runtime.shellTool() as any).execute({ command: "pwd" }, {})).resolves.toMatchObject({
        exitCode: 0,
      });
    });
  });

  it("rejects empty shell input at schema validation time", async () => {
    await withTempDir(async (dir) => {
      const host = localHost({ dataDir: dir });
      const session = await host.sessions.getOrCreate({ id: "schema-compat" });
      const prepared = await host.prepareTurn({ session, turnId: "turn_1", persistentDirs: [] });
      const runtime = await createWorkflowRuntime({ prepared, mounts: [] });
      const shell = runtime.shellTool() as any;

      expect(shell.inputSchema.safeParse({}).success).toBe(false);
      expect(shell.inputSchema.safeParse({ cmd: "pwd" }).success).toBe(true);
      expect(shell.inputSchema.safeParse({ command: "pwd" }).success).toBe(true);
    });
  });

  it("preserves cwd and timeoutMs command options", async () => {
    await withTempDir(async (dir) => {
      const scratch = path.join(dir, "scratch");
      await mkdir(scratch, { recursive: true });

      const host = localHost({ dataDir: path.join(dir, "host") });
      const session = await host.sessions.getOrCreate({ id: "command-options" });
      const prepared = await host.prepareTurn({ session, turnId: "turn_1", persistentDirs: [] });
      const runtime = await createWorkflowRuntime({
        prepared,
        mounts: [{ mountPath: "/mnt/scratch/own/", backingPath: scratch, mode: "rw" }],
      });
      const shell = runtime.shellTool() as any;

      const cwdResult = await shell.execute(
        { command: "pwd", cwd: "/mnt/scratch/own" },
        {},
      );
      const timeoutResult = await shell.execute(
        { command: "sleep 1", timeoutMs: 1 },
        {},
      );

      expect(cwdResult).toMatchObject({ exitCode: 0 });
      expect(String(cwdResult.stdout).trim()).toBe("/mnt/scratch/own");
      expect(timeoutResult).toMatchObject({ exitCode: 124 });
    });
  });
});
