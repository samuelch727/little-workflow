import { appendAction, episodeDirForSession, readDb, writeDb, type EpisodeDb } from "./episode";

/**
 * The one path every tool call takes.
 *
 * Three properties the grading depends on are established here, once, instead of in five
 * tool files that could each get one of them wrong:
 *
 *  - **Every call is logged**, including the ones that throw. A refund the tool rejected
 *    because the order id was a typo is still something the agent did, and a compliance
 *    score computed from a log that quietly omits failures would read an agent's mistakes
 *    as restraint.
 *  - **The log is written after the store**, so an action that appears in `actions.jsonl`
 *    always has its effect visible in `db.json`.
 *  - **The episode comes from the session**, never from a module-level variable, so two
 *    scenarios running through the same loaded agent cannot write into each other.
 *
 * What is deliberately NOT here: any policy check. The tools are the environment, and the
 * environment does not enforce the rulebook — see the header of `policy.mjs`.
 */

/** The harness merges its tool-execution context into the AI SDK's second `execute` argument. */
type HarnessToolOptions = { session?: { id?: string } };

export function sessionIdFrom(options: unknown): string | undefined {
  const session = (options as HarnessToolOptions | undefined)?.session;
  return typeof session?.id === "string" ? session.id : undefined;
}

export type ToolCallContext = {
  readonly db: EpisodeDb;
  readonly episodeDir: string;
  readonly sessionId: string | null;
  /** `db.asOf` — the demo's clock, so windows grade the same in a year as they do today. */
  readonly today: string;
};

export type ToolCallBody<TResult> = (context: ToolCallContext) => {
  /** What the model sees. */
  readonly result: TResult;
  /** The fields of that result a policy predicate keys on. Never the whole result. */
  readonly outcome: Record<string, unknown>;
  /** True when `context.db` was mutated in place and has to be written back. */
  readonly mutated?: boolean;
};

export function runToolCall<TResult>(
  toolName: string,
  input: Record<string, unknown>,
  options: unknown,
  body: ToolCallBody<TResult>,
): TResult {
  const sessionId = sessionIdFrom(options) ?? null;
  const episodeDir = episodeDirForSession(sessionId ?? undefined);

  try {
    const db = readDb(episodeDir);
    const { result, outcome, mutated } = body({ db, episodeDir, sessionId, today: db.asOf });
    if (mutated === true) writeDb(episodeDir, db);
    appendAction(episodeDir, { sessionId, tool: toolName, input, ok: true, outcome });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendAction(episodeDir, {
      sessionId,
      tool: toolName,
      input,
      ok: false,
      outcome: { error: message },
    });
    throw error;
  }
}

/**
 * Log a call that touches no state (`read_policy`).
 *
 * Whether the agent read the policy is worth having in the log — it is the diagnostic that
 * separates "followed the wrong summary" from "never looked" — but it must not be the reason
 * a hand-driven `little-harness test support` session fails. So a missing episode binding is
 * swallowed here, and only here.
 */
export function logToolCall(
  toolName: string,
  input: Record<string, unknown>,
  options: unknown,
  outcome: Record<string, unknown>,
): void {
  const sessionId = sessionIdFrom(options) ?? null;
  try {
    appendAction(episodeDirForSession(sessionId ?? undefined), {
      sessionId,
      tool: toolName,
      input,
      ok: true,
      outcome,
    });
  } catch {
    /* no episode bound — nothing to log against. */
  }
}

/** Next id in a ledger, zero-padded so a sorted listing reads in order. */
export function nextLedgerId(prefix: string, rows: ReadonlyArray<{ id: string }>): string {
  const highest = rows.reduce((best, row) => {
    const parsed = Number.parseInt(row.id.replace(/^[A-Za-z]+-/, ""), 10);
    return Number.isNaN(parsed) ? best : Math.max(best, parsed);
  }, 0);
  return `${prefix}-${String(highest + 1).padStart(4, "0")}`;
}
