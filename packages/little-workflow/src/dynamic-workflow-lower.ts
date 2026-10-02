import { registerWorkflowVersion, validateLwir, type LwirStep, type LwirWorkflow, type WorkflowVersion } from "./lwir.js";
import { normalizeSchema } from "./schema.js";
import type { AdHocPlan, AdHocPlanStep } from "./dynamic-workflow-plan.js";

export type LowerAdHocPlanResult =
  | { readonly ok: true; readonly version: WorkflowVersion; readonly lwir: LwirWorkflow }
  | { readonly ok: false; readonly message: string; readonly findings?: readonly unknown[] };

export function lowerAdHocPlan(
  plan: AdHocPlan,
  opts: { outputSchema: unknown; referenced: { tools: readonly string[]; models: readonly string[]; bash: boolean }; name: string },
): LowerAdHocPlanResult {
  let steps: LwirStep[];
  try {
    steps = plan.steps.map((s) => lowerStep(s));
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }

  const lwir: LwirWorkflow = {
    apiVersion: "littleworkflow.dev/v0.1",
    kind: "Workflow",
    metadata: { name: opts.name },
    input: { schema: normalizeSchema(true) },
    output: { schema: normalizeSchema(opts.outputSchema) },
    permissions: {
      models: [...opts.referenced.models],
      tools: [...opts.referenced.tools],
      secrets: [],
      network: [],
    },
    steps,
  };

  const validation = validateLwir(lwir);
  if (!validation.valid) {
    return { ok: false, message: "Lowered plan failed LWIR validation.", findings: validation.findings };
  }
  const version = registerWorkflowVersion(lwir);
  return { ok: true, version, lwir: version.lwir };
}

function lowerStep(step: AdHocPlanStep): LwirStep {
  const base = {
    id: step.id,
    ...(step.needs && step.needs.length > 0 ? { needs: [...step.needs] } : {}),
    // Every non-decision LWIR step must declare an output contract (validateLwir).
    // When the plan step omits one, default to unconstrained JSON: it coerces nothing
    // at runtime and stays referencable via `{{ steps.X.output }}` (a json output with a
    // schema present does not trigger `output.missing_schema`). Decision steps must NOT
    // declare an output, so they are excluded below.
    ...(step.output
      ? { output: normalizeStepOutput(step.output) }
      : step.uses === "decision"
        ? {}
        : { output: { mode: "json" as const, schema: normalizeSchema(true) } }),
  };
  if (step.uses === "tool.call") {
    if (typeof step.tool !== "string" || step.tool.length === 0) {
      throw new Error(`Step ${step.id}: tool.call requires a tool name.`);
    }
    return { ...base, uses: "tool.call", with: { tool: step.tool, args: step.with ?? {} } };
  }
  if (step.uses === "ai.generate") {
    if (typeof step.model !== "string" || step.model.length === 0) {
      throw new Error(`Step ${step.id}: ai.generate requires a model slot.`);
    }
    const withField: Record<string, unknown> = { model: step.model };
    // Agentic bash is signalled to the runtime via the presence of bashCapabilities at run time;
    // record intent on the step so the harness knows this step wants bash.
    if (step.bash === true) withField.bash = true;
    return {
      ...base,
      uses: "ai.generate",
      input: step.prompt ?? "",
      with: withField,
    };
  }
  // code.run / parallel / decision pass with/steps through unchanged in v1.
  return { ...base, uses: step.uses, ...(step.with ? { with: step.with } : {}) } as LwirStep;
}

function normalizeStepOutput(output: NonNullable<AdHocPlanStep["output"]>) {
  return {
    mode: output.mode,
    ...(output.schema !== undefined ? { schema: normalizeSchema(output.schema) } : {}),
    ...(output.values !== undefined ? { values: output.values } : {}),
  };
}

export type ReferencedCapabilities = { tools: string[]; models: string[]; bash: boolean };
export type AllowedCapabilities = { readonly tools: readonly string[]; readonly models: readonly string[]; readonly bash: boolean };

export function referencedCapabilities(plan: AdHocPlan): ReferencedCapabilities {
  const tools = new Set<string>();
  const models = new Set<string>();
  let bash = false;
  for (const step of plan.steps) {
    if (step.uses === "tool.call" && typeof step.tool === "string") tools.add(step.tool);
    if (step.uses === "ai.generate" && typeof step.model === "string") models.add(step.model);
    if (step.uses === "ai.generate" && step.bash === true) bash = true;
  }
  return { tools: [...tools].sort(), models: [...models].sort(), bash };
}

export function subsetCheck(referenced: ReferencedCapabilities, allowed: AllowedCapabilities):
  | { ok: true } | { ok: false; message: string } {
  const allowTools = new Set(allowed.tools);
  for (const t of referenced.tools) {
    if (!allowTools.has(t)) return { ok: false, message: `Tool '${t}' is not in the agent's capability snapshot.` };
  }
  const allowModels = new Set(allowed.models);
  for (const m of referenced.models) {
    if (!allowModels.has(m)) return { ok: false, message: `Model slot '${m}' is not available (use "default").` };
  }
  if (referenced.bash && !allowed.bash) {
    return { ok: false, message: "This plan uses bash, but the agent's snapshot does not grant bash." };
  }
  return { ok: true };
}
