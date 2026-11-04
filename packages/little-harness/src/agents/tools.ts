import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { HarnessInputError } from "../errors.js";
import {
  HARNESS_AGENT_GROUP_MAX_LIFETIME_PAGE_CALLS,
  type HarnessAgentGroupJoinBeginReservationResult,
  type HarnessAgentGroupPageState,
  type HarnessTaskLedger,
} from "../tasks/ledger.js";
import { harnessExecutionContext, type HarnessTaskRecord } from "../tasks/types.js";
import { canonicalJson, stableHash } from "../utils/canonical-hash.js";
import {
  HARNESS_AGENT_GROUP_PAGES_PROTOCOL_VERSION,
  HARNESS_AGENT_GROUPS_PROTOCOL_VERSION,
  HarnessAgentGroupCursorError,
  HarnessAgentGroupPageCallLimitError,
  HarnessAgentGroupLaunchRejectedError,
} from "./types.js";
import type {
  HarnessAgentGroupAggregate,
  HarnessAgentGroupLauncher,
  HarnessAgentGroupPagedLauncher,
  HarnessAgentGroupMemberChangePage,
  HarnessAgentGroupOperationResult,
  HarnessAgentGroupPageRequest,
  HarnessAgentGroupsOptions,
  HarnessAgentGroupStatus,
  HarnessAgentGroupMergePolicy,
  HarnessAgentGroupWorkspace,
  HarnessAgentGroupWorkspaceAsk,
  HarnessAgentJoinPolicy,
  HarnessAgentJoinPolicyProfile,
  HarnessAgentMemberObservation,
  HarnessAgentMemberStatus,
  HarnessAgentReductionPolicy,
  HarnessCancelAgentGroupResult,
  HarnessCancelAgentGroupPageResult,
  HarnessExternalAgentGroupRef,
  HarnessExternalAgentResultRef,
  HarnessExternalAgentTaskRef,
  HarnessJoinAgentGroupResult,
  HarnessJoinAgentGroupPendingPageResult,
  HarnessJoinAgentGroupPageCallResult,
  HarnessJoinAgentGroupPageResult,
  HarnessStartAgentGroupResult,
  HarnessWatchAgentGroupResult,
  HarnessWatchAgentGroupPageResult,
  ResolvedHarnessAgentGroupLimits,
  ResolvedHarnessAgentGroups,
} from "./types.js";

const HANDLE = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/u;
const MEMBER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const OPAQUE_REF_MAX_BYTES = 1_024;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1_000;
/** Merge rules one model call may set; launchers add their own after them. */
const MAX_MERGE_POLICIES = 64;
const MAX_MERGE_GLOB_BYTES = 512;
const MAX_WORKSPACE_CONFLICT_PATHS = 32;
const MAX_WORKSPACE_PATH_BYTES = 1_024;
const MAX_WORKSPACE_BRANCH_BYTES = 512;
/** Canonical bytes one workspace outcome may occupy in a tool result. */
const MAX_WORKSPACE_BYTES = 256 * 1_024;
const MEMBER_ID = /^member_[1-9][0-9]{0,8}$/u;
const DEFAULT_LIMITS: ResolvedHarnessAgentGroupLimits = Object.freeze({
  maxMembers: 32,
  maxPromptBytes: 64 * 1_024,
  maxGroupPromptBytes: 2 * 1_024 * 1_024,
  maxDeadlineMs: 24 * 60 * 60 * 1_000,
  maxJoinWaitMs: 5 * 60 * 1_000,
  maxMemberPageChanges: 128,
  maxMemberPageBytes: 256 * 1_024,
  maxMemberCursorBytes: 2_048,
});

export const HARNESS_AGENT_GROUP_TOOL_NAMES = [
  "start_agent_group",
  "spawn_agent",
  "watch_agent_group",
  "join_agent_group",
  "cancel_agent_group",
] as const;

export function resolveAgentGroupsOptions(
  options: HarnessAgentGroupsOptions,
): ResolvedHarnessAgentGroups {
  if (options.launcher === undefined || typeof options.launcher.startAgentGroup !== "function" ||
      typeof options.launcher.watchAgentGroup !== "function" ||
      typeof options.launcher.joinAgentGroup !== "function" ||
      typeof options.launcher.cancelAgentGroup !== "function") {
    throw new HarnessInputError("Agent Groups require a complete launcher port.");
  }
  const paged = options.launcher.paged;
  if (paged !== undefined && (paged === null || typeof paged.watch !== "function" ||
      typeof paged.join !== "function" || typeof paged.cancel !== "function")) {
    throw new HarnessInputError("Paged Agent Groups require launcher.paged with watch, join and cancel.");
  }
  const workspaces = options.launcher.workspaces;
  if (workspaces !== undefined && (workspaces === null || typeof workspaces.read !== "function")) {
    throw new HarnessInputError("Agent Group workspaces require launcher.workspaces with read.");
  }
  const observationMode = paged !== undefined ? "paged_changes" as const : "legacy_snapshot" as const;
  const limits = Object.freeze({
    maxMembers: boundedInteger(
      options.limits?.maxMembers ?? DEFAULT_LIMITS.maxMembers,
      1,
      observationMode === "paged_changes" ? 10_000 : 1_024,
      "maxMembers",
    ),
    maxPromptBytes: boundedInteger(
      options.limits?.maxPromptBytes ?? DEFAULT_LIMITS.maxPromptBytes,
      1,
      16 * 1_024 * 1_024,
      "maxPromptBytes",
    ),
    maxGroupPromptBytes: boundedInteger(
      options.limits?.maxGroupPromptBytes ?? DEFAULT_LIMITS.maxGroupPromptBytes,
      1,
      64 * 1_024 * 1_024,
      "maxGroupPromptBytes",
    ),
    maxDeadlineMs: boundedInteger(
      options.limits?.maxDeadlineMs ?? DEFAULT_LIMITS.maxDeadlineMs,
      1,
      30 * 24 * 60 * 60 * 1_000,
      "maxDeadlineMs",
    ),
    maxJoinWaitMs: boundedInteger(
      options.limits?.maxJoinWaitMs ?? DEFAULT_LIMITS.maxJoinWaitMs,
      0,
      24 * 60 * 60 * 1_000,
      "maxJoinWaitMs",
    ),
    maxMemberPageChanges: boundedInteger(
      options.limits?.maxMemberPageChanges ?? DEFAULT_LIMITS.maxMemberPageChanges,
      1,
      1_024,
      "maxMemberPageChanges",
    ),
    maxMemberPageBytes: boundedInteger(
      options.limits?.maxMemberPageBytes ?? DEFAULT_LIMITS.maxMemberPageBytes,
      1_024,
      4 * 1_024 * 1_024,
      "maxMemberPageBytes",
    ),
    maxMemberCursorBytes: boundedInteger(
      options.limits?.maxMemberCursorBytes ?? DEFAULT_LIMITS.maxMemberCursorBytes,
      64,
      16 * 1_024,
      "maxMemberCursorBytes",
    ),
  });
  const profiles = Object.freeze(options.profiles.map((profile) => Object.freeze({
    handle: declaredHandle(profile.handle, "agent profile"),
    ...(profile.description === undefined ? {} : { description: boundedText(profile.description, 4_096, "profile description") }),
    resourcesHandle: declaredHandle(profile.resourcesHandle, "resources profile"),
    secretsHandle: declaredHandle(profile.secretsHandle, "secrets profile"),
    toolsHandle: declaredHandle(profile.toolsHandle, "tools profile"),
    networkHandle: declaredHandle(profile.networkHandle, "network profile"),
    priorityHandle: declaredHandle(profile.priorityHandle, "priority profile"),
  })));
  const reductionPolicies = Object.freeze(options.reductionPolicies.map((policy) => Object.freeze({
    handle: declaredHandle(policy.handle, "reduction policy"),
    ...(policy.description === undefined
      ? {}
      : { description: boundedText(policy.description, 4_096, "reduction description") }),
    maxMemberSummaryBytes: boundedInteger(policy.maxMemberSummaryBytes, 0, 1_048_576, "maxMemberSummaryBytes"),
    maxGroupSummaryBytes: boundedInteger(policy.maxGroupSummaryBytes, 0, 1_048_576, "maxGroupSummaryBytes"),
    maxResultRefs: boundedInteger(policy.maxResultRefs, 0, 10_000, "maxResultRefs"),
  })));
  const joinPolicies = Object.freeze(options.joinPolicies.map((entry) => {
    const policy = normalizedConfiguredJoinPolicy(entry.policy);
    if (policy.kind === "first_verified" &&
        (entry.verifierHandle === undefined || entry.requiredCheckSetHandle === undefined)) {
      throw new HarnessInputError(
        "first_verified Agent Group join policies require trusted verifier and check-set handles.",
        { joinPolicyHandle: entry.handle },
      );
    }
    if (policy.kind !== "first_verified" &&
        (entry.verifierHandle !== undefined || entry.requiredCheckSetHandle !== undefined)) {
      throw new HarnessInputError(
        "Verifier bindings are valid only for first_verified Agent Group join policies.",
        { joinPolicyHandle: entry.handle },
      );
    }
    return Object.freeze({
      handle: declaredHandle(entry.handle, "join policy"),
      ...(entry.description === undefined
        ? {}
        : { description: boundedText(entry.description, 4_096, "join policy description") }),
      policy,
      ...(entry.verifierHandle === undefined
        ? {}
        : { verifierHandle: declaredHandle(entry.verifierHandle, "verifier") }),
      ...(entry.requiredCheckSetHandle === undefined
        ? {}
        : { requiredCheckSetHandle: declaredHandle(entry.requiredCheckSetHandle, "required check set") }),
    });
  }));
  const profilesByHandle = indexedByHandle(profiles, "agent profile");
  const joinPoliciesByHandle = indexedByHandle(joinPolicies, "join policy");
  const reductionPoliciesByHandle = indexedByHandle(reductionPolicies, "reduction policy");
  if (profiles.length === 0) throw new HarnessInputError("At least one Agent Group profile is required.");
  if (!Object.hasOwn(joinPoliciesByHandle, options.defaultJoinPolicyHandle)) {
    throw new HarnessInputError("The default Agent Group join policy handle is not declared.", {
      joinPolicyHandle: options.defaultJoinPolicyHandle,
    });
  }
  if (!Object.hasOwn(reductionPoliciesByHandle, options.defaultReductionPolicyHandle)) {
    throw new HarnessInputError("The default Agent Group reduction policy handle is not declared.", {
      reductionPolicyHandle: options.defaultReductionPolicyHandle,
    });
  }
  return Object.freeze({
    launcher: options.launcher,
    profiles,
    profilesByHandle,
    joinPolicies,
    joinPoliciesByHandle,
    defaultJoinPolicyHandle: options.defaultJoinPolicyHandle,
    reductionPolicies,
    reductionPoliciesByHandle,
    defaultReductionPolicyHandle: options.defaultReductionPolicyHandle,
    limits,
    observationMode,
  });
}

