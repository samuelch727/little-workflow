import { tool } from "ai";
import { expect, test } from "vitest";
import { z } from "zod";
import { buildRunWorkflowOptions, defineWorkflow } from "./authoring.js";

const fakeModel = { provider: "test", modelId: "test-model" } as const;

function baseWorkflow() {
  return defineWorkflow({
    id: "demo.x",
    input: z.object({ a: z.string() }),
    output: z.object({ ok: z.boolean() }),
    model: fakeModel,
  });
}

test("a defined workflow is runnable via .run()", () => {
  const wf = baseWorkflow();
  expect(typeof wf.run).toBe("function");
});

test("buildRunWorkflowOptions defaults the world and wires workflows + input", () => {
  const wf = baseWorkflow();
  const options = buildRunWorkflowOptions(wf, { a: "hi" });
  expect(options.workflows).toBe(wf);
  expect(options.input).toEqual({ a: "hi" });
  expect(options.world).toBeDefined();
});

test("buildRunWorkflowOptions passes the inline tool registry from defineWorkflow", () => {
  const wf = defineWorkflow({
    id: "demo.x",
    input: z.object({ a: z.string() }),
    output: z.object({ ok: z.boolean() }),
    model: fakeModel,
    tools: {
      lookup: tool({
        description: "look up",
        inputSchema: z.object({ id: z.string() }),
        execute: async () => ({ found: true }),
      }),
    },
  });
  const options = buildRunWorkflowOptions(wf, { a: "hi" });
  expect(options.tools?.has("lookup")).toBe(true);
});

test("buildRunWorkflowOptions lets explicit options override the defaults", () => {
  const wf = baseWorkflow();
  const customWorld = { kind: "local-world" } as never;
  const options = buildRunWorkflowOptions(wf, { a: "hi" }, { world: customWorld });
  expect(options.world).toBe(customWorld);
});
