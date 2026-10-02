import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  connectorsCommand,
  initCommand,
  newCommand,
  resolveConnectorReplTools,
  testCommand,
} from "./agent-commands.js";
import { resolveProvider } from "./provider-catalog.js";
import { scaffoldDependencyVersions } from "./scaffold-versions.js";

const descriptorPath = resolve(import.meta.dirname, "../connectors/descriptors.ts");

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
async function tmp() {
  const d = await mkdtemp(join(tmpdir(), "lh-cli-"));
  dirs.push(d);
  return d;
}
const has = async (p: string) => {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
};

it("init prompts for project setup answers and creates a project directory", async () => {
  const cwd = await tmp();
  let out = "";
  const code = await initCommand([], {
    cwd,
    stdout: (t) => { out += t; },
    prompts: {
      projectName: "support-agents",
      provider: "openai",
      model: "gpt-5.2",
      install: false,
    },
  });
  expect(code).toBe(0);
  expect(await has(join(cwd, "support-agents", "package.json"))).toBe(true);
  expect(await has(join(cwd, "support-agents", "agents", "support", "agent.ts"))).toBe(true);
  expect(out).toContain("cd support-agents");
  expect(out).toContain("OPENAI_API_KEY");
  expect(out).toContain("pnpm little-harness test support");
});

it("init creates a project from non-interactive flags", async () => {
  const cwd = await tmp();
  const code = await initCommand([
    "support-agents",
    "--provider",
    "openai",
    "--model",
    "gpt-5.2",
    "--yes",
    "--no-install",
  ], { cwd, stdout: () => {} });
  expect(code).toBe(0);
  const agentTs = await readFile(join(cwd, "support-agents", "agents", "support", "agent.ts"), "utf8");
  expect(agentTs).toContain('import { openai } from "@ai-sdk/openai";');
  expect(agentTs).toContain('model: openai("gpt-5.2")');
});

it("init reports every required env var for OpenAI-compatible providers", async () => {
  const cwd = await tmp();
  let out = "";
  const code = await initCommand([
    "custom-agents",
    "--provider",
    "openai-compatible",
    "--model",
    "local-model",
    "--yes",
    "--no-install",
  ], { cwd, stdout: (t) => { out += t; } });

  expect(code).toBe(0);
  expect(out).toContain("OPENAI_COMPATIBLE_BASE_URL");
  expect(out).toContain("OPENAI_COMPATIBLE_API_KEY");
});

it("init --here initializes the current directory without a cd hint", async () => {
  const cwd = await tmp();
  let out = "";
  const code = await initCommand([
    "--here",
    "--provider",
    "anthropic",
    "--model",
    "claude-sonnet-4-6",
    "--yes",
    "--no-install",
  ], { cwd, stdout: (t) => { out += t; } });
  expect(code).toBe(0);
  expect(await has(join(cwd, "package.json"))).toBe(true);
  const agentTs = await readFile(join(cwd, "agents", "support", "agent.ts"), "utf8");
  expect(agentTs).toContain('model: anthropic("claude-sonnet-4-6")');
  expect(out).not.toContain("cd ");
  expect(out).toContain("ANTHROPIC_API_KEY");
});

it("init returns a usage error instead of prompting without a TTY or project name", async () => {
  const cwd = await tmp();
  let err = "";
  let installed = false;
  const code = await initCommand(["--provider", "openai", "--model", "gpt-5.2", "--yes"], {
    cwd,
    stderr: (t) => { err += t; },
    isTTY: false,
    install: async () => {
      installed = true;
    },
  });
  expect(code).toBe(1);
  expect(err).toMatch(/usage/i);
  expect(installed).toBe(false);
  expect(await has(join(cwd, "package.json"))).toBe(false);
  expect(await has(join(cwd, "support-agents", "package.json"))).toBe(false);
});

