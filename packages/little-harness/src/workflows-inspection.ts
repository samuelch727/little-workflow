import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { resultIdPattern } from "./results/mounts.js";
import type {
  HarnessResultGrantStore,
  HarnessResultStore,
  HarnessStoredResult,
  HarnessTaskLedger,
  HarnessWorkflowQueueLedger,
  HarnessWorkflowQueueRecord,
} from "./tasks/ledger.js";
import type { HarnessTaskRecord } from "./tasks/types.js";
import { modelFacingWorkflowRunStatus } from "./workflow-scheduler/workflow-run-status.js";
import type { ResolvedWorkflowManifestEntry } from "./workspace/resolve-agent-manifest.js";

export type WorkflowInspectionToolsOptions = {
  readonly sessionId: string;
  readonly workflows: readonly ResolvedWorkflowManifestEntry[];
  readonly tasks?: HarnessTaskLedger;
  readonly workflowQueue?: HarnessWorkflowQueueLedger;
  readonly results?: HarnessResultStore;
  readonly resultGrants?: HarnessResultGrantStore;
};

const includeSchema = z.array(z.enum(["output"])).optional();
const listWorkflowsInputSchema = z.object({}).strict();
const getWorkflowInputSchema = z.object({ workflow: z.string().min(1) }).strict();
const getWorkflowTaskInputSchema = z.object({ taskId: z.string().regex(/^task_\d+$/u), include: includeSchema }).strict();
const getWorkflowRunInputSchema = z.object({ runId: z.string().min(1), include: includeSchema }).strict();

export function createWorkflowInspectionTools(options: WorkflowInspectionToolsOptions): ToolSet {
  return {
    list_workflows: tool({
      description: "List workflows available to this harness agent.",
      inputSchema: listWorkflowsInputSchema,
      execute: async () => ({
        workflows: options.workflows.map(presentWorkflow),
      }),
    }),
    get_workflow: tool({
      description: "Inspect one available workflow by id or handle.",
      inputSchema: getWorkflowInputSchema,
      execute: async ({ workflow }) => {
        const found = workflowByIdOrHandle(options.workflows, workflow);
        if (found === undefined) {
          return { status: "not_found", workflow };
        }
        return presentWorkflow(found);
      },
    }),
    get_workflow_task: tool({
      description: "Inspect the workflow run attached to one background task.",
      inputSchema: getWorkflowTaskInputSchema,
      execute: async ({ taskId, include }) => {
        if (options.tasks === undefined) {
          return unsupportedDurableHost("Task inspection requires durable task storage.");
        }
        const task = await options.tasks.getTask({ sessionId: options.sessionId, taskId: taskId as never });
        if (task === undefined) {
          return { status: "not_found", taskId };
        }
        if (task.kind !== "workflow") {
          return invalidTaskKind(task);
        }
        const queue = await options.workflowQueue?.getByTaskId({ sessionId: options.sessionId, taskId: taskId as never });
        return runView({
          sessionId: options.sessionId,
          workflows: options.workflows,
          task,
          queue,
          results: options.results,
          resultGrants: options.resultGrants,
          includeOutput: include?.includes("output") === true,
        });
      },
    }),
    get_workflow_run: tool({
      description: "Inspect one workflow run by run id.",
      inputSchema: getWorkflowRunInputSchema,
      execute: async ({ runId, include }) => {
        if (options.workflowQueue === undefined) {
          return unsupportedDurableHost("Workflow run inspection requires durable workflow queue storage.");
        }
        const queue = await options.workflowQueue.getByRunId({ sessionId: options.sessionId, runId });
        if (queue === undefined) {
          return { status: "not_found", runId };
        }
        const task = queue.taskId === undefined
          ? undefined
          : await options.tasks?.getTask({ sessionId: options.sessionId, taskId: queue.taskId });
        return runView({
          sessionId: options.sessionId,
          workflows: options.workflows,
          task,
          queue,
          results: options.results,
          resultGrants: options.resultGrants,
          includeOutput: include?.includes("output") === true,
        });
      },
    }),
  };
}

function presentWorkflow(workflow: ResolvedWorkflowManifestEntry) {
  return compact({
    id: workflow.id,
    handle: workflow.handle,
    description: workflow.description,
    executionMode: workflow.executionMode,
    workflowDefinitionIdentity: workflow.workflowDefinitionIdentity,
    inputSchema: workflow.inputSchema,
  });
}

