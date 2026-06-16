import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createWorkflowHarness,
  createLittleWorkflow,
  createToolRegistry,
  getWorkflowDefinitionHash,
  listEvents,
  localWorld,
  model,
  output,
  runWorkflow,
  sha256Digest,
  skill,
  type ExecuteStepTask,
  type Harness,
  type HarnessContext,
  type LwirWorkflow,
} from "./index.js";
import { cleanupTempDirs, workerScopedTempPrefix } from "./test-temp.js";

const tempDirs: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(
    join(tmpdir(), workerScopedTempPrefix(prefix, process.env.VITEST_POOL_ID)),
  );
  tempDirs.push(dir);
  return dir;
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

async function appendCodeToolCallEvent(
  ctx: HarnessContext,
  type: "harness.tool_call.started" | "harness.tool_call.succeeded",
  payload: Record<string, unknown>,
): Promise<void> {
  await ctx.durability.append({
    type,
    runId: ctx.session.runId,
    payload: {
      caller: "code",
      callIndex: 1,
      ...payload,
    } as never,
  });
}

afterEach(async () => {
  await cleanupTempDirs(tempDirs);
});

const itemInputSchema = {
  type: "object",
  required: ["item"],
  additionalProperties: false,
  properties: {
    item: { type: "string" },
  },
};

const itemOutputSchema = {
  type: "object",
  required: ["item", "label", "repaired"],
  additionalProperties: false,
  properties: {
    item: { type: "string" },
    label: { type: "string" },
    repaired: { type: "boolean" },
  },
};

const noopInputSchema = { type: "object" };
const noopOutputSchema = { type: "object" };

