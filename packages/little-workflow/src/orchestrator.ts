import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tool } from "ai";
import { z } from "zod";
import type { LocalWorld } from "./authoring.js";
import { sha256Digest } from "./canonical.js";
import {
  compileWorkflow,
  type CompilableWorkflowDefinition,
} from "./compiler.js";
import type { WorkflowDefinitionSnapshot } from "./harness/types.js";
import { validateAlphaJsonSchema } from "./lwir.js";
import { normalizeOutputMode, normalizeSchema } from "./schema.js";
import type { AiSdkTool, ToolRegistry } from "./tool-registry.js";
import { getWorkflowDefinitionHash } from "./workflow-definition-hash.js";
import type { WorkflowVersionReusePolicy } from "./workflow-version-reuse.js";
import type { ArtifactRef } from "./world.js";

type PlannedWorkflowVersion = {
  readonly id: string;
  readonly lwir: unknown;
  readonly lock?: unknown;
  readonly [key: string]: unknown;
};

export type PlanWorkflowDelegate = (options: {
  readonly workflow: CompilableWorkflowDefinition;
  readonly input: unknown;
  readonly tools?: ToolRegistry;
  readonly signal?: AbortSignal;
}) => Promise<{
  readonly workflowVersion: PlannedWorkflowVersion;
}>;

export type RunWorkflowVersionDelegate = (options: {
  readonly world: LocalWorld;
  readonly workflow: CompilableWorkflowDefinition;
  readonly workflowVersion: PlannedWorkflowVersion;
  readonly input: unknown;
  readonly runId: string;
  readonly tools?: ToolRegistry;
  readonly workflowVersionReuse?: WorkflowVersionReusePolicy;
  readonly signal?: AbortSignal;
}) => Promise<{
  readonly runId: string;
  readonly status: "completed" | "failed";
  readonly output?: unknown;
  readonly outputRef?: ArtifactRef;
  readonly artifacts?: readonly ArtifactRef[];
  readonly error?: { readonly message: string };
}>;

export type OrchestratorToolOptions = {
  readonly world: LocalWorld;
  readonly workflows: readonly CompilableWorkflowDefinition[];
  readonly tools?: ToolRegistry;
  readonly maxConcurrentSubRuns?: number;
  readonly planWorkflow?: PlanWorkflowDelegate;
  readonly readWorkflowVersion?: (workflowVersionId: string) => Promise<PlannedWorkflowVersion | undefined>;
  readonly executeWorkflowVersion: RunWorkflowVersionDelegate;
  readonly createRunId?: () => string;
  readonly resultStore?: {
    readonly backingDir: string;
    readonly mountDir: string;
  };
};

type WorkflowToolExecutionOptions = {
  readonly caller?: "code" | "model";
  readonly abortSignal?: AbortSignal;
  readonly experimental_context?: {
    readonly signal?: AbortSignal;
  };
};

type WorkflowRunToolResult = {
  readonly runId: string;
  readonly status: "completed" | "failed";
  readonly output?: unknown;
  readonly outputRef?: ArtifactRef;
  readonly outputPath?: string;
  readonly outputSummary?: OutputSummary;
  readonly artifacts?: readonly ArtifactRef[];
  readonly error?: { readonly message: string };
};

type OutputSummary =
  | {
      readonly kind: "array";
      readonly itemCount: number;
      readonly sizeBytes: number;
      readonly sha256: string;
    }
  | {
      readonly kind: "object";
      readonly fieldCount: number;
      readonly fields: readonly string[];
      readonly sizeBytes: number;
      readonly sha256: string;
    }
  | {
      readonly kind: "string" | "number" | "boolean" | "null" | "unknown";
      readonly sizeBytes: number;
      readonly sha256: string;
    };

const workflowRunToolOutputSchema = z.object({
  runId: z.string(),
  status: z.enum(["completed", "failed"]),
  output: z.unknown().optional(),
  outputRef: z.string().optional(),
  outputPath: z.string().optional(),
  outputSummary: z.record(z.string(), z.unknown()).optional(),
  artifacts: z.array(z.string()).optional(),
  error: z.object({ message: z.string() }).optional(),
});
const runWorkflowInputSchema = z.object({
  workflowVersionId: z.string(),
  input: z.unknown(),
});
const startWorkflowInputSchema = z.object({
  workflowId: z.string(),
  input: z.unknown(),
});

