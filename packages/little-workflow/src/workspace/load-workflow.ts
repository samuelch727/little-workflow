import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildRunWorkflowOptions,
  createLittleWorkflow,
  inlineToolRegistryFor,
  type ErgonomicRunWorkflowOptions,
  type RunResult,
  type WorkflowDefinition,
} from "../authoring.js";
import { sha256Digest } from "../canonical.js";
import { asHarnessWorkflow, toHarnessWorkflowInputSchemaMarker } from "../harness-workflow.js";
import { runWorkflow as runWorkflowCore } from "../runtime.js";
import type { Skill } from "../skills.js";
import { createToolRegistry, type AiSdkTool, type ToolRegistry } from "../tool-registry.js";
import { getWorkflowDefinitionHash } from "../workflow-definition-hash.js";
import { discoverSkills } from "./discover-skills.js";
import { discoverTools } from "./discover-tools.js";
import { hashImportGraph } from "./import-graph.js";
import { importDefault } from "./module-loader.js";
import type {
  HarnessWorkflow,
  HarnessWorkflowDefinitionIdentity,
  HarnessWorkflowInputSchema,
} from "little-harness";

export type WorkflowExecutionMode = "inline" | "durable";
export type WorkflowSourceIdentity = string;
export type LoadedWorkflowRunOptions = ErgonomicRunWorkflowOptions;

export type LoadWorkflowOptions = {
  readonly workspaceRoot?: string | URL;
  readonly executionMode?: WorkflowExecutionMode;
  readonly allowUntypedInput?: boolean;
  readonly allowLossyStandardSchema?: boolean;
  readonly sourceIdentity?: WorkflowSourceIdentity;
};

export type LoadedWorkflow<TInput = unknown, TOutput = unknown> = HarnessWorkflow & {
  readonly id: string;
  readonly description?: string;
  readonly inputSchema?: HarnessWorkflowInputSchema;
  readonly executionMode: WorkflowExecutionMode;
  readonly definitionIdentity: HarnessWorkflowDefinitionIdentity;
  readonly sourceIdentity?: WorkflowSourceIdentity;
  readonly workflow: WorkflowDefinition<TInput, TOutput>;
  readonly tools: ToolRegistry;
  readonly source: {
    readonly type: "folder";
    readonly folder: string;
    readonly workspaceRoot: string;
    readonly workflow: string;
    readonly instructionsPath?: string;
    readonly toolFiles: readonly string[];
    readonly skillDirs: readonly string[];
  };
  run(input: TInput, options?: LoadedWorkflowRunOptions): Promise<RunResult<TOutput>>;
};

type WorkflowModuleExport = WorkflowDefinition | LoadedWorkflow;

