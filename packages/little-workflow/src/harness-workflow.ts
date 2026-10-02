import type {
  HarnessWorkflow,
  HarnessWorkflowExecution,
  HarnessWorkflowInputSchema,
  HarnessWorkflowRunContext,
} from "little-harness";
import {
  buildRunWorkflowOptions,
  localWorld,
  type ErgonomicRunWorkflowOptions,
  type WorkflowDefinition,
  type WorkflowRunProgressEvent,
} from "./authoring.js";
import { normalizeSchema } from "./schema.js";
import { RunFailedError, runWorkflow as runWorkflowCore } from "./runtime.js";

export type HarnessWorkflowSchemaMarkerOptions = {
  readonly allowUntypedInput?: boolean;
  readonly allowLossyStandardSchema?: boolean;
};

export type HarnessWorkflowAdapterOptions =
  ErgonomicRunWorkflowOptions &
  HarnessWorkflowSchemaMarkerOptions & {
    readonly executionMode?: "inline" | "durable";
    readonly definitionIdentity: HarnessWorkflow["definitionIdentity"];
  };

export function asHarnessWorkflow(
  // `any`, not `unknown`: a typed `defineWorkflow` result is not assignable to
  // `WorkflowDefinition<unknown, unknown>` (its input sits in contravariant positions), and
  // the adapter validates input at run time anyway.
  workflow: WorkflowDefinition<any, any>,
  options: HarnessWorkflowAdapterOptions,
): HarnessWorkflow {
  if (options.definitionIdentity === undefined) {
    throw new Error(
      "Manual Harness workflow adapters require definition identity. Use loadWorkflow(...) for folder-derived identity, or pass a stable hash / notApplicable marker explicitly.",
    );
  }
  const allowUntypedInput = options.allowUntypedInput;
  const allowLossyStandardSchema = options.allowLossyStandardSchema;
  const executionMode = options.executionMode ?? "inline";
  const definitionIdentity = options.definitionIdentity;
  const runDefaults = workflowRunDefaults(options);

  return {
    id: workflow.id,
    ...(workflow.description === undefined ? {} : { description: workflow.description }),
    inputSchema: toHarnessWorkflowInputSchemaMarker(workflow.inputSchema, {
      allowUntypedInput,
      allowLossyStandardSchema,
    }),
    executionMode,
    definitionIdentity,
    async runForHarness(input: unknown, ctx: HarnessWorkflowRunContext): Promise<HarnessWorkflowExecution> {
      const unsupported = validateHarnessRunContext(ctx, executionMode);
      if (unsupported !== undefined) return unsupported;

      try {
        const runOptions = buildRunWorkflowOptions(
          workflow as WorkflowDefinition<any, any>,
          input as never,
          runDefaults,
        );
        const result = await runWorkflowCore({
          ...runOptions,
          world: runDefaults.world ?? localWorld({ dataDir: ctx.persistence.dataDir }),
          runId: ctx.reservedRunId as never,
          signal: ctx.abortSignal,
          progress: withHarnessProgress(runOptions.progress, ctx),
        });
        if (result.status === "completed") {
          return {
            protocolVersion: 1,
            status: "completed",
            runId: result.runId,
            output: result.output,
            // `output` is dropped by the Harness tool-result compactor; `summary` is the only
            // field that reaches the model that invoked this workflow tool.
            summary: summarizeWorkflowOutput(result.output, result.runId),
          };
        }
        return {
          protocolVersion: 1,
          status: "failed",
          runId: result.runId,
          causeCode: "workflow_failed",
          message: "Workflow run failed.",
        };
      } catch (error) {
        const mapped = mapWorkflowError(error, ctx.reservedRunId);
        if (mapped !== undefined) return mapped;
        return {
          protocolVersion: 1,
          status: "failed",
          runId: ctx.reservedRunId,
          causeCode: "workflow_failed",
          message: (error instanceof Error ? error.message : String(error)) || "Workflow run failed.",
        };
      }
    },
  };
}

