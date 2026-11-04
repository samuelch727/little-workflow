/**
 * `@little-stack/workflow`: define, run and replay durable workflows, and hand them to Little Harness.
 *
 * This root is the app-author surface. Eval sets live at `@little-stack/workflow/eval`, LWIR
 * validation at `@little-stack/workflow/lwir`, and the building blocks the CLI, Little Harness,
 * LittleDB, demos and tests use at `@little-stack/workflow/internals` (unstable, no semver
 * guarantees). `src/index.test.ts` pins the runtime values below so the root cannot grow silently.
 */

// ── Define ────────────────────────────────────────────────────────────────────
export { defineWorkflow, model, skill } from "./authoring.js";
export { output } from "./schema.js";
export { createToolRegistry } from "./tool-registry.js";

// ── Run ───────────────────────────────────────────────────────────────────────
export { localWorld, runOrchestration, runWorkflow } from "./authoring.js";
export { virtualWorld, type VirtualWorldOptions } from "./world.js";
export { isRunFailedError, RunFailedError } from "./runtime.js";
export { replayRun } from "./replay.js";
export { readWorkflowVersion } from "./run-plan.js";
export { gradeRun, listRunGrades } from "./run-grades.js";

// ── Compose with Little Harness ───────────────────────────────────────────────
export { asHarnessWorkflow } from "./harness-workflow.js";
export { loadWorkflow } from "./workspace/load-workflow.js";
export { dynamicWorkflows } from "./dynamic-workflow.js";
export type { DynamicWorkflowWorld, DynamicWorkflowWorldContext } from "./dynamic-workflow.js";
export { agentWorkflow, type AgentWorkflowRunBindings } from "./dynamic-workflow-factory.js";
export {
  versionedHarnessWorkflow,
  type VersionedHarnessWorkflowOptions,
  type WorkflowVersionSource,
} from "./versioned-harness-workflow.js";

// ── Types ─────────────────────────────────────────────────────────────────────
export type {
  DefinedWorkflow,
  DefineWorkflowInput,
  FailedRunResult,
  FixedPlan,
  InferWorkflowInput,
  InferWorkflowOutput,
  InputSchemaLike,
  LocalWorldOptions,
  MemoryConfig,
  ModelSelectionMetadata,
  ModelSlot,
  OrchestratorConfig,
  OutputMode,
  OutputSchemaLike,
  PlannerConfig,
  RemoteSkillOptions,
  RunOrchestrationOptions,
  RunResult,
  RunTrigger,
  RunWorkflowOptions,
  Skill,
  SkillGitAuth,
  SkillOidcToken,
  SkillRiskLevel,
  ToolSelectionPolicy,
  WorkerConfig,
  WorkflowRunProgressEvent,
} from "./authoring.js";
export type { SuperviseDecision, SuperviseOuterLoopState } from "./compiler.js";
export type { RunFailedCauseCode } from "./runtime.js";
export type { ReplayResult } from "./replay.js";
export type { RunPlan, StoredWorkflowPlan } from "./run-plan.js";
export type { GradeRunInput, RunGrade } from "./run-grades.js";
export type { World } from "./world-port.js";
export type {
  ArtifactInput,
  ArtifactManifest,
  ArtifactReadResult,
  ArtifactRef,
  EventEnvelope,
  EventInput,
  RunId,
} from "./world.js";
export type { UsageTotals } from "./pricing.js";
export type { AiSdkTool, ToolRegistry } from "./tool-registry.js";
export type { BashCapabilities } from "./bash-tool.js";
export type { ToolPermissions } from "./permission.js";
export type { WorkflowVersionReuseStrategy } from "./workflow-version-reuse.js";
export type { HarnessWorkflowAdapterOptions } from "./harness-workflow.js";
export type {
  LoadedWorkflow,
  LoadWorkflowOptions,
  WorkflowExecutionMode,
  WorkflowSourceIdentity,
} from "./workspace/load-workflow.js";
