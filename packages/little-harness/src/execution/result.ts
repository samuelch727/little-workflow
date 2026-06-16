import type {
  ArtifactRef,
  HarnessSession,
  HarnessWarning,
  PersistenceStatus,
  TraceRef,
} from "../types.js";

export type GenerateHarnessResult<TOutput = string> = {
  text: string;
  output: TOutput;
  session: HarnessSession;
  artifacts: ArtifactRef[];
  trace: TraceRef;
  persistence: PersistenceStatus;
  commitManual(): Promise<PersistenceStatus>;
  warnings: HarnessWarning[];
};

export type StreamHarnessFinished = {
  session: HarnessSession;
  artifacts: ArtifactRef[];
  trace: TraceRef;
  persistence: PersistenceStatus;
  commitManual(): Promise<PersistenceStatus>;
  warnings: HarnessWarning[];
};
