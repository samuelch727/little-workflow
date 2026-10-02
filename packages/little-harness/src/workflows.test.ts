import { expect, expectTypeOf, test } from "vitest";
import {
  DEFAULT_WORKFLOW_INHERITANCE_POLICY,
  resolveHarnessWorkflowTools,
  resolveWorkflowInheritance,
  toolInputSchemaFromWorkflowMarker,
  validateHarnessWorkflowExecution,
  workflowHandleFromId,
  workflowToolDescription,
  type HarnessCancelledWorkflowExecution,
  type HarnessPreparedWorkflow,
  type HarnessPreparedWorkflowSnapshotEnvelope,
  type HarnessWorkflow,
  type HarnessWorkflowDefinitionIdentity,
  type HarnessWorkflowPrepareContext,
  type HarnessWorkflowRunContext,
} from "./workflows.js";

function fakeWorkflow(overrides: Partial<HarnessWorkflow> = {}): HarnessWorkflow {
  return {
    id: "billing.refund",
    description: "Process a customer refund.",
    inputSchema: {
      kind: "json-schema",
      schema: {
        type: "object",
        properties: { orderId: { type: "string" } },
        required: ["orderId"],
        additionalProperties: false,
      },
    },
    executionMode: "inline",
    definitionIdentity: "sha256:test-billing-refund",
    runForHarness: async (_input, ctx) => ({
      protocolVersion: 1,
      status: "completed",
      output: { ok: true },
      runId: ctx.reservedRunId,
      summary: "Refund completed.",
    }),
    ...overrides,
  };
}

const workflowToolOptions = {
  sessionId: "sess_1",
  turnId: "turn_1",
  originTurnId: "turn_1",
  dataDir: "/tmp/lh-workflows",
};

test("derives workflow tool handles from every dotted id segment", () => {
  expect(workflowHandleFromId("candidate.review")).toBe("candidate_review");
  expect(workflowHandleFromId("candidate-review")).toBe("candidate_review");
  expect(workflowHandleFromId("billing.2026")).toBe("billing_2026");
});

test.each(["...", ".candidate.review", "candidate..review", "candidate.review.", "123"])(
  "rejects invalid workflow id %s",
  (id) => {
    expect(() => workflowHandleFromId(id)).toThrow(/valid workflow handle/i);
  },
);

test("enforces the final workflow handle length", () => {
  const accepted = "a".repeat(32) + "." + "b".repeat(31);
  const rejected = "a".repeat(32) + "." + "b".repeat(32);

  expect(workflowHandleFromId(accepted)).toHaveLength(64);
  expect(() => workflowHandleFromId(rejected)).toThrow(/valid workflow handle/i);
});

test("the tool carries the workflow's description and an input schema", () => {
  const tools = resolveHarnessWorkflowTools([fakeWorkflow()], workflowToolOptions);
  expect(tools.billing_refund?.description).toBe("Process a customer refund.");
  expect(tools.billing_refund?.inputSchema).toBeDefined();
});

