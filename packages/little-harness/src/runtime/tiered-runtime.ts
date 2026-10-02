import { HarnessInputError } from "../errors.js";
import type {
  CreateExecutionEnvironmentOptions,
  HarnessEvent,
  HarnessEventInput,
  HarnessExecutionEnvironmentFactory,
  HarnessRuntime,
  HarnessRuntimeOptions,
  HarnessWorkspaceSpec,
  JsonObject,
} from "../types.js";
import {
  classifyCommand,
  detectEmulationGap,
  type ClassificationReason,
  type CommandClassification,
  type Tier0ClassificationPolicy,
  type Tier0EmulationGap,
} from "./command-classification.js";
import { createJustBashRuntime } from "./just-bash-runtime.js";
import {
  createShellRuntime,
  emitTrackedMountFileChanges,
  snapshotTrackedMounts,
  type ShellCommandInput,
  type ShellCommandResult,
} from "./shell-runtime.js";
import type { Tier0CapabilityMatrix } from "./tier0-capability-matrix.js";

export type TieredExecutionEnvironmentOptions<TExtraBody = unknown> = {
  /**
   * The tier every command starts on. Defaults to `createJustBashRuntime` (in-process
   * just-bash), matching the package default; pass `subprocessSandbox()` for the hardened
   * Tier-0 adapter (see `defenseInDepthForAdapter`).
   */
  readonly tier0?: HarnessExecutionEnvironmentFactory<TExtraBody> | undefined;
  /**
   * The tier escalation switches to, provisioned lazily on the first escalation and never
   * before — a turn that never escalates never pays for it. When omitted, escalation is
   * permanently unavailable and commands that require it fail with a structured result
   * instead of running: a tiered environment without a higher tier is a misconfiguration,
   * not a silent downgrade to Tier-0.
   */
  readonly nextTier?: HarnessExecutionEnvironmentFactory<TExtraBody> | undefined;
  /** Caller policy for {@link classifyCommand}. Denied commands run on no tier at all. */
  readonly policy?: Tier0ClassificationPolicy | undefined;
  /** Pin the capability matrix (tests, or a host pinning an older matrix version). */
  readonly matrix?: Tier0CapabilityMatrix | undefined;
};

/** Which tier a command ran on. Recorded on tier events; never shown to the model. */
export type HarnessExecutionTier = "tier-0" | "next-tier";

/** The out-of-band events this layer adds to a turn's trace. Never model-visible. */
type HarnessTierEventType =
  | "harness.runtime.tier.escalated"
  | "harness.runtime.tier.unavailable"
  | "harness.runtime.command.denied";

/** Synthetic tool-call id for the state probe run on the outgoing tier at a switch. */
export const TIER_STATE_PROBE_TOOL_CALL_ID = "runtime_tier_probe";

/** Synthetic tool-call id for the env/cwd replay run on the incoming tier at a switch. */
export const TIER_CARRY_OVER_TOOL_CALL_ID = "runtime_tier_carry_over";

/**
 * Exit code for a command the tiered runtime refused to run — escalation required but
 * unavailable, or policy-denied. 126 is the shell's "found, but could not be executed",
 * which is exactly what happened: nothing ran.
 */
export const TIER_REFUSED_EXIT_CODE = 126;

/** Prefix on every stderr line this layer authors, so it can never read as shell output. */
const MESSAGE_PREFIX = "little-harness:";

