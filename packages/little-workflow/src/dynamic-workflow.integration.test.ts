import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { jsonSchema, tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { createHarness, generateHarness, localHost } from "little-harness";
import { dynamicWorkflows } from "./dynamic-workflow.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

/**
 * generateHarness does not surface individual tool results on its return value, so we recover the
 * tool-result envelope the same way the model itself sees it: from the prompt of the *next* model
 * turn. The AI SDK serializes each tool result as a `tool` message whose content carries a
 * `tool-result` part `{ toolName, output: { type, value } }`. We return every such envelope for the
 * named tool (the `output.value` payload — i.e. exactly what `run_ad_hoc_plan`/`search_authored_plans`
 * returned to the model).
 */
function toolResultsFromPrompt(prompt: unknown, toolName: string): unknown[] {
  const out: unknown[] = [];
  if (!Array.isArray(prompt)) return out;
  for (const message of prompt) {
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const p = part as { type?: string; toolName?: string; output?: unknown };
      if (p.type !== "tool-result" || p.toolName !== toolName) continue;
      const output = p.output as { value?: unknown } | undefined;
      out.push(output && typeof output === "object" && "value" in output ? output.value : output);
    }
  }
  return out;
}

// A `tool.call` step-DAG over the `echo` tool: echo receives `{ v: <input.v> }` and returns it, and
// the plan surfaces step `c`'s output. This is the minimal end-to-end proof that a model-authored
// plan compiles, capability-checks, and runs to completion inside the harness turn.
const echoPlan = {
  steps: [
    {
      id: "c",
      uses: "tool.call",
      tool: "echo",
      with: { v: "{{ input.v }}" },
      output: { mode: "json", schema: true },
    },
  ],
  output: { from: "c" },
};

it("authors a one-shot plan, runs it, and records it for recall", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dyn-e2e-"));
  dirs.push(dataDir);
  const echo = tool({
    description: "Echo back.",
    inputSchema: jsonSchema({ type: "object", additionalProperties: true }),
    execute: async (a: unknown) => a,
  });

  let secondPrompt: unknown;
  let call = 0;
  const model = new MockLanguageModelV3({
    provider: "test",
    modelId: "dyn",
    doGenerate: async (options) => {
      call += 1;
      if (call === 1) {
        return {
          content: [
            {
              type: "tool-call",
              toolCallId: "call_plan",
              toolName: "run_ad_hoc_plan",
              input: JSON.stringify({
                purpose: "echo the input",
                plan: echoPlan,
                input: { v: 42 },
                outputSchema: true,
              }),
            },
          ],
          finishReason: { unified: "tool-calls", raw: "tool-calls" },
          usage,
          warnings: [],
        };
      }
      secondPrompt = options.prompt;
      return {
        content: [{ type: "text", text: "done" }],
        finishReason: { unified: "stop", raw: "stop" },
        usage,
        warnings: [],
      };
    },
  });

  const harness = createHarness({
    host: localHost({ dataDir }),
    model,
    tools: { echo },
    dynamicWorkflows: dynamicWorkflows(),
  });
  const result = await generateHarness({ harness, type: "job", input: {} });

  // The harness completed after running the model-authored plan.
  expect(result.text).toContain("done");

  // The run_ad_hoc_plan envelope the model received back carries the completed run's echo output.
  const envelopes = toolResultsFromPrompt(secondPrompt, "run_ad_hoc_plan") as Array<{
    status?: string;
    output?: unknown;
  }>;
  expect(envelopes).toHaveLength(1);
  expect(envelopes[0]?.status).toBe("completed");
  expect(envelopes[0]?.output).toEqual({ v: 42 });

  // Persistence: the completed record is committed to disk under the host dataDir so a later
  // harness can recall it. It lives at <dataDir>/dynamic-plans/plans/<runId>.json — the runId
  // now embeds the session id, so read the single record in the dir rather than hardcode its name.
  const plansDir = join(dataDir, "dynamic-plans", "plans");
  const files = (await readdir(plansDir)).filter((f) => f.endsWith(".json"));
  expect(files).toHaveLength(1);
  const raw = await readFile(join(plansDir, files[0]!), "utf8");
  const record = JSON.parse(raw) as { purpose: string; status: string };
  expect(record.purpose).toBe("echo the input");
  expect(record.status).toBe("completed");
});

