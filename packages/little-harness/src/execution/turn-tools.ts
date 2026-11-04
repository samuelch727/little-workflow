import type { ToolSet } from "ai";
import type { IFileSystem } from "just-bash";
import { join, posix } from "node:path";
import { HarnessInputError } from "../errors.js";
import { resolveHarnessMcpGateway, type ResolvedHarnessMcpGateway } from "../mcp.js";
import { resolveSkillsWithWarnings } from "../skills/skill.js";
import { createLoadSkillTool } from "../skills/load-skill-tool.js";
import { withMemorySkill } from "../memory/skill.js";
import { createMemoryFileTools } from "../memory/file-tools.js";
import { createTaskControlTools } from "../tasks/control-tools.js";
import type { DynamicAllowedCapabilities } from "../dynamic-workflows/types.js";
import { createTraceErrorEnvelope } from "../trace/error.js";
import { withStepToolContext } from "../runtime/step-tools.js";
import { createHumanInputTurn } from "../human-input/tool.js";
import { sessionResultsDir } from "../human-input/requests.js";
import type { HumanInputAsk } from "../human-input/types.js";
import type {
  FileWriter,
  HarnessEventInput,
  HarnessOrchestrationServices,
  HarnessRuntimeUsage,
  HarnessSandbox,
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
  createAgentWorkflowTools,
  createDefineWorkflowTool,
  DEFINE_WORKFLOW_TOOL_NAME,
  offeredAgentWorkflows,
  type AgentWorkflowToolsConfig,
} from "../dynamic-workflows/agent-workflow-tools.js";
import { readAgentWorkflows } from "../dynamic-workflows/agent-workflows-store.js";
import { AUTHORED_PLANS_HARNESS_DIR } from "../dynamic-workflows/authored-plans-store.js";
import { createAgentGroupTools, HARNESS_AGENT_GROUP_TOOL_NAMES } from "../agents/tools.js";
import {
  createCheckpointTools,
  HARNESS_CHECKPOINT_TOOL_NAMES,
} from "../checkpoints/tools.js";
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
  /** The turn's file store (PreparedTurn `files`), read for the workflows the agent defined. */
  files?: FileWriter | undefined;
  /** The host's own data dir (PreparedTurn `dataDir`), shared by every session. */
  hostDataDir?: string | undefined;
  /** The exact cached filesystem backing hostDataDir, when the host has no disk. */
  hostDataFs?: IFileSystem | undefined;
};