describe("harness + orchestrator + memory acceptance", () => {
  it("mounts memory and scratch across orchestrator, planner, worker, and fixer sessions", async () => {
    const dataDir = await tempDir("lwf-harness-memory-");
    const world = localWorld({ dataDir });
    await writeFileAt(join(dataDir, "memory", "org", "policy.md"), "Policy: deterministic fake harnesses only.\n");
    await writeFileAt(
      join(dataDir, "memory", "workflows", "alpha-process", "available.md"),
      "available workflow memory: alpha-process\n",
    );
    await writeFileAt(
      join(dataDir, "memory", "workflows", "beta-unused", "available.md"),
      "available workflow memory: beta-unused\n",
    );
    const orgSkillDir = join(dataDir, "memory", "org", "skills", "acceptance-org");
    await writeFileAt(
      join(orgSkillDir, "SKILL.md"),
      [
        "---",
        "name: acceptance-org",
        "description: Org-level acceptance skill.",
        "---",
        "",
        "Use org-level constraints.",
      ].join("\n"),
    );

    const skillDir = await tempDir("lwf-planner-skill-");
    await writeFileAt(
      join(skillDir, "SKILL.md"),
      [
        "---",
        "name: acceptance-planner",
        "description: Plan deterministic code workflow.",
        "---",
        "",
        "Return the fixture LWIR.",
      ].join("\n"),
    );
    const workerSkillDir = await tempDir("lwf-worker-skill-");
    await writeFileAt(
      join(workerSkillDir, "SKILL.md"),
      [
        "---",
        "name: acceptance-worker",
        "description: Worker runtime acceptance skill.",
        "---",
        "",
        "Use deterministic tool-calling behavior.",
      ].join("\n"),
    );

    const observed: {
      readonly contexts: Array<{ readonly role: string; readonly ctx: HarnessContext }>;
      orchestratorAvailableMemory?: string;
      orchestratorScratchFile?: string;
      plannerWorkflowMemory?: boolean;
      plannerAlphaOrgMemoryAbsent?: boolean;
      plannerOrgSkillPresent?: boolean;
      workerWorkflowMemory?: boolean;
      workerPipelineMemory?: boolean;
      workerScratch?: boolean;
      workerFromOrchestratorScratch?: boolean;
      workerPeerScratchReadable?: boolean;
      workerSkillPresent?: boolean;
      workerOrgSkillPresent?: boolean;
      fixerWorkflowMemory?: boolean;
      fixerPipelineMemory?: boolean;
      fixerScratch?: boolean;
      fixerFromOrchestratorScratch?: boolean;
      fixerSkillPresent?: boolean;
      fixerOrgSkillPresent?: boolean;
    } = { contexts: [] };

    const plannerHarness = {
      harnessId: "acceptancePlannerHarness@1.0.0",
      run: vi.fn<Harness["run"]>(async (task, ctx) => {
        observed.contexts.push({ role: ctx.scope.role, ctx });
        if (task.kind !== "plan") {
          return { kind: "delegate_to_default" };
        }
        if (task.workflowSnapshot.id === "alpha.process") {
          expect(ctx.skills.map((entry) => entry.name)).toContain("acceptance-planner");
          observed.plannerWorkflowMemory = ctx.memoryMounts.some((mount) =>
            mount.storeId === "workflow:alpha-process" &&
            mount.mountPath === "/mnt/memory/workflow/" &&
            mount.mode === "rw"
          );
          observed.plannerAlphaOrgMemoryAbsent = ctx.memoryMounts.every((mount) => mount.storeId !== "org");
        }
        if (task.workflowSnapshot.id === "beta.unused") {
          observed.plannerOrgSkillPresent = ctx.skills.some((entry) => entry.name === "acceptance-org");
          expect(ctx.memoryMounts).toEqual(expect.arrayContaining([
            expect.objectContaining({ storeId: "org", mountPath: "/mnt/memory/org/", mode: "ro" }),
          ]));
        }
        expect(ctx.scratchMounts).toEqual(expect.arrayContaining([
          expect.objectContaining({ mountPath: "/mnt/scratch/own/", mode: "rw" }),
        ]));
        if (task.workflowSnapshot.id === "alpha.process") {
          return { kind: "plan", lwir: alphaProcessLwir() };
        }
        if (task.workflowSnapshot.id === "beta.unused") {
          return { kind: "plan", lwir: betaNoopLwir() };
        }
        throw new Error(`Unexpected workflow id for planner harness: ${task.workflowSnapshot.id}`);
      }),
    } satisfies Harness & { readonly harnessId: string };

    const fixerLoop = vi.fn(async () => ({
      output: {
        output: { item: "broken", label: "lookup:broken", repaired: true },
        fixedSource: "async ({ input }) => ({ item: input.item, label: input.label, repaired: true })",
        attempts: 1,
      },
    }));
    const workerHarnessRuntime = createWorkflowHarness({ aiLoop: { generate: fixerLoop } });
    const workerHarness = {
      harnessId: "acceptanceWorkerHarness@1.0.0",
      run: vi.fn<Harness["run"]>(async (task, ctx) => {
        observed.contexts.push({ role: ctx.scope.role, ctx });
        if (ctx.scope.role === "worker.code-run") {
          const bash = ctx.bash;
          if (bash === undefined) {
            throw new Error("Expected worker code-run context to include bash.");
          }
          const workflowMemory = await bash.execute({ cmd: "cat /mnt/memory/workflow/available.md" });
          expect(workflowMemory).toMatchObject({ exitCode: 0 });
          expect(String((workflowMemory as { readonly stdout?: unknown }).stdout)).toMatch(
            /^available workflow memory: (alpha-process|beta-unused)\n$/u,
          );
          await expect(
            bash.execute({
              cmd: "cp /mnt/memory/workflow/available.md /mnt/scratch/own/worker-memory-copy.md",
            }),
          ).resolves.toMatchObject({ exitCode: 0 });
          observed.workerWorkflowMemory ||= ctx.memoryMounts.some((mount) =>
            mount.storeId === "workflow:alpha-process" &&
            mount.mountPath === "/mnt/memory/workflow/" &&
            mount.mode === "ro"
          );
          observed.workerPipelineMemory ||= ctx.memoryMounts.some((mount) =>
            mount.storeId.startsWith("pipeline:") &&
            mount.mountPath === "/mnt/memory/pipeline/" &&
            mount.mode === "ro"
          );
          observed.workerScratch ||= ctx.scratchMounts.some((mount) =>
            mount.mountPath === "/mnt/scratch/own/" &&
            mount.mode === "rw"
          );
          observed.workerFromOrchestratorScratch ||= ctx.scratchMounts.some((mount) =>
            mount.mountPath === "/mnt/scratch/from-orchestrator/" &&
            mount.mode === "ro" &&
            mount.backingPath === join(dataDir, "runs", "run_harness_orchestrator_memory", "scratch")
          );
          observed.workerSkillPresent ||= ctx.skills.some((entry) => entry.name === "acceptance-worker");
          observed.workerOrgSkillPresent ||= ctx.skills.some((entry) => entry.name === "acceptance-org");
        }
        if (task.kind === "execute_step" && task.step.uses === "code.run") {
          await appendTestExecuteStepEvent(ctx, task, "harness.execute_step.started");
          if (task.step.id === "enrich") {
            const input = task.stepInput as { readonly item: string };
            const lookupTool = executableTool(ctx.tools.lookup);
            const callId = `${ctx.session.runId}:enrich:lookup`;
            const args = { item: input.item };
            await appendCodeToolCallEvent(ctx, "harness.tool_call.started", {
              callId,
              toolName: "lookup",
              args,
            });
            const row = await lookupTool(args) as { readonly label: string };
            await appendCodeToolCallEvent(ctx, "harness.tool_call.succeeded", {
              callId,
              toolName: "lookup",
              args,
              result: row,
              durationMs: 0,
            });
            const output = { item: input.item, label: row.label };
            await appendTestExecuteStepEvent(ctx, task, "harness.execute_step.succeeded", { output });
            return { kind: "execute_step", output, artifactRefs: [] };
          }
          if (task.step.id === "finalize") {
            const input = task.stepInput as { readonly item: string; readonly label: string };
            if (input.item === "broken") {
              throw new Error("needs fixer");
            }
            const output = { item: input.item, label: input.label, repaired: false };
            await appendTestExecuteStepEvent(ctx, task, "harness.execute_step.succeeded", { output });
            return { kind: "execute_step", output, artifactRefs: [] };
          }
          if (task.step.id === "emit") {
            const output = task.stepInput as Record<string, unknown>;
            await appendTestExecuteStepEvent(ctx, task, "harness.execute_step.succeeded", { output });
            return { kind: "execute_step", output, artifactRefs: [] };
          }
          throw new Error(`Unexpected code.run step for acceptance worker: ${task.step.id}`);
        }
        if (ctx.scope.role === "fixer") {
          const bash = ctx.bash;
          if (bash === undefined) {
            throw new Error("Expected fixer context to include bash.");
          }
          await expect(
            bash.execute({ cmd: "cat /mnt/scratch/from-orchestrator/pipeline.json" }),
          ).resolves.toMatchObject({
            stdout: JSON.stringify({ stage: "orchestrator", planned: "alpha-process" }),
            exitCode: 0,
          });
          await expect(
            bash.execute({ cmd: "cat /mnt/scratch/peer-steps/enrich/worker-memory-copy.md" }),
          ).resolves.toMatchObject({
            stdout: "available workflow memory: alpha-process\n",
            exitCode: 0,
          });
          observed.workerPeerScratchReadable = true;
          observed.fixerWorkflowMemory = ctx.memoryMounts.some((mount) =>
            mount.storeId === "workflow:alpha-process" &&
            mount.mountPath === "/mnt/memory/workflow/" &&
            mount.mode === "ro"
          );
          observed.fixerPipelineMemory = ctx.memoryMounts.some((mount) =>
            mount.storeId.startsWith("pipeline:") &&
            mount.mountPath === "/mnt/memory/pipeline/" &&
            mount.mode === "ro"
          );
          observed.fixerScratch = ctx.scratchMounts.some((mount) =>
            mount.mountPath === "/mnt/scratch/own/" &&
            mount.mode === "rw"
          );
          observed.fixerFromOrchestratorScratch = ctx.scratchMounts.some((mount) =>
            mount.mountPath === "/mnt/scratch/from-orchestrator/" &&
            mount.mode === "ro" &&
            mount.backingPath === join(dataDir, "runs", "run_harness_orchestrator_memory", "scratch")
          );
          observed.fixerSkillPresent = ctx.skills.some((entry) => entry.name === "acceptance-worker");
          observed.fixerOrgSkillPresent = ctx.skills.some((entry) => entry.name === "acceptance-org");
        }
        return workerHarnessRuntime.run(task, ctx);
      }),
    } satisfies Harness & { readonly harnessId: string };

    const orchestratorHarness = {
      harnessId: "acceptanceOrchestratorHarness@1.0.0",
      run: vi.fn<Harness["run"]>(async (task, ctx) => {
        observed.contexts.push({ role: ctx.scope.role, ctx });
        if (task.kind !== "orchestrate") {
          return { kind: "delegate_to_default" };
        }
        expect(task.available).toHaveLength(2);
        const alphaMemory = ctx.memoryMounts.find((mount) =>
          mount.mountPath === "/mnt/memory/available-workflows/alpha-process/"
        );
        expect(alphaMemory).toBeDefined();
        observed.orchestratorAvailableMemory = await readFile(join(alphaMemory!.backingPath, "available.md"), "utf8");
        const ownScratch = ctx.scratchMounts.find((mount) => mount.mountPath === "/mnt/scratch/own/");
        expect(ownScratch).toBeDefined();
        observed.orchestratorScratchFile = join(ownScratch!.backingPath, "pipeline.json");
        await writeFileAt(
          observed.orchestratorScratchFile,
          JSON.stringify({ stage: "orchestrator", planned: "alpha-process" }),
        );

        const plan = executableTool(ctx.tools.plan_workflow);
        const run = executableTool(ctx.tools.run_workflow);
        const plannedAlpha = await plan({
          workflowId: "alpha.process",
          input: { item: "broken" },
        }) as { workflowVersionId: string };
        const plannedBeta = await plan({
          workflowId: "beta.unused",
          input: {},
        }) as { workflowVersionId: string };
        await plan({
          workflowId: "alpha.process",
          input: { item: "seed-2" },
        });
        const runs = await Promise.all([
          run({ workflowVersionId: plannedAlpha.workflowVersionId, input: { item: "broken" } }),
          run({ workflowVersionId: plannedBeta.workflowVersionId, input: {} }),
          run({ workflowVersionId: plannedBeta.workflowVersionId, input: {} }),
        ]);
        return {
          kind: "orchestrate",
          output: { workflowVersionId: plannedAlpha.workflowVersionId, runs },
        };
      }),
    } satisfies Harness & { readonly harnessId: string };

    const tools = createToolRegistry();
    const lookup = vi.fn(async (input: unknown) => {
      const item = String((input as { item: string }).item);
      return { label: `lookup:${item}` };
    });
    tools.register("lookup", {
      description: "Lookup deterministic item labels.",
      inputSchema: itemInputSchema,
      outputSchema: {
        type: "object",
        required: ["label"],
        additionalProperties: false,
        properties: { label: { type: "string" } },
      },
      execute: lookup,
    });

    const fixerModel = model({ provider: "test", modelId: "fixer-model" }, { id: "model.fixer" });
    const alphaWorkflow = createLittleWorkflow({
      id: "alpha.process",
      description: "Process one item with code and fixer coverage.",
      inputSchema: itemInputSchema,
      output: output.object({ schema: itemOutputSchema }),
      models: [fixerModel],
      planner: {
        model: { provider: "test", modelId: "planner-model" },
        harness: plannerHarness,
        skills: [skill(skillDir)],
      },
      worker: { harness: workerHarness, skills: [skill(workerSkillDir)] },
      memory: { workflow: "rw", org: "none" },
      workflowVersionReuseStrategy: "planner_reviewed",
      globalTools: ["lookup"],
    });
    const betaWorkflow = createLittleWorkflow({
      id: "beta.unused",
      description: "Second available workflow for orchestrator choice.",
      inputSchema: noopInputSchema,
      output: output.object({ schema: noopOutputSchema }),
      models: [fixerModel],
      planner: {
        model: { provider: "test", modelId: "planner-model" },
        harness: plannerHarness,
      },
      worker: { harness: workerHarness, skills: [skill(workerSkillDir)] },
      memory: { workflow: "rw", org: "ro" },
    });

    const stableHash = getWorkflowDefinitionHash(alphaWorkflow, tools);
    expect(getWorkflowDefinitionHash(alphaWorkflow, tools)).toBe(stableHash);

    const result = await runWorkflow({
      world,
      workflows: [alphaWorkflow, betaWorkflow],
      orchestrator: {
        model: { provider: "test", modelId: "orchestrator-model" },
        harness: orchestratorHarness,
      },
      input: { batch: "acceptance" },
      tools,
      runId: "run_harness_orchestrator_memory",
    });

    expect(result.status).toBe("completed");
    const payload = result.output as {
      workflowVersionId: string;
      runs: Array<{ readonly runId: string; readonly status: string; readonly output?: unknown }>;
    };
    expect(payload.workflowVersionId).toMatch(/^wfver_/u);
    expect(payload.runs).toHaveLength(3);
    expect(
      payload.runs.filter((run) =>
        run.status === "completed" &&
        canonicalOutput(run.output) === canonicalOutput({ item: "broken", label: "lookup:broken", repaired: true })
      ),
    ).toHaveLength(1);
    expect(plannerHarness.run).toHaveBeenCalledTimes(3);
    expect(orchestratorHarness.run).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(fixerLoop).toHaveBeenCalledTimes(1);
    expect(observed.orchestratorAvailableMemory).toContain("alpha-process");
    expect(observed.orchestratorScratchFile).toBeDefined();
    await expect(readFile(observed.orchestratorScratchFile!, "utf8")).resolves.toContain("alpha-process");
    expect(observed.plannerWorkflowMemory).toBe(true);
    expect(observed.plannerAlphaOrgMemoryAbsent).toBe(true);
    expect(observed.plannerOrgSkillPresent).toBe(true);
    expect(observed.workerWorkflowMemory).toBe(true);
    expect(observed.workerPipelineMemory).toBe(true);
    expect(observed.workerScratch).toBe(true);
    expect(observed.workerFromOrchestratorScratch).toBe(true);
    expect(observed.workerPeerScratchReadable).toBe(true);
    expect(observed.workerSkillPresent).toBe(true);
    expect(observed.workerOrgSkillPresent).toBe(true);
    expect(observed.fixerWorkflowMemory).toBe(true);
    expect(observed.fixerPipelineMemory).toBe(true);
    expect(observed.fixerScratch).toBe(true);
    expect(observed.fixerFromOrchestratorScratch).toBe(true);
    expect(observed.fixerSkillPresent).toBe(true);
    expect(observed.fixerOrgSkillPresent).toBe(true);

    const rootEvents = await listEvents(world, "run_harness_orchestrator_memory");
    expect(startedRoles(rootEvents)).toContain("orchestrator");

    const plannerRunIds = [...new Set(
      observed.contexts
        .filter(({ role }) => role === "planner")
        .map(({ ctx }) => ctx.scope.runId),
    )];
    const plannerEventSets = await Promise.all(plannerRunIds.map((plannerRunId) => listEvents(world, plannerRunId)));
    expect(startedRoles(plannerEventSets.flat())).toContain("planner");
    for (const plannerEvents of plannerEventSets) {
      const started = plannerEvents.find((event) => event.type === "harness.session.started");
      expect(started?.payload.parentRunId).toBe("run_harness_orchestrator_memory");
    }

    const subRunEvents = await Promise.all(payload.runs.map((run) => listEvents(world, run.runId)));
    const allSubRunEvents = subRunEvents.flat();
    expect(startedRoles(allSubRunEvents)).toContain("worker.code-run");
    expect(startedRoles(allSubRunEvents)).toContain("fixer");
    expect(allSubRunEvents.some((event) =>
      event.type === "harness.tool_call.started" &&
      event.payload.caller === "code" &&
      event.payload.toolName === "lookup"
    )).toBe(true);

    for (const event of [...rootEvents, ...allSubRunEvents]) {
      if (event.type === "harness.session.started") {
        expect(event.payload.manifestHash).toBe(sha256Digest(event.payload.manifest));
      }
    }
    const workerOrFixerStarts = allSubRunEvents
      .filter((event) => event.type === "harness.session.started")
      .filter((event) =>
        event.payload.role === "worker.code-run" ||
        event.payload.role === "worker.ai-generate" ||
        event.payload.role === "worker.tool-call" ||
        event.payload.role === "fixer"
      );
    for (const event of workerOrFixerStarts) {
      const manifest = event.payload.manifest as { memoryStoreIds?: unknown };
      expect(Array.isArray(manifest.memoryStoreIds)).toBe(true);
      const storeIds = manifest.memoryStoreIds as string[];
      expect(new Set(storeIds).size).toBe(storeIds.length);
      expect(storeIds.some((entry) => entry.startsWith("workflow:"))).toBe(true);
      expect(storeIds.some((entry) => entry.startsWith("pipeline:"))).toBe(true);
    }
    expect(workerOrFixerStarts.some((event) => {
      const manifest = event.payload.manifest as { memoryStoreIds?: unknown };
      return Array.isArray(manifest.memoryStoreIds) &&
        manifest.memoryStoreIds.includes("workflow:alpha-process");
    })).toBe(true);
    const workerSkill = observed.contexts
      .flatMap(({ ctx }) => ctx.skills)
      .find((entry) => entry.name === "acceptance-worker");
    const orgSkill = observed.contexts
      .flatMap(({ ctx }) => ctx.skills)
      .find((entry) => entry.name === "acceptance-org");
    expect(workerSkill?.frontmatterHash).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(orgSkill?.frontmatterHash).toMatch(/^sha256:[a-f0-9]{64}$/u);
    const emptySkillsHash = sha256Digest([]);
    for (const event of workerOrFixerStarts) {
      const manifest = event.payload.manifest as { skillsHash?: unknown };
      if (event.payload.role === "worker.code-run" || event.payload.role === "fixer") {
        expect(manifest.skillsHash).not.toBe(emptySkillsHash);
      }
      expect(event.payload.parentRunId).toBe("run_harness_orchestrator_memory");
    }
    expect(observed.contexts.some(({ ctx }) => ctx.memoryMounts.length > 0)).toBe(true);
    expect(observed.contexts.some(({ ctx }) => ctx.scratchMounts.length > 0)).toBe(true);
  }, 30000);
});

