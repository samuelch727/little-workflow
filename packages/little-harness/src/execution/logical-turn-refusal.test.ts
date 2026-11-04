import { APICallError } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { expect, it } from "vitest";
import { createHarness } from "../create-harness.js";
import { localHost } from "../local-host/index.js";
import { withTempDir } from "../test/temp.js";
import { generateHarness } from "./generate-harness.js";
import { streamHarness } from "./stream-harness.js";

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };

function flaky(error: Error = new APICallError({
  message: "Overloaded", url: "https://provider.invalid/model", requestBodyValues: {},
  statusCode: 529, isRetryable: true, responseHeaders: { "retry-after-ms": "0" },
}), failures = 1) {
  let calls = 0;
  const attempt = () => {
    if (++calls <= failures) throw error;
  };
  const model = new MockLanguageModelV3({
    doGenerate: async () => {
      attempt();
      return { content: [{ type: "text", text: "done" }], usage, warnings: [], finishReason: { unified: "stop", raw: "stop" } };
    },
    doStream: async () => {
      attempt();
      return { stream: new ReadableStream({ start(c) {
        c.enqueue({ type: "stream-start", warnings: [] });
        c.enqueue({ type: "text-start", id: "text" });
        c.enqueue({ type: "text-delta", id: "text", delta: "done" });
        c.enqueue({ type: "text-end", id: "text" });
        c.enqueue({ type: "finish", usage, finishReason: { unified: "stop", raw: "stop" } });
        c.close();
      } }) };
    },
  });
  return { model, calls: () => calls };
}

it.each(["generate", "stream"] as const)("retries the owner's HTTP 529 case with run accounting (%s)", async mode => {
  await withTempDir(async dir => {
    const model = flaky();
    const harness = createHarness({ host: localHost({ dataDir: dir }), model: model.model, runtime: { bash: false }, turnLimits: { accounting: "run", maxSteps: 4 } });
    const options = { harness, session: "s", runId: "root", prompt: "Go" };
    const result = mode === "generate" ? await generateHarness(options) : await streamHarness(options).finished;
    expect(result.status).toBe("completed");
    expect(model.calls()).toBe(2);
  });
});

it.each(["generate", "stream"] as const)("counts a refused attempt against the logical step ceiling (%s)", async mode => {
  await withTempDir(async dir => {
    const model = flaky();
    const harness = createHarness({ host: localHost({ dataDir: dir }), model: model.model, runtime: { bash: false }, turnLimits: { accounting: "logical-turn", maxSteps: 1 } });
    const options = { harness, session: "s", runId: "root", prompt: "Go" };
    await expect(mode === "generate" ? generateHarness(options) : streamHarness(options).finished)
      .rejects.toMatchObject({ name: "StepLimitExceeded", reason: "StepLimitExceeded" });
    expect(model.calls()).toBe(1);
  });
});

it.each(["generate", "stream"] as const)("retains the unknown attempt across a fresh count-only host (%s)", async mode => {
  await withTempDir(async dir => {
    const model = flaky();
    const create = () => createHarness({ host: localHost({ dataDir: dir }), model: model.model, runtime: { bash: false }, turnLimits: { accounting: "logical-turn", maxSteps: 2 } });
    const options = { session: "s", runId: "root", prompt: "Go", maxRetries: 0 };
    const first = create();
    await expect(mode === "generate" ? generateHarness({ ...options, harness: first }) : streamHarness({ ...options, harness: first }).finished).rejects.toMatchObject({ name: "AI_APICallError" });
    const harness = create();
    const result = mode === "generate" ? await generateHarness({ ...options, harness }) : await streamHarness({ ...options, harness }).finished;
    expect(result.status).toBe("completed");
    expect(model.calls()).toBe(2);
    const state = await harness.config.host.durable!.turnBudgets!.inspect({ version: "lh.turn-budget.v1", sessionId: "s", originRunId: "root" });
    expect(state.steps).toBe(2);
    expect(state.receipts.map(receipt => receipt.state)).toEqual(["reserved", "settled"]);
    await expect(harness.config.host.durable!.turnBudgets!.reserve(state.ref, { runId: "root", model: "test/model" })).rejects.toMatchObject({ reason: "StepLimitExceeded" });
    const priced = createHarness({ host: localHost({ dataDir: dir }), model: model.model, runtime: { bash: false }, turnLimits: { accounting: "logical-turn", maxSteps: 2, maxCostUsd: 3, price: () => .1 } });
    await expect(mode === "generate" ? generateHarness({ ...options, harness: priced }) : streamHarness({ ...options, harness: priced }).finished).rejects.toMatchObject({ reason: "BudgetStateUnavailable" });
  });
});

