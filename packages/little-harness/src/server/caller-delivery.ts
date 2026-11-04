import { join } from "node:path";
import type { HarnessInbox } from "../execution/inbox.js";
import { HarnessTurnLimitError } from "../execution/turn-limits.js";
import { fileSessionLog } from "../remote-session/session-log-store.js";
import type { HarnessSessionLog } from "../events/occurrence.js";
import type { Harness } from "../types.js";
import { deliveryLedger, digest, HarnessDeliveryError, messageStatus } from "./delivery-ledger.js";
import type { TurnEventDelivery } from "./event-delivery.js";

/** The server's caller identities and inbox are independent of any application's credential. */
export function callerDelivery(harness: Harness, dataDir: string) {
  const ledger = deliveryLedger(dataDir);
  const logFor = (runId: string) => {
    const log = harness.config.sessionLog ?? fileSessionLog({ path: join(dataDir, "agent-server", "caller-runs", `${digest(runId)}.ndjson`) });
    if (typeof log.priorEvents !== "function") throw new HarnessDeliveryError("Identified dispatches require a readable durable session log.", 503);
    return log as HarnessSessionLog & { priorEvents: NonNullable<HarnessSessionLog["priorEvents"]> };
  };
  const assert = async (sessionId: string, dispatchId: string) => {
    try { return await ledger.assertActive(sessionId, dispatchId); }
    catch (error) { if (error instanceof HarnessDeliveryError) throw new HarnessTurnLimitError("Interrupted", "This dispatch no longer permits execution."); throw error; }
  };
  const reconcile = async (sessionId: string, dispatchId: string) => {
    try {
    const record = await ledger.get(sessionId, dispatchId);
    if (!record) return;
    for (const runId of record.runIds) {
      const events = await logFor(runId).priorEvents({ runId });
      await ledger.reconcile(sessionId, dispatchId, runId, events);
      if (runId === record.latestRunId) {
        const completed = [...events].reverse().find((event) => event.type === "harness.session.completed");
        const failed = [...events].reverse().find((event) => event.type === "harness.session.failed");
        if (completed) {
          const turnId = completed.payload?.turnId;
          const durable = harness.config.host.durable;
          const open = await durable?.continuations.listOpen(sessionId) ?? [];
          const queued = await durable?.resumeQueue.listOpen(sessionId) ?? [];
          const enqueued = await Promise.all(queued.map((q) => durable!.continuations.get(q.continuationId)));
          await ledger.end(sessionId, dispatchId, [...open, ...enqueued].some((c) => c && c.state !== "closed" && c.originTurnId === turnId) ? "parked" : "finished", runId);
        } else if (failed) await ledger.end(sessionId, dispatchId, "failed", runId);
      }
    }
    } catch (error) {
      if (error instanceof HarnessDeliveryError) throw error;
      throw new HarnessDeliveryError("The dispatch's durable replay proof is unavailable.", 503);
    }
  };
  const report = (delivery: TurnEventDelivery | undefined, records: Awaited<ReturnType<typeof ledger.messages>>) => {
    for (const record of records) delivery?.push({ type: "turn.message", ...messageStatus(record) });
  };
  return {
    ledger, logFor, assert, reconcile,
    inbox(sessionId: string, dispatchId: string, runId: string, delivery?: () => TurnEventDelivery | undefined): HarnessInbox {
      return {
        take: (step) => { if (!step) throw new Error("Identified inbox needs a step context."); return ledger.take(sessionId, dispatchId, runId, step.stepNumber, step.at); },
        replay: (step) => ledger.replay(sessionId, dispatchId, runId, step.stepNumber),
        modelRequested: async ({ stepNumber, occurrenceId }) => { await assert(sessionId, dispatchId); report(delivery?.(), await ledger.called(sessionId, dispatchId, runId, stepNumber, occurrenceId)); },
        modelResponded: async ({ occurrenceId }) => { report(delivery?.(), await ledger.responded(sessionId, dispatchId, runId, occurrenceId)); },
      };
    },
    async end(sessionId: string, dispatchId: string, state: "parked" | "finished" | "failed", runId: string, delivery?: TurnEventDelivery) {
      await reconcile(sessionId, dispatchId);
      const record = await ledger.end(sessionId, dispatchId, state, runId);
      report(delivery, await ledger.messages(sessionId, dispatchId));
      return record;
    },
  };
}
