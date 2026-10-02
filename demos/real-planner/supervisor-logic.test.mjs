import test from "node:test";
import assert from "node:assert/strict";
import {
  decideStubSupervisorOutcome,
  DONE_RETRY_PLANNER_NOTE,
  buildSupervisorCycles,
  coerceContinuePromptNote,
  ensureCanContinueCycle,
  isValidRankingOutput,
  shouldAcceptDoneDecision,
  toFailedCycleRun,
} from "./supervisor-logic.mjs";

test("buildSupervisorCycles attaches summary to the matching cycle", () => {
  const cycles = buildSupervisorCycles({
    cycleRuns: [
      { runId: "run-1", workflowVersionId: "v1", status: "completed", output: [{ id: "a", score: 90, reasoning: "x" }] },
      { runId: "run-2", workflowVersionId: "v1", status: "completed", output: [{ id: "a", score: 88, reasoning: "y" }] },
    ],
    cycleSummaries: ["focus on calibration"],
  });

  assert.equal(cycles[0]?.summary, "focus on calibration");
  assert.equal(cycles[1]?.summary, undefined);
});

test("buildSupervisorCycles includes compact error summary when a cycle fails", () => {
  const cycles = buildSupervisorCycles({
    cycleRuns: [
      {
        runId: "run-1",
        workflowVersionId: "v1",
        status: "failed",
        output: null,
        error: new Error("tool call failed"),
      },
    ],
    cycleSummaries: [],
  });

  assert.equal(cycles[0]?.error, "Error: tool call failed");
});

test("ensureCanContinueCycle throws when continue is requested at max cycle", () => {
  assert.throws(
    () => ensureCanContinueCycle({ cycleNumber: 3, maxCycles: 3 }),
    /max cycles/u,
  );
});

test("coerceContinuePromptNote falls back when prompt note is missing", () => {
  const value = coerceContinuePromptNote(undefined);
  assert.match(value, /Refine/i);
});

test("isValidRankingOutput requires exact candidate ids and descending scores", () => {
  const expectedCandidateIds = ["a", "b", "c"];

  const valid = isValidRankingOutput(
    [
      { id: "a", score: 98, reasoning: "best fit" },
      { id: "b", score: 90, reasoning: "good fit" },
      { id: "c", score: 81, reasoning: "ok fit" },
    ],
    expectedCandidateIds,
  );
  assert.equal(valid, true);

  const wrongOrder = isValidRankingOutput(
    [
      { id: "a", score: 88, reasoning: "best fit" },
      { id: "b", score: 97, reasoning: "good fit" },
      { id: "c", score: 81, reasoning: "ok fit" },
    ],
    expectedCandidateIds,
  );
  assert.equal(wrongOrder, false);

  const duplicateId = isValidRankingOutput(
    [
      { id: "a", score: 98, reasoning: "best fit" },
      { id: "a", score: 90, reasoning: "good fit" },
      { id: "c", score: 81, reasoning: "ok fit" },
    ],
    expectedCandidateIds,
  );
  assert.equal(duplicateId, false);
});

test("shouldAcceptDoneDecision rejects supervisor output that does not match latest cycle output", () => {
  const expectedCandidateIds = ["a", "b"];
  const latestCycleOutput = [
    { id: "a", score: 92, reasoning: "best fit" },
  ];
  const supervisorFinalOutput = [
    { id: "a", score: 92, reasoning: "best fit" },
    { id: "b", score: 82, reasoning: "strong fit" },
  ];

  const accepted = shouldAcceptDoneDecision({
    latestCycleOutput,
    supervisorFinalOutput,
    expectedCandidateIds,
  });

  assert.equal(accepted, false);
});

test("shouldAcceptDoneDecision rejects when both outputs are valid but differ", () => {
  const expectedCandidateIds = ["a", "b"];
  const latestCycleOutput = [
    { id: "a", score: 93, reasoning: "best fit" },
    { id: "b", score: 84, reasoning: "strong fit" },
  ];
  const supervisorFinalOutput = [
    { id: "a", score: 93, reasoning: "best fit" },
    { id: "b", score: 84, reasoning: "different rationale text" },
  ];

  const accepted = shouldAcceptDoneDecision({
    latestCycleOutput,
    supervisorFinalOutput,
    expectedCandidateIds,
  });

  assert.equal(accepted, false);
});