for (const error of [
  new APICallError({ message: "Overloaded", url: "https://provider.invalid/model", requestBodyValues: {}, statusCode: 529, isRetryable: true, responseHeaders: { "retry-after-ms": "0" } }),
  new APICallError({ message: "Invalid JSON response after generation", url: "https://provider.invalid/model", requestBodyValues: {}, statusCode: 200, isRetryable: true, responseHeaders: { "retry-after-ms": "0" } }),
  new TypeError("Transport failed after submission"),
]) it.each(["generate", "stream"] as const)(`holds unknown spend after ${error.message} (%s)`, async mode => {
  await withTempDir(async dir => {
    const model = flaky(error);
    const create = () => createHarness({ host: localHost({ dataDir: dir }), model: model.model, runtime: { bash: false }, turnLimits: { accounting: "logical-turn", maxSteps: 4, maxCostUsd: 3, price: () => .1 } });
    let harness = create();
    const options = { session: "s", runId: "root", prompt: "Go" };
    await expect(mode === "generate" ? generateHarness({ ...options, harness }) : streamHarness({ ...options, harness }).finished).rejects.toBeDefined();
    harness = create();
    await expect(mode === "generate" ? generateHarness({ ...options, harness }) : streamHarness({ ...options, harness }).finished).rejects.toMatchObject({ reason: "BudgetStateUnavailable" });
    expect(model.calls()).toBe(1);
    const state = await harness.config.host.durable!.turnBudgets!.inspect({ version: "lh.turn-budget.v1", sessionId: "s", originRunId: "root" });
    expect(state.steps).toBe(1);
    expect(state.receipts[0]).toMatchObject({ state: "reserved" });
    expect(state.receipts[0]).not.toHaveProperty("usage");
    expect(state.receipts[0]).not.toHaveProperty("costUsd");
  });
});

it("does not classify an errored partial stream as a free refusal", async () => {
  await withTempDir(async dir => {
    let calls = 0;
    const model = new MockLanguageModelV3({ doStream: async () => {
      calls++;
      return { stream: new ReadableStream({ start(c) {
        c.enqueue({ type: "stream-start", warnings: [] });
        c.enqueue({ type: "text-start", id: "text" });
        c.enqueue({ type: "text-delta", id: "text", delta: "partial output" });
        c.enqueue({ type: "error", error: new APICallError({ message: "Stream failed", url: "https://provider.invalid/model", requestBodyValues: {}, statusCode: 529, isRetryable: true }) });
        c.close();
      } }) };
    } });
    const create = () => createHarness({ host: localHost({ dataDir: dir }), model, runtime: { bash: false }, turnLimits: { accounting: "logical-turn", maxSteps: 4, maxCostUsd: 3, price: () => .1 } });
    const options = { session: "s", runId: "root", prompt: "Go" };
    await expect(streamHarness({ ...options, harness: create() }).finished).rejects.toBeDefined();
    const harness = create();
    await expect(streamHarness({ ...options, harness }).finished).rejects.toMatchObject({ reason: "BudgetStateUnavailable" });
    expect(calls).toBe(1);
    const state = await harness.config.host.durable!.turnBudgets!.inspect({ version: "lh.turn-budget.v1", sessionId: "s", originRunId: "root" });
    expect(state.receipts[0]).toMatchObject({ state: "reserved" });
    expect(state.receipts[0]).not.toHaveProperty("usage");
  });
});

