import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hashHarnessPrompt } from "../events/durability.js";
import type { PersistedDurableHarnessEvent } from "../events/occurrence.js";
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
    expect(receivedOptions?.experimental_context).toBe(runtimeContext);
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
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 0,
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

  it("exposes ctx.bash to ai.generate model loops", async () => {
    const events: RecordedEvent[] = [];
    let seenTools: Record<string, unknown> | undefined;
    const harness = createWorkflowHarness({
      aiLoop: {
        generate: async ({ tools }) => {
          seenTools = tools;
          return {
            output: "done",
            usage: { inputTokens: 1, outputTokens: 1 },
          };
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

    expect(Object.keys(seenTools ?? {})).toContain("bash");
    const modelCalled = events.find((event) => event.type === "harness.model.called");
    expect((modelCalled?.payload.request as { tools?: Array<{ toolName?: string }> } | undefined)?.tools)
      .toEqual(expect.arrayContaining([expect.objectContaining({ toolName: "bash" })]));
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
      costUsd: 0,
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
    const harness = createWorkflowHarness({
      aiLoop: {
        generate: async ({ system }) => {
          seenSystem = system;
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
      output: { mode: "object" },
    });
    expect(events.map((event) => event.type)).toEqual([
      "harness.model.called",
      "harness.model.responded",
    ]);
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
        payload: event.payload,
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
  return {
    eventId: `evt_${sequence}`,
    sequence,
    type,
    runId: "run_test",
    recordedAt: "2026-06-07T00:00:00.000Z",
    ...(occurrenceId === undefined ? {} : { occurrenceId }),
    payload,
  };
}