export function createAgentGroupTools(config: Readonly<{
  sessionId: string;
  originTurnId: string;
  ledger: HarnessTaskLedger;
  agents: ResolvedHarnessAgentGroups;
  abortSignal?: AbortSignal;
}>): ToolSet {
  requiredAgentGroupLedger(config.ledger);
  const observationMode = agentObservationMode(config.agents);
  if (observationMode === "paged_changes") requiredPagedAgentGroupLedger(config.ledger);
  const profileHandleSchema = configuredHandleSchema(config.agents.profiles, "agent profile");
  const joinPolicyHandleSchema = configuredHandleSchema(config.agents.joinPolicies, "join policy");
  const reductionPolicyHandleSchema = configuredHandleSchema(
    config.agents.reductionPolicies,
    "reduction policy",
  );
  const memberSchema = z.object({
    name: z.string().regex(MEMBER_NAME).optional(),
    purpose: z.string().max(2_048).optional(),
    prompt: z.string().min(1),
    profileHandle: profileHandleSchema,
  }).strict();
  const baseLaunchControls = {
    reductionPolicyHandle: reductionPolicyHandleSchema.optional(),
    joinPolicyHandle: joinPolicyHandleSchema.optional(),
    deadlineMs: z.number().int().positive().max(config.agents.limits.maxDeadlineMs).optional(),
    onDeadline: z.enum(["cancel_pending", "return_terminal", "fail_group"]).optional(),
  } as const;
  // `from` and `mergePolicy` exist only for a launcher that can fork and
  // merge; every other launcher keeps its exact tool schema.
  const supportsWorkspaces = config.agents.launcher.workspaces !== undefined;
  const launchControls = (supportsWorkspaces
    ? { ...baseLaunchControls, ...workspaceControls() }
    : baseLaunchControls) as typeof baseLaunchControls;
  const groupRefSchema = z.string().min(1).max(OPAQUE_REF_MAX_BYTES);
  const pageCursorSchema = z.string().min(1).max(config.agents.limits.maxMemberCursorBytes).optional();
  const pageControls = {
    pageCursor: pageCursorSchema,
    afterSequence: z.number().int().nonnegative().optional(),
    pageSize: z.number().int().positive().max(config.agents.limits.maxMemberPageChanges).optional(),
  } as const;

  return {
    start_agent_group: tool({
      description:
        "Atomically start an ordered group of isolated agents using declared profile handles. " +
        "Resource, secret, tool, network, and priority values cannot be requested directly." +
        (supportsWorkspaces ? START_WORKSPACE_DESCRIPTION : ""),
      inputSchema: z.object({
        members: z.array(memberSchema).min(1).max(config.agents.limits.maxMembers),
        ...launchControls,
      }).strict(),
      execute: async (input, executionOptions) => launchGroup(config, {
        ...modelWorkspaceInput(input),
        members: input.members.map((member) => ({
          ...(member.name === undefined ? {} : { name: member.name }),
          ...(member.purpose === undefined ? {} : { purpose: member.purpose }),
          prompt: member.prompt,
          profileHandle: member.profileHandle,
        })),
        ...(input.reductionPolicyHandle === undefined
          ? {}
          : { reductionPolicyHandle: input.reductionPolicyHandle }),
        ...(input.joinPolicyHandle === undefined ? {} : { joinPolicyHandle: input.joinPolicyHandle }),
        ...(input.deadlineMs === undefined ? {} : { deadlineMs: input.deadlineMs }),
        ...(input.onDeadline === undefined ? {} : { onDeadline: input.onDeadline }),
      }, executionOptions),
    }),
    spawn_agent: tool({
      description: "Start one isolated agent; this is exactly a one-member Agent Group lowering." +
        (supportsWorkspaces ? SPAWN_WORKSPACE_DESCRIPTION : ""),
      inputSchema: z.object({
        ...memberSchema.shape,
        ...launchControls,
      }).strict(),
      execute: async (input, executionOptions) => {
        const launched = await launchGroup(config, {
          ...modelWorkspaceInput(input),
          members: [{
            ...(input.name === undefined ? {} : { name: input.name }),
            ...(input.purpose === undefined ? {} : { purpose: input.purpose }),
            prompt: input.prompt,
            profileHandle: input.profileHandle,
          }],
          ...(input.reductionPolicyHandle === undefined
            ? {}
            : { reductionPolicyHandle: input.reductionPolicyHandle }),
          ...(input.joinPolicyHandle === undefined ? {} : { joinPolicyHandle: input.joinPolicyHandle }),
          ...(input.deadlineMs === undefined ? {} : { deadlineMs: input.deadlineMs }),
          ...(input.onDeadline === undefined ? {} : { onDeadline: input.onDeadline }),
        }, executionOptions, "spawn_agent");
        return {
          status: "started" as const,
          groupRef: launched.groupRef,
          member: launched.members[0],
          deadlineAt: launched.deadlineAt,
        };
      },
    }),
    ...(observationMode === "legacy_snapshot" ? {
      watch_agent_group: tool({
      description: "Read bounded status and summaries for one Agent Group owned by this session." +
        (supportsWorkspaces ? WATCH_WORKSPACE_DESCRIPTION : ""),
      inputSchema: z.object({ groupRef: groupRefSchema }).strict(),
      execute: async ({ groupRef }, executionOptions) => {
        const group = await ownedGroup(config, groupRef);
        const result = await config.agents.launcher.watchAgentGroup({
          ...controlRequest(config, "watch_agent_group", group, executionOptions),
          groupRef: asGroupRef(groupRef),
        });
        const safe = validateObservation(result, group, "watch");
        await projectObservations(config.ledger, group, safe);
        return {
          ...presentObservation(safe),
          ...(isActiveGroup(safe.status)
            ? {}
            : await readWorkspace(config, group, group.tasks.length, executionOptions)),
        };
      },
      }),
      join_agent_group: tool({
      description:
        "Wait for the configured Agent Group join policy for a bounded interval and return only bounded reductions." +
        (supportsWorkspaces ? JOIN_WORKSPACE_DESCRIPTION : ""),
      inputSchema: z.object({
        groupRef: groupRefSchema,
        maxWaitMs: z.number().int().nonnegative().max(config.agents.limits.maxJoinWaitMs).optional(),
      }).strict(),
      execute: async ({ groupRef, maxWaitMs }, executionOptions) => {
        const group = await ownedGroup(config, groupRef);
        const result = await config.agents.launcher.joinAgentGroup({
          ...controlRequest(config, "join_agent_group", group, executionOptions),
          groupRef: asGroupRef(groupRef),
          maxWaitMs: maxWaitMs ?? config.agents.limits.maxJoinWaitMs,
        });
        const safe = validateJoin(result, group);
        await projectObservations(config.ledger, group, safe, {
          disposition: safe.disposition,
          ...(safe.summary === undefined ? {} : { summary: safe.summary }),
          resultRefs: safe.resultRefs,
        });
        return {
          ...presentJoin(safe),
          ...await readWorkspace(config, group, group.tasks.length, executionOptions),
        };
      },
      }),
      cancel_agent_group: tool({
      description: "Cancel non-terminal members of one Agent Group owned by this session.",
      inputSchema: z.object({
        groupRef: groupRefSchema,
        reason: z.string().max(512).optional(),
      }).strict(),
      execute: async ({ groupRef, reason }, executionOptions) => {
        const group = await ownedGroup(config, groupRef);
        const result = await config.agents.launcher.cancelAgentGroup({
          ...controlRequest(config, "cancel_agent_group", group, executionOptions),
          groupRef: asGroupRef(groupRef),
          ...(reason === undefined ? {} : { reason }),
        });
        const safe = validateCancel(result, group);
        await projectObservations(config.ledger, group, {
          groupRef: safe.groupRef,
          groupRevision: safe.groupRevision,
          status: safe.status,
          members: safe.members,
          observedAt: safe.cancelledAt,
        });
        return presentCancel(safe);
      },
      }),
    } : {
      watch_agent_group: tool({
        description: "Read a bounded aggregate and gap-free page of member changes for one Agent Group." +
          (supportsWorkspaces ? WATCH_WORKSPACE_DESCRIPTION : ""),
        inputSchema: z.object({ groupRef: groupRefSchema, ...pageControls }).strict(),
        execute: async ({ groupRef, pageCursor, afterSequence, pageSize }, executionOptions) => {
          const group = await ownedPagedGroup(config, groupRef);
          const bound = await pageRequest(config, group, "watch_agent_group", "watch", executionOptions, {
            ...(pageCursor === undefined ? {} : { pageCursor }),
            ...(afterSequence === undefined ? {} : { afterSequence }),
            ...(pageSize === undefined ? {} : { pageSize }),
          });
          const result = await requiredPagedLauncher(config.agents.launcher).watch(bound.request);
          const safe = validatePagedObservation(result, group, bound.request, "watch");
          await projectPagedObservations(config.ledger, group, safe, bound.callIdentity);
          return {
            ...presentPagedObservation(safe),
            ...(isActiveGroup(safe.status)
              ? {}
              : await readWorkspace(config, group, group.state.memberCount, executionOptions)),
          };
        },
      }),
      join_agent_group: tool({
        description:
          "Apply the bounded join once, then read its stored aggregate and gap-free member-change pages." +
          (supportsWorkspaces ? JOIN_WORKSPACE_DESCRIPTION : ""),
        inputSchema: z.object({
          groupRef: groupRefSchema,
          maxWaitMs: z.number().int().nonnegative().max(config.agents.limits.maxJoinWaitMs).optional(),
          operationRef: groupRefSchema.optional(),
          ...pageControls,
        }).strict(),
        execute: async ({ groupRef, maxWaitMs, operationRef, pageCursor, afterSequence, pageSize }, executionOptions) => {
          const group = await ownedPagedGroup(config, groupRef);
          if (operationRef !== undefined && maxWaitMs !== undefined) {
            throw new HarnessInputError("Continuing an Agent Group join cannot change maxWaitMs.");
          }
          const effectiveMaxWaitMs = maxWaitMs ?? config.agents.limits.maxJoinWaitMs;
          const bound = await pageRequest(config, group, "join_agent_group", "join", executionOptions, {
            ...(pageCursor === undefined ? {} : { pageCursor }),
            ...(afterSequence === undefined ? {} : { afterSequence }),
            ...(pageSize === undefined ? {} : { pageSize }),
          }, {
            ...(operationRef === undefined ? { maxWaitMs: effectiveMaxWaitMs } : { operationRef }),
          });
          const operationIdempotencyKey = operationKey("join", bound.callIdentity, group.groupRef, {
            ...(operationRef === undefined ? { maxWaitMs: effectiveMaxWaitMs } : { operationRef }),
          });
          const reservationLedger = requiredPagedAgentGroupLedger(config.ledger);
          const beginReservation = operationRef === undefined
            ? validateJoinBeginReservationResult(await reservationLedger.reserveAgentGroupJoinBegin({
              sessionId: group.state.sessionId,
              scopeIdentity: group.scopeIdentity,
              groupRef: group.groupRef,
              pageCallIdentity: bound.callIdentity,
              requestIdempotencyKey: bound.request.requestIdempotencyKey,
              operationIdempotencyKey,
              mutationInputDigest: bound.mutationInputDigest,
            }))
            : undefined;
          if (beginReservation?.outcome === "conflict" && beginReservation.operationRef !== undefined) {
            return presentPagedJoinRecovery(group.groupRef, beginReservation.operationRef);
          }
          if (beginReservation?.outcome === "conflict" || beginReservation?.outcome === "inconsistent") {
            throw new HarnessInputError(
              "Agent Group join begin could not reserve its immutable operation identity.",
              { reservationOutcome: beginReservation.outcome },
            );
          }
          if (beginReservation?.phase === "ref_bound" && beginReservation.operationRef !== undefined) {
            return presentPagedJoinRecovery(group.groupRef, beginReservation.operationRef);
          }
          const expectedOperationRef = operationRef ?? beginReservation?.operationRef;
          let result: HarnessJoinAgentGroupPageCallResult;
          try {
            result = await requiredPagedLauncher(config.agents.launcher).join({
              ...bound.request,
              maxWaitMs: effectiveMaxWaitMs,
              operationIdempotencyKey,
              ...(operationRef === undefined ? {} : { operationRef }),
              operation: operationRef === undefined ? "begin" : "continue",
            });
          } catch (error) {
            if (expectedOperationRef !== undefined) {
              return presentPagedJoinRecovery(group.groupRef, expectedOperationRef);
            }
            const racedReservation = await reservationLedger.reserveAgentGroupJoinBegin({
              sessionId: group.state.sessionId,
              scopeIdentity: group.scopeIdentity,
              groupRef: group.groupRef,
              pageCallIdentity: bound.callIdentity,
              requestIdempotencyKey: bound.request.requestIdempotencyKey,
              operationIdempotencyKey,
              mutationInputDigest: bound.mutationInputDigest,
            });
            const safeRacedReservation = validateJoinBeginReservationResult(racedReservation);
            if (safeRacedReservation.operationRef !== undefined) {
              return presentPagedJoinRecovery(group.groupRef, safeRacedReservation.operationRef);
            }
            throw error;
          }
          try {
            if ("pendingOperation" in result) {
              const safe = validatePagedJoinPending(
                result,
                group,
                bound.request,
                expectedOperationRef,
              );
              const pendingBinding = await reservationLedger.bindAgentGroupPendingOperation({
                sessionId: group.state.sessionId,
                scopeIdentity: group.scopeIdentity,
                groupRef: group.groupRef,
                operationIdempotencyKey,
                mutationInputDigest: bound.mutationInputDigest,
                operationMode: operationRef === undefined ? "begin" : "continue",
                pageCallIdentity: bound.callIdentity,
                requestIdempotencyKey: bound.request.requestIdempotencyKey,
                pending: safe.pendingOperation,
              });
              if (pendingBinding.outcome !== "applied" && pendingBinding.outcome !== "replayed") {
                throw new HarnessInputError(
                  "Agent Group pending operation could not be bound to immutable authority.",
                  { bindingOutcome: pendingBinding.outcome },
                );
              }
              await projectPagedObservations(
                config.ledger,
                group,
                safe,
                bound.callIdentity,
              );
              return presentPagedJoinPending(safe);
            }
            const safe = validatePagedOperation(result, group, bound.request, "join", expectedOperationRef);
            await bindImmutableOperationResult(
              config.ledger,
              group,
              safe,
              operationIdempotencyKey,
              bound.mutationInputDigest,
              operationRef === undefined ? "begin" : "continue",
              false,
              bound.callIdentity,
              bound.request.requestIdempotencyKey,
            );
            await projectPagedObservations(config.ledger, group, safe, bound.callIdentity);
            const resolved = safe.memberPage.throughSequence >= safe.operationResult.resultVersion;
            if (resolved) {
              await bindImmutableOperationResult(
                config.ledger,
                group,
                safe,
                operationIdempotencyKey,
                bound.mutationInputDigest,
                operationRef === undefined ? "begin" : "continue",
                true,
                bound.callIdentity,
                bound.request.requestIdempotencyKey,
              );
            }
            return {
              ...presentPagedJoin(safe),
              ...(resolved
                ? await readWorkspace(config, group, group.state.memberCount, executionOptions)
                : {}),
            };
          } catch (error) {
            // A deterministic error after a launcher response must stay
            // visible. Reconcile an interrupted begin reservation only so a
            // later exact retry can discover its durable operation reference.
            if (operationRef === undefined) {
              try {
                await reservationLedger.reserveAgentGroupJoinBegin({
                  sessionId: group.state.sessionId,
                  scopeIdentity: group.scopeIdentity,
                  groupRef: group.groupRef,
                  pageCallIdentity: bound.callIdentity,
                  requestIdempotencyKey: bound.request.requestIdempotencyKey,
                  operationIdempotencyKey,
                  mutationInputDigest: bound.mutationInputDigest,
                });
              } catch {
                // Preserve the deterministic result-processing error.
              }
            }
            throw error;
          }
        },
      }),
      cancel_agent_group: tool({
        description: "Apply cancellation once, then read its stored aggregate and gap-free member-change pages.",
        inputSchema: z.object({
          groupRef: groupRefSchema,
          reason: z.string().max(512).optional(),
          operationRef: groupRefSchema.optional(),
          ...pageControls,
        }).strict(),
        execute: async ({ groupRef, reason, operationRef, pageCursor, afterSequence, pageSize }, executionOptions) => {
          const group = await ownedPagedGroup(config, groupRef);
          if (operationRef !== undefined && reason !== undefined) {
            throw new HarnessInputError("Continuing Agent Group cancellation cannot change its reason.");
          }
          const mutation = operationRef === undefined
            ? { ...(reason === undefined ? {} : { reason }) }
            : { operationRef };
          const bound = await pageRequest(config, group, "cancel_agent_group", "cancel", executionOptions, {
            ...(pageCursor === undefined ? {} : { pageCursor }),
            ...(afterSequence === undefined ? {} : { afterSequence }),
            ...(pageSize === undefined ? {} : { pageSize }),
          }, mutation);
          const operationIdempotencyKey = operationKey("cancel", bound.callIdentity, group.groupRef, mutation);
          const result = await requiredPagedLauncher(config.agents.launcher).cancel({
            ...bound.request,
            ...(reason === undefined ? {} : { reason }),
            operationIdempotencyKey,
            ...(operationRef === undefined ? {} : { operationRef }),
            operation: operationRef === undefined ? "begin" : "continue",
          });
          const safe = validatePagedOperation(result, group, bound.request, "cancel", operationRef);
          await bindImmutableOperationResult(
            config.ledger,
            group,
            safe,
            operationIdempotencyKey,
            bound.mutationInputDigest,
            operationRef === undefined ? "begin" : "continue",
            false,
          );
          await projectPagedObservations(config.ledger, group, safe, bound.callIdentity);
          if (safe.memberPage.throughSequence >= safe.operationResult.resultVersion) {
            await bindImmutableOperationResult(
              config.ledger,
              group,
              safe,
              operationIdempotencyKey,
              bound.mutationInputDigest,
              operationRef === undefined ? "begin" : "continue",
              true,
            );
          }
          return presentPagedCancel(safe);
        },
      }),
    }),
  };
}

type ModelMember = Readonly<{
  name?: string;
  purpose?: string;
  prompt: string;
  profileHandle: string;
}>;

type LaunchInput = Readonly<{
  members: readonly ModelMember[];
  reductionPolicyHandle?: string;
  joinPolicyHandle?: string;
  deadlineMs?: number;
  onDeadline?: "cancel_pending" | "return_terminal" | "fail_group";
  from?: "parent" | "project";
  mergePolicy?: readonly HarnessAgentGroupMergePolicy[];
}>;

const START_WORKSPACE_DESCRIPTION =
  " Children start from a copy of your current files (from: \"parent\", the default) or from the Project head" +
  " (from: \"project\"), work in isolation, and merge back into one result when the group completes." +
  " Shared files merge three-way; a member whose merge conflicts keeps its work on a branch." +
  " mergePolicy sets per-path rules, first match wins: owner gives one member (member_1, member_2, … in" +
  " member order) sole write access to matching paths; collect puts each member's matching outputs under" +
  " members/<memberId>/ so they never collide (reports, generated files).";
const SPAWN_WORKSPACE_DESCRIPTION =
  " The agent starts from a copy of your current files (from: \"parent\", the default) or from the Project head" +
  " (from: \"project\"); its work merges back when it completes.";
const JOIN_WORKSPACE_DESCRIPTION =
  " Once the group has merged back, workspace says where the children started and, per member, whether its" +
  " work merged, was merged by a resolver agent (resolved), or is kept on a branch with its conflicting paths.";
const WATCH_WORKSPACE_DESCRIPTION =
  " For a finished group, workspace shows the current merge-back state of each member.";

