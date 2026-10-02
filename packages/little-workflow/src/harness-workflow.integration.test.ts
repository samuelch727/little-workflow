import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  createHarness,
  generateHarness,
  localHost,
  resolveHarnessWorkflowTools,
  type HarnessWorkflow,
} from "little-harness";
import { defineWorkflow } from "./authoring.js";
import { asHarnessWorkflow, MAX_WORKFLOW_OUTPUT_SUMMARY_CHARACTERS } from "./harness-workflow.js";
import type { Harness, WorkflowDefinition } from "./index.js";
import { loadWorkflow } from "./workspace/load-workflow.js";

const dirs: string[] = [];
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

async function writeWorkflowFixture(
  prefix: string,
  toolExecute = "async () => ({ ok: true })",
): Promise<string> {
  const dir = await mkdtemp(join(packageRoot, `.tmp-${prefix}-`));
  dirs.push(dir);
  await mkdir(join(dir, "tools"));
  await writeFile(join(dir, "tools", "score.ts"), `
    import { tool } from "ai";
    export default tool({ description: "Score.", inputSchema: {}, execute: ${toolExecute} });
  `);
  await writeFile(join(dir, "workflow.ts"), `
    import { createLittleWorkflow, model } from "little-workflow";
    export default createLittleWorkflow({
      id: "candidate.review",
      models: [model({ provider: "test", modelId: "planner" } as never)],
      planner: {
        model: model({ provider: "test", modelId: "planner" } as never),
        harness: {
          harnessId: "folder-planner@1.0.0",
          async run() {
            return {
              kind: "plan",
              lwir: {
                apiVersion: "littleworkflow.dev/v0.1",
                kind: "Workflow",
                metadata: { name: "candidate.review" },
                input: { schema: true },
                output: { schema: true },
                permissions: { models: [], tools: ["score"], secrets: [], network: [] },
                steps: [{ id: "score", uses: "tool.call", with: { tool: "score", args: {} }, output: { mode: "json", schema: true } }]
              }
            };
          }
        }
      },
      globalTools: ["score"],
    });
  `);
  return dir;
}

it("passes a folder-loaded workflow to createHarness and executes it as a workflow tool", async () => {
  const dir = await writeWorkflowFixture("lw-harness");
  const loaded = await loadWorkflow(dir, {
    workspaceRoot: packageRoot,
    executionMode: "inline",
    allowUntypedInput: true,
  });
  const structural: HarnessWorkflow = loaded;
  expect(structural.executionMode).toBe("inline");
  expect(structural.inputSchema).toEqual({ kind: "untyped", allowUntypedInput: true });

  let call = 0;
  const model = new MockLanguageModelV3({
    provider: "test",
    modelId: "folder-loaded-workflow",
    doGenerate: async () => {
      call += 1;
      if (call === 1) {
        return {
          content: [{ type: "tool-call", toolCallId: "call_review", toolName: "candidate_review", input: "{}" }],
          finishReason: { unified: "tool-calls", raw: "tool-calls" },
          usage,
          warnings: [],
        };
      }
      return {
        content: [{ type: "text", text: "review complete" }],
        finishReason: { unified: "stop", raw: "stop" },
        usage,
        warnings: [],
      };
    },
  });
  const hostDir = await mkdtemp(join(tmpdir(), "lh-folder-workflow-"));
  dirs.push(hostDir);
  const harness = createHarness({
    host: localHost({ dataDir: hostDir }),
    model,
    workflows: [loaded],
  });

  const result = await generateHarness({ harness, type: "job", input: {} });
  expect(result.text).toContain("review complete");
});

it("invokes ctx.observation.recordProgress with a real currentStep during runForHarness", async () => {
  const dir = await writeWorkflowFixture("lw-progress");
  const loaded = await loadWorkflow(dir, {
    workspaceRoot: packageRoot,
    executionMode: "inline",
    allowUntypedInput: true,
  });
  const progressEvents: Array<{ currentStep?: string; lastEvent?: unknown }> = [];
  const runDir = await mkdtemp(join(tmpdir(), "lh-progress-run-"));
  dirs.push(runDir);

  const exec = await loaded.runForHarness({}, {
    protocolVersion: 1,
    workflowId: "candidate.review",
    workflowHandle: "candidate_review",
    definitionIdentity: loaded.definitionIdentity,
    toolCallId: "tool_1",
    disposition: "await",
    parentSessionId: "sess_1",
    parentTurnId: "turn_1",
    originTurnId: "turn_1",
    reservedRunId: "run_progress",
    persistence: { dataDir: runDir },
    observation: { recordProgress: async (e) => { progressEvents.push(e as never); } },
    inheritance: {},
  });

  expect(exec.status).toBe("completed");
  expect(progressEvents.some((e) => typeof e.currentStep === "string" && e.lastEvent !== undefined)).toBe(true);
});

