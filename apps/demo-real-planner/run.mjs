/**
 * demo-real-planner — wedge demo
 *
 * Supports four variants:
 *   node run.mjs single      (default) — one-shot planner → run → final output.
 *   node run.mjs supervisor  — up to 3 cycles. The planner reviews each
 *                              cycle's output and decides whether to continue
 *                              (with a note) or to stop.
 *   node run.mjs stub        — keyless deterministic planner harness smoke run.
 *   node run.mjs stub-supervisor
 *                            — keyless deterministic multi-cycle supervisor run.
 *
 * Requires: DEEPSEEK_API_KEY environment variable for single/supervisor.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import * as ai from "ai";
import { streamText, Output, jsonSchema } from "ai";
import {
  createLittleWorkflow,
  createWorkflowHarness,
  createToolRegistry,
  localWorld,
  model,
  runWorkflow,
} from "little-workflow";
import {
  decideStubSupervisorOutcome,
  DONE_RETRY_PLANNER_NOTE,
  buildSupervisorCycles,
  coerceContinuePromptNote,
  ensureCanContinueCycle,
  shouldAcceptDoneDecision,
  toFailedCycleRun,
} from "./supervisor-logic.mjs";
import { parseVariant } from "./variant-config.mjs";
import { resolveDeepseekModels } from "./provider-client.mjs";
import { PLANNER_SYSTEM_PROMPT } from "./planner-prompt.mjs";
import { lwirSchema } from "./lwir-schema.mjs";
import { supervisorDecisionSchema } from "./supervisor-decision-schema.mjs";

// ---------------------------------------------------------------------------
// Supervisor system prompt (module-level so superviseDecideNextCycle can use it)
// ---------------------------------------------------------------------------

const SUPERVISOR_SYSTEM = `\
You are reviewing the output of a candidate-review workflow cycle.
Decide whether the results are convincing enough to finalize, or whether to ask
for another cycle with a refined prompt.

Respond with a JSON object:
  { "kind": "done", "finalOutput": <the final ranking data> }
  OR
  { "kind": "continue", "promptNote": "what to focus on next cycle" }`;

// ---------------------------------------------------------------------------
// Exported helper: supervisor decision via streamText + Output.object
// ---------------------------------------------------------------------------

/**
 * Ask the supervisor model whether the current cycle output is final or needs
 * another pass. Uses structured output (Output.object) to eliminate brittle
 * text-JSON parsing.
 *
 * @param {object} options
 * @param {object} options.model - AI SDK model instance.
 * @param {object[]} options.cycles - Supervisor cycle summaries.
 * @param {string} options.goalDescription - Workflow goal description.
 * @param {unknown[]} options.latestCycleOutput - Most recent cycle output.
 * @param {string[]} options.expectedCandidateIds - Expected candidate IDs.
 * @param {Function} [options.streamText] - Injected streamText implementation (for testing).
 * @returns {Promise<{kind: "done", finalOutput: unknown[]} | {kind: "continue", promptNote: string}>}
 */
export async function superviseDecideNextCycle({
  model,
  cycles,
  goalDescription,
  latestCycleOutput,
  expectedCandidateIds,
  streamText: streamTextImpl = streamText,
}) {
  const recentCycles = cycles.slice(-3);
  const prompt = `Goal: ${goalDescription}\n\nPrior cycles (most recent ${recentCycles.length}):\n${JSON.stringify(recentCycles, null, 2)}`;
  const result = streamTextImpl({
    model,
    system: SUPERVISOR_SYSTEM,
    prompt,
    output: Output.object({ schema: supervisorDecisionSchema }),
  });
  const decisionPromise = result.output ?? result.experimental_output;
  if (decisionPromise === undefined) {
    throw new TypeError(
      "streamText result missing structured `output` for supervisor decision.",
    );
  }
  const decision = await decisionPromise;
  if (decision && decision.kind === "done") {
    if (
      !shouldAcceptDoneDecision({
        latestCycleOutput,
        supervisorFinalOutput: decision.finalOutput,
        expectedCandidateIds,
      })
    ) {
      return {
        kind: "continue",
        promptNote: DONE_RETRY_PLANNER_NOTE,
      };
    }
    return { kind: "done", finalOutput: decision.finalOutput ?? latestCycleOutput };
  }
  return {
    kind: "continue",
    promptNote: coerceContinuePromptNote(decision?.promptNote),
  };
}