/**
 * An execution environment that presents ONE runtime to the harness while owning a Tier-0
 * adapter and a lazily-provisioned higher tier behind it, switching between them mid-turn.
 *
 * The switch is invisible to the model. System hints come from the Tier-0 runtime verbatim
 * (they feed promptHash replay, so a tier switch must not change a single byte of the
 * prompt), and every command — whichever tier runs it — is traced by the one
 * `createShellRuntime` wrapped around the pair, so all tiers emit identical
 * `harness.runtime.command.*` events. Escalation itself is reported out-of-band on
 * `harness.runtime.tier.*` events, which the model never sees.
 *
 * Two independent signals move a turn up a tier:
 *
 * 1. **Classification, before anything runs.** `classifyCommand` reads the script's AST; a
 *    `"escalate"` decision switches tiers *before* the first side effect exists, which is
 *    the whole point of deciding statically — a script discovered to be unrunnable halfway
 *    through has already done half its work, and re-running it on the next tier repeats it.
 * 2. **Emulation-gap detection, after a Tier-0 run.** Classification cannot read
 *    `./build.sh` or model which flags each emulated command implements, so a finished
 *    Tier-0 result whose stderr shows just-bash missing a command or an option escalates
 *    and retries **the same command once**. That retry is the containment: stderr is
 *    script-writable, so a forged `bash: x: command not found` costs exactly one extra
 *    attempt and can never loop.
 *
 * Escalation is sticky: once a turn is on the higher tier every later command goes there,
 * because Tier-0 state has already been left behind and interleaving the two would make
 * `cd`/`export` semantics depend on which command the classifier happened to like.
 *
 * What crosses the switch is env + cwd, nothing else. just-bash resets shell state between
 * commands and carries it in the returned env, so exported variables and the working
 * directory are the entire durable surface; functions, aliases, and shell options do not
 * survive a command boundary on Tier-0 and therefore have nothing to carry.
 */
export function tieredExecutionEnvironment<TExtraBody = unknown>(
  tiers: TieredExecutionEnvironmentOptions<TExtraBody> = {},
): HarnessExecutionEnvironmentFactory<TExtraBody> {
  const tier0Factory = tiers.tier0 ?? createJustBashRuntime;
  return async (options) => {
    const innerOptions = subordinateTierOptions(options);
    const tier0 = tierExecutor(await tier0Factory(innerOptions));
    const tiering = createTierSwitch({
      tier0,
      innerOptions,
      nextTierFactory: tiers.nextTier,
      runtime: options.runtime,
      policy: tiers.policy,
      matrix: tiers.matrix,
      emit: options.emit,
    });

    const shell = createShellRuntime({
      workspace: options.workspace,
      ...(options.runtime === undefined ? {} : { runtime: options.runtime }),
      ...(options.emit === undefined ? {} : { emit: options.emit }),
      ...(options.emitToolEvents === undefined ? {} : { emitToolEvents: options.emitToolEvents }),
      ...(options.traceOptions === undefined ? {} : { traceOptions: options.traceOptions }),
      files: options.files,
      execute: (input, context) => tiering.execute(input, context.toolCallId),
    });

    return {
      // The prompt surface is Tier-0's, verbatim — never the active tier's. `shell` is
      // built without a tool bridge precisely because its own systemHints() is never
      // called: hints are the one thing a tier switch must not be able to change.
      systemHints: (hintOptions) => tier0.runtime.systemHints(hintOptions),
      shellTool: () => shell.shellTool(),
      dispose: () => disposeTiers(tiering, options),
    };
  };
}

/**
 * Event types the wrapping `createShellRuntime` owns. Subordinate tiers must not emit them
 * a second time — the trace records one command, not one per tier that touched it.
 *
 * The other duplicate source, `harness.file.*`, is removed structurally instead: subordinate
 * tiers receive a workspace with `trackChanges` stripped, so they neither emit file events
 * nor pay for the before/after folder scans around every command.
 */
const TIER_OWNED_EVENT_TYPES: ReadonlySet<string> = new Set([
  "harness.runtime.command.started",
  "harness.runtime.command.succeeded",
  "harness.runtime.command.failed",
]);

/**
 * Dispose the tiers, and report anything the teardown wrote to a tracked mount.
 *
 * A higher tier may do real filesystem work at dispose — a sandbox syncing its
 * workspace back to the host is the reason this exists — and that write happens
 * after the last command, so the per-command diff can never see it. Bracketing
 * the disposal is the only place it can be observed, and it has to happen HERE
 * rather than inside the tier: `subordinateTierOptions` strips `trackChanges`
 * before a sub-tier ever sees the workspace, so only this layer still knows
 * which mounts the host asked to have tracked.
 *
 * A turn that never escalated skips the bracket entirely. There is no higher
 * tier to have written anything, and the snapshot is an O(workspace) read that
 * the default Tier-0-only path must not pay twice.
 *
 * The diff runs even when disposal throws, because a partial sync-back is
 * exactly the case a reader needs to see, and it never masks the disposal error.
 */
