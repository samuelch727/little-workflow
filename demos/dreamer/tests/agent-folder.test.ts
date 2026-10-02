import { join } from "node:path";
import type { LanguageModel } from "ai";
import { afterAll, beforeAll, expect, it } from "vitest";
import { loadHarness } from "little-harness";
import { setDreamerModel } from "../agents/dreamer/env";

const AGENT_DIR = join(import.meta.dirname, "..", "agents", "dreamer");

beforeAll(() => {
  setDreamerModel({ provider: "test", modelId: "unused" } as unknown as LanguageModel);
});
afterAll(() => {
  setDreamerModel(undefined);
});

it("discovers the dreamer's three tools and three template workflows", async () => {
  const harness = await loadHarness(AGENT_DIR);

  expect(Object.keys(harness.config.tools).sort()).toEqual([
    "littledb_evidence_pack",
    "littledb_load_run",
    "littledb_submit_proposal",
  ]);
  expect((harness.config.workflows ?? []).map((workflow) => workflow.id).sort()).toEqual([
    "dream.cluster-cards",
    "dream.config-ab",
    "dream.incident-card",
  ]);
  for (const workflow of harness.config.workflows ?? []) {
    // Inline: a card has to be back inside the same turn to be swept over.
    expect(workflow.executionMode).toBe("inline");
    expect(workflow.inputSchema?.kind).toBe("json-schema");
  }
});

it("keeps dynamic workflows available as the escape hatch", async () => {
  const harness = await loadHarness(AGENT_DIR);

  // `run_ad_hoc_plan` exists because `dynamicWorkflows()` was injected. The doctrine tells
  // the agent to prefer the templates — it does not take the hatch away.
  expect(harness.config.dynamicWorkflows).toBeDefined();
  expect(typeof harness.config.dynamicWorkflows?.factory.compile).toBe("function");
  expect(harness.config.dynamicWorkflows?.exclude).toEqual([]);
});

it("uses instructions.md as the system prompt, doctrine intact", async () => {
  const harness = await loadHarness(AGENT_DIR);
  const system = harness.config.system;

  expect(typeof system).toBe("string");
  const text = String(system);
  expect(text).toContain("You are the Dreamer.");
  // The four load-bearing rules. If any of these stops being said, the agent stops doing it.
  expect(text).toContain("Two verifiable citations, minimum");
  expect(text).toContain("Quote, do not paraphrase");
  expect(text).toContain("If a citation is rejected, fix it");
  expect(text).toMatch(/`run_ad_hoc_plan` is the escape hatch/);
  expect(text).toContain("Prefer them.");
});

it("configures the budgets an investigation actually needs", async () => {
  const harness = await loadHarness(AGENT_DIR);
  const budgets = harness.config.workflowBudgets;

  expect(budgets.maxConcurrentWorkflowRuns).toBe(4);
  // Evidence pack, a sweep, a cluster, drill-downs, a submit, and up to two citation
  // repairs do not fit in the default 20 model steps.
  expect(budgets.maxModelSteps).toBeGreaterThanOrEqual(40);
  expect(budgets.maxToolCallsPerTurn).toBeGreaterThanOrEqual(200);
  // Unset budgets keep the harness defaults rather than becoming unbounded.
  expect(budgets.maxQueuedWorkflowRuns).toBe(100);
});