test("workflow tools call runForHarness with protocol context and return compact metadata", async () => {
  let seenContext: unknown;
  const workflow: HarnessWorkflow = {
    id: "candidate.review",
    description: "Review a candidate.",
    inputSchema: { kind: "untyped", allowUntypedInput: true },
    executionMode: "inline",
    definitionIdentity: "sha256:test-candidate-review",
    async runForHarness(input, ctx) {
      expect(input).toEqual({ candidateId: "C-1" });
      seenContext = ctx;
      return {
        protocolVersion: 1,
        status: "completed",
        output: { recommendation: "advance" },
        runId: ctx.reservedRunId,
        summary: "Candidate advances.",
      };
    },
  };

  const tools = resolveHarnessWorkflowTools([workflow], workflowToolOptions);
  const result = await tools.candidate_review?.execute?.(
    { candidateId: "C-1" },
    { toolCallId: "call_1" } as never,
  );

  expect(result).toMatchObject({
    status: "completed",
    outputSummary: "Candidate advances.",
  });
  expect(seenContext).toMatchObject({
    protocolVersion: 1,
    workflowId: "candidate.review",
    workflowHandle: "candidate_review",
    disposition: "await",
    parentSessionId: "sess_1",
    parentTurnId: "turn_1",
    originTurnId: "turn_1",
    persistence: { dataDir: "/tmp/lh-workflows" },
    toolCallId: "call_1",
    inheritance: DEFAULT_WORKFLOW_INHERITANCE_POLICY,
  });
  expect(seenContext).toMatchObject({
    capabilities: {
      tools: {},
      mcpTools: {},
      bash: {},
      code: {},
      workflows: {},
      skills: {},
      mounts: [],
      permissions: { approvalPolicy: "reject_ask" },
    },
  });
  expect((seenContext as { observation?: { recordProgress?: unknown } }).observation?.recordProgress).toBeTypeOf("function");
  await expect(
    (seenContext as { observation: { recordProgress(progress: unknown): Promise<void> } }).observation.recordProgress({
      status: "checking",
    }),
  ).resolves.toBeUndefined();
});

test("workflow context uses a stable fallback toolCallId when the AI SDK omits one", async () => {
  let seenContext: unknown;
  const tools = resolveHarnessWorkflowTools([
    fakeWorkflow({
      id: "candidate.review",
      runForHarness: async (_input, ctx) => {
        seenContext = ctx;
        return {
          protocolVersion: 1,
          status: "completed",
          output: { ok: true },
          runId: ctx.reservedRunId,
        };
      },
    }),
  ], workflowToolOptions);

  await tools.candidate_review?.execute?.({}, {} as never);

  expect(seenContext).toMatchObject({
    toolCallId: "candidate_review_manual",
    reservedRunId: "run_candidate_review_candidate_review_manual",
  });
});

test("reserved workflow run ids are bounded and safe for persistence", async () => {
  let seenReservedRunId = "";
  const tools = resolveHarnessWorkflowTools([
    fakeWorkflow({
      id: "a".repeat(64),
      runForHarness: async (_input, ctx) => {
        seenReservedRunId = ctx.reservedRunId;
        return {
          protocolVersion: 1,
          status: "completed",
          output: { ok: true },
          runId: ctx.reservedRunId,
        };
      },
    }),
  ], workflowToolOptions);

  await tools["a".repeat(64)]?.execute?.({}, {
    toolCallId: `call:${"punctuated/segment.".repeat(20)}${"x".repeat(160)}`,
  } as never);

  expect(seenReservedRunId).toMatch(/^run_[A-Za-z0-9_]+$/u);
  expect(seenReservedRunId).not.toContain(":");
  expect(seenReservedRunId.length).toBeLessThanOrEqual(128);
});

test("forwards a failed execution's summary to the model alongside the cause code", async () => {
  const tools = resolveHarnessWorkflowTools([
    fakeWorkflow({
      id: "candidate.review",
      runForHarness: async (_input, ctx) => ({
        protocolVersion: 1,
        status: "failed",
        runId: ctx.reservedRunId,
        causeCode: "workflow_failed",
        message: "scoring service unavailable",
        summary: "Failed at step 'review.score' (step_failed): scoring service unavailable",
      }),
    }),
  ], workflowToolOptions);

  await expect(tools.candidate_review?.execute?.({}, { toolCallId: "call_1" } as never)).resolves.toEqual({
    status: "failed",
    runId: "run_candidate_review_call_1",
    causeCode: "workflow_failed",
    message: "scoring service unavailable",
    outputSummary: "Failed at step 'review.score' (step_failed): scoring service unavailable",
  });
});

