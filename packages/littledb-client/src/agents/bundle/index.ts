/**
 * Builds a Little Harness agent folder into one module the LittleDB runtime loads: `agent.ts`,
 * `instructions.md`, `tools/`, `skills/`, `workflows/` and `schedules/`, discovered the way
 * `loadHarness` discovers them, but at build time, since a deployment has no filesystem to
 * discover from. Little Harness, the LittleDB client, AI SDK and Zod are not bundled: the
 * runtime provides them, so a deployment is mostly the developer's own code.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import * as esbuild from "esbuild";
import { parseSandboxSpec, type AgentManifest, type JsonSchema, type ManifestTool, type SandboxSpec, type ScheduleSpec } from "../protocol.js";
import { sharedModules, workerdBuildOptions, workerdBuiltins, workerdStubs } from "./plugins.js";
import { compilerInputs, packageInputs, resolutionInputs, TraversalInputs } from "./provenance.js";

export type BundleResult = {
  /** The agent's name: the folder's name unless given. */
  readonly name: string;
  /** The module the runtime loads as `agent.js`. */
  readonly bundle: string;
  readonly manifest: AgentManifest;
  readonly warnings: readonly string[];
  /** Real source, resolution metadata and embedded-text paths; excludes runtime-provided packages. */
  readonly inputs: readonly string[];
  /** Link entries used to reach the canonical inputs, retained for Git status. */
  readonly traversals: readonly string[];
  /** Searched configuration/manifest locations; absence alone is not dirtiness. */
  readonly searchPaths: readonly string[];
  /** Whether the available metadata could be inspected; never a complete native read set. */
  readonly provenanceInspected: boolean;
};

const SOURCE = /\.(ts|mts|js|mjs)$/;
export const IGNORED_DIRS: ReadonlySet<string> = new Set(["node_modules", ".git", ".little-harness", ".littledb", "dist"]);
export const AGENT_ENTRY_FILES = ["agent.ts", "agent.mts", "agent.js", "agent.mjs"] as const;
const MAX_SKILL_BYTES = 2_000_000;

