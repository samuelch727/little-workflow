import type { ToolSet } from "ai";
import { resolveDynamicWorkflows } from "./dynamic-workflows/config.js";
import { authoredPlansPersistentDir } from "./dynamic-workflows/authored-plans-store.js";
import { HarnessInputError } from "./errors.js";
import { resolveHarnessMemory } from "./memory/memory.js";
import { resolveTraceOptions } from "./trace/options.js";
import {
  DEFAULT_MAX_CONCURRENT_WORKFLOW_RUNS,
  DEFAULT_MAX_QUEUED_WORKFLOW_RUNS,
} from "./utils/workflow-concurrency.js";
import type { CreateHarnessOptions, Harness, HarnessWorkflowBudgets, PersistentDir, ResolvedHarnessConfig } from "./types.js";

const HARNESS_TOOL_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const RESERVED_USER_TOOL_NAMES = new Set(["bash", "__proto__", "constructor", "prototype"]);
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
  const { dynamicWorkflows: rawDynamicWorkflows, ...restOptions } = options;
  const userTools = (options.tools ?? {}) as TTools;
  assertSafeUserTools(userTools);
  const resolvedMemory = resolveHarnessMemory(options.memory, userTools);
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
    tools: { ...userTools, ...resolvedMemory.tools } as TTools,
    skills: options.skills ?? [],
    persistentDirs,
    memory: resolvedMemory.configs,
    trace: resolveTraceOptions(options.trace, undefined),
    workflowBudgets: resolveWorkflowBudgets(options.workflowBudgets),
    ...(dynamicWorkflows ? { dynamicWorkflows } : {}),
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
