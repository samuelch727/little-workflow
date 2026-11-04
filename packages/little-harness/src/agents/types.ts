import { LittleHarnessError } from "../errors.js";
import type { HarnessTaskId } from "../tasks/types.js";

declare const externalAgentGroupRefBrand: unique symbol;
declare const externalAgentTaskRefBrand: unique symbol;
declare const externalAgentResultRefBrand: unique symbol;

/** Adapter-owned identifiers. Harness treats their bytes as opaque. */
/** Protocol version every Agent Group start/watch/join/cancel request carries. */
export const HARNESS_AGENT_GROUPS_PROTOCOL_VERSION = "little-harness.agent-groups.v1" as const;

/** Protocol version of the paged Agent Group requests Harness sends today. */
export const HARNESS_AGENT_GROUP_PAGES_PROTOCOL_VERSION = "little-harness.agent-group-pages.v2" as const;

export type HarnessExternalAgentGroupRef = string & {
  readonly [externalAgentGroupRefBrand]: true;
};
export type HarnessExternalAgentTaskRef = string & {
  readonly [externalAgentTaskRefBrand]: true;
};
export type HarnessExternalAgentResultRef = string & {
  readonly [externalAgentResultRefBrand]: true;
};

/**
 * One declared, composite launch profile. Models select only this handle; the
 * five capability handles are trusted configuration and never model input.
 */
export type HarnessAgentProfile = Readonly<{
  handle: string;
  description?: string;
  resourcesHandle: string;
  secretsHandle: string;
  toolsHandle: string;
  networkHandle: string;
  priorityHandle: string;
}>;

/** Summary-only reduction budget. Raw child output is intentionally absent. */
export type HarnessAgentReductionPolicy = Readonly<{
  handle: string;
  description?: string;
  maxMemberSummaryBytes: number;
  maxGroupSummaryBytes: number;
  maxResultRefs: number;
}>;

export type HarnessAgentGroupLimits = Readonly<{
  maxMembers: number;
  maxPromptBytes: number;
  maxGroupPromptBytes: number;
  maxDeadlineMs: number;
  maxJoinWaitMs: number;
  /** Maximum member changes returned by one paged observation. */
  maxMemberPageChanges?: number;
  /** Maximum canonical UTF-8 bytes occupied by one paged result envelope. */
  maxMemberPageBytes?: number;
  /** Maximum UTF-8 bytes accepted for an adapter-owned opaque cursor. */
  maxMemberCursorBytes?: number;
}>;

export type ResolvedHarnessAgentGroupLimits = Omit<
  HarnessAgentGroupLimits,
  "maxMemberPageChanges" | "maxMemberPageBytes" | "maxMemberCursorBytes"
> & Readonly<{
  maxMemberPageChanges: number;
  maxMemberPageBytes: number;
  maxMemberCursorBytes: number;
}>;

export type HarnessAgentJoinPolicy =
  | Readonly<{ kind: "all_success" }>
  | Readonly<{ kind: "all_terminal" }>
  | Readonly<{ kind: "any_success" }>
  | Readonly<{ kind: "quorum"; count: number }>
  | Readonly<{ kind: "first_verified" }>;

/** Trusted join binding. first_verified requires both verifier handles. */
export type HarnessAgentJoinPolicyProfile = Readonly<{
  handle: string;
  description?: string;
  policy: HarnessAgentJoinPolicy;
  verifierHandle?: string;
  requiredCheckSetHandle?: string;
}>;

export type HarnessAgentDeadlineDisposition =
  | "cancel_pending"
  | "return_terminal"
  | "fail_group";

export type HarnessAgentMemberLaunch = Readonly<{
  memberId: string;
  memberIndex: number;
  name?: string;
  purpose?: string;
  prompt: string;
  profile: HarnessAgentProfile;
  harnessTaskId: HarnessTaskId;
  callIdentity: string;
}>;

/**
 * One per-path merge rule a model sets for its group. The first rule whose
 * glob matches a path decides how members' changes to it merge back:
 * `three_way` merges with Git (a conflicting member keeps its work on a
 * branch), `collect` routes each member's matching outputs under
 * `members/<memberId>/` so they never collide, and `owner` lets only the
 * named member write matching paths.
 */