test("omits outputSummary from a failed execution that carries no summary", async () => {
  const tools = resolveHarnessWorkflowTools([
    fakeWorkflow({
      id: "candidate.review",
      runForHarness: async (_input, ctx) => ({
        protocolVersion: 1,
        status: "cancelled",
        runId: ctx.reservedRunId,
        causeCode: "cancelled",
        message: "Run was cancelled.",
      }),
    }),
  ], workflowToolOptions);

  await expect(tools.candidate_review?.execute?.({}, { toolCallId: "call_1" } as never)).resolves.toEqual({
    status: "cancelled",
    runId: "run_candidate_review_call_1",
    causeCode: "cancelled",
    message: "Run was cancelled.",
  });
});

test("returns an empty tool set when no workflows are given", () => {
  expect(resolveHarnessWorkflowTools(undefined, workflowToolOptions)).toEqual({});
  expect(resolveHarnessWorkflowTools([], workflowToolOptions)).toEqual({});
});

test("throws when two workflow ids resolve to the same handle", () => {
  expect(() =>
    resolveHarnessWorkflowTools([
      fakeWorkflow({ id: "a.b" }),
      fakeWorkflow({ id: "a_b" }),
    ], workflowToolOptions),
  ).toThrow(/not unique/i);
});

test("rejects omitted input schema before exposing a workflow tool", () => {
  expect(() =>
    resolveHarnessWorkflowTools([
      fakeWorkflow({ inputSchema: undefined }),
    ], workflowToolOptions),
  ).toThrow(/untyped input/i);
});

test("maps explicit workflow schema markers to tool input schemas", () => {
  expect(toolInputSchemaFromWorkflowMarker({
    kind: "json-schema",
    schema: { type: "object", properties: { id: { type: "string" } } },
  })).toBeDefined();
  expect(toolInputSchemaFromWorkflowMarker({
    kind: "untyped",
    allowUntypedInput: true,
  })).toBeDefined();
});

test("rejects unsafe or unsupported workflow schema markers", () => {
  expect(() =>
    toolInputSchemaFromWorkflowMarker({ kind: "untyped", allowUntypedInput: false }),
  ).toThrow(/untyped input/i);
  expect(() =>
    toolInputSchemaFromWorkflowMarker({ kind: "unconvertible", error: "Zod effects cannot be represented." }),
  ).toThrow(/Zod effects cannot be represented/);
  expect(() =>
    toolInputSchemaFromWorkflowMarker({ kind: "zod", schema: {} } as never),
  ).toThrow(/workflow input schema marker/i);
});

test("appends lossy schema warnings to workflow tool descriptions", () => {
  const description = workflowToolDescription(fakeWorkflow({
    inputSchema: {
      kind: "json-schema",
      schema: {
        type: "object",
        properties: { when: { instanceof: "Date" } },
      },
      warning: "Date validators are not representable as JSON Schema.",
    },
  }));

  expect(description).toContain("Process a customer refund.");
  expect(description).toContain("Date validators are not representable as JSON Schema.");
});

