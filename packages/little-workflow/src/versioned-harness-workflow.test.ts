import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tool } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { defineWorkflow, localWorld } from "./authoring.js";
import { agentWorkflow } from "./dynamic-workflow-factory.js";
import { versionedHarnessWorkflow, type WorkflowVersionSource } from "./versioned-harness-workflow.js";
import { readRunPin, writeRunPin } from "./world.js";
import type { World } from "./world-port.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function harnessContext(dataDir: string, parentSessionId: string, reservedRunId: string) {
  return {
    protocolVersion: 1,
    workflowId: "refund.note",
    workflowHandle: "refund_note",
    definitionIdentity: "sha256:test",
    toolCallId: "tool_1",
    disposition: "await",
    parentSessionId,
    parentTurnId: "turn_1",
    originTurnId: "turn_1",
    reservedRunId,
    persistence: { dataDir },
    observation: { recordProgress: async () => undefined },
    inheritance: {},
  };
}

type Content = { readonly greeting: string };

const noteInput = z.object({ name: z.string() });

/** A workflow whose one step's text comes from the version's content. */
function build(content: Content) {
  return defineWorkflow({
    id: "refund.note",
    description: "Write the customer a refund note.",
    input: noteInput,
    tools: {
      note: tool({
        description: "Write a note.",
        inputSchema: z.object({ text: z.string() }),
        execute: async ({ text }) => ({ text }),
      }),
    },
    plan: {
      steps: [
        {
          id: "note",
          uses: "tool.call",
          with: { tool: "note", args: { text: `${content.greeting} {{ input.name }}` } },
          output: { mode: "json", schema: true },
        },
      ],
    },
  });
}

describe("versionedHarnessWorkflow", () => {
  it("builds each run from the version its session runs, and traces the run's World", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "lw-versioned-"));
    dirs.push(dataDir);
    const asked: (string | undefined)[] = [];
    const wrapped: World[] = [];
    const source: WorkflowVersionSource<Content> = {
      bootstrap: { greeting: "Hello" },
      async prepare({ stickyKey }) {
        asked.push(stickyKey);
        return {
          content: stickyKey === "sess_new" ? { greeting: "Good news," } : { greeting: "Hello" },
          world(inner) {
            wrapped.push(inner);
            return inner;
          },
        };
      },
    };
    const adapted = versionedHarnessWorkflow(source, build);
    expect(adapted).toMatchObject({ id: "refund.note", description: "Write the customer a refund note." });

    const before = await adapted.runForHarness({ name: "Ada" }, harnessContext(dataDir, "sess_old", "run_1") as never);
    const after = await adapted.runForHarness({ name: "Ada" }, harnessContext(dataDir, "sess_new", "run_2") as never);

    expect(before).toMatchObject({ status: "completed" });
    expect(after).toMatchObject({ status: "completed" });
    expect(JSON.stringify(before)).toContain("Hello Ada");
    expect(JSON.stringify(after)).toContain("Good news, Ada");
    expect(asked).toEqual(["sess_old", "sess_new"]);
    expect(wrapped).toHaveLength(2);
  });
});

type Flow = { readonly greeting: string; readonly check: boolean };

/** `note`, then `check` when the version has it, then `send`: a version can change the topology. */
function buildFlow(content: Flow, calls: string[]) {
  const step = (id: string, needs: readonly string[], text: string) => ({
    id,
    ...(needs.length === 0 ? {} : { needs }),
    uses: "tool.call",
    with: { tool: id, args: { text } },
    output: { mode: "json", schema: true },
  });
  const record = (name: string) =>
    tool({
      description: name,
      inputSchema: z.object({ text: z.string() }),
      execute: async ({ text }) => {
        calls.push(`${name}:${text}`);
        return { text };
      },
    });
  return defineWorkflow({
    id: "refund.note",
    description: "Write the customer a refund note.",
    input: noteInput,
    tools: { note: record("note"), check: record("check"), send: record("send") },
    plan: {
      steps: [
        step("note", [], `${content.greeting} {{ input.name }}`),
        ...(content.check ? [step("check", ["note"], "check")] : []),
        step("send", [content.check ? "check" : "note"], "send"),
      ],
    } as never,
  });
}

/** A World whose process dies once `stepId` completes: every later write fails. */
function crashAfter(inner: World, stepId: string): World {
  let dead = false;
  return {
    kind: inner.kind,
    dataDir: inner.dataDir,
    async appendEvent(runId, event) {
      if (dead) throw new Error("process crashed");
      const written = await inner.appendEvent(runId, event);
      if (event.type === "StepCompleted" && event.payload.stepId === stepId) dead = true;
      return written;
    },
    listEvents: (runId) => inner.listEvents(runId),
    writeArtifact: (input) => inner.writeArtifact(input),
    readArtifact: (ref) => inner.readArtifact(ref),
    readArtifactManifest: (ref) => inner.readArtifactManifest(ref),
  };
}

