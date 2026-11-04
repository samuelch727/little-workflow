import type { Environment, SpanInput, TraceInput, Trigger, WorkflowOrigin } from "../contract.js";
import type { Exporter, LittleDBErrorHandler } from "../exporter.js";
import { turnTraceId, type TurnTraceIds } from "../harness/tracer.js";
import type { Resolution } from "../resolve.js";
import {
  boundedId,
  clipText,
  contentText,
  environmentFor,
  errorInfo,
  isRecord,
  messageContent,
  nowIso,
  providerName,
  stringValue,
  toLittleDBUsage,
  toTrigger,
} from "../util.js";

/** An event as a World returns it from `appendEvent` (`EventEnvelope` in `@little-stack/workflow`). */
export type WorldEventLike = {
  readonly runId: string;
  readonly type: string;
  readonly recordedAt: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly sequence?: number;
  readonly occurrenceId?: string;
};

/**
 * The part of a Little Workflow `World` the tracing wrapper needs. Every other member is passed
 * through untouched, so the wrapper is a `World` wherever the inner one is.
 */
export type WorldLike = {
  appendEvent(runId: string, event: { readonly type: string; readonly payload: Readonly<Record<string, unknown>> }): Promise<WorldEventLike>;
};

export type TracingWorldOptions = {
  /** The workflow's slug in LittleDB, the same one you resolve. */
  readonly workflow: string;
  /** Who wrote it: `code` (default), `agent` (`define_workflow`) or `planner` (a one-shot plan). */
  readonly origin?: WorkflowOrigin | undefined;
  /** What `resolve` returned for this run: its version id, and `trial` and `holdout` traffic is tagged as such. */
  readonly resolution?: Pick<Resolution, "versionId" | "mode"> | undefined;
  /** The LittleDB version this run uses, when you have it without a resolution. */
  readonly versionId?: string | null | undefined;
  /** The harness an agent-made workflow belongs to. */
  readonly harness?: string | undefined;
  /**
   * The session the run belongs to. A run a harness tool call started takes the harness session
   * from its trigger, and a child run its parent's, so set this only to override them.
   */
  readonly sessionId?: string | undefined;
  readonly userId?: string | undefined;
  /**
   * Default `production`: `trial` or `holdout` from the resolution, and `experiment` for a run
   * inside an eval worker run.
   */
  readonly environment?: Environment | undefined;
  /** Set by an eval worker run. */
  readonly experimentId?: string | undefined;
  readonly datasetItemId?: string | undefined;
  /**
   * The trace id: a fixed one (an eval worker's run), or one per run. Default `lw_<runId>`.
   * With a fixed id, runs after the first become child spans of the first run's root.
   */
  readonly traceId?: string | ((runId: string) => string) | undefined;
  /** The trace and root span name. Default the workflow slug. */
  readonly name?: string | undefined;
  readonly tags?: readonly string[] | undefined;
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
  /** Send step outputs, run input and output, prompts and tool arguments. Default `true`. */
  readonly captureContent?: boolean | undefined;
};

type OpenSpan = {
  readonly id: string;
  readonly parentId: string;
  readonly name: string;
  readonly type: "step" | "llm" | "tool";
  readonly startTime: string;
  readonly input?: unknown;
  readonly model?: string;
  readonly attributes: Record<string, unknown>;
};

type RunTrace = {
  readonly runId: string;
  readonly traceId: string;
  readonly rootId: string;
  readonly rootParentId: string | null;
  readonly startTime: string;
  /** A later run in a fixed trace: a span under the first run's root, with no trace row of its own. */
  readonly nested: boolean;
  /** Decided when the run began: an eval worker run tags the runs inside it `experiment`. */
  readonly environment: Environment;
  sessionId?: string;
  input?: unknown;
  readonly attributes: Record<string, unknown>;
  /**
   * Open spans by key: `step:<path>`, `llm:<callId>`, `tool:<callId>`, `rt:<path>:<tool>`. Their
   * span ids carry the run id, since runs can share a trace (`traceId`); within a run they stay
   * the same, so a replayed event updates its span.
   */
  readonly open: Map<string, OpenSpan>;
  /** The latest attempt span of each step path, to parent model and tool calls under. */
  readonly stepSpan: Map<string, string>;
};