/**
 * Runs a folder-loaded workflow the way a model does: through the real
 * `resolveHarnessWorkflowTools` tool wrapper, so the assertion sees exactly the compacted tool
 * result that goes back into the calling model's context.
 */
async function modelVisibleToolResult(
  prefix: string,
  toolExecute: string,
): Promise<Record<string, unknown>> {
  const dir = await writeWorkflowFixture(prefix, toolExecute);
  const loaded = await loadWorkflow(dir, {
    workspaceRoot: packageRoot,
    executionMode: "inline",
    allowUntypedInput: true,
  });
  const runDir = await mkdtemp(join(tmpdir(), `lh-${prefix}-`));
  dirs.push(runDir);
  const tools = resolveHarnessWorkflowTools([loaded], {
    sessionId: "sess_1",
    turnId: "turn_1",
    originTurnId: "turn_1",
    dataDir: runDir,
  });
  const result = await tools.candidate_review?.execute?.({}, { toolCallId: "call_1" } as never);
  return result as Record<string, unknown>;
}

it("returns a completed workflow run's output to the calling model as an inline summary", async () => {
  const result = await modelVisibleToolResult(
    "lw-summary-ok",
    "async () => ({ ok: true, recommendation: 'advance' })",
  );

  expect(result).toMatchObject({ status: "completed" });
  // Before this, a completed run handed the model only `{status, runId}` — nothing about the result.
  expect(result.outputSummary).toBe('{"ok":true,"recommendation":"advance"}');
});

it("marks an over-cap summary as truncated and reports the full size and run id", async () => {
  const result = await modelVisibleToolResult(
    "lw-summary-big",
    "async () => ({ blob: 'x'.repeat(20000) })",
  );

  expect(result).toMatchObject({ status: "completed" });
  const summary = result.outputSummary as string;
  expect(summary.startsWith('{"blob":"xxx')).toBe(true);
  expect(summary).toMatch(
    /…\[truncated: 4096 of 20011 characters; the full value is recorded in run run_candidate_review_call_1\]$/u,
  );
  // The cap bounds the payload; the marker itself is allowed to exceed it.
  expect(summary.indexOf("…[truncated:")).toBe(MAX_WORKFLOW_OUTPUT_SUMMARY_CHARACTERS);
});

it("surfaces the failing step and runtime cause to the calling model on a failed run", async () => {
  const result = await modelVisibleToolResult(
    "lw-summary-fail",
    "async () => { throw new Error('scoring service unavailable'); }",
  );

  expect(result).toMatchObject({
    status: "failed",
    causeCode: "workflow_failed",
    message: "scoring service unavailable",
    outputSummary: "Failed at step 'score' (step_failed): scoring service unavailable",
  });
});

/**
 * LIT-43 regression, end to end.
 *
 * `.describe()` is the standard way to document a field for a model, and `zod` emits it as
 * the JSON Schema `description` keyword. The alpha LWIR schema subset used to reject that
 * keyword outright, so a described input schema failed at validation on *every* run of the
 * workflow — the KB demo had to strip its `.describe()` calls and move the field docs into
 * a system prompt to keep working.
 *
 * This is the whole demo shape: `defineWorkflow` with described zod input/output, wrapped by
 * `asHarnessWorkflow`, handed to `createHarness`, and invoked as a tool by a model. It also
 * pins the flip side — the descriptions must actually REACH the model, otherwise accepting
 * them is cosmetic — by asserting on the tool schema the language model itself receives.
 */
