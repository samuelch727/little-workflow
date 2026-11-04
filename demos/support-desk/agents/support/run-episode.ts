import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { UIMessage } from "ai";
import {
  generateHarness,
  loadHarness,
  type Harness,
  type HarnessEvent,
  type HarnessSession,
} from "@little-stack/harness";
import { bindEpisode, createEpisode, readActions, unbindEpisode, type ActionEntry } from "./episode";
import { episodeTraceId, overridesFor, supportLittleDb, type SupportTurnOverrides, type SupportVersionContent } from "./littledb";

/**
 * One episode — one scripted customer, one fresh database, one session — as a function.
 *
 * `experiment/run.mjs` is a thin driver over this, and the tests call it directly. The split
 * matters for the same reason it does in `demos/dreamer`: the model seam lives on
 * `globalThis`, so a mock model can only be installed for an episode that runs in the test's
 * own process. A spawned driver receives one through the `--import` preload instead.
 */

export const supportAgentDir = dirname(fileURLToPath(import.meta.url));

let cachedHarness: Promise<Harness> | undefined;

/**
 * Load the agent folder once per process.
 *
 * Not just an optimisation: `loadHarness` goes through jiti, whose module cache is
 * process-wide, so a second load would return the SAME `agent.ts` instance — with the model
 * it captured on the first load — while paying to re-discover the tools. One explicit cache
 * is clearer than that accident.
 */
export function supportHarness(): Promise<Harness> {
  cachedHarness ??= loadHarness(supportAgentDir);
  return cachedHarness;
}

export type EpisodeTurnRecord = {
  readonly user: string;
  readonly assistant: string;
  readonly toolCalls: readonly string[];
};

export type EpisodeResult = {
  readonly sessionId: string;
  readonly session: HarnessSession;
  readonly episodeDir: string;
  readonly turns: readonly EpisodeTurnRecord[];
  /** Every tool the agent called, in order, across every turn. */
  readonly toolCalls: readonly string[];
  /** The LittleDB version the episode ran on; `null` without LittleDB or on the bootstrap fallback. */
  readonly versionId: string | null;
  /** The LittleDB trace the episode was sent to; `null` when it was not traced. */
  readonly traceId: string | null;
  /** True when a scripted turn was withheld because the episode was already resolved. */
  readonly turnsWithheld: number;
};

export type RunEpisodeOptions = {
  readonly sessionId: string;
  readonly episodeDir: string;
  /** The scripted customer, turn by turn. `turns[0]` is the opening request. */
  readonly turns: readonly string[];
  /**
   * Asked before every turn after the first: is the episode still unresolved?
   *
   * This is the demo's translation of kb-chatbot's "only argue with a failure" rule into a
   * world graded on end state. The driver answers by grading the database as it stands: if
   * the episode has already reached the outcome the policy calls for, the remaining scripted
   * pushback is withheld, because arguing with an agent that has just done the right thing
   * is theatre and would put words in the transcript that the run does not deserve.
   */
  readonly shouldSendTurn?: (turnIndex: number) => boolean | Promise<boolean>;
  /**
   * Send the episode to LittleDB as a trace. FALSE for gate runs: a gate episode must never
   * become history the reviewer can read. See `littledb.ts`'s `tracerFor`.
   */
  readonly telemetry?: boolean;
  /**
   * Run this version instead of resolving one: an eval worker runs the version LittleDB
   * handed it, with its own tracer (the experiment run's trace).
   */
  readonly version?: { readonly content: SupportVersionContent; readonly versionId: string | null };
  readonly tracer?: { readonly onEvent: (event: HarnessEvent) => Promise<void>; readonly traceId: string };
};

/**
 * The turn record the NEXT turn sees: what the agent did, as tool parts.
 *
 * Without this an episode is amnesiac. `generateHarness` builds the model's messages from
 * exactly what it is handed, so a history of plain assistant text would leave the agent in
 * turn 3 unable to see that it escalated in turn 2 — and policy §5 ("record each outcome
 * once") and the two-strike verification rule both need that memory. `convertToModelMessages`
 * turns a `tool-<name>` part into the assistant tool-call plus the tool-result message pair,
 * which is the same shape the model saw live.
 *
 * The output carried forward is the action log's `outcome` — the durable record of the call —
 * rather than the verbatim tool result. That is a deliberate compaction, and it is the
 * conservative direction: the agent remembers what it DID (this order, this amount, this
 * reason code, verified or not) and has to look facts up again if it wants them, which is
 * both realistic context management and impossible to mistake for a fact it never fetched.
 */
