/**
 * `@little-stack/harness/sandbox`: for writing your own sandbox. The shell runtime, the tool bridges,
 * the just-bash building blocks and the tier-0 command classification. The ready-made sandboxes
 * (`justBashSandbox`, `tieredSandbox`, `subprocessSandbox`) stay on the package root.
 */
export { localSessionWorkspace } from "./local-host/workspace-spec.js";
export {
  resolveSandbox,
  selectSandboxMode,
  type HarnessSandboxMode,
} from "./local-host/execution-environment.js";
export {
  bashOptionsForRuntime,
  buildWorkspaceFs,
  createEnvironmentToolBridge,
  defenseInDepthForAdapter,
  execBashSafely,
  type JustBashAdapter,
} from "./runtime/just-bash-runtime.js";
export {
  classifyCommand,
  detectEmulationGap,
  tier0RuntimeCapabilities,
  type ClassificationDecision,
  type ClassificationReason,
  type ClassifyCommandOptions,
  type CommandClassification,
  type Tier0ClassificationPolicy,
  type Tier0EmulationGap,
  type Tier0RuntimeCapabilities,
} from "./runtime/command-classification.js";
export {
  TIER0_ALWAYS_COMMANDS_SNAPSHOT,
  TIER0_BUILTINS,
  TIER0_EMULATOR,
  TIER0_JAVASCRIPT_COMMANDS_SNAPSHOT,
  TIER0_MATRIX_SCHEMA_VERSION,
  TIER0_MATRIX_VERSION,
  TIER0_NEEDS_REAL_EXEC,
  TIER0_NETWORK_COMMANDS_SNAPSHOT,
  TIER0_PYTHON_COMMANDS_SNAPSHOT,
  TIER0_UNIMPLEMENTED_BUILTINS,
  tier0CapabilityMatrix,
  type Tier0Capability,
  type Tier0CapabilityMatrix,
  type Tier0RealExecReason,
} from "./runtime/tier0-capability-matrix.js";
export {
  createRuntimeToolBridge,
  type RuntimeToolBridge,
  type RuntimeToolBridgeOptions,
} from "./runtime/tool-bridge.js";
export {
  createShellRuntime,
  emitTrackedMountFileChanges,
  snapshotTrackedMounts,
  type CreateShellRuntimeOptions,
  type ShellCommandInput,
  type ShellCommandResult,
  type TrackedMountSnapshot,
} from "./runtime/shell-runtime.js";
export { TIER_REFUSED_EXIT_CODE } from "./runtime/tiered-runtime.js";
export { resolveSubprocessWorkerPath } from "./sandbox/subprocess/subprocess-sandbox.js";
export { resolveTraceOptions } from "./trace/options.js";
export type { ResolvedHarnessTraceOptions } from "./trace/types.js";
