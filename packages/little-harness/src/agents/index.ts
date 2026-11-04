/**
 * Agent Groups (experimental): the port a parallel-agent launcher implements, its protocol
 * types and errors, and the task-ledger projections a custom orchestration store needs.
 *
 * App code only passes `createHarness({ agents: { launcher, … } })`; the launcher itself comes
 * from an adapter such as Little Compute's `littleComputeAgentGroups()`. Import from
 * `@little-stack/harness/agents` when you implement a launcher or a ledger. This entry may
 * change between alpha releases.
 */
export type * from "./types.js";
export {
  HARNESS_AGENT_GROUP_PAGES_PROTOCOL_VERSION,
  HARNESS_AGENT_GROUPS_PROTOCOL_VERSION,
  HarnessAgentGroupCursorError,
  HarnessAgentGroupLaunchRejectedError,
  HarnessAgentGroupPageCallLimitError,
} from "./types.js";
export type {
  HarnessAgentGroupObservationProjection,
  HarnessAgentGroupObservationProjectionResult,
  HarnessAgentGroupChangeProjection,
  HarnessAgentGroupControlChangeProjection,
  HarnessAgentGroupMemberChangeProjection,
  HarnessAgentGroupOperationResultBinding,
  HarnessAgentGroupOperationResultBindingResult,
  HarnessAgentGroupPageCallBinding,
  HarnessAgentGroupPageCallBindingResult,
  HarnessAgentGroupJoinBeginReservation,
  HarnessAgentGroupJoinBeginReservationResult,
  HarnessAgentGroupPendingOperationBinding,
  HarnessAgentGroupPendingOperationBindingResult,
  HarnessAgentGroupGarbageCollectionResult,
  HarnessAgentGroupPageProjection,
  HarnessAgentGroupPageProjectionResult,
  HarnessAgentGroupPageState,
  HarnessAgentGroupStartBinding,
  HarnessAgentGroupStartBindingResult,
  HarnessAgentGroupTaskBatchReservation,
  HarnessAgentGroupTaskBatchReservationResult,
  HarnessAgentMemberObservationProjection,
} from "../tasks/ledger.js";
