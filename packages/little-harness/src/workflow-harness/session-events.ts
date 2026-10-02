import { emitHarnessOccurrence } from "../events/occurrence.js";
import type {
  WorkflowHarness,
  WorkflowHarnessContext,
  WorkflowHarnessDurabilitySink,
  WorkflowHarnessResult,
  WorkflowHarnessTask,
  WorkflowHarnessTraceSink,
} from "./types.js";

export async function runWorkflowHarnessWithSession(
  harness: WorkflowHarness,
  task: WorkflowHarnessTask,
  ctx: WorkflowHarnessContext,
): Promise<WorkflowHarnessResult> {
  const usage = createUsageAccumulator();
  const sessionCtx: WorkflowHarnessContext = {
    ...ctx,
    durability: {
      ...ctx.durability,
      append: async (event) => {
        usage.add(event);
        return ctx.durability.append(event);
      },
    },
  };

  await emitHarnessOccurrence({
    type: "harness.session.started",
    runId: sessionCtx.session.runId,
    payload: {
      runId: sessionCtx.session.runId,
      role: sessionCtx.session.role,
      task: { kind: task.kind },
      ...(sessionCtx.session.parentRunId === undefined ? {} : { parentRunId: sessionCtx.session.parentRunId }),
      manifest: asRecord(sessionCtx.session.manifest),
      manifestHash: sessionCtx.session.manifestHash,
      ...(sessionCtx.session.warnings === undefined ? {} : { warnings: sessionCtx.session.warnings }),
      ...(sessionCtx.session.skillContents === undefined ? {} : { skillContents: sessionCtx.session.skillContents }),
    },
    metadata: {
      runId: sessionCtx.session.runId,
      role: sessionCtx.session.role,
      task: { kind: task.kind },
      manifestHash: sessionCtx.session.manifestHash,
      harnessId: harness.harnessId,
    },
    ...occurrenceSinks(sessionCtx),
  });

  try {
    const result = await harness.run(task, sessionCtx);
    throwIfAborted(sessionCtx.abortSignal);
    await emitHarnessOccurrence({
      type: "harness.session.completed",
      runId: sessionCtx.session.runId,
      payload: {
        runId: sessionCtx.session.runId,
        output: asRecord({ result: eventSafeValue(result) }),
        usage: usage.value(),
      },
      metadata: {
        runId: sessionCtx.session.runId,
        harnessId: harness.harnessId,
      },
      ...occurrenceSinks(sessionCtx),
    });
    return result;
  } catch (error) {
    await emitHarnessOccurrence({
      type: "harness.session.failed",
      runId: sessionCtx.session.runId,
      payload: {
        runId: sessionCtx.session.runId,
        error: errorEnvelope(error),
      },
      metadata: {
        runId: sessionCtx.session.runId,
        harnessId: harness.harnessId,
        error: errorEnvelope(error),
      },
      ...occurrenceSinks(sessionCtx),
    });
    throw error;
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) {
    return;
  }
  const reason = signal.reason;
  if (reason instanceof Error) {
    throw reason;
  }
  throw new Error(typeof reason === "string" && reason.length > 0 ? reason : "Workflow harness session aborted.");
}

function occurrenceSinks(
  ctx: WorkflowHarnessContext,
): { durability: WorkflowHarnessDurabilitySink; trace?: WorkflowHarnessTraceSink } {
  return {
    durability: ctx.durability,
    ...(ctx.trace === undefined ? {} : { trace: ctx.trace }),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : { value };
}

function eventSafeValue(value: unknown): unknown {
  if (value === undefined) {
    return null;
  }
  if (Array.isArray(value)) {
    return value.map((item) => eventSafeValue(item));
  }
  if (!isRecord(value)) {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = eventSafeValue(item);
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Session-scoped token rollup for `harness.session.completed`.
 *
 * Deliberately token-only: this package cannot see the model pricing registry (it lives
 * in `little-workflow`, which depends on this package), so a cost computed here could
 * only ever be a stub. Cost is derived once, downstream, by pricing the atomic
 * `harness.model.responded` events — see `little-workflow/src/pricing.ts`. The value
 * here is a convenience rollup for session consumers and is **not** re-summed by the run
 * materializer, which would double-count it.
 */
function createUsageAccumulator(): {
  readonly add: (event: unknown) => void;
  readonly value: () => {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cachedInputTokens: number;
    readonly reasoningTokens: number;
  };
} {
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let reasoningTokens = 0;
  return {
    add(event) {
      const usage = modelResponseUsage(event);
      if (usage === undefined) {
        return;
      }
      inputTokens += numberValue(usage.inputTokens);
      outputTokens += numberValue(usage.outputTokens);
      // Traces store the AI SDK usage verbatim: v6 recorded the flat fields, v7 only the details.
      cachedInputTokens += numberValue(usage.cachedInputTokens ?? detail(usage.inputTokenDetails, "cacheReadTokens"));
      reasoningTokens += numberValue(usage.reasoningTokens ?? detail(usage.outputTokenDetails, "reasoningTokens"));
    },
    value: () => ({ inputTokens, outputTokens, cachedInputTokens, reasoningTokens }),
  };
}

function modelResponseUsage(event: unknown): Record<string, unknown> | undefined {
  if (!isRecord(event) || event.type !== "harness.model.responded" || !isRecord(event.payload)) {
    return undefined;
  }
  const response = isRecord(event.payload.response) ? event.payload.response : undefined;
  return isRecord(response?.usage) ? response.usage : undefined;
}

function detail(details: unknown, key: string): unknown {
  return isRecord(details) ? details[key] : undefined;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function errorEnvelope(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(error.stack === undefined ? {} : { stack: error.stack }),
    };
  }
  return { name: "NonError", message: String(error) };
}
