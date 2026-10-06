import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { planSetup, type SetupOptions } from "./setup-plan.js";
import { applySetupPlan, readText, rollbackSetup } from "./setup-transaction.js";

type Io = { cwd?: string; stdout?: (text: string) => void | Promise<void>; stderr?: (text: string) => void | Promise<void>; isTTY?: boolean };
export const setupUsage = `Usage: little setup [directory] [options]

Templates: --template node | next | existing-next
  --here                    Add Little to the current Next.js project
  --workflow                Wire a durable, keyless Workflow example into Harness
  --provider <id>           Harness scaffold provider (default: openai)
  --model <id>              Provider model (defaults to its catalog choice)
  --package-manager <name>  npm, pnpm, or Yarn Classic (detect existing lockfile)
  --route <path>            Chat route (default: api/little/chat)
  --page <path>             Chat page (default: little)
  --plan                    Preview files, dependencies, warnings and conflicts; no writes
  --yes                     Apply the preview without an interactive confirmation
  --install                 Install dependencies with lifecycle scripts disabled
  --no-install              Generate only (default in noninteractive mode)
  --allow-native-build      Permit only better-sqlite3's build after --install
  --verify                  Run generated typecheck and deterministic keyless smoke
  --rollback                Recover an interrupted transaction in --here/directory
  --compute                 Explain unavailable Compute support; makes no changes
  --help                    Show this help

Node >=22 and AI SDK 7. No major upgrades, keys, paid provisioning or deployment.
New templates: one repo, agent definitions shared by the CLI and web entrypoint.
Compute is unqualified; LittleDB is unpublished. Neither is installed.
Examples:
  npx little-workflow@alpha setup my-app --template next --workflow --yes --install --allow-native-build --verify
  npx little-workflow@alpha setup agents --template node --yes --install --verify
  npx little-workflow@alpha setup --here --plan
`;

type Parsed = { dir?: string; options: SetupOptions; plan: boolean; yes: boolean; install: boolean; verify: boolean; native: boolean; here: boolean; rollback: boolean; help: boolean; compute: boolean; explicitTemplate: boolean; noInstall: boolean };
function parseArgs(args: readonly string[]): Parsed {
  const result: Parsed = { options: { template: "node", provider: "openai", workflow: false, route: "api/little/chat", page: "little" }, plan: false, yes: false, install: false, verify: false, native: false, here: false, rollback: false, help: false, compute: false, explicitTemplate: false, noInstall: false };
  const fields: Record<string, keyof SetupOptions> = { "--template": "template", "--provider": "provider", "--model": "model", "--package-manager": "packageManager", "--route": "route", "--page": "page" };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const [flag, inline] = arg.split(/=(.*)/s);
    if (fields[flag!]) {
      const value = inline ?? args[++i];
      if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
      (result.options as unknown as Record<string, unknown>)[fields[flag!]!] = value;
      if (flag === "--template") result.explicitTemplate = true;
    } else if (arg === "--here") { result.here = true; }
    else if (arg === "--plan") result.plan = true;
    else if (arg === "--yes" || arg === "-y") result.yes = true;
    else if (arg === "--workflow") result.options.workflow = true;
    else if (arg === "--install") { result.install = true; result.noInstall = false; }
    else if (arg === "--no-install") { result.install = false; result.noInstall = true; }
    else if (arg === "--verify") result.verify = true;
    else if (arg === "--allow-native-build") result.native = true;
    else if (arg === "--rollback") result.rollback = true;
    else if (arg === "--help" || arg === "-h") result.help = true;
    else if (arg === "--compute") result.compute = true;
    else if (arg.startsWith("-")) throw new Error(`Unknown setup option: ${arg}`);
    else if (result.dir) throw new Error("Provide one target directory.");
    else result.dir = arg;
  }
  if (result.here && result.dir) throw new Error("Choose a directory or --here, not both.");
  if (result.here && !result.explicitTemplate) result.options.template = "existing-next";
  if (!["node", "next", "existing-next"].includes(result.options.template)) throw new Error("Template must be node, next, or existing-next.");
  if (result.options.packageManager && !["npm", "pnpm", "yarn"].includes(result.options.packageManager)) throw new Error("Package manager must be npm, pnpm, or yarn.");
  return result;
}

