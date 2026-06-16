import type { LocalWorld } from "./authoring.js";
import { sha256Digest } from "./canonical.js";
import { validateLwir, type LwirWorkflow } from "./lwir.js";
import { readStoredWorkflowVersion } from "./workflow-version-store.js";
import { listRunIds, type EventEnvelope } from "./world.js";

export type PlannerReuseCandidate = {
  readonly workflowVersionId: string;
  readonly runId: string;
  readonly workflowId: string;
  readonly completedAt: string;
  readonly workflowVersion: unknown;
  readonly planningDefinitionSnapshot?: unknown;
  readonly planningDefinitionSnapshotHash?: string;
  readonly priorOutput?: unknown;
};

export type PlannerReuseDecision =
  | {
      readonly kind: "reuse_unchanged";
      readonly workflowVersionId: string;
      readonly rationale: string;
      readonly acknowledgedWarnings?: readonly string[];
    }
  | {
      readonly kind: "adapt";
      readonly baseWorkflowVersionId: string;
      readonly rationale: string;
      readonly lwir: LwirWorkflow;
    }
  | {
      readonly kind: "draft_fresh";
      readonly rationale: string;
      readonly lwir: LwirWorkflow;
    };

export type PlannerReuseDecisionValidationOptions = {
  readonly candidates: readonly PlannerReuseCandidate[];
  readonly warnings?: readonly string[];
  readonly blocks?: readonly string[];
};

export async function selectPlannerReuseCandidates(
  world: LocalWorld,
  options: { readonly workflowId: string; readonly limit?: number },
): Promise<readonly PlannerReuseCandidate[]> {
  const runIds = await listRunIds(world);
  const candidates: PlannerReuseCandidate[] = [];
  for (const runId of runIds) {
    const candidate = await candidateForRun(world, runId, options.workflowId);
    if (candidate !== undefined) {
      candidates.push(candidate);
    }
  }

  candidates.sort((left, right) => compareStrings(right.completedAt, left.completedAt));
  const newestByWorkflowVersion = new Map<string, PlannerReuseCandidate>();
  for (const candidate of candidates) {
    if (!newestByWorkflowVersion.has(candidate.workflowVersionId)) {
      newestByWorkflowVersion.set(candidate.workflowVersionId, candidate);
    }
  }

  const selected = [...newestByWorkflowVersion.values()];
  return options.limit === undefined ? selected : selected.slice(0, Math.max(0, options.limit));
}

export function buildReuseBrief(options: {
  readonly candidate: PlannerReuseCandidate;
  readonly currentPlanningDefinitionSnapshot?: unknown;
  readonly mountedRoot: string;
}): { readonly text: string; readonly briefHash: string; readonly warnings: readonly string[] } {
  const basePath = `${options.mountedRoot.replace(/\/+$/u, "")}/${options.candidate.workflowVersionId}`;
  const warnings = planningSnapshotWarnings(
    options.candidate.planningDefinitionSnapshot,
    options.currentPlanningDefinitionSnapshot,
  );
  const text = [
    `# Planner Reuse Candidate`,
    ``,
    `Candidate WorkflowVersion: ${options.candidate.workflowVersionId}`,
    `Workflow ID: ${options.candidate.workflowId}`,
    `Run ID: ${options.candidate.runId}`,
    `Completed At: ${options.candidate.completedAt}`,
    ``,
    `## Step Graph`,
    ``,
    "```mermaid",
    mermaidGraphFor(options.candidate.workflowVersion),
    "```",
    ``,
    `## Mounted Details`,
    ``,
    `- LWIR: ${basePath}/lwir.json`,
    `- Lock: ${basePath}/lock.json`,
    `- Planning definition snapshot: ${basePath}/planning-definition-snapshot.json`,
    `- Prior input summary: ${basePath}/prior-input-summary.md`,
    `- Prior output summary: ${basePath}/prior-output-summary.md`,
    `- Feedback summary: ${basePath}/feedback-summary.md`,
    ``,
    `## Warnings`,
    ``,
    ...(
      warnings.length === 0
        ? ["- none"]
        : warnings.map((warning) => `- ${warning}`)
    ),
    ``,
  ].join("\n");
  return { text, briefHash: sha256Digest(text), warnings };
}

export function validatePlannerReuseDecision(
  decision: unknown,
  options: PlannerReuseDecisionValidationOptions,
): PlannerReuseDecision {
  if (!isRecord(decision) || typeof decision.kind !== "string") {
    throw new TypeError("Malformed planner reuse decision.");
  }
  switch (decision.kind) {
    case "reuse_unchanged":
      return validateReuseUnchangedDecision(decision, options);
    case "adapt":
      return validateAdaptDecision(decision, options);
    case "draft_fresh":
      return validateDraftFreshDecision(decision);
    default:
      throw new TypeError("Malformed planner reuse decision.");
  }
}

