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
import { resolveRepairPolicy } from "./runtime.js";
import { concreteInputStructure } from "./workflow-version-reuse.js";

it("defaults ai.generate steps to self-repair with 3 attempts", () => {
  expect(resolveRepairPolicy({ id: "g", uses: "ai.generate", with: { model: "m" } } as never)).toEqual({
    mode: "self",
    maxAttempts: 3,
  });
});

// This used to assert that `mode: "escalate"` flowed through resolveRepairPolicy —
// which it did, straight into a runtime branch that discarded it and repaired
// nothing. `validateLwir` now rejects escalate outright (see the
// "declared but unimplemented fields" suite in lwir.test.ts), so the explicit
// config under test is a self-repair budget that differs from the default of 3.
it("honors an explicit repair config", () => {
  expect(
    resolveRepairPolicy({
      id: "g",
      uses: "ai.generate",
      with: { model: "m" },
      onFailure: { repair: { mode: "self", maxAttempts: 2 } },
    } as never),
  ).toEqual({ mode: "self", maxAttempts: 2 });
});

it("returns undefined for non-ai.generate steps with no repair config", () => {
  expect(resolveRepairPolicy({ id: "t", uses: "tool.call", with: { tool: "x" } } as never)).toBeUndefined();
});

const tempDirs: string[] = [];

async function tempWorld() {
  const dataDir = await mkdtemp(join(tmpdir(), "little-workflow-repair-"));
  tempDirs.push(dataDir);
  return localWorld({ dataDir });
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("ai.generate output self-repair loop", () => {
  it("self-repair completes when the worker returns a valid object on a later attempt", async () => {
    const world = await tempWorld();
    const executeStep = vi.fn();
    const repairPrompts: string[] = [];
    const workerHarness: Harness & { readonly harnessId: string } = {
      harnessId: "testRepairHarness@1.0.0",
      async run(task) {
        if (task.kind === "execute_step" && task.step.uses === "ai.generate") {
          const callIndex = executeStep.mock.calls.length;
          executeStep();
          if (callIndex > 0) {
            // The repair re-run must feed the findings back through the dedicated channel
            // (with.outputRepairNote) the worker actually surfaces to the model.
            repairPrompts.push(String(task.step.with?.outputRepairNote ?? ""));
          }
          // Attempt 1: invalid (missing required `value`). Attempt 2: valid.
          const output = callIndex === 0 ? { wrong: "shape" } : { value: 42 };
          return { kind: "execute_step", output, artifactRefs: [] };
        }
        return { kind: "delegate_to_default" };
      },
    };
    const workflowVersion = lockedWorkflowVersion(
      "wfver_repair_success",
      aiGenerateWorkflow(),
      { "model.fast": { provider: "mock", modelId: "fast" } },
    );

    const result = await executeWorkflowVersion({
      world,
      workflowVersion,
      runId: "run_repair_success",
      input: {},
      models: { "model.fast": { provider: "mock", modelId: "fast" } },
      workerHarness,
    });

    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      expect(result.output).toEqual({ value: 42 });
    }
    // Initial invalid call + one repair call.
    expect(executeStep).toHaveBeenCalledTimes(2);

    const events = await listEvents(world, "run_repair_success");
    const repairAttempts = events.filter((event) => event.type === "StepRepairAttempted");
    expect(repairAttempts).toHaveLength(1);
    expect(repairAttempts[0]?.payload.stepPath).toBe("draft");
    expect(repairAttempts[0]?.payload.attempt).toBe(1);
    expect(Array.isArray(repairAttempts[0]?.payload.findings)).toBe(true);
    expect((repairAttempts[0]?.payload.findings as readonly string[]).length).toBeGreaterThan(0);

    // The findings must be fed back to the worker through with.outputRepairNote — that is
    // the whole point of self-repair, so assert the repair note actually carries them.
    expect(repairPrompts).toHaveLength(1);
    expect(repairPrompts[0]).toContain("[OUTPUT REPAIR]");
    for (const finding of repairAttempts[0]?.payload.findings as readonly string[]) {
      expect(repairPrompts[0]).toContain(finding);
    }
  });

  it("exhausts after maxAttempts repair attempts and fails with step_schema_error", async () => {
    const world = await tempWorld();
    const executeStep = vi.fn();
    const workerHarness: Harness & { readonly harnessId: string } = {
      harnessId: "testRepairHarness@1.0.0",
      async run(task) {
        if (task.kind === "execute_step" && task.step.uses === "ai.generate") {
          executeStep();
          return { kind: "execute_step", output: { wrong: "shape" }, artifactRefs: [] };
        }
        return { kind: "delegate_to_default" };
      },
    };
    const workflowVersion = lockedWorkflowVersion(
      "wfver_repair_exhaustion",
      aiGenerateWorkflow(),
      { "model.fast": { provider: "mock", modelId: "fast" } },
    );

    const result = await executeWorkflowVersion({
      world,
      workflowVersion,
      runId: "run_repair_exhaustion",
      input: {},
      models: { "model.fast": { provider: "mock", modelId: "fast" } },
      workerHarness,
    });

    expect(result.status).toBe("failed");
    // Default policy maxAttempts = 3: initial call + 3 repair calls = 4.
    expect(executeStep).toHaveBeenCalledTimes(4);

    const events = await listEvents(world, "run_repair_exhaustion");
    expect(events.filter((event) => event.type === "StepRepairAttempted")).toHaveLength(3);
    const runFailed = events.find((event) => event.type === "RunFailed");
    expect(runFailed).toBeDefined();
    expect(stringProperty(propertyValue(runFailed?.payload, "error"), "causeCode")).toBe(
      "step_schema_error",
    );
  });

  it("self-repair is replay-safe: re-running reuses the committed output with no new worker calls", async () => {
    const world = await tempWorld();
    const firstHarness = repairHarnessReturningValidOnSecondCall();
    const workflowVersion = lockedWorkflowVersion(
      "wfver_repair_replay",
      aiGenerateWorkflow(),
      { "model.fast": { provider: "mock", modelId: "fast" } },
    );

    const first = await executeWorkflowVersion({
      world,
      workflowVersion,
      runId: "run_repair_replay",
      input: {},
      models: { "model.fast": { provider: "mock", modelId: "fast" } },
      workerHarness: firstHarness.harness,
    });
    expect(first.status).toBe("completed");
    expect(firstHarness.executeStep).toHaveBeenCalledTimes(2);

    const replayExecuteStep = vi.fn();
    const replayHarness: Harness & { readonly harnessId: string } = {
      harnessId: "testRepairHarness@1.0.0",
      async run(task) {
        if (task.kind === "execute_step") {
          replayExecuteStep();
        }
        return { kind: "execute_step", output: { value: -1 }, artifactRefs: [] };
      },
    };

    const replay = await executeWorkflowVersion({
      world,
      workflowVersion,
      runId: "run_repair_replay",
      input: {},
      models: { "model.fast": { provider: "mock", modelId: "fast" } },
      workerHarness: replayHarness,
    });

    expect(replay.status).toBe("completed");
    if (replay.status === "completed") {
      expect(replay.output).toEqual({ value: 42 });
    }
    expect(replayExecuteStep).not.toHaveBeenCalled();
  });

  it("feeds the target output schema back when the worker returns a NON-record (the live failure path)", async () => {
    const world = await tempWorld();
    const executeStep = vi.fn();
    const repairPrompts: string[] = [];
    const workerHarness: Harness & { readonly harnessId: string } = {
      harnessId: "testRepairHarness@1.0.0",
      async run(task) {
        if (task.kind === "execute_step" && task.step.uses === "ai.generate") {
          const callIndex = executeStep.mock.calls.length;
          executeStep();
          if (callIndex > 0) {
            repairPrompts.push(String(task.step.with?.outputRepairNote ?? ""));
          }
          // Attempt 1: a NON-record (array) → !isRecord → "does not match object output mode"
          // (this is the failure mode every live deepseek run actually hit). Attempt 2: valid.
          const output = callIndex === 0 ? ["not", "an", "object"] : { value: 42 };
          return { kind: "execute_step", output, artifactRefs: [] };
        }
        return { kind: "delegate_to_default" };
      },
    };
    const workflowVersion = lockedWorkflowVersion(
      "wfver_repair_nonrecord",
      aiGenerateWorkflow(),
      { "model.fast": { provider: "mock", modelId: "fast" } },
    );

    const result = await executeWorkflowVersion({
      world,
      workflowVersion,
      runId: "run_repair_nonrecord",
      input: {},
      models: { "model.fast": { provider: "mock", modelId: "fast" } },
      workerHarness,
    });

    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      expect(result.output).toEqual({ value: 42 });
    }
    // The repair prompt must carry the TARGET SCHEMA — "that wasn't an object" alone gives the
    // model nothing to anchor on. "additionalProperties" and the property type "number" appear
    // ONLY in the output schema, never in the original prompt ("Produce a value.") or the repair
    // boilerplate ("the required schema") — so these fail unless the schema is actually fed back.
    expect(repairPrompts).toHaveLength(1);
    expect(repairPrompts[0]).toContain("additionalProperties");
    expect(repairPrompts[0]).toContain("number");
  });
});