export async function setupCommand(args: readonly string[], io: Io = {}): Promise<number> {
  const out = io.stdout ?? ((text: string) => { process.stdout.write(text); });
  const err = io.stderr ?? ((text: string) => { process.stderr.write(text); });
  try {
    const parsed = parseArgs(args);
    if (parsed.help) { await out(setupUsage); return 0; }
    if (parsed.compute) { await out("Compute is unavailable in setup: its public package/backend is not qualified. LittleDB is unpublished. No packages were installed or provisioned.\n"); return 0; }
    const tty = io.isTTY ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
    let interactiveInstall = false;
    if (tty && !parsed.yes && !parsed.plan && !parsed.rollback) {
      await out("Little Harness is included. Workflow is optional. Compute is unavailable: its public backend/package is not qualified; LittleDB is unpublished.\n");
      const readline = createInterface({ input: process.stdin, output: process.stdout });
      try {
        if (!parsed.here && !parsed.dir) parsed.dir = (await readline.question("Project directory [little-app]: ")).trim() || "little-app";
        if (!parsed.explicitTemplate && !parsed.here) {
          const answer = (await readline.question("Template: Next.js app or standalone Node agent [next/node; next]: ")).trim();
          parsed.options.template = answer === "node" ? "node" : "next";
        }
        parsed.options.workflow = parsed.options.workflow || (await readline.question("Add Little Workflow's durable keyless example? [y/N]: ")).toLowerCase() === "y";
        parsed.options.provider = (await readline.question(`Live provider (any Harness catalog id) [${parsed.options.provider}]: `)).trim() || parsed.options.provider;
        parsed.options.model = (await readline.question(`Live model [${parsed.options.model ?? "catalog default"}]: `)).trim() || parsed.options.model;
        if (!parsed.here && !parsed.options.packageManager) {
          const manager = (await readline.question("Package manager [npm/pnpm/yarn; npm]: ")).trim() || "npm";
          if (!["npm", "pnpm", "yarn"].includes(manager)) throw new Error("Package manager must be npm, pnpm, or yarn.");
          parsed.options.packageManager = manager as SetupOptions["packageManager"];
        }
        interactiveInstall = true;
      } finally { readline.close(); }
    }
    const root = resolve(io.cwd ?? process.cwd(), parsed.here ? "." : parsed.dir ?? ".");
    if (parsed.rollback) {
      const retained = await rollbackSetup(root);
      if (retained.length) throw new Error(`Rollback preserved edited files: ${retained.join(", ")}. Recover the remaining journal manually.`);
      await out("Recovered unchanged CLI-owned files; dependencies, caches and user edits were preserved.\n");
      return 0;
    }
    if (!parsed.dir && !parsed.here) throw new Error("Provide a project directory or --here. Use --help for examples.");
    const plan = await planSetup(root, parsed.options);
    await out(`${JSON.stringify({ root: plan.root, options: plan.options, files: plan.files.map(f => ({ path: f.path, action: f.before === null ? "create" : "merge", ...(f.path === "package.json" ? { before: f.before && JSON.parse(f.before), after: JSON.parse(f.after) } : {}) })), warnings: plan.warnings, conflicts: plan.conflicts }, null, 2)}\n`);
    if (parsed.plan) return plan.conflicts.length ? 1 : 0;
    if (plan.conflicts.length) throw new Error("No files changed. Resolve the previewed conflicts, then rerun.");
    if (!parsed.yes) {
      if (!tty) throw new Error("No files changed. Noninteractive setup requires --yes to apply or --plan to preview.");
      const readline = createInterface({ input: process.stdin, output: process.stdout });
      try {
        if ((await readline.question("Apply these changes? [y/N]: ")).toLowerCase() !== "y") { await out("Cancelled; no files changed.\n"); return 0; }
        if (interactiveInstall && !parsed.noInstall) parsed.install ||= (await readline.question("Install dependencies with lifecycle scripts disabled? [y/N]: ")).toLowerCase() === "y";
        if (parsed.install && parsed.options.workflow && !parsed.native) parsed.native = (await readline.question("Allow only better-sqlite3's native build? [y/N]: ")).toLowerCase() === "y";
        if (parsed.install) parsed.verify ||= (await readline.question("Run typecheck and keyless smoke? [Y/n]: ")).toLowerCase() !== "n";
      } finally { readline.close(); }
    }
    if (parsed.install && plan.options.workflow && !parsed.native) throw new Error("Workflow install requires explicit --allow-native-build. No files changed; use --no-install to generate only.");
    if (parsed.install) await checkInstallBoundary(root, plan.options.packageManager!);
    await applySetupPlan(plan, { complete: async () => {
      if (parsed.install) {
        const manager = plan.options.packageManager!;
        await run(manager, ["install", "--ignore-scripts", ...(manager === "pnpm" ? ["--no-frozen-lockfile"] : [])], root);
        if (plan.options.workflow) {
          // npm rebuild targets just this named package, also with pnpm's node_modules layout.
          await run("npm", ["rebuild", "better-sqlite3", "--ignore-scripts=false"], root);
        }
      }
      if (parsed.verify) {
        await run(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "--noEmit", "-p", "tsconfig.little.json"], root);
        await run(process.execPath, [join(root, "node_modules/tsx/dist/cli.mjs"), "scripts/little-smoke.ts"], root, { LITTLE_DEMO: "1" });
      }
    } });
    await out(`${plan.files.length ? "Little setup complete" : "Already configured (no file changes)"}. ${parsed.install ? "Dependencies installed. " : "Install dependencies before running. "}${parsed.verify ? "Typecheck and keyless smoke passed. " : ""}See LITTLE.md.\n`);
    return 0;
  } catch (error) { await err(`${error instanceof Error ? error.message : String(error)}\n`); return 1; }
}

