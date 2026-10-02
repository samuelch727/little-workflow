import { tool } from "ai";
import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import * as fsp from "node:fs/promises";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { localHost, localSessionWorkspace } from "../local-host/index.js";
import { resolveLocalHostPaths } from "../local-host/paths.js";
import { LocalSessionStore } from "../local-host/session-store.js";
import { subprocessSandbox } from "../sandbox/subprocess/subprocess-sandbox.js";
import { withTempDir } from "../test/temp.js";
import type {
  CreateExecutionEnvironmentOptions,
  HarnessEventInput,
  HarnessExecutionEnvironmentFactory,
  HarnessRuntime,
} from "../types.js";
import { createJustBashRuntime } from "./just-bash-runtime.js";
import { createShellRuntime, type ShellCommandResult } from "./shell-runtime.js";
import {
  tieredExecutionEnvironment,
  TIER_CARRY_OVER_TOOL_CALL_ID,
  TIER_REFUSED_EXIT_CODE,
  TIER_STATE_PROBE_TOOL_CALL_ID,
} from "./tiered-runtime.js";

const packageRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");

type TierCall = { command: string; toolCallId: string };

type FakeTier = {
  readonly factory: HarnessExecutionEnvironmentFactory;
  readonly calls: TierCall[];
  /** Commands the model asked for, without the tier's own probe/carry-over bookkeeping. */
  modelCommands(): string[];
  carryOverCommand(): string | undefined;
  created(): number;
  disposed(): number;
};

/** A tier backed by its own just-bash instance: real shell state, recorded commands. */
function justBashTier(): FakeTier {
  const calls: TierCall[] = [];
  let created = 0;
  let disposed = 0;
  const factory: HarnessExecutionEnvironmentFactory = async (options) => {
    created += 1;
    const runtime = await createJustBashRuntime(options);
    const shell = runtime.shellTool() as { execute: (input: any, options: any) => Promise<any> };
    const inner = shell.execute.bind(shell);
    return {
      systemHints: (hintOptions) => runtime.systemHints(hintOptions),
      shellTool: () =>
        ({
          ...shell,
          execute: async (input: any, executeOptions: any) => {
            calls.push({ command: input.command, toolCallId: executeOptions?.toolCallId ?? "" });
            return inner(input, executeOptions);
          },
        }) as never,
      dispose: async () => {
        disposed += 1;
        await runtime.dispose?.();
      },
    };
  };
  return { factory, calls, ...tierViews(calls), created: () => created, disposed: () => disposed };
}

/**
 * A tier with scripted answers, for asserting what the switch routes where. Carry-over and
 * probe execs always succeed, as they would on any tier with a working `cd`/`export`.
 */
function scriptedTier(respond: (command: string) => ShellCommandResult): FakeTier {
  const calls: TierCall[] = [];
  const bookkeeping = new Set([TIER_CARRY_OVER_TOOL_CALL_ID, TIER_STATE_PROBE_TOOL_CALL_ID]);
  let created = 0;
  let disposed = 0;
  const factory: HarnessExecutionEnvironmentFactory = async (options) => {
    created += 1;
    return createShellRuntime({
      workspace: options.workspace,
      files: options.files,
      execute: async (input, context) => {
        calls.push({ command: input.command, toolCallId: context.toolCallId });
        return bookkeeping.has(context.toolCallId) ? OK : respond(input.command);
      },
      dispose: async () => {
        disposed += 1;
      },
    });
  };
  return { factory, calls, ...tierViews(calls), created: () => created, disposed: () => disposed };
}

function tierViews(calls: readonly TierCall[]): Pick<FakeTier, "modelCommands" | "carryOverCommand"> {
  const bookkeeping = new Set([TIER_CARRY_OVER_TOOL_CALL_ID, TIER_STATE_PROBE_TOOL_CALL_ID]);
  return {
    modelCommands: () => calls.filter((call) => !bookkeeping.has(call.toolCallId)).map((call) => call.command),
    carryOverCommand: () =>
      calls.find((call) => call.toolCallId === TIER_CARRY_OVER_TOOL_CALL_ID)?.command,
  };
}

const OK: ShellCommandResult = { stdout: "", stderr: "", exitCode: 0 };

