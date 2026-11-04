import { createHash } from "node:crypto";
import { jsonSchema, tool, type JSONSchema7, type ToolExecutionOptions, type ToolSet } from "ai";
import { HarnessInputError } from "../errors.js";
import { dynamicAllowedCapabilities, RUNTIME_RESERVED_TOOL_NAMES } from "../execution/turn-tools.js";
import type { HarnessWarning } from "../types.js";
import { runWithWorkflowRunSlot, WorkflowQueueOverflowError } from "../utils/workflow-concurrency.js";
import {
  workflowHandleFromId,
  type HarnessWorkflow,
  type HarnessWorkflowExecution,
  type HarnessWorkflowRunContext,
} from "../workflows.js";
import { AUTHORED_PLANS_HARNESS_DIR } from "./authored-plans-store.js";
import {
  nextAgentWorkflowRevision,
  readAgentWorkflows,
  writeAgentWorkflow,
  type AgentWorkflowRecord,
} from "./agent-workflows-store.js";
import type { DynamicWorkflowToolsConfig } from "./tools.js";
import type {
  AgentWorkflowBindings,
  AgentWorkflowBuildRecord,
  AgentWorkflowDefinedResult,
  AgentWorkflowDefinition,
  AgentWorkflowOffer,
  AgentWorkflowRegistry,
  AgentWorkflowRegistryContext,
} from "./types.js";

export const DEFINE_WORKFLOW_TOOL_NAME = "define_workflow";

/** What {@link createDefineWorkflowTool} and {@link createAgentWorkflowTools} need besides the dynamic-workflow config. */
export type AgentWorkflowToolsConfig = DynamicWorkflowToolsConfig & {
  /**
   * Where agent-defined workflows run: one store for the whole host, so a plan the planner wrote
   * in one session is kept in the next.
   */
  readonly agentWorkflowsDataDir: string;
  /**
   * The workflows this turn offers: the definitions stored when the turn started, or what the
   * registry's `resolve` chose (see {@link offeredAgentWorkflows}).
   */
  readonly records: readonly AgentWorkflowOffer[];
  /** Every tool name the turn offers, read when `define_workflow` runs. */
  readonly takenToolNames: () => ReadonlySet<string>;
};

type DefineInput = {
  id: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: unknown;
  tools: string[];
  policy?: string;
  models?: string[];
  runWith?: unknown;
};

const WORKFLOW_ID = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*$/u;
const MAX_HANDLE_LENGTH = 64;
// little-workflow's world accepts run ids matching /^run_[A-Za-z0-9_-]{1,80}$/.
const MAX_RUN_ID_LENGTH = 84;

function defineInputSchema(toolNames: readonly string[], modelSlots: readonly string[]) {
  const schema: JSONSchema7 = {
    type: "object",
    properties: {
      id: {
        type: "string",
        description:
          "A stable id such as `lending.preapproval`: letters, digits and `_`, in parts joined by `.`. The workflow's tool is named after it with `.` as `_`. Reuse an id to replace that workflow's definition.",
      },
      description: {
        type: "string",
        description: "What the workflow does and when to call it. It becomes the tool's description.",
      },
      inputSchema: {
        type: "object",
        description: "JSON Schema of the workflow's input, `type: \"object\"`. It becomes the tool's input schema.",
      },
      outputSchema: {
        type: "object",
        description: "JSON Schema of the workflow's result.",
      },
      tools: {
        type: "array",
        items: { type: "string", ...(toolNames.length > 0 ? { enum: [...toolNames] } : {}) },
        description: "The tools the workflow's steps may call: some or all of your own.",
      },
      policy: {
        type: "string",
        description:
          "Rules every model step must follow, such as a lending policy, copied word for word. The runtime adds this text to every model step, and a changed policy sends the saved steps back to the planner.",
      },
      models: {
        type: "array",
        items: { type: "string", enum: [...modelSlots] },
        description:
          "Optional: the model slots its model steps may use, such as only a cheaper one. Default: all of them. `default` is your own model.",
      },
      runWith: {
        description: "Optional: an input to run the workflow with right away, in this call.",
      },
    },
    required: ["id", "description", "inputSchema", "outputSchema", "tools"],
    additionalProperties: false,
  };
  return jsonSchema<DefineInput>(schema);
}

