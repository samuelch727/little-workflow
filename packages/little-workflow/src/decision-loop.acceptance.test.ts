/**
 * Layer A acceptance — candidate review with loop (Spec §2.8)
 *
 * Three scenarios:
 *   1. Happy path: 3 candidates with different iteration counts (1, 2, 3 loops) — all converge.
 *   2. Kill mid-loop resume: simulate a kill after worker.visit[0] of one candidate by pre-seeding
 *      events (Mode 2), then verify a fresh executeWorkflowVersion completes without re-calling
 *      already-committed steps.
 *   3. max_visits_exceeded: review never passes for one candidate; verify fail_fast produces a
 *      RunFailedError with causeCode "max_visits_exceeded".
 *
 * NOTE: Steps use "tool.call" because this exercises the same loop/visit/decision
 * machinery and tool adapters are simpler to mock inline. The spec §2.8 example uses ai.generate.
 * in a production context; the LWIR structure is identical.
 */

import { mkdtemp } from "node:fs/promises";
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
  validateLwir,
  writeArtifact,
} from "./index.js";
import { cleanupTempDirs, workerScopedTempPrefix } from "./test-temp.js";
import { concreteInputStructure } from "./workflow-version-reuse.js";

// ---------------------------------------------------------------------------
// World helpers
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

async function tempWorld() {
  const dataDir = await mkdtemp(
    join(tmpdir(), workerScopedTempPrefix("lwf-acceptance-", process.env.VITEST_POOL_ID)),
  );
  tempDirs.push(dataDir);
  return localWorld({ dataDir });
}

afterEach(async () => {
  await cleanupTempDirs(tempDirs);
});

// ---------------------------------------------------------------------------
// LWIR definition for the worked example (Spec §2.8)
//
// Parallel over candidates. Each branch: worker → review → route (decision).
// If review passes → route to "end"; otherwise route loops back to "worker".
//
// failureMode defaults to "all_settled" for the happy-path and kill-resume
// tests; the max_visits test uses "fail_fast" (documented below).
// ---------------------------------------------------------------------------

