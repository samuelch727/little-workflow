import { tool } from "ai";
import { expect, expectTypeOf, test } from "vitest";
import { z } from "zod";
import { defineWorkflow, type InferWorkflowInput, type InferWorkflowOutput } from "./authoring.js";

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
