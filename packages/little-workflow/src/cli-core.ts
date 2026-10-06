import { setupCommand } from "./cli/setup-command.js";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { sha256Digest } from "./canonical.js";
import {
  computeCompiledWorkflowVersionIdentity,
  computeCompilerValidationHash,
  lwirVersionIdForHash,
  type WorkflowVersionLockSeed,
} from "./compiler-lock.js";
import type { LwirWorkflow, WorkflowVersion } from "./lwir.js";
import { registerWorkflowVersion, validateLwir } from "./lwir.js";
import { replayRun } from "./replay.js";
import { formatRunReport, runReport } from "./run-report.js";
import { materializeRunState } from "./world.js";
import { executeWorkflowVersion, type RuntimeRunResult } from "./runtime.js";
import { localWorld, type RunResult } from "./authoring.js";
import { concreteInputStructure } from "./workflow-version-reuse.js";
import { loadWorkflow } from "./workspace/load-workflow.js";
import { resolveWorkflowReference } from "./workspace/resolve-workflow-reference.js";
import { addCommand, initCommand } from "./cli/workflow-commands.js";

type CliIo = {
  readonly stdout?: (text: string) => void | Promise<void>;
  readonly stderr?: (text: string) => void | Promise<void>;
  readonly cwd?: string;
};

type ParsedSharedArgs = {
  readonly args: readonly string[];
  readonly dataDir: string;
};

type JsonRecord = Record<string, unknown>;

const DEFAULT_DATA_DIR = ".little-workflow";
const ALPHA_STEP_TYPES = [
  "ai.generate",
  "tool.call",
  "code.run",
  "parallel",
] as const;

export async function runCli(
  argv: readonly string[] = process.argv.slice(2),
  io: CliIo = {},
): Promise<number> {
  try {
    if (argv[0] === "setup") return await setupCommand(argv.slice(1), io);
    const parsed = parseSharedArgs(argv);
    const [command, ...args] = parsed.args;
    if (command === undefined || command === "--help" || command === "-h") {
      await writeStdout(io, usage());
      return command === undefined ? 1 : 0;
    }

    switch (command) {
      case "init":
        return await initCommand(args, io);
      case "add":
        return await addCommand(args, io);
      case "validate":
        return await validateCommand(args, io);
      case "events":
        return await eventsCommand(args, parsed.dataDir, io);
      case "replay":
        return await replayCommand(args, parsed.dataDir, io);
      case "report":
        return await reportCommand(args, parsed.dataDir, io);
      case "run":
        return await runCommand(args, parsed.dataDir, io);
      case "test":
        return await testCommand(args, parsed.dataDir, io);
      case "orchestrate":
        throw new CliUsageError(
          "little orchestrate requires a harness-backed planner, which is only exposed through the SDK in alpha.",
        );
      default:
        throw new CliUsageError(`Unknown command: ${command}`);
    }
  } catch (error) {
    await writeStderr(io, `${errorMessage(error)}\n`);
    return 1;
  }
}

async function testCommand(
  args: readonly string[],
  dataDir: string,
  io: CliIo,
): Promise<number> {
  const options = parseTestArgs(args);
  const input = await readJsonFile(options.inputPath, io);
  const resolved = await resolveWorkflowReference(options.workflow, { cwd: io.cwd });
  const loaded = await loadWorkflow(resolved.folder, resolved.loadOptions);
  try {
    const result = await loaded.run(input, {
      world: localWorld({ dataDir: resolvePath(dataDir, io) }),
      ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
    });
    await writeJsonLine(io, {
      workflowId: loaded.id,
      ...runSummary(result),
    });
    return result.status === "completed" ? 0 : 1;
  } catch (error) {
    await writeJsonLine(io, {
      workflowId: loaded.id,
      status: "failed",
      error: errorMessage(error),
    });
    return 1;
  }
}

async function validateCommand(args: readonly string[], io: CliIo): Promise<number> {
  if (args.length !== 1) {
    throw new CliUsageError("Usage: little validate <workflow.json>");
  }
  const document = await readJsonFile(args[0] as string, io);
  const result = validateLwir(lwirDocumentFrom(document));
  await writeJsonLine(io, result);
  return result.valid ? 0 : 1;
}

async function eventsCommand(
  args: readonly string[],
  dataDir: string,
  io: CliIo,
): Promise<number> {
  const options = parseEventsArgs(args);
  const world = localWorld({ dataDir: resolvePath(dataDir, io) });
  const events = await world.listEvents(options.runId);
  for (const event of events.filter((candidate) => eventMatchesFilters(candidate, options))) {
    await writeJsonLine(io, event);
  }
  return 0;
}

