import { LittleHarnessError } from "../errors.js";
import {
  canonicalHarnessEventRequestDigest,
  normalizeDurableHarnessEventInput,
  normalizePersistedDurableHarnessEvent,
  type DurableHarnessEventInput,
  type PersistedDurableHarnessEvent,
} from "../events/occurrence.js";

export const REMOTE_SESSION_LOG_PROTOCOL_VERSION = "lh.remote-session.v1" as const;

export type RemoteAppendRequest = Readonly<{
  schemaVersion: typeof REMOTE_SESSION_LOG_PROTOCOL_VERSION;
  canonicalRequestDigest: string;
  event: DurableHarnessEventInput;
}>;

export function createRemoteAppendRequest(event: DurableHarnessEventInput): RemoteAppendRequest {
  const normalized = normalizeDurableHarnessEventInput(event);
  return {
    schemaVersion: REMOTE_SESSION_LOG_PROTOCOL_VERSION,
    canonicalRequestDigest: canonicalHarnessEventRequestDigest(normalized),
    event: normalized,
  };
}

export function parseRemoteAppendRequest(input: unknown): RemoteAppendRequest {
  const record = strictRecord(
    input,
    ["schemaVersion", "canonicalRequestDigest", "event"],
    "append request",
  );
  if (record.schemaVersion !== REMOTE_SESSION_LOG_PROTOCOL_VERSION) {
    throw new RemoteSessionProtocolError("unsupported append request schemaVersion");
  }
  if (
    typeof record.canonicalRequestDigest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/u.test(record.canonicalRequestDigest)
  ) {
    throw new RemoteSessionProtocolError("invalid canonicalRequestDigest");
  }
  const event = normalizeDurableHarnessEventInput(record.event);
  const expected = canonicalHarnessEventRequestDigest(event);
  if (record.canonicalRequestDigest !== expected) {
    throw new RemoteSessionProtocolError("canonicalRequestDigest does not match event");
  }
  return {
    schemaVersion: REMOTE_SESSION_LOG_PROTOCOL_VERSION,
    canonicalRequestDigest: expected,
    event,
  };
}

export function parseRemoteAppendResponse(input: unknown): PersistedDurableHarnessEvent {
  const record = strictRecord(input, ["schemaVersion", "event"], "append response");
  if (record.schemaVersion !== REMOTE_SESSION_LOG_PROTOCOL_VERSION) {
    throw new RemoteSessionProtocolError("unsupported append response schemaVersion");
  }
  return normalizePersistedDurableHarnessEvent(record.event);
}

export function parseRemoteReplayResponse(input: unknown): readonly PersistedDurableHarnessEvent[] {
  const record = strictRecord(input, ["schemaVersion", "events"], "replay response");
  if (record.schemaVersion !== REMOTE_SESSION_LOG_PROTOCOL_VERSION) {
    throw new RemoteSessionProtocolError("unsupported replay response schemaVersion");
  }
  if (!Array.isArray(record.events)) {
    throw new RemoteSessionProtocolError("replay response events must be an array");
  }
  return record.events.map((event) => normalizePersistedDurableHarnessEvent(event));
}

export class RemoteSessionProtocolError extends LittleHarnessError {
  declare readonly code: "remote_session_protocol_error";

  constructor(message: string) {
    super(message, "remote_session_protocol_error");
    this.name = "RemoteSessionProtocolError";
  }
}

function strictRecord(
  input: unknown,
  allowedKeys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)
  ) {
    throw new RemoteSessionProtocolError(`${label} must be an object`);
  }
  const record = input as Record<string, unknown>;
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new RemoteSessionProtocolError(`${label} contains unknown field ${key}`);
    }
  }
  for (const key of allowedKeys) {
    if (!Object.hasOwn(record, key)) {
      throw new RemoteSessionProtocolError(`${label} is missing ${key}`);
    }
  }
  return record;
}
