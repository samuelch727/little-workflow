import { readFileSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import {
  providerDependency,
  renderAgentSource,
  resolveProvider,
  scaffoldAgent,
  scaffoldDependencyVersions,
} from "little-harness/scaffold";

type InitWorkflowProjectOptions = {
  readonly projectName?: string;
  readonly workflowName?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly force?: boolean;
  readonly here?: boolean;
  readonly withHarness?: {
    readonly agentName?: string;
    readonly provider?: string;
    readonly model?: string;
  };
};

type AddWorkflowOptions = {
  readonly workflowName: string;
  readonly dir?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly force?: boolean;
};

type AddHarnessOptions = {
  readonly agentName?: string;
  readonly workflowName?: string;
  readonly newWorkflowName?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly force?: boolean;
};

type LittleWorkflowManifest = {
  workflows?: Record<string, string>;
};

const DEFAULT_WORKFLOW_NAME = "candidate-review";
const DEFAULT_PROVIDER = "deepseek";
const PNPM_VERSION = "pnpm@10.27.0";
// The Local World event store's native binding; pnpm 10 skips dependency build scripts
// unless they are allow-listed, which leaves `require("better-sqlite3")` failing at run time.
const NATIVE_BUILD_DEPENDENCIES = ["better-sqlite3"];

/** Pin scaffolded projects to the CLI that wrote them, never to npm's `latest`. */
function littleWorkflowVersionRange(): string {
  // src/cli/ and dist/cli/ both sit two levels below the package root.
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
    readonly version: string;
  };
  return `^${pkg.version}`;
}

export async function initWorkflowProject(
  root: string,
  options: InitWorkflowProjectOptions = {},
): Promise<string[]> {
  if (!options.force && !options.here && await exists(root) && (await readdir(root)).length > 0) {
    throw new Error(`Target directory is not empty: ${root} (use --force to overwrite)`);
  }
  await mkdir(root, { recursive: true });
  const workflowName = options.workflowName ?? DEFAULT_WORKFLOW_NAME;
  const provider = options.provider ?? options.withHarness?.provider ?? DEFAULT_PROVIDER;
  const model = options.model ?? options.withHarness?.model;
  await assertInitTargetsAvailable(root, workflowName, options);
  const created: string[] = [];
  created.push(...await writeProjectFiles(root, {
    projectName: options.projectName ?? basename(root),
    workflowName,
    provider,
    includeHarness: options.withHarness !== undefined,
    force: options.force ?? false,
  }));
  created.push(...await addWorkflowToProject(root, {
    workflowName,
    provider,
    ...(model === undefined ? {} : { model }),
    force: options.force,
  }));
  if (options.withHarness !== undefined) {
    created.push(...await addHarnessToWorkflowProject(root, {
      agentName: options.withHarness.agentName ?? "support",
      workflowName,
      provider: options.withHarness.provider ?? options.provider ?? DEFAULT_PROVIDER,
      ...(options.withHarness.model ?? options.model) === undefined
        ? {}
        : { model: options.withHarness.model ?? options.model },
      force: options.force,
    }));
  }
  return unique(created);
}

async function assertInitTargetsAvailable(
  root: string,
  workflowName: string,
  options: InitWorkflowProjectOptions,
): Promise<void> {
  if (options.force) {
    return;
  }
  const workflowRoot = resolve(root, "workflows");
  assertWithinProject(root, workflowRoot, "Workflow directory");
  const workflowDir = join(workflowRoot, workflowName);
  assertWithinProject(root, workflowDir, "Workflow folder");
  await assertWorkflowSlotAvailable(root, workflowName, workflowDir);
  if (options.withHarness !== undefined) {
    const agentName = options.withHarness.agentName ?? "support";
    const agentsDir = await readHarnessAgentsDir(root);
    const shimPath = join(agentsDir, agentName, "workflows", `${workflowName}.ts`);
    assertWithinProject(root, shimPath, "Workflow shim");
    if (await exists(shimPath)) {
      throw new Error(`Workflow shim already exists: ${shimPath} (use --force to overwrite)`);
    }
  }
}

