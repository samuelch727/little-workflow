import { createHash } from "node:crypto";
import { jsonSchema, tool, type ToolExecutionOptions, type ToolSet } from "ai";
import type { HarnessChildCapabilities, HarnessWorkflowExecution, HarnessWorkflowRunContext } from "../workflows.js";
import type { ResolvedDynamicWorkflows } from "./config.js";
import { dynamicAllowedCapabilities } from "../execution/turn-tools.js";
import {
  runWithWorkflowRunSlot,
  WorkflowQueueOverflowError,
  type WorkflowRunConcurrencyBudgets,
} from "../utils/workflow-concurrency.js";
import {
  AUTHORED_PLANS_HARNESS_DIR,
  searchAuthoredPlans,
  writeAuthoredPlan,
  type AuthoredPlanRecord,
} from "./authored-plans-store.js";

/**
 * Config for {@link createDynamicWorkflowTools}. Threaded by Task 11's turn-tools wiring.
 *
 * `model` is the RAW harness provider model (NOT pre-wrapped): it is placed verbatim under
 * `capabilities.models.default`, and the factory's `modelsFromContext` wraps it via
 * `model(raw, { id: slot })`. `bashCapability` is an opaque, already-normalized
 * `BashCapabilities`: Task 11 owns converting the runtime `network` field
 * (`boolean | HarnessNetworkPolicy`) into `BashNetworkCapabilities` before passing it here;
 * this tool only forwards it under `capabilities.bash.capabilities`.
 */
export type DynamicWorkflowToolsConfig = {
  readonly sessionId: string;
  readonly turnId: string;
  readonly originTurnId: string;
  readonly dataDir: string;
  readonly dynamic: ResolvedDynamicWorkflows;
  readonly parentSnapshot: {
    tools?: Readonly<Record<string, unknown>>;
    mcpTools?: Readonly<Record<string, unknown>>;
    bash?: Readonly<Record<string, unknown>>;
  };
  readonly model: unknown;
  readonly bashCapability?: unknown;
  readonly authoredPlansHarnessDir?: string;
  readonly nowIso?: () => string;
  readonly abortSignal?: AbortSignal | undefined;
  /**
   * The session's workflow-run admission budgets. A one-shot plan is a workflow run, so it is
   * charged against the same session-scoped `maxConcurrentWorkflowRuns` slot pool as the
   * configured workflow tools — 50 parallel `run_ad_hoc_plan` calls would otherwise be 50
   * concurrent runs. See `utils/workflow-concurrency.ts`.
   */
  readonly budgets?: WorkflowRunConcurrencyBudgets | undefined;
};

const RUN_INPUT = jsonSchema<{
  purpose: string;
  reasonConfiguredWorkflowsDoNotFit?: string;
  plan: unknown;
  input: unknown;
  outputSchema: unknown;
}>({
  type: "object",
  properties: {
    purpose: { type: "string" },
    reasonConfiguredWorkflowsDoNotFit: { type: "string" },
    plan: { type: "object", additionalProperties: true },
    input: {},
    outputSchema: {},
  },
  required: ["purpose", "plan", "input", "outputSchema"],
  additionalProperties: false,
});

const SEARCH_INPUT = jsonSchema<{ query: string }>({
  type: "object",
  properties: { query: { type: "string" } },
  required: ["query"],
  additionalProperties: false,
});

/**
 * The subset of the harness `FileWriter` the authored-plans store needs. Derived from the
 * store's own parameter type so the two stay in lock-step; pulled off `executeOptions.files`
 * (the same field the memory `remember` tool reads — see `memory/memory.ts`).
 */
type StoreFiles = Parameters<typeof writeAuthoredPlan>[0];

