import { appendFile, mkdir, open, readFile, stat, truncate } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import * as path from "node:path";
import {
  HarnessAppendIdempotencyConflictError,
  canonicalHarnessEventRequestDigest,
  normalizeDurableHarnessEventInput,
  normalizePersistedDurableHarnessEvent,
  type DurableHarnessEventInput,
  type HarnessPriorEventQuery,
  type PersistedDurableHarnessEvent,
} from "../events/occurrence.js";
import { LittleHarnessError } from "../errors.js";
import { createEventId } from "../ids.js";

export type SessionLogStore = {
  /**
   * Persists one event and assigns its per-run sequence. Implementations must serialize
   * appends internally — the HTTP server invokes this concurrently across requests.
   */
  append(event: DurableHarnessEventInput): Promise<PersistedDurableHarnessEvent>;
  priorEvents(query?: HarnessPriorEventQuery): Promise<readonly PersistedDurableHarnessEvent[]>;
};

type IdempotencyEntry = Readonly<{
  digest: string;
  event: PersistedDurableHarnessEvent;
}>;

type SessionLogState = {
  events: PersistedDurableHarnessEvent[];
  sequences: Map<string, number>;
  idempotency: Map<string, IdempotencyEntry>;
  /** Bytes through the final committed newline. A later tail is uncommitted. */
  committedByteLength: number;
  hasUncommittedTail: boolean;
};

/**
 * The reference in-memory session log. Identical retries return the original event and
 * sequence; reusing a `(runId, appendIdempotencyKey)` with another request is rejected.
 */
export function inMemorySessionLog(): SessionLogStore & {
  readonly events: readonly PersistedDurableHarnessEvent[];
} {
  const events: PersistedDurableHarnessEvent[] = [];
  const sequences = new Map<string, number>();
  const idempotency = new Map<string, IdempotencyEntry>();
  let appendChain: Promise<unknown> = Promise.resolve();

  return {
    events,
    append(event) {
      const run = appendChain.then(async () => {
        const normalized = normalizeDurableHarnessEventInput(event);
        const digest = canonicalHarnessEventRequestDigest(normalized);
        const existing = idempotency.get(idempotencyMapKey(normalized));
        if (existing !== undefined) {
          return resolveIdempotentRetry(normalized, digest, existing);
        }
        const sequence = (sequences.get(normalized.runId) ?? 0) + 1;
        const persisted = makePersistedEvent(normalized, digest, sequence);
        sequences.set(normalized.runId, sequence);
        events.push(persisted);
        idempotency.set(idempotencyMapKey(normalized), { digest, event: persisted });
        return structuredClone(persisted);
      });
      appendChain = run.catch(() => undefined);
      return run;
    },
    async priorEvents(query = {}) {
      await appendChain.catch(() => undefined);
      return filterEvents(events, normalizeQuery(query)).map((event) => structuredClone(event));
    },
  };
}

export type FileSessionLogOptions = {
  /** Path of the append-only NDJSON log file; created (with parent directories) on first use. */
  path: string;
  /**
   * `true` by default: fsync the file and its parent directory before every
   * acknowledgement. Set false only when crash durability is intentionally not
   * required.
   */
  sync?: boolean;
};

export class FileSessionLogDurabilityError extends LittleHarnessError {
  declare readonly code: "file_session_log_durability_error";
  readonly target: "file" | "parent_directory";

  constructor(target: "file" | "parent_directory", cause: unknown) {
    super(
      target === "file"
        ? "File session log could not durably synchronize its data file."
        : "File session log could not durably synchronize its parent directory; this filesystem is unsupported for acknowledged file-log durability.",
      "file_session_log_durability_error",
      undefined,
      { cause },
    );
    this.name = "FileSessionLogDurabilityError";
    this.target = target;
  }
}

/**
 * A single-process durable file log. It rebuilds both sequence and idempotency indexes on
 * restart. Newline is the commit marker: only one final unterminated fragment is
 * treated as uncommitted, while malformed complete records and sequence gaps fail
 * closed. An acknowledged retry keeps the original event identity across a restart.
 * This adapter serializes one process only; use the PostgreSQL store for multiple
 * writers.
 */
