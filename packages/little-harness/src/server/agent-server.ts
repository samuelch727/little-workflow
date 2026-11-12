import { createHash, timingSafeEqual } from "node:crypto";
import { rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { Readable } from "node:stream";
import { createUIMessageStreamResponse, type UIMessage } from "ai";
import { loadChatSdkConnector } from "../connectors/chat-sdk.js";
import { discoverConnectors } from "../connectors/discovery.js";
import { loadWebRichConnector } from "../connectors/web-rich.js";
import { HarnessInputError, LittleHarnessError } from "../errors.js";
import { generateHarness } from "../execution/generate-harness.js";
import type { HarnessTurnResult } from "../execution/result.js";
import { createDeadlineSweeper } from "../execution/deadline-sweeper.js";
import { resumeParked } from "../execution/resume-parked.js";
import { streamHarness } from "../execution/stream-harness.js";
import type { HarnessInbox } from "../execution/inbox.js";
import { HarnessTurnLimitError } from "../execution/turn-limits.js";
import {
  createTurnEventDelivery,
  deliversHarnessEvent,
  parkedSinks,
  sinkFrom,
  type DeliveredTurnEvent,
  type EndedTurn,
  type TurnEventDelivery,
  type TurnEventSink,
} from "./event-delivery.js";
import { callerDelivery } from "./caller-delivery.js";
import { callerId, dispatchRunId, HarnessDeliveryError, messageStatus } from "./delivery-ledger.js";
import { stableHash } from "../utils/canonical-hash.js";
import { latestTurns } from "./latest-turns.js";
import { isRevision } from "../outcomes/aggregate.js";
import { reportHarnessOutcome } from "../outcomes/record.js";
import type { HarnessOutcomeInput, HarnessOutcomeSink } from "../outcomes/types.js";
import { answerInputRequest, listInputRequests } from "../human-input/answers.js";
import { fileSessionLog } from "../remote-session/session-log-store.js";
import type { HumanInputAnswer } from "../human-input/types.js";
import type { HarnessResumeQueueRecord } from "../tasks/ledger.js";
import { callerResumes, type CallerResumeStatus } from "./caller-resumes.js";
import { createScheduleRunner, type ScheduleRun, type ScheduleRunner } from "../schedules/runner.js";
import { discoverSchedules } from "../schedules/schedule.js";
import type { Harness, HarnessEvent, HarnessTrigger, HarnessTurnStart } from "../types.js";
import { loadHarness as defaultLoadHarness } from "../workspace/load-harness.js";

export type AgentServerOptions = {
  readonly agentDir: string;
  readonly agentName: string;
  /** Default 3000; 0 picks a free port. */
  readonly port?: number;
  /** Default `127.0.0.1`, this machine only. */
  readonly hostname?: string;
  /**
   * Required by the API routes when set (`Authorization: Bearer <token>`). Without one, the server
   * must listen on a loopback address, and the API routes answer only requests addressed to
   * `localhost`, `127.0.0.1` or `[::1]` that do not come from a web page. Connectors check their
   * own requests either way.
   */
  readonly token?: string;
  /** Where schedule state goes when the agent's host has no data dir. */
  readonly dataDir: string;
  /** How often to start due schedules and continue parked turns. Default 15 seconds. */
  readonly intervalMs?: number;
  readonly log?: (line: string) => void;
  /** Log a continued turn's whole reply, not its first 120 characters. For `dev`. */
  readonly logFullReplies?: boolean;
  readonly loadHarness?: (agentDir: string) => Promise<Harness<any, any>>;
  /**
   * Checks the `extraBody` a message or resume request sends before its turn gets it, and returns
   * what the turn gets. It gets `undefined` when the request sends none. Throw to refuse the
   * request (400). Without one, `extraBody` is passed as sent.
   */
  readonly parseExtraBody?: (value: unknown) => unknown;
  /**
   * Who continues a parked turn once its wait is over. `"timer"`, the default: this server, on
   * its timer and right after an answer. `"caller"`: only `POST /sessions/:id/resume`, so a turn
   * always continues with the `extraBody` its caller sends then (a fresh credential, say).
   */
  readonly resume?: "timer" | "caller";
  /**
   * Lets the caller report how a turn went (a person's thumb on a reply, say):
   * `POST /sessions/:id/outcomes` records it in the session's trace, as `reportHarnessOutcome`
   * does, and hands it to these sinks, such as a LittleDB client's `outcomeSink`. A `revision`
   * orders reports under one `reportKey`, so a sink that keeps state turns away a late, older
   * one. Without `outcomes`, the route answers 404.
   */
  readonly outcomes?: { readonly sinks: readonly HarnessOutcomeSink[] };
};

export type AgentServer = {
  readonly url: string;
  readonly harness: Harness;
  /** Runs the schedules and parked-turn checks once now, as the timer does. */
  tick(): Promise<void>;
  close(): Promise<void>;
};

type MountedConnector = {
  readonly id: string;
  readonly kind: string;
  handle(request: Request): Promise<Response>;
  close(): Promise<void>;
};

/**
 * Serves one agent folder: its connectors at `/connectors/<id>`, an HTTP API for messages, Input
 * Type jobs, questions and schedules, and a timer that starts due schedules and continues turns
 * that parked waiting for tasks or a person's answer.
 */
export async function startAgentServer(options: AgentServerOptions): Promise<AgentServer> {
  const log = options.log ?? ((line: string) => console.log(line));
  const harness = await (options.loadHarness ?? ((dir) => defaultLoadHarness(dir, { dataDir: options.dataDir })))(options.agentDir);
  const background = new Set<Promise<unknown>>();
  const track = (task: Promise<unknown>) => {
    const settled = task.catch((error) => log(`[server] background work failed: ${message(error)}`))
      .finally(() => background.delete(settled));
    background.add(settled);
  };

  const connectors: MountedConnector[] = [];
  for (const found of await discoverConnectors(options.agentDir, {
    onSkip: (skipped) => log(`[connectors] skipped ${skipped.id}: ${message(skipped.error)}`),
  })) {
    const shared = { agentDir: options.agentDir, connector: found.id, connectorId: found.id, loadHarness: async () => harness };
    if (found.kind === "web-rich") {
      const loaded = await loadWebRichConnector({ ...shared, waitUntil: track });
      connectors.push({ id: found.id, kind: found.kind, handle: (request) => loaded.POST(request), close: () => loaded.close() });
    } else {
      const loaded = await loadChatSdkConnector(shared);
      connectors.push({
        id: found.id,
        kind: found.kind,
        handle: (request) => loaded.webhook(request, { waitUntil: track }),
        close: () => loaded.close(),
      });
    }
  }

  const schedules = await discoverSchedules(options.agentDir);
  const runner = createScheduleRunner({
    harness,
    schedules,
    stateDir: join(harness.config.host.dataDir ?? options.dataDir, "schedules", options.agentName),
  });
  const durable = harness.config.host.durable !== undefined;
  const reportRun = (run: ScheduleRun) => {
    log(`[schedule] ${run.id} started in session ${run.sessionId}${run.caughtUp ? " (missed while down)" : ""}`);
    track(run.finished.then((outcome) => {
      log(`[schedule] ${run.id} ${outcome.status}${outcome.status === "failed" ? `: ${message(outcome.error)}` : ""}`);
    }));
  };
  const sinks = parkedSinks(harness.config.host.dataDir ?? options.dataDir);
  const turnRecords = latestTurns(harness.config.host.dataDir ?? options.dataDir);
  const caller = callerDelivery(harness, harness.config.host.dataDir ?? options.dataDir);
  // A continued turn reports to the sink the turn named when it started, if it named one.
  const resumedDeliveries = new Map<string, Promise<TurnEventDelivery | undefined>>();
  const resumedDelivery = (turn: { sessionId: string; continuationId: string }) => {
    let delivery = resumedDeliveries.get(turn.continuationId);
    if (delivery === undefined) {
      delivery = sinks.load(turn.sessionId).then((sink) => {
        if (sink === undefined) return undefined;
        const opened = createTurnEventDelivery(sink, { sessionId: turn.sessionId, log });
        opened.push({ type: "turn.resumed", continuationId: turn.continuationId });
        return opened;
      });
      resumedDeliveries.set(turn.continuationId, delivery);
    }
    return delivery;
  };
  const endResumed = async (turn: { sessionId: string; continuationId: string }, last: DeliveredTurnEvent) => {
    const delivery = await resumedDelivery(turn);
    resumedDeliveries.delete(turn.continuationId);
    if (delivery === undefined) return;
    delivery.push(last);
    if (last.type !== "turn.parked") await sinks.remove(turn.sessionId);
    track(delivery.close());
  };
  // Sessions with a continued turn running in this process.
  const resumingSessions = new Set<string>();
  // A continued turn runs as the run of its queue record and records what it did under that id,
  // so a try after a failure or a restart replays the tool calls and steps that finished instead
  // of running them again. In the harness's own session log when it has one; else in a file per
  // continued turn, dropped once the turn is done with.
  const resumeLogs = join(harness.config.host.dataDir ?? options.dataDir, "agent-server", "resume-runs");
  const resumeLogPath = (resumeId: string) => join(resumeLogs, `${encodeURIComponent(resumeId)}.ndjson`);
  const resumeLog = harness.config.sessionLog === undefined
    ? (queued: HarnessResumeQueueRecord) => fileSessionLog({ path: resumeLogPath(queued.resumeId) })
    : undefined;
  const dropResumeLog = async (resumeId: string | undefined) => {
    if (resumeLog !== undefined && resumeId !== undefined) await rm(resumeLogPath(resumeId), { force: true });
  };
  // The queue record each turn the timer continues was claimed from, by continuation.
  const claimedIds = new Map<string, string>();
  // The turn each continuation the timer continues started as, for the event that ends it.
  const timerStarts = new Map<string, HarnessTurnStart>();
  let resuming: Promise<void> | undefined;
  const resume = (): Promise<void> => {
    if (!durable || options.resume === "caller") return Promise.resolve();
    resuming ??= resumeParked({
      harness,
      ...(resumeLog === undefined ? {} : { sessionLog: resumeLog }),
      onClaim: (turn, queued) => {
        resumingSessions.add(turn.sessionId);
        claimedIds.set(turn.continuationId, queued.resumeId);
      },
      onEvent: async (event, turn) => {
        if (deliversHarnessEvent(event)) (await resumedDelivery(turn))?.push({ type: "harness", event });
      },
      onTurnStart: async (start, turn) => {
        timerStarts.set(turn.continuationId, start);
        await turnRecords.save(start);
      },
      onResult: async (result, turn) => {
        resumingSessions.delete(turn.sessionId);
        log(`[resume] session ${turn.sessionId} ${describeTurn(result, options.logFullReplies === true)}`);
        await dropResumeLog(claimedIds.get(turn.continuationId));
        await endResumed(turn, withTurn(outcomeEvent(result), timerStarts.get(turn.continuationId)));
        timerStarts.delete(turn.continuationId);
      },
    })
      .then(async ({ failed }) => {
        for (const turn of failed) {
          resumingSessions.delete(turn.sessionId);
          log(`[resume] session ${turn.sessionId} failed: ${message(turn.error)}`);
          if (!turn.willRetry) {
            await dropResumeLog(claimedIds.get(turn.continuationId));
            await endResumed(turn, withTurn(failedEvent(turn.error), timerStarts.get(turn.continuationId)));
          } else resumedDeliveries.delete(turn.continuationId);
          timerStarts.delete(turn.continuationId);
        }
      })
      .finally(() => {
        resuming = undefined;
        claimedIds.clear();
      });
    return resuming;
  };
  const tick = async () => {
    // A failure in one does not hold back the other.
    const [scheduled, resumed] = await Promise.allSettled([runner.tick(), resume()]);
    if (scheduled.status === "fulfilled") for (const run of scheduled.value) reportRun(run);
    else log(`[schedule] checking schedules failed: ${message(scheduled.reason)}`);
    if (resumed.status === "rejected") log(`[resume] continuing parked turns failed: ${message(resumed.reason)}`);
  };

  const turns = runningTurns();
  const resumes = callerResumes(harness.config.host.dataDir ?? options.dataDir);
  // One resume request at a time per session, so two can't both claim its turn.
  const sessionLocks = new Map<string, Promise<unknown>>();
  const locked = <T>(sessionId: string, work: () => Promise<T>): Promise<T> => {
    const run = (sessionLocks.get(sessionId) ?? Promise.resolve()).then(work, work);
    const settled = run.catch(() => undefined);
    sessionLocks.set(sessionId, settled);
    void settled.then(() => {
      if (sessionLocks.get(sessionId) === settled) sessionLocks.delete(sessionId);
    });
    return run;
  };

  // Admission and controller attachment share the cancellation lock, including before a
  // Harness id exists. A duplicate terminal start is a receipt, never another execution.
  const admitStart = (sessionId: string, dispatchId: string, inputHash: string) => locked(sessionId, async () => {
    caller.logFor(dispatchRunId(sessionId, dispatchId));
    const previous = await caller.ledger.get(sessionId, dispatchId);
    await caller.reconcile(sessionId, dispatchId);
    const record = await caller.ledger.admit(sessionId, dispatchId, inputHash);
    if (previous && (turns.running(sessionId, dispatchId) || record.latestRunId !== record.startRunId || ["parked", "finished", "failed"].includes(record.state))) return { run: false as const, record };
    const latest = await caller.ledger.get(sessionId);
    if (previous && latest?.dispatchId !== dispatchId) throw new HarnessDeliveryError("This initial dispatch was superseded.");
    await caller.reconcile(sessionId, dispatchId);
    return { run: true as const, record, turn: turns.begin(sessionId, dispatchId) };
  });

  /**
   * Records the resume, then claims its queued turn and runs it; resolves once claimed, or false
   * when the turn was gone. Recorded first, so that whenever a restart cuts the resume off, a
   * repeat of its resumeId finds the turn and continues it.
   */
  const startCallerResume = async (
    sessionId: string,
    request: { readonly resumeId: string; readonly extraBody?: unknown; readonly sink?: TurnEventSink; readonly dispatchId?: string },
    queued: HarnessResumeQueueRecord,
  ): Promise<boolean> => {
    const save = async (status: CallerResumeStatus) => {
      if (request.dispatchId) await caller.ledger.resumeStatus(sessionId, request.dispatchId, request.resumeId, status);
      await resumes.save(sessionId, { resumeId: request.resumeId, continuationId: queued.continuationId, status, queued, updatedAt: new Date().toISOString() });
    };
    const dispatchId = request.dispatchId;
    if (dispatchId) { await caller.ledger.assertActive(sessionId, dispatchId); await caller.reconcile(sessionId, dispatchId); await caller.ledger.bindResume(sessionId, dispatchId, request.resumeId, queued); await caller.ledger.addRun(sessionId, dispatchId, queued.resumeId, request.resumeId); }
    const turn = turns.begin(sessionId, dispatchId);
    resumingSessions.add(sessionId);
    try {
      await save("running");
    } catch (error) {
      turn.end();
      resumingSessions.delete(sessionId);
      throw error;
    }
    return new Promise<boolean>((resolve, reject) => {
      let claimed = false;
      let delivery: TurnEventDelivery | undefined;
      let sink = request.sink;
      let started: HarnessTurnStart | undefined;
      const run = resumeParked({
        harness,
        sessionId,
        resumeId: queued.resumeId,
        // The caller decides whether to try again, with the same resumeId.
        maxAttempts: 1,
        ...(request.extraBody === undefined ? {} : { extraBody: request.extraBody }),
        ...(dispatchId ? { sessionLog: () => caller.logFor(queued.resumeId) } : resumeLog === undefined ? {} : { sessionLog: resumeLog }),
        abortSignal: turn.signal,
        inbox: dispatchId ? caller.inbox(sessionId, dispatchId, queued.resumeId, () => delivery) : turn.inbox,
        ...(dispatchId ? { beforeInvocation: () => caller.assert(sessionId, dispatchId).then(() => undefined) } : {}),
        onClaim: async (resumedTurn) => {
          if (dispatchId) await caller.assert(sessionId, dispatchId);
          turn.signal.throwIfAborted();
          claimed = true;
          sink ??= await sinks.load(sessionId);
          if (sink !== undefined) {
            delivery = createTurnEventDelivery(sink, { sessionId, log });
            delivery.push({ type: "turn.resumed", continuationId: resumedTurn.continuationId, resumeId: request.resumeId });
          }
          resolve(true);
        },
        onEvent: async (event) => {
          if (deliversHarnessEvent(event)) delivery?.push({ type: "harness", event });
        },
        onTurnStart: async (start) => {
          if (dispatchId) { await caller.assert(sessionId, dispatchId); await caller.ledger.startRun(sessionId, dispatchId, queued.resumeId, start.turnId, request.resumeId); }
          turn.signal.throwIfAborted();
          started = start;
          await turnRecords.save(start);
        },
      });
      track(run.then(async ({ resumed, failed }) => {
        let last: DeliveredTurnEvent;
        try {
          if (!claimed) {
            // Gone since it was found: nothing ran, and a repeat of this resumeId says so.
            await save("failed");
            if (dispatchId) await caller.end(sessionId, dispatchId, "failed", queued.resumeId, delivery);
            turn.end();
            return resolve(false);
          }
          const done = resumed[0];
          const failure = failed[0];
          if (done !== undefined) {
            log(`[resume] session ${sessionId} (${request.resumeId}) ${describeTurn(done.result, options.logFullReplies === true)}`);
            await save(done.result.status === "parked" ? "parked" : "finished");
            last = withTurn(outcomeEvent(done.result), started);
          } else {
            log(`[resume] session ${sessionId} (${request.resumeId}) failed: ${message(failure?.error)}`);
            // A stopped turn goes back on the queue; stopped by its caller, it ends here.
            if (failure?.willRetry === true) await endQueued(queued);
            await save("failed");
            last = withTurn(failedEvent(turn.stoppedBy(failure?.error) ?? failure?.error), started);
          }
        } finally {
          // Only once its status is saved, so GET /turn never sees a running record and no turn.
          resumingSessions.delete(sessionId);
        }
        if (dispatchId) {
          const ended = await caller.end(sessionId, dispatchId, last.type === "turn.parked" ? "parked" : last.type === "turn.finished" ? "finished" : "failed", queued.resumeId, delivery);
          if (ended.state === "cancelled") { await endParked(sessionId, dispatchId); last = withTurn(failedEvent(new HarnessTurnLimitError("Interrupted", "The caller cancelled this dispatch.")), started); }
        } else await dropResumeLog(queued.resumeId);
        const unread = turn.end();
        if (delivery === undefined) return;
        if (unread.length > 0) delivery.push({ type: "turn.unread", messages: unread });
        delivery.push(last);
        if (last.type === "turn.parked" && sink !== undefined) await sinks.save(sessionId, sink);
        else await sinks.remove(sessionId);
        await delivery.close();
      }, (error: unknown) => {
        turn.end();
        resumingSessions.delete(sessionId);
        if (!claimed) reject(error);
        else log(`[resume] session ${sessionId} (${request.resumeId}) failed: ${message(error)}`);
      }));
    });
  };

  /** A queued continuation that will not run: off the queue, and closed. */
  const endQueued = async (queued: HarnessResumeQueueRecord) => {
    const orchestration = harness.config.host.durable!;
    const now = new Date().toISOString();
    await orchestration.resumeQueue.markCompleted(queued.resumeId, now);
    await orchestration.continuations.transition(queued.continuationId, "resume_enqueued", "closed", { updatedAt: now });
  };

  const resumeForCaller = (
    sessionId: string,
    request: { readonly resumeId: string; readonly extraBody?: unknown; readonly sink?: TurnEventSink; readonly dispatchId?: string },
  ) => locked(sessionId, async (): Promise<Record<string, unknown>> => {
    const orchestration = harness.config.host.durable;
    if (orchestration === undefined) throw new HarnessInputError("Continuing turns needs a host with durable services, such as localHost.");
    if (request.dispatchId) { const target = await caller.ledger.get(sessionId, request.dispatchId); if (!target || target.state === "cancelled") throw new HarnessDeliveryError("This dispatch is cancelled or was never admitted."); }
    const known = await resumes.get(sessionId);
    const bound = await caller.ledger.resume(sessionId, request.resumeId);
    if (request.dispatchId && bound && bound.dispatchId !== request.dispatchId) throw new HarnessDeliveryError("This resumeId belongs to another dispatch.");
    if (request.dispatchId && !bound && (known?.latest.resumeId === request.resumeId || known?.earlier.some((r) => r.resumeId === request.resumeId))) throw new HarnessDeliveryError("This resume receipt has no matching dispatch binding.");
    let queued: HarnessResumeQueueRecord | undefined;
    if (bound) {
      await caller.reconcile(sessionId, bound.dispatchId);
      const target = await caller.ledger.get(sessionId, bound.dispatchId);
      if (!target || target.state === "cancelled") throw new HarnessDeliveryError("This dispatch is cancelled or was never admitted.");
      const receipt = (await caller.ledger.resume(sessionId, request.resumeId))!.receipt;
      if (["finished", "failed"].includes(target.state)) return { resumed: true, resumeId: request.resumeId, status: receipt.status === "running" ? target.state : receipt.status };
      await caller.ledger.assertActive(sessionId, bound.dispatchId);
      if (receipt.status !== "running" || turns.running(sessionId, bound.dispatchId)) return { resumed: true, resumeId: request.resumeId, status: receipt.status };
      request = { ...request, dispatchId: bound.dispatchId };
      const { claimedAt: _claimedAt, completedAt: _completedAt, ...unclaimed } = receipt.queued;
      await orchestration.resumeQueue.enqueue(unclaimed); queued = unclaimed;
    } else if (known?.latest.resumeId === request.resumeId) {
      const { latest } = known;
      if (latest.status !== "running" || resumingSessions.has(sessionId)) {
        return { resumed: true, resumeId: request.resumeId, status: latest.status };
      }
      // A restart cut this resume off, before or after it claimed its turn: queue the turn again
      // and continue it.
      const { claimedAt: _claimedAt, completedAt: _completedAt, ...unclaimed } = latest.queued;
      await orchestration.resumeQueue.enqueue(unclaimed);
      queued = unclaimed;
    } else {
      const earlier = known?.earlier.find((entry) => entry.resumeId === request.resumeId);
      if (earlier !== undefined) return { resumed: true, resumeId: request.resumeId, status: earlier.status };
      if (known?.latest.status === "running") {
        return { resumed: false, reason: "already-resumed", resumeId: known.latest.resumeId };
      }
      // The session's turn whose wait is over, the one `resumeParked` would claim next.
      await createDeadlineSweeper({ durable: orchestration }).tick();
      const now = new Date().toISOString();
      queued = (await orchestration.resumeQueue.listOpen(sessionId))
        .filter((record) => record.retryAt === undefined || record.retryAt <= now)
        .sort((left, right) => left.enqueuedAt.localeCompare(right.enqueuedAt))[0];
    }
    if (queued !== undefined) {
      const continuation = await orchestration.continuations.get(queued.continuationId);
      const identified = continuation ? await caller.ledger.byTurn(sessionId, continuation.originTurnId) : undefined;
      if (request.dispatchId && identified?.dispatchId !== request.dispatchId) throw new HarnessDeliveryError("This continuation belongs to another dispatch.");
      if (identified) { await caller.ledger.assertActive(sessionId, identified.dispatchId); request = { ...request, dispatchId: identified.dispatchId }; }
    }
    if (queued !== undefined && await startCallerResume(sessionId, request, queued)) {
      return { resumed: true, resumeId: request.resumeId, status: "running" };
    }
    const waiting = (await orchestration.continuations.listOpen(sessionId)).length > 0;
    return { resumed: false, reason: waiting ? "waiting" : "not-parked" };
  });

  /** Where the session's latest turn is, for a caller that lost an answer or an event. */
  const turnState = async (sessionId: string, dispatchId?: string): Promise<Record<string, unknown>> => {
    let identified = await caller.ledger.get(sessionId, dispatchId);
    if (identified) {
      await caller.reconcile(sessionId, identified.dispatchId);
      identified = (await caller.ledger.get(sessionId, identified.dispatchId))!;
      const active = turns.running(sessionId, identified.dispatchId);
      const resume = identified.resumes.find((r) => r.resumeId === identified!.resumeId);
      return { sessionId, dispatchId: identified.dispatchId, state: active && identified.state !== "cancelled" ? "running" : identified.state === "parked" ? "parked" : "idle", dispatchStatus: identified.state === "running" && !active ? "interrupted" : identified.state,
        ...(identified.resumeId ? { resumeId: identified.resumeId, resumeStatus: resume?.status === "running" && !active ? "interrupted" : resume?.status ?? "interrupted" } : {}),
        ...(identified.harnessTurnIds.at(-1) ? { turnId: identified.harnessTurnIds.at(-1) } : {}) };
    }
    if (dispatchId) return { sessionId, dispatchId, state: "idle", dispatchStatus: "unknown" };
    const isRunning = () => turns.running(sessionId) || resumingSessions.has(sessionId);
    const read = async () => (await resumes.get(sessionId))?.latest;
    const wasRunning = isRunning();
    const first = await read();
    const running = isRunning();
    // A resume that ended while its record was read saved its status before it ended: read again.
    const latest = wasRunning && !running ? await read() : first;
    const interrupted = latest?.status === "running" && !running;
    const orchestration = harness.config.host.durable;
    const open = orchestration === undefined ? [] : await orchestration.continuations.listOpen(sessionId);
    const queued = orchestration === undefined ? [] : await orchestration.resumeQueue.listOpen(sessionId);
    const continuationId = open[0]?.continuationId ?? queued[0]?.continuationId
      ?? (interrupted ? latest.continuationId : undefined);
    const lastTurn = await turnRecords.get(sessionId);
    return {
      sessionId,
      state: running ? "running" : continuationId !== undefined ? "parked" : "idle",
      ...(continuationId === undefined || running ? {} : { continuationId }),
      ...(latest === undefined ? {} : { resumeId: latest.resumeId, resumeStatus: interrupted ? "interrupted" : latest.status }),
      ...turnFields(lastTurn),
    };
  };

  /**
   * Ends the session's parked turn: off the queue, its continuations closed, and the questions
   * they waited on cancelled. True when there was one. Never while a resume claims the turn.
   */
  const endParkedWork = async (sessionId: string, dispatchId?: string): Promise<boolean> => {
    const orchestration = harness.config.host.durable;
    if (orchestration === undefined) return false;
    const target = dispatchId ? await caller.ledger.get(sessionId, dispatchId) : undefined;
    const matches = (record: { originTurnId: string }) => !dispatchId || target?.harnessTurnIds.includes(record.originTurnId) === true;
    const now = new Date().toISOString();
    const ended = [];
    for (const queued of await orchestration.resumeQueue.listOpen(sessionId)) {
      const record = await orchestration.continuations.get(queued.continuationId);
      if (!record || !matches(record)) continue;
      await endQueued(queued);
      if (record !== undefined) ended.push(record);
    }
    for (const record of await orchestration.continuations.listOpen(sessionId)) {
      if (!matches(record)) continue;
      const closed = await orchestration.continuations.transition(record.continuationId, "open", "closed", { updatedAt: now });
      if (closed.updated) ended.push(record);
    }
    for (const taskId of new Set(ended.flatMap((record) => record.waits.flatMap((wait) =>
      wait.predicate.kind === "tasks" ? wait.predicate.taskIds : [])))) {
      const task = await orchestration.tasks.getTask({ sessionId, taskId });
      if (task?.kind === "input") await orchestration.tasks.cancelTask({ sessionId, taskId });
    }
    return ended.length > 0;
  };
  const endParked = (sessionId: string, dispatchId?: string) => locked(sessionId, () => endParkedWork(sessionId, dispatchId));
  const stopDispatch = (sessionId: string, dispatchId: string) => locked(sessionId, async () => {
    await caller.ledger.cancel(sessionId, dispatchId);
    const stopped = turns.stop(sessionId, dispatchId);
    const ended = await endParkedWork(sessionId, dispatchId);
    return { stopped: stopped || ended, cancelled: true, dispatchId };
  });

  const hostname = options.hostname ?? "127.0.0.1";
  const api = createApi({
    harness,
    runner,
    connectors,
    resume,
    track,
    turns,
    resumeForCaller,
    turnState,
    endParked,
    sinks,
    turnRecords,
    caller, admitStart, stopDispatch, callerMode: options.resume === "caller",
    log,
    ...(options.parseExtraBody === undefined ? {} : { parseExtraBody: options.parseExtraBody }),
    ...(options.outcomes === undefined ? {} : { outcomes: options.outcomes }),
  });
  // The Host headers a tokenless API answers, set once the server is listening.
  let localHosts: ReadonlySet<string> = new Set();

  const server = createServer((req, res) => {
    void handle(req, res).catch((error) => {
      log(`[server] ${req.method} ${req.url} failed: ${message(error)}`);
      if (!res.headersSent) sendJson(res, 500, { error: "Internal error." });
      else res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const connectorMatch = /^\/connectors\/([^/]+)\/?$/u.exec(url.pathname);
    if (connectorMatch !== null) {
      const id = decode(connectorMatch[1]!);
      const connector = connectors.find((candidate) => candidate.id === id);
      if (connector === undefined) return sendJson(res, 404, { error: "No such connector." });
      return sendResponse(res, await connector.handle(toRequest(req)));
    }
    if (options.token === undefined) {
      // Without a token, only programs on this machine may call the API. Any web page open in the
      // developer's browser can send it a request (a text/plain POST needs no preflight), and a
      // page on a domain that resolves to 127.0.0.1 (DNS rebinding) can read the reply.
      const refused = nonLocalRequest(req, localHosts);
      if (refused !== undefined) return sendJson(res, refused.status, { error: refused.error });
    } else if (!sameSecret(req.headers.authorization, `Bearer ${options.token}`)) {
      return sendJson(res, 401, { error: "Send Authorization: Bearer <token>." });
    }
    const body = req.method === "POST" ? await readJson(req) : { value: undefined };
    if ("error" in body) return sendJson(res, 400, { error: body.error });
    const accept = req.headers.accept ?? "";
    const stream = url.searchParams.get("stream") === "1" || accept.includes("text/event-stream");
    const reply = await api(req.method ?? "GET", url, body.value, { stream });
    if ("response" in reply) return sendResponse(res, reply.response);
    return sendJson(res, reply.status, reply.body);
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 3000, hostname, () => resolve());
  });
  const address = server.address() as AddressInfo;
  if (options.token === undefined && !isLoopback(address.address)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await Promise.allSettled(connectors.map((connector) => connector.close()));
    throw new HarnessInputError(
      `Set a token (--token or LITTLE_HARNESS_TOKEN) to listen on ${address.address}. Without one, listen on a loopback address such as 127.0.0.1.`,
      { address: address.address },
    );
  }
  localHosts = new Set(
    ["localhost", "127.0.0.1", "[::1]", address.family === "IPv6" ? `[${address.address}]` : address.address]
      .flatMap((name) => (address.port === 80 ? [name, `${name}:80`] : [`${name}:${address.port}`])),
  );
  const url = `http://${hostname.includes(":") ? `[${hostname}]` : hostname}:${address.port}`;

  const interval = setInterval(() => track(tick()), options.intervalMs ?? 15_000);
  interval.unref();
  track(tick());

  log(`[server] ${options.agentName} on ${url}`);
  for (const connector of connectors) log(`[server]   ${connector.kind} connector at ${url}/connectors/${connector.id}`);
  if (schedules.length > 0) log(`[server]   schedules: ${schedules.map((entry) => entry.id).join(", ")}`);

  return {
    url,
    harness,
    tick,
    async close() {
      clearInterval(interval);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await Promise.allSettled([...background]);
      await Promise.allSettled(connectors.map((connector) => connector.close()));
    },
  };
}

type ApiReply = { readonly status: number; readonly body: unknown } | { readonly response: Response };

function createApi(context: {
  readonly harness: Harness;
  readonly runner: ScheduleRunner;
  readonly connectors: readonly MountedConnector[];
  readonly resume: () => Promise<void>;
  readonly track: (task: Promise<unknown>) => void;
  readonly turns: RunningTurns;
  readonly resumeForCaller: (
    sessionId: string,
    request: { readonly resumeId: string; readonly extraBody?: unknown; readonly sink?: TurnEventSink; readonly dispatchId?: string },
  ) => Promise<Record<string, unknown>>;
  readonly turnState: (sessionId: string, dispatchId?: string) => Promise<Record<string, unknown>>;
  readonly endParked: (sessionId: string, dispatchId?: string) => Promise<boolean>;
  readonly caller: ReturnType<typeof callerDelivery>;
  readonly callerMode: boolean;
  readonly admitStart: (sessionId: string, dispatchId: string, inputHash: string) => Promise<{ run: false; record: import("./delivery-ledger.js").CallerDispatch } | { run: true; record: import("./delivery-ledger.js").CallerDispatch; turn: ReturnType<RunningTurns["begin"]> }>;
  readonly stopDispatch: (sessionId: string, dispatchId: string) => Promise<Record<string, unknown>>;
  readonly sinks: ReturnType<typeof parkedSinks>;
  readonly turnRecords: ReturnType<typeof latestTurns>;
  readonly log: (line: string) => void;
  readonly parseExtraBody?: (value: unknown) => unknown;
  readonly outcomes?: { readonly sinks: readonly HarnessOutcomeSink[] };
}): (method: string, url: URL, body: unknown, request: { readonly stream: boolean }) => Promise<ApiReply> {
  const { harness } = context;
  const parseExtraBody = async (value: unknown): Promise<{ readonly extraBody: unknown } | { readonly refused: ApiReply }> => {
    try {
      // Called without one too, so a server can require it.
      return { extraBody: context.parseExtraBody === undefined ? value : await context.parseExtraBody(value) };
    } catch (error) {
      return { refused: { status: 400, body: { error: `extraBody was refused: ${message(error)}` } } };
    }
  };
  return async (method, url, body, request) => {
    const segments = url.pathname.split("/").filter(Boolean).map(decode);
    if (segments.includes(undefined)) return { status: 400, body: { error: "The path is not valid URL encoding." } };
    let path = segments as string[];
    try {
    let input = isRecord(body) ? body : {};
    let scopedDispatchId: string | undefined;
    if (path[0] === "sessions" && path[2] === "dispatches") {
      if (!context.callerMode) return { status: 400, body: { error: "Identified dispatches require resume: caller." } };
      scopedDispatchId = callerId(path[3], "dispatchId");
      if (!scopedDispatchId || !["messages", "resume", "stop", "staged", "turn"].includes(path[4] ?? "") || path.length !== (path[4] === "staged" ? 6 : 5)) return { status: 404, body: { error: "Unknown scoped dispatch route." } };
      for (const value of [input.dispatchId, input.expectedDispatchId, url.searchParams.get("dispatchId") ?? undefined]) if (value !== undefined && value !== scopedDispatchId) return { status: 409, body: { error: "The body target conflicts with the scoped dispatch path." } };
      const messageId = path[4] === "staged" ? callerId(path[5], "messageId") : undefined;
      if (input.messageId !== undefined && input.messageId !== messageId) return { status: 409, body: { error: "The body messageId conflicts with the scoped message path." } };
      input = { ...input, dispatchId: scopedDispatchId, ...(path[4] === "stop" ? { expectedDispatchId: scopedDispatchId } : {}), ...(messageId ? { messageId } : {}) };
      path = ["sessions", path[1]!, path[4]!, ...(method === "GET" && messageId ? [messageId] : [])];
    }
      if (method === "POST" && path[0] === "sessions" && path.length === 3 && ["messages", "resume", "stop", "staged"].includes(path[2]!)) {
        const identified = scopedDispatchId !== undefined || input.dispatchId !== undefined || input.expectedDispatchId !== undefined || input.messageId !== undefined;
        if (identified && !context.callerMode) return { status: 400, body: { error: "Identified dispatches require resume: caller." } };
        // Pin before asynchronous parsing or admission. This also fences a first Stop.
        // Sessions from older servers have a durable latest-turn receipt but no mode pin.
        const mode = await context.caller.ledger.read(path[1]!);
        if (identified && mode.mode !== "identified" && mode.dispatches.length === 0 && ((await harness.sessions.get(path[1]!)) || (await context.turnRecords.get(path[1]!)) || (await harness.config.host.durable?.continuations.listOpen(path[1]!) ?? []).length || (await harness.config.host.durable?.resumeQueue.listOpen(path[1]!) ?? []).length)) throw new HarnessDeliveryError("An existing host/legacy session cannot convert to identified mode. Create a new session.");
        await context.caller.ledger.pinMode(path[1]!, identified ? "identified" : "legacy");
      }
      if (method === "GET" && path.length === 0) {
        return ok({
          connectors: context.connectors.map(({ id, kind }) => ({ id, kind, path: `/connectors/${id}` })),
          inputTypes: Object.keys(harness.config.inputTypes ?? {}),
          schedules: await context.runner.list(),
          humanInput: harness.config.humanInput !== undefined,
        });
      }
      if (method === "POST" && path[0] === "sessions" && path.length === 3 && path[2] === "messages") {
        const sessionId = path[1]!;
        const dispatchId = callerId(input.dispatchId, "dispatchId");
        if (dispatchId && !context.callerMode) return { status: 400, body: { error: "Identified dispatches require resume: caller." } };
        const prompt = typeof input.prompt === "string" ? input.prompt : undefined;
        const messages = Array.isArray(input.messages) ? (input.messages as UIMessage[]) : undefined;
        if (prompt === undefined && messages === undefined) return { status: 400, body: { error: "Send `prompt` or `messages`." } };
        const parsed = await parseExtraBody(input.extraBody);
        if ("refused" in parsed) return parsed.refused;
        const { extraBody } = parsed;
        const trigger = triggerFrom(input.trigger);
        if (trigger === null) return { status: 400, body: { error: "`trigger` needs a `kind`, and its fields must be short text." } };
        const sink = sinkFrom(input.events);
        if (sink === null) return { status: 400, body: { error: "`events` needs an http(s) `url`, and `headers` of text." } };
        const admitted = dispatchId ? await context.admitStart(sessionId, dispatchId, stableHash({ prompt: prompt ?? null, messages: messages ?? null, extraBody: extraBody ?? null, trigger: trigger ?? null })) : undefined;
        if (admitted?.run === false) return ok({ accepted: true, dispatchId, dispatchStatus: admitted.record.state });
        const turn = admitted?.run ? admitted.turn : context.turns.begin(sessionId);
        const runId = admitted?.record.startRunId;
        const delivery = sink === undefined ? undefined : createTurnEventDelivery(sink, { sessionId, log: context.log });
        let started: HarnessTurnStart | undefined;
        const run = {
          harness,
          session: sessionId,
          onTurnStart: async (start: HarnessTurnStart) => {
            if (dispatchId && runId) { await context.caller.assert(sessionId, dispatchId); await context.caller.ledger.startRun(sessionId, dispatchId, runId, start.turnId); }
            turn.signal.throwIfAborted();
            started = start;
            await context.turnRecords.save(start);
          },
          ...(prompt === undefined ? {} : { prompt }),
          ...(messages === undefined ? {} : { messages }),
          ...(extraBody === undefined ? {} : { extraBody }),
          trigger: trigger ?? { kind: "api", source: "POST /sessions/<session>/messages" },
          abortSignal: turn.signal,
          inbox: dispatchId && runId ? context.caller.inbox(sessionId, dispatchId, runId, () => delivery) : turn.inbox,
          ...(dispatchId ? { beforeInvocation: () => context.caller.assert(sessionId, dispatchId).then(() => undefined) } : {}),
          ...(runId ? { runId, sessionLog: context.caller.logFor(runId) } : {}),
          onEvent: async (event: HarnessEvent) => {
            if (deliversHarnessEvent(event)) delivery?.push({ type: "harness", event });
          },
        };
        if (request.stream || delivery !== undefined) {
          // The UI message stream, as AI SDK's useChat reads it; with a sink, its text deltas are
          // sent there too. The turn ends when the stream does.
          const streamed = streamHarness(run);
          let ui = streamed.toUIMessageStream() as ReadableStream<{ type: string; delta?: string }>;
          let deltas: Promise<void> = Promise.resolve();
          if (delivery !== undefined) {
            const [forClient, forSink] = ui.tee();
            ui = forClient;
            deltas = pushTextDeltas(forSink, delivery);
          }
          const outcome = Promise.allSettled([streamed.finished, streamed.text, deltas]).then(async ([finished, text]) => {
            let last = withTurn(
              finished.status === "rejected"
                ? failedEvent(turn.stoppedBy(finished.reason) ?? finished.reason)
                : finished.value.status === "parked"
                  ? { type: "turn.parked" as const, continuationId: finished.value.continuationId, pending: finished.value.pending }
                  : { type: "turn.finished" as const, text: text.status === "fulfilled" ? text.value : "" },
              started,
            );
            if (dispatchId) {
              const ended = await context.caller.end(sessionId, dispatchId, last.type === "turn.parked" ? "parked" : last.type === "turn.finished" ? "finished" : "failed", runId!, delivery);
              if (ended.state === "cancelled") { await context.endParked(sessionId, dispatchId); last = withTurn(failedEvent(new HarnessTurnLimitError("Interrupted", "The caller cancelled this dispatch.")), started); }
            }
            const unread = turn.end();
            if (delivery === undefined) return;
            if (unread.length > 0) delivery.push({ type: "turn.unread", messages: unread });
            if (last.type === "turn.parked") await context.sinks.save(sessionId, sink!);
            delivery.push(last);
            await delivery.close();
          });
          if (request.stream) {
            context.track(outcome);
            return { response: createUIMessageStreamResponse({ stream: ui as ReadableStream<any> }) };
          }
          // A failed turn errors its stream; `finished` says why.
          await drain(ui).catch(() => undefined);
          const finished = await streamed.finished.catch((error: unknown) => ({ error }));
          const unread = unreadField(turn.end());
          context.track(outcome);
          if ("error" in finished) {
            const stopped = turn.stoppedBy(finished.error);
            if (stopped !== undefined) return ok({ status: "failed", sessionId, reason: stopped.reason, error: stopped.message, ...turnFields(started), ...unread });
            throw finished.error;
          }
          if (finished.status === "parked") {
            return ok({ status: "parked", sessionId, continuationId: finished.continuationId, pending: finished.pending, ...turnFields(started), ...unread });
          }
          return ok({ status: "completed", sessionId, text: await streamed.text, ...turnFields(started), ...unread });
        }
        try {
          const result = await generateHarness(run);
          if (dispatchId) {
            const ended = await context.caller.end(sessionId, dispatchId, result.status === "parked" ? "parked" : "finished", runId!);
            if (ended.state === "cancelled") { await context.endParked(sessionId, dispatchId); throw new HarnessTurnLimitError("Interrupted", "The caller cancelled this dispatch."); }
          }
          return ok({ ...turnJson(result), ...turnFields(started), ...unreadField(turn.end()) });
        } catch (error) {
          if (dispatchId) await context.caller.end(sessionId, dispatchId, "failed", runId!);
          const unread = unreadField(turn.end());
          const stopped = turn.stoppedBy(error);
          if (stopped !== undefined) return ok({ status: "failed", sessionId, reason: stopped.reason, error: stopped.message, ...turnFields(started), ...unread });
          throw error;
        } finally {
          turn.end();
        }
      }
      if (method === "POST" && path[0] === "sessions" && path.length === 3 && path[2] === "stop") {
        const expectedDispatchId = callerId(input.expectedDispatchId, "expectedDispatchId");
        if (expectedDispatchId) {
          if (!context.callerMode) return { status: 400, body: { error: "Conditional Stop requires resume: caller." } };
          return ok(await context.stopDispatch(path[1]!, expectedDispatchId));
        }
        // A running turn stops after its current step; a parked one ends, its questions cancelled.
        const stopped = context.turns.stop(path[1]!);
        const ended = await context.endParked(path[1]!);
        return ok({ stopped: stopped || ended });
      }
      if (method === "POST" && path[0] === "sessions" && path.length === 3 && path[2] === "resume") {
        const dispatchId = callerId(input.dispatchId, "dispatchId");
        if (dispatchId && !context.callerMode) return { status: 400, body: { error: "Identified dispatches require resume: caller." } };
        const resumeId = typeof input.resumeId === "string" ? input.resumeId : "";
        if (resumeId.length === 0 || resumeId.length > 200) {
          return { status: 400, body: { error: "Send `resumeId`: your id for this resume, up to 200 characters." } };
        }
        const parsed = await parseExtraBody(input.extraBody);
        if ("refused" in parsed) return parsed.refused;
        const sink = sinkFrom(input.events);
        if (sink === null) return { status: 400, body: { error: "`events` needs an http(s) `url`, and `headers` of text." } };
        return ok(await context.resumeForCaller(path[1]!, {
          resumeId,
          ...(dispatchId ? { dispatchId } : {}),
          ...(parsed.extraBody === undefined ? {} : { extraBody: parsed.extraBody }),
          ...(sink === undefined ? {} : { sink }),
        }));
      }
      if (method === "POST" && path[0] === "sessions" && path.length === 3 && path[2] === "outcomes") {
        if (context.outcomes === undefined) {
          return { status: 404, body: { error: "This server takes no outcomes: start it with `outcomes: { sinks }`." } };
        }
        const outcome = outcomeFrom(input);
        if (typeof outcome === "string") return { status: 400, body: { error: outcome } };
        const reported = await reportHarnessOutcome({
          harness,
          sessionId: path[1]!,
          ...outcome,
          source: outcome.source ?? "agent-server",
          sinks: context.outcomes.sinks,
        });
        // Never thrown: an outcome is an observation. Without an event, the session wasn't found.
        if (reported.event === undefined) return { status: 404, body: { error: `No session ${path[1]!}.` } };
        // `stale`: sinks whose store holds this revision with a retraction, or a newer one (G24).
        const reply = {
          recorded: reported.recorded,
          delivered: reported.delivered,
          stale: reported.stale,
          failed: reported.failed,
          eventId: reported.event.eventId,
        };
        if (reported.failed > 0) {
          // The caller tries again; a sink takes a repeat of the same reportKey as the same report.
          return { status: 502, body: { ...reply, error: reported.errors.map((error) => error.message).join("; ") } };
        }
        return ok(reply);
      }
      if (method === "GET" && path[0] === "sessions" && path.length === 3 && path[2] === "turn") {
        return ok(await context.turnState(path[1]!, scopedDispatchId ?? callerId(url.searchParams.get("dispatchId") ?? undefined, "dispatchId")));
      }
      if (method === "GET" && path[0] === "sessions" && path.length === 4 && path[2] === "staged") {
        if (!context.callerMode) return { status: 400, body: { error: "Identified staging requires resume: caller." } };
        const found = await context.caller.ledger.message(path[1]!, path[3]!);
        if (!found) return { status: 404, body: { error: "No staged message with that id." } };
        if (scopedDispatchId && found.dispatchId !== scopedDispatchId) return { status: 409, body: { error: "The staged message belongs to another dispatch." } };
        await context.caller.reconcile(path[1]!, found.dispatchId);
        return ok(messageStatus((await context.caller.ledger.message(path[1]!, path[3]!))!));
      }
      if (method === "POST" && path[0] === "sessions" && path.length === 3 && path[2] === "staged") {
        const text = typeof input.text === "string" ? input.text : undefined;
        if (text === undefined || text.trim().length === 0) return { status: 400, body: { error: "Send `text`." } };
        const dispatchId = callerId(input.dispatchId, "dispatchId"), messageId = callerId(input.messageId, "messageId");
        if (dispatchId || messageId) {
          if (!context.callerMode) return { status: 400, body: { error: "Identified staging requires resume: caller." } };
          if (!dispatchId || !messageId || text.length > 20_000) return { status: 400, body: { error: "Identified staging needs dispatchId, messageId and text up to 20000 characters." } };
          await context.caller.reconcile(path[1]!, dispatchId);
          const staged = await context.caller.ledger.stage(path[1]!, dispatchId, messageId, text);
          return { status: staged.state === "unread" ? 409 : 202, body: { staged: staged.state !== "unread", ...messageStatus(staged) } };
        }
        if (!context.turns.stage(path[1]!, text)) {
          return { status: 409, body: { error: "No turn is running in this session. Send the message as a new turn." } };
        }
        return { status: 202, body: { staged: true } };
      }
      if (method === "POST" && path[0] === "jobs" && path.length === 2) {
        if (!Object.hasOwn(harness.config.inputTypes ?? {}, path[1]!)) {
          return { status: 404, body: { error: `No Input Type '${path[1]}'.` } };
        }
        const result = await generateHarness({
          harness,
          type: path[1]!,
          input: input.input,
          ...(typeof input.session === "string" ? { session: input.session } : {}),
          trigger: { kind: "api", source: `POST /jobs/${path[1]!}` },
        });
        return ok(turnJson(result));
      }
      if (method === "GET" && path[0] === "questions" && path.length === 1) {
        const sessionId = url.searchParams.get("session") ?? undefined;
        const status = url.searchParams.get("status") ?? undefined;
        return ok(await listInputRequests({
          harness,
          ...(sessionId === undefined ? {} : { sessionId }),
          ...(status === "all" || status === "answered" || status === "cancelled" || status === "waiting" ? { status } : {}),
        }));
      }
      const answerPath = method === "POST" && path[0] === "sessions" && path[2] === "questions"
        && ((path.length === 5 && path[4] === "answer") || (path.length === 4 && path[3] === "answer"));
      if (answerPath) {
        // By its id in the path, or by the id or key a tool asked it with in the body.
        const requestId = path.length === 5 ? path[3]! : typeof input.requestId === "string" ? input.requestId : undefined;
        const key = typeof input.key === "string" ? input.key : undefined;
        if (requestId === undefined && key === undefined) return { status: 400, body: { error: "Send `key` or `requestId`." } };
        const answered = await answerInputRequest({
          harness,
          sessionId: path[1]!,
          ...(requestId === undefined ? { key: key! } : { requestId }),
          answer: pick(input, ["option", "text", "value"]) as HumanInputAnswer,
          ...(typeof input.answeredBy === "string" ? { answeredBy: input.answeredBy } : {}),
        });
        // Continue the turn that was waiting for this answer without holding the reply.
        context.track(context.resume());
        return ok(answered);
      }
      if (method === "POST" && path[0] === "schedules" && path.length === 3 && path[2] === "run") {
        const run = await context.runner.run(path[1]!);
        const { finished: _finished, outcome, ...rest } = run;
        return ok({
          ...rest,
          ...(outcome.status === "failed" ? { status: "failed", error: message(outcome.error) } : turnJson(outcome.result)),
        });
      }
      return { status: 404, body: { error: `No route ${method} ${url.pathname}.` } };
    } catch (error) {
      if (error instanceof HarnessDeliveryError) return { status: error.status, body: { error: error.message } };
      if (error instanceof LittleHarnessError) return { status: 400, body: { error: error.message } };
      throw error;
    }
  };
}

type RunningTurns = {
  begin(sessionId: string, dispatchId?: string): {
    readonly signal: AbortSignal;
    /** Messages staged for the session while this turn runs. */
    readonly inbox: HarnessInbox;
    /** The limit or stop that ended the turn, when one did. */
    stoppedBy(error: unknown): HarnessTurnLimitError | undefined;
    /**
     * Ends the turn. Returns the staged messages no turn read, when it was the session's last: the
     * caller sends them as a new turn. Calling it again returns the same.
     */
    end(): readonly string[];
  };
  /** Stops the session's running turn and any waiting behind it. False when there are none. */
  stop(sessionId: string, dispatchId?: string): boolean;
  /** Whether a turn runs in the session now. */
  running(sessionId: string, dispatchId?: string): boolean;
  /** Stages a message for the session's running turn. False when none is running. */
  stage(sessionId: string, text: string): boolean;
};

/** The turns this server is running, by session, so `POST /sessions/:id/stop` can stop them. */
function runningTurns(): RunningTurns {
  const bySession = new Map<string, Set<AbortController>>();
  const staged = new Map<string, string[]>();
  const dispatchByController = new WeakMap<AbortController, string>();
  return {
    begin(sessionId, dispatchId) {
      const controller = new AbortController();
      if (dispatchId) dispatchByController.set(controller, dispatchId);
      const turns = bySession.get(sessionId) ?? new Set<AbortController>();
      turns.add(controller);
      bySession.set(sessionId, turns);
      let unread: readonly string[] | undefined;
      return {
        signal: controller.signal,
        inbox: {
          take: () => {
            const messages = staged.get(sessionId) ?? [];
            staged.delete(sessionId);
            return messages;
          },
        },
        stoppedBy: (error) => {
          if (error instanceof HarnessTurnLimitError) return error;
          const reason: unknown = controller.signal.reason;
          return controller.signal.aborted && reason instanceof HarnessTurnLimitError ? reason : undefined;
        },
        end: () => {
          if (unread !== undefined) return unread;
          turns.delete(controller);
          unread = [];
          if (turns.size === 0 && bySession.get(sessionId) === turns) {
            bySession.delete(sessionId);
            unread = staged.get(sessionId) ?? [];
            staged.delete(sessionId);
          }
          return unread;
        },
      };
    },
    stage(sessionId, text) {
      if ((bySession.get(sessionId)?.size ?? 0) === 0) return false;
      staged.set(sessionId, [...(staged.get(sessionId) ?? []), text]);
      return true;
    },
    running(sessionId, dispatchId) {
      return [...bySession.get(sessionId) ?? []].some((controller) => !dispatchId || dispatchByController.get(controller) === dispatchId);
    },
    stop(sessionId, dispatchId) {
      const turns = bySession.get(sessionId);
      if (turns === undefined || turns.size === 0) return false;
      const matching = [...turns].filter((controller) => !dispatchId || dispatchByController.get(controller) === dispatchId);
      for (const controller of matching) controller.abort(new HarnessTurnLimitError("Interrupted", "The turn was stopped."));
      return matching.length > 0;
    },
  };
}

/** A request's `trigger`: undefined when it sent none, null when what it sent is not one. */
function triggerFrom(value: unknown): HarnessTrigger | undefined | null {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return null;
  const fields = ["kind", "source", "from", "label"] as const;
  if (typeof value.kind !== "string" || value.kind.length === 0) return null;
  const out: Record<string, string> = {};
  for (const field of fields) {
    const entry = value[field];
    if (entry === undefined) continue;
    if (typeof entry !== "string" || entry.length > 200) return null;
    out[field] = entry;
  }
  return out as HarnessTrigger;
}

/** Sends the text deltas of a turn's UI message stream to its sink. */
async function pushTextDeltas(stream: ReadableStream<{ type: string; delta?: string }>, delivery: TurnEventDelivery): Promise<void> {
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    if (value.type === "text-delta" && typeof value.delta === "string") delivery.push({ type: "text-delta", text: value.delta });
  }
}

function unreadField(unread: readonly string[]): { unread?: readonly string[] } {
  return unread.length === 0 ? {} : { unread };
}

async function drain(stream: ReadableStream): Promise<void> {
  const reader = stream.getReader();
  while (!(await reader.read()).done) {
    // Read to the end, so the turn runs to its end.
  }
}

function outcomeEvent(result: HarnessTurnResult<unknown>): DeliveredTurnEvent {
  return result.status === "parked"
    ? { type: "turn.parked", continuationId: result.continuationId, pending: result.pending }
    : { type: "turn.finished", text: result.text };
}

/** An ending event with the turn it ends: its id and the metadata its `turnOptions` returned. */
function withTurn(event: DeliveredTurnEvent, started: HarnessTurnStart | undefined): DeliveredTurnEvent {
  if (event.type !== "turn.finished" && event.type !== "turn.parked" && event.type !== "turn.failed") return event;
  return { ...event, ...turnFields(started) };
}

function turnFields(started: HarnessTurnStart | undefined): EndedTurn {
  if (started === undefined) return {};
  return { turnId: started.turnId, ...(started.metadata === undefined ? {} : { metadata: started.metadata }) };
}

const OUTCOME_STATUSES: readonly string[] = ["success", "failure", "partial"];

/** A `POST /sessions/:id/outcomes` body, or what is wrong with it. */
function outcomeFrom(input: Record<string, unknown>): (HarnessOutcomeInput & { readonly turnId: string }) | string {
  const text = (field: string, max: number): string | undefined | null => {
    const value = input[field];
    if (value === undefined) return undefined;
    return typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
  };
  if (typeof input.status !== "string" || !OUTCOME_STATUSES.includes(input.status)) {
    return "Send `status`: success, failure or partial.";
  }
  const turnId = text("turnId", 200);
  if (turnId === undefined || turnId === null) return "Send `turnId`: the turn the outcome is about.";
  const detail = text("detail", 2000);
  const reporter = text("reporter", 200);
  const reportKey = text("reportKey", 200);
  const source = text("source", 100);
  if (detail === null || reporter === null || reportKey === null || source === null) {
    return "`detail` (up to 2000 characters), `reporter`, `reportKey` (up to 200) and `source` (up to 100) are text.";
  }
  if (input.retracted !== undefined && typeof input.retracted !== "boolean") return "`retracted` is true or false.";
  if (input.score !== undefined && (typeof input.score !== "number" || !Number.isFinite(input.score))) return "`score` is a number.";
  if (input.revision !== undefined) {
    if (!isRevision(input.revision)) return "`revision` is a whole number from 0.";
    if (reportKey === undefined) return "`revision` orders reports under one `reportKey`: send the key too.";
  }
  return {
    status: input.status as HarnessOutcomeInput["status"],
    turnId,
    ...(detail === undefined ? {} : { detail }),
    ...(reporter === undefined ? {} : { reporter }),
    ...(reportKey === undefined ? {} : { reportKey }),
    ...(source === undefined ? {} : { source }),
    ...(input.retracted === undefined ? {} : { retracted: input.retracted }),
    ...(input.score === undefined ? {} : { score: input.score }),
    ...(input.revision === undefined ? {} : { revision: input.revision as number }),
  };
}

function failedEvent(error: unknown): DeliveredTurnEvent {
  return {
    type: "turn.failed",
    error: message(error),
    ...(error instanceof HarnessTurnLimitError ? { reason: error.reason } : {}),
  };
}

function turnJson(result: HarnessTurnResult<unknown>): Record<string, unknown> {
  if (result.status === "parked") {
    return { status: "parked", sessionId: result.session.id, continuationId: result.continuationId, pending: result.pending };
  }
  return {
    status: "completed",
    sessionId: result.session.id,
    text: result.text,
    ...(result.output === result.text ? {} : { output: result.output }),
  };
}

function describeTurn(result: HarnessTurnResult<unknown>, full: boolean): string {
  if (result.status === "parked") return "parked again, waiting";
  if (full) return `completed:\n${result.text}`;
  const text = result.text.replace(/\s+/gu, " ").trim();
  return `completed: ${text.length > 120 ? `${text.slice(0, 120)}…` : text}`;
}

function toRequest(req: IncomingMessage): Request {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) for (const entry of value) headers.append(name, entry);
    else if (value !== undefined) headers.set(name, value);
  }
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  return new Request(url, {
    method: req.method ?? "GET",
    headers,
    ...(hasBody ? { body: Readable.toWeb(req) as ReadableStream<Uint8Array>, duplex: "half" } : {}),
  } as RequestInit);
}