// ---------------------------------------------------------------------------
// Exported helper: structured LWIR generation via streamText + Output.object
// ---------------------------------------------------------------------------

/**
 * Generate an LWIR object from the planner model using structured output.
 *
 * @param {object} options
 * @param {object} options.model - AI SDK model instance.
 * @param {object} options.task - Planner task (workflowSnapshot, input, etc).
 * @param {string|undefined} [options.promptNote] - Optional supervisor note for this cycle.
 * @param {Function} [options.streamText] - Injected streamText implementation (for testing).
 * @returns {Promise<object>} The parsed LWIR object.
 */
export async function generateLwirFromPlanner({
  model: plannerModel,
  task,
  promptNote,
  streamText: streamTextImpl = streamText,
}) {
  const result = streamTextImpl({
    model: plannerModel,
    system: buildPlannerSystemPrompt(task, promptNote),
    prompt: buildPlannerPrompt(task),
    output: Output.object({ schema: lwirSchema }),
  });
  // v6 exposes structured output on `output`; tolerate v5/v6 transition by
  // falling back to experimental_output if `output` is undefined.
  const lwirPromise = result.output ?? result.experimental_output;
  if (lwirPromise === undefined) {
    throw new TypeError(
      "streamText result is missing structured `output` for planner LWIR generation.",
    );
  }
  return await lwirPromise;
}

// ---------------------------------------------------------------------------
// Shared planner prompt helpers (used by both generateLwirFromPlanner and harness)
// ---------------------------------------------------------------------------

function buildPlannerSystemPrompt(task, promptNote) {
  const sections = [PLANNER_SYSTEM_PROMPT];
  if (promptNote !== undefined && promptNote.length > 0) {
    sections.push(`Supervisor note for this cycle:\n${promptNote}`);
  }
  if (task.outerLoopContext !== undefined) {
    sections.push(`Outer loop context:\n${JSON.stringify(task.outerLoopContext, null, 2)}`);
  }
  return sections.join("\n\n");
}

function buildPlannerPrompt(task) {
  const request = {
    workflow: task.workflowSnapshot,
    input: task.input,
    ...(task.outerLoopContext === undefined ? {} : { outerLoopContext: task.outerLoopContext }),
  };
  const sections = [
    "Return a Little Workflow Intermediate Representation (LWIR) JSON object for this planning task.",
    "The response must be a single JSON object with apiVersion, kind, metadata, input, output, permissions, and steps.",
    `Planning task:\n${JSON.stringify(request, null, 2)}`,
  ];
  return sections.join("\n\n");
}

// ---------------------------------------------------------------------------
// Exported helper: worker live call via streamText + Output.{text,object,array}
// ---------------------------------------------------------------------------

/**
 * Execute a single worker step via streamText with structured output.
 *
 * Replaces the brittle text-JSON parsing path in `generateLiveStepOutput`.
 *
 * @param {object} options
 * @param {object} options.model - AI SDK model instance.
 * @param {string|undefined} [options.system] - Optional system prompt.
 * @param {string} options.prompt - User prompt string.
 * @param {"text"|"object"|"array"} options.outputMode - Structured output mode.
 * @param {object|undefined} [options.schema] - JSON schema for object/array modes.
 * @param {object[]|undefined} [options.messages] - Optional messages (overrides prompt when provided).
 * @param {object|undefined} [options.tools] - Optional tools to pass through.
 * @param {Function} [options.streamText] - Injected streamText implementation (for testing).
 * @returns {Promise<{output?: unknown, text?: string, usage: object}>}
 */
