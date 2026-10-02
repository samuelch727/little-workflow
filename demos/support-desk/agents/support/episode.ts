import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The episode environment: one JSON database and one append-only action log per scenario.
 *
 * Two things live here and nothing else does.
 *
 * 1. **The store.** `db.json` is the world the tools mutate — orders, the refunds ledger,
 *    exchanges, escalations, declinations. `actions.jsonl` is every tool call in order.
 *    The split is the grading design made physical: task success is read from `db.json`
 *    (what exists in the world afterwards) and policy compliance from `actions.jsonl`
 *    (what the agent did to get there). Neither file can answer the other's question,
 *    which is what keeps the two scores independent.
 *
 * 2. **The binding.** A tool has no idea which scenario it is serving — agent-folder
 *    discovery constructs it with no arguments — so the driver registers
 *    `sessionId -> episode dir` before the run and the tools look themselves up at
 *    execute time. That is what makes episodes isolated by construction rather than by
 *    the driver remembering to clean up.
 */

const here = dirname(fileURLToPath(import.meta.url));

/** `demos/support-desk` — the demo root. */
export const demoRoot = resolve(here, "..", "..");

/** The tracked seed. Copied, never opened for writing. */
export const seedDbFile = join(demoRoot, "seed-data", "db.json");

export const DB_FILE = "db.json";
export const ACTIONS_FILE = "actions.jsonl";

export type Customer = {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  address: string;
};

export type Order = {
  readonly id: string;
  readonly customerId: string;
  readonly item: string;
  readonly amount: number;
  status: string;
  readonly purchasedAt: string;
  readonly deliveredAt: string | null;
  readonly opened: boolean;
  readonly finalSale: boolean;
  refunded: boolean;
  shippingAddress: string;
};

export type RefundRow = {
  readonly id: string;
  readonly orderId: string;
  readonly amount: number;
  readonly reason: string;
  readonly at: string;
};

export type ExchangeRow = {
  readonly id: string;
  readonly orderId: string;
  readonly replacementItem: string;
  readonly reason: string;
  readonly at: string;
};

export type EscalationRow = {
  readonly id: string;
  readonly orderId: string | null;
  readonly category: string;
  readonly reason: string;
  readonly at: string;
};

export type DeclineRow = {
  readonly id: string;
  readonly orderId: string | null;
  readonly reason: string;
  readonly explanation: string;
  readonly at: string;
};

export type EpisodeDb = {
  readonly asOf: string;
  readonly customers: Customer[];
  readonly orders: Order[];
  refunds: RefundRow[];
  exchanges: ExchangeRow[];
  escalations: EscalationRow[];
  declines: DeclineRow[];
};

/** One tool call, exactly as it happened. The compliance grader reads nothing else. */
export type ActionEntry = {
  readonly seq: number;
  readonly at: string;
  readonly sessionId: string | null;
  readonly tool: string;
  readonly input: Record<string, unknown>;
  readonly ok: boolean;
  /** The fields of the result a policy predicate can key on. Never the whole result. */
  readonly outcome: Record<string, unknown>;
};

export function readDb(episodeDir: string): EpisodeDb {
  return JSON.parse(readFileSync(join(episodeDir, DB_FILE), "utf8")) as EpisodeDb;
}

export function writeDb(episodeDir: string, db: EpisodeDb): void {
  writeFileSync(join(episodeDir, DB_FILE), `${JSON.stringify(db, null, 2)}\n`);
}

export function readActions(episodeDir: string): ActionEntry[] {
  const file = join(episodeDir, ACTIONS_FILE);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as ActionEntry);
}

/**
 * Append one call to the log.
 *
 * The sequence number comes from the file's current length rather than a counter in memory:
 * the driver, the tests and the `little-harness test` REPL all reach the same episode
 * through different module instances (jiti builds one per importer), and a module-level
 * counter would restart in each of them.
 */
export function appendAction(
  episodeDir: string,
  entry: Omit<ActionEntry, "seq" | "at"> & { at?: string },
): ActionEntry {
  const seq = readActions(episodeDir).length + 1;
  const full: ActionEntry = { ...entry, seq, at: entry.at ?? new Date().toISOString() };
  appendFileSync(join(episodeDir, ACTIONS_FILE), `${JSON.stringify(full)}\n`);
  return full;
}

/** Copy the tracked seed into a fresh episode dir and start an empty action log. */
export function createEpisode(episodeDir: string): string {
  mkdirSync(episodeDir, { recursive: true });
  writeFileSync(join(episodeDir, DB_FILE), readFileSync(seedDbFile, "utf8"));
  writeFileSync(join(episodeDir, ACTIONS_FILE), "");
  return episodeDir;
}

/**
 * `sessionId -> episode dir`, on `globalThis`.
 *
 * It has to be here rather than in a module-level `Map`: `little-harness`'s `importDefault`
 * builds a NEW jiti instance per module, so `tools/refund_order.ts` and the driver each get
 * their own copy of this file. `Symbol.for` is the one registry every copy shares — the same
 * reason `env.ts` holds the model seam this way.
 */
const REGISTRY = Symbol.for("support-desk.episodes");

type Registry = { [REGISTRY]?: Map<string, string> };

function registry(): Map<string, string> {
  const holder = globalThis as unknown as Registry;
  const existing = holder[REGISTRY];
  if (existing !== undefined) return existing;
  const created = new Map<string, string>();
  holder[REGISTRY] = created;
  return created;
}

export function bindEpisode(sessionId: string, episodeDir: string): void {
  registry().set(sessionId, episodeDir);
}

export function unbindEpisode(sessionId: string): void {
  registry().delete(sessionId);
}

export function clearEpisodeBindings(): void {
  registry().clear();
}

/**
 * The episode a tool call belongs to.
 *
 * `SUPPORT_EPISODE_DIR` is the fallback, and it is what makes `little-harness test support`
 * usable: a human poking at the agent by hand has no driver to register a binding, so they
 * point the variable at a scratch episode instead. It is deliberately the LAST resort —
 * inside a scenario run the binding always wins, so one stray environment variable cannot
 * silently merge every scenario into one database.
 */
export function episodeDirForSession(sessionId: string | undefined): string {
  const bound = sessionId === undefined ? undefined : registry().get(sessionId);
  if (bound !== undefined) return bound;
  const fromEnv = process.env.SUPPORT_EPISODE_DIR;
  if (fromEnv !== undefined && fromEnv.length > 0) return resolve(fromEnv);
  throw new Error(
    `No episode is bound to session ${sessionId ?? "(unknown)"} and SUPPORT_EPISODE_DIR is unset. ` +
      "The driver binds one per scenario; set SUPPORT_EPISODE_DIR to a scratch episode dir to " +
      "run the agent by hand.",
  );
}

/** Whole days from one `YYYY-MM-DD` to another. Negative when `to` precedes `from`. */
export function daysBetween(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00.000Z`);
  const end = Date.parse(`${to}T00:00:00.000Z`);
  if (Number.isNaN(start) || Number.isNaN(end)) {
    throw new Error(`Not a YYYY-MM-DD date: ${Number.isNaN(start) ? from : to}`);
  }
  return Math.round((end - start) / 86_400_000);
}
