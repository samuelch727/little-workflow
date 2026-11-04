// Runs the client against a real LittleDB server. Skipped unless one answers at
// LITTLEDB_TEST_URL (default http://127.0.0.1:7340), e.g. `littledb dev` on this machine:
//   LITTLEDB_TEST_URL=http://127.0.0.1:7340 LITTLEDB_TEST_API_KEY=ldb_dev_local_key pnpm test
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarness, generateHarness, localHost } from "@little-stack/harness";
import { tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createLittleDB } from "./client.js";
import type { HarnessTracer } from "./harness/tracer.js";

const url = process.env.LITTLEDB_TEST_URL ?? "http://127.0.0.1:7340";
const apiKey = process.env.LITTLEDB_TEST_API_KEY ?? "ldb_dev_local_key";

async function reachable(): Promise<boolean> {
  try {
    const response = await fetch(`${url.replace(/\/+$/u, "").replace(/\/v1$/u, "")}/healthz`, { signal: AbortSignal.timeout(1_000) });
    return response.ok;
  } catch {
    return false;
  }
}

const live = await reachable();
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

function harness(onEvent: HarnessTracer["onEvent"], system: string) {
  let calls = 0;
  const model = new MockLanguageModelV3({
    provider: "anthropic.messages",
    modelId: "claude-haiku-5-5",
    doGenerate: async () => {
      calls += 1;
      const usage = {
        inputTokens: { total: 1200, noCache: 200, cacheRead: 1000, cacheWrite: 0 },
        outputTokens: { total: 30, text: 30, reasoning: 0 },
      };
      return calls % 2 === 1
        ? {
            content: [{ type: "tool-call" as const, toolCallId: `c${calls}`, toolName: "lookup_order", input: '{"orderId":"A1"}' }],
            finishReason: { unified: "tool-calls" as const, raw: "tool_use" },
            usage,
            warnings: [],
          }
        : { content: [{ type: "text" as const, text: "Order A1 shipped." }], finishReason: { unified: "stop" as const, raw: "end_turn" }, usage, warnings: [] };
    },
  });
  return mkdtemp(join(tmpdir(), "ldb-live-")).then((dir) => {
    dirs.push(dir);
    return createHarness({
      host: localHost({ dataDir: dir }),
      model,
      system,
      runtime: { bash: false },
      trace: { content: { previewBytes: 65_536 } },
      tools: {
        lookup_order: tool({
          description: "Look an order up.",
          inputSchema: z.object({ orderId: z.string() }),
          execute: async ({ orderId }) => ({ orderId, status: "shipped" }),
        }),
      },
      onEvent,
    });
  });
}

type TraceDetail = {
  trace: { id: string; status: string; versionId: string | null; experimentId: string | null; environment: string; input: unknown; output: unknown; costUsd?: number | string | null };
  spans: Array<{ id: string; parentId: string | null; type: string; inputTokens?: number; costUsd?: number | string | null }>;
  scores: Array<{ id: string; name: string; value: number | null; source: string }>;
};