export function createDynamicWorkflowTools(config: DynamicWorkflowToolsConfig): ToolSet {
  const harnessDir = config.authoredPlansHarnessDir ?? AUTHORED_PLANS_HARNESS_DIR;
  const nowIso = config.nowIso ?? (() => new Date().toISOString());

  return {
    run_ad_hoc_plan: tool({
      description:
        "Author and run a ONE-SHOT plan for a request no configured workflow fits. The plan is a step-DAG whose steps are `tool.call` (invoke one of your own tools/MCP handles) or `ai.generate` (a model step, optionally with agentic bash) — no other step kinds are supported. It runs once, is not added to the workflow library, and is remembered for later recall via search_authored_plans. Provide `purpose`, `plan` (steps + output.from naming the terminal step), `input`, and `outputSchema`.",
      inputSchema: RUN_INPUT,
      execute: async (args, executeOptions: ToolExecutionOptions<unknown> & { files?: unknown }) => {
        const allowed = dynamicAllowedCapabilities(config.parentSnapshot, config.dynamic.exclude);
        const compiled = config.dynamic.factory.compile({
          purpose: args.purpose,
          ...(args.reasonConfiguredWorkflowsDoNotFit
            ? { reasonConfiguredWorkflowsDoNotFit: args.reasonConfiguredWorkflowsDoNotFit }
            : {}),
          plan: args.plan,
          input: args.input,
          outputSchema: args.outputSchema,
          allowed,
          limits: config.dynamic.limits,
        });
        if (!compiled.ok) {
          // Surface validation findings so the model can repair the plan and resubmit.
          return {
            status: "failed",
            causeCode: compiled.causeCode,
            message: compiled.message,
            ...(compiled.findings && compiled.findings.length > 0 ? { findings: compiled.findings } : {}),
          };
        }

        const toolCallId = executeOptions.toolCallId ?? "run_ad_hoc_plan_manual";
        // Scope the runId by session AND turn: provider toolCallIds (e.g. `call_0`) repeat across
        // sessions and across turns within a session, and would otherwise clobber each other's
        // records in the global plans store (and reuse the same workflow persistence path).
        // A hash of the full tuple guarantees uniqueness even when a long sessionId would push
        // the turn/toolCall suffix past the length cap; the readable prefix aids inspection.
        // Budget: little-workflow's world enforces run ids against /^run_[A-Za-z0-9_-]{1,80}$/
        // (84 chars total) -- stricter than the harness-side 128-char reserved-id cap.
        const MAX_RUN_ID_LENGTH = 84;
        const identity = `${config.sessionId} ${config.turnId} ${toolCallId}`;
        const identityHash = createHash("sha256").update(identity).digest("hex").slice(0, 12);
        const readablePrefix = `run_adhoc_${config.sessionId}_${config.turnId}_${toolCallId}`
          .replace(/[^A-Za-z0-9_]/gu, "_")
          .slice(0, MAX_RUN_ID_LENGTH - identityHash.length - 1);
        const runId = `${readablePrefix}_${identityHash}`;
        const files = extractFiles(executeOptions);

        const planSteps = (args.plan as { steps?: unknown }).steps;
        const baseRecord: AuthoredPlanRecord = {
          runId,
          purpose: args.purpose,
          ...(args.reasonConfiguredWorkflowsDoNotFit
            ? { reason: args.reasonConfiguredWorkflowsDoNotFit }
            : {}),
          plan: args.plan,
          definitionHash: compiled.definitionHash,
          capabilitySnapshot: compiled.referenced,
          outputSchema: args.outputSchema,
          status: "running",
          createdAt: nowIso(),
          steps: Array.isArray(planSteps) ? planSteps.length : 0,
        };
        // Admission control shared with the configured workflow tools (session-scoped): the
        // "running" record is written inside the slot so a queued plan is not recorded as
        // running, and a queue-bound rejection leaves no phantom record behind.
        let execution: HarnessWorkflowExecution;
        try {
          execution = await runWithWorkflowRunSlot(config.sessionId, config.budgets, async () => {
            if (files) await writeAuthoredPlan(files, harnessDir, baseRecord);
            const ctx = runContext(config, compiled.definitionHash, runId, allowed.bash);
            return compiled.workflow.runForHarness(args.input, ctx);
          });
        } catch (error) {
          if (error instanceof WorkflowQueueOverflowError) {
            return {
              status: "failed",
              runId,
              causeCode: error.causeCode,
              message: error.message,
            };
          }
          throw error;
        }

        const terminal: AuthoredPlanRecord = {
          ...baseRecord,
          status:
            execution.status === "completed"
              ? "completed"
              : execution.status === "cancelled"
                ? "cancelled"
                : execution.status === "failed"
                  ? "failed"
                  : "running",
          ...(execution.status === "completed"
            ? { outputSummary: summarize(execution.output) }
            : {}),
        };
        // Best-effort: the plan already ran. A store-write failure here must NOT convert a
        // successful run into a tool error — return the execution envelope regardless.
        if (files) {
          try {
            await writeAuthoredPlan(files, harnessDir, terminal);
          } catch {
            // Swallow: persistence of the terminal record is best-effort only.
          }
        }

        return compact(execution);
      },
    }),

    search_authored_plans: tool({
      description:
        "Search one-shot plans you authored on prior runs (by purpose). Returns each plan's purpose, the frozen plan, and its last run's status/summary so you can re-submit it (verbatim or adapted) via run_ad_hoc_plan.",
      inputSchema: SEARCH_INPUT,
      execute: async (args, executeOptions: ToolExecutionOptions<unknown> & { files?: unknown }) => {
        const files = extractFiles(executeOptions);
        if (!files) return { plans: [] };
        const records = await searchAuthoredPlans(files, harnessDir, args.query);
        return {
          plans: records.map((r) => ({
            runId: r.runId,
            purpose: r.purpose,
            status: r.status,
            outputSummary: r.outputSummary,
            plan: r.plan,
            // Return the stored outputSchema too — run_ad_hoc_plan requires it, so a recalled
            // plan can be re-submitted verbatim without the model re-guessing the schema.
            outputSchema: r.outputSchema,
          })),
        };
      },
    }),
  };
}