export async function loadWorkflow<TInput = unknown, TOutput = unknown>(
  folder: string | URL,
  options: LoadWorkflowOptions = {},
): Promise<LoadedWorkflow<TInput, TOutput>> {
  const workflowDir = normalizeFolder(folder);
  const workspaceRoot = await chooseWorkspaceRoot(workflowDir, options.workspaceRoot);
  const workflowPath = join(workflowDir, "workflow.ts");
  const exported = await importDefault<WorkflowModuleExport>(workflowPath, workspaceRoot);
  const [instructions, discoveredTools, discoveredSkills] = await Promise.all([
    readInstructions(workflowDir),
    discoverTools(workflowDir, workspaceRoot),
    discoverSkills(workflowDir, workspaceRoot),
  ]);
  const hasSiblingComposition = instructions !== undefined ||
    discoveredTools.registry.names().length > 0 ||
    discoveredSkills.skills.length > 0;

  if (isLoadedWorkflow(exported) && !hasSiblingComposition && optionsCompatibleWithLoaded(exported, options)) {
    return withHarnessAdapter(exported as LoadedWorkflow<TInput, TOutput>, {
      workflow: exported.workflow as WorkflowDefinition<TInput, TOutput>,
      tools: exported.tools,
      executionMode: exported.executionMode,
      definitionIdentity: exported.definitionIdentity,
      inputSchema: exported.inputSchema,
      allowUntypedInput: options.allowUntypedInput,
      allowLossyStandardSchema: options.allowLossyStandardSchema,
    });
  }

  const exportedSourceIdentity = isLoadedWorkflow(exported) ? exported.sourceIdentity : sourceIdentityFrom(exported);
  if (
    options.sourceIdentity !== undefined &&
    exportedSourceIdentity !== undefined &&
    options.sourceIdentity !== exportedSourceIdentity
  ) {
    throw new Error(
      `loadWorkflow sourceIdentity mismatch: option '${options.sourceIdentity}' differs from workflow export '${exportedSourceIdentity}'.`,
    );
  }
  const sourceIdentity = options.sourceIdentity ?? exportedSourceIdentity;
  const executionMode = options.executionMode ?? (isLoadedWorkflow(exported) ? exported.executionMode : "inline");

  const baseWorkflow = isLoadedWorkflow(exported) ? exported.workflow : exported;
  const tools = mergeToolRegistries(
    isLoadedWorkflow(exported) ? exported.tools : inlineToolRegistryFor(baseWorkflow) ?? createToolRegistry(),
    discoveredTools.registry,
  );
  const workflow = mergeWorkflow(baseWorkflow, {
    instructions,
    skills: discoveredSkills.skills,
    toolNames: discoveredTools.registry.names(),
  }) as WorkflowDefinition<TInput, TOutput>;

  const graph = await hashImportGraph({
    workspaceRoot,
    entries: [
      workflowPath,
      ...discoveredTools.modulePaths,
      ...discoveredSkills.modulePaths,
      ...discoveredSkills.sourcePaths,
      ...(instructions === undefined ? [] : [join(workflowDir, "instructions.md")]),
    ],
    ...(sourceIdentity === undefined ? {} : { sourceIdentity }),
  });
  if (executionMode === "durable" && sourceIdentity === undefined && graph.hasDynamicOrUnresolvedLocal) {
    throw new Error(
      "loadWorkflow durable mode requires sourceIdentity when dynamic imports or unresolved local imports are present.",
    );
  }

  const inputSchema = toHarnessWorkflowInputSchemaMarker(workflow.inputSchema, {
    allowUntypedInput: options.allowUntypedInput === true,
    allowLossyStandardSchema: options.allowLossyStandardSchema === true,
  });
  const definitionIdentity = sha256Digest({
    workflow: getWorkflowDefinitionHash({ ...workflow, inputSchema }, tools),
    graph: graph.hash,
    executionMode,
    sourceIdentity: sourceIdentity ?? "",
    innerDefinitionIdentity: isLoadedWorkflow(exported) ? exported.definitionIdentity : "",
  });
  const adapter = asHarnessWorkflow(workflow as unknown as WorkflowDefinition, {
    executionMode,
    definitionIdentity,
    allowUntypedInput: options.allowUntypedInput === true,
    allowLossyStandardSchema: options.allowLossyStandardSchema === true,
    tools,
  });

  return {
    id: workflow.id,
    ...(workflow.description === undefined ? {} : { description: workflow.description }),
    inputSchema: adapter.inputSchema,
    executionMode,
    definitionIdentity,
    ...(sourceIdentity === undefined ? {} : { sourceIdentity }),
    workflow,
    tools,
    source: {
      type: "folder",
      folder: workflowDir,
      workspaceRoot,
      workflow: workflowPath,
      ...(instructions === undefined ? {} : { instructionsPath: join(workflowDir, "instructions.md") }),
      toolFiles: discoveredTools.modulePaths,
      skillDirs: discoveredSkills.skillDirs,
    },
    run(input: TInput, runOptions?: LoadedWorkflowRunOptions) {
      const { tools: runTools, ...rest } = runOptions ?? {};
      return runWorkflowCore(
        buildRunWorkflowOptions(workflow, input, {
          tools: runTools ?? tools,
          ...rest,
        }),
      ) as Promise<RunResult<TOutput>>;
    },
    runForHarness: adapter.runForHarness,
  };
}

function normalizeFolder(folder: string | URL): string {
  const path = typeof folder === "string" ? folder : fileURLToPath(folder);
  return resolve(path);
}

async function chooseWorkspaceRoot(folder: string, explicit: string | URL | undefined): Promise<string> {
  if (explicit !== undefined) return normalizeFolder(explicit);
  const littleWorkflowRoot = await nearestAncestor(folder, "little-workflow.json");
  if (littleWorkflowRoot !== undefined) return littleWorkflowRoot;
  const packageRoot = await nearestAncestor(folder, "package.json");
  return packageRoot ?? folder;
}

