import { MockLanguageModelV3 } from "ai/test";
import { InMemoryFs } from "just-bash";
import disk from "node:fs";
import diskAsync from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createHarness } from "../create-harness.js";
import { generateHarness } from "../execution/generate-harness.js";
import { resumeParked } from "../execution/resume-parked.js";
import { answerInputRequest, listInputRequests } from "../human-input/answers.js";
import { HarnessInputError, HarnessPathError } from "../errors.js";
import { localDir, projectDir, type LocalDirSource } from "../local-host/local-dir.js";
import { createInMemoryDurableStore } from "../local-host/durable-store.js";
import { subprocessSandbox } from "../sandbox/subprocess/subprocess-sandbox.js";
import { skill } from "../skills/skill.js";
import type { HarnessEvent, HarnessMemoryOptions, PersistentDir } from "../types.js";
import type { HarnessWorkflow, HarnessWorkflowRunContext } from "../workflows.js";
import { VIRTUAL_HOST_STATE_DIR, virtualHost } from "./virtual-host.js";

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

type Prompt = ReadonlyArray<{ role: string; content: unknown }>;

/** Runs each command with bash, one model call per command, then answers with the last output. */
function bashModel(commands: readonly string[]) {
  let calls = 0;
  return new MockLanguageModelV3({
    doGenerate: async ({ prompt }) => {
      const command = commands[calls];
      calls += 1;
      if (command !== undefined) {
        return {
          content: [{
            type: "tool-call" as const,
            toolCallId: `call_${calls}`,
            toolName: "bash",
            input: JSON.stringify({ command }),
          }],
          finishReason: { unified: "tool-calls" as const, raw: "tool-calls" },
          usage,
          warnings: [],
        };
      }
      return {
        content: [{ type: "text" as const, text: JSON.stringify(lastToolResult(prompt as Prompt, "bash")) }],
        finishReason: { unified: "stop" as const, raw: "stop" },
        usage,
        warnings: [],
      };
    },
  });
}

function lastToolResult(prompt: Prompt, toolName: string): unknown {
  const results = prompt.flatMap((message) =>
    message.role === "tool" && Array.isArray(message.content)
      ? (message.content as Array<{ type: string; toolName: string; output: { value: unknown } }>)
          .filter((part) => part.type === "tool-result" && part.toolName === toolName)
          .map((part) => part.output.value)
      : [],
  );
  return results.at(-1);
}

async function run(
  host: ReturnType<typeof virtualHost>,
  session: string,
  commands: readonly string[],
  options: { events?: HarnessEvent[]; persistentDirs?: PersistentDir[]; skills?: ReturnType<typeof skill>[]; memory?: HarnessMemoryOptions } = {},
) {
  const harness = createHarness({
    host,
    model: bashModel(commands),
    ...(options.persistentDirs === undefined ? {} : { persistentDirs: options.persistentDirs }),
    ...(options.skills === undefined ? {} : { skills: options.skills }),
    ...(options.memory === undefined ? {} : { memory: options.memory }),
    onEvent: (event) => {
      options.events?.push(event);
    },
  });
  const result = await generateHarness({ harness, session, prompt: "go" });
  if (result.status !== "completed") {
    throw new Error(`The turn ended ${result.status}.`);
  }
  return JSON.parse(result.text) as { stdout: string; stderr: string; exitCode: number };
}

