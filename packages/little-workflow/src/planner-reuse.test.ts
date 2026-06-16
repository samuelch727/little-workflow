import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { localWorld } from "./authoring.js";
import { canonicalJson, sha256Digest } from "./canonical.js";
import {
  buildReuseBrief,
  selectPlannerReuseCandidates,
  validatePlannerReuseDecision,
  type PlannerReuseCandidate,
} from "./planner-reuse.js";
import { appendEvent } from "./world.js";
import { registerStoredWorkflowVersion, type StoredWorkflowVersion } from "./workflow-version-store.js";

const tempDirs: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("planner reuse candidate selection", () => {
  it("selects same-workflow completed candidates most recent first and keeps only the newest run per WorkflowVersion", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const world = await tempWorld();
    const firstVersion = storedWorkflowVersion("wfver_candidate_first", "first");
    const secondVersion = storedWorkflowVersion("wfver_candidate_second", "second");
    await registerStoredWorkflowVersion(world, firstVersion);
    await registerStoredWorkflowVersion(world, secondVersion);

    await appendCompletedRun(world, {
      runId: "run_candidate_old_first",
      workflowId: "support.triage",
      workflowVersionId: firstVersion.id,
      completedAt: "2026-05-20T10:00:00.000Z",
    });
    await appendCompletedRun(world, {
      runId: "run_candidate_new_second",
      workflowId: "support.triage",
      workflowVersionId: secondVersion.id,
      completedAt: "2026-05-21T10:00:00.000Z",
    });
    await appendCompletedRun(world, {
      runId: "run_candidate_new_first",
      workflowId: "support.triage",
      workflowVersionId: firstVersion.id,
      completedAt: "2026-05-22T10:00:00.000Z",
    });
    await appendCompletedRun(world, {
      runId: "run_candidate_other_workflow",
      workflowId: "billing.triage",
      workflowVersionId: secondVersion.id,
      completedAt: "2026-05-23T10:00:00.000Z",
    });

    const candidates = await selectPlannerReuseCandidates(world, {
      workflowId: "support.triage",
      limit: 1,
    });

    expect(candidates).toMatchObject([
      {
        workflowVersionId: firstVersion.id,
        runId: "run_candidate_new_first",
        workflowId: "support.triage",
        completedAt: "2026-05-22T10:00:00.000Z",
        planningDefinitionSnapshot: firstVersion.lock?.planningDefinitionSnapshot,
        planningDefinitionSnapshotHash: firstVersion.lock?.planningDefinitionSnapshotHash,
      },
    ]);
  });

  it("excludes failed-only and incomplete runs", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const world = await tempWorld();
    const version = storedWorkflowVersion("wfver_candidate_terminal", "terminal");
    await registerStoredWorkflowVersion(world, version);

    await appendRequestedAndRegistered(world, {
      runId: "run_candidate_incomplete",
      workflowId: "support.triage",
      workflowVersionId: version.id,
      recordedAt: "2026-05-22T10:00:00.000Z",
    });
    await appendRequestedAndRegistered(world, {
      runId: "run_candidate_failed",
      workflowId: "support.triage",
      workflowVersionId: version.id,
      recordedAt: "2026-05-22T11:00:00.000Z",
    });
    await appendAt("2026-05-22T11:05:00.000Z", () =>
      appendEvent(world, "run_candidate_failed", {
        type: "RunFailed",
        payload: { workflowVersionId: version.id, error: { message: "nope" } },
      })
    );

    await expect(selectPlannerReuseCandidates(world, { workflowId: "support.triage" }))
      .resolves.toEqual([]);
  });

  it("ignores candidates whose stored WorkflowVersion is missing or unreadable", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const world = await tempWorld();
    const readableVersion = storedWorkflowVersion("wfver_candidate_readable", "readable");
    await registerStoredWorkflowVersion(world, readableVersion);

    await appendCompletedRun(world, {
      runId: "run_candidate_missing_version",
      workflowId: "support.triage",
      workflowVersionId: "wfver_candidate_missing",
      completedAt: "2026-05-22T10:00:00.000Z",
    });
    await mkdir(join(world.dataDir, "workflow-versions"), { recursive: true });
    await writeFile(
      join(world.dataDir, "workflow-versions", "wfver_candidate_unreadable.json"),
      "{not-json",
      "utf8",
    );
    await appendCompletedRun(world, {
      runId: "run_candidate_unreadable_version",
      workflowId: "support.triage",
      workflowVersionId: "wfver_candidate_unreadable",
      completedAt: "2026-05-22T09:30:00.000Z",
    });
    await appendCompletedRun(world, {
      runId: "run_candidate_readable_version",
      workflowId: "support.triage",
      workflowVersionId: readableVersion.id,
      completedAt: "2026-05-22T09:00:00.000Z",
    });

    await expect(selectPlannerReuseCandidates(world, { workflowId: "support.triage" }))
      .resolves.toMatchObject([
        {
          workflowVersionId: readableVersion.id,
          runId: "run_candidate_readable_version",
        },
      ]);
  });

  it("ignores candidates whose stored WorkflowVersion is parseable but partial", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const world = await tempWorld();
    const readableVersion = storedWorkflowVersion("wfver_candidate_full", "full");
    await registerStoredWorkflowVersion(world, readableVersion);
    await mkdir(join(world.dataDir, "workflow-versions"), { recursive: true });
    await writeFile(
      join(world.dataDir, "workflow-versions", "wfver_candidate_partial.json"),
      `${canonicalJson({ id: "wfver_candidate_partial", lwir: {} })}\n`,
      "utf8",
    );

    await appendCompletedRun(world, {
      runId: "run_candidate_partial_version",
      workflowId: "support.triage",
      workflowVersionId: "wfver_candidate_partial",
      completedAt: "2026-05-23T10:00:00.000Z",
    });
    await appendCompletedRun(world, {
      runId: "run_candidate_full_version",
      workflowId: "support.triage",
      workflowVersionId: readableVersion.id,
      completedAt: "2026-05-22T10:00:00.000Z",
    });

    await expect(selectPlannerReuseCandidates(world, { workflowId: "support.triage" }))
      .resolves.toMatchObject([
        {
          workflowVersionId: readableVersion.id,
          runId: "run_candidate_full_version",
        },
      ]);
  });

  it("ignores readable base WorkflowVersions without a runtime lock", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const world = await tempWorld();
    const unlockedVersion = unlockedStoredWorkflowVersion("wfver_candidate_unlocked", "unlocked");
    const lockedVersion = storedWorkflowVersion("wfver_candidate_locked", "locked");
    await registerStoredWorkflowVersion(world, unlockedVersion);
    await registerStoredWorkflowVersion(world, lockedVersion);

    await appendCompletedRun(world, {
      runId: "run_candidate_unlocked_version",
      workflowId: "support.triage",
      workflowVersionId: unlockedVersion.id,
      completedAt: "2026-05-23T10:00:00.000Z",
    });
    await appendCompletedRun(world, {
      runId: "run_candidate_locked_version",
      workflowId: "support.triage",
      workflowVersionId: lockedVersion.id,
      completedAt: "2026-05-22T10:00:00.000Z",
    });

    await expect(selectPlannerReuseCandidates(world, { workflowId: "support.triage" }))
      .resolves.toMatchObject([
        {
          workflowVersionId: lockedVersion.id,
          runId: "run_candidate_locked_version",
        },
      ]);
  });
});

