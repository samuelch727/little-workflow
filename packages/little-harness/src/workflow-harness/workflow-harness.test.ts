import { createHash } from "node:crypto";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { hashHarnessPrompt } from "../events/durability.js";
import {
  canonicalHarnessEventRequestDigest,
  createHarnessAppendIdempotencyKey,
  type DurableHarnessEventInput,
  type PersistedDurableHarnessEvent,
} from "../events/occurrence.js";
import {
  createWorkflowHarness,
  runWorkflowHarnessWithSession,
  workflowHarness,
  type WorkflowHarnessContext,
  type WorkflowHarnessDurabilitySink,
  type WorkflowDurableHarnessEventType,
} from "./index.js";

type RecordedEvent = {
  readonly type: string;
  readonly runId: string;
  readonly occurrenceId?: string;
  readonly payload: Record<string, unknown>;
};

describe("workflowHarness", () => {
  it("exposes the default harness identity", () => {
    expect(workflowHarness.harnessId).toBe("workflowHarness@1.0.0");
  });

  it("wraps direct tool-call steps in workflow session and execution events", async () => {
    const events: RecordedEvent[] = [];
    const harness = createWorkflowHarness();

    const result = await runWorkflowHarnessWithSession(
      harness,
      {
        kind: "execute_step",
        step: { id: "lookup", uses: "tool.call", with: { tool: "lookup" } },
        stepInput: { id: "1" },
        stepContext: { stepPath: "lookup", visitIndex: 0 },
      },
      workflowHarnessTestContext({
        durability: recordDurability(events),
        tools: {
          lookup: {
            execute: async (input: unknown) => ({ input }),
          },
        },
      }),
    );

    expect(result).toEqual({
      kind: "execute_step",
      output: { input: { id: "1" } },
      artifactRefs: [],
    });
    expect(events.map((event) => event.type)).toEqual([
      "harness.session.started",
      "harness.execute_step.started",
      "harness.tool_call.started",
      "harness.tool_call.succeeded",
      "harness.execute_step.succeeded",
      "harness.session.completed",
    ]);
    expect(events.every((event) => event.runId === "run_test")).toBe(true);
    expect(events[0]?.payload).toMatchObject({
      runId: "run_test",
      role: "worker.tool-call",
      task: { kind: "execute_step" },
      manifestHash: "sha256:test",
    });
    expect(events).not.toContainEqual(expect.objectContaining({ type: "harness.model.called" }));
  });

  it("passes workflow runtime context to direct tool-call execution without storing it in replay scope", async () => {
    const events: RecordedEvent[] = [];
    const harness = createWorkflowHarness();
    const signal = new AbortController().signal;
    let receivedOptions: Record<string, unknown> | undefined;
    const runtimeContext = {
      runId: "run_test",
      workflowVersionId: "wv_test",
      step: { id: "lookup", output: { mode: "object" } },
      stepPath: "review[a].lookup",
      attempt: 2,
      input: { id: "a" },
      branchPath: "review[a]",
      hasItem: true,
      item: { id: "a" },
      resumingAttempt: true,
      signal,
    };

    await runWorkflowHarnessWithSession(
      harness,
      {
        kind: "execute_step",
        step: { id: "lookup", uses: "tool.call", with: { tool: "lookup" } },
        stepInput: { id: "a" },
        stepContext: {
          stepPath: "review[a].lookup",
          visitIndex: 0,
          attempt: 2,
          toolCallScope: { branchPath: "review[a]", hasItem: true, resumingAttempt: true },
          toolExecutionContext: runtimeContext,
        },
      },
      workflowHarnessTestContext({
        durability: recordDurability(events),
        tools: {
          lookup: {
            execute: async (_input: unknown, options: Record<string, unknown>) => {
              receivedOptions = options;
              return { ok: true };
            },
          },
        },
      }),
    );

    expect(receivedOptions).toMatchObject({
      runId: "run_test",
      workflowVersionId: "wv_test",
      stepPath: "review[a].lookup",
      attempt: 2,
      branchPath: "review[a]",
      hasItem: true,
      item: { id: "a" },
      resumingAttempt: true,
      caller: "code",
    });
    expect(receivedOptions?.signal).toBe(signal);
    expect(receivedOptions?.abortSignal).toBe(signal);
    expect(receivedOptions?.context).toBe(runtimeContext);
    const started = events.find((event) => event.type === "harness.tool_call.started");
    expect(started?.payload.scope).toEqual({
      stepPath: "review[a].lookup",
      visitIndex: 0,
      attempt: 2,
      branchPath: "review[a]",
      hasItem: true,
      resumingAttempt: true,
    });
    expect((started?.payload.scope as Record<string, unknown> | undefined)?.step).toBeUndefined();
    expect((started?.payload.scope as Record<string, unknown> | undefined)?.signal).toBeUndefined();
  });

  it("preserves undefined direct tool output while writing event-safe payloads", async () => {
    const events: RecordedEvent[] = [];
    const harness = createWorkflowHarness();

    const result = await runWorkflowHarnessWithSession(
      harness,
      {
        kind: "execute_step",
        step: { id: "lookup", uses: "tool.call", with: { tool: "lookup" } },
        stepInput: { id: "1" },
        stepContext: { stepPath: "lookup", visitIndex: 0, attempt: 1 },
      },
      workflowHarnessTestContext({
        durability: recordDurability(events),
        tools: {
          lookup: {
            execute: async () => undefined,
          },
        },
      }),
    );

    expect(result.kind).toBe("execute_step");
    if (result.kind !== "execute_step") {
      throw new Error("Expected execute_step result.");
    }
    expect(Object.hasOwn(result, "output")).toBe(true);
    expect(result.output).toBeUndefined();
    const succeeded = events.find((event) => event.type === "harness.tool_call.succeeded");
    expect(succeeded?.payload).toMatchObject({
      result: null,
      resultUndefined: true,
    });
    const completed = events.find((event) => event.type === "harness.session.completed");
    expect(JSON.stringify(completed?.payload)).not.toContain("undefined");
  });

  it("enforces deny and ask permissions before direct tool execution", async () => {
    let calls = 0;
    const harness = createWorkflowHarness();
    const task = {
      kind: "execute_step" as const,
      step: { id: "lookup", uses: "tool.call" as const, with: { tool: "lookup" } },
      stepInput: { id: "1" },
      stepContext: { stepPath: "lookup", visitIndex: 0 },
    };
    const tools = {
      lookup: {
        execute: async () => {
          calls += 1;
          return { ok: true };
        },
      },
    };

    await expect(
      harness.run(
        task,
        workflowHarnessTestContext({
          tools,
          permissions: { ruleset: [{ tool: "lookup", action: "deny" }] },
        }),
      ),
    ).rejects.toThrow(/denied/i);

    await expect(
      harness.run(
        task,
        workflowHarnessTestContext({
          tools,
          permissions: { ruleset: [{ tool: "lookup", action: "ask" }] },
        }),
      ),
    ).rejects.toThrow(/approval/i);

    await expect(
      harness.run(
        task,
        workflowHarnessTestContext({
          tools,
          permissions: {
            ruleset: [{ tool: "lookup", action: "ask" }],
            onAsk: async () => false,
          },
        }),
      ),
    ).rejects.toThrow(/declined/i);

    expect(calls).toBe(0);
  });

  it("matches permission rules as globs over the tool name", async () => {
    let calls = 0;
    const harness = createWorkflowHarness();
    const taskFor = (tool: string) => ({
      kind: "execute_step" as const,
      step: { id: tool, uses: "tool.call" as const, with: { tool } },
      stepInput: { id: "1" },
      stepContext: { stepPath: tool, visitIndex: 0 },
    });
    const tools = {
      delete_record: {
        execute: async () => {
          calls += 1;
          return { ok: true };
        },
      },
      lookup: {
        execute: async () => {
          calls += 1;
          return { ok: true };
        },
      },
    };

    // "delete_*" denies delete_record; the "*" allow rule does not override deny.
    await expect(
      harness.run(
        taskFor("delete_record"),
        workflowHarnessTestContext({
          tools,
          permissions: {
            ruleset: [
              { tool: "*", action: "allow" },
              { tool: "delete_*", action: "deny" },
            ],
          },
        }),
      ),
    ).rejects.toThrow(/denied/i);
    expect(calls).toBe(0);

    // A non-matching glob leaves other tools allowed.
    const allowed = await harness.run(
      taskFor("lookup"),
      workflowHarnessTestContext({
        tools,
        permissions: { ruleset: [{ tool: "delete_*", action: "deny" }] },
      }),
    );
    expect(allowed).toBeDefined();
    expect(calls).toBe(1);

    // "*" ask applies to every tool and fails closed without onAsk.
    await expect(
      harness.run(
        taskFor("lookup"),
        workflowHarnessTestContext({
          tools,
          permissions: { ruleset: [{ tool: "*", action: "ask" }] },
        }),
      ),
    ).rejects.toThrow(/approval/i);
    expect(calls).toBe(1);
  });

  it("records session failure without marking a failed step as succeeded", async () => {
    const events: RecordedEvent[] = [];
    const harness = createWorkflowHarness();

    await expect(
      runWorkflowHarnessWithSession(
        harness,
        {
          kind: "execute_step",
          step: { id: "lookup", uses: "tool.call", with: { tool: "lookup" } },
          stepInput: { id: "1" },
          stepContext: { stepPath: "lookup", visitIndex: 0 },
        },
        workflowHarnessTestContext({
          durability: recordDurability(events),
          tools: {
            lookup: {
              execute: async () => {
                throw new Error("lookup failed");
              },
            },
          },
        }),
      ),
    ).rejects.toThrow("lookup failed");

    expect(events.map((event) => event.type)).toEqual([
      "harness.session.started",
      "harness.execute_step.started",
      "harness.tool_call.started",
      "harness.tool_call.failed",
      "harness.session.failed",
    ]);
    expect(events.at(-1)?.payload).toMatchObject({
      runId: "run_test",
      error: { name: "Error", message: "lookup failed" },
    });
  });

  it("replays completed direct tool results without executing the tool again", async () => {
    const events: RecordedEvent[] = [];
    let calls = 0;
    const prior = [
      persistedEvent(1, "harness.tool_call.started", {
        callId: "call_replay",
        caller: "code",
        toolName: "lookup",
        args: { id: "1" },
        scope: { stepPath: "lookup", visitIndex: 0 },
      }),
      persistedEvent(2, "harness.tool_call.succeeded", {
        callId: "call_replay",
        caller: "code",
        toolName: "lookup",
        args: { id: "1" },
        result: { input: { id: "1" }, replayed: true },
        scope: { stepPath: "lookup", visitIndex: 0 },
      }),
    ];

    const result = await createWorkflowHarness().run(
      {
        kind: "execute_step",
        step: { id: "lookup", uses: "tool.call", with: { tool: "lookup" } },
        stepInput: { id: "1" },
        stepContext: { stepPath: "lookup", visitIndex: 0 },
      },
      workflowHarnessTestContext({
        durability: {
          ...recordDurability(events),
          priorEvents: async () => prior,
        },
        tools: {
          lookup: {
            execute: async () => {
              calls += 1;
              return { replayed: false };
            },
          },
        },
      }),
    );

    expect(result).toEqual({
      kind: "execute_step",
      output: { input: { id: "1" }, replayed: true },
      artifactRefs: [],
    });
    expect(calls).toBe(0);
    expect(events.map((event) => event.type)).toEqual([
      "harness.execute_step.started",
      "harness.execute_step.succeeded",
    ]);
  });

  it("continues inflight direct tool calls with the recorded occurrence id", async () => {
    const events: RecordedEvent[] = [];
    const prior = [
      persistedEvent(1, "harness.tool_call.started", {
        callId: "call_inflight_tool",
        caller: "code",
        toolName: "lookup",
        args: { id: "1" },
        callIndex: 1,
        scope: { stepPath: "lookup", visitIndex: 0 },
      }, "occ_tool_inflight"),
    ];

    const result = await createWorkflowHarness().run(
      {
        kind: "execute_step",
        step: { id: "lookup", uses: "tool.call", with: { tool: "lookup" } },
        stepInput: { id: "1" },
        stepContext: { stepPath: "lookup", visitIndex: 0 },
      },
      workflowHarnessTestContext({
        durability: {
          ...recordDurability(events),
          priorEvents: async () => prior,
        },
        tools: {
          lookup: {
            execute: async () => ({ ok: true }),
          },
        },
      }),
    );

    expect(result).toEqual({
      kind: "execute_step",
      output: { ok: true },
      artifactRefs: [],
    });
    expect(events.map((event) => event.type)).toEqual([
      "harness.execute_step.started",
      "harness.tool_call.succeeded",
      "harness.execute_step.succeeded",
    ]);
    expect(events[1]).toMatchObject({
      occurrenceId: "occ_tool_inflight",
      payload: { callId: "call_inflight_tool" },
    });
  });

  it("emits model events for ai.generate steps handled by an aiLoop", async () => {
    const events: RecordedEvent[] = [];
    const harness = createWorkflowHarness({
      aiLoop: {
        generate: async () => ({
          text: "done",
          output: "done",
          usage: { inputTokens: 1, outputTokens: 1 },
        }),
      },
    });

    const result = await runWorkflowHarnessWithSession(
      harness,
      {
        kind: "execute_step",
        step: { id: "draft", uses: "ai.generate", with: { model: "worker" } },
        stepInput: { prompt: "Draft." },
        stepContext: { stepPath: "draft", visitIndex: 0 },
      },
      workflowHarnessTestContext({ durability: recordDurability(events) }),
    );

    expect(result).toMatchObject({ kind: "execute_step", output: "done" });
    expect(events.map((event) => event.type).filter((type) => type === "harness.session.started")).toHaveLength(1);
    expect(events.map((event) => event.type).filter((type) => type === "harness.session.completed")).toHaveLength(1);
    expect(events).toContainEqual(expect.objectContaining({ type: "harness.model.called", runId: "run_test" }));
    expect(events).toContainEqual(expect.objectContaining({ type: "harness.model.responded", runId: "run_test" }));
    expect(events.find((event) => event.type === "harness.session.completed")?.payload.usage).toEqual({
      // Session rollup is token-only: cost is derived downstream from the model registry,
      // which this package cannot see (little-workflow depends on it, not the reverse).
      inputTokens: 1,
      outputTokens: 1,
      cachedInputTokens: 0,
      reasoningTokens: 0,
    });
  });

  it("includes mounted skills in ai.generate model prompts", async () => {
    let seenSystem: string | undefined;
    const harness = createWorkflowHarness({
      aiLoop: {
        generate: async ({ system }) => {
          seenSystem = system;
          return { output: "done" };
        },
      },
    });

    await harness.run(
      {
        kind: "execute_step",
        step: { id: "draft", uses: "ai.generate", with: { model: "worker" } },
        stepInput: { prompt: "Draft." },
        stepContext: { stepPath: "draft", visitIndex: 0 },
      },
      workflowHarnessTestContext({
        system: "Custom worker instructions.",
        skills: [{
          name: "worker-guide",
          description: "Use for worker tasks.",
          bodyPath: "/tmp/worker-guide/SKILL.md",
        }],
      }),
    );

    expect(seenSystem).toContain("Custom worker instructions.");
    expect(seenSystem).toContain("<available_skills>");
    expect(seenSystem).toContain("<name>worker-guide</name>");
    expect(seenSystem).toContain("<description>Use for worker tasks.</description>");
    expect(seenSystem).toContain("<read>cat .agents/skills/worker-guide/SKILL.md</read>");
    expect(seenSystem?.match(/<available_skills>/gu)).toHaveLength(1);
  });

  it("surfaces step.with.outputRepairNote into the ai.generate model messages", async () => {
    let seenMessages: unknown;
    const harness = createWorkflowHarness({
      aiLoop: {
        generate: async ({ messages }) => {
          seenMessages = messages;
          return { output: { value: 42 } };
        },
      },
    });

    await harness.run(
      {
        kind: "execute_step",
        step: {
          id: "draft",
          uses: "ai.generate",
          with: {
            model: "worker",
            outputRepairNote: '[OUTPUT REPAIR] rejected; required schema: {"required":["value"]}',
          },
        },
        stepInput: { prompt: "Draft." },
        stepContext: { stepPath: "draft", visitIndex: 0 },
      },
      workflowHarnessTestContext({}),
    );

    // The repair note must reach the model — it is the entire point of self-repair.
    const serialized = JSON.stringify(seenMessages);
    expect(serialized).toContain("[OUTPUT REPAIR]");
    expect(serialized).toContain("required");
  });

  it("does NOT offer workflow tools to a structured-output ai.generate step (so the model produces the object, not a tool call)", async () => {
    let seenTools: Record<string, unknown> | undefined;
    const harness = createWorkflowHarness({
      aiLoop: {
        generate: async ({ tools }) => {
          seenTools = tools as Record<string, unknown>;
          return { output: { value: 1 } };
        },
      },
    });

    await harness.run(
      {
        kind: "execute_step",
        step: {
          id: "summarize",
          uses: "ai.generate",
          with: { model: "worker" },
          output: { mode: "object", schema: { type: "object" } },
        },
        stepInput: { data: "x" },
        stepContext: { stepPath: "summarize", visitIndex: 0 },
      },
      workflowHarnessTestContext({
        tools: {
          issueRefund: { execute: async () => ({ ok: true }) },
          lookupOrder: { execute: async () => ({ ok: true }) },
        },
      }),
    );

    // A structured-output generation step must produce its declared output from its input —
    // offering it the workflow's action tools invites a spurious tool call that ends the
    // generation with empty output (and could re-fire a side-effecting tool like issueRefund).
    expect(Object.keys(seenTools ?? {})).toHaveLength(0);
  });

  it("does not offer workflow tools to a free-text ai.generate step either (nothing executes the call)", async () => {
    let seenTools: Record<string, unknown> | undefined;
    const harness = createWorkflowHarness({
      aiLoop: {
        generate: async ({ tools }) => {
          seenTools = tools as Record<string, unknown>;
          return { text: "ok" };
        },
      },
    });

    await harness.run(
      {
        kind: "execute_step",
        step: { id: "letter", uses: "ai.generate", with: { model: "worker" } },
        stepInput: { data: "x" },
        stepContext: { stepPath: "letter", visitIndex: 0 },
      },
      workflowHarnessTestContext({
        tools: { recordDecision: { execute: async () => ({ ok: true }) } },
      }),
    );

    // ai.generate is a single model call: a tool call the model makes here is never executed and
    // only ends the step with empty text. Side effects belong in explicit tool.call steps.
    expect(seenTools).toEqual({});
  });

  it("keeps ctx.bash out of ai.generate steps but offers it to planner tasks", async () => {
    const events: RecordedEvent[] = [];
    const seenTools: Record<string, Record<string, unknown>> = {};
    const harness = createWorkflowHarness({
      aiLoop: {
        generate: async ({ tools, step }) => {
          const isPlan = (step as { kind?: unknown } | undefined)?.kind === "plan";
          seenTools[isPlan ? "plan" : "draft"] = tools;
          return isPlan
            ? { output: { lwir: { steps: [] } } }
            : { output: "done", usage: { inputTokens: 1, outputTokens: 1 } };
        },
      },
    });
    const ctx = workflowHarnessTestContext({ durability: recordDurability(events) }) as
      WorkflowHarnessContext & { bash: { execute: () => Promise<{ stdout: string; exitCode: number }> } };
    ctx.bash = { execute: async () => ({ stdout: "ok", exitCode: 0 }) };

    await runWorkflowHarnessWithSession(
      harness,
      {
        kind: "execute_step",
        step: { id: "draft", uses: "ai.generate", with: { model: "worker" } },
        stepInput: { prompt: "Draft." },
        stepContext: { stepPath: "draft", visitIndex: 0 },
      },
      ctx,
    );
    await harness.run(
      {
        kind: "plan",
        workflowSnapshot: {
          id: "test.workflow",
          description: "Test workflow",
          inputSchema: true,
          outputSchema: true,
          workflowDefinitionHash: "sha256:test",
        },
        input: {},
      },
      ctx,
    );

    expect(seenTools.draft).toEqual({});
    const modelCalled = events.find((event) => event.type === "harness.model.called");
    expect((modelCalled?.payload.request as { tools?: unknown[] } | undefined)?.tools).toEqual([]);
    expect(Object.keys(seenTools.plan ?? {})).toContain("bash");
  });

  it("appends an ai.generate step's with.system after the worker system", async () => {
    const events: RecordedEvent[] = [];
    let seenSystem: string | undefined;
    const harness = createWorkflowHarness({
      aiLoop: {
        generate: async ({ system }) => {
          seenSystem = system;
          return { text: "ok" };
        },
      },
    });

    await runWorkflowHarnessWithSession(
      harness,
      {
        kind: "execute_step",
        step: {
          id: "underwrite",
          uses: "ai.generate",
          with: { model: "worker", system: "You are a cautious underwriter." },
        },
        stepInput: { applicant: "A-1" },
        stepContext: { stepPath: "underwrite", visitIndex: 0 },
      },
      workflowHarnessTestContext({
        system: "Worker system.",
        durability: recordDurability(events),
      }),
    );

    expect(seenSystem).toBe("Worker system.\n\nYou are a cautious underwriter.");
    const modelCalled = events.find((event) => event.type === "harness.model.called");
    expect((modelCalled?.payload.request as { system?: string } | undefined)?.system)
      .toBe("Worker system.\n\nYou are a cautious underwriter.");
  });

  it("does not backfill prior model usage into sessions that emit no model responses", async () => {
    const events: RecordedEvent[] = [];
    const harness = createWorkflowHarness();

    const result = await runWorkflowHarnessWithSession(
      harness,
      {
        kind: "execute_step",
        step: { id: "lookup", uses: "tool.call", with: { tool: "lookup" } },
        stepInput: { id: "1" },
        stepContext: { stepPath: "lookup", visitIndex: 0 },
      },
      workflowHarnessTestContext({
        durability: {
          ...recordDurability(events),
          priorEvents: async () => [
            persistedEvent(1, "harness.model.responded", {
              turn: 1,
              response: {
                text: "prior",
                usage: { inputTokens: 10, outputTokens: 5 },
              },
            }),
          ],
        },
        tools: {
          lookup: {
            execute: async () => ({ ok: true }),
          },
        },
      }),
    );

    expect(result).toMatchObject({ kind: "execute_step", output: { ok: true } });
    expect(events.find((event) => event.type === "harness.session.completed")?.payload.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
    });
  });

  it("replays completed ai.generate responses without calling the model loop again", async () => {
    const events: RecordedEvent[] = [];
    let calls = 0;
    const step = { id: "draft", uses: "ai.generate" as const, with: { model: "worker" } };
    const messages = [{ role: "user", content: { prompt: "Draft." } }];
    const request = {
      model: "test-model",
      system: "",
      messages,
      tools: [],
      scope: { stepPath: "draft", visitIndex: 0 },
      step,
    };
    const prior = [
      persistedEvent(1, "harness.model.called", {
        callId: "call_model_replay",
        turn: 1,
        promptHash: hashHarnessPrompt(request),
        request,
      }),
      persistedEvent(2, "harness.model.responded", {
        callId: "call_model_replay",
        turn: 1,
        response: {
          text: "replayed",
          output: { replayed: true },
          usage: { inputTokens: 1, outputTokens: 1 },
        },
      }),
    ];

    const result = await createWorkflowHarness({
      aiLoop: {
        generate: async () => {
          calls += 1;
          return { output: { replayed: false } };
        },
      },
    }).run(
      {
        kind: "execute_step",
        step,
        stepInput: { prompt: "Draft." },
        stepContext: { stepPath: "draft", visitIndex: 0 },
      },
      workflowHarnessTestContext({
        durability: {
          ...recordDurability(events),
          priorEvents: async () => prior,
        },
      }),
    );

    expect(result).toEqual({
      kind: "execute_step",
      output: { replayed: true },
      artifactRefs: [],
    });
    expect(calls).toBe(0);
    expect(events.map((event) => event.type)).toEqual([
      "harness.execute_step.started",
      "harness.execute_step.succeeded",
    ]);
  });

  it("continues inflight ai.generate calls with the recorded turn and occurrence id", async () => {
    const events: RecordedEvent[] = [];
    const step = { id: "draft", uses: "ai.generate" as const, with: { model: "worker" } };
    const messages = [{ role: "user", content: { prompt: "Draft." } }];
    const request = {
      model: "test-model",
      system: "",
      messages,
      tools: [],
      scope: { stepPath: "draft", visitIndex: 0 },
      step,
    };
    const prior = [
      persistedEvent(1, "harness.model.called", {
        callId: "call_inflight_model",
        turn: 4,
        promptHash: hashHarnessPrompt(request),
        request,
      }, "occ_model_inflight"),
    ];

    const result = await createWorkflowHarness({
      aiLoop: {
        generate: async () => ({ output: { ok: true } }),
      },
    }).run(
      {
        kind: "execute_step",
        step,
        stepInput: { prompt: "Draft." },
        stepContext: { stepPath: "draft", visitIndex: 0 },
      },
      workflowHarnessTestContext({
        durability: {
          ...recordDurability(events),
          priorEvents: async () => prior,
        },
      }),
    );

    expect(result).toEqual({
      kind: "execute_step",
      output: { ok: true },
      artifactRefs: [],
    });
    expect(events.map((event) => event.type)).toEqual([
      "harness.execute_step.started",
      "harness.model.responded",
      "harness.execute_step.succeeded",
    ]);
    expect(events[1]).toMatchObject({
      occurrenceId: "occ_model_inflight",
      payload: { callId: "call_inflight_model", turn: 4 },
    });
  });

  it("does not replay ai.generate responses when the current tool contract differs", async () => {
    const events: RecordedEvent[] = [];
    let calls = 0;
    const step = { id: "draft", uses: "ai.generate" as const, with: { model: "worker" } };
    const messages = [{ role: "user", content: { prompt: "Draft." } }];
    const staleRequest = {
      model: "test-model",
      system: "",
      messages,
      tools: [{ toolName: "lookup" }],
      scope: { stepPath: "draft", visitIndex: 0 },
      step,
    };
    const prior = [
      persistedEvent(1, "harness.model.called", {
        callId: "call_stale_tool_contract",
        turn: 1,
        promptHash: hashHarnessPrompt(staleRequest),
        request: staleRequest,
      }),
      persistedEvent(2, "harness.model.responded", {
        callId: "call_stale_tool_contract",
        turn: 1,
        response: { output: { replayed: true }, text: "stale" },
      }),
    ];

    const result = await createWorkflowHarness({
      aiLoop: {
        generate: async () => {
          calls += 1;
          return { output: { replayed: false }, text: "fresh" };
        },
      },
    }).run(
      {
        kind: "execute_step",
        step,
        stepInput: { prompt: "Draft." },
        stepContext: { stepPath: "draft", visitIndex: 0 },
      },
      workflowHarnessTestContext({
        durability: {
          ...recordDurability(events),
          priorEvents: async () => prior,
        },
        tools: {
          lookup: {
            description: "New lookup contract",
            inputSchema: {
              type: "object",
              properties: { id: { type: "string" } },
              required: ["id"],
            },
            execute: async () => ({ ok: true }),
          },
        },
      }),
    );

    expect(result).toEqual({
      kind: "execute_step",
      output: { replayed: false },
      artifactRefs: [],
    });
    expect(calls).toBe(1);
    expect(events.map((event) => event.type)).toEqual([
      "harness.execute_step.started",
      "harness.model.called",
      "harness.model.responded",
      "harness.execute_step.succeeded",
    ]);
  });

  it("fails closed for pinned code.run steps under denied sandbox policies", async () => {
    const events: RecordedEvent[] = [];
    const source = "export default async function main() { return { leaked: process.env.PATH }; }";
    const harness = createWorkflowHarness();

    await expect(
      harness.run(
        {
          kind: "execute_step",
          step: {
            id: "compute",
            uses: "code.run",
            with: {
              entrypoint: "main.ts",
              files: { "main.ts": codeRunFile(source) },
              sandbox: { network: "deny", env: "deny", fs: "deny" },
            },
          },
          stepInput: { ticketId: "TIN-8" },
          stepContext: { stepPath: "compute", visitIndex: 0 },
        },
        workflowHarnessTestContext({ durability: recordDurability(events) }),
      ),
    ).rejects.toThrow(/cannot safely execute code\.run/i);
    expect(events.map((event) => event.type)).toEqual([
      "harness.execute_step.started",
    ]);
  });

  it("blocks code.run entrypoints before node:fs imports can execute", async () => {
    const events: RecordedEvent[] = [];
    const source = [
      "import { readFileSync } from 'node:fs';",
      "export default async function main() {",
      "  return { passwd: readFileSync('/etc/passwd', 'utf8') };",
      "}",
    ].join("\n");
    const harness = createWorkflowHarness();

    await expect(
      harness.run(
        {
          kind: "execute_step",
          step: {
            id: "compute",
            uses: "code.run",
            with: {
              entrypoint: "main.ts",
              files: { "main.ts": codeRunFile(source) },
              sandbox: { network: "deny", env: "deny", fs: "deny" },
            },
          },
          stepInput: {},
          stepContext: { stepPath: "compute", visitIndex: 0 },
        },
        workflowHarnessTestContext({ durability: recordDurability(events) }),
      ),
    ).rejects.toThrow(/cannot safely execute code\.run/i);

    expect(events.map((event) => event.type)).toEqual([
      "harness.execute_step.started",
    ]);
  });

  it("blocks legacy code.run source before network globals can execute", async () => {
    const events: RecordedEvent[] = [];
    const source = "async () => fetch('https://example.com')";
    const harness = createWorkflowHarness();

    await expect(
      harness.run(
        {
          kind: "execute_step",
          step: {
            id: "compute",
            uses: "code.run",
            with: {
              source,
              entrypoint: "main.ts",
              files: { "main.ts": codeRunFile(source) },
              sandbox: { network: "deny", env: "deny", fs: "deny" },
            },
          },
          stepInput: {},
          stepContext: { stepPath: "compute", visitIndex: 0 },
        },
        workflowHarnessTestContext({ durability: recordDurability(events) }),
      ),
    ).rejects.toThrow(/cannot safely execute code\.run/i);

    expect(events.map((event) => event.type)).toEqual([
      "harness.execute_step.started",
    ]);
  });

  it("rejects unsupported code.run sandbox policies before running guest code", async () => {
    const events: RecordedEvent[] = [];
    const source = "export default async function main() { return { shouldNotRun: true }; }";

    await expect(
      createWorkflowHarness().run(
        {
          kind: "execute_step",
          step: {
            id: "compute",
            uses: "code.run",
            with: {
              entrypoint: "main.ts",
              files: { "main.ts": codeRunFile(source) },
              sandbox: { network: "allow" } as never,
            },
          },
          stepInput: { ticketId: "TIN-8" },
          stepContext: { stepPath: "compute", visitIndex: 0 },
        },
        workflowHarnessTestContext({
          durability: recordDurability(events),
        }),
      ),
    ).rejects.toThrow(/sandbox/i);

    expect(events.map((event) => event.type)).toEqual([
      "harness.execute_step.started",
    ]);
  });

  it("uses the default AI SDK bridge when no aiLoop is configured", async () => {
    await expect(
      createWorkflowHarness().run(
        {
          kind: "execute_step",
          step: { id: "draft", uses: "ai.generate", with: { model: "worker" } },
          stepInput: { prompt: "Draft." },
          stepContext: { stepPath: "draft", visitIndex: 0 },
        },
        workflowHarnessTestContext(),
      ),
    ).rejects.toThrow(/Unsupported model version|model/i);
  });

  it("emits model events for plan tasks handled by an aiLoop", async () => {
    const events: RecordedEvent[] = [];
    const harness = createWorkflowHarness({
      aiLoop: {
        generate: async () => ({
          output: { steps: [{ id: "draft", uses: "ai.generate" }] },
          usage: { inputTokens: 2, outputTokens: 3 },
        }),
      },
    });

    const result = await harness.run(
      {
        kind: "plan",
        workflowSnapshot: {
          id: "test.workflow",
          description: "Test workflow",
          inputSchema: true,
          outputSchema: true,
          workflowDefinitionHash: "sha256:test",
        },
        input: { ticketId: "TIN-8" },
      },
      workflowHarnessTestContext({ durability: recordDurability(events) }),
    );

    expect(result).toEqual({
      kind: "plan",
      lwir: { steps: [{ id: "draft", uses: "ai.generate" }] },
    });
    expect(events.map((event) => event.type)).toEqual([
      "harness.model.called",
      "harness.model.responded",
    ]);
    expect(events[0]?.payload).toMatchObject({
      callId: expect.any(String),
      turn: 1,
      request: {
        model: "test-model",
        scope: { role: "worker.tool-call" },
        task: { kind: "plan" },
      },
    });
  });

  it("includes mounted skills in model-like prompts without dropping task system messages", async () => {
    let seenSystem: string | undefined;
    let seenMessages: readonly unknown[] = [];
    const harness = createWorkflowHarness({
      aiLoop: {
        generate: async ({ system, messages }) => {
          seenSystem = system;
          seenMessages = messages;
          return { output: { lwir: { steps: [] } } };
        },
      },
    });

    await harness.run(
      {
        kind: "plan",
        workflowSnapshot: {
          id: "test.workflow",
          description: "Test workflow",
          inputSchema: true,
          outputSchema: true,
          workflowDefinitionHash: "sha256:test",
        },
        input: { ticketId: "TIN-8" },
        systemMessage: "Planner-specific instructions.",
      },
      workflowHarnessTestContext({
        system: "Base planner instructions.",
        skills: [{
          name: "planner-guide",
          description: "Use for planning.",
          bodyPath: "/tmp/planner-guide/SKILL.md",
        }],
      }),
    );

    expect(seenSystem).toContain("Base planner instructions.");
    expect(seenSystem).toContain("Planner-specific instructions.");
    expect(seenSystem).toContain("<available_skills>");
    expect(seenSystem).toContain("<name>planner-guide</name>");
    expect(seenSystem).toContain("<read>cat .agents/skills/planner-guide/SKILL.md</read>");
    expect(seenSystem?.match(/<available_skills>/gu)).toHaveLength(1);
    // The planning instructions travel once, in the system prompt, not again in the user message.
    expect(JSON.stringify(seenMessages)).not.toContain("Planner-specific instructions.");
    expect(JSON.stringify(seenMessages)).toContain("TIN-8");
  });

  it("unwraps planner aiLoop outputs shaped as { lwir }", async () => {
    const harness = createWorkflowHarness({
      aiLoop: {
        generate: async () => ({
          output: { lwir: { steps: [{ id: "draft", uses: "ai.generate" }] } },
        }),
      },
    });

    await expect(
      harness.run(
        {
          kind: "plan",
          workflowSnapshot: {
            id: "test.workflow",
            description: "Test workflow",
            inputSchema: true,
            outputSchema: true,
            workflowDefinitionHash: "sha256:test",
          },
          input: { ticketId: "TIN-8" },
        },
        workflowHarnessTestContext(),
      ),
    ).resolves.toEqual({
      kind: "plan",
      lwir: { steps: [{ id: "draft", uses: "ai.generate" }] },
    });
  });

  it("uses aiSdkModule as the model loop when no aiLoop is configured", async () => {
    const events: RecordedEvent[] = [];
    const calls: unknown[] = [];
    const aiSdkModule = {
      generateText: async (request: unknown) => {
        calls.push(request);
        return {
          output: { lwir: { steps: [{ id: "draft", uses: "ai.generate" }] } },
          usage: { inputTokens: 3, outputTokens: 4 },
        };
      },
      Output: {
        text: () => ({ mode: "text" }),
        object: (options?: unknown) => ({ mode: "object", options }),
        array: (options?: unknown) => ({ mode: "array", options }),
        choice: (options?: unknown) => ({ mode: "choice", options }),
        json: (options?: unknown) => ({ mode: "json", options }),
      },
      jsonSchema: (schema: unknown) => ({ wrapped: schema }),
    };
    const harness = createWorkflowHarness({ aiSdkModule });

    const result = await harness.run(
      {
        kind: "plan",
        workflowSnapshot: {
          id: "test.workflow",
          description: "Test workflow",
          inputSchema: true,
          outputSchema: true,
          workflowDefinitionHash: "sha256:test",
        },
        input: { ticketId: "TIN-8" },
      },
      workflowHarnessTestContext({ durability: recordDurability(events) }),
    );

    expect(result).toEqual({
      kind: "plan",
      lwir: { steps: [{ id: "draft", uses: "ai.generate" }] },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      model: { provider: "test", modelId: "test-model" },
      output: { mode: "text" },
    });
    expect(events.map((event) => event.type)).toEqual([
      "harness.model.called",
      "harness.model.responded",
    ]);
  });

  it("sends a failed planner tool call to an AI SDK model as an error tool result", async () => {
    const calls: Array<{ readonly messages?: readonly unknown[] }> = [];
    const aiSdkModule = {
      generateText: async (request: { readonly messages?: readonly unknown[] }) => {
        calls.push(request);
        return calls.length === 1
          ? { text: "", toolCalls: [{ toolName: "bash", toolCallId: "call_1", input: {} }] }
          : { text: JSON.stringify({ steps: [{ id: "draft", uses: "ai.generate" }] }) };
      },
      Output: { text: () => ({ mode: "text" }) },
      jsonSchema: (schema: unknown) => ({ wrapped: schema }),
    };
    const harness = createWorkflowHarness({ aiSdkModule });

    await harness.run(
      {
        kind: "plan",
        workflowSnapshot: {
          id: "test.workflow",
          description: "Test workflow",
          inputSchema: true,
          outputSchema: true,
          workflowDefinitionHash: "sha256:test",
        },
        input: { ticketId: "TIN-8" },
      },
      workflowHarnessTestContext({
        tools: {
          bash: {
            execute: async () => {
              throw new Error("bash needs a `cmd`.");
            },
          },
        },
      }),
    );

    expect(calls[1]?.messages?.at(-1)).toEqual({
      role: "tool",
      content: [{
        type: "tool-result",
        toolCallId: "call_1",
        toolName: "bash",
        output: { type: "error-text", value: "Error: bash needs a `cmd`." },
      }],
    });
  });

  it("continues planner model-like tasks after tool calls", async () => {
    const events: RecordedEvent[] = [];
    const generate = async () => {
      if (events.some((event) => event.type === "harness.tool_call.succeeded")) {
        return { output: { lwir: { steps: [{ id: "draft", uses: "ai.generate" }] } } };
      }
      return {
        toolCalls: [
          {
            toolName: "bash",
            args: { cmd: "printf planner-tool-output" },
            toolCallId: "call_bash",
          },
        ],
      };
    };
    const harness = createWorkflowHarness({ aiLoop: { generate } });

    const result = await harness.run(
      {
        kind: "plan",
        workflowSnapshot: {
          id: "test.workflow",
          description: "Test workflow",
          inputSchema: true,
          outputSchema: true,
          workflowDefinitionHash: "sha256:test",
        },
        input: { ticketId: "TIN-8" },
      },
      workflowHarnessTestContext({
        durability: recordDurability(events),
        tools: {
          bash: {
            execute: async () => ({ stdout: "planner-tool-output", exitCode: 0 }),
          },
        },
      }),
    );

    expect(result).toEqual({
      kind: "plan",
      lwir: { steps: [{ id: "draft", uses: "ai.generate" }] },
    });
    expect(events.map((event) => event.type)).toEqual([
      "harness.model.called",
      "harness.model.responded",
      "harness.tool_call.started",
      "harness.tool_call.succeeded",
      "harness.model.called",
      "harness.model.responded",
    ]);
    expect(events[2]?.payload).toMatchObject({
      caller: "model",
      toolName: "bash",
      args: { cmd: "printf planner-tool-output" },
      turn: 1,
      callIndex: 1,
    });
  });

  it("hands a failed planner tool call back to the model instead of failing the plan", async () => {
    const events: RecordedEvent[] = [];
    const seenMessages: unknown[][] = [];
    const generate = async ({ messages }: { readonly messages: readonly unknown[] }) => {
      seenMessages.push([...messages]);
      if (seenMessages.length === 1) {
        return {
          toolCalls: [
            { toolName: "bash", args: { command: "ls" }, toolCallId: "call_bad_args" },
            { toolName: "read_file", args: { path: "a.txt" }, toolCallId: "call_made_up" },
          ],
        };
      }
      return { output: { lwir: { steps: [{ id: "draft", uses: "ai.generate" }] } } };
    };
    const harness = createWorkflowHarness({ aiLoop: { generate } });

    const result = await harness.run(
      {
        kind: "plan",
        workflowSnapshot: {
          id: "test.workflow",
          description: "Test workflow",
          inputSchema: true,
          outputSchema: true,
          workflowDefinitionHash: "sha256:test",
        },
        input: { ticketId: "TIN-8" },
      },
      workflowHarnessTestContext({
        durability: recordDurability(events),
        tools: {
          bash: {
            execute: async (args: { readonly cmd?: unknown }) => {
              if (typeof args.cmd !== "string") throw new TypeError("bash needs a string `cmd`.");
              return { stdout: "", exitCode: 0 };
            },
          },
        },
      }),
    );

    expect(result).toEqual({ kind: "plan", lwir: { steps: [{ id: "draft", uses: "ai.generate" }] } });
    expect(events.map((event) => event.type)).toContain("harness.tool_call.failed");
    expect(seenMessages[1]?.at(-1)).toEqual({
      role: "tool",
      content: [
        {
          toolName: "bash",
          toolCallId: "call_bad_args",
          result: "TypeError: bash needs a string `cmd`.",
          isError: true,
        },
        {
          toolName: "read_file",
          toolCallId: "call_made_up",
          result: "There is no tool named 'read_file'. Available tools: bash.",
          isError: true,
        },
      ],
    });
  });

  it("runs the tools of an AI SDK planner turn that ends in tool calls with empty text", async () => {
    const events: RecordedEvent[] = [];
    const commands: unknown[] = [];
    const model = new MockLanguageModelV4({
      provider: "test",
      modelId: "planner",
      doStream: [
        mockModelStream([
          { type: "tool-call", toolCallId: "call_1", toolName: "bash", input: JSON.stringify({ cmd: "cat /planner/reuse/v1/lwir.json" }) },
          { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_use" }, usage: mockModelUsage },
        ]),
        mockModelTextStream(JSON.stringify({ steps: [{ id: "draft", uses: "ai.generate" }] })),
      ],
    });
    const ctx = workflowHarnessTestContext({
      durability: recordDurability(events),
      model: { slotId: "planner", providerId: "test", modelId: "planner", model },
    }) as WorkflowHarnessContext & { bash: unknown };
    ctx.bash = {
      inputSchema: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] },
      execute: async (input: unknown) => {
        commands.push(input);
        return { stdout: "{}", stderr: "", exitCode: 0 };
      },
    };

    const result = await createWorkflowHarness().run(harnessPlanTask(), ctx);

    expect(result).toEqual({ kind: "plan", lwir: { steps: [{ id: "draft", uses: "ai.generate" }] } });
    expect(commands).toEqual([{ cmd: "cat /planner/reuse/v1/lwir.json" }]);
    expect(model.doStreamCalls).toHaveLength(2);
    expect(events.map((event) => event.type)).toEqual([
      "harness.model.called",
      "harness.model.responded",
      "harness.tool_call.started",
      "harness.tool_call.succeeded",
      "harness.model.called",
      "harness.model.responded",
    ]);
  });

  it("asks an AI SDK planner for text and reads the LWIR out of a fenced reply", async () => {
    const lwir = { apiVersion: "littleworkflow.dev/v0.1", kind: "Workflow", steps: [{ id: "draft", uses: "ai.generate" }] };
    const model = new MockLanguageModelV4({
      provider: "test",
      modelId: "planner",
      doStream: mockModelTextStream(`Here is the plan.\n\n\`\`\`json\n${JSON.stringify(lwir, null, 2)}\n\`\`\``),
    });

    const result = await createWorkflowHarness().run(
      harnessPlanTask(),
      workflowHarnessTestContext({ model: { slotId: "planner", providerId: "test", modelId: "planner", model } }),
    );

    expect(result).toEqual({ kind: "plan", lwir });
    // An open object schema sent as native structured output only admits `{}` on Claude.
    expect(model.doStreamCalls).toHaveLength(1);
    expect(model.doStreamCalls[0]?.responseFormat?.type).not.toBe("json");
  });

  it("keeps a planner's adapt decision whole instead of unwrapping its lwir", async () => {
    const decision = {
      kind: "adapt",
      baseWorkflowVersionId: "wfv_1",
      rationale: "Add a letter step.",
      lwir: { steps: [{ id: "draft", uses: "ai.generate" }] },
    };
    const harness = createWorkflowHarness({ aiLoop: { generate: async () => ({ text: JSON.stringify(decision) }) } });

    await expect(harness.run(harnessPlanTask(), workflowHarnessTestContext())).resolves.toEqual({
      kind: "plan",
      lwir: decision,
    });
  });

  it("returns a planner reply with no JSON in it as text for the validator to reject", async () => {
    const harness = createWorkflowHarness({ aiLoop: { generate: async () => ({ text: "I could not plan this." }) } });

    await expect(harness.run(harnessPlanTask(), workflowHarnessTestContext())).resolves.toEqual({
      kind: "plan",
      lwir: "I could not plan this.",
    });
  });

  it("throws the model's own error from an AI SDK planner call instead of returning an empty draft", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const events: RecordedEvent[] = [];
      const model = new MockLanguageModelV4({
        provider: "test",
        modelId: "planner",
        doStream: async () => {
          throw new Error("529 overloaded_error");
        },
      });

      await expect(
        createWorkflowHarness().run(
          harnessPlanTask(),
          workflowHarnessTestContext({
            durability: recordDurability(events),
            model: { slotId: "planner", providerId: "test", modelId: "planner", model },
          }),
        ),
      ).rejects.toThrow("529 overloaded_error");
      expect(events.map((event) => event.type)).toEqual(["harness.model.called", "harness.model.failed"]);
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("sends no system prompt for an ai.generate step that has none", async () => {
    const model = new MockLanguageModelV4({ provider: "test", modelId: "worker", doStream: mockModelTextStream("Dear Ana,") });

    await createWorkflowHarness().run(
      {
        kind: "execute_step",
        step: { id: "letter", uses: "ai.generate", with: { model: "worker", prompt: "Write the letter." }, output: { mode: "text" } },
        stepInput: { applicantName: "Ana" },
        stepContext: { stepPath: "letter", visitIndex: 0 },
      },
      workflowHarnessTestContext({ model: { slotId: "worker", providerId: "test", modelId: "worker", model } }),
    );

    // Anthropic rejects an empty system block ("text content blocks must be non-empty").
    expect(model.doStreamCalls).toHaveLength(1);
    expect(model.doStreamCalls[0]?.prompt.filter((message) => message.role === "system")).toEqual([]);
  });

  it("throws an AI SDK error stream part from an ai.generate step even after partial text", async () => {
    const model = new MockLanguageModelV4({
      provider: "test",
      modelId: "worker",
      doStream: mockModelStream([
        { type: "text-start", id: "0" },
        { type: "text-delta", id: "0", delta: "partial" },
        { type: "error", error: new Error("stream reset by provider") },
      ]),
    });

    await expect(
      createWorkflowHarness().run(
        {
          kind: "execute_step",
          step: { id: "draft", uses: "ai.generate", with: { model: "worker" }, output: { mode: "text" } },
          stepInput: { prompt: "Draft." },
          stepContext: { stepPath: "draft", visitIndex: 0 },
        },
        workflowHarnessTestContext({
          model: { slotId: "worker", providerId: "test", modelId: "worker", model },
        }),
      ),
    ).rejects.toThrow("stream reset by provider");
  });

  it("adds deterministic subRunId to workflow run tool started events before execution", async () => {
    const events: RecordedEvent[] = [];
    let executedInput: unknown;
    let turn = 0;
    const harness = createWorkflowHarness({
      aiLoop: {
        generate: async () => {
          turn += 1;
          if (turn === 1) {
            return {
              usage: { inputTokens: 1, outputTokens: 1 },
              toolCalls: [{
                toolName: "start_workflow",
                args: { workflowId: "child.workflow", input: { id: "TIN-1" } },
              }],
            };
          }
          return {
            output: { ok: true },
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        },
      },
    });

    await runWorkflowHarnessWithSession(
      harness,
      {
        kind: "orchestrate",
        available: [],
        input: { request: "start child" },
      },
      workflowHarnessTestContext({
        durability: recordDurability(events),
        scope: {
          runId: "run_parent",
          logDir: "/tmp/little-harness-test",
          role: "orchestrator",
        },
        session: {
          runId: "run_parent",
          role: "orchestrator",
          task: { kind: "orchestrate" },
          manifest: { test: true },
          manifestHash: "sha256:test",
        },
        tools: {
          start_workflow: {
            execute: async (input: unknown) => {
              executedInput = input;
              return { runId: (input as { subRunId?: string }).subRunId, status: "completed" };
            },
          },
        },
      }),
    );

    const started = events.find((event) => event.type === "harness.tool_call.started");
    const startedArgs = started?.payload.args as { subRunId?: string } | undefined;
    expect(startedArgs?.subRunId).toMatch(/^run_[0-9a-f]{16}$/u);
    expect((executedInput as { subRunId?: string } | undefined)?.subRunId).toBe(startedArgs?.subRunId);
  });
});

