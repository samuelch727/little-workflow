import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tool } from "ai";
import { MockLanguageModelV3, MockLanguageModelV4 } from "ai/test";
import { afterEach, expect, expectTypeOf, test, vi } from "vitest";
import { z } from "zod";
import {
  defineWorkflow,
  inlineToolRegistryFor,
  isRunFailedError,
  localWorld,
  model,
  runWorkflow,
  type InferWorkflowInput,
  type RunFailedError,
  type InferWorkflowOutput,
} from "./authoring.js";
import { fixedPlanLwir } from "./compiler.js";
import { readWorkflowVersion } from "./run-plan.js";
import { FIXED_PLAN_HARNESS_PREFIX } from "./fixed-plan.js";
import { createToolRegistry } from "./tool-registry.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempWorld() {
  const dir = await mkdtemp(join(tmpdir(), "define-workflow-"));
  tempDirs.push(dir);
  return localWorld({ dataDir: dir });
}

// A stub model: model() only reads .provider/.modelId if present and never throws,
// so this is enough to exercise the normalization facade without a real provider.
const fakeModel = { provider: "test", modelId: "test-model" } as const;

test("wraps a single model into a one-element models tuple", () => {
  const wf = defineWorkflow({
    id: "demo.review",
    input: z.object({ name: z.string() }),
    output: z.object({ ok: z.boolean() }),
    model: fakeModel,
  });
  expect(wf.models).toHaveLength(1);
  expect(wf.models[0]?.aiSdkModel).toBe(fakeModel);
});

test("synthesizes a planner from the workflow model", () => {
  const wf = defineWorkflow({
    id: "demo.review",
    input: z.object({ name: z.string() }),
    output: z.object({ ok: z.boolean() }),
    model: fakeModel,
  });
  expect(wf.planner).toBeDefined();
  expect(wf.planner.model).toBe(fakeModel);
});

test("lifts a bare planner model into a PlannerConfig", () => {
  const plannerModel = { provider: "test", modelId: "planner-model" } as const;
  const wf = defineWorkflow({
    id: "demo.review",
    input: z.object({ name: z.string() }),
    output: z.object({ ok: z.boolean() }),
    model: fakeModel,
    planner: plannerModel,
  });
  expect(wf.planner.model).toBe(plannerModel);
});

test("registers inline tools and lists their names in globalTools", () => {
  const wf = defineWorkflow({
    id: "demo.review",
    input: z.object({ name: z.string() }),
    output: z.object({ ok: z.boolean() }),
    model: fakeModel,
    tools: {
      lookup: tool({
        description: "look up an order",
        inputSchema: z.object({ id: z.string() }),
        execute: async () => ({ found: true }),
      }),
    },
  });
  expect(wf.globalTools).toContain("lookup");
});

test("maps the ergonomic input schema onto inputSchema", () => {
  const input = z.object({ name: z.string() });
  const wf = defineWorkflow({
    id: "demo.review",
    input,
    output: z.object({ ok: z.boolean() }),
    model: fakeModel,
  });
  expect(wf.inputSchema).toBe(input);
});

test("infers object output mode from a z.object output schema", () => {
  const wf = defineWorkflow({
    id: "demo.review",
    input: z.object({}),
    output: z.object({ ok: z.boolean() }),
    model: fakeModel,
  });
  expect((wf.output as { readonly kind?: string } | undefined)?.kind).toBe("object");
});

test("infers array output mode from a z.array output schema", () => {
  const wf = defineWorkflow({
    id: "demo.review",
    input: z.object({}),
    output: z.array(z.object({ ok: z.boolean() })),
    model: fakeModel,
  });
  expect((wf.output as { readonly kind?: string } | undefined)?.kind).toBe("array");
});

test("passes the id through unchanged", () => {
  const wf = defineWorkflow({
    id: "applicants.review",
    input: z.object({}),
    output: z.object({}),
    model: fakeModel,
  });
  expect(wf.id).toBe("applicants.review");
});