it.each(["generate", "stream"] as const)("keeps spend unknown when aborted after provider entry (%s)", async mode => {
  await withTempDir(async dir => {
    let calls = 0;
    const controller = new AbortController();
    const abort = () => {
      calls++;
      controller.abort(new DOMException("Stopped after provider entry", "AbortError"));
      throw controller.signal.reason;
    };
    const model = new MockLanguageModelV3({ doGenerate: async () => abort(), doStream: async () => abort() });
    const create = () => createHarness({ host: localHost({ dataDir: dir }), model, runtime: { bash: false }, turnLimits: { accounting: "logical-turn", maxSteps: 4, maxCostUsd: 3, price: () => .1 } });
    const options = { session: "s", runId: "root", prompt: "Go" };
    const first = { ...options, harness: create(), abortSignal: controller.signal };
    await expect(mode === "generate" ? generateHarness(first) : streamHarness(first).finished).rejects.toBeDefined();
    const harness = create();
    await expect(mode === "generate" ? generateHarness({ ...options, harness }) : streamHarness({ ...options, harness }).finished).rejects.toMatchObject({ reason: "BudgetStateUnavailable" });
    expect(calls).toBe(1);
    const state = await harness.config.host.durable!.turnBudgets!.inspect({ version: "lh.turn-budget.v1", sessionId: "s", originRunId: "root" });
    expect(state.steps).toBe(1);
    expect(state.receipts[0]).toMatchObject({ state: "reserved" });
    expect(state.receipts[0]).not.toHaveProperty("usage");
  });
});

it.each(["generate", "stream"] as const)("distinguishes a trusted admission refusal before provider entry (%s)", async mode => {
  await withTempDir(async dir => {
    const model = flaky(undefined, 0);
    const harness = createHarness({ host: localHost({ dataDir: dir }), model: model.model, runtime: { bash: false }, turnLimits: { accounting: "logical-turn", maxSteps: 4, maxCostUsd: 3, price: () => .1 } });
    const options = { harness, session: "s", runId: "root", prompt: "Go" };
    const refused = { ...options, beforeInvocation: async () => { throw new Error("Admission refused before I/O"); } };
    await expect(mode === "generate" ? generateHarness(refused) : streamHarness(refused).finished).rejects.toThrow("Admission refused before I/O");
    expect(model.calls()).toBe(0);
    expect(await harness.config.host.durable!.turnBudgets!.inspect({ version: "lh.turn-budget.v1", sessionId: "s", originRunId: "root" })).toMatchObject({ steps: 0, receipts: [] });
    expect((mode === "generate" ? await generateHarness(options) : await streamHarness(options).finished).status).toBe("completed");
    expect(model.calls()).toBe(1);
  });
});

it.each(["generate", "stream"] as const)("retries the owner's HTTP 529 case with count-only logical accounting (%s)", async mode => {
  await withTempDir(async dir => {
    const model = flaky();
    const harness = createHarness({ host: localHost({ dataDir: dir }), model: model.model, runtime: { bash: false }, turnLimits: { accounting: "logical-turn", maxSteps: 4 } });
    const options = { harness, session: "s", runId: "root", prompt: "Go" };
    const result = mode === "generate" ? await generateHarness(options) : await streamHarness(options).finished;
    expect(result.status).toBe("completed");
    expect(model.calls()).toBe(2);
    const state = await harness.config.host.durable!.turnBudgets!.inspect({ version: "lh.turn-budget.v1", sessionId: "s", originRunId: "root" });
    expect(state.steps).toBe(2);
    expect(state.receipts.map(receipt => receipt.state)).toEqual(["reserved", "settled"]);
    expect(state.receipts[0]).not.toHaveProperty("usage");
    expect(state.receipts[0]).not.toHaveProperty("costUsd");
  });
});

// G25: a host may attest that a provider's own rejection had no effect.
const anthropicLike = (error: unknown) => APICallError.isInstance(error) && (error.statusCode === 429 || error.statusCode === 529);
const ref = { version: "lh.turn-budget.v1", sessionId: "s", originRunId: "root" } as const;