export async function addWorkflowToProject(
  root: string,
  options: AddWorkflowOptions,
): Promise<string[]> {
  assertSafeWorkflowName(options.workflowName);
  const workflowRoot = resolve(root, options.dir ?? "workflows");
  assertWithinProject(root, workflowRoot, "Workflow directory");
  const workflowDir = join(workflowRoot, options.workflowName);
  assertWithinProject(root, workflowDir, "Workflow folder");
  if (!options.force) {
    await assertWorkflowSlotAvailable(root, options.workflowName, workflowDir);
  }
  await mkdir(join(workflowDir, "tools"), { recursive: true });
  const provider = resolveProvider(options.provider ?? DEFAULT_PROVIDER);
  const model = options.model ?? provider.defaultModel;
  const writes: ReadonlyArray<readonly [string, string]> = [
    [join(workflowDir, "workflow.ts"), workflowSource(options.workflowName, provider.id, model)],
    [join(workflowDir, "instructions.md"), workflowInstructions(options.workflowName)],
    [join(workflowDir, "tools", "echo.ts"), echoToolSource()],
  ];
  for (const [path, contents] of writes) {
    await writeFile(path, contents);
  }
  const manifestPath = await updateWorkflowManifest(root, options.workflowName, workflowDir);
  return [manifestPath, ...writes.map(([path]) => path)];
}

export async function addHarnessToWorkflowProject(
  root: string,
  options: AddHarnessOptions,
): Promise<string[]> {
  if (options.workflowName !== undefined && options.newWorkflowName !== undefined) {
    throw new Error("Choose either --workflow or --new-workflow, not both.");
  }
  const agentName = options.agentName ?? "support";
  assertSafeWorkflowName(agentName);
  const created: string[] = [];
  const workflowName = options.newWorkflowName ?? options.workflowName;
  if (workflowName === undefined) {
    throw new Error("A workflow name is required for harness scaffolding.");
  }
  assertSafeWorkflowName(workflowName);
  if (options.newWorkflowName !== undefined) {
    created.push(...await addWorkflowToProject(root, {
      workflowName: options.newWorkflowName,
      provider: options.provider ?? DEFAULT_PROVIDER,
      ...(options.model === undefined ? {} : { model: options.model }),
      force: options.force,
    }));
  } else {
    const manifest = await readManifest(root);
    if (manifest.workflows?.[workflowName] === undefined) {
      throw new Error(`Unknown workflow '${workflowName}' in little-workflow.json.`);
    }
  }

  const harnessMarker = join(root, "little-harness.json");
  const hasHarnessMarker = await exists(harnessMarker);
  if (!hasHarnessMarker) {
    await writeFile(harnessMarker, `${JSON.stringify({ agents: "agents" }, null, 2)}\n`);
    created.push(harnessMarker);
  }
  const agentsDir = await readHarnessAgentsDir(root);
  await mkdir(agentsDir, { recursive: true });
  const agentDir = join(agentsDir, agentName);
  if (options.force || !(await exists(agentDir))) {
    created.push(...await scaffoldAgent(agentsDir, agentName, {
      force: options.force ?? false,
      provider: options.provider ?? DEFAULT_PROVIDER,
      ...(options.model === undefined ? {} : { model: options.model }),
    }));
  }
  const shimPath = await writeWorkflowShim(root, agentsDir, agentName, workflowName, options.force ?? false);
  created.push(shimPath);
  await updatePackageJson(root, {
    includeHarness: true,
    provider: options.provider ?? DEFAULT_PROVIDER,
    model: options.model,
    workflowName,
    agentName,
  });
  return unique(created);
}

async function writeProjectFiles(
  root: string,
  options: {
    readonly projectName: string;
    readonly workflowName: string;
    readonly provider: string;
    readonly includeHarness: boolean;
    readonly force: boolean;
  },
): Promise<string[]> {
  await mkdir(root, { recursive: true });
  const packagePath = await updatePackageJson(root, {
    includeHarness: options.includeHarness,
    provider: options.provider,
    workflowName: options.workflowName,
    agentName: "support",
    projectName: options.projectName,
  });
  const writes: ReadonlyArray<readonly [string, string]> = [
    [join(root, "tsconfig.json"), tsconfigSource(options.includeHarness)],
    [join(root, ".gitignore"), gitignoreSource()],
    [join(root, "input.example.json"), `${JSON.stringify({ value: "hello" }, null, 2)}\n`],
  ];
  const created = [packagePath];
  for (const [path, contents] of writes) {
    if (options.force || !(await exists(path))) {
      await writeFile(path, contents);
      created.push(path);
    }
  }
  return created;
}