async function sessionFor(dir: string, id = "chat") {
  return new LocalSessionStore(resolveLocalHostPaths({ dataDir: dir }, dir)).getOrCreate({ id });
}

let callCounter = 0;

async function run(runtime: HarnessRuntime, command: string): Promise<ShellCommandResult> {
  callCounter += 1;
  const shell = runtime.shellTool() as { execute: (input: any, options: any) => Promise<ShellCommandResult> };
  return shell.execute({ command }, { toolCallId: `call_${callCounter}`, messages: [] });
}

beforeAll(() => {
  if (!existsSync(path.join(packageRoot, "dist/sandbox/subprocess/worker.js"))) {
    execSync("pnpm build", { cwd: packageRoot, stdio: "ignore" });
  }
}, 120_000);

describe("tieredExecutionEnvironment", () => {
  it("escalates before running an unsupported command, then keeps the turn on the higher tier", async () => {
    await withTempDir(async (dir) => {
      const session = await sessionFor(dir);
      const next = justBashTier();
      const runtime = await tieredExecutionEnvironment({ nextTier: next.factory })({
        workspace: localSessionWorkspace(session),
        files: session.files,
      });

      const first = await run(runtime, "echo one");
      const escalated = await run(runtime, "cargo build");
      const sticky = await run(runtime, "echo two");

      expect(next.created()).toBe(1);
      expect(first).toMatchObject({ stdout: "one\n", exitCode: 0 });
      // `cargo` is missing on the fake higher tier too — routing is what is asserted here.
      expect(escalated.stderr).toBe("bash: cargo: command not found\n");
      expect(sticky).toMatchObject({ stdout: "two\n", exitCode: 0 });
      expect(next.modelCommands()).toEqual(["cargo build", "echo two"]);
      await runtime.dispose?.();
    });
  });

  it("retries the same command once on the higher tier when Tier-0 reports an emulation gap", async () => {
    await withTempDir(async (dir) => {
      const session = await sessionFor(dir);
      await session.files.writeText("/session/build.sh", "cargo build\n");
      const next = scriptedTier((command) =>
        command === "sh /session/build.sh" ? { stdout: "built\n", stderr: "", exitCode: 0 } : OK,
      );
      const events: HarnessEventInput[] = [];
      const runtime = await tieredExecutionEnvironment({ nextTier: next.factory })({
        workspace: localSessionWorkspace(session),
        files: session.files,
        emit: async (event) => {
          events.push(event);
        },
      });

      // Classification clears this: `sh <script>` is well-formed and the script's contents
      // are invisible to it. The gap only shows up in Tier-0's stderr.
      const result = await run(runtime, "sh /session/build.sh");

      expect(result).toMatchObject({ stdout: "built\n", exitCode: 0 });
      expect(next.modelCommands()).toEqual(["sh /session/build.sh"]);
      expect(events.filter((event) => event.type === "harness.runtime.tier.escalated")).toMatchObject([
        {
          metadata: {
            trigger: "emulation-gap",
            command: "sh /session/build.sh",
            gap: { signal: "command-not-found", command: "cargo" },
          },
        },
      ]);
      await runtime.dispose?.();
    });
  });

  it("bounds emulation-gap escalation to one retry per command", async () => {
    await withTempDir(async (dir) => {
      const session = await sessionFor(dir);
      // The higher tier answers with a gap line of its own: a script-writable signal must
      // not be able to bounce a command between tiers.
      const next = scriptedTier(() => ({
        stdout: "",
        stderr: "bash: cargo: command not found\n",
        exitCode: 127,
      }));
      const events: HarnessEventInput[] = [];
      const runtime = await tieredExecutionEnvironment({ nextTier: next.factory })({
        workspace: localSessionWorkspace(session),
        files: session.files,
        emit: async (event) => {
          events.push(event);
        },
      });

      const forged = "echo 'bash: cargo: command not found' >&2";
      const first = await run(runtime, forged);
      const second = await run(runtime, forged);

      expect(first.exitCode).toBe(127);
      expect(second.exitCode).toBe(127);
      expect(next.modelCommands()).toEqual([forged, forged]);
      expect(events.filter((event) => event.type === "harness.runtime.tier.escalated")).toHaveLength(1);
      await runtime.dispose?.();
    });
  });

  it("degrades to a structured failure — running nothing — when escalation is unavailable", async () => {
    await withTempDir(async (dir) => {
      const session = await sessionFor(dir);
      const events: HarnessEventInput[] = [];
      const runtime = await tieredExecutionEnvironment({})({
        workspace: localSessionWorkspace(session),
        files: session.files,
        emit: async (event) => {
          events.push(event);
        },
      });

      const refused = await run(runtime, "mkdir -p /session/half-done && cargo build");
      const afterwards = await run(runtime, "ls /session");

      expect(refused.exitCode).toBe(TIER_REFUSED_EXIT_CODE);
      expect(refused.stderr).toContain("cargo needs a real execution environment (build-toolchain)");
      expect(refused.stderr).toContain("no higher execution tier is configured");
      // Classifying first is what makes this safe: the destructive prefix never ran.
      expect(afterwards.stdout).not.toContain("half-done");
      expect(afterwards.exitCode).toBe(0);
      expect(events.filter((event) => event.type === "harness.runtime.tier.unavailable")).toMatchObject([
        { metadata: { trigger: "classification", detail: "no higher execution tier is configured" } },
      ]);
      await runtime.dispose?.();
    });
  });

  it("stops re-provisioning a higher tier that failed once", async () => {
    await withTempDir(async (dir) => {
      const session = await sessionFor(dir);
      let attempts = 0;
      const runtime = await tieredExecutionEnvironment({
        nextTier: async () => {
          attempts += 1;
          throw new Error("no capacity");
        },
      })({ workspace: localSessionWorkspace(session), files: session.files });

      const first = await run(runtime, "cargo build");
      const second = await run(runtime, "docker ps");

      expect(attempts).toBe(1);
      expect(first.exitCode).toBe(TIER_REFUSED_EXIT_CODE);
      expect(first.stderr).toContain("no capacity");
      expect(second.exitCode).toBe(TIER_REFUSED_EXIT_CODE);
      await runtime.dispose?.();
    });
  });

  it("provisions the higher tier once when two commands escalate concurrently", async () => {
    await withTempDir(async (dir) => {
      const session = await sessionFor(dir);
      const next = justBashTier();
      const events: HarnessEventInput[] = [];
      let release = () => {};
      const provisioning = new Promise<void>((resolve) => {
        release = resolve;
      });
      const runtime = await tieredExecutionEnvironment({
        nextTier: async (environmentOptions) => {
          await provisioning;
          return next.factory(environmentOptions);
        },
      })({
        workspace: localSessionWorkspace(session),
        files: session.files,
        emit: async (event) => {
          events.push(event);
        },
      });

      // A step's bash calls run concurrently; both of these decide to escalate while the
      // first provisioning attempt is still in flight, which the gate makes deterministic.
      const commands = Promise.all([run(runtime, "cargo build"), run(runtime, "docker ps")]);
      await new Promise((resolve) => setTimeout(resolve, 25));
      release();
      await commands;

      expect(next.created()).toBe(1);
      expect(next.modelCommands().sort()).toEqual(["cargo build", "docker ps"]);
      expect(events.filter((event) => event.type === "harness.runtime.tier.escalated")).toHaveLength(1);
      await runtime.dispose?.();
      expect(next.disposed()).toBe(1);
    });
  });

  it("returns the Tier-0 result unchanged when a gap is found and escalation is unavailable", async () => {
    await withTempDir(async (dir) => {
      const session = await sessionFor(dir);
      await session.files.writeText("/session/build.sh", "cargo build\n");
      const events: HarnessEventInput[] = [];
      const runtime = await tieredExecutionEnvironment({})({
        workspace: localSessionWorkspace(session),
        files: session.files,
        emit: async (event) => {
          events.push(event);
        },
      });

      const result = await run(runtime, "sh /session/build.sh");

      // The command already ran; its real result beats a synthesized one.
      expect(result).toEqual({ stdout: "", stderr: "bash: cargo: command not found\n", exitCode: 127 });
      expect(events.filter((event) => event.type === "harness.runtime.tier.unavailable")).toMatchObject([
        { metadata: { trigger: "emulation-gap" } },
      ]);
      await runtime.dispose?.();
    });
  });

  it("carries exported variables and the working directory across the switch, and nothing else", async () => {
    await withTempDir(async (dir) => {
      const session = await sessionFor(dir);
      const next = justBashTier();
      const runtime = await tieredExecutionEnvironment({ nextTier: next.factory })({
        workspace: localSessionWorkspace(session),
        files: session.files,
      });

      await run(runtime, "mkdir -p /session/work");
      await run(runtime, "export GREETING='hello world'; export TRICKY='a \"b\" $c'; LOCAL=hidden; cd /session/work");
      await run(runtime, "cargo build");
      const carried = await run(runtime, 'pwd; echo "$GREETING"; echo "$TRICKY"; echo "[$LOCAL]"');

      // The higher tier is a fresh shell created at escalation time: the only way it knows
      // any of this is the replay.
      expect(carried.stdout).toBe('/session/work\nhello world\na "b" $c\n[]\n');
      const carryOver = next.carryOverCommand() ?? "";
      expect(carryOver).toContain("cd '/session/work'");
      expect(carryOver).toContain("export GREETING='hello world'");
      // Tier-0's own idea of the machine must not be pushed onto a real one.
      expect(carryOver).not.toContain("export PATH=");
      expect(carryOver).not.toContain("export HOME=");
      await runtime.dispose?.();
    });
  });

  it("refuses policy-denied commands on every tier without running them anywhere", async () => {
    await withTempDir(async (dir) => {
      const session = await sessionFor(dir);
      const next = justBashTier();
      const events: HarnessEventInput[] = [];
      const runtime = await tieredExecutionEnvironment({
        nextTier: next.factory,
        policy: { denyCommands: ["docker"], rule: "denyCommands" },
      })({
        workspace: localSessionWorkspace(session),
        files: session.files,
        emit: async (event) => {
          events.push(event);
        },
      });

      const denied = await run(runtime, "docker ps");
      await run(runtime, "cargo build");
      const deniedAfterEscalation = await run(runtime, "docker ps");

      expect(denied.exitCode).toBe(TIER_REFUSED_EXIT_CODE);
      expect(denied.stderr).toContain("docker is denied by denyCommands");
      expect(deniedAfterEscalation.exitCode).toBe(TIER_REFUSED_EXIT_CODE);
      expect(next.modelCommands()).toEqual(["cargo build"]);
      expect(events.filter((event) => event.type === "harness.runtime.command.denied")).toHaveLength(2);
      await runtime.dispose?.();
    });
  });

  it("keeps the prompt-visible surface byte-identical to a pure Tier-0 turn", async () => {
    await withTempDir(async (dir) => {
      const session = await sessionFor(dir);
      const environmentOptions: CreateExecutionEnvironmentOptions = {
        workspace: localSessionWorkspace(session),
        files: session.files,
        tools: {
          lookup: tool({
            description: "Look up a value.",
            inputSchema: z.object({ id: z.string() }),
            execute: async ({ id }) => ({ id }),
          }),
        },
        toolContext: { session, files: session.files, artifacts: session.artifacts } as never,
      };
      const scripts = ["echo one", "cargo build", "echo two"];

      const tier0Only = await createJustBashRuntime(environmentOptions);
      const tier0Results = [];
      for (const script of scripts) {
        tier0Results.push(await run(tier0Only, script));
      }

      const next = justBashTier();
      const mixed = await tieredExecutionEnvironment({ nextTier: next.factory })(environmentOptions);
      const mixedResults = [];
      for (const script of scripts) {
        mixedResults.push(await run(mixed, script));
      }

      expect(next.modelCommands()).toEqual(["cargo build", "echo two"]);
      // Same hints, same tool contract, same bytes back — the switch is not observable
      // anywhere the model can read, which is what keeps promptHash replay valid.
      expect(mixed.systemHints()).toEqual(tier0Only.systemHints());
      expect(mixed.systemHints({ activeTools: ["bash"] })).toEqual(
        tier0Only.systemHints({ activeTools: ["bash"] }),
      );
      expect(mixed.systemHints().join("\n")).toContain("tools.lookup(args)");
      expect(mixed.systemHints().join("\n")).not.toContain("tier");
      expect(mixed.shellTool().description).toBe(tier0Only.shellTool().description);
      expect(Object.keys((mixed.shellTool().inputSchema as any).shape)).toEqual(
        Object.keys((tier0Only.shellTool().inputSchema as any).shape),
      );
      expect(mixedResults).toEqual(tier0Results);
      await mixed.dispose?.();
      await tier0Only.dispose?.();
    });
  });

  it("traces one command per model call and reports the switch out of band", async () => {
    await withTempDir(async (dir) => {
      const session = await sessionFor(dir);
      const next = justBashTier();
      const events: HarnessEventInput[] = [];
      const runtime = await tieredExecutionEnvironment({ nextTier: next.factory })({
        workspace: localSessionWorkspace(session),
        files: session.files,
        emit: async (event) => {
          events.push(event);
        },
      });

      await run(runtime, "echo one > /session/one.txt");
      await run(runtime, "cargo build");
      await run(runtime, "echo two > /session/two.txt");

      const commandEvents = events.filter((event) => event.type.startsWith("harness.runtime.command."));
      expect(commandEvents.map((event) => event.type)).toEqual([
        "harness.runtime.command.started",
        "harness.runtime.command.succeeded",
        "harness.runtime.command.started",
        "harness.runtime.command.failed",
        "harness.runtime.command.started",
        "harness.runtime.command.succeeded",
      ]);
      // Neither the higher tier's copy of the command nor the switch's own bookkeeping
      // execs may reach the trace as commands.
      expect(commandEvents.map((event) => event.metadata?.["command"])).toEqual([
        "echo one > /session/one.txt",
        "echo one > /session/one.txt",
        "cargo build",
        "cargo build",
        "echo two > /session/two.txt",
        "echo two > /session/two.txt",
      ]);
      expect(JSON.stringify(events)).not.toContain("export -p");
      // File tracking belongs to the wrapper, so a write made on the higher tier is
      // reported exactly once, like any other.
      expect(
        events
          .filter((event) => event.type === "harness.file.created")
          .map((event) => event.metadata?.["path"]),
      ).toEqual(["/session/one.txt", "/session/two.txt"]);
      // The switch is reported inside the command that caused it, which is the ordering
      // later telemetry joins on.
      const indexOf = (type: string) =>
        events.findIndex((event) => event.type === type && event.metadata?.["command"] === "cargo build");
      const escalatedAt = indexOf("harness.runtime.tier.escalated");
      expect(escalatedAt).toBeGreaterThan(indexOf("harness.runtime.command.started"));
      expect(escalatedAt).toBeLessThan(indexOf("harness.runtime.command.failed"));
      expect(events[escalatedAt]?.metadata).toMatchObject({
        from: "tier-0",
        to: "next-tier",
        trigger: "classification",
        decision: "escalate",
        command: "cargo build",
        reasons: [{ kind: "needs-real-exec", command: "cargo", reason: "build-toolchain" }],
      });
      await runtime.dispose?.();
    });
  });

  it("reads Tier-0 state and failure strings through the subprocess adapter too", async () => {
    await withTempDir(async (dir) => {
      const session = await sessionFor(dir, "subprocess-tier");
      await session.files.writeText("/session/build.sh", "cargo build\n");
      const environmentOptions: CreateExecutionEnvironmentOptions = {
        workspace: localSessionWorkspace(session),
        files: session.files,
      };

      // The detector matches just-bash's exact strings; the worker relays stderr over a
      // JSON protocol, so byte-equality with the in-process adapter is what makes the
      // detector valid for both.
      const inProcess = await createJustBashRuntime(environmentOptions);
      const subprocess = await subprocessSandbox()(environmentOptions);
      const inProcessGap = await run(inProcess, "sh /session/build.sh");
      const subprocessGap = await run(subprocess, "sh /session/build.sh");
      expect(subprocessGap.stderr).toBe(inProcessGap.stderr);
      await inProcess.dispose?.();
      await subprocess.dispose?.();

      const next = scriptedTier(() => ({ stdout: "built\n", stderr: "", exitCode: 0 }));
      const runtime = await tieredExecutionEnvironment({
        tier0: subprocessSandbox(),
        nextTier: next.factory,
      })(environmentOptions);

      await run(runtime, "export MARKER=carried; cd /session");
      const retried = await run(runtime, "sh /session/build.sh");

      expect(retried).toMatchObject({ stdout: "built\n", exitCode: 0 });
      expect(next.modelCommands()).toEqual(["sh /session/build.sh"]);
      expect(next.carryOverCommand()).toContain("export MARKER='carried'");
      await runtime.dispose?.();
    });
  }, 30_000);

  it("disposes both tiers when the turn ends", async () => {
    await withTempDir(async (dir) => {
      const session = await sessionFor(dir);
      const tier0 = scriptedTier(() => OK);
      const next = scriptedTier(() => OK);
      const runtime = await tieredExecutionEnvironment({
        tier0: tier0.factory,
        nextTier: next.factory,
      })({ workspace: localSessionWorkspace(session), files: session.files });

      await run(runtime, "cargo build");
      await runtime.dispose?.();

      expect(tier0.disposed()).toBe(1);
      expect(next.disposed()).toBe(1);
    });
  });

  it("serves js-exec tool calls from the higher tier with the same trace", async () => {
    await withTempDir(async (dir) => {
      const next = justBashTier();
      const host = localHost({
        dataDir: dir,
        executionEnvironment: tieredExecutionEnvironment({ nextTier: next.factory }),
      });
      const session = await host.sessions.getOrCreate({ id: "tiered-tools" });
      const events: HarnessEventInput[] = [];
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

      await run(runtime, "cargo build");
      const sum = await run(runtime, "js-exec -c 'console.log((await tools.add({a:2,b:3})).sum)'");

      expect(sum).toMatchObject({ stdout: "5\n", exitCode: 0 });
      expect(
        events.filter((event) => event.metadata?.["toolName"] === "add").map((event) => event.type),
      ).toEqual(["harness.tool_call.started", "harness.tool_call.succeeded"]);
      await runtime.dispose?.();
    });
  });
});

