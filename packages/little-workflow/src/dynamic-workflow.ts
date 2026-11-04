import type {
  AgentWorkflowDefinition,
  AgentWorkflowRegistry,
  DynamicWorkflowLimits,
  DynamicWorkflowsConfig,
} from "@little-stack/harness";
import type { IFileSystem } from "just-bash";
import { littleWorkflowDynamicWorkflowFactory } from "./dynamic-workflow-factory.js";
import type { World } from "./world-port.js";

/** What a {@link DynamicWorkflowWorld} factory is told about the run it stores. */
export type DynamicWorkflowWorldContext = {
  /** `defined`: a workflow the agent defined with `define_workflow`. `ad_hoc`: a `run_ad_hoc_plan` plan. */
  readonly kind: "defined" | "ad_hoc";
  /** The workflow's id, such as `lending.preapproval` (`ad_hoc_plan` for a one-shot plan). */
  readonly workflowId: string;
  /** The tool name the agent called it by. */
  readonly handle: string;
  readonly runId: string;
  /** The store the harness keeps for these runs. The default World uses fs when supplied. */
  readonly dataDir: string;
  /** Exact host data filesystem, when runs have no disk. Wrappers must preserve its identity. */
  readonly fs?: IFileSystem;
  /** The harness session, turn and tool call that started the run. */
  readonly sessionId: string;
  readonly turnId: string;
  readonly toolCallId: string;
  /** A defined workflow's definition, as the turn offered it. */
  readonly definition?: AgentWorkflowDefinition;
  /** The offered revision, and any metadata the registry attached to it (such as a version id). */
  readonly revision?: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
};

/**
 * Where agent-made workflow runs are stored: one World for every run, or a function that picks
 * one per run (for example a tracing wrapper around `localWorld({ dataDir: ctx.dataDir })`).
 */
export type DynamicWorkflowWorld = World | ((context: DynamicWorkflowWorldContext) => World);

export function dynamicWorkflows(
  options: {
    exclude?: readonly string[];
    limits?: Partial<DynamicWorkflowLimits>;
    /**
     * Model slots a plan's `ai.generate` steps may name besides `default` (the agent's own model),
     * for example `{ fast: anthropic("claude-haiku-5-5") }`.
     */
    models?: Readonly<Record<string, unknown>>;
    /**
     * Give the agent `define_workflow`, so it can turn recurring work into a named workflow: the
     * agent's model plans the steps once, later runs keep them, and from the next message on the
     * workflow is one of its tools, in this and every later session on the same host. Default `true`.
     */
    define?: boolean;
    /**
     * Decide which agent-defined workflows each turn offers (for example only approved ones), and
     * hear about every new definition. Without one, every stored definition is offered.
     */
    registry?: AgentWorkflowRegistry;
    /**
     * Where agent-defined workflow and one-shot plan runs are stored. By default the host's
     * filesystem selects virtualWorld or localWorld, under its workflow data directory.
     */
    world?: DynamicWorkflowWorld;
  } = {},
): DynamicWorkflowsConfig {
  return {
    enabled: true,
    factory: littleWorkflowDynamicWorkflowFactory(options.world === undefined ? {} : { world: options.world }),
    ...(options.exclude ? { exclude: options.exclude } : {}),
    ...(options.limits ? { limits: options.limits } : {}),
    ...(options.models ? { models: options.models } : {}),
    ...(options.define === undefined ? {} : { define: options.define }),
    ...(options.registry === undefined ? {} : { registry: options.registry }),
  };
}

export { littleWorkflowDynamicWorkflowFactory } from "./dynamic-workflow-factory.js";
export type { AdHocPlan, AdHocPlanStep } from "./dynamic-workflow-plan.js";
