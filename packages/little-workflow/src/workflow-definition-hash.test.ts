import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createLittleWorkflow,
  createToolRegistry,
  model,
  skill,
  type Harness,
  type HarnessResult,
  type HarnessTask,
  type WorkflowDefinition,
} from "./index.js";
import {
  getWorkflowDefinitionHash,
  getWorkflowDefinitionSnapshot,
  getPlanningDefinitionHash,
  getPlanningDefinitionSnapshot,
} from "./workflow-definition-hash.js";

function ai(provider: string, modelId: string) {
  return { provider, modelId };
}

function skillIdentity(source: string, name: string, frontmatterHash: string) {
  return Object.assign(skill(source), { name, frontmatterHash });
}

function harness(harnessId = "testHarness@1.0.0"): Harness & { readonly harnessId: string } {
  return Object.assign(
    {
      async run(task: HarnessTask): Promise<HarnessResult> {
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
    } satisfies Harness,
    { harnessId },
  );
}

function workflow(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return createLittleWorkflow({
    id: "support.summarize",
    description: "Summarize support tickets.",
    inputSchema: {
      type: "object",
      properties: { body: { type: "string" } },
      required: ["body"],
    },
    output: {
      kind: "object",
      schema: {
        type: "object",
        properties: { summary: { type: "string" } },
        required: ["summary"],
      },
    },
    models: [
      model(ai("test", "worker"), {
        id: "worker",
        description: "Worker model.",
      }),
    ],
    planner: {
      model: ai("test", "planner"),
      harness: harness(),
      system: "Plan carefully.",
      skills: [skillIdentity("skills/planner.md", "planner", "sha256:planner")],
    },
    worker: {
      harness: harness(),
      skills: [skillIdentity("skills/worker.md", "worker", "sha256:worker")],
    },
    globalTools: ["lookupCustomer"],
    memory: {
      workflow: "rw",
      org: "ro",
      attach: [{ id: "kb", mode: "ro" }],
    },
    ...overrides,
  }) as unknown as WorkflowDefinition;
}

function registryWithLookupCustomer(
  overrides: Partial<{
    readonly description: string;
    readonly inputSchema: unknown;
    readonly outputSchema: unknown;
    readonly needsApproval: boolean | ((args: unknown) => boolean);
  }> = {},
) {
  const registry = createToolRegistry();
  registry.register("lookupCustomer", {
    description: overrides.description ?? "Look up customer metadata.",
    inputSchema: overrides.inputSchema ?? {
      type: "object",
      properties: { customerId: { type: "string" } },
      required: ["customerId"],
    },
    outputSchema: overrides.outputSchema ?? {
      type: "object",
      properties: { plan: { type: "string" } },
      required: ["plan"],
    },
    ...(overrides.needsApproval === undefined
      ? {}
      : { needsApproval: overrides.needsApproval }),
    execute: async () => ({ plan: "pro" }),
  });
  return registry;
}

describe("workflow definition hash", () => {
  it("is stable for equivalent separately-created definitions", () => {
    const first = workflow();
    const second = workflow();

    expect(getWorkflowDefinitionSnapshot(first)).toEqual(getWorkflowDefinitionSnapshot(second));
    expect(getWorkflowDefinitionHash(first)).toBe(getWorkflowDefinitionHash(second));
  });

  it("changes when planner system changes", () => {
    const first = workflow({
      planner: { model: ai("test", "planner"), harness: harness(), system: "System A." },
    });
    const second = workflow({
      planner: { model: ai("test", "planner"), harness: harness(), system: "System B." },
    });

    expect(getWorkflowDefinitionHash(first)).not.toBe(getWorkflowDefinitionHash(second));
  });

  it("changes when workflow bash capabilities change", () => {
    const first = workflow({
      bash: { network: false },
    } as Partial<WorkflowDefinition>);
    const second = workflow({
      bash: {
        network: {
          allow: ["https://api.example.com/*"],
          methods: ["GET"],
        },
      },
    } as Partial<WorkflowDefinition>);

    expect(getWorkflowDefinitionSnapshot(first)).toMatchObject({
      bashConfig: { network: false },
    });
    expect(getWorkflowDefinitionSnapshot(second)).toMatchObject({
      bashConfig: {
        network: {
          allowedUrlPrefixes: ["https://api.example.com/*"],
          allowedMethods: ["GET"],
          denyPrivateRanges: true,
        },
      },
    });
    expect(getWorkflowDefinitionHash(first)).not.toBe(getWorkflowDefinitionHash(second));
  });

  it("changes when harness id changes", () => {
    const first = workflow({
      planner: { model: ai("test", "planner"), harness: harness("testHarness@1.0.0") },
    });
    const second = workflow({
      planner: { model: ai("test", "planner"), harness: harness("testHarness@2.0.0") },
    });

    expect(getWorkflowDefinitionHash(first)).not.toBe(getWorkflowDefinitionHash(second));
  });

  it("changes when planner model provider changes", () => {
    const first = workflow({
      planner: { model: ai("provider-a", "planner"), harness: harness() },
    });
    const second = workflow({
      planner: { model: ai("provider-b", "planner"), harness: harness() },
    });

    expect(getWorkflowDefinitionHash(first)).not.toBe(getWorkflowDefinitionHash(second));
  });

  it("changes when planner model role identity changes despite a shared workflow model slot id", () => {
    const first = workflow({
      models: [
        model(ai("provider-a", "shared"), {
          id: "shared",
          description: "Workflow model.",
        }),
      ],
      planner: {
        model: model(ai("provider-b", "shared"), {
          id: "shared",
          description: "Planner model.",
        }),
        harness: harness(),
      },
    });
    const second = workflow({
      models: [
        model(ai("provider-b", "shared"), {
          id: "shared",
          description: "Planner model.",
        }),
      ],
      planner: {
        model: model(ai("provider-a", "shared"), {
          id: "shared",
          description: "Workflow model.",
        }),
        harness: harness(),
      },
    });

    expect(getWorkflowDefinitionHash(first)).not.toBe(getWorkflowDefinitionHash(second));
  });

  it("changes when output contract mode changes even if the raw schema is permissive", () => {
    const textHash = getWorkflowDefinitionHash(workflow({ output: { kind: "text" } }));
    const jsonHash = getWorkflowDefinitionHash(workflow({ output: { kind: "json" } }));
    const objectHash = getWorkflowDefinitionHash(workflow({ output: { kind: "object", schema: true } }));

    expect(new Set([textHash, jsonHash, objectHash]).size).toBe(3);
  });

  it("changes when output contract name or description changes", () => {
    const unnamed = workflow({ output: { kind: "object", schema: true } });
    const named = workflow({
      output: {
        kind: "object",
        name: "ticketSummary",
        description: "Summary payload.",
        schema: true,
      },
    });

    expect(getWorkflowDefinitionHash(unnamed)).not.toBe(getWorkflowDefinitionHash(named));
  });

  it("changes when a referenced global tool descriptor changes", () => {
    const definition = workflow({ globalTools: ["lookupCustomer"] });
    const baseline = getWorkflowDefinitionHash(definition, registryWithLookupCustomer());

    expect(
      getWorkflowDefinitionHash(
        definition,
        registryWithLookupCustomer({ description: "Look up customer plan and entitlements." }),
      ),
    ).not.toBe(baseline);
    expect(
      getWorkflowDefinitionHash(
        definition,
        registryWithLookupCustomer({
          inputSchema: {
            type: "object",
            properties: { customerId: { type: "string" }, region: { type: "string" } },
            required: ["customerId", "region"],
          },
        }),
      ),
    ).not.toBe(baseline);
    expect(
      getWorkflowDefinitionHash(
        definition,
        registryWithLookupCustomer({
          outputSchema: {
            type: "object",
            properties: { plan: { type: "string" }, seats: { type: "number" } },
            required: ["plan", "seats"],
          },
        }),
      ),
    ).not.toBe(baseline);
    expect(
      getWorkflowDefinitionHash(definition, registryWithLookupCustomer({ needsApproval: true })),
    ).not.toBe(baseline);
  });

  it("changes when a referenced global tool is missing from the registry", () => {
    const definition = workflow({ globalTools: ["lookupCustomer"] });

    expect(getWorkflowDefinitionHash(definition, createToolRegistry())).not.toBe(
      getWorkflowDefinitionHash(definition, registryWithLookupCustomer()),
    );
  });

  it("changes when tool selection policy changes", () => {
    const allTools = workflow({ toolSelection: "all" });
    const explicitOnly = workflow({ toolSelection: "explicit_only" });

    expect(getWorkflowDefinitionHash(allTools)).not.toBe(getWorkflowDefinitionHash(explicitOnly));
  });

  it("changes when planner skill frontmatter hash changes with the same source", () => {
    const first = workflow({
      planner: {
        model: ai("test", "planner"),
        harness: harness(),
        skills: [skillIdentity("skills/planner.md", "planner", "sha256:frontmatter-a")],
      },
    });
    const second = workflow({
      planner: {
        model: ai("test", "planner"),
        harness: harness(),
        skills: [skillIdentity("skills/planner.md", "planner", "sha256:frontmatter-b")],
      },
    });

    expect(getWorkflowDefinitionHash(first)).not.toBe(getWorkflowDefinitionHash(second));
  });

  it("changes when local skill file frontmatter changes at the same source path", () => {
    const directory = mkdtempSync(join(tmpdir(), "little-workflow-skill-"));
    const source = join(directory, "planner.md");
    writeFileSync(source, "---\nname: planner\nversion: 1\n---\nUse the planner.\n");
    const first = workflow({
      planner: {
        model: ai("test", "planner"),
        harness: harness(),
        skills: [skill(source)],
      },
    });
    const firstHash = getWorkflowDefinitionHash(first);

    writeFileSync(source, "---\nname: planner\nversion: 2\n---\nUse the planner.\n");
    const second = workflow({
      planner: {
        model: ai("test", "planner"),
        harness: harness(),
        skills: [skill(source)],
      },
    });

    expect(getWorkflowDefinitionHash(second)).not.toBe(firstHash);
  });

  it("uses skill frontmatter name rather than source path for local skill identity", () => {
    const firstDirectory = mkdtempSync(join(tmpdir(), "little-workflow-skill-move-a-"));
    const secondDirectory = mkdtempSync(join(tmpdir(), "little-workflow-skill-move-b-"));
    const frontmatter = "---\nname: planner\nversion: 1\n---\nUse the planner.\n";
    const firstSource = join(firstDirectory, "planner.md");
    const secondSource = join(secondDirectory, "renamed.md");
    writeFileSync(firstSource, frontmatter);
    writeFileSync(secondSource, frontmatter);

    const first = workflow({
      planner: {
        model: ai("test", "planner"),
        harness: harness(),
        skills: [skill(firstSource)],
      },
    });
    const second = workflow({
      planner: {
        model: ai("test", "planner"),
        harness: harness(),
        skills: [skill(secondSource)],
      },
    });

    expect(getWorkflowDefinitionHash(first)).toBe(getWorkflowDefinitionHash(second));
  });

  it("rejects relative skill sources without explicit frontmatter identity", () => {
    const directory = mkdtempSync(join(tmpdir(), "little-workflow-skill-relative-"));
    const source = join(directory, "planner.md");
    writeFileSync(source, "---\nname: planner\nversion: 1\n---\nUse the planner.\n");
    const relativeSource = relative(process.cwd(), source);

    expect(() =>
      getWorkflowDefinitionHash(workflow({
        planner: {
          model: ai("test", "planner"),
          harness: harness(),
          skills: [skill(relativeSource)],
        },
      })),
    ).toThrow(/must provide name and frontmatterHash/u);
  });

  it("changes when local skill directory frontmatter changes at the same source path", () => {
    const source = mkdtempSync(join(tmpdir(), "little-workflow-skill-dir-"));
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "SKILL.md"), "---\nname: worker\nversion: 1\n---\nUse the worker.\n");
    const first = workflow({
      worker: {
        harness: harness(),
        skills: [skill(source)],
      },
    });
    const firstHash = getWorkflowDefinitionHash(first);

    writeFileSync(join(source, "SKILL.md"), "---\nname: worker\nversion: 2\n---\nUse the worker.\n");
    const second = workflow({
      worker: {
        harness: harness(),
        skills: [skill(source)],
      },
    });

    expect(getWorkflowDefinitionHash(second)).not.toBe(firstHash);
  });

  it("is stable when planner skill identity order changes", () => {
    const first = workflow({
      planner: {
        model: ai("test", "planner"),
        harness: harness(),
        skills: [
          skillIdentity("skills/z-source.md", "alpha", "sha256:frontmatter-a"),
          skillIdentity("skills/a-source.md", "beta", "sha256:frontmatter-b"),
        ],
      },
    });
    const second = workflow({
      planner: {
        model: ai("test", "planner"),
        harness: harness(),
        skills: [
          skillIdentity("skills/a-source.md", "beta", "sha256:frontmatter-b"),
          skillIdentity("skills/z-source.md", "alpha", "sha256:frontmatter-a"),
        ],
      },
    });

    expect(getWorkflowDefinitionHash(first)).toBe(getWorkflowDefinitionHash(second));
  });

  it("rejects dynamic tool approval predicates because closures are not hashable", () => {
    const definition = workflow({ globalTools: ["lookupCustomer"] });
    const approvalRegistry = registryWithLookupCustomer({
      needsApproval: (args) =>
        typeof args === "object" && args !== null && "risk" in args,
    });

    expect(() => getWorkflowDefinitionHash(definition, approvalRegistry)).toThrow(
      /function-valued tool approval predicates are not hashable/u,
    );
  });

  it("names the offending tool when a function-valued approval predicate is rejected", () => {
    const definition = workflow({ globalTools: ["lookupCustomer"] });
    const approvalRegistry = registryWithLookupCustomer({
      needsApproval: (args) =>
        typeof args === "object" && args !== null && "risk" in args,
    });

    expect(() => getWorkflowDefinitionHash(definition, approvalRegistry)).toThrow(/lookupCustomer/u);
  });

  it("sorts global tools and attached memory stores", () => {
    const first = workflow({
      globalTools: ["summarize", "lookupCustomer"],
      memory: {
        attach: [
          { id: "team-policy", mode: "ro" },
          { id: "product-facts", mode: "ro" },
        ],
      },
    });
    const second = workflow({
      globalTools: ["lookupCustomer", "summarize"],
      memory: {
        attach: [
          { id: "product-facts", mode: "ro" },
          { id: "team-policy", mode: "ro" },
        ],
      },
    });

    expect(getWorkflowDefinitionHash(first)).toBe(getWorkflowDefinitionHash(second));
    expect(getWorkflowDefinitionSnapshot(first).globalTools).toEqual([
      "lookupCustomer",
      "summarize",
    ]);
    expect(getWorkflowDefinitionSnapshot(first).memoryConfig.attached).toEqual([
      { id: "product-facts", mode: "ro" },
      { id: "team-policy", mode: "ro" },
    ]);
  });
});

