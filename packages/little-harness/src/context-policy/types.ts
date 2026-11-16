import type { ModelMessage } from "ai";

/** Four public tuning fields. Absent/false policy preserves the existing SDK behavior. */
export type ContextPolicy = {
  triggerTokens: number;
  keepLastTurns?: number;
  summaryModel?: false | string;
  maxCompactionCostUsdPerSession?: number;
};
export type ContextModel = {
  providerId: string;
  modelId: string;
  contextWindow?: { tokens: number; source: string };
  maxOutputTokens: number;
  inputUsdPerMillion?: number;
  outputUsdPerMillion?: number;
};
/** Last measured provider input paired with this estimator's bytes of the same request.
 * Counts/hashes only; never a prompt, aggregate session usage, or a token estimate.
 */
export type ContextInputUsage = {
  version: 1;
  sessionId: string;
  modelId: string;
  providerId: string;
  requestId: string;
  requestHash: string;
  requestBytes: number;
  inputTokens: number;
};
export type ContextCheckpoint = {
  version: 1;
  id: string;
  sessionId: string;
  sourceRevision: string;
  policyHash: string;
  modelId: string;
  providerId: string;
  messages: ModelMessage[];
  beforeTokens: number;
  afterTokens: number;
  estimator: "utf8-bytes-v1" | "last-input-ratio-v1";
  beforeBytes?: number;
  afterBytes?: number;
  calibration?: ContextInputUsage;
  prefix?: { messageCount: number; sourceHash: string; projectedMessages: ModelMessage[] };
  summary?: string;
  attemptId: string;
};
export type ContextAttempt = {
  purpose: "context-compaction";
  id: string;
  sessionId: string;
  sourceRevision: string;
  policyHash: string;
  runId?: string;
  summaryAttempt?: boolean;
  reservedUsd: number;
  status: "reserved" | "committed" | "failed";
  actualUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  reason?: string;
};
/** Implementations atomically serialize claim/commit against the current source revision.
 * A duplicate attempt never permits another provider call; unknown costs remain reserved.
 */
export type ContextCheckpointStore = {
  readonly durable: boolean;
  readonly supportsTurnAdmission?: boolean;
  lastInputUsage?: (sessionId: string) => Promise<ContextInputUsage | undefined>;
  recordInputUsage?: (usage: ContextInputUsage) => Promise<void>;
  list?: () => Promise<readonly ContextCheckpoint[]>;
  load(id: string): Promise<ContextCheckpoint | undefined>;
  claim(attempt: ContextAttempt, sessionCapUsd: number): Promise<boolean>;
  commit(checkpoint: ContextCheckpoint, actual?: { usd: number; inputTokens: number; outputTokens: number }): Promise<boolean>;
  fail(id: string, reason: string, actual?: { usd: number; inputTokens: number; outputTokens: number }): Promise<void>;
};
export type ContextSummaryRequest = {
  purpose: "context-compaction";
  attemptId: string;
  modelId: string;
  providerId: string;
  messages: readonly ModelMessage[];
  maxOutputTokens: number;
  reservedUsd: number;
  signal?: AbortSignal;
};
/** Trusted host adapter, never a public custom summarizer field or provider fallback. */
export type ContextCompactionRuntime = {
  runId?: string;
  store: ContextCheckpointStore;
  model: ContextModel;
  summarize?: (request: ContextSummaryRequest) => Promise<
    { text: string; inputTokens: number; outputTokens: number; costUsd?: number } |
    /** Admission refused before a provider call (for example, missing credits). */
    { skipped: "trim-only" }
  >;
  onAttempt?: (attempt: ContextAttempt) => Promise<void>;
};
export type ContextCompactionHost = {
  forSession(input: { sessionId: string; runId: string; modelId: string; providerId: string; maxOutputTokens?: number }): Promise<ContextCompactionRuntime>;
};
