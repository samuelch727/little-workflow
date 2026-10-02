export const HARNESS_EVENT_TYPES = [
  "harness.session.started",
  "harness.session.completed",
  "harness.session.failed",
  "harness.model.called",
  "harness.model.responded",
  "harness.model.failed",
  "harness.tool_call.started",
  "harness.tool_call.succeeded",
  "harness.tool_call.failed",
  "harness.runtime.command.started",
  "harness.runtime.command.succeeded",
  "harness.runtime.command.failed",
  "harness.runtime.command.denied",
  "harness.runtime.tier.escalated",
  "harness.runtime.tier.unavailable",
  "harness.runtime.error",
  "harness.runtime.dispose.failed",
  "harness.file.created",
  "harness.file.updated",
  "harness.file.deleted",
  "harness.file.staged_from_message",
  "harness.file.staged_from_host",
  "harness.file.written_by_tool",
  "harness.artifact.created",
  "harness.filesystem.mounted",
  "harness.persistent_dir.loaded",
  "harness.persistent_dir.commit.started",
  "harness.persistent_dir.commit.succeeded",
  "harness.persistent_dir.commit.failed",
] as const;

export type HarnessEventType = (typeof HARNESS_EVENT_TYPES)[number];

const HARNESS_EVENT_TYPE_SET = new Set<string>(HARNESS_EVENT_TYPES);

export function isHarnessEventType(value: unknown): value is HarnessEventType {
  return typeof value === "string" && HARNESS_EVENT_TYPE_SET.has(value);
}

/**
 * Side-channel event types: facts written ONTO a run after the fact by an observer, rather
 * than events the run itself emitted. They are deliberately NOT in `HARNESS_EVENT_TYPES`,
 * because that set types the durable session log — the replay input for a run — and an
 * outcome is never an input to the run it describes. They ARE valid trace events (see
 * `trace/validate.ts`) so they can be read back alongside the run they annotate.
 *
 * `outcome.reported` is spelled exactly as littleDB stores it (`server/outcomes.ts`), so a
 * locally traced outcome and a control-plane-ingested one carry the same type string.
 */
export const HARNESS_SIDE_CHANNEL_EVENT_TYPES = ["outcome.reported"] as const;

export type HarnessSideChannelEventType = (typeof HARNESS_SIDE_CHANNEL_EVENT_TYPES)[number];

const HARNESS_SIDE_CHANNEL_EVENT_TYPE_SET = new Set<string>(HARNESS_SIDE_CHANNEL_EVENT_TYPES);

export function isHarnessSideChannelEventType(
  value: unknown,
): value is HarnessSideChannelEventType {
  return typeof value === "string" && HARNESS_SIDE_CHANNEL_EVENT_TYPE_SET.has(value);
}