async function disposeTiers<TExtraBody>(
  tiering: { escalated(): boolean; dispose(): Promise<void> },
  options: CreateExecutionEnvironmentOptions<TExtraBody>,
): Promise<void> {
  const emit = options.emit;
  // Snapshotting reads every file under every tracked mount, so a turn that
  // never left Tier 0 must not pay for it: only a higher tier that was actually
  // built can write at dispose, and Tier-0's own writes were already reported
  // per command.
  if (emit === undefined || !tiering.escalated()) {
    await tiering.dispose();
    return;
  }
  // A snapshot that fails (an unreadable file, a file deleted mid-scan) must not skip the
  // disposal below, or every tier would leak; it only costs the sync-back diff.
  const before = await snapshotTrackedMounts(options.workspace).catch(() => undefined);
  if (before === undefined) {
    await tiering.dispose();
    return;
  }
  try {
    await tiering.dispose();
  } finally {
    await emitTrackedMountFileChanges({
      workspace: options.workspace,
      before,
      emit,
      files: options.files,
      ...(options.traceOptions === undefined
        ? {}
        : { traceOptions: options.traceOptions }),
    }).catch(() => undefined);
  }
}

/**
 * The options a tier runs under: the caller's, minus the observability the wrapper owns.
 * Tool-bridge events still flow — a js-exec tool call made inside a tier is that tier's
 * event to report, and no outer layer duplicates it.
 */
function subordinateTierOptions<TExtraBody>(
  options: CreateExecutionEnvironmentOptions<TExtraBody>,
): CreateExecutionEnvironmentOptions<TExtraBody> {
  const emit = options.emit;
  return {
    ...options,
    workspace: untrackedWorkspace(options.workspace),
    emitToolEvents: false,
    ...(emit === undefined
      ? {}
      : {
          emit: async (event: HarnessEventInput) =>
            TIER_OWNED_EVENT_TYPES.has(event.type) ? undefined : emit(event),
        }),
  };
}

function untrackedWorkspace(workspace: HarnessWorkspaceSpec): HarnessWorkspaceSpec {
  return {
    ...workspace,
    mounts: workspace.mounts.map(({ trackChanges: _tracked, ...mount }) => mount),
  };
}

/** One tier, reduced to the only thing the switch needs from it: a command executor. */
type TierExecutor = {
  readonly runtime: HarnessRuntime;
  execute(input: ShellCommandInput, toolCallId: string): Promise<ShellCommandResult>;
};

/**
 * Adapts an execution-environment runtime to the executor port by calling its `bash` tool
 * directly. Going through the tool (rather than a private executor hook) is what lets any
 * `HarnessExecutionEnvironmentFactory` — including a remote or compute-backed one from
 * another package — be a tier without implementing anything extra.
 */
function tierExecutor(runtime: HarnessRuntime): TierExecutor {
  const shell = runtime.shellTool();
  const execute = (shell as { execute?: unknown }).execute;
  if (typeof execute !== "function") {
    throw new HarnessInputError("Execution tier returned a shell tool with no execute implementation.");
  }
  const call = execute.bind(shell) as (input: ShellCommandInput, options: unknown) => Promise<unknown>;
  return {
    runtime,
    async execute(input, toolCallId) {
      return shellCommandResult(await call(input, { toolCallId, messages: [] }));
    },
  };
}

function shellCommandResult(value: unknown): ShellCommandResult {
  const result = value as Partial<ShellCommandResult> | undefined;
  if (
    typeof result?.stdout !== "string" ||
    typeof result.stderr !== "string" ||
    typeof result.exitCode !== "number"
  ) {
    throw new HarnessInputError("Execution tier returned a non-shell result.");
  }
  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
}

type NextTierState =
  | { readonly status: "unprovisioned" }
  | { readonly status: "ready"; readonly tier: TierExecutor }
  | { readonly status: "unavailable"; readonly detail: string };

type ProvisionResult = { ok: true; tier: TierExecutor } | { ok: false; detail: string };

type EscalationTrigger = "classification" | "emulation-gap";

type EscalationCause = {
  readonly trigger: EscalationTrigger;
  readonly command: string;
  readonly classification?: CommandClassification | undefined;
  readonly gap?: Tier0EmulationGap | undefined;
};

