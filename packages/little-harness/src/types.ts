import type {
  PrepareStepFunction,
  CallSettings,
  JSONValue,
  LanguageModel,
  ModelMessage,
  Output,
  StopCondition,
  Tool,
  ToolChoice,
  ToolSet,
  UIMessage,
} from "ai";
import type { ZodType } from "zod";
import type { HarnessEventType } from "./events/names.js";
import type { HarnessSessionLog, TraceHarnessEventInput } from "./events/occurrence.js";
import type { HarnessToolCallHashInput, ToolReplay } from "./events/durability.js";
import type { HarnessMcpConfig } from "./mcp.js";
import type {
  HarnessAsyncLaunchLedger,
  HarnessAsyncTaskQueueLedger,
  HarnessContinuationLedger,
  HarnessPreparedWorkflowRunStore,
  HarnessPreparedWorkflowStore,
  HarnessResultGrantStore,
  HarnessResultStore,
  HarnessResumeQueue,
  HarnessTaskLedger,
  HarnessWakeupLedger,
  HarnessWorkflowLaunchLedger,
  HarnessWorkflowQueueLedger,
} from "./tasks/ledger.js";
import type { HarnessTraceOptions, ResolvedHarnessTraceOptions } from "./trace/types.js";

export type JsonObject = Record<string, unknown>;
export type FileContent =
  | string
  | Uint8Array
  | ArrayBuffer
  | ReadableStream<Uint8Array>;

export type HarnessWarning = {
  code: "undefined_input_type" | "provider_warning" | "staging_warning" | "policy_warning";
  message: string;
  metadata?: JsonObject;
};

export type ArtifactRef = {
  id: string;
  path: string;
  bytes?: number;
  mediaType?: string;
  sha256?: string;
  metadata?: JsonObject;
};

export type TraceRef = {
  id: string;
  path?: string;
};

export type FileRef = {
  path: string;
  bytes?: number;
  mediaType?: string;
  sha256?: string;
  artifact?: ArtifactRef;
};

export type FileData = {
  path: string;
  content: Uint8Array;
  text(): string;
  json<T = unknown>(): T;
};

export type FileEntry = {
  path: string;
  kind: "file" | "directory";
  bytes?: number;
  updatedAt?: Date;
};

export type WriteFileOptions = {
  mediaType?: string;
  source?: "user-message" | "app-context" | "tool" | "agent" | string;
  metadata?: JsonObject;
  artifact?: boolean | { name?: string; metadata?: JsonObject };
};

export type ReadFileOptions = { encoding?: "bytes" | "utf8" };
export type ListFilesOptions = { recursive?: boolean };
export type RemoveFileOptions = { recursive?: boolean };

export type FileWriter = {
  write(path: string, content: FileContent, options?: WriteFileOptions): Promise<FileRef>;
  writeText(path: string, text: string, options?: WriteFileOptions): Promise<FileRef>;
  writeJSON(path: string, value: unknown, options?: WriteFileOptions): Promise<FileRef>;
  read(path: string, options?: ReadFileOptions): Promise<FileData>;
  list(path: string, options?: ListFilesOptions): Promise<FileEntry[]>;
  remove(path: string, options?: RemoveFileOptions): Promise<void>;
};

export type HarnessSessionStatus = {
  id: string;
  state: "idle" | "queued" | "running" | "failed";
  pathKey: string;
  createdAt: string;
  updatedAt: string;
  stagedMessageIds: string[];
};

export type HarnessSession = {
  id: string;
  /**
   * Absolute directory for host-managed data this session owns, such as the event stores of
   * the workflow runs it starts. Optional for custom hosts; without it those stores resolve
   * relative to the process working directory.
   */
  dataDir?: string;
  files: FileWriter;
  artifacts: HarnessArtifactAccessor;
  trace: TraceRef;
  status(): Promise<HarnessSessionStatus>;
  setStatus(patch: Partial<HarnessSessionStatus>): Promise<void>;
  markMessageStaged(messageId: string): Promise<void>;
  /**
   * Read-only Persistent Dir prefixes are turn-scoped state resolved by the host while
   * loading Persistent Dirs; the execution environment consults them to enforce write policy.
   */
  setReadOnlyPersistentDirs(harnessDirs: readonly string[]): void;
  getReadOnlyPersistentDirs(): readonly string[];
};

