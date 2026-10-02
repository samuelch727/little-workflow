import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ToolSet } from "ai";
import type { CliIo } from "../cli-core.js";
import {
  discoverConnectors,
  loadConnectorDescriptor,
  loadConnectorToolExtensions,
} from "../connectors/discovery.js";
import {
  applyConnectorToolPolicy,
  resolveConnectorTools,
  type ConnectorToolPolicy,
} from "../connectors/tool-extensions.js";
import { rejectReservedDiscoveredToolNames } from "../workspace/tool-name-policy.js";
import { loadHarness, loadWorkspace } from "../workspace/index.js";
import { scaffoldAgent as writeAgent, scaffoldProject } from "./agent-scaffold.js";
import {
  CUSTOM_MODEL_CHOICE,
  modelChoices,
  providerEnvVars,
  providerChoices,
  resolveModelChoice,
  resolveProvider,
  type ProviderDefinition,
  type ProviderId,
} from "./provider-catalog.js";
import { runRepl } from "./repl.js";
import { providerDependency } from "./scaffold-versions.js";

type PromptAnswers = {
  customModel?: string;
  projectName?: string;
  provider?: string;
  model?: string;
  install?: boolean;
};

type AgentCommandIo = CliIo & {
  prompts?: PromptAnswers;
  isTTY?: boolean;
  install?: (cwd: string) => Promise<void>;
};

function cwdOf(io: CliIo): string {
  return io.cwd ?? process.cwd();
}
async function out(io: CliIo, text: string): Promise<void> {
  await (io.stdout ?? ((t: string) => void process.stdout.write(t)))(text);
}
async function err(io: CliIo, text: string): Promise<void> {
  await (io.stderr ?? ((t: string) => void process.stderr.write(t)))(text);
}
function positionals(args: readonly string[]): string[] {
  return args.filter((a) => !a.startsWith("-"));
}