function defineDescription(modelSlots: readonly string[], reviewed: boolean): string {
  return [
    "Turn work you expect to do again into a named workflow. Describe the job, not the steps: its input and output schemas, the tools it may use and any policy its decisions must follow. On the first run a planner writes the steps from that; later runs reuse them without planning again, which costs far less than writing a plan each time.",
    reviewed
      ? "Your host decides when a definition becomes one of your tools, named after its id; it may review it first, and the result says what happens next. Pass `runWith` to run it now as well."
      : "From your next message on, and in every later session, the workflow is one of your tools, named after its id. Pass `runWith` to run it now as well.",
    `Its model steps may use these model slots: ${modelSlots.map((slot) => (slot === "default" ? "default (your own model)" : slot)).join(", ")}. Pass \`models\` to limit them.`,
    "Prefer this over run_ad_hoc_plan when the same kind of request will come again. Calling it again with the same id replaces the definition.",
  ].join("\n\n");
}

/** The `define_workflow` tool. Offered when `dynamicWorkflows()` is on and its factory can build workflows. */
export function createDefineWorkflowTool(config: AgentWorkflowToolsConfig): ToolSet {
  const factory = config.dynamic.factory;
  const define = factory.define?.bind(factory);
  if (define === undefined || config.dynamic.define !== true) return {};
  const nowIso = config.nowIso ?? (() => new Date().toISOString());
  const harnessDir = config.authoredPlansHarnessDir ?? AUTHORED_PLANS_HARNESS_DIR;
  const allowedTools = dynamicAllowedCapabilities(config.parentSnapshot, config.dynamic.exclude).tools;
  const modelSlots = modelSlotsOf(config);
  const ownHandles = new Set(config.records.map((record) => record.handle));

  return {
    [DEFINE_WORKFLOW_TOOL_NAME]: tool({
      description: defineDescription(modelSlots, config.dynamic.registry?.resolve !== undefined),
      inputSchema: defineInputSchema(allowedTools, modelSlots),
      execute: async (args, executeOptions: ToolExecutionOptions<unknown> & { files?: unknown }) => {
        const handle = handleFor(args.id);
        if (typeof handle !== "string") return failed(handle.message);
        if (config.takenToolNames().has(handle) && !ownHandles.has(handle)) {
          return failed(`'${handle}' is already one of your tools. Choose another id.`);
        }
        const unknownTools = args.tools.filter((name) => !allowedTools.includes(name));
        if (unknownTools.length > 0) {
          return failed(
            `Unknown tools: ${unknownTools.join(", ")}. A workflow can use these: ${allowedTools.join(", ") || "none"}.`,
          );
        }
        const unknownModels = (args.models ?? []).filter((slot) => !modelSlots.includes(slot));
        if (unknownModels.length > 0 || args.models?.length === 0) {
          return failed(`models must name some of these slots: ${modelSlots.join(", ")}.`);
        }
        if (!isObjectSchema(args.inputSchema)) {
          return failed("inputSchema must be a JSON Schema with `type: \"object\"`.");
        }
        const definition: AgentWorkflowDefinition = {
          id: args.id,
          description: args.description,
          inputSchema: args.inputSchema,
          outputSchema: args.outputSchema,
          tools: [...new Set(args.tools)],
          ...(args.policy === undefined || args.policy.trim() === "" ? {} : { policy: args.policy }),
          ...(args.models === undefined ? {} : { models: [...new Set(args.models)] }),
        };
        const built = define(definition, bindingsFor(config, definition));
        if (!built.ok) return failed(built.message);

        const files = extractFiles(executeOptions);
        if (files === undefined) return failed("This host has no file store to keep workflows in.");
        const stored = (await readAgentWorkflows(files, harnessDir)).find((record) => record.handle === handle);
        if (stored !== undefined && stored.id !== args.id) {
          return failed(
            `The tool name '${handle}' belongs to your workflow '${stored.id}'. Reuse that id to replace it, or choose an id that makes another tool name.`,
          );
        }
        const record: AgentWorkflowRecord = {
          ...definition,
          handle,
          revision: await nextAgentWorkflowRevision(files, harnessDir, handle, stored?.revision),
          definedAt: nowIso(),
          sessionId: config.sessionId,
        };
        await writeAgentWorkflow(files, harnessDir, record);
        const registered = await registerDefinition(config, record);

        // The run `runWith` starts is built for the stored revision, with what the registry said
        // about it, so a host that traces runs knows which revision ran.
        let workflow = built.workflow;
        if (args.runWith !== undefined) {
          const rebuilt = define(definition, {
            ...bindingsFor(config, definition),
            record: buildRecord({ ...record, ...(registered.metadata === undefined ? {} : { metadata: registered.metadata }) }),
          });
          if (rebuilt.ok) workflow = rebuilt.workflow;
        }
        const run = args.runWith === undefined
          ? undefined
          : await runAgentWorkflow(config, workflow, handle, args.runWith, executeOptions);
        return {
          status: "defined",
          id: record.id,
          tool: handle,
          revision: record.revision,
          note: registered.note ?? `From your next message on, call it as the tool ${handle}.`,
          ...(run === undefined ? {} : { run }),
        };
      },
    }),
  };
}