async function runView(options: {
  readonly sessionId: string;
  readonly workflows: readonly ResolvedWorkflowManifestEntry[];
  readonly task?: HarnessTaskRecord | undefined;
  readonly queue?: HarnessWorkflowQueueRecord | undefined;
  readonly results?: HarnessResultStore | undefined;
  readonly resultGrants?: HarnessResultGrantStore | undefined;
  readonly includeOutput: boolean;
}) {
  if (!belongsToInspectionSession(options.sessionId, options.task, options.queue)) {
    return sessionMismatch();
  }
  const workflowId = options.queue?.workflowId ?? options.task?.workflowId;
  const workflow = workflowId === undefined ? undefined : workflowByIdOrHandle(options.workflows, workflowId);
  const resultId = options.queue?.terminalResultId ?? options.task?.terminalResultId;
  const resultRecord = resultId === undefined
    ? undefined
    : await options.results?.getRecord({ sessionId: options.sessionId, resultId });
  if (resultRecord !== undefined && resultRecord.sessionId !== options.sessionId) {
    return sessionMismatch();
  }
  const result = options.includeOutput && resultId !== undefined
    ? await options.results?.get({ sessionId: options.sessionId, resultId })
    : undefined;
  if (result !== undefined && result.record.sessionId !== options.sessionId) {
    return sessionMismatch();
  }
  const outputPath = resultOutputPath(resultRecord);

  return compact({
    runId: options.queue?.reservedRunId ?? options.task?.reservedRunId,
    taskId: options.queue?.taskId ?? options.task?.taskId,
    workflowId,
    handle: options.queue?.handle ?? workflow?.handle ?? options.task?.workflowHandle,
    status: options.queue === undefined ? options.task?.status : modelFacingWorkflowRunStatus(options.queue.status),
    currentStep: options.queue?.currentStep,
    lastEvent: compactTerminalDiagnostic(options.queue?.lastEvent),
    resultId,
    outputSummary: resultRecord?.inlineSummary ?? options.task?.outputSummary,
    outputPath,
    terminalCauseCode: options.queue?.terminalCauseCode ?? options.task?.terminalCauseCode,
    terminalMessage: options.queue?.terminalMessage ?? options.task?.terminalMessage,
    terminalDiagnostic: compactTerminalDiagnostic(options.queue?.terminalDiagnostic ?? options.task?.terminalDiagnostic),
    ...(options.includeOutput && result !== undefined ? { output: result.value } : {}),
  });
}

// Model-facing results expose an opaque virtual outputPath keyed by the durable
// resultId (harness-result://<resultId>/output) -- never a readable filesystem
// path and never a result grant. Grants are minted only for an explicit
// runtime/bash/code mount request, not for model-facing inspection.
function resultOutputPath(result: HarnessStoredResult | undefined): string | undefined {
  if (result === undefined) {
    return undefined;
  }
  if (result.outputPath !== undefined) {
    return result.outputPath;
  }
  if (!resultIdPattern.test(result.resultId)) {
    throw new Error(`Invalid Harness result id: ${result.resultId}`);
  }
  return `harness-result://${result.resultId}/output`;
}

function belongsToInspectionSession(
  sessionId: string,
  task: HarnessTaskRecord | undefined,
  queue: HarnessWorkflowQueueRecord | undefined,
): boolean {
  return (task === undefined || task.sessionId === sessionId) && (queue === undefined || queue.sessionId === sessionId);
}

function sessionMismatch() {
  return {
    status: "failed" as const,
    causeCode: "session_mismatch" as const,
    message: "Workflow inspection record belongs to a different session.",
  };
}

function invalidTaskKind(task: HarnessTaskRecord) {
  return {
    status: "failed" as const,
    causeCode: "invalid_task_kind" as const,
    taskId: task.taskId,
    kind: task.kind,
    message: "Workflow task inspection can only inspect workflow tasks.",
  };
}

function workflowByIdOrHandle(
  workflows: readonly ResolvedWorkflowManifestEntry[],
  idOrHandle: string,
): ResolvedWorkflowManifestEntry | undefined {
  return workflows.find((workflow) => workflow.id === idOrHandle || workflow.handle === idOrHandle);
}

function unsupportedDurableHost(message: string) {
  return {
    status: "failed" as const,
    causeCode: "unsupported_durable_host" as const,
    message,
  };
}

function compactTerminalDiagnostic(diagnostic: unknown): unknown {
  if (diagnostic === undefined || diagnostic === null || typeof diagnostic !== "object") {
    return diagnostic;
  }
  if (Array.isArray(diagnostic)) {
    return "[array]";
  }
  return Object.fromEntries(
    Object.entries(diagnostic).flatMap(([key, value]) =>
      key === "stack"
        ? []
        : [[key, value === null || value === undefined || typeof value !== "object" ? value : Array.isArray(value) ? "[array]" : "[object]"]]
    ),
  );
}

function compact(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}