async function checkInstallBoundary(root: string, manager: string): Promise<void> {
  let dir = root;
  while (true) {
    const pkgText = await readText(dir, "package.json");
    if (pkgText && JSON.parse(pkgText).workspaces) throw new Error("Automatic install inside a workspace is not supported in this alpha. Use --no-install and install at your workspace root after reviewing the plan.");
    if (await readText(dir, "pnpm-workspace.yaml") !== null) throw new Error("Automatic install inside a pnpm workspace is not supported. Use --no-install, then install at the workspace root.");
    const parent = await realpath(resolve(dir, ".."));
    if (parent === dir) break;
    dir = parent;
  }
  if (manager === "yarn") {
    if (await readText(root, ".yarnrc.yml") !== null) throw new Error("Yarn Berry/PnP is not supported by the filesystem CLI loader. Use --no-install or a Yarn Classic node_modules project.");
  }
}
async function run(command: string, args: string[], cwd: string, extraEnv: Record<string, string> = {}): Promise<void> {
  await new Promise<void>((accept, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit", env: { ...process.env, ...extraEnv }, shell: false });
    const interrupt = () => child.kill("SIGTERM");
    process.on("SIGINT", interrupt); process.on("SIGTERM", interrupt);
    const cleanup = () => { process.off("SIGINT", interrupt); process.off("SIGTERM", interrupt); };
    child.once("error", error => { cleanup(); reject(error); });
    child.once("exit", (code, signal) => { cleanup(); code === 0 ? accept() : reject(new Error(`${command} ${args.join(" ")} failed (${signal ?? code}). Generated file changes will be rolled back; dependency artifacts are preserved.`)); });
  });
}
