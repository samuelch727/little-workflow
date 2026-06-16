import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { canonicalJson, sha256Digest } from "./canonical.js";
import { normalizeSchema, type NormalizedSchemaDescriptor } from "./schema.js";

export type LwirStepType =
  | "ai.generate"
  | "tool.call"
  | "code.run"
  | "parallel"
  | "decision";

export type LwirOutputMode = "text" | "object" | "array" | "choice" | "json";

export type LwirStepOutput = {
  readonly mode: LwirOutputMode;
  readonly schema?: NormalizedSchemaDescriptor;
  readonly values?: readonly string[];
  readonly name?: string;
  readonly description?: string;
};

export type LwirStepFixerConfig = {
  readonly model: string;
  readonly maxAttempts: number;
  readonly system: string;
};

export type LwirStepOnFailure = {
  readonly fixer?: LwirStepFixerConfig;
};

export type LwirStep = {
  readonly id: string;
  readonly uses: LwirStepType;
  readonly needs?: readonly string[];
  readonly with?: Record<string, unknown>;
  readonly input?: unknown;
  readonly cache?: unknown;
  readonly onFailure?: LwirStepOnFailure;
  readonly output?: LwirStepOutput;
  readonly steps?: readonly LwirStep[];
  readonly sensitive?: boolean;
  readonly maxVisits?: number;
};

export type LwirWorkflow = {
  readonly apiVersion: "littleworkflow.dev/v0.1";
  readonly kind: "Workflow";
  readonly metadata: {
    readonly name: string;
    readonly version?: string;
    readonly description?: string;
  };
  readonly input: { readonly schema: NormalizedSchemaDescriptor };
  readonly output: { readonly schema: NormalizedSchemaDescriptor };
  readonly permissions?: {
    readonly models?: readonly string[];
    readonly tools?: readonly string[];
    readonly secrets?: readonly string[];
    readonly network?: readonly string[];
  };
  readonly steps: readonly LwirStep[];
};

export type LwirValidationFinding = {
  readonly severity: "error";
  readonly code: string;
  readonly path: string;
  readonly message: string;
};

export type LwirValidationResult =
  | { readonly valid: true; readonly findings: readonly [] }
  | { readonly valid: false; readonly findings: readonly LwirValidationFinding[] };

export type WorkflowVersion = {
  readonly id: string;
  readonly hash: string;
  readonly canonicalizer: "little-workflow-canonical-json@alpha";
  readonly canonicalJson: string;
  readonly lwir: LwirWorkflow;
};

type JsonRecord = Record<string, unknown>;
type ValidationContext = {
  readonly allowedModels?: ReadonlySet<string>;
  readonly allowedTools?: ReadonlySet<string>;
  readonly allowItemExpressions?: boolean;
  readonly externalStepsById?: ReadonlyMap<string, KnownStep>;
  readonly localStepsById?: ReadonlyMap<string, KnownStep>;
};
type StepReference = {
  readonly id: string;
  readonly path: string;
  /** The first property segment after steps.X (e.g. "output", "lastOutput", "allVisits"). */
  readonly property?: string;
};
type KnownStep = {
  readonly step: JsonRecord;
  readonly path: string;
};
type AjvError = {
  readonly instancePath?: string;
  readonly schemaPath?: string;
  readonly message?: string;
};
type AjvInstance = {
  validateSchema(schema: unknown): boolean | Promise<unknown>;
  readonly errors?: readonly AjvError[] | null;
  errorsText?(errors?: readonly AjvError[] | null): string;
};
type AjvConstructor = new (options?: Record<string, unknown>) => AjvInstance;

const VALID_STEP_TYPES = new Set<LwirStepType>([
  "ai.generate",
  "tool.call",
  "code.run",
  "parallel",
  "decision",
]);
const VALID_OUTPUT_MODES = new Set<LwirOutputMode>([
  "text",
  "object",
  "array",
  "choice",
  "json",
]);
const STEP_ID_PATH_DELIMITER_PATTERN = /[.[\]]/u;
const STEP_ID_RESERVED_ATTEMPT_PATTERN = /@attempt_/u;
const ALPHA_MAX_BRANCHES = 100;
const SHA256_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const VALID_JSON_SCHEMA_TYPES = new Set([
  "array",
  "boolean",
  "integer",
  "null",
  "number",
  "object",
  "string",
]);
const SUPPORTED_JSON_SCHEMA_KEYS = new Set([
  "additionalProperties",
  "anyOf",
  "const",
  "enum",
  "items",
  "maxItems",
  "maxLength",
  "maximum",
  "minItems",
  "minLength",
  "minimum",
  "oneOf",
  "properties",
  "required",
  "type",
]);
const EXPRESSION_ROOTS = new Set(["input", "item", "steps", "step", "workflow"]);
const FORBIDDEN_PATH_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);
const SAFE_FUNCTION_ARITY: Record<string, { readonly min: number; readonly max?: number }> = {
  coalesce: { min: 2 },
  date: { min: 1, max: 1 },
  hmac: { min: 2, max: 2 },
  json: { min: 1, max: 1 },
  len: { min: 1, max: 1 },
  lower: { min: 1, max: 1 },
  sha256: { min: 1 },
  upper: { min: 1, max: 1 },
};
const COMPARISON_OPERATORS = ["===", "!==", ">=", "<=", "==", "!=", ">", "<"] as const;
const nodeRequire = createRequire(import.meta.url);

let cachedAjv: AjvInstance | undefined;

export class LwirValidationError extends TypeError {
  readonly findings: readonly LwirValidationFinding[];

  constructor(findings: readonly LwirValidationFinding[]) {
    super("Invalid LWIR document.");
    this.name = "LwirValidationError";
    this.findings = findings;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function validateLwir(value: unknown): LwirValidationResult {
  const findings: LwirValidationFinding[] = [];
  const lwir = canonicalJsonClone(value, findings);
  if (lwir === undefined) {
    return invalid(findings);
  }

  if (!isRecord(lwir)) {
    findings.push(finding("schema.invalid", "$", "LWIR document must be an object."));
  } else {
    validateTopLevelShape(lwir, findings);
    if (isRecord(lwir.input) && "schema" in lwir.input) {
      validateSchemaValue(lwir.input.schema, "$.input.schema", findings);
    }
    if (isRecord(lwir.output) && "schema" in lwir.output) {
      validateSchemaValue(lwir.output.schema, "$.output.schema", findings);
    }
    if (Array.isArray(lwir.steps)) {
      validateStepList(lwir.steps, "$.steps", findings, validationContextFor(lwir));
    }
  }

  return findings.length === 0 ? { valid: true, findings: [] } : invalid(findings);
}

export function assertValidLwir(value: unknown): asserts value is LwirWorkflow {
  const result = validateLwir(value);
  if (!result.valid) {
    throw new LwirValidationError(result.findings);
  }
}

export function validateAlphaJsonSchema(
  value: unknown,
  path = "$",
): readonly LwirValidationFinding[] {
  const findings: LwirValidationFinding[] = [];
  validateSchemaValue(value, path, findings);
  return findings;
}

export function registerWorkflowVersion(value: unknown): WorkflowVersion {
  assertValidLwir(value);
  const canonical = canonicalJson(value);
  const lwir = deepFreeze(JSON.parse(canonical) as LwirWorkflow);
  const hash = sha256Digest(lwir);
  return deepFreeze({
    id: `wfver_${hash.slice("sha256:".length, "sha256:".length + 16)}`,
    hash,
    canonicalizer: "little-workflow-canonical-json@alpha",
    canonicalJson: canonical,
    lwir,
  });
}

function canonicalJsonClone(
  value: unknown,
  findings: LwirValidationFinding[],
): unknown | undefined {
  try {
    return JSON.parse(canonicalJson(value)) as unknown;
  } catch (error) {
    findings.push({
      severity: "error",
      code: "lwir.non_hashable",
      path: "$",
      message: error instanceof Error ? error.message : "LWIR is not hashable.",
    });
    return undefined;
  }
}

function validateTopLevelShape(
  lwir: JsonRecord,
  findings: LwirValidationFinding[],
): void {
  if (lwir.apiVersion !== "littleworkflow.dev/v0.1") {
    findings.push(
      finding(
        "schema.invalid",
        "$.apiVersion",
        "apiVersion must be littleworkflow.dev/v0.1.",
      ),
    );
  }
  if (lwir.kind !== "Workflow") {
    findings.push(finding("schema.invalid", "$.kind", "kind must be Workflow."));
  }
  if (!isRecord(lwir.metadata)) {
    findings.push(finding("schema.invalid", "$.metadata", "metadata is required."));
  } else if (typeof lwir.metadata.name !== "string" || lwir.metadata.name.length === 0) {
    findings.push(
      finding("schema.invalid", "$.metadata.name", "metadata.name is required."),
    );
  }
  if (!isRecord(lwir.input) || !("schema" in lwir.input)) {
    findings.push(finding("schema.invalid", "$.input", "input.schema is required."));
  }
  if (!isRecord(lwir.output) || !("schema" in lwir.output)) {
    findings.push(finding("schema.invalid", "$.output", "output.schema is required."));
  }
  if (!Array.isArray(lwir.steps)) {
    findings.push(finding("schema.invalid", "$.steps", "steps must be an array."));
  }

  if (lwir.permissions !== undefined) {
    validatePermissions(lwir.permissions, findings);
  }
}

function validatePermissions(
  permissions: unknown,
  findings: LwirValidationFinding[],
): void {
  if (!isRecord(permissions)) {
    findings.push(
      finding("schema.invalid", "$.permissions", "permissions must be an object."),
    );
    return;
  }
  for (const key of ["models", "tools", "secrets", "network"]) {
    const value = permissions[key];
    if (value === undefined) {
      continue;
    }
    if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
      findings.push(
        finding(
          "schema.invalid",
          `$.permissions.${key}`,
          "permission entries must be string arrays.",
        ),
      );
    }
  }
}

function validateStepList(
  steps: readonly unknown[],
  path: string,
  findings: LwirValidationFinding[],
  context: ValidationContext,
): void {
  const indexesById = new Map<string, number>();
  const dependenciesById = new Map<string, readonly string[]>();
  const referencesById = new Map<string, readonly StepReference[]>();
  const stepsById = new Map<string, JsonRecord>();
  const declaredStepsById = declaredStepsForList(steps, path);
  const listContext: ValidationContext = { ...context, localStepsById: declaredStepsById };

  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    const stepPath = `${path}[${index}]`;
    if (!isRecord(step)) {
      findings.push(finding("step.invalid", stepPath, "Step must be an object."));
      continue;
    }

    const id = step.id;
    if (typeof id !== "string" || id.length === 0) {
      findings.push(finding("step.invalid_id", `${stepPath}.id`, "Step id is required."));
      continue;
    }
    if (STEP_ID_PATH_DELIMITER_PATTERN.test(id)) {
      findings.push(
        finding(
          "step.invalid_id",
          `${stepPath}.id`,
          "Step id must not contain a reserved path delimiter: '.', '[', or ']'.",
        ),
      );
      continue;
    }
    if (STEP_ID_RESERVED_ATTEMPT_PATTERN.test(id)) {
      findings.push(
        finding(
          "step.invalid_id",
          `${stepPath}.id`,
          "Step id must not contain reserved retry path marker '@attempt_N'.",
        ),
      );
      continue;
    }
    const isDuplicate = indexesById.has(id);
    if (isDuplicate) {
      findings.push(
        finding("step.duplicate_id", `${stepPath}.id`, `Duplicate step id '${id}'.`),
      );
    } else {
      indexesById.set(id, index);
      stepsById.set(id, step);
    }

    const needs = validateNeeds(step, stepPath, findings);
    if (!isDuplicate) {
      dependenciesById.set(id, needs);
      referencesById.set(id, stepReferencesIn(step, stepPath));
    }
    validateStep(step, stepPath, findings, listContext);
  }