export type AssembledTurnTools = {
  /** The resolved MCP gateway; the caller owns closing it when the turn ends. */
  mcp: ResolvedHarnessMcpGateway;
  resolvedSkills: ResolvedSkill[];
  manifest: ReturnType<typeof resolveAgentManifest>;
  /** Configured + MCP + workflow + task-control + inspection tools, collision-checked. */
  turnTools: ToolSet;
  warnings: HarnessWarning[];
  /** `ask` for tools' execution context, when the harness has `humanInput`. */
  ask?: HumanInputAsk;
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
      dynamicWorkflowToolNames: config.dynamicWorkflows
        ? [
            ...HARNESS_DYNAMIC_WORKFLOW_TOOL_NAMES,
            ...(config.dynamicWorkflows.define === true ? [DEFINE_WORKFLOW_TOOL_NAME] : []),
          ]
        : [],
      agentGroupToolNames: config.agents ? [...HARNESS_AGENT_GROUP_TOOL_NAMES] : [],
      checkpointToolNames: config.checkpoints
        ? [...HARNESS_CHECKPOINT_TOOL_NAMES]
        : [],
      workflows: config.workflows ?? [],
    });
    warnings.push(...manifest.warnings);
    // What workflow and plan steps call: the configured tools, with the caller's harness context,
    // an idempotency key, and recorded results for tools marked with `once`.
    const stepTools = withStepToolContext(baseTools, {
      sessionId: session.id,
      onceDir: workflowDataPath(options, "once"),
      ...(options.hostDataFs === undefined ? {} : { fs: options.hostDataFs }),
    });
    const workflowTools = resolveHarnessWorkflowTools(config.workflows, {
      sessionId: session.id,
      turnId,
      originTurnId: turnId,
      dataDir: workflowDataPath(options, "workflows"),
      ...(options.hostDataFs === undefined ? {} : { fs: options.hostDataFs }),
      abortSignal: options.abortSignal,
      budgets: config.workflowBudgets,
      parentSnapshot: workflowParentSnapshot({
        tools: stepTools,
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
    const dynamicWorkflowConfig = config.dynamicWorkflows
      ? {
          sessionId: session.id,
          turnId,
          originTurnId: turnId,
          dataDir: workflowDataPath(options, "dynamic-workflows"),
          ...(options.hostDataFs === undefined ? {} : { fs: options.hostDataFs }),
          dynamic: config.dynamicWorkflows,
          parentSnapshot: {
            tools: stepTools,
            mcpTools: mcp.tools,
            bash: bashSnapshotFromRuntime(config.runtime),
          },
          model: config.model,
          budgets: config.workflowBudgets,
          bashCapability: bashCapabilityFromRuntime(config.runtime),
          ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
        }
      : undefined;
    // Workflows the agent defined run in one store for the whole host, so the steps the planner
    // wrote in one session are kept in the next. A host without a data dir keeps them per session.
    // A registry, when the host gave one, decides which of them this turn offers.
    let turnTools = baseTools;
    let agentWorkflowConfig: AgentWorkflowToolsConfig | undefined;
    if (dynamicWorkflowConfig !== undefined && config.dynamicWorkflows?.define === true) {
      const offered = await offeredAgentWorkflows(
        options.files === undefined ? [] : await readAgentWorkflows(options.files, AUTHORED_PLANS_HARNESS_DIR),
        config.dynamicWorkflows.registry,
        { sessionId: session.id, turnId },
      );
      warnings.push(...offered.warnings);
      agentWorkflowConfig = {
        ...dynamicWorkflowConfig,
        agentWorkflowsDataDir: agentWorkflowsDataPath(options),
        records: offered.offers,
        takenToolNames: () => new Set(Object.keys(turnTools)),
      };
    }
    const dynamicWorkflowTools = dynamicWorkflowConfig === undefined
      ? {}
      : {
          ...createDynamicWorkflowTools(dynamicWorkflowConfig),
          ...(agentWorkflowConfig === undefined ? {} : createDefineWorkflowTool(agentWorkflowConfig)),
        };
    if (config.agents !== undefined && orchestration === undefined) {
      throw new HarnessInputError("Agent Groups require Harness orchestration services.");
    }
    const agentGroupTools = config.agents === undefined || orchestration === undefined
      ? {}
      : createAgentGroupTools({
          sessionId: session.id,
          originTurnId: turnId,
          ledger: orchestration.tasks,
          agents: config.agents,
          ...(options.abortSignal === undefined ? {} : { abortSignal: options.abortSignal }),
        });
    const checkpointTools = config.checkpoints === undefined
      ? {}
      : createCheckpointTools({
          sessionId: session.id,
          originTurnId: turnId,
          checkpoints: config.checkpoints,
          ...(options.abortSignal === undefined
            ? {}
            : { abortSignal: options.abortSignal }),
        });
    if (config.humanInput !== undefined && orchestration === undefined) {
      throw new HarnessInputError("humanInput needs a host with durable services, such as localHost.");
    }
    const humanInput = config.humanInput === undefined || orchestration === undefined
      ? undefined
      : createHumanInputTurn({
          options: config.humanInput,
          services: { tasks: orchestration.tasks, results: orchestration.results },
          session,
          sessionDataDir: sessionResultsDir(session),
          turnId,
        });
    for (const [additionalTools, source] of [
      [mcp.tools, "MCP gateway"],
      [workflowTools, "workflow"],
      [taskControlTools, "task-control"],
      [workflowInspectionTools, "workflow-inspection"],
      [dynamicWorkflowTools, "dynamic-workflow"],
      [agentGroupTools, "agent-group"],
      [checkpointTools, "checkpoint"],
      [humanInput?.tools ?? {}, "human-input"],
    ] as const) {
      turnTools = mergedTurnTools(turnTools, additionalTools, source);
    }
    if (agentWorkflowConfig !== undefined) {
      // Last, so a stored workflow whose name another tool now uses is left out, not fatal.
      const agentWorkflows = createAgentWorkflowTools(agentWorkflowConfig);
      warnings.push(...agentWorkflows.warnings);
      turnTools = mergedTurnTools(turnTools, agentWorkflows.tools, "agent-defined workflow");
    }

    // The built-in memory skill joins the turn's skills here, after the workflow snapshot: workflow
    // steps do not see the memory folders, so they do not get the skill either.
    const turnResolvedSkills = withMemorySkill(resolvedSkills, config.memory);
    if (config.runtime?.bash === false) {
      // Without bash the agent cannot cat a skill or edit a memory file, so it gets plain tools
      // for exactly that: one to open skills, and file tools limited to its memory folders.
      turnTools = mergedTurnTools(
        turnTools,
        {
          ...(turnResolvedSkills.length === 0 ? {} : createLoadSkillTool(turnResolvedSkills)),
          ...(config.memory.length === 0 ? {} : createMemoryFileTools(config.memory)),
        },
        "built-in file",
      );
    }

    return {
      mcp,
      resolvedSkills: turnResolvedSkills,
      manifest,
      turnTools,
      warnings,
      ...(humanInput === undefined ? {} : { ask: humanInput.ask }),
    };
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
 *
 * Disposal is also when a sandbox's usage is final: a remote sandbox knows its awake time
 * only once it has been put to sleep. So after the teardown, failed or not, the turn's one
 * `harness.runtime.usage` event is emitted from what the sandbox reports (see
 * {@link runtimeUsageOf}). Callers dispose before the turn's terminal session event, so the
 * usage lands inside the turn's trace. A sandbox that reports nothing emits nothing.
 */
export async function disposeTurnRuntime(
  runtime: HarnessSandbox | undefined,
  emit?: (event: HarnessEventInput) => Promise<unknown>,
): Promise<void> {
  if (runtime === undefined) {
    return;
  }
  try {
    await runtime.dispose?.();
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
  const usage = runtimeUsageOf(runtime);
  if (usage === undefined) {
    return;
  }
  try {
    await emit?.({ type: "harness.runtime.usage", metadata: usage });
  } catch {
    // Usage accounting is observability; it never fails the turn.
  }
}

/**
 * What a turn's sandbox used, from its `tiering()` and `usage()`. A sandbox that implements
 * neither is not accounted for. One that reports usage but no tiering is a real execution
 * environment unless it names itself `just-bash`; one that reports tiering but no usage is
 * measured as nothing from an unknown provider. Both reads are best effort: a sandbox that
 * throws here has already been disposed and cannot be asked again.
 */
export function runtimeUsageOf(runtime: HarnessSandbox): HarnessRuntimeUsage | undefined {
  const sandbox = read(() => runtime.usage?.());
  const tiering = read(() => runtime.tiering?.());
  if (sandbox === undefined && tiering === undefined) {
    return undefined;
  }
  const tier = tiering?.tier ?? (sandbox?.provider === "just-bash" ? "tier-0" : "next-tier");
  return {
    tier,
    commands: tiering?.commands ?? { tier0: 0, nextTier: 0, denied: 0 },
    escalations: tiering?.escalations ?? 0,
    sandbox: sandbox ?? { provider: "unknown", activeMs: 0 },
  };
}

function read<T>(get: () => T | undefined): T | undefined {
  try {
    return get();
  } catch {
    return undefined;
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
 * `exclude`), the `default` model slot plus any configured `modelSlots`, and `bash` iff the snapshot carries a
 * non-empty bash capability and bash is not excluded.
 */
export function dynamicAllowedCapabilities(
  snapshot: {
    tools?: Readonly<Record<string, unknown>>;
    mcpTools?: Readonly<Record<string, unknown>>;
    bash?: Readonly<Record<string, unknown>>;
  },
  exclude: readonly string[],
  modelSlots: readonly string[] = [],
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
  return { tools, models: ["default", ...modelSlots], bash };
}

/**
 * Filesystem-backed hosts supply both the session data dir and their exact cached filesystem.
 * Never interpret a virtual workflow path relative to the process working directory.
 */
function workflowDataPath(options: AssembleTurnToolsOptions<any>, name: string): string {
  if (options.hostDataFs === undefined) return sessionDataPath(options.session, name);
  if (options.session.dataDir === undefined || !posix.isAbsolute(options.session.dataDir)) {
    throw new HarnessInputError("A workflow data filesystem needs an absolute session dataDir.");
  }
  return posix.join(options.session.dataDir, name);
}

function agentWorkflowsDataPath(options: AssembleTurnToolsOptions<any>): string {
  if (options.hostDataDir === undefined) return sessionDataPath(options.session, "agent-workflows");
  // Next 15's build tracer mistakes a conditional path callee for a thenable.
  if (options.hostDataFs === undefined) return join(options.hostDataDir, "agent-workflows");
  return posix.join(options.hostDataDir, "agent-workflows");
}

/**
 * Where a turn's workflow event stores live: under the host's session data dir, so they never
 * land wherever the process happened to start (LIT-44). A host without one keeps the old
 * `<sessionId>/<name>` path, relative to the working directory.
 */
function sessionDataPath(session: HarnessSession, name: string): string {
  return session.dataDir === undefined ? `${session.id}/${name}` : join(session.dataDir, name);
}
