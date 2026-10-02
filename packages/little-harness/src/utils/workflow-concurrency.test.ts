import { expect, test } from "vitest";
import {
  DEFAULT_MAX_CONCURRENT_WORKFLOW_RUNS,
  DEFAULT_MAX_QUEUED_WORKFLOW_RUNS,
  runWithWorkflowRunSlot,
  WorkflowQueueOverflowError,
  workflowRunSlotSnapshot,
} from "./workflow-concurrency.js";

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (error: unknown) => void } {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = () => res();
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

test("an uncontended acquisition runs the task in the caller's own tick", () => {
  let ran = false;
  const call = runWithWorkflowRunSlot("sess_gate_fastpath", undefined, async () => {
    ran = true;
  });
  expect(ran).toBe(true);
  return call;
});

test("holds concurrency at the supplied limit and admits waiters in FIFO order", async () => {
  const sessionId = "sess_gate_fifo";
  const budgets = { maxConcurrentWorkflowRuns: 2, maxQueuedWorkflowRuns: 100 };
  const started: number[] = [];
  const gates: Array<() => void> = [];
  let inFlight = 0;
  let peak = 0;

  const calls = Array.from({ length: 6 }, (_unused, index) =>
    runWithWorkflowRunSlot(sessionId, budgets, async () => {
      started.push(index);
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      const gate = deferred();
      gates.push(gate.resolve);
      await gate.promise;
      inFlight -= 1;
      return index;
    }));

  for (let released = 0; released < 6; released += 1) {
    await tick();
    expect(inFlight).toBeLessThanOrEqual(2);
    gates.shift()?.();
  }

  await expect(Promise.all(calls)).resolves.toEqual([0, 1, 2, 3, 4, 5]);
  expect(peak).toBe(2);
  expect(started).toEqual([0, 1, 2, 3, 4, 5]);
  expect(workflowRunSlotSnapshot(sessionId)).toBeUndefined();
});

test("rejects an acquisition that would push the queue past maxQueuedWorkflowRuns", async () => {
  const sessionId = "sess_gate_overflow";
  const budgets = { maxConcurrentWorkflowRuns: 1, maxQueuedWorkflowRuns: 2 };
  const gate = deferred();
  const admitted = runWithWorkflowRunSlot(sessionId, budgets, () => gate.promise);
  const queued = [
    runWithWorkflowRunSlot(sessionId, budgets, async () => {}),
    runWithWorkflowRunSlot(sessionId, budgets, async () => {}),
  ];
  expect(workflowRunSlotSnapshot(sessionId)).toEqual({ active: 1, queued: 2 });

  let thrown: unknown;
  try {
    runWithWorkflowRunSlot(sessionId, budgets, async () => {
      throw new Error("must never run");
    });
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(WorkflowQueueOverflowError);
  expect(thrown).toMatchObject({
    causeCode: "max_queued_workflow_runs",
    maxQueuedWorkflowRuns: 2,
    queuedWorkflowRuns: 2,
  });
  expect((thrown as Error).message).toContain("maxQueuedWorkflowRuns is 2");

  gate.resolve();
  await Promise.all([admitted, ...queued]);
  expect(workflowRunSlotSnapshot(sessionId)).toBeUndefined();
});

test("a rejected or synchronously throwing task releases its slot", async () => {
  const sessionId = "sess_gate_release";
  const budgets = { maxConcurrentWorkflowRuns: 1, maxQueuedWorkflowRuns: 10 };

  await expect(
    runWithWorkflowRunSlot(sessionId, budgets, async () => {
      throw new Error("async boom");
    }),
  ).rejects.toThrow("async boom");
  expect(workflowRunSlotSnapshot(sessionId)).toBeUndefined();

  expect(() =>
    runWithWorkflowRunSlot(sessionId, budgets, (): Promise<void> => {
      throw new Error("sync boom");
    })).toThrow("sync boom");
  expect(workflowRunSlotSnapshot(sessionId)).toBeUndefined();

  await expect(runWithWorkflowRunSlot(sessionId, budgets, async () => "after")).resolves.toBe("after");
});

test("a failing run hands its slot to the call queued behind it", async () => {
  const sessionId = "sess_gate_handoff";
  const budgets = { maxConcurrentWorkflowRuns: 1, maxQueuedWorkflowRuns: 10 };
  const gate = deferred();
  const failing = runWithWorkflowRunSlot(sessionId, budgets, async () => {
    await gate.promise;
    throw new Error("run failed");
  });
  let secondStarted = false;
  const second = runWithWorkflowRunSlot(sessionId, budgets, async () => {
    secondStarted = true;
    return "second";
  });

  expect(secondStarted).toBe(false);
  gate.resolve();
  await expect(failing).rejects.toThrow("run failed");
  await expect(second).resolves.toBe("second");
  expect(workflowRunSlotSnapshot(sessionId)).toBeUndefined();
});

test("sessions do not share a slot pool", async () => {
  const budgets = { maxConcurrentWorkflowRuns: 1, maxQueuedWorkflowRuns: 10 };
  const gate = deferred();
  let secondStarted = false;
  const first = runWithWorkflowRunSlot("sess_gate_a", budgets, () => gate.promise);
  const second = runWithWorkflowRunSlot("sess_gate_b", budgets, async () => {
    secondStarted = true;
  });

  expect(secondStarted).toBe(true);
  gate.resolve();
  await Promise.all([first, second]);
});

test("missing budgets fall back to the harness defaults and a sub-1 limit cannot deadlock", async () => {
  expect(DEFAULT_MAX_CONCURRENT_WORKFLOW_RUNS).toBe(10);
  expect(DEFAULT_MAX_QUEUED_WORKFLOW_RUNS).toBe(100);

  const sessionId = "sess_gate_defaults";
  const gates: Array<() => void> = [];
  const held = Array.from({ length: DEFAULT_MAX_CONCURRENT_WORKFLOW_RUNS }, () =>
    runWithWorkflowRunSlot(sessionId, {}, async () => {
      const gate = deferred();
      gates.push(gate.resolve);
      await gate.promise;
    }));
  await tick();
  expect(workflowRunSlotSnapshot(sessionId)).toEqual({ active: 10, queued: 0 });
  const queued = runWithWorkflowRunSlot(sessionId, {}, async () => "queued");
  expect(workflowRunSlotSnapshot(sessionId)).toEqual({ active: 10, queued: 1 });
  for (const resolve of gates) {
    resolve();
  }
  await Promise.all(held);
  await expect(queued).resolves.toBe("queued");

  // A limit below 1 would strand every call on a path that awaits its own runs, so it is
  // clamped to 1 rather than honoured verbatim.
  await expect(
    runWithWorkflowRunSlot("sess_gate_zero", { maxConcurrentWorkflowRuns: 0 }, async () => "ran"),
  ).resolves.toBe("ran");
});
