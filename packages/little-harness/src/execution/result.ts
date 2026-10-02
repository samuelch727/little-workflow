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
  text: string;
  output: TOutput;
  session: HarnessSession;
  artifacts: ArtifactRef[];
  trace: TraceRef;
  persistence: PersistenceStatus;
  commitManual(): Promise<PersistenceStatus>;
  warnings: HarnessWarning[];
};

export type HarnessTurnResult<TOutput = string> =
  | HarnessCompletedResult<TOutput>
  | HarnessParkedResult;

export type GenerateHarnessResult<TOutput = string> = HarnessCompletedResult<TOutput>;

export type StreamHarnessCompletedResult = {
  status: "completed";
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

export type StreamHarnessFinished = StreamHarnessCompletedResult;
