import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import type { PersistedDurableHarnessEvent } from "../events/occurrence.js";
import { withTempDir } from "../test/temp.js";
import { deliveryLedger, dispatchRunId, writeDeliveryJson } from "./delivery-ledger.js";

const event = (runId: string, type: "harness.model.called" | "harness.model.responded", occurrenceId = "occurrence") => ({ type, runId, occurrenceId, payload: { turn: 1 }, sequence: type === "harness.model.called" ? 1 : 2, eventId: type, appendIdempotencyKey: type, recordedAt: new Date().toISOString(), canonicalRequestDigest: "synthetic" }) as PersistedDurableHarnessEvent;

describe("durable caller delivery ledger", () => {
  it("keeps a session-global immutable payload binding, preserves duplicate-text identities and strips terminal payload bytes", async () => withTempDir(async (dir) => {
    let ledger = deliveryLedger(dir);
    await ledger.admit("s", "a", "input");
    expect((await ledger.stage("s", "a", "m1", "same text")).state).toBe("accepted");
    await ledger.stage("s", "a", "m1", "same text"); await ledger.stage("s", "a", "m2", "same text");
    await expect(ledger.stage("s", "a", "m1", "different")).rejects.toThrow(/different/);
    await expect(ledger.stage("s", "b", "m1", "same text")).rejects.toThrow(/different/);
    const runId = dispatchRunId("s", "a");
    expect(await ledger.take("s", "a", runId, 0, 3)).toEqual([{ messageId: "m1", text: "same text", at: 3 }, { messageId: "m2", text: "same text", at: 3 }]);
    ledger = deliveryLedger(dir);
    expect(await ledger.replay("s", "a", runId, 0)).toHaveLength(2);
    await ledger.called("s", "a", runId, 0, "occurrence");
    expect((await ledger.message("s", "m1"))!.state).toBe("claimed");
    await ledger.responded("s", "a", runId, "occurrence"); await ledger.end("s", "a", "finished");
    expect(await ledger.message("s", "m1")).toMatchObject({ state: "read", payloadHash: expect.any(String), claim: { runId, occurrenceId: "occurrence" } });
    expect((await ledger.message("s", "m1"))!.text).toBeUndefined();
    expect((await ledger.stage("s", "a", "m1", "same text")).state).toBe("read");
    expect((await ledger.stage("s", "a", "late", "not read")).state).toBe("unread");
  }));

  it("repairs a durable response before a failed read marker, while a called-only or unknown outcome stays claimed", async () => withTempDir(async (dir) => {
    const ledger = deliveryLedger(dir); await ledger.admit("s", "a", "input"); const runId = dispatchRunId("s", "a");
    await ledger.stage("s", "a", "m", "unconfirmed input"); await ledger.take("s", "a", runId, 0, 1); await ledger.called("s", "a", runId, 0, "occurrence");
    await ledger.reconcile("s", "a", runId, [event(runId, "harness.model.called")]); await ledger.end("s", "a", "failed");
    expect(await ledger.message("s", "m")).toMatchObject({ state: "claimed", text: "unconfirmed input" });
    const failedWriter = deliveryLedger(dir, { write: async () => { throw new Error("read marker not persisted"); } });
    await expect(failedWriter.responded("s", "a", runId, "occurrence")).rejects.toThrow(/not persisted/);
    const restarted = deliveryLedger(dir); await restarted.reconcile("s", "a", runId, [event(runId, "harness.model.called"), event(runId, "harness.model.responded")]);
    expect((await restarted.message("s", "m"))!.state).toBe("read");
    await expect(restarted.reconcile("s", "a", runId, [event("another-run", "harness.model.responded")])).rejects.toThrow(/another run/);
  }));

  it("reconciles a lost acceptance/cancellation write acknowledgement without duplication or reopening", async () => withTempDir(async (dir) => {
    const ledger = deliveryLedger(dir); await ledger.admit("s", "a", "input");
    const lostAck = deliveryLedger(dir, { write: async (path, value) => { await writeDeliveryJson(path, value); throw new Error("ack lost"); } });
    await expect(lostAck.stage("s", "a", "m", "once")).rejects.toThrow(/ack lost/);
    expect((await ledger.stage("s", "a", "m", "once")).state).toBe("accepted"); expect(await ledger.messages("s", "a")).toHaveLength(1);
    await expect(lostAck.cancel("s", "not-arrived")).rejects.toThrow(/ack lost/);
    await expect(deliveryLedger(dir).admit("s", "not-arrived", "late start")).rejects.toThrow(/cancelled/);
    await ledger.end("s", "a", "finished");
    for (let n = 0; n < 60; n++) { await ledger.admit("s", `successor-${n}`, "input"); await ledger.end("s", `successor-${n}`, "finished"); }
    await expect(deliveryLedger(dir).admit("s", "not-arrived", "late again")).rejects.toThrow(/cancelled/);
    const current = await ledger.get("s"); await ledger.end("s", "a", "finished"); await ledger.admit("s", "a", "input");
    expect((await ledger.get("s"))!.dispatchId).toBe(current!.dispatchId);
    await expect(ledger.startRun("s", "a", "reopen", "turn")).rejects.toThrow(/ended/);
  }));

  it("fails closed on malformed durable files, including cancellation and message invariants", async () => withTempDir(async (dir) => {
    const ledger = deliveryLedger(dir); await mkdir(dirname(ledger.file("s")), { recursive: true });
    await writeFile(ledger.file("s"), "{broken"); await expect(ledger.admit("s", "a", "input")).rejects.toThrow();
    await writeDeliveryJson(ledger.file("s"), { version: 1, nextMessage: 0, dispatches: [{ dispatchId: "a", state: "cancelled", harnessTurnIds: [], runIds: [] }], messages: [] });
    await expect(ledger.get("s")).rejects.toThrow(/cancellation/);
  }));
  it("fences delayed run ends and retains immutable resume bindings beyond the receipt cache", async () => withTempDir(async (dir) => {
    const ledger = deliveryLedger(dir); await ledger.admit("s", "a", "input"); const initial = dispatchRunId("s", "a");
    await ledger.end("s", "a", "parked", initial);
    const queued = (n: number) => ({ resumeId: `run-${n}`, continuationId: `continuation-${n}`, sessionId: "s", originTurnId: "turn-a", reason: "predicate_satisfied" as const, terminalResultIds: [], enqueuedAt: new Date().toISOString() });
    for (let n = 0; n < 60; n++) { await ledger.bindResume("s", "a", `caller-${n}`, queued(n)); await ledger.addRun("s", "a", `run-${n}`, `caller-${n}`); }
    await ledger.stage("s", "a", "new", "new resumed input");
    await ledger.end("s", "a", "finished", initial);
    expect((await ledger.get("s", "a"))!.state).toBe("running"); expect((await ledger.message("s", "new"))!.state).toBe("accepted");
    await ledger.end("s", "a", "finished", "run-59"); await ledger.end("s", "a", "parked", initial);
    expect((await ledger.get("s", "a"))!.state).toBe("finished");
    await ledger.admit("s", "b", "input");
    await expect(ledger.bindResume("s", "b", "caller-0", queued(0))).rejects.toThrow(/different dispatch/);
    expect((await ledger.resume("s", "caller-0"))!.dispatchId).toBe("a");
    const file = await ledger.read("s"); file.dispatches[0]!.resumes[0]!.queued = { ...queued(0), sessionId: "other" };
    await writeDeliveryJson(ledger.file("s"), file); await expect(ledger.resume("s", "caller-0")).rejects.toMatchObject({ status: 503 });
  }));

});
