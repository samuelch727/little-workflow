import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  appendEvent,
  createWorkflowHarness,
  createLittleWorkflow,
  createToolRegistry,
  executeWorkflowVersion,
  readArtifact,
  localWorld,
  listEvents,
  output,
  readStoredWorkflowVersion,
  registerStoredWorkflowVersion,
  sha256Digest,
  getWorkflowDefinitionHash,
  skill,
  runWorkflow as runWorkflowPublic,
  RunFailedError,
  workflowHarness,
  writeOuterLoopManifest,
  writeArtifact,
} from "./index.js";
import { runWorkflowWithLegacyPlannerAdapter } from "./runtime.js";
import { materializeRunStateFromEvents } from "./run-state.js";
import { runReport } from "./run-report.js";
import { compileWorkflow, type PlannerAdapter } from "./compiler.js";
import {
  computeCompiledWorkflowVersionIdentity,
  computeCompilerValidationHash,
  workflowVersionLockSeedFrom,
} from "./compiler-lock.js";
import {
  concreteInputStructure,
  concreteInputStructureHash,
} from "./workflow-version-reuse.js";
import type {
  Harness,
  HarnessTask,
  InferWorkflowOutput,
  LwirWorkflow,
  RunResult,
  RunWorkflowOptions,
  RuntimeToolHandler,
  SuperviseDecision,
  SuperviseOuterLoopState,
  WorkflowRunTarget,
} from "./index.js";
import { model } from "./index.js";
import { cleanupTempDirs, workerScopedTempPrefix } from "./test-temp.js";

const tempDirs: string[] = [];

async function tempWorld() {
  const dataDir = await mkdtemp(
    join(
      tmpdir(),
      workerScopedTempPrefix("little-workflow-run-workflow-", process.env.VITEST_POOL_ID),
    ),
  );
  tempDirs.push(dataDir);
  return localWorld({ dataDir });
}

afterEach(async () => {
  await cleanupTempDirs(tempDirs);
});

const ticketInputSchema = {
  type: "object",
  required: ["ticketId", "body"],
  additionalProperties: false,
  properties: {
    ticketId: { type: "string" },
    body: { type: "string" },
  },
};

const ticketOutputSchema = {
  type: "object",
  required: ["summary"],
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
  },
};

const ticketToolRegistry = createToolRegistry();
ticketToolRegistry.register("summarize", {
  description: "Summarize a ticket.",
  inputSchema: ticketInputSchema,
  execute: async (input) => input as Record<string, unknown>,
});

const workerModel = model(
  { provider: "test", modelId: "worker-model" },
  { description: "Worker model for runtime tests." },
);

const ticketWorkflow = createLittleWorkflow({
  id: "support.summarize",
  description: "Summarize a ticket.",
  inputSchema: ticketInputSchema,
  output: output.object({ schema: ticketOutputSchema }),
  models: [workerModel],
  globalTools: ["summarize"],
} as unknown as Parameters<typeof createLittleWorkflow>[0]);

const multiStepToolRegistry = createToolRegistry();
multiStepToolRegistry.register("extract", {
  description: "Extract ticket context.",
  inputSchema: ticketInputSchema,
  execute: async (input) => input as Record<string, unknown>,
});
multiStepToolRegistry.register("summarize", {
  description: "Summarize extracted context.",
  inputSchema: {
    type: "object",
    required: ["context"],
    additionalProperties: false,
    properties: { context: { type: "string" } },
  },
  execute: async (input) => input as Record<string, unknown>,
});

const multiStepWorkflow = createLittleWorkflow({
  id: "support.multi-step",
  description: "Run two artifact-producing steps.",
  inputSchema: ticketInputSchema,
  output: output.object({ schema: ticketOutputSchema }),
  models: [workerModel],
  globalTools: ["extract", "summarize"],
} as unknown as Parameters<typeof createLittleWorkflow>[0]);

function singleToolLwir(): LwirWorkflow {
  return singleToolLwirWithStepId("summarize");
}

function singleToolLwirWithStepId(stepId: string): LwirWorkflow {
  return {
    apiVersion: "littleworkflow.dev/v0.1",
    kind: "Workflow",
    metadata: {
      name: "support.summarize",
      version: "0.1.0-alpha",
      description: "Summarize a ticket.",
    },
    input: { schema: ticketInputSchema },
    output: { schema: ticketOutputSchema },
    permissions: { tools: ["summarize"], models: [], secrets: [], network: [] },
    steps: [
      {
        id: stepId,
        uses: "tool.call",
        with: { tool: "summarize" },
        input: {
          ticketId: "{{ input.ticketId }}",
          body: "{{ input.body }}",
        },
        output: { mode: "object", schema: ticketOutputSchema },
      },
    ],
  };
}

function multiStepLwir(): LwirWorkflow {
  return {
    apiVersion: "littleworkflow.dev/v0.1",
    kind: "Workflow",
    metadata: {
      name: "support.multi-step",
      version: "0.1.0-alpha",
      description: "Run two artifact-producing steps.",
    },
    input: { schema: ticketInputSchema },
    output: { schema: ticketOutputSchema },
    permissions: { tools: ["extract", "summarize"], models: [], secrets: [], network: [] },
    steps: [
      {
        id: "extract",
        uses: "tool.call",
        with: { tool: "extract" },
        input: {
          ticketId: "{{ input.ticketId }}",
          body: "{{ input.body }}",
        },
        output: {
          mode: "object",
          schema: {
            type: "object",
            required: ["context"],
            additionalProperties: false,
            properties: { context: { type: "string" } },
          },
        },
      },
      {
        id: "summarize",
        uses: "tool.call",
        needs: ["extract"],
        with: { tool: "summarize" },
        input: {
          context: "{{ steps.extract.output.context }}",
        },
        output: { mode: "object", schema: ticketOutputSchema },
      },
    ],
  };
}

const codeRunInputSchema = {
  type: "object",
  required: ["ticketId"],
  additionalProperties: false,
  properties: { ticketId: { type: "string" } },
};

const codeRunOutputSchema = {
  type: "object",
  required: ["final"],
  additionalProperties: false,
  properties: { final: { type: "string" } },
};

function codeRunLwir(): LwirWorkflow {
  const source = "async ({ input }) => ({ final: `ticket:${input.ticketId}` })";
  return {
    apiVersion: "littleworkflow.dev/v0.1",
    kind: "Workflow",
    metadata: {
      name: "support.code-run",
      version: "0.1.0-alpha",
      description: "Compute a ticket result.",
    },
    input: { schema: codeRunInputSchema },
    output: { schema: codeRunOutputSchema },
    permissions: { tools: [], models: [], secrets: [], network: [] },
    steps: [
      {
        id: "compute",
        uses: "code.run",
        with: {
          source,
          entrypoint: "main.ts",
          sandbox: { network: "deny" },
          files: { "main.ts": codeRunFile(source) },
        },
        input: { ticketId: "{{ input.ticketId }}" },
        output: { mode: "object", schema: codeRunOutputSchema },
      },
    ],
  };
}

function codeRunFile(content: string) {
  return {
    sha256: `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`,
    content,
  };
}

function codeRunWorkflow(workerHarness?: Harness) {
  return createLittleWorkflow({
    id: "support.code-run",
    description: "Compute a ticket result.",
    inputSchema: codeRunInputSchema,
    output: output.object({ schema: codeRunOutputSchema }),
    ...(workerHarness === undefined ? {} : { worker: { harness: workerHarness } }),
  } as unknown as Parameters<typeof createLittleWorkflow>[0]);
}

function codeRunTestWorkerHarness(
  harnessId = "codeRunTestHarness@1.0.0",
): Harness & { readonly harnessId: string } {
  return {
    harnessId,
    run: vi.fn<Harness["run"]>(async (task) => {
      if (task.kind !== "execute_step" || task.step.uses !== "code.run") {
        return { kind: "delegate_to_default" };
      }
      const ticketId = String((task.stepInput as { readonly ticketId?: unknown }).ticketId);
      return {
        kind: "execute_step",
        output: { final: `ticket:${ticketId}` },
        artifactRefs: [],
      };
    }),
  };
}

function plannerFor(lwir: LwirWorkflow): PlannerAdapter {
  return {
    draft: vi.fn(async () => lwir),
  };
}

type RunWorkflowLegacyPlannerOptions<TWorkflow extends WorkflowRunTarget> =
  RunWorkflowOptions<TWorkflow> & {
    readonly planner?: PlannerAdapter;
  };

async function runWorkflow<TWorkflow extends WorkflowRunTarget>(
  options: RunWorkflowLegacyPlannerOptions<TWorkflow>,
): Promise<RunResult<InferWorkflowOutput<TWorkflow>>> {
  return runWorkflowWithLegacyPlannerAdapter(options) as Promise<
    RunResult<InferWorkflowOutput<TWorkflow>>
  >;
}

async function appendLegacyCompiledLifecyclePrefix(
  world: Awaited<ReturnType<typeof tempWorld>>,
  runId: string,
  compiled: Awaited<ReturnType<typeof compileWorkflow>>,
  registrationPayload: Record<string, unknown>,
): Promise<void> {
  await appendLegacyCompiledLifecycleWithoutRegistration(world, runId, compiled);
  await appendEvent(world, runId, {
    type: "WorkflowVersionRegistered",
    payload: registrationPayload,
  });
}

async function appendLegacyCompiledLifecycleWithoutRegistration(
  world: Awaited<ReturnType<typeof tempWorld>>,
  runId: string,
  compiled: Awaited<ReturnType<typeof compileWorkflow>>,
): Promise<void> {
  const revision = compiled.revisions[0];
  if (revision === undefined) {
    throw new Error("Expected a compiler revision.");
  }
  await appendEvent(world, runId, {
    type: "OrchestrationRequested",
    payload: {
      requestId: compiled.request.requestId,
      requestHash: compiled.request.locks.requestHash,
      inputHash: compiled.request.locks.inputHash,
      workflowDefinitionHash: compiled.request.locks.workflowDefinitionHash,
      inputSchemaHash: compiled.request.locks.inputSchemaHash,
      requestedOutputHash: compiled.request.locks.requestedOutputHash,
      capabilityManifestHash: sha256Digest(compiled.request.capabilityManifest),
      workflowId: compiled.request.metadata.name,
      description: compiled.request.metadata.description,
      maxWorkflowRevisions: compiled.request.controls.maxWorkflowRevisions,
    },
  });
  await appendEvent(world, runId, {
    type: "PlannerStarted",
    payload: { requestId: compiled.request.requestId, revision: 1, repair: false },
  });
  await appendEvent(world, runId, {
    type: "PlannerDraftedWorkflow",
    payload: {
      requestId: compiled.request.requestId,
      revision: revision.revision,
      valid: revision.valid,
      lwirHash: sha256Digest(revision.lwir),
      lwir: revision.lwir,
    },
  });
  await appendEvent(world, runId, {
    type: "WorkflowValidationSucceeded",
    payload: {
      requestId: compiled.request.requestId,
      revision: revision.revision,
      lwirHash: sha256Digest(revision.lwir),
      workflowVersionId: compiled.workflowVersion.id,
      lwirVersionId: compiled.workflowVersion.lwirVersionId,
      validationHash: compiled.workflowVersion.lock.validationHash,
    },
  });
}