// --- LIT-58: a higher tier that writes at dispose ---
//
// A Tier-1 sandbox syncs its workspace back to the host when the turn ends. That write
// lands after the last command, so only the disposal bracket can see it — and only this
// layer still knows which mounts the host asked to track, because `subordinateTierOptions`
// strips `trackChanges` before any sub-tier sees the workspace.

describe("tiered execution: disposal-time workspace writes", () => {
  const roots: string[] = [];

  afterEach(async () => {
    for (const root of roots.splice(0)) {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  async function trackedRoot(): Promise<string> {
    const root = await fsp.mkdtemp(nodePath.join(nodeOs.tmpdir(), "lh-tier-dispose-"));
    roots.push(root);
    return root;
  }

  it("emits harness.file.* for what the higher tier wrote while disposing", async () => {
    const root = await trackedRoot();
    await fsp.writeFile(nodePath.join(root, "before.txt"), "tier 0 wrote this");
    const events: HarnessEventInput[] = [];
    let sawTrackChanges: boolean | undefined;

    const runtime = await tieredExecutionEnvironment({
      nextTier: async (inner) => {
        // What a sub-tier is handed: the same mounts, without the tracking flag.
        sawTrackChanges = (inner.workspace.mounts[0] as { trackChanges?: boolean })
          .trackChanges;
        return createShellRuntime({
          workspace: inner.workspace,
          files: inner.files,
          execute: async () => OK,
          dispose: async () => {
            await fsp.writeFile(nodePath.join(root, "synced.txt"), "tier 1 wrote this");
            await fsp.rm(nodePath.join(root, "before.txt"));
          },
        });
      },
    })({
      workspace: {
        sessionId: "tier-dispose",
        workingDir: "/session",
        mounts: [
          { mountPath: "/session", backingPath: root, mode: "rw", trackChanges: true },
        ],
      },
      files: {} as never,
      emit: async (event) => {
        events.push(event);
      },
    });

    const shell = runtime.shellTool() as {
      execute(input: unknown, context: unknown): Promise<{ exitCode: number }>;
    };
    // `git` needs real exec, so this escalates and provisions the higher tier.
    await shell.execute({ command: "git --version" }, { toolCallId: "c1", messages: [] });
    expect(sawTrackChanges).toBeUndefined();

    const beforeDispose = events.filter(({ type }) => type.startsWith("harness.file."));
    expect(beforeDispose).toEqual([]);

    await runtime.dispose?.();

    const paths = (type: string) =>
      events
        .filter((event) => event.type === type)
        .map((event) => event.metadata?.path as string | undefined);
    expect(paths("harness.file.created")).toEqual(["/session/synced.txt"]);
    expect(paths("harness.file.deleted")).toEqual(["/session/before.txt"]);
  });

  it("does not read the workspace at all when the turn never escalated",
    async () => {
      const root = await trackedRoot();
      // A file only a snapshot would touch: if the bracket ran, this is read.
      await fsp.writeFile(nodePath.join(root, "big.txt"), "x".repeat(1024));
      const events: HarnessEventInput[] = [];
      let nextTierBuilt = false;
      const runtime = await tieredExecutionEnvironment({
        nextTier: async () => {
          nextTierBuilt = true;
          throw new Error("never provisioned");
        },
      })({
        workspace: {
          sessionId: "tier-dispose-skip",
          workingDir: "/session",
          mounts: [
            { mountPath: "/session", backingPath: root, mode: "rw", trackChanges: true },
          ],
        },
        files: {} as never,
        emit: async (event) => {
          events.push(event);
        },
      });
      // Something a Tier-0 emulator can run: no escalation, no higher tier.
      await run(runtime, "echo hello");
      // A write nobody escalated for is Tier-0's own, already reported per
      // command; the disposal bracket must not re-report it.
      await fsp.writeFile(nodePath.join(root, "after.txt"), "written late");
      await runtime.dispose?.();
      expect(nextTierBuilt).toBe(false);
      expect(events.filter(({ type }) => type.startsWith("harness.file."))).toEqual([]);
    });

  it("still disposes the higher tier when the pre-dispose snapshot cannot read the workspace",
    async () => {
      const root = await trackedRoot();
      let nextDisposed = false;
      const runtime = await tieredExecutionEnvironment({
        nextTier: async (inner) => createShellRuntime({
          workspace: inner.workspace,
          files: inner.files,
          execute: async () => OK,
          dispose: async () => {
            nextDisposed = true;
          },
        }),
      })({
        workspace: {
          sessionId: "tier-dispose-unreadable",
          workingDir: "/session",
          mounts: [
            { mountPath: "/session", backingPath: root, mode: "rw", trackChanges: true },
          ],
        },
        files: {} as never,
        emit: async () => {},
      });
      const shell = runtime.shellTool() as {
        execute(input: unknown, context: unknown): Promise<{ exitCode: number }>;
      };
      await shell.execute({ command: "git --version" }, { toolCallId: "c1", messages: [] });

      // The tracked mount is no longer a directory, so the snapshot read throws ENOTDIR.
      await fsp.rm(root, { recursive: true, force: true });
      await fsp.writeFile(root, "not a directory");

      await expect(runtime.dispose?.()).resolves.toBeUndefined();
      expect(nextDisposed).toBe(true);
    });

  it("still reports a partial sync-back when the higher tier's dispose throws",
    async () => {
      const root = await trackedRoot();
      const events: HarnessEventInput[] = [];
      const runtime = await tieredExecutionEnvironment({
        nextTier: async (inner) => createShellRuntime({
          workspace: inner.workspace,
          files: inner.files,
          execute: async () => OK,
          dispose: async () => {
            await fsp.writeFile(nodePath.join(root, "half.txt"), "partial");
            throw new Error("workspace egress failed");
          },
        }),
      })({
        workspace: {
          sessionId: "tier-dispose-failure",
          workingDir: "/session",
          mounts: [
            { mountPath: "/session", backingPath: root, mode: "rw", trackChanges: true },
          ],
        },
        files: {} as never,
        emit: async (event) => {
          events.push(event);
        },
      });
      const shell = runtime.shellTool() as {
        execute(input: unknown, context: unknown): Promise<{ exitCode: number }>;
      };
      await shell.execute({ command: "git --version" }, { toolCallId: "c1", messages: [] });

      // The disposal error still reaches the caller — that is what makes
      // `harness.runtime.dispose.failed` fire — and the partial write is visible.
      await expect(runtime.dispose?.()).rejects.toThrow("workspace egress failed");
      expect(events.filter(({ type }) => type === "harness.file.created")
        .map((event) => event.metadata?.path)).toEqual(["/session/half.txt"]);
    });
});