describe("planner reuse briefs", () => {
  it("includes the candidate id, Mermaid step graph, mounted paths, warnings, and a stable hash", () => {
    const version = storedWorkflowVersion("wfver_candidate_brief", "brief");
    const priorPlanningDefinitionSnapshot = {
      id: "support.triage",
      description: "Plan brief v1",
      inputSchema: { hash: "sha256:prior-input", summary: { kind: "boolean", value: true } },
      suggestedInputSchema: { descriptor: true, hash: "sha256:prior-suggested-input" },
      requestedOutputHash: "sha256:prior-output",
      modelSlots: [{ id: "model.old", providerId: "test", modelId: "old", description: "" }],
      plannerConfig: {
        modelSlotId: "planner.old",
        modelIdentity: { id: "planner.old", providerId: "test", modelId: "old", description: "" },
        harnessId: "oldHarness",
        systemHash: "sha256:old-system",
        skillsHash: "sha256:old-skills",
      },
      plannerVisibleTools: [
        { name: "summarize", registered: true, descriptionHash: "sha256:old-tool" },
      ],
      plannerVisibleToolsHash: "sha256:old-tools",
      toolSelection: "planner_selected",
    };
    const candidate = {
      ...plannerReuseCandidate(version, {
        runId: "run_candidate_brief",
        workflowId: "support.triage",
        completedAt: "2026-05-22T10:00:00.000Z",
      }),
      planningDefinitionSnapshot: priorPlanningDefinitionSnapshot,
    } satisfies PlannerReuseCandidate;

    const brief = buildReuseBrief({
      candidate,
      currentPlanningDefinitionSnapshot: {
        id: "support.triage",
        description: "Plan brief v2",
        inputSchema: { hash: "sha256:current-input", summary: { kind: "boolean", value: true } },
        suggestedInputSchema: { descriptor: true, hash: "sha256:current-suggested-input" },
        requestedOutputHash: "sha256:current-output",
        modelSlots: [{ id: "model.new", providerId: "test", modelId: "new", description: "" }],
        plannerConfig: {
          modelSlotId: "planner.new",
          modelIdentity: { id: "planner.new", providerId: "test", modelId: "new", description: "" },
          harnessId: "newHarness",
          systemHash: "sha256:new-system",
          skillsHash: "sha256:new-skills",
        },
        plannerVisibleTools: [
          { name: "summarize", registered: true, descriptionHash: "sha256:new-tool" },
        ],
        plannerVisibleToolsHash: "sha256:new-tools",
        toolSelection: "explicit_only",
      },
      mountedRoot: "/planner/reuse",
    });

    expect(brief.text).toContain("Candidate WorkflowVersion: wfver_candidate_brief");
    expect(brief.text).toContain("Workflow ID: support.triage");
    expect(brief.text).toContain("Run ID: run_candidate_brief");
    expect(brief.text).toContain("```mermaid");
    expect(brief.text).toContain("summarize");
    expect(brief.text).toContain("/planner/reuse/wfver_candidate_brief/lwir.json");
    expect(brief.text).toContain("/planner/reuse/wfver_candidate_brief/lock.json");
    expect(brief.text).toContain("/planner/reuse/wfver_candidate_brief/planning-definition-snapshot.json");
    expect(brief.text).toContain("/planner/reuse/wfver_candidate_brief/prior-input-summary.md");
    expect(brief.text).toContain("/planner/reuse/wfver_candidate_brief/prior-output-summary.md");
    expect(brief.text).toContain("/planner/reuse/wfver_candidate_brief/feedback-summary.md");
    expect(brief.text).toContain("requested output hash changed");
    expect(brief.warnings).toEqual([
      "description changed",
      "input schema hash changed",
      "suggested input hash changed",
      "requested output hash changed",
      "planner model changed",
      "planner harness changed",
      "planner system changed",
      "planner skills changed",
      "model slots changed",
      "planner-visible tools changed",
      "tool selection changed",
    ]);
    expect(brief.briefHash).toBe(sha256Digest(brief.text));
  });

  it("warns instead of throwing when prior planning snapshots omit newer fields", () => {
    const version = storedWorkflowVersion("wfver_candidate_legacy_brief", "legacy-brief");
    const candidate = {
      ...plannerReuseCandidate(version, {
        runId: "run_candidate_legacy_brief",
        workflowId: "support.triage",
        completedAt: "2026-05-22T10:00:00.000Z",
      }),
      planningDefinitionSnapshot: {
        id: "support.triage",
        description: "Plan brief v1",
        requestedOutputHash: "sha256:prior-output",
      },
    } satisfies PlannerReuseCandidate;

    const brief = buildReuseBrief({
      candidate,
      currentPlanningDefinitionSnapshot: {
        id: "support.triage",
        description: "Plan brief v1",
        requestedOutputHash: "sha256:prior-output",
        modelSlots: [{ id: "model.new", providerId: "test", modelId: "new", description: "" }],
        plannerConfig: {
          modelSlotId: "planner.new",
          modelIdentity: { id: "planner.new", providerId: "test", modelId: "new", description: "" },
          harnessId: "newHarness",
          systemHash: "sha256:new-system",
          skillsHash: "sha256:new-skills",
        },
        plannerVisibleToolsHash: "sha256:new-tools",
        toolSelection: "planner_selected",
      },
      mountedRoot: "/planner/reuse",
    });

    expect(brief.warnings).toEqual([
      "planner model changed",
      "planner harness changed",
      "planner system changed",
      "planner skills changed",
      "model slots changed",
      "planner-visible tools changed",
      "tool selection changed",
    ]);
  });
});