it("init rejects an empty prompted project name before scaffolding", async () => {
  const cwd = await tmp();
  let err = "";
  const code = await initCommand([], {
    cwd,
    stderr: (t) => { err += t; },
    prompts: {
      projectName: "  ",
      provider: "openai",
      model: "gpt-5.2",
      install: false,
    },
  });
  expect(code).toBe(1);
  expect(err).toMatch(/project name/i);
  expect(await has(join(cwd, "package.json"))).toBe(false);
});

it("init rejects invalid providers", async () => {
  const cwd = await tmp();
  let err = "";
  const code = await initCommand(["support-agents", "--provider", "nope", "--yes", "--no-install"], {
    cwd,
    stderr: (t) => { err += t; },
  });
  expect(code).toBe(1);
  expect(err).toMatch(/unknown provider/i);
});

it("init --no-install skips package installation", async () => {
  const cwd = await tmp();
  let installed = false;
  let out = "";
  const code = await initCommand(["support-agents", "--provider", "gateway", "--yes", "--no-install"], {
    cwd,
    stdout: (t) => { out += t; },
    install: async () => {
      installed = true;
    },
  });
  expect(code).toBe(0);
  expect(installed).toBe(false);
  expect(out).toContain("pnpm install");
  expect(out.indexOf("pnpm install")).toBeLessThan(out.indexOf("pnpm little-harness test support"));
});

it("init returns a usage error in non-interactive mode without provider or yes", async () => {
  const cwd = await tmp();
  let err = "";
  const code = await initCommand(["support-agents"], {
    cwd,
    stderr: (t) => { err += t; },
    isTTY: false,
  });
  expect(code).toBe(1);
  expect(err).toMatch(/--provider|--yes/);
  expect(await has(join(cwd, "support-agents", "package.json"))).toBe(false);
});

it("new scaffolds an agent under agents/", async () => {
  const cwd = await tmp();
  const code = await newCommand(["billing"], { cwd, stdout: () => {} });
  expect(code).toBe(0);
  expect(await has(join(cwd, "agents", "billing", "agent.ts"))).toBe(true);
});

it("new scaffolds an agent with the selected provider and model", async () => {
  const cwd = await tmp();
  const code = await newCommand(["billing", "--provider", "openai", "--model", "gpt-5.2"], {
    cwd,
    stdout: () => {},
  });
  expect(code).toBe(0);
  const agentTs = await readFile(join(cwd, "agents", "billing", "agent.ts"), "utf8");
  expect(agentTs).toContain('import { openai } from "@ai-sdk/openai";');
  expect(agentTs).toContain('model: openai("gpt-5.2")');
});

it("new adds the selected provider package to the workspace package.json", async () => {
  const cwd = await tmp();
  expect(await initCommand(["support-agents", "--provider", "gateway", "--yes", "--no-install"], {
    cwd,
    stdout: () => {},
  })).toBe(0);

  const projectRoot = join(cwd, "support-agents");
  expect(await newCommand(["billing", "--provider", "openai", "--model", "gpt-5.2"], {
    cwd: projectRoot,
    stdout: () => {},
  })).toBe(0);

  const packageJson = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"));
  expect(packageJson.dependencies).toMatchObject({
    "@ai-sdk/openai": resolveProvider("openai").packageVersion,
    ai: scaffoldDependencyVersions().ai,
    "little-harness": scaffoldDependencyVersions().littleHarness,
  });
});

it("new without a name returns a usage error", async () => {
  let err = "";
  const code = await newCommand([], { cwd: await tmp(), stderr: (t) => { err += t; } });
  expect(code).toBe(1);
  expect(err).toMatch(/usage/i);
});

it("test fails clearly for an unknown agent", async () => {
  const cwd = await tmp();
  let err = "";
  const code = await testCommand(["ghost"], ".little-harness", { cwd, stderr: (t) => { err += t; } });
  expect(code).toBe(1);
  expect(err).toMatch(/ghost/);
});

