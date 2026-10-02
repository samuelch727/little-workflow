import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { renderAgentSource, resolveProvider } from "./provider-catalog.js";
import { providerDependency, scaffoldDependencyVersions } from "./scaffold-versions.js";

const DEFAULT_PROVIDER = "anthropic";

const ECHO_TS = `import { tool } from "ai";
import { z } from "zod";

// Tool files in tools/ are auto-discovered; the tool name is the filename ("echo").
export default tool({
  description: "Echo a message back to the caller.",
  inputSchema: z.object({ message: z.string() }),
  execute: async ({ message }) => message,
});
`;

const INSTRUCTIONS_MD = `You are a helpful agent.

Replace this file (or the \`system\` field in agent.ts) with your agent's instructions.
agent.ts's \`system\` wins; if it is omitted, this file becomes the system prompt.
`;

const TSCONFIG_JSON = `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "noEmit": true
  },
  "include": ["agents/**/*.ts"]
}
`;

const GITIGNORE = `node_modules
dist
.env
.little-harness
`;

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Scaffold a new agent folder at `<agentsDir>/<name>` with `agent.ts`, `instructions.md`, and an
 * example `tools/echo.ts`. Throws if the folder already exists and `force` is not set.
 */
export async function scaffoldAgent(
  agentsDir: string,
  name: string,
  opts: { force?: boolean; provider?: string; model?: string } = {},
): Promise<string[]> {
  const dir = join(agentsDir, name);
  if (!opts.force && (await exists(dir))) {
    throw new Error(`Agent folder already exists: ${dir} (use --force to overwrite)`);
  }
  await mkdir(join(dir, "tools"), { recursive: true });
  const writes: ReadonlyArray<readonly [string, string]> = [
    [
      join(dir, "agent.ts"),
      renderAgentSource({
        provider: opts.provider ?? DEFAULT_PROVIDER,
        ...(opts.model === undefined ? {} : { model: opts.model }),
      }),
    ],
    [join(dir, "instructions.md"), INSTRUCTIONS_MD],
    [join(dir, "tools", "echo.ts"), ECHO_TS],
  ];
  for (const [path, content] of writes) await writeFile(path, content);
  return writes.map(([path]) => path);
}

/**
 * Initialize a workspace at `root`: write `little-harness.json` (`{ "agents": "agents" }`), create
 * `agents/`, and scaffold a starter `support` agent. Throws if already initialized and `force` is unset.
 */
export async function initWorkspace(
  root: string,
  opts: { force?: boolean; provider?: string; model?: string } = {},
): Promise<string[]> {
  const marker = join(root, "little-harness.json");
  if (!opts.force && (await exists(marker))) {
    throw new Error(`Workspace already initialized: ${marker} (use --force to overwrite)`);
  }
  await mkdir(join(root, "agents"), { recursive: true });
  await writeFile(marker, `${JSON.stringify({ agents: "agents" }, null, 2)}\n`);
  const agentPaths = await scaffoldAgent(join(root, "agents"), "support", {
    force: opts.force ?? false,
    ...(opts.provider === undefined ? {} : { provider: opts.provider }),
    ...(opts.model === undefined ? {} : { model: opts.model }),
  });
  return [marker, ...agentPaths];
}

export async function scaffoldProject(
  root: string,
  opts: { allowNonEmpty?: boolean; force?: boolean; projectName?: string; provider?: string; model?: string } = {},
): Promise<string[]> {
  const provider = resolveProvider(opts.provider ?? DEFAULT_PROVIDER);
  const packagePath = join(root, "package.json");
  const marker = join(root, "little-harness.json");
  const starterAgentDir = join(root, "agents", "support");
  if (!opts.force && (await exists(packagePath))) {
    throw new Error(`Project already initialized: ${packagePath} (use --force to overwrite)`);
  }
  if (!opts.force && (await exists(marker))) {
    throw new Error(`Workspace already initialized: ${marker} (use --force to overwrite)`);
  }
  if (!opts.force && (await exists(starterAgentDir))) {
    throw new Error(`Agent folder already exists: ${starterAgentDir} (use --force to overwrite)`);
  }
  if (!opts.force && !opts.allowNonEmpty && (await exists(root))) {
    const entries = await readdir(root);
    if (entries.length > 0) {
      throw new Error(`Target directory is not empty: ${root} (use --force to overwrite)`);
    }
  }

  await mkdir(root, { recursive: true });
  const versions = scaffoldDependencyVersions();
  const dependencies: Record<string, string> = {
    "little-harness": versions.littleHarness,
    ai: versions.ai,
    zod: versions.zod,
  };
  const providerPackage = providerDependency(provider);
  if (providerPackage !== undefined) {
    dependencies[providerPackage[0]] = providerPackage[1];
  }

  const packageJson = {
    name: opts.projectName ?? basename(root),
    type: "module",
    private: true,
    scripts: {
      "test:agent": "little-harness test support",
      typecheck: "tsc --noEmit",
    },
    dependencies,
    devDependencies: { ...versions.devDependencies },
    packageManager: "pnpm@10.27.0",
  };

  const writes: ReadonlyArray<readonly [string, string]> = [
    [packagePath, `${JSON.stringify(packageJson, null, 2)}\n`],
    [join(root, "tsconfig.json"), TSCONFIG_JSON],
    [join(root, ".gitignore"), GITIGNORE],
  ];
  for (const [path, content] of writes) await writeFile(path, content);
  const workspacePaths = await initWorkspace(root, {
    force: opts.force ?? false,
    provider: provider.id,
    ...(opts.model === undefined ? {} : { model: opts.model }),
  });
  return [...writes.map(([path]) => path), ...workspacePaths];
}
