import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { initWorkspace, scaffoldAgent, scaffoldProject } from "./agent-scaffold.js";
import { resolveProvider } from "./provider-catalog.js";
import { scaffoldDependencyVersions } from "./scaffold-versions.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
async function tmp() {
  const d = await mkdtemp(join(tmpdir(), "lh-scaffold-"));
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

it("initWorkspace writes the marker + a starter agent", async () => {
  const root = await tmp();
  await initWorkspace(root);
  expect(JSON.parse(await readFile(join(root, "little-harness.json"), "utf8"))).toEqual({ agents: "agents" });
  expect(await has(join(root, "agents", "support", "agent.ts"))).toBe(true);
  expect(await has(join(root, "agents", "support", "tools", "echo.ts"))).toBe(true);
  expect(await has(join(root, "agents", "support", "instructions.md"))).toBe(true);
});

it("scaffolded agent.ts default-exports createHarness and echo.ts is an AI SDK tool", async () => {
  const root = await tmp();
  await scaffoldAgent(join(root, "agents"), "billing");
  const agentTs = await readFile(join(root, "agents", "billing", "agent.ts"), "utf8");
  const echoTs = await readFile(join(root, "agents", "billing", "tools", "echo.ts"), "utf8");
  expect(agentTs).toMatch(/export default createHarness\(/);
  expect(agentTs).toContain('from "little-harness"');
  expect(echoTs).toMatch(/export default tool\(/);
});

it("scaffoldAgent renders the selected provider and model", async () => {
  const root = await tmp();
  await scaffoldAgent(join(root, "agents"), "support", {
    provider: "openai",
    model: "gpt-5.2",
  });
  const agentTs = await readFile(join(root, "agents", "support", "agent.ts"), "utf8");
  expect(agentTs).toContain('import { openai } from "@ai-sdk/openai";');
  expect(agentTs).toContain('model: openai("gpt-5.2")');
});

it("scaffoldProject creates a runnable gateway project without a gateway package dependency", async () => {
  const root = await tmp();
  await scaffoldProject(root, {
    projectName: "support-agents",
    provider: "gateway",
    model: "anthropic/claude-sonnet-4-6",
  });

  expect(await has(join(root, "package.json"))).toBe(true);
  expect(await has(join(root, "tsconfig.json"))).toBe(true);
  expect(await has(join(root, ".gitignore"))).toBe(true);
  expect(await has(join(root, "little-harness.json"))).toBe(true);
  expect(await has(join(root, "agents", "support", "agent.ts"))).toBe(true);
  expect(await has(join(root, "agents", "support", "instructions.md"))).toBe(true);
  expect(await has(join(root, "agents", "support", "tools", "echo.ts"))).toBe(true);

  const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  // Pinned, never `latest`: npm's latest `ai` is a major this package may not run.
  const versions = scaffoldDependencyVersions();
  expect(packageJson.dependencies).toEqual({
    "little-harness": versions.littleHarness,
    ai: versions.ai,
    zod: versions.zod,
  });
  expect(versions.littleHarness).toMatch(/^\^\d+\.\d+\.\d+/u);
  expect(versions.ai).toMatch(/^\^7\./u);
  expect(packageJson.devDependencies).toEqual(versions.devDependencies);
  expect(JSON.stringify(packageJson)).not.toContain('"latest"');
  expect(packageJson.dependencies).not.toHaveProperty("@ai-sdk/gateway");
  expect(packageJson.scripts).toMatchObject({
    "test:agent": "little-harness test support",
    typecheck: "tsc --noEmit",
  });
  expect(packageJson.packageManager).toBe("pnpm@10.27.0");
});

it("scaffoldProject creates an OpenAI-compatible project with its provider dependency and base URL setup", async () => {
  const root = await tmp();
  await scaffoldProject(root, {
    projectName: "custom-provider-agents",
    provider: "openai-compatible",
    model: "local-model",
  });

  const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  expect(packageJson.dependencies).toMatchObject({
    "@ai-sdk/openai-compatible": resolveProvider("openai-compatible").packageVersion,
    "little-harness": scaffoldDependencyVersions().littleHarness,
    ai: scaffoldDependencyVersions().ai,
  });

  const agentTs = await readFile(join(root, "agents", "support", "agent.ts"), "utf8");
  expect(agentTs).toContain('import { createOpenAICompatible } from "@ai-sdk/openai-compatible";');
  expect(agentTs).toContain("OPENAI_COMPATIBLE_BASE_URL");
  expect(agentTs).toContain('model: openaiCompatible("local-model")');
});

it("scaffoldProject refuses to write into a non-empty directory without force", async () => {
  const root = await tmp();
  await writeFile(join(root, "README.md"), "# existing\n");
  await expect(scaffoldProject(root, { projectName: "support-agents" })).rejects.toThrow(/not empty/i);
  expect(await has(join(root, "package.json"))).toBe(false);
});

it("scaffoldProject refuses an existing workspace marker before writing package files", async () => {
  const root = await tmp();
  await writeFile(join(root, "little-harness.json"), `${JSON.stringify({ agents: "agents" })}\n`);
  await expect(scaffoldProject(root, { projectName: "support-agents" })).rejects.toThrow(/initialized/i);
  expect(await has(join(root, "package.json"))).toBe(false);
});

it("scaffoldProject refuses an existing support agent before writing project files", async () => {
  const root = await tmp();
  await mkdir(join(root, "agents", "support"), { recursive: true });
  await writeFile(join(root, "agents", "support", "README.md"), "# existing support agent\n");
  await expect(scaffoldProject(root, {
    allowNonEmpty: true,
    projectName: "support-agents",
  })).rejects.toThrow(/support/);
  expect(await has(join(root, "package.json"))).toBe(false);
  expect(await has(join(root, "little-harness.json"))).toBe(false);
});

it("scaffoldAgent refuses to clobber without force", async () => {
  const root = await tmp();
  await scaffoldAgent(join(root, "agents"), "x");
  await expect(scaffoldAgent(join(root, "agents"), "x")).rejects.toThrow(/exists/i);
  await scaffoldAgent(join(root, "agents"), "x", { force: true }); // ok
});

it("initWorkspace refuses to re-init without force", async () => {
  const root = await tmp();
  await initWorkspace(root);
  await expect(initWorkspace(root)).rejects.toThrow(/initialized/i);
});
