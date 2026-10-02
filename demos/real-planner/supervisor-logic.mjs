import { isDeepStrictEqual } from "node:util";

const CONTINUE_PROMPT_NOTE_FALLBACK =
  "Refine the ranking rationale and return a complete descending ranking for all candidates.";
export const DONE_RETRY_PLANNER_NOTE =
  "Regenerate the workflow so the latest cycle output itself is a complete descending ranking for every candidate exactly once, and do not rely on supervisor-side output rewrites.";
const STUB_SUPERVISOR_CONTINUE_PROMPT_NOTE =
  "Run one more cycle to confirm ranking stability before finalizing.";

export function buildSupervisorCycles({ cycleRuns, cycleSummaries }) {
  return cycleRuns.map((run, index) => ({
    cycleNumber: index + 1,
    runId: run.runId,
    workflowVersionId: run.workflowVersionId,
    status: run.status,
    output: run.output,
    ...(run.error === undefined ? {} : { error: compactErrorSummary(run.error) }),
    ...(cycleSummaries[index] === undefined ? {} : { summary: cycleSummaries[index] }),
  }));
}

export function ensureCanContinueCycle({ cycleNumber, maxCycles }) {
  if (cycleNumber >= maxCycles) {
    throw new Error(
      `Supervisor requested continue at cycle ${cycleNumber}, but max cycles (${maxCycles}) have been reached.`,
    );
  }
}

export function coerceContinuePromptNote(promptNote) {
  if (typeof promptNote === "string") {
    const value = promptNote.trim();
    if (value.length > 0) {
      return value;
    }
  }
  return CONTINUE_PROMPT_NOTE_FALLBACK;
}

export function isValidRankingOutput(value, expectedCandidateIds) {
  if (!Array.isArray(value)) {
    return false;
  }
  if (!Array.isArray(expectedCandidateIds) || expectedCandidateIds.length === 0) {
    return false;
  }
  if (value.length !== expectedCandidateIds.length) {
    return false;
  }

  const expectedIdSet = new Set(expectedCandidateIds);
  if (expectedIdSet.size !== expectedCandidateIds.length) {
    return false;
  }

  const seenIds = new Set();
  let priorScore = Number.POSITIVE_INFINITY;

  for (const entry of value) {
    if (entry === null || typeof entry !== "object") {
      return false;
    }
    if (typeof entry.id !== "string") {
      return false;
    }
    if (!expectedIdSet.has(entry.id) || seenIds.has(entry.id)) {
      return false;
    }
    if (typeof entry.reasoning !== "string") {
      return false;
    }
    if (typeof entry.score !== "number" || !Number.isFinite(entry.score)) {
      return false;
    }
    if (entry.score < 0 || entry.score > 100) {
      return false;
    }
    if (entry.score > priorScore) {
      return false;
    }

    priorScore = entry.score;
    seenIds.add(entry.id);
  }

  return seenIds.size === expectedIdSet.size;
}

export function shouldAcceptDoneDecision({
  latestCycleOutput,
  supervisorFinalOutput,
  expectedCandidateIds,
}) {
  if (!isValidRankingOutput(latestCycleOutput, expectedCandidateIds)) {
    return false;
  }
  if (!isValidRankingOutput(supervisorFinalOutput, expectedCandidateIds)) {
    return false;
  }
  return isDeepStrictEqual(supervisorFinalOutput, latestCycleOutput);
}

export function decideStubSupervisorOutcome({
  cycleNumber,
  maxCycles,
  latestCycleOutput,
  expectedCandidateIds,
}) {
  if (!isValidRankingOutput(latestCycleOutput, expectedCandidateIds)) {
    return {
      kind: "continue",
      promptNote: DONE_RETRY_PLANNER_NOTE,
    };
  }

  const normalizedMaxCycles =
    Number.isInteger(maxCycles) && maxCycles > 0 ? maxCycles : 1;
  const finalizeAtCycle = Math.min(normalizedMaxCycles, 2);
  if (cycleNumber >= finalizeAtCycle) {
    return { kind: "done", finalOutput: latestCycleOutput };
  }

  return {
    kind: "continue",
    promptNote: STUB_SUPERVISOR_CONTINUE_PROMPT_NOTE,
  };
}

export function toFailedCycleRun(error, cycleNumber) {
  if (!isRunFailedErrorLike(error)) {
    return undefined;
  }

  const result = error.result;
  if (
    result !== undefined &&
    result !== null &&
    typeof result === "object" &&
    result.status === "failed" &&
    typeof result.runId === "string" &&
    typeof result.workflowVersionId === "string"
  ) {
    return {
      runId: result.runId,
      workflowVersionId: result.workflowVersionId,
      status: "failed",
      ...(Object.hasOwn(result, "output") ? { output: result.output } : {}),
      error,
    };
  }

  return {
    runId: `run_failed_cycle_${cycleNumber}`,
    workflowVersionId: "unknown",
    status: "failed",
    error,
  };
}

function isRunFailedErrorLike(error) {
  return (
    error !== null &&
    typeof error === "object" &&
    error.name === "RunFailedError"
  );
}

function compactErrorSummary(error) {
  if (typeof error === "string") {
    return error;
  }
  if (error !== null && typeof error === "object") {
    const name = typeof error.name === "string" ? error.name : "Error";
    const message = typeof error.message === "string" ? error.message : undefined;
    if (message !== undefined && message.length > 0) {
      return `${name}: ${message}`;
    }
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return String(error);
}
