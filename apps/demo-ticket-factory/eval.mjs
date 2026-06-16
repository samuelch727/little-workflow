/**
 * Harvest + evaluation helpers for demo-ticket-factory.
 *
 * The coordinator's run output is a small summary; the actual tickets are
 * reconstructed from the durable event log (run_workflow tool results). These
 * helpers are pure so the assembly/validation logic is unit-testable.
 */

import {
  TARGET_DISTRIBUTION,
  formatTicketId,
  validateTicket,
} from "./ticket-schema.mjs";

/** Orchestrator tools whose results carry a sub-run's ticket output. */
const SUBRUN_TOOLS = new Set(["run_workflow", "start_workflow"]);

/**
 * Join harness.tool_call.started, harness.tool_call.succeeded events into sub-run results. Covers both
 * run_workflow and start_workflow (plan+run), since the coordinator may use
 * either to execute a batch.
 *
 * @param {readonly object[]} events Orchestrator session event envelopes.
 * @returns {{ runId: string|undefined, status: string|undefined, output: unknown }[]}
 */
export function harvestRunWorkflowResults(events) {
  const startedByCallId = new Map();
  for (const event of events ?? []) {
    if (event?.type === "harness.tool_call.started") {
      const callId = event.payload?.callId;
      if (callId !== undefined) {
        startedByCallId.set(callId, event.payload?.toolName);
      }
    }
  }
  const results = [];
  for (const event of events ?? []) {
    if (event?.type !== "harness.tool_call.succeeded") continue;
    const callId = event.payload?.callId;
    if (!SUBRUN_TOOLS.has(startedByCallId.get(callId))) continue;
    const result = event.payload?.result ?? {};
    results.push({
      runId: result.runId,
      status: result.status,
      output: result.output,
    });
  }
  return results;
}

/**
 * Flatten the per-batch ticket arrays out of harvested run results.
 *
 * Tolerates the two shapes the worker may emit: a bare array, or an object
 * wrapping the array (e.g. { elements: [...] } / { tickets: [...] }).
 *
 * @param {readonly {output: unknown}[]} results
 * @returns {object[]}
 */
export function collectTickets(results) {
  const tickets = [];
  for (const result of results ?? []) {
    for (const ticket of ticketsFromOutput(result?.output)) {
      tickets.push(ticket);
    }
  }
  return tickets;
}

function ticketsFromOutput(output) {
  if (Array.isArray(output)) return output;
  if (output !== null && typeof output === "object") {
    for (const key of ["elements", "tickets", "items", "data"]) {
      if (Array.isArray(output[key])) return output[key];
    }
  }
  return [];
}

/**
 * Assign global sequential ticket_id values (TICKET-0001, ...).
 *
 * @param {readonly object[]} tickets
 * @returns {object[]}
 */
export function renumberTickets(tickets) {
  return (tickets ?? []).map((ticket, index) => ({
    ...ticket,
    ticket_id: formatTicketId(index + 1),
  }));
}

/**
 * Validate every ticket and collect problems.
 *
 * @param {readonly object[]} tickets
 * @returns {{ total: number, validCount: number, invalidCount: number, problems: {index:number, problems:string[]}[] }}
 */
export function validateDataset(tickets) {
  const problems = [];
  let validCount = 0;
  (tickets ?? []).forEach((ticket, index) => {
    const ticketProblems = validateTicket(ticket);
    if (ticketProblems.length === 0) {
      validCount += 1;
    } else {
      problems.push({ index, problems: ticketProblems });
    }
  });
  const total = tickets?.length ?? 0;
  return { total, validCount, invalidCount: total - validCount, problems };
}

/**
 * Actual vs target distribution shares for one label field.
 *
 * @param {readonly object[]} tickets
 * @param {string} field
 * @param {Record<string, number>} target
 * @returns {{ label: string, actual: number, actualShare: number, targetShare: number }[]}
 */
export function distributionFor(tickets, field, target) {
  const counts = new Map();
  for (const ticket of tickets ?? []) {
    const value = ticket?.[field];
    if (typeof value === "string") {
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
  }
  const total = tickets?.length ?? 0;
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

/**
 * Full distribution report across category/urgency/sentiment.
 *
 * @param {readonly object[]} tickets
 * @returns {Record<string, ReturnType<typeof distributionFor>>}
 */
export function distributionReport(tickets) {
  return {
    category: distributionFor(tickets, "category", TARGET_DISTRIBUTION.category),
    urgency: distributionFor(tickets, "urgency", TARGET_DISTRIBUTION.urgency),
    sentiment: distributionFor(tickets, "sentiment", TARGET_DISTRIBUTION.sentiment),
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
 * Count event types and notable signals (fixer/failure) in a session log.
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
 * Render the answer-key CSV.
 *
 * @param {readonly object[]} tickets
 * @returns {string}
 */
export function toAnswerKeyCsv(tickets) {
  const columns = [
    "ticket_id",
    "category",
    "urgency",
    "sentiment",
    "summary",
    "recommended_action",
  ];
  const lines = [columns.join(",")];
  for (const ticket of tickets ?? []) {
    lines.push(columns.map((column) => csvCell(ticket?.[column])).join(","));
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