describe("virtualHost", () => {
  it("runs bash over the filesystem it is given, with files the app wrote", async () => {
    const fs = new InMemoryFs();
    const host = virtualHost({ fs });
    const session = await host.sessions.getOrCreate({ id: "chat" });
    await session.files.writeText("/session/notes.md", "hello from the app\n");

    const events: HarnessEvent[] = [];
    const result = await run(host, "chat", ["cat notes.md && echo made > made.txt && mkdir -p /artifacts/out && echo r > /artifacts/out/report.txt"], { events });

    expect(result).toMatchObject({ exitCode: 0, stdout: "hello from the app\n" });
    expect(await fs.readFile("/session/made.txt")).toBe("made\n");
    expect((await session.artifacts.list()).map((artifact) => artifact.path)).toEqual(["/artifacts/out/report.txt"]);
    expect(events.filter((event) => event.type === "harness.file.created").map((event) => event.metadata?.path))
      .toEqual(expect.arrayContaining(["/session/made.txt", "/artifacts/out/report.txt"]));
    // Bash sees the four workspace roots and nothing else of the filesystem.
    const listing = await run(host, "chat", ["ls -a /"]);
    expect(listing.stdout.split(/\s+/u).filter((name) => !["", ".", ".."].includes(name)).sort())
      .toEqual([".agents", "artifacts", "dev", "persistent", "session"]);
    expect((await run(host, "chat", [`ls ${VIRTUAL_HOST_STATE_DIR}`])).exitCode).not.toBe(0);
  });

  it("numbers trace events and keeps status in the filesystem, so a later host carries on", async () => {
    const fs = new InMemoryFs();
    const first: HarnessEvent[] = [];
    await run(virtualHost({ fs }), "chat", ["echo one"], { events: first });
    const second: HarnessEvent[] = [];
    await run(virtualHost({ fs }), "chat", ["echo two"], { events: second });

    const sequences = [...first, ...second].map((event) => event.sequence);
    expect(sequences).toEqual(sequences.map((_, index) => index + 1));
    expect(new Set(first.map((event) => event.eventId)).size).toBe(first.length);
    const reopened = await virtualHost({ fs }).sessions.get("chat");
    expect(await reopened?.status()).toMatchObject({ id: "chat", state: "idle" });
    expect(await virtualHost({ fs }).sessions.get("other")).toBeUndefined();
  });

  it("gives each session its own filesystem when fs is a function, and by default", async () => {
    const filesystems = new Map<string, InMemoryFs>();
    const perChat = virtualHost({
      fs: (sessionId) => {
        const fs = filesystems.get(sessionId) ?? new InMemoryFs();
        filesystems.set(sessionId, fs);
        return fs;
      },
    });
    for (const host of [perChat, virtualHost()]) {
      await run(host, "a", ["echo secret > /session/a.txt"]);
      expect(await run(host, "b", ["cat /session/a.txt"])).toMatchObject({ exitCode: 1 });
      expect(await run(host, "a", ["cat /session/a.txt"])).toMatchObject({ exitCode: 0, stdout: "secret\n" });
    }
    expect(await filesystems.get("a")?.readFile("/session/a.txt")).toBe("secret\n");
    expect(await filesystems.get("b")?.exists("/session/a.txt")).toBe(false);
  });

  it("answers and resumes a parked turn from regular files without getOrCreate", async () => {
    const store = createInMemoryDurableStore();
    let calls = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async ({ prompt }) => {
        calls += 1;
        if (calls <= 2) {
          const asked = lastToolResult(prompt as Prompt, "ask_person") as { taskId: string };
          return {
            content: [{
              type: "tool-call" as const,
              toolCallId: `human_${calls}`,
              toolName: calls === 1 ? "ask_person" : "await_tasks",
              input: JSON.stringify(calls === 1
                ? { question: "Which notebook?" }
                : { taskIds: [asked.taskId], mode: "all" }),
            }],
            finishReason: { unified: "tool-calls" as const, raw: "tool-calls" },
            usage,
            warnings: [],
          };
        }
        const waited = lastToolResult(prompt as Prompt, "await_tasks") as {
          tasks: Array<{ answer: { text: string } }>;
        };
        return {
          content: [{ type: "text" as const, text: waited.tasks[0]!.answer.text }],
          finishReason: { unified: "stop" as const, raw: "stop" },
          usage,
          warnings: [],
        };
      },
    });
    const harnessFor = (fs: InMemoryFs) => createHarness({
      host: virtualHost({ fs, store }), model, humanInput: true, runtime: { bash: false },
    });
    // A file-only save drops empty workspace roots, as the workerd example does.
    const restoreFiles = async (fs: InMemoryFs) => {
      const files: Record<string, Uint8Array> = {};
      for (const file of fs.getAllPaths()) {
        if ((await fs.lstat(file)).isFile) files[file] = await fs.readFileBuffer(file);
      }
      return new InMemoryFs(files);
    };
    const firstFs = new InMemoryFs();
    const first = harnessFor(firstFs);
    expect((await generateHarness({ harness: first, session: "chat", prompt: "Ask me." })).status).toBe("parked");
    const [request] = await listInputRequests({ harness: first, sessionId: "chat" });
    expect(request).toBeDefined();

    const answerFs = await restoreFiles(firstFs);
    expect(await answerFs.exists("/artifacts")).toBe(false);
    const answering = harnessFor(answerFs);
    const answerCreate = vi.spyOn(answering.sessions, "getOrCreate");
    await answerInputRequest({
      harness: answering, sessionId: "chat", requestId: request!.requestId, answer: { text: "Blue notebook" },
    });
    for (const dir of ["/session", "/artifacts", "/persistent", "/.agents"]) {
      expect((await answerFs.lstat(dir)).isDirectory).toBe(true);
    }
    expect(answerCreate).not.toHaveBeenCalled();

    // Drop the empty roots again so resumeParked must independently restore them.
    const resumeFs = await restoreFiles(answerFs);
    expect(await resumeFs.exists("/artifacts")).toBe(false);
    const resuming = harnessFor(resumeFs);
    const resumeCreate = vi.spyOn(resuming.sessions, "getOrCreate");
    const result = await resumeParked({ harness: resuming, sessionId: "chat" });
    expect(result.failed).toEqual([]);
    expect(result.resumed).toHaveLength(1);
    expect(result.resumed[0]!.result).toMatchObject({ status: "completed", text: "Blue notebook" });
    expect(await listInputRequests({ harness: resuming, sessionId: "chat" })).toEqual([]);
    expect(resumeCreate).not.toHaveBeenCalled();
  });

  it("stages skills into /.agents, read-only to bash", async () => {
    const fs = new InMemoryFs();
    const host = virtualHost({ fs });
    const skills = [skill({ name: "review", description: "Review.", harnessDir: ".agents/skills/review", files: { "SKILL.md": "Review body." } })];

    expect((await run(host, "chat", ["cat /.agents/skills/review/SKILL.md"], { skills })).stdout).toContain("Review body.");
    expect((await run(host, "chat", ["echo x > /.agents/skills/review/SKILL.md"], { skills })).exitCode).not.toBe(0);
    expect(await fs.readFile("/.agents/skills/review/SKILL.md")).toContain("Review body.");
  });

  it("loads Persistent Dirs into /persistent and stores what the turn changed", async () => {
    const stored: unknown[] = [];
    const notes: PersistentDir = {
      harnessDir: "/persistent/notes",
      load: () => ({ "todo.md": "- one\n" }),
      store: ({ changes }) => {
        stored.push(changes);
      },
    };
    const rules: PersistentDir = {
      harnessDir: "/persistent/rules",
      commit: "read-only",
      load: () => ({ "rules.md": "be kind\n" }),
    };
    const host = virtualHost();
    const persistentDirs = [notes, rules];

    const edited = await run(host, "chat", ["cat /persistent/rules/rules.md && echo '- two' >> /persistent/notes/todo.md"], { persistentDirs });
    expect(edited).toMatchObject({ exitCode: 0, stdout: "be kind\n" });
    expect(stored).toEqual([
      expect.objectContaining({ updated: { "todo.md": new TextEncoder().encode("- one\n- two\n") } }),
    ]);

    const refused = await run(host, "chat", ["echo no > /persistent/rules/rules.md"], { persistentDirs });
    expect(refused).toMatchObject({ exitCode: 1, stderr: expect.stringContaining("read-only") });
  });

  it("keeps memory across a new host and hides its backing folder from bash", async () => {
    const fs = new InMemoryFs();
    const memory: HarnessMemoryOptions = { sourceDir: "memory", skill: false };
    await run(virtualHost({ fs }), "chat", ["echo 'The release colour is violet.' > /persistent/memory/release.md"], { memory });

    expect(await fs.readFile("/.little-harness/data/memory/release.md")).toBe("The release colour is violet.\n");
    // Removing the checkout proves the second host loads the committed source, not stale workspace files.
    await fs.rm("/persistent/memory", { recursive: true, force: true });
    const recalled = await run(virtualHost({ fs }), "chat", ["cat /persistent/memory/release.md"], { memory });
    expect(recalled).toMatchObject({ exitCode: 0, stdout: "The release colour is violet.\n" });
    const roots = await run(virtualHost({ fs }), "chat", ["ls -A /"], { memory });
    expect(roots.stdout.trim().split(/\s+/u).sort()).toEqual([".agents", "artifacts", "dev", "persistent", "session"]);
    expect((await run(virtualHost({ fs }), "chat", ["cat /.little-harness/data/memory/release.md"], { memory })).exitCode).not.toBe(0);
  });

  it("shares localDir data across separate workspaces with a direct or asynchronous dataFs", async () => {
    for (const asynchronous of [false, true]) {
      const dataFs = new InMemoryFs();
      const filesystems = new Map<string, InMemoryFs>();
      const dataFor = vi.fn(async (_sessionId: string) => dataFs);
      const host = virtualHost({
        fs: (sessionId) => {
          const fs = filesystems.get(sessionId) ?? new InMemoryFs();
          filesystems.set(sessionId, fs);
          return fs;
        },
        dataFs: asynchronous ? dataFor : dataFs,
      });
      const persistentDirs = [localDir({ harnessDir: "/persistent/shared", sourceDir: "shared" })];
      await run(host, "writer", ["echo shared-fact > /persistent/shared/fact.txt"], { persistentDirs });
      expect(await run(host, "reader", ["cat /persistent/shared/fact.txt"], { persistentDirs }))
        .toMatchObject({ exitCode: 0, stdout: "shared-fact\n" });
      expect(await dataFs.readFile("/.little-harness/data/shared/fact.txt")).toBe("shared-fact\n");
      expect(filesystems.get("reader")).not.toBe(filesystems.get("writer"));
      expect(await filesystems.get("writer")!.exists("/.little-harness/data/shared/fact.txt")).toBe(false);
      if (asynchronous) {
        expect(dataFor).toHaveBeenCalledWith("writer");
        expect(dataFor).toHaveBeenCalledWith("reader");
      }
    }
  });

  it("commits nested binary files, updates and deletions to its data filesystem", async () => {
    const fs = new InMemoryFs();
    const dataFs = new InMemoryFs();
    await dataFs.mkdir("/.little-harness/data/shared/nested", { recursive: true });
    await dataFs.writeFile("/.little-harness/data/shared/nested/binary.bin", new Uint8Array([0, 255, 1, 128]));
    await dataFs.writeFile("/.little-harness/data/shared/old.txt", "old");
    const host = virtualHost({ fs, dataFs });
    const persistentDirs = [localDir({ harnessDir: "/persistent/shared", sourceDir: "shared" })];
    const session = await host.sessions.getOrCreate({ id: "chat" });
    const prepared = await host.prepareTurn({ session, turnId: "binary", persistentDirs });
    await prepared.loadPersistentDirs();
    expect((await session.files.read("/persistent/shared/nested/binary.bin")).content)
      .toEqual(new Uint8Array([0, 255, 1, 128]));
    await session.files.writeText("/persistent/shared/old.txt", "updated");
    await session.files.writeText("/persistent/shared/nested/new.txt", "created");
    await fs.rm("/persistent/shared/nested/binary.bin");
    expect(await prepared.commitPersistentDirs()).toMatchObject({ status: "succeeded" });
    expect(await dataFs.readFile("/.little-harness/data/shared/old.txt")).toBe("updated");
    expect(await dataFs.readFile("/.little-harness/data/shared/nested/new.txt")).toBe("created");
    expect(await dataFs.exists("/.little-harness/data/shared/nested/binary.bin")).toBe(false);
  });

  it("rejects static and computed localDir paths outside its POSIX data root", async () => {
    const sources: LocalDirSource[] = [
      "/absolute", "../escape", "nested/../../escape", "nested/../escape", "bad\0path",
      () => "/absolute", () => "../escape", () => "nested/../../escape", () => ".",
    ];
    for (const sourceDir of sources) {
      const host = virtualHost();
      const session = await host.sessions.getOrCreate({ id: "chat" });
      const prepared = await host.prepareTurn({
        session,
        turnId: "invalid-path",
        persistentDirs: [localDir({ harnessDir: "/persistent/test", sourceDir })],
      });
      await expect(prepared.loadPersistentDirs()).rejects.toBeInstanceOf(HarnessPathError);
    }
  });

  it("refuses projectDir with an error that names the unsupported helper", async () => {
    for (const sourceDir of [projectDir("docs"), () => projectDir("docs")]) {
      const host = virtualHost();
      const session = await host.sessions.getOrCreate({ id: "chat" });
      const prepared = await host.prepareTurn({
        session,
        turnId: "project-dir",
        persistentDirs: [localDir({ harnessDir: "/persistent/project", sourceDir })],
      });
      await expect(prepared.loadPersistentDirs()).rejects.toBeInstanceOf(HarnessInputError);
      await expect(prepared.loadPersistentDirs()).rejects.toThrow("projectDir()");
    }
  });

  it("passes the cached data filesystem and absolute roots to one-shot and defined workflows without disk writes", async () => {
    const workingDir = await diskAsync.mkdtemp(join(tmpdir(), "virtual-workflows-"));
    const dataFs = new InMemoryFs();
    const dataFor = vi.fn(async () => dataFs);
    const workspaces = new Map<string, InMemoryFs>();
    const seen: HarnessWorkflowRunContext[] = [];
    const workflow = (id: string): HarnessWorkflow => ({
      id, executionMode: "inline", definitionIdentity: "sha256:port-test",
      inputSchema: { kind: "untyped", allowUntypedInput: true },
      async runForHarness(input, context) {
        seen.push(context);
        expect(context.persistence.fs).toBe(dataFs);
        await context.persistence.fs!.mkdir(context.persistence.dataDir, { recursive: true });
        await context.persistence.fs!.writeFile(`${context.persistence.dataDir}/${context.reservedRunId}.json`, JSON.stringify(input));
        return { protocolVersion: 1, status: "completed", runId: context.reservedRunId, output: input };
      },
    });
    const compile = vi.fn(() => ({
      ok: true, definitionHash: "sha256:port-test", lwir: { steps: [{}] },
      referenced: { tools: [], models: [], bash: false }, workflow: workflow("ad_hoc_plan"),
    }));
    const define = vi.fn(() => ({ ok: true, workflow: workflow("shared.reply") }));
    const calls = [
      { name: "run_ad_hoc_plan", input: {
        purpose: "echo", plan: { steps: [{ id: "echo", uses: "tool.call", tool: "echo", with: {} }], output: { from: "echo" } },
        input: { name: "Ada" }, outputSchema: true,
      } },
      { name: "define_workflow", input: {
        id: "shared.reply", description: "Reply.", inputSchema: { type: "object" }, outputSchema: { type: "object" }, tools: [], runWith: { name: "Ada" },
      } },
      undefined,
      { name: "shared_reply", input: { name: "Bo" } },
    ];
    let callIndex = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        const call = calls[callIndex++];
        return call === undefined
          ? { content: [{ type: "text", text: "done" }], finishReason: { unified: "stop", raw: "stop" }, usage, warnings: [] }
          : { content: [{ type: "tool-call", toolCallId: `call_${callIndex}`, toolName: call.name, input: JSON.stringify(call.input) }],
              finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage, warnings: [] };
      },
    });
    const writes = [
      vi.spyOn(disk, "mkdirSync"),
      vi.spyOn(disk, "writeFileSync"),
      vi.spyOn(diskAsync, "mkdir"),
      vi.spyOn(diskAsync, "writeFile"),
      vi.spyOn(diskAsync, "open"),
    ];
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(workingDir);
    try {
      const host = virtualHost({
        fs: (id) => {
          const fs = new InMemoryFs();
          workspaces.set(id, fs);
          return fs;
        },
        dataFs: dataFor,
      });
      const harness = createHarness({
        host, model,
        dynamicWorkflows: { enabled: true, factory: { compile, define } as never },
      });
      expect((await generateHarness({ harness, session: "writer", prompt: "define and run" })).status).toBe("completed");
      expect((await generateHarness({ harness, session: "reader", prompt: "run the stored workflow" })).status).toBe("completed");
      expect(seen).toHaveLength(3);
      expect(seen[0]!.persistence.dataDir).toBe(`/.little-harness/data/sessions/writer/dynamic-workflows/${seen[0]!.reservedRunId}`);
      expect(seen.slice(1).map(context => context.persistence.dataDir)).toEqual([
        "/.little-harness/data/agent-workflows", "/.little-harness/data/agent-workflows",
      ]);
      for (const context of seen) {
        expect(context.persistence.fs).toBe(dataFs);
        expect(await dataFs.exists(`${context.persistence.dataDir}/${context.reservedRunId}.json`)).toBe(true);
      }
      expect(compile).toHaveBeenCalledTimes(1);
      expect(define).toHaveBeenCalled();
      expect(dataFor.mock.calls).toEqual([["writer"], ["reader"]]);
      expect(workspaces.get("writer")).not.toBe(workspaces.get("reader"));
      expect(await workspaces.get("writer")!.exists(seen[0]!.persistence.dataDir)).toBe(false);
      for (const write of writes) expect(write).not.toHaveBeenCalled();
      expect(await diskAsync.readdir(workingDir)).toEqual([]);
    } finally {
      cwd.mockRestore();
      for (const write of writes) write.mockRestore();
      await diskAsync.rm(workingDir, { recursive: true, force: true });
    }
  });

  it("keeps the session's files to the four roots", async () => {
    const session = await virtualHost().sessions.getOrCreate({ id: "chat" });
    await expect(session.files.writeText("/etc/passwd", "x")).rejects.toBeInstanceOf(HarnessPathError);
    await expect(session.files.writeText("/.agents/skills/x/SKILL.md", "x")).rejects.toBeInstanceOf(HarnessPathError);
    await session.files.writeText("/session/a/b.txt", "deep");
    expect(await session.files.list("/session", { recursive: true })).toEqual([
      { path: "/session/a", kind: "directory" },
      { path: "/session/a/b.txt", kind: "file", bytes: 4 },
    ]);
    expect((await session.files.read("/session/a/b.txt")).text()).toBe("deep");
  });

  it("refuses a sandbox that needs a disk", async () => {
    const host = virtualHost({ sandbox: subprocessSandbox() });
    const session = await host.sessions.getOrCreate({ id: "chat" });
    const prepared = await host.prepareTurn({ session, turnId: "turn_1", persistentDirs: [] });
    await expect(prepared.createSandbox({})).rejects.toBeInstanceOf(HarnessInputError);
  });
});