export function fileSessionLog(options: FileSessionLogOptions): SessionLogStore {
  const filePath = options.path;
  const syncWrites = options.sync ?? true;
  let state: Promise<SessionLogState> | undefined;
  let parentDurability: Promise<void> | undefined;
  let appendChain: Promise<unknown> = Promise.resolve();

  const load = () => {
    state ??= loadFileState(filePath).catch((error: unknown) => {
      // Do not cache transient failures (EACCES, EMFILE, …): the next call retries.
      state = undefined;
      throw error;
    });
    return state;
  };
  const ensureParent = () => {
    if (!syncWrites) return mkdir(path.dirname(filePath), { recursive: true }).then(() => undefined);
    parentDurability ??= ensureDurableDirectoryTree(path.dirname(filePath)).catch((error: unknown) => {
      parentDurability = undefined;
      throw error;
    });
    return parentDurability;
  };

  return {
    append(event) {
      const run = appendChain.then(async () => {
        const loaded = await load();
        try {
          await ensureParent();
          if (loaded.hasUncommittedTail) {
            await truncate(filePath, loaded.committedByteLength);
            loaded.hasUncommittedTail = false;
            if (syncWrites) await syncPath(filePath, "file");
          }
          const normalized = normalizeDurableHarnessEventInput(event);
          const digest = canonicalHarnessEventRequestDigest(normalized);
          const key = idempotencyMapKey(normalized);
          const existing = loaded.idempotency.get(key);
          if (existing !== undefined) {
            if (syncWrites) await syncFileAndParent(filePath);
            return resolveIdempotentRetry(normalized, digest, existing);
          }
          const sequence = (loaded.sequences.get(normalized.runId) ?? 0) + 1;
          const persisted = makePersistedEvent(normalized, digest, sequence);
          const record = `${JSON.stringify(persisted)}\n`;
          await appendFile(filePath, record, "utf8");
          if (syncWrites) await syncFileAndParent(filePath);
          loaded.committedByteLength += Buffer.byteLength(record, "utf8");
          loaded.sequences.set(normalized.runId, sequence);
          loaded.events.push(persisted);
          loaded.idempotency.set(key, { digest, event: persisted });
          return structuredClone(persisted);
        } catch (error) {
          // The write or either fsync may have committed despite a lost response.
          // Rebuild from newline-delimited committed records before the next action.
          state = undefined;
          parentDurability = undefined;
          throw error;
        }
      });
      appendChain = run.catch(() => undefined);
      return run;
    },
    async priorEvents(query = {}) {
      await appendChain.catch(() => undefined);
      const { events } = await load();
      return filterEvents(events, normalizeQuery(query)).map((event) => structuredClone(event));
    },
  };
}

/**
 * Create one component at a time and sync every containing directory. Existing
 * components are also synced on initialization, which closes the retry/restart
 * case where a previous mkdir landed but its fsync acknowledgement was lost.
 */