async function appendPartialReuseReplayPrefix(
  world: Awaited<ReturnType<typeof tempWorld>>,
  runId: string,
  options: {
    readonly workflowVersionId: string;
    readonly input: unknown;
    readonly registrationPayload: Record<string, unknown>;
  },
): Promise<void> {
  await appendEvent(world, runId, {
    type: "PlannerReuseDecisionRecorded",
    payload: {
      decisionKind: "reuse_unchanged",
      candidateWorkflowVersionId: options.workflowVersionId,
      rationale: "Resume the previously approved reuse decision.",
      acknowledgedWarnings: [],
      inputHash: sha256Digest(options.input),
      candidateBriefHash: sha256Digest(`${runId}:partial-reuse-brief`),
      resultingWorkflowVersionId: options.workflowVersionId,
    },
  });
  await appendEvent(world, runId, {
    type: "WorkflowVersionRegistered",
    payload: options.registrationPayload,
  });
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function runLockDir(dataDir: string, runId: string) {
  return join(dataDir, "locks", sha256Digest(runId).replace(/[^A-Za-z0-9_-]/gu, "_"));
}

async function writeRunLockOwner(dataDir: string, runId: string, pid: number) {
  const lockDir = runLockDir(dataDir, runId);
  await mkdir(lockDir, { recursive: true });
  await writeFile(join(lockDir, "owner.json"), JSON.stringify({ pid }), "utf8");
}

/** Build a ToolRegistry with the "summarize" tool using ticketWorkflow's descriptor + the given handler. */
function ticketRegistryWith(summarize: RuntimeToolHandler) {
  const registry = createToolRegistry();
  registry.register("summarize", {
    description: "Summarize a ticket.",
    inputSchema: ticketInputSchema,
    execute: summarize as (input: unknown, context: unknown) => Promise<unknown>,
  });
  return registry;
}

/** Build a ToolRegistry for multiStepWorkflow with both "extract" and "summarize". */
function multiStepRegistryWith(
  extract: RuntimeToolHandler,
  summarize: RuntimeToolHandler,
) {
  const registry = createToolRegistry();
  registry.register("extract", {
    description: "Extract ticket context.",
    inputSchema: ticketInputSchema,
    execute: extract as (input: unknown, context: unknown) => Promise<unknown>,
  });
  registry.register("summarize", {
    description: "Summarize extracted context.",
    inputSchema: {
      type: "object",
      required: ["context"],
      additionalProperties: false,
      properties: { context: { type: "string" } },
    },
    execute: summarize as (input: unknown, context: unknown) => Promise<unknown>,
  });
  return registry;
}

describe("runWorkflow integration", () => {
  it("planner_reviewed reuses an existing successful WorkflowVersion when the planner chooses reuse_unchanged", async () => {
    const world = await tempWorld();
    const firstInput = { ticketId: "TIN-12", body: "Cannot export invoices." };
    const secondInput = { ticketId: "TIN-13", body: "Cannot import receipts." };
    const plannerRequests: Array<Parameters<PlannerAdapter["draft"]>[0]> = [];
    let firstWorkflowVersionId = "";
    const planner: PlannerAdapter = {
      draft: vi.fn(async (request) => {
        plannerRequests.push(request);
        if (plannerRequests.length === 1) {
          return singleToolLwir();
        }
        return {
          kind: "reuse_unchanged",
          workflowVersionId: firstWorkflowVersionId,
          rationale: "The existing plan still matches this input.",
        };
      }),
    };
    const summarize = vi.fn<RuntimeToolHandler>((toolInput) => {
      const typed = toolInput as { ticketId: string; body: string };
      return { summary: `${typed.ticketId}:${typed.body}` };
    });

    const first = await runWorkflow({
      world,
      workflows: ticketWorkflow,
      input: firstInput,
      planner,
      tools: ticketRegistryWith(summarize),
      runId: "run_planner_reviewed_reuse_first",
      workflowVersionReuseStrategy: "planner_reviewed",
    });
    firstWorkflowVersionId = first.workflowVersionId;
    const second = await runWorkflow({
      world,
      workflows: ticketWorkflow,
      input: secondInput,
      planner,
      tools: ticketRegistryWith(summarize),
      runId: "run_planner_reviewed_reuse_second",
      workflowVersionReuseStrategy: "planner_reviewed",
    });

    expect(planner.draft).toHaveBeenCalledTimes(2);
    expect(second.workflowVersionId).toBe(first.workflowVersionId);
    expect(second.output).toEqual({ summary: "TIN-13:Cannot import receipts." });
    expect(plannerRequests[1]?.messages.system).toContain("Candidate WorkflowVersion");
    expect(plannerRequests[1]?.messages.system).toContain(first.workflowVersionId);

    const secondEventTypes = second.events.map((event) => event.type);
    expect(secondEventTypes).toContain("PlannerReuseDecisionRecorded");
    expect(secondEventTypes.indexOf("PlannerReuseDecisionRecorded"))
      .toBeLessThan(secondEventTypes.indexOf("WorkflowVersionRegistered"));
    expect(secondEventTypes.indexOf("PlannerReuseDecisionRecorded"))
      .toBeLessThan(secondEventTypes.indexOf("RunStarted"));
    expect(second.events.find((event) => event.type === "PlannerReuseDecisionRecorded")?.payload)
      .toEqual(expect.objectContaining({
        decisionKind: "reuse_unchanged",
        candidateWorkflowVersionId: first.workflowVersionId,
        rationale: "The existing plan still matches this input.",
        acknowledgedWarnings: [],
        inputHash: sha256Digest(secondInput),
        inputStructure: concreteInputStructure(secondInput),
        candidateBriefHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
        resultingWorkflowVersionId: first.workflowVersionId,
      }));
  });

  it("keeps direct executeWorkflowVersion permissive for SDK locks with worker harness metadata", async () => {
    const world = await tempWorld();
    const input = { ticketId: "TIN-12", body: "Cannot export invoices." };
    const directTool = vi.fn<RuntimeToolHandler>(() => ({ summary: "from direct tool" }));
    const tools = ticketRegistryWith(directTool);
    const workerHarnessV1 = {
      harnessId: "directWorkerHarness@1.0.0",
      run: vi.fn<Harness["run"]>(async (task) =>
        task.kind === "execute_step"
          ? {
              kind: "execute_step",
              output: { summary: "from worker v1" },
              artifactRefs: [],
            }
          : { kind: "delegate_to_default" }
      ),
    } satisfies Harness & { readonly harnessId: string };
    const workerHarnessV2 = {
      harnessId: "directWorkerHarness@2.0.0",
      run: vi.fn<Harness["run"]>(async (task) =>
        task.kind === "execute_step"
          ? {
              kind: "execute_step",
              output: { summary: "from worker v2" },
              artifactRefs: [],
            }
          : { kind: "delegate_to_default" }
      ),
    } satisfies Harness & { readonly harnessId: string };
    const workflowWithHarness = createLittleWorkflow({
      ...ticketWorkflow,
      worker: { harness: workerHarnessV1 },
    } as unknown as Parameters<typeof createLittleWorkflow>[0]);
    const compiled = await compileWorkflow(workflowWithHarness, {
      input,
      planner: plannerFor(singleToolLwir()),
      tools,
    });

    const sameHarness = await executeWorkflowVersion({
      world,
      workflowVersion: compiled.workflowVersion,
      input,
      tools,
      workerHarness: workerHarnessV1,
      runId: "run_direct_sdk_lock_same_harness",
    });
    const changedHarness = await executeWorkflowVersion({
      world,
      workflowVersion: compiled.workflowVersion,
      input,
      tools,
      workerHarness: workerHarnessV2,
      runId: "run_direct_sdk_lock_changed_harness",
    });
    const omittedHarness = await executeWorkflowVersion({
      world,
      workflowVersion: compiled.workflowVersion,
      input,
      tools,
      runId: "run_direct_sdk_lock_omitted_harness",
    });

    expect(sameHarness.status).toBe("completed");
    expect(changedHarness.status).toBe("completed");
    expect(omittedHarness.status).toBe("completed");
    expect(sameHarness.status === "completed" ? sameHarness.output : undefined)
      .toEqual({ summary: "from worker v1" });
    expect(changedHarness.status === "completed" ? changedHarness.output : undefined)
      .toEqual({ summary: "from worker v2" });
    expect(omittedHarness.status === "completed" ? omittedHarness.output : undefined)
      .toEqual({ summary: "from direct tool" });
    expect(workerHarnessV1.run).toHaveBeenCalledTimes(1);
    expect(workerHarnessV2.run).toHaveBeenCalledTimes(1);
    expect(directTool).toHaveBeenCalledTimes(1);
  });

  it("fails closed for code.run when worker config is omitted or empty", async () => {
    const cases = [
      {
        label: "omitted",
        workflow: codeRunWorkflow(),
      },
      {
        label: "empty",
        workflow: createLittleWorkflow({
          ...codeRunWorkflow(),
          worker: {},
        } as unknown as Parameters<typeof createLittleWorkflow>[0]),
      },
    ];

    for (const entry of cases) {
      const world = await tempWorld();
      await expect(
        runWorkflow({
          world,
          workflows: entry.workflow,
          input: { ticketId: `TIN-${entry.label}` },
          planner: plannerFor(codeRunLwir()),
          runId: `run_default_worker_harness_${entry.label}`,
        }),
      ).rejects.toThrow(/cannot safely execute code\.run|isolated runtime/u);
    }
  });

  it("wraps reuse_unchanged LWIR input schema mismatches as input_schema_error failed runs", async () => {
    const world = await tempWorld();
    const firstInput = { ticketId: "TIN-12", body: "Cannot export invoices." };
    const secondInput = {
      ticketId: "TIN-13",
      body: "Cannot import receipts.",
      priority: "high",
    };
    const first = await runWorkflow({
      world,
      workflows: ticketWorkflow,
      input: firstInput,
      planner: plannerFor(singleToolLwir()),
      tools: ticketRegistryWith(() => ({ summary: "first run" })),
      runId: "run_reuse_lwir_input_mismatch_first",
      workflowVersionReuseStrategy: "planner_reviewed",
    });
    const permissiveWorkflow = createLittleWorkflow({
      ...ticketWorkflow,
      inputSchema: {
        type: "object",
        required: ["ticketId", "body"],
        additionalProperties: true,
        properties: {
          ticketId: { type: "string" },
          body: { type: "string" },
        },
      },
    } as unknown as Parameters<typeof createLittleWorkflow>[0]);
    const reusePlanner: PlannerAdapter = {
      draft: vi.fn(async () => ({
        kind: "reuse_unchanged",
        workflowVersionId: first.workflowVersionId,
        rationale: "The old ticket summarization plan still fits.",
        acknowledgedWarnings: ["input schema hash changed"],
      })),
    };
    const summarize = vi.fn<RuntimeToolHandler>(() => ({ summary: "should not run" }));

    await expect(
      runWorkflow({
        world,
        workflows: permissiveWorkflow,
        input: secondInput,
        planner: reusePlanner,
        tools: ticketRegistryWith(summarize),
        runId: "run_reuse_lwir_input_mismatch_second",
        workflowVersionReuseStrategy: "planner_reviewed",
      }),
    ).rejects.toMatchObject({
      name: "RunFailedError",
      runId: "run_reuse_lwir_input_mismatch_second",
      causeCode: "input_schema_error",
    });

    const events = await listEvents(world, "run_reuse_lwir_input_mismatch_second");
    expect(events.filter((event) => event.type === "RunFailed")).toHaveLength(1);
    expect(events.find((event) => event.type === "RunFailed")?.payload)
      .toEqual(expect.objectContaining({
        workflowVersionId: "uncompiled",
        error: expect.objectContaining({ causeCode: "input_schema_error" }),
      }));
    expect(events.map((event) => event.type)).not.toContain("PlannerReuseDecisionRecorded");
    expect(summarize).not.toHaveBeenCalled();
  });

  it("always_fresh compiles without showing candidate WorkflowVersions to the planner", async () => {
    const world = await tempWorld();
    const input = { ticketId: "TIN-12", body: "Cannot export invoices." };
    const plannerRequests: Array<Parameters<PlannerAdapter["draft"]>[0]> = [];
    const planner: PlannerAdapter = {
      draft: vi.fn(async (request) => {
        plannerRequests.push(request);
        return plannerRequests.length === 1
          ? singleToolLwirWithStepId("summarize_first")
          : singleToolLwirWithStepId("summarize_second");
      }),
    };
    const summarize = vi.fn<RuntimeToolHandler>((toolInput) => {
      const typed = toolInput as { body: string };
      return { summary: typed.body };
    });

    const first = await runWorkflow({
      world,
      workflows: ticketWorkflow,
      input,
      planner,
      tools: ticketRegistryWith(summarize),
      runId: "run_always_fresh_first",
      workflowVersionReuseStrategy: "always_fresh",
    });
    const second = await runWorkflow({
      world,
      workflows: ticketWorkflow,
      input,
      planner,
      tools: ticketRegistryWith(summarize),
      runId: "run_always_fresh_second",
      workflowVersionReuseStrategy: "always_fresh",
    });

    expect(planner.draft).toHaveBeenCalledTimes(2);
    expect(second.workflowVersionId).not.toBe(first.workflowVersionId);
    expect(plannerRequests[1]?.messages.system ?? "").not.toContain("Candidate WorkflowVersion");
    expect(second.events.map((event) => event.type)).not.toContain("PlannerReuseDecisionRecorded");
  });

  it("requires reuse_unchanged decisions to acknowledge reuse brief warnings", async () => {
    const world = await tempWorld();
    const input = { ticketId: "TIN-12", body: "Cannot export invoices." };
    const planner: PlannerAdapter = {
      draft: vi.fn(async () => singleToolLwir()),
    };
    const summarize = vi.fn<RuntimeToolHandler>((toolInput) => {
      const typed = toolInput as { body: string };
      return { summary: typed.body };
    });
    const first = await runWorkflow({
      world,
      workflows: ticketWorkflow,
      input,
      planner,
      tools: ticketRegistryWith(summarize),
      runId: "run_reuse_warning_first",
      workflowVersionReuseStrategy: "planner_reviewed",
    });
    const changedWorkflow = createLittleWorkflow({
      ...ticketWorkflow,
      description: "Summarize a ticket with a revised planning note.",
    } as unknown as Parameters<typeof createLittleWorkflow>[0]);
    const rejectingPlanner: PlannerAdapter = {
      draft: vi.fn(async () => ({
        kind: "reuse_unchanged",
        workflowVersionId: first.workflowVersionId,
        rationale: "The changed description does not affect the executable plan.",
      })),
    };

    await expect(
      runWorkflow({
        world,
        workflows: changedWorkflow,
        input,
        planner: rejectingPlanner,
        tools: ticketRegistryWith(summarize),
        runId: "run_reuse_warning_missing_ack",
        workflowVersionReuseStrategy: "planner_reviewed",
      }),
    ).rejects.toThrow(/reuse_unchanged must acknowledge candidate warnings/u);

    const acceptingPlanner: PlannerAdapter = {
      draft: vi.fn(async () => ({
        kind: "reuse_unchanged",
        workflowVersionId: first.workflowVersionId,
        rationale: "The changed description does not affect the executable plan.",
        acknowledgedWarnings: ["description changed"],
      })),
    };
    const accepted = await runWorkflow({
      world,
      workflows: changedWorkflow,
      input,
      planner: acceptingPlanner,
      tools: ticketRegistryWith(summarize),
      runId: "run_reuse_warning_acknowledged",
      workflowVersionReuseStrategy: "planner_reviewed",
    });

    expect(accepted.workflowVersionId).toBe(first.workflowVersionId);
    expect(accepted.events.find((event) => event.type === "PlannerReuseDecisionRecorded")?.payload)
      .toEqual(expect.objectContaining({
        acknowledgedWarnings: ["description changed"],
        resultingWorkflowVersionId: first.workflowVersionId,
      }));
  });

  it("blocks reuse_unchanged when the requested output contract changes", async () => {
    const world = await tempWorld();
    const input = { ticketId: "TIN-12", body: "Cannot export invoices." };
    const planner: PlannerAdapter = {
      draft: vi.fn(async () => singleToolLwir()),
    };
    const summarize = vi.fn<RuntimeToolHandler>((toolInput) => {
      const typed = toolInput as { body: string };
      return { summary: typed.body };
    });
    const first = await runWorkflow({
      world,
      workflows: ticketWorkflow,
      input,
      planner,
      tools: ticketRegistryWith(summarize),
      runId: "run_reuse_output_contract_first",
      workflowVersionReuseStrategy: "planner_reviewed",
    });
    const changedOutputWorkflow = createLittleWorkflow({
      ...ticketWorkflow,
      output: output.object({
        schema: {
          type: "object",
          required: ["summary", "severity"],
          additionalProperties: false,
          properties: {
            summary: { type: "string" },
            severity: { type: "string" },
          },
        },
      }),
    } as unknown as Parameters<typeof createLittleWorkflow>[0]);
    const reusePlanner: PlannerAdapter = {
      draft: vi.fn(async () => ({
        kind: "reuse_unchanged",
        workflowVersionId: first.workflowVersionId,
        rationale: "The steps still look reusable.",
        acknowledgedWarnings: ["requested output hash changed"],
      })),
    };

    await expect(
      runWorkflow({
        world,
        workflows: changedOutputWorkflow,
        input,
        planner: reusePlanner,
        tools: ticketRegistryWith(summarize),
        runId: "run_reuse_output_contract_blocked",
        workflowVersionReuseStrategy: "planner_reviewed",
      }),
    ).rejects.toThrow(/reuse_unchanged is blocked.*requested output/u);
  });

  it("blocks reuse_unchanged when a candidate tool is no longer available", async () => {
    const world = await tempWorld();
    const input = { ticketId: "TIN-12", body: "Cannot export invoices." };
    const summarize = vi.fn<RuntimeToolHandler>((toolInput) => {
      const typed = toolInput as { body: string };
      return { summary: typed.body };
    });
    const first = await runWorkflow({
      world,
      workflows: ticketWorkflow,
      input,
      planner: plannerFor(singleToolLwir()),
      tools: ticketRegistryWith(summarize),
      runId: "run_reuse_tool_available_first",
      workflowVersionReuseStrategy: "planner_reviewed",
    });
    const workflowWithoutTool = createLittleWorkflow({
      ...ticketWorkflow,
      globalTools: [],
    } as unknown as Parameters<typeof createLittleWorkflow>[0]);
    const reusePlanner: PlannerAdapter = {
      draft: vi.fn(async () => ({
        kind: "reuse_unchanged",
        workflowVersionId: first.workflowVersionId,
        rationale: "The prior tool graph still looks useful.",
        acknowledgedWarnings: ["planner-visible tools changed"],
      })),
    };

    await expect(
      runWorkflow({
        world,
        workflows: workflowWithoutTool,
        input,
        planner: reusePlanner,
        tools: createToolRegistry(),
        runId: "run_reuse_tool_unavailable_blocked",
        workflowVersionReuseStrategy: "planner_reviewed",
      }),
    ).rejects.toThrow(/reuse_unchanged is blocked.*tool 'summarize'/u);
    expect(summarize).toHaveBeenCalledTimes(1);
  });

  it("blocks reuse_unchanged when a tool.call candidate worker harness changes", async () => {
    const world = await tempWorld();
    const input = { ticketId: "TIN-12", body: "Cannot export invoices." };
    const workerHarnessV1 = {
      harnessId: "workerHarness@1.0.0",
      run: vi.fn<Harness["run"]>(async () => ({
        kind: "execute_step",
        output: { summary: "from worker v1" },
        artifactRefs: [],
      })),
    } satisfies Harness & { readonly harnessId: string };
    const workerHarnessV2 = {
      harnessId: "workerHarness@2.0.0",
      run: vi.fn<Harness["run"]>(async () => ({
        kind: "execute_step",
        output: { summary: "from worker v2" },
        artifactRefs: [],
      })),
    } satisfies Harness & { readonly harnessId: string };
    const workflowWithHarnessV1 = createLittleWorkflow({
      ...ticketWorkflow,
      worker: { harness: workerHarnessV1 },
    } as unknown as Parameters<typeof createLittleWorkflow>[0]);
    const first = await runWorkflow({
      world,
      workflows: workflowWithHarnessV1,
      input,
      planner: plannerFor(singleToolLwir()),
      tools: ticketRegistryWith(() => ({ summary: "from direct tool" })),
      runId: "run_reuse_tool_worker_harness_first",
      workflowVersionReuseStrategy: "planner_reviewed",
    });
    expect(first.output).toEqual({ summary: "from worker v1" });
    const workflowWithHarnessV2 = createLittleWorkflow({
      ...ticketWorkflow,
      worker: { harness: workerHarnessV2 },
    } as unknown as Parameters<typeof createLittleWorkflow>[0]);
    const reusePlanner: PlannerAdapter = {
      draft: vi.fn(async () => ({
        kind: "reuse_unchanged",
        workflowVersionId: first.workflowVersionId,
        rationale: "The old tool-call graph still fits.",
        acknowledgedWarnings: [],
      })),
    };

    await expect(
      runWorkflow({
        world,
        workflows: workflowWithHarnessV2,
        input,
        planner: reusePlanner,
        tools: ticketRegistryWith(() => ({ summary: "from direct tool" })),
        runId: "run_reuse_tool_worker_harness_blocked",
        workflowVersionReuseStrategy: "planner_reviewed",
      }),
    ).rejects.toThrow(/reuse_unchanged is blocked.*worker harness changed/u);
    expect(workerHarnessV2.run).not.toHaveBeenCalled();
  });

  it("blocks reuse_unchanged when a tool.call candidate adds a worker harness", async () => {
    const world = await tempWorld();
    const input = { ticketId: "TIN-12", body: "Cannot export invoices." };
    const directTool = vi.fn<RuntimeToolHandler>(() => ({ summary: "from direct tool" }));
    const first = await runWorkflow({
      world,
      workflows: ticketWorkflow,
      input,
      planner: plannerFor(singleToolLwir()),
      tools: ticketRegistryWith(directTool),
      runId: "run_reuse_tool_adds_worker_harness_first",
      workflowVersionReuseStrategy: "planner_reviewed",
    });
    expect(first.output).toEqual({ summary: "from direct tool" });
    const workerHarness = {
      harnessId: "workerHarness@1.0.0",
      run: vi.fn<Harness["run"]>(async () => ({
        kind: "execute_step",
        output: { summary: "from worker harness" },
        artifactRefs: [],
      })),
    } satisfies Harness & { readonly harnessId: string };
    const workflowWithHarness = createLittleWorkflow({
      ...ticketWorkflow,
      worker: { harness: workerHarness },
    } as unknown as Parameters<typeof createLittleWorkflow>[0]);
    const reusePlanner: PlannerAdapter = {
      draft: vi.fn(async () => ({
        kind: "reuse_unchanged",
        workflowVersionId: first.workflowVersionId,
        rationale: "The old tool-call graph still fits.",
        acknowledgedWarnings: [],
      })),
    };

    await expect(
      runWorkflow({
        world,
        workflows: workflowWithHarness,
        input,
        planner: reusePlanner,
        tools: ticketRegistryWith(directTool),
        runId: "run_reuse_tool_added_worker_harness_blocked",
        workflowVersionReuseStrategy: "planner_reviewed",
      }),
    ).rejects.toThrow(/reuse_unchanged is blocked.*worker harness changed/u);
    expect(workerHarness.run).not.toHaveBeenCalled();
  });

  it("blocks reuse_unchanged when a worker-backed tool.call candidate bash capability changes", async () => {
    const world = await tempWorld();
    const input = { ticketId: "TIN-12", body: "Cannot export invoices." };
    const workerHarness = {
      harnessId: "workerHarness@1.0.0",
      run: vi.fn<Harness["run"]>(async () => ({
        kind: "execute_step",
        output: { summary: "from worker harness" },
        artifactRefs: [],
      })),
    } satisfies Harness & { readonly harnessId: string };
    const workflowWithBashDisabled = createLittleWorkflow({
      ...ticketWorkflow,
      worker: { harness: workerHarness },
      bash: { javascript: false },
    } as unknown as Parameters<typeof createLittleWorkflow>[0]);
    const first = await runWorkflow({
      world,
      workflows: workflowWithBashDisabled,
      input,
      planner: plannerFor(singleToolLwir()),
      tools: ticketRegistryWith(() => ({ summary: "from direct tool" })),
      runId: "run_reuse_tool_bash_capability_first",
      workflowVersionReuseStrategy: "planner_reviewed",
    });
    expect(first.output).toEqual({ summary: "from worker harness" });
    const workflowWithBashEnabled = createLittleWorkflow({
      ...ticketWorkflow,
      worker: { harness: workerHarness },
      bash: { javascript: true },
    } as unknown as Parameters<typeof createLittleWorkflow>[0]);
    const reusePlanner: PlannerAdapter = {
      draft: vi.fn(async () => ({
        kind: "reuse_unchanged",
        workflowVersionId: first.workflowVersionId,
        rationale: "The old tool-call graph still fits.",
        acknowledgedWarnings: [],
      })),
    };

    await expect(
      runWorkflow({
        world,
        workflows: workflowWithBashEnabled,
        input,
        planner: reusePlanner,
        tools: ticketRegistryWith(() => ({ summary: "from direct tool" })),
        runId: "run_reuse_tool_bash_capability_blocked",
        workflowVersionReuseStrategy: "planner_reviewed",
      }),
    ).rejects.toThrow(/reuse_unchanged is blocked.*bash capability/u);
    expect(workerHarness.run).toHaveBeenCalledTimes(1);
  });

  it("blocks reuse_unchanged when a code.run candidate falls back from a custom worker harness to the default harness", async () => {
    const world = await tempWorld();
    const workerHarness = codeRunTestWorkerHarness("customCodeHarness@1.0.0");
    const first = await runWorkflow({
      world,
      workflows: codeRunWorkflow(workerHarness),
      input: { ticketId: "TIN-12" },
      planner: plannerFor(codeRunLwir()),
      runId: "run_reuse_code_harness_first",
      workflowVersionReuseStrategy: "planner_reviewed",
    });
    expect(first.output).toEqual({ final: "ticket:TIN-12" });
    const reusePlanner: PlannerAdapter = {
      draft: vi.fn(async () => ({
        kind: "reuse_unchanged",
        workflowVersionId: first.workflowVersionId,
        rationale: "The code step is still useful.",
        acknowledgedWarnings: [],
      })),
    };

    await expect(
      runWorkflow({
        world,
        workflows: codeRunWorkflow(),
        input: { ticketId: "TIN-13" },
        planner: reusePlanner,
        runId: "run_reuse_code_harness_blocked",
        workflowVersionReuseStrategy: "planner_reviewed",
      }),
    ).rejects.toThrow(/reuse_unchanged is blocked.*worker harness/u);
  });

  it("blocks reuse_unchanged for legacy code.run candidates without worker harness lock metadata", async () => {
    const world = await tempWorld();
    const workerHarness = createWorkflowHarness();
    const compiled = await compileWorkflow(codeRunWorkflow(workerHarness), {
      input: { ticketId: "TIN-12" },
      planner: plannerFor(codeRunLwir()),
    });
    const capabilityManifest = {
      ...(compiled.workflowVersion.lock.capabilityManifest as Record<string, unknown>),
    };
    delete capabilityManifest.workerHarness;
    const capabilityManifestHash = sha256Digest(capabilityManifest);
    const lockWithoutWorkerHarness = {
      ...compiled.workflowVersion.lock,
      capabilityManifest,
      capabilityManifestHash,
      validationHash: computeCompilerValidationHash({
        canonicalizer: compiled.workflowVersion.canonicalizer,
        lwirVersionId: compiled.workflowVersion.lwirVersionId,
        lwirHash: compiled.workflowVersion.lwirHash,
        requestId: compiled.workflowVersion.lock.requestId,
        requestHash: compiled.workflowVersion.lock.requestHash,
        inputHash: compiled.workflowVersion.lock.inputHash,
        plannedInputStructureHash: compiled.workflowVersion.lock.plannedInputStructureHash,
        workflowDefinitionHash: compiled.workflowVersion.lock.workflowDefinitionHash,
        inputSchemaHash: compiled.workflowVersion.lock.inputSchemaHash,
        requestedOutputHash: compiled.workflowVersion.lock.requestedOutputHash,
        capabilityManifestHash,
      }),
    };
    const identity = computeCompiledWorkflowVersionIdentity({
      canonicalizer: compiled.workflowVersion.canonicalizer,
      lwirVersionId: compiled.workflowVersion.lwirVersionId,
      lwirHash: compiled.workflowVersion.lwirHash,
      lockSeed: workflowVersionLockSeedFrom(lockWithoutWorkerHarness),
    });
    const workflowVersion = {
      ...compiled.workflowVersion,
      id: identity.workflowVersionId,
      hash: identity.workflowVersionHash,
      lock: {
        ...lockWithoutWorkerHarness,
        workflowVersionId: identity.workflowVersionId,
        workflowVersionHash: identity.workflowVersionHash,
      },
    };
    await registerStoredWorkflowVersion(world, workflowVersion);
    await appendEvent(world, "run_reuse_legacy_code_harness_candidate", {
      type: "OrchestrationRequested",
      payload: {
        requestId: compiled.request.requestId,
        requestHash: compiled.request.locks.requestHash,
        inputHash: compiled.request.locks.inputHash,
        workflowDefinitionHash: compiled.request.locks.workflowDefinitionHash,
        workflowId: "support.code-run",
      },
    });
    await appendEvent(world, "run_reuse_legacy_code_harness_candidate", {
      type: "WorkflowVersionRegistered",
      payload: {
        workflowVersionId: workflowVersion.id,
        workflowVersionHash: workflowVersion.hash,
      },
    });
    await appendEvent(world, "run_reuse_legacy_code_harness_candidate", {
      type: "RunCompleted",
      payload: {
        workflowVersionId: workflowVersion.id,
        output: { final: "ticket:TIN-12" },
      },
    });
    const reusePlanner: PlannerAdapter = {
      draft: vi.fn(async () => ({
        kind: "reuse_unchanged",
        workflowVersionId: workflowVersion.id,
        rationale: "The code step is still useful.",
        acknowledgedWarnings: [],
      })),
    };

    await expect(
      runWorkflow({
        world,
        workflows: codeRunWorkflow(),
        input: { ticketId: "TIN-13" },
        planner: reusePlanner,
        runId: "run_reuse_legacy_code_harness_blocked",
        workflowVersionReuseStrategy: "planner_reviewed",
      }),
    ).rejects.toThrow(/reuse_unchanged is blocked.*worker harness/u);
  });

  it("rejects reuse_unchanged when the planner selects a candidate that was not briefed", async () => {
    const world = await tempWorld();
    const firstInput = { ticketId: "TIN-12", body: "Cannot export invoices." };
    const secondInput = { ticketId: "TIN-13", body: "Cannot import receipts." };
    const thirdInput = { ticketId: "TIN-14", body: "Cannot sync contacts." };
    const plannerRequests: Array<Parameters<PlannerAdapter["draft"]>[0]> = [];
    const planner: PlannerAdapter = {
      draft: vi.fn(async (request) => {
        plannerRequests.push(request);
        return singleToolLwirWithStepId(`summarize_${plannerRequests.length}`);
      }),
    };
    const summarize = vi.fn<RuntimeToolHandler>((toolInput) => {
      const typed = toolInput as { ticketId: string; body: string };
      return { summary: `${typed.ticketId}:${typed.body}` };
    });
    const first = await runWorkflow({
      world,
      workflows: ticketWorkflow,
      input: firstInput,
      planner,
      tools: ticketRegistryWith(summarize),
      runId: "run_reuse_non_briefed_first",
      workflowVersionReuseStrategy: "planner_reviewed",
    });
    const second = await runWorkflow({
      world,
      workflows: ticketWorkflow,
      input: secondInput,
      planner,
      tools: ticketRegistryWith(summarize),
      runId: "run_reuse_non_briefed_second",
      workflowVersionReuseStrategy: "planner_reviewed",
    });
    const reusePlanner: PlannerAdapter = {
      draft: vi.fn(async (request) => {
        plannerRequests.push(request);
        return {
          kind: "reuse_unchanged",
          workflowVersionId: first.workflowVersionId,
          rationale: "Try to select an older unbriefed candidate.",
        };
      }),
    };

    await expect(
      runWorkflow({
        world,
        workflows: ticketWorkflow,
        input: thirdInput,
        planner: reusePlanner,
        tools: ticketRegistryWith(summarize),
        runId: "run_reuse_non_briefed_third",
        workflowVersionReuseStrategy: "planner_reviewed",
      }),
    ).rejects.toThrow(/Planner reuse decision references a missing candidate/u);
    expect(plannerRequests.at(-1)?.messages.system).toContain(second.workflowVersionId);
    expect(plannerRequests.at(-1)?.messages.system).not.toContain(first.workflowVersionId);
  });

  it("planner_reviewed adapts from the briefed WorkflowVersion and records the decision before registration", async () => {
    const world = await tempWorld();
    const firstInput = { ticketId: "TIN-12", body: "Cannot export invoices." };
    const secondInput = { ticketId: "TIN-13", body: "Cannot import receipts." };
    const planner = plannerFor(singleToolLwirWithStepId("summarize_original"));
    const summarize = vi.fn<RuntimeToolHandler>((toolInput) => {
      const typed = toolInput as { ticketId: string; body: string };
      return { summary: `${typed.ticketId}:${typed.body}` };
    });
    const first = await runWorkflow({
      world,
      workflows: ticketWorkflow,
      input: firstInput,
      planner,
      tools: ticketRegistryWith(summarize),
      runId: "run_reuse_adapt_first",
      workflowVersionReuseStrategy: "planner_reviewed",
    });
    const adaptPlanner: PlannerAdapter = {
      draft: vi.fn(async () => ({
        kind: "adapt",
        baseWorkflowVersionId: first.workflowVersionId,
        rationale: "The prior plan is close but needs a fresh step id.",
        lwir: singleToolLwirWithStepId("summarize_adapted"),
      })),
    };

    const second = await runWorkflow({
      world,
      workflows: ticketWorkflow,
      input: secondInput,
      planner: adaptPlanner,
      tools: ticketRegistryWith(summarize),
      runId: "run_reuse_adapt_second",
      workflowVersionReuseStrategy: "planner_reviewed",
    });

    expect(second.workflowVersionId).not.toBe(first.workflowVersionId);
    expect(second.output).toEqual({ summary: "TIN-13:Cannot import receipts." });
    const secondEventTypes = second.events.map((event) => event.type);
    expect(secondEventTypes.indexOf("PlannerReuseDecisionRecorded"))
      .toBeLessThan(secondEventTypes.indexOf("WorkflowVersionRegistered"));
    expect(second.events.find((event) => event.type === "PlannerReuseDecisionRecorded")?.payload)
      .toEqual(expect.objectContaining({
        decisionKind: "adapt",
        baseWorkflowVersionId: first.workflowVersionId,
        candidateWorkflowVersionId: first.workflowVersionId,
        rationale: "The prior plan is close but needs a fresh step id.",
        inputHash: sha256Digest(secondInput),
        inputStructure: concreteInputStructure(secondInput),
        candidateBriefHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
        resultingWorkflowVersionId: second.workflowVersionId,
      }));
  });

  it("repairs a partial adapt decision log without replanning or duplicating the decision", async () => {
    const world = await tempWorld();
    const firstInput = { ticketId: "TIN-12", body: "Cannot export invoices." };
    const secondInput = { ticketId: "TIN-13", body: "Cannot import receipts." };
    const summarize = vi.fn<RuntimeToolHandler>((toolInput) => {
      const typed = toolInput as { ticketId: string; body: string };
      return { summary: `${typed.ticketId}:${typed.body}` };
    });
    const first = await runWorkflow({
      world,
      workflows: ticketWorkflow,
      input: firstInput,
      planner: plannerFor(singleToolLwirWithStepId("summarize_original")),
      tools: ticketRegistryWith(summarize),
      runId: "run_partial_adapt_decision_first",
      workflowVersionReuseStrategy: "planner_reviewed",
    });
    const adaptedLwir = singleToolLwirWithStepId("summarize_adapted");
    const compiled = await compileWorkflow(ticketWorkflow, {
      input: secondInput,
      tools: ticketRegistryWith(summarize),
      planner: {
        draft: vi.fn(async () => ({
          kind: "adapt",
          baseWorkflowVersionId: first.workflowVersionId,
          rationale: "The prior plan is close but needs a fresh step id.",
          lwir: adaptedLwir,
        })),
      },
    });
    await registerStoredWorkflowVersion(world, compiled.workflowVersion);
    await appendLegacyCompiledLifecycleWithoutRegistration(
      world,
      "run_partial_adapt_decision_second",
      compiled,
    );
    await appendEvent(world, "run_partial_adapt_decision_second", {
      type: "PlannerReuseDecisionRecorded",
      payload: {
        decisionKind: "adapt",
        baseWorkflowVersionId: first.workflowVersionId,
        candidateWorkflowVersionId: first.workflowVersionId,
        rationale: "The prior plan is close but needs a fresh step id.",
        inputHash: sha256Digest(secondInput),
        inputStructure: concreteInputStructure(secondInput),
        candidateBriefHash: sha256Digest("partial adapt decision brief"),
        resultingWorkflowVersionId: compiled.workflowVersion.id,
      },
    });
    const replayPlanner: PlannerAdapter = {
      draft: vi.fn(async () => {
        throw new Error("planner should not be called while repairing partial adapt replay");
      }),
    };

    const second = await runWorkflow({
      world,
      workflows: ticketWorkflow,
      input: secondInput,
      planner: replayPlanner,
      tools: ticketRegistryWith(summarize),
      runId: "run_partial_adapt_decision_second",
      workflowVersionReuseStrategy: "planner_reviewed",
    });

    expect(replayPlanner.draft).not.toHaveBeenCalled();
    expect(second.workflowVersionId).toBe(compiled.workflowVersion.id);
    expect(second.output).toEqual({ summary: "TIN-13:Cannot import receipts." });
    const secondEvents = await listEvents(world, "run_partial_adapt_decision_second");
    expect(secondEvents.filter((event) => event.type === "PlannerReuseDecisionRecorded"))
      .toHaveLength(1);
    expect(secondEvents.map((event) => event.type)).toContain("WorkflowVersionRegistered");
    expect(secondEvents.map((event) => event.type)).toContain("RunStarted");
  });

  it("rejects adapt when the planner references a candidate that was not briefed", async () => {
    const world = await tempWorld();
    const plannerRequests: Array<Parameters<PlannerAdapter["draft"]>[0]> = [];
    const planner: PlannerAdapter = {
      draft: vi.fn(async (request) => {
        plannerRequests.push(request);
        return singleToolLwirWithStepId(`summarize_${plannerRequests.length}`);
      }),
    };
    const summarize = vi.fn<RuntimeToolHandler>((toolInput) => {
      const typed = toolInput as { ticketId: string; body: string };
      return { summary: `${typed.ticketId}:${typed.body}` };
    });
    const first = await runWorkflow({
      world,
      workflows: ticketWorkflow,
      input: { ticketId: "TIN-12", body: "Cannot export invoices." },
      planner,
      tools: ticketRegistryWith(summarize),
      runId: "run_reuse_adapt_non_briefed_first",
      workflowVersionReuseStrategy: "planner_reviewed",
    });
    const second = await runWorkflow({
      world,
      workflows: ticketWorkflow,
      input: { ticketId: "TIN-13", body: "Cannot import receipts." },
      planner,
      tools: ticketRegistryWith(summarize),
      runId: "run_reuse_adapt_non_briefed_second",
      workflowVersionReuseStrategy: "planner_reviewed",
    });
    let attemptedBaseWorkflowVersionId = first.workflowVersionId;
    const adaptPlanner: PlannerAdapter = {
      draft: vi.fn(async (request) => {
        plannerRequests.push(request);
        const system = request.messages.system ?? "";
        attemptedBaseWorkflowVersionId = system.includes(first.workflowVersionId)
          ? second.workflowVersionId
          : first.workflowVersionId;
        return {
          kind: "adapt",
          baseWorkflowVersionId: attemptedBaseWorkflowVersionId,
          rationale: "Try to adapt from an older unbriefed candidate.",
          lwir: singleToolLwirWithStepId("summarize_invalid_adapt"),
        };
      }),
    };

    await expect(
      runWorkflow({
        world,
        workflows: ticketWorkflow,
        input: { ticketId: "TIN-14", body: "Cannot sync contacts." },
        planner: adaptPlanner,
        tools: ticketRegistryWith(summarize),
        runId: "run_reuse_adapt_non_briefed_third",
        workflowVersionReuseStrategy: "planner_reviewed",
      }),
    ).rejects.toThrow(/Planner reuse decision references a missing candidate/u);
    const lastSystem = plannerRequests.at(-1)?.messages.system ?? "";
    expect(lastSystem.includes(first.workflowVersionId) || lastSystem.includes(second.workflowVersionId))
      .toBe(true);
    expect(lastSystem).not.toContain(attemptedBaseWorkflowVersionId);
  });

  it("planner_reviewed drafts fresh and records the decision before registration", async () => {
    const world = await tempWorld();
    const input = { ticketId: "TIN-12", body: "Cannot export invoices." };
    const planner = plannerFor(singleToolLwirWithStepId("summarize_original"));
    const summarize = vi.fn<RuntimeToolHandler>((toolInput) => {
      const typed = toolInput as { body: string };
      return { summary: typed.body };
    });
    const first = await runWorkflow({
      world,
      workflows: ticketWorkflow,
      input,
      planner,
      tools: ticketRegistryWith(summarize),
      runId: "run_reuse_draft_fresh_first",
      workflowVersionReuseStrategy: "planner_reviewed",
    });
    const freshPlanner: PlannerAdapter = {
      draft: vi.fn(async () => ({
        kind: "draft_fresh",
        rationale: "The old plan is not worth reusing.",
        lwir: singleToolLwirWithStepId("summarize_fresh"),
      })),
    };

    const second = await runWorkflow({
      world,
      workflows: ticketWorkflow,
      input,
      planner: freshPlanner,
      tools: ticketRegistryWith(summarize),
      runId: "run_reuse_draft_fresh_second",
      workflowVersionReuseStrategy: "planner_reviewed",
    });

    expect(second.workflowVersionId).not.toBe(first.workflowVersionId);
    const secondEventTypes = second.events.map((event) => event.type);
    expect(secondEventTypes.indexOf("PlannerReuseDecisionRecorded"))
      .toBeLessThan(secondEventTypes.indexOf("WorkflowVersionRegistered"));
    expect(second.events.find((event) => event.type === "PlannerReuseDecisionRecorded")?.payload)
      .toEqual(expect.objectContaining({
        decisionKind: "draft_fresh",
        rationale: "The old plan is not worth reusing.",
        inputHash: sha256Digest(input),
        inputStructure: concreteInputStructure(input),
        candidateBriefHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
        resultingWorkflowVersionId: second.workflowVersionId,
      }));
  });

  it("blocks reuse_unchanged output drift using the candidate lock when planning snapshot is absent", async () => {
    const world = await tempWorld();
    const input = { ticketId: "TIN-12", body: "Cannot export invoices." };
    const compiled = await compileWorkflow(ticketWorkflow, {
      input,
      tools: ticketToolRegistry,
      planner: plannerFor(singleToolLwir()),
    });
    const lockWithoutPlanningSnapshot = { ...compiled.workflowVersion.lock };
    delete (lockWithoutPlanningSnapshot as Record<string, unknown>).planningDefinitionSnapshot;
    delete (lockWithoutPlanningSnapshot as Record<string, unknown>).planningDefinitionSnapshotHash;
    const identity = computeCompiledWorkflowVersionIdentity({
      canonicalizer: compiled.workflowVersion.canonicalizer,
      lwirVersionId: compiled.workflowVersion.lwirVersionId,
      lwirHash: compiled.workflowVersion.lwirHash,
      lockSeed: workflowVersionLockSeedFrom(lockWithoutPlanningSnapshot),
    });
    const workflowVersion = {
      ...compiled.workflowVersion,
      id: identity.workflowVersionId,
      hash: identity.workflowVersionHash,
      lock: {
        ...lockWithoutPlanningSnapshot,
        workflowVersionId: identity.workflowVersionId,
        workflowVersionHash: identity.workflowVersionHash,
      },
    };
    await registerStoredWorkflowVersion(world, workflowVersion);
    await appendEvent(world, "run_reuse_no_snapshot_candidate", {
      type: "OrchestrationRequested",
      payload: {
        requestId: compiled.request.requestId,
        requestHash: compiled.request.locks.requestHash,
        inputHash: compiled.request.locks.inputHash,
        workflowDefinitionHash: compiled.request.locks.workflowDefinitionHash,
        workflowId: "support.summarize",
      },
    });
    await appendEvent(world, "run_reuse_no_snapshot_candidate", {
      type: "WorkflowVersionRegistered",
      payload: {
        workflowVersionId: workflowVersion.id,
        workflowVersionHash: workflowVersion.hash,
      },
    });
    await appendEvent(world, "run_reuse_no_snapshot_candidate", {
      type: "RunCompleted",
      payload: {
        workflowVersionId: workflowVersion.id,
        output: { summary: "Cannot export invoices." },
      },
    });
    const changedOutputWorkflow = createLittleWorkflow({
      ...ticketWorkflow,
      output: output.object({
        schema: {
          type: "object",
          required: ["summary", "severity"],
          additionalProperties: false,
          properties: {
            summary: { type: "string" },
            severity: { type: "string" },
          },
        },
      }),
    } as unknown as Parameters<typeof createLittleWorkflow>[0]);
    const reusePlanner: PlannerAdapter = {
      draft: vi.fn(async () => ({
        kind: "reuse_unchanged",
        workflowVersionId: workflowVersion.id,
        rationale: "The old executable is not enough when output changed.",
        acknowledgedWarnings: [],
      })),
    };

    await expect(
      runWorkflow({
        world,
        workflows: changedOutputWorkflow,
        input,
        planner: reusePlanner,
        tools: ticketRegistryWith(() => ({ summary: "Should not run." })),
        runId: "run_reuse_no_snapshot_output_block",
        workflowVersionReuseStrategy: "planner_reviewed",
      }),
    ).rejects.toThrow(/reuse_unchanged is blocked.*requested output/u);
  });

  it("blocks reuse_unchanged output drift using the candidate lock when planning snapshot lacks output hash", async () => {
    const world = await tempWorld();
    const input = { ticketId: "TIN-12", body: "Cannot export invoices." };
    const compiled = await compileWorkflow(ticketWorkflow, {
      input,
      tools: ticketToolRegistry,
      planner: plannerFor(singleToolLwir()),
    });
    const partialPlanningSnapshot = {
      ...(compiled.workflowVersion.lock.planningDefinitionSnapshot as Record<string, unknown>),
    };
    delete partialPlanningSnapshot.requestedOutputHash;
    const lockWithPartialPlanningSnapshot = {
      ...compiled.workflowVersion.lock,
      planningDefinitionSnapshot: partialPlanningSnapshot,
      planningDefinitionSnapshotHash: sha256Digest(partialPlanningSnapshot),
    };
    const identity = computeCompiledWorkflowVersionIdentity({
      canonicalizer: compiled.workflowVersion.canonicalizer,
      lwirVersionId: compiled.workflowVersion.lwirVersionId,
      lwirHash: compiled.workflowVersion.lwirHash,
      lockSeed: workflowVersionLockSeedFrom(lockWithPartialPlanningSnapshot),
    });
    const workflowVersion = {
      ...compiled.workflowVersion,
      id: identity.workflowVersionId,
      hash: identity.workflowVersionHash,
      lock: {
        ...lockWithPartialPlanningSnapshot,
        workflowVersionId: identity.workflowVersionId,
        workflowVersionHash: identity.workflowVersionHash,
      },
    };
    await registerStoredWorkflowVersion(world, workflowVersion);
    await appendEvent(world, "run_reuse_partial_snapshot_candidate", {
      type: "OrchestrationRequested",
      payload: {
        requestId: compiled.request.requestId,
        requestHash: compiled.request.locks.requestHash,
        inputHash: compiled.request.locks.inputHash,
        workflowDefinitionHash: compiled.request.locks.workflowDefinitionHash,
        workflowId: "support.summarize",
      },
    });
    await appendEvent(world, "run_reuse_partial_snapshot_candidate", {
      type: "WorkflowVersionRegistered",
      payload: {
        workflowVersionId: workflowVersion.id,
        workflowVersionHash: workflowVersion.hash,
      },
    });
    await appendEvent(world, "run_reuse_partial_snapshot_candidate", {
      type: "RunCompleted",
      payload: {
        workflowVersionId: workflowVersion.id,
        output: { summary: "Cannot export invoices." },
      },
    });
    const changedOutputWorkflow = createLittleWorkflow({
      ...ticketWorkflow,
      output: output.object({
        schema: {
          type: "object",
          required: ["summary", "severity"],
          additionalProperties: false,
          properties: {
            summary: { type: "string" },
            severity: { type: "string" },
          },
        },
      }),
    } as unknown as Parameters<typeof createLittleWorkflow>[0]);
    const reusePlanner: PlannerAdapter = {
      draft: vi.fn(async () => ({
        kind: "reuse_unchanged",
        workflowVersionId: workflowVersion.id,
        rationale: "The old executable is not enough when output changed.",
        acknowledgedWarnings: ["requested output hash changed"],
      })),
    };

    await expect(
      runWorkflow({
        world,
        workflows: changedOutputWorkflow,
        input,
        planner: reusePlanner,
        tools: ticketRegistryWith(() => ({ summary: "Should not run." })),
        runId: "run_reuse_partial_snapshot_output_block",
        workflowVersionReuseStrategy: "planner_reviewed",
      }),
    ).rejects.toThrow(/reuse_unchanged is blocked.*requested output/u);
  });

  it("allows reuse_unchanged with no planning snapshot when the candidate lock output hash still matches", async () => {
    const world = await tempWorld();
    const input = { ticketId: "TIN-12", body: "Cannot export invoices." };
    const compiled = await compileWorkflow(ticketWorkflow, {
      input,
      tools: ticketToolRegistry,
      planner: plannerFor(singleToolLwir()),
    });
    const lockWithoutPlanningSnapshot = { ...compiled.workflowVersion.lock };
    delete (lockWithoutPlanningSnapshot as Record<string, unknown>).planningDefinitionSnapshot;
    delete (lockWithoutPlanningSnapshot as Record<string, unknown>).planningDefinitionSnapshotHash;
    const identity = computeCompiledWorkflowVersionIdentity({
      canonicalizer: compiled.workflowVersion.canonicalizer,
      lwirVersionId: compiled.workflowVersion.lwirVersionId,
      lwirHash: compiled.workflowVersion.lwirHash,
      lockSeed: workflowVersionLockSeedFrom(lockWithoutPlanningSnapshot),
    });
    const workflowVersion = {
      ...compiled.workflowVersion,
      id: identity.workflowVersionId,
      hash: identity.workflowVersionHash,
      lock: {
        ...lockWithoutPlanningSnapshot,
        workflowVersionId: identity.workflowVersionId,
        workflowVersionHash: identity.workflowVersionHash,
      },
    };
    await registerStoredWorkflowVersion(world, workflowVersion);
    await appendEvent(world, "run_reuse_no_snapshot_matching_candidate", {
      type: "OrchestrationRequested",
      payload: {
        requestId: compiled.request.requestId,
        requestHash: compiled.request.locks.requestHash,
        inputHash: compiled.request.locks.inputHash,
        workflowDefinitionHash: compiled.request.locks.workflowDefinitionHash,
        workflowId: "support.summarize",
      },
    });
    await appendEvent(world, "run_reuse_no_snapshot_matching_candidate", {
      type: "WorkflowVersionRegistered",
      payload: {
        workflowVersionId: workflowVersion.id,
        workflowVersionHash: workflowVersion.hash,
      },
    });
    await appendEvent(world, "run_reuse_no_snapshot_matching_candidate", {
      type: "RunCompleted",
      payload: {
        workflowVersionId: workflowVersion.id,
        output: { summary: "Cannot export invoices." },
      },
    });
    const reusePlanner: PlannerAdapter = {
      draft: vi.fn(async () => ({
        kind: "reuse_unchanged",
        workflowVersionId: workflowVersion.id,
        rationale: "The output contract is unchanged.",
        acknowledgedWarnings: [],
      })),
    };

    const result = await runWorkflow({
      world,
      workflows: ticketWorkflow,
      input,
      planner: reusePlanner,
      tools: ticketRegistryWith(() => ({ summary: "Cannot export invoices." })),
      runId: "run_reuse_no_snapshot_output_allowed",
      workflowVersionReuseStrategy: "planner_reviewed",
    });

    expect(result.workflowVersionId).toBe(workflowVersion.id);
    expect(result.events.find((event) => event.type === "PlannerReuseDecisionRecorded")?.payload)
      .toEqual(expect.objectContaining({
        decisionKind: "reuse_unchanged",
        candidateWorkflowVersionId: workflowVersion.id,
      }));
  });

  it("compiles, registers, and runs a workflow through the alpha entrypoint", async () => {
    const world = await tempWorld();
    const summarize = vi.fn<RuntimeToolHandler>((input) => {
      expect(input).toEqual({ ticketId: "TIN-12", body: "Cannot export invoices." });
      return { summary: "Cannot export invoices." };
    });
    const planner = plannerFor(singleToolLwir());

    const result = await runWorkflow({
      world,
      workflows: ticketWorkflow,
      input: { ticketId: "TIN-12", body: "Cannot export invoices." },
      planner,
      tools: ticketRegistryWith(summarize),
      runId: "run_public_entrypoint",
    });

    expect(result.status).toBe("completed");
    expect(result.output).toEqual({ summary: "Cannot export invoices." });
    expect(result.runId).toBe("run_public_entrypoint");
    expect(result.workflowVersionId).toMatch(/^wfver_/u);
    // No model calls, so $0 is a genuine zero (unpricedCalls === 0), not a silent
    // under-report of work that could not be priced.
    expect(result.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      costUsd: 0,
      pricedCalls: 0,
      unpricedCalls: 0,
    });
    expect(result.events.map((event) => event.type)).toEqual([
      "OrchestrationRequested",
      "PlannerStarted",
      "PlannerDraftedWorkflow",
      "WorkflowValidationSucceeded",
      "WorkflowVersionRegistered",
      "RunStarted",
      "StepScheduled",
      "StepAttemptStarted",
      "harness.session.started",
      "harness.execute_step.started",
      "harness.tool_call.started",
      "harness.tool_call.succeeded",
      "harness.execute_step.succeeded",
      "harness.session.completed",
      "ArtifactCreated",
      "StepOutputValidated",
      "StepCompleted",
      "RunCompleted",
    ]);
    expect(result.events.find((event) => event.type === "OrchestrationRequested")?.payload)
      .toEqual(expect.objectContaining({
        requestId: expect.stringMatching(/^orq_/u),
        requestHash: expect.any(String),
        inputHash: expect.any(String),
        workflowDefinitionHash: expect.any(String),
        workflowId: "support.summarize",
      }));
    expect(result.events.find((event) => event.type === "PlannerDraftedWorkflow")?.payload)
      .toEqual(expect.objectContaining({
        revision: 1,
        valid: true,
        lwirHash: expect.any(String),
      }));
    expect(result.events.find((event) => event.type === "WorkflowValidationSucceeded")?.payload)
      .toEqual(expect.objectContaining({
        revision: 1,
        workflowVersionId: result.workflowVersionId,
        validationHash: expect.any(String),
      }));
    expect(result.events.find((event) => event.type === "WorkflowVersionRegistered")?.payload)
      .toEqual(expect.objectContaining({
        workflowVersionId: result.workflowVersionId,
        workflowVersionHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
        lwirVersionId: expect.stringMatching(/^wfver_[0-9a-f]{16}$/u),
        lwirHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
        requestId: expect.stringMatching(/^orq_/u),
        requestHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
        inputHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
        plannedInputStructure: concreteInputStructure({
          ticketId: "TIN-12",
          body: "Cannot export invoices.",
        }),
        plannedInputStructureHash: concreteInputStructureHash({
          ticketId: "TIN-12",
          body: "Cannot export invoices.",
        }),
        workflowDefinitionHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
        inputSchemaHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
        requestedOutputHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
        capabilityManifestHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
        planningDefinitionSnapshotHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
        validationHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      }));
    const registrationPayload = result.events.find((event) =>
      event.type === "WorkflowVersionRegistered"
    )?.payload;
    const storedVersion = await readStoredWorkflowVersion(world, result.workflowVersionId);
    expect(storedVersion.id).toBe(result.workflowVersionId);
    expect(storedVersion.hash).toBe(registrationPayload?.workflowVersionHash);
    expect(storedVersion.lock?.planningDefinitionSnapshotHash).toBe(
      registrationPayload?.planningDefinitionSnapshotHash,
    );
    const expectedStepSchemaHash = sha256Digest(ticketOutputSchema);
    const stepOutputValidated = result.events.find((event) => event.type === "StepOutputValidated");
    const stepCompleted = result.events.find((event) => event.type === "StepCompleted");
    expect(stepOutputValidated?.payload)
      .toEqual(expect.objectContaining({
        stepPath: "summarize",
        outputMode: "object",
        schemaHash: expectedStepSchemaHash,
      }));
    expect(stepCompleted?.payload)
      .toEqual(expect.objectContaining({
        stepPath: "summarize",
        metadata: expect.objectContaining({
          outputMode: "object",
          schemaHash: expectedStepSchemaHash,
        }),
      }));
    expect((stepCompleted?.payload.metadata as Record<string, unknown> | undefined)?.schemaHash)
      .toBe(stepOutputValidated?.payload.schemaHash);
    expect(result.artifacts).toHaveLength(1);
    expect(summarize).toHaveBeenCalledTimes(1);
    expect(planner.draft).toHaveBeenCalledTimes(1);
  });

  it("compiles through workflow.planner harness when planner adapter is omitted", async () => {
    const world = await tempWorld();
    const summarize = vi.fn<RuntimeToolHandler>((input) => {
      expect(input).toEqual({ ticketId: "TIN-13", body: "Missing permissions." });
      return { summary: "Missing permissions." };
    });
    const plannerHarnessRun = vi.fn<Harness["run"]>(async (task, ctx) => {
      expect(task.kind).toBe("plan");
      if (task.kind !== "plan") {
        throw new Error("expected plan task");
      }
      expect(task.workflowSnapshot.id).toBe("support.summarize");
      expect(ctx.scope.role).toBe("planner");
      return { kind: "plan", lwir: singleToolLwir() };
    });
    const workflowWithPlannerHarness = createLittleWorkflow({
      ...ticketWorkflow,
      planner: {
        model: { provider: "test", modelId: "planner-harness" },
        harness: {
          harnessId: "plannerHarness@1.0.0",
          run: plannerHarnessRun,
        },
        system: "Plan through harness.",
      },
    });

    const result = await runWorkflow({
      world,
      workflows: workflowWithPlannerHarness,
      input: { ticketId: "TIN-13", body: "Missing permissions." },
      tools: ticketRegistryWith(summarize),
      runId: "run_workflow_planner_harness",
    });

    expect(result.status).toBe("completed");
    expect(result.output).toEqual({ summary: "Missing permissions." });
    expect(plannerHarnessRun).toHaveBeenCalledTimes(1);
  });

  it("mounts advertised planner reuse detail files for bash harness planners", async () => {
    const world = await tempWorld();
    const summarize = vi.fn<RuntimeToolHandler>((input) => {
      const typed = input as { body: string };
      return { summary: typed.body };
    });
    const aiLoop = {
      generate: vi
        .fn()
        .mockResolvedValueOnce({ output: { lwir: singleToolLwirWithStepId("summarize_first") } })
        .mockResolvedValueOnce({
          toolCalls: [
            {
              toolName: "bash",
              args: {
                cmd: [
                  "cat /planner/reuse/*/lwir.json >/dev/null",
                  "cat /planner/reuse/*/lock.json >/dev/null",
                  "cat /planner/reuse/*/planning-definition-snapshot.json >/dev/null",
                  "cat /planner/reuse/*/prior-input-summary.md >/dev/null",
                  "cat /planner/reuse/*/prior-output-summary.md >/dev/null",
                  "cat /planner/reuse/*/feedback-summary.md >/dev/null",
                  "printf reuse-details-readable",
                ].join(" && "),
              },
            },
          ],
        })
        .mockResolvedValueOnce({ output: { lwir: singleToolLwirWithStepId("summarize_second") } }),
    };
    const workflowWithBashPlanner = createLittleWorkflow({
      ...ticketWorkflow,
      planner: {
        model: { provider: "test", modelId: "planner-harness" },
        harness: createWorkflowHarness({ aiLoop }),
      },
    });

    const first = await runWorkflowPublic({
      world,
      workflows: workflowWithBashPlanner,
      input: { ticketId: "TIN-12", body: "Cannot export invoices." },
      tools: ticketRegistryWith(summarize),
      runId: "run_reuse_mount_first",
      workflowVersionReuseStrategy: "planner_reviewed",
    });
    const second = await runWorkflowPublic({
      world,
      workflows: workflowWithBashPlanner,
      input: { ticketId: "TIN-13", body: "Cannot import receipts." },
      tools: ticketRegistryWith(summarize),
      runId: "run_reuse_mount_second",
      workflowVersionReuseStrategy: "planner_reviewed",
    });

    expect(first.workflowVersionId).not.toBe(second.workflowVersionId);
    expect(aiLoop.generate).toHaveBeenCalledTimes(3);
    const toolSucceeded = second.events.find((event) => event.type === "harness.tool_call.succeeded");
    expect(toolSucceeded?.payload).toEqual(expect.objectContaining({
      result: expect.objectContaining({
        stdout: "reuse-details-readable",
        exitCode: 0,
      }),
    }));
    expect(aiLoop.generate.mock.calls[1]?.[0].system).toContain(
      `/planner/reuse/${first.workflowVersionId}/lwir.json`,
    );
  });

  it("supports maxOuterCycles via workflow.planner.supervise in public runWorkflow", async () => {
    const world = await tempWorld();
    const summarize = vi.fn<RuntimeToolHandler>((input) => {
      const typed = input as { body: string };
      return { summary: typed.body };
    });
    const plannerHarnessRun = vi.fn<Harness["run"]>(async (task) => {
      if (task.kind !== "plan") {
        return { kind: "delegate_to_default" };
      }
      return { kind: "plan", lwir: singleToolLwir() };
    });
    const plannerHarness = {
      harnessId: "plannerHarness@1.0.0",
      run: plannerHarnessRun,
    } satisfies Harness & { readonly harnessId: string };
    const supervise = vi.fn(
      async (state: SuperviseOuterLoopState): Promise<SuperviseDecision> => {
        return state.cycles.length < 2
          ? { kind: "continue", promptNote: "Retry with tighter rubric." }
          : { kind: "done", finalOutput: { summary: "outer-final" } };
      },
    );
    const workflowWithPlannerHarness = createLittleWorkflow({
      ...ticketWorkflow,
      planner: {
        model: { provider: "test", modelId: "planner-harness" },
        harness: plannerHarness,
        supervise,
      },
    });

    const result = await runWorkflowPublic({
      world,
      workflows: workflowWithPlannerHarness,
      input: { ticketId: "TIN-13", body: "Missing permissions." },
      tools: ticketRegistryWith(summarize),
      maxOuterCycles: 3,
      outerLoopId: "ol_public_planner_supervise",
    });

    expect(result.status).toBe("completed");
    expect(result.output).toEqual({ summary: "outer-final" });
    expect(plannerHarnessRun).toHaveBeenCalledTimes(2);
    expect(summarize).toHaveBeenCalledTimes(2);
    expect(supervise).toHaveBeenCalledTimes(2);
    expect(result.events.map((event) => event.type)).toContain("OuterLoopCycleCompleted");

    const events = await listEvents(world, result.runId);
    expect(events.filter((event) => event.type === "OuterLoopCycleCompleted")).toHaveLength(1);
  });

  it("completes and records warnings when planner and worker remote skills are unavailable", async () => {
    const world = await tempWorld();
    const remote = `${pathToFileURL(join(world.dataDir, "missing-skills")).href}#${"a".repeat(40)}`;
    const seenPlannerSkills: unknown[][] = [];
    const seenWorkerSkills: unknown[][] = [];
    const plannerHarness = {
      harnessId: "plannerHarness@1.0.0",
      run: vi.fn<Harness["run"]>(async (task, ctx) => {
        seenPlannerSkills.push([...ctx.skills]);
        if (task.kind !== "plan") {
          return { kind: "delegate_to_default" };
        }
        return { kind: "plan", lwir: singleToolLwir() };
      }),
    } satisfies Harness & { readonly harnessId: string };
    const workerHarness = {
      harnessId: "workerHarness@1.0.0",
      run: vi.fn<Harness["run"]>(async (task, ctx) => {
        seenWorkerSkills.push([...ctx.skills]);
        if (task.kind !== "execute_step") {
          return { kind: "delegate_to_default" };
        }
        return { kind: "execute_step", output: { summary: "soft-failed skills" }, artifactRefs: [] };
      }),
    } satisfies Harness & { readonly harnessId: string };
    const workflowWithRemoteSkills = createLittleWorkflow({
      ...ticketWorkflow,
      planner: {
        model: { provider: "test", modelId: "planner-harness" },
        harness: plannerHarness,
        skills: [skill(remote, { skills: ["planner-guide"] })],
      },
      worker: {
        harness: workerHarness,
        skills: [skill(remote, { skills: ["worker-guide"] })],
      },
    } as unknown as Parameters<typeof createLittleWorkflow>[0]);

    const result = await runWorkflowPublic({
      world,
      workflows: workflowWithRemoteSkills,
      input: { ticketId: "TIN-13", body: "Missing permissions." },
      tools: ticketToolRegistry,
      runId: "run_public_remote_skill_soft_fail",
    });

    expect(result.status).toBe("completed");
    expect(result.output).toEqual({ summary: "soft-failed skills" });
    expect(seenPlannerSkills).toEqual([[]]);
    expect(seenWorkerSkills).toEqual([[]]);
    const started = (await listEvents(world, result.runId))
      .filter((event) => event.type === "harness.session.started");
    expect(started).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          role: "planner",
          warnings: [
            expect.objectContaining({
              code: "policy_warning",
              metadata: expect.objectContaining({
                reason: "remote_skill_unavailable",
                source: remote,
              }),
            }),
          ],
        }),
      }),
      expect.objectContaining({
        payload: expect.objectContaining({
          role: "worker.tool-call",
          warnings: [
            expect.objectContaining({
              code: "policy_warning",
              metadata: expect.objectContaining({
                reason: "remote_skill_unavailable",
                source: remote,
              }),
            }),
          ],
        }),
      }),
    ]);
  });

  it("forwards call-level always_fresh into outer-loop cycle compiles", async () => {
    const world = await tempWorld();
    const summarize = vi.fn<RuntimeToolHandler>((input) => {
      const typed = input as { body: string };
      return { summary: typed.body };
    });
    const plannerTasks: Extract<HarnessTask, { readonly kind: "plan" }>[] = [];
    const plannerHarnessRun = vi.fn<Harness["run"]>(async (task) => {
      if (task.kind !== "plan") {
        return { kind: "delegate_to_default" };
      }
      plannerTasks.push(task);
      return { kind: "plan", lwir: singleToolLwirWithStepId(`outer_${plannerTasks.length}`) };
    });
    const supervise = vi.fn(
      async (state: SuperviseOuterLoopState): Promise<SuperviseDecision> => {
        return state.cycles.length < 2
          ? { kind: "continue", promptNote: "Retry with tighter rubric." }
          : { kind: "done", finalOutput: { summary: "outer-final" } };
      },
    );
    const workflowWithPlannerHarness = createLittleWorkflow({
      ...ticketWorkflow,
      workflowVersionReuseStrategy: "planner_reviewed",
      planner: {
        model: { provider: "test", modelId: "planner-harness" },
        harness: {
          harnessId: "plannerHarness@1.0.0",
          run: plannerHarnessRun,
        },
        supervise,
      },
    });

    const result = await runWorkflowPublic({
      world,
      workflows: workflowWithPlannerHarness,
      input: { ticketId: "TIN-13", body: "Missing permissions." },
      tools: ticketRegistryWith(summarize),
      maxOuterCycles: 3,
      outerLoopId: "ol_public_always_fresh_overrides_workflow_reuse",
      workflowVersionReuseStrategy: "always_fresh",
    });

    expect(result.status).toBe("completed");
    expect(plannerHarnessRun).toHaveBeenCalledTimes(2);
    expect(plannerTasks[1]?.systemMessage).toContain("Retry with tighter rubric.");
    expect(plannerTasks[1]?.systemMessage ?? "").not.toContain("Candidate WorkflowVersion");
  });

  it("honors timeout on public outer-loop runs that use workflow.planner.supervise", async () => {
    const world = await tempWorld();
    const releasePlan = deferred<void>();
    const summarize = vi.fn<RuntimeToolHandler>(() => ({ summary: "should-not-run" }));
    const plannerHarnessRun = vi.fn<Harness["run"]>(async (task) => {
      if (task.kind !== "plan") {
        return { kind: "delegate_to_default" };
      }
      await releasePlan.promise;
      return { kind: "plan", lwir: singleToolLwir() };
    });
    const plannerHarness = {
      harnessId: "plannerHarness@1.0.0",
      run: plannerHarnessRun,
    } satisfies Harness & { readonly harnessId: string };
    const supervise = vi.fn(async (): Promise<SuperviseDecision> => ({
      kind: "done",
      finalOutput: { summary: "unused" },
    }));
    const workflowWithPlannerHarness = createLittleWorkflow({
      ...ticketWorkflow,
      planner: {
        model: { provider: "test", modelId: "planner-harness" },
        harness: plannerHarness,
        supervise,
      },
    });

    const releaseTimer = setTimeout(() => releasePlan.resolve(), 50);
    await expect(
      runWorkflowPublic({
        world,
        workflows: workflowWithPlannerHarness,
        input: { ticketId: "TIN-13", body: "Missing permissions." },
        tools: ticketRegistryWith(summarize),
        maxOuterCycles: 2,
        outerLoopId: "ol_public_planner_timeout",
        timeout: 10,
      }),
    ).rejects.toMatchObject({
      name: "RunFailedError",
      causeCode: "timeout",
    });
    clearTimeout(releaseTimer);
    releasePlan.resolve();
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(summarize).not.toHaveBeenCalled();
    expect(supervise).not.toHaveBeenCalled();
  });

  it("honors cancellation signals on public outer-loop runs that use workflow.planner.supervise", async () => {
    const world = await tempWorld();
    const summarize = vi.fn<RuntimeToolHandler>(() => ({ summary: "should-not-run" }));
    const plannerHarnessRun = vi.fn<Harness["run"]>(async (task) => {
      if (task.kind !== "plan") {
        return { kind: "delegate_to_default" };
      }
      return { kind: "plan", lwir: singleToolLwir() };
    });
    const plannerHarness = {
      harnessId: "plannerHarness@1.0.0",
      run: plannerHarnessRun,
    } satisfies Harness & { readonly harnessId: string };
    const supervise = vi.fn(async (): Promise<SuperviseDecision> => ({
      kind: "done",
      finalOutput: { summary: "unused" },
    }));
    const workflowWithPlannerHarness = createLittleWorkflow({
      ...ticketWorkflow,
      planner: {
        model: { provider: "test", modelId: "planner-harness" },
        harness: plannerHarness,
        supervise,
      },
    });
    const controller = new AbortController();
    controller.abort(new Error("cancel before run"));

    await expect(
      runWorkflowPublic({
        world,
        workflows: workflowWithPlannerHarness,
        input: { ticketId: "TIN-13", body: "Missing permissions." },
        tools: ticketRegistryWith(summarize),
        maxOuterCycles: 2,
        outerLoopId: "ol_public_planner_cancelled",
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({
      name: "RunFailedError",
      causeCode: "cancelled",
    });

    expect(plannerHarnessRun).not.toHaveBeenCalled();
    expect(summarize).not.toHaveBeenCalled();
    expect(supervise).not.toHaveBeenCalled();
  });

  it("times out when planner.supervise hangs in public outer-loop runs", async () => {
    const world = await tempWorld();
    const releaseSupervise = deferred<void>();
    const summarize = vi.fn<RuntimeToolHandler>(() => ({ summary: "done" }));
    const plannerHarness = {
      harnessId: "plannerHarness@1.0.0",
      run: vi.fn<Harness["run"]>(async (task) => {
        if (task.kind !== "plan") {
          return { kind: "delegate_to_default" };
        }
        return { kind: "plan", lwir: singleToolLwir() };
      }),
    } satisfies Harness & { readonly harnessId: string };
    const supervise = vi.fn(async (): Promise<SuperviseDecision> => {
      await releaseSupervise.promise;
      return { kind: "done", finalOutput: { summary: "should-not-reach" } };
    });
    const workflowWithPlannerHarness = createLittleWorkflow({
      ...ticketWorkflow,
      planner: {
        model: { provider: "test", modelId: "planner-harness" },
        harness: plannerHarness,
        supervise,
      },
    });

    await expect(
      runWorkflowPublic({
        world,
        workflows: workflowWithPlannerHarness,
        input: { ticketId: "TIN-13", body: "Missing permissions." },
        tools: ticketRegistryWith(summarize),
        maxOuterCycles: 2,
        outerLoopId: "ol_public_supervise_timeout",
        timeout: 2000,
      }),
    ).rejects.toMatchObject({
      name: "RunFailedError",
      causeCode: "timeout",
    });

    releaseSupervise.resolve();
  });

  it("rejects public runWorkflow when workflow.planner is missing", async () => {
    const world = await tempWorld();
    const summarize = vi.fn<RuntimeToolHandler>(() => ({ summary: "unused" }));

    await expect(
      runWorkflowPublic({
        world,
        workflows: ticketWorkflow,
        input: { ticketId: "TIN-13", body: "Missing permissions." },
        tools: ticketRegistryWith(summarize),
        runId: "run_workflow_reject_legacy_top_level_planner",
      }),
    ).rejects.toThrow(/workflow\.planner/u);

    expect(summarize).not.toHaveBeenCalled();
  });

  it("replays completed outer-loop manifests without requiring workflow.planner.supervise", async () => {
    const world = await tempWorld();
    const summarize = vi.fn<RuntimeToolHandler>(() => ({ summary: "unused" }));
    const plannerHarnessRun = vi.fn<Harness["run"]>(async (task) => {
      if (task.kind !== "plan") {
        return { kind: "delegate_to_default" };
      }
      return { kind: "plan", lwir: singleToolLwir() };
    });
    const workflowWithPlannerHarness = createLittleWorkflow({
      ...ticketWorkflow,
      planner: {
        model: { provider: "test", modelId: "planner-harness" },
        harness: {
          harnessId: "plannerHarness@1.0.0",
          run: plannerHarnessRun,
        },
      },
    });
    const tools = ticketRegistryWith(summarize);
    const outerLoopId = "ol_public_replay_done_without_supervise";
    await writeOuterLoopManifest(world, outerLoopId, {
      outerLoopId,
      goal: {
        workflowDefinitionHash: getWorkflowDefinitionHash(workflowWithPlannerHarness, tools),
        description: workflowWithPlannerHarness.description ?? workflowWithPlannerHarness.id,
      },
      maxCycles: 3,
      cycles: [
        {
          cycleNumber: 1,
          runId: "run_public_replay_done_without_supervise_cycle_1",
          workflowVersionId: "wfver_replayed",
          status: "completed",
          output: { summary: "cached-output" },
        },
      ],
      result: { kind: "done", finalOutput: { summary: "from-manifest" } },
    });

    const result = await runWorkflowPublic({
      world,
      workflows: workflowWithPlannerHarness,
      input: { ticketId: "TIN-13", body: "Missing permissions." },
      tools,
      maxOuterCycles: 3,
      outerLoopId,
    });

    expect(result.status).toBe("completed");
    expect(result.output).toEqual({ summary: "from-manifest" });
    expect(plannerHarnessRun).not.toHaveBeenCalled();
    expect(summarize).not.toHaveBeenCalled();
  });

  it("replays completed outer-loop manifests without requiring workflow.planner.harness", async () => {
    const world = await tempWorld();
    const summarize = vi.fn<RuntimeToolHandler>(() => ({ summary: "unused" }));
    const tools = ticketRegistryWith(summarize);
    const outerLoopId = "ol_public_replay_done_without_planner_harness";
    await writeOuterLoopManifest(world, outerLoopId, {
      outerLoopId,
      goal: {
        workflowDefinitionHash: getWorkflowDefinitionHash(ticketWorkflow, tools),
        description: ticketWorkflow.description ?? ticketWorkflow.id,
      },
      maxCycles: 3,
      cycles: [
        {
          cycleNumber: 1,
          runId: "run_public_replay_done_without_planner_harness_cycle_1",
          workflowVersionId: "wfver_replayed",
          status: "completed",
          output: { summary: "cached-output" },
        },
      ],
      result: { kind: "done", finalOutput: { summary: "from-manifest-no-harness" } },
    });

    const result = await runWorkflowPublic({
      world,
      workflows: ticketWorkflow,
      input: { ticketId: "TIN-13", body: "Missing permissions." },
      tools,
      maxOuterCycles: 3,
      outerLoopId,
    });

    expect(result.status).toBe("completed");
    expect(result.output).toEqual({ summary: "from-manifest-no-harness" });
    expect(summarize).not.toHaveBeenCalled();
  });

  it("rejects outer-loop runs without supervise when outerLoopId has no manifest", async () => {
    const world = await tempWorld();
    const summarize = vi.fn<RuntimeToolHandler>(() => ({ summary: "unused" }));

    await expect(
      runWorkflowPublic({
        world,
        workflows: ticketWorkflow,
        input: { ticketId: "TIN-13", body: "Missing permissions." },
        tools: ticketRegistryWith(summarize),
        maxOuterCycles: 3,
        outerLoopId: "ol_public_missing_manifest_without_supervise",
      }),
    ).rejects.toMatchObject({
      name: "RunFailedError",
      causeCode: "runtime_config_error",
    });

    expect(summarize).not.toHaveBeenCalled();
  });

  it("rejects outer-loop runs without supervise when outerLoopId manifest is not done", async () => {
    const world = await tempWorld();
    const summarize = vi.fn<RuntimeToolHandler>(() => ({ summary: "unused" }));
    const tools = ticketRegistryWith(summarize);
    const outerLoopId = "ol_public_manifest_not_done_without_supervise";
    await writeOuterLoopManifest(world, outerLoopId, {
      outerLoopId,
      goal: {
        workflowDefinitionHash: getWorkflowDefinitionHash(ticketWorkflow, tools),
        description: ticketWorkflow.description ?? ticketWorkflow.id,
      },
      maxCycles: 3,
      cycles: [
        {
          cycleNumber: 1,
          runId: "run_public_manifest_not_done_without_supervise_cycle_1",
          workflowVersionId: "wfver_replayed",
          status: "completed",
          output: { summary: "cached-output" },
        },
      ],
    });

    await expect(
      runWorkflowPublic({
        world,
        workflows: ticketWorkflow,
        input: { ticketId: "TIN-13", body: "Missing permissions." },
        tools,
        maxOuterCycles: 3,
        outerLoopId,
      }),
    ).rejects.toMatchObject({
      name: "RunFailedError",
      causeCode: "runtime_config_error",
    });

    expect(summarize).not.toHaveBeenCalled();
  });

  it("rejects corrupted done manifests where cycles are empty", async () => {
    const world = await tempWorld();
    const summarize = vi.fn<RuntimeToolHandler>(() => ({ summary: "unused" }));
    const tools = ticketRegistryWith(summarize);
    const outerLoopId = "ol_public_manifest_done_without_cycles";
    await writeOuterLoopManifest(world, outerLoopId, {
      outerLoopId,
      goal: {
        workflowDefinitionHash: getWorkflowDefinitionHash(ticketWorkflow, tools),
        description: ticketWorkflow.description ?? ticketWorkflow.id,
      },
      maxCycles: 3,
      cycles: [],
      result: { kind: "done", finalOutput: { summary: "invalid" } },
    });

    await expect(
      runWorkflowPublic({
        world,
        workflows: ticketWorkflow,
        input: { ticketId: "TIN-13", body: "Missing permissions." },
        tools,
        maxOuterCycles: 3,
        outerLoopId,
      }),
    ).rejects.toMatchObject({
      name: "RunFailedError",
      causeCode: "runtime_config_error",
      message: expect.stringContaining("outer_loop_manifest_corrupt"),
    });

    expect(summarize).not.toHaveBeenCalled();
  });

  it("rejects legacy top-level planner adapters even when workflow.planner is configured", async () => {
    const world = await tempWorld();
    const summarize = vi.fn<RuntimeToolHandler>(() => ({ summary: "unused" }));
    const workflowWithPlannerHarness = createLittleWorkflow({
      ...ticketWorkflow,
      planner: {
        model: { provider: "test", modelId: "planner-harness" },
        harness: {
          harnessId: "plannerHarness@1.0.0",
          run: async (task) => {
            if (task.kind !== "plan") {
              return { kind: "delegate_to_default" };
            }
            return { kind: "plan", lwir: singleToolLwir() };
          },
        },
      },
    });

    await expect(
      runWorkflowPublic({
        world,
        workflows: workflowWithPlannerHarness,
        input: { ticketId: "TIN-13", body: "Missing permissions." },
        planner: plannerFor(singleToolLwir()),
        tools: ticketRegistryWith(summarize),
        runId: "run_workflow_reject_legacy_top_level_planner_with_workflow_planner",
      } as unknown as RunWorkflowOptions<typeof workflowWithPlannerHarness>),
    ).rejects.toThrow(/top-level planner/u);

    expect(summarize).not.toHaveBeenCalled();
  });

  it("requires workflow.models in public runWorkflow calls", async () => {
    const world = await tempWorld();
    const summarize = vi.fn<RuntimeToolHandler>(() => ({ summary: "unused" }));
    const missingModelsPlannerHarness = {
      harnessId: "plannerHarness@1.0.0",
      run: async (task: HarnessTask) => {
        if (task.kind !== "plan") {
          return { kind: "delegate_to_default" };
        }
        return { kind: "plan", lwir: singleToolLwir() };
      },
    } satisfies Harness & { readonly harnessId: string };
    const workflowWithoutModels = createLittleWorkflow({
      id: "support.missing-models",
      description: "Missing models should be rejected by public API runs.",
      inputSchema: ticketInputSchema,
      output: output.object({ schema: ticketOutputSchema }),
      planner: {
        model: { provider: "test", modelId: "planner-harness" },
        harness: missingModelsPlannerHarness,
      },
      globalTools: ["summarize"],
    } as unknown as Parameters<typeof createLittleWorkflow>[0]);

    await expect(
      runWorkflowPublic({
        world,
        workflows: workflowWithoutModels,
        input: { ticketId: "TIN-13", body: "Missing models." },
        tools: ticketRegistryWith(summarize),
        runId: "run_workflow_reject_missing_models",
      }),
    ).rejects.toThrow(/workflow\.models/u);
    expect(summarize).not.toHaveBeenCalled();
  });

  it("does not append late planner harness completion after timeout", async () => {
    const world = await tempWorld();
    const releasePlan = deferred<void>();
    const summarize = vi.fn<RuntimeToolHandler>(() => ({ summary: "should not run" }));
    const plannerHarnessRun = vi.fn<Harness["run"]>(async (task) => {
      if (task.kind !== "plan") {
        return { kind: "delegate_to_default" };
      }
      await releasePlan.promise;
      return { kind: "plan", lwir: singleToolLwir() };
    });
    const workflowWithPlannerHarness = createLittleWorkflow({
      ...ticketWorkflow,
      planner: {
        model: { provider: "test", modelId: "planner-harness" },
        harness: {
          harnessId: "plannerHarness@1.0.0",
          run: plannerHarnessRun,
        },
      },
    });

    await expect(
      runWorkflow({
        world,
        workflows: workflowWithPlannerHarness,
        input: { ticketId: "TIN-13", body: "Missing permissions." },
        tools: ticketRegistryWith(summarize),
        runId: "run_workflow_planner_harness_timeout",
        timeout: 1,
      }),
    ).rejects.toMatchObject({
      name: "RunFailedError",
      runId: "run_workflow_planner_harness_timeout",
      causeCode: "timeout",
    });

    releasePlan.resolve();
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(summarize).not.toHaveBeenCalled();
    const events = await listEvents(world, "run_workflow_planner_harness_timeout");
    expect(events.some((event) => event.type === "harness.session.completed")).toBe(false);
  });

  it("orchestrator runs workflow arrays through an orchestrate harness session", async () => {
    const world = await tempWorld();
    const summarize = vi.fn<RuntimeToolHandler>((input) => {
      const typed = input as { ticketId: string; body: string };
      return { summary: `${typed.ticketId}:${typed.body}` };
    });
    const plannerHarness = {
      harnessId: "plannerHarness@1.0.0",
      run: vi.fn<Harness["run"]>(async (task) => {
        if (task.kind !== "plan") {
          return { kind: "delegate_to_default" };
        }
        return { kind: "plan", lwir: singleToolLwir() };
      }),
    } satisfies Harness & { readonly harnessId: string };
    const orchestratorHarness = {
      harnessId: "orchestratorHarness@1.0.0",
      run: vi.fn<Harness["run"]>(async (task, ctx) => {
        if (task.kind !== "orchestrate") {
          return { kind: "delegate_to_default" };
        }
        await ctx.durability.append({
          type: "harness.model.responded",
          runId: ctx.session.runId,
          payload: {
            turn: 1,
            response: {
              text: "orchestrating",
              usage: { inputTokens: 2, outputTokens: 3 },
            },
          },
        });
        const start = ctx.tools.start_workflow as { execute?: (input: unknown) => Promise<unknown> };
        if (typeof start?.execute !== "function") {
          throw new Error("start_workflow tool missing from orchestrator context.");
        }
        const started = await start.execute({
          workflowId: "support.summarize",
          input: { ticketId: "TIN-O1", body: "Need orchestrator help." },
        });
        return { kind: "orchestrate", output: started };
      }),
    } satisfies Harness & { readonly harnessId: string };
    const workflowWithPlannerHarness = createLittleWorkflow({
      ...ticketWorkflow,
      planner: {
        model: { provider: "test", modelId: "planner-model" },
        harness: plannerHarness,
      },
    });

    const result = await runWorkflow({
      world,
      workflows: [workflowWithPlannerHarness],
      orchestrator: {
        model: { provider: "test", modelId: "orchestrator-model" },
        harness: orchestratorHarness,
      },
      input: { request: "run one summarized workflow" },
      tools: ticketRegistryWith(summarize),
      runId: "run_orchestrator_entrypoint",
    });

    expect(result.status).toBe("completed");
    // The orchestrator harness records a model call but no model identity, so the call
    // is counted in tokens and reported as unpriced — a null cost, never a fake $0.
    expect(result.usage).toEqual({
      inputTokens: 2,
      outputTokens: 3,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      costUsd: null,
      pricedCalls: 0,
      unpricedCalls: 1,
    });
    expect(orchestratorHarness.run).toHaveBeenCalledTimes(1);
    const orchestratorOutput = result.output as {
      workflowVersionId: string;
      runId: string;
      status: "completed" | "failed";
      output?: unknown;
    };
    expect(orchestratorOutput.status).toBe("completed");
    expect(orchestratorOutput.output).toEqual({ summary: "TIN-O1:Need orchestrator help." });

    const rootEvents = await listEvents(world, "run_orchestrator_entrypoint");
    expect(rootEvents.map((event) => event.type)).not.toContain("HarnessSessionStarted");
    expect(rootEvents.map((event) => event.type)).not.toContain("HarnessSessionCompleted");
    expect(rootEvents.find((event) =>
      event.type === "harness.session.started" && event.payload.role === "orchestrator"
    )).toBeDefined();
    const completed = rootEvents.find((event) =>
      event.type === "harness.session.completed" && event.payload.runId === "run_orchestrator_entrypoint"
    );
    expect((completed?.payload.output as { result?: { kind?: string } } | undefined)?.result?.kind)
      .toBe("orchestrate");

    const subRunEvents = await listEvents(world, orchestratorOutput.runId);
    expect(subRunEvents.map((event) => event.type)).toContain("RunCompleted");
  });

  it("falls back to workflowHarness when an orchestrator harness delegates", async () => {
    const world = await tempWorld();
    const summarize = vi.fn<RuntimeToolHandler>((input) => {
      const typed = input as { ticketId: string; body: string };
      return { summary: `${typed.ticketId}:${typed.body}` };
    });
    const plannerHarness = {
      harnessId: "plannerHarness@1.0.0",
      run: vi.fn<Harness["run"]>(async (task) => {
        if (task.kind !== "plan") {
          return { kind: "delegate_to_default" };
        }
        return { kind: "plan", lwir: singleToolLwir() };
      }),
    } satisfies Harness & { readonly harnessId: string };
    const orchestratorHarness = {
      harnessId: "delegatingOrchestratorHarness@1.0.0",
      run: vi.fn<Harness["run"]>(async () => ({ kind: "delegate_to_default" })),
    } satisfies Harness & { readonly harnessId: string };
    const workflowWithPlannerHarness = createLittleWorkflow({
      ...ticketWorkflow,
      planner: {
        model: { provider: "test", modelId: "planner-model" },
        harness: plannerHarness,
      },
    });

    await expect(runWorkflow({
      world,
      workflows: [workflowWithPlannerHarness],
      orchestrator: {
        model: { provider: "test", modelId: "orchestrator-model" },
        harness: orchestratorHarness,
      },
      input: { request: "run one summarized workflow" },
      tools: ticketRegistryWith(summarize),
      runId: "run_orchestrator_delegate_to_default",
    })).rejects.toThrow(/Unsupported model version|model/u);

    const sessionHarnessIds = (await listEvents(world, "run_orchestrator_delegate_to_default"))
      .filter((event) => event.type === "harness.session.started")
      .map((event) => (event.payload.manifest as { harnessId?: string } | undefined)?.harnessId);
    expect(sessionHarnessIds).toContain("delegatingOrchestratorHarness@1.0.0");
    expect(sessionHarnessIds).toContain("workflowHarness@1.0.0");
  });

  it("orchestrator run_workflow executes the planned WorkflowVersion with matching input", async () => {
    const world = await tempWorld();
    const summarize = vi.fn<RuntimeToolHandler>((input) => {
      const typed = input as { ticketId: string; body: string };
      return { summary: typed.body };
    });
    const plannerHarness = {
      harnessId: "plannerHarness@1.0.0",
      run: vi.fn<Harness["run"]>(async (task) => {
        if (task.kind !== "plan") {
          return { kind: "delegate_to_default" };
        }
        return { kind: "plan", lwir: singleToolLwir() };
      }),
    } satisfies Harness & { readonly harnessId: string };
    const workflowWithStructureReuse = createLittleWorkflow({
      ...ticketWorkflow,
      workflowVersionReuseStrategy: "planner_reviewed",
      planner: {
        model: { provider: "test", modelId: "planner-model" },
        harness: plannerHarness,
      },
    });
    const orchestratorHarness = {
      harnessId: "orchestratorHarness@1.0.0",
      run: vi.fn<Harness["run"]>(async (task, ctx) => {
        if (task.kind !== "orchestrate") {
          return { kind: "delegate_to_default" };
        }
        const plan = ctx.tools.plan_workflow as { execute?: (input: unknown) => Promise<unknown> };
        const run = ctx.tools.run_workflow as { execute?: (input: unknown) => Promise<unknown> };
        const planned = await plan.execute?.({
          workflowId: "support.summarize",
          input: { ticketId: "TIN-O1", body: "Original body." },
        }) as { workflowVersionId: string };
        const executed = await run.execute?.({
          workflowVersionId: planned.workflowVersionId,
          input: { ticketId: "TIN-O1", body: "Original body." },
        });
        return { kind: "orchestrate", output: executed };
      }),
    } satisfies Harness & { readonly harnessId: string };

    const result = await runWorkflow({
      world,
      workflows: [workflowWithStructureReuse],
      orchestrator: {
        model: { provider: "test", modelId: "orchestrator-model" },
        harness: orchestratorHarness,
      },
      input: { request: "plan then reuse one summarized workflow" },
      tools: ticketRegistryWith(summarize),
      runId: "run_orchestrator_reuse_entrypoint",
    });

    expect(result.status).toBe("completed");
    const orchestratorOutput = result.output as {
      readonly runId: string;
      readonly status: "completed" | "failed";
      readonly output?: unknown;
    };
    expect(orchestratorOutput.status).toBe("completed");
    expect(orchestratorOutput.output).toEqual({ summary: "Original body." });

    const subRunEvents = await listEvents(world, orchestratorOutput.runId);
    expect(subRunEvents.find((event) => event.type === "WorkflowVersionRegistered")?.payload)
      .toEqual(expect.objectContaining({
        inputHash: sha256Digest({ ticketId: "TIN-O1", body: "Original body." }),
      }));
    expect(subRunEvents.find((event) => event.type === "RunStarted")?.payload)
      .toEqual(expect.objectContaining({
        input: { ticketId: "TIN-O1", body: "Original body." },
      }));
  });

  it("persists orchestrator plan_workflow versions before any run_workflow call", async () => {
    const world = await tempWorld();
    const plannerHarness = {
      harnessId: "plannerHarness@1.0.0",
      run: vi.fn<Harness["run"]>(async (task) => {
        if (task.kind !== "plan") {
          return { kind: "delegate_to_default" };
        }
        return { kind: "plan", lwir: singleToolLwir() };
      }),
    } satisfies Harness & { readonly harnessId: string };
    const workflowWithPlannerHarness = createLittleWorkflow({
      ...ticketWorkflow,
      planner: {
        model: { provider: "test", modelId: "planner-model" },
        harness: plannerHarness,
      },
    });
    const orchestratorHarness = {
      harnessId: "orchestratorHarness@1.0.0",
      run: vi.fn<Harness["run"]>(async (task, ctx) => {
        if (task.kind !== "orchestrate") {
          return { kind: "delegate_to_default" };
        }
        const plan = ctx.tools.plan_workflow as { execute?: (input: unknown) => Promise<unknown> };
        const planned = await plan.execute?.({
          workflowId: "support.summarize",
          input: { ticketId: "TIN-O1", body: "Original body." },
        }) as { workflowVersionId: string };
        return { kind: "orchestrate", output: planned };
      }),
    } satisfies Harness & { readonly harnessId: string };

    const result = await runWorkflow({
      world,
      workflows: [workflowWithPlannerHarness],
      orchestrator: {
        model: { provider: "test", modelId: "orchestrator-model" },
        harness: orchestratorHarness,
      },
      input: { request: "plan one workflow and stop before execution" },
      tools: ticketToolRegistry,
      runId: "run_orchestrator_plan_only",
    });

    const planned = result.output as { readonly workflowVersionId: string };
    await expect(readStoredWorkflowVersion(world, planned.workflowVersionId))
      .resolves.toEqual(expect.objectContaining({
        id: planned.workflowVersionId,
        lwir: expect.objectContaining({ apiVersion: "littleworkflow.dev/v0.1" }),
      }));
  });

  it("returns runtime_config_error when workflow arrays set maxOuterCycles > 1", async () => {
    const world = await tempWorld();
    const summarize = vi.fn<RuntimeToolHandler>(() => ({ summary: "unused" }));
    const plannerHarness = {
      harnessId: "plannerHarness@1.0.0",
      run: vi.fn<Harness["run"]>(async (task) => {
        if (task.kind !== "plan") {
          return { kind: "delegate_to_default" };
        }
        return { kind: "plan", lwir: singleToolLwir() };
      }),
    } satisfies Harness & { readonly harnessId: string };
    const orchestratorHarness = {
      harnessId: "orchestratorHarness@1.0.0",
      run: vi.fn<Harness["run"]>(async () => ({ kind: "orchestrate", output: { ok: true } })),
    } satisfies Harness & { readonly harnessId: string };
    const workflowWithPlannerHarness = createLittleWorkflow({
      ...ticketWorkflow,
      planner: {
        model: { provider: "test", modelId: "planner-model" },
        harness: plannerHarness,
      },
    });

    await expect(
      runWorkflowPublic({
        world,
        workflows: [workflowWithPlannerHarness],
        orchestrator: {
          model: { provider: "test", modelId: "orchestrator-model" },
          harness: orchestratorHarness,
        },
        input: { request: "run one summarized workflow" },
        tools: ticketRegistryWith(summarize),
        maxOuterCycles: 2,
      }),
    ).rejects.toMatchObject({
      name: "RunFailedError",
      causeCode: "runtime_config_error",
    });
  });

  it("runs tools registered in a ToolRegistry", async () => {
    const world = await tempWorld();
    const execute = vi.fn(async (input: unknown) => {
      const typedInput = input as { ticketId: string; body: string };
      expect(typedInput).toEqual({ ticketId: "TIN-12", body: "Cannot export invoices." });
      return { summary: typedInput.body };
    });
    const registry = createToolRegistry();
    registry.register("summarize", {
      description: "Summarize a ticket.",
      inputSchema: z.object({
        ticketId: z.string(),
        body: z.string(),
      }),
      execute: execute as (input: unknown, context: unknown) => Promise<unknown>,
    });
    const workflow = createLittleWorkflow({
      id: "support.summarize",
      description: "Summarize with a registry-registered tool.",
      inputSchema: ticketInputSchema,
      output: output.object({ schema: ticketOutputSchema }),
      globalTools: ["summarize"],
    } as unknown as Parameters<typeof createLittleWorkflow>[0]);

    const result = await runWorkflow({
      world,
      workflows: workflow,
      input: { ticketId: "TIN-12", body: "Cannot export invoices." },
      planner: plannerFor(singleToolLwir()),
      tools: registry,
      runId: "run_public_ai_sdk_global_tool",
    });

    expect(result.status).toBe("completed");
    expect(result.output).toEqual({ summary: "Cannot export invoices." });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("passes AI SDK ToolExecutionOptions shape to direct tool.call executions", async () => {
    const world = await tempWorld();
    let observedOptions: unknown;
    const workflow = createLittleWorkflow({
      id: "support.summarize",
      description: "Ensure tool.execute receives abortSignal-compatible options.",
      inputSchema: ticketInputSchema,
      output: output.object({ schema: ticketOutputSchema }),
      globalTools: ["summarize"],
    } as unknown as Parameters<typeof createLittleWorkflow>[0]);
    const registry = createToolRegistry({
      summarize: {
        description: "Summarize a ticket.",
        inputSchema: ticketInputSchema,
        execute: async (_input: unknown, options: unknown) => {
          observedOptions = options;
          return { summary: "ok" };
        },
      },
    });

    const result = await runWorkflow({
      world,
      workflows: workflow,
      input: { ticketId: "TIN-12", body: "Cannot export invoices." },
      planner: plannerFor(singleToolLwir()),
      tools: registry,
      runId: "run_public_tool_execute_abort_signal",
    });

    expect(result.status).toBe("completed");
    const optionsRecord = observedOptions as Record<string, unknown> | undefined;
    expect(optionsRecord).toBeDefined();
    expect(typeof optionsRecord?.toolCallId).toBe("string");
    expect(Array.isArray(optionsRecord?.messages)).toBe(true);
    expect(typeof optionsRecord?.abortSignal).toBe("object");
    expect(typeof optionsRecord?.context).toBe("object");
  });

  it("validates AI SDK-style tool input before executing", async () => {
    const world = await tempWorld();
    const execute = vi.fn(async () => ({ summary: "should not run" }));
    const workflow = createLittleWorkflow({
      id: "support.summarize",
      description: "Summarize with an AI SDK-style tool object.",
      inputSchema: ticketInputSchema,
      output: output.object({ schema: ticketOutputSchema }),
      globalTools: ["summarize"],
    } as unknown as Parameters<typeof createLittleWorkflow>[0]);
    const invalidInputRegistry = createToolRegistry();
    invalidInputRegistry.register("summarize", {
      description: "Summarize a ticket.",
      inputSchema: z.object({
        ticketId: z.string(),
        body: z.string(),
      }),
      execute,
    });
    const invalidToolInputLwir = {
      ...singleToolLwir(),
      steps: [
        {
          ...singleToolLwir().steps[0],
          input: { ticketId: "{{ input.ticketId }}" },
        },
      ],
    };

    await expect(
      runWorkflow({
        world,
        workflows: workflow,
        input: { ticketId: "TIN-12", body: "Cannot export invoices." },
        planner: plannerFor(invalidToolInputLwir),
        tools: invalidInputRegistry,
        runId: "run_public_ai_sdk_tool_invalid_input",
      }),
    ).rejects.toMatchObject({
      name: "RunFailedError",
      causeCode: "runtime_config_error",
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("fails closed for executable AI SDK tools that require approval", async () => {
    const world = await tempWorld();
    const execute = vi.fn(async () => ({ summary: "should not run" }));
    const approvalRegistry = createToolRegistry();
    approvalRegistry.register("summarize", {
      description: "Summarize a ticket.",
      inputSchema: ticketInputSchema,
      needsApproval: true,
      execute,
    });
    const workflow = createLittleWorkflow({
      id: "support.summarize",
      description: "Summarize with an approval-gated tool.",
      inputSchema: ticketInputSchema,
      output: output.object({ schema: ticketOutputSchema }),
      globalTools: ["summarize"],
    } as unknown as Parameters<typeof createLittleWorkflow>[0]);

    await expect(
      runWorkflow({
        world,
        workflows: workflow,
        input: { ticketId: "TIN-12", body: "Cannot export invoices." },
        planner: plannerFor(singleToolLwir()),
        tools: approvalRegistry,
        runId: "run_public_ai_sdk_tool_needs_approval",
      }),
    ).rejects.toMatchObject({
      name: "RunFailedError",
      causeCode: "runtime_config_error",
      failedStepPath: "summarize",
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("preserves approval requirements from the compiled tool lock", async () => {
    const world = await tempWorld();
    const execute = vi.fn(async () => ({ summary: "should not run" }));
    // Compile with needsApproval: true; the lock will record approvalRequired: true.
    // At runtime, pass a registry without needsApproval - the lock check fires first.
    const compiledApprovalRegistry = createToolRegistry();
    compiledApprovalRegistry.register("summarize", {
      description: "Summarize a ticket.",
      inputSchema: ticketInputSchema,
      needsApproval: true,
      execute,
    });
    const workflow = createLittleWorkflow({
      id: "support.summarize",
      description: "Summarize with an approval-gated tool.",
      inputSchema: ticketInputSchema,
      output: output.object({ schema: ticketOutputSchema }),
      globalTools: ["summarize"],
    } as unknown as Parameters<typeof createLittleWorkflow>[0]);

    await expect(
      runWorkflow({
        world,
        workflows: workflow,
        input: { ticketId: "TIN-12", body: "Cannot export invoices." },
        planner: plannerFor(singleToolLwir()),
        tools: compiledApprovalRegistry,
        runId: "run_public_ai_sdk_tool_needs_approval_override",
      }),
    ).rejects.toMatchObject({
      name: "RunFailedError",
      causeCode: "runtime_config_error",
      failedStepPath: "summarize",
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("preserves approval requirements from function-valued authored tools", async () => {
    const world = await tempWorld();
    const execute = vi.fn(async () => ({ summary: "should not run" }));
    // Registry with needsApproval: true → lock records approvalRequired: true → runtime throws.
    const approvalRegistry2 = createToolRegistry();
    approvalRegistry2.register("summarize", {
      description: "Summarize a ticket.",
      inputSchema: ticketInputSchema,
      needsApproval: true,
      execute,
    });
    const workflow = createLittleWorkflow({
      id: "support.summarize",
      description: "Summarize with a function-valued approval-gated tool.",
      inputSchema: ticketInputSchema,
      output: output.object({ schema: ticketOutputSchema }),
      globalTools: ["summarize"],
    } as unknown as Parameters<typeof createLittleWorkflow>[0]);

    await expect(
      runWorkflow({
        world,
        workflows: workflow,
        input: { ticketId: "TIN-12", body: "Cannot export invoices." },
        planner: plannerFor(singleToolLwir()),
        tools: approvalRegistry2,
        runId: "run_public_function_tool_needs_approval_override",
      }),
    ).rejects.toMatchObject({
      name: "RunFailedError",
      causeCode: "runtime_config_error",
      failedStepPath: "summarize",
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("fails at compile time when a globalTools name is not in the registry", async () => {
    const world = await tempWorld();
    const emptyRegistry = createToolRegistry();
    const workflow = createLittleWorkflow({
      id: "support.summarize",
      description: "Tool not registered.",
      inputSchema: ticketInputSchema,
      output: output.object({ schema: ticketOutputSchema }),
      globalTools: ["summarize"],
    } as unknown as Parameters<typeof createLittleWorkflow>[0]);

    await expect(
      runWorkflow({
        world,
        workflows: workflow,
        input: { ticketId: "TIN-12", body: "Cannot export invoices." },
        planner: plannerFor(singleToolLwir()),
        tools: emptyRegistry,
        runId: "run_public_tool_not_registered",
      }),
    ).rejects.toMatchObject({
      name: "RunFailedError",
      causeCode: "runtime_config_error",
    });
  });

  it("throws runtime_config_error when tool.execute is absent", async () => {
    // Compile with the full registry so the lock is recorded, then run with a
    // partial registry that returns a tool object lacking execute().
    // The runtime should fail closed.
    const world = await tempWorld();
    const compiled = await compileWorkflow(ticketWorkflow, {
      input: { ticketId: "TIN-12", body: "Cannot export invoices." },
      tools: ticketToolRegistry,
      planner: plannerFor(singleToolLwir()),
    });

    // A registry that exposes tool metadata via get(), but no execute handler.
    const partialRegistry: import("./tool-registry.js").ToolRegistry = {
      get: (name) =>
        name === "summarize"
          ? { description: "Summarize a ticket.", inputSchema: ticketInputSchema }
          : undefined,
      list: () => ["summarize"],
      toRecord: () => ({
        summarize: { description: "Summarize a ticket.", inputSchema: ticketInputSchema },
      }),
      snapshotForManifest: () => [],
      attachMcpTools: () => {},
      register: () => {},
      names: () => ["summarize"],
      has: (name) => name === "summarize",
    };

    const result = await executeWorkflowVersion({
      world,
      workflowVersion: compiled.workflowVersion,
      input: { ticketId: "TIN-12", body: "Cannot export invoices." },
      tools: partialRegistry,
      runId: "run_descriptor_present_handler_absent",
    });

    expect(result.status).toBe("failed");
    expect((result as typeof result & { error?: { causeCode?: string } }).error?.causeCode)
      .toBe("runtime_config_error");
    await expect(readStoredWorkflowVersion(world, compiled.workflowVersion.id)).resolves.toEqual(
      compiled.workflowVersion,
    );
    const events = await listEvents(world, "run_descriptor_present_handler_absent");
    expect(events.filter((event) => event.type === "StepAttemptStarted")).toHaveLength(1);
    expect(events.filter((event) => event.type === "RunFailed")).toHaveLength(1);
  });

  it("rejects direct execution when planning snapshot hash does not match the snapshot", async () => {
    const world = await tempWorld();
    const compiled = await compileWorkflow(ticketWorkflow, {
      input: { ticketId: "TIN-12", body: "Cannot export invoices." },
      tools: ticketToolRegistry,
      planner: plannerFor(singleToolLwir()),
    });
    const mismatchedLock = {
      ...compiled.workflowVersion.lock,
      planningDefinitionSnapshotHash: sha256Digest({ mismatched: true }),
    };
    const identity = computeCompiledWorkflowVersionIdentity({
      canonicalizer: compiled.workflowVersion.canonicalizer,
      lwirVersionId: compiled.workflowVersion.lwirVersionId,
      lwirHash: compiled.workflowVersion.lwirHash,
      lockSeed: workflowVersionLockSeedFrom(mismatchedLock),
    });
    const workflowVersion = {
      ...compiled.workflowVersion,
      id: identity.workflowVersionId,
      hash: identity.workflowVersionHash,
      lock: {
        ...mismatchedLock,
        workflowVersionId: identity.workflowVersionId,
        workflowVersionHash: identity.workflowVersionHash,
      },
    };

    await expect(
      executeWorkflowVersion({
        world,
        workflowVersion,
        input: { ticketId: "TIN-12", body: "Cannot export invoices." },
        tools: ticketToolRegistry,
        runId: "run_planning_snapshot_hash_mismatch",
      }),
    ).rejects.toThrow(/WorkflowVersion lock mismatch/u);
  });

  it("rejects direct execution when input differs from the WorkflowVersion lock", async () => {
    const world = await tempWorld();
    const compiled = await compileWorkflow(ticketWorkflow, {
      input: { ticketId: "TIN-12", body: "Original body." },
      tools: ticketToolRegistry,
      planner: plannerFor(singleToolLwir()),
    });
    const summarize = vi.fn<RuntimeToolHandler>(() => ({ summary: "Should not run." }));

    await expect(
      executeWorkflowVersion({
        world,
        workflowVersion: compiled.workflowVersion,
        input: { ticketId: "TIN-13", body: "Changed body." },
        tools: ticketRegistryWith(summarize),
        runId: "run_locked_input_mismatch",
      }),
    ).rejects.toThrow("WorkflowVersion inputHash does not match run input.");
    expect(summarize).not.toHaveBeenCalled();
    await expect(listEvents(world, "run_locked_input_mismatch")).resolves.toEqual([]);
  });

  it("unwraps common object wrappers for array-mode step output", async () => {
    const world = await tempWorld();
    const itemSchema = {
      type: "object",
      required: ["id"],
      additionalProperties: false,
      properties: { id: { type: "string" } },
    };
    const arraySchema = { type: "array", items: itemSchema };
    const registry = createToolRegistry();
    registry.register("generate_items", {
      description: "Return an object-wrapped array like some JSON-mode providers do.",
      inputSchema: { type: "object", additionalProperties: true },
      execute: async () => ({ items: [{ id: "one" }, { id: "two" }] }),
    });
    const arrayWorkflow = createLittleWorkflow({
      id: "support.array-wrapper",
      description: "Normalize wrapped array outputs.",
      inputSchema: { type: "object", additionalProperties: true },
      output: output.array({ element: itemSchema }),
      models: [workerModel],
      globalTools: ["generate_items"],
    } as unknown as Parameters<typeof createLittleWorkflow>[0]);
    const arrayLwir: LwirWorkflow = {
      apiVersion: "littleworkflow.dev/v0.1",
      kind: "Workflow",
      metadata: { name: "support.array-wrapper" },
      input: { schema: { type: "object", additionalProperties: true } },
      output: { schema: arraySchema },
      permissions: { tools: ["generate_items"], models: [], secrets: [], network: [] },
      steps: [
        {
          id: "generate",
          uses: "tool.call",
          with: { tool: "generate_items" },
          input: "{{ input }}",
          output: { mode: "array", schema: arraySchema },
        },
      ],
    };
    const compiled = await compileWorkflow(arrayWorkflow, {
      input: {},
      tools: registry,
      planner: plannerFor(arrayLwir),
    });

    const result = await executeWorkflowVersion({
      world,
      workflowVersion: compiled.workflowVersion,
      input: {},
      tools: registry,
      runId: "run_array_wrapper_output",
    });

    expect(result.status).toBe("completed");
    expect(result.output).toEqual([{ id: "one" }, { id: "two" }]);
  });

  it("replays a completed run without requiring planner access", async () => {
    const world = await tempWorld();
    const summarize = vi.fn<RuntimeToolHandler>(() => ({ summary: "Cannot export invoices." }));
    const planner = plannerFor(singleToolLwir());

    const first = await runWorkflow({
      world,
      workflows: ticketWorkflow,
      input: { ticketId: "TIN-12", body: "Cannot export invoices." },
      planner,
      tools: ticketRegistryWith(summarize),
      runId: "run_public_completed_replay",
    });
    const eventCount = first.events.length;

    const replay = await runWorkflow({
      world,
      workflows: ticketWorkflow,
      input: { ticketId: "TIN-12", body: "Cannot export invoices." },
      runId: "run_public_completed_replay",
    });

    expect(replay).toMatchObject({
      runId: "run_public_completed_replay",
      workflowVersionId: first.workflowVersionId,
      status: "completed",
      output: { summary: "Cannot export invoices." },
      usage: first.usage,
      artifacts: first.artifacts,
    });
    expect(replay.events).toHaveLength(eventCount);
    expect(summarize).toHaveBeenCalledTimes(1);
    expect(planner.draft).toHaveBeenCalledTimes(1);
    await expect(listEvents(world, "run_public_completed_replay")).resolves.toHaveLength(
      eventCount,
    );
  });

  it("rejects completed run replay when the input does not match", async () => {
    const world = await tempWorld();
    const summarize = vi.fn<RuntimeToolHandler>(() => ({ summary: "Cannot export invoices." }));

    await runWorkflow({
      world,
      workflows: ticketWorkflow,
      input: { ticketId: "TIN-12", body: "Cannot export invoices." },
      planner: plannerFor(singleToolLwir()),
      tools: ticketRegistryWith(summarize),
      runId: "run_public_completed_replay_input_mismatch",
    });

    await expect(
      runWorkflow({
        world,
        workflows: ticketWorkflow,
        input: { ticketId: "TIN-99", body: "Different issue." },
        runId: "run_public_completed_replay_input_mismatch",
      }),
    ).rejects.toThrow("Run input mismatch");
    expect(summarize).toHaveBeenCalledTimes(1);
  });

  it("rejects failed run replay when persisted input does not match", async () => {
    const world = await tempWorld();
    const planner = plannerFor(singleToolLwir());

    await expect(
      runWorkflow({
        world,
        workflows: ticketWorkflow,
        input: { ticketId: "TIN-12", body: "Cannot export invoices." },
        planner,
        tools: ticketRegistryWith(() => {
          throw new Error("tool unavailable");
        }),
        runId: "run_public_failed_replay_input_mismatch",
      }),
    ).rejects.toMatchObject({ causeCode: "step_failed" });

    await expect(
      runWorkflow({
        world,
        workflows: ticketWorkflow,
        input: { ticketId: "TIN-99", body: "Different issue." },
        runId: "run_public_failed_replay_input_mismatch",
      }),
    ).rejects.toThrow("Run input mismatch");
  });

  it("checks failed run replay artifacts before returning recorded failure metadata", async () => {
    const world = await tempWorld();
    const extract = vi.fn<RuntimeToolHandler>(() => ({ context: "Cannot export invoices." }));
    const summarize = vi.fn<RuntimeToolHandler>(() => {
      throw new Error("summary backend unavailable");
    });

    await expect(
      runWorkflow({
        world,
        workflows: multiStepWorkflow,
        input: { ticketId: "TIN-12", body: "Cannot export invoices." },
        planner: plannerFor(multiStepLwir()),
        tools: multiStepRegistryWith(extract, summarize),
        runId: "run_public_failed_replay_artifact_corrupt",
      }),
    ).rejects.toMatchObject({
      name: "RunFailedError",
      causeCode: "step_failed",
      failedStepPath: "summarize",
    });

    const events = await listEvents(world, "run_public_failed_replay_artifact_corrupt");
    const extractCompleted = events.find((event) =>
      event.type === "StepCompleted" && event.payload.stepPath === "extract"
    );
    const extractOutputRef = extractCompleted?.payload.outputRef;
    if (typeof extractOutputRef !== "string") {
      throw new Error("Expected extract step to create an output artifact.");
    }
    const artifact = await readArtifact(world, extractOutputRef);
    await rm(join(world.dataDir, "artifacts", "blobs", `${artifact.manifest.artifactId}.bin`), {
      force: true,
    });

    await expect(
      runWorkflow({
        world,
        workflows: multiStepWorkflow,
        input: { ticketId: "TIN-12", body: "Cannot export invoices." },
        runId: "run_public_failed_replay_artifact_corrupt",
      }),
    ).rejects.toThrow("Artifact not found");
    expect(extract).toHaveBeenCalledTimes(1);
    expect(summarize).toHaveBeenCalledTimes(1);
  });

  it("rejects completed run replay when the persisted input is missing", async () => {
    const world = await tempWorld();
    const outputArtifact = await writeArtifact(world, {
      runId: "run_public_completed_replay_missing_input",
      stepPath: "summarize",
      name: "output",
      payload: { summary: "Cannot export invoices." },
      contentType: "application/json",
    });
    await appendEvent(world, "run_public_completed_replay_missing_input", {
      type: "RunStarted",
      payload: { workflowVersionId: "wfver_manual_missing_input" },
    });
    await appendEvent(world, "run_public_completed_replay_missing_input", {
      type: "StepScheduled",
      payload: { stepPath: "summarize", stepId: "summarize", uses: "tool.call" },
    });
    await appendEvent(world, "run_public_completed_replay_missing_input", {
      type: "StepAttemptStarted",
      payload: {
        stepPath: "summarize",
        stepId: "summarize",
        attempt: 1,
        attemptId: "attempt_1",
      },
    });
    await appendEvent(world, "run_public_completed_replay_missing_input", {
      type: "ArtifactCreated",
      payload: {
        stepPath: "summarize",
        artifactRef: outputArtifact.artifactRef,
        name: "output",
        contentType: "application/json",
      },
    });
    await appendEvent(world, "run_public_completed_replay_missing_input", {
      type: "StepCompleted",
      payload: {
        stepPath: "summarize",
        stepId: "summarize",
        attempt: 1,
        attemptId: "attempt_1",
        output: { summary: "Cannot export invoices." },
        outputRef: outputArtifact.artifactRef,
        artifactRefs: [outputArtifact.artifactRef],
      },
    });
    await appendEvent(world, "run_public_completed_replay_missing_input", {
      type: "RunCompleted",
      payload: {
        workflowVersionId: "wfver_manual_missing_input",
        output: { summary: "Cannot export invoices." },
        outputRef: outputArtifact.artifactRef,
      },
    });

    await expect(
      runWorkflow({
        world,
        workflows: ticketWorkflow,
        input: { ticketId: "TIN-12", body: "Cannot export invoices." },
        runId: "run_public_completed_replay_missing_input",
      }),
    ).rejects.toThrow("Completed run is missing persisted input");
  });

  it("checks completed run replay artifacts before returning recorded output", async () => {
    const world = await tempWorld();
    const summarize = vi.fn<RuntimeToolHandler>(() => ({ summary: "Cannot export invoices." }));

    const first = await runWorkflow({
      world,
      workflows: ticketWorkflow,
      input: { ticketId: "TIN-12", body: "Cannot export invoices." },
      planner: plannerFor(singleToolLwir()),
      tools: ticketRegistryWith(summarize),
      runId: "run_public_completed_replay_artifact_corrupt",
    });
    const outputRef = first.artifacts.at(-1);
    if (outputRef === undefined) {
      throw new Error("Expected completed run to create an output artifact.");
    }
    const artifact = await readArtifact(world, outputRef);
    await rm(join(world.dataDir, "artifacts", "blobs", `${artifact.manifest.artifactId}.bin`), {
      force: true,
    });

    await expect(
      runWorkflow({
        world,
        workflows: ticketWorkflow,
        input: { ticketId: "TIN-12", body: "Cannot export invoices." },
        runId: "run_public_completed_replay_artifact_corrupt",
      }),
    ).rejects.toThrow("Artifact not found");
    expect(summarize).toHaveBeenCalledTimes(1);
  });

  it("checks artifact step ownership before completed run replay returns artifact refs", async () => {
    const world = await tempWorld();
    const input = { ticketId: "TIN-12", body: "Cannot export invoices." };
    const extractOutput = { context: "Cannot export invoices." };
    const finalOutput = { summary: "Cannot export invoices." };
    const wrongStepArtifact = await writeArtifact(world, {
      runId: "run_public_completed_replay_wrong_step_artifact",
      stepPath: "summarize",
      name: "output",
      payload: extractOutput,
      contentType: "application/json",
    });
    const finalArtifact = await writeArtifact(world, {
      runId: "run_public_completed_replay_wrong_step_artifact",
      stepPath: "summarize",
      name: "output",
      payload: finalOutput,
      contentType: "application/json",
    });

    await appendEvent(world, "run_public_completed_replay_wrong_step_artifact", {
      type: "RunStarted",
      payload: { workflowVersionId: "wfver_manual_wrong_step_artifact", input },
    });
    await appendEvent(world, "run_public_completed_replay_wrong_step_artifact", {
      type: "StepScheduled",
      payload: { stepPath: "extract", stepId: "extract", uses: "tool.call" },
    });
    await appendEvent(world, "run_public_completed_replay_wrong_step_artifact", {
      type: "StepAttemptStarted",
      payload: { stepPath: "extract", stepId: "extract", attempt: 1, attemptId: "attempt_1" },
    });
    await appendEvent(world, "run_public_completed_replay_wrong_step_artifact", {
      type: "ArtifactCreated",
      payload: {
        stepPath: "extract",
        artifactRef: wrongStepArtifact.artifactRef,
        name: "output",
        contentType: "application/json",
      },
    });
    await appendEvent(world, "run_public_completed_replay_wrong_step_artifact", {
      type: "StepCompleted",
      payload: {
        stepPath: "extract",
        stepId: "extract",
        attempt: 1,
        attemptId: "attempt_1",
        output: extractOutput,
        outputRef: wrongStepArtifact.artifactRef,
        artifactRefs: [wrongStepArtifact.artifactRef],
      },
    });
    await appendEvent(world, "run_public_completed_replay_wrong_step_artifact", {
      type: "StepScheduled",
      payload: { stepPath: "summarize", stepId: "summarize", uses: "tool.call" },
    });
    await appendEvent(world, "run_public_completed_replay_wrong_step_artifact", {
      type: "StepAttemptStarted",
      payload: {
        stepPath: "summarize",
        stepId: "summarize",
        attempt: 1,
        attemptId: "attempt_1",
      },
    });
    await appendEvent(world, "run_public_completed_replay_wrong_step_artifact", {
      type: "ArtifactCreated",
      payload: {
        stepPath: "summarize",
        artifactRef: finalArtifact.artifactRef,
        name: "output",
        contentType: "application/json",
      },
    });
    await appendEvent(world, "run_public_completed_replay_wrong_step_artifact", {
      type: "StepCompleted",
      payload: {
        stepPath: "summarize",
        stepId: "summarize",
        attempt: 1,
        attemptId: "attempt_1",
        output: finalOutput,
        outputRef: finalArtifact.artifactRef,
        artifactRefs: [finalArtifact.artifactRef],
      },
    });
    await appendEvent(world, "run_public_completed_replay_wrong_step_artifact", {
      type: "RunCompleted",
      payload: {
        workflowVersionId: "wfver_manual_wrong_step_artifact",
        output: finalOutput,
        outputRef: finalArtifact.artifactRef,
        terminalStepPath: "summarize",
      },
    });

    await expect(
      runWorkflow({
        world,
        workflows: multiStepWorkflow,
        input,
        runId: "run_public_completed_replay_wrong_step_artifact",
      }),
    ).rejects.toThrow("does not belong to step 'extract'");
  });

  it("rejects completed replay when the run output ref points at a post-terminal step", async () => {
    const world = await tempWorld();
    const input = { ticketId: "TIN-12", body: "Cannot export invoices." };
    const terminalOutput = { summary: "Terminal output." };
    const injectedOutput = { summary: "Injected output." };
    const terminalArtifact = await writeArtifact(world, {
      runId: "run_public_completed_replay_post_terminal_output",
      stepPath: "summarize",
      name: "output",
      payload: terminalOutput,
      contentType: "application/json",
    });
    const injectedArtifact = await writeArtifact(world, {
      runId: "run_public_completed_replay_post_terminal_output",
      stepPath: "extract",
      name: "output",
      payload: injectedOutput,
      contentType: "application/json",
    });

    await appendEvent(world, "run_public_completed_replay_post_terminal_output", {
      type: "RunStarted",
      payload: { workflowVersionId: "wfver_manual_post_terminal_output", input },
    });
    await appendEvent(world, "run_public_completed_replay_post_terminal_output", {
      type: "StepScheduled",
      payload: { stepPath: "summarize", stepId: "summarize", uses: "tool.call" },
    });
    await appendEvent(world, "run_public_completed_replay_post_terminal_output", {
      type: "StepAttemptStarted",
      payload: {
        stepPath: "summarize",
        stepId: "summarize",
        attempt: 1,
        attemptId: "attempt_1",
      },
    });
    await appendEvent(world, "run_public_completed_replay_post_terminal_output", {
      type: "ArtifactCreated",
      payload: {
        stepPath: "summarize",
        artifactRef: terminalArtifact.artifactRef,
        name: "output",
        contentType: "application/json",
      },
    });
    await appendEvent(world, "run_public_completed_replay_post_terminal_output", {
      type: "StepCompleted",
      payload: {
        stepPath: "summarize",
        stepId: "summarize",
        attempt: 1,
        attemptId: "attempt_1",
        output: terminalOutput,
        outputRef: terminalArtifact.artifactRef,
        artifactRefs: [terminalArtifact.artifactRef],
      },
    });
    await appendEvent(world, "run_public_completed_replay_post_terminal_output", {
      type: "StepScheduled",
      payload: { stepPath: "extract", stepId: "extract", uses: "tool.call" },
    });
    await appendEvent(world, "run_public_completed_replay_post_terminal_output", {
      type: "StepAttemptStarted",
      payload: { stepPath: "extract", stepId: "extract", attempt: 1, attemptId: "attempt_1" },
    });
    await appendEvent(world, "run_public_completed_replay_post_terminal_output", {
      type: "ArtifactCreated",
      payload: {
        stepPath: "extract",
        artifactRef: injectedArtifact.artifactRef,
        name: "output",
        contentType: "application/json",
      },
    });
    await appendEvent(world, "run_public_completed_replay_post_terminal_output", {
      type: "StepCompleted",
      payload: {
        stepPath: "extract",
        stepId: "extract",
        attempt: 1,
        attemptId: "attempt_1",
        output: injectedOutput,
        outputRef: injectedArtifact.artifactRef,
        artifactRefs: [injectedArtifact.artifactRef],
      },
    });
    await appendEvent(world, "run_public_completed_replay_post_terminal_output", {
      type: "RunCompleted",
      payload: {
        workflowVersionId: "wfver_manual_post_terminal_output",
        output: injectedOutput,
        outputRef: injectedArtifact.artifactRef,
        terminalStepPath: "summarize",
      },
    });

    await expect(
      runWorkflow({
        world,
        workflows: multiStepWorkflow,
        input,
        runId: "run_public_completed_replay_post_terminal_output",
      }),
    ).rejects.toThrow("does not match terminal step outputRef");
  });

  it("checks run output ref matches the terminal step before completed replay", async () => {
    const world = await tempWorld();
    const input = { ticketId: "TIN-12", body: "Cannot export invoices." };
    const earlierOutput = { summary: "Earlier step output." };
    const finalOutput = { summary: "Final step output." };
    const earlierArtifact = await writeArtifact(world, {
      runId: "run_public_completed_replay_wrong_run_output_ref",
      stepPath: "extract",
      name: "output",
      payload: earlierOutput,
      contentType: "application/json",
    });
    const finalArtifact = await writeArtifact(world, {
      runId: "run_public_completed_replay_wrong_run_output_ref",
      stepPath: "summarize",
      name: "output",
      payload: finalOutput,
      contentType: "application/json",
    });

    await appendEvent(world, "run_public_completed_replay_wrong_run_output_ref", {
      type: "RunStarted",
      payload: { workflowVersionId: "wfver_manual_wrong_run_output_ref", input },
    });
    await appendEvent(world, "run_public_completed_replay_wrong_run_output_ref", {
      type: "StepScheduled",
      payload: { stepPath: "extract", stepId: "extract", uses: "tool.call" },
    });
    await appendEvent(world, "run_public_completed_replay_wrong_run_output_ref", {
      type: "StepAttemptStarted",
      payload: { stepPath: "extract", stepId: "extract", attempt: 1, attemptId: "attempt_1" },
    });
    await appendEvent(world, "run_public_completed_replay_wrong_run_output_ref", {
      type: "ArtifactCreated",
      payload: {
        stepPath: "extract",
        artifactRef: earlierArtifact.artifactRef,
        name: "output",
        contentType: "application/json",
      },
    });
    await appendEvent(world, "run_public_completed_replay_wrong_run_output_ref", {
      type: "StepCompleted",
      payload: {
        stepPath: "extract",
        stepId: "extract",
        attempt: 1,
        attemptId: "attempt_1",
        output: earlierOutput,
        outputRef: earlierArtifact.artifactRef,
        artifactRefs: [earlierArtifact.artifactRef],
      },
    });
    await appendEvent(world, "run_public_completed_replay_wrong_run_output_ref", {
      type: "StepScheduled",
      payload: { stepPath: "summarize", stepId: "summarize", uses: "tool.call" },
    });
    await appendEvent(world, "run_public_completed_replay_wrong_run_output_ref", {
      type: "StepAttemptStarted",
      payload: {
        stepPath: "summarize",
        stepId: "summarize",
        attempt: 1,
        attemptId: "attempt_1",
      },
    });
    await appendEvent(world, "run_public_completed_replay_wrong_run_output_ref", {
      type: "ArtifactCreated",
      payload: {
        stepPath: "summarize",
        artifactRef: finalArtifact.artifactRef,
        name: "output",
        contentType: "application/json",
      },
    });
    await appendEvent(world, "run_public_completed_replay_wrong_run_output_ref", {
      type: "StepCompleted",
      payload: {
        stepPath: "summarize",
        stepId: "summarize",
        attempt: 1,
        attemptId: "attempt_1",
        output: finalOutput,
        outputRef: finalArtifact.artifactRef,
        artifactRefs: [finalArtifact.artifactRef],
      },
    });
    await appendEvent(world, "run_public_completed_replay_wrong_run_output_ref", {
      type: "RunCompleted",
      payload: {
        workflowVersionId: "wfver_manual_wrong_run_output_ref",
        output: earlierOutput,
        outputRef: earlierArtifact.artifactRef,
        terminalStepPath: "summarize",
      },
    });

    await expect(
      runWorkflow({
        world,
        workflows: multiStepWorkflow,
        input,
        runId: "run_public_completed_replay_wrong_run_output_ref",
      }),
    ).rejects.toThrow("does not match terminal step outputRef");
  });

  it("validates completed replay output against the workflow output schema", async () => {
    const world = await tempWorld();
    const input = { ticketId: "TIN-12", body: "Cannot export invoices." };
    const invalidOutput = { summary: 404 };
    const outputArtifact = await writeArtifact(world, {
      runId: "run_public_completed_replay_invalid_output_schema",
      stepPath: "summarize",
      name: "output",
      payload: invalidOutput,
      contentType: "application/json",
    });
    await appendEvent(world, "run_public_completed_replay_invalid_output_schema", {
      type: "RunStarted",
      payload: { workflowVersionId: "wfver_manual_invalid_output_schema", input },
    });
    await appendEvent(world, "run_public_completed_replay_invalid_output_schema", {
      type: "StepScheduled",
      payload: { stepPath: "summarize", stepId: "summarize", uses: "tool.call" },
    });
    await appendEvent(world, "run_public_completed_replay_invalid_output_schema", {
      type: "StepAttemptStarted",
      payload: {
        stepPath: "summarize",
        stepId: "summarize",
        attempt: 1,
        attemptId: "attempt_1",
      },
    });
    await appendEvent(world, "run_public_completed_replay_invalid_output_schema", {
      type: "ArtifactCreated",
      payload: {
        stepPath: "summarize",
        artifactRef: outputArtifact.artifactRef,
        name: "output",
        contentType: "application/json",
      },
    });
    await appendEvent(world, "run_public_completed_replay_invalid_output_schema", {
      type: "StepCompleted",
      payload: {
        stepPath: "summarize",
        stepId: "summarize",
        attempt: 1,
        attemptId: "attempt_1",
        output: invalidOutput,
        outputRef: outputArtifact.artifactRef,
        artifactRefs: [outputArtifact.artifactRef],
      },
    });
    await appendEvent(world, "run_public_completed_replay_invalid_output_schema", {
      type: "RunCompleted",
      payload: {
        workflowVersionId: "wfver_manual_invalid_output_schema",
        output: invalidOutput,
        outputRef: outputArtifact.artifactRef,
        terminalStepPath: "summarize",
      },
    });

    await expect(
      runWorkflow({
        world,
        workflows: ticketWorkflow,
        input,
        runId: "run_public_completed_replay_invalid_output_schema",
      }),
    ).rejects.toThrow("Workflow output does not match schema");
  });

  it("checks intermediate artifacts before completed run replay returns artifact refs", async () => {
    const world = await tempWorld();
    const extract = vi.fn<RuntimeToolHandler>(() => ({ context: "Cannot export invoices." }));
    const summarize = vi.fn<RuntimeToolHandler>(() => ({ summary: "Cannot export invoices." }));

    const first = await runWorkflow({
      world,
      workflows: multiStepWorkflow,
      input: { ticketId: "TIN-12", body: "Cannot export invoices." },
      planner: plannerFor(multiStepLwir()),
      tools: multiStepRegistryWith(extract, summarize),
      runId: "run_public_completed_replay_intermediate_artifact_corrupt",
    });
    const events = await listEvents(
      world,
      "run_public_completed_replay_intermediate_artifact_corrupt",
    );
    const extractCompleted = events.find((event) =>
      event.type === "StepCompleted" && event.payload.stepPath === "extract"
    );
    const extractOutputRef = extractCompleted?.payload.outputRef;
    if (typeof extractOutputRef !== "string") {
      throw new Error("Expected extract step to create an output artifact.");
    }
    expect(first.artifacts).toContain(extractOutputRef);
    const artifact = await readArtifact(world, extractOutputRef);
    await rm(join(world.dataDir, "artifacts", "blobs", `${artifact.manifest.artifactId}.bin`), {
      force: true,
    });

    await expect(
      runWorkflow({
        world,
        workflows: multiStepWorkflow,
        input: { ticketId: "TIN-12", body: "Cannot export invoices." },
        runId: "run_public_completed_replay_intermediate_artifact_corrupt",
      }),
    ).rejects.toThrow("Artifact not found");
    expect(extract).toHaveBeenCalledTimes(1);
    expect(summarize).toHaveBeenCalledTimes(1);
  });

  it("rejects failed runs with RunFailedError metadata", async () => {
    const world = await tempWorld();
    const planner = plannerFor(singleToolLwir());

    await expect(
      runWorkflow({
        world,
        workflows: ticketWorkflow,
        input: { ticketId: "TIN-12", body: "Cannot export invoices." },
        planner,
        tools: ticketRegistryWith(() => {
          throw new Error("tool unavailable");
        }),
        runId: "run_public_failed",
      }),
    ).rejects.toMatchObject({
      name: "RunFailedError",
      runId: "run_public_failed",
      causeCode: "step_failed",
      failedStepPath: "summarize",
    });
  });

  it("maps step output schema validation failures to step_schema_error", async () => {
    const world = await tempWorld();
    const planner = plannerFor(singleToolLwir());

    await expect(
      runWorkflow({
        world,
        workflows: ticketWorkflow,
        input: { ticketId: "TIN-12", body: "Cannot export invoices." },
        planner,
        tools: ticketRegistryWith(() => ({ summary: 404 })),
        runId: "run_public_step_schema_failure",
      }),
    ).rejects.toMatchObject({
      name: "RunFailedError",
      runId: "run_public_step_schema_failure",
      causeCode: "step_schema_error",
      failedStepPath: "summarize",
    });
  });

  it("marks aborted runs as cancelled before planning starts", async () => {
    const world = await tempWorld();
    const planner = plannerFor(singleToolLwir());
    const controller = new AbortController();
    controller.abort();

    await expect(
      runWorkflow({
        world,
        workflows: ticketWorkflow,
        input: { ticketId: "TIN-12", body: "Cannot export invoices." },
        planner,
        tools: ticketRegistryWith(() => ({ summary: "should not run" })),
        runId: "run_public_cancelled",
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({
      name: "RunFailedError",
      runId: "run_public_cancelled",
      causeCode: "cancelled",
      result: expect.objectContaining({
        runId: "run_public_cancelled",
        status: "failed",
        workflowVersionId: "uncompiled",
      }),
    });
    expect(planner.draft).not.toHaveBeenCalled();
  });

  it("marks runs as timed out when timeout elapses before planning starts", async () => {
    const world = await tempWorld();
    const planner = plannerFor(singleToolLwir());

    await expect(
      runWorkflow({
        world,
        workflows: ticketWorkflow,
        input: { ticketId: "TIN-12", body: "Cannot export invoices." },
        planner,
        tools: ticketRegistryWith(() => ({ summary: "should not run" })),
        runId: "run_public_timeout",
        timeout: 0,
      }),
    ).rejects.toBeInstanceOf(RunFailedError);

    await expect(
      runWorkflow({
        world,
        workflows: ticketWorkflow,
        input: { ticketId: "TIN-12", body: "Cannot export invoices." },
        planner,
        tools: ticketRegistryWith(() => ({ summary: "should not run" })),
        runId: "run_public_timeout_again",
        timeout: 0,
      }),
    ).rejects.toMatchObject({
      name: "RunFailedError",
      runId: "run_public_timeout_again",
      causeCode: "timeout",
      result: expect.objectContaining({
        runId: "run_public_timeout_again",
        status: "failed",
        workflowVersionId: "uncompiled",
      }),
    });
  });

  it("marks runs as timed out when timeout elapses during planning", async () => {
    const world = await tempWorld();
    const planner: PlannerAdapter = {
      draft: vi.fn(() => new Promise<never>(() => {})),
    };

    await expect(
      runWorkflow({
        world,
        workflows: ticketWorkflow,
        input: { ticketId: "TIN-12", body: "Cannot export invoices." },
        planner,
        tools: ticketRegistryWith(() => ({ summary: "should not run" })),
        runId: "run_public_planning_timeout",
        timeout: 1,
      }),
    ).rejects.toMatchObject({
      name: "RunFailedError",
      runId: "run_public_planning_timeout",
      causeCode: "timeout",
      result: expect.objectContaining({
        runId: "run_public_planning_timeout",
        status: "failed",
        workflowVersionId: "uncompiled",
      }),
    });
    await expect(listEvents(world, "run_public_planning_timeout")).resolves.toEqual([
      expect.objectContaining({ sequence: 1, type: "OrchestrationRequested" }),
      expect.objectContaining({ sequence: 2, type: "PlannerStarted" }),
      expect.objectContaining({ sequence: 3, type: "RunStarted" }),
      expect.objectContaining({ sequence: 4, type: "RunFailed" }),
    ]);
  });

  it("uses one timeout budget across planning and execution", async () => {
    const world = await tempWorld();
    const planner = plannerFor(singleToolLwir());
    const summarize = vi.fn<RuntimeToolHandler>(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      return { summary: "should not complete after the wall-clock budget" };
    });
    const now = vi.spyOn(Date, "now");
    let nowCallCount = 0;
    now.mockImplementation(() => {
      nowCallCount += 1;
      if (nowCallCount === 1) {
        return 0;
      }
      return 300;
    });

    try {
      await expect(
        runWorkflow({
          world,
          workflows: ticketWorkflow,
          input: { ticketId: "TIN-12", body: "Cannot export invoices." },
          planner,
          tools: ticketRegistryWith(summarize),
          runId: "run_public_wall_clock_timeout",
          timeout: 1_500,
        }),
      ).rejects.toMatchObject({
        name: "RunFailedError",
        runId: "run_public_wall_clock_timeout",
        causeCode: "timeout",
      });
    } finally {
      now.mockRestore();
    }
    expect(summarize).toHaveBeenCalledTimes(1);
  });

  it("registers compiled workflow versions before post-compile timeout failure", async () => {
    const world = await tempWorld();
    const planner = plannerFor(singleToolLwir());
    const summarize = vi.fn<RuntimeToolHandler>(() => ({ summary: "should not run" }));
    const now = vi.spyOn(Date, "now");
    let nowCallCount = 0;
    now.mockImplementation(() => {
      nowCallCount += 1;
      if (nowCallCount === 1) {
        return 0;
      }
      return 100_001;
    });

    try {
      await expect(
        runWorkflow({
          world,
          workflows: ticketWorkflow,
          input: { ticketId: "TIN-12", body: "Cannot export invoices." },
          planner,
          tools: ticketRegistryWith(summarize),
          runId: "run_public_post_compile_timeout_registered",
          timeout: 100_000,
        }),
      ).rejects.toMatchObject({
        name: "RunFailedError",
        runId: "run_public_post_compile_timeout_registered",
        causeCode: "timeout",
      });
    } finally {
      now.mockRestore();
    }

    expect(summarize).not.toHaveBeenCalled();
    expect(planner.draft).toHaveBeenCalledTimes(1);
    expect((await listEvents(world, "run_public_post_compile_timeout_registered")).map((event) => event.type))
      .toEqual([
        "OrchestrationRequested",
        "PlannerStarted",
        "PlannerDraftedWorkflow",
        "WorkflowValidationSucceeded",
        "WorkflowVersionRegistered",
        "RunStarted",
        "RunFailed",
      ]);
  });

  it("marks runs as cancelled when aborted during execution", async () => {
    const world = await tempWorld();
    const planner = plannerFor(singleToolLwir());
    const controller = new AbortController();
    let runtimeSignal: AbortSignal | undefined;
    const summarize = vi.fn<RuntimeToolHandler>(async (_input, context) => {
      runtimeSignal = context.signal;
      controller.abort();
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { summary: "should not complete" };
    });

    await expect(
      runWorkflow({
        world,
        workflows: ticketWorkflow,
        input: { ticketId: "TIN-12", body: "Cannot export invoices." },
        planner,
        tools: ticketRegistryWith(summarize),
        runId: "run_public_execution_cancelled",
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({
      name: "RunFailedError",
      runId: "run_public_execution_cancelled",
      causeCode: "cancelled",
    });
    expect(runtimeSignal?.aborted).toBe(true);
  });

  it("records cancellation attempts as terminal and does not resume them", async () => {
    const world = await tempWorld();
    const planner = plannerFor(singleToolLwir());
    const controller = new AbortController();
    const summarize = vi.fn<RuntimeToolHandler>(async () => {
      controller.abort();
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { summary: "should not complete" };
    });

    await expect(
      runWorkflow({
        world,
        workflows: ticketWorkflow,
        input: { ticketId: "TIN-12", body: "Cannot export invoices." },
        planner,
        tools: ticketRegistryWith(summarize),
        runId: "run_public_terminal_cancelled",
        signal: controller.signal,
        maxAttempts: 2,
      }),
    ).rejects.toMatchObject({
      name: "RunFailedError",
      runId: "run_public_terminal_cancelled",
      causeCode: "cancelled",
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    const eventsAfterCancel = await listEvents(world, "run_public_terminal_cancelled");
    expect(eventsAfterCancel.filter((event) => event.type === "StepFailed")).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          stepPath: "summarize",
          error: expect.objectContaining({ name: "AbortError", retriable: false }),
        }),
      }),
    ]);
    const eventTypesAfterCancel = eventsAfterCancel.map((event) => event.type);
    expect(eventTypesAfterCancel).not.toContain("harness.tool_call.succeeded");
    expect(eventTypesAfterCancel).not.toContain("harness.execute_step.succeeded");
    expect(eventTypesAfterCancel).not.toContain("harness.session.completed");
    expect(eventTypesAfterCancel).not.toContain("harness.session.failed");

    const resumedTool = vi.fn<RuntimeToolHandler>(() => ({ summary: "should not resume" }));
    await expect(
      runWorkflow({
        world,
        workflows: ticketWorkflow,
        input: { ticketId: "TIN-12", body: "Cannot export invoices." },
        planner,
        tools: ticketRegistryWith(resumedTool),
        runId: "run_public_terminal_cancelled",
        maxAttempts: 2,
      }),
    ).rejects.toMatchObject({
      name: "RunFailedError",
      runId: "run_public_terminal_cancelled",
      causeCode: "cancelled",
    });
    expect(resumedTool).not.toHaveBeenCalled();
    await expect(listEvents(world, "run_public_terminal_cancelled")).resolves.toHaveLength(
      eventsAfterCancel.length,
    );
  });

  it("does not recompile or append after a pre-planning cancellation for the same runId", async () => {
    const world = await tempWorld();
    const firstPlanner = plannerFor(singleToolLwir());
    const controller = new AbortController();
    controller.abort();

    await expect(
      runWorkflow({
        world,
        workflows: ticketWorkflow,
        input: { ticketId: "TIN-12", body: "Cannot export invoices." },
        planner: firstPlanner,
        tools: ticketRegistryWith(() => ({ summary: "should not run" })),
        runId: "run_public_pre_cancel_replay",
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ causeCode: "cancelled" });
    expect(firstPlanner.draft).not.toHaveBeenCalled();
    const eventsAfterFailure = await listEvents(world, "run_public_pre_cancel_replay");

    const replayPlanner = plannerFor(singleToolLwir());
    await expect(
      runWorkflow({
        world,
        workflows: ticketWorkflow,
        input: { ticketId: "TIN-12", body: "Cannot export invoices." },
        planner: replayPlanner,
        tools: ticketRegistryWith(() => ({ summary: "should not resume" })),
        runId: "run_public_pre_cancel_replay",
      }),
    ).rejects.toMatchObject({
      name: "RunFailedError",
      runId: "run_public_pre_cancel_replay",
      causeCode: "cancelled",
    });
    expect(replayPlanner.draft).not.toHaveBeenCalled();
    await expect(listEvents(world, "run_public_pre_cancel_replay")).resolves.toHaveLength(
      eventsAfterFailure.length,
    );
  });

  it("repairs a registered-only run log before executing", async () => {
    const world = await tempWorld();
    const planner = plannerFor(singleToolLwir());
    const compiled = await compileWorkflow(ticketWorkflow, {
      input: { ticketId: "TIN-12", body: "Cannot export invoices." },
      tools: ticketToolRegistry,
      planner,
    });
    await appendEvent(world, "run_public_registered_only_resume", {
      type: "WorkflowVersionRegistered",
      payload: {
        workflowVersionId: compiled.workflowVersion.id,
        workflowVersionHash: compiled.workflowVersion.hash,
      },
    });
    const summarize = vi.fn<RuntimeToolHandler>(() => ({ summary: "Cannot export invoices." }));

    const result = await runWorkflow({
      world,
      workflows: ticketWorkflow,
      input: { ticketId: "TIN-12", body: "Cannot export invoices." },
      planner: plannerFor(singleToolLwir()),
      tools: ticketRegistryWith(summarize),
      runId: "run_public_registered_only_resume",
    });

    expect(result.status).toBe("completed");
    expect(result.output).toEqual({ summary: "Cannot export invoices." });
    const events = await listEvents(world, "run_public_registered_only_resume");
    expect(events.map((event) => event.type)).toContain("RunStarted");
    expect(summarize).toHaveBeenCalledTimes(1);

    await expect(
      runWorkflow({
        world,
        workflows: ticketWorkflow,
        input: { ticketId: "TIN-12", body: "Cannot export invoices." },
        runId: "run_public_registered_only_resume",
      }),
    ).resolves.toMatchObject({
      status: "completed",
      output: { summary: "Cannot export invoices." },
    });
  });

  it("keeps direct registered-only replay locked to the WorkflowVersion planned input without reuse approval", async () => {
    const world = await tempWorld();
    const compiled = await compileWorkflow(ticketWorkflow, {
      input: { ticketId: "TIN-12", body: "Cannot export invoices." },
      tools: ticketToolRegistry,
      planner: plannerFor(singleToolLwir()),
    });
    await appendEvent(world, "run_direct_registered_only_changed_input", {
      type: "WorkflowVersionRegistered",
      payload: {
        workflowVersionId: compiled.workflowVersion.id,
        workflowVersionHash: compiled.workflowVersion.hash,
      },
    });
    const summarize = vi.fn<RuntimeToolHandler>(() => ({ summary: "Should not run." }));

    await expect(
      executeWorkflowVersion({
        world,
        workflowVersion: compiled.workflowVersion,
        input: { ticketId: "TIN-13", body: "Cannot import receipts." },
        tools: ticketRegistryWith(summarize),
        runId: "run_direct_registered_only_changed_input",
      }),
    ).rejects.toThrow("WorkflowVersion inputHash does not match run input.");
    expect(summarize).not.toHaveBeenCalled();
  });

  it("repairs a partial planner-reviewed reuse log with changed schema-compatible input without replanning", async () => {
    const world = await tempWorld();
    const firstInput = { ticketId: "TIN-12", body: "Cannot export invoices." };
    const secondInput = { ticketId: "TIN-13", body: "Cannot import receipts." };
    const initialPlanner = plannerFor(singleToolLwir());
    const summarize = vi.fn<RuntimeToolHandler>((toolInput) => {
      const typed = toolInput as { ticketId: string; body: string };
      return { summary: `${typed.ticketId}:${typed.body}` };
    });
    const first = await runWorkflow({
      world,
      workflows: ticketWorkflow,
      input: firstInput,
      planner: initialPlanner,
      tools: ticketRegistryWith(summarize),
      runId: "run_partial_reuse_replay_first",
      workflowVersionReuseStrategy: "planner_reviewed",
    });
    const registration = first.events.find((event) => event.type === "WorkflowVersionRegistered");
    if (registration === undefined) {
      throw new Error("Expected first run to register a WorkflowVersion.");
    }
    await appendEvent(world, "run_partial_reuse_replay_second", {
      type: "PlannerReuseDecisionRecorded",
      payload: {
        decisionKind: "reuse_unchanged",
        candidateWorkflowVersionId: first.workflowVersionId,
        rationale: "Reuse remains valid for a new ticket.",
        acknowledgedWarnings: [],
        inputHash: sha256Digest(secondInput),
        candidateBriefHash: sha256Digest("partial reuse replay brief"),
        resultingWorkflowVersionId: first.workflowVersionId,
      },
    });
    await appendEvent(world, "run_partial_reuse_replay_second", {
      type: "WorkflowVersionRegistered",
      payload: registration.payload,
    });
    const replayPlanner: PlannerAdapter = {
      draft: vi.fn(async () => {
        throw new Error("planner should not be called while repairing partial reuse replay");
      }),
    };

    const second = await runWorkflow({
      world,
      workflows: ticketWorkflow,
      input: secondInput,
      planner: replayPlanner,
      tools: ticketRegistryWith(summarize),
      runId: "run_partial_reuse_replay_second",
      workflowVersionReuseStrategy: "planner_reviewed",
    });

    expect(replayPlanner.draft).not.toHaveBeenCalled();
    expect(second.workflowVersionId).toBe(first.workflowVersionId);
    expect(second.output).toEqual({ summary: "TIN-13:Cannot import receipts." });
    const secondEvents = await listEvents(world, "run_partial_reuse_replay_second");
    expect(secondEvents.map((event) => event.type)).toContain("RunStarted");
    expect(secondEvents.find((event) => event.type === "RunStarted")?.payload)
      .toEqual(expect.objectContaining({
        workflowVersionId: first.workflowVersionId,
        input: secondInput,
      }));
  });

  it("rejects partial planner-reviewed reuse replay when a worker-backed tool.call harness changes", async () => {
    const world = await tempWorld();
    const input = { ticketId: "TIN-12", body: "Cannot export invoices." };
    const workerHarnessV1 = {
      harnessId: "workerHarness@1.0.0",
      run: vi.fn<Harness["run"]>(async () => ({
        kind: "execute_step",
        output: { summary: "from worker v1" },
        artifactRefs: [],
      })),
    } satisfies Harness & { readonly harnessId: string };
    const workerHarnessV2 = {
      harnessId: "workerHarness@2.0.0",
      run: vi.fn<Harness["run"]>(async () => ({
        kind: "execute_step",
        output: { summary: "from worker v2" },
        artifactRefs: [],
      })),
    } satisfies Harness & { readonly harnessId: string };
    const workflowWithHarnessV1 = createLittleWorkflow({
      ...ticketWorkflow,
      worker: { harness: workerHarnessV1 },
    } as unknown as Parameters<typeof createLittleWorkflow>[0]);
    const first = await runWorkflow({
      world,
      workflows: workflowWithHarnessV1,
      input,
      planner: plannerFor(singleToolLwir()),
      tools: ticketRegistryWith(() => ({ summary: "from direct tool" })),
      runId: "run_partial_reuse_tool_harness_first",
      workflowVersionReuseStrategy: "planner_reviewed",
    });
    const registration = first.events.find((event) => event.type === "WorkflowVersionRegistered");
    if (registration === undefined) {
      throw new Error("Expected first run to register a WorkflowVersion.");
    }
    await appendPartialReuseReplayPrefix(world, "run_partial_reuse_tool_harness_second", {
      workflowVersionId: first.workflowVersionId,
      input,
      registrationPayload: registration.payload,
    });
    const workflowWithHarnessV2 = createLittleWorkflow({
      ...ticketWorkflow,
      worker: { harness: workerHarnessV2 },
    } as unknown as Parameters<typeof createLittleWorkflow>[0]);
    const replayPlanner: PlannerAdapter = {
      draft: vi.fn(async () => {
        throw new Error("planner should not be called while repairing partial reuse replay");
      }),
    };

    await expect(
      runWorkflow({
        world,
        workflows: workflowWithHarnessV2,
        input,
        planner: replayPlanner,
        tools: ticketRegistryWith(() => ({ summary: "from direct tool" })),
        runId: "run_partial_reuse_tool_harness_second",
        workflowVersionReuseStrategy: "planner_reviewed",
      }),
    ).rejects.toThrow(/capability_drift.*worker harness changed/u);
    expect(replayPlanner.draft).not.toHaveBeenCalled();
    expect(workerHarnessV2.run).not.toHaveBeenCalled();
  });

  it("rejects partial planner-reviewed reuse replay when a tool descriptor changes", async () => {
    const world = await tempWorld();
    const input = { ticketId: "TIN-12", body: "Cannot export invoices." };
    const first = await runWorkflow({
      world,
      workflows: ticketWorkflow,
      input,
      planner: plannerFor(singleToolLwir()),
      tools: ticketRegistryWith(() => ({ summary: "first run" })),
      runId: "run_partial_reuse_tool_descriptor_first",
      workflowVersionReuseStrategy: "planner_reviewed",
    });
    const registration = first.events.find((event) => event.type === "WorkflowVersionRegistered");
    if (registration === undefined) {
      throw new Error("Expected first run to register a WorkflowVersion.");
    }
    await appendPartialReuseReplayPrefix(world, "run_partial_reuse_tool_descriptor_second", {
      workflowVersionId: first.workflowVersionId,
      input,
      registrationPayload: registration.payload,
    });
    const driftedRegistry = createToolRegistry();
    const driftedSummarize = vi.fn<RuntimeToolHandler>(() => ({ summary: "should not run" }));
    driftedRegistry.register("summarize", {
      description: "Summarize a ticket with a drifted descriptor.",
      inputSchema: ticketInputSchema,
      execute: driftedSummarize as (input: unknown, context: unknown) => Promise<unknown>,
    });
    const replayPlanner: PlannerAdapter = {
      draft: vi.fn(async () => {
        throw new Error("planner should not be called while repairing partial reuse replay");
      }),
    };

    await expect(
      runWorkflow({
        world,
        workflows: ticketWorkflow,
        input,
        planner: replayPlanner,
        tools: driftedRegistry,
        runId: "run_partial_reuse_tool_descriptor_second",
        workflowVersionReuseStrategy: "planner_reviewed",
      }),
    ).rejects.toThrow(/capability_drift.*tool 'summarize'/u);
    expect(replayPlanner.draft).not.toHaveBeenCalled();
    expect(driftedSummarize).not.toHaveBeenCalled();
  });

  it("rejects partial planner-reviewed reuse replay when a code.run worker harness changes", async () => {
    const world = await tempWorld();
    const input = { ticketId: "TIN-12" };
    const workerHarnessV1 = {
      harnessId: "codeWorkerHarness@1.0.0",
      run: vi.fn<Harness["run"]>(async () => ({
        kind: "execute_step",
        output: { final: "from worker v1" },
        artifactRefs: [],
      })),
    } satisfies Harness & { readonly harnessId: string };
    const workerHarnessV2 = {
      harnessId: "codeWorkerHarness@2.0.0",
      run: vi.fn<Harness["run"]>(async () => ({
        kind: "execute_step",
        output: { final: "from worker v2" },
        artifactRefs: [],
      })),
    } satisfies Harness & { readonly harnessId: string };
    const first = await runWorkflow({
      world,
      workflows: codeRunWorkflow(workerHarnessV1),
      input,
      planner: plannerFor(codeRunLwir()),
      runId: "run_partial_reuse_code_harness_first",
      workflowVersionReuseStrategy: "planner_reviewed",
    });
    const registration = first.events.find((event) => event.type === "WorkflowVersionRegistered");
    if (registration === undefined) {
      throw new Error("Expected first run to register a WorkflowVersion.");
    }
    await appendPartialReuseReplayPrefix(world, "run_partial_reuse_code_harness_second", {
      workflowVersionId: first.workflowVersionId,
      input,
      registrationPayload: registration.payload,
    });
    const replayPlanner: PlannerAdapter = {
      draft: vi.fn(async () => {
        throw new Error("planner should not be called while repairing partial reuse replay");
      }),
    };

    await expect(
      runWorkflow({
        world,
        workflows: codeRunWorkflow(workerHarnessV2),
        input,
        planner: replayPlanner,
        runId: "run_partial_reuse_code_harness_second",
        workflowVersionReuseStrategy: "planner_reviewed",
      }),
    ).rejects.toThrow(/capability_drift.*worker harness changed/u);
    expect(replayPlanner.draft).not.toHaveBeenCalled();
    expect(workerHarnessV2.run).not.toHaveBeenCalled();
  });

  it("rejects partial planner-reviewed reuse replay when an ai.generate worker harness changes", async () => {
    const world = await tempWorld();
    const input = { text: "hello world" };
    const stubModel = { providerId: "stub", modelId: "stub-model" };
    const workerSlot = model(stubModel, { id: "model.fast" });
    const aiLoop = {
      generate: vi.fn(async () => ({
        output: { summary: "stub summary" },
        usage: { inputTokens: 5, outputTokens: 3 },
      })),
    };
    const workflowHarness = createWorkflowHarness({ aiLoop });
    const workerHarnessV1 = {
      harnessId: "workerHarness@1.0.0",
      run: workflowHarness.run,
    } satisfies Harness & { readonly harnessId: string };
    const workerHarnessV2 = {
      harnessId: "workerHarness@2.0.0",
      run: workflowHarness.run,
    } satisfies Harness & { readonly harnessId: string };
    const aiWorkflowV1 = createLittleWorkflow({
      id: "p1-5.ai-generate",
      description: "Single ai.generate step with model.fast slot.",
      inputSchema: aiInputSchema,
      output: output.object({ schema: aiOutputSchema }),
      models: [workerSlot],
      worker: { harness: workerHarnessV1 },
    } as unknown as Parameters<typeof createLittleWorkflow>[0]);
    const first = await runWorkflow({
      world,
      workflows: aiWorkflowV1,
      input,
      planner: plannerFor(aiGenerateLwir()),
      runId: "run_partial_reuse_ai_harness_first",
      workflowVersionReuseStrategy: "planner_reviewed",
    });
    const registration = first.events.find((event) => event.type === "WorkflowVersionRegistered");
    if (registration === undefined) {
      throw new Error("Expected first run to register a WorkflowVersion.");
    }
    await appendPartialReuseReplayPrefix(world, "run_partial_reuse_ai_harness_second", {
      workflowVersionId: first.workflowVersionId,
      input,
      registrationPayload: registration.payload,
    });
    const aiWorkflowV2 = createLittleWorkflow({
      id: "p1-5.ai-generate",
      description: "Single ai.generate step with model.fast slot.",
      inputSchema: aiInputSchema,
      output: output.object({ schema: aiOutputSchema }),
      models: [workerSlot],
      worker: { harness: workerHarnessV2 },
    } as unknown as Parameters<typeof createLittleWorkflow>[0]);
    const replayPlanner: PlannerAdapter = {
      draft: vi.fn(async () => {
        throw new Error("planner should not be called while repairing partial reuse replay");
      }),
    };

    await expect(
      runWorkflow({
        world,
        workflows: aiWorkflowV2,
        input,
        planner: replayPlanner,
        runId: "run_partial_reuse_ai_harness_second",
        workflowVersionReuseStrategy: "planner_reviewed",
      }),
    ).rejects.toThrow(/capability_drift.*worker harness changed/u);
    expect(replayPlanner.draft).not.toHaveBeenCalled();
    expect(aiLoop.generate).toHaveBeenCalledOnce();
  });

  it("rejects partial planner-reviewed reuse replay when an ai.generate model identity changes", async () => {
    const world = await tempWorld();
    const input = { text: "hello world" };
    const workerSlotV1 = model(
      { providerId: "stub", modelId: "stub-model-v1" },
      { id: "model.fast" },
    );
    const workerSlotV2 = model(
      { providerId: "stub", modelId: "stub-model-v2" },
      { id: "model.fast" },
    );
    const aiLoop = {
      generate: vi.fn(async () => ({
        output: { summary: "stub summary" },
        usage: { inputTokens: 5, outputTokens: 3 },
      })),
    };
    const workerHarness = createWorkflowHarness({ aiLoop });
    const aiWorkflowV1 = createLittleWorkflow({
      id: "p1-5.ai-generate",
      description: "Single ai.generate step with model.fast slot.",
      inputSchema: aiInputSchema,
      output: output.object({ schema: aiOutputSchema }),
      models: [workerSlotV1],
      worker: { harness: workerHarness },
    } as unknown as Parameters<typeof createLittleWorkflow>[0]);
    const first = await runWorkflow({
      world,
      workflows: aiWorkflowV1,
      input,
      planner: plannerFor(aiGenerateLwir()),
      runId: "run_partial_reuse_ai_model_first",
      workflowVersionReuseStrategy: "planner_reviewed",
    });
    const registration = first.events.find((event) => event.type === "WorkflowVersionRegistered");
    if (registration === undefined) {
      throw new Error("Expected first run to register a WorkflowVersion.");
    }
    await appendPartialReuseReplayPrefix(world, "run_partial_reuse_ai_model_second", {
      workflowVersionId: first.workflowVersionId,
      input,
      registrationPayload: registration.payload,
    });
    const aiWorkflowV2 = createLittleWorkflow({
      id: "p1-5.ai-generate",
      description: "Single ai.generate step with model.fast slot.",
      inputSchema: aiInputSchema,
      output: output.object({ schema: aiOutputSchema }),
      models: [workerSlotV2],
      worker: { harness: workerHarness },
    } as unknown as Parameters<typeof createLittleWorkflow>[0]);
    const replayPlanner: PlannerAdapter = {
      draft: vi.fn(async () => {
        throw new Error("planner should not be called while repairing partial reuse replay");
      }),
    };

    await expect(
      runWorkflow({
        world,
        workflows: aiWorkflowV2,
        input,
        planner: replayPlanner,
        runId: "run_partial_reuse_ai_model_second",
        workflowVersionReuseStrategy: "planner_reviewed",
      }),
    ).rejects.toThrow(/capability_drift.*model 'model\.fast'/u);
    expect(replayPlanner.draft).not.toHaveBeenCalled();
    expect(aiLoop.generate).toHaveBeenCalledOnce();
  });

  it("rejects partial planner-reviewed reuse replay when worker-backed tool.call bash capabilities change", async () => {
    const world = await tempWorld();
    const input = { ticketId: "TIN-12", body: "Cannot export invoices." };
    const workerHarness = {
      harnessId: "workerHarness@1.0.0",
      run: vi.fn<Harness["run"]>(async () => ({
        kind: "execute_step",
        output: { summary: "from worker harness" },
        artifactRefs: [],
      })),
    } satisfies Harness & { readonly harnessId: string };
    const workflowWithBashDisabled = createLittleWorkflow({
      ...ticketWorkflow,
      worker: { harness: workerHarness },
      bash: { javascript: false },
    } as unknown as Parameters<typeof createLittleWorkflow>[0]);
    const first = await runWorkflow({
      world,
      workflows: workflowWithBashDisabled,
      input,
      planner: plannerFor(singleToolLwir()),
      tools: ticketRegistryWith(() => ({ summary: "from direct tool" })),
      runId: "run_partial_reuse_tool_bash_first",
      workflowVersionReuseStrategy: "planner_reviewed",
    });
    const registration = first.events.find((event) => event.type === "WorkflowVersionRegistered");
    if (registration === undefined) {
      throw new Error("Expected first run to register a WorkflowVersion.");
    }
    await appendPartialReuseReplayPrefix(world, "run_partial_reuse_tool_bash_second", {
      workflowVersionId: first.workflowVersionId,
      input,
      registrationPayload: registration.payload,
    });
    const workflowWithBashEnabled = createLittleWorkflow({
      ...ticketWorkflow,
      worker: { harness: workerHarness },
      bash: { javascript: true },
    } as unknown as Parameters<typeof createLittleWorkflow>[0]);
    const replayPlanner: PlannerAdapter = {
      draft: vi.fn(async () => {
        throw new Error("planner should not be called while repairing partial reuse replay");
      }),
    };

    await expect(
      runWorkflow({
        world,
        workflows: workflowWithBashEnabled,
        input,
        planner: replayPlanner,
        tools: ticketRegistryWith(() => ({ summary: "from direct tool" })),
        runId: "run_partial_reuse_tool_bash_second",
        workflowVersionReuseStrategy: "planner_reviewed",
      }),
    ).rejects.toThrow(/capability_drift.*bash capability/u);
    expect(replayPlanner.draft).not.toHaveBeenCalled();
    expect(workerHarness.run).toHaveBeenCalledTimes(1);
  });

  it("rejects partial planner-reviewed reuse replay when the recorded decision inputHash differs from run input", async () => {
    const world = await tempWorld();
    const firstInput = { ticketId: "TIN-12", body: "Cannot export invoices." };
    const approvedInput = { ticketId: "TIN-13", body: "Cannot import receipts." };
    const replayInput = { ticketId: "TIN-14", body: "Cannot sync contacts." };
    const first = await runWorkflow({
      world,
      workflows: ticketWorkflow,
      input: firstInput,
      planner: plannerFor(singleToolLwir()),
      tools: ticketRegistryWith((toolInput) => {
        const typed = toolInput as { ticketId: string; body: string };
        return { summary: `${typed.ticketId}:${typed.body}` };
      }),
      runId: "run_partial_reuse_hash_mismatch_first",
      workflowVersionReuseStrategy: "planner_reviewed",
    });
    const registration = first.events.find((event) => event.type === "WorkflowVersionRegistered");
    if (registration === undefined) {
      throw new Error("Expected first run to register a WorkflowVersion.");
    }
    await appendEvent(world, "run_partial_reuse_hash_mismatch_second", {
      type: "PlannerReuseDecisionRecorded",
      payload: {
        decisionKind: "reuse_unchanged",
        candidateWorkflowVersionId: first.workflowVersionId,
        rationale: "Approved for a different input.",
        acknowledgedWarnings: [],
        inputHash: sha256Digest(approvedInput),
        candidateBriefHash: sha256Digest("partial reuse hash mismatch brief"),
        resultingWorkflowVersionId: first.workflowVersionId,
      },
    });
    await appendEvent(world, "run_partial_reuse_hash_mismatch_second", {
      type: "WorkflowVersionRegistered",
      payload: registration.payload,
    });
    const replayPlanner: PlannerAdapter = {
      draft: vi.fn(async () => {
        throw new Error("planner should not be called for mismatched partial reuse replay");
      }),
    };
    const summarize = vi.fn<RuntimeToolHandler>(() => ({ summary: "Should not run." }));

    await expect(
      runWorkflow({
        world,
        workflows: ticketWorkflow,
        input: replayInput,
        planner: replayPlanner,
        tools: ticketRegistryWith(summarize),
        runId: "run_partial_reuse_hash_mismatch_second",
        workflowVersionReuseStrategy: "planner_reviewed",
      }),
    ).rejects.toThrow(/Planner reuse decision inputHash does not match run input/u);
    expect(replayPlanner.draft).not.toHaveBeenCalled();
    expect(summarize).not.toHaveBeenCalled();
    const secondEvents = await listEvents(world, "run_partial_reuse_hash_mismatch_second");
    expect(secondEvents.map((event) => event.type)).not.toContain("RunStarted");
  });

  it("repairs legacy compiled lifecycle prefixes with registered-only payloads", async () => {
    const world = await tempWorld();
    const planner = plannerFor(singleToolLwir());
    const input = { ticketId: "TIN-12", body: "Cannot export invoices." };
    const compiled = await compileWorkflow(ticketWorkflow, { input, tools: ticketToolRegistry, planner });
    const revision = compiled.revisions[0];
    if (revision === undefined) {
      throw new Error("Expected a compiler revision.");
    }
    await appendEvent(world, "run_public_legacy_registered_prefix", {
      type: "OrchestrationRequested",
      payload: {
        requestId: compiled.request.requestId,
        requestHash: compiled.request.locks.requestHash,
        inputHash: compiled.request.locks.inputHash,
        workflowDefinitionHash: compiled.request.locks.workflowDefinitionHash,
        inputSchemaHash: compiled.request.locks.inputSchemaHash,
        requestedOutputHash: compiled.request.locks.requestedOutputHash,
        capabilityManifestHash: sha256Digest(compiled.request.capabilityManifest),
        workflowId: compiled.request.metadata.name,
        description: compiled.request.metadata.description,
        maxWorkflowRevisions: compiled.request.controls.maxWorkflowRevisions,
      },
    });
    await appendEvent(world, "run_public_legacy_registered_prefix", {
      type: "PlannerStarted",
      payload: { requestId: compiled.request.requestId, revision: 1, repair: false },
    });
    await appendEvent(world, "run_public_legacy_registered_prefix", {
      type: "PlannerDraftedWorkflow",
      payload: {
        requestId: compiled.request.requestId,
        revision: revision.revision,
        valid: revision.valid,
        lwirHash: sha256Digest(revision.lwir),
        lwir: revision.lwir,
      },
    });
    await appendEvent(world, "run_public_legacy_registered_prefix", {
      type: "WorkflowValidationSucceeded",
      payload: {
        requestId: compiled.request.requestId,
        revision: revision.revision,
        lwirHash: sha256Digest(revision.lwir),
        workflowVersionId: compiled.workflowVersion.id,
        lwirVersionId: compiled.workflowVersion.lwirVersionId,
        validationHash: compiled.workflowVersion.lock.validationHash,
      },
    });
    await appendEvent(world, "run_public_legacy_registered_prefix", {
      type: "WorkflowVersionRegistered",
      payload: {
        workflowVersionId: compiled.workflowVersion.id,
        workflowVersionHash: compiled.workflowVersion.hash,
      },
    });
    const summarize = vi.fn<RuntimeToolHandler>(() => ({ summary: "Cannot export invoices." }));

    const result = await runWorkflow({
      world,
      workflows: ticketWorkflow,
      input,
      planner: plannerFor(singleToolLwir()),
      tools: ticketRegistryWith(summarize),
      runId: "run_public_legacy_registered_prefix",
    });

    expect(result.status).toBe("completed");
    expect(summarize).toHaveBeenCalledTimes(1);
    expect((await listEvents(world, "run_public_legacy_registered_prefix")).map((event) => event.type))
      .toContain("RunStarted");
  });

  it("does not repair legacy compiled lifecycle prefixes with unsafe registration payloads", async () => {
    const input = { ticketId: "TIN-12", body: "Cannot export invoices." };
    const compiled = await compileWorkflow(ticketWorkflow, {
      input,
      tools: ticketToolRegistry,
      planner: plannerFor(singleToolLwir()),
    });
    const cases = [
      {
        runId: "run_public_legacy_registered_missing_hash",
        payload: { workflowVersionId: compiled.workflowVersion.id },
      },
      {
        runId: "run_public_legacy_registered_wrong_hash",
        payload: {
          workflowVersionId: compiled.workflowVersion.id,
          workflowVersionHash: `sha256:${"0".repeat(64)}`,
        },
      },
      {
        runId: "run_public_legacy_registered_wrong_id",
        payload: {
          workflowVersionId: "wfver_wrong",
          workflowVersionHash: compiled.workflowVersion.hash,
        },
      },
      {
        runId: "run_public_legacy_registered_bad_extra",
        payload: {
          workflowVersionId: compiled.workflowVersion.id,
          workflowVersionHash: compiled.workflowVersion.hash,
          lwirHash: `sha256:${"0".repeat(64)}`,
        },
      },
    ];

    for (const entry of cases) {
      const world = await tempWorld();
      const summarize = vi.fn<RuntimeToolHandler>(() => ({ summary: "should not run" }));
      await appendLegacyCompiledLifecyclePrefix(world, entry.runId, compiled, entry.payload);

      await expect(
        runWorkflow({
          world,
          workflows: ticketWorkflow,
          input,
          planner: plannerFor(singleToolLwir()),
          tools: ticketRegistryWith(summarize),
          runId: entry.runId,
        }),
      ).rejects.toThrow();
      expect(summarize).not.toHaveBeenCalled();
      expect((await listEvents(world, entry.runId)).map((event) => event.type))
        .not.toContain("RunStarted");
    }
  });

  it("rejects malformed logs without RunStarted instead of repairing them", async () => {
    const world = await tempWorld();
    const planner = plannerFor(singleToolLwir());
    const compiled = await compileWorkflow(ticketWorkflow, {
      input: { ticketId: "TIN-12", body: "Cannot export invoices." },
      tools: ticketToolRegistry,
      planner,
    });
    await appendEvent(world, "run_public_malformed_no_start", {
      type: "WorkflowVersionRegistered",
      payload: {
        workflowVersionId: compiled.workflowVersion.id,
        workflowVersionHash: compiled.workflowVersion.hash,
      },
    });
    await appendEvent(world, "run_public_malformed_no_start", {
      type: "StepScheduled",
      payload: { stepPath: "summarize", stepId: "summarize", uses: "tool.call" },
    });

    await expect(
      runWorkflow({
        world,
        workflows: ticketWorkflow,
        input: { ticketId: "TIN-12", body: "Cannot export invoices." },
        planner: plannerFor(singleToolLwir()),
        tools: ticketRegistryWith(() => ({ summary: "should not run" })),
        runId: "run_public_malformed_no_start",
      }),
    ).rejects.toThrow("missing RunStarted");
  });

  it("rejects terminal failed logs without RunStarted instead of replaying them", async () => {
    const world = await tempWorld();
    await appendEvent(world, "run_public_terminal_failed_no_start", {
      type: "RunFailed",
      payload: {
        workflowVersionId: "wfver_manual_terminal_no_start",
        error: {
          name: "TimeoutError",
          message: "Run timed out.",
          causeCode: "timeout",
          retriable: false,
        },
      },
    });
    const planner = plannerFor(singleToolLwir());

    await expect(
      runWorkflow({
        world,
        workflows: ticketWorkflow,
        input: { ticketId: "TIN-12", body: "Cannot export invoices." },
        planner,
        tools: ticketRegistryWith(() => ({ summary: "should not run" })),
        runId: "run_public_terminal_failed_no_start",
      }),
    ).rejects.toThrow("missing RunStarted");
    expect(planner.draft).not.toHaveBeenCalled();
  });

  it("rejects terminal failed logs without RunStarted before cause classification", async () => {
    const world = await tempWorld();
    await appendEvent(world, "run_public_terminal_failed_no_start_unknown_cause", {
      type: "RunFailed",
      payload: {
        workflowVersionId: "wfver_manual_terminal_no_start_unknown",
        error: {
          name: "Error",
          message: "unknown terminal failure",
          retriable: false,
        },
      },
    });
    const planner = plannerFor(singleToolLwir());
    const beforeReplay = await listEvents(
      world,
      "run_public_terminal_failed_no_start_unknown_cause",
    );

    await expect(
      runWorkflow({
        world,
        workflows: ticketWorkflow,
        input: { ticketId: "TIN-12", body: "Cannot export invoices." },
        planner,
        tools: ticketRegistryWith(() => ({ summary: "should not run" })),
        runId: "run_public_terminal_failed_no_start_unknown_cause",
      }),
    ).rejects.toThrow("missing RunStarted");
    expect(planner.draft).not.toHaveBeenCalled();
    await expect(listEvents(world, "run_public_terminal_failed_no_start_unknown_cause"))
      .resolves.toHaveLength(beforeReplay.length);
  });

  it("replays legacy pre-runtime cancellation logs without recompiling", async () => {
    const world = await tempWorld();
    await appendEvent(world, "run_public_legacy_pre_cancel", {
      type: "RunStarted",
      payload: { workflowVersionId: "uncompiled" },
    });
    await appendEvent(world, "run_public_legacy_pre_cancel", {
      type: "RunFailed",
      payload: {
        workflowVersionId: "uncompiled",
        error: {
          name: "AbortError",
          message: "Run was cancelled.",
          retriable: false,
        },
      },
    });
    const planner = plannerFor(singleToolLwir());
    const eventsAfterFailure = await listEvents(world, "run_public_legacy_pre_cancel");

    await expect(
      runWorkflow({
        world,
        workflows: ticketWorkflow,
        input: { ticketId: "TIN-12", body: "Cannot export invoices." },
        planner,
        tools: ticketRegistryWith(() => ({ summary: "should not resume" })),
        runId: "run_public_legacy_pre_cancel",
      }),
    ).rejects.toMatchObject({
      name: "RunFailedError",
      runId: "run_public_legacy_pre_cancel",
      causeCode: "cancelled",
    });
    expect(planner.draft).not.toHaveBeenCalled();
    await expect(listEvents(world, "run_public_legacy_pre_cancel")).resolves.toHaveLength(
      eventsAfterFailure.length,
    );
  });

  it("replays legacy pre-runtime timeout logs without recompiling", async () => {
    const world = await tempWorld();
    await appendEvent(world, "run_public_legacy_pre_timeout", {
      type: "RunStarted",
      payload: { workflowVersionId: "uncompiled" },
    });
    await appendEvent(world, "run_public_legacy_pre_timeout", {
      type: "RunFailed",
      payload: {
        workflowVersionId: "uncompiled",
        error: {
          name: "TimeoutError",
          message: "Run timed out.",
          retriable: false,
        },
      },
    });
    const planner = plannerFor(singleToolLwir());
    const eventsAfterFailure = await listEvents(world, "run_public_legacy_pre_timeout");

    await expect(
      runWorkflow({
        world,
        workflows: ticketWorkflow,
        input: { ticketId: "TIN-12", body: "Cannot export invoices." },
        planner,
        tools: ticketRegistryWith(() => ({ summary: "should not resume" })),
        runId: "run_public_legacy_pre_timeout",
      }),
    ).rejects.toMatchObject({
      name: "RunFailedError",
      runId: "run_public_legacy_pre_timeout",
      causeCode: "timeout",
    });
    expect(planner.draft).not.toHaveBeenCalled();
    await expect(listEvents(world, "run_public_legacy_pre_timeout")).resolves.toHaveLength(
      eventsAfterFailure.length,
    );
  });

  it("completes a partial pre-runtime failure log for the same runId", async () => {
    const world = await tempWorld();
    await appendEvent(world, "run_public_partial_pre_failure", {
      type: "RunStarted",
      payload: { workflowVersionId: "uncompiled" },
    });
    const controller = new AbortController();
    controller.abort();
    const planner = plannerFor(singleToolLwir());

    await expect(
      runWorkflow({
        world,
        workflows: ticketWorkflow,
        input: { ticketId: "TIN-12", body: "Cannot export invoices." },
        planner,
        tools: ticketRegistryWith(() => ({ summary: "should not run" })),
        runId: "run_public_partial_pre_failure",
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({
      name: "RunFailedError",
      runId: "run_public_partial_pre_failure",
      causeCode: "cancelled",
    });
    expect(planner.draft).not.toHaveBeenCalled();
    expect((await listEvents(world, "run_public_partial_pre_failure")).map((event) => event.type))
      .toEqual(["RunStarted", "RunFailed"]);
  });

  it("does not recompile or append after a planning timeout for the same runId", async () => {
    const world = await tempWorld();
    const firstPlanner: PlannerAdapter = {
      draft: vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return singleToolLwir();
      }),
    };

    await expect(
      runWorkflow({
        world,
        workflows: ticketWorkflow,
        input: { ticketId: "TIN-12", body: "Cannot export invoices." },
        planner: firstPlanner,
        tools: ticketRegistryWith(() => ({ summary: "should not run" })),
        runId: "run_public_planning_timeout_replay",
        timeout: 1,
      }),
    ).rejects.toMatchObject({ causeCode: "timeout" });
    expect(firstPlanner.draft).toHaveBeenCalledTimes(1);
    const eventsAfterFailure = await listEvents(world, "run_public_planning_timeout_replay");

    const replayPlanner = plannerFor(singleToolLwir());
    await expect(
      runWorkflow({
        world,
        workflows: ticketWorkflow,
        input: { ticketId: "TIN-12", body: "Cannot export invoices." },
        planner: replayPlanner,
        tools: ticketRegistryWith(() => ({ summary: "should not resume" })),
        runId: "run_public_planning_timeout_replay",
      }),
    ).rejects.toMatchObject({
      name: "RunFailedError",
      runId: "run_public_planning_timeout_replay",
      causeCode: "timeout",
    });
    expect(replayPlanner.draft).not.toHaveBeenCalled();
    await expect(listEvents(world, "run_public_planning_timeout_replay")).resolves.toHaveLength(
      eventsAfterFailure.length,
    );
  });

  it("rejects failed pre-runtime replay when orchestration input hash differs", async () => {
    const world = await tempWorld();
    const firstPlanner: PlannerAdapter = {
      draft: vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return singleToolLwir();
      }),
    };

    await expect(
      runWorkflow({
        world,
        workflows: ticketWorkflow,
        input: { ticketId: "TIN-12", body: "Original body." },
        planner: firstPlanner,
        tools: ticketRegistryWith(() => ({ summary: "should not run" })),
        runId: "run_public_planning_timeout_input_mismatch",
        timeout: 1,
      }),
    ).rejects.toMatchObject({ causeCode: "timeout" });
    const eventsAfterFailure = await listEvents(world, "run_public_planning_timeout_input_mismatch");

    await expect(
      runWorkflow({
        world,
        workflows: ticketWorkflow,
        input: { ticketId: "TIN-12", body: "Changed body." },
        planner: plannerFor(singleToolLwir()),
        tools: ticketRegistryWith(() => ({ summary: "should not resume" })),
        runId: "run_public_planning_timeout_input_mismatch",
      }),
    ).rejects.toThrow("Run input mismatch");
    await expect(listEvents(world, "run_public_planning_timeout_input_mismatch")).resolves
      .toHaveLength(eventsAfterFailure.length);
  });

  it("does not recompile or append after an input schema failure for the same runId", async () => {
    const world = await tempWorld();
    const firstPlanner = plannerFor(singleToolLwir());

    await expect(
      runWorkflow({
        world,
        workflows: ticketWorkflow,
        input: { ticketId: "TIN-12" } as never,
        planner: firstPlanner,
        tools: ticketRegistryWith(() => ({ summary: "should not run" })),
        runId: "run_public_input_error_replay",
      }),
    ).rejects.toMatchObject({ causeCode: "input_schema_error" });
    expect(firstPlanner.draft).not.toHaveBeenCalled();
    const eventsAfterFailure = await listEvents(world, "run_public_input_error_replay");

    const replayPlanner = plannerFor(singleToolLwir());
    await expect(
      runWorkflow({
        world,
        workflows: ticketWorkflow,
        input: { ticketId: "TIN-12", body: "Cannot export invoices." },
        planner: replayPlanner,
        tools: ticketRegistryWith(() => ({ summary: "should not resume" })),
        runId: "run_public_input_error_replay",
      }),
    ).rejects.toMatchObject({
      name: "RunFailedError",
      runId: "run_public_input_error_replay",
      causeCode: "input_schema_error",
    });
    expect(replayPlanner.draft).not.toHaveBeenCalled();
    await expect(listEvents(world, "run_public_input_error_replay")).resolves.toHaveLength(
      eventsAfterFailure.length,
    );
  });

  it("does not recompile or append after planner validation exhaustion for the same runId", async () => {
    const world = await tempWorld();
    const invalidPlanner: PlannerAdapter = {
      draft: vi.fn(async () => ({
        apiVersion: "littleworkflow.dev/v0.1",
        kind: "Workflow",
        metadata: { name: "support.summarize" },
        input: { schema: ticketInputSchema },
        output: { schema: ticketOutputSchema },
        steps: [
          {
            id: "call-missing-tool",
            uses: "tool.call",
            with: { tool: "missingTool" },
            output: { mode: "object", schema: ticketOutputSchema },
          },
        ],
      })),
    };

    await expect(
      runWorkflow({
        world,
        workflows: ticketWorkflow,
        input: { ticketId: "TIN-12", body: "Cannot export invoices." },
        planner: invalidPlanner,
        tools: ticketRegistryWith(() => ({ summary: "should not run" })),
        runId: "run_public_compile_error_replay",
      }),
    ).rejects.toMatchObject({ causeCode: "planner_validation_exhausted" });
    expect(invalidPlanner.draft).toHaveBeenCalledTimes(3);
    const eventsAfterFailure = await listEvents(world, "run_public_compile_error_replay");
    expect(eventsAfterFailure.map((event) => event.type)).toEqual([
      "OrchestrationRequested",
      "PlannerStarted",
      "PlannerDraftedWorkflow",
      "WorkflowValidationFailed",
      "PlannerStarted",
      "PlannerDraftedWorkflow",
      "WorkflowValidationFailed",
      "PlannerStarted",
      "PlannerDraftedWorkflow",
      "WorkflowValidationFailed",
      "RunStarted",
      "RunFailed",
    ]);
    expect(eventsAfterFailure.filter((event) => event.type === "WorkflowValidationFailed"))
      .toHaveLength(3);
    expect(eventsAfterFailure.find((event) => event.type === "WorkflowValidationFailed")?.payload)
      .toEqual(expect.objectContaining({
        revision: 1,
        findings: expect.arrayContaining([
          expect.objectContaining({
            message: expect.stringContaining("missingTool"),
          }),
        ]),
      }));

    const replayPlanner = plannerFor(singleToolLwir());
    await expect(
      runWorkflow({
        world,
        workflows: ticketWorkflow,
        input: { ticketId: "TIN-12", body: "Cannot export invoices." },
        planner: replayPlanner,
        tools: ticketRegistryWith(() => ({ summary: "should not resume" })),
        runId: "run_public_compile_error_replay",
      }),
    ).rejects.toMatchObject({
      name: "RunFailedError",
      runId: "run_public_compile_error_replay",
      causeCode: "planner_validation_exhausted",
    });
    expect(replayPlanner.draft).not.toHaveBeenCalled();
    await expect(listEvents(world, "run_public_compile_error_replay")).resolves.toHaveLength(
      eventsAfterFailure.length,
    );
  });

  it("rejects concurrent pre-runtime failures for the same runId without invoking the second planner", async () => {
    const world = await tempWorld();
    const gate = deferred();
    const invalidLwir = {
      apiVersion: "littleworkflow.dev/v0.1",
      kind: "Workflow",
      metadata: { name: "support.summarize" },
      input: { schema: ticketInputSchema },
      output: { schema: ticketOutputSchema },
      steps: [
        {
          id: "call-missing-tool",
          uses: "tool.call",
          with: { tool: "missingTool" },
          output: { mode: "object", schema: ticketOutputSchema },
        },
      ],
    };
    const firstPlanner: PlannerAdapter = {
      draft: vi.fn(async () => {
        await gate.promise;
        return invalidLwir;
      }),
    };
    const secondPlanner: PlannerAdapter = {
      draft: vi.fn(async () => invalidLwir),
    };

    const firstRun = runWorkflow({
      world,
      workflows: ticketWorkflow,
      input: { ticketId: "TIN-12", body: "Cannot export invoices." },
      planner: firstPlanner,
      tools: ticketRegistryWith(() => ({ summary: "should not run" })),
      runId: "run_public_compile_error_concurrent",
    });

    await vi.waitFor(() => {
      expect(firstPlanner.draft).toHaveBeenCalledTimes(1);
    });
    const secondRun = runWorkflow({
      world,
      workflows: ticketWorkflow,
      input: { ticketId: "TIN-12", body: "Cannot export invoices." },
      planner: secondPlanner,
      tools: ticketRegistryWith(() => ({ summary: "should not run" })),
      runId: "run_public_compile_error_concurrent",
    });

    await expect(secondRun).rejects.toThrow(
      "Run 'run_public_compile_error_concurrent' is already executing in this process.",
    );
    expect(secondPlanner.draft).not.toHaveBeenCalled();

    gate.resolve();
    await expect(firstRun).rejects.toMatchObject({
      causeCode: "planner_validation_exhausted",
    });
    expect(firstPlanner.draft).toHaveBeenCalledTimes(3);
    await expect(listEvents(world, "run_public_compile_error_concurrent")).resolves.toHaveLength(
      12,
    );
  });

  it("does not mask live tool descriptor drift", async () => {
    // Compile with the canonical descriptor, then run with a drifted descriptor.
    const world = await tempWorld();
    const planner = plannerFor(singleToolLwir());
    const summarize = vi.fn<RuntimeToolHandler>(() => ({ summary: "drifted" }));

    const compiled = await compileWorkflow(ticketWorkflow, {
      input: { ticketId: "TIN-12", body: "Cannot export invoices." },
      tools: ticketToolRegistry,
      planner,
    });

    // Run with a registry whose descriptor differs from the compiled lock.
    const driftedRegistry = createToolRegistry();
    driftedRegistry.register("summarize", {
      description: "Different tool descriptor.",
      inputSchema: true,
      execute: summarize as (input: unknown, context: unknown) => Promise<unknown>,
    });

    const result = await executeWorkflowVersion({
      world,
      workflowVersion: compiled.workflowVersion,
      input: { ticketId: "TIN-12", body: "Cannot export invoices." },
      tools: driftedRegistry,
      runId: "run_public_tool_drift",
    });
    expect(result.status).toBe("failed");
    expect((result as typeof result & { error?: { message?: string } }).error?.message).toContain("capability_drift");
    expect(summarize).not.toHaveBeenCalled();
  });

  it("does not mask live tool outputSchema drift", async () => {
    // With registry-based tools, drift is detected by comparing the lock's outputSchemaHash
    // against the registry's descriptor at runtime. Compile with outputSchemaA, run with outputSchemaB.
    const world = await tempWorld();
    const outputSchemaA = {
      type: "object",
      required: ["summary"],
      additionalProperties: false,
      properties: {
        summary: { type: "string" },
      },
    };
    const outputSchemaB = {
      type: "object",
      required: ["summary"],
      additionalProperties: false,
      properties: {
        summary: { type: "string", minLength: 1 },
      },
    };
    const registryA = createToolRegistry();
    registryA.register("summarize", {
      description: "Summarize a ticket.",
      inputSchema: ticketInputSchema,
      outputSchema: outputSchemaA,
      execute: async () => ({ summary: "compile-time handler" }),
    });
    const workflowWithOutputSchema = createLittleWorkflow({
      id: "support.summarize",
      description: "Summarize a ticket.",
      inputSchema: ticketInputSchema,
      output: output.object({ schema: outputSchemaA }),
      globalTools: ["summarize"],
    } as unknown as Parameters<typeof createLittleWorkflow>[0]);
    const planner = plannerFor({
      apiVersion: "littleworkflow.dev/v0.1",
      kind: "Workflow",
      metadata: {
        name: "support.summarize",
        version: "0.1.0-alpha",
        description: "Summarize a ticket.",
      },
      input: { schema: ticketInputSchema },
      output: { schema: outputSchemaA },
      permissions: { tools: ["summarize"], models: [], secrets: [], network: [] },
      steps: [
        {
          id: "summarize",
          uses: "tool.call",
          with: { tool: "summarize" },
          input: {
            ticketId: "{{ input.ticketId }}",
            body: "{{ input.body }}",
          },
          output: { mode: "object", schema: outputSchemaA },
        },
      ],
    });
    const compiled = await compileWorkflow(workflowWithOutputSchema, {
      input: { ticketId: "TIN-12", body: "Cannot export invoices." },
      tools: registryA,
      planner,
    });

    // Now run with a registry that has outputSchemaB — drift should be detected.
    const summarize = vi.fn<RuntimeToolHandler>(() => ({ summary: "drifted" }));
    const registryB = createToolRegistry();
    registryB.register("summarize", {
      description: "Summarize a ticket.",
      inputSchema: ticketInputSchema,
      outputSchema: outputSchemaB,
      execute: summarize as (input: unknown, context: unknown) => Promise<unknown>,
    });

    await expect(
      executeWorkflowVersion({
        world,
        workflowVersion: compiled.workflowVersion,
        input: { ticketId: "TIN-12", body: "Cannot export invoices." },
        tools: registryB,
        runId: "run_public_output_schema_drift",
      }),
    ).resolves.toMatchObject({
      status: "failed",
      error: expect.objectContaining({
        message: expect.stringContaining("capability_drift"),
      }),
    });
    expect(summarize).not.toHaveBeenCalled();
  });

  it("the same handler can be reused across multiple registries without mutation", async () => {
    const world = await tempWorld();
    const sharedSummarize = vi.fn<RuntimeToolHandler>(() => ({ summary: "Cannot export invoices." }));
    // Two separate registries can share the same underlying handler function.
    const firstRegistry = createToolRegistry();
    firstRegistry.register("summarize", {
      description: "First descriptor.",
      inputSchema: ticketInputSchema,
      execute: sharedSummarize as (input: unknown, context: unknown) => Promise<unknown>,
    });
    const secondRegistry = createToolRegistry();
    secondRegistry.register("summarize", {
      description: "Summarize a ticket.",
      inputSchema: ticketInputSchema,
      execute: sharedSummarize as (input: unknown, context: unknown) => Promise<unknown>,
    });
    const firstWorkflow = createLittleWorkflow({
      id: "support.summarize",
      description: "Summarize with first descriptor.",
      inputSchema: ticketInputSchema,
      output: output.object({ schema: ticketOutputSchema }),
      globalTools: ["summarize"],
    } as unknown as Parameters<typeof createLittleWorkflow>[0]);
    const secondWorkflow = createLittleWorkflow({
      id: "support.summarize",
      description: "Summarize with second descriptor.",
      inputSchema: ticketInputSchema,
      output: output.object({ schema: ticketOutputSchema }),
      globalTools: ["summarize"],
    } as unknown as Parameters<typeof createLittleWorkflow>[0]);

    await expect(
      runWorkflow({
        world,
        workflows: firstWorkflow,
        input: { ticketId: "TIN-12", body: "Cannot export invoices." },
        planner: plannerFor(singleToolLwir()),
        tools: firstRegistry,
        runId: "run_public_descriptor_first",
      }),
    ).resolves.toMatchObject({ status: "completed" });

    await expect(
      runWorkflow({
        world,
        workflows: secondWorkflow,
        input: { ticketId: "TIN-12", body: "Cannot export invoices." },
        planner: plannerFor(singleToolLwir()),
        tools: secondRegistry,
        runId: "run_public_descriptor_second",
      }),
    ).resolves.toMatchObject({ status: "completed" });
    // The handler itself is never mutated; descriptors live in the registry.
    expect(Object.hasOwn(sharedSummarize, "description")).toBe(false);
    expect(Object.hasOwn(sharedSummarize, "inputSchema")).toBe(false);
    expect(sharedSummarize).toHaveBeenCalledTimes(2);
  });

  it("replays terminal capability drift failures without planner access", async () => {
    const world = await tempWorld();
    const planner = plannerFor(singleToolLwir());

    // Compile with canonical descriptor.
    const compiled = await compileWorkflow(ticketWorkflow, {
      input: { ticketId: "TIN-12", body: "Cannot export invoices." },
      tools: ticketToolRegistry,
      planner,
    });

    // Run with a drifted descriptor → capability_drift.
    const driftedRegistry = createToolRegistry();
    driftedRegistry.register("summarize", {
      description: "Different tool descriptor.",
      inputSchema: true,
      execute: () => Promise.resolve({ summary: "drifted" }),
    });
    const firstResult = await executeWorkflowVersion({
      world,
      workflowVersion: compiled.workflowVersion,
      input: { ticketId: "TIN-12", body: "Cannot export invoices." },
      tools: driftedRegistry,
      runId: "run_public_tool_drift_no_planner_replay",
    });
    expect(firstResult.status).toBe("failed");
    const eventCount = (await listEvents(world, "run_public_tool_drift_no_planner_replay")).length;

    // Replay: run without a planner → should replay the terminal failure.
    await expect(
      runWorkflow({
        world,
        workflows: ticketWorkflow,
        input: { ticketId: "TIN-12", body: "Cannot export invoices." },
        runId: "run_public_tool_drift_no_planner_replay",
      }),
    ).rejects.toMatchObject({
      name: "RunFailedError",
      runId: "run_public_tool_drift_no_planner_replay",
      causeCode: "capability_drift",
      failedStepPath: "summarize",
    });
    expect(planner.draft).toHaveBeenCalledTimes(1);
    await expect(listEvents(world, "run_public_tool_drift_no_planner_replay")).resolves
      .toHaveLength(eventCount);
  });

  it("does not report a recovered step as failed when the terminal failure is run-level", async () => {
    const world = await tempWorld();
    const outputArtifact = await writeArtifact(world, {
      runId: "run_public_timeout_after_recovered_step",
      stepPath: "summarize",
      name: "output",
      payload: { summary: "Cannot export invoices." },
      contentType: "application/json",
    });
    await appendEvent(world, "run_public_timeout_after_recovered_step", {
      type: "RunStarted",
      payload: {
        workflowVersionId: "wfver_manual_timeout_after_recovered_step",
        input: { ticketId: "TIN-12", body: "Cannot export invoices." },
      },
    });
    await appendEvent(world, "run_public_timeout_after_recovered_step", {
      type: "StepScheduled",
      payload: { stepPath: "summarize", stepId: "summarize", uses: "tool.call" },
    });
    await appendEvent(world, "run_public_timeout_after_recovered_step", {
      type: "StepAttemptStarted",
      payload: {
        stepPath: "summarize",
        stepId: "summarize",
        attempt: 1,
        attemptId: "attempt_1",
      },
    });
    await appendEvent(world, "run_public_timeout_after_recovered_step", {
      type: "StepFailed",
      payload: {
        stepPath: "summarize",
        stepId: "summarize",
        attempt: 1,
        attemptId: "attempt_1",
        error: {
          name: "Error",
          message: "transient",
          retriable: true,
        },
      },
    });
    await appendEvent(world, "run_public_timeout_after_recovered_step", {
      type: "StepAttemptStarted",
      payload: {
        stepPath: "summarize",
        stepId: "summarize",
        attempt: 2,
        attemptId: "attempt_2",
      },
    });
    await appendEvent(world, "run_public_timeout_after_recovered_step", {
      type: "ArtifactCreated",
      payload: {
        stepPath: "summarize",
        artifactRef: outputArtifact.artifactRef,
        name: "output",
        contentType: "application/json",
      },
    });
    await appendEvent(world, "run_public_timeout_after_recovered_step", {
      type: "StepCompleted",
      payload: {
        stepPath: "summarize",
        stepId: "summarize",
        attempt: 2,
        attemptId: "attempt_2",
        output: { summary: "Cannot export invoices." },
        outputRef: outputArtifact.artifactRef,
        artifactRefs: [outputArtifact.artifactRef],
      },
    });
    await appendEvent(world, "run_public_timeout_after_recovered_step", {
      type: "RunFailed",
      payload: {
        workflowVersionId: "wfver_manual_timeout_after_recovered_step",
        error: {
          name: "TimeoutError",
          message: "Run timed out.",
          causeCode: "timeout",
          retriable: false,
        },
      },
    });

    await expect(
      runWorkflow({
        world,
        workflows: ticketWorkflow,
        input: { ticketId: "TIN-12", body: "Cannot export invoices." },
        runId: "run_public_timeout_after_recovered_step",
      }),
    ).rejects.toMatchObject({
      name: "RunFailedError",
      causeCode: "timeout",
      failedStepPath: undefined,
    });
  });

  it("marks missing runtime tool capabilities as non-retriable", async () => {
    const world = await tempWorld();
    const planner = plannerFor(singleToolLwir());

    await expect(
      runWorkflow({
        world,
        workflows: ticketWorkflow,
        input: { ticketId: "TIN-12", body: "Cannot export invoices." },
        planner,
        // No registry provided → tool not registered → runtime_config_error at compile time.
        runId: "run_public_missing_tool_capability",
        maxAttempts: 2,
      }),
    ).rejects.toMatchObject({
      name: "RunFailedError",
      runId: "run_public_missing_tool_capability",
      causeCode: "runtime_config_error",
    });

    const events = await listEvents(world, "run_public_missing_tool_capability");
    // With registry-based tools, the error is detected at compile time (no step events).
    expect(events.filter((event) => event.type === "StepAttemptStarted")).toHaveLength(0);
    expect(events.filter((event) => event.type === "RunFailed")).toHaveLength(1);
  });

  it("wraps compiler input errors in RunFailedError", async () => {
    const world = await tempWorld();
    const planner = plannerFor(singleToolLwir());

    await expect(
      runWorkflow({
        world,
        workflows: ticketWorkflow,
        input: { ticketId: "TIN-12" } as never,
        planner,
        tools: ticketRegistryWith(() => ({ summary: "should not run" })),
        runId: "run_public_input_error",
      }),
    ).rejects.toMatchObject({
      name: "RunFailedError",
      runId: "run_public_input_error",
      causeCode: "input_schema_error",
      result: expect.objectContaining({
        runId: "run_public_input_error",
        status: "failed",
        workflowVersionId: "uncompiled",
      }),
    });
    expect(planner.draft).not.toHaveBeenCalled();
  });

  it("wraps planner validation exhaustion in RunFailedError", async () => {
    const world = await tempWorld();
    const planner: PlannerAdapter = {
      draft: vi.fn(async () => ({
        apiVersion: "littleworkflow.dev/v0.1",
        kind: "Workflow",
        metadata: { name: "support.summarize" },
        input: { schema: ticketInputSchema },
        output: { schema: ticketOutputSchema },
        steps: [
          {
            id: "call-missing-tool",
            uses: "tool.call",
            with: { tool: "missingTool" },
            output: { mode: "object", schema: ticketOutputSchema },
          },
        ],
      })),
    };

    await expect(
      runWorkflow({
        world,
        workflows: ticketWorkflow,
        input: { ticketId: "TIN-12", body: "Cannot export invoices." },
        planner,
        tools: ticketRegistryWith(() => ({ summary: "should not run" })),
        runId: "run_public_compile_error",
      }),
    ).rejects.toMatchObject({
      name: "RunFailedError",
      runId: "run_public_compile_error",
      causeCode: "planner_validation_exhausted",
      result: expect.objectContaining({
        runId: "run_public_compile_error",
        status: "failed",
        workflowVersionId: "uncompiled",
      }),
    });
  });

  it("does not treat planner-thrown RunFailedError as SDK cancellation", async () => {
    const world = await tempWorld();
    const plannerError = new RunFailedError({
      runId: "planner_origin",
      workflowVersionId: "wfver_planner_origin",
      causeCode: "step_failed",
      message: "Planner adapter failed before producing LWIR.",
    });
    const planner: PlannerAdapter = {
      draft: vi.fn(async () => {
        throw plannerError;
      }),
    };

    await expect(
      runWorkflow({
        world,
        workflows: ticketWorkflow,
        input: { ticketId: "TIN-12", body: "Cannot export invoices." },
        planner,
        tools: ticketRegistryWith(() => ({ summary: "should not run" })),
        runId: "run_public_planner_runfailed",
      }),
    ).rejects.toBe(plannerError);
    await expect(listEvents(world, "run_public_planner_runfailed")).resolves.toEqual([
      expect.objectContaining({ sequence: 1, type: "OrchestrationRequested" }),
      expect.objectContaining({ sequence: 2, type: "PlannerStarted" }),
    ]);
  });

  it("does not report adapter-origin AbortError as run cancellation", async () => {
    const world = await tempWorld();
    const planner = plannerFor(singleToolLwir());
    const summarize = vi.fn<RuntimeToolHandler>(() => {
      const error = new Error("provider aborted request");
      error.name = "AbortError";
      throw error;
    });

    await expect(
      runWorkflow({
        world,
        workflows: ticketWorkflow,
        input: { ticketId: "TIN-12", body: "Cannot export invoices." },
        planner,
        tools: ticketRegistryWith(summarize),
        runId: "run_public_provider_abort",
      }),
    ).rejects.toMatchObject({
      name: "RunFailedError",
      runId: "run_public_provider_abort",
      causeCode: "step_failed",
      failedStepPath: "summarize",
    });
  });

  it("does not report adapter-origin TimeoutError as run timeout", async () => {
    const world = await tempWorld();
    const planner = plannerFor(singleToolLwir());
    const summarize = vi.fn<RuntimeToolHandler>(() => {
      const error = new Error("provider timed out request");
      error.name = "TimeoutError";
      throw error;
    });

    await expect(
      runWorkflow({
        world,
        workflows: ticketWorkflow,
        input: { ticketId: "TIN-12", body: "Cannot export invoices." },
        planner,
        tools: ticketRegistryWith(summarize),
        runId: "run_public_provider_timeout",
      }),
    ).rejects.toMatchObject({
      name: "RunFailedError",
      runId: "run_public_provider_timeout",
      causeCode: "step_failed",
      failedStepPath: "summarize",
    });
  });

  it("does not infer step schema failures from adapter-origin messages", async () => {
    const world = await tempWorld();
    const planner = plannerFor(singleToolLwir());
    const summarize = vi.fn<RuntimeToolHandler>(() => {
      throw new Error("schema service unavailable");
    });

    await expect(
      runWorkflow({
        world,
        workflows: ticketWorkflow,
        input: { ticketId: "TIN-12", body: "Cannot export invoices." },
        planner,
        tools: ticketRegistryWith(summarize),
        runId: "run_public_provider_schema_message",
      }),
    ).rejects.toMatchObject({
      name: "RunFailedError",
      runId: "run_public_provider_schema_message",
      causeCode: "step_failed",
      failedStepPath: "summarize",
    });
  });

  it("replays terminal step schema failures without planner access", async () => {
    const world = await tempWorld();
    const planner = plannerFor(singleToolLwir());

    await expect(
      runWorkflow({
        world,
        workflows: ticketWorkflow,
        input: { ticketId: "TIN-12", body: "Cannot export invoices." },
        planner,
        tools: ticketRegistryWith(() => ({ summary: 404 })),
        runId: "run_public_step_schema_no_planner_replay",
      }),
    ).rejects.toMatchObject({ causeCode: "step_schema_error" });
    const eventCount = (await listEvents(world, "run_public_step_schema_no_planner_replay")).length;

    await expect(
      runWorkflow({
        world,
        workflows: ticketWorkflow,
        input: { ticketId: "TIN-12", body: "Cannot export invoices." },
        runId: "run_public_step_schema_no_planner_replay",
      }),
    ).rejects.toMatchObject({
      name: "RunFailedError",
      runId: "run_public_step_schema_no_planner_replay",
      causeCode: "step_schema_error",
      failedStepPath: "summarize",
    });
    expect(planner.draft).toHaveBeenCalledTimes(1);
    await expect(listEvents(world, "run_public_step_schema_no_planner_replay")).resolves
      .toHaveLength(eventCount);
  });

  it("replays terminal step failures without planner access", async () => {
    const world = await tempWorld();
    const planner = plannerFor(singleToolLwir());

    await expect(
      runWorkflow({
        world,
        workflows: ticketWorkflow,
        input: { ticketId: "TIN-12", body: "Cannot export invoices." },
        planner,
        tools: ticketRegistryWith(() => {
          throw new Error("tool unavailable");
        }),
        runId: "run_public_step_failed_no_planner_replay",
      }),
    ).rejects.toMatchObject({ causeCode: "step_failed" });
    const eventCount = (await listEvents(world, "run_public_step_failed_no_planner_replay")).length;

    await expect(
      runWorkflow({
        world,
        workflows: ticketWorkflow,
        input: { ticketId: "TIN-12", body: "Cannot export invoices." },
        runId: "run_public_step_failed_no_planner_replay",
      }),
    ).rejects.toMatchObject({
      name: "RunFailedError",
      runId: "run_public_step_failed_no_planner_replay",
      causeCode: "step_failed",
      failedStepPath: "summarize",
    });
    expect(planner.draft).toHaveBeenCalledTimes(1);
    await expect(listEvents(world, "run_public_step_failed_no_planner_replay")).resolves
      .toHaveLength(eventCount);
  });

  it("preserves persisted terminal step schema cause codes when replaying partial failure logs", async () => {
    const world = await tempWorld();
    const compiled = await compileWorkflow(ticketWorkflow, {
      input: { ticketId: "TIN-12", body: "Cannot export invoices." },
      tools: ticketToolRegistry,
      planner: plannerFor(singleToolLwir()),
    });

    await appendEvent(world, "run_public_partial_step_schema_replay", {
      type: "WorkflowVersionRegistered",
      payload: {
        workflowVersionId: compiled.workflowVersion.id,
        workflowVersionHash: compiled.workflowVersion.hash,
      },
    });
    await appendEvent(world, "run_public_partial_step_schema_replay", {
      type: "RunStarted",
      payload: { workflowVersionId: compiled.workflowVersion.id },
    });
    await appendEvent(world, "run_public_partial_step_schema_replay", {
      type: "StepScheduled",
      payload: { stepPath: "summarize", stepId: "summarize", uses: "tool.call" },
    });
    await appendEvent(world, "run_public_partial_step_schema_replay", {
      type: "StepAttemptStarted",
      payload: {
        stepPath: "summarize",
        stepId: "summarize",
        attempt: 1,
        attemptId: "attempt_1",
      },
    });
    await appendEvent(world, "run_public_partial_step_schema_replay", {
      type: "StepFailed",
      payload: {
        stepPath: "summarize",
        stepId: "summarize",
        attempt: 1,
        attemptId: "attempt_1",
        error: {
          name: "StepSchemaError",
          message: "Step 'summarize' output does not match schema.",
          causeCode: "step_schema_error",
          retriable: false,
        },
      },
    });

    await expect(
      runWorkflow({
        world,
        workflows: ticketWorkflow,
        input: { ticketId: "TIN-12", body: "Cannot export invoices." },
        planner: plannerFor(singleToolLwir()),
        tools: ticketRegistryWith(() => ({ summary: "should not rerun" })),
        runId: "run_public_partial_step_schema_replay",
      }),
    ).rejects.toMatchObject({
      name: "RunFailedError",
      runId: "run_public_partial_step_schema_replay",
      causeCode: "step_schema_error",
      failedStepPath: "summarize",
    });

    const events = await listEvents(world, "run_public_partial_step_schema_replay");
    expect(events.filter((event) => event.type === "StepAttemptStarted")).toHaveLength(1);
    expect(events.filter((event) => event.type === "RunFailed")).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          error: expect.objectContaining({
            name: "StepSchemaError",
            causeCode: "step_schema_error",
            retriable: false,
          }),
        }),
      }),
    ]);
  });

  it("rejects runs locked by another process before invoking the planner", async () => {
    const world = await tempWorld();
    const runId = "run_public_external_lock";
    await writeRunLockOwner(world.dataDir, runId, process.pid);
    const planner = plannerFor(singleToolLwir());

    await expect(
      runWorkflow({
        world,
        workflows: ticketWorkflow,
        input: { ticketId: "TIN-12", body: "Cannot export invoices." },
        planner,
        tools: ticketRegistryWith(() => ({ summary: "should not run" })),
        runId,
      }),
    ).rejects.toThrow(`Run '${runId}' is already executing`);
    expect(planner.draft).not.toHaveBeenCalled();
  });

  it("does not steal ownerless run locks before invoking the planner", async () => {
    const world = await tempWorld();
    const runId = "run_public_ownerless_lock";
    await mkdir(runLockDir(world.dataDir, runId), { recursive: true });
    const planner = plannerFor(singleToolLwir());

    await expect(
      runWorkflow({
        world,
        workflows: ticketWorkflow,
        input: { ticketId: "TIN-12", body: "Cannot export invoices." },
        planner,
        tools: ticketRegistryWith(() => ({ summary: "should not run" })),
        runId,
      }),
    ).rejects.toThrow(`Run '${runId}' is already executing`);
    expect(planner.draft).not.toHaveBeenCalled();
  });

  it("recovers stale run locks before replaying a completed run", async () => {
    const world = await tempWorld();
    const summarize = vi.fn<RuntimeToolHandler>(() => ({ summary: "Cannot export invoices." }));
    const first = await runWorkflow({
      world,
      workflows: ticketWorkflow,
      input: { ticketId: "TIN-12", body: "Cannot export invoices." },
      planner: plannerFor(singleToolLwir()),
      tools: ticketRegistryWith(summarize),
      runId: "run_public_stale_lock_replay",
    });
    await writeRunLockOwner(world.dataDir, "run_public_stale_lock_replay", 999_999_999);

    await expect(
      runWorkflow({
        world,
        workflows: ticketWorkflow,
        input: { ticketId: "TIN-12", body: "Cannot export invoices." },
        runId: "run_public_stale_lock_replay",
      }),
    ).resolves.toMatchObject({
      status: "completed",
      output: first.output,
      artifacts: first.artifacts,
    });
    expect(summarize).toHaveBeenCalledTimes(1);
  });
});

// ── P1.5: planner declares model in permissions; runtime receives model registry ──

const aiOutputSchema = {
  type: "object",
  required: ["summary"],
  additionalProperties: false,
  properties: { summary: { type: "string" } },
};

const aiInputSchema = {
  type: "object",
  required: ["text"],
  additionalProperties: false,
  properties: { text: { type: "string" } },
};

function aiGenerateLwir(modelSlot = "model.fast"): LwirWorkflow {
  return {
    apiVersion: "littleworkflow.dev/v0.1",
    kind: "Workflow",
    metadata: {
      name: "p1-5.ai-generate",
      description: `Single ai.generate step with ${modelSlot} slot.`,
    },
    input: { schema: aiInputSchema },
    output: { schema: aiOutputSchema },
    permissions: { tools: [], models: [modelSlot], secrets: [], network: [] },
    steps: [
      {
        id: "summarize",
        uses: "ai.generate",
        with: { model: modelSlot, prompt: "Summarize: {{ input.text }}" },
        output: { mode: "object", schema: aiOutputSchema },
      },
    ],
  };
}

describe("P1.5 — planner declares model in permissions; runtime receives model registry", () => {
  it("P1.5: completes an ai.generate run when permissions.models includes model.fast and models is passed to runWorkflow", async () => {
    const world = await tempWorld();

    const stubModel = { providerId: "stub", modelId: "stub-model" };
    const workerSlot = model(stubModel, { id: "model.fast" });

    const aiLoop = {
      generate: vi.fn(async () => ({
        output: { summary: "stub summary" },
        usage: { inputTokens: 5, outputTokens: 3 },
      })),
    };
    const workerHarness = createWorkflowHarness({ aiLoop });

    const aiWorkflow = createLittleWorkflow({
      id: "p1-5.ai-generate",
      description: "Single ai.generate step with model.fast slot.",
      inputSchema: aiInputSchema,
      output: output.object({ schema: aiOutputSchema }),
      models: [workerSlot],
      worker: { harness: workerHarness },
    } as unknown as Parameters<typeof createLittleWorkflow>[0]);

    const result = await runWorkflow({
      world,
      workflows: aiWorkflow,
      input: { text: "hello world" },
      planner: plannerFor(aiGenerateLwir()),
    });

    expect(result.status).toBe("completed");
    expect(result.output).toEqual({ summary: "stub summary" });
    expect(aiLoop.generate).toHaveBeenCalledOnce();
  });

  it("attributes real ai.generate usage to the step that ran it", async () => {
    // End-to-end guard for the runtime -> harness bridge: the harness never sees a
    // workflow step path, so the runtime stamps one onto every event it forwards. If
    // that injection regressed, usage would still be counted at the run level but every
    // step would report zero, and a receipt would lose its per-step breakdown.
    const world = await tempWorld();
    const workerSlot = model({ providerId: "stub", modelId: "stub-model" }, { id: "model.fast" });
    const aiLoop = {
      generate: vi.fn(async () => ({
        output: { summary: "stub summary" },
        usage: { inputTokens: 5_000, outputTokens: 3_000, cachedInputTokens: 4_000 },
      })),
    };
    const aiWorkflow = createLittleWorkflow({
      id: "p1-5.ai-generate",
      description: "Single ai.generate step with model.fast slot.",
      inputSchema: aiInputSchema,
      output: output.object({ schema: aiOutputSchema }),
      models: [workerSlot],
      worker: { harness: createWorkflowHarness({ aiLoop }) },
    } as unknown as Parameters<typeof createLittleWorkflow>[0]);

    const result = await runWorkflow({
      world,
      workflows: aiWorkflow,
      input: { text: "hello world" },
      planner: plannerFor(aiGenerateLwir()),
      runId: "run_step_usage_attribution",
    });
    expect(result.status).toBe("completed");

    const state = materializeRunStateFromEvents("run_step_usage_attribution", result.events);
    // The step path comes from the LWIR, not from anything the harness supplied.
    expect(state.steps.summarize?.usage.inputTokens).toBe(5_000);
    expect(state.steps.summarize?.usage.outputTokens).toBe(3_000);
    expect(state.steps.summarize?.usage.cachedInputTokens).toBe(4_000);

    // Nothing is left unattributed: the per-step rows reconcile with the run total.
    const report = runReport(state);
    expect(report.unattributed).toBeUndefined();
    expect(report.total.inputTokens).toBe(5_000);

    // The stub model is not in the registry, so cost is honestly unpriced rather than $0.
    expect(state.usage.costUsd).toBeNull();
    expect(state.usage.unpricedCalls).toBeGreaterThan(0);
  });

  it("prices an end-to-end run whose model reports a real AI SDK provider id", async () => {
    // The companion to the test above, and the one that catches the whole-stack failure
    // it cannot: every AI SDK provider stamps `.provider` as
    // `${providerName}.${modelType}` — "deepseek.chat" here, "openai.responses" for
    // `openai("gpt-4o-mini")` — while registry keys are bare ("deepseek/deepseek-v4-flash").
    // Before provider-id normalization, every real-provider run reported costUsd: null,
    // so a pricing suite that only used bare ids stayed green while nothing shipped
    // priced. Note `provider`, not `providerId`: that is the property real AI SDK model
    // objects expose, and the one the runtime falls back to.
    const world = await tempWorld();
    const workerSlot = model(
      { provider: "deepseek.chat", modelId: "deepseek-v4-flash" },
      { id: "model.fast" },
    );
    const aiLoop = {
      generate: vi.fn(async () => ({
        output: { summary: "stub summary" },
        usage: { inputTokens: 10_000, outputTokens: 2_000 },
      })),
    };
    const aiWorkflow = createLittleWorkflow({
      id: "p1-5.ai-generate",
      description: "Single ai.generate step with model.fast slot.",
      inputSchema: aiInputSchema,
      output: output.object({ schema: aiOutputSchema }),
      models: [workerSlot],
      worker: { harness: createWorkflowHarness({ aiLoop }) },
    } as unknown as Parameters<typeof createLittleWorkflow>[0]);

    const result = await runWorkflow({
      world,
      workflows: aiWorkflow,
      input: { text: "hello world" },
      planner: plannerFor(aiGenerateLwir()),
      runId: "run_real_provider_id_pricing",
    });
    expect(result.status).toBe("completed");

    // deepseek/deepseek-v4-flash is listed at input $0.14 / output $0.28 per 1M tokens.
    //   10,000 input  x $0.14 / 1M = $0.00140
    //    2,000 output x $0.28 / 1M = $0.00056
    //                        total = $0.00196
    expect(result.usage.costUsd).toBeCloseTo(0.00196, 12);
    expect(result.usage.pricedCalls).toBeGreaterThan(0);
    expect(result.usage.unpricedCalls).toBe(0);

    const state = materializeRunStateFromEvents("run_real_provider_id_pricing", result.events);
    expect(state.steps.summarize?.usage.costUsd).toBeCloseTo(0.00196, 12);
    expect(runReport(state).hasUnpricedCalls).toBe(false);
  });

  it("blocks reuse_unchanged when a candidate model slot is no longer available", async () => {
    const world = await tempWorld();
    const stubModel = { providerId: "stub", modelId: "stub-model" };
    const workerSlot = model(stubModel, { id: "model.fast" });
    const aiLoop = {
      generate: vi.fn(async () => ({
        output: { summary: "stub summary" },
        usage: { inputTokens: 5, outputTokens: 3 },
      })),
    };
    const workerHarness = createWorkflowHarness({ aiLoop });
    const aiWorkflow = createLittleWorkflow({
      id: "p1-5.ai-generate",
      description: "Single ai.generate step with model.fast slot.",
      inputSchema: aiInputSchema,
      output: output.object({ schema: aiOutputSchema }),
      models: [workerSlot],
      worker: { harness: workerHarness },
    } as unknown as Parameters<typeof createLittleWorkflow>[0]);
    const first = await runWorkflow({
      world,
      workflows: aiWorkflow,
      input: { text: "hello world" },
      planner: plannerFor(aiGenerateLwir()),
      runId: "run_reuse_model_available_first",
      workflowVersionReuseStrategy: "planner_reviewed",
    });
    const aiWorkflowWithoutModel = createLittleWorkflow({
      ...aiWorkflow,
      models: [],
      worker: { harness: workerHarness },
    } as unknown as Parameters<typeof createLittleWorkflow>[0]);
    const reusePlanner: PlannerAdapter = {
      draft: vi.fn(async () => ({
        kind: "reuse_unchanged",
        workflowVersionId: first.workflowVersionId,
        rationale: "The old prompt still fits.",
        acknowledgedWarnings: ["model slots changed"],
      })),
    };

    await expect(
      runWorkflow({
        world,
        workflows: aiWorkflowWithoutModel,
        input: { text: "hello world" },
        planner: reusePlanner,
        runId: "run_reuse_model_unavailable_blocked",
        workflowVersionReuseStrategy: "planner_reviewed",
      }),
    ).rejects.toThrow(/reuse_unchanged is blocked.*model 'model\.fast'/u);
    expect(aiLoop.generate).toHaveBeenCalledOnce();
  });

  it("blocks reuse_unchanged when an ai.generate candidate falls back from a custom worker harness to the default harness", async () => {
    const world = await tempWorld();
    const stubModel = { providerId: "stub", modelId: "stub-model" };
    const workerSlot = model(stubModel, { id: "model.fast" });
    const aiLoop = {
      generate: vi.fn(async () => ({
        output: { summary: "stub summary" },
        usage: { inputTokens: 5, outputTokens: 3 },
      })),
    };
    const workerHarnessRuntime = createWorkflowHarness({ aiLoop });
    const workerHarness = {
      harnessId: "customAiHarness@1.0.0",
      run: workerHarnessRuntime.run,
    } satisfies Harness & { readonly harnessId: string };
    const aiWorkflow = createLittleWorkflow({
      id: "p1-5.ai-generate",
      description: "Single ai.generate step with model.fast slot.",
      inputSchema: aiInputSchema,
      output: output.object({ schema: aiOutputSchema }),
      models: [workerSlot],
      worker: { harness: workerHarness },
    } as unknown as Parameters<typeof createLittleWorkflow>[0]);
    const first = await runWorkflow({
      world,
      workflows: aiWorkflow,
      input: { text: "hello world" },
      planner: plannerFor(aiGenerateLwir()),
      runId: "run_reuse_ai_harness_first",
      workflowVersionReuseStrategy: "planner_reviewed",
    });
    const aiWorkflowWithoutHarness = createLittleWorkflow({
      id: "p1-5.ai-generate",
      description: "Single ai.generate step with model.fast slot.",
      inputSchema: aiInputSchema,
      output: output.object({ schema: aiOutputSchema }),
      models: [workerSlot],
    } as unknown as Parameters<typeof createLittleWorkflow>[0]);
    const reusePlanner: PlannerAdapter = {
      draft: vi.fn(async () => ({
        kind: "reuse_unchanged",
        workflowVersionId: first.workflowVersionId,
        rationale: "The old prompt still fits.",
        acknowledgedWarnings: [],
      })),
    };

    await expect(
      runWorkflow({
        world,
        workflows: aiWorkflowWithoutHarness,
        input: { text: "hello world" },
        planner: reusePlanner,
        runId: "run_reuse_ai_harness_blocked",
        workflowVersionReuseStrategy: "planner_reviewed",
      }),
    ).rejects.toThrow(/reuse_unchanged is blocked.*worker harness/u);
    expect(aiLoop.generate).toHaveBeenCalledOnce();
  });

  it("blocks reuse_unchanged when an ai.generate candidate worker harness changes", async () => {
    const world = await tempWorld();
    const stubModel = { providerId: "stub", modelId: "stub-model" };
    const workerSlot = model(stubModel, { id: "model.fast" });
    const aiLoop = {
      generate: vi.fn(async () => ({
        output: { summary: "stub summary" },
        usage: { inputTokens: 5, outputTokens: 3 },
      })),
    };
    const workflowHarness = createWorkflowHarness({ aiLoop });
    const workerHarnessV1 = {
      harnessId: "workerHarness@1.0.0",
      run: workflowHarness.run,
    } satisfies Harness & { readonly harnessId: string };
    const workerHarnessV2 = {
      harnessId: "workerHarness@2.0.0",
      run: workflowHarness.run,
    } satisfies Harness & { readonly harnessId: string };
    const aiWorkflow = createLittleWorkflow({
      id: "p1-5.ai-generate",
      description: "Single ai.generate step with model.fast slot.",
      inputSchema: aiInputSchema,
      output: output.object({ schema: aiOutputSchema }),
      models: [workerSlot],
      worker: { harness: workerHarnessV1 },
    } as unknown as Parameters<typeof createLittleWorkflow>[0]);
    const first = await runWorkflow({
      world,
      workflows: aiWorkflow,
      input: { text: "hello world" },
      planner: plannerFor(aiGenerateLwir()),
      runId: "run_reuse_ai_worker_harness_first",
      workflowVersionReuseStrategy: "planner_reviewed",
    });
    const aiWorkflowWithChangedHarness = createLittleWorkflow({
      id: "p1-5.ai-generate",
      description: "Single ai.generate step with model.fast slot.",
      inputSchema: aiInputSchema,
      output: output.object({ schema: aiOutputSchema }),
      models: [workerSlot],
      worker: { harness: workerHarnessV2 },
    } as unknown as Parameters<typeof createLittleWorkflow>[0]);
    const reusePlanner: PlannerAdapter = {
      draft: vi.fn(async () => ({
        kind: "reuse_unchanged",
        workflowVersionId: first.workflowVersionId,
        rationale: "The old prompt still fits.",
        acknowledgedWarnings: [],
      })),
    };

    await expect(
      runWorkflow({
        world,
        workflows: aiWorkflowWithChangedHarness,
        input: { text: "hello world" },
        planner: reusePlanner,
        runId: "run_reuse_ai_worker_harness_blocked",
        workflowVersionReuseStrategy: "planner_reviewed",
      }),
    ).rejects.toThrow(/reuse_unchanged is blocked.*worker harness changed/u);
    expect(aiLoop.generate).toHaveBeenCalledOnce();
  });

  it("blocks reuse_unchanged when an ai.generate candidate bash capability changes", async () => {
    const world = await tempWorld();
    const stubModel = { providerId: "stub", modelId: "stub-model" };
    const workerSlot = model(stubModel, { id: "model.fast" });
    const aiLoop = {
      generate: vi.fn(async () => ({
        output: { summary: "stub summary" },
        usage: { inputTokens: 5, outputTokens: 3 },
      })),
    };
    const workerHarness = createWorkflowHarness({ aiLoop });
    const aiWorkflow = createLittleWorkflow({
      id: "p1-5.ai-generate",
      description: "Single ai.generate step with model.fast slot.",
      inputSchema: aiInputSchema,
      output: output.object({ schema: aiOutputSchema }),
      models: [workerSlot],
      worker: { harness: workerHarness },
      bash: { javascript: false },
    } as unknown as Parameters<typeof createLittleWorkflow>[0]);
    const first = await runWorkflow({
      world,
      workflows: aiWorkflow,
      input: { text: "hello world" },
      planner: plannerFor(aiGenerateLwir()),
      runId: "run_reuse_ai_bash_capability_first",
      workflowVersionReuseStrategy: "planner_reviewed",
    });
    const aiWorkflowWithChangedBash = createLittleWorkflow({
      id: "p1-5.ai-generate",
      description: "Single ai.generate step with model.fast slot.",
      inputSchema: aiInputSchema,
      output: output.object({ schema: aiOutputSchema }),
      models: [workerSlot],
      worker: { harness: workerHarness },
      bash: { javascript: true },
    } as unknown as Parameters<typeof createLittleWorkflow>[0]);
    const reusePlanner: PlannerAdapter = {
      draft: vi.fn(async () => ({
        kind: "reuse_unchanged",
        workflowVersionId: first.workflowVersionId,
        rationale: "The old prompt still fits.",
        acknowledgedWarnings: [],
      })),
    };

    await expect(
      runWorkflow({
        world,
        workflows: aiWorkflowWithChangedBash,
        input: { text: "hello world" },
        planner: reusePlanner,
        runId: "run_reuse_ai_bash_capability_blocked",
        workflowVersionReuseStrategy: "planner_reviewed",
      }),
    ).rejects.toThrow(/reuse_unchanged is blocked.*bash capability/u);
    expect(aiLoop.generate).toHaveBeenCalledOnce();
  });

  it("P1.5: accepts model-name slot ids without capability drift", async () => {
    const world = await tempWorld();
    const modelSlotId = "gpt-4o-mini";
    const workerSlot = model({ provider: "openai", modelId: modelSlotId });

    const aiLoop = {
      generate: vi.fn(async () => ({
        output: { summary: "stub summary" },
        usage: { inputTokens: 5, outputTokens: 3 },
      })),
    };
    const workerHarness = createWorkflowHarness({ aiLoop });

    const aiWorkflow = createLittleWorkflow({
      id: "p1-5.ai-generate",
      description: "Single ai.generate step with gpt-4o-mini slot.",
      inputSchema: aiInputSchema,
      output: output.object({ schema: aiOutputSchema }),
      models: [workerSlot],
      worker: { harness: workerHarness },
    } as unknown as Parameters<typeof createLittleWorkflow>[0]);

    const result = await runWorkflow({
      world,
      workflows: aiWorkflow,
      input: { text: "hello world" },
      planner: plannerFor(aiGenerateLwir(modelSlotId)),
    });

    expect(result.status).toBe("completed");
    expect(result.output).toEqual({ summary: "stub summary" });
    expect(aiLoop.generate).toHaveBeenCalledOnce();
  });

  it("P1.5: accepts AI SDK models that expose identity through getters", async () => {
    const world = await tempWorld();
    const modelSlotId = "model.fast";
    const getterModel = Object.create({
      get provider() {
        return "stub";
      },
      get modelId() {
        return "getter-model";
      },
    });
    const workerSlot = model(getterModel, { id: modelSlotId });

    const aiLoop = {
      generate: vi.fn(async () => ({
        output: { summary: "stub summary" },
        usage: { inputTokens: 5, outputTokens: 3 },
      })),
    };
    const workerHarness = createWorkflowHarness({ aiLoop });

    const aiWorkflow = createLittleWorkflow({
      id: "p1-5.ai-generate",
      description: "Single ai.generate step with getter-backed model identity.",
      inputSchema: aiInputSchema,
      output: output.object({ schema: aiOutputSchema }),
      models: [workerSlot],
      worker: { harness: workerHarness },
    } as unknown as Parameters<typeof createLittleWorkflow>[0]);

    const result = await runWorkflow({
      world,
      workflows: aiWorkflow,
      input: { text: "hello world" },
      planner: plannerFor(aiGenerateLwir(modelSlotId)),
    });

    expect(result.status).toBe("completed");
    expect(result.output).toEqual({ summary: "stub summary" });
    expect(aiLoop.generate).toHaveBeenCalledOnce();
  });
});