async function replayCommand(
  args: readonly string[],
  dataDir: string,
  io: CliIo,
): Promise<number> {
  if (args.length !== 1) {
    throw new CliUsageError("Usage: little replay <run-id> [--data-dir <dir>]");
  }
  const world = localWorld({ dataDir: resolvePath(dataDir, io) });
  const replay = await replayRun(world, args[0] as string);
  await writeJsonLine(io, replay.state);
  return 0;
}

/**
 * Per-step tokens, cache-hit share, and real dollars for a recorded run.
 *
 * JSON is the CLI's default output convention, so `--table` opts into the human-readable
 * fixed-width rendering rather than the other way round.
 */
async function reportCommand(
  args: readonly string[],
  dataDir: string,
  io: CliIo,
): Promise<number> {
  const options = parseReportArgs(args);
  const world = localWorld({ dataDir: resolvePath(dataDir, io) });
  const report = runReport(await materializeRunState(world, options.runId));
  if (options.table) {
    await writeStdout(io, formatRunReport(report));
    return 0;
  }
  await writeJsonLine(io, report);
  return 0;
}

function parseReportArgs(args: readonly string[]): {
  readonly runId: string;
  readonly table: boolean;
} {
  const positional: string[] = [];
  let table = false;
  for (const arg of args) {
    if (arg === "--table") {
      table = true;
      continue;
    }
    positional.push(arg as string);
  }
  if (positional.length !== 1) {
    throw new CliUsageError("Usage: little report <run-id> [--table] [--data-dir <dir>]");
  }
  return { runId: positional[0] as string, table };
}

async function runCommand(
  args: readonly string[],
  dataDir: string,
  io: CliIo,
): Promise<number> {
  const options = parseRunArgs(args);
  const workflowDocument = await readJsonFile(options.workflowPath, io);
  const input = await readJsonFile(options.inputPath, io);
  const workflowVersion = workflowVersionFromDocument(workflowDocument, input);
  const result = await executeWorkflowVersion({
    world: localWorld({ dataDir: resolvePath(dataDir, io) }),
    workflowVersion,
    input,
    ...(options.runId === undefined ? {} : { runId: options.runId }),
  });
  await writeJsonLine(io, runSummary(result));
  return result.status === "completed" ? 0 : 1;
}

function parseSharedArgs(argv: readonly string[]): ParsedSharedArgs {
  const args: string[] = [];
  let dataDir = DEFAULT_DATA_DIR;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--data-dir") {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new CliUsageError("--data-dir requires a value.");
      }
      dataDir = value;
      index += 1;
      continue;
    }
    if (arg?.startsWith("--data-dir=")) {
      dataDir = arg.slice("--data-dir=".length);
      continue;
    }
    if (arg === "--json") {
      continue;
    }
    args.push(arg as string);
  }
  return { args, dataDir };
}

function parseRunArgs(args: readonly string[]): {
  readonly workflowPath: string;
  readonly inputPath: string;
  readonly runId?: string;
} {
  const positional: string[] = [];
  let inputPath: string | undefined;
  let runId: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--input") {
      inputPath = requiredOptionValue(args, index, "--input");
      index += 1;
      continue;
    }
    if (arg?.startsWith("--input=")) {
      inputPath = arg.slice("--input=".length);
      continue;
    }
    if (arg === "--run-id") {
      runId = requiredOptionValue(args, index, "--run-id");
      index += 1;
      continue;
    }
    if (arg?.startsWith("--run-id=")) {
      runId = arg.slice("--run-id=".length);
      continue;
    }
    positional.push(arg as string);
  }
  if (positional.length !== 1 || inputPath === undefined) {
    throw new CliUsageError("Usage: little run <workflow.json> --input <input.json>");
  }
  return { workflowPath: positional[0] as string, inputPath, runId };
}

function parseTestArgs(args: readonly string[]): {
  readonly workflow: string;
  readonly inputPath: string;
  readonly timeout?: string | number;
} {
  const positional: string[] = [];
  let inputPath: string | undefined;
  let timeout: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--input") {
      inputPath = requiredOptionValue(args, index, "--input");
      index += 1;
      continue;
    }
    if (arg?.startsWith("--input=")) {
      inputPath = arg.slice("--input=".length);
      continue;
    }
    if (arg === "--timeout") {
      timeout = requiredOptionValue(args, index, "--timeout");
      index += 1;
      continue;
    }
    if (arg?.startsWith("--timeout=")) {
      timeout = arg.slice("--timeout=".length);
      continue;
    }
    positional.push(arg as string);
  }
  if (positional.length !== 1 || inputPath === undefined) {
    throw new CliUsageError("Usage: little test <workflow-folder-or-name> --input <input.json> [--timeout <ms>]");
  }
  return {
    workflow: positional[0] as string,
    inputPath,
    ...(timeout === undefined ? {} : { timeout }),
  };
}