type CreateTierSwitchOptions<TExtraBody> = {
  readonly tier0: TierExecutor;
  readonly innerOptions: CreateExecutionEnvironmentOptions<TExtraBody>;
  readonly nextTierFactory: HarnessExecutionEnvironmentFactory<TExtraBody> | undefined;
  readonly runtime: HarnessRuntimeOptions | undefined;
  readonly policy: Tier0ClassificationPolicy | undefined;
  readonly matrix: Tier0CapabilityMatrix | undefined;
  readonly emit: ((event: HarnessEventInput) => Promise<HarnessEvent | void>) | undefined;
};

/**
 * The escalation state machine for one turn.
 *
 * ```
 *              classify: escalate            provision ok
 *   [tier-0] ────────────────────────▶ (provision) ──────────▶ [next-tier]  (sticky)
 *      │  ▲                                  │
 *      │  │ gap detected, retry once         │ provision failed
 *      │  └──────────────────────────────────┤
 *      │                                     ▼
 *      └──────────────────────────────▶ [unavailable] ──▶ Tier-0 keeps serving
 *                                                          "run" commands; anything
 *                                                          needing escalation is refused
 * ```
 *
 * `(provision)` is single-flight and both outcomes are sticky for the turn: a tier is
 * built at most once, and one that failed is not retried command after command.
 */
function createTierSwitch<TExtraBody>(options: CreateTierSwitchOptions<TExtraBody>): {
  execute(input: ShellCommandInput, toolCallId: string): Promise<ShellCommandResult>;
  /** Whether a higher tier was actually built, and so could write at dispose. */
  escalated(): boolean;
  dispose(): Promise<void>;
} {
  const policyDenies = (options.policy?.denyCommands?.length ?? 0) > 0;
  let active: HarnessExecutionTier = "tier-0";
  let tier0Executed = false;
  let next: NextTierState = { status: "unprovisioned" };
  let provisioning: Promise<ProvisionResult> | undefined;

  const emit = async (type: HarnessTierEventType, metadata: JsonObject): Promise<void> => {
    await options.emit?.({ type, metadata });
  };

  const classify = (command: string): CommandClassification | undefined => {
    // On the higher tier the verdict can only matter for policy: everything else the
    // classifier reports is about Tier-0's capabilities, which no longer apply.
    if (active !== "tier-0" && !policyDenies) {
      return undefined;
    }
    return classifyCommand(command, {
      runtime: options.runtime,
      policy: options.policy,
      matrix: options.matrix,
    });
  };

  const provision = async (): Promise<ProvisionResult> => {
    if (options.nextTierFactory === undefined) {
      return { ok: false, detail: "no higher execution tier is configured" };
    }
    // Read the outgoing tier's state BEFORE the incoming one exists, and only when it has
    // actually run something — a turn that escalates on its first command has nothing to
    // carry, and probing would spawn a Tier-0 worker for no reason.
    const carried = tier0Executed ? await captureShellState(options.tier0) : undefined;
    let tier: TierExecutor;
    try {
      tier = tierExecutor(await options.nextTierFactory(options.innerOptions));
    } catch (error) {
      return { ok: false, detail: `the higher tier could not be provisioned: ${describeError(error)}` };
    }
    if (carried !== undefined) {
      const replay = await applyShellState(tier, carried);
      if (!replay.ok) {
        await disposeRuntime(tier.runtime);
        return { ok: false, detail: `the higher tier could not be prepared: ${replay.detail}` };
      }
    }
    return { ok: true, tier };
  };

  const escalate = async (cause: EscalationCause): Promise<{ ok: boolean; detail: string }> => {
    if (next.status === "unprovisioned") {
      // Single-flight: a step's bash calls run concurrently, so two commands can decide to
      // escalate before either has provisioned. Sharing the one in-flight attempt is what
      // keeps that from building — and leaking — a second execution environment.
      provisioning ??= provision().catch((error: unknown) => ({
        ok: false as const,
        detail: `the higher tier could not be provisioned: ${describeError(error)}`,
      }));
      const provisioned = await provisioning;
      if (next.status === "unprovisioned") {
        next = provisioned.ok
          ? { status: "ready", tier: provisioned.tier }
          : { status: "unavailable", detail: provisioned.detail };
      }
    }
    if (next.status === "unavailable") {
      await emit("harness.runtime.tier.unavailable", { ...causeMetadata(cause), detail: next.detail });
      return { ok: false, detail: next.detail };
    }
    if (active === "tier-0") {
      // One switch, one event: a second command that reached the same conclusion joined a
      // switch that already happened rather than causing another.
      active = "next-tier";
      await emit("harness.runtime.tier.escalated", causeMetadata(cause));
    }
    return { ok: true, detail: "" };
  };

  const runOnActiveTier = async (
    input: ShellCommandInput,
    toolCallId: string,
  ): Promise<ShellCommandResult> => {
    if (active === "tier-0") {
      tier0Executed = true;
      return runOnTier(options.tier0, input, toolCallId);
    }
    const tier = next.status === "ready" ? next.tier : undefined;
    if (tier === undefined) {
      // Unreachable: `active` only leaves "tier-0" after a successful provision.
      return refusal("the higher tier is no longer available");
    }
    return runOnTier(tier, input, toolCallId);
  };

  return {
    async execute(input, toolCallId) {
      const classification = classify(input.command);
      if (classification?.decision === "deny") {
        await emit("harness.runtime.command.denied", {
          command: input.command,
          reasons: classification.reasons,
        });
        return refusal(`blocked by policy (${describeReasons(classification.reasons)})`);
      }

      if (classification?.decision === "escalate" && active === "tier-0") {
        const escalated = await escalate({
          trigger: "classification",
          command: input.command,
          classification,
        });
        if (!escalated.ok) {
          // Nothing has run: the whole point of classifying first is that refusing here
          // costs no side effects.
          return refusal(
            `needs a higher execution tier (${describeReasons(classification.reasons)}), ` +
              `but escalation is unavailable — ${escalated.detail}`,
          );
        }
      }

      const ranOnTier0 = active === "tier-0";
      const result = await runOnActiveTier(input, toolCallId);
      if (!ranOnTier0) {
        return result;
      }

      const gap = detectEmulationGap(result, { matrix: options.matrix });
      if (gap === undefined) {
        return result;
      }
      const escalated = await escalate({ trigger: "emulation-gap", command: input.command, gap });
      if (!escalated.ok) {
        // The command already ran; its real result beats a synthesized error.
        return result;
      }
      // Exactly one retry per command, structurally: the retry's own stderr is returned
      // unexamined, so a script that prints gap lines forever still escalates only once.
      return runOnActiveTier(input, toolCallId);
    },
    escalated: () => next.status === "ready",
    async dispose() {
      const tier = next.status === "ready" ? next.tier : undefined;
      try {
        if (tier !== undefined) {
          await disposeRuntime(tier.runtime, { rethrow: true });
        }
      } finally {
        await disposeRuntime(options.tier0.runtime, { rethrow: true });
      }
    },
  };
}

