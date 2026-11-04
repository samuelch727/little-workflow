import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { runCli } from "../cli-core.js";
import { createHarness } from "../create-harness.js";
import { localHost } from "../local-host/index.js";
import { startAgentServer } from "../server/agent-server.js";
import { withTempDir } from "../test/temp.js";
import { runDevRepl, superviseChild } from "./serve-commands.js";

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

async function workspace(dir: string): Promise<string> {
  const agentDir = join(dir, "agents", "loan-officer");
  await mkdir(join(agentDir, "schedules"), { recursive: true });
  await writeFile(
    join(agentDir, "agent.ts"),
    `import { MockLanguageModelV3 } from "ai/test";
import { createHarness } from ${JSON.stringify(resolve("src/create-harness.ts"))};
import { localHost } from ${JSON.stringify(resolve("src/local-host/index.ts"))};
const usage = ${JSON.stringify(usage)};
export default createHarness({
  host: localHost({ dataDir: ${JSON.stringify(join(dir, "data"))}, sandbox: "in-process" }),
  model: new MockLanguageModelV3({
    doGenerate: async () => ({ content: [{ type: "text", text: "Backlog done." }], finishReason: { unified: "stop", raw: "stop" }, usage, warnings: [] }),
  }),
  runtime: { bash: false },
});
`,
  );
  await writeFile(
    join(agentDir, "schedules", "morning-backlog.ts"),
    `import { defineSchedule } from ${JSON.stringify(resolve("src/schedules/schedule.ts"))};
export default defineSchedule({ cron: "0 9 * * 1-5", timezone: "Asia/Hong_Kong", prompt: "Work the backlog." });
`,
  );
  return agentDir;
}

it("lists an agent's schedules and runs one by hand", async () => {
  await withTempDir(async (dir) => {
    await workspace(dir);
    let stdout = "";
    const io = { cwd: dir, stdout: (text: string) => void (stdout += text), stderr: (text: string) => void (stdout += text) };

    expect(await runCli(["schedules", "loan-officer"], io)).toBe(0);
    expect(stdout).toMatch(/^morning-backlog {2}0 9 \* \* 1-5 \(Asia\/Hong_Kong\) {2}next \d{4}-\d\d-\d\dT01:00:00\.000Z {2}last never\n$/u);

    stdout = "";
    expect(await runCli(["schedules", "run", "loan-officer", "morning-backlog"], io)).toBe(0);
    expect(stdout).toMatch(/^Ran morning-backlog in session schedule-morning-backlog-\d{8}T\d{4}: completed\nBacklog done\.\n$/u);

    stdout = "";
    expect(await runCli(["schedules", "loan-officer"], io)).toBe(0);
    expect(stdout).not.toContain("last never");

    stdout = "";
    expect(await runCli(["schedules", "run", "loan-officer", "nightly"], io)).toBe(1);
    expect(stdout).toContain("No schedule 'nightly'. Schedules: morning-backlog.");
  });
});