export type HarnessArtifactAccessor = {
  list(): Promise<ArtifactRef[]>;
  read(path: string, options?: ReadFileOptions): Promise<FileData>;
};

export type GetOrCreateSessionOptions<TExtraBody = unknown> = {
  id?: string;
  extraBody?: TExtraBody | undefined;
  metadata?: JsonObject;
};

export type HarnessSessionManager<TExtraBody = unknown> = {
  getOrCreate(options?: GetOrCreateSessionOptions<TExtraBody>): Promise<HarnessSession>;
  get(id: string): Promise<HarnessSession | undefined>;
};

export type HarnessEvent<TEventType extends string = HarnessEventType> = {
  schemaVersion?: "lh.trace.v2";
  eventId?: string;
  sequence?: number;
  occurrenceId?: string;
  type: TEventType;
  sessionId: string;
  turnId?: string;
  stepId?: string;
  parentEventId?: string;
  timestamp: string;
  metadata?: JsonObject;
};

export type HarnessEventInput<TEventType extends string = HarnessEventType> = {
  type: TEventType;
  occurrenceId?: string;
  turnId?: string;
  stepId?: string;
  parentEventId?: string;
  metadata?: JsonObject;
  payload?: JsonObject;
};

export type PersistenceStatus =
  | { status: "not-configured" }
  | { status: "succeeded"; commits: PersistentDirCommitResult[] }
  | {
      status: "failed";
      commits: PersistentDirCommitResult[];
      failedCommits: PersistentDirCommitResult[];
    };

export type PersistentDirCommitResult = {
  harnessDir: string;
  commit: "after-turn" | "manual" | "read-only";
  status: "skipped" | "succeeded" | "failed";
  error?: unknown;
};

export type PersistenceError = {
  session: HarnessSession;
  failedCommits: PersistentDirCommitResult[];
};

export type InputFile = {
  name: string;
  safeName: string;
  mediaType?: string;
  content: FileContent;
};

export type StagedFile = FileRef & { originalName?: string; messageId?: string };

export type StageMessageOptions<TExtraBody = unknown> = {
  message: UIMessage;
  inputFiles: InputFile[];
  files: FileWriter;
  session: HarnessSession;
  extraBody?: TExtraBody | undefined;
  abortSignal?: AbortSignal | undefined;
};

export type StageMessageResult = {
  stagedFiles?: StagedFile[];
  notice?: string;
  metadata?: JsonObject;
};

export type HarnessChatOptions<TExtraBody = unknown> = {
  stageMessage?: (
    options: StageMessageOptions<TExtraBody>,
  ) => StageMessageResult | Promise<StageMessageResult>;
};

export type HarnessInputType<TInput = unknown, TOutput = unknown, TExtraBody = unknown> = {
  description: string;
  inputSchema?: ZodType<TInput>;
  output?: Output.Output<TOutput>;
  instructions?: string;
  toMessages?: (options: {
    input: TInput;
    extraBody?: TExtraBody | undefined;
    session: HarnessSession;
    files: FileWriter;
  }) => ModelMessage[] | Promise<ModelMessage[]>;
};

export type HarnessNetworkTransform = { headers: Record<string, string> };

export type HarnessAllowedUrl = { url: string; transform?: HarnessNetworkTransform[] };

export type HarnessAllowedUrlEntry = string | HarnessAllowedUrl;

export type HarnessHttpMethod = "GET" | "HEAD" | "POST" | "PUT" | "DELETE" | "PATCH" | "OPTIONS";

/**
 * Neutral network policy for execution environments. Structurally compatible with just-bash's
 * NetworkConfig so the default adapter passes it through unchanged, but the core types carry
 * no dependency on any particular sandbox implementation.
 */
export type HarnessNetworkPolicy = {
  allowedUrlPrefixes?: HarnessAllowedUrlEntry[];
  allowedMethods?: HarnessHttpMethod[];
  dangerouslyAllowFullInternetAccess?: boolean;
  maxRedirects?: number;
  timeoutMs?: number;
  maxResponseSize?: number;
  denyPrivateRanges?: boolean;
};

export type HarnessRuntimeOptions = {
  bash?: boolean;
  python?: boolean;
  javascript?: boolean;
  network?: boolean | HarnessNetworkPolicy;
  toolBridge?: boolean;
};

