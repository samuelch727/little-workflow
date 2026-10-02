export const CONCIERGE_SESSION_ID_HEADER = "x-harness-session-id";

const CONCIERGE_SESSION_ID_PATTERN = /^concierge:[a-zA-Z0-9:_-]{1,160}$/u;

/** Validate and normalize a `concierge:*` session id, or return undefined. */
export function conciergeSessionId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return CONCIERGE_SESSION_ID_PATTERN.test(trimmed) ? trimmed : undefined;
}

/** Extract a session id from a platform message's `raw` record. */
export function conciergeSessionIdFromRecord(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  return conciergeSessionId(record.harnessSessionId) ?? conciergeSessionId(record.sessionId);
}