  // Build the execution-flow edge map once; reused for back-edge checks and cycle validation.
  const outgoing = buildExecutionFlowEdges(stepsById, dependenciesById);

  for (const [id, needs] of dependenciesById) {
    const stepIndex = indexesById.get(id);
    if (stepIndex === undefined) {
      continue;
    }
    for (let index = 0; index < needs.length; index += 1) {
      const need = needs[index];
      if (!indexesById.has(need) && !context.externalStepsById?.has(need)) {
        findings.push(
          finding(
            "step.missing_dependency",
            `${path}[${stepIndex}].needs[${index}]`,
            `Step '${id}' depends on missing step '${need}'.`,
          ),
        );
      }
    }

    const needsSet = new Set(needs);
    for (const reference of referencesById.get(id) ?? []) {
      const referenceIndex = indexesById.get(reference.id);
      const externalReference = context.externalStepsById?.get(reference.id);
      if (referenceIndex === undefined && externalReference === undefined) {
        findings.push(
          finding(
            "step.missing_dependency",
            reference.path,
            `Step '${id}' references missing step '${reference.id}'.`,
          ),
        );
        continue;
      }
      if (!needsSet.has(reference.id)) {
        // For lastOutput and allVisits only: if the referenced step can reach the referencing
        // step via the execution-flow graph (needs-edges + decision-transition-edges), this is
        // a legitimate back-edge reference in a loop — the planner cannot declare it in needs
        // without creating an unsatisfiable forward-DAG cycle. Suppress the finding.
        const isBackEdgeLoopRef =
          (reference.property === "lastOutput" || reference.property === "allVisits") &&
          canReach(reference.id, id, outgoing);
        if (!isBackEdgeLoopRef) {
          findings.push(
            finding(
              "step.undeclared_dependency",
              reference.path,
              `Step '${id}' references '${reference.id}' without declaring it in needs.`,
            ),
          );
        }
      }

      const referencedStep = stepsById.get(reference.id) ?? externalReference?.step;
      if (referencedStep !== undefined && jsonOutputNeedsSchema(referencedStep)) {
        const referencedStepPath = referenceIndex === undefined
          ? externalReference?.path
          : `${path}[${referenceIndex}]`;
        findings.push(
          finding(
            "output.missing_schema",
            `${referencedStepPath}.output.schema`,
            `Referenced json output from step '${reference.id}' requires schema.`,
          ),
        );
      }

      if (
        reference.property === "output" &&
        referencedStep !== undefined &&
        ((referencedStep.maxVisits as number | undefined) ?? 1) > 1
      ) {
        findings.push(
          finding(
            "lwir.output_ambiguous_for_multi_visit",
            reference.path,
            `Step '${id}' uses '{{ steps.${reference.id}.output }}' but step '${reference.id}' has maxVisits > 1. Use 'lastOutput' or 'allVisits' instead.`,
          ),
        );
      }
    }
  }

  // P1.2 — detect the deadlock case where a non-decision-target step Y declares a
  // decision target X in its needs, and X has non-empty needs (so X may be excluded
  // from normal scheduling by its controlling decision step, causing Y to deadlock).
  // Decision targets with needs:[] always run on the first iteration regardless of
  // routing, so their dependents are safe and should not generate a finding.
  const allDecisionTargetIds = new Set<string>();
  const deadlockDecisionTargetIds = new Set<string>(); // targets with non-empty needs
  for (const [, step] of stepsById) {
    if (step.uses !== "decision" || !isRecord(step.with)) continue;
    const cfg = step.with as { cases?: ReadonlyArray<{ to?: unknown }>; default?: unknown };
    const targets: string[] = [];
    for (const c of (Array.isArray(cfg.cases) ? cfg.cases : [])) {
      if (isRecord(c) && typeof c.to === "string" && c.to !== "end") targets.push(c.to);
    }
    if (typeof cfg.default === "string" && cfg.default !== "end") targets.push(cfg.default);
    for (const targetId of targets) {
      allDecisionTargetIds.add(targetId);
      const targetStep = stepsById.get(targetId);
      if (targetStep !== undefined) {
        const targetNeeds = Array.isArray(targetStep.needs) ? targetStep.needs : [];
        if (targetNeeds.length > 0) {
          deadlockDecisionTargetIds.add(targetId);
        }
      }
    }
  }

  for (const [id, needs] of dependenciesById) {
    const step = stepsById.get(id);
    // Skip decision steps themselves (they orchestrate routing and may legitimately
    // depend on their own targets in back-edge loops).
    if (step?.uses === "decision") continue;
    // Skip steps that are themselves decision targets — their scheduling is already
    // controlled by the decision that routes to them.
    if (allDecisionTargetIds.has(id)) continue;
    const stepIndex = indexesById.get(id);
    if (stepIndex === undefined) continue;
    for (let depIndex = 0; depIndex < needs.length; depIndex += 1) {
      const depId = needs[depIndex];
      if (deadlockDecisionTargetIds.has(depId)) {
        findings.push(
          finding(
            "lwir.decision_target_referenced_by_needs",
            `${path}[${stepIndex}].needs`,
            `Step '${id}' declares '${depId}' in needs, but '${depId}' is a decision target ` +
              `— it may never be routed to, causing '${id}' to deadlock.`,
          ),
        );
      }
    }
  }

  validateCycles(stepsById, outgoing, path, findings);
}

function declaredStepsForList(steps: readonly unknown[], path: string): ReadonlyMap<string, KnownStep> {
  const declared = new Map<string, KnownStep>();
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    if (!isRecord(step) || typeof step.id !== "string" || step.id.length === 0) {
      continue;
    }
    if (
      STEP_ID_PATH_DELIMITER_PATTERN.test(step.id) ||
      STEP_ID_RESERVED_ATTEMPT_PATTERN.test(step.id) ||
      declared.has(step.id)
    ) {
      continue;
    }
    declared.set(step.id, { step, path: `${path}[${index}]` });
  }
  return declared;
}

function validateNeeds(
  step: JsonRecord,
  stepPath: string,
  findings: LwirValidationFinding[],
): readonly string[] {
  if (step.needs === undefined) {
    return [];
  }
  if (!Array.isArray(step.needs)) {
    findings.push(finding("step.invalid_needs", `${stepPath}.needs`, "Needs must be an array."));
    return [];
  }

  const needs: string[] = [];
  for (let index = 0; index < step.needs.length; index += 1) {
    const need = step.needs[index];
    if (typeof need !== "string" || need.length === 0) {
      findings.push(
        finding(
          "step.invalid_needs",
          `${stepPath}.needs[${index}]`,
          "Step dependency must be a non-empty string.",
        ),
      );
      continue;
    }
    needs.push(need);
  }
  return needs;
}