async function sendResponse(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, name) => {
    if (name !== "set-cookie") res.setHeader(name, value);
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) res.setHeader("set-cookie", cookies);
  if (response.body === null) {
    res.end();
    return;
  }
  for await (const chunk of response.body) res.write(chunk);
  res.end();
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(`${JSON.stringify(body)}\n`);
}

async function readJson(req: IncomingMessage): Promise<{ readonly value: unknown } | { readonly error: string }> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 10 * 1024 * 1024) return { error: "The request body is over 10 MB." };
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return { value: undefined };
  try {
    return { value: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
  } catch {
    return { error: "The request body is not JSON." };
  }
}

function ok(body: unknown): ApiReply {
  return { status: 200, body };
}

function pick(record: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter((key) => record[key] !== undefined).map((key) => [key, record[key]]));
}

function decode(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}

/** Compares in constant time, so the token cannot be guessed from response times. */
function sameSecret(given: string | undefined, expected: string): boolean {
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return given !== undefined && timingSafeEqual(digest(given), digest(expected));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether the address the server is bound to is this machine only: 127.0.0.0/8 or ::1. */
function isLoopback(address: string): boolean {
  return /^(?:::ffff:)?127\.\d+\.\d+\.\d+$/iu.test(address) || address === "::1";
}

/**
 * Why a tokenless API refuses a request, if it does: it is addressed to another host name (DNS
 * rebinding), it comes from a web page, or its body is not declared JSON (a form or a text/plain
 * fetch, which browsers send cross-origin without asking).
 */
function nonLocalRequest(
  req: IncomingMessage,
  localHosts: ReadonlySet<string>,
): { readonly status: number; readonly error: string } | undefined {
  if (!localHosts.has(req.headers.host?.toLowerCase() ?? "")) {
    return { status: 403, error: "Without a token, the API answers only requests to localhost, 127.0.0.1 or [::1]." };
  }
  const site = req.headers["sec-fetch-site"];
  if (req.headers.origin !== undefined || site === "cross-site" || site === "same-site") {
    return { status: 403, error: "Without a token, the API does not answer requests from web pages." };
  }
  const contentType = req.headers["content-type"]?.split(";")[0]?.trim().toLowerCase();
  if (req.method !== "GET" && req.method !== "HEAD" && contentType !== "application/json") {
    return { status: 415, error: "Send content-type: application/json." };
  }
  return undefined;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
