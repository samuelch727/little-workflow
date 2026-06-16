import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  computeCompiledWorkflowVersionIdentity,
  computeCompilerValidationHash,
  lwirVersionIdForHash,
  type WorkflowVersionLockSeed,
} from "./compiler-lock.js";
import {
  canonicalJson,
  executeWorkflowVersion,
  listEvents,
  localWorld,
  sha256Digest,
  type Harness,
  type LwirWorkflow,
} from "./index.js";
import { concreteInputStructure } from "./workflow-version-reuse.js";

const tempDirs: string[] = [];

async function tempWorld() {
  const dataDir = await mkdtemp(join(tmpdir(), "little-workflow-fixer-"));
  tempDirs.push(dataDir);
  return localWorld({ dataDir });
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("fixer runtime hook", () => {
  it("does not invoke fixer when code.run fails due capability drift/runtime config", async () => {
    const world = await tempWorld();
    let fixerCalls = 0;
    const workerHarness: Harness & { readonly harnessId: string } = {
      harnessId: "testFixerHarness@1.0.0",
      async run(task) {
        if (task.kind === "execute_step") {
          return { kind: "plan", lwir: { apiVersion: "littleworkflow.dev/v0.1" } };
        }
        if (task.kind === "fix_step") {
          fixerCalls += 1;
          return {
            kind: "fix_step",
            output: { value: 99 },
            fixedSource: "async ({ input }) => ({ value: 99 })",
            attempts: 1,
          };
        }
        return { kind: "delegate_to_default" };
      },
    };
    const workflowVersion = lockedWorkflowVersion(
      "wfver_fixer_capability_drift",
      codeStepWorkflowWithFixer(),
      {
        "model.fast": { provider: "mock", modelId: "fast" },
      },
    );

    const result = await executeWorkflowVersion({
      world,
      workflowVersion,
      runId: "run_fixer_capability_drift",
      input: {},
      models: {
        "model.fast": { provider: "mock", modelId: "fast" },
      },
      workerHarness,
    });

    expect(result.status).toBe("failed");
    expect(fixerCalls).toBe(0);

    const runFailed = result.events.find((event) => event.type === "RunFailed");
    expect(runFailed).toBeDefined();
    expect(stringProperty(propertyValue(runFailed?.payload, "error"), "causeCode")).toBe(
      "runtime_config_error",
    );
  });

  it("recovers failed code.run steps via a fix_step harness session", async () => {
    const world = await tempWorld();
    const executeStep = vi.fn(() => {
      throw new Error("compute failed");
    });
    const workerHarness: Harness & { readonly harnessId: string } = {
      harnessId: "testFixerHarness@1.0.0",
      async run(task) {
        if (task.kind === "execute_step" && task.step.uses === "code.run") {
          executeStep();
        }
        if (task.kind === "fix_step") {
          expect(task.priorFixAttempts).toBe(0);
          expect(task.originalAttemptError.message).toContain("compute failed");
          return {
            kind: "fix_step",
            output: { value: 42 },
            fixedSource: "async ({ input }) => ({ value: 42 })",
            attempts: 1,
          };
        }
        return { kind: "delegate_to_default" };
      },
    };
    const workflowVersion = lockedWorkflowVersion(
      "wfver_fixer_recovery",
      codeStepWorkflowWithFixer(),
      {
        "model.fast": { provider: "mock", modelId: "fast" },
      },
    );

    const result = await executeWorkflowVersion({
      world,
      workflowVersion,
      runId: "run_fixer_recovery",
      input: {},
      models: {
        "model.fast": { provider: "mock", modelId: "fast" },
      },
      workerHarness,
    });

    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      expect(result.output).toEqual({ value: 42 });
    }
    expect(executeStep).toHaveBeenCalledTimes(1);

    const events = await listEvents(world, "run_fixer_recovery");
    expect(events.find((event) =>
      event.type === "harness.session.started" && event.payload.role === "fixer"
    )).toBeDefined();
    const completed = events.find((event) => event.type === "harness.session.completed");
    expect(
      (completed?.payload.output as { result?: { fixedSource?: string } } | undefined)?.result?.fixedSource,
    ).toBe("async ({ input }) => ({ value: 42 })");
  });

  it("falls back to workflowHarness when a fixer harness delegates", async () => {
    const world = await tempWorld();
    const executeStep = vi.fn(() => {
      throw new Error("compute failed");
    });
    const workerHarness: Harness & { readonly harnessId: string } = {
      harnessId: "delegatingFixerHarness@1.0.0",
      async run(task) {
        if (task.kind === "execute_step" && task.step.uses === "code.run") {
          executeStep();
        }
        if (task.kind === "fix_step") {
          return { kind: "delegate_to_default" };
        }
        return { kind: "delegate_to_default" };
      },
    };
    const workflowVersion = lockedWorkflowVersion(
      "wfver_fixer_delegate_to_default",
      codeStepWorkflowWithFixer(),
      {
        "model.fast": { provider: "mock", modelId: "fast" },
      },
    );

    const result = await executeWorkflowVersion({
      world,
      workflowVersion,
      runId: "run_fixer_delegate_to_default",
      input: {},
      models: {
        "model.fast": { provider: "mock", modelId: "fast" },
      },
      workerHarness,
      maxAttempts: 1,
    });

    expect(result.status).toBe("failed");
    const sessionHarnessIds = (await listEvents(world, "run_fixer_delegate_to_default"))
      .filter((event) => event.type === "harness.session.started" && event.payload.role === "fixer")
      .map((event) => (event.payload.manifest as { harnessId?: string } | undefined)?.harnessId);
    expect(sessionHarnessIds).toContain("delegatingFixerHarness@1.0.0");
    expect(sessionHarnessIds).toContain("workflowHarness@1.0.0");
  });

  it("does not silently skip repair when a fixer delegates", async () => {
    const world = await tempWorld();
    const executeStep = vi.fn(() => {
      throw new Error("compute failed");
    });
    const fixerCalls: Array<number> = [];
    const workerHarness: Harness & { readonly harnessId: string } = {
      harnessId: "testFixerHarness@1.0.0",
      async run(task) {
        if (task.kind === "execute_step" && task.step.uses === "code.run") {
          executeStep();
        }
        if (task.kind === "fix_step") {
          fixerCalls.push(task.priorFixAttempts);
          return { kind: "delegate_to_default" };
        }
        return { kind: "delegate_to_default" };
      },
    };
    const workflowVersion = lockedWorkflowVersion(
      "wfver_fixer_exhaustion",
      codeStepWorkflowWithFixer(1),
      {
        "model.fast": { provider: "mock", modelId: "fast" },
      },
    );

    const result = await executeWorkflowVersion({
      world,
      workflowVersion,
      runId: "run_fixer_exhaustion",
      input: {},
      models: {
        "model.fast": { provider: "mock", modelId: "fast" },
      },
      workerHarness,
      maxAttempts: 2,
    });

    expect(result.status).toBe("failed");
    expect(executeStep).toHaveBeenCalledTimes(1);
    expect(fixerCalls).toEqual([0]);

    const events = await listEvents(world, "run_fixer_exhaustion");
    const fixerHarnessIds = events.filter((event) =>
      event.type === "harness.session.started" && event.payload.role === "fixer"
    ).map((event) => (event.payload.manifest as { harnessId?: string } | undefined)?.harnessId);
    expect(fixerHarnessIds).toEqual([
      "testFixerHarness@1.0.0",
      "workflowHarness@1.0.0",
    ]);
    expect(events.find((event) => event.type === "RunFailed")).toBeDefined();
  });
});

