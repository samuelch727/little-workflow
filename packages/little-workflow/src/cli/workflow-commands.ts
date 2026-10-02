import { basename, resolve } from "node:path";
import {
  addHarnessToWorkflowProject,
  addWorkflowToProject,
  initWorkflowProject,
} from "./workflow-scaffold.js";

export type WorkflowCommandIo = {
  readonly cwd?: string;
  readonly stdout?: (text: string) => void | Promise<void>;
  readonly stderr?: (text: string) => void | Promise<void>;
};

const INIT_USAGE = [
  "Usage: little init [name] [options]",
  "",
  "Scaffold a Little Workflow project: a starter workflow, package.json, and tsconfig.",
  "",
  "Options:",
  "  --here              Scaffold into the current directory",
  "  --workflow <name>   Starter workflow name (default: candidate-review)",
  "  --with-harness      Also scaffold a Little Harness agent that calls the workflow",
  "  --agent <name>      Agent name for --with-harness (default: support)",
  "  --provider <id>     AI SDK provider (default: deepseek)",
  "  --model <id>        Model id for the provider",
  "  --force             Overwrite existing files",
  "",
].join("\n");

const ADD_USAGE = [
  "Usage:",
  "  little add workflow <name> [--dir <dir>] [--provider <id>] [--model <id>] [--force]",
  "  little add harness [--agent <name>] [--workflow <name>] [--provider <id>] [--model <id>] [--force]",
  "",
].join("\n");

function wantsHelp(args: readonly string[]): boolean {
  return args.includes("--help") || args.includes("-h");
}

export async function initCommand(args: readonly string[], io: WorkflowCommandIo = {}): Promise<number> {
  if (wantsHelp(args)) {
    await writeStdout(io, INIT_USAGE);
    return 0;
  }
  try {
    const options = parseInitArgs(args);
    const cwd = io.cwd ?? process.cwd();
    const root = options.here ? cwd : resolve(cwd, options.projectName ?? "little-workflow-project");
    await initWorkflowProject(root, {
      projectName: options.projectName ?? basename(root),
      workflowName: options.workflowName,
      provider: options.provider,
      model: options.model,
      force: options.force,
      here: options.here,
      ...(options.withHarness
        ? {
            withHarness: {
              agentName: options.agentName,
              provider: options.provider,
              model: options.model,
            },
          }
        : {}),
    });
    await writeStdout(io, successMessage(options.here ? "." : basename(root), options.withHarness));
    return 0;
  } catch (error) {
    await writeStderr(io, `${errorMessage(error)}\n`);
    return 1;
  }
}

export async function addCommand(args: readonly string[], io: WorkflowCommandIo = {}): Promise<number> {
  if (wantsHelp(args)) {
    await writeStdout(io, ADD_USAGE);
    return 0;
  }
  const [kind, ...rest] = args;
  try {
    if (kind === "workflow") {
      const options = parseAddWorkflowArgs(rest);
      await addWorkflowToProject(resolve(io.cwd ?? process.cwd()), options);
      await writeStdout(io, `Added workflow ${options.workflowName}.\n`);
      return 0;
    }
    if (kind === "harness") {
      const options = parseAddHarnessArgs(rest);
      await addHarnessToWorkflowProject(resolve(io.cwd ?? process.cwd()), options);
      await writeStdout(io, `Added harness ${options.agentName ?? "support"}.\n`);
      return 0;
    }
    throw new Error("Usage: little add workflow <name> | little add harness");
  } catch (error) {
    await writeStderr(io, `${errorMessage(error)}\n`);
    return 1;
  }
}

function parseInitArgs(args: readonly string[]): {
  readonly projectName?: string;
  readonly here: boolean;
  readonly workflowName?: string;
  readonly withHarness: boolean;
  readonly agentName?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly force?: boolean;
} {
  const positional: string[] = [];
  let here = false;
  let workflowName: string | undefined;
  let withHarness = false;
  let agentName: string | undefined;
  let provider: string | undefined;
  let model: string | undefined;
  let force = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--here") {
      here = true;
    } else if (arg === "--workflow") {
      workflowName = required(args, index, "--workflow");
      index += 1;
    } else if (arg?.startsWith("--workflow=")) {
      workflowName = arg.slice("--workflow=".length);
    } else if (arg === "--with-harness") {
      withHarness = true;
    } else if (arg === "--agent") {
      agentName = required(args, index, "--agent");
      index += 1;
    } else if (arg?.startsWith("--agent=")) {
      agentName = arg.slice("--agent=".length);
    } else if (arg === "--provider") {
      provider = required(args, index, "--provider");
      index += 1;
    } else if (arg?.startsWith("--provider=")) {
      provider = arg.slice("--provider=".length);
    } else if (arg === "--model") {
      model = required(args, index, "--model");
      index += 1;
    } else if (arg?.startsWith("--model=")) {
      model = arg.slice("--model=".length);
    } else if (arg === "--force") {
      force = true;
    } else if (arg === "--yes" || arg === "--no-install") {
      // Accepted for non-interactive CLI parity. This scaffold does not install packages.
    } else if (arg?.startsWith("-")) {
      throw new Error(`Unknown option '${arg}' for little init.\n${INIT_USAGE}`);
    } else {
      positional.push(arg as string);
    }
  }
  return {
    ...(positional[0] === undefined ? {} : { projectName: positional[0] }),
    here,
    ...(workflowName === undefined ? {} : { workflowName }),
    withHarness,
    ...(agentName === undefined ? {} : { agentName }),
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
    ...(force ? { force } : {}),
  };
}

