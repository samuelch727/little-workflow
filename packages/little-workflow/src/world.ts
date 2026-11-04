import { createHash, randomUUID } from "node:crypto";
import { join, posix, resolve } from "node:path";
import type { LocalWorld } from "./authoring.js";
import { canonicalJson, sha256Digest } from "./canonical.js";
import type { UsageTotals } from "./pricing.js";
import { materializeRunStateFromEvents } from "./run-state.js";
import { stripUndefined } from "./strip-undefined.js";
import type { World } from "./world-port.js";
import type { EventStorage } from "./event-storage.js";
import { sqliteEventStorage } from "./event-storage-sqlite.js";
import { filesystemEventStorage } from "./event-storage-filesystem.js";
import { runFilesFor } from "./run-files.js";
import { virtualDataDir, virtualStorageKey } from "./storage-identity.js";
import type { IFileSystem } from "just-bash";

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
  /** Present for Harness Session appends; generic Workflow facts remain keyless. */
  readonly appendIdempotencyKey?: string;
  readonly canonicalRequestDigest?: string;
  readonly payload: JsonRecord;
};

export type EventRef = {
  readonly eventId: string;
  readonly runId: RunId;
  readonly sequence: number;
  readonly type: EventType;
  readonly occurrenceId?: string;
  readonly appendIdempotencyKey?: string;
  readonly canonicalRequestDigest?: string;
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

function worldPath(world: Pick<World, "dataDir" | "files">, ...parts: string[]): string {
  // Next 15's build tracer mistakes a conditional path callee for a thenable.
  if (world.files === undefined) return join(world.dataDir, ...parts);
  return posix.join(world.dataDir, ...parts);
}

function eventStorageFor(world: LocalWorld): EventStorage {
  return world.files === undefined
    ? sqliteEventStorage(world.dataDir)
    : filesystemEventStorage(world.files, world.dataDir);
}

function eventChainKey(world: LocalWorld, runId: string): string {
  return world.files === undefined
    ? `events:${resolve(world.dataDir)}:${runId}`
    : virtualStorageKey(world.files, world.dataDir, `events:${runId}`);
}

/** Close the disk adapter's cached connections; filesystem Worlds have no cache. */
export { closeSQLiteEventStoresForTest as closeEventStoresForTest } from "./event-storage-sqlite.js";

export async function appendEvent(
  world: LocalWorld,
  runId: RunId,
  event: EventInput,
): Promise<EventEnvelope> {
  validateRunId(runId);
  assertAppendIdempotencyPair(event);
  return withWriteChain(eventChainKey(world, runId), async () => {
    const store = eventStorageFor(world);
    if (event.appendIdempotencyKey !== undefined) {
      const existing = await store.findByIdempotency(runId, event.appendIdempotencyKey);
      if (existing !== undefined) {
        if (existing.canonicalRequestDigest !== event.canonicalRequestDigest) {
          throw new EventAppendIdempotencyConflictError(
            runId,
            event.appendIdempotencyKey,
          );
        }
        return deepFreeze(existing);
      }
    }
    // Artifact-reference invariant is checked BEFORE persistence so a rejected
    // append never consumes a sequence number (see "rejected append" guarantee).
    await assertReferencedArtifactsExist(world, runId, event);
    const sequence = await store.maxSequence(runId) + 1;
    const envelope: EventEnvelope = {
      eventId: eventIdFor(runId, sequence, event),
      runId,
	      sequence,
	      type: event.type,
	      ...(event.occurrenceId === undefined ? {} : { occurrenceId: event.occurrenceId }),
	      ...(event.appendIdempotencyKey === undefined
          ? {}
          : { appendIdempotencyKey: event.appendIdempotencyKey }),
	      ...(event.canonicalRequestDigest === undefined
          ? {}
          : { canonicalRequestDigest: event.canonicalRequestDigest }),
	      recordedAt: new Date().toISOString(),
	      payload: canonicalClone(event.payload),
    };
    // The shared per-run chain includes receipt lookup, artifact validation,
    // sequence allocation and publication, regardless of the storage adapter.
    await store.insert(envelope);
    return deepFreeze(envelope);
  });
}

export class EventAppendIdempotencyConflictError extends Error {
  readonly runId: string;
  readonly appendIdempotencyKey: string;

  constructor(runId: string, appendIdempotencyKey: string) {
    super(`Append key ${appendIdempotencyKey} was already used with another request in ${runId}.`);
    this.name = "EventAppendIdempotencyConflictError";
    this.runId = runId;
    this.appendIdempotencyKey = appendIdempotencyKey;
  }
}

function assertAppendIdempotencyPair(event: EventInput): void {
  if ((event.appendIdempotencyKey === undefined) !== (event.canonicalRequestDigest === undefined)) {
    throw new TypeError(
      "appendIdempotencyKey and canonicalRequestDigest must be supplied together",
    );
  }
  if (event.appendIdempotencyKey !== undefined) {
    if (
      Buffer.byteLength(event.appendIdempotencyKey, "utf8") < 16 ||
      Buffer.byteLength(event.appendIdempotencyKey, "utf8") > 256 ||
      event.appendIdempotencyKey.includes("\0")
    ) {
      throw new TypeError("appendIdempotencyKey is invalid");
    }
    if (!/^sha256:[a-f0-9]{64}$/u.test(event.canonicalRequestDigest!)) {
      throw new TypeError("canonicalRequestDigest is invalid");
    }
  }
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
  return (await eventStorageFor(world).list(runId)).map(event => deepFreeze(event));
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
    await eventStorageFor(world).deleteAfter(runId, keepThroughSequence);
  });
}

