import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createInMemoryTaskLedger } from "../tasks/ledger.js";
import { stableHash } from "../utils/canonical-hash.js";
import type {
  HarnessAgentGroupLauncher,
  HarnessAgentGroupPageRequest,
  HarnessAgentGroupWorkspace,
  HarnessAgentGroupWorkspaceRequest,
  HarnessExternalAgentGroupRef,
  HarnessExternalAgentTaskRef,
  HarnessJoinAgentGroupPageRequest,
  HarnessStartAgentGroupRequest,
  HarnessWatchAgentGroupPageResult,
} from "./types.js";
import { createAgentGroupTools, resolveAgentGroupsOptions } from "./tools.js";

const groupRef = "workspace-group-1" as HarnessExternalAgentGroupRef;
const acceptedAt = new Date(Date.now() + 60_000).toISOString();

function taskRef(index: number): HarnessExternalAgentTaskRef {
  return `workspace-task-${index + 1}` as HarnessExternalAgentTaskRef;
}

function started(request: HarnessStartAgentGroupRequest) {
  return {
    groupRef,
    acceptedAt,
    members: request.members.map((member, index) => ({
      memberId: member.memberId,
      memberIndex: member.memberIndex,
      taskRef: taskRef(index),
    })),
  };
}

function succeeded(index: number, revision = 1) {
  return {
    memberId: `member_${index + 1}`,
    memberIndex: index,
    taskRef: taskRef(index),
    revision,
    status: "succeeded" as const,
    updatedAt: acceptedAt,
  };
}

function launcher(
  memberCount: number,
  overrides: Partial<HarnessAgentGroupLauncher> = {},
): HarnessAgentGroupLauncher {
  const members = Array.from({ length: memberCount }, (_, index) => succeeded(index));
  return {
    startAgentGroup: async (request) => started(request),
    watchAgentGroup: async (request) => ({
      groupRef: request.groupRef,
      groupRevision: 1,
      status: "satisfied",
      members,
      observedAt: acceptedAt,
    }),
    joinAgentGroup: async (request) => ({
      groupRef: request.groupRef,
      groupRevision: 1,
      status: "satisfied",
      disposition: "satisfied",
      members,
      observedAt: acceptedAt,
      resultRefs: [],
    }),
    cancelAgentGroup: async () => { throw new Error("cancel is not part of these tests"); },
    ...overrides,
  };
}

function tools(adapter: HarnessAgentGroupLauncher) {
  const ledger = createInMemoryTaskLedger();
  return createAgentGroupTools({
    sessionId: "session-1",
    originTurnId: "turn-1",
    ledger,
    agents: resolveAgentGroupsOptions({
      launcher: adapter,
      profiles: [{
        handle: "worker",
        resourcesHandle: "cpu",
        secretsHandle: "none",
        toolsHandle: "code",
        networkHandle: "none",
        priorityHandle: "interactive",
      }],
      joinPolicies: [{ handle: "all", policy: { kind: "all_success" } }],
      defaultJoinPolicyHandle: "all",
      reductionPolicies: [{
        handle: "bounded",
        maxMemberSummaryBytes: 128,
        maxGroupSummaryBytes: 256,
        maxResultRefs: 4,
      }],
      defaultReductionPolicyHandle: "bounded",
      limits: { maxMembers: 4, maxDeadlineMs: 60_000, maxJoinWaitMs: 1_000 },
    }),
  });
}

async function execute(toolValue: unknown, input: unknown, toolCallId = "call-1"): Promise<any> {
  const executable = toolValue as { execute?: (value: any, execution: any) => Promise<unknown> };
  if (executable.execute === undefined) throw new Error("test tool is not executable");
  return await executable.execute(input, {
    toolCallId,
    context: { modelStepId: "step-1", sequenceIndex: 0 },
  });
}

function schemaOf(toolValue: unknown): z.ZodType {
  return (toolValue as { inputSchema: z.ZodType }).inputSchema;
}

function descriptionOf(toolValue: unknown): string {
  return (toolValue as { description: string }).description;
}

const twoMembers = [
  { prompt: "Build the navigation", profileHandle: "worker" },
  { prompt: "Build the catalog", profileHandle: "worker" },
];

const forked: HarnessAgentGroupWorkspace = {
  from: "parent",
  members: [
    { memberId: "member_1", merge: "merged" },
    {
      memberId: "member_2",
      merge: "branch",
      branch: "refs/heads/little-compute/members/member_2",
      conflictPaths: ["src/routes.ts"],
    },
  ],
};

