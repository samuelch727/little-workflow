import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  computeCompiledWorkflowVersionIdentity,
  computeCompilerValidationHash,
  lwirVersionIdForHash,
  type WorkflowVersionLockSeed,
} from "./compiler-lock.js";
import {
  workflowHarness,
  type ExecuteStepTask,
  type HarnessContext,
  type LwirWorkflow,
  createWorkflowHarness,
  type Harness,
  type RuntimeToolHandler,
  RuntimeMaxVisitsError,
  appendEvent,
  canonicalJson,
  createLittleWorkflow,
  createToolRegistry,
  executeWorkflowVersion,
  listEvents,
  localWorld,
  materializeRunState,
  model,
  readArtifact,
  runWorkflow,
  sha256Digest,
  skill,
  stepPathFor,
  writeArtifact,
} from "./index.js";
import { normalizeBashCapabilities } from "./bash-tool.js";
import { hashHarnessManifest, workerManifest } from "./manifests.js";
import { normalizeSchema } from "./schema.js";
import { resolveSkills as resolveWorkflowSkills } from "./skills.js";
import { cleanupTempDirs, workerScopedTempPrefix } from "./test-temp.js";
import { concreteInputStructure } from "./workflow-version-reuse.js";

const tempDirs: string[] = [];
const execFileAsync = promisify(execFile);

async function tempWorld() {
  const dataDir = await mkdtemp(
    join(tmpdir(), workerScopedTempPrefix("little-workflow-runtime-", process.env.VITEST_POOL_ID)),
  );
  tempDirs.push(dataDir);
  return localWorld({ dataDir });
}

function sha256TextDigest(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

async function appendTestExecuteStepEvent(
  ctx: HarnessContext,
  task: ExecuteStepTask,
  type: "harness.execute_step.started" | "harness.execute_step.succeeded",
  extra: Record<string, unknown> = {},
): Promise<void> {
  await ctx.durability.append({
    type,
    runId: ctx.session.runId,
    payload: {
      runId: ctx.session.runId,
      stepId: task.step.id,
      uses: task.step.uses,
      stepPath: task.stepContext.stepPath,
      visitIndex: task.stepContext.visitIndex,
      ...extra,
    } as never,
  });
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await cleanupTempDirs(tempDirs);
});

const runtimeWorkerModel = model(
  { provider: "test", modelId: "runtime-worker-model" },
  { description: "Runtime test worker model." },
);

async function writeRuntimeSkill(root: string, name: string): Promise<string> {
  const skillDir = join(root, name);
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} skill.\n---\n\nUse ${name}.\n`,
    "utf8",
  );
  return skillDir;
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", [...args], { cwd });
  return stdout.trim();
}

async function initRepo(repoDir: string): Promise<void> {
  await mkdir(repoDir, { recursive: true });
  await git(repoDir, ["init", "-b", "main"]);
  await git(repoDir, ["config", "user.name", "Little Workflow Tests"]);
  await git(repoDir, ["config", "user.email", "tests@example.com"]);
}

async function commitAll(repoDir: string, message: string): Promise<string> {
  await git(repoDir, ["add", "."]);
  await git(repoDir, ["commit", "-m", message]);
  return git(repoDir, ["rev-parse", "HEAD"]);
}

async function writeRepoSkill(repoDir: string, name: string): Promise<void> {
  const skillDir = join(repoDir, "skills", name);
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} remote skill.\n---\n\nUse ${name}.\n`,
    "utf8",
  );
}

{
  type ExecuteWorkflowVersionInput = Parameters<typeof executeWorkflowVersion>[0];
  const _legacyAiOption: ExecuteWorkflowVersionInput = {
    world: localWorld({ dataDir: "/tmp/lwf-types" }),
    workflowVersion: {
      id: "wfver_types",
      lwir: {
        apiVersion: "littleworkflow.dev/v0.1",
        kind: "Workflow",
        metadata: { name: "types" },
        input: { schema: { type: "object" } },
        output: { schema: { type: "object" } },
        steps: [],
      },
    },
    input: {},
    // @ts-expect-error legacy ai option should not be accepted once Task 24 is complete
    ai: {
      generate: async () => ({ output: {} }),
    },
  };
  void _legacyAiOption;

  const _legacyCodeRunnerOption: ExecuteWorkflowVersionInput = {
    world: localWorld({ dataDir: "/tmp/lwf-types" }),
    workflowVersion: {
      id: "wfver_types",
      lwir: {
        apiVersion: "littleworkflow.dev/v0.1",
        kind: "Workflow",
        metadata: { name: "types" },
        input: { schema: { type: "object" } },
        output: { schema: { type: "object" } },
        steps: [],
      },
    },
    input: {},
    // @ts-expect-error legacy codeRunner option should not be accepted once Task 24 is complete
    codeRunner: {
      run: () => ({}),
    },
  };
  void _legacyCodeRunnerOption;
}