export type HarnessWorkflowBudgets = {
  readonly maxModelSteps: number;
  readonly maxToolCallsPerTurn: number;
  readonly maxConcurrentToolCalls: number;
  readonly maxConcurrentWorkflowRuns: number;
  readonly maxQueuedWorkflowRuns: number;
  readonly maxAutonomousTurns: number;
  readonly toolDeadlineMs?: number;
  readonly workflowDeadlineMs?: number;
  readonly queueDeadlineMs?: number;
  readonly maxDynamicWorkflowTokens?: number;
  readonly maxDynamicWorkflowOutputBytes?: number;
};

export type HarnessRuntimeMount = {
  readonly mountPath: string;
  readonly backingPath: string;
  readonly mode: "rw" | "ro";
};

export type HarnessWorkspaceMount = HarnessRuntimeMount & {
  /** Emit harness.file.* change events for writes observed under this mount. */
  readonly trackChanges?: boolean;
  /**
   * Dynamic read-only harness-path prefixes enforced inside an otherwise-writable mount
   * (used for read-only Persistent Dirs resolved per turn). In-process environments
   * re-evaluate this on every write; out-of-process environments may snapshot it when they
   * start (the subprocess sandbox snapshots at worker spawn, which happens lazily on the
   * turn's first command — after persistent dirs load), so prefixes must be resolved
   * before the turn's first command runs.
   */
  readonly getReadOnlyPrefixes?: () => readonly string[];
};

/**
 * Host-neutral description of the filesystem an execution environment exposes to the agent.
 * Hosts assemble one per turn from their own storage; execution-environment factories consume
 * it without ever seeing host session internals.
 *
 * `backingPath` is a real directory on a filesystem the HOST can reach: file-change
 * tracking (`trackChanges`) snapshots it from the host process, so an execution
 * environment on another machine must share (or mirror) these paths for harness.file.*
 * events to be observed.
 */
export type HarnessWorkspaceSpec = {
  readonly sessionId: string;
  /** Initial working directory inside the environment (typically "/session"). */
  readonly workingDir: string;
  readonly mounts: readonly HarnessWorkspaceMount[];
};

/**
 * Stable identity of a connector endpoint (the surface a run is attached to). Canonical definition
 * lives here so both the session registry and the tool-execution context share one shape; the
 * connectors package re-exports it for backwards compatibility.
 */
export type SessionConnectorEndpoint = {
  id: string;
  platform?: string;
  threadId?: string;
  userId?: string;
  label?: string;
};

export type HarnessActiveConnector = {
  id: string;
  kind: string;
  endpoint?: SessionConnectorEndpoint | undefined;
};

export type HarnessToolExecutionContext<TExtraBody = unknown> = {
  session: HarnessSession;
  files: FileWriter;
  artifacts: HarnessArtifactAccessor;
  connector?: HarnessActiveConnector | undefined;
  extraBody?: TExtraBody | undefined;
  abortSignal?: AbortSignal | undefined;
  toolResultSpooling?: HarnessToolResultSpoolingOptions | undefined;
  toolReplay?: {
    get(toolCallId: string | undefined): { replay: ToolReplay; callId?: string } | undefined;
  } | undefined;
};

export type HarnessRuntimeToolReplay = {
  find(candidate: Omit<HarnessToolCallHashInput, "caller"> & { caller: "runtime" }): ToolReplay;
};

export type HarnessToolResultSpoolingOptions =
  | false
  | {
      maxInlineBytes?: number;
      previewBytes?: number;
      outputDir?: string;
    };

export type HarnessAgentOptions = {
  model?: LanguageModel;
  system?: string | ModelMessage | ModelMessage[];
  runtime?: HarnessRuntimeOptions;
  temperature?: CallSettings["temperature"];
  stopWhen?: StopCondition<any> | Array<StopCondition<any>>;
  prepareStep?: PrepareStepFunction<any>;
  toolChoice?: ToolChoice<any>;
  activeTools?: string[];
  providerOptions?: Record<string, Record<string, JSONValue | undefined>>;
  headers?: Record<string, string>;
  maxRetries?: number;
  toolResultSpooling?: HarnessToolResultSpoolingOptions;
  trace?: HarnessTraceOptions;
};

export type HarnessMemorySource<TExtraBody = unknown> =
  | string
  | { kind: "projectDir"; path: string }
  | ((options: { extraBody?: TExtraBody | undefined }) =>
      string | { kind: "projectDir"; path: string });

export type HarnessMemoryToolOptions =
  | false
  | {
      name?: string;
      description?: string;
    };