test("preserves input and output types in the workflow brand", () => {
  const wf = defineWorkflow({
    id: "demo.review",
    input: z.object({ name: z.string() }),
    output: z.array(z.object({ score: z.number() })),
    model: fakeModel,
  });
  // The whole point of schema-as-contract: result.output is typed, not `unknown`.
  expectTypeOf<InferWorkflowInput<typeof wf>>().toEqualTypeOf<{ name: string }>();
  expectTypeOf<InferWorkflowOutput<typeof wf>>().toEqualTypeOf<{ score: number }[]>();
});

test("keeps several model slots, unwrapping model() slots instead of nesting them", () => {
  const fast = { provider: "test", modelId: "fast" } as const;
  const deep = { provider: "test", modelId: "deep" } as const;
  const wf = defineWorkflow({
    id: "demo.review",
    input: z.object({}),
    output: z.object({}),
    models: [model(fast, { id: "fast" }), deep],
  });
  expect(wf.models).toHaveLength(2);
  expect(wf.models[0]?.aiSdkModel).toBe(fast);
  expect(wf.models[0]?.metadata.id).toBe("fast");
  expect(wf.models[1]?.aiSdkModel).toBe(deep);
  // The planner defaults to the first model.
  expect(wf.planner.model).toEqual(wf.models[0]);
});

test("rejects model plus models, empty models, and a workflow with no way to plan", () => {
  expect(() =>
    defineWorkflow({ id: "demo.both", model: fakeModel, models: [fakeModel] }),
  ).toThrow(/either model or models/u);
  expect(() => defineWorkflow({ id: "demo.empty", models: [] })).toThrow(/at least one model/u);
  expect(() => defineWorkflow({ id: "demo.none" })).toThrow(/set model \(or models\)/u);
});

test("passes PlannerConfig, toolSelection, reuse strategy and suggestedInput through", () => {
  const planner = { model: fakeModel, system: "Plan carefully." };
  const suggestedInput = z.object({ hint: z.string() });
  const wf = defineWorkflow({
    id: "demo.review",
    input: z.object({}),
    suggestedInput,
    output: z.object({}),
    model: fakeModel,
    planner,
    tools: ["lookup", "search"],
    toolSelection: "all",
    workflowVersionReuseStrategy: "always_fresh",
  });
  expect(wf.planner).toBe(planner);
  expect(wf.globalTools).toEqual(["lookup", "search"]);
  expect(wf.toolSelection).toBe("all");
  expect(wf.workflowVersionReuseStrategy).toBe("always_fresh");
  expect(wf.suggestedInputSchema).toBe(suggestedInput);
  // Tool names only: the run supplies the implementations.
  expect(inlineToolRegistryFor(wf)).toBeUndefined();
});

test("accepts a ToolRegistry as the workflow's tools", () => {
  const registry = createToolRegistry({
    lookup: tool({
      description: "look up an order",
      inputSchema: z.object({ id: z.string() }),
      execute: async () => ({ found: true }),
    }),
  });
  const wf = defineWorkflow({ id: "demo.review", model: fakeModel, tools: registry });
  expect(wf.globalTools).toEqual(["lookup"]);
  expect(inlineToolRegistryFor(wf)).toBe(registry);
});

const echoInput = z.object({ value: z.string() });

function echoWorkflow(execute: (args: { readonly value: string }) => Promise<unknown>) {
  return defineWorkflow({
    id: "demo.echo",
    input: echoInput,
    tools: {
      echo: tool({ description: "Echo a value.", inputSchema: echoInput, execute }),
    },
    plan: {
      steps: [
        {
          id: "echo",
          uses: "tool.call",
          with: { tool: "echo", args: { value: "{{ input.value }}" } },
          output: { mode: "json", schema: true },
        },
      ],
    },
  });
}

test("a fixed plan needs no model and declares the tools its steps call", () => {
  const wf = echoWorkflow(async ({ value }) => ({ echoed: value }));
  expect(wf.models).toEqual([]);
  expect(wf.globalTools).toEqual(["echo"]);
  expect(wf.planner.harness?.harnessId?.startsWith(FIXED_PLAN_HARNESS_PREFIX)).toBe(true);
});

