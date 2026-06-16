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
import type { NetworkConfig } from "just-bash";
import type { ZodType } from "zod";
import type { HarnessEventType } from "./events/names.js";
import type { HarnessDurabilitySink, TraceHarnessEventInput } from "./events/occurrence.js";
import type { HarnessToolCallHashInput, ToolReplay } from "./events/durability.js";
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
  files: FileWriter;
  artifacts: HarnessArtifactAccessor;
  trace: TraceRef;
  status(): Promise<HarnessSessionStatus>;
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

export type HarnessRuntimeOptions = {
  bash?: boolean;
  python?: boolean;
  javascript?: boolean;
  network?: boolean | NetworkConfig;
  toolBridge?: boolean;
};

export type HarnessRuntimeMount = {
  readonly mountPath: string;
  readonly backingPath: string;
  readonly mode: "rw" | "ro";
};

export type HarnessToolExecutionContext<TExtraBody = unknown> = {
  session: HarnessSession;
  files: FileWriter;
  artifacts: HarnessArtifactAccessor;
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
  skills?: SkillInput[];
  skillMaxRisk?: SkillRiskLevel;
  skillOidcToken?: SkillOidcToken;
  inputTypes?: Record<string, HarnessInputType<any, any, TExtraBody>>;
  persistentDirs?: PersistentDir<TExtraBody>[];
  chat?: HarnessChatOptions<TExtraBody>;
  runtime?: HarnessRuntimeOptions;
  toolResultSpooling?: HarnessToolResultSpoolingOptions;
  trace?: HarnessTraceOptions;
  durability?: HarnessDurabilitySink;
  onTraceError?: (error: unknown, event: TraceHarnessEventInput) => Promise<void> | void;
  onEvent?: (event: HarnessEvent) => void | Promise<void>;
  onPersistenceError?: (error: PersistenceError) => void | Promise<void>;
};

export type ResolvedHarnessConfig<TTools extends ToolSet = ToolSet, TExtraBody = unknown> =
  Required<Pick<CreateHarnessOptions<TTools, TExtraBody>, "host" | "model">> &
    Omit<CreateHarnessOptions<TTools, TExtraBody>, "host" | "model" | "memory"> & {
      tools: TTools;
      skills: SkillInput[];
      persistentDirs: PersistentDir<TExtraBody>[];
      memory: ResolvedHarnessMemoryConfig[];
      trace: ResolvedHarnessTraceOptions;
    };

export type Harness<TTools extends ToolSet = ToolSet, TExtraBody = unknown> = {
  sessions: HarnessSessionManager<TExtraBody>;
  config: ResolvedHarnessConfig<TTools, TExtraBody>;
};

export type HarnessHost<TExtraBody = unknown> = {
  kind: "local";
  sessions: HarnessSessionManager<TExtraBody>;
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
};

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