describe("Agent Group workspaces", () => {
  it("leaves the tools exactly as they were for a launcher without workspaces", async () => {
    const startAgentGroup = vi.fn(async (request: HarnessStartAgentGroupRequest) => started(request));
    const groupTools = tools(launcher(2, { startAgentGroup }));
    const start = schemaOf(groupTools.start_agent_group);
    expect(start.safeParse({ members: twoMembers, from: "project" }).success).toBe(false);
    expect(start.safeParse({
      members: twoMembers,
      mergePolicy: [{ glob: "docs/**", policy: "collect" }],
    }).success).toBe(false);
    expect(schemaOf(groupTools.spawn_agent).safeParse({
      prompt: "x",
      profileHandle: "worker",
      from: "parent",
    }).success).toBe(false);
    expect(descriptionOf(groupTools.start_agent_group)).not.toContain("mergePolicy");
    expect(descriptionOf(groupTools.join_agent_group)).not.toContain("workspace");

    await execute(groupTools.start_agent_group, { members: twoMembers });
    expect(startAgentGroup.mock.calls[0]![0]).not.toHaveProperty("workspace");
    // A direct caller that bypasses the schema still cannot send an ask.
    await expect(execute(groupTools.start_agent_group, {
      members: twoMembers,
      from: "project",
    }, "call-2")).rejects.toThrow(/cannot fork or merge/u);
    await expect(execute(groupTools.join_agent_group, { groupRef }, "join-1"))
      .resolves.not.toHaveProperty("workspace");
  });

  it("rejects a workspaces capability without read", () => {
    expect(() => tools({
      ...launcher(1),
      workspaces: {} as never,
    })).toThrow(/launcher\.workspaces with read/u);
  });

  it("carries from and mergePolicy to the launcher and into the call identity", async () => {
    // Two groups in one session need distinct external refs.
    const startAgentGroup = vi.fn(async (request: HarnessStartAgentGroupRequest) => ({
      ...started(request),
      groupRef: `group-${request.callIdentity}` as HarnessExternalAgentGroupRef,
    }));
    const groupTools = tools(launcher(2, {
      startAgentGroup,
      workspaces: { read: async () => undefined },
    }));
    const start = schemaOf(groupTools.start_agent_group);
    expect(start.safeParse({
      members: twoMembers,
      from: "project",
      mergePolicy: [
        { glob: "src/nav/**", policy: "owner", owner: "member_1" },
        { glob: "reports/**", policy: "collect" },
      ],
    }).success).toBe(true);
    expect(start.safeParse({ members: twoMembers, from: "elsewhere" }).success).toBe(false);
    expect(start.safeParse({
      members: twoMembers,
      mergePolicy: [{ glob: "src/**", policy: "owner", owner: "first" }],
    }).success).toBe(false);
    expect(descriptionOf(groupTools.start_agent_group)).toContain("mergePolicy");
    expect(descriptionOf(groupTools.join_agent_group)).toContain("workspace");

    await execute(groupTools.start_agent_group, { members: twoMembers }, "plain");
    await execute(groupTools.start_agent_group, {
      members: twoMembers,
      from: "project",
      mergePolicy: [
        { glob: "src/nav/**", policy: "owner", owner: "member_1" },
        { glob: "reports/**", policy: "collect" },
      ],
    }, "plain");
    const [plain, asked] = startAgentGroup.mock.calls.map((call) => call[0]);
    expect(plain).not.toHaveProperty("workspace");
    expect(asked!.workspace).toEqual({
      from: "project",
      mergePolicies: [
        { glob: "src/nav/**", policy: "owner", owner: "member_1" },
        { glob: "reports/**", policy: "collect" },
      ],
    });
    expect(Object.isFrozen(asked!.workspace)).toBe(true);
    // The same tool call with a different ask is a different group.
    expect(asked!.callIdentity).not.toBe(plain!.callIdentity);
    expect(asked!.scopeIdentity).not.toBe(plain!.scopeIdentity);

    const spawn = vi.fn(async (request: HarnessStartAgentGroupRequest) => started(request));
    const spawnTools = tools(launcher(1, {
      startAgentGroup: spawn,
      workspaces: { read: async () => undefined },
    }));
    await execute(spawnTools.spawn_agent, {
      prompt: "Write the report",
      profileHandle: "worker",
      from: "parent",
      mergePolicy: [{ glob: "reports/**", policy: "owner", owner: "member_1" }],
    });
    expect(spawn.mock.calls[0]![0].workspace).toEqual({
      from: "parent",
      mergePolicies: [{ glob: "reports/**", policy: "owner", owner: "member_1" }],
    });
  });

  it("validates merge rules against the group before any launcher call", async () => {
    const startAgentGroup = vi.fn(async (request: HarnessStartAgentGroupRequest) => started(request));
    const groupTools = tools(launcher(2, {
      startAgentGroup,
      workspaces: { read: async () => undefined },
    }));
    const attempts: [unknown, RegExp][] = [
      [[{ glob: "src/**", policy: "owner", owner: "member_3" }], /member_1 to member_2/u],
      [[{ glob: "src/**", policy: "owner" }], /member_1 to member_2/u],
      [[{ glob: "src/**", policy: "collect", owner: "member_1" }], /Only an owner/u],
      [[{ glob: "src\\app.ts", policy: "three_way" }], /path pattern/u],
      [[{ glob: " src/**", policy: "three_way" }], /path pattern/u],
      [[{ glob: "a".repeat(513), policy: "three_way" }], /path pattern/u],
      [[{ glob: "src/**", policy: "rebase" }], /three_way, collect or owner/u],
      [[{ glob: "src/**", policy: "collect", extra: true }], /rule is invalid/u],
      [[], /1 to 64 rules/u],
      [Array.from({ length: 65 }, () => ({ glob: "src/**", policy: "collect" })), /1 to 64 rules/u],
    ];
    for (const [index, [mergePolicy, expected]] of attempts.entries()) {
      await expect(execute(groupTools.start_agent_group, {
        members: twoMembers,
        mergePolicy,
      }, `invalid-${index}`)).rejects.toThrow(expected);
    }
    await expect(execute(groupTools.start_agent_group, {
      members: twoMembers,
      from: "sideways",
    }, "invalid-from")).rejects.toThrow(/parent or project/u);
    expect(startAgentGroup).not.toHaveBeenCalled();
  });

  it("returns the launcher's workspace outcome on join, and on watch once the group finished", async () => {
    let status: "running" | "satisfied" = "running";
    const read = vi.fn(async (_request: HarnessAgentGroupWorkspaceRequest) => forked);
    const done = [succeeded(0, 2), succeeded(1, 2)];
    const groupTools = tools(launcher(2, {
      watchAgentGroup: async (request) => ({
        groupRef: request.groupRef,
        groupRevision: status === "running" ? 1 : 2,
        status,
        members: status === "running"
          ? [0, 1].map((index) => ({ ...succeeded(index), status: "running" as const }))
          : done,
        observedAt: acceptedAt,
      }),
      joinAgentGroup: async (request) => ({
        groupRef: request.groupRef,
        groupRevision: 2,
        status: "satisfied",
        disposition: "satisfied",
        members: done,
        observedAt: acceptedAt,
        resultRefs: [],
      }),
      workspaces: { read },
    }));
    await execute(groupTools.start_agent_group, { members: twoMembers });

    const running = await execute(groupTools.watch_agent_group, { groupRef }, "watch-running");
    expect(running).not.toHaveProperty("workspace");
    expect(read).not.toHaveBeenCalled();

    const joined = await execute(groupTools.join_agent_group, { groupRef }, "join-1");
    expect(joined.workspace).toEqual(forked);
    const readRequest = read.mock.calls[0]![0];
    expect(readRequest).toMatchObject({
      protocolVersion: "little-harness.agent-groups.v1",
      sessionId: "session-1",
      originTurnId: "turn-1",
      groupRef,
    });
    expect(readRequest.callIdentity).toMatch(/^agc_/u);
    expect(readRequest.scopeIdentity).toMatch(/^ags_/u);

    status = "satisfied";
    const finished = await execute(groupTools.watch_agent_group, { groupRef }, "watch-finished");
    expect(finished.workspace).toEqual(forked);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("omits workspace while the launcher has no outcome, and rejects a malformed one", async () => {
    let outcome: unknown;
    const groupTools = tools(launcher(2, {
      workspaces: { read: async () => outcome as HarnessAgentGroupWorkspace | undefined },
    }));
    await execute(groupTools.start_agent_group, { members: twoMembers });
    await expect(execute(groupTools.join_agent_group, { groupRef }, "join-none"))
      .resolves.not.toHaveProperty("workspace");

    const malformed: unknown[] = [
      { ...forked, mergedRevision: "abc" },
      { ...forked, from: "fork" },
      { ...forked, reason: "configured" },
      { from: "project", reason: "has spaces", members: forked.members },
      { from: "parent", members: [] },
      { from: "parent", members: [{ memberId: "member_3", merge: "merged" }] },
      { from: "parent", members: [{ memberId: "member_1", merge: "merged" }, { memberId: "member_1", merge: "merged" }] },
      { from: "parent", members: [{ memberId: "member_1", merge: "merged", branch: "refs/heads/x" }] },
      { from: "parent", members: [{ memberId: "member_1", merge: "branch" }] },
      { from: "parent", members: [{ memberId: "member_1", merge: "rebased" }] },
      {
        from: "parent",
        members: [{
          memberId: "member_1",
          merge: "branch",
          branch: "refs/heads/x",
          conflictPaths: Array.from({ length: 33 }, (_, index) => `file-${index}`),
        }],
      },
      { from: "parent", members: [{ memberId: "member_1", merge: "branch", branch: "refs/heads/x", conflictPaths: ["a\nb"] }] },
    ];
    for (const [index, value] of malformed.entries()) {
      outcome = value;
      await expect(execute(groupTools.join_agent_group, { groupRef }, `join-bad-${index}`))
        .rejects.toThrow(/workspace/u);
    }

    outcome = {
      from: "project",
      reason: "parent_files_unchanged",
      members: [{ memberId: "member_2", merge: "resolved" }],
    };
    await expect(execute(groupTools.join_agent_group, { groupRef }, "join-project"))
      .resolves.toMatchObject({ workspace: outcome });
  });
});

describe("paged Agent Group workspaces", () => {
  const memberCount = 2;

  function page(request: HarnessAgentGroupPageRequest, through = memberCount): HarnessWatchAgentGroupPageResult {
    const changes = Array.from({ length: through - request.afterSequence }, (_, offset) => {
      const index = request.afterSequence + offset;
      return { sequence: index + 1, member: succeeded(index) };
    });
    const body = {
      requestIdempotencyKey: request.requestIdempotencyKey,
      afterSequence: request.afterSequence,
      throughSequence: through,
      nextPageCursor: `cursor-${through}`,
      hasMore: through < memberCount,
      changes,
    };
    return {
      groupRef: request.groupRef,
      aggregateVersion: through,
      status: through === memberCount ? "satisfied" : "running",
      aggregate: {
        memberCount,
        queuedCount: memberCount - through,
        runningCount: 0,
        succeededCount: through,
        failedCount: 0,
        cancelledCount: 0,
        timedOutCount: 0,
        verifiedSucceededCount: 0,
        resultRefCount: 0,
      },
      memberPage: { ...body, pageDigest: stableHash(body) },
      observedAt: acceptedAt,
    };
  }

  function joined(request: HarnessJoinAgentGroupPageRequest, through: number) {
    const body = {
      operationRef: request.operationRef ?? `operation-${request.operationIdempotencyKey}`,
      kind: "join" as const,
      resultVersion: memberCount,
      disposition: "satisfied" as const,
      completedAt: acceptedAt,
      resultRefs: [],
    };
    return {
      ...page(request, through),
      operationResult: { ...body, resultDigest: stableHash(body) },
    };
  }

  function pagedTools(read: NonNullable<HarnessAgentGroupLauncher["workspaces"]>["read"], through: () => number) {
    return tools({
      ...launcher(memberCount),
      paged: {
        watch: async (request) => page(request, through()),
        join: async (request) => joined(request, through()),
        cancel: async () => { throw new Error("cancel is not part of these tests"); },
      },
      workspaces: { read },
    });
  }

  it("reads the outcome once a join resolves, never while it is still paging", async () => {
    let through = 1;
    const read = vi.fn(async () => forked);
    const groupTools = pagedTools(read, () => through);
    await execute(groupTools.start_agent_group, { members: twoMembers });

    const pending = await execute(groupTools.join_agent_group, { groupRef }, "join-pending");
    expect(pending.operation.state).toBe("pending");
    expect(pending).not.toHaveProperty("workspace");
    expect(read).not.toHaveBeenCalled();

    through = memberCount;
    const resolved = await execute(groupTools.join_agent_group, {
      groupRef,
      operationRef: pending.operation.operationRef,
    }, "join-resolved");
    expect(resolved.operation.state).toBe("resolved");
    expect(resolved.workspace).toEqual(forked);

    const watched = await execute(groupTools.watch_agent_group, { groupRef }, "watch-finished");
    expect(watched.workspace).toEqual(forked);
    expect(read).toHaveBeenCalledTimes(2);
  });
});
