/**
 * `@little-stack/workflow/internals`: UNSTABLE. The building blocks the `little` CLI, Little
 * Harness, LittleDB, the demos and the tests use: the runtime, compiler identities, world storage
 * functions, harness plumbing, manifests, pricing and the lower-level authoring API.
 *
 * Nothing here is covered by semver; names and signatures change between alpha releases. App code
 * should import from `@little-stack/workflow` (and `/eval`, `/lwir`). Nothing exported from the root
 * is repeated here, so each value has one import path.
 */

// ── Authoring internals ───────────────────────────────────────────────────────
export {
  buildRunWorkflowOptions,
  createLittleWorkflow,
  inlineToolRegistryFor,
} from "../authoring.js";
export type {
  LocalWorld,
  ParserSchemaLike,
  RunWorkflowRequest,
  Schema,
  SchemaLike,
  StandardSchemaLike,
  WorkflowDefinition,
  WorkflowRunTarget,
} from "../authoring.js";
export { toHarnessWorkflowInputSchemaMarker } from "../harness-workflow.js";
export type { HarnessWorkflowSchemaMarkerOptions } from "../harness-workflow.js";
export { littleWorkflowDynamicWorkflowFactory } from "../dynamic-workflow.js";
export type { AdHocPlan, AdHocPlanStep } from "../dynamic-workflow.js";
export {
  normalizeOutputMode,
  normalizeSchema,
  UnsupportedSchemaError,
} from "../schema.js";
export type { JsonValue, NormalizedOutputMode, NormalizedSchemaDescriptor } from "../schema.js";
export { createToolRegistryOverlay } from "../tool-registry.js";
export type { ToolRegistrySnapshot } from "../tool-registry.js";
export {
  resolveModelSlots,
  slotIdForResolvedModel,
} from "../model-slots.js";
export type { ResolvedModelSlot } from "../model-slots.js";
export {
  resolveSkills,
  skillPromptSection,
  skillsHash,
} from "../skills.js";
export type { ResolveSkillsOptions, ResolvedSkillDescriptor } from "../skills.js";

// ── Runtime and compiler ──────────────────────────────────────────────────────
export {
  executeWorkflowVersion,
  runWorkflowCycle,
  RuntimeMaxVisitsError,
  stepPathFor,
  visitIndexFor,
} from "../runtime.js";
export type {
  ExecuteWorkflowVersionOptions,
  RunWorkflowCycleOptions,
  RuntimeCompletedRunResult,
  RuntimeFailedRunResult,
  RuntimeRunResult,
  RuntimeStepContext,
  RuntimeStepExecutionResult,
  RuntimeToolHandler,
  RuntimeUsage,
} from "../runtime.js";
export {
  buildRunStateFromEvents,
  hydrateArtifactRefs,
  hydrateRunArtifactRefs,
  RunStateEventMismatchError,
} from "../replay.js";
export type { HydratedArtifact, ReplayPlanStep, ReplayStepStatus } from "../replay.js";
export {
  getPlanningDefinitionHash,
  getPlanningDefinitionSnapshot,
  getWorkflowDefinitionHash,
  getWorkflowDefinitionSnapshot,
} from "../workflow-definition-hash.js";
export type {
  PlanningDefinitionSnapshot,
  WorkflowDefinitionSnapshot,
} from "../workflow-definition-hash.js";
export {
  DEFAULT_WORKFLOW_VERSION_REUSE_STRATEGY,
  resolveWorkflowVersionReuseStrategy,
} from "../workflow-version-reuse.js";
export * from "../workflow-version-store.js";
export * from "../planner-reuse.js";
export * from "../lwir-input-cone.js";
export {
  lwirContainsUnscannableExpression,
  lwirReferencesExpressionRoot,
  lwirStepReferenceIdsIn,
  UNIMPLEMENTED_FIELD_CODE,
  validateAlphaJsonSchema,
} from "../lwir.js";

// ── World storage (free functions; app code uses the World methods) ───────────
export {
  appendEvent,
  ArtifactHashMismatchError,
  ArtifactManifestCorruptError,
  ArtifactNotFoundError,
  EventAppendIdempotencyConflictError,
  EventStoreCorruptError,
  listEvents,
  listRunIds,
  materializeRunState,
  readArtifact,
  readArtifactManifest,
  readOuterLoopManifest,
  RunNotFoundError,
  WorldPathError,
  writeArtifact,
  writeOuterLoopManifest,
} from "../world.js";
export type {
  ArtifactEncoding,
  ArtifactId,
  EventRef,
  EventType,
  MaterializedRunState,
  MaterializedStepAttempt,
  MaterializedStepState,
  OuterLoopCycleSummary,
  OuterLoopManifest,
} from "../world.js";

// ── Harness plumbing (custom planner/worker harnesses) ────────────────────────
export {
  createHarnessEventRecorder,
  createWorkflowHarness,
  errorEnvelope,
  hashHarnessPrompt,
  hashHarnessToolCall,
  normalizeHarnessEventType,
  runWorkflowHarnessWithSession,
  workflowHarness,
  WORKFLOW_HARNESS_ID,
} from "../harness/index.js";
export type {
  ErrorEnvelope,
  ErrorEnvelopeValue,
  ExecuteStepTask,
  FixStepTask,
  Harness,
  HarnessContext,
  HarnessEventInput,
  HarnessEventRecorder,
  HarnessResult,
  HarnessRole,
  HarnessScope,
  HarnessTask,
  OrchestrateTask,
  OuterLoopContext,
  PlanTask,
  ResolvedModel,
  SkillDescriptor,
  ToolSet,
  WorkflowBashCapabilities,
} from "../harness/index.js";

// ── Sandboxing, memory, manifests, cost ───────────────────────────────────────
export * from "../bash-tool.js";
export * from "../canonical.js";
export * from "../manifests.js";
export * from "../memory.js";
export * from "../scratch.js";
export * from "../model-registry.js";
export * from "../pricing.js";
export * from "../run-report.js";

// ── Deprecated orchestrator internals ─────────────────────────────────────────
export * from "../orchestrator.js";