function validateStep(
  step: JsonRecord,
  stepPath: string,
  findings: LwirValidationFinding[],
  context: ValidationContext,
): void {
  const stepType =
    typeof step.uses === "string" && VALID_STEP_TYPES.has(step.uses as LwirStepType)
      ? (step.uses as LwirStepType)
      : undefined;

  if (stepType === undefined) {
    findings.push(
      finding("step.invalid_type", `${stepPath}.uses`, "Unsupported alpha step type."),
    );
  }
  if (stepType === "parallel" && context.allowItemExpressions === true) {
    findings.push(
      finding(
        "parallel.nested_unsupported",
        `${stepPath}.uses`,
        "Nested parallel steps are not supported in alpha.",
      ),
    );
  }

  const outputMode = stepType === "decision"
    ? undefined
    : validateOutput(step.output, `${stepPath}.output`, findings);
  const expressionContext = { allowItemExpressions: context.allowItemExpressions === true };
  if (stepType !== "parallel" && stepType !== "decision") {
    validateExpressions(step.with, `${stepPath}.with`, findings, expressionContext);
  }
  validateExpressions(step.input, `${stepPath}.input`, findings, expressionContext);
  validateExpressions(step.cache, `${stepPath}.cache`, findings, expressionContext);

  validateSensitiveField(step, stepPath, findings);
  validateMaxVisitsField(step, stepPath, findings);

  if (stepType !== undefined) {
    validateStepTypeConfig(step, stepPath, stepType, findings, context);
    validateFixerConfig(step, stepPath, stepType, findings, context);
    if (outputMode !== undefined) {
      validateOutputCompatibility(stepPath, stepType, outputMode, findings);
    }
  }

  if (stepType === "parallel") {
    validateParallelStep(step, stepPath, findings, context);
    validateParallelOutputSchema(step, stepPath, findings);
  }
}

function validateOutput(
  output: unknown,
  outputPath: string,
  findings: LwirValidationFinding[],
): LwirOutputMode | undefined {
  if (!isRecord(output)) {
    findings.push(finding("output.invalid", outputPath, "Step output must be an object."));
    return undefined;
  }

  const mode = output.mode;
  if (typeof mode !== "string" || !VALID_OUTPUT_MODES.has(mode as LwirOutputMode)) {
    findings.push(finding("output.invalid", outputPath, "Unsupported output mode."));
    return undefined;
  }
  const outputMode = mode as LwirOutputMode;
  validateOutputMetadata(output, outputPath, findings);

  if (mode === "object" || mode === "array") {
    if (output.schema === undefined) {
      findings.push(
        finding(
          "output.missing_schema",
          `${outputPath}.schema`,
          `${mode} output requires schema.`,
        ),
      );
      return outputMode;
    }
    validateSchemaValue(output.schema, `${outputPath}.schema`, findings);
    return outputMode;
  }

  if (mode === "choice") {
    if (!Array.isArray(output.values)) {
      findings.push(
        finding("output.missing_values", `${outputPath}.values`, "choice output requires values."),
      );
      return outputMode;
    }
    for (let index = 0; index < output.values.length; index += 1) {
      if (typeof output.values[index] !== "string") {
        findings.push(
          finding(
            "output.invalid_values",
            `${outputPath}.values[${index}]`,
            "Choice values must be strings.",
          ),
        );
      }
    }
    return outputMode;
  }

  if (mode === "json" && output.schema !== undefined) {
    validateSchemaValue(output.schema, `${outputPath}.schema`, findings);
  }
  return outputMode;
}

function validateOutputMetadata(
  output: JsonRecord,
  outputPath: string,
  findings: LwirValidationFinding[],
): void {
  for (const key of ["name", "description"]) {
    const value = output[key];
    if (value !== undefined && typeof value !== "string") {
      findings.push(
        finding(
          "output.invalid_metadata",
          `${outputPath}.${key}`,
          `output.${key} must be a string.`,
        ),
      );
    }
  }
}

function validateSensitiveField(
  step: JsonRecord,
  stepPath: string,
  findings: LwirValidationFinding[],
): void {
  if (step.sensitive === undefined) {
    return;
  }
  if (typeof step.sensitive !== "boolean") {
    findings.push(
      finding(
        "step.sensitive_must_be_boolean",
        `${stepPath}.sensitive`,
        "sensitive must be a boolean.",
      ),
    );
  }
}

function validateMaxVisitsField(
  step: JsonRecord,
  stepPath: string,
  findings: LwirValidationFinding[],
): void {
  if (step.maxVisits === undefined) {
    return;
  }
  if (
    !Number.isInteger(step.maxVisits) ||
    (step.maxVisits as number) < 1 ||
    (step.maxVisits as number) > 100
  ) {
    findings.push(
      finding(
        "step.max_visits_out_of_range",
        `${stepPath}.maxVisits`,
        "maxVisits must be an integer in [1, 100].",
      ),
    );
  }
}

function validateFixerConfig(
  step: JsonRecord,
  stepPath: string,
  stepType: LwirStepType,
  findings: LwirValidationFinding[],
  context: ValidationContext,
): void {
  if (step.onFailure === undefined) {
    return;
  }
  if (!isRecord(step.onFailure)) {
    findings.push(
      finding(
        "fixer.invalid_config",
        `${stepPath}.onFailure`,
        "onFailure must be an object when provided.",
      ),
    );
    return;
  }
  const fixer = step.onFailure.fixer;
  if (fixer === undefined) {
    return;
  }
  const fixerPath = `${stepPath}.onFailure.fixer`;
  if (!isRecord(fixer)) {
    findings.push(
      finding(
        "fixer.invalid_config",
        fixerPath,
        "onFailure.fixer must be an object.",
      ),
    );
    return;
  }

  if (stepType !== "code.run") {
    findings.push(
      finding(
        "fixer.unsupported_step",
        fixerPath,
        "onFailure.fixer is supported only for code.run steps in alpha.",
      ),
    );
  }

  if (typeof fixer.model !== "string" || fixer.model.length === 0) {
    findings.push(
      finding(
        "fixer.model.missing",
        `${fixerPath}.model`,
        "fixer.model must be a non-empty model slot string.",
      ),
    );
  } else if (context.allowedModels === undefined || !context.allowedModels.has(fixer.model)) {
    findings.push(
      finding(
        "fixer.model.disallowed",
        `${fixerPath}.model`,
        `Fixer model '${fixer.model}' is not in the workflow allowlist.`,
      ),
    );
  }

  if (
    typeof fixer.maxAttempts !== "number" ||
    !Number.isInteger(fixer.maxAttempts) ||
    fixer.maxAttempts < 1
  ) {
    findings.push(
      finding(
        "fixer.max_attempts_invalid",
        `${fixerPath}.maxAttempts`,
        "fixer.maxAttempts must be a positive integer.",
      ),
    );
  }

  if (typeof fixer.system !== "string" || fixer.system.length === 0) {
    findings.push(
      finding(
        "fixer.system_missing",
        `${fixerPath}.system`,
        "fixer.system must be a non-empty string.",
      ),
    );
  }
}

function validateStepTypeConfig(
  step: JsonRecord,
  stepPath: string,
  stepType: LwirStepType,
  findings: LwirValidationFinding[],
  context: ValidationContext,
): void {
  if (stepType === "ai.generate") {
    validateAiStepConfig(step, stepPath, findings, context);
    return;
  }
  if (stepType === "tool.call") {
    validateToolStepConfig(step, stepPath, findings, context);
    return;
  }
  if (stepType === "code.run") {
    validateCodeRunStepConfig(step, stepPath, findings);
    return;
  }
  if (stepType === "decision") {
    validateDecisionStepConfig(step, stepPath, findings, context);
  }
}

function validateAiStepConfig(
  step: JsonRecord,
  stepPath: string,
  findings: LwirValidationFinding[],
  context: ValidationContext,
): void {
  const config = step.with;
  if (!isRecord(config) || typeof config.model !== "string" || config.model.length === 0) {
    findings.push(
      finding("model.missing", `${stepPath}.with.model`, "AI steps require a model slot."),
    );
    return;
  }

  if (context.allowedModels === undefined || !context.allowedModels.has(config.model)) {
    findings.push(
      finding(
        "model.disallowed",
        `${stepPath}.with.model`,
        `Model '${config.model}' is not in the workflow allowlist.`,
      ),
    );
  }
}

function validateToolStepConfig(
  step: JsonRecord,
  stepPath: string,
  findings: LwirValidationFinding[],
  context: ValidationContext,
): void {
  const config = step.with;
  if (!isRecord(config) || typeof config.tool !== "string" || config.tool.length === 0) {
    findings.push(
      finding("tool.missing", `${stepPath}.with.tool`, "Tool steps require a tool capability."),
    );
    return;
  }

  if (context.allowedTools === undefined || !context.allowedTools.has(config.tool)) {
    findings.push(
      finding(
        "tool.disallowed",
        `${stepPath}.with.tool`,
        `Tool '${config.tool}' is not in the workflow allowlist.`,
      ),
    );
  }
}