it.each([
  "printf hidden > /dev/null; cat /dev/null; printf OK",
  "printf hidden >> '/dev/null'; cat < /dev/null; printf OK",
  "cat /missing 2>/dev/null; printf OK",
  "{ printf hidden; cat /missing; } >/dev/null 2>&1; printf OK",
  "printf hidden > /dev/../dev/null; printf OK",
])("virtualHost uses a synthetic null sink/EOF endpoint: %s", async command => {
  const fs = new InMemoryFs(); const host = virtualHost({ fs }); const events: HarnessEvent[] = [];
  expect(await run(host, "null", [command], { events })).toMatchObject({ exitCode: 0, stdout: "OK", stderr: "" });
  expect(fs.getAllPaths().some(path => path.startsWith("/dev/"))).toBe(false);
  expect(events.filter(event => event.type.startsWith("harness.file."))).toEqual([]);
});

it.each([
  "printf no > /dev/nullish", "printf no > /dev/other", "mkdir /dev/new",
  "rm /dev/null", "ln -s /session/target /dev/null", "ln /dev/null /session/alias",
  "printf keep >/session/source; mv /session/source /dev/null",
])("virtualHost keeps other device writes and structural changes forbidden: %s", async command => {
  const host = virtualHost({ fs: new InMemoryFs() });
  expect((await run(host, "null-deny", [command])).exitCode).not.toBe(0);
  expect(await run(host, "null-check", ["cat /dev/null"])).toMatchObject({ exitCode: 0, stdout: "", stderr: "" });
});