export function workflowSnapshotsForOrchestrator(
  workflows: readonly CompilableWorkflowDefinition[],
  tools?: ToolRegistry,
): readonly WorkflowDefinitionSnapshot[] {
  return [...workflows]
    .map((workflow) => workflowSnapshot(workflow, tools))
    .sort((left, right) => compareStrings(left.id, right.id));
}

export function createOrchestratorTools(
  options: OrchestratorToolOptions,
): Record<"plan_workflow" | "run_workflow" | "start_workflow", AiSdkTool> {
  const maxConcurrentSubRuns = options.maxConcurrentSubRuns ?? 10;
  if (!Number.isInteger(maxConcurrentSubRuns) || maxConcurrentSubRuns < 1) {
    throw new Error("createOrchestratorTools: maxConcurrentSubRuns must be an integer >= 1.");
  }

  const workflowById = mapWorkflowsById(options.workflows);
  const planWorkflow = options.planWorkflow ?? defaultPlanWorkflow;
  const executeWorkflowVersion = options.executeWorkflowVersion;
  const createRunId = options.createRunId ?? (() => `run_${randomUUID()}`);
  const scheduleSubRun = createConcurrencyGate(maxConcurrentSubRuns);
  const workflowByDefinitionHash = mapWorkflowsByDefinitionHash(options.workflows, options.tools);
  const plannedVersions = new Map<string, {
    readonly workflow: CompilableWorkflowDefinition;
    readonly workflowVersion: PlannedWorkflowVersion;
  }>();

  async function planWorkflowVersion(
    workflowId: string,
    input: unknown,
    executeOptions?: unknown,
  ): Promise<string> {
    const workflow = workflowById.get(workflowId);
    if (workflow === undefined) {
      throw new Error(`Unknown workflow id '${workflowId}'.`);
    }
    const planned = await planWorkflow({
      workflow,
      input,
      tools: options.tools,
      signal: abortSignalFromToolOptions(executeOptions),
    });
    plannedVersions.set(planned.workflowVersion.id, {
      workflow,
      workflowVersion: planned.workflowVersion,
    });
    return planned.workflowVersion.id;
  }

  async function runWorkflowByVersion(
    workflowVersionId: string,
    input: unknown,
    executeOptions?: unknown,
    subRunId?: string,
  ): Promise<WorkflowRunToolResult> {
    const planned = await plannedWorkflowVersionFor(workflowVersionId);
    if (planned === undefined) {
      throw new Error(`Unknown workflowVersionId '${workflowVersionId}'.`);
    }

    const runId = subRunId ?? createRunId();
    const result = await scheduleSubRun(() => executeWorkflowVersion({
      world: options.world,
      workflow: planned.workflow,
      workflowVersion: planned.workflowVersion,
      input,
      runId,
      tools: options.tools,
      workflowVersionReuse: "structure",
      signal: abortSignalFromToolOptions(executeOptions),
    }));
    return workflowRunToolResultForCaller(result, options.resultStore, executeOptions);
  }

  return {
    plan_workflow: tool({
      description:
        "Draft an LWIR for one representative workflow input and return a reusable workflowVersionId. Use run_workflow for same-shape inputs, or use start_workflow when a different input shape may need a fresh plan.",
      inputSchema: z.object({
        workflowId: z.string(),
        input: z.unknown(),
      }),
      outputSchema: z.object({
        workflowVersionId: z.string(),
      }),
      execute: async ({ workflowId, input }, executeOptions?: unknown) => ({
        workflowVersionId: await planWorkflowVersion(workflowId, input, executeOptions),
      }),
    }),
    run_workflow: {
      description:
        "Execute a previously planned workflowVersionId. The input must be structure-compatible with the input used by plan_workflow; use start_workflow when the input shape or workflow steps may differ. Model-facing calls return compact metadata; read outputPath with bash when full output is needed.",
      inputSchema: runWorkflowInputSchema,
      outputSchema: workflowRunToolOutputSchema,
      execute: async (rawInput: any, executeOptions?: unknown) => {
        const { workflowVersionId, input } = rawInput as {
          readonly workflowVersionId: string;
          readonly input: unknown;
        };
        return runWorkflowByVersion(
          workflowVersionId,
          input,
          executeOptions,
          subRunIdFromInput(rawInput),
        );
      },
    },
    start_workflow: {
      description:
        "Plan then run a workflow in one call for the provided input. Model-facing calls return compact metadata; read outputPath with bash when full output is needed.",
      inputSchema: startWorkflowInputSchema,
      outputSchema: workflowRunToolOutputSchema.extend({
        workflowVersionId: z.string(),
      }),
      execute: async (rawInput: any, executeOptions?: unknown) => {
        const { workflowId, input } = rawInput as {
          readonly workflowId: string;
          readonly input: unknown;
        };
        const workflowVersionId = await planWorkflowVersion(workflowId, input, executeOptions);
        const run = await runWorkflowByVersion(
          workflowVersionId,
          input,
          executeOptions,
          subRunIdFromInput(rawInput),
        );
        return {
          workflowVersionId,
          ...run,
        };
      },
    },
  };

  async function plannedWorkflowVersionFor(
    workflowVersionId: string,
  ): Promise<
    | {
      readonly workflow: CompilableWorkflowDefinition;
      readonly workflowVersion: PlannedWorkflowVersion;
    }
    | undefined
  > {
    const planned = plannedVersions.get(workflowVersionId);
    if (planned !== undefined) {
      return planned;
    }
    if (options.readWorkflowVersion === undefined) {
      return undefined;
    }
    const workflowVersion = await options.readWorkflowVersion(workflowVersionId);
    if (workflowVersion === undefined) {
      return undefined;
    }
    const workflowDefinitionHash = workflowDefinitionHashForWorkflowVersion(workflowVersion);
    if (workflowDefinitionHash === undefined) {
      return undefined;
    }
    const workflow = workflowByDefinitionHash.get(workflowDefinitionHash);
    if (workflow === undefined) {
      return undefined;
    }
    const recovered = { workflow, workflowVersion };
    plannedVersions.set(workflowVersion.id, recovered);
    return recovered;
  }
}

