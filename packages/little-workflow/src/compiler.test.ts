import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { sha256Digest } from "./canonical.js";
import {
  compileWorkflow,
  toOrchestrationRequest,
  WorkflowMissingToolError,
  type PlannerAdapter,
  type PlannerRepairContext,
  type SuperviseOuterLoopState,
  type SuperviseDecision,
} from "./compiler.js";
import {
  createLittleWorkflow,
  createToolRegistry,
  model,
  output,
  skill,
  workflowHarness,
  type Harness,
  type HarnessResult,
  type HarnessTask,
  type ModelSelectionMetadata,
} from "./index.js";
import type { LwirValidationFinding } from "./lwir.js";
import {
  getPlanningDefinitionHash,
  getPlanningDefinitionSnapshot,
  getWorkflowDefinitionHash,
  type WorkflowDefinitionSnapshotInput,
} from "./workflow-definition-hash.js";
import { concreteInputStructureHash } from "./workflow-version-reuse.js";

const ticketInputSchema = {
  type: "object",
  required: ["ticketId", "body"],
  additionalProperties: false,
  properties: {
    ticketId: { type: "string" },
    body: { type: "string" },
  },
};

const classifiedTicketInputSchema = {
  type: "object",
  required: ["ticketId", "body", "severity"],
  additionalProperties: false,
  properties: {
    ticketId: { type: "string" },
    body: { type: "string" },
    severity: { type: "string", enum: ["low", "medium", "high"] },
  },
};

const ticketOutputSchema = {
  type: "object",
  required: ["summary", "severity"],
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
    severity: { type: "string", enum: ["low", "medium", "high"] },
  },
};

const workerModel = model(
  { provider: "test", modelId: "worker" },
  {
    id: "model.fast",
    description: "Summarizes tickets.",
  },
);

const lookupCustomerDescriptor = {
  description: "Look up customer plan metadata.",
  inputSchema: {
    type: "object",
    required: ["ticketId"],
    properties: { ticketId: { type: "string" } },
  },
};

const workflowRegistry = createToolRegistry({
  lookupCustomer: {
    ...lookupCustomerDescriptor,
    execute: async () => ({}),
  },
});

const workflow = workflowDef({
  id: "support.summarize",
  description: "Summarize a support ticket.",
  inputSchema: ticketInputSchema,
  output: output.object({ schema: ticketOutputSchema, name: "ticketSummary" }),
  models: [workerModel],
  globalTools: ["lookupCustomer"],
  toolSelection: "planner_selected",
});

function harness(harnessId = "compilerHarness@1.0.0"): Harness & { readonly harnessId: string } {
  return Object.assign(
    {
      async run(task: HarnessTask): Promise<HarnessResult> {
        switch (task.kind) {
          case "plan":
            return { kind: "plan", lwir: validLwir() };
          case "orchestrate":
            return { kind: "orchestrate", output: { ok: true } };
          case "execute_step":
            return { kind: "execute_step", output: task.stepInput, artifactRefs: [] };
          case "fix_step":
            return {
              kind: "fix_step",
              output: task.stepInput,
              fixedSource: "async () => ({})",
              attempts: 1,
            };
        }
      },
    } satisfies Harness,
    { harnessId },
  );
}

function workflowDef(
  definition: WorkflowDefinitionSnapshotInput & { readonly suggestedInputSchema?: unknown },
): WorkflowDefinitionSnapshotInput & { readonly suggestedInputSchema?: unknown } {
  return createLittleWorkflow({
    models: [workerModel],
    ...definition,
  } as unknown as Parameters<typeof createLittleWorkflow>[0]) as WorkflowDefinitionSnapshotInput;
}

function skillIdentity(source: string, name: string, frontmatterHash: string) {
  return Object.assign(skill(source), { name, frontmatterHash });
}

function validLwir() {
  return {
    apiVersion: "littleworkflow.dev/v0.1",
    kind: "Workflow",
    metadata: {
      name: "support.summarize",
      version: "0.1.0-alpha",
      description: "Summarize a support ticket.",
    },
    input: { schema: ticketInputSchema },
    output: { schema: ticketOutputSchema },
    permissions: {
      models: ["model.fast"],
      tools: ["lookupCustomer"],
      secrets: [],
      network: [],
    },
    steps: [
      {
        id: "lookup-customer",
        uses: "tool.call",
        with: {
          tool: "lookupCustomer",
          args: { ticketId: "{{ input.ticketId }}" },
        },
        output: { mode: "json", schema: true },
      },
      {
        id: "summarize",
        uses: "ai.generate",
        needs: ["lookup-customer"],
        with: {
          model: "model.fast",
          prompt:
            "Summarize {{ input.body }} with customer context {{ steps.lookup-customer.output }}.",
        },
        output: { mode: "object", schema: ticketOutputSchema },
      },
    ],
  };
}

