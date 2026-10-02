import { type UsageTotals, cacheHitShare, emptyUsageTotals, mergeUsageTotals } from "./pricing.js";
import type { MaterializedRunState } from "./world.js";

/** Per-step line of a run cost report. */
export type RunReportRow = {
  readonly stepPath: string;
  readonly status: string;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  /** Share of this row's input tokens served from cache, in `[0, 1]`. */
  readonly cacheHitShare: number;
  /** Real dollars, or `null` when nothing in this row could be priced. */
  readonly costUsd: number | null;
  readonly pricedCalls: number;
  readonly unpricedCalls: number;
};

export type RunReport = {
  readonly runId: string;
  readonly status: MaterializedRunState["status"];
  readonly steps: readonly RunReportRow[];
  /**
   * Model calls recorded without a `stepPath` (for example a run-level orchestrator
   * session). Present so the per-step rows and the run total always reconcile.
   */
  readonly unattributed?: RunReportRow;
  readonly total: RunReportRow;
  /** True when any recorded model call had no registry pricing. */
  readonly hasUnpricedCalls: boolean;
};

/** Builds a per-step tokens / cache-hit / dollars report from materialized run state. */
export function runReport(state: MaterializedRunState): RunReport {
  const steps = Object.values(state.steps)
    .map((step) => row(step.stepPath, step.status, step.usage))
    .sort((a, b) => a.stepPath.localeCompare(b.stepPath));

  const attributed = Object.values(state.steps).reduce<UsageTotals>(
    (acc, step) => mergeUsageTotals(acc, step.usage),
    emptyUsageTotals(),
  );
  const unattributed = residualUsage(state.usage, attributed);

  return {
    runId: state.runId,
    status: state.status,
    steps,
    ...(unattributed === undefined
      ? {}
      : { unattributed: row("(unattributed)", state.status, unattributed) }),
    total: row("TOTAL", state.status, state.usage),
    hasUnpricedCalls: state.usage.unpricedCalls > 0,
  };
}

/** Renders a run report as a fixed-width terminal table. */
export function formatRunReport(report: RunReport): string {
  const rows = [
    ...report.steps,
    ...(report.unattributed === undefined ? [] : [report.unattributed]),
  ];
  const header = ["STEP", "IN", "CACHED", "CACHE%", "OUT", "CALLS", "COST (USD)"];
  const body = [...rows, report.total].map((entry) => [
    entry.stepPath,
    String(entry.inputTokens),
    String(entry.cachedInputTokens),
    formatShare(entry.cacheHitShare),
    String(entry.outputTokens),
    formatCalls(entry),
    formatCost(entry.costUsd),
  ]);

  const widths = header.map((label, column) =>
    Math.max(label.length, ...body.map((line) => (line[column] ?? "").length)),
  );
  const line = (cells: readonly string[]): string =>
    cells
      .map((cell, column) =>
        // Left-align the step name, right-align the numeric columns.
        column === 0 ? cell.padEnd(widths[column] as number) : cell.padStart(widths[column] as number),
      )
      .join("  ")
      .trimEnd();

  const out = [
    `Run ${report.runId} (${report.status})`,
    "",
    line(header),
    widths.map((width) => "-".repeat(width)).join("  "),
    ...body.slice(0, -1).map(line),
  ];
  if (body.length > 1) {
    out.push(widths.map((width) => "-".repeat(width)).join("  "));
  }
  out.push(line(body.at(-1) as readonly string[]));
  if (report.hasUnpricedCalls) {
    out.push(
      "",
      `Note: ${report.total.unpricedCalls} model call(s) had no registry pricing and are excluded from the cost above.`,
    );
  }
  out.push("");
  return out.join("\n");
}

function row(stepPath: string, status: string, usage: UsageTotals): RunReportRow {
  return {
    stepPath,
    status,
    inputTokens: usage.inputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    outputTokens: usage.outputTokens,
    reasoningTokens: usage.reasoningTokens,
    cacheHitShare: cacheHitShare(usage),
    costUsd: usage.costUsd,
    pricedCalls: usage.pricedCalls,
    unpricedCalls: usage.unpricedCalls,
  };
}

/**
 * Difference between run totals and the sum of per-step totals — the model calls that
 * were recorded without a step attribution. Returns `undefined` when everything is
 * attributed.
 */
function residualUsage(total: UsageTotals, attributed: UsageTotals): UsageTotals | undefined {
  const pricedCalls = total.pricedCalls - attributed.pricedCalls;
  const unpricedCalls = total.unpricedCalls - attributed.unpricedCalls;
  if (pricedCalls <= 0 && unpricedCalls <= 0) {
    return undefined;
  }
  return {
    inputTokens: total.inputTokens - attributed.inputTokens,
    outputTokens: total.outputTokens - attributed.outputTokens,
    cachedInputTokens: total.cachedInputTokens - attributed.cachedInputTokens,
    reasoningTokens: total.reasoningTokens - attributed.reasoningTokens,
    costUsd:
      pricedCalls === 0 ? (unpricedCalls === 0 ? 0 : null) : (total.costUsd ?? 0) - (attributed.costUsd ?? 0),
    pricedCalls,
    unpricedCalls,
  };
}

function formatShare(share: number): string {
  return `${(share * 100).toFixed(1)}%`;
}

function formatCalls(entry: RunReportRow): string {
  return entry.unpricedCalls === 0
    ? String(entry.pricedCalls)
    : `${entry.pricedCalls}+${entry.unpricedCalls}?`;
}

/**
 * Renders a cost so the three cases stay distinguishable at a glance:
 *
 * - `n/a` — could not be computed (no registry pricing).
 * - `0.000000` — a genuine zero-dollar total.
 * - `<0.000001` — real money, too small to show at six decimals. One `gpt-4o-mini` call
 *   with a single input token costs $0.00000015, which `toFixed(6)` renders as
 *   `0.000000` — indistinguishable from a step that spent nothing.
 *
 * The threshold is read off `toFixed` itself rather than restated as a literal, because
 * `toFixed(6)` rounds at 0.0000005, not 0.000001. JSON output is unaffected: this is a
 * table-rendering concern only, and `RunReportRow.costUsd` stays exact.
 */
function formatCost(costUsd: number | null): string {
  if (costUsd === null) {
    return "n/a";
  }
  const rendered = costUsd.toFixed(6);
  return costUsd > 0 && Number(rendered) === 0 ? "<0.000001" : rendered;
}
