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
import type { IFileSystem } from "just-bash";
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
import type { HarnessAgentGroupsOptions, ResolvedHarnessAgentGroups } from "./agents/types.js";

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
  /** Known per-file content ceiling in bytes. Absent: no advertised ceiling; writes may still fail. */
  readonly limits?: { readonly maxFileBytes: number } | undefined;
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
 * `backingPath` is a real directory on a filesystem the HOST can reach (or, with `filesystem`
 * set, a folder of that filesystem): file-change tracking (`trackChanges`) snapshots it from
 * the host process, so an execution environment on another machine must share (or mirror)
 * these paths for harness.file.* events to be observed.
 */
export type HarnessWorkspaceSpec = {
  readonly sessionId: string;
  /** Initial working directory inside the environment (typically "/session"). */
  readonly workingDir: string;
  readonly mounts: readonly HarnessWorkspaceMount[];
  /**
   * Set by hosts that keep the workspace in a just-bash filesystem instead of on disk, such
   * as `virtualHost`. Every mount's `backingPath` is then a folder of this filesystem, not a
   * directory. `justBashSandbox` mounts it directly; a sandbox that needs real directories
   * (`subprocessSandbox`, a remote machine) must refuse such a workspace.
   */
  readonly filesystem?: IFileSystem;
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
  /** Trusted effect-boundary guard; failure prevents actual tool execution. */
  beforeInvocation?: () => void | Promise<void>;
  toolResultSpooling?: HarnessToolResultSpoolingOptions | undefined;
  toolReplay?: {
    get(toolCallId: string | undefined): { replay: ToolReplay; callId?: string } | undefined;
  } | undefined;
  /**
   * Set when a workflow step calls one of the harness's tools, as in an ad-hoc plan, a workflow
   * the agent defined, or a configured workflow: the same for the same tool and input (or `once`
   * key) in the same session, so a rerun of the step gets the same key. Pass it on to a system
   * that takes one, for example as an `Idempotency-Key` header.
   */
  idempotencyKey?: string | undefined;
  /**
   * Asks a person a question and returns at once, when the harness has `humanInput`. Asking the
   * same question again in the session returns the first one, with its answer once there is one.
   */
  ask?: import("./human-input/types.js").HumanInputAsk | undefined;
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

/**
 * How a turn started, for trace readers such as LittleDB. It goes on the turn's
 * `harness.session.started` event as `triggerKind`, `triggerSource`, `triggerFrom` and
 * `triggerLabel`. A turn without one started from the app's own code.
 */
export type HarnessTrigger = {
  /** A short word: `message`, `schedule`, `api`, `cli`, `webhook`, or your own. */
  readonly kind: string;
  /** Where it came from: a connector (`whatsapp`, `email`), a schedule id, a route (`POST /loans`). */
  readonly source?: string;
  /** Who sent it, as the channel names them: a phone number, an email address, a chat handle. */
  readonly from?: string;
  /** A short label for people, such as the schedule's description or the email's subject. */
  readonly label?: string;
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
  /** Step, cost and time limits for the turn. See {@link import("./execution/turn-limits.js").HarnessTurnLimits}. */
  turnLimits?: import("./execution/turn-limits.js").HarnessTurnLimits;
};

/** What a `turnOptions` hook tells a turn's caller about it, such as the version that ran: JSON. */
export type HarnessTurnMetadata = { readonly [key: string]: JSONValue };

/** What a `turnOptions` hook is told about the turn about to run. */
export type HarnessTurnContext<TExtraBody = unknown> = {
  readonly sessionId: string;
  readonly session: HarnessSession;
  /** The turn's `extraBody`: who is asking, as your app names them. */
  readonly extraBody?: TExtraBody | undefined;
  /** How the turn started; a connector's turn names the channel and the sender in `source` and `from`. */
  readonly trigger?: HarnessTrigger | undefined;
  /**
   * Set when the turn continues a parked one: the `pin` and `metadata` the parked turn's hook
   * returned. The continued turn runs the system prompt the parked turn saved, so a hook that
   * decides something per turn (a version, say) should decide the same again from `pin`.
   */
  readonly resumed?: {
    readonly continuationId: string;
    readonly pin?: unknown;
    readonly metadata?: HarnessTurnMetadata | undefined;
  } | undefined;
};

/** What a `turnOptions` hook may set for one turn: the per-run options, and an `onEvent` for this turn's events. */
export type HarnessTurnOverrides = HarnessAgentOptions & {
  onEvent?: (event: HarnessEvent) => void | Promise<void>;
  /**
   * What the turn's caller is told about it. `onTurnStart` gets it, and the agent server sends it
   * on `turn.finished`, `turn.parked` and `turn.failed` and in `GET /sessions/:id/turn`. A continued
   * turn reports the parked turn's metadata unless its hook returns some.
   */
  metadata?: HarnessTurnMetadata;
  /**
   * What the turn was decided from, as JSON (it is saved as JSON). A turn that parks saves it with
   * its conversation, and the hook gets it back in `turn.resumed.pin` when the turn continues,
   * after a restart too.
   */
  pin?: unknown;
};

/** A turn about to run, as `onTurnStart` is told it. */
export type HarnessTurnStart = {
  readonly sessionId: string;
  readonly turnId: string;
  /** What the harness's `turnOptions` hook returned as `metadata`, if anything. */
  readonly metadata?: HarnessTurnMetadata;
};

/**
 * Decide a turn's model, system prompt and other per-run options from its session, for example
 * the version of the agent LittleDB says this session runs. Awaited once per turn, before the
 * turn starts, on every path that runs one: `generateHarness`, `streamHarness`, connectors,
 * schedules and `little-harness start`. Options a call passes itself win.
 */
export type HarnessTurnOptions<TExtraBody = unknown> = (
  turn: HarnessTurnContext<TExtraBody>,
) => HarnessTurnOverrides | void | Promise<HarnessTurnOverrides | void>;

export type HarnessMemorySource<TExtraBody = unknown> =
  | string
  | { kind: "projectDir"; path: string }
  | ((options: { extraBody?: TExtraBody | undefined }) =>
      string | { kind: "projectDir"; path: string });

/**
 * Where a memory lives when it is not a Local Host folder: a service such as a knowledge base.
 * It is a Persistent Dir: `load` returns the files to mount for the turn, and `store` receives
 * what the turn changed (`changes.created`, `changes.updated`, `changes.deleted`, as paths
 * relative to the memory's `harnessDir`). A file the model deleted is a memory it forgot.
 */
export type HarnessMemoryBackend<TExtraBody = unknown> = {
  load: (options: PersistentDirLoadOptions<TExtraBody>) => Promise<PersistentDirLoadResult> | PersistentDirLoadResult;
  store?: (options: PersistentDirStoreOptions<TExtraBody>) => Promise<void> | void;
};

export type HarnessMemoryOptions<TExtraBody = unknown> = {
  /** A localDir source: on disk for localHost, in dataFs for virtualHost. Pass this or `backend`. */
  sourceDir?: HarnessMemorySource<TExtraBody>;
  /** A memory kept somewhere else. Pass this or `sourceDir`. */
  backend?: HarnessMemoryBackend<TExtraBody>;
  /** Where the model sees the memory. Default: `/persistent/memory`. */
  harnessDir?: string;
  /** What the memory holds, shown to the model every turn, such as "The bank's lending rules." */
  description?: string;
  commit?: "after-turn" | "manual" | "read-only";
  /**
   * Who may change this memory, decided each turn from the turn's `extraBody`. When it returns
   * false the memory is mounted read-only for the turn, the model is told so, and nothing is
   * stored. Default: anyone.
   */
  canWrite?: (options: { extraBody?: TExtraBody | undefined }) => boolean | Promise<boolean>;
  /** Guidance shown with this memory every turn, up to 4096 characters. */
  instructions?: string;
  /** Most bytes of the file list shown every turn. Default: 8000. */
  maxIndexBytes?: number;
  /**
   * `false` leaves the built-in `memory` skill out for this memory. A skill named `memory` in
   * `skills` replaces the built-in one.
   */
  skill?: false;
};

export type ResolvedHarnessMemoryConfig = {
  harnessDir: string;
  commit: "after-turn" | "manual" | "read-only";
  description?: string;
  instructions?: string;
  maxIndexBytes: number;
  /** Whether this memory points the model at the `memory` skill. */
  skill: boolean;
};

export type CreateHarnessOptions<TTools extends ToolSet = ToolSet, TExtraBody = unknown> = {
  host: HarnessHost<TExtraBody>;
  /**
   * The model every turn runs unless `turnOptions` or the call names another. Optional: where
   * the model comes from somewhere else, such as a LittleDB managed agent, whose runtime passes
   * the version's model on each call, the agent's code names none. A turn that ends up with no
   * model fails with "Little Harness model is required".
   */
  model?: LanguageModel;
  system?: string | ModelMessage | ModelMessage[];
  tools?: TTools;
  /**
   * Long-term memory: folders of files the model sees every turn and changes with its file tools,
   * plus a built-in `memory` skill on how to keep them. Pass several to give the agent layers,
   * such as company knowledge everyone shares and one memory per user; each needs its own
   * `harnessDir`.
   */
  memory?: HarnessMemoryOptions<TExtraBody> | readonly HarnessMemoryOptions<TExtraBody>[];
  mcp?: HarnessMcpConfig;
  /** Workflows exposed to the agent as callable tools (one named tool per workflow). */
  workflows?: readonly import("./workflows.js").HarnessWorkflow[];
  workflowBudgets?: Partial<HarnessWorkflowBudgets>;
  /** Enable model-authored one-shot plans. Inject via little-workflow's `dynamicWorkflows()`. */
  dynamicWorkflows?: import("./dynamic-workflows/types.js").DynamicWorkflowsConfig;
  /** Optional neutral Agent Group launcher; no agent tools are injected when absent. */
  agents?: HarnessAgentGroupsOptions;
  /** Optional durable environment milestone writer; injects `checkpoint`. */
  checkpoints?: import("./checkpoints/types.js").HarnessCheckpointsOptions;
  /**
   * Lets the agent ask a person a question without waiting on the answer: adds the `ask_person`
   * tool, and `ask` to every tool's execution context. Needs a host with durable services, such as
   * `localHost`. Answers come in through `answerInputRequest`; `resumeParked` continues a turn that
   * paused for one.
   */
  humanInput?: boolean | import("./human-input/types.js").HumanInputOptions;
  skills?: SkillInput[];
  skillMaxRisk?: SkillRiskLevel;
  skillOidcToken?: SkillOidcToken;
  inputTypes?: Record<string, HarnessInputType<any, any, TExtraBody>>;
  persistentDirs?: PersistentDir<TExtraBody>[];
  chat?: HarnessChatOptions<TExtraBody>;
  runtime?: HarnessRuntimeOptions;
  toolResultSpooling?: HarnessToolResultSpoolingOptions;
  /**
   * Anthropic prompt caching on the agent's model calls: the tools and system prompt are cached
   * for the next session, and each step reads what the step before it sent. Default true. Uses 2
   * of Anthropic's 4 cache points; on Amazon Bedrock only the system prompt's is sent. Providers
   * that do not read `providerOptions.anthropic` ignore it. Set false to send no cache points.
   */
  promptCaching?: boolean;
  trace?: HarnessTraceOptions;
  /**
   * Step, cost and time limits for every turn, unless a call or `turnOptions` passes its own.
   * See {@link import("./execution/turn-limits.js").HarnessTurnLimits}.
   */
  turnLimits?: import("./execution/turn-limits.js").HarnessTurnLimits;
  /**
   * Per-turn options: a hook that returns the model, system prompt and other per-run options for
   * each turn, decided from its session. See {@link HarnessTurnOptions}.
   */
  turnOptions?: HarnessTurnOptions<TExtraBody>;
  /**
   * The session log: the append-only durable event log that is the run's source of truth
   * (e.g. remoteSessionLog). Runs re-invoked with the same runId replay from it.
   */
  sessionLog?: HarnessSessionLog;
  onTraceError?: (error: unknown, event: TraceHarnessEventInput) => Promise<void> | void;
  onEvent?: (event: HarnessEvent) => void | Promise<void>;
  onPersistenceError?: (error: PersistenceError) => void | Promise<void>;
};

export type ResolvedHarnessConfig<TTools extends ToolSet = ToolSet, TExtraBody = unknown> =
  Required<Pick<CreateHarnessOptions<TTools, TExtraBody>, "host">> &
    Pick<CreateHarnessOptions<TTools, TExtraBody>, "model"> &
    Omit<
      CreateHarnessOptions<TTools, TExtraBody>,
      "host" | "model" | "memory" | "workflowBudgets" | "dynamicWorkflows" | "agents" | "checkpoints" | "humanInput"
    > & {
      tools: TTools;
      skills: SkillInput[];
      persistentDirs: PersistentDir<TExtraBody>[];
      memory: ResolvedHarnessMemoryConfig[];
      trace: ResolvedHarnessTraceOptions;
      workflowBudgets: HarnessWorkflowBudgets;
      dynamicWorkflows?: import("./dynamic-workflows/config.js").ResolvedDynamicWorkflows;
      agents?: ResolvedHarnessAgentGroups;
      checkpoints?: import("./checkpoints/types.js").ResolvedHarnessCheckpoints;
      humanInput?: import("./human-input/types.js").HumanInputOptions;
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
  /** Optional; logical-turn limits fail closed when unavailable. */
  readonly turnBudgets?: import("./execution/turn-budget.js").HarnessTurnBudgetLedger;
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

export type HarnessHost<TExtraBody = unknown> = {
  /** Adapter identifier ("local", "in-memory", "remote", …) — informational, never branched on. */
  kind: string;
  sessions: HarnessSessionManager<TExtraBody>;
  durable?: HarnessOrchestrationServices;
  /**
   * Absolute directory for data every session on this host shares, when the host has one.
   * `localHost` sets it to its `dataDir`; `little-harness start` keeps schedule state there.
   */
  dataDir?: string;
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
   * Absolute directory for data every session on this host shares, such as the runs of the
   * workflows an agent defines (whose saved steps later sessions reuse). Optional for custom
   * hosts; without it that data is kept per session.
   */
  dataDir?: string;
  /** Filesystem backing dataDir on hosts without disk; passed unchanged to workflow runs. */
  dataFs?: IFileSystem;
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
  createSandbox(options: {
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
  }): Promise<HarnessSandbox>;
};

export type PersistentDirEventOptions = {
  emit?: (event: Omit<HarnessEvent, "timestamp" | "sessionId">) => Promise<HarnessEvent | void>;
};

export type PersistentDirCommitOptions = PersistentDirEventOptions & {
  mode?: "automatic" | "manual";
};

export type HarnessSandboxSystemHintsOptions = {
  activeTools?: readonly string[] | undefined;
};

/**
 * The sandbox a turn runs shell commands in (just-bash in-process, a subprocess, a remote
 * microVM, …). Hosts create one per turn through a {@link HarnessSandboxFactory}.
 */
export type HarnessSandbox = {
  systemHints(options?: HarnessSandboxSystemHintsOptions): string[];
  shellTool(): Tool;
  /** Releases environment resources (child processes, remote sandboxes). Loops call it when the turn ends. */
  dispose?(): Promise<void>;
  /**
   * What this sandbox used during the turn so far, for cost accounting (LittleDB records it per
   * turn). Optional: an in-process sandbox has nothing billable to report. Read after the last
   * command and again after `dispose`, so it must stay callable once disposed.
   */
  usage?(): HarnessSandboxUsage | undefined;
  /**
   * Which execution tiers the turn's commands ran on. The harness's own sandboxes report it
   * (just-bash is Tier 0; `tieredSandbox` reports the switch); a custom sandbox may leave it
   * out, and is then taken for a real execution environment. Read with `usage()`, after `dispose`.
   */
  tiering?(): HarnessSandboxTiering | undefined;
};

/**
 * An execution tier: Tier 0 is the emulated shell over the session folder (just-bash);
 * `next-tier` is a real execution environment (a sandbox, a container, a microVM).
 */
export type HarnessExecutionTier = "tier-0" | "next-tier";

/**
 * Which tiers ran what in one turn. `tier` is the highest tier the turn reached, and
 * `commands` counts executions per tier: a command retried on the next tier after a Tier-0
 * emulation gap counts once on each.
 */
export type HarnessSandboxTiering = {
  readonly tier: HarnessExecutionTier;
  readonly commands: {
    readonly tier0: number;
    readonly nextTier: number;
    /** Commands policy refused; they ran on no tier. */
    readonly denied: number;
  };
  /** Tier switches in the turn: at most one, since escalation is sticky. */
  readonly escalations: number;
};

/**
 * What a turn's shell sandbox used, as the `harness.runtime.usage` event records it: the
 * tiering plus the sandbox's own usage. `sandbox` comes from `usage()` of the sandbox that
 * served the highest tier; a sandbox that reports none is measured from command durations and
 * named `"unknown"`.
 */
export type HarnessRuntimeUsage = HarnessSandboxTiering & {
  readonly sandbox: HarnessSandboxUsage;
};

/**
 * Infrastructure a sandbox used in one turn. Active time is the time commands were running;
 * awake time is what the vendor bills as provisioned (it includes the idle tail before sleep).
 * LittleDB prices managed compute on active use, so `activeMs` is the number that matters;
 * the rest is there to check the margin against the vendor bill.
 */
export type HarnessSandboxUsage = {
  /** Where the commands ran, such as "cloudflare-sandbox", "little-compute" or "just-bash". */
  readonly provider: string;
  /** The vendor's instance type, such as "standard-1". */
  readonly instanceType?: string | undefined;
  readonly vcpu?: number | undefined;
  readonly memoryGiB?: number | undefined;
  readonly diskGB?: number | undefined;
  /** Milliseconds commands were running on this sandbox. */
  readonly activeMs: number;
  /** Milliseconds the vendor billed the instance as awake, when known. */
  readonly awakeMs?: number | undefined;
  /** The provider's own estimate of the vendor bill at list price, when it knows the rates. */
  readonly costUsd?: number | undefined;
};

/**
 * Everything an execution-environment factory receives: the workspace to expose, the tools
 * reachable through the runtime tool bridge (with the context they execute under), replay
 * wiring, and event/trace sinks. Notably NOT a session object — factories see references,
 * never host internals, so an implementation may run in-process, in a child process, or
 * remotely.
 */
export type CreateSandboxOptions<TExtraBody = unknown> = {
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
 * `justBashSandbox()` (in-process just-bash) is the default adapter.
 */
export type HarnessSandboxFactory<TExtraBody = unknown> = (
  options: CreateSandboxOptions<TExtraBody>,
) => Promise<HarnessSandbox>;

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
  /**
   * Whether this turn may change the folder, decided from the turn's `extraBody` when the turn
   * loads it. When it returns false the folder is mounted read-only for the turn, so a write fails
   * at once, and nothing is stored. Default: every turn may.
   */
  canWrite?: (options: { extraBody?: TExtraBody | undefined }) => boolean | Promise<boolean>;
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
