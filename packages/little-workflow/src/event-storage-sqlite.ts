import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import type { EventEnvelope, EventType, RunId } from "./world.js";
import type { EventStorage } from "./event-storage.js";

type JsonRecord = Record<string, unknown>;

type EventRow = {
  readonly event_id: string;
  readonly type: string;
  readonly occurrence_id: string | null;
  readonly append_idempotency_key: string | null;
  readonly canonical_request_digest: string | null;
  readonly recorded_at: string;
  readonly payload: string;
  readonly sequence: number;
};

type EventStore = {
  readonly db: Database.Database;
  readonly insert: Database.Statement<[
    string,
    number,
    string,
    string,
    string | null,
    string | null,
    string | null,
    string,
    string,
  ]>;
  readonly maxSequence: Database.Statement<[string]>;
  readonly selectByIdempotency: Database.Statement<[string, string]>;
  readonly selectAll: Database.Statement<[string]>;
  readonly selectRunIds: Database.Statement<[]>;
  readonly deleteAfter: Database.Statement<[string, number]>;
};

const eventStores = new Map<string, EventStore>();

function eventStoreFor(dataDir: string): EventStore {
  const eventsDir = join(dataDir, "events");
  const key = resolve(eventsDir);
  const existing = eventStores.get(key);
  if (existing !== undefined) {
    return existing;
  }
  // The DB file lives in the same `events/` directory the JSONL logs used, so a
  // single dataDir remains self-contained. Synchronous mkdir keeps connection
  // setup atomic with respect to the per-run write chain.
  mkdirSync(eventsDir, { recursive: true });
  const db = new Database(join(key, "events.db"));
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.exec(
    `CREATE TABLE IF NOT EXISTS events (
       run_id TEXT NOT NULL,
       sequence INTEGER NOT NULL,
	       event_id TEXT NOT NULL,
	       type TEXT NOT NULL,
	       occurrence_id TEXT,
	       append_idempotency_key TEXT,
	       canonical_request_digest TEXT,
	       recorded_at TEXT NOT NULL,
	       payload TEXT NOT NULL,
	       PRIMARY KEY (run_id, sequence)
	     );`,
  );
  ensureOptionalColumn(db, "events", "occurrence_id", "TEXT");
  ensureOptionalColumn(db, "events", "append_idempotency_key", "TEXT");
  ensureOptionalColumn(db, "events", "canonical_request_digest", "TEXT");
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS events_run_append_idempotency_idx
     ON events (run_id, append_idempotency_key)
     WHERE append_idempotency_key IS NOT NULL;`,
  );
  const store: EventStore = {
    db,
    insert: db.prepare(
      `INSERT INTO events (
         run_id, sequence, event_id, type, occurrence_id, append_idempotency_key,
         canonical_request_digest, recorded_at, payload
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    maxSequence: db.prepare(
      `SELECT MAX(sequence) AS maxSequence FROM events WHERE run_id = ?`,
    ),
    selectByIdempotency: db.prepare(
      `SELECT event_id, type, occurrence_id, append_idempotency_key,
              canonical_request_digest, recorded_at, payload, sequence
       FROM events WHERE run_id = ? AND append_idempotency_key = ?`,
    ),
    selectAll: db.prepare(
      `SELECT event_id, type, occurrence_id, append_idempotency_key,
              canonical_request_digest, recorded_at, payload, sequence
       FROM events WHERE run_id = ? ORDER BY sequence ASC`,
    ),
    selectRunIds: db.prepare(
      `SELECT DISTINCT run_id FROM events ORDER BY run_id ASC`,
    ),
    deleteAfter: db.prepare(`DELETE FROM events WHERE run_id = ? AND sequence > ?`),
  };
  eventStores.set(key, store);
  return store;
}

function ensureOptionalColumn(
  db: Database.Database,
  table: string,
  column: string,
  definition: string,
): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ readonly name?: unknown }>;
  if (columns.some((entry) => entry.name === column)) {
    return;
  }
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export function closeSQLiteEventStoresForTest(): void {
  for (const store of eventStores.values()) {
    store.db.close();
  }
  eventStores.clear();
}
function rowToEnvelope(runId: RunId, row: EventRow): EventEnvelope {
  return {
    eventId: row.event_id,
    runId,
	    sequence: row.sequence,
	    type: row.type as EventType,
	    ...(row.occurrence_id === null ? {} : { occurrenceId: row.occurrence_id }),
	    ...(row.append_idempotency_key === null
        ? {}
        : { appendIdempotencyKey: row.append_idempotency_key }),
	    ...(row.canonical_request_digest === null
        ? {}
        : { canonicalRequestDigest: row.canonical_request_digest }),
	    recordedAt: row.recorded_at,
	    payload: JSON.parse(row.payload) as JsonRecord,
	  };
}


/** The disk adapter keeps the existing SQLite schema, statements and commit behavior. */
export function sqliteEventStorage(dataDir: string): EventStorage {
  const store = eventStoreFor(dataDir);
  return {
    async findByIdempotency(runId, key) {
      const row = store.selectByIdempotency.get(runId, key) as EventRow | undefined;
      return row === undefined ? undefined : rowToEnvelope(runId, row);
    },
    async maxSequence(runId) {
      return (store.maxSequence.get(runId) as { maxSequence: number | null }).maxSequence ?? 0;
    },
    async insert(envelope) {
      store.insert.run(
        envelope.runId, envelope.sequence, envelope.eventId, envelope.type,
        envelope.occurrenceId ?? null, envelope.appendIdempotencyKey ?? null,
        envelope.canonicalRequestDigest ?? null, envelope.recordedAt,
        JSON.stringify(envelope.payload),
      );
    },
    async list(runId) {
      return (store.selectAll.all(runId) as EventRow[]).map(row => rowToEnvelope(runId, row));
    },
    async listRunIds() {
      return (store.selectRunIds.all() as Array<{ run_id: string }>).map(row => row.run_id);
    },
    async deleteAfter(runId, sequence) {
      store.deleteAfter.run(runId, sequence);
    },
  };
}