async function candidateForRun(
  world: LocalWorld,
  runId: string,
  workflowId: string,
): Promise<PlannerReuseCandidate | undefined> {
  const events = await world.listEvents(runId);
  if (!events.some((event) =>
    event.type === "OrchestrationRequested" &&
    event.payload.workflowId === workflowId
  )) {
    return undefined;
  }

  const completed = lastEventOfType(events, "RunCompleted");
  const registered = lastEventOfType(events, "WorkflowVersionRegistered");
  const workflowVersionId = stringValue(registered?.payload.workflowVersionId);
  if (completed === undefined || workflowVersionId === undefined) {
    return undefined;
  }

  let workflowVersion: unknown;
  try {
    workflowVersion = await readStoredWorkflowVersion(world, workflowVersionId);
  } catch {
    return undefined;
  }
  if (!isReadableWorkflowVersion(workflowVersion, workflowVersionId)) {
    return undefined;
  }

  const lock = isRecord(workflowVersion.lock) ? workflowVersion.lock : undefined;
  return {
    workflowVersionId,
    runId,
    workflowId,
    completedAt: completed.recordedAt,
    workflowVersion,
    ...(Object.hasOwn(completed.payload, "output") ? { priorOutput: completed.payload.output } : {}),
    ...(lock !== undefined && Object.hasOwn(lock, "planningDefinitionSnapshot")
      ? { planningDefinitionSnapshot: lock.planningDefinitionSnapshot }
      : {}),
    ...(typeof lock?.planningDefinitionSnapshotHash === "string"
      ? { planningDefinitionSnapshotHash: lock.planningDefinitionSnapshotHash }
      : {}),
  };
}

function lastEventOfType<TType extends EventEnvelope["type"]>(
  events: readonly EventEnvelope[],
  type: TType,
): (EventEnvelope & { readonly type: TType }) | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === type) {
      return event as EventEnvelope & { readonly type: TType };
    }
  }
  return undefined;
}

function validateReuseUnchangedDecision(
  decision: Record<string, unknown>,
  options: PlannerReuseDecisionValidationOptions,
): PlannerReuseDecision {
  const workflowVersionId = stringValue(decision.workflowVersionId);
  const rationale = rationaleValue(decision.rationale);
  if (workflowVersionId === undefined) {
    throw new TypeError("Malformed planner reuse decision: workflowVersionId is required.");
  }
  if (rationale === undefined) {
    throw new TypeError("Planner reuse decision rationale must be a non-empty string.");
  }
  assertCandidateExists(options.candidates, workflowVersionId);
  const blocks = options.blocks ?? [];
  if (blocks.length > 0) {
    throw new Error(`reuse_unchanged is blocked: ${blocks.join("; ")}`);
  }

  const warnings = options.warnings ?? [];
  const acknowledgedWarnings = acknowledgedWarningValues(decision.acknowledgedWarnings);
  if (
    warnings.length > 0 &&
    (acknowledgedWarnings === undefined ||
      warnings.some((warning) => !acknowledgedWarnings.includes(warning)))
  ) {
    throw new Error(
      `reuse_unchanged must acknowledge candidate warnings: ${warnings.join("; ")}`,
    );
  }

  return stripUndefined({
    kind: "reuse_unchanged" as const,
    workflowVersionId,
    rationale,
    acknowledgedWarnings,
  });
}

function validateAdaptDecision(
  decision: Record<string, unknown>,
  options: PlannerReuseDecisionValidationOptions,
): PlannerReuseDecision {
  const baseWorkflowVersionId = stringValue(decision.baseWorkflowVersionId);
  const rationale = rationaleValue(decision.rationale);
  if (baseWorkflowVersionId === undefined) {
    throw new TypeError("Malformed planner reuse decision: baseWorkflowVersionId is required.");
  }
  if (rationale === undefined) {
    throw new TypeError("Planner reuse decision rationale must be a non-empty string.");
  }
  assertCandidateExists(options.candidates, baseWorkflowVersionId);
  if (!Object.hasOwn(decision, "lwir") || decision.lwir === undefined) {
    throw new TypeError("Planner reuse decision lwir is required.");
  }
  const lwir = validDecisionLwir(decision.lwir);
  return {
    kind: "adapt",
    baseWorkflowVersionId,
    rationale,
    lwir,
  };
}

