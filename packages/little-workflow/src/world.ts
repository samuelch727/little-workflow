import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import {
  mkdir,
  open,
  readFile,
  rename,
  stat,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import Database from "better-sqlite3";
import type { LocalWorld } from "./authoring.js";
import { canonicalJson, sha256Digest } from "./canonical.js";
import type { UsageTotals } from "./pricing.js";
import { materializeRunStateFromEvents } from "./run-state.js";
import { stripUndefined } from "./strip-undefined.js";
import type { World } from "./world-port.js";

type JsonRecord = Record<string, unknown>;

export type RunId = string;
export type ArtifactId = string;
export type ArtifactRef = `artifact://${ArtifactId}`;

export type EventType =
  | "OrchestrationRequested"
  | "PlannerStarted"
  | "PlannerDraftedWorkflow"
  | "WorkflowValidationFailed"
  | "WorkflowValidationSucceeded"
  | "PlannerReuseDecisionRecorded"
  | "WorkflowVersionRegistered"
  | "RunStarted"
  | "StepScheduled"
  | "StepAttemptStarted"
  | "ModelCallStarted"
  | "ModelCallCompleted"
  | "ToolCallStarted"
  | "ToolCallCompleted"
  | "ArtifactCreated"
  | "StepOutputValidated"
  | "StepCompleted"
  | "StepFailed"
  | "StepRepairAttempted"
  | "ParallelGroupStarted"
  | "ParallelBranchScheduled"
  | "ParallelBranchCompleted"
  | "ParallelBranchFailed"
  | "ParallelGroupCompleted"
  | "ParallelGroupFailed"
  | "RunCompleted"
  | "RunFailed"
  | "OuterLoopCycleCompleted"
  | "harness.session.started"
  | "harness.session.completed"
  | "harness.session.failed"
  | "harness.model.called"
  | "harness.model.responded"
  | "harness.model.failed"
  | "harness.tool_call.started"
  | "harness.tool_call.succeeded"
  | "harness.tool_call.failed"
  | "harness.execute_step.started"
  | "harness.execute_step.succeeded";

export type EventInput = {
  readonly type: EventType;
  readonly occurrenceId?: string;
  readonly payload: JsonRecord;
};

export type EventRef = {
  readonly eventId: string;
  readonly runId: RunId;
  readonly sequence: number;
  readonly type: EventType;
  readonly occurrenceId?: string;
};

export type EventEnvelope = EventRef & {
  readonly recordedAt: string;
  readonly payload: JsonRecord;
};

export type ArtifactInput = {
  readonly runId: RunId;
  readonly stepPath?: string;
  readonly name: string;
  readonly payload: unknown;
  readonly contentType: string;
};

export type ArtifactEncoding = "json" | "utf-8" | "binary";

export type ArtifactManifest = {
  readonly artifactId: ArtifactId;
  readonly artifactRef: ArtifactRef;
  readonly runId: RunId;
  readonly stepPath?: string;
  readonly name: string;
  readonly contentType: string;
  readonly encoding: ArtifactEncoding;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly createdAt: string;
};

export type ArtifactReadResult = {
  readonly manifest: ArtifactManifest;
  readonly payload: unknown;
};

export type MaterializedStepAttempt = {
  readonly attemptId: string;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly status: "running" | "completed" | "failed";
  readonly error?: unknown;
};

export type MaterializedStepState = {
  readonly stepPath: string;
  readonly status: "pending" | "running" | "completed" | "failed";
  /** Tokens and priced dollars for the model calls attributed to this step. */
  readonly usage: UsageTotals;
  readonly attempts: readonly MaterializedStepAttempt[];
  readonly output?: unknown;
  readonly outputRef?: ArtifactRef;
  readonly artifactRefs: readonly ArtifactRef[];
  readonly metadata?: JsonRecord;
  readonly error?: unknown;
};

export type MaterializedRunState = {
  readonly runId: RunId;
  readonly workflowVersionId?: string;
  readonly status: "pending" | "running" | "completed" | "failed";
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly output?: unknown;
  readonly outputRef?: ArtifactRef;
  /** Run-wide totals: the sum of every step's usage plus any unattributed model calls. */
  readonly usage: UsageTotals;
  readonly steps: Record<string, MaterializedStepState>;
  readonly artifacts: readonly ArtifactRef[];
  readonly error?: unknown;
  readonly eventCount: number;
};

export class WorldPathError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = "WorldPathError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class ArtifactNotFoundError extends Error {
  constructor(ref: string) {
    super(`Artifact not found: ${ref}`);
    this.name = "ArtifactNotFoundError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class ArtifactHashMismatchError extends Error {
  constructor(ref: string) {
    super(`Artifact hash mismatch: ${ref}`);
    this.name = "ArtifactHashMismatchError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class ArtifactManifestCorruptError extends Error {
  constructor(ref: string, detail: string) {
    super(`Artifact manifest is malformed for ${ref}: ${detail}`);
    this.name = "ArtifactManifestCorruptError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class RunNotFoundError extends Error {
  constructor(runId: string) {
    super(`Run not found: ${runId}`);
    this.name = "RunNotFoundError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class EventStoreCorruptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EventStoreCorruptError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

const RUN_ID_PATTERN = /^run_[A-Za-z0-9_-]{1,80}$/u;
const ARTIFACT_ID_PATTERN = /^art_[A-Za-z0-9_-]{1,80}$/u;
const writeChains = new Map<string, Promise<unknown>>();

// ── Embedded WAL event store ────────────────────────────────────────
//
// The event log moved from per-run append-only JSONL (with a per-event fsync) to
// an embedded better-sqlite3 database in WAL mode with `synchronous=NORMAL`.
// Durability: in WAL + NORMAL, every committed transaction is fsynced to the
// write-ahead log, so a committed append survives an application crash. (An OS
// kernel crash / power loss may lose the very last commits not yet checkpointed —
// the documented WAL+NORMAL tradeoff, the same envelope JSONL+fsync gave once the
// OS write cache is in play.) `appendEvent`'s promise resolves only AFTER the
// synchronous transaction commits, so a resolved append is durable.
//
// One cached connection per resolved `dataDir`; schema init is idempotent.

type EventRow = {
  readonly event_id: string;
  readonly type: string;
  readonly occurrence_id: string | null;
  readonly recorded_at: string;
  readonly payload: string;
  readonly sequence: number;
};

type EventStore = {
  readonly db: Database.Database;
  readonly insert: Database.Statement<[string, number, string, string, string | null, string, string]>;
  readonly maxSequence: Database.Statement<[string]>;
  readonly selectAll: Database.Statement<[string]>;
  readonly selectRunIds: Database.Statement<[]>;
  readonly deleteAfter: Database.Statement<[string, number]>;
};

const eventStores = new Map<string, EventStore>();

function eventStoreFor(world: LocalWorld): EventStore {
  const eventsDir = join(world.dataDir, "events");
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
	       recorded_at TEXT NOT NULL,
	       payload TEXT NOT NULL,
	       PRIMARY KEY (run_id, sequence)
	     );`,
  );
  ensureOptionalColumn(db, "events", "occurrence_id", "TEXT");
  const store: EventStore = {
    db,
    insert: db.prepare(
      `INSERT INTO events (run_id, sequence, event_id, type, occurrence_id, recorded_at, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ),
    maxSequence: db.prepare(
      `SELECT MAX(sequence) AS maxSequence FROM events WHERE run_id = ?`,
    ),
    selectAll: db.prepare(
      `SELECT event_id, type, occurrence_id, recorded_at, payload, sequence
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

function eventChainKey(world: LocalWorld, runId: string): string {
  return `events:${resolve(world.dataDir)}:${runId}`;
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

/**
 * TEST-ONLY. Closes and forgets all cached event-store connections so the next
 * access reopens the DB from disk. Lets durability tests prove that committed
 * events survive a fresh process-equivalent reopen (a closed+reopened
 * connection reads the WAL-checkpointed state from disk, not in-memory cache).
 */
export function closeEventStoresForTest(): void {
  for (const store of eventStores.values()) {
    store.db.close();
  }
  eventStores.clear();
}

function rowToEnvelope(runId: RunId, row: EventRow): EventEnvelope {
  return deepFreeze({
    eventId: row.event_id,
    runId,
	    sequence: row.sequence,
	    type: row.type as EventType,
	    ...(row.occurrence_id === null ? {} : { occurrenceId: row.occurrence_id }),
	    recordedAt: row.recorded_at,
	    payload: JSON.parse(row.payload) as JsonRecord,
	  });
}

export async function appendEvent(
  world: LocalWorld,
  runId: RunId,
  event: EventInput,
): Promise<EventEnvelope> {
  validateRunId(runId);
  return withWriteChain(eventChainKey(world, runId), async () => {
    const store = eventStoreFor(world);
    // Artifact-reference invariant is checked BEFORE persistence so a rejected
    // append never consumes a sequence number (see "rejected append" guarantee).
    await assertReferencedArtifactsExist(world, runId, event);
    const maxRow = store.maxSequence.get(runId) as { maxSequence: number | null };
    const sequence = (maxRow.maxSequence ?? 0) + 1;
    const envelope: EventEnvelope = {
      eventId: eventIdFor(runId, sequence, event),
      runId,
	      sequence,
	      type: event.type,
	      ...(event.occurrenceId === undefined ? {} : { occurrenceId: event.occurrenceId }),
	      recordedAt: new Date().toISOString(),
	      payload: canonicalClone(event.payload),
    };
    // Synchronous commit: better-sqlite3 runs the INSERT inside an implicit
    // transaction that fsyncs the WAL (synchronous=NORMAL) before `run()`
    // returns. The per-run write chain serializes reads+writes, so the
    // MAX(sequence) read above and this INSERT cannot interleave.
    store.insert.run(
      runId,
	      sequence,
	      envelope.eventId,
	      envelope.type,
	      envelope.occurrenceId ?? null,
	      envelope.recordedAt,
	      JSON.stringify(envelope.payload),
	    );
    return deepFreeze(envelope);
  });
}

async function assertReferencedArtifactsExist(
  world: LocalWorld,
  runId: RunId,
  event: EventInput,
): Promise<void> {
  if (event.type !== "StepCompleted") {
    return;
  }
  const refs = new Set<ArtifactRef>();
  const outputRef = artifactRefValue(event.payload.outputRef);
  if (outputRef !== undefined) {
    refs.add(outputRef);
  }
  for (const ref of artifactRefsValue(event.payload.artifactRefs)) {
    refs.add(ref);
  }
  const artifacts = await Promise.all([...refs].map((ref) => readArtifact(world, ref)));
  for (const artifact of artifacts) {
    if (artifact.manifest.runId !== runId) {
      throw new ArtifactNotFoundError(artifact.manifest.artifactRef);
    }
  }
}

export async function listEvents(
  world: LocalWorld,
  runId: RunId,
): Promise<readonly EventEnvelope[]> {
  validateRunId(runId);
  const store = eventStoreFor(world);
  const rows = store.selectAll.all(runId) as EventRow[];
  return rows.map((row) => rowToEnvelope(runId, row));
}

/**
 * TEST-ONLY crash-simulation seam. Drops every event for `runId` whose
 * `sequence` is greater than `keepThroughSequence`, representing "the crash
 * left only events 1..keepThroughSequence durably committed." Medium-agnostic:
 * the only guarantee it relies on is that committed events have monotonic
 * 1-indexed sequences. Routed through the same per-run write chain as
 * `appendEvent` so it cannot race a concurrent append.
 *
 * NOT part of the public World contract; exported solely so durability/recovery
 * tests can simulate a crash without coupling to the storage byte format.
 */
export async function truncateEventLogForTest(
  world: LocalWorld,
  runId: RunId,
  keepThroughSequence: number,
): Promise<void> {
  validateRunId(runId);
  await withWriteChain(eventChainKey(world, runId), async () => {
    const store = eventStoreFor(world);
    store.deleteAfter.run(runId, keepThroughSequence);
  });
}

export async function listRunIds(world: LocalWorld): Promise<readonly RunId[]> {
  const store = eventStoreFor(world);
  const rows = store.selectRunIds.all() as Array<{ readonly run_id: string }>;
  return rows
    .map((row) => row.run_id)
    .filter((runId): runId is RunId => RUN_ID_PATTERN.test(runId));
}

export async function writeArtifact(
  world: LocalWorld,
  input: ArtifactInput,
): Promise<ArtifactManifest> {
  validateRunId(input.runId);
  const encoded = encodeArtifactPayload(input.payload);
  const payloadHash = sha256Bytes(encoded.bytes);
  const artifactId = artifactIdFor(input, encoded.encoding, payloadHash);
  return withWriteChain(`artifact:${resolve(world.dataDir)}:${artifactId}`, () =>
    writeArtifactLocked(world, input, encoded, payloadHash, artifactId)
  );
}

async function writeArtifactLocked(
  world: LocalWorld,
  input: ArtifactInput,
  encoded: { readonly bytes: Buffer; readonly encoding: ArtifactEncoding },
  payloadHash: string,
  artifactId: ArtifactId,
): Promise<ArtifactManifest> {
  const artifactRef = `artifact://${artifactId}` as ArtifactRef;
  const manifestPath = join(world.dataDir, "artifacts", `${artifactId}.json`);
  const existingManifest = await readArtifactManifestIfPresent(manifestPath);
  if (existingManifest !== undefined) {
    if (
      existingManifest.artifactId === artifactId &&
      existingManifest.artifactRef === artifactRef &&
      existingManifest.runId === input.runId &&
      existingManifest.stepPath === input.stepPath &&
      existingManifest.name === input.name &&
      existingManifest.contentType === input.contentType &&
      existingManifest.encoding === encoded.encoding &&
      existingManifest.sha256 === payloadHash
    ) {
      await readArtifact(world, artifactRef);
      return existingManifest;
    }
    throw new ArtifactHashMismatchError(artifactRef);
  }
  const manifest: ArtifactManifest = deepFreeze(stripUndefined({
    artifactId,
    artifactRef,
    runId: input.runId,
    stepPath: input.stepPath,
    name: input.name,
    contentType: input.contentType,
    encoding: encoded.encoding,
    sha256: payloadHash,
    sizeBytes: encoded.bytes.byteLength,
    createdAt: new Date().toISOString(),
  }) as ArtifactManifest);
  const artifactsDir = join(world.dataDir, "artifacts");
  const blobsDir = join(artifactsDir, "blobs");
  await ensureDirectory(artifactsDir);
  await ensureDirectory(blobsDir);

  const blobPath = join(blobsDir, `${artifactId}.bin`);
  const blobTempPath = `${blobPath}.tmp`;
  await writeFileDurably(blobTempPath, encoded.bytes);
  await rename(blobTempPath, blobPath);
  await syncDirectory(blobsDir);

  const manifestTempPath = `${manifestPath}.tmp`;
  await writeFileDurably(manifestTempPath, `${canonicalJson(manifest)}\n`);
  await rename(manifestTempPath, manifestPath);
  await syncDirectory(artifactsDir);
  return manifest;
}

export async function readArtifact(
  world: LocalWorld,
  ref: string,
): Promise<ArtifactReadResult> {
  const artifactId = artifactIdFromRef(ref);
  const manifest = await readArtifactManifest(world, ref);

  const blobPath = join(world.dataDir, "artifacts", "blobs", `${artifactId}.bin`);
  let bytes: Buffer;
  try {
    bytes = await readFile(blobPath);
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      throw new ArtifactNotFoundError(ref);
    }
    throw error;
  }
  if (sha256Bytes(bytes) !== manifest.sha256) {
    throw new ArtifactHashMismatchError(ref);
  }
  if (bytes.byteLength !== manifest.sizeBytes) {
    throw new ArtifactManifestCorruptError(ref, "sizeBytes does not match blob size.");
  }

  return deepFreeze({
    manifest,
    payload: decodeArtifactPayload(bytes, manifest.encoding),
  });
}

export async function readArtifactManifest(
  world: LocalWorld,
  ref: string,
): Promise<ArtifactManifest> {
  const artifactId = artifactIdFromRef(ref);
  const manifestPath = join(world.dataDir, "artifacts", `${artifactId}.json`);
  try {
    const manifest = parseArtifactManifest(await readFile(manifestPath, "utf8"), ref);
    assertArtifactManifestShape(manifest, ref, artifactId);
    return deepFreeze(manifest);
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      throw new ArtifactNotFoundError(ref);
    }
    throw error;
  }
}

async function readArtifactManifestIfPresent(
  manifestPath: string,
): Promise<ArtifactManifest | undefined> {
  try {
    return deepFreeze(parseArtifactManifest(await readFile(manifestPath, "utf8"), manifestPath));
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

export async function materializeRunState(
  world: LocalWorld,
  runId: RunId,
): Promise<MaterializedRunState> {
  const events = await listEvents(world, runId);
  if (events.length === 0) {
    throw new RunNotFoundError(runId);
  }
  return materializeRunStateFromEvents(runId, events);
}

function eventIdFor(runId: string, sequence: number, event: EventInput): string {
  const hash = sha256Digest({
    runId,
    sequence,
    type: event.type,
    ...(event.occurrenceId === undefined ? {} : { occurrenceId: event.occurrenceId }),
    payload: event.payload,
  });
  return `evt_${hash.slice("sha256:".length, "sha256:".length + 16)}`;
}

function artifactIdFor(
  input: ArtifactInput,
  encoding: ArtifactEncoding,
  payloadHash: string,
): ArtifactId {
  const hash = sha256Digest(stripUndefined({
    runId: input.runId,
    stepPath: input.stepPath,
    name: input.name,
    contentType: input.contentType,
    encoding,
    payloadHash,
  }));
  return `art_${hash.slice("sha256:".length, "sha256:".length + 16)}`;
}

function artifactIdFromRef(ref: string): ArtifactId {
  if (!ref.startsWith("artifact://")) {
    throw new WorldPathError(`Invalid artifact ref: ${ref}`);
  }
  const artifactId = ref.slice("artifact://".length);
  validateArtifactId(artifactId);
  return artifactId;
}

function validateRunId(runId: string): void {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new WorldPathError(`Invalid run id: ${runId}`);
  }
}

function validateArtifactId(artifactId: string): void {
  if (!ARTIFACT_ID_PATTERN.test(artifactId)) {
    throw new WorldPathError(`Invalid artifact id: ${artifactId}`);
  }
}

function compareStrings(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

function encodeArtifactPayload(payload: unknown): {
  readonly bytes: Buffer;
  readonly encoding: ArtifactEncoding;
} {
  if (payload instanceof Uint8Array) {
    return { bytes: Buffer.from(payload), encoding: "binary" };
  }
  if (typeof payload === "string") {
    return { bytes: Buffer.from(payload, "utf8"), encoding: "utf-8" };
  }
  // Artifacts are JSON-encoded, so `undefined` values cannot be preserved verbatim—
  // JSON encoding `undefined` would produce no output. We normalize `undefined`
  // to `null` so that step outputs which happen to be undefined survive replay as
  // `null`. This is intentional: alpha step contracts treat structured outputs as
  // the norm, and "no useful output" is best expressed as explicit `null`. Future
  // versions may enforce that step outputs cannot be undefined.
  const normalized = payload === undefined ? null : payload;
  return { bytes: Buffer.from(canonicalJson(normalized), "utf8"), encoding: "json" };
}

function decodeArtifactPayload(bytes: Buffer, encoding: ArtifactEncoding): unknown {
  switch (encoding) {
    case "json":
      return JSON.parse(bytes.toString("utf8")) as unknown;
    case "utf-8":
      return bytes.toString("utf8");
    case "binary":
      return new Uint8Array(bytes);
    default:
      throw new ArtifactManifestCorruptError("artifact://unknown", "encoding is invalid.");
  }
}

function parseArtifactManifest(text: string, ref: string): ArtifactManifest {
  try {
    return JSON.parse(text) as ArtifactManifest;
  } catch (error) {
    throw new ArtifactManifestCorruptError(
      ref,
      error instanceof Error ? error.message : "invalid JSON",
    );
  }
}

function assertArtifactManifestShape(
  manifest: ArtifactManifest,
  ref: string,
  artifactId: ArtifactId,
): void {
  if (!isRecord(manifest)) {
    throw new ArtifactManifestCorruptError(ref, "manifest must be an object.");
  }
  if (manifest.artifactId !== artifactId || manifest.artifactRef !== ref) {
    throw new ArtifactHashMismatchError(ref);
  }
  if (typeof manifest.runId !== "string" || !RUN_ID_PATTERN.test(manifest.runId)) {
    throw new ArtifactManifestCorruptError(ref, "runId must be a valid run id.");
  }
  if (manifest.stepPath !== undefined && typeof manifest.stepPath !== "string") {
    throw new ArtifactManifestCorruptError(ref, "stepPath must be a string when present.");
  }
  if (typeof manifest.name !== "string" || manifest.name.length === 0) {
    throw new ArtifactManifestCorruptError(ref, "name must be a non-empty string.");
  }
  if (typeof manifest.contentType !== "string" || manifest.contentType.length === 0) {
    throw new ArtifactManifestCorruptError(ref, "contentType must be a non-empty string.");
  }
  if (
    manifest.encoding !== "json" &&
    manifest.encoding !== "utf-8" &&
    manifest.encoding !== "binary"
  ) {
    throw new ArtifactManifestCorruptError(ref, "encoding must be json, utf-8, or binary.");
  }
  if (typeof manifest.sha256 !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(manifest.sha256)) {
    throw new ArtifactManifestCorruptError(ref, "sha256 must be a sha256 digest.");
  }
  if (!Number.isSafeInteger(manifest.sizeBytes) || manifest.sizeBytes < 0) {
    throw new ArtifactManifestCorruptError(ref, "sizeBytes must be a non-negative integer.");
  }
  if (typeof manifest.createdAt !== "string" || manifest.createdAt.length === 0) {
    throw new ArtifactManifestCorruptError(ref, "createdAt must be a string.");
  }
}

function sha256Bytes(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function writeFileDurably(path: string, data: string | Uint8Array): Promise<void> {
  const handle = await open(path, "w");
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function ensureDirectory(path: string): Promise<void> {
  const missingDirectories = await findMissingDirectories(path);
  await mkdir(path, { recursive: true });
  await syncDirectory(path);
  await syncDirectory(dirname(path));
  await Promise.all(
    missingDirectories.map((directory) => syncDirectory(dirname(directory))),
  );
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function findMissingDirectories(path: string): Promise<readonly string[]> {
  const missingDirectories: string[] = [];
  for (const directory of directoryChain(path)) {
    try {
      const entry = await stat(directory);
      if (!entry.isDirectory()) {
        throw new WorldPathError(`Expected directory path, received file path: ${directory}`);
      }
    } catch (error) {
      if (!isErrno(error, "ENOENT")) {
        throw error;
      }
      missingDirectories.push(directory);
    }
  }
  return missingDirectories;
}

function directoryChain(path: string): readonly string[] {
  const directories: string[] = [];
  let current = resolve(path);
  while (true) {
    directories.unshift(current);
    const parent = dirname(current);
    if (parent === current) {
      return directories;
    }
    current = parent;
  }
}

function withWriteChain<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = writeChains.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(fn);
  writeChains.set(key, next);
  return next.finally(() => {
    if (writeChains.get(key) === next) {
      writeChains.delete(key);
    }
  });
}

function artifactRefValue(value: unknown): ArtifactRef | undefined {
  return typeof value === "string" && value.startsWith("artifact://")
    ? value as ArtifactRef
    : undefined;
}

function artifactRefsValue(value: unknown): readonly ArtifactRef[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    const ref = artifactRefValue(item);
    return ref === undefined ? [] : [ref];
  });
}

function canonicalClone<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}

function deepFreeze<T>(value: T): T {
  if (ArrayBuffer.isView(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      deepFreeze(item);
    }
    return Object.freeze(value) as T;
  }
  if (isRecord(value)) {
    for (const item of Object.values(value)) {
      deepFreeze(item);
    }
    return Object.freeze(value) as T;
  }
  return value;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return isRecord(error) && error.code === code;
}

// ── World port factory ────────────────────────────────────────────────────────

export function createLocalWorld(config: {
  dataDir: string;
  maxConcurrentSteps?: number;
}): World {
  const base = {
    kind: "local-world" as const,
    dataDir: config.dataDir,
    ...(config.maxConcurrentSteps !== undefined
      ? { maxConcurrentSteps: config.maxConcurrentSteps }
      : {}),
  };
  return {
    ...base,
    appendEvent: (runId, event) => appendEvent(base as never, runId, event),
    listEvents: (runId) => listEvents(base as never, runId),
    writeArtifact: (input) => writeArtifact(base as never, input),
    readArtifact: (ref) => readArtifact(base as never, ref),
    readArtifactManifest: (ref) => readArtifactManifest(base as never, ref),
  };
}

// ── Outer-loop manifest ────────────────────────────────────────────────────────

export type OuterLoopCycleSummary = {
  readonly cycleNumber: number;
  readonly runId: string;
  readonly workflowVersionId: string;
  readonly status: "completed" | "failed";
  readonly output: unknown;
  readonly summary?: string;
};

export type OuterLoopManifest = {
  readonly outerLoopId: string;
  readonly goal: {
    readonly workflowDefinitionHash: string;
    readonly description: string;
  };
  readonly maxCycles: number;
  readonly cycles: ReadonlyArray<OuterLoopCycleSummary>;
  readonly result?: { readonly kind: "done"; readonly finalOutput: unknown };
  /**
   * Set before a cycle begins, cleared after the cycle's `OuterLoopCycleCompleted`
   * event is written and the manifest is updated. Used to resume a mid-cycle crash:
   * on resume, the outer-loop scheduler reuses this runId so Layer A replay can pick
   * up from the last committed step event.
   */
  readonly pendingCycleRunId?: string;
};

const OUTER_LOOP_ID_PATTERN = /^ol_[A-Za-z0-9_-]{1,80}$/u;

function outerLoopManifestPath(world: LocalWorld, outerLoopId: string): string {
  return join(world.dataDir, "outer-loops", `${outerLoopId}.json`);
}

export async function writeOuterLoopManifest(
  world: LocalWorld,
  outerLoopId: string,
  manifest: OuterLoopManifest,
): Promise<void> {
  if (!OUTER_LOOP_ID_PATTERN.test(outerLoopId)) {
    throw new WorldPathError(`Invalid outer-loop id: ${outerLoopId}`);
  }
  const manifestPath = outerLoopManifestPath(world, outerLoopId);
  const outerLoopsDir = join(world.dataDir, "outer-loops");
  await ensureDirectory(outerLoopsDir);
  const tmpPath = `${manifestPath}.tmp`;
  await writeFileDurably(tmpPath, `${canonicalJson(manifest)}\n`);
  await rename(tmpPath, manifestPath);
  await syncDirectory(outerLoopsDir);
}

export async function readOuterLoopManifest(
  world: LocalWorld,
  outerLoopId: string,
): Promise<OuterLoopManifest | undefined> {
  if (!OUTER_LOOP_ID_PATTERN.test(outerLoopId)) {
    throw new WorldPathError(`Invalid outer-loop id: ${outerLoopId}`);
  }
  const manifestPath = outerLoopManifestPath(world, outerLoopId);
  try {
    const text = await readFile(manifestPath, "utf8");
    return JSON.parse(text) as OuterLoopManifest;
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}