export async function runWorkerLiveCall({
  model,
  system,
  prompt,
  outputMode,
  schema,
  messages,
  tools,
  streamText: streamTextImpl = streamText,
}) {
  const outputSpec = (() => {
    switch (outputMode) {
      case "text":
        return Output.text();
      case "object":
      case "json":
        return Output.object({ schema: jsonSchemaOrAlready(schema) });
      case "array": {
        // Use Output.object with the full array schema (type:"array", items:...)
        // instead of Output.array, which wraps the schema as {elements: T[]} and
        // breaks providers (like DeepSeek) that return a raw JSON array.
        // Output.object parses the JSON response and validates against the schema,
        // accepting a top-level array when the schema declares type:"array".
        return Output.object({ schema: jsonSchemaOrAlready(schema) });
      }
      default:
        throw new TypeError(
          `runWorkerLiveCall: unsupported outputMode '${outputMode}'.`,
        );
    }
  })();

  const request = {
    model,
    ...(system === undefined ? {} : { system }),
    ...(messages !== undefined ? { messages } : { prompt }),
    ...(tools !== undefined ? { tools: wrapPlainJsonToolSchemas(tools) } : {}),
    output: outputSpec,
  };

  const result = streamTextImpl(request);

  const usage = await result.usage;

  if (outputMode === "text") {
    const text = await result.text;
    return { output: text, text, usage };
  }

  const outputPromise = result.output ?? result.experimental_output;
  if (outputPromise === undefined) {
    throw new TypeError(
      "streamText result missing structured `output` for object/array worker step.",
    );
  }
  try {
    return { output: await outputPromise, usage };
  } catch (err) {
    // Enrich AI_NoObjectGeneratedError with the raw text so callers can diagnose
    // schema-validation failures (e.g. DeepSeek compatibility-mode wrapping).
    const rawText =
      typeof err?.text === "string"
        ? err.text
        : typeof err?.cause?.text === "string"
          ? err.cause.text
          : undefined;
    if (rawText !== undefined) {
      err.message = `${err.message}\nRaw response text: ${rawText.slice(0, 2000)}`;
    }
    throw err;
  }
}

/**
 * Wrap plain-object JSON schemas on tool `inputSchema`/`outputSchema` fields
 * so that AI SDK v6 `asSchema()` accepts them without error.
 * Mirrors the same helper in json-text.mjs, but uses the module-level
 * `jsonSchema` import rather than a parameter.
 */