/**
 * One tool per agent-defined workflow, built from the stored definitions with this turn's tools
 * and models. A definition that no longer builds (a tool it names is gone), whose name is now
 * taken or reserved, or that `define_workflow` would refuse is left out, with a warning.
 */
export function createAgentWorkflowTools(
  config: AgentWorkflowToolsConfig,
): { readonly tools: ToolSet; readonly warnings: readonly HarnessWarning[] } {
  const define = config.dynamic.factory.define?.bind(config.dynamic.factory);
  if (define === undefined || config.dynamic.define !== true) return { tools: {}, warnings: [] };
  const taken = config.takenToolNames();
  const available = new Set(dynamicAllowedCapabilities(config.parentSnapshot, config.dynamic.exclude).tools);
  const tools: ToolSet = {};
  const warnings: HarnessWarning[] = [];
  const skip = (record: AgentWorkflowOffer, reason: string) =>
    warnings.push({
      code: "policy_warning",
      message: `Agent-defined workflow '${record.id}' is not offered this turn: ${reason}`,
      metadata: { workflowId: record.id, revision: record.revision },
    });

  for (const record of config.records) {
    // A stored file is written by define_workflow but read back as data: check it the same way.
    try {
      const handle = handleFor(record.id);
      if (typeof handle !== "string") {
        skip(record, handle.message);
        continue;
      }
      if (handle !== record.handle) {
        skip(record, `its stored tool name '${record.handle}' does not match its id.`);
        continue;
      }
      if (!isObjectSchema(record.inputSchema)) {
        skip(record, "its inputSchema is not a JSON Schema with `type: \"object\"`.");
        continue;
      }
      if (taken.has(record.handle) || Object.hasOwn(tools, record.handle)) {
        skip(record, `the tool name '${record.handle}' is taken.`);
        continue;
      }
      const missing = record.tools.filter((name) => !available.has(name));
      if (missing.length > 0) {
        skip(record, `it uses tools this agent no longer has (${missing.join(", ")}).`);
        continue;
      }
      const missingModels = (record.models ?? []).filter((slot) => !modelSlotsOf(config).includes(slot));
      if (missingModels.length > 0) {
        skip(record, `it uses model slots this agent no longer has (${missingModels.join(", ")}).`);
        continue;
      }
      const built = define(record, { ...bindingsFor(config, record), record: buildRecord(record) });
      if (!built.ok) {
        skip(record, built.message);
        continue;
      }
      const workflow = built.workflow;
      tools[record.handle] = tool({
        description:
          `${record.description}\n\n(A workflow you defined with define_workflow, revision ${record.revision}. ` +
          "Its first run planned the steps; later runs reuse them.)",
        inputSchema: jsonSchema(record.inputSchema as JSONSchema7),
        execute: async (input, executeOptions) =>
          runAgentWorkflow(config, workflow, record.handle, input, executeOptions),
      });
    } catch (error) {
      skip(record, error instanceof Error ? error.message : String(error));
    }
  }
  return { tools, warnings };
}

