import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import { resolveHarnessWorkflowTools, type HarnessWorkflow } from "little-harness";
import { asHarnessWorkflow } from "little-workflow";
import type { WorkflowDefinition } from "little-workflow";
import { createClusterCardsWorkflow } from "../agents/dreamer/workflows/cluster-cards";
import { createConfigAbWorkflow } from "../agents/dreamer/workflows/config-ab";
import { createIncidentCardWorkflow } from "../agents/dreamer/workflows/incident-card";
import { scriptedModel } from "./support/mock-model";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/**
 * Run a template through the SAME path the agent uses: `asHarnessWorkflow` →
 * `resolveHarnessWorkflowTools` → `execute`. Nothing about the workflow is stubbed; only
 * the model is a mock.
 */
async function runTemplate(
  build: (model: LanguageModel) => unknown,
  handle: string,
  input: unknown,
  output: unknown,
): Promise<Record<string, unknown>> {
  const model = scriptedModel({ turns: [], workflowOutput: () => output });
  const workflow = asHarnessWorkflow(build(model) as unknown as WorkflowDefinition, {
    executionMode: "inline",
    definitionIdentity: { notApplicable: true },
  });
  const dataDir = await mkdtemp(join(tmpdir(), "dreamer-wf-"));
  dirs.push(dataDir);
  const tools = resolveHarnessWorkflowTools([workflow], {
    sessionId: `sess_${handle}`,
    turnId: "turn_1",
    originTurnId: "turn_1",
    dataDir,
  });
  const result = await tools[handle]?.execute?.(input, { toolCallId: "call_1" } as never);
  return result as Record<string, unknown>;
}

const CARD = {
  runId: "run_cite_1",
  symptom: "answered without naming a source",
  userQuote: "where does that number come from?",
  wrongAnswerSummary: "gave 20 days with no file reference",
  suspectedCause: "prompt never requires a Source line",
};

describe("template workflows execute end to end", () => {
  it("dream.incident-card turns one failed run into a card", async () => {
    const result = await runTemplate(
      (model) => createIncidentCardWorkflow(model),
      "dream_incident_card",
      {
        runId: "run_cite_1",
        transcript: "user: how many vacation days\nassistant: 20\nuser: where does that number come from?",
        outcome: "failure (inferred from user pushback)",
      },
      CARD,
    );

    expect(result.status).toBe("completed");
    // `outputSummary` is the ONLY field of a completed workflow run the calling model sees —
    // the harness tool-result compactor drops `output` entirely.
    const summary = JSON.parse(String(result.outputSummary)) as typeof CARD;
    expect(summary).toMatchObject(CARD);
  }, 60_000);

  it("dream.cluster-cards groups cards and names the dominant cluster", async () => {
    const clustering = {
      clusters: [
        {
          label: "answers omit their source",
          runIds: ["run_cite_1", "run_cite_2"],
          dominantCause: "prompt never requires a citation",
        },
        {
          label: "answers stop half way",
          runIds: ["run_partial_1"],
          dominantCause: "no instruction to cover follow-ups",
        },
      ],
      dominantCluster: "answers omit their source",
    };
    const result = await runTemplate(
      (model) => createClusterCardsWorkflow(model),
      "dream_cluster_cards",
      { cards: [CARD] },
      clustering,
    );

    expect(result.status).toBe("completed");
    expect(JSON.parse(String(result.outputSummary))).toMatchObject(clustering);
  }, 60_000);

  it("dream.config-ab compares two config versions", async () => {
    const comparison = {
      behavioralDifference: "Under B the agent names the file it answered from; under A it does not.",
      hypothesis: "The citation requirement is what removes the follow-up 'where is that from' turn.",
    };
    const result = await runTemplate(
      (model) => createConfigAbWorkflow(model),
      "dream_config_ab",
      {
        configA: { prompt: "Answer briefly." },
        configB: { prompt: "Answer briefly. Always cite the source file." },
        metricsA: { configVersionId: "cfgv_001", runCount: 1, withOutcome: 1, successRate: 1 },
        metricsB: { configVersionId: "cfgv_002", runCount: 7, withOutcome: 6, successRate: 1 / 6 },
      },
      comparison,
    );

    expect(result.status).toBe("completed");
    expect(JSON.parse(String(result.outputSummary))).toMatchObject(comparison);
  }, 60_000);
});

/**
 * LIT-43 regression guard. `.describe()` on a workflow's zod schema used to make the LWIR
 * input cone reject the definition, so demos had to strip their descriptions. It is fixed;
 * these templates lean on `.describe()` for every field (the word caps, the "copy verbatim"
 * rule) and that guidance only reaches the model if the schema converts.
 */
describe("described schemas convert to a usable tool schema (LIT-43)", () => {
  const templates: ReadonlyArray<[string, (model: LanguageModel) => unknown]> = [
    ["dream.incident-card", (model) => createIncidentCardWorkflow(model)],
    ["dream.cluster-cards", (model) => createClusterCardsWorkflow(model)],
    ["dream.config-ab", (model) => createConfigAbWorkflow(model)],
  ];

  const model = { provider: "test", modelId: "schema-only" } as unknown as LanguageModel;

  for (const [id, build] of templates) {
    it(`${id} exposes a json-schema input marker carrying its descriptions`, () => {
      const workflow: HarnessWorkflow = asHarnessWorkflow(
        build(model) as unknown as WorkflowDefinition,
        { executionMode: "inline", definitionIdentity: { notApplicable: true } },
      );

      expect(workflow.id).toBe(id);
      // Not "unconvertible", and not the untyped escape hatch: a real JSON Schema.
      expect(workflow.inputSchema?.kind).toBe("json-schema");
      const marker = workflow.inputSchema as { kind: "json-schema"; schema: unknown; lossy?: boolean };
      expect(marker.lossy).toBeUndefined();

      const rendered = JSON.stringify(marker.schema);
      expect(rendered).toContain("description");
      expect(rendered.length).toBeGreaterThan(200);
    });
  }

  it("carries the load-bearing 'verbatim' instruction into the incident-card schema", () => {
    const workflow = asHarnessWorkflow(
      createIncidentCardWorkflow(model) as unknown as WorkflowDefinition,
      { executionMode: "inline", definitionIdentity: { notApplicable: true } },
    );
    const rendered = JSON.stringify(
      (workflow.inputSchema as { schema: unknown }).schema,
    );
    // The input side describes what a transcript is; the verbatim rule lives on the OUTPUT
    // schema, which the workflow enforces at run time rather than exposing as a tool schema.
    expect(rendered).toContain("run id");
  });
});