const mockModelUsage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

function mockModelStream(parts: readonly unknown[]) {
  return {
    stream: new ReadableStream({
      start(controller) {
        controller.enqueue({ type: "stream-start", warnings: [] });
        for (const part of parts) controller.enqueue(part);
        controller.close();
      },
    }),
  } as never;
}

function mockModelTextStream(text: string) {
  return mockModelStream([
    { type: "text-start", id: "0" },
    { type: "text-delta", id: "0", delta: text },
    { type: "text-end", id: "0" },
    { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: mockModelUsage },
  ]);
}

function harnessPlanTask() {
  return {
    kind: "plan" as const,
    workflowSnapshot: {
      id: "test.workflow",
      description: "Test workflow",
      inputSchema: true,
      outputSchema: true,
      workflowDefinitionHash: "sha256:test",
    },
    input: { ticketId: "TIN-8" },
  };
}

function workflowHarnessTestContext(
  overrides: Partial<WorkflowHarnessContext> = {},
): WorkflowHarnessContext {
  const controller = new AbortController();
  return {
    scope: {
      runId: "run_test",
      logDir: "/tmp/little-harness-test",
      role: "worker.tool-call",
      stepPath: "lookup",
    },
    session: {
      runId: "run_test",
      role: "worker.tool-call",
      task: { kind: "execute_step" },
      manifest: { test: true },
      manifestHash: "sha256:test",
    },
    model: {
      slotId: "worker",
      providerId: "test",
      modelId: "test-model",
      model: { provider: "test", modelId: "test-model" },
    },
    tools: {},
    memoryMounts: [],
    scratchMounts: [],
    skills: [],
    mounts: [],
    durability: { append: async () => undefined },
    abortSignal: controller.signal,
    ...overrides,
  };
}