describe("serial runtime executor", () => {
  it("mounts planner skills under .agents/skills and bash reads them from the default cwd", async () => {
    const world = await tempWorld();
    const skillDir = join(world.dataDir, "local-skills", "planner-guide");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      `---
name: planner-guide
description: Inspect planner context skill mounts.
---

Use this skill.
`,
      "utf8",
    );
    const plannerHarness = {
      harnessId: "relativeSkillPlannerHarness@1.0.0",
      async run(task, ctx) {
        if (task.kind !== "plan") {
          return { kind: "delegate_to_default" } as const;
        }
        expect(ctx.skills).toEqual([
          expect.objectContaining({
            name: "planner-guide",
            mountPath: ".agents/skills/planner-guide/",
          }),
        ]);
        expect(ctx.mounts).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              mountPath: ".agents/skills/planner-guide/",
              mode: "ro",
            }),
          ]),
        );
        expect(JSON.stringify(ctx)).not.toContain("/mnt/skills");
        const bashResult = await ctx.bash?.execute({ cmd: "cat .agents/skills/planner-guide/SKILL.md" });
        expect(bashResult).toMatchObject({
          exitCode: 0,
          stdout: expect.stringContaining("name: planner-guide"),
        });
        await expect(ctx.bash?.execute({ cmd: "pwd" })).resolves.toMatchObject({
          exitCode: 0,
          stdout: "/mnt/scratch/own\n",
        });
        return {
          kind: "plan",
          lwir: {
            apiVersion: "littleworkflow.dev/v0.1",
            kind: "Workflow",
            metadata: { name: "runtime.relative-skill-mount" },
            input: {
              schema: {
                type: "object",
                additionalProperties: false,
                properties: {},
              },
            },
            output: {
              schema: {
                type: "object",
                additionalProperties: false,
                properties: {
                  ok: { type: "boolean" },
                },
              },
            },
            permissions: { tools: ["done"] },
            steps: [
              {
                id: "done",
                uses: "tool.call",
                with: { tool: "done" },
                output: {
                  mode: "object",
                  schema: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      ok: { type: "boolean" },
                    },
                  },
                },
              },
            ],
          },
        } as const;
      },
    } satisfies Harness & { readonly harnessId: string };
    const workflow = createLittleWorkflow({
      id: "runtime.relative-skill-mount",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean" },
        },
      },
      models: [runtimeWorkerModel],
      planner: {
        model: { provider: "test", modelId: "planner" },
        harness: plannerHarness,
        skills: [skill(skillDir)],
      },
      globalTools: ["done"],
    });
    const tools = createToolRegistry({
      done: {
        description: "Return a completed result.",
        execute: async () => ({ ok: true }),
      },
    });

    const result = await runWorkflow({
      world,
      workflows: workflow,
      input: {},
      tools,
      runId: "run_runtime_relative_skill_mount",
    });

    expect(result.status).toBe("completed");
  });

  it("mounts single-file planner skills as SKILL.md without source siblings", async () => {
    const world = await tempWorld();
    const skillsDir = join(world.dataDir, "single-file-skills");
    await mkdir(skillsDir, { recursive: true });
    const skillFile = join(skillsDir, "output-schema-validation.md");
    await writeFile(
      skillFile,
      `---
name: output-schema-validation
description: Validate ai.generate output against declared schemas.
---

Use this skill.
`,
      "utf8",
    );
    await writeFile(join(skillsDir, "secret.md"), "hidden\n", "utf8");
    const plannerHarness = {
      harnessId: "singleFileSkillPlannerHarness@1.0.0",
      async run(task, ctx) {
        if (task.kind !== "plan") {
          return { kind: "delegate_to_default" } as const;
        }
        expect(ctx.skills).toEqual([
          expect.objectContaining({
            name: "output-schema-validation",
            mountPath: ".agents/skills/output-schema-validation/SKILL.md",
          }),
        ]);
        const read = await ctx.bash?.execute({ cmd: "cat .agents/skills/output-schema-validation/SKILL.md" });
        expect(read).toMatchObject({
          exitCode: 0,
          stdout: expect.stringContaining("name: output-schema-validation"),
        });
        await expect(ctx.bash?.execute({ cmd: "pwd" })).resolves.toMatchObject({
          exitCode: 0,
          stdout: "/mnt/scratch/own\n",
        });
        await expect(ctx.bash?.execute({
          cmd: "test ! -e .agents/skills/output-schema-validation/output-schema-validation.md && test ! -e .agents/skills/output-schema-validation/secret.md",
        })).resolves.toMatchObject({ exitCode: 0 });
        return {
          kind: "plan",
          lwir: {
            apiVersion: "littleworkflow.dev/v0.1",
            kind: "Workflow",
            metadata: { name: "runtime.single-file-skill-mount" },
            input: { schema: { type: "object", additionalProperties: false, properties: {} } },
            output: { schema: { type: "object", additionalProperties: false, properties: { ok: { type: "boolean" } } } },
            permissions: { tools: ["done"] },
            steps: [{
              id: "done",
              uses: "tool.call",
              with: { tool: "done" },
              output: { mode: "object", schema: { type: "object" } },
            }],
          },
        } as const;
      },
    } satisfies Harness & { readonly harnessId: string };
    const workflow = createLittleWorkflow({
      id: "runtime.single-file-skill-mount",
      inputSchema: { type: "object", additionalProperties: false, properties: {} },
      outputSchema: { type: "object", additionalProperties: false, properties: { ok: { type: "boolean" } } },
      models: [runtimeWorkerModel],
      planner: {
        model: { provider: "test", modelId: "planner" },
        harness: plannerHarness,
        skills: [skill(skillFile)],
      },
      globalTools: ["done"],
    });

    const result = await runWorkflow({
      world,
      workflows: workflow,
      input: {},
      tools: createToolRegistry({
        done: { description: "Return a completed result.", execute: async () => ({ ok: true }) },
      }),
      runId: "run_runtime_single_file_skill_mount",
    });

    expect(result.status).toBe("completed");
  });

  it("mounts remote Git planner skills from materialized files", async () => {
    const world = await tempWorld();
    const repoDir = join(world.dataDir, "remote-skill-repo");
    await initRepo(repoDir);
    await writeRepoSkill(repoDir, "remote-guide");
    const sha = await commitAll(repoDir, "add remote guide");
    const plannerHarness = {
      harnessId: "remoteSkillPlannerHarness@1.0.0",
      async run(task, ctx) {
        if (task.kind !== "plan") {
          return { kind: "delegate_to_default" } as const;
        }
        expect(ctx.skills).toEqual([
          expect.objectContaining({
            name: "remote-guide",
            source: expect.not.stringContaining("file://"),
            remote: expect.objectContaining({
              commitSha: sha,
              normalizedSource: pathToFileURL(repoDir).href,
            }),
          }),
        ]);
        const bashResult = await ctx.bash?.execute({ cmd: "cat .agents/skills/remote-guide/SKILL.md" });
        expect(bashResult).toMatchObject({
          exitCode: 0,
          stdout: expect.stringContaining("name: remote-guide"),
        });
        return {
          kind: "plan",
          lwir: {
            apiVersion: "littleworkflow.dev/v0.1",
            kind: "Workflow",
            metadata: { name: "runtime.remote-skill-mount" },
            input: { schema: { type: "object", additionalProperties: false, properties: {} } },
            output: {
              schema: {
                type: "object",
                additionalProperties: false,
                properties: { ok: { type: "boolean" } },
              },
            },
            permissions: { tools: ["done"] },
            steps: [{
              id: "done",
              uses: "tool.call",
              with: { tool: "done" },
              output: { mode: "object", schema: { type: "object" } },
            }],
          },
        } as const;
      },
    } satisfies Harness & { readonly harnessId: string };
    const workflow = createLittleWorkflow({
      id: "runtime.remote-skill-mount",
      inputSchema: { type: "object", additionalProperties: false, properties: {} },
      outputSchema: { type: "object", additionalProperties: false, properties: { ok: { type: "boolean" } } },
      models: [runtimeWorkerModel],
      planner: {
        model: { provider: "test", modelId: "planner" },
        harness: plannerHarness,
        skills: [skill(`${pathToFileURL(repoDir).href}#${sha}`, { skills: ["remote-guide"] })],
      },
      globalTools: ["done"],
    });

    const result = await runWorkflow({
      world,
      workflows: workflow,
      input: {},
      tools: createToolRegistry({
        done: { description: "Return a completed result.", execute: async () => ({ ok: true }) },
      }),
      runId: "run_runtime_remote_skill_mount",
    });

    expect(result.status).toBe("completed");
  });

  it("mounts orchestrator skills under .agents/skills and bash reads them from the default cwd", async () => {
    const world = await tempWorld();
    const skillDir = await writeRuntimeSkill(join(world.dataDir, "local-skills"), "orchestrator-guide");
    const workflow = createLittleWorkflow({
      id: "runtime.orchestrator-relative-skill",
      inputSchema: { type: "object", additionalProperties: false, properties: {} },
      outputSchema: { type: "object", additionalProperties: false, properties: { ok: { type: "boolean" } } },
      models: [runtimeWorkerModel],
      planner: {
        model: { provider: "test", modelId: "planner" },
        harness: {
          harnessId: "orchestratorSkillPlannerHarness@1.0.0",
          async run(task) {
            if (task.kind !== "plan") return { kind: "delegate_to_default" } as const;
            return {
              kind: "plan",
              lwir: {
                apiVersion: "littleworkflow.dev/v0.1",
                kind: "Workflow",
                metadata: { name: "runtime.orchestrator-relative-skill" },
                input: { schema: { type: "object", additionalProperties: false, properties: {} } },
                output: { schema: { type: "object", additionalProperties: false, properties: { ok: { type: "boolean" } } } },
                permissions: { tools: ["done"] },
                steps: [{ id: "done", uses: "tool.call", with: { tool: "done" }, output: { mode: "object", schema: { type: "object" } } }],
              },
            } as const;
          },
        } satisfies Harness & { readonly harnessId: string },
      },
      globalTools: ["done"],
    });
    const orchestratorHarness = {
      harnessId: "orchestratorSkillHarness@1.0.0",
      async run(task, ctx) {
        if (task.kind !== "orchestrate") return { kind: "delegate_to_default" } as const;
        expect(ctx.skills).toEqual([
          expect.objectContaining({ name: "orchestrator-guide", mountPath: ".agents/skills/orchestrator-guide/" }),
        ]);
        const bashResult = await ctx.bash?.execute({ cmd: "cat .agents/skills/orchestrator-guide/SKILL.md" });
        expect(bashResult).toMatchObject({ exitCode: 0, stdout: expect.stringContaining("name: orchestrator-guide") });
        await expect(ctx.bash?.execute({ cmd: "pwd" })).resolves.toMatchObject({
          exitCode: 0,
          stdout: "/mnt/scratch/own\n",
        });
        return { kind: "orchestrate", output: { ok: true } } as const;
      },
    } satisfies Harness & { readonly harnessId: string };

    const result = await runWorkflow({
      world,
      workflows: [workflow],
      input: {},
      tools: createToolRegistry({ done: { description: "done", execute: async () => ({ ok: true }) } }),
      orchestrator: {
        model: { provider: "test", modelId: "orchestrator" },
        harness: orchestratorHarness,
        skills: [skill(skillDir)],
      },
      runId: "run_runtime_orchestrator_relative_skill",
    });

    expect(result.status).toBe("completed");
  });

  it("mounts worker skills for worker and fixer bash reads under .agents/skills", async () => {
    const world = await tempWorld();
    const skillDir = await writeRuntimeSkill(join(world.dataDir, "local-skills"), "worker-guide");
    const [workerSkill] = await resolveWorkflowSkills([skill(skillDir)], { baseDir: world.dataDir });
    const workerHarness = {
      harnessId: "workerFixerSkillHarness@1.0.0",
      async run(task, ctx) {
        if (task.kind === "execute_step" && task.step.uses === "ai.generate") {
          const bashResult = await ctx.bash?.execute({ cmd: "cat .agents/skills/worker-guide/SKILL.md" });
          expect(bashResult).toMatchObject({ exitCode: 0, stdout: expect.stringContaining("name: worker-guide") });
          await expect(ctx.bash?.execute({ cmd: "pwd" })).resolves.toMatchObject({
            exitCode: 0,
            stdout: "/mnt/scratch/own\n",
          });
          return { kind: "execute_step", output: { value: 7 }, artifactRefs: [] } as const;
        }
        if (task.kind === "execute_step" && task.step.uses === "code.run") {
          throw new Error("trigger fixer");
        }
        if (task.kind === "fix_step") {
          const bashResult = await ctx.bash?.execute({ cmd: "cat .agents/skills/worker-guide/SKILL.md" });
          expect(bashResult).toMatchObject({ exitCode: 0, stdout: expect.stringContaining("name: worker-guide") });
          await expect(ctx.bash?.execute({ cmd: "pwd" })).resolves.toMatchObject({
            exitCode: 0,
            stdout: "/mnt/scratch/own\n",
          });
          return {
            kind: "fix_step",
            output: { value: 42 },
            fixedSource: "async () => ({ value: 42 })",
            attempts: 1,
          } as const;
        }
        return { kind: "delegate_to_default" } as const;
      },
    } satisfies Harness & { readonly harnessId: string };

    const workerResult = await executeWorkflowVersion({
      world,
      workflowVersion: lockedWorkflowVersion(
        "wfver_worker_relative_skill",
        {
          apiVersion: "littleworkflow.dev/v0.1",
          kind: "Workflow",
          metadata: { name: "runtime.worker-relative-skill" },
          input: { schema: { type: "object" } },
          output: { schema: { type: "object", required: ["value"], additionalProperties: false, properties: { value: { type: "number" } } } },
          permissions: { models: ["model.fast"] },
          steps: [{
            id: "generate",
            uses: "ai.generate",
            with: { model: "model.fast", prompt: "Return a value." },
            output: { mode: "object", schema: { type: "object", required: ["value"], additionalProperties: false, properties: { value: { type: "number" } } } },
          }],
        },
        { models: { "model.fast": { provider: "test", modelId: "fast" } } },
      ),
      input: {},
      runId: "run_runtime_worker_relative_skill",
      models: { "model.fast": { provider: "test", modelId: "fast" } },
      workerHarness,
      workerSkills: [workerSkill!],
    });
    expect(workerResult.status).toBe("completed");

    const result = await executeWorkflowVersion({
      world,
      workflowVersion: lockedWorkflowVersion(
        "wfver_worker_fixer_relative_skill",
        {
          apiVersion: "littleworkflow.dev/v0.1",
          kind: "Workflow",
          metadata: { name: "runtime.worker-fixer-relative-skill" },
          input: { schema: { type: "object" } },
          output: { schema: { type: "object", required: ["value"], additionalProperties: false, properties: { value: { type: "number" } } } },
          permissions: { models: ["model.fast"] },
          steps: [{
            id: "compute",
            uses: "code.run",
            with: { source: "async () => ({ value: 1 })" },
            onFailure: {
              fixer: {
                model: "model.fast",
                maxAttempts: 1,
                system: "Fix failed code output.",
              },
            },
            output: { mode: "object", schema: { type: "object", required: ["value"], additionalProperties: false, properties: { value: { type: "number" } } } },
          }],
        },
        { models: { "model.fast": { provider: "test", modelId: "fast" } } },
      ),
      input: {},
      runId: "run_runtime_worker_fixer_relative_skill",
      models: { "model.fast": { provider: "test", modelId: "fast" } },
      workerHarness,
      workerSkills: [workerSkill!],
    });

    expect(result.status).toBe("completed");
  });

  it("passes worker skills to direct tool.call and code.run worker harness contexts", async () => {
    const world = await tempWorld();
    const skillDir = await writeRuntimeSkill(join(world.dataDir, "local-skills"), "direct-worker-guide");
    const [workerSkill] = await resolveWorkflowSkills([skill(skillDir)], { baseDir: world.dataDir });
    const emptySkillsHash = sha256Digest([]);
    const seen: string[] = [];
    const workerHarness = {
      harnessId: "directWorkerSkillHarness@1.0.0",
      async run(task, ctx) {
        if (task.kind !== "execute_step") {
          return { kind: "delegate_to_default" } as const;
        }
        if (task.step.uses !== "tool.call" && task.step.uses !== "code.run") {
          return { kind: "delegate_to_default" } as const;
        }
        seen.push(task.step.uses);
        expect(ctx.skills).toEqual([
          expect.objectContaining({ name: "direct-worker-guide", mountPath: ".agents/skills/direct-worker-guide/" }),
        ]);
        const manifest = ctx.session?.manifest as { readonly skillsHash?: unknown } | undefined;
        expect(manifest?.skillsHash).not.toBe(emptySkillsHash);
        const bashResult = await ctx.bash?.execute({ cmd: "cat .agents/skills/direct-worker-guide/SKILL.md" });
        expect(bashResult).toMatchObject({
          exitCode: 0,
          stdout: expect.stringContaining("name: direct-worker-guide"),
        });
        await expect(ctx.bash?.execute({ cmd: "pwd" })).resolves.toMatchObject({
          exitCode: 0,
          stdout: "/mnt/scratch/own\n",
        });
        return {
          kind: "execute_step",
          output: { value: task.step.uses },
          artifactRefs: [],
        } as const;
      },
    } satisfies Harness & { readonly harnessId: string };
    const tools = createToolRegistry({
      lookup: { description: "lookup", execute: async () => ({ value: "tool" }) },
    });

    const toolWorkflow = lockedWorkflowVersion(
      "wfver_direct_tool_worker_skills",
      {
        apiVersion: "littleworkflow.dev/v0.1",
        kind: "Workflow",
        metadata: { name: "runtime.direct-tool-worker-skills" },
        input: { schema: { type: "object" } },
        output: { schema: { type: "object", required: ["value"], additionalProperties: false, properties: { value: { type: "string" } } } },
        permissions: { tools: ["lookup"] },
        steps: [{
          id: "lookup",
          uses: "tool.call",
          with: { tool: "lookup" },
          output: { mode: "object", schema: { type: "object", required: ["value"], additionalProperties: false, properties: { value: { type: "string" } } } },
        }],
      },
      { tools },
    );
    const codeWorkflow = lockedWorkflowVersion(
      "wfver_direct_code_worker_skills",
      {
        apiVersion: "littleworkflow.dev/v0.1",
        kind: "Workflow",
        metadata: { name: "runtime.direct-code-worker-skills" },
        input: { schema: { type: "object" } },
        output: { schema: { type: "object", required: ["value"], additionalProperties: false, properties: { value: { type: "string" } } } },
        permissions: { tools: ["lookup"] },
        steps: [{
          id: "compute",
          uses: "code.run",
          with: { source: "async () => ({ value: 'code' })" },
          output: { mode: "object", schema: { type: "object", required: ["value"], additionalProperties: false, properties: { value: { type: "string" } } } },
        }],
      },
      { tools },
    );

    const toolResult = await executeWorkflowVersion({
      world,
      workflowVersion: toolWorkflow,
      input: {},
      runId: "run_direct_tool_worker_skills",
      tools,
      workerHarness,
      workerSkills: [workerSkill!],
    });
    const codeResult = await executeWorkflowVersion({
      world,
      workflowVersion: codeWorkflow,
      input: {},
      runId: "run_direct_code_worker_skills",
      tools,
      workerHarness,
      workerSkills: [workerSkill!],
    });

    expect(toolResult.status).toBe("completed");
    expect(codeResult.status).toBe("completed");
    expect(seen).toEqual(["tool.call", "code.run"]);
  });

  it("inherits the parent's permission denies into a delegated sub-run worker", async () => {
    const world = await tempWorld();
    let orchestratorPermissions: unknown;
    let workerPermissions: unknown;
    const plannerHarness = {
      harnessId: "permInheritPlannerHarness@1.0.0",
      async run(task: { readonly kind: string }) {
        if (task.kind !== "plan") {
          return { kind: "delegate_to_default" } as const;
        }
        return {
          kind: "plan",
          lwir: {
            apiVersion: "littleworkflow.dev/v0.1",
            kind: "Workflow",
            metadata: { name: "runtime.permissions.inherit" },
            input: { schema: { type: "object", additionalProperties: false, properties: {} } },
            output: {
              schema: {
                type: "object",
                additionalProperties: false,
                properties: { ok: { type: "boolean" } },
              },
            },
            permissions: { models: ["writer"] },
            steps: [
              {
                id: "done",
                uses: "ai.generate",
                with: { model: "writer" },
                output: {
                  mode: "object",
                  schema: {
                    type: "object",
                    additionalProperties: false,
                    properties: { ok: { type: "boolean" } },
                  },
                },
              },
            ],
          },
        } as const;
      },
    } satisfies Harness & { readonly harnessId: string };
    const workerHarness = {
      harnessId: "permInheritWorkerHarness@1.0.0",
      async run(task, ctx) {
        if (task.kind !== "execute_step" || task.step.uses !== "ai.generate") {
          return { kind: "delegate_to_default" } as const;
        }
        workerPermissions = ctx.permissions;
        return { kind: "execute_step", output: { ok: true }, artifactRefs: [] } as const;
      },
    } satisfies Harness & { readonly harnessId: string };
    const workflow = createLittleWorkflow({
      id: "runtime.permissions.inherit",
      inputSchema: { type: "object", additionalProperties: false, properties: {} },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { ok: { type: "boolean" } },
      },
      models: [model({ provider: "test", modelId: "writer" }, { id: "writer" })],
      planner: { model: { provider: "test", modelId: "planner" }, harness: plannerHarness },
      worker: { harness: workerHarness },
    });
    const orchestratorHarness = {
      harnessId: "permInheritOrchestratorHarness@1.0.0",
      async run(task, ctx) {
        if (task.kind !== "orchestrate") {
          return { kind: "delegate_to_default" } as const;
        }
        orchestratorPermissions = ctx.permissions;
        const plan = ctx.tools.plan_workflow as { execute?: (input: unknown) => Promise<unknown> };
        const run = ctx.tools.run_workflow as { execute?: (input: unknown) => Promise<unknown> };
        const planned = (await plan.execute?.({
          workflowId: "runtime.permissions.inherit",
          input: {},
        })) as { readonly workflowVersionId: string };
        const executed = await run.execute?.({
          workflowVersionId: planned.workflowVersionId,
          input: {},
        });
        return { kind: "orchestrate", output: executed } as const;
      },
    } satisfies Harness & { readonly harnessId: string };

    const result = await runWorkflow({
      world,
      workflows: [workflow],
      input: {},
      orchestrator: {
        model: { provider: "test", modelId: "orchestrator" },
        harness: orchestratorHarness,
      },
      runId: "run_permissions_inherit",
      permissions: {
        ruleset: [
          { tool: "secret_tool", action: "deny" },
          { tool: "audit_log", action: "ask" },
        ],
      },
    });

    expect(result.status).toBe("completed");
    // The orchestrator (the policy owner) sees the full ruleset.
    expect(orchestratorPermissions).toEqual({
      ruleset: [
        { tool: "secret_tool", action: "deny" },
        { tool: "audit_log", action: "ask" },
      ],
    });
    // The delegated sub-run inherits only the parent's DENY — the hard floor it
    // cannot escape. The parent's "ask" stays where approval happens (the parent).
    expect(workerPermissions).toEqual({ ruleset: [{ tool: "secret_tool", action: "deny" }] });
  });

  it("executes a simple LWIR DAG serially and records durable result envelopes", async () => {
    const world = await tempWorld();
    const calls: string[] = [];
    const lookup = vi.fn((input: unknown) => {
      calls.push("lookup");
      expect(input).toEqual({ name: "Ada" });
      return { profile: { name: "Ada", title: "Engineer" } };
    });
    const directStepHarness = createWorkflowHarness();
    const workerHarness = {
      harnessId: "aiOnlyRuntimeDagHarness@1.0.0",
      async run(task, ctx) {
        if (task.kind === "execute_step" && task.step.uses === "ai.generate") {
          calls.push(task.step.id);
          if (task.step.id === "extract") {
            expect(ctx.model.model).toEqual({ provider: "mock", id: "structured" });
            expect(task.stepInput).toEqual({
              profile: { name: "Ada", title: "Engineer" },
              request: "write a note",
            });
            return {
              kind: "execute_step",
              output: { profile: { name: "Ada", seniority: "principal" } },
              artifactRefs: [],
            };
          }

          expect(task.step.id).toBe("draft");
          expect(ctx.model.model).toEqual({ provider: "mock", id: "writer" });
          expect(task.stepInput).toEqual({ name: "Ada", seniority: "principal" });
          return {
            kind: "execute_step",
            output: "Ada is a principal engineer.",
            artifactRefs: [],
          };
        }
        return directStepHarness.run(task, ctx);
      },
    } satisfies Harness & { readonly harnessId: string };
    const result = await executeWorkflowVersion({
      world,
      workflowVersion: lockedWorkflowVersion("wfver_runtime_dag", workflow(), {
        models: {
          structured: { provider: "mock", id: "structured" },
          writer: { provider: "mock", id: "writer" },
        },
        tools: registryFor({ lookup }),
      }),
      runId: "run_runtime_dag",
      input: { name: "Ada", request: "write a note" },
      models: {
        structured: { provider: "mock", id: "structured" },
        writer: { provider: "mock", id: "writer" },
      },
      tools: registryFor({ lookup }),
      workerHarness,
    });

    expect(calls).toEqual(["lookup", "extract", "draft"]);
    if (result.status !== "completed") {
      throw new Error("Expected runtime DAG to complete.");
    }
    expect(result).toEqual(
      expect.objectContaining({
        runId: "run_runtime_dag",
        workflowVersionId: expect.stringMatching(/^wfver_[0-9a-f]{16}$/),
        status: "completed",
        output: "Ada is a principal engineer.",
        usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      }),
    );
    expect(result.artifacts).toHaveLength(3);
    expect(result.outputRef).toBe(result.artifacts.at(-1));

    const outputArtifact = await readArtifact(world, result.outputRef);
    expect(outputArtifact.payload).toEqual("Ada is a principal engineer.");

    const state = await materializeRunState(world, "run_runtime_dag");
    expect(state.status).toBe("completed");
    expect(state.steps.draft).toEqual(
      expect.objectContaining({
        status: "completed",
        output: "Ada is a principal engineer.",
        outputRef: result.outputRef,
        metadata: expect.objectContaining({ outputMode: "text" }),
      }),
    );

    const events = await listEvents(world, "run_runtime_dag");
    expect(events.map((event) => event.type)).toContain("harness.tool_call.started");
    expect(events.map((event) => event.type)).toContain("harness.tool_call.succeeded");
    expect(events.map((event) => event.type)).toContain("harness.session.started");
    expect(events.map((event) => event.type)).toContain("harness.session.completed");
    expect(events.map((event) => event.type)).not.toContain("ToolCallStarted");
    expect(events.map((event) => event.type)).not.toContain("ModelCallStarted");
    expect(events.map((event) => event.type)).not.toContain("harness.model.responded");
  });

  it("passes the active cancellation signal to ai.generate and tool.call worker-harness paths", async () => {
    const world = await tempWorld();
    const controller = new AbortController();
    const seenSignals: AbortSignal[] = [];
    const lookup = vi.fn<RuntimeToolHandler>((_input, context) => {
      const signal = (context as { readonly abortSignal?: AbortSignal }).abortSignal ?? context.signal;
      if (signal !== undefined) {
        seenSignals.push(signal);
      }
      return { profile: { name: "Ada", title: "Engineer" } };
    });
    const directStepHarness = createWorkflowHarness();
    const workerHarness = {
      harnessId: "aiOnlyRuntimeSignalsHarness@1.0.0",
      async run(task, ctx) {
        if (task.kind === "execute_step" && task.step.uses === "ai.generate") {
          seenSignals.push(ctx.abortSignal);
          return task.step.id === "extract"
            ? {
                kind: "execute_step",
                output: { profile: { name: "Ada", seniority: "principal" } },
                artifactRefs: [],
              }
            : {
                kind: "execute_step",
                output: "Ada is a principal engineer.",
                artifactRefs: [],
              };
        }
        return directStepHarness.run(task, ctx);
      },
    } satisfies Harness & { readonly harnessId: string };
    const result = await executeWorkflowVersion({
      world,
      workflowVersion: lockedWorkflowVersion("wfver_runtime_signals", workflow(), {
        models: {
          structured: { provider: "mock", id: "structured" },
          writer: { provider: "mock", id: "writer" },
        },
        tools: registryFor({ lookup }),
      }),
      runId: "run_runtime_signals",
      input: { name: "Ada", request: "write a note" },
      signal: controller.signal,
      models: {
        structured: { provider: "mock", id: "structured" },
        writer: { provider: "mock", id: "writer" },
      },
      tools: registryFor({ lookup }),
      workerHarness,
    });

    expect(result.status).toBe("completed");
    expect(seenSignals).toEqual([
      controller.signal,
      controller.signal,
      controller.signal,
    ]);
  });

  it("runs tool steps through the worker harness and emits harness tool events", async () => {
    const world = await tempWorld();
    const summarize = vi.fn<RuntimeToolHandler>(() => ({ summary: "ok" }));
    const tools = registryFor({ first: summarize });
    const workflowVersion = lockedWorkflowVersion(
      "wfver_worker_harness_tool",
      oneStepWorkflow(),
      { tools },
    );

    const result = await executeWorkflowVersion({
      world,
      workflowVersion,
      runId: "run_worker_harness_tool",
      input: {},
      tools,
      workerHarness: workflowHarness,
    });

    expect(result.status).toBe("completed");
    expect(summarize).toHaveBeenCalledTimes(1);

    const events = await listEvents(world, "run_worker_harness_tool");
    expect(events.map((event) => event.type)).toContain("harness.session.started");
    expect(events.map((event) => event.type)).toContain("harness.session.completed");
    expect(events.map((event) => event.type)).not.toContain("HarnessSessionStarted");
    expect(events.map((event) => event.type)).not.toContain("HarnessSessionCompleted");
    expect(events.map((event) => event.type)).toContain("harness.execute_step.started");
    expect(events.map((event) => event.type)).toContain("harness.tool_call.started");
    expect(events.map((event) => event.type)).not.toContain("ToolCallStarted");
  });

  it("drift-checks worker harness session manifests before appending runtime events", async () => {
    const world = await tempWorld();
    const summarize = vi.fn<RuntimeToolHandler>(() => ({ summary: "ok" }));
    const tools = registryFor({ first: summarize });
    const workflowVersion = lockedWorkflowVersion(
      "wfver_worker_harness_manifest_drift",
      oneStepWorkflow(),
      { tools },
    );
    const step = workflowVersion.lwir.steps[0];
    if (step === undefined) {
      throw new Error("Expected one test step.");
    }
    await appendEvent(world, "run_worker_harness_manifest_drift", {
      type: "WorkflowVersionRegistered",
      payload: {
        workflowVersionId: workflowVersion.id,
        workflowVersionHash: workflowVersion.hash,
      },
    });
    await appendEvent(world, "run_worker_harness_manifest_drift", {
      type: "RunStarted",
      payload: { workflowVersionId: workflowVersion.id, input: {} },
    });
    const storedManifest = workerManifest({
      harnessId: "staleWorkerHarness@1.0.0",
      workflowDefinitionHash: workflowVersion.lock.workflowDefinitionHash,
      workflowVersionId: workflowVersion.id,
      stepPath: "first",
      stepConfig: step,
      allowedTools: ["first"],
    });
    await appendEvent(world, "run_worker_harness_manifest_drift", {
      type: "harness.session.started" as never,
      payload: {
        runId: "run_worker_harness_manifest_drift",
        role: "worker.tool-call",
        task: { kind: "execute_step" },
        manifest: storedManifest,
        manifestHash: hashHarnessManifest(storedManifest),
      },
    });

    const result = await executeWorkflowVersion({
      world,
      workflowVersion,
      runId: "run_worker_harness_manifest_drift",
      input: {},
      tools,
      workerHarness: workflowHarness,
    });

    expect(result.status).toBe("failed");
    expect(summarize).not.toHaveBeenCalled();
    if (result.status !== "failed") {
      throw new Error("Expected worker manifest drift workflow to fail.");
    }
    const errorMessage = result.error instanceof Error ? result.error.message : JSON.stringify(result.error);
    expect(errorMessage).toContain("CapabilityDriftError");
    expect(errorMessage).toContain("staleWorkerHarness@1.0.0");
  });

  it("runs code.run through the worker harness with pinned files and input", async () => {
    const world = await tempWorld();
    const lookup = vi.fn<RuntimeToolHandler>((input) => ({ summary: `ticket:${String((input as { ticketId: string }).ticketId)}` }));
    const tools = registryFor({ lookup });
    const source = "export default async function main({ input }) { return { final: `ticket:${input.ticketId}` }; }";
    const codeWorkflow: LwirWorkflow = {
      apiVersion: "littleworkflow.dev/v0.1",
      kind: "Workflow",
      metadata: { name: "worker-harness-code" },
      input: { schema: { type: "object" } },
      output: { schema: { type: "object" } },
      permissions: { tools: ["lookup"] },
      steps: [
        {
          id: "code",
          uses: "code.run",
          with: {
            entrypoint: "main.ts",
            files: {
              "main.ts": {
                content: source,
                sha256: sha256TextDigest(source),
              },
            },
            sandbox: { network: "deny" },
          },
          input: { ticketId: "{{ input.ticketId }}" },
          output: { mode: "object", schema: { type: "object" } },
        },
      ],
    };
    const workflowVersion = lockedWorkflowVersion("wfver_worker_harness_code", codeWorkflow, { tools });
    const workerHarness = {
      harnessId: "trustedCodeRunHarness@1.0.0",
      run: vi.fn<Harness["run"]>(async (task, ctx) => {
        if (task.kind !== "execute_step" || task.step.uses !== "code.run") {
          return { kind: "delegate_to_default" };
        }
        await appendTestExecuteStepEvent(ctx, task, "harness.execute_step.started");
        const ticketId = String((task.stepInput as { readonly ticketId?: unknown }).ticketId);
        const output = { final: `ticket:${ticketId}` };
        await appendTestExecuteStepEvent(ctx, task, "harness.execute_step.succeeded", { output });
        return { kind: "execute_step", output, artifactRefs: [] };
      }),
    } satisfies Harness & { readonly harnessId: string };

    const result = await executeWorkflowVersion({
      world,
      workflowVersion,
      runId: "run_worker_harness_code",
      input: { ticketId: "TIN-9000" },
      tools,
      workerHarness,
    });

    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      expect(result.output).toEqual({ final: "ticket:TIN-9000" });
    }
    expect(lookup).not.toHaveBeenCalled();

    const events = await listEvents(world, "run_worker_harness_code");
    expect(events.map((event) => event.type)).toContain("harness.execute_step.started");
    expect(events.map((event) => event.type)).not.toContain("harness.tool_call.started");
    expect(events.map((event) => event.type)).not.toContain("ToolCallStarted");
  });

  it("reports legacy code.run locks without sandbox policy as runtime_config_error under the default harness", async () => {
    const world = await tempWorld();
    const lookup = vi.fn<RuntimeToolHandler>((input) => ({ summary: `ticket:${String((input as { ticketId: string }).ticketId)}` }));
    const tools = registryFor({ lookup });
    const codeWorkflow: LwirWorkflow = {
      apiVersion: "littleworkflow.dev/v0.1",
      kind: "Workflow",
      metadata: { name: "worker-harness-code-missing" },
      input: { schema: { type: "object" } },
      output: { schema: { type: "object" } },
      permissions: { tools: ["lookup"] },
      steps: [
        {
          id: "code",
          uses: "code.run",
          with: {
            source:
              "async ({ input, tools }) => { const row = await tools.lookup({ ticketId: input.ticketId }); return { final: row.summary }; }",
          },
          input: { ticketId: "{{ input.ticketId }}" },
          output: { mode: "object", schema: { type: "object" } },
        },
      ],
    };
    const workflowVersion = lockedWorkflowVersion(
      "wfver_worker_harness_code_missing",
      codeWorkflow,
      { tools },
    );

    const result = await executeWorkflowVersion({
      world,
      workflowVersion,
      runId: "run_worker_harness_code_missing",
      input: { ticketId: "TIN-9000" },
      tools,
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") {
      throw new Error("Expected code.run without worker harness to fail.");
    }
    expect(result.error).toEqual(
      expect.objectContaining({
        causeCode: "runtime_config_error",
        message: expect.stringContaining("Workflow code.run step 'code' requires a sandbox policy."),
      }),
    );
    expect(lookup).not.toHaveBeenCalled();
  });

  it("records effective bash capabilities in planner and worker harness manifests", async () => {
    const world = await tempWorld();
    const bash = {
      network: {
        allow: ["https://api.example.test/"],
        methods: ["GET"],
      },
    } as const;
    const tools = registryFor({
      done: vi.fn<RuntimeToolHandler>(() => ({ ok: true })),
    });
    const plannerHarness = {
      harnessId: "bashCapabilitiesPlannerHarness@1.0.0",
      async run(task) {
        if (task.kind !== "plan") {
          return { kind: "delegate_to_default" } as const;
        }
        return {
          kind: "plan",
          lwir: {
            apiVersion: "littleworkflow.dev/v0.1",
            kind: "Workflow",
            metadata: { name: "runtime.bash-capabilities" },
            input: { schema: { type: "object" } },
            output: { schema: { type: "object" } },
            permissions: { tools: ["done"] },
            steps: [
              {
                id: "done",
                uses: "tool.call",
                with: { tool: "done" },
                output: { mode: "object", schema: { type: "object" } },
              },
            ],
          },
        } as const;
      },
    } satisfies Harness & { readonly harnessId: string };
    const workerHarness = {
      harnessId: "bashCapabilitiesWorkerHarness@1.0.0",
      async run(task) {
        if (task.kind !== "execute_step") {
          return { kind: "delegate_to_default" } as const;
        }
        return { kind: "execute_step", output: { ok: true }, artifactRefs: [] } as const;
      },
    } satisfies Harness & { readonly harnessId: string };
    const workflow = createLittleWorkflow({
      id: "runtime.bash-capabilities",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      models: [runtimeWorkerModel],
      planner: {
        model: { provider: "test", modelId: "planner" },
        harness: plannerHarness,
      },
      worker: { harness: workerHarness },
      globalTools: ["done"],
      bash,
    });

    const result = await runWorkflow({
      world,
      workflows: workflow,
      input: {},
      tools,
      runId: "run_runtime_bash_capabilities",
    });

    expect(result.status).toBe("completed");
    const expectedHash = sha256Digest(normalizeBashCapabilities(bash));
    const started = (await listEvents(world, "run_runtime_bash_capabilities"))
      .filter((event) => event.type === "harness.session.started");
    expect(started).toEqual(expect.arrayContaining([
      expect.objectContaining({
        payload: expect.objectContaining({
          role: "planner",
          manifest: expect.objectContaining({ bashCapabilitiesHash: expectedHash }),
        }),
      }),
      expect.objectContaining({
        payload: expect.objectContaining({
          role: "worker.tool-call",
          manifest: expect.objectContaining({ bashCapabilitiesHash: expectedHash }),
        }),
      }),
    ]));
  });

  it("runs ai.generate through the worker harness when configured", async () => {
    const world = await tempWorld();
    const aiLoop = {
      generate: vi.fn(async () => ({
        output: { final: "from-harness" },
        usage: { inputTokens: 2, outputTokens: 1 },
      })),
    };
    const workerHarness = createWorkflowHarness({ aiLoop });
    const workflowVersion = lockedWorkflowVersion(
      "wfver_worker_harness_ai",
      artifactClaimWorkflow(),
      {
        models: {
          writer: { provider: "mock", modelId: "writer" },
        },
      },
    );

    const result = await executeWorkflowVersion({
      world,
      workflowVersion,
      runId: "run_worker_harness_ai",
      input: {},
      models: {
        writer: { provider: "mock", modelId: "writer" },
      },
      workerHarness,
    });

    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      expect(result.output).toEqual({ final: "from-harness" });
    }
    expect(aiLoop.generate).toHaveBeenCalledTimes(1);

    const events = await listEvents(world, "run_worker_harness_ai");
    expect(events.map((event) => event.type)).toContain("harness.model.called");
    expect(events.map((event) => event.type)).toContain("harness.model.responded");
    expect(events.map((event) => event.type)).not.toContain("ModelCallStarted");
  });

  it("does not expose ai.generate tools outside workflow permissions", async () => {
    const world = await tempWorld();
    const secret = vi.fn<RuntimeToolHandler>(() => ({ ok: true }));
    const tools = registryFor({ secret });
    const aiLoop = {
      generate: vi.fn(async (_options: { tools?: Record<string, unknown> }) => ({
        output: { final: "from-harness" },
        toolCalls: [{ toolName: "secret", args: {} }],
      })),
    };
    const workerHarness = createWorkflowHarness({ aiLoop });
    const workflowVersion = lockedWorkflowVersion(
      "wfver_worker_harness_ai_disallowed_tools",
      artifactClaimWorkflow(),
      {
        models: {
          writer: { provider: "mock", modelId: "writer" },
        },
      },
    );

    const result = await executeWorkflowVersion({
      world,
      workflowVersion,
      runId: "run_worker_harness_ai_disallowed_tools",
      input: {},
      models: {
        writer: { provider: "mock", modelId: "writer" },
      },
      tools,
      workerHarness,
    });

    expect(result.status).toBe("completed");
    const firstGenerateCall = aiLoop.generate.mock.calls[0];
    expect(firstGenerateCall).toBeDefined();
    expect(Object.keys(firstGenerateCall?.[0].tools ?? {})).not.toContain("secret");
    expect(secret).not.toHaveBeenCalled();
  });

  it("uses the default workflowHarness AI SDK bridge when ai.generate delegates", async () => {
    const world = await tempWorld();
    const workflowVersion = lockedWorkflowVersion(
      "wfver_worker_harness_ai_delegate",
      artifactClaimWorkflow(),
      {
        models: {
          writer: { provider: "mock", modelId: "writer" },
        },
      },
    );

    const workerHarness = {
      harnessId: "aiDelegateHarness@1.0.0",
      async run() {
        return { kind: "delegate_to_default" } as const;
      },
    } satisfies Harness & { readonly harnessId: string };

    const result = await executeWorkflowVersion({
      world,
      workflowVersion,
      runId: "run_worker_harness_ai_delegate",
      input: {},
      models: {
        writer: { provider: "mock", modelId: "writer" },
      },
      workerHarness,
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") {
      throw new Error("Expected delegated ai.generate workflow to fail.");
    }
    expect(result.error).toEqual(
      expect.objectContaining({
        message: expect.stringContaining("Unsupported model version"),
      }),
    );
    const events = await listEvents(world, "run_worker_harness_ai_delegate");
    expect(events.map((event) => event.type)).toContain("harness.session.started");
    expect(events.map((event) => event.type)).toContain("harness.session.completed");
    const sessionHarnessIds = events
      .filter((event) => event.type === "harness.session.started")
      .map((event) => (event.payload.manifest as { harnessId?: string } | undefined)?.harnessId);
    expect(sessionHarnessIds).toContain("aiDelegateHarness@1.0.0");
    expect(sessionHarnessIds).toContain("workflowHarness@1.0.0");
  });

  it("falls back to the default worker runtime when tool.call delegates", async () => {
    const world = await tempWorld();
    const summarize = vi.fn<RuntimeToolHandler>(() => ({ summary: "ok" }));
    const tools = registryFor({ first: summarize });
    const workflowVersion = lockedWorkflowVersion(
      "wfver_worker_harness_tool_delegate",
      oneStepWorkflow(),
      { tools },
    );
    const workerHarness = {
      harnessId: "toolDelegateHarness@1.0.0",
      async run() {
        return { kind: "delegate_to_default" } as const;
      },
    } satisfies Harness & { readonly harnessId: string };

    const result = await executeWorkflowVersion({
      world,
      workflowVersion,
      runId: "run_worker_harness_tool_delegate",
      input: {},
      tools,
      workerHarness,
    });

    expect(result.status).toBe("completed");
    expect(summarize).toHaveBeenCalledTimes(1);
    if (result.status !== "completed") {
      throw new Error("Expected delegated tool.call workflow to complete.");
    }
    expect(result.output).toEqual({ summary: "ok" });
    const events = await listEvents(world, "run_worker_harness_tool_delegate");
    const sessionHarnessIds = events
      .filter((event) => event.type === "harness.session.started")
      .map((event) => (event.payload.manifest as { harnessId?: string } | undefined)?.harnessId);
    expect(sessionHarnessIds).toContain("toolDelegateHarness@1.0.0");
    expect(sessionHarnessIds).toContain("workflowHarness@1.0.0");
  });

  it("defaults public tool.call execution to workflowHarness", async () => {
    const world = await tempWorld();
    const summarize = vi.fn<RuntimeToolHandler>(() => ({ summary: "ok" }));
    const tools = registryFor({ first: summarize });

    const result = await executeWorkflowVersion({
      world,
      workflowVersion: lockedWorkflowVersion("wfver_worker_default_tool_harness", oneStepWorkflow(), { tools }),
      runId: "run_worker_default_tool_harness",
      input: {},
      tools,
    });

    expect(result.status).toBe("completed");
    expect(summarize).toHaveBeenCalledTimes(1);
    const events = await listEvents(world, "run_worker_default_tool_harness");
    expect(events.map((event) => event.type)).toContain("harness.session.started");
    expect(events.map((event) => event.type)).toContain("harness.tool_call.started");
    expect(events.map((event) => event.type)).not.toContain("ToolCallStarted");
    expect(events.map((event) => event.type)).not.toContain("ToolCallCompleted");
    const sessionHarnessIds = events
      .filter((event) => event.type === "harness.session.started")
      .map((event) => (event.payload.manifest as { harnessId?: string } | undefined)?.harnessId);
    expect(sessionHarnessIds).toContain("workflowHarness@1.0.0");
  });

  it("does not expose code.run tools outside workflow permissions", async () => {
    const world = await tempWorld();
    const lookup = vi.fn<RuntimeToolHandler>(() => ({ summary: "ticket:TIN-9000" }));
    const secret = vi.fn<RuntimeToolHandler>(() => ({ summary: "secret" }));
    const tools = registryFor({ lookup, secret });
    const source =
      "async ({ tools }) => { const row = await tools.secret({ ticketId: 'TIN-9000' }); return { final: row.summary }; }";
    const codeWorkflow: LwirWorkflow = {
      apiVersion: "littleworkflow.dev/v0.1",
      kind: "Workflow",
      metadata: { name: "worker-harness-code-permissions" },
      input: { schema: { type: "object" } },
      output: { schema: { type: "object" } },
      permissions: { tools: ["lookup"] },
      steps: [
        {
          id: "code",
          uses: "code.run",
          with: {
            source,
            entrypoint: "main.ts",
            files: {
              "main.ts": {
                content: source,
                sha256: sha256TextDigest(source),
              },
            },
            sandbox: { network: "deny" },
          },
          output: { mode: "object", schema: { type: "object" } },
        },
      ],
    };
    const workflowVersion = lockedWorkflowVersion("wfver_worker_harness_code_permissions", codeWorkflow, { tools });
    const workerHarness = {
      harnessId: "permissionScopedCodeHarness@1.0.0",
      run: vi.fn<Harness["run"]>(async (task, ctx) => {
        if (task.kind !== "execute_step" || task.step.uses !== "code.run") {
          return { kind: "delegate_to_default" };
        }
        await appendTestExecuteStepEvent(ctx, task, "harness.execute_step.started");
        if (Object.hasOwn(ctx.tools, "secret")) {
          throw new Error("secret tool should not be exposed to code.run");
        }
        throw new Error("secret tool is not available to this code.run step");
      }),
    } satisfies Harness & { readonly harnessId: string };

    const result = await executeWorkflowVersion({
      world,
      workflowVersion,
      runId: "run_worker_harness_code_permissions",
      input: {},
      tools,
      workerHarness,
    });

    expect(result.status).toBe("failed");
    expect(secret).not.toHaveBeenCalled();
    if (result.status !== "failed") {
      throw new Error("Expected code.run permissions workflow to fail.");
    }
    expect(result.error).toEqual(
      expect.objectContaining({
        message: expect.stringContaining("secret"),
      }),
    );
  });

  it("fails closed when code.run tools are supplied only via workerTools without registry lock descriptors", async () => {
    const world = await tempWorld();
    const lookup = vi.fn(async () => ({ summary: "ticket:TIN-9000" }));
    const lockTools = registryFor({ lookup });
    const codeWorkflow: LwirWorkflow = {
      apiVersion: "littleworkflow.dev/v0.1",
      kind: "Workflow",
      metadata: { name: "worker-harness-code-worker-tools-drift" },
      input: { schema: { type: "object" } },
      output: { schema: { type: "object" } },
      permissions: { tools: ["lookup"] },
      steps: [
        {
          id: "code",
          uses: "code.run",
          with: {
            source:
              "async ({ tools }) => { const row = await tools.lookup({ ticketId: 'TIN-9000' }); return { final: row.summary }; }",
          },
          output: { mode: "object", schema: { type: "object" } },
        },
      ],
    };
    const workflowVersion = lockedWorkflowVersion(
      "wfver_worker_harness_code_worker_tools_drift",
      codeWorkflow,
      { tools: lockTools },
    );

    const result = await executeWorkflowVersion({
      world,
      workflowVersion,
      runId: "run_worker_harness_code_worker_tools_drift",
      input: {},
      tools: createToolRegistry(),
      workerTools: {
        lookup: {
          description: "Lookup ticket details.",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["ticketId"],
            properties: {
              ticketId: { type: "string" },
            },
          },
          execute: lookup,
        },
      },
      workerHarness: workflowHarness,
    });

    expect(result.status).toBe("failed");
    expect(lookup).not.toHaveBeenCalled();
    if (result.status !== "failed") {
      throw new Error("Expected code.run workerTools lock-drift workflow to fail.");
    }
    expect(result.error).toEqual(
      expect.objectContaining({
        message: expect.stringContaining("capability_drift"),
      }),
    );
  });

  it("fails closed for disallowed tool.call when worker harness delegates", async () => {
    const world = await tempWorld();
    const hidden = vi.fn(() => ({ secret: true }));
    const tools = registryFor({ hidden });
    const workflowVersion = lockedWorkflowVersion(
      "wfver_worker_harness_disallowed_tool_delegate",
      unapprovedToolWorkflow(),
      { tools },
    );
    const workerHarness = {
      harnessId: "toolDelegateHarness@1.0.0",
      async run() {
        return { kind: "delegate_to_default" } as const;
      },
    } satisfies Harness & { readonly harnessId: string };

    const result = await executeWorkflowVersion({
      world,
      workflowVersion,
      runId: "run_worker_harness_disallowed_tool_delegate",
      input: {},
      tools,
      workerHarness,
    });

    expect(result.status).toBe("failed");
    expect(hidden).not.toHaveBeenCalled();
    if (result.status !== "failed") {
      throw new Error("Expected delegated disallowed tool.call workflow to fail.");
    }
    expect(result.error).toEqual(
      expect.objectContaining({
        message: expect.stringContaining("capability_drift"),
      }),
    );
  });

  it("does not emit harness.model.called for direct tool and code worker-harness steps", async () => {
    const world = await tempWorld();
    const tool = vi.fn<RuntimeToolHandler>(() => ({ summary: "ok" }));
    const tools = registryFor({ first: tool, lookup: tool });

    await executeWorkflowVersion({
      world,
      workflowVersion: lockedWorkflowVersion("wfver_worker_harness_no_model_tool", oneStepWorkflow(), { tools }),
      runId: "run_worker_harness_no_model_tool",
      input: {},
      tools,
      workerHarness: workflowHarness,
    });

    const events = await listEvents(world, "run_worker_harness_no_model_tool");
    expect(events.map((event) => event.type)).toContain("harness.execute_step.started");
    expect(events.map((event) => event.type)).not.toContain("harness.model.called");
  });

  it("does not invoke adapters when the signal aborts before the adapter call starts", async () => {
    const world = await tempWorld();
    const controller = new AbortController();
    const tool = vi.fn(() => ({ ok: true }));
    const workflowVersion = lockedWorkflowVersion(
      "wfver_runtime_abort_before_adapter",
      oneStepWorkflow(),
      { tools: registryFor({ first: tool }) },
    );
    await appendEvent(world, "run_runtime_abort_before_adapter", {
      type: "WorkflowVersionRegistered",
      payload: {
        workflowVersionId: workflowVersion.id,
        workflowVersionHash: workflowVersion.hash,
      },
    });
    controller.abort();

    const result = await executeWorkflowVersion({
      world,
      workflowVersion,
      runId: "run_runtime_abort_before_adapter",
      input: {},
      signal: controller.signal,
      tools: registryFor({ first: tool }),
    });

    expect(result.status).toBe("failed");
    expect(tool).not.toHaveBeenCalled();
  });

  it("does not retry a persisted terminal cancellation attempt without a RunFailed event", async () => {
    const world = await tempWorld();
    const tool = vi.fn(() => ({ ok: true }));
    const workflowVersion = lockedWorkflowVersion(
      "wfver_runtime_terminal_step_failed",
      retryWorkflowWithMaxAttempts(2),
      { tools: registryFor({ flaky: tool }) },
    );
    await appendEvent(world, "run_runtime_terminal_step_failed", {
      type: "WorkflowVersionRegistered",
      payload: {
        workflowVersionId: workflowVersion.id,
        workflowVersionHash: workflowVersion.hash,
      },
    });
    await appendEvent(world, "run_runtime_terminal_step_failed", {
      type: "RunStarted",
      payload: { workflowVersionId: workflowVersion.id },
    });
    await appendEvent(world, "run_runtime_terminal_step_failed", {
      type: "StepScheduled",
      payload: { stepPath: "flaky", stepId: "flaky", uses: "tool.call" },
    });
    await appendEvent(world, "run_runtime_terminal_step_failed", {
      type: "StepAttemptStarted",
      payload: {
        stepPath: "flaky",
        stepId: "flaky",
        attempt: 1,
        attemptId: "attempt_1",
      },
    });
    await appendEvent(world, "run_runtime_terminal_step_failed", {
      type: "StepFailed",
      payload: {
        stepPath: "flaky",
        stepId: "flaky",
        attempt: 1,
        attemptId: "attempt_1",
        error: {
          name: "AbortError",
          causeCode: "cancelled",
          message: "Run was cancelled.",
          retriable: false,
        },
      },
    });

    const result = await executeWorkflowVersion({
      world,
      workflowVersion,
      runId: "run_runtime_terminal_step_failed",
      input: {},
      tools: registryFor({ flaky: tool }),
    });

    expect(result.status).toBe("failed");
    expect(tool).not.toHaveBeenCalled();
    const events = await listEvents(world, "run_runtime_terminal_step_failed");
    expect(events.filter((event) => event.type === "StepAttemptStarted")).toHaveLength(1);
    expect(events.filter((event) => event.type === "RunFailed")).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          error: expect.objectContaining({
            name: "AbortError",
            causeCode: "cancelled",
            retriable: false,
          }),
        }),
      }),
    ]);
  });

  it("normalizes custom abort reasons before execution to terminal cancellation", async () => {
    const world = await tempWorld();
    const controller = new AbortController();
    const tool = vi.fn(() => ({ number: 21 }));
    const workflowVersion = lockedWorkflowVersion(
      "wfver_runtime_custom_abort_before",
      oneStepWorkflow(),
      { tools: registryFor({ first: tool }) },
    );
    controller.abort(new Error("stop before execution"));

    const firstResult = await executeWorkflowVersion({
      world,
      workflowVersion,
      runId: "run_runtime_custom_abort_before",
      input: {},
      signal: controller.signal,
      tools: registryFor({ first: tool }),
    });

    expect(firstResult.status).toBe("failed");
    if (firstResult.status !== "failed") {
      throw new Error("Expected custom abort before execution to fail.");
    }
    expect(firstResult.error).toEqual(
      expect.objectContaining({
        name: "AbortError",
        message: "stop before execution",
      }),
    );
    expect(tool).not.toHaveBeenCalled();

    const replayResult = await executeWorkflowVersion({
      world,
      workflowVersion,
      runId: "run_runtime_custom_abort_before",
      input: {},
      tools: registryFor({ first: tool }),
    });

    expect(replayResult.status).toBe("failed");
    expect(tool).not.toHaveBeenCalled();
  });

  it("normalizes custom abort reasons during adapter calls to terminal cancellation", async () => {
    const world = await tempWorld();
    const controller = new AbortController();
    const tool = vi.fn(async () => {
      controller.abort(new Error("stop during adapter"));
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { ok: true };
    });
    const workflowVersion = lockedWorkflowVersion(
      "wfver_runtime_custom_abort_during",
      retryWorkflowWithMaxAttempts(2),
      { tools: registryFor({ flaky: tool }) },
    );

    const firstResult = await executeWorkflowVersion({
      world,
      workflowVersion,
      runId: "run_runtime_custom_abort_during",
      input: {},
      signal: controller.signal,
      tools: registryFor({ flaky: tool }),
    });

    expect(firstResult.status).toBe("failed");
    expect(tool).toHaveBeenCalledTimes(1);
    const eventsAfterCancel = await listEvents(world, "run_runtime_custom_abort_during");
    expect(eventsAfterCancel.filter((event) => event.type === "StepFailed")).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          stepPath: "flaky",
          error: expect.objectContaining({
            name: "AbortError",
            message: "stop during adapter",
            retriable: false,
          }),
        }),
      }),
    ]);

    const replayTool = vi.fn(() => ({ ok: true }));
    const replayResult = await executeWorkflowVersion({
      world,
      workflowVersion,
      runId: "run_runtime_custom_abort_during",
      input: {},
      tools: registryFor({ flaky: replayTool }),
    });

    expect(replayResult.status).toBe("failed");
    expect(replayTool).not.toHaveBeenCalled();
  });

  it("treats adapter-origin AbortError as a retryable step failure", async () => {
    const world = await tempWorld();
    const tool = vi.fn(() => {
      if (tool.mock.calls.length === 1) {
        const error = new Error("provider aborted request");
        error.name = "AbortError";
        throw error;
      }
      return { ok: true };
    });

    const result = await executeWorkflowVersion({
      world,
      workflowVersion: lockedWorkflowVersion(
        "wfver_runtime_provider_abort",
        retryWorkflowWithMaxAttempts(2),
        { tools: registryFor({ flaky: tool }) },
      ),
      runId: "run_runtime_provider_abort",
      input: {},
      tools: registryFor({ flaky: tool }),
    });

    expect(result.status).toBe("completed");
    expect(tool).toHaveBeenCalledTimes(2);
    const events = await listEvents(world, "run_runtime_provider_abort");
    expect(events.filter((event) => event.type === "StepFailed")).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          error: expect.objectContaining({
            name: "AbortError",
            retriable: true,
          }),
        }),
      }),
    ]);
  });

  it("treats adapter-origin TimeoutError as a retryable step failure", async () => {
    const world = await tempWorld();
    const tool = vi.fn(() => {
      if (tool.mock.calls.length === 1) {
        const error = new Error("provider timed out request");
        error.name = "TimeoutError";
        throw error;
      }
      return { ok: true };
    });

    const result = await executeWorkflowVersion({
      world,
      workflowVersion: lockedWorkflowVersion(
        "wfver_runtime_provider_timeout",
        retryWorkflowWithMaxAttempts(2),
        { tools: registryFor({ flaky: tool }) },
      ),
      runId: "run_runtime_provider_timeout",
      input: {},
      tools: registryFor({ flaky: tool }),
    });

    expect(result.status).toBe("completed");
    expect(tool).toHaveBeenCalledTimes(2);
    const events = await listEvents(world, "run_runtime_provider_timeout");
    expect(events.filter((event) => event.type === "StepFailed")).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          error: expect.objectContaining({
            name: "TimeoutError",
            retriable: true,
          }),
        }),
      }),
    ]);
  });

  it("retries persisted adapter-origin causeCode failures when marked retriable", async () => {
    const world = await tempWorld();
    const tool = vi.fn(() => ({ ok: true }));
    const workflowVersion = lockedWorkflowVersion(
      "wfver_runtime_provider_cause_code_replay",
      retryWorkflowWithMaxAttempts(2),
      { tools: registryFor({ flaky: tool }) },
    );
    await appendEvent(world, "run_runtime_provider_cause_code_replay", {
      type: "WorkflowVersionRegistered",
      payload: {
        workflowVersionId: workflowVersion.id,
        workflowVersionHash: workflowVersion.hash,
      },
    });
    await appendEvent(world, "run_runtime_provider_cause_code_replay", {
      type: "RunStarted",
      payload: { workflowVersionId: workflowVersion.id },
    });
    await appendEvent(world, "run_runtime_provider_cause_code_replay", {
      type: "StepScheduled",
      payload: { stepPath: "flaky", stepId: "flaky", uses: "tool.call" },
    });
    await appendEvent(world, "run_runtime_provider_cause_code_replay", {
      type: "StepAttemptStarted",
      payload: {
        stepPath: "flaky",
        stepId: "flaky",
        attempt: 1,
        attemptId: "attempt_1",
      },
    });
    await appendEvent(world, "run_runtime_provider_cause_code_replay", {
      type: "StepFailed",
      payload: {
        stepPath: "flaky",
        stepId: "flaky",
        attempt: 1,
        attemptId: "attempt_1",
        error: {
          name: "TimeoutError",
          message: "provider timeout with provider cause code",
          causeCode: "timeout",
          retriable: true,
        },
      },
    });

    const result = await executeWorkflowVersion({
      world,
      workflowVersion,
      runId: "run_runtime_provider_cause_code_replay",
      input: {},
      tools: registryFor({ flaky: tool }),
    });

    expect(result.status).toBe("completed");
    expect(tool).toHaveBeenCalledTimes(1);
    const attempts = (await listEvents(world, "run_runtime_provider_cause_code_replay")).filter(
      (event) => event.type === "StepAttemptStarted",
    );
    expect(attempts).toHaveLength(2);
  });

  it("retries failed step attempts and preserves failed attempt events", async () => {
    const world = await tempWorld();
    const flakyTool = vi.fn(() => {
      if (flakyTool.mock.calls.length < 3) {
        throw new Error("temporary outage");
      }
      return { ok: true };
    });

    const result = await executeWorkflowVersion({
      world,
      workflowVersion: lockedWorkflowVersion("wfver_runtime_retry", retryWorkflow(), {
        tools: registryFor({ flaky: flakyTool }),
      }),
      runId: "run_runtime_retry",
      input: {},
      tools: registryFor({ flaky: flakyTool }),
    });

    expect(flakyTool).toHaveBeenCalledTimes(3);
    expect(result.status).toBe("completed");
    expect(result.output).toEqual({ ok: true });

    const events = await listEvents(world, "run_runtime_retry");
    expect(events.filter((event) => event.type === "StepFailed")).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          stepPath: "flaky",
          attempt: 1,
          error: expect.objectContaining({ message: "temporary outage", retriable: true }),
        }),
      }),
      expect.objectContaining({
        payload: expect.objectContaining({
          stepPath: "flaky",
          attempt: 2,
          error: expect.objectContaining({ message: "temporary outage", retriable: true }),
        }),
      }),
    ]);
    expect(events.filter((event) => event.type === "StepAttemptStarted")).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ attemptId: "attempt_1" }) }),
      expect.objectContaining({ payload: expect.objectContaining({ attemptId: "attempt_2" }) }),
      expect.objectContaining({ payload: expect.objectContaining({ attemptId: "attempt_3" }) }),
    ]);
  });

  it("honors retry maxAttempts as a total replay budget", async () => {
    const world = await tempWorld();
    const flakyTool = vi.fn(() => {
      throw new Error("still down");
    });
    const workflowVersion = lockedWorkflowVersion(
      "wfver_runtime_retry_replay",
      retryWorkflowWithMaxAttempts(2),
      { tools: registryFor({ flaky: flakyTool }) },
    );

    await executeWorkflowVersion({
      world,
      workflowVersion,
      runId: "run_runtime_retry_replay",
      input: {},
      tools: registryFor({ flaky: flakyTool }),
      maxAttempts: 1,
    });

    const result = await executeWorkflowVersion({
      world,
      workflowVersion,
      runId: "run_runtime_retry_replay",
      input: {},
      tools: registryFor({ flaky: flakyTool }),
    });

    expect(result.status).toBe("failed");
    expect(flakyTool).toHaveBeenCalledTimes(2);
    const attempts = (await listEvents(world, "run_runtime_retry_replay")).filter(
      (event) => event.type === "StepAttemptStarted",
    );
    expect(attempts).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ attemptId: "attempt_1" }) }),
      expect.objectContaining({ payload: expect.objectContaining({ attemptId: "attempt_2" }) }),
    ]);

    const failedEventsBeforeReplay = (await listEvents(world, "run_runtime_retry_replay")).filter(
      (event) => event.type === "RunFailed",
    );
    await executeWorkflowVersion({
      world,
      workflowVersion,
      runId: "run_runtime_retry_replay",
      input: {},
      tools: registryFor({ flaky: flakyTool }),
    });
    const failedEventsAfterReplay = (await listEvents(world, "run_runtime_retry_replay")).filter(
      (event) => event.type === "RunFailed",
    );
    expect(failedEventsAfterReplay).toEqual(failedEventsBeforeReplay);
  });

  it("replays a failed existing run without re-calling completed steps", async () => {
    const world = await tempWorld();
    const first = vi.fn(() => ({ number: 21 }));
    let secondShouldFail = true;
    const second = vi.fn((input: unknown) => {
      if (secondShouldFail) {
        throw new Error("second unavailable");
      }
      expect(input).toEqual({ previous: 21 });
      return { doubled: 42 };
    });

    await executeWorkflowVersion({
      world,
      workflowVersion: lockedWorkflowVersion("wfver_runtime_replay", twoStepWorkflow(), {
        tools: registryFor({ first, second }),
      }),
      runId: "run_runtime_replay",
      input: {},
      tools: registryFor({ first, second }),
      maxAttempts: 1,
    });

    secondShouldFail = false;

    const result = await executeWorkflowVersion({
      world,
      workflowVersion: lockedWorkflowVersion("wfver_runtime_replay", twoStepWorkflow(), {
        tools: registryFor({ first, second }),
      }),
      runId: "run_runtime_replay",
      input: {},
      tools: registryFor({ first, second }),
      maxAttempts: 2,
    });

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);
    expect(result.status).toBe("completed");
    expect(result.output).toEqual({ doubled: 42 });
    expect(result.state.error).toBeUndefined();

    const events = await listEvents(world, "run_runtime_replay");
    expect(
      events.filter(
        (event) =>
          event.type === "harness.tool_call.started" &&
          isRecord(event.payload.scope) &&
          event.payload.scope.stepPath === "first",
      ),
    ).toHaveLength(1);
    expect(
      events.filter(
        (event) =>
          event.type === "harness.tool_call.started" &&
          isRecord(event.payload.scope) &&
          event.payload.scope.stepPath === "second",
      ),
    ).toHaveLength(2);
  });

  it("rejects replay when an existing run belongs to a different workflow version", async () => {
    const world = await tempWorld();
    const first = vi.fn(() => ({ number: 21 }));

    await executeWorkflowVersion({
      world,
      workflowVersion: lockedWorkflowVersion("wfver_runtime_original", oneStepWorkflow(), {
        tools: registryFor({ first }),
      }),
      runId: "run_runtime_version_mismatch",
      input: {},
      tools: registryFor({ first }),
    });
    const eventCount = (await listEvents(world, "run_runtime_version_mismatch")).length;

    await expect(
      executeWorkflowVersion({
        world,
        workflowVersion: lockedWorkflowVersion("wfver_runtime_changed", oneStepWorkflow(), {
          tools: registryFor({ first }),
        }),
        runId: "run_runtime_version_mismatch",
        input: {},
        tools: registryFor({ first }),
      }),
    ).rejects.toThrow("WorkflowVersion mismatch");
    await expect(listEvents(world, "run_runtime_version_mismatch")).resolves.toHaveLength(
      eventCount,
    );
  });

  it("passes workflow input to ai.generate worker harness", async () => {
    const world = await tempWorld();
    const aiLoop = {
      generate: vi.fn(async (options) => {
        expect(options.input).toEqual({ name: "Ada", title: "Engineer" });
        return { output: "done" };
      }),
    };
    const workerHarness = createWorkflowHarness({ aiLoop });

    const result = await executeWorkflowVersion({
      world,
      workflowVersion: lockedWorkflowVersion("wfver_runtime_prompt", promptWorkflow(), {
        models: { writer: { provider: "mock", id: "writer" } },
      }),
      runId: "run_runtime_prompt",
      input: { name: "Ada", title: "Engineer" },
      models: { writer: { provider: "mock", id: "writer" } },
      workerHarness,
    });

    expect(result.status).toBe("completed");
    expect(aiLoop.generate).toHaveBeenCalledTimes(1);
  });

  it("validates step output schema before completing a step", async () => {
    const world = await tempWorld();
    const tool = vi.fn(() => ({ count: "not a number" }));

    const result = await executeWorkflowVersion({
      world,
      workflowVersion: lockedWorkflowVersion("wfver_runtime_step_schema", stepSchemaWorkflow(), {
        tools: registryFor({ count: tool }),
      }),
      runId: "run_runtime_step_schema",
      input: {},
      tools: registryFor({ count: tool }),
    });

    expect(result.status).toBe("failed");
    expect(tool).toHaveBeenCalledTimes(1);
    const events = await listEvents(world, "run_runtime_step_schema");
    expect(events.some((event) => event.type === "StepOutputValidated")).toBe(false);
    expect(events.some((event) => event.type === "StepCompleted")).toBe(false);
  });

  it("validates step output against the original contract when adapters mutate context.step", async () => {
    const world = await tempWorld();
    const tool = vi.fn<RuntimeToolHandler>((_input, context) => {
      (context.step as { output?: unknown }).output = {
        mode: "object",
        schema: { type: "object", additionalProperties: true },
      };
      return { wrong: true };
    });

    const result = await executeWorkflowVersion({
      world,
      workflowVersion: lockedWorkflowVersion("wfver_runtime_step_contract_mutation", stepSchemaWorkflow(), {
        tools: registryFor({ count: tool }),
      }),
      runId: "run_runtime_step_contract_mutation",
      input: {},
      tools: registryFor({ count: tool }),
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") {
      throw new Error("Expected mutated contract workflow to fail.");
    }
    expect(result.error).toEqual(
      expect.objectContaining({ message: expect.stringContaining("does not match schema") }),
    );
    expect(tool).toHaveBeenCalledTimes(1);
  });

  it("uses the original output contract across retries after adapters mutate context.step", async () => {
    const world = await tempWorld();
    const workflow = {
      ...stepSchemaWorkflow(),
      steps: [
        {
          ...stepSchemaWorkflow().steps[0],
          retry: { maxAttempts: 2 },
        },
      ],
    } as unknown as LwirWorkflow;
    const tool = vi.fn<RuntimeToolHandler>((_input, context) => {
      (context.step as { output?: unknown }).output = {
        mode: "object",
        schema: { type: "object", additionalProperties: true },
      };
      if (tool.mock.calls.length === 1) {
        throw new Error("transient after mutation");
      }
      return { wrong: true };
    });

    const result = await executeWorkflowVersion({
      world,
      workflowVersion: lockedWorkflowVersion("wfver_runtime_retry_contract_mutation", workflow, {
        tools: registryFor({ count: tool }),
      }),
      runId: "run_runtime_retry_contract_mutation",
      input: {},
      tools: registryFor({ count: tool }),
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") {
      throw new Error("Expected retried mutated contract workflow to fail.");
    }
    expect(result.error).toEqual(
      expect.objectContaining({ message: expect.stringContaining("does not match schema") }),
    );
    expect(tool).toHaveBeenCalledTimes(2);
  });

  it("validates workflow output schema before completing the run", async () => {
    const world = await tempWorld();
    const tool = vi.fn(() => ({ count: 7 }));

    const result = await executeWorkflowVersion({
      world,
      workflowVersion: lockedWorkflowVersion("wfver_runtime_final_schema", finalSchemaWorkflow(), {
        tools: registryFor({ count: tool }),
      }),
      runId: "run_runtime_final_schema",
      input: {},
      tools: registryFor({ count: tool }),
    });

    expect(result.status).toBe("failed");
    expect(tool).toHaveBeenCalledTimes(1);
    const events = await listEvents(world, "run_runtime_final_schema");
    expect(events.some((event) => event.type === "StepCompleted")).toBe(false);
    expect(events.some((event) => event.type === "RunCompleted")).toBe(false);
  });

  it("rejects completed replay when persisted step schema hashes drift", async () => {
    const workflow = stepSchemaWorkflow();
    const outputValue = { count: 7 };
    const expectedHash = sha256Digest((workflow.steps[0]?.output as { schema: unknown }).schema);
    const wrongHash = `sha256:${"0".repeat(64)}`;
    const cases = [
      {
        runId: "run_runtime_replay_bad_validated_schema_hash",
        validatedHash: wrongHash,
        completedHash: expectedHash,
      },
      {
        runId: "run_runtime_replay_bad_completed_schema_hash",
        validatedHash: expectedHash,
        completedHash: wrongHash,
      },
    ];

    for (const entry of cases) {
      const world = await tempWorld();
      const tool = vi.fn(() => outputValue);
      const workflowVersion = lockedWorkflowVersion(entry.runId, workflow, {
        tools: registryFor({ count: tool }),
      });
      const outputArtifact = await writeArtifact(world, {
        runId: entry.runId,
        stepPath: "count",
        name: "output",
        payload: outputValue,
        contentType: "application/json",
      });
      await appendEvent(world, entry.runId, {
        type: "WorkflowVersionRegistered",
        payload: {
          workflowVersionId: workflowVersion.id,
          workflowVersionHash: workflowVersion.hash,
        },
      });
      await appendEvent(world, entry.runId, {
        type: "RunStarted",
        payload: { workflowVersionId: workflowVersion.id, input: {} },
      });
      await appendEvent(world, entry.runId, {
        type: "StepScheduled",
        payload: { stepPath: "count", stepId: "count", uses: "tool.call" },
      });
      await appendEvent(world, entry.runId, {
        type: "StepAttemptStarted",
        payload: { stepPath: "count", stepId: "count", attempt: 1, attemptId: "attempt_1" },
      });
      await appendEvent(world, entry.runId, {
        type: "ArtifactCreated",
        payload: {
          stepPath: "count",
          artifactRef: outputArtifact.artifactRef,
          name: "output",
          contentType: "application/json",
        },
      });
      await appendEvent(world, entry.runId, {
        type: "StepOutputValidated",
        payload: {
          stepPath: "count",
          outputRef: outputArtifact.artifactRef,
          outputMode: "object",
          schemaHash: entry.validatedHash,
        },
      });
      await appendEvent(world, entry.runId, {
        type: "StepCompleted",
        payload: {
          stepPath: "count",
          stepId: "count",
          attempt: 1,
          output: outputValue,
          outputRef: outputArtifact.artifactRef,
          artifactRefs: [outputArtifact.artifactRef],
          metadata: { outputMode: "object", schemaHash: entry.completedHash },
        },
      });
      await appendEvent(world, entry.runId, {
        type: "RunCompleted",
        payload: {
          workflowVersionId: workflowVersion.id,
          output: outputValue,
          outputRef: outputArtifact.artifactRef,
          terminalStepPath: "count",
        },
      });

      await expect(
        executeWorkflowVersion({
          world,
          workflowVersion,
          runId: entry.runId,
          input: {},
          tools: registryFor({ count: tool }),
        }),
      ).rejects.toThrow("schemaHash");
      expect(tool).not.toHaveBeenCalled();
    }
  });

  it("preflights incompatible terminal output contracts before calling tools", async () => {
    const world = await tempWorld();
    const tool = vi.fn(() => "done");

    const result = await executeWorkflowVersion({
      world,
      workflowVersion: lockedWorkflowVersion(
        "wfver_runtime_terminal_contract",
        terminalContractWorkflow(),
        { tools: registryFor({ report: tool }) },
      ),
      runId: "run_runtime_terminal_contract",
      input: {},
      tools: registryFor({ report: tool }),
    });

    expect(result.status).toBe("failed");
    expect(tool).not.toHaveBeenCalled();
  });

  it("enforces output mode shape even when JSON Schema is permissive", async () => {
    const world = await tempWorld();
    const tool = vi.fn(() => "not an object");

    const result = await executeWorkflowVersion({
      world,
      workflowVersion: lockedWorkflowVersion("wfver_runtime_mode_shape", modeShapeWorkflow(), {
        tools: registryFor({ shape: tool }),
      }),
      runId: "run_runtime_mode_shape",
      input: {},
      tools: registryFor({ shape: tool }),
    });

    expect(result.status).toBe("failed");
    expect(tool).toHaveBeenCalledTimes(1);
    const events = await listEvents(world, "run_runtime_mode_shape");
    expect(events.some((event) => event.type === "StepCompleted")).toBe(false);
  });

  it("checks completed replay artifact hashes before suppressing re-execution", async () => {
    const world = await tempWorld();
    const first = vi.fn(() => ({ number: 21 }));

    const firstRun = await executeWorkflowVersion({
      world,
      workflowVersion: lockedWorkflowVersion("wfver_runtime_artifact_replay", oneStepWorkflow(), {
        tools: registryFor({ first }),
      }),
      runId: "run_runtime_artifact_replay",
      input: {},
      tools: registryFor({ first }),
    });
    if (firstRun.status !== "completed") {
      throw new Error("Expected setup run to complete.");
    }
    const artifact = await readArtifact(world, firstRun.outputRef);
    await rm(join(world.dataDir, "artifacts", "blobs", `${artifact.manifest.artifactId}.bin`), {
      force: true,
    });

    await expect(
      executeWorkflowVersion({
        world,
        workflowVersion: lockedWorkflowVersion("wfver_runtime_artifact_replay", oneStepWorkflow(), {
          tools: registryFor({ first }),
        }),
        runId: "run_runtime_artifact_replay",
        input: {},
        tools: registryFor({ first }),
      }),
    ).rejects.toThrow("Artifact not found");
    expect(first).toHaveBeenCalledTimes(1);
  });

  it("rejects completed replay when the run outputRef differs from the final step outputRef", async () => {
    const world = await tempWorld();
    const first = vi.fn(() => ({ number: 21 }));
    const workflowVersion = lockedWorkflowVersion(
      "wfver_runtime_run_output_ref_mismatch",
      oneStepWorkflow(),
      { tools: registryFor({ first }) },
    );
    const stepArtifact = await writeArtifact(world, {
      runId: "run_runtime_run_output_ref_mismatch",
      stepPath: "first",
      name: "output",
      payload: { number: 21 },
      contentType: "application/json",
    });
    const runArtifact = await writeArtifact(world, {
      runId: "run_runtime_run_output_ref_mismatch",
      stepPath: "first",
      name: "output",
      payload: { number: 99 },
      contentType: "application/json",
    });
    await appendEvent(world, "run_runtime_run_output_ref_mismatch", {
      type: "WorkflowVersionRegistered",
      payload: {
        workflowVersionId: workflowVersion.id,
        workflowVersionHash: workflowVersion.hash,
      },
    });
    await appendEvent(world, "run_runtime_run_output_ref_mismatch", {
      type: "RunStarted",
      payload: { workflowVersionId: workflowVersion.id },
    });
    await appendEvent(world, "run_runtime_run_output_ref_mismatch", {
      type: "StepScheduled",
      payload: { stepPath: "first", stepId: "first", uses: "tool.call" },
    });
    await appendEvent(world, "run_runtime_run_output_ref_mismatch", {
      type: "StepCompleted",
      payload: {
        stepPath: "first",
        stepId: "first",
        output: { number: 21 },
        outputRef: stepArtifact.artifactRef,
        artifactRefs: [stepArtifact.artifactRef],
        metadata: { uses: "tool.call", outputMode: "object" },
      },
    });
    await appendEvent(world, "run_runtime_run_output_ref_mismatch", {
      type: "RunCompleted",
      payload: { outputRef: runArtifact.artifactRef },
    });

    await expect(
      executeWorkflowVersion({
        world,
        workflowVersion,
        runId: "run_runtime_run_output_ref_mismatch",
        input: {},
        tools: registryFor({ first }),
      }),
    ).rejects.toThrow("does not match final step outputRef");
    expect(first).not.toHaveBeenCalled();
  });

  it("rejects completed replay when inline run output disagrees with the output artifact", async () => {
    const world = await tempWorld();
    const first = vi.fn(() => ({ number: 21 }));
    const workflowVersion = lockedWorkflowVersion(
      "wfver_runtime_inline_run_output_mismatch",
      oneStepWorkflow(),
      { tools: registryFor({ first }) },
    );
    const outputArtifact = await writeArtifact(world, {
      runId: "run_runtime_inline_run_output_mismatch",
      stepPath: "first",
      name: "output",
      payload: { number: 21 },
      contentType: "application/json",
    });
    await appendEvent(world, "run_runtime_inline_run_output_mismatch", {
      type: "WorkflowVersionRegistered",
      payload: {
        workflowVersionId: workflowVersion.id,
        workflowVersionHash: workflowVersion.hash,
      },
    });
    await appendEvent(world, "run_runtime_inline_run_output_mismatch", {
      type: "RunStarted",
      payload: { workflowVersionId: workflowVersion.id },
    });
    await appendEvent(world, "run_runtime_inline_run_output_mismatch", {
      type: "StepScheduled",
      payload: { stepPath: "first", stepId: "first", uses: "tool.call" },
    });
    await appendEvent(world, "run_runtime_inline_run_output_mismatch", {
      type: "StepCompleted",
      payload: {
        stepPath: "first",
        stepId: "first",
        output: { number: 21 },
        outputRef: outputArtifact.artifactRef,
        artifactRefs: [outputArtifact.artifactRef],
        metadata: { uses: "tool.call", outputMode: "object" },
      },
    });
    await appendEvent(world, "run_runtime_inline_run_output_mismatch", {
      type: "RunCompleted",
      payload: {
        output: { number: 99 },
        outputRef: outputArtifact.artifactRef,
      },
    });

    await expect(
      executeWorkflowVersion({
        world,
        workflowVersion,
        runId: "run_runtime_inline_run_output_mismatch",
        input: {},
        tools: registryFor({ first }),
      }),
    ).rejects.toThrow("does not match output artifact");
    expect(first).not.toHaveBeenCalled();
  });

  it("rejects replay when inline completed step output disagrees with the output artifact", async () => {
    const world = await tempWorld();
    const second = vi.fn(() => ({ doubled: 42 }));
    const workflowVersion = lockedWorkflowVersion(
      "wfver_runtime_step_output_mismatch",
      twoStepWorkflow(),
      { tools: registryFor({ first: () => ({ number: 21 }), second }) },
    );
    const firstArtifact = await writeArtifact(world, {
      runId: "run_runtime_step_output_mismatch",
      stepPath: "first",
      name: "output",
      payload: { number: 21 },
      contentType: "application/json",
    });
    const secondArtifact = await writeArtifact(world, {
      runId: "run_runtime_step_output_mismatch",
      stepPath: "second",
      name: "output",
      payload: { doubled: 42 },
      contentType: "application/json",
    });
    await appendEvent(world, "run_runtime_step_output_mismatch", {
      type: "WorkflowVersionRegistered",
      payload: {
        workflowVersionId: workflowVersion.id,
        workflowVersionHash: workflowVersion.hash,
      },
    });
    await appendEvent(world, "run_runtime_step_output_mismatch", {
      type: "RunStarted",
      payload: { workflowVersionId: workflowVersion.id },
    });
    await appendEvent(world, "run_runtime_step_output_mismatch", {
      type: "StepScheduled",
      payload: { stepPath: "first", stepId: "first", uses: "tool.call" },
    });
    await appendEvent(world, "run_runtime_step_output_mismatch", {
      type: "StepCompleted",
      payload: {
        stepPath: "first",
        stepId: "first",
        output: { number: 99 },
        outputRef: firstArtifact.artifactRef,
        artifactRefs: [firstArtifact.artifactRef],
        metadata: { uses: "tool.call", outputMode: "object" },
      },
    });

    await expect(
      executeWorkflowVersion({
        world,
        workflowVersion,
        runId: "run_runtime_step_output_mismatch",
        input: {},
        tools: registryFor({
          first: () => ({ number: 21 }),
          second,
        }),
      }),
    ).rejects.toThrow("StepCompleted output does not match output artifact");
    expect(second).not.toHaveBeenCalled();

    await appendEvent(world, "run_runtime_step_output_mismatch", {
      type: "StepScheduled",
      payload: { stepPath: "second", stepId: "second", uses: "tool.call" },
    });
    await appendEvent(world, "run_runtime_step_output_mismatch", {
      type: "StepCompleted",
      payload: {
        stepPath: "second",
        stepId: "second",
        output: { doubled: 42 },
        outputRef: secondArtifact.artifactRef,
        artifactRefs: [secondArtifact.artifactRef],
        metadata: { uses: "tool.call", outputMode: "object" },
      },
    });
    await appendEvent(world, "run_runtime_step_output_mismatch", {
      type: "RunCompleted",
      payload: {
        output: { doubled: 42 },
        outputRef: secondArtifact.artifactRef,
      },
    });

    await expect(
      executeWorkflowVersion({
        world,
        workflowVersion,
        runId: "run_runtime_step_output_mismatch",
        input: {},
        tools: registryFor({
          first: () => ({ number: 21 }),
          second,
        }),
      }),
    ).rejects.toThrow("StepCompleted output does not match output artifact");
  });

  it("surfaces artifact corruption when resuming an already failed run", async () => {
    const world = await tempWorld();
    const first = vi.fn(() => ({ number: 21 }));
    let secondShouldFail = true;
    const second = vi.fn(() => {
      if (secondShouldFail) {
        throw new Error("second unavailable");
      }
      return { doubled: 42 };
    });
    const workflowVersion = lockedWorkflowVersion(
      "wfver_runtime_failed_artifact_replay",
      twoStepWorkflow(),
      { tools: registryFor({ first, second }) },
    );

    const failed = await executeWorkflowVersion({
      world,
      workflowVersion,
      runId: "run_runtime_failed_artifact_replay",
      input: {},
      tools: registryFor({ first, second }),
      maxAttempts: 1,
    });
    expect(failed.status).toBe("failed");
    const firstStep = failed.state.steps.first;
    if (firstStep?.outputRef === undefined) {
      throw new Error("Expected first step output artifact.");
    }
    const artifact = await readArtifact(world, firstStep.outputRef);
    await rm(join(world.dataDir, "artifacts", "blobs", `${artifact.manifest.artifactId}.bin`), {
      force: true,
    });
    secondShouldFail = false;

    await expect(
      executeWorkflowVersion({
        world,
        workflowVersion,
        runId: "run_runtime_failed_artifact_replay",
        input: {},
        tools: registryFor({ first, second }),
        maxAttempts: 2,
      }),
    ).rejects.toThrow("Artifact not found");
    expect(first).toHaveBeenCalledTimes(1);
  });

  it("surfaces artifact ownership corruption when resuming an already failed run", async () => {
    const world = await tempWorld();
    const first = vi.fn(() => ({ number: 21 }));
    const second = vi.fn(() => {
      throw new Error("second unavailable");
    });
    const workflowVersion = lockedWorkflowVersion(
      "wfver_runtime_failed_artifact_owner",
      twoStepWorkflow(),
      { tools: registryFor({ first, second }) },
    );

    const failed = await executeWorkflowVersion({
      world,
      workflowVersion,
      runId: "run_runtime_failed_artifact_owner",
      input: {},
      tools: registryFor({ first, second }),
      maxAttempts: 1,
    });
    expect(failed.status).toBe("failed");
    const firstStep = failed.state.steps.first;
    if (firstStep?.outputRef === undefined) {
      throw new Error("Expected first step output artifact.");
    }
    const artifact = await readArtifact(world, firstStep.outputRef);
    await writeFile(
      join(world.dataDir, "artifacts", `${artifact.manifest.artifactId}.json`),
      `${canonicalJson({
        ...artifact.manifest,
        stepPath: "different-step",
      })}\n`,
      "utf8",
    );
    await writeArtifact(world, {
      runId: "run_runtime_failed_artifact_owner",
      stepPath: "different-step",
      name: "unrelated",
      payload: artifact.payload,
      contentType: artifact.manifest.contentType,
    });

    await expect(
      executeWorkflowVersion({
        world,
        workflowVersion,
        runId: "run_runtime_failed_artifact_owner",
        input: {},
        tools: registryFor({ first, second }),
        maxAttempts: 2,
      }),
    ).rejects.toThrow("does not belong to step");
    expect(first).toHaveBeenCalledTimes(1);
  });

  it("surfaces malformed artifact manifests when resuming an already failed run", async () => {
    const world = await tempWorld();
    const first = vi.fn(() => ({ number: 21 }));
    const second = vi.fn(() => {
      throw new Error("second unavailable");
    });
    const workflowVersion = lockedWorkflowVersion(
      "wfver_runtime_failed_artifact_manifest",
      twoStepWorkflow(),
      { tools: registryFor({ first, second }) },
    );

    const failed = await executeWorkflowVersion({
      world,
      workflowVersion,
      runId: "run_runtime_failed_artifact_manifest",
      input: {},
      tools: registryFor({ first, second }),
      maxAttempts: 1,
    });
    expect(failed.status).toBe("failed");
    const firstStep = failed.state.steps.first;
    if (firstStep?.outputRef === undefined) {
      throw new Error("Expected first step output artifact.");
    }
    const artifact = await readArtifact(world, firstStep.outputRef);
    await writeFile(
      join(world.dataDir, "artifacts", `${artifact.manifest.artifactId}.json`),
      "{ malformed",
      "utf8",
    );

    await expect(
      executeWorkflowVersion({
        world,
        workflowVersion,
        runId: "run_runtime_failed_artifact_manifest",
        input: {},
        tools: registryFor({ first, second }),
        maxAttempts: 2,
      }),
    ).rejects.toThrow();
    expect(first).toHaveBeenCalledTimes(1);
  });

  it("surfaces valid JSON artifact manifests with invalid encoding on failed replay", async () => {
    const world = await tempWorld();
    const first = vi.fn(() => ({ number: 21 }));
    const second = vi.fn(() => {
      throw new Error("second unavailable");
    });
    const workflowVersion = lockedWorkflowVersion(
      "wfver_runtime_failed_artifact_manifest_shape",
      twoStepWorkflow(),
      { tools: registryFor({ first, second }) },
    );

    const failed = await executeWorkflowVersion({
      world,
      workflowVersion,
      runId: "run_runtime_failed_artifact_manifest_shape",
      input: {},
      tools: registryFor({ first, second }),
      maxAttempts: 1,
    });
    expect(failed.status).toBe("failed");
    const firstStep = failed.state.steps.first;
    if (firstStep?.outputRef === undefined) {
      throw new Error("Expected first step output artifact.");
    }
    const artifact = await readArtifact(world, firstStep.outputRef);
    await writeFile(
      join(world.dataDir, "artifacts", `${artifact.manifest.artifactId}.json`),
      `${canonicalJson({
        ...artifact.manifest,
        encoding: "rot13",
      })}\n`,
      "utf8",
    );

    await expect(
      executeWorkflowVersion({
        world,
        workflowVersion,
        runId: "run_runtime_failed_artifact_manifest_shape",
        input: {},
        tools: registryFor({ first, second }),
        maxAttempts: 2,
      }),
    ).rejects.toThrow("Artifact manifest");
    expect(first).toHaveBeenCalledTimes(1);
  });

  it("resolves the LWIR-approved expression subset at runtime", async () => {
    const world = await tempWorld();
    const first = vi.fn(() => ({ number: 21, profile: { name: "Ada" } }));
    const second = vi.fn((input: unknown) => {
      expect(input).toEqual({
        bracket: 21,
        label: "2 Ada true",
        digest: sha256Digest("ticket-1"),
      });
      return { ok: true };
    });

    const result = await executeWorkflowVersion({
      world,
      workflowVersion: lockedWorkflowVersion(
        "wfver_runtime_expression_subset",
        expressionSubsetWorkflow(),
        { tools: registryFor({ first, second }) },
      ),
      runId: "run_runtime_expression_subset",
      input: { ticketId: "ticket-1", items: ["a", "b"] },
      tools: registryFor({ first, second }),
    });

    if (result.status === "failed") {
      throw new Error(JSON.stringify(result.error));
    }
    expect(result.status).toBe("completed");
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("does not read inherited Array prototype indexes in expressions", async () => {
    const world = await tempWorld();
    const tool = vi.fn(() => ({ ok: true }));

    Object.defineProperty(Array.prototype, "0", {
      configurable: true,
      writable: true,
      value: "polluted",
    });
    try {
      const result = await executeWorkflowVersion({
        world,
        workflowVersion: lockedWorkflowVersion("wfver_runtime_array_index", arrayIndexWorkflow(), {
          tools: registryFor({ read: tool }),
        }),
        runId: "run_runtime_array_index",
        input: { items: [] },
        tools: registryFor({ read: tool }),
      });

      expect(result.status).toBe("failed");
      expect(tool).not.toHaveBeenCalled();
    } finally {
      delete Array.prototype[0];
    }
  });

  it("fails compiled workflow versions when runtime capability locks drift", async () => {
    const world = await tempWorld();
    const tool = Object.assign(vi.fn(() => ({ ok: true })), {
      description: "Changed lookup behavior.",
    });

    const result = await executeWorkflowVersion({
      world,
      workflowVersion: capabilityDriftWorkflowVersion(),
      runId: "run_runtime_capability_drift",
      input: {},
      tools: registryFor({ lookup: tool }),
    });

    expect(result.status).toBe("failed");
    expect(tool).not.toHaveBeenCalled();
    if (result.status !== "failed") {
      throw new Error("Expected capability drift workflow to fail.");
    }
    expect(result.error).toEqual(
      expect.objectContaining({ message: expect.stringContaining("capability_drift") }),
    );
  });

  it("fails compiled workflow versions when tool output schemas drift", async () => {
    const world = await tempWorld();
    const original = Object.assign(vi.fn(() => ({ ok: true })), {
      description: "Lookup customer.",
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["ok"],
        properties: {
          ok: { type: "boolean" },
        },
      },
    });
    const drifted = Object.assign(vi.fn(() => ({ ok: true })), {
      description: "Lookup customer.",
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["ok"],
        properties: {
          ok: { type: "string" },
        },
      },
    });
    const lwir: LwirWorkflow = {
      apiVersion: "littleworkflow.dev/v0.1",
      kind: "Workflow",
      metadata: { name: "runtime-capability-drift-output-schema" },
      input: { schema: { type: "object" } },
      output: { schema: { type: "object" } },
      permissions: { tools: ["lookup"] },
      steps: [
        {
          id: "lookup",
          uses: "tool.call",
          with: { tool: "lookup" },
          output: { mode: "object", schema: { type: "object" } },
        },
      ],
    };
    const workflowVersion = lockedWorkflowVersion(
      "wfver_runtime_capability_drift_output_schema",
      lwir,
      { tools: registryFor({ lookup: original }) },
    );

    const result = await executeWorkflowVersion({
      world,
      workflowVersion,
      runId: "run_runtime_capability_drift_output_schema",
      input: {},
      tools: registryFor({ lookup: drifted }),
    });

    expect(result.status).toBe("failed");
    expect(drifted).not.toHaveBeenCalled();
    if (result.status !== "failed") {
      throw new Error("Expected output-schema capability drift workflow to fail.");
    }
    expect(result.error).toEqual(
      expect.objectContaining({ message: expect.stringContaining("capability_drift") }),
    );
  });

  it("accepts opaque model slots using slot id fallback identity", async () => {
    const world = await tempWorld();
    const opaqueModel = {};
    const modelBinding = {
      aiSdkModel: opaqueModel,
      metadata: { id: "writer", description: "Opaque writer model." },
    };
    const aiLoop = {
      generate: vi.fn(async () => ({ output: "done" })),
    };
    const workerHarness = createWorkflowHarness({ aiLoop });

    const result = await executeWorkflowVersion({
      world,
      workflowVersion: lockedWorkflowVersion("wfver_runtime_opaque_model", promptWorkflow(), {
        models: { writer: modelBinding },
      }),
      runId: "run_runtime_opaque_model",
      input: { name: "Ada", title: "Engineer" },
      models: { writer: modelBinding },
      workerHarness,
    });

    expect(result.status).toBe("completed");
    expect(aiLoop.generate).toHaveBeenCalledTimes(1);
  });

  it("accepts raw runtime bindings for known registry models with implicit metadata", async () => {
    const world = await tempWorld();
    const rawModel = { provider: "openai", modelId: "gpt-4o-mini" };
    const aiLoop = {
      generate: vi.fn(async (options) => {
        expect(options.model).toBe(rawModel);
        return { output: "done" };
      }),
    };
    const workerHarness = createWorkflowHarness({ aiLoop });

    const result = await executeWorkflowVersion({
      world,
      workflowVersion: lockedWorkflowVersion("wfver_runtime_registry_raw_model", promptWorkflow(), {
        models: { writer: model(rawModel) },
      }),
      runId: "run_runtime_registry_raw_model",
      input: { name: "Ada", title: "Engineer" },
      models: { writer: rawModel },
      workerHarness,
    });

    if (result.status === "failed") {
      throw new Error(JSON.stringify(result.error));
    }
    expect(result.status).toBe("completed");
    expect(aiLoop.generate).toHaveBeenCalledTimes(1);
  });

  it("accepts raw runtime bindings for explicitly authored model slot ids", async () => {
    const world = await tempWorld();
    const rawModel = { provider: "openai", modelId: "gpt-4o-mini" };
    const aiLoop = {
      generate: vi.fn(async (options) => {
        expect(options.model).toBe(rawModel);
        return { output: "done" };
      }),
    };
    const workerHarness = createWorkflowHarness({ aiLoop });

    const result = await executeWorkflowVersion({
      world,
      workflowVersion: lockedWorkflowVersion("wfver_runtime_explicit_raw_model", promptWorkflow(), {
        models: { writer: model(rawModel, { id: "writer" }) },
      }),
      runId: "run_runtime_explicit_raw_model",
      input: { name: "Ada", title: "Engineer" },
      models: { writer: rawModel },
      workerHarness,
    });

    if (result.status === "failed") {
      throw new Error(JSON.stringify(result.error));
    }
    expect(result.status).toBe("completed");
    expect(aiLoop.generate).toHaveBeenCalledTimes(1);
  });

  it("normalizes explicit model slot metadata when checking known registry model locks", async () => {
    const world = await tempWorld();
    const explicitModelSlot = {
      aiSdkModel: { provider: "openai", modelId: "gpt-4o-mini" },
      metadata: { id: "writer" },
    };
    const aiLoop = {
      generate: vi.fn(async () => ({ output: "done" })),
    };
    const workerHarness = createWorkflowHarness({ aiLoop });

    const result = await executeWorkflowVersion({
      world,
      workflowVersion: lockedWorkflowVersion("wfver_runtime_explicit_registry_model", promptWorkflow(), {
        models: { writer: explicitModelSlot },
      }),
      runId: "run_runtime_explicit_registry_model",
      input: { name: "Ada", title: "Engineer" },
      models: { writer: explicitModelSlot },
      workerHarness,
    });

    if (result.status === "failed") {
      throw new Error(JSON.stringify(result.error));
    }
    expect(result.status).toBe("completed");
    expect(aiLoop.generate).toHaveBeenCalledTimes(1);
  });

  it("ignores removed model metadata fields when checking runtime model locks", async () => {
    const world = await tempWorld();
    const modelBinding = {
      aiSdkModel: { providerId: "test", modelId: "writer" },
      metadata: {
        providerId: "test",
        modelId: "writer",
        tools: {
          inspectProfile: {
            description: "Inspect a profile while planning.",
            inputSchema: {
              type: "object",
              properties: { name: { type: "string" } },
              required: ["name"],
              additionalProperties: false,
            },
          },
        },
      },
    };
    const liveModelBinding = {
      ...modelBinding,
      metadata: {
        ...modelBinding.metadata,
        tools: {
          inspectProfile: {
            description: "Inspect a profile while planning.",
            inputSchema: z.object({ name: z.string() }),
          },
        },
      },
    };
    const aiLoop = {
      generate: vi.fn(async () => ({ output: "done" })),
    };
    const workerHarness = createWorkflowHarness({ aiLoop });

    const result = await executeWorkflowVersion({
      world,
      workflowVersion: lockedWorkflowVersion("wfver_runtime_model_tool_schema", promptWorkflow(), {
        models: { writer: modelBinding },
      }),
      runId: "run_runtime_model_tool_schema",
      input: { name: "Ada", title: "Engineer" },
      models: { writer: liveModelBinding },
      workerHarness,
    });

    expect(result.status).toBe("completed");
    expect(aiLoop.generate).toHaveBeenCalledTimes(1);
  });

  it("accepts opaque model bindings using slot id fallback identity", async () => {
    const world = await tempWorld();
    const aiLoop = {
      generate: vi.fn(async () => ({ output: "done" })),
    };
    const workerHarness = createWorkflowHarness({ aiLoop });

    const result = await executeWorkflowVersion({
      world,
      workflowVersion: lockedWorkflowVersion("wfver_runtime_opaque_model_reject", promptWorkflow(), {
        models: { writer: {} },
      }),
      runId: "run_runtime_opaque_model_reject",
      input: { name: "Ada", title: "Engineer" },
      models: { writer: {} },
      workerHarness,
    });

    expect(result.status).toBe("completed");
    expect(aiLoop.generate).toHaveBeenCalledTimes(1);
  });

  it("accepts provider-only model bindings using slot id fallback identity", async () => {
    const world = await tempWorld();
    const aiLoop = {
      generate: vi.fn(async () => ({ output: "done" })),
    };
    const workerHarness = createWorkflowHarness({ aiLoop });

    const result = await executeWorkflowVersion({
      world,
      workflowVersion: lockedWorkflowVersion("wfver_runtime_provider_only_model", promptWorkflow(), {
        models: { writer: { provider: "mock" } },
      }),
      runId: "run_runtime_provider_only_model",
      input: { name: "Ada", title: "Engineer" },
      models: { writer: { provider: "mock" } },
      workerHarness,
    });

    expect(result.status).toBe("completed");
    expect(aiLoop.generate).toHaveBeenCalledTimes(1);
  });

  it("rejects executable workflow versions without hashes and capability locks", async () => {
    const world = await tempWorld();
    const tool = vi.fn(() => ({ ok: true }));

    await expect(
      executeWorkflowVersion({
        world,
        workflowVersion: { id: "wfver_runtime_unlocked", lwir: unapprovedToolWorkflow() },
        runId: "run_runtime_unlocked",
        input: {},
        tools: registryFor({ hidden: tool }),
      }),
    ).rejects.toThrow("locked WorkflowVersion");
    expect(tool).not.toHaveBeenCalled();
  });

  it("rejects locked workflow versions whose hash and lock metadata are inconsistent", async () => {
    const world = await tempWorld();
    const first = vi.fn(() => ({ number: 21 }));
    const forged = {
      ...lockedWorkflowVersion("wfver_runtime_forged_lock", oneStepWorkflow(), {
        tools: registryFor({ first }),
      }),
      hash: sha256Digest("forged"),
    };

    await expect(
      executeWorkflowVersion({
        world,
        workflowVersion: forged,
        runId: "run_runtime_forged_lock",
        input: {},
        tools: registryFor({ first }),
      }),
    ).rejects.toThrow("WorkflowVersion lock mismatch");
    expect(first).not.toHaveBeenCalled();
  });

  it("rejects locked workflow versions with self-consistent forged compiled identity", async () => {
    const world = await tempWorld();
    const first = vi.fn(() => ({ number: 21 }));
    const forgedBase = lockedWorkflowVersion("wfver_runtime_self_signed_lock", oneStepWorkflow(), {
      tools: registryFor({ first }),
    });
    const forgedHash = sha256Digest({ forged: "compiled-version" });
    const forged = {
      ...forgedBase,
      hash: forgedHash,
      lock: {
        ...forgedBase.lock,
        workflowVersionHash: forgedHash,
      },
    };

    await expect(
      executeWorkflowVersion({
        world,
        workflowVersion: forged,
        runId: "run_runtime_self_signed_lock",
        input: {},
        tools: registryFor({ first }),
      }),
    ).rejects.toThrow("WorkflowVersion lock mismatch");
    expect(first).not.toHaveBeenCalled();
  });

  it("rejects replay when a same-id workflow version hash changes", async () => {
    const world = await tempWorld();
    const first = vi.fn(() => ({ number: 21 }));
    const original = lockedWorkflowVersion("wfver_runtime_hash_mismatch", oneStepWorkflow(), {
      tools: registryFor({ first }),
    });
    await executeWorkflowVersion({
      world,
      workflowVersion: original,
      runId: "run_runtime_hash_mismatch",
      input: {},
      tools: registryFor({ first }),
    });

    const changed = lockedWorkflowVersion("wfver_runtime_hash_mismatch", changedOneStepWorkflow(), {
      tools: registryFor({ first }),
    });

    await expect(
      executeWorkflowVersion({
        world,
        workflowVersion: changed,
        runId: "run_runtime_hash_mismatch",
        input: {},
        tools: registryFor({ first }),
      }),
    ).rejects.toThrow("WorkflowVersion mismatch");
    expect(first).toHaveBeenCalledTimes(1);
  });

  it("rejects unsafe expression paths and prototype-polluting input keys", async () => {
    const world = await tempWorld();
    const tool = vi.fn(() => ({ ok: true }));

    const result = await executeWorkflowVersion({
      world,
      workflowVersion: lockedWorkflowVersion("wfver_runtime_unsafe_input", unsafeInputWorkflow(), {
        tools: registryFor({ unsafe: tool }),
      }),
      runId: "run_runtime_unsafe_input",
      input: { value: "safe" },
      tools: registryFor({ unsafe: tool }),
    });

    expect(result.status).toBe("failed");
    expect(tool).not.toHaveBeenCalled();
    if (result.status !== "failed") {
      throw new Error("Expected unsafe input workflow to fail.");
    }
    expect(result.error).toEqual(
      expect.objectContaining({ message: expect.stringContaining("__proto__") }),
    );
  });

  it("fails closed for unapproved tools and missing model bindings", async () => {
    const world = await tempWorld();
    const tool = vi.fn(() => ({ ok: true }));

    const toolResult = await executeWorkflowVersion({
      world,
      workflowVersion: lockedWorkflowVersion("wfver_runtime_unapproved_tool", unapprovedToolWorkflow(), {
        tools: registryFor({ hidden: tool }),
      }),
      runId: "run_runtime_unapproved_tool",
      input: {},
      tools: registryFor({ hidden: tool }),
    });
    expect(toolResult.status).toBe("failed");
    expect(tool).not.toHaveBeenCalled();

    const aiLoop = { generate: vi.fn(async () => ({ output: "done" })) };
    const workerHarness = createWorkflowHarness({ aiLoop });
    const aiResult = await executeWorkflowVersion({
      world,
      workflowVersion: lockedWorkflowVersion("wfver_runtime_missing_model", promptWorkflow()),
      runId: "run_runtime_missing_model",
      input: { name: "Ada", title: "Engineer" },
      workerHarness,
    });
    expect(aiResult.status).toBe("failed");
    expect(aiLoop.generate).not.toHaveBeenCalled();
  });

  it("rejects worker-harness artifact refs owned by another step", async () => {
    const world = await tempWorld();
    const workerHarness = {
      harnessId: "crossStepArtifactHarness@1.0.0",
      async run(task, ctx) {
        if (task.kind === "execute_step" && task.step.uses === "ai.generate") {
          const artifact = await writeArtifact(world, {
            runId: ctx.scope.runId,
            stepPath: "other-step",
            name: "evidence",
            payload: { claim: "not this step" },
            contentType: "application/json",
          });
          return { kind: "execute_step", output: { ok: true }, artifactRefs: [artifact.artifactRef] };
        }
        return { kind: "delegate_to_default" };
      },
    } satisfies Harness & { readonly harnessId: string };

    const result = await executeWorkflowVersion({
      world,
      workflowVersion: lockedWorkflowVersion(
        "wfver_runtime_cross_step_artifact",
        artifactClaimWorkflow(),
        { models: { writer: { provider: "mock", id: "writer" } } },
      ),
      runId: "run_runtime_cross_step_artifact",
      input: {},
      models: { writer: { provider: "mock", id: "writer" } },
      workerHarness,
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") {
      throw new Error("Expected cross-step artifact workflow to fail.");
    }
    expect(result.error).toEqual(
      expect.objectContaining({ message: expect.stringContaining("does not belong to step") }),
    );
  });

  it("fails closed when worker-harness artifact manifests are corrupt during active execution", async () => {
    const world = await tempWorld();
    const harnessCalls = vi.fn(async (task: Parameters<Harness["run"]>[0], ctx: Parameters<Harness["run"]>[1]) => {
      if (task.kind === "execute_step" && task.step.uses === "ai.generate") {
        const stepPath = ctx.scope.stepPath ?? task.stepContext.stepPath;
        const artifact = await writeArtifact(world, {
          runId: ctx.scope.runId,
          stepPath,
          name: "evidence",
          payload: { claim: "same step but corrupt manifest" },
          contentType: "application/json",
        });
        await writeFile(
          join(world.dataDir, "artifacts", `${artifact.artifactId}.json`),
          `${canonicalJson({
            ...artifact,
            sizeBytes: artifact.sizeBytes + 1,
          })}\n`,
          "utf8",
        );
        return { kind: "execute_step", output: { ok: true }, artifactRefs: [artifact.artifactRef] } as const;
      }
      return { kind: "delegate_to_default" } as const;
    });
    const workerHarness = {
      harnessId: "corruptArtifactHarness@1.0.0",
      run: harnessCalls,
    } satisfies Harness & { readonly harnessId: string };

    await expect(
      executeWorkflowVersion({
        world,
        workflowVersion: lockedWorkflowVersion(
          "wfver_runtime_corrupt_active_artifact",
          artifactClaimWorkflow(),
          { models: { writer: { provider: "mock", id: "writer" } } },
        ),
        runId: "run_runtime_corrupt_active_artifact",
        input: {},
        models: { writer: { provider: "mock", id: "writer" } },
        workerHarness,
      }),
    ).rejects.toThrow("Artifact manifest");

    const events = await listEvents(world, "run_runtime_corrupt_active_artifact");
    expect(events.map((event) => event.type)).not.toContain("StepFailed");
    expect(events.map((event) => event.type)).not.toContain("RunFailed");

    // P1.4: after fix, top-level in-flight attempts are resumable. The second call resumes
    // the running attempt (same attemptId) and re-executes the worker harness, which corrupts the
    // artifact again and throws the same manifest error (not "non-terminal attempt").
    await expect(
      executeWorkflowVersion({
        world,
        workflowVersion: lockedWorkflowVersion(
          "wfver_runtime_corrupt_active_artifact",
          artifactClaimWorkflow(),
          { models: { writer: { provider: "mock", id: "writer" } } },
        ),
        runId: "run_runtime_corrupt_active_artifact",
        input: {},
        models: { writer: { provider: "mock", id: "writer" } },
        workerHarness,
      }),
    ).rejects.toThrow("Artifact manifest");

    const retryEvents = await listEvents(world, "run_runtime_corrupt_active_artifact");
    expect(retryEvents.map((event) => event.type)).not.toContain("StepFailed");
    expect(retryEvents.map((event) => event.type)).not.toContain("RunFailed");
    // Still only one StepAttemptStarted — resume reuses the same attemptId.
    expect(retryEvents.filter((event) => event.type === "StepAttemptStarted")).toHaveLength(1);
    // Worker harness was called twice (once per executeWorkflowVersion call).
    expect(harnessCalls).toHaveBeenCalledTimes(2);

    // Third call with maxAttempts: 2 also resumes the still-running attempt and corrupts again.
    await expect(
      executeWorkflowVersion({
        world,
        workflowVersion: lockedWorkflowVersion(
          "wfver_runtime_corrupt_active_artifact",
          artifactClaimWorkflow(),
          { models: { writer: { provider: "mock", id: "writer" } } },
        ),
        runId: "run_runtime_corrupt_active_artifact",
        input: {},
        models: { writer: { provider: "mock", id: "writer" } },
        workerHarness,
        maxAttempts: 2,
      }),
    ).rejects.toThrow("Artifact manifest");

    const retryWithBudgetEvents = await listEvents(world, "run_runtime_corrupt_active_artifact");
    expect(
      retryWithBudgetEvents.filter((event) => event.type === "StepAttemptStarted"),
    ).toHaveLength(1);
    // Worker harness called three times total (once per executeWorkflowVersion call).
    expect(harnessCalls).toHaveBeenCalledTimes(3);
  });

  it("fails workflows with ambiguous terminal outputs", async () => {
    const world = await tempWorld();
    const left = vi.fn(() => ({ left: true }));
    const right = vi.fn(() => ({ right: true }));

    const result = await executeWorkflowVersion({
      world,
      workflowVersion: lockedWorkflowVersion(
        "wfver_runtime_ambiguous_terminal",
        ambiguousTerminalWorkflow(),
        { tools: registryFor({ left, right }) },
      ),
      runId: "run_runtime_ambiguous_terminal",
      input: {},
      tools: registryFor({ left, right }),
    });

    expect(result.status).toBe("failed");
    expect(left).not.toHaveBeenCalled();
    expect(right).not.toHaveBeenCalled();
    if (result.status !== "failed") {
      throw new Error("Expected ambiguous terminal workflow to fail.");
    }
    expect(result.error).toEqual(
      expect.objectContaining({ message: expect.stringContaining("Ambiguous terminal steps") }),
    );
  });

  it("omits inline output from StepCompleted when serialized size exceeds threshold", async () => {
    const world = await tempWorld();
    // Create a large output: 257KB string
    const largeString = "x".repeat(257_000);
    const tool = vi.fn(() => ({ data: largeString }));

    const result = await executeWorkflowVersion({
      world,
      workflowVersion: lockedWorkflowVersion("wfver_large_output", {
        apiVersion: "littleworkflow.dev/v0.1",
        kind: "Workflow",
        metadata: { name: "large-output-test" },
        input: { schema: { type: "object" } },
        output: { schema: { type: "object" } },
        permissions: { tools: ["large"] },
        steps: [
          {
            id: "large",
            uses: "tool.call",
            with: { tool: "large" },
            output: { mode: "object", schema: { type: "object" } },
          },
        ],
      } as LwirWorkflow, {
        tools: registryFor({ large: tool }),
      }),
      runId: "run_large_output",
      input: {},
      tools: registryFor({ large: tool }),
    });

    if (result.status !== "completed") {
      throw new Error("Expected workflow to complete");
    }

    const events = await listEvents(world, "run_large_output");
    const completed = events.find((e) => e.type === "StepCompleted");

    expect(completed).toBeDefined();
    expect(completed?.payload).toHaveProperty("outputRef");
    expect(completed?.payload).not.toHaveProperty("output");
  });

  it("keeps inline output in StepCompleted when serialized size is under threshold", async () => {
    const world = await tempWorld();
    const smallOutput = { message: "small" };
    const tool = vi.fn(() => smallOutput);

    const result = await executeWorkflowVersion({
      world,
      workflowVersion: lockedWorkflowVersion("wfver_small_output", {
        apiVersion: "littleworkflow.dev/v0.1",
        kind: "Workflow",
        metadata: { name: "small-output-test" },
        input: { schema: { type: "object" } },
        output: { schema: { type: "object" } },
        permissions: { tools: ["small"] },
        steps: [
          {
            id: "small",
            uses: "tool.call",
            with: { tool: "small" },
            output: { mode: "object", schema: { type: "object" } },
          },
        ],
      } as LwirWorkflow, {
        tools: registryFor({ small: tool }),
      }),
      runId: "run_small_output",
      input: {},
      tools: registryFor({ small: tool }),
    });

    if (result.status !== "completed") {
      throw new Error("Expected workflow to complete");
    }

    const events = await listEvents(world, "run_small_output");
    const completed = events.find((e) => e.type === "StepCompleted");

    expect(completed).toBeDefined();
    expect(completed?.payload).toHaveProperty("output");
    expect(completed?.payload).toHaveProperty("outputRef");
    expect(completed?.payload.output).toEqual(smallOutput);
  });

  it("respects world.maxConcurrentSteps as a global cap across parallel branches", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "little-workflow-runtime-max-concurrent-"));
    tempDirs.push(dataDir);

    let maxInFlight = 0;
    let inFlight = 0;

    const slowTool: RuntimeToolHandler = vi.fn(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 20));
      inFlight -= 1;
      return { ok: true };
    });

    const branchCount = 10;
    const candidates = Array.from({ length: branchCount }, (_, i) => ({ id: `item${i}` }));

    const lwir: LwirWorkflow = {
      apiVersion: "littleworkflow.dev/v0.1",
      kind: "Workflow",
      metadata: { name: "max-concurrent-steps-global-cap" },
      input: {
        schema: {
          type: "object",
          required: ["candidates"],
          properties: { candidates: { type: "array" } },
        },
      },
      output: { schema: { type: "array" } },
      permissions: { tools: ["slowTool"] },
      steps: [
        {
          id: "review",
          uses: "parallel",
          with: {
            items: "{{ input.candidates }}",
            cardinality: { kind: "matches_items" },
            itemKey: "{{ item.id }}",
            maxBranches: branchCount,
            maxConcurrency: branchCount,
            failureMode: "fail_fast",
            fanIn: { order: "input", output: "array" },
          },
          steps: [
            {
              id: "slow",
              uses: "tool.call",
              with: { tool: "slowTool" },
              input: { id: "{{ item.id }}" },
              output: { mode: "object", schema: { type: "object" } },
            },
          ],
          output: { mode: "array", schema: { type: "array" } },
        },
      ],
    };

    const world = localWorld({ dataDir, maxConcurrentSteps: 3 });

    const result = await executeWorkflowVersion({
      world,
      workflowVersion: lockedWorkflowVersion("wfver_max_concurrent", lwir, {
        tools: registryFor({ slowTool }),
      }),
      runId: "run_max_concurrent_steps",
      input: { candidates },
      tools: registryFor({ slowTool }),
    });

    expect(result.status).toBe("completed");
    expect(maxInFlight).toBeGreaterThan(0);
    expect(maxInFlight).toBeLessThanOrEqual(3);
  });

  it("handles undefined output from a step without crashing", async () => {
    const world = await tempWorld();
    const tool = vi.fn(() => undefined);

    const result = await executeWorkflowVersion({
      world,
      workflowVersion: lockedWorkflowVersion("wfver_undefined_output", {
        apiVersion: "littleworkflow.dev/v0.1",
        kind: "Workflow",
        metadata: { name: "undefined-output-test" },
        input: { schema: { type: "object" } },
        output: { schema: {} },
        permissions: { tools: ["undefined"] },
        steps: [
          {
            id: "undefined",
            uses: "tool.call",
            with: { tool: "undefined" },
            output: { mode: "json", schema: {} },
          },
        ],
      } as LwirWorkflow, {
        tools: registryFor({ undefined: tool }),
      }),
      runId: "run_undefined_output",
      input: {},
      tools: registryFor({ undefined: tool }),
    });

    // Should complete successfully even with undefined output
    expect(result.status).toBe("completed");

    const events = await listEvents(world, "run_undefined_output");
    const completed = events.find((e) => e.type === "StepCompleted");

    expect(completed).toBeDefined();
    // When output is undefined, it should be handled gracefully
    // The output field may be omitted or set to undefined
    expect(completed?.payload).toHaveProperty("outputRef");
  });
});