describe("planner reuse decision validation", () => {
  it("requires reuse_unchanged decisions to acknowledge every warning", () => {
    const candidate = plannerReuseCandidate(
      storedWorkflowVersion("wfver_candidate_warning", "warning"),
    );

    expect(() =>
      validatePlannerReuseDecision(
        {
          kind: "reuse_unchanged",
          workflowVersionId: candidate.workflowVersionId,
          rationale: "The prior plan still matches.",
        },
        {
          candidates: [candidate],
          warnings: ["requested output hash changed"],
        },
      )
    ).toThrow(/reuse_unchanged must acknowledge candidate warnings/u);

    expect(validatePlannerReuseDecision(
      {
        kind: "reuse_unchanged",
        workflowVersionId: candidate.workflowVersionId,
        rationale: "The warning is acceptable for this run.",
        acknowledgedWarnings: ["requested output hash changed"],
      },
      {
        candidates: [candidate],
        warnings: ["requested output hash changed"],
      },
    )).toMatchObject({ kind: "reuse_unchanged" });
  });

  it("blocks reuse_unchanged on output contract changes but allows adapt with full LWIR", () => {
    const candidate = plannerReuseCandidate(
      storedWorkflowVersion("wfver_candidate_block", "block"),
    );
    const lwir = validLwir("adapted");

    expect(() =>
      validatePlannerReuseDecision(
        {
          kind: "reuse_unchanged",
          workflowVersionId: candidate.workflowVersionId,
          rationale: "Reuse anyway.",
          acknowledgedWarnings: ["requested output hash changed"],
        },
        {
          candidates: [candidate],
          warnings: ["requested output hash changed"],
          blocks: ["requested output contract changed"],
        },
      )
    ).toThrow(/reuse_unchanged is blocked/u);

    expect(validatePlannerReuseDecision(
      {
        kind: "adapt",
        baseWorkflowVersionId: candidate.workflowVersionId,
        rationale: "Adapt from the known good plan.",
        lwir,
      },
      {
        candidates: [candidate],
        blocks: ["requested output contract changed"],
      },
    )).toEqual({
      kind: "adapt",
      baseWorkflowVersionId: candidate.workflowVersionId,
      rationale: "Adapt from the known good plan.",
      lwir,
    });
  });

  it("rejects malformed decisions, empty rationales, missing LWIR, and missing candidates", () => {
    const candidate = plannerReuseCandidate(
      storedWorkflowVersion("wfver_candidate_validation", "validation"),
    );

    expect(() => validatePlannerReuseDecision({ kind: "surprise" }, { candidates: [candidate] }))
      .toThrow(/Malformed planner reuse decision/u);
    expect(() =>
      validatePlannerReuseDecision(
        { kind: "draft_fresh", rationale: " ", lwir: {} },
        { candidates: [candidate] },
      )
    ).toThrow(/rationale/u);
    expect(() =>
      validatePlannerReuseDecision(
        {
          kind: "adapt",
          baseWorkflowVersionId: candidate.workflowVersionId,
          rationale: "Adapt without the draft.",
        },
        { candidates: [candidate] },
      )
    ).toThrow(/lwir/u);
    expect(() =>
      validatePlannerReuseDecision(
        {
          kind: "adapt",
          baseWorkflowVersionId: "wfver_missing",
          rationale: "Adapt from an unknown plan.",
          lwir: {},
        },
        { candidates: [candidate] },
      )
    ).toThrow(/candidate/u);
  });

  it("rejects adapt and draft_fresh decisions with invalid LWIR", () => {
    const candidate = plannerReuseCandidate(
      storedWorkflowVersion("wfver_candidate_invalid_lwir", "invalid-lwir"),
    );

    expect(() =>
      validatePlannerReuseDecision(
        {
          kind: "adapt",
          baseWorkflowVersionId: candidate.workflowVersionId,
          rationale: "Adapt from the prior plan.",
          lwir: { kind: "Workflow", steps: [] },
        },
        { candidates: [candidate] },
      )
    ).toThrow(/Invalid planner reuse decision LWIR/u);

    expect(() =>
      validatePlannerReuseDecision(
        {
          kind: "draft_fresh",
          rationale: "Start over with a fresh plan.",
          lwir: { kind: "Workflow", steps: [] },
        },
        { candidates: [candidate] },
      )
    ).toThrow(/Invalid planner reuse decision LWIR/u);
  });
});