function validateCodeRunStepConfig(
  step: JsonRecord,
  stepPath: string,
  findings: LwirValidationFinding[],
): void {
  const config = step.with;
  if (!isRecord(config)) {
    findings.push(
      finding("code.invalid_config", `${stepPath}.with`, "code.run config is required."),
    );
    return;
  }

  if (typeof config.entrypoint !== "string" || config.entrypoint.length === 0) {
    findings.push(
      finding(
        "code.missing_entrypoint",
        `${stepPath}.with.entrypoint`,
        "code.run steps require an entrypoint.",
      ),
    );
  } else if (!isSafeCodePath(config.entrypoint) || !config.entrypoint.endsWith(".ts")) {
    findings.push(
      finding(
        "code.invalid_entrypoint",
        `${stepPath}.with.entrypoint`,
        "code.run entrypoint must be a safe relative .ts path.",
      ),
    );
  }

  if (!isRecord(config.files) || Object.keys(config.files).length === 0) {
    findings.push(
      finding(
        "code.missing_files",
        `${stepPath}.with.files`,
        "code.run steps require pinned source files.",
      ),
    );
  } else {
    for (const [fileName, file] of Object.entries(config.files)) {
      const filePath = `${stepPath}.with.files[${JSON.stringify(fileName)}]`;
      if (!isSafeCodePath(fileName)) {
        findings.push(
          finding(
            "code.invalid_file_path",
            filePath,
            "code.run file paths must be safe relative paths.",
          ),
        );
      }
      if (!isRecord(file)) {
        findings.push(
          finding("code.invalid_file", filePath, "code.run file entries must be objects."),
        );
        continue;
      }
      if (typeof file.content !== "string") {
        findings.push(
          finding(
            "code.invalid_file",
            `${filePath}.content`,
            "code.run file content must be a string.",
          ),
        );
      }
      if (typeof file.sha256 !== "string" || !SHA256_DIGEST_PATTERN.test(file.sha256)) {
        findings.push(
          finding(
            "code.invalid_file_hash",
            `${filePath}.sha256`,
            "code.run file entries require a sha256 digest.",
          ),
        );
      } else if (
        typeof file.content === "string" &&
        file.sha256 !== sha256TextDigest(file.content)
      ) {
        findings.push(
          finding(
            "code.invalid_file_hash",
            `${filePath}.sha256`,
            "code.run file hash does not match content.",
          ),
        );
      }
    }

    if (typeof config.entrypoint === "string" && !(config.entrypoint in config.files)) {
      findings.push(
        finding(
          "code.invalid_entrypoint",
          `${stepPath}.with.entrypoint`,
          "code.run entrypoint must exist in files.",
        ),
      );
    }
  }

  if (config.sandbox === undefined) {
    findings.push(
      finding(
        "code.missing_sandbox",
        `${stepPath}.with.sandbox`,
        "code.run steps require an explicit denied sandbox policy.",
      ),
    );
  } else if (!isRecord(config.sandbox)) {
    findings.push(
      finding(
        "code.invalid_sandbox",
        `${stepPath}.with.sandbox`,
        "code.run sandbox policy must be an object.",
      ),
    );
    return;
  } else {
    const network = config.sandbox.network;
    if (network !== "deny" && network !== false) {
      findings.push(
        finding(
          "code.invalid_sandbox",
          `${stepPath}.with.sandbox.network`,
          "code.run sandbox network access must be denied.",
        ),
      );
    }
    const env = config.sandbox.env;
    if (env !== undefined && env !== "deny" && env !== false) {
      findings.push(
        finding(
          "code.invalid_sandbox",
          `${stepPath}.with.sandbox.env`,
          "code.run sandbox environment access must be denied.",
        ),
      );
    }
    const fs = config.sandbox.fs;
    if (fs !== undefined && fs !== "deny" && fs !== false) {
      findings.push(
        finding(
          "code.invalid_sandbox",
          `${stepPath}.with.sandbox.fs`,
          "code.run sandbox filesystem access must be denied unless explicit mounts are supported.",
        ),
      );
    }
  }
}

function validateDecisionStepConfig(
  step: JsonRecord,
  stepPath: string,
  findings: LwirValidationFinding[],
  context: ValidationContext,
): void {
  const cfg = step.with as {
    cases?: ReadonlyArray<{ when?: unknown; to?: unknown }>;
    default?: unknown;
  } | undefined;

  // default must be a non-empty string
  if (typeof cfg?.default !== "string" || cfg.default.length === 0) {
    findings.push(
      finding(
        "decision.default_required",
        `${stepPath}.with.default`,
        "Decision step requires 'default' (string step id or 'end').",
      ),
    );
  }

  // each case: when (valid template expression), to (string)
  const targets = new Set<string>();
  if (typeof cfg?.default === "string" && cfg.default.length > 0) {
    targets.add(cfg.default);
  }
  for (let i = 0; i < (cfg?.cases?.length ?? 0); i += 1) {
    const c = cfg!.cases![i];
    if (typeof c?.when !== "string" || typeof c?.to !== "string" || (c.to as string).length === 0) {
      findings.push(
        finding(
          "decision.case_invalid",
          `${stepPath}.with.cases[${i}]`,
          "Each case must have 'when' (expression string) and 'to' (step id string).",
        ),
      );
    } else {
      // when is a string — validate it as a template expression (must use {{ }} wrapping)
      if (!isValidTemplateExpression(c.when as string, { allowItemExpressions: context.allowItemExpressions === true })) {
        findings.push(
          finding(
            "expression.invalid",
            `${stepPath}.with.cases[${i}].when`,
            "Decision case 'when' must be a valid {{ }} template expression.",
          ),
        );
      }
      targets.add(c.to as string);
    }
  }

  // targets must be in scope or "end"
  const stepsInScope = context.localStepsById;
  for (const t of targets) {
    if (t !== "end" && !(stepsInScope?.has(t) ?? false)) {
      findings.push(
        finding(
          "decision.target_not_in_scope",
          `${stepPath}.with`,
          `Decision target '${t}' is not in the same scope.`,
        ),
      );
    }
  }
}

function validateOutputCompatibility(
  stepPath: string,
  stepType: LwirStepType,
  outputMode: LwirOutputMode,
  findings: LwirValidationFinding[],
): void {
  if (stepType === "parallel" && outputMode !== "array") {
    findings.push(
      finding(
        "output.invalid_for_step",
        `${stepPath}.output.mode`,
        "parallel output must use array mode.",
      ),
    );
  }
}

function validateParallelStep(
  step: JsonRecord,
  stepPath: string,
  findings: LwirValidationFinding[],
  context: ValidationContext,
): void {
  const config = step.with;
  if (!isRecord(config)) {
    findings.push(finding("parallel.invalid", `${stepPath}.with`, "Parallel config is required."));
    return;
  }

  if (
    typeof config.items !== "string" ||
    !isValidTemplateExpression(config.items, {
      allowItemExpressions: context.allowItemExpressions === true,
    })
  ) {
    findings.push(
      finding(
        "parallel.invalid_items",
        `${stepPath}.with.items`,
        "Parallel items must be a valid expression.",
      ),
    );
  }
  if (
    typeof config.itemKey !== "string" ||
    !isValidTemplateExpression(config.itemKey, { allowItemExpressions: true }) ||
    !templateExpressionReferencesRoot(config.itemKey, "item")
  ) {
    findings.push(
      finding(
        "parallel.invalid_item_key",
        `${stepPath}.with.itemKey`,
        "Parallel itemKey must be a valid expression.",
      ),
    );
  }
  const cardinality = config.cardinality;
  if (!isRecord(cardinality) || cardinality.kind !== "matches_items") {
    findings.push(
      finding(
        "parallel.invalid_cardinality",
        `${stepPath}.with.cardinality.kind`,
        "Parallel cardinality kind must be matches_items.",
      ),
    );
  }

  const maxBranches = config.maxBranches;
  const maxConcurrency = config.maxConcurrency;
  if (
    !Number.isInteger(maxBranches) ||
    (maxBranches as number) < 1 ||
    (maxBranches as number) > ALPHA_MAX_BRANCHES
  ) {
    findings.push(
      finding(
        "parallel.invalid_branches",
        `${stepPath}.with.maxBranches`,
        `maxBranches must be an integer between 1 and ${ALPHA_MAX_BRANCHES}.`,
      ),
    );
  }
  if (
    !Number.isInteger(maxConcurrency) ||
    (maxConcurrency as number) < 1 ||
    (Number.isInteger(maxBranches) && (maxConcurrency as number) > (maxBranches as number))
  ) {
    findings.push(
      finding(
        "parallel.invalid_concurrency",
        `${stepPath}.with.maxConcurrency`,
        "maxConcurrency must be an integer between 1 and maxBranches.",
      ),
    );
  }
  if (config.failureMode !== "fail_fast" && config.failureMode !== "all_settled") {
    findings.push(
      finding(
        "parallel.invalid_failure_mode",
        `${stepPath}.with.failureMode`,
        "failureMode must be fail_fast or all_settled.",
      ),
    );
  }

  const fanIn = config.fanIn;
  if (!isRecord(fanIn)) {
    findings.push(
      finding(
        "parallel.invalid_fan_in",
        `${stepPath}.with.fanIn`,
        "fanIn must use input or itemKey order and array output.",
      ),
    );
  } else {
    if (fanIn.order !== "input" && fanIn.order !== "itemKey") {
      findings.push(
        finding(
          "parallel.invalid_fan_in",
          `${stepPath}.with.fanIn.order`,
          "fanIn order must be input or itemKey.",
        ),
      );
    }
    if (fanIn.output !== "array") {
      findings.push(
        finding(
          "parallel.invalid_fan_in",
          `${stepPath}.with.fanIn.output`,
          "fanIn output must be array.",
        ),
      );
    }
    if (fanIn.outputStep !== undefined) {
      const outputStepId = fanIn.outputStep;
      const branchSteps = Array.isArray(step.steps) ? step.steps : [];
      const targetStep = branchSteps.find(
        (s): s is JsonRecord => isRecord(s) && s.id === outputStepId,
      );
      if (targetStep === undefined || targetStep.uses === "decision") {
        findings.push(
          finding(
            "parallel.fan_in_output_step_invalid",
            `${stepPath}.with.fanIn.outputStep`,
            "fanIn.outputStep must reference a non-decision step defined in the parallel branch body.",
          ),
        );
      }
    }
  }

  if (!Array.isArray(step.steps) || step.steps.length === 0) {
    findings.push(
      finding("parallel.missing_steps", `${stepPath}.steps`, "Parallel steps are required."),
    );
  } else {
    const parentNeeds = new Set(
      Array.isArray(step.needs)
        ? step.needs.filter((need): need is string => typeof need === "string")
        : [],
    );
    const parentDependencyStepsById = filterKnownStepsByIds(context.localStepsById, parentNeeds);
    const externalStepsById = mergeKnownSteps(
      context.externalStepsById,
      parentDependencyStepsById,
    );
    validateStepList(
      step.steps,
      `${stepPath}.steps`,
      findings,
      { ...context, allowItemExpressions: true, externalStepsById },
    );
  }
}

