import { LittleHarnessError } from "../errors.js";
import type { JsonObject } from "../types.js";
import { stableHash } from "../utils/canonical-hash.js";
import type { HarnessEventType } from "./names.js";

export {
  HARNESS_EVENT_TYPES,
  HARNESS_SIDE_CHANNEL_EVENT_TYPES,
  isHarnessEventType,
  isHarnessSideChannelEventType,
  type HarnessEventType,
  type HarnessSideChannelEventType,
} from "./names.js";

export const HARNESS_SESSION_EVENT_APPEND_SCHEMA_VERSION =
  "lh.session-event.append.v1" as const;
export const HARNESS_SESSION_EVENT_RECORD_SCHEMA_VERSION =
  "lh.session-event.record.v1" as const;

const MAX_HARNESS_EVENT_JSON_DEPTH = 64;
const MAX_HARNESS_EVENT_JSON_NODES = 100_000;

type DurableHarnessEventCommon<TEventType extends string> = {
  readonly type: TEventType;
  readonly runId: string;
  /**
   * Stable identity for this append attempt. It is selected by the logical
   * emitter before transport and is deliberately distinct from occurrenceId.
   */
  readonly appendIdempotencyKey: string;
  /** Optional causal grouping. Several lifecycle events may share one occurrence. */
  readonly occurrenceId?: string;
  /** Exact Little Compute correlation links, when the Harness runs under Compute. */
  readonly operationId?: string;
  readonly taskId?: string;
  readonly attemptId?: string;
  readonly correlationId?: string;
  readonly causationId?: string;
};

export type DurableHarnessEventInput<TEventType extends string = HarnessEventType> =
  DurableHarnessEventCommon<TEventType> &
    (
      | {
          readonly payload: JsonObject;
          readonly payloadArtifactId?: never;
        }
      | {
          readonly payload?: never;
          /** Content-addressed Artifact containing a large JSON payload. */
          readonly payloadArtifactId: string;
        }
    );

export type PersistedDurableHarnessEvent<TEventType extends string = HarnessEventType> =
  DurableHarnessEventInput<TEventType> & {
    readonly eventId: string;
    readonly sequence: number;
    readonly recordedAt: string;
    /** Digest of the normalized append request, not of server-assigned fields. */
    readonly canonicalRequestDigest: string;
  };

export type TraceHarnessEventInput<TEventType extends string = HarnessEventType> = {
  readonly type: TEventType;
  readonly occurrenceId?: string;
  readonly metadata?: JsonObject;
};

export type HarnessPriorEventQuery<TEventType extends string = HarnessEventType> = {
  readonly type?: TEventType;
  readonly occurrenceId?: string;
  readonly runId?: string;
  readonly operationId?: string;
  readonly taskId?: string;
  readonly attemptId?: string;
  /** Exclusive, per-run cursor used by bounded replay implementations. */
  readonly afterSequence?: number;
  readonly limit?: number;
};

/**
 * The session log — the managed-agents "session" port: an append-only durable event log
 * that is the source of truth for a run (append + priorEvents). A stateless harness
 * reconstructs everything else from it.
 */
export type HarnessSessionLog<TEventType extends string = HarnessEventType> = {
  readonly append: (
    event: DurableHarnessEventInput<TEventType>,
  ) =>
    | Promise<PersistedDurableHarnessEvent<TEventType> | void>
    | PersistedDurableHarnessEvent<TEventType>
    | void;
  readonly priorEvents?: (
    query?: HarnessPriorEventQuery<TEventType>,
  ) =>
    | Promise<readonly PersistedDurableHarnessEvent<TEventType>[]>
    | readonly PersistedDurableHarnessEvent<TEventType>[];
};

export type HarnessTraceSink<TEventType extends string = HarnessEventType> = {
  readonly append: (event: TraceHarnessEventInput<TEventType>) => Promise<void> | void;
};