describe.skipIf(!live)(`live LittleDB at ${url}`, { timeout: 30_000 }, () => {
  const errors: unknown[] = [];
  const db = createLittleDB({ url, apiKey, flushIntervalMs: 100, onError: (error) => errors.push(error) });
  const slug = `client-live-${suffix}`;

  afterAll(async () => {
    await db.shutdown();
    expect(errors).toEqual([]);
  });

  it("resolves, traces a turn, and scores it", async () => {
    const resolution = await db.resolve({ kind: "harness", slug, stickyKey: "sess_live", bootstrap: { system: "Be brief.", model: "fast" } });
    expect(resolution).toMatchObject({ mode: "live", number: 1, content: { system: "Be brief.", model: "fast" } });
    expect(resolution.versionId).toMatch(/^ver_/u);

    const tracer = db.harnessTracer({ harness: slug, resolution, userId: "u_live" });
    const agent = await harness(tracer.onEvent, String(resolution.content?.system));
    await generateHarness({ harness: agent, session: "sess_live", prompt: "Where is order A1?" });
    const traceId = tracer.traceIdFor("sess_live")!;
    const scoreId = db.score({ traceId, name: "task_success", value: 0 });
    db.score({ traceId, name: "task_success", value: 1, comment: "regraded" });
    await db.flush();

    const detail = await db.request<TraceDetail>("GET", `/traces/${traceId}`);
    expect(detail.trace).toMatchObject({ status: "ok", versionId: resolution.versionId, environment: "production", input: "Where is order A1?", output: "Order A1 shipped." });
    expect(detail.spans.filter((s) => s.type === "llm")).toHaveLength(2);
    expect(detail.spans.filter((s) => s.type === "tool")).toHaveLength(1);
    expect(detail.spans.find((s) => s.type === "llm")).toMatchObject({ inputTokens: 200, cacheReadTokens: 1000, outputTokens: 30 });
    expect(Number(detail.spans.find((s) => s.type === "llm")?.costUsd ?? 0)).toBeGreaterThan(0);
    expect(detail.scores).toEqual([expect.objectContaining({ id: scoreId, name: "task_success", value: 1, source: "app" })]);
  });

  it("puts agent-made workflows behind review", async () => {
    const registry = db.agentWorkflowRegistry({ harness: slug, cacheTtlMs: 0 });
    const record = {
      id: `refund.check${suffix}`,
      handle: `refund_check${suffix}`,
      description: "Check whether an order can be refunded.",
      inputSchema: { type: "object", properties: { orderId: { type: "string" } } },
      outputSchema: { type: "object" },
      tools: ["lookup_order"],
      revision: 1,
      definedAt: new Date().toISOString(),
      sessionId: "sess_author",
    };
    const defined = await registry.defined(record, { sessionId: "sess_author", turnId: "t1" });
    expect(defined.metadata.littledb).toMatchObject({ status: "draft", proposalId: expect.stringMatching(/^prp_/u) });
    expect(await registry.resolve([record], { sessionId: "sess_author", turnId: "t2" })).toHaveLength(1);
    expect(await registry.resolve([record], { sessionId: "sess_other", turnId: "t1" })).toEqual([]);

    await db.request("POST", `/subjects/${encodeURIComponent(`workflow:${record.handle}`)}/promote`, { versionId: defined.metadata.littledb.versionId });
    const offered = await registry.resolve([], { sessionId: "sess_other", turnId: "t2" });
    expect(offered).toEqual([expect.objectContaining({ handle: record.handle, revision: 1, metadata: { littledb: expect.objectContaining({ status: "live" }) } })]);
  });

  it("runs an experiment in an eval worker", async () => {
    const { dataset } = await db.request<{ dataset: { id: string } }>("POST", "/datasets", { name: `client-live-${suffix}`, subject: `harness:${slug}` });
    await db.request("POST", `/datasets/${dataset.id}/items`, {
      items: [
        { input: { question: "Where is order A1?" }, expected: { contains: "shipped" } },
        { input: { question: "Has A1 shipped?" }, expected: { contains: "shipped" } },
      ],
    });
    const { version } = await db.request<{ version: { id: string } }>("POST", `/subjects/${encodeURIComponent(`harness:${slug}`)}/versions`, {
      content: { system: "Be brief and kind.", model: "fast" },
    });
    const { experiment } = await db.request<{ experiment: { id: string } }>("POST", "/experiments", {
      subject: `harness:${slug}`,
      datasetId: dataset.id,
      candidateVersionId: version.id,
    });

    const worker = db.evalWorker({
      subjects: [`harness:${slug}`],
      concurrency: 2,
      run: async (run) => {
        const tracer = db.harnessTracer({ harness: slug, ...run.trace });
        const agent = await harness(tracer.onEvent, String(run.version?.content.system));
        const result = await generateHarness({ harness: agent, session: run.runId, prompt: String((run.item?.input as { question: string }).question) });
        const text = "text" in result ? result.text : "";
        return { output: text, scores: [{ name: "task_success", value: text.includes("shipped") ? 1 : 0 }] };
      },
    });
    let done = 0;
    for (let i = 0; i < 5 && done < 2; i += 1) done += (await worker.runOnce()).completed;
    expect(done).toBe(2);

    const detail = await db.request<{ progress: { total: number; done: number }; rows: Array<{ candidate: Array<{ traceId: string; scores: Array<{ value: number }> }> }> }>(
      "GET",
      `/experiments/${experiment.id}`,
    );
    expect(detail.progress).toMatchObject({ total: 2, done: 2 });
    const traceId = detail.rows[0]!.candidate[0]!.traceId;
    const trace = await db.request<TraceDetail>("GET", `/traces/${traceId}`);
    expect(trace.trace).toMatchObject({ experimentId: experiment.id, versionId: version.id, environment: "experiment", status: "ok" });
    expect(trace.spans.find((s) => s.id === "root")?.parentId ?? null).toBeNull();
    expect(trace.scores.map((s) => s.name)).toContain("task_success");
  });
});