async function ensureDurableDirectoryTree(directory: string): Promise<void> {
  const resolved = path.resolve(directory);
  const root = path.parse(resolved).root;
  let current = root;
  for (const component of path.relative(root, resolved).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    try {
      const currentStat = await stat(current);
      if (!currentStat.isDirectory()) {
        throw new Error(`File session log parent component is not a directory: ${current}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
        const racedStat = await stat(current);
        if (!racedStat.isDirectory()) {
          throw new Error(`File session log parent component is not a directory: ${current}`);
        }
      }
    }
    await syncPath(path.dirname(current), "parent_directory");
  }
}

async function syncFileAndParent(filePath: string): Promise<void> {
  await syncPath(filePath, "file");
  await syncPath(path.dirname(filePath), "parent_directory");
}

async function syncPath(
  targetPath: string,
  target: "file" | "parent_directory",
): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(targetPath, "r");
    await handle.sync();
    await handle.close();
  } catch (error) {
    await handle?.close().catch(() => undefined);
    throw new FileSessionLogDurabilityError(target, error);
  }
}

async function loadFileState(filePath: string): Promise<SessionLogState> {
  const events: PersistedDurableHarnessEvent[] = [];
  const sequences = new Map<string, number>();
  const idempotency = new Map<string, IdempotencyEntry>();
  let raw: Buffer;
  try {
    raw = await readFile(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        events,
        sequences,
        idempotency,
        committedByteLength: 0,
        hasUncommittedTail: false,
      };
    }
    throw error;
  }

  const finalNewline = raw.lastIndexOf(0x0a);
  const committedByteLength = finalNewline + 1;
  const committedBytes = raw.subarray(0, committedByteLength);
  let committedText: string;
  try {
    committedText = new TextDecoder("utf-8", { fatal: true }).decode(committedBytes);
  } catch (error) {
    throw new Error("Session-log committed prefix is not valid UTF-8.", { cause: error });
  }
  const completeLines = committedText.length === 0
    ? []
    : committedText.split("\n").slice(0, -1);
  for (const [lineIndex, line] of completeLines.entries()) {
    if (line.trim().length === 0) {
      throw new Error(`Session-log record at line ${lineIndex + 1} is empty.`);
    }
    let untrusted: unknown;
    try {
      untrusted = JSON.parse(line);
    } catch (error) {
      throw new Error(`Invalid session-log JSON at line ${lineIndex + 1}.`, { cause: error });
    }
    let event: PersistedDurableHarnessEvent;
    try {
      event = normalizePersistedDurableHarnessEvent(untrusted);
    } catch (error) {
      throw new Error(`Invalid session-log record at line ${lineIndex + 1}.`, { cause: error });
    }
    const previousSequence = sequences.get(event.runId) ?? 0;
    const expectedSequence = previousSequence + 1;
    if (event.sequence !== expectedSequence) {
      throw new Error(
        `Session-log sequence for run ${event.runId} is ${event.sequence} at line ${lineIndex + 1}; expected ${expectedSequence}.`,
      );
    }
    const key = idempotencyMapKey(event);
    if (idempotency.has(key)) {
      throw new Error(
        `Session-log contains duplicate append idempotency key ${event.appendIdempotencyKey} for run ${event.runId}.`,
      );
    }
    events.push(event);
    sequences.set(event.runId, event.sequence);
    idempotency.set(key, { digest: event.canonicalRequestDigest, event });
  }
  return {
    events,
    sequences,
    idempotency,
    committedByteLength,
    hasUncommittedTail: committedByteLength < raw.byteLength,
  };
}

function makePersistedEvent(
  event: DurableHarnessEventInput,
  canonicalRequestDigest: string,
  sequence: number,
): PersistedDurableHarnessEvent {
  return normalizePersistedDurableHarnessEvent({
    ...event,
    eventId: createEventId(),
    sequence,
    recordedAt: new Date().toISOString(),
    canonicalRequestDigest,
  });
}

function idempotencyMapKey(
  event: Pick<DurableHarnessEventInput, "runId" | "appendIdempotencyKey">,
): string {
  // Length-prefix avoids delimiter ambiguity for arbitrary NUL-free identifiers.
  return `${Buffer.byteLength(event.runId, "utf8")}:${event.runId}${event.appendIdempotencyKey}`;
}

function resolveIdempotentRetry(
  event: DurableHarnessEventInput,
  digest: string,
  existing: IdempotencyEntry,
): PersistedDurableHarnessEvent {
  if (existing.digest !== digest) {
    throw new HarnessAppendIdempotencyConflictError(event.runId, event.appendIdempotencyKey);
  }
  return structuredClone(existing.event);
}

function normalizeQuery(query: HarnessPriorEventQuery): HarnessPriorEventQuery {
  if (query.afterSequence !== undefined &&
    (!Number.isSafeInteger(query.afterSequence) || query.afterSequence < 0)) {
    throw new TypeError("afterSequence must be a non-negative safe integer");
  }
  if (query.limit !== undefined &&
    (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 10_000)) {
    throw new TypeError("limit must be an integer between 1 and 10000");
  }
  return query;
}

function filterEvents(
  events: readonly PersistedDurableHarnessEvent[],
  query: HarnessPriorEventQuery,
): PersistedDurableHarnessEvent[] {
  const filtered = events.filter(
    (event) =>
      (query.runId === undefined || event.runId === query.runId) &&
      (query.type === undefined || event.type === query.type) &&
      (query.occurrenceId === undefined || event.occurrenceId === query.occurrenceId) &&
      (query.operationId === undefined || event.operationId === query.operationId) &&
      (query.taskId === undefined || event.taskId === query.taskId) &&
      (query.attemptId === undefined || event.attemptId === query.attemptId) &&
      (query.afterSequence === undefined || event.sequence > query.afterSequence),
  );
  return query.limit === undefined ? filtered : filtered.slice(0, query.limit);
}
