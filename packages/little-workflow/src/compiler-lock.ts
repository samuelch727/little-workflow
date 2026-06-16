import { sha256Digest } from "./canonical.js";
import type { ConcreteInputStructure } from "./workflow-version-reuse.js";

export const COMPILER_VALIDATION_ALGORITHM =
  "little-workflow-compiler-binding@v0.1-alpha";
export const COMPILED_WORKFLOW_VERSION_ALGORITHM =
  "little-workflow-compiled-version@v0.1-alpha";

export type WorkflowVersionLockSeed = {
  readonly lwirVersionId: string;
  readonly lwirHash: string;
  readonly requestId: string;
  readonly requestHash: string;
  readonly inputHash: string;
  readonly plannedInputStructure: ConcreteInputStructure;
  readonly plannedInputStructureHash: string;
  readonly inputBinding?: "required";
  readonly workflowDefinitionHash: string;
  readonly planningDefinitionSnapshot?: unknown;
  readonly planningDefinitionSnapshotHash?: string;
  readonly inputSchemaHash: string;
  readonly requestedOutput: unknown;
  readonly requestedOutputHash: string;
  readonly capabilityManifest: unknown;
  readonly capabilityManifestHash: string;
  readonly modelSlots: readonly unknown[];
  readonly tools: readonly unknown[];
  readonly validationHash: string;
};

export type WorkflowVersionLockEnvelope = WorkflowVersionLockSeed & {
  readonly workflowVersionId: string;
  readonly workflowVersionHash: string;
};

export type CompilerValidationHashInput = {
  readonly canonicalizer: string;
  readonly lwirVersionId: string;
  readonly lwirHash: string;
  readonly requestId: string;
  readonly requestHash: string;
  readonly inputHash: string;
  readonly plannedInputStructureHash: string;
  readonly workflowDefinitionHash: string;
  readonly inputSchemaHash: string;
  readonly requestedOutputHash: string;
  readonly capabilityManifestHash: string;
};

export function computeCompilerValidationHash(
  input: CompilerValidationHashInput,
): string {
  return sha256Digest({
    algorithm: COMPILER_VALIDATION_ALGORITHM,
    valid: true,
    findings: [],
    lwirVersionId: input.lwirVersionId,
    lwirHash: input.lwirHash,
    canonicalizer: input.canonicalizer,
    requestId: input.requestId,
    requestHash: input.requestHash,
    inputHash: input.inputHash,
    plannedInputStructureHash: input.plannedInputStructureHash,
    requestBinding: {
      requestHash: input.requestHash,
      inputHash: input.inputHash,
      plannedInputStructureHash: input.plannedInputStructureHash,
      workflowDefinitionHash: input.workflowDefinitionHash,
      inputSchemaHash: input.inputSchemaHash,
      requestedOutputHash: input.requestedOutputHash,
      capabilityManifestHash: input.capabilityManifestHash,
    },
  });
}

export function computeCompiledWorkflowVersionIdentity(input: {
  readonly canonicalizer: string;
  readonly lwirVersionId: string;
  readonly lwirHash: string;
  readonly lockSeed: WorkflowVersionLockSeed;
}): { readonly workflowVersionHash: string; readonly workflowVersionId: string } {
  const workflowVersionHash = sha256Digest({
    algorithm: COMPILED_WORKFLOW_VERSION_ALGORITHM,
    canonicalizer: input.canonicalizer,
    lwirVersionId: input.lwirVersionId,
    lwirHash: input.lwirHash,
    lock: input.lockSeed,
  });
  return {
    workflowVersionHash,
    workflowVersionId: workflowVersionIdForHash(workflowVersionHash),
  };
}

export function workflowVersionLockSeedFrom(
  lock: WorkflowVersionLockEnvelope,
): WorkflowVersionLockSeed {
  return {
    lwirVersionId: lock.lwirVersionId,
    lwirHash: lock.lwirHash,
    requestId: lock.requestId,
    requestHash: lock.requestHash,
    inputHash: lock.inputHash,
    plannedInputStructure: lock.plannedInputStructure,
    plannedInputStructureHash: lock.plannedInputStructureHash,
    ...(lock.inputBinding === undefined ? {} : { inputBinding: lock.inputBinding }),
    workflowDefinitionHash: lock.workflowDefinitionHash,
    ...(lock.planningDefinitionSnapshot === undefined
      ? {}
      : { planningDefinitionSnapshot: lock.planningDefinitionSnapshot }),
    ...(lock.planningDefinitionSnapshotHash === undefined
      ? {}
      : { planningDefinitionSnapshotHash: lock.planningDefinitionSnapshotHash }),
    inputSchemaHash: lock.inputSchemaHash,
    requestedOutput: lock.requestedOutput,
    requestedOutputHash: lock.requestedOutputHash,
    capabilityManifest: lock.capabilityManifest,
    capabilityManifestHash: lock.capabilityManifestHash,
    modelSlots: lock.modelSlots,
    tools: lock.tools,
    validationHash: lock.validationHash,
  };
}

export function lwirVersionIdForHash(lwirHash: string): string {
  return `wfver_${lwirHash.slice("sha256:".length, "sha256:".length + 16)}`;
}

export function workflowVersionIdForHash(workflowVersionHash: string): string {
  return `wfver_${
    workflowVersionHash.slice("sha256:".length, "sha256:".length + 16)
  }`;
}