test("a different fixed plan gives a different planner identity", () => {
  const first = echoWorkflow(async () => ({}));
  const second = defineWorkflow({
    id: "demo.echo",
    input: echoInput,
    tools: ["echo"],
    plan: {
      steps: [
        {
          id: "echo-twice",
          uses: "tool.call",
          with: { tool: "echo", args: { value: "{{ input.value }}" } },
          output: { mode: "json", schema: true },
        },
      ],
    },
  });
  expect(second.planner.harness?.harnessId).not.toBe(first.planner.harness?.harnessId);
});

test("a fixed plan replaces the planner", () => {
  expect(() =>
    defineWorkflow({ id: "demo.echo", plan: { steps: [] }, planner: fakeModel }),
  ).toThrow(/plan or planner, not both/u);
});

function registeredLwirHash(result: { readonly events: readonly { readonly type: string; readonly payload?: unknown }[] }) {
  const registered = result.events.find((event) => event.type === "WorkflowVersionRegistered");
  return (registered?.payload as { readonly lwirHash?: string } | undefined)?.lwirHash;
}

test("runs a fixed plan without a model, and runs the same plan again in the same world", async () => {
  const world = await tempWorld();
  const wf = echoWorkflow(async ({ value }) => ({ echoed: value }));

  const first = await runWorkflow(wf, { value: "hello" }, { world });
  expect(first.status).toBe("completed");
  expect(JSON.stringify(first.output)).toContain("hello");

  const second = await wf.run({ value: "again" }, { world });
  expect(second.status).toBe("completed");
  expect(JSON.stringify(second.output)).toContain("again");
  // The compiled version binds the concrete input, so its id changes; the plan itself does not.
  expect(registeredLwirHash(second)).toBeDefined();
  expect(registeredLwirHash(second)).toBe(registeredLwirHash(first));
  expect(first.plan).toEqual({ kind: "fixed", plannerCalled: false, workflowVersionId: first.workflowVersionId });
  expect(second.plan).toEqual({ kind: "fixed", plannerCalled: false, workflowVersionId: second.workflowVersionId });
});

test("a failing fixed-plan step throws an error isRunFailedError recognizes", async () => {
  const world = await tempWorld();
  const wf = echoWorkflow(async () => {
    throw new Error("echo is down");
  });
  const error = await runWorkflow(wf, { value: "hello" }, { world, maxAttempts: 1 }).catch(
    (caught: unknown) => caught,
  );
  expect(isRunFailedError(error)).toBe(true);
  expect(isRunFailedError(new Error("plain"))).toBe(false);
});

function recordingModel(slotId: string) {
  const prompts: unknown[] = [];
  const tools: unknown[] = [];
  const usage = {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  };
  const aiSdkModel = new MockLanguageModelV3({
    provider: "test",
    modelId: slotId,
    doStream: async (options) => {
      prompts.push(options.prompt);
      tools.push(options.tools);
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ type: "text-start", id: "0" });
            controller.enqueue({ type: "text-delta", id: "0", delta: "summary" });
            controller.enqueue({ type: "text-end", id: "0" });
            controller.enqueue({ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage });
            controller.close();
          },
        }),
      };
    },
  });
  return { prompts, tools, slot: model(aiSdkModel, { id: slotId }) };
}

// The system and user text a recorded AI SDK prompt carried, one message per line.
function promptText(prompt: unknown): string {
  return (prompt as ReadonlyArray<{ readonly content: unknown }>)
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : (message.content as ReadonlyArray<{ readonly text?: string }>)
          .map((part) => part.text ?? "")
          .join(""),
    )
    .join("\n");
}

function summaryWorkflow(slot: ReturnType<typeof model>, stepModel: string) {
  return defineWorkflow({
    id: "demo.summary",
    input: z.object({ text: z.string() }),
    output: z.string(),
    models: [slot],
    plan: {
      steps: [
        {
          id: "summarize",
          uses: "ai.generate",
          with: { model: stepModel, prompt: "Summarize in one line." },
          output: { mode: "text" },
        },
      ],
    },
  });
}

test("runs the authored ai.generate step of a fixed plan", async () => {
  const world = await tempWorld();
  const { prompts, slot } = recordingModel("writer");
  const result = await runWorkflow(summaryWorkflow(slot, "writer"), { text: "hello" }, { world });
  expect(result.status).toBe("completed");
  expect(result.output).toBe("summary");
  expect(prompts).toHaveLength(1);
  expect(JSON.stringify(prompts[0])).toContain("Summarize in one line.");
});