function workflow(): LwirWorkflow {
  return {
    apiVersion: "littleworkflow.dev/v0.1",
    kind: "Workflow",
    metadata: { name: "runtime-dag" },
    input: { schema: { type: "object" } },
    output: { schema: { type: "string" } },
    permissions: {
      models: ["structured", "writer"],
      tools: ["lookup"],
    },
    steps: [
      {
        id: "lookup",
        uses: "tool.call",
        with: { tool: "lookup" },
        input: { name: "{{ input.name }}" },
        output: {
          mode: "object",
          schema: { type: "object" },
        },
      },
      {
        id: "extract",
        uses: "ai.generate",
        needs: ["lookup"],
        with: { model: "structured" },
        input: {
          profile: "{{ steps.lookup.output.profile }}",
          request: "{{ input.request }}",
        },
        output: {
          mode: "object",
          schema: { type: "object" },
        },
      },
      {
        id: "draft",
        uses: "ai.generate",
        needs: ["extract"],
        with: { model: "writer" },
        input: "{{ steps.extract.output.profile }}",
        output: { mode: "text" },
      },
    ],
  };
}

function retryWorkflow(): LwirWorkflow {
  return retryWorkflowWithMaxAttempts(3);
}

function retryWorkflowWithMaxAttempts(maxAttempts: number): LwirWorkflow {
  return {
    apiVersion: "littleworkflow.dev/v0.1",
    kind: "Workflow",
    metadata: { name: "runtime-retry" },
    input: { schema: { type: "object" } },
    output: { schema: { type: "object" } },
    permissions: { tools: ["flaky"] },
    steps: [
      {
        id: "flaky",
        uses: "tool.call",
        with: { tool: "flaky" },
        output: { mode: "object", schema: { type: "object" } },
        retry: { maxAttempts },
      },
    ],
  } as unknown as LwirWorkflow;
}

