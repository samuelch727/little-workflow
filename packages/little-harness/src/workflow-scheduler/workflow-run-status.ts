import type { HarnessWorkflowQueueRecord } from "../tasks/ledger.js";

export function modelFacingWorkflowRunStatus(
  status: HarnessWorkflowQueueRecord["status"],
): "queued" | "running" | "completed" | "failed" | "cancelled" {
  return status === "admitted" ? "running" : status;
}