function subRunIdFromInput(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return typeof value.subRunId === "string" && value.subRunId.length > 0
    ? value.subRunId
    : undefined;
}

async function workflowRunToolResultForCaller(
  result: Awaited<ReturnType<RunWorkflowVersionDelegate>>,
  resultStore: OrchestratorToolOptions["resultStore"],
  executeOptions: unknown,
): Promise<WorkflowRunToolResult> {
  if (!isModelToolExecution(executeOptions)) {
    return legacyWorkflowRunToolResult(result);
  }
  if (resultStore === undefined || result.output === undefined) {
    return result;
  }
  const stored = await writeModelFacingOutput(resultStore, result.runId, result.output);
  return {
    runId: result.runId,
    status: result.status,
    outputRef: result.outputRef,
    outputPath: stored.outputPath,
    outputSummary: stored.outputSummary,
    ...(result.artifacts === undefined ? {} : { artifacts: result.artifacts }),
    ...(result.error === undefined ? {} : { error: result.error }),
  };
}

function legacyWorkflowRunToolResult(
  result: Awaited<ReturnType<RunWorkflowVersionDelegate>>,
): WorkflowRunToolResult {
  return {
    runId: result.runId,
    status: result.status,
    ...(result.output === undefined ? {} : { output: result.output }),
    ...(result.error === undefined ? {} : { error: result.error }),
  };
}

function isModelToolExecution(value: unknown): value is WorkflowToolExecutionOptions {
  return isRecord(value) && value.caller === "model";
}

function abortSignalFromToolOptions(value: unknown): AbortSignal | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (value.abortSignal instanceof AbortSignal) {
    return value.abortSignal;
  }
  const experimentalContext = value.experimental_context;
  if (isRecord(experimentalContext) && experimentalContext.signal instanceof AbortSignal) {
    return experimentalContext.signal;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function writeModelFacingOutput(
  resultStore: NonNullable<OrchestratorToolOptions["resultStore"]>,
  runId: string,
  output: unknown,
): Promise<{
  readonly outputPath: string;
  readonly outputSummary: OutputSummary;
}> {
  const runSegment = safePathSegment(runId);
  const outputDirectory = join(resultStore.backingDir, runSegment);
  await mkdir(outputDirectory, { recursive: true });
  const text = `${JSON.stringify(output, null, 2)}\n`;
  await writeFile(join(outputDirectory, "output.json"), text, "utf8");
  return {
    outputPath: `${trimTrailingSlash(resultStore.mountDir)}/${runSegment}/output.json`,
    outputSummary: summarizeOutput(output, Buffer.byteLength(text, "utf8")),
  };
}

function summarizeOutput(output: unknown, sizeBytes: number): OutputSummary {
  const sha256 = sha256Digest(output);
  if (Array.isArray(output)) {
    return {
      kind: "array",
      itemCount: output.length,
      sizeBytes,
      sha256,
    };
  }
  if (output !== null && typeof output === "object") {
    const fields = Object.keys(output).sort();
    return {
      kind: "object",
      fieldCount: fields.length,
      fields: fields.slice(0, 20),
      sizeBytes,
      sha256,
    };
  }
  return {
    kind: scalarOutputKind(output),
    sizeBytes,
    sha256,
  };
}

function scalarOutputKind(output: unknown): "string" | "number" | "boolean" | "null" | "unknown" {
  if (output === null) {
    return "null";
  }
  const kind = typeof output;
  if (kind === "string" || kind === "number" || kind === "boolean") {
    return kind;
  }
  return "unknown";
}

function safePathSegment(value: string): string {
  return encodeURIComponent(value).replace(/\./gu, "%2E");
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, "");
}