test("validates workflow execution protocol fail-closed cases", () => {
  expect(() =>
    validateHarnessWorkflowExecution({ protocolVersion: 2, status: "completed", runId: "run_1", output: {} } as never),
  ).toThrow(/unsupported.*protocol/i);
  expect(() =>
    validateHarnessWorkflowExecution({ protocolVersion: 1, status: "paused", runId: "run_1" } as never),
  ).toThrow(/unsupported status/i);
  expect(() =>
    validateHarnessWorkflowExecution({
      protocolVersion: 1,
      status: "failed",
      runId: "run_1",
      causeCode: "future_code",
      message: "Failed.",
    } as never),
  ).toThrow(/unsupported.*cause/i);
  expect(() =>
    validateHarnessWorkflowExecution({ protocolVersion: 1, status: "completed", runId: "run_1" }),
  ).toThrow(/output/i);
  expect(() =>
    validateHarnessWorkflowExecution({
      protocolVersion: 1,
      status: "failed",
      runId: "run_1",
      causeCode: "workflow_failed",
    }),
  ).toThrow(/message/i);
  expect(() =>
    validateHarnessWorkflowExecution({
      protocolVersion: 1,
      status: "failed",
      runId: "run_1",
      message: "Failed.",
    }),
  ).toThrow(/causeCode/i);
  expect(() =>
    validateHarnessWorkflowExecution({
      protocolVersion: 1,
      status: "cancelled",
      runId: "run_1",
      causeCode: "cancelled",
    } as never),
  ).toThrow(/message/i);
  expect(() =>
    validateHarnessWorkflowExecution({
      protocolVersion: 1,
      status: "cancelled",
      runId: "run_1",
      message: "Cancelled.",
    } as never),
  ).toThrow(/causeCode/i);
  expect(() =>
    validateHarnessWorkflowExecution({
      protocolVersion: 1,
      status: "cancelled",
      runId: "run_1",
      causeCode: "timeout",
      message: "Timed out.",
    } as never),
  ).toThrow(/cancelled/i);
  expect(validateHarnessWorkflowExecution({
    protocolVersion: 1,
    status: "cancelled",
    runId: "run_1",
    causeCode: "cancelled",
    message: "Cancelled.",
  })).toMatchObject({ status: "cancelled" });
  expect(() =>
    validateHarnessWorkflowExecution({
      protocolVersion: 1,
      status: "failed",
      runId: "run_1",
      causeCode: "workflow_failed",
      message: "Failed.",
      outputPath: "runs/run_1/output.json",
    }),
  ).toThrow(/outputPath/i);
  expect(() =>
    validateHarnessWorkflowExecution({
      protocolVersion: 1,
      status: "cancelled",
      runId: "run_1",
      causeCode: "cancelled",
      message: "Cancelled.",
      outputPath: "runs/run_1/output.json",
    } as never),
  ).toThrow(/outputPath/i);
});

test("inline workflows cannot return running executions", async () => {
  const tools = resolveHarnessWorkflowTools([
    fakeWorkflow({
      id: "candidate.review",
      runForHarness: async () => ({
        protocolVersion: 1,
        status: "running",
        runId: "run_inline",
      }),
    }),
  ], workflowToolOptions);

  await expect(tools.candidate_review?.execute?.({}, { toolCallId: "call_1" } as never)).resolves.toMatchObject({
    status: "failed",
    causeCode: "unsupported_protocol",
  });
});

test("durable running workflow executions must echo the reserved run id", async () => {
  const tools = resolveHarnessWorkflowTools([
    fakeWorkflow({
      id: "candidate.review",
      executionMode: "durable",
      runForHarness: async () => ({
        protocolVersion: 1,
        status: "running",
        runId: "run_unreserved",
      }),
    }),
  ], workflowToolOptions);

  await expect(tools.candidate_review?.execute?.({}, { toolCallId: "call_1" } as never)).resolves.toMatchObject({
    status: "failed",
    runId: "run_candidate_review_call_1",
    causeCode: "launch_corruption",
  });
});

const parentSnapshot = {
  tools: {
    lookup_order: { description: "Lookup order" },
    refund_order: { description: "Refund order" },
  },
  mcpTools: {
    "linear.get_issue": { server: "linear" },
    "github.get_pull_request": { server: "github" },
  },
  skills: {
    review: { path: "skills/review/SKILL.md" },
    refund: { path: "skills/refund/SKILL.md" },
  },
  mounts: [
    { name: "memory", path: "/mnt/memory", access: "read" },
    { name: "scratch", path: "/mnt/scratch", access: "readwrite" },
  ],
  pipelineMemory: { transcript: "parent" },
  permissions: {
    filesystem: "workspace-write",
    approvalPolicy: "ask_becomes_deny",
  },
  bash: {
    run_shell: { description: "Run shell" },
  },
  code: {
    edit_file: { description: "Edit file" },
  },
  workflows: {
    billing_refund: { description: "Refund workflow" },
  },
} as const;