it("chats in the terminal and answers the agent's questions", async () => {
  await withTempDir(async (dir) => {
    let call = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        call += 1;
        const toolMessages = options.prompt.filter((message) => message.role === "tool");
        const last = toolMessages.at(-1)?.content.at(-1) as { toolName?: string; output?: { value?: any } } | undefined;
        const reply = (content: unknown[], finish: "stop" | "tool-calls") => ({
          content: content as never,
          finishReason: { unified: finish, raw: finish },
          usage,
          warnings: [],
        });
        if (last?.toolName === "await_tasks") {
          return reply([{ type: "text", text: `Decision: ${last.output?.value.tasks[0].answer.option}` }], "stop");
        }
        if (last?.toolName === "ask_person") {
          return reply([{ type: "tool-call", toolCallId: `c${call}`, toolName: "await_tasks", input: JSON.stringify({ taskIds: [last.output?.value.taskId], mode: "all" }) }], "tool-calls");
        }
        const user = JSON.stringify(options.prompt.at(-1)?.content);
        if (user.includes("APP-1")) {
          return reply([{ type: "tool-call", toolCallId: `c${call}`, toolName: "ask_person", input: JSON.stringify({ question: "Approve APP-1?", options: [{ id: "approve", label: "Approve" }, { id: "decline", label: "Decline" }] }) }], "tool-calls");
        }
        return reply([{ type: "text", text: "Hello." }], "stop");
      },
    });
    const logs: string[] = [];
    const harness = createHarness({
      host: localHost({ dataDir: join(dir, "data"), sandbox: "in-process" }),
      model,
      humanInput: true,
      runtime: { bash: false },
    });
    await mkdir(join(dir, "agent"));
    const server = await startAgentServer({
      agentDir: join(dir, "agent"),
      agentName: "loan-officer",
      port: 0,
      dataDir: join(dir, "cli-data"),
      log: (line) => logs.push(line),
      logFullReplies: true,
      loadHarness: async () => harness,
    });
    try {
      const lines = ["Hi", "Review APP-1.", ":questions", ":answer 1 approve", ":exit"];
      let stdout = "";
      await runDevRepl({
        url: server.url,
        io: { stdout: (text) => void (stdout += text), stderr: (text) => void (stdout += text) },
        read: async () => lines.shift() ?? null,
        session: "dev-1",
      });
      expect(stdout).toContain("agent> Hello.\n");
      expect(stdout).toContain("agent> (waiting; type :questions to see what it asked)\n");
      expect(stdout).toContain("1. [dev-1] Approve APP-1?  (approve = Approve, decline = Decline)\n");
      expect(stdout).toContain("(answered; the agent continues, and its reply appears in the log)\n");
      await server.tick();
      expect(logs).toContain("[resume] session dev-1 completed:\nDecision: approve");
    } finally {
      await server.close();
    }
  });
});

it("sends the token from the dev chat when the server has one", async () => {
  await withTempDir(async (dir) => {
    const harness = createHarness({
      host: localHost({ dataDir: join(dir, "data"), sandbox: "in-process" }),
      model: new MockLanguageModelV3({
        doGenerate: async () => ({ content: [{ type: "text", text: "Hello." }], finishReason: { unified: "stop", raw: "stop" }, usage, warnings: [] }),
      }),
      runtime: { bash: false },
    });
    await mkdir(join(dir, "agent"));
    const server = await startAgentServer({
      agentDir: join(dir, "agent"),
      agentName: "loan-officer",
      port: 0,
      token: "secret",
      dataDir: join(dir, "cli-data"),
      log: () => {},
      loadHarness: async () => harness,
    });
    try {
      const lines = ["Hi", ":questions", ":exit"];
      let stdout = "";
      await runDevRepl({
        url: server.url,
        io: { stdout: (text) => void (stdout += text), stderr: (text) => void (stdout += text) },
        read: async () => lines.shift() ?? null,
        session: "dev-1",
        token: "secret",
      });
      expect(stdout).toContain("agent> Hello.\n");
      expect(stdout).toContain("(no questions waiting)\n");
      expect(stdout).not.toContain("Authorization");
    } finally {
      await server.close();
    }
  });
});

describe("superviseChild", () => {
  const exited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null;
  /** A child that takes `stopMs` to stop on SIGTERM, or ignores it; resolves once it listens for it. */
  const startChild = (started: ChildProcess[], onTerm: string) => () => {
    const child = spawn(process.execPath, ["-e", `process.on("SIGTERM", () => { ${onTerm} }); console.log("ready"); setInterval(() => {}, 1000);`], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    started.push(child);
    return child;
  };
  const ready = (child: ChildProcess) => new Promise<void>((resolve) => child.stdout!.once("data", () => resolve()));

  it("waits for the old child to exit before starting the next, one restart at a time", async () => {
    const started: ChildProcess[] = [];
    const supervisor = superviseChild(startChild(started, "setTimeout(() => process.exit(0), 200);"));
    try {
      await supervisor.restart();
      await ready(started[0]!);
      // Several changes while the old server is still stopping.
      await Promise.all([supervisor.restart(), supervisor.restart(), supervisor.restart()]);
      expect(started).toHaveLength(4);
      expect(started.slice(0, 3).every(exited)).toBe(true);
      expect(exited(started[3]!)).toBe(false);
    } finally {
      await supervisor.close();
    }
    expect(started.every(exited)).toBe(true);
  });

  it("kills a child that does not stop", async () => {
    const started: ChildProcess[] = [];
    const supervisor = superviseChild(startChild(started, ""), { killAfterMs: 200 });
    await supervisor.restart();
    await ready(started[0]!);
    await supervisor.close();
    expect(started[0]!.signalCode).toBe("SIGKILL");
  });
});