function wrapPlainJsonToolSchemas(tools) {
  if (!isPlainObject(tools)) return tools;
  let changed = false;
  const wrapped = {};
  for (const [name, tool] of Object.entries(tools)) {
    if (!isPlainObject(tool)) {
      wrapped[name] = tool;
      continue;
    }
    const nextTool = { ...tool };
    for (const schemaKey of ["inputSchema", "outputSchema"]) {
      if (Object.hasOwn(nextTool, schemaKey) && isPlainJsonSchemaObject(nextTool[schemaKey])) {
        nextTool[schemaKey] = jsonSchema(nextTool[schemaKey]);
        changed = true;
      }
    }
    wrapped[name] = nextTool;
  }
  return changed ? wrapped : tools;
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlainJsonSchemaObject(schema) {
  if (!isPlainObject(schema)) return false;
  if (schema[Symbol.for("vercel.ai.schema")] === true) return false;
  if (typeof schema.safeParse === "function" || typeof schema.parse === "function") return false;
  return [
    "$ref", "$defs", "type", "properties", "items", "required",
    "additionalProperties", "enum", "const", "anyOf", "oneOf", "allOf",
  ].some((key) => Object.hasOwn(schema, key));
}

/**
 * Wrap a raw JSON schema object with `jsonSchema()` if it hasn't been wrapped
 * already, leaving AI-SDK-branded schemas and Zod schemas unchanged.
 */
function jsonSchemaOrAlready(schema) {
  if (schema === undefined || schema === null) return schema;
  if (typeof schema !== "object") return schema;
  // Zod schemas have parse/safeParse methods — AI SDK accepts them directly.
  if (typeof schema.parse === "function" || typeof schema.safeParse === "function") return schema;
  // Detect already-wrapped AI SDK schemas via the documented brand symbol.
  const aiSdkSchemaSymbol = Symbol.for("vercel.ai.schema");
  if (schema[aiSdkSchemaSymbol] === true) return schema;
  return jsonSchema(schema);
}

// ---------------------------------------------------------------------------
// Guard: only run the demo harness when invoked directly as a script
// ---------------------------------------------------------------------------

const isDirectRun =
  import.meta.url === pathToFileURL(process.argv[1] ?? "").href;

if (isDirectRun) {
  await runDemo();
}

async function runDemo() {
  // -------------------------------------------------------------------------
  // CLI arg
  // -------------------------------------------------------------------------

  let parsedVariant;
  try {
    parsedVariant = parseVariant(process.argv[2] ?? "single");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
  }
  const { variant, useStubPlanner, useSupervisorLoop, workflowId, maxCycles } = parsedVariant;

  if (!useStubPlanner && !process.env.DEEPSEEK_API_KEY) {
    console.error("Set DEEPSEEK_API_KEY to run this demo.");
    process.exit(1);
  }

  const here = dirname(fileURLToPath(import.meta.url));

  // -------------------------------------------------------------------------
  // Load fixtures
  // -------------------------------------------------------------------------

  const candidates = JSON.parse(
    await readFile(join(here, "data", "candidates.json"), "utf8"),
  );
  const jobDescription = await readFile(
    join(here, "data", "job-description.txt"),
    "utf8",
  );
  const expectedCandidateIds = candidates.map(
    (candidate, index) =>
      candidate !== null && typeof candidate === "object" && typeof candidate.id === "string"
        ? candidate.id
        : `candidate-${index + 1}`,
  );

  // -------------------------------------------------------------------------
  // AI SDK setup
  // -------------------------------------------------------------------------

  const deepseekModelId = process.env.DEEPSEEK_MODEL_ID ?? "deepseek-v4-pro";
  const deepseekBaseUrl = process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com/v1";
  const deepseekModels = useStubPlanner
    ? undefined
    : resolveDeepseekModels({
      apiKey: process.env.DEEPSEEK_API_KEY,
      baseURL: deepseekBaseUrl,
      modelId: deepseekModelId,
    });
  const plannerModel = useStubPlanner
    ? { provider: "stub", modelId: "stub-planner" }
    : deepseekModels.plannerModel;
  const workerModel = useStubPlanner
    ? { provider: "stub", modelId: "stub-worker" }
    : deepseekModels.workerModel;

  const inputSchema = {
    type: "object",
    required: ["candidates", "jobDescription"],
    additionalProperties: false,
    properties: {
      candidates: { type: "array", items: { type: "object" } },
      jobDescription: { type: "string" },
    },
  };

  const rankingItemSchema = {
    type: "object",
    required: ["id", "score", "reasoning"],
    additionalProperties: true,
    properties: {
      id: { type: "string" },
      score: { type: "number", minimum: 0, maximum: 100 },
      reasoning: { type: "string" },
    },
  };
  const rankingArraySchema = {
    type: "array",
    items: rankingItemSchema,
  };

  let plannerPromptNote;

  const workerHarness = createWorkflowHarness({
    aiLoop: {
      generate: async ({ model, system, tools, step, input }) => {
        if (step.output === undefined) {
          throw new TypeError(`Step '${step.id}' must declare an output contract.`);
        }

        const stepSystem = typeof step.with?.system === "string"
          ? step.with.system
          : undefined;
        const prompt = typeof step.with?.prompt === "string"
          ? step.with.prompt
          : undefined;
        const renderedPrompt = renderPromptTemplate(prompt, input);
        const mergedSystem = [system, stepSystem].filter(Boolean).join("\n\n") || undefined;
        const mergedMessages = [{
          role: "user",
          content: renderedPrompt,
        }];
        const result = useStubPlanner
          ? generateStubStepOutput({ step, input })
          : await generateLiveStepOutput({
            model,
            system: mergedSystem,
            messages: mergedMessages,
            tools,
            output: step.output,
          });

        return {
          output: result.output,
          ...(result.text === undefined ? {} : { text: result.text }),
          usage: {
            inputTokens: result.usage?.inputTokens ?? 0,
            outputTokens: result.usage?.outputTokens ?? 0,
          },
        };
      },
    },
  });

  const plannerHarness = {
    harnessId: "deepseekPlannerHarness@1.0.0",
    async run(task) {
      if (task.kind !== "plan") {
        return { kind: "delegate_to_default" };
      }
      if (useStubPlanner) {
        const workflowName = typeof task.workflowSnapshot?.id === "string"
          ? task.workflowSnapshot.id
          : workflowId;
        return {
          kind: "plan",
          lwir: stubPlannerLwir({
            workflowName,
            inputSchema,
            rankingItemSchema,
          }),
        };
      }
      const lwir = await generateLwirFromPlanner({
        model: plannerModel,
        task,
        promptNote: plannerPromptNote,
      });
      return { kind: "plan", lwir };
    },
  };

  // -------------------------------------------------------------------------
  // World + workflow definition
  // -------------------------------------------------------------------------

  const world = localWorld({
    dataDir: ".little-workflow-demo-real-planner",
    maxConcurrentSteps: 4,
  });

  const workerSlot = model(workerModel, {
    id: "model.worker",
    description: "Fast worker model for demo steps.",
  });

  const SYSTEM_PROMPT = PLANNER_SYSTEM_PROMPT;

  const workflow = createLittleWorkflow({
    id: workflowId,
    description:
      "Rank the candidates against the job description; output a sorted array of { id, score, reasoning }.",
    inputSchema,
    output: { kind: "array", element: rankingItemSchema },
    models: [workerSlot],
    planner: {
      model: plannerModel,
      harness: plannerHarness,
      system: SYSTEM_PROMPT,
    },
    globalTools: useStubPlanner ? ["score_candidate"] : [],
    worker: { harness: workerHarness },
  });

  const tools = createToolRegistry(
    useStubPlanner
      ? {
          score_candidate: ai.tool({
            description: "Score all candidates deterministically for the stub planner variant.",
            inputSchema: {
              type: "object",
              required: ["candidates", "jobDescription"],
              additionalProperties: false,
              properties: {
                candidates: { type: "array", items: { type: "object" } },
                jobDescription: { type: "string" },
              },
            },
            outputSchema: rankingArraySchema,
            execute: async ({ candidates, jobDescription }) => {
              const rows = Array.isArray(candidates) ? candidates : [];
              const description = typeof jobDescription === "string" ? jobDescription : "";
              return rows
                .map((candidate, index) => scoreCandidateDeterministically(candidate, description, index))
                .sort((left, right) => right.score - left.score);
            },
          }),
        }
      : {},
  );

  // -------------------------------------------------------------------------
  // Run
  // -------------------------------------------------------------------------

  console.log(`# demo-real-planner [${variant}]: candidate ranking via AI-generated LWIR`);
  console.log(`Candidates: ${candidates.map((c) => c.name).join(", ")}`);
  console.log(`Max outer cycles: ${maxCycles}`);
  console.log();

  const cycleRuns = [];
  const cycleSummaries = [];
  let finalOutput;
  let cycleNumber = 0;
  while (cycleNumber < maxCycles) {
    cycleNumber += 1;
    let cycleRun;
    let latestCycleOutput;

    try {
      const result = await runWorkflow({
        world,
        workflows: workflow,
        input: { candidates, jobDescription },
        ...(useStubPlanner ? { tools } : {}),
        runId: `run_demo_real_planner_${variant}_${cycleNumber}_${Date.now()}`,
      });
      cycleRun = result;
      latestCycleOutput = result.output;
    } catch (error) {
      const failedCycle = toFailedCycleRun(error, cycleNumber);
      if (!useSupervisorLoop || failedCycle === undefined) {
        throw error;
      }
      cycleRun = failedCycle;
      latestCycleOutput = failedCycle.output;
    }

    cycleRuns.push(cycleRun);

    if (!useSupervisorLoop) {
      finalOutput = latestCycleOutput;
      break;
    }

    const decision = useStubPlanner
      ? decideStubSupervisorOutcome({
          cycleNumber,
          maxCycles,
          latestCycleOutput,
          expectedCandidateIds,
        })
      : await superviseNextCycle({
          goalDescription: workflow.description ?? workflow.id,
          cycles: buildSupervisorCycles({ cycleRuns, cycleSummaries }),
          expectedCandidateIds,
          latestCycleOutput,
        });

    if (decision.kind === "done") {
      finalOutput = decision.finalOutput;
      break;
    }

    const nextPromptNote = coerceContinuePromptNote(decision.promptNote);
    cycleSummaries[cycleRuns.length - 1] = nextPromptNote;
    ensureCanContinueCycle({ cycleNumber, maxCycles });
    plannerPromptNote = nextPromptNote;
  }

  const result = cycleRuns.at(-1);
  if (result === undefined) {
    throw new Error("Demo did not execute any cycle.");
  }
  if (finalOutput === undefined) {
    throw new Error("Supervisor loop ended without a final output.");
  }

  // PlannerDraftedWorkflow fires once per cycle; show the last one.
  const resultEvents = Array.isArray(result.events) ? result.events : [];
  const plannerDraftedEvents = resultEvents.filter(
    (event) => event.type === "PlannerDraftedWorkflow",
  );
  const lastLwirEvent = plannerDraftedEvents.at(-1);
  const generatedLwir = lastLwirEvent?.payload?.lwir;

  console.log(
    `=== Generated LWIR (cycle ${cycleRuns.length} of ${maxCycles}) ===`,
  );
  if (generatedLwir !== undefined) {
    console.log(JSON.stringify(generatedLwir, null, 2));
  } else {
    console.log("(LWIR not found in event stream — check events for details)");
    const eventTypes = resultEvents.map((e) => e.type);
    console.log("Event types seen:", eventTypes.join(", "));
  }

  console.log();
  console.log("=== Final Output ===");
  console.log(JSON.stringify(finalOutput, null, 2));

  console.log();
  console.log(
    `Run ${result.runId} completed. Events: ${resultEvents.length}. Cycles: ${cycleRuns.length}.`,
  );

  async function superviseNextCycle({
    goalDescription,
    cycles,
    expectedCandidateIds,
    latestCycleOutput,
  }) {
    return superviseDecideNextCycle({
      model: plannerModel,
      cycles,
      goalDescription,
      latestCycleOutput,
      expectedCandidateIds,
    });
  }

  async function generateLiveStepOutput({
    model,
    system,
    messages,
    tools,
    output,
  }) {
    return runWorkerLiveCall({
      model,
      system,
      // Pass messages directly; runWorkerLiveCall prefers messages over prompt
      // when both are provided.
      messages,
      tools,
      outputMode: output.mode,
      schema: output.schema,
    });
  }
}

// ---------------------------------------------------------------------------
// Pure utility functions (module-level, safe to import)
// ---------------------------------------------------------------------------

function renderPromptTemplate(prompt, input) {
  const fallback = `Use this input JSON:\n${safeJson(input)}`;
  if (typeof prompt !== "string" || prompt.length === 0) {
    return fallback;
  }

  const rendered = prompt.replace(/\{\{\s*(input|item)\.([^{}]+)\s*\}\}/gu, (_whole, _root, path) => {
    const value = readPath(input, path.trim());
    return value === undefined ? "" : safeScalar(value);
  });

  if (rendered.includes("{{") || rendered.includes("}}")) {
    return fallback;
  }
  return `${rendered}\n\n${fallback}`;
}

function readPath(root, rawPath) {
  const normalized = rawPath
    .replace(/\[(\d+)\]/gu, ".$1")
    .replace(/\[['"]([^'"]+)['"]\]/gu, ".$1");
  const segments = normalized.split(".").filter(Boolean);
  let current = root;
  for (const segment of segments) {
    if (current === null || typeof current !== "object") {
      return undefined;
    }
    if (!Object.hasOwn(current, segment)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

function safeScalar(value) {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null) return "null";
  return safeJson(value);
}

function safeJson(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function generateStubStepOutput({ step, input }) {
  const mode = step.output?.mode;
  const output = mode === "text"
    ? `Stub deterministic output for ${step.id}`
    : input;
  return {
    output,
    ...(mode === "text" ? { text: output } : {}),
    usage: {
      inputTokens: 0,
      outputTokens: 0,
    },
  };
}

function stubPlannerLwir({ workflowName, inputSchema, rankingItemSchema }) {
  return {
    apiVersion: "littleworkflow.dev/v0.1",
    kind: "Workflow",
    metadata: {
      name: workflowName,
      version: "0.1.0-alpha",
      description: "Deterministic keyless candidate ranking workflow.",
    },
    input: { schema: inputSchema },
    output: { schema: { type: "array", items: rankingItemSchema } },
    permissions: {
      tools: ["score_candidate"],
      models: [],
      secrets: [],
      network: [],
    },
    steps: [
      {
        id: "score-candidates",
        uses: "tool.call",
        with: { tool: "score_candidate" },
        input: {
          candidates: "{{ input.candidates }}",
          jobDescription: "{{ input.jobDescription }}",
        },
        output: {
          mode: "array",
          schema: { type: "array", items: rankingItemSchema },
        },
      },
    ],
  };
}

function scoreCandidateDeterministically(candidate, jobDescription, index) {
  const row = candidate !== null && typeof candidate === "object" ? candidate : {};
  const id = typeof row.id === "string" ? row.id : `candidate-${index + 1}`;
  const summary = typeof row.summary === "string" ? row.summary : "";
  const seed = `${id} ${summary} ${jobDescription}`;
  const hash = stableHash(seed);
  const score = 50 + (hash % 51);
  return {
    id,
    score,
    reasoning: `Stub deterministic score for ${id}`,
  };
}

function stableHash(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