describe("planning definition hash", () => {
  it("captures only planner-visible workflow definition inputs", () => {
    const definition = workflow({
      suggestedInputSchema: {
        type: "object",
        properties: { body: { type: "string" }, priority: { type: "string" } },
        required: ["body"],
      },
    } as unknown as Partial<WorkflowDefinition>);

    expect(getPlanningDefinitionSnapshot(definition, registryWithLookupCustomer()))
      .toEqual({
        id: "support.summarize",
        description: "Summarize support tickets.",
        inputSchema: {
          hash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
          summary: {
            type: "object",
            required: ["body"],
            properties: ["body"],
          },
        },
        suggestedInputSchema: {
          descriptor: {
            type: "object",
            properties: {
              body: { type: "string" },
              priority: { type: "string" },
            },
            required: ["body"],
          },
          hash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
        },
        requestedOutput: {
          kind: "object",
          schema: {
            type: "object",
            properties: { summary: { type: "string" } },
            required: ["summary"],
          },
          name: "",
          description: "",
        },
        requestedOutputHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
        modelSlots: [
          {
            id: "planner",
            providerId: "test",
            modelId: "planner",
            description: "",
          },
          {
            id: "worker",
            providerId: "test",
            modelId: "worker",
            description: "Worker model.",
          },
        ],
        plannerConfig: {
          modelSlotId: "planner",
          modelIdentity: {
            id: "planner",
            providerId: "test",
            modelId: "planner",
            description: "",
          },
          harnessId: "testHarness@1.0.0",
          systemHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
          skillsHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
        },
        plannerVisibleTools: [
          {
            name: "lookupCustomer",
            registered: true,
            descriptionHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
            inputSchemaHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
            outputSchemaHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
            approvalPolicy: "none",
          },
        ],
        plannerVisibleToolsHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
        toolSelection: "planner_selected",
      });
  });

  it("is stable when worker-only configuration changes", () => {
    const first = workflow({
      worker: {
        harness: harness("workerHarness@1.0.0"),
        skills: [skillIdentity("skills/worker.md", "worker", "sha256:worker-a")],
      },
      memory: { workflow: "rw", org: "ro" },
      bash: { network: false },
    } as Partial<WorkflowDefinition>);
    const second = workflow({
      worker: {
        harness: harness("workerHarness@2.0.0"),
        skills: [skillIdentity("skills/worker.md", "worker", "sha256:worker-b")],
      },
      memory: { workflow: "none", org: "none" },
      bash: {
        network: {
          allow: ["https://api.example.com/*"],
          methods: ["POST"],
        },
      },
    } as Partial<WorkflowDefinition>);

    expect(getPlanningDefinitionHash(first)).toBe(getPlanningDefinitionHash(second));
  });

  it("changes when planner-visible configuration changes", () => {
    const baseline = workflow({ globalTools: ["lookupCustomer"] });
    const baselineHash = getPlanningDefinitionHash(baseline, registryWithLookupCustomer());

    expect(
      getPlanningDefinitionHash(
        workflow({
          planner: {
            model: ai("test", "planner"),
            harness: harness(),
            system: "Plan differently.",
            skills: [skillIdentity("skills/planner.md", "planner", "sha256:planner")],
          },
        }),
        registryWithLookupCustomer(),
      ),
    ).not.toBe(baselineHash);
    expect(
      getPlanningDefinitionHash(
        workflow({
          planner: {
            model: ai("test", "planner"),
            harness: harness(),
            system: "Plan carefully.",
            skills: [skillIdentity("skills/planner.md", "planner", "sha256:planner-v2")],
          },
        }),
        registryWithLookupCustomer(),
      ),
    ).not.toBe(baselineHash);
    expect(
      getPlanningDefinitionHash(
        workflow({
          planner: {
            model: ai("other", "planner"),
            harness: harness(),
            system: "Plan carefully.",
            skills: [skillIdentity("skills/planner.md", "planner", "sha256:planner")],
          },
        }),
        registryWithLookupCustomer(),
      ),
    ).not.toBe(baselineHash);
    expect(
      getPlanningDefinitionHash(
        workflow({ output: { kind: "text" } }),
        registryWithLookupCustomer(),
      ),
    ).not.toBe(baselineHash);
    expect(
      getPlanningDefinitionHash(
        workflow({
          suggestedInputSchema: {
            type: "object",
            properties: { body: { type: "string" }, priority: { type: "string" } },
            required: ["body"],
          },
        } as unknown as Partial<WorkflowDefinition>),
        registryWithLookupCustomer(),
      ),
    ).not.toBe(baselineHash);
    expect(
      getPlanningDefinitionHash(
        workflow({ globalTools: ["lookupCustomer"] }),
        registryWithLookupCustomer({ description: "Look up customer details and subscription." }),
      ),
    ).not.toBe(baselineHash);
  });
});
