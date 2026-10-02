import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateHarness, loadHarness, type HarnessEvent, type HarnessSession } from "little-harness";
import { investigationState, resetInvestigationState, type ProposalBody } from "./littledb-api";

/**
 * One dreamer investigation, as a function.
 *
 * `run.mjs` is a thin CLI over this, and the tests drive the same function in-process. That
 * split is not cosmetic: the model seam lives on `globalThis` (see `env.ts`), so a test can
 * only install a mock model for an investigation that runs in its own process — a spawned
 * `node run.mjs` could never receive one.
 */

const agentDir = dirname(fileURLToPath(import.meta.url));

export type ToolCallRecord = {
  readonly type: "harness.tool_call.succeeded" | "harness.tool_call.failed";
  readonly toolName?: string | undefined;
  readonly toolCallId?: string | undefined;
  readonly step?: string | undefined;
};

export type InvestigationResult = {
  readonly text: string;
  readonly session: HarnessSession;
  readonly toolCalls: readonly ToolCallRecord[];
  /** `--dry-run` only: the bodies that WOULD have been posted. */
  readonly dryRunSubmissions: readonly ProposalBody[];
  /** Proposals the control plane accepted, with their ids. */
  readonly submittedProposals: ReadonlyArray<{
    readonly harness: string;
    readonly proposalId: string | undefined;
    readonly body: ProposalBody;
  }>;
  /** POST attempts that actually reached the control plane, by harness slug. */
  readonly submitAttempts: Record<string, number>;
};

export type RunInvestigationOptions = {
  /** Harness slug to investigate. */
  readonly harness: string;
  /** littleDB control-plane base URL. Defaults to `LITTLEDB_URL`. */
  readonly controlPlaneUrl?: string;
  /** Build the proposal body, print it, submit nothing. */
  readonly dryRun?: boolean;
  /** Harness session id. Defaults to a timestamped one. */
  readonly sessionId?: string;
};

function briefing(slug: string): string {
  return [
    `Investigate the harness \`${slug}\`.`,
    "",
    "Work the investigation end to end: pull the evidence pack, sweep incident cards over",
    "every failure run, cluster them, identify the dominant failure mode, read the base",
    "config, and submit the smallest config patch that addresses that cluster — with at",
    "least two failure samples quoting the users verbatim.",
  ].join("\n");
}

export async function runInvestigation(
  options: RunInvestigationOptions,
): Promise<InvestigationResult> {
  // The tools read their configuration from the environment, because agent-folder discovery
  // constructs them with no arguments.
  process.env.DREAMER_HARNESS = options.harness;
  if (options.controlPlaneUrl !== undefined) {
    process.env.DREAMER_CONTROL_PLANE_URL = options.controlPlaneUrl;
  }
  if (options.dryRun === true) {
    process.env.DREAMER_DRY_RUN = "1";
  } else {
    delete process.env.DREAMER_DRY_RUN;
  }

  resetInvestigationState();
  const harness = await loadHarness(agentDir);

  const toolCalls: ToolCallRecord[] = [];
  const result = await generateHarness({
    harness,
    session: options.sessionId ?? `dream-${options.harness}-${Date.now()}`,
    messages: [
      {
        id: "brief-1",
        role: "user",
        parts: [{ type: "text", text: briefing(options.harness) }],
      },
    ],
    onEvent: (event: HarnessEvent) => {
      // `onEvent` receives the TRACE view of an event: no `payload`, but `metadata` carries
      // toolName / toolCallId / stepId (packages/little-harness/src/execution/tool-events.ts).
      if (
        event.type !== "harness.tool_call.succeeded" &&
        event.type !== "harness.tool_call.failed"
      ) {
        return;
      }
      toolCalls.push({
        type: event.type,
        toolName: asString(event.metadata?.toolName),
        toolCallId: asString(event.metadata?.toolCallId),
        step: asString(event.metadata?.stepId),
      });
    },
  });

  const state = investigationState();
  return {
    text: result.text,
    session: result.session,
    toolCalls,
    dryRunSubmissions: [...state.dryRunSubmissions],
    submittedProposals: [...state.submittedProposals],
    submitAttempts: Object.fromEntries(state.submitAttempts),
  };
}

/** A one-line-per-call summary of what the agent actually did. */
export function formatToolTrace(toolCalls: readonly ToolCallRecord[]): {
  readonly lines: readonly string[];
  readonly totals: string;
} {
  const counts = new Map<string, number>();
  const lines = toolCalls.map((call, index) => {
    const name = call.toolName ?? "(unnamed)";
    counts.set(name, (counts.get(name) ?? 0) + 1);
    const verdict = call.type === "harness.tool_call.failed" ? "FAILED" : "ok";
    return `  ${String(index + 1).padStart(3)}. ${name}  ${verdict}${call.step === undefined ? "" : `  [${call.step}]`}`;
  });
  const totals = [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([name, n]) => `${name} x${n}`)
    .join(", ");
  return { lines, totals };
}

/** The agent folder, so `run.mjs` and the tests agree on where it is. */
export const dreamerAgentDir = agentDir;

/** The demo root — `run.mjs` chdirs here so jiti resolves the agent's bare imports. */
export const dreamerDemoRoot = join(agentDir, "..", "..");

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
