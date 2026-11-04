import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarness, generateHarness, localHost } from "@little-stack/harness";
import { tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createLittleDB } from "../client.js";
import { fakeLittleDB } from "../test/fake-littledb.js";
import type { SpanInput, TraceInput } from "../contract.js";
import { createMemoryLinks } from "../memory.js";
import { toLittleDBCompute } from "../util.js";
import { createHarnessTracer, turnTraceId } from "./tracer.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const usage = {
  inputTokens: { total: 1000, noCache: 200, cacheRead: 700, cacheWrite: 100 },
  outputTokens: { total: 40, text: 40, reasoning: 0 },
};

/** A model that looks an order up, then answers; with `preamble`, it says so before looking. */
function supportModel(preamble?: string) {
  let calls = 0;
  return new MockLanguageModelV3({
    provider: "anthropic.messages",
    modelId: "claude-test",
    doGenerate: async () => {
      calls += 1;
      if (calls % 2 === 1) {
        return {
          content: [
            ...(preamble === undefined ? [] : [{ type: "text" as const, text: preamble }]),
            { type: "tool-call" as const, toolCallId: `call_${calls}`, toolName: "lookup_order", input: JSON.stringify({ orderId: "A1" }) },
          ],
          finishReason: { unified: "tool-calls", raw: "tool_use" },
          usage,
          warnings: [],
        };
      }
      return {
        content: [{ type: "text", text: "Your order A1 shipped." }],
        finishReason: { unified: "stop", raw: "end_turn" },
        usage,
        warnings: [],
      };
    },
  });
}

async function harnessWith(onEvent: Parameters<typeof createHarness>[0]["onEvent"], preamble?: string) {
  const dir = await mkdtemp(join(tmpdir(), "ldb-tracer-"));
  dirs.push(dir);
  return createHarness({
    host: localHost({ dataDir: dir }),
    model: supportModel(preamble),
    runtime: { bash: false },
    trace: { content: { previewBytes: 65_536 } },
    tools: {
      lookup_order: tool({
        description: "Look an order up.",
        inputSchema: z.object({ orderId: z.string() }),
        execute: async ({ orderId }) => ({ orderId, status: "shipped" }),
      }),
    },
    ...(onEvent === undefined ? {} : { onEvent }),
  });
}

