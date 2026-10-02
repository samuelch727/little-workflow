import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  addHarnessToWorkflowProject,
  addWorkflowToProject,
  initWorkflowProject,
} from "./workflow-scaffold.js";
import { resolveProvider, scaffoldDependencyVersions } from "little-harness/scaffold";
import packageManifest from "../../package.json" with { type: "json" };

const littleWorkflowVersion = packageManifest.version;

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "lw-scaffold-"));
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

it("initWorkflowProject creates a workflow-first project", async () => {
  const cwd = await tmp();
  const root = join(cwd, "support-workflows");
  const created = await initWorkflowProject(root, {
    projectName: "support-workflows",
    workflowName: "candidate-review",
    provider: "deepseek",
    model: "deepseek-chat",
  });

  expect(created).toEqual(expect.arrayContaining([
    join(root, "package.json"),
    join(root, "little-workflow.json"),
    join(root, "workflows", "candidate-review", "workflow.ts"),
    join(root, "workflows", "candidate-review", "instructions.md"),
    join(root, "workflows", "candidate-review", "tools", "echo.ts"),
    join(root, "input.example.json"),
  ]));
  const manifest = JSON.parse(await readFile(join(root, "little-workflow.json"), "utf8"));
  expect(manifest).toEqual({ workflows: { "candidate-review": "./workflows/candidate-review" } });
  const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  // Pinned to the CLI's own version and the AI SDK major it peers on, never `latest`.
  const versions = scaffoldDependencyVersions();
  expect(packageJson.dependencies).toEqual({
    "little-workflow": `^${littleWorkflowVersion}`,
    ai: versions.ai,
    zod: versions.zod,
    "@ai-sdk/deepseek": resolveProvider("deepseek").packageVersion,
  });
  expect(packageJson.devDependencies).toEqual(versions.devDependencies);
  // pnpm 10 skips dependency build scripts unless allow-listed; the event store needs this one.
  expect(packageJson.pnpm).toEqual({ onlyBuiltDependencies: ["better-sqlite3"] });
  expect(JSON.stringify(packageJson)).not.toContain('"latest"');
  expect(packageJson.scripts).toMatchObject({
    "test:workflow": "little test candidate-review --input input.example.json",
    typecheck: "tsc --noEmit",
  });
  expect(packageJson.packageManager).toBe("pnpm@10.27.0");
  const workflowTs = await readFile(join(root, "workflows", "candidate-review", "workflow.ts"), "utf8");
  expect(workflowTs).toContain("createLittleWorkflow");
  expect(workflowTs).toContain('id: "candidate.review"');
  expect(workflowTs).toContain('model: deepseek("deepseek-chat")');
  expect(workflowTs).toContain('input: { schema: {\n                      "type": "object"');
  expect(workflowTs).not.toContain("input: { schema: true }");
});

it("addWorkflowToProject writes a workflow folder and updates little-workflow.json", async () => {
  const root = await tmp();
  await writeFile(join(root, "package.json"), `${JSON.stringify({ type: "module", private: true })}\n`);

  await addWorkflowToProject(root, {
    workflowName: "ticket-triage",
    provider: "openai",
    model: "gpt-5.2",
  });

  expect(await exists(join(root, "workflows", "ticket-triage", "workflow.ts"))).toBe(true);
  const manifest = JSON.parse(await readFile(join(root, "little-workflow.json"), "utf8"));
  expect(manifest.workflows["ticket-triage"]).toBe("./workflows/ticket-triage");
});

it("addWorkflowToProject refuses to clobber an existing workflow without force", async () => {
  const root = await tmp();
  await mkdir(join(root, "workflows", "ticket-triage"), { recursive: true });
  await writeFile(join(root, "workflows", "ticket-triage", "README.md"), "# existing\n");

  await expect(addWorkflowToProject(root, { workflowName: "ticket-triage" }))
    .rejects.toThrow(/already exists/i);
});

