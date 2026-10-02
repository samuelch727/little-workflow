import type {
  DynamicCompileResult,
  DynamicPlanSubmission,
  DynamicWorkflowFactory,
  HarnessWorkflow,
  HarnessWorkflowExecution,
  HarnessWorkflowRunContext,
} from "little-harness";
import { localWorld, model } from "./authoring.js";
import type { BashCapabilities } from "./bash-tool.js";
import {
  compileWorkflow,
  type CompilableWorkflowDefinition,
  type PlannerAdapter,
} from "./compiler.js";
import { parseAdHocPlan } from "./dynamic-workflow-plan.js";
import { mapWorkflowError } from "./harness-workflow.js";
import {
  lowerAdHocPlan,
  referencedCapabilities,
  subsetCheck,
  type ReferencedCapabilities,
} from "./dynamic-workflow-lower.js";
import type { LwirWorkflow } from "./lwir.js";
import { executeWorkflowVersion, type ExecuteWorkflowVersionOptions } from "./runtime.js";
import { createToolRegistry, type AiSdkTool, type ToolRegistry } from "./tool-registry.js";
import type { RunId } from "./world.js";

// The workflow id doubles as the frozen LWIR's metadata.name; the compiler's
// request-binding check (validateRequestBinding) requires the two to match.
const AD_HOC_WORKFLOW_ID = "ad_hoc_plan";

export function littleWorkflowDynamicWorkflowFactory(): DynamicWorkflowFactory {
  return {
    compile(submission: DynamicPlanSubmission): DynamicCompileResult {
      const parsed = parseAdHocPlan(submission.plan);
      if (!parsed.ok) {
        return { ok: false, causeCode: "plan_invalid", message: parsed.message };
      }

      if (parsed.plan.steps.length > submission.limits.maxSteps) {
        return {
          ok: false,
          causeCode: "plan_invalid",
          message: `Plan exceeds maxSteps (${submission.limits.maxSteps}).`,
        };
      }

      const referenced = referencedCapabilities(parsed.plan);
      const subset = subsetCheck(referenced, submission.allowed);
      if (!subset.ok) {
        return { ok: false, causeCode: "capability_not_allowed", message: subset.message };
      }

      const lowered = lowerAdHocPlan(parsed.plan, {
        outputSchema: submission.outputSchema,
        referenced,
        name: AD_HOC_WORKFLOW_ID,
      });
      if (!lowered.ok) {
        return {
          ok: false,
          causeCode: "plan_invalid",
          message: lowered.message,
          ...(lowered.findings ? { findings: lowered.findings } : {}),
        };
      }

      const workflow = buildHarnessWorkflow({
        lwir: lowered.lwir,
        definitionHash: lowered.version.hash,
        referenced,
        outputSchema: submission.outputSchema,
        maxRuntimeMs: submission.limits.maxRuntimeMs,
      });
      return {
        ok: true,
        workflow,
        definitionHash: lowered.version.hash,
        lwir: lowered.lwir,
        referenced,
      };
    },
  };
}

