import type {
  ArtifactRef,
  HarnessSession,
  HarnessWarning,
  PersistenceStatus,
  TraceRef,
} from "../types.js";

export type HarnessParkedPending = {
  taskIds?: readonly string[];
  toolCallIds?: readonly string[];
  mode?: "all" | "any";
};

export type HarnessParkedResult = {
  status: "parked";
  continuationId: string;
  pending: HarnessParkedPending;
  session: HarnessSession;
  artifacts: ArtifactRef[];
  trace: TraceRef;
  warnings: HarnessWarning[];
};

export type HarnessCompletedResult<TOutput = string> = {
  status: "completed";
  /** A soft stop completed while calling tools: harness step cap or caller condition. */
  stopReason?: "step-limit" | "stop-condition";
  text: string;
  output: TOutput;
  session: HarnessSession;
  artifacts: ArtifactRef[];
  trace: TraceRef;
  persistence: PersistenceStatus;
  commitManual(): Promise<PersistenceStatus>;
  warnings: HarnessWarning[];
};

/** A turn can finish by completing or by parking until its pending work settles. */
export type HarnessTurnResult<TOutput = string> =
  | HarnessCompletedResult<TOutput>
  | HarnessParkedResult;


export type StreamHarnessCompletedResult = {
  status: "completed";
  /** A soft stop completed while calling tools: harness step cap or caller condition. */
  stopReason?: "step-limit" | "stop-condition";
  session: HarnessSession;
  artifacts: ArtifactRef[];
  trace: TraceRef;
  persistence: PersistenceStatus;
  commitManual(): Promise<PersistenceStatus>;
  warnings: HarnessWarning[];
};

export type StreamHarnessTurnFinished =
  | StreamHarnessCompletedResult
  | HarnessParkedResult;

