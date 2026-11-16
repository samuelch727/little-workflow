import type { HarnessSessionLog } from "../events/occurrence.js";
import type { JsonObject } from "../types.js";
import type { ContextAttempt, ContextCheckpoint, ContextCheckpointStore, ContextInputUsage } from "./types.js";
import { validContextInputUsage } from "./calibration.js";

const queues = new WeakMap<object, Promise<unknown>>();
/** Adapts local/file/remote/virtual session logs under the host's session exclusivity.
 * The log must be durable and the caller must supply a source-revision guard. This
 * serializes handles sharing one log in-process; distributed hosts must implement
 * their own transactional ContextCheckpointStore instead of claiming cross-process CAS.
 */
export function contextSessionLogStore(input: {
  log: HarnessSessionLog;
  sessionId: string;
  isCurrent: (sourceRevision: string) => Promise<boolean>;
}): ContextCheckpointStore {
  if (!input.log.priorEvents) throw new Error("Context checkpoint log must support replay");
  const runId = `context:${input.sessionId}`;
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = (queues.get(input.log) ?? Promise.resolve()).then(fn);
    queues.set(input.log, next.catch(() => undefined));
    return next;
  };
  async function state() {
    const attempts = new Map<string, ContextAttempt>();
    const checkpoints = new Map<string, ContextCheckpoint>();
    let inputUsage: ContextInputUsage | undefined;
    for (const event of await input.log.priorEvents!({ runId })) {
      if (!event.payload) continue;
      if (event.type === "harness.context.attempt") {
        const attempt = event.payload as unknown as ContextAttempt;
        attempts.set(attempt.id, structuredClone(attempt));
      } else if (event.type === "harness.context.checkpoint") {
        const checkpoint = event.payload as unknown as ContextCheckpoint;
        checkpoints.set(checkpoint.id, structuredClone(checkpoint));
      } else if (event.type === "harness.context.input_usage" && validContextInputUsage(event.payload) && event.payload.sessionId === input.sessionId) {
        inputUsage = structuredClone(event.payload);
      }
    }
    return { attempts, checkpoints, inputUsage };
  }
  async function append(type: "harness.context.attempt" | "harness.context.checkpoint" | "harness.context.input_usage", id: string, payload: unknown) {
    await input.log.append({ type, runId, appendIdempotencyKey: `${type}:${id}`, payload: payload as JsonObject });
  }
  return {
    durable: true,
    supportsTurnAdmission: true,
    lastInputUsage: sessionId => serial(async () => sessionId === input.sessionId ? (await state()).inputUsage : undefined),
    recordInputUsage: usage => serial(async () => {
      if (!validContextInputUsage(usage) || usage.sessionId !== input.sessionId) return;
      await append("harness.context.input_usage", usage.requestId, usage);
    }),
    list: () => serial(async () => [...(await state()).checkpoints.values()]),
    load: id => serial(async () => (await state()).checkpoints.get(id)),
    claim: (attempt, cap) => serial(async () => {
      if (attempt.sessionId !== input.sessionId || !await input.isCurrent(attempt.sourceRevision)) return false;
      const current = await state();
      if (current.attempts.has(attempt.id)) return false;
      if (attempt.summaryAttempt && (!attempt.runId?.trim() || attempt.runId.length > 200 || [...current.attempts.values()].some(a => a.summaryAttempt && a.runId === attempt.runId))) return false;
      const spent = [...current.attempts.values()].reduce((n, a) => n + (a.actualUsd ?? a.reservedUsd), 0);
      if (spent + attempt.reservedUsd > cap) return false;
      await append("harness.context.attempt", `${attempt.id}:reserved`, attempt);
      return true;
    }),
    commit: (checkpoint, actual) => serial(async () => {
      const current = await state(), attempt = current.attempts.get(checkpoint.attemptId);
      if (!attempt || attempt.status !== "reserved" || attempt.sourceRevision !== checkpoint.sourceRevision || !await input.isCurrent(checkpoint.sourceRevision)) return false;
      // Checkpoint first: on interrupted settlement its reservation remains conservative.
      await append("harness.context.checkpoint", checkpoint.id, checkpoint);
      await append("harness.context.attempt", `${attempt.id}:committed`, { ...attempt, status: "committed", actualUsd: actual?.usd ?? 0, ...(actual ? { inputTokens: actual.inputTokens, outputTokens: actual.outputTokens } : {}) });
      return true;
    }),
    fail: (id, reason, actual) => serial(async () => {
      const current = await state(), attempt = current.attempts.get(id);
      if (!attempt || attempt.status !== "reserved" || current.checkpoints.has(id)) return;
      await append("harness.context.attempt", `${id}:failed`, { ...attempt, status: "failed", reason, ...(actual ? { actualUsd: actual.usd, inputTokens: actual.inputTokens, outputTokens: actual.outputTokens } : {}) });
    }),
  };
}