export type HarnessAgentGroupMergePolicy = Readonly<{
  /** Repository-relative path pattern: `**` spans segments, `*` stays in one. */
  glob: string;
  policy: "three_way" | "collect" | "owner";
  /** A member id of this group (`member_1` … `member_N`); required exactly for `owner`. */
  owner?: string;
}>;

/**
 * Where a group's children start and how their work merges back, as the model
 * asked. Present on a start request only when the launcher supports workspaces
 * (`launcher.workspaces`) and the model set `from` or `mergePolicy`.
 */
export type HarnessAgentGroupWorkspaceAsk = Readonly<{
  /**
   * `parent`: from the parent's current files when the launcher can fork them
   * (the default). `project`: from the Project head, never forked.
   */
  from?: "parent" | "project";
  /** At most 64 rules, applied in order ahead of the launcher's own. */
  mergePolicies?: readonly HarnessAgentGroupMergePolicy[];
}>;

/** One atomic adapter request: implementations must not partially accept members. */
export type HarnessStartAgentGroupRequest = Readonly<{
  protocolVersion: typeof HARNESS_AGENT_GROUPS_PROTOCOL_VERSION;
  sessionId: string;
  originTurnId: string;
  callIdentity: string;
  scopeIdentity: string;
  members: readonly HarnessAgentMemberLaunch[];
  joinPolicy: HarnessAgentJoinPolicyProfile;
  reductionPolicy: HarnessAgentReductionPolicy;
  deadlineAt: string;
  onDeadline: HarnessAgentDeadlineDisposition;
  /** The model's workspace ask; only sent to a launcher with `workspaces`. */
  workspace?: HarnessAgentGroupWorkspaceAsk;
  abortSignal?: AbortSignal;
}>;

export type HarnessStartedAgentMember = Readonly<{
  memberId: string;
  memberIndex: number;
  taskRef: HarnessExternalAgentTaskRef;
}>;

export type HarnessStartAgentGroupResult = Readonly<{
  groupRef: HarnessExternalAgentGroupRef;
  members: readonly HarnessStartedAgentMember[];
  acceptedAt: string;
}>;

export type HarnessAgentMemberStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out";

/** Trusted verifier receipt. It is validated internally and never exposed to the model. */
export type HarnessAgentVerificationReceipt = Readonly<{
  receiptRef: string;
  verifierHandle: string;
  requiredCheckSetHandle: string;
  verifiedAt: string;
}>;

/** Model-safe adapter observation; there is deliberately no child output field. */
export type HarnessAgentMemberObservation = Readonly<{
  memberId: string;
  memberIndex: number;
  taskRef: HarnessExternalAgentTaskRef;
  /** Monotonic per member, starting at 1. Equal revisions must be byte-consistent. */
  revision: number;
  status: HarnessAgentMemberStatus;
  verificationReceipt?: HarnessAgentVerificationReceipt;
  summary?: string;
  /** Opaque artifact/result reference; valid only for terminal member statuses. */
  resultRef?: HarnessExternalAgentResultRef;
  /** Bounded machine-readable failure cause; valid only for terminal member statuses. */
  failureCode?: string;
  updatedAt: string;
}>;

export type HarnessAgentGroupStatus =
  | "queued"
  | "running"
  | "satisfied"
  | "failed"
  | "cancelled"
  | "deadline";

export type HarnessWatchAgentGroupRequest = Readonly<{
  protocolVersion: typeof HARNESS_AGENT_GROUPS_PROTOCOL_VERSION;
  sessionId: string;
  originTurnId: string;
  callIdentity: string;
  scopeIdentity: string;
  groupRef: HarnessExternalAgentGroupRef;
  abortSignal?: AbortSignal;
}>;

export type HarnessWatchAgentGroupResult = Readonly<{
  groupRef: HarnessExternalAgentGroupRef;
  /** Monotonic for the complete ordered group snapshot, starting at 1. */
  groupRevision: number;
  status: HarnessAgentGroupStatus;
  members: readonly HarnessAgentMemberObservation[];
  observedAt: string;
}>;

