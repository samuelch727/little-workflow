import type { ToolSet } from "ai";
import { join } from "node:path";
import { HarnessInputError } from "../errors.js";
import { resolveHarnessMcpGateway, type ResolvedHarnessMcpGateway } from "../mcp.js";
import { resolveSkillsWithWarnings } from "../skills/skill.js";
import { createTaskControlTools } from "../tasks/control-tools.js";
import type { DynamicAllowedCapabilities } from "../dynamic-workflows/types.js";
import { createTraceErrorEnvelope } from "../trace/error.js";
import type {
  HarnessEventInput,
  HarnessOrchestrationServices,
  HarnessRuntime,
  HarnessRuntimeOptions,
  HarnessSession,
  HarnessWarning,
  ResolvedHarnessConfig,
  ResolvedSkill,
} from "../types.js";
import {
  resolveHarnessWorkflowTools,
  workflowHandleFromId,
  type HarnessWorkflow,
  type HarnessWorkflowParentSnapshot,
} from "../workflows.js";
import { createWorkflowInspectionTools } from "../workflows-inspection.js";
import { createDynamicWorkflowTools } from "../dynamic-workflows/tools.js";
import {
  HARNESS_DYNAMIC_WORKFLOW_TOOL_NAMES,
  HARNESS_TASK_CONTROL_TOOL_NAMES,
  HARNESS_WORKFLOW_INSPECTION_TOOL_NAMES,
  resolveAgentManifest,
} from "../workspace/resolve-agent-manifest.js";

export const RUNTIME_RESERVED_TOOL_NAMES: ReadonlySet<string> = new Set(["bash"]);

export type AssembleTurnToolsOptions<TExtraBody = unknown> = {
  config: ResolvedHarnessConfig<ToolSet, TExtraBody>;
  /** The executable configured tools for this turn (post abstract-tool partitioning). */
  baseTools: ToolSet;
  session: HarnessSession;
  turnId: string;
  /** Turn-scoped orchestration services (from PreparedTurn); absent when the host has none. */
  orchestration: HarnessOrchestrationServices | undefined;
  abortSignal?: AbortSignal | undefined;
};

export type AssembledTurnTools = {
  /** The resolved MCP gateway; the caller owns closing it when the turn ends. */
  mcp: ResolvedHarnessMcpGateway;
  resolvedSkills: ResolvedSkill[];
  manifest: ReturnType<typeof resolveAgentManifest>;
  /** Configured + MCP + workflow + task-control + inspection tools, collision-checked. */
  turnTools: ToolSet;
  warnings: HarnessWarning[];
};

/**
 * Assembles the full tool manifest for one turn — the "what can this turn call" half of the
 * tool-dispatch seam, shared by generateHarness and streamHarness so the two loops cannot
 * drift. Dispatch of the assembled tools stays with wrapToolsWithHarnessContext (model
 * calls) and the runtime tool bridge (sandbox calls).
 */
