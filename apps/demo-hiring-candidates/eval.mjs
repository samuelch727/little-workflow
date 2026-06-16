/**
 * Harvest + evaluation helpers for demo-hiring-candidates.
 *
 * The orchestrator's run output is a small summary; the actual candidates are
 * reconstructed from the durable event log (run_workflow tool results). These
 * helpers are pure so the assembly/validation logic is unit-testable.
 */

import { TARGET_DISTRIBUTION, formatCandidateId, validateCandidate } from "./candidate-schema.mjs";

/** Orchestrator tools whose results carry a sub-run's candidate output. */
const SUBRUN_TOOLS = new Set(["run_workflow", "start_workflow"]);

/**
 * Join harness.tool_call.started, harness.tool_call.succeeded events into sub-run results.
 *
 * @param {readonly object[]} events Orchestrator session event envelopes.
 * @returns {{ runId: string|undefined, status: string|undefined, output: unknown, outputRef: string|undefined, outputPath: string|undefined, outputSummary: unknown, artifacts: unknown, args: unknown }[]}
 */
export function harvestRunWorkflowResults(events) {
  const startedByCallId = new Map();
  for (const event of events ?? []) {
    if (event?.type === "harness.tool_call.started") {
      const callId = event.payload?.callId;
      if (callId !== undefined) {
        startedByCallId.set(callId, {
          toolName: event.payload?.toolName,
          args: event.payload?.args,
        });
      }
    }
  }
  const results = [];
  for (const event of events ?? []) {
    if (event?.type !== "harness.tool_call.succeeded") continue;
    const callId = event.payload?.callId;
    const started = startedByCallId.get(callId);
    if (!SUBRUN_TOOLS.has(started?.toolName)) continue;
    const result = event.payload?.result ?? {};
    results.push({
      runId: result.runId,
      status: result.status,
      output: result.output,
      outputRef: result.outputRef,
      outputPath: result.outputPath,
      outputSummary: result.outputSummary,
      artifacts: result.artifacts,
      args: started.args,
    });
  }
  return results;
}

/**
 * Keep at most one harvested result for each batch startIndex, preferring a
 * completed result over a failed earlier attempt.
 *
 * @param {readonly { runId?: string, status?: string, output: unknown, args?: unknown }[]} results
 */
export function dedupeRunWorkflowResults(results) {
  const deduped = [];
  const indexByBatchKey = new Map();
  for (const result of results ?? []) {
    const batchKey = batchIdentity(result);
    if (batchKey === undefined) {
      deduped.push(result);
      continue;
    }

    const existingIndex = indexByBatchKey.get(batchKey);
    if (existingIndex === undefined) {
      indexByBatchKey.set(batchKey, deduped.length);
      deduped.push(result);
      continue;
    }

    if (shouldReplaceBatchResult(deduped[existingIndex], result)) {
      deduped[existingIndex] = result;
    }
  }
  return deduped;
}

function batchIdentity(result) {
  const input = result?.args?.input;
  const startIndex = input?.startIndex;
  if (Number.isFinite(startIndex)) {
    return `startIndex:${startIndex}`;
  }
  return undefined;
}

function shouldReplaceBatchResult(existing, candidate) {
  if (existing?.status !== "completed" && candidate?.status === "completed") {
    return true;
  }
  return existing?.output === undefined && candidate?.output !== undefined;
}

function candidatesFromOutput(output) {
  if (Array.isArray(output)) return output;
  if (output !== null && typeof output === "object") {
    for (const key of ["elements", "candidates", "items", "data"]) {
      if (Array.isArray(output[key])) return output[key];
    }
  }
  return [];
}

/**
 * Flatten the per-batch candidate arrays out of harvested run results.
 *
 * @param {readonly {output: unknown}[]} results
 * @returns {object[]}
 */
export function collectCandidates(results) {
  const candidates = [];
  for (const result of results ?? []) {
    for (const candidate of candidatesFromOutput(result?.output)) {
      candidates.push(candidate);
    }
  }
  return candidates;
}

/**
 * Assign global sequential candidate_id values (CAND-0001, ...).
 *
 * @param {readonly object[]} candidates
 * @returns {object[]}
 */
export function renumberCandidates(candidates) {
  return (candidates ?? []).map((candidate, index) => ({
    ...candidate,
    candidate_id: formatCandidateId(index + 1),
  }));
}