/**
 * The workflows a turn offers. Without a registry (or one with no `resolve`), every stored
 * definition. With one, what its `resolve` returns; when that throws, none, with a warning, so a
 * registry that cannot be reached never offers a workflow it would have refused.
 */
export async function offeredAgentWorkflows(
  records: readonly AgentWorkflowRecord[],
  registry: AgentWorkflowRegistry | undefined,
  ctx: AgentWorkflowRegistryContext,
): Promise<{ readonly offers: readonly AgentWorkflowOffer[]; readonly warnings: readonly HarnessWarning[] }> {
  const resolve = registry?.resolve;
  if (resolve === undefined) return { offers: records, warnings: [] };
  try {
    const offers = await resolve.call(registry, records, ctx);
    if (!Array.isArray(offers)) throw new TypeError("resolve must return an array of workflows.");
    return { offers, warnings: [] };
  } catch (error) {
    return {
      offers: [],
      warnings: [
        {
          code: "policy_warning",
          message: `Agent-defined workflows are not offered this turn: the registry could not resolve them (${
            error instanceof Error ? error.message : String(error)
          }).`,
        },
      ],
    };
  }
}

/** Tell the registry about a stored revision. Its failure is reported to the agent, never thrown. */
async function registerDefinition(
  config: AgentWorkflowToolsConfig,
  record: AgentWorkflowRecord,
): Promise<AgentWorkflowDefinedResult> {
  const registry = config.dynamic.registry;
  const defined = registry?.defined;
  if (defined === undefined) return {};
  try {
    const result = await defined.call(registry, record, { sessionId: config.sessionId, turnId: config.turnId });
    return typeof result === "object" && result !== null ? result : {};
  } catch (error) {
    return {
      note:
        `Stored, but the host could not register it (${error instanceof Error ? error.message : String(error)}). ` +
        `It may not be offered as the tool ${record.handle} until it is registered.`,
    };
  }
}

function buildRecord(offer: AgentWorkflowOffer): AgentWorkflowBuildRecord {
  return {
    handle: offer.handle,
    revision: offer.revision,
    ...(offer.metadata === undefined ? {} : { metadata: offer.metadata }),
  };
}

function bindingsFor(config: AgentWorkflowToolsConfig, definition: AgentWorkflowDefinition): AgentWorkflowBindings {
  const own = { ...(config.parentSnapshot.mcpTools ?? {}), ...(config.parentSnapshot.tools ?? {}) };
  const models: Record<string, unknown> = { default: config.model, ...(config.dynamic.models ?? {}) };
  const slots = definition.models ?? Object.keys(models);
  return {
    tools: Object.fromEntries(definition.tools.filter((name) => name in own).map((name) => [name, own[name]])),
    models: Object.fromEntries(slots.filter((slot) => slot in models).map((slot) => [slot, models[slot]])),
    planner: config.model,
  };
}

function modelSlotsOf(config: AgentWorkflowToolsConfig): readonly string[] {
  return ["default", ...Object.keys(config.dynamic.models ?? {})];
}