describe("compiler and planner repair loop", () => {
  it("normalizes a workflow definition into a canonical OrchestrationRequest", () => {
    const request = toOrchestrationRequest(workflow, {
      input: { ticketId: "TIN-1", body: "Export failed." },
      tools: workflowRegistry,
      requestId: "orq_test",
      actor: { type: "user", id: "usr_123" },
      controls: { maxWorkflowRevisions: 2 },
    });

    expect(request).toEqual({
      apiVersion: "littleworkflow.dev/v0.1",
      kind: "OrchestrationRequest",
      requestId: "orq_test",
      actor: { type: "user", id: "usr_123" },
      metadata: {
        name: "support.summarize",
        description: "Summarize a support ticket.",
      },
      messages: {
        user: "Summarize a support ticket.",
      },
      input: { ticketId: "TIN-1", body: "Export failed." },
      inputSchema: ticketInputSchema,
      requestedOutput: {
        mode: "object",
        schema: ticketOutputSchema,
        name: "ticketSummary",
      },
      capabilityManifest: {
        stepTypes: ["ai.generate", "tool.call", "code.run", "parallel", "decision"],
        toolSelection: "planner_selected",
        tools: [
          expect.objectContaining({
            name: "lookupCustomer",
            scope: "global",
            description: "Look up customer plan metadata.",
            descriptionHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
            inputSchemaHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
          }),
        ],
        models: expect.arrayContaining([
          expect.objectContaining({
            slotId: "model.fast",
            role: "model",
            metadataHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
            modelIdentityHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
          }),
        ]),
        modelSlots: ["model.fast"],
        secrets: [],
        network: { default: "deny", allow: [] },
        bash: {
          network: false,
          python: true,
          javascript: true,
        },
        workerHarness: {
          harnessId: "workflowHarness@1.0.0",
        },
      },
      controls: { maxWorkflowRevisions: 2 },
      locks: expect.objectContaining({
        workflowDefinitionHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        inputSchemaHash: sha256Digest(ticketInputSchema),
        requestedOutputHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        modelSlots: expect.arrayContaining([
          expect.objectContaining({
            slotId: "model.fast",
            role: "model",
            metadataHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
          }),
        ]),
        tools: expect.arrayContaining([
          expect.objectContaining({
            name: "lookupCustomer",
            scope: "global",
            descriptionHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
            inputSchemaHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
          }),
        ]),
      }),
    });
  });

  it("uses the workflow definition hash snapshot for compiler request locks", () => {
    const baseWorkflow = workflowDef({
      ...workflow,
      planner: {
        model: { provider: "test", modelId: "planner" },
        harness: harness("compilerPlanner@1.0.0"),
        system: "Plan with customer context.",
        skills: [skillIdentity("skills/planner.md", "planner", "sha256:planner")],
      },
      worker: {
        harness: harness("compilerWorker@1.0.0"),
        skills: [skillIdentity("skills/worker.md", "worker", "sha256:worker")],
      },
      memory: {
        workflow: "rw",
        org: "ro",
        attach: [{ id: "kb", mode: "ro" }],
      },
    });
    const base = toOrchestrationRequest(baseWorkflow, {
      input: { ticketId: "TIN-1", body: "Export failed." },
      tools: workflowRegistry,
      requestId: "orq_definition_hash_base",
    });

    expect(base.locks.workflowDefinitionHash).toBe(
      getWorkflowDefinitionHash(baseWorkflow, workflowRegistry),
    );

    const variants = [
      workflowDef({
        ...baseWorkflow,
        planner: {
          model: { provider: "test", modelId: "planner" },
          harness: harness("compilerPlanner@1.0.0"),
          system: "Plan with escalations in mind.",
          skills: [skillIdentity("skills/planner.md", "planner", "sha256:planner")],
        },
      }),
      workflowDef({
        ...baseWorkflow,
        planner: {
          model: { provider: "test", modelId: "planner" },
          harness: harness("compilerPlanner@2.0.0"),
          system: "Plan with customer context.",
          skills: [skillIdentity("skills/planner.md", "planner", "sha256:planner")],
        },
      }),
      workflowDef({
        ...baseWorkflow,
        planner: {
          model: { provider: "test", modelId: "planner" },
          harness: harness("compilerPlanner@1.0.0"),
          system: "Plan with customer context.",
          skills: [skillIdentity("skills/planner-v2.md", "planner", "sha256:planner-v2")],
        },
      }),
      workflowDef({
        ...baseWorkflow,
        worker: {
          harness: harness("compilerWorker@2.0.0"),
          skills: [skillIdentity("skills/worker.md", "worker", "sha256:worker")],
        },
      }),
      workflowDef({
        ...baseWorkflow,
        worker: {
          harness: harness("compilerWorker@1.0.0"),
          skills: [skillIdentity("skills/worker-v2.md", "worker", "sha256:worker-v2")],
        },
      }),
      workflowDef({
        ...baseWorkflow,
        memory: {
          workflow: "ro",
          org: "ro",
          attach: [{ id: "kb", mode: "ro" }],
        },
      }),
    ];

    for (const variant of variants) {
      const request = toOrchestrationRequest(variant, {
        input: { ticketId: "TIN-1", body: "Export failed." },
        tools: workflowRegistry,
        requestId: "orq_definition_hash_variant",
      });

      expect(request.locks.workflowDefinitionHash).not.toBe(
        base.locks.workflowDefinitionHash,
      );
    }
  });

  it("omits absent optional request fields", () => {
    const request = toOrchestrationRequest(workflow, {
      input: { ticketId: "TIN-1", body: "Export failed." },
      tools: workflowRegistry,
      requestId: "orq_no_actor",
    });

    expect(Object.hasOwn(request, "actor")).toBe(false);
    expect(sha256Digest(request)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("derives default request ids from the full request body", () => {
    const input = { ticketId: "TIN-1", body: "Export failed." };
    const base = toOrchestrationRequest(workflow, { input, tools: workflowRegistry });
    const explicitOnly = toOrchestrationRequest(
      workflowDef({ ...workflow, toolSelection: "explicit_only" }),
      { input, tools: workflowRegistry },
    );
    const withControls = toOrchestrationRequest(workflow, {
      input,
      tools: workflowRegistry,
      controls: { maxWorkflowRevisions: 2 },
    });
    const withActor = toOrchestrationRequest(workflow, {
      input,
      tools: workflowRegistry,
      actor: { type: "user", id: "usr_123" },
    });

    expect(base.requestId).toMatch(/^orq_[0-9a-f]{16}$/);
    expect(new Set([
      base.requestId,
      explicitOnly.requestId,
      withControls.requestId,
      withActor.requestId,
    ])).toHaveLength(4);
  });

  it("hashes the exact request instance after assigning the request id", () => {
    const request = toOrchestrationRequest(workflow, {
      input: { ticketId: "TIN-1", body: "Export failed." },
      tools: workflowRegistry,
      requestId: "orq_explicit",
    });
    const { requestHash: _requestHash, ...locksWithoutRequestHash } = request.locks;

    expect(request.locks.requestHash).toBe(
      sha256Digest({ ...request, locks: locksWithoutRequestHash }),
    );

    const sameBodyDifferentId = toOrchestrationRequest(workflow, {
      input: { ticketId: "TIN-1", body: "Export failed." },
      tools: workflowRegistry,
      requestId: "orq_other",
    });

    expect(sameBodyDifferentId.locks.requestHash).not.toBe(request.locks.requestHash);
  });

  it("canonical-clones request input instead of freezing caller-owned values", () => {
    const input = { ticketId: "TIN-1", body: "Export failed." };
    const request = toOrchestrationRequest(workflow, {
      input,
      tools: workflowRegistry,
      requestId: "orq_clone_input",
    });

    expect(request.input).toEqual(input);
    expect(request.input).not.toBe(input);
    expect(Object.isFrozen(input)).toBe(false);

    input.body = "Mutated after request creation.";

    expect(request.input).toEqual({ ticketId: "TIN-1", body: "Export failed." });
  });

  it("validates request input when creating an OrchestrationRequest directly", () => {
    expect(() =>
      toOrchestrationRequest(workflow, {
        input: { ticketId: "TIN-1" },
        tools: workflowRegistry,
        requestId: "orq_direct_invalid_input",
      }),
    ).toThrowError("data must have required property 'body'");
  });

  it("validates input and output schemas before hashing an OrchestrationRequest", () => {
    expect(() =>
      toOrchestrationRequest(
        workflowDef({
          id: "support.invalid-schema",
          inputSchema: { type: "nonsense" },
          outputSchema: true,
        }),
        {
          input: {},
          requestId: "orq_invalid_input_schema",
        },
      ),
    ).toThrowError("data/type must");

    expect(() =>
      toOrchestrationRequest(
        workflowDef({
          id: "support.unsupported-output-schema",
          inputSchema: true,
          output: output.object({
            schema: {
              type: "object",
              patternProperties: { "^x-": { type: "string" } },
            },
          }),
        }),
        {
          input: {},
          requestId: "orq_unsupported_output_schema",
        },
      ),
    ).toThrowError("Unsupported JSON Schema keyword 'patternProperties' in alpha LWIR.");
  });

  it("validates tool input schemas before capability hashing", () => {
    const badToolRegistry = createToolRegistry({
      lookupCustomer: {
        description: "Look up customer metadata.",
        inputSchema: {
          type: "object",
          patternProperties: { "^x-": { type: "string" } },
        },
        execute: async () => ({}),
      },
    });
    expect(() =>
      toOrchestrationRequest(
        workflowDef({
          id: "support.invalid-tool-schema",
          inputSchema: true,
          outputSchema: true,
          globalTools: ["lookupCustomer"],
        }),
        {
          input: {},
          tools: badToolRegistry,
          requestId: "orq_invalid_tool_schema",
        },
      ),
    ).toThrowError("Unsupported JSON Schema keyword 'patternProperties' in alpha LWIR.");
  });

  it("throws WorkflowMissingToolError when a globalTools name is not in the registry", () => {
    const emptyRegistry = createToolRegistry();
    const missingToolWorkflow = workflowDef({
      id: "support.missing-tool",
      description: "Workflow referencing an unregistered tool.",
      inputSchema: ticketInputSchema,
      output: output.object({ schema: ticketOutputSchema }),
      globalTools: ["lookupCustomer"],
    });

    expect(() =>
      toOrchestrationRequest(missingToolWorkflow, {
        input: { ticketId: "TIN-1", body: "Export failed." },
        tools: emptyRegistry,
        requestId: "orq_missing_tool",
      }),
    ).toThrow(WorkflowMissingToolError);

    expect(() =>
      toOrchestrationRequest(missingToolWorkflow, {
        input: { ticketId: "TIN-1", body: "Export failed." },
        tools: emptyRegistry,
        requestId: "orq_missing_tool_message",
      }),
    ).toThrowError("tool 'lookupCustomer' is not registered");
  });

  it("derives tool lock metadata from registry.get without calling descriptor()", () => {
    const registry = createToolRegistry({
      lookupCustomer: {
        description: "Look up customer metadata.",
        inputSchema: {
          type: "object",
          required: ["ticketId"],
          properties: { ticketId: { type: "string" } },
        },
        outputSchema: {
          type: "object",
          properties: { plan: { type: "string" } },
        },
        execute: async () => ({ plan: "pro" }),
      },
    });
    const descriptorSpy = vi.fn(() => {
      throw new Error("legacy descriptor() should not be called");
    });
    (registry as unknown as { descriptor: typeof descriptorSpy }).descriptor = descriptorSpy;

    const request = toOrchestrationRequest(
      workflowDef({
        id: "support.tool-via-get",
        description: "Hash tool lock metadata via registry.get.",
        inputSchema: ticketInputSchema,
        output: output.object({ schema: ticketOutputSchema }),
        globalTools: ["lookupCustomer"],
      }),
      {
        input: { ticketId: "TIN-1", body: "Export failed." },
        tools: registry,
        requestId: "orq_tool_via_get",
      },
    );

    expect(request.requestId).toBe("orq_tool_via_get");
    expect(descriptorSpy).not.toHaveBeenCalled();
  });

  it("rejects non-hashable request input even with an explicit request id", () => {
    expect(() =>
      toOrchestrationRequest(
        workflowDef({
          id: "support.any-input",
          inputSchema: true,
          outputSchema: true,
        }),
        {
          input: new Map([["ticketId", "TIN-1"]]),
          requestId: "orq_non_hashable_input",
        },
      ),
    ).toThrow();
  });

  it("omits undefined optional workflow metadata from hashes", () => {
    const request = toOrchestrationRequest(
      workflowDef({
        id: "support.metadata",
        description: undefined,
        inputSchema: true,
        outputSchema: true,
        models: [
          model(
            { provider: "test", modelId: "worker" },
            {
              description: undefined,
            },
          ),
        ],
      }),
      {
        input: { ticketId: "TIN-1" },
        requestId: "orq_metadata",
      },
    );

    expect(request.locks.workflowDefinitionHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(request.locks.modelSlots[0]?.metadataHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("omits unsafe model metadata fields from planner-visible snapshots and hashes", () => {
    const cleanMetadata = {
      description: "Safe worker metadata.",
    } satisfies ModelSelectionMetadata;
    const cleanRequest = toOrchestrationRequest(
      workflowDef({
        id: "support.safe-model-metadata",
        inputSchema: true,
        outputSchema: true,
        models: [model({ provider: "test", modelId: "worker" }, cleanMetadata)],
      }),
      {
        input: {},
        requestId: "orq_safe_metadata",
      },
    );
    const requestWithUnsafeMetadata = toOrchestrationRequest(
      workflowDef({
        id: "support.safe-model-metadata",
        inputSchema: true,
        outputSchema: true,
        models: [
          model(
            { provider: "test", modelId: "worker" },
            {
              ...cleanMetadata,
              apiKey: "secret_should_not_enter_planner_context",
            } as ModelSelectionMetadata & { readonly apiKey: string },
          ),
        ],
      }),
      {
        input: {},
        requestId: "orq_safe_metadata",
      },
    );

    expect(requestWithUnsafeMetadata.capabilityManifest.models[0]?.metadata).toEqual(
      cleanRequest.capabilityManifest.models[0]?.metadata,
    );
    expect(
      requestWithUnsafeMetadata.capabilityManifest.models[0]?.metadata,
    ).not.toHaveProperty("apiKey");
    expect(requestWithUnsafeMetadata.locks.modelSlots[0]?.metadataHash).toBe(
      cleanRequest.locks.modelSlots[0]?.metadataHash,
    );
    expect(requestWithUnsafeMetadata.locks.workflowDefinitionHash).toBe(
      cleanRequest.locks.workflowDefinitionHash,
    );
  });

  it("derives unique model slot locks from model identity", () => {
    const request = toOrchestrationRequest(
      workflowDef({
        id: "support.multi-model",
        inputSchema: true,
        outputSchema: true,
        models: [
          model({ provider: "test", modelId: "worker-a" }),
          model({ provider: "test", modelId: "worker-b" }),
          model({ provider: "test", modelId: "worker-reasoning" }),
        ],
      }),
      {
        input: {},
        requestId: "orq_models",
      },
    );

    expect(request.capabilityManifest.modelSlots).toEqual([
      "worker-a",
      "worker-b",
      "worker-reasoning",
    ]);
    expect(request.locks.modelSlots).toEqual([
      expect.objectContaining({
        slotId: "worker-a",
        modelIdentityHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      }),
      expect.objectContaining({
        slotId: "worker-b",
        modelIdentityHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      }),
      expect.objectContaining({
        slotId: "worker-reasoning",
        modelIdentityHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      }),
    ]);
    expect(request.locks.modelSlots[0]?.modelIdentityHash).not.toBe(
      request.locks.modelSlots[1]?.modelIdentityHash,
    );
  });

  it("exposes workflow models as a flat execution model slot set", () => {
    const request = toOrchestrationRequest(
      workflowDef({
        id: "support.execution-models",
        inputSchema: true,
        outputSchema: true,
        models: [
          model({ provider: "test", modelId: "fast-model" }),
          model({ provider: "test", modelId: "reasoning-model" }),
        ],
      }),
      {
        input: {},
        requestId: "orq_execution_models",
      },
    );

    expect(request.capabilityManifest.modelSlots).toEqual([
      "fast-model",
      "reasoning-model",
    ]);
    expect(request.locks.modelSlots).toEqual([
      expect.objectContaining({
        slotId: "fast-model",
        role: "model",
      }),
      expect.objectContaining({
        slotId: "reasoning-model",
        role: "model",
      }),
    ]);
  });

  it("keeps planner adapter tools out of workflow model metadata", () => {
    const request = toOrchestrationRequest(
      workflowDef({
        id: "support.model-metadata-tools",
        inputSchema: true,
        outputSchema: true,
        models: [
          model(
            { provider: "test", modelId: "worker" },
            {
              tools: {
                inspectRepo: {
                  description: "Read repository metadata while planning.",
                  inputSchema: {
                    type: "object",
                    properties: { path: { type: "string" } },
                  },
                },
              },
            } as ModelSelectionMetadata & {
              tools: Record<string, unknown>;
            },
          ),
        ],
      }),
      {
        input: {},
        requestId: "orq_model_metadata_tools",
      },
    );

    expect(request.capabilityManifest.tools).toEqual([]);
    expect(request.locks.tools).toEqual([]);
    expect(request.capabilityManifest.models[0]?.metadata).not.toHaveProperty("tools");
  });

  it("falls back to index-based slot ids for opaque object-shaped model slots", () => {
    const request = toOrchestrationRequest(
      workflowDef({
        id: "support.opaque-object-model",
        inputSchema: true,
        outputSchema: true,
        models: [model({}, {})],
      }),
      {
        input: {},
        requestId: "orq_opaque_object_model",
      },
    );

    expect(request.capabilityManifest.models).toEqual([
      expect.objectContaining({
        modelIdentity: {
          slotId: "model-0",
        },
      }),
    ]);
  });

  it("validates input before calling the planner", async () => {
    const planner: PlannerAdapter = {
      draft: vi.fn(async () => validLwir()),
    };

    await expect(
      compileWorkflow(workflow, {
        input: { ticketId: "TIN-1" },
        tools: workflowRegistry,
        planner,
      }),
    ).rejects.toMatchObject({
      name: "WorkflowInputValidationError",
    });
    expect(planner.draft).not.toHaveBeenCalled();
  });

  it("uses JSON Schema validation for input before calling the planner", async () => {
    const planner: PlannerAdapter = {
      draft: vi.fn(async () => validLwir()),
    };
    const classifiedWorkflow = workflowDef({
      ...workflow,
      inputSchema: classifiedTicketInputSchema,
    });

    await expect(
      compileWorkflow(classifiedWorkflow, {
        input: { ticketId: "TIN-1", body: "Export failed.", severity: "urgent" },
        tools: workflowRegistry,
        planner,
        requestId: "orq_invalid_enum",
      }),
    ).rejects.toMatchObject({
      name: "WorkflowInputValidationError",
    });
    expect(planner.draft).not.toHaveBeenCalled();
  });

  it("returns a registered workflow version and lock metadata for valid planner output", async () => {
    const planner: PlannerAdapter = {
      draft: vi.fn(async () => validLwir()),
    };

    const result = await compileWorkflow(workflow, {
      input: { ticketId: "TIN-1", body: "Export failed." },
      tools: workflowRegistry,
      planner,
      requestId: "orq_compile",
    });

    expect(result.request.requestId).toBe("orq_compile");
    expect(result.revisions).toHaveLength(1);
    expect(result.revisions[0]).toEqual(
      expect.objectContaining({ revision: 1, valid: true, findings: [] }),
    );
    expect(result.workflowVersion.lwirHash).toBe(sha256Digest(result.workflowVersion.lwir));
    expect(result.workflowVersion.hash).not.toBe(result.workflowVersion.lwirHash);
    expect(Object.isFrozen(result.workflowVersion.lock)).toBe(true);
    expect(result.workflowVersion.lock).toBe(result.lock);
    expect(result.lock.capabilityManifest).toBe(result.request.capabilityManifest);
    expect(result.lock.modelSlots).toBe(result.request.locks.modelSlots);
    expect(result.lock.tools).toBe(result.request.locks.tools);
    expect(result.lock.planningDefinitionSnapshot).toEqual(
      getPlanningDefinitionSnapshot(workflow, workflowRegistry),
    );
    expect(result.lock.planningDefinitionSnapshotHash).toBe(
      getPlanningDefinitionHash(workflow, workflowRegistry),
    );
    expect(result.lock).toEqual(
      expect.objectContaining({
        workflowVersionId: result.workflowVersion.id,
        workflowVersionHash: result.workflowVersion.hash,
        lwirVersionId: result.workflowVersion.lwirVersionId,
        lwirHash: result.workflowVersion.lwirHash,
        requestId: result.request.requestId,
        requestHash: result.request.locks.requestHash,
        inputHash: result.request.locks.inputHash,
        plannedInputStructureHash: result.request.locks.plannedInputStructureHash,
        inputBinding: "required",
        workflowDefinitionHash: result.request.locks.workflowDefinitionHash,
        inputSchemaHash: result.request.locks.inputSchemaHash,
        requestedOutput: result.request.requestedOutput,
        requestedOutputHash: result.request.locks.requestedOutputHash,
        capabilityManifest: result.request.capabilityManifest,
        capabilityManifestHash: sha256Digest(result.request.capabilityManifest),
        modelSlots: result.request.locks.modelSlots,
        tools: result.request.locks.tools,
        planningDefinitionSnapshot: getPlanningDefinitionSnapshot(workflow, workflowRegistry),
        planningDefinitionSnapshotHash: getPlanningDefinitionHash(workflow, workflowRegistry),
        validationHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      }),
    );
    expect(Object.isFrozen(result.lock.capabilityManifest.tools[0])).toBe(true);
    expect(result.lock.requestHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.lock.inputHash).toBe(sha256Digest(result.request.input));
    expect(result.lock.plannedInputStructureHash).toBe(
      concreteInputStructureHash(result.request.input),
    );
    expect(planner.draft).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "OrchestrationRequest" }),
      undefined,
    );
  });

  it("compiles the inner LWIR from adapt planner decision envelopes", async () => {
    const adaptedLwir = {
      ...validLwir(),
      metadata: {
        ...validLwir().metadata,
        version: "0.1.0-adapt",
      },
    };
    const planner: PlannerAdapter = {
      draft: vi.fn(async () => ({
        kind: "adapt",
        baseWorkflowVersionId: "wfver_prior",
        rationale: "Reuse the prior graph shape with refreshed prompts.",
        lwir: adaptedLwir,
      })),
    };

    const result = await compileWorkflow(workflow, {
      input: { ticketId: "TIN-1", body: "Export failed." },
      tools: workflowRegistry,
      planner,
      requestId: "orq_adapt_decision",
    });

    expect(result.revisions).toHaveLength(1);
    expect(result.revisions[0]).toEqual(
      expect.objectContaining({ revision: 1, valid: true, findings: [], lwir: adaptedLwir }),
    );
    expect(result.workflowVersion.lwir).toEqual(adaptedLwir);
    expect(result.plannerReuseDecision).toEqual({
      kind: "adapt",
      baseWorkflowVersionId: "wfver_prior",
      rationale: "Reuse the prior graph shape with refreshed prompts.",
    });
  });

  it("compiles the inner LWIR from draft_fresh planner decision envelopes", async () => {
    const freshLwir = {
      ...validLwir(),
      metadata: {
        ...validLwir().metadata,
        version: "0.1.0-fresh",
      },
    };
    const planner: PlannerAdapter = {
      draft: vi.fn(async () => ({
        kind: "draft_fresh",
        rationale: "No prior workflow version fits this request.",
        lwir: freshLwir,
      })),
    };

    const result = await compileWorkflow(workflow, {
      input: { ticketId: "TIN-1", body: "Export failed." },
      tools: workflowRegistry,
      planner,
      requestId: "orq_draft_fresh_decision",
    });

    expect(result.revisions).toHaveLength(1);
    expect(result.revisions[0]).toEqual(
      expect.objectContaining({ revision: 1, valid: true, findings: [], lwir: freshLwir }),
    );
    expect(result.workflowVersion.lwir).toEqual(freshLwir);
    expect(result.plannerReuseDecision).toEqual({
      kind: "draft_fresh",
      rationale: "No prior workflow version fits this request.",
    });
  });

  it("surfaces reuse_unchanged planner decisions as a runtime integration sentinel", async () => {
    const planner: PlannerAdapter = {
      draft: vi.fn(async () => ({
        kind: "reuse_unchanged",
        workflowVersionId: "wfver_reuse",
        rationale: "The prior compiled workflow still matches.",
        acknowledgedWarnings: ["planning definition changed"],
      })),
    };

    await expect(
      compileWorkflow(workflow, {
        input: { ticketId: "TIN-1", body: "Export failed." },
        tools: workflowRegistry,
        planner,
        maxWorkflowRevisions: 1,
      }),
    ).rejects.toMatchObject({
      name: "PlannerReuseUnchangedDecisionError",
      workflowVersionId: "wfver_reuse",
      rationale: "The prior compiled workflow still matches.",
      acknowledgedWarnings: ["planning definition changed"],
    });
    await expect(
      compileWorkflow(workflow, {
        input: { ticketId: "TIN-1", body: "Export failed." },
        tools: workflowRegistry,
        planner,
        maxWorkflowRevisions: 1,
      }),
    ).rejects.not.toMatchObject({
      name: "WorkflowCompileError",
    });
  });

  it("uses workflow planner harness when planner adapter is omitted", async () => {
    const plannerHarnessRun = vi.fn<Harness["run"]>(async (task, ctx) => {
      expect(task.kind).toBe("plan");
      if (task.kind !== "plan") {
        throw new Error("expected plan task");
      }
      expect(task.workflowSnapshot).toEqual(
        expect.objectContaining({
          id: "support.summarize",
          workflowDefinitionHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
        }),
      );
      expect(task.input).toEqual({ ticketId: "TIN-1", body: "Export failed." });
      expect(ctx.scope.role).toBe("planner");
      expect(ctx.system).toBe("Plan with a harness.");
      return { kind: "plan", lwir: validLwir() };
    });
    const workflowWithPlannerHarness = workflowDef({
      ...workflow,
      planner: {
        model: { provider: "test", modelId: "planner-harness" },
        harness: {
          harnessId: "plannerHarness@1.0.0",
          run: plannerHarnessRun,
        },
        system: "Plan with a harness.",
      },
    });

    const result = await compileWorkflow(workflowWithPlannerHarness, {
      input: { ticketId: "TIN-1", body: "Export failed." },
      tools: workflowRegistry,
      requestId: "orq_planner_harness",
    });

    expect(result.workflowVersion.id).toMatch(/^wfver_[0-9a-f]{16}$/u);
    expect(result.revisions).toHaveLength(1);
    expect(plannerHarnessRun).toHaveBeenCalledTimes(1);
  });

  it("passes suggestedInputSchema to the planner without using it as the hard input schema", async () => {
    const tasks: HarnessTask[] = [];
    const plannerHarness: Harness = {
      async run(task) {
        tasks.push(task);
        return {
          kind: "plan",
          lwir: {
            apiVersion: "littleworkflow.dev/v0.1",
            kind: "Workflow",
            metadata: { name: "flexible-input" },
            input: { schema: true },
            output: { schema: true },
            steps: [],
          },
        };
      },
    };

    await compileWorkflow(workflowDef({
      id: "flexible-input",
      suggestedInputSchema: {
        type: "object",
        properties: { files: { type: "array" } },
      },
      outputSchema: true,
      planner: { model: { provider: "test", modelId: "planner" }, harness: plannerHarness },
      models: [model({ provider: "test", modelId: "worker" })],
    }), { input: { any: "shape" } });

    expect(tasks[0]).toMatchObject({
      kind: "plan",
      workflowSnapshot: {
        inputSchema: true,
        suggestedInputSchema: {
          type: "object",
          properties: { files: { type: "array" } },
        },
      },
    });
  });

  it("uses model-name slot ids", async () => {
    const objectSchema = z.object({});
    const slotIdWorkflow = workflowDef({
      id: "slot-id-test",
      inputSchema: objectSchema,
      outputSchema: objectSchema,
      models: [
        model(
          { provider: "openai", modelId: "gpt-4o-mini" },
          { description: "fast" },
        ),
      ],
    });
    const planner: PlannerAdapter = {
      draft: vi.fn(async () => ({
        apiVersion: "littleworkflow.dev/v0.1",
        kind: "Workflow",
        metadata: {
          name: "slot-id-test",
          version: "0.1.0-alpha",
        },
        input: { schema: { type: "object", properties: {}, additionalProperties: false } },
        output: { schema: { type: "object", properties: {}, additionalProperties: false } },
        permissions: {
          models: ["gpt-4o-mini"],
          tools: [],
          secrets: [],
          network: [],
        },
        steps: [],
      })),
    };

    const result = await compileWorkflow(slotIdWorkflow, {
      input: {},
      planner,
      requestId: "orq_slot_id_test",
    });

    expect(result.request.locks.capabilityManifest.modelSlots).toEqual(["gpt-4o-mini"]);
  });

  it("binds compiled workflow version identity to capability locks", async () => {
    const first = await compileWorkflow(workflow, {
      input: { ticketId: "TIN-1", body: "Export failed." },
      tools: workflowRegistry,
      planner: { draft: vi.fn(async () => validLwir()) },
      requestId: "orq_capability_hash",
    });
    const changedRegistry = createToolRegistry({
      lookupCustomer: {
        description: "Look up customer plan and entitlement metadata.",
        inputSchema: {
          type: "object",
          required: ["ticketId"],
          properties: { ticketId: { type: "string" } },
        },
        execute: async () => ({}),
      },
    });
    const changedToolMetadata = workflowDef({
      ...workflow,
      globalTools: ["lookupCustomer"],
    });
    const second = await compileWorkflow(changedToolMetadata, {
      input: { ticketId: "TIN-1", body: "Export failed." },
      tools: changedRegistry,
      planner: { draft: vi.fn(async () => validLwir()) },
      requestId: "orq_capability_hash",
    });

    expect(first.workflowVersion.lwirHash).toBe(second.workflowVersion.lwirHash);
    expect(first.workflowVersion.hash).not.toBe(second.workflowVersion.hash);
    expect(first.lock.workflowVersionHash).toBe(first.workflowVersion.hash);
    expect(second.lock.workflowVersionHash).toBe(second.workflowVersion.hash);
    expect(first.lock.capabilityManifestHash).not.toBe(second.lock.capabilityManifestHash);
  });

  it("binds compiled workflow version identity to bash capabilities", async () => {
    const first = await compileWorkflow(workflow, {
      input: { ticketId: "TIN-1", body: "Export failed." },
      tools: workflowRegistry,
      planner: { draft: vi.fn(async () => validLwir()) },
      requestId: "orq_bash_capability_hash",
      bash: { network: false },
    });
    const second = await compileWorkflow(workflow, {
      input: { ticketId: "TIN-1", body: "Export failed." },
      tools: workflowRegistry,
      planner: { draft: vi.fn(async () => validLwir()) },
      requestId: "orq_bash_capability_hash",
      bash: {
        network: {
          allow: ["https://api.example.test/"],
          methods: ["GET"],
        },
      },
    });

    expect(first.workflowVersion.lwirHash).toBe(second.workflowVersion.lwirHash);
    expect(first.workflowVersion.hash).not.toBe(second.workflowVersion.hash);
    expect(first.lock.capabilityManifestHash).not.toBe(second.lock.capabilityManifestHash);
  });

  it("snapshots Zod-backed AI SDK-style tool descriptors without executable fields", () => {
    const execute = vi.fn();
    const normalizedToolSchema = {
      type: "object",
      properties: {
        ticketId: { type: "string" },
      },
      required: ["ticketId"],
      additionalProperties: false,
    };
    const zodRegistry = createToolRegistry({
      lookupCustomer: {
        description: "Look up customer plan metadata.",
        inputSchema: z.object({
          ticketId: z.string(),
        }),
        execute,
      },
    });
    const zodToolWorkflow = workflowDef({
      id: "support.zod-tool",
      description: "Compile a Zod-backed tool descriptor.",
      inputSchema: ticketInputSchema,
      output: output.object({ schema: ticketOutputSchema }),
      globalTools: ["lookupCustomer"],
    });

    const request = toOrchestrationRequest(zodToolWorkflow, {
      input: { ticketId: "TIN-1", body: "Export failed." },
      tools: zodRegistry,
    });
    const tool = request.locks.tools.find((entry) => entry.name === "lookupCustomer");

    expect(tool).toEqual(
      expect.objectContaining({
        name: "lookupCustomer",
        scope: "global",
        description: "Look up customer plan metadata.",
        inputSchema: normalizedToolSchema,
        inputSchemaHash: sha256Digest(normalizedToolSchema),
      }),
    );
    expect(tool).not.toHaveProperty("execute");
    expect(execute).not.toHaveBeenCalled();
  });

  it("hashes tool outputSchema into the snapshot", () => {
    const echoDescriptor = {
      description: "echo",
      inputSchema: { type: "object", required: [], properties: {} },
      outputSchema: { type: "object", required: ["echoed"], properties: { echoed: { type: "string" } } },
    };
    const echoRegistry = createToolRegistry({
      echo: { ...echoDescriptor, execute: async () => ({}) },
    });
    const echoWorkflow = workflowDef({
      id: "support.echo",
      inputSchema: true,
      outputSchema: true,
      globalTools: ["echo"],
      toolSelection: "planner_selected",
    });
    const request = toOrchestrationRequest(echoWorkflow, { input: {}, tools: echoRegistry });
    const snapshot = request.capabilityManifest.tools.find((entry) => entry.name === "echo");
    expect(snapshot?.outputSchemaHash).toBe(sha256Digest(echoDescriptor.outputSchema));
  });

  it("treats missing outputSchema as undefined hash", () => {
    const echoNoOutputDescriptor = {
      description: "echo",
      inputSchema: { type: "object", required: [], properties: {} },
    };
    const echoNoOutputRegistry = createToolRegistry({
      echo: { ...echoNoOutputDescriptor, execute: async () => ({}) },
    });
    const echoNoOutputWorkflow = workflowDef({
      id: "support.echo-no-output",
      inputSchema: true,
      outputSchema: true,
      globalTools: ["echo"],
      toolSelection: "planner_selected",
    });
    const request = toOrchestrationRequest(echoNoOutputWorkflow, { input: {}, tools: echoNoOutputRegistry });
    const snapshot = request.capabilityManifest.tools.find((entry) => entry.name === "echo");
    expect(snapshot?.outputSchemaHash).toBeUndefined();
  });

  it("hashes Zod workflow input schemas as normalized descriptors", () => {
    const zodInputWorkflow = workflowDef({
      id: "support.zod-input",
      description: "Compile a Zod-backed workflow input schema.",
      inputSchema: z.object({
        ticketId: z.string(),
        body: z.string(),
      }),
      output: output.object({ schema: ticketOutputSchema }),
    });
    const normalizedInputSchema = {
      type: "object",
      properties: {
        ticketId: { type: "string" },
        body: { type: "string" },
      },
      required: ["ticketId", "body"],
      additionalProperties: false,
    };

    const request = toOrchestrationRequest(zodInputWorkflow, {
      input: { ticketId: "TIN-1", body: "Export failed." },
    });

    expect(request.inputSchema).toEqual(normalizedInputSchema);
    expect(request.locks.inputSchemaHash).toBe(sha256Digest(normalizedInputSchema));
    expect(request.locks.workflowDefinitionHash).toBe(
      getWorkflowDefinitionHash(zodInputWorkflow),
    );
  });

  it("binds validation hashes to the exact registered LWIR", async () => {
    const first = await compileWorkflow(workflow, {
      input: { ticketId: "TIN-1", body: "Export failed." },
      tools: workflowRegistry,
      planner: { draft: vi.fn(async () => validLwir()) },
      requestId: "orq_validation_hash",
    });
    const changedLwir = {
      ...validLwir(),
      steps: [
        validLwir().steps[0],
        {
          ...validLwir().steps[1],
          with: {
            model: "model.fast",
            prompt: "Summarize the ticket with a different prompt.",
          },
        },
      ],
    };
    const second = await compileWorkflow(workflow, {
      input: { ticketId: "TIN-1", body: "Export failed." },
      tools: workflowRegistry,
      planner: { draft: vi.fn(async () => changedLwir) },
      requestId: "orq_validation_hash",
    });

    expect(first.lock.workflowVersionHash).not.toBe(second.lock.workflowVersionHash);
    expect(first.lock.validationHash).not.toBe(second.lock.validationHash);

    const differentInput = await compileWorkflow(workflow, {
      input: { ticketId: "TIN-1", body: "Different input." },
      tools: workflowRegistry,
      planner: { draft: vi.fn(async () => validLwir()) },
      requestId: "orq_validation_hash",
    });

    expect(first.lock.inputHash).not.toBe(differentInput.lock.inputHash);
    expect(first.lock.validationHash).not.toBe(differentInput.lock.validationHash);
  });

  it("repairs valid LWIR that is not bound to the orchestration request", async () => {
    const unboundDraft = {
      ...validLwir(),
      metadata: { name: "support.other", version: "0.1.0-alpha" },
      output: { schema: { type: "string" } },
      permissions: {
        models: ["model.fast", "model.unapproved"],
        tools: ["lookupCustomer", "deleteEverything"],
        secrets: [],
        network: [],
      },
      steps: [
        {
          id: "delete-everything",
          uses: "tool.call",
          with: { tool: "deleteEverything", args: { ticketId: "{{ input.ticketId }}" } },
          output: { mode: "json", schema: true },
        },
        {
          id: "summarize",
          uses: "ai.generate",
          needs: ["delete-everything"],
          with: { model: "model.unapproved", prompt: "Summarize." },
          output: { mode: "object", schema: ticketOutputSchema },
        },
      ],
    };
    const planner: PlannerAdapter = {
      draft: vi.fn(async (_request, repair) => (repair === undefined ? unboundDraft : validLwir())),
    };

    const result = await compileWorkflow(workflow, {
      input: { ticketId: "TIN-1", body: "Export failed." },
      tools: workflowRegistry,
      planner,
      maxWorkflowRevisions: 2,
    });

    expect(result.revisions.map((revision) => revision.valid)).toEqual([false, true]);
    expect(planner.draft).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ kind: "OrchestrationRequest" }),
      expect.objectContaining({
        previousLwir: unboundDraft,
        findings: expect.arrayContaining([
          expect.objectContaining({ code: "binding.workflow_name_mismatch" }),
          expect.objectContaining({ code: "binding.output_schema_mismatch" }),
          expect.objectContaining({ code: "binding.model_disallowed" }),
          expect.objectContaining({ code: "binding.tool_disallowed" }),
        ]),
      }),
    );
  });

  it("uses an immutable request snapshot when validating planner output", async () => {
    let mutationError: unknown;
    const maliciousDraft = {
      ...validLwir(),
      permissions: {
        models: ["model.fast", "model.unapproved"],
        tools: ["lookupCustomer", "deleteEverything"],
        secrets: [],
        network: [],
      },
      steps: [
        {
          id: "delete-everything",
          uses: "tool.call",
          with: { tool: "deleteEverything", args: { ticketId: "{{ input.ticketId }}" } },
          output: { mode: "json", schema: true },
        },
        {
          id: "summarize",
          uses: "ai.generate",
          needs: ["delete-everything"],
          with: { model: "model.unapproved", prompt: "Summarize." },
          output: { mode: "object", schema: ticketOutputSchema },
        },
      ],
    };
    const planner: PlannerAdapter = {
      draft: vi.fn(async (request) => {
        try {
          (request.capabilityManifest.modelSlots as string[]).push("model.unapproved");
        } catch (error) {
          mutationError = error;
        }
        return maliciousDraft;
      }),
    };

    await expect(
      compileWorkflow(workflow, {
        input: { ticketId: "TIN-1", body: "Export failed." },
        tools: workflowRegistry,
        planner,
        maxWorkflowRevisions: 1,
      }),
    ).rejects.toMatchObject({
      name: "WorkflowCompileError",
      revisions: [
        expect.objectContaining({
          findings: expect.arrayContaining([
            expect.objectContaining({ code: "binding.model_disallowed" }),
            expect.objectContaining({ code: "binding.tool_disallowed" }),
          ]),
        }),
      ],
    });
    expect(mutationError).toBeInstanceOf(TypeError);
  });

  it("freezes canonical repair history before passing it back to the planner", async () => {
    const invalidDraft = {
      ...validLwir(),
      steps: [
        {
          id: "summarize",
          uses: "tool",
          with: { tool: "summarize" },
          output: { mode: "json" },
        },
      ],
    };
    let previousLwirMutation: unknown;
    let findingsMutation: unknown;
    const planner: PlannerAdapter = {
      draft: vi.fn(async (_request, repair) => {
        if (repair === undefined) {
          return invalidDraft;
        }
        try {
          ((repair.previousLwir as { metadata: { name: string } }).metadata.name) = "mutated";
        } catch (error) {
          previousLwirMutation = error;
        }
        try {
          (repair.findings as LwirValidationFinding[]).push({
            severity: "error",
            code: "mutated",
            path: "$",
            message: "mutated",
          });
        } catch (error) {
          findingsMutation = error;
        }
        return validLwir();
      }),
    };

    const result = await compileWorkflow(workflow, {
      input: { ticketId: "TIN-1", body: "Export failed." },
      tools: workflowRegistry,
      planner,
      maxWorkflowRevisions: 2,
    });

    expect(result.revisions[0]?.lwir).toEqual(invalidDraft);
    expect(result.revisions[0]?.lwir).not.toBe(invalidDraft);
    expect(Object.isFrozen(result.revisions)).toBe(true);
    expect(Object.isFrozen(result.revisions[0])).toBe(true);
    expect(Object.isFrozen(result.revisions[0]?.lwir)).toBe(true);
    expect(Object.isFrozen(result.revisions[0]?.findings)).toBe(true);
    expect(previousLwirMutation).toBeInstanceOf(TypeError);
    expect(findingsMutation).toBeInstanceOf(TypeError);
  });

  it("passes non-hashable planner LWIR through repair instead of throwing", async () => {
    let repairContext: PlannerRepairContext | undefined;
    const planner: PlannerAdapter = {
      draft: vi.fn(async (_request, repair) => {
        repairContext = repair;
        return repair === undefined ? new Map([["kind", "Workflow"]]) : validLwir();
      }),
    };

    const result = await compileWorkflow(workflow, {
      input: { ticketId: "TIN-1", body: "Export failed." },
      tools: workflowRegistry,
      planner,
      maxWorkflowRevisions: 2,
    });

    expect(result.revisions.map((revision) => revision.valid)).toEqual([false, true]);
    expect(result.revisions[0]?.findings).toEqual([
      expect.objectContaining({ code: "lwir.non_hashable" }),
    ]);
    expect(result.revisions[0]?.lwir).toEqual({
      kind: "NonHashablePlannerOutput",
      valueType: "object",
      constructorName: "Map",
      finding: expect.objectContaining({ code: "lwir.non_hashable" }),
    });
    expect(Object.isFrozen(result.revisions[0]?.lwir)).toBe(true);
    expect(repairContext).toEqual(
      expect.objectContaining({
        previousLwir: result.revisions[0]?.lwir,
        findings: result.revisions[0]?.findings,
      }),
    );
  });

  it("rejects model metadata tools in executable LWIR steps", async () => {
    const plannerToolWorkflow = workflowDef({
      ...workflow,
      models: [
        model(
          { provider: "test", modelId: "worker" },
          {
            id: "model.fast",
            description: "Summarizes tickets.",
            tools: {
              inspectRepo: {
                description: "Read repository metadata while planning.",
                inputSchema: {
                  type: "object",
                  properties: { path: { type: "string" } },
                },
              },
            },
          } as ModelSelectionMetadata & { tools: Record<string, unknown> },
        ),
      ],
    });
    const plannerOnlyDraft = {
      ...validLwir(),
      permissions: {
        models: ["model.fast"],
        tools: ["inspectRepo"],
        secrets: [],
        network: [],
      },
      steps: [
        {
          id: "inspect",
          uses: "tool.call",
          with: { tool: "inspectRepo", args: { path: "{{ input.ticketId }}" } },
          output: { mode: "json", schema: true },
        },
        {
          id: "summarize",
          uses: "ai.generate",
          needs: ["inspect"],
          with: { model: "model.fast", prompt: "Summarize." },
          output: { mode: "object", schema: ticketOutputSchema },
        },
      ],
    };
    const planner: PlannerAdapter = {
      draft: vi.fn(async () => plannerOnlyDraft),
    };

    await expect(
      compileWorkflow(plannerToolWorkflow, {
        input: { ticketId: "TIN-1", body: "Export failed." },
        tools: workflowRegistry,
        planner,
        maxWorkflowRevisions: 1,
      }),
    ).rejects.toMatchObject({
      name: "WorkflowCompileError",
      revisions: [
        expect.objectContaining({
          findings: expect.arrayContaining([
            expect.objectContaining({ code: "binding.tool_disallowed" }),
          ]),
        }),
      ],
    });
  });

  it("rejects unbound secrets and network permissions", async () => {
    const draft = {
      ...validLwir(),
      permissions: {
        ...validLwir().permissions,
        secrets: ["licenseApiKey"],
        network: ["internet"],
      },
    };
    const planner: PlannerAdapter = {
      draft: vi.fn(async () => draft),
    };

    await expect(
      compileWorkflow(workflow, {
        input: { ticketId: "TIN-1", body: "Export failed." },
        tools: workflowRegistry,
        planner,
        maxWorkflowRevisions: 1,
      }),
    ).rejects.toMatchObject({
      name: "WorkflowCompileError",
      revisions: [
        expect.objectContaining({
          findings: expect.arrayContaining([
            expect.objectContaining({ code: "binding.secret_disallowed" }),
            expect.objectContaining({ code: "binding.network_disallowed" }),
          ]),
        }),
      ],
    });
  });

  it("enforces explicit-only tool selection until steps are explicitly bound", async () => {
    const explicitWorkflow = workflowDef({
      ...workflow,
      toolSelection: "explicit_only",
    });
    const planner: PlannerAdapter = {
      draft: vi.fn(async () => validLwir()),
    };

    await expect(
      compileWorkflow(explicitWorkflow, {
        input: { ticketId: "TIN-1", body: "Export failed." },
        tools: workflowRegistry,
        planner,
        maxWorkflowRevisions: 1,
      }),
    ).rejects.toMatchObject({
      name: "WorkflowCompileError",
      revisions: [
        expect.objectContaining({
          findings: expect.arrayContaining([
            expect.objectContaining({ code: "binding.tool_disallowed" }),
          ]),
        }),
      ],
    });
  });

  it("repairs invalid planner LWIR using compact validation findings", async () => {
    const invalidDraft = {
      ...validLwir(),
      steps: [
        {
          id: "summarize",
          uses: "tool",
          with: { tool: "summarize" },
          output: { mode: "json" },
        },
      ],
    };
    const planner: PlannerAdapter = {
      draft: vi.fn(async (_request, repair) => (repair === undefined ? invalidDraft : validLwir())),
    };

    const result = await compileWorkflow(workflow, {
      input: { ticketId: "TIN-1", body: "Export failed." },
      tools: workflowRegistry,
      planner,
      maxWorkflowRevisions: 2,
    });

    expect(result.revisions.map((revision) => revision.valid)).toEqual([false, true]);
    expect(planner.draft).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ kind: "OrchestrationRequest" }),
      expect.objectContaining({
        previousLwir: invalidDraft,
        findings: expect.arrayContaining([
          expect.objectContaining({ code: "step.invalid_type" }),
        ]),
      }),
    );
  });

  it.each(["adapt", "draft_fresh"] as const)(
    "repairs invalid inner LWIR from %s planner decision envelopes",
    async (decisionKind) => {
      const invalidDraft = {
        ...validLwir(),
        steps: [
          {
            id: "summarize",
            uses: "tool",
            with: { tool: "summarize" },
            output: { mode: "json" },
          },
        ],
      };
      const planner: PlannerAdapter = {
        draft: vi.fn(async (_request, repair) => {
          if (repair !== undefined) {
            return validLwir();
          }
          return decisionKind === "adapt"
            ? {
                kind: "adapt",
                baseWorkflowVersionId: "wfver_prior",
                rationale: "Adapt the prior workflow after validation feedback.",
                lwir: invalidDraft,
              }
            : {
                kind: "draft_fresh",
                rationale: "Draft a fresh workflow after validation feedback.",
                lwir: invalidDraft,
              };
        }),
      };

      const result = await compileWorkflow(workflow, {
        input: { ticketId: "TIN-1", body: "Export failed." },
        tools: workflowRegistry,
        planner,
        maxWorkflowRevisions: 2,
      });

      expect(result.revisions.map((revision) => revision.valid)).toEqual([false, true]);
      expect(result.revisions[0]?.lwir).toEqual(invalidDraft);
      expect(planner.draft).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ kind: "OrchestrationRequest" }),
        expect.objectContaining({
          previousLwir: invalidDraft,
          findings: expect.arrayContaining([
            expect.objectContaining({ code: "step.invalid_type" }),
          ]),
        }),
      );
    },
  );

  it("fails when max workflow revisions are exhausted", async () => {
    const invalidDraft = {
      ...validLwir(),
      steps: [{ id: "bad", uses: "ai.generate", output: { mode: "text" } }],
    };
    const planner: PlannerAdapter = {
      draft: vi.fn(async () => invalidDraft),
    };

    await expect(
      compileWorkflow(workflow, {
        input: { ticketId: "TIN-1", body: "Export failed." },
        tools: workflowRegistry,
        planner,
        maxWorkflowRevisions: 2,
      }),
    ).rejects.toMatchObject({
      name: "WorkflowCompileError",
      revisions: [
        expect.objectContaining({ revision: 1, valid: false }),
        expect.objectContaining({ revision: 2, valid: false }),
      ],
    });
    expect(planner.draft).toHaveBeenCalledTimes(2);
  });
});

