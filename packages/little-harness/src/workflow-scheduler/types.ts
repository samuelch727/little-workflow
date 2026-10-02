import type {
  HarnessWorkflowDefinitionIdentity,
  HarnessWorkflowInheritance,
} from "../workflows.js";

export type WorkflowReserveInput = {
  readonly sessionId: string;
  readonly workflowId: string;
  readonly handle: string;
  readonly disposition: "await" | "start";
  readonly input: unknown;
  readonly inputHash: string;
  readonly sessionDataDir: string;
  readonly dataDir: string;
  readonly originTurnId: string;
  readonly parentTurnId: string;
  readonly callIdentity: string;
  readonly reservationScopeId: string;
  readonly reservationOrder: number;
  readonly scopeSize: number;
  readonly toolCallId?: string;
  readonly launcherHandle?: string;
  readonly workflowDefinitionIdentity: HarnessWorkflowDefinitionIdentity;
  readonly workflowVersionId?: string;
  readonly memoryScope: "cross-session" | "session" | "none";
  readonly workflowSetMemoryKey?: string;
  readonly workflowSetDefinitionIdentities: readonly HarnessWorkflowDefinitionIdentity[];
  readonly inheritance: HarnessWorkflowInheritance;
  readonly source?: "static" | "dynamic";
  readonly purpose?: string;
  readonly dynamicPlan?: unknown;
  readonly dynamicCapabilitySnapshot?: unknown;
  readonly queueDeadlineAt?: string;
  readonly replay?: boolean;
};

export type WorkflowLaunchTransactionInput = WorkflowReserveInput & {
  readonly taskKind: "workflow";
  readonly reservedAt: string;
  readonly reservedRunId?: string;
};

export type WorkflowReserveResult = {
  readonly queueId: string;
  readonly taskId: `task_${number}`;
  readonly reservedRunId: string;
  readonly inputResultId: string;
  readonly status: "queued" | "admitted";
  readonly modelFacingStatus: "queued" | "running";
};

export function modelFacingWorkflowStatus(
  status: WorkflowReserveResult["status"],
): WorkflowReserveResult["modelFacingStatus"] {
  return status === "admitted" ? "running" : "queued";
}
