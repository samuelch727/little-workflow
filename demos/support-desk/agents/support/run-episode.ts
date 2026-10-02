import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { UIMessage } from "ai";
import {
  generateHarness,
  loadHarness,
  reportHarnessOutcome,
  type Harness,
  type HarnessEvent,
  type HarnessOutcomeStatus,
  type HarnessSession,
} from "little-harness";
import { bindEpisode, createEpisode, readActions, unbindEpisode, type ActionEntry } from "./episode";
import { supportLittleDb } from "./littledb";

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
  readonly configVersionId: string | null;
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
   * Send trace events to littleDB. FALSE for gate runs: a gate episode must never become run
   * history the dream can read. See `littledb.ts`'s `reporterFor`.
   */
  readonly telemetry?: boolean;
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
  const config = db === undefined ? undefined : await db.prepareSession(sessionId);
  const overrides = db?.overridesFor(sessionId);
  const reporter = options.telemetry === false ? undefined : db?.reporterFor(sessionId);

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
          await reporter?.(event);
        },
      });

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
    configVersionId: config?.configVersionId ?? null,
    turnsWithheld: withheld,
  };
}

/**
 * Report an episode's verdict as a harness outcome, and onward to littleDB.
 *
 * This is the demo's stand-in for the 👍/👎 a real user clicks, and it takes the same path a
 * chat reaction would: `reportHarnessOutcome` writes `outcome.reported` into the session
 * trace and hands it to the littleDB sink. Tier C scenarios never call it — their failures
 * exist only in the conversation text, which is the whole point of that tier.
 */
export async function reportEpisodeOutcome(input: {
  readonly session: HarnessSession;
  readonly status: HarnessOutcomeStatus;
  readonly detail: string;
  readonly reporter: string;
}): Promise<{ recorded: boolean; delivered: number }> {
  const db = supportLittleDb();
  const result = await reportHarnessOutcome({
    session: input.session,
    status: input.status,
    detail: input.detail,
    source: "experiment",
    reporter: input.reporter,
    // One report per session: a re-report of the same episode replaces rather than
    // double-counts, which is what `reportKey` is for.
    reportKey: `${input.session.id}:verdict`,
    ...(db === undefined ? {} : { sinks: [db.outcomeSink] }),
  });
  return { recorded: result.recorded, delivered: result.delivered };
}