export type HarnessMemoryOptions<TExtraBody = unknown> = {
  sourceDir: HarnessMemorySource<TExtraBody>;
  harnessDir?: string;
  commit?: "after-turn" | "manual" | "read-only";
  tool?: HarnessMemoryToolOptions;
  indexPath?: string;
  maxIndexBytes?: number;
  maxEntryBytes?: number;
  instructions?: string | false;
  now?: () => Date;
};

export type ResolvedHarnessMemoryConfig = {
  harnessDir: string;
  commit: "after-turn" | "manual" | "read-only";
  indexPath: string;
  maxIndexBytes: number;
  maxEntryBytes: number;
  instructions?: string | false;
  toolName?: string;
};

export type CreateHarnessOptions<TTools extends ToolSet = ToolSet, TExtraBody = unknown> = {
  host: HarnessHost<TExtraBody>;
  model: LanguageModel;
  system?: string | ModelMessage | ModelMessage[];
  tools?: TTools;
  memory?: HarnessMemoryOptions<TExtraBody>;
  mcp?: HarnessMcpConfig;
  /** Workflows exposed to the agent as callable tools (one named tool per workflow). */
  workflows?: readonly import("./workflows.js").HarnessWorkflow[];
  workflowBudgets?: Partial<HarnessWorkflowBudgets>;
  /** Enable model-authored one-shot plans. Inject via little-workflow's `dynamicWorkflows()`. */
  dynamicWorkflows?: import("./dynamic-workflows/types.js").DynamicWorkflowsConfig;
  skills?: SkillInput[];
  skillMaxRisk?: SkillRiskLevel;
  skillOidcToken?: SkillOidcToken;
  inputTypes?: Record<string, HarnessInputType<any, any, TExtraBody>>;
  persistentDirs?: PersistentDir<TExtraBody>[];
  chat?: HarnessChatOptions<TExtraBody>;
  runtime?: HarnessRuntimeOptions;
  toolResultSpooling?: HarnessToolResultSpoolingOptions;
  trace?: HarnessTraceOptions;
  /**
   * The session log: the append-only durable event log that is the run's source of truth
   * (e.g. remoteSessionLog). Runs re-invoked with the same runId replay from it.
   */
  sessionLog?: HarnessSessionLog;
  /** Historical alias of `sessionLog`; `sessionLog` wins when both are set. */
  durability?: HarnessSessionLog;
  onTraceError?: (error: unknown, event: TraceHarnessEventInput) => Promise<void> | void;
  onEvent?: (event: HarnessEvent) => void | Promise<void>;
  onPersistenceError?: (error: PersistenceError) => void | Promise<void>;
};

export type ResolvedHarnessConfig<TTools extends ToolSet = ToolSet, TExtraBody = unknown> =
  Required<Pick<CreateHarnessOptions<TTools, TExtraBody>, "host" | "model">> &
    Omit<
      CreateHarnessOptions<TTools, TExtraBody>,
      "host" | "model" | "memory" | "workflowBudgets" | "dynamicWorkflows"
    > & {
      tools: TTools;
      skills: SkillInput[];
      persistentDirs: PersistentDir<TExtraBody>[];
      memory: ResolvedHarnessMemoryConfig[];
      trace: ResolvedHarnessTraceOptions;
      workflowBudgets: HarnessWorkflowBudgets;
      dynamicWorkflows?: import("./dynamic-workflows/config.js").ResolvedDynamicWorkflows;
    };

export type Harness<TTools extends ToolSet = ToolSet, TExtraBody = unknown> = {
  sessions: HarnessSessionManager<TExtraBody>;
  config: ResolvedHarnessConfig<TTools, TExtraBody>;
};

/**
 * The orchestration port, in managed-agents terms: the durable ledgers (tasks,
 * continuations, wakeups, workflow queues, results) that let N stateless harness processes
 * coordinate.
 */
export type HarnessOrchestrationServices = {
  readonly tasks: HarnessTaskLedger;
  readonly continuations: HarnessContinuationLedger;
  readonly wakeups: HarnessWakeupLedger;
  readonly asyncTaskQueue: HarnessAsyncTaskQueueLedger;
  readonly asyncLaunches: HarnessAsyncLaunchLedger;
  readonly workflowQueue: HarnessWorkflowQueueLedger;
  readonly workflowLaunches: HarnessWorkflowLaunchLedger;
  readonly preparedWorkflows: HarnessPreparedWorkflowStore;
  readonly preparedWorkflowRuns: HarnessPreparedWorkflowRunStore;
  readonly resumeQueue: HarnessResumeQueue;
  readonly results: HarnessResultStore;
  readonly resultGrants: HarnessResultGrantStore;
};