export type HarnessEventOccurrence<TEventType extends string = HarnessEventType> = {
  readonly type: TEventType;
  readonly runId: string;
  /** Mandatory even for trace-only projection, so adding durability cannot invent identity. */
  readonly appendIdempotencyKey: string;
  readonly occurrenceId?: string;
  readonly operationId?: string;
  readonly taskId?: string;
  readonly attemptId?: string;
  readonly correlationId?: string;
  readonly causationId?: string;
  readonly payload?: JsonObject;
  readonly payloadArtifactId?: string;
  readonly metadata?: JsonObject;
  readonly durability?: HarnessSessionLog<TEventType>;
  readonly trace?: HarnessTraceSink<TEventType>;
  readonly onTraceError?: (
    error: unknown,
    event: TraceHarnessEventInput<TEventType>,
  ) => Promise<void> | void;
};

export type HarnessAppendIdempotencyKeyInput = {
  readonly runId: string;
  readonly eventType: string;
  /** A stable call, step, turn, or session identity selected by the emitter. */
  readonly logicalEventId: string;
  /** Optional lifecycle phase when logicalEventId spans multiple event types. */
  readonly phase?: string;
};

/**
 * Derives a compact, opaque append key from a stable logical event identity.
 * Callers must invoke this before entering a transport retry loop.
 */
export function createHarnessAppendIdempotencyKey(
  input: HarnessAppendIdempotencyKeyInput,
): string {
  assertBoundedString(input.runId, "runId", 512);
  assertBoundedString(input.eventType, "eventType", 160);
  assertBoundedString(input.logicalEventId, "logicalEventId", 2_048);
  if (input.phase !== undefined) {
    assertBoundedString(input.phase, "phase", 160);
  }
  return `lhai_${stableHash(
    {
      domain: "little-harness.append-idempotency-key.v1",
      runId: input.runId,
      eventType: input.eventType,
      logicalEventId: input.logicalEventId,
      ...(input.phase === undefined ? {} : { phase: input.phase }),
    },
    { format: "hex" },
  )}`;
}

/** Normalize, clone, and strictly validate an append request. */
export function normalizeDurableHarnessEventInput<TEventType extends string = HarnessEventType>(
  input: DurableHarnessEventInput<TEventType> | unknown,
): DurableHarnessEventInput<TEventType> {
  if (!isPlainObject(input)) {
    throw new HarnessSessionEventValidationError("event must be a plain object");
  }
  const allowed = new Set([
    "type",
    "runId",
    "appendIdempotencyKey",
    "occurrenceId",
    "operationId",
    "taskId",
    "attemptId",
    "correlationId",
    "causationId",
    "payload",
    "payloadArtifactId",
  ]);
  assertOnlyKeys(input, allowed, "event");
  const type = ownDataValue(input, "type");
  const runId = ownDataValue(input, "runId");
  const appendIdempotencyKey = ownDataValue(input, "appendIdempotencyKey");
  assertBoundedString(type, "type", 160);
  assertBoundedString(runId, "runId", 512);
  assertBoundedString(appendIdempotencyKey, "appendIdempotencyKey", 256, 16);
  const optionalLinks: Partial<Record<
    "occurrenceId" | "operationId" | "taskId" | "attemptId" | "correlationId" | "causationId",
    string
  >> = {};
  for (const key of [
    "occurrenceId",
    "operationId",
    "taskId",
    "attemptId",
    "correlationId",
    "causationId",
  ] as const) {
    const value = ownDataValue(input, key);
    if (value !== undefined) {
      assertBoundedString(value, key, 512);
      optionalLinks[key] = value;
    }
  }
  const payload = ownDataValue(input, "payload");
  const payloadArtifactId = ownDataValue(input, "payloadArtifactId");
  const hasInlinePayload = Object.hasOwn(input, "payload") && payload !== undefined;
  const hasArtifactPayload =
    Object.hasOwn(input, "payloadArtifactId") && payloadArtifactId !== undefined;
  if (hasInlinePayload === hasArtifactPayload) {
    throw new HarnessSessionEventValidationError(
      "event must contain exactly one of payload or payloadArtifactId",
    );
  }
  const normalizedPayload = hasInlinePayload
    ? normalizeJsonObject(payload, "payload")
    : undefined;
  if (!hasInlinePayload) assertBoundedString(payloadArtifactId, "payloadArtifactId", 512);
  const common = {
    type: type as TEventType,
    runId,
    appendIdempotencyKey,
    ...optionalLinks,
  };
  return (hasInlinePayload
    ? { ...common, payload: normalizedPayload }
    : { ...common, payloadArtifactId }) as DurableHarnessEventInput<TEventType>;
}

