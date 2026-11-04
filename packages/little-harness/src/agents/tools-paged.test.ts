import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createInMemoryTaskLedger,
  HARNESS_AGENT_GROUP_PAGE_RETENTION,
  HARNESS_AGENT_GROUP_MAX_LIFETIME_PAGE_CALLS,
  type HarnessTaskLedger,
} from "../tasks/ledger.js";
import type { HarnessTaskId, HarnessTaskRecord } from "../tasks/types.js";
import { createInMemoryOrchestrationServices } from "../local-host/in-memory-orchestration-services.js";
import { createLocalHarnessDurableServices } from "../local-host/durable-services.js";
import { createInMemoryDurableStore, recordKey } from "../local-host/durable-store.js";
import { stableHash } from "../utils/canonical-hash.js";
import {
  HarnessAgentGroupCursorError,
  HarnessAgentGroupPageCallLimitError,
  type HarnessAgentGroupAggregate,
  type HarnessAgentGroupLauncher,
  type HarnessAgentGroupPagedLauncher,
  type HarnessAgentGroupPageRequest,
  type HarnessAgentGroupMemberChangePage,
  type HarnessExternalAgentGroupRef,
  type HarnessExternalAgentResultRef,
  type HarnessExternalAgentTaskRef,
  type HarnessStartAgentGroupRequest,
  type HarnessWatchAgentGroupPageResult,
} from "./types.js";
import { createAgentGroupTools, resolveAgentGroupsOptions } from "./tools.js";

// The paged trio as three flat methods, so a test can override one of them with a spread.
// `portLauncher` folds them into the port's `paged` object before Harness sees the launcher.
type TestLauncher = HarnessAgentGroupLauncher & {
  watchAgentGroupPage?: HarnessAgentGroupPagedLauncher["watch"];
  joinAgentGroupPage?: HarnessAgentGroupPagedLauncher["join"];
  cancelAgentGroupPage?: HarnessAgentGroupPagedLauncher["cancel"];
};

function portLauncher(launcher: TestLauncher): HarnessAgentGroupLauncher {
  const { watchAgentGroupPage, joinAgentGroupPage, cancelAgentGroupPage, ...port } = launcher;
  if (watchAgentGroupPage === undefined && joinAgentGroupPage === undefined &&
      cancelAgentGroupPage === undefined) {
    return port;
  }
  return {
    ...port,
    paged: {
      watch: watchAgentGroupPage!,
      join: joinAgentGroupPage!,
      cancel: cancelAgentGroupPage!,
    },
  };
}

const groupRef = "paged-group-1" as HarnessExternalAgentGroupRef;
const acceptedAt = new Date(Date.now() + 60_000).toISOString();

function taskRef(index: number): HarnessExternalAgentTaskRef {
  return `paged-task-${index + 1}` as HarnessExternalAgentTaskRef;
}

function started(request: HarnessStartAgentGroupRequest) {
  return Object.freeze({
    groupRef,
    acceptedAt,
    members: Object.freeze(request.members.map((member, index) => Object.freeze({
      memberId: member.memberId,
      memberIndex: member.memberIndex,
      taskRef: taskRef(index),
    }))),
  });
}

function aggregate(memberCount: number, succeededCount: number): HarnessAgentGroupAggregate {
  return Object.freeze({
    memberCount,
    queuedCount: memberCount - succeededCount,
    runningCount: 0,
    succeededCount,
    failedCount: 0,
    cancelledCount: 0,
    timedOutCount: 0,
    verifiedSucceededCount: 0,
    resultRefCount: 0,
  });
}

function runningAggregate(memberCount: number): HarnessAgentGroupAggregate {
  return Object.freeze({
    memberCount,
    queuedCount: 0,
    runningCount: memberCount,
    succeededCount: 0,
    failedCount: 0,
    cancelledCount: 0,
    timedOutCount: 0,
    verifiedSucceededCount: 0,
    resultRefCount: 0,
  });
}

function pageBody(
  request: HarnessAgentGroupPageRequest,
  memberCount: number,
  maximumChanges = request.maximumChanges,
) {
  const throughSequence = Math.min(memberCount, request.afterSequence + maximumChanges);
  const changes = Object.freeze(Array.from(
    { length: throughSequence - request.afterSequence },
    (_, offset) => {
      const memberIndex = request.afterSequence + offset;
      return Object.freeze({
        sequence: memberIndex + 1,
        member: Object.freeze({
          memberId: `member_${memberIndex + 1}`,
          memberIndex,
          taskRef: taskRef(memberIndex),
          revision: 1,
          status: "succeeded" as const,
          summary: `done-${memberIndex + 1}`,
          updatedAt: acceptedAt,
        }),
      });
    },
  ));
  const body = Object.freeze({
    requestIdempotencyKey: request.requestIdempotencyKey,
    afterSequence: request.afterSequence,
    throughSequence,
    nextPageCursor: cursorFor(throughSequence),
    hasMore: throughSequence < memberCount,
    changes,
  });
  return Object.freeze({ ...body, pageDigest: stableHash(body) });
}

function cursorFor(sequence: number): string {
  return `cursor_${stableHash({ domain: "test-store-cursor", sequence }, { format: "base32hex" }).slice(0, 24)}`;
}

function pageResult(
  request: HarnessAgentGroupPageRequest,
  memberCount: number,
  maximumChanges?: number,
): HarnessWatchAgentGroupPageResult {
  const memberPage = pageBody(request, memberCount, maximumChanges);
  return Object.freeze({
    groupRef: request.groupRef,
    aggregateVersion: memberPage.throughSequence,
    status: memberPage.throughSequence === memberCount ? "satisfied" : "running",
    aggregate: aggregate(memberCount, memberPage.throughSequence),
    memberPage,
    observedAt: acceptedAt,
  });
}

function pagedLauncher(memberCount: number, overrides: Partial<TestLauncher> = {}) {
  const knownCursors = new Map<string, number>([[cursorFor(0), 0]]);
  const validateCursor = (request: HarnessAgentGroupPageRequest) => {
    if (request.pageCursor === undefined) return;
    const stored = knownCursors.get(request.pageCursor);
    if (stored === undefined || stored !== request.afterSequence) {
      throw new HarnessAgentGroupCursorError("mismatch");
    }
  };
  const observe = async (request: HarnessAgentGroupPageRequest) => {
    validateCursor(request);
    const result = pageResult(request, memberCount);
    knownCursors.set(result.memberPage.nextPageCursor, result.memberPage.throughSequence);
    return result;
  };
  const operationResult = (
    request: Parameters<NonNullable<TestLauncher["joinAgentGroupPage"]>>[0] |
      Parameters<NonNullable<TestLauncher["cancelAgentGroupPage"]>>[0],
    kind: "join" | "cancel",
    disposition: "satisfied" | "already_terminal",
  ) => {
    const body = Object.freeze({
      operationRef: request.operationRef ?? `operation-${request.operationIdempotencyKey}`,
      kind,
      resultVersion: memberCount,
      disposition,
      completedAt: acceptedAt,
      resultRefs: Object.freeze([]),
    });
    return Object.freeze({ ...body, resultDigest: stableHash(body) });
  };
  const launcher: TestLauncher = {
    startAgentGroup: async (request) => started(request),
    watchAgentGroup: async () => { throw new Error("legacy watch must not run"); },
    joinAgentGroup: async () => { throw new Error("legacy join must not run"); },
    cancelAgentGroup: async () => { throw new Error("legacy cancel must not run"); },
    watchAgentGroupPage: observe,
    joinAgentGroupPage: async (request) => ({
      ...await observe(request),
      operationResult: operationResult(request, "join", "satisfied"),
    }),
    cancelAgentGroupPage: async (request) => ({
      ...await observe(request),
      operationResult: operationResult(request, "cancel", "already_terminal"),
    }),
    ...overrides,
  };
  return { launcher, knownCursors };
}

function agents(
  launcher: TestLauncher,
  maxMembers: number,
  limitOverrides: Partial<{
    maxMemberPageChanges: number;
    maxMemberPageBytes: number;
    maxMemberCursorBytes: number;
  }> = {},
) {
  return resolveAgentGroupsOptions({
    launcher: portLauncher(launcher),
    profiles: [{
      handle: "worker",
      resourcesHandle: "cpu",
      secretsHandle: "none",
      toolsHandle: "code",
      networkHandle: "none",
      priorityHandle: "batch",
    }],
    joinPolicies: [{ handle: "all", policy: { kind: "all_success" } }],
    defaultJoinPolicyHandle: "all",
    reductionPolicies: [{
      handle: "bounded",
      maxMemberSummaryBytes: 128,
      maxGroupSummaryBytes: 256,
      maxResultRefs: 10_000,
    }],
    defaultReductionPolicyHandle: "bounded",
    limits: {
      maxMembers,
      maxPromptBytes: 16,
      maxGroupPromptBytes: Math.max(maxMembers * 2, 1_024),
      maxDeadlineMs: 60_000,
      maxJoinWaitMs: 1_000,
      maxMemberPageChanges: 1_000,
      maxMemberPageBytes: 4 * 1_024 * 1_024,
      maxMemberCursorBytes: 256,
      ...limitOverrides,
    },
  });
}

function tools(
  launcher: TestLauncher,
  maxMembers: number,
  ledger = createInMemoryTaskLedger(),
  limitOverrides: Parameters<typeof agents>[2] = {},
) {
  return {
    ledger,
    tools: createAgentGroupTools({
      sessionId: "paged-session",
      originTurnId: "paged-turn",
      ledger,
      agents: agents(launcher, maxMembers, limitOverrides),
    }),
  };
}

async function execute(toolValue: unknown, input: unknown, toolCallId: string): Promise<any> {
  const executable = toolValue as { execute?: (value: any, execution: any) => Promise<unknown> };
  if (executable.execute === undefined) throw new Error("test tool is not executable");
  return await executable.execute(input, {
    toolCallId,
    context: { modelStepId: "paged-step", sequenceIndex: 0 },
  });
}

async function launch(toolValue: unknown, memberCount: number) {
  return await execute(toolValue, {
    members: Array.from({ length: memberCount }, () => ({ prompt: "x", profileHandle: "worker" })),
  }, `launch-${memberCount}`);
}

async function createDirectPagedGroup(
  ledger: HarnessTaskLedger,
  input: {
    sessionId: string;
    scopeIdentity: string;
    groupRef: string;
    launchCallIdentity: string;
    memberCallIdentity: string;
    taskRef: string;
  },
): Promise<HarnessTaskRecord> {
  const tasks = Object.freeze([Object.freeze({
    kind: "agent" as const,
    callIdentity: input.memberCallIdentity,
    agentMemberId: "member_1",
    agentMemberIndex: 0,
    agentGroupScopeIdentity: input.scopeIdentity,
    agentJoinPolicyHandle: "all",
    agentJoinPolicyKind: "all_success" as const,
    agentReductionPolicyHandle: "bounded",
    agentMaxMemberSummaryBytes: 128,
    agentMaxGroupSummaryBytes: 256,
    agentMaxResultRefs: 10,
  })]);
  const canonicalInputDigest = stableHash({
    domain: "little-harness.agent-group-task-batch.v1",
    sessionId: input.sessionId,
    callIdentity: input.launchCallIdentity,
    scopeIdentity: input.scopeIdentity,
    tasks,
  });
  const reserved = await ledger.reserveAgentGroupTaskBatch!({
    sessionId: input.sessionId,
    callIdentity: input.launchCallIdentity,
    scopeIdentity: input.scopeIdentity,
    canonicalInputDigest,
    tasks,
  });
  if (reserved.outcome !== "applied" && reserved.outcome !== "replayed") {
    throw new Error(`direct group reservation failed: ${reserved.outcome}`);
  }
  const bound = await ledger.bindAgentGroupStart!({
    sessionId: input.sessionId,
    scopeIdentity: input.scopeIdentity,
    groupRef: input.groupRef,
    acceptedAt,
    launchCallIdentity: input.launchCallIdentity,
    observationMode: "paged_changes",
    members: [{
      taskId: reserved.records[0]!.taskId,
      memberId: "member_1",
      memberIndex: 0,
      taskRef: input.taskRef,
    }],
  });
  if (bound.outcome !== "applied" && bound.outcome !== "replayed") {
    throw new Error(`direct group start failed: ${bound.outcome}`);
  }
  return bound.records[0]!;
}

async function bindDirectJoinPageCall(
  ledger: HarnessTaskLedger,
  input: {
    sessionId: string;
    scopeIdentity: string;
    groupRef: string;
    pageCallIdentity: string;
    requestIdempotencyKey: string;
  },
) {
  return await ledger.bindAgentGroupPageCall!({
    sessionId: input.sessionId,
    scopeIdentity: input.scopeIdentity,
    groupRef: input.groupRef,
    callIdentity: input.pageCallIdentity,
    operationKind: "join",
    canonicalInputDigest: stableHash({ callIdentity: input.pageCallIdentity }),
    requestIdempotencyKey: input.requestIdempotencyKey,
    maximumChanges: 1,
    maximumBytes: 1_000_000,
    maximumCursorBytes: 256,
  });
}

async function projectDirectResultRef(
  ledger: HarnessTaskLedger,
  input: {
    sessionId: string;
    scopeIdentity: string;
    groupRef: string;
    taskRef: string;
    callIdentity: string;
    requestIdempotencyKey: string;
    afterSequence: number;
    memberRevision: number;
    resultRef?: string;
    memberStateDigest?: string;
  },
) {
  const binding = await ledger.bindAgentGroupPageCall!({
    sessionId: input.sessionId,
    scopeIdentity: input.scopeIdentity,
    groupRef: input.groupRef,
    callIdentity: input.callIdentity,
    operationKind: "watch",
    canonicalInputDigest: stableHash({ callIdentity: input.callIdentity }),
    requestIdempotencyKey: input.requestIdempotencyKey,
    requestedAfterSequence: input.afterSequence,
    pageCursorDigest: stableHash({ cursor: input.afterSequence }),
    maximumChanges: 1,
    maximumBytes: 1_000_000,
    maximumCursorBytes: 256,
  });
  if (binding.outcome !== "applied" && binding.outcome !== "replayed") return binding;
  const sequence = input.afterSequence + 1;
  const memberStateDigest = input.memberStateDigest ?? stableHash({
    status: "succeeded",
    resultRef: input.resultRef,
  });
  return await ledger.projectAgentGroupPage!({
    sessionId: input.sessionId,
    scopeIdentity: input.scopeIdentity,
    groupRef: input.groupRef,
    requestIdempotencyKey: input.requestIdempotencyKey,
    pageDigest: stableHash({ page: input.requestIdempotencyKey }),
    afterSequence: input.afterSequence,
    throughSequence: sequence,
    aggregateVersion: sequence,
    groupStatus: "satisfied",
    aggregate: Object.freeze({
      ...aggregate(1, 1),
      resultRefCount: input.resultRef === undefined ? 0 : 1,
    }),
    groupObservationDigest: stableHash({ group: input.requestIdempotencyKey }),
    groupObservedAt: acceptedAt,
    pageCallIdentity: input.callIdentity,
    changes: [Object.freeze({
      sequence,
      memberId: "member_1",
      memberIndex: 0,
      taskRef: input.taskRef,
      memberStatus: "succeeded" as const,
      memberRevision: input.memberRevision,
      memberObservationDigest: stableHash({ observation: input.requestIdempotencyKey }),
      memberStateDigest,
      memberObservedAt: acceptedAt,
      status: "completed" as const,
      ...(input.resultRef === undefined ? {} : { externalAgentResultRef: input.resultRef }),
      verifiedSucceeded: false,
      hasResultRef: input.resultRef !== undefined,
    })],
  });
}