describe("harnessTracer", () => {
  it.each(["界", "x"])("retains the legacy default preview visible to LittleDB for %s text", async character => {
    const fake = fakeLittleDB();
    const db = createLittleDB({ url: fake.url, apiKey: fake.apiKey, fetch: fake.fetch });
    const tracer = db.harnessTracer({ harness: "default-preview" });
    const dir = await mkdtemp(join(tmpdir(), "ldb-tracer-preview-"));
    dirs.push(dir);
    const harness = createHarness({
      host: localHost({ dataDir: dir }), runtime: { bash: false }, onEvent: tracer.onEvent,
      model: new MockLanguageModelV3({ doGenerate: async () => ({
        content: [{ type: "text", text: character.repeat(700) }],
        finishReason: { unified: "stop", raw: "stop" }, usage, warnings: [],
      }) }),
    });
    await generateHarness({ harness, session: "default-preview", prompt: "Reply." });
    await db.flush();
    const spans = fake.spansOf(tracer.traceIdFor("default-preview")!);
    expect(spans.find(span => span.type === "agent")?.output).toBe(character.repeat(512));
    expect(spans.find(span => span.type === "llm")?.output).toMatchObject({ text: character.repeat(512) });
  });

  it("sends each turn as a trace: the turn, its model calls and its tool calls", async () => {
    const fake = fakeLittleDB();
    const db = createLittleDB({ url: fake.url, apiKey: fake.apiKey, fetch: fake.fetch });
    const tracer = db.harnessTracer({
      harness: "support",
      resolution: { versionId: "ver_7", mode: "trial" },
      userId: "u1",
      tags: ["test"],
    });
    const harness = await harnessWith(tracer.onEvent);
    await generateHarness({ harness, session: "sess_1", prompt: "Where is order A1?" });
    await db.flush();

    const traceId = tracer.traceIdFor("sess_1");
    expect(traceId).toBeDefined();
    expect(traceId).toMatch(/^lh_[0-9a-f]{32}$/u);
    expect(fake.traces.get(traceId!)).toMatchObject({
      kind: "turn",
      harness: "support",
      versionId: "ver_7",
      sessionId: "sess_1",
      userId: "u1",
      environment: "trial",
      tags: ["test"],
    });

    const spans = fake.spansOf(traceId!);
    const root = spans.find((span) => span.id === "turn");
    expect(root).toMatchObject({ type: "agent", status: "ok", input: "Where is order A1?", output: "Your order A1 shipped." });
    expect(root?.parentId).toBeUndefined();

    const llm = spans.filter((span) => span.type === "llm");
    expect(llm).toHaveLength(2);
    expect(llm.every((span) => span.parentId === "turn" && span.status === "ok")).toBe(true);
    expect(llm[0]).toMatchObject({
      model: "claude-test",
      provider: "anthropic",
      usage: { inputTokens: 200, outputTokens: 40, cacheReadTokens: 700, cacheWriteTokens: 100 },
    });
    const first = llm.find((span) => (span.output as { toolCalls?: unknown[] }).toolCalls !== undefined);
    expect(first?.output).toMatchObject({ toolCalls: [{ toolName: "lookup_order", input: { orderId: "A1" } }] });
    expect(JSON.stringify(first?.input)).toContain("Where is order A1?");

    const toolSpan = spans.find((span) => span.type === "tool");
    expect(toolSpan).toMatchObject({
      name: "lookup_order",
      parentId: "turn",
      status: "ok",
      input: { orderId: "A1" },
      output: { orderId: "A1", status: "shipped" },
    });
    expect(fake.spans.size).toBe(spans.length);
  });

  it("takes as the turn's output everything it said, including text written before a tool call", async () => {
    const fake = fakeLittleDB();
    const db = createLittleDB({ url: fake.url, apiKey: fake.apiKey, fetch: fake.fetch });
    const tracer = db.harnessTracer({ harness: "support" });
    const harness = await harnessWith(tracer.onEvent, "Let me look that up.");
    await generateHarness({ harness, session: "sess_said", prompt: "Where is order A1?" });
    await db.flush();

    const root = fake.spansOf(tracer.traceIdFor("sess_said")!).find((span) => span.id === "turn");
    expect(root?.output).toBe("Let me look that up.\n\nYour order A1 shipped.");
  });

  it("gives each turn its own trace, and keeps a session's traces in order", async () => {
    const fake = fakeLittleDB();
    const db = createLittleDB({ url: fake.url, apiKey: fake.apiKey, fetch: fake.fetch });
    const tracer = db.harnessTracer({ harness: "support" });
    const harness = await harnessWith(tracer.onEvent);
    await generateHarness({ harness, session: "sess_2", prompt: "Hi" });
    await generateHarness({ harness, session: "sess_2", prompt: "And order A1?" });
    await db.flush();
    const ids = tracer.traceIdsFor("sess_2");
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    expect(fake.traces.get(ids[0]!)?.environment).toBe("production");
    expect(fake.spansOf(ids[1]!).find((s) => s.id === "turn")?.input).toBe("And order A1?");
  });

  it("puts every turn in one trace under a root span when given a trace id", async () => {
    const fake = fakeLittleDB();
    const db = createLittleDB({ url: fake.url, apiKey: fake.apiKey, fetch: fake.fetch });
    const tracer = db.harnessTracer({
      harness: "support",
      traceId: "exp_run_1",
      versionId: "ver_9",
      environment: "experiment",
      experimentId: "exp_1",
      datasetItemId: "itm_1",
    });
    const harness = await harnessWith(tracer.onEvent);
    await generateHarness({ harness, session: "episode", prompt: "First" });
    await generateHarness({ harness, session: "episode", prompt: "Second" });
    await db.flush();

    expect([...fake.traces.keys()]).toEqual(["exp_run_1"]);
    expect(fake.traces.get("exp_run_1")).toMatchObject({ kind: "experiment", experimentId: "exp_1", datasetItemId: "itm_1", versionId: "ver_9" });
    const spans = fake.spansOf("exp_run_1");
    const root = spans.find((span) => span.id === "root");
    expect(root).toMatchObject({ name: "session", status: "ok", input: "First", output: "Your order A1 shipped." });
    const turns = spans.filter((span) => span.type === "agent" && span.id !== "root");
    expect(turns).toHaveLength(2);
    expect(turns.every((span) => span.parentId === "root")).toBe(true);
    const llm = spans.filter((span) => span.type === "llm");
    expect(new Set(llm.map((span) => span.parentId))).toEqual(new Set(turns.map((t) => t.id)));
  });

  it("gives back the trace of a turn from its turn id, as the tracer wrote it", async () => {
    const fake = fakeLittleDB();
    const db = createLittleDB({ url: fake.url, apiKey: fake.apiKey, fetch: fake.fetch });
    const tracer = db.harnessTracer({ harness: "support" });
    let turnId: string | undefined;
    const harness = await harnessWith(async (event) => {
      turnId ??= event.turnId;
      await tracer.onEvent(event);
    });
    await generateHarness({ harness, session: "sess_3", prompt: "Hi" });
    await db.flush();
    expect(turnId).toBeDefined();
    expect(tracer.traceIdForTurn("sess_3", turnId!)).toBe(tracer.traceIdFor("sess_3"));
    expect(tracer.traceIdForTurn("sess_3", turnId!)).toBe(turnTraceId("sess_3", turnId!));
    expect(fake.traces.has(tracer.traceIdForTurn("sess_3", turnId!))).toBe(true);

    const custom = db.harnessTracer({ harness: "support", traceIdFor: (sessionId, turn) => `mine_${sessionId}_${turn}` });
    expect(custom.traceIdForTurn("s", "t")).toBe("mine_s_t");
    expect(db.harnessTracer({ harness: "support", traceId: "exp_run_2" }).traceIdForTurn("s", "t")).toBe("exp_run_2");
  });

  it("puts how the turn started on its trace", async () => {
    const fake = fakeLittleDB();
    const db = createLittleDB({ url: fake.url, apiKey: fake.apiKey, fetch: fake.fetch });
    const tracer = db.harnessTracer({ harness: "support" });
    const harness = await harnessWith(tracer.onEvent);
    await generateHarness({
      harness,
      session: "wa_1",
      prompt: "Where is order A1?",
      trigger: { kind: "message", source: "whatsapp", from: "+15550100", label: "x".repeat(600) },
    });
    await generateHarness({ harness, session: "wa_1", prompt: "Thanks" });
    await db.flush();

    const [first, second] = tracer.traceIdsFor("wa_1");
    expect(fake.traces.get(first!)?.trigger).toEqual({
      kind: "message",
      source: "whatsapp",
      from: "+15550100",
      label: `${"x".repeat(499)}…`,
    });
    // A turn started from the app's own code has no trigger.
    expect(fake.traces.get(second!)?.trigger).toBeUndefined();
  });

  it("puts the trigger on the turn's trace when an earlier event already began the turn", async () => {
    const fake = fakeLittleDB();
    const db = createLittleDB({ url: fake.url, apiKey: fake.apiKey, fetch: fake.fetch });
    const tracer = db.harnessTracer({ harness: "support" });
    const at = new Date().toISOString();
    await tracer.onEvent({ type: "harness.model.called", sessionId: "s", turnId: "t", timestamp: at, metadata: { stepNumber: 1 } });
    await tracer.onEvent({
      type: "harness.session.started",
      sessionId: "s",
      turnId: "t",
      timestamp: at,
      metadata: { triggerKind: "schedule", triggerSource: "morning", triggerLabel: "Work the backlog", other: 1 },
    });
    await db.flush();
    expect(fake.traces.get(turnTraceId("s", "t"))).toMatchObject({
      kind: "turn",
      sessionId: "s",
      trigger: { kind: "schedule", source: "morning", label: "Work the backlog" },
    });
  });

  it("leaves content out when asked, and never throws from onEvent", async () => {
    const fake = fakeLittleDB();
    const db = createLittleDB({ url: fake.url, apiKey: fake.apiKey, fetch: fake.fetch, onError: () => {} });
    const tracer = db.harnessTracer({ harness: "support", captureContent: false });
    const harness = await harnessWith(tracer.onEvent);
    await generateHarness({ harness, session: "private", prompt: "secret question" });
    await tracer.onEvent({ type: "harness.model.called", sessionId: "x", timestamp: "not a date", metadata: { request: 42 } } as never);
    await db.flush();
    const sent = JSON.stringify([...fake.spans.values()]);
    expect(sent).not.toContain("secret question");
    expect(sent).not.toContain("shipped");
    expect(turnTraceId("a", "b")).toBe(turnTraceId("a", "b"));
  });
});