async function tempWorld() {
  const dataDir = await mkdtemp(join(tmpdir(), "little-workflow-planner-reuse-"));
  tempDirs.push(dataDir);
  return localWorld({ dataDir });
}

function storedWorkflowVersion(id: string, name: string): StoredWorkflowVersion {
  const lwir = validLwir(name);
  const canonical = canonicalJson(lwir);
  const lwirHash = sha256Digest(lwir);
  const planningDefinitionSnapshot = {
    workflow: {
      id: name,
      description: `Plan ${name}`,
      suggestedInput: { description: `Suggested ${name}` },
      requestedOutput: { description: `Output ${name}` },
    },
  };
  const planningDefinitionSnapshotHash = sha256Digest(planningDefinitionSnapshot);
  return {
    id,
    hash: lwirHash,
    canonicalizer: "little-workflow-canonical-json@alpha",
    canonicalJson: canonical,
    lwir,
    lwirVersionId: `wfver_${lwirHash.slice("sha256:".length, "sha256:".length + 16)}`,
    lwirHash,
    lock: {
      workflowVersionId: id,
      workflowVersionHash: lwirHash,
      lwirVersionId: `wfver_${lwirHash.slice("sha256:".length, "sha256:".length + 16)}`,
      lwirHash,
      requestId: `orq_${name}`,
      requestHash: sha256Digest({ name, kind: "request" }),
      inputHash: sha256Digest({ ticketId: name }),
      plannedInputStructure: { kind: "object", fields: [] },
      plannedInputStructureHash: sha256Digest({ kind: "object", fields: [] }),
      inputBinding: "required",
      workflowDefinitionHash: sha256Digest({ name, kind: "definition" }),
      planningDefinitionSnapshot,
      planningDefinitionSnapshotHash,
      inputSchemaHash: sha256Digest(lwir.input.schema),
      requestedOutput: { kind: "json", schema: lwir.output.schema },
      requestedOutputHash: sha256Digest({ kind: "json", schema: lwir.output.schema }),
      capabilityManifest: { models: [], tools: [] },
      capabilityManifestHash: sha256Digest({ models: [], tools: [] }),
      modelSlots: [],
      tools: [],
      validationHash: sha256Digest({ name, kind: "validation" }),
    },
  };
}

