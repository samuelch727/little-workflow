import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { HarnessResumeQueueRecord } from "../tasks/ledger.js";
import { LittleHarnessError } from "../errors.js";
import type { PersistedDurableHarnessEvent } from "../events/occurrence.js";

const claimSchema = z.object({ runId: z.string(), stepNumber: z.number().int().nonnegative(), at: z.number().int().nonnegative(), occurrenceId: z.string().optional() }).strict();
const timestamp = z.string().datetime({ offset: true });
const queuedSchema = z.object({ resumeId: z.string().min(1), continuationId: z.string().min(1), sessionId: z.string().min(1), originTurnId: z.string().min(1), reason: z.enum(["predicate_satisfied", "timeout"]), terminalResultIds: z.array(z.string()), enqueuedAt: timestamp, claimedAt: timestamp.optional(), completedAt: timestamp.optional(), attempts: z.number().int().nonnegative().optional(), retryAt: timestamp.optional() }).strict().transform((value) => value as HarnessResumeQueueRecord);
const resumeSchema = z.object({ resumeId: z.string(), runId: z.string(), continuationId: z.string(), status: z.enum(["running", "parked", "finished", "failed"]), queued: queuedSchema }).strict();
const dispatchSchema = z.object({ dispatchId: z.string(), inputHash: z.string().optional(), startRunId: z.string().optional(), latestRunId: z.string().optional(), state: z.enum(["running", "parked", "finished", "failed", "cancelled"]), harnessTurnIds: z.array(z.string()), runIds: z.array(z.string()), resumeId: z.string().optional(), resumes: z.array(resumeSchema).default([]), cancelledAt: z.string().optional() }).strict();
const messageSchema = z.object({ messageId: z.string(), dispatchId: z.string(), text: z.string().optional(), payloadHash: z.string().regex(/^[0-9a-f]{64}$/), sequence: z.number().int().nonnegative(), state: z.enum(["accepted", "claimed", "read", "unread"]), claim: claimSchema.optional() }).strict();
const ledgerSchema = z.object({ version: z.literal(1), mode: z.enum(["legacy", "identified"]).optional(), current: z.string().optional(), nextMessage: z.number().int().nonnegative(), dispatches: z.array(dispatchSchema), messages: z.array(messageSchema) }).strict();
export type CallerDispatch = z.infer<typeof dispatchSchema>;
export type StagedMessage = z.infer<typeof messageSchema>;
type Ledger = z.infer<typeof ledgerSchema>;

