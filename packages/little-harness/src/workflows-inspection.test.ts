import { describe, expect, it } from "vitest";
import type { HarnessResultGrantStore, HarnessResultStore } from "./tasks/ledger.js";
import { createWorkflowInspectionTools } from "./workflows-inspection.js";

const workflow = {
  id: "candidate.review",
  handle: "candidate_review",
  description: "Review a candidate.",
  executionMode: "durable" as const,
  workflowDefinitionIdentity: "sha256:test-candidate-review",
  inputSchema: undefined,
};

describe("createWorkflowInspectionTools", () => {
  it("lists workflows with id, handle, and description", async () => {
    const tools = createWorkflowInspectionTools({
      sessionId: "sess_1",
      workflows: [workflow],
    });

    await expect(tools.list_workflows!.execute?.({}, {} as never)).resolves.toEqual({
      workflows: [{
        id: "candidate.review",
        handle: "candidate_review",
        description: "Review a candidate.",
        executionMode: "durable",
        workflowDefinitionIdentity: "sha256:test-candidate-review",
      }],
    });
  });

  it("returns compact run state with opaque output path", async () => {
    const grants = grantStoreWith();
    const tools = createWorkflowInspectionTools({
      sessionId: "sess_1",
      workflows: [workflow],
      tasks: taskLedgerWith([
        { taskId: "task_1", sessionId: "sess_1", kind: "workflow", workflowId: "candidate.review", reservedRunId: "run_1", status: "completed" },
      ]),
      workflowQueue: workflowQueueWith([
        {
          queueId: "queue_1",
          sessionId: "sess_1",
          reservedRunId: "run_1",
          taskId: "task_1",
          workflowId: "candidate.review",
          handle: "candidate_review",
          status: "completed",
          currentStep: "score",
          lastEvent: { type: "StepCompleted", stepId: "score" },
          terminalResultId: "result_1",
        },
      ]),
      results: resultStoreWith({
        "sess_1:result_1": {
          record: {
            resultId: "result_1",
            sessionId: "sess_1",
            sessionDataDir: "/tmp/sess_1",
            inlineSummary: "Candidate advances.",
          },
          value: { recommendation: "advance" },
        },
      }),
      resultGrants: grants,
    });

    await expect(tools.get_workflow_run!.execute?.({ runId: "run_1" }, {} as never)).resolves.toEqual({
      runId: "run_1",
      taskId: "task_1",
      workflowId: "candidate.review",
      handle: "candidate_review",
      status: "completed",
      currentStep: "score",
      lastEvent: { type: "StepCompleted", stepId: "score" },
      resultId: "result_1",
      outputSummary: "Candidate advances.",
      outputPath: "harness-result://result_1/output",
    });
    expect(grants.mintCalls).toBe(0);
  });

  it("sanitizes workflow-authored lastEvent the same way as terminal diagnostics", async () => {
    const tools = createWorkflowInspectionTools({
      sessionId: "sess_1",
      workflows: [workflow],
      workflowQueue: workflowQueueWith([
        {
          queueId: "queue_1",
          sessionId: "sess_1",
          reservedRunId: "run_1",
          taskId: "task_1",
          workflowId: "candidate.review",
          handle: "candidate_review",
          status: "running",
          lastEvent: {
            type: "StepFailed",
            stepId: "score",
            stack: "Error: boom\n  at /home/dev/secret/path/file.ts:12:3",
            detail: { nested: "object", path: "/home/dev/secret/path" },
          },
        },
      ]),
    });

    await expect(tools.get_workflow_run!.execute?.({ runId: "run_1" }, {} as never)).resolves.toMatchObject({
      lastEvent: { type: "StepFailed", stepId: "score", detail: "[object]" },
    });
    const run = await tools.get_workflow_run!.execute?.({ runId: "run_1" }, {} as never) as { lastEvent: Record<string, unknown> };
    expect(run.lastEvent).not.toHaveProperty("stack");
  });

  it("maps admitted queue records to running", async () => {
    const tools = createWorkflowInspectionTools({
      sessionId: "sess_1",
      workflows: [workflow],
      workflowQueue: workflowQueueWith([
        {
          queueId: "queue_1",
          sessionId: "sess_1",
          reservedRunId: "run_1",
          taskId: "task_1",
          workflowId: "candidate.review",
          handle: "candidate_review",
          status: "admitted",
        },
      ]),
    });

    await expect(tools.get_workflow_run!.execute?.({ runId: "run_1" }, {} as never)).resolves.toMatchObject({
      runId: "run_1",
      status: "running",
    });
  });

  it("can include full output only when requested", async () => {
    const tools = createWorkflowInspectionTools({
      sessionId: "sess_1",
      workflows: [workflow],
      workflowQueue: workflowQueueWith([
        {
          queueId: "queue_1",
          sessionId: "sess_1",
          reservedRunId: "run_1",
          taskId: "task_1",
          workflowId: "candidate.review",
          handle: "candidate_review",
          status: "completed",
          terminalResultId: "result_1",
        },
      ]),
      results: resultStoreWith({
        "sess_1:result_1": {
          record: {
            resultId: "result_1",
            sessionId: "sess_1",
            sessionDataDir: "/tmp/sess_1",
          },
          value: { recommendation: "advance" },
        },
      }),
      resultGrants: grantStoreWith(),
    });

    await expect(tools.get_workflow_run!.execute?.({ runId: "run_1", include: ["output"] }, {} as never))
      .resolves.toMatchObject({ output: { recommendation: "advance" } });
  });

  it("does not read full result values for compact inspection", async () => {
    const results = resultStoreWith({
      "sess_1:result_1": {
        record: {
          resultId: "result_1",
          sessionId: "sess_1",
          sessionDataDir: "/tmp/sess_1",
          inlineSummary: "Large output summary.",
        },
        value: "LARGE_OUTPUT_SENTINEL",
      },
    });
    const tools = createWorkflowInspectionTools({
      sessionId: "sess_1",
      workflows: [workflow],
      workflowQueue: workflowQueueWith([
        {
          queueId: "queue_1",
          sessionId: "sess_1",
          reservedRunId: "run_1",
          taskId: "task_1",
          workflowId: "candidate.review",
          handle: "candidate_review",
          status: "completed",
          terminalResultId: "result_1",
        },
      ]),
      results,
      resultGrants: grantStoreWith(),
    });

    await expect(tools.get_workflow_run!.execute?.({ runId: "run_1" }, {} as never))
      .resolves.toMatchObject({ outputSummary: "Large output summary." });
    expect(results.getCalls).toBe(0);
  });

  it("rejects unsupported inspection options before execution", () => {
    const tools = createWorkflowInspectionTools({
      sessionId: "sess_1",
      workflows: [workflow],
    });

    expect(parseToolInput(tools.list_workflows, { mountFor: "agent" }).success).toBe(false);
    expect(parseToolInput(tools.get_workflow_run, {
      runId: "run_1",
      include: ["output"],
      mountFor: "agent",
    }).success).toBe(false);
  });

  it("uses the inspection session when result ids collide", async () => {
    const tools = createWorkflowInspectionTools({
      sessionId: "sess_1",
      workflows: [workflow],
      workflowQueue: workflowQueueWith([
        {
          queueId: "queue_1",
          sessionId: "sess_1",
          reservedRunId: "run_1",
          taskId: "task_1",
          workflowId: "candidate.review",
          handle: "candidate_review",
          status: "completed",
          terminalResultId: "result_1",
        },
        {
          queueId: "queue_1",
          sessionId: "sess_2",
          reservedRunId: "run_1",
          taskId: "task_1",
          workflowId: "candidate.review",
          handle: "candidate_review",
          status: "completed",
          terminalResultId: "result_1",
        },
      ]),
      results: resultStoreWith({
        "sess_1:result_1": { record: { resultId: "result_1", sessionId: "sess_1", sessionDataDir: "/tmp/sess_1", inlineSummary: "Current session." }, value: { ok: true } },
        "sess_2:result_1": { record: { resultId: "result_1", sessionId: "sess_2", sessionDataDir: "/tmp/sess_2", inlineSummary: "Wrong session." }, value: { ok: false } },
      }),
      resultGrants: grantStoreWith(),
    });

    await expect(tools.get_workflow_run!.execute?.({ runId: "run_1" }, {} as never))
      .resolves.toMatchObject({ outputSummary: "Current session." });
  });

  it("fails closed when durable workflow records are from a different session", async () => {
    const tools = createWorkflowInspectionTools({
      sessionId: "sess_1",
      workflows: [workflow],
      workflowQueue: {
        getByRunId: async () => ({
          queueId: "queue_1",
          sessionId: "sess_2",
          reservedRunId: "run_1",
          taskId: "task_1",
          workflowId: "candidate.review",
          handle: "candidate_review",
          status: "completed",
          terminalResultId: "result_1",
        }),
      } as never,
      results: resultStoreWith({
        "sess_2:result_1": {
          record: { resultId: "result_1", sessionId: "sess_2", sessionDataDir: "/tmp/sess_2", inlineSummary: "Wrong session." },
          value: { ok: false },
        },
      }),
    });

    await expect(tools.get_workflow_run!.execute?.({ runId: "run_1" }, {} as never))
      .resolves.toMatchObject({
        status: "failed",
        causeCode: "session_mismatch",
      });
  });

  it("does not expose non-workflow task results through workflow task inspection", async () => {
    const results = resultStoreWith({
      "sess_1:result_1": {
        record: { resultId: "result_1", sessionId: "sess_1", sessionDataDir: "/tmp/sess_1", inlineSummary: "Tool result." },
        value: { secret: true },
      },
    });
    const tools = createWorkflowInspectionTools({
      sessionId: "sess_1",
      workflows: [workflow],
      tasks: taskLedgerWith([
        { taskId: "task_1", sessionId: "sess_1", kind: "tool", status: "completed", terminalResultId: "result_1" },
      ]),
      results,
    });

    await expect(tools.get_workflow_task!.execute?.({ taskId: "task_1", include: ["output"] }, {} as never))
      .resolves.toMatchObject({
        status: "failed",
        causeCode: "invalid_task_kind",
      });
    expect(results.getCalls).toBe(0);
  });
});