test("default workflow inheritance policy explicitly denies parent capabilities", () => {
  expect(DEFAULT_WORKFLOW_INHERITANCE_POLICY).toEqual({
    tools: { mode: "none" },
    mcpTools: { mode: "none" },
    bash: { mode: "none" },
    code: { mode: "none" },
    workflows: { mode: "none" },
    skills: { mode: "none" },
    mounts: [],
    pipelineMemory: "none",
    permissions: { mode: "none", approvalPolicy: "reject_ask" },
  });
  expect(resolveWorkflowInheritance(undefined, parentSnapshot)).toEqual({
    tools: {},
    mcpTools: {},
    bash: {},
    code: {},
    workflows: {},
    skills: {},
    mounts: [],
    pipelineMemory: undefined,
    permissions: { approvalPolicy: "reject_ask" },
  });
});

test("workflow inheritance snapshots pipeline memory and selected approval policy only when opted in", () => {
  expect(resolveWorkflowInheritance({
    pipelineMemory: "snapshot",
    permissions: { mode: "snapshot", approvalPolicy: "ask_becomes_deny" },
  }, parentSnapshot)).toMatchObject({
    tools: {},
    mcpTools: {},
    bash: {},
    code: {},
    workflows: {},
    skills: {},
    mounts: [],
    pipelineMemory: parentSnapshot.pipelineMemory,
    permissions: {
      filesystem: "workspace-write",
      approvalPolicy: "ask_becomes_deny",
    },
  });
});

test("workflow inheritance passes explicit capability allowlists", () => {
  expect(resolveWorkflowInheritance({
    tools: { mode: "allowlist", handles: ["lookup_order"] },
    mcpTools: { mode: "allowlist", handles: ["linear.get_issue"] },
    bash: { mode: "allowlist", handles: ["run_shell"] },
    code: { mode: "allowlist", handles: ["edit_file"] },
    workflows: { mode: "allowlist", handles: ["billing_refund"] },
    skills: { mode: "allowlist", names: ["review"] },
  }, parentSnapshot)).toMatchObject({
    tools: { lookup_order: parentSnapshot.tools.lookup_order },
    mcpTools: { "linear.get_issue": parentSnapshot.mcpTools["linear.get_issue"] },
    bash: { run_shell: parentSnapshot.bash.run_shell },
    code: { edit_file: parentSnapshot.code.edit_file },
    workflows: { billing_refund: parentSnapshot.workflows.billing_refund },
    skills: { review: parentSnapshot.skills.review },
  });
});

test("workflow inheritance rejects allowlisted capabilities absent from the parent manifest", () => {
  expect(() =>
    resolveWorkflowInheritance({ tools: { mode: "allowlist", handles: ["missing_tool"] } }, parentSnapshot),
  ).toThrow(/missing_tool/);
  expect(() =>
    resolveWorkflowInheritance({ mcpTools: { mode: "allowlist", handles: ["missing.mcp"] } }, parentSnapshot),
  ).toThrow(/missing\.mcp/);
  expect(() =>
    resolveWorkflowInheritance({ skills: { mode: "allowlist", names: ["missing_skill"] } }, parentSnapshot),
  ).toThrow(/missing_skill/);
});

test("workflow inheritance preserves declared mount access and never defaults to all parent mounts", () => {
  expect(resolveWorkflowInheritance({
    mounts: [{ name: "memory", path: "/mnt/memory", access: "read" }],
  }, parentSnapshot).mounts).toEqual([{ name: "memory", path: "/mnt/memory", access: "read" }]);
});

