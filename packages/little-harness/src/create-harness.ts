import type { ToolSet } from "ai";
import { resolveDynamicWorkflows } from "./dynamic-workflows/config.js";
import { authoredPlansPersistentDir } from "./dynamic-workflows/authored-plans-store.js";
import { HarnessInputError } from "./errors.js";
import { resolveHarnessMemory } from "./memory/memory.js";
import { MEMORY_FILE_TOOL_NAMES } from "./memory/file-tools.js";
import { LOAD_SKILL_TOOL_NAME } from "./skills/load-skill-tool.js";
import { resolveTraceOptions } from "./trace/options.js";
import {
  DEFAULT_MAX_CONCURRENT_WORKFLOW_RUNS,
  DEFAULT_MAX_QUEUED_WORKFLOW_RUNS,
} from "./utils/workflow-concurrency.js";
import { HARNESS_AGENT_GROUP_TOOL_NAMES, resolveAgentGroupsOptions } from "./agents/tools.js";
import {
  HARNESS_CHECKPOINT_TOOL_NAMES,
  resolveCheckpointsOptions,
} from "./checkpoints/tools.js";
import { DEFAULT_ASK_PERSON_TOOL_NAME } from "./human-input/tool.js";
import type { HumanInputOptions } from "./human-input/types.js";
import type { CreateHarnessOptions, Harness, HarnessWorkflowBudgets, PersistentDir, ResolvedHarnessConfig } from "./types.js";

const HARNESS_TOOL_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const RESERVED_USER_TOOL_NAMES = new Set([
  "bash",
  "__proto__",
  "constructor",
  "prototype",
  ...HARNESS_AGENT_GROUP_TOOL_NAMES,
  ...HARNESS_CHECKPOINT_TOOL_NAMES,
]);
export const DEFAULT_WORKFLOW_BUDGETS: HarnessWorkflowBudgets = {
  maxModelSteps: 20,
  maxToolCallsPerTurn: 100,
  maxConcurrentToolCalls: 10,
  // Shared with the workflow-run gate so a direct caller of resolveHarnessWorkflowTools that
  // omits budgets is bound by the same numbers a harness would apply.
  maxConcurrentWorkflowRuns: DEFAULT_MAX_CONCURRENT_WORKFLOW_RUNS,
  maxQueuedWorkflowRuns: DEFAULT_MAX_QUEUED_WORKFLOW_RUNS,
  maxAutonomousTurns: 10,
};

export function createHarness<TTools extends ToolSet = ToolSet, TExtraBody = unknown>(
  options: CreateHarnessOptions<TTools, TExtraBody>,
): Harness<TTools, TExtraBody> {
  const {
    dynamicWorkflows: rawDynamicWorkflows,
    agents: rawAgents,
    checkpoints: rawCheckpoints,
    humanInput: rawHumanInput,
    ...restOptions
  } = options;
  const userTools = (options.tools ?? {}) as TTools;
  assertSafeUserTools(userTools);
  const humanInput = resolveHumanInput(rawHumanInput, userTools);
  const resolvedMemory = resolveHarnessMemory(options.memory);
  assertNoBuiltInFileToolCollisions(options, userTools, resolvedMemory.configs.length > 0);
  const dynamicWorkflows = resolveDynamicWorkflows(rawDynamicWorkflows);
  const dynamicPlanDirs = dynamicWorkflows
    ? [authoredPlansPersistentDir<TExtraBody>()]
    : [];
  const persistentDirs = [
    ...(options.persistentDirs ?? []),
    ...resolvedMemory.persistentDirs,
    ...dynamicPlanDirs,
  ];
  assertUniquePersistentDirs(persistentDirs);
  const config: ResolvedHarnessConfig<TTools, TExtraBody> = {
    ...restOptions,
    tools: userTools,
    skills: options.skills ?? [],
    persistentDirs,
    memory: resolvedMemory.configs,
    trace: resolveTraceOptions(options.trace, undefined),
    workflowBudgets: resolveWorkflowBudgets(options.workflowBudgets),
    ...(dynamicWorkflows ? { dynamicWorkflows } : {}),
    ...(rawAgents === undefined ? {} : { agents: resolveAgentGroupsOptions(rawAgents) }),
    ...(rawCheckpoints === undefined
      ? {}
      : { checkpoints: resolveCheckpointsOptions(rawCheckpoints) }),
    ...(humanInput === undefined ? {} : { humanInput }),
  };

  return {
    sessions: options.host.sessions,
    config,
  };
}

