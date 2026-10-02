export const SUPPORT_SESSION_ID_HEADER = "x-harness-session-id";

const SUPPORT_SESSION_ID_PATTERN = /^support:[a-zA-Z0-9:_-]{1,160}$/u;

export function supportSessionId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return SUPPORT_SESSION_ID_PATTERN.test(trimmed) ? trimmed : undefined;
}

export function supportSessionIdFromRecord(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  return supportSessionId(record.harnessSessionId) ?? supportSessionId(record.sessionId);
}
