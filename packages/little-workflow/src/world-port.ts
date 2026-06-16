import type {
  ArtifactInput,
  ArtifactManifest,
  ArtifactReadResult,
  EventEnvelope,
  EventInput,
  RunId,
} from "./world.js";

/**
 * The durable storage port for a run. Owns durable persistence + the recovery
 * read path — NOT the memoization policy (that stays in the runtime).
 *
 * Implementations:
 *  - localWorld()  — default embedded adapter (this package)
 *  - littleDB()    — Tracing World (separate `littledb` repo)
 */
export interface World {
  readonly kind: string;
  readonly dataDir: string;
  readonly maxConcurrentSteps?: number;
  appendEvent(runId: RunId, event: EventInput): Promise<EventEnvelope>;
  listEvents(runId: RunId): Promise<readonly EventEnvelope[]>;
  writeArtifact(input: ArtifactInput): Promise<ArtifactManifest>;
  readArtifact(ref: string): Promise<ArtifactReadResult>;
  readArtifactManifest(ref: string): Promise<ArtifactManifest>;
}