async function runAgentWorkflow(
  config: AgentWorkflowToolsConfig,
  workflow: HarnessWorkflow,
  handle: string,
  input: unknown,
  executeOptions: ToolExecutionOptions<unknown>,
): Promise<Record<string, unknown>> {
  const toolCallId = executeOptions.toolCallId ?? `${handle}_manual`;
  // Every session shares the store, and provider tool call ids (`call_0`) repeat across sessions
  // and turns, so the run id hashes all three.
  const hash = createHash("sha256")
    .update(`${config.sessionId} ${config.turnId} ${toolCallId}`)
    .digest("hex")
    .slice(0, 12);
  const runId = `run_${handle.slice(0, MAX_RUN_ID_LENGTH - "run__".length - hash.length)}_${hash}`;
  const abortSignal = executeOptions.abortSignal ?? config.abortSignal;
  const ctx: HarnessWorkflowRunContext = {
    protocolVersion: 1,
    workflowId: workflow.id,
    workflowHandle: handle,
    definitionIdentity: workflow.definitionIdentity,
    toolCallId,
    disposition: "await",
    parentSessionId: config.sessionId,
    parentTurnId: config.turnId,
    originTurnId: config.originTurnId,
    reservedRunId: runId,
    persistence: { dataDir: config.agentWorkflowsDataDir, ...(config.fs === undefined ? {} : { fs: config.fs }) },
    ...(abortSignal ? { abortSignal } : {}),
    inheritance: {},
    // The workflow was built with its tools and models bound; it reads nothing from here.
    capabilities: {
      tools: {},
      mcpTools: {},
      bash: {},
      code: {},
      workflows: {},
      skills: {},
      mounts: [],
      permissions: { approvalPolicy: "reject_ask" },
    },
    observation: {
      async recordProgress() {},
    },
  };

  let execution: HarnessWorkflowExecution;
  try {
    execution = await runWithWorkflowRunSlot(config.sessionId, config.budgets, () => workflow.runForHarness(input, ctx));
  } catch (error) {
    if (error instanceof WorkflowQueueOverflowError) {
      return { status: "failed", runId, causeCode: error.causeCode, message: error.message };
    }
    throw error;
  }
  if (execution.status === "completed") {
    return { status: "completed", runId: execution.runId, output: execution.output };
  }
  if (execution.status === "failed" || execution.status === "cancelled") {
    return {
      status: execution.status,
      runId: execution.runId,
      causeCode: execution.causeCode,
      message: execution.message,
      ...(execution.summary === undefined ? {} : { summary: execution.summary }),
    };
  }
  return { status: "running", runId: execution.runId };
}

function handleFor(id: string): string | { readonly message: string } {
  if (!WORKFLOW_ID.test(id)) {
    return { message: "id must be letters, digits and `_`, in parts joined by `.`, each part starting with a letter." };
  }
  let handle: string;
  try {
    handle = workflowHandleFromId(id);
  } catch (error) {
    if (error instanceof HarnessInputError) return { message: `id '${id}' does not make a valid tool name.` };
    throw error;
  }
  if (handle.length > MAX_HANDLE_LENGTH) return { message: `id is too long; keep it under ${MAX_HANDLE_LENGTH} characters.` };
  if (handle.startsWith("start_")) return { message: "id cannot begin with `start.` or `start_`; those names are reserved." };
  if (RUNTIME_RESERVED_TOOL_NAMES.has(handle)) return { message: `id '${id}' makes the tool name '${handle}', which is reserved.` };
  return handle;
}

function isObjectSchema(value: unknown): boolean {
  return typeof value === "object" && value !== null && (value as { type?: unknown }).type === "object";
}

function failed(message: string): Record<string, unknown> {
  return { status: "failed", causeCode: "plan_invalid", message };
}

type StoreFiles = Parameters<typeof writeAgentWorkflow>[0];

function extractFiles(executeOptions: { files?: unknown }): StoreFiles | undefined {
  const files = executeOptions.files;
  return files && typeof (files as { writeText?: unknown }).writeText === "function"
    ? (files as StoreFiles)
    : undefined;
}
