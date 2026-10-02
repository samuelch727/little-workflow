import { tool } from "ai";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { localHost, localSessionWorkspace } from "../../local-host/index.js";
import { LocalSessionStore } from "../../local-host/session-store.js";
import { resolveLocalHostPaths } from "../../local-host/paths.js";
import { createJustBashRuntime } from "../../runtime/just-bash-runtime.js";
import { withTempDir } from "../../test/temp.js";
import type { HarnessExecutionEnvironmentFactory, HarnessRuntime } from "../../types.js";
import { subprocessSandbox } from "./subprocess-sandbox.js";

const packageRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");

type SubprocessDiagnostics = { pid: number; envKeys: readonly string[] };
type DiagnosableRuntime = HarnessRuntime & {
  __subprocessDiagnostics(): Promise<SubprocessDiagnostics>;
};

beforeAll(() => {
  // The worker runs as a real child process from dist; build once when it is missing
  // (turbo's test task builds first, so this only triggers for direct vitest runs).
  if (!existsSync(path.join(packageRoot, "dist/sandbox/subprocess/worker.js"))) {
    execSync("pnpm build", { cwd: packageRoot, stdio: "ignore" });
  }
}, 120_000);

describe("subprocessSandbox", () => {
  it("runs shell commands in a separate process against the shared workspace", async () => {
    await withTempDir(async (dir) => {
      const host = localHost({ dataDir: dir, executionEnvironment: subprocessSandbox() });
      const session = await host.sessions.getOrCreate({ id: "subprocess" });
      await session.files.writeText("/session/input.txt", "hello");
      const prepared = await host.prepareTurn({ session, turnId: "turn_1", persistentDirs: [] });
      const runtime = await prepared.createRuntime({});
      const shell = runtime.shellTool() as any;

      const result = await shell.execute(
        { command: "cat /session/input.txt > /artifacts/out.txt && echo copied" },
        {},
      );
      expect(result).toMatchObject({ exitCode: 0, stdout: "copied\n" });
      expect((await session.files.read("/artifacts/out.txt")).text()).toBe("hello");

      // Environment state persists across commands within the same sandbox process.
      await shell.execute({ command: "export MARKER=42" }, {});
      const echoed = await shell.execute({ command: "echo $MARKER" }, {});
      expect(echoed.stdout).toBe("42\n");

      await runtime.dispose?.();
    });
  });

  it("proxies js-exec tool calls back to the parent process tools", async () => {
    await withTempDir(async (dir) => {
      const host = localHost({ dataDir: dir, executionEnvironment: subprocessSandbox() });
      const session = await host.sessions.getOrCreate({ id: "subprocess-tools" });
      const events: any[] = [];
      const prepared = await host.prepareTurn({ session, turnId: "turn_1", persistentDirs: [] });
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
        payload: {
          caller: "runtime",
          toolName: "add",
          args: { type: "harness.runtime_tool.args", value: { a: 3, b: 4 } },
        },
      });
      const succeeded = events.find(
        (event) => event.type === "harness.tool_call.succeeded" && event.payload?.toolName === "add",
      );
      expect(succeeded).toMatchObject({
        payload: { toolName: "add", result: { sum: 7 } },
      });

      await runtime.dispose?.();
    });
  });

  it("is what localHost's \"auto\" mode picks for a turn that can execute code", async () => {
    await withTempDir(async (dir) => {
      const host = localHost({ dataDir: dir, executionEnvironment: "auto" });
      const session = await host.sessions.getOrCreate({ id: "auto-subprocess" });
      const prepared = await host.prepareTurn({ session, turnId: "turn_1", persistentDirs: [] });
      const runtime = (await prepared.createRuntime({})) as DiagnosableRuntime;

      const result = await (runtime.shellTool() as any).execute({ command: "echo auto" }, {});
      expect(result).toMatchObject({ exitCode: 0, stdout: "auto\n" });
      expect((await runtime.__subprocessDiagnostics()).pid).not.toBe(process.pid);

      await runtime.dispose?.();
    });
  }, 20_000);

  it("is skipped by \"auto\" when the turn can neither execute code nor reach the network", async () => {
    await withTempDir(async (dir) => {
      const host = localHost({ dataDir: dir, executionEnvironment: "auto" });
      const session = await host.sessions.getOrCreate({ id: "auto-in-process" });
      const prepared = await host.prepareTurn({ session, turnId: "turn_1", persistentDirs: [] });
      const runtime = await prepared.createRuntime({
        runtime: { python: false, javascript: false },
      });

      const result = await (runtime.shellTool() as any).execute({ command: "echo auto" }, {});
      expect(result).toMatchObject({ exitCode: 0, stdout: "auto\n" });
      // Only the subprocess adapter exposes diagnostics, so its absence proves the runtime
      // stayed in-process.
      expect((runtime as Partial<DiagnosableRuntime>).__subprocessDiagnostics).toBeUndefined();

      await runtime.dispose?.();
    });
  });

  it("attributes proxied tool calls to the shell call that made them under concurrency", async () => {
    await withTempDir(async (dir) => {
      const host = localHost({ dataDir: dir, executionEnvironment: subprocessSandbox() });
      const session = await host.sessions.getOrCreate({ id: "subprocess-scope" });
      const events: any[] = [];
      const prepared = await host.prepareTurn({ session, turnId: "turn_1", persistentDirs: [] });
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

      // The AI SDK executes a step's tool calls concurrently: the second bash call starts
      // before the first finishes, and its toolCallId must not leak into the first call's
      // proxied tool events (worker execs are serialized; attribution follows the exec).
      const [first, second] = await Promise.all([
        shell.execute(
          { command: "js-exec -c 'console.log((await tools.add({a:1,b:2})).sum)'" },
          { toolCallId: "call_A" },
        ),
        shell.execute({ command: "echo b" }, { toolCallId: "call_B" }),
      ]);
      expect(first).toMatchObject({ exitCode: 0 });
      expect(second).toMatchObject({ exitCode: 0, stdout: "b\n" });

      const started = events.find(
        (event) => event.type === "harness.tool_call.started" && event.payload?.toolName === "add",
      );
      expect(started?.payload?.scope).toEqual({ parentToolCallId: "call_A" });

      await runtime.dispose?.();
    });
  });

  it("emits workspace file-change events from the parent process", async () => {
    await withTempDir(async (dir) => {
      const host = localHost({ dataDir: dir, executionEnvironment: subprocessSandbox() });
      const session = await host.sessions.getOrCreate({ id: "subprocess-events" });
      const events: any[] = [];
      const prepared = await host.prepareTurn({ session, turnId: "turn_1", persistentDirs: [] });
      const runtime = await prepared.createRuntime({
        emit: async (event) => {
          events.push(event);
        },
      });
      const shell = runtime.shellTool() as any;

      await shell.execute({ command: "echo out > /artifacts/result.txt" }, {});

      expect(events.map((event) => event.type)).toEqual(
        expect.arrayContaining([
          "harness.runtime.command.started",
          "harness.file.created",
          "harness.artifact.created",
          "harness.runtime.command.succeeded",
        ]),
      );
      const created = events.find((event) => event.type === "harness.file.created");
      expect(created.metadata).toMatchObject({ path: "/artifacts/result.txt", root: "artifacts" });

      await runtime.dispose?.();
    });
  });

  it("emits event traces identical to the in-process runtime", async () => {
    const run = async (factory: HarnessExecutionEnvironmentFactory, dir: string, id: string) => {
      const session = await new LocalSessionStore(resolveLocalHostPaths({ dataDir: dir }, dir))
        .getOrCreate({ id });
      const events: any[] = [];
      const runtime = await factory({
        workspace: localSessionWorkspace(session),
        files: session.files,
        emit: async (event) => {
          events.push(event);
        },
      });
      const shell = runtime.shellTool() as any;
      await shell.execute({ command: "echo hello" }, { toolCallId: "call_1" });
      await shell.execute({ command: "printf data > /session/notes.txt" }, { toolCallId: "call_2" });
      await shell.execute({ command: "printf out > /artifacts/result.txt" }, { toolCallId: "call_3" });
      await shell.execute({ command: "false" }, { toolCallId: "call_4" });
      await runtime.dispose?.();
      return events;
    };
    const normalize = (events: any[]) =>
      JSON.parse(
        JSON.stringify(events, (key, value) => {
          if (key === "durationMs") {
            return 0;
          }
          // Error stacks legitimately differ across adapters (different async frames);
          // parity is about event types, ordering, and payload shape.
          if (key === "stack") {
            return "<stack>";
          }
          return value;
        }),
      );

    await withTempDir(async (inProcessDir) => {
      await withTempDir(async (subprocessDir) => {
        const inProcess = await run(createJustBashRuntime, inProcessDir, "parity");
        const subprocess = await run(subprocessSandbox(), subprocessDir, "parity");
        expect(normalize(subprocess)).toEqual(normalize(inProcess));
      });
    });
  }, 20_000);

  it("enforces read-only Persistent Dir prefixes inside the worker", async () => {
    await withTempDir(async (dir) => {
      const session = await new LocalSessionStore(resolveLocalHostPaths({ dataDir: dir }, dir))
        .getOrCreate({ id: "subprocess-ro" });
      await session.files.writeText("/persistent/knowledge/source.txt", "source");
      session.setReadOnlyPersistentDirs(["/persistent/knowledge/"]);

      const factory = subprocessSandbox();
      const runtime = await factory({
        workspace: localSessionWorkspace(session),
        files: session.files,
      });
      const shell = runtime.shellTool() as any;

      const read = await shell.execute({ command: "cat /persistent/knowledge/source.txt" }, {});
      const write = await shell.execute(
        { command: "echo changed > /persistent/knowledge/source.txt" },
        {},
      );

      expect(read).toMatchObject({ exitCode: 0, stdout: "source" });
      expect(write.exitCode).not.toBe(0);
      expect((await session.files.read("/persistent/knowledge/source.txt")).text()).toBe("source");

      await runtime.dispose?.();
    });
  });

  it("recovers from a worker crash: next command respawns, dispose returns promptly", async () => {
    await withTempDir(async (dir) => {
      const host = localHost({ dataDir: dir, executionEnvironment: subprocessSandbox() });
      const session = await host.sessions.getOrCreate({ id: "subprocess-crash" });
      const prepared = await host.prepareTurn({ session, turnId: "turn_1", persistentDirs: [] });
      const runtime = (await prepared.createRuntime({})) as DiagnosableRuntime;
      const shell = runtime.shellTool() as any;

      const first = await shell.execute({ command: "echo alive" }, {});
      expect(first).toMatchObject({ exitCode: 0, stdout: "alive\n" });

      // Kill exactly this client's worker process out from under it.
      const { pid } = await runtime.__subprocessDiagnostics();
      process.kill(pid, "SIGKILL");
      await new Promise((resolve) => setTimeout(resolve, 200));

      // The next command must not hang on the dead child: a fresh worker is spawned.
      const second = await shell.execute({ command: "echo recovered" }, {});
      expect(second).toMatchObject({ exitCode: 0, stdout: "recovered\n" });

      // Dispose after the (recovered) worker — and never hangs even after crashes.
      const disposed = await Promise.race([
        runtime.dispose?.().then(() => "disposed"),
        new Promise((resolve) => setTimeout(() => resolve("timeout"), 5000)),
      ]);
      expect(disposed).toBe("disposed");
    });
  }, 20_000);

  it("survives a command sent while the worker is dying (no EPIPE crash, promise settles)", async () => {
    await withTempDir(async (dir) => {
      const host = localHost({ dataDir: dir, executionEnvironment: subprocessSandbox() });
      const session = await host.sessions.getOrCreate({ id: "subprocess-epipe" });
      const prepared = await host.prepareTurn({ session, turnId: "turn_1", persistentDirs: [] });
      const runtime = (await prepared.createRuntime({})) as DiagnosableRuntime;
      const shell = runtime.shellTool() as any;

      await shell.execute({ command: "echo alive" }, {});
      const { pid } = await runtime.__subprocessDiagnostics();
      process.kill(pid, "SIGKILL");
      // No settling delay: this write races the worker's death. It must neither crash the
      // host process (unhandled EPIPE) nor hang; either failure or respawned success is fine.
      const raced = await shell.execute({ command: "echo raced" }, {});
      expect(typeof raced.exitCode).toBe("number");

      const after = await shell.execute({ command: "echo after" }, {});
      expect(after).toMatchObject({ exitCode: 0, stdout: "after\n" });

      await runtime.dispose?.();
    });
  }, 20_000);

  it("never delivers a dead worker's tool result to its successor", async () => {
    await withTempDir(async (dir) => {
      const host = localHost({ dataDir: dir, executionEnvironment: subprocessSandbox() });
      const session = await host.sessions.getOrCreate({ id: "subprocess-stale-tool" });
      const gates: Array<(value: unknown) => void> = [];
      let toolCalls = 0;
      const prepared = await host.prepareTurn({ session, turnId: "turn_1", persistentDirs: [] });
      const runtime = (await prepared.createRuntime({
        tools: {
          gate: tool({
            description: "Resolves when the test releases it.",
            inputSchema: z.object({}),
            execute: () =>
              new Promise((resolve) => {
                toolCalls += 1;
                gates.push(resolve);
              }),
          }),
        },
      })) as DiagnosableRuntime;
      const shell = runtime.shellTool() as any;
      // Generous budget: after the SIGKILL below, satisfying `toolCalls === 2` requires a full
      // worker respawn + js-exec startup + a proxied tool call, which can exceed 5s on loaded
      // CI runners (the sibling respawn test alone takes ~7s there). Deadline-based, not
      // iteration-based, so slow event-loop turns don't silently shrink the budget.
      const waitFor = async (condition: () => boolean) => {
        const deadline = Date.now() + 15_000;
        while (!condition() && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        expect(condition()).toBe(true);
      };

      // Exec A blocks inside a proxied tool call, then its worker dies.
      const { pid } = await runtime.__subprocessDiagnostics();
      const execA = shell.execute(
        { command: "js-exec -c 'console.log(JSON.stringify(await tools.gate({})))'" },
        { toolCallId: "call_A" },
      );
      await waitFor(() => toolCalls === 1);
      process.kill(pid, "SIGKILL");
      await expect(execA).resolves.toMatchObject({ exitCode: 1 });

      // Exec B's first tool call in the fresh worker reuses id 1. Releasing A's stale
      // invocation now must NOT satisfy B's pending call with A's payload.
      const execB = shell.execute(
        { command: "js-exec -c 'console.log(JSON.stringify(await tools.gate({})))'" },
        { toolCallId: "call_B" },
      );
      await waitFor(() => toolCalls === 2);
      gates[0]!({ from: "A" });
      await new Promise((resolve) => setTimeout(resolve, 200));
      gates[1]!({ from: "B" });

      const resultB = await execB;
      expect(resultB.stdout).toContain('{"from":"B"}');
      expect(resultB.stdout).not.toContain('{"from":"A"}');

      await runtime.dispose?.();
    });
  }, 20_000);

  it("respawns after a worker-reported fatal error instead of staying wedged", async () => {
    await withTempDir(async (dir) => {
      const stubPath = path.join(dir, "fatal-once-worker.cjs");
      const flagPath = path.join(dir, "fatal-once.flag");
      await writeFile(
        stubPath,
        `
const fs = require("node:fs");
const readline = require("node:readline");
const flag = process.env.LH_TEST_FATAL_FLAG;
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.type === "init") {
    if (flag && !fs.existsSync(flag)) {
      fs.writeFileSync(flag, "1");
      process.stdout.write(JSON.stringify({ type: "fatal", message: "init boom" }) + "\\n");
      return;
    }
    process.stdout.write(JSON.stringify({ type: "ready", id: message.id }) + "\\n");
    return;
  }
  if (message.type === "exec") {
    process.stdout.write(JSON.stringify({ type: "exec_result", id: message.id, stdout: "stub\\n", stderr: "", exitCode: 0 }) + "\\n");
  }
});
`,
      );
      const session = await new LocalSessionStore(resolveLocalHostPaths({ dataDir: dir }, dir))
        .getOrCreate({ id: "subprocess-fatal" });
      const factory = subprocessSandbox({
        workerPath: stubPath,
        env: { LH_TEST_FATAL_FLAG: flagPath },
      });
      const runtime = await factory({
        workspace: localSessionWorkspace(session),
        files: session.files,
      });
      const shell = runtime.shellTool() as any;

      const first = await shell.execute({ command: "echo hi" }, {});
      expect(first.exitCode).not.toBe(0);
      expect(first.stderr).toContain("init boom");

      // A fatal worker must be retired: the next command spawns a fresh one.
      const second = await shell.execute({ command: "echo hi" }, {});
      expect(second).toMatchObject({ exitCode: 0, stdout: "stub\n" });

      await runtime.dispose?.();
    });
  }, 20_000);

  it("fails commands instead of hanging when the worker never initializes", async () => {
    await withTempDir(async (dir) => {
      const stubPath = path.join(dir, "silent-worker.cjs");
      // Consumes stdin and never acknowledges init — a worker wedged before ready.
      await writeFile(stubPath, "process.stdin.resume();\n");
      const session = await new LocalSessionStore(resolveLocalHostPaths({ dataDir: dir }, dir))
        .getOrCreate({ id: "subprocess-init-hang" });
      const factory = subprocessSandbox({ workerPath: stubPath, initTimeoutMs: 300 });
      const runtime = await factory({
        workspace: localSessionWorkspace(session),
        files: session.files,
      });
      const shell = runtime.shellTool() as any;

      const first = await shell.execute({ command: "echo hi" }, {});
      expect(first.exitCode).not.toBe(0);
      expect(first.stderr).toContain("did not initialize");

      // The dead worker was retired: the next command respawns (and fails the same way)
      // instead of waiting on a stale ready promise.
      const second = await shell.execute({ command: "echo hi" }, {});
      expect(second.exitCode).not.toBe(0);
      expect(second.stderr).toContain("did not initialize");

      await runtime.dispose?.();
    });
  }, 20_000);

  it("enforces timeoutMs from the parent when the worker cannot answer at all", async () => {
    await withTempDir(async (dir) => {
      const stubPath = path.join(dir, "unresponsive-worker.cjs");
      await writeFile(
        stubPath,
        `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.type === "init") {
    process.stdout.write(JSON.stringify({ type: "ready", id: message.id }) + "\\n");
  }
  // exec messages are deliberately never answered — a wedged worker.
});
`,
      );
      const session = await new LocalSessionStore(resolveLocalHostPaths({ dataDir: dir }, dir))
        .getOrCreate({ id: "subprocess-watchdog" });
      const factory = subprocessSandbox({ workerPath: stubPath, watchdogGraceMs: 200 });
      const runtime = (await factory({
        workspace: localSessionWorkspace(session),
        files: session.files,
      })) as DiagnosableRuntime;
      const shell = runtime.shellTool() as any;

      // The stub also never answers diag: the watchdog must settle this too, not just its exec.
      const diagOutcome = runtime.__subprocessDiagnostics().catch((error: unknown) => error);
      const result = await shell.execute({ command: "echo hi", timeoutMs: 100 }, {});
      expect(result.exitCode).toBe(124);
      expect(result.stderr).toContain("unresponsive");
      expect(await diagOutcome).toBeInstanceOf(Error);

      await runtime.dispose?.();
    });
  }, 20_000);

  // Variables the operating system injects into every spawned process, independent of the
  // `env` passed to spawn. Keep this list minimal — an entry here is an assertion that the
  // platform, not our code, put the variable there.
  const OS_INJECTED_ENV_KEYS = new Set(["__CF_USER_TEXT_ENCODING"]);

  it("spawns the worker with a stripped environment so parent secrets never reach the sandbox", async () => {
    await withTempDir(async (dir) => {
      process.env.LH_TEST_PARENT_SECRET = "super-secret";
      try {
        const session = await new LocalSessionStore(resolveLocalHostPaths({ dataDir: dir }, dir))
          .getOrCreate({ id: "subprocess-env" });
        // The real factory with its real defaults — not a re-creation of its spawn call.
        const factory = subprocessSandbox();
        const runtime = (await factory({
          workspace: localSessionWorkspace(session),
          files: session.files,
        })) as DiagnosableRuntime;

        const diag = await runtime.__subprocessDiagnostics();
        expect(diag.pid).not.toBe(process.pid);
        expect(diag.envKeys).not.toContain("LH_TEST_PARENT_SECRET");
        // The sandbox spawns with `env: {}`, but the OS injects a few variables into every
        // child regardless of spawn options — macOS launchd adds __CF_USER_TEXT_ENCODING.
        // Those are not inherited from our environment and cannot be suppressed, so the
        // property under test is "nothing but OS injections", not "literally empty".
        expect(diag.envKeys.filter((key) => !OS_INJECTED_ENV_KEYS.has(key))).toEqual([]);

        await runtime.dispose?.();
      } finally {
        delete process.env.LH_TEST_PARENT_SECRET;
      }
    });
  });
});