test("fills in {{ }} in an ai.generate prompt and system, and offers the step no tools", async () => {
  const world = await tempWorld();
  const { prompts, tools, slot } = recordingModel("writer");
  const wf = defineWorkflow({
    id: "demo.letter",
    input: z.object({ name: z.string() }),
    output: z.string(),
    models: [slot],
    tools: {
      score: tool({
        description: "Look up a credit score.",
        inputSchema: z.object({ name: z.string() }),
        execute: async () => ({ score: 712, band: "good" }),
      }),
    },
    plan: {
      steps: [
        {
          id: "credit",
          uses: "tool.call",
          with: { tool: "score", args: { name: "{{ input.name }}" } },
          output: { mode: "json", schema: true },
        },
        {
          id: "letter",
          uses: "ai.generate",
          needs: ["credit"],
          with: {
            model: "writer",
            system: "You write letters for {{ input.name }}.",
            prompt: "Score {{ steps.credit.output.score }}. Report: {{ steps.credit.output }}",
          },
          output: { mode: "text" },
        },
      ],
    },
  });

  const result = await runWorkflow(wf, { name: "Ada" }, { world });

  expect(result.status).toBe("completed");
  expect(prompts).toHaveLength(1);
  const text = promptText(prompts[0]);
  expect(text).toContain("You write letters for Ada.");
  expect(text).toContain('Score 712. Report: {"band":"good","score":712}');
  expect(text).not.toContain("{{");
  // The workflow's `score` tool is a tool.call step's job; the model step is not offered it.
  expect(tools[0] ?? []).toEqual([]);
});

test("a workflow policy reaches every ai.generate step's system prompt word for word", async () => {
  const world = await tempWorld();
  const { prompts, slot } = recordingModel("writer");
  const policy = "Refer anything this policy does not cover.\nNever approve more than requested.";
  const wf = defineWorkflow({
    id: "demo.policy",
    input: z.object({ text: z.string() }),
    output: z.string(),
    models: [slot],
    policy,
    plan: {
      steps: [
        {
          id: "decide",
          uses: "ai.generate",
          with: { model: "writer", system: "You are an underwriter.", prompt: "Decide." },
          output: { mode: "text" },
        },
        {
          id: "letter",
          uses: "ai.generate",
          needs: ["decide"],
          with: { model: "writer", prompt: "Write the letter." },
          output: { mode: "text" },
        },
      ],
    },
  });

  const result = await runWorkflow(wf, { text: "hello" }, { world });

  expect(result.status).toBe("completed");
  expect(prompts).toHaveLength(2);
  const [decide, letter] = prompts.map(promptText);
  expect(decide).toContain(`Follow this policy exactly:\n${policy}\n\nYou are an underwriter.`);
  expect(letter).toContain(`Follow this policy exactly:\n${policy}`);
  // The plan is stored as written: the policy is added at run time, not baked into the version.
  const { lwir } = await readWorkflowVersion(world, result.workflowVersionId);
  expect(JSON.stringify(lwir)).not.toContain("Never approve more than requested.");
});

test("a workflow policy must be a non-empty string", () => {
  expect(() => defineWorkflow({ id: "demo.policy", model: fakeModel, policy: "  " })).toThrow(
    /policy must be a non-empty string/u,
  );
});

