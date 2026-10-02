import { describe, expect, it } from "vitest";
import {
  HARNESS_EVENT_TYPES,
  HARNESS_SIDE_CHANNEL_EVENT_TYPES,
  isHarnessEventType,
  isHarnessSideChannelEventType,
} from "./names.js";

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

  it("keeps side-channel observations out of the core (durable, replayable) set", () => {
    expect(HARNESS_SIDE_CHANNEL_EVENT_TYPES).toContain("outcome.reported");
    // An outcome is a fact ABOUT a run, never an input TO it, so it must never reach the
    // durable session log that replay reads back.
    expect(isHarnessEventType("outcome.reported")).toBe(false);
    expect(HARNESS_EVENT_TYPES).not.toContain("outcome.reported");
  });

  it("recognizes side-channel event types and nothing else", () => {
    expect(isHarnessSideChannelEventType("outcome.reported")).toBe(true);
    expect(isHarnessSideChannelEventType("harness.outcome.reported")).toBe(false);
    expect(isHarnessSideChannelEventType("harness.session.started")).toBe(false);
  });
});
