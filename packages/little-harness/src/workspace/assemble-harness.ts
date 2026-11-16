import type { ToolSet } from "ai";
import type { Harness, HarnessHost, SkillInput } from "../types.js";
import type { HarnessWorkflow } from "../workflows.js";
import { HarnessInputError } from "../errors.js";
import { HARNESS_AGENT_GROUP_TOOL_NAMES } from "../agents/tools.js";
import { HARNESS_TASK_CONTROL_TOOL_NAMES, HARNESS_WORKFLOW_INSPECTION_TOOL_NAMES, resolveAgentManifest } from "./resolve-agent-manifest.js";
import { rejectReservedDiscoveredToolNames } from "./tool-name-policy.js";

/** A factory creates instance-local tools/model/config from trusted application values. */
export type HarnessDefinition<TContext = unknown> = Harness | ((host: HarnessHost, context: TContext) => Harness | Promise<Harness>);
type HarnessFactory = Exclude<HarnessDefinition<never>, Harness>;
// TypeScript infers an overloaded function from its last signature. Explicit
// HarnessDefinition<Context> exports provide a stable context contract when needed.
type LastFactoryContext<TFactory> = 0 extends (1 & TFactory) ? unknown
  : TFactory extends (host: HarnessHost, ...rest: infer TRest) => unknown
    ? TRest extends [] ? unknown
      : TRest extends [infer TContext, ...unknown[]] ? TContext
      : TRest extends [(infer TContext)?, ...unknown[]] ? TContext | undefined
      : unknown
    : unknown;
// Preserve released host-only calls regardless of where that overload appears.
type FactoryContext<TFactory> = LastFactoryContext<TFactory> |
  (TFactory extends (host: HarnessHost) => Harness | Promise<Harness> ? undefined : never);
// Intersect across possible factories, not across one context's own union.
type FactoryUnionContext<TFactory> = (TFactory extends unknown ? (context: FactoryContext<TFactory>) => void : never) extends
  (context: infer TContext) => void ? TContext : never;
/** Infer awaited factory context; Harness values and host-only factories accept omitted context. */
export type HarnessContext<TDefinition> =
  [Extract<Awaited<TDefinition>, HarnessFactory>] extends [never] ? unknown : FactoryUnionContext<Extract<Awaited<TDefinition>, HarnessFactory>>;
/** Trusted, live construction data. Never automatically added to prompts, tool inputs or Bash. */
export type HarnessContextOptions<TContext = unknown> = undefined extends TContext ? { context?: TContext } : { context: TContext };
export type CompiledHarnessOptions<TContext = unknown> = { host: HarnessHost } & HarnessContextOptions<TContext>;

export function instantiateHarness<TDefinition extends HarnessDefinition<never>>(
  definition: TDefinition,
  host: HarnessHost | undefined,
  ...context: undefined extends HarnessContext<TDefinition>
    ? [context?: HarnessContext<TDefinition>]
    : [context: HarnessContext<TDefinition>]
): Promise<Harness>;
export function instantiateHarness(definition: HarnessDefinition, host?: HarnessHost): Promise<Harness>;
export async function instantiateHarness<TContext>(definition: HarnessDefinition<TContext>, host?: HarnessHost, context?: TContext): Promise<Harness> {
  if (typeof definition === "function") {
    if (host === undefined) throw new HarnessInputError("An agent factory requires an explicit host.");
    // Omitted context is supported by the legacy overload. Forward by reference, without
    // cloning, serializing or spreading it into the host/config (callbacks/bindings may be live).
    definition = await definition(host, context as TContext);
  }
  if (definition?.config === undefined) throw new HarnessInputError("agent.ts must default-export a Harness or a host factory.");
  return definition;
}

/** Shared by Node discovery and static compilation: inline tools and system take precedence. */
export function assembleHarness(
  base: Harness,
  { tools, skills, workflows, instructions }: { tools: ToolSet; skills: SkillInput[]; workflows: readonly HarnessWorkflow[]; instructions?: string },
  options: { host?: HarnessHost } = {},
): Harness {
  rejectReservedDiscoveredToolNames(Object.keys(tools));
  const system = base.config.system ?? instructions;
  const mergedWorkflows = [...(base.config.workflows ?? []), ...workflows];
  resolveAgentManifest({
    configuredToolNames: Object.keys(base.config.tools),
    discoveredToolNames: Object.keys(tools),
    taskControlToolNames: HARNESS_TASK_CONTROL_TOOL_NAMES,
    workflowInspectionToolNames: HARNESS_WORKFLOW_INSPECTION_TOOL_NAMES,
    agentGroupToolNames: base.config.agents ? HARNESS_AGENT_GROUP_TOOL_NAMES : [],
    workflows: mergedWorkflows,
  });
  return {
    ...base,
    ...(options.host === undefined ? {} : { sessions: options.host.sessions }),
    config: {
      ...base.config,
      ...(options.host === undefined ? {} : { host: options.host }),
      ...(system === undefined ? {} : { system }),
      tools: { ...tools, ...base.config.tools },
      skills: [...base.config.skills, ...skills],
      workflows: mergedWorkflows,
    },
  };
}