/** Canonical request digest used by every in-memory, file, remote, and PostgreSQL store. */
export function canonicalHarnessEventRequestDigest(
  input: DurableHarnessEventInput<string> | unknown,
): string {
  const event = normalizeDurableHarnessEventInput<string>(input);
  return stableHash({
    schemaVersion: HARNESS_SESSION_EVENT_APPEND_SCHEMA_VERSION,
    ...event,
  });
}

export function normalizePersistedDurableHarnessEvent<
  TEventType extends string = HarnessEventType,
>(input: PersistedDurableHarnessEvent<TEventType> | unknown): PersistedDurableHarnessEvent<TEventType> {
  if (!isPlainObject(input)) {
    throw new HarnessSessionEventValidationError("persisted event must be a plain object");
  }
  const persistedKeys = new Set([
    "type",
    "runId",
    "appendIdempotencyKey",
    "occurrenceId",
    "operationId",
    "taskId",
    "attemptId",
    "correlationId",
    "causationId",
    "payload",
    "payloadArtifactId",
    "eventId",
    "sequence",
    "recordedAt",
    "canonicalRequestDigest",
  ]);
  assertOnlyKeys(input, persistedKeys, "persisted event");
  const request = normalizeDurableHarnessEventInput<TEventType>({
    type: ownDataValue(input, "type"),
    runId: ownDataValue(input, "runId"),
    appendIdempotencyKey: ownDataValue(input, "appendIdempotencyKey"),
    ...optionalOwnDataValue(input, "occurrenceId"),
    ...optionalOwnDataValue(input, "operationId"),
    ...optionalOwnDataValue(input, "taskId"),
    ...optionalOwnDataValue(input, "attemptId"),
    ...optionalOwnDataValue(input, "correlationId"),
    ...optionalOwnDataValue(input, "causationId"),
    ...(ownDataValue(input, "payload") === undefined
      ? { payloadArtifactId: ownDataValue(input, "payloadArtifactId") }
      : { payload: ownDataValue(input, "payload") }),
  });
  const eventId = ownDataValue(input, "eventId");
  const sequence = ownDataValue(input, "sequence");
  const recordedAt = ownDataValue(input, "recordedAt");
  const canonicalRequestDigest = ownDataValue(input, "canonicalRequestDigest");
  assertBoundedString(eventId, "eventId", 512);
  if (!Number.isSafeInteger(sequence) || (sequence as number) < 0) {
    throw new HarnessSessionEventValidationError("sequence must be a non-negative safe integer");
  }
  assertCanonicalTimestamp(recordedAt, "recordedAt");
  assertDigest(canonicalRequestDigest, "canonicalRequestDigest");
  const expectedDigest = canonicalHarnessEventRequestDigest(request);
  if (canonicalRequestDigest !== expectedDigest) {
    throw new HarnessSessionEventValidationError(
      "canonicalRequestDigest does not match the append request",
    );
  }
  return structuredClone({
    ...request,
    eventId,
    sequence,
    recordedAt,
    canonicalRequestDigest,
  }) as PersistedDurableHarnessEvent<TEventType>;
}

export class HarnessSessionEventValidationError extends LittleHarnessError {
  declare readonly code: "harness_session_event_invalid";