it.each([
  ["{ printf OUT; printf ERR >&2; } >/session/all 2>&1; cat /session/all", "OUTERR"],
  ["{ printf OUT; printf ERR >&2; } 2>&1 >/session/out; printf '|'; cat /session/out", "ERR|OUT"],
  ["{ printf OUT; printf ERR >&2; } >/session/all 2>&1 2>/session/err; cat /session/all; printf '|'; cat /session/err", "OUT|ERR"],
  ["printf OUT >/session/first >/session/last; cat /session/first; printf '|'; cat /session/last", "|OUT"],
  ["{ printf OUT; printf ERR >&2; } >/dev/null 2>&1; printf OK", "OK"],
  ["{ printf OUT; printf ERR >&2; } 2>&1 >/dev/null; printf OK", "ERROK"],
])("preserves descriptor destination/order semantics: %s", async (command, stdout) => {
  const host = virtualHost({ fs: new InMemoryFs() });
  expect(await run(host, "fd-order", [command])).toMatchObject({ stdout, stderr: "", exitCode: 0 });
});

it("treats null as a special endpoint and preserves existing-directory mkdir semantics", async () => {
  const host = virtualHost({ fs: new InMemoryFs() });
  expect(await run(host, "null-kind", ["test ! -f /dev/null && test -c /dev/null && test -e /dev/null && printf OK"])).toMatchObject({ exitCode: 0, stdout: "OK" });
  expect((await run(host, "null-mkdir", ["mkdir /dev"])).exitCode).not.toBe(0);
  expect(await run(host, "null-mkdir", ["mkdir -p /dev; printf OK"])).toMatchObject({ exitCode: 0, stdout: "OK" });
});