export async function assembleTurnTools<TExtraBody>(
  options: AssembleTurnToolsOptions<TExtraBody>,
): Promise<AssembledTurnTools> {
  const { config, baseTools, session, turnId, orchestration } = options;
  const warnings: HarnessWarning[] = [];
  const mcp = await resolveHarnessMcpGateway(config.mcp);

  try {
    const turnSkills = [...config.skills, ...mcp.skills];
    const resolvedSkillsResult = await resolveSkillsWithWarnings(turnSkills, {
      skillMaxRisk: config.skillMaxRisk,
      skillOidcToken: config.skillOidcToken,
    });
    const resolvedSkills = resolvedSkillsResult.skills;
    warnings.push(...resolvedSkillsResult.warnings);
    const manifest = resolveAgentManifest({
      configuredToolNames: Object.keys(baseTools),
      mcpToolNames: Object.keys(mcp.tools),
      taskControlToolNames: HARNESS_TASK_CONTROL_TOOL_NAMES,
      workflowInspectionToolNames: HARNESS_WORKFLOW_INSPECTION_TOOL_NAMES,
      dynamicWorkflowToolNames: config.dynamicWorkflows ? [...HARNESS_DYNAMIC_WORKFLOW_TOOL_NAMES] : [],
      workflows: config.workflows ?? [],
    });
    warnings.push(...manifest.warnings);
    const workflowTools = resolveHarnessWorkflowTools(config.workflows, {
      sessionId: session.id,
      turnId,
      originTurnId: turnId,
      dataDir: sessionDataPath(session, "workflows"),
      abortSignal: options.abortSignal,
      budgets: config.workflowBudgets,
      parentSnapshot: workflowParentSnapshot({
        tools: baseTools,
        mcpTools: mcp.tools,
        skills: resolvedSkills,
        workflows: config.workflows,
        bash: bashSnapshotFromRuntime(config.runtime),
      }),
    });
    const taskControlTools = orchestration === undefined
      ? {}
      : createTaskControlTools({
          sessionId: session.id,
          originTurnId: turnId,
          ledger: orchestration.tasks,
          continuations: orchestration.continuations,
          resumeQueue: orchestration.resumeQueue,
          wakeups: orchestration.wakeups,
          results: orchestration.results,
          modelFacingSafeOnly: true,
        });
    const workflowInspectionTools = createWorkflowInspectionTools({
      sessionId: session.id,
      workflows: manifest.workflows,
      ...(orchestration === undefined
        ? {}
        : {
            tasks: orchestration.tasks,
            workflowQueue: orchestration.workflowQueue,
            results: orchestration.results,
            resultGrants: orchestration.resultGrants,
          }),
    });
    const dynamicWorkflowTools = config.dynamicWorkflows
      ? createDynamicWorkflowTools({
          sessionId: session.id,
          turnId,
          originTurnId: turnId,
          dataDir: sessionDataPath(session, "dynamic-workflows"),
          dynamic: config.dynamicWorkflows,
          parentSnapshot: {
            tools: baseTools,
            mcpTools: mcp.tools,
            bash: bashSnapshotFromRuntime(config.runtime),
          },
          model: config.model,
          budgets: config.workflowBudgets,
          bashCapability: bashCapabilityFromRuntime(config.runtime),
          ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
        })
      : {};
    const turnTools = mergedTurnTools(
      mergedTurnTools(
        mergedTurnTools(
          mergedTurnTools(
            mergedTurnTools(baseTools, mcp.tools, "MCP gateway"),
            workflowTools,
            "workflow",
          ),
          taskControlTools,
          "task-control",
        ),
        workflowInspectionTools,
        "workflow-inspection",
      ),
      dynamicWorkflowTools,
      "dynamic-workflow",
    );

    return { mcp, resolvedSkills, manifest, turnTools, warnings };
  } catch (error) {
    try {
      await mcp.close();
    } catch {
      // Preserve the original assembly failure.
    }
    throw error;
  }
}

/**
 * Disposes the turn's execution environment without letting cleanup mask the turn's outcome.
 *
 * Disposal is where an execution environment does its last real work — reaping a child,
 * closing a remote session, syncing a sandbox workspace back to the host. Swallowing those
 * failures silently turns data loss into a no-op, so the error is reported as one
 * `harness.runtime.dispose.failed` event carrying the trace error envelope. Emission itself
 * is best effort: neither the disposal error nor a failing emitter may escape this function.
 */
export async function disposeTurnRuntime(
  runtime: HarnessRuntime | undefined,
  emit?: (event: HarnessEventInput) => Promise<unknown>,
): Promise<void> {
  try {
    await runtime?.dispose?.();
  } catch (error) {
    try {
      await emit?.({
        type: "harness.runtime.dispose.failed",
        metadata: { error: createTraceErrorEnvelope(error) },
      });
    } catch {
      // Reporting the failure must never mask the turn's outcome either.
    }
  }
}

export function mergedTurnTools(
  configuredTools: ToolSet,
  incomingTools: ToolSet,
  incomingLabel: string,
): ToolSet {
  for (const name of Object.keys(incomingTools)) {
    if (Object.hasOwn(configuredTools, name)) {
      throw new HarnessInputError(`${incomingLabel} tool name collides with a configured harness tool.`, {
        toolName: name,
      });
    }
    if (RUNTIME_RESERVED_TOOL_NAMES.has(name)) {
      throw new HarnessInputError(`${incomingLabel} tool name collides with a runtime reserved tool.`, {
        toolName: name,
      });
    }
  }
  return { ...configuredTools, ...incomingTools };
}

function workflowParentSnapshot(options: {
  tools: ToolSet;
  mcpTools: ToolSet;
  skills: readonly { readonly name: string }[];
  workflows: readonly HarnessWorkflow[] | undefined;
  bash: Readonly<Record<string, unknown>>;
}): HarnessWorkflowParentSnapshot {
  return {
    tools: options.tools,
    mcpTools: options.mcpTools,
    bash: options.bash,
    skills: Object.fromEntries(options.skills.map((skill) => [skill.name, skill])),
    workflows: Object.fromEntries((options.workflows ?? []).map((workflow) => [
      workflowHandleFromId(workflow.id),
      {
        id: workflow.id,
        description: workflow.description,
        definitionIdentity: workflow.definitionIdentity,
      },
    ])),
  };
}