  constructor(message: string) {
    super(message, "harness_session_event_invalid");
    this.name = "HarnessSessionEventValidationError";
  }
}

export class HarnessAppendIdempotencyConflictError extends LittleHarnessError {
  declare readonly code: "harness_append_idempotency_conflict";
  readonly runId: string;
  readonly appendIdempotencyKey: string;

  constructor(runId: string, appendIdempotencyKey: string) {
    super(
      `Append idempotency key ${appendIdempotencyKey} was already committed with a different request for run ${runId}.`,
      "harness_append_idempotency_conflict",
    );
    this.name = "HarnessAppendIdempotencyConflictError";
    this.runId = runId;
    this.appendIdempotencyKey = appendIdempotencyKey;
  }
}

export async function emitHarnessOccurrence<TEventType extends string = HarnessEventType>(
  event: HarnessEventOccurrence<TEventType>,
): Promise<void> {
  if (
    event.durability !== undefined &&
    event.payload !== undefined &&
    event.payloadArtifactId !== undefined
  ) {
    throw new HarnessSessionEventValidationError(
      "occurrence must contain at most one of payload or payloadArtifactId",
    );
  }
  if (
    event.durability !== undefined &&
    (event.payload !== undefined || event.payloadArtifactId !== undefined)
  ) {
    await event.durability.append({
      type: event.type,
      runId: event.runId,
      appendIdempotencyKey: event.appendIdempotencyKey,
      ...(event.occurrenceId === undefined ? {} : { occurrenceId: event.occurrenceId }),
      ...(event.operationId === undefined ? {} : { operationId: event.operationId }),
      ...(event.taskId === undefined ? {} : { taskId: event.taskId }),
      ...(event.attemptId === undefined ? {} : { attemptId: event.attemptId }),
      ...(event.correlationId === undefined ? {} : { correlationId: event.correlationId }),
      ...(event.causationId === undefined ? {} : { causationId: event.causationId }),
      ...(event.payload === undefined
        ? { payloadArtifactId: event.payloadArtifactId! }
        : { payload: event.payload }),
    });
  }

  if (event.trace === undefined) {
    return;
  }

  const traceEvent: TraceHarnessEventInput<TEventType> = {
    type: event.type,
    ...(event.occurrenceId === undefined ? {} : { occurrenceId: event.occurrenceId }),
    ...(event.metadata === undefined ? {} : { metadata: event.metadata }),
  };

  try {
    await event.trace.append(traceEvent);
  } catch (error) {
    await event.onTraceError?.(error, traceEvent);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertOnlyKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      throw new HarnessSessionEventValidationError(`${label} cannot contain symbol fields`);
    }
    if (!allowed.has(key)) {
      throw new HarnessSessionEventValidationError(`${label} contains unknown field ${key}`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true
    ) {
      throw new HarnessSessionEventValidationError(
        `${label}.${key} must be an enumerable data property`,
      );
    }
  }
}

function ownDataValue(value: Readonly<Record<string, unknown>>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
}

function optionalOwnDataValue<Key extends string>(
  value: Readonly<Record<string, unknown>>,
  key: Key,
): { [Property in Key]?: unknown } {
  const candidate = ownDataValue(value, key);
  return candidate === undefined ? {} : { [key]: candidate } as { [Property in Key]?: unknown };
}

function assertBoundedString(
  value: unknown,
  label: string,
  maximumBytes: number,
  minimumBytes = 1,
): asserts value is string {
  if (typeof value !== "string") {
    throw new HarnessSessionEventValidationError(`${label} must be a string`);
  }
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes < minimumBytes || bytes > maximumBytes || value.includes("\0")) {
    throw new HarnessSessionEventValidationError(
      `${label} must be NUL-free and between ${minimumBytes} and ${maximumBytes} UTF-8 bytes`,
    );
  }
}