export type HarnessJoinAgentGroupRequest = HarnessWatchAgentGroupRequest & Readonly<{
  maxWaitMs: number;
}>;

export type HarnessJoinAgentGroupResult = HarnessWatchAgentGroupResult & Readonly<{
  disposition: "satisfied" | "deadline" | "terminal";
  summary?: string;
  resultRefs: readonly HarnessExternalAgentResultRef[];
}>;

export type HarnessCancelAgentGroupRequest = HarnessWatchAgentGroupRequest & Readonly<{
  reason?: string;
}>;

export type HarnessCancelAgentGroupResult = Readonly<{
  groupRef: HarnessExternalAgentGroupRef;
  groupRevision: number;
  status: HarnessAgentGroupStatus;
  disposition: "cancelled" | "already_terminal";
  members: readonly HarnessAgentMemberObservation[];
  cancelledAt: string;
}>;

/** Exact aggregate at `aggregateVersion`; counts always sum to `memberCount`. */
export type HarnessAgentGroupAggregate = Readonly<{
  memberCount: number;
  queuedCount: number;
  runningCount: number;
  succeededCount: number;
  failedCount: number;
  cancelledCount: number;
  timedOutCount: number;
  verifiedSucceededCount: number;
  resultRefCount: number;
}>;

export type HarnessAgentGroupMemberChange = Readonly<{
  /** Gap-free, group-global sequence, starting at one. */
  sequence: number;
  member: HarnessAgentMemberObservation;
}>;

export type HarnessAgentGroupChange = Readonly<{
  /** Gap-free, group-global sequence, starting at one. */
  sequence: number;
  kind: "member";
  member: HarnessAgentMemberObservation;
}> | Readonly<{
  /** Group-only transitions consume the same sequence as member changes. */
  sequence: number;
  kind: "group_control";
  status: HarnessAgentGroupStatus;
  observedAt: string;
  /** Canonical digest of sequence, kind, status, and observedAt. */
  controlDigest: string;
}>;

/**
 * A cursor is adapter-owned and MUST be authenticated or bound to server-side
 * cursor state. It cannot be a caller-authoritative encoding of a sequence.
 */
export type HarnessAgentGroupPageRequest = Omit<HarnessWatchAgentGroupRequest, "protocolVersion"> & Readonly<{
  protocolVersion: "little-harness.agent-group-pages.v1" | typeof HARNESS_AGENT_GROUP_PAGES_PROTOCOL_VERSION;
  /** Ledger-bound before adapter invocation and stable across response-loss retry. */
  requestIdempotencyKey: string;
  afterSequence: number;
  pageCursor?: string;
  maximumChanges: number;
  maximumBytes: number;
  maximumCursorBytes: number;
}>;

export type HarnessAgentGroupMemberChangePage = Readonly<{
  requestIdempotencyKey: string;
  afterSequence: number;
  throughSequence: number;
  /** Required even at the current tail so it can resume future changes. */
  nextPageCursor: string;
  hasMore: boolean;
  /** Legacy member-only v1 changes remain readable during adapter upgrades. */
  changes: readonly (HarnessAgentGroupMemberChange | HarnessAgentGroupChange)[];
  /** Canonical digest of every field above except this digest. */
  pageDigest: string;
}>;

export type HarnessWatchAgentGroupPageResult = Readonly<{
  groupRef: HarnessExternalAgentGroupRef;
  /** Monotonic aggregate version; it equals the page's throughSequence. */
  aggregateVersion: number;
  status: HarnessAgentGroupStatus;
  aggregate: HarnessAgentGroupAggregate;
  memberPage: HarnessAgentGroupMemberChangePage;
  observedAt: string;
}>;

export type HarnessJoinAgentGroupPageRequest = HarnessAgentGroupPageRequest & Readonly<{
  maxWaitMs: number;
  operationIdempotencyKey: string;
  operationRef?: string;
  /** Pagination is independent: only operationRef selects continue. */
  operation: "begin" | "continue";
}>;

