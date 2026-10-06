/** Public scaffold APIs. Callers never need private dist paths. */
export { initWorkflowProject, addWorkflowToProject, addHarnessToWorkflowProject } from "./cli/workflow-scaffold.js";
export { planSetup, type SetupOptions } from "./cli/setup-plan.js";
export { applySetupPlan, rollbackSetup, type SetupPlan, type FileChange } from "./cli/setup-transaction.js";