function turnRecordParts(actions: readonly ActionEntry[], messageId: string): UIMessage["parts"] {
  return actions.map((action) => ({
    type: `tool-${action.tool}`,
    toolCallId: `${messageId}-${action.seq}`,
    state: "output-available",
    input: action.input,
    output: action.ok ? action.outcome : { error: action.outcome.error ?? "the call failed" },
  })) as UIMessage["parts"];
}

export async function runEpisode(options: RunEpisodeOptions): Promise<EpisodeResult> {
  const { sessionId, episodeDir, turns } = options;
  createEpisode(episodeDir);
  bindEpisode(sessionId, episodeDir);

  const harness = await supportHarness();
  const db = supportLittleDb();
  let overrides: SupportTurnOverrides | undefined;
  let versionId: string | null = null;
  let tracer = options.tracer;
  if (options.version !== undefined) {
    overrides = overridesFor(options.version.content);
    versionId = options.version.versionId;
  } else if (db !== undefined) {
    const prepared = await db.prepareSession(sessionId);
    overrides = prepared.overrides;
    versionId = prepared.resolution.versionId;
    if (tracer === undefined && options.telemetry !== false) {
      const sessionTracer = db.tracerFor(sessionId, prepared.resolution);
      tracer = { onEvent: sessionTracer.onEvent, traceId: episodeTraceId(sessionId) };
    }
  }

  const history: UIMessage[] = [];
  const records: EpisodeTurnRecord[] = [];
  const allToolCalls: string[] = [];
  let withheld = 0;
  let session: HarnessSession | undefined;

  try {
    for (const [index, text] of turns.entries()) {
      if (index > 0 && options.shouldSendTurn !== undefined) {
        if (!(await options.shouldSendTurn(index))) {
          withheld = turns.length - index;
          break;
        }
      }

      history.push({ id: `${sessionId}-u${index + 1}`, role: "user", parts: [{ type: "text", text }] });
      const turnToolCalls: string[] = [];
      const actionsBefore = readActions(episodeDir).length;

      const result = await generateHarness({
        harness,
        session: sessionId,
        // The whole conversation every turn: `generateHarness` builds the model's messages
        // from what it is handed, exactly as the chat connector does for a thread.
        messages: [...history],
        ...(overrides === undefined ? {} : overrides),
        onEvent: async (event: HarnessEvent) => {
          if (event.type === "harness.tool_call.succeeded" || event.type === "harness.tool_call.failed") {
            const name = event.metadata?.toolName;
            if (typeof name === "string") turnToolCalls.push(name);
          }
          await tracer?.onEvent(event);
        },
      });

      // Episodes run on a local host without parking, so every turn must complete.
      if (result.status !== "completed") {
        throw new Error(`episode turn ended as ${result.status}, expected completed`);
      }
      session = result.session;
      const messageId = `${sessionId}-a${index + 1}`;
      history.push({
        id: messageId,
        role: "assistant",
        parts: [
          ...turnRecordParts(readActions(episodeDir).slice(actionsBefore), messageId),
          { type: "text", text: result.text },
        ],
      });
      records.push({ user: text, assistant: result.text, toolCalls: [...turnToolCalls] });
      allToolCalls.push(...turnToolCalls);
    }
  } finally {
    unbindEpisode(sessionId);
  }

  if (session === undefined) throw new Error("An episode must have at least one turn.");

  return {
    sessionId,
    session,
    episodeDir,
    turns: records,
    toolCalls: allToolCalls,
    versionId,
    traceId: tracer?.traceId ?? null,
    turnsWithheld: withheld,
  };
}

/**
 * Score an episode in LittleDB: `task_success` (did the database end up right) and
 * `policy_compliance` (did the calls obey `policy.md`), 1 or 0, on the episode's trace.
 *
 * This is the demo's stand-in for the thumbs-up or thumbs-down a real user clicks, except
 * that it reports the GRADE, not a mood. Tier C scenarios never call it: their failures exist
 * only in the conversation text, which is the whole point of that tier.
 */
export function scoreEpisode(input: {
  readonly traceId: string;
  readonly taskSuccess: boolean;
  readonly policyCompliant: boolean;
  readonly taskFailures: readonly string[];
  readonly policyFailures: readonly string[];
}): boolean {
  const db = supportLittleDb();
  if (db === undefined) return false;
  const comment = (failures: readonly string[]) => (failures.length === 0 ? {} : { comment: failures.join("; ").slice(0, 10_000) });
  db.db.score({ traceId: input.traceId, name: "task_success", value: input.taskSuccess ? 1 : 0, source: "code", ...comment(input.taskFailures) });
  db.db.score({ traceId: input.traceId, name: "policy_compliance", value: input.policyCompliant ? 1 : 0, source: "code", ...comment(input.policyFailures) });
  return true;
}