function workspaceControls() {
  return {
    from: z.enum(["parent", "project"]).optional().describe(
      "Where children start: parent (default) is a copy of your current files; project is the Project head.",
    ),
    mergePolicy: z.array(z.object({
      glob: z.string().min(1).max(MAX_MERGE_GLOB_BYTES).describe(
        "Repository-relative path pattern: ** spans directories, * stays within one; a pattern without / matches at any depth.",
      ),
      policy: z.enum(["three_way", "collect", "owner"]),
      owner: z.string().regex(MEMBER_ID).optional().describe(
        "Required for owner: the member id (member_1 is the first member) that alone may write matching paths.",
      ),
    }).strict()).min(1).max(MAX_MERGE_POLICIES).optional().describe(
      "Ordered per-path merge rules; the first rule matching a path decides how members' changes to it merge back.",
    ),
  } as const;
}

/** Reads the workspace fields a tool input has only when the launcher supports them. */
function modelWorkspaceInput(input: object): Pick<LaunchInput, "from" | "mergePolicy"> {
  const { from, mergePolicy } = input as Pick<LaunchInput, "from" | "mergePolicy">;
  return {
    ...(from === undefined ? {} : { from }),
    ...(mergePolicy === undefined ? {} : { mergePolicy }),
  };
}

type HarnessAgentGroupCapableLedger = HarnessTaskLedger & Readonly<{
  bindAgentGroupStart: NonNullable<HarnessTaskLedger["bindAgentGroupStart"]>;
  projectAgentGroupObservation: NonNullable<HarnessTaskLedger["projectAgentGroupObservation"]>;
}>;

type HarnessPagedAgentGroupCapableLedger = HarnessAgentGroupCapableLedger & Readonly<{
  reserveAgentGroupTaskBatch: NonNullable<HarnessTaskLedger["reserveAgentGroupTaskBatch"]>;
  getAgentGroupPageState: NonNullable<HarnessTaskLedger["getAgentGroupPageState"]>;
  bindAgentGroupPageCall: NonNullable<HarnessTaskLedger["bindAgentGroupPageCall"]>;
  reserveAgentGroupJoinBegin: NonNullable<HarnessTaskLedger["reserveAgentGroupJoinBegin"]>;
  bindAgentGroupPendingOperation: NonNullable<HarnessTaskLedger["bindAgentGroupPendingOperation"]>;
  bindAgentGroupOperationResult: NonNullable<HarnessTaskLedger["bindAgentGroupOperationResult"]>;
  projectAgentGroupPage: NonNullable<HarnessTaskLedger["projectAgentGroupPage"]>;
}>;

function requiredAgentGroupLedger(ledger: HarnessTaskLedger): HarnessAgentGroupCapableLedger {
  if (typeof ledger.bindAgentGroupStart !== "function" ||
      typeof ledger.projectAgentGroupObservation !== "function") {
    throw new HarnessInputError(
      "Agent Groups require orchestration task-ledger start-binding and observation-projection capabilities.",
    );
  }
  return ledger as HarnessAgentGroupCapableLedger;
}

function requiredPagedAgentGroupLedger(ledger: HarnessTaskLedger): HarnessPagedAgentGroupCapableLedger {
  const base = requiredAgentGroupLedger(ledger);
  if (typeof ledger.reserveAgentGroupTaskBatch !== "function" ||
      typeof ledger.getAgentGroupPageState !== "function" ||
      typeof ledger.bindAgentGroupPageCall !== "function" ||
      typeof ledger.reserveAgentGroupJoinBegin !== "function" ||
      typeof ledger.bindAgentGroupPendingOperation !== "function" ||
      typeof ledger.bindAgentGroupOperationResult !== "function" ||
      typeof ledger.projectAgentGroupPage !== "function") {
    throw new HarnessInputError(
      "Paged Agent Groups require atomic batch reservation, pending/result authority, and member-change projection ledger capabilities.",
    );
  }
  return base as HarnessPagedAgentGroupCapableLedger;
}

function validateJoinBeginReservationResult(
  value: unknown,
): HarnessAgentGroupJoinBeginReservationResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new HarnessInputError("Paged Agent Group join reservation returned an invalid result.");
  }
  const candidate = value as {
    readonly outcome?: unknown;
    readonly phase?: unknown;
    readonly operationRef?: unknown;
  };
  const outcomes = [
    "applied",
    "replayed",
    "ref_bound",
    "pending",
    "terminal",
    "conflict",
    "inconsistent",
  ] as const;
  const phases = ["reserved", "ref_bound", "pending", "terminal"] as const;
  if (!outcomes.includes(candidate.outcome as typeof outcomes[number]) ||
      !phases.includes(candidate.phase as typeof phases[number])) {
    throw new HarnessInputError("Paged Agent Group join reservation returned an invalid result.");
  }
  if (candidate.phase !== "reserved" &&
      (typeof candidate.operationRef !== "string" || candidate.operationRef.length === 0)) {
    throw new HarnessInputError("Paged Agent Group join reservation returned an invalid result.");
  }
  if (candidate.operationRef !== undefined) {
    if (typeof candidate.operationRef !== "string" || candidate.operationRef.length === 0) {
      throw new HarnessInputError("Paged Agent Group join reservation returned an invalid result.");
    }
    validOpaqueRef(candidate.operationRef, "operationRef");
  }
  return value as HarnessAgentGroupJoinBeginReservationResult;
}

function agentObservationMode(agents: ResolvedHarnessAgentGroups): "legacy_snapshot" | "paged_changes" {
  if (agents.observationMode !== undefined) return agents.observationMode;
  return agents.launcher.paged !== undefined ? "paged_changes" : "legacy_snapshot";
}

function requiredPagedLauncher(launcher: HarnessAgentGroupLauncher): HarnessAgentGroupPagedLauncher {
  const paged = launcher.paged;
  if (paged === undefined || typeof paged.watch !== "function" ||
      typeof paged.join !== "function" || typeof paged.cancel !== "function") {
    throw new HarnessInputError("Paged Agent Groups require launcher.paged with watch, join and cancel.");
  }
  return paged;
}

function configuredHandleSchema(
  entries: readonly Readonly<{ handle: string; description?: string }>[],
  label: string,
) {
  const handles = entries.map((entry) => entry.handle);
  if (handles.length === 0) throw new HarnessInputError(`At least one ${label} is required.`);
  const catalog = entries.map((entry) =>
    entry.description === undefined ? entry.handle : `${entry.handle} — ${entry.description}`);
  return z.enum(handles as [string, ...string[]]).describe(
    `Select one configured ${label} handle. Available: ${catalog.join("; ")}`,
  );
}

async function launchGroup(
  config: Parameters<typeof createAgentGroupTools>[0],
  input: LaunchInput,
  executionOptions: unknown,
  launcherHandle = "start_agent_group",
) {
  if (input.members.length < 1 || input.members.length > config.agents.limits.maxMembers) {
    throw new HarnessInputError("Agent Group member count is outside the configured bound.");
  }
  const profiles = input.members.map((member) => {
    boundedText(member.prompt, config.agents.limits.maxPromptBytes, "agent prompt");
    const profile = config.agents.profilesByHandle[member.profileHandle];
    if (profile === undefined) {
      throw new HarnessInputError("Agent profile handle is not declared.", {
        profileHandle: member.profileHandle,
      });
    }
    return profile;
  });
  const aggregatePromptBytes = input.members.reduce(
    (total, member) => total + utf8Bytes(member.prompt),
    0,
  );
  if (aggregatePromptBytes > config.agents.limits.maxGroupPromptBytes) {
    throw new HarnessInputError("Agent Group prompts exceed the configured aggregate byte bound.");
  }
  const reductionHandle = input.reductionPolicyHandle ?? config.agents.defaultReductionPolicyHandle;
  const reductionPolicy = config.agents.reductionPoliciesByHandle[reductionHandle];
  if (reductionPolicy === undefined) {
    throw new HarnessInputError("Agent reduction policy handle is not declared.", {
      reductionPolicyHandle: reductionHandle,
    });
  }
  const joinPolicyHandle = input.joinPolicyHandle ?? config.agents.defaultJoinPolicyHandle;
  const configuredJoinPolicy = config.agents.joinPoliciesByHandle[joinPolicyHandle];
  if (configuredJoinPolicy === undefined) {
    throw new HarnessInputError("Agent join policy handle is not declared.", { joinPolicyHandle });
  }
  const joinPolicy = resolvedJoinPolicy(configuredJoinPolicy, input.members.length);
  const workspace = workspaceAsk(config, input);
  const execution = requiredExecutionIdentity(executionOptions);
  const deadlineMs = input.deadlineMs ?? Math.min(30 * 60 * 1_000, config.agents.limits.maxDeadlineMs);
  const onDeadline = input.onDeadline ?? "cancel_pending";
  const callIdentity = `agc_${stableHash({
    domain: "little-harness.agent-group-call.v1",
    sessionId: config.sessionId,
    originTurnId: config.originTurnId,
    launcherHandle,
    toolCallId: execution.toolCallId,
    modelStepId: execution.modelStepId,
    sequenceIndex: execution.sequenceIndex,
    members: input.members,
    profiles,
    reductionPolicy,
    joinPolicy,
    deadlineMs,
    onDeadline,
    // Only an ask changes the identity, so groups without one keep theirs.
    ...(workspace === undefined ? {} : { workspace }),
  }, { format: "base32hex" }).slice(0, 40)}`;
  const scopeIdentity = `ags_${stableHash({
    domain: "little-harness.agent-group-scope.v1",
    sessionId: config.sessionId,
    originTurnId: config.originTurnId,
    callIdentity,
  }, { format: "base32hex" }).slice(0, 40)}`;
  const tasks = await reserveAgentTasks(
    config,
    input,
    callIdentity,
    scopeIdentity,
    joinPolicy,
    reductionPolicy,
  );
  const deadlineAt = new Date(Date.parse(tasks[0]!.createdAt) + deadlineMs).toISOString();
  const acceptedGroupRef = tasks[0]!.externalAgentGroupRef;
  if (acceptedGroupRef !== undefined && tasks.every((task, memberIndex) =>
    task.externalAgentGroupRef === acceptedGroupRef &&
    task.agentLaunchAcceptedAt === tasks[0]!.agentLaunchAcceptedAt &&
    task.externalAgentTaskRef !== undefined && task.externalAgentTaskRef.length > 0 &&
    task.agentMemberId === `member_${memberIndex + 1}` && task.agentMemberIndex === memberIndex)) {
    return {
      status: "started" as const,
      groupRef: acceptedGroupRef as HarnessExternalAgentGroupRef,
      members: tasks.map((task, index) => ({
        memberId: task.agentMemberId,
        memberIndex: task.agentMemberIndex,
        taskId: task.taskId,
        ...(input.members[index]?.name === undefined ? {} : { name: input.members[index]!.name }),
      })),
      joinPolicyHandle: joinPolicy.handle,
      reductionPolicyHandle: reductionPolicy.handle,
      deadlineAt,
    };
  }
  let started: HarnessStartAgentGroupResult;
  try {
    started = validateStarted(await config.agents.launcher.startAgentGroup(Object.freeze({
      protocolVersion: HARNESS_AGENT_GROUPS_PROTOCOL_VERSION,
      sessionId: config.sessionId,
      originTurnId: config.originTurnId,
      callIdentity,
      scopeIdentity,
      members: Object.freeze(input.members.map((member, memberIndex) => Object.freeze({
        memberId: `member_${memberIndex + 1}`,
        memberIndex,
        ...(member.name === undefined ? {} : { name: member.name }),
        ...(member.purpose === undefined ? {} : { purpose: member.purpose }),
        prompt: member.prompt,
        profile: profiles[memberIndex]!,
        harnessTaskId: tasks[memberIndex]!.taskId,
        callIdentity: tasks[memberIndex]!.callIdentity!,
      }))),
      joinPolicy,
      reductionPolicy,
      deadlineAt,
      onDeadline,
      ...(workspace === undefined ? {} : { workspace }),
      ...(config.abortSignal === undefined ? {} : { abortSignal: config.abortSignal }),
    })), tasks);
  } catch (error) {
    if (error instanceof HarnessAgentGroupLaunchRejectedError) {
      await terminalizeReservedLaunches(config.ledger, tasks, "Agent Group launch was atomically rejected.");
    }
    // Every other throw is response-loss/acceptance-indeterminate. Do not
    // manufacture failure: retrying this tool call supplies byte-identical
    // call/scope/member identities and the adapter must converge idempotently.
    throw error;
  }
  const startBinding = await requiredAgentGroupLedger(config.ledger).bindAgentGroupStart({
    sessionId: config.sessionId,
    scopeIdentity,
    groupRef: started.groupRef,
    acceptedAt: started.acceptedAt,
    launchCallIdentity: callIdentity,
    observationMode: agentObservationMode(config.agents),
    members: Object.freeze(tasks.map((task, index) => Object.freeze({
      taskId: task.taskId,
      memberId: task.agentMemberId!,
      memberIndex: task.agentMemberIndex!,
      taskRef: started.members[index]!.taskRef,
    }))),
  });
  if (startBinding.outcome !== "applied" && startBinding.outcome !== "replayed") {
    throw new HarnessInputError("Agent Group start could not be atomically bound to its Harness tasks.", {
      bindingOutcome: startBinding.outcome,
    });
  }
  const updatedTasks = startBinding.records;
  return {
    status: "started" as const,
    groupRef: started.groupRef,
    members: updatedTasks.map((task, index) => ({
      memberId: task.agentMemberId,
      memberIndex: task.agentMemberIndex,
      taskId: task.taskId,
      ...(input.members[index]?.name === undefined ? {} : { name: input.members[index]!.name }),
    })),
    joinPolicyHandle: joinPolicy.handle,
    reductionPolicyHandle: reductionPolicy.handle,
    deadlineAt,
  };
}

/**
 * The model's workspace ask, validated against this group: at most 64 rules,
 * POSIX path patterns, and `owner` naming one of this group's member ids.
 */
