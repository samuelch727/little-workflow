import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { localWorld } from "./authoring.js";
import {
  ensureMemoryMounts,
  orchestratorAvailableWorkflowMemoryMounts,
  pipelineKeyForWorkflowDefinitions,
  pipelineMemoryMounts,
  workflowMemoryMounts,
} from "./memory.js";

const world = localWorld({ dataDir: "/tmp/little-workflow-memory-test" });

describe("ensureMemoryMounts", () => {
  it("creates backing directories for rw and ro mounts so bash can access them", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lw-mem-"));
    const mounts = [
      { storeId: "a", mountPath: "/mnt/memory/workflow/", backingPath: join(dir, "rw-store"), mode: "rw" as const },
      { storeId: "b", mountPath: "/mnt/memory/org/", backingPath: join(dir, "ro-store"), mode: "ro" as const },
    ];
    await ensureMemoryMounts(mounts);
    expect((await stat(mounts[0].backingPath)).isDirectory()).toBe(true);
    expect((await stat(mounts[1].backingPath)).isDirectory()).toBe(true);
  });
});

describe("memory mounts", () => {
  it("defaults workflow memory rw and org memory ro", () => {
    expect(workflowMemoryMounts({ world, workflowId: "candidate-review" })).toEqual([
      {
        storeId: "workflow:candidate-review",
        mountPath: "/mnt/memory/workflow/",
        backingPath: "/tmp/little-workflow-memory-test/memory/workflows/candidate-review",
        mode: "rw",
      },
      {
        storeId: "org",
        mountPath: "/mnt/memory/org/",
        backingPath: "/tmp/little-workflow-memory-test/memory/org",
        mode: "ro",
      },
    ]);
  });

  it("omits stores configured as none", () => {
    expect(
      workflowMemoryMounts({
        world,
        workflowId: "candidate-review",
        memory: { workflow: "none", org: "none" },
      }),
    ).toEqual([]);
  });

  it("mounts attached workflow stores read-only under peer-workflows", () => {
    expect(
      workflowMemoryMounts({
        world,
        workflowId: "candidate-scoring",
        memory: {
          attach: [
            { id: "Candidate Review", mode: "ro" },
            { id: "candidate.profile/enrich", mode: "ro" },
          ],
        },
      }),
    ).toContainEqual({
      storeId: "workflow:candidate-review",
      mountPath: "/mnt/memory/peer-workflows/candidate-review/",
      backingPath: "/tmp/little-workflow-memory-test/memory/workflows/candidate-review",
      mode: "ro",
    });
    expect(
      workflowMemoryMounts({
        world,
        workflowId: "candidate-scoring",
        memory: {
          attach: [
            { id: "Candidate Review", mode: "ro" },
            { id: "candidate.profile/enrich", mode: "ro" },
          ],
        },
      }),
    ).toContainEqual({
      storeId: "workflow:candidate-profile-enrich",
      mountPath: "/mnt/memory/peer-workflows/candidate-profile-enrich/",
      backingPath: "/tmp/little-workflow-memory-test/memory/workflows/candidate-profile-enrich",
      mode: "ro",
    });
  });

  it("computes a stable pipeline key from sorted workflow definition hashes", () => {
    const left = pipelineKeyForWorkflowDefinitions(["sha256:b", "sha256:a", "sha256:c"]);
    const right = pipelineKeyForWorkflowDefinitions(["sha256:c", "sha256:b", "sha256:a"]);

    expect(left).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(right).toBe(left);
    expect(
      pipelineMemoryMounts({
        world,
        workflowDefinitionHashes: ["sha256:b", "sha256:a", "sha256:c"],
      }),
    ).toEqual([
      {
        storeId: `pipeline:${left}`,
        mountPath: "/mnt/memory/pipeline/",
        backingPath: `/tmp/little-workflow-memory-test/memory/pipelines/${left}`,
        mode: "rw",
      },
      {
        storeId: "org",
        mountPath: "/mnt/memory/org/",
        backingPath: "/tmp/little-workflow-memory-test/memory/org",
        mode: "ro",
      },
    ]);
  });

  it("supports read-only pipeline memory mounts for sub-runs", () => {
    const pipelineKey = pipelineKeyForWorkflowDefinitions(["sha256:workflow"]);

    expect(
      pipelineMemoryMounts({
        world,
        workflowDefinitionHashes: ["sha256:workflow"],
        mode: "ro",
      })[0],
    ).toEqual({
      storeId: `pipeline:${pipelineKey}`,
      mountPath: "/mnt/memory/pipeline/",
      backingPath: `/tmp/little-workflow-memory-test/memory/pipelines/${pipelineKey}`,
      mode: "ro",
    });
  });

  it("can omit org mount for nested planner/worker memory composition", () => {
    const pipelineKey = pipelineKeyForWorkflowDefinitions(["sha256:workflow"]);
    expect(
      pipelineMemoryMounts({
        world,
        workflowDefinitionHashes: ["sha256:workflow"],
        mode: "ro",
        includeOrg: false,
      }),
    ).toEqual([
      {
        storeId: `pipeline:${pipelineKey}`,
        mountPath: "/mnt/memory/pipeline/",
        backingPath: `/tmp/little-workflow-memory-test/memory/pipelines/${pipelineKey}`,
        mode: "ro",
      },
    ]);
  });

  it("rejects attached workflow memory key collisions", () => {
    expect(() =>
      workflowMemoryMounts({
        world,
        workflowId: "candidate-scoring",
        memory: {
          attach: [
            { id: "candidate.review", mode: "ro" },
            { id: "candidate/review", mode: "ro" },
          ],
        },
      }),
    ).toThrow(/Duplicate attached workflow memory key/u);
  });

  it("mounts available workflow memories for orchestrator read-only", () => {
    expect(
      orchestratorAvailableWorkflowMemoryMounts({
        world,
        workflows: [
          {
            id: "candidate.review",
            description: "Review candidate",
            inputSchema: true,
            outputSchema: true,
            workflowDefinitionHash: "sha256:def123",
          },
          {
            id: "Candidate Scoring",
            description: "Score candidate",
            inputSchema: true,
            outputSchema: true,
            workflowDefinitionHash: "sha256:def456",
          },
        ],
      }),
    ).toEqual([
      {
        storeId: "workflow:candidate-review",
        mountPath: "/mnt/memory/available-workflows/candidate-review/",
        backingPath: "/tmp/little-workflow-memory-test/memory/workflows/candidate-review",
        mode: "ro",
      },
      {
        storeId: "workflow:candidate-scoring",
        mountPath: "/mnt/memory/available-workflows/candidate-scoring/",
        backingPath: "/tmp/little-workflow-memory-test/memory/workflows/candidate-scoring",
        mode: "ro",
      },
    ]);
  });

  it("rejects available workflow memory key collisions", () => {
    expect(() =>
      orchestratorAvailableWorkflowMemoryMounts({
        world,
        workflows: [
          { id: "candidate.review" },
          { id: "candidate/review" },
        ],
      }),
    ).toThrow(/Duplicate available workflow memory key/u);
  });
});
