import { resolve } from "node:path";
import {
  aggregateLocalOutcomes,
  doctorSession,
  latestDiffForPath,
  listLocalArtifacts,
  listLocalFiles,
  listLocalSessions,
  readLocalTrace,
} from "./trace/inspect.js";
import { connectorsCommand, initCommand, newCommand, testCommand } from "./cli/agent-commands.js";

export type CliIo = {
  stdout?: (text: string) => void | Promise<void>;
  stderr?: (text: string) => void | Promise<void>;
  cwd?: string;
};

const DEFAULT_DATA_DIR = ".little-harness";

export async function runCli(
  argv: readonly string[] = process.argv.slice(2),
  io: CliIo = {},
): Promise<number> {
  try {
    const parsed = parseSharedArgs(argv);
    const [command, ...args] = parsed.args;

    if (!command || command === "--help" || command === "-h") {
      await writeStdout(io, usage());
      return command ? 0 : 1;
    }

    switch (command) {
      case "sessions":
        return sessionsCommand(parsed.dataDir, io);
      case "trace":
        return traceCommand(args, parsed.dataDir, io);
      case "files":
        return filesCommand(args, parsed.dataDir, io);
      case "artifacts":
        return artifactsCommand(args, parsed.dataDir, io);
      case "diff":
        return diffCommand(args, parsed.dataDir, io);
      case "doctor":
        return doctorCommand(args, parsed.dataDir, io);
      case "outcomes":
        return outcomesCommand(args, parsed.dataDir, io);
      case "init":
        return initCommand(args, io);
      case "new":
        return newCommand(args, io);
      case "test":
        return testCommand(args, parsed.dataDir, io);
      case "connectors":
        return connectorsCommand(args, parsed.dataDir, io);
      default:
        throw new CliUsageError(`Unknown command: ${command}`);
    }
  } catch (error) {
    await writeStderr(io, `${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

async function sessionsCommand(dataDir: string, io: CliIo): Promise<number> {
  await writeJsonLine(
    io,
    await listLocalSessions(withCwd(io, { dataDir: resolvePath(dataDir, io) })),
  );
  return 0;
}

async function traceCommand(
  args: readonly string[],
  dataDir: string,
  io: CliIo,
): Promise<number> {
  const parsed = parseCommandOptions(args);
  if (parsed.positionals.length !== 1) {
    throw new CliUsageError(
      "Usage: little-harness trace <session-id> [--format ndjson|pretty] [--data-dir <dir>]",
    );
  }

  const format = parsed.options.format ?? "ndjson";
  const events = await readLocalTrace(
    withCwd(io, {
      dataDir: resolvePath(dataDir, io),
      sessionId: parsed.positionals[0]!,
    }),
  );

  if (format === "pretty") {
    await writeStdout(io, formatPrettyTrace(events));
    return 0;
  }

  if (format !== "ndjson") {
    throw new CliUsageError("--format must be ndjson or pretty.");
  }

  for (const event of events) {
    await writeJsonLine(io, event);
  }
  return 0;
}

async function filesCommand(
  args: readonly string[],
  dataDir: string,
  io: CliIo,
): Promise<number> {
  const parsed = parseCommandOptions(args);
  if (parsed.positionals.length !== 1) {
    throw new CliUsageError("Usage: little-harness files <session-id> [--data-dir <dir>]");
  }
  const files = await listLocalFiles(
    withCwd(io, {
      dataDir: resolvePath(dataDir, io),
      sessionId: parsed.positionals[0]!,
    }),
  );
  await writeJsonLine(io, files);
  return 0;
}

async function artifactsCommand(
  args: readonly string[],
  dataDir: string,
  io: CliIo,
): Promise<number> {
  const parsed = parseCommandOptions(args);
  if (parsed.positionals.length !== 1) {
    throw new CliUsageError("Usage: little-harness artifacts <session-id> [--data-dir <dir>]");
  }
  const artifacts = await listLocalArtifacts(
    withCwd(io, {
      dataDir: resolvePath(dataDir, io),
      sessionId: parsed.positionals[0]!,
    }),
  );
  await writeJsonLine(io, artifacts);
  return 0;
}

async function diffCommand(
  args: readonly string[],
  dataDir: string,
  io: CliIo,
): Promise<number> {
  const parsed = parseCommandOptions(args);
  if (parsed.positionals.length !== 1 || !parsed.options.path) {
    throw new CliUsageError(
      "Usage: little-harness diff <session-id> --path <harness-path> [--data-dir <dir>]",
    );
  }
  const diff = await latestDiffForPath(
    withCwd(io, {
      dataDir: resolvePath(dataDir, io),
      sessionId: parsed.positionals[0]!,
      path: parsed.options.path,
    }),
  );
  await writeJsonLine(io, diff ?? { path: parsed.options.path, diff: undefined });
  return 0;
}

async function doctorCommand(
  args: readonly string[],
  dataDir: string,
  io: CliIo,
): Promise<number> {
  const parsed = parseCommandOptions(args);
  if (parsed.positionals.length !== 1) {
    throw new CliUsageError("Usage: little-harness doctor <session-id> [--data-dir <dir>]");
  }
  const summary = await doctorSession(
    withCwd(io, {
      dataDir: resolvePath(dataDir, io),
      sessionId: parsed.positionals[0]!,
    }),
  );
  await writeJsonLine(io, summary);
  return summary.invalidEventCount > 0 || summary.failureCount > 0 ? 2 : 0;
}

async function outcomesCommand(
  args: readonly string[],
  dataDir: string,
  io: CliIo,
): Promise<number> {
  const parsed = parseCommandOptions(args);
  if (parsed.positionals.length > 1) {
    throw new CliUsageError("Usage: little-harness outcomes [session-id] [--data-dir <dir>]");
  }
  const sessionId = parsed.positionals[0];
  const report = await aggregateLocalOutcomes(
    withCwd(io, {
      dataDir: resolvePath(dataDir, io),
      ...(sessionId === undefined ? {} : { sessionId }),
    }),
  );
  await writeJsonLine(io, report);
  return 0;
}

function parseSharedArgs(argv: readonly string[]): { args: string[]; dataDir: string } {
  const args: string[] = [];
  let dataDir = DEFAULT_DATA_DIR;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--data-dir") {
      dataDir = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg?.startsWith("--data-dir=")) {
      dataDir = arg.slice("--data-dir=".length);
      continue;
    }
    if (arg !== undefined) {
      args.push(arg);
    }
  }

  if (!dataDir) {
    throw new CliUsageError("--data-dir requires a value.");
  }
  return { args, dataDir };
}

function parseCommandOptions(argv: readonly string[]): {
  positionals: string[];
  options: Record<string, string | undefined>;
} {
  const positionals: string[] = [];
  const options: Record<string, string | undefined> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--path" || arg === "--format") {
      const key = arg.slice(2);
      const value = argv[index + 1];
      if (!value) {
        throw new CliUsageError(`${arg} requires a value.`);
      }
      options[key] = value;
      index += 1;
      continue;
    }
    if (arg?.startsWith("--path=") || arg?.startsWith("--format=")) {
      const [key, value] = arg.slice(2).split("=", 2);
      if (!key || !value) {
        throw new CliUsageError(`${arg.slice(0, arg.indexOf("="))} requires a value.`);
      }
      options[key] = value;
      continue;
    }
    if (arg !== undefined) {
      positionals.push(arg);
    }
  }

  return { positionals, options };
}

function resolvePath(pathname: string, io: CliIo): string {
  return resolve(io.cwd ?? process.cwd(), pathname);
}

function withCwd<T extends object>(io: CliIo, options: T): T & { cwd?: string } {
  return io.cwd === undefined ? options : { ...options, cwd: io.cwd };
}

function formatPrettyTrace(
  events: Awaited<ReturnType<typeof readLocalTrace>>,
): string {
  const lines: string[] = [];
  let currentTurn: string | undefined;
  let currentStep: string | undefined;
  let currentToolCall: string | undefined;

  for (const event of events) {
    if (event.turnId && event.turnId !== currentTurn) {
      currentTurn = event.turnId;
      currentStep = undefined;
      currentToolCall = undefined;
      lines.push(`turn ${event.turnId}`);
    }

    if (event.stepId && event.stepId !== currentStep) {
      currentStep = event.stepId;
      currentToolCall = undefined;
      lines.push(`${event.turnId ? "  " : ""}step ${event.stepId}`);
    }

    const toolCallId =
      typeof event.metadata?.toolCallId === "string" ? event.metadata.toolCallId : undefined;
    if (toolCallId && toolCallId !== currentToolCall) {
      currentToolCall = toolCallId;
      const toolName =
        typeof event.metadata?.toolName === "string" ? ` ${event.metadata.toolName}` : "";
      lines.push(`${event.turnId || event.stepId ? "    " : ""}tool ${toolCallId}${toolName}`);
    }

    const indent = toolCallId
      ? "      "
      : event.stepId
        ? "    "
        : event.turnId
          ? "  "
          : "";
    lines.push(`${indent}${event.sequence}  ${event.type}  ${event.timestamp}`);
  }

  return `${lines.join("\n")}${lines.length > 0 ? "\n" : ""}`;
}

async function writeJsonLine(io: CliIo, value: unknown): Promise<void> {
  await writeStdout(io, `${JSON.stringify(value)}\n`);
}

async function writeStdout(io: CliIo, text: string): Promise<void> {
  await (io.stdout ?? process.stdout.write.bind(process.stdout))(text);
}

async function writeStderr(io: CliIo, text: string): Promise<void> {
  await (io.stderr ?? process.stderr.write.bind(process.stderr))(text);
}

function usage(): string {
  return [
    "Usage: little-harness [--data-dir <dir>] <command>",
    "",
    "Commands:",
    "  sessions                 List Local Host sessions",
    "  trace <session-id>       Dump validated trace NDJSON or a pretty timeline",
    "  files <session-id>       List mounted managed files without contents",
    "  artifacts <session-id>   List artifact refs",
    "  diff <session-id> --path <harness-path>",
    "                           Print the latest traced file diff metadata",
    "  doctor <session-id>      Summarize trace failures and debug signals",
    "  outcomes [session-id]    Success rate (with sample size) per promptHash and stepPath,",
    "                           folded from outcome.reported events. Omit the session id to",
    "                           aggregate across every session in the data dir.",
    "",
    "  init [name]              Guided project setup wizard",
    "                           Flags: --provider, --model, --yes, --no-install, --here, --force",
    "  new <name>               Scaffold a new agent folder under agents/",
    "                           Flags: --provider, --model, --force",
    "  test <name>              Interactively chat with an agent (REPL)",
    "                           Flags: --connector <id> (exercise a connector's toolset)",
    "  connectors <name>        List an agent's discovered connectors and skipped candidates",
    "",
  ].join("\n");
}

class CliUsageError extends Error {}
