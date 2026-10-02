import { createJustBashRuntime } from "../runtime/just-bash-runtime.js";
import { subprocessSandbox } from "../sandbox/subprocess/subprocess-sandbox.js";
import type { HarnessExecutionEnvironmentFactory, HarnessRuntimeOptions } from "../types.js";

/**
 * How a host picks the execution environment for a turn.
 *
 * - `"in-process"` — always `createJustBashRuntime`. Fastest (no process spawn), but Tier-0
 *   just-bash embedded in the host process: a compatibility layer for trusted tool patterns,
 *   not an isolation boundary.
 * - `"subprocess"` — always `subprocessSandbox()` with its defaults. Pass
 *   `subprocessSandbox({ ... })` as the factory instead when the worker needs `workerPath`,
 *   `env`, or timeout overrides; the string form takes no options.
 * - `"auto"` — apply `selectExecutionEnvironmentMode` per turn. Recommended.
 */
export type HarnessExecutionEnvironmentMode = "auto" | "in-process" | "subprocess";

/**
 * The `"auto"` rule: stay in-process only for turns that cannot execute model-authored code
 * and cannot reach the network — every other turn is worth a process boundary, because only
 * the subprocess adapter has an empty environment, a SIGKILL watchdog, and just-bash's
 * defense-in-depth layer (see `defenseInDepthForAdapter`).
 *
 * just-bash enables python and javascript by default, so a caller who wants in-process under
 * `"auto"` must opt out of both explicitly. Doing so also drops the runtime tool bridge, which
 * only exists for js exec.
 */
export function selectExecutionEnvironmentMode(
  runtime: HarnessRuntimeOptions | undefined,
): Exclude<HarnessExecutionEnvironmentMode, "auto"> {
  const networkEnabled = runtime?.network !== undefined && runtime.network !== false;
  if (networkEnabled || runtime?.python !== false || runtime?.javascript !== false) {
    return "subprocess";
  }
  return "in-process";
}

/**
 * Resolves a host's configured execution environment for one turn. A factory is used as-is;
 * a mode is mapped to the matching built-in adapter.
 */
export function resolveExecutionEnvironment<TExtraBody>(
  selection:
    | HarnessExecutionEnvironmentMode
    | HarnessExecutionEnvironmentFactory<TExtraBody>
    | undefined,
  runtime: HarnessRuntimeOptions | undefined,
): HarnessExecutionEnvironmentFactory<TExtraBody> {
  if (typeof selection === "function") {
    return selection;
  }
  // Unset means "auto": in-process only for turns that can neither run model-authored code
  // nor reach the network, the subprocess sandbox otherwise.
  const requested = selection ?? "auto";
  const mode = requested === "auto" ? selectExecutionEnvironmentMode(runtime) : requested;
  return mode === "subprocess" ? subprocessSandbox() : createJustBashRuntime;
}