test("an ai.generate prompt in a loop reads the reviewer's last note, empty on the first pass", async () => {
  const world = await tempWorld();
  const { prompts, slot } = recordingModel("writer");
  let reviews = 0;
  const wf = defineWorkflow({
    id: "demo.redraft",
    input: z.object({ topic: z.string() }),
    output: z.object({ ok: z.boolean(), note: z.string() }),
    models: [slot],
    tools: {
      review: tool({
        description: "Review a draft.",
        inputSchema: z.object({ draft: z.string() }),
        execute: async () => {
          reviews += 1;
          return { ok: reviews >= 2, note: `round ${reviews}` };
        },
      }),
    },
    plan: {
      steps: [
        {
          id: "draft",
          uses: "ai.generate",
          maxVisits: 3,
          // A back-edge read: `review` runs after `draft`, so the first pass has no note yet.
          with: { model: "writer", prompt: "Draft. Reviewer note: [{{ steps.review.lastOutput.note }}]" },
          output: { mode: "text" },
        },
        {
          id: "review",
          uses: "tool.call",
          needs: ["draft"],
          maxVisits: 3,
          with: { tool: "review", args: { draft: "{{ steps.draft.lastOutput }}" } },
          output: { mode: "json", schema: true },
        },
        {
          id: "route",
          uses: "decision",
          needs: ["review"],
          maxVisits: 3,
          with: { cases: [{ when: "{{ steps.review.lastOutput.ok }}", to: "end" }], default: "draft" },
        },
      ],
    },
  });

  const result = await runWorkflow(wf, { topic: "rates" }, { world });

  expect(result.status).toBe("completed");
  expect(prompts.map((prompt) => /Reviewer note: \[[^\]]*\]/u.exec(promptText(prompt))?.[0])).toEqual([
    "Reviewer note: []",
    "Reviewer note: [round 1]",
  ]);
});

test("an ai.generate prompt inside a parallel branch reads its item", async () => {
  const world = await tempWorld();
  const { prompts, slot } = recordingModel("writer");
  const wf = defineWorkflow({
    id: "demo.greetings",
    input: z.object({ people: z.array(z.object({ name: z.string() })) }),
    models: [slot],
    plan: {
      steps: [
        {
          id: "greet",
          uses: "parallel",
          with: {
            items: "{{ input.people }}",
            cardinality: { kind: "matches_items" },
            itemKey: "{{ item.name }}",
            maxBranches: 5,
            maxConcurrency: 1,
            failureMode: "fail_fast",
            fanIn: { order: "input", output: "array" },
          },
          output: {
            mode: "array",
            schema: {
              type: "array",
              items: {
                type: "object",
                required: ["itemKey", "status", "artifacts"],
                properties: { itemKey: {}, status: {}, artifacts: {}, output: {} },
              },
            },
          },
          steps: [
            {
              id: "hello",
              uses: "ai.generate",
              with: { model: "writer", prompt: "Greet {{ item.name }}." },
              output: { mode: "text" },
            },
          ],
        },
      ],
    },
  });

  const result = await runWorkflow(wf, { people: [{ name: "Ada" }, { name: "Grace" }] }, { world });

  expect(result.status).toBe("completed");
  expect(prompts.map((prompt) => /Greet \w+\./u.exec(promptText(prompt))?.[0]).sort()).toEqual([
    "Greet Ada.",
    "Greet Grace.",
  ]);
});

test("a fixed plan naming an unknown model slot fails instead of running a replacement plan", async () => {
  const world = await tempWorld();
  const { prompts, slot } = recordingModel("writer");
  const error = await runWorkflow(summaryWorkflow(slot, "wrtier"), { text: "hello" }, { world })
    .catch((caught: unknown) => caught);
  expect(isRunFailedError(error)).toBe(true);
  expect(prompts).toHaveLength(0);
  const events = (error as RunFailedError).result?.events ?? [];
  // One draft: the authored plan, rejected. No retry, and no synthesized plan in its place.
  expect(events.filter((event) => event.type === "PlannerDraftedWorkflow")).toHaveLength(1);
  expect(events.some((event) => event.type === "WorkflowVersionRegistered")).toBe(false);
  expect((error as RunFailedError).message).toMatch(/Fixed plan .* is invalid: .*'wrtier'/u);
});

test("a fixed plan that reads a step it does not list in needs fails: no needs are added to it", async () => {
  const world = await tempWorld();
  const { prompts, slot } = recordingModel("writer");
  const wf = defineWorkflow({
    id: "demo.undeclared",
    input: z.object({ text: z.string() }),
    output: z.string(),
    models: [slot],
    plan: {
      steps: [
        { id: "draft", uses: "ai.generate", with: { model: "writer", prompt: "Draft." }, output: { mode: "text" } },
        {
          id: "polish",
          uses: "ai.generate",
          with: { model: "writer", prompt: "Polish {{ steps.draft.output }}." },
          output: { mode: "text" },
        },
      ],
    },
  });
  const error = await runWorkflow(wf, { text: "hello" }, { world }).catch((caught: unknown) => caught);
  expect(isRunFailedError(error)).toBe(true);
  expect(prompts).toHaveLength(0);
  expect((error as RunFailedError).message).toMatch(/references 'draft' without declaring it in needs/u);
});