it("recalls a plan authored on a PRIOR run via a second harness sharing the same dataDir", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dyn-recall-"));
  dirs.push(dataDir);
  const echo = tool({
    description: "Echo back.",
    inputSchema: jsonSchema({ type: "object", additionalProperties: true }),
    execute: async (a: unknown) => a,
  });

  // RUN 1: author + run the plan on one harness instance.
  let run1Call = 0;
  const run1Model = new MockLanguageModelV3({
    provider: "test",
    modelId: "r1",
    doGenerate: async () => {
      run1Call += 1;
      return run1Call === 1
        ? {
            content: [
              {
                type: "tool-call",
                toolCallId: "call_plan",
                toolName: "run_ad_hoc_plan",
                input: JSON.stringify({
                  purpose: "echo the input",
                  plan: echoPlan,
                  input: { v: 42 },
                  outputSchema: true,
                }),
              },
            ],
            finishReason: { unified: "tool-calls", raw: "tool-calls" },
            usage,
            warnings: [],
          }
        : {
            content: [{ type: "text", text: "run1 done" }],
            finishReason: { unified: "stop", raw: "stop" },
            usage,
            warnings: [],
          };
    },
  });
  const run1 = await generateHarness({
    harness: createHarness({
      host: localHost({ dataDir }),
      model: run1Model,
      tools: { echo },
      dynamicWorkflows: dynamicWorkflows(),
    }),
    type: "job",
    input: {},
  });
  expect(run1.text).toContain("run1 done");

  // RUN 2: a FRESH harness over the SAME dataDir searches its authored plans and finds run 1's plan.
  let run2Call = 0;
  let searchPrompt: unknown;
  const run2Model = new MockLanguageModelV3({
    provider: "test",
    modelId: "r2",
    doGenerate: async (options) => {
      run2Call += 1;
      if (run2Call === 1) {
        return {
          content: [
            {
              type: "tool-call",
              toolCallId: "call_search",
              toolName: "search_authored_plans",
              input: JSON.stringify({ query: "echo" }),
            },
          ],
          finishReason: { unified: "tool-calls", raw: "tool-calls" },
          usage,
          warnings: [],
        };
      }
      searchPrompt = options.prompt;
      return {
        content: [{ type: "text", text: "recalled" }],
        finishReason: { unified: "stop", raw: "stop" },
        usage,
        warnings: [],
      };
    },
  });
  const run2 = await generateHarness({
    harness: createHarness({
      host: localHost({ dataDir }),
      model: run2Model,
      tools: { echo },
      dynamicWorkflows: dynamicWorkflows(),
    }),
    type: "job",
    input: {},
  });
  expect(run2.text).toContain("recalled");

  // THE HEADLINE: run 2's search returned run 1's plan — proving the authored-plans store persists
  // across harness instances that share a dataDir.
  const envelopes = toolResultsFromPrompt(searchPrompt, "search_authored_plans") as Array<{
    plans?: Array<{ purpose?: string; status?: string; plan?: unknown }>;
  }>;
  expect(envelopes).toHaveLength(1);
  const plans = envelopes[0]?.plans ?? [];
  expect(plans.length).toBeGreaterThanOrEqual(1);
  const recalled = plans.find((p) => p.purpose === "echo the input");
  expect(recalled).toBeDefined();
  expect(recalled?.status).toBe("completed");
  expect(recalled?.plan).toEqual(echoPlan);
});

it("rejects a recalled plan after a capability is removed (drift)", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dyn-drift-"));
  dirs.push(dataDir);
  // A plan that references `echo`, submitted to a harness that no longer exposes `echo`.
  const plan = {
    steps: [{ id: "c", uses: "tool.call", tool: "echo", with: {} }],
    output: { from: "c" },
  };

  let call = 0;
  let secondPrompt: unknown;
  const model = new MockLanguageModelV3({
    provider: "test",
    modelId: "drift",
    doGenerate: async (options) => {
      call += 1;
      if (call === 1) {
        return {
          content: [
            {
              type: "tool-call",
              toolCallId: "call_plan",
              toolName: "run_ad_hoc_plan",
              input: JSON.stringify({
                purpose: "echo",
                plan,
                input: {},
                outputSchema: true,
              }),
            },
          ],
          finishReason: { unified: "tool-calls", raw: "tool-calls" },
          usage,
          warnings: [],
        };
      }
      secondPrompt = options.prompt;
      return {
        content: [{ type: "text", text: "handled" }],
        finishReason: { unified: "stop", raw: "stop" },
        usage,
        warnings: [],
      };
    },
  });

  // Fresh harness WITHOUT `echo` in tools; the model re-submits the plan that used echo.
  const result = await generateHarness({
    harness: createHarness({
      host: localHost({ dataDir }),
      model,
      dynamicWorkflows: dynamicWorkflows(),
    }),
    type: "job",
    input: {},
  });

  // The run did NOT throw; the harness handled the clean failure and produced text.
  expect(result.text).toContain("handled");

  // The invariant re-checks on resubmission: the tool result is a clean capability-drift failure.
  const envelopes = toolResultsFromPrompt(secondPrompt, "run_ad_hoc_plan") as Array<{
    status?: string;
    causeCode?: string;
  }>;
  expect(envelopes).toHaveLength(1);
  expect(envelopes[0]?.status).toBe("failed");
  expect(envelopes[0]?.causeCode).toBe("capability_not_allowed");
});