describe("versionedHarnessWorkflow resumed runs", () => {
  const before: Flow = { greeting: "Hello", check: false };
  const after: Flow = { greeting: "Hi", check: true };

  /** A source whose live version can change, and a run of `run_resume` that crashed after `note`. */
  async function crashedRun() {
    const dataDir = await mkdtemp(join(tmpdir(), "lw-versioned-resume-"));
    dirs.push(dataDir);
    const calls: string[] = [];
    const state = { live: before, crash: true };
    const asked: { stickyKey?: string | undefined; pinned?: unknown }[] = [];
    const source: WorkflowVersionSource<Flow> = {
      bootstrap: before,
      async prepare(options) {
        asked.push(options);
        const content = state.live;
        return {
          content,
          version: { versionId: content === before ? "ver_1" : "ver_2" },
          world: (inner) => (state.crash ? crashAfter(inner, "note") : inner),
        };
      },
    };
    const ctx = harnessContext(dataDir, "sess_1", "run_resume") as never;
    const crashed = await versionedHarnessWorkflow(source, (c: Flow) => buildFlow(c, calls)).runForHarness({ name: "Ada" }, ctx);
    expect(crashed).toMatchObject({ status: "failed", message: "process crashed" });
    expect(calls).toEqual(["note:Hello Ada"]);
    state.crash = false;
    // A new process: a new adapter, nothing cached.
    const restart = () => versionedHarnessWorkflow(source, (c: Flow) => buildFlow(c, calls));
    return { dataDir, calls, state, asked, ctx, restart };
  }

  it("resumes on the version it started on after the live version changed its steps", async () => {
    const { dataDir, calls, state, asked, ctx, restart } = await crashedRun();
    state.live = after;

    const resumed = await restart().runForHarness({ name: "Ada" }, ctx);

    expect(resumed).toMatchObject({ status: "completed", output: { text: "send" } });
    // `note` is not run again, and the new version's `check` step never runs.
    expect(calls).toEqual(["note:Hello Ada", "send:send"]);
    expect(asked.at(-1)).toEqual({ stickyKey: "sess_1", pinned: { content: before, version: { versionId: "ver_1" } } });

    // A new run in the same session after the change runs the live version.
    const next = await restart().runForHarness({ name: "Ada" }, harnessContext(dataDir, "sess_1", "run_next") as never);
    expect(next).toMatchObject({ status: "completed" });
    expect(calls.slice(2)).toEqual(["note:Hi Ada", "check:check", "send:send"]);
  });

  it("fails closed, without running the live version, when a run has a log but no pin", async () => {
    const { dataDir, calls, state, ctx, restart } = await crashedRun();
    // A run that started before runs were pinned.
    await rm(join(dataDir, "run-pins"), { recursive: true });
    state.live = after;

    const resumed = await restart().runForHarness({ name: "Ada" }, ctx);

    expect(resumed).toMatchObject({ status: "failed" });
    expect(JSON.stringify(resumed)).toMatch(/changed/u);
    expect(calls).toEqual(["note:Hello Ada"]);
    // The live version is not pinned in its place.
    expect(await readRunPin(localWorld({ dataDir }), "run_resume")).toBeUndefined();
  });

  it("fails closed when the pin was altered", async () => {
    const { dataDir, calls, state, ctx, restart } = await crashedRun();
    const path = join(dataDir, "run-pins", "run_resume.json");
    await writeFile(path, (await readFile(path, "utf8")).replace("Hello", "Hi"));
    state.live = after;

    const resumed = await restart().runForHarness({ name: "Ada" }, ctx);

    expect(resumed).toMatchObject({ status: "failed" });
    expect(JSON.stringify(resumed)).toMatch(/does not match its hash/u);
    expect(calls).toEqual(["note:Hello Ada"]);
  });

  it("fails closed when only the pin's version was altered", async () => {
    const { dataDir, calls, ctx, restart } = await crashedRun();
    const path = join(dataDir, "run-pins", "run_resume.json");
    await writeFile(path, (await readFile(path, "utf8")).replace("ver_1", "ver_2"));

    const resumed = await restart().runForHarness({ name: "Ada" }, ctx);

    expect(resumed).toMatchObject({ status: "failed" });
    expect(JSON.stringify(resumed)).toMatch(/does not match its hash/u);
    expect(calls).toEqual(["note:Hello Ada"]);
  });

  it("resumes on another process's pin when that process pinned and started the run while this one resolved", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "lw-pins-interleave-"));
    dirs.push(dataDir);
    const calls: string[] = [];
    const ctx = () => harnessContext(dataDir, "sess_1", "run_interleave") as never;
    // Process A resolves `before` and crashes after `note`.
    const sourceA: WorkflowVersionSource<Flow> = {
      bootstrap: before,
      async prepare() {
        return { content: before, version: { versionId: "ver_A" }, world: (inner) => crashAfter(inner, "note") };
      },
    };
    // Process B is still resolving (to `after`) while A pins and starts the run.
    let entered!: () => void;
    const inPrepare = new Promise<void>((resolve) => (entered = resolve));
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => (release = resolve));
    const tracedB: unknown[] = [];
    const sourceB: WorkflowVersionSource<Flow> = {
      bootstrap: before,
      async prepare(options) {
        if (options.pinned === undefined) {
          entered();
          await barrier;
        }
        const version = options.pinned?.version ?? { versionId: "ver_B" };
        return {
          content: after,
          version: { versionId: "ver_B" },
          world: (inner) => {
            tracedB.push(version);
            return inner;
          },
        };
      },
    };

    const runB = versionedHarnessWorkflow(sourceB, (c: Flow) => buildFlow(c, calls)).runForHarness({ name: "Ada" }, ctx());
    await inPrepare;
    const runA = await versionedHarnessWorkflow(sourceA, (c: Flow) => buildFlow(c, calls)).runForHarness({ name: "Ada" }, ctx());
    expect(runA).toMatchObject({ status: "failed", message: "process crashed" });
    release();

    expect(await runB).toMatchObject({ status: "completed", output: { text: "send" } });
    // B ran A's version: no `check` step, and it is traced as A's version.
    expect(calls).toEqual(["note:Hello Ada", "send:send"]);
    expect(tracedB).toEqual([{ versionId: "ver_A" }]);
  });

  it("keeps the first pin written for a run", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "lw-pins-"));
    dirs.push(dataDir);
    const world = localWorld({ dataDir });
    expect(await writeRunPin(world, { runId: "run_a", content: before, version: "ver_1" })).toMatchObject({ written: true });
    const second = await writeRunPin(world, { runId: "run_a", content: after, version: "ver_2" });
    expect(second).toMatchObject({ written: false, pin: { content: before, version: "ver_1" } });
    await expect(readRunPin(world, "../run_a")).rejects.toThrow(/Invalid run id/u);
  });

  it("runs and traces the other process's pin when it pinned the run first, even with the same content", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "lw-pins-race-"));
    dirs.push(dataDir);
    const traced: unknown[] = [];
    const source: WorkflowVersionSource<Flow> = {
      bootstrap: before,
      async prepare(options) {
        if (options.pinned === undefined) {
          // Another process starts the same run and pins it while this one resolves: the trial
          // version this process saw was promoted in between, so the content matches, the version doesn't.
          await writeRunPin(localWorld({ dataDir }), { runId: "run_race", content: before, version: { mode: "live" } });
        }
        const version = options.pinned?.version ?? { mode: "trial" };
        return {
          content: before,
          version,
          world: (inner) => {
            traced.push(version);
            return inner;
          },
        };
      },
    };
    const result = await versionedHarnessWorkflow(source, (c: Flow) => buildFlow(c, [])).runForHarness(
      { name: "Ada" },
      harnessContext(dataDir, "sess_1", "run_race") as never,
    );
    expect(result).toMatchObject({ status: "completed" });
    expect(traced).toEqual([{ mode: "live" }]);
  });
});

describe("agentWorkflow", () => {
  const definition = {
    id: "refund.check",
    description: "Check whether an order can be refunded.",
    inputSchema: { type: "object", properties: { orderId: { type: "string" } }, required: ["orderId"] },
    outputSchema: { type: "object" },
    tools: ["lookup_order"],
  };
  const lookup = tool({ description: "Look up an order.", inputSchema: z.object({ orderId: z.string() }), execute: async () => ({}) });
  const planner = { provider: "test", modelId: "planner" } as never;

  it("builds an agent's definition into a workflow that runs outside the harness", () => {
    const workflow = agentWorkflow(definition, { tools: { lookup_order: lookup, other: lookup }, models: { default: planner }, planner });
    expect(workflow).toMatchObject({ id: "refund.check", description: "Check whether an order can be refunded." });
  });

  it("refuses a definition that uses a tool it was not given, or has an unusable schema", () => {
    expect(() => agentWorkflow(definition, { tools: {}, models: { default: planner }, planner })).toThrow(/lookup_order/u);
    expect(() =>
      agentWorkflow({ ...definition, inputSchema: { $schema: "x" } }, { tools: { lookup_order: lookup }, models: { default: planner }, planner }),
    ).toThrow(/inputSchema/u);
  });
});
