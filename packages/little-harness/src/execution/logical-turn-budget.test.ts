import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { tool, type LanguageModel } from "ai";
import { MockLanguageModelV3, MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { inMemorySessionLog } from "../remote-session/session-log-store.js";
import { recordKey } from "../local-host/durable-store.js";
import { join } from "node:path";
import { sha256Digest } from "../events/durability.js";
import { createHarness } from "../create-harness.js";
import { harnessToolContext } from "../connectors/tool-context.js";
import { answerInputRequest, listInputRequests } from "../human-input/answers.js";
import { localHost, createInMemoryDurableStore, createInMemoryOrchestrationServices } from "../local-host/index.js";
import { withTempDir } from "../test/temp.js";
import { generateHarness } from "./generate-harness.js";
import { streamHarness } from "./stream-harness.js";
import { resumeParked } from "./resume-parked.js";
import type { Harness } from "../types.js";

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
function scripted(parks = 2) {
  let calls = 0;
  const next = () => {
    calls++;
    return calls <= parks
      ? { content: [{ type: "tool-call" as const, toolCallId: `call_${calls}`, toolName: "approve", input: JSON.stringify({ key: `card_${calls}` }) }], finishReason: { unified: "tool-calls" as const, raw: "tool-calls" } }
      : { content: [{ type: "text" as const, text: "done" }], finishReason: { unified: "stop" as const, raw: "stop" } };
  };
  const model = new MockLanguageModelV3({
    provider: "test", modelId: "priced",
    doGenerate: async () => ({ ...next(), usage, warnings: [] }),
    doStream: async () => {
      const response = next();
      return { stream: new ReadableStream({ start(controller) {
        controller.enqueue({ type: "stream-start", warnings: [] });
        for (const part of response.content) if (part.type === "text") {
          controller.enqueue({ type: "text-start", id: "text" }); controller.enqueue({ type: "text-delta", id: "text", delta: part.text }); controller.enqueue({ type: "text-end", id: "text" });
        } else controller.enqueue(part);
        controller.enqueue({ type: "finish", finishReason: response.finishReason, usage }); controller.close();
      } }) };
    },
  });
  return { model, calls: () => calls };
}
const approve = tool({ description: "Ask for approval.", inputSchema: z.object({ key: z.string() }), execute: async ({ key }, options) => {
  const result = await harnessToolContext(options).ask!({ question: key, options: [{ id: "yes", label: "Yes" }] }, { key, wait: true });
  return result.status === "parked" ? result.output : "approved";
} });
async function answer(harness: Harness) {
  const request = (await listInputRequests({ harness, sessionId: "s" }))[0];
  expect(request).toBeDefined();
  await answerInputRequest({ harness, sessionId: "s", requestId: request!.requestId, answer: { option: "yes" } });
}

describe("logical turn model budgets", () => {
  it.each(["generate", "stream"] as const)("persists one budget through two parks and fresh hosts (%s)", async mode => {
    await withTempDir(async dir => {
      const model = scripted();
      const create = () => createHarness({ host: localHost({ dataDir: dir, sandbox: "in-process" }), model: model.model, tools: { approve }, humanInput: { tool: false }, runtime: { bash: false }, turnLimits: { accounting: "logical-turn", maxSteps: 3, maxCostUsd: 3, price: () => .1 } });
      let harness = create();
      if (mode === "generate") expect((await generateHarness({ harness, session: "s", runId: "root", prompt: "Go" })).status).toBe("parked");
      else expect((await streamHarness({ harness, session: "s", runId: "root", prompt: "Go" }).finished).status).toBe("parked");
      harness = create(); await answer(harness);
      expect((await resumeParked({ harness })).resumed[0]!.result.status).toBe("parked");
      harness = create(); await answer(harness);
      expect((await resumeParked({ harness })).resumed[0]!.result.status).toBe("completed");
      expect(model.calls()).toBe(3);
      const state = await harness.config.host.durable!.turnBudgets!.inspect({ version: "lh.turn-budget.v1", sessionId: "s", originRunId: "root" });
      expect(state.steps).toBe(3); expect(state.costUsd).toBeCloseTo(.3);
    });
  });
  it("does not grant a third call after two approval parks exhaust two calls", async () => {
    await withTempDir(async dir => {
      const model = scripted();
      const harness = createHarness({ host: localHost({ dataDir: dir, sandbox: "in-process" }), model: model.model, tools: { approve }, humanInput: { tool: false }, runtime: { bash: false }, turnLimits: { accounting: "logical-turn", maxSteps: 2 } });
      await generateHarness({ harness, session: "s", runId: "root", prompt: "Go" });
      await answer(harness); await resumeParked({ harness }); await answer(harness);
      const result = await resumeParked({ harness, maxAttempts: 1 });
      expect(result.failed[0]!.error).toMatchObject({ reason: "StepLimitExceeded" });
      expect(model.calls()).toBe(2);
    });
  });
  it("keeps an ack-lost reservation held without reporting paid usage", async () => {
    await withTempDir(async dir => {
      const store = createInMemoryDurableStore();
      const write = store.writeJsonDurable!.bind(store);
      let fail = true;
      store.writeJsonDurable = async (path, value) => {
        await write(path, value);
        if (fail && (value as { steps: number }).steps === 1) { fail = false; throw new Error("lost reserve acknowledgement"); }
      };
      const services = createInMemoryOrchestrationServices({ store });
      const model = scripted(0);
      const harness = createHarness({ host: localHost({ dataDir: dir, orchestration: services, sandbox: "in-process" }), model: model.model, runtime: { bash: false }, turnLimits: { accounting: "logical-turn", maxSteps: 3, maxCostUsd: 3, price: () => .1 } });
      await expect(generateHarness({ harness, session: "s", runId: "root", prompt: "Go" })).rejects.toMatchObject({ reason: "BudgetStateUnavailable" });
      await expect(generateHarness({ harness, session: "s", runId: "root", prompt: "Go" })).rejects.toMatchObject({ reason: "BudgetStateUnavailable" });
      expect(model.calls()).toBe(0);
      const state = await services.turnBudgets!.inspect({ version: "lh.turn-budget.v1", sessionId: "s", originRunId: "root" });
      expect(state.costUsd).toBe(0); expect(state.receipts[0]!.state).toBe("reserved");
    });
  });
});


it.each(["steps", "cost"] as const)("keeps cumulative %s through two parks in three actual processes", async cap => {
  await withTempDir(async directory => {
    const child = async (stage: string) => {
      const result = await promisify(execFile)(process.execPath, ["--no-warnings", "--experimental-transform-types", fileURLToPath(new URL("../test/fixtures/logical-budget-process.mjs", import.meta.url)), directory, stage, cap], { env: {} });
      return JSON.parse(result.stdout.trim());
    };
    expect(await child("start")).toEqual({ status: "parked", calls: 1 });
    expect(await child("resume")).toEqual({ status: "parked", calls: 1 });
    expect(await child("resume")).toEqual({ status: "failed", reason: cap === "cost" ? "CostLimitExceeded" : "StepLimitExceeded", calls: 0 });
  });
});


it.each(["generate", "stream"] as const)("meters prepareStep model replacement (%s)", async mode => {
  await withTempDir(async dir => {
    const original = scripted(0); const replacement = scripted(0);
    const harness = createHarness({ host: localHost({ dataDir: dir }), model: original.model, runtime: { bash: false }, turnLimits: { accounting: "logical-turn", maxSteps: 1, price: () => .25 } });
    const options = { harness, session: "s", runId: "root", prompt: "Go", prepareStep: () => ({ model: replacement.model }) };
    if (mode === "generate") await generateHarness(options); else await streamHarness(options).finished;
    expect(original.calls()).toBe(0); expect(replacement.calls()).toBe(1);
    expect(await harness.config.host.durable!.turnBudgets!.inspect({ version: "lh.turn-budget.v1", sessionId: "s", originRunId: "root" })).toMatchObject({ steps: 1, costUsd: .25 });
  });
});

it("replays a persisted completed response without another paid call or debit", async () => {
  await withTempDir(async dir => {
    const log = inMemorySessionLog(); const model = scripted(0);
    const harness = createHarness({ host: localHost({ dataDir: dir }), model: model.model, sessionLog: log, runtime: { bash: false }, turnLimits: { accounting: "logical-turn", maxSteps: 1, maxCostUsd: 3, price: () => .5 } });
    const options = { harness, session: "s", runId: "root", prompt: "Go" };
    await generateHarness(options); await generateHarness(options);
    expect(model.calls()).toBe(1);
    expect(await harness.config.host.durable!.turnBudgets!.inspect({ version: "lh.turn-budget.v1", sessionId: "s", originRunId: "root" })).toMatchObject({ steps: 1, costUsd: .5 });
  });
});

it("a required model.called append failure cannot reach the provider", async () => {
  await withTempDir(async dir => {
    const log = inMemorySessionLog(); const model = scripted(0);
    const harness = createHarness({ host: localHost({ dataDir: dir }), model: model.model, sessionLog: { priorEvents: log.priorEvents, append: async event => { if (event.type === "harness.model.called") throw new Error("model start acknowledgement failed"); return log.append(event); } }, runtime: { bash: false }, turnLimits: { accounting: "logical-turn", maxSteps: 2 } });
    await expect(generateHarness({ harness, session: "s", runId: "root", prompt: "Go" })).rejects.toThrow();
    expect(model.calls()).toBe(0);
    expect(await harness.config.host.durable!.turnBudgets!.inspect({ version: "lh.turn-budget.v1", sessionId: "s", originRunId: "root" })).toMatchObject({ steps: 0, costUsd: 0 });
  });
});

it.each(["missing", "malformed", "mode", "caps"] as const)("refuses %s accounting on a continuation before provider I/O", async fault => {
  await withTempDir(async dir => {
    const model = scripted();
    const services = createInMemoryOrchestrationServices();
    const base = { host: localHost({ dataDir: dir, orchestration: services }), model: model.model, tools: { approve }, humanInput: { tool: false as const }, runtime: { bash: false as const } };
    const harness = createHarness({ ...base, turnLimits: { accounting: "logical-turn", maxSteps: 3 } });
    await generateHarness({ harness, session: "s", runId: "root", prompt: "Go" }); await answer(harness);
    const ref = { version: "lh.turn-budget.v1", sessionId: "s", originRunId: "root" } as const;
    if (fault === "missing" || fault === "malformed") {
      // The journal survives the specific budget-record loss/corruption.
      const store = createInMemoryDurableStore();
      const legacyServices = createInMemoryOrchestrationServices({ store });
      const state = await services.turnBudgets!.inspect(ref);
      await legacyServices.turnBudgets!.open(ref, state.caps, { create: true });
      const path = join("/in-memory", "turn-budgets", `${recordKey(ref)}.json`);
      if (fault === "missing") await store.remove(path); else await store.writeJson(path, { bad: "state" });
      const failed = createHarness({ ...base, host: localHost({ dataDir: dir, orchestration: { ...services, turnBudgets: legacyServices.turnBudgets! } }), turnLimits: { accounting: "logical-turn", maxSteps: 3 } });
      const result = await resumeParked({ harness: failed, maxAttempts: 1 });
      expect(result.failed[0]!.error).toMatchObject({ reason: "BudgetStateUnavailable" });
    } else {
      const changed = createHarness({ ...base, turnLimits: fault === "mode" ? { accounting: "run", maxSteps: 3 } : { accounting: "logical-turn", maxSteps: 4 } });
      const result = await resumeParked({ harness: changed, maxAttempts: 1 });
      expect(result.failed[0]!.error).toMatchObject({ reason: "BudgetStateUnavailable" });
    }
    expect(model.calls()).toBe(1);
  });
});

it("a repeated settlement is idempotent and a different receipt cannot overwrite it", async () => {
  const services = createInMemoryOrchestrationServices();
  const ref = { version: "lh.turn-budget.v1", sessionId: "s", originRunId: "root" } as const;
  await services.turnBudgets!.open(ref, { maxSteps: 3, maxCostUsd: 3 }, { create: true });
  const occurrenceId = await services.turnBudgets!.reserve(ref, { runId: "run", model: "test/priced" });
  const normalized = { inputTokens: 1, outputTokens: 1, totalTokens: 2, inputTokenDetails: { noCacheTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, outputTokenDetails: { textTokens: 1, reasoningTokens: 0 } };
  const response = { occurrenceId, usage: normalized, pricedModel: "priced", costUsd: .5, responseDigest: sha256Digest({ known: true }) };
  await services.turnBudgets!.settle(ref, response); await services.turnBudgets!.settle(ref, response);
  expect(await services.turnBudgets!.inspect(ref)).toMatchObject({ steps: 1, costUsd: .5 });
  await expect(services.turnBudgets!.settle(ref, { ...response, costUsd: 0 })).rejects.toMatchObject({ reason: "BudgetStateUnavailable" });
});


it.each(["generate", "stream"] as const)("awaits the trusted provider guard and refuses aliases (%s)", async mode => {
  await withTempDir(async dir => {
    const model = scripted(0);
    const harness = createHarness({ host: localHost({ dataDir: dir }), model: model.model, runtime: { bash: false } });
    let checked = 0;
    const options = { harness, session: "s", prompt: "Go", beforeInvocation: async () => { await Promise.resolve(); checked++; throw new Error("dispatch cancelled"); } };
    const run = () => mode === "generate" ? generateHarness(options) : streamHarness(options).finished;
    await expect(run()).rejects.toThrow("dispatch cancelled");
    expect(checked).toBeGreaterThan(0); expect(model.calls()).toBe(0);
    const alias = { ...options, model: "test/alias" as const, beforeInvocation: async () => {} };
    await expect(mode === "generate" ? generateHarness(alias) : streamHarness(alias).finished).rejects.toMatchObject({ name: "HarnessInputError" });
    expect(model.calls()).toBe(0);
  });
});

it.each(["generate", "stream"] as const)("denies unknown usage without refunding its reservation (%s)", async mode => {
  await withTempDir(async dir => {
    let calls = 0;
    const invalid = { inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
    const model = new MockLanguageModelV3({ doGenerate: async () => { calls++; return { content: [{ type: "text", text: "unconfirmed" }], usage: invalid, warnings: [], finishReason: { unified: "stop", raw: "stop" } }; }, doStream: async () => { calls++; return { stream: new ReadableStream({ start(c) { c.enqueue({ type: "stream-start", warnings: [] }); c.enqueue({ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: invalid }); c.close(); } }) }; } });
    const harness = createHarness({ host: localHost({ dataDir: dir }), model, runtime: { bash: false }, turnLimits: { accounting: "logical-turn", maxSteps: 3, maxCostUsd: 3, price: () => .1 } });
    const run = () => mode === "generate" ? generateHarness({ harness, session: "s", runId: "root", prompt: "Go" }) : streamHarness({ harness, session: "s", runId: "root", prompt: "Go" }).finished;
    await expect(run()).rejects.toMatchObject({ reason: "BudgetStateUnavailable" });
    await expect(run()).rejects.toMatchObject({ reason: "BudgetStateUnavailable" });
    expect(calls).toBe(1);
    expect(await harness.config.host.durable!.turnBudgets!.inspect({ version: "lh.turn-budget.v1", sessionId: "s", originRunId: "root" })).toMatchObject({ steps: 1, costUsd: 0, receipts: [{ state: "reserved" }] });
  });
});

it.each([NaN, -1, Infinity, "throws"] as const)("fails closed when response pricing is %s", async invalid => {
  await withTempDir(async dir => {
    const model = scripted(0);
    const harness = createHarness({ host: localHost({ dataDir: dir }), model: model.model, runtime: { bash: false }, turnLimits: { accounting: "logical-turn", maxSteps: 3, maxCostUsd: 3, price: () => { if (invalid === "throws") throw new Error("unknown price"); return invalid; } } });
    await expect(generateHarness({ harness, session: "s", runId: "root", prompt: "Go" })).rejects.toMatchObject({ reason: "BudgetStateUnavailable" });
    expect(model.calls()).toBe(1);
    expect(await harness.config.host.durable!.turnBudgets!.inspect({ version: "lh.turn-budget.v1", sessionId: "s", originRunId: "root" })).toMatchObject({ steps: 1, costUsd: 0, receipts: [{ state: "reserved" }] });
  });
});

it("legacy five-method stores remain usable per run but refuse logical accounting", async () => {
  await withTempDir(async dir => {
    const store = createInMemoryDurableStore(); delete store.writeJsonDurable;
    const model = scripted(0); const host = localHost({ dataDir: dir, orchestration: createInMemoryOrchestrationServices({ store }) });
    const legacy = createHarness({ host, model: model.model, runtime: { bash: false }, turnLimits: { accounting: "run", maxSteps: 2 } });
    await generateHarness({ harness: legacy, session: "legacy", prompt: "Go" });
    const logical = createHarness({ host, model: model.model, runtime: { bash: false }, turnLimits: { accounting: "logical-turn", maxSteps: 2 } });
    await expect(generateHarness({ harness: logical, session: "s", prompt: "Go" })).rejects.toMatchObject({ reason: "BudgetStateUnavailable" });
    expect(model.calls()).toBe(1);
  });
});

it.each(["before-settle", "after-settle", "after-response"] as const)("preserves accounting across real process exit %s", async stage => {
  await withTempDir(async directory => {
    const child = async (step: string) => JSON.parse((await promisify(execFile)(process.execPath, ["--no-warnings", "--experimental-transform-types", fileURLToPath(new URL("../test/fixtures/logical-budget-crash.mjs", import.meta.url)), directory, step], { env: {} })).stdout.trim());
    expect(await child(stage)).toEqual({ interrupted: stage, calls: 1 });
    expect(await child("retry")).toEqual(stage === "before-settle"
      ? { reason: "BudgetStateUnavailable", calls: 0, steps: 1, costUsd: 0 }
      : stage === "after-settle" ? { status: "completed", calls: 1, steps: 2, costUsd: 1 }
      : { status: "completed", calls: 0, steps: 1, costUsd: .5 });
  });
});

it("legacy parked snapshots cannot acquire a fresh logical allowance", async () => {
  await withTempDir(async dir => {
    const model = scripted(); const host = localHost({ dataDir: dir });
    const config = { host, model: model.model, tools: { approve }, humanInput: { tool: false as const }, runtime: { bash: false as const } };
    await generateHarness({ harness: createHarness(config), session: "s", runId: "legacy", prompt: "Go" });
    const harness = createHarness({ ...config, turnLimits: { accounting: "logical-turn", maxSteps: 3 } });
    await answer(harness);
    expect((await resumeParked({ harness, maxAttempts: 1 })).failed[0]!.error).toMatchObject({ reason: "BudgetStateUnavailable" });
    expect(model.calls()).toBe(1);
  });
});

it.each(["before", "after"] as const)("interrupted resume %s response settlement never resets allowance", async fault => {
  await withTempDir(async dir => {
    const store = createInMemoryDurableStore(); const write = store.writeJsonDurable!.bind(store);
    const services = createInMemoryOrchestrationServices({ store }); const model = scripted(1); let enabled = false;
    store.writeJsonDurable = async (path, value) => {
      const state = value as { receipts?: { state: string }[] };
      const interrupt = enabled && state.receipts?.length === 2 && state.receipts[1]!.state === "settled";
      if (interrupt && fault === "before") { enabled = false; throw new Error("interrupted resumed settlement"); }
      await write(path, value);
      if (interrupt && fault === "after") { enabled = false; throw new Error("interrupted resumed acknowledgement"); }
    };
    const create = () => createHarness({ host: localHost({ dataDir: dir, orchestration: services }), model: model.model, tools: { approve }, humanInput: { tool: false }, runtime: { bash: false }, turnLimits: { accounting: "logical-turn", maxSteps: 3, maxCostUsd: 3, price: () => .5 } });
    let harness = create();
    await generateHarness({ harness, session: "s", runId: "root", prompt: "Go" }); await answer(harness); enabled = true;
    expect((await resumeParked({ harness, retryDelayMs: 0 })).failed[0]!.willRetry).toBe(true);
    harness = create();
    const retry = await resumeParked({ harness, maxAttempts: 1 });
    if (fault === "before") expect(retry.failed[0]!.error).toMatchObject({ reason: "BudgetStateUnavailable" });
    else expect(retry.resumed[0]!.result.status).toBe("completed");
    expect(model.calls()).toBe(fault === "before" ? 2 : 3);
    expect(await services.turnBudgets!.inspect({ version: "lh.turn-budget.v1", sessionId: "s", originRunId: "root" })).toMatchObject({ steps: fault === "before" ? 2 : 3, costUsd: fault === "before" ? .5 : 1.5 });
  });
});

it("surviving model-request proof prevents recreation when both accounting files are missing", async () => {
  await withTempDir(async dir => {
    const store = createInMemoryDurableStore(); const services = createInMemoryOrchestrationServices({ store }); const model = scripted(0); const log = inMemorySessionLog();
    const harness = createHarness({ host: localHost({ dataDir: dir, orchestration: services }), model: model.model, sessionLog: log, runtime: { bash: false }, turnLimits: { accounting: "logical-turn", maxSteps: 2 } });
    await generateHarness({ harness, session: "s", runId: "root", prompt: "Go" });
    const ref = { version: "lh.turn-budget.v1", sessionId: "s", originRunId: "root" } as const;
    for (const name of ["turn-budgets", "turn-budget-origins"]) await store.remove(join("/in-memory", name, `${recordKey(ref)}.json`));
    await expect(generateHarness({ harness, session: "s", runId: "root", prompt: "Go" })).rejects.toMatchObject({ reason: "BudgetStateUnavailable" });
    expect(model.calls()).toBe(1);
  });
});


it.each(["v2", "v4"] as const)("accounts accepted %s provider interfaces in generate and stream", async version => {
  for (const mode of ["generate", "stream"] as const) await withTempDir(async dir => {
    const model: LanguageModel = version === "v4" ? new MockLanguageModelV4({ modelId: "priced", doGenerate: { content: [{ type: "text", text: "done" }], usage, finishReason: { unified: "stop", raw: "stop" }, warnings: [] }, doStream: { stream: new ReadableStream({ start(c) { c.enqueue({ type: "stream-start", warnings: [] }); c.enqueue({ type: "finish", usage, finishReason: { unified: "stop", raw: "stop" } }); c.close(); } }) } }) : {
      specificationVersion: "v2", provider: "test", modelId: "priced", supportedUrls: {},
      doGenerate: async () => ({ content: [{ type: "text", text: "done" }], usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: "stop", warnings: [] }),
      doStream: async () => ({ stream: new ReadableStream({ start(c) { c.enqueue({ type: "stream-start", warnings: [] }); c.enqueue({ type: "finish", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: "stop" }); c.close(); } }) }),
    };
    const harness = createHarness({ host: localHost({ dataDir: dir }), model, runtime: { bash: false }, turnLimits: { accounting: "logical-turn", maxSteps: 2, price: () => .5 } });
    const options = { harness, session: "s", runId: "root", prompt: "Go" };
    if (mode === "generate") await generateHarness(options); else await streamHarness(options).finished;
    expect(await harness.config.host.durable!.turnBudgets!.inspect({ version: "lh.turn-budget.v1", sessionId: "s", originRunId: "root" })).toMatchObject({ steps: 1, costUsd: .5, receipts: [{ state: "settled" }] });
  });
});

it("a missing reference with a surviving logical marker cannot downgrade to per-run", async () => {
  await withTempDir(async dir => {
    const model = scripted(); const services = createInMemoryOrchestrationServices();
    const host = localHost({ dataDir: dir, orchestration: services });
    const config = { host, model: model.model, tools: { approve }, humanInput: { tool: false as const }, runtime: { bash: false as const } };
    const harness = createHarness({ ...config, turnLimits: { accounting: "logical-turn", maxSteps: 3 } });
    await generateHarness({ harness, session: "s", runId: "root", prompt: "Go" }); await answer(harness);
    const read = services.results.getByIdempotencyKey.bind(services.results);
    services.results.getByIdempotencyKey = async input => {
      const saved = await read(input); if (!saved) return saved;
      const value = saved.value as { budgetRef?: unknown; budgetAccounting?: unknown };
      if (value?.budgetAccounting === "logical-turn") { const { budgetRef: _lost, ...damaged } = value; return { ...saved, value: damaged }; }
      return saved;
    };
    const downgraded = createHarness({ ...config, turnLimits: { accounting: "run", maxSteps: 3 } });
    expect((await resumeParked({ harness: downgraded, maxAttempts: 1 })).failed[0]!.error).toMatchObject({ reason: "BudgetStateUnavailable" });
    expect(model.calls()).toBe(1);
  });
});


it.each(["generate", "stream"] as const)("prices the response model identity returned by a router (%s)", async mode => {
  await withTempDir(async dir => {
    const priced: string[] = [];
    const model = new MockLanguageModelV3({ modelId: "cheap-router", doGenerate: { content: [{ type: "text", text: "done" }], usage, warnings: [], finishReason: { unified: "stop", raw: "stop" }, response: { modelId: "actual-expensive" } }, doStream: { stream: new ReadableStream({ start(c) { c.enqueue({ type: "stream-start", warnings: [] }); c.enqueue({ type: "response-metadata", modelId: "actual-expensive" }); c.enqueue({ type: "finish", usage, finishReason: { unified: "stop", raw: "stop" } }); c.close(); } }) } });
    const harness = createHarness({ host: localHost({ dataDir: dir }), model, runtime: { bash: false }, turnLimits: { accounting: "logical-turn", maxSteps: 3, maxCostUsd: 3, price: ({ model }) => { priced.push(model); return model === "actual-expensive" ? 3.5 : .01; } } });
    const options = { harness, session: "s", runId: "root", prompt: "Go" };
    if (mode === "generate") await generateHarness(options); else await streamHarness(options).finished;
    expect(priced).toEqual(["actual-expensive"]);
    expect(await harness.config.host.durable!.turnBudgets!.inspect({ version: "lh.turn-budget.v1", sessionId: "s", originRunId: "root" })).toMatchObject({ steps: 1, costUsd: 3.5, receipts: [{ pricedModel: "actual-expensive" }] });
    await expect(generateHarness(options)).rejects.toMatchObject({ reason: "CostLimitExceeded" });
  });
});