function workspaceAsk(
  config: Parameters<typeof createAgentGroupTools>[0],
  input: LaunchInput,
): HarnessAgentGroupWorkspaceAsk | undefined {
  if (input.from === undefined && input.mergePolicy === undefined) return undefined;
  if (config.agents.launcher.workspaces === undefined) {
    throw new HarnessInputError("This Agent Group launcher cannot fork or merge workspaces.");
  }
  if (input.from !== undefined && input.from !== "parent" && input.from !== "project") {
    throw new HarnessInputError("Agent Group from must be parent or project.");
  }
  const memberCount = input.members.length;
  let mergePolicies: readonly HarnessAgentGroupMergePolicy[] | undefined;
  if (input.mergePolicy !== undefined) {
    if (!Array.isArray(input.mergePolicy) || input.mergePolicy.length < 1 ||
        input.mergePolicy.length > MAX_MERGE_POLICIES) {
      throw new HarnessInputError(`Agent Group mergePolicy must hold 1 to ${MAX_MERGE_POLICIES} rules.`);
    }
    mergePolicies = Object.freeze(input.mergePolicy.map((rule: unknown, ruleIndex) => {
      if (rule === null || typeof rule !== "object" || Array.isArray(rule) ||
          Object.keys(rule).some((key) => key !== "glob" && key !== "policy" && key !== "owner")) {
        throw new HarnessInputError("Agent Group mergePolicy rule is invalid.", { ruleIndex });
      }
      const { glob, policy, owner } = rule as Partial<HarnessAgentGroupMergePolicy>;
      if (typeof glob !== "string" || glob.length === 0 || glob.trim() !== glob || hasControl(glob) ||
          hasInvalidUnicode(glob) || glob.includes("\\") || utf8Bytes(glob) > MAX_MERGE_GLOB_BYTES) {
        throw new HarnessInputError(
          "Agent Group mergePolicy glob must be a repository-relative path pattern of at most 512 bytes.",
          { ruleIndex },
        );
      }
      if (policy !== "three_way" && policy !== "collect" && policy !== "owner") {
        throw new HarnessInputError("Agent Group mergePolicy policy must be three_way, collect or owner.", { ruleIndex });
      }
      if (policy === "owner") {
        if (typeof owner !== "string" || memberOrdinal(owner) === undefined ||
            memberOrdinal(owner)! > memberCount) {
          throw new HarnessInputError(
            `An owner rule must name one of this group's members, member_1 to member_${memberCount}.`,
            { ruleIndex },
          );
        }
      } else if (owner !== undefined) {
        throw new HarnessInputError("Only an owner mergePolicy rule names a member.", { ruleIndex });
      }
      return Object.freeze({ glob, policy, ...(owner === undefined ? {} : { owner }) });
    }));
  }
  return Object.freeze({
    ...(input.from === undefined ? {} : { from: input.from }),
    ...(mergePolicies === undefined ? {} : { mergePolicies }),
  });
}

/** `member_N` → N, or `undefined` for anything else. */
function memberOrdinal(memberId: string): number | undefined {
  return MEMBER_ID.test(memberId) ? Number(memberId.slice("member_".length)) : undefined;
}

function isActiveGroup(status: HarnessAgentGroupStatus): boolean {
  return status === "queued" || status === "running";
}

/**
 * Reads how a group merged back from a launcher with workspaces. The read is
 * current, not part of the immutable join result: a resolver that merged a
 * kept member later shows on the next read.
 */
async function readWorkspace(
  config: Parameters<typeof createAgentGroupTools>[0],
  group: Readonly<{ groupRef: HarnessExternalAgentGroupRef; scopeIdentity: string }>,
  memberCount: number,
  executionOptions: unknown,
): Promise<Readonly<{ workspace?: HarnessAgentGroupWorkspace }>> {
  const workspaces = config.agents.launcher.workspaces;
  if (workspaces === undefined) return {};
  const value = await workspaces.read(Object.freeze({
    ...controlRequest(config, "read_agent_group_workspace", group, executionOptions),
    groupRef: group.groupRef,
  }));
  if (value === undefined) return {};
  return {
    workspace: validateWorkspace(
      value,
      memberCount,
      Math.min(MAX_WORKSPACE_BYTES, config.agents.limits.maxMemberPageBytes),
    ),
  };
}

function validateWorkspace(
  value: HarnessAgentGroupWorkspace,
  memberCount: number,
  maximumBytes: number,
): HarnessAgentGroupWorkspace {
  const invalid = () => new HarnessInputError("Agent launcher returned an invalid workspace outcome.");
  assertExactKeys(value, ["from", "reason", "members"], "workspace outcome");
  if (value.from !== "parent" && value.from !== "project") throw invalid();
  if (value.reason !== undefined) {
    if (value.from !== "project") throw invalid();
    boundedToken(value.reason, 128, "workspace reason");
  }
  if (!Array.isArray(value.members) || value.members.length < 1 || value.members.length > memberCount) {
    throw invalid();
  }
  const seen = new Set<string>();
  const members = value.members.map((member) => {
    assertExactKeys(member, ["memberId", "merge", "branch", "conflictPaths"], "workspace member");
    const ordinal = typeof member.memberId === "string" ? memberOrdinal(member.memberId) : undefined;
    if (ordinal === undefined || ordinal > memberCount || seen.has(member.memberId)) throw invalid();
    seen.add(member.memberId);
    if (member.merge !== "merged" && member.merge !== "resolved" && member.merge !== "branch") throw invalid();
    if (member.merge !== "branch") {
      if (member.branch !== undefined || member.conflictPaths !== undefined) throw invalid();
      return Object.freeze({ memberId: member.memberId, merge: member.merge });
    }
    if (typeof member.branch !== "string" || member.branch.length === 0 || hasControl(member.branch) ||
        hasInvalidUnicode(member.branch) || utf8Bytes(member.branch) > MAX_WORKSPACE_BRANCH_BYTES) {
      throw invalid();
    }
    if (member.conflictPaths !== undefined &&
        (!Array.isArray(member.conflictPaths) ||
          member.conflictPaths.length > MAX_WORKSPACE_CONFLICT_PATHS ||
          member.conflictPaths.some((path: unknown) =>
            typeof path !== "string" || path.length === 0 || hasControl(path) ||
            hasInvalidUnicode(path) || utf8Bytes(path) > MAX_WORKSPACE_PATH_BYTES))) {
      throw invalid();
    }
    return Object.freeze({
      memberId: member.memberId,
      merge: member.merge,
      branch: member.branch,
      ...(member.conflictPaths === undefined
        ? {}
        : { conflictPaths: Object.freeze([...member.conflictPaths]) }),
    });
  });
  const workspace = Object.freeze({
    from: value.from,
    ...(value.reason === undefined ? {} : { reason: value.reason }),
    members: Object.freeze(members),
  });
  if (utf8Bytes(canonicalJson(workspace)) > maximumBytes) {
    throw new HarnessInputError("Agent launcher returned a workspace outcome above its byte bound.");
  }
  return workspace;
}