function oneStepWorkflow(): LwirWorkflow {
  return {
    apiVersion: "littleworkflow.dev/v0.1",
    kind: "Workflow",
    metadata: { name: "runtime-replay-one" },
    input: { schema: { type: "object" } },
    output: { schema: { type: "object" } },
    permissions: { tools: ["first"] },
    steps: [
      {
        id: "first",
        uses: "tool.call",
        with: { tool: "first" },
        output: { mode: "object", schema: { type: "object" } },
      },
    ],
  };
}

function changedOneStepWorkflow(): LwirWorkflow {
  return {
    ...oneStepWorkflow(),
    steps: [
      {
        id: "first",
        uses: "tool.call",
        with: { tool: "first" },
        output: {
          mode: "object",
          schema: {
            type: "object",
            required: ["number"],
            properties: { number: { type: "number" } },
          },
        },
      },
    ],
  };
}

function twoStepWorkflow(): LwirWorkflow {
  return {
    apiVersion: "littleworkflow.dev/v0.1",
    kind: "Workflow",
    metadata: { name: "runtime-replay-two" },
    input: { schema: { type: "object" } },
    output: { schema: { type: "object" } },
    permissions: { tools: ["first", "second"] },
    steps: [
      {
        id: "first",
        uses: "tool.call",
        with: { tool: "first" },
        output: { mode: "object", schema: { type: "object" } },
      },
      {
        id: "second",
        uses: "tool.call",
        needs: ["first"],
        with: { tool: "second" },
        input: { previous: "{{ steps.first.output.number }}" },
        output: { mode: "object", schema: { type: "object" } },
      },
    ],
  };
}