function validateParallelOutputSchema(
  step: JsonRecord,
  stepPath: string,
  findings: LwirValidationFinding[],
): void {
  if (!isRecord(step.output) || step.output.mode !== "array") {
    return;
  }
  const schema = step.output.schema;
  if (!isRecord(schema)) {
    findings.push(
      finding(
        "parallel.invalid_fan_in",
        `${stepPath}.output.schema`,
        "Parallel output schema must describe fan-in envelope records.",
      ),
    );
    return;
  }
  if (!parallelFanInItemSchemaLooksLikeEnvelope(schema.items)) {
    findings.push(
      finding(
        "parallel.invalid_fan_in",
        `${stepPath}.output.schema.items`,
        "Parallel output items must include itemKey, status, and runtime result fields.",
      ),
    );
  }
}

function parallelFanInItemSchemaLooksLikeEnvelope(items: unknown): boolean {
  if (!isRecord(items) || !schemaAllowsType(items, "object")) {
    return false;
  }
  if (!isStringArray(items.required)) {
    return false;
  }
  const required = new Set(items.required);
  if (!required.has("itemKey") || !required.has("status") || !required.has("artifacts")) {
    return false;
  }
  if (!isRecord(items.properties)) {
    return false;
  }
  return (
    items.properties.itemKey !== undefined &&
    items.properties.status !== undefined &&
    items.properties.artifacts !== undefined &&
    (
      items.properties.output !== undefined ||
      items.properties.outputRef !== undefined ||
      items.properties.error !== undefined
    )
  );
}

function schemaAllowsType(schema: JsonRecord, expectedType: string): boolean {
  if (schema.type === undefined) {
    return true;
  }
  if (typeof schema.type === "string") {
    return schema.type === expectedType;
  }
  return Array.isArray(schema.type) && schema.type.includes(expectedType);
}

function mergeKnownSteps(
  left: ReadonlyMap<string, KnownStep> | undefined,
  right: ReadonlyMap<string, KnownStep> | undefined,
): ReadonlyMap<string, KnownStep> | undefined {
  if (left === undefined && right === undefined) {
    return undefined;
  }
  const merged = new Map<string, KnownStep>();
  for (const [id, step] of left ?? []) {
    merged.set(id, step);
  }
  for (const [id, step] of right ?? []) {
    if (!merged.has(id)) {
      merged.set(id, step);
    }
  }
  return merged;
}

function filterKnownStepsByIds(
  steps: ReadonlyMap<string, KnownStep> | undefined,
  ids: ReadonlySet<string>,
): ReadonlyMap<string, KnownStep> | undefined {
  if (steps === undefined || ids.size === 0) {
    return undefined;
  }
  const filtered = new Map<string, KnownStep>();
  for (const id of ids) {
    const step = steps.get(id);
    if (step !== undefined) {
      filtered.set(id, step);
    }
  }
  return filtered;
}

function validateSchemaValue(
  value: unknown,
  path: string,
  findings: LwirValidationFinding[],
): void {
  try {
    const normalized = normalizeSchema(value);
    if (!validateSchemaWithAjv(normalized, path, findings)) {
      return;
    }
    validateSupportedSchemaSubset(normalized, path, findings);
  } catch (error) {
    findings.push(
      finding(
        "schema.invalid",
        path,
        error instanceof Error ? error.message : "Schema is invalid.",
      ),
    );
  }
}

function validateExpressions(
  value: unknown,
  path: string,
  findings: LwirValidationFinding[],
  options: { readonly allowItemExpressions?: boolean } = {},
): void {
  if (typeof value === "string") {
    if (value.includes("{{") || value.includes("}}")) {
      const expressions = expressionsIn(value);
      if (expressions.length === 0) {
        findings.push(finding("expression.invalid", path, "Malformed template expression."));
        return;
      }
      for (const expression of expressions) {
        if (!isSafeExpressionBody(expression, options)) {
          findings.push(finding("expression.invalid", path, "Unsafe template expression."));
          return;
        }
      }
    }
    return;
  }

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      validateExpressions(value[index], `${path}[${index}]`, findings, options);
    }
    return;
  }

  if (isRecord(value)) {
    for (const key of Object.keys(value)) {
      validateExpressions(value[key], `${path}.${key}`, findings, options);
    }
  }
}

function expressionsIn(value: string): readonly string[] {
  const expressions: string[] = [];
  const matcher = /\{\{([^{}]+)\}\}/gu;
  let match: RegExpExecArray | null;
  let covered = value;
  while ((match = matcher.exec(value)) !== null) {
    expressions.push(match[1]?.trim() ?? "");
    covered = covered.replace(match[0], "");
  }
  return covered.includes("{{") || covered.includes("}}") ? [] : expressions;
}

function isValidTemplateExpression(
  value: string,
  options: { readonly allowItemExpressions?: boolean } = {},
): boolean {
  if (!value.startsWith("{{") || !value.endsWith("}}")) {
    return false;
  }
  const expressions = expressionsIn(value);
  return expressions.length === 1 && isSafeExpressionBody(expressions[0] ?? "", options);
}