it.each(["generate", "stream"] as const)("settles a host-attested refusal and retries within a priced budget (%s)", async mode => {
  await withTempDir(async dir => {
    const model = flaky();
    const asked: unknown[] = [];
    const harness = createHarness({ host: localHost({ dataDir: dir }), model: model.model, runtime: { bash: false }, turnLimits: {
      accounting: "logical-turn", maxSteps: 4, maxCostUsd: 3, price: () => .1,
      refusedBeforeEffect: (error, call) => { asked.push(call); return anthropicLike(error); },
    } });
    const options = { harness, session: "s", runId: "root", prompt: "Go" };
    const result = mode === "generate" ? await generateHarness(options) : await streamHarness(options).finished;
    expect(result.status).toBe("completed");
    expect(model.calls()).toBe(2);
    expect(asked).toEqual([{ provider: "mock-provider", modelId: "mock-model-id" }]);
    const state = await harness.config.host.durable!.turnBudgets!.inspect(ref);
    expect(state.steps).toBe(2);
    expect(state.costUsd).toBeCloseTo(.1);
    expect(state.receipts.map(receipt => receipt.state)).toEqual(["refused", "settled"]);
    expect(state.receipts[0]).toEqual({ occurrenceId: "root:model:1", runId: "root", model: "mock-provider/mock-model-id", state: "refused", refusal: "host-attested" });
  });
});

it.each(["generate", "stream"] as const)("still counts a host-attested refusal as a step (%s)", async mode => {
  await withTempDir(async dir => {
    const model = flaky(undefined, 5);
    const harness = createHarness({ host: localHost({ dataDir: dir }), model: model.model, runtime: { bash: false }, turnLimits: {
      accounting: "logical-turn", maxSteps: 2, maxCostUsd: 3, price: () => .1, refusedBeforeEffect: anthropicLike,
    } });
    const options = { harness, session: "s", runId: "root", prompt: "Go", maxRetries: 4 };
    await expect(mode === "generate" ? generateHarness(options) : streamHarness(options).finished)
      .rejects.toMatchObject({ name: "StepLimitExceeded", reason: "StepLimitExceeded" });
    expect(model.calls()).toBe(2);
    expect((await harness.config.host.durable!.turnBudgets!.inspect(ref)).receipts.map(receipt => receipt.state)).toEqual(["refused", "refused"]);
  });
});

it.each(["generate", "stream"] as const)("keeps a host-attested refusal across a restart (%s)", async mode => {
  await withTempDir(async dir => {
    const model = flaky();
    const create = () => createHarness({ host: localHost({ dataDir: dir }), model: model.model, runtime: { bash: false }, turnLimits: {
      accounting: "logical-turn", maxSteps: 4, maxCostUsd: 3, price: () => .1, refusedBeforeEffect: anthropicLike,
    } });
    const options = { session: "s", runId: "root", prompt: "Go", maxRetries: 0 };
    const first = create();
    await expect(mode === "generate" ? generateHarness({ ...options, harness: first }) : streamHarness({ ...options, harness: first }).finished).rejects.toMatchObject({ name: "AI_APICallError" });
    const harness = create();
    const result = mode === "generate" ? await generateHarness({ ...options, harness }) : await streamHarness({ ...options, harness }).finished;
    expect(result.status).toBe("completed");
    expect((await harness.config.host.durable!.turnBudgets!.inspect(ref)).receipts.map(receipt => receipt.state)).toEqual(["refused", "settled"]);
  });
});