function terminalContractWorkflow(): LwirWorkflow {
  return {
    apiVersion: "littleworkflow.dev/v0.1",
    kind: "Workflow",
    metadata: { name: "runtime-terminal-contract" },
    input: { schema: { type: "object" } },
    output: { schema: { type: "object" } },
    permissions: { tools: ["report"] },
    steps: [
      {
        id: "report",
        uses: "tool.call",
        with: { tool: "report" },
        output: { mode: "text" },
      },
    ],
  };
}

function modeShapeWorkflow(): LwirWorkflow {
  return {
    apiVersion: "littleworkflow.dev/v0.1",
    kind: "Workflow",
    metadata: { name: "runtime-mode-shape" },
    input: { schema: { type: "object" } },
    output: { schema: true },
    permissions: { tools: ["shape"] },
    steps: [
      {
        id: "shape",
        uses: "tool.call",
        with: { tool: "shape" },
        output: { mode: "object", schema: true },
      },
    ],
  };
}

function stepSchemaWorkflow(): LwirWorkflow {
  return {
    apiVersion: "littleworkflow.dev/v0.1",
    kind: "Workflow",
    metadata: { name: "runtime-step-schema" },
    input: { schema: { type: "object" } },
    output: { schema: { type: "object" } },
    permissions: { tools: ["count"] },
    steps: [
      {
        id: "count",
        uses: "tool.call",
        with: { tool: "count" },
        output: {
          mode: "object",
          schema: {
            type: "object",
            required: ["count"],
            properties: { count: { type: "number" } },
          },
        },
      },
    ],
  };
}

