import { HarnessInputError } from "../errors.js";
import type {
  AgentWorkflowRegistry,
  DynamicWorkflowFactory,
  DynamicWorkflowLimits,
  DynamicWorkflowsConfig,
} from "./types.js";

export const DEFAULT_DYNAMIC_WORKFLOW_LIMITS: DynamicWorkflowLimits = {
  maxSteps: 8,
  maxRuntimeMs: 120_000,
};

export type ResolvedDynamicWorkflows = {
  readonly factory: DynamicWorkflowFactory;
  readonly exclude: readonly string[];
  readonly limits: DynamicWorkflowLimits;
  /** Extra model slots for plan steps, keyed by slot name. `default` is always the agent's model. */
  readonly models?: Readonly<Record<string, unknown>>;
  /** Whether the agent gets `define_workflow`: asked for, and the factory can build them. */
  readonly define?: boolean;
  /** Decides which agent-defined workflows a turn offers. Absent: every stored one. */
  readonly registry?: AgentWorkflowRegistry;
};

export function resolveDynamicWorkflows(
  input: DynamicWorkflowsConfig | undefined,
): ResolvedDynamicWorkflows | undefined {
  if (input === undefined) return undefined;
  if (
    typeof input !== "object" ||
    input === null ||
    (input as { enabled?: unknown }).enabled !== true ||
    typeof (input as { factory?: unknown }).factory !== "object" ||
    (input as { factory?: unknown }).factory === null ||
    typeof (input as { factory?: { compile?: unknown } }).factory?.compile !== "function"
  ) {
    throw new HarnessInputError(
      "dynamicWorkflows must be the result of dynamicWorkflows() from little-workflow (it injects the lowering factory). A bare `true` cannot work because little-workflow depends on little-harness.",
    );
  }
  const limits = { ...DEFAULT_DYNAMIC_WORKFLOW_LIMITS, ...(input.limits ?? {}) };
  assertPositiveInteger("limits.maxSteps", limits.maxSteps);
  assertPositiveInteger("limits.maxRuntimeMs", limits.maxRuntimeMs);
  const models = input.models ?? {};
  for (const slot of Object.keys(models)) {
    if (slot === "default" || !MODEL_SLOT.test(slot)) {
      throw new HarnessInputError(
        `dynamicWorkflows models: '${slot}' cannot be a model slot name. Use letters, digits, '_' or '-', and not 'default', which is always the agent's own model.`,
        { field: "models", value: slot },
      );
    }
  }
  const registry = input.registry;
  if (registry !== undefined) assertRegistry(registry);
  return {
    factory: input.factory,
    exclude: input.exclude ?? [],
    limits,
    ...(Object.keys(models).length === 0 ? {} : { models }),
    define: input.define !== false && typeof input.factory.define === "function",
    ...(registry === undefined ? {} : { registry }),
  };
}

function assertRegistry(registry: unknown): asserts registry is AgentWorkflowRegistry {
  const hooks = registry as { defined?: unknown; resolve?: unknown } | null;
  if (
    typeof hooks !== "object" ||
    hooks === null ||
    (hooks.defined !== undefined && typeof hooks.defined !== "function") ||
    (hooks.resolve !== undefined && typeof hooks.resolve !== "function")
  ) {
    throw new HarnessInputError(
      "dynamicWorkflows registry must be an object whose `defined` and `resolve`, when present, are functions.",
      { field: "registry" },
    );
  }
}

const MODEL_SLOT = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/u;

function assertPositiveInteger(field: string, value: number): void {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new HarnessInputError(
      `dynamicWorkflows ${field} must be a positive integer; got ${String(value)}. ` +
        "This bounds one-shot plans (a non-positive or non-finite value would disable the cap).",
      { field, value },
    );
  }
}
