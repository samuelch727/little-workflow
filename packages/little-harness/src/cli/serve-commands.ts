import { spawn, type ChildProcess } from "node:child_process";
import { watch } from "node:fs";
import { join, resolve } from "node:path";
import type { CliIo } from "../cli-core.js";
import { createScheduleRunner } from "../schedules/runner.js";
import { discoverSchedules } from "../schedules/schedule.js";
import { startAgentServer } from "../server/agent-server.js";
import { loadHarness, loadWorkspace } from "../workspace/index.js";
import { parseKnownOptions, readLineFromStdin } from "./agent-commands.js";

const DEFAULT_PORT = 3000;

/** `little-harness start <name>`: serve one agent until the process is stopped. */
export async function startCommand(args: readonly string[], dataDir: string, io: CliIo): Promise<number> {
  const parsed = parseKnownOptions(args, new Set(["port", "host", "token", "resume"]), new Set(["dev"]));
  const agent = await findAgent(parsed.positionals[0], io, "start <name> [--port <n>] [--host <address>] [--token <token>] [--resume timer|caller]");
  if (agent === undefined) return 1;
  const resume = parsed.options.resume;
  if (resume !== undefined && resume !== "timer" && resume !== "caller") {
    await write(io, `--resume takes timer or caller, not ${resume}\n`, "stderr");
    return 1;
  }
  const token = parsed.options.token ?? process.env.LITTLE_HARNESS_TOKEN;
  const server = await startAgentServer({
    agentDir: agent.dir,
    agentName: agent.name,
    port: port(parsed.options.port),
    ...(parsed.options.host === undefined ? {} : { hostname: parsed.options.host }),
    ...(token === undefined || token === "" ? {} : { token }),
    ...(resume === undefined ? {} : { resume }),
    dataDir: resolve(cwdOf(io), dataDir),
    log: (line) => void write(io, `${line}\n`),
    logFullReplies: parsed.flags.has("dev"),
  });
  await new Promise<void>((done) => {
    const stop = () => done();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  await server.close();
  return 0;
}

/**
 * `little-harness dev <name>`: `start` in a child process that restarts when the agent folder
 * changes, with a terminal chat against it.
 */
export async function devCommand(args: readonly string[], dataDir: string, io: CliIo): Promise<number> {
  const parsed = parseKnownOptions(args, new Set(["port"]));
  const agent = await findAgent(parsed.positionals[0], io, "dev <name> [--port <n>]");
  if (agent === undefined) return 1;
  const listenPort = port(parsed.options.port);
  const childArgs = [
    ...process.execArgv,
    process.argv[1]!,
    "--data-dir",
    resolve(cwdOf(io), dataDir),
    "start",
    agent.name,
    "--port",
    String(listenPort),
    "--dev",
  ];
  const server = superviseChild(
    () => spawn(process.execPath, childArgs, { cwd: cwdOf(io), stdio: ["ignore", "inherit", "inherit"] }),
    {
      onExit: (code, signal) => void write(io, `[dev] the server stopped (${signal ?? `exit ${code}`}); save a file to restart it\n`),
    },
  );
  void server.restart();
  let pending: NodeJS.Timeout | undefined;
  const watcher = watch(agent.dir, { recursive: true }, (_event, file) => {
    if (file !== null && /(^|[/\\])(node_modules|\.)/u.test(file)) return;
    clearTimeout(pending);
    pending = setTimeout(() => {
      void write(io, `[dev] ${file ?? "a file"} changed; restarting\n`);
      void server.restart();
    }, 300);
  });
  // The child `start` reads LITTLE_HARNESS_TOKEN too, and then wants it on every API request.
  const token = process.env.LITTLE_HARNESS_TOKEN;
  try {
    await runDevRepl({
      url: `http://127.0.0.1:${listenPort}`,
      io,
      read: readLineFromStdin(),
      ...(token === undefined || token === "" ? {} : { token }),
    });
  } finally {
    watcher.close();
    clearTimeout(pending);
    await server.close();
  }
  return 0;
}

/**
 * Runs one child process at a time. `restart` stops the running child and waits for it to exit
 * (SIGTERM, then SIGKILL after `killAfterMs`) before it starts the next, and restarts queue up
 * behind each other, so overlapping restarts never leave an old child running.
 */
export function superviseChild(
  start: () => ChildProcess,
  options: {
    /** Default 5000. */
    readonly killAfterMs?: number;
    /** Called when the running child exits without being stopped. */
    readonly onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
  } = {},
): { restart(): Promise<void>; close(): Promise<void> } {
  let child: ChildProcess | undefined;
  let closed = false;
  let queue: Promise<void> = Promise.resolve();
  const enqueue = (step: () => Promise<void>): Promise<void> => {
    const next = queue.then(step);
    queue = next.catch(() => {});
    return next;
  };
  const stop = async () => {
    const running = child;
    child = undefined;
    if (running === undefined || running.pid === undefined || running.exitCode !== null || running.signalCode !== null) return;
    await new Promise<void>((done) => {
      const kill = setTimeout(() => running.kill("SIGKILL"), options.killAfterMs ?? 5_000);
      running.once("exit", () => {
        clearTimeout(kill);
        done();
      });
      running.kill("SIGTERM");
    });
  };
  return {
    restart: () => enqueue(async () => {
      await stop();
      if (closed) return;
      const started = start();
      started.once("exit", (code, signal) => {
        if (child === started) options.onExit?.(code, signal);
      });
      child = started;
    }),
    close: () => {
      closed = true;
      return enqueue(stop);
    },
  };
}

/** `little-harness schedules <name>` lists; `schedules run <name> <id>` runs one now. */
export async function schedulesCommand(args: readonly string[], dataDir: string, io: CliIo): Promise<number> {
  const parsed = parseKnownOptions(args, new Set());
  const [first, second, third] = parsed.positionals;
  const running = first === "run" && third !== undefined;
  const agent = await findAgent(running ? second : first, io, "schedules <name> | schedules run <name> <schedule-id>");
  if (agent === undefined) return 1;
  const harness = await loadHarness(agent.dir);
  const runner = createScheduleRunner({
    harness,
    schedules: await discoverSchedules(agent.dir),
    stateDir: join(harness.config.host.dataDir ?? resolve(cwdOf(io), dataDir), "schedules", agent.name),
  });
  if (running) {
    const run = await runner.run(third);
    const outcome = run.outcome;
    await write(io, `Ran ${run.id} in session ${run.sessionId}: ${outcome.status}\n`);
    if (outcome.status === "completed" && outcome.result.status === "completed") await write(io, `${outcome.result.text}\n`);
    if (outcome.status === "failed") {
      await write(io, `${outcome.error instanceof Error ? outcome.error.message : String(outcome.error)}\n`, "stderr");
      return 1;
    }
    return 0;
  }
  const schedules = await runner.list();
  if (schedules.length === 0) {
    await write(io, `No schedules for '${agent.name}'. Add one at agents/${agent.name}/schedules/<id>.ts.\n`);
    return 0;
  }
  for (const schedule of schedules) {
    await write(
      io,
      `${schedule.id}  ${schedule.cron} (${schedule.timezone})  next ${schedule.next ?? "never"}  last ${schedule.lastRunAt ?? "never"}\n`,
    );
  }
  return 0;
}

/**
 * The terminal chat of `dev`: each line goes to the server as a message. `:questions` lists the
 * questions waiting for an answer, `:answer <n> <option or text>` answers one, `:reset` starts a
 * new session, `:exit` quits.
 */
export async function runDevRepl(options: {
  readonly url: string;
  readonly io: CliIo;
  readonly read: () => Promise<string | null>;
  readonly session?: string;
  /** Sent as `Authorization: Bearer <token>`, for a server started with a token. */
  readonly token?: string;
}): Promise<void> {
  const call = <T = any>(method: string, path: string, body?: unknown) => request<T>(options.url, method, path, body, options.token);
  let session = options.session ?? newSession();
  let questions: Array<{ requestId: string; sessionId: string; question: string; options?: Array<{ id: string; label: string }> }> = [];
  await write(options.io, `Chatting at ${options.url}. :questions, :answer <n> <reply>, :reset, :exit.\n`);
  for (;;) {
    await write(options.io, "\nyou> ");
    const line = await options.read();
    if (line === null) return;
    const text = line.trim();
    if (text === "") continue;
    if (text === ":exit") return;
    try {
      if (text === ":reset") {
        session = newSession();
        await write(options.io, "(new session)\n");
      } else if (text === ":questions") {
        questions = await call("GET", "/questions");
        if (questions.length === 0) await write(options.io, "(no questions waiting)\n");
        questions.forEach((question, index) => {
          const choices = question.options?.map((option) => `${option.id} = ${option.label}`).join(", ");
          void write(options.io, `${index + 1}. [${question.sessionId}] ${question.question}${choices ? `  (${choices})` : ""}\n`);
        });
      } else if (text.startsWith(":answer")) {
        const [, number, ...words] = text.split(/\s+/u);
        const question = questions[Number(number) - 1];
        const reply = words.join(" ");
        if (question === undefined || reply === "") {
          await write(options.io, "Usage: :answer <n> <option or text>, with n from :questions.\n");
          continue;
        }
        const isOption = question.options?.some((option) => option.id === reply) === true;
        await call("POST", `/sessions/${encodeURIComponent(question.sessionId)}/questions/${question.requestId}/answer`, {
          ...(isOption ? { option: reply } : { text: reply }),
          answeredBy: "dev terminal",
        });
        await write(options.io, "(answered; the agent continues, and its reply appears in the log)\n");
      } else {
        const result = await call<{ status: string; text?: string }>(
          "POST",
          `/sessions/${encodeURIComponent(session)}/messages`,
          { prompt: text },
        );
        await write(
          options.io,
          result.status === "parked"
            ? "agent> (waiting; type :questions to see what it asked)\n"
            : `agent> ${result.text ?? ""}\n`,
        );
      }
    } catch (error) {
      await write(options.io, `${error instanceof Error ? error.message : String(error)}\n`, "stderr");
    }
  }
}

async function request<T>(url: string, method: string, path: string, body: unknown, token: string | undefined): Promise<T> {
  const headers = {
    ...(body === undefined ? {} : { "content-type": "application/json" }),
    ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
  };
  // The server may still be starting, or restarting after a change.
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(`${url}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const json = await response.json() as T & { error?: string };
      if (!response.ok) throw new Error(json.error ?? `${response.status} from the server.`);
      return json;
    } catch (error) {
      const refused = (error as { cause?: { code?: string } }).cause?.code === "ECONNREFUSED";
      if (!refused || attempt >= 40) throw error;
      await new Promise((done) => setTimeout(done, 250));
    }
  }
}

async function findAgent(name: string | undefined, io: CliIo, usage: string) {
  if (name === undefined) {
    await write(io, `Usage: little-harness ${usage}\n`, "stderr");
    return undefined;
  }
  const { agents } = await loadWorkspace(cwdOf(io));
  const agent = agents.find((candidate) => candidate.name === name);
  if (agent === undefined) {
    await write(io, `Unknown agent '${name}'. Available: ${agents.map((a) => a.name).join(", ") || "(none)"}\n`, "stderr");
  }
  return agent;
}

function port(value: string | undefined): number {
  if (value === undefined) return DEFAULT_PORT;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) throw new Error(`--port must be 0-65535, not '${value}'.`);
  return parsed;
}

function newSession(): string {
  return `dev-${new Date().toISOString().slice(0, 19).replace(/[-:]/gu, "")}`;
}

function cwdOf(io: CliIo): string {
  return io.cwd ?? process.cwd();
}

async function write(io: CliIo, text: string, stream: "stdout" | "stderr" = "stdout"): Promise<void> {
  const sink = stream === "stdout" ? io.stdout : io.stderr;
  await (sink ?? ((t: string) => void (stream === "stdout" ? process.stdout : process.stderr).write(t)))(text);
}