function finalSchemaWorkflow(): LwirWorkflow {
  return {
    apiVersion: "littleworkflow.dev/v0.1",
    kind: "Workflow",
    metadata: { name: "runtime-final-schema" },
    input: { schema: { type: "object" } },
    output: {
      schema: {
        type: "object",
        required: ["summary"],
        properties: { summary: { type: "string" } },
      },
    },
    permissions: { tools: ["count"] },
    steps: [
      {
        id: "count",
        uses: "tool.call",
        with: { tool: "count" },
        output: { mode: "object", schema: { type: "object" } },
      },
    ],
  };
}

function arrayIndexWorkflow(): LwirWorkflow {
  return {
    apiVersion: "littleworkflow.dev/v0.1",
    kind: "Workflow",
    metadata: { name: "runtime-array-index" },
    input: { schema: { type: "object" } },
    output: { schema: { type: "object" } },
    permissions: { tools: ["read"] },
    steps: [
      {
        id: "read",
        uses: "tool.call",
        with: { tool: "read" },
        input: { value: "{{ input.items[0] }}" },
        output: { mode: "object", schema: { type: "object" } },
      },
    ],
  };
}

function expressionSubsetWorkflow(): LwirWorkflow {
  return {
    apiVersion: "littleworkflow.dev/v0.1",
    kind: "Workflow",
    metadata: { name: "runtime-expression-subset" },
    input: { schema: { type: "object" } },
    output: { schema: { type: "object" } },
    permissions: { tools: ["first", "second"] },
    steps: [
      {
        id: "first",
        uses: "tool.call",
        with: { tool: "first" },
        output: { mode: "object", schema: { type: "object" } },
      },
      {
        id: "second",
        uses: "tool.call",
        needs: ["first"],
        with: { tool: "second" },
        input: {
          bracket: "{{ steps[\"first\"].output.number }}",
          label:
            "{{ len(input.items) }} {{ coalesce(input.nickname, steps.first.output.profile.name) }} {{ steps.first.output.number >= 20 }}",
          digest: "{{ sha256(input.ticketId) }}",
        },
        output: { mode: "object", schema: { type: "object" } },
      },
    ],
  };
}

function capabilityDriftWorkflowVersion() {
  const lwir: LwirWorkflow = {
    apiVersion: "littleworkflow.dev/v0.1",
    kind: "Workflow",
    metadata: { name: "runtime-capability-drift" },
    input: { schema: { type: "object" } },
    output: { schema: { type: "object" } },
    permissions: { tools: ["lookup"] },
    steps: [
      {
        id: "lookup",
        uses: "tool.call",
        with: { tool: "lookup" },
        output: { mode: "object", schema: { type: "object" } },
      },
    ],
  };
  return lockedWorkflowVersion("wfver_runtime_capability_drift", lwir, {
    tools: registryFor({
      lookup: Object.assign(() => ({}), { description: "Original lookup behavior." }),
    }),
  });
}

function promptWorkflow(): LwirWorkflow {
  return {
    apiVersion: "littleworkflow.dev/v0.1",
    kind: "Workflow",
    metadata: { name: "runtime-prompt" },
    input: { schema: { type: "object" } },
    output: { schema: { type: "string" } },
    permissions: { models: ["writer"] },
    steps: [
      {
        id: "prompt",
        uses: "ai.generate",
        with: {
          model: "writer",
          prompt: "Summarize {{ input.name }} for {{ input.title }}.",
        },
        output: { mode: "text" },
      },
    ],
  };
}

function unsafeInputWorkflow(): LwirWorkflow {
  return {
    apiVersion: "littleworkflow.dev/v0.1",
    kind: "Workflow",
    metadata: { name: "runtime-unsafe-input" },
    input: { schema: { type: "object" } },
    output: { schema: { type: "object" } },
    permissions: { tools: ["unsafe"] },
    steps: [
      {
        id: "unsafe",
        uses: "tool.call",
        with: { tool: "unsafe" },
        input: { ["__proto__"]: "{{ input.value }}" },
        output: { mode: "object", schema: { type: "object" } },
      },
    ],
  };
}

function unapprovedToolWorkflow(): LwirWorkflow {
  return {
    apiVersion: "littleworkflow.dev/v0.1",
    kind: "Workflow",
    metadata: { name: "runtime-unapproved-tool" },
    input: { schema: { type: "object" } },
    output: { schema: { type: "object" } },
    permissions: { tools: [] },
    steps: [
      {
        id: "hidden",
        uses: "tool.call",
        with: { tool: "hidden" },
        output: { mode: "object", schema: { type: "object" } },
      },
    ],
  };
}

function artifactClaimWorkflow(): LwirWorkflow {
  return {
    apiVersion: "littleworkflow.dev/v0.1",
    kind: "Workflow",
    metadata: { name: "runtime-artifact-claim" },
    input: { schema: { type: "object" } },
    output: { schema: { type: "object" } },
    permissions: { models: ["writer"] },
    steps: [
      {
        id: "claim",
        uses: "ai.generate",
        with: { model: "writer" },
        output: { mode: "object", schema: { type: "object" } },
      },
    ],
  };
}

function ambiguousTerminalWorkflow(): LwirWorkflow {
  return {
    apiVersion: "littleworkflow.dev/v0.1",
    kind: "Workflow",
    metadata: { name: "runtime-ambiguous-terminal" },
    input: { schema: { type: "object" } },
    output: { schema: { type: "object" } },
    permissions: { tools: ["left", "right"] },
    steps: [
      {
        id: "left",
        uses: "tool.call",
        with: { tool: "left" },
        output: { mode: "object", schema: { type: "object" } },
      },
      {
        id: "right",
        uses: "tool.call",
        with: { tool: "right" },
        output: { mode: "object", schema: { type: "object" } },
      },
    ],
  };
}

function lockedWorkflowVersion(
  id: string,
  lwir: LwirWorkflow,
  bindings: {
    readonly models?: Record<string, unknown>;
    readonly tools?: ReturnType<typeof registryFor>;
  } = {},
) {
  const modelEntries = Object.entries(bindings.models ?? {});
  const lwirHash = sha256Digest(lwir);
  const lwirVersionId = lwirVersionIdForHash(lwirHash);
  const canonicalizer = "little-workflow-canonical-json@alpha";
  const modelSlots = modelEntries.map(([slotId, binding]) => {
    const metadata = isModelSlot(binding)
      ? model(binding.aiSdkModel, binding.metadata).metadata
      : {};
    const modelBinding = isModelSlot(binding) ? binding.aiSdkModel : binding;
    const modelIdentity = modelIdentityForTest(slotId, modelBinding);
    return {
      slotId,
      role: "model",
      metadataHash: sha256Digest(safeModelMetadataForTest(metadata)),
      modelIdentityHash: sha256Digest(modelIdentity),
    };
  });
  const tools = [...(bindings.tools?.names() ?? [])]
    .sort((left, right) => left.localeCompare(right))
    .map((name) => {
      const registered = bindings.tools?.get(name);
      const description = typeof registered?.description === "string"
        ? registered.description
        : "";
      const inputSchema = registered?.inputSchema;
      const normalizedInputSchema =
        inputSchema === undefined ? undefined : normalizeSchema(inputSchema);
      const outputSchema = registered?.outputSchema;
      const normalizedOutputSchema =
        outputSchema === undefined ? undefined : normalizeSchema(outputSchema);
      const needsApproval = registered?.needsApproval;
      const approvalRequired =
        needsApproval !== undefined && needsApproval !== false ? true : undefined;
      return stripUndefined({
        name,
        scope: "global",
        description,
        inputSchema: normalizedInputSchema,
        outputSchema: normalizedOutputSchema,
        approvalRequired,
        descriptionHash: sha256Digest(description),
        inputSchemaHash:
          normalizedInputSchema === undefined ? undefined : sha256Digest(normalizedInputSchema),
        outputSchemaHash:
          normalizedOutputSchema === undefined ? undefined : sha256Digest(normalizedOutputSchema),
      });
    });
  const requestedOutput = { mode: "json", schema: lwir.output.schema };
  const capabilityManifest = {
    stepTypes: ["ai.generate", "tool.call", "code.run", "parallel"],
    toolSelection: "planner_selected",
    tools,
    models: modelSlots,
    modelSlots: modelSlots.map((slot) => slot.slotId),
    secrets: [],
    network: { default: "deny", allow: [] },
  };
  const capabilityManifestHash = sha256Digest(capabilityManifest);
  const requestId = `orq_${id}`;
  const requestHash = sha256Digest({ id, lwirHash, bindings: { modelSlots, tools } });
  const plannedInput = { testInput: id };
  const inputHash = sha256Digest(plannedInput);
  const plannedInputStructure = concreteInputStructure(plannedInput);
  const plannedInputStructureHash = sha256Digest(plannedInputStructure);
  const workflowDefinitionHash = sha256Digest({ id, name: lwir.metadata.name });
  const inputSchemaHash = sha256Digest(lwir.input.schema);
  const requestedOutputHash = sha256Digest(requestedOutput);
  const validationHash = computeCompilerValidationHash({
    canonicalizer,
    lwirVersionId,
    lwirHash,
    requestId,
    requestHash,
    inputHash,
    plannedInputStructureHash,
    workflowDefinitionHash,
    inputSchemaHash,
    requestedOutputHash,
    capabilityManifestHash,
  });
  const lockSeed: WorkflowVersionLockSeed = {
    lwirVersionId,
    lwirHash,
    requestId,
    requestHash,
    inputHash,
    plannedInputStructure,
    plannedInputStructureHash,
    workflowDefinitionHash,
    inputSchemaHash,
    requestedOutput,
    requestedOutputHash,
    capabilityManifest,
    capabilityManifestHash,
    modelSlots,
    tools,
    validationHash,
  };
  const { workflowVersionId, workflowVersionHash } =
    computeCompiledWorkflowVersionIdentity({
      canonicalizer,
      lwirVersionId,
      lwirHash,
      lockSeed,
    });
  return {
    id: workflowVersionId,
    hash: workflowVersionHash,
    canonicalizer,
    canonicalJson: canonicalJson(lwir),
    lwirVersionId,
    lwirHash,
    lwir,
    lock: {
      workflowVersionId,
      workflowVersionHash,
      ...lockSeed,
    },
  } as const;
}

function modelIdentityForTest(
  slotId: string,
  modelBinding: unknown,
): unknown {
  const providerId = stringProperty(modelBinding, "provider") ?? stringProperty(modelBinding, "providerId");
  const modelId = stringProperty(modelBinding, "modelId");
  if (providerId === undefined || modelId === undefined) {
    return { slotId };
  }
  return { providerId, modelId };
}

function safeModelMetadataForTest(metadata: Record<string, unknown>): unknown {
  return stripUndefined({
    id: metadata.id,
    description: metadata.description,
  });
}

function isModelSlot(value: unknown): value is {
  readonly aiSdkModel: unknown;
  readonly metadata: Record<string, unknown>;
} {
  return isRecord(value) && "aiSdkModel" in value && isRecord(value.metadata);
}

function propertyValue(value: unknown, key: string): unknown {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    return undefined;
  }
  return Object.hasOwn(value, key) ? (value as Record<string, unknown>)[key] : undefined;
}

function stringProperty(value: unknown, key: string): string | undefined {
  const property = propertyValue(value, key);
  if (typeof property === "string") {
    return property;
  }
  if (typeof property === "number" || typeof property === "boolean") {
    return String(property);
  }
  return undefined;
}

function stripUndefined<T extends Record<string, unknown>>(value: T): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) {
      result[key] = item;
    }
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Build a ToolRegistry from a plain handler map.
 * Descriptor info (description, inputSchema, outputSchema, needsApproval) is extracted
 * from own properties of each handler, matching how lockedWorkflowVersion builds the lock.
 */