async function assertWorkflowSlotAvailable(root: string, workflowName: string, workflowDir: string): Promise<void> {
  if (await exists(workflowDir)) {
    throw new Error(`Workflow folder already exists: ${workflowDir} (use --force to overwrite)`);
  }
  const manifest = await readManifest(root);
  const existing = manifest.workflows?.[workflowName];
  const relativePath = `./${relative(root, workflowDir).split(/[\\/]+/u).join("/")}`;
  if (existing !== undefined && existing !== relativePath) {
    throw new Error(
      `Workflow '${workflowName}' is already registered at ${existing} (use --force to overwrite)`,
    );
  }
}

async function updatePackageJson(
  root: string,
  options: {
    readonly includeHarness: boolean;
    readonly provider: string;
    readonly model?: string;
    readonly workflowName: string;
    readonly agentName: string;
    readonly projectName?: string;
  },
): Promise<string> {
  const packagePath = join(root, "package.json");
  const existing = await readJsonFile<Record<string, any>>(packagePath, {});
  const provider = resolveProvider(options.provider);
  const versions = scaffoldDependencyVersions();
  const dependencies = {
    ...(existing.dependencies ?? {}),
    "little-workflow": littleWorkflowVersionRange(),
    ai: versions.ai,
    zod: versions.zod,
  };
  if (options.includeHarness) {
    dependencies["little-harness"] = versions.littleHarness;
  }
  const providerPackage = providerDependency(provider);
  if (providerPackage !== undefined) {
    dependencies[providerPackage[0]] = providerPackage[1];
  }
  const existingPnpm = existing.pnpm ?? {};
  const onlyBuiltDependencies = [
    ...new Set([...(existingPnpm.onlyBuiltDependencies ?? []), ...NATIVE_BUILD_DEPENDENCIES]),
  ];
  const scripts = {
    ...(existing.scripts ?? {}),
    "test:workflow": `little test ${options.workflowName} --input input.example.json`,
    ...(options.includeHarness ? { "test:agent": `little-harness test ${options.agentName}` } : {}),
    typecheck: "tsc --noEmit",
  };
  const next = {
    name: existing.name ?? options.projectName ?? basename(root),
    type: existing.type ?? "module",
    private: existing.private ?? true,
    ...existing,
    scripts,
    dependencies,
    devDependencies: {
      ...(existing.devDependencies ?? {}),
      ...versions.devDependencies,
    },
    pnpm: { ...existingPnpm, onlyBuiltDependencies },
    packageManager: existing.packageManager ?? PNPM_VERSION,
  };
  await writeFile(packagePath, `${JSON.stringify(next, null, 2)}\n`);
  return packagePath;
}

async function updateWorkflowManifest(root: string, name: string, workflowDir: string): Promise<string> {
  const manifestPath = join(root, "little-workflow.json");
  const manifest = await readJsonFile<LittleWorkflowManifest>(manifestPath, {});
  const relativePath = `./${relative(root, workflowDir).split(/[\\/]+/u).join("/")}`;
  const next: LittleWorkflowManifest = {
    ...manifest,
    workflows: {
      ...(manifest.workflows ?? {}),
      [name]: relativePath,
    },
  };
  await writeFile(manifestPath, `${JSON.stringify(next, null, 2)}\n`);
  return manifestPath;
}

async function readManifest(root: string): Promise<LittleWorkflowManifest> {
  return readJsonFile(join(root, "little-workflow.json"), {});
}

async function readHarnessAgentsDir(root: string): Promise<string> {
  const marker = await readJsonFile<{ agents?: unknown }>(join(root, "little-harness.json"), {});
  const agents = typeof marker.agents === "string" && marker.agents.length > 0 ? marker.agents : "agents";
  const agentsDir = resolve(root, agents);
  assertWithinProject(root, agentsDir, "Harness agents directory");
  return agentsDir;
}