function isSafeExpressionBody(
  expression: string,
  options: { readonly allowItemExpressions?: boolean } = {},
): boolean {
  const trimmed = expression.trim();
  if (trimmed.length === 0) {
    return false;
  }
  if (
    /(?:;|`|=>|\bawait\b|\bnew\b|\bfunction\b|\bimport\b|\brequire\b|\bprocess\b|\bglobalThis\b|\bglobal\b|\beval\b|\bconstructor\b|\bprototype\b|__proto__)/u.test(
      trimmed,
    )
  ) {
    return false;
  }
  if (!options.allowItemExpressions && expressionBodyReferencesRoot(trimmed, "item")) {
    return false;
  }
  if (expressionUsesNumericStepIndex(trimmed)) {
    return false;
  }
  return isValidExpression(trimmed);
}

function validateSchemaWithAjv(
  schema: NormalizedSchemaDescriptor,
  path: string,
  findings: LwirValidationFinding[],
): boolean {
  try {
    const ajv = getAjv();
    if (ajv.validateSchema(schema) === true) {
      return true;
    }
    findings.push(
      finding(
        "schema.invalid",
        path,
        ajv.errorsText?.(ajv.errors) ?? "JSON Schema is invalid.",
      ),
    );
    return false;
  } catch (error) {
    findings.push(
      finding(
        "schema.invalid",
        path,
        error instanceof Error ? error.message : "JSON Schema is invalid.",
      ),
    );
    return false;
  }
}

function getAjv(): AjvInstance {
  if (cachedAjv !== undefined) {
    return cachedAjv;
  }

  const ajvModule = nodeRequire("ajv") as
    | AjvConstructor
    | { readonly default?: AjvConstructor };
  const Ajv = typeof ajvModule === "function" ? ajvModule : ajvModule.default;
  if (Ajv === undefined) {
    throw new TypeError("Ajv default export is unavailable.");
  }
  cachedAjv = new Ajv({ allErrors: true, strict: false, validateSchema: true });
  return cachedAjv;
}

function validateSupportedSchemaSubset(
  schema: NormalizedSchemaDescriptor,
  path: string,
  findings: LwirValidationFinding[],
): void {
  if (typeof schema === "boolean") {
    return;
  }
  validateSchemaRecordSubset(schema, path, findings);
}

function validateSchemaRecordSubset(
  schema: JsonRecord,
  path: string,
  findings: LwirValidationFinding[],
): void {
  for (const key of Object.keys(schema)) {
    if (!SUPPORTED_JSON_SCHEMA_KEYS.has(key)) {
      findings.push(
        finding(
          "schema.invalid",
          path,
          `Unsupported JSON Schema keyword '${key}' in alpha LWIR.`,
        ),
      );
      return;
    }
  }

  if (schema.type !== undefined) {
    validateSchemaTypeSubset(schema.type, path, findings);
  }
  if (schema.required !== undefined && !isStringArray(schema.required)) {
    findings.push(
      finding("schema.invalid", path, "JSON Schema required must be a string array."),
    );
  }
  if (isStringArray(schema.required) && !isRecord(schema.properties)) {
    findings.push(
      finding(
        "schema.invalid",
        path,
        "JSON Schema required keys must have a matching properties object.",
      ),
    );
  }
  if (schema.properties !== undefined) {
    if (!isRecord(schema.properties)) {
      findings.push(
        finding("schema.invalid", path, "JSON Schema properties must be an object."),
      );
    } else {
      for (const value of Object.values(schema.properties)) {
        validateNestedSchemaSubset(value, path, findings);
      }
      if (isStringArray(schema.required)) {
        for (const requiredKey of schema.required) {
          if (!(requiredKey in schema.properties)) {
            findings.push(
              finding(
                "schema.invalid",
                path,
                `JSON Schema required key '${requiredKey}' must exist in properties.`,
              ),
            );
          }
        }
      }
    }
  }
  if (schema.additionalProperties !== undefined) {
    const additionalProperties = schema.additionalProperties;
    if (
      typeof additionalProperties !== "boolean" &&
      !isRecord(additionalProperties)
    ) {
      findings.push(
        finding(
          "schema.invalid",
          path,
          "JSON Schema additionalProperties must be a boolean or schema.",
        ),
      );
    } else if (isRecord(additionalProperties)) {
      validateSchemaRecordSubset(additionalProperties, path, findings);
    }
  }
  if (schema.items !== undefined) {
    validateNestedSchemaSubset(schema.items, path, findings);
  }
  if (schema.enum !== undefined && !Array.isArray(schema.enum)) {
    findings.push(finding("schema.invalid", path, "JSON Schema enum must be an array."));
  }
  for (const key of ["anyOf", "oneOf"]) {
    const value = schema[key];
    if (value === undefined) {
      continue;
    }
    if (!Array.isArray(value) || value.length === 0) {
      findings.push(
        finding("schema.invalid", path, `JSON Schema ${key} must be a non-empty array.`),
      );
      continue;
    }
    if (!isSupportedSchemaUnion(value)) {
      findings.push(
        finding(
          "schema.invalid",
          path,
          `JSON Schema ${key} branches must be primitive or explicitly discriminated object shapes.`,
        ),
      );
    }
    for (const branch of value) {
      validateNestedSchemaSubset(branch, path, findings);
    }
  }
  validateNumericBound(schema.minimum, "minimum", path, findings);
  validateNumericBound(schema.maximum, "maximum", path, findings);
  validateNonNegativeIntegerBound(schema.minItems, "minItems", path, findings);
  validateNonNegativeIntegerBound(schema.maxItems, "maxItems", path, findings);
  validateNonNegativeIntegerBound(schema.minLength, "minLength", path, findings);
  validateNonNegativeIntegerBound(schema.maxLength, "maxLength", path, findings);
  validateOrderedBounds(schema.minimum, schema.maximum, "minimum", "maximum", path, findings);
  validateOrderedBounds(schema.minItems, schema.maxItems, "minItems", "maxItems", path, findings);
  validateOrderedBounds(
    schema.minLength,
    schema.maxLength,
    "minLength",
    "maxLength",
    path,
    findings,
  );
}

function validateNestedSchemaSubset(
  value: unknown,
  path: string,
  findings: LwirValidationFinding[],
): void {
  if (typeof value === "boolean") {
    return;
  }
  if (!isRecord(value)) {
    findings.push(finding("schema.invalid", path, "Nested JSON Schema must be an object."));
    return;
  }
  validateSchemaRecordSubset(value, path, findings);
}

function validateSchemaTypeSubset(
  value: unknown,
  path: string,
  findings: LwirValidationFinding[],
): void {
  if (typeof value === "string") {
    if (!VALID_JSON_SCHEMA_TYPES.has(value)) {
      findings.push(finding("schema.invalid", path, `Unsupported JSON Schema type '${value}'.`));
    }
    return;
  }
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
    for (const entry of value) {
      if (
        !VALID_JSON_SCHEMA_TYPES.has(entry) ||
        entry === "object" ||
        entry === "array"
      ) {
        findings.push(
          finding("schema.invalid", path, `Unsupported JSON Schema type '${entry}'.`),
        );
        return;
      }
    }
    return;
  }
  findings.push(
    finding("schema.invalid", path, "JSON Schema type must be a string or string array."),
  );
}

function validateNumericBound(
  value: unknown,
  key: string,
  path: string,
  findings: LwirValidationFinding[],
): void {
  if (value !== undefined && typeof value !== "number") {
    findings.push(finding("schema.invalid", path, `JSON Schema ${key} must be a number.`));
  }
}

function validateNonNegativeIntegerBound(
  value: unknown,
  key: string,
  path: string,
  findings: LwirValidationFinding[],
): void {
  if (value !== undefined && (!Number.isInteger(value) || (value as number) < 0)) {
    findings.push(
      finding("schema.invalid", path, `JSON Schema ${key} must be a non-negative integer.`),
    );
  }
}

function validateOrderedBounds(
  minimum: unknown,
  maximum: unknown,
  minimumKey: string,
  maximumKey: string,
  path: string,
  findings: LwirValidationFinding[],
): void {
  if (
    typeof minimum === "number" &&
    typeof maximum === "number" &&
    minimum > maximum
  ) {
    findings.push(
      finding(
        "schema.invalid",
        path,
        `JSON Schema ${minimumKey} must be less than or equal to ${maximumKey}.`,
      ),
    );
  }
}

function isSupportedSchemaUnion(branches: readonly unknown[]): boolean {
  return branches.every((branch) => isPrimitiveSchemaBranch(branch)) || hasDiscriminator(branches);
}

function isPrimitiveSchemaBranch(branch: unknown): boolean {
  if (typeof branch === "boolean") {
    return true;
  }
  if (!isRecord(branch)) {
    return false;
  }
  const type = branch.type;
  return (
    typeof type === "string" &&
    type !== "object" &&
    type !== "array" &&
    VALID_JSON_SCHEMA_TYPES.has(type)
  );
}

function hasDiscriminator(branches: readonly unknown[]): boolean {
  let discriminator: string | undefined;

  for (const branch of branches) {
    if (!isRecord(branch) || branch.type !== "object" || !isRecord(branch.properties)) {
      return false;
    }
    const required = isStringArray(branch.required) ? new Set(branch.required) : new Set<string>();
    let branchDiscriminator: string | undefined;

    for (const [key, value] of Object.entries(branch.properties)) {
      if (!required.has(key) || !isRecord(value)) {
        continue;
      }
      if (value.const !== undefined || Array.isArray(value.enum)) {
        branchDiscriminator = key;
        break;
      }
    }

    if (branchDiscriminator === undefined) {
      return false;
    }
    if (discriminator === undefined) {
      discriminator = branchDiscriminator;
    } else if (discriminator !== branchDiscriminator) {
      return false;
    }
  }

  return discriminator !== undefined;
}

function isValidExpression(expression: string): boolean {
  const disjunction = splitTopLevelByToken(expression, "||");
  if (disjunction.length > 1) {
    return disjunction.every((part) => isValidExpression(part.trim()));
  }

  const conjunction = splitTopLevelByToken(expression, "&&");
  if (conjunction.length > 1) {
    return conjunction.every((part) => isValidExpression(part.trim()));
  }

  const comparison = findTopLevelComparison(expression);
  if (comparison !== undefined) {
    const left = expression.slice(0, comparison.index).trim();
    const right = expression.slice(comparison.index + comparison.operator.length).trim();
    return isValidOperand(left) && isValidOperand(right);
  }

  return isValidOperand(expression);
}

function isValidOperand(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return false;
  }
  if (isStringLiteral(trimmed) || isNumberLiteral(trimmed)) {
    return true;
  }
  if (trimmed === "true" || trimmed === "false" || trimmed === "null") {
    return true;
  }
  const call = parseFunctionCall(trimmed);
  if (call !== undefined) {
    const arity = SAFE_FUNCTION_ARITY[call.name];
    if (arity === undefined) {
      return false;
    }
    if (call.args.length < arity.min || (arity.max !== undefined && call.args.length > arity.max)) {
      return false;
    }
    return call.args.every((arg) => isValidExpression(arg.trim()));
  }
  return isValidPathExpression(trimmed);
}

function parseFunctionCall(
  value: string,
): { readonly name: string; readonly args: readonly string[] } | undefined {
  const match = /^([A-Za-z_$][\w$]*)\s*\(/u.exec(value);
  if (match === null || !value.endsWith(")")) {
    return undefined;
  }
  const openIndex = value.indexOf("(", match[1]?.length ?? 0);
  if (matchingCloseParenIndex(value, openIndex) !== value.length - 1) {
    return undefined;
  }
  const inner = value.slice(openIndex + 1, -1).trim();
  return {
    name: match[1] ?? "",
    args: inner.length === 0 ? [] : splitTopLevelByToken(inner, ","),
  };
}

function matchingCloseParenIndex(value: string, openIndex: number): number | undefined {
  let depth = 0;
  let quote: '"' | "'" | undefined;
  for (let index = openIndex; index < value.length; index += 1) {
    const char = value[index];
    if (quote !== undefined) {
      if (char === "\\" && index + 1 < value.length) {
        index += 1;
        continue;
      }
      if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "(") {
      depth += 1;
      continue;
    }
    if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
      if (depth < 0) {
        return undefined;
      }
    }
  }
  return undefined;
}

function splitTopLevelByToken(value: string, token: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: '"' | "'" | undefined;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quote !== undefined) {
      if (char === "\\" && index + 1 < value.length) {
        index += 1;
        continue;
      }
      if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "(" || char === "[") {
      depth += 1;
      continue;
    }
    if (char === ")" || char === "]") {
      depth -= 1;
      if (depth < 0) {
        return [value];
      }
      continue;
    }
    if (depth === 0 && value.startsWith(token, index)) {
      parts.push(value.slice(start, index));
      index += token.length - 1;
      start = index + 1;
    }
  }

  if (parts.length === 0) {
    return [value];
  }
  parts.push(value.slice(start));
  return parts;
}

function findTopLevelComparison(
  value: string,
): { readonly index: number; readonly operator: string } | undefined {
  let depth = 0;
  let quote: '"' | "'" | undefined;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quote !== undefined) {
      if (char === "\\" && index + 1 < value.length) {
        index += 1;
        continue;
      }
      if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "(" || char === "[") {
      depth += 1;
      continue;
    }
    if (char === ")" || char === "]") {
      depth -= 1;
      if (depth < 0) {
        return undefined;
      }
      continue;
    }
    if (depth !== 0) {
      continue;
    }
    for (const operator of COMPARISON_OPERATORS) {
      if (value.startsWith(operator, index)) {
        return { index, operator };
      }
    }
  }
  return undefined;
}

function isValidPathExpression(value: string): boolean {
  const first = readPathSegment(value, 0, false);
  if (first === undefined || !EXPRESSION_ROOTS.has(first.segment)) {
    return false;
  }
  let index = first.nextIndex;
  while (index < value.length) {
    const char = value[index];
    if (char === ".") {
      const next = readPathSegment(value, index + 1, true);
      if (next === undefined) {
        return false;
      }
      index = next.nextIndex;
      continue;
    }
    if (char === "[") {
      const next = readPathIndex(value, index);
      if (next === undefined) {
        return false;
      }
      index = next;
      continue;
    }
    return false;
  }
  return true;
}

function readPathSegment(
  value: string,
  index: number,
  allowHyphen: boolean,
): { readonly segment: string; readonly nextIndex: number } | undefined {
  const pattern = allowHyphen ? /[A-Za-z_$][\w$-]*/uy : /[A-Za-z_$][\w$]*/uy;
  pattern.lastIndex = index;
  const match = pattern.exec(value);
  const segment = match?.[0];
  if (segment === undefined || FORBIDDEN_PATH_SEGMENTS.has(segment)) {
    return undefined;
  }
  return { segment, nextIndex: index + segment.length };
}

function readPathIndex(value: string, index: number): number | undefined {
  let cursor = index + 1;
  const first = value[cursor];
  if (first === '"' || first === "'") {
    const literal = readQuotedLiteral(value, cursor);
    if (literal === undefined || value[literal.nextIndex] !== "]") {
      return undefined;
    }
    if (FORBIDDEN_PATH_SEGMENTS.has(literal.value)) {
      return undefined;
    }
    return literal.nextIndex + 1;
  }

  const numberMatch = /\d+/uy;
  numberMatch.lastIndex = cursor;
  const match = numberMatch.exec(value);
  if (match === null) {
    return undefined;
  }
  cursor += match[0].length;
  return value[cursor] === "]" ? cursor + 1 : undefined;
}

function readQuotedLiteral(
  value: string,
  index: number,
): { readonly value: string; readonly nextIndex: number } | undefined {
  const quote = value[index];
  if (quote !== '"' && quote !== "'") {
    return undefined;
  }
  let result = "";
  for (let cursor = index + 1; cursor < value.length; cursor += 1) {
    const char = value[cursor];
    if (char === "\\" && cursor + 1 < value.length) {
      result += value[cursor + 1] ?? "";
      cursor += 1;
      continue;
    }
    if (char === quote) {
      return { value: result, nextIndex: cursor + 1 };
    }
    result += char;
  }
  return undefined;
}

function isStringLiteral(value: string): boolean {
  const quote = value[0];
  if ((quote !== '"' && quote !== "'") || value[value.length - 1] !== quote) {
    return false;
  }
  return readQuotedLiteral(value, 0)?.nextIndex === value.length;
}

function isNumberLiteral(value: string): boolean {
  return /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value);
}

function templateExpressionReferencesRoot(value: string, root: string): boolean {
  const expressions = expressionsIn(value);
  if (expressions.length !== 1) {
    return false;
  }
  return expressionBodyReferencesRoot(expressions[0] ?? "", root);
}

function expressionBodyReferencesRoot(expression: string, root: string): boolean {
  return new RegExp(
    `(^|[^A-Za-z0-9_$.-])${root}(?=$|\\s|[.\\[\\],=!<>|&)])`,
    "u",
  ).test(
    expressionWithoutStringLiterals(expression),
  );
}

function expressionUsesNumericStepIndex(expression: string): boolean {
  return /(^|[^A-Za-z0-9_$.-])steps\s*\[\s*\d+\s*\]/u.test(
    expressionWithoutStringLiterals(expression),
  );
}

function expressionWithoutStringLiterals(expression: string): string {
  return expression.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/gu, "");
}

function stepReferencesIn(step: JsonRecord, stepPath: string): readonly StepReference[] {
  const references: StepReference[] = [];
  collectStepReferences(step.with, `${stepPath}.with`, references);
  collectStepReferences(step.input, `${stepPath}.input`, references);
  collectStepReferences(step.cache, `${stepPath}.cache`, references);
  return references;
}

function collectStepReferences(
  value: unknown,
  path: string,
  references: StepReference[],
): void {
  if (typeof value === "string") {
    for (const expression of expressionsIn(value)) {
      for (const ref of fullStepReferencesInExpression(expression)) {
        references.push({ id: ref.id, property: ref.property, path });
      }
    }
    return;
  }

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      collectStepReferences(value[index], `${path}[${index}]`, references);
    }
    return;
  }

  if (isRecord(value)) {
    for (const key of Object.keys(value)) {
      collectStepReferences(value[key], `${path}.${key}`, references);
    }
  }
}

function fullStepReferencesInExpression(
  expression: string,
): readonly { readonly id: string; readonly property: string | undefined }[] {
  const refs: { readonly id: string; readonly property: string | undefined }[] = [];
  let quote: '"' | "'" | undefined;

  for (let index = 0; index < expression.length; index += 1) {
    const char = expression[index];
    if (quote !== undefined) {
      if (char === "\\" && index + 1 < expression.length) {
        index += 1;
        continue;
      }
      if (char === quote) {
        quote = undefined;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (!hasPathBoundary(expression, index) || !expression.startsWith("steps", index)) {
      continue;
    }

    const nextChar = expression[index + "steps".length];
    if (nextChar === ".") {
      const step = readPathSegment(expression, index + "steps.".length, true);
      if (step !== undefined) {
        // Read the property segment after steps.X.
        let property: string | undefined;
        if (expression[step.nextIndex] === ".") {
          const prop = readPathSegment(expression, step.nextIndex + 1, true);
          if (prop !== undefined) {
            property = prop.segment;
          }
        }
        refs.push({ id: step.segment, property });
        index = step.nextIndex - 1;
      }
      continue;
    }

    if (nextChar === "[") {
      const step = readBracketedPathSegment(expression, index + "steps".length);
      if (step !== undefined) {
        // For bracket-form references, check for a .property after the bracket
        let property: string | undefined;
        if (expression[step.nextIndex] === ".") {
          const prop = readPathSegment(expression, step.nextIndex + 1, true);
          if (prop !== undefined) {
            property = prop.segment;
          }
        }
        refs.push({ id: step.segment, property });
        index = step.nextIndex - 1;
      }
    }
  }

  return refs;
}

function stepIdsInExpression(expression: string): readonly string[] {
  const ids = new Set<string>();
  for (const ref of fullStepReferencesInExpression(expression)) {
    ids.add(ref.id);
  }
  return [...ids];
}

function hasPathBoundary(value: string, index: number): boolean {
  return index === 0 || !/[A-Za-z0-9_$]/u.test(value[index - 1] ?? "");
}

function readBracketedPathSegment(
  value: string,
  index: number,
): { readonly segment: string; readonly nextIndex: number } | undefined {
  if (value[index] !== "[") {
    return undefined;
  }
  const literal = readQuotedLiteral(value, index + 1);
  if (literal === undefined || value[literal.nextIndex] !== "]") {
    return undefined;
  }
  if (FORBIDDEN_PATH_SEGMENTS.has(literal.value)) {
    return undefined;
  }
  return { segment: literal.value, nextIndex: literal.nextIndex + 1 };
}

function jsonOutputNeedsSchema(step: JsonRecord): boolean {
  return isRecord(step.output) && step.output.mode === "json" && step.output.schema === undefined;
}

function isSafeCodePath(value: string): boolean {
  if (
    value.length === 0 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("\0")
  ) {
    return false;
  }
  const segments = value.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function sha256TextDigest(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

/**
 * Build the union of needs-edges and decision-transition-edges for a step list.
 *
 * Edge direction is execution-flow order: an edge A→B means A can reach B.
 *   - needs-edges: if B.needs contains A, then A→B (A runs before B → A can reach B).
 *   - decision-transition-edges: if a decision step D routes to target T, then D→T.
 *
 * Only local steps (present in stepsById) are included; external refs and "end" are skipped.
 */
function buildExecutionFlowEdges(
  stepsById: ReadonlyMap<string, JsonRecord>,
  dependenciesById: ReadonlyMap<string, readonly string[]>,
): Map<string, Set<string>> {
  const stepIds = [...stepsById.keys()];
  const outgoing = new Map<string, Set<string>>();
  for (const id of stepIds) {
    outgoing.set(id, new Set<string>());
  }

  for (const id of stepIds) {
    // needs-edges: dependency can reach this step
    for (const dep of dependenciesById.get(id) ?? []) {
      if (stepsById.has(dep)) {
        outgoing.get(dep)?.add(id);
      }
    }

    // decision transition edges
    const step = stepsById.get(id);
    if (step !== undefined && step.uses === "decision" && isRecord(step.with)) {
      const cfg = step.with as { cases?: ReadonlyArray<{ to?: unknown }>; default?: unknown };
      if (typeof cfg.default === "string" && cfg.default !== "end" && stepsById.has(cfg.default)) {
        outgoing.get(id)?.add(cfg.default);
      }
      for (const c of cfg.cases ?? []) {
        if (typeof c?.to === "string" && c.to !== "end" && stepsById.has(c.to)) {
          outgoing.get(id)?.add(c.to);
        }
      }
    }
  }

  return outgoing;
}

/**
 * BFS reachability check: can we reach `toId` starting from `fromId` using the given edge map?
 * Returns true iff toId is reachable from fromId (not counting fromId itself as a trivial match).
 */
function canReach(
  fromId: string,
  toId: string,
  outgoing: ReadonlyMap<string, ReadonlySet<string>>,
): boolean {
  const visited = new Set<string>();
  const queue: string[] = [fromId];
  visited.add(fromId);
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const neighbor of outgoing.get(current) ?? []) {
      if (neighbor === toId) return true;
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        queue.push(neighbor);
      }
    }
  }
  return false;
}

/**
 * Validate cycles in a step list using Tarjan's SCC algorithm over the union of:
 *   - needs-edges (dep → step, i.e., execution order edges)
 *   - decision step transition edges (decision → target)
 *
 * A non-trivial SCC (size > 1, or single node with a self-edge) is only valid if:
 *   1. At least one step on the cycle has uses === "decision"
 *   2. Every step on the cycle has maxVisits >= 2
 */
function validateCycles(
  stepsById: ReadonlyMap<string, JsonRecord>,
  outgoing: ReadonlyMap<string, ReadonlySet<string>>,
  path: string,
  findings: LwirValidationFinding[],
): void {
  const stepIds = [...stepsById.keys()];

  // Tarjan's SCC (iterative)
  const sccs = tarjanSCC(stepIds, outgoing);

  for (const scc of sccs) {
    // Skip trivial SCCs: single node with no self-loop
    if (scc.length === 1 && !(outgoing.get(scc[0])?.has(scc[0]) ?? false)) {
      continue;
    }

    const allMultiVisit = scc.every(
      (id) => ((stepsById.get(id)?.maxVisits as number | undefined) ?? 1) >= 2,
    );

    if (!allMultiVisit) {
      findings.push(
        finding(
          "lwir.invalid_cycle",
          path,
          `Cycle [${scc.join(" -> ")}] is invalid: every cycle step must have maxVisits >= 2.`,
        ),
      );
      continue;
    }

    // Residual-graph check: remove decision nodes from the SCC's induced subgraph
    // and re-run Tarjan. Any non-trivial residual SCC is a cycle with no decision step.
    const sccSet = new Set(scc);
    const residualIds = scc.filter((id) => stepsById.get(id)?.uses !== "decision");
    const residualOutgoing = new Map<string, Set<string>>();
    for (const id of residualIds) {
      const filtered = new Set<string>();
      for (const dest of outgoing.get(id) ?? []) {
        if (sccSet.has(dest) && stepsById.get(dest)?.uses !== "decision") {
          filtered.add(dest);
        }
      }
      residualOutgoing.set(id, filtered);
    }
    const residualSccs = tarjanSCC(residualIds, residualOutgoing);
    for (const residual of residualSccs) {
      const isNonTrivial =
        residual.length > 1 ||
        (residual.length === 1 && (residualOutgoing.get(residual[0])?.has(residual[0]) ?? false));
      if (isNonTrivial) {
        findings.push(
          finding(
            "lwir.invalid_cycle",
            path,
            `Cycle [${residual.join(" -> ")}] is invalid: cycle must contain a decision step.`,
          ),
        );
      }
    }
  }
}

/**
 * Iterative Tarjan's strongly connected components algorithm.
 * Returns all SCCs (including trivial ones for the caller to filter).
 */
function tarjanSCC(
  nodeIds: readonly string[],
  outgoing: ReadonlyMap<string, ReadonlySet<string>>,
): readonly (readonly string[])[] {
  const index = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const sccs: string[][] = [];
  let counter = 0;

  // Iterative DFS using an explicit call stack
  // Each frame: { node, iterator over neighbors, isNew }
  type Frame = {
    node: string;
    neighbors: Iterator<string>;
    processed: boolean;
  };

  const callStack: Frame[] = [];

  const startNode = (node: string): void => {
    index.set(node, counter);
    lowlink.set(node, counter);
    counter += 1;
    stack.push(node);
    onStack.add(node);
    callStack.push({
      node,
      neighbors: (outgoing.get(node) ?? new Set<string>())[Symbol.iterator](),
      processed: false,
    });
  };

  for (const nodeId of nodeIds) {
    if (index.has(nodeId)) {
      continue;
    }
    startNode(nodeId);

    while (callStack.length > 0) {
      const frame = callStack[callStack.length - 1]!;
      const { node, neighbors } = frame;

      const next = neighbors.next();
      if (!next.done) {
        const neighbor = next.value;
        if (!index.has(neighbor)) {
          // Tree edge: recurse
          startNode(neighbor);
        } else if (onStack.has(neighbor)) {
          // Back edge: update lowlink
          const currentLowlink = lowlink.get(node) ?? 0;
          const neighborIndex = index.get(neighbor) ?? 0;
          if (neighborIndex < currentLowlink) {
            lowlink.set(node, neighborIndex);
          }
        }
        // Cross or forward edges: ignore
      } else {
        // All neighbors processed: pop this frame
        callStack.pop();
        if (callStack.length > 0) {
          const parent = callStack[callStack.length - 1]!.node;
          const parentLowlink = lowlink.get(parent) ?? 0;
          const nodeLowlink = lowlink.get(node) ?? 0;
          if (nodeLowlink < parentLowlink) {
            lowlink.set(parent, nodeLowlink);
          }
        }

        // If node is SCC root, pop the SCC
        if ((lowlink.get(node) ?? 0) === (index.get(node) ?? 0)) {
          const scc: string[] = [];
          let w: string | undefined;
          do {
            w = stack.pop();
            if (w !== undefined) {
              onStack.delete(w);
              scc.push(w);
            }
          } while (w !== undefined && w !== node);
          sccs.push(scc);
        }
      }
    }
  }

  return sccs;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function validationContextFor(lwir: JsonRecord): ValidationContext {
  if (!isRecord(lwir.permissions)) {
    return {};
  }
  return {
    ...(isStringArray(lwir.permissions.models)
      ? { allowedModels: new Set(lwir.permissions.models) }
      : {}),
    ...(isStringArray(lwir.permissions.tools)
      ? { allowedTools: new Set(lwir.permissions.tools) }
      : {}),
  };
}

function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const item of value) {
      deepFreeze(item);
    }
    return Object.freeze(value) as T;
  }

  if (isRecord(value)) {
    for (const item of Object.values(value)) {
      deepFreeze(item);
    }
    return Object.freeze(value) as T;
  }

  return value;
}

function invalid(findings: LwirValidationFinding[]): LwirValidationResult {
  return { valid: false, findings };
}

function finding(
  code: string,
  path: string,
  message: string,
): LwirValidationFinding {
  return { severity: "error", code, path, message };
}