function registryFor(handlers: Record<string, RuntimeToolHandler>) {
  const tools: Record<string, {
    description: string;
    inputSchema?: unknown;
    outputSchema?: unknown;
    needsApproval?: boolean;
    execute: (input: unknown, context: unknown) => Promise<unknown>;
  }> = {};
  for (const [name, handler] of Object.entries(handlers)) {
    const description = typeof propertyValue(handler, "description") === "string"
      ? (propertyValue(handler, "description") as string)
      : "";
    const inputSchema = propertyValue(handler, "inputSchema");
    const outputSchema = propertyValue(handler, "outputSchema");
    const needsApproval = propertyValue(handler, "needsApproval");
    tools[name] = {
      description,
      ...(inputSchema !== undefined ? { inputSchema } : {}),
      ...(outputSchema !== undefined ? { outputSchema } : {}),
      ...(needsApproval !== undefined ? { needsApproval: needsApproval as boolean } : {}),
      execute: handler as (input: unknown, context: unknown) => Promise<unknown>,
    };
  }
  return createToolRegistry(tools);
}

describe("visit-indexed step paths (Layer A §2.4) — runtime", () => {
  it("stepPathFor returns base step.id for maxVisits === 1 steps", () => {
    const step = { id: "worker", uses: "tool.call" as const };
    expect(stepPathFor(step, "", 0)).toBe("worker");
    // visitIndex is ignored for DAG steps
    expect(stepPathFor(step, "", 5)).toBe("worker");
  });

  it("stepPathFor includes .visit[N] suffix for maxVisits > 1 steps", () => {
    const step = { id: "worker", uses: "tool.call" as const, maxVisits: 3 };
    expect(stepPathFor(step, "", 0)).toBe("worker.visit[0]");
    expect(stepPathFor(step, "", 1)).toBe("worker.visit[1]");
    expect(stepPathFor(step, "", 2)).toBe("worker.visit[2]");
  });

  it("stepPathFor uses branchPath prefix for parallel branch sub-steps", () => {
    const dagStep = { id: "extract", uses: "tool.call" as const };
    expect(stepPathFor(dagStep, "fan[k_1]", 0)).toBe("fan[k_1].extract");

    const multiVisitStep = { id: "worker", uses: "tool.call" as const, maxVisits: 2 };
    expect(stepPathFor(multiVisitStep, "fan[k_1]", 0)).toBe("fan[k_1].worker.visit[0]");
  });

  it("RuntimeMaxVisitsError carries causeCode and failedStepPath", () => {
    const err = new RuntimeMaxVisitsError(
      "Step 'worker' has reached its maxVisits cap of 2.",
      "worker.visit[2]",
    );
    expect(err.causeCode).toBe("max_visits_exceeded");
    expect(err.failedStepPath).toBe("worker.visit[2]");
    expect(err.name).toBe("MaxVisitsExceededError");
    expect(err).toBeInstanceOf(Error);
  });

  it("records max_visits_exceeded in RunFailed event and surfaces it via executeWorkflowVersion — wired in Task 14 via decision executor", async () => {
    // Workflow: worker (maxVisits:2) → route (maxVisits:3, decision default:worker)
    // route always routes back to worker, so visit[2] would overshoot the cap.
    const world = await tempWorld();
    let workerCallCount = 0;
    const workerTool = vi.fn(() => {
      workerCallCount += 1;
      return { result: "done" };
    });
    const lwir: LwirWorkflow = {
      apiVersion: "littleworkflow.dev/v0.1",
      kind: "Workflow",
      metadata: { name: "runtime-max-visits-exceeded" },
      input: { schema: { type: "object" } },
      output: { schema: { type: "object" } },
      permissions: { tools: ["worker"] },
      steps: [
        {
          id: "worker",
          uses: "tool.call",
          with: { tool: "worker" },
          maxVisits: 2,
          output: { mode: "object", schema: { type: "object" } },
        },
        {
          id: "route",
          uses: "decision",
          needs: ["worker"],
          maxVisits: 3,
          with: { cases: [], default: "worker" },
        },
      ],
    };
    const workflowVersion = lockedWorkflowVersion(
      "wfver_runtime_max_visits_exceeded",
      lwir,
      { tools: registryFor({ worker: workerTool }) },
    );
    const result = await executeWorkflowVersion({
      world,
      workflowVersion,
      runId: "run_runtime_max_visits_exceeded",
      input: {},
      tools: registryFor({ worker: workerTool }),
    });
    expect(result.status).toBe("failed");
    const failedResult = result as import("./runtime.js").RuntimeFailedRunResult;
    expect(failedResult.error).toMatchObject({
      causeCode: "max_visits_exceeded",
    });
    // worker ran twice (visit[0] and visit[1]) before the cap was hit
    expect(workerCallCount).toBe(2);
    const events = await listEvents(world, "run_runtime_max_visits_exceeded");
    const runFailed = events.find((e) => e.type === "RunFailed");
    expect(runFailed).toBeDefined();
    expect(runFailed?.payload.error).toMatchObject({
      causeCode: "max_visits_exceeded",
      failedStepPath: "worker.visit[2]",
    });
  });
});

describe("decision step execution (Layer A §2.2)", () => {
  it("commits a StepCompleted with output { chosen: targetId } when a case matches", async () => {
    const world = await tempWorld();
    // Workflow: a → route (case: a.ok → b, default: c) → b or c
    const lwir: LwirWorkflow = {
      apiVersion: "littleworkflow.dev/v0.1",
      kind: "Workflow",
      metadata: { name: "runtime-decision-chosen" },
      input: { schema: { type: "object" } },
      output: { schema: { type: "object" } },
      permissions: { tools: ["a", "b", "c"] },
      steps: [
        {
          id: "a",
          uses: "tool.call",
          with: { tool: "a" },
          output: { mode: "object", schema: { type: "object" } },
        },
        {
          id: "route",
          uses: "decision",
          needs: ["a"],
          with: {
            cases: [{ when: "{{ steps.a.output.ok }}", to: "b" }],
            default: "c",
          },
        },
        {
          id: "b",
          uses: "tool.call",
          needs: ["a"],
          with: { tool: "b" },
          output: { mode: "object", schema: { type: "object" } },
        },
        {
          id: "c",
          uses: "tool.call",
          needs: ["a"],
          with: { tool: "c" },
          output: { mode: "object", schema: { type: "object" } },
        },
      ],
    };
    const workflowVersion = lockedWorkflowVersion(
      "wfver_runtime_decision_chosen",
      lwir,
      { tools: registryFor({ a: () => ({ ok: true }), b: () => ({ result: "b" }), c: () => ({ result: "c" }) }) },
    );
    const result = await executeWorkflowVersion({
      world,
      workflowVersion,
      runId: "run_runtime_decision_chosen",
      input: {},
      tools: registryFor({ a: () => ({ ok: true }), b: () => ({ result: "b" }), c: () => ({ result: "c" }) }),
    });
    expect(result.status).toBe("completed");
    const events = await listEvents(world, "run_runtime_decision_chosen");
    const routeCompleted = events.find(
      (e) => e.type === "StepCompleted" && e.payload.stepId === "route",
    );
    expect(routeCompleted).toBeDefined();
    expect(routeCompleted?.payload.output).toEqual({ chosen: "b" });
    expect(routeCompleted?.payload.metadata).toMatchObject({ uses: "decision" });
  });

  it("commits chosen === default when no case matches", async () => {
    const world = await tempWorld();
    const lwir: LwirWorkflow = {
      apiVersion: "littleworkflow.dev/v0.1",
      kind: "Workflow",
      metadata: { name: "runtime-decision-default" },
      input: { schema: { type: "object" } },
      output: { schema: { type: "object" } },
      permissions: { tools: ["a", "b", "c"] },
      steps: [
        {
          id: "a",
          uses: "tool.call",
          with: { tool: "a" },
          output: { mode: "object", schema: { type: "object" } },
        },
        {
          id: "route",
          uses: "decision",
          needs: ["a"],
          with: {
            cases: [{ when: "{{ steps.a.output.ok }}", to: "b" }],
            default: "c",
          },
        },
        {
          id: "b",
          uses: "tool.call",
          needs: ["a"],
          with: { tool: "b" },
          output: { mode: "object", schema: { type: "object" } },
        },
        {
          id: "c",
          uses: "tool.call",
          needs: ["a"],
          with: { tool: "c" },
          output: { mode: "object", schema: { type: "object" } },
        },
      ],
    };
    const workflowVersion = lockedWorkflowVersion(
      "wfver_runtime_decision_default",
      lwir,
      { tools: registryFor({ a: () => ({ ok: false }), b: () => ({ result: "b" }), c: () => ({ result: "c" }) }) },
    );
    const result = await executeWorkflowVersion({
      world,
      workflowVersion,
      runId: "run_runtime_decision_default",
      input: {},
      tools: registryFor({ a: () => ({ ok: false }), b: () => ({ result: "b" }), c: () => ({ result: "c" }) }),
    });
    expect(result.status).toBe("completed");
    const events = await listEvents(world, "run_runtime_decision_default");
    const routeCompleted = events.find(
      (e) => e.type === "StepCompleted" && e.payload.stepId === "route",
    );
    expect(routeCompleted?.payload.output).toEqual({ chosen: "c" });
  });

  it("routes execution to the chosen target step (case match → b runs, c does not)", async () => {
    const world = await tempWorld();
    const bCalls: number[] = [];
    const cCalls: number[] = [];
    const lwir: LwirWorkflow = {
      apiVersion: "littleworkflow.dev/v0.1",
      kind: "Workflow",
      metadata: { name: "runtime-decision-routes" },
      input: { schema: { type: "object" } },
      output: { schema: { type: "object" } },
      permissions: { tools: ["a", "b", "c"] },
      steps: [
        {
          id: "a",
          uses: "tool.call",
          with: { tool: "a" },
          output: { mode: "object", schema: { type: "object" } },
        },
        {
          id: "route",
          uses: "decision",
          needs: ["a"],
          with: {
            cases: [{ when: "{{ steps.a.output.ok }}", to: "b" }],
            default: "c",
          },
        },
        {
          id: "b",
          uses: "tool.call",
          needs: ["a"],
          with: { tool: "b" },
          output: { mode: "object", schema: { type: "object" } },
        },
        {
          id: "c",
          uses: "tool.call",
          needs: ["a"],
          with: { tool: "c" },
          output: { mode: "object", schema: { type: "object" } },
        },
      ],
    };
    const bTool = vi.fn(() => { bCalls.push(1); return { result: "b" }; });
    const cTool = vi.fn(() => { cCalls.push(1); return { result: "c" }; });
    const workflowVersion = lockedWorkflowVersion(
      "wfver_runtime_decision_routes",
      lwir,
      { tools: registryFor({ a: () => ({ ok: true }), b: bTool, c: cTool }) },
    );
    const result = await executeWorkflowVersion({
      world,
      workflowVersion,
      runId: "run_runtime_decision_routes",
      input: {},
      tools: registryFor({ a: () => ({ ok: true }), b: bTool, c: cTool }),
    });
    expect(result.status).toBe("completed");
    expect(result.output).toEqual({ result: "b" });
    expect(bCalls).toHaveLength(1);
    expect(cCalls).toHaveLength(0);
  });

  it("terminates the workflow when decision routes to 'end' and uses the last non-decision step as output", async () => {
    const world = await tempWorld();
    const lwir: LwirWorkflow = {
      apiVersion: "littleworkflow.dev/v0.1",
      kind: "Workflow",
      metadata: { name: "runtime-decision-end" },
      input: { schema: { type: "object" } },
      output: { schema: { type: "object" } },
      permissions: { tools: ["a"] },
      steps: [
        {
          id: "a",
          uses: "tool.call",
          with: { tool: "a" },
          output: { mode: "object", schema: { type: "object" } },
        },
        {
          id: "route",
          uses: "decision",
          needs: ["a"],
          with: { cases: [], default: "end" },
        },
      ],
    };
    const workflowVersion = lockedWorkflowVersion(
      "wfver_runtime_decision_end",
      lwir,
      { tools: registryFor({ a: () => ({ result: "done" }) }) },
    );
    const result = await executeWorkflowVersion({
      world,
      workflowVersion,
      runId: "run_runtime_decision_end",
      input: {},
      tools: registryFor({ a: () => ({ result: "done" }) }),
    });
    expect(result.status).toBe("completed");
    expect(result.output).toEqual({ result: "done" });
    const events = await listEvents(world, "run_runtime_decision_end");
    expect(events.at(-1)?.type).toBe("RunCompleted");
    // Only a and route were executed (no further steps).
    const stepCompletedIds = events
      .filter((e) => e.type === "StepCompleted")
      .map((e) => e.payload.stepId);
    expect(stepCompletedIds).toEqual(["a", "route"]);
  });

  it("re-executes a back-edge target as a new visit in a loop until review passes", async () => {
    const world = await tempWorld();
    // Workflow: worker (maxVisits:5) → review (maxVisits:5) → route (maxVisits:5)
    // review returns { passed: false } for first 2 calls, then { passed: true }
    let reviewCallCount = 0;
    const reviewTool = vi.fn(() => {
      reviewCallCount += 1;
      return { passed: reviewCallCount >= 3 };
    });
    const workerTool = vi.fn(() => ({ work: "done" }));
    const lwir: LwirWorkflow = {
      apiVersion: "littleworkflow.dev/v0.1",
      kind: "Workflow",
      metadata: { name: "runtime-decision-loop" },
      input: { schema: { type: "object" } },
      output: { schema: { type: "object" } },
      permissions: { tools: ["worker", "review"] },
      steps: [
        {
          id: "worker",
          uses: "tool.call",
          with: { tool: "worker" },
          maxVisits: 5,
          output: { mode: "object", schema: { type: "object" } },
        },
        {
          id: "review",
          uses: "tool.call",
          needs: ["worker"],
          with: { tool: "review" },
          maxVisits: 5,
          output: { mode: "object", schema: { type: "object" } },
        },
        {
          id: "route",
          uses: "decision",
          needs: ["review"],
          maxVisits: 5,
          with: {
            cases: [{ when: "{{ steps.review.lastOutput.passed }}", to: "end" }],
            default: "worker",
          },
        },
      ],
    };
    const registry = registryFor({ worker: workerTool, review: reviewTool });
    const workflowVersion = lockedWorkflowVersion(
      "wfver_runtime_decision_loop",
      lwir,
      { tools: registry },
    );
    const result = await executeWorkflowVersion({
      world,
      workflowVersion,
      runId: "run_runtime_decision_loop",
      input: {},
      tools: registryFor({ worker: workerTool, review: reviewTool }),
    });
    expect(result.status).toBe("completed");
    // worker ran 3 times (visit[0], visit[1], visit[2])
    expect(workerTool).toHaveBeenCalledTimes(3);
    // review ran 3 times (visit[0], visit[1], visit[2])
    expect(reviewTool).toHaveBeenCalledTimes(3);
    // Final output is review's last output ({ passed: true })
    expect(result.output).toEqual({ passed: true });
    const events = await listEvents(world, "run_runtime_decision_loop");
    const workerCompleted = events.filter(
      (e) => e.type === "StepCompleted" && e.payload.stepId === "worker",
    );
    expect(workerCompleted).toHaveLength(3);
    const reviewCompleted = events.filter(
      (e) => e.type === "StepCompleted" && e.payload.stepId === "review",
    );
    expect(reviewCompleted).toHaveLength(3);
    // Last review visit output was { passed: true }
    expect(reviewCompleted.at(-1)?.payload.output).toEqual({ passed: true });
  });

  it("fails the run with max_visits_exceeded when back-edge re-execution would exceed cap", async () => {
    const world = await tempWorld();
    // review always returns { passed: false } so the loop keeps going until worker hits maxVisits.
    const workerTool = vi.fn(() => ({ work: "done" }));
    const reviewTool = vi.fn(() => ({ passed: false }));
    const lwir: LwirWorkflow = {
      apiVersion: "littleworkflow.dev/v0.1",
      kind: "Workflow",
      metadata: { name: "runtime-decision-loop-exceeded" },
      input: { schema: { type: "object" } },
      output: { schema: { type: "object" } },
      permissions: { tools: ["worker", "review"] },
      steps: [
        {
          id: "worker",
          uses: "tool.call",
          with: { tool: "worker" },
          maxVisits: 3,
          output: { mode: "object", schema: { type: "object" } },
        },
        {
          id: "review",
          uses: "tool.call",
          needs: ["worker"],
          with: { tool: "review" },
          maxVisits: 3,
          output: { mode: "object", schema: { type: "object" } },
        },
        {
          id: "route",
          uses: "decision",
          needs: ["review"],
          maxVisits: 4,
          with: {
            cases: [{ when: "{{ steps.review.lastOutput.passed }}", to: "end" }],
            default: "worker",
          },
        },
      ],
    };
    const registry = registryFor({ worker: workerTool, review: reviewTool });
    const workflowVersion = lockedWorkflowVersion(
      "wfver_runtime_decision_loop_exceeded",
      lwir,
      { tools: registry },
    );
    const result = await executeWorkflowVersion({
      world,
      workflowVersion,
      runId: "run_runtime_decision_loop_exceeded",
      input: {},
      tools: registryFor({ worker: workerTool, review: reviewTool }),
    });
    expect(result.status).toBe("failed");
    const failedResult = result as import("./runtime.js").RuntimeFailedRunResult;
    expect(failedResult.error).toMatchObject({ causeCode: "max_visits_exceeded" });
    // worker ran 3 times (visit[0], [1], [2]), then route tried to go back again → exceeded
    expect(workerTool).toHaveBeenCalledTimes(3);
    const events = await listEvents(world, "run_runtime_decision_loop_exceeded");
    const runFailed = events.find((e) => e.type === "RunFailed");
    expect(runFailed).toBeDefined();
    expect(runFailed?.payload.error).toMatchObject({
      causeCode: "max_visits_exceeded",
      failedStepPath: "worker.visit[3]",
    });
  });

  it("resumes a decision loop from a true mid-loop crash point (route.visit[0] committed, worker.visit[1] not yet started)", async () => {
    // This test exercises the actual mid-loop resume path that the "crash-and-resume" test
    // above does NOT cover.  It pre-injects events that represent:
    //   worker.visit[0] completed → review.visit[0] completed (passed:false) → route.visit[0]
    //   completed (chosen:"worker")
    // …stopping before worker.visit[1]'s StepAttemptStarted is recorded.
    // On resume, the runtime must:
    //   - NOT re-call worker or review for visit[0] (they are memoized)
    //   - Detect the pending routing from the committed route.visit[0] and start at worker.visit[1]
    //   - Complete the loop normally (review.visit[1] returns passed:true → route.visit[1]→end)
    const world = await tempWorld();
    const workerOutput = { work: "done" };
    const reviewOutputFailed = { passed: false };
    const reviewOutputPassed = { passed: true };

    const lwir: LwirWorkflow = {
      apiVersion: "littleworkflow.dev/v0.1",
      kind: "Workflow",
      metadata: { name: "runtime-decision-mid-loop-resume" },
      input: { schema: { type: "object" } },
      output: { schema: { type: "object" } },
      permissions: { tools: ["worker", "review"] },
      steps: [
        {
          id: "worker",
          uses: "tool.call",
          with: { tool: "worker" },
          maxVisits: 5,
          output: { mode: "object", schema: { type: "object" } },
        },
        {
          id: "review",
          uses: "tool.call",
          needs: ["worker"],
          with: { tool: "review" },
          maxVisits: 5,
          output: { mode: "object", schema: { type: "object" } },
        },
        {
          id: "route",
          uses: "decision",
          needs: ["review"],
          maxVisits: 5,
          with: {
            cases: [{ when: "{{ steps.review.lastOutput.passed }}", to: "end" }],
            default: "worker",
          },
        },
      ],
    };
    const runId = "run_runtime_decision_mid_loop_resume";
    // workerTool and reviewTool track calls made in *this* session only.
    let workerCallCount = 0;
    let reviewCallCount = 0;
    const workerTool = vi.fn(() => { workerCallCount += 1; return workerOutput; });
    const reviewTool = vi.fn(() => {
      reviewCallCount += 1;
      // First in-session call (visit[1]) returns passed:true so the loop ends after one more cycle.
      return reviewOutputPassed;
    });
    const workflowVersion = lockedWorkflowVersion(
      `wfver_${runId}`,
      lwir,
      { tools: registryFor({ worker: workerTool, review: reviewTool }) },
    );
    const schemaHash = sha256Digest({ type: "object" });

    // --- Pre-inject events up to and including route.visit[0] StepCompleted ---

    // Write output artifacts for each pre-committed step visit.
    const workerV0Artifact = await writeArtifact(world, {
      runId,
      stepPath: "worker.visit[0]",
      name: "output",
      payload: workerOutput,
      contentType: "application/json",
    });
    const reviewV0Artifact = await writeArtifact(world, {
      runId,
      stepPath: "review.visit[0]",
      name: "output",
      payload: reviewOutputFailed,
      contentType: "application/json",
    });
    const routeV0Artifact = await writeArtifact(world, {
      runId,
      stepPath: "route.visit[0]",
      name: "output",
      payload: { chosen: "worker" },
      contentType: "application/json",
    });

    await appendEvent(world, runId, {
      type: "WorkflowVersionRegistered",
      payload: { workflowVersionId: workflowVersion.id, workflowVersionHash: workflowVersion.hash },
    });
    await appendEvent(world, runId, {
      type: "RunStarted",
      payload: { workflowVersionId: workflowVersion.id, input: {} },
    });
    // worker.visit[0]
    await appendEvent(world, runId, {
      type: "StepScheduled",
      payload: { stepPath: "worker.visit[0]", stepId: "worker", uses: "tool.call" },
    });
    await appendEvent(world, runId, {
      type: "StepAttemptStarted",
      payload: { stepPath: "worker.visit[0]", stepId: "worker", attempt: 1, attemptId: "attempt_1" },
    });
    await appendEvent(world, runId, {
      type: "ArtifactCreated",
      payload: {
        stepPath: "worker.visit[0]",
        artifactRef: workerV0Artifact.artifactRef,
        name: "output",
        contentType: "application/json",
      },
    });
    await appendEvent(world, runId, {
      type: "StepOutputValidated",
      payload: {
        stepPath: "worker.visit[0]",
        outputRef: workerV0Artifact.artifactRef,
        outputMode: "object",
        schemaHash,
      },
    });
    await appendEvent(world, runId, {
      type: "StepCompleted",
      payload: {
        stepPath: "worker.visit[0]",
        stepId: "worker",
        attempt: 1,
        output: workerOutput,
        outputRef: workerV0Artifact.artifactRef,
        artifactRefs: [workerV0Artifact.artifactRef],
        metadata: { uses: "tool.call", outputMode: "object", schemaHash },
      },
    });
    // review.visit[0]
    await appendEvent(world, runId, {
      type: "StepScheduled",
      payload: { stepPath: "review.visit[0]", stepId: "review", uses: "tool.call" },
    });
    await appendEvent(world, runId, {
      type: "StepAttemptStarted",
      payload: { stepPath: "review.visit[0]", stepId: "review", attempt: 1, attemptId: "attempt_1" },
    });
    await appendEvent(world, runId, {
      type: "ArtifactCreated",
      payload: {
        stepPath: "review.visit[0]",
        artifactRef: reviewV0Artifact.artifactRef,
        name: "output",
        contentType: "application/json",
      },
    });
    await appendEvent(world, runId, {
      type: "StepOutputValidated",
      payload: {
        stepPath: "review.visit[0]",
        outputRef: reviewV0Artifact.artifactRef,
        outputMode: "object",
        schemaHash,
      },
    });
    await appendEvent(world, runId, {
      type: "StepCompleted",
      payload: {
        stepPath: "review.visit[0]",
        stepId: "review",
        attempt: 1,
        output: reviewOutputFailed,
        outputRef: reviewV0Artifact.artifactRef,
        artifactRefs: [reviewV0Artifact.artifactRef],
        metadata: { uses: "tool.call", outputMode: "object", schemaHash },
      },
    });
    // route.visit[0] — decision step; no output contract, so no schemaHash/outputMode in metadata
    await appendEvent(world, runId, {
      type: "StepScheduled",
      payload: { stepPath: "route.visit[0]", stepId: "route", uses: "decision" },
    });
    await appendEvent(world, runId, {
      type: "StepAttemptStarted",
      payload: { stepPath: "route.visit[0]", stepId: "route", attempt: 1, attemptId: "attempt_1" },
    });
    await appendEvent(world, runId, {
      type: "ArtifactCreated",
      payload: {
        stepPath: "route.visit[0]",
        artifactRef: routeV0Artifact.artifactRef,
        name: "output",
        contentType: "application/json",
      },
    });
    await appendEvent(world, runId, {
      type: "StepOutputValidated",
      payload: {
        stepPath: "route.visit[0]",
        outputRef: routeV0Artifact.artifactRef,
      },
    });
    await appendEvent(world, runId, {
      type: "StepCompleted",
      payload: {
        stepPath: "route.visit[0]",
        stepId: "route",
        attempt: 1,
        output: { chosen: "worker" },
        outputRef: routeV0Artifact.artifactRef,
        artifactRefs: [routeV0Artifact.artifactRef],
        metadata: { uses: "decision" },
      },
    });
    // NOTE: worker.visit[1]'s StepAttemptStarted is intentionally NOT injected.
    // This is the crash point — the run resumes from here.

    // --- Execute and verify ---
    const result = await executeWorkflowVersion({
      world,
      workflowVersion,
      runId,
      input: {},
      tools: registryFor({ worker: workerTool, review: reviewTool }),
    });

    expect(result.status).toBe("completed");
    expect(result.output).toEqual(reviewOutputPassed);

    // visit[0] tools were NOT re-called — only visit[1] executed in this session.
    expect(workerCallCount).toBe(1);  // worker.visit[1] only
    expect(reviewCallCount).toBe(1);  // review.visit[1] only

    const events = await listEvents(world, runId);
    const workerCompleted = events.filter(
      (e) => e.type === "StepCompleted" && e.payload.stepId === "worker",
    );
    // Exactly two worker completions: visit[0] (injected) + visit[1] (just executed)
    expect(workerCompleted).toHaveLength(2);
    expect(workerCompleted[0]?.payload.stepPath).toBe("worker.visit[0]");
    expect(workerCompleted[1]?.payload.stepPath).toBe("worker.visit[1]");
  });

  it("resumes a decision loop correctly from pre-committed events (crash-and-resume of back-edge)", async () => {
    // This test verifies that pendingDecisionTarget correctly detects a pending routing
    // from committed events and that the scheduler resumes at the right visit.
    //
    // Strategy: run the loop workflow to completion with a call-count spy, then re-run it
    // from the same world+runId and verify no additional tool calls happen (idempotent replay).
    const world = await tempWorld();
    let workerCallCount = 0;
    let reviewCallCount = 0;
    const workerTool = vi.fn(() => { workerCallCount += 1; return { work: "done" }; });
    const reviewTool = vi.fn(() => {
      reviewCallCount += 1;
      return { passed: reviewCallCount >= 3 };
    });
    const lwir: LwirWorkflow = {
      apiVersion: "littleworkflow.dev/v0.1",
      kind: "Workflow",
      metadata: { name: "runtime-decision-loop-replay" },
      input: { schema: { type: "object" } },
      output: { schema: { type: "object" } },
      permissions: { tools: ["worker", "review"] },
      steps: [
        {
          id: "worker",
          uses: "tool.call",
          with: { tool: "worker" },
          maxVisits: 5,
          output: { mode: "object", schema: { type: "object" } },
        },
        {
          id: "review",
          uses: "tool.call",
          needs: ["worker"],
          with: { tool: "review" },
          maxVisits: 5,
          output: { mode: "object", schema: { type: "object" } },
        },
        {
          id: "route",
          uses: "decision",
          needs: ["review"],
          maxVisits: 5,
          with: {
            cases: [{ when: "{{ steps.review.lastOutput.passed }}", to: "end" }],
            default: "worker",
          },
        },
      ],
    };
    const workflowVersion = lockedWorkflowVersion(
      "wfver_runtime_decision_loop_replay",
      lwir,
      { tools: registryFor({ worker: workerTool, review: reviewTool }) },
    );
    const runId = "run_runtime_decision_loop_replay";

    // First run: completes 3 iterations (worker+review+route x3, last route→end).
    const firstResult = await executeWorkflowVersion({
      world,
      workflowVersion,
      runId,
      input: {},
      tools: registryFor({ worker: workerTool, review: reviewTool }),
    });
    expect(firstResult.status).toBe("completed");
    expect(workerCallCount).toBe(3);
    expect(reviewCallCount).toBe(3);

    // Reset spy counters.
    workerCallCount = 0;
    reviewCallCount = 0;

    // Re-run from same world+runId: should be a no-op replay (no tool calls).
    const replayResult = await executeWorkflowVersion({
      world,
      workflowVersion,
      runId,
      input: {},
      tools: registryFor({ worker: workerTool, review: reviewTool }),
    });
    expect(replayResult.status).toBe("completed");
    expect(replayResult.output).toEqual({ passed: true });
    // No additional tool calls — all steps were memoized.
    expect(workerCallCount).toBe(0);
    expect(reviewCallCount).toBe(0);
  });
});

