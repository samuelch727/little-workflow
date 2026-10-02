import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModel } from "ai";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import {
  loadHarness,
  resolveHarnessWorkflowTools,
  type HarnessWorkflow,
  type HarnessWorkflowExecution,
} from "little-harness";
import { setDreamerModel } from "../agents/dreamer/env";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

// Loading the agent folder resolves the model at import time (a `defineWorkflow` captures
// it), so a stub has to be installed before `loadHarness`. No model is ever CALLED here —
// every workflow run is replaced by the gate instrumentation.
beforeAll(() => {
  setDreamerModel({ provider: "test", modelId: "unused" } as unknown as LanguageModel);
});
afterAll(() => {
  setDreamerModel(undefined);
});

const AGENT_DIR = join(import.meta.dirname, "..", "agents", "dreamer");

const nextTick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * The sweep's safety property.
 *
 * Step 2 of the doctrine tells the agent to fan a `dream_incident_card` call out over EVERY
 * failure run in one step, and the AI SDK executes a step's tool calls in parallel. What
 * keeps that from becoming N concurrent provider requests is the harness's session-scoped
 * workflow-run admission gate, configured in `agent.ts`.
 *
 * The proof takes the REAL discovered workflow — real id, real handle, real input schema —
 * and swaps only its `runForHarness` for a gated fake, then drives it with the dreamer's own
 * `workflowBudgets`. So what is under test is the demo's configuration, not a hand-picked
 * number. (Instrumentation pattern from `packages/little-harness/src/workflows.test.ts`.)
 */
function gated(
  workflow: HarnessWorkflow,
  state: { inFlight: number; peak: number; gates: Array<() => void> },
): HarnessWorkflow {
  return {
    ...workflow,
    async runForHarness(input, ctx): Promise<HarnessWorkflowExecution> {
      state.inFlight += 1;
      state.peak = Math.max(state.peak, state.inFlight);
      await new Promise<void>((resolve) => state.gates.push(resolve));
      state.inFlight -= 1;
      return {
        protocolVersion: 1,
        status: "completed",
        runId: ctx.reservedRunId,
        output: input,
        summary: "card",
      };
    },
  };
}

it("a sweep over N failure runs never exceeds maxConcurrentWorkflowRuns in flight", async () => {
  const harness = await loadHarness(AGENT_DIR);
  const budgets = harness.config.workflowBudgets;
  const limit = budgets.maxConcurrentWorkflowRuns;

  // The demo must actually configure a bound below the harness default of 10 — every card is
  // a model call against one provider account.
  expect(limit).toBe(4);
  expect(limit).toBeLessThan(10);

  const card = harness.config.workflows?.find((workflow) => workflow.id === "dream.incident-card");
  expect(card, "dream.incident-card must be discovered from workflows/").toBeDefined();

  const state = { inFlight: 0, peak: 0, gates: [] as Array<() => void> };
  const dataDir = await mkdtemp(join(tmpdir(), "dreamer-fanout-"));
  dirs.push(dataDir);
  const tools = resolveHarnessWorkflowTools([gated(card as HarnessWorkflow, state)], {
    // The slot registry is a module-level map keyed by session id — a unique id per test
    // keeps this bound independent of anything else running.
    sessionId: "sess_dreamer_fanout",
    turnId: "turn_1",
    originTurnId: "turn_1",
    dataDir,
    budgets,
  });

  // One card per failure run, all issued in the same step — the shape of the real sweep.
  const total = 12;
  const calls = Array.from({ length: total }, (_unused, n) =>
    tools.dream_incident_card?.execute?.(
      { runId: `run_${n}`, transcript: "…", outcome: "failure (inferred)" },
      { toolCallId: `call_${n}` } as never,
    ));

  for (let released = 0; released < total; released += 1) {
    await nextTick();
    expect(state.inFlight).toBeLessThanOrEqual(limit);
    // Only admitted runs ever register a gate, so this is a direct read of "runs started".
    expect(state.gates.length).toBeLessThanOrEqual(limit);
    state.gates.shift()?.();
  }

  const results = await Promise.all(calls);
  expect(results).toHaveLength(total);
  // Saturated, but never over: the excess calls queued instead of failing.
  expect(state.peak).toBe(limit);
  expect(state.inFlight).toBe(0);
  for (const result of results) {
    expect(result).toMatchObject({ status: "completed", outputSummary: "card" });
  }
}, 60_000);

it("the bound is shared across the dreamer's workflow tools, not per tool", async () => {
  const harness = await loadHarness(AGENT_DIR);
  const budgets = { maxConcurrentWorkflowRuns: 1, maxQueuedWorkflowRuns: 10 };
  const state = { inFlight: 0, peak: 0, gates: [] as Array<() => void> };
  const dataDir = await mkdtemp(join(tmpdir(), "dreamer-fanout-shared-"));
  dirs.push(dataDir);

  const workflows = (harness.config.workflows ?? []).map((workflow) => gated(workflow, state));
  expect(workflows.length).toBeGreaterThanOrEqual(3);
  const shared = {
    sessionId: "sess_dreamer_fanout_shared",
    turnId: "turn_1",
    originTurnId: "turn_1",
    dataDir,
    budgets,
  };
  const tools = resolveHarnessWorkflowTools(workflows, shared);

  const calls = [
    tools.dream_incident_card?.execute?.({}, { toolCallId: "call_a" } as never),
    tools.dream_cluster_cards?.execute?.({}, { toolCallId: "call_b" } as never),
    tools.dream_config_ab?.execute?.({}, { toolCallId: "call_c" } as never),
  ];

  for (let released = 0; released < calls.length; released += 1) {
    await nextTick();
    expect(state.inFlight).toBeLessThanOrEqual(1);
    state.gates.shift()?.();
  }
  await Promise.all(calls);
  expect(state.peak).toBe(1);
}, 60_000);