/**
 * Derives the serializable bash capability snapshot the parent hands to a child (dynamic)
 * run. The bash *tool* (`runtime.shellTool()`) is created lazily after the turn's tools are
 * assembled and carries a non-serializable `execute` fn, so it cannot enter the snapshot
 * (the snapshot is hashed into the child's definitionIdentity). Instead we capture the
 * config-derived, serializable bash capabilities from `config.runtime` under a `default`
 * key, mirroring the single model slot. Bash defaults ON — it is present unless the runtime
 * options explicitly set `bash: false`. Task 10 threads these caps into
 * `executeWorkflowVersion`'s `bashCapabilities` (normalizing the `network` field, which is
 * `boolean | HarnessNetworkPolicy` here but `BashNetworkCapabilities` there).
 */
export function bashSnapshotFromRuntime(
  runtime: HarnessRuntimeOptions | undefined,
): Readonly<Record<string, unknown>> {
  if (runtime?.bash === false) {
    return {};
  }
  return {
    default: {
      network: runtime?.network ?? false,
      python: runtime?.python ?? false,
      javascript: runtime?.javascript ?? false,
    },
  };
}

/**
 * The concrete, opaque `BashCapabilities` (little-workflow `bash-tool.ts`) threaded into a
 * dynamic plan's run context under `capabilities.bash.capabilities`. Kept consistent with
 * {@link bashSnapshotFromRuntime}: `undefined` iff the snapshot's bash is empty (bash off),
 * defined otherwise — so the factory never accepts a bash-referencing plan at compile then
 * gets `undefined` bash at run.
 *
 * NETWORK IS CONSERVATIVELY DISABLED. Task 11's brief assumed an existing harness
 * `runtime -> BashCapabilities` conversion to reuse, but there is none: the harness's own
 * bash tool goes `runtime -> just-bash BashOptions` via `bashOptionsForRuntime`
 * (fields `allowedUrlPrefixes`/`allowedMethods`, a *different* normalizer), while
 * `BashCapabilities.network` (`BashNetworkCapabilities`) uses `allow`/`methods` and runs
 * through little-workflow's `normalizeBashCapabilities`. Hand-mapping the
 * `boolean | HarnessNetworkPolicy` runtime network (whose `allowedUrlPrefixes` entries are
 * `string | HarnessAllowedUrl`, not `string`) across those two normalizers — untested here
 * (Task 12 exercises tool.call/ai.generate, not bash) — risks getting `denyPrivateRanges` /
 * full-internet wrong in the permissive direction. We only ever under-grant: `network: false`.
 * A network-via-bash one-shot plan under a `network`-enabled harness fails at run time (safe,
 * flagged). Follow-up: extract a shared runtime->BashCapabilities normalizer used by both the
 * harness's own bash tool and this seam, then map network faithfully.
 */
export function bashCapabilityFromRuntime(
  runtime: HarnessRuntimeOptions | undefined,
): { readonly network: false; readonly python: boolean; readonly javascript: boolean } | undefined {
  if (runtime?.bash === false) {
    return undefined;
  }
  return {
    network: false,
    python: runtime?.python ?? false,
    javascript: runtime?.javascript ?? false,
  };
}

/**
 * Derives the ceiling of capabilities a one-shot dynamic plan may reference: the parent
 * agent's own snapshot. The allow-set is the union of tool + MCP handle names (minus
 * `exclude`), the single `default` model slot, and `bash` iff the snapshot carries a
 * non-empty bash capability and bash is not excluded.
 */
export function dynamicAllowedCapabilities(
  snapshot: {
    tools?: Readonly<Record<string, unknown>>;
    mcpTools?: Readonly<Record<string, unknown>>;
    bash?: Readonly<Record<string, unknown>>;
  },
  exclude: readonly string[],
): DynamicAllowedCapabilities {
  const excluded = new Set(exclude);
  const tools = [
    ...Object.keys(snapshot.tools ?? {}),
    ...Object.keys(snapshot.mcpTools ?? {}),
  ]
    .filter((name) => !excluded.has(name))
    .sort();
  const bash =
    snapshot.bash !== undefined &&
    Object.keys(snapshot.bash).length > 0 &&
    !excluded.has("bash");
  return { tools, models: ["default"], bash };
}

/**
 * Where a turn's workflow event stores live: under the host's session data dir, so they never
 * land wherever the process happened to start (LIT-44). A host without one keeps the old
 * `<sessionId>/<name>` path, relative to the working directory.
 */
function sessionDataPath(session: HarnessSession, name: string): string {
  return session.dataDir === undefined ? `${session.id}/${name}` : join(session.dataDir, name);
}
