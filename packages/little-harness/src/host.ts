/**
 * `@little-stack/harness/host`: for writing or tuning a host. Orchestration services, durable stores,
 * local paths, the local session store and queue, and the readers for local traces. `localHost()`
 * and `virtualHost()` themselves stay on the package root.
 */
export { createLocalFileWriter, type LocalFileWriterOptions } from "./files/file-writer.js";
export { createFsFileWriter, type FsFileWriterOptions } from "./files/fs-file-writer.js";
export { sessionKeyToPathKey } from "./ids.js";
export { resolveLocalDirSource } from "./local-host/local-dir.js";
export {
  createInMemoryOrchestrationServices,
  type InMemoryOrchestrationServicesOptions,
} from "./local-host/in-memory-orchestration-services.js";
export {
  createDurableOrchestrationServices,
  createFileDurableStore,
  createLocalHarnessDurableServices,
  type DurableOrchestrationServicesOptions,
  type LocalHarnessDurableServicesFaultInjection,
  type LocalHarnessDurableServicesFaultPoint,
  type LocalHarnessDurableServicesOptions,
} from "./local-host/durable-services.js";
export {
  createInMemoryDurableStore,
  recordKey,
  type DurableJsonStore,
} from "./local-host/durable-store.js";
export {
  assertInsideRoot,
  resolveLocalHostPaths,
  resolveProjectDirSource,
  sessionPaths,
  type LocalHostPathOptions,
  type LocalHostPaths,
  type LocalSessionPaths,
} from "./local-host/paths.js";
export { LocalSessionQueue, type LocalSessionQueueOptions } from "./local-host/queue.js";
export { LocalSessionStore, type LocalHarnessSession } from "./local-host/session-store.js";
export { LocalTrace } from "./local-host/trace.js";
export {
  doctorSession,
  latestDiffForPath,
  listLocalArtifacts,
  listLocalFiles,
  listLocalSessions,
  readLocalTrace,
  type DoctorSummary,
  type TraceEvent,
  type TraceReadError,
} from "./trace/inspect.js";
export type { TraceContentRef, TraceErrorEnvelope, TraceFileDiff } from "./trace/types.js";
export type { HarnessOrchestrationServices, HarnessSessionManager, PreparedTurn } from "./types.js";

export type { HarnessTurnBudgetRef, HarnessTurnBudgetCaps, HarnessTurnBudgetState, HarnessTurnBudgetLedger } from "./execution/turn-budget.js";