test("an ai.generate step whose output fails the workflow output schema is repaired by the default harness", async () => {
  const world = await tempWorld();
  // The first answer is fenced JSON with the wrong type; the step itself accepts any JSON, so it
  // succeeds and the workflow output check fails. The repair answer is valid.
  const replies = ["```json\n{\"answer\": 1}\n```", "{\"answer\":\"ok\"}"];
  let calls = 0;
  const usage = {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  };
  const aiSdkModel = new MockLanguageModelV3({
    provider: "test",
    modelId: "writer",
    doStream: async () => {
      const text = replies[Math.min(calls, replies.length - 1)]!;
      calls += 1;
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ type: "text-start", id: "0" });
            controller.enqueue({ type: "text-delta", id: "0", delta: text });
            controller.enqueue({ type: "text-end", id: "0" });
            controller.enqueue({ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage });
            controller.close();
          },
        }),
      };
    },
  });
  const wf = defineWorkflow({
    id: "demo.repair",
    input: z.object({ question: z.string() }),
    output: z.object({ answer: z.string() }),
    models: [model(aiSdkModel, { id: "writer" })],
    plan: {
      steps: [
        { id: "answer", uses: "ai.generate", with: { model: "writer", prompt: "Answer." }, output: { mode: "json", schema: true } },
      ],
    },
  });

  const result = await runWorkflow(wf, { question: "why?" }, { world });

  expect(calls).toBe(2);
  expect(result.output).toEqual({ answer: "ok" });
});

test("a fixed plan's permissions come from its steps, not from tool arguments that look like steps", async () => {
  const world = await tempWorld();
  const template = {
    steps: [
      { id: "deploy", uses: "tool.call", with: { tool: "deploy", model: "planner" } },
      { id: "draft", uses: "ai.generate", with: { model: "drafter", prompt: "Draft." } },
    ],
  };
  const saved: unknown[] = [];
  const wf = defineWorkflow({
    id: "demo.templates",
    tools: {
      saveTemplate: tool({
        description: "Store a workflow template as data.",
        inputSchema: z.object({ template: z.unknown() }),
        execute: async ({ template: value }) => {
          saved.push(value);
          return { saved: true };
        },
      }),
    },
    plan: {
      steps: [
        {
          id: "save",
          uses: "tool.call",
          with: { tool: "saveTemplate", args: { template } },
          output: { mode: "json", schema: true },
        },
      ],
    },
  });
  const result = await runWorkflow(wf, {}, { world });
  expect(result.status).toBe("completed");
  expect(saved).toEqual([template]);
  const lwir = fixedPlanLwir({ id: "demo.templates" }, [
    { id: "save", uses: "tool.call", with: { tool: "saveTemplate", args: { template } } },
  ]);
  expect(lwir.permissions).toEqual({ models: [], tools: ["saveTemplate"], secrets: [], network: [] });
});

// A planner run end to end: the planner model drafts the LWIR through the default harness and
// the AI SDK adapter. These pin how a model error, a planner tool call, and a repeated bad draft
// reach the caller.
const plannerUsage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