export type HarnessCancelAgentGroupPageRequest = HarnessAgentGroupPageRequest & Readonly<{
  reason?: string;
  operationIdempotencyKey: string;
  operationRef?: string;
  /** Pagination is independent: only operationRef selects continue. */
  operation: "begin" | "continue";
}>;

export type HarnessAgentGroupOperationResult = Readonly<{
  operationRef: string;
  kind: "join" | "cancel";
  resultVersion: number;
  disposition: "satisfied" | "deadline" | "terminal" | "cancelled" | "already_terminal";
  completedAt: string;
  summary?: string;
  resultRefs: readonly HarnessExternalAgentResultRef[];
  /** Canonical digest of every field above except this digest. */
  resultDigest: string;
}>;

export type HarnessJoinAgentGroupPageResult = HarnessWatchAgentGroupPageResult & Readonly<{
  operationResult: HarnessAgentGroupOperationResult;
}>;

/**
 * A bounded join wait may end before the external operation has an immutable
 * result. The operation reference is durable and must be supplied on the next
 * `continue`; it is not a synthetic group-deadline result.
 */
export type HarnessAgentGroupPendingOperation = Readonly<{
  operationRef: string;
  observedAggregateVersion: number;
  observedAt: string;
  retryAfterMs: number;
  /** Canonical digest of every field above except this digest. */
  pendingDigest: string;
}>;

export type HarnessJoinAgentGroupPendingPageResult =
  HarnessWatchAgentGroupPageResult & Readonly<{
    pendingOperation: HarnessAgentGroupPendingOperation;
  }>;

export type HarnessJoinAgentGroupPageCallResult =
  | HarnessJoinAgentGroupPageResult
  | HarnessJoinAgentGroupPendingPageResult;

export type HarnessCancelAgentGroupPageResult = HarnessWatchAgentGroupPageResult & Readonly<{
  operationResult: HarnessAgentGroupOperationResult;
}>;

export type HarnessAgentGroupCursorErrorCode = "invalid" | "expired" | "mismatch";

/** Typed adapter error; expiry is intentionally distinguishable from mismatch. */
export class HarnessAgentGroupCursorError extends LittleHarnessError {
  declare readonly code: HarnessAgentGroupCursorErrorCode;

  constructor(code: HarnessAgentGroupCursorErrorCode, message?: string) {
    super(message ?? `Agent Group cursor is ${code}.`, code);
    this.name = "HarnessAgentGroupCursorError";
  }
}

/** Typed failure raised before launcher I/O when a group's bounded call lifetime is exhausted. */
export class HarnessAgentGroupPageCallLimitError extends LittleHarnessError {
  declare readonly code: "page_call_limit";
  readonly maximumCalls: number;

  constructor(maximumCalls: number) {
    super(`Agent Group exhausted its durable lifetime limit of ${maximumCalls} page calls.`, "page_call_limit");
    this.name = "HarnessAgentGroupPageCallLimitError";
    this.maximumCalls = maximumCalls;
  }
}

/**
 * The paged observation capability of a launcher: member changes are read page by page instead
 * of as one snapshot. A launcher supplies all three methods or none (omit `paged`).
 */
export type HarnessAgentGroupPagedLauncher = Readonly<{
  watch(request: HarnessAgentGroupPageRequest): Promise<HarnessWatchAgentGroupPageResult>;
  join(request: HarnessJoinAgentGroupPageRequest): Promise<HarnessJoinAgentGroupPageCallResult>;
  cancel(request: HarnessCancelAgentGroupPageRequest): Promise<HarnessCancelAgentGroupPageResult>;
}>;

/** What became of one member's work when its group merged back. */
export type HarnessAgentGroupMemberWorkspace = Readonly<{
  memberId: string;
  /**
   * `merged`: merged cleanly. `resolved`: it conflicted and a resolver agent
   * merged it. `branch`: it conflicted and is kept, unmerged, on `branch`.
   */
  merge: "merged" | "resolved" | "branch";
  /** The branch holding the member's work; present exactly when `merge` is `branch`. */
  branch?: string;
  /** The first conflicting paths (at most 32); only when `merge` is `branch`. */
  conflictPaths?: readonly string[];
}>;