for (const [label, error] of [
  ["a malformed 200", new APICallError({ message: "Invalid JSON response after generation", url: "https://provider.invalid/model", requestBodyValues: {}, statusCode: 200, isRetryable: true, responseHeaders: { "retry-after-ms": "0" } })],
  ["a 500", new APICallError({ message: "Internal error", url: "https://provider.invalid/model", requestBodyValues: {}, statusCode: 500, isRetryable: true, responseHeaders: { "retry-after-ms": "0" } })],
  ["a transport error", new TypeError("Transport failed after submission")],
] as const) it.each(["generate", "stream"] as const)(`holds ${label} the host doesn't attest (%s)`, async mode => {
  await withTempDir(async dir => {
    const model = flaky(error);
    const create = () => createHarness({ host: localHost({ dataDir: dir }), model: model.model, runtime: { bash: false }, turnLimits: {
      accounting: "logical-turn", maxSteps: 4, maxCostUsd: 3, price: () => .1, refusedBeforeEffect: anthropicLike,
    } });
    const options = { session: "s", runId: "root", prompt: "Go" };
    await expect(mode === "generate" ? generateHarness({ ...options, harness: create() }) : streamHarness({ ...options, harness: create() }).finished).rejects.toBeDefined();
    const harness = create();
    await expect(mode === "generate" ? generateHarness({ ...options, harness }) : streamHarness({ ...options, harness }).finished).rejects.toMatchObject({ reason: "BudgetStateUnavailable" });
    expect(model.calls()).toBe(1);
    expect((await harness.config.host.durable!.turnBudgets!.inspect(ref)).receipts).toEqual([{ occurrenceId: "root:model:1", runId: "root", model: "mock-provider/mock-model-id", state: "reserved" }]);
  });
});

it.each(["generate", "stream"] as const)("treats a hook that throws as no attestation (%s)", async mode => {
  await withTempDir(async dir => {
    const model = flaky();
    const harness = createHarness({ host: localHost({ dataDir: dir }), model: model.model, runtime: { bash: false }, turnLimits: {
      accounting: "logical-turn", maxSteps: 4, maxCostUsd: 3, price: () => .1, refusedBeforeEffect: () => { throw new Error("host check failed"); },
    } });
    const options = { harness, session: "s", runId: "root", prompt: "Go" };
    await expect(mode === "generate" ? generateHarness(options) : streamHarness(options).finished).rejects.toMatchObject({ name: "BudgetStateUnavailable", reason: "BudgetStateUnavailable" });
    expect(model.calls()).toBe(1);
    expect((await harness.config.host.durable!.turnBudgets!.inspect(ref)).receipts[0]).toMatchObject({ state: "reserved" });
  });
});

it("never asks the host about an error inside a stream that began", async () => {
  await withTempDir(async dir => {
    let asked = 0;
    const model = new MockLanguageModelV3({ doStream: async () => ({ stream: new ReadableStream({ start(c) {
      c.enqueue({ type: "stream-start", warnings: [] });
      c.enqueue({ type: "text-start", id: "text" });
      c.enqueue({ type: "text-delta", id: "text", delta: "partial output" });
      c.enqueue({ type: "error", error: new APICallError({ message: "Overloaded", url: "https://provider.invalid/model", requestBodyValues: {}, statusCode: 529, isRetryable: true }) });
      c.close();
    } }) }) });
    const create = () => createHarness({ host: localHost({ dataDir: dir }), model, runtime: { bash: false }, turnLimits: {
      accounting: "logical-turn", maxSteps: 4, maxCostUsd: 3, price: () => .1, refusedBeforeEffect: () => { asked++; return true; },
    } });
    const options = { session: "s", runId: "root", prompt: "Go" };
    await expect(streamHarness({ ...options, harness: create() }).finished).rejects.toBeDefined();
    const harness = create();
    await expect(streamHarness({ ...options, harness }).finished).rejects.toMatchObject({ reason: "BudgetStateUnavailable" });
    expect(asked).toBe(0);
    expect((await harness.config.host.durable!.turnBudgets!.inspect(ref)).receipts[0]).toMatchObject({ state: "reserved" });
  });
});

