import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createLittleDB,
  scoreId,
  turnTraceId,
  type HarnessTracer,
  type LittleDB,
  type Resolution,
} from "@little-stack/littledb";
import type { LanguageModel } from "ai";
import type { HarnessOutcomeEvent, HarnessOutcomeSink, HarnessTurnOptions } from "@little-stack/harness";
import { z } from "zod";
import { demoRoot, DEFAULT_MODEL_SLOT, modelForSlot } from "./env";

const agentDir = dirname(fileURLToPath(import.meta.url));

/**
 * What a LittleDB version of the Librarian holds: the system prompt and a model slot. A
 * proposal (from a person, LittleDB's reviewer or the dream loop) changes one or both.
 * LittleDB is told this shape, so it never proposes a version the Librarian cannot run.
 */
export const LibrarianVersion = z.object({
  system: z.string().trim().min(1),
  model: z.enum([DEFAULT_MODEL_SLOT, "deepseek-v4-pro"]),
});
export type LibrarianVersionContent = z.infer<typeof LibrarianVersion>;

/** What a turn runs with: the version's prompt and the model its slot names. */
export type ManagedTurnOverrides = {
  readonly system?: string;
  readonly model?: LanguageModel;
};

export type LibrarianSession = {
  readonly resolution: Resolution<LibrarianVersionContent>;
  readonly content: LibrarianVersionContent;
  readonly tracer: HarnessTracer;
  readonly overrides: ManagedTurnOverrides;
};

export type LibrarianLittleDb = {
  readonly db: LittleDB;
  readonly url: string;
  /** The harness slug in LittleDB. */
  readonly harness: string;
  readonly channel: string;
  /** Chat reactions as `user_feedback` scores on the turn they grade. */
  readonly outcomeSink: HarnessOutcomeSink;
  /**
   * The Harness `turnOptions` hook (`agent.ts` passes it to `createHarness`): every turn, on
   * every path (the Slack connector, `little-harness test`, the driver), runs the version its
   * session runs on and is traced with it.
   */
  readonly turnOptions: HarnessTurnOptions;
  /** What `sessionId` ran on in its latest turn, for reporting. */
  sessionFor(sessionId: string): LibrarianSession | undefined;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
};

/**
 * Read the bootstrap prompt from the SAME file `loadHarness` uses as the system prompt.
 *
 * `LIBRARIAN_PROMPT_FILE` (a path, absolute or relative to the demo root) seeds LittleDB
 * with a DIFFERENT prompt without touching `instructions.md`: that is how
 * `experiment/run.mjs` bootstraps the deliberately-flawed v1. It affects the LittleDB
 * bootstrap ONLY: a run with `LITTLEDB_URL` unset still uses `instructions.md`. Once the
 * harness has versions, a changed bootstrap does not run straight away: LittleDB opens a
 * "Changed in code" proposal for it, which ships like any other proposal.
 */
export function bootstrapPrompt(): string {
  const override = process.env.LIBRARIAN_PROMPT_FILE;
  const file =
    override === undefined || override.length === 0
      ? join(agentDir, "instructions.md")
      : resolve(demoRoot, override);
  return readFileSync(file, "utf8").trim();
}

/**
 * The Librarian as the code defines it, sent with every resolve. LittleDB stores the first one
 * as version 1, and turns a later edit into a "Changed in code" proposal.
 */
export function bootstrapContent(): LibrarianVersionContent {
  return LibrarianVersion.parse({ system: bootstrapPrompt(), model: process.env.KB_CHATBOT_MODEL_SLOT ?? DEFAULT_MODEL_SLOT });
}

/** The score a chat reaction becomes. */
export const FEEDBACK_SCORE = "user_feedback";

const FEEDBACK_VALUE = { success: 1, partial: 0.5, failure: 0 } as const;

/**
 * Held on `globalThis` because `little-harness`'s `importDefault` constructs a NEW jiti
 * instance per module: `agent.ts` (loaded by `loadHarness`) and the driver do not share a
 * module registry, so a plain module-level singleton would give each of them its own client
 * and its own cache.
 */