/**
 * How a completed group's workspace merged back: where the children started
 * and one row per member. A launcher reports it once the group has merged;
 * rows can change afterwards (a resolver turns `branch` into `resolved`).
 */
export type HarnessAgentGroupWorkspace = Readonly<{
  from: "parent" | "project";
  /** Why the children started from the Project head; a launcher-defined token, only with `project`. */
  reason?: string;
  members: readonly HarnessAgentGroupMemberWorkspace[];
}>;

/** Reads one owned group's workspace outcome; same identity fields as a watch. */
export type HarnessAgentGroupWorkspaceRequest = HarnessWatchAgentGroupRequest;

/**
 * The fork-and-merge capability of a launcher. When present, the
 * `start_agent_group` and `spawn_agent` tools accept `from` and `mergePolicy`,
 * start requests carry `workspace`, and join and watch results show how a
 * completed group merged back.
 */
export type HarnessAgentGroupWorkspaceLauncher = Readonly<{
  /** `undefined` until the group has merged back, or when the launcher keeps no outcome. */
  read(request: HarnessAgentGroupWorkspaceRequest): Promise<HarnessAgentGroupWorkspace | undefined>;
}>;

/** Neutral adapter port, implemented outside Harness (for example by Little Compute). */
export type HarnessAgentGroupLauncher = Readonly<{
  startAgentGroup(request: HarnessStartAgentGroupRequest): Promise<HarnessStartAgentGroupResult>;
  watchAgentGroup(request: HarnessWatchAgentGroupRequest): Promise<HarnessWatchAgentGroupResult>;
  joinAgentGroup(request: HarnessJoinAgentGroupRequest): Promise<HarnessJoinAgentGroupResult>;
  cancelAgentGroup(request: HarnessCancelAgentGroupRequest): Promise<HarnessCancelAgentGroupResult>;
  /** Optional paged capability. When present, Harness observes member changes page by page. */
  paged?: HarnessAgentGroupPagedLauncher;
  /** Optional fork-and-merge capability; see {@link HarnessAgentGroupWorkspaceLauncher}. */
  workspaces?: HarnessAgentGroupWorkspaceLauncher;
}>;

/**
 * The only start failure that proves no external member was accepted. All
 * other throws are indeterminate response loss: Harness leaves tasks queued and
 * retries the identical call/scope/member identities until the adapter
 * converges on its idempotent start result.
 */
export class HarnessAgentGroupLaunchRejectedError extends LittleHarnessError {
  declare readonly code: "agent_group_launch_rejected";

  constructor(message = "Agent Group launcher rejected the atomic request.") {
    super(message, "agent_group_launch_rejected");
    this.name = "HarnessAgentGroupLaunchRejectedError";
  }
}

export type HarnessAgentGroupsOptions = Readonly<{
  launcher: HarnessAgentGroupLauncher;
  profiles: readonly HarnessAgentProfile[];
  joinPolicies: readonly HarnessAgentJoinPolicyProfile[];
  defaultJoinPolicyHandle: string;
  reductionPolicies: readonly HarnessAgentReductionPolicy[];
  defaultReductionPolicyHandle: string;
  limits?: Partial<HarnessAgentGroupLimits>;
}>;

export type ResolvedHarnessAgentGroups = Readonly<{
  launcher: HarnessAgentGroupLauncher;
  profiles: readonly HarnessAgentProfile[];
  profilesByHandle: Readonly<Record<string, HarnessAgentProfile>>;
  joinPolicies: readonly HarnessAgentJoinPolicyProfile[];
  joinPoliciesByHandle: Readonly<Record<string, HarnessAgentJoinPolicyProfile>>;
  defaultJoinPolicyHandle: string;
  reductionPolicies: readonly HarnessAgentReductionPolicy[];
  reductionPoliciesByHandle: Readonly<Record<string, HarnessAgentReductionPolicy>>;
  defaultReductionPolicyHandle: string;
  limits: ResolvedHarnessAgentGroupLimits;
  observationMode?: "legacy_snapshot" | "paged_changes";
}>;