function validateDraftFreshDecision(
  decision: Record<string, unknown>,
): PlannerReuseDecision {
  const rationale = rationaleValue(decision.rationale);
  if (rationale === undefined) {
    throw new TypeError("Planner reuse decision rationale must be a non-empty string.");
  }
  if (!Object.hasOwn(decision, "lwir") || decision.lwir === undefined) {
    throw new TypeError("Planner reuse decision lwir is required.");
  }
  const lwir = validDecisionLwir(decision.lwir);
  return {
    kind: "draft_fresh",
    rationale,
    lwir,
  };
}

function validDecisionLwir(value: unknown): LwirWorkflow {
  const result = validateLwir(value);
  if (!result.valid) {
    throw new TypeError(
      `Invalid planner reuse decision LWIR: ${
        result.findings.map((finding) => `${finding.path}: ${finding.message}`).join("; ")
      }`,
    );
  }
  return value as LwirWorkflow;
}

function assertCandidateExists(
  candidates: readonly PlannerReuseCandidate[],
  workflowVersionId: string,
): void {
  if (!candidates.some((candidate) => candidate.workflowVersionId === workflowVersionId)) {
    throw new Error(`Planner reuse decision references a missing candidate: ${workflowVersionId}`);
  }
}

function acknowledgedWarningValues(value: unknown): readonly string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new TypeError("Malformed planner reuse decision: acknowledgedWarnings must be strings.");
  }
  return value;
}

function rationaleValue(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : value;
}

function mermaidGraphFor(workflowVersion: unknown): string {
  const steps = workflowVersionSteps(workflowVersion);
  if (steps.length === 0) {
    return `graph TD\n  empty["(no steps)"]`;
  }
  const lines = ["graph TD"];
  steps.forEach((stepId, index) => {
    lines.push(`  n${index}["${escapeMermaidLabel(stepId)}"]`);
    if (index > 0) {
      lines.push(`  n${index - 1} --> n${index}`);
    }
  });
  return lines.join("\n");
}

function workflowVersionSteps(workflowVersion: unknown): readonly string[] {
  if (!isRecord(workflowVersion) || !isRecord(workflowVersion.lwir)) {
    return [];
  }
  const stepIds: string[] = [];
  collectStepIds(workflowVersion.lwir.steps, stepIds);
  return stepIds;
}

function collectStepIds(value: unknown, stepIds: string[]): void {
  if (!Array.isArray(value)) {
    return;
  }
  for (const step of value) {
    if (!isRecord(step)) {
      continue;
    }
    const id = stringValue(step.id);
    if (id !== undefined) {
      stepIds.push(id);
    }
    collectStepIds(step.steps, stepIds);
  }
}

function planningSnapshotWarnings(
  prior: unknown,
  current: unknown,
): readonly string[] {
  if (current === undefined || prior === undefined) {
    return [];
  }
  const warnings: string[] = [];
  pushStringChangeWarning(
    warnings,
    "description changed",
    planningDescription(prior),
    planningDescription(current),
  );
  pushStringChangeWarning(
    warnings,
    "input schema hash changed",
    nestedString(prior, ["inputSchema", "hash"]),
    nestedString(current, ["inputSchema", "hash"]),
  );
  pushStringChangeWarning(
    warnings,
    "suggested input hash changed",
    nestedString(prior, ["suggestedInputSchema", "hash"]),
    nestedString(current, ["suggestedInputSchema", "hash"]),
  );
  pushStringChangeWarning(
    warnings,
    "requested output hash changed",
    nestedString(prior, ["requestedOutputHash"]),
    nestedString(current, ["requestedOutputHash"]),
  );
  pushValueChangeWarning(
    warnings,
    "planner model changed",
    plannerModelSnapshot(prior),
    plannerModelSnapshot(current),
  );
  pushStringChangeWarning(
    warnings,
    "planner harness changed",
    nestedString(prior, ["plannerConfig", "harnessId"]),
    nestedString(current, ["plannerConfig", "harnessId"]),
  );
  pushStringChangeWarning(
    warnings,
    "planner system changed",
    nestedString(prior, ["plannerConfig", "systemHash"]),
    nestedString(current, ["plannerConfig", "systemHash"]),
  );
  pushStringChangeWarning(
    warnings,
    "planner skills changed",
    nestedString(prior, ["plannerConfig", "skillsHash"]),
    nestedString(current, ["plannerConfig", "skillsHash"]),
  );
  pushValueChangeWarning(
    warnings,
    "model slots changed",
    nestedValue(prior, ["modelSlots"]),
    nestedValue(current, ["modelSlots"]),
  );
  pushStringChangeWarning(
    warnings,
    "planner-visible tools changed",
    nestedString(prior, ["plannerVisibleToolsHash"]),
    nestedString(current, ["plannerVisibleToolsHash"]),
  );
  pushStringChangeWarning(
    warnings,
    "tool selection changed",
    nestedString(prior, ["toolSelection"]),
    nestedString(current, ["toolSelection"]),
  );
  return warnings;
}