function unlockedStoredWorkflowVersion(id: string, name: string): StoredWorkflowVersion {
  const lwir = validLwir(name);
  const canonical = canonicalJson(lwir);
  return {
    id,
    hash: sha256Digest(lwir),
    canonicalizer: "little-workflow-canonical-json@alpha",
    canonicalJson: canonical,
    lwir,
  };
}

function validLwir(name: string) {
  return {
    apiVersion: "littleworkflow.dev/v0.1",
    kind: "Workflow",
    metadata: { name },
    input: { schema: { type: "object" } },
    output: { schema: { type: "object" } },
    permissions: {
      models: ["model.structured"],
      tools: [],
      secrets: [],
      network: [],
    },
    steps: [
      {
        id: "summarize",
        uses: "ai.generate",
        with: {
          model: "model.structured",
          prompt: "Summarize {{ input.ticketId }}.",
        },
        output: { mode: "object", schema: { type: "object" } },
      },
    ],
  } as const;
}

function plannerReuseCandidate(
  workflowVersion: StoredWorkflowVersion,
  overrides: Partial<Omit<PlannerReuseCandidate, "workflowVersionId" | "workflowVersion">> = {},
): PlannerReuseCandidate {
  return {
    workflowVersionId: workflowVersion.id,
    runId: overrides.runId ?? "run_candidate",
    workflowId: overrides.workflowId ?? "support.triage",
    completedAt: overrides.completedAt ?? "2026-05-22T10:00:00.000Z",
    workflowVersion,
    planningDefinitionSnapshot: workflowVersion.lock?.planningDefinitionSnapshot,
    planningDefinitionSnapshotHash: workflowVersion.lock?.planningDefinitionSnapshotHash,
  };
}

async function appendCompletedRun(
  world: Awaited<ReturnType<typeof tempWorld>>,
  options: {
    readonly runId: string;
    readonly workflowId: string;
    readonly workflowVersionId: string;
    readonly completedAt: string;
  },
): Promise<void> {
  await appendRequestedAndRegistered(world, {
    ...options,
    recordedAt: options.completedAt,
  });
  await appendAt(options.completedAt, () =>
    appendEvent(world, options.runId, {
      type: "RunCompleted",
      payload: { workflowVersionId: options.workflowVersionId, output: { ok: true } },
    })
  );
}

async function appendRequestedAndRegistered(
  world: Awaited<ReturnType<typeof tempWorld>>,
  options: {
    readonly runId: string;
    readonly workflowId: string;
    readonly workflowVersionId: string;
    readonly recordedAt: string;
  },
): Promise<void> {
  await appendAt(options.recordedAt, () =>
    appendEvent(world, options.runId, {
      type: "OrchestrationRequested",
      payload: { workflowId: options.workflowId },
    })
  );
  await appendAt(options.recordedAt, () =>
    appendEvent(world, options.runId, {
      type: "WorkflowVersionRegistered",
      payload: {
        workflowVersionId: options.workflowVersionId,
        workflowVersionHash: `sha256:${options.workflowVersionId.padEnd(64, "0").slice(0, 64)}`,
      },
    })
  );
}

async function appendAt<T>(isoDate: string, fn: () => Promise<T>): Promise<T> {
  vi.setSystemTime(new Date(isoDate));
  return fn();
}
