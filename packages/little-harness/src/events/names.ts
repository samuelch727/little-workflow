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
  "harness.runtime.error",
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