function assertCanonicalTimestamp(value: unknown, label: string): asserts value is string {
  assertBoundedString(value, label, 64);
  const instant = Date.parse(value);
  if (!Number.isFinite(instant) || new Date(instant).toISOString() !== value) {
    throw new HarnessSessionEventValidationError(`${label} must be canonical UTC ISO-8601`);
  }
}

function assertDigest(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new HarnessSessionEventValidationError(`${label} must be a lowercase sha256 digest`);
  }
}

function normalizeJsonObject(value: unknown, label: string): JsonObject {
  if (!isPlainObject(value)) {
    throw new HarnessSessionEventValidationError(`${label} must be a JSON object`);
  }
  const normalized = normalizeJsonValue(
    value,
    label,
    new WeakSet<object>(),
    { remainingNodes: MAX_HARNESS_EVENT_JSON_NODES },
    0,
    false,
  );
  if (!isPlainObject(normalized)) {
    throw new HarnessSessionEventValidationError(`${label} must normalize to a JSON object`);
  }
  return normalized;
}

function normalizeJsonValue(
  value: unknown,
  label: string,
  seen: WeakSet<object>,
  complexity: { remainingNodes: number },
  depth: number,
  arrayElement: boolean,
): unknown {
  complexity.remainingNodes -= 1;
  if (complexity.remainingNodes < 0 || depth > MAX_HARNESS_EVENT_JSON_DEPTH) {
    throw new HarnessSessionEventValidationError(`${label} exceeds JSON complexity limits`);
  }
  if (value === undefined) return arrayElement ? null : undefined;
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) return value;
  if (typeof value !== "object") {
    throw new HarnessSessionEventValidationError(`${label} contains a non-JSON value`);
  }
  if (seen.has(value)) {
    throw new HarnessSessionEventValidationError(`${label} exceeds JSON complexity limits`);
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        throw new HarnessSessionEventValidationError(`${label} contains a non-plain array`);
      }
      if (value.length > complexity.remainingNodes) {
        throw new HarnessSessionEventValidationError(`${label} exceeds JSON complexity limits`);
      }
      for (const key of Reflect.ownKeys(value)) {
        if (
          typeof key !== "string" ||
          (key !== "length" && !isCanonicalArrayIndex(key, value.length))
        ) {
          throw new HarnessSessionEventValidationError(
            `${label} arrays cannot contain custom or symbol fields`,
          );
        }
      }
      const normalized: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor === undefined) {
          normalized.push(null);
          complexity.remainingNodes -= 1;
          if (complexity.remainingNodes < 0) {
            throw new HarnessSessionEventValidationError(`${label} exceeds JSON complexity limits`);
          }
          continue;
        }
        if (!("value" in descriptor) || descriptor.enumerable !== true) {
          throw new HarnessSessionEventValidationError(
            `${label}[${index}] must be an enumerable data property`,
          );
        }
        normalized.push(normalizeJsonValue(
          descriptor.value,
          `${label}[${index}]`,
          seen,
          complexity,
          depth + 1,
          true,
        ));
      }
      return normalized;
    }
    if (!isPlainObject(value)) {
      throw new HarnessSessionEventValidationError(`${label} contains a non-plain object`);
    }
    const normalized: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") {
        throw new HarnessSessionEventValidationError(`${label} cannot contain symbol fields`);
      }
      if (key.includes("\0")) {
        throw new HarnessSessionEventValidationError(`${label} contains a NUL in an object key`);
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.enumerable !== true
      ) {
        throw new HarnessSessionEventValidationError(
          `${label}.${key} must be an enumerable data property`,
        );
      }
      const child = normalizeJsonValue(
        descriptor.value,
        `${label}.${key}`,
        seen,
        complexity,
        depth + 1,
        false,
      );
      if (child !== undefined) {
        Object.defineProperty(normalized, key, {
          configurable: true,
          enumerable: true,
          value: child,
          writable: true,
        });
      }
    }
    return normalized;
  } finally {
    seen.delete(value);
  }
}

function isCanonicalArrayIndex(key: string, length: number): boolean {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(key)) return false;
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === key;
}
