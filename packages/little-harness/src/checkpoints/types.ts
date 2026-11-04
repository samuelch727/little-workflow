export type HarnessCheckpointKind = "goal_reached" | "pre_risky_op";
export type HarnessCheckpointTier = "tag" | "filesystem" | "machine";

export type HarnessCheckpointRequest = Readonly<{
  protocolVersion: "little-harness.checkpoints.v1";
  sessionId: string;
  originTurnId: string;
  modelStepId: string;
  sequenceIndex: number;
  callIdentity: string;
  label: string;
  kind: HarnessCheckpointKind;
  rationale?: string;
  evidenceArtifactIds: readonly string[];
  abortSignal?: AbortSignal;
}>;

export type HarnessCheckpointResult = Readonly<{
  protocolVersion: "little-harness.checkpoints.v1";
  sessionId: string;
  callIdentity: string;
  milestoneId: string;
  kind: HarnessCheckpointKind;
  tier: HarnessCheckpointTier;
  disposition: "created" | "replayed" | "coalesced";
  warning?: string;
}>;

export type HarnessCheckpointWriter = Readonly<{
  checkpoint(request: HarnessCheckpointRequest): Promise<HarnessCheckpointResult>;
}>;

export type HarnessCheckpointsOptions = Readonly<{
  writer: HarnessCheckpointWriter;
}>;

export type ResolvedHarnessCheckpoints = Readonly<{
  writer: HarnessCheckpointWriter;
}>;