/** Historical name of the orchestration-services contract. */
export type HarnessDurableServices = HarnessOrchestrationServices;

export type HarnessHost<TExtraBody = unknown> = {
  /** Adapter identifier ("local", "in-memory", "remote", …) — informational, never branched on. */
  kind: string;
  sessions: HarnessSessionManager<TExtraBody>;
  durable?: HarnessOrchestrationServices;
  /**
   * Per-session turn exclusivity. `rejectIfBusy` must reject with a concurrency error when the
   * session already has a running turn instead of queueing behind it.
   */
  runExclusive<T>(
    session: HarnessSession,
    options: { turnId: string; rejectIfBusy?: boolean },
    fn: () => Promise<T>,
  ): Promise<T>;
  prepareTurn(options: {
    session: HarnessSession;
    turnId: string;
    persistentDirs: PersistentDir<TExtraBody>[];
    extraBody?: TExtraBody | undefined;
  }): Promise<PreparedTurn<TExtraBody>>;
};

export type PreparedTurn<TExtraBody = unknown> = {
  files: FileWriter;
  trace: TraceRef;
  /**
   * Durable orchestration services scoped to this turn. Hosts with durable services surface
   * them here so turn execution never reaches back through the host object; when absent, the
   * loops fall back to `host.durable` for compatibility.
   */
  orchestration?: HarnessOrchestrationServices;
  emit(event: Omit<HarnessEvent, "timestamp" | "sessionId">): Promise<HarnessEvent>;
  stageSkills(skills: ResolvedSkill[]): Promise<void>;
  loadPersistentDirs(options?: PersistentDirEventOptions): Promise<void>;
  commitPersistentDirs(options?: PersistentDirCommitOptions): Promise<PersistenceStatus>;
  createRuntime(options: {
    tools?: ToolSet;
    toolContext?: HarnessToolExecutionContext<TExtraBody>;
    runtimeToolReplay?: HarnessRuntimeToolReplay;
    runtime?: HarnessRuntimeOptions;
    mounts?: readonly HarnessRuntimeMount[];
    emit?: (event: HarnessEventInput) => Promise<HarnessEvent | void>;
    emitToolEvents?: boolean;
    traceOptions?: ResolvedHarnessTraceOptions;
    extraBody?: TExtraBody | undefined;
    abortSignal?: AbortSignal | undefined;
  }): Promise<HarnessRuntime>;
};

export type PersistentDirEventOptions = {
  emit?: (event: Omit<HarnessEvent, "timestamp" | "sessionId">) => Promise<HarnessEvent | void>;
};

export type PersistentDirCommitOptions = PersistentDirEventOptions & {
  mode?: "automatic" | "manual";
};

export type HarnessRuntimeSystemHintsOptions = {
  activeTools?: readonly string[] | undefined;
};

export type HarnessRuntime = {
  systemHints(options?: HarnessRuntimeSystemHintsOptions): string[];
  shellTool(): Tool;
  /** Releases environment resources (child processes, remote sandboxes). Loops call it when the turn ends. */
  dispose?(): Promise<void>;
};

/**
 * The execution environment ("sandbox") a turn runs shell commands in, in managed-agents
 * terms. `HarnessRuntime` is the historical name of the same port.
 */
export type HarnessExecutionEnvironment = HarnessRuntime;

/**
 * Everything an execution-environment factory receives: the workspace to expose, the tools
 * reachable through the runtime tool bridge (with the context they execute under), replay
 * wiring, and event/trace sinks. Notably NOT a session object — factories see references,
 * never host internals, so an implementation may run in-process, in a child process, or
 * remotely.
 */
export type CreateExecutionEnvironmentOptions<TExtraBody = unknown> = {
  workspace: HarnessWorkspaceSpec;
  files: FileWriter;
  tools?: ToolSet;
  toolContext?: HarnessToolExecutionContext<TExtraBody>;
  runtimeToolReplay?: HarnessRuntimeToolReplay;
  runtime?: HarnessRuntimeOptions;
  mounts?: readonly HarnessRuntimeMount[];
  emit?: (event: HarnessEventInput) => Promise<HarnessEvent | void>;
  emitToolEvents?: boolean;
  traceOptions?: ResolvedHarnessTraceOptions;
  extraBody?: TExtraBody;
  abortSignal?: AbortSignal;
};