test("workflow tool schemas do not add include or mount fields", () => {
  const marker = {
    kind: "json-schema",
    schema: {
      type: "object",
      properties: { orderId: { type: "string" } },
      required: ["orderId"],
      additionalProperties: false,
    },
  } as const;
  const schema = toolInputSchemaFromWorkflowMarker(marker) as { jsonSchema?: unknown };

  expect(JSON.stringify(schema.jsonSchema)).not.toContain("include");
  expect(JSON.stringify(schema.jsonSchema)).not.toContain("mount");
});

test("compact workflow results preserve explicit outputPath but do not synthesize one", async () => {
  const noPathTools = resolveHarnessWorkflowTools([
    fakeWorkflow({
      id: "candidate.review",
      runForHarness: async (_input, ctx) => ({
        protocolVersion: 1,
        status: "completed",
        runId: ctx.reservedRunId,
        output: { recommendation: "advance" },
      }),
    }),
  ], workflowToolOptions);
  await expect(noPathTools.candidate_review?.execute?.({}, { toolCallId: "call_1" } as never)).resolves.not.toHaveProperty(
    "outputPath",
  );
  await expect(noPathTools.candidate_review?.execute?.({}, { toolCallId: "call_1" } as never)).resolves.not.toHaveProperty(
    "output",
  );

  const explicitPathTools = resolveHarnessWorkflowTools([
    fakeWorkflow({
      id: "candidate.review",
      runForHarness: async (_input, ctx) => ({
        protocolVersion: 1,
        status: "completed",
        runId: ctx.reservedRunId,
        output: { recommendation: "advance" },
        outputPath: "runs/run_1/output.json",
      }),
    }),
  ], workflowToolOptions);
  await expect(explicitPathTools.candidate_review?.execute?.({}, { toolCallId: "call_1" } as never)).resolves.toMatchObject({
    outputPath: "runs/run_1/output.json",
  });
});

test("prepared workflow protocol types expose planned durable identity fields", () => {
  type NotApplicable = { readonly notApplicable: true; readonly reason?: string };

  expectTypeOf<HarnessCancelledWorkflowExecution["causeCode"]>().toEqualTypeOf<"cancelled">();
  expectTypeOf<NotApplicable>().toMatchTypeOf<HarnessWorkflowDefinitionIdentity>();
  expectTypeOf({
    protocolVersion: 1,
    workflowId: "candidate.review",
    versionId: "wfver_candidate_review",
    workflowDefinitionHash: { notApplicable: true, reason: "test fixture" },
    capabilityHash: "sha256:capability",
    modelToolSkillSnapshotHash: { notApplicable: true },
    inputShapeHash: "sha256:input-shape",
  } as const).toMatchTypeOf<HarnessPreparedWorkflow>();
  expectTypeOf({
    workflowId: "candidate.review",
    workflowDefinitionHash: "sha256:workflow-definition",
    capabilityHash: "sha256:capability",
    modelToolSkillSnapshotHash: "sha256:model-tool-skill",
    inputShapeHash: "sha256:input-shape",
    exampleInputHash: "sha256:example-input",
  } as const).toMatchTypeOf<HarnessPreparedWorkflowSnapshotEnvelope>();
  expectTypeOf<HarnessWorkflowPrepareContext>().toMatchTypeOf<{
    readonly prepareId: string;
    readonly prepareCallIdentity: string;
    readonly prepareSnapshot: HarnessPreparedWorkflowSnapshotEnvelope;
  }>();
  expectTypeOf<Parameters<NonNullable<HarnessWorkflow["runPreparedForHarness"]>>>()
    .toEqualTypeOf<[HarnessPreparedWorkflow, unknown, HarnessWorkflowRunContext]>();
});

// --- session-scoped workflow-run admission control (maxConcurrentWorkflowRuns) -------------

