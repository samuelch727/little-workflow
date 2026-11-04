/**
 * `@little-stack/harness`: build and run an agent. Everything else has its own entry point:
 * `/sandbox` for writing a sandbox, `/host` for writing or tuning a host, `/events` for the event
 * contract, `/remote-session` for session logs, `/agents` for the experimental Agent Group port,
 * `/connectors` for chat connectors, and `/internals` for what Little Workflow and Little Compute
 * build on. `src/index.test.ts` pins this list.
 */
// The AI SDK types this package's public API is written in, so a consumer can name them
// without a direct `ai` import (`ai` is a peer dependency either way).
export type { LanguageModel, ModelMessage, UIMessage } from "ai";
// Agent Groups: only the `agents` option type lives on the root. The launcher port, protocol
// types, errors and ledger projections are on the experimental `@little-stack/harness/agents`.
export type { HarnessAgentGroupsOptions } from "./agents/types.js";
export type {
  HarnessCheckpointKind,
  HarnessCheckpointRequest,
  HarnessCheckpointResult,
  HarnessCheckpointsOptions,
  HarnessCheckpointTier,
  HarnessCheckpointWriter,
} from "./checkpoints/types.js";
// Workflow and plan steps get the same tool once per session and input.
export { once, type OnceOptions } from "./runtime/step-tools.js";
export {
  harnessToolContext,
  tryHarnessToolContext,
  type HarnessToolCallContext,
} from "./connectors/tool-context.js";
export { createHarness } from "./create-harness.js";
export type {
  AgentWorkflowBindings,
  AgentWorkflowBuildRecord,
  AgentWorkflowBuildResult,
  AgentWorkflowDefinedResult,
  AgentWorkflowDefinition,
  AgentWorkflowOffer,
  AgentWorkflowRecord,
  AgentWorkflowRegistry,
  AgentWorkflowRegistryContext,
  DynamicAllowedCapabilities,
  DynamicCompileResult,
  DynamicPlanSubmission,
  DynamicReferencedCapabilities,
  DynamicWorkflowFactory,
  DynamicWorkflowLimits,
  DynamicWorkflowsConfig,
} from "./dynamic-workflows/types.js";
export {
  HarnessConcurrencyError,
  HarnessInputError,
  HarnessPathError,
  HarnessPersistenceError,
  HarnessTerminalStageError,
  LittleHarnessError,
  type HarnessTerminalStage,
} from "./errors.js";
export { generateHarness, type GenerateHarnessOptions } from "./execution/generate-harness.js";
export type { HarnessInbox } from "./execution/inbox.js";
export {
  HarnessTurnLimitError,
  type HarnessTurnLimitReason,
  type HarnessTurnLimits,
} from "./execution/turn-limits.js";
export {
  resumeParked,
  type ResumedTurn,
  type ResumeParkedOptions,
  type ResumeParkedResult,
} from "./execution/resume-parked.js";
// Questions for a person: the agent asks with `ask_person`, your app answers.
export {
  answerInputRequest,
  listInputRequests,
  type HumanInputRequestState,
} from "./human-input/answers.js";
export type * from "./human-input/types.js";
export type {
  HarnessCompletedResult,
  HarnessParkedPending,
  HarnessParkedResult,
  HarnessTurnResult,
  StreamHarnessCompletedResult,
  StreamHarnessTurnFinished,
} from "./execution/result.js";
export {
  streamHarness,
  type StreamHarnessOptions,
  type StreamHarnessResult,
} from "./execution/stream-harness.js";
export { inputType } from "./input-types/input-type.js";
export { localHost, type LocalHostOptions } from "./local-host/local-host.js";
export { virtualHost, type VirtualHostOptions } from "./virtual-host/virtual-host.js";
export {
  customDir,
  localDir,
  projectDir,
  type LocalDirOptions,
  type LocalDirSource,
  type ProjectDirRef,
} from "./local-host/local-dir.js";
export { memory } from "./memory/memory.js";
export type {
  HarnessMcpClient,
  HarnessMcpClientOptions,
  HarnessMcpConfig,
  HarnessMcpCreateClient,
  HarnessMcpDiscoveredTool,
  HarnessMcpGatewayConfig,
  HarnessMcpGuideConfig,
  HarnessMcpServerConfig,
  HarnessMcpToolPolicy,
  HarnessMcpToolSchema,
  HarnessMcpToolSchemas,
  HarnessMcpTransportConfig,
} from "./mcp.js";
export { justBashSandbox } from "./runtime/just-bash-runtime.js";
export {
  tieredSandbox,
  type TieredSandboxOptions,
} from "./runtime/tiered-runtime.js";
export {
  subprocessSandbox,
  type SubprocessSandboxOptions,
} from "./sandbox/subprocess/subprocess-sandbox.js";
// Runs of the agent on a timer, from `schedules/<id>.ts`; `little-harness dev` and `start` run them.
export {
  defineSchedule,
  type HarnessSchedule,
  type HarnessScheduleOptions,
} from "./schedules/schedule.js";
export { skill } from "./skills/skill.js";
export type {
  HarnessOutcomeError,
  HarnessOutcomeEvent,
  HarnessOutcomeInput,
  HarnessOutcomeResult,
  HarnessOutcomeSink,
  HarnessOutcomeStatus,
} from "./outcomes/types.js";
export {
  createHarnessOutcomeReporter,
  reportHarnessOutcome,
  type HarnessOutcomeReporter,
  type HarnessOutcomeReporterOptions,
  type HarnessOutcomeTarget,
  type ReportHarnessOutcomeOptions,
} from "./outcomes/record.js";
export {
  aggregateOutcomes,
  foldOutcomeReports,
  type OutcomeAggregate,
  type OutcomeGroup,
  type OutcomeRate,
} from "./outcomes/aggregate.js";
export { aggregateLocalOutcomes, type OutcomeReport } from "./trace/inspect.js";
export type {
  HarnessTraceContentOptions,
  HarnessTraceFileDiffOptions,
  HarnessTraceOptions,
  HarnessTraceRedactionOptions,
  HarnessTraceSchemaVersion,
} from "./trace/types.js";
export type {
  ArtifactRef,
  CreateHarnessOptions,
  CreateSandboxOptions,
  FileChangeSet,
  FileContent,
  FileData,
  FileEntry,
  FileRef,
  FileWriter,
  GetOrCreateSessionOptions,
  Harness,
  HarnessActiveConnector,
  HarnessAgentOptions,
  HarnessAllowedUrl,
  HarnessAllowedUrlEntry,
  HarnessArtifactAccessor,
  HarnessChatOptions,
  HarnessEvent,
  HarnessEventInput,
  HarnessExecutionTier,
  HarnessHost,
  HarnessHttpMethod,
  HarnessInputType,
  HarnessMemoryBackend,
  HarnessMemoryOptions,
  HarnessMemorySource,
  HarnessNetworkPolicy,
  HarnessNetworkTransform,
  HarnessRuntimeMount,
  HarnessRuntimeOptions,
  HarnessRuntimeUsage,
  HarnessSandbox,
  HarnessSandboxFactory,
  HarnessSandboxSystemHintsOptions,
  HarnessSandboxTiering,
  HarnessSandboxUsage,
  HarnessSession,
  HarnessSessionStatus,
  HarnessToolExecutionContext,
  HarnessToolResultSpoolingOptions,
  HarnessTrigger,
  HarnessTurnContext,
  HarnessTurnMetadata,
  HarnessTurnOptions,
  HarnessTurnOverrides,
  HarnessTurnStart,
  HarnessWarning,
  HarnessWorkflowBudgets,
  HarnessWorkspaceMount,
  HarnessWorkspaceSpec,
  InputFile,
  JsonObject,
  ListFilesOptions,
  LocalSkillInput,
  PersistenceError,
  PersistenceStatus,
  PersistentDir,
  PersistentDirCommitOptions,
  PersistentDirCommitResult,
  PersistentDirDeleteOptions,
  PersistentDirEntry,
  PersistentDirEventOptions,
  PersistentDirListOptions,
  PersistentDirLoadOptions,
  PersistentDirLoadResult,
  PersistentDirReadOptions,
  PersistentDirStoreOptions,
  PersistentDirWriteOptions,
  ReadFileOptions,
  RemoteSkillInput,
  RemoteSkillOptions,
  RemoveFileOptions,
  SessionConnectorEndpoint,
  SkillGitAuth,
  SkillInput,
  SkillOidcToken,
  SkillRiskLevel,
  StagedFile,
  StageMessageOptions,
  StageMessageResult,
  TraceRef,
  WriteFileOptions,
} from "./types.js";
export type {
  HarnessCancelledWorkflowExecution,
  HarnessChildCapabilities,
  HarnessCompletedWorkflowExecution,
  HarnessFailedWorkflowExecution,
  HarnessFailureCauseCode,
  HarnessPreparedWorkflow,
  HarnessRunningWorkflowExecution,
  HarnessWorkflow,
  HarnessWorkflowCapabilityPolicy,
  HarnessWorkflowDefinitionIdentity,
  HarnessWorkflowExecution,
  HarnessWorkflowInheritancePolicy,
  HarnessWorkflowInputSchema,
  HarnessWorkflowMountDeclaration,
  HarnessWorkflowPrepareContext,
  HarnessWorkflowRunContext,
  HarnessWorkflowSkillPolicy,
} from "./workflows.js";
export {
  loadHarness,
  loadWorkspace,
  type LoadHarnessOptions,
  type WorkspaceAgent,
} from "./workspace/load-harness.js";