function parseAddWorkflowArgs(args: readonly string[]): {
  readonly workflowName: string;
  readonly dir?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly force?: boolean;
} {
  const positional: string[] = [];
  let dir: string | undefined;
  let provider: string | undefined;
  let model: string | undefined;
  let force = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--dir") {
      dir = required(args, index, "--dir");
      index += 1;
    } else if (arg?.startsWith("--dir=")) {
      dir = arg.slice("--dir=".length);
    } else if (arg === "--provider") {
      provider = required(args, index, "--provider");
      index += 1;
    } else if (arg?.startsWith("--provider=")) {
      provider = arg.slice("--provider=".length);
    } else if (arg === "--model") {
      model = required(args, index, "--model");
      index += 1;
    } else if (arg?.startsWith("--model=")) {
      model = arg.slice("--model=".length);
    } else if (arg === "--force") {
      force = true;
    } else if (arg?.startsWith("-")) {
      throw new Error(`Unknown option '${arg}' for little add workflow.\n${ADD_USAGE}`);
    } else {
      positional.push(arg as string);
    }
  }
  if (positional.length !== 1) throw new Error("Usage: little add workflow <name>");
  return {
    workflowName: positional[0] as string,
    ...(dir === undefined ? {} : { dir }),
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
    ...(force ? { force } : {}),
  };
}

function parseAddHarnessArgs(args: readonly string[]): {
  readonly agentName?: string;
  readonly workflowName?: string;
  readonly newWorkflowName?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly force?: boolean;
} {
  let agentName: string | undefined;
  let workflowName: string | undefined;
  let newWorkflowName: string | undefined;
  let provider: string | undefined;
  let model: string | undefined;
  let force = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--agent") {
      agentName = required(args, index, "--agent");
      index += 1;
    } else if (arg?.startsWith("--agent=")) {
      agentName = arg.slice("--agent=".length);
    } else if (arg === "--workflow") {
      workflowName = required(args, index, "--workflow");
      index += 1;
    } else if (arg?.startsWith("--workflow=")) {
      workflowName = arg.slice("--workflow=".length);
    } else if (arg === "--new-workflow") {
      newWorkflowName = required(args, index, "--new-workflow");
      index += 1;
    } else if (arg?.startsWith("--new-workflow=")) {
      newWorkflowName = arg.slice("--new-workflow=".length);
    } else if (arg === "--provider") {
      provider = required(args, index, "--provider");
      index += 1;
    } else if (arg?.startsWith("--provider=")) {
      provider = arg.slice("--provider=".length);
    } else if (arg === "--model") {
      model = required(args, index, "--model");
      index += 1;
    } else if (arg?.startsWith("--model=")) {
      model = arg.slice("--model=".length);
    } else if (arg === "--force") {
      force = true;
    } else {
      throw new Error(`Unknown add harness option: ${arg}`);
    }
  }
  if (workflowName !== undefined && newWorkflowName !== undefined) {
    throw new Error("Choose either --workflow or --new-workflow, not both.");
  }
  return {
    ...(agentName === undefined ? {} : { agentName }),
    ...(workflowName === undefined ? {} : { workflowName }),
    ...(newWorkflowName === undefined ? {} : { newWorkflowName }),
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
    ...(force ? { force } : {}),
  };
}

function required(args: readonly string[], index: number, option: string): string {
  const value = args[index + 1];
  if (value === undefined) throw new Error(`${option} requires a value.`);
  return value;
}

function successMessage(target: string, withHarness: boolean): string {
  return [
    `Created ${target}.`,
    target === "." ? "" : `cd ${target}`,
    "pnpm install",
    "pnpm test:workflow",
    withHarness ? "pnpm test:agent" : "",
  ].filter(Boolean).join("\n") + "\n";
}

async function writeStdout(io: WorkflowCommandIo, text: string): Promise<void> {
  await (io.stdout ?? ((value: string) => process.stdout.write(value)))(text);
}

async function writeStderr(io: WorkflowCommandIo, text: string): Promise<void> {
  await (io.stderr ?? ((value: string) => process.stderr.write(value)))(text);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