describe("pendingDecisionTarget cross-scope contamination (Issue 2)", () => {
  // Verifies that a decision StepCompleted from inside a parallel branch does NOT
  // contaminate the top-level scheduler's pendingDecisionTarget logic.
  //
  // The actual contamination manifests when:
  //  1. A branch-scoped decision StepCompleted has chosen:"worker"
  //  2. The top-level step "worker" has maxVisits > 1 and visit[0] is already committed
  //  3. pendingDecisionTarget (without the fix) finds the branch decision, checks
  //     visitIndexFor("worker") = 1, and sees that "worker.visit[1]" is not in state
  //     → returns "worker" as the pending forced target
  //  4. The scheduler then runs worker.visit[1] unnecessarily
  //
  // With the fix (filtering branch paths that contain "[" before ".visit["), the branch
  // decision event is skipped and pendingDecisionTarget correctly returns null.
  // The scheduler then sees remaining={} and completes the run using the already-
  // committed worker.visit[0] output.
  it("branch-scoped decision event does not spuriously force a new visit of a multi-visit top-level step", async () => {
    const world = await tempWorld();
    const workerOutputV0 = { iteration: 0, done: true };
    const workerOutputV1 = { iteration: 1, done: true };
    const schemaHash = sha256Digest({ type: "object" });

    // Workflow: single multi-visit worker step (maxVisits:2).
    // In a normal (non-crash) run, worker.visit[0] would complete and the run would end —
    // no decision step routes back to worker at the top level.
    const lwir: LwirWorkflow = {
      apiVersion: "littleworkflow.dev/v0.1",
      kind: "Workflow",
      metadata: { name: "runtime-decision-cross-scope" },
      input: { schema: { type: "object" } },
      output: { schema: { type: "object" } },
      permissions: { tools: ["worker"] },
      steps: [
        {
          id: "worker",
          uses: "tool.call",
          with: { tool: "worker" },
          maxVisits: 2,
          output: { mode: "object", schema: { type: "object" } },
        },
      ],
    };

    const runId = "run_runtime_decision_cross_scope";
    let workerCallCount = 0;
    const workerTool = vi.fn(() => {
      workerCallCount += 1;
      return workerCallCount === 1 ? workerOutputV0 : workerOutputV1;
    });
    const workflowVersion = lockedWorkflowVersion(
      `wfver_${runId}`,
      lwir,
      { tools: registryFor({ worker: workerTool }) },
    );

    // Pre-inject: worker.visit[0] is committed, but RunCompleted was not written (crash).
    // Also inject a branch-scoped decision event with chosen:"worker" — this simulates
    // a crashed parallel run that committed a branch decision routing back to the
    // top-level step name "worker".
    //
    // Without the fix: pendingDecisionTarget scans events, finds the branch decision
    // (the most recent decision StepCompleted), computes visitIndexFor("worker")=1,
    // sees that "worker.visit[1]" is absent from state → returns "worker" → forces
    // visit[1] to run → workerTool is called a second time (wrong).
    //
    // With the fix: the branch event is skipped, pendingDecisionTarget returns null,
    // remaining={} (worker is in completedForNeeds from visit[0]), the loop breaks,
    // and RunCompleted is written using visit[0]'s output → workerTool NOT called.

    const workerV0Artifact = await writeArtifact(world, {
      runId,
      stepPath: "worker.visit[0]",
      name: "output",
      payload: workerOutputV0,
      contentType: "application/json",
    });
    // The branch-scoped decision artifact (simulates crashed parallel branch)
    const branchRouteArtifact = await writeArtifact(world, {
      runId,
      // stepPath contains "[" (branch separator) before ".visit[" → identified as branch-scoped
      stepPath: "scan[k_item1].route",
      name: "output",
      payload: { chosen: "worker" },
      contentType: "application/json",
    });

    await appendEvent(world, runId, {
      type: "WorkflowVersionRegistered",
      payload: { workflowVersionId: workflowVersion.id, workflowVersionHash: workflowVersion.hash },
    });
    await appendEvent(world, runId, {
      type: "RunStarted",
      payload: { workflowVersionId: workflowVersion.id, input: {} },
    });

    // worker.visit[0] — fully committed
    await appendEvent(world, runId, {
      type: "StepScheduled",
      payload: { stepPath: "worker.visit[0]", stepId: "worker", uses: "tool.call" },
    });
    await appendEvent(world, runId, {
      type: "StepAttemptStarted",
      payload: { stepPath: "worker.visit[0]", stepId: "worker", attempt: 1, attemptId: "attempt_1" },
    });
    await appendEvent(world, runId, {
      type: "ArtifactCreated",
      payload: { stepPath: "worker.visit[0]", artifactRef: workerV0Artifact.artifactRef, name: "output", contentType: "application/json" },
    });
    await appendEvent(world, runId, {
      type: "StepOutputValidated",
      payload: { stepPath: "worker.visit[0]", outputRef: workerV0Artifact.artifactRef, outputMode: "object", schemaHash },
    });
    await appendEvent(world, runId, {
      type: "StepCompleted",
      payload: {
        stepPath: "worker.visit[0]",
        stepId: "worker",
        attempt: 1,
        output: workerOutputV0,
        outputRef: workerV0Artifact.artifactRef,
        artifactRefs: [workerV0Artifact.artifactRef],
        metadata: { uses: "tool.call", outputMode: "object", schemaHash },
      },
    });
    // RunCompleted was NOT recorded (crash point).

    // Branch-scoped decision StepCompleted — the contaminating event (appended AFTER worker.visit[0]).
    // This is the most recent decision event in the log, and without the fix,
    // pendingDecisionTarget would pick it up.
    await appendEvent(world, runId, {
      type: "StepScheduled",
      payload: { stepPath: "scan[k_item1].route", stepId: "route", uses: "decision" },
    });
    await appendEvent(world, runId, {
      type: "StepAttemptStarted",
      payload: { stepPath: "scan[k_item1].route", stepId: "route", attempt: 1, attemptId: "attempt_1" },
    });
    await appendEvent(world, runId, {
      type: "ArtifactCreated",
      payload: { stepPath: "scan[k_item1].route", artifactRef: branchRouteArtifact.artifactRef, name: "output", contentType: "application/json" },
    });
    await appendEvent(world, runId, {
      type: "StepOutputValidated",
      payload: { stepPath: "scan[k_item1].route", outputRef: branchRouteArtifact.artifactRef },
    });
    await appendEvent(world, runId, {
      type: "StepCompleted",
      payload: {
        stepPath: "scan[k_item1].route",
        stepId: "route",
        attempt: 1,
        output: { chosen: "worker" },
        outputRef: branchRouteArtifact.artifactRef,
        artifactRefs: [branchRouteArtifact.artifactRef],
        metadata: { uses: "decision" },
      },
    });

    // Resume the run.
    const result = await executeWorkflowVersion({
      world,
      workflowVersion,
      runId,
      input: {},
      tools: registryFor({ worker: workerTool }),
    });

    expect(result.status).toBe("completed");
    // Output must come from worker.visit[0] (not a spurious visit[1]).
    expect(result.output).toEqual(workerOutputV0);
    // The worker must NOT have been called in this session — visit[0] was already committed.
    expect(workerCallCount).toBe(0);
  });
});

describe("P1.2 — decision target scheduling exclusion", () => {
  // Scenario: [worker, review, route] where review is listed BEFORE route in the array.
  // Without the fix, needs-based scheduling would pick up review (needs: [worker]) right
  // after worker completes — before route (the decision) has had a chance to run.
  // With the fix, review is excluded from normal scheduling because route (whose needs
  // are all satisfied after worker runs) targets it via cases[].to.

  it("routes worker → route → review when review is a decision target (route.cases[].to)", async () => {
    const world = await tempWorld();
    const eventLog: Array<{ type: string; stepId?: string }> = [];

    const workerTool = vi.fn(() => ({ ok: true }));
    const reviewTool = vi.fn(() => ({ reviewed: true }));

    const lwir: LwirWorkflow = {
      apiVersion: "littleworkflow.dev/v0.1",
      kind: "Workflow",
      metadata: { name: "p1-2-scheduler-exclusion" },
      input: { schema: { type: "object" } },
      output: { schema: { type: "object" } },
      permissions: { tools: ["worker", "review"] },
      steps: [
        {
          id: "worker",
          uses: "tool.call",
          with: { tool: "worker" },
          output: { mode: "object", schema: { type: "object" } },
        },
        // review is listed BEFORE route in the array — this is the critical ordering.
        // Without the fix, the needs-based scheduler picks review immediately after worker.
        {
          id: "review",
          uses: "tool.call",
          needs: ["worker"],
          with: { tool: "review" },
          output: { mode: "object", schema: { type: "object" } },
        },
        {
          id: "route",
          uses: "decision",
          needs: ["worker"],
          with: {
            cases: [{ when: "{{ steps.worker.output.ok }}", to: "review" }],
            default: "end",
          },
        },
      ],
    };

    const workflowVersion = lockedWorkflowVersion(
      "wfver_p1_2_scheduler_exclusion",
      lwir,
      { tools: registryFor({ worker: workerTool, review: reviewTool }) },
    );

    const result = await executeWorkflowVersion({
      world,
      workflowVersion,
      runId: "run_p1_2_scheduler_exclusion",
      input: {},
      tools: registryFor({ worker: workerTool, review: reviewTool }),
    });

    expect(result.status).toBe("completed");

    const events = await listEvents(world, "run_p1_2_scheduler_exclusion");

    // Extract step-completion events in order.
    const stepCompletedIds = events
      .filter((e) => e.type === "StepCompleted")
      .map((e) => e.payload.stepId as string);

    // The sequence must be: worker → route → review
    // (NOT worker → review → route)
    expect(stepCompletedIds).toEqual(["worker", "route", "review"]);

    // route must complete before review is even scheduled.
    const routeCompletedIndex = events.findIndex(
      (e) => e.type === "StepCompleted" && e.payload.stepId === "route",
    );
    const reviewScheduledIndex = events.findIndex(
      (e) => e.type === "StepScheduled" && e.payload.stepId === "review",
    );
    expect(routeCompletedIndex).toBeGreaterThan(-1);
    expect(reviewScheduledIndex).toBeGreaterThan(-1);
    expect(routeCompletedIndex).toBeLessThan(reviewScheduledIndex);
  });

  it("does not schedule review when decision routes to 'end' (review is a decision target)", async () => {
    const world = await tempWorld();
    const workerTool = vi.fn(() => ({ ok: false }));
    const reviewTool = vi.fn(() => ({ reviewed: true }));

    const lwir: LwirWorkflow = {
      apiVersion: "littleworkflow.dev/v0.1",
      kind: "Workflow",
      metadata: { name: "p1-2-scheduler-exclusion-end" },
      input: { schema: { type: "object" } },
      output: { schema: { type: "object" } },
      permissions: { tools: ["worker", "review"] },
      steps: [
        {
          id: "worker",
          uses: "tool.call",
          with: { tool: "worker" },
          output: { mode: "object", schema: { type: "object" } },
        },
        // review listed before route — without fix it would run even when routed to end.
        {
          id: "review",
          uses: "tool.call",
          needs: ["worker"],
          with: { tool: "review" },
          output: { mode: "object", schema: { type: "object" } },
        },
        {
          id: "route",
          uses: "decision",
          needs: ["worker"],
          with: {
            // worker.ok is false → no case matches → default: end
            cases: [{ when: "{{ steps.worker.output.ok }}", to: "review" }],
            default: "end",
          },
        },
      ],
    };

    const workflowVersion = lockedWorkflowVersion(
      "wfver_p1_2_scheduler_exclusion_end",
      lwir,
      { tools: registryFor({ worker: workerTool, review: reviewTool }) },
    );

    const result = await executeWorkflowVersion({
      world,
      workflowVersion,
      runId: "run_p1_2_scheduler_exclusion_end",
      input: {},
      tools: registryFor({ worker: workerTool, review: reviewTool }),
    });

    expect(result.status).toBe("completed");
    // Since worker.ok is false, route → end. review must NOT have run.
    expect(reviewTool).not.toHaveBeenCalled();

    const events = await listEvents(world, "run_p1_2_scheduler_exclusion_end");
    const reviewScheduled = events.find(
      (e) => e.type === "StepScheduled" && e.payload.stepId === "review",
    );
    expect(reviewScheduled).toBeUndefined();
  });
});

describe("P1.4 — allow resume of top-level in-flight visit", () => {
  it("resumes a top-level ai.generate step that was killed mid-attempt", async () => {
    const world = await tempWorld();
    const aiLoop = {
      generate: vi.fn(async () => ({
        output: "hello from resumed ai",
        usage: { inputTokens: 5, outputTokens: 5 },
      })),
    };
    const workerHarness = createWorkflowHarness({ aiLoop });

    const lwir: LwirWorkflow = {
      apiVersion: "littleworkflow.dev/v0.1",
      kind: "Workflow",
      metadata: { name: "p1-4-ai-generate-resume" },
      input: { schema: { type: "object" } },
      output: { schema: { type: "string" } },
      permissions: { models: ["writer"] },
      steps: [
        {
          id: "generate",
          uses: "ai.generate",
          with: { model: "writer", prompt: "Say hello." },
          output: { mode: "text" },
        },
      ],
    };

    const workflowVersion = lockedWorkflowVersion("wfver_p1_4_ai_generate_resume", lwir, {
      models: { writer: { provider: "mock", id: "writer" } },
    });

    // Pre-inject: WorkflowVersionRegistered + RunStarted + StepScheduled + StepAttemptStarted
    // No terminal event — simulates a kill mid-attempt.
    await appendEvent(world, "run_p1_4_ai_generate_resume", {
      type: "WorkflowVersionRegistered",
      payload: {
        workflowVersionId: workflowVersion.id,
        workflowVersionHash: workflowVersion.hash,
      },
    });
    await appendEvent(world, "run_p1_4_ai_generate_resume", {
      type: "RunStarted",
      payload: { workflowVersionId: workflowVersion.id },
    });
    await appendEvent(world, "run_p1_4_ai_generate_resume", {
      type: "StepScheduled",
      payload: { stepPath: "generate", stepId: "generate", uses: "ai.generate" },
    });
    await appendEvent(world, "run_p1_4_ai_generate_resume", {
      type: "StepAttemptStarted",
      payload: {
        stepPath: "generate",
        stepId: "generate",
        attempt: 1,
        attemptId: "attempt_1",
      },
    });

    const result = await executeWorkflowVersion({
      world,
      workflowVersion,
      runId: "run_p1_4_ai_generate_resume",
      input: {},
      models: { writer: { provider: "mock", id: "writer" } },
      workerHarness,
    });

    expect(result.status).toBe("completed");

    const events = await listEvents(world, "run_p1_4_ai_generate_resume");

    // Only ONE StepAttemptStarted — no duplicate emitted on resume.
    const attemptStartedEvents = events.filter((e) => e.type === "StepAttemptStarted");
    expect(attemptStartedEvents).toHaveLength(1);
    expect(attemptStartedEvents[0]!.payload.attemptId).toBe("attempt_1");

    // Step completed successfully.
    const stepCompleted = events.find((e) => e.type === "StepCompleted");
    expect(stepCompleted).toBeDefined();

    // Worker harness AI loop called exactly once (on resume).
    expect(aiLoop.generate).toHaveBeenCalledTimes(1);
  });

  it("resumes a top-level code.run step that was killed mid-attempt", async () => {
    const world = await tempWorld();
    const executeStepCalls = vi.fn(() => ({ result: "done" }));
    const workerHarness = {
      harnessId: "codeRunResumeHarness@1.0.0",
      async run(task) {
        if (task.kind === "execute_step" && task.step.uses === "code.run") {
          return {
            kind: "execute_step",
            output: executeStepCalls(),
            artifactRefs: [],
          };
        }
        return { kind: "delegate_to_default" };
      },
    } satisfies Harness & { readonly harnessId: string };

    const lwir: LwirWorkflow = {
      apiVersion: "littleworkflow.dev/v0.1",
      kind: "Workflow",
      metadata: { name: "p1-4-code-ts-resume" },
      input: { schema: { type: "object" } },
      output: { schema: { type: "object" } },
      permissions: {},
      steps: [
        {
          id: "compute",
          uses: "code.run",
          with: {
            source: "async () => ({ result: 'done' })",
          },
          output: { mode: "object", schema: { type: "object" } },
        },
      ],
    };

    const workflowVersion = lockedWorkflowVersion("wfver_p1_4_code_ts_resume", lwir);

    // Pre-inject: WorkflowVersionRegistered + RunStarted + StepScheduled + StepAttemptStarted
    // No terminal event — simulates a kill mid-attempt.
    await appendEvent(world, "run_p1_4_code_ts_resume", {
      type: "WorkflowVersionRegistered",
      payload: {
        workflowVersionId: workflowVersion.id,
        workflowVersionHash: workflowVersion.hash,
      },
    });
    await appendEvent(world, "run_p1_4_code_ts_resume", {
      type: "RunStarted",
      payload: { workflowVersionId: workflowVersion.id },
    });
    await appendEvent(world, "run_p1_4_code_ts_resume", {
      type: "StepScheduled",
      payload: { stepPath: "compute", stepId: "compute", uses: "code.run" },
    });
    await appendEvent(world, "run_p1_4_code_ts_resume", {
      type: "StepAttemptStarted",
      payload: {
        stepPath: "compute",
        stepId: "compute",
        attempt: 1,
        attemptId: "attempt_1",
      },
    });

    const result = await executeWorkflowVersion({
      world,
      workflowVersion,
      runId: "run_p1_4_code_ts_resume",
      input: {},
      workerHarness,
    });

    expect(result.status).toBe("completed");

    const events = await listEvents(world, "run_p1_4_code_ts_resume");

    // Only ONE StepAttemptStarted — no duplicate emitted on resume.
    const attemptStartedEvents = events.filter((e) => e.type === "StepAttemptStarted");
    expect(attemptStartedEvents).toHaveLength(1);
    expect(attemptStartedEvents[0]!.payload.attemptId).toBe("attempt_1");

    // Step completed successfully.
    const stepCompleted = events.find((e) => e.type === "StepCompleted");
    expect(stepCompleted).toBeDefined();

    // Worker harness execute_step called exactly once (on resume).
    expect(executeStepCalls).toHaveBeenCalledTimes(1);
  });
});