function planningDescription(snapshot: unknown): string | undefined {
  return nestedString(snapshot, ["description"]) ?? nestedString(snapshot, ["workflow", "description"]);
}

function plannerModelSnapshot(snapshot: unknown): unknown {
  const config = nestedValue(snapshot, ["plannerConfig"]);
  if (!isRecord(config)) {
    return undefined;
  }
  return {
    modelSlotId: config.modelSlotId,
    modelIdentity: config.modelIdentity,
  };
}

function pushStringChangeWarning(
  warnings: string[],
  warning: string,
  prior: string | undefined,
  current: string | undefined,
): void {
  if ((prior !== undefined || current !== undefined) && prior !== current) {
    warnings.push(warning);
  }
}

function pushValueChangeWarning(
  warnings: string[],
  warning: string,
  prior: unknown,
  current: unknown,
): void {
  const priorHash = optionalValueHash(prior);
  const currentHash = optionalValueHash(current);
  if ((priorHash !== undefined || currentHash !== undefined) && priorHash !== currentHash) {
    warnings.push(warning);
  }
}

function optionalValueHash(value: unknown): string | undefined {
  return value === undefined ? undefined : sha256Digest(value);
}

function nestedValue(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const segment of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

function nestedString(value: unknown, path: readonly string[]): string | undefined {
  return stringValue(nestedValue(value, path));
}

function escapeMermaidLabel(value: string): string {
  return value.replace(/["\\]/gu, "\\$&");
}

function isReadableWorkflowVersion(
  value: unknown,
  workflowVersionId: string,
): value is {
  readonly id: string;
  readonly hash: string;
  readonly canonicalizer: "little-workflow-canonical-json@alpha";
  readonly canonicalJson: string;
  readonly lwir: unknown;
  readonly lwirVersionId: string;
  readonly lwirHash: string;
  readonly lock: Record<string, unknown>;
} {
  return isRecord(value) &&
    value.id === workflowVersionId &&
    isSha256Digest(value.hash) &&
    value.canonicalizer === "little-workflow-canonical-json@alpha" &&
    typeof value.canonicalJson === "string" &&
    typeof value.lwirVersionId === "string" &&
    isSha256Digest(value.lwirHash) &&
    isPlausibleFullLwir(value.lwir) &&
    isRuntimeExecutableLock(value.lock, workflowVersionId, value.hash);
}

function isPlausibleFullLwir(value: unknown): boolean {
  return isRecord(value) &&
    value.apiVersion === "littleworkflow.dev/v0.1" &&
    value.kind === "Workflow" &&
    isRecord(value.metadata) &&
    typeof value.metadata.name === "string" &&
    isRecord(value.input) &&
    Object.hasOwn(value.input, "schema") &&
    isRecord(value.output) &&
    Object.hasOwn(value.output, "schema") &&
    Array.isArray(value.steps);
}

function isSha256Digest(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value);
}

function isRuntimeExecutableLock(
  value: unknown,
  workflowVersionId: string,
  workflowVersionHash: string,
): value is Record<string, unknown> {
  if (!isRecord(value)) {
    return false;
  }
  if (
    value.workflowVersionId !== workflowVersionId ||
    value.workflowVersionHash !== workflowVersionHash
  ) {
    return false;
  }
  const requiredHashFields = [
    "workflowVersionHash",
    "lwirHash",
    "requestHash",
    "inputHash",
    "plannedInputStructureHash",
    "workflowDefinitionHash",
    "inputSchemaHash",
    "requestedOutputHash",
    "capabilityManifestHash",
    "validationHash",
  ];
  if (requiredHashFields.some((field) => !isSha256Digest(value[field]))) {
    return false;
  }
  const requiredStringFields = [
    "workflowVersionId",
    "lwirVersionId",
    "requestId",
  ];
  if (requiredStringFields.some((field) => typeof value[field] !== "string")) {
    return false;
  }
  if (
    !Array.isArray(value.modelSlots) ||
    !Array.isArray(value.tools) ||
    !Object.hasOwn(value, "plannedInputStructure") ||
    !Object.hasOwn(value, "requestedOutput") ||
    !Object.hasOwn(value, "capabilityManifest")
  ) {
    return false;
  }
  if (
    value.planningDefinitionSnapshotHash !== undefined &&
    !isSha256Digest(value.planningDefinitionSnapshotHash)
  ) {
    return false;
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as T;
}