function gatedWorkflow(state: {
  inFlight: number;
  peak: number;
  gates: Array<() => void>;
}): HarnessWorkflow {
  return fakeWorkflow({
    id: "candidate.review",
    async runForHarness(input, ctx) {
      state.inFlight += 1;
      state.peak = Math.max(state.peak, state.inFlight);
      await new Promise<void>((resolve) => state.gates.push(resolve));
      state.inFlight -= 1;
      return {
        protocolVersion: 1,
        status: "completed",
        output: input,
        runId: ctx.reservedRunId,
        summary: `summary ${(input as { n: number }).n}`,
      };
    },
  });
}

const nextTick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

test("parallel workflow tool calls never exceed maxConcurrentWorkflowRuns in flight", async () => {
  const limit = 3;
  const total = 25;
  const state = { inFlight: 0, peak: 0, gates: [] as Array<() => void> };
  const tools = resolveHarnessWorkflowTools([gatedWorkflow(state)], {
    ...workflowToolOptions,
    sessionId: "sess_fanout_bound",
    budgets: { maxConcurrentWorkflowRuns: limit, maxQueuedWorkflowRuns: 100 },
  });

  const calls = Array.from({ length: total }, (_unused, n) =>
    tools.candidate_review?.execute?.({ n }, { toolCallId: `call_${n}` } as never));

  for (let released = 0; released < total; released += 1) {
    await nextTick();
    expect(state.inFlight).toBeLessThanOrEqual(limit);
    // Only admitted runs ever register a gate, so this is a direct read of "runs started".
    expect(state.gates.length).toBeLessThanOrEqual(limit);
    state.gates.shift()?.();
  }

  const results = await Promise.all(calls);
  expect(results).toHaveLength(total);
  expect(state.peak).toBe(limit);
  expect(state.inFlight).toBe(0);
  results.forEach((result, n) => {
    expect(result).toEqual({
      status: "completed",
      runId: `run_candidate_review_call_${n}`,
      outputSummary: `summary ${n}`,
    });
  });
});

test("a single uncontended workflow tool call is pass-through: the run starts in the caller's tick", async () => {
  let started = false;
  const tools = resolveHarnessWorkflowTools([
    fakeWorkflow({
      id: "candidate.review",
      async runForHarness(_input, ctx) {
        started = true;
        return {
          protocolVersion: 1,
          status: "completed",
          output: { ok: true },
          runId: ctx.reservedRunId,
          summary: "Reviewed.",
        };
      },
    }),
  ], { ...workflowToolOptions, sessionId: "sess_fanout_passthrough" });

  const call = tools.candidate_review?.execute?.({}, { toolCallId: "call_1" } as never);
  expect(started).toBe(true);
  await expect(call).resolves.toEqual({
    status: "completed",
    runId: "run_candidate_review_call_1",
    outputSummary: "Reviewed.",
  });
});

test("queueing past maxQueuedWorkflowRuns fails the call and names the budget", async () => {
  const state = { inFlight: 0, peak: 0, gates: [] as Array<() => void> };
  const tools = resolveHarnessWorkflowTools([gatedWorkflow(state)], {
    ...workflowToolOptions,
    sessionId: "sess_fanout_queue_bound",
    budgets: { maxConcurrentWorkflowRuns: 1, maxQueuedWorkflowRuns: 2 },
  });

  const admitted = tools.candidate_review?.execute?.({ n: 0 }, { toolCallId: "call_0" } as never);
  const queued = [1, 2].map((n) =>
    tools.candidate_review?.execute?.({ n }, { toolCallId: `call_${n}` } as never));
  const overflow = await tools.candidate_review?.execute?.({ n: 3 }, { toolCallId: "call_3" } as never);

  expect(overflow).toMatchObject({
    status: "failed",
    runId: "run_candidate_review_call_3",
    causeCode: "max_queued_workflow_runs",
  });
  expect((overflow as { message: string }).message).toContain("maxQueuedWorkflowRuns is 2");
  // The rejected call never started a run.
  expect(state.peak).toBe(1);

  for (let released = 0; released < 3; released += 1) {
    await nextTick();
    state.gates.shift()?.();
  }
  const results = await Promise.all([admitted, ...queued]);
  expect(results.map((result) => (result as { status: string }).status)).toEqual([
    "completed",
    "completed",
    "completed",
  ]);
});