async function nearestAncestor(start: string, marker: string): Promise<string | undefined> {
  let dir = start;
  while (true) {
    if (await exists(join(dir, marker))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readInstructions(workflowDir: string): Promise<string | undefined> {
  try {
    const text = (await readFile(join(workflowDir, "instructions.md"), "utf8")).trim();
    return text.length === 0 ? undefined : text;
  } catch {
    return undefined;
  }
}

function optionsCompatibleWithLoaded(loaded: LoadedWorkflow, options: LoadWorkflowOptions): boolean {
  if (options.executionMode !== undefined && options.executionMode !== loaded.executionMode) return false;
  if (options.sourceIdentity !== undefined && options.sourceIdentity !== loaded.sourceIdentity) return false;
  if (hasOwnOption(options, "allowUntypedInput") || hasOwnOption(options, "allowLossyStandardSchema")) {
    const requested = toHarnessWorkflowInputSchemaMarker(loaded.workflow.inputSchema, {
      allowUntypedInput: options.allowUntypedInput === true,
      allowLossyStandardSchema: options.allowLossyStandardSchema === true,
    });
    if (sha256Digest(requested) !== sha256Digest(loaded.inputSchema)) return false;
  }
  return options.workspaceRoot === undefined;
}

function withHarnessAdapter<TInput, TOutput>(
  loaded: LoadedWorkflow<TInput, TOutput>,
  options: {
    readonly workflow: WorkflowDefinition<TInput, TOutput>;
    readonly tools: ToolRegistry;
    readonly executionMode: WorkflowExecutionMode;
    readonly definitionIdentity: HarnessWorkflowDefinitionIdentity;
    readonly inputSchema?: HarnessWorkflowInputSchema;
    readonly allowUntypedInput?: boolean;
    readonly allowLossyStandardSchema?: boolean;
  },
): LoadedWorkflow<TInput, TOutput> {
  if (typeof loaded.runForHarness === "function") return loaded;
  const adapter = asHarnessWorkflow(options.workflow as unknown as WorkflowDefinition, {
    executionMode: options.executionMode,
    definitionIdentity: options.definitionIdentity,
    allowUntypedInput: options.allowUntypedInput,
    allowLossyStandardSchema: options.allowLossyStandardSchema,
    tools: options.tools,
  });
  return {
    ...loaded,
    inputSchema: options.inputSchema ?? loaded.inputSchema ?? adapter.inputSchema,
    runForHarness: adapter.runForHarness,
  };
}

function mergeToolRegistries(inner: ToolRegistry, outer: ToolRegistry): ToolRegistry {
  const merged = createToolRegistry(inner.toRecord());
  for (const name of outer.names()) {
    const tool = outer.get(name);
    if (tool === undefined) continue;
    const existing = merged.get(name);
    if (existing !== undefined) {
      if (existing !== tool) {
        throw new Error(`Tool '${name}' is already registered with a different implementation.`);
      }
      continue;
    }
    merged.register(name, tool);
  }
  return merged;
}

function mergeWorkflow(
  workflow: WorkflowDefinition,
  outer: {
    readonly instructions?: string;
    readonly skills: readonly Skill[];
    readonly toolNames: readonly string[];
  },
): WorkflowDefinition {
  const plannerSkills = mergeSkills(workflow.planner.skills ?? [], outer.skills);
  const globalTools = uniqueStrings([...(workflow.globalTools ?? []), ...outer.toolNames]);
  return createLittleWorkflow({
    ...workflow,
    planner: {
      ...workflow.planner,
      ...(workflow.planner.system === undefined && outer.instructions !== undefined
        ? { system: outer.instructions }
        : {}),
      ...(plannerSkills.length === 0 ? {} : { skills: plannerSkills }),
    },
    ...(globalTools.length === 0 ? {} : { globalTools }),
  }) as WorkflowDefinition;
}

function mergeSkills(inner: readonly Skill[], outer: readonly Skill[]): readonly Skill[] {
  const merged: Skill[] = [...inner];
  const seen = new Set(inner.map(skillIdentityKey));
  for (const entry of outer) {
    const key = skillIdentityKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(entry);
  }
  return merged;
}

function skillIdentityKey(entry: Skill): string {
  return `${entry.name ?? ""}\0${entry.frontmatterHash ?? ""}\0${entry.source}`;
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function isLoadedWorkflow(value: unknown): value is LoadedWorkflow {
  return isRecord(value) &&
    typeof value.id === "string" &&
    isDefinitionIdentity(value.definitionIdentity) &&
    isRecord(value.workflow) &&
    isRecord(value.tools) &&
    typeof value.run === "function";
}

function isDefinitionIdentity(value: unknown): value is HarnessWorkflowDefinitionIdentity {
  return typeof value === "string" ||
    (isRecord(value) && value.notApplicable === true);
}

function sourceIdentityFrom(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const sourceIdentity = value.sourceIdentity;
  return typeof sourceIdentity === "string" ? sourceIdentity : undefined;
}

function hasOwnOption<TKey extends keyof LoadWorkflowOptions>(
  options: LoadWorkflowOptions,
  key: TKey,
): boolean {
  return Object.prototype.hasOwnProperty.call(options, key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (typeof value === "object" || typeof value === "function") && value !== null;
}