function workflowSnapshot(
  workflow: CompilableWorkflowDefinition,
  tools: ToolRegistry | undefined,
): WorkflowDefinitionSnapshot {
  const inputSchema = normalizeSchema(workflow.inputSchema ?? true);
  const suggestedInputSchema = workflow.suggestedInputSchema === undefined
    ? undefined
    : normalizeSchema(workflow.suggestedInputSchema);
  validateSchema(inputSchema, "$.inputSchema");
  if (suggestedInputSchema !== undefined) {
    validateSchema(suggestedInputSchema, "$.suggestedInputSchema");
  }
  return {
    id: workflow.id,
    description: workflow.description ?? "",
    inputSchema,
    ...(suggestedInputSchema === undefined ? {} : { suggestedInputSchema }),
    outputSchema: outputSchemaForSnapshot(workflow),
    workflowDefinitionHash: getWorkflowDefinitionHash(workflow, tools),
  };
}

function validateSchema(schema: unknown, path: string): void {
  const findings = validateAlphaJsonSchema(schema, path);
  if (findings.length > 0) {
    throw new Error(
      findings.map((finding) => `${finding.path}: ${finding.message}`).join("; "),
    );
  }
}

function outputSchemaForSnapshot(workflow: CompilableWorkflowDefinition): unknown {
  const output = normalizeOutputMode(
    workflow.output ?? { kind: "object", schema: workflow.outputSchema ?? true },
  );
  switch (output.kind) {
    case "text":
      return { type: "string" };
    case "object":
      return output.schema;
    case "array":
      return { type: "array", items: output.element };
    case "choice":
      return {
        type: "string",
        enum: output.values,
      };
    case "json":
      return output.schema ?? true;
  }
}

const defaultPlanWorkflow: PlanWorkflowDelegate = async ({ workflow, input, tools }) => {
  const compiled = await compileWorkflow(workflow, { input, tools });
  return {
    workflowVersion: compiled.workflowVersion as unknown as PlannedWorkflowVersion,
  };
};

function mapWorkflowsById(
  workflows: readonly CompilableWorkflowDefinition[],
): ReadonlyMap<string, CompilableWorkflowDefinition> {
  const map = new Map<string, CompilableWorkflowDefinition>();
  for (const workflow of workflows) {
    if (map.has(workflow.id)) {
      throw new Error(`createOrchestratorTools: duplicate workflow id '${workflow.id}'.`);
    }
    map.set(workflow.id, workflow);
  }
  return map;
}

function mapWorkflowsByDefinitionHash(
  workflows: readonly CompilableWorkflowDefinition[],
  tools: ToolRegistry | undefined,
): ReadonlyMap<string, CompilableWorkflowDefinition> {
  const map = new Map<string, CompilableWorkflowDefinition>();
  for (const workflow of workflows) {
    const hash = getWorkflowDefinitionHash(workflow, tools);
    if (!map.has(hash)) {
      map.set(hash, workflow);
    }
  }
  return map;
}

function workflowDefinitionHashForWorkflowVersion(
  workflowVersion: PlannedWorkflowVersion,
): string | undefined {
  const lock = workflowVersion.lock;
  if (!isRecord(lock)) {
    return undefined;
  }
  const hash = lock.workflowDefinitionHash;
  return typeof hash === "string" && hash.length > 0 ? hash : undefined;
}

function createConcurrencyGate(
  maxConcurrency: number,
): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const queue: Array<() => void> = [];

  return async function schedule<T>(task: () => Promise<T>): Promise<T> {
    if (active >= maxConcurrency) {
      await new Promise<void>((resolve) => queue.push(resolve));
    }
    active += 1;
    try {
      return await task();
    } finally {
      active -= 1;
      queue.shift()?.();
    }
  };
}

function compareStrings(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}