async function runOnTier(
  tier: TierExecutor,
  input: ShellCommandInput,
  toolCallId: string,
): Promise<ShellCommandResult> {
  try {
    return await tier.execute(input, toolCallId);
  } catch (error) {
    // The shell port's contract is a result, never a throw — an adapter that breaks it
    // must not take the turn down with it.
    return {
      stdout: "",
      stderr: `${MESSAGE_PREFIX} the execution tier failed to run this command: ${describeError(error)}\n`,
      exitCode: 1,
    };
  }
}

function refusal(reason: string): ShellCommandResult {
  return {
    stdout: "",
    stderr: `${MESSAGE_PREFIX} this command was not executed: ${reason}.\n`,
    exitCode: TIER_REFUSED_EXIT_CODE,
  };
}

function causeMetadata(cause: EscalationCause): JsonObject {
  return {
    from: "tier-0",
    to: "next-tier",
    trigger: cause.trigger,
    command: cause.command,
    ...(cause.classification === undefined
      ? {}
      : { decision: cause.classification.decision, reasons: cause.classification.reasons }),
    ...(cause.gap === undefined ? {} : { gap: cause.gap }),
  };
}

/** Human-readable escalation causes for the one place a refusal reaches the model. */
function describeReasons(reasons: readonly ClassificationReason[]): string {
  const described = reasons.map(describeReason).filter((text): text is string => text !== undefined);
  return described.length === 0 ? "no Tier-0 capability for this script" : described.join("; ");
}

