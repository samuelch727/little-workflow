import { describe, expect, it } from "vitest";
import {
  WORKFLOW_HARNESS_ID,
  workflowHarness,
} from "./index.js";

describe("harness public API", () => {
  it("re-exports the Workflow harness identity and default harness", () => {
    expect(WORKFLOW_HARNESS_ID).toBe("workflowHarness@1.0.0");
    expect(workflowHarness.harnessId).toBe(WORKFLOW_HARNESS_ID);
  });
});