describe("paged Agent Group tools", () => {
  it("keeps the begin idempotency owner through an alias-only crash cut", async () => {
    const rootDir = "/pending-terminal-crash-cut";
    const store = createInMemoryDurableStore();
    let injected = false;
    const firstServices = createInMemoryOrchestrationServices({
      rootDir,
      store,
      faultInjection: {
        onPoint(point) {
          if (!injected && point === "agent-group-pending-after-alias-before-write") {
            injected = true;
            throw new Error("injected alias-before-pending crash");
          }
        },
      },
    });
    const task = await createDirectPagedGroup(firstServices.tasks, {
      sessionId: "pending-terminal-crash-session",
      scopeIdentity: "pending-terminal-crash-scope",
      groupRef: "pending-terminal-crash-group",
      launchCallIdentity: "pending-terminal-crash-launch",
      memberCallIdentity: "pending-terminal-crash-member",
      taskRef: "pending-terminal-crash-task",
    });
    const scopeIdentity = task.agentGroupScopeIdentity!;
    const pendingBody = Object.freeze({
      operationRef: "pending-terminal-crash-operation",
      observedAggregateVersion: 0,
      observedAt: acceptedAt,
      retryAfterMs: 250,
    });
    const pending = Object.freeze({
      ...pendingBody,
      pendingDigest: stableHash(pendingBody),
    });
    const beginBinding = {
      sessionId: "pending-terminal-crash-session",
      scopeIdentity,
      groupRef: "pending-terminal-crash-group",
      operationIdempotencyKey: "pending-terminal-crash-begin",
      mutationInputDigest: stableHash("pending-terminal-crash-mutation"),
      operationMode: "begin" as const,
      pending,
    };
    await expect(firstServices.tasks.bindAgentGroupPendingOperation!(beginBinding))
      .rejects.toThrow("injected alias-before-pending crash");

    const sessionKey = stableHash(
      { kind: "session", sessionId: beginBinding.sessionId },
      { format: "base32hex" },
    );
    const pageDir = join(rootDir, "agent-group-pages", sessionKey, recordKey(scopeIdentity));
    const aliasPath = join(
      pageDir,
      "operation-idempotency",
      `${recordKey(beginBinding.operationIdempotencyKey)}.json`,
    );
    const pendingPath = join(
      pageDir,
      "operation-pending",
      `${recordKey(pending.operationRef)}.json`,
    );
    expect(await store.readJson(aliasPath)).toMatchObject({
      operationRef: pending.operationRef,
      operationMode: "begin",
      mutationInputDigest: beginBinding.mutationInputDigest,
    });
    expect(await store.readJson(pendingPath)).toBeUndefined();

    const restarted = createInMemoryOrchestrationServices({ rootDir, store });
    const otherPendingBody = Object.freeze({
      ...pendingBody,
      operationRef: "pending-terminal-crash-other-operation",
    });
    const otherPending = Object.freeze({
      ...otherPendingBody,
      pendingDigest: stableHash(otherPendingBody),
    });
    expect(await restarted.tasks.bindAgentGroupPendingOperation!({
      ...beginBinding,
      pending: otherPending,
    })).toMatchObject({ outcome: "conflict" });
    expect(await restarted.tasks.bindAgentGroupPendingOperation!(beginBinding))
      .toMatchObject({ outcome: "applied" });
    expect(await store.readJson(pendingPath)).toMatchObject({
      input: beginBinding,
    });
    expect(await store.readJson(aliasPath)).toMatchObject({
      operationRef: pending.operationRef,
      operationMode: "begin",
    });

    // A pending-first record from an older owner can still be repaired in place.
    await store.remove(aliasPath);
    expect(await restarted.tasks.bindAgentGroupPendingOperation!(beginBinding))
      .toMatchObject({ outcome: "replayed" });
    expect(await store.readJson(aliasPath)).toMatchObject({
      operationRef: pending.operationRef,
      operationMode: "begin",
    });

    const terminalBody = Object.freeze({
      operationRef: pending.operationRef,
      kind: "join" as const,
      resultVersion: 0,
      disposition: "satisfied" as const,
      completedAt: acceptedAt,
      resultRefs: Object.freeze([]),
    });
    const terminal = Object.freeze({
      ...terminalBody,
      resultDigest: stableHash(terminalBody),
    });
    const continueBinding = {
      ...beginBinding,
      operationIdempotencyKey: "pending-terminal-crash-continue",
      mutationInputDigest: stableHash("pending-terminal-crash-continue"),
      operationMode: "continue" as const,
      result: terminal,
    };
    expect(await restarted.tasks.bindAgentGroupOperationResult!(continueBinding))
      .toMatchObject({ outcome: "applied" });
    expect(await restarted.tasks.bindAgentGroupOperationResult!(continueBinding))
      .toMatchObject({ outcome: "replayed" });
    const terminalRestart = createInMemoryOrchestrationServices({ rootDir, store });
    expect(await terminalRestart.tasks.bindAgentGroupOperationResult!(continueBinding))
      .toMatchObject({ outcome: "replayed" });
  });

  it.each([undefined, ""] as const)(
    "rejects a non-reserved join reservation without an operation ref before launcher I/O (%s)",
    async (operationRef) => {
      const baseLedger = createInMemoryTaskLedger();
      const reserveAgentGroupJoinBegin = vi.fn(async () => ({
        outcome: "pending" as const,
        phase: "pending" as const,
        ...(operationRef === undefined ? {} : { operationRef }),
      })) as unknown as NonNullable<HarnessTaskLedger["reserveAgentGroupJoinBegin"]>;
      const ledger: HarnessTaskLedger = {
        ...baseLedger,
        reserveAgentGroupJoinBegin,
      };
      const { launcher: baseLauncher } = pagedLauncher(1);
      const joinAgentGroupPage = vi.fn(baseLauncher.joinAgentGroupPage!);
      const groupTools = tools({ ...baseLauncher, joinAgentGroupPage }, 1, ledger).tools;
      await launch(groupTools.start_agent_group, 1);

      await expect(execute(groupTools.join_agent_group, { groupRef }, `invalid-reservation-${operationRef ?? "missing"}`))
        .rejects.toThrow("Paged Agent Group join reservation returned an invalid result.");
      expect(reserveAgentGroupJoinBegin).toHaveBeenCalledTimes(1);
      expect(joinAgentGroupPage).not.toHaveBeenCalled();
    },
  );

  it.each(["in-memory", "durable"] as const)(
    "projects a gap-free v2 group-control-only transition through the %s ledger",
    async (backend) => {
      const ledger = backend === "in-memory"
        ? createInMemoryTaskLedger()
        : createInMemoryOrchestrationServices({
            rootDir: `/group-control-${backend}`,
            store: createInMemoryDurableStore(),
          }).tasks;
      let driftControlDigest = false;
      const { launcher: baseLauncher } = pagedLauncher(1);
      const watchAgentGroupPage = vi.fn(async (request: HarnessAgentGroupPageRequest) => {
        const controlBody = Object.freeze({
          sequence: request.afterSequence + 1,
          kind: "group_control" as const,
          status: "deadline" as const,
          observedAt: acceptedAt,
        });
        const changes = Object.freeze([Object.freeze({
          ...controlBody,
          controlDigest: driftControlDigest ? stableHash({ drift: true }) : stableHash(controlBody),
        })]);
        const page = Object.freeze({
          requestIdempotencyKey: request.requestIdempotencyKey,
          afterSequence: request.afterSequence,
          throughSequence: request.afterSequence + 1,
          nextPageCursor: cursorFor(request.afterSequence + 1),
          hasMore: false,
          changes,
        });
        return Object.freeze({
          groupRef: request.groupRef,
          aggregateVersion: page.throughSequence,
          status: "deadline" as const,
          aggregate: aggregate(1, 0),
          memberPage: Object.freeze({ ...page, pageDigest: stableHash(page) }),
          observedAt: acceptedAt,
        });
      });
      const { tools: groupTools } = tools({ ...baseLauncher, watchAgentGroupPage }, 1, ledger);
      await launch(groupTools.start_agent_group, 1);

      const projected = await execute(groupTools.watch_agent_group, { groupRef }, `control-${backend}`);
      expect(projected.memberPage.changes).toEqual([{
        sequence: 1,
        kind: "group_control",
        status: "deadline",
        observedAt: acceptedAt,
      }]);
      expect(await ledger.getAgentGroupPageState?.({ sessionId: "paged-session", groupRef }))
        .toMatchObject({ aggregateVersion: 1, groupStatus: "deadline", aggregate: aggregate(1, 0) });

      const replayLedger = backend === "in-memory"
        ? createInMemoryTaskLedger()
        : createInMemoryOrchestrationServices({
            rootDir: `/group-control-drift-${backend}`,
            store: createInMemoryDurableStore(),
          }).tasks;
      const driftTools = tools({ ...baseLauncher, watchAgentGroupPage }, 1, replayLedger).tools;
      await launch(driftTools.start_agent_group, 1);
      driftControlDigest = true;
      await expect(execute(driftTools.watch_agent_group, { groupRef }, `control-drift-${backend}`))
        .rejects.toThrow("invalid group control digest");
    },
  );

  it.each(["in-memory", "durable"] as const)(
    "admits the JR queued-to-running member page and replays exact bytes through the %s ledger",
    async (backend) => {
      const baseLedger = backend === "in-memory"
        ? createInMemoryTaskLedger()
        : createInMemoryOrchestrationServices({
            rootDir: `/jr-member-transition-${backend}`,
            store: createInMemoryDurableStore(),
          }).tasks;
      const projectionOutcomes: string[] = [];
      const ledger: HarnessTaskLedger = {
        ...baseLedger,
        async projectAgentGroupPage(input) {
          const result = await baseLedger.projectAgentGroupPage!(input);
          projectionOutcomes.push(result.outcome);
          return result;
        },
      };
      const { launcher: baseLauncher } = pagedLauncher(2);
      const replayedPages: HarnessAgentGroupMemberChangePage[] = [];
      const watchAgentGroupPage = vi.fn(async (request: HarnessAgentGroupPageRequest) => {
        const changes = Object.freeze([0, 1].map((memberIndex) => Object.freeze({
          sequence: memberIndex + 1,
          kind: "member" as const,
          member: Object.freeze({
            memberId: `member_${memberIndex + 1}`,
            memberIndex,
            taskRef: taskRef(memberIndex),
            revision: 1,
            status: "running" as const,
            updatedAt: acceptedAt,
          }),
        })));
        const body = Object.freeze({
          requestIdempotencyKey: request.requestIdempotencyKey,
          afterSequence: request.afterSequence,
          throughSequence: request.afterSequence + changes.length,
          nextPageCursor: cursorFor(request.afterSequence + changes.length),
          hasMore: false,
          changes,
        });
        const result = Object.freeze({
          groupRef: request.groupRef,
          aggregateVersion: body.throughSequence,
          status: "running" as const,
          aggregate: runningAggregate(2),
          memberPage: Object.freeze({ ...body, pageDigest: stableHash(body) }),
          observedAt: acceptedAt,
        });
        replayedPages.push(result.memberPage);
        return result;
      });
      const { tools: groupTools } = tools(
        { ...baseLauncher, watchAgentGroupPage },
        2,
        ledger,
      );
      await launch(groupTools.start_agent_group, 2);

      const first = await execute(groupTools.watch_agent_group, {
        groupRef,
        pageSize: 2,
      }, `jr-member-page-${backend}`);
      const replay = await execute(groupTools.watch_agent_group, {
        groupRef,
        pageSize: 2,
      }, `jr-member-page-${backend}`);

      expect(first).toEqual(replay);
      expect(replayedPages).toHaveLength(2);
      expect(replayedPages[1]).toEqual(replayedPages[0]);
      expect(replayedPages[1]!.pageDigest).toBe(replayedPages[0]!.pageDigest);
      expect(projectionOutcomes).toEqual(["applied", "replayed"]);
      expect(first).toMatchObject({
        aggregateVersion: 2,
        status: "running",
        memberPage: {
          afterSequence: 0,
          throughSequence: 2,
          nextPageCursor: cursorFor(2),
          changes: [
            { sequence: 1, kind: "member", member: { status: "running" } },
            { sequence: 2, kind: "member", member: { status: "running" } },
          ],
        },
      });
      expect(watchAgentGroupPage).toHaveBeenCalledTimes(2);
      expect(await ledger.getAgentGroupPageState?.({ sessionId: "paged-session", groupRef }))
        .toMatchObject({ aggregateVersion: 2, groupStatus: "running", aggregate: runningAggregate(2) });
    },
  );

  it.each(["in-memory", "durable"] as const)(
    "rejects a queued-only v2 member page claiming queued-to-running through the %s ledger",
    async (backend) => {
      const ledger = backend === "in-memory"
        ? createInMemoryTaskLedger()
        : createInMemoryOrchestrationServices({
            rootDir: `/jr-member-queued-only-${backend}`,
            store: createInMemoryDurableStore(),
          }).tasks;
      const { launcher: baseLauncher } = pagedLauncher(2);
      const watchAgentGroupPage = vi.fn(async (request: HarnessAgentGroupPageRequest) => {
        const changes = Object.freeze([0, 1].map((memberIndex) => Object.freeze({
          sequence: memberIndex + 1,
          kind: "member" as const,
          member: Object.freeze({
            memberId: `member_${memberIndex + 1}`,
            memberIndex,
            taskRef: taskRef(memberIndex),
            revision: 1,
            status: "queued" as const,
            updatedAt: acceptedAt,
          }),
        })));
        const body = Object.freeze({
          requestIdempotencyKey: request.requestIdempotencyKey,
          afterSequence: request.afterSequence,
          throughSequence: request.afterSequence + changes.length,
          nextPageCursor: cursorFor(request.afterSequence + changes.length),
          hasMore: false,
          changes,
        });
        return Object.freeze({
          groupRef: request.groupRef,
          aggregateVersion: body.throughSequence,
          status: "running" as const,
          aggregate: aggregate(2, 0),
          memberPage: Object.freeze({ ...body, pageDigest: stableHash(body) }),
          observedAt: acceptedAt,
        });
      });
      const { tools: groupTools } = tools(
        { ...baseLauncher, watchAgentGroupPage },
        2,
        ledger,
      );
      await launch(groupTools.start_agent_group, 2);

      await expect(execute(groupTools.watch_agent_group, {
        groupRef,
        pageSize: 2,
      }, `jr-member-queued-only-${backend}`)).rejects.toThrow(/conflicting bytes/);
      expect(await ledger.getAgentGroupPageState?.({ sessionId: "paged-session", groupRef }))
        .toMatchObject({ aggregateVersion: 0, groupStatus: "queued", aggregate: aggregate(2, 0) });
    },
  );

  it.each(["in-memory", "durable"] as const)(
    "rejects member-only queued-to-terminal status changes through the %s ledger",
    async (backend) => {
      const terminalCases = [
        {
          groupStatus: "satisfied" as const,
          memberStatus: "succeeded" as const,
          aggregate: Object.freeze({
            memberCount: 2,
            queuedCount: 0,
            runningCount: 0,
            succeededCount: 2,
            failedCount: 0,
            cancelledCount: 0,
            timedOutCount: 0,
            verifiedSucceededCount: 0,
            resultRefCount: 0,
          }),
        },
        {
          groupStatus: "failed" as const,
          memberStatus: "failed" as const,
          aggregate: Object.freeze({
            memberCount: 2,
            queuedCount: 0,
            runningCount: 0,
            succeededCount: 0,
            failedCount: 2,
            cancelledCount: 0,
            timedOutCount: 0,
            verifiedSucceededCount: 0,
            resultRefCount: 0,
          }),
        },
        {
          groupStatus: "cancelled" as const,
          memberStatus: "cancelled" as const,
          aggregate: Object.freeze({
            memberCount: 2,
            queuedCount: 0,
            runningCount: 0,
            succeededCount: 0,
            failedCount: 0,
            cancelledCount: 2,
            timedOutCount: 0,
            verifiedSucceededCount: 0,
            resultRefCount: 0,
          }),
        },
        {
          groupStatus: "deadline" as const,
          memberStatus: "timed_out" as const,
          aggregate: Object.freeze({
            memberCount: 2,
            queuedCount: 0,
            runningCount: 0,
            succeededCount: 0,
            failedCount: 0,
            cancelledCount: 0,
            timedOutCount: 2,
            verifiedSucceededCount: 0,
            resultRefCount: 0,
          }),
        },
      ] as const;
      for (const [index, terminal] of terminalCases.entries()) {
        const ledger = backend === "in-memory"
          ? createInMemoryTaskLedger()
          : createInMemoryOrchestrationServices({
              rootDir: `/jr-member-terminal-${backend}-${terminal.groupStatus}`,
              store: createInMemoryDurableStore(),
            }).tasks;
        const { launcher: baseLauncher } = pagedLauncher(2);
        const watchAgentGroupPage = vi.fn(async (request: HarnessAgentGroupPageRequest) => {
          const changes = Object.freeze([0, 1].map((memberIndex) => Object.freeze({
            sequence: memberIndex + 1,
            kind: "member" as const,
            member: Object.freeze({
              memberId: `member_${memberIndex + 1}`,
              memberIndex,
              taskRef: taskRef(memberIndex),
              revision: 1,
              status: terminal.memberStatus,
              updatedAt: acceptedAt,
            }),
          })));
          const body = Object.freeze({
            requestIdempotencyKey: request.requestIdempotencyKey,
            afterSequence: request.afterSequence,
            throughSequence: request.afterSequence + changes.length,
            nextPageCursor: cursorFor(request.afterSequence + changes.length),
            hasMore: false,
            changes,
          });
          return Object.freeze({
            groupRef: request.groupRef,
            aggregateVersion: body.throughSequence,
            status: terminal.groupStatus,
            aggregate: terminal.aggregate,
            memberPage: Object.freeze({ ...body, pageDigest: stableHash(body) }),
            observedAt: acceptedAt,
          });
        });
        const { tools: groupTools } = tools(
          { ...baseLauncher, watchAgentGroupPage },
          2,
          ledger,
        );
        await launch(groupTools.start_agent_group, 2);

        await expect(execute(groupTools.watch_agent_group, {
          groupRef,
          pageSize: 2,
        }, `jr-terminal-page-${backend}-${index}`)).rejects.toThrow(/conflicting bytes/);
        expect(watchAgentGroupPage).toHaveBeenCalledTimes(1);
        expect(await ledger.getAgentGroupPageState?.({ sessionId: "paged-session", groupRef }))
          .toMatchObject({ aggregateVersion: 0, groupStatus: "queued" });
      }
    },
  );

  it("launches a zero-to-10,000 durable group in one O(N) batch lock and replays response loss without duplicates", async () => {
    const memberCount = 10_000;
    const rootDir = "/scale-launch";
    const backing = createInMemoryDurableStore();
    const lockScopes: unknown[] = [];
    const reads: string[] = [];
    const writes: string[] = [];
    const lists: string[] = [];
    const store = {
      ...backing,
      async readJson<T>(path: string) {
        reads.push(path);
        return await backing.readJson<T>(path);
      },
      async writeJson(path: string, value: unknown) {
        writes.push(path);
        await backing.writeJson(path, value);
      },
      async listDir(path: string) {
        lists.push(path);
        return await backing.listDir(path);
      },
      async withLock<T>(scope: unknown, fn: () => Promise<T>) {
        lockScopes.push(scope);
        return await backing.withLock(scope, fn);
      },
    };
    let lost = false;
    const services = createInMemoryOrchestrationServices({
      rootDir,
      store,
      faultInjection: {
        onPoint(point) {
          if (!lost && point === "agent-group-start-binding-after-authority-commit") {
            lost = true;
            throw new Error("lost 10k start response");
          }
        },
      },
    });
    const { launcher: baseLauncher } = pagedLauncher(memberCount);
    const startAgentGroup = vi.fn(baseLauncher.startAgentGroup);
    const groupTools = tools({ ...baseLauncher, startAgentGroup }, memberCount, services.tasks).tools;

    await expect(launch(groupTools.start_agent_group, memberCount))
      .rejects.toThrow("lost 10k start response");
    const taskLocksAfterLostResponse = lockScopes.filter((scope) =>
      Array.isArray(scope) && scope[0] === "task-ledger");
    expect(taskLocksAfterLostResponse).toHaveLength(1);
    expect(lists).toHaveLength(0);

    const launched = await launch(groupTools.start_agent_group, memberCount);
    expect(launched.members).toHaveLength(memberCount);
    expect(new Set(launched.members.map((member: { taskId: string }) => member.taskId)).size)
      .toBe(memberCount);
    expect(startAgentGroup).toHaveBeenCalledTimes(1);
    const thirdReplay = await launch(groupTools.start_agent_group, memberCount);
    expect(thirdReplay.members.map((member: { taskId: string }) => member.taskId))
      .toEqual(launched.members.map((member: { taskId: string }) => member.taskId));
    expect(startAgentGroup).toHaveBeenCalledTimes(1);
    expect(lockScopes.filter((scope) => Array.isArray(scope) && scope[0] === "task-ledger"))
      .toHaveLength(3);
    expect(lists).toHaveLength(0);

    const unique = (fragment: string) => new Set(
      writes.filter((path) => path.includes(fragment)),
    );
    const sessionKey = stableHash(
      { kind: "session", sessionId: "paged-session" },
      { format: "base32hex" },
    );
    const taskRecordPrefix = join(rootDir, "tasks", sessionKey);
    const taskRecordPaths = new Set(writes.filter((path) =>
      path.startsWith(`${taskRecordPrefix}/`) &&
      !path.includes("/call-identities/") && !path.endsWith("/meta.json")));
    expect(taskRecordPaths.size).toBe(memberCount);
    expect(unique("/agent-group-pages/").size).toBeGreaterThanOrEqual(memberCount + 1);
    expect(unique("/page-calls/").size).toBe(0);
    expect(unique("/sequences/").size).toBe(0);
    const batchJournalPath = [...unique("/agent-group-task-batches/")][0]!;
    expect(await backing.readJson<any>(batchJournalPath)).toMatchObject({
      state: "committed",
      firstTaskNumber: 1,
      lastTaskNumber: memberCount,
    });
    expect(await backing.readJson<any>(batchJournalPath)).not.toHaveProperty("records");
    // The retry performs O(N) point reads against the immutable journal/task
    // records; it never scans a task directory or creates a second task set.
    expect(reads.length).toBeLessThan(memberCount * 18);
  }, 30_000);

  it("replays an immutable accepted start after terminal progress without relaunch or task rewind", async () => {
    const rootDir = "/accepted-start-terminal-replay";
    const store = createInMemoryDurableStore();
    const services = createInMemoryOrchestrationServices({ rootDir, store });
    const { launcher: baseLauncher } = pagedLauncher(1);
    const startAgentGroup = vi.fn(baseLauncher.startAgentGroup);
    const groupTools = tools({ ...baseLauncher, startAgentGroup }, 1, services.tasks).tools;
    const first = await launch(groupTools.start_agent_group, 1);
    await execute(groupTools.watch_agent_group, { groupRef, pageSize: 1 }, "accepted-terminal-page");
    expect((await services.tasks.getTask({
      sessionId: "paged-session",
      taskId: first.members[0].taskId,
    }))?.status).toBe("completed");

    const replay = await launch(groupTools.start_agent_group, 1);
    expect(replay).toMatchObject({ status: "started", groupRef });
    expect(replay.members[0].taskId).toBe(first.members[0].taskId);
    expect(startAgentGroup).toHaveBeenCalledTimes(1);
    expect((await services.tasks.getTask({
      sessionId: "paged-session",
      taskId: first.members[0].taskId,
    }))?.status).toBe("completed");
  });

  it.each(["memory", "durable"] as const)(
    "replays an accepted start after valid running progress in the %s ledger",
    async (kind) => {
      const rootDir = `/accepted-start-running-${kind}`;
      const store = kind === "durable" ? createInMemoryDurableStore() : undefined;
      const ledger = kind === "durable"
        ? createInMemoryOrchestrationServices({ rootDir, store: store! }).tasks
        : createInMemoryTaskLedger();
      const { launcher: baseLauncher } = pagedLauncher(1);
      const startAgentGroup = vi.fn(baseLauncher.startAgentGroup);
      const watchAgentGroupPage = vi.fn(async (request: HarnessAgentGroupPageRequest) => {
        const body = Object.freeze({
          requestIdempotencyKey: request.requestIdempotencyKey,
          afterSequence: 0,
          throughSequence: 1,
          nextPageCursor: cursorFor(1),
          hasMore: false,
          changes: Object.freeze([Object.freeze({
            sequence: 1,
            member: Object.freeze({
              memberId: "member_1",
              memberIndex: 0,
              taskRef: taskRef(0),
              revision: 1,
              status: "running" as const,
              updatedAt: acceptedAt,
            }),
          })]),
        });
        return Object.freeze({
          groupRef: request.groupRef,
          aggregateVersion: 1,
          status: "running" as const,
          aggregate: Object.freeze({
            ...aggregate(1, 0),
            queuedCount: 0,
            runningCount: 1,
          }),
          memberPage: Object.freeze({ ...body, pageDigest: stableHash(body) }),
          observedAt: acceptedAt,
        });
      });
      const groupTools = tools(
        { ...baseLauncher, startAgentGroup, watchAgentGroupPage },
        1,
        ledger,
      ).tools;
      const first = await launch(groupTools.start_agent_group, 1);
      await execute(groupTools.watch_agent_group, { groupRef, pageSize: 1 }, `running-${kind}`);
      expect((await ledger.getTask({
        sessionId: "paged-session",
        taskId: first.members[0].taskId,
      }))?.status).toBe("running");

      const replay = await launch(groupTools.start_agent_group, 1);
      expect(replay.members[0].taskId).toBe(first.members[0].taskId);
      expect(startAgentGroup).toHaveBeenCalledTimes(1);
      expect((await ledger.getTask({
        sessionId: "paged-session",
        taskId: first.members[0].taskId,
      }))?.status).toBe("running");
    },
  );

  it("rejects a failure code on a nonterminal paged member observation", async () => {
    const { launcher: baseLauncher } = pagedLauncher(1);
    const watchAgentGroupPage = vi.fn(async (request: HarnessAgentGroupPageRequest) => {
      const body = Object.freeze({
        requestIdempotencyKey: request.requestIdempotencyKey,
        afterSequence: 0,
        throughSequence: 1,
        nextPageCursor: cursorFor(1),
        hasMore: false,
        changes: Object.freeze([Object.freeze({
          sequence: 1,
          member: Object.freeze({
            memberId: "member_1",
            memberIndex: 0,
            taskRef: taskRef(0),
            revision: 1,
            status: "running" as const,
            failureCode: "not-terminal",
            updatedAt: acceptedAt,
          }),
        })]),
      });
      return Object.freeze({
        groupRef: request.groupRef,
        aggregateVersion: 1,
        status: "running" as const,
        aggregate: Object.freeze({ ...aggregate(1, 0), queuedCount: 0, runningCount: 1 }),
        memberPage: Object.freeze({ ...body, pageDigest: stableHash(body) }),
        observedAt: acceptedAt,
      });
    });
    const groupTools = tools({ ...baseLauncher, watchAgentGroupPage }, 1).tools;
    await launch(groupTools.start_agent_group, 1);
    await expect(execute(groupTools.watch_agent_group, { groupRef, pageSize: 1 }, "running-failure"))
      .rejects.toThrow(/Only a terminal Agent Group member may report a failure code/);
  });

  it("qualifies paged start/reopen on a real file durable store", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lh-agent-start-real-"));
    try {
      const memberCount = 128;
      const { launcher } = pagedLauncher(memberCount);
      const first = createLocalHarnessDurableServices({ rootDir: dir });
      const launched = await launch(tools(launcher, memberCount, first.tasks).tools.start_agent_group, memberCount);
      expect(launched.members).toHaveLength(memberCount);

      const reopened = createLocalHarnessDurableServices({ rootDir: dir });
      expect(await reopened.tasks.getAgentGroupPageState?.({
        sessionId: "paged-session",
        groupRef,
      })).toMatchObject({
        memberCount,
        aggregateVersion: 0,
        minimumRetainedSequence: 0,
      });
      expect(await reopened.tasks.getTask({
        sessionId: "paged-session",
        taskId: launched.members[127].taskId,
      })).toMatchObject({
        taskId: launched.members[127].taskId,
        externalAgentGroupRef: groupRef,
        externalAgentTaskRef: taskRef(127),
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("fails closed before following a symlink inside the durable ledger root", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lh-agent-root-"));
    const outside = await mkdtemp(join(tmpdir(), "lh-agent-outside-"));
    try {
      await symlink(outside, join(dir, "agent-group-task-batches"));
      const { launcher } = pagedLauncher(1);
      const services = createLocalHarnessDurableServices({ rootDir: dir });
      await expect(launch(tools(launcher, 1, services.tasks).tools.start_agent_group, 1))
        .rejects.toThrow(/symbolic links/);
      expect(await readdir(outside)).toEqual([]);
    } finally {
      await Promise.all([
        rm(dir, { recursive: true, force: true }),
        rm(outside, { recursive: true, force: true }),
      ]);
    }
  });

  it.each([1_000, 10_000])(
    "projects gap-free pages at %i members without full-snapshot ledger scans",
    async (memberCount) => {
      const { launcher } = pagedLauncher(memberCount);
      const { ledger, tools: groupTools } = tools(launcher, memberCount);
      await launch(groupTools.start_agent_group, memberCount);
      const listTasks = vi.spyOn(ledger, "listTasks");

      let pageCursor: string | undefined;
      let throughSequence = 0;
      let pageNumber = 0;
      do {
        const output = await execute(groupTools.watch_agent_group, {
          groupRef,
          ...(pageCursor === undefined ? {} : { pageCursor, afterSequence: throughSequence }),
          pageSize: 1_000,
        }, `watch-${memberCount}-${pageNumber}`);
        expect(output.memberPage.afterSequence).toBe(throughSequence);
        expect(output.memberPage.changes.map((change: { sequence: number }) => change.sequence))
          .toEqual(Array.from(
            { length: output.memberPage.throughSequence - throughSequence },
            (_, offset) => throughSequence + offset + 1,
          ));
        pageCursor = output.memberPage.nextPageCursor;
        throughSequence = output.memberPage.throughSequence;
        pageNumber += 1;
      } while (throughSequence < memberCount);

      expect(listTasks).not.toHaveBeenCalled();
      expect(await ledger.getAgentGroupPageState?.({ sessionId: "paged-session", groupRef }))
        .toMatchObject({
          aggregateVersion: memberCount,
          groupStatus: "satisfied",
          aggregate: { memberCount, succeededCount: memberCount, queuedCount: 0 },
        });
    },
    30_000,
  );

  it("touches only the bounded page on page two of a 10,000-member durable group", async () => {
    const memberCount = 10_000;
    const pageSize = 128;
    const rootDir = "/scale-observation";
    const sessionId = "paged-session";
    const scopeIdentity = "scale-scope";
    const backing = createInMemoryDurableStore();
    const operations: Array<{ kind: "read" | "write" | "list"; path: string }> = [];
    const store = {
      ...backing,
      async readJson<T>(path: string) {
        operations.push({ kind: "read" as const, path });
        return await backing.readJson<T>(path);
      },
      async writeJson(path: string, value: unknown) {
        operations.push({ kind: "write" as const, path });
        await backing.writeJson(path, value);
      },
      async listDir(path: string) {
        operations.push({ kind: "list" as const, path });
        return await backing.listDir(path);
      },
    };
    const services = createInMemoryOrchestrationServices({ store, rootDir });
    const sessionKey = stableHash({ kind: "session", sessionId }, { format: "base32hex" });
    const members = [];
    for (let memberIndex = 0; memberIndex < memberCount; memberIndex += 1) {
      const taskId = `task_${memberIndex + 1}` as HarnessTaskId;
      const record = {
        taskId,
        sessionId,
        kind: "agent" as const,
        status: "queued" as const,
        createdAt: acceptedAt,
        updatedAt: acceptedAt,
        callIdentity: `scale-call-${memberIndex}`,
        agentMemberId: `member_${memberIndex + 1}`,
        agentMemberIndex: memberIndex,
        agentGroupScopeIdentity: scopeIdentity,
        agentJoinPolicyHandle: "all",
        agentJoinPolicyKind: "all_success" as const,
        agentReductionPolicyHandle: "bounded",
        agentMaxMemberSummaryBytes: 128,
        agentMaxGroupSummaryBytes: 256,
        agentMaxResultRefs: 10_000,
      } satisfies HarnessTaskRecord;
      members.push({
        taskId,
        memberId: record.agentMemberId,
        memberIndex,
        taskRef: taskRef(memberIndex),
      });
      await backing.writeJson(
        join(rootDir, "tasks", sessionKey, `${recordKey(taskId)}.json`),
        record,
      );
    }
    expect(await services.tasks.bindAgentGroupStart?.({
      sessionId,
      scopeIdentity,
      groupRef,
      acceptedAt,
      observationMode: "paged_changes",
      members,
    })).toMatchObject({ outcome: "applied" });
    expect(operations.filter(({ kind }) => kind === "list")).toHaveLength(0);

    const watchAgentGroupPage = vi.fn(async (request: HarnessAgentGroupPageRequest) =>
      pageResult(request, memberCount));
    const { launcher } = pagedLauncher(memberCount, { watchAgentGroupPage });
    const groupTools = tools(launcher, memberCount, services.tasks).tools;
    operations.length = 0;
    const first = await execute(groupTools.watch_agent_group, {
      groupRef,
      pageSize,
    }, "scale-page-1");
    operations.length = 0;
    const second = await execute(groupTools.watch_agent_group, {
      groupRef,
      pageCursor: first.memberPage.nextPageCursor,
      afterSequence: first.memberPage.throughSequence,
      pageSize,
    }, "scale-page-2");

    const uniquePaths = (fragment: string) => new Set(
      operations.filter(({ path }) => path.includes(fragment)).map(({ path }) => path),
    );
    expect(operations.filter(({ kind }) => kind === "list")).toHaveLength(0);
    expect(uniquePaths("/members/").size).toBe(pageSize);
    expect(uniquePaths("/sequences/").size).toBeLessThanOrEqual(pageSize * 2);
    expect(uniquePaths("/receipts/").size).toBeLessThanOrEqual(2);
    expect(uniquePaths("/commits/").size).toBeLessThanOrEqual(2);
    expect(uniquePaths("/authority.json").size).toBe(1);
    expect(second.memberPage.changes).toHaveLength(pageSize);
    expect(second).not.toHaveProperty("members");
    expect(JSON.stringify(second)).not.toContain('"members"');
    const secondRequest = watchAgentGroupPage.mock.calls.at(-1)![0];
    expect(new TextEncoder().encode(JSON.stringify(second)).byteLength)
      .toBeLessThan(secondRequest.maximumBytes);
  }, 30_000);

  it("replays one cancel mutation/page projection and continues pages without re-executing mutation", async () => {
    const memberCount = 3;
    const mutationKeys = new Set<string>();
    const mutationCount = vi.fn();
    const projectionOutcomes: string[] = [];
    const baseLedger = createInMemoryTaskLedger();
    const baseProjection = baseLedger.projectAgentGroupPage!.bind(baseLedger);
    const ledger: HarnessTaskLedger = {
      ...baseLedger,
      async projectAgentGroupPage(input) {
        const result = await baseProjection(input);
        projectionOutcomes.push(result.outcome);
        return result;
      },
    };
    const { launcher } = pagedLauncher(memberCount);
    const cancelAgentGroupPage = vi.fn(async (request: Parameters<NonNullable<
      TestLauncher["cancelAgentGroupPage"]
    >>[0]) => {
      if (request.operation === "begin" && !mutationKeys.has(request.operationIdempotencyKey)) {
        mutationKeys.add(request.operationIdempotencyKey);
        mutationCount();
      }
      const memberPage = pageBody(request, memberCount, 1);
      return {
        groupRef: request.groupRef,
        aggregateVersion: memberPage.throughSequence,
        status: "cancelled" as const,
        aggregate: {
          memberCount,
          queuedCount: memberCount - memberPage.throughSequence,
          runningCount: 0,
          succeededCount: 0,
          failedCount: 0,
          cancelledCount: memberPage.throughSequence,
          timedOutCount: 0,
          verifiedSucceededCount: 0,
          resultRefCount: 0,
        },
        memberPage: {
          ...memberPage,
          changes: memberPage.changes.map((change) => ({
            ...change,
            member: { ...change.member, status: "cancelled" as const },
          })),
          pageDigest: "replaced-below",
        },
        observedAt: acceptedAt,
        operationResult: (() => {
          const body = {
            operationRef: request.operationRef ?? "cancel-operation-1",
            kind: "cancel" as const,
            resultVersion: memberCount,
            disposition: "cancelled" as const,
            completedAt: acceptedAt,
            resultRefs: Object.freeze([]),
          };
          return { ...body, resultDigest: stableHash(body) };
        })(),
      };
    });
    // Recompute the page digest after changing succeeded observations to cancelled.
    const digestingCancel = vi.fn(async (request: Parameters<typeof cancelAgentGroupPage>[0]) => {
      const value = await cancelAgentGroupPage(request);
      const { pageDigest: _ignored, ...body } = value.memberPage;
      return { ...value, memberPage: { ...body, pageDigest: stableHash(body) } };
    });
    const { tools: groupTools } = tools({ ...launcher, cancelAgentGroupPage: digestingCancel }, 3, ledger);
    await launch(groupTools.start_agent_group, memberCount);

    const first = await execute(groupTools.cancel_agent_group, { groupRef, reason: "stop" }, "cancel-1");
    expect(first.operation).toEqual({
      operationRef: "cancel-operation-1",
      resultVersion: memberCount,
      state: "pending",
    });
    expect(first.operation).not.toHaveProperty("disposition");
    expect(first.operation).not.toHaveProperty("resultRefs");
    const replay = await execute(groupTools.cancel_agent_group, { groupRef, reason: "stop" }, "cancel-1");
    await execute(groupTools.cancel_agent_group, {
      groupRef,
      operationRef: first.operation.operationRef,
      pageCursor: first.memberPage.nextPageCursor,
      afterSequence: first.memberPage.throughSequence,
    }, "cancel-2");

    expect(replay).toEqual(first);
    expect(mutationCount).toHaveBeenCalledTimes(1);
    expect(digestingCancel.mock.calls.map(([request]) => request.operation))
      .toEqual(["begin", "begin", "continue"]);
    expect(projectionOutcomes).toEqual(["applied", "replayed", "applied"]);
  });

  it("preserves typed cursor expiry and mismatch errors from a store-bound adapter", async () => {
    const { launcher } = pagedLauncher(1);
    const watchAgentGroupPage = vi.fn(async (request: HarnessAgentGroupPageRequest) => {
      if (request.pageCursor === "expired") throw new HarnessAgentGroupCursorError("expired");
      throw new HarnessAgentGroupCursorError("mismatch");
    });
    const { tools: groupTools } = tools({ ...launcher, watchAgentGroupPage }, 1);
    await launch(groupTools.start_agent_group, 1);

    await expect(execute(groupTools.watch_agent_group, {
      groupRef,
      pageCursor: "expired",
      afterSequence: 0,
    }, "expired-call")).rejects.toMatchObject({ code: "expired" });
    await expect(execute(groupTools.watch_agent_group, {
      groupRef,
      pageCursor: "forged",
      afterSequence: 0,
    }, "mismatch-call")).rejects.toMatchObject({ code: "mismatch" });
    await expect(execute(groupTools.watch_agent_group, {
      groupRef,
      pageCursor: "bad\u0000cursor",
      afterSequence: 0,
    }, "invalid-call")).rejects.toMatchObject({ code: "invalid" });
  });

  it("expires bounded replay history without silently rebinding a stable call and permits cursorless reopen", async () => {
    const memberCount = 1;
    const { launcher: baseLauncher } = pagedLauncher(memberCount);
    const watchAgentGroupPage = vi.fn(async (request: HarnessAgentGroupPageRequest) => {
      const throughSequence = request.afterSequence + 1;
      const pageBodyValue = Object.freeze({
        requestIdempotencyKey: request.requestIdempotencyKey,
        afterSequence: request.afterSequence,
        throughSequence,
        nextPageCursor: cursorFor(throughSequence),
        hasMore: false,
        changes: Object.freeze([Object.freeze({
          sequence: throughSequence,
          member: Object.freeze({
            memberId: "member_1",
            memberIndex: 0,
            taskRef: taskRef(0),
            revision: throughSequence,
            status: "running" as const,
            updatedAt: acceptedAt,
          }),
        })]),
      });
      return Object.freeze({
        groupRef: request.groupRef,
        aggregateVersion: throughSequence,
        status: "running" as const,
        aggregate: Object.freeze({
          ...aggregate(1, 0),
          queuedCount: 0,
          runningCount: 1,
        }),
        memberPage: Object.freeze({ ...pageBodyValue, pageDigest: stableHash(pageBodyValue) }),
        observedAt: acceptedAt,
      });
    });
    const { ledger, tools: groupTools } = tools(
      { ...baseLauncher, watchAgentGroupPage },
      memberCount,
    );
    await launch(groupTools.start_agent_group, memberCount);

    let pageCursor: string | undefined;
    let afterSequence = 0;
    for (let page = 0; page < 8_193; page += 1) {
      const value = await execute(groupTools.watch_agent_group, {
        groupRef,
        ...(pageCursor === undefined ? {} : { pageCursor, afterSequence }),
        pageSize: 1,
      }, `retention-page-${page}`);
      pageCursor = value.memberPage.nextPageCursor;
      afterSequence = value.memberPage.throughSequence;
    }
    expect(await ledger.getAgentGroupPageState?.({ sessionId: "paged-session", groupRef }))
      .toMatchObject({ aggregateVersion: 8_193, minimumRetainedSequence: 4_097 });

    const launcherCallsBeforeExpiredRetry = watchAgentGroupPage.mock.calls.length;
    await expect(execute(groupTools.watch_agent_group, {
      groupRef,
      pageSize: 1,
    }, "retention-page-0")).rejects.toMatchObject({ code: "expired" });
    expect(watchAgentGroupPage).toHaveBeenCalledTimes(launcherCallsBeforeExpiredRetry);
    await expect(execute(groupTools.watch_agent_group, {
      groupRef,
      pageCursor: cursorFor(0),
      afterSequence: 0,
      pageSize: 1,
    }, "retention-expired-cursor")).rejects.toMatchObject({ code: "expired" });

    const reopened = await execute(groupTools.watch_agent_group, {
      groupRef,
      pageSize: 1,
    }, "retention-cursorless-reopen");
    expect(reopened.memberPage).toMatchObject({ afterSequence: 8_193, throughSequence: 8_194 });
  }, 30_000);

  it.each(["in-memory", "durable"] as const)(
    "pins the active join page within the %s retention boundary and releases a valid cap",
    async (backend) => {
      const rootDir = `/join-begin-retention-boundary-${backend}`;
      const store = backend === "durable" ? createInMemoryDurableStore() : undefined;
      const services = backend === "durable"
        ? createInMemoryOrchestrationServices({ rootDir, store: store! })
        : undefined;
      const ledger = services?.tasks ?? createInMemoryTaskLedger();
      const task = await createDirectPagedGroup(ledger, {
        sessionId: "join-retention-session",
        scopeIdentity: "join-retention-scope",
        groupRef: "join-retention-group",
        launchCallIdentity: "join-retention-launch",
        memberCallIdentity: "join-retention-member",
        taskRef: "join-retention-task",
      });
      const scopeIdentity = task.agentGroupScopeIdentity!;
      const pageCall = (callIdentity: string, requestIdempotencyKey: string, operationKind: "watch" | "join" = "watch") => ({
        sessionId: "join-retention-session",
        scopeIdentity,
        groupRef: "join-retention-group",
        callIdentity,
        operationKind,
        canonicalInputDigest: stableHash({ callIdentity }),
        requestIdempotencyKey,
        maximumChanges: 1,
        maximumBytes: 1_000_000,
        maximumCursorBytes: 256,
      });
      const activePage = pageCall("join-retention-active-page", "join-retention-active-request", "join");
      expect(await ledger.bindAgentGroupPageCall!(activePage))
        .toMatchObject({ outcome: "applied" });
      const begin = {
        sessionId: activePage.sessionId,
        scopeIdentity,
        groupRef: activePage.groupRef,
        pageCallIdentity: activePage.callIdentity,
        requestIdempotencyKey: activePage.requestIdempotencyKey,
        operationIdempotencyKey: "join-retention-active-operation",
        mutationInputDigest: stableHash("join-retention-active-mutation"),
      };
      expect(await ledger.reserveAgentGroupJoinBegin!(begin))
        .toMatchObject({ outcome: "applied", phase: "reserved" });
      const retainedCalls = Array.from(
        { length: HARNESS_AGENT_GROUP_PAGE_RETENTION - 1 },
        (_, index) => pageCall(
          `join-retention-ordinary-${index}`,
          `join-retention-ordinary-request-${index}`,
        ),
      );
      for (const call of retainedCalls) {
        expect(await ledger.bindAgentGroupPageCall!(call)).toMatchObject({ outcome: "applied" });
      }
      const boundaryCall = pageCall("join-retention-boundary", "join-retention-boundary-request");
      expect(await ledger.bindAgentGroupPageCall!(boundaryCall)).toMatchObject({ outcome: "applied" });
      if (backend === "durable") {
        const sessionKey = stableHash(
          { kind: "session", sessionId: begin.sessionId },
          { format: "base32hex" },
        );
        const authority = await store!.readJson<any>(join(
          rootDir,
          "agent-group-pages",
          sessionKey,
          recordKey(scopeIdentity),
          "authority.json",
        ));
        expect(authority.pageCallOrder).toHaveLength(HARNESS_AGENT_GROUP_PAGE_RETENTION);
        expect(authority.pageCallOrder).toContain(activePage.callIdentity);
        expect(authority.pageCallOrder).not.toContain(retainedCalls[0]!.callIdentity);
      }
      expect(await ledger.bindAgentGroupPageCall!(activePage)).toMatchObject({ outcome: "replayed" });
      expect(await ledger.bindAgentGroupPageCall!(retainedCalls[0]!)).toMatchObject({ outcome: "expired" });

      const resultBody = Object.freeze({
        operationRef: "join-retention-active-result",
        kind: "join" as const,
        resultVersion: 0,
        disposition: "deadline" as const,
        completedAt: acceptedAt,
        resultRefs: Object.freeze([]),
      });
      const result = Object.freeze({ ...resultBody, resultDigest: stableHash(resultBody) });
      expect(await ledger.bindAgentGroupOperationResult!({
        ...begin,
        operationMode: "begin",
        authorizeVisibility: true,
        result,
      })).toMatchObject({ outcome: "applied" });
      expect(await ledger.getAgentGroupPageState!({
        sessionId: begin.sessionId,
        groupRef: begin.groupRef,
      })).toMatchObject({ groupRef: begin.groupRef });

      const nextPage = pageCall("join-retention-next-page", "join-retention-next-request", "join");
      expect(await ledger.bindAgentGroupPageCall!(nextPage)).toMatchObject({ outcome: "applied" });
      expect(await ledger.reserveAgentGroupJoinBegin!({
        ...begin,
        pageCallIdentity: nextPage.callIdentity,
        requestIdempotencyKey: nextPage.requestIdempotencyKey,
        operationIdempotencyKey: "join-retention-next-operation",
        mutationInputDigest: stableHash("join-retention-next-mutation"),
      })).toMatchObject({ outcome: "applied", phase: "reserved" });

      if (backend === "durable") {
        const restarted = createInMemoryOrchestrationServices({ rootDir, store: store! });
        expect(await restarted.tasks.getAgentGroupPageState!({
          sessionId: begin.sessionId,
          groupRef: begin.groupRef,
        })).toMatchObject({ groupRef: begin.groupRef });
      }
    },
  );

  it.each(["in-memory", "durable"] as const)(
    "rejects a join reservation after its retained page receipt expires on the %s ledger",
    async (backend) => {
      const rootDir = `/join-begin-page-receipt-race-${backend}`;
      const store = backend === "durable" ? createInMemoryDurableStore() : undefined;
      const services = backend === "durable"
        ? createInMemoryOrchestrationServices({ rootDir, store: store! })
        : undefined;
      const ledger = services?.tasks ?? createInMemoryTaskLedger();
      const task = await createDirectPagedGroup(ledger, {
        sessionId: "join-page-race-session",
        scopeIdentity: "join-page-race-scope",
        groupRef: "join-page-race-group",
        launchCallIdentity: "join-page-race-launch",
        memberCallIdentity: "join-page-race-member",
        taskRef: "join-page-race-task",
      });
      const scopeIdentity = task.agentGroupScopeIdentity!;
      const pageCall = (callIdentity: string, requestIdempotencyKey: string, operationKind: "watch" | "join") => ({
        sessionId: "join-page-race-session",
        scopeIdentity,
        groupRef: "join-page-race-group",
        callIdentity,
        operationKind,
        canonicalInputDigest: stableHash({ callIdentity, requestIdempotencyKey }),
        requestIdempotencyKey,
        maximumChanges: 1,
        maximumBytes: 1_000_000,
        maximumCursorBytes: 256,
      });
      const activePage = pageCall("join-page-race-active", "join-page-race-active-request", "join");
      expect(await ledger.bindAgentGroupPageCall!(activePage)).toMatchObject({ outcome: "applied" });
      for (let index = 0; index < HARNESS_AGENT_GROUP_PAGE_RETENTION; index += 1) {
        expect(await ledger.bindAgentGroupPageCall!(pageCall(
          `join-page-race-watch-${index}`,
          `join-page-race-watch-request-${index}`,
          "watch",
        ))).toMatchObject({ outcome: "applied" });
      }
      expect(await ledger.bindAgentGroupPageCall!(activePage)).toMatchObject({ outcome: "expired" });
      const begin = {
        sessionId: activePage.sessionId,
        scopeIdentity,
        groupRef: activePage.groupRef,
        pageCallIdentity: activePage.callIdentity,
        requestIdempotencyKey: activePage.requestIdempotencyKey,
        operationIdempotencyKey: "join-page-race-operation",
        mutationInputDigest: stableHash("join-page-race-mutation"),
      };
      expect(await ledger.reserveAgentGroupJoinBegin!(begin))
        .toMatchObject({ outcome: "inconsistent", phase: "reserved" });

      const nextPage = pageCall("join-page-race-next", "join-page-race-next-request", "join");
      expect(await ledger.bindAgentGroupPageCall!(nextPage)).toMatchObject({ outcome: "applied" });
      expect(await ledger.reserveAgentGroupJoinBegin!({
        ...begin,
        pageCallIdentity: nextPage.callIdentity,
        requestIdempotencyKey: nextPage.requestIdempotencyKey,
        operationIdempotencyKey: "join-page-race-next-operation",
        mutationInputDigest: stableHash("join-page-race-next-mutation"),
      })).toMatchObject({ outcome: "applied", phase: "reserved" });
    },
  );

  it("expires page receipts without deleting immutable operation or terminal result-ref authority", async () => {
    const rootDir = "/operation-retention";
    const backing = createInMemoryDurableStore();
    const removed: string[] = [];
    let failReceiptCleanup = false;
    const store = {
      ...backing,
      async remove(path: string) {
        removed.push(path);
        if (failReceiptCleanup && path.includes("/receipts/")) {
          failReceiptCleanup = false;
          throw new Error("retention cleanup interrupted");
        }
        await backing.remove(path);
      },
    };
    const services = createInMemoryOrchestrationServices({ rootDir, store });
    const { launcher } = pagedLauncher(1);
    const groupTools = tools(launcher, 1, services.tasks).tools;
    const launched = await launch(groupTools.start_agent_group, 1);
    const task = await services.tasks.getTask({
      sessionId: "paged-session",
      taskId: launched.members[0].taskId,
    });
    const scopeIdentity = task!.agentGroupScopeIdentity!;
    const resultRef = "durable-result-1";
    const firstCall = {
      sessionId: "paged-session",
      scopeIdentity,
      groupRef,
      callIdentity: "retained-call-1",
      operationKind: "join" as const,
      canonicalInputDigest: stableHash("retained-call-1"),
      requestIdempotencyKey: "retained-request-1",
      maximumChanges: 1,
      maximumBytes: 1_000_000,
      maximumCursorBytes: 256,
    };
    expect(await services.tasks.bindAgentGroupPageCall?.(firstCall))
      .toMatchObject({ outcome: "applied", startSequence: 0 });
    const resultAggregate = Object.freeze({ ...aggregate(1, 1), resultRefCount: 1 });
    expect(await services.tasks.projectAgentGroupPage?.({
      sessionId: "paged-session",
      scopeIdentity,
      groupRef,
      requestIdempotencyKey: firstCall.requestIdempotencyKey,
      pageDigest: stableHash("retained-page-1"),
      afterSequence: 0,
      throughSequence: 1,
      aggregateVersion: 1,
      groupStatus: "satisfied",
      aggregate: resultAggregate,
      groupObservationDigest: stableHash("retained-group-1"),
      groupObservedAt: acceptedAt,
      pageCallIdentity: firstCall.callIdentity,
      changes: [Object.freeze({
        sequence: 1,
        memberId: "member_1",
        memberIndex: 0,
        taskRef: taskRef(0),
        memberStatus: "succeeded",
        memberRevision: 1,
        memberObservationDigest: stableHash("retained-member-observation-1"),
        memberStateDigest: stableHash("retained-member-state-1"),
        memberObservedAt: acceptedAt,
        status: "completed",
        externalAgentResultRef: resultRef,
        verifiedSucceeded: false,
        hasResultRef: true,
      })],
    })).toMatchObject({ outcome: "applied" });

    const operationBody = Object.freeze({
      operationRef: "retained-operation-1",
      kind: "join" as const,
      resultVersion: 1,
      disposition: "satisfied" as const,
      completedAt: acceptedAt,
      resultRefs: Object.freeze([resultRef]),
    });
    const operationResult = Object.freeze({
      ...operationBody,
      resultDigest: stableHash(operationBody),
    });
    expect(await services.tasks.bindAgentGroupOperationResult?.({
      sessionId: "paged-session",
      scopeIdentity,
      groupRef,
      operationIdempotencyKey: "operation-key-1",
      mutationInputDigest: stableHash("join-input-1"),
      operationMode: "begin",
      result: operationResult as any,
    })).toMatchObject({ outcome: "applied" });

    const tailCall = {
      ...firstCall,
      callIdentity: "retained-tail-call",
      canonicalInputDigest: stableHash("retained-tail-call"),
      requestIdempotencyKey: "retained-tail-request",
    };
    expect(await services.tasks.bindAgentGroupPageCall?.(tailCall))
      .toMatchObject({ outcome: "applied", startSequence: 1 });
    expect(await services.tasks.projectAgentGroupPage?.({
      sessionId: "paged-session",
      scopeIdentity,
      groupRef,
      requestIdempotencyKey: tailCall.requestIdempotencyKey,
      pageDigest: stableHash("retained-tail-page"),
      afterSequence: 1,
      throughSequence: 1,
      aggregateVersion: 1,
      groupStatus: "satisfied",
      aggregate: resultAggregate,
      groupObservationDigest: stableHash("retained-group-tail"),
      groupObservedAt: acceptedAt,
      pageCallIdentity: tailCall.callIdentity,
      changes: [],
    })).toMatchObject({ outcome: "applied" });

    const sessionKey = stableHash(
      { kind: "session", sessionId: "paged-session" },
      { format: "base32hex" },
    );
    const pageDir = join(rootDir, "agent-group-pages", sessionKey, recordKey(scopeIdentity));
    const authorityPath = join(pageDir, "authority.json");
    const authority = await backing.readJson<any>(authorityPath);
    await backing.writeJson(authorityPath, {
      ...authority,
      pageCallOrder: [
        firstCall.callIdentity,
        ...Array.from({ length: 4_095 }, (_, index) => `retention-placeholder-${index}`),
      ],
      expiredPageCallOrder: [],
      pageCallsIssued: 4_096,
    });
    const boundaryCall = {
      ...firstCall,
      callIdentity: "retention-boundary-call",
      canonicalInputDigest: stableHash("retention-boundary-call"),
      requestIdempotencyKey: "retention-boundary-request",
    };
    failReceiptCleanup = true;
    await expect(services.tasks.bindAgentGroupPageCall?.(boundaryCall))
      .rejects.toThrow("retention cleanup interrupted");
    expect(await services.tasks.bindAgentGroupPageCall?.(boundaryCall))
      .toMatchObject({ outcome: "replayed", startSequence: 1 });

    expect(await services.tasks.bindAgentGroupPageCall?.(firstCall))
      .toMatchObject({ outcome: "expired" });
    expect(await services.tasks.bindAgentGroupOperationResult?.({
      sessionId: "paged-session",
      scopeIdentity,
      groupRef,
      operationIdempotencyKey: "operation-key-continuation",
      mutationInputDigest: stableHash("operation-ref-continuation"),
      operationMode: "continue",
      result: operationResult as any,
    })).toMatchObject({ outcome: "applied" });
    expect(removed.some((path) => path.includes("/receipts/"))).toBe(true);
    expect(removed.some((path) => path.includes("/operation-results/"))).toBe(false);
    expect(removed.some((path) => path.includes("/agent-group-result-ref-owners/"))).toBe(false);

    const afterBoundary = await backing.readJson<any>(authorityPath);
    await backing.writeJson(authorityPath, {
      ...afterBoundary,
      pageCallOrder: Array.from({ length: 4_096 }, (_, index) => `protected-placeholder-${index}`),
      expiredPageCallOrder: [tailCall.callIdentity],
      pendingPageCallCleanup: [tailCall.callIdentity],
      pageCallsIssued: 8_192,
    });
    for (const suffix of ["a", "b"]) {
      expect(await services.tasks.bindAgentGroupPageCall?.({
        ...firstCall,
        callIdentity: `protected-consecutive-${suffix}`,
        canonicalInputDigest: stableHash(`protected-consecutive-${suffix}`),
        requestIdempotencyKey: `protected-consecutive-request-${suffix}`,
      })).toMatchObject({ outcome: "applied" });
    }
    expect((await backing.readJson<any>(authorityPath)).pendingPageCallCleanup)
      .toEqual([tailCall.callIdentity]);

    const beforePrune = await backing.readJson<any>(authorityPath);
    await backing.writeJson(authorityPath, {
      ...beforePrune,
      state: {
        ...beforePrune.state,
        aggregateVersion: 4_098,
      },
      mirrorThroughSequence: 4_098,
    });
    const pruneCall = {
      ...firstCall,
      callIdentity: "retention-prune-call",
      canonicalInputDigest: stableHash("retention-prune-call"),
      requestIdempotencyKey: "retention-prune-request",
    };
    expect(await services.tasks.bindAgentGroupPageCall?.(pruneCall))
      .toMatchObject({ outcome: "applied", startSequence: 4_098 });
    expect(await services.tasks.projectAgentGroupPage?.({
      sessionId: "paged-session",
      scopeIdentity,
      groupRef,
      requestIdempotencyKey: pruneCall.requestIdempotencyKey,
      pageDigest: stableHash("retention-prune-page"),
      afterSequence: 4_098,
      throughSequence: 4_098,
      aggregateVersion: 4_098,
      groupStatus: "satisfied",
      aggregate: resultAggregate,
      groupObservationDigest: stableHash("retained-group-prune"),
      groupObservedAt: acceptedAt,
      pageCallIdentity: pruneCall.callIdentity,
      changes: [],
    })).toMatchObject({ outcome: "applied" });
    expect(await backing.readJson(join(pageDir, "sequences", "1.json"))).toBeUndefined();
    expect(await services.tasks.getAgentGroupPageState?.({ sessionId: "paged-session", groupRef }))
      .toMatchObject({ aggregateVersion: 4_098, minimumRetainedSequence: 2 });
    expect(await services.tasks.bindAgentGroupPageCall?.({
      ...firstCall,
      callIdentity: "retention-old-cursor",
      canonicalInputDigest: stableHash("retention-old-cursor"),
      requestIdempotencyKey: "retention-old-cursor-request",
      requestedAfterSequence: 0,
      pageCursorDigest: stableHash("old-cursor"),
    })).toMatchObject({ outcome: "expired", minimumRetainedSequence: 2 });
    expect(await services.tasks.bindAgentGroupOperationResult?.({
      sessionId: "paged-session",
      scopeIdentity,
      groupRef,
      operationIdempotencyKey: "operation-key-after-prune",
      mutationInputDigest: stableHash("operation-after-prune"),
      operationMode: "continue",
      result: operationResult as any,
    })).toMatchObject({ outcome: "applied" });
  });

  it("rejects a canonical paged result envelope above the requested byte cap", async () => {
    const memberCount = 10;
    const { launcher } = pagedLauncher(memberCount);
    const { tools: groupTools } = tools(
      launcher,
      memberCount,
      createInMemoryTaskLedger(),
      { maxMemberPageBytes: 1_024 },
    );
    await launch(groupTools.start_agent_group, memberCount);
    await expect(execute(groupTools.watch_agent_group, { groupRef }, "oversized-page"))
      .rejects.toThrow(/canonical .* byte bound/);
  });

  it.each(["map", "file"] as const)(
    "recovers committed page sequences and replays a lost response on the %s durable store",
    async (kind) => {
      const dir = kind === "file" ? await mkdtemp(join(tmpdir(), "lh-agent-pages-")) : undefined;
      const store = kind === "map" ? createInMemoryDurableStore() : undefined;
      let injected = false;
      const faultInjection = {
        onPoint(point: string) {
          if (!injected && point === "agent-group-page-projection-after-authority-commit") {
            injected = true;
            throw new Error("lost page response");
          }
        },
      };
      try {
        const firstServices = kind === "map"
          ? createInMemoryOrchestrationServices({ store: store!, faultInjection })
          : createLocalHarnessDurableServices({ rootDir: dir!, faultInjection });
        const { launcher } = pagedLauncher(3);
        const first = tools(launcher, 3, firstServices.tasks);
        const launched = await launch(first.tools.start_agent_group, 3);

        await expect(execute(first.tools.watch_agent_group, {
          groupRef,
          pageSize: 1,
        }, "lost-response-watch")).rejects.toThrow("lost page response");

        const restartedServices = kind === "map"
          ? createInMemoryOrchestrationServices({ store: store! })
          : createLocalHarnessDurableServices({ rootDir: dir! });
        const restarted = tools(launcher, 3, restartedServices.tasks);
        const replay = await execute(restarted.tools.watch_agent_group, {
          groupRef,
          pageSize: 1,
        }, "lost-response-watch");

        expect(replay.memberPage).toMatchObject({ afterSequence: 0, throughSequence: 1 });
        expect(await restartedServices.tasks.getAgentGroupPageState?.({
          sessionId: "paged-session",
          groupRef,
        })).toMatchObject({ aggregateVersion: 1, aggregate: { succeededCount: 1 } });
        expect(await restartedServices.tasks.getTask({
          sessionId: "paged-session",
          taskId: launched.members[0].taskId,
        })).toMatchObject({ status: "completed", agentMemberRevision: 1 });
      } finally {
        if (dir !== undefined) await rm(dir, { recursive: true, force: true });
      }
    },
    30_000,
  );

  it.each([
    "agent-group-page-projection-before-stage",
    "agent-group-page-projection-during-stage",
    "agent-group-page-projection-after-stage",
  ] as const)("recovers the exact request-specific provisional stage after %s", async (faultPoint) => {
    const store = createInMemoryDurableStore();
    let injected = false;
    const firstServices = createInMemoryOrchestrationServices({
      rootDir: "/stage-recovery",
      store,
      faultInjection: {
        onPoint(point) {
          if (!injected && point === faultPoint) {
            injected = true;
            throw new Error(`stage fault: ${faultPoint}`);
          }
        },
      },
    });
    const { launcher } = pagedLauncher(3);
    const first = tools(launcher, 3, firstServices.tasks);
    const launched = await launch(first.tools.start_agent_group, 3);
    await expect(execute(first.tools.watch_agent_group, {
      groupRef,
      pageSize: 3,
    }, "stage-recovery-call")).rejects.toThrow(`stage fault: ${faultPoint}`);

    const reopenedServices = createInMemoryOrchestrationServices({
      rootDir: "/stage-recovery",
      store,
    });
    const reopened = tools(launcher, 3, reopenedServices.tasks);
    const recovered = await execute(reopened.tools.watch_agent_group, {
      groupRef,
      pageSize: 3,
    }, "stage-recovery-call");
    expect(recovered.memberPage).toMatchObject({ afterSequence: 0, throughSequence: 3 });
    expect(await reopenedServices.tasks.getAgentGroupPageState?.({
      sessionId: "paged-session",
      groupRef,
    })).toMatchObject({ aggregateVersion: 3, aggregate: { succeededCount: 3 } });
    expect(await reopenedServices.tasks.getTask({
      sessionId: "paged-session",
      taskId: launched.members[2].taskId,
    })).toMatchObject({ status: "completed", agentMemberRevision: 1 });
  });

  it("binds zero-change join receipts to the exact committed authority across reordering", async () => {
    const store = createInMemoryDurableStore();
    let injected = false;
    const firstServices = createInMemoryOrchestrationServices({
      store,
      faultInjection: {
        onPoint(point) {
          if (!injected && point === "agent-group-page-projection-after-authority-commit") {
            injected = true;
            throw new Error("authority committed before receipt");
          }
        },
      },
    });
    const summaries = new Map<string, string>();
    let firstOperationIdempotencyKey: string | undefined;
    const joinAgentGroupPage = vi.fn(async (request: Parameters<NonNullable<
      TestLauncher["joinAgentGroupPage"]
    >>[0]) => {
      if (request.operation === "begin" && firstOperationIdempotencyKey === undefined) {
        firstOperationIdempotencyKey = request.operationIdempotencyKey;
      }
      const isFirstOperation = request.operationIdempotencyKey === firstOperationIdempotencyKey ||
        request.operationRef === `join-operation-${firstOperationIdempotencyKey}`;
      const summary = isFirstOperation ? "join-A" : "join-B";
      summaries.set(request.requestIdempotencyKey, summary);
      const body = Object.freeze({
        requestIdempotencyKey: request.requestIdempotencyKey,
        afterSequence: 0,
        throughSequence: 0,
        nextPageCursor: cursorFor(0),
        hasMore: false,
        changes: Object.freeze([]),
      });
      const operationBody = Object.freeze({
        operationRef: request.operationRef ?? `join-operation-${request.operationIdempotencyKey}`,
        kind: "join" as const,
        resultVersion: 0,
        disposition: "deadline" as const,
        completedAt: acceptedAt,
        summary,
        resultRefs: Object.freeze([]),
      });
      return {
        groupRef: request.groupRef,
        aggregateVersion: 0,
        status: "queued" as const,
        aggregate: aggregate(1, 0),
        memberPage: { ...body, pageDigest: stableHash(body) },
        observedAt: acceptedAt,
        operationResult: { ...operationBody, resultDigest: stableHash(operationBody) },
      };
    });
    const { launcher } = pagedLauncher(1, { joinAgentGroupPage });
    const first = tools(launcher, 1, firstServices.tasks);
    await launch(first.tools.start_agent_group, 1);
    await expect(
      execute(first.tools.join_agent_group, { groupRef }, "join-A-call"),
    ).rejects.toThrow("authority committed before receipt");
    expect(joinAgentGroupPage).toHaveBeenCalledTimes(1);

    const restartedServices = createInMemoryOrchestrationServices({ store });
    const restarted = tools(launcher, 1, restartedServices.tasks);
    const recovery = await execute(restarted.tools.join_agent_group, { groupRef }, "join-B-call");
    expect(recovery).toEqual({
      groupRef,
      operation: { operationRef: "join-operation-" + firstOperationIdempotencyKey, state: "continue_required" },
    });
    const blocked = await execute(restarted.tools.join_agent_group, { groupRef }, "join-C-call");
    expect(blocked).toEqual(recovery);
    expect(joinAgentGroupPage).toHaveBeenCalledTimes(1);

    const continued = await execute(restarted.tools.join_agent_group, {
      groupRef,
      operationRef: recovery.operation.operationRef,
    }, "join-A-continuation");
    expect(continued.operation).toMatchObject({ state: "resolved", summary: "join-A" });

    const second = await execute(restarted.tools.join_agent_group, { groupRef }, "join-B-call");
    expect(second.operation).toMatchObject({ state: "resolved", summary: "join-B" });

    const replay = await execute(restarted.tools.join_agent_group, { groupRef }, "join-A-call");
    expect(replay).toMatchObject({
      aggregateVersion: 0,
      operation: { state: "resolved", disposition: "deadline", summary: "join-A" },
      memberPage: { afterSequence: 0, throughSequence: 0 },
    });
    expect(new Set(summaries.values())).toEqual(new Set(["join-A", "join-B"]));
    expect(joinAgentGroupPage).toHaveBeenCalledTimes(4);
  });

  it.each(["in-memory", "durable"] as const)(
    "keeps a pending join owner through separately keyed completion and cancel on the %s ledger",
    async (backend) => {
      const rootDir = `/join-begin-continuation-${backend}`;
      const store = backend === "durable" ? createInMemoryDurableStore() : undefined;
      const ledger = backend === "durable"
        ? createInMemoryOrchestrationServices({ rootDir, store: store! }).tasks
        : createInMemoryTaskLedger();
      const task = await createDirectPagedGroup(ledger, {
        sessionId: "join-begin-session",
        scopeIdentity: "join-begin-scope",
        groupRef: "join-begin-group",
        launchCallIdentity: "join-begin-launch",
        memberCallIdentity: "join-begin-member",
        taskRef: "join-begin-task",
      });
      const scopeIdentity = task.agentGroupScopeIdentity!;
      const begin = {
        sessionId: "join-begin-session",
        scopeIdentity,
        groupRef: "join-begin-group",
        pageCallIdentity: "join-begin-page",
        requestIdempotencyKey: "join-begin-request",
        operationIdempotencyKey: "join-begin-operation",
        mutationInputDigest: stableHash("join-begin-mutation"),
      };
      expect(await bindDirectJoinPageCall(ledger, begin)).toMatchObject({ outcome: "applied" });
      expect(await ledger.reserveAgentGroupJoinBegin!(begin))
        .toMatchObject({ outcome: "applied", phase: "reserved" });
      const pendingBody = Object.freeze({
        operationRef: "join-begin-operation-ref",
        observedAggregateVersion: 0,
        observedAt: acceptedAt,
        retryAfterMs: 250,
      });
      const pending = Object.freeze({ ...pendingBody, pendingDigest: stableHash(pendingBody) });
      expect(await ledger.bindAgentGroupPendingOperation!({
        ...begin,
        operationMode: "begin",
        pending,
      })).toMatchObject({ outcome: "applied" });
      expect(await ledger.bindAgentGroupPendingOperation!({
        ...begin,
        operationIdempotencyKey: "join-begin-pending-continuation",
        mutationInputDigest: stableHash("join-begin-pending-continuation"),
        operationMode: "continue",
        pageCallIdentity: "join-begin-pending-continuation-page",
        requestIdempotencyKey: "join-begin-pending-continuation-request",
        pending,
      })).toMatchObject({ outcome: "replayed" });

      const cancelBody = Object.freeze({
        operationRef: "join-begin-cancel-ref",
        kind: "cancel" as const,
        resultVersion: 0,
        disposition: "already_terminal" as const,
        completedAt: acceptedAt,
        resultRefs: Object.freeze([]),
      });
      expect(await ledger.bindAgentGroupOperationResult!({
        sessionId: begin.sessionId,
        scopeIdentity,
        groupRef: begin.groupRef,
        operationIdempotencyKey: "join-begin-cancel-operation",
        mutationInputDigest: stableHash("join-begin-cancel-mutation"),
        operationMode: "begin",
        result: Object.freeze({ ...cancelBody, resultDigest: stableHash(cancelBody) }),
      })).toMatchObject({ outcome: "applied" });
      expect(await ledger.reserveAgentGroupJoinBegin!({
        ...begin,
        operationIdempotencyKey: "join-begin-new-operation",
        mutationInputDigest: stableHash("join-begin-new-mutation"),
      })).toMatchObject({ outcome: "conflict" });

      const terminalBody = Object.freeze({
        operationRef: pending.operationRef,
        kind: "join" as const,
        resultVersion: 0,
        disposition: "deadline" as const,
        completedAt: acceptedAt,
        resultRefs: Object.freeze([]),
      });
      const terminal = Object.freeze({ ...terminalBody, resultDigest: stableHash(terminalBody) });
      const continuation = {
        sessionId: begin.sessionId,
        scopeIdentity,
        groupRef: begin.groupRef,
        operationIdempotencyKey: "join-begin-continuation-operation",
        mutationInputDigest: stableHash("join-begin-continuation-mutation"),
        operationMode: "continue" as const,
        pageCallIdentity: "join-begin-continuation-page",
        requestIdempotencyKey: "join-begin-continuation-request",
        result: terminal,
      };
      expect(await ledger.bindAgentGroupOperationResult!(continuation))
        .toMatchObject({ outcome: "applied" });
      expect(await ledger.reserveAgentGroupJoinBegin!({
        ...begin,
        operationIdempotencyKey: "join-begin-new-operation-2",
        mutationInputDigest: stableHash("join-begin-new-mutation-2"),
      })).toMatchObject({ outcome: "conflict" });
      expect(await ledger.bindAgentGroupOperationResult!({
        ...continuation,
        authorizeVisibility: true,
      })).toMatchObject({ outcome: "applied" });
      expect(await ledger.bindAgentGroupPendingOperation!({
        ...begin,
        operationMode: "begin",
        pending,
      })).toMatchObject({ outcome: "replayed" });
      expect(await ledger.reserveAgentGroupJoinBegin!({
        ...begin,
        operationIdempotencyKey: "join-begin-new-operation-3",
        mutationInputDigest: stableHash("join-begin-new-mutation-3"),
      })).toMatchObject({ outcome: "applied", phase: "reserved" });
    },
  );

  it("publishes an immediate terminal begin alias before result bytes", async () => {
    const rootDir = "/join-begin-result-alias-crash";
    const store = createInMemoryDurableStore();
    let injected = false;
    const first = createInMemoryOrchestrationServices({
      rootDir,
      store,
      faultInjection: {
        onPoint(point) {
          if (!injected && point === "agent-group-result-after-alias-before-write") {
            injected = true;
            throw new Error("join result alias crash");
          }
        },
      },
    });
    const task = await createDirectPagedGroup(first.tasks, {
      sessionId: "join-result-alias-session",
      scopeIdentity: "join-result-alias-scope",
      groupRef: "join-result-alias-group",
      launchCallIdentity: "join-result-alias-launch",
      memberCallIdentity: "join-result-alias-member",
      taskRef: "join-result-alias-task",
    });
    const input = {
      sessionId: "join-result-alias-session",
      scopeIdentity: task.agentGroupScopeIdentity!,
      groupRef: "join-result-alias-group",
      pageCallIdentity: "join-result-alias-page",
      requestIdempotencyKey: "join-result-alias-request",
      operationIdempotencyKey: "join-result-alias-operation",
      mutationInputDigest: stableHash("join-result-alias-mutation"),
    };
    expect(await bindDirectJoinPageCall(first.tasks, input)).toMatchObject({ outcome: "applied" });
    expect(await first.tasks.reserveAgentGroupJoinBegin!(input))
      .toMatchObject({ outcome: "applied", phase: "reserved" });
    const resultBody = Object.freeze({
      operationRef: "join-result-alias-operation-ref",
      kind: "join" as const,
      resultVersion: 0,
      disposition: "deadline" as const,
      completedAt: acceptedAt,
      resultRefs: Object.freeze([]),
    });
    const result = Object.freeze({ ...resultBody, resultDigest: stableHash(resultBody) });
    await expect(first.tasks.bindAgentGroupOperationResult!({
      ...input,
      operationMode: "begin",
      result,
    })).rejects.toThrow("join result alias crash");

    const sessionKey = stableHash(
      { kind: "session", sessionId: input.sessionId },
      { format: "base32hex" },
    );
    const pageDir = join(rootDir, "agent-group-pages", sessionKey, recordKey(input.scopeIdentity));
    expect(await store.readJson(join(
      pageDir,
      "operation-idempotency",
      `${recordKey(input.operationIdempotencyKey)}.json`,
    ))).toMatchObject({
      operationRef: result.operationRef,
      operationMode: "begin",
      mutationInputDigest: input.mutationInputDigest,
    });
    expect(await store.readJson(join(
      pageDir,
      "operation-results",
      `${recordKey(result.operationRef)}.json`,
    ))).toBeUndefined();

    const restarted = createInMemoryOrchestrationServices({ rootDir, store });
    expect(await restarted.tasks.reserveAgentGroupJoinBegin!(input))
      .toMatchObject({ outcome: "ref_bound", phase: "ref_bound", operationRef: result.operationRef });
    expect(await restarted.tasks.reserveAgentGroupJoinBegin!({
      ...input,
      operationIdempotencyKey: "join-result-alias-other-operation",
      mutationInputDigest: stableHash("join-result-alias-other-mutation"),
    })).toMatchObject({ outcome: "conflict", operationRef: result.operationRef });
  });

  it.each(["pending", "terminal"] as const)(
    "consumes a ref-bound %s recovery through a separately keyed continuation",
    async (recoveryPhase) => {
      const rootDir = `/join-begin-ref-bound-${recoveryPhase}`;
      const store = createInMemoryDurableStore();
      let injected = false;
      const operationRef = `join-ref-bound-${recoveryPhase}-operation-ref`;
      const pendingBody = Object.freeze({
        operationRef,
        observedAggregateVersion: 0,
        observedAt: acceptedAt,
        retryAfterMs: 250,
      });
      const pending = Object.freeze({ ...pendingBody, pendingDigest: stableHash(pendingBody) });
      const resultBody = Object.freeze({
        operationRef,
        kind: "join" as const,
        resultVersion: 0,
        disposition: "deadline" as const,
        completedAt: acceptedAt,
        resultRefs: Object.freeze([]),
      });
      const terminal = Object.freeze({ ...resultBody, resultDigest: stableHash(resultBody) });
      const joinAgentGroupPage = vi.fn(async (
        request: Parameters<NonNullable<TestLauncher["joinAgentGroupPage"]>>[0],
      ) => {
        if (request.operation === "begin") {
          if (recoveryPhase === "pending") {
            return {
              groupRef: request.groupRef,
              aggregateVersion: 0,
              status: "queued" as const,
              aggregate: aggregate(1, 0),
              memberPage: pageBody(request, 0),
              observedAt: acceptedAt,
              pendingOperation: pending,
            };
          }
        }
        const memberPage = pageBody(request, 0);
        return {
          groupRef: request.groupRef,
          aggregateVersion: 0,
          status: "queued" as const,
          aggregate: aggregate(1, 0),
          memberPage,
          observedAt: acceptedAt,
          operationResult: terminal,
        };
      });
      const { launcher } = pagedLauncher(1, { joinAgentGroupPage });
      const firstServices = createInMemoryOrchestrationServices({
        rootDir,
        store,
        faultInjection: {
          onPoint(point) {
            if (!injected && ((recoveryPhase === "pending" &&
                point === "agent-group-pending-after-alias-before-write") ||
                (recoveryPhase === "terminal" &&
                  point === "agent-group-result-after-alias-before-write"))) {
              injected = true;
              throw new Error(`${recoveryPhase} payload crash`);
            }
          },
        },
      });
      await createDirectPagedGroup(firstServices.tasks, {
        sessionId: "paged-session",
        scopeIdentity: `join-ref-bound-${recoveryPhase}-scope`,
        groupRef,
        launchCallIdentity: `join-ref-bound-${recoveryPhase}-launch`,
        memberCallIdentity: `join-ref-bound-${recoveryPhase}-member`,
        taskRef: `join-ref-bound-${recoveryPhase}-task` as HarnessExternalAgentTaskRef,
      });
      const first = tools(launcher, 1, firstServices.tasks);
      await expect(
        execute(first.tools.join_agent_group, { groupRef },
          `join-ref-bound-${recoveryPhase}-begin`),
      ).rejects.toThrow(`${recoveryPhase} payload crash`);
      expect(joinAgentGroupPage).toHaveBeenCalledTimes(1);

      const restartedServices = createInMemoryOrchestrationServices({ rootDir, store });
      const restartedTasks = restartedServices.tasks;
      const restarted = tools(launcher, 1, restartedTasks);
      const firstRecovery = await execute(restarted.tools.join_agent_group, { groupRef },
        `join-ref-bound-${recoveryPhase}-other-begin`);
      expect(firstRecovery).toEqual({
        groupRef,
        operation: { operationRef, state: "continue_required" },
      });
      const blocked = await execute(restarted.tools.join_agent_group, { groupRef },
        `join-ref-bound-${recoveryPhase}-blocked-begin`);
      expect(blocked).toEqual(firstRecovery);
      expect(joinAgentGroupPage).toHaveBeenCalledTimes(1);

      const continued = await execute(restarted.tools.join_agent_group, {
        groupRef,
        operationRef,
      }, `join-ref-bound-${recoveryPhase}-continue`);
      expect(continued.operation).toMatchObject({ state: "resolved", disposition: "deadline" });
      expect(joinAgentGroupPage).toHaveBeenCalledTimes(2);

      const replay = await execute(restarted.tools.join_agent_group, {
        groupRef,
        operationRef,
      }, `join-ref-bound-${recoveryPhase}-continue-replay`);
      expect(replay.operation).toMatchObject({ state: "resolved", disposition: "deadline" });
      expect(joinAgentGroupPage).toHaveBeenCalledTimes(3);
    },
  );

  it("does not release a durable begin fence from mismatched terminal visibility bytes", async () => {
    const rootDir = "/join-begin-corrupt-visibility";
    const store = createInMemoryDurableStore();
    const services = createInMemoryOrchestrationServices({ rootDir, store });
    const task = await createDirectPagedGroup(services.tasks, {
      sessionId: "join-corrupt-session",
      scopeIdentity: "join-corrupt-scope",
      groupRef: "join-corrupt-group",
      launchCallIdentity: "join-corrupt-launch",
      memberCallIdentity: "join-corrupt-member",
      taskRef: "join-corrupt-task",
    });
    const input = {
      sessionId: "join-corrupt-session",
      scopeIdentity: task.agentGroupScopeIdentity!,
      groupRef: "join-corrupt-group",
      pageCallIdentity: "join-corrupt-page",
      requestIdempotencyKey: "join-corrupt-request",
      operationIdempotencyKey: "join-corrupt-operation",
      mutationInputDigest: stableHash("join-corrupt-mutation"),
    };
    expect(await bindDirectJoinPageCall(services.tasks, input)).toMatchObject({ outcome: "applied" });
    expect(await services.tasks.reserveAgentGroupJoinBegin!(input))
      .toMatchObject({ outcome: "applied", phase: "reserved" });
    const resultBody = Object.freeze({
      operationRef: "join-corrupt-operation-ref",
      kind: "join" as const,
      resultVersion: 0,
      disposition: "deadline" as const,
      completedAt: acceptedAt,
      resultRefs: Object.freeze([]),
    });
    const result = Object.freeze({ ...resultBody, resultDigest: stableHash(resultBody) });
    expect(await services.tasks.bindAgentGroupOperationResult!({
      ...input,
      operationMode: "begin",
      result,
    })).toMatchObject({ outcome: "applied" });
    const sessionKey = stableHash(
      { kind: "session", sessionId: input.sessionId },
      { format: "base32hex" },
    );
    const pageDir = join(rootDir, "agent-group-pages", sessionKey, recordKey(input.scopeIdentity));
    await store.writeJson(join(
      pageDir,
      "operation-visibility",
      `${recordKey(result.operationRef)}.json`,
    ), {
      schemaVersion: "little-harness.agent-group-operation-visibility.v1",
      sessionId: input.sessionId,
      scopeIdentity: input.scopeIdentity,
      groupRef: input.groupRef,
      operationRef: result.operationRef,
      resultDigest: stableHash("wrong-result"),
      resultVersion: result.resultVersion,
    });
    await expect(services.tasks.reserveAgentGroupJoinBegin!(input))
      .rejects.toThrow("visibility authority is invalid");
    expect(await services.tasks.reserveAgentGroupJoinBegin!({
      ...input,
      operationIdempotencyKey: "join-corrupt-other-operation",
      mutationInputDigest: stableHash("join-corrupt-other-mutation"),
    })).toMatchObject({ outcome: "conflict" });
  });

  it("does not release a durable pending begin fence from corrupt visibility on replay", async () => {
    const rootDir = "/join-begin-pending-corrupt-visibility";
    const store = createInMemoryDurableStore();
    const services = createInMemoryOrchestrationServices({ rootDir, store });
    const task = await createDirectPagedGroup(services.tasks, {
      sessionId: "join-pending-corrupt-session",
      scopeIdentity: "join-pending-corrupt-scope",
      groupRef: "join-pending-corrupt-group",
      launchCallIdentity: "join-pending-corrupt-launch",
      memberCallIdentity: "join-pending-corrupt-member",
      taskRef: "join-pending-corrupt-task",
    });
    const input = {
      sessionId: "join-pending-corrupt-session",
      scopeIdentity: task.agentGroupScopeIdentity!,
      groupRef: "join-pending-corrupt-group",
      pageCallIdentity: "join-pending-corrupt-page",
      requestIdempotencyKey: "join-pending-corrupt-request",
      operationIdempotencyKey: "join-pending-corrupt-operation",
      mutationInputDigest: stableHash("join-pending-corrupt-mutation"),
    };
    const pendingBody = Object.freeze({
      operationRef: "join-pending-corrupt-operation-ref",
      observedAggregateVersion: 0,
      observedAt: acceptedAt,
      retryAfterMs: 250,
    });
    const pending = Object.freeze({ ...pendingBody, pendingDigest: stableHash(pendingBody) });
    const terminalBody = Object.freeze({
      operationRef: pending.operationRef,
      kind: "join" as const,
      resultVersion: 0,
      disposition: "deadline" as const,
      completedAt: acceptedAt,
      resultRefs: Object.freeze([]),
    });
    const terminal = Object.freeze({ ...terminalBody, resultDigest: stableHash(terminalBody) });
    expect(await bindDirectJoinPageCall(services.tasks, input)).toMatchObject({ outcome: "applied" });
    expect(await services.tasks.reserveAgentGroupJoinBegin!(input))
      .toMatchObject({ outcome: "applied", phase: "reserved" });
    expect(await services.tasks.bindAgentGroupPendingOperation!({
      ...input,
      operationMode: "begin",
      pending,
    })).toMatchObject({ outcome: "applied" });
    expect(await services.tasks.bindAgentGroupOperationResult!({
      ...input,
      operationIdempotencyKey: "join-pending-corrupt-continuation",
      mutationInputDigest: stableHash("join-pending-corrupt-continuation"),
      operationMode: "continue",
      result: terminal,
    })).toMatchObject({ outcome: "applied" });

    const sessionKey = stableHash(
      { kind: "session", sessionId: input.sessionId },
      { format: "base32hex" },
    );
    const pageDir = join(rootDir, "agent-group-pages", sessionKey, recordKey(input.scopeIdentity));
    await store.writeJson(join(
      pageDir,
      "operation-visibility",
      `${recordKey(terminal.operationRef)}.json`,
    ), {
      schemaVersion: "little-harness.agent-group-operation-visibility.v1",
      sessionId: input.sessionId,
      scopeIdentity: input.scopeIdentity,
      groupRef: input.groupRef,
      operationRef: terminal.operationRef,
      resultDigest: stableHash("wrong-result"),
      resultVersion: terminal.resultVersion,
    });
    expect(await services.tasks.bindAgentGroupPendingOperation!({
      ...input,
      operationMode: "begin",
      pending,
    })).toMatchObject({ outcome: "replayed" });
    const otherBegin = {
      ...input,
      pageCallIdentity: "join-pending-corrupt-other-page",
      requestIdempotencyKey: "join-pending-corrupt-other-request",
      operationIdempotencyKey: "join-pending-corrupt-other-operation",
      mutationInputDigest: stableHash("join-pending-corrupt-other-mutation"),
    };
    expect(await bindDirectJoinPageCall(services.tasks, otherBegin)).toMatchObject({ outcome: "applied" });
    expect(await services.tasks.reserveAgentGroupJoinBegin!(otherBegin))
      .toMatchObject({ outcome: "conflict", operationRef: pending.operationRef });
  });

  it("does not release a durable terminal begin fence from mismatched visibility on result replay", async () => {
    const rootDir = "/join-begin-result-corrupt-visibility";
    const store = createInMemoryDurableStore();
    const services = createInMemoryOrchestrationServices({ rootDir, store });
    const task = await createDirectPagedGroup(services.tasks, {
      sessionId: "join-result-corrupt-session",
      scopeIdentity: "join-result-corrupt-scope",
      groupRef: "join-result-corrupt-group",
      launchCallIdentity: "join-result-corrupt-launch",
      memberCallIdentity: "join-result-corrupt-member",
      taskRef: "join-result-corrupt-task",
    });
    const input = {
      sessionId: "join-result-corrupt-session",
      scopeIdentity: task.agentGroupScopeIdentity!,
      groupRef: "join-result-corrupt-group",
      pageCallIdentity: "join-result-corrupt-page",
      requestIdempotencyKey: "join-result-corrupt-request",
      operationIdempotencyKey: "join-result-corrupt-operation",
      mutationInputDigest: stableHash("join-result-corrupt-mutation"),
    };
    const resultBody = Object.freeze({
      operationRef: "join-result-corrupt-operation-ref",
      kind: "join" as const,
      resultVersion: 0,
      disposition: "deadline" as const,
      completedAt: acceptedAt,
      resultRefs: Object.freeze([]),
    });
    const result = Object.freeze({ ...resultBody, resultDigest: stableHash(resultBody) });
    expect(await bindDirectJoinPageCall(services.tasks, input)).toMatchObject({ outcome: "applied" });
    expect(await services.tasks.reserveAgentGroupJoinBegin!(input))
      .toMatchObject({ outcome: "applied", phase: "reserved" });
    expect(await services.tasks.bindAgentGroupOperationResult!({
      ...input,
      operationMode: "begin",
      result,
    })).toMatchObject({ outcome: "applied" });

    const sessionKey = stableHash(
      { kind: "session", sessionId: input.sessionId },
      { format: "base32hex" },
    );
    const pageDir = join(rootDir, "agent-group-pages", sessionKey, recordKey(input.scopeIdentity));
    await store.writeJson(join(
      pageDir,
      "operation-visibility",
      `${recordKey(result.operationRef)}.json`,
    ), {
      schemaVersion: "little-harness.agent-group-operation-visibility.v1",
      sessionId: input.sessionId,
      scopeIdentity: input.scopeIdentity,
      groupRef: input.groupRef,
      operationRef: result.operationRef,
      resultDigest: stableHash("wrong-result"),
      resultVersion: result.resultVersion,
    });
    try {
      const replay = await services.tasks.bindAgentGroupOperationResult!({
        ...input,
        operationMode: "begin",
        result,
      });
      expect(replay).toMatchObject({ outcome: "conflict" });
    } catch (error) {
      expect(error).toMatchObject({ message: expect.stringContaining("visibility authority is invalid") });
    }
    const otherBegin = {
      ...input,
      pageCallIdentity: "join-result-corrupt-other-page",
      requestIdempotencyKey: "join-result-corrupt-other-request",
      operationIdempotencyKey: "join-result-corrupt-other-operation",
      mutationInputDigest: stableHash("join-result-corrupt-other-mutation"),
    };
    expect(await bindDirectJoinPageCall(services.tasks, otherBegin)).toMatchObject({ outcome: "applied" });
    expect(await services.tasks.reserveAgentGroupJoinBegin!(otherBegin))
      .toMatchObject({ outcome: "conflict", operationRef: result.operationRef });
  });

  it("returns a durable pending join reference without inventing a deadline result", async () => {
    const pendingRefs = new Map<string, string>();
    const joinAgentGroupPage = vi.fn(async (request: Parameters<NonNullable<
      TestLauncher["joinAgentGroupPage"]
    >>[0]) => {
      const operationRef = request.operationRef ??
        pendingRefs.get(request.operationIdempotencyKey) ??
        `pending-${request.operationIdempotencyKey}`;
      pendingRefs.set(request.operationIdempotencyKey, operationRef);
      if (request.operation === "continue") {
        const page = Object.freeze({
          requestIdempotencyKey: request.requestIdempotencyKey,
          afterSequence: request.afterSequence,
          throughSequence: request.afterSequence + 1,
          nextPageCursor: cursorFor(request.afterSequence + 1),
          hasMore: false,
          changes: Object.freeze([Object.freeze({
            sequence: request.afterSequence + 1,
            member: Object.freeze({
              memberId: "member_1",
              memberIndex: 0,
              taskRef: taskRef(0),
              revision: 1,
              status: "succeeded" as const,
              updatedAt: acceptedAt,
            }),
          })]),
        });
        const operationBody = Object.freeze({
          operationRef,
          kind: "join" as const,
          resultVersion: page.throughSequence,
          disposition: "satisfied" as const,
          completedAt: acceptedAt,
          resultRefs: Object.freeze([]),
        });
        return Object.freeze({
          groupRef: request.groupRef,
          aggregateVersion: page.throughSequence,
          status: "satisfied" as const,
          aggregate: aggregate(1, 1),
          memberPage: Object.freeze({ ...page, pageDigest: stableHash(page) }),
          observedAt: acceptedAt,
          operationResult: Object.freeze({
            ...operationBody,
            resultDigest: stableHash(operationBody),
          }),
        });
      }
      const page = Object.freeze({
        requestIdempotencyKey: request.requestIdempotencyKey,
        afterSequence: request.afterSequence,
        throughSequence: request.afterSequence,
        nextPageCursor: cursorFor(request.afterSequence),
        hasMore: false,
        changes: Object.freeze([]),
      });
      const pending = Object.freeze({
        operationRef,
        observedAggregateVersion: request.afterSequence,
        observedAt: acceptedAt,
        retryAfterMs: 250,
      });
      return Object.freeze({
        groupRef: request.groupRef,
        aggregateVersion: request.afterSequence,
        status: "queued" as const,
        aggregate: aggregate(1, 0),
        memberPage: Object.freeze({ ...page, pageDigest: stableHash(page) }),
        observedAt: acceptedAt,
        pendingOperation: Object.freeze({
          ...pending,
          pendingDigest: stableHash(pending),
        }),
      });
    });
    const { launcher } = pagedLauncher(1, { joinAgentGroupPage });
    const groupTools = tools(launcher, 1, createInMemoryTaskLedger());
    await launch(groupTools.tools.start_agent_group, 1);

    const first = await execute(groupTools.tools.join_agent_group, {
      groupRef,
      maxWaitMs: 10,
    }, "pending-join-begin");
    expect(first).toMatchObject({
      status: "queued",
      operation: {
        state: "waiting",
        observedAggregateVersion: 0,
        retryAfterMs: 250,
      },
      memberPage: { afterSequence: 0, throughSequence: 0 },
    });

    const continued = await execute(groupTools.tools.join_agent_group, {
      groupRef,
      operationRef: first.operation.operationRef,
    }, "pending-join-continue");
    expect(continued.operation).toMatchObject({
      operationRef: first.operation.operationRef,
      state: "resolved",
      disposition: "satisfied",
    });
    const replay = await execute(groupTools.tools.join_agent_group, {
      groupRef,
      operationRef: first.operation.operationRef,
    }, "pending-join-continue");
    expect(replay.operation).toEqual(continued.operation);
    expect(joinAgentGroupPage).toHaveBeenCalledTimes(3);
    expect(joinAgentGroupPage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        operation: "continue",
        operationRef: first.operation.operationRef,
      }),
    );
  });

  it("recovers a one-shot launcher fault on a known join operation", async () => {
    let injected = false;
    const { launcher: baseLauncher } = pagedLauncher(1);
    const joinAgentGroupPage = vi.fn(async (
      request: Parameters<NonNullable<TestLauncher["joinAgentGroupPage"]>>[0],
    ) => {
      if (request.operation === "begin") {
        const pendingBody = {
          operationRef: "launcher-fault-operation",
          observedAggregateVersion: 0,
          observedAt: acceptedAt,
          retryAfterMs: 1,
        };
        return {
          groupRef: request.groupRef,
          aggregateVersion: 0,
          status: "queued" as const,
          aggregate: aggregate(1, 0),
          memberPage: pageBody(request, 0),
          observedAt: acceptedAt,
          pendingOperation: {
            ...pendingBody,
            pendingDigest: stableHash(pendingBody),
          },
        };
      }
      if (!injected) {
        injected = true;
        throw new Error("transient launcher response loss");
      }
      return await baseLauncher.joinAgentGroupPage!(request);
    });
    const { tools: groupTools } = tools(
      { ...baseLauncher, joinAgentGroupPage },
      1,
    );
    await launch(groupTools.start_agent_group, 1);

    const pending = await execute(
      groupTools.join_agent_group,
      { groupRef },
      "launcher-fault-begin",
    );
    expect(pending.operation).toMatchObject({
      operationRef: "launcher-fault-operation",
      state: "waiting",
    });

    const recovery = await execute(
      groupTools.join_agent_group,
      { groupRef, operationRef: pending.operation.operationRef },
      "launcher-fault-continue-1",
    );
    expect(recovery).toEqual({
      groupRef,
      operation: {
        operationRef: "launcher-fault-operation",
        state: "continue_required",
      },
    });

    const resolved = await execute(
      groupTools.join_agent_group,
      { groupRef, operationRef: recovery.operation.operationRef },
      "launcher-fault-continue-2",
    );
    expect(resolved.operation).toMatchObject({
      state: "resolved",
      disposition: "satisfied",
    });
    expect(joinAgentGroupPage).toHaveBeenCalledTimes(3);
  });

  it("surfaces a deterministic result-reference binding inconsistency", async () => {
    const { launcher: baseLauncher } = pagedLauncher(1);
    const operationRef = "deterministic-binding-operation";
    const runningMember = Object.freeze({
      memberId: "member_1",
      memberIndex: 0,
      taskRef: taskRef(0),
      revision: 1,
      status: "running" as const,
      summary: "running",
      updatedAt: acceptedAt,
    });
    const runningPage = (request: Parameters<NonNullable<TestLauncher["joinAgentGroupPage"]>>[0]) => {
      const body = Object.freeze({
        requestIdempotencyKey: request.requestIdempotencyKey,
        afterSequence: request.afterSequence,
        throughSequence: request.afterSequence + 1,
        nextPageCursor: cursorFor(request.afterSequence + 1),
        hasMore: false,
        changes: Object.freeze([Object.freeze({
          sequence: request.afterSequence + 1,
          kind: "member" as const,
          member: runningMember,
        })]),
      });
      return Object.freeze({ ...body, pageDigest: stableHash(body) });
    };
    const terminalPage = (request: Parameters<NonNullable<TestLauncher["joinAgentGroupPage"]>>[0]) => {
      const terminalMember = Object.freeze({
        memberId: "member_1",
        memberIndex: 0,
        taskRef: taskRef(0),
        revision: 2,
        status: "succeeded" as const,
        summary: "done-1",
        resultRef: "member-result-ref" as HarnessExternalAgentResultRef,
        updatedAt: acceptedAt,
      });
      const controlSequence = request.afterSequence + 1;
      const memberSequence = request.afterSequence + 2;
      const controlBody = Object.freeze({
        sequence: controlSequence,
        kind: "group_control" as const,
        status: "satisfied" as const,
        observedAt: acceptedAt,
      });
      const body = Object.freeze({
        requestIdempotencyKey: request.requestIdempotencyKey,
        afterSequence: request.afterSequence,
        throughSequence: memberSequence,
        nextPageCursor: cursorFor(memberSequence),
        hasMore: false,
        changes: Object.freeze([
          Object.freeze({
            ...controlBody,
            controlDigest: stableHash(controlBody),
          }),
          Object.freeze({
            sequence: memberSequence,
            kind: "member" as const,
            member: terminalMember,
          }),
        ]),
      });
      return Object.freeze({ ...body, pageDigest: stableHash(body) });
    };
    const joinAgentGroupPage = vi.fn(async (
      request: Parameters<NonNullable<TestLauncher["joinAgentGroupPage"]>>[0],
    ) => {
      if (request.operation === "begin") {
        const pendingBody = {
          operationRef,
          observedAggregateVersion: 1,
          observedAt: acceptedAt,
          retryAfterMs: 1,
        };
        return {
          groupRef: request.groupRef,
          aggregateVersion: 1,
          status: "running" as const,
          aggregate: runningAggregate(1),
          memberPage: runningPage(request),
          observedAt: acceptedAt,
          pendingOperation: {
            ...pendingBody,
            pendingDigest: stableHash(pendingBody),
          },
        };
      }
      const memberPage = terminalPage(request);
      const operationBody = {
        operationRef,
        kind: "join" as const,
        resultVersion: 3,
        disposition: "satisfied" as const,
        completedAt: acceptedAt,
        resultRefs: Object.freeze(["group-result-ref" as HarnessExternalAgentResultRef]),
      };
      const operationResult = {
        ...operationBody,
        resultDigest: stableHash(operationBody),
      };
      return {
        groupRef: request.groupRef,
        aggregateVersion: 3,
        status: "satisfied" as const,
        aggregate: { ...aggregate(1, 1), resultRefCount: 1 },
        memberPage,
        observedAt: acceptedAt,
        operationResult,
      };
    });
    const { tools: groupTools } = tools(
      { ...baseLauncher, joinAgentGroupPage },
      1,
    );
    await launch(groupTools.start_agent_group, 1);

    const pending = await execute(
      groupTools.join_agent_group,
      { groupRef },
      "inconsistent-result-begin",
    );
    expect(pending.operation).toMatchObject({
      operationRef,
      state: "waiting",
    });
    await expect(
      execute(
        groupTools.join_agent_group,
        { groupRef, operationRef },
        "inconsistent-result",
      ),
    ).rejects.toMatchObject({
      message: "Agent Group operation result did not converge to immutable authority.",
      details: { bindingOutcome: "inconsistent" },
    });
    expect(joinAgentGroupPage).toHaveBeenCalledTimes(2);
  });

  it.each(["in-memory", "durable"] as const)(
    "binds a pending join to its first terminal continuation through the %s authority",
    async (backend) => {
      const rootDir = `/pending-terminal-${backend}`;
      const store = backend === "durable" ? createInMemoryDurableStore() : undefined;
      const ledger = backend === "durable"
        ? createInMemoryOrchestrationServices({ rootDir, store: store! }).tasks
        : createInMemoryTaskLedger();
      const task = await createDirectPagedGroup(ledger, {
        sessionId: "pending-terminal-session",
        scopeIdentity: "pending-terminal-scope",
        groupRef: "pending-terminal-group",
        launchCallIdentity: "pending-terminal-launch",
        memberCallIdentity: "pending-terminal-member",
        taskRef: "pending-terminal-task",
      });
      const scopeIdentity = task.agentGroupScopeIdentity!;
      const pendingBody = Object.freeze({
        operationRef: "pending-terminal-operation",
        observedAggregateVersion: 0,
        observedAt: acceptedAt,
        retryAfterMs: 250,
      });
      const pending = Object.freeze({
        ...pendingBody,
        pendingDigest: stableHash(pendingBody),
      });
      const beginBinding = {
        sessionId: "pending-terminal-session",
        scopeIdentity,
        groupRef: "pending-terminal-group",
        operationIdempotencyKey: "pending-terminal-begin",
        mutationInputDigest: stableHash("pending-terminal-begin-input"),
        operationMode: "begin" as const,
        pending,
      };
      expect(await ledger.bindAgentGroupPendingOperation!(beginBinding))
        .toMatchObject({ outcome: "applied" });
      expect(await ledger.bindAgentGroupPendingOperation!(beginBinding))
        .toMatchObject({ outcome: "replayed" });
      expect(await ledger.bindAgentGroupPendingOperation!({
        ...beginBinding,
        mutationInputDigest: stableHash("pending-terminal-wrong-input"),
      })).toMatchObject({ outcome: "conflict" });

      expect(await ledger.bindAgentGroupOperationResult!({
        ...beginBinding,
        operationIdempotencyKey: "pending-terminal-wrong-kind",
        mutationInputDigest: stableHash("pending-terminal-wrong-kind-input"),
        operationMode: "continue",
        result: Object.freeze({
          operationRef: pending.operationRef,
          kind: "cancel" as const,
          resultVersion: 0,
          disposition: "already_terminal" as const,
          completedAt: acceptedAt,
          resultRefs: Object.freeze([]),
          resultDigest: stableHash({
            operationRef: pending.operationRef,
            kind: "cancel",
            resultVersion: 0,
            disposition: "already_terminal",
            completedAt: acceptedAt,
            resultRefs: Object.freeze([]),
          }),
        }),
      })).toMatchObject({ outcome: "conflict" });

      let terminalLedger = ledger;
      if (backend === "durable") {
        const restarted = createInMemoryOrchestrationServices({ rootDir, store: store! });
        expect(await restarted.tasks.bindAgentGroupPendingOperation!(beginBinding))
          .toMatchObject({ outcome: "replayed" });
        terminalLedger = restarted.tasks;
      }

      const resultBody = Object.freeze({
        operationRef: pending.operationRef,
        kind: "join" as const,
        resultVersion: 0,
        disposition: "satisfied" as const,
        completedAt: acceptedAt,
        resultRefs: Object.freeze([]),
      });
      const terminal = Object.freeze({ ...resultBody, resultDigest: stableHash(resultBody) });
      expect(await terminalLedger.bindAgentGroupOperationResult!({
        ...beginBinding,
        operationIdempotencyKey: "pending-terminal-unbound-continue",
        mutationInputDigest: stableHash("pending-terminal-unbound-input"),
        operationMode: "continue",
        result: Object.freeze({
          ...resultBody,
          operationRef: "pending-terminal-unbound",
          resultDigest: stableHash({ ...resultBody, operationRef: "pending-terminal-unbound" }),
        }),
      })).toMatchObject({ outcome: "inconsistent" });
      const continueBinding = {
        ...beginBinding,
        operationIdempotencyKey: "pending-terminal-continue",
        mutationInputDigest: stableHash("pending-terminal-continue-input"),
        operationMode: "continue" as const,
        result: terminal,
      };
      expect(await terminalLedger.bindAgentGroupOperationResult!(continueBinding))
        .toMatchObject({ outcome: "applied" });
      expect(await terminalLedger.bindAgentGroupOperationResult!(continueBinding))
        .toMatchObject({ outcome: "replayed" });
      expect(await terminalLedger.bindAgentGroupOperationResult!({
        ...continueBinding,
        mutationInputDigest: stableHash("pending-terminal-mutated-input"),
      })).toMatchObject({ outcome: "conflict" });
      expect(await terminalLedger.bindAgentGroupOperationResult!({
        ...continueBinding,
        result: Object.freeze({
          ...resultBody,
          operationRef: "pending-terminal-unknown",
          resultDigest: stableHash({ ...resultBody, operationRef: "pending-terminal-unknown" }),
        }),
      })).toMatchObject({ outcome: "conflict" });
      expect(await terminalLedger.bindAgentGroupOperationResult!({
        ...continueBinding,
        result: Object.freeze({
          ...resultBody,
          kind: "cancel" as const,
          disposition: "already_terminal" as const,
          resultDigest: stableHash({
            ...resultBody,
            kind: "cancel",
            disposition: "already_terminal",
          }),
        }),
      })).toMatchObject({ outcome: "conflict" });

      if (backend === "durable") {
        const reopened = createInMemoryOrchestrationServices({ rootDir, store: store! });
        expect(await reopened.tasks.bindAgentGroupOperationResult!(continueBinding))
          .toMatchObject({ outcome: "replayed" });
        expect(await reopened.tasks.bindAgentGroupPendingOperation!(beginBinding))
          .toMatchObject({ outcome: "replayed" });
      }
    },
  );

  it.each(["in-memory", "durable"] as const)(
    "replays a pending join page with a newer pending observation through the %s ledger",
    async (backend) => {
      const pageObservedAt = new Date(Date.parse(acceptedAt) + 2_000).toISOString();
      const firstMemberObservedAt = new Date(Date.parse(acceptedAt) + 1_000).toISOString();
      const newerPendingObservedAt = new Date(Date.parse(acceptedAt) + 3_000).toISOString();
      const baseLedger = backend === "in-memory"
        ? createInMemoryTaskLedger()
        : createInMemoryOrchestrationServices({
            rootDir: `/pending-join-page-replay-${backend}`,
            store: createInMemoryDurableStore(),
          }).tasks;
      const projectionOutcomes: string[] = [];
      const ledger: HarnessTaskLedger = {
        ...baseLedger,
        async projectAgentGroupPage(input) {
          const result = await baseLedger.projectAgentGroupPage!(input);
          projectionOutcomes.push(result.outcome);
          return result;
        },
      };
      const { launcher: baseLauncher } = pagedLauncher(2);
      let calls = 0;
      const joinAgentGroupPage = vi.fn(async (
        request: Parameters<NonNullable<TestLauncher["joinAgentGroupPage"]>>[0],
      ) => {
        calls += 1;
        const pageBody = Object.freeze({
          requestIdempotencyKey: request.requestIdempotencyKey,
          afterSequence: 0,
          throughSequence: 2,
          nextPageCursor: cursorFor(2),
          hasMore: false,
          changes: Object.freeze([
            Object.freeze({
              sequence: 1,
              kind: "member" as const,
              member: Object.freeze({
                memberId: "member_2",
                memberIndex: 1,
                taskRef: taskRef(1),
                revision: 2,
                status: "running" as const,
                updatedAt: firstMemberObservedAt,
              }),
            }),
            Object.freeze({
              sequence: 2,
              kind: "member" as const,
              member: Object.freeze({
                memberId: "member_1",
                memberIndex: 0,
                taskRef: taskRef(0),
                revision: 2,
                status: "running" as const,
                updatedAt: pageObservedAt,
              }),
            }),
          ]),
        });
        const pendingBody = Object.freeze({
          operationRef: "pending-jw-operation-0001",
          observedAggregateVersion: 2,
          observedAt: calls === 1 ? pageObservedAt : newerPendingObservedAt,
          retryAfterMs: 250,
        });
        return Object.freeze({
          groupRef: request.groupRef,
          aggregateVersion: 2,
          status: "running" as const,
          aggregate: runningAggregate(2),
          memberPage: Object.freeze({
            ...pageBody,
            pageDigest: stableHash(pageBody),
          }),
          // The page timestamp is immutable; a pending settlement can observe
          // that same page at a later safe cut.
          observedAt: pageObservedAt,
          pendingOperation: Object.freeze({
            ...pendingBody,
            pendingDigest: stableHash(pendingBody),
          }),
        });
      });
      const { tools: groupTools } = tools(
        { ...baseLauncher, joinAgentGroupPage },
        2,
        ledger,
      );
      await launch(groupTools.start_agent_group, 2);

      const first = await execute(groupTools.join_agent_group, {
        groupRef,
        maxWaitMs: 10,
      }, `jw-pending-replay-${backend}`);
      const replay = await execute(groupTools.join_agent_group, {
        groupRef,
        maxWaitMs: 10,
      }, `jw-pending-replay-${backend}`);

      expect(first.observedAt).toBe(pageObservedAt);
      expect(replay.observedAt).toBe(pageObservedAt);
      expect(first.operation.observedAt).toBe(pageObservedAt);
      expect(replay.operation.observedAt).toBe(newerPendingObservedAt);
      expect(first.memberPage).toEqual(replay.memberPage);
      expect(projectionOutcomes).toEqual(["applied", "replayed"]);
      expect(joinAgentGroupPage).toHaveBeenCalledTimes(2);
      expect(calls).toBe(2);
      expect(await ledger.getAgentGroupPageState?.({ sessionId: "paged-session", groupRef }))
        .toMatchObject({
          aggregateVersion: 2,
          groupObservedAt: pageObservedAt,
          groupStatus: "running",
          aggregate: runningAggregate(2),
        });
    },
  );

  it.each([
    "agent-group-batch-after-journal-write",
    "agent-group-batch-during-record-writes",
    "agent-group-batch-after-record-writes",
  ] as const)("recovers an exact compact task batch after %s", async (faultPoint) => {
    const rootDir = "/batch-recovery";
    const backing = createInMemoryDurableStore();
    let journalPath: string | undefined;
    const store = {
      ...backing,
      async writeJson(path: string, value: unknown) {
        if (path.includes("/agent-group-task-batches/")) journalPath = path;
        await backing.writeJson(path, value);
      },
    };
    let injected = false;
    const firstServices = createInMemoryOrchestrationServices({
      rootDir,
      store,
      faultInjection: {
        onPoint(point) {
          if (!injected && point === faultPoint) {
            injected = true;
            throw new Error(`batch fault: ${faultPoint}`);
          }
        },
      },
    });
    const { launcher: baseLauncher } = pagedLauncher(4);
    const startAgentGroup = vi.fn(baseLauncher.startAgentGroup);
    const launcher = { ...baseLauncher, startAgentGroup };
    await expect(launch(tools(launcher, 4, firstServices.tasks).tools.start_agent_group, 4))
      .rejects.toThrow(`batch fault: ${faultPoint}`);
    expect(startAgentGroup).not.toHaveBeenCalled();

    const reopened = createInMemoryOrchestrationServices({ rootDir, store });
    const launched = await launch(tools(launcher, 4, reopened.tasks).tools.start_agent_group, 4);
    expect(launched.members.map((member: { taskId: string }) => member.taskId))
      .toEqual(["task_1", "task_2", "task_3", "task_4"]);
    expect(new Set((await reopened.tasks.listTasks({ sessionId: "paged-session" }))
      .map((record) => record.taskId))).toEqual(new Set(["task_1", "task_2", "task_3", "task_4"]));
    expect(startAgentGroup).toHaveBeenCalledTimes(1);
    const thirdReplay = await launch(tools(launcher, 4, reopened.tasks).tools.start_agent_group, 4);
    expect(thirdReplay.members.map((member: { taskId: string }) => member.taskId))
      .toEqual(launched.members.map((member: { taskId: string }) => member.taskId));
    expect(startAgentGroup).toHaveBeenCalledTimes(1);
    expect(journalPath).toBeDefined();
    expect(await backing.readJson<any>(journalPath!)).toMatchObject({
      state: "committed",
      recordsDigest: expect.any(String),
      reservationDigest: expect.any(String),
    });
    expect(await backing.readJson<any>(journalPath!)).not.toHaveProperty("records");
  });

  it("recovers a compact batch after a crash during atomic start-record mirroring", async () => {
    const rootDir = "/start-binding-record-recovery";
    const store = createInMemoryDurableStore();
    let injected = false;
    const first = createInMemoryOrchestrationServices({
      rootDir,
      store,
      faultInjection: {
        onPoint(point) {
          if (!injected && point === "agent-group-start-binding-during-record-writes") {
            injected = true;
            throw new Error("start record mirror interrupted");
          }
        },
      },
    });
    const { launcher: baseLauncher } = pagedLauncher(4);
    const startAgentGroup = vi.fn(baseLauncher.startAgentGroup);
    const launcher = { ...baseLauncher, startAgentGroup };
    await expect(launch(tools(launcher, 4, first.tasks).tools.start_agent_group, 4))
      .rejects.toThrow("start record mirror interrupted");

    const reopened = createInMemoryOrchestrationServices({ rootDir, store });
    const reopenedTools = tools(launcher, 4, reopened.tasks).tools;
    const recovered = await launch(reopenedTools.start_agent_group, 4);
    const third = await launch(reopenedTools.start_agent_group, 4);
    expect(third.members.map((member: { taskId: string }) => member.taskId))
      .toEqual(recovered.members.map((member: { taskId: string }) => member.taskId));
    expect(new Set((await reopened.tasks.listTasks({ sessionId: "paged-session" }))
      .map((record) => record.taskId)).size).toBe(4);
    expect(startAgentGroup).toHaveBeenCalledTimes(1);
  });

  it("rejects a fully-digested but semantically invalid prepared batch before materialization", async () => {
    const rootDir = "/strict-prepared-batch";
    const backing = createInMemoryDurableStore();
    let journalPath: string | undefined;
    const store = {
      ...backing,
      async writeJson(path: string, value: unknown) {
        if (path.includes("/agent-group-task-batches/")) journalPath = path;
        await backing.writeJson(path, value);
      },
    };
    let injected = false;
    const first = createInMemoryOrchestrationServices({
      rootDir,
      store,
      faultInjection: {
        onPoint(point) {
          if (!injected && point === "agent-group-batch-after-journal-write") {
            injected = true;
            throw new Error("prepared batch retained");
          }
        },
      },
    });
    const { launcher } = pagedLauncher(2);
    await expect(launch(tools(launcher, 2, first.tasks).tools.start_agent_group, 2))
      .rejects.toThrow("prepared batch retained");
    const journal = await backing.readJson<any>(journalPath!);
    const records = journal.records.map((record: any, index: number) => index === 0
      ? { ...record, externalAgentGroupRef: "forged-before-start" }
      : record);
    await backing.writeJson(journalPath!, {
      ...journal,
      records,
      recordsDigest: stableHash(records),
      reservationDigest: stableHash(records.map((record: any) => ({
        taskId: record.taskId,
        sessionId: record.sessionId,
        createdAt: record.createdAt,
        kind: record.kind,
        callIdentity: record.callIdentity,
        agentMemberId: record.agentMemberId,
        agentMemberIndex: record.agentMemberIndex,
        agentGroupScopeIdentity: record.agentGroupScopeIdentity,
        agentJoinPolicyHandle: record.agentJoinPolicyHandle,
        agentJoinPolicyKind: record.agentJoinPolicyKind,
        agentReductionPolicyHandle: record.agentReductionPolicyHandle,
        agentMaxMemberSummaryBytes: record.agentMaxMemberSummaryBytes,
        agentMaxGroupSummaryBytes: record.agentMaxGroupSummaryBytes,
        agentMaxResultRefs: record.agentMaxResultRefs,
      }))),
    });
    const reopened = createInMemoryOrchestrationServices({ rootDir, store });
    await expect(launch(tools(launcher, 2, reopened.tasks).tools.start_agent_group, 2))
      .rejects.toThrow(/task-batch journal is invalid/);
  });

  it("rejects malformed mutable task state on committed batch replay before launcher I/O", async () => {
    const rootDir = "/strict-committed-batch-live-state";
    const store = createInMemoryDurableStore();
    const services = createInMemoryOrchestrationServices({ rootDir, store });
    const { launcher: baseLauncher } = pagedLauncher(1);
    const startAgentGroup = vi.fn(baseLauncher.startAgentGroup);
    const launcher = { ...baseLauncher, startAgentGroup };
    const first = await launch(tools(launcher, 1, services.tasks).tools.start_agent_group, 1);
    const sessionKey = stableHash(
      { kind: "session", sessionId: "paged-session" },
      { format: "base32hex" },
    );
    const taskPath = join(rootDir, "tasks", sessionKey, `${recordKey(first.members[0].taskId)}.json`);
    const stored = await store.readJson<any>(taskPath);
    await store.writeJson(taskPath, { ...stored, status: "unknown-terminal" });

    const reopened = createInMemoryOrchestrationServices({ rootDir, store });
    await expect(launch(tools(launcher, 1, reopened.tasks).tools.start_agent_group, 1))
      .rejects.toThrow(/task-batch records are missing or inconsistent/);
    expect(startAgentGroup).toHaveBeenCalledTimes(1);
  });

  it("stores exact future operation bytes, enforces begin/continuation aliases, and fences result owners", async () => {
    const rootDir = "/operation-authority";
    const backing = createInMemoryDurableStore();
    const services = createInMemoryOrchestrationServices({ rootDir, store: backing });
    const { launcher } = pagedLauncher(1);
    const groupTools = tools(launcher, 1, services.tasks).tools;
    const launched = await launch(groupTools.start_agent_group, 1);
    const task = await services.tasks.getTask({
      sessionId: "paged-session",
      taskId: launched.members[0].taskId,
    });
    const scopeIdentity = task!.agentGroupScopeIdentity!;
    const operationBody = Object.freeze({
      operationRef: "future-operation",
      kind: "join" as const,
      resultVersion: 1,
      disposition: "satisfied" as const,
      completedAt: acceptedAt,
      summary: "immutable future result",
      resultRefs: Object.freeze([]),
    });
    const result = Object.freeze({ ...operationBody, resultDigest: stableHash(operationBody) });
    const begin = {
      sessionId: "paged-session",
      scopeIdentity,
      groupRef,
      operationIdempotencyKey: "begin-key",
      mutationInputDigest: stableHash("begin-mutation"),
      operationMode: "begin" as const,
      result,
    };
    expect(await services.tasks.bindAgentGroupOperationResult?.(begin))
      .toMatchObject({ outcome: "applied" });
    const sessionKey = stableHash(
      { kind: "session", sessionId: "paged-session" },
      { format: "base32hex" },
    );
    const pageDir = join(rootDir, "agent-group-pages", sessionKey, recordKey(scopeIdentity));
    const stored = await backing.readJson<any>(join(
      pageDir,
      "operation-results",
      `${recordKey(result.operationRef)}.json`,
    ));
    expect(stored.input.result).toEqual(result);
    expect(await backing.readJson(join(
      pageDir,
      "operation-visibility",
      `${recordKey(result.operationRef)}.json`,
    ))).toBeUndefined();
    expect(await services.tasks.bindAgentGroupOperationResult?.({ ...begin, authorizeVisibility: true }))
      .toMatchObject({ outcome: "inconsistent" });
    expect(await services.tasks.bindAgentGroupOperationResult?.({
      ...begin,
      operationIdempotencyKey: "different-begin-key",
      mutationInputDigest: stableHash("different-begin"),
    })).toMatchObject({ outcome: "conflict" });
    expect(await services.tasks.bindAgentGroupOperationResult?.({
      ...begin,
      operationIdempotencyKey: "continuation-key",
      mutationInputDigest: stableHash("continuation"),
      operationMode: "continue",
    })).toMatchObject({ outcome: "applied" });
    const unknownBody = Object.freeze({ ...operationBody, operationRef: "unknown-operation" });
    expect(await services.tasks.bindAgentGroupOperationResult?.({
      ...begin,
      operationIdempotencyKey: "unknown-continuation",
      mutationInputDigest: stableHash("unknown-continuation"),
      operationMode: "continue",
      result: { ...unknownBody, resultDigest: stableHash(unknownBody) },
    })).toMatchObject({ outcome: "inconsistent" });

    await execute(groupTools.watch_agent_group, { groupRef, pageSize: 1 }, "publish-version-one");
    expect(await services.tasks.bindAgentGroupOperationResult?.({ ...begin, authorizeVisibility: true }))
      .toMatchObject({ outcome: "applied" });

    const ownerPath = (resultRef: string) => join(
      rootDir,
      "agent-group-result-ref-owners",
      `${recordKey(resultRef)}.json`,
    );
    const writeOwner = async (resultRef: string, ownerScope: string, ownerGroup: string, sequence: number) => {
      const body = {
        sessionId: "paged-session",
        scopeIdentity: ownerScope,
        groupRef: ownerGroup,
        memberId: "member_1",
        memberIndex: 0,
        memberRevision: 1,
        publicationSequence: sequence,
        publicationDigest: stableHash({ resultRef, sequence }),
        resultRef,
      };
      await backing.writeJson(ownerPath(resultRef), {
        schemaVersion: "little-harness.agent-group-result-ref-owner.v1",
        ...body,
        ownerDigest: stableHash(body),
      });
    };
    for (const [operationRef, resultRef, ownerScope, ownerGroup, sequence] of [
      ["cross-group-operation", "cross-group-ref", "other-scope", "other-group", 1],
      ["late-publication-operation", "late-publication-ref", scopeIdentity, groupRef, 2],
    ] as const) {
      await writeOwner(resultRef, ownerScope, ownerGroup, sequence);
      const body = Object.freeze({
        operationRef,
        kind: "join" as const,
        resultVersion: 1,
        disposition: "satisfied" as const,
        completedAt: acceptedAt,
        resultRefs: Object.freeze([resultRef as HarnessExternalAgentResultRef]),
      });
      const ownerResult = Object.freeze({ ...body, resultDigest: stableHash(body) });
      const ownerBinding = {
        sessionId: "paged-session",
        scopeIdentity,
        groupRef,
        operationIdempotencyKey: `${operationRef}-begin`,
        mutationInputDigest: stableHash(operationRef),
        operationMode: "begin" as const,
        result: ownerResult,
      };
      expect(await services.tasks.bindAgentGroupOperationResult?.(ownerBinding))
        .toMatchObject({ outcome: "applied" });
      expect(await services.tasks.bindAgentGroupOperationResult?.({
        ...ownerBinding,
        authorizeVisibility: true,
      })).toMatchObject({ outcome: "inconsistent" });
    }
  });

  it.each(["memory", "durable"] as const)(
    "rejects invalid first operation visibility semantics in the %s ledger",
    async (kind) => {
      const store = kind === "durable" ? createInMemoryDurableStore() : undefined;
      const ledger = kind === "durable"
        ? createInMemoryOrchestrationServices({ rootDir: `/operation-semantics-${kind}`, store: store! }).tasks
        : createInMemoryTaskLedger();
      await createDirectPagedGroup(ledger, {
        sessionId: "operation-semantic-session",
        scopeIdentity: "operation-semantic-scope",
        groupRef: "operation-semantic-group",
        launchCallIdentity: "operation-semantic-launch",
        memberCallIdentity: "operation-semantic-member",
        taskRef: "operation-semantic-task",
      });
      const binding = (body: Readonly<Record<string, unknown>>, suffix: string, authorizeVisibility = false) => ({
        sessionId: "operation-semantic-session",
        scopeIdentity: "operation-semantic-scope",
        groupRef: "operation-semantic-group",
        operationIdempotencyKey: `operation-semantic-${suffix}`,
        mutationInputDigest: stableHash({ suffix }),
        operationMode: "begin" as const,
        authorizeVisibility,
        result: Object.freeze({ ...body, resultDigest: stableHash(body) }) as any,
      });
      const satisfied = Object.freeze({
        operationRef: `operation-semantic-satisfied-${kind}`,
        kind: "join" as const,
        resultVersion: 0,
        disposition: "satisfied" as const,
        completedAt: acceptedAt,
        resultRefs: Object.freeze([]),
      });
      expect(await ledger.bindAgentGroupOperationResult!(binding(satisfied, "satisfied", true)))
        .toMatchObject({ outcome: "inconsistent" });
      const beforeLaunch = Object.freeze({
        ...satisfied,
        operationRef: `operation-semantic-time-${kind}`,
        disposition: "deadline" as const,
        completedAt: new Date(Date.parse(acceptedAt) - 1).toISOString(),
      });
      expect(await ledger.bindAgentGroupOperationResult!(binding(beforeLaunch, "time")))
        .toMatchObject({ outcome: "inconsistent" });
      const oversized = Object.freeze({
        ...satisfied,
        operationRef: `operation-semantic-summary-${kind}`,
        disposition: "deadline" as const,
        summary: "x".repeat(257),
      });
      expect(await ledger.bindAgentGroupOperationResult!(binding(oversized, "summary")))
        .toMatchObject({ outcome: "inconsistent" });
    },
  );

  it("serializes cross-group result-ref publication with a canonical lock barrier", async () => {
    const rootDir = "/result-ref-race";
    const backing = createInMemoryDurableStore();
    let attempts = 0;
    let releaseFirst!: () => void;
    const secondAttempt = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const store = {
      ...backing,
      async withLock<T>(scope: unknown, fn: () => Promise<T>) {
        if (Array.isArray(scope) && scope[0] === "agent-group-result-ref-owner") {
          attempts += 1;
          if (attempts === 1) await secondAttempt;
          else if (attempts === 2) releaseFirst();
        }
        return await backing.withLock(scope, fn);
      },
    };
    const first = createInMemoryOrchestrationServices({ rootDir, store });
    const second = createInMemoryOrchestrationServices({ rootDir, store });
    await createDirectPagedGroup(first.tasks, {
      sessionId: "race-session-a",
      scopeIdentity: "race-scope-a",
      groupRef: "race-group-a",
      launchCallIdentity: "race-launch-a",
      memberCallIdentity: "race-member-a",
      taskRef: "race-task-a",
    });
    await createDirectPagedGroup(second.tasks, {
      sessionId: "race-session-b",
      scopeIdentity: "race-scope-b",
      groupRef: "race-group-b",
      launchCallIdentity: "race-launch-b",
      memberCallIdentity: "race-member-b",
      taskRef: "race-task-b",
    });
    const [firstResult, secondResult] = await Promise.all([
      projectDirectResultRef(first.tasks, {
        sessionId: "race-session-a",
        scopeIdentity: "race-scope-a",
        groupRef: "race-group-a",
        taskRef: "race-task-a",
        callIdentity: "race-page-a",
        requestIdempotencyKey: "race-request-a",
        afterSequence: 0,
        memberRevision: 1,
        resultRef: "shared-race-ref",
      }),
      projectDirectResultRef(second.tasks, {
        sessionId: "race-session-b",
        scopeIdentity: "race-scope-b",
        groupRef: "race-group-b",
        taskRef: "race-task-b",
        callIdentity: "race-page-b",
        requestIdempotencyKey: "race-request-b",
        afterSequence: 0,
        memberRevision: 1,
        resultRef: "shared-race-ref",
      }),
    ]);
    expect([firstResult.outcome, secondResult.outcome].sort()).toEqual(["applied", "conflict"]);
    const states = await Promise.all([
      first.tasks.getAgentGroupPageState!({ sessionId: "race-session-a", groupRef: "race-group-a" }),
      second.tasks.getAgentGroupPageState!({ sessionId: "race-session-b", groupRef: "race-group-b" }),
    ]);
    expect(states.map((state) => state!.aggregateVersion).sort()).toEqual([0, 1]);
    expect(attempts).toBeGreaterThanOrEqual(2);
  });

  it.each([
    "agent-group-page-projection-after-result-ref-intents",
    "agent-group-page-projection-after-authority-commit",
  ] as const)("recovers a global result-ref claim after %s", async (faultPoint) => {
    const rootDir = `/result-ref-claim-${faultPoint}`;
    const store = createInMemoryDurableStore();
    let injected = false;
    const first = createInMemoryOrchestrationServices({
      rootDir,
      store,
      faultInjection: {
        onPoint(point) {
          if (!injected && point === faultPoint) {
            injected = true;
            throw new Error(`claim fault: ${faultPoint}`);
          }
        },
      },
    });
    const second = createInMemoryOrchestrationServices({ rootDir, store });
    await createDirectPagedGroup(first.tasks, {
      sessionId: "claim-session-a",
      scopeIdentity: "claim-scope-a",
      groupRef: "claim-group-a",
      launchCallIdentity: "claim-launch-a",
      memberCallIdentity: "claim-member-a",
      taskRef: "claim-task-a",
    });
    await createDirectPagedGroup(second.tasks, {
      sessionId: "claim-session-b",
      scopeIdentity: "claim-scope-b",
      groupRef: "claim-group-b",
      launchCallIdentity: "claim-launch-b",
      memberCallIdentity: "claim-member-b",
      taskRef: "claim-task-b",
    });
    await expect(projectDirectResultRef(first.tasks, {
      sessionId: "claim-session-a",
      scopeIdentity: "claim-scope-a",
      groupRef: "claim-group-a",
      taskRef: "claim-task-a",
      callIdentity: "claim-page-a",
      requestIdempotencyKey: "claim-request-a",
      afterSequence: 0,
      memberRevision: 1,
      resultRef: "shared-claim-ref",
    })).rejects.toThrow(`claim fault: ${faultPoint}`);

    const contender = await projectDirectResultRef(second.tasks, {
      sessionId: "claim-session-b",
      scopeIdentity: "claim-scope-b",
      groupRef: "claim-group-b",
      taskRef: "claim-task-b",
      callIdentity: "claim-page-b",
      requestIdempotencyKey: "claim-request-b",
      afterSequence: 0,
      memberRevision: 1,
      resultRef: "shared-claim-ref",
    });
    if (faultPoint === "agent-group-page-projection-after-result-ref-intents") {
      expect(contender).toMatchObject({ outcome: "applied" });
      expect(await first.tasks.getAgentGroupPageState!({
        sessionId: "claim-session-a",
        groupRef: "claim-group-a",
      })).toMatchObject({ aggregateVersion: 0 });
    } else {
      expect(contender).toMatchObject({ outcome: "conflict" });
      expect(await first.tasks.getAgentGroupPageState!({
        sessionId: "claim-session-a",
        groupRef: "claim-group-a",
      })).toMatchObject({ aggregateVersion: 1 });
    }
  });

  it("rejects a coherent result-ref intent without its exact member sequence proof", async () => {
    const rootDir = "/result-ref-forged-sequence-proof";
    const store = createInMemoryDurableStore();
    let injected = false;
    const first = createInMemoryOrchestrationServices({
      rootDir,
      store,
      faultInjection: {
        onPoint(point) {
          if (!injected && point === "agent-group-page-projection-after-result-ref-intents") {
            injected = true;
            throw new Error("intent retained before authority");
          }
        },
      },
    });
    const contender = createInMemoryOrchestrationServices({ rootDir, store });
    await createDirectPagedGroup(first.tasks, {
      sessionId: "intent-proof-session-a",
      scopeIdentity: "intent-proof-scope-a",
      groupRef: "intent-proof-group-a",
      launchCallIdentity: "intent-proof-launch-a",
      memberCallIdentity: "intent-proof-member-a",
      taskRef: "intent-proof-task-a",
    });
    await createDirectPagedGroup(contender.tasks, {
      sessionId: "intent-proof-session-b",
      scopeIdentity: "intent-proof-scope-b",
      groupRef: "intent-proof-group-b",
      launchCallIdentity: "intent-proof-launch-b",
      memberCallIdentity: "intent-proof-member-b",
      taskRef: "intent-proof-task-b",
    });
    const resultRef = "intent-proof-result-ref";
    await expect(projectDirectResultRef(first.tasks, {
      sessionId: "intent-proof-session-a",
      scopeIdentity: "intent-proof-scope-a",
      groupRef: "intent-proof-group-a",
      taskRef: "intent-proof-task-a",
      callIdentity: "intent-proof-page-a",
      requestIdempotencyKey: "intent-proof-request-a",
      afterSequence: 0,
      memberRevision: 1,
      resultRef,
    })).rejects.toThrow("intent retained before authority");
    const intentPath = join(
      rootDir,
      "agent-group-result-ref-intents",
      `${recordKey(resultRef)}.json`,
    );
    const intent = await store.readJson<any>(intentPath);
    const forgedOwnerBody = {
      ...intent.owner,
      schemaVersion: undefined,
      ownerDigest: undefined,
      memberId: "member_2",
      memberIndex: 1,
    };
    const forgedOwner = {
      schemaVersion: "little-harness.agent-group-result-ref-owner.v1",
      ...Object.fromEntries(Object.entries(forgedOwnerBody).filter(([, value]) => value !== undefined)),
      ownerDigest: stableHash(Object.fromEntries(
        Object.entries(forgedOwnerBody).filter(([, value]) => value !== undefined),
      )),
    };
    await store.writeJson(intentPath, { ...intent, owner: forgedOwner });

    await expect(projectDirectResultRef(contender.tasks, {
      sessionId: "intent-proof-session-b",
      scopeIdentity: "intent-proof-scope-b",
      groupRef: "intent-proof-group-b",
      taskRef: "intent-proof-task-b",
      callIdentity: "intent-proof-page-b",
      requestIdempotencyKey: "intent-proof-request-b",
      afterSequence: 0,
      memberRevision: 1,
      resultRef,
    })).rejects.toThrow(/exact publication sequence proof/);
    expect(await store.readJson(join(
      rootDir,
      "agent-group-result-ref-owners",
      `${recordKey(resultRef)}.json`,
    ))).toBeUndefined();
    expect(await store.readJson(intentPath)).toBeDefined();
  });

  it.each(["memory", "durable"] as const)(
    "preserves first result-ref publication on higher terminal revisions in the %s ledger",
    async (kind) => {
      const rootDir = `/result-ref-revision-${kind}`;
      const store = kind === "durable" ? createInMemoryDurableStore() : undefined;
      const ledger = kind === "durable"
        ? createInMemoryOrchestrationServices({ rootDir, store: store! }).tasks
        : createInMemoryTaskLedger();
      await createDirectPagedGroup(ledger, {
        sessionId: "revision-session",
        scopeIdentity: "revision-scope",
        groupRef: "revision-group",
        launchCallIdentity: "revision-launch",
        memberCallIdentity: "revision-member",
        taskRef: "revision-task",
      });
      const stateDigest = stableHash({ status: "succeeded", resultRef: "revision-ref" });
      expect(await projectDirectResultRef(ledger, {
        sessionId: "revision-session",
        scopeIdentity: "revision-scope",
        groupRef: "revision-group",
        taskRef: "revision-task",
        callIdentity: "revision-page-1",
        requestIdempotencyKey: "revision-request-1",
        afterSequence: 0,
        memberRevision: 1,
        resultRef: "revision-ref",
        memberStateDigest: stateDigest,
      })).toMatchObject({ outcome: "applied" });
      const ownerPath = kind === "durable"
        ? join(rootDir, "agent-group-result-ref-owners", `${recordKey("revision-ref")}.json`)
        : undefined;
      const firstOwner = ownerPath === undefined ? undefined : await store!.readJson<any>(ownerPath);
      expect(await projectDirectResultRef(ledger, {
        sessionId: "revision-session",
        scopeIdentity: "revision-scope",
        groupRef: "revision-group",
        taskRef: "revision-task",
        callIdentity: "revision-page-2",
        requestIdempotencyKey: "revision-request-2",
        afterSequence: 1,
        memberRevision: 2,
        resultRef: "revision-ref",
        memberStateDigest: stateDigest,
      })).toMatchObject({ outcome: "applied" });
      if (ownerPath !== undefined) expect(await store!.readJson<any>(ownerPath)).toEqual(firstOwner);
      const operationLedger = kind === "durable"
        ? createInMemoryOrchestrationServices({ rootDir, store: store! }).tasks
        : ledger;
      expect(await operationLedger.getAgentGroupPageState!({
        sessionId: "revision-session",
        groupRef: "revision-group",
      })).toMatchObject({ aggregateVersion: 2 });
      const operationBody = Object.freeze({
        operationRef: `revision-operation-${kind}`,
        kind: "join" as const,
        resultVersion: 1,
        disposition: "satisfied" as const,
        completedAt: acceptedAt,
        resultRefs: Object.freeze(["revision-ref" as HarnessExternalAgentResultRef]),
      });
      const operation = Object.freeze({ ...operationBody, resultDigest: stableHash(operationBody) });
      const operationBinding = {
        sessionId: "revision-session",
        scopeIdentity: "revision-scope",
        groupRef: "revision-group",
        operationIdempotencyKey: `revision-operation-key-${kind}`,
        mutationInputDigest: stableHash({ kind }),
        operationMode: "begin" as const,
        result: operation,
      };
      expect(await operationLedger.bindAgentGroupOperationResult!({ ...operationBinding }))
        .toMatchObject({ outcome: "applied" });
      expect(await operationLedger.bindAgentGroupOperationResult!({
        ...operationBinding,
        authorizeVisibility: true,
      })).toMatchObject({ outcome: "applied" });
      expect(await projectDirectResultRef(operationLedger, {
        sessionId: "revision-session",
        scopeIdentity: "revision-scope",
        groupRef: "revision-group",
        taskRef: "revision-task",
        callIdentity: "revision-page-replace",
        requestIdempotencyKey: "revision-request-replace",
        afterSequence: 2,
        memberRevision: 3,
        resultRef: "replacement-ref",
        memberStateDigest: stateDigest,
      })).toMatchObject({ outcome: "invalid_transition" });
    },
  );

  it("raises a typed lifetime ceiling before launcher I/O", async () => {
    const rootDir = "/page-call-lifetime";
    const backing = createInMemoryDurableStore();
    const services = createInMemoryOrchestrationServices({ rootDir, store: backing });
    const { launcher: baseLauncher } = pagedLauncher(1);
    const watchAgentGroupPage = vi.fn(baseLauncher.watchAgentGroupPage!);
    const launcher = { ...baseLauncher, watchAgentGroupPage };
    const groupTools = tools(launcher, 1, services.tasks).tools;
    const launched = await launch(groupTools.start_agent_group, 1);
    const task = await services.tasks.getTask({
      sessionId: "paged-session",
      taskId: launched.members[0].taskId,
    });
    const sessionKey = stableHash(
      { kind: "session", sessionId: "paged-session" },
      { format: "base32hex" },
    );
    const authorityPath = join(
      rootDir,
      "agent-group-pages",
      sessionKey,
      recordKey(task!.agentGroupScopeIdentity!),
      "authority.json",
    );
    const authority = await backing.readJson<any>(authorityPath);
    await backing.writeJson(authorityPath, {
      ...authority,
      pageCallsIssued: HARNESS_AGENT_GROUP_MAX_LIFETIME_PAGE_CALLS,
    });

    await expect(execute(groupTools.watch_agent_group, { groupRef }, "over-lifetime-limit"))
      .rejects.toBeInstanceOf(HarnessAgentGroupPageCallLimitError);
    expect(watchAgentGroupPage).not.toHaveBeenCalled();
  });

  it.each([
    "agent-group-gc-after-prepare",
    "agent-group-gc-during-delete",
    "agent-group-gc-after-delete",
  ] as const)("recovers whole-group collection after %s and permanently rejects old calls", async (faultPoint) => {
    const rootDir = "/group-gc";
    const store = createInMemoryDurableStore();
    let injected = false;
    const firstServices = createInMemoryOrchestrationServices({
      rootDir,
      store,
      faultInjection: {
        onPoint(point) {
          if (!injected && point === faultPoint) {
            injected = true;
            throw new Error(`gc fault: ${faultPoint}`);
          }
        },
      },
    });
    const { launcher: baseLauncher } = pagedLauncher(3);
    const startAgentGroup = vi.fn(baseLauncher.startAgentGroup);
    const joinAgentGroupPage = vi.fn(baseLauncher.joinAgentGroupPage!);
    const cancelAgentGroupPage = vi.fn(baseLauncher.cancelAgentGroupPage!);
    const launcher = { ...baseLauncher, startAgentGroup, joinAgentGroupPage, cancelAgentGroupPage };
    const firstTools = tools(launcher, 3, firstServices.tasks).tools;
    await launch(firstTools.start_agent_group, 3);
    await execute(firstTools.watch_agent_group, { groupRef, pageSize: 3 }, "gc-terminal-page");
    const terminal = await firstServices.tasks.getAgentGroupPageState?.({
      sessionId: "paged-session",
      groupRef,
    });
    const collection = {
      sessionId: "paged-session",
      groupRef,
      expectedAggregateVersion: terminal!.aggregateVersion,
      expectedGroupObservationDigest: terminal!.groupObservationDigest,
    };
    await expect(firstServices.tasks.collectAgentGroupGarbage!(collection))
      .rejects.toThrow(`gc fault: ${faultPoint}`);

    const reopened = createInMemoryOrchestrationServices({ rootDir, store });
    expect(await reopened.tasks.collectAgentGroupGarbage!(collection))
      .toMatchObject({ outcome: "collected" });
    expect(await reopened.tasks.collectAgentGroupGarbage!(collection))
      .toMatchObject({ outcome: "replayed" });
    expect(await reopened.tasks.collectAgentGroupGarbage!({
      ...collection,
      expectedAggregateVersion: collection.expectedAggregateVersion + 1,
    })).toMatchObject({ outcome: "conflict" });
    expect(await reopened.tasks.listTasks({ sessionId: "paged-session" })).toEqual([]);
    expect(await reopened.tasks.getAgentGroupPageState?.({ sessionId: "paged-session", groupRef }))
      .toBeUndefined();

    const receipt = await store.readJson<any>(join(
      rootDir,
      "agent-group-gc",
      `${recordKey(groupRef)}.json`,
    ));
    expect(receipt).toMatchObject({ state: "committed", groupRef });
    expect(receipt).not.toHaveProperty("members");
    expect(receipt).not.toHaveProperty("resultRefOwners");

    const reopenedTools = tools(launcher, 3, reopened.tasks).tools;
    await expect(launch(reopenedTools.start_agent_group, 3))
      .rejects.toThrow(/task batch reservation did not converge/);
    await expect(execute(reopenedTools.join_agent_group, { groupRef }, "gc-old-join"))
      .rejects.toThrow(/not owned by this session/);
    await expect(execute(reopenedTools.cancel_agent_group, { groupRef }, "gc-old-cancel"))
      .rejects.toThrow(/not owned by this session/);
    expect(startAgentGroup).toHaveBeenCalledTimes(1);
    expect(joinAgentGroupPage).not.toHaveBeenCalled();
    expect(cancelAgentGroupPage).not.toHaveBeenCalled();
  });

  it("qualifies recursive GC and post-delete recovery on the real file store", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lh-agent-gc-real-"));
    let injected = false;
    try {
      const first = createLocalHarnessDurableServices({
        rootDir: dir,
        faultInjection: {
          onPoint(point) {
            if (!injected && point === "agent-group-gc-after-delete") {
              injected = true;
              throw new Error("real file GC lost commit response");
            }
          },
        },
      });
      const { launcher: baseLauncher } = pagedLauncher(3);
      const startAgentGroup = vi.fn(baseLauncher.startAgentGroup);
      const launcher = { ...baseLauncher, startAgentGroup };
      const firstTools = tools(launcher, 3, first.tasks).tools;
      await launch(firstTools.start_agent_group, 3);
      await execute(firstTools.watch_agent_group, { groupRef, pageSize: 3 }, "real-gc-terminal");
      const terminal = await first.tasks.getAgentGroupPageState?.({
        sessionId: "paged-session",
        groupRef,
      });
      const collection = {
        sessionId: "paged-session",
        groupRef,
        expectedAggregateVersion: terminal!.aggregateVersion,
        expectedGroupObservationDigest: terminal!.groupObservationDigest,
      };
      await expect(first.tasks.collectAgentGroupGarbage!(collection))
        .rejects.toThrow("real file GC lost commit response");

      const reopened = createLocalHarnessDurableServices({ rootDir: dir });
      expect(await reopened.tasks.collectAgentGroupGarbage!(collection))
        .toMatchObject({ outcome: "collected" });
      expect(await reopened.tasks.collectAgentGroupGarbage!(collection))
        .toMatchObject({ outcome: "replayed" });
      expect(await reopened.tasks.listTasks({ sessionId: "paged-session" })).toEqual([]);
      await expect(launch(tools(launcher, 3, reopened.tasks).tools.start_agent_group, 3))
        .rejects.toThrow(/task batch reservation did not converge/);
      expect(startAgentGroup).toHaveBeenCalledTimes(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("revalidates a prepared GC fence before deleting a newer terminal revision", async () => {
    const rootDir = "/gc-version-revalidation";
    const store = createInMemoryDurableStore();
    let injected = false;
    const services = createInMemoryOrchestrationServices({
      rootDir,
      store,
      faultInjection: {
        onPoint(point) {
          if (!injected && point === "agent-group-gc-after-prepare") {
            injected = true;
            throw new Error("GC prepared at V1");
          }
        },
      },
    });
    await createDirectPagedGroup(services.tasks, {
      sessionId: "gc-version-session",
      scopeIdentity: "gc-version-scope",
      groupRef: "gc-version-group",
      launchCallIdentity: "gc-version-launch",
      memberCallIdentity: "gc-version-member",
      taskRef: "gc-version-task",
    });
    expect(await projectDirectResultRef(services.tasks, {
      sessionId: "gc-version-session",
      scopeIdentity: "gc-version-scope",
      groupRef: "gc-version-group",
      taskRef: "gc-version-task",
      callIdentity: "gc-version-page-1",
      requestIdempotencyKey: "gc-version-request-1",
      afterSequence: 0,
      memberRevision: 1,
    })).toMatchObject({ outcome: "applied" });
    const v1 = await services.tasks.getAgentGroupPageState!({
      sessionId: "gc-version-session",
      groupRef: "gc-version-group",
    });
    const collectV1 = {
      sessionId: "gc-version-session",
      groupRef: "gc-version-group",
      expectedAggregateVersion: v1!.aggregateVersion,
      expectedGroupObservationDigest: v1!.groupObservationDigest,
    };
    await expect(services.tasks.collectAgentGroupGarbage!(collectV1))
      .rejects.toThrow("GC prepared at V1");
    expect(await projectDirectResultRef(services.tasks, {
      sessionId: "gc-version-session",
      scopeIdentity: "gc-version-scope",
      groupRef: "gc-version-group",
      taskRef: "gc-version-task",
      callIdentity: "gc-version-page-2",
      requestIdempotencyKey: "gc-version-request-2",
      afterSequence: 1,
      memberRevision: 2,
    })).toMatchObject({ outcome: "applied" });
    expect(await services.tasks.collectAgentGroupGarbage!(collectV1))
      .toMatchObject({ outcome: "conflict" });
    const v2 = await services.tasks.getAgentGroupPageState!({
      sessionId: "gc-version-session",
      groupRef: "gc-version-group",
    });
    expect(v2).toMatchObject({ aggregateVersion: 2 });
    expect(await services.tasks.collectAgentGroupGarbage!({
      sessionId: "gc-version-session",
      groupRef: "gc-version-group",
      expectedAggregateVersion: v2!.aggregateVersion,
      expectedGroupObservationDigest: v2!.groupObservationDigest,
    })).toMatchObject({ outcome: "collected" });
  });

  it("fences a higher terminal projection once GC publishes deletion", async () => {
    const rootDir = "/gc-projection-fence";
    const backing = createInMemoryDurableStore();
    let deletingReachedResolve!: () => void;
    let releaseDeletionResolve!: () => void;
    const deletingReached = new Promise<void>((resolve) => {
      deletingReachedResolve = resolve;
    });
    const releaseDeletion = new Promise<void>((resolve) => {
      releaseDeletionResolve = resolve;
    });
    const store = {
      ...backing,
      async writeJson(path: string, value: unknown) {
        await backing.writeJson(path, value);
        if (path.includes("/agent-group-gc/") &&
            (value as { readonly state?: string }).state === "deleting") {
          deletingReachedResolve();
          await releaseDeletion;
        }
      },
    };
    const services = createInMemoryOrchestrationServices({ rootDir, store });
    await createDirectPagedGroup(services.tasks, {
      sessionId: "gc-fence-session",
      scopeIdentity: "gc-fence-scope",
      groupRef: "gc-fence-group",
      launchCallIdentity: "gc-fence-launch",
      memberCallIdentity: "gc-fence-member",
      taskRef: "gc-fence-task",
    });
    expect(await projectDirectResultRef(services.tasks, {
      sessionId: "gc-fence-session",
      scopeIdentity: "gc-fence-scope",
      groupRef: "gc-fence-group",
      taskRef: "gc-fence-task",
      callIdentity: "gc-fence-page-1",
      requestIdempotencyKey: "gc-fence-request-1",
      afterSequence: 0,
      memberRevision: 1,
    })).toMatchObject({ outcome: "applied" });
    const terminal = await services.tasks.getAgentGroupPageState!({
      sessionId: "gc-fence-session",
      groupRef: "gc-fence-group",
    });
    expect(await services.tasks.bindAgentGroupPageCall!({
      sessionId: "gc-fence-session",
      scopeIdentity: "gc-fence-scope",
      groupRef: "gc-fence-group",
      callIdentity: "gc-fence-page-2",
      operationKind: "watch",
      canonicalInputDigest: stableHash({ callIdentity: "gc-fence-page-2" }),
      requestIdempotencyKey: "gc-fence-request-2",
      requestedAfterSequence: 1,
      pageCursorDigest: stableHash({ cursor: 1 }),
      maximumChanges: 1,
      maximumBytes: 1_000_000,
      maximumCursorBytes: 256,
    })).toMatchObject({ outcome: "applied" });
    const collection = services.tasks.collectAgentGroupGarbage!({
      sessionId: "gc-fence-session",
      groupRef: "gc-fence-group",
      expectedAggregateVersion: terminal!.aggregateVersion,
      expectedGroupObservationDigest: terminal!.groupObservationDigest,
    });
    await deletingReached;
    const resultRef = "gc-fence-result-ref";
    let projectionSettled = false;
    const projection = services.tasks.projectAgentGroupPage!({
      sessionId: "gc-fence-session",
      scopeIdentity: "gc-fence-scope",
      groupRef: "gc-fence-group",
      requestIdempotencyKey: "gc-fence-request-2",
      pageDigest: stableHash({ page: "gc-fence-request-2" }),
      afterSequence: 1,
      throughSequence: 2,
      aggregateVersion: 2,
      groupStatus: "satisfied",
      aggregate: Object.freeze({ ...aggregate(1, 1), resultRefCount: 1 }),
      groupObservationDigest: stableHash({ group: "gc-fence-request-2" }),
      groupObservedAt: acceptedAt,
      pageCallIdentity: "gc-fence-page-2",
      changes: [Object.freeze({
        sequence: 2,
        memberId: "member_1",
        memberIndex: 0,
        taskRef: "gc-fence-task",
        memberStatus: "succeeded" as const,
        memberRevision: 2,
        memberObservationDigest: stableHash({ observation: "gc-fence-request-2" }),
        memberStateDigest: stableHash({ status: "succeeded", resultRef }),
        memberObservedAt: acceptedAt,
        status: "completed" as const,
        externalAgentResultRef: resultRef,
        verifiedSucceeded: false,
        hasResultRef: true,
      })],
    }).then((result) => {
      projectionSettled = true;
      return result;
    });
    await Promise.resolve();
    expect(projectionSettled).toBe(false);
    releaseDeletionResolve();
    expect(await collection).toMatchObject({ outcome: "collected" });
    expect(await projection).toMatchObject({ outcome: "inconsistent" });
    expect(await backing.readJson(join(
      rootDir,
      "agent-group-result-ref-owners",
      `${recordKey(resultRef)}.json`,
    ))).toBeUndefined();
  });

  it("keeps the deleting fence authoritative across a service restart", async () => {
    const rootDir = "/gc-restart-deleting-fence";
    const store = createInMemoryDurableStore();
    let injected = false;
    const first = createInMemoryOrchestrationServices({
      rootDir,
      store,
      faultInjection: {
        onPoint(point) {
          if (!injected && point === "agent-group-gc-after-deleting-fence") {
            injected = true;
            throw new Error("restart after deleting fence");
          }
        },
      },
    });
    await createDirectPagedGroup(first.tasks, {
      sessionId: "gc-restart-session",
      scopeIdentity: "gc-restart-scope",
      groupRef: "gc-restart-group",
      launchCallIdentity: "gc-restart-launch",
      memberCallIdentity: "gc-restart-member",
      taskRef: "gc-restart-task",
    });
    expect(await projectDirectResultRef(first.tasks, {
      sessionId: "gc-restart-session",
      scopeIdentity: "gc-restart-scope",
      groupRef: "gc-restart-group",
      taskRef: "gc-restart-task",
      callIdentity: "gc-restart-page-1",
      requestIdempotencyKey: "gc-restart-request-1",
      afterSequence: 0,
      memberRevision: 1,
    })).toMatchObject({ outcome: "applied" });
    const terminal = await first.tasks.getAgentGroupPageState!({
      sessionId: "gc-restart-session",
      groupRef: "gc-restart-group",
    });
    expect(await first.tasks.bindAgentGroupPageCall!({
      sessionId: "gc-restart-session",
      scopeIdentity: "gc-restart-scope",
      groupRef: "gc-restart-group",
      callIdentity: "gc-restart-page-2",
      operationKind: "watch",
      canonicalInputDigest: stableHash({ callIdentity: "gc-restart-page-2" }),
      requestIdempotencyKey: "gc-restart-request-2",
      requestedAfterSequence: 1,
      pageCursorDigest: stableHash({ cursor: 1 }),
      maximumChanges: 1,
      maximumBytes: 1_000_000,
      maximumCursorBytes: 256,
    })).toMatchObject({ outcome: "applied" });
    const collection = {
      sessionId: "gc-restart-session",
      groupRef: "gc-restart-group",
      expectedAggregateVersion: terminal!.aggregateVersion,
      expectedGroupObservationDigest: terminal!.groupObservationDigest,
    };
    await expect(first.tasks.collectAgentGroupGarbage!(collection))
      .rejects.toThrow("restart after deleting fence");

    const reopened = createInMemoryOrchestrationServices({ rootDir, store });
    expect(await reopened.tasks.bindAgentGroupPageCall!({
      sessionId: "gc-restart-session",
      scopeIdentity: "gc-restart-scope",
      groupRef: "gc-restart-group",
      callIdentity: "gc-restart-page-new",
      operationKind: "watch",
      canonicalInputDigest: stableHash({ callIdentity: "gc-restart-page-new" }),
      requestIdempotencyKey: "gc-restart-request-new",
      maximumChanges: 1,
      maximumBytes: 1_000_000,
      maximumCursorBytes: 256,
    })).toMatchObject({ outcome: "inconsistent" });
    expect(await reopened.tasks.projectAgentGroupPage!({
      sessionId: "gc-restart-session",
      scopeIdentity: "gc-restart-scope",
      groupRef: "gc-restart-group",
      requestIdempotencyKey: "gc-restart-request-2",
      pageDigest: stableHash({ page: "gc-restart-request-2" }),
      afterSequence: 1,
      throughSequence: 2,
      aggregateVersion: 2,
      groupStatus: "satisfied",
      aggregate: aggregate(1, 1),
      groupObservationDigest: stableHash({ group: "gc-restart-request-2" }),
      groupObservedAt: acceptedAt,
      pageCallIdentity: "gc-restart-page-2",
      changes: [Object.freeze({
        sequence: 2,
        memberId: "member_1",
        memberIndex: 0,
        taskRef: "gc-restart-task",
        memberStatus: "succeeded" as const,
        memberRevision: 2,
        memberObservationDigest: stableHash({ observation: "gc-restart-request-2" }),
        memberStateDigest: stableHash({ status: "succeeded" }),
        memberObservedAt: acceptedAt,
        status: "completed" as const,
        verifiedSucceeded: false,
        hasResultRef: false,
      })],
    })).toMatchObject({ outcome: "inconsistent" });
    const operationBody = Object.freeze({
      operationRef: "gc-restart-operation",
      kind: "cancel" as const,
      resultVersion: 1,
      disposition: "already_terminal" as const,
      completedAt: acceptedAt,
      resultRefs: Object.freeze([]),
    });
    expect(await reopened.tasks.bindAgentGroupOperationResult!({
      sessionId: "gc-restart-session",
      scopeIdentity: "gc-restart-scope",
      groupRef: "gc-restart-group",
      operationIdempotencyKey: "gc-restart-operation-key",
      mutationInputDigest: stableHash({ operation: "gc-restart" }),
      operationMode: "begin",
      result: Object.freeze({ ...operationBody, resultDigest: stableHash(operationBody) }),
    })).toMatchObject({ outcome: "inconsistent" });
    expect(await reopened.tasks.getAgentGroupPageState!({
      sessionId: "gc-restart-session",
      groupRef: "gc-restart-group",
    })).toBeUndefined();
    expect(await reopened.tasks.collectAgentGroupGarbage!(collection))
      .toMatchObject({ outcome: "collected" });
  });

  it("keeps the global group tombstone across sessions", async () => {
    const rootDir = "/gc-global-group-ref";
    const store = createInMemoryDurableStore();
    const services = createInMemoryOrchestrationServices({ rootDir, store });
    await createDirectPagedGroup(services.tasks, {
      sessionId: "global-session-a",
      scopeIdentity: "global-scope-a",
      groupRef: "global-collected-group",
      launchCallIdentity: "global-launch-a",
      memberCallIdentity: "global-member-a",
      taskRef: "global-task-a",
    });
    expect(await projectDirectResultRef(services.tasks, {
      sessionId: "global-session-a",
      scopeIdentity: "global-scope-a",
      groupRef: "global-collected-group",
      taskRef: "global-task-a",
      callIdentity: "global-page-a",
      requestIdempotencyKey: "global-request-a",
      afterSequence: 0,
      memberRevision: 1,
    })).toMatchObject({ outcome: "applied" });
    const terminal = await services.tasks.getAgentGroupPageState!({
      sessionId: "global-session-a",
      groupRef: "global-collected-group",
    });
    expect(await services.tasks.collectAgentGroupGarbage!({
      sessionId: "global-session-a",
      groupRef: "global-collected-group",
      expectedAggregateVersion: terminal!.aggregateVersion,
      expectedGroupObservationDigest: terminal!.groupObservationDigest,
    })).toMatchObject({ outcome: "collected" });
    await expect(createDirectPagedGroup(services.tasks, {
      sessionId: "global-session-b",
      scopeIdentity: "global-scope-b",
      groupRef: "global-collected-group",
      launchCallIdentity: "global-launch-b",
      memberCallIdentity: "global-member-b",
      taskRef: "global-task-b",
    })).rejects.toThrow(/direct group start failed: conflict/);
  });

  it("rejects a rehashed GC marker that omits a member publication owner", async () => {
    const rootDir = "/gc-owner-completeness";
    const store = createInMemoryDurableStore();
    let injected = false;
    const first = createInMemoryOrchestrationServices({
      rootDir,
      store,
      faultInjection: {
        onPoint(point) {
          if (!injected && point === "agent-group-gc-after-prepare") {
            injected = true;
            throw new Error("owner-complete marker prepared");
          }
        },
      },
    });
    await createDirectPagedGroup(first.tasks, {
      sessionId: "owner-complete-session",
      scopeIdentity: "owner-complete-scope",
      groupRef: "owner-complete-group",
      launchCallIdentity: "owner-complete-launch",
      memberCallIdentity: "owner-complete-member",
      taskRef: "owner-complete-task",
    });
    const resultRef = "owner-complete-result-ref";
    expect(await projectDirectResultRef(first.tasks, {
      sessionId: "owner-complete-session",
      scopeIdentity: "owner-complete-scope",
      groupRef: "owner-complete-group",
      taskRef: "owner-complete-task",
      callIdentity: "owner-complete-page",
      requestIdempotencyKey: "owner-complete-request",
      afterSequence: 0,
      memberRevision: 1,
      resultRef,
    })).toMatchObject({ outcome: "applied" });
    const terminal = await first.tasks.getAgentGroupPageState!({
      sessionId: "owner-complete-session",
      groupRef: "owner-complete-group",
    });
    const collection = {
      sessionId: "owner-complete-session",
      groupRef: "owner-complete-group",
      expectedAggregateVersion: terminal!.aggregateVersion,
      expectedGroupObservationDigest: terminal!.groupObservationDigest,
    };
    await expect(first.tasks.collectAgentGroupGarbage!(collection))
      .rejects.toThrow("owner-complete marker prepared");
    const markerPath = join(rootDir, "agent-group-gc", `${recordKey("owner-complete-group")}.json`);
    const marker = await store.readJson<any>(markerPath);
    await store.writeJson(markerPath, {
      ...marker,
      resultRefOwners: [],
      resultRefOwnersDigest: stableHash([]),
    });

    const reopened = createInMemoryOrchestrationServices({ rootDir, store });
    await expect(reopened.tasks.collectAgentGroupGarbage!(collection))
      .rejects.toThrow(/garbage-collection authority is invalid/);
    expect(await store.readJson(join(
      rootDir,
      "agent-group-result-ref-owners",
      `${recordKey(resultRef)}.json`,
    ))).toBeDefined();
    expect(await reopened.tasks.listTasks({ sessionId: "owner-complete-session" }))
      .toHaveLength(1);
  });

  it("retains cleanup authority when current result-owner bytes are malformed", async () => {
    const rootDir = "/gc-malformed-owner";
    const store = createInMemoryDurableStore();
    let injected = false;
    const first = createInMemoryOrchestrationServices({
      rootDir,
      store,
      faultInjection: {
        onPoint(point) {
          if (!injected && point === "agent-group-gc-after-delete") {
            injected = true;
            throw new Error("group deleted before owner cleanup");
          }
        },
      },
    });
    await createDirectPagedGroup(first.tasks, {
      sessionId: "malformed-owner-session",
      scopeIdentity: "malformed-owner-scope",
      groupRef: "malformed-owner-group",
      launchCallIdentity: "malformed-owner-launch",
      memberCallIdentity: "malformed-owner-member",
      taskRef: "malformed-owner-task",
    });
    const resultRef = "malformed-owner-result-ref";
    expect(await projectDirectResultRef(first.tasks, {
      sessionId: "malformed-owner-session",
      scopeIdentity: "malformed-owner-scope",
      groupRef: "malformed-owner-group",
      taskRef: "malformed-owner-task",
      callIdentity: "malformed-owner-page",
      requestIdempotencyKey: "malformed-owner-request",
      afterSequence: 0,
      memberRevision: 1,
      resultRef,
    })).toMatchObject({ outcome: "applied" });
    const terminal = await first.tasks.getAgentGroupPageState!({
      sessionId: "malformed-owner-session",
      groupRef: "malformed-owner-group",
    });
    const collection = {
      sessionId: "malformed-owner-session",
      groupRef: "malformed-owner-group",
      expectedAggregateVersion: terminal!.aggregateVersion,
      expectedGroupObservationDigest: terminal!.groupObservationDigest,
    };
    await expect(first.tasks.collectAgentGroupGarbage!(collection))
      .rejects.toThrow("group deleted before owner cleanup");
    const ownerPath = join(
      rootDir,
      "agent-group-result-ref-owners",
      `${recordKey(resultRef)}.json`,
    );
    const owner = await store.readJson<any>(ownerPath);
    await store.writeJson(ownerPath, { ...owner, ownerDigest: "malformed" });

    const reopened = createInMemoryOrchestrationServices({ rootDir, store });
    await expect(reopened.tasks.collectAgentGroupGarbage!(collection))
      .rejects.toThrow(/malformed result-reference owner bytes/);
    expect(await store.readJson<any>(join(
      rootDir,
      "agent-group-gc",
      `${recordKey("malformed-owner-group")}.json`,
    ))).toMatchObject({ state: "committed_cleanup" });
  });

  it("never lets an old GC replay delete a result ref reused after committed cleanup", async () => {
    const rootDir = "/gc-owner-reuse";
    const store = createInMemoryDurableStore();
    let injected = false;
    const first = createInMemoryOrchestrationServices({
      rootDir,
      store,
      faultInjection: {
        onPoint(point) {
          if (!injected && point === "agent-group-gc-during-owner-cleanup") {
            injected = true;
            throw new Error("owner cleanup interrupted");
          }
        },
      },
    });
    await createDirectPagedGroup(first.tasks, {
      sessionId: "owner-session-a",
      scopeIdentity: "owner-scope-a",
      groupRef: "owner-group-a",
      launchCallIdentity: "owner-launch-a",
      memberCallIdentity: "owner-member-a",
      taskRef: "owner-task-a",
    });
    expect(await projectDirectResultRef(first.tasks, {
      sessionId: "owner-session-a",
      scopeIdentity: "owner-scope-a",
      groupRef: "owner-group-a",
      taskRef: "owner-task-a",
      callIdentity: "owner-page-a",
      requestIdempotencyKey: "owner-request-a",
      afterSequence: 0,
      memberRevision: 1,
      resultRef: "reusable-result-ref",
    })).toMatchObject({ outcome: "applied" });
    expect(await projectDirectResultRef(first.tasks, {
      sessionId: "owner-session-a",
      scopeIdentity: "owner-scope-a",
      groupRef: "owner-group-a",
      taskRef: "owner-task-a",
      callIdentity: "owner-page-a-2",
      requestIdempotencyKey: "owner-request-a-2",
      afterSequence: 1,
      memberRevision: 2,
      resultRef: "reusable-result-ref",
      memberStateDigest: stableHash({ status: "succeeded", resultRef: "reusable-result-ref" }),
    })).toMatchObject({ outcome: "applied" });
    const terminal = await first.tasks.getAgentGroupPageState!({
      sessionId: "owner-session-a",
      groupRef: "owner-group-a",
    });
    const collection = {
      sessionId: "owner-session-a",
      groupRef: "owner-group-a",
      expectedAggregateVersion: terminal!.aggregateVersion,
      expectedGroupObservationDigest: terminal!.groupObservationDigest,
    };
    await expect(first.tasks.collectAgentGroupGarbage!(collection))
      .rejects.toThrow("owner cleanup interrupted");

    const reopened = createInMemoryOrchestrationServices({ rootDir, store });
    await createDirectPagedGroup(reopened.tasks, {
      sessionId: "owner-session-b",
      scopeIdentity: "owner-scope-b",
      groupRef: "owner-group-b",
      launchCallIdentity: "owner-launch-b",
      memberCallIdentity: "owner-member-b",
      taskRef: "owner-task-b",
    });
    expect(await projectDirectResultRef(reopened.tasks, {
      sessionId: "owner-session-b",
      scopeIdentity: "owner-scope-b",
      groupRef: "owner-group-b",
      taskRef: "owner-task-b",
      callIdentity: "owner-page-b",
      requestIdempotencyKey: "owner-request-b",
      afterSequence: 0,
      memberRevision: 1,
      resultRef: "reusable-result-ref",
    })).toMatchObject({ outcome: "applied" });
    const ownerPath = join(
      rootDir,
      "agent-group-result-ref-owners",
      `${recordKey("reusable-result-ref")}.json`,
    );
    const replacementOwner = await store.readJson<any>(ownerPath);
    expect(await reopened.tasks.collectAgentGroupGarbage!(collection))
      .toMatchObject({ outcome: "collected" });
    expect(await reopened.tasks.collectAgentGroupGarbage!(collection))
      .toMatchObject({ outcome: "replayed" });
    expect(await store.readJson<any>(ownerPath)).toEqual(replacementOwner);
  });

  it("validates exact GC task and call bindings before deletion", async () => {
    const rootDir = "/strict-gc-deletion";
    const store = createInMemoryDurableStore();
    let injected = false;
    const first = createInMemoryOrchestrationServices({
      rootDir,
      store,
      faultInjection: {
        onPoint(point) {
          if (!injected && point === "agent-group-gc-after-prepare") {
            injected = true;
            throw new Error("GC marker prepared for corruption test");
          }
        },
      },
    });
    await createDirectPagedGroup(first.tasks, {
      sessionId: "strict-gc-session",
      scopeIdentity: "strict-gc-scope",
      groupRef: "strict-gc-group",
      launchCallIdentity: "strict-gc-launch",
      memberCallIdentity: "strict-gc-member",
      taskRef: "strict-gc-task",
    });
    expect(await projectDirectResultRef(first.tasks, {
      sessionId: "strict-gc-session",
      scopeIdentity: "strict-gc-scope",
      groupRef: "strict-gc-group",
      taskRef: "strict-gc-task",
      callIdentity: "strict-gc-page",
      requestIdempotencyKey: "strict-gc-request",
      afterSequence: 0,
      memberRevision: 1,
    })).toMatchObject({ outcome: "applied" });
    const terminal = await first.tasks.getAgentGroupPageState!({
      sessionId: "strict-gc-session",
      groupRef: "strict-gc-group",
    });
    const collection = {
      sessionId: "strict-gc-session",
      groupRef: "strict-gc-group",
      expectedAggregateVersion: terminal!.aggregateVersion,
      expectedGroupObservationDigest: terminal!.groupObservationDigest,
    };
    await expect(first.tasks.collectAgentGroupGarbage!(collection))
      .rejects.toThrow("GC marker prepared for corruption test");
    const markerPath = join(rootDir, "agent-group-gc", `${recordKey("strict-gc-group")}.json`);
    const marker = await store.readJson<any>(markerPath);
    const members = marker.members.map((member: any, index: number) => index === 0
      ? { ...member, callIdentity: "well-formed-but-wrong-call-binding" }
      : member);
    await store.writeJson(markerPath, { ...marker, members, membersDigest: stableHash(members) });
    const reopened = createInMemoryOrchestrationServices({ rootDir, store });
    await expect(reopened.tasks.collectAgentGroupGarbage!(collection))
      .rejects.toThrow(/GC (task deletion binding|member publication authority) is invalid|GC member publication authority is incomplete/);
    expect(await reopened.tasks.getAgentGroupPageState!({
      sessionId: "strict-gc-session",
      groupRef: "strict-gc-group",
    })).toMatchObject({ aggregateVersion: 1 });
  });

  it("fails closed on malformed persisted group/member enums, accounting, and conditional fields", async () => {
    const rootDir = "/strict-persisted-schema";
    const store = createInMemoryDurableStore();
    const services = createInMemoryOrchestrationServices({ rootDir, store });
    const { launcher } = pagedLauncher(1);
    const launched = await launch(tools(launcher, 1, services.tasks).tools.start_agent_group, 1);
    const task = await services.tasks.getTask({
      sessionId: "paged-session",
      taskId: launched.members[0].taskId,
    });
    const scopeIdentity = task!.agentGroupScopeIdentity!;
    const sessionKey = stableHash(
      { kind: "session", sessionId: "paged-session" },
      { format: "base32hex" },
    );
    const pageDir = join(rootDir, "agent-group-pages", sessionKey, recordKey(scopeIdentity));
    const memberPath = join(pageDir, "members", "0.json");
    const authorityPath = join(pageDir, "authority.json");
    const originalMember = await store.readJson<any>(memberPath);
    const originalAuthority = await store.readJson<any>(authorityPath);
    const call = {
      sessionId: "paged-session",
      scopeIdentity,
      groupRef,
      callIdentity: "strict-schema-call",
      operationKind: "watch" as const,
      canonicalInputDigest: stableHash("strict-schema-call"),
      requestIdempotencyKey: "strict-schema-request",
      maximumChanges: 1,
      maximumBytes: 1_000_000,
      maximumCursorBytes: 256,
    };
    expect(await services.tasks.bindAgentGroupPageCall?.(call))
      .toMatchObject({ outcome: "applied" });
    const projection = {
      sessionId: "paged-session",
      scopeIdentity,
      groupRef,
      requestIdempotencyKey: call.requestIdempotencyKey,
      pageDigest: stableHash("strict-schema-page"),
      afterSequence: 0,
      throughSequence: 1,
      aggregateVersion: 1,
      groupStatus: "satisfied" as const,
      aggregate: aggregate(1, 1),
      groupObservationDigest: stableHash("strict-schema-group"),
      groupObservedAt: acceptedAt,
      pageCallIdentity: call.callIdentity,
      changes: [Object.freeze({
        sequence: 1,
        memberId: "member_1",
        memberIndex: 0,
        taskRef: taskRef(0),
        memberStatus: "succeeded" as const,
        memberRevision: 1,
        memberObservationDigest: stableHash("strict-member-observation"),
        memberStateDigest: stableHash("strict-member-state"),
        memberObservedAt: acceptedAt,
        status: "completed" as const,
        verifiedSucceeded: false,
        hasResultRef: false,
      })],
    };
    const corruptions = [
      (member: any) => ({ ...member, accounting: { ...member.accounting, status: "unknown" } }),
      (member: any) => ({ ...member, accounting: { ...member.accounting, verifiedSucceeded: "false" } }),
      (member: any) => ({ ...member, record: { ...member.record, status: "unknown" } }),
      (member: any) => ({ ...member, record: { ...member.record, agentMemberRevision: -1 } }),
      (member: any) => ({
        ...member,
        record: { ...member.record, terminalCauseCode: "cancelled" },
      }),
    ];
    for (const corrupt of corruptions) {
      await store.writeJson(memberPath, corrupt(originalMember));
      await expect(services.tasks.projectAgentGroupPage?.(projection))
        .rejects.toThrow(/Stored Agent Group page member is invalid/);
      await store.writeJson(memberPath, originalMember);
    }
    await store.writeJson(authorityPath, {
      ...originalAuthority,
      state: { ...originalAuthority.state, groupStatus: "unknown" },
    });
    await expect(services.tasks.getAgentGroupPageState?.({ sessionId: "paged-session", groupRef }))
      .rejects.toThrow(/page authority is invalid/);
  });

  it("replays an accepted start receipt without relaunching after response loss", async () => {
    const store = createInMemoryDurableStore();
    let injected = false;
    const services = createInMemoryOrchestrationServices({
      store,
      faultInjection: {
        onPoint(point) {
          if (!injected && point === "agent-group-start-binding-after-authority-commit") {
            injected = true;
            throw new Error("lost start response");
          }
        },
      },
    });
    let startAttempt = 0;
    const { launcher: baseLauncher } = pagedLauncher(1);
    const startAgentGroup = vi.fn(async (request: HarnessStartAgentGroupRequest) => {
      startAttempt += 1;
      const result = started(request);
      if (startAttempt === 1) return result;
      return {
        ...result,
        members: result.members.map((member) => ({
          ...member,
          taskRef: `conflicting-${member.memberIndex}` as HarnessExternalAgentTaskRef,
        })),
      };
    });
    const groupTools = tools({ ...baseLauncher, startAgentGroup }, 1, services.tasks).tools;
    const input = { members: [{ prompt: "x", profileHandle: "worker" }] };
    await expect(execute(groupTools.start_agent_group, input, "lost-start-call"))
      .rejects.toThrow("lost start response");
    await expect(execute(groupTools.start_agent_group, input, "lost-start-call"))
      .resolves.toMatchObject({ status: "started", groupRef });

    const member = (await services.tasks.listTasks({ sessionId: "paged-session" }))[0]!;
    expect(member.externalAgentTaskRef).toBe(taskRef(0));
    expect(startAgentGroup).toHaveBeenCalledTimes(1);
  });

  it("rejects partial page capability and keeps the legacy member ceiling unchanged", () => {
    const legacy: TestLauncher = {
      startAgentGroup: async (request) => started(request),
      watchAgentGroup: async () => { throw new Error("unused"); },
      joinAgentGroup: async () => { throw new Error("unused"); },
      cancelAgentGroup: async () => { throw new Error("unused"); },
    };
    expect(() => agents(legacy, 10_000)).toThrow(/maxMembers/);
    expect(() => agents({ ...legacy, watchAgentGroupPage: async () => { throw new Error("unused"); } }, 1))
      .toThrow(/launcher\.paged with watch, join and cancel/);
  });
});
