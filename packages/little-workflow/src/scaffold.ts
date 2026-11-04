/** Public scaffold APIs. Callers never need private dist paths. */
export { initWorkflowProject, addWorkflowToProject, addHarnessToWorkflowProject } from "./cli/workflow-scaffold.js";
export { planSetup, type ResolvedSetupOptions, type SetupOptions } from "./cli/setup-plan.js";
export {
  applySetupPlan,
  recoverSetup,
  type ApplySetupOptions,
  type FileChange,
  type RecoverSetupOptions,
  type SetupPlan,
  type SetupRecoveryResult,
} from "./cli/setup-transaction.js";