export function toHarnessWorkflowInputSchemaMarker(
  schema: unknown,
  options: HarnessWorkflowSchemaMarkerOptions,
): HarnessWorkflowInputSchema {
  if (schema === undefined) {
    return { kind: "untyped", allowUntypedInput: options.allowUntypedInput === true };
  }

  try {
    const normalized = normalizeSchema(schema);
    if (normalized === true) {
      return { kind: "untyped", allowUntypedInput: options.allowUntypedInput === true };
    }
    return { kind: "json-schema", schema: normalized };
  } catch (error) {
    if (isExecutableSchemaLike(schema)) {
      return {
        kind: "unconvertible",
        error: error instanceof Error ? error.message : String(error),
      };
    }
    if (isStandardSchema(schema)) {
      const portable = extractStandardSchemaJsonSchema(schema);
      if (portable !== undefined) {
        return { kind: "json-schema", schema: portable };
      }
      if (options.allowLossyStandardSchema === true) {
        return {
          kind: "json-schema",
          schema: true,
          lossy: true,
          warning:
            "Opaque StandardSchema validator was exposed as an unconstrained JSON Schema. Runtime workflow validation remains authoritative.",
        };
      }
      return {
        kind: "unconvertible",
        error: "Opaque StandardSchema validators cannot be converted to JSON Schema without allowLossyStandardSchema.",
      };
    }
    return {
      kind: "unconvertible",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function mapWorkflowError(
  error: unknown,
  runId: string,
): HarnessWorkflowExecution | undefined {
  if (error instanceof RunFailedError) {
    // `message` already carries the failure text; the summary adds the failing step path and the
    // runtime cause code, which the Harness cause-code vocabulary collapses away.
    const summary = runFailureSummary(error, runId);
    switch (error.causeCode) {
      case "cancelled":
        return {
          protocolVersion: 1,
          status: "cancelled",
          runId: error.runId ?? runId,
          causeCode: "cancelled",
          message: error.message || "Run was cancelled.",
          ...summary,
        };
      case "timeout":
        return {
          protocolVersion: 1,
          status: "failed",
          runId: error.runId ?? runId,
          causeCode: "timeout",
          message: error.message || "Run timed out.",
          ...summary,
        };
      case "input_schema_error":
      case "step_schema_error":
        return {
          protocolVersion: 1,
          status: "failed",
          runId: error.runId ?? runId,
          causeCode: "input_validation",
          message: error.message || "Input validation failed.",
          ...summary,
        };
      default:
        return {
          protocolVersion: 1,
          status: "failed",
          runId: error.runId ?? runId,
          causeCode: "workflow_failed",
          message: error.message || "Workflow run failed.",
          ...summary,
        };
    }
  }

  if (error instanceof Error && error.name === "AbortError") {
    return {
      protocolVersion: 1,
      status: "cancelled",
      runId,
      causeCode: "cancelled",
      message: error.message || "Run was cancelled.",
    };
  }
  if (error instanceof Error && error.name === "TimeoutError") {
    return {
      protocolVersion: 1,
      status: "failed",
      runId,
      causeCode: "timeout",
      message: error.message || "Run timed out.",
    };
  }
  return undefined;
}

/**
 * Character cap for the inline execution summary handed back to the calling model.
 *
 * The Harness tool-result compactor drops a completed run's `output` entirely, so this summary is
 * the model's only view of the result. 4096 characters is roughly 1–1.5K tokens: enough for the
 * model to act on a real result inline, small enough that one chatty workflow cannot flood the
 * calling turn's context. Bounded in characters (not bytes) so the cap and the truncation marker
 * are measured in the same unit as the string being sliced.
 */
export const MAX_WORKFLOW_OUTPUT_SUMMARY_CHARACTERS = 4096;

/**
 * Render a workflow result into a compact, deterministic string for the calling model.
 *
 * Deterministic: the same value always renders to the same summary. Total-failure-proof: a value
 * that cannot be rendered degrades to a placeholder rather than turning a completed run into a
 * failed tool call.
 */
export function summarizeWorkflowOutput(
  output: unknown,
  runId: string,
  maxCharacters: number = MAX_WORKFLOW_OUTPUT_SUMMARY_CHARACTERS,
): string {
  const text = renderWorkflowOutput(output);
  if (text.length <= maxCharacters) return text;
  // Never split a surrogate pair — a lone high surrogate is an invalid string for the consumer.
  const head = trimTrailingLoneSurrogate(text.slice(0, maxCharacters));
  return `${head}…[truncated: ${head.length} of ${text.length} characters; the full value is recorded in run ${runId}]`;
}

function renderWorkflowOutput(output: unknown): string {
  if (typeof output === "string") return output;
  try {
    const rendered = JSON.stringify(output);
    // JSON.stringify returns undefined for undefined / functions / symbols.
    if (typeof rendered === "string") return rendered;
  } catch {
    // Circular references, BigInt, or a throwing toJSON — fall through to a best-effort rendering.
  }
  try {
    return String(output);
  } catch {
    return `[unrenderable ${typeof output} workflow output]`;
  }
}

function trimTrailingLoneSurrogate(text: string): string {
  const last = text.charCodeAt(text.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? text.slice(0, -1) : text;
}

function runFailureSummary(
  error: RunFailedError,
  runId: string,
): { readonly summary?: string } {
  const failedStepPath = error.failedStepPath;
  if (typeof failedStepPath !== "string" || failedStepPath.length === 0) {
    // Nothing beyond `message` and the mapped cause code to say — don't echo them back.
    return {};
  }
  const detail = error.message.length > 0 ? error.message : "Workflow run failed.";
  return {
    summary: summarizeWorkflowOutput(
      `Failed at step '${failedStepPath}' (${error.causeCode}): ${detail}`,
      error.runId ?? runId,
    ),
  };
}

function validateHarnessRunContext(
  ctx: HarnessWorkflowRunContext,
  executionMode: HarnessWorkflow["executionMode"],
): HarnessWorkflowExecution | undefined {
  if (ctx.protocolVersion !== 1) {
    return unsupportedProtocol(ctx.reservedRunId, `Unsupported Harness workflow protocol: ${String(ctx.protocolVersion)}`);
  }
  if (ctx.disposition !== "await" && ctx.disposition !== "start") {
    return unsupportedProtocol(ctx.reservedRunId, `Unsupported Harness workflow disposition: ${String(ctx.disposition)}`);
  }
  if (executionMode === "inline" && ctx.disposition === "start") {
    return unsupportedProtocol(ctx.reservedRunId, "Inline workflows cannot run as detached starts.");
  }
  if (typeof ctx.persistence?.dataDir !== "string" || ctx.persistence.dataDir.length === 0) {
    return unsupportedProtocol(ctx.reservedRunId, "Harness workflow context is missing persistence.dataDir.");
  }
  if (typeof ctx.observation?.recordProgress !== "function") {
    return unsupportedProtocol(ctx.reservedRunId, "Harness workflow context is missing observation.recordProgress.");
  }
  return undefined;
}

function unsupportedProtocol(runId: string, message: string): HarnessWorkflowExecution {
  return {
    protocolVersion: 1,
    status: "failed",
    runId,
    causeCode: "unsupported_protocol",
    message,
  };
}

function withHarnessProgress(
  previous: ErgonomicRunWorkflowOptions["progress"],
  ctx: HarnessWorkflowRunContext,
): (event: WorkflowRunProgressEvent) => Promise<void> {
  return async (event) => {
    await previous?.(event);
    await ctx.observation.recordProgress(event);
  };
}

function workflowRunDefaults(options: HarnessWorkflowAdapterOptions): ErgonomicRunWorkflowOptions {
  const runDefaults = { ...(options as unknown as Record<string, unknown>) };
  delete runDefaults.allowUntypedInput;
  delete runDefaults.allowLossyStandardSchema;
  delete runDefaults.executionMode;
  delete runDefaults.definitionIdentity;
  return runDefaults as ErgonomicRunWorkflowOptions;
}

function isStandardSchema(schema: unknown): boolean {
  return typeof schema === "object" && schema !== null && "~standard" in schema;
}

function isExecutableSchemaLike(schema: unknown): boolean {
  if (typeof schema !== "object" || schema === null) return false;
  return ["parse", "safeParse", "transform", "refine", "pipe", "execute", "run"].some((key) =>
    typeof (schema as Record<string, unknown>)[key] === "function"
  );
}

function extractStandardSchemaJsonSchema(schema: unknown): unknown | undefined {
  if (typeof schema !== "object" || schema === null) return undefined;
  const candidate = schema as Record<string, unknown>;
  if (isJsonSchema(candidate.jsonSchema)) return candidate.jsonSchema;
  const standard = candidate["~standard"];
  if (typeof standard === "object" && standard !== null) {
    const standardRecord = standard as Record<string, unknown>;
    if (isJsonSchema(standardRecord.jsonSchema)) return standardRecord.jsonSchema;
  }
  return undefined;
}

function isJsonSchema(value: unknown): boolean {
  return value === true || (typeof value === "object" && value !== null);
}
