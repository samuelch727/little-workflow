import type { JsonObject } from "../types.js";
import type { HarnessWorkflow } from "../workflows.js";

export type DynamicWorkflowLimits = {
  readonly maxSteps: number;
  readonly maxRuntimeMs: number;
};

export type DynamicAllowedCapabilities = {
  readonly tools: readonly string[]; // parent-snapshot tool + MCP handle names, minus exclude
  readonly models: readonly string[]; // "default" (the agent's model), then any `models` slots
  readonly bash: boolean; // parent snapshot has bash, and not excluded
};

export type DynamicPlanSubmission = {
  readonly purpose: string;
  readonly reasonConfiguredWorkflowsDoNotFit?: string;
  readonly plan: unknown; // untrusted, model-authored step-DAG
  readonly input: unknown;
  readonly outputSchema: unknown; // JSON schema (or true)
  readonly allowed: DynamicAllowedCapabilities;
  readonly limits: DynamicWorkflowLimits;
};

export type DynamicReferencedCapabilities = {
  readonly tools: readonly string[];
  readonly models: readonly string[];
  readonly bash: boolean;
};

export type DynamicCompileResult =
  | {
      readonly ok: true;
      readonly workflow: HarnessWorkflow;
      readonly definitionHash: string; // == workflow.definitionIdentity
      readonly lwir: unknown; // frozen LwirWorkflow (for the artifact record)
      readonly referenced: DynamicReferencedCapabilities;
    }
  | {
      readonly ok: false;
      readonly causeCode: "plan_invalid" | "capability_not_allowed";
      readonly message: string;
      readonly findings?: readonly unknown[];
    };

/**
 * A workflow the agent defined with `define_workflow`: what a developer writes in
 * `defineWorkflow`, minus the code. The planner writes the steps on the first run.
 */
export type AgentWorkflowDefinition = {
  readonly id: string;
  readonly description: string;
  readonly inputSchema: unknown; // JSON Schema
  readonly outputSchema: unknown; // JSON Schema
  readonly tools: readonly string[]; // names of the agent's own tools
  readonly policy?: string;
  /** The model slots its model steps may use. Default: all of them. */
  readonly models?: readonly string[];
};

/**
 * A workflow the agent defined with `define_workflow`, as stored. Kept next to the authored
 * one-shot plans (under `/persistent/dynamic-plans/workflows/`), so every session on the same
 * host data dir loads the same definitions.
 */
export type AgentWorkflowRecord = AgentWorkflowDefinition & {
  /** The workflow's tool name: its id with `.` and other characters outside `[A-Za-z0-9_]` as `_`. */
  readonly handle: string;
  /** 1 for the first definition, then one more for each `define_workflow` call with this id. */
  readonly revision: number;
  readonly definedAt: string;
  /** The session that wrote this revision. */
  readonly sessionId: string;
};

/**
 * One agent-defined workflow a turn offers as a tool: a stored record, or a definition an
 * {@link AgentWorkflowRegistry} supplies (for example the approved version a review service holds).
 */
export type AgentWorkflowOffer = AgentWorkflowDefinition & {
  readonly handle: string;
  readonly revision: number;
  /**
   * Host data the registry attaches, such as the version id a review service gave this
   * definition. Handed to the factory with the bindings; never shown to the model.
   */
  readonly metadata?: JsonObject;
};

/** Which offered revision a factory build is for. */
export type AgentWorkflowBuildRecord = {
  readonly handle: string;
  readonly revision: number;
  readonly metadata?: JsonObject;
};

/** What a registry hook is told about the turn it runs in. */
export type AgentWorkflowRegistryContext = {
  readonly sessionId: string;
  readonly turnId: string;
};

/** What `defined` may return: a note for the agent, and metadata for the run `runWith` starts. */
export type AgentWorkflowDefinedResult = {
  /** Replaces the default note in `define_workflow`'s result, e.g. "saved as a draft for review". */
  readonly note?: string;
  /** Attached to this revision for the run `runWith` starts now, like {@link AgentWorkflowOffer.metadata}. */
  readonly metadata?: JsonObject;
};

/**
 * Hooks that put agent-defined workflows under the host's control, for example behind a review.
 * Without a registry every stored definition is offered from the next turn on, in every session.
 */
export type AgentWorkflowRegistry = {
  /**
   * Called after `define_workflow` stored a revision, so the host can register it somewhere
   * (as a draft waiting for review, say). An error here does not undo the definition: the agent
   * is told it could not be registered.
   */
  readonly defined?: (
    record: AgentWorkflowRecord,
    ctx: AgentWorkflowRegistryContext,
  ) => void | AgentWorkflowDefinedResult | Promise<void | AgentWorkflowDefinedResult>;
  /**
   * Called when a turn starts, with every stored definition. Returns the workflows the turn
   * offers: a subset of the records, other revisions of them, or definitions the registry holds
   * itself. Leave one out and it is not a tool this turn. Whether the session that defined a
   * workflow sees its own unapproved revision is the registry's choice. When this throws, the
   * turn offers no agent-defined workflow and carries a warning.
   */
  readonly resolve?: (
    records: readonly AgentWorkflowRecord[],
    ctx: AgentWorkflowRegistryContext,
  ) => readonly AgentWorkflowOffer[] | Promise<readonly AgentWorkflowOffer[]>;
};

/** The agent's live capabilities an agent-defined workflow runs with, resolved each turn. */
export type AgentWorkflowBindings = {
  /** The definition's tools, by name (a subset of the agent's tools and MCP handles). */
  readonly tools: Readonly<Record<string, unknown>>;
  /**
   * Step model slots: `default` (the agent's model) and any `dynamicWorkflows({ models })` slots,
   * narrowed to the definition's `models` when it names some.
   */
  readonly models: Readonly<Record<string, unknown>>;
  /** The model that plans the steps: the agent's own model. */
  readonly planner: unknown;
  /**
   * The offered revision this build is for, with its registry metadata. Absent while
   * `define_workflow` checks a new definition before storing it.
   */
  readonly record?: AgentWorkflowBuildRecord;
};

export type AgentWorkflowBuildResult =
  | {
      readonly ok: true;
      /** Runs in `ctx.persistence.dataDir`, which the harness keeps per host, not per session. */
      readonly workflow: HarnessWorkflow;
    }
  | { readonly ok: false; readonly message: string };

export interface DynamicWorkflowFactory {
  compile(submission: DynamicPlanSubmission): DynamicCompileResult;
  /** Builds an agent-defined workflow. Without it, the agent gets no `define_workflow` tool. */
  define?(definition: AgentWorkflowDefinition, bindings: AgentWorkflowBindings): AgentWorkflowBuildResult;
}

export type DynamicWorkflowsConfig = {
  readonly enabled: true;
  readonly factory: DynamicWorkflowFactory;
  readonly exclude?: readonly string[];
  readonly limits?: Partial<DynamicWorkflowLimits>;
  /**
   * Model slots a plan's `ai.generate` steps may name besides `default` (the agent's own model),
   * for example `{ fast: anthropic("claude-haiku-5-5") }`.
   */
  readonly models?: Readonly<Record<string, unknown>>;
  /**
   * Give the agent `define_workflow`, so it can turn recurring work into a named workflow that
   * becomes one of its tools in every later session. Default `true`.
   */
  readonly define?: boolean;
  /**
   * Decide which agent-defined workflows each turn offers, and hear about each new definition.
   * Without one, a definition is a tool from the next turn on, in every session on the host.
   */
  readonly registry?: AgentWorkflowRegistry;
};
