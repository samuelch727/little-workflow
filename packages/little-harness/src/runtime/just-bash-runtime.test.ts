import { createHook } from "node:async_hooks";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tool } from "ai";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { localHost, localSessionWorkspace } from "../local-host/index.js";
import { resolveLocalHostPaths } from "../local-host/paths.js";
import { LocalSessionStore, type LocalHarnessSession } from "../local-host/session-store.js";
import { withTempDir } from "../test/temp.js";
import { resolveTraceOptions } from "../trace/options.js";
import {
  bashOptionsForRuntime,
  buildWorkspaceFs,
  createJustBashRuntime,
  defenseInDepthForAdapter,
} from "./just-bash-runtime.js";

describe("createJustBashRuntime", () => {
  it("runs shell commands against /session and /artifacts", async () => {
    await withTempDir(async (dir) => {
      const session = await new LocalSessionStore(resolveLocalHostPaths({ dataDir: dir }, dir)).getOrCreate({
        id: "chat",
      });
      await session.files.writeText("/session/input.txt", "hello");

      const runtime = await createJustBashRuntime({ workspace: localSessionWorkspace(session), files: session.files });
      const shell = runtime.shellTool();
      const result = await (shell as any).execute(
        { command: "cat /session/input.txt > /artifacts/out.txt" },
        {},
      );

      expect(result.exitCode).toBe(0);
      expect((await session.files.read("/artifacts/out.txt")).text()).toBe("hello");
    });
  });

  it("rejects shell writes outside managed harness roots", async () => {
    await withTempDir(async (dir) => {
      const session = await new LocalSessionStore(resolveLocalHostPaths({ dataDir: dir }, dir)).getOrCreate({
        id: "chat",
      });

      const runtime = await createJustBashRuntime({ workspace: localSessionWorkspace(session), files: session.files });
      const shell = runtime.shellTool();
      const result = await (shell as any).execute({ command: "echo nope > /tmp/out.txt" }, {});

      expect(result.exitCode).not.toBe(0);
      await expect(session.files.read("/session/../tmp/out.txt")).rejects.toThrow();
    });
  });

  it("rejects shell writes to read-only Persistent Dirs immediately", async () => {
    await withTempDir(async (dir) => {
      const session = (await new LocalSessionStore(
        resolveLocalHostPaths({ dataDir: dir }, dir),
      ).getOrCreate({ id: "chat" })) as LocalHarnessSession;
      await session.files.writeText("/persistent/knowledge/source.txt", "source");
      await session.files.writeText("/persistent/work/.keep", "");
      session.setReadOnlyPersistentDirs(["/persistent/knowledge/"]);

      const runtime = await createJustBashRuntime({ workspace: localSessionWorkspace(session), files: session.files });
      const shell = runtime.shellTool();
      const read = await (shell as any).execute({ command: "cat /persistent/knowledge/source.txt" }, {});
      const write = await (shell as any).execute(
        { command: "echo changed > /persistent/knowledge/source.txt" },
        {},
      );
      const linkBypass = await (shell as any).execute(
        { command: "ln /persistent/knowledge/source.txt /persistent/work/source-link.txt" },
        {},
      );

      expect(read).toMatchObject({ exitCode: 0, stdout: "source" });
      expect(write.exitCode).not.toBe(0);
      expect(linkBypass.exitCode).not.toBe(0);
      expect((await session.files.read("/persistent/knowledge/source.txt")).text()).toBe("source");
    });
  });

  it("stores large runtime file diffs under trace artifacts", async () => {
    await withTempDir(async (dir) => {
      const session = (await new LocalSessionStore(
        resolveLocalHostPaths({ dataDir: dir }, dir),
      ).getOrCreate({ id: "chat" })) as LocalHarnessSession;
      await session.files.writeText("/session/large-diff.md", "before\n");
      const events: any[] = [];

      const runtime = await createJustBashRuntime({
        workspace: localSessionWorkspace(session),
        files: session.files,
        traceOptions: resolveTraceOptions(
          { fileDiffs: { maxInlineBytes: 24, maxBytesToDiff: 4096 } },
          undefined,
        ),
        emit: async (event) => {
          events.push(event);
        },
      });
      const shell = runtime.shellTool();

      await (shell as any).execute({
        command: "python -c \"open('/session/large-diff.md','w').write('after line\\\\n'*40)\"",
      }, {});

      const diff = events.find(
        (event) => event.type === "harness.file.updated" && event.metadata?.path === "/session/large-diff.md",
      )?.metadata?.diff as { contentRef?: string; truncated?: boolean; preview?: string };
      expect(diff).toMatchObject({
        contentRef: expect.stringMatching(/^\/artifacts\/trace\/file-diffs\//u),
        truncated: true,
      });
      expect(diff.preview?.length).toBeLessThanOrEqual(24);
      expect((await session.files.read(diff.contentRef!)).text()).toContain("+after line");
    });
  });

  it("does not mount /skills for runtime commands", async () => {
    await withTempDir(async (dir) => {
      const session = await new LocalSessionStore(resolveLocalHostPaths({ dataDir: dir }, dir)).getOrCreate({
        id: "chat",
      });

      const runtime = await createJustBashRuntime({ workspace: localSessionWorkspace(session), files: session.files });
      const shell = runtime.shellTool();
      const result = await (shell as any).execute({ command: "cat /skills/new.txt" }, {});

      expect(result.exitCode).not.toBe(0);
    });
  });

  it("mounts /.agents read-only for remote skill commands", async () => {
    await withTempDir(async (dir) => {
      const session = await new LocalSessionStore(resolveLocalHostPaths({ dataDir: dir }, dir)).getOrCreate({
        id: "chat",
      });
      const skillDir = path.join(session.paths.root, ".agents", "skills", "remote");
      await mkdir(skillDir, { recursive: true });
      await writeFile(path.join(skillDir, "SKILL.md"), "remote skill", "utf8");

      const runtime = await createJustBashRuntime({ workspace: localSessionWorkspace(session), files: session.files });
      const shell = runtime.shellTool();
      const read = await (shell as any).execute({ command: "cat /.agents/skills/remote/SKILL.md" }, {});
      const write = await (shell as any).execute(
        { command: "echo no > /.agents/skills/remote/new.txt" },
        {},
      );

      expect(read).toMatchObject({ exitCode: 0, stdout: "remote skill" });
      expect(write.exitCode).not.toBe(0);
    });
  });

  it("resolves relative .agents skill paths from the default cwd", async () => {
    await withTempDir(async (dir) => {
      const session = await new LocalSessionStore(resolveLocalHostPaths({ dataDir: dir }, dir)).getOrCreate({
        id: "chat",
      });
      const skillDir = path.join(session.paths.root, ".agents", "skills", "remote");
      await mkdir(skillDir, { recursive: true });
      await writeFile(path.join(skillDir, "SKILL.md"), "relative remote skill", "utf8");

      const runtime = await createJustBashRuntime({ workspace: localSessionWorkspace(session), files: session.files });
      const shell = runtime.shellTool();
      const read = await (shell as any).execute({
        command: "cat .agents/skills/remote/SKILL.md && echo working > note.txt",
      }, {});

      expect(read).toMatchObject({ exitCode: 0, stdout: "relative remote skill" });
      expect((await session.files.read("/session/note.txt")).text()).toBe("working\n");
    });
  });

  it("hardens the subprocess adapter and only the subprocess adapter", async () => {
    expect(defenseInDepthForAdapter("subprocess")).toBe(true);
    // Not an oversight: the layer patches process-wide globals, so the in-process adapter
    // opts out of a just-bash default that would otherwise reach the embedding host.
    expect(defenseInDepthForAdapter("in-process")).toBe(false);

    await withTempDir(async (dir) => {
      const session = await new LocalSessionStore(
        resolveLocalHostPaths({ dataDir: dir }, dir),
      ).getOrCreate({ id: "adapter-options" });
      const fs = await buildWorkspaceFs(localSessionWorkspace(session), []);
      const optionsFor = (adapter: "in-process" | "subprocess") =>
        bashOptionsForRuntime(fs, "/session", undefined, {
          javascript: true,
          defenseInDepth: defenseInDepthForAdapter(adapter),
        });

      expect(optionsFor("subprocess").defenseInDepth).toBe(true);
      expect(optionsFor("in-process").defenseInDepth).toBe(false);
    });
  });

  it("does not let defense-in-depth patches block host async hooks", async () => {
    await withTempDir(async (dir) => {
      const host = localHost({ dataDir: dir });
      const session = await host.sessions.getOrCreate({ id: "async-hook" });
      const prepared = await host.prepareTurn({
        session,
        turnId: "turn_1",
        persistentDirs: [],
      });
      const runtime = await prepared.createRuntime({});
      const shell = runtime.shellTool() as any;
      const hook = createHook({
        init() {
          void globalThis.performance.now();
        },
      });

      hook.enable();
      try {
        const result = await shell.execute({ command: "echo ok" }, {});
        expect(result).toMatchObject({ stdout: "ok\n", exitCode: 0 });
      } finally {
        hook.disable();
      }
    });
  });

  it("is wired through Local Host prepared turns", async () => {
    await withTempDir(async (dir) => {
      const host = localHost({ dataDir: dir });
      const session = await host.sessions.getOrCreate({ id: "chat" });
      await session.files.writeText("/session/input.txt", "ok");
      const prepared = await host.prepareTurn({
        session,
        turnId: "turn_1",
        persistentDirs: [],
      });

      const runtime = await prepared.createRuntime({});
      const result = await (runtime.shellTool() as any).execute({ command: "cat /session/input.txt" }, {});

      expect(result).toMatchObject({ exitCode: 0, stdout: "ok" });
    });
  });

  it("preserves cwd and environment between shell calls", async () => {
    await withTempDir(async (dir) => {
      const host = localHost({ dataDir: dir });
      const session = await host.sessions.getOrCreate({ id: "shell-state" });
      const prepared = await host.prepareTurn({
        session,
        turnId: "turn_1",
        persistentDirs: [],
      });
      const runtime = await prepared.createRuntime({});
      const shell = runtime.shellTool() as any;

      const setup = await shell.execute(
        { command: "mkdir -p /session/state && cd /session/state && export ANSWER=42" },
        {},
      );
      const followUp = await shell.execute({ command: "pwd && printf $ANSWER" }, {});

      expect(setup).toMatchObject({ exitCode: 0 });
      expect(followUp).toMatchObject({ stdout: "/session/state\n42", exitCode: 0 });
    });
  });

  it("mounts caller-provided runtime mounts", async () => {
    await withTempDir(async (dir) => {
      const external = path.join(dir, "external");
      await mkdir(external, { recursive: true });
      await writeFile(path.join(external, "note.txt"), "hello", "utf8");

      const host = localHost({ dataDir: path.join(dir, "host") });
      const session = await host.sessions.getOrCreate({ id: "mounts" });
      const prepared = await host.prepareTurn({
        session,
        turnId: "turn_1",
        persistentDirs: [],
      });
      const runtime = await prepared.createRuntime({
        mounts: [{ mountPath: "/mnt/custom/", backingPath: external, mode: "ro" }],
      });

      const result = await (runtime.shellTool() as any).execute(
        { command: "cat /mnt/custom/note.txt" },
        {},
      );

      expect(result).toMatchObject({ stdout: "hello", exitCode: 0 });
    });
  });

  it("expands caller-provided wildcard directory mounts", async () => {
    await withTempDir(async (dir) => {
      const steps = path.join(dir, "steps");
      const enrichScratch = path.join(steps, "enrich", "scratch");
      const reviewScratch = path.join(steps, "review", "scratch");
      await mkdir(enrichScratch, { recursive: true });
      await mkdir(reviewScratch, { recursive: true });
      await writeFile(path.join(enrichScratch, "worker-memory-copy.md"), "memory copy", "utf8");
      await writeFile(path.join(reviewScratch, "notes.md"), "review notes", "utf8");

      const host = localHost({ dataDir: path.join(dir, "host") });
      const session = await host.sessions.getOrCreate({ id: "wildcard-mounts" });
      const prepared = await host.prepareTurn({
        session,
        turnId: "turn_1",
        persistentDirs: [],
      });
      const runtime = await prepared.createRuntime({
        mounts: [{ mountPath: "/mnt/scratch/peer-steps/", backingPath: path.join(steps, "*", "scratch"), mode: "ro" }],
      });
      const shell = runtime.shellTool() as any;

      const read = await shell.execute(
        { command: "cat /mnt/scratch/peer-steps/enrich/worker-memory-copy.md && cat /mnt/scratch/peer-steps/review/notes.md" },
        {},
      );
      const write = await shell.execute(
        { command: "echo no > /mnt/scratch/peer-steps/enrich/worker-memory-copy.md" },
        {},
      );

      expect(read).toMatchObject({ stdout: "memory copyreview notes", exitCode: 0 });
      expect(write.exitCode).not.toBe(0);
      await expect(stat(path.join(steps, "*"))).rejects.toThrow();
    });
  });

  it("mounts single files without exposing sibling host files", async () => {
    await withTempDir(async (dir) => {
      const backingDir = path.join(dir, "skill");
      const backingFile = path.join(backingDir, "SKILL.md");
      await mkdir(backingDir, { recursive: true });
      await writeFile(backingFile, "visible", "utf8");
      await writeFile(path.join(backingDir, "secret.txt"), "hidden", "utf8");

      const host = localHost({ dataDir: path.join(dir, "host") });
      const session = await host.sessions.getOrCreate({ id: "file-mount-ro" });
      const prepared = await host.prepareTurn({
        session,
        turnId: "turn_1",
        persistentDirs: [],
      });
      const runtime = await prepared.createRuntime({
        mounts: [{ mountPath: "/mnt/skills/review/SKILL.md", backingPath: backingFile, mode: "ro" }],
      });
      const shell = runtime.shellTool() as any;

      const visible = await shell.execute({ command: "cat /mnt/skills/review/SKILL.md" }, {});
      const copy = await shell.execute(
        { command: "cp /mnt/skills/review/SKILL.md /session/copied.md && cat /session/copied.md" },
        {},
      );
      const sibling = await shell.execute({ command: "cat /mnt/skills/review/secret.txt" }, {});
      const write = await shell.execute({ command: "echo changed > /mnt/skills/review/SKILL.md" }, {});

      expect(visible).toMatchObject({ stdout: "visible", exitCode: 0 });
      expect(copy).toMatchObject({ stdout: "visible", exitCode: 0 });
      expect(sibling.exitCode).not.toBe(0);
      expect(write.exitCode).not.toBe(0);
      expect(await readFile(backingFile, "utf8")).toBe("visible");
    });
  });

  it("mounts writable single files without exposing sibling host files", async () => {
    await withTempDir(async (dir) => {
      const backingDir = path.join(dir, "config");
      const backingFile = path.join(backingDir, "state.json");
      await mkdir(backingDir, { recursive: true });
      await writeFile(backingFile, "{\"count\":0}", "utf8");
      await writeFile(path.join(backingDir, "secret.txt"), "hidden", "utf8");

      const host = localHost({ dataDir: path.join(dir, "host") });
      const session = await host.sessions.getOrCreate({ id: "file-mount-rw" });
      const prepared = await host.prepareTurn({
        session,
        turnId: "turn_1",
        persistentDirs: [],
      });
      const runtime = await prepared.createRuntime({
        mounts: [{ mountPath: "/mnt/state.json", backingPath: backingFile, mode: "rw" }],
      });
      const shell = runtime.shellTool() as any;

      const write = await shell.execute({ command: "echo '{\"count\":1}' > /mnt/state.json" }, {});
      const read = await shell.execute({ command: "cat /mnt/state.json" }, {});
      const copy = await shell.execute(
        { command: "echo '{\"count\":2}' > /session/new.json && cp /session/new.json /mnt/state.json" },
        {},
      );
      const sibling = await shell.execute({ command: "cat /mnt/secret.txt" }, {});

      expect(write).toMatchObject({ exitCode: 0 });
      expect(read).toMatchObject({ stdout: "{\"count\":1}\n", exitCode: 0 });
      expect(copy).toMatchObject({ exitCode: 0 });
      expect(sibling.exitCode).not.toBe(0);
      expect(await readFile(backingFile, "utf8")).toBe("{\"count\":2}\n");
    });
  });

  it("emits bash tool events through the tool content policy", async () => {
    await withTempDir(async (dir) => {
      const session = await new LocalSessionStore(resolveLocalHostPaths({ dataDir: dir }, dir)).getOrCreate({
        id: "chat",
      });
      const events: any[] = [];

      const runtime = await createJustBashRuntime({
        workspace: localSessionWorkspace(session),
        files: session.files,
        emit: async (event) => {
          events.push(event);
        },
      });
      const shell = runtime.shellTool();
      await (shell as any).execute(
        { command: "export SECRET_TOKEN=abc123 && echo ok" },
        { toolCallId: "call_bash" },
      );

      expect(events.find((event) => event.type === "harness.runtime.command.succeeded")).toMatchObject({
        metadata: {
          command: "export SECRET_TOKEN=abc123 && echo ok",
          exitCode: 0,
          durationMs: expect.any(Number),
        },
      });
      expect(events.find((event) => event.type === "harness.tool_call.started")).toMatchObject({
        metadata: {
          toolName: "bash",
          toolCallId: "call_bash",
          caller: "runtime",
          input: expect.objectContaining({ captured: true, preview: expect.stringContaining("echo ok") }),
        },
      });
      expect(events.find((event) => event.type === "harness.tool_call.succeeded")).toMatchObject({
        metadata: {
          toolName: "bash",
          toolCallId: "call_bash",
          caller: "runtime",
          durationMs: expect.any(Number),
          output: expect.objectContaining({ captured: true, preview: expect.stringContaining("ok") }),
        },
      });
      const outputPreview = events.find((event) => event.type === "harness.tool_call.succeeded")
        ?.metadata?.output?.preview;
      expect(outputPreview).not.toContain("SECRET_TOKEN");
      expect(outputPreview).not.toContain("abc123");
    });
  });

  it("lets js-exec call configured tools through the runtime tool bridge", async () => {
    await withTempDir(async (dir) => {
      const host = localHost({ dataDir: dir });
      const session = await host.sessions.getOrCreate({ id: "tool-bridge" });
      const events: any[] = [];
      const prepared = await host.prepareTurn({
        session,
        turnId: "turn_1",
        persistentDirs: [],
      });
      const runtime = await prepared.createRuntime({
        tools: {
          add: tool({
            description: "Add two numbers.",
            inputSchema: z.object({ a: z.number(), b: z.number() }),
            execute: async ({ a, b }) => ({ sum: a + b }),
          }),
        },
        emit: async (event) => {
          events.push(event);
        },
      });
      const shell = runtime.shellTool() as any;

      const result = await shell.execute({
        command:
          "js-exec -c 'if (typeof tools !== \"undefined\" && typeof tools.add === \"function\") console.log((await tools.add({a:3,b:4})).sum)' | grep '^7$'",
      }, {});

      expect(result).toMatchObject({ exitCode: 0, stdout: "7\n" });
      const started = events.find(
        (event) => event.type === "harness.tool_call.started" && event.payload?.toolName === "add",
      );
      expect(started).toMatchObject({
        occurrenceId: expect.any(String),
        payload: {
          callId: expect.any(String),
          caller: "runtime",
          toolName: "add",
          args: { type: "harness.runtime_tool.args", value: { a: 3, b: 4 } },
          callIndex: 1,
        },
        metadata: {
          toolName: "add",
          toolCallId: expect.any(String),
          caller: "runtime",
          input: expect.objectContaining({ captured: true }),
        },
      });
      const succeeded = events.find(
        (event) => event.type === "harness.tool_call.succeeded" && event.payload?.toolName === "add",
      );
      expect(succeeded).toMatchObject({
        occurrenceId: started.occurrenceId,
        payload: {
          callId: started.payload.callId,
          caller: "runtime",
          toolName: "add",
          args: { type: "harness.runtime_tool.args", value: { a: 3, b: 4 } },
          result: { sum: 7 },
          callIndex: 1,
          durationMs: expect.any(Number),
        },
        metadata: {
          toolName: "add",
          toolCallId: started.payload.callId,
          caller: "runtime",
          output: expect.objectContaining({ captured: true }),
        },
      });
    });
  });

  it("does not expose configured tools to js-exec when the runtime tool bridge is disabled", async () => {
    await withTempDir(async (dir) => {
      const host = localHost({ dataDir: dir });
      const session = await host.sessions.getOrCreate({ id: "tool-bridge-disabled" });
      const events: any[] = [];
      const prepared = await host.prepareTurn({
        session,
        turnId: "turn_1",
        persistentDirs: [],
      });
      const runtime = await prepared.createRuntime({
        tools: {
          add: tool({
            description: "Add two numbers.",
            inputSchema: z.object({ a: z.number(), b: z.number() }),
            execute: async ({ a, b }) => ({ sum: a + b }),
          }),
        },
        runtime: { toolBridge: false },
        emit: async (event) => {
          events.push(event);
        },
      });
      const shell = runtime.shellTool() as any;

      const result = await shell.execute({
        command:
          "js-exec -c 'if (typeof tools !== \"undefined\" && typeof tools.add === \"function\") console.log((await tools.add({a:3,b:4})).sum)' | grep '^7$'",
      }, {});

      expect(result.exitCode).not.toBe(0);
      expect(
        events.filter((event) => event.type.startsWith("harness.tool_call.") && event.payload?.toolName === "add"),
      ).toHaveLength(0);
    });
  });

  it("adds runtime tool bridge system hints only when the bridge is enabled", async () => {
    await withTempDir(async (dir) => {
      const host = localHost({ dataDir: dir });
      const session = await host.sessions.getOrCreate({ id: "tool-bridge-hints" });
      const prepared = await host.prepareTurn({
        session,
        turnId: "turn_1",
        persistentDirs: [],
      });
      const tools = {
        add: tool({
          description: "Add two numbers.",
          inputSchema: z.object({ a: z.number(), b: z.number() }),
          execute: async ({ a, b }) => ({ sum: a + b }),
        }),
      };

      const enabled = await prepared.createRuntime({ tools });
      const disabled = await prepared.createRuntime({ tools, runtime: { toolBridge: false } });
      const bashDisabled = await prepared.createRuntime({ tools, runtime: { bash: false } });

      expect(enabled.systemHints().join("\n")).toContain("tools.add");
      expect(enabled.systemHints().join("\n")).toContain("js-exec");
      expect(disabled.systemHints().join("\n")).not.toContain("tools.add");
      expect(disabled.systemHints().join("\n")).not.toContain("js-exec");
      expect(bashDisabled.systemHints().join("\n")).not.toContain("tools.add");
      expect(bashDisabled.systemHints().join("\n")).not.toContain("js-exec");
    });
  });
});