/**
 * Builds the child run context for a compiled one-shot plan. The `capabilities` shape is the
 * seam with the factory (Task 4): `models.default` is the RAW model (the factory wraps it),
 * and `bash.capabilities` carries the opaque `BashCapabilities` when bash is allowed.
 */
function runContext(
  config: DynamicWorkflowToolsConfig,
  definitionIdentity: string,
  runId: string,
  bash: boolean,
): HarnessWorkflowRunContext {
  const capabilities: HarnessChildCapabilities = {
    tools: config.parentSnapshot.tools ?? {},
    mcpTools: config.parentSnapshot.mcpTools ?? {},
    // Factory `bashFromContext` reads `bash.capabilities`; present only when bash is allowed
    // and a capability was threaded (Task 11), else an empty (absent) capability.
    bash: bash && config.bashCapability !== undefined ? { capabilities: config.bashCapability } : {},
    code: {},
    workflows: {},
    skills: {},
    mounts: [],
    permissions: { approvalPolicy: "reject_ask" },
    // Single model slot; factory `modelsFromContext` maps slot -> wrapped model.
    models: { default: config.model },
  };

  return {
    protocolVersion: 1,
    workflowId: "ad_hoc_plan",
    workflowHandle: "ad_hoc_plan",
    definitionIdentity,
    toolCallId: runId,
    disposition: "await",
    parentSessionId: config.sessionId,
    parentTurnId: config.turnId,
    originTurnId: config.originTurnId,
    reservedRunId: runId,
    persistence: { dataDir: `${config.dataDir}/${runId}` },
    ...(config.abortSignal ? { abortSignal: config.abortSignal } : {}),
    inheritance: {},
    capabilities,
    observation: {
      async recordProgress() {},
    },
  };
}

function compact(execution: HarnessWorkflowExecution): Record<string, unknown> {
  if (execution.status === "completed") {
    // The whole point of a one-shot plan is to return its answer to the model that authored it.
    // The real factory's completed execution carries the result in `output` and sets no `summary`,
    // so `output` MUST be present (untruncated — the caps bound runtime/steps). `outputSummary` is
    // a convenience quick-read only.
    return {
      status: "completed",
      runId: execution.runId,
      output: execution.output,
      outputSummary: execution.summary ?? summarize(execution.output),
    };
  }
  if (execution.status === "failed" || execution.status === "cancelled") {
    return {
      status: execution.status,
      runId: execution.runId,
      causeCode: execution.causeCode,
      message: execution.message,
    };
  }
  return {
    status: "running",
    runId: execution.runId,
    ...(execution.summary ? { outputSummary: execution.summary } : {}),
  };
}

function summarize(output: unknown): string {
  const text = typeof output === "string" ? output : JSON.stringify(output);
  return text.length > 500 ? `${text.slice(0, 500)}…` : text;
}

function extractFiles(executeOptions: { files?: unknown }): StoreFiles | undefined {
  const files = executeOptions.files;
  return files && typeof (files as { writeText?: unknown }).writeText === "function"
    ? (files as StoreFiles)
    : undefined;
}