async function workflowDirFromManifest(root: string, workflowName: string): Promise<string> {
  const manifest = await readManifest(root);
  const manifestValue = manifest.workflows?.[workflowName];
  if (manifestValue === undefined) {
    throw new Error(`Unknown workflow '${workflowName}' in little-workflow.json.`);
  }
  const workflowDir = resolve(root, manifestValue);
  assertWithinProject(root, workflowDir, "Workflow manifest path");
  return workflowDir;
}

async function writeWorkflowShim(
  root: string,
  agentsDir: string,
  agentName: string,
  workflowName: string,
  force: boolean,
): Promise<string> {
  const shimDir = join(agentsDir, agentName, "workflows");
  await mkdir(shimDir, { recursive: true });
  const shimPath = join(shimDir, `${workflowName}.ts`);
  if (!force && await exists(shimPath)) {
    throw new Error(`Workflow shim already exists: ${shimPath} (use --force to overwrite)`);
  }
  const workflowDir = await workflowDirFromManifest(root, workflowName);
  const workflowUrl = relative(dirname(shimPath), workflowDir).split(/[\\/]+/u).join("/");
  await writeFile(shimPath, `import { loadWorkflow } from "little-workflow";

export default await loadWorkflow(
  new URL("${workflowUrl}", import.meta.url),
  {
    executionMode: "durable",
    allowUntypedInput: true,
  },
);
`);
  return shimPath;
}

async function readJsonFile<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return fallback;
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

function workflowSource(workflowName: string, providerId: string, modelId: string): string {
  const provider = resolveProvider(providerId);
  const id = workflowName.replace(/-/gu, ".");
  const inputSchema = {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
    additionalProperties: false,
  };
  return `import { createLittleWorkflow, model } from "little-workflow";
import { ${provider.exportName} } from "${provider.importModule}";

export default createLittleWorkflow({
  id: ${JSON.stringify(id)},
  description: ${JSON.stringify(`Starter workflow for ${workflowName}.`)},
  inputSchema: ${JSON.stringify(inputSchema, null, 4).replace(/^/gmu, "  ").trimStart()},
  models: [model(${provider.exportName}(${JSON.stringify(modelId)}))],
  globalTools: ["echo"],
  planner: {
    model: ${provider.exportName}(${JSON.stringify(modelId)}),
    system: "Create a short plan that calls the echo tool.",
    harness: {
      harnessId: "starter-workflow-planner@1.0.0",
      async run() {
        return {
          kind: "plan",
          lwir: {
            apiVersion: "littleworkflow.dev/v0.1",
            kind: "Workflow",
            metadata: { name: ${JSON.stringify(id)} },
            input: { schema: ${JSON.stringify(inputSchema, null, 14).replace(/^/gmu, "            ").trimStart()} },
            output: { schema: true },
            permissions: { models: [], tools: ["echo"], secrets: [], network: [] },
            steps: [
              {
                id: "echo",
                uses: "tool.call",
                with: { tool: "echo", args: {} },
                output: { mode: "json", schema: true },
              },
            ],
          },
        };
      },
    },
  },
});
`;
}

function workflowInstructions(workflowName: string): string {
  return `You are running the ${workflowName} workflow.

Replace this file with task-specific planning instructions.
`;
}

function echoToolSource(): string {
  return `export default {
  description: "Return a small starter response.",
  inputSchema: true,
  execute: async () => ({ ok: true }),
};
`;
}

function tsconfigSource(includeHarness: boolean): string {
  return `${JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      forceConsistentCasingInFileNames: true,
      noEmit: true,
    },
    include: includeHarness ? ["workflows/**/*.ts", "agents/**/*.ts"] : ["workflows/**/*.ts"],
  }, null, 2)}\n`;
}

function gitignoreSource(): string {
  return `node_modules
dist
.env
.little-workflow
.little-harness
`;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function assertSafeWorkflowName(name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(name) || name.includes("..") || name.includes("/") || name.includes("\\")) {
    throw new Error(`Invalid workflow or agent name: ${name}`);
  }
}

function assertWithinProject(root: string, path: string, label: string): void {
  const absoluteRoot = resolve(root);
  const absolutePath = resolve(path);
  const prefix = absoluteRoot.endsWith("/") ? absoluteRoot : `${absoluteRoot}/`;
  if (absolutePath !== absoluteRoot && !absolutePath.startsWith(prefix)) {
    throw new Error(`${label} escapes the project root: ${path}`);
  }
}