function recordDurability(events: RecordedEvent[]): WorkflowHarnessDurabilitySink {
  return {
    append: async (event) => {
      events.push({
        type: event.type,
        runId: event.runId,
        payload: event.payload ?? { payloadArtifactId: event.payloadArtifactId },
        ...(event.occurrenceId === undefined ? {} : { occurrenceId: event.occurrenceId }),
      });
    },
  };
}

function codeRunFile(content: string): { readonly content: string; readonly sha256: `sha256:${string}` } {
  return {
    content,
    sha256: `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`,
  };
}

function persistedEvent(
  sequence: number,
  type: WorkflowDurableHarnessEventType,
  payload: Record<string, unknown>,
  occurrenceId?: string,
): PersistedDurableHarnessEvent<WorkflowDurableHarnessEventType> {
  const request: DurableHarnessEventInput<WorkflowDurableHarnessEventType> = {
    type,
    runId: "run_test",
    appendIdempotencyKey: createHarnessAppendIdempotencyKey({
      runId: "run_test",
      eventType: type,
      logicalEventId: `fixture:${sequence}`,
    }),
    ...(occurrenceId === undefined ? {} : { occurrenceId }),
    payload,
  };
  return {
    ...request,
    eventId: `evt_${sequence}`,
    sequence,
    recordedAt: "2026-06-07T00:00:00.000Z",
    canonicalRequestDigest: canonicalHarnessEventRequestDigest(request),
  };
}