function alphaProcessLwir(): LwirWorkflow {
  const enrichSource =
    "async ({ input, tools }) => { const row = await tools.lookup({ item: input.item }); return { item: input.item, label: row.label }; }";
  const finalizeSource =
    "async ({ input }) => { if (input.item === 'broken') throw new Error('needs fixer'); return { item: input.item, label: input.label, repaired: false }; }";
  return {
    apiVersion: "littleworkflow.dev/v0.1",
    kind: "Workflow",
    metadata: { name: "alpha.process" },
    input: { schema: itemInputSchema },
    output: { schema: itemOutputSchema },
    permissions: {
      tools: ["lookup"],
      models: ["model.fixer"],
    },
    steps: [
      {
        id: "enrich",
        uses: "code.run",
        with: {
          source: enrichSource,
          entrypoint: "enrich.ts",
          files: { "enrich.ts": codeFile(enrichSource) },
          sandbox: { network: "deny", env: "deny", fs: "deny" },
        },
        input: { item: "{{ input.item }}" },
        output: {
          mode: "object",
          schema: {
            type: "object",
            required: ["item", "label"],
            additionalProperties: false,
            properties: {
              item: { type: "string" },
              label: { type: "string" },
            },
          },
        },
      },
      {
        id: "finalize",
        uses: "code.run",
        needs: ["enrich"],
        with: {
          source: finalizeSource,
          entrypoint: "finalize.ts",
          files: { "finalize.ts": codeFile(finalizeSource) },
          sandbox: { network: "deny", env: "deny", fs: "deny" },
        },
        input: {
          item: "{{ steps.enrich.output.item }}",
          label: "{{ steps.enrich.output.label }}",
        },
        onFailure: {
          fixer: {
            model: "model.fixer",
            maxAttempts: 1,
            system: "Return fixed final output.",
          },
        },
        output: { mode: "object", schema: itemOutputSchema },
      },
    ],
  };
}