it("addWorkflowToProject refuses to clobber a manifest entry at a different path without force", async () => {
  const root = await tmp();
  await addWorkflowToProject(root, { workflowName: "foo", dir: "custom" });
  const before = JSON.parse(await readFile(join(root, "little-workflow.json"), "utf8"));
  expect(before.workflows.foo).toBe("./custom/foo");

  await expect(addWorkflowToProject(root, { workflowName: "foo" }))
    .rejects.toThrow(/already registered|already exists/i);

  const after = JSON.parse(await readFile(join(root, "little-workflow.json"), "utf8"));
  expect(after.workflows.foo).toBe("./custom/foo");
});

it("init default emits a model present in the DeepSeek catalog", async () => {
  const { resolveProvider } = await import("little-harness/scaffold");
  const root = join(await tmp(), "demo");
  await initWorkflowProject(root, { workflowName: "candidate-review" });
  const ts = await readFile(join(root, "workflows", "candidate-review", "workflow.ts"), "utf8");
  const emitted = ts.match(/deepseek\("([^"]+)"\)/u)?.[1];
  expect(emitted).toBeDefined();
  expect(resolveProvider("deepseek").models).toContain(emitted);
});

it("initWorkflowProject --here refuses to clobber an existing workflow without force", async () => {
  const root = await tmp();
  const packagePath = join(root, "package.json");
  await mkdir(join(root, "workflows", "alpha"), { recursive: true });
  const workflowPath = join(root, "workflows", "alpha", "workflow.ts");
  await writeFile(packagePath, "{\"scripts\":{\"keep\":\"node keep.js\"}}\n");
  await writeFile(workflowPath, "// existing workflow\n");

  await expect(initWorkflowProject(root, {
    here: true,
    workflowName: "alpha",
  })).rejects.toThrow(/already exists/i);

  expect(await readFile(workflowPath, "utf8")).toBe("// existing workflow\n");
  expect(await readFile(packagePath, "utf8")).toBe("{\"scripts\":{\"keep\":\"node keep.js\"}}\n");
  expect(await exists(join(root, "tsconfig.json"))).toBe(false);
});

it("initWorkflowProject --here preserves existing project scaffold files without force", async () => {
  const root = await tmp();
  const tsconfigPath = join(root, "tsconfig.json");
  const gitignorePath = join(root, ".gitignore");
  const inputPath = join(root, "input.example.json");
  await writeFile(tsconfigPath, "// existing tsconfig\n");
  await writeFile(gitignorePath, "# existing ignore\n");
  await writeFile(inputPath, "{\"existing\": true}\n");

  await initWorkflowProject(root, {
    here: true,
    workflowName: "alpha",
  });

  expect(await readFile(tsconfigPath, "utf8")).toBe("// existing tsconfig\n");
  expect(await readFile(gitignorePath, "utf8")).toBe("# existing ignore\n");
  expect(await readFile(inputPath, "utf8")).toBe("{\"existing\": true}\n");
});

it("initWorkflowProject --here withHarness refuses to clobber an existing workflow shim without force", async () => {
  const root = await tmp();
  const packagePath = join(root, "package.json");
  const shimPath = join(root, "agents", "support", "workflows", "alpha.ts");
  await mkdir(join(root, "agents", "support", "workflows"), { recursive: true });
  await writeFile(packagePath, "{\"scripts\":{\"keep\":\"node keep.js\"}}\n");
  await writeFile(shimPath, "// existing shim\n");

  await expect(initWorkflowProject(root, {
    here: true,
    workflowName: "alpha",
    withHarness: { agentName: "support" },
  })).rejects.toThrow(/already exists/i);

  expect(await readFile(shimPath, "utf8")).toBe("// existing shim\n");
  expect(await readFile(packagePath, "utf8")).toBe("{\"scripts\":{\"keep\":\"node keep.js\"}}\n");
  expect(await exists(join(root, "workflows", "alpha", "workflow.ts"))).toBe(false);
});

