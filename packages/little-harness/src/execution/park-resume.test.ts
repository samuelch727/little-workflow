import { describe, expect, it } from "vitest";
import type { HarnessContinuationRecord, HarnessContinuationWaitRecord } from "../tasks/ledger.js";
import {
  createContinuationId,
  createParkedToolResult,
  markContinuationWaitTerminal,
  shouldEnqueueResumeForLateCompletion,
  shouldResumeProviderStep,
} from "./park-resume.js";

describe("park/resume primitives", () => {
  it("derives a stable path-safe continuation id from immutable park identity", () => {
    const input = {
      sessionId: "sess_1",
      originTurnId: "turn_1",
      modelStepId: "step_2",
      parkSequence: 1,
    };

    expect(createContinuationId(input)).toBe(createContinuationId(input));
    expect(createContinuationId(input)).toMatch(/^cont_[0-9a-v]+$/u);
  });

  it("creates a compact parked tool result", () => {
    expect(createParkedToolResult({
      continuationId: "cont_1",
      pending: { taskIds: ["task_1"], mode: "all" },
    })).toEqual({
      status: "parked",
      continuationId: "cont_1",
      pending: { taskIds: ["task_1"], mode: "all" },
    });
  });

  it("resumes a provider step only after every parked tool call is terminal", () => {
    expect(shouldResumeProviderStep({
      parkedToolCallIds: ["tool_1", "tool_2"],
      terminalResultsByToolCallId: { tool_1: ["result_1"] },
    })).toBe(false);
    expect(shouldResumeProviderStep({
      parkedToolCallIds: ["tool_1", "tool_2"],
      terminalResultsByToolCallId: { tool_1: ["result_1"], tool_2: ["result_2"] },
    })).toBe(true);
  });

  it("resumes one provider step after heterogeneous waits finish across restart", () => {
    const continuation = continuationWithWaits([
      wait("wait_tasks", "tool_tasks", { kind: "tasks", taskIds: ["task_1"], mode: "all" }),
      wait("wait_workflow", "tool_workflow", { kind: "workflow-run", taskId: "task_2", reservedRunId: "run_2", queueId: "queue_2" }),
    ]);

    const afterTask = markContinuationWaitTerminal(continuation, {
      waitId: "wait_tasks",
      terminalResultIds: ["result_tasks"],
      terminalAt: "2026-06-22T00:00:01.000Z",
    });
    expect(shouldResumeProviderStep(afterTask)).toBe(false);

    const rehydrated = JSON.parse(JSON.stringify(afterTask)) as HarnessContinuationRecord;
    const afterWorkflow = markContinuationWaitTerminal(rehydrated, {
      waitId: "wait_workflow",
      terminalResultIds: ["result_workflow"],
      terminalAt: "2026-06-22T00:00:02.000Z",
    });

    expect(shouldResumeProviderStep(afterWorkflow)).toBe(true);
    expect(afterWorkflow.terminalResultsByToolCallId).toEqual({
      tool_tasks: ["result_tasks"],
      tool_workflow: ["result_workflow"],
    });
  });

  it("does not enqueue a second resume after an await_tasks timeout closes the continuation", () => {
    const continuation: HarnessContinuationRecord = {
      continuationId: "cont_1",
      sessionId: "sess_1",
      originTurnId: "turn_1",
      parkedToolCallIds: ["tool_await"],
      terminalResultsByToolCallId: {},
      state: "resume_enqueued",
      createdAt: "2026-06-22T00:00:00.000Z",
      updatedAt: "2026-06-22T00:00:01.000Z",
      timeoutAt: "2026-06-22T00:00:01.000Z",
      waits: [
        {
          waitId: "wait_1",
          parkedToolCallId: "tool_await",
          predicate: { kind: "tasks", taskIds: ["task_1"], mode: "all" },
          state: "timed_out",
          outcomesById: {},
          terminalResultIds: [],
          terminalAt: "2026-06-22T00:00:01.000Z",
        },
      ],
    };

    expect(shouldEnqueueResumeForLateCompletion(continuation, "task_1")).toBe(false);
  });
});

function continuationWithWaits(waits: readonly HarnessContinuationWaitRecord[]): HarnessContinuationRecord {
  return {
    continuationId: "cont_1",
    sessionId: "sess_1",
    originTurnId: "turn_1",
    modelStepId: "step_1",
    parkedToolCallIds: waits.map((candidate) => candidate.parkedToolCallId),
    waits,
    terminalResultsByToolCallId: {},
    state: "open",
    createdAt: "2026-06-22T00:00:00.000Z",
    updatedAt: "2026-06-22T00:00:00.000Z",
  };
}

function wait(
  waitId: string,
  parkedToolCallId: string,
  predicate: HarnessContinuationWaitRecord["predicate"],
): HarnessContinuationWaitRecord {
  return {
    waitId,
    parkedToolCallId,
    predicate,
    state: "open",
    outcomesById: {},
    terminalResultIds: [],
  };
}