async function reserveAgentTasks(
  config: Parameters<typeof createAgentGroupTools>[0],
  input: LaunchInput,
  callIdentity: string,
  scopeIdentity: string,
  joinPolicy: HarnessAgentJoinPolicyProfile,
  reductionPolicy: HarnessAgentReductionPolicy,
): Promise<readonly HarnessTaskRecord[]> {
  const reservationInputs = input.members.map((member, memberIndex) => {
    const memberId = `member_${memberIndex + 1}`;
    const memberCallIdentity = stableHash({ callIdentity, scopeIdentity, memberId, memberIndex });
    return {
      memberIndex,
      memberId,
      memberCallIdentity,
      member,
    };
  });
  const tasks = Object.freeze(reservationInputs.map((entry) => Object.freeze({
      kind: "agent",
      ...(entry.member.purpose === undefined ? {} : { purpose: entry.member.purpose }),
      callIdentity: entry.memberCallIdentity,
      agentMemberId: entry.memberId,
      agentMemberIndex: entry.memberIndex,
      agentGroupScopeIdentity: scopeIdentity,
      agentJoinPolicyHandle: joinPolicy.handle,
      agentJoinPolicyKind: joinPolicy.policy.kind,
      ...(joinPolicy.policy.kind === "quorum"
        ? { agentJoinQuorumCount: joinPolicy.policy.count }
        : {}),
      ...(joinPolicy.verifierHandle === undefined
        ? {}
        : { agentVerifierHandle: joinPolicy.verifierHandle }),
      ...(joinPolicy.requiredCheckSetHandle === undefined
        ? {}
        : { agentRequiredCheckSetHandle: joinPolicy.requiredCheckSetHandle }),
      agentReductionPolicyHandle: reductionPolicy.handle,
      agentMaxMemberSummaryBytes: reductionPolicy.maxMemberSummaryBytes,
      agentMaxGroupSummaryBytes: reductionPolicy.maxGroupSummaryBytes,
      agentMaxResultRefs: reductionPolicy.maxResultRefs,
  })));
  let reserved: readonly HarnessTaskRecord[] = Object.freeze([]);
  try {
    if (agentObservationMode(config.agents) === "paged_changes") {
      const batch = await requiredPagedAgentGroupLedger(config.ledger).reserveAgentGroupTaskBatch({
        sessionId: config.sessionId,
        callIdentity,
        scopeIdentity,
        canonicalInputDigest: stableHash({
          domain: "little-harness.agent-group-task-batch.v1",
          sessionId: config.sessionId,
          callIdentity,
          scopeIdentity,
          tasks,
        }),
        tasks,
      });
      if (batch.outcome !== "applied" && batch.outcome !== "replayed") {
        throw new HarnessInputError("Agent Group task batch reservation did not converge.", {
          reservationOutcome: batch.outcome,
        });
      }
      reserved = batch.records;
    } else {
      const settlements = await Promise.allSettled(tasks.map(async (task) =>
        config.ledger.reserveTask({ sessionId: config.sessionId, ...task })));
      reserved = Object.freeze(settlements.flatMap((settlement) =>
        settlement.status === "fulfilled" ? [settlement.value] : []));
      const failed = settlements.find((settlement) => settlement.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    }
    if (reserved.length !== reservationInputs.length) {
      throw new HarnessInputError("Agent Group batch reservation returned a partial ordered set.");
    }
    for (const [memberIndex, task] of reserved.entries()) {
      const { memberId, memberCallIdentity } = reservationInputs[memberIndex]!;
      if (task.kind !== "agent" || task.callIdentity !== memberCallIdentity ||
          task.agentMemberId !== memberId || task.agentMemberIndex !== memberIndex ||
          task.agentGroupScopeIdentity !== scopeIdentity ||
          task.agentJoinPolicyHandle !== joinPolicy.handle ||
          task.agentJoinPolicyKind !== joinPolicy.policy.kind ||
          task.agentJoinQuorumCount !== (joinPolicy.policy.kind === "quorum" ? joinPolicy.policy.count : undefined) ||
          task.agentVerifierHandle !== joinPolicy.verifierHandle ||
          task.agentRequiredCheckSetHandle !== joinPolicy.requiredCheckSetHandle ||
          task.agentReductionPolicyHandle !== reductionPolicy.handle ||
          task.agentMaxMemberSummaryBytes !== reductionPolicy.maxMemberSummaryBytes ||
          task.agentMaxGroupSummaryBytes !== reductionPolicy.maxGroupSummaryBytes ||
          task.agentMaxResultRefs !== reductionPolicy.maxResultRefs) {
        throw new HarnessInputError("Agent task replay identity does not match its reservation.");
      }
    }
    if (reserved.some(isTerminalTask)) {
      await terminalizeReservedLaunches(
        config.ledger,
        reserved,
        "Agent Group reservation was already terminalized and cannot be relaunched.",
      );
      throw new HarnessAgentGroupLaunchRejectedError(
        "Agent Group launch identity was already terminalized.",
      );
    }
    return Object.freeze(reserved);
  } catch (error) {
    await terminalizeReservedLaunches(
      config.ledger,
      reserved,
      "Agent Group reservation failed before the complete ordered set was reserved.",
    );
    throw error;
  }
}

async function terminalizeReservedLaunches(
  ledger: HarnessTaskLedger,
  tasks: readonly HarnessTaskRecord[],
  message: string,
): Promise<void> {
  await Promise.all(tasks.map(async (task) => {
    if (isTerminalTask(task)) return;
    await ledger.updateTaskTerminal({
      sessionId: task.sessionId,
      taskId: task.taskId,
      status: "failed",
      terminalCauseCode: "launch_corruption",
      terminalMessage: message,
      terminalDiagnostic: { agentGroupLaunchFailed: true },
      error: "agent_group_launch_failed",
    });
  }));
}

type OwnedGroup = Readonly<{
  groupRef: HarnessExternalAgentGroupRef;
  scopeIdentity: string;
  tasks: readonly HarnessTaskRecord[];
  reduction: HarnessAgentReductionPolicy;
  joinPolicy: HarnessAgentJoinPolicyProfile;
}>;

type OwnedPagedGroup = Readonly<{
  groupRef: HarnessExternalAgentGroupRef;
  scopeIdentity: string;
  state: HarnessAgentGroupPageState;
  reduction: HarnessAgentReductionPolicy;
  joinPolicy: HarnessAgentJoinPolicyProfile;
}>;

async function ownedGroup(
  config: Parameters<typeof createAgentGroupTools>[0],
  requestedRef: string,
): Promise<OwnedGroup> {
  validOpaqueRef(requestedRef, "groupRef");
  const tasks = (await config.ledger.listTasks({ sessionId: config.sessionId }))
    .filter((task) => task.kind === "agent" && task.externalAgentGroupRef === requestedRef)
    .sort((left, right) => (left.agentMemberIndex ?? -1) - (right.agentMemberIndex ?? -1));
  if (tasks.length === 0) throw new HarnessInputError("Agent Group is not owned by this session.");
  const first = tasks[0]!;
  const scopeIdentity = first.agentGroupScopeIdentity;
  if (scopeIdentity === undefined || tasks.some((task, index) =>
    task.agentGroupScopeIdentity !== scopeIdentity || task.agentMemberIndex !== index ||
    task.agentMemberId !== `member_${index + 1}` || task.externalAgentTaskRef === undefined ||
    task.agentLaunchAcceptedAt !== first.agentLaunchAcceptedAt ||
    task.agentJoinPolicyHandle !== first.agentJoinPolicyHandle ||
    task.agentJoinPolicyKind !== first.agentJoinPolicyKind ||
    task.agentJoinQuorumCount !== first.agentJoinQuorumCount ||
    task.agentVerifierHandle !== first.agentVerifierHandle ||
    task.agentRequiredCheckSetHandle !== first.agentRequiredCheckSetHandle ||
    task.agentReductionPolicyHandle !== first.agentReductionPolicyHandle ||
    task.agentGroupRevision !== first.agentGroupRevision ||
    task.agentGroupStatus !== first.agentGroupStatus ||
    task.agentGroupObservationDigest !== first.agentGroupObservationDigest ||
    task.agentGroupObservedAt !== first.agentGroupObservedAt ||
    task.agentJoinReductionRevision !== first.agentJoinReductionRevision ||
    task.agentJoinReductionDigest !== first.agentJoinReductionDigest ||
    task.agentMaxMemberSummaryBytes !== first.agentMaxMemberSummaryBytes ||
    task.agentMaxGroupSummaryBytes !== first.agentMaxGroupSummaryBytes ||
    task.agentMaxResultRefs !== first.agentMaxResultRefs)) {
    throw new HarnessInputError("Agent Group task projection is inconsistent.");
  }
  if (first.agentGroupRevision === undefined || !Number.isSafeInteger(first.agentGroupRevision) ||
      first.agentGroupRevision < 0 || first.agentGroupStatus === undefined ||
      !groupStatus(first.agentGroupStatus) || first.agentGroupObservationDigest === undefined ||
      first.agentGroupObservedAt === undefined) {
    throw new HarnessInputError("Agent Group revision projection is missing or invalid.");
  }
  if (first.agentLaunchAcceptedAt === undefined) {
    throw new HarnessInputError("Agent Group atomic start binding is missing.");
  }
  validTimestamp(first.agentLaunchAcceptedAt, "stored launch acceptedAt");
  boundedToken(first.agentGroupObservationDigest, 128, "stored group observation digest");
  validTimestamp(first.agentGroupObservedAt, "stored group observedAt");
  for (const task of tasks) {
    if (task.agentMemberRevision === undefined || !Number.isSafeInteger(task.agentMemberRevision) ||
        task.agentMemberRevision < 0 || task.agentMemberObservationDigest === undefined ||
        task.agentMemberStateDigest === undefined || task.agentMemberObservedAt === undefined) {
      throw new HarnessInputError("Agent Group member revision projection is missing or invalid.");
    }
    boundedToken(task.agentMemberObservationDigest, 128, "stored member observation digest");
    boundedToken(task.agentMemberStateDigest, 128, "stored member state digest");
    validTimestamp(task.agentMemberObservedAt, "stored member observedAt");
  }
  const joinPolicy = storedJoinPolicy(first);
  if (joinPolicy.policy.kind === "quorum" && joinPolicy.policy.count > tasks.length) {
    throw new HarnessInputError("Agent Group stored quorum exceeds its immutable member count.");
  }
  return Object.freeze({
    groupRef: asGroupRef(requestedRef),
    scopeIdentity,
    tasks: Object.freeze(tasks),
    joinPolicy,
    reduction: storedReductionPolicy(first),
  });
}

async function ownedPagedGroup(
  config: Parameters<typeof createAgentGroupTools>[0],
  requestedRef: string,
): Promise<OwnedPagedGroup> {
  validOpaqueRef(requestedRef, "groupRef");
  const state = await requiredPagedAgentGroupLedger(config.ledger).getAgentGroupPageState({
    sessionId: config.sessionId,
    groupRef: requestedRef,
  });
  if (state === undefined || state.sessionId !== config.sessionId || state.groupRef !== requestedRef ||
      state.memberCount < 1 || state.memberCount > config.agents.limits.maxMembers ||
      !Number.isSafeInteger(state.aggregateVersion) || state.aggregateVersion < 0 ||
      !groupStatus(state.groupStatus)) {
    throw new HarnessInputError("Agent Group is not owned by this session or its page authority is invalid.");
  }
  validTimestamp(state.launchAcceptedAt, "stored launch acceptedAt");
  validTimestamp(state.groupObservedAt, "stored group observedAt");
  boundedToken(state.groupObservationDigest, 128, "stored group observation digest");
  const joinPolicy = storedPagedJoinPolicy(state);
  if (joinPolicy.policy.kind === "quorum" && joinPolicy.policy.count > state.memberCount) {
    throw new HarnessInputError("Agent Group stored quorum exceeds its immutable member count.");
  }
  validateAggregate(state.aggregate, state.memberCount, "stored aggregate");
  return Object.freeze({
    groupRef: asGroupRef(requestedRef),
    scopeIdentity: state.scopeIdentity,
    state,
    joinPolicy,
    reduction: storedPagedReductionPolicy(state),
  });
}

function storedPagedReductionPolicy(state: HarnessAgentGroupPageState): HarnessAgentReductionPolicy {
  return Object.freeze({
    handle: declaredHandle(state.agentReductionPolicyHandle, "stored reduction policy"),
    maxMemberSummaryBytes: boundedInteger(
      state.agentMaxMemberSummaryBytes,
      0,
      1_048_576,
      "stored maxMemberSummaryBytes",
    ),
    maxGroupSummaryBytes: boundedInteger(
      state.agentMaxGroupSummaryBytes,
      0,
      1_048_576,
      "stored maxGroupSummaryBytes",
    ),
    maxResultRefs: boundedInteger(state.agentMaxResultRefs, 0, 10_000, "stored maxResultRefs"),
  });
}

function storedPagedJoinPolicy(state: HarnessAgentGroupPageState): HarnessAgentJoinPolicyProfile {
  const handle = declaredHandle(state.agentJoinPolicyHandle, "stored join policy");
  const kind = state.agentJoinPolicyKind;
  if (kind === "quorum") {
    return Object.freeze({
      handle,
      policy: Object.freeze({
        kind,
        count: boundedInteger(state.agentJoinQuorumCount ?? -1, 1, 10_000, "stored quorum"),
      }),
    });
  }
  if (kind === "first_verified") {
    return Object.freeze({
      handle,
      policy: Object.freeze({ kind }),
      verifierHandle: declaredHandle(state.agentVerifierHandle ?? "", "stored verifier"),
      requiredCheckSetHandle: declaredHandle(
        state.agentRequiredCheckSetHandle ?? "",
        "stored required check set",
      ),
    });
  }
  if (kind !== "all_success" && kind !== "all_terminal" && kind !== "any_success") {
    throw new HarnessInputError("Agent Group stored join policy is invalid.");
  }
  return Object.freeze({ handle, policy: Object.freeze({ kind }) });
}

function storedReductionPolicy(task: HarnessTaskRecord): HarnessAgentReductionPolicy {
  const handle = task.agentReductionPolicyHandle;
  if (handle === undefined || !HANDLE.test(handle)) {
    throw new HarnessInputError("Agent Group reduction-policy projection is missing or invalid.");
  }
  return Object.freeze({
    handle,
    maxMemberSummaryBytes: boundedInteger(
      task.agentMaxMemberSummaryBytes ?? -1,
      0,
      1_048_576,
      "stored maxMemberSummaryBytes",
    ),
    maxGroupSummaryBytes: boundedInteger(
      task.agentMaxGroupSummaryBytes ?? -1,
      0,
      1_048_576,
      "stored maxGroupSummaryBytes",
    ),
    maxResultRefs: boundedInteger(
      task.agentMaxResultRefs ?? -1,
      0,
      10_000,
      "stored maxResultRefs",
    ),
  });
}

function storedJoinPolicy(task: HarnessTaskRecord): HarnessAgentJoinPolicyProfile {
  const handle = task.agentJoinPolicyHandle;
  const kind = task.agentJoinPolicyKind;
  if (handle === undefined || !HANDLE.test(handle) || kind === undefined) {
    throw new HarnessInputError("Agent Group join-policy projection is missing or invalid.");
  }
  if (kind === "quorum") {
    const count = task.agentJoinQuorumCount;
    if (count === undefined || !Number.isSafeInteger(count) || count < 1) {
      throw new HarnessInputError("Agent Group quorum projection is missing or invalid.");
    }
    if (task.agentVerifierHandle !== undefined || task.agentRequiredCheckSetHandle !== undefined) {
      throw new HarnessInputError("Agent Group quorum projection contains an invalid verifier binding.");
    }
    return Object.freeze({ handle, policy: Object.freeze({ kind, count }) });
  }
  if (kind === "first_verified") {
    const verifierHandle = task.agentVerifierHandle;
    const requiredCheckSetHandle = task.agentRequiredCheckSetHandle;
    if (verifierHandle === undefined || requiredCheckSetHandle === undefined ||
        !HANDLE.test(verifierHandle) || !HANDLE.test(requiredCheckSetHandle) ||
        task.agentJoinQuorumCount !== undefined) {
      throw new HarnessInputError("Agent Group verified join projection is missing its trusted binding.");
    }
    return Object.freeze({
      handle,
      policy: Object.freeze({ kind }),
      verifierHandle,
      requiredCheckSetHandle,
    });
  }
  if (kind !== "all_success" && kind !== "all_terminal" && kind !== "any_success") {
    throw new HarnessInputError("Agent Group join-policy projection is invalid.");
  }
  if (task.agentJoinQuorumCount !== undefined || task.agentVerifierHandle !== undefined ||
      task.agentRequiredCheckSetHandle !== undefined) {
    throw new HarnessInputError("Agent Group join-policy projection contains an invalid binding.");
  }
  return Object.freeze({ handle, policy: Object.freeze({ kind }) });
}

function controlRequest(
  config: Parameters<typeof createAgentGroupTools>[0],
  handle: string,
  group: Readonly<{ groupRef: HarnessExternalAgentGroupRef; scopeIdentity: string }>,
  executionOptions: unknown,
) {
  const execution = requiredExecutionIdentity(executionOptions);
  return {
    protocolVersion: HARNESS_AGENT_GROUPS_PROTOCOL_VERSION,
    sessionId: config.sessionId,
    originTurnId: config.originTurnId,
    callIdentity: `agc_${stableHash({
      domain: "little-harness.agent-group-control-call.v1",
      sessionId: config.sessionId,
      originTurnId: config.originTurnId,
      handle,
      groupRef: group.groupRef,
      toolCallId: execution.toolCallId,
      modelStepId: execution.modelStepId,
      sequenceIndex: execution.sequenceIndex,
    }, { format: "base32hex" }).slice(0, 40)}`,
    scopeIdentity: group.scopeIdentity,
    ...(config.abortSignal === undefined ? {} : { abortSignal: config.abortSignal }),
  };
}

async function pageRequest(
  config: Parameters<typeof createAgentGroupTools>[0],
  group: OwnedPagedGroup,
  handle: string,
  operationKind: "watch" | "join" | "cancel",
  executionOptions: unknown,
  input: Readonly<{ pageCursor?: string; afterSequence?: number; pageSize?: number }>,
  mutation: Readonly<Record<string, unknown>> = Object.freeze({}),
): Promise<Readonly<{
  request: HarnessAgentGroupPageRequest;
  callIdentity: string;
  mutationInputDigest: string;
}>> {
  if ((input.pageCursor === undefined) !== (input.afterSequence === undefined) ||
      (input.afterSequence !== undefined &&
        (!Number.isSafeInteger(input.afterSequence) || input.afterSequence < 0))) {
    throw new HarnessInputError(
      "Agent Group pagination requires pageCursor and afterSequence together; a cursorless read opens at the durable high-water mark.",
    );
  }
  const pageCursor = input.pageCursor === undefined
    ? undefined
    : validCursor(input.pageCursor, config.agents.limits.maxMemberCursorBytes, "pageCursor");
  const maximumChanges = input.pageSize ?? config.agents.limits.maxMemberPageChanges;
  const base = controlRequest(config, handle, group, executionOptions);
  const requestIdempotencyKey = `agp_${stableHash({
    domain: "little-harness.agent-group-page-request.v2",
    callIdentity: base.callIdentity,
  }, { format: "base32hex" }).slice(0, 40)}`;
  const pageCursorDigest = pageCursor === undefined ? undefined : stableHash(pageCursor);
  const mutationInputDigest = stableHash({
    domain: "little-harness.agent-group-operation-input.v1",
    operationKind,
    groupRef: group.groupRef,
    mutation,
  });
  const canonicalInputDigest = stableHash({
    domain: "little-harness.agent-group-page-call-input.v2",
    callIdentity: base.callIdentity,
    operationKind,
    groupRef: group.groupRef,
    ...(input.afterSequence === undefined ? {} : { requestedAfterSequence: input.afterSequence }),
    ...(pageCursorDigest === undefined ? {} : { pageCursorDigest }),
    maximumChanges,
    maximumBytes: config.agents.limits.maxMemberPageBytes,
    maximumCursorBytes: config.agents.limits.maxMemberCursorBytes,
    mutationInputDigest,
  });
  const binding = await requiredPagedAgentGroupLedger(config.ledger).bindAgentGroupPageCall({
    sessionId: config.sessionId,
    scopeIdentity: group.scopeIdentity,
    groupRef: group.groupRef,
    callIdentity: base.callIdentity,
    operationKind,
    canonicalInputDigest,
    requestIdempotencyKey,
    ...(input.afterSequence === undefined ? {} : { requestedAfterSequence: input.afterSequence }),
    ...(pageCursorDigest === undefined ? {} : { pageCursorDigest }),
    maximumChanges,
    maximumBytes: config.agents.limits.maxMemberPageBytes,
    maximumCursorBytes: config.agents.limits.maxMemberCursorBytes,
  });
  if (binding.outcome === "expired") {
    throw new HarnessAgentGroupCursorError(
      "expired",
      `Agent Group cursor is older than retained sequence ${binding.minimumRetainedSequence}.`,
    );
  }
  if (binding.outcome === "exhausted") {
    throw new HarnessAgentGroupPageCallLimitError(HARNESS_AGENT_GROUP_MAX_LIFETIME_PAGE_CALLS);
  }
  if (binding.outcome !== "applied" && binding.outcome !== "replayed") {
    throw new HarnessInputError("Agent Group page call could not be bound before launcher invocation.", {
      bindingOutcome: binding.outcome,
    });
  }
  const request = Object.freeze({
    ...base,
    protocolVersion: HARNESS_AGENT_GROUP_PAGES_PROTOCOL_VERSION,
    requestIdempotencyKey: binding.requestIdempotencyKey,
    groupRef: group.groupRef,
    afterSequence: binding.startSequence,
    ...(pageCursor === undefined ? {} : { pageCursor }),
    maximumChanges,
    maximumBytes: config.agents.limits.maxMemberPageBytes,
    maximumCursorBytes: config.agents.limits.maxMemberCursorBytes,
  });
  return Object.freeze({ request, callIdentity: base.callIdentity, mutationInputDigest });
}

function operationKey(
  kind: "join" | "cancel",
  callIdentity: string,
  groupRef: HarnessExternalAgentGroupRef,
  mutation: Readonly<Record<string, unknown>>,
): string {
  return `ago_${stableHash({
    domain: "little-harness.agent-group-operation.v1",
    kind,
    callIdentity,
    groupRef,
    mutation,
  }, { format: "base32hex" }).slice(0, 40)}`;
}

function validateStarted(
  value: HarnessStartAgentGroupResult,
  tasks: readonly HarnessTaskRecord[],
): HarnessStartAgentGroupResult {
  assertExactKeys(value, ["groupRef", "members", "acceptedAt"], "start result");
  const groupRef = asGroupRef(validOpaqueRef(value.groupRef, "groupRef"));
  validTimestamp(value.acceptedAt, "acceptedAt");
  if (tasks.some((task) => value.acceptedAt < task.createdAt)) {
    throw new HarnessInputError("Agent launcher acceptedAt predates its Harness reservation.");
  }
  if (!Array.isArray(value.members) || value.members.length !== tasks.length) {
    throw new HarnessInputError("Agent launcher returned a partial atomic start result.");
  }
  const seen = new Set<string>();
  const members = Object.freeze(value.members.map((member, index) => {
    assertExactKeys(member, ["memberId", "memberIndex", "taskRef"], "started member");
    const taskRef = asTaskRef(validOpaqueRef(member.taskRef, "taskRef"));
    if (seen.has(taskRef) || member.memberId !== `member_${index + 1}` || member.memberIndex !== index) {
      throw new HarnessInputError("Agent launcher changed ordered member identity.");
    }
    seen.add(taskRef);
    return Object.freeze({ memberId: member.memberId, memberIndex: index, taskRef });
  }));
  return Object.freeze({ groupRef, members, acceptedAt: value.acceptedAt });
}

function validateObservation(
  value: HarnessWatchAgentGroupResult,
  group: OwnedGroup,
  operation: string,
  additionalKeys: readonly string[] = [],
): HarnessWatchAgentGroupResult {
  assertExactKeys(
    value,
    ["groupRef", "groupRevision", "status", "members", "observedAt", ...additionalKeys],
    `${operation} result`,
  );
  if (validOpaqueRef(value.groupRef, "groupRef") !== group.groupRef || !groupStatus(value.status)) {
    throw new HarnessInputError(`Agent launcher ${operation} result changed group identity or status.`);
  }
  validRevision(value.groupRevision, "groupRevision");
  validTimestamp(value.observedAt, "observedAt");
  const members = validateMembers(value.members, group);
  if (value.status === "satisfied") assertJoinPolicySatisfied(group.joinPolicy.policy, members);
  return Object.freeze({
    groupRef: group.groupRef,
    groupRevision: value.groupRevision,
    status: value.status,
    members,
    observedAt: value.observedAt,
  });
}

function validateJoin(value: HarnessJoinAgentGroupResult, group: OwnedGroup): HarnessJoinAgentGroupResult {
  const observed = validateObservation(
    value,
    group,
    "join",
    ["disposition", "summary", "resultRefs"],
  );
  if (value.disposition !== "satisfied" && value.disposition !== "deadline" && value.disposition !== "terminal") {
    throw new HarnessInputError("Agent launcher returned an invalid join disposition.");
  }
  if ((value.disposition === "satisfied") !== (observed.status === "satisfied")) {
    throw new HarnessInputError("Agent launcher returned inconsistent join satisfaction state.");
  }
  const summary = value.summary === undefined
    ? undefined
    : boundedText(value.summary, group.reduction.maxGroupSummaryBytes, "group summary");
  if (!Array.isArray(value.resultRefs) || value.resultRefs.length > group.reduction.maxResultRefs) {
    throw new HarnessInputError("Agent launcher exceeded the result-reference bound.");
  }
  const resultRefs = Object.freeze(value.resultRefs.map((ref) => asResultRef(validOpaqueRef(ref, "resultRef"))));
  if (new Set(resultRefs).size !== resultRefs.length) {
    throw new HarnessInputError("Agent launcher returned duplicate result references.");
  }
  const memberResultRefs = new Set(observed.members.flatMap((member) =>
    member.resultRef === undefined ? [] : [member.resultRef]));
  if (resultRefs.some((ref) => !memberResultRefs.has(ref))) {
    throw new HarnessInputError("Agent join result referenced output outside its ordered members.");
  }
  const allMembersTerminal = observed.members.every((member) =>
    member.status !== "queued" && member.status !== "running");
  if (value.disposition === "terminal" &&
      (!allMembersTerminal || observed.status === "queued" || observed.status === "running" ||
        observed.status === "satisfied")) {
    throw new HarnessInputError("Agent launcher returned terminal before the group was terminal.");
  }
  if (value.disposition === "deadline" &&
      (allMembersTerminal || observed.status === "satisfied" || observed.status === "failed" ||
        observed.status === "cancelled")) {
    throw new HarnessInputError("Agent launcher returned deadline for a terminal Agent Group snapshot.");
  }
  return Object.freeze({
    ...observed,
    disposition: value.disposition,
    ...(summary === undefined ? {} : { summary }),
    resultRefs,
  });
}

function validateCancel(
  value: HarnessCancelAgentGroupResult,
  group: OwnedGroup,
): HarnessCancelAgentGroupResult {
  assertExactKeys(
    value,
    ["groupRef", "groupRevision", "status", "disposition", "members", "cancelledAt"],
    "cancel result",
  );
  if (validOpaqueRef(value.groupRef, "groupRef") !== group.groupRef ||
      !groupStatus(value.status) ||
      (value.disposition !== "cancelled" && value.disposition !== "already_terminal") ||
      (value.disposition === "cancelled" && value.status !== "cancelled") ||
      (value.disposition === "already_terminal" &&
        (value.status === "queued" || value.status === "running"))) {
    throw new HarnessInputError("Agent launcher cancel result changed group identity or status.");
  }
  validRevision(value.groupRevision, "groupRevision");
  validTimestamp(value.cancelledAt, "cancelledAt");
  const members = validateMembers(value.members, group);
  if (value.status === "satisfied") assertJoinPolicySatisfied(group.joinPolicy.policy, members);
  return Object.freeze({
    groupRef: group.groupRef,
    groupRevision: value.groupRevision,
    status: value.status,
    disposition: value.disposition,
    members,
    cancelledAt: value.cancelledAt,
  });
}

function validatePagedObservation(
  value: HarnessWatchAgentGroupPageResult,
  group: OwnedPagedGroup,
  request: HarnessAgentGroupPageRequest,
  operation: string,
  additionalKeys: readonly string[] = [],
): HarnessWatchAgentGroupPageResult {
  assertExactKeys(
    value,
    ["groupRef", "aggregateVersion", "status", "aggregate", "memberPage", "observedAt", ...additionalKeys],
    `${operation} page result`,
  );
  if (validOpaqueRef(value.groupRef, "groupRef") !== group.groupRef || !groupStatus(value.status) ||
      !Number.isSafeInteger(value.aggregateVersion) || value.aggregateVersion < 0) {
    throw new HarnessInputError(`Agent launcher ${operation} page changed group identity or status.`);
  }
  validTimestamp(value.observedAt, "observedAt");
  if (value.observedAt < group.state.launchAcceptedAt) {
    throw new HarnessInputError("Agent launcher page observation predates the atomic launch.");
  }
  const aggregate = validateAggregate(value.aggregate, group.state.memberCount, `${operation} aggregate`);
  const memberPage = validateMemberChangePage(value.memberPage, group, request);
  if (value.aggregateVersion !== memberPage.throughSequence) {
    throw new HarnessInputError("Agent launcher aggregate version does not fence its member-change page.");
  }
  if (value.status === "satisfied") assertAggregateJoinPolicySatisfied(group.joinPolicy.policy, aggregate);
  const safe = Object.freeze({
    groupRef: group.groupRef,
    aggregateVersion: value.aggregateVersion,
    status: value.status,
    aggregate,
    memberPage,
    observedAt: value.observedAt,
  });
  assertPagedEnvelopeBytes(safe, request, `${operation} page result`);
  return safe;
}

function validateMemberChangePage(
  value: HarnessAgentGroupMemberChangePage,
  group: OwnedPagedGroup,
  request: HarnessAgentGroupPageRequest,
): HarnessAgentGroupMemberChangePage {
  assertExactKeys(value, [
    "requestIdempotencyKey",
    "afterSequence",
    "throughSequence",
    "nextPageCursor",
    "hasMore",
    "changes",
    "pageDigest",
  ], "member-change page");
  if (value.requestIdempotencyKey !== request.requestIdempotencyKey ||
      value.afterSequence !== request.afterSequence ||
      !Number.isSafeInteger(value.throughSequence) || value.throughSequence < value.afterSequence ||
      typeof value.hasMore !== "boolean" || !Array.isArray(value.changes) ||
      value.changes.length > request.maximumChanges ||
      value.throughSequence !== value.afterSequence + value.changes.length ||
      (value.hasMore && value.changes.length === 0)) {
    throw new HarnessInputError("Agent launcher returned a non-contiguous or mismatched member-change page.");
  }
  const nextPageCursor = validCursor(
    value.nextPageCursor,
    request.maximumCursorBytes,
    "nextPageCursor",
  );
  const resultRefsByMember = new Map<string, number>();
  const changes = Object.freeze(value.changes.map((change, offset) => {
    if (change.sequence !== value.afterSequence + offset + 1) {
      throw new HarnessInputError("Agent launcher returned a gap or duplicate in Agent Group change sequence.");
    }
    if ("kind" in change && change.kind === "group_control") {
      assertExactKeys(change, ["sequence", "kind", "status", "observedAt", "controlDigest"], "group control change");
      if (!groupStatus(change.status)) {
        throw new HarnessInputError("Agent launcher returned an invalid group control status.");
      }
      validTimestamp(change.observedAt, "group control observedAt");
      if (change.observedAt < group.state.launchAcceptedAt) {
        throw new HarnessInputError("Agent launcher group control predates the atomic launch.");
      }
      const body = Object.freeze({
        sequence: change.sequence,
        kind: "group_control" as const,
        status: change.status,
        observedAt: change.observedAt,
      });
      const controlDigest = boundedToken(change.controlDigest, 128, "controlDigest");
      if (controlDigest !== stableHash(body)) {
        throw new HarnessInputError("Agent launcher returned an invalid group control digest.");
      }
      return Object.freeze({ ...body, controlDigest });
    }
    assertExactKeys(
      change,
      "kind" in change ? ["sequence", "kind", "member"] : ["sequence", "member"],
      "member change",
    );
    if ("kind" in change && change.kind !== "member") {
      throw new HarnessInputError("Agent launcher returned an unknown Agent Group change kind.");
    }
    const member = validatePagedMember(change.member, group);
    if (member.resultRef !== undefined) {
      const owner = resultRefsByMember.get(member.resultRef);
      if (owner !== undefined && owner !== member.memberIndex) {
        throw new HarnessInputError("Agent launcher reused one result reference for different members.");
      }
      resultRefsByMember.set(member.resultRef, member.memberIndex);
    }
    return "kind" in change
      ? Object.freeze({ sequence: change.sequence, kind: "member" as const, member })
      : Object.freeze({ sequence: change.sequence, member });
  }));
  const body = Object.freeze({
    requestIdempotencyKey: value.requestIdempotencyKey,
    afterSequence: value.afterSequence,
    throughSequence: value.throughSequence,
    nextPageCursor,
    hasMore: value.hasMore,
    changes,
  });
  const pageDigest = boundedToken(value.pageDigest, 128, "pageDigest");
  if (pageDigest !== stableHash(body)) {
    throw new HarnessInputError("Agent launcher returned an invalid member-change page digest.");
  }
  if (utf8Bytes(canonicalJson(body)) > request.maximumBytes) {
    throw new HarnessInputError("Agent launcher exceeded the canonical member-change page byte bound.");
  }
  return Object.freeze({ ...body, pageDigest });
}

function validatePagedMember(
  member: HarnessAgentMemberObservation,
  group: OwnedPagedGroup,
): HarnessAgentMemberObservation {
  assertExactKeys(member, [
    "memberId",
    "memberIndex",
    "taskRef",
    "revision",
    "status",
    "verificationReceipt",
    "summary",
    "resultRef",
    "failureCode",
    "updatedAt",
  ], "paged member observation");
  if (!Number.isSafeInteger(member.memberIndex) || member.memberIndex < 0 ||
      member.memberIndex >= group.state.memberCount ||
      member.memberId !== `member_${member.memberIndex + 1}` || !memberStatus(member.status)) {
    throw new HarnessInputError("Agent launcher changed paged member identity or status.");
  }
  const taskRef = asTaskRef(validOpaqueRef(member.taskRef, "taskRef"));
  validRevision(member.revision, "member revision");
  validTimestamp(member.updatedAt, "updatedAt");
  if (member.updatedAt < group.state.launchAcceptedAt) {
    throw new HarnessInputError("Agent launcher member observation predates the atomic launch.");
  }
  let verificationReceipt: HarnessAgentMemberObservation["verificationReceipt"];
  if (member.verificationReceipt !== undefined) {
    const receipt = member.verificationReceipt;
    assertExactKeys(
      receipt,
      ["receiptRef", "verifierHandle", "requiredCheckSetHandle", "verifiedAt"],
      "verification receipt",
    );
    if (group.joinPolicy.policy.kind !== "first_verified" || member.status !== "succeeded" ||
        receipt.verifierHandle !== group.joinPolicy.verifierHandle ||
        receipt.requiredCheckSetHandle !== group.joinPolicy.requiredCheckSetHandle) {
      throw new HarnessInputError("Agent verification receipt is not bound to the trusted verifier policy.");
    }
    const receiptRef = validOpaqueRef(receipt.receiptRef, "verification receiptRef");
    validTimestamp(receipt.verifiedAt, "verifiedAt");
    if (receipt.verifiedAt < group.state.launchAcceptedAt || receipt.verifiedAt > member.updatedAt) {
      throw new HarnessInputError("Agent verification receipt timestamp is outside its member observation.");
    }
    verificationReceipt = Object.freeze({
      receiptRef,
      verifierHandle: receipt.verifierHandle,
      requiredCheckSetHandle: receipt.requiredCheckSetHandle,
      verifiedAt: receipt.verifiedAt,
    });
  } else if (group.joinPolicy.policy.kind !== "first_verified") {
    verificationReceipt = undefined;
  }
  const summary = member.summary === undefined
    ? undefined
    : boundedText(member.summary, group.reduction.maxMemberSummaryBytes, "member summary");
  const resultRef = member.resultRef === undefined
    ? undefined
    : asResultRef(validOpaqueRef(member.resultRef, "resultRef"));
  if (resultRef !== undefined && member.status === "queued" ||
      resultRef !== undefined && member.status === "running") {
    throw new HarnessInputError("Only a terminal Agent Group member may publish a result reference.");
  }
  const failureCode = member.failureCode === undefined
    ? undefined
    : boundedToken(member.failureCode, 128, "failureCode");
  if (failureCode !== undefined && (member.status === "queued" || member.status === "running")) {
    throw new HarnessInputError("Only a terminal Agent Group member may report a failure code.");
  }
  return Object.freeze({
    memberId: member.memberId,
    memberIndex: member.memberIndex,
    taskRef,
    revision: member.revision,
    status: member.status,
    ...(verificationReceipt === undefined ? {} : { verificationReceipt }),
    ...(summary === undefined ? {} : { summary }),
    ...(resultRef === undefined ? {} : { resultRef }),
    ...(failureCode === undefined ? {} : { failureCode }),
    updatedAt: member.updatedAt,
  });
}

function validateAggregate(
  value: HarnessAgentGroupAggregate,
  memberCount: number,
  label: string,
): HarnessAgentGroupAggregate {
  assertExactKeys(value, [
    "memberCount",
    "queuedCount",
    "runningCount",
    "succeededCount",
    "failedCount",
    "cancelledCount",
    "timedOutCount",
    "verifiedSucceededCount",
    "resultRefCount",
  ], label);
  const fields = [
    value.memberCount,
    value.queuedCount,
    value.runningCount,
    value.succeededCount,
    value.failedCount,
    value.cancelledCount,
    value.timedOutCount,
    value.verifiedSucceededCount,
    value.resultRefCount,
  ];
  if (fields.some((count) => !Number.isSafeInteger(count) || count < 0) ||
      value.memberCount !== memberCount ||
      value.queuedCount + value.runningCount + value.succeededCount + value.failedCount +
        value.cancelledCount + value.timedOutCount !== memberCount ||
      value.verifiedSucceededCount > value.succeededCount || value.resultRefCount > memberCount) {
    throw new HarnessInputError(`Agent launcher returned an invalid ${label}.`);
  }
  return Object.freeze({ ...value });
}

function validatePagedOperation(
  value: HarnessJoinAgentGroupPageResult,
  group: OwnedPagedGroup,
  request: HarnessAgentGroupPageRequest,
  kind: "join",
  expectedOperationRef?: string,
): HarnessJoinAgentGroupPageResult;
function validatePagedOperation(
  value: HarnessCancelAgentGroupPageResult,
  group: OwnedPagedGroup,
  request: HarnessAgentGroupPageRequest,
  kind: "cancel",
  expectedOperationRef?: string,
): HarnessCancelAgentGroupPageResult;
function validatePagedOperation(
  value: HarnessJoinAgentGroupPageResult | HarnessCancelAgentGroupPageResult,
  group: OwnedPagedGroup,
  request: HarnessAgentGroupPageRequest,
  kind: "join" | "cancel",
  expectedOperationRef?: string,
): HarnessJoinAgentGroupPageResult | HarnessCancelAgentGroupPageResult {
  const observed = validatePagedObservation(
    value,
    group,
    request,
    kind,
    ["operationResult"],
  );
  const operation = value.operationResult;
  assertExactKeys(operation, [
    "operationRef",
    "kind",
    "resultVersion",
    "disposition",
    "completedAt",
    "summary",
    "resultRefs",
    "resultDigest",
  ], `${kind} operation result`);
  const operationRef = validOpaqueRef(operation.operationRef, "operationRef");
  if (operation.kind !== kind ||
      (expectedOperationRef !== undefined && operationRef !== expectedOperationRef) ||
      !Number.isSafeInteger(operation.resultVersion) || operation.resultVersion < 0) {
    throw new HarnessInputError("Agent launcher changed paged operation identity or result version.");
  }
  validTimestamp(operation.completedAt, "completedAt");
  if (operation.completedAt < group.state.launchAcceptedAt) {
    throw new HarnessInputError("Agent launcher operation result predates the atomic launch.");
  }
  const summary = operation.summary === undefined
    ? undefined
    : boundedText(operation.summary, group.reduction.maxGroupSummaryBytes, "group summary");
  if (!Array.isArray(operation.resultRefs) ||
      operation.resultRefs.length > group.reduction.maxResultRefs) {
    throw new HarnessInputError("Agent launcher exceeded the paged operation result-reference bound.");
  }
  const resultRefs = Object.freeze(operation.resultRefs.map((ref) =>
    asResultRef(validOpaqueRef(ref, "resultRef"))));
  if (new Set(resultRefs).size !== resultRefs.length) {
    throw new HarnessInputError("Agent launcher returned duplicate result references.");
  }
  if (kind === "join" && operation.disposition !== "satisfied" &&
      operation.disposition !== "deadline" && operation.disposition !== "terminal" ||
      kind === "cancel" && operation.disposition !== "cancelled" &&
      operation.disposition !== "already_terminal" ||
      kind === "cancel" && (summary !== undefined || resultRefs.length !== 0)) {
    throw new HarnessInputError("Agent launcher returned an invalid paged operation disposition.");
  }
  const operationBody = Object.freeze({
    operationRef,
    kind,
    resultVersion: operation.resultVersion,
    disposition: operation.disposition,
    completedAt: operation.completedAt,
    ...(summary === undefined ? {} : { summary }),
    resultRefs,
  });
  const resultDigest = boundedToken(operation.resultDigest, 128, "resultDigest");
  if (resultDigest !== stableHash(operationBody)) {
    throw new HarnessInputError("Agent launcher returned an invalid operation-result digest.");
  }
  const operationResult = Object.freeze({ ...operationBody, resultDigest });
  if (observed.memberPage.throughSequence >= operation.resultVersion) {
    const allTerminal = observed.aggregate.queuedCount === 0 && observed.aggregate.runningCount === 0;
    if (kind === "join" && operation.disposition === "satisfied" && observed.status !== "satisfied" ||
        kind === "join" && operation.disposition === "terminal" &&
          (!allTerminal || observed.status === "satisfied") ||
        kind === "join" && operation.disposition === "deadline" &&
          (allTerminal || observed.status === "satisfied" || observed.status === "failed" ||
            observed.status === "cancelled") ||
        kind === "join" && resultRefs.length > observed.aggregate.resultRefCount ||
        kind === "cancel" && operation.disposition === "cancelled" &&
          observed.status !== "cancelled" ||
        kind === "cancel" && operation.disposition === "already_terminal" &&
          (observed.status === "queued" || observed.status === "running")) {
      throw new HarnessInputError("Agent launcher returned an inconsistent resolved operation state.");
    }
  }
  const safe = Object.freeze({
    ...observed,
    operationResult,
  });
  assertPagedEnvelopeBytes(safe, request, `${kind} page result`);
  return safe;
}

function validatePagedJoinPending(
  value: HarnessJoinAgentGroupPageCallResult,
  group: OwnedPagedGroup,
  request: HarnessAgentGroupPageRequest,
  expectedOperationRef?: string,
): HarnessJoinAgentGroupPendingPageResult {
  if (!("pendingOperation" in value) || "operationResult" in value) {
    throw new HarnessInputError(
      "Agent launcher returned an ambiguous pending join operation.",
    );
  }
  const observed = validatePagedObservation(
    value,
    group,
    request,
    "join",
    ["pendingOperation"],
  );
  const pending = value.pendingOperation;
  assertExactKeys(pending, [
    "operationRef",
    "observedAggregateVersion",
    "observedAt",
    "retryAfterMs",
    "pendingDigest",
  ], "join pending operation");
  const operationRef = validOpaqueRef(pending.operationRef, "operationRef");
  if (
    (expectedOperationRef !== undefined && operationRef !== expectedOperationRef) ||
    !Number.isSafeInteger(pending.observedAggregateVersion) ||
    pending.observedAggregateVersion < 0 ||
    pending.observedAggregateVersion > observed.aggregateVersion ||
    !Number.isSafeInteger(pending.retryAfterMs) ||
    pending.retryAfterMs < 1 ||
    pending.retryAfterMs > 60_000
  ) {
    throw new HarnessInputError(
      "Agent launcher returned an invalid pending join operation.",
    );
  }
  validTimestamp(pending.observedAt, "pending observedAt");
  if (pending.observedAt < group.state.launchAcceptedAt) {
    throw new HarnessInputError(
      "Agent launcher returned a pending join predating the atomic launch.",
    );
  }
  const body = Object.freeze({
    operationRef,
    observedAggregateVersion: pending.observedAggregateVersion,
    observedAt: pending.observedAt,
    retryAfterMs: pending.retryAfterMs,
  });
  const pendingDigest = boundedToken(
    pending.pendingDigest,
    128,
    "pendingDigest",
  );
  if (pendingDigest !== stableHash(body)) {
    throw new HarnessInputError(
      "Agent launcher returned an invalid pending-operation digest.",
    );
  }
  const safe = Object.freeze({
    ...observed,
    pendingOperation: Object.freeze({ ...body, pendingDigest }),
  });
  assertPagedEnvelopeBytes(safe, request, "join pending page result");
  return safe;
}

function assertPagedEnvelopeBytes(
  value: unknown,
  request: HarnessAgentGroupPageRequest,
  label: string,
): void {
  if (utf8Bytes(canonicalJson(value)) > request.maximumBytes) {
    throw new HarnessInputError(`Agent launcher exceeded the canonical ${label} byte bound.`);
  }
}

function assertAggregateJoinPolicySatisfied(
  policy: HarnessAgentJoinPolicy,
  aggregate: HarnessAgentGroupAggregate,
): void {
  const satisfied = policy.kind === "all_success"
    ? aggregate.succeededCount === aggregate.memberCount
    : policy.kind === "all_terminal"
      ? aggregate.queuedCount === 0 && aggregate.runningCount === 0
      : policy.kind === "any_success"
        ? aggregate.succeededCount > 0
        : policy.kind === "quorum"
          ? aggregate.succeededCount >= policy.count
          : aggregate.verifiedSucceededCount > 0;
  if (!satisfied) {
    throw new HarnessInputError("Agent launcher claimed aggregate satisfaction without meeting the join policy.");
  }
}

function validateMembers(
  members: readonly HarnessAgentMemberObservation[],
  group: OwnedGroup,
): readonly HarnessAgentMemberObservation[] {
  if (!Array.isArray(members) || members.length !== group.tasks.length) {
    throw new HarnessInputError("Agent launcher returned an incomplete member observation.");
  }
  const seenResultRefs = new Set<string>();
  return Object.freeze(members.map((member, index) => {
    assertExactKeys(member, [
      "memberId",
      "memberIndex",
      "taskRef",
      "revision",
      "status",
      "verificationReceipt",
      "summary",
      "resultRef",
      "failureCode",
      "updatedAt",
    ], "member observation");
    const task = group.tasks[index]!;
    if (member.memberIndex !== index || member.memberId !== task.agentMemberId ||
        validOpaqueRef(member.taskRef, "taskRef") !== task.externalAgentTaskRef ||
        !memberStatus(member.status)) {
      throw new HarnessInputError("Agent launcher changed ordered task identity or status.");
    }
    validRevision(member.revision, "member revision");
    validTimestamp(member.updatedAt, "updatedAt");
    const verificationReceipt = validateVerificationReceipt(member, task, group);
    const summary = member.summary === undefined
      ? undefined
      : boundedText(member.summary, group.reduction.maxMemberSummaryBytes, "member summary");
    const resultRef = member.resultRef === undefined
      ? undefined
      : asResultRef(validOpaqueRef(member.resultRef, "resultRef"));
    if (resultRef !== undefined && (member.status === "queued" || member.status === "running")) {
      throw new HarnessInputError("Only a terminal Agent Group member may publish a result reference.");
    }
    if (resultRef !== undefined && seenResultRefs.has(resultRef)) {
      throw new HarnessInputError("Agent launcher reused one result reference for multiple members.");
    }
    if (resultRef !== undefined) seenResultRefs.add(resultRef);
    const failureCode = member.failureCode === undefined
      ? undefined
      : boundedToken(member.failureCode, 128, "failureCode");
    if (failureCode !== undefined && (member.status === "queued" || member.status === "running")) {
      throw new HarnessInputError("Only a terminal Agent Group member may report a failure code.");
    }
    return Object.freeze({
      memberId: member.memberId,
      memberIndex: index,
      taskRef: asTaskRef(member.taskRef),
      revision: member.revision,
      status: member.status,
      ...(verificationReceipt === undefined ? {} : { verificationReceipt }),
      ...(summary === undefined ? {} : { summary }),
      ...(resultRef === undefined ? {} : { resultRef }),
      ...(failureCode === undefined ? {} : { failureCode }),
      updatedAt: member.updatedAt,
    });
  }));
}

function validateVerificationReceipt(
  member: HarnessAgentMemberObservation,
  task: HarnessTaskRecord,
  group: OwnedGroup,
): HarnessAgentMemberObservation["verificationReceipt"] {
  const receipt = member.verificationReceipt;
  if (group.joinPolicy.policy.kind !== "first_verified") {
    if (receipt !== undefined) {
      throw new HarnessInputError(
        "Agent verification receipts are accepted only under a trusted first_verified policy.",
      );
    }
    return undefined;
  }
  if (receipt === undefined) return undefined;
  assertExactKeys(
    receipt,
    ["receiptRef", "verifierHandle", "requiredCheckSetHandle", "verifiedAt"],
    "verification receipt",
  );
  if (member.status !== "succeeded" ||
      receipt.verifierHandle !== group.joinPolicy.verifierHandle ||
      receipt.requiredCheckSetHandle !== group.joinPolicy.requiredCheckSetHandle) {
    throw new HarnessInputError("Agent verification receipt is not bound to the trusted verifier policy.");
  }
  const receiptRef = validOpaqueRef(receipt.receiptRef, "verification receiptRef");
  validTimestamp(receipt.verifiedAt, "verifiedAt");
  if (receipt.verifiedAt < task.createdAt || receipt.verifiedAt > member.updatedAt) {
    throw new HarnessInputError("Agent verification receipt timestamp is outside its member observation.");
  }
  return Object.freeze({
    receiptRef,
    verifierHandle: receipt.verifierHandle,
    requiredCheckSetHandle: receipt.requiredCheckSetHandle,
    verifiedAt: receipt.verifiedAt,
  });
}

function assertJoinPolicySatisfied(
  policy: HarnessAgentJoinPolicy,
  members: readonly HarnessAgentMemberObservation[],
): void {
  const succeeded = members.filter((member) => member.status === "succeeded");
  const satisfied = policy.kind === "all_success"
    ? succeeded.length === members.length
    : policy.kind === "all_terminal"
      ? members.every((member) => member.status !== "queued" && member.status !== "running")
      : policy.kind === "any_success"
        ? succeeded.length > 0
        : policy.kind === "quorum"
          ? succeeded.length >= policy.count
          : succeeded.some((member) => member.verificationReceipt !== undefined);
  if (!satisfied) {
    throw new HarnessInputError("Agent launcher claimed satisfaction without meeting the trusted join policy.");
  }
}

async function projectObservations(
  ledger: HarnessTaskLedger,
  group: OwnedGroup,
  observation: HarnessWatchAgentGroupResult,
  joinReduction?: Readonly<{
    disposition: HarnessJoinAgentGroupResult["disposition"];
    summary?: string;
    resultRefs: readonly HarnessExternalAgentResultRef[];
  }>,
): Promise<void> {
  const projected = await requiredAgentGroupLedger(ledger).projectAgentGroupObservation({
    sessionId: group.tasks[0]!.sessionId,
    scopeIdentity: group.scopeIdentity,
    groupRevision: observation.groupRevision,
    groupStatus: observation.status,
    groupObservationDigest: stableHash({
      groupRef: observation.groupRef,
      groupRevision: observation.groupRevision,
      status: observation.status,
      members: observation.members,
      observedAt: observation.observedAt,
    }),
    groupObservedAt: observation.observedAt,
    ...(joinReduction === undefined
      ? {}
      : { joinReductionDigest: stableHash(joinReduction) }),
    members: Object.freeze(group.tasks.map((task, index) => {
      const observed = observation.members[index]!;
      const status = taskStatus(observed.status);
      const terminal = status === "completed" || status === "failed" || status === "cancelled";
      const terminalCauseCode = status === "cancelled"
        ? "cancelled" as const
        : observed.status === "timed_out"
          ? "timeout" as const
          : status === "failed"
            ? "workflow_failed" as const
            : undefined;
      return Object.freeze({
        taskId: task.taskId,
        memberRevision: observed.revision,
        memberObservationDigest: stableHash(observed),
        memberStateDigest: stableHash({
          status: observed.status,
          verificationReceipt: observed.verificationReceipt,
          summary: observed.summary,
          resultRef: observed.resultRef,
          failureCode: observed.failureCode,
        }),
        memberObservedAt: observed.updatedAt,
        status,
        ...(observed.summary === undefined ? {} : { outputSummary: observed.summary }),
        ...(observed.resultRef === undefined ? {} : { externalAgentResultRef: observed.resultRef }),
        ...(observed.failureCode === undefined ? {} : { error: observed.failureCode }),
        ...(terminal
          ? {
              ...(terminalCauseCode === undefined ? {} : { terminalCauseCode }),
              terminalMessage: terminalMessage(observed),
              terminalDiagnostic: {
                agentMemberTerminal: true,
                verified: observed.verificationReceipt !== undefined,
                hasExternalResultRef: observed.resultRef !== undefined,
              },
            }
          : {}),
      });
    })),
  });
  if (projected.outcome !== "applied" && projected.outcome !== "replayed") {
    const message = projected.outcome === "stale"
      ? "Agent launcher returned a stale Agent Group observation."
      : projected.outcome === "conflict"
        ? "Agent launcher reused an Agent Group revision with conflicting bytes."
        : projected.outcome === "invalid_transition"
          ? "Agent launcher returned an invalid Agent Group state transition."
          : "Agent Group observation projection is inconsistent with its reservations.";
    throw new HarnessInputError(message, { projectionOutcome: projected.outcome });
  }
}

async function projectPagedObservations(
  ledger: HarnessTaskLedger,
  group: OwnedPagedGroup,
  observation: HarnessWatchAgentGroupPageResult,
  pageCallIdentity: string,
): Promise<void> {
  const projected = await requiredPagedAgentGroupLedger(ledger).projectAgentGroupPage({
    sessionId: group.state.sessionId,
    scopeIdentity: group.scopeIdentity,
    groupRef: group.groupRef,
    requestIdempotencyKey: observation.memberPage.requestIdempotencyKey,
    pageDigest: observation.memberPage.pageDigest,
    afterSequence: observation.memberPage.afterSequence,
    throughSequence: observation.memberPage.throughSequence,
    aggregateVersion: observation.aggregateVersion,
    groupStatus: observation.status,
    aggregate: observation.aggregate,
    groupObservationDigest: stableHash({
      groupRef: observation.groupRef,
      aggregateVersion: observation.aggregateVersion,
      status: observation.status,
      aggregate: observation.aggregate,
      throughSequence: observation.memberPage.throughSequence,
      observedAt: observation.observedAt,
    }),
    groupObservedAt: observation.observedAt,
    pageCallIdentity,
    changes: Object.freeze(observation.memberPage.changes.map((change) => {
      if ("kind" in change && change.kind === "group_control") {
        return Object.freeze({
          sequence: change.sequence,
          kind: "group_control" as const,
          groupStatus: change.status,
          groupObservedAt: change.observedAt,
          controlDigest: change.controlDigest,
        });
      }
      const observed = change.member;
      const status = taskStatus(observed.status);
      const terminal = status === "completed" || status === "failed" || status === "cancelled";
      const terminalCauseCode = status === "cancelled"
        ? "cancelled" as const
        : observed.status === "timed_out"
          ? "timeout" as const
          : status === "failed"
            ? "workflow_failed" as const
            : undefined;
      return Object.freeze({
        sequence: change.sequence,
        ...("kind" in change && change.kind === "member" ? { kind: "member" as const } : {}),
        memberId: observed.memberId,
        memberIndex: observed.memberIndex,
        taskRef: observed.taskRef,
        memberStatus: observed.status,
        memberRevision: observed.revision,
        memberObservationDigest: stableHash(observed),
        memberStateDigest: stableHash({
          status: observed.status,
          verificationReceipt: observed.verificationReceipt,
          summary: observed.summary,
          resultRef: observed.resultRef,
          failureCode: observed.failureCode,
        }),
        memberObservedAt: observed.updatedAt,
        status,
        verifiedSucceeded: observed.status === "succeeded" &&
          observed.verificationReceipt !== undefined,
        hasResultRef: observed.resultRef !== undefined,
        ...(observed.summary === undefined ? {} : { outputSummary: observed.summary }),
        ...(observed.resultRef === undefined ? {} : { externalAgentResultRef: observed.resultRef }),
        ...(observed.failureCode === undefined ? {} : { error: observed.failureCode }),
        ...(terminal
          ? {
              ...(terminalCauseCode === undefined ? {} : { terminalCauseCode }),
              terminalMessage: terminalMessage(observed),
              terminalDiagnostic: {
                agentMemberTerminal: true,
                verified: observed.verificationReceipt !== undefined,
                hasExternalResultRef: observed.resultRef !== undefined,
              },
            }
          : {}),
      });
    })),
  });
  if (projected.outcome !== "applied" && projected.outcome !== "replayed") {
    const message = projected.outcome === "stale"
      ? "Agent launcher returned a stale member-change page."
      : projected.outcome === "conflict"
        ? "Agent launcher replayed a page identity with conflicting bytes."
        : projected.outcome === "invalid_transition"
          ? "Agent launcher returned an invalid paged Agent Group transition."
          : "Agent launcher returned a gap or inconsistent aggregate page.";
    throw new HarnessInputError(message, { projectionOutcome: projected.outcome });
  }
}

async function bindImmutableOperationResult(
  ledger: HarnessTaskLedger,
  group: OwnedPagedGroup,
  observation: HarnessJoinAgentGroupPageResult | HarnessCancelAgentGroupPageResult,
  operationIdempotencyKey: string,
  mutationInputDigest: string,
  operationMode: "begin" | "continue",
  authorizeVisibility: boolean,
  pageCallIdentity?: string,
  requestIdempotencyKey?: string,
): Promise<void> {
  const bound = await requiredPagedAgentGroupLedger(ledger).bindAgentGroupOperationResult({
    sessionId: group.state.sessionId,
    scopeIdentity: group.scopeIdentity,
    groupRef: group.groupRef,
    operationIdempotencyKey,
    mutationInputDigest,
    operationMode,
    authorizeVisibility,
    ...(pageCallIdentity === undefined ? {} : { pageCallIdentity }),
    ...(requestIdempotencyKey === undefined ? {} : { requestIdempotencyKey }),
    result: observation.operationResult,
  });
  if (bound.outcome !== "applied" && bound.outcome !== "replayed") {
    throw new HarnessInputError("Agent Group operation result did not converge to immutable authority.", {
      bindingOutcome: bound.outcome,
    });
  }
}

function presentObservation(value: HarnessWatchAgentGroupResult) {
  return {
    groupRef: value.groupRef,
    groupRevision: value.groupRevision,
    status: value.status,
    observedAt: value.observedAt,
    members: value.members.map(presentMember),
  };
}

function presentJoin(value: HarnessJoinAgentGroupResult) {
  return {
    ...presentObservation(value),
    disposition: value.disposition,
    ...(value.summary === undefined ? {} : { summary: value.summary }),
    resultRefs: value.resultRefs,
  };
}

function presentCancel(value: HarnessCancelAgentGroupResult) {
  return {
    groupRef: value.groupRef,
    groupRevision: value.groupRevision,
    status: value.status,
    disposition: value.disposition,
    cancelledAt: value.cancelledAt,
    members: value.members.map(presentMember),
  };
}

function presentPagedObservation(value: HarnessWatchAgentGroupPageResult) {
  return {
    groupRef: value.groupRef,
    aggregateVersion: value.aggregateVersion,
    status: value.status,
    aggregate: value.aggregate,
    observedAt: value.observedAt,
    memberPage: {
      afterSequence: value.memberPage.afterSequence,
      throughSequence: value.memberPage.throughSequence,
      nextPageCursor: value.memberPage.nextPageCursor,
      hasMore: value.memberPage.hasMore,
      changes: value.memberPage.changes.map((change) =>
        "kind" in change && change.kind === "group_control"
          ? {
              sequence: change.sequence,
              kind: change.kind,
              status: change.status,
              observedAt: change.observedAt,
            }
          : {
              sequence: change.sequence,
              ...("kind" in change && change.kind === "member" ? { kind: change.kind } : {}),
              member: presentMember(change.member),
            }),
    },
  };
}

function presentPagedJoin(value: HarnessJoinAgentGroupPageResult) {
  return {
    ...presentPagedObservation(value),
    operation: presentPagedOperation(value),
  };
}

function presentPagedJoinPending(value: HarnessJoinAgentGroupPendingPageResult) {
  return {
    ...presentPagedObservation(value),
    operation: {
      operationRef: value.pendingOperation.operationRef,
      observedAggregateVersion:
        value.pendingOperation.observedAggregateVersion,
      observedAt: value.pendingOperation.observedAt,
      retryAfterMs: value.pendingOperation.retryAfterMs,
      state: "waiting" as const,
    },
  };
}

function presentPagedJoinRecovery(groupRef: HarnessExternalAgentGroupRef, operationRef: string) {
  return {
    groupRef,
    operation: {
      operationRef,
      state: "continue_required" as const,
    },
  };
}

function presentPagedCancel(value: HarnessCancelAgentGroupPageResult) {
  return {
    ...presentPagedObservation(value),
    operation: presentPagedOperation(value),
  };
}

function presentPagedOperation(
  value: HarnessJoinAgentGroupPageResult | HarnessCancelAgentGroupPageResult,
) {
  const result = value.operationResult;
  if (value.memberPage.throughSequence < result.resultVersion) {
    return {
      operationRef: result.operationRef,
      resultVersion: result.resultVersion,
      state: "pending" as const,
    };
  }
  return {
    operationRef: result.operationRef,
    resultVersion: result.resultVersion,
    state: "resolved" as const,
    disposition: result.disposition,
    completedAt: result.completedAt,
    ...(result.summary === undefined ? {} : { summary: result.summary }),
    resultRefs: result.resultRefs,
  };
}

function presentMember(member: HarnessAgentMemberObservation) {
  return {
    memberId: member.memberId,
    memberIndex: member.memberIndex,
    revision: member.revision,
    status: member.status,
    ...(member.verificationReceipt === undefined ? {} : { verified: true as const }),
    ...(member.summary === undefined ? {} : { summary: member.summary }),
    ...(member.resultRef === undefined ? {} : { resultRef: member.resultRef }),
    ...(member.failureCode === undefined ? {} : { failureCode: member.failureCode }),
    updatedAt: member.updatedAt,
  };
}

function requiredExecutionIdentity(value: unknown): Readonly<{
  toolCallId: string;
  modelStepId?: string;
  sequenceIndex?: number;
}> {
  const execution = harnessExecutionContext(value);
  const toolCallId = execution.toolCallId;
  if (toolCallId === undefined || toolCallId.length === 0 || toolCallId.length > 512 || hasControl(toolCallId)) {
    throw new HarnessInputError("Agent Group calls require a Harness-supplied tool call identity.");
  }
  return Object.freeze({
    toolCallId,
    ...(execution.modelStepId === undefined ? {} : { modelStepId: execution.modelStepId }),
    ...(execution.sequenceIndex === undefined ? {} : { sequenceIndex: execution.sequenceIndex }),
  });
}

function normalizedConfiguredJoinPolicy(policy: HarnessAgentJoinPolicy): HarnessAgentJoinPolicy {
  if (policy.kind === "quorum") {
    if (!Number.isSafeInteger(policy.count) || policy.count < 1 || policy.count > 10_000) {
      throw new HarnessInputError("Configured Agent Group quorum is outside its supported bound.");
    }
    return Object.freeze({ kind: "quorum", count: policy.count });
  }
  if (policy.kind !== "all_success" && policy.kind !== "all_terminal" &&
      policy.kind !== "any_success" && policy.kind !== "first_verified") {
    throw new HarnessInputError("Agent Group join policy is invalid.");
  }
  return Object.freeze({ kind: policy.kind });
}

function resolvedJoinPolicy(
  configured: HarnessAgentJoinPolicyProfile,
  memberCount: number,
): HarnessAgentJoinPolicyProfile {
  if (configured.policy.kind === "quorum" && configured.policy.count > memberCount) {
    throw new HarnessInputError("Agent Group quorum exceeds the immutable member count.", {
      joinPolicyHandle: configured.handle,
    });
  }
  return configured;
}

function indexedByHandle<T extends Readonly<{ handle: string }>>(
  values: readonly T[],
  label: string,
): Readonly<Record<string, T>> {
  const indexed: Record<string, T> = Object.create(null) as Record<string, T>;
  for (const value of values) {
    if (Object.hasOwn(indexed, value.handle)) {
      throw new HarnessInputError(`${label} handle is not unique.`, { handle: value.handle });
    }
    indexed[value.handle] = value;
  }
  return Object.freeze(indexed);
}

function declaredHandle(value: string, label: string): string {
  if (!HANDLE.test(value)) throw new HarnessInputError(`${label} handle is invalid.`, { handle: value });
  return value;
}

function boundedInteger(value: number, minimum: number, maximum: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new HarnessInputError(`${field} is outside its supported bound.`);
  }
  return value;
}