describe("memory a step touched", () => {
  it("reads a bash command's memory paths, a search's hits, a glob's files and what the command changed", async () => {
    const spans: SpanInput[] = [];
    const links = createMemoryLinks();
    const tracer = createHarnessTracer(
      { harness: "desk" },
      { exporter: { enqueue: (batch: { spans: SpanInput[] }) => spans.push(...batch.spans) } as never, onError: () => {}, memoryLinks: links },
    );
    links.loaded("s1", "/persistent/org/rules", {
      layer: "org",
      space: "rules",
      writable: true,
      files: 3,
      revisions: { "a.md": "mrev_a", "lessons/b.md": "mrev_b", "lessons/c.md": "mrev_c" },
    });
    const event = (type: string, metadata: Record<string, unknown>) =>
      tracer.onEvent({ type, sessionId: "s1", turnId: "t1", timestamp: "2026-10-21T08:00:00.000Z", metadata });

    await event("harness.session.started", {});
    await event("harness.tool_call.started", { toolName: "bash", toolCallId: "c1", input: { command: "cat /persistent/org/rules/a.md; grep -rn self /persistent/org/rules/lessons" } });
    await event("harness.tool_call.succeeded", { toolName: "bash", toolCallId: "c1", output: { stdout: "/persistent/org/rules/lessons/b.md:2:self-employed\n", stderr: "", exitCode: 0 } });
    await event("harness.tool_call.started", { toolName: "bash", toolCallId: "c2", input: { command: "cat /persistent/org/rules/lessons/*.md && printf hi > /persistent/org/rules/new.md; cat /persistent/org/rulesbook.md" } });
    await event("harness.file.created", { path: "/persistent/org/rules/new.md", source: "tool" });
    await event("harness.tool_call.succeeded", { toolName: "bash", toolCallId: "c2", output: { stdout: "", stderr: "", exitCode: 0 } });
    await event("harness.tool_call.started", { toolName: "bash", toolCallId: "c3", input: { command: "ls /tmp" } });
    await event("harness.tool_call.succeeded", { toolName: "bash", toolCallId: "c3", output: { stdout: "", stderr: "", exitCode: 0 } });

    const [searched, wrote, elsewhere] = spans.filter((s) => s.type === "tool");
    expect(searched?.attributes?.memoryAccess).toEqual({
      how: "command",
      files: [
        { layer: "org", space: "rules", path: "a.md", op: "read", revision: "mrev_a" },
        { layer: "org", space: "rules", path: "lessons/b.md", op: "read", revision: "mrev_b" },
      ],
      listed: ["rules"],
    });
    // `rulesbook.md` is next to the memory, not in it.
    expect(wrote?.attributes?.memoryAccess).toEqual({
      how: "command",
      files: [
        { layer: "org", space: "rules", path: "lessons/b.md", op: "read", revision: "mrev_b" },
        { layer: "org", space: "rules", path: "lessons/c.md", op: "read", revision: "mrev_c" },
        { layer: "org", space: "rules", path: "new.md", op: "write" },
      ],
    });
    expect(elsewhere?.attributes?.memoryAccess).toBeUndefined();
    // The store asks which step wrote each file, once.
    expect(links.takeSteps("s1", "/persistent/org/rules")).toEqual({ "new.md": wrote!.id });
    expect(links.takeSteps("s1", "/persistent/org/rules")).toEqual({});
  });

  // --- Refocus decision 5: the tier a turn reached and what its sandbox cost, per trace ---

  it("puts the harness's runtime usage on the turn's trace row, with the vCPU-seconds worked out", async () => {
    const traces: TraceInput[] = [];
    const tracer = createHarnessTracer(
      { harness: "desk" },
      { exporter: { enqueue: (batch: { traces?: TraceInput[] }) => traces.push(...(batch.traces ?? [])) } as never, onError: () => {} },
    );
    const event = (type: string, metadata: Record<string, unknown>, turnId = "t1") =>
      tracer.onEvent({ type, sessionId: "s1", turnId, timestamp: "2026-10-21T08:00:00.000Z", metadata });

    await event("harness.session.started", {});
    await event("harness.runtime.usage", {
      tier: "next-tier",
      commands: { tier0: 2, nextTier: 3, denied: 0 },
      escalations: 1,
      sandbox: { provider: "cloudflare-sandbox", instanceType: "standard-1", vcpu: 0.5, memoryGiB: 4, diskGB: 8, activeMs: 300_000, awakeMs: 900_000, costUsd: 0.0125 },
    });
    await event("harness.session.completed", {});

    expect(traces).toHaveLength(2);
    expect(traces[0]?.compute).toBeUndefined();
    expect(traces[1]).toMatchObject({
      id: turnTraceId("s1", "t1"),
      harness: "desk",
      compute: {
        tier: "next-tier",
        provider: "cloudflare-sandbox",
        instanceType: "standard-1",
        vcpu: 0.5,
        memoryGiB: 4,
        activeMs: 300_000,
        awakeMs: 900_000,
        vcpuSeconds: 150,
        costUsd: 0.0125,
      },
    });

    // An older harness that sends the usage after the turn closed still updates the row,
    // without reopening the turn.
    await event("harness.runtime.usage", { tier: "tier-0", commands: { tier0: 1, nextTier: 0, denied: 0 }, escalations: 0, sandbox: { provider: "just-bash", activeMs: 7 } });
    expect(traces).toHaveLength(3);
    expect(traces[2]).toEqual({ id: turnTraceId("s1", "t1"), startTime: "2026-10-21T08:00:00.000Z", compute: { tier: "tier-0", provider: "just-bash", activeMs: 7 } });
    expect(tracer.traceIdsFor("s1")).toEqual([turnTraceId("s1", "t1")]);

    // An event the contract would refuse is dropped rather than refusing the batch.
    await event("harness.session.started", {}, "t2");
    await event("harness.runtime.usage", { tier: "tier-7", sandbox: { provider: "x", activeMs: 1 } }, "t2");
    await event("harness.runtime.usage", { tier: "tier-0", sandbox: { provider: "x" } }, "t2");
    expect(traces.filter((t) => t.id === turnTraceId("s1", "t2"))).toHaveLength(1);
  });

  it("maps usage metadata within the contract's limits", () => {
    expect(toLittleDBCompute({ tier: "tier-0", sandbox: { provider: "just-bash", activeMs: 12.5 } })).toEqual({ tier: "tier-0", provider: "just-bash", activeMs: 12.5 });
    expect(toLittleDBCompute({ tier: "next-tier", sandbox: { provider: "p", activeMs: 2000, vcpu: 2, awakeMs: -1, costUsd: Number.NaN, instanceType: "" } })).toEqual({
      tier: "next-tier",
      provider: "p",
      vcpu: 2,
      activeMs: 2000,
      vcpuSeconds: 4,
    });
    expect(toLittleDBCompute(undefined)).toBeUndefined();
    expect(toLittleDBCompute({ tier: "tier-0" })).toBeUndefined();
  });

  it("records a turn on the folder tier as Tier 0 on just-bash, end to end", async () => {
    const fake = fakeLittleDB();
    const db = createLittleDB({ url: fake.url, apiKey: fake.apiKey, fetch: fake.fetch });
    const tracer = db.harnessTracer({ harness: "shell" });
    const dir = await mkdtemp(join(tmpdir(), "ldb-tracer-"));
    dirs.push(dir);
    let calls = 0;
    const harness = createHarness({
      host: localHost({ dataDir: dir }),
      model: new MockLanguageModelV3({
        provider: "anthropic.messages",
        modelId: "claude-test",
        doGenerate: async () => {
          calls += 1;
          return calls === 1
            ? {
                content: [{ type: "tool-call", toolCallId: "call_1", toolName: "bash", input: JSON.stringify({ command: "echo hi > /session/hi.txt" }) }],
                finishReason: { unified: "tool-calls", raw: "tool_use" },
                usage,
                warnings: [],
              }
            : { content: [{ type: "text", text: "Done." }], finishReason: { unified: "stop", raw: "end_turn" }, usage, warnings: [] };
        },
      }),
      onEvent: tracer.onEvent,
    });
    await generateHarness({ harness, session: "sess_shell", prompt: "Write hi." });
    await db.flush();

    const trace = fake.traces.get(tracer.traceIdFor("sess_shell")!);
    expect(trace?.compute).toEqual({ tier: "tier-0", provider: "just-bash", activeMs: expect.any(Number) });
    // The row with the usage went out before the turn's spans closed it.
    expect(fake.spansOf(trace!.id).find((span) => span.id === "turn")?.status).toBe("ok");
  });
});
