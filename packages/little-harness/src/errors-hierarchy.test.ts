import { describe, expect, it } from "vitest";
import {
  HarnessAgentGroupCursorError,
  HarnessAgentGroupLaunchRejectedError,
  HarnessAgentGroupPageCallLimitError,
} from "./agents/index.js";
import { LittleHarnessError } from "./errors.js";
import {
  HarnessAppendIdempotencyConflictError,
  HarnessSessionEventValidationError,
} from "./events/occurrence.js";
import { FileSessionLogDurabilityError, RemoteSessionProtocolError } from "./remote-session/index.js";

describe("error hierarchy", () => {
  it("lets one instanceof LittleHarnessError catch every Harness error, each with a stable code", () => {
    const cause = new Error("fsync");
    const cases: Array<[Error, string]> = [
      [new HarnessAgentGroupCursorError("expired"), "expired"],
      [new HarnessAgentGroupPageCallLimitError(3), "page_call_limit"],
      [new HarnessAgentGroupLaunchRejectedError(), "agent_group_launch_rejected"],
      [new HarnessSessionEventValidationError("bad"), "harness_session_event_invalid"],
      [new HarnessAppendIdempotencyConflictError("run", "key"), "harness_append_idempotency_conflict"],
      [new RemoteSessionProtocolError("bad"), "remote_session_protocol_error"],
      [new FileSessionLogDurabilityError("file", cause), "file_session_log_durability_error"],
    ];
    for (const [error, code] of cases) {
      expect(error).toBeInstanceOf(LittleHarnessError);
      expect((error as LittleHarnessError).code).toBe(code);
    }
    expect(cases[6]![0].cause).toBe(cause);
    expect((cases[1]![0] as HarnessAgentGroupPageCallLimitError).maximumCalls).toBe(3);
  });
});
