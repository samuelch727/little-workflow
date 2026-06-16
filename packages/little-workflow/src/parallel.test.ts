import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  computeCompiledWorkflowVersionIdentity,
  computeCompilerValidationHash,
  lwirVersionIdForHash,
  type WorkflowVersionLockSeed,
} from "./compiler-lock.js";
import {
  type LwirWorkflow,
  type RuntimeToolHandler,
  appendEvent,
  canonicalJson,
  createToolRegistry,
  executeWorkflowVersion,
  listEvents,
  localWorld,
  sha256Digest,
  writeArtifact,
} from "./index.js";
import { cleanupTempDirs, workerScopedTempPrefix } from "./test-temp.js";
import { concreteInputStructure } from "./workflow-version-reuse.js";

const tempDirs: string[] = [];
const artifactRefMatcher = expect.stringMatching(/^artifact:\/\//u);

async function tempWorld() {
  const dataDir = await mkdtemp(
    join(tmpdir(), workerScopedTempPrefix("little-workflow-parallel-", process.env.VITEST_POOL_ID)),
  );
  tempDirs.push(dataDir);
  return localWorld({ dataDir });
}

afterEach(async () => {
  await cleanupTempDirs(tempDirs);
});

function completedRecord(itemKey: string, output: unknown) {
  return {
    itemKey,
    status: "completed",
    output,
    outputRef: artifactRefMatcher,
    artifacts: expect.arrayContaining([artifactRefMatcher]),
  };
}

function completedRecordValue(
  itemKey: string,
  output: unknown,
  artifactRef: string,
) {
  return {
    itemKey,
    status: "completed",
    output,
    outputRef: artifactRef,
    artifacts: [artifactRef],
  };
}

describe("bounded parallel branches", () => {
  it("runs branches with maxConcurrency and fans in outputs in input order", async () => {
    const world = await tempWorld();
    const release = deferred<void>();
    let concurrencyCheckError: unknown;
    let inFlight = 0;
    let maxInFlight = 0;
    const callIds: string[] = [];
    const score: RuntimeToolHandler = vi.fn(async (input) => {
      const candidate = input as {
        readonly id: string;
        readonly score: number;
        readonly root: string;
      };
      callIds.push(candidate.id);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await release.promise;
      inFlight -= 1;
      return {
        id: candidate.id,
        score: candidate.score * 10,
        root: candidate.root,
      };
    });

    const resultPromise = executeWorkflowVersion({
      world,
      workflowVersion: lockedWorkflowVersion(parallelWorkflow("input"), {
        tools: registryFor({ score }),
      }),
      runId: "run_parallel_input_order",
      input: {
        ticketId: "TIN-11",
        candidates: [
          { id: "c", score: 3 },
          { id: "a", score: 1 },
          { id: "b", score: 2 },
        ],
      },
      tools: registryFor({ score }),
    });
    try {
      await waitUntil(() => maxInFlight === 2, { attempts: 2_000, intervalMs: 5 });
    } catch (error) {
      concurrencyCheckError = error;
    } finally {
      release.resolve();
    }
    const result = await resultPromise;
    if (concurrencyCheckError !== undefined) {
      throw concurrencyCheckError;
    }

    expect(result.status).toBe("completed");
    expect(result.output).toEqual([
      completedRecord("c", { id: "c", score: 30, root: "TIN-11" }),
      completedRecord("a", { id: "a", score: 10, root: "TIN-11" }),
      completedRecord("b", { id: "b", score: 20, root: "TIN-11" }),
    ]);
    expect(maxInFlight).toBe(2);
    expect(callIds).toHaveLength(3);

    const events = await listEvents(world, "run_parallel_input_order");
    const scheduledStepPaths = events
      .filter((event) => event.type === "StepScheduled")
      .map((event) => event.payload.stepPath);
    expect(scheduledStepPaths[0]).toBe("review");
    expect(new Set(scheduledStepPaths.slice(1))).toEqual(
      new Set(["review[c].score", "review[a].score", "review[b].score"]),
    );
    const branchScheduledEvents = events
      .filter((event) => event.type === "ParallelBranchScheduled")
      .sort((left, right) => Number(left.payload.branchIndex) - Number(right.payload.branchIndex));
    expect(branchScheduledEvents).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          stepPath: "review",
          branchPath: "review[c]",
          itemKey: "c",
          branchIndex: 0,
        }),
      }),
      expect.objectContaining({
        payload: expect.objectContaining({
          stepPath: "review",
          branchPath: "review[a]",
          itemKey: "a",
          branchIndex: 1,
        }),
      }),
      expect.objectContaining({
        payload: expect.objectContaining({
          stepPath: "review",
          branchPath: "review[b]",
          itemKey: "b",
          branchIndex: 2,
        }),
      }),
    ]);
    expect(events.some((event) => event.type === "ParallelGroupCompleted")).toBe(true);
  });

  it("fans in outputs in deterministic itemKey order when requested", async () => {
    const world = await tempWorld();
    const score = vi.fn((input: unknown) => {
      const candidate = input as {
        readonly id: string;
        readonly score: number;
        readonly root: string;
      };
      return { id: candidate.id, score: candidate.score, root: candidate.root };
    });

    const result = await executeWorkflowVersion({
      world,
      workflowVersion: lockedWorkflowVersion(parallelWorkflow("itemKey"), {
        tools: registryFor({ score }),
      }),
      runId: "run_parallel_item_key_order",
      input: {
        ticketId: "TIN-11",
        candidates: [
          { id: "c", score: 3 },
          { id: "a", score: 1 },
          { id: "b", score: 2 },
        ],
      },
      tools: registryFor({ score }),
    });

    expect(result.status).toBe("completed");
    expect(result.output).toEqual([
      completedRecord("a", { id: "a", score: 1, root: "TIN-11" }),
      completedRecord("b", { id: "b", score: 2, root: "TIN-11" }),
      completedRecord("c", { id: "c", score: 3, root: "TIN-11" }),
    ]);
  });

  it("fails before branch scheduling when maxBranches or itemKey uniqueness is violated", async () => {
    const world = await tempWorld();
    const score = vi.fn(() => ({ id: "unused", score: 0 }));

    const tooMany = await executeWorkflowVersion({
      world,
      workflowVersion: lockedWorkflowVersion(parallelWorkflow("input", { maxBranches: 2 }), {
        tools: registryFor({ score }),
      }),
      runId: "run_parallel_max_branches",
      input: {
        ticketId: "TIN-11",
        candidates: [
          { id: "a", score: 1 },
          { id: "b", score: 2 },
          { id: "c", score: 3 },
        ],
      },
      tools: registryFor({ score }),
    });

    expect(tooMany.status).toBe("failed");
    if (tooMany.status !== "failed") {
      throw new Error("Expected maxBranches run to fail.");
    }
    expect(tooMany.error).toEqual(
      expect.objectContaining({ message: expect.stringContaining("maxBranches") }),
    );

    const invalidConcurrency = await executeWorkflowVersion({
      world,
      workflowVersion: lockedWorkflowVersion(parallelWorkflow("input", { maxConcurrency: 0 }), {
        tools: registryFor({ score }),
      }),
      runId: "run_parallel_invalid_concurrency",
      input: {
        ticketId: "TIN-11",
        candidates: [{ id: "a", score: 1 }],
      },
      tools: registryFor({ score }),
    });

    expect(invalidConcurrency.status).toBe("failed");
    if (invalidConcurrency.status !== "failed") {
      throw new Error("Expected invalid concurrency run to fail.");
    }
    expect(invalidConcurrency.error).toEqual(
      expect.objectContaining({ message: expect.stringContaining("invalid runtime config") }),
    );

    const overAlphaCap = await executeWorkflowVersion({
      world,
      workflowVersion: lockedWorkflowVersion(parallelWorkflow("input", { maxBranches: 101 }), {
        tools: registryFor({ score }),
      }),
      runId: "run_parallel_over_alpha_cap",
      input: {
        ticketId: "TIN-11",
        candidates: [{ id: "a", score: 1 }],
      },
      tools: registryFor({ score }),
    });

    expect(overAlphaCap.status).toBe("failed");
    if (overAlphaCap.status !== "failed") {
      throw new Error("Expected over-cap maxBranches run to fail.");
    }
    expect(overAlphaCap.error).toEqual(
      expect.objectContaining({ message: expect.stringContaining("invalid runtime config") }),
    );

    const duplicate = await executeWorkflowVersion({
      world,
      workflowVersion: lockedWorkflowVersion(parallelWorkflow("input"), {
        tools: registryFor({ score }),
      }),
      runId: "run_parallel_duplicate_keys",
      input: {
        ticketId: "TIN-11",
        candidates: [
          { id: "a", score: 1 },
          { id: "a", score: 2 },
        ],
      },
      tools: registryFor({ score }),
    });

    expect(duplicate.status).toBe("failed");
    if (duplicate.status !== "failed") {
      throw new Error("Expected duplicate itemKey run to fail.");
    }
    expect(duplicate.error).toEqual(
      expect.objectContaining({ message: expect.stringContaining("Duplicate itemKey") }),
    );
    expect(score).not.toHaveBeenCalled();
  });

  it("does not retry deterministic parallel runtime config failures", async () => {
    const world = await tempWorld();
    const score = vi.fn(() => ({ id: "unused", score: 0 }));

    const result = await executeWorkflowVersion({
      world,
      workflowVersion: lockedWorkflowVersion(
        withParallelRetry(parallelWorkflow("input", { maxConcurrency: 0 }), 2),
        { tools: registryFor({ score }) },
      ),
      runId: "run_parallel_invalid_config_non_retriable",
      input: {
        ticketId: "TIN-11",
        candidates: [{ id: "a", score: 1 }],
      },
      tools: registryFor({ score }),
    });

    expect(result.status).toBe("failed");
    const events = await listEvents(world, "run_parallel_invalid_config_non_retriable");
    expect(events.filter((event) => event.type === "StepAttemptStarted")).toHaveLength(1);
    expect(events.filter((event) => event.type === "StepFailed")).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          stepPath: "review",
          error: expect.objectContaining({
            name: "RuntimeConfigError",
            causeCode: "runtime_config_error",
            retriable: false,
          }),
        }),
      }),
    ]);
    expect(score).not.toHaveBeenCalled();
  });

  it("stops scheduling new branches on fail_fast", async () => {
    const world = await tempWorld();
    const score = vi.fn((input: unknown) => {
      const candidate = input as { readonly id: string };
      if (candidate.id === "bad") {
        throw new Error("cannot score bad candidate");
      }
      return { id: candidate.id, score: 1 };
    });

    const result = await executeWorkflowVersion({
      world,
      workflowVersion: lockedWorkflowVersion(
        parallelWorkflow("input", { failureMode: "fail_fast", maxConcurrency: 1 }),
        { tools: registryFor({ score }) },
      ),
      runId: "run_parallel_fail_fast",
      input: {
        ticketId: "TIN-11",
        candidates: [
          { id: "bad", score: 0 },
          { id: "later", score: 1 },
        ],
      },
      tools: registryFor({ score }),
    });

    expect(result.status).toBe("failed");
    expect(score).toHaveBeenCalledTimes(1);
    const events = await listEvents(world, "run_parallel_fail_fast");
    expect(events.some((event) => event.type === "ParallelBranchFailed")).toBe(true);
    expect(events.some((event) => event.type === "ParallelGroupFailed")).toBe(true);
    expect(events.some((event) => event.type === "ParallelGroupCompleted")).toBe(false);
  });

  it("continues all branches on all_settled and returns settlement envelopes", async () => {
    const world = await tempWorld();
    const score = vi.fn((input: unknown) => {
      const candidate = input as { readonly id: string; readonly score: number; readonly root: string };
      if (candidate.id === "bad") {
        throw new Error("cannot score bad candidate");
      }
      return { id: candidate.id, score: candidate.score, root: candidate.root };
    });

    const result = await executeWorkflowVersion({
      world,
      workflowVersion: lockedWorkflowVersion(
        parallelWorkflow("input", { failureMode: "all_settled", maxConcurrency: 1 }),
        { tools: registryFor({ score }) },
      ),
      runId: "run_parallel_all_settled",
      input: {
        ticketId: "TIN-11",
        candidates: [
          { id: "bad", score: 0 },
          { id: "ok", score: 1 },
        ],
      },
      tools: registryFor({ score }),
    });

    expect(result.status).toBe("completed");
    const output = result.output as readonly {
      readonly itemKey: string;
      readonly status: string;
      readonly output?: unknown;
      readonly outputRef?: string;
      readonly error?: unknown;
      readonly artifacts: readonly string[];
    }[];
    expect(output).toEqual([
      {
        itemKey: "bad",
        status: "failed",
        error: expect.objectContaining({ message: "cannot score bad candidate" }),
        artifacts: [],
      },
      {
        itemKey: "ok",
        status: "completed",
        output: { id: "ok", score: 1, root: "TIN-11" },
        outputRef: expect.stringMatching(/^artifact:\/\//u),
        artifacts: expect.arrayContaining([expect.stringMatching(/^artifact:\/\//u)]),
      },
    ]);
    expect(output[1]?.artifacts).toContain(output[1]?.outputRef);
    expect(score).toHaveBeenCalledTimes(2);
    const events = await listEvents(world, "run_parallel_all_settled");
    expect(events.some((event) => event.type === "ParallelBranchFailed")).toBe(true);
    expect(events.some((event) => event.type === "ParallelGroupCompleted")).toBe(true);
    expect(
      events
        .filter((event) => event.type.startsWith("Parallel"))
        .every((event) => event.payload.attemptId === "attempt_1"),
    ).toBe(true);
    const parent = result.state.steps.review;
    const parentBranchArtifacts = output.flatMap((branch) => branch.artifacts);
    expect(parent?.artifactRefs).toEqual(
      expect.arrayContaining([
        ...(parent?.outputRef === undefined ? [] : [parent.outputRef]),
        ...parentBranchArtifacts,
      ]),
    );

    const replay = await executeWorkflowVersion({
      world,
      workflowVersion: lockedWorkflowVersion(
        parallelWorkflow("input", { failureMode: "all_settled", maxConcurrency: 1 }),
        { tools: registryFor({ score }) },
      ),
      runId: "run_parallel_all_settled",
      input: {
        ticketId: "TIN-11",
        candidates: [
          { id: "bad", score: 0 },
          { id: "ok", score: 1 },
        ],
      },
      tools: registryFor({ score }),
    });

    expect(replay.status).toBe("completed");
    expect(replay.output).toEqual(result.output);
    expect(score).toHaveBeenCalledTimes(2);
  });

  it("fails all_settled runs on branch capability drift", async () => {
    const world = await tempWorld();
    const lockedScore = Object.assign(
      vi.fn<RuntimeToolHandler>(() => ({ id: "ok", score: 1, root: "TIN-11" })),
      {
        description: "Locked score descriptor.",
        inputSchema: true,
      },
    );
    const liveScore = Object.assign(
      vi.fn<RuntimeToolHandler>(() => ({ id: "ok", score: 1, root: "TIN-11" })),
      {
        description: "Drifted score descriptor.",
        inputSchema: true,
      },
    );

    const result = await executeWorkflowVersion({
      world,
      workflowVersion: lockedWorkflowVersion(
        parallelWorkflow("input", { failureMode: "all_settled" }),
        { tools: registryFor({ score: lockedScore }) },
      ),
      runId: "run_parallel_all_settled_capability_drift",
      input: {
        ticketId: "TIN-11",
        candidates: [{ id: "ok", score: 1 }],
      },
      tools: registryFor({ score: liveScore }),
    });

    expect(result.status).toBe("failed");
    expect(liveScore).not.toHaveBeenCalled();
    const events = await listEvents(world, "run_parallel_all_settled_capability_drift");
    expect(events.some((event) => event.type === "ParallelGroupCompleted")).toBe(false);
    expect(events.filter((event) => event.type === "RunFailed")).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          error: expect.objectContaining({
            name: "CapabilityDriftError",
            causeCode: "capability_drift",
            retriable: false,
          }),
        }),
      }),
    ]);
  });

  it("resumes a parallel group with a running parent attempt without re-calling completed branches", async () => {
    const world = await tempWorld();
    const score = vi.fn((input: unknown) => {
      const candidate = input as { readonly id: string; readonly score: number; readonly root: string };
      return { id: candidate.id, score: candidate.score * 10, root: candidate.root };
    });
    const workflowVersion = lockedWorkflowVersion(parallelWorkflow("input"), {
      tools: registryFor({ score }),
    });
    const completedOutput = { id: "done", score: 10, root: "TIN-11" };
    const completedArtifact = await writeArtifact(world, {
      runId: "run_parallel_resume_parent",
      stepPath: "review[done].score",
      name: "output",
      payload: completedOutput,
      contentType: "application/json",
    });
    await appendStartedParallelRun(world, workflowVersion, "run_parallel_resume_parent");
    await appendEvent(world, "run_parallel_resume_parent", {
      type: "ParallelBranchScheduled",
      payload: {
        stepPath: "review",
        branchPath: "review[done]",
        itemKey: "done",
        branchIndex: 0,
      },
    });
    await appendEvent(world, "run_parallel_resume_parent", {
      type: "StepScheduled",
      payload: { stepPath: "review[done].score", stepId: "score", uses: "tool.call" },
    });
    await appendEvent(world, "run_parallel_resume_parent", {
      type: "StepAttemptStarted",
      payload: {
        stepPath: "review[done].score",
        stepId: "score",
        attempt: 1,
        attemptId: "attempt_1",
      },
    });
    await appendEvent(world, "run_parallel_resume_parent", {
      type: "ArtifactCreated",
      payload: {
        stepPath: "review[done].score",
        artifactRef: completedArtifact.artifactRef,
        name: "output",
        contentType: "application/json",
      },
    });
    await appendEvent(world, "run_parallel_resume_parent", {
      type: "StepOutputValidated",
      payload: {
        stepPath: "review[done].score",
        outputRef: completedArtifact.artifactRef,
        outputMode: "object",
      },
    });
    await appendEvent(world, "run_parallel_resume_parent", {
      type: "StepCompleted",
      payload: {
        stepPath: "review[done].score",
        stepId: "score",
        attempt: 1,
        output: completedOutput,
        outputRef: completedArtifact.artifactRef,
        artifactRefs: [completedArtifact.artifactRef],
        metadata: { uses: "tool.call", outputMode: "object" },
      },
    });
    const result = await executeWorkflowVersion({
      world,
      workflowVersion,
      runId: "run_parallel_resume_parent",
      input: {
        ticketId: "TIN-11",
        candidates: [
          { id: "done", score: 1 },
          { id: "todo", score: 2 },
        ],
      },
      tools: registryFor({ score }),
    });

    expect(result.status).toBe("completed");
    expect(result.output).toEqual([
      completedRecord("done", { id: "done", score: 10, root: "TIN-11" }),
      completedRecord("todo", { id: "todo", score: 20, root: "TIN-11" }),
    ]);
    expect(score).toHaveBeenCalledTimes(1);
    expect(score).toHaveBeenCalledWith(
      { id: "todo", score: 2, root: "TIN-11" },
      expect.objectContaining({ branchPath: "review[todo]", hasItem: true }),
    );
    const parent = result.state.steps.review;
    expect(parent?.attempts).toHaveLength(1);
    expect(parent?.attempts[0]?.status).toBe("completed");
    const resumedEvents = await listEvents(world, "run_parallel_resume_parent");
    expect(
      resumedEvents.filter((event) =>
        event.type === "ParallelBranchCompleted" &&
        event.payload.branchPath === "review[done]"
      ),
    ).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          branchPath: "review[done]",
          outputRef: completedArtifact.artifactRef,
          artifactRefs: [completedArtifact.artifactRef],
        }),
      }),
    ]);
    expect(
      resumedEvents.filter((event) =>
        event.type === "ParallelGroupStarted" &&
        event.payload.stepPath === "review"
      ),
    ).toHaveLength(1);
    expect(
      resumedEvents.filter((event) =>
        event.type === "ParallelBranchScheduled" &&
        event.payload.branchPath === "review[done]"
      ),
    ).toHaveLength(1);
  });

  it("rejects resume input that differs from the original run input", async () => {
    const world = await tempWorld();
    const score = vi.fn(() => ({ id: "unused", score: 0 }));
    const workflowVersion = lockedWorkflowVersion(parallelWorkflow("input"), {
      tools: registryFor({ score }),
    });
    await appendEvent(world, "run_parallel_resume_input_mismatch", {
      type: "WorkflowVersionRegistered",
      payload: {
        workflowVersionId: workflowVersion.id,
        workflowVersionHash: workflowVersion.hash,
      },
    });
    await appendEvent(world, "run_parallel_resume_input_mismatch", {
      type: "RunStarted",
      payload: {
        workflowVersionId: workflowVersion.id,
        input: {
          ticketId: "TIN-11",
          candidates: [
            { id: "a", score: 1 },
            { id: "b", score: 2 },
          ],
        },
      },
    });
    await appendEvent(world, "run_parallel_resume_input_mismatch", {
      type: "StepScheduled",
      payload: { stepPath: "review", stepId: "review", uses: "parallel" },
    });
    await appendEvent(world, "run_parallel_resume_input_mismatch", {
      type: "StepAttemptStarted",
      payload: {
        stepPath: "review",
        stepId: "review",
        attempt: 1,
        attemptId: "attempt_1",
      },
    });

    await expect(
      executeWorkflowVersion({
        world,
        workflowVersion,
        runId: "run_parallel_resume_input_mismatch",
        input: {
          ticketId: "TIN-11",
          candidates: [{ id: "a", score: 1 }],
        },
        tools: registryFor({ score }),
      }),
    ).rejects.toThrow("Run input mismatch");
    expect(score).not.toHaveBeenCalled();
  });

  it("hydrates outputRef-only completed branch state while resuming", async () => {
    const world = await tempWorld();
    const score = vi.fn((input: unknown) => {
      const candidate = input as { readonly id: string; readonly score: number; readonly root: string };
      return { id: candidate.id, score: candidate.score * 10, root: candidate.root };
    });
    const workflowVersion = lockedWorkflowVersion(parallelWorkflow("input"), {
      tools: registryFor({ score }),
    });
    const completedOutput = { id: "done", score: 10, root: "TIN-11" };
    const completedArtifact = await writeArtifact(world, {
      runId: "run_parallel_resume_output_ref_only",
      stepPath: "review[done].score",
      name: "output",
      payload: completedOutput,
      contentType: "application/json",
    });
    await appendStartedParallelRun(world, workflowVersion, "run_parallel_resume_output_ref_only");
    await appendEvent(world, "run_parallel_resume_output_ref_only", {
      type: "ParallelBranchScheduled",
      payload: {
        stepPath: "review",
        attempt: 1,
        attemptId: "attempt_1",
        branchPath: "review[done]",
        itemKey: "done",
        branchIndex: 0,
      },
    });
    await appendEvent(world, "run_parallel_resume_output_ref_only", {
      type: "StepScheduled",
      payload: { stepPath: "review[done].score", stepId: "score", uses: "tool.call" },
    });
    await appendEvent(world, "run_parallel_resume_output_ref_only", {
      type: "StepCompleted",
      payload: {
        stepPath: "review[done].score",
        stepId: "score",
        outputRef: completedArtifact.artifactRef,
        artifactRefs: [completedArtifact.artifactRef],
        metadata: { uses: "tool.call", outputMode: "object" },
      },
    });

    const result = await executeWorkflowVersion({
      world,
      workflowVersion,
      runId: "run_parallel_resume_output_ref_only",
      input: {
        ticketId: "TIN-11",
        candidates: [
          { id: "done", score: 1 },
          { id: "todo", score: 2 },
        ],
      },
      tools: registryFor({ score }),
    });

    expect(result.status).toBe("completed");
    expect(result.output).toEqual([
      completedRecord("done", { id: "done", score: 10, root: "TIN-11" }),
      completedRecord("todo", { id: "todo", score: 20, root: "TIN-11" }),
    ]);
    expect(score).toHaveBeenCalledTimes(1);
  });

  it("hydrates outputRef-only completed parent parallel output while finalizing a run", async () => {
    const world = await tempWorld();
    const score = vi.fn(() => {
      throw new Error("score should not be called");
    });
    const workflowVersion = lockedWorkflowVersion(parallelWorkflow("input"), {
      tools: registryFor({ score }),
    });
    const branchOutput = { id: "done", score: 10, root: "TIN-11" };
    const branchArtifact = await writeArtifact(world, {
      runId: "run_parallel_parent_output_ref_only",
      stepPath: "review[done].score",
      name: "output",
      payload: branchOutput,
      contentType: "application/json",
    });
    const parentOutput = [
      {
        itemKey: "done",
        status: "completed",
        output: branchOutput,
        outputRef: branchArtifact.artifactRef,
        artifacts: [branchArtifact.artifactRef],
      },
    ];
    const parentArtifact = await writeArtifact(world, {
      runId: "run_parallel_parent_output_ref_only",
      stepPath: "review",
      name: "output",
      payload: parentOutput,
      contentType: "application/json",
    });
    await appendEvent(world, "run_parallel_parent_output_ref_only", {
      type: "WorkflowVersionRegistered",
      payload: {
        workflowVersionId: workflowVersion.id,
        workflowVersionHash: workflowVersion.hash,
      },
    });
    await appendEvent(world, "run_parallel_parent_output_ref_only", {
      type: "RunStarted",
      payload: { workflowVersionId: workflowVersion.id },
    });
    await appendEvent(world, "run_parallel_parent_output_ref_only", {
      type: "StepScheduled",
      payload: { stepPath: "review", stepId: "review", uses: "parallel" },
    });
    await appendEvent(world, "run_parallel_parent_output_ref_only", {
      type: "StepAttemptStarted",
      payload: { stepPath: "review", stepId: "review", attempt: 1, attemptId: "attempt_1" },
    });
    await appendEvent(world, "run_parallel_parent_output_ref_only", {
      type: "ParallelBranchScheduled",
      payload: {
        stepPath: "review",
        attempt: 1,
        attemptId: "attempt_1",
        branchPath: "review[done]",
        itemKey: "done",
        branchIndex: 0,
      },
    });
    await appendEvent(world, "run_parallel_parent_output_ref_only", {
      type: "StepScheduled",
      payload: { stepPath: "review[done].score", stepId: "score", uses: "tool.call" },
    });
    await appendEvent(world, "run_parallel_parent_output_ref_only", {
      type: "StepCompleted",
      payload: {
        stepPath: "review[done].score",
        stepId: "score",
        output: branchOutput,
        outputRef: branchArtifact.artifactRef,
        artifactRefs: [branchArtifact.artifactRef],
        metadata: { uses: "tool.call", outputMode: "object" },
      },
    });
    await appendEvent(world, "run_parallel_parent_output_ref_only", {
      type: "ParallelBranchCompleted",
      payload: {
        stepPath: "review",
        attempt: 1,
        attemptId: "attempt_1",
        branchPath: "review[done]",
        itemKey: "done",
        branchIndex: 0,
        outputRef: branchArtifact.artifactRef,
        artifactRefs: [branchArtifact.artifactRef],
      },
    });
    await appendEvent(world, "run_parallel_parent_output_ref_only", {
      type: "StepCompleted",
      payload: {
        stepPath: "review",
        stepId: "review",
        attempt: 1,
        outputRef: parentArtifact.artifactRef,
        artifactRefs: [parentArtifact.artifactRef, branchArtifact.artifactRef],
        metadata: { uses: "parallel", outputMode: "array" },
      },
    });

    const result = await executeWorkflowVersion({
      world,
      workflowVersion,
      runId: "run_parallel_parent_output_ref_only",
      input: {
        ticketId: "TIN-11",
        candidates: [{ id: "done", score: 1 }],
      },
      tools: registryFor({ score }),
    });

    expect(result.status).toBe("completed");
    expect(result.output).toEqual(parentOutput);
    expect(score).not.toHaveBeenCalled();
    const events = await listEvents(world, "run_parallel_parent_output_ref_only");
    expect(events.some((event) => event.type === "RunCompleted")).toBe(true);
  });

  it("hydrates outputRef-only completed run output while replaying", async () => {
    const world = await tempWorld();
    const score = vi.fn(() => {
      throw new Error("score should not be called");
    });
    const workflowVersion = lockedWorkflowVersion(parallelWorkflow("input"), {
      tools: registryFor({ score }),
    });
    const branchOutput = { id: "done", score: 10, root: "TIN-11" };
    const branchArtifact = await writeArtifact(world, {
      runId: "run_parallel_completed_run_output_ref_only",
      stepPath: "review[done].score",
      name: "output",
      payload: branchOutput,
      contentType: "application/json",
    });
    const parentOutput = [
      {
        itemKey: "done",
        status: "completed",
        output: branchOutput,
        outputRef: branchArtifact.artifactRef,
        artifacts: [branchArtifact.artifactRef],
      },
    ];
    const parentArtifact = await writeArtifact(world, {
      runId: "run_parallel_completed_run_output_ref_only",
      stepPath: "review",
      name: "output",
      payload: parentOutput,
      contentType: "application/json",
    });
    await appendEvent(world, "run_parallel_completed_run_output_ref_only", {
      type: "WorkflowVersionRegistered",
      payload: {
        workflowVersionId: workflowVersion.id,
        workflowVersionHash: workflowVersion.hash,
      },
    });
    await appendEvent(world, "run_parallel_completed_run_output_ref_only", {
      type: "RunStarted",
      payload: { workflowVersionId: workflowVersion.id },
    });
    await appendEvent(world, "run_parallel_completed_run_output_ref_only", {
      type: "StepScheduled",
      payload: { stepPath: "review", stepId: "review", uses: "parallel" },
    });
    await appendEvent(world, "run_parallel_completed_run_output_ref_only", {
      type: "ParallelBranchScheduled",
      payload: {
        stepPath: "review",
        attempt: 1,
        attemptId: "attempt_1",
        branchPath: "review[done]",
        itemKey: "done",
        branchIndex: 0,
      },
    });
    await appendEvent(world, "run_parallel_completed_run_output_ref_only", {
      type: "StepScheduled",
      payload: { stepPath: "review[done].score", stepId: "score", uses: "tool.call" },
    });
    await appendEvent(world, "run_parallel_completed_run_output_ref_only", {
      type: "StepCompleted",
      payload: {
        stepPath: "review[done].score",
        stepId: "score",
        output: branchOutput,
        outputRef: branchArtifact.artifactRef,
        artifactRefs: [branchArtifact.artifactRef],
        metadata: { uses: "tool.call", outputMode: "object" },
      },
    });
    await appendEvent(world, "run_parallel_completed_run_output_ref_only", {
      type: "ParallelBranchCompleted",
      payload: {
        stepPath: "review",
        attempt: 1,
        attemptId: "attempt_1",
        branchPath: "review[done]",
        itemKey: "done",
        branchIndex: 0,
        outputRef: branchArtifact.artifactRef,
        artifactRefs: [branchArtifact.artifactRef],
      },
    });
    await appendEvent(world, "run_parallel_completed_run_output_ref_only", {
      type: "StepCompleted",
      payload: {
        stepPath: "review",
        stepId: "review",
        attempt: 1,
        output: parentOutput,
        outputRef: parentArtifact.artifactRef,
        artifactRefs: [parentArtifact.artifactRef, branchArtifact.artifactRef],
        metadata: { uses: "parallel", outputMode: "array" },
      },
    });
    await appendEvent(world, "run_parallel_completed_run_output_ref_only", {
      type: "RunCompleted",
      payload: {
        outputRef: parentArtifact.artifactRef,
      },
    });

    const result = await executeWorkflowVersion({
      world,
      workflowVersion,
      runId: "run_parallel_completed_run_output_ref_only",
      input: {
        ticketId: "TIN-11",
        candidates: [{ id: "done", score: 1 }],
      },
      tools: registryFor({ score }),
    });

    expect(result.status).toBe("completed");
    expect(result.output).toEqual(parentOutput);
    expect(score).not.toHaveBeenCalled();
  });

  it("hydrates outputRef-only dependency steps while resuming a multi-step branch", async () => {
    const world = await tempWorld();
    const prepare = vi.fn(() => {
      throw new Error("prepare should not be called");
    });
    const score = vi.fn((input: unknown) => {
      const candidate = input as { readonly id: string; readonly normalized: number; readonly root: string };
      return { id: candidate.id, score: candidate.normalized * 10, root: candidate.root };
    });
    const workflowVersion = lockedWorkflowVersion(multiStepParallelWorkflow(), {
      tools: registryFor({ prepare, score }),
    });
    const preparedOutput = { id: "done", normalized: 2 };
    const prepareArtifact = await writeArtifact(world, {
      runId: "run_parallel_resume_dependency_output_ref_only",
      stepPath: "review[done].prepare",
      name: "output",
      payload: preparedOutput,
      contentType: "application/json",
    });
    await appendStartedParallelRun(
      world,
      workflowVersion,
      "run_parallel_resume_dependency_output_ref_only",
      "all_settled",
    );
    await appendEvent(world, "run_parallel_resume_dependency_output_ref_only", {
      type: "ParallelBranchScheduled",
      payload: {
        stepPath: "review",
        attempt: 1,
        attemptId: "attempt_1",
        branchPath: "review[done]",
        itemKey: "done",
        branchIndex: 0,
      },
    });
    await appendEvent(world, "run_parallel_resume_dependency_output_ref_only", {
      type: "StepScheduled",
      payload: { stepPath: "review[done].prepare", stepId: "prepare", uses: "tool.call" },
    });
    await appendEvent(world, "run_parallel_resume_dependency_output_ref_only", {
      type: "StepCompleted",
      payload: {
        stepPath: "review[done].prepare",
        stepId: "prepare",
        outputRef: prepareArtifact.artifactRef,
        artifactRefs: [prepareArtifact.artifactRef],
        metadata: { uses: "tool.call", outputMode: "object" },
      },
    });

    const result = await executeWorkflowVersion({
      world,
      workflowVersion,
      runId: "run_parallel_resume_dependency_output_ref_only",
      input: {
        ticketId: "TIN-11",
        candidates: [{ id: "done", score: 1 }],
      },
      tools: registryFor({ prepare, score }),
    });

    expect(result.status).toBe("completed");
    expect(result.output).toEqual([
      completedRecord("done", { id: "done", score: 20, root: "TIN-11" }),
    ]);
    expect(prepare).not.toHaveBeenCalled();
    expect(score).toHaveBeenCalledWith(
      { id: "done", normalized: 2, root: "TIN-11" },
      expect.objectContaining({ branchPath: "review[done]" }),
    );
  });

  it("lets branch steps read completed top-level step outputs", async () => {
    const world = await tempWorld();
    const load = vi.fn(() => ({ root: "TIN-11", multiplier: 7 }));
    const score = vi.fn((input: unknown) => {
      const candidate = input as {
        readonly id: string;
        readonly score: number;
        readonly root: string;
        readonly multiplier: number;
      };
      return {
        id: candidate.id,
        score: candidate.score * candidate.multiplier,
        root: candidate.root,
      };
    });

    const result = await executeWorkflowVersion({
      world,
      workflowVersion: lockedWorkflowVersion(topLevelDependencyParallelWorkflow(), {
        tools: registryFor({ load, score }),
      }),
      runId: "run_parallel_top_level_dependency",
      input: {
        ticketId: "TIN-11",
        candidates: [{ id: "a", score: 3 }],
      },
      tools: registryFor({ load, score }),
    });

    expect(result.status).toBe("completed");
    expect(result.output).toEqual([
      completedRecord("a", { id: "a", score: 21, root: "TIN-11" }),
    ]);
    expect(score).toHaveBeenCalledWith(
      { id: "a", score: 3, root: "TIN-11", multiplier: 7 },
      expect.objectContaining({ branchPath: "review[a]" }),
    );
  });

  it("does not expose top-level step outputs to branches unless the parent declares needs", async () => {
    const world = await tempWorld();
    const load = vi.fn(() => ({ root: "TIN-11", multiplier: 7 }));
    const score = vi.fn(() => ({ id: "unused", score: 0, root: "TIN-11" }));
    const finish = vi.fn(() => ({ ok: true }));

    const result = await executeWorkflowVersion({
      world,
      workflowVersion: lockedWorkflowVersion(parentMissingDependencyParallelWorkflow(), {
        tools: registryFor({ finish, load, score }),
      }),
      runId: "run_parallel_undeclared_top_level_dependency",
      input: {
        ticketId: "TIN-11",
        candidates: [{ id: "a", score: 3 }],
      },
      tools: registryFor({ finish, load, score }),
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") {
      throw new Error("Expected undeclared top-level dependency run to fail.");
    }
    expect(result.error).toEqual(
      expect.objectContaining({ message: expect.stringContaining("No runnable LWIR branch step") }),
    );
    expect(load).toHaveBeenCalledTimes(1);
    expect(score).not.toHaveBeenCalled();
    expect(finish).not.toHaveBeenCalled();
  });

  it("resumes an all_settled failed branch from persisted branch failure events", async () => {
    const world = await tempWorld();
    const score = vi.fn((input: unknown) => {
      const candidate = input as { readonly id: string; readonly score: number; readonly root: string };
      return { id: candidate.id, score: candidate.score * 10, root: candidate.root };
    });
    const workflowVersion = lockedWorkflowVersion(
      parallelWorkflow("input", { failureMode: "all_settled" }),
      { tools: registryFor({ score }) },
    );
    const originalError = { name: "Error", message: "original branch failure", retriable: false };
    await appendStartedParallelRun(
      world,
      workflowVersion,
      "run_parallel_resume_failed_branch",
      "all_settled",
    );
    await appendEvent(world, "run_parallel_resume_failed_branch", {
      type: "ParallelBranchScheduled",
      payload: {
        stepPath: "review",
        branchPath: "review[bad]",
        itemKey: "bad",
        branchIndex: 0,
      },
    });
    await appendEvent(world, "run_parallel_resume_failed_branch", {
      type: "StepScheduled",
      payload: { stepPath: "review[bad].score", stepId: "score", uses: "tool.call" },
    });
    await appendEvent(world, "run_parallel_resume_failed_branch", {
      type: "StepAttemptStarted",
      payload: {
        stepPath: "review[bad].score",
        stepId: "score",
        attempt: 1,
        attemptId: "attempt_1",
      },
    });
    await appendEvent(world, "run_parallel_resume_failed_branch", {
      type: "StepFailed",
      payload: {
        stepPath: "review[bad].score",
        stepId: "score",
        attempt: 1,
        attemptId: "attempt_1",
        error: originalError,
      },
    });
    await appendEvent(world, "run_parallel_resume_failed_branch", {
      type: "ParallelBranchFailed",
      payload: {
        stepPath: "review",
        branchPath: "review[bad]",
        itemKey: "bad",
        branchIndex: 0,
        error: originalError,
        artifactRefs: [],
      },
    });

    const result = await executeWorkflowVersion({
      world,
      workflowVersion,
      runId: "run_parallel_resume_failed_branch",
      input: {
        ticketId: "TIN-11",
        candidates: [
          { id: "bad", score: 0 },
          { id: "ok", score: 1 },
        ],
      },
      tools: registryFor({ score }),
    });

    expect(result.status).toBe("completed");
    expect(result.output).toEqual([
      {
        itemKey: "bad",
        status: "failed",
        error: originalError,
        artifacts: [],
      },
      {
        itemKey: "ok",
        status: "completed",
        output: { id: "ok", score: 10, root: "TIN-11" },
        outputRef: expect.stringMatching(/^artifact:\/\//u),
        artifacts: expect.arrayContaining([expect.stringMatching(/^artifact:\/\//u)]),
      },
    ]);
    expect(score).toHaveBeenCalledTimes(1);
    expect(score).toHaveBeenCalledWith(
      { id: "ok", score: 1, root: "TIN-11" },
      expect.objectContaining({ branchPath: "review[ok]" }),
    );
  });

  it("resumes an all_settled failed branch from a persisted StepFailed event", async () => {
    const world = await tempWorld();
    const score = vi.fn((input: unknown) => {
      const candidate = input as { readonly id: string; readonly score: number; readonly root: string };
      return { id: candidate.id, score: candidate.score * 10, root: candidate.root };
    });
    const workflowVersion = lockedWorkflowVersion(
      parallelWorkflow("input", { failureMode: "all_settled" }),
      { tools: registryFor({ score }) },
    );
    const originalError = { name: "Error", message: "step failed before branch event", retriable: false };
    await appendStartedParallelRun(
      world,
      workflowVersion,
      "run_parallel_resume_step_failed_branch",
      "all_settled",
    );
    await appendEvent(world, "run_parallel_resume_step_failed_branch", {
      type: "ParallelBranchScheduled",
      payload: {
        stepPath: "review",
        branchPath: "review[bad]",
        itemKey: "bad",
        branchIndex: 0,
      },
    });
    await appendEvent(world, "run_parallel_resume_step_failed_branch", {
      type: "StepScheduled",
      payload: { stepPath: "review[bad].score", stepId: "score", uses: "tool.call" },
    });
    await appendEvent(world, "run_parallel_resume_step_failed_branch", {
      type: "StepAttemptStarted",
      payload: {
        stepPath: "review[bad].score",
        stepId: "score",
        attempt: 1,
        attemptId: "attempt_1",
      },
    });
    await appendEvent(world, "run_parallel_resume_step_failed_branch", {
      type: "StepFailed",
      payload: {
        stepPath: "review[bad].score",
        stepId: "score",
        attempt: 1,
        attemptId: "attempt_1",
        error: originalError,
      },
    });

    const result = await executeWorkflowVersion({
      world,
      workflowVersion,
      runId: "run_parallel_resume_step_failed_branch",
      input: {
        ticketId: "TIN-11",
        candidates: [
          { id: "bad", score: 0 },
          { id: "ok", score: 1 },
        ],
      },
      tools: registryFor({ score }),
    });

    expect(result.status).toBe("completed");
    expect(result.output).toEqual([
      {
        itemKey: "bad",
        status: "failed",
        error: originalError,
        artifacts: [],
      },
      {
        itemKey: "ok",
        status: "completed",
        output: { id: "ok", score: 10, root: "TIN-11" },
        outputRef: expect.stringMatching(/^artifact:\/\//u),
        artifacts: expect.arrayContaining([expect.stringMatching(/^artifact:\/\//u)]),
      },
    ]);
    const events = await listEvents(world, "run_parallel_resume_step_failed_branch");
    expect(
      events.filter((event) =>
        event.type === "ParallelBranchFailed" &&
        event.payload.branchPath === "review[bad]"
      ),
    ).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({ error: originalError }),
      }),
    ]);
    expect(score).toHaveBeenCalledTimes(1);
  });

  it("fails an all_settled run when replaying a terminal branch cancellation StepFailed", async () => {
    const world = await tempWorld();
    const score = vi.fn((input: unknown) => {
      const candidate = input as { readonly id: string; readonly score: number; readonly root: string };
      return { id: candidate.id, score: candidate.score * 10, root: candidate.root };
    });
    const workflowVersion = lockedWorkflowVersion(
      parallelWorkflow("input", { failureMode: "all_settled", maxConcurrency: 2 }),
      { tools: registryFor({ score }) },
    );
    await appendStartedParallelRun(
      world,
      workflowVersion,
      "run_parallel_terminal_branch_cancel_replay",
      "all_settled",
    );
    await appendEvent(world, "run_parallel_terminal_branch_cancel_replay", {
      type: "ParallelBranchScheduled",
      payload: {
        stepPath: "review",
        branchPath: "review[bad]",
        itemKey: "bad",
        branchIndex: 0,
      },
    });
    await appendEvent(world, "run_parallel_terminal_branch_cancel_replay", {
      type: "StepScheduled",
      payload: { stepPath: "review[bad].score", stepId: "score", uses: "tool.call" },
    });
    await appendEvent(world, "run_parallel_terminal_branch_cancel_replay", {
      type: "StepAttemptStarted",
      payload: {
        stepPath: "review[bad].score",
        stepId: "score",
        attempt: 1,
        attemptId: "attempt_1",
      },
    });
    await appendEvent(world, "run_parallel_terminal_branch_cancel_replay", {
      type: "StepFailed",
      payload: {
        stepPath: "review[bad].score",
        stepId: "score",
        attempt: 1,
        attemptId: "attempt_1",
        error: {
          name: "AbortError",
          message: "Run was cancelled.",
          causeCode: "cancelled",
          retriable: false,
        },
      },
    });

    const result = await executeWorkflowVersion({
      world,
      workflowVersion,
      runId: "run_parallel_terminal_branch_cancel_replay",
      input: {
        ticketId: "TIN-11",
        candidates: [
          { id: "bad", score: 0 },
          { id: "ok", score: 1 },
        ],
      },
      tools: registryFor({ score }),
    });

    expect(result.status).toBe("failed");
    expect(score).not.toHaveBeenCalled();
    const events = await listEvents(world, "run_parallel_terminal_branch_cancel_replay");
    expect(events.filter((event) => event.type === "RunFailed")).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          error: expect.objectContaining({
            name: "AbortError",
            causeCode: "cancelled",
            retriable: false,
          }),
        }),
      }),
    ]);
    expect(events.some((event) => event.type === "ParallelGroupCompleted")).toBe(false);
    expect(
      events.some((event) =>
        event.type === "ParallelBranchScheduled" &&
        event.payload.branchPath === "review[ok]"
      ),
    ).toBe(false);
  });

  it("fails an all_settled run when replaying a terminal ParallelBranchFailed event", async () => {
    const world = await tempWorld();
    const score = vi.fn((input: unknown) => {
      const candidate = input as { readonly id: string; readonly score: number; readonly root: string };
      return { id: candidate.id, score: candidate.score * 10, root: candidate.root };
    });
    const workflowVersion = lockedWorkflowVersion(
      parallelWorkflow("input", { failureMode: "all_settled", maxConcurrency: 1 }),
      { tools: registryFor({ score }) },
    );
    const cancellationError = {
      name: "AbortError",
      message: "Run was cancelled.",
      causeCode: "cancelled",
      retriable: false,
    };
    await appendStartedParallelRun(
      world,
      workflowVersion,
      "run_parallel_terminal_branch_failed_replay",
      "all_settled",
    );
    await appendEvent(world, "run_parallel_terminal_branch_failed_replay", {
      type: "ParallelBranchScheduled",
      payload: {
        stepPath: "review",
        branchPath: "review[bad]",
        itemKey: "bad",
        branchIndex: 0,
      },
    });
    await appendEvent(world, "run_parallel_terminal_branch_failed_replay", {
      type: "StepScheduled",
      payload: { stepPath: "review[bad].score", stepId: "score", uses: "tool.call" },
    });
    await appendEvent(world, "run_parallel_terminal_branch_failed_replay", {
      type: "StepAttemptStarted",
      payload: {
        stepPath: "review[bad].score",
        stepId: "score",
        attempt: 1,
        attemptId: "attempt_1",
      },
    });
    await appendEvent(world, "run_parallel_terminal_branch_failed_replay", {
      type: "StepFailed",
      payload: {
        stepPath: "review[bad].score",
        stepId: "score",
        attempt: 1,
        attemptId: "attempt_1",
        error: cancellationError,
      },
    });
    await appendEvent(world, "run_parallel_terminal_branch_failed_replay", {
      type: "ParallelBranchFailed",
      payload: {
        stepPath: "review",
        attempt: 1,
        attemptId: "attempt_1",
        branchPath: "review[bad]",
        itemKey: "bad",
        branchIndex: 0,
        error: cancellationError,
        artifactRefs: [],
      },
    });

    const result = await executeWorkflowVersion({
      world,
      workflowVersion,
      runId: "run_parallel_terminal_branch_failed_replay",
      input: {
        ticketId: "TIN-11",
        candidates: [
          { id: "bad", score: 0 },
          { id: "ok", score: 1 },
        ],
      },
      tools: registryFor({ score }),
    });

    expect(result.status).toBe("failed");
    expect(score).not.toHaveBeenCalled();
    const events = await listEvents(world, "run_parallel_terminal_branch_failed_replay");
    expect(events.filter((event) => event.type === "RunFailed")).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          error: expect.objectContaining({
            name: "AbortError",
            causeCode: "cancelled",
            retriable: false,
          }),
        }),
      }),
    ]);
    expect(events.some((event) => event.type === "ParallelGroupCompleted")).toBe(false);
    expect(events.some((event) => event.type === "RunCompleted")).toBe(false);
  });

  it("does not hydrate failed branch events from an earlier parent retry attempt", async () => {
    const world = await tempWorld();
    const score = vi.fn((input: unknown) => {
      const candidate = input as { readonly id: string; readonly score: number; readonly root: string };
      return { id: candidate.id, score: candidate.score, root: candidate.root };
    });
    const workflowVersion = lockedWorkflowVersion(
      parallelWorkflow("input", { failureMode: "fail_fast", maxConcurrency: 1 }),
      { tools: registryFor({ score }) },
    );
    const firstAttemptError = { name: "Error", message: "first parent attempt failed", retriable: false };
    await appendStartedParallelRun(
      world,
      workflowVersion,
      "run_parallel_retry_attempt_scope",
      "fail_fast",
    );
    await appendEvent(world, "run_parallel_retry_attempt_scope", {
      type: "ParallelBranchScheduled",
      payload: {
        stepPath: "review",
        attempt: 1,
        branchPath: "review[retry]",
        itemKey: "retry",
        branchIndex: 0,
      },
    });
    await appendEvent(world, "run_parallel_retry_attempt_scope", {
      type: "StepScheduled",
      payload: { stepPath: "review[retry].score", stepId: "score", uses: "tool.call" },
    });
    await appendEvent(world, "run_parallel_retry_attempt_scope", {
      type: "StepAttemptStarted",
      payload: {
        stepPath: "review[retry].score",
        stepId: "score",
        attempt: 1,
        attemptId: "attempt_1",
      },
    });
    await appendEvent(world, "run_parallel_retry_attempt_scope", {
      type: "StepFailed",
      payload: {
        stepPath: "review[retry].score",
        stepId: "score",
        attempt: 1,
        attemptId: "attempt_1",
        error: firstAttemptError,
      },
    });
    await appendEvent(world, "run_parallel_retry_attempt_scope", {
      type: "ParallelBranchFailed",
      payload: {
        stepPath: "review",
        attempt: 1,
        branchPath: "review[retry]",
        itemKey: "retry",
        branchIndex: 0,
        error: firstAttemptError,
        artifactRefs: [],
      },
    });
    await appendEvent(world, "run_parallel_retry_attempt_scope", {
      type: "ParallelGroupFailed",
      payload: {
        stepPath: "review",
        stepId: "review",
        attempt: 1,
        error: firstAttemptError,
      },
    });
    await appendEvent(world, "run_parallel_retry_attempt_scope", {
      type: "StepFailed",
      payload: {
        stepPath: "review",
        stepId: "review",
        attempt: 1,
        attemptId: "attempt_1",
        error: firstAttemptError,
      },
    });

    const result = await executeWorkflowVersion({
      world,
      workflowVersion,
      runId: "run_parallel_retry_attempt_scope",
      input: {
        ticketId: "TIN-11",
        candidates: [{ id: "retry", score: 1 }],
      },
      tools: registryFor({ score }),
      maxAttempts: 2,
    });

    expect(result.status).toBe("completed");
    expect(result.output).toEqual([
      completedRecord("retry", { id: "retry", score: 1, root: "TIN-11" }),
    ]);
    expect(score).toHaveBeenCalledTimes(1);
    const events = await listEvents(world, "run_parallel_retry_attempt_scope");
    expect(events.filter((event) => event.type === "ParallelBranchFailed")).toHaveLength(1);
    expect(events.filter((event) => event.type === "ParallelBranchCompleted")).toHaveLength(1);
  });

  it("isolates branch step state across parent retry attempts", async () => {
    const world = await tempWorld();
    let attempts = 0;
    const score = vi.fn((input: unknown) => {
      attempts += 1;
      const candidate = input as { readonly id: string; readonly score: number; readonly root: string };
      if (attempts === 1) {
        throw new Error("first parent attempt failed");
      }
      return { id: candidate.id, score: candidate.score, root: candidate.root };
    });

    const result = await executeWorkflowVersion({
      world,
      workflowVersion: lockedWorkflowVersion(withParallelRetry(parallelWorkflow("input"), 2), {
        tools: registryFor({ score }),
      }),
      runId: "run_parallel_parent_retry_scoped_paths",
      input: {
        ticketId: "TIN-11",
        candidates: [{ id: "retry", score: 1 }],
      },
      tools: registryFor({ score }),
    });

    expect(result.status).toBe("completed");
    expect(result.output).toEqual([
      completedRecord("retry", { id: "retry", score: 1, root: "TIN-11" }),
    ]);
    expect(score).toHaveBeenCalledTimes(2);
    const events = await listEvents(world, "run_parallel_parent_retry_scoped_paths");
    expect(
      events
        .filter((event) => event.type === "StepScheduled")
        .map((event) => event.payload.stepPath),
    ).toEqual([
      "review",
      "review[retry].score",
      "review@attempt_2[retry].score",
    ]);
  });

  it("rejects parent retry completion artifacts from another attempt branch path", async () => {
    const world = await tempWorld();
    const score = vi.fn(() => ({ id: "unused", score: 0 }));
    const workflowVersion = lockedWorkflowVersion(withParallelRetry(parallelWorkflow("input"), 2), {
      tools: registryFor({ score }),
    });
    const firstAttemptBranchArtifact = await writeArtifact(world, {
      runId: "run_parallel_parent_retry_stale_artifact",
      stepPath: "review[retry].score",
      name: "output",
      payload: { id: "retry", score: 1, root: "TIN-11" },
      contentType: "application/json",
    });
    const parentOutput = [
      {
        itemKey: "retry",
        status: "completed",
        output: { id: "retry", score: 1, root: "TIN-11" },
        outputRef: firstAttemptBranchArtifact.artifactRef,
        artifacts: [firstAttemptBranchArtifact.artifactRef],
      },
    ];
    const parentArtifact = await writeArtifact(world, {
      runId: "run_parallel_parent_retry_stale_artifact",
      stepPath: "review",
      name: "output",
      payload: parentOutput,
      contentType: "application/json",
    });
    await appendEvent(world, "run_parallel_parent_retry_stale_artifact", {
      type: "WorkflowVersionRegistered",
      payload: {
        workflowVersionId: workflowVersion.id,
        workflowVersionHash: workflowVersion.hash,
      },
    });
    await appendEvent(world, "run_parallel_parent_retry_stale_artifact", {
      type: "RunStarted",
      payload: { workflowVersionId: workflowVersion.id },
    });
    await appendEvent(world, "run_parallel_parent_retry_stale_artifact", {
      type: "StepScheduled",
      payload: { stepPath: "review", stepId: "review", uses: "parallel" },
    });
    await appendEvent(world, "run_parallel_parent_retry_stale_artifact", {
      type: "StepAttemptStarted",
      payload: { stepPath: "review", stepId: "review", attempt: 1, attemptId: "attempt_1" },
    });
    await appendEvent(world, "run_parallel_parent_retry_stale_artifact", {
      type: "StepFailed",
      payload: {
        stepPath: "review",
        stepId: "review",
        attempt: 1,
        attemptId: "attempt_1",
        error: { name: "Error", message: "first attempt failed", retriable: true },
      },
    });
    await appendEvent(world, "run_parallel_parent_retry_stale_artifact", {
      type: "StepAttemptStarted",
      payload: { stepPath: "review", stepId: "review", attempt: 2, attemptId: "attempt_2" },
    });
    await appendEvent(world, "run_parallel_parent_retry_stale_artifact", {
      type: "StepCompleted",
      payload: {
        stepPath: "review",
        stepId: "review",
        attempt: 2,
        output: parentOutput,
        outputRef: parentArtifact.artifactRef,
        artifactRefs: [parentArtifact.artifactRef, firstAttemptBranchArtifact.artifactRef],
        metadata: { uses: "parallel", outputMode: "array" },
      },
    });
    await appendEvent(world, "run_parallel_parent_retry_stale_artifact", {
      type: "RunCompleted",
      payload: {
        output: parentOutput,
        outputRef: parentArtifact.artifactRef,
      },
    });

    await expect(
      executeWorkflowVersion({
        world,
        workflowVersion,
        runId: "run_parallel_parent_retry_stale_artifact",
        input: {
          ticketId: "TIN-11",
          candidates: [{ id: "retry", score: 1 }],
        },
        tools: registryFor({ score }),
      }),
    ).rejects.toThrow("does not belong to step 'review'");
  });

  it("rejects unscheduled descendant artifacts on completed parallel parents", async () => {
    const world = await tempWorld();
    const score = vi.fn(() => ({ id: "unused", score: 0 }));
    const workflowVersion = lockedWorkflowVersion(parallelWorkflow("input"), {
      tools: registryFor({ score }),
    });
    const parentOutput = [
      {
        itemKey: "ok",
        status: "completed",
        output: { id: "ok", score: 1, root: "TIN-11" },
        outputRef: "artifact://art_unused",
        artifacts: [],
      },
    ];
    const parentArtifact = await writeArtifact(world, {
      runId: "run_parallel_unscheduled_descendant_artifact",
      stepPath: "review",
      name: "output",
      payload: parentOutput,
      contentType: "application/json",
    });
    const ghostArtifact = await writeArtifact(world, {
      runId: "run_parallel_unscheduled_descendant_artifact",
      stepPath: "review[ghost].score",
      name: "output",
      payload: { id: "ghost" },
      contentType: "application/json",
    });
    await appendStartedParallelRun(world, workflowVersion, "run_parallel_unscheduled_descendant_artifact");
    await appendEvent(world, "run_parallel_unscheduled_descendant_artifact", {
      type: "ParallelBranchScheduled",
      payload: {
        stepPath: "review",
        attempt: 1,
        attemptId: "attempt_1",
        branchPath: "review[ok]",
        itemKey: "ok",
        branchIndex: 0,
      },
    });
    await appendEvent(world, "run_parallel_unscheduled_descendant_artifact", {
      type: "StepCompleted",
      payload: {
        stepPath: "review",
        stepId: "review",
        attempt: 1,
        output: parentOutput,
        outputRef: parentArtifact.artifactRef,
        artifactRefs: [parentArtifact.artifactRef, ghostArtifact.artifactRef],
        metadata: { uses: "parallel", outputMode: "array" },
      },
    });
    await appendEvent(world, "run_parallel_unscheduled_descendant_artifact", {
      type: "RunCompleted",
      payload: {
        output: parentOutput,
        outputRef: parentArtifact.artifactRef,
      },
    });

    await expect(
      executeWorkflowVersion({
        world,
        workflowVersion,
        runId: "run_parallel_unscheduled_descendant_artifact",
        input: {
          ticketId: "TIN-11",
          candidates: [{ id: "ok", score: 1 }],
        },
        tools: registryFor({ score }),
      }),
    ).rejects.toThrow("does not belong to step 'review'");
  });

  it("rejects ghost terminal branch events as descendant artifact authority", async () => {
    const world = await tempWorld();
    const score = vi.fn(() => ({ id: "unused", score: 0 }));
    const workflowVersion = lockedWorkflowVersion(parallelWorkflow("input"), {
      tools: registryFor({ score }),
    });
    const parentOutput = [
      {
        itemKey: "ok",
        status: "completed",
        output: { id: "ok", score: 1, root: "TIN-11" },
        outputRef: "artifact://art_unused",
        artifacts: [],
      },
    ];
    const parentArtifact = await writeArtifact(world, {
      runId: "run_parallel_ghost_terminal_artifact",
      stepPath: "review",
      name: "output",
      payload: parentOutput,
      contentType: "application/json",
    });
    const ghostArtifact = await writeArtifact(world, {
      runId: "run_parallel_ghost_terminal_artifact",
      stepPath: "review[ghost].score",
      name: "output",
      payload: { id: "ghost" },
      contentType: "application/json",
    });
    await appendStartedParallelRun(world, workflowVersion, "run_parallel_ghost_terminal_artifact");
    await appendEvent(world, "run_parallel_ghost_terminal_artifact", {
      type: "ParallelBranchCompleted",
      payload: {
        stepPath: "review",
        attempt: 1,
        attemptId: "attempt_1",
        branchPath: "review[ghost]",
        itemKey: "ghost",
        branchIndex: 99,
        outputRef: ghostArtifact.artifactRef,
        artifactRefs: [ghostArtifact.artifactRef],
      },
    });
    await appendEvent(world, "run_parallel_ghost_terminal_artifact", {
      type: "StepCompleted",
      payload: {
        stepPath: "review",
        stepId: "review",
        attempt: 1,
        output: parentOutput,
        outputRef: parentArtifact.artifactRef,
        artifactRefs: [parentArtifact.artifactRef, ghostArtifact.artifactRef],
        metadata: { uses: "parallel", outputMode: "array" },
      },
    });
    await appendEvent(world, "run_parallel_ghost_terminal_artifact", {
      type: "RunCompleted",
      payload: {
        output: parentOutput,
        outputRef: parentArtifact.artifactRef,
      },
    });

    await expect(
      executeWorkflowVersion({
        world,
        workflowVersion,
        runId: "run_parallel_ghost_terminal_artifact",
        input: {
          ticketId: "TIN-11",
          candidates: [{ id: "ok", score: 1 }],
        },
        tools: registryFor({ score }),
      }),
    ).rejects.toThrow("without a matching ParallelBranchScheduled");
  });

  it("rejects unscheduled descendant branch state during completed-run replay", async () => {
    const world = await tempWorld();
    const score = vi.fn(() => ({ id: "unused", score: 0 }));
    const workflowVersion = lockedWorkflowVersion(parallelWorkflow("input"), {
      tools: registryFor({ score }),
    });
    const parentOutput: readonly unknown[] = [];
    const parentArtifact = await writeArtifact(world, {
      runId: "run_parallel_completed_unscheduled_descendant",
      stepPath: "review",
      name: "output",
      payload: parentOutput,
      contentType: "application/json",
    });
    const ghostArtifact = await writeArtifact(world, {
      runId: "run_parallel_completed_unscheduled_descendant",
      stepPath: "review[ghost].score",
      name: "output",
      payload: { id: "ghost", score: 10, root: "TIN-11" },
      contentType: "application/json",
    });
    await appendStartedParallelRun(world, workflowVersion, "run_parallel_completed_unscheduled_descendant");
    await appendEvent(world, "run_parallel_completed_unscheduled_descendant", {
      type: "StepScheduled",
      payload: { stepPath: "review[ghost].score", stepId: "score", uses: "tool.call" },
    });
    await appendEvent(world, "run_parallel_completed_unscheduled_descendant", {
      type: "StepCompleted",
      payload: {
        stepPath: "review[ghost].score",
        stepId: "score",
        output: { id: "ghost", score: 10, root: "TIN-11" },
        outputRef: ghostArtifact.artifactRef,
        artifactRefs: [ghostArtifact.artifactRef],
        metadata: { uses: "tool.call", outputMode: "object" },
      },
    });
    await appendEvent(world, "run_parallel_completed_unscheduled_descendant", {
      type: "StepCompleted",
      payload: {
        stepPath: "review",
        stepId: "review",
        attempt: 1,
        output: parentOutput,
        outputRef: parentArtifact.artifactRef,
        artifactRefs: [parentArtifact.artifactRef],
        metadata: { uses: "parallel", outputMode: "array" },
      },
    });
    await appendEvent(world, "run_parallel_completed_unscheduled_descendant", {
      type: "RunCompleted",
      payload: {
        output: parentOutput,
        outputRef: parentArtifact.artifactRef,
      },
    });

    await expect(
      executeWorkflowVersion({
        world,
        workflowVersion,
        runId: "run_parallel_completed_unscheduled_descendant",
        input: {
          ticketId: "TIN-11",
          candidates: [{ id: "ok", score: 1 }],
        },
        tools: registryFor({ score }),
      }),
    ).rejects.toThrow("without a matching ParallelBranchScheduled");
    expect(score).not.toHaveBeenCalled();
  });

  it("rejects unscheduled completed branch terminals while resuming a parent attempt", async () => {
    const world = await tempWorld();
    const score = vi.fn(() => {
      throw new Error("score should not be called");
    });
    const workflowVersion = lockedWorkflowVersion(parallelWorkflow("input"), {
      tools: registryFor({ score }),
    });
    const branchOutput = { id: "ghost", score: 10, root: "TIN-11" };
    const branchArtifact = await writeArtifact(world, {
      runId: "run_parallel_unscheduled_terminal_resume",
      stepPath: "review[ghost].score",
      name: "output",
      payload: branchOutput,
      contentType: "application/json",
    });
    await appendStartedParallelRun(world, workflowVersion, "run_parallel_unscheduled_terminal_resume");
    await appendEvent(world, "run_parallel_unscheduled_terminal_resume", {
      type: "StepScheduled",
      payload: { stepPath: "review[ghost].score", stepId: "score", uses: "tool.call" },
    });
    await appendEvent(world, "run_parallel_unscheduled_terminal_resume", {
      type: "StepCompleted",
      payload: {
        stepPath: "review[ghost].score",
        stepId: "score",
        attempt: 1,
        output: branchOutput,
        outputRef: branchArtifact.artifactRef,
        artifactRefs: [branchArtifact.artifactRef],
        metadata: { uses: "tool.call", outputMode: "object" },
      },
    });
    await appendEvent(world, "run_parallel_unscheduled_terminal_resume", {
      type: "ParallelBranchCompleted",
      payload: {
        stepPath: "review",
        attempt: 1,
        attemptId: "attempt_1",
        branchPath: "review[ghost]",
        itemKey: "ghost",
        branchIndex: 0,
        outputRef: branchArtifact.artifactRef,
        artifactRefs: [branchArtifact.artifactRef],
      },
    });

    await expect(
      executeWorkflowVersion({
        world,
        workflowVersion,
        runId: "run_parallel_unscheduled_terminal_resume",
        input: {
          ticketId: "TIN-11",
          candidates: [{ id: "ghost", score: 1 }],
        },
        tools: registryFor({ score }),
      }),
    ).rejects.toThrow("without a matching ParallelBranchScheduled");
    expect(score).not.toHaveBeenCalled();
  });

  it("rejects unscheduled failed branch terminals without descendant state", async () => {
    const world = await tempWorld();
    const score = vi.fn(() => {
      throw new Error("score should not be called");
    });
    const workflowVersion = lockedWorkflowVersion(
      parallelWorkflow("input", { failureMode: "all_settled" }),
      { tools: registryFor({ score }) },
    );
    const branchError = { name: "Error", message: "ghost branch failed", retriable: false };
    await appendStartedParallelRun(
      world,
      workflowVersion,
      "run_parallel_unscheduled_failed_terminal",
      "all_settled",
    );
    await appendEvent(world, "run_parallel_unscheduled_failed_terminal", {
      type: "ParallelBranchFailed",
      payload: {
        stepPath: "review",
        attempt: 1,
        attemptId: "attempt_1",
        branchPath: "review[ghost]",
        itemKey: "ghost",
        branchIndex: 0,
        error: branchError,
        artifactRefs: [],
      },
    });

    await expect(
      executeWorkflowVersion({
        world,
        workflowVersion,
        runId: "run_parallel_unscheduled_failed_terminal",
        input: {
          ticketId: "TIN-11",
          candidates: [{ id: "ghost", score: 1 }],
        },
        tools: registryFor({ score }),
      }),
    ).rejects.toThrow("without a matching ParallelBranchScheduled");
    expect(score).not.toHaveBeenCalled();
  });

  it("rejects unscheduled descendant branch state before resume repair can schedule it", async () => {
    const world = await tempWorld();
    const score = vi.fn(() => {
      throw new Error("score should not be called");
    });
    const workflowVersion = lockedWorkflowVersion(parallelWorkflow("input"), {
      tools: registryFor({ score }),
    });
    const branchOutput = { id: "ghost", score: 10, root: "TIN-11" };
    const branchArtifact = await writeArtifact(world, {
      runId: "run_parallel_unscheduled_descendant_resume",
      stepPath: "review[ghost].score",
      name: "output",
      payload: branchOutput,
      contentType: "application/json",
    });
    await appendStartedParallelRun(world, workflowVersion, "run_parallel_unscheduled_descendant_resume");
    await appendEvent(world, "run_parallel_unscheduled_descendant_resume", {
      type: "StepScheduled",
      payload: { stepPath: "review[ghost].score", stepId: "score", uses: "tool.call" },
    });
    await appendEvent(world, "run_parallel_unscheduled_descendant_resume", {
      type: "StepCompleted",
      payload: {
        stepPath: "review[ghost].score",
        stepId: "score",
        attempt: 1,
        output: branchOutput,
        outputRef: branchArtifact.artifactRef,
        artifactRefs: [branchArtifact.artifactRef],
        metadata: { uses: "tool.call", outputMode: "object" },
      },
    });

    await expect(
      executeWorkflowVersion({
        world,
        workflowVersion,
        runId: "run_parallel_unscheduled_descendant_resume",
        input: {
          ticketId: "TIN-11",
          candidates: [{ id: "ghost", score: 1 }],
        },
        tools: registryFor({ score }),
      }),
    ).rejects.toThrow("without a matching ParallelBranchScheduled");
    expect(score).not.toHaveBeenCalled();
  });

  it("derives resumed failed branch artifacts from completed branch steps", async () => {
    const world = await tempWorld();
    const score = vi.fn(() => {
      throw new Error("score should not be called");
    });
    const workflowVersion = lockedWorkflowVersion(
      parallelWorkflow("input", { failureMode: "all_settled" }),
      { tools: registryFor({ score }) },
    );
    const staleArtifact = await writeArtifact(world, {
      runId: "run_parallel_failed_event_stale_artifact",
      stepPath: "review[bad].score",
      name: "scratch",
      payload: { stale: true },
      contentType: "application/json",
    });
    const branchError = { name: "Error", message: "branch failed", retriable: false };
    await appendStartedParallelRun(
      world,
      workflowVersion,
      "run_parallel_failed_event_stale_artifact",
      "all_settled",
    );
    await appendEvent(world, "run_parallel_failed_event_stale_artifact", {
      type: "ParallelBranchScheduled",
      payload: {
        stepPath: "review",
        attempt: 1,
        attemptId: "attempt_1",
        branchPath: "review[bad]",
        itemKey: "bad",
        branchIndex: 0,
      },
    });
    await appendEvent(world, "run_parallel_failed_event_stale_artifact", {
      type: "StepScheduled",
      payload: { stepPath: "review[bad].score", stepId: "score", uses: "tool.call" },
    });
    await appendEvent(world, "run_parallel_failed_event_stale_artifact", {
      type: "StepFailed",
      payload: {
        stepPath: "review[bad].score",
        stepId: "score",
        attempt: 1,
        attemptId: "attempt_1",
        error: branchError,
      },
    });
    await appendEvent(world, "run_parallel_failed_event_stale_artifact", {
      type: "ParallelBranchFailed",
      payload: {
        stepPath: "review",
        attempt: 1,
        attemptId: "attempt_1",
        branchPath: "review[bad]",
        itemKey: "bad",
        branchIndex: 0,
        error: branchError,
        artifactRefs: [staleArtifact.artifactRef],
      },
    });

    const result = await executeWorkflowVersion({
      world,
      workflowVersion,
      runId: "run_parallel_failed_event_stale_artifact",
      input: {
        ticketId: "TIN-11",
        candidates: [{ id: "bad", score: 0 }],
      },
      tools: registryFor({ score }),
    });

    expect(result.status).toBe("completed");
    expect(result.output).toEqual([
      {
        itemKey: "bad",
        status: "failed",
        error: branchError,
        artifacts: [],
      },
    ]);
  });

  it("excludes artifacts from abandoned branch attempts when a later attempt completes", async () => {
    const world = await tempWorld();
    const score = vi.fn((input: unknown) => {
      const candidate = input as { readonly id: string; readonly score: number; readonly root: string };
      return { id: candidate.id, score: candidate.score * 10, root: candidate.root };
    });
    const workflowVersion = lockedWorkflowVersion(parallelWorkflow("input"), {
      tools: registryFor({ score }),
    });
    const staleArtifact = await writeArtifact(world, {
      runId: "run_parallel_stale_branch_artifact",
      stepPath: "review[ok].score",
      name: "scratch",
      payload: { stale: true },
      contentType: "application/json",
    });
    await appendStartedParallelRun(world, workflowVersion, "run_parallel_stale_branch_artifact");
    await appendEvent(world, "run_parallel_stale_branch_artifact", {
      type: "ParallelBranchScheduled",
      payload: {
        stepPath: "review",
        attempt: 1,
        attemptId: "attempt_1",
        branchPath: "review[ok]",
        itemKey: "ok",
        branchIndex: 0,
      },
    });
    await appendEvent(world, "run_parallel_stale_branch_artifact", {
      type: "StepScheduled",
      payload: { stepPath: "review[ok].score", stepId: "score", uses: "tool.call" },
    });
    await appendEvent(world, "run_parallel_stale_branch_artifact", {
      type: "StepAttemptStarted",
      payload: {
        stepPath: "review[ok].score",
        stepId: "score",
        attempt: 1,
        attemptId: "attempt_1",
      },
    });
    await appendEvent(world, "run_parallel_stale_branch_artifact", {
      type: "ArtifactCreated",
      payload: {
        stepPath: "review[ok].score",
        artifactRef: staleArtifact.artifactRef,
        name: "scratch",
        contentType: "application/json",
      },
    });

    const result = await executeWorkflowVersion({
      world,
      workflowVersion,
      runId: "run_parallel_stale_branch_artifact",
      input: {
        ticketId: "TIN-11",
        candidates: [{ id: "ok", score: 1 }],
      },
      tools: registryFor({ score }),
      maxAttempts: 2,
    });

    expect(result.status).toBe("completed");
    const output = result.output as readonly { readonly artifacts: readonly string[] }[];
    expect(output[0]?.artifacts).not.toContain(staleArtifact.artifactRef);
    const parent = result.state.steps.review;
    expect(parent?.artifactRefs).not.toContain(staleArtifact.artifactRef);
  });

  it("rejects descendant artifacts on non-parallel steps even when metadata claims parallel", async () => {
    const world = await tempWorld();
    const load = vi.fn(() => ({ ok: true }));
    const workflowVersion = lockedWorkflowVersion(nonParallelToolWorkflow(), {
      tools: registryFor({ load }),
    });
    const output = { ok: true };
    const outputArtifact = await writeArtifact(world, {
      runId: "run_parallel_metadata_artifact_spoof",
      stepPath: "load",
      name: "output",
      payload: output,
      contentType: "application/json",
    });
    const descendantArtifact = await writeArtifact(world, {
      runId: "run_parallel_metadata_artifact_spoof",
      stepPath: "load[spoof].score",
      name: "output",
      payload: { ok: false },
      contentType: "application/json",
    });
    await appendEvent(world, "run_parallel_metadata_artifact_spoof", {
      type: "WorkflowVersionRegistered",
      payload: {
        workflowVersionId: workflowVersion.id,
        workflowVersionHash: workflowVersion.hash,
      },
    });
    await appendEvent(world, "run_parallel_metadata_artifact_spoof", {
      type: "RunStarted",
      payload: { workflowVersionId: workflowVersion.id },
    });
    await appendEvent(world, "run_parallel_metadata_artifact_spoof", {
      type: "StepScheduled",
      payload: { stepPath: "load", stepId: "load", uses: "tool.call" },
    });
    await appendEvent(world, "run_parallel_metadata_artifact_spoof", {
      type: "StepCompleted",
      payload: {
        stepPath: "load",
        stepId: "load",
        attempt: 1,
        output,
        outputRef: outputArtifact.artifactRef,
        artifactRefs: [outputArtifact.artifactRef, descendantArtifact.artifactRef],
        metadata: { uses: "parallel", outputMode: "object" },
      },
    });
    await appendEvent(world, "run_parallel_metadata_artifact_spoof", {
      type: "RunCompleted",
      payload: {
        output,
        outputRef: outputArtifact.artifactRef,
      },
    });

    await expect(
      executeWorkflowVersion({
        world,
        workflowVersion,
        runId: "run_parallel_metadata_artifact_spoof",
        input: {},
        tools: registryFor({ load }),
      }),
    ).rejects.toThrow("does not belong to step 'load'");
  });

  it("retries a retriable branch StepFailed when resuming the same parent attempt", async () => {
    const world = await tempWorld();
    const score = vi.fn((input: unknown) => {
      const candidate = input as { readonly id: string; readonly score: number; readonly root: string };
      return { id: candidate.id, score: candidate.score * 10, root: candidate.root };
    });
    const workflowVersion = lockedWorkflowVersion(parallelWorkflow("input"), {
      tools: registryFor({ score }),
    });
    const retriableError = { name: "Error", message: "transient branch failure", retriable: true };
    await appendStartedParallelRun(world, workflowVersion, "run_parallel_resume_retriable_child");
    await appendEvent(world, "run_parallel_resume_retriable_child", {
      type: "ParallelBranchScheduled",
      payload: {
        stepPath: "review",
        attempt: 1,
        branchPath: "review[retry]",
        itemKey: "retry",
        branchIndex: 0,
      },
    });
    await appendEvent(world, "run_parallel_resume_retriable_child", {
      type: "StepScheduled",
      payload: { stepPath: "review[retry].score", stepId: "score", uses: "tool.call" },
    });
    await appendEvent(world, "run_parallel_resume_retriable_child", {
      type: "StepAttemptStarted",
      payload: {
        stepPath: "review[retry].score",
        stepId: "score",
        attempt: 1,
        attemptId: "attempt_1",
      },
    });
    await appendEvent(world, "run_parallel_resume_retriable_child", {
      type: "StepFailed",
      payload: {
        stepPath: "review[retry].score",
        stepId: "score",
        attempt: 1,
        attemptId: "attempt_1",
        error: retriableError,
      },
    });

    const result = await executeWorkflowVersion({
      world,
      workflowVersion,
      runId: "run_parallel_resume_retriable_child",
      input: {
        ticketId: "TIN-11",
        candidates: [{ id: "retry", score: 1 }],
      },
      tools: registryFor({ score }),
      maxAttempts: 2,
    });

    expect(result.status).toBe("completed");
    expect(result.output).toEqual([
      completedRecord("retry", { id: "retry", score: 10, root: "TIN-11" }),
    ]);
    expect(score).toHaveBeenCalledTimes(1);
    const child = result.state.steps["review[retry].score"];
    expect(child?.attempts).toHaveLength(2);
    expect(child?.status).toBe("completed");
  });

  it("rejects concurrent execution of the same run in one local process", async () => {
    const world = await tempWorld();
    const release = deferred<void>();
    let started = false;
    const score = vi.fn(async (input: unknown) => {
      started = true;
      await release.promise;
      const candidate = input as { readonly id: string; readonly score: number; readonly root: string };
      return { id: candidate.id, score: candidate.score, root: candidate.root };
    });
    const workflowVersion = lockedWorkflowVersion(parallelWorkflow("input"), {
      tools: registryFor({ score }),
    });

    const first = executeWorkflowVersion({
      world,
      workflowVersion,
      runId: "run_parallel_concurrent_execution",
      input: {
        ticketId: "TIN-11",
        candidates: [{ id: "a", score: 1 }],
      },
      tools: registryFor({ score }),
    });
    await waitUntil(() => started);

    await expect(
      executeWorkflowVersion({
        world,
        workflowVersion,
        runId: "run_parallel_concurrent_execution",
        input: {
          ticketId: "TIN-11",
          candidates: [{ id: "a", score: 1 }],
        },
        tools: registryFor({ score }),
      }),
    ).rejects.toThrow("already executing");

    release.resolve();
    await expect(first).resolves.toEqual(expect.objectContaining({ status: "completed" }));
  });

  it("uses canonical dataDir paths for same-process run fencing", async () => {
    const world = await tempWorld();
    const equivalentWorld = localWorld({ dataDir: `${world.dataDir}/.` });
    const release = deferred<void>();
    let started = false;
    const score = vi.fn(async (input: unknown) => {
      started = true;
      await release.promise;
      const candidate = input as { readonly id: string; readonly score: number; readonly root: string };
      return { id: candidate.id, score: candidate.score, root: candidate.root };
    });
    const workflowVersion = lockedWorkflowVersion(parallelWorkflow("input"), {
      tools: registryFor({ score }),
    });

    const first = executeWorkflowVersion({
      world,
      workflowVersion,
      runId: "run_parallel_canonical_fence",
      input: {
        ticketId: "TIN-11",
        candidates: [{ id: "a", score: 1 }],
      },
      tools: registryFor({ score }),
    });
    await waitUntil(() => started);

    await expect(
      executeWorkflowVersion({
        world: equivalentWorld,
        workflowVersion,
        runId: "run_parallel_canonical_fence",
        input: {
          ticketId: "TIN-11",
          candidates: [{ id: "a", score: 1 }],
        },
        tools: registryFor({ score }),
      }),
    ).rejects.toThrow("already executing");

    release.resolve();
    await expect(first).resolves.toEqual(expect.objectContaining({ status: "completed" }));
  });

  it("uses canonical symlink parent paths for same-process run fencing before storage exists", async () => {
    const parent = await mkdtemp(join(tmpdir(), "little-workflow-parent-"));
    tempDirs.push(parent);
    const link = `${parent}-link`;
    tempDirs.push(link);
    await symlink(parent, link);
    const world = localWorld({ dataDir: join(parent, "world") });
    const equivalentWorld = localWorld({ dataDir: join(link, "world") });
    const release = deferred<void>();
    let started = false;
    const score = vi.fn(async (input: unknown) => {
      started = true;
      await release.promise;
      const candidate = input as { readonly id: string; readonly score: number; readonly root: string };
      return { id: candidate.id, score: candidate.score, root: candidate.root };
    });
    const workflowVersion = lockedWorkflowVersion(parallelWorkflow("input"), {
      tools: registryFor({ score }),
    });

    const first = executeWorkflowVersion({
      world,
      workflowVersion,
      runId: "run_parallel_symlink_fence",
      input: {
        ticketId: "TIN-11",
        candidates: [{ id: "a", score: 1 }],
      },
      tools: registryFor({ score }),
    });
    await waitUntil(() => started);

    await expect(
      executeWorkflowVersion({
        world: equivalentWorld,
        workflowVersion,
        runId: "run_parallel_symlink_fence",
        input: {
          ticketId: "TIN-11",
          candidates: [{ id: "a", score: 1 }],
        },
        tools: registryFor({ score }),
      }),
    ).rejects.toThrow("already executing");

    release.resolve();
    await expect(first).resolves.toEqual(expect.objectContaining({ status: "completed" }));
  });

  it("reports artifacts from every successful branch step in all_settled fan-in", async () => {
    const world = await tempWorld();
    const prepare = vi.fn((input: unknown) => {
      const candidate = input as { readonly id: string; readonly score: number };
      return { id: candidate.id, normalized: candidate.score + 1 };
    });
    const score = vi.fn((input: unknown) => {
      const candidate = input as { readonly id: string; readonly normalized: number; readonly root: string };
      return { id: candidate.id, score: candidate.normalized * 10, root: candidate.root };
    });

    const result = await executeWorkflowVersion({
      world,
      workflowVersion: lockedWorkflowVersion(multiStepParallelWorkflow(), {
        tools: registryFor({ prepare, score }),
      }),
      runId: "run_parallel_all_branch_artifacts",
      input: {
        ticketId: "TIN-11",
        candidates: [{ id: "ok", score: 1 }],
      },
      tools: registryFor({ prepare, score }),
    });

    expect(result.status).toBe("completed");
    const prepareRef = result.state.steps["review[ok].prepare"]?.outputRef;
    const scoreRef = result.state.steps["review[ok].score"]?.outputRef;
    expect(prepareRef).toMatch(/^artifact:\/\//u);
    expect(scoreRef).toMatch(/^artifact:\/\//u);
    expect(result.output).toEqual([
      {
        itemKey: "ok",
        status: "completed",
        output: { id: "ok", score: 20, root: "TIN-11" },
        outputRef: scoreRef,
        artifacts: expect.arrayContaining([prepareRef, scoreRef]),
      },
    ]);
  });

  it("resumes a branch with an abandoned running attempt", async () => {
    const world = await tempWorld();
    const releaseOk = deferred<void>();
    let okStarted = false;
    const score = vi.fn(async (input: unknown) => {
      const candidate = input as { readonly id: string; readonly score: number; readonly root: string };
      if (candidate.id === "ok") {
        okStarted = true;
        await releaseOk.promise;
      }
      return { id: candidate.id, score: candidate.score, root: candidate.root };
    });
    const workflowVersion = lockedWorkflowVersion(parallelWorkflow("input"), {
      tools: registryFor({ score }),
    });
    await appendStartedParallelRun(world, workflowVersion, "run_parallel_fatal_drain");
    await appendEvent(world, "run_parallel_fatal_drain", {
      type: "ParallelBranchScheduled",
      payload: {
        stepPath: "review",
        branchPath: "review[bad]",
        itemKey: "bad",
        branchIndex: 0,
      },
    });
    await appendEvent(world, "run_parallel_fatal_drain", {
      type: "StepScheduled",
      payload: { stepPath: "review[bad].score", stepId: "score", uses: "tool.call" },
    });
    await appendEvent(world, "run_parallel_fatal_drain", {
      type: "StepAttemptStarted",
      payload: {
        stepPath: "review[bad].score",
        stepId: "score",
        attempt: 1,
        attemptId: "attempt_1",
      },
    });

    const runPromise = executeWorkflowVersion({
      world,
      workflowVersion,
      runId: "run_parallel_fatal_drain",
      input: {
        ticketId: "TIN-11",
        candidates: [
          { id: "bad", score: 0 },
          { id: "ok", score: 1 },
        ],
      },
      tools: registryFor({ score }),
    });

    await waitUntil(() => okStarted);
    releaseOk.resolve();
    await expect(runPromise).resolves.toEqual(
      expect.objectContaining({
        status: "completed",
        output: [
          completedRecord("bad", { id: "bad", score: 0, root: "TIN-11" }),
          completedRecord("ok", { id: "ok", score: 1, root: "TIN-11" }),
        ],
      }),
    );
    expect(score).toHaveBeenCalledTimes(2);
  });

  it("only marks the abandoned branch attempt as resuming when it retries", async () => {
    const world = await tempWorld();
    const resumingFlags: unknown[] = [];
    const score = vi.fn((input: unknown, context) => {
      resumingFlags.push(context.resumingAttempt);
      if (resumingFlags.length === 1) {
        throw new Error("resumed abandoned attempt failed again");
      }
      if (context.resumingAttempt === true) {
        throw new Error("fresh retry must not be marked as resuming");
      }
      const candidate = input as { readonly id: string; readonly score: number; readonly root: string };
      return { id: candidate.id, score: candidate.score * 10, root: candidate.root };
    });
    const workflowVersion = lockedWorkflowVersion(parallelWorkflow("input"), {
      tools: registryFor({ score }),
    });
    await appendStartedParallelRun(world, workflowVersion, "run_parallel_resuming_flag_retry");
    await appendEvent(world, "run_parallel_resuming_flag_retry", {
      type: "ParallelBranchScheduled",
      payload: {
        stepPath: "review",
        attempt: 1,
        attemptId: "attempt_1",
        branchPath: "review[retry]",
        itemKey: "retry",
        branchIndex: 0,
      },
    });
    await appendEvent(world, "run_parallel_resuming_flag_retry", {
      type: "StepScheduled",
      payload: { stepPath: "review[retry].score", stepId: "score", uses: "tool.call" },
    });
    await appendEvent(world, "run_parallel_resuming_flag_retry", {
      type: "StepAttemptStarted",
      payload: {
        stepPath: "review[retry].score",
        stepId: "score",
        attempt: 1,
        attemptId: "attempt_1",
      },
    });

    const result = await executeWorkflowVersion({
      world,
      workflowVersion,
      runId: "run_parallel_resuming_flag_retry",
      input: {
        ticketId: "TIN-11",
        candidates: [{ id: "retry", score: 1 }],
      },
      tools: registryFor({ score }),
      maxAttempts: 2,
    });

    expect(result.status).toBe("completed");
    expect(result.output).toEqual([
      completedRecord("retry", { id: "retry", score: 10, root: "TIN-11" }),
    ]);
    expect(resumingFlags).toEqual([true, undefined]);
  });

  it("does not duplicate completed group terminal events while repairing parent completion", async () => {
    const world = await tempWorld();
    const score = vi.fn(() => {
      throw new Error("score should not be called");
    });
    const workflowVersion = lockedWorkflowVersion(parallelWorkflow("input"), {
      tools: registryFor({ score }),
    });
    const branchOutput = { id: "done", score: 10, root: "TIN-11" };
    const branchArtifact = await writeArtifact(world, {
      runId: "run_parallel_resume_group_completed",
      stepPath: "review[done].score",
      name: "output",
      payload: branchOutput,
      contentType: "application/json",
    });
    await appendStartedParallelRun(world, workflowVersion, "run_parallel_resume_group_completed");
    await appendEvent(world, "run_parallel_resume_group_completed", {
      type: "ParallelBranchScheduled",
      payload: {
        stepPath: "review",
        attempt: 1,
        attemptId: "attempt_1",
        branchPath: "review[done]",
        itemKey: "done",
        branchIndex: 0,
      },
    });
    await appendEvent(world, "run_parallel_resume_group_completed", {
      type: "StepScheduled",
      payload: { stepPath: "review[done].score", stepId: "score", uses: "tool.call" },
    });
    await appendEvent(world, "run_parallel_resume_group_completed", {
      type: "StepCompleted",
      payload: {
        stepPath: "review[done].score",
        stepId: "score",
        output: branchOutput,
        outputRef: branchArtifact.artifactRef,
        artifactRefs: [branchArtifact.artifactRef],
        metadata: { uses: "tool.call", outputMode: "object" },
      },
    });
    await appendEvent(world, "run_parallel_resume_group_completed", {
      type: "ParallelBranchCompleted",
      payload: {
        stepPath: "review",
        attempt: 1,
        attemptId: "attempt_1",
        branchPath: "review[done]",
        itemKey: "done",
        branchIndex: 0,
        outputRef: branchArtifact.artifactRef,
        artifactRefs: [branchArtifact.artifactRef],
      },
    });
    await appendEvent(world, "run_parallel_resume_group_completed", {
      type: "ParallelGroupCompleted",
      payload: {
        stepPath: "review",
        stepId: "review",
        attempt: 1,
        attemptId: "attempt_1",
        branchCount: 1,
        fanInOrder: "input",
      },
    });

    const result = await executeWorkflowVersion({
      world,
      workflowVersion,
      runId: "run_parallel_resume_group_completed",
      input: {
        ticketId: "TIN-11",
        candidates: [{ id: "done", score: 1 }],
      },
      tools: registryFor({ score }),
    });

    expect(result.status).toBe("completed");
    expect(result.output).toEqual([completedRecord("done", branchOutput)]);
    expect(score).not.toHaveBeenCalled();
    const events = await listEvents(world, "run_parallel_resume_group_completed");
    expect(events.filter((event) => event.type === "ParallelGroupCompleted")).toHaveLength(1);
  });

  it("does not duplicate failed group terminal events while repairing parent failure", async () => {
    const world = await tempWorld();
    const score = vi.fn(() => {
      throw new Error("score should not be called");
    });
    const workflowVersion = lockedWorkflowVersion(parallelWorkflow("input"), {
      tools: registryFor({ score }),
    });
    const branchError = { name: "Error", message: "branch failed", retriable: false };
    await appendStartedParallelRun(world, workflowVersion, "run_parallel_resume_group_failed");
    await appendEvent(world, "run_parallel_resume_group_failed", {
      type: "ParallelBranchScheduled",
      payload: {
        stepPath: "review",
        attempt: 1,
        attemptId: "attempt_1",
        branchPath: "review[bad]",
        itemKey: "bad",
        branchIndex: 0,
      },
    });
    await appendEvent(world, "run_parallel_resume_group_failed", {
      type: "StepScheduled",
      payload: { stepPath: "review[bad].score", stepId: "score", uses: "tool.call" },
    });
    await appendEvent(world, "run_parallel_resume_group_failed", {
      type: "StepFailed",
      payload: {
        stepPath: "review[bad].score",
        stepId: "score",
        attempt: 1,
        attemptId: "attempt_1",
        error: branchError,
      },
    });
    await appendEvent(world, "run_parallel_resume_group_failed", {
      type: "ParallelBranchFailed",
      payload: {
        stepPath: "review",
        attempt: 1,
        attemptId: "attempt_1",
        branchPath: "review[bad]",
        itemKey: "bad",
        branchIndex: 0,
        error: branchError,
        artifactRefs: [],
      },
    });
    await appendEvent(world, "run_parallel_resume_group_failed", {
      type: "ParallelGroupFailed",
      payload: {
        stepPath: "review",
        stepId: "review",
        attempt: 1,
        attemptId: "attempt_1",
        error: branchError,
      },
    });

    const result = await executeWorkflowVersion({
      world,
      workflowVersion,
      runId: "run_parallel_resume_group_failed",
      input: {
        ticketId: "TIN-11",
        candidates: [{ id: "bad", score: 1 }],
      },
      tools: registryFor({ score }),
    });

    expect(result.status).toBe("failed");
    expect(score).not.toHaveBeenCalled();
    const events = await listEvents(world, "run_parallel_resume_group_failed");
    expect(events.filter((event) => event.type === "ParallelGroupFailed")).toHaveLength(1);
  });

  it("passes a null branch item as default branch step input", async () => {
    const world = await tempWorld();
    const inspect = vi.fn((input: unknown) => ({ value: input }));

    const result = await executeWorkflowVersion({
      world,
      workflowVersion: lockedWorkflowVersion(defaultInputParallelWorkflow(), {
        tools: registryFor({ inspect }),
      }),
      runId: "run_parallel_null_item",
      input: {
        ticketId: "TIN-11",
        candidates: [null],
      },
      tools: registryFor({ inspect }),
    });

    expect(result.status).toBe("completed");
    expect(result.output).toEqual([completedRecord(sha256Digest(null), { value: null })]);
    expect(inspect).toHaveBeenCalledWith(
      null,
      expect.objectContaining({ hasItem: true, input: null, item: null }),
    );
  });

  it("rejects step ids that can collide with generated branch paths", async () => {
    const world = await tempWorld();
    const score = vi.fn(() => ({ id: "unused", score: 0 }));
    const unsafe = parallelWorkflow("input");

    const result = await executeWorkflowVersion({
      world,
      workflowVersion: lockedWorkflowVersion({
        ...unsafe,
        steps: [
          ...unsafe.steps,
          {
            id: "review[a].score",
            uses: "tool.call",
            with: { tool: "score" },
            output: { mode: "object", schema: { type: "object" } },
          },
        ],
      }, { tools: registryFor({ score }) }),
      runId: "run_parallel_path_collision",
      input: {
        ticketId: "TIN-11",
        candidates: [{ id: "a", score: 1 }],
      },
      tools: registryFor({ score }),
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") {
      throw new Error("Expected unsafe step id run to fail.");
    }
    expect(result.error).toEqual(
      expect.objectContaining({ message: expect.stringContaining("reserved path delimiter") }),
    );
    expect(score).not.toHaveBeenCalled();
  });

  it("rejects forged locked workflows with nested parallel steps before live execution", async () => {
    const world = await tempWorld();
    const inspect = vi.fn(() => ({ value: "unused" }));
    const workflowVersion = lockedWorkflowVersion(nestedParallelWorkflow(), {
      tools: registryFor({ inspect }),
    });

    await expect(
      executeWorkflowVersion({
        world,
        workflowVersion,
        runId: "run_nested_parallel_live",
        input: {
          ticketId: "TIN-11",
          candidates: [{ id: "outer", children: [{ id: "inner" }] }],
        },
        tools: registryFor({ inspect }),
      }),
    ).rejects.toThrow("Nested parallel steps are not supported");
    expect(inspect).not.toHaveBeenCalled();
  });

  it("rejects forged locked workflows with nested parallel steps before completed-run replay", async () => {
    const world = await tempWorld();
    const inspect = vi.fn(() => ({ value: "unused" }));
    const workflowVersion = lockedWorkflowVersion(nestedParallelWorkflow(), {
      tools: registryFor({ inspect }),
    });
    const output: readonly unknown[] = [];
    const outputArtifact = await writeArtifact(world, {
      runId: "run_nested_parallel_completed",
      stepPath: "review",
      name: "output",
      payload: output,
      contentType: "application/json",
    });
    await appendEvent(world, "run_nested_parallel_completed", {
      type: "WorkflowVersionRegistered",
      payload: {
        workflowVersionId: workflowVersion.id,
        workflowVersionHash: workflowVersion.hash,
      },
    });
    await appendEvent(world, "run_nested_parallel_completed", {
      type: "RunStarted",
      payload: { workflowVersionId: workflowVersion.id },
    });
    await appendEvent(world, "run_nested_parallel_completed", {
      type: "StepScheduled",
      payload: { stepPath: "review", stepId: "review", uses: "parallel" },
    });
    await appendEvent(world, "run_nested_parallel_completed", {
      type: "StepCompleted",
      payload: {
        stepPath: "review",
        stepId: "review",
        attempt: 1,
        output,
        outputRef: outputArtifact.artifactRef,
        artifactRefs: [outputArtifact.artifactRef],
        metadata: { uses: "parallel", outputMode: "array" },
      },
    });
    await appendEvent(world, "run_nested_parallel_completed", {
      type: "RunCompleted",
      payload: {
        output,
        outputRef: outputArtifact.artifactRef,
      },
    });

    await expect(
      executeWorkflowVersion({
        world,
        workflowVersion,
        runId: "run_nested_parallel_completed",
        input: {
          ticketId: "TIN-11",
          candidates: [{ id: "outer", children: [{ id: "inner" }] }],
        },
        tools: registryFor({ inspect }),
      }),
    ).rejects.toThrow("Nested parallel steps are not supported");
    expect(inspect).not.toHaveBeenCalled();
  });

  it("rejects completed-run replay for step ids that collide with branch paths", async () => {
    const world = await tempWorld();
    const score = vi.fn(() => ({ id: "unused", score: 0 }));
    const unsafeWorkflow = unsafeStepPathWorkflow();
    const workflowVersion = lockedWorkflowVersion(unsafeWorkflow, {
      tools: registryFor({ score }),
    });
    const output = { id: "a", score: 10, root: "TIN-11" };
    const outputArtifact = await writeArtifact(world, {
      runId: "run_parallel_completed_path_collision",
      stepPath: "review[a].score",
      name: "output",
      payload: output,
      contentType: "application/json",
    });
    await appendEvent(world, "run_parallel_completed_path_collision", {
      type: "WorkflowVersionRegistered",
      payload: {
        workflowVersionId: workflowVersion.id,
        workflowVersionHash: workflowVersion.hash,
      },
    });
    await appendEvent(world, "run_parallel_completed_path_collision", {
      type: "RunStarted",
      payload: { workflowVersionId: workflowVersion.id },
    });
    await appendEvent(world, "run_parallel_completed_path_collision", {
      type: "StepScheduled",
      payload: { stepPath: "review[a].score", stepId: "review[a].score", uses: "tool.call" },
    });
    await appendEvent(world, "run_parallel_completed_path_collision", {
      type: "StepCompleted",
      payload: {
        stepPath: "review[a].score",
        stepId: "review[a].score",
        output,
        outputRef: outputArtifact.artifactRef,
        artifactRefs: [outputArtifact.artifactRef],
        metadata: { uses: "tool.call", outputMode: "object" },
      },
    });
    await appendEvent(world, "run_parallel_completed_path_collision", {
      type: "RunCompleted",
      payload: {
        output,
        outputRef: outputArtifact.artifactRef,
      },
    });

    await expect(
      executeWorkflowVersion({
        world,
        workflowVersion,
        runId: "run_parallel_completed_path_collision",
        input: {
          ticketId: "TIN-11",
          candidates: [{ id: "a", score: 1 }],
        },
        tools: registryFor({ score }),
      }),
    ).rejects.toThrow("reserved path delimiter");
    expect(score).not.toHaveBeenCalled();
  });

  it("rejects completed-run replay when scheduled branches do not match workflow input", async () => {
    const world = await tempWorld();
    const score = vi.fn(() => ({ id: "unused", score: 0 }));
    const workflowVersion = lockedWorkflowVersion(parallelWorkflow("input"), {
      tools: registryFor({ score }),
    });
    const branchOutput = { id: "ghost", score: 10, root: "TIN-11" };
    const branchArtifact = await writeArtifact(world, {
      runId: "run_parallel_completed_scheduled_ghost",
      stepPath: "review[ghost].score",
      name: "output",
      payload: branchOutput,
      contentType: "application/json",
    });
    const parentOutput = [completedRecordValue("ghost", branchOutput, branchArtifact.artifactRef)];
    const parentArtifact = await writeArtifact(world, {
      runId: "run_parallel_completed_scheduled_ghost",
      stepPath: "review",
      name: "output",
      payload: parentOutput,
      contentType: "application/json",
    });
    await appendStartedParallelRun(world, workflowVersion, "run_parallel_completed_scheduled_ghost");
    await appendEvent(world, "run_parallel_completed_scheduled_ghost", {
      type: "ParallelBranchScheduled",
      payload: {
        stepPath: "review",
        attempt: 1,
        attemptId: "attempt_1",
        branchPath: "review[ghost]",
        itemKey: "ghost",
        branchIndex: 0,
      },
    });
    await appendEvent(world, "run_parallel_completed_scheduled_ghost", {
      type: "StepScheduled",
      payload: { stepPath: "review[ghost].score", stepId: "score", uses: "tool.call" },
    });
    await appendEvent(world, "run_parallel_completed_scheduled_ghost", {
      type: "StepCompleted",
      payload: {
        stepPath: "review[ghost].score",
        stepId: "score",
        output: branchOutput,
        outputRef: branchArtifact.artifactRef,
        artifactRefs: [branchArtifact.artifactRef],
        metadata: { uses: "tool.call", outputMode: "object" },
      },
    });
    await appendEvent(world, "run_parallel_completed_scheduled_ghost", {
      type: "ParallelBranchCompleted",
      payload: {
        stepPath: "review",
        attempt: 1,
        attemptId: "attempt_1",
        branchPath: "review[ghost]",
        itemKey: "ghost",
        branchIndex: 0,
        outputRef: branchArtifact.artifactRef,
        artifactRefs: [branchArtifact.artifactRef],
      },
    });
    await appendEvent(world, "run_parallel_completed_scheduled_ghost", {
      type: "ParallelGroupCompleted",
      payload: {
        stepPath: "review",
        stepId: "review",
        attempt: 1,
        attemptId: "attempt_1",
        branchCount: 1,
        fanInOrder: "input",
      },
    });
    await appendEvent(world, "run_parallel_completed_scheduled_ghost", {
      type: "StepCompleted",
      payload: {
        stepPath: "review",
        stepId: "review",
        attempt: 1,
        output: parentOutput,
        outputRef: parentArtifact.artifactRef,
        artifactRefs: [parentArtifact.artifactRef, branchArtifact.artifactRef],
        metadata: { uses: "parallel", outputMode: "array" },
      },
    });
    await appendEvent(world, "run_parallel_completed_scheduled_ghost", {
      type: "RunCompleted",
      payload: {
        output: parentOutput,
        outputRef: parentArtifact.artifactRef,
      },
    });

    await expect(
      executeWorkflowVersion({
        world,
        workflowVersion,
        runId: "run_parallel_completed_scheduled_ghost",
        input: {
          ticketId: "TIN-11",
          candidates: [{ id: "real", score: 1 }],
        },
        tools: registryFor({ score }),
      }),
    ).rejects.toThrow("does not match expected branch path");
    expect(score).not.toHaveBeenCalled();
  });

  it("rejects completed-run replay when duplicate branch schedules disagree", async () => {
    const world = await tempWorld();
    const score = vi.fn(() => ({ id: "unused", score: 0 }));
    const workflowVersion = lockedWorkflowVersion(parallelWorkflow("input"), {
      tools: registryFor({ score }),
    });
    const branchOutput = { id: "real", score: 10, root: "TIN-11" };
    const branchArtifact = await writeArtifact(world, {
      runId: "run_parallel_completed_duplicate_schedule",
      stepPath: "review[real].score",
      name: "output",
      payload: branchOutput,
      contentType: "application/json",
    });
    const parentOutput = [completedRecordValue("real", branchOutput, branchArtifact.artifactRef)];
    const parentArtifact = await writeArtifact(world, {
      runId: "run_parallel_completed_duplicate_schedule",
      stepPath: "review",
      name: "output",
      payload: parentOutput,
      contentType: "application/json",
    });
    await appendStartedParallelRun(world, workflowVersion, "run_parallel_completed_duplicate_schedule");
    await appendEvent(world, "run_parallel_completed_duplicate_schedule", {
      type: "ParallelBranchScheduled",
      payload: {
        stepPath: "review",
        attempt: 1,
        attemptId: "attempt_1",
        branchPath: "review[real]",
        itemKey: "real",
        branchIndex: 0,
      },
    });
    await appendEvent(world, "run_parallel_completed_duplicate_schedule", {
      type: "ParallelBranchScheduled",
      payload: {
        stepPath: "review",
        attempt: 1,
        attemptId: "attempt_1",
        branchPath: "review[real]",
        itemKey: "real",
        branchIndex: 1,
      },
    });
    await appendEvent(world, "run_parallel_completed_duplicate_schedule", {
      type: "StepScheduled",
      payload: { stepPath: "review[real].score", stepId: "score", uses: "tool.call" },
    });
    await appendEvent(world, "run_parallel_completed_duplicate_schedule", {
      type: "StepCompleted",
      payload: {
        stepPath: "review[real].score",
        stepId: "score",
        output: branchOutput,
        outputRef: branchArtifact.artifactRef,
        artifactRefs: [branchArtifact.artifactRef],
        metadata: { uses: "tool.call", outputMode: "object" },
      },
    });
    await appendEvent(world, "run_parallel_completed_duplicate_schedule", {
      type: "ParallelBranchCompleted",
      payload: {
        stepPath: "review",
        attempt: 1,
        attemptId: "attempt_1",
        branchPath: "review[real]",
        itemKey: "real",
        branchIndex: 0,
        outputRef: branchArtifact.artifactRef,
        artifactRefs: [branchArtifact.artifactRef],
      },
    });
    await appendEvent(world, "run_parallel_completed_duplicate_schedule", {
      type: "ParallelGroupCompleted",
      payload: {
        stepPath: "review",
        stepId: "review",
        attempt: 1,
        attemptId: "attempt_1",
        branchCount: 1,
        fanInOrder: "input",
      },
    });
    await appendEvent(world, "run_parallel_completed_duplicate_schedule", {
      type: "StepCompleted",
      payload: {
        stepPath: "review",
        stepId: "review",
        attempt: 1,
        output: parentOutput,
        outputRef: parentArtifact.artifactRef,
        artifactRefs: [parentArtifact.artifactRef, branchArtifact.artifactRef],
        metadata: { uses: "parallel", outputMode: "array" },
      },
    });
    await appendEvent(world, "run_parallel_completed_duplicate_schedule", {
      type: "RunCompleted",
      payload: {
        output: parentOutput,
        outputRef: parentArtifact.artifactRef,
      },
    });

    await expect(
      executeWorkflowVersion({
        world,
        workflowVersion,
        runId: "run_parallel_completed_duplicate_schedule",
        input: {
          ticketId: "TIN-11",
          candidates: [{ id: "real", score: 1 }],
        },
        tools: registryFor({ score }),
      }),
    ).rejects.toThrow("Conflicting ParallelBranchScheduled");
    expect(score).not.toHaveBeenCalled();
  });

  it("rejects stale completed parallel parents before resuming downstream steps", async () => {
    const world = await tempWorld();
    const finish = vi.fn(() => ({ ok: true }));
    const workflowVersion = lockedWorkflowVersion(parallelThenFinishWorkflow(), {
      tools: registryFor({ finish, score: () => ({ id: "unused", score: 0 }) }),
    });
    const branchOutput = { id: "ghost", score: 10, root: "TIN-11" };
    const branchArtifact = await writeArtifact(world, {
      runId: "run_parallel_resume_stale_parent",
      stepPath: "review[ghost].score",
      name: "output",
      payload: branchOutput,
      contentType: "application/json",
    });
    const parentOutput = [completedRecordValue("ghost", branchOutput, branchArtifact.artifactRef)];
    const parentArtifact = await writeArtifact(world, {
      runId: "run_parallel_resume_stale_parent",
      stepPath: "review",
      name: "output",
      payload: parentOutput,
      contentType: "application/json",
    });
    await appendStartedParallelRun(world, workflowVersion, "run_parallel_resume_stale_parent");
    await appendEvent(world, "run_parallel_resume_stale_parent", {
      type: "ParallelBranchScheduled",
      payload: {
        stepPath: "review",
        attempt: 1,
        attemptId: "attempt_1",
        branchPath: "review[ghost]",
        itemKey: "ghost",
        branchIndex: 0,
      },
    });
    await appendEvent(world, "run_parallel_resume_stale_parent", {
      type: "StepScheduled",
      payload: { stepPath: "review[ghost].score", stepId: "score", uses: "tool.call" },
    });
    await appendEvent(world, "run_parallel_resume_stale_parent", {
      type: "StepCompleted",
      payload: {
        stepPath: "review[ghost].score",
        stepId: "score",
        output: branchOutput,
        outputRef: branchArtifact.artifactRef,
        artifactRefs: [branchArtifact.artifactRef],
        metadata: { uses: "tool.call", outputMode: "object" },
      },
    });
    await appendEvent(world, "run_parallel_resume_stale_parent", {
      type: "ParallelBranchCompleted",
      payload: {
        stepPath: "review",
        attempt: 1,
        attemptId: "attempt_1",
        branchPath: "review[ghost]",
        itemKey: "ghost",
        branchIndex: 0,
        outputRef: branchArtifact.artifactRef,
        artifactRefs: [branchArtifact.artifactRef],
      },
    });
    await appendEvent(world, "run_parallel_resume_stale_parent", {
      type: "ParallelGroupCompleted",
      payload: {
        stepPath: "review",
        stepId: "review",
        attempt: 1,
        attemptId: "attempt_1",
        branchCount: 1,
        fanInOrder: "input",
      },
    });
    await appendEvent(world, "run_parallel_resume_stale_parent", {
      type: "StepCompleted",
      payload: {
        stepPath: "review",
        stepId: "review",
        attempt: 1,
        output: parentOutput,
        outputRef: parentArtifact.artifactRef,
        artifactRefs: [parentArtifact.artifactRef, branchArtifact.artifactRef],
        metadata: { uses: "parallel", outputMode: "array" },
      },
    });

    await expect(
      executeWorkflowVersion({
        world,
        workflowVersion,
        runId: "run_parallel_resume_stale_parent",
        input: {
          ticketId: "TIN-11",
          candidates: [{ id: "real", score: 1 }],
        },
        tools: registryFor({
          finish,
          score: () => ({ id: "unused", score: 0 }),
        }),
      }),
    ).rejects.toThrow("does not match expected branch path");
    expect(finish).not.toHaveBeenCalled();
  });
});

describe("branch final output with decision-driven termination (Layer A §2.7)", () => {
  it("uses the most recent non-decision step output when a decision routes to 'end'", async () => {
    const world = await tempWorld();
    // Per branch: worker (maxVisits:5) → review (maxVisits:5) → route (decision, maxVisits:5)
    // route: cases: [{ when: "{{ steps.review.lastOutput.passed }}", to: "end" }], default: "worker"
    // review returns passed=false for first visit, passed=true for second visit.
    // Parallel has 2 items ("a", "b"). Expected fan-in: each entry's output is the
    // most-recently-committed non-decision step's output — which is review's last output
    // ({ passed: true }), NOT the decision step's output ({ chosen: "end" }).
    const workerCallCounts: Record<string, number> = {};
    const reviewCallCounts: Record<string, number> = {};
    const workerTool = vi.fn((input: unknown) => {
      const item = input as { readonly id: string };
      workerCallCounts[item.id] = (workerCallCounts[item.id] ?? 0) + 1;
      return { workerId: item.id, visitCount: workerCallCounts[item.id] };
    });
    const reviewTool = vi.fn((input: unknown) => {
      const item = input as { readonly id: string };
      reviewCallCounts[item.id] = (reviewCallCounts[item.id] ?? 0) + 1;
      // Pass on the second review visit.
      return { passed: (reviewCallCounts[item.id] ?? 0) >= 2, reviewId: item.id };
    });
    const lwir: LwirWorkflow = {
      apiVersion: "littleworkflow.dev/v0.1",
      kind: "Workflow",
      metadata: { name: "parallel-branch-decision-end-output" },
      input: {
        schema: {
          type: "object",
          required: ["items"],
          properties: { items: { type: "array" } },
        },
      },
      output: { schema: { type: "array" } },
      permissions: { tools: ["worker", "review"] },
      steps: [
        {
          id: "batch",
          uses: "parallel",
          with: {
            items: "{{ input.items }}",
            cardinality: { kind: "matches_items" },
            itemKey: "{{ item.id }}",
            maxBranches: 3,
            maxConcurrency: 3,
            failureMode: "all_settled",
            fanIn: { order: "input", output: "array" },
          },
          steps: [
            {
              id: "worker",
              uses: "tool.call",
              with: { tool: "worker" },
              maxVisits: 5,
              input: { id: "{{ item.id }}" },
              output: { mode: "object", schema: { type: "object" } },
            },
            {
              id: "review",
              uses: "tool.call",
              needs: ["worker"],
              with: { tool: "review" },
              maxVisits: 5,
              input: { id: "{{ item.id }}" },
              output: { mode: "object", schema: { type: "object" } },
            },
            {
              id: "route",
              uses: "decision",
              needs: ["review"],
              maxVisits: 5,
              with: {
                cases: [{ when: "{{ steps.review.lastOutput.passed }}", to: "end" }],
                default: "worker",
              },
            },
          ],
          output: { mode: "array", schema: { type: "array" } },
        },
      ],
    };
    const registry = registryFor({ worker: workerTool, review: reviewTool });
    const result = await executeWorkflowVersion({
      world,
      workflowVersion: lockedWorkflowVersion(lwir, { tools: registry }),
      runId: "run_parallel_branch_decision_end_output",
      input: { items: [{ id: "a" }, { id: "b" }] },
      tools: registryFor({ worker: workerTool, review: reviewTool }),
    });

    expect(result.status).toBe("completed");
    const output = result.output as unknown[];
    expect(output).toHaveLength(2);
    // Each branch ran worker and review twice (review passed on 2nd visit, looping back once).
    expect(workerTool).toHaveBeenCalledTimes(4); // 2 items × 2 worker visits each
    expect(reviewTool).toHaveBeenCalledTimes(4); // 2 items × 2 review visits each

    // Fan-in output must be the most-recently-committed non-decision step output.
    // After the loop: review ran last (visit[1] → passed=true), so its output is used,
    // NOT the decision step's output ({ chosen: "end" }).
    const entryA = output.find((e) => (e as { itemKey: string }).itemKey === "a") as {
      status: string;
      output: { passed: boolean; reviewId: string };
    } | undefined;
    const entryB = output.find((e) => (e as { itemKey: string }).itemKey === "b") as {
      status: string;
      output: { passed: boolean; reviewId: string };
    } | undefined;
    expect(entryA).toBeDefined();
    expect(entryB).toBeDefined();
    expect(entryA?.status).toBe("completed");
    expect(entryB?.status).toBe("completed");
    // Output is review's last output, not { chosen: "end" } from the decision step.
    expect(entryA?.output.passed).toBe(true);
    expect(entryA?.output.reviewId).toBe("a");
    expect(entryB?.output.passed).toBe(true);
    expect(entryB?.output.reviewId).toBe("b");
  });

  it("respects explicit fanIn.outputStep override to a non-decision branch step", async () => {
    const world = await tempWorld();
    // Same loop structure as Test 1 (worker → review → route) but fanIn.outputStep: "worker".
    // The default rule would produce review's last output ({ passed: true }),
    // because review is the most-recently-committed non-decision step.
    // With outputStep: "worker", the fan-in must instead use worker's most-recently-committed
    // output ({ workerId: "x", visitCount: 2 }), discriminating the two code paths.
    const workerCallCounts: Record<string, number> = {};
    const reviewCallCounts: Record<string, number> = {};
    const workerTool = vi.fn((input: unknown) => {
      const item = input as { readonly id: string };
      workerCallCounts[item.id] = (workerCallCounts[item.id] ?? 0) + 1;
      return { workerId: item.id, visitCount: workerCallCounts[item.id] };
    });
    const reviewTool = vi.fn((input: unknown) => {
      const item = input as { readonly id: string };
      reviewCallCounts[item.id] = (reviewCallCounts[item.id] ?? 0) + 1;
      return { passed: (reviewCallCounts[item.id] ?? 0) >= 2, reviewId: item.id };
    });
    const lwir: LwirWorkflow = {
      apiVersion: "littleworkflow.dev/v0.1",
      kind: "Workflow",
      metadata: { name: "parallel-branch-decision-output-step-override" },
      input: {
        schema: {
          type: "object",
          required: ["items"],
          properties: { items: { type: "array" } },
        },
      },
      output: { schema: { type: "array" } },
      permissions: { tools: ["worker", "review"] },
      steps: [
        {
          id: "batch",
          uses: "parallel",
          with: {
            items: "{{ input.items }}",
            cardinality: { kind: "matches_items" },
            itemKey: "{{ item.id }}",
            maxBranches: 3,
            maxConcurrency: 3,
            failureMode: "all_settled",
            // outputStep: "worker" — overrides the default (which would give review's output).
            fanIn: { order: "input", output: "array", outputStep: "worker" },
          },
          steps: [
            {
              id: "worker",
              uses: "tool.call",
              with: { tool: "worker" },
              maxVisits: 5,
              input: { id: "{{ item.id }}" },
              output: { mode: "object", schema: { type: "object" } },
            },
            {
              id: "review",
              uses: "tool.call",
              needs: ["worker"],
              with: { tool: "review" },
              maxVisits: 5,
              input: { id: "{{ item.id }}" },
              output: { mode: "object", schema: { type: "object" } },
            },
            {
              id: "route",
              uses: "decision",
              needs: ["review"],
              maxVisits: 5,
              with: {
                cases: [{ when: "{{ steps.review.lastOutput.passed }}", to: "end" }],
                default: "worker",
              },
            },
          ],
          output: { mode: "array", schema: { type: "array" } },
        },
      ],
    };
    const registry = registryFor({ worker: workerTool, review: reviewTool });
    const result = await executeWorkflowVersion({
      world,
      workflowVersion: lockedWorkflowVersion(lwir, { tools: registry }),
      runId: "run_parallel_branch_decision_output_step_override",
      input: { items: [{ id: "x" }, { id: "y" }] },
      tools: registryFor({ worker: workerTool, review: reviewTool }),
    });

    expect(result.status).toBe("completed");
    const output = result.output as unknown[];
    expect(output).toHaveLength(2);

    // Fan-in output must be worker's most-recently-completed output,
    // NOT review's last output ({ passed: true }) as the default rule would give.
    // worker.visit[1] returns { workerId: "x", visitCount: 2 }.
    const entryX = output.find((e) => (e as { itemKey: string }).itemKey === "x") as {
      status: string;
      output: { workerId: string; visitCount: number };
    } | undefined;
    const entryY = output.find((e) => (e as { itemKey: string }).itemKey === "y") as {
      status: string;
      output: { workerId: string; visitCount: number };
    } | undefined;
    expect(entryX).toBeDefined();
    expect(entryY).toBeDefined();
    expect(entryX?.status).toBe("completed");
    expect(entryY?.status).toBe("completed");
    // Confirms outputStep: "worker" overrides the default (review's output).
    expect(entryX?.output.workerId).toBe("x");
    expect(entryX?.output.visitCount).toBe(2);
    expect(entryY?.output.workerId).toBe("y");
    expect(entryY?.output.visitCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// P1.1 — Re-add transitive downstream on parallel-branch decision replay
// ---------------------------------------------------------------------------

describe("P1.1 — transitive downstream re-add on parallel-branch decision replay", () => {
  // Scenario: branch body is worker → review → route (decision).
  //   Pre-seeded: worker.visit[0] + review.visit[0] (passed=false) + route.visit[0] (chosen: "worker").
  //   A crash happened right after route.visit[0] committed.
  //   On resume: `completedForNeeds` has {worker, review, route} → all are absent from `remaining`.
  //   Bug: forcedNextStepId = "worker" but route is not re-added → after worker.visit[1] runs,
  //        the loop exits (remaining empty) and branch terminates with stale review.visit[0] output.
  //   Fix: transitiveDownstreamOf(branchSteps, "worker") = {review, route} → re-added to remaining
  //        → worker.visit[1] → review.visit[1] → route.visit[1] (chosen: "end") → correct output.
  it(
    "P1.1: resumes correctly when crash occurs after route.visit[0] in a parallel branch",
    async () => {
      const world = await tempWorld();

      const workerCallsFor: string[] = [];
      const reviewCallCounts: Record<string, number> = {};

      // Live worker always returns a fixed output (continue doesn't matter, review drives the loop).
      const workerTool = vi.fn((input: unknown) => {
        const item = input as { readonly id: string };
        workerCallsFor.push(item.id);
        return { workerId: item.id, live: true };
      });

      // cand_a: review always passes on the live call (visit[1]).
      // cand_b: fresh branch (no pre-seeded events), passes on first visit.
      const reviewTool = vi.fn((input: unknown) => {
        const item = input as { readonly id: string };
        reviewCallCounts[item.id] = (reviewCallCounts[item.id] ?? 0) + 1;
        return { passed: true, reviewId: item.id };
      });

      // LWIR: worker → review → route (decision back to worker or end)
      const lwir: LwirWorkflow = {
        apiVersion: "littleworkflow.dev/v0.1",
        kind: "Workflow",
        metadata: { name: "p1-1-branch-decision-replay" },
        input: {
          schema: {
            type: "object",
            required: ["items"],
            properties: { items: { type: "array" } },
          },
        },
        output: { schema: { type: "array" } },
        permissions: { tools: ["worker", "review"] },
        steps: [
          {
            id: "score",
            uses: "parallel",
            with: {
              items: "{{ input.items }}",
              cardinality: { kind: "matches_items" },
              itemKey: "{{ item.id }}",
              maxBranches: 5,
              maxConcurrency: 3,
              failureMode: "all_settled",
              fanIn: { order: "input", output: "array", outputStep: "review" },
            },
            steps: [
              {
                id: "worker",
                uses: "tool.call",
                with: { tool: "worker" },
                maxVisits: 2,
                input: { id: "{{ item.id }}" },
                output: { mode: "object", schema: { type: "object" } },
              },
              {
                id: "review",
                uses: "tool.call",
                needs: ["worker"],
                with: { tool: "review" },
                maxVisits: 2,
                input: { id: "{{ item.id }}" },
                output: { mode: "object", schema: { type: "object" } },
              },
              {
                id: "route",
                uses: "decision",
                needs: ["review"],
                maxVisits: 2,
                with: {
                  cases: [{ when: "{{ steps.review.lastOutput.passed }}", to: "end" }],
                  default: "worker",
                },
              },
            ],
            output: { mode: "array", schema: { type: "array" } },
          },
        ],
      };

      const registry = registryFor({ worker: workerTool, review: reviewTool });
      const workflowVersion = lockedWorkflowVersion(lwir, { tools: registry });
      const runId = "run_p1_1_branch_decision_replay";

      // ----- Pre-seed: simulate crash after route.visit[0] committed for cand_a -----

      // Write artifacts for the pre-seeded steps.
      const workerV0Output = { workerId: "cand_a", live: false };
      const workerV0Artifact = await writeArtifact(world, {
        runId,
        stepPath: "score[cand_a].worker.visit[0]",
        name: "output",
        payload: workerV0Output,
        contentType: "application/json",
      });

      const reviewV0Output = { passed: false, reviewId: "cand_a" };
      const reviewV0Artifact = await writeArtifact(world, {
        runId,
        stepPath: "score[cand_a].review.visit[0]",
        name: "output",
        payload: reviewV0Output,
        contentType: "application/json",
      });

      // WorkflowVersionRegistered + RunStarted
      await appendEvent(world, runId, {
        type: "WorkflowVersionRegistered",
        payload: {
          workflowVersionId: workflowVersion.id,
          workflowVersionHash: workflowVersion.hash,
        },
      });
      await appendEvent(world, runId, {
        type: "RunStarted",
        payload: {
          workflowVersionId: workflowVersion.id,
          input: { items: [{ id: "cand_a" }, { id: "cand_b" }] },
        },
      });

      // Parallel step
      await appendEvent(world, runId, {
        type: "StepScheduled",
        payload: { stepPath: "score", stepId: "score", uses: "parallel" },
      });
      await appendEvent(world, runId, {
        type: "StepAttemptStarted",
        payload: { stepPath: "score", stepId: "score", attempt: 1, attemptId: "attempt_1" },
      });
      await appendEvent(world, runId, {
        type: "ParallelGroupStarted",
        payload: {
          stepPath: "score",
          stepId: "score",
          attempt: 1,
          branchCount: 2,
          maxConcurrency: 3,
          failureMode: "all_settled",
        },
      });

      // Branch cand_a scheduled
      await appendEvent(world, runId, {
        type: "ParallelBranchScheduled",
        payload: {
          stepPath: "score",
          branchPath: "score[cand_a]",
          itemKey: "cand_a",
          branchIndex: 0,
        },
      });

      // worker.visit[0] for cand_a
      await appendEvent(world, runId, {
        type: "StepScheduled",
        payload: { stepPath: "score[cand_a].worker.visit[0]", stepId: "worker", uses: "tool.call" },
      });
      await appendEvent(world, runId, {
        type: "StepAttemptStarted",
        payload: {
          stepPath: "score[cand_a].worker.visit[0]",
          stepId: "worker",
          attempt: 1,
          attemptId: "attempt_1",
        },
      });
      await appendEvent(world, runId, {
        type: "ArtifactCreated",
        payload: {
          stepPath: "score[cand_a].worker.visit[0]",
          artifactRef: workerV0Artifact.artifactRef,
          name: "output",
          contentType: "application/json",
        },
      });
      await appendEvent(world, runId, {
        type: "StepOutputValidated",
        payload: {
          stepPath: "score[cand_a].worker.visit[0]",
          outputRef: workerV0Artifact.artifactRef,
          outputMode: "object",
        },
      });
      await appendEvent(world, runId, {
        type: "StepCompleted",
        payload: {
          stepPath: "score[cand_a].worker.visit[0]",
          stepId: "worker",
          attempt: 1,
          output: workerV0Output,
          outputRef: workerV0Artifact.artifactRef,
          artifactRefs: [workerV0Artifact.artifactRef],
          metadata: { uses: "tool.call", outputMode: "object" },
        },
      });

      // review.visit[0] for cand_a (passed=false → route will loop back to worker)
      await appendEvent(world, runId, {
        type: "StepScheduled",
        payload: { stepPath: "score[cand_a].review.visit[0]", stepId: "review", uses: "tool.call" },
      });
      await appendEvent(world, runId, {
        type: "StepAttemptStarted",
        payload: {
          stepPath: "score[cand_a].review.visit[0]",
          stepId: "review",
          attempt: 1,
          attemptId: "attempt_1",
        },
      });
      await appendEvent(world, runId, {
        type: "ArtifactCreated",
        payload: {
          stepPath: "score[cand_a].review.visit[0]",
          artifactRef: reviewV0Artifact.artifactRef,
          name: "output",
          contentType: "application/json",
        },
      });
      await appendEvent(world, runId, {
        type: "StepOutputValidated",
        payload: {
          stepPath: "score[cand_a].review.visit[0]",
          outputRef: reviewV0Artifact.artifactRef,
          outputMode: "object",
        },
      });
      await appendEvent(world, runId, {
        type: "StepCompleted",
        payload: {
          stepPath: "score[cand_a].review.visit[0]",
          stepId: "review",
          attempt: 1,
          output: reviewV0Output,
          outputRef: reviewV0Artifact.artifactRef,
          artifactRefs: [reviewV0Artifact.artifactRef],
          metadata: { uses: "tool.call", outputMode: "object" },
        },
      });

      // route.visit[0] for cand_a — decision step. chosen: "worker" (review didn't pass).
      // CRITICAL: metadata.uses must equal "decision" for pendingDecisionTargetForScope to pick it up.
      // CRITICAL: output.chosen must be a string for the same reason.
      // No artifact needed: outputValueForCompletedStep returns inline output when outputRef is absent.
      await appendEvent(world, runId, {
        type: "StepScheduled",
        payload: { stepPath: "score[cand_a].route.visit[0]", stepId: "route", uses: "decision" },
      });
      await appendEvent(world, runId, {
        type: "StepAttemptStarted",
        payload: {
          stepPath: "score[cand_a].route.visit[0]",
          stepId: "route",
          attempt: 1,
          attemptId: "attempt_1",
        },
      });
      // Crash happens here — route.visit[0] completes but no further events are written.
      await appendEvent(world, runId, {
        type: "StepCompleted",
        payload: {
          stepPath: "score[cand_a].route.visit[0]",
          stepId: "route",
          attempt: 1,
          output: { chosen: "worker" },
          // No outputRef — inline output is sufficient for a decision step.
          metadata: { uses: "decision" },
        },
      });

      // ----- Resume -----
      const result = await executeWorkflowVersion({
        world,
        workflowVersion,
        runId,
        input: { items: [{ id: "cand_a" }, { id: "cand_b" }] },
        tools: registryFor({ worker: workerTool, review: reviewTool }),
      });

      expect(result.status).toBe("completed");

      // cand_a: worker.visit[0] was pre-seeded; only worker.visit[1] should be called live.
      const candACalls = workerCallsFor.filter((id) => id === "cand_a");
      expect(candACalls).toHaveLength(1); // only visit[1]

      // cand_a: review.visit[0] was pre-seeded; review.visit[1] must be called live.
      // (Without the fix, the branch exits after worker.visit[1] and review.visit[1] is never called.)
      expect(reviewCallCounts["cand_a"]).toBe(1); // exactly visit[1]

      // cand_b: fresh branch → worker.visit[0] + review.visit[0] + route → "end".
      const candBCalls = workerCallsFor.filter((id) => id === "cand_b");
      expect(candBCalls).toHaveLength(1);
      expect(reviewCallCounts["cand_b"]).toBe(1);

      // Confirm route.visit[1] was executed for cand_a (the discriminating assertion).
      // Without the fix, route.visit[1] never runs → no StepCompleted for it.
      const events = await listEvents(world, runId);
      const routeV1Completed = events.filter(
        (event) =>
          event.type === "StepCompleted" &&
          event.payload?.stepPath === "score[cand_a].route.visit[1]",
      );
      expect(routeV1Completed).toHaveLength(1);

      // Output shape: both branches completed with passed=true from review.
      const output = result.output as Array<{ itemKey: string; status: string; output: { passed: boolean; reviewId: string } }>;
      expect(output).toHaveLength(2);

      const entryA = output.find((e) => e.itemKey === "cand_a");
      const entryB = output.find((e) => e.itemKey === "cand_b");
      expect(entryA?.status).toBe("completed");
      expect(entryB?.status).toBe("completed");
      // With the fix, review.visit[1] ran → passed=true.
      // Without the fix, stale review.visit[0] would give passed=false.
      expect(entryA?.output.passed).toBe(true);
      expect(entryB?.output.passed).toBe(true);
    },
  );
});

async function appendStartedParallelRun(
  world: Awaited<ReturnType<typeof tempWorld>>,
  workflowVersion: ReturnType<typeof lockedWorkflowVersion>,
  runId: string,
  failureMode: "fail_fast" | "all_settled" = "fail_fast",
): Promise<void> {
  await appendEvent(world, runId, {
    type: "WorkflowVersionRegistered",
    payload: {
      workflowVersionId: workflowVersion.id,
      workflowVersionHash: workflowVersion.hash,
    },
  });
  await appendEvent(world, runId, {
    type: "RunStarted",
    payload: { workflowVersionId: workflowVersion.id },
  });
  await appendEvent(world, runId, {
    type: "StepScheduled",
    payload: { stepPath: "review", stepId: "review", uses: "parallel" },
  });
  await appendEvent(world, runId, {
    type: "StepAttemptStarted",
    payload: {
      stepPath: "review",
      stepId: "review",
      attempt: 1,
      attemptId: "attempt_1",
    },
  });
  await appendEvent(world, runId, {
    type: "ParallelGroupStarted",
    payload: {
      stepPath: "review",
      stepId: "review",
      attempt: 1,
      branchCount: 2,
      maxConcurrency: 2,
      failureMode,
    },
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

async function waitUntil(
  predicate: () => boolean,
  options: {
    readonly attempts?: number;
    readonly intervalMs?: number;
  } = {},
): Promise<void> {
  const attempts = options.attempts ?? 1_000;
  const intervalMs = options.intervalMs ?? 5;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Timed out waiting for condition.");
}

function parallelWorkflow(
  order: "input" | "itemKey",
  overrides: {
    readonly maxBranches?: number;
    readonly maxConcurrency?: number;
    readonly failureMode?: "fail_fast" | "all_settled";
  } = {},
): LwirWorkflow {
  return {
    apiVersion: "littleworkflow.dev/v0.1",
    kind: "Workflow",
    metadata: { name: `parallel-${order}-${overrides.failureMode ?? "fail_fast"}` },
    input: {
      schema: {
        type: "object",
        required: ["ticketId", "candidates"],
        properties: {
          ticketId: { type: "string" },
          candidates: { type: "array" },
        },
      },
    },
    output: { schema: { type: "array" } },
    permissions: { tools: ["score"] },
    steps: [
      {
        id: "review",
        uses: "parallel",
        with: {
          items: "{{ input.candidates }}",
          cardinality: { kind: "matches_items" },
          itemKey: "{{ item.id }}",
          maxBranches: overrides.maxBranches ?? 10,
          maxConcurrency: overrides.maxConcurrency ?? 2,
          failureMode: overrides.failureMode ?? "fail_fast",
          fanIn: { order, output: "array" },
        },
        steps: [
          {
            id: "score",
            uses: "tool.call",
            with: { tool: "score" },
            input: {
              id: "{{ item.id }}",
              score: "{{ item.score }}",
              root: "{{ input.ticketId }}",
            },
            output: { mode: "object", schema: { type: "object" } },
          },
        ],
        output: { mode: "array", schema: { type: "array" } },
      },
    ],
  };
}

function withParallelRetry(lwir: LwirWorkflow, maxAttempts: number): LwirWorkflow {
  const [review, ...rest] = lwir.steps;
  if (review === undefined) {
    throw new Error("Expected review step.");
  }
  return {
    ...lwir,
    steps: [
      {
        ...review,
        retry: { maxAttempts },
      } as LwirWorkflow["steps"][number],
      ...rest,
    ],
  };
}

function parallelThenFinishWorkflow(): LwirWorkflow {
  const workflow = parallelWorkflow("input");
  return {
    ...workflow,
    metadata: { name: "parallel-then-finish" },
    output: { schema: { type: "object" } },
    permissions: { tools: ["finish", "score"] },
    steps: [
      ...workflow.steps,
      {
        id: "finish",
        uses: "tool.call",
        needs: ["review"],
        with: { tool: "finish" },
        input: { review: "{{ steps.review.output }}" },
        output: { mode: "object", schema: { type: "object" } },
      },
    ],
  };
}

function defaultInputParallelWorkflow(): LwirWorkflow {
  return {
    apiVersion: "littleworkflow.dev/v0.1",
    kind: "Workflow",
    metadata: { name: "parallel-default-input" },
    input: {
      schema: {
        type: "object",
        required: ["ticketId", "candidates"],
        properties: {
          ticketId: { type: "string" },
          candidates: { type: "array" },
        },
      },
    },
    output: { schema: { type: "array" } },
    permissions: { tools: ["inspect"] },
    steps: [
      {
        id: "review",
        uses: "parallel",
        with: {
          items: "{{ input.candidates }}",
          cardinality: { kind: "matches_items" },
          itemKey: "{{ sha256(item) }}",
          maxBranches: 10,
          maxConcurrency: 2,
          failureMode: "fail_fast",
          fanIn: { order: "input", output: "array" },
        },
        steps: [
          {
            id: "inspect",
            uses: "tool.call",
            with: { tool: "inspect" },
            output: { mode: "object", schema: { type: "object" } },
          },
        ],
        output: { mode: "array", schema: { type: "array" } },
      },
    ],
  };
}

function topLevelDependencyParallelWorkflow(): LwirWorkflow {
  return {
    apiVersion: "littleworkflow.dev/v0.1",
    kind: "Workflow",
    metadata: { name: "parallel-top-level-dependency" },
    input: {
      schema: {
        type: "object",
        required: ["ticketId", "candidates"],
        properties: {
          ticketId: { type: "string" },
          candidates: { type: "array" },
        },
      },
    },
    output: { schema: { type: "array" } },
    permissions: { tools: ["load", "score"] },
    steps: [
      {
        id: "load",
        uses: "tool.call",
        with: { tool: "load" },
        input: { ticketId: "{{ input.ticketId }}" },
        output: { mode: "object", schema: { type: "object" } },
      },
      {
        id: "review",
        uses: "parallel",
        needs: ["load"],
        with: {
          items: "{{ input.candidates }}",
          cardinality: { kind: "matches_items" },
          itemKey: "{{ item.id }}",
          maxBranches: 10,
          maxConcurrency: 2,
          failureMode: "fail_fast",
          fanIn: { order: "input", output: "array" },
        },
        steps: [
          {
            id: "score",
            uses: "tool.call",
            needs: ["load"],
            with: { tool: "score" },
            input: {
              id: "{{ item.id }}",
              score: "{{ item.score }}",
              root: "{{ steps.load.output.root }}",
              multiplier: "{{ steps.load.output.multiplier }}",
            },
            output: { mode: "object", schema: { type: "object" } },
          },
        ],
        output: { mode: "array", schema: { type: "array" } },
      },
    ],
  };
}

function parentMissingDependencyParallelWorkflow(): LwirWorkflow {
  const workflow = topLevelDependencyParallelWorkflow();
  const review = workflow.steps.find((step) => step.id === "review");
  if (review === undefined) {
    throw new Error("Expected review step.");
  }
  const { needs: _needs, ...reviewWithoutNeeds } = review;
  return {
    ...workflow,
    metadata: { name: "parallel-parent-missing-dependency" },
    output: { schema: { type: "object" } },
    permissions: { tools: ["finish", "load", "score"] },
    steps: [
      workflow.steps[0] as LwirWorkflow["steps"][number],
      reviewWithoutNeeds,
      {
        id: "finish",
        uses: "tool.call",
        needs: ["load", "review"],
        with: { tool: "finish" },
        input: { review: "{{ steps.review.output }}" },
        output: { mode: "object", schema: { type: "object" } },
      },
    ],
  };
}

function unsafeStepPathWorkflow(): LwirWorkflow {
  return {
    apiVersion: "littleworkflow.dev/v0.1",
    kind: "Workflow",
    metadata: { name: "parallel-unsafe-step-path" },
    input: {
      schema: {
        type: "object",
        required: ["ticketId", "candidates"],
        properties: {
          ticketId: { type: "string" },
          candidates: { type: "array" },
        },
      },
    },
    output: { schema: { type: "object" } },
    permissions: { tools: ["score"] },
    steps: [
      {
        id: "review[a].score",
        uses: "tool.call",
        with: { tool: "score" },
        input: {
          id: "a",
          score: 1,
          root: "{{ input.ticketId }}",
        },
        output: { mode: "object", schema: { type: "object" } },
      },
    ],
  };
}

function nonParallelToolWorkflow(): LwirWorkflow {
  return {
    apiVersion: "littleworkflow.dev/v0.1",
    kind: "Workflow",
    metadata: { name: "non-parallel-tool" },
    input: { schema: { type: "object" } },
    output: { schema: { type: "object" } },
    permissions: { tools: ["load"] },
    steps: [
      {
        id: "load",
        uses: "tool.call",
        with: { tool: "load" },
        output: { mode: "object", schema: { type: "object" } },
      },
    ],
  };
}

function multiStepParallelWorkflow(): LwirWorkflow {
  return {
    apiVersion: "littleworkflow.dev/v0.1",
    kind: "Workflow",
    metadata: { name: "parallel-multi-step" },
    input: {
      schema: {
        type: "object",
        required: ["ticketId", "candidates"],
        properties: {
          ticketId: { type: "string" },
          candidates: { type: "array" },
        },
      },
    },
    output: { schema: { type: "array" } },
    permissions: { tools: ["prepare", "score"] },
    steps: [
      {
        id: "review",
        uses: "parallel",
        with: {
          items: "{{ input.candidates }}",
          cardinality: { kind: "matches_items" },
          itemKey: "{{ item.id }}",
          maxBranches: 10,
          maxConcurrency: 2,
          failureMode: "all_settled",
          fanIn: { order: "input", output: "array" },
        },
        steps: [
          {
            id: "prepare",
            uses: "tool.call",
            with: { tool: "prepare" },
            input: {
              id: "{{ item.id }}",
              score: "{{ item.score }}",
            },
            output: { mode: "object", schema: { type: "object" } },
          },
          {
            id: "score",
            uses: "tool.call",
            needs: ["prepare"],
            with: { tool: "score" },
            input: {
              id: "{{ steps.prepare.output.id }}",
              normalized: "{{ steps.prepare.output.normalized }}",
              root: "{{ input.ticketId }}",
            },
            output: { mode: "object", schema: { type: "object" } },
          },
        ],
        output: { mode: "array", schema: { type: "array" } },
      },
    ],
  };
}

function nestedParallelWorkflow(): LwirWorkflow {
  return {
    apiVersion: "littleworkflow.dev/v0.1",
    kind: "Workflow",
    metadata: { name: "parallel-nested-forged" },
    input: {
      schema: {
        type: "object",
        required: ["ticketId", "candidates"],
        properties: {
          ticketId: { type: "string" },
          candidates: { type: "array" },
        },
      },
    },
    output: { schema: { type: "array" } },
    permissions: { tools: ["inspect"] },
    steps: [
      {
        id: "review",
        uses: "parallel",
        with: {
          items: "{{ input.candidates }}",
          cardinality: { kind: "matches_items" },
          itemKey: "{{ item.id }}",
          maxBranches: 10,
          maxConcurrency: 2,
          failureMode: "fail_fast",
          fanIn: { order: "input", output: "array" },
        },
        steps: [
          {
            id: "nested",
            uses: "parallel",
            with: {
              items: "{{ item.children }}",
              cardinality: { kind: "matches_items" },
              itemKey: "{{ item.id }}",
              maxBranches: 10,
              maxConcurrency: 2,
              failureMode: "fail_fast",
              fanIn: { order: "input", output: "array" },
            },
            steps: [
              {
                id: "inspect",
                uses: "tool.call",
                with: { tool: "inspect" },
                output: { mode: "object", schema: { type: "object" } },
              },
            ],
            output: { mode: "array", schema: { type: "array" } },
          },
        ],
        output: { mode: "array", schema: { type: "array" } },
      },
    ],
  };
}

function lockedWorkflowVersion(
  lwir: LwirWorkflow,
  bindings: {
    readonly tools?: ReturnType<typeof registryFor>;
  } = {},
) {
  const lwirHash = sha256Digest(lwir);
  const lwirVersionId = lwirVersionIdForHash(lwirHash);
  const canonicalizer = "little-workflow-canonical-json@alpha";
  const tools = [...(bindings.tools?.names() ?? [])]
    .sort((left, right) => left.localeCompare(right))
    .map((name) => {
      const registered = bindings.tools?.get(name);
      const description = typeof registered?.description === "string"
        ? registered.description
        : "";
      const inputSchema = registered?.inputSchema;
      return stripUndefined({
        name,
        scope: "global",
        description,
        inputSchema,
        descriptionHash: sha256Digest(description),
        inputSchemaHash: inputSchema === undefined ? undefined : sha256Digest(inputSchema),
      });
    });
  const requestedOutput = { mode: "json", schema: lwir.output.schema };
  const capabilityManifest = {
    stepTypes: ["ai.generate", "tool.call", "code.run", "parallel"],
    toolSelection: "planner_selected",
    tools,
    models: [],
    modelSlots: [],
    secrets: [],
    network: { default: "deny", allow: [] },
  };
  const capabilityManifestHash = sha256Digest(capabilityManifest);
  const requestId = `orq_${lwir.metadata.name}`;
  const requestHash = sha256Digest({ name: lwir.metadata.name, lwirHash, tools });
  const plannedInput = { testInput: lwir.metadata.name };
  const inputHash = sha256Digest(plannedInput);
  const plannedInputStructure = concreteInputStructure(plannedInput);
  const plannedInputStructureHash = sha256Digest(plannedInputStructure);
  const workflowDefinitionHash = sha256Digest({ name: lwir.metadata.name });
  const inputSchemaHash = sha256Digest(lwir.input.schema);
  const requestedOutputHash = sha256Digest(requestedOutput);
  const validationHash = computeCompilerValidationHash({
    canonicalizer,
    lwirVersionId,
    lwirHash,
    requestId,
    requestHash,
    inputHash,
    plannedInputStructureHash,
    workflowDefinitionHash,
    inputSchemaHash,
    requestedOutputHash,
    capabilityManifestHash,
  });
  const lockSeed: WorkflowVersionLockSeed = {
    lwirVersionId,
    lwirHash,
    requestId,
    requestHash,
    inputHash,
    plannedInputStructure,
    plannedInputStructureHash,
    workflowDefinitionHash,
    inputSchemaHash,
    requestedOutput,
    requestedOutputHash,
    capabilityManifest,
    capabilityManifestHash,
    modelSlots: [],
    tools,
    validationHash,
  };
  const { workflowVersionId, workflowVersionHash } = computeCompiledWorkflowVersionIdentity({
    canonicalizer,
    lwirVersionId,
    lwirHash,
    lockSeed,
  });
  return {
    id: workflowVersionId,
    hash: workflowVersionHash,
    canonicalizer,
    canonicalJson: canonicalJson(lwir),
    lwirVersionId,
    lwirHash,
    lwir,
    lock: {
      workflowVersionId,
      workflowVersionHash,
      ...lockSeed,
    },
  } as const;
}

function propertyValue(value: unknown, key: string): unknown {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    return undefined;
  }
  return Object.hasOwn(value, key) ? (value as Record<string, unknown>)[key] : undefined;
}

function stringProperty(value: unknown, key: string): string | undefined {
  const property = propertyValue(value, key);
  if (typeof property === "string") {
    return property;
  }
  if (typeof property === "number" || typeof property === "boolean") {
    return String(property);
  }
  return undefined;
}

function stripUndefined<T extends Record<string, unknown>>(value: T): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) {
      result[key] = item;
    }
  }
  return result;
}

/**
 * Build a ToolRegistry from a plain handler map.
 * Descriptor info (description, inputSchema, outputSchema, needsApproval) is extracted
 * from own properties of each handler, matching how lockedWorkflowVersion builds the lock.
 */
function registryFor(handlers: Record<string, RuntimeToolHandler>) {
  const registry = createToolRegistry();
  for (const [name, handler] of Object.entries(handlers)) {
    const description = typeof propertyValue(handler, "description") === "string"
      ? (propertyValue(handler, "description") as string)
      : "";
    const inputSchema = propertyValue(handler, "inputSchema");
    const outputSchema = propertyValue(handler, "outputSchema");
    const needsApproval = propertyValue(handler, "needsApproval");
    registry.register(name, {
      description,
      ...(inputSchema !== undefined ? { inputSchema } : {}),
      ...(outputSchema !== undefined ? { outputSchema } : {}),
      ...(needsApproval !== undefined ? { needsApproval: needsApproval as boolean } : {}),
      execute: handler as (input: unknown, context: unknown) => Promise<unknown>,
    });
  }
  return registry;
}
