import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const fsRace = vi.hoisted(() => ({
  lockDir: undefined as string | undefined,
  freshLockOwner: "owned" as "owned" | "ownerless",
  intercepted: false,
}));

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>(
    "node:fs/promises",
  );
  return {
    ...actual,
    rm: vi.fn(async (path, options) => actual.rm(path, options)),
    rename: vi.fn(async (oldPath, newPath) => {
      if (!fsRace.intercepted && fsRace.lockDir === String(oldPath)) {
        fsRace.intercepted = true;
        await actual.rm(fsRace.lockDir, { recursive: true, force: true });
        await actual.mkdir(fsRace.lockDir, { recursive: true });
        if (fsRace.freshLockOwner === "owned") {
          await actual.writeFile(
            join(fsRace.lockDir, "owner.json"),
            JSON.stringify({ pid: process.pid, token: "fresh-owner" }),
            "utf8",
          );
        }
      }
      return actual.rename(oldPath, newPath);
    }),
  };
});

import {
  createLittleWorkflow,
  createToolRegistry,
  localWorld,
  model,
  output,
  sha256Digest,
} from "./index.js";
import type {
  HarnessTask,
  InferWorkflowOutput,
  LwirWorkflow,
  RunResult,
  RunWorkflowOptions,
  RuntimeToolHandler,
  WorkflowRunTarget,
} from "./index.js";
import type { PlannerAdapter } from "./compiler.js";
import { runWorkflowWithLegacyPlannerAdapter } from "./runtime.js";

const tempDirs: string[] = [];

async function tempWorld() {
  const dataDir = await mkdtemp(join(tmpdir(), "little-workflow-run-lock-race-"));
  tempDirs.push(dataDir);
  return localWorld({ dataDir });
}