function boundedText(value: string, maximumBytes: number, field: string): string {
  if (typeof value !== "string" || hasInvalidUnicode(value) || utf8Bytes(value) > maximumBytes) {
    throw new HarnessInputError(`${field} exceeds its UTF-8 byte bound or contains invalid text.`);
  }
  return value;
}

function boundedToken(value: string, maximumBytes: number, field: string): string {
  boundedText(value, maximumBytes, field);
  if (!/^[A-Za-z0-9_.:-]+$/u.test(value)) throw new HarnessInputError(`${field} is invalid.`);
  return value;
}

function validOpaqueRef(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || utf8Bytes(value) > OPAQUE_REF_MAX_BYTES || hasControl(value)) {
    throw new HarnessInputError(`Agent launcher returned an invalid opaque ${field}.`);
  }
  return value;
}

function validCursor(value: unknown, maximumBytes: number, field: string): string {
  if (typeof value !== "string" || value.length === 0 || utf8Bytes(value) > maximumBytes ||
      hasControl(value) || hasInvalidUnicode(value)) {
    throw new HarnessAgentGroupCursorError("invalid", `Agent Group ${field} is structurally invalid.`);
  }
  return value;
}

function assertExactKeys(value: unknown, allowed: readonly string[], label: string): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new HarnessInputError(`Agent launcher returned a non-object ${label}.`);
  }
  const allowedKeys = new Set(allowed);
  const prototype = Object.getPrototypeOf(value);
  const keys = Reflect.ownKeys(value);
  if ((prototype !== Object.prototype && prototype !== null) ||
      keys.some((key) => typeof key !== "string" || !allowedKeys.has(key)) ||
      keys.some((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return descriptor === undefined || !descriptor.enumerable ||
          !("value" in descriptor) || descriptor.get !== undefined || descriptor.set !== undefined;
      })) {
    throw new HarnessInputError(`Agent launcher returned undeclared fields in ${label}.`);
  }
}