const SINGLETON = Symbol.for("kb-chatbot.librarian.littledb");

type Holder = { [SINGLETON]?: LibrarianLittleDb | null };

/**
 * The LittleDB handle, or `undefined` when `LITTLEDB_URL` is unset: the demo runs fully
 * without LittleDB (plain `createHarness` + `instructions.md`, no traces, no scores).
 */
export function librarianLittleDb(): LibrarianLittleDb | undefined {
  const holder = globalThis as unknown as Holder;
  const existing = holder[SINGLETON];
  if (existing !== undefined) return existing ?? undefined;

  const url = process.env.LITTLEDB_URL;
  if (url === undefined || url.length === 0) {
    holder[SINGLETON] = null;
    return undefined;
  }

  const created = create(url);
  holder[SINGLETON] = created;
  return created;
}

function create(url: string): LibrarianLittleDb {
  const apiKey = process.env.LITTLEDB_API_KEY;
  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error("LITTLEDB_URL is set but LITTLEDB_API_KEY is not. `littledb dev` prints a local key.");
  }
  const harness = process.env.LITTLEDB_HARNESS ?? "kb-librarian";
  const channel = process.env.LITTLEDB_CHANNEL ?? "production";
  const db = createLittleDB({ url, apiKey });
  const managed = db.managedHarness({
    slug: harness,
    channel,
    bootstrap: bootstrapContent(),
    schema: LibrarianVersion,
    models: (slot) => modelForSlot(slot),
  });
  const tracer = managed.tracer!;
  const sessions = new Map<string, LibrarianSession>();

  const remember = async (sessionId: string): Promise<LibrarianSession> => {
    const { resolution, content, overrides } = await managed.session(sessionId);
    if (resolution.fallback !== undefined) {
      console.warn(
        `littledb: session ${sessionId} runs on the ${resolution.fallback === "last_known" ? "last known version" : "bootstrap"} (${resolution.error ?? "LittleDB unreachable"}).`,
      );
    }
    const session: LibrarianSession = { resolution, content, tracer, overrides };
    sessions.set(sessionId, session);
    return session;
  };

  const outcomeSink: HarnessOutcomeSink = {
    name: "littledb",
    async deliver(event: HarnessOutcomeEvent) {
      // The turn the reaction grades, or the session's latest one.
      const traceId =
        event.turnId !== undefined ? turnTraceId(event.sessionId, event.turnId) : tracer.traceIdFor(event.sessionId);
      if (traceId === undefined) return { ok: false };
      // One score per rater per message: a changed mind replaces it, an un-reaction removes it.
      const id = scoreId(traceId, undefined, `${FEEDBACK_SCORE}\n${event.reportKey ?? event.eventId}`, "human");
      if (event.retracted === true) {
        await db.flush();
        try {
          await db.request("DELETE", `/scores/${encodeURIComponent(id)}`);
        } catch {
          // Already gone, or never sent: either way there is nothing left to retract.
        }
        return { ok: true };
      }
      db.score({
        id,
        traceId,
        name: FEEDBACK_SCORE,
        value: event.score ?? FEEDBACK_VALUE[event.status],
        label: event.status,
        source: "human",
        ...(event.detail === undefined ? {} : { comment: event.detail }),
        metadata: {
          outcomeSource: event.source,
          ...(event.reporter === undefined ? {} : { reporter: event.reporter }),
          ...event.metadata,
        },
      });
      return { ok: true };
    },
  };

  return {
    db,
    url,
    harness,
    channel,
    outcomeSink,
    turnOptions: async (turn) => {
      const options = await managed.turnOptions(turn);
      await remember(turn.sessionId);
      return options;
    },
    sessionFor: (sessionId) => sessions.get(sessionId),
    flush: () => db.flush(),
    shutdown: () => db.shutdown(),
  };
}