test("done-retry note is planner-actionable", () => {
  assert.match(DONE_RETRY_PLANNER_NOTE, /Regenerate/i);
  assert.match(DONE_RETRY_PLANNER_NOTE, /latest cycle output/i);
});

test("toFailedCycleRun converts RunFailedError-like data into a cycle record", () => {
  const err = {
    name: "RunFailedError",
    message: "step exploded",
    causeCode: "step_failed",
    result: {
      runId: "run-failed-1",
      workflowVersionId: "wf-v1",
      status: "failed",
      output: { partial: true },
    },
  };

  const cycle = toFailedCycleRun(err, 2);
  assert.deepEqual(cycle, {
    runId: "run-failed-1",
    workflowVersionId: "wf-v1",
    status: "failed",
    output: { partial: true },
    error: err,
  });
});

test("decideStubSupervisorOutcome continues on cycle 1 and finalizes on cycle 2", () => {
  const expectedCandidateIds = ["a", "b"];
  const latestCycleOutput = [
    { id: "a", score: 93, reasoning: "best fit" },
    { id: "b", score: 84, reasoning: "strong fit" },
  ];

  const cycle1 = decideStubSupervisorOutcome({
    cycleNumber: 1,
    maxCycles: 3,
    latestCycleOutput,
    expectedCandidateIds,
  });
  assert.equal(cycle1.kind, "continue");
  assert.equal(typeof cycle1.promptNote, "string");
  assert.ok(cycle1.promptNote.length > 0);

  const cycle2 = decideStubSupervisorOutcome({
    cycleNumber: 2,
    maxCycles: 3,
    latestCycleOutput,
    expectedCandidateIds,
  });
  assert.equal(cycle2.kind, "done");
  assert.deepEqual(cycle2.finalOutput, latestCycleOutput);
});

test("decideStubSupervisorOutcome requests planner retry note when output is invalid", () => {
  const decision = decideStubSupervisorOutcome({
    cycleNumber: 1,
    maxCycles: 3,
    latestCycleOutput: [{ id: "a", score: 50, reasoning: "partial" }],
    expectedCandidateIds: ["a", "b"],
  });

  assert.deepEqual(decision, {
    kind: "continue",
    promptNote: DONE_RETRY_PLANNER_NOTE,
  });
});

import { describe, it } from "node:test";
import { superviseDecideNextCycle } from "./run.mjs";

describe("superviseDecideNextCycle (v6 structured output)", () => {
  it("passes output: Output.object to streamText and returns parsed decision", async () => {
    const captured = { request: undefined };
    const fakeStreamText = (request) => {
      captured.request = request;
      const decision = { kind: "continue", promptNote: "more" };
      return {
        text: Promise.resolve(JSON.stringify(decision)),
        usage: Promise.resolve({ inputTokens: 1, outputTokens: 1 }),
        output: Promise.resolve(decision),
      };
    };
    const decision = await superviseDecideNextCycle({
      model: { providerId: "demo", modelId: "demo" },
      cycles: [],
      goalDescription: "test",
      latestCycleOutput: [],
      expectedCandidateIds: ["c1"],
      streamText: fakeStreamText,
    });
    assert.ok(captured.request, "streamText was called");
    assert.ok(captured.request.output, "request.output (structured) is set");
    assert.equal(decision.kind, "continue");
  });

  it("downgrades a hallucinated done to continue when finalOutput doesn't match latestCycleOutput", async () => {
    const fakeStreamText = () => {
      const decision = { kind: "done", finalOutput: [{ id: "wrong" }] };
      return {
        text: Promise.resolve(JSON.stringify(decision)),
        usage: Promise.resolve({ inputTokens: 1, outputTokens: 1 }),
        output: Promise.resolve(decision),
      };
    };
    const decision = await superviseDecideNextCycle({
      model: { providerId: "demo", modelId: "demo" },
      cycles: [],
      goalDescription: "test",
      latestCycleOutput: [{ id: "c1" }],
      expectedCandidateIds: ["c1"],
      streamText: fakeStreamText,
    });
    assert.equal(decision.kind, "continue", "hallucinated done must downgrade");
    assert.ok(typeof decision.promptNote === "string" && decision.promptNote.length > 0);
  });
});