function resolveWorkflowBudgets(overrides: Partial<HarnessWorkflowBudgets> | undefined): HarnessWorkflowBudgets {
  return {
    ...DEFAULT_WORKFLOW_BUDGETS,
    ...Object.fromEntries(Object.entries(overrides ?? {}).filter(([, value]) => value !== undefined)),
  };
}

function resolveHumanInput(
  humanInput: CreateHarnessOptions["humanInput"],
  userTools: ToolSet,
): HumanInputOptions | undefined {
  if (humanInput === undefined || humanInput === false) return undefined;
  const resolved = humanInput === true ? {} : humanInput;
  if (resolved.tool !== false) {
    const name = resolved.toolName ?? DEFAULT_ASK_PERSON_TOOL_NAME;
    if (!HARNESS_TOOL_NAME.test(name) || RESERVED_USER_TOOL_NAMES.has(name) || Object.hasOwn(userTools, name)) {
      throw new HarnessInputError("humanInput toolName is reserved, invalid, or already a tool.", { toolName: name });
    }
  }
  if (resolved.deliver !== undefined && typeof resolved.deliver !== "function") {
    throw new HarnessInputError("humanInput deliver must be a function.");
  }
  return resolved;
}

/**
 * With bash off, a turn adds `load_skill` when it has skills and plain file tools when it has
 * memory. A configured tool with one of those names would collide on the first turn, so say so
 * now.
 */
function assertNoBuiltInFileToolCollisions(
  options: CreateHarnessOptions<any, any>,
  userTools: ToolSet,
  hasMemory: boolean,
): void {
  if (options.runtime?.bash !== false) {
    return;
  }
  const names = [
    ...(hasMemory || (options.skills?.length ?? 0) > 0 || options.mcp !== undefined ? [LOAD_SKILL_TOOL_NAME] : []),
    ...(hasMemory ? MEMORY_FILE_TOOL_NAMES : []),
  ];
  for (const name of names) {
    if (Object.hasOwn(userTools, name)) {
      throw new HarnessInputError(
        `With bash off the harness adds its own ${name} tool; rename this tool.`,
        { toolName: name },
      );
    }
  }
}

function assertSafeUserTools(userTools: ToolSet): void {
  for (const name of Object.keys(userTools)) {
    if (!HARNESS_TOOL_NAME.test(name) || RESERVED_USER_TOOL_NAMES.has(name)) {
      throw new HarnessInputError("User tool name is reserved or invalid.", { toolName: name });
    }
  }
}

function assertUniquePersistentDirs(persistentDirs: readonly Pick<PersistentDir, "harnessDir">[]): void {
  const seen = new Map<string, string>();
  for (const persistentDir of persistentDirs) {
    const normalized = canonicalizeHarnessDir(persistentDir.harnessDir);
    const existing = seen.get(normalized);
    if (existing !== undefined) {
      throw new HarnessInputError("Persistent Dir harnessDir values must be unique.", {
        harnessDir: persistentDir.harnessDir,
        duplicateOf: existing,
      });
    }
    seen.set(normalized, persistentDir.harnessDir);
  }
}

function canonicalizeHarnessDir(value: string): string {
  if (!value.startsWith("/") || value.includes("\0")) {
    return value;
  }

  const parts: string[] = [];
  for (const part of value.split("/")) {
    if (part === "" || part === ".") {
      continue;
    }
    if (part === "..") {
      parts.pop();
    } else {
      parts.push(part);
    }
  }

  return `/${parts.join("/")}`;
}
