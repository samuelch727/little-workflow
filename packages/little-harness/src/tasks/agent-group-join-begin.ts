import type { HarnessAgentGroupJoinBeginReservation, HarnessAgentGroupJoinBeginReservationResult,
  HarnessAgentGroupOperationResultBinding, HarnessAgentGroupPageCallBinding,
  HarnessAgentGroupPendingOperationBinding } from "./ledger.js";

export type AgentGroupJoinBeginPhase =
  "reserved" | "ref_bound" | "pending" | "terminal";

export type AgentGroupJoinBeginOperationIdentity = Readonly<{
  sessionId: string;
  scopeIdentity: string;
  groupRef: string;
  operationIdempotencyKey: string;
  operationRef: string;
  mutationInputDigest: string;
}>;

export function validAgentGroupJoinBeginReservationInput(input: HarnessAgentGroupJoinBeginReservation): boolean {
  return input.sessionId.length > 0 && input.scopeIdentity.length > 0 &&
    input.groupRef.length > 0 && input.pageCallIdentity.length > 0 &&
    input.requestIdempotencyKey.length > 0 && input.operationIdempotencyKey.length > 0 &&
    input.mutationInputDigest.length > 0;
}

export function validAgentGroupPageCallInput(input: HarnessAgentGroupPageCallBinding): boolean {
  return input.callIdentity.length > 0 && input.canonicalInputDigest.length > 0 &&
    input.requestIdempotencyKey.length > 0 &&
    (input.operationKind === "watch" || input.operationKind === "join" || input.operationKind === "cancel") &&
    Number.isSafeInteger(input.maximumChanges) && input.maximumChanges >= 1 &&
    Number.isSafeInteger(input.maximumBytes) && input.maximumBytes >= 1 &&
    Number.isSafeInteger(input.maximumCursorBytes) && input.maximumCursorBytes >= 1 &&
    ((input.requestedAfterSequence === undefined) === (input.pageCursorDigest === undefined)) &&
    (input.requestedAfterSequence === undefined ||
      (Number.isSafeInteger(input.requestedAfterSequence) && input.requestedAfterSequence >= 0)) &&
    (input.pageCursorDigest === undefined || input.pageCursorDigest.length > 0);
}

export function agentGroupJoinBeginReservationPhaseRank(phase: AgentGroupJoinBeginPhase): number {
  return phase === "reserved" ? 0 : phase === "ref_bound" ? 1 : phase === "pending" ? 2 : 3;
}

export function agentGroupJoinBeginReservationInputFromBinding(
  input: HarnessAgentGroupPendingOperationBinding | HarnessAgentGroupOperationResultBinding,
  operationIdempotencyKey: string, mutationInputDigest = input.mutationInputDigest,
): HarnessAgentGroupJoinBeginReservation | undefined {
  if (input.pageCallIdentity === undefined || input.requestIdempotencyKey === undefined) return undefined;
  return Object.freeze({
    sessionId: input.sessionId,
    scopeIdentity: input.scopeIdentity,
    groupRef: input.groupRef,
    pageCallIdentity: input.pageCallIdentity,
    requestIdempotencyKey: input.requestIdempotencyKey,
    operationIdempotencyKey,
    mutationInputDigest,
  });
}

export function agentGroupJoinBeginOperationIdentity(
  input: Pick<HarnessAgentGroupJoinBeginReservation, "sessionId" | "scopeIdentity" | "groupRef" |
    "operationIdempotencyKey" | "mutationInputDigest">, operationRef: string,
): AgentGroupJoinBeginOperationIdentity {
  return Object.freeze({
    sessionId: input.sessionId,
    scopeIdentity: input.scopeIdentity,
    groupRef: input.groupRef,
    operationIdempotencyKey: input.operationIdempotencyKey,
    operationRef,
    mutationInputDigest: input.mutationInputDigest,
  });
}

export function joinBeginReservationResult(
  record: Pick<HarnessAgentGroupJoinBeginReservationResult, "phase" | "operationRef">,
  outcome: HarnessAgentGroupJoinBeginReservationResult["outcome"],
): HarnessAgentGroupJoinBeginReservationResult {
  if (record.phase === "reserved") {
    return Object.freeze({
      outcome,
      phase: record.phase,
      ...(record.operationRef === undefined ? {} : { operationRef: record.operationRef }),
    });
  }
  if (typeof record.operationRef !== "string" || record.operationRef.length === 0) {
    throw new TypeError("Agent Group join reservation is missing its operation reference.");
  }
  return Object.freeze({ outcome, phase: record.phase, operationRef: record.operationRef });
}