export async function initCommand(args: readonly string[], io: AgentCommandIo): Promise<number> {
  try {
    const parsed = parseInitArgs(args);
    const answers = await resolveInitAnswers(parsed, io);
    const provider = resolveProvider(answers.provider);
    const targetRoot = parsed.here ? cwdOf(io) : join(cwdOf(io), answers.projectName);
    const projectName = parsed.here ? basename(targetRoot) : answers.projectName;
    const created = await scaffoldProject(targetRoot, {
      allowNonEmpty: parsed.here,
      force: parsed.force,
      projectName,
      provider: provider.id,
      ...(answers.model === undefined ? {} : { model: answers.model }),
    });
    if (answers.install) {
      await runInstall(targetRoot, io);
    }
    await out(io, formatInitComplete({
      createdCount: created.length,
      ...(parsed.here ? {} : { cdTarget: answers.projectName }),
      envVars: providerEnvVars(provider),
      installSkipped: !answers.install,
    }));
    return 0;
  } catch (error) {
    await err(io, `${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

export async function newCommand(args: readonly string[], io: AgentCommandIo): Promise<number> {
  const parsed = parseAgentArgs(args);
  const name = parsed.positionals[0];
  if (name === undefined) {
    await err(io, "Usage: little-harness new <name> [--provider <provider>] [--model <model>] [--force]\n");
    return 1;
  }
  try {
    const provider = resolveProvider(parsed.provider ?? "anthropic");
    const { agentsDir } = await loadWorkspace(cwdOf(io));
    const created = await writeAgent(agentsDir, name, {
      force: parsed.force,
      provider: provider.id,
      ...(parsed.model === undefined ? {} : { model: parsed.model }),
    });
    await addProviderDependency(cwdOf(io), provider);
    await out(io, `Created agent '${name}' (${created.length} files). Try: little-harness test ${name}\n`);
    return 0;
  } catch (error) {
    await err(io, `${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

type InitArgs = {
  positionals: string[];
  provider?: string;
  model?: string;
  yes: boolean;
  noInstall: boolean;
  here: boolean;
  force: boolean;
};

type AgentArgs = {
  positionals: string[];
  provider?: string;
  model?: string;
  force: boolean;
};

function parseInitArgs(args: readonly string[]): InitArgs {
  const parsed = parseKnownOptions(args, new Set(["provider", "model"]));
  return {
    positionals: parsed.positionals,
    ...(parsed.options.provider === undefined ? {} : { provider: parsed.options.provider }),
    ...(parsed.options.model === undefined ? {} : { model: parsed.options.model }),
    yes: parsed.flags.has("yes"),
    noInstall: parsed.flags.has("no-install"),
    here: parsed.flags.has("here"),
    force: parsed.flags.has("force"),
  };
}

function parseAgentArgs(args: readonly string[]): AgentArgs {
  const parsed = parseKnownOptions(args, new Set(["provider", "model"]));
  return {
    positionals: parsed.positionals,
    ...(parsed.options.provider === undefined ? {} : { provider: parsed.options.provider }),
    ...(parsed.options.model === undefined ? {} : { model: parsed.options.model }),
    force: parsed.flags.has("force"),
  };
}

function parseKnownOptions(args: readonly string[], valueOptions: ReadonlySet<string>): {
  positionals: string[];
  options: Record<string, string | undefined>;
  flags: Set<string>;
} {
  const positionals: string[] = [];
  const options: Record<string, string | undefined> = {};
  const flags = new Set<string>();

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (!arg.startsWith("-")) {
      positionals.push(arg);
      continue;
    }
    if (!arg.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`);
    }

    const eqIndex = arg.indexOf("=");
    const key = arg.slice(2, eqIndex === -1 ? undefined : eqIndex);
    if (valueOptions.has(key)) {
      const value = eqIndex === -1 ? args[index + 1] : arg.slice(eqIndex + 1);
      if (!value || value.startsWith("-")) throw new Error(`--${key} requires a value.`);
      options[key] = value;
      if (eqIndex === -1) index += 1;
      continue;
    }
    flags.add(key);
  }

  return { positionals, options, flags };
}

async function resolveInitAnswers(parsed: InitArgs, io: AgentCommandIo): Promise<{
  projectName: string;
  provider: string;
  model: string;
  install: boolean;
}> {
  const prompts = io.prompts;
  const tty = io.isTTY ?? Boolean(process.stdin.isTTY);
  const promptable = prompts !== undefined || tty;
  const positionalProjectName = parsed.positionals[0];
  if (parsed.positionals.length > 1) {
    throw new Error("Usage: little-harness init [name] [--provider <provider>] [--model <model>] [--yes] [--no-install] [--here] [--force]");
  }

  let projectName = positionalProjectName ?? prompts?.projectName;
  if (!parsed.here && projectName === undefined) {
    if (!promptable) {
      throw new Error("Usage: little-harness init <name> [--provider <provider>] [--model <model>] [--yes] [--no-install] [--force]");
    }
    projectName = await promptInput("Project name", "support-agents", io);
  }
  if (!parsed.here) {
    projectName = validateProjectName(projectName);
  }
  if (!promptable && !parsed.yes && parsed.provider === undefined) {
    throw new Error("Non-interactive init requires --provider or --yes.");
  }

  const provider = parsed.provider ?? prompts?.provider ?? (
    parsed.yes ? "anthropic" : await promptProvider(io)
  );
  const resolvedProvider = resolveProvider(provider);
  const model = resolveModelChoice(
    resolvedProvider.id,
    parsed.model ?? prompts?.model ?? (parsed.yes ? undefined : await promptModel(resolvedProvider.id, io)),
  );
  const install = parsed.noInstall ? false : (
    parsed.yes ? true : prompts?.install ?? (promptable ? await promptConfirm("Install dependencies with pnpm now?", true, io) : false)
  );

  return {
    projectName: projectName ?? basename(cwdOf(io)),
    provider: resolvedProvider.id,
    model,
    install,
  };
}

async function promptInput(message: string, defaultValue: string, io: AgentCommandIo): Promise<string> {
  if (io.prompts?.projectName !== undefined) return io.prompts.projectName;
  const prompts = await loadInquirerPrompts();
  return prompts.input({ message, default: defaultValue });
}

async function promptProvider(io: AgentCommandIo): Promise<string> {
  if (io.prompts?.provider !== undefined) return io.prompts.provider;
  return promptSearchOrSelect("Provider", providerChoices(), "anthropic", io);
}

async function promptModel(provider: ProviderId, io: AgentCommandIo): Promise<string> {
  if (io.prompts?.model !== undefined) {
    return io.prompts.model === CUSTOM_MODEL_CHOICE ? promptCustomModel(io) : io.prompts.model;
  }
  const choices = modelChoices(provider);
  const selected = await promptSearchOrSelect("Model", choices, choices[0]?.value ?? "", io, true);
  if (selected === CUSTOM_MODEL_CHOICE) {
    return promptCustomModel(io);
  }
  return selected;
}

async function promptConfirm(message: string, defaultValue: boolean, io: AgentCommandIo): Promise<boolean> {
  if (io.prompts?.install !== undefined) return io.prompts.install;
  const prompts = await loadInquirerPrompts();
  return prompts.confirm({ message, default: defaultValue });
}

async function promptSearchOrSelect(
  message: string,
  choices: Array<{ name: string; value: string; description?: string }>,
  defaultValue: string,
  _io: AgentCommandIo,
  allowCustom = false,
): Promise<string> {
  const prompts = await loadInquirerPrompts();
  if (typeof prompts.search === "function") {
    return prompts.search({
      message,
      source: (input?: string) => {
        const rawInput = input?.trim() ?? "";
        const query = rawInput.toLowerCase();
        const filtered = query.length === 0
          ? choices
          : choices.filter((choice) => (
            choice.name.toLowerCase().includes(query) || choice.value.toLowerCase().includes(query)
          ));
        if (allowCustom && rawInput.length > 0 && choices.every((choice) => choice.value !== rawInput)) {
          return [...filtered, { name: `Use "${rawInput}"`, value: rawInput }];
        }
        return filtered;
      },
    });
  }
  return prompts.select({ message, choices, default: defaultValue });
}

async function promptCustomModel(io: AgentCommandIo): Promise<string> {
  if (io.prompts?.customModel !== undefined) return io.prompts.customModel;
  const prompts = await loadInquirerPrompts();
  return prompts.input({ message: "Custom model id" });
}

async function loadInquirerPrompts(): Promise<{
  input: (config: { message: string; default?: string }) => Promise<string>;
  select: (config: { message: string; choices: Array<{ name: string; value: string; description?: string }>; default?: string }) => Promise<string>;
  confirm: (config: { message: string; default?: boolean }) => Promise<boolean>;
  search?: (config: {
    message: string;
    source: (input?: string) => Array<{ name: string; value: string; description?: string }>;
  }) => Promise<string>;
}> {
  const dynamicImport = new Function("specifier", "return import(specifier)") as (
    specifier: string,
  ) => Promise<{
    input: (config: { message: string; default?: string }) => Promise<string>;
    select: (config: { message: string; choices: Array<{ name: string; value: string; description?: string }>; default?: string }) => Promise<string>;
    confirm: (config: { message: string; default?: boolean }) => Promise<boolean>;
    search?: (config: {
      message: string;
      source: (input?: string) => Array<{ name: string; value: string; description?: string }>;
    }) => Promise<string>;
  }>;
  return await dynamicImport("@inquirer/prompts");
}

async function runInstall(cwd: string, io: AgentCommandIo): Promise<void> {
  if (io.install !== undefined) {
    await io.install(cwd);
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn("pnpm", ["install"], { cwd, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`pnpm install failed with exit code ${code ?? "unknown"}`));
    });
  });
}

async function addProviderDependency(root: string, provider: ProviderDefinition): Promise<void> {
  const providerPackage = providerDependency(provider);
  if (providerPackage === undefined) {
    return;
  }
  const packagePath = join(root, "package.json");
  let packageJson: Record<string, unknown>;
  try {
    packageJson = JSON.parse(await readFile(packagePath, "utf8")) as Record<string, unknown>;
  } catch {
    return;
  }
  const dependencies = isRecord(packageJson.dependencies) ? packageJson.dependencies : {};
  if (dependencies[providerPackage[0]] === undefined) {
    packageJson.dependencies = {
      ...dependencies,
      [providerPackage[0]]: providerPackage[1],
    };
    await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatInitComplete(options: {
  createdCount: number;
  cdTarget?: string;
  envVars: string[];
  installSkipped: boolean;
}): string {
  const lines = [`Initialized Little Harness project (${options.createdCount} files).`];
  if (options.cdTarget !== undefined) {
    lines.push(`Next: cd ${options.cdTarget}`);
  }
  if (options.installSkipped) {
    lines.push(`${options.cdTarget === undefined ? "Next" : "Then"}: pnpm install`);
  }
  lines.push(`Set ${options.envVars.join(", ")} in your environment.`);
  lines.push("Run: pnpm little-harness test support");
  return `${lines.join("\n")}\n`;
}

function validateProjectName(projectName: string | undefined): string {
  const trimmed = projectName?.trim();
  if (!trimmed) {
    throw new Error("Project name is required.");
  }
  return trimmed;
}

export type ConnectorReplTools = {
  /** Descriptor tools merged with folder extensions — the raw set handed to the REPL/streamHarness. */
  connectorTools: ToolSet;
  toolPolicy?: ConnectorToolPolicy;
  kind: string;
  /** The model-facing tool names after execute-filtering and the descriptor's allow/deny policy. */
  toolNames: string[];
};

/**
 * Reproduce the exact per-connector toolset a `load*Connector` run presents, for the REPL and for
 * `test --connector`'s printed inventory. Mirrors the loaders' `mergeConnectorTools`:
 * descriptor-carried tools (validated against the reserved-name policy) FIRST, then
 * folder-discovered `connectors/<id>/tools/*` extensions (which win per name). The merged set is
 * execute-filtered by `resolveConnectorTools` and narrowed by the descriptor's allow/deny policy to
 * compute the printed inventory, while the raw merged set is what the REPL forwards as
 * `connectorTools`. Previously this omitted the descriptor's own `tools`, so descriptor-carried
 * tools never appeared in the inventory or the REPL.
 */
export async function resolveConnectorReplTools(
  agentDir: string,
  connectorId: string,
  baseTools: ToolSet,
): Promise<ConnectorReplTools> {
  const descriptor = await loadConnectorDescriptor(agentDir, connectorId);
  const descriptorTools = descriptor.tools;
  if (descriptorTools !== undefined) {
    rejectReservedDiscoveredToolNames(Object.keys(descriptorTools));
  }
  const folderExtensions = await loadConnectorToolExtensions(agentDir, connectorId, baseTools);
  const connectorTools: ToolSet = { ...(descriptorTools ?? {}), ...folderExtensions };
  const resolvedTools = applyConnectorToolPolicy(
    resolveConnectorTools(baseTools, connectorTools),
    descriptor.toolPolicy,
  );
  return {
    connectorTools,
    ...(descriptor.toolPolicy === undefined ? {} : { toolPolicy: descriptor.toolPolicy }),
    kind: descriptor.kind,
    toolNames: Object.keys(resolvedTools).sort(),
  };
}

export async function testCommand(args: readonly string[], _dataDir: string, io: CliIo): Promise<number> {
  let parsed: ReturnType<typeof parseKnownOptions>;
  try {
    parsed = parseKnownOptions(args, new Set(["connector"]));
  } catch (error) {
    await err(io, `${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  const name = parsed.positionals[0];
  if (name === undefined) {
    await err(io, "Usage: little-harness test <name> [--connector <id>]\n");
    return 1;
  }
  const { agents } = await loadWorkspace(cwdOf(io));
  const agent = agents.find((a) => a.name === name);
  if (agent === undefined) {
    const available = agents.map((a) => a.name).join(", ") || "(none)";
    await err(io, `Unknown agent '${name}'. Available: ${available}\n`);
    return 1;
  }
  const harness = await loadHarness(agent.dir);
  const replOpts: Parameters<typeof runRepl>[3] = {};
  const connectorId = parsed.options.connector;
  if (connectorId !== undefined) {
    try {
      const inventory = await resolveConnectorReplTools(agent.dir, connectorId, harness.config.tools);
      replOpts.connectorTools = inventory.connectorTools;
      if (inventory.toolPolicy !== undefined) {
        replOpts.toolPolicy = inventory.toolPolicy;
      }
      await out(
        io,
        `Connector '${connectorId}' (${inventory.kind}) tools: ${inventory.toolNames.length > 0 ? inventory.toolNames.join(", ") : "(none)"}\n`,
      );
    } catch (error) {
      await err(io, `${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
  }
  await out(io, `Chatting with '${name}'. Type :exit to quit, :reset to clear the conversation.\n`);
  await runRepl(harness, io, readLineFromStdin(), replOpts);
  return 0;
}

export async function connectorsCommand(args: readonly string[], _dataDir: string, io: CliIo): Promise<number> {
  const name = positionals(args)[0];
  if (name === undefined) {
    await err(io, "Usage: little-harness connectors <name>\n");
    return 1;
  }
  const { agents } = await loadWorkspace(cwdOf(io));
  const agent = agents.find((a) => a.name === name);
  if (agent === undefined) {
    const available = agents.map((a) => a.name).join(", ") || "(none)";
    await err(io, `Unknown agent '${name}'. Available: ${available}\n`);
    return 1;
  }

  const skipped: Array<{ id: string; path: string; error: unknown }> = [];
  let discovered: Awaited<ReturnType<typeof discoverConnectors>>;
  try {
    // A flat `connectors/<id>.ts` helper that fails to load is skipped (not fatal) and reported
    // here; a broken nested connector folder is a hard error that rejects and exits non-zero.
    discovered = await discoverConnectors(agent.dir, { onSkip: (entry) => skipped.push(entry) });
  } catch (error) {
    await err(io, `${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  if (discovered.length === 0) {
    await out(io, `No connectors found for '${name}'.\n`);
  } else {
    await out(io, `Connectors for '${name}':\n`);
    for (const connector of discovered) {
      await out(io, `  ${connector.id}  ${connector.kind}  ${connector.path}\n`);
    }
  }

  if (skipped.length > 0) {
    await out(io, `\nSkipped connector candidates:\n`);
    for (const entry of skipped) {
      const reason = entry.error instanceof Error ? entry.error.message : String(entry.error);
      await out(io, `  ${entry.id}  ${entry.path}  ${reason}\n`);
    }
  }

  return 0;
}

function readLineFromStdin(): () => Promise<string | null> {
  const rl = createInterface({ input: process.stdin });
  const iterator = rl[Symbol.asyncIterator]();
  return async () => {
    const { value, done } = await iterator.next();
    if (done === true) {
      rl.close();
      return null;
    }
    return value as string;
  };
}