it("connectors lists discovered connectors and reports skipped candidates", async () => {
  const cwd = await tmp();
  const agentDir = join(cwd, "agents", "support");
  const connectorsDir = join(agentDir, "connectors");
  await mkdir(connectorsDir, { recursive: true });
  await writeFile(join(agentDir, "agent.ts"), "export default {};\n");
  await writeFile(
    join(connectorsDir, "slack.ts"),
    `import { chatSdkConnector } from ${JSON.stringify(descriptorPath)};
     export default chatSdkConnector({ userName: "support", adapter: { name: "slack", create: () => ({}) }, state: () => ({}) });`,
  );
  // A flat helper that is not a connector descriptor — must be reported as a skipped candidate,
  // not silently dropped.
  await writeFile(join(connectorsDir, "notes.ts"), `export default { title: "not a connector" };`);

  let out = "";
  const code = await connectorsCommand(["support"], ".little-harness", { cwd, stdout: (t) => { out += t; } });

  expect(code).toBe(0);
  expect(out).toContain("Connectors for 'support':");
  expect(out).toContain("slack");
  expect(out).toContain("chat-sdk");
  expect(out).toContain(join(connectorsDir, "slack.ts"));
  expect(out).toContain("Skipped connector candidates:");
  expect(out).toContain("notes");
});

it("connectors reports no connectors for an agent without a connectors dir", async () => {
  const cwd = await tmp();
  const agentDir = join(cwd, "agents", "support");
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "agent.ts"), "export default {};\n");

  let out = "";
  const code = await connectorsCommand(["support"], ".little-harness", { cwd, stdout: (t) => { out += t; } });

  expect(code).toBe(0);
  expect(out).toContain("No connectors found for 'support'.");
});

it("connectors fails clearly for an unknown agent", async () => {
  const cwd = await tmp();
  let err = "";
  const code = await connectorsCommand(["ghost"], ".little-harness", { cwd, stderr: (t) => { err += t; } });
  expect(code).toBe(1);
  expect(err).toMatch(/ghost/);
});

it("resolveConnectorReplTools inventory includes descriptor-carried tools merged with folder extensions", async () => {
  const cwd = await tmp();
  const agentDir = join(cwd, "agents", "support");
  const toolsDir = join(agentDir, "connectors", "slack", "tools");
  await mkdir(toolsDir, { recursive: true });
  await writeFile(join(agentDir, "agent.ts"), "export default {};\n");
  await writeFile(
    join(agentDir, "connectors", "slack", "connector.ts"),
    `import { chatSdkConnector } from ${JSON.stringify(descriptorPath)};
     export default chatSdkConnector({
       userName: "support",
       adapter: { name: "slack", create: () => ({ name: "slack" }) },
       state: () => ({}),
       tools: {
         postToChannel: { description: "Descriptor tool.", inputSchema: {}, execute: async () => ({ ok: true }) },
         descriptorOnly: { description: "Descriptor-only tool.", inputSchema: {}, execute: async () => ({ ok: true }) },
       },
     });`,
  );
  // A folder extension with the same name must win per-name over the descriptor tool.
  await writeFile(
    join(toolsDir, "postToChannel.ts"),
    `export default { description: "Folder tool.", inputSchema: {}, execute: async () => ({ ok: "folder" }) };`,
  );

  const inventory = await resolveConnectorReplTools(agentDir, "slack", {});

  expect(inventory.kind).toBe("chat-sdk");
  // Descriptor-carried tools now appear in the inventory (previously omitted), merged with folder.
  expect(inventory.toolNames).toEqual(["descriptorOnly", "postToChannel"]);
  expect((inventory.connectorTools.postToChannel as { description?: string }).description).toBe("Folder tool.");
  expect((inventory.connectorTools.descriptorOnly as { description?: string }).description).toBe(
    "Descriptor-only tool.",
  );
});
