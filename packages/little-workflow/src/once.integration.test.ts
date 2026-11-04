import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { jsonSchema, tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { createHarness, generateHarness, harnessToolContext, localHost, once } from "@little-stack/harness";
import { dynamicWorkflows } from "./dynamic-workflow.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

/** A one-step plan that records a decision; the letter stands in for text a model wrote. */
function decisionPlan(letter: string) {
  return {
    steps: [
      {
        id: "record",
        uses: "tool.call",
        tool: "record_decision",
        with: { applicationId: "{{ input.applicationId }}", letter },
        output: { mode: "json", schema: true },
      },
    ],
    output: { from: "record" },
  };
}

/** What run_ad_hoc_plan returned, read from the prompt of the model call after it. */
function planResults(prompt: unknown): unknown[] {
  return (prompt as Array<{ content?: unknown }>).flatMap((message) =>
    Array.isArray(message.content)
      ? message.content
          .filter((part: { type?: string; toolName?: string }) => part.type === "tool-result" && part.toolName === "run_ad_hoc_plan")
          .map((part: { output?: { value?: unknown } }) => part.output?.value)
      : [],
  );
}

/** A model that submits each plan in turn with run_ad_hoc_plan, then answers. */
function planningModel(plans: readonly unknown[], prompts: unknown[] = []) {
  let call = 0;
  return new MockLanguageModelV3({
    provider: "test",
    modelId: "planner",
    doGenerate: async (options) => {
      prompts.push(options.prompt);
      const plan = plans[call % (plans.length + 1)];
      call += 1;
      if (plan === undefined) {
        return { content: [{ type: "text", text: "done" }], finishReason: { unified: "stop", raw: "stop" }, usage, warnings: [] };
      }
      return {
        content: [
          {
            type: "tool-call",
            toolCallId: `call_${call}`,
            toolName: "run_ad_hoc_plan",
            input: JSON.stringify({
              purpose: "record the decision",
              plan,
              input: { applicationId: "APP-1012" },
              outputSchema: true,
            }),
          },
        ],
        finishReason: { unified: "tool-calls", raw: "tool-calls" },
        usage,
        warnings: [],
      };
    },
  });
}

it("a resubmitted plan gets the recorded decision back instead of writing it twice", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "once-e2e-"));
  dirs.push(dataDir);
  const writes: Array<{ applicationId: string; letter: string; session: string; idempotencyKey?: string }> = [];
  const recordDecision = tool({
    description: "Write the decision to the loan system.",
    inputSchema: jsonSchema<{ applicationId: string; letter: string }>({
      type: "object",
      properties: { applicationId: { type: "string" }, letter: { type: "string" } },
      required: ["applicationId", "letter"],
    }),
    execute: async (input, options) => {
      const ctx = harnessToolContext(options);
      writes.push({ ...input, session: ctx.session.id, ...(ctx.idempotencyKey ? { idempotencyKey: ctx.idempotencyKey } : {}) });
      return { recordId: `rec_${writes.length}` };
    },
  });

  const prompts: unknown[] = [];
  const harness = createHarness({
    host: localHost({ dataDir }),
    model: planningModel([decisionPlan("Approved, first draft."), decisionPlan("Approved, second draft.")], prompts),
    tools: { record_decision: once(recordDecision, { key: (input) => input.applicationId }) },
    dynamicWorkflows: dynamicWorkflows(),
    runtime: { bash: false },
  });

  const first = await generateHarness({ harness, session: "loan_APP-1012", prompt: "Pre-approve APP-1012." });
  expect(first.status).toBe("completed");
  // Both plans ran to completion in the session; the second got the first one's record back.
  expect(planResults(prompts[2])).toMatchObject([
    { status: "completed", output: { recordId: "rec_1" } },
    { status: "completed", output: { recordId: "rec_1" } },
  ]);
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({ applicationId: "APP-1012", letter: "Approved, first draft.", session: "loan_APP-1012" });
  expect(writes[0]?.idempotencyKey).toMatch(/^idem_/);

  // Another session is another conversation: the tool runs again.
  await generateHarness({ harness, session: "loan_APP-1012_review", prompt: "Pre-approve APP-1012." });
  expect(writes.map((write) => write.session)).toEqual(["loan_APP-1012", "loan_APP-1012_review"]);
});

it("leaves a call the agent makes itself alone", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "once-direct-"));
  dirs.push(dataDir);
  let writes = 0;
  const notify = once(
    tool({
      description: "Notify the applicant.",
      inputSchema: jsonSchema<{ applicationId: string }>({ type: "object" }),
      execute: async () => {
        writes += 1;
        return { sent: true };
      },
    }),
  );
  let call = 0;
  const model = new MockLanguageModelV3({
    provider: "test",
    modelId: "direct",
    doGenerate: async () => {
      call += 1;
      return call <= 2
        ? {
            content: [{ type: "tool-call", toolCallId: `call_${call}`, toolName: "notify", input: JSON.stringify({ applicationId: "APP-1" }) }],
            finishReason: { unified: "tool-calls", raw: "tool-calls" },
            usage,
            warnings: [],
          }
        : { content: [{ type: "text", text: "done" }], finishReason: { unified: "stop", raw: "stop" }, usage, warnings: [] };
    },
  });
  const harness = createHarness({ host: localHost({ dataDir }), model, tools: { notify }, runtime: { bash: false } });

  await generateHarness({ harness, session: "s", prompt: "Notify APP-1 twice." });
  expect(writes).toBe(2);
});