export class HarnessDeliveryError extends LittleHarnessError {
  constructor(message: string, readonly status: 409 | 503 = 409) { super(message, "harness_delivery_conflict"); }
}
export const dispatchRunId = (sessionId: string, dispatchId: string) => `dispatch_${digest([sessionId, dispatchId])}`;
export const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function callerId(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim() || value.length > 200) throw new HarnessDeliveryError(`${name} must be non-empty text of at most 200 characters.`);
  return value;
}
export function messageStatus(message: StagedMessage) {
  return { messageId: message.messageId, dispatchId: message.dispatchId, state: message.state, ...(message.claim ? { runId: message.claim.runId, stepNumber: message.claim.stepNumber, ...(message.claim.occurrenceId ? { occurrenceId: message.claim.occurrenceId } : {}) } : {}) };
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}
async function ensureDirectory(path: string): Promise<void> {
  try { await mkdir(path, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") { await ensureDirectory(dirname(path)); await mkdir(path, { mode: 0o700 }).catch((e: NodeJS.ErrnoException) => { if (e.code !== "EEXIST") throw e; }); }
    else if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  await syncDirectory(dirname(path)); await syncDirectory(path);
}
export async function writeDeliveryJson(path: string, value: unknown): Promise<void> {
  await ensureDirectory(dirname(path));
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, path); await syncDirectory(dirname(path));
}

/** Strict, single-writer file ledger. An uncertain write is reconciled by rereading, never by reset. */
export function deliveryLedger(dataDir: string, io: { write?: (path: string, value: unknown) => Promise<void> } = {}) {
  const root = join(dataDir, "agent-server", "delivery");
  const file = (sessionId: string) => join(root, `${digest(sessionId)}.json`);
  const tails = new Map<string, Promise<unknown>>();
  const locked = async <T>(sessionId: string, work: () => Promise<T>): Promise<T> => {
    const run = (tails.get(sessionId) ?? Promise.resolve()).then(work, work);
    const tail = run.catch(() => undefined); tails.set(sessionId, tail);
    try { return await run; } finally { if (tails.get(sessionId) === tail) tails.delete(sessionId); }
  };
  const readRaw = async (sessionId: string): Promise<Ledger> => {
    let text: string;
    try { text = await readFile(file(sessionId), "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, nextMessage: 0, dispatches: [], messages: [] }; throw error; }
    const value = ledgerSchema.parse(JSON.parse(text));
    if (new Set(value.dispatches.map((d) => d.dispatchId)).size !== value.dispatches.length || new Set(value.messages.map((m) => m.messageId)).size !== value.messages.length) throw new Error("Duplicate identities in the delivery ledger.");
    const resumeIds = new Set<string>();
    for (const d of value.dispatches) {
      if ((d.state === "cancelled") !== (d.cancelledAt !== undefined)) throw new Error("Invalid cancellation receipt.");
      for (const r of d.resumes) {
        if (resumeIds.has(r.resumeId) || r.queued.resumeId !== r.runId || r.queued.continuationId !== r.continuationId || r.queued.sessionId !== sessionId || !d.runIds.includes(r.runId)) throw new Error("Invalid immutable resume binding.");
        resumeIds.add(r.resumeId);
      }
    }
    for (const m of value.messages) {
      if (["accepted", "claimed"].includes(m.state) && m.text === undefined || m.state === "claimed" && !m.claim || m.state === "read" && !m.claim?.occurrenceId || m.text !== undefined && digest([m.dispatchId, m.text]) !== m.payloadHash) throw new Error("Invalid staged-message receipt.");
    }
    return value;
  };
  const read = async (sessionId: string): Promise<Ledger> => {
    try { return await readRaw(sessionId); }
    catch (error) { throw new HarnessDeliveryError(`The delivery ledger is unavailable: ${error instanceof Error ? error.message : "unreadable proof"}`, 503); }
  };
  const update = <T>(sessionId: string, work: (value: Ledger) => T | Promise<T>): Promise<T> => locked(sessionId, async () => {
    const value = await read(sessionId); const result = await work(value);
    // Terminal receipt/proof needs only the immutable payload digest; active/unknown claims
    // keep their placement bytes so an interrupted run can reconstruct its exact request.
    for (const m of value.messages) if (["read", "unread"].includes(m.state) && !["running", "parked"].includes(value.dispatches.find((d) => d.dispatchId === m.dispatchId)?.state ?? "")) delete m.text;
    await (io.write ?? writeDeliveryJson)(file(sessionId), value); return result;
  });
  const find = (value: Ledger, dispatchId: string) => value.dispatches.find((d) => d.dispatchId === dispatchId);
  const active = (value: Ledger, dispatchId: string): CallerDispatch => {
    const dispatch = find(value, dispatchId);
    if (!dispatch || !["running", "parked"].includes(dispatch.state)) throw new HarnessDeliveryError("This dispatch is cancelled, ended, or was never admitted.");
    return dispatch;
  };
  return {
    file,
    read,
    async pinMode(sessionId: string, mode: "legacy" | "identified") {
      return update(sessionId, (value) => {
        const existing = value.mode ?? (value.dispatches.length ? "identified" : undefined);
        if (existing && existing !== mode) throw new HarnessDeliveryError("This session uses another dispatch API mode. Use its original scoped API, or create a new session.");
        value.mode = mode;
      });
    },
    async get(sessionId: string, dispatchId?: string) { const value = await read(sessionId); return value.dispatches.find((d) => d.dispatchId === (dispatchId ?? value.current)); },
    async byTurn(sessionId: string, turnId: string) { return (await read(sessionId)).dispatches.find((d) => d.harnessTurnIds.includes(turnId)); },
    async admit(sessionId: string, dispatchId: string, inputHash: string) {
      return update(sessionId, (value) => {
        let dispatch = find(value, dispatchId);
        if (dispatch?.state === "cancelled") throw new HarnessDeliveryError("This dispatch is cancelled.");
        if (dispatch?.inputHash && dispatch.inputHash !== inputHash) throw new HarnessDeliveryError("This dispatchId belongs to a different request.");
        if (!dispatch && value.dispatches.some((other) => ["running", "parked"].includes(other.state))) throw new HarnessDeliveryError("Another identified dispatch is still running, parked, or interrupted. Cancel that exact dispatch before starting another.");
        if (!dispatch) { dispatch = { dispatchId, inputHash, startRunId: dispatchRunId(sessionId, dispatchId), latestRunId: dispatchRunId(sessionId, dispatchId), state: "running", harnessTurnIds: [], runIds: [dispatchRunId(sessionId, dispatchId)], resumes: [] }; value.dispatches.push(dispatch); value.current = dispatchId; }
         return dispatch;
      });
    },
    async assertActive(sessionId: string, dispatchId: string) { return active(await read(sessionId), dispatchId); },
    async startRun(sessionId: string, dispatchId: string, runId: string, turnId: string, resumeId?: string) {
      return update(sessionId, (value) => {
        const dispatch = active(value, dispatchId); if (["finished", "failed"].includes(dispatch.state)) throw new HarnessDeliveryError("This dispatch already ended."); dispatch.state = "running"; dispatch.latestRunId = runId;
        if (!dispatch.runIds.includes(runId)) dispatch.runIds.push(runId);
        if (!dispatch.harnessTurnIds.includes(turnId)) dispatch.harnessTurnIds.push(turnId);
        if (resumeId) dispatch.resumeId = resumeId;
        return dispatch;
      });
    },
    async resume(sessionId: string, resumeId: string) {
      const value = await read(sessionId);
      for (const d of value.dispatches) { const receipt = d.resumes.find((r) => r.resumeId === resumeId); if (receipt) return { dispatchId: d.dispatchId, receipt }; }
      return undefined;
    },
    async bindResume(sessionId: string, dispatchId: string, resumeId: string, queued: HarnessResumeQueueRecord) {
      queued = queuedSchema.parse(queued);
      if (queued.sessionId !== sessionId) throw new HarnessDeliveryError("The queued resume belongs to another session.", 503);
      return update(sessionId, (value) => {
        for (const d of value.dispatches) for (const r of d.resumes) if (r.resumeId === resumeId && (d.dispatchId !== dispatchId || r.runId !== queued.resumeId || r.continuationId !== queued.continuationId)) throw new HarnessDeliveryError("This resumeId belongs to a different dispatch or continuation.");
        const d = active(value, dispatchId);
        if (!d.runIds.includes(queued.resumeId)) d.runIds.push(queued.resumeId);
        if (!d.resumes.some((r) => r.resumeId === resumeId)) d.resumes.push({ resumeId, runId: queued.resumeId, continuationId: queued.continuationId, status: "running", queued: JSON.parse(JSON.stringify(queued)) });
      });
    },
    async resumeStatus(sessionId: string, dispatchId: string, resumeId: string, status: "running" | "parked" | "finished" | "failed") {
      return update(sessionId, (value) => { const receipt = find(value, dispatchId)?.resumes.find((r) => r.resumeId === resumeId); if (!receipt) throw new HarnessDeliveryError("No admitted resume with that identity."); if (receipt.status !== "running" && receipt.status !== status) throw new HarnessDeliveryError("A terminal resume receipt cannot be reopened."); receipt.status = status; });
    },
    async addRun(sessionId: string, dispatchId: string, runId: string, resumeId: string) {
      return update(sessionId, (value) => { const d = active(value, dispatchId); if (["finished", "failed"].includes(d.state)) throw new HarnessDeliveryError("This dispatch already ended."); if (!d.runIds.includes(runId)) d.runIds.push(runId); d.resumeId = resumeId; d.state = "running"; d.latestRunId = runId; return d; });
    },
    async cancel(sessionId: string, dispatchId: string) {
      return update(sessionId, (value) => {
        let dispatch = find(value, dispatchId);
        if (!dispatch) { dispatch = { dispatchId, state: "cancelled", harnessTurnIds: [], runIds: [], resumes: [] }; value.dispatches.push(dispatch); }
        dispatch.state = "cancelled"; dispatch.cancelledAt ??= new Date().toISOString();
        for (const m of value.messages) if (m.dispatchId === dispatchId && m.state === "accepted") m.state = "unread";
        return dispatch;
      });
    },
    async end(sessionId: string, dispatchId: string, state: "parked" | "finished" | "failed", expectedLatestRunId?: string) {
      return update(sessionId, (value) => {
        const dispatch = find(value, dispatchId); if (!dispatch) throw new HarnessDeliveryError("No such dispatch.");
        // A stale log read or delayed completion must not end a newer resumed run,
        // reopen a terminal receipt, or sweep that newer run's accepted messages.
        if (expectedLatestRunId !== undefined && dispatch.latestRunId !== expectedLatestRunId) return dispatch;
        if (["finished", "failed"].includes(dispatch.state)) return dispatch;
        if (dispatch.state !== "cancelled") dispatch.state = state;
        if (expectedLatestRunId !== undefined) for (const r of dispatch.resumes) if (r.runId === expectedLatestRunId && r.status === "running") r.status = state;
        if (dispatch.state !== "parked") for (const m of value.messages) if (m.dispatchId === dispatchId && m.state === "accepted") m.state = "unread";
        return dispatch;
      });
    },
    async stage(sessionId: string, dispatchId: string, messageId: string, text: string) {
      return update(sessionId, (value) => {
        const old = value.messages.find((m) => m.messageId === messageId);
        if (old) { if (old.dispatchId !== dispatchId || old.payloadHash !== digest([dispatchId, text])) throw new HarnessDeliveryError("This messageId belongs to a different dispatch or payload."); return old; }
        const dispatch = find(value, dispatchId);
        const m: StagedMessage = { messageId, dispatchId, text, payloadHash: digest([dispatchId, text]), sequence: value.nextMessage++, state: dispatch && ["running", "parked"].includes(dispatch.state) ? "accepted" : "unread" };
        value.messages.push(m); return m;
      });
    },
    async message(sessionId: string, messageId: string) { return (await read(sessionId)).messages.find((m) => m.messageId === messageId); },
    async messages(sessionId: string, dispatchId: string) { return (await read(sessionId)).messages.filter((m) => m.dispatchId === dispatchId); },
    async take(sessionId: string, dispatchId: string, runId: string, stepNumber: number, at: number) {
      return update(sessionId, (value) => {
        active(value, dispatchId);
        for (const m of value.messages) if (m.dispatchId === dispatchId && m.state === "accepted") { m.state = "claimed"; m.claim = { runId, stepNumber, at }; }
        return value.messages.filter((m) => m.dispatchId === dispatchId && m.claim?.runId === runId && m.claim.stepNumber <= stepNumber && ["claimed", "read"].includes(m.state)).sort((a, b) => a.sequence - b.sequence).map((m) => ({ messageId: m.messageId, text: m.text!, at: m.claim!.at }));
      });
    },
    async replay(sessionId: string, dispatchId: string, runId: string, stepNumber: number) {
      const value = await read(sessionId); active(value, dispatchId);
      return value.messages.filter((m) => m.dispatchId === dispatchId && m.claim?.runId === runId && m.claim.stepNumber <= stepNumber && ["claimed", "read"].includes(m.state)).sort((a, b) => a.sequence - b.sequence).map((m) => ({ messageId: m.messageId, text: m.text!, at: m.claim!.at }));
    },
    async called(sessionId: string, dispatchId: string, runId: string, stepNumber: number, occurrenceId: string) {
      return update(sessionId, (value) => {
        active(value, dispatchId);
        const changed: StagedMessage[] = [];
        for (const m of value.messages) if (m.dispatchId === dispatchId && m.claim?.runId === runId && m.claim.stepNumber === stepNumber) {
          if (m.claim.occurrenceId && m.claim.occurrenceId !== occurrenceId) throw new HarnessDeliveryError("A staged-message claim is bound to another model occurrence.");
          m.claim.occurrenceId = occurrenceId; changed.push(m);
        }
        return changed;
      });
    },
    async responded(sessionId: string, dispatchId: string, runId: string, occurrenceId: string) {
      return update(sessionId, (value) => {
        const changed: StagedMessage[] = [];
        for (const m of value.messages) if (m.dispatchId === dispatchId && m.claim?.runId === runId && m.claim.occurrenceId === occurrenceId && m.state === "claimed") { m.state = "read"; changed.push(m); }
        return changed;
      });
    },
    async reconcile(sessionId: string, dispatchId: string, runId: string, events: readonly PersistedDurableHarnessEvent[]) {
      return update(sessionId, (value) => {
        for (const event of events) {
          if (event.runId !== runId) throw new HarnessDeliveryError("The session log returned events from another run.", 503);
          if (!event.occurrenceId) continue;
          if (event.type === "harness.model.called") {
            const step = Number(event.payload?.turn) - 1;
            for (const m of value.messages) if (m.dispatchId === dispatchId && m.claim?.runId === runId && m.claim.stepNumber === step) {
              if (m.claim.occurrenceId && m.claim.occurrenceId !== event.occurrenceId) throw new HarnessDeliveryError("A staged-message claim has conflicting durable model occurrences.");
              m.claim.occurrenceId = event.occurrenceId;
            }
          }
          if (event.type === "harness.model.responded") for (const m of value.messages) if (m.dispatchId === dispatchId && m.claim?.runId === runId && m.claim.occurrenceId === event.occurrenceId && m.state === "claimed") m.state = "read";
        }
      });
    },
  };
}