it("runs an asHarnessWorkflow-wrapped workflow whose zod schemas use .describe(), and shows the descriptions to the model", async () => {
  const inputSchema = z.object({
    filename: z.string().describe("Name of the uploaded knowledge-base file."),
    tags: z.array(z.string().describe("A single free-form label.")).describe("Catalog labels."),
  }).describe("An uploaded knowledge-base document.");
  const outputSchema = z.object({
    catalogLine: z.string().describe("The one-line catalog entry for this document."),
  }).describe("The catalog entry produced for the document.");

  // The planner echoes the workflow snapshot's schemas straight back into the LWIR, which is
  // both what a real planner must do (the compiler hash-binds LWIR schemas to the request)
  // and the point of the test: the described schemas travel through normalization, the
  // snapshot validator, LWIR validation, and compilation unchanged.
  const plannerHarness = {
    harnessId: "describedPlanner@1.0.0",
    run: async (task: Parameters<Harness["run"]>[0]) => {
      if (task.kind !== "plan") {
        return { kind: "delegate_to_default" as const };
      }
      const snapshot = task.workflowSnapshot as {
        readonly inputSchema: unknown;
        readonly outputSchema: unknown;
      };
      return {
        kind: "plan" as const,
        lwir: {
          apiVersion: "littleworkflow.dev/v0.1",
          kind: "Workflow",
          metadata: { name: "kb.ingest-file" },
          input: { schema: snapshot.inputSchema },
          output: { schema: snapshot.outputSchema },
          permissions: { models: [], tools: ["catalog"], secrets: [], network: [] },
          steps: [
            {
              id: "catalog",
              uses: "tool.call",
              with: { tool: "catalog" },
              input: { filename: "{{ input.filename }}" },
              output: { mode: "object", schema: snapshot.outputSchema },
            },
          ],
        },
      };
    },
  } satisfies Harness & { readonly harnessId: string };

  // The step's tool: it only runs if LWIR validation and compilation accepted the described
  // schemas, so its call count is the proof that the workflow really executed.
  const catalogExecute = vi.fn(async (args: unknown) => ({
    catalogLine: `- \`${(args as { readonly filename: string }).filename}\``,
  }));

  const workflow = defineWorkflow({
    id: "kb.ingest-file",
    description: "Summarize an uploaded knowledge-base document.",
    input: inputSchema,
    output: outputSchema,
    model: { provider: "test", modelId: "worker" } as never,
    planner: { model: { provider: "test", modelId: "planner" } as never, harness: plannerHarness },
    tools: {
      catalog: tool({
        description: "Build a catalog line.",
        // Also described: a workflow's tool schemas are validated against the same alpha
        // subset (`buildToolSnapshots` in compiler.ts), so `.describe()` broke them too.
        inputSchema: z.object({ filename: z.string().describe("The document's filename.") }),
        execute: catalogExecute,
      }),
    },
  });

  const adapted = asHarnessWorkflow(workflow, {
    executionMode: "inline",
    definitionIdentity: { notApplicable: true, reason: "test fixture" },
  });
  // The marker the Harness turns into the model-facing tool schema keeps the annotations.
  expect(adapted.inputSchema).toMatchObject({
    kind: "json-schema",
    schema: {
      description: "An uploaded knowledge-base document.",
      properties: {
        filename: { description: "Name of the uploaded knowledge-base file." },
        tags: {
          description: "Catalog labels.",
          items: { description: "A single free-form label." },
        },
      },
    },
  });

  const modelFacingSchemas: unknown[] = [];
  const promptsSeen: string[] = [];
  let call = 0;
  const model = new MockLanguageModelV3({
    provider: "test",
    modelId: "described-workflow",
    doGenerate: async (options) => {
      const tools = (options as { readonly tools?: readonly { readonly name: string; readonly inputSchema?: unknown }[] }).tools ?? [];
      const workflowTool = tools.find((entry) => entry.name === "kb_ingest_file");
      modelFacingSchemas.push(workflowTool?.inputSchema);
      promptsSeen.push(JSON.stringify((options as { readonly prompt?: unknown }).prompt));
      call += 1;
      if (call === 1) {
        return {
          content: [{
            type: "tool-call" as const,
            toolCallId: "call_ingest",
            toolName: "kb_ingest_file",
            input: JSON.stringify({ filename: "runbook.md", tags: ["ops"] }),
          }],
          finishReason: { unified: "tool-calls" as const, raw: "tool-calls" },
          usage,
          warnings: [],
        };
      }
      return {
        content: [{ type: "text" as const, text: "ingested" }],
        finishReason: { unified: "stop" as const, raw: "stop" },
        usage,
        warnings: [],
      };
    },
  });

  const hostDir = await mkdtemp(join(tmpdir(), "lh-described-workflow-"));
  dirs.push(hostDir);
  const harness = createHarness({
    host: localHost({ dataDir: hostDir }),
    model,
    workflows: [adapted],
  });

  const result = await generateHarness({ harness, type: "job", input: {} });

  expect(result.text).toContain("ingested");
  // Before the fix the run failed with `Unsupported JSON Schema keyword 'description' in alpha
  // LWIR.` before reaching any step, so these are the assertions that pin the regression:
  // the step's tool ran, and the model got a completed run back with the workflow's output.
  expect(catalogExecute).toHaveBeenCalledTimes(1);
  expect(catalogExecute.mock.calls[0]?.[0]).toMatchObject({ filename: "runbook.md" });
  expect(promptsSeen[1]).toContain('"status":"completed"');
  expect(promptsSeen[1]).toContain("catalogLine");
  // The flip side: the description reached the tool definition the model was handed.
  expect(modelFacingSchemas[0]).toMatchObject({
    properties: {
      filename: { description: "Name of the uploaded knowledge-base file." },
      tags: {
        description: "Catalog labels.",
        items: { description: "A single free-form label." },
      },
    },
  });
});