function candidateReviewLwir(overrides: {
  readonly maxVisits?: number;
  readonly failureMode?: "fail_fast" | "all_settled";
} = {}): LwirWorkflow {
  const maxVisits = overrides.maxVisits ?? 5;
  const failureMode = overrides.failureMode ?? "all_settled";
  return {
    apiVersion: "littleworkflow.dev/v0.1",
    kind: "Workflow",
    metadata: { name: `candidate.review.acceptance.${failureMode}.mv${maxVisits}` },
    input: {
      schema: {
        type: "object",
        required: ["candidates"],
        properties: { candidates: { type: "array" } },
      },
    },
    output: { schema: { type: "array" } },
    permissions: { tools: ["worker", "review"] },
    steps: [
      {
        id: "review-cands",
        uses: "parallel",
        with: {
          items: "{{ input.candidates }}",
          cardinality: { kind: "matches_items" },
          itemKey: "{{ item.id }}",
          maxBranches: 5,
          maxConcurrency: 3,
          failureMode,
          fanIn: { order: "input", output: "array", outputStep: "review" },
        },
        steps: [
          {
            id: "worker",
            uses: "tool.call",
            with: { tool: "worker" },
            maxVisits,
            input: { id: "{{ item.id }}" },
            output: { mode: "object", schema: { type: "object" } },
          },
          {
            id: "review",
            uses: "tool.call",
            with: { tool: "review" },
            needs: ["worker"],
            maxVisits,
            input: { id: "{{ item.id }}" },
            output: { mode: "object", schema: { type: "object" } },
          },
          {
            id: "route",
            uses: "decision",
            needs: ["review"],
            maxVisits,
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
}

// ---------------------------------------------------------------------------
// lockedWorkflowVersion helper (private to this file — mirrors parallel.test.ts)
// ---------------------------------------------------------------------------

function propertyValue(value: unknown, key: string): unknown {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    return undefined;
  }
  return Object.hasOwn(value, key) ? (value as Record<string, unknown>)[key] : undefined;
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

// ---------------------------------------------------------------------------
// Scenario 1: Happy path — 3 candidates, iteration counts 1 / 2 / 3
// ---------------------------------------------------------------------------

describe("Layer A acceptance — candidate review with loop", () => {
  it(
    "runs worker → review → route until review passes for each of 3 candidates (1, 2, 3 iterations)",
    async () => {
      const world = await tempWorld();

      // Per-candidate thresholds: review passes on visit number N (1-indexed).
      const thresholds: Record<string, number> = { cand_1: 1, cand_2: 2, cand_3: 3 };
      const reviewCallCounts: Record<string, number> = {};
      const workerCallCounts: Record<string, number> = {};

      const workerTool = vi.fn((input: unknown) => {
        const item = input as { readonly id: string };
        workerCallCounts[item.id] = (workerCallCounts[item.id] ?? 0) + 1;
        return { workerId: item.id, visitCount: workerCallCounts[item.id] };
      });

      const reviewTool = vi.fn((input: unknown) => {
        const item = input as { readonly id: string };
        reviewCallCounts[item.id] = (reviewCallCounts[item.id] ?? 0) + 1;
        const threshold = thresholds[item.id] ?? 1;
        return {
          passed: (reviewCallCounts[item.id] ?? 0) >= threshold,
          reviewId: item.id,
          visitCount: reviewCallCounts[item.id],
        };
      });

      const lwir = candidateReviewLwir();
      const registry = registryFor({ worker: workerTool, review: reviewTool });
      const workflowVersion = lockedWorkflowVersion(lwir, { tools: registry });

      const result = await executeWorkflowVersion({
        world,
        workflowVersion,
        runId: "run_acceptance_happy_path",
        input: {
          candidates: [
            { id: "cand_1" },
            { id: "cand_2" },
            { id: "cand_3" },
          ],
        },
        tools: registryFor({ worker: workerTool, review: reviewTool }),
      });

      expect(result.status).toBe("completed");

      // Total calls: worker(1+2+3=6), review(1+2+3=6).
      expect(workerTool).toHaveBeenCalledTimes(6);
      expect(reviewTool).toHaveBeenCalledTimes(6);

      // Per-candidate visit counts.
      expect(workerCallCounts["cand_1"]).toBe(1);
      expect(workerCallCounts["cand_2"]).toBe(2);
      expect(workerCallCounts["cand_3"]).toBe(3);
      expect(reviewCallCounts["cand_1"]).toBe(1);
      expect(reviewCallCounts["cand_2"]).toBe(2);
      expect(reviewCallCounts["cand_3"]).toBe(3);

      // Fan-in output: array of 3 branch records.
      const output = result.output as unknown[];
      expect(output).toHaveLength(3);

      // fanIn.outputStep: "review" → each branch record's output is review's last output.
      for (const id of ["cand_1", "cand_2", "cand_3"]) {
        const entry = output.find((e) => (e as { itemKey: string }).itemKey === id) as {
          status: string;
          output: { passed: boolean; reviewId: string };
        } | undefined;
        expect(entry).toBeDefined();
        expect(entry?.status).toBe("completed");
        expect(entry?.output.passed).toBe(true);
        expect(entry?.output.reviewId).toBe(id);
      }
    },
    30_000,
  );

  // -------------------------------------------------------------------------
  // Scenario 2: Kill mid-loop resume
  //
  // We simulate a "kill" by pre-seeding completed events for worker.visit[0]
  // of cand_a (using Mode 2 — direct event injection). The runtime should then:
  //   - NOT re-call worker.visit[0] for cand_a (already committed).
  //   - Continue from that point (call review.visit[0] for cand_a).
  //   - Complete the run normally.
  //
  // Review for cand_a: first visit returns passed=false, second returns passed=true.
  // So: worker.visit[0] (pre-seeded) → review.visit[0] → route (loops) →
  //     worker.visit[1] → review.visit[1] (passed=true) → route (end).
  //
  // Assertion: workerTool is called exactly once for cand_a (visit[1] only),
  // because visit[0] was already committed in the pre-seeded events.
  // -------------------------------------------------------------------------

  it(
    "resumes mid-loop: pre-committed worker.visit[0] for cand_a is not re-called on resume",
    async () => {
      const world = await tempWorld();

      const reviewCallCounts: Record<string, number> = {};
      const workerCallsFor: string[] = [];

      const workerTool = vi.fn((input: unknown) => {
        const item = input as { readonly id: string };
        workerCallsFor.push(item.id);
        return { workerId: item.id, live: true };
      });

      const reviewTool = vi.fn((input: unknown) => {
        const item = input as { readonly id: string };
        reviewCallCounts[item.id] = (reviewCallCounts[item.id] ?? 0) + 1;
        // cand_a: pass on 2nd review visit; cand_b: pass on 1st review visit.
        const passOn = item.id === "cand_a" ? 2 : 1;
        return {
          passed: (reviewCallCounts[item.id] ?? 0) >= passOn,
          reviewId: item.id,
        };
      });

      const lwir = candidateReviewLwir();
      const registry = registryFor({ worker: workerTool, review: reviewTool });
      const workflowVersion = lockedWorkflowVersion(lwir, { tools: registry });
      const runId = "run_acceptance_kill_resume";

      // ---- Pre-seed: simulate a "killed" run that completed worker.visit[0] for cand_a ----
      // This mirrors Mode 2: write committed events as if a previous process ran worker.visit[0]
      // for cand_a and was then killed before any further step could execute.

      const preSeedOutput = { workerId: "cand_a", live: false };
      const preSeedArtifact = await writeArtifact(world, {
        runId,
        stepPath: "review-cands[cand_a].worker.visit[0]",
        name: "output",
        payload: preSeedOutput,
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
          input: {
            candidates: [{ id: "cand_a" }, { id: "cand_b" }],
          },
        },
      });

      // Parallel step scheduled and attempt started
      await appendEvent(world, runId, {
        type: "StepScheduled",
        payload: { stepPath: "review-cands", stepId: "review-cands", uses: "parallel" },
      });
      await appendEvent(world, runId, {
        type: "StepAttemptStarted",
        payload: {
          stepPath: "review-cands",
          stepId: "review-cands",
          attempt: 1,
          attemptId: "attempt_1",
        },
      });
      await appendEvent(world, runId, {
        type: "ParallelGroupStarted",
        payload: {
          stepPath: "review-cands",
          stepId: "review-cands",
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
          stepPath: "review-cands",
          branchPath: "review-cands[cand_a]",
          itemKey: "cand_a",
          branchIndex: 0,
        },
      });

      // worker.visit[0] for cand_a: scheduled → attempt started → artifact → validated → completed
      await appendEvent(world, runId, {
        type: "StepScheduled",
        payload: {
          stepPath: "review-cands[cand_a].worker.visit[0]",
          stepId: "worker",
          uses: "tool.call",
        },
      });
      await appendEvent(world, runId, {
        type: "StepAttemptStarted",
        payload: {
          stepPath: "review-cands[cand_a].worker.visit[0]",
          stepId: "worker",
          attempt: 1,
          attemptId: "attempt_1",
        },
      });
      await appendEvent(world, runId, {
        type: "ArtifactCreated",
        payload: {
          stepPath: "review-cands[cand_a].worker.visit[0]",
          artifactRef: preSeedArtifact.artifactRef,
          name: "output",
          contentType: "application/json",
        },
      });
      await appendEvent(world, runId, {
        type: "StepOutputValidated",
        payload: {
          stepPath: "review-cands[cand_a].worker.visit[0]",
          outputRef: preSeedArtifact.artifactRef,
          outputMode: "object",
        },
      });
      await appendEvent(world, runId, {
        type: "StepCompleted",
        payload: {
          stepPath: "review-cands[cand_a].worker.visit[0]",
          stepId: "worker",
          attempt: 1,
          output: preSeedOutput,
          outputRef: preSeedArtifact.artifactRef,
          artifactRefs: [preSeedArtifact.artifactRef],
          metadata: { uses: "tool.call", outputMode: "object" },
        },
      });

      // ---- Resume: executeWorkflowVersion on the same runId with no kill signal ----
      const result = await executeWorkflowVersion({
        world,
        workflowVersion,
        runId,
        input: {
          candidates: [{ id: "cand_a" }, { id: "cand_b" }],
        },
        tools: registryFor({ worker: workerTool, review: reviewTool }),
      });

      expect(result.status).toBe("completed");

      // workerTool must NOT have been called for cand_a.visit[0] (pre-seeded).
      // It SHOULD be called for cand_a.visit[1] (loop iteration 2) and cand_b.visit[0].
      // So total: 1 (cand_a visit[1]) + 1 (cand_b visit[0]) = 2 calls.
      const candACalls = workerCallsFor.filter((id) => id === "cand_a");
      const candBCalls = workerCallsFor.filter((id) => id === "cand_b");
      expect(candACalls).toHaveLength(1); // only visit[1] — visit[0] was pre-seeded
      expect(candBCalls).toHaveLength(1); // visit[0] (passes on first review)

      // cand_a needed 2 review visits; cand_b needed 1.
      expect(reviewCallCounts["cand_a"]).toBe(2);
      expect(reviewCallCounts["cand_b"]).toBe(1);

      // Both branches completed.
      const output = result.output as unknown[];
      expect(output).toHaveLength(2);
      for (const id of ["cand_a", "cand_b"]) {
        const entry = output.find((e) => (e as { itemKey: string }).itemKey === id) as {
          status: string;
          output: { passed: boolean; reviewId: string };
        } | undefined;
        expect(entry?.status).toBe("completed");
        expect(entry?.output.passed).toBe(true);
      }

      // Confirm: worker.visit[0] for cand_a does NOT appear as a new ToolCallStarted event
      // (it was replayed from the persisted StepCompleted, not re-executed).
      const events = await listEvents(world, runId);
      const workerToolCallsForCandA = events.filter(
        (event) =>
          event.type === "ToolCallStarted" &&
          event.payload?.stepPath === "review-cands[cand_a].worker.visit[0]",
      );
      expect(workerToolCallsForCandA).toHaveLength(0);
    },
  );

  // -------------------------------------------------------------------------
  // Scenario 3: max_visits_exceeded
  //
  // Review always returns passed=false for cand_x. With maxVisits=3 and
  // failureMode="fail_fast", the run must fail with a RunFailedError whose
  // causeCode is "max_visits_exceeded".
  //
  // "fail_fast" is used here because it produces the cleanest assertion:
  // the entire run fails immediately when the first branch exhausts its visits,
  // surfaced as a RunFailedError from executeWorkflowVersion. With "all_settled"
  // the run would complete but the branch record would carry the failure — a
  // valid alternative, but "fail_fast" gives a crisper test boundary.
  // -------------------------------------------------------------------------

  it(
    "fails with max_visits_exceeded when review never passes (fail_fast)",
    async () => {
      const world = await tempWorld();

      const workerTool = vi.fn((input: unknown) => {
        const item = input as { readonly id: string };
        return { workerId: item.id };
      });

      const reviewTool = vi.fn((_input: unknown) => {
        // Always fails: passed=false so the loop never exits.
        return { passed: false, feedback: "not ready" };
      });

      // maxVisits=3 so the cap is reached after 3 worker/review cycles.
      const lwir = candidateReviewLwir({ maxVisits: 3, failureMode: "fail_fast" });
      const registry = registryFor({ worker: workerTool, review: reviewTool });
      const workflowVersion = lockedWorkflowVersion(lwir, { tools: registry });

      const result = await executeWorkflowVersion({
        world,
        workflowVersion,
        runId: "run_acceptance_max_visits",
        input: {
          candidates: [{ id: "cand_x" }],
        },
        tools: registryFor({ worker: workerTool, review: reviewTool }),
      });

      expect(result.status).toBe("failed");
      if (result.status !== "failed") {
        throw new Error("Expected run to fail with max_visits_exceeded.");
      }

      // The run-level error must carry causeCode "max_visits_exceeded".
      expect(result.error).toEqual(
        expect.objectContaining({ causeCode: "max_visits_exceeded" }),
      );

      // Worker and review each ran exactly maxVisits (3) times before the cap was hit.
      expect(workerTool).toHaveBeenCalledTimes(3);
      expect(reviewTool).toHaveBeenCalledTimes(3);

      // Event log must contain a RunFailed event with max_visits_exceeded.
      const events = await listEvents(world, "run_acceptance_max_visits");
      expect(events.some((event) => event.type === "RunFailed")).toBe(true);
      const runFailed = events.find((event) => event.type === "RunFailed");
      expect(runFailed?.payload?.error).toEqual(
        expect.objectContaining({ causeCode: "max_visits_exceeded" }),
      );
    },
  );
});

// ---------------------------------------------------------------------------
// FU4 — Multi-fix acceptance: P1.1 + P1.2 + P1.4 + P2.6 combined scenario
//
// A single parallel branch exercising four fixes together:
//
//   P1.2: Branch steps array has review BEFORE route in the LWIR definition.
//         The runtime must not schedule review before route routes to it
//         (decision target exclusion from needs-based scheduler).
//
//   P2.6: Worker reads {{ steps.review.lastOutput.note }} in its input
//         without declaring review in needs. The validator must accept this
//         back-edge reference (review can reach worker via review→route→worker).
//
//   P1.4: A top-level non-parallel step "prep" is pre-injected as in-flight
//         (StepScheduled + StepAttemptStarted, no terminal event). On resume the
//         runtime reuses the same attemptId (isResumableRunningAttempt returns true
//         for top-level non-parallel steps after the P1.4 fix). Before the fix,
//         isResumableRunningAttempt gated on (parallel || branchPath !== undefined),
//         so this would throw RuntimeIntegrityError("non-terminal attempt").
//
//   P1.1: After resume from route.visit[0] (chosen="worker"), the branch must
//         re-add the transitive downstream (review, route) to remaining so the
//         second loop iteration runs to completion.
//
// Workflow structure: prep (in-flight top-level) → run-branch (parallel).
// Branch steps array order: [review, route, worker] — inverted from execution order.
// ---------------------------------------------------------------------------

describe("FU4 — multi-fix acceptance: P1.1 + P1.2 + P1.4 + P2.6", () => {
  it(
    "prep in-flight resume + parallel branch with review-before-route array order, back-edge ref, and transitive re-add",
    async () => {
      const world = await tempWorld();

      // Fan-in envelope schema for branch output and workflow output.
      const fanInItemSchema = {
        type: "object",
        required: ["itemKey", "status", "output", "outputRef", "artifacts"],
        properties: {
          itemKey: { type: "string" },
          status: { type: "string" },
          output: { type: "object" },
          outputRef: { type: "string" },
          artifacts: { type: "array", items: { type: "string" } },
        },
      };

      // LWIR:
      // Top-level steps: prep → run-branch (parallel).
      // prep (tool): in-flight on resume — exercises P1.4.
      // run-branch: deliberate steps array order [review, route, worker].
      //   - worker has needs:[] (back-edge entry), reads steps.review.lastOutput.note (P2.6).
      //   - review has needs:[worker], comes first in array (P1.2).
      //   - route is decision, needs:[review], routes back to worker or "end".
      const lwir: LwirWorkflow = {
        apiVersion: "littleworkflow.dev/v0.1",
        kind: "Workflow",
        metadata: { name: "fu4-multi-fix-acceptance" },
        input: {
          schema: {
            type: "object",
            required: ["items"],
            properties: { items: { type: "array" } },
          },
        },
        output: {
          schema: { type: "array", items: fanInItemSchema },
        },
        permissions: { tools: ["prep", "worker", "review"] },
        steps: [
          // prep: top-level tool step — will be pre-seeded as in-flight.
          // P1.4: on resume, the runtime must reuse the in-flight attempt (same attemptId)
          // and NOT throw RuntimeIntegrityError("non-terminal attempt").
          {
            id: "prep",
            uses: "tool.call",
            with: { tool: "prep" },
            output: { mode: "object", schema: { type: "object" } },
          },
          {
            id: "run-branch",
            uses: "parallel",
            needs: ["prep"],
            with: {
              items: "{{ input.items }}",
              cardinality: { kind: "matches_items" },
              itemKey: "{{ item.id }}",
              maxBranches: 5,
              maxConcurrency: 3,
              failureMode: "all_settled",
              fanIn: { order: "input", output: "array", outputStep: "review" },
            },
            // Deliberate array order: review, route, worker — inverted from execution order.
            // P1.2: review must not be scheduled by needs-based scheduler before route fires.
            steps: [
              {
                id: "review",
                uses: "tool.call",
                with: { tool: "review" },
                needs: ["worker"],
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
              {
                id: "worker",
                uses: "tool.call",
                with: { tool: "worker" },
                // No needs — back-edge entry point.
                maxVisits: 2,
                // P2.6: reads steps.review.lastOutput.note without declaring review in needs.
                input: {
                  id: "{{ item.id }}",
                  priorNote: "{{ steps.review.lastOutput.note }}",
                },
                output: { mode: "object", schema: { type: "object" } },
              },
            ],
            output: {
              mode: "array",
              schema: { type: "array", items: fanInItemSchema },
            },
          },
        ],
      };

      // P2.6 validation: the validator must accept worker's back-edge lastOutput reference
      // without emitting step.undeclared_dependency for the worker→review relationship.
      const validation = validateLwir(lwir);
      expect(
        validation.findings.some(
          (f) =>
            f.code === "step.undeclared_dependency" &&
            f.message.includes("worker") &&
            f.message.includes("review"),
        ),
      ).toBe(false);
      expect(validation.valid).toBe(true);

      // Track what the live tools actually receive.
      const workerInputs: Array<{ id: string; priorNote?: unknown }> = [];
      const reviewCallCounts: Record<string, number> = {};

      // P1.4: prep is a top-level non-parallel tool step pre-seeded as in-flight.
      // Before the P1.4 fix, isResumableRunningAttempt gated on (parallel || branchPath !== undefined),
      // causing a RuntimeIntegrityError("non-terminal attempt") for top-level non-parallel in-flight steps.
      const prepTool = vi.fn(() => ({ ready: true }));

      // Worker captures its input (proves P2.6 back-edge ref resolves correctly at runtime).
      const workerTool = vi.fn((input: unknown) => {
        const item = input as { readonly id: string; readonly priorNote?: unknown };
        workerInputs.push({ id: item.id, priorNote: item.priorNote });
        return { workerId: item.id, live: true };
      });

      // review.visit[0] was pre-committed (passed=false). The live tool only runs once (visit[1]).
      // The first live call must return passed=true so the route closes the loop with "end".
      const reviewTool = vi.fn((input: unknown) => {
        const item = input as { readonly id: string };
        reviewCallCounts[item.id] = (reviewCallCounts[item.id] ?? 0) + 1;
        const visitNum = reviewCallCounts[item.id] ?? 0;
        return {
          passed: true, // always pass on the live call (first overall = visit[1])
          note: `feedback-visit-${visitNum}`,
          reviewId: item.id,
        };
      });

      const registry = registryFor({ prep: prepTool, worker: workerTool, review: reviewTool });
      const workflowVersion = lockedWorkflowVersion(lwir, { tools: registry });
      const runId = "run_fu4_multi_fix_acceptance";

      // ---- Pre-seed: simulate crash state ----
      //
      // Top-level: prep is IN-FLIGHT (StepScheduled + StepAttemptStarted, no terminal event).
      //   → exercises P1.4: runtime must resume the same attempt (not throw "non-terminal attempt").
      //
      // Branch (cand_a): worker.visit[0] + review.visit[0] (passed=false) + route.visit[0]
      //   (chosen="worker") are all committed. Crash happened right after route.visit[0].
      //   → exercises P1.1: forcedNextStepId="worker" must re-add {review, route} to remaining
      //     so the second loop iteration runs to completion.

      const workerV0Output = { workerId: "cand_a", live: false };
      const workerV0Artifact = await writeArtifact(world, {
        runId,
        stepPath: "run-branch[cand_a].worker.visit[0]",
        name: "output",
        payload: workerV0Output,
        contentType: "application/json",
      });

      const reviewV0Output = { passed: false, note: "feedback-visit-0", reviewId: "cand_a" };
      const reviewV0Artifact = await writeArtifact(world, {
        runId,
        stepPath: "run-branch[cand_a].review.visit[0]",
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
          input: { items: [{ id: "cand_a" }] },
        },
      });

      // prep — top-level tool step, IN-FLIGHT (P1.4): scheduled + attempt started, no terminal event.
      // Crash happened right after StepAttemptStarted for prep. The runtime must resume this
      // attempt (same attemptId) instead of throwing RuntimeIntegrityError("non-terminal attempt").
      await appendEvent(world, runId, {
        type: "StepScheduled",
        payload: { stepPath: "prep", stepId: "prep", uses: "tool.call" },
      });
      await appendEvent(world, runId, {
        type: "StepAttemptStarted",
        payload: {
          stepPath: "prep",
          stepId: "prep",
          attempt: 1,
          attemptId: "attempt_1",
        },
      });

      // Parallel step
      await appendEvent(world, runId, {
        type: "StepScheduled",
        payload: { stepPath: "run-branch", stepId: "run-branch", uses: "parallel" },
      });
      await appendEvent(world, runId, {
        type: "StepAttemptStarted",
        payload: {
          stepPath: "run-branch",
          stepId: "run-branch",
          attempt: 1,
          attemptId: "attempt_1",
        },
      });
      await appendEvent(world, runId, {
        type: "ParallelGroupStarted",
        payload: {
          stepPath: "run-branch",
          stepId: "run-branch",
          attempt: 1,
          branchCount: 1,
          maxConcurrency: 3,
          failureMode: "all_settled",
        },
      });

      // Branch cand_a scheduled
      await appendEvent(world, runId, {
        type: "ParallelBranchScheduled",
        payload: {
          stepPath: "run-branch",
          branchPath: "run-branch[cand_a]",
          itemKey: "cand_a",
          branchIndex: 0,
        },
      });

      // worker.visit[0] — completed (pre-committed)
      await appendEvent(world, runId, {
        type: "StepScheduled",
        payload: {
          stepPath: "run-branch[cand_a].worker.visit[0]",
          stepId: "worker",
          uses: "tool.call",
        },
      });
      await appendEvent(world, runId, {
        type: "StepAttemptStarted",
        payload: {
          stepPath: "run-branch[cand_a].worker.visit[0]",
          stepId: "worker",
          attempt: 1,
          attemptId: "attempt_1",
        },
      });
      await appendEvent(world, runId, {
        type: "ArtifactCreated",
        payload: {
          stepPath: "run-branch[cand_a].worker.visit[0]",
          artifactRef: workerV0Artifact.artifactRef,
          name: "output",
          contentType: "application/json",
        },
      });
      await appendEvent(world, runId, {
        type: "StepOutputValidated",
        payload: {
          stepPath: "run-branch[cand_a].worker.visit[0]",
          outputRef: workerV0Artifact.artifactRef,
          outputMode: "object",
        },
      });
      await appendEvent(world, runId, {
        type: "StepCompleted",
        payload: {
          stepPath: "run-branch[cand_a].worker.visit[0]",
          stepId: "worker",
          attempt: 1,
          output: workerV0Output,
          outputRef: workerV0Artifact.artifactRef,
          artifactRefs: [workerV0Artifact.artifactRef],
          metadata: { uses: "tool.call", outputMode: "object" },
        },
      });

      // review.visit[0] — completed, passed=false (triggers loop back to worker)
      await appendEvent(world, runId, {
        type: "StepScheduled",
        payload: {
          stepPath: "run-branch[cand_a].review.visit[0]",
          stepId: "review",
          uses: "tool.call",
        },
      });
      await appendEvent(world, runId, {
        type: "StepAttemptStarted",
        payload: {
          stepPath: "run-branch[cand_a].review.visit[0]",
          stepId: "review",
          attempt: 1,
          attemptId: "attempt_1",
        },
      });
      await appendEvent(world, runId, {
        type: "ArtifactCreated",
        payload: {
          stepPath: "run-branch[cand_a].review.visit[0]",
          artifactRef: reviewV0Artifact.artifactRef,
          name: "output",
          contentType: "application/json",
        },
      });
      await appendEvent(world, runId, {
        type: "StepOutputValidated",
        payload: {
          stepPath: "run-branch[cand_a].review.visit[0]",
          outputRef: reviewV0Artifact.artifactRef,
          outputMode: "object",
        },
      });
      await appendEvent(world, runId, {
        type: "StepCompleted",
        payload: {
          stepPath: "run-branch[cand_a].review.visit[0]",
          stepId: "review",
          attempt: 1,
          output: reviewV0Output,
          outputRef: reviewV0Artifact.artifactRef,
          artifactRefs: [reviewV0Artifact.artifactRef],
          metadata: { uses: "tool.call", outputMode: "object" },
        },
      });

      // route.visit[0] — decision, chosen="worker" (review didn't pass).
      // Crash happens right after this event. No further events are written.
      await appendEvent(world, runId, {
        type: "StepScheduled",
        payload: {
          stepPath: "run-branch[cand_a].route.visit[0]",
          stepId: "route",
          uses: "decision",
        },
      });
      await appendEvent(world, runId, {
        type: "StepAttemptStarted",
        payload: {
          stepPath: "run-branch[cand_a].route.visit[0]",
          stepId: "route",
          attempt: 1,
          attemptId: "attempt_1",
        },
      });
      await appendEvent(world, runId, {
        type: "StepCompleted",
        payload: {
          stepPath: "run-branch[cand_a].route.visit[0]",
          stepId: "route",
          attempt: 1,
          output: { chosen: "worker" },
          metadata: { uses: "decision" },
        },
      });

      // ---- Resume ----
      const result = await executeWorkflowVersion({
        world,
        workflowVersion,
        runId,
        input: { items: [{ id: "cand_a" }] },
        tools: registryFor({ prep: prepTool, worker: workerTool, review: reviewTool }),
      });

      expect(result.status).toBe("completed");

      // ---- P1.4: prep (top-level non-parallel in-flight step) was resumed, not re-attempted ----
      // Before the P1.4 fix, isResumableRunningAttempt gated on (parallel || branchPath !== undefined).
      // A top-level tool step like prep would throw RuntimeIntegrityError("non-terminal attempt") on resume.
      // With the fix: the check passes → prep is re-executed under the same attemptId, exactly once.
      const events = await listEvents(world, runId);
      const prepAttemptStarted = events.filter(
        (event) =>
          event.type === "StepAttemptStarted" &&
          event.payload?.stepPath === "prep",
      );
      // Only one StepAttemptStarted for prep — the pre-seeded one. Resume does NOT emit a second one.
      expect(prepAttemptStarted).toHaveLength(1);
      expect(prepAttemptStarted[0]!.payload.attemptId).toBe("attempt_1");
      // prepTool was called exactly once (on resume execution).
      expect(prepTool).toHaveBeenCalledTimes(1);

      // ---- P1.1: review.visit[1] was executed (transitive re-add after worker.visit[1]) ----
      // Without the fix, remaining would be empty after worker.visit[1] and the loop would
      // terminate with stale review.visit[0] output (passed=false).
      const reviewV1Completed = events.filter(
        (event) =>
          event.type === "StepCompleted" &&
          event.payload?.stepPath === "run-branch[cand_a].review.visit[1]",
      );
      expect(reviewV1Completed).toHaveLength(1);

      // route.visit[1] must also have run (chose "end" after review.visit[1] passed).
      const routeV1Completed = events.filter(
        (event) =>
          event.type === "StepCompleted" &&
          event.payload?.stepPath === "run-branch[cand_a].route.visit[1]",
      );
      expect(routeV1Completed).toHaveLength(1);
      expect((routeV1Completed[0]!.payload.output as { chosen?: string } | undefined)?.chosen).toBe("end");

      // ---- P2.6: worker.visit[1] received the back-edge lastOutput.note from review.visit[0] ----
      // The live worker tool was called exactly once (visit[1]; visit[0] was pre-committed).
      // Without P2.6 fix, validateLwir would have blocked this LWIR from compiling due to
      // step.undeclared_dependency on steps.review.lastOutput.note in worker.
      expect(workerTool).toHaveBeenCalledTimes(1);
      const workerV1Input = workerInputs.find((inp) => inp.id === "cand_a");
      expect(workerV1Input).toBeDefined();
      // On visit[1], review.visit[0] committed note="feedback-visit-0" (the pre-seeded value).
      expect(workerV1Input?.priorNote).toBe("feedback-visit-0");

      // review.visit[1] returns passed=true — final output reflects the latest iteration.
      expect(reviewTool).toHaveBeenCalledTimes(1); // only visit[1]; visit[0] was pre-committed

      // ---- Final output reflects latest loop iteration ----
      const output = result.output as Array<{
        itemKey: string;
        status: string;
        output: { passed: boolean; reviewId: string; note: string };
      }>;
      expect(output).toHaveLength(1);
      const entryA = output.find((e) => e.itemKey === "cand_a");
      expect(entryA?.status).toBe("completed");
      // fanIn.outputStep: "review" → branch output is review's last output.
      // review.visit[1] returned passed=true (2nd visit).
      expect(entryA?.output.passed).toBe(true);
      expect(entryA?.output.reviewId).toBe("cand_a");
    },
    // Generous timeout for a deterministic 2-iteration loop with pre-seeding.
    10_000,
  );
});