/**
 * Keep the requested number of candidates when a model returns a bonus item.
 *
 * @param {readonly object[]} candidates
 * @param {number} requestedCount
 * @returns {object[]}
 */
export function limitCandidateCount(candidates, requestedCount) {
  if (!Number.isInteger(requestedCount) || requestedCount < 0) {
    return [...(candidates ?? [])];
  }
  return [...(candidates ?? [])].slice(0, requestedCount);
}

/**
 * Validate every candidate and collect problems.
 *
 * @param {readonly object[]} candidates
 * @returns {{ total: number, validCount: number, invalidCount: number, problems: {index:number, problems:string[]}[] }}
 */
export function validateDataset(candidates) {
  const problems = [];
  let validCount = 0;
  (candidates ?? []).forEach((candidate, index) => {
    const candidateProblems = validateCandidate(candidate);
    if (candidateProblems.length === 0) {
      validCount += 1;
    } else {
      problems.push({ index, problems: candidateProblems });
    }
  });
  const total = candidates?.length ?? 0;
  return { total, validCount, invalidCount: total - validCount, problems };
}

/**
 * Actual vs target distribution shares for one label field.
 *
 * @param {readonly object[]} candidates
 * @param {string} field
 * @param {Record<string, number>} target
 */
export function distributionFor(candidates, field, target) {
  const counts = new Map();
  for (const candidate of candidates ?? []) {
    const value = candidate?.[field];
    if (typeof value === "string") {
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
  }
  const total = candidates?.length ?? 0;
  const labels = new Set([...Object.keys(target ?? {}), ...counts.keys()]);
  return [...labels].sort().map((label) => {
    const actual = counts.get(label) ?? 0;
    return {
      label,
      actual,
      actualShare: total === 0 ? 0 : actual / total,
      targetShare: target?.[label] ?? 0,
    };
  });
}

/** Full distribution report across seniority/source/status. */
export function distributionReport(candidates) {
  return {
    seniority: distributionFor(candidates, "seniority", TARGET_DISTRIBUTION.seniority),
    source: distributionFor(candidates, "source", TARGET_DISTRIBUTION.source),
    status: distributionFor(candidates, "status", TARGET_DISTRIBUTION.status),
  };
}

/**
 * Sum model token usage from harness.model.responded events.
 *
 * @param {readonly object[]} events
 * @returns {{ inputTokens: number, outputTokens: number }}
 */
export function sumUsageFromEvents(events) {
  let inputTokens = 0;
  let outputTokens = 0;
  for (const event of events ?? []) {
    if (event?.type !== "harness.model.responded") continue;
    const usage = event.payload?.response?.usage ?? {};
    inputTokens += Number(usage.inputTokens) || 0;
    outputTokens += Number(usage.outputTokens) || 0;
  }
  return { inputTokens, outputTokens };
}

/**
 * Count event types and notable signals in a session log.
 *
 * @param {readonly object[]} events
 * @returns {{ byType: Record<string, number>, fixerInvocations: number, toolFailures: number }}
 */
export function summarizeEvents(events) {
  const byType = {};
  let fixerInvocations = 0;
  let toolFailures = 0;
  for (const event of events ?? []) {
    const type = event?.type ?? "unknown";
    byType[type] = (byType[type] ?? 0) + 1;
    if (typeof type === "string" && type.includes("Fix")) fixerInvocations += 1;
    if (type === "harness.tool_call.failed") toolFailures += 1;
  }
  return { byType, fixerInvocations, toolFailures };
}

/**
 * Render a compact CSV summary of the candidate pool.
 *
 * @param {readonly object[]} candidates
 * @returns {string}
 */
export function toCandidateCsv(candidates) {
  const columns = [
    "candidate_id",
    "full_name",
    "seniority",
    "source",
    "status",
    "match_score",
    "years_experience",
    "desired_salary_usd",
    "location",
  ];
  const lines = [columns.join(",")];
  for (const candidate of candidates ?? []) {
    lines.push(columns.map((column) => csvCell(candidate?.[column])).join(","));
  }
  return lines.join("\n") + "\n";
}

function csvCell(value) {
  const text = value === undefined || value === null ? "" : String(value);
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}