/**
 * LIT-53 regression, end to end.
 *
 * `z.record(K, V)` is how a map-shaped input is written, and zod emits it as
 * `{ type: "object", propertyNames: <K>, additionalProperties: <V> }`. The alpha LWIR
 * subset rejected `propertyNames` outright, so every map-shaped schema failed at compile
 * time with "Unsupported JSON Schema keyword 'propertyNames' in alpha LWIR" — the dreamer's
 * `config-ab` workflow had to ship `z.looseObject` to have an input schema at all.
 *
 * This runs the dreamer's real shape — a record of config bundles, keyed by version id —
 * through `defineWorkflow` → `asHarnessWorkflow` → `createHarness` → a model calling it as a
 * tool. It also pins the downstream half: the record must reach the model-facing tool
 * definition WHOLE (`propertyNames` and the value schema both), otherwise the model is shown
 * a shape that is not the one it will be validated against.
 */
it("runs an asHarnessWorkflow-wrapped workflow whose zod input is a z.record(), and shows the whole record schema to the model", async () => {
  const configBundle = z.object({
    prompt: z.string().describe("The system prompt this config version runs on."),
    temperature: z.number().describe("Sampling temperature."),
  });
  const inputSchema = z.object({
    variants: z
      .record(z.string(), configBundle)
      .describe("Config bundles from the evidence pack, keyed by config version id."),
  });
  const outputSchema = z.object({
    behavioralDifference: z.string().describe("What the agent would DO differently."),
  });

  // As in the LIT-43 test: the planner echoes the snapshot's schemas back, which is what a
  // real planner must do (the compiler hash-binds LWIR schemas to the request) and is the
  // point here — the record travels through normalization, the snapshot validator, LWIR
  // validation and compilation unchanged.
  const plannerHarness = {
    harnessId: "recordPlanner@1.0.0",
    run: async (task: Parameters<Harness["run"]>[0]) => {
      if (task.kind !== "plan") {
        return { kind: "delegate_to_default" as const };
      }
      const snapshot = task.workflowSnapshot as {
        readonly inputSchema: unknown;
        readonly outputSchema: unknown;
      };
      return {
        kind: "plan" as const,
        lwir: {
          apiVersion: "littleworkflow.dev/v0.1",
          kind: "Workflow",
          metadata: { name: "dream.config-ab" },
          input: { schema: snapshot.inputSchema },
          output: { schema: snapshot.outputSchema },
          permissions: { models: [], tools: ["compare"], secrets: [], network: [] },
          steps: [
            {
              id: "compare",
              uses: "tool.call",
              with: { tool: "compare" },
              input: { variants: "{{ input.variants }}" },
              output: { mode: "object", schema: snapshot.outputSchema },
            },
          ],
        },
      };
    },
  } satisfies Harness & { readonly harnessId: string };

  // The step's tool only runs if LWIR validation and compilation accepted the record, so its
  // call count is the proof that the workflow really executed.
  const compareExecute = vi.fn(async (args: unknown) => ({
    behavioralDifference: `compared ${Object.keys((args as { readonly variants: Record<string, unknown> }).variants).join(" vs ")}`,
  }));

  const workflow = defineWorkflow({
    id: "dream.config-ab",
    description: "Compare two config versions the harness has run on.",
    input: inputSchema,
    output: outputSchema,
    model: { provider: "test", modelId: "worker" } as never,
    planner: { model: { provider: "test", modelId: "planner" } as never, harness: plannerHarness },
    tools: {
      compare: tool({
        description: "Compare config bundles.",
        // A record in a TOOL's input schema too: tool schemas go through the same alpha
        // subset (`buildToolSnapshots` in compiler.ts), so `propertyNames` broke them alike.
        inputSchema: z.object({ variants: z.record(z.string(), configBundle) }),
        execute: compareExecute,
      }),
    },
  });

  const adapted = asHarnessWorkflow(workflow, {
    executionMode: "inline",
    definitionIdentity: { notApplicable: true, reason: "test fixture" },
  });
  // The marker the Harness turns into the model-facing tool schema keeps the map shape.
  expect(adapted.inputSchema).toMatchObject({
    kind: "json-schema",
    schema: {
      properties: {
        variants: {
          type: "object",
          propertyNames: { type: "string" },
          additionalProperties: {
            type: "object",
            properties: { prompt: { type: "string" }, temperature: { type: "number" } },
          },
          description: "Config bundles from the evidence pack, keyed by config version id.",
        },
      },
    },
  });

  const modelFacingSchemas: unknown[] = [];
  const promptsSeen: string[] = [];
  let call = 0;
  const model = new MockLanguageModelV3({
    provider: "test",
    modelId: "record-workflow",
    doGenerate: async (options) => {
      const tools = (options as { readonly tools?: readonly { readonly name: string; readonly inputSchema?: unknown }[] }).tools ?? [];
      const workflowTool = tools.find((entry) => entry.name === "dream_config_ab");
      modelFacingSchemas.push(workflowTool?.inputSchema);
      promptsSeen.push(JSON.stringify((options as { readonly prompt?: unknown }).prompt));
      call += 1;
      if (call === 1) {
        return {
          content: [{
            type: "tool-call" as const,
            toolCallId: "call_compare",
            toolName: "dream_config_ab",
            input: JSON.stringify({
              variants: {
                cfgver_1: { prompt: "Be terse.", temperature: 0.2 },
                cfgver_2: { prompt: "Be thorough.", temperature: 0.7 },
              },
            }),
          }],
          finishReason: { unified: "tool-calls" as const, raw: "tool-calls" },
          usage,
          warnings: [],
        };
      }
      return {
        content: [{ type: "text" as const, text: "compared" }],
        finishReason: { unified: "stop" as const, raw: "stop" },
        usage,
        warnings: [],
      };
    },
  });

  const hostDir = await mkdtemp(join(tmpdir(), "lh-record-workflow-"));
  dirs.push(hostDir);
  const harness = createHarness({
    host: localHost({ dataDir: hostDir }),
    model,
    workflows: [adapted],
  });

  const result = await generateHarness({ harness, type: "job", input: {} });

  expect(result.text).toContain("compared");
  // Before the fix the run failed with `Unsupported JSON Schema keyword 'propertyNames' in
  // alpha LWIR.` before reaching any step, so these pin the regression: the step's tool ran
  // with the map intact, and the model got a completed run back.
  expect(compareExecute).toHaveBeenCalledTimes(1);
  expect(compareExecute.mock.calls[0]?.[0]).toMatchObject({
    variants: {
      cfgver_1: { prompt: "Be terse.", temperature: 0.2 },
      cfgver_2: { prompt: "Be thorough.", temperature: 0.7 },
    },
  });
  expect(promptsSeen[1]).toContain('"status":"completed"');
  expect(promptsSeen[1]).toContain("behavioralDifference");
  // The downstream half: the record reached the tool definition the model was handed, whole.
  expect(modelFacingSchemas[0]).toMatchObject({
    properties: {
      variants: {
        type: "object",
        propertyNames: { type: "string" },
        additionalProperties: {
          type: "object",
          properties: { prompt: { type: "string" }, temperature: { type: "number" } },
          required: ["prompt", "temperature"],
        },
      },
    },
  });
});
