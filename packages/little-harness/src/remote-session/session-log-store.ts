import { appendFile, mkdir, readFile } from "node:fs/promises";
import * as path from "node:path";
import type {
  DurableHarnessEventInput,
  HarnessPriorEventQuery,
  PersistedDurableHarnessEvent,
} from "../events/occurrence.js";
import { createEventId } from "../ids.js";

export type SessionLogStore = {
  /**
   * Persists one event and assigns its per-run sequence. Implementations must serialize
   * appends internally — the HTTP server invokes this concurrently across requests.
   */
  append(event: DurableHarnessEventInput): Promise<PersistedDurableHarnessEvent>;
  priorEvents(query?: HarnessPriorEventQuery): Promise<readonly PersistedDurableHarnessEvent[]>;
};

/**
 * The reference in-memory session log: an append-only store of durable harness events with
 * server-assigned per-run sequences. It is the managed-agents "session" in its simplest
 * form — everything a stateless harness needs to reconstruct a run — and the default store
 * behind startSessionLogServer. It lives in process memory: a server restart loses every
 * run, so real deployments should pass createFileSessionLog (or their own store) instead.
 */
export function createInMemorySessionLog(): SessionLogStore & {
  readonly events: readonly PersistedDurableHarnessEvent[];
} {
  const events: PersistedDurableHarnessEvent[] = [];
  const sequences = new Map<string, number>();

  return {
    events,
    async append(event) {
      const sequence = (sequences.get(event.runId) ?? 0) + 1;
      sequences.set(event.runId, sequence);
      const persisted: PersistedDurableHarnessEvent = {
        ...event,
        eventId: createEventId(),
        sequence,
        recordedAt: new Date().toISOString(),
      };
      events.push(persisted);
      return persisted;
    },
    async priorEvents(query = {}) {
      // Clones, not live references: replay consumers must not be able to mutate the log.
      return filterEvents(events, query).map((event) => structuredClone(event));
    },
  };
}

export type FileSessionLogOptions = {
  /** Path of the append-only NDJSON log file; created (with parent directories) on first use. */
  path: string;
};

/**
 * A durable file-backed session log: one JSON event per line, appended after the event is
 * assigned its per-run sequence. Restarting the process (or the session-log server it
 * backs) re-reads the file, so kill-and-resume survives log-server restarts too — the
 * property the in-memory reference store cannot provide.
 */
export function createFileSessionLog(options: FileSessionLogOptions): SessionLogStore {
  const filePath = options.path;
  let state: Promise<{
    events: PersistedDurableHarnessEvent[];
    sequences: Map<string, number>;
    /** True when the file ends mid-line (torn write); the next append starts a fresh line. */
    needsLeadingNewline: boolean;
  }> | undefined;
  // Appends are serialized through this chain so concurrent HTTP requests cannot
  // interleave sequence assignment with the file write.
  let appendChain: Promise<unknown> = Promise.resolve();

  const load = () => {
    state ??= (async () => {
      const events: PersistedDurableHarnessEvent[] = [];
      const sequences = new Map<string, number>();
      let raw: string;
      try {
        raw = await readFile(filePath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return { events, sequences, needsLeadingNewline: false };
        }
        throw error;
      }
      for (const line of raw.split("\n")) {
        if (line.trim().length === 0) {
          continue;
        }
        let event: PersistedDurableHarnessEvent;
        try {
          event = JSON.parse(line) as PersistedDurableHarnessEvent;
        } catch {
          // A torn line is what a crash mid-append leaves behind — exactly the situation
          // this store exists to survive. Skip it instead of poisoning the whole log.
          continue;
        }
        events.push(event);
        const highest = sequences.get(event.runId) ?? 0;
        sequences.set(event.runId, Math.max(highest, event.sequence));
      }
      return {
        events,
        sequences,
        needsLeadingNewline: raw.length > 0 && !raw.endsWith("\n"),
      };
    })().catch((error: unknown) => {
      // Do not cache transient failures (EACCES, EMFILE, …): the next call retries.
      state = undefined;
      throw error;
    });
    return state;
  };

  return {
    append(event) {
      const run = appendChain.then(async () => {
        const loaded = await load();
        const { events, sequences } = loaded;
        const sequence = (sequences.get(event.runId) ?? 0) + 1;
        const persisted: PersistedDurableHarnessEvent = {
          ...event,
          eventId: createEventId(),
          sequence,
          recordedAt: new Date().toISOString(),
        };
        await mkdir(path.dirname(filePath), { recursive: true });
        // A torn tail (crash mid-append) must not swallow this event too: start a fresh
        // line so the corrupt fragment stays isolated and skippable.
        const prefix = loaded.needsLeadingNewline ? "\n" : "";
        try {
          await appendFile(filePath, `${prefix}${JSON.stringify(persisted)}\n`, "utf8");
        } catch (error) {
          // A failed write may have landed partial bytes (ENOSPC/EIO): force the retry
          // onto a fresh line so the fragment cannot swallow an acknowledged event. A
          // spurious blank line when nothing landed is harmless — blank lines are skipped.
          loaded.needsLeadingNewline = true;
          throw error;
        }
        loaded.needsLeadingNewline = false;
        // Only acknowledge in memory after the write survives, so a failed append is
        // retried from the same sequence instead of leaving a phantom event.
        sequences.set(event.runId, sequence);
        events.push(persisted);
        return persisted;
      });
      appendChain = run.catch(() => undefined);
      return run;
    },
    async priorEvents(query = {}) {
      await appendChain.catch(() => undefined);
      const { events } = await load();
      return filterEvents(events, query).map((event) => structuredClone(event));
    },
  };
}

function filterEvents(
  events: readonly PersistedDurableHarnessEvent[],
  query: HarnessPriorEventQuery,
): PersistedDurableHarnessEvent[] {
  return events.filter(
    (event) =>
      (query.runId === undefined || event.runId === query.runId) &&
      (query.type === undefined || event.type === query.type) &&
      (query.occurrenceId === undefined || event.occurrenceId === query.occurrenceId),
  );
}