export async function bundleAgent(folder: string, options: { name?: string | undefined } = {}): Promise<BundleResult> {
  const dir = resolve(folder);
  const agentFile = AGENT_ENTRY_FILES.map((file) => join(dir, file)).find((file) => existsSync(file));
  if (agentFile === undefined) throw new Error(`${dir} is not an agent folder: it has no agent.ts.`);
  const warnings: string[] = [];

  const tools = await sourceFiles(join(dir, "tools"));
  const workflows = await sourceFiles(join(dir, "workflows"));
  const schedules = await sourceFiles(join(dir, "schedules"));
  const skills = await discoverSkills(join(dir, "skills"), warnings);
  const instructions = await readText(join(dir, "instructions.md"));

  const imports: string[] = [`import * as agent_module from ${JSON.stringify(agentFile)};`];
  const toolEntries: string[] = [];
  tools.forEach((file, index) => {
    imports.push(`import tool_${index} from ${JSON.stringify(file)};`);
    toolEntries.push(`${JSON.stringify(stem(file))}: tool_${index}`);
  });
  const workflowEntries: string[] = [];
  workflows.forEach((file, index) => {
    imports.push(`import workflow_${index} from ${JSON.stringify(file)};`);
    workflowEntries.push(`workflow_${index}`);
  });
  const scheduleEntries: string[] = [];
  schedules.forEach((file, index) => {
    imports.push(`import schedule_${index} from ${JSON.stringify(file)};`);
    scheduleEntries.push(`${JSON.stringify(stem(file))}: schedule_${index}`);
  });
  const skillEntries: string[] = [];
  skills.forEach((skill, index) => {
    if (skill.module !== undefined) {
      imports.push(`import skill_${index} from ${JSON.stringify(skill.module)};`);
      skillEntries.push(`skill_${index}`);
    } else {
      skillEntries.push(JSON.stringify({ name: skill.name, files: skill.files }));
    }
  });
  const entry =
    `${imports.join("\n")}\n` +
    `export default { harness: agent_module.default, managed: agent_module.managed, sandbox: agent_module.sandbox, tools: { ${toolEntries.join(", ")} }, skills: [${skillEntries.join(", ")}], workflows: [${workflowEntries.join(", ")}], schedules: { ${scheduleEntries.join(", ")} }` +
    `${instructions === undefined ? "" : `, instructions: ${JSON.stringify(instructions)}`} };\n`;

  const built = await esbuild.build({
    ...workerdBuildOptions(),
    absWorkingDir: dir,
    metafile: true,
    stdin: { contents: entry, resolveDir: dir, loader: "js", sourcefile: "little-agent-entry.js" },
    write: false,
    outfile: join(dir, "agent.js"),
    plugins: [sharedModules(), workerdBuiltins(), workerdStubs()],
    logLevel: "silent",
  }).catch((error: unknown) => {
    throw new Error(`Building ${basename(dir)} failed:\n${formatEsbuildError(error)}`);
  });
  const bundle = built.outputFiles[0]!.text;

  const graphDir = realpathSync(dir);
  const codeInputs = Object.keys(built.metafile!.inputs).map((file) => resolve(graphDir, file)).filter(existsSync);
  const textInputs = [
    ...(instructions === undefined ? [] : [join(dir, "instructions.md")]),
    ...skills.flatMap((skill) => Object.keys(skill.files ?? {}).map((file) => join(dir, "skills", skill.name, file))),
  ];
  const compiler = compilerInputs([join(graphDir, "little-agent-entry.js"), ...codeInputs]);
  const resolution = await resolutionInputs(dir, built.metafile!);
  const packages = packageInputs([join(graphDir, "little-agent-entry.js"), ...codeInputs, ...resolution.routes, ...compiler.inputs]);
  const searchPaths = [...new Set([...compiler.searchPaths, ...packages.searchPaths])];
  const paths = new TraversalInputs();
  const traversals = [...new Set([dir, ...resolution.routes, ...textInputs, ...compiler.inputs, ...packages.inputs].flatMap((file) => paths.links(file)))];
  const inspected = await inspectFolder(dir, agentFile, entry, schedules, warnings);
  const manifest: AgentManifest = {
    format: 1,
    tools: inspected.tools,
    skills: skills.map((skill) => skill.name),
    schedules: inspected.schedules,
    workflows: workflows.map(stem),
    instructions: instructions !== undefined,
    ...(inspected.managed ? { managed: true } : {}),
    ...(inspected.sandbox === undefined ? {} : { sandbox: inspected.sandbox }),
    sdk: { harness: packageVersion(dir, "@little-stack/harness"), ai: packageVersion(dir, "ai") },
    files: await hashFolder(dir),
  };
  const inputs = [...new Set([...codeInputs, ...textInputs, ...compiler.inputs, ...packages.inputs].map((file) => realpathSync(file)))];
  const provenanceInspected = resolution.complete && compiler.complete;
  if (!provenanceInspected) warnings.push("Could not inspect available resolution metadata for Git provenance.");
  return { name: options.name ?? basename(dir).toLowerCase(), bundle, manifest, warnings, inputs, traversals, searchPaths, provenanceInspected };
}

/**
 * The tools as the model sees them (name, description and JSON Schema), whether the agent has
 * managed settings, and the container it asks for. Read by loading the folder in Node once (as
 * `little-harness dev` would), from a separate Node build of the entry.
 */
