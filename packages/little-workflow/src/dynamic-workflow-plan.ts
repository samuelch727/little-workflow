export type AdHocPlanStepUses = "tool.call" | "ai.generate" | "code.run" | "parallel" | "decision";

export type AdHocPlanStep = {
  readonly id: string;
  readonly uses: AdHocPlanStepUses;
  readonly needs?: readonly string[];
  readonly tool?: string;                 // tool.call
  readonly model?: string;                // ai.generate
  readonly prompt?: string;               // ai.generate
  readonly bash?: boolean;                // ai.generate: requires the agent's bash grant; the step itself runs no tools
  readonly with?: Record<string, unknown>;
  readonly output?: { readonly mode: "text" | "object" | "array" | "choice" | "json"; readonly schema?: unknown; readonly values?: readonly string[] };
};

export type AdHocPlan = {
  readonly steps: readonly AdHocPlanStep[];
  readonly output: { readonly from: string };
};

export type ParseAdHocPlanResult =
  | { readonly ok: true; readonly plan: AdHocPlan }
  | { readonly ok: false; readonly message: string };

const STEP_USES = new Set<AdHocPlanStepUses>(["tool.call", "ai.generate", "code.run", "parallel", "decision"]);
const STEP_ID = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const COMMON_FIELDS = ["id", "uses", "needs", "output"];
const STEP_FIELDS: Record<"tool.call" | "ai.generate", readonly string[]> = {
  "tool.call": [...COMMON_FIELDS, "tool", "with"],
  "ai.generate": [...COMMON_FIELDS, "model", "prompt", "bash"],
};
const STEP_SHAPE_HINT: Record<"tool.call" | "ai.generate", string> = {
  "tool.call": "A tool.call step takes `tool` and the tool's arguments in `with`.",
  "ai.generate": "An ai.generate step takes `model` and its whole instruction in `prompt`.",
};
// `$input.x`, `$.steps.y`: a reference written in another template syntax, which would reach the
// tool or the model as literal text.
const FOREIGN_REFERENCE = /(?:^|[^\w$])(\$\.?(?:input|steps))\b/u;

/**
 * Rejects what a plan's author most often gets wrong, before anything runs: a field the step type
 * does not take (it would be ignored, so a tool gets no arguments or a model an empty prompt), an
 * `ai.generate` step with no prompt, and references written as `$input.x` instead of `{{ input.x }}`.
 */
function stepShapeError(
  step: Record<string, unknown> & { readonly id: string; readonly uses: "tool.call" | "ai.generate" },
): string | undefined {
  const allowed = STEP_FIELDS[step.uses];
  const unknown = Object.keys(step).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    const article = step.uses === "ai.generate" ? "an" : "a";
    return `Step '${step.id}' has ${unknown.length === 1 ? "a field" : "fields"} ${article} ${step.uses} step does not take: ${unknown.map((key) => `'${key}'`).join(", ")}. ${STEP_SHAPE_HINT[step.uses]}`;
  }
  if (step.uses === "ai.generate" && (typeof step.prompt !== "string" || step.prompt.trim().length === 0)) {
    return `Step '${step.id}' has no prompt. ${STEP_SHAPE_HINT["ai.generate"]}`;
  }
  const foreign = [step.prompt, step.with].flatMap(strings).find((text) => FOREIGN_REFERENCE.test(text));
  if (foreign !== undefined) {
    return `Step '${step.id}' refers to data as '${foreign.match(FOREIGN_REFERENCE)?.[1]}...'. Write {{ input.<field> }} or {{ steps.<id>.output }} (or {{ steps.<id>.output.<field> }}).`;
  }
  return undefined;
}

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (isRecord(value)) return Object.values(value).flatMap(strings);
  return [];
}

export function parseAdHocPlan(value: unknown): ParseAdHocPlanResult {
  if (!isRecord(value)) return { ok: false, message: "Plan must be an object." };
  if (!Array.isArray(value.steps) || value.steps.length === 0) {
    return { ok: false, message: "Plan must have a non-empty steps array." };
  }
  const ids = new Set<string>();
  const steps: AdHocPlanStep[] = [];
  for (const raw of value.steps) {
    if (!isRecord(raw)) return { ok: false, message: "Each step must be an object." };
    if (typeof raw.id !== "string" || !STEP_ID.test(raw.id)) {
      return { ok: false, message: `Invalid step id: ${String(raw.id)}` };
    }
    if (ids.has(raw.id)) return { ok: false, message: `Duplicate step id: ${raw.id}` };
    ids.add(raw.id);
    if (typeof raw.uses !== "string" || !STEP_USES.has(raw.uses as AdHocPlanStepUses)) {
      return {
        ok: false,
        message: `Invalid step uses: ${String(raw.uses)}. Step '${raw.id}' needs \`uses\`: "tool.call" or "ai.generate".`,
      };
    }
    if (raw.uses === "code.run" || raw.uses === "parallel" || raw.uses === "decision") {
      // These kinds have no executable lowering in v1: `parallel` bodies are silently dropped,
      // `code.run` needs a worker harness the factory never supplies, and `decision` needs a
      // routing loop. Reject at parse so they fail with a clear message, not a downstream error.
      return {
        ok: false,
        message: `Dynamic one-shot plans support only 'tool.call' and 'ai.generate' steps in v1; step '${raw.id}' uses '${raw.uses}'.`,
      };
    }
    if (raw.needs !== undefined && (!Array.isArray(raw.needs) || raw.needs.some((n) => typeof n !== "string"))) {
      return { ok: false, message: `Step ${raw.id} needs must be a string array.` };
    }
    const shapeError = stepShapeError(raw as Record<string, unknown> & { id: string; uses: "tool.call" | "ai.generate" });
    if (shapeError !== undefined) return { ok: false, message: shapeError };
    steps.push(raw as unknown as AdHocPlanStep);
  }
  // needs must reference known, earlier-declared ids (acyclic by construction)
  const seen = new Set<string>();
  for (const step of steps) {
    for (const need of step.needs ?? []) {
      if (!ids.has(need)) return { ok: false, message: `Step ${step.id} needs unknown step ${need}.` };
      if (!seen.has(need)) return { ok: false, message: `Step ${step.id} needs ${need} which is not declared earlier (cycles are not allowed).` };
    }
    seen.add(step.id);
  }
  if (!isRecord(value.output) || typeof value.output.from !== "string") {
    return { ok: false, message: "Plan output.from must be a step id string." };
  }
  if (!ids.has(value.output.from)) {
    return { ok: false, message: `Plan output.from references unknown step ${value.output.from}.` };
  }
  // The LWIR output rides the plan's natural terminal step (the single step no other step needs).
  // `output.from` is otherwise ignored at lowering, so a mismatch would silently return the wrong
  // step's output. Enforce the single-terminal happy case here; multi-terminal is a validateLwir error.
  const needed = new Set<string>();
  for (const step of steps) {
    for (const need of step.needs ?? []) needed.add(need);
  }
  const terminals = steps.filter((step) => !needed.has(step.id)).map((step) => step.id);
  if (terminals.length === 1 && value.output.from !== terminals[0]) {
    return {
      ok: false,
      message: `output.from must name the plan's terminal step (the step no other step needs); got '${value.output.from}', terminal is '${terminals[0]}'.`,
    };
  }
  return { ok: true, plan: { steps, output: { from: value.output.from } } };
}