function repairHarnessReturningValidOnSecondCall(): {
  readonly harness: Harness & { readonly harnessId: string };
  readonly executeStep: ReturnType<typeof vi.fn>;
} {
  const executeStep = vi.fn();
  const harness: Harness & { readonly harnessId: string } = {
    harnessId: "testRepairHarness@1.0.0",
    async run(task) {
      if (task.kind === "execute_step" && task.step.uses === "ai.generate") {
        const callIndex = executeStep.mock.calls.length;
        executeStep();
        const output = callIndex === 0 ? { wrong: "shape" } : { value: 42 };
        return { kind: "execute_step", output, artifactRefs: [] };
      }
      return { kind: "delegate_to_default" };
    },
  };
  return { harness, executeStep };
}

function aiGenerateWorkflow(): LwirWorkflow {
  const objectSchema = {
    type: "object",
    required: ["value"],
    additionalProperties: false,
    properties: {
      value: { type: "number" },
    },
  };
  return {
    apiVersion: "littleworkflow.dev/v0.1",
    kind: "Workflow",
    metadata: { name: "repair-recovery" },
    input: { schema: { type: "object" } },
    output: { schema: objectSchema },
    permissions: { models: ["model.fast"] },
    steps: [
      {
        id: "draft",
        uses: "ai.generate",
        with: { model: "model.fast", prompt: "Produce a value." },
        output: { mode: "object", schema: objectSchema },
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