describe("OrchestrationRequest outerLoop context (Layer B §3.2)", () => {
  it("carries outerLoop context when provided in options", () => {
    const request = toOrchestrationRequest(workflow, {
      input: { ticketId: "TIN-1", body: "Export failed." },
      tools: workflowRegistry,
      outerLoop: {
        cycleNumber: 2,
        maxCycles: 5,
        isFinalCycle: false,
        priorCycles: [{ cycleNumber: 1, status: "completed", output: { score: 0.7 } }],
      },
    });
    expect(request.outerLoop?.cycleNumber).toBe(2);
    expect(request.outerLoop?.maxCycles).toBe(5);
    expect(request.outerLoop?.isFinalCycle).toBe(false);
    expect(request.outerLoop?.priorCycles).toHaveLength(1);
  });

  it("auto-computes isFinalCycle when missing", () => {
    const request = toOrchestrationRequest(workflow, {
      input: { ticketId: "TIN-1", body: "Export failed." },
      tools: workflowRegistry,
      outerLoop: { cycleNumber: 5, maxCycles: 5, priorCycles: [] },
    });
    expect(request.outerLoop?.isFinalCycle).toBe(true);
  });

  it("auto-computes isFinalCycle to false when not at the last cycle", () => {
    const request = toOrchestrationRequest(workflow, {
      input: { ticketId: "TIN-1", body: "Export failed." },
      tools: workflowRegistry,
      outerLoop: { cycleNumber: 3, maxCycles: 5, priorCycles: [] },
    });
    expect(request.outerLoop?.isFinalCycle).toBe(false);
  });

  it("omits outerLoop when not provided in options", () => {
    const request = toOrchestrationRequest(workflow, {
      input: { ticketId: "TIN-1", body: "Export failed." },
      tools: workflowRegistry,
    });
    expect(request.outerLoop).toBeUndefined();
  });
});

