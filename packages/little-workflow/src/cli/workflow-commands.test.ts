import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { addCommand, initCommand } from "./workflow-commands.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "lw-cli-"));
  dirs.push(dir);
  return dir;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

it("little init --help prints usage instead of scaffolding a project named --help", async () => {
  const cwd = await tmp();
  let stdout = "";
  const code = await initCommand(["--help"], { cwd, stdout: (text) => { stdout += text; } });

  expect(code).toBe(0);
  expect(stdout).toContain("Usage: little init [name] [options]");
  expect(await exists(join(cwd, "--help"))).toBe(false);
  expect(await exists(join(cwd, "little-workflow-project"))).toBe(false);
});

it("little init rejects an unknown option without writing files", async () => {
  const cwd = await tmp();
  let stderr = "";
  const code = await initCommand(["demo", "--provder", "openai"], {
    cwd,
    stderr: (text) => { stderr += text; },
  });

  expect(code).toBe(1);
  expect(stderr).toContain("Unknown option '--provder' for little init.");
  expect(await exists(join(cwd, "demo"))).toBe(false);
});

it("little init creates a workflow project from non-interactive flags", async () => {
  const cwd = await tmp();
  let stdout = "";
  const code = await initCommand([
    "ops-workflows",
    "--workflow",
    "ticket-triage",
    "--provider",
    "deepseek",
    "--model",
    "deepseek-chat",
    "--yes",
    "--no-install",
  ], {
    cwd,
    stdout: (text) => { stdout += text; },
  });

  expect(code).toBe(0);
  expect(await exists(join(cwd, "ops-workflows", "workflows", "ticket-triage", "workflow.ts"))).toBe(true);
  expect(stdout).toContain("cd ops-workflows");
  expect(stdout).toContain("pnpm install");
  expect(stdout).toContain("pnpm test:workflow");
});

it("little init --here --with-harness creates workflow and harness files in cwd", async () => {
  const cwd = await tmp();
  const code = await initCommand([
    "--here",
    "--workflow",
    "candidate-review",
    "--with-harness",
    "--agent",
    "support",
    "--provider",
    "deepseek",
    "--model",
    "deepseek-reasoner",
    "--yes",
    "--no-install",
  ], { cwd, stdout: () => {} });

  expect(code).toBe(0);
  expect(await exists(join(cwd, "workflows", "candidate-review", "workflow.ts"))).toBe(true);
  expect(await exists(join(cwd, "agents", "support", "agent.ts"))).toBe(true);
  expect(await exists(join(cwd, "agents", "support", "workflows", "candidate-review.ts"))).toBe(true);
});

it("little init --here works in a non-empty directory", async () => {
  const cwd = await tmp();
  await writeFile(join(cwd, "README.md"), "# existing project\n");
  let stderr = "";
  const code = await initCommand(
    ["--here", "--workflow", "alpha", "--yes", "--no-install"],
    { cwd, stdout: () => {}, stderr: (text) => { stderr += text; } },
  );

  expect(code).toBe(0);
  expect(stderr).toBe("");
  expect(await exists(join(cwd, "workflows", "alpha", "workflow.ts"))).toBe(true);
  expect(await exists(join(cwd, "README.md"))).toBe(true);
});

it("little add workflow adds a workflow to the current project", async () => {
  const cwd = await tmp();
  await initCommand(["--here", "--workflow", "alpha", "--yes", "--no-install"], {
    cwd,
    stdout: () => {},
  });

  const code = await addCommand(["workflow", "beta"], { cwd, stdout: () => {} });

  expect(code).toBe(0);
  const manifest = JSON.parse(await readFile(join(cwd, "little-workflow.json"), "utf8"));
  expect(manifest.workflows).toMatchObject({
    alpha: "./workflows/alpha",
    beta: "./workflows/beta",
  });
});

it("little add workflow honors --dir for custom workflow roots", async () => {
  const cwd = await tmp();
  await initCommand(["--here", "--workflow", "alpha", "--yes", "--no-install"], {
    cwd,
    stdout: () => {},
  });

  const code = await addCommand([
    "workflow",
    "beta",
    "--dir",
    "automation/workflows",
    "--provider",
    "deepseek",
    "--model",
    "deepseek-reasoner",
  ], { cwd, stdout: () => {} });

  expect(code).toBe(0);
  expect(await exists(join(cwd, "automation", "workflows", "beta", "workflow.ts"))).toBe(true);
  const workflowTs = await readFile(join(cwd, "automation", "workflows", "beta", "workflow.ts"), "utf8");
  expect(workflowTs).toContain('model: deepseek("deepseek-reasoner")');
  const manifest = JSON.parse(await readFile(join(cwd, "little-workflow.json"), "utf8"));
  expect(manifest.workflows.beta).toBe("./automation/workflows/beta");
});

it("little add harness --new-workflow creates both the new workflow and shim", async () => {
  const cwd = await tmp();
  await initCommand(["--here", "--workflow", "alpha", "--yes", "--no-install"], {
    cwd,
    stdout: () => {},
  });

  const code = await addCommand([
    "harness",
    "--agent",
    "support",
    "--new-workflow",
    "beta",
    "--provider",
    "deepseek",
    "--model",
    "deepseek-reasoner",
  ], { cwd, stdout: () => {} });

  expect(code).toBe(0);
  expect(await exists(join(cwd, "workflows", "beta", "workflow.ts"))).toBe(true);
  expect(await exists(join(cwd, "agents", "support", "agent.ts"))).toBe(true);
  expect(await exists(join(cwd, "agents", "support", "workflows", "beta.ts"))).toBe(true);
});

it("little add harness rejects selecting and creating a workflow at the same time", async () => {
  const cwd = await tmp();
  let stderr = "";
  const code = await addCommand([
    "harness",
    "--workflow",
    "alpha",
    "--new-workflow",
    "beta",
  ], {
    cwd,
    stderr: (text) => { stderr += text; },
  });

  expect(code).toBe(1);
  expect(stderr).toMatch(/choose either --workflow or --new-workflow/i);
});