function streamOf(parts: readonly unknown[]) {
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

function textReply(text: string) {
  return streamOf([
    { type: "text-start", id: "0" },
    { type: "text-delta", id: "0", delta: text },
    { type: "text-end", id: "0" },
    { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: plannerUsage },
  ]);
}

function toolCallReply(toolName: string, input: unknown) {
  return streamOf([
    { type: "tool-call", toolCallId: "call_1", toolName, input: JSON.stringify(input) },
    { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_use" }, usage: plannerUsage },
  ]);
}

// The planner prompt carries a valid LWIR skeleton for a tool-registering workflow; a scripted
// planner returns it as its draft.
function skeletonFrom(prompt: unknown): string {
  const text = promptText(prompt);
  const marker = "no prose or markdown fences:\n";
  const start = text.indexOf("{", text.indexOf(marker));
  return text.slice(start, text.indexOf("\n}", start) + 2);
}

function offeredToolNames(options: { readonly tools?: ReadonlyArray<{ readonly name: string }> }): string[] {
  return (options.tools ?? []).map((entry) => entry.name).sort();
}

function loanWorkflow(slot: ReturnType<typeof model>, onRecord: () => void) {
  return defineWorkflow({
    id: "demo.loan",
    description: "Decide a loan application.",
    input: z.object({ name: z.string() }),
    output: z.string(),
    models: [slot],
    tools: {
      fetch_credit_report: tool({
        description: "Fetch the applicant's credit report.",
        inputSchema: z.object({ name: z.string() }),
        execute: async () => ({ score: 712 }),
      }),
      record_decision: tool({
        description: "Record the decision in the loan system.",
        inputSchema: z.object({ name: z.string() }),
        execute: async () => {
          onRecord();
          return { recorded: true };
        },
      }),
    },
  });
}

test("a planner model error fails the run with that error instead of a validator finding", async () => {
  const world = await tempWorld();
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const plannerModel = new MockLanguageModelV4({
      provider: "test",
      modelId: "planner",
      doStream: async () => {
        throw new Error("401 invalid x-api-key");
      },
    });
    const wf = loanWorkflow(model(plannerModel, { id: "writer" }), () => {});
    const error = await runWorkflow(wf, { name: "Ada" }, { world }).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect((error as Error | undefined)?.message).toContain("401 invalid x-api-key");
    expect((error as Error).message).not.toMatch(/hashable|already used/u);
    // A failed call is not a bad draft: the planner is not asked again.
    expect(plannerModel.doStreamCalls).toHaveLength(1);
    expect(consoleError).not.toHaveBeenCalled();
  } finally {
    consoleError.mockRestore();
  }
});

test("a planner tool call runs before the draft is read, and planning is offered bash but not the workflow's tools", async () => {
  const world = await tempWorld();
  let recorded = 0;
  const plannerCalls: Array<{ readonly tools: string[]; readonly prompt: unknown }> = [];
  const plannerModel = new MockLanguageModelV4({
    provider: "test",
    modelId: "planner",
    doStream: async (options) => {
      const tools = offeredToolNames(options as never);
      if (!tools.includes("bash")) {
        return textReply("Approved."); // the plan's ai.generate step
      }
      plannerCalls.push({ tools, prompt: options.prompt });
      return plannerCalls.length === 1
        ? toolCallReply("bash", { cmd: "echo planner-was-here" })
        : textReply(skeletonFrom(options.prompt));
    },
  });
  const wf = loanWorkflow(model(plannerModel, { id: "writer" }), () => {
    recorded += 1;
  });

  const result = await runWorkflow(wf, { name: "Ada" }, { world });

  expect(result.status).toBe("completed");
  expect(plannerCalls.map((call) => call.tools)).toEqual([["bash"], ["bash"]]);
  // The bash call ran and its result went back to the planner before it drafted.
  expect(JSON.stringify(plannerCalls[1]?.prompt)).toContain("planner-was-here");
  // The planner prompt still lists the workflow's tools so it can write tool.call steps.
  expect(promptText(plannerCalls[0]?.prompt)).toContain("record_decision");
  expect(recorded).toBe(0);
});

test("a planner that returns the same rejected draft twice is asked again, not replayed into a key conflict", async () => {
  const world = await tempWorld();
  const plannerModel = new MockLanguageModelV4({
    provider: "test",
    modelId: "planner",
    doStream: async () => textReply(JSON.stringify({ kind: "NotAWorkflow" })),
  });
  const wf = loanWorkflow(model(plannerModel, { id: "writer" }), () => {});

  const error = await runWorkflow(wf, { name: "Ada" }, { world }).then(
    () => undefined,
    (caught: unknown) => caught,
  );

  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).not.toMatch(/already used/u);
  expect(plannerModel.doStreamCalls).toHaveLength(3);
});
