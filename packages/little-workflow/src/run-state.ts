import type {
  ArtifactRef,
  EventEnvelope,
  MaterializedRunState,
  MaterializedStepAttempt,
  MaterializedStepState,
  RunId,
} from "./world.js";
import { normalizeHarnessEventType } from "./harness/event-names.js";
import { type UsageTotals, addPricedCall, emptyUsageTotals, priceModelCall } from "./pricing.js";

type JsonRecord = Record<string, unknown>;

type MutableRunState = {
  runId: RunId;
  workflowVersionId?: string;
  status: MaterializedRunState["status"];
  startedAt?: string;
  finishedAt?: string;
  output?: unknown;
  outputRef?: ArtifactRef;
  usage: UsageTotals;
  steps: Record<string, MutableStepState>;
  artifacts: ArtifactRef[];
  error?: unknown;
  eventCount: number;
};

type MutableStepState = {
  stepPath: string;
  status: MaterializedStepState["status"];
  usage: UsageTotals;
  attempts: MutableStepAttempt[];
  output?: unknown;
  outputRef?: ArtifactRef;
  artifactRefs: ArtifactRef[];
  metadata?: JsonRecord;
  error?: unknown;
};

type MutableStepAttempt = {
  attemptId: string;
  startedAt: string;
  finishedAt?: string;
  status: MaterializedStepAttempt["status"];
  error?: unknown;
};

export class RunStateEventMismatchError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = "RunStateEventMismatchError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function materializeRunStateFromEvents(
  runId: RunId,
  events: readonly EventEnvelope[],
): MaterializedRunState {
  validateEventLogShape(runId, events);

  const state: MutableRunState = {
    runId,
    status: "pending",
    usage: emptyUsageTotals(),
    steps: Object.create(null) as Record<string, MutableStepState>,
    artifacts: [],
    eventCount: events.length,
  };

  for (const event of events) {
    applyEvent(state, event);
  }

  return deepFreeze(state);
}

export function stepPathsInEventOrder(events: readonly EventEnvelope[]): readonly string[] {
  const stepPaths: string[] = [];
  for (const event of events) {
    const stepPath = stringValue(event.payload.stepPath);
    if (stepPath !== undefined) {
      pushUnique(stepPaths, stepPath);
    }
  }
  return deepFreeze(stepPaths);
}

function validateEventLogShape(runId: RunId, events: readonly EventEnvelope[]): void {
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index] as EventEnvelope | undefined;
    if (event === undefined) {
      continue;
    }
    if (event.runId !== runId) {
      throw new RunStateEventMismatchError(
        `Event runId mismatch at index ${index}: expected ${runId}, received ${event.runId}.`,
      );
    }
    const expectedSequence = index + 1;
    if (event.sequence !== expectedSequence) {
      throw new RunStateEventMismatchError(
        `Event sequence mismatch for ${runId}: expected ${expectedSequence}, received ${event.sequence}.`,
      );
    }
  }
}

function applyEvent(state: MutableRunState, event: EventEnvelope): void {
  const payload = event.payload;
  const eventType = normalizeHarnessEventType(event.type);
  switch (eventType) {
    case "WorkflowVersionRegistered":
    case "RunStarted": {
      if (typeof payload.workflowVersionId === "string") {
        state.workflowVersionId = payload.workflowVersionId;
      }
      if (eventType === "RunStarted") {
        state.status = "running";
        state.startedAt = event.recordedAt;
      }
      break;
    }
    case "StepScheduled": {
      const stepPath = stringValue(payload.stepPath);
      if (stepPath !== undefined) {
        ensureStep(state, stepPath);
      }
      break;
    }
    case "StepAttemptStarted": {
      const stepPath = stringValue(payload.stepPath);
      if (stepPath !== undefined) {
        const step = ensureStep(state, stepPath);
        step.status = "running";
        delete step.error;
        delete step.output;
        delete step.outputRef;
        step.attempts.push({
          attemptId: stringValue(payload.attemptId) ?? `attempt_${step.attempts.length + 1}`,
          startedAt: event.recordedAt,
          status: "running",
        });
      }
      break;
    }
    case "ModelCallCompleted": {
      recordModelCall(state, event, payload.usage, payload.model);
      break;
    }
    case "harness.model.responded": {
      const response = isRecord(payload.response) ? payload.response : undefined;
      recordModelCall(state, event, response?.usage, payload.model);
      break;
    }
    case "harness.session.completed": {
      // Intentionally does not accumulate `payload.usage`. That field is a per-session
      // token rollup the harness computes by summing the very `harness.model.responded`
      // events already recorded above — adding it here would double-count every model
      // call in the session. Atomic model-call events are the single source of truth.
      break;
    }
    case "ArtifactCreated": {
      const artifactRef = artifactRefValue(payload.artifactRef);
      if (artifactRef !== undefined) {
        pushUnique(state.artifacts, artifactRef);
        const stepPath = stringValue(payload.stepPath);
        if (stepPath !== undefined) {
          pushUnique(ensureStep(state, stepPath).artifactRefs, artifactRef);
        }
      }
      break;
    }
    case "StepCompleted": {
      const stepPath = stringValue(payload.stepPath);
      if (stepPath !== undefined) {
        const step = ensureStep(state, stepPath);
        step.status = "completed";
        delete step.error;
        completeLastAttempt(step, event.recordedAt);
        if ("output" in payload) {
          step.output = payload.output;
        }
        const outputRef = artifactRefValue(payload.outputRef);
        if (outputRef !== undefined) {
          step.outputRef = outputRef;
          pushUnique(step.artifactRefs, outputRef);
          pushUnique(state.artifacts, outputRef);
        }
        for (const ref of artifactRefsValue(payload.artifactRefs)) {
          pushUnique(step.artifactRefs, ref);
          pushUnique(state.artifacts, ref);
        }
        if (isRecord(payload.metadata)) {
          step.metadata = payload.metadata;
        }
      }
      break;
    }
    case "StepFailed": {
      const stepPath = stringValue(payload.stepPath);
      if (stepPath !== undefined) {
        const step = ensureStep(state, stepPath);
        step.status = "failed";
        step.error = payload.error;
        failLastAttempt(step, event.recordedAt, payload.error);
      }
      break;
    }
    case "RunCompleted": {
      state.status = "completed";
      state.finishedAt = event.recordedAt;
      delete state.error;
      if ("output" in payload) {
        state.output = payload.output;
      }
      const outputRef = artifactRefValue(payload.outputRef);
      if (outputRef !== undefined) {
        state.outputRef = outputRef;
        pushUnique(state.artifacts, outputRef);
      }
      break;
    }
    case "RunFailed": {
      state.status = "failed";
      state.finishedAt = event.recordedAt;
      state.error = payload.error;
      break;
    }
    default:
      break;
  }
}