function buildHarnessWorkflow(frozen: {
  readonly lwir: LwirWorkflow;
  readonly definitionHash: string;
  readonly referenced: ReferencedCapabilities;
  readonly outputSchema: unknown;
  readonly maxRuntimeMs: number;
}): HarnessWorkflow {
  return {
    id: AD_HOC_WORKFLOW_ID,
    description: "Model-authored one-shot plan.",
    inputSchema: { kind: "untyped", allowUntypedInput: true },
    executionMode: "inline",
    // Stable, model-independent identity: the frozen LWIR hash. The runtime
    // WorkflowVersion (which carries the capability lock) is minted lazily in
    // runForHarness, once the concrete models/tools are known.
    definitionIdentity: frozen.definitionHash,
    async runForHarness(
      input: unknown,
      ctx: HarnessWorkflowRunContext,
    ): Promise<HarnessWorkflowExecution> {
      try {
        const tools = toolRegistryFromContext(ctx);
        const models = modelsFromContext(ctx, frozen.referenced.models);
        const bashCapabilities = frozen.referenced.bash ? bashFromContext(ctx) : undefined;

        // The capability lock binds the frozen LWIR to the concrete model
        // identities and tool descriptors — data only available here, at run
        // time, via ctx.capabilities. So we mint the locked WorkflowVersion now
        // by driving the real compiler with a pass-through planner that returns
        // our already-frozen LWIR. This reuses the production lock construction
        // (finalizeValidLwir) verbatim, guaranteeing the lock matches the
        // runtime capability checks in executeWorkflowVersion.
        const workflowDefinition: CompilableWorkflowDefinition = {
          id: AD_HOC_WORKFLOW_ID,
          description: "Model-authored one-shot plan.",
          inputSchema: true,
          outputSchema: frozen.outputSchema,
          models: frozen.referenced.models.map((slot) => model(rawModelFor(ctx, slot), { id: slot })),
          globalTools: [...frozen.referenced.tools],
          toolSelection: "planner_selected",
          ...(bashCapabilities !== undefined ? { bash: bashCapabilities } : {}),
        };
        const planner: PlannerAdapter = { draft: async () => frozen.lwir };
        const compiled = await compileWorkflow(workflowDefinition, {
          input,
          planner,
          tools,
          ...(bashCapabilities !== undefined ? { bash: bashCapabilities } : {}),
        });

        // Fail fast on silent substitution. If the frozen LWIR fails
        // validateRequestBinding, the pass-through planner keeps returning the
        // same invalid LWIR every revision and compileWorkflow falls through to
        // synthesizeSimpleLwir (compiler.ts:628), which — for a tool-less
        // ai.generate-shaped plan — can produce a VALID *substitute*. Running
        // that would execute a plan whose hash differs from the reported
        // definitionIdentity: a silent replay-proof divergence. Refuse instead.
        if (compiled.workflowVersion.lwirHash !== frozen.definitionHash) {
          return {
            protocolVersion: 1,
            status: "failed",
            runId: ctx.reservedRunId,
            causeCode: "workflow_failed",
            message:
              "Frozen ad-hoc plan failed capability binding; refusing to run a substituted plan.",
          };
        }

        // Enforce the plan's runtime budget: a run that exceeds maxRuntimeMs aborts with a
        // TimeoutError-named reason, which executeWorkflowVersion surfaces as a RunFailedError
        // (causeCode "timeout"), mapped below. Compose with the incoming cancel signal so an
        // upstream cancel still wins. (AbortSignal.any/timeout require Node >=17.3/20.3; the
        // package targets Node >=20.19.)
        const timeoutSignal = AbortSignal.timeout(frozen.maxRuntimeMs);
        const signal = ctx.abortSignal
          ? AbortSignal.any([ctx.abortSignal, timeoutSignal])
          : timeoutSignal;
        const options: ExecuteWorkflowVersionOptions = {
          world: localWorld({ dataDir: ctx.persistence.dataDir }),
          workflowVersion: compiled.workflowVersion,
          input,
          runId: ctx.reservedRunId as RunId,
          tools,
          models,
          ...(bashCapabilities !== undefined ? { bashCapabilities } : {}),
          signal,
          progress: async (event) => {
            await ctx.observation.recordProgress(event);
          },
        };
        const result = await executeWorkflowVersion(options);
        if (result.status === "completed") {
          return { protocolVersion: 1, status: "completed", runId: result.runId, output: result.output };
        }
        // A budget overrun / cancel surfaces here as a *returned* failed result whose
        // `error` envelope carries the terminal causeCode (executeWorkflowVersion records the
        // cancellation and returns rather than throwing). Preserve "timeout"/"cancelled" instead
        // of flattening every failure to workflow_failed.
        const runtimeCauseCode = terminalCauseCodeFor(result.error);
        const runtimeMessage =
          isRecord(result.error) && typeof result.error.message === "string"
            ? result.error.message
            : undefined;
        if (runtimeCauseCode === "cancelled") {
          return {
            protocolVersion: 1,
            status: "cancelled",
            runId: result.runId,
            causeCode: "cancelled",
            message: runtimeMessage ?? "Ad-hoc plan run was cancelled.",
          };
        }
        if (runtimeCauseCode === "timeout") {
          return {
            protocolVersion: 1,
            status: "failed",
            runId: result.runId,
            causeCode: "timeout",
            message: runtimeMessage ?? "Ad-hoc plan run timed out.",
          };
        }
        return {
          protocolVersion: 1,
          status: "failed",
          runId: result.runId,
          causeCode: "workflow_failed",
          message: runtimeMessage ?? "Ad-hoc plan run failed.",
        };
      } catch (error) {
        // A runtime-budget overrun (or upstream cancel) surfaces here as a RunFailedError /
        // TimeoutError / AbortError; map it to the right terminal envelope (causeCode "timeout"
        // for the budget overrun) rather than a generic workflow_failed.
        const mapped = mapWorkflowError(error, ctx.reservedRunId);
        if (mapped !== undefined) return mapped;
        return {
          protocolVersion: 1,
          status: "failed",
          runId: ctx.reservedRunId,
          causeCode: "workflow_failed",
          message: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// The terminal cancellation causeCode ("timeout"/"cancelled") carried on a returned failed
// runtime result's `error` envelope; undefined for any other (step-level) failure.
function terminalCauseCodeFor(error: unknown): "timeout" | "cancelled" | undefined {
  if (isRecord(error) && (error.causeCode === "timeout" || error.causeCode === "cancelled")) {
    return error.causeCode;
  }
  return undefined;
}

function toolRegistryFromContext(ctx: HarnessWorkflowRunContext): ToolRegistry {
  const tools = (ctx.capabilities?.tools ?? {}) as Record<string, AiSdkTool>;
  const mcp = (ctx.capabilities?.mcpTools ?? {}) as Record<string, AiSdkTool>;
  return createToolRegistry({ ...tools, ...mcp });
}

function rawModelFor(ctx: HarnessWorkflowRunContext, slot: string): unknown {
  // HarnessChildCapabilities (little-harness) does not declare `models`; the
  // harness (Task 10) places the raw aiSdkModel under
  // ctx.capabilities.models[slot], read here via a cast (Pre-flight fact #2).
  const provided =
    (ctx.capabilities as { models?: Record<string, unknown> } | undefined)?.models ?? {};
  return provided[slot];
}

function modelsFromContext(
  ctx: HarnessWorkflowRunContext,
  modelSlots: readonly string[],
): Record<string, unknown> {
  // executeWorkflowVersion wants ModelSlot values, so wrap each raw model with
  // model(rawModel, { id: slot }) — the same wrapping used for the compiler's
  // workflow.models, so the lock's model identity matches the runtime binding.
  const provided =
    (ctx.capabilities as { models?: Record<string, unknown> } | undefined)?.models ?? {};
  return Object.fromEntries(
    modelSlots
      .filter((slot) => slot in provided)
      .map((slot) => [slot, model(provided[slot], { id: slot })]),
  );
}

function bashFromContext(ctx: HarnessWorkflowRunContext): BashCapabilities | undefined {
  return (ctx.capabilities?.bash as { capabilities?: BashCapabilities } | undefined)?.capabilities;
}