const MAX_OPEN_RUNS = 1_000;

/** The default trace id of a workflow run. */
export function runTraceId(runId: string): string {
  return boundedId(`lw_${runId}`);
}

/**
 * Wrap a World so every run it stores is also sent to LittleDB as a trace: the run is the root
 * span, each step attempt a child, and model and tool calls sit under the step that made them.
 * The inner World stays the source of truth; tracing never fails or slows an append.
 */
export function createTracingWorld<W extends WorldLike>(
  inner: W,
  options: TracingWorldOptions,
  deps: { readonly exporter: Exporter; readonly onError: LittleDBErrorHandler; readonly turnTraceIds?: TurnTraceIds },
): W {
  const capture = options.captureContent !== false;
  const versionId = options.versionId ?? options.resolution?.versionId ?? undefined;
  const name = clipText(options.name ?? options.workflow, 500);
  const runs = new Map<string, RunTrace>();
  let fixedRootTaken = false;

  const send = (traces: TraceInput[], spans: SpanInput[]) => deps.exporter.enqueue({ traces, spans });

  function traceIdFor(runId: string): string {
    if (typeof options.traceId === "string") return options.traceId;
    if (typeof options.traceId === "function") return options.traceId(runId);
    return runTraceId(runId);
  }

  function rootSpan(run: RunTrace, status: "running" | "ok" | "error", endTime?: string, output?: unknown, error?: { message: string; type?: string }): SpanInput {
    return {
      traceId: run.traceId,
      id: run.rootId,
      ...(run.rootParentId === null ? {} : { parentId: run.rootParentId }),
      name,
      type: "workflow",
      status,
      startTime: run.startTime,
      ...(endTime === undefined ? {} : { endTime }),
      ...(capture && run.input !== undefined ? { input: run.input } : {}),
      ...(capture && output !== undefined ? { output } : {}),
      attributes: { runId: run.runId, ...run.attributes },
      ...(error === undefined ? {} : { error }),
    };
  }

  function begin(runId: string, at: string): RunTrace {
    const existing = runs.get(runId);
    if (existing !== undefined) return existing;
    const traceId = traceIdFor(runId);
    const nested = typeof options.traceId === "string" && fixedRootTaken;
    if (typeof options.traceId === "string") fixedRootTaken = true;
    const run: RunTrace = {
      runId,
      traceId,
      rootId: nested ? boundedId("run", runId) : "root",
      rootParentId: nested ? "root" : null,
      startTime: at,
      nested,
      environment: environmentFor(options.environment, options.resolution?.mode),
      ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
      attributes: {},
      open: new Map(),
      stepSpan: new Map(),
    };
    runs.set(runId, run);
    if (runs.size > MAX_OPEN_RUNS) {
      const oldest = runs.keys().next().value;
      if (oldest !== undefined) runs.delete(oldest);
    }
    // A nested run must not overwrite the first run's trace row.
    send(nested ? [] : [traceRow(run)], [rootSpan(run, "running")]);
    return run;
  }

  function traceRow(run: RunTrace, links: Pick<TraceInput, "trigger" | "parentTraceId" | "parentSpanId"> = {}): TraceInput {
    return {
      id: run.traceId,
      name,
      kind: options.experimentId === undefined ? "workflow" : "experiment",
      workflow: options.workflow,
      workflowOrigin: options.origin ?? "code",
      ...(options.harness === undefined ? {} : { harness: options.harness }),
      ...(versionId === undefined || versionId === null ? {} : { versionId }),
      ...(run.sessionId === undefined ? {} : { sessionId: run.sessionId }),
      ...(options.userId === undefined ? {} : { userId: options.userId }),
      environment: run.environment,
      ...(options.experimentId === undefined ? {} : { experimentId: options.experimentId }),
      ...(options.datasetItemId === undefined ? {} : { datasetItemId: options.datasetItemId }),
      startTime: run.startTime,
      metadata: { ...(options.metadata ?? {}), runId: run.runId },
      ...(options.tags === undefined ? {} : { tags: [...options.tags] }),
      ...links,
    };
  }

  /**
   * What started the run, from its RunStarted: a harness tool call (the trace then points at that
   * turn's trace and tool span, and joins the harness session), a parent run (its trace and
   * session), or anything else, passed through.
   */
  function startedBy(run: RunTrace, payload: Readonly<Record<string, unknown>>): Pick<TraceInput, "trigger" | "parentTraceId" | "parentSpanId"> {
    const parentRunId = stringValue(payload.parentRunId);
    if (parentRunId !== undefined) {
      const parentTraceId = traceIdFor(parentRunId);
      const parentSession = runs.get(parentRunId)?.sessionId;
      if (run.sessionId === undefined && parentSession !== undefined) run.sessionId = parentSession;
      const trigger = toTrigger({ kind: "workflow", runId: parentRunId });
      return {
        ...(trigger === undefined ? {} : { trigger }),
        ...(parentTraceId === run.traceId ? {} : { parentTraceId }),
      };
    }
    const raw = isRecord(payload.trigger) ? payload.trigger : undefined;
    const trigger = raw === undefined ? undefined : toTrigger(raw);
    if (raw === undefined || trigger === undefined) return {};
    if (trigger.kind !== "harness") return { trigger };
    const sessionId = stringValue(raw.sessionId);
    const turnId = stringValue(raw.turnId);
    const toolCallId = stringValue(raw.toolCallId);
    if (run.sessionId === undefined && sessionId !== undefined) run.sessionId = sessionId;
    if (sessionId === undefined || turnId === undefined) return { trigger };
    const parentTraceId = deps.turnTraceIds?.get(sessionId, turnId) ?? turnTraceId(sessionId, turnId);
    return {
      trigger,
      ...(parentTraceId === run.traceId ? {} : { parentTraceId }),
      // The harness tracer's id for the tool call's span.
      ...(toolCallId === undefined || parentTraceId === run.traceId ? {} : { parentSpanId: boundedId("tool", turnId, toolCallId) }),
    };
  }

  function parentFor(run: RunTrace, stepPath: string | undefined): string {
    return (stepPath === undefined ? undefined : run.stepSpan.get(stepPath)) ?? run.rootId;
  }

  function close(run: RunTrace, key: string, at: string, status: "ok" | "error", extra: Partial<SpanInput> = {}): void {
    const open = run.open.get(key);
    if (open === undefined) return;
    run.open.delete(key);
    send([], [
      {
        traceId: run.traceId,
        id: open.id,
        parentId: open.parentId,
        name: open.name,
        type: open.type,
        status,
        startTime: open.startTime,
        endTime: at,
        ...(open.model === undefined ? {} : { model: open.model }),
        ...(open.input === undefined ? {} : { input: open.input }),
        ...extra,
        attributes: { ...open.attributes, ...(extra.attributes ?? {}) },
      },
    ]);
  }

  function openSpan(run: RunTrace, key: string, span: OpenSpan, announce: boolean): void {
    run.open.set(key, span);
    if (!announce) return;
    send([], [
      {
        traceId: run.traceId,
        id: span.id,
        parentId: span.parentId,
        name: span.name,
        type: span.type,
        status: "running",
        startTime: span.startTime,
        ...(span.input === undefined ? {} : { input: span.input }),
        attributes: span.attributes,
      },
    ]);
  }

  function finish(run: RunTrace, at: string, status: "ok" | "error", output: unknown, error?: { message: string; type?: string }) {
    for (const key of [...run.open.keys()]) {
      close(run, key, at, "error", { error: { message: "Unfinished when the run ended." } });
    }
    send([], [rootSpan(run, status, at, output, error)]);
    runs.delete(run.runId);
  }

  function observe(runId: string, event: WorldEventLike): void {
    const at = typeof event.recordedAt === "string" ? event.recordedAt : nowIso();
    const payload = isRecord(event.payload) ? event.payload : {};
    const run = begin(runId, at);
    const stepPath = stringValue(payload.stepPath);
    const attempt = typeof payload.attempt === "number" ? payload.attempt : undefined;
    switch (event.type) {
      case "RunStarted": {
        if (payload.input !== undefined) run.input = payload.input;
        for (const field of ["workflowVersionId", "parentRunId", "label"] as const) {
          const value = stringValue(payload[field]);
          if (value !== undefined) run.attributes[field] = value;
        }
        // The trace row went out with the run's first event; send it again with how it started.
        const links = run.nested ? {} : startedBy(run, payload);
        send(Object.keys(links).length === 0 ? [] : [traceRow(run, links)], [rootSpan(run, "running")]);
        return;
      }
      case "StepAttemptStarted": {
        if (stepPath === undefined) return;
        const id = boundedId("step", run.runId, stepPath, String(attempt ?? 1));
        run.stepSpan.set(stepPath, id);
        openSpan(run, `step:${stepPath}`, {
          id,
          parentId: run.rootId,
          name: clipText(stringValue(payload.stepId) ?? stepPath, 500),
          type: "step",
          startTime: at,
          attributes: { stepPath, attempt: attempt ?? 1 },
        }, true);
        return;
      }
      case "StepCompleted": {
        if (stepPath === undefined) return;
        const metadata = isRecord(payload.metadata) ? payload.metadata : {};
        close(run, `step:${stepPath}`, at, "ok", {
          ...(capture ? { output: payload.output !== undefined ? payload.output : payload.outputRef } : {}),
          attributes: {
            ...(typeof metadata.uses === "string" ? { uses: metadata.uses } : {}),
            ...(typeof payload.outputRef === "string" ? { outputRef: payload.outputRef } : {}),
          },
        });
        return;
      }
      case "StepFailed": {
        if (stepPath === undefined) return;
        const error = isRecord(payload.error) ? payload.error : {};
        close(run, `step:${stepPath}`, at, "error", {
          error: errorInfo(payload.error),
          attributes: typeof error.retriable === "boolean" ? { retriable: error.retriable } : {},
        });
        return;
      }
      case "ToolCallStarted": {
        const tool = stringValue(payload.tool) ?? "tool";
        openSpan(run, `rt:${stepPath ?? ""}:${tool}`, {
          id: boundedId("tool", run.runId, stepPath ?? "", String(attempt ?? 1), tool, String(event.sequence ?? at)),
          parentId: parentFor(run, stepPath),
          name: clipText(tool, 500),
          type: "tool",
          startTime: at,
          attributes: { ...(stepPath === undefined ? {} : { stepPath }) },
        }, false);
        return;
      }
      case "ToolCallCompleted": {
        close(run, `rt:${stepPath ?? ""}:${stringValue(payload.tool) ?? "tool"}`, at, "ok");
        return;
      }
      case "harness.model.called": {
        const request = isRecord(payload.request) ? payload.request : {};
        const scope = isRecord(request.scope) ? request.scope : isRecord(payload.scope) ? payload.scope : {};
        const path = stringValue(scope.stepPath) ?? stepPath;
        const callId = stringValue(payload.callId) ?? event.occurrenceId ?? `${path ?? "run"}:${String(event.sequence ?? at)}`;
        const model = stringValue(request.model);
        const messages = Array.isArray(request.messages) ? request.messages : [];
        // An `ai.generate` step's call records the step as it ran: its prompt, with expressions
        // filled in, goes into the user message ahead of the step input, which is all `messages`
        // holds. Without it a reviewer cannot see what the step was told.
        const step = isRecord(request.step) && isRecord(request.step.with) ? request.step.with : {};
        const prompt = step.prompt === undefined ? undefined : contentText(step.prompt);
        const modelSlot = stringValue(step.model);
        openSpan(run, `llm:${callId}`, {
          id: boundedId("llm", run.runId, callId),
          parentId: parentFor(run, path),
          name: clipText(model ?? "model", 500),
          type: "llm",
          startTime: at,
          ...(model === undefined ? {} : { model }),
          ...(capture
            ? {
                input: {
                  ...(request.system === undefined ? {} : { system: contentText(request.system) }),
                  ...(prompt === undefined ? {} : { prompt }),
                  messages: messages.map((m) => (isRecord(m) ? { role: m.role, content: messageContent(m.content) } : m)),
                },
              }
            : {}),
          attributes: {
            ...(path === undefined ? {} : { stepPath: path }),
            ...(typeof scope.role === "string" ? { role: scope.role } : {}),
            ...(modelSlot === undefined ? {} : { modelSlot }),
          },
        }, false);
        return;
      }
      case "harness.model.responded":
      case "harness.model.failed": {
        const callId = stringValue(payload.callId) ?? event.occurrenceId;
        if (callId === undefined || !run.open.has(`llm:${callId}`)) return;
        if (event.type === "harness.model.failed") {
          close(run, `llm:${callId}`, at, "error", { error: errorInfo(payload.error) });
          return;
        }
        const response = isRecord(payload.response) ? payload.response : {};
        const model = isRecord(payload.model) ? payload.model : {};
        const modelId = stringValue(model.modelId);
        const provider = providerName(model.provider);
        const usage = toLittleDBUsage(response.usage);
        close(run, `llm:${callId}`, at, "ok", {
          ...(modelId === undefined ? {} : { model: modelId }),
          ...(provider === undefined ? {} : { provider }),
          ...(capture
            ? {
                output: {
                  text: typeof response.text === "string" ? response.text : "",
                  ...(response.output === undefined ? {} : { output: response.output }),
                  ...(Array.isArray(response.toolCalls) && response.toolCalls.length > 0 ? { toolCalls: response.toolCalls } : {}),
                },
              }
            : {}),
          ...(usage === undefined ? {} : { usage }),
        });
        return;
      }
      case "harness.tool_call.started": {
        const callId = stringValue(payload.callId) ?? `${String(event.sequence ?? at)}`;
        const scope = isRecord(payload.scope) ? payload.scope : {};
        const path = stringValue(scope.stepPath) ?? stepPath;
        const toolName = stringValue(payload.toolName) ?? "tool";
        openSpan(run, `tool:${callId}`, {
          id: boundedId("tool", run.runId, callId),
          parentId: parentFor(run, path),
          name: clipText(toolName, 500),
          type: "tool",
          startTime: at,
          ...(capture && payload.args !== undefined ? { input: payload.args } : {}),
          attributes: {
            toolCallId: callId,
            ...(path === undefined ? {} : { stepPath: path }),
            ...(typeof payload.caller === "string" ? { caller: payload.caller } : {}),
          },
        }, false);
        return;
      }
      case "harness.tool_call.succeeded":
      case "harness.tool_call.failed": {
        const callId = stringValue(payload.callId);
        if (callId === undefined) return;
        const failed = event.type === "harness.tool_call.failed";
        close(run, `tool:${callId}`, at, failed ? "error" : "ok", {
          ...(capture && !failed && payload.result !== undefined ? { output: payload.result } : {}),
          ...(failed ? { error: errorInfo(payload.error) } : {}),
          attributes: typeof payload.durationMs === "number" ? { durationMs: payload.durationMs } : {},
        });
        return;
      }
      case "RunCompleted": {
        finish(run, at, "ok", payload.output !== undefined ? payload.output : payload.outputRef);
        return;
      }
      case "RunFailed": {
        finish(run, at, "error", undefined, errorInfo(payload.error));
        return;
      }
      default:
        return;
    }
  }

  const appendEvent: WorldLike["appendEvent"] = async (runId, event) => {
    const envelope = await inner.appendEvent(runId, event);
    try {
      observe(runId, envelope ?? { runId, type: event.type, recordedAt: nowIso(), payload: event.payload });
    } catch (error) {
      deps.onError(error, { operation: "trace" });
    }
    return envelope;
  };

  return new Proxy(inner, {
    get(target, property) {
      if (property === "appendEvent") return appendEvent;
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}
