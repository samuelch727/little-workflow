import type { ModelMessage } from "ai";
import { expect, it, vi } from "vitest";
import { inMemorySessionLog } from "../remote-session/session-log-store.js";
import { compactContext } from "./policy.js";
import { contextSessionLogStore } from "./log-store.js";

const model = { providerId: "fake", modelId: "fake", contextWindow: { tokens: 100000, source: "synthetic" }, maxOutputTokens: 1024, inputUsdPerMillion: 1, outputUsdPerMillion: 1 };
const policy = { triggerTokens: 4000, keepLastTurns: 1, maxCompactionCostUsdPerSession: 1 };
const history = (): ModelMessage[] => [{ role: "user", content: "old facts ".repeat(1000) }, { role: "assistant", content: "acknowledged" }, { role: "user", content: "current" }];
it("summarizes a reused prefix with only newly covered source and preserves cumulative session spend", async () => {
  const log = inMemorySessionLog();
  const requests: unknown[] = [];
  const summarize = vi.fn(async (request: { messages: readonly ModelMessage[] }) => {
    requests.push(structuredClone(request.messages));
    return { text: `summary-${requests.length}`, inputTokens: 100, outputTokens: 10 };
  });
  const runtime = (runId: string) => ({ runId, model, summarize, store: contextSessionLogStore({ log, sessionId: "s", isCurrent: async () => true }) });
  const first = history();
  await compactContext({ sessionId: "s", messages: first, policy, runtime: runtime("one"), system: "pins" });
  const extended: ModelMessage[] = [...first, { role: "assistant", content: "answer" }, { role: "user", content: "new facts ".repeat(1000) }, { role: "assistant", content: "answer" }, { role: "user", content: "latest" }];
  const result = await compactContext({ sessionId: "s", messages: extended, policy, runtime: runtime("two"), system: "pins" });
  expect(summarize).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(requests[1])).toContain("summary-1");
  expect(JSON.stringify(requests[1])).toContain("new facts ".repeat(1000));
  expect(JSON.stringify(requests[1])).not.toContain("old facts ".repeat(1000));
  expect(await compactContext({ sessionId: "s", messages: extended, policy, runtime: runtime("restart"), system: "pins" })).toEqual(result);
  expect(summarize).toHaveBeenCalledTimes(2);
  const commits = log.events.filter(event => event.type === "harness.context.attempt" && event.payload?.status === "committed");
  expect(commits).toHaveLength(2);
  expect(commits.every(event => Number(event.payload?.actualUsd) > 0)).toBe(true);
});
it("reuses validated prefix after restart, appends exact suffix, and rejects rewound/divergent/fork sources", async () => {
  const log = inMemorySessionLog();
  const summarize = vi.fn(async () => ({ text: "old facts", inputTokens: 100, outputTokens: 10 }));
  const runtime = (sessionId = "s", runId = "turn1") => ({ runId, model, summarize, store: contextSessionLogStore({ log, sessionId, isCurrent: async () => true }) });
  const source = history();
  const initial = await compactContext({ sessionId: "s", messages: source, policy, runtime: runtime(), system: "pins" });
  const extended = [...source, { role: "assistant" as const, content: "answer" }, { role: "user" as const, content: "next" }];
  const result = await compactContext({ sessionId: "s", messages: extended, policy, runtime: runtime("s", "turn2"), system: "pins" });
  expect(result).toEqual([initial[0], ...extended.slice(2)]);
  expect(summarize).toHaveBeenCalledTimes(1);
  // Rewind inside the covered prefix: the old summary cannot be grafted onto shorter history.
  const rewind = source.slice(0, 1);
  expect(await compactContext({ sessionId: "s", messages: rewind, policy, runtime: runtime("s", "turn3"), system: "pins" })).toEqual(rewind);
  // Same count but changed historical content has a different prefix fingerprint.
  const divergent = [{ role: "user" as const, content: "different facts ".repeat(1000) }, ...source.slice(1)];
  await compactContext({ sessionId: "s", messages: divergent, policy, runtime: runtime("s", "turn4"), system: "pins" });
  expect(summarize).toHaveBeenCalledTimes(2);
  // Fork isolation: a new session never silently inherits another session's checkpoints/budget.
  await compactContext({ sessionId: "fork", messages: source, policy, runtime: runtime("fork", "turn1"), system: "pins" });
  expect(summarize).toHaveBeenCalledTimes(3);
});
it("durably blocks a second summary in the same run after unknown failure and process restart", async () => {
  const log = inMemorySessionLog();
  const summarize = vi.fn(async () => { throw new Error("unknown provider outcome"); });
  const runtime = () => ({ runId: "same-run", model, summarize, store: contextSessionLogStore({ log, sessionId: "s", isCurrent: async () => true }) });
  const source = history();
  await compactContext({ sessionId: "s", messages: source, policy, runtime: runtime() });
  await expect(compactContext({ sessionId: "s", messages: [...source, { role: "user", content: "more" }], policy, runtime: runtime() })).rejects.toThrow("attempt_inflight_unknown_or_budget_denied");
  expect(summarize).toHaveBeenCalledTimes(1);
  expect(log.events.at(-1)?.payload).toMatchObject({ summaryAttempt: true, runId: "same-run", status: "failed" });
});
it("does not trust a durable store lacking atomic turn admission", async () => {
  const log = inMemorySessionLog();
  const summarize = vi.fn();
  const store = contextSessionLogStore({ log, sessionId: "s", isCurrent: async () => true });
  await expect(compactContext({ sessionId: "s", messages: history(), policy, runtime: { runId: "r", model, summarize, store: { ...store, supportsTurnAdmission: false } } })).rejects.toThrow("summary_admission_unavailable");
  expect(summarize).not.toHaveBeenCalled();
});