function parseEventsArgs(args: readonly string[]): {
  readonly runId: string;
  readonly type?: string;
  readonly caller?: string;
} {
  const positional: string[] = [];
  let type: string | undefined;
  let caller: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--type") {
      type = requiredOptionValue(args, index, "--type");
      index += 1;
      continue;
    }
    if (arg?.startsWith("--type=")) {
      type = arg.slice("--type=".length);
      continue;
    }
    if (arg === "--caller") {
      caller = requiredOptionValue(args, index, "--caller");
      index += 1;
      continue;
    }
    if (arg?.startsWith("--caller=")) {
      caller = arg.slice("--caller=".length);
      continue;
    }
    positional.push(arg as string);
  }
  if (positional.length !== 1) {
    throw new CliUsageError("Usage: little events <run-id> [--type <event-type>] [--caller <caller>] [--data-dir <dir>]");
  }
  return {
    runId: positional[0] as string,
    ...(type === undefined ? {} : { type }),
    ...(caller === undefined ? {} : { caller }),
  };
}

function eventMatchesFilters(
  event: { readonly type: string; readonly payload?: unknown },
  filters: { readonly type?: string; readonly caller?: string },
): boolean {
  if (filters.type !== undefined && !eventTypeMatches(event.type, filters.type)) {
    return false;
  }
  if (filters.caller !== undefined) {
    return isRecord(event.payload) && event.payload.caller === filters.caller;
  }
  return true;
}

function eventTypeMatches(type: string, pattern: string): boolean {
  if (pattern.endsWith("*")) {
    return type.startsWith(pattern.slice(0, -1));
  }
  return type === pattern;
}

function requiredOptionValue(
  args: readonly string[],
  index: number,
  option: string,
): string {
  const value = args[index + 1];
  if (value === undefined) {
    throw new CliUsageError(`${option} requires a value.`);
  }
  return value;
}

async function readJsonFile(path: string, io: CliIo): Promise<unknown> {
  const text = await readFile(resolvePath(path, io), "utf8");
  return JSON.parse(text) as unknown;
}

function lwirDocumentFrom(document: unknown): unknown {
  if (isRecord(document) && Object.hasOwn(document, "lwir")) {
    return document.lwir;
  }
  return document;
}

function workflowVersionFromDocument(
  document: unknown,
  input: unknown,
): WorkflowVersion & {
  readonly lwirVersionId: string;
  readonly lwirHash: string;
  readonly lock: JsonRecord;
} {
  if (isLockedWorkflowVersion(document)) {
    assertLockedWorkflowVersionInputMatches(document, input);
    return document;
  }
  const lwir = lwirDocumentFrom(document);
  const validation = validateLwir(lwir);
  if (!validation.valid) {
    throw new CliUsageError(
      `Workflow is not valid LWIR: ${validation.findings
        .map((finding) => `${finding.path}: ${finding.message}`)
        .join("; ")}`,
    );
  }
  return lockDirectLwirWorkflowVersion(lwir as LwirWorkflow, input);
}

function assertLockedWorkflowVersionInputMatches(
  workflowVersion: WorkflowVersion & { readonly lock: JsonRecord },
  input: unknown,
): void {
  if (workflowVersion.lock.inputBinding !== "required") {
    return;
  }
  const inputHash = workflowVersion.lock.inputHash;
  if (typeof inputHash !== "string") {
    throw new CliUsageError("WorkflowVersion lock is missing inputHash.");
  }
  if (inputHash !== sha256Digest(input)) {
    throw new CliUsageError("WorkflowVersion inputHash does not match --input.");
  }
}