function betaNoopLwir(): LwirWorkflow {
  return {
    apiVersion: "littleworkflow.dev/v0.1",
    kind: "Workflow",
    metadata: { name: "beta.unused" },
    input: { schema: noopInputSchema },
    output: { schema: noopOutputSchema },
    permissions: {
      tools: [],
      models: [],
      secrets: [],
      network: [],
    },
    steps: [
      {
        id: "emit",
        uses: "code.run",
        with: {
          source: "async ({ input }) => input",
          entrypoint: "emit.ts",
          files: { "emit.ts": codeFile("async ({ input }) => input") },
          sandbox: { network: "deny", env: "deny", fs: "deny" },
        },
        output: { mode: "object", schema: noopOutputSchema },
      },
    ],
  };
}

function codeFile(content: string): { readonly sha256: string; readonly content: string } {
  return {
    sha256: `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`,
    content,
  };
}

async function writeFileAt(path: string, contents: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, contents);
}

function executableTool(tool: unknown): (input: unknown) => Promise<unknown> {
  if ((typeof tool !== "object" && typeof tool !== "function") || tool === null) {
    throw new TypeError("Expected executable tool object.");
  }
  const execute = (tool as { execute?: unknown }).execute;
  if (typeof execute !== "function") {
    throw new TypeError("Expected tool.execute function.");
  }
  return execute as (input: unknown) => Promise<unknown>;
}

function startedRoles(events: Awaited<ReturnType<typeof listEvents>>): string[] {
  return events
    .filter((event) => event.type === "harness.session.started")
    .map((event) => String(event.payload.role));
}

function canonicalOutput(value: unknown): string {
  return JSON.stringify(value);
}