/**
 * The sandbox port: hosts call the configured factory once per turn that needs a runtime.
 * `createJustBashRuntime` (in-process just-bash) is the default adapter.
 */
export type HarnessExecutionEnvironmentFactory<TExtraBody = unknown> = (
  options: CreateExecutionEnvironmentOptions<TExtraBody>,
) => Promise<HarnessRuntime>;

export type SkillRiskLevel = "NONE" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export type SkillOidcToken =
  | string
  | undefined
  | (() => string | undefined | Promise<string | undefined>);

export type SkillGitAuth = {
  type: "bearer";
  token: string | undefined;
};

export type RemoteSkillOptions = {
  skills?: readonly string[];
  skillMaxRisk?: SkillRiskLevel;
  skillRisk?: Record<string, SkillRiskLevel>;
  auth?: SkillGitAuth;
};

export type RemoteSkillInput = {
  source: string;
} & RemoteSkillOptions;

export type LocalSkillInput = {
  path?: string;
  name?: string;
  description?: string;
  harnessDir?: string;
  files?: Record<string, string | Uint8Array>;
};

export type SkillInput = string | RemoteSkillInput | LocalSkillInput;

export type ResolvedRemoteSkillSource = {
  type: "remote-git";
  original: string;
  cloneUrl: string;
  provider: "github" | "gitlab" | "git";
  host?: string;
  ownerRepo?: string;
  ref?: string;
  subpath?: string;
  commitSha: string;
  selectedSkill: string;
  skillPath: string;
  contentHash: string;
};

export type ResolvedSkill = {
  name: string;
  description: string;
  harnessDir: string;
  files: Record<string, Uint8Array>;
  source?: ResolvedRemoteSkillSource;
};

export type PersistentDir<TExtraBody = unknown> = {
  harnessDir: string;
  commit?: "after-turn" | "manual" | "read-only";
  load?: (options: PersistentDirLoadOptions<TExtraBody>) => Promise<PersistentDirLoadResult> | PersistentDirLoadResult;
  store?: (options: PersistentDirStoreOptions<TExtraBody>) => Promise<void> | void;
  list?: (options: PersistentDirListOptions<TExtraBody>) => Promise<PersistentDirEntry[]> | PersistentDirEntry[];
  read?: (options: PersistentDirReadOptions<TExtraBody>) => Promise<FileContent> | FileContent;
  write?: (options: PersistentDirWriteOptions<TExtraBody>) => Promise<void> | void;
  delete?: (options: PersistentDirDeleteOptions<TExtraBody>) => Promise<void> | void;
};

export interface PersistentDirLoadOptions<TExtraBody = unknown> {
  extraBody?: TExtraBody | undefined;
  session: HarnessSession;
  sessionHostPaths?: unknown;
}

export type PersistentDirLoadResult =
  | Record<string, FileContent>
  | { files: Record<string, FileContent>; cursor?: unknown };

export type PersistentDirEntry = { path: string; kind: "file" | "directory" };

export type PersistentDirListOptions<TExtraBody = unknown> = {
  extraBody?: TExtraBody | undefined;
  session: HarnessSession;
  path: string;
};

export type PersistentDirReadOptions<TExtraBody = unknown> = PersistentDirListOptions<TExtraBody>;

export type PersistentDirWriteOptions<TExtraBody = unknown> = {
  extraBody?: TExtraBody | undefined;
  session: HarnessSession;
  path: string;
  content: Uint8Array;
};

export type PersistentDirDeleteOptions<TExtraBody = unknown> = {
  extraBody?: TExtraBody | undefined;
  session: HarnessSession;
  path: string;
};

export type FileChangeSet = {
  created: Record<string, Uint8Array>;
  updated: Record<string, Uint8Array>;
  deleted: string[];
};

export interface PersistentDirStoreOptions<TExtraBody = unknown> {
  extraBody?: TExtraBody | undefined;
  session: HarnessSession;
  harnessDir: string;
  changes: FileChangeSet;
  snapshot: Record<string, Uint8Array>;
  cursor?: unknown;
  sessionHostPaths?: unknown;
}
