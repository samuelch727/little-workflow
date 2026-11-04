import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { MockLanguageModelV3 } from "ai/test";
import { tool } from "ai";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { createHarness } from "../create-harness.js";
import { streamHarness } from "../execution/stream-harness.js";
import { generateHarness } from "../execution/generate-harness.js";
import { harnessToolContext } from "../connectors/tool-context.js";
import { localHost } from "../local-host/index.js";
import type { HarnessSessionLog, PersistedDurableHarnessEvent } from "../events/occurrence.js";
import type { Harness } from "../types.js";
import { withTempDir } from "../test/temp.js";
import { startAgentServer, type AgentServerOptions } from "./agent-server.js";
import { callerDelivery } from "./caller-delivery.js";
import { deliveryLedger, dispatchRunId } from "./delivery-ledger.js";
import { stableHash } from "../utils/canonical-hash.js";

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
type Reply = { text: string } | { tool: string };
function scripted(reply: (prompt: unknown) => Reply | Promise<Reply>, calls: unknown[]) {
  const response = async (prompt: unknown) => {
    calls.push(prompt); const next = await reply(prompt);
    return { content: "text" in next ? [{ type: "text" as const, text: next.text }] : [{ type: "tool-call" as const, toolCallId: `call_${calls.length}`, toolName: next.tool, input: "{}" }], finishReason: { unified: "text" in next ? "stop" as const : "tool-calls" as const, raw: "stop" }, usage, warnings: [] };
  };
  return new MockLanguageModelV3({ doGenerate: async ({ prompt }) => response(prompt), doStream: async ({ prompt }) => {
    const r = await response(prompt);
    return { stream: new ReadableStream({ start(c) { c.enqueue({ type: "stream-start", warnings: [] }); for (const part of r.content) { if (part.type === "text") { c.enqueue({ type: "text-start", id: "t" }); c.enqueue({ type: "text-delta", id: "t", delta: part.text }); c.enqueue({ type: "text-end", id: "t" }); } else c.enqueue(part); } c.enqueue({ type: "finish", finishReason: r.finishReason, usage }); c.close(); } }) };
  } });
}
const post = (url: string, body: unknown) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const get = async (url: string) => { const r = await fetch(url); return { status: r.status, body: await r.json() }; };
const latch = () => { let release!: () => void; const promise = new Promise<void>((r) => { release = r; }); return { promise, release }; };
const eventually = async (read: () => Promise<boolean>) => { for (let i = 0; i < 150; i++) { if (await read()) return; await new Promise((r) => setTimeout(r, 5)); } throw new Error("Expected state did not arrive"); };
async function fixture(build: (dataDir: string) => Harness, run: (f: { dataDir: string; start: (o?: Partial<AgentServerOptions>) => ReturnType<typeof startAgentServer> }) => Promise<void>) {
  await withTempDir(async (dir) => { const agentDir = join(dir, "agent"), dataDir = join(dir, "data"); await mkdir(agentDir); await run({ dataDir, start: (o) => startAgentServer({ agentDir, agentName: "synthetic", port: 0, dataDir, resume: "caller", log: () => undefined, loadHarness: async () => build(dataDir), ...o }) }); });
}
const inputHash = (prompt: string) => stableHash({ prompt, messages: null, extraBody: null, trigger: null });

