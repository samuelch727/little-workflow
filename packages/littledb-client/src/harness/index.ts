// `@little-stack/littledb/harness`: the Little Harness pieces on their own, for hosts that wire
// the transport themselves. Most apps use `createLittleDB(...).harnessTracer`,
// `.agentWorkflowRegistry` and `.outcomeSink` from the package root instead.
export {
  createHarnessTracer,
  turnTraceId,
  type HarnessEventLike,
  type HarnessTracer,
  type HarnessTracerOptions,
} from "./tracer.js";
export {
  createOutcomeSink,
  outcomeFeedback,
  outcomeFeedbackId,
  type HarnessOutcomeEventLike,
  type LittleDBOutcomeSink,
  type OutcomeSinkOptions,
} from "./outcome-sink.js";
export {
  createAgentWorkflowRegistry,
  pickDefinition,
  trialArmFor,
  type AgentWorkflowDefinitionLike,
  type AgentWorkflowRunLike,
  type AgentWorkflowRecordLike,
  type AgentWorkflowRegistryContextLike,
  type AgentWorkflowRegistryOptions,
  type LittleDBAgentWorkflowOffer,
  type LittleDBAgentWorkflowRegistry,
  type LittleDBWorkflowVersion,
} from "./registry.js";
