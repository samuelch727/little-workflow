import { mkdtemp, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureScratchMounts,
  scratchMountsForScope,
} from "./scratch.js";

const tempDirs: string[] = [];

async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), "little-workflow-scratch-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("scratch mounts", () => {
  it("gives orchestrator writable own scratch", () => {
    expect(
      scratchMountsForScope({
        runId: "run_pipeline",
        logDir: "/tmp/little-workflow/runs/run_pipeline",
        role: "orchestrator",
      }),
    ).toEqual([
      {
        mountPath: "/mnt/scratch/own/",
        backingPath: "/tmp/little-workflow/runs/run_pipeline/scratch",
        mode: "rw",
      },
    ]);
  });

  it("gives top-level planner writable own scratch only", () => {
    expect(
      scratchMountsForScope({
        runId: "run_workflow",
        logDir: "/tmp/little-workflow/runs/run_workflow",
        role: "planner",
      }),
    ).toEqual([
      {
        mountPath: "/mnt/scratch/own/",
        backingPath: "/tmp/little-workflow/runs/run_workflow/scratch",
        mode: "rw",
      },
    ]);
  });

  it("gives nested planner read-only from-orchestrator scratch", () => {
    expect(
      scratchMountsForScope({
        runId: "run_child",
        parentRunId: "run_pipeline",
        logDir: "/tmp/little-workflow/runs/run_pipeline/sub-runs/run_child",
        role: "planner",
      }),
    ).toEqual([
      {
        mountPath: "/mnt/scratch/own/",
        backingPath: "/tmp/little-workflow/runs/run_pipeline/sub-runs/run_child/scratch",
        mode: "rw",
      },
      {
        mountPath: "/mnt/scratch/from-orchestrator/",
        backingPath: "/tmp/little-workflow/runs/run_pipeline/scratch",
        mode: "ro",
      },
    ]);
  });

  it("gives worker own, from-planner, from-orchestrator, and peer-steps mounts", () => {
    expect(
      scratchMountsForScope({
        runId: "run_child",
        parentRunId: "run_pipeline",
        logDir: "/tmp/little-workflow/runs/run_pipeline/sub-runs/run_child",
        role: "worker.code-run",
        stepPath: "summarize",
      }),
    ).toEqual([
      {
        mountPath: "/mnt/scratch/own/",
        backingPath: "/tmp/little-workflow/runs/run_pipeline/sub-runs/run_child/steps/summarize/scratch",
        mode: "rw",
      },
      {
        mountPath: "/mnt/scratch/from-planner/",
        backingPath: "/tmp/little-workflow/runs/run_pipeline/sub-runs/run_child/scratch",
        mode: "ro",
      },
      {
        mountPath: "/mnt/scratch/from-orchestrator/",
        backingPath: "/tmp/little-workflow/runs/run_pipeline/scratch",
        mode: "ro",
      },
      {
        mountPath: "/mnt/scratch/peer-steps/",
        backingPath: "/tmp/little-workflow/runs/run_pipeline/sub-runs/run_child/steps/*/scratch",
        mode: "ro",
      },
    ]);
  });

  it("uses step path in worker scratch backing path", () => {
    expect(
      scratchMountsForScope({
        runId: "run_child",
        logDir: "/tmp/little-workflow/runs/run_child",
        role: "worker.ai-generate",
        stepPath: "score[cand_a].review.visit[0]",
      })[0],
    ).toEqual({
      mountPath: "/mnt/scratch/own/",
      backingPath: "/tmp/little-workflow/runs/run_child/steps/score%5Bcand_a%5D.review.visit%5B0%5D/scratch",
      mode: "rw",
    });
  });

  it("escapes wildcard characters in worker step paths", () => {
    expect(
      scratchMountsForScope({
        runId: "run_child",
        logDir: "/tmp/little-workflow/runs/run_child",
        role: "worker.code-run",
        stepPath: "*",
      })[0],
    ).toEqual({
      mountPath: "/mnt/scratch/own/",
      backingPath: "/tmp/little-workflow/runs/run_child/steps/%2A/scratch",
      mode: "rw",
    });
  });

  it("creates scratch backing directories", async () => {
    const root = await tempDir();
    const mounts = scratchMountsForScope({
      runId: "run_child",
      logDir: join(root, "runs", "run_child"),
      role: "worker.tool-call",
      stepPath: "lookup",
    });

    await ensureScratchMounts(mounts);

    await expect(stat(join(root, "runs", "run_child", "scratch"))).resolves.toMatchObject({
      isDirectory: expect.any(Function),
    });
    expect((await stat(join(root, "runs", "run_child", "steps", "lookup", "scratch"))).isDirectory()).toBe(true);
    await expect(stat(join(root, "runs", "run_child", "steps", "*"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