test("the workflow-run bound is shared across every workflow tool of a session", async () => {
  const state = { inFlight: 0, peak: 0, gates: [] as Array<() => void> };
  const shared = {
    ...workflowToolOptions,
    sessionId: "sess_fanout_shared",
    budgets: { maxConcurrentWorkflowRuns: 1, maxQueuedWorkflowRuns: 10 },
  };
  const first = resolveHarnessWorkflowTools([gatedWorkflow(state)], shared);
  // A second resolve for the same session (a later turn, or a second workflow handle) must
  // draw on the same pool -- a per-tool gate would allow tools x limit concurrent runs.
  const second = resolveHarnessWorkflowTools([gatedWorkflow(state)], { ...shared, turnId: "turn_2" });

  const calls = [
    first.candidate_review?.execute?.({ n: 0 }, { toolCallId: "call_0" } as never),
    second.candidate_review?.execute?.({ n: 1 }, { toolCallId: "call_1" } as never),
  ];
  await nextTick();
  expect(state.inFlight).toBe(1);

  for (let released = 0; released < 2; released += 1) {
    await nextTick();
    expect(state.inFlight).toBeLessThanOrEqual(1);
    state.gates.shift()?.();
  }
  await Promise.all(calls);
  expect(state.peak).toBe(1);
});

test("different sessions do not contend for the same workflow-run slots", async () => {
  const state = { inFlight: 0, peak: 0, gates: [] as Array<() => void> };
  const budgets = { maxConcurrentWorkflowRuns: 1, maxQueuedWorkflowRuns: 10 };
  const a = resolveHarnessWorkflowTools([gatedWorkflow(state)], {
    ...workflowToolOptions,
    sessionId: "sess_fanout_isolated_a",
    budgets,
  });
  const b = resolveHarnessWorkflowTools([gatedWorkflow(state)], {
    ...workflowToolOptions,
    sessionId: "sess_fanout_isolated_b",
    budgets,
  });

  const calls = [
    a.candidate_review?.execute?.({ n: 0 }, { toolCallId: "call_0" } as never),
    b.candidate_review?.execute?.({ n: 1 }, { toolCallId: "call_1" } as never),
  ];
  await nextTick();
  expect(state.inFlight).toBe(2);

  state.gates.shift()?.();
  state.gates.shift()?.();
  await Promise.all(calls);
});

test("a workflow run that throws still frees its slot for the queued call behind it", async () => {
  let secondStarted = false;
  const release = { resolve: (): void => {} };
  const held = new Promise<void>((resolve) => {
    release.resolve = resolve;
  });
  const tools = resolveHarnessWorkflowTools([
    fakeWorkflow({
      id: "candidate.review",
      async runForHarness(input, ctx) {
        if ((input as { n: number }).n === 0) {
          await held;
          throw new Error("workflow exploded");
        }
        secondStarted = true;
        return {
          protocolVersion: 1,
          status: "completed",
          output: { ok: true },
          runId: ctx.reservedRunId,
          summary: "Second ran.",
        };
      },
    }),
  ], {
    ...workflowToolOptions,
    sessionId: "sess_fanout_failure_release",
    budgets: { maxConcurrentWorkflowRuns: 1, maxQueuedWorkflowRuns: 10 },
  });

  const failing = tools.candidate_review?.execute?.({ n: 0 }, { toolCallId: "call_0" } as never);
  const second = tools.candidate_review?.execute?.({ n: 1 }, { toolCallId: "call_1" } as never);
  await nextTick();
  expect(secondStarted).toBe(false);

  release.resolve();
  await expect(failing).rejects.toThrow("workflow exploded");
  await expect(second).resolves.toMatchObject({ status: "completed", outputSummary: "Second ran." });
});
