import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { parse, type ParseError } from "jsonc-parser";
import semver from "semver";
import { providerDependency, resolveModelChoice, resolveProvider, scaffoldAgent, scaffoldDependencyVersions } from "little-harness/scaffold";
import { agentSource, nextFiles, smokeSource } from "./setup-templates.js";
import { digest, readText, STATE, type SetupPlan } from "./setup-transaction.js";

export type SetupOptions = {
  template: "node" | "next" | "existing-next";
  provider: string;
  model?: string;
  workflow: boolean;
  packageManager?: "npm" | "pnpm" | "yarn";
  route: string;
  page: string;
};
type Json = Record<string, any>;
type SetupState = { schema: 1; options: SetupOptions; hashes: Record<string, string> };
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const ownVersion = () => (JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }).version;
const LOCKS = { npm: "package-lock.json", pnpm: "pnpm-lock.yaml", yarn: "yarn.lock" } as const;

async function readObject(root: string, path: string, jsonc = false): Promise<Json | undefined> {
  const text = await readText(root, path);
  if (text === null) return undefined;
  let value: unknown;
  if (jsonc) {
    const errors: ParseError[] = [];
    value = parse(text, errors, { allowTrailingComma: true });
    if (errors.length) throw new Error(`Invalid JSON/JSONC: ${path}`);
  } else {
    try { value = JSON.parse(text); } catch { throw new Error(`Invalid JSON: ${path}`); }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Expected JSON object: ${path}`);
  return value as Json;
}
async function isDir(root: string, path: string): Promise<boolean> {
  try { return (await stat(join(root, path))).isDirectory(); } catch { return false; }
}
export async function detectPackageManager(root: string, pkg: Json, requested?: SetupOptions["packageManager"]): Promise<NonNullable<SetupOptions["packageManager"]>> {
  const locks: string[] = [];
  for (const [manager, path] of Object.entries(LOCKS)) if (await readText(root, path) !== null) locks.push(manager);
  if (await readText(root, "npm-shrinkwrap.json") !== null && !locks.includes("npm")) locks.push("npm");
  if (locks.length > 1) throw new Error(`Multiple lockfiles (${locks.join(", ")}); resolve the package-manager conflict first.`);
  const declared = typeof pkg.packageManager === "string" ? pkg.packageManager.split("@")[0] : undefined;
  if (declared && !["npm", "pnpm", "yarn"].includes(declared)) throw new Error(`Unsupported packageManager: ${pkg.packageManager}`);
  if (locks[0] && declared && locks[0] !== declared) throw new Error("packageManager disagrees with the lockfile.");
  const detected = locks[0] ?? declared;
  if (requested && detected && requested !== detected) throw new Error(`Use ${detected}: --package-manager ${requested} conflicts with this project.`);
  return (requested ?? detected ?? "npm") as NonNullable<SetupOptions["packageManager"]>;
}

export async function planSetup(rootInput: string, input: SetupOptions): Promise<SetupPlan & { options: SetupOptions }> {
  const root = resolve(rootInput);
  if (Number(process.versions.node.split(".")[0]) < 22) throw new Error("Little setup requires Node.js >=22.");
  if (!/^(api\/)[a-zA-Z0-9_/-]+$/.test(input.route) || input.route.split("/").some(x => !x || x === "." || x === "..")) throw new Error("--route must be a plain App Router path such as api/little/chat.");
  if (!/^[a-zA-Z0-9_/-]+$/.test(input.page) || input.page.split("/").some(x => !x || x === "." || x === "..")) throw new Error("--page must be a plain App Router path such as little.");
  const oldState = await readObject(root, STATE) as SetupState | undefined;
  if (oldState && (oldState.schema !== 1 || !oldState.options || !oldState.hashes)) throw new Error(`Invalid ${STATE}.`);
  if (await readText(root, ".little/setup-transaction.json") !== null) throw new Error("Interrupted setup detected. Inspect .little/setup-transaction.json, then run little setup --here --rollback.");
  let pkg = await readObject(root, "package.json");
  const existing = input.template === "existing-next";
  if (existing && !pkg) throw new Error("Existing Next.js mode needs package.json at the project root.");
  if (!existing && !oldState) {
    let entries: string[] = [];
    try { entries = await readdir(root); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (entries.length) throw new Error("New-project target must be empty. Use --here --template existing-next for an existing Next.js app.");
  }
  pkg ??= { name: basename(root).toLowerCase().replace(/[^a-z0-9._-]/g, "-"), private: true, type: "module", engines: { node: ">=22" } };
  for (const field of ["scripts", "dependencies", "devDependencies", "peerDependencies", "engines"]) {
    if (pkg[field] !== undefined && (!pkg[field] || typeof pkg[field] !== "object" || Array.isArray(pkg[field]))) throw new Error(`package.json ${field} must be an object.`);
  }
  const packageManager = await detectPackageManager(root, pkg, input.packageManager);
  const options = { template: input.template, provider: input.provider, model: resolveModelChoice(input.provider, input.model), workflow: input.workflow, packageManager, route: input.route, page: input.page };
  if (oldState && JSON.stringify(oldState.options) !== JSON.stringify(options)) throw new Error("Setup options differ from the previous run. Keep its template/provider/workflow/paths or integrate changes manually; generated files are never replaced implicitly.");
  const plan: SetupPlan & { options: SetupOptions } = { root, files: [], conflicts: [], warnings: [], options };
  const desired: Record<string, string> = {};
  const versions = scaffoldDependencyVersions();
  const provider = resolveProvider(options.provider);
  const dependencies: Record<string, string> = { "little-harness": versions.littleHarness, ai: versions.ai, zod: versions.zod };
  if (options.workflow) dependencies["little-workflow"] = `^${ownVersion()}`;
  const providerPkg = providerDependency(provider);
  if (providerPkg) dependencies[providerPkg[0]] = providerPkg[1];
  const dev = { ...versions.devDependencies };
  let app = "src/app";
  let agents = input.template === "node" ? "agents" : "src/agents";
  if (input.template !== "node") {
    dependencies["@ai-sdk/react"] = "^4.0.129";
    dependencies["server-only"] = "^0.0.1";
    if (existing) {
      const next = pkg.dependencies?.next ?? pkg.devDependencies?.next;
      if (typeof next !== "string" || !semver.subset(next, ">=15 <17")) throw new Error("Existing mode supports Next.js 15/16 App Router. Resolve its Next version explicitly first.");
      const src = await isDir(root, "src/app"), plain = await isDir(root, "app");
      if (src === plain) throw new Error("Expected exactly one App Router directory: app/ or src/app/.");
      app = src ? "src/app" : "app";
      agents = src ? "src/agents" : "agents";
      if (!await readText(root, "tsconfig.json")) throw new Error("Existing mode requires a TypeScript Next.js app (tsconfig.json).");
      const tsconfig = await readObject(root, "tsconfig.json", true);
      plan.warnings.push(`App Router: ${app}; aliases: ${Object.keys(tsconfig?.compilerOptions?.paths ?? {}).join(", ") || "none"}. Generated imports are relative.`);
      const react = pkg.dependencies?.react ?? pkg.devDependencies?.react;
      if (!react || !semver.subset(react, ">=18 <20")) throw new Error("Existing Next app needs a compatible React 18/19 range.");
    } else {
      dependencies.next = "^16.3.8";
      dependencies.react = "^19.2.7";
      dependencies["react-dom"] = "^19.2.7";
      dev["@types/react"] = "^19.2.0";
      dev["@types/react-dom"] = "^19.2.0";
      desired[`${app}/layout.tsx`] = 'import type { ReactNode } from "react";\nexport default function RootLayout({ children }: { children: ReactNode }) { return <html lang="en"><body>{children}</body></html>; }\n';
      desired[`${app}/page.tsx`] = `import Link from "next/link";\nexport default function Home() { return <main><h1>Little</h1><Link href="/${options.page}">Open keyless chat</Link></main>; }\n`;
      // Preserve arbitrary existing configs: only the fresh template owns a Next config.
      desired["next.config.ts"] = 'import type { NextConfig } from "next";\nconst config: NextConfig = { serverExternalPackages: ["little-harness", "little-workflow", "better-sqlite3"] };\nexport default config;\n';
      pkg.scripts = { dev: "next dev", build: "next build", start: "next start", ...pkg.scripts };
    }
    if (existing) {
      for (const [folder, name] of [[options.route, "route"], [options.page, "page"]]) {
        for (const ext of ["js", "jsx", "tsx", "ts"]) {
          const candidate = `${app}/${folder}/${name}.${ext}`;
          if (candidate === `${app}/${options.route}/route.ts` || candidate === `${app}/${options.page}/page.tsx`) continue;
          if (await readText(root, candidate) !== null) plan.conflicts.push(`${candidate}: existing route/page conflicts with generated ${name}. Choose a different path.`);
        }
        const opposite = name === "route" ? "page" : "route";
        for (const ext of ["js", "jsx", "tsx", "ts"]) {
          const candidate = `${app}/${folder}/${opposite}.${ext}`;
          if (await readText(root, candidate) !== null) plan.conflicts.push(`${candidate}: Next does not allow a page and route in the same segment.`);
        }
      }
    }
    const files = nextFiles(app, agents, options.route, options.page);
    if (existing) delete files["next-env.d.ts"];
    Object.assign(desired, files);
  }
  if (pkg.engines?.node && !semver.satisfies(process.versions.node, pkg.engines.node)) throw new Error(`Current Node ${process.versions.node} does not satisfy project engines.node ${pkg.engines.node}.`);
  for (const [name, range] of Object.entries(dependencies)) {
    const prior = pkg.dependencies?.[name] ?? pkg.devDependencies?.[name] ?? pkg.peerDependencies?.[name];
    if (prior) {
      if (typeof prior !== "string" || !semver.validRange(prior) || !semver.subset(prior, range, { includePrerelease: true })) {
        plan.conflicts.push(`Dependency ${name}: existing ${String(prior)}; required ${range}. Resolve explicitly; setup never upgrades existing dependencies.`);
      }
    } else pkg.dependencies = { ...pkg.dependencies, [name]: range };
  }
  for (const [name, range] of Object.entries(dev)) {
    if (!pkg.dependencies?.[name] && !pkg.devDependencies?.[name]) pkg.devDependencies = { ...pkg.devDependencies, [name]: range };
  }
  pkg.scripts = { ...pkg.scripts };
  for (const [name, command] of Object.entries({ "little:smoke": "tsx scripts/little-smoke.ts", "little:agent": "little-harness test support", "little:typecheck": "tsc --noEmit -p tsconfig.little.json" })) {
    if (pkg.scripts[name] !== undefined && pkg.scripts[name] !== command) plan.conflicts.push(`Script ${name} already exists. Rename it or integrate the generated command manually.`);
    else pkg.scripts[name] = command;
  }
  if (options.workflow && packageManager === "pnpm") {
    // No workspace/YAML edits or policy broadening. The exact package is an explicit install flag.
    plan.warnings.push("Workflow install needs --allow-native-build to compile only better-sqlite3; all other lifecycle scripts remain disabled.");
  }
  if (!existing && !pkg.packageManager) pkg.packageManager = { npm: "npm@10.9.8", pnpm: "pnpm@10.27.0", yarn: "yarn@1.22.22" }[packageManager];
  desired["package.json"] = json(pkg);
  const harness = await readObject(root, "little-harness.json");
  if (harness?.agents !== undefined && harness.agents !== agents) plan.conflicts.push(`little-harness.json already points to ${harness.agents}; expected ${agents}.`);
  desired["little-harness.json"] = json({ ...harness, agents });
  const staging = await mkdtemp(join(tmpdir(), "little-setup-"));
  try {
    await scaffoldAgent(staging, "support", { provider: options.provider, model: options.model });
    desired[`${agents}/support/instructions.md`] = (await readText(staging, "support/instructions.md"))!;
    desired[`${agents}/support/tools/echo.ts`] = (await readText(staging, "support/tools/echo.ts"))!;
  } finally { await rm(staging, { recursive: true, force: true }); }
  for (const [path, text] of Object.entries(agentSource(options.provider, options.model!, options.workflow))) desired[`${agents}/support/${path}`] = text;
  desired["scripts/little-smoke.ts"] = smokeSource(agents, options.workflow);
  desired["tsconfig.little.json"] = json({
    ...(existing ? { extends: "./tsconfig.json" } : {}),
    compilerOptions: { target: "ES2022", module: input.template === "node" ? "NodeNext" : "ESNext", moduleResolution: input.template === "node" ? "NodeNext" : "Bundler", strict: true, allowImportingTsExtensions: true, types: ["node"], skipLibCheck: true, esModuleInterop: true, noEmit: true, ...(input.template === "node" ? {} : { jsx: "react-jsx" }) },
    include: [`${agents}/**/*.ts`, "scripts/little-smoke.ts", ...(input.template === "node" ? [] : [`${app}/${options.route}/route.ts`, `${app}/${options.page}/**/*`, "next-env.d.ts"])], exclude: ["node_modules"],
  });
  if (!existing) desired["tsconfig.json"] = json({ extends: "./tsconfig.little.json", compilerOptions: { ...(input.template === "node" ? {} : { plugins: [{ name: "next" }], isolatedModules: true, resolveJsonModule: true }) }, include: ["**/*.ts", "**/*.tsx", ".next/types/**/*.ts"], exclude: ["node_modules"] });
  const ignore = await readText(root, ".gitignore") ?? "";
  const ignores = ["node_modules/", ".next/", ".little-harness/", ".little-workflow/", ".little/setup-transaction.json", ".env", ".env.local"];
  desired[".gitignore"] = ignore + (ignore && !ignore.endsWith("\n") ? "\n" : "") + ignores.filter(x => !ignore.split(/\r?\n/).includes(x)).map(x => `${x}\n`).join("");
  const envVars = provider.envVars ?? [provider.apiKeyEnvVar];
  desired[".env.little.example"] = `# Keyless by default. Explicit LITTLE_DEMO=0 enables real calls and charges.\nLITTLE_DEMO=1\n${envVars.map(x => `# ${x}=`).join("\n")}\n`;
  desired["LITTLE.md"] = `# Little setup\n\nNode.js 22+, AI SDK 7. Created with little-workflow ${ownVersion()}.\n\nRun \`${packageManager} run little:smoke\` for a deterministic keyless Harness${options.workflow ? ' + durable Workflow' : ''} test. Run \`${packageManager} run little:agent\` to chat in the terminal using the same agent module.${input.template !== "node" ? ` Run \`${packageManager} run dev\` and open /${options.page} for useChatUI (an app-local wrapper over AI SDK useChat).` : ''}\n\nProvider: ${options.provider}; model: ${options.model}. Copy values from .env.little.example into your environment; setup never reads or writes credentials. Set LITTLE_DEMO=0 yourself to opt into real model calls. Next reads .env.local; terminal scripts need exported environment values.\n\nAgent definitions: ${agents}/support. Shared by CLI and web; Next's server-only initializer is outside agent.ts.${options.workflow ? ' The echo workflow is wired into the agent as starter_echo; the keyless model calls it, and smoke also executes it directly. Replace its fixed plan/tool with your business logic and increment definitionIdentity when changing the definition.' : ''}\n\nLocal persistence in .little-harness/ and .little-workflow/ assumes one local process and filesystem. This is not hosted or multi-tenant storage. The sample web API has no login, ignores browser userId/session ids, and chooses a fresh session per request. It refuses production live chat until you implement server-verified authentication and authorization. LITTLE_DEMO=1 explicitly enables keyless production smoke only. Add rate limits and a suitable durable host before deployment.\n\nExisting routes, scripts, configs, aliases, and env are preserved. Relative imports avoid alias assumptions. The server-only wrapper uses native Node loading from the project root for Little packages and shared definitions, avoiding bundling filesystem/native runtime internals. Keep the definitions present on disk. Setup does not rewrite your config.\n\nCompute is unavailable in this installer: its public backend/package has not been qualified. LittleDB is unpublished. Neither is installed, provisioned, or advertised as working. Channel adapters/services and monorepo templates are outside this alpha; a headless CLI does not require a separate service.\n\nRerun with identical options for a no-op. Edited generated files become conflicts. Use --plan to preview. On an interrupted generation, inspect .little/setup-transaction.json and use little setup --here --rollback; only unchanged CLI-written bytes are restored. Dependency installs can leave node_modules/cache/lockfiles, which rollback preserves.\n`;
  if (input.template !== "node") {
    // Next source uses extensionless TS imports so the user's root tsconfig needs
    // no allowImportingTsExtensions edit. jiti/tsx resolve the same shared modules.
    for (const [path, text] of Object.entries(desired)) {
      if (path.endsWith(".ts") || path.endsWith(".tsx")) desired[path] = text.replace(/(from\s+|import\()\s*("[.][^"]*)\.ts"/g, '$1$2"');
    }
  }
  if (options.workflow) {
    const manifest = await readObject(root, "little-workflow.json");
    if (manifest?.workflows !== undefined && (!manifest.workflows || typeof manifest.workflows !== "object" || Array.isArray(manifest.workflows))) throw new Error("little-workflow.json workflows must be an object.");
    const path = `./${agents}/support/workflows/echo`;
    if (manifest?.workflows?.["starter-echo"] && manifest.workflows["starter-echo"] !== path) plan.conflicts.push("Workflow manifest already registers starter-echo elsewhere.");
    desired["little-workflow.json"] = json({ ...manifest, workflows: { ...manifest?.workflows, "starter-echo": path } });
  }
  try {
    const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (dirty) plan.warnings.push("Git tree has uncommitted work. Review the preview; only listed files are changed.");
  } catch { /* new/unversioned directory */ }
  plan.warnings.push("All installs disable lifecycle scripts. Native Workflow build needs explicit --allow-native-build. No keys, paid provisioning, model charges, or deployment during setup/verify.");
  const hashes: Record<string, string> = {};
  const mergeFiles = ["package.json", ".gitignore", "little-harness.json", "little-workflow.json"];
  for (const [path, after] of Object.entries(desired)) {
    const before = await readText(root, path);
    hashes[path] = digest(after);
    if (before === after) continue;
    if (before !== null && !mergeFiles.includes(path)) {
      plan.conflicts.push(`${path}: ${oldState?.hashes[path] ? 'generated file was edited or its template changed' : 'file already exists'}. Choose another --route/--page or move it yourself.`);
    } else plan.files.push({ path, before, after });
  }
  const stateAfter = json({ schema: 1, options, hashes });
  const stateBefore = await readText(root, STATE);
  if (stateBefore !== stateAfter) plan.files.push({ path: STATE, before: stateBefore, after: stateAfter });
  return plan;
}
