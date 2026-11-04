import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineWorkflow, localWorld, model, runWorkflow } from "@little-stack/workflow";
import { MockLanguageModelV3 } from "ai/test";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createLittleDB } from "../client.js";
import type { ClaimedRun } from "../contract.js";
import { fakeLittleDB } from "../test/fake-littledb.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** The tunable parts of the workflow's steps, as its LittleDB version holds them. */
type StepConfig = { steps: Record<"classify" | "reply", { model: string; prompt: string }> };

const V1: StepConfig = {
  steps: {
    classify: { model: "fast", prompt: "Classify this request: {{ input.message }}" },
    reply: { model: "fast", prompt: "Answer the customer. The request is: {{ steps.classify.output }}" },
  },
};
const V2: StepConfig = { steps: { ...V1.steps, classify: { model: "fast", prompt: "Read the refund policy, then classify: {{ input.message }}" } } };

/** A model that answers from the prompt it got: "refund" only when told to read the policy. */
function haiku() {
  const answer = (prompt: unknown) => {
    const text = JSON.stringify(prompt);
    return text.includes("refund policy") ? "refund" : text.includes("Answer the customer") ? "We are on it." : "other";
  };
  const usage = { inputTokens: { total: 50, noCache: 50, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 3, text: 3, reasoning: 0 } };
  return new MockLanguageModelV3({
    provider: "anthropic.messages",
    modelId: "claude-haiku-5-5",
    doGenerate: async (options) => ({ content: [{ type: "text", text: answer(options.prompt) }], finishReason: { unified: "stop", raw: "end_turn" }, usage, warnings: [] }),
    doStream: async (options) => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({ type: "text-start", id: "0" });
          controller.enqueue({ type: "text-delta", id: "0", delta: answer(options.prompt) });
          controller.enqueue({ type: "text-end", id: "0" });
          controller.enqueue({ type: "finish", finishReason: { unified: "stop", raw: "end_turn" }, usage });
          controller.close();
        },
      }),
    }),
  });
}

/** The app's workflow, built from a version's step config. */
function triage(config: StepConfig) {
  return defineWorkflow({
    id: "support.triage",
    input: z.object({ message: z.string() }),
    output: z.object({ label: z.string(), reply: z.string() }),
    models: [model(haiku(), { id: "fast" })],
    plan: {
      steps: [
        { id: "classify", uses: "ai.generate", with: { model: config.steps.classify.model, prompt: config.steps.classify.prompt }, output: { mode: "text" } },
        { id: "reply", uses: "ai.generate", needs: ["classify"], with: { model: config.steps.reply.model, prompt: config.steps.reply.prompt }, output: { mode: "text" } },
        {
          id: "result",
          uses: "tool.call",
          needs: ["classify", "reply"],
          with: { tool: "pack", args: { label: "{{ steps.classify.output }}", reply: "{{ steps.reply.output }}" } },
          output: { mode: "json", schema: true },
        },
      ],
    } as never,
    tools: {
      pack: {
        description: "Return the label and the reply.",
        inputSchema: z.object({ label: z.string(), reply: z.string() }),
        execute: async (args: { label: string; reply: string }) => args,
      },
    } as never,
  });
}

function claimed(n: number, content: StepConfig, overrides: Partial<ClaimedRun> = {}): ClaimedRun {
  return {
    runId: `run_${n}`,
    experimentId: "exp_1",
    traceId: `exp_run_${n}`,
    repetition: 0,
    leaseUntil: "2026-10-01T00:10:00.000Z",
    subject: { kind: "workflow", slug: "support.triage" },
    version: { id: `ver_${n}`, number: n, content, externalId: null },
    item: { id: `itm_${n}`, input: { message: "My boots arrived torn, I want my money back." }, expected: { label: "refund" }, metadata: {} },
    ...overrides,
  };
}

async function dataDir() {
  const dir = await mkdtemp(join(tmpdir(), "ldb-eval-"));
  dirs.push(dir);
  return dir;
}