afterEach(async () => {
  fsRace.lockDir = undefined;
  fsRace.freshLockOwner = "owned";
  fsRace.intercepted = false;
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const ticketInputSchema = {
  type: "object",
  required: ["ticketId", "body"],
  additionalProperties: false,
  properties: {
    ticketId: { type: "string" },
    body: { type: "string" },
  },
};

const ticketOutputSchema = {
  type: "object",
  required: ["summary"],
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
  },
};

const ticketToolRegistry = createToolRegistry();
ticketToolRegistry.register("summarize", {
  description: "Summarize a ticket.",
  inputSchema: ticketInputSchema,
  execute: async (input) => input as Record<string, unknown>,
});

const runLockRaceWorkerModel = model(
  { provider: "test", modelId: "run-lock-race-worker-model" },
  { description: "Worker model for run lock race tests." },
);

const runLockRacePlanner = {
  model: { provider: "test", modelId: "run-lock-race-planner-model" },
  harness: {
    harnessId: "runLockRacePlannerHarness@1.0.0",
    run: async (task: HarnessTask) => {
      if (task.kind !== "plan") {
        return { kind: "delegate_to_default" } as const;
      }
      return { kind: "plan", lwir: singleToolLwir() } as const;
    },
  },
} as const;

const ticketWorkflow = createLittleWorkflow({
  id: "support.summarize",
  description: "Summarize a ticket.",
  inputSchema: ticketInputSchema,
  output: output.object({ schema: ticketOutputSchema }),
  models: [runLockRaceWorkerModel],
  planner: runLockRacePlanner,
  globalTools: ["summarize"],
});

function singleToolLwir(): LwirWorkflow {
  return {
    apiVersion: "littleworkflow.dev/v0.1",
    kind: "Workflow",
    metadata: {
      name: "support.summarize",
      version: "0.1.0-alpha",
      description: "Summarize a ticket.",
    },
    input: { schema: ticketInputSchema },
    output: { schema: ticketOutputSchema },
    permissions: { tools: ["summarize"], models: [], secrets: [], network: [] },
    steps: [
      {
        id: "summarize",
        uses: "tool.call",
        with: { tool: "summarize" },
        input: {
          ticketId: "{{ input.ticketId }}",
          body: "{{ input.body }}",
        },
        output: { mode: "object", schema: ticketOutputSchema },
      },
    ],
  };
}

function plannerFor(lwir: LwirWorkflow): PlannerAdapter {
  return {
    draft: vi.fn(async () => lwir),
  };
}

type RunWorkflowLegacyPlannerOptions<TWorkflow extends WorkflowRunTarget> =
  RunWorkflowOptions<TWorkflow> & {
    readonly planner?: PlannerAdapter;
  };

async function runWorkflow<TWorkflow extends WorkflowRunTarget>(
  options: RunWorkflowLegacyPlannerOptions<TWorkflow>,
): Promise<RunResult<InferWorkflowOutput<TWorkflow>>> {
  return runWorkflowWithLegacyPlannerAdapter(options) as Promise<
    RunResult<InferWorkflowOutput<TWorkflow>>
  >;
}

function runLockDir(dataDir: string, runId: string) {
  return join(dataDir, "locks", sha256Digest(runId).replace(/[^A-Za-z0-9_-]/gu, "_"));
}

async function writeRunLockOwner(dataDir: string, runId: string, pid: number) {
  const lockDir = runLockDir(dataDir, runId);
  await mkdir(lockDir, { recursive: true });
  await writeFile(join(lockDir, "owner.json"), JSON.stringify({ pid }), "utf8");
}

async function writeOwnerlessStaleRunLock(dataDir: string, runId: string) {
  const lockDir = runLockDir(dataDir, runId);
  await mkdir(lockDir, { recursive: true });
  const old = new Date(Date.now() - 60_000);
  await utimes(lockDir, old, old);
}

describe("run execution lock stale recovery", () => {
  it("uses retry-safe rm options when cleaning run lock directories", async () => {
    vi.mocked(rm).mockClear();
    const world = await tempWorld();
    const runId = "run_public_lock_cleanup_retry_safe";
    const planner = plannerFor(singleToolLwir());
    const registry = createToolRegistry();
    registry.register("summarize", {
      description: "Summarize a ticket.",
      inputSchema: ticketInputSchema,
      execute: async (input) => ({ summary: (input as { body: string }).body }),
    });

    const result = await runWorkflow({
      world,
      workflows: ticketWorkflow,
      input: { ticketId: "TIN-12", body: "Cannot export invoices." },
      planner,
      tools: registry,
      runId,
    });

    expect(result.status).toBe("completed");
    const lockSegment = `${sep}locks${sep}`;
    const lockCleanupCalls = vi.mocked(rm).mock.calls.filter(([path]) =>
      String(path).includes(lockSegment)
    );
    expect(lockCleanupCalls.length).toBeGreaterThan(0);
    for (const [, options] of lockCleanupCalls) {
      expect(options).toEqual(expect.objectContaining({
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 50,
      }));
    }
  });

  it("does not steal a fresh lock that appears while claiming a stale lock", async () => {
    const world = await tempWorld();
    const runId = "run_public_stale_lock_fresh_owner_race";
    await writeRunLockOwner(world.dataDir, runId, 999_999_999);
    fsRace.lockDir = runLockDir(world.dataDir, runId);
    const planner = plannerFor(singleToolLwir());

    await expect(
      runWorkflow({
        world,
        workflows: ticketWorkflow,
        input: { ticketId: "TIN-12", body: "Cannot export invoices." },
        planner,
        tools: ticketToolRegistry,
        runId,
      }),
    ).rejects.toThrow(`Run '${runId}' is already executing`);

    const owner = JSON.parse(await readFile(join(fsRace.lockDir, "owner.json"), "utf8"));
    expect(owner).toMatchObject({ pid: process.pid, token: "fresh-owner" });
    expect(planner.draft).not.toHaveBeenCalled();
  });

  it("does not steal an ownerless fresh lock that appears while claiming an ownerless stale lock", async () => {
    const world = await tempWorld();
    const runId = "run_public_ownerless_stale_lock_fresh_ownerless_race";
    await writeOwnerlessStaleRunLock(world.dataDir, runId);
    fsRace.lockDir = runLockDir(world.dataDir, runId);
    fsRace.freshLockOwner = "ownerless";
    const planner = plannerFor(singleToolLwir());

    await expect(
      runWorkflow({
        world,
        workflows: ticketWorkflow,
        input: { ticketId: "TIN-12", body: "Cannot export invoices." },
        planner,
        tools: ticketToolRegistry,
        runId,
      }),
    ).rejects.toThrow(`Run '${runId}' is already executing`);

    const lockStats = await stat(fsRace.lockDir);
    expect(lockStats.isDirectory()).toBe(true);
    await expect(readFile(join(fsRace.lockDir, "owner.json"), "utf8")).rejects.toThrow();
    expect(planner.draft).not.toHaveBeenCalled();
  });
});