it("initWorkflowProject withHarness creates an agent workflow shim", async () => {
  const root = join(await tmp(), "ops-project");
  await initWorkflowProject(root, {
    projectName: "ops-project",
    workflowName: "ticket-triage",
    withHarness: {
      agentName: "support",
      provider: "deepseek",
      model: "deepseek-reasoner",
    },
  });

  expect(await exists(join(root, "little-harness.json"))).toBe(true);
  expect(await exists(join(root, "agents", "support", "agent.ts"))).toBe(true);
  expect(await exists(join(root, "agents", "support", "workflows", "ticket-triage.ts"))).toBe(true);
  const shim = await readFile(join(root, "agents", "support", "workflows", "ticket-triage.ts"), "utf8");
  expect(shim).toContain('from "little-workflow"');
  expect(shim).toContain('new URL("../../../workflows/ticket-triage", import.meta.url)');
  expect(shim).toContain('executionMode: "durable"');
  const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  expect(packageJson.dependencies).toMatchObject({
    "little-harness": scaffoldDependencyVersions().littleHarness,
    "little-workflow": `^${littleWorkflowVersion}`,
  });
});

it("addHarnessToWorkflowProject can create a new workflow and shim in the current project", async () => {
  const root = await tmp();
  await writeFile(join(root, "package.json"), `${JSON.stringify({ type: "module", private: true })}\n`);

  await addHarnessToWorkflowProject(root, {
    agentName: "support",
    newWorkflowName: "candidate-review",
    provider: "deepseek",
    model: "deepseek-reasoner",
  });

  expect(await exists(join(root, "workflows", "candidate-review", "workflow.ts"))).toBe(true);
  expect(await exists(join(root, "agents", "support", "workflows", "candidate-review.ts"))).toBe(true);
});

it("addHarnessToWorkflowProject uses manifest paths for existing workflow shims", async () => {
  const root = await tmp();
  await writeFile(join(root, "package.json"), `${JSON.stringify({ type: "module", private: true })}\n`);
  await addWorkflowToProject(root, {
    workflowName: "beta",
    dir: "automation/workflows",
    provider: "deepseek",
    model: "deepseek-reasoner",
  });

  await addHarnessToWorkflowProject(root, {
    agentName: "support",
    workflowName: "beta",
    provider: "deepseek",
    model: "deepseek-reasoner",
  });

  const shim = await readFile(join(root, "agents", "support", "workflows", "beta.ts"), "utf8");
  expect(shim).toContain('new URL("../../../automation/workflows/beta", import.meta.url)');
});

it("addHarnessToWorkflowProject does not clobber an existing agent without force", async () => {
  const root = await tmp();
  await addWorkflowToProject(root, { workflowName: "alpha" });
  await mkdir(join(root, "agents", "support"), { recursive: true });
  await writeFile(join(root, "agents", "support", "agent.ts"), "// keep me\n");

  await addHarnessToWorkflowProject(root, {
    agentName: "support",
    workflowName: "alpha",
  });

  expect(await readFile(join(root, "agents", "support", "agent.ts"), "utf8")).toBe("// keep me\n");
});

it("addHarnessToWorkflowProject honors an existing custom harness agents root", async () => {
  const root = await tmp();
  await addWorkflowToProject(root, { workflowName: "alpha" });
  await writeFile(join(root, "little-harness.json"), `${JSON.stringify({ agents: "custom-agents" })}\n`);

  await addHarnessToWorkflowProject(root, {
    agentName: "support",
    workflowName: "alpha",
  });

  expect(await exists(join(root, "custom-agents", "support", "agent.ts"))).toBe(true);
  expect(await exists(join(root, "custom-agents", "support", "workflows", "alpha.ts"))).toBe(true);
  expect(await exists(join(root, "agents", "support", "agent.ts"))).toBe(false);
});

it("addWorkflowToProject rejects workflow directories outside the project root", async () => {
  const root = await tmp();

  await expect(addWorkflowToProject(root, {
    workflowName: "outside",
    dir: "../outside",
  })).rejects.toThrow(/escapes/i);
});

it("addHarnessToWorkflowProject fails for an unknown existing workflow", async () => {
  const root = await tmp();
  await writeFile(join(root, "little-workflow.json"), `${JSON.stringify({ workflows: {} })}\n`);

  await expect(addHarnessToWorkflowProject(root, {
    agentName: "support",
    workflowName: "missing",
  })).rejects.toThrow(/unknown workflow/i);
});