async function inspectFolder(
  dir: string,
  agentFile: string,
  entry: string,
  scheduleFiles: readonly string[],
  warnings: string[],
): Promise<{ tools: ManifestTool[]; managed: boolean; sandbox: SandboxSpec | undefined; schedules: ScheduleSpec[] }> {
  // Timer errors must refuse deployment even when the agent cannot load to describe its tools.
  const schedules = await inspectSchedules(dir, scheduleFiles);
  const scratch = await mkdtemp(join(tmpdir(), "little-agent-"));
  try {
    const built = await esbuild.build({
      stdin: { contents: entry, resolveDir: dir, loader: "js", sourcefile: "little-agent-inspect.js" },
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node22",
      packages: "external",
      write: false,
      outfile: join(scratch, "inspect.mjs"),
      logLevel: "silent",
    });
    // Write next to the folder so its bare imports resolve from its node_modules.
    const file = join(dir, `.little-agent-inspect-${randomUUID()}.mjs`);
    await writeFile(file, built.outputFiles[0]!.text);
    let definition: { default: { harness: { config?: { tools?: Record<string, unknown> } }; tools: Record<string, unknown>; managed?: unknown; sandbox?: unknown } };
    try {
      definition = await import(pathToFileURL(file).href);
    } finally {
      await rm(file, { force: true });
    }
    const all = { ...definition.default.tools, ...(definition.default.harness?.config?.tools ?? {}) };
    if (definition.default.harness?.config === undefined) throw new Error("agent.ts must default-export createHarness(...).");
    const managed = definition.default.managed;
    if (managed !== undefined) {
      const bootstrap = (managed as { bootstrap?: unknown } | null)?.bootstrap;
      if (bootstrap === null || typeof bootstrap !== "object" || Array.isArray(bootstrap)) {
        throw new Error("agent.ts's `managed` export must be { bootstrap: { ... } }: the settings LittleDB starts from.");
      }
    }
    const sandbox = sandboxSpec(definition.default.sandbox);
    const { asSchema } = (await import(pathToFileURL(createRequire(join(dir, "package.json")).resolve("ai")).href)) as typeof import("ai");
    const out: ManifestTool[] = [];
    for (const [name, value] of Object.entries(all)) {
      const tool = value as { description?: string; inputSchema?: unknown; execute?: unknown };
      let inputSchema: JsonSchema | undefined;
      try {
        inputSchema = tool.inputSchema === undefined ? undefined : ((await asSchema(tool.inputSchema as never).jsonSchema) as JsonSchema);
      } catch {
        warnings.push(`Could not read ${name}'s input schema.`);
      }
      out.push({ name, kind: typeof tool.execute === "function" ? "server" : "client", ...(tool.description === undefined ? {} : { description: tool.description }), ...(inputSchema === undefined ? {} : { inputSchema }) });
    }
    return { tools: out, managed: managed !== undefined, sandbox, schedules };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("agent.ts")) throw error;
    warnings.push(`Could not load the folder to list its tools: ${error instanceof Error ? error.message : String(error)}`);
    // Still say whether it has managed settings, so its experiments run, and which container it asks for.
    const source = await readFile(agentFile, "utf8").catch(() => "");
    const declared = /export\s+(const|let|var)\s+sandbox\b/.test(source);
    if (declared && /\b(hosts|internet)\s*:/.test(source)) {
      // Guessing the network rules from the source could lock out a host the agent needs.
      throw new Error(`agent.ts's \`sandbox\` export sets the machine's network, which needs the folder to load: ${error instanceof Error ? error.message : String(error)}`);
    }
    const instanceType = /instanceType\s*:\s*["']([\w-]+)["']/.exec(source)?.[1];
    const sandbox = declared
      ? sandboxSpec({ ...(instanceType === undefined ? {} : { instanceType }), ...(/snapshots\s*:\s*true\b/.test(source) ? { snapshots: true } : {}) })
      : undefined;
    return { tools: [], managed: /export\s+(const|let|var)\s+managed\b/.test(source), sandbox, schedules };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** Load each module separately so an import-time validation error names the schedule file. */
async function inspectSchedules(dir: string, files: readonly string[]): Promise<ScheduleSpec[]> {
  if (files.length === 0) return [];
  const require = createRequire(join(dir, "package.json"));
  const { isHarnessSchedule } = await import(pathToFileURL(require.resolve("@little-stack/harness/internals")).href) as typeof import("@little-stack/harness/internals");
  const { defineSchedule } = await import(pathToFileURL(require.resolve("@little-stack/harness")).href) as typeof import("@little-stack/harness");
  const seen = new Set<string>();
  const specs: ScheduleSpec[] = [];
  for (const source of files) {
    const name = `schedules/${basename(source)}`;
    const id = stem(source);
    const output = join(dir, `.little-agent-inspect-${randomUUID()}.mjs`);
    try {
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id)) throw new Error("Schedule file names must be 1-64 letters, digits, '-' or '_', starting with a letter or digit.");
      if (seen.has(id)) throw new Error(`Schedule id ${JSON.stringify(id)} is defined by more than one file.`);
      seen.add(id);
      const built = await esbuild.build({ entryPoints: [source], bundle: true, format: "esm", platform: "node", target: "node22", packages: "external", write: false, logLevel: "silent" });
      await writeFile(output, built.outputFiles[0]!.text);
      const loaded = (await import(pathToFileURL(output).href)) as { default?: unknown };
      if (!isHarnessSchedule(loaded.default)) throw new Error("A schedule file must default-export defineSchedule({ ... }).");
      // Check again in case a module modified the object after defineSchedule returned it.
      const schedule = defineSchedule(loaded.default);
      if (schedule.session.length > 200 || schedule.session.includes("\0")) throw new Error("A schedule's session must be 1-200 characters without NUL.");
      if (typeof schedule.catchUp !== "boolean") throw new Error("A schedule's catchUp must be true or false.");
      if (schedule.description !== undefined && typeof schedule.description !== "string") throw new Error("A schedule's description must be text.");
      if (schedule.type !== undefined) throw new Error("Input Type schedules aren't supported on managed agents yet.");
      specs.push({ id, cron: schedule.cron, timezone: schedule.timezone, session: schedule.session, catchUp: schedule.catchUp, kind: "prompt", ...(schedule.description === undefined ? {} : { description: schedule.description }) });
    } catch (error) {
      throw new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await rm(output, { force: true });
    }
  }
  return specs;
}

