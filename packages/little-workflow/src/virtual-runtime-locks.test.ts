import { InMemoryFs } from "just-bash";
import { jsonSchema, tool } from "ai";
import type { HarnessWorkflowRunContext } from "@little-stack/harness";
import { describe, expect, it, vi } from "vitest";
import { littleWorkflowDynamicWorkflowFactory } from "./dynamic-workflow-factory.js";
import { virtualWorld } from "./world.js";
import type { World } from "./world-port.js";
import { sha256Digest } from "./canonical.js";
import { tryAcquireOuterLoopExecutionLock } from "./runtime.js";

function runContext(world: World, execute: () => Promise<unknown>): HarnessWorkflowRunContext {
  return {
    protocolVersion: 1, workflowId: "adhoc", workflowHandle: "adhoc",
    definitionIdentity: "sha256:lock-test", toolCallId: "call_1", disposition: "await",
    parentSessionId: "s", parentTurnId: "t", originTurnId: "t",
    reservedRunId: "run_shared_identity", persistence: { dataDir: world.dataDir }, inheritance: {},
    capabilities: {
      tools: { echo: tool({ description: "Wait, then echo.", inputSchema: jsonSchema({ type: "object" }), execute }) },
      mcpTools: {}, bash: {}, code: {}, workflows: {}, skills: {}, mounts: [],
      permissions: { approvalPolicy: "reject_ask" },
    },
    observation: { recordProgress: async () => undefined },
  };
}

function plan(world: World) {
  const result = littleWorkflowDynamicWorkflowFactory({ world }).compile({
    purpose: "Check storage identity", input: {}, outputSchema: true,
    plan: {
      steps: [{ id: "echo", uses: "tool.call", tool: "echo", with: {}, output: { mode: "json", schema: true } }],
      output: { from: "echo" },
    },
    allowed: { tools: ["echo"], models: [], bash: false },
    limits: { maxSteps: 8, maxRuntimeMs: 120_000 },
  });
  if (!result.ok) throw new Error(result.message);
  return result.workflow;
}

function gate() {
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  return { waiting, release };
}

describe("virtual filesystem namespace coordination", () => {
  it("does not let an old outer-loop release remove a later owner", async () => {
    const fs = new InMemoryFs();
    const firstWorld = virtualWorld({ fs, dataDir: "/outer" });
    const nextWorld = virtualWorld({ fs, dataDir: "/outer/./" });
    const firstRelease = await tryAcquireOuterLoopExecutionLock(firstWorld, "ol_shared");
    expect(firstRelease).toEqual(expect.any(Function));
    await firstRelease!();
    const nextRelease = await tryAcquireOuterLoopExecutionLock(nextWorld, "ol_shared");
    expect(nextRelease).toEqual(expect.any(Function));
    try {
      await firstRelease!();
      expect(await tryAcquireOuterLoopExecutionLock(firstWorld, "ol_shared")).toBeUndefined();
    } finally {
      await nextRelease!();
    }
    const finalRelease = await tryAcquireOuterLoopExecutionLock(firstWorld, "ol_shared");
    expect(finalRelease).toEqual(expect.any(Function));
    await finalRelease!();
  });

  it.each([false, true])("refuses same-run overlap (second World=%s)", async secondWorld => {
    const fs = new InMemoryFs();
    const firstWorld = virtualWorld({ fs, dataDir: "/shared" });
    const otherWorld = secondWorld ? virtualWorld({ fs, dataDir: "/nested/../shared/./" }) : firstWorld;
    const paused = gate();
    let calls = 0;
    const execute = async () => {
      calls += 1;
      await paused.waiting;
      return { owner: "first" };
    };
    const first = plan(firstWorld).runForHarness({}, runContext(firstWorld, execute));
    try {
      await vi.waitFor(() => expect(calls).toBe(1));
      expect(await plan(otherWorld).runForHarness({}, runContext(otherWorld, execute)))
        .toMatchObject({ status: "failed", message: expect.stringContaining("already executing") });
      expect(calls).toBe(1);
    } finally {
      paused.release();
    }
    expect(await first).toMatchObject({ status: "completed", output: { owner: "first" } });
  });

  it("does not mix independent filesystems with identical paths and run ids", async () => {
    const worlds = [new InMemoryFs(), new InMemoryFs()].map(fs => virtualWorld({ fs, dataDir: "/shared" }));
    const paused = gate();
    let entered = 0;
    const runs = worlds.map((world, index) => plan(world).runForHarness({}, runContext(world, async () => {
      entered += 1;
      await paused.waiting;
      return { owner: index };
    })));
    try {
      await vi.waitFor(() => expect(entered).toBe(2));
    } finally {
      paused.release();
    }
    expect(await Promise.all(runs)).toEqual([
      expect.objectContaining({ status: "completed", output: { owner: 0 } }),
      expect.objectContaining({ status: "completed", output: { owner: 1 } }),
    ]);
    const completed = await Promise.all(worlds.map(world => world.listEvents("run_shared_identity")));
    expect(completed[0]).not.toEqual(completed[1]);
    expect(completed.every(events => events.some(event => event.type === "RunCompleted"))).toBe(true);
  });

  it("shares append ordering and idempotency receipts across Worlds over the same namespace", async () => {
    const fs = new InMemoryFs();
    const worlds = [virtualWorld({ fs, dataDir: "/events" }), virtualWorld({ fs, dataDir: "/events/./" })];
    const input = Array.from({ length: 12 }, (_, index) => ({
      type: "StepScheduled" as const, payload: { stepPath: `step-${index}` },
      appendIdempotencyKey: `append-key-000000-${index}`, canonicalRequestDigest: sha256Digest({ index }),
    }));
    const events = await Promise.all(input.map((event, index) => worlds[index % 2]!.appendEvent("run_shared_appends", event)));
    expect(events.map(event => event.sequence)).toEqual(input.map((_, index) => index + 1));
    expect(await worlds[1]!.appendEvent("run_shared_appends", input[0]!)).toEqual(events[0]);
    expect(await worlds[0]!.listEvents("run_shared_appends")).toEqual(events);
    expect(await worlds[1]!.listEvents("run_shared_appends")).toEqual(events);
  });
});