function ensureStep(state: MutableRunState, stepPath: string): MutableStepState {
  if (!Object.hasOwn(state.steps, stepPath)) {
    state.steps[stepPath] = {
      stepPath,
      status: "pending",
      usage: emptyUsageTotals(),
      attempts: [],
      artifactRefs: [],
    };
  }
  return state.steps[stepPath] as MutableStepState;
}

/**
 * Prices one recorded model call and folds it into the run total and, when the event
 * carries a `stepPath`, that step's total.
 *
 * This is the **only** place a run's dollar figure comes from. Events carry tokens and
 * model identity; the registry supplies the rates. No event's own `costUsd` is ever read
 * (the event recorder rejects the field outright), so a run total cannot be
 * double-counted from a pre-computed figure.
 */
function recordModelCall(
  state: MutableRunState,
  event: EventEnvelope,
  usageValue: unknown,
  modelValue: unknown,
): void {
  if (!isRecord(usageValue)) {
    return;
  }
  const model = isRecord(modelValue) ? modelValue : undefined;
  const call = priceModelCall(
    { provider: stringValue(model?.provider), modelId: stringValue(model?.modelId) },
    {
      inputTokens: numberValue(usageValue.inputTokens),
      outputTokens: numberValue(usageValue.outputTokens),
      // Harness traces store the AI SDK usage verbatim: v6 recorded the flat fields, v7 only the details.
      cachedInputTokens: numberValue(usageValue.cachedInputTokens ?? usageDetail(usageValue.inputTokenDetails, "cacheReadTokens")),
      reasoningTokens: numberValue(usageValue.reasoningTokens ?? usageDetail(usageValue.outputTokenDetails, "reasoningTokens")),
    },
  );

  state.usage = addPricedCall(state.usage, call);

  const stepPath = stringValue(event.payload.stepPath);
  if (stepPath !== undefined) {
    const step = ensureStep(state, stepPath);
    step.usage = addPricedCall(step.usage, call);
  }
}

function completeLastAttempt(step: MutableStepState, finishedAt: string): void {
  const attempt = step.attempts.at(-1);
  if (attempt === undefined) {
    step.attempts.push({
      attemptId: "attempt_1",
      startedAt: finishedAt,
      finishedAt,
      status: "completed",
    });
    return;
  }
  attempt.status = "completed";
  attempt.finishedAt = finishedAt;
}

function failLastAttempt(
  step: MutableStepState,
  finishedAt: string,
  error: unknown,
): void {
  const attempt = step.attempts.at(-1);
  if (attempt === undefined) {
    step.attempts.push({
      attemptId: "attempt_1",
      startedAt: finishedAt,
      finishedAt,
      status: "failed",
      error,
    });
    return;
  }
  attempt.status = "failed";
  attempt.finishedAt = finishedAt;
  attempt.error = error;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function artifactRefValue(value: unknown): ArtifactRef | undefined {
  return typeof value === "string" && value.startsWith("artifact://")
    ? value as ArtifactRef
    : undefined;
}

function artifactRefsValue(value: unknown): readonly ArtifactRef[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    const ref = artifactRefValue(item);
    return ref === undefined ? [] : [ref];
  });
}

function pushUnique<T>(items: T[], value: T): void {
  if (!items.includes(value)) {
    items.push(value);
  }
}

function deepFreeze<T>(value: T): T {
  if (ArrayBuffer.isView(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      deepFreeze(item);
    }
    return Object.freeze(value) as T;
  }
  if (isRecord(value)) {
    for (const item of Object.values(value)) {
      deepFreeze(item);
    }
    return Object.freeze(value);
  }
  return value;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function usageDetail(details: unknown, key: string): unknown {
  return isRecord(details) ? details[key] : undefined;
}