function taskLedgerWith(records: readonly any[]) {
  return {
    listTasks: async (filter?: { sessionId?: string }) => records.filter((record) => filter?.sessionId === undefined || record.sessionId === filter.sessionId),
    getTask: async (input: { sessionId: string; taskId: string }) => records.find((record) => record.sessionId === input.sessionId && record.taskId === input.taskId),
  } as never;
}

function workflowQueueWith(records: readonly any[]) {
  return {
    getByRunId: async (input: { sessionId: string; runId: string }) => records.find((record) => record.sessionId === input.sessionId && record.reservedRunId === input.runId),
    getByTaskId: async (input: { sessionId: string; taskId: string }) => records.find((record) => record.sessionId === input.sessionId && record.taskId === input.taskId),
  } as never;
}

function resultStoreWith(records: Record<string, { record: unknown; value: unknown }>): HarnessResultStore & { readonly getCalls: number } {
  let getCalls = 0;
  return {
    get getCalls() {
      return getCalls;
    },
    allocate: async () => {
      throw new Error("allocate should not be called by workflow inspection tests.");
    },
    commit: async () => {
      throw new Error("commit should not be called by workflow inspection tests.");
    },
    getRecord: async (input: { sessionId: string; resultId: string }) => records[`${input.sessionId}:${input.resultId}`]?.record,
    get: async (input: { sessionId: string; resultId: string }) => {
      getCalls += 1;
      return records[`${input.sessionId}:${input.resultId}`];
    },
    getByIdempotencyKey: async () => {
      throw new Error("getByIdempotencyKey should not be called by workflow inspection tests.");
    },
  } as never;
}

function grantStoreWith(): HarnessResultGrantStore & { readonly mintCalls: number } {
  let next = 1;
  let mintCalls = 0;
  return {
    get mintCalls() {
      return mintCalls;
    },
    mintGrant: async (input: unknown) => {
      mintCalls += 1;
      return {
        resultGrantId: `grant_${next++}`,
        createdAt: "2026-06-07T00:00:00.000Z",
        ...(input as Record<string, unknown>),
      };
    },
  } as never;
}

function parseToolInput(tool: unknown, input: unknown): { success: boolean } {
  return (tool as { inputSchema: { safeParse: (value: unknown) => { success: boolean } } }).inputSchema.safeParse(input);
}