function lockDirectLwirWorkflowVersion(
  lwir: LwirWorkflow,
  input: unknown,
): WorkflowVersion & {
  readonly lwirVersionId: string;
  readonly lwirHash: string;
  readonly lock: JsonRecord;
} {
  const base = registerWorkflowVersion(lwir);
  const inputHash = sha256Digest(input);
  const plannedInputStructure = concreteInputStructure(input);
  const plannedInputStructureHash = sha256Digest(plannedInputStructure);
  const requestId = `orq_cli_${base.hash.slice("sha256:".length, "sha256:".length + 16)}`;
  const workflowDefinitionHash = sha256Digest({
    source: "little-cli.direct-lwir",
    lwirHash: base.hash,
  });
  const inputSchemaHash = sha256Digest(lwir.input.schema);
  const requestedOutput = { mode: "json", schema: lwir.output.schema };
  const requestedOutputHash = sha256Digest(requestedOutput);
  const capabilityManifest = {
    stepTypes: ALPHA_STEP_TYPES,
    toolSelection: "explicit_only",
    tools: [],
    models: [],
    modelSlots: [],
    secrets: lwir.permissions?.secrets ?? [],
    network: { default: "deny", allow: lwir.permissions?.network ?? [] },
  };
  const capabilityManifestHash = sha256Digest(capabilityManifest);
  const requestHash = sha256Digest({
    source: "little-cli.direct-lwir",
    requestId,
    lwirHash: base.hash,
    inputHash,
    workflowDefinitionHash,
    inputSchemaHash,
    requestedOutputHash,
    capabilityManifestHash,
  });
  const validationHash = computeCompilerValidationHash({
    canonicalizer: base.canonicalizer,
    lwirVersionId: base.id,
    lwirHash: base.hash,
    requestId,
    requestHash,
    inputHash,
    plannedInputStructureHash,
    workflowDefinitionHash,
    inputSchemaHash,
    requestedOutputHash,
    capabilityManifestHash,
  });
  const lockSeed: WorkflowVersionLockSeed = {
    lwirVersionId: base.id,
    lwirHash: base.hash,
    requestId,
    requestHash,
    inputHash,
    plannedInputStructure,
    plannedInputStructureHash,
    inputBinding: "required",
    workflowDefinitionHash,
    inputSchemaHash,
    requestedOutput,
    requestedOutputHash,
    capabilityManifest,
    capabilityManifestHash,
    modelSlots: [],
    tools: [],
    validationHash,
  };
  const identity = computeCompiledWorkflowVersionIdentity({
    canonicalizer: base.canonicalizer,
    lwirVersionId: base.id,
    lwirHash: base.hash,
    lockSeed,
  });
  const lock = {
    workflowVersionId: identity.workflowVersionId,
    workflowVersionHash: identity.workflowVersionHash,
    ...lockSeed,
  };
  return {
    ...base,
    id: identity.workflowVersionId,
    hash: identity.workflowVersionHash,
    lwirVersionId: lwirVersionIdForHash(base.hash),
    lwirHash: base.hash,
    lock,
  };
}

function isLockedWorkflowVersion(
  value: unknown,
): value is WorkflowVersion & {
  readonly lwirVersionId: string;
  readonly lwirHash: string;
  readonly lock: JsonRecord;
} {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.hash === "string" &&
    typeof value.canonicalizer === "string" &&
    typeof value.canonicalJson === "string" &&
    isRecord(value.lwir) &&
    typeof value.lwirVersionId === "string" &&
    typeof value.lwirHash === "string" &&
    isRecord(value.lock)
  );
}

function runSummary(result: RuntimeRunResult | RunResult<unknown>): JsonRecord {
  return stripUndefined({
    runId: result.runId,
    workflowVersionId: result.workflowVersionId,
    status: result.status,
    ...("output" in result ? { output: result.output } : {}),
    ...("error" in result ? { error: result.error } : {}),
    usage: result.usage,
    artifacts: result.artifacts,
    eventCount: result.events.length,
  });
}

function resolvePath(path: string, io: CliIo): string {
  return resolve(io.cwd ?? process.cwd(), path);
}

async function writeJsonLine(io: CliIo, value: unknown): Promise<void> {
  await writeStdout(io, `${JSON.stringify(value)}\n`);
}

async function writeStdout(io: CliIo, text: string): Promise<void> {
  await (io.stdout ?? ((value: string) => {
    process.stdout.write(value);
  }))(text);
}

async function writeStderr(io: CliIo, text: string): Promise<void> {
  await (io.stderr ?? ((value: string) => {
    process.stderr.write(value);
  }))(text);
}

function errorMessage(error: unknown): string {
  if (error instanceof CliUsageError) {
    return error.message;
  }
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}

function usage(): string {
  return [
    "Usage:",
    "  little setup [directory] [--template node|next|existing-next] [--here] [--workflow]",
    "  little init [name] [--with-harness] [--provider <id>] [--model <id>]",
    "  little add workflow <name> | little add harness",
    "  little validate <workflow.json>",
    "  little run <workflow.json> --input <input.json>",
    "  little test <workflow-folder-or-name> --input <input.json>",
    "  little events <run-id>",
    "  little replay <run-id>",
    "  little report <run-id> [--table]",
    "",
    "Options:",
    "  --data-dir <dir>  Local World directory (default: .little-workflow)",
    "  --json            Accepted for forward compatibility; JSON is the default",
    "  --table           Render `little report` as a table instead of JSON",
    "",
  ].join("\n");
}

function stripUndefined(value: JsonRecord): JsonRecord {
  const result: JsonRecord = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) {
      result[key] = item;
    }
  }
  return result;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
