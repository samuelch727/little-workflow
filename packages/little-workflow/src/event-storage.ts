import type { EventEnvelope, RunId } from "./world.js";

/** Persistence only. Append ordering, validation and freezing stay in world.ts. */
export interface EventStorage {
  findByIdempotency(runId: RunId, key: string): Promise<EventEnvelope | undefined>;
  maxSequence(runId: RunId): Promise<number>;
  insert(event: EventEnvelope): Promise<void>;
  list(runId: RunId): Promise<readonly EventEnvelope[]>;
  listRunIds(): Promise<readonly string[]>;
  deleteAfter(runId: RunId, sequence: number): Promise<void>;
}