export async function listRunIds(world: LocalWorld): Promise<readonly RunId[]> {
  return (await eventStorageFor(world).listRunIds())
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
  const key = world.files === undefined
    ? `artifact:${resolve(world.dataDir)}:${artifactId}`
    : virtualStorageKey(world.files, world.dataDir, `artifact:${artifactId}`);
  return withWriteChain(key, () =>
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
  const manifestPath = worldPath(world, "artifacts", `${artifactId}.json`);
  const files = runFilesFor(world);
  const existingManifest = await readArtifactManifestIfPresent(world, manifestPath);
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
  const artifactsDir = worldPath(world, "artifacts");
  const blobsDir = files.path.join(artifactsDir, "blobs");
  await files.ensureDirectory(artifactsDir);
  await files.ensureDirectory(blobsDir);

  const blobPath = files.path.join(blobsDir, `${artifactId}.bin`);
  const blobTempPath = `${blobPath}.tmp`;
  await files.writeFileDurably(blobTempPath, encoded.bytes);
  await files.rename(blobTempPath, blobPath);
  await files.syncDirectory(blobsDir);

  const manifestTempPath = `${manifestPath}.tmp`;
  await files.writeFileDurably(manifestTempPath, `${canonicalJson(manifest)}\n`);
  await files.rename(manifestTempPath, manifestPath);
  await files.syncDirectory(artifactsDir);
  return manifest;
}

export async function readArtifact(
  world: LocalWorld,
  ref: string,
): Promise<ArtifactReadResult> {
  const artifactId = artifactIdFromRef(ref);
  const files = runFilesFor(world);
  const manifest = await readArtifactManifest(world, ref);

  const blobPath = worldPath(world, "artifacts", "blobs", `${artifactId}.bin`);
  let bytes: Buffer;
  try {
    bytes = Buffer.from(await files.readFile(blobPath));
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
  const manifestPath = worldPath(world, "artifacts", `${artifactId}.json`);
  try {
    const manifest = parseArtifactManifest(await runFilesFor(world).readFile(manifestPath, "utf8"), ref);
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
  world: LocalWorld,
  manifestPath: string,
): Promise<ArtifactManifest | undefined> {
  try {
    return deepFreeze(parseArtifactManifest(await runFilesFor(world).readFile(manifestPath, "utf8"), manifestPath));
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
  return createWorld({
    kind: "local-world",
    dataDir: config.dataDir,
    ...(config.maxConcurrentSteps === undefined ? {} : { maxConcurrentSteps: config.maxConcurrentSteps }),
  });
}

export type VirtualWorldOptions = {
  fs: IFileSystem;
  dataDir?: string;
  maxConcurrentSteps?: number;
};

/**
 * One process owns this filesystem namespace. Persistence and atomic publication
 * are inherited from fs; bare InMemoryFs is not durable across process restarts.
 */
export function virtualWorld(options: VirtualWorldOptions): World {
  if (options?.fs === undefined || options.fs === null) {
    throw new TypeError("virtualWorld requires a filesystem.");
  }
  return createWorld({
    kind: "virtual-world",
    files: options.fs,
    dataDir: virtualDataDir(options.dataDir ?? "/"),
    ...(options.maxConcurrentSteps === undefined ? {} : { maxConcurrentSteps: options.maxConcurrentSteps }),
  });
}

function createWorld(base: Pick<World, "kind" | "dataDir" | "files" | "maxConcurrentSteps">): World {
  return {
    ...base,
    appendEvent: (runId, event) => appendEvent(base as LocalWorld, runId, event),
    listEvents: (runId) => listEvents(base as LocalWorld, runId),
    writeArtifact: (input) => writeArtifact(base as LocalWorld, input),
    readArtifact: (ref) => readArtifact(base as LocalWorld, ref),
    readArtifactManifest: (ref) => readArtifactManifest(base as LocalWorld, ref),
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
  /**
   * `sha256Digest` of the loop's input. A resumed call with different input is
   * rejected. Absent from manifests written before it existed; the outer-loop
   * scheduler backfills it on the next resume.
   */
  readonly inputHash?: string;
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
  return worldPath(world, "outer-loops", `${outerLoopId}.json`);
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
  const outerLoopsDir = worldPath(world, "outer-loops");
  const files = runFilesFor(world);
  await files.ensureDirectory(outerLoopsDir);
  const tmpPath = `${manifestPath}.tmp`;
  await files.writeFileDurably(tmpPath, `${canonicalJson(manifest)}\n`);
  await files.rename(tmpPath, manifestPath);
  await files.syncDirectory(outerLoopsDir);
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
    const text = await runFilesFor(world).readFile(manifestPath, "utf8");
    return JSON.parse(text) as OuterLoopManifest;
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

// ── Run pins ──────────────────────────────────────────────────────────────────

/**
 * The version a run started on, for workflows whose definition is chosen per run
 * (`versionedHarnessWorkflow`). Written once, before the run's first event, and
 * never replaced, so a run that resumes after a crash rebuilds the same workflow
 * even if the live version changed in between.
 */
export type RunPin<C = unknown> = {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly content: C;
  /** What the version source handed back to name this version again, e.g. LittleDB's version id. */
  readonly version?: unknown;
  /**
   * Hash of every other field. It catches a damaged or hand-edited pin; it does not
   * authenticate one, since whoever can rewrite the pin can rewrite the hash.
   */
  readonly pinHash: string;
};

const RUN_PIN_KEYS = new Set(["schemaVersion", "runId", "content", "version", "pinHash"]);

function runPinPath(world: Pick<World, "dataDir" | "files">, runId: string): string {
  return worldPath(world, "run-pins", `${runId}.json`);
}

function runPinHash(pin: Omit<RunPin, "pinHash">): string {
  return sha256Digest({
    schemaVersion: pin.schemaVersion,
    runId: pin.runId,
    content: pin.content,
    ...(pin.version === undefined ? {} : { version: pin.version }),
  });
}

/**
 * Records `pin` for its run unless one is already there, and returns the stored
 * pin and whether this call wrote it: when two processes start the same run,
 * both run the first one written.
 */
export async function writeRunPin<C>(
  world: Pick<World, "dataDir" | "files">,
  pin: { readonly runId: string; readonly content: C; readonly version?: unknown },
): Promise<{ readonly pin: RunPin<C>; readonly written: boolean }> {
  validateRunId(pin.runId);
  const pinsDir = worldPath(world, "run-pins");
  const files = runFilesFor(world);
  await files.ensureDirectory(pinsDir);
  const pinPath = runPinPath(world, pin.runId);
  const tmpPath = `${pinPath}.${randomUUID()}.tmp`;
  const stored = stripUndefined({ schemaVersion: 1 as const, ...pin });
  await files.writeFileDurably(tmpPath, `${canonicalJson({ ...stored, pinHash: runPinHash(stored) })}\n`);
  let written = true;
  try {
    // `link` fails if the pin exists, so the first pin written is never replaced.
    await files.link(tmpPath, pinPath);
  } catch (error) {
    if (!isErrno(error, "EEXIST")) throw error;
    written = false;
  } finally {
    await files.rm(tmpPath, { force: true });
  }
  await files.syncDirectory(pinsDir);
  const found = await readRunPin<C>(world, pin.runId);
  if (found === undefined) {
    throw new WorldPathError(`Run pin for '${pin.runId}' was not written.`);
  }
  return { pin: found, written };
}

/** The run's pin, or `undefined` if it has none. Throws if the pin is unreadable or altered. */
export async function readRunPin<C>(
  world: Pick<World, "dataDir" | "files">,
  runId: string,
): Promise<RunPin<C> | undefined> {
  validateRunId(runId);
  let text: string;
  try {
    text = await runFilesFor(world).readFile(runPinPath(world, runId), "utf8");
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
  let pin: unknown;
  try {
    pin = JSON.parse(text);
  } catch {
    throw new Error(`Run pin for '${runId}' is not valid JSON.`);
  }
  if (
    !isRecord(pin) ||
    pin.schemaVersion !== 1 ||
    pin.runId !== runId ||
    !("content" in pin) ||
    Object.keys(pin).some((key) => !RUN_PIN_KEYS.has(key)) ||
    pin.pinHash !== runPinHash(pin as Omit<RunPin, "pinHash">)
  ) {
    throw new Error(`Run pin for '${runId}' does not match its hash.`);
  }
  return pin as RunPin<C>;
}
