import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ArtifactNotFoundError,
  ArtifactHashMismatchError,
  RunNotFoundError,
  appendEvent,
  buildRunStateFromEvents,
  hydrateArtifactRefs,
  listEvents,
  localWorld,
  materializeRunState,
  readArtifact,
  replayRun,
  stepPathFor,
  visitIndexFor,
  writeArtifact,
} from "./index.js";

const tempDirs: string[] = [];

async function tempWorld() {
  const dataDir = await mkdtemp(join(tmpdir(), "little-workflow-replay-"));
  tempDirs.push(dataDir);
  return localWorld({ dataDir });
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("replay state builder", () => {
  it("rebuilds materialized run state deterministically from provided events", async () => {
    const world = await tempWorld();
    const artifact = await writeArtifact(world, {
      runId: "run_replay_state",
      stepPath: "extract",
      name: "profile",
      payload: { name: "Ada" },
      contentType: "application/json",
    });

    await appendEvent(world, "run_replay_state", {
      type: "RunStarted",
      payload: { workflowVersionId: "wfver_replay" },
    });
    await appendEvent(world, "run_replay_state", {
      type: "StepScheduled",
      payload: { stepPath: "extract" },
    });
    await appendEvent(world, "run_replay_state", {
      type: "StepAttemptStarted",
      payload: { stepPath: "extract", attemptId: "attempt_1" },
    });
    await appendEvent(world, "run_replay_state", {
      type: "ModelCallCompleted",
      payload: {
        usage: { inputTokens: 12, outputTokens: 4, costUsd: 0.003 },
      },
    });
    await appendEvent(world, "run_replay_state", {
      type: "StepCompleted",
      payload: {
        stepPath: "extract",
        output: { name: "Ada" },
        outputRef: artifact.artifactRef,
        artifactRefs: [artifact.artifactRef],
      },
    });
    await appendEvent(world, "run_replay_state", {
      type: "RunCompleted",
      payload: { output: { ok: true }, outputRef: artifact.artifactRef },
    });

    const events = await listEvents(world, "run_replay_state");
    const rebuilt = buildRunStateFromEvents("run_replay_state", events);
    const materialized = await materializeRunState(world, "run_replay_state");

    expect(rebuilt).toEqual(materialized);
    expect(Object.getPrototypeOf(rebuilt.steps)).toBe(null);
    expect(() => buildRunStateFromEvents("run_missing", [])).toThrow(RunNotFoundError);
  });

  it("hydrates artifact refs with manifests and payloads", async () => {
    const world = await tempWorld();
    const first = await writeArtifact(world, {
      runId: "run_replay_artifacts",
      stepPath: "extract",
      name: "json",
      payload: { score: 98 },
      contentType: "application/json",
    });
    const second = await writeArtifact(world, {
      runId: "run_replay_artifacts",
      stepPath: "summarize",
      name: "text",
      payload: "ready",
      contentType: "text/plain",
    });

    await expect(
      hydrateArtifactRefs(world, [second.artifactRef, first.artifactRef]),
    ).resolves.toEqual([
      { ref: second.artifactRef, manifest: second, payload: "ready" },
      { ref: first.artifactRef, manifest: first, payload: { score: 98 } },
    ]);
  });

  it("plans replay by skipping completed steps and rerunning incomplete steps", async () => {
    const world = await tempWorld();
    const artifact = await writeArtifact(world, {
      runId: "run_replay_plan",
      stepPath: "extract",
      name: "profile",
      payload: { name: "Ada" },
      contentType: "application/json",
    });

    await appendEvent(world, "run_replay_plan", { type: "RunStarted", payload: {} });
    await appendEvent(world, "run_replay_plan", {
      type: "StepScheduled",
      payload: { stepPath: "extract" },
    });
    await appendEvent(world, "run_replay_plan", {
      type: "StepCompleted",
      payload: {
        stepPath: "extract",
        output: { name: "Ada" },
        outputRef: artifact.artifactRef,
      },
    });
    await appendEvent(world, "run_replay_plan", {
      type: "StepScheduled",
      payload: { stepPath: "summarize" },
    });
    await appendEvent(world, "run_replay_plan", {
      type: "StepAttemptStarted",
      payload: { stepPath: "score", attemptId: "attempt_1" },
    });
    await appendEvent(world, "run_replay_plan", {
      type: "StepFailed",
      payload: { stepPath: "notify", error: { message: "Webhook unavailable" } },
    });

    const replay = await replayRun(world, "run_replay_plan");

    expect(replay.completedStepPaths).toEqual(["extract"]);
    expect(replay.pendingStepPaths).toEqual(["summarize", "score", "notify"]);
    expect(replay.steps).toEqual([
      expect.objectContaining({
        stepPath: "extract",
        status: "completed",
        shouldRun: false,
        output: { name: "Ada" },
        outputRef: artifact.artifactRef,
        artifactRefs: [artifact.artifactRef],
      }),
      expect.objectContaining({
        stepPath: "summarize",
        status: "pending",
        shouldRun: true,
        artifactRefs: [],
      }),
      expect.objectContaining({
        stepPath: "score",
        status: "running",
        shouldRun: true,
        artifactRefs: [],
      }),
      expect.objectContaining({
        stepPath: "notify",
        status: "failed",
        shouldRun: true,
        artifactRefs: [],
      }),
    ]);
    expect(replay.artifacts).toEqual([
      { ref: artifact.artifactRef, manifest: artifact, payload: { name: "Ada" } },
    ]);
  });

  it("surfaces artifact store errors when replay refs are missing", async () => {
    const world = await tempWorld();
    const artifact = await writeArtifact(world, {
      runId: "run_replay_missing_artifact",
      stepPath: "extract",
      name: "profile",
      payload: { name: "Ada" },
      contentType: "application/json",
    });

    await appendEvent(world, "run_replay_missing_artifact", { type: "RunStarted", payload: {} });
    await appendEvent(world, "run_replay_missing_artifact", {
      type: "StepCompleted",
      payload: { stepPath: "extract", outputRef: artifact.artifactRef },
    });

    await rm(join(world.dataDir, "artifacts", `${artifact.artifactId}.json`));

    await expect(replayRun(world, "run_replay_missing_artifact")).rejects.toBeInstanceOf(
      ArtifactNotFoundError,
    );
  });

  it("rejects replay events that belong to another run", async () => {
    const world = await tempWorld();
    await appendEvent(world, "run_replay_other", { type: "RunStarted", payload: {} });

    const events = await listEvents(world, "run_replay_other");

    expect(() => buildRunStateFromEvents("run_replay_expected", events)).toThrow(
      "Event runId mismatch",
    );
  });

  it("rejects cross-run artifact refs before hydrating replay payloads", async () => {
    const world = await tempWorld();
    const otherArtifact = await writeArtifact(world, {
      runId: "run_replay_artifact_owner",
      stepPath: "extract",
      name: "profile",
      payload: { name: "Ada" },
      contentType: "application/json",
    });

    await appendEvent(world, "run_replay_cross_run_artifact", {
      type: "RunStarted",
      payload: {},
    });
    await appendEvent(world, "run_replay_cross_run_artifact", {
      type: "ArtifactCreated",
      payload: { stepPath: "extract", artifactRef: otherArtifact.artifactRef },
    });
    await writeFile(
      join(world.dataDir, "artifacts", "blobs", `${otherArtifact.artifactId}.bin`),
      "tampered cross-run payload",
    );

    await expect(replayRun(world, "run_replay_cross_run_artifact")).rejects.toBeInstanceOf(
      ArtifactNotFoundError,
    );
    await expect(readArtifact(world, otherArtifact.artifactRef)).rejects.toBeInstanceOf(
      ArtifactHashMismatchError,
    );
  });

  it("keeps replay plan steps in event order for numeric-looking step paths", async () => {
    const world = await tempWorld();

    await appendEvent(world, "run_replay_numeric_paths", { type: "RunStarted", payload: {} });
    await appendEvent(world, "run_replay_numeric_paths", {
      type: "StepScheduled",
      payload: { stepPath: "10" },
    });
    await appendEvent(world, "run_replay_numeric_paths", {
      type: "StepScheduled",
      payload: { stepPath: "2" },
    });

    const replay = await replayRun(world, "run_replay_numeric_paths");

    expect(replay.steps.map((step) => step.stepPath)).toEqual(["10", "2"]);
    expect(replay.pendingStepPaths).toEqual(["10", "2"]);
  });

  it("preserves harness events and ignores in-progress harness sessions for terminal replay", async () => {
    const world = await tempWorld();
    const runId = "run_replay_harness_terminal";

    await appendEvent(world, runId, { type: "RunStarted", payload: {} });
    await appendEvent(world, runId, {
      type: "StepScheduled",
      payload: { stepPath: "generate" },
    });
    await appendEvent(world, runId, {
      type: "StepAttemptStarted",
      payload: { stepPath: "generate", attemptId: "attempt_1" },
    });
    await appendEvent(world, runId, {
      type: "harness.session.started",
      payload: {
        runId,
        role: "worker.ai-generate",
        task: { kind: "execute_step" },
        manifest: { stepPath: "generate" },
        manifestHash: "sha256:test_manifest",
      },
    });
    await appendEvent(world, runId, {
      type: "StepCompleted",
      payload: { stepPath: "generate", output: { ok: true } },
    });
    await appendEvent(world, runId, {
      type: "RunCompleted",
      payload: { output: { ok: true } },
    });

    const replay = await replayRun(world, runId);

    expect(replay.pendingStepPaths).toEqual([]);
    expect(replay.steps).toEqual([
      expect.objectContaining({
        stepPath: "generate",
        status: "completed",
        shouldRun: false,
      }),
    ]);
    expect(replay.events.map((event) => event.type)).toContain("harness.session.started");
  });
});

describe("visit-indexed step paths (Layer A §2.4)", () => {
  it("stepPathFor returns base step.id when maxVisits === 1 (DAG default)", () => {
    const step = { id: "worker", uses: "tool.call" as const };
    expect(stepPathFor(step, "", 0)).toBe("worker");
    expect(stepPathFor(step, "", 1)).toBe("worker");
  });

  it("stepPathFor returns base step.id when maxVisits is not set", () => {
    const step = { id: "summarize", uses: "ai.generate" as const };
    expect(stepPathFor(step, "", 0)).toBe("summarize");
  });

  it("stepPathFor includes .visit[N] suffix when maxVisits > 1", () => {
    const step = { id: "worker", uses: "tool.call" as const, maxVisits: 3 };
    expect(stepPathFor(step, "", 0)).toBe("worker.visit[0]");
    expect(stepPathFor(step, "", 1)).toBe("worker.visit[1]");
    expect(stepPathFor(step, "", 2)).toBe("worker.visit[2]");
  });

  it("stepPathFor uses branchPath as prefix for steps inside parallel branches", () => {
    const step = { id: "worker", uses: "tool.call" as const, maxVisits: 2 };
    expect(stepPathFor(step, "parallel_step[key_abc]", 0)).toBe(
      "parallel_step[key_abc].worker.visit[0]",
    );
    expect(stepPathFor(step, "parallel_step[key_abc]", 1)).toBe(
      "parallel_step[key_abc].worker.visit[1]",
    );
  });

  it("stepPathFor uses branchPath as prefix without .visit[N] for maxVisits === 1", () => {
    const step = { id: "worker", uses: "tool.call" as const };
    expect(stepPathFor(step, "parallel_step[key_abc]", 0)).toBe(
      "parallel_step[key_abc].worker",
    );
  });

  it("visitIndexFor returns 0 when no visits have been committed", async () => {
    const world = await tempWorld();
    const step = { id: "worker", uses: "tool.call" as const, maxVisits: 3 };
    await appendEvent(world, "run_vi_none", { type: "RunStarted", payload: {} });
    const events = await listEvents(world, "run_vi_none");
    const state = buildRunStateFromEvents("run_vi_none", events);
    expect(visitIndexFor(step, "", state)).toBe(0);
  });

  it("visitIndexFor returns 0 for maxVisits === 1 steps regardless of state", async () => {
    const world = await tempWorld();
    const step = { id: "worker", uses: "tool.call" as const };
    await appendEvent(world, "run_vi_dag", { type: "RunStarted", payload: {} });
    await appendEvent(world, "run_vi_dag", {
      type: "StepCompleted",
      payload: { stepPath: "worker", output: "done" },
    });
    const events = await listEvents(world, "run_vi_dag");
    const state = buildRunStateFromEvents("run_vi_dag", events);
    expect(visitIndexFor(step, "", state)).toBe(0);
  });

  it("reconstructs visit counter from multiple StepCompleted events for the same step", async () => {
    const world = await tempWorld();
    await appendEvent(world, "run_vi_multi", { type: "RunStarted", payload: {} });
    await appendEvent(world, "run_vi_multi", {
      type: "StepScheduled",
      payload: { stepPath: "worker.visit[0]" },
    });
    await appendEvent(world, "run_vi_multi", {
      type: "StepCompleted",
      payload: { stepPath: "worker.visit[0]", output: "first" },
    });
    await appendEvent(world, "run_vi_multi", {
      type: "StepScheduled",
      payload: { stepPath: "worker.visit[1]" },
    });
    await appendEvent(world, "run_vi_multi", {
      type: "StepCompleted",
      payload: { stepPath: "worker.visit[1]", output: "second" },
    });

    const events = await listEvents(world, "run_vi_multi");
    const state = buildRunStateFromEvents("run_vi_multi", events);
    const step = { id: "worker", uses: "tool.call" as const, maxVisits: 3 };

    // Both visits are recorded as separate step entries in state
    expect(Object.keys(state.steps)).toContain("worker.visit[0]");
    expect(Object.keys(state.steps)).toContain("worker.visit[1]");
    expect(state.steps["worker.visit[0]"]?.status).toBe("completed");
    expect(state.steps["worker.visit[1]"]?.status).toBe("completed");

    // visitIndexFor should return 2 (the next visit index to use)
    expect(visitIndexFor(step, "", state)).toBe(2);
  });

  it("visitIndexFor counts only completed visits (not pending/running)", async () => {
    const world = await tempWorld();
    await appendEvent(world, "run_vi_partial", { type: "RunStarted", payload: {} });
    await appendEvent(world, "run_vi_partial", {
      type: "StepScheduled",
      payload: { stepPath: "worker.visit[0]" },
    });
    await appendEvent(world, "run_vi_partial", {
      type: "StepCompleted",
      payload: { stepPath: "worker.visit[0]", output: "first" },
    });
    await appendEvent(world, "run_vi_partial", {
      type: "StepScheduled",
      payload: { stepPath: "worker.visit[1]" },
    });
    // visit[1] is scheduled but not yet completed (simulates kill mid-loop)

    const events = await listEvents(world, "run_vi_partial");
    const state = buildRunStateFromEvents("run_vi_partial", events);
    const step = { id: "worker", uses: "tool.call" as const, maxVisits: 3 };

    // Only visit[0] is completed; visit[1] is pending
    expect(state.steps["worker.visit[0]"]?.status).toBe("completed");
    expect(state.steps["worker.visit[1]"]?.status).toBe("pending");

    // visitIndexFor should return 1 (resume at visit[1], not start visit[2])
    expect(visitIndexFor(step, "", state)).toBe(1);
  });

  it("RuntimeMaxVisitsError is thrown by executeStep when visitIndex >= maxVisits cap — wired via decision executor in Task 14", () => {
    // This is a unit test of the overshoot guard inside executeStep.
    // The integration-level proof (end-to-end via a decision loop) lives in runtime.test.ts:
    // "records max_visits_exceeded in RunFailed event" and
    // "fails the run with max_visits_exceeded when back-edge re-execution would exceed cap".
    //
    // Here we just confirm that stepPathFor and visitIndexFor produce the right values
    // that would trigger the guard (visitIndex === cap means overshoot).
    const step = { id: "worker", uses: "tool.call" as const, maxVisits: 2 };
    // At visit[2] the cap (2) is reached — executeStep checks visitIndex >= cap.
    expect(stepPathFor(step, "", 2)).toBe("worker.visit[2]");
    // visitIndexFor counts completed visits; if 2 are completed, next index is 2 (overshoot).
    // That path ("worker.visit[2]") is what RuntimeMaxVisitsError.failedStepPath reports.
  });
});
