import { describe, expect, it } from "vitest";
import { HARNESS_EVENT_TYPES, isHarnessEventType } from "./names.js";

describe("harness event names", () => {
  it("uses dotted harness namespaces for shared events", () => {
    expect(HARNESS_EVENT_TYPES).toContain("harness.session.started");
    expect(HARNESS_EVENT_TYPES).toContain("harness.model.called");
    expect(HARNESS_EVENT_TYPES).toContain("harness.tool_call.started");
    expect(HARNESS_EVENT_TYPES).toContain("harness.runtime.command.started");
  });

  it("rejects legacy PascalCase event names", () => {
    expect(isHarnessEventType("HarnessSessionStarted")).toBe(false);
    expect(isHarnessEventType("session.started")).toBe(false);
  });

  it("keeps workflow-specific execute-step events out of the core set", () => {
    expect(isHarnessEventType("harness.execute_step.started")).toBe(false);
    expect(isHarnessEventType("harness.execute_step.succeeded")).toBe(false);
  });
});