function describeReason(reason: ClassificationReason): string | undefined {
  switch (reason.kind) {
    case "needs-real-exec":
      return `${reason.command} needs a real execution environment (${reason.reason})`;
    case "unknown-command":
      return `${reason.command} is not available on this tier`;
    case "capability-disabled":
      return `${reason.command} needs the ${reason.capability} runtime capability`;
    case "policy-blocked":
      return `${reason.command} is denied by ${reason.rule}`;
    case "dynamic-command":
      return `the command name ${reason.source} cannot be read before running`;
    case "parse-failed":
      return `the script could not be parsed (${reason.message})`;
    case "classifier-unavailable":
      return `classification is unavailable (${reason.detail})`;
    case "tier0-supported":
    case "empty-script":
    case "opaque-script":
      return undefined;
  }
}

/** Everything that survives a tier switch. */
type TierShellState = {
  readonly cwd: string;
  readonly env: ReadonlyMap<string, string>;
};

/**
 * `pwd` then `export -p`: the working directory and the variables the turn exported, read
 * through the same shell port every tier already implements rather than through adapter
 * internals — so a tier this package has never seen can still hand its state over.
 */
const STATE_PROBE_COMMAND = "pwd\nexport -p";

/**
 * `export -p` prints one `declare -x NAME="value"` line per exported variable, with `"` and
 * `\` backslash-escaped inside the quotes (bash also escapes `$` and a backtick; the
 * unescape below is generic, so it covers both). Exported-but-unset variables print without
 * a value and are skipped, as is any value containing a newline — it would span lines and
 * cannot be read back reliably. Losing such a variable degrades the carry-over; it can
 * never inject a command, because every replayed value is single-quoted.
 */
const EXPORT_LINE = /^declare -x ([A-Za-z_][A-Za-z0-9_]*)="(.*)"$/u;

/**
 * Names the tier itself owns. Carrying just-bash's `PATH=/usr/bin:/bin` or `HOME=/` into a
 * real execution environment would describe a machine that does not exist; `PWD`/`OLDPWD`
 * are replayed as a `cd` instead. A script that exports one of these deliberately loses it
 * — the alternative is handing the next tier a false description of itself.
 */
const TIER_OWNED_ENV_NAMES: ReadonlySet<string> = new Set([
  "HOME",
  "IFS",
  "OLDPWD",
  "PATH",
  "PWD",
  "SHELL",
  "SHLVL",
  "_",
]);

async function captureShellState(tier: TierExecutor): Promise<TierShellState | undefined> {
  const result = await runOnTier(tier, { command: STATE_PROBE_COMMAND }, TIER_STATE_PROBE_TOOL_CALL_ID);
  if (result.exitCode !== 0) {
    return undefined;
  }
  const [cwd, ...lines] = result.stdout.split("\n");
  if (cwd === undefined || !cwd.startsWith("/")) {
    return undefined;
  }
  const env = new Map<string, string>();
  for (const line of lines) {
    const match = EXPORT_LINE.exec(line);
    const name = match?.[1];
    const value = match?.[2];
    if (name === undefined || value === undefined || TIER_OWNED_ENV_NAMES.has(name)) {
      continue;
    }
    env.set(name, value.replace(/\\(.)/gu, "$1"));
  }
  return { cwd, env };
}

async function applyShellState(
  tier: TierExecutor,
  state: TierShellState,
): Promise<{ ok: true } | { ok: false; detail: string }> {
  const script = [
    `cd ${singleQuote(state.cwd)}`,
    ...[...state.env].map(([name, value]) => `export ${name}=${singleQuote(value)}`),
  ].join("\n");
  const result = await runOnTier(tier, { command: script }, TIER_CARRY_OVER_TOOL_CALL_ID);
  if (result.exitCode !== 0) {
    // Refusing to switch is the conservative read: a working directory that does not exist
    // on the higher tier means the command would run somewhere else entirely.
    return { ok: false, detail: `${state.cwd} could not be entered (${result.stderr.trim()})` };
  }
  return { ok: true };
}

function singleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function disposeRuntime(runtime: HarnessRuntime, options?: { rethrow?: boolean }): Promise<void> {
  try {
    await runtime.dispose?.();
  } catch (error) {
    if (options?.rethrow === true) {
      throw error;
    }
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