function codeStepWorkflowWithFixer(maxFixerAttempts = 2): LwirWorkflow {
  return {
    apiVersion: "littleworkflow.dev/v0.1",
    kind: "Workflow",
    metadata: { name: "fixer-recovery" },
    input: { schema: { type: "object" } },
    output: {
      schema: {
        type: "object",
        required: ["value"],
        additionalProperties: false,
        properties: {
          value: { type: "number" },
        },
      },
    },
    permissions: {
      models: ["model.fast"],
    },
    steps: [
      {
        id: "compute",
        uses: "code.run",
        with: {
          source: "async () => ({ value: 1 })",
        },
        onFailure: {
          fixer: {
            model: "model.fast",
            maxAttempts: maxFixerAttempts,
            system: "Fix failed code output to satisfy schema.",
          },
        },
        output: {
          mode: "object",
          schema: {
            type: "object",
            required: ["value"],
            additionalProperties: false,
            properties: {
              value: { type: "number" },
            },
          },
        },
      },
    ],
  } as unknown as LwirWorkflow;
}

function lockedWorkflowVersion(
  id: string,
  lwir: LwirWorkflow,
  models: Record<string, unknown>,
) {
  const modelSlots = Object.entries(models).map(([slotId, binding]) => ({
    slotId,
    role: "model",
    metadataHash: sha256Digest({}),
    modelIdentityHash: sha256Digest(modelIdentityForTest(slotId, binding)),
  }));
  const lwirHash = sha256Digest(lwir);
  const lwirVersionId = lwirVersionIdForHash(lwirHash);
  const canonicalizer = "little-workflow-canonical-json@alpha";
  const tools: Array<{
    readonly name: string;
    readonly scope: "global";
    readonly descriptionHash: string;
    readonly inputSchemaHash?: string;
    readonly outputSchemaHash?: string;
    readonly approvalRequired?: true;
  }> = [];
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
  const { workflowVersionId, workflowVersionHash } = computeCompiledWorkflowVersionIdentity({
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

function propertyValue(value: unknown, key: string): unknown {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    return undefined;
  }
  return Object.hasOwn(value, key) ? (value as Record<string, unknown>)[key] : undefined;
}

function stringProperty(value: unknown, key: string): string | undefined {
  const property = propertyValue(value, key);
  return typeof property === "string" ? property : undefined;
}
