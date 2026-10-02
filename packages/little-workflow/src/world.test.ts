import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { localWorld } from "./authoring.js";
import {
  ArtifactHashMismatchError,
  ArtifactManifestCorruptError,
  ArtifactNotFoundError,
  RunNotFoundError,
  WorldPathError,
  canonicalJson,
  appendEvent,
  listEvents,
  materializeRunState,
  readArtifact,
  truncateEventLogForTest,
  writeArtifact,
} from "./index.js";

const tempDirs: string[] = [];

async function tempWorld() {
  const dataDir = await mkdtemp(join(tmpdir(), "little-workflow-world-"));
  tempDirs.push(dataDir);
  return localWorld({ dataDir });
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("Local World event and artifact store", () => {
  it("accepts harness event vocabulary", async () => {
    const world = await tempWorld();
    const runId = "run_harness_events";
    const events = [
      {
        type: "harness.session.started",
        payload: {
          runId,
          role: "planner",
          task: { kind: "plan" },
          manifest: { harnessId: "testHarness@1.0.0" },
          manifestHash: "sha256:test",
        },
      },
      {
        type: "harness.session.completed",
        payload: {
          runId,
          output: { ok: true },
          usage: { inputTokens: 1, outputTokens: 1, costUsd: null },
        },
      },
      {
        type: "harness.session.failed",
        payload: { runId, error: { message: "failed" } },
      },
      {
        type: "harness.model.called",
        payload: {
          turn: 1,
          promptHash: "sha256:prompt",
          request: { model: "gpt-5", messages: [], tools: [] },
        },
      },
      {
        type: "harness.model.responded",
        payload: {
          turn: 1,
          response: { text: "ok" },
          usage: { inputTokens: 1, outputTokens: 1, costUsd: null },
        },
      },
      {
        type: "harness.tool_call.started",
        payload: {
          turn: 1,
          callId: "call_1",
          caller: "model",
          toolName: "bash",
          args: { cmd: "echo ok" },
        },
      },
      {
        type: "harness.tool_call.succeeded",
        payload: {
          callId: "call_1",
          result: { stdout: "ok\n", stderr: "", exitCode: 0 },
          durationMs: 1,
        },
      },
      {
        type: "harness.tool_call.failed",
        payload: { callId: "call_2", error: { message: "tool failed" }, durationMs: 1 },
      },
      {
        type: "harness.execute_step.started",
        payload: { stepPath: "step", visitIndex: 0 },
      },
      {
        type: "harness.execute_step.succeeded",
        payload: { stepPath: "step", visitIndex: 0, output: { ok: true } },
      },
    ] as const;

    for (const event of events) {
      await appendEvent(world, runId, event);
    }

    expect((await listEvents(world, runId)).map((event) => event.type)).toEqual(
      events.map((event) => event.type),
    );
  });

  it("appends events in commit order and returns stable event refs", async () => {
    const world = await tempWorld();

    const started = await appendEvent(world, "run_order", {
      type: "RunStarted",
      payload: { workflowVersionId: "wfver_123" },
    });
    const scheduled = await appendEvent(world, "run_order", {
      type: "StepScheduled",
      payload: { stepPath: "summarize" },
    });
    const completed = await appendEvent(world, "run_order", {
      type: "RunCompleted",
      payload: { output: { ok: true } },
    });

    expect([started.sequence, scheduled.sequence, completed.sequence]).toEqual([1, 2, 3]);
    expect(started).toEqual(
      expect.objectContaining({
        eventId: expect.stringMatching(/^evt_[0-9a-f]{16}$/),
        runId: "run_order",
        sequence: 1,
        type: "RunStarted",
        payload: { workflowVersionId: "wfver_123" },
        recordedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      }),
    );

    const events = await listEvents(world, "run_order");
    expect(events).toHaveLength(3);
    expect(events.map((event) => event.eventId)).toEqual([
      started.eventId,
      scheduled.eventId,
      completed.eventId,
    ]);
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3]);
    expect(events.map((event) => event.type)).toEqual([
      "RunStarted",
      "StepScheduled",
      "RunCompleted",
    ]);
  });

  it("surfaces only fully-committed events after an interrupted append and continues the sequence", async () => {
    // Guarantee under test: after a crash mid-append, listEvents returns ONLY
    // the events that were durably committed (in order), and the next append
    // resumes from the correct next sequence — no corruption, no gaps, no
    // double-counting. Expressed via the medium-agnostic crash seam rather than
    // by editing the on-disk byte format.
    const world = await tempWorld();

    const started = await appendEvent(world, "run_partial_tail", {
      type: "RunStarted",
      payload: { workflowVersionId: "wfver_123" },
    });
    // A second event is committed, then the "crash" leaves only event 1 durable.
    await appendEvent(world, "run_partial_tail", {
      type: "StepScheduled",
      payload: { stepPath: "summarize" },
    });
    await truncateEventLogForTest(world, "run_partial_tail", started.sequence);

    // Only the fully-committed prefix survives.
    await expect(listEvents(world, "run_partial_tail")).resolves.toEqual([
      expect.objectContaining({ sequence: 1, type: "RunStarted" }),
    ]);

    // The next append continues from the correct next sequence with the
    // deterministic eventId formula — proving no corruption or sequence drift.
    const completed = await appendEvent(world, "run_partial_tail", {
      type: "RunCompleted",
      payload: { output: { ok: true } },
    });
    expect(completed.sequence).toBe(2);
    expect(completed.eventId).toMatch(/^evt_[0-9a-f]{16}$/);

    const events = await listEvents(world, "run_partial_tail");
    expect(events.map((event) => event.sequence)).toEqual([1, 2]);
    expect(events.map((event) => event.type)).toEqual(["RunStarted", "RunCompleted"]);
    expect(events[0]!.eventId).toBe(started.eventId);
    expect(events[1]!.eventId).toBe(completed.eventId);
  });

  it("does not advance the sequence when an append is rejected before commit", async () => {
    // Guarantee under test: a rejected append (here, a StepCompleted that
    // references a non-existent artifact and is rejected before persistence)
    // must NOT consume a sequence number. The next successful append continues
    // from where the committed log left off.
    const world = await tempWorld();

    const started = await appendEvent(world, "run_rejected_append", {
      type: "RunStarted",
      payload: {},
    });
    expect(started.sequence).toBe(1);

    await expect(
      appendEvent(world, "run_rejected_append", {
        type: "StepCompleted",
        payload: {
          stepPath: "summarize",
          outputRef: "artifact://art_missing",
          artifactRefs: ["artifact://art_missing"],
        },
      }),
    ).rejects.toBeInstanceOf(ArtifactNotFoundError);

    const next = await appendEvent(world, "run_rejected_append", {
      type: "RunCompleted",
      payload: { output: { ok: true } },
    });
    expect(next.sequence).toBe(2);

    const events = await listEvents(world, "run_rejected_append");
    expect(events.map((event) => event.sequence)).toEqual([1, 2]);
    expect(events.map((event) => event.type)).toEqual(["RunStarted", "RunCompleted"]);
  });

  it("isolates events and artifacts by temporary Local World directory", async () => {
    const left = await tempWorld();
    const right = await tempWorld();

    await appendEvent(left, "run_same", { type: "RunStarted", payload: { side: "left" } });
    await appendEvent(right, "run_same", { type: "RunStarted", payload: { side: "right" } });
    const leftArtifact = await writeArtifact(left, {
      runId: "run_same",
      stepPath: "step",
      name: "payload",
      payload: { side: "left" },
      contentType: "application/json",
    });
    const rightArtifact = await writeArtifact(right, {
      runId: "run_same",
      stepPath: "step",
      name: "payload",
      payload: { side: "right" },
      contentType: "application/json",
    });

    await expect(listEvents(left, "run_same")).resolves.toEqual([
      expect.objectContaining({ payload: { side: "left" } }),
    ]);
    await expect(listEvents(right, "run_same")).resolves.toEqual([
      expect.objectContaining({ payload: { side: "right" } }),
    ]);
    await expect(readArtifact(left, leftArtifact.artifactRef)).resolves.toEqual(
      expect.objectContaining({ payload: { side: "left" } }),
    );
    await expect(readArtifact(right, rightArtifact.artifactRef)).resolves.toEqual(
      expect.objectContaining({ payload: { side: "right" } }),
    );
  });

  it("round-trips artifact manifests and payloads", async () => {
    const world = await tempWorld();

    const jsonArtifact = await writeArtifact(world, {
      runId: "run_artifacts",
      stepPath: "extract",
      name: "profile",
      payload: { name: "Ada", score: 98 },
      contentType: "application/json",
    });
    const textArtifact = await writeArtifact(world, {
      runId: "run_artifacts",
      name: "notes",
      payload: "plain text",
      contentType: "text/plain",
    });
    const bytesArtifact = await writeArtifact(world, {
      runId: "run_artifacts",
      name: "bytes",
      payload: new Uint8Array([1, 2, 3]),
      contentType: "application/octet-stream",
    });

    expect(jsonArtifact).toEqual(
      expect.objectContaining({
        artifactId: expect.stringMatching(/^art_[0-9a-f]{16}$/),
        artifactRef: expect.stringMatching(/^artifact:\/\/art_[0-9a-f]{16}$/),
        encoding: "json",
        sha256: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        sizeBytes: expect.any(Number),
      }),
    );
    await expect(readArtifact(world, jsonArtifact.artifactRef)).resolves.toEqual(
      expect.objectContaining({
        manifest: jsonArtifact,
        payload: { name: "Ada", score: 98 },
      }),
    );
    await expect(readArtifact(world, textArtifact.artifactRef)).resolves.toEqual(
      expect.objectContaining({ payload: "plain text" }),
    );
    const bytesRead = await readArtifact(world, bytesArtifact.artifactRef);
    expect(Array.from(bytesRead.payload as Uint8Array)).toEqual([1, 2, 3]);

    const duplicateJson = await writeArtifact(world, {
      runId: "run_artifacts",
      stepPath: "extract",
      name: "profile",
      payload: { score: 98, name: "Ada" },
      contentType: "application/json",
    });
    expect(duplicateJson.artifactId).toBe(jsonArtifact.artifactId);
    expect(duplicateJson).toEqual(jsonArtifact);

    const textOne = await writeArtifact(world, {
      runId: "run_artifacts",
      name: "one",
      payload: "1",
      contentType: "text/plain",
    });
    const jsonOne = await writeArtifact(world, {
      runId: "run_artifacts",
      name: "one",
      payload: 1,
      contentType: "application/json",
    });
    expect(textOne.sha256).toBe(jsonOne.sha256);
    expect(textOne.artifactId).not.toBe(jsonOne.artifactId);
  });

  it("serializes concurrent duplicate artifact writes for the same ref", async () => {
    const world = await tempWorld();

    const writes = await Promise.all(
      Array.from({ length: 8 }, () =>
        writeArtifact(world, {
          runId: "run_concurrent_artifact",
          stepPath: "extract",
          name: "profile",
          payload: { name: "Ada", score: 98 },
          contentType: "application/json",
        }),
      ),
    );

    expect(new Set(writes.map((manifest) => manifest.artifactId))).toHaveLength(1);
    expect(new Set(writes.map((manifest) => manifest.createdAt))).toHaveLength(1);
    await expect(readArtifact(world, writes[0]!.artifactRef)).resolves.toEqual(
      expect.objectContaining({ payload: { name: "Ada", score: 98 } }),
    );
  });

  it("detects unsafe paths, unknown artifacts, and artifact hash mismatches", async () => {
    const world = await tempWorld();

    await expect(
      appendEvent(world, "../run_escape", { type: "RunStarted", payload: {} }),
    ).rejects.toBeInstanceOf(WorldPathError);
    await expect(readArtifact(world, "artifact://../art_escape")).rejects.toBeInstanceOf(
      WorldPathError,
    );
    await expect(readArtifact(world, "artifact://art_missing")).rejects.toBeInstanceOf(
      ArtifactNotFoundError,
    );

    const artifact = await writeArtifact(world, {
      runId: "run_hash",
      name: "payload",
      payload: { ok: true },
      contentType: "application/json",
    });
    await writeFileForTest(
      join(world.dataDir, "artifacts", "blobs", `${artifact.artifactId}.bin`),
      "tampered",
    );
    await expect(readArtifact(world, artifact.artifactRef)).rejects.toBeInstanceOf(
      ArtifactHashMismatchError,
    );
  });

  it("detects malformed artifact manifests with forged size fields", async () => {
    const world = await tempWorld();
    const artifact = await writeArtifact(world, {
      runId: "run_manifest_shape",
      name: "payload",
      payload: { ok: true },
      contentType: "application/json",
    });

    await writeFileForTest(
      join(world.dataDir, "artifacts", `${artifact.artifactId}.json`),
      `${canonicalJson({
        ...artifact,
        sizeBytes: artifact.sizeBytes + 1,
      })}\n`,
    );

    await expect(readArtifact(world, artifact.artifactRef)).rejects.toBeInstanceOf(
      ArtifactManifestCorruptError,
    );
  });

  it("materializes run and step views from events after artifacts are committed", async () => {
    const world = await tempWorld();
    const artifact = await writeArtifact(world, {
      runId: "run_materialize",
      stepPath: "summarize",
      name: "summary-output",
      payload: { summary: "Done" },
      contentType: "application/json",
    });

    await appendEvent(world, "run_materialize", {
      type: "RunStarted",
      payload: { workflowVersionId: "wfver_materialized" },
    });
    await appendEvent(world, "run_materialize", {
      type: "StepScheduled",
      payload: { stepPath: "summarize" },
    });
    await appendEvent(world, "run_materialize", {
      type: "StepAttemptStarted",
      payload: { stepPath: "summarize", attemptId: "attempt_1" },
    });
    await appendEvent(world, "run_materialize", {
      type: "ModelCallCompleted",
      payload: {
        stepPath: "summarize",
        model: { provider: "openai", modelId: "gpt-4o-mini" },
        usage: { inputTokens: 10, outputTokens: 5 },
      },
    });
    await appendEvent(world, "run_materialize", {
      type: "ArtifactCreated",
      payload: { stepPath: "summarize", artifactRef: artifact.artifactRef },
    });
    await appendEvent(world, "run_materialize", {
      type: "StepCompleted",
      payload: {
        stepPath: "summarize",
        output: { summary: "Done" },
        outputRef: artifact.artifactRef,
        artifactRefs: [artifact.artifactRef],
        metadata: { outputMode: "object" },
      },
    });
    await appendEvent(world, "run_materialize", {
      type: "RunCompleted",
      payload: { output: { summary: "Done" }, outputRef: artifact.artifactRef },
    });

    const state = await materializeRunState(world, "run_materialize");

    expect(state).toEqual(
      expect.objectContaining({
        runId: "run_materialize",
        workflowVersionId: "wfver_materialized",
        status: "completed",
        output: { summary: "Done" },
        outputRef: artifact.artifactRef,
        artifacts: [artifact.artifactRef],
        eventCount: 7,
      }),
    );
    // Cost is priced from recorded tokens x registry rates, never read off the event.
    // openai/gpt-4o-mini: 10 input x $0.15/1M + 5 output x $0.60/1M = $0.0000045
    expect(state.usage.inputTokens).toBe(10);
    expect(state.usage.outputTokens).toBe(5);
    expect(state.usage.pricedCalls).toBe(1);
    expect(state.usage.unpricedCalls).toBe(0);
    expect(state.usage.costUsd).toBeCloseTo(0.0000045, 14);
    // The same call is attributed to the step that emitted it.
    expect(state.steps.summarize?.usage.inputTokens).toBe(10);
    expect(state.steps.summarize?.usage.costUsd).toBeCloseTo(0.0000045, 14);
    expect(state.steps.summarize).toEqual(
      expect.objectContaining({
        stepPath: "summarize",
        status: "completed",
        output: { summary: "Done" },
        outputRef: artifact.artifactRef,
        artifactRefs: [artifact.artifactRef],
        metadata: { outputMode: "object" },
        attempts: [
          expect.objectContaining({
            attemptId: "attempt_1",
            status: "completed",
            startedAt: expect.any(String),
            finishedAt: expect.any(String),
          }),
        ],
      }),
    );
  });

  it("rejects step completion events that reference unwritten artifacts", async () => {
    const world = await tempWorld();
    const otherWorldArtifact = await writeArtifact(world, {
      runId: "run_other",
      stepPath: "summarize",
      name: "summary-output",
      payload: { summary: "Other" },
      contentType: "application/json",
    });

    await expect(
      appendEvent(world, "run_missing_artifact", {
        type: "StepCompleted",
        payload: {
          stepPath: "summarize",
          outputRef: "artifact://art_missing",
          artifactRefs: ["artifact://art_missing"],
        },
      }),
    ).rejects.toBeInstanceOf(ArtifactNotFoundError);
    await expect(
      appendEvent(world, "run_missing_artifact", {
        type: "StepCompleted",
        payload: {
          stepPath: "summarize",
          outputRef: otherWorldArtifact.artifactRef,
          artifactRefs: [otherWorldArtifact.artifactRef],
        },
      }),
    ).rejects.toBeInstanceOf(ArtifactNotFoundError);

    const artifact = await writeArtifact(world, {
      runId: "run_missing_artifact",
      stepPath: "summarize",
      name: "summary-output",
      payload: { summary: "Done" },
      contentType: "application/json",
    });

    await expect(
      appendEvent(world, "run_missing_artifact", {
        type: "StepCompleted",
        payload: {
          stepPath: "summarize",
          outputRef: artifact.artifactRef,
          artifactRefs: [artifact.artifactRef],
        },
      }),
    ).resolves.toEqual(expect.objectContaining({ type: "StepCompleted" }));
  });

  it("materializes retries and failed runs without re-reading artifact payloads", async () => {
    const world = await tempWorld();

    await appendEvent(world, "run_retry", { type: "RunStarted", payload: {} });
    await appendEvent(world, "run_retry", {
      type: "StepAttemptStarted",
      payload: { stepPath: "score", attemptId: "attempt_1" },
    });
    await appendEvent(world, "run_retry", {
      type: "StepFailed",
      payload: {
        stepPath: "score",
        error: { code: "timeout", message: "Timed out.", retriable: true },
      },
    });
    await appendEvent(world, "run_retry", {
      type: "StepAttemptStarted",
      payload: { stepPath: "score", attemptId: "attempt_2" },
    });
    await appendEvent(world, "run_retry", {
      type: "StepCompleted",
      payload: { stepPath: "score", output: { score: 42 } },
    });

    const retryState = await materializeRunState(world, "run_retry");
    expect(retryState.steps.score?.status).toBe("completed");
    expect(retryState.steps.score?.error).toBeUndefined();
    expect(retryState.steps.score?.attempts).toEqual([
      expect.objectContaining({ attemptId: "attempt_1", status: "failed" }),
      expect.objectContaining({ attemptId: "attempt_2", status: "completed" }),
    ]);

    await appendEvent(world, "run_failed", { type: "RunStarted", payload: {} });
    await appendEvent(world, "run_failed", {
      type: "StepFailed",
      payload: {
        stepPath: "score",
        error: { code: "fatal", message: "Fatal.", retriable: false },
      },
    });
    await appendEvent(world, "run_failed", {
      type: "RunFailed",
      payload: { error: { code: "fatal", message: "Fatal." } },
    });

    const failedState = await materializeRunState(world, "run_failed");
    expect(failedState.status).toBe("failed");
    expect(failedState.steps.score?.status).toBe("failed");
  });

  it("materializes outputRef-only step artifacts and special step paths safely", async () => {
    const world = await tempWorld();
    const artifact = await writeArtifact(world, {
      runId: "run_output_ref_only",
      stepPath: "__proto__",
      name: "summary-output",
      payload: { summary: "Done" },
      contentType: "application/json",
    });

    await appendEvent(world, "run_output_ref_only", { type: "RunStarted", payload: {} });
    await appendEvent(world, "run_output_ref_only", {
      type: "StepCompleted",
      payload: {
        stepPath: "__proto__",
        outputRef: artifact.artifactRef,
      },
    });

    const state = await materializeRunState(world, "run_output_ref_only");
    expect(state.artifacts).toEqual([artifact.artifactRef]);
    expect(Object.hasOwn(state.steps, "__proto__")).toBe(true);
    expect(state.steps.__proto__).toEqual(
      expect.objectContaining({
        stepPath: "__proto__",
        status: "completed",
        outputRef: artifact.artifactRef,
        artifactRefs: [artifact.artifactRef],
      }),
    );
  });

  it("returns no events for missing runs and rejects missing materialized state", async () => {
    const world = await tempWorld();

    await expect(listEvents(world, "run_missing")).resolves.toEqual([]);
    await expect(materializeRunState(world, "run_missing")).rejects.toBeInstanceOf(
      RunNotFoundError,
    );
  });
});

async function writeFileForTest(path: string, value: string): Promise<void> {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path, value);
}
