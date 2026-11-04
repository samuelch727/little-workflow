import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createInMemoryTaskLedger, type HarnessTaskLedger } from "../tasks/ledger.js";
import type { HarnessAsyncToolTaskKind } from "../tasks/types.js";
import {
  HarnessAgentGroupLaunchRejectedError,
  type HarnessAgentGroupLauncher,
  type HarnessExternalAgentGroupRef,
  type HarnessExternalAgentResultRef,
  type HarnessExternalAgentTaskRef,
  type HarnessStartAgentGroupRequest,
} from "./types.js";
import { createAgentGroupTools, resolveAgentGroupsOptions } from "./tools.js";

const groupRef = "external-group-1" as HarnessExternalAgentGroupRef;
const acceptedAt = new Date(Date.now() + 60_000).toISOString();

function taskRef(index: number): HarnessExternalAgentTaskRef {
  return `external-task-${index + 1}` as HarnessExternalAgentTaskRef;
}

function resultRef(index: number): HarnessExternalAgentResultRef {
  return `external-result-${index + 1}` as HarnessExternalAgentResultRef;
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

function launcher(overrides: Partial<HarnessAgentGroupLauncher> = {}): HarnessAgentGroupLauncher {
  return {
    startAgentGroup: async (request) => started(request),
    watchAgentGroup: async (request) => ({
      groupRef: request.groupRef,
      groupRevision: 1,
      status: "running",
      members: [],
      observedAt: acceptedAt,
    }),
    joinAgentGroup: async (request) => ({
      groupRef: request.groupRef,
      groupRevision: 1,
      status: "satisfied",
      disposition: "satisfied",
      members: [],
      observedAt: acceptedAt,
      resultRefs: [],
    }),
    cancelAgentGroup: async (request) => ({
      groupRef: request.groupRef,
      groupRevision: 1,
      status: "cancelled",
      disposition: "cancelled",
      members: [],
      cancelledAt: acceptedAt,
    }),
    ...overrides,
  };
}

function agents(
  adapter: HarnessAgentGroupLauncher,
  limitOverrides: Partial<{
    maxMembers: number;
    maxPromptBytes: number;
    maxGroupPromptBytes: number;
    maxDeadlineMs: number;
    maxJoinWaitMs: number;
  }> = {},
) {
  return resolveAgentGroupsOptions({
    launcher: adapter,
    profiles: [{
      handle: "reviewer",
      description: "Repository reviewer with bounded capabilities.",
      resourcesHandle: "cpu-medium",
      secretsHandle: "repo-read",
      toolsHandle: "code-review",
      networkHandle: "package-registry",
      priorityHandle: "interactive",
    }],
    joinPolicies: [
      { handle: "all", policy: { kind: "all_success" } },
      {
        handle: "verified",
        policy: { kind: "first_verified" },
        verifierHandle: "signed-review-verifier",
        requiredCheckSetHandle: "review-checks-v1",
      },
      { handle: "quorum-2", policy: { kind: "quorum", count: 2 } },
    ],
    defaultJoinPolicyHandle: "all",
    reductionPolicies: [{
      handle: "concise",
      maxMemberSummaryBytes: 128,
      maxGroupSummaryBytes: 256,
      maxResultRefs: 4,
    }],
    defaultReductionPolicyHandle: "concise",
    limits: {
      maxMembers: 4,
      maxPromptBytes: 256,
      maxGroupPromptBytes: 1_024,
      maxDeadlineMs: 60_000,
      maxJoinWaitMs: 5_000,
      ...limitOverrides,
    },
  });
}

function tools(
  adapter: HarnessAgentGroupLauncher,
  ledger = createInMemoryTaskLedger(),
  limitOverrides: Parameters<typeof agents>[1] = {},
) {
  return {
    ledger,
    tools: createAgentGroupTools({
      sessionId: "session-1",
      originTurnId: "turn-1",
      ledger,
      agents: agents(adapter, limitOverrides),
    }),
  };
}

const executionOptions = {
  toolCallId: "provider-call-1",
  context: { modelStepId: "step-1", sequenceIndex: 0 },
};

async function execute(
  toolValue: unknown,
  input: unknown,
  options: unknown = executionOptions,
): Promise<any> {
  const executable = toolValue as { execute?: (value: any, execution: any) => Promise<unknown> };
  if (executable.execute === undefined) throw new Error("test tool is not executable");
  return await executable.execute(input, options);
}

describe("Agent Group tools", () => {
  it("atomically launches immutable ordered members with Harness identities and trusted profiles", async () => {
    const startAgentGroup = vi.fn(async (request: HarnessStartAgentGroupRequest) => started(request));
    const { ledger, tools: groupTools } = tools(launcher({ startAgentGroup }));

    const output = await execute(groupTools.start_agent_group, {
      members: [
        { name: "review-a", purpose: "Review API", prompt: "Review API boundaries", profileHandle: "reviewer" },
        { name: "review-b", purpose: "Review tests", prompt: "Review test coverage", profileHandle: "reviewer" },
      ],
      joinPolicyHandle: "verified",
      reductionPolicyHandle: "concise",
      deadlineMs: 30_000,
      onDeadline: "cancel_pending",
    });

    expect(output).toMatchObject({
      status: "started",
      groupRef,
      joinPolicyHandle: "verified",
      members: [
        { memberId: "member_1", memberIndex: 0, taskId: "task_1" },
        { memberId: "member_2", memberIndex: 1, taskId: "task_2" },
      ],
    });
    expect(output.members.every((member: Record<string, unknown>) => !("taskRef" in member))).toBe(true);
    const request = startAgentGroup.mock.calls[0]![0];
    expect(Object.isFrozen(request.members)).toBe(true);
    expect(request.members.map((member) => member.memberId)).toEqual(["member_1", "member_2"]);
    expect(request.members.map((member) => member.harnessTaskId)).toEqual(["task_1", "task_2"]);
    expect(request.callIdentity).toMatch(/^agc_/u);
    expect(request.scopeIdentity).toMatch(/^ags_/u);
    expect(request.members.every((member) => member.callIdentity.length > 20)).toBe(true);
    expect(request.joinPolicy).toEqual({
      handle: "verified",
      policy: { kind: "first_verified" },
      verifierHandle: "signed-review-verifier",
      requiredCheckSetHandle: "review-checks-v1",
    });
    expect(request.members[0]!.profile).toMatchObject({
      resourcesHandle: "cpu-medium",
      secretsHandle: "repo-read",
      toolsHandle: "code-review",
      networkHandle: "package-registry",
      priorityHandle: "interactive",
    });
    expect((await ledger.listTasks({ sessionId: "session-1" })).map((task) => task.kind))
      .toEqual(["agent", "agent"]);
  });

  it("strictly rejects raw capability requests and undeclared profile handles", async () => {
    const { tools: groupTools } = tools(launcher());
    const schema = (groupTools.start_agent_group as { inputSchema: z.ZodType }).inputSchema;
    expect(() => schema.parse({
      members: [{
        prompt: "do work",
        profileHandle: "reviewer",
        resources: { cpu: 64 },
        secrets: ["raw-token"],
        tools: ["unbounded-shell"],
        network: "full",
        priority: 999,
      }],
    })).toThrow();

    await expect(execute(groupTools.start_agent_group, {
      members: [{ prompt: "do work", profileHandle: "not-declared" }],
    })).rejects.toThrow(/not declared/i);

    await expect(execute(groupTools.start_agent_group, {
      members: [{ prompt: "Review Unicode safely 🧪", profileHandle: "reviewer" }],
    }, { ...executionOptions, toolCallId: "unicode-valid" })).resolves.toMatchObject({ status: "started" });
    await expect(execute(groupTools.start_agent_group, {
      members: [{ prompt: "unpaired \uD800", profileHandle: "reviewer" }],
    }, { ...executionOptions, toolCallId: "unicode-invalid" })).rejects.toThrow(/invalid text/i);
  });

  it("enumerates trusted handles and descriptions in model-facing schemas", () => {
    const { tools: groupTools } = tools(launcher());
    const schema = (groupTools.start_agent_group as { inputSchema: any }).inputSchema;
    const member = schema.shape.members.element;
    expect(member.shape.profileHandle.options).toEqual(["reviewer"]);
    expect(member.shape.profileHandle.description).toContain(
      "reviewer — Repository reviewer with bounded capabilities.",
    );
    expect(schema.shape.joinPolicyHandle.unwrap().options).toEqual(["all", "verified", "quorum-2"]);
    expect(schema.shape.reductionPolicyHandle.unwrap().options).toEqual(["concise"]);
    expect(member.shape.profileHandle.description).not.toContain("repo-read");
  });

  it("enforces aggregate prompt bytes and reserves large groups concurrently", async () => {
    const bounded = tools(launcher(), createInMemoryTaskLedger(), { maxGroupPromptBytes: 10 });
    await expect(execute(bounded.tools.start_agent_group, {
      members: [
        { prompt: "123456", profileHandle: "reviewer" },
        { prompt: "abcdef", profileHandle: "reviewer" },
      ],
    })).rejects.toThrow(/aggregate byte bound/i);

    const base = createInMemoryTaskLedger();
    let reserveCalls = 0;
    let release!: () => void;
    const allReservationsEntered = new Promise<void>((resolve) => { release = resolve; });
    const concurrentLedger: HarnessTaskLedger = {
      ...base,
      reserveTask: async (input) => {
        reserveCalls += 1;
        if (reserveCalls === 2) release();
        await allReservationsEntered;
        return await base.reserveTask(input);
      },
    };
    const concurrent = tools(launcher(), concurrentLedger);
    await expect(execute(concurrent.tools.start_agent_group, {
      members: [
        { prompt: "one", profileHandle: "reviewer" },
        { prompt: "two", profileHandle: "reviewer" },
      ],
    }, { ...executionOptions, toolCallId: "parallel-reservations" }))
      .resolves.toMatchObject({ members: [{ taskId: expect.any(String) }, { taskId: expect.any(String) }] });
    expect(reserveCalls).toBe(2);
  });

  it("requires Agent Group ledger capabilities only when Agent Groups are enabled", () => {
    const base = createInMemoryTaskLedger();
    const {
      bindAgentGroupStart: _bindAgentGroupStart,
      projectAgentGroupObservation: _projectAgentGroupObservation,
      ...legacyLedger
    } = base;
    expect(() => createAgentGroupTools({
      sessionId: "session-legacy",
      originTurnId: "turn-legacy",
      ledger: legacyLedger,
      agents: agents(launcher()),
    })).toThrow(/ledger start-binding and observation-projection capabilities/i);
  });

  it("lowers spawn_agent to the same one-member atomic group port", async () => {
    const startAgentGroup = vi.fn(async (request: HarnessStartAgentGroupRequest) => started(request));
    const { tools: groupTools } = tools(launcher({ startAgentGroup }));
    const output = await execute(groupTools.spawn_agent, {
      name: "solo",
      prompt: "Review the change",
      profileHandle: "reviewer",
    });
    expect(startAgentGroup).toHaveBeenCalledOnce();
    expect(startAgentGroup.mock.calls[0]![0].members).toHaveLength(1);
    expect(startAgentGroup.mock.calls[0]![0].joinPolicy.handle).toBe("all");
    expect(output.member).toMatchObject({ memberId: "member_1", taskId: "task_1" });
    expect(output.member).not.toHaveProperty("taskRef");
  });

  it("atomically binds start without per-task updates and rejects reused external group refs", async () => {
    const base = createInMemoryTaskLedger();
    const updateTask = vi.fn(async () => { throw new Error("per-task update must not run"); });
    const ledger: HarnessTaskLedger = { ...base, updateTask };
    const { tools: groupTools } = tools(launcher(), ledger);
    await expect(execute(groupTools.start_agent_group, {
      members: [{ prompt: "first group", profileHandle: "reviewer" }],
    }, { ...executionOptions, toolCallId: "unique-group-1" })).resolves.toMatchObject({ groupRef });
    expect(updateTask).not.toHaveBeenCalled();

    await expect(execute(groupTools.start_agent_group, {
      members: [{ prompt: "second group", profileHandle: "reviewer" }],
    }, { ...executionOptions, toolCallId: "unique-group-2" }))
      .rejects.toThrow(/atomically bound/i);
  });

  it("keeps indeterminate start response loss queued and converges with identical retry identities", async () => {
    const requests: HarnessStartAgentGroupRequest[] = [];
    let attempt = 0;
    const adapter = launcher({
      startAgentGroup: async (request) => {
        requests.push(request);
        attempt += 1;
        if (attempt === 1) throw new Error("response lost after possible acceptance");
        return started(request);
      },
    });
    const { ledger, tools: groupTools } = tools(adapter);
    const input = { members: [{ prompt: "retry me", profileHandle: "reviewer" }] };

    await expect(execute(groupTools.start_agent_group, input)).rejects.toThrow(/response lost/i);
    expect(await ledger.listTasks({ sessionId: "session-1" })).toMatchObject([
      { taskId: "task_1", status: "queued", kind: "agent" },
    ]);
    await expect(execute(groupTools.start_agent_group, input)).resolves.toMatchObject({
      groupRef,
      members: [{ taskId: "task_1" }],
    });
    expect(requests).toHaveLength(2);
    expect(requests[1]!.callIdentity).toBe(requests[0]!.callIdentity);
    expect(requests[1]!.scopeIdentity).toBe(requests[0]!.scopeIdentity);
    expect(requests[1]!.deadlineAt).toBe(requests[0]!.deadlineAt);
    expect(requests[1]!.members[0]!.callIdentity).toBe(requests[0]!.members[0]!.callIdentity);
    expect(await ledger.listTasks({ sessionId: "session-1" })).toHaveLength(1);
  });

  it("terminalizes definitive rejection and deterministic partial reservation failure", async () => {
    const rejectStart = vi.fn(async () => { throw new HarnessAgentGroupLaunchRejectedError(); });
    const rejected = tools(launcher({
      startAgentGroup: rejectStart,
    }));
    const rejectedInput = {
      members: [{ prompt: "reject", profileHandle: "reviewer" }],
    };
    await expect(execute(rejected.tools.start_agent_group, rejectedInput))
      .rejects.toBeInstanceOf(HarnessAgentGroupLaunchRejectedError);
    expect(await rejected.ledger.listTasks({ sessionId: "session-1" })).toMatchObject([
      { status: "failed", terminalCauseCode: "launch_corruption" },
    ]);
    await expect(execute(rejected.tools.start_agent_group, rejectedInput))
      .rejects.toThrow(/already terminalized/i);
    expect(rejectStart).toHaveBeenCalledOnce();

    const base = createInMemoryTaskLedger();
    let reserveCount = 0;
    const partial: HarnessTaskLedger = {
      ...base,
      reserveTask: async (input) => {
        reserveCount += 1;
        if (reserveCount === 2) throw new Error("reservation storage failed");
        return await base.reserveTask(input);
      },
    };
    const partialTools = tools(launcher(), partial);
    await expect(execute(partialTools.tools.start_agent_group, {
      members: [
        { prompt: "one", profileHandle: "reviewer" },
        { prompt: "two", profileHandle: "reviewer" },
      ],
    })).rejects.toThrow(/storage failed/i);
    expect(await base.listTasks({ sessionId: "session-1" })).toMatchObject([
      { status: "failed", terminalCauseCode: "launch_corruption" },
    ]);
  });

  it("rejects unbound first_verified and quorum policies before launch", async () => {
    expect(() => resolveAgentGroupsOptions({
      launcher: launcher(),
      profiles: [{
        handle: "reviewer",
        resourcesHandle: "r",
        secretsHandle: "s",
        toolsHandle: "t",
        networkHandle: "n",
        priorityHandle: "p",
      }],
      joinPolicies: [{ handle: "unsafe", policy: { kind: "first_verified" } }],
      defaultJoinPolicyHandle: "unsafe",
      reductionPolicies: [{
        handle: "concise",
        maxMemberSummaryBytes: 1,
        maxGroupSummaryBytes: 1,
        maxResultRefs: 0,
      }],
      defaultReductionPolicyHandle: "concise",
    })).toThrow(/verifier and check-set/i);

    const { tools: groupTools } = tools(launcher());
    await expect(execute(groupTools.start_agent_group, {
      members: [{ prompt: "one", profileHandle: "reviewer" }],
      joinPolicyHandle: "quorum-2",
    })).rejects.toThrow(/quorum exceeds/i);
  });

  it("strictly bounds observations and never admits raw child output into model context", async () => {
    let watchVariant: "raw" | "accessor" | "verified" | "oversized" | "foreign-order" = "raw";
    const adapter = launcher({
      watchAgentGroup: async (request) => {
        const members: any[] = [{
          memberId: "member_1",
          memberIndex: 0,
          taskRef: taskRef(0),
          revision: 1,
          status: "succeeded",
          summary: watchVariant === "oversized" ? "x".repeat(129) : "safe summary",
          resultRef: resultRef(0),
          updatedAt: acceptedAt,
          ...(watchVariant === "raw" ? { output: "raw child transcript must never enter context" } : {}),
        }];
        if (watchVariant === "verified") members[0].verified = "yes";
        if (watchVariant === "accessor") {
          Object.defineProperty(members[0], "summary", {
            enumerable: true,
            get: () => "accessor output must not cross the adapter boundary",
          });
        }
        if (watchVariant === "foreign-order") members[0].memberId = "member_999";
        return {
          groupRef: request.groupRef,
          groupRevision: 1,
          status: "satisfied",
          members,
          observedAt: acceptedAt,
        };
      },
    });
    const { tools: groupTools } = tools(adapter);
    await execute(groupTools.start_agent_group, {
      members: [{ prompt: "watch me", profileHandle: "reviewer" }],
    });

    await expect(execute(groupTools.watch_agent_group, { groupRef }, {
      ...executionOptions,
      toolCallId: "watch-raw",
    })).rejects.toThrow(/undeclared fields/i);
    watchVariant = "accessor";
    await expect(execute(groupTools.watch_agent_group, { groupRef }, {
      ...executionOptions,
      toolCallId: "watch-accessor",
    })).rejects.toThrow(/undeclared fields/i);
    watchVariant = "verified";
    await expect(execute(groupTools.watch_agent_group, { groupRef }, {
      ...executionOptions,
      toolCallId: "watch-verified",
    })).rejects.toThrow(/undeclared fields/i);
    watchVariant = "oversized";
    await expect(execute(groupTools.watch_agent_group, { groupRef }, {
      ...executionOptions,
      toolCallId: "watch-oversized",
    })).rejects.toThrow(/summary exceeds/i);
    watchVariant = "foreign-order";
    await expect(execute(groupTools.watch_agent_group, { groupRef }, {
      ...executionOptions,
      toolCallId: "watch-order",
    })).rejects.toThrow(/ordered task identity/i);
  });

  it("rejects a legacy result reference from a nonterminal member", async () => {
    const adapter = launcher({
      watchAgentGroup: async (request) => ({
        groupRef: request.groupRef,
        groupRevision: 1,
        status: "running",
        members: [{
          memberId: "member_1",
          memberIndex: 0,
          taskRef: taskRef(0),
          revision: 1,
          status: "running",
          resultRef: resultRef(0),
          updatedAt: acceptedAt,
        }],
        observedAt: acceptedAt,
      }),
    });
    const { tools: groupTools } = tools(adapter);
    await execute(groupTools.start_agent_group, {
      members: [{ prompt: "watch me", profileHandle: "reviewer" }],
    });
    await expect(execute(groupTools.watch_agent_group, { groupRef }, {
      ...executionOptions,
      toolCallId: "watch-early-result-ref",
    })).rejects.toThrow(/Only a terminal Agent Group member may publish a result reference/);
  });

  it("projects bounded summaries while rejecting join refs outside member results", async () => {
    let foreignJoinRef = true;
    const member = {
      memberId: "member_1",
      memberIndex: 0,
      taskRef: taskRef(0),
      revision: 1,
      status: "succeeded" as const,
      summary: "verified result",
      resultRef: resultRef(0),
      updatedAt: acceptedAt,
    };
    const adapter = launcher({
      joinAgentGroup: async (request) => ({
        groupRef: request.groupRef,
        groupRevision: 1,
        status: "satisfied",
        disposition: "satisfied",
        members: [member],
        observedAt: acceptedAt,
        summary: "group reduction",
        resultRefs: [foreignJoinRef ? resultRef(1) : resultRef(0)],
      }),
    });
    const { ledger, tools: groupTools } = tools(adapter);
    await execute(groupTools.start_agent_group, {
      members: [{ prompt: "join me", profileHandle: "reviewer" }],
    });
    await expect(execute(groupTools.join_agent_group, { groupRef, maxWaitMs: 10 }, {
      ...executionOptions,
      toolCallId: "join-foreign",
    })).rejects.toThrow(/outside its ordered members/i);

    foreignJoinRef = false;
    const output = await execute(groupTools.join_agent_group, { groupRef, maxWaitMs: 10 }, {
      ...executionOptions,
      toolCallId: "join-valid",
    });
    expect(output).toEqual({
      groupRef,
      groupRevision: 1,
      status: "satisfied",
      observedAt: acceptedAt,
      members: [{
        memberId: member.memberId,
        memberIndex: member.memberIndex,
        revision: member.revision,
        status: member.status,
        summary: member.summary,
        resultRef: member.resultRef,
        updatedAt: member.updatedAt,
      }],
      disposition: "satisfied",
      summary: "group reduction",
      resultRefs: [resultRef(0)],
    });
    const projected = (await ledger.listTasks({ sessionId: "session-1" }))[0]!;
    expect(projected).toMatchObject({
      kind: "agent",
      status: "completed",
      outputSummary: "verified result",
      externalAgentResultRef: resultRef(0),
    });
    expect(projected).not.toHaveProperty("output");
  });

  it("keeps adapter task refs internal across successful watch and cancel output", async () => {
    const adapter = launcher({
      watchAgentGroup: async (request) => ({
        groupRef: request.groupRef,
        groupRevision: 1,
        status: "running",
        members: [{
          memberId: "member_1",
          memberIndex: 0,
          taskRef: taskRef(0),
          revision: 1,
          status: "running",
          updatedAt: acceptedAt,
        }],
        observedAt: acceptedAt,
      }),
      cancelAgentGroup: async (request) => ({
        groupRef: request.groupRef,
        groupRevision: 2,
        status: "cancelled",
        disposition: "cancelled",
        members: [{
          memberId: "member_1",
          memberIndex: 0,
          taskRef: taskRef(0),
          revision: 2,
          status: "cancelled",
          updatedAt: acceptedAt,
        }],
        cancelledAt: acceptedAt,
      }),
    });
    const { tools: groupTools } = tools(adapter);
    await execute(groupTools.start_agent_group, {
      members: [{ prompt: "keep task refs internal", profileHandle: "reviewer" }],
    });
    const watched = await execute(groupTools.watch_agent_group, { groupRef }, {
      ...executionOptions,
      toolCallId: "watch-internal-ref",
    });
    expect(watched.members[0]).not.toHaveProperty("taskRef");
    const cancelled = await execute(groupTools.cancel_agent_group, { groupRef }, {
      ...executionOptions,
      toolCallId: "cancel-internal-ref",
    });
    expect(cancelled.members[0]).not.toHaveProperty("taskRef");
  });

  it("rejects launcher satisfaction that does not meet the trusted first_verified policy", async () => {
    const member = {
      memberId: "member_1",
      memberIndex: 0,
      taskRef: taskRef(0),
      revision: 1,
      status: "succeeded" as const,
      updatedAt: acceptedAt,
    };
    const adapter = launcher({
      joinAgentGroup: async (request) => ({
        groupRef: request.groupRef,
        groupRevision: 1,
        status: "satisfied",
        disposition: "satisfied",
        members: [member],
        observedAt: acceptedAt,
        resultRefs: [],
      }),
    });
    const { tools: groupTools } = tools(adapter);
    await execute(groupTools.start_agent_group, {
      members: [{ prompt: "verify me", profileHandle: "reviewer" }],
      joinPolicyHandle: "verified",
    });

    await expect(execute(groupTools.join_agent_group, { groupRef }, {
      ...executionOptions,
      toolCallId: "join-unverified",
    })).rejects.toThrow(/trusted join policy/i);
  });

  it("accepts only trusted first_verified receipts and exposes only the derived boolean", async () => {
    let trusted = false;
    const adapter = launcher({
      joinAgentGroup: async (request) => ({
        groupRef: request.groupRef,
        groupRevision: 1,
        status: "satisfied",
        disposition: "satisfied",
        members: [{
          memberId: "member_1",
          memberIndex: 0,
          taskRef: taskRef(0),
          revision: 1,
          status: "succeeded",
          verificationReceipt: {
            receiptRef: "verification-receipt-1",
            verifierHandle: trusted ? "signed-review-verifier" : "untrusted-verifier",
            requiredCheckSetHandle: "review-checks-v1",
            verifiedAt: acceptedAt,
          },
          updatedAt: acceptedAt,
        }],
        observedAt: acceptedAt,
        resultRefs: [],
      }),
    });
    const { tools: groupTools } = tools(adapter);
    await execute(groupTools.start_agent_group, {
      members: [{ prompt: "verify receipt", profileHandle: "reviewer" }],
      joinPolicyHandle: "verified",
    });
    await expect(execute(groupTools.join_agent_group, { groupRef }, {
      ...executionOptions,
      toolCallId: "join-untrusted-receipt",
    })).rejects.toThrow(/trusted verifier policy/i);

    trusted = true;
    const output = await execute(groupTools.join_agent_group, { groupRef }, {
      ...executionOptions,
      toolCallId: "join-trusted-receipt",
    });
    expect(output.members[0]).toMatchObject({ verified: true, status: "succeeded" });
    expect(output.members[0]).not.toHaveProperty("verificationReceipt");
    expect(output.members[0]).not.toHaveProperty("taskRef");

    const nonVerified = tools(launcher({
      watchAgentGroup: async (request) => ({
        groupRef: request.groupRef,
        groupRevision: 1,
        status: "running",
        members: [{
          memberId: "member_1",
          memberIndex: 0,
          taskRef: taskRef(0),
          revision: 1,
          status: "succeeded",
          verificationReceipt: {
            receiptRef: "verification-receipt-2",
            verifierHandle: "signed-review-verifier",
            requiredCheckSetHandle: "review-checks-v1",
            verifiedAt: acceptedAt,
          },
          updatedAt: acceptedAt,
        }],
        observedAt: acceptedAt,
      }),
    }));
    await execute(nonVerified.tools.start_agent_group, {
      members: [{ prompt: "not a verified policy", profileHandle: "reviewer" }],
    });
    await expect(execute(nonVerified.tools.watch_agent_group, { groupRef }, {
      ...executionOptions,
      toolCallId: "watch-receipt-without-policy",
    })).rejects.toThrow(/only under a trusted first_verified/i);
  });

  it("fences same-revision join reductions and validates disposition coherence", async () => {
    let summary = "first reduction";
    let mode: "satisfied" | "terminal" | "deadline" = "satisfied";
    const adapter = launcher({
      joinAgentGroup: async (request) => {
        const running = mode === "terminal";
        const failed = mode === "deadline";
        return {
          groupRef: request.groupRef,
          groupRevision: 1,
          status: running ? "running" as const : failed ? "failed" as const : "satisfied" as const,
          disposition: mode,
          members: [{
            memberId: "member_1",
            memberIndex: 0,
            taskRef: taskRef(0),
            revision: 1,
            status: running ? "running" as const : failed ? "failed" as const : "succeeded" as const,
            updatedAt: acceptedAt,
          }],
          observedAt: acceptedAt,
          summary,
          resultRefs: [],
        };
      },
    });
    const { tools: groupTools } = tools(adapter);
    await execute(groupTools.start_agent_group, {
      members: [{ prompt: "join reduction", profileHandle: "reviewer" }],
    });
    await expect(execute(groupTools.join_agent_group, { groupRef }, {
      ...executionOptions,
      toolCallId: "join-reduction-1",
    })).resolves.toMatchObject({ summary: "first reduction" });
    summary = "conflicting reduction";
    await expect(execute(groupTools.join_agent_group, { groupRef }, {
      ...executionOptions,
      toolCallId: "join-reduction-2",
    })).rejects.toThrow(/conflicting bytes/i);

    const coherence = tools(adapter);
    await execute(coherence.tools.start_agent_group, {
      members: [{ prompt: "coherence", profileHandle: "reviewer" }],
    });
    mode = "terminal";
    await expect(execute(coherence.tools.join_agent_group, { groupRef }, {
      ...executionOptions,
      toolCallId: "join-terminal-running",
    })).rejects.toThrow(/before the group was terminal/i);
    mode = "deadline";
    await expect(execute(coherence.tools.join_agent_group, { groupRef }, {
      ...executionOptions,
      toolCallId: "join-deadline-terminal",
    })).rejects.toThrow(/deadline for a terminal/i);
  });

  it("rejects future-poisoned launcher timestamps", async () => {
    const future = new Date(Date.now() + 10 * 60 * 1_000).toISOString();
    const futureStart = tools(launcher({
      startAgentGroup: async (request) => ({ ...started(request), acceptedAt: future }),
    }));
    await expect(execute(futureStart.tools.start_agent_group, {
      members: [{ prompt: "future start", profileHandle: "reviewer" }],
    })).rejects.toThrow(/invalid acceptedAt/i);

    const futureWatch = tools(launcher({
      watchAgentGroup: async (request) => ({
        groupRef: request.groupRef,
        groupRevision: 1,
        status: "running",
        members: [{
          memberId: "member_1",
          memberIndex: 0,
          taskRef: taskRef(0),
          revision: 1,
          status: "running",
          updatedAt: future,
        }],
        observedAt: future,
      }),
    }));
    await execute(futureWatch.tools.start_agent_group, {
      members: [{ prompt: "future watch", profileHandle: "reviewer" }],
    });
    await expect(execute(futureWatch.tools.watch_agent_group, { groupRef }, {
      ...executionOptions,
      toolCallId: "future-watch",
    })).rejects.toThrow(/invalid observedAt/i);
  });

  it("atomically fences a late watch snapshot after a newer terminal join", async () => {
    let releaseWatch!: () => void;
    let watchEntered!: () => void;
    const watchGate = new Promise<void>((resolve) => { releaseWatch = resolve; });
    const entered = new Promise<void>((resolve) => { watchEntered = resolve; });
    const adapter = launcher({
      watchAgentGroup: async (request) => {
        watchEntered();
        await watchGate;
        return {
          groupRef: request.groupRef,
          groupRevision: 1,
          status: "running",
          members: [{
            memberId: "member_1",
            memberIndex: 0,
            taskRef: taskRef(0),
            revision: 1,
            status: "running",
            updatedAt: acceptedAt,
          }],
          observedAt: acceptedAt,
        };
      },
      joinAgentGroup: async (request) => ({
        groupRef: request.groupRef,
        groupRevision: 2,
        status: "satisfied",
        disposition: "satisfied",
        members: [{
          memberId: "member_1",
          memberIndex: 0,
          taskRef: taskRef(0),
          revision: 2,
          status: "succeeded",
          updatedAt: acceptedAt,
        }],
        observedAt: acceptedAt,
        resultRefs: [],
      }),
    });
    const { ledger, tools: groupTools } = tools(adapter);
    await execute(groupTools.start_agent_group, {
      members: [{ prompt: "race safely", profileHandle: "reviewer" }],
    });

    const lateWatch = execute(groupTools.watch_agent_group, { groupRef }, {
      ...executionOptions,
      toolCallId: "late-watch",
    });
    await entered;
    await expect(execute(groupTools.join_agent_group, { groupRef }, {
      ...executionOptions,
      toolCallId: "newer-join",
    })).resolves.toMatchObject({ groupRevision: 2, status: "satisfied" });
    releaseWatch();
    await expect(lateWatch).rejects.toThrow(/stale Agent Group observation/i);
    expect(await ledger.getTask({ sessionId: "session-1", taskId: "task_1" }))
      .toMatchObject({ status: "completed", agentGroupRevision: 2, agentMemberRevision: 2 });
  });

  it("accepts byte-consistent equal-revision replay and rejects conflicting equal revisions", async () => {
    let summary = "same snapshot";
    const adapter = launcher({
      watchAgentGroup: async (request) => ({
        groupRef: request.groupRef,
        groupRevision: 1,
        status: "running",
        members: [{
          memberId: "member_1",
          memberIndex: 0,
          taskRef: taskRef(0),
          revision: 1,
          status: "running",
          summary,
          updatedAt: acceptedAt,
        }],
        observedAt: acceptedAt,
      }),
    });
    const { tools: groupTools } = tools(adapter);
    await execute(groupTools.start_agent_group, {
      members: [{ prompt: "replay safely", profileHandle: "reviewer" }],
    });
    await expect(execute(groupTools.watch_agent_group, { groupRef }, {
      ...executionOptions,
      toolCallId: "watch-revision-1a",
    })).resolves.toMatchObject({ groupRevision: 1 });
    await expect(execute(groupTools.watch_agent_group, { groupRef }, {
      ...executionOptions,
      toolCallId: "watch-revision-1b",
    })).resolves.toMatchObject({ groupRevision: 1 });
    summary = "conflicting bytes";
    await expect(execute(groupTools.watch_agent_group, { groupRef }, {
      ...executionOptions,
      toolCallId: "watch-revision-1c",
    })).rejects.toThrow(/conflicting bytes/i);
  });

  it("rejects a start acceptance timestamp that predates task reservation", async () => {
    const adapter = launcher({
      startAgentGroup: async (request) => ({
        ...started(request),
        acceptedAt: "2000-01-01T00:00:00.000Z",
      }),
    });
    const { tools: groupTools } = tools(adapter);
    await expect(execute(groupTools.start_agent_group, {
      members: [{ prompt: "do not regress time", profileHandle: "reviewer" }],
    })).rejects.toThrow(/predates/i);
  });

  it("keeps agent outside the closed asynchronous tool task kind", () => {
    type AgentIsNotAsyncTool = "agent" extends HarnessAsyncToolTaskKind ? false : true;
    const invariant: AgentIsNotAsyncTool = true;
    expect(invariant).toBe(true);
  });
});
