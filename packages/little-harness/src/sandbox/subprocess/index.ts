export {
  resolveSubprocessWorkerPath,
  subprocessSandbox,
  type SubprocessSandboxOptions,
} from "./subprocess-sandbox.js";
// The parent↔worker wire protocol (protocol.ts) is deliberately NOT re-exported: it is an
// internal implementation detail that must be free to evolve without a semver event.