describe("CapabilityManifest.stepTypes includes decision", () => {
  it("capabilityManifest.stepTypes includes 'decision' so the planner can use decision steps", () => {
    const request = toOrchestrationRequest(workflow, {
      input: { ticketId: "TIN-1", body: "Export failed." },
      tools: workflowRegistry,
      requestId: "orq_decision_test",
    });
    expect(request.capabilityManifest.stepTypes).toContain("decision");
  });
});

describe("CapabilityManifest.workerHarness", () => {
  it("records workflowHarness as the default worker harness when worker config is omitted or empty", () => {
    const input = { ticketId: "TIN-1", body: "Export failed." };
    const omittedWorker = toOrchestrationRequest(workflow, {
      input,
      tools: workflowRegistry,
    });
    const emptyWorker = toOrchestrationRequest(
      createLittleWorkflow({
        ...workflow,
        worker: {},
      } as unknown as Parameters<typeof createLittleWorkflow>[0]),
      {
        input,
        tools: workflowRegistry,
      },
    );

    expect(omittedWorker.capabilityManifest.workerHarness).toEqual({
      harnessId: workflowHarness.harnessId,
    });
    expect(emptyWorker.capabilityManifest.workerHarness).toEqual({
      harnessId: workflowHarness.harnessId,
    });
  });
});

describe("PlannerAdapter.supervise type", () => {
  it("accepts a PlannerAdapter with optional supervise method", () => {
    const adapter: PlannerAdapter = {
      draft: async () => ({}),
      supervise: async (state: SuperviseOuterLoopState): Promise<SuperviseDecision> => {
        return { kind: "done", finalOutput: state.cycles.at(-1)?.output };
      },
    };
    expect(typeof adapter.supervise).toBe("function");
  });

  it("PlannerAdapter without supervise is still valid", () => {
    const adapter: PlannerAdapter = { draft: async () => ({}) };
    expect(adapter.supervise).toBeUndefined();
  });
});
