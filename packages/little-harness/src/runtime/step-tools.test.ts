import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonSchema, tool, type ToolSet } from "ai";
import { harnessToolContext } from "../connectors/tool-context.js";
import { HarnessInputError, HarnessPersistenceError } from "../errors.js";
import type { HarnessToolExecutionContext } from "../types.js";
import { once, runWithCallerToolContext, withStepToolContext } from "./step-tools.js";

/** Set to make every file write fail, as on a full disk. */
let failWrites = false;

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    writeFile: ((...args: Parameters<typeof actual.writeFile>) =>
      failWrites
        ? Promise.reject(Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" }))
        : actual.writeFile(...args)) as typeof actual.writeFile,
  };
});

const dirs: string[] = [];
afterEach(async () => {
  failWrites = false;
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

type Decision = { applicationId: string; letter: string };

function recordDecision(writes: Decision[], options: { fail?: () => boolean; seen?: unknown[] } = {}) {
  return tool({
    description: "Record a decision.",
    inputSchema: jsonSchema<Decision>({ type: "object" }),
    execute: async (input, executeOptions) => {
      options.seen?.push(executeOptions);
      if (options.fail?.()) throw new Error("loan system down");
      writes.push(input);
      return { recordId: `rec_${writes.length}`, applicationId: input.applicationId };
    },
  });
}

async function stepTools(tools: ToolSet, sessionId = "s1") {
  const onceDir = await mkdtemp(join(tmpdir(), "step-tools-"));
  dirs.push(onceDir);
  return { tools: withStepToolContext(tools, { sessionId, onceDir }), onceDir };
}

/** Calls a step tool the way the Workflow runtime does. */
function callStep(tools: ToolSet, name: string, input: unknown, stepPath = "record") {
  const execute = tools[name]!.execute as (input: unknown, options: unknown) => Promise<unknown>;
  return execute(input, { runId: "run_1", stepPath, attempt: 1, toolCallId: `run_1:${stepPath}:attempt-1`, messages: [] });
}

const decision = (letter: string): Decision => ({ applicationId: "APP-1012", letter });

describe("once", () => {
  it("returns the recorded result when a step makes the same call again in the session", async () => {
    const writes: Decision[] = [];
    const { tools } = await stepTools({ record_decision: once(recordDecision(writes)) });

    const first = await callStep(tools, "record_decision", decision("Approved."));
    const second = await callStep(tools, "record_decision", decision("Approved."), "save");

    expect(writes).toHaveLength(1);
    expect(second).toEqual(first);
  });

  it("uses the key to tell calls apart when the input carries model-written text", async () => {
    const writes: Decision[] = [];
    const { tools } = await stepTools({
      record_decision: once(recordDecision(writes), { key: (input) => input.applicationId }),
    });

    await callStep(tools, "record_decision", decision("Approved, DTI 0.42."));
    await callStep(tools, "record_decision", decision("We are pleased to approve."));
    await callStep(tools, "record_decision", { applicationId: "APP-1013", letter: "Declined." });

    expect(writes.map((write) => write.applicationId)).toEqual(["APP-1012", "APP-1013"]);
  });

  it("runs again in another session", async () => {
    const writes: Decision[] = [];
    const recorder = once(recordDecision(writes));
    const onceDir = await mkdtemp(join(tmpdir(), "step-tools-"));
    dirs.push(onceDir);
    for (const sessionId of ["s1", "s2"]) {
      await callStep(withStepToolContext({ record_decision: recorder }, { sessionId, onceDir }), "record_decision", decision("Approved."));
    }

    expect(writes).toHaveLength(2);
  });

  it("does not record a failed call, so the next attempt runs it", async () => {
    const writes: Decision[] = [];
    let down = true;
    const { tools } = await stepTools({ record_decision: once(recordDecision(writes, { fail: () => down })) });

    await expect(callStep(tools, "record_decision", decision("Approved."))).rejects.toThrow("loan system down");
    down = false;
    await callStep(tools, "record_decision", decision("Approved."));
    await callStep(tools, "record_decision", decision("Approved."));

    expect(writes).toHaveLength(1);
  });

  it("shares one execution between two steps making the same call at the same time", async () => {
    const writes: Decision[] = [];
    const { tools } = await stepTools({ record_decision: once(recordDecision(writes)) });

    const results = await Promise.all([
      callStep(tools, "record_decision", decision("Approved."), "a"),
      callStep(tools, "record_decision", decision("Approved."), "b"),
    ]);

    expect(writes).toHaveLength(1);
    expect(results[0]).toEqual(results[1]);
  });

  it("keeps a recorded undefined result", async () => {
    let calls = 0;
    const notify = once(tool({
      description: "Notify.",
      inputSchema: jsonSchema<{ to: string }>({ type: "object" }),
      execute: async () => {
        calls += 1;
        return undefined;
      },
    }));
    const { tools, onceDir } = await stepTools({ notify });

    expect(await callStep(tools, "notify", { to: "a" })).toBeUndefined();
    expect(await callStep(tools, "notify", { to: "a" })).toBeUndefined();
    expect(calls).toBe(1);
    expect(await readdir(onceDir)).toHaveLength(1);
  });

  it("refuses to run again when the result could not be recorded, instead of writing twice", async () => {
    let calls = 0;
    const transfer = once(tool({
      description: "Transfer funds.",
      inputSchema: jsonSchema<{ to: string }>({ type: "object" }),
      execute: async () => {
        calls += 1;
        return { amountCents: 1000n }; // not JSON
      },
    }));
    const { tools } = await stepTools({ transfer });
    expect(await callStep(tools, "transfer", { to: "a" })).toEqual({ amountCents: 1000n });
    await expect(callStep(tools, "transfer", { to: "a" })).rejects.toThrow(HarnessPersistenceError);
    await expect(callStep(tools, "transfer", { to: "a" })).rejects.toThrow("could not be saved, so it does not run again");

    // Nothing can be written at all (a full disk): this process still refuses.
    failWrites = true;
    expect(await callStep(tools, "transfer", { to: "b" })).toEqual({ amountCents: 1000n });
    await expect(callStep(tools, "transfer", { to: "b" })).rejects.toThrow(HarnessPersistenceError);
    expect(calls).toBe(2);
  });

  it("refuses a tool without execute and a key that returns nothing", async () => {
    expect(() => once(tool({ description: "x", inputSchema: jsonSchema({ type: "object" }) }) as never)).toThrow(
      HarnessInputError,
    );
    const { tools } = await stepTools({ record_decision: once(recordDecision([]), { key: () => "" }) });
    await expect(callStep(tools, "record_decision", decision("x"))).rejects.toThrow("must return non-empty text");
  });
});

describe("step tool calls", () => {
  it("get the caller's harness context and an idempotency key, without once too", async () => {
    const seen: unknown[] = [];
    const writes: Decision[] = [];
    const { tools } = await stepTools({ record_decision: recordDecision(writes, { seen }) });
    const caller = {
      session: { id: "s1" },
      files: { writeText: async () => ({}) },
      artifacts: {},
      extraBody: { tenant: "t1" },
      toolReplay: { get: () => undefined },
    } as unknown as HarnessToolExecutionContext;

    await runWithCallerToolContext(caller, () => callStep(tools, "record_decision", decision("Approved.")));
    await runWithCallerToolContext(caller, () => callStep(tools, "record_decision", decision("Approved.")));

    expect(writes).toHaveLength(2);
    const [first, second] = seen.map((options) => harnessToolContext(options));
    expect(first?.session.id).toBe("s1");
    expect(first?.extraBody).toEqual({ tenant: "t1" });
    expect(first?.idempotencyKey).toMatch(/^idem_[0-9a-f]{32}$/);
    expect(second?.idempotencyKey).toBe(first?.idempotencyKey);
    expect((first as { toolReplay?: unknown }).toolReplay).toBeUndefined();
    expect((first as { stepPath?: unknown }).stepPath).toBe("record");
  });

  it("give a different key for different input", async () => {
    const seen: unknown[] = [];
    const { tools } = await stepTools({ record_decision: recordDecision([], { seen }) });

    await callStep(tools, "record_decision", decision("Approved."));
    await callStep(tools, "record_decision", decision("Declined."));

    const keys = seen.map((options) => (options as { idempotencyKey?: string }).idempotencyKey);
    expect(keys[0]).not.toBe(keys[1]);
  });
});