it.each(["generate", "stream"] as const)("never asks the host about an abort after provider entry (%s)", async mode => {
  await withTempDir(async dir => {
    let asked = 0;
    const controller = new AbortController();
    const abort = () => { controller.abort(new DOMException("Stopped after provider entry", "AbortError")); throw controller.signal.reason; };
    const model = new MockLanguageModelV3({ doGenerate: async () => abort(), doStream: async () => abort() });
    const harness = createHarness({ host: localHost({ dataDir: dir }), model, runtime: { bash: false }, turnLimits: {
      accounting: "logical-turn", maxSteps: 4, maxCostUsd: 3, price: () => .1, refusedBeforeEffect: () => { asked++; return true; },
    } });
    const options = { harness, session: "s", runId: "root", prompt: "Go", abortSignal: controller.signal };
    await expect(mode === "generate" ? generateHarness(options) : streamHarness(options).finished).rejects.toBeDefined();
    expect(asked).toBe(0);
    expect((await harness.config.host.durable!.turnBudgets!.inspect(ref)).receipts[0]).toMatchObject({ state: "reserved" });
  });
});

it("refuses refusedBeforeEffect without logical-turn accounting", async () => {
  await withTempDir(async dir => {
    const model = flaky(undefined, 0);
    const harness = createHarness({ host: localHost({ dataDir: dir }), model: model.model, runtime: { bash: false }, turnLimits: { maxSteps: 4, refusedBeforeEffect: anthropicLike } });
    await expect(generateHarness({ harness, session: "s", prompt: "Go" })).rejects.toThrow(/refusedBeforeEffect needs accounting/);
    expect(model.calls()).toBe(0);
  });
});

it("keeps a refused occurrence from being settled or a settled one from being refused", async () => {
  await withTempDir(async dir => {
    const harness = createHarness({ host: localHost({ dataDir: dir }), model: flaky(undefined, 0).model, runtime: { bash: false } });
    const ledger = harness.config.host.durable!.turnBudgets!;
    await ledger.open(ref, { maxSteps: 4, maxCostUsd: 3 }, { create: true });
    const first = await ledger.reserve(ref, { runId: "root", model: "test/model" });
    await ledger.refuse!(ref, { occurrenceId: first });
    await ledger.refuse!(ref, { occurrenceId: first });
    const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2, inputTokenDetails: { noCacheTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, outputTokenDetails: { textTokens: 1, reasoningTokens: 0 } };
    const receipt = { usage, costUsd: .1, pricedModel: "test/model", responseDigest: `sha256:${"a".repeat(64)}` };
    await expect(ledger.settle(ref, { occurrenceId: first, ...receipt })).rejects.toMatchObject({ reason: "BudgetStateUnavailable" });
    const second = await ledger.reserve(ref, { runId: "root", model: "test/model" });
    await ledger.settle(ref, { occurrenceId: second, ...receipt });
    await expect(ledger.refuse!(ref, { occurrenceId: second })).rejects.toMatchObject({ reason: "BudgetStateUnavailable" });
    await expect(ledger.refuse!(ref, { occurrenceId: "root:model:9" })).rejects.toMatchObject({ reason: "BudgetStateUnavailable" });
    expect(await ledger.inspect(ref)).toMatchObject({ steps: 2, costUsd: .1, receipts: [{ state: "refused", refusal: "host-attested" }, { state: "settled" }] });
  });
});

it.each(["generate", "stream"] as const)("fails with the limit's own reason when a retried call reaches it (%s)", async mode => {
  await withTempDir(async dir => {
    const model = flaky();
    const events: { type: string; metadata?: unknown }[] = [];
    const harness = createHarness({ host: localHost({ dataDir: dir }), model: model.model, runtime: { bash: false }, turnLimits: { accounting: "logical-turn", maxSteps: 4, maxCostUsd: 3, price: () => .1 } });
    const options = { harness, session: "s", runId: "root", prompt: "Go", onEvent: (event: { type: string; metadata?: unknown }) => { events.push(event); } };
    await expect(mode === "generate" ? generateHarness(options) : streamHarness(options).finished).rejects.toMatchObject({ name: "BudgetStateUnavailable", reason: "BudgetStateUnavailable" });
    expect(events.find(event => event.type === "harness.session.failed")?.metadata).toMatchObject({ reason: "BudgetStateUnavailable" });
  });
});
