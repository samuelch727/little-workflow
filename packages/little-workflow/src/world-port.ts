import type { IFileSystem } from "just-bash";
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
 *  - virtualWorld() — single-process adapter over an IFileSystem
 *  - db.tracingWorld(inner) — wraps any World to send runs to LittleDB (`@little-stack/littledb`)
 */
export interface World {
  readonly kind: string;
  readonly dataDir: string;
  /** Optional single-process filesystem backing all run data at POSIX paths. */
  readonly files?: IFileSystem;
  readonly maxConcurrentSteps?: number;
  appendEvent(runId: RunId, event: EventInput): Promise<EventEnvelope>;
  listEvents(runId: RunId): Promise<readonly EventEnvelope[]>;
  writeArtifact(input: ArtifactInput): Promise<ArtifactManifest>;
  readArtifact(ref: string): Promise<ArtifactReadResult>;
  readArtifactManifest(ref: string): Promise<ArtifactManifest>;
}
