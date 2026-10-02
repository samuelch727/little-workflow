import { expect, it } from "vitest";
import { modelFacingWorkflowRunStatus } from "./workflow-run-status.js";

it("maps admitted workflow queue records to running for model-facing inspection", () => {
  expect(modelFacingWorkflowRunStatus("queued")).toBe("queued");
  expect(modelFacingWorkflowRunStatus("admitted")).toBe("running");
  expect(modelFacingWorkflowRunStatus("running")).toBe("running");
  expect(modelFacingWorkflowRunStatus("completed")).toBe("completed");
  expect(modelFacingWorkflowRunStatus("failed")).toBe("failed");
  expect(modelFacingWorkflowRunStatus("cancelled")).toBe("cancelled");
});