describe("workflowEvalWorker", () => {
  it("runs each version's content on the item in a traced World, and grades the output", async () => {
    const fake = fakeLittleDB();
    fake.pendingRuns.push(claimed(1, V1), claimed(2, V2));
    const db = createLittleDB({ url: fake.url, apiKey: fake.apiKey, fetch: fake.fetch, flushIntervalMs: 60_000 });
    const dir = await dataDir();
    const worker = db.workflowEvalWorker({
      workflow: "support.triage",
      concurrency: 2,
      world: () => localWorld({ dataDir: dir }),
      run: ({ content, input, world }) => runWorkflow(triage(content as StepConfig), input as { message: string }, { world }),
      grade: ({ output, expected }) => [{ name: "correct_label", value: (output as { label: string }).label === (expected as { label: string }).label ? 1 : 0 }],
    });
    expect(await worker.runOnce()).toEqual({ claimed: 2, completed: 2, failed: 0 });
    expect(fake.requests[0]?.body).toMatchObject({ subjects: ["workflow:support.triage"], limit: 2 });

    // The content decided what the model was told, and the grade followed.
    const done = (runId: string) => fake.completions.find((c) => c.runId === runId)?.body as { output: { label: string }; scores: unknown };
    expect(done("run_1")).toMatchObject({ traceId: "exp_run_1", output: { label: "other" }, scores: [{ name: "correct_label", value: 0 }] });
    expect(done("run_2")).toMatchObject({ traceId: "exp_run_2", output: { label: "refund", reply: "We are on it." }, scores: [{ name: "correct_label", value: 1 }] });

    // Each run is one trace, tagged with its experiment, item and version.
    expect(fake.traces.get("exp_run_2")).toMatchObject({
      kind: "experiment",
      workflow: "support.triage",
      workflowOrigin: "code",
      versionId: "ver_2",
      environment: "experiment",
      experimentId: "exp_1",
      datasetItemId: "itm_2",
    });
    const spans = fake.spansOf("exp_run_2");
    expect(spans.filter((s) => s.type === "step").map((s) => s.name)).toEqual(["classify", "reply", "result"]);
    // A model call carries its step's prompt as it ran, so a reviewer can read it.
    const classify = spans.find((s) => s.type === "step" && s.name === "classify");
    const llm = spans.find((s) => s.type === "llm" && s.parentId === classify?.id);
    expect(llm).toMatchObject({
      model: "claude-haiku-5-5",
      input: { prompt: "Read the refund policy, then classify: My boots arrived torn, I want my money back." },
      attributes: { stepPath: "classify", modelSlot: "fast" },
      usage: { inputTokens: 50, outputTokens: 3 },
    });
    expect(spans.find((s) => s.id === "root")).toMatchObject({ type: "workflow", status: "ok", output: { label: "refund" } });
  });

  it("fails a run whose workflow fails, so LittleDB retries it, and grades nothing", async () => {
    const fake = fakeLittleDB();
    // A version whose step names a model slot the app does not have.
    fake.pendingRuns.push(claimed(3, { steps: { ...V1.steps, reply: { model: "deep", prompt: "Answer." } } }));
    const db = createLittleDB({ url: fake.url, apiKey: fake.apiKey, fetch: fake.fetch, onError: () => {} });
    const dir = await dataDir();
    let graded = 0;
    const worker = db.workflowEvalWorker({
      workflow: "support.triage",
      world: () => localWorld({ dataDir: dir }),
      run: ({ content, input, world }) => runWorkflow(triage(content as StepConfig), input as { message: string }, { world }),
      grade: () => {
        graded += 1;
        return [];
      },
    });
    expect(await worker.runOnce()).toEqual({ claimed: 1, completed: 0, failed: 1 });
    const body = fake.completions[0]?.body as { traceId: string; error?: string; scores?: unknown };
    expect(body.traceId).toBe("exp_run_3");
    expect(body.error).toMatch(/deep/);
    expect(body.scores).toBeUndefined();
    expect(graded).toBe(0);
  });

  it("needs the workflow's slug", () => {
    const fake = fakeLittleDB();
    const db = createLittleDB({ url: fake.url, apiKey: fake.apiKey, fetch: fake.fetch });
    expect(() => db.workflowEvalWorker({ workflow: "", world: () => ({ appendEvent: async () => ({ runId: "", type: "", recordedAt: "", payload: {} }) }), run: async () => ({}) })).toThrow(TypeError);
  });
});

describe("agentWorkflowEvalWorker", () => {
  it("runs a proposed definition of an agent-made workflow, listed from the harness", async () => {
    const fake = fakeLittleDB();
    const db = createLittleDB({ url: fake.url, apiKey: fake.apiKey, fetch: fake.fetch, onError: () => {} });
    const definition = {
      id: "refund.check",
      description: "Check whether an order can be refunded.",
      inputSchema: { type: "object", properties: { orderId: { type: "string" } }, required: ["orderId"] },
      outputSchema: { type: "object" },
      tools: ["lookup_order"],
    };
    // The harness's agent defined it once, so the worker finds its handle.
    await db.agentWorkflowRegistry({ harness: "support" }).defined(
      { ...definition, handle: "refund_check", revision: 1, definedAt: "2026-10-21T00:00:00.000Z", sessionId: "s1" },
      { sessionId: "s1", turnId: "t1" },
    );
    fake.pendingRuns.push({
      runId: "run_a",
      experimentId: "exp_a",
      traceId: "trc_a",
      repetition: 0,
      leaseUntil: new Date(Date.now() + 60_000).toISOString(),
      subject: { kind: "workflow", slug: "refund_check" },
      version: { id: "ver_proposed", number: 2, content: { ...definition, policy: "Refuse refunds after 30 days." } },
      item: { id: "item_a", input: { orderId: "o_1" }, expected: { refundable: false } },
    });
    const seen: unknown[] = [];
    const worker = db.agentWorkflowEvalWorker({
      harness: "support",
      world: () => ({
        appendEvent: async (runId: string, event: { readonly type: string; readonly payload: Readonly<Record<string, unknown>> }) => ({
          runId,
          type: event.type,
          recordedAt: "2026-10-21T00:00:00.000Z",
          payload: event.payload,
        }),
      }),
      run: async ({ definition: proposed, input, world, handle }) => {
        seen.push(proposed.policy, input, handle);
        await world.appendEvent("wf_run", { type: "RunStarted", payload: { input } });
        return { output: { refundable: false } };
      },
      grade: ({ output, expected }) => [{ name: "correct", value: JSON.stringify(output) === JSON.stringify(expected) ? 1 : 0 }],
    });
    expect(await worker.runOnce()).toEqual({ claimed: 1, completed: 1, failed: 0 });
    expect(seen).toEqual(["Refuse refunds after 30 days.", { orderId: "o_1" }, "refund_check"]);
    const claim = fake.requests.find((r) => r.path === "/v1/worker/claim");
    expect(claim?.body).toMatchObject({ subjects: ["workflow:refund_check"] });
    expect(fake.completions[0]?.body).toMatchObject({ scores: [{ name: "correct", value: 1 }] });
    expect(fake.traces.get("trc_a")).toMatchObject({ workflow: "refund_check", workflowOrigin: "agent", harness: "support", environment: "experiment" });
  });
});
