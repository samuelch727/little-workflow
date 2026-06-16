const LEGACY_HARNESS_EVENT_TYPES: Readonly<Record<string, string>> = {
  HarnessSessionStarted: "harness.session.started",
  HarnessSessionCompleted: "harness.session.completed",
  HarnessSessionFailed: "harness.session.failed",
  HarnessModelCalled: "harness.model.called",
  HarnessModelResponded: "harness.model.responded",
  HarnessModelFailed: "harness.model.failed",
  HarnessToolCallStarted: "harness.tool_call.started",
  HarnessToolCallSucceeded: "harness.tool_call.succeeded",
  HarnessToolCallFailed: "harness.tool_call.failed",
  HarnessExecuteStepStarted: "harness.execute_step.started",
  HarnessExecuteStepSucceeded: "harness.execute_step.succeeded",
};

export function normalizeHarnessEventType(type: string): string {
  return LEGACY_HARNESS_EVENT_TYPES[type] ?? type;
}
