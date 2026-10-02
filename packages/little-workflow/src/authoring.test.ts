import { describe, expect, expectTypeOf, it } from "vitest";
import {
  createLittleWorkflow,
  createRuntime,
  localWorld,
  model,
  runWorkflow,
  skill,
} from "./authoring.js";
import * as publicApi from "./index.js";
import type {
  BashCapabilities,
  ExecuteWorkflowVersionOptions,
  Harness,
  InferWorkflowInput,
  InferWorkflowOutput,
  MemoryConfig,
  ModelSlot,
  OrchestratorConfig,
  OutputMode,
  ParserSchemaLike,
  PlannerConfig,
  RunResult,
  RunWorkflowOptions,
  Schema,
  Skill,
  SkillOidcToken,
  SuperviseDecision,
  SuperviseOuterLoopState,
  WorkerConfig,
  WorkflowDefinition,
} from "./index.js";
import type { CompilableWorkflowDefinition } from "./compiler.js";
import {
  DEFAULT_WORKFLOW_VERSION_REUSE_STRATEGY,
  resolveWorkflowVersionReuseStrategy,
} from "./workflow-version-reuse.js";

{
  const plannerTypeHarness: Harness = {
    async run(task) {
      switch (task.kind) {
        case "plan":
          return { kind: "plan", lwir: { apiVersion: "littleworkflow.dev/v0.1" } };
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
  };
  const typePlannerModel = { provider: "test", modelId: "planner" } as const;
  const typeWorkerModel = model({ provider: "test", modelId: "worker" });
  const typeCheckWorkflow = createLittleWorkflow({
    id: "types.legacy-options",
    inputSchema: { type: "object", additionalProperties: true },
    outputSchema: { type: "object", additionalProperties: true },
    models: [typeWorkerModel],
    planner: {
      model: typePlannerModel,
      harness: plannerTypeHarness,
    },
  });

  const _legacyPlannerOption: RunWorkflowOptions<typeof typeCheckWorkflow> = {
    world: localWorld(),
    workflows: typeCheckWorkflow,
    input: { ticketId: "TIN-types", body: "legacy planner option" },
    // @ts-expect-error legacy planner option should not be accepted in runWorkflow
    planner: { draft: async () => ({ apiVersion: "littleworkflow.dev/v0.1" }) },
  };
  void _legacyPlannerOption;

  const _legacyModelsOption: RunWorkflowOptions<typeof typeCheckWorkflow> = {
    world: localWorld(),
    workflows: typeCheckWorkflow,
    input: { ticketId: "TIN-types", body: "legacy models option" },
    // @ts-expect-error legacy models option should not be accepted in runWorkflow
    models: { "model.fast": { provider: "test", modelId: "fast" } },
  };
  void _legacyModelsOption;

  const _legacyAiOption: RunWorkflowOptions<typeof typeCheckWorkflow> = {
    world: localWorld(),
    workflows: typeCheckWorkflow,
    input: { ticketId: "TIN-types", body: "legacy ai option" },
    // @ts-expect-error legacy ai option should not be accepted in runWorkflow
    ai: { generate: async () => ({ output: {} }) },
  };
  void _legacyAiOption;

  const _legacyCodeRunnerOption: RunWorkflowOptions<typeof typeCheckWorkflow> = {
    world: localWorld(),
    workflows: typeCheckWorkflow,
    input: { ticketId: "TIN-types", body: "legacy code option" },
    // @ts-expect-error legacy codeRunner option should not be accepted in runWorkflow
    codeRunner: { run: async () => ({ output: {} }) },
  };
  void _legacyCodeRunnerOption;

  const _legacyExecuteWorkflowVersionOption: ExecuteWorkflowVersionOptions = {
    world: localWorld(),
    workflowVersion: {
      id: "wfver_types",
      lwir: { apiVersion: "littleworkflow.dev/v0.1" } as ExecuteWorkflowVersionOptions["workflowVersion"] extends { readonly lwir: infer TLwir }
        ? TLwir
        : never,
    },
    input: {},
    // @ts-expect-error old deterministic policy is no longer public ExecuteWorkflowVersionOptions API
    workflowVersionReuse: "structure",
  };
  void _legacyExecuteWorkflowVersionOption;

  const _legacyCompilableWorkflowDefinition: CompilableWorkflowDefinition = {
    id: "types.old-compile-reuse-policy",
    // @ts-expect-error old deterministic policy is no longer public compile/orchestrator API
    workflowVersionReuse: "structure",
  };
  void _legacyCompilableWorkflowDefinition;

  const plannerConfiguredWorkflow = createLittleWorkflow({
    id: "types.planner-configured",
    inputSchema: { type: "object", additionalProperties: true },
    outputSchema: { type: "object", additionalProperties: true },
    models: [typeWorkerModel],
    planner: {
      model: typePlannerModel,
      harness: plannerTypeHarness,
    },
  });
  const _plannerConfiguredRunOptions: RunWorkflowOptions<typeof plannerConfiguredWorkflow> = {
    world: localWorld(),
    workflows: plannerConfiguredWorkflow,
    input: { ticketId: "TIN-types", body: "planner configured" },
  };
  void _plannerConfiguredRunOptions;

  // @ts-expect-error createLittleWorkflow should require planner in alpha harness API.
  createLittleWorkflow({
    id: "types.missing-planner",
    inputSchema: { type: "object", additionalProperties: true },
    outputSchema: { type: "object", additionalProperties: true },
    models: [model({ provider: "test", modelId: "worker" })],
  });

  // @ts-expect-error createLittleWorkflow should require at least one model slot in alpha harness API.
  createLittleWorkflow({
    id: "types.missing-models",
    inputSchema: { type: "object", additionalProperties: true },
    outputSchema: { type: "object", additionalProperties: true },
    planner: {
      model: { provider: "test", modelId: "planner" },
      harness: plannerTypeHarness,
    },
  });
}

type TicketInput = {
  ticketId: string;
  body: string;
};

type TicketOutput = {
  summary: string;
  priority: "low" | "high";
};

type RankingOutput = {
  topTicketId: string;
};

type ScoreOutput = {
  score: number;
};

type TypedSchema<TValue, TKind extends string> = Schema<TValue> & {
  readonly kind: TKind;
};

const ticketInputSchema = { kind: "ticket-input" } as TypedSchema<
  TicketInput,
  "ticket-input"
>;
const ticketOutputSchema = { kind: "ticket-output" } as TypedSchema<
  TicketOutput,
  "ticket-output"
>;
const rankingOutputSchema = { kind: "ranking-output" } as TypedSchema<
  RankingOutput,
  "ranking-output"
>;
const scoreOutputSchema = { kind: "score-output" } as TypedSchema<
  ScoreOutput,
  "score-output"
>;
const typedTicketOutputMode: OutputMode<TicketOutput> = {
  kind: "object",
  schema: ticketOutputSchema,
};
const typedChoiceOutputMode: OutputMode<TicketOutput["priority"]> = {
  kind: "choice",
  values: ["low", "high"],
};
const typedArrayOutputMode: OutputMode<ScoreOutput[]> = {
  kind: "array",
  element: scoreOutputSchema,
};
const standardTicketSchema = { kind: "standard-ticket" } as {
  readonly kind: "standard-ticket";
  readonly "~standard": {
    readonly types?: {
      readonly input: TicketInput;
      readonly output: TicketOutput;
    };
  };
};
const standardTicketOutputMode: OutputMode<TicketOutput> = {
  kind: "object",
  schema: standardTicketSchema,
};

const reasoningModel = model(
  { provider: "test", modelId: "reasoning" },
  { id: "reasoning", description: "JSON reasoning model." },
);
const testHarness: Harness = {
  async run(task) {
    switch (task.kind) {
      case "plan":
        return { kind: "plan", lwir: { apiVersion: "littleworkflow.dev/v0.1" } };
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
};
const plannerModel = { provider: "test", modelId: "planner" } as const;
const defaultPlanner: PlannerConfig = {
  model: plannerModel,
  harness: testHarness,
};

const ticketWorkflow = createLittleWorkflow({
  id: "support.summarize",
  description: "Summarize a support ticket.",
  inputSchema: ticketInputSchema,
  output: { kind: "object", schema: ticketOutputSchema },
  models: [reasoningModel],
  planner: defaultPlanner,
  globalTools: ["lookupCustomer"],
  toolSelection: "planner_selected",
});

const inferredTicketWorkflow = createLittleWorkflow({
  id: "support.inferred-summarize",
  description: "Summarize a support ticket with schema-derived types.",
  inputSchema: ticketInputSchema,
  output: { kind: "object", schema: ticketOutputSchema },
  models: [reasoningModel],
  planner: defaultPlanner,
});

const typedOutputWorkflow = createLittleWorkflow({
  id: "support.typed-output",
  description: "Summarize a support ticket with a typed output mode.",
  inputSchema: ticketInputSchema,
  output: typedTicketOutputMode,
  models: [reasoningModel],
  planner: defaultPlanner,
});

const choiceWorkflow = createLittleWorkflow({
  id: "support.priority",
  description: "Classify support priority.",
  inputSchema: ticketInputSchema,
  output: typedChoiceOutputMode,
  models: [reasoningModel],
  planner: defaultPlanner,
});

const arrayWorkflow = createLittleWorkflow({
  id: "support.scores",
  description: "Produce support scores.",
  inputSchema: ticketInputSchema,
  output: typedArrayOutputMode,
  models: [reasoningModel],
  planner: defaultPlanner,
});

const standardSchemaWorkflow = createLittleWorkflow({
  id: "support.standard-schema",
  description: "Summarize a support ticket with Standard Schema metadata.",
  inputSchema: standardTicketSchema,
  output: standardTicketOutputMode,
  models: [reasoningModel],
  planner: defaultPlanner,
});

const rankingWorkflow = createLittleWorkflow({
  id: "support.rank",
  description: "Pick the top ticket.",
  inputSchema: ticketOutputSchema,
  output: { kind: "object", schema: rankingOutputSchema },
  models: [reasoningModel],
  planner: defaultPlanner,
});

describe("authoring helpers", () => {
  describe("planner-reviewed workflow reuse authoring API", () => {
    const planner = {
      model: { provider: "test", modelId: "planner" },
      harness: {
        async run() {
          return { kind: "delegate_to_default" as const };
        },
      },
    };

    it("accepts suggestedInputSchema and workflowVersionReuseStrategy", () => {
      const workflow = createLittleWorkflow({
        id: "company-review",
        suggestedInputSchema: {
          type: "object",
          properties: { files: { type: "array" }, prompt: { type: "string" } },
        },
        output: { kind: "object", schema: true },
        models: [model({ provider: "test", modelId: "worker" })],
        planner,
        workflowVersionReuseStrategy: "planner_reviewed",
      });

      expect(workflow.workflowVersionReuseStrategy).toBe("planner_reviewed");
    });

    it("keeps old workflowVersionReuse out of the public authoring API", () => {
      createLittleWorkflow({
        id: "old-reuse-policy",
        output: { kind: "object", schema: true },
        models: [model({ provider: "test", modelId: "worker" })],
        planner,
        // @ts-expect-error old deterministic policy is no longer public WorkflowDefinition API
        workflowVersionReuse: "structure",
      } satisfies Parameters<typeof createLittleWorkflow>[0]);

      createLittleWorkflow({
        id: "old-reuse-policy-direct",
        output: { kind: "object", schema: true },
        models: [model({ provider: "test", modelId: "worker" })],
        planner,
        // @ts-expect-error direct createLittleWorkflow calls must reject the old deterministic policy
        workflowVersionReuse: "structure",
      });
    });

    it("accepts call-level workflowVersionReuseStrategy", () => {
      const workflow = createLittleWorkflow({
        id: "call-level-strategy",
        output: { kind: "object", schema: true },
        models: [model({ provider: "test", modelId: "worker" })],
        planner,
      });

      const options: RunWorkflowOptions<typeof workflow> = {
        world: localWorld({ dataDir: "/tmp/lwf-types" }),
        workflows: workflow,
        input: {},
        workflowVersionReuseStrategy: "always_fresh",
      };

      expect(options.workflowVersionReuseStrategy).toBe("always_fresh");
    });

    it("resolves workflow version reuse strategy defaults and overrides", () => {
      expect(DEFAULT_WORKFLOW_VERSION_REUSE_STRATEGY).toBe("planner_reviewed");
      expect(resolveWorkflowVersionReuseStrategy()).toBe("planner_reviewed");
      expect(resolveWorkflowVersionReuseStrategy({ workflow: "always_fresh" }))
        .toBe("always_fresh");
      expect(resolveWorkflowVersionReuseStrategy({
        workflow: "always_fresh",
        call: "planner_reviewed",
      })).toBe("planner_reviewed");
    });
  });

  it("returns declarative authoring values without runtime normalization", () => {
    expect(reasoningModel).toEqual({
      aiSdkModel: { provider: "test", modelId: "reasoning" },
      metadata: { id: "reasoning", description: "JSON reasoning model." },
    });

    expect(ticketWorkflow.id).toBe("support.summarize");
    expect(ticketWorkflow.models).toEqual([reasoningModel]);
    expect(ticketWorkflow.toolSelection).toBe("planner_selected");

    expect(localWorld().kind).toBe("local-world");
    expect(localWorld().dataDir).toBe(".little-workflow");
    expect(localWorld({ dataDir: "tmp/workflows" }).kind).toBe("local-world");
    expect(localWorld({ dataDir: "tmp/workflows" }).dataDir).toBe("tmp/workflows");
    expect(skill("./skills/ticket-triage")).toEqual({
      kind: "skill",
      source: "./skills/ticket-triage",
    });
  });

  it("preserves planner, worker, and memory config values", () => {
    const ai = { provider: "openai", modelId: "gpt-5" };
    const planner = {
      model: ai,
      harness: testHarness,
      system: "Plan carefully.",
    };
    const worker = { harness: testHarness, skills: [] };
    const memory = { workflow: "rw", org: "ro" } as const;

    const workflow = createLittleWorkflow({
      id: "planner-worker-memory",
      inputSchema: ticketInputSchema,
      outputSchema: ticketOutputSchema,
      models: [model(ai)],
      planner,
      worker,
      memory,
    });

    expect(workflow.planner).toBe(planner);
    expect(workflow.worker).toBe(worker);
    expect(workflow.memory).toBe(memory);
    expect(workflow.memory).toEqual({ workflow: "rw", org: "ro" });
  });

  it("preserves structured bash capability config values", () => {
    const ai = { provider: "openai", modelId: "gpt-5" };
    const workflowBash = {
      network: {
        allow: ["https://api.example.com/*"],
        methods: ["GET", "POST"],
      },
    } as const satisfies BashCapabilities;
    const orchestratorBash = {
      network: {
        allow: ["https://orchestrator.example.com/*"],
      },
    } as const satisfies BashCapabilities;

    const workflow = createLittleWorkflow({
      id: "bash-capability-config",
      inputSchema: ticketInputSchema,
      outputSchema: ticketOutputSchema,
      models: [model(ai)],
      planner: { model: ai, harness: testHarness },
      bash: workflowBash,
    });

    expect(workflow.bash).toBe(workflowBash);

    const runOptions: RunWorkflowOptions<readonly [typeof workflow]> = {
      world: localWorld(),
      workflows: [workflow],
      input: { batch: "networked" },
      bash: { network: false },
      orchestrator: {
        model: ai,
        harness: testHarness,
        bash: orchestratorBash,
      },
    };

    expect(runOptions.bash).toEqual({ network: false });
    expect(runOptions.orchestrator.bash).toBe(orchestratorBash);
  });

  it("re-exports the authoring surface from the public package entrypoint", () => {
    expect(publicApi.createLittleWorkflow).toBe(createLittleWorkflow);
    expect(publicApi.model).toBe(model);
    expect(publicApi.localWorld).toBe(localWorld);
    expect(publicApi).not.toHaveProperty("createRuntime");
    expect(publicApi.skill).toBe(skill);
    expect(publicApi.runWorkflow).toBe(runWorkflow);
    expect(publicApi.DEFAULT_WORKFLOW_VERSION_REUSE_STRATEGY).toBe("planner_reviewed");
    expect(publicApi.resolveWorkflowVersionReuseStrategy()).toBe("planner_reviewed");
    expect(publicApi).not.toHaveProperty("DEFAULT_WORKFLOW_VERSION_REUSE_POLICY");
    expect(publicApi).not.toHaveProperty("resolveWorkflowVersionReusePolicy");
    expect(publicApi).not.toHaveProperty("concreteInputStructure");
    expect(publicApi).not.toHaveProperty("concreteInputStructureHash");
    expect(publicApi).not.toHaveProperty("chainWorkflows");
  });

  it("keeps createRuntime as a beta stub while preserving the runWorkflow typed boundary", async () => {
    expect(() => createRuntime({ world: localWorld() })).toThrow(
      "createRuntime arrives after alpha; use runWorkflow() for v0.1.0-alpha.",
    );
    const workflowWithoutPlanner = createLittleWorkflow({
      id: "support.summarize.missing-planner-runtime",
      description: "Missing planner runtime validation fixture.",
      inputSchema: ticketInputSchema,
      output: { kind: "object", schema: ticketOutputSchema },
      models: [reasoningModel],
      globalTools: ["lookupCustomer"],
    } as unknown as Parameters<typeof createLittleWorkflow>[0]);

    await expect(
      runWorkflow({
        world: localWorld(),
        workflows: workflowWithoutPlanner,
        input: { ticketId: "TIN-1", body: "Cannot sign in." },
      }),
    ).rejects.toThrow("runWorkflow requires workflow.planner harness config in alpha.");
  });

  it("infers workflow input, output, and run result types", () => {
    expectTypeOf(ticketWorkflow).toMatchTypeOf<
      WorkflowDefinition<TicketInput, TicketOutput>
    >();
    expectTypeOf(reasoningModel).toMatchTypeOf<
      ModelSlot<{ provider: string; modelId: string }>
    >();
    expectTypeOf(reasoningModel.aiSdkModel.modelId).toEqualTypeOf<"reasoning">();
    expectTypeOf(ticketWorkflow.output.schema).toEqualTypeOf<typeof ticketOutputSchema>();
    expectTypeOf(inferredTicketWorkflow.output.schema).toEqualTypeOf<
      typeof ticketOutputSchema
    >();
    expectTypeOf<InferWorkflowInput<typeof ticketWorkflow>>().toEqualTypeOf<TicketInput>();
    expectTypeOf<InferWorkflowOutput<typeof ticketWorkflow>>().toEqualTypeOf<TicketOutput>();
    expectTypeOf<InferWorkflowInput<typeof inferredTicketWorkflow>>().toEqualTypeOf<
      TicketInput
    >();
    expectTypeOf<InferWorkflowOutput<typeof inferredTicketWorkflow>>().toEqualTypeOf<
      TicketOutput
    >();
    expectTypeOf<InferWorkflowOutput<typeof typedOutputWorkflow>>().toEqualTypeOf<
      TicketOutput
    >();
    expectTypeOf<InferWorkflowOutput<typeof choiceWorkflow>>().toEqualTypeOf<
      TicketOutput["priority"]
    >();
    expectTypeOf<InferWorkflowOutput<typeof arrayWorkflow>>().toEqualTypeOf<
      ScoreOutput[]
    >();
    expectTypeOf<InferWorkflowInput<typeof standardSchemaWorkflow>>().toEqualTypeOf<
      TicketInput
    >();
    expectTypeOf<InferWorkflowOutput<typeof standardSchemaWorkflow>>().toEqualTypeOf<
      TicketOutput
    >();
    expectTypeOf(standardSchemaWorkflow).toMatchTypeOf<
      WorkflowDefinition<TicketInput, TicketOutput>
    >();
    expectTypeOf<RunWorkflowOptions<typeof ticketWorkflow>["input"]>().toEqualTypeOf<
      TicketInput
    >();
    expectTypeOf<RunResult<TicketOutput>["output"]>().toEqualTypeOf<TicketOutput>();
    expectTypeOf<Skill>().toEqualTypeOf<ReturnType<typeof skill>>();
    expectTypeOf<WorkflowDefinition["planner"]>().toEqualTypeOf<
      PlannerConfig
    >();
    expectTypeOf<PlannerConfig["supervise"]>().toEqualTypeOf<
      | ((
          state: SuperviseOuterLoopState,
        ) => Promise<SuperviseDecision>)
      | undefined
    >();
    expectTypeOf<WorkflowDefinition["worker"]>().toEqualTypeOf<WorkerConfig | undefined>();
    expectTypeOf<WorkflowDefinition["memory"]>().toEqualTypeOf<MemoryConfig | undefined>();
    expectTypeOf<WorkflowDefinition["bash"]>().toEqualTypeOf<BashCapabilities | undefined>();
    expectTypeOf<PlannerConfig["model"]>().toEqualTypeOf<unknown | ModelSlot>();
    expectTypeOf<WorkerConfig>().toMatchTypeOf<{ readonly harness?: Harness }>();
    expectTypeOf<MemoryConfig["attach"]>().toEqualTypeOf<
      readonly { readonly id: string; readonly mode: "ro" }[] | undefined
    >();
    // runWorkflow accepts the power-user options object and returns the typed result
    // (it is now overloaded to also accept the ergonomic `runWorkflow(def, input)` form).
    expectTypeOf(
      runWorkflow({
        world: localWorld(),
        workflows: ticketWorkflow,
        input: { ticketId: "TIN-1", body: "Billing question." },
      }),
    ).toEqualTypeOf<Promise<RunResult<TicketOutput>>>();

    const validOptions: RunWorkflowOptions<typeof ticketWorkflow> = {
      world: localWorld(),
      workflows: ticketWorkflow,
      input: { ticketId: "TIN-2", body: "Billing question." },
    };
    expect(validOptions.input.ticketId).toBe("TIN-2");

    const rawModelPlanner: PlannerConfig = {
      model: { provider: "openai", modelId: "gpt-5" },
      harness: testHarness,
    };
    const slotModelPlanner: PlannerConfig = {
      model: reasoningModel,
      harness: testHarness,
    };
    const oidcToken: SkillOidcToken = () => "oidc-token";
    const remoteSkill = skill("https://github.com/org/repo", {
      skills: ["foo"],
      skillMaxRisk: "LOW",
      skillRisk: { foo: "MEDIUM" },
      auth: { type: "bearer", token: process.env.GIT_TOKEN },
    });
    const plannerWithSkillDefaults: PlannerConfig = {
      model: reasoningModel,
      harness: testHarness,
      skillMaxRisk: "LOW",
      skillOidcToken: oidcToken,
      skills: [remoteSkill],
    };
    const workerWithSkillDefaults: WorkerConfig = {
      harness: testHarness,
      skillMaxRisk: "MEDIUM",
      skillOidcToken: oidcToken,
      skills: [remoteSkill],
    };
    const orchestratorWithSkillDefaults: OrchestratorConfig = {
      model: reasoningModel,
      harness: testHarness,
      skillMaxRisk: "HIGH",
      skillOidcToken: oidcToken,
      skills: [remoteSkill],
    };
    expect(rawModelPlanner.harness).toBe(testHarness);
    expect(slotModelPlanner.harness).toBe(testHarness);
    expect(plannerWithSkillDefaults.skillMaxRisk).toBe("LOW");
    expect(workerWithSkillDefaults.skillMaxRisk).toBe("MEDIUM");
    expect(orchestratorWithSkillDefaults.skillMaxRisk).toBe("HIGH");

    const invalidOptions: RunWorkflowOptions<typeof ticketWorkflow> = {
      world: localWorld(),
      workflows: ticketWorkflow,
      // @ts-expect-error input must match the workflow definition input type.
      input: { ticketId: "TIN-3" },
    };
    void invalidOptions;

    if (false) {
      void runWorkflow({
        world: localWorld(),
        workflows: inferredTicketWorkflow,
        // @ts-expect-error direct runWorkflow input must match the workflow input type.
        input: { ticketId: "TIN-4" },
      });

      const orchestrator = {
        model: { provider: "openai", modelId: "gpt-5" },
        harness: testHarness,
      };

      // @ts-expect-error workflow arrays require orchestrator config.
      void runWorkflow({
        world: localWorld(),
        workflows: [ticketWorkflow, arrayWorkflow] as const,
        input: {},
      });

      void runWorkflow({
        world: localWorld(),
        workflows: ticketWorkflow,
        input: { ticketId: "TIN-4", body: "Single workflow forbids orchestrator." },
        // @ts-expect-error single-workflow runs must not accept orchestrator config.
        orchestrator,
      });

      void runWorkflow({
        world: localWorld(),
        workflows: [ticketWorkflow, arrayWorkflow] as const,
        input: {},
        orchestrator,
      });

      void runWorkflow({
        world: localWorld(),
        workflows: ticketWorkflow,
        input: { ticketId: "TIN-4", body: "Models in runWorkflow should be removed." },
        // @ts-expect-error runWorkflow must not accept direct models overrides.
        models: { "model.fast": reasoningModel },
      });

      void runWorkflow({
        world: localWorld(),
        workflows: ticketWorkflow,
        input: { ticketId: "TIN-4", body: "ai adapter in runWorkflow should be removed." },
        // @ts-expect-error runWorkflow must not accept direct ai adapter overrides.
        ai: {
          async generate() {
            return { output: {} };
          },
        },
      });

      void runWorkflow({
        world: localWorld(),
        workflows: ticketWorkflow,
        input: { ticketId: "TIN-4", body: "codeRunner in runWorkflow should be removed." },
        // @ts-expect-error runWorkflow must not accept direct codeRunner overrides.
        codeRunner: {
          async run() {
            return {};
          },
        },
      });

      // @ts-expect-error use typed schemas/output modes so the authoring object shape is preserved.
      createLittleWorkflow<TicketInput, TicketOutput>({
        id: "support.explicit-generic",
        inputSchema: ticketInputSchema,
        output: { kind: "object", schema: ticketOutputSchema },
        models: [reasoningModel],
        planner: defaultPlanner,
      });

      createLittleWorkflow({
        id: "support.invalid-kind",
        inputSchema: ticketInputSchema,
        models: [reasoningModel],
        planner: defaultPlanner,
        // @ts-expect-error output kind must be one of the alpha output modes.
        output: { kind: "invalid", schema: ticketOutputSchema },
      });

      createLittleWorkflow({
        id: "support.invalid-choice-values",
        inputSchema: ticketInputSchema,
        models: [reasoningModel],
        planner: defaultPlanner,
        // @ts-expect-error choice values must be strings.
        output: { kind: "choice", values: [1, 2] },
      });

      createLittleWorkflow({
        id: "support.missing-object-schema",
        inputSchema: ticketInputSchema,
        models: [reasoningModel],
        planner: defaultPlanner,
        // @ts-expect-error object output modes require schema evidence.
        output: { kind: "object" },
      });

      createLittleWorkflow({
        id: "support.missing-array-element",
        inputSchema: ticketInputSchema,
        models: [reasoningModel],
        planner: defaultPlanner,
        // @ts-expect-error array output modes require element schema evidence.
        output: { kind: "array" },
      });

      const invalidChoiceOutputMode: OutputMode<TicketOutput["priority"]> = {
        kind: "choice",
        // @ts-expect-error typed choices must match the output union.
        values: ["low", "medium"],
      };
      void invalidChoiceOutputMode;

      const invalidArrayOutputMode: OutputMode<ScoreOutput[]> = {
        kind: "array",
        // @ts-expect-error typed array elements must match the array element output type.
        element: ticketOutputSchema,
      };
      void invalidArrayOutputMode;

      // @ts-expect-error typed json outputs must include schema evidence.
      const invalidJsonOutputMode: OutputMode<TicketOutput> = { kind: "json" };
      void invalidJsonOutputMode;

      // @ts-expect-error workflow input types must not widen to unknown at the run boundary.
      const widenedWorkflow: WorkflowDefinition<unknown, TicketOutput> = ticketWorkflow;
      void widenedWorkflow;

      // @ts-expect-error qualityTier metadata was removed.
      model({ provider: "test", modelId: "x" }, { qualityTier: "fast" });

      // @ts-expect-error capabilities metadata was removed.
      model({ provider: "test", modelId: "x" }, { capabilities: ["tools"] });

      const narrowParserSchema: ParserSchemaLike<TicketOutput> = {
        // @ts-expect-error parser schemas must accept unknown runtime values.
        parse: (input: string) => ({
          summary: input,
          priority: "low",
        }),
      };
      void narrowParserSchema;

      const narrowInputParserWorkflow = createLittleWorkflow({
        id: "support.narrow-input-parser",
        inputSchema: {
          parse: (input: string): TicketInput => ({ ticketId: input, body: input }),
        },
        output: typedTicketOutputMode,
        models: [reasoningModel],
        planner: defaultPlanner,
      });
      expectTypeOf<InferWorkflowInput<typeof narrowInputParserWorkflow>>().toEqualTypeOf<
        unknown
      >();

      const narrowOutputParserWorkflow = createLittleWorkflow({
        id: "support.narrow-output-parser",
        inputSchema: ticketInputSchema,
        output: {
          kind: "object",
          schema: {
            parse: (input: string): TicketOutput => ({ summary: input, priority: "low" }),
          },
        },
        models: [reasoningModel],
        planner: defaultPlanner,
      });
      expectTypeOf<InferWorkflowOutput<typeof narrowOutputParserWorkflow>>().toEqualTypeOf<
        unknown
      >();

      const narrowOutputSchemaWorkflow = createLittleWorkflow({
        id: "support.narrow-output-schema",
        inputSchema: ticketInputSchema,
        outputSchema: {
          parse: (input: string): TicketOutput => ({ summary: input, priority: "low" }),
        },
        models: [reasoningModel],
        planner: defaultPlanner,
      });
      expectTypeOf<InferWorkflowOutput<typeof narrowOutputSchemaWorkflow>>().toEqualTypeOf<
        unknown
      >();
    }
  });

  it("keeps run result typing for direct workflow runs", () => {
    expectTypeOf<RunResult<RankingOutput>["output"]>().toEqualTypeOf<RankingOutput>();
  });
});