describe("identified caller dispatches", () => {
  it("fences a start delayed in async parsing, survives restart, and leaves legacy timer APIs unchanged", async () => {
    const calls: unknown[] = [], entered = latch(), wait = latch(); let hold = true;
    await fixture((dataDir) => createHarness({ host: localHost({ dataDir, sandbox: "in-process" }), runtime: { bash: false }, model: scripted(() => ({ text: "done" }), calls) }), async (f) => {
      let server = await f.start({ parseExtraBody: async (v) => { if (hold) { hold = false; entered.release(); await wait.promise; } return v; } });
      const delayed = post(`${server.url}/sessions/s/messages`, { dispatchId: "a", prompt: "start" }); await entered.promise;
      expect((await post(`${server.url}/sessions/s/stop`, { expectedDispatchId: "a" })).status).toBe(200);
      wait.release(); expect((await delayed).status).toBe(409); expect(calls).toHaveLength(0); await server.close();
      server = await f.start(); expect((await post(`${server.url}/sessions/s/messages`, { dispatchId: "a", prompt: "start" })).status).toBe(409); expect(calls).toHaveLength(0); await server.close();
      server = await f.start({ resume: "timer" });
      for (const [route, body] of [["messages", { dispatchId: "x", prompt: "new" }], ["staged", { dispatchId: "x", messageId: "m", text: "new" }], ["stop", { expectedDispatchId: "x" }]] as const) expect((await post(`${server.url}/sessions/s/${route}`, body)).status).toBe(400);
      expect((await post(`${server.url}/sessions/legacy/messages`, { prompt: "legacy" })).status).toBe(200); await server.close();
    });
  });

  it("acknowledges completed multi-step starts without another invocation, and old retries cannot displace a successor", async () => {
    const calls: unknown[] = [], secondEntered = latch(), secondWait = latch(); let effects = 0;
    await fixture((dataDir) => createHarness({ host: localHost({ dataDir, sandbox: "in-process" }), runtime: { bash: false }, turnOptions: async () => ({ prepareStep: () => ({}) }), model: scripted(async (prompt) => { if (JSON.stringify(prompt).includes("successor")) { secondEntered.release(); await secondWait.promise; return { text: "b done" }; } return JSON.stringify(prompt).includes('"role":"tool"') ? { text: "a done" } : { tool: "read_once" }; }, calls), tools: { read_once: tool({ inputSchema: z.object({}), execute: async () => { effects++; return "read"; } }) } }), async (f) => {
      const server = await f.start(); const a = { dispatchId: "a", prompt: "initial" };
      const response = await post(`${server.url}/sessions/s/messages`, a); await response.body?.cancel(); expect(calls).toHaveLength(2); expect(effects).toBe(1);
      const b = post(`${server.url}/sessions/s/messages`, { dispatchId: "b", prompt: "successor" }); await secondEntered.promise;
      expect(await (await post(`${server.url}/sessions/s/messages`, a)).json()).toMatchObject({ accepted: true, dispatchStatus: "finished" });
      expect((await get(`${server.url}/sessions/s/turn`)).body.dispatchId).toBe("b");
      expect((await post(`${server.url}/sessions/s/stop`, { expectedDispatchId: "a" })).status).toBe(200);
      expect((await get(`${server.url}/sessions/s/turn?dispatchId=b`)).body.state).toBe("running");
      secondWait.release(); expect((await b).status).toBe(200); expect(calls).toHaveLength(3); expect(effects).toBe(1);
      expect((await post(`${server.url}/sessions/s/messages`, { ...a, prompt: "different" })).status).toBe(409); await server.close();
    });
  });

  it("does not revive an interrupted initial dispatch after a successor was admitted", async () => {
    const calls: unknown[] = [];
    await fixture((dataDir) => createHarness({ host: localHost({ dataDir, sandbox: "in-process" }), runtime: { bash: false }, model: scripted(() => ({ text: "done" }), calls) }), async (f) => {
      await deliveryLedger(f.dataDir).admit("s", "old", inputHash("old"));
      const server = await f.start();
      expect((await post(`${server.url}/sessions/s/messages`, { dispatchId: "new", prompt: "new" })).status).toBe(409);
      await post(`${server.url}/sessions/s/stop`, { expectedDispatchId: "old" });
      await post(`${server.url}/sessions/s/messages`, { dispatchId: "new", prompt: "new" });
      expect((await post(`${server.url}/sessions/s/messages`, { dispatchId: "old", prompt: "old" })).status).toBe(409);
      expect((await get(`${server.url}/sessions/s/turn`)).body.dispatchId).toBe("new"); expect(calls).toHaveLength(1); await server.close();
    });
  });

  it("keeps staged message identities through a park and restart; duplicate text remains two messages", async () => {
    const calls: unknown[] = []; let executions = 0;
    await fixture((dataDir) => createHarness({ host: localHost({ dataDir, sandbox: "in-process" }), runtime: { bash: false }, humanInput: { tool: false, deliver: async () => undefined }, model: scripted((prompt) => JSON.stringify(prompt).includes('"role":"tool"') ? { text: "continued" } : { tool: "wait_person" }, calls), tools: { wait_person: tool({ inputSchema: z.object({}), execute: async (_i, options) => { executions++; const asked = await harnessToolContext(options).ask!({ question: "Continue?", options: [{ id: "yes", label: "Yes" }] }, { key: "question", wait: true }); return asked.status === "parked" ? asked.output : "answered"; } }) } }), async (f) => {
      let server = await f.start(); expect((await post(`${server.url}/sessions/s/messages`, { dispatchId: "a", prompt: "start" })).status).toBe(200);
      for (const messageId of ["m1", "m1", "m2"]) expect((await post(`${server.url}/sessions/s/staged`, { dispatchId: "a", messageId, text: "same arrival" })).status).toBe(202);
      expect((await post(`${server.url}/sessions/s/staged`, { dispatchId: "a", messageId: "m1", text: "conflict" })).status).toBe(409); await server.close();
      server = await f.start(); expect((await get(`${server.url}/sessions/s/staged/m1`)).body.state).toBe("accepted");
      await post(`${server.url}/sessions/s/questions/answer`, { key: "question", option: "yes" });
      expect((await post(`${server.url}/sessions/s/resume`, { dispatchId: "a", resumeId: "a:2" })).status).toBe(200);
      await eventually(async () => (await get(`${server.url}/sessions/s/turn?dispatchId=a`)).body.dispatchStatus === "finished");
      expect(JSON.stringify(calls.at(-1)).match(/same arrival/g)).toHaveLength(2); expect(executions).toBe(2);
      const first = (await get(`${server.url}/sessions/s/staged/m1`)).body; const second = (await get(`${server.url}/sessions/s/staged/m2`)).body;
      expect(first).toMatchObject({ state: "read", messageId: "m1", dispatchId: "a", occurrenceId: expect.any(String) }); expect(second.occurrenceId).toBe(first.occurrenceId);
      expect((await post(`${server.url}/sessions/s/staged`, { dispatchId: "a", messageId: "m1", text: "same arrival" })).status).toBe(202);
      await post(`${server.url}/sessions/s/messages`, { dispatchId: "b", prompt: "successor" });
      expect((await post(`${server.url}/sessions/s/staged`, { dispatchId: "a", messageId: "late", text: "old arrival" })).status).toBe(409);
      expect((await get(`${server.url}/sessions/s/staged/late`)).body.state).toBe("unread");
      expect((await post(`${server.url}/sessions/s/staged`, { dispatchId: "b", messageId: "m1", text: "same arrival" })).status).toBe(409); await server.close();
    });
  });

  it("restores a staged first-request placement before completed-response replay", async () => {
    const calls: unknown[] = [];
    await withTempDir(async (dataDir) => {
      const harness = createHarness({ host: localHost({ dataDir, sandbox: "in-process" }), runtime: { bash: false }, model: scripted(() => ({ text: "seen" }), calls) });
      const delivery = callerDelivery(harness, dataDir), runId = dispatchRunId("s", "a"); await delivery.ledger.admit("s", "a", "input"); await delivery.ledger.stage("s", "a", "m", "staged before model");
      const run = () => generateHarness({ harness, session: "s", prompt: "initial", runId, sessionLog: delivery.logFor(runId), inbox: delivery.inbox("s", "a", runId) });
      await run();
      // Replaying a known response restores the original inbox placement before hashing it.
      await run(); expect(calls).toHaveLength(1); expect(JSON.stringify(calls[0])).toContain("staged before model");
    });
  });
  it("uses authoritative scoped paths and pins session mode without cancelling legacy work", async () => {
    const calls: unknown[] = [];
    await fixture((dataDir) => createHarness({ host: localHost({ dataDir, sandbox: "in-process" }), runtime: { bash: false }, model: scripted(() => ({ text: "done" }), calls) }), async (f) => {
      const server = await f.start(); const base = `${server.url}/sessions/s/dispatches/a`;
      expect((await post(`${base}/stop`, { dispatchId: "b" })).status).toBe(409);
      expect((await post(`${base}/stop/unknown`, {})).status).toBe(404);
      expect((await post(`${base}/stop`, {})).status).toBe(200);
      for (const route of ["stop", "staged", "messages", "resume"]) expect((await post(`${server.url}/sessions/s/${route}`, { prompt: "legacy", text: "legacy", resumeId: "x" })).status).toBe(409);
      expect((await post(`${base}/messages`, { prompt: "late" })).status).toBe(409);
      expect((await post(`${server.url}/sessions/legacy/messages`, { prompt: "legacy" })).status).toBe(200);
      for (const route of ["messages", "stop", "resume", "staged/m"]) expect((await post(`${server.url}/sessions/legacy/dispatches/new/${route}`, { prompt: "new", text: "new", resumeId: "new" })).status).toBe(409);
      expect(calls).toHaveLength(1); await server.close();
    });
  });

  it("blocks provider and waiting-tool effects when cancelled during host preparation", async () => {
    const calls: unknown[] = [], entered = latch(), wait = latch(); let held = false;
    await fixture((dataDir) => {
      const host = localHost({ dataDir, sandbox: "in-process" });
      return createHarness({ host: { ...host, prepareTurn: async (input) => { entered.release(); await wait.promise; held = true; return host.prepareTurn(input); } }, runtime: { bash: false }, model: scripted(() => ({ text: "should not run" }), calls) });
    }, async (f) => {
      const server = await f.start(), base = `${server.url}/sessions/s/dispatches/a`;
      const start = post(`${base}/messages`, { prompt: "start" }); await entered.promise;
      expect((await post(`${base}/stop`, {})).status).toBe(200); wait.release(); await start;
      expect(held).toBe(true); expect(calls).toHaveLength(0); await server.close();
    });
  });

  it("holds identified requests when their durable replay log is unsupported or unreadable", async () => {
    const calls: unknown[] = [];
    await fixture((dataDir) => createHarness({ host: localHost({ dataDir, sandbox: "in-process" }), runtime: { bash: false }, sessionLog: { append: async () => undefined }, model: scripted(() => ({ text: "should not run" }), calls) }), async (f) => {
      const server = await f.start(); expect((await post(`${server.url}/sessions/s/dispatches/a/messages`, { prompt: "start" })).status).toBe(503); expect(calls).toHaveLength(0); await server.close();
    });
  });

  it("does not let delayed initial replay proof end a newer resumed run or sweep its messages", async () => withTempDir(async (dir) => {
    const entered = latch(), wait = latch(), initial = dispatchRunId("s", "a");
    const log = { append: async () => undefined, priorEvents: async ({ runId }: { runId: string }) => { if (runId !== initial) return []; entered.release(); await wait.promise; return [{ type: "harness.session.completed", runId, payload: { turnId: "initial-turn" } }] as PersistedDurableHarnessEvent[]; } } as unknown as HarnessSessionLog;
    const harness = createHarness({ host: localHost({ dataDir: dir, sandbox: "in-process" }), runtime: { bash: false }, sessionLog: log, model: scripted(() => ({ text: "unused" }), []) });
    const caller = callerDelivery(harness, dir); await caller.ledger.admit("s", "a", "input");
    const delayed = caller.reconcile("s", "a"); await entered.promise;
    await caller.ledger.addRun("s", "a", "resume-run", "caller-resume"); await caller.ledger.stage("s", "a", "new", "new input"); wait.release(); await delayed;
    expect((await caller.ledger.get("s", "a"))!.state).toBe("running"); expect((await caller.ledger.message("s", "new"))!.state).toBe("accepted");
  }));

  it.each(["generate", "stream"])("fails closed before actual %s provider I/O when inbox occurrence persistence fails", async (api) => withTempDir(async (dir) => {
    const calls: unknown[] = [];
    const harness = createHarness({ host: localHost({ dataDir: dir, sandbox: "in-process" }), runtime: { bash: false }, model: scripted(() => ({ text: "must not run" }), calls) });
    const options = { harness, session: "s", prompt: "start", beforeInvocation: async () => undefined, inbox: { take: () => [], modelRequested: async () => { throw new Error("claim ledger unavailable"); } } };
    await expect(api === "generate" ? generateHarness(options) : streamHarness(options).finished).rejects.toThrow(/claim ledger unavailable/); expect(calls).toHaveLength(0);
  }));

  it("cancels a resumed waiting tool while host preparation is blocked", async () => {
    const calls: unknown[] = [], entered = latch(), wait = latch(); let prepares = 0, effects = 0;
    await fixture((dataDir) => {
      const host = localHost({ dataDir, sandbox: "in-process" });
      return createHarness({ host: { ...host, prepareTurn: async (input) => { if (++prepares > 1) { entered.release(); await wait.promise; } return host.prepareTurn(input); } }, runtime: { bash: false }, humanInput: { tool: false, deliver: async () => undefined }, model: scripted(() => ({ tool: "wait_person" }), calls), tools: { wait_person: tool({ inputSchema: z.object({}), execute: async (_input, options) => { effects++; const asked = await harnessToolContext(options).ask!({ question: "Continue?", options: [{ id: "yes", label: "Yes" }] }, { key: "q", wait: true }); return asked.status === "parked" ? asked.output : "answered"; } }) } });
    }, async (f) => {
      const server = await f.start(), base = `${server.url}/sessions/s/dispatches/a`;
      await post(`${base}/messages`, { prompt: "start" }); expect(effects).toBe(1);
      await post(`${server.url}/sessions/s/questions/answer`, { key: "q", option: "yes" });
      const resumed = post(`${base}/resume`, { resumeId: "r" }); await entered.promise;
      await post(`${base}/stop`, {}); wait.release(); await resumed;
      await eventually(async () => (await get(`${base}/turn`)).body.dispatchStatus === "cancelled");
      expect(effects).toBe(1); expect(calls).toHaveLength(1); await server.close();
    });
  });

});