function validTimestamp(value: string, field: string): void {
  const timestamp = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(timestamp) || new Date(value).toISOString() !== value ||
      timestamp > Date.now() + MAX_CLOCK_SKEW_MS) {
    throw new HarnessInputError(`Agent launcher returned an invalid ${field}.`);
  }
}

function validRevision(value: unknown, field: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new HarnessInputError(`Agent launcher returned an invalid ${field}.`);
  }
}

function memberStatus(value: unknown): value is HarnessAgentMemberStatus {
  return value === "queued" || value === "running" || value === "succeeded" ||
    value === "failed" || value === "cancelled" || value === "timed_out";
}

function groupStatus(value: unknown): value is HarnessAgentGroupStatus {
  return value === "queued" || value === "running" || value === "satisfied" ||
    value === "failed" || value === "cancelled" || value === "deadline";
}

function taskStatus(status: HarnessAgentMemberStatus): HarnessTaskRecord["status"] {
  if (status === "queued") return "queued";
  if (status === "running") return "running";
  if (status === "succeeded") return "completed";
  if (status === "cancelled") return "cancelled";
  return "failed";
}

function isTerminalTask(task: HarnessTaskRecord): boolean {
  return task.status === "completed" || task.status === "failed" || task.status === "cancelled";
}

function terminalMessage(observation: HarnessAgentMemberObservation): string {
  if (observation.status === "succeeded") return "Agent member completed.";
  if (observation.status === "cancelled") return "Agent member cancelled.";
  if (observation.status === "timed_out") return "Agent member deadline elapsed.";
  return "Agent member failed.";
}

function asGroupRef(value: string): HarnessExternalAgentGroupRef {
  return value as HarnessExternalAgentGroupRef;
}
function asTaskRef(value: string): HarnessExternalAgentTaskRef {
  return value as HarnessExternalAgentTaskRef;
}
function asResultRef(value: string): HarnessExternalAgentResultRef {
  return value as HarnessExternalAgentResultRef;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function hasControl(value: string): boolean {
  return /[\u0000-\u001f\u007f]/u.test(value);
}

function hasInvalidUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit === 0) return true;
    if (unit >= 0xD800 && unit <= 0xDBFF) {
      if (index + 1 >= value.length) return true;
      const next = value.charCodeAt(index + 1);
      if (next < 0xDC00 || next > 0xDFFF) return true;
      index += 1;
    } else if (unit >= 0xDC00 && unit <= 0xDFFF) {
      return true;
    }
  }
  return false;
}