/** `agent.ts`'s `sandbox` export, checked and in manifest form (see {@link parseSandboxSpec}). */
function sandboxSpec(value: unknown): SandboxSpec | undefined {
  if (value === undefined) return undefined;
  try {
    return parseSandboxSpec(value);
  } catch (error) {
    throw new Error(`agent.ts's \`sandbox\` export: ${error instanceof Error ? error.message : String(error)}`);
  }
}

type DiscoveredSkill = { name: string; module?: string; files?: Record<string, string> };

async function discoverSkills(skillsDir: string, warnings: string[]): Promise<DiscoveredSkill[]> {
  const entries = await readdir(skillsDir, { withFileTypes: true }).catch(() => []);
  const skills: DiscoveredSkill[] = [];
  for (const entry of entries.filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const dir = join(skillsDir, entry.name);
    const module = ["skill.ts", "skill.mts", "skill.js", "skill.mjs"].map((file) => join(dir, file)).find((file) => existsSync(file));
    if (module !== undefined) {
      skills.push({ name: entry.name, module });
      continue;
    }
    if (!existsSync(join(dir, "SKILL.md"))) continue;
    const files: Record<string, string> = {};
    let bytes = 0;
    for (const file of await walk(dir)) {
      const content = await readFile(file);
      bytes += content.length;
      if (bytes > MAX_SKILL_BYTES) {
        warnings.push(`Skill ${entry.name} is over 2 MB; the rest of its files were left out.`);
        break;
      }
      // Skills are text; anything that is not UTF-8 is left out.
      const text = content.toString("utf8");
      if (text.includes("�")) continue;
      files[relative(dir, file).split(sep).join("/")] = text;
    }
    skills.push({ name: entry.name, files });
  }
  return skills;
}

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir).catch(() => [] as string[]);
  return entries
    .filter((entry) => SOURCE.test(entry) && !/\.(test|spec)\.[^.]+$/.test(entry) && !entry.endsWith(".d.ts"))
    .sort()
    .map((entry) => join(dir, entry));
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith(".little-agent-inspect")) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(path)));
    else if (entry.isFile()) out.push(path);
  }
  return out.sort();
}

async function hashFolder(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const file of await walk(dir)) {
    if ((await stat(file)).size > 5_000_000) continue;
    out[relative(dir, file).split(sep).join("/")] = createHash("sha256").update(await readFile(file)).digest("hex").slice(0, 16);
  }
  return out;
}

async function readText(file: string): Promise<string | undefined> {
  try {
    const text = (await readFile(file, "utf8")).trim();
    return text.length > 0 ? text : undefined;
  } catch {
    return undefined;
  }
}

function packageVersion(dir: string, name: string): string | undefined {
  try {
    const require = createRequire(join(dir, "package.json"));
    return (require(`${name}/package.json`) as { version?: string }).version;
  } catch {
    return undefined;
  }
}

function stem(file: string): string {
  return basename(file).replace(SOURCE, "");
}

function formatEsbuildError(error: unknown): string {
  const errors = (error as { errors?: { text: string; location?: { file: string; line: number } | null }[] }).errors;
  if (errors === undefined) return error instanceof Error ? error.message : String(error);
  return errors.map((e) => `  ${e.location ? `${e.location.file}:${e.location.line}: ` : ""}${e.text}`).join("\n");
}
