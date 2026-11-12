import { isStepCount, type ToolSet } from "ai";
import type {
  HarnessAgentOptions,
  HarnessEventInput,
  HarnessTurnContext,
  ResolvedHarnessConfig,
} from "../types.js";
import { HarnessInputError } from "../errors.js";
import {
  assertSnapshotRegistry,
  type HarnessExecutionSnapshot,
  type SnapshotEvent,
} from "../execution-snapshot.js";
import { digest, json, object, parseHarnessFiles } from "../harness-contract-v1/harness.js";
import type { HarnessTurnLimits } from "./turn-limits.js";

const STATE = Symbol("harness.executionSnapshot");
type Config = ResolvedHarnessConfig<ToolSet, unknown>;
type Turn = HarnessAgentOptions & { harness: { config: unknown }; turnPin?: unknown };
type State = {
  snapshot: HarnessExecutionSnapshot;
  registry: NonNullable<Config["executionRegistry"]>;
  tools: ToolSet;
  pending: SnapshotEvent[];
  emit: (event: SnapshotEvent) => Promise<void>;
};
export const snapshotState = (turn: unknown): State | undefined =>
  (turn as { [STATE]?: State })[STATE];
function fail(message: string): never {
  throw new HarnessInputError(message);
}

function limits(
  owner: HarnessTurnLimits | undefined,
  requested: HarnessTurnLimits | undefined,
  hook?: unknown,
): HarnessTurnLimits {
  const out = { ...owner };
  for (const source of [requested, hook]) {
    if (source === undefined) continue;
    const raw = object(source, "/turnLimits");
    if (source === hook) object(raw, "/turnLimits", ["maxSteps", "maxCostUsd", "deadlineMs"]);
    for (const key of ["accounting", "price", "refusedBeforeEffect"] as const)
      if (key in raw && raw[key] !== owner?.[key]) fail(`Snapshot cannot replace owner ${key}.`);
    for (const key of ["maxSteps", "maxCostUsd", "deadlineMs"] as const) {
      const value = raw[key];
      if (value === undefined) continue;
      if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        value <= 0 ||
        (key !== "maxCostUsd" && !Number.isSafeInteger(value))
      )
        fail(`Invalid snapshot ${key}.`);
      out[key] = Math.min(out[key] ?? Infinity, value);
    }
  }
  return out;
}

/** Prepare immutable turn-local data before any runtime, remote source or model is opened. */
export async function prepareSnapshotTurn<T extends Turn>(
  turn: T,
  resumed?: HarnessTurnContext["resumed"],
): Promise<T> {
  const config = turn.harness.config as Config;
  const resumedPin =
    resumed?.pin && typeof resumed.pin === "object"
      ? (resumed.pin as Record<string, unknown>).harnessSnapshot
      : undefined;
  const candidate = turn.executionSnapshot ?? resumedPin;
  if (candidate === undefined) return turn;
  const registry = config.executionRegistry;
  assertSnapshotRegistry(registry);
  const model = turn.model ?? config.model;
  if (!model || typeof model === "string")
    fail("Snapshots require a concrete installed model handle.");
  const { snapshot } = await registry.verify(candidate, model);
  const sameLimits = (value: HarnessTurnLimits | undefined) =>
    value === undefined ||
    ["maxSteps", "maxCostUsd", "deadlineMs", "accounting", "price", "refusedBeforeEffect"].every(
      (key) =>
        value[key as keyof HarnessTurnLimits] ===
        registry.ownerLimits[key as keyof HarnessTurnLimits],
    );
  if (!sameLimits(config.turnLimits) || !sameLimits(turn.turnLimits))
    fail(
      "Snapshot ceilings must match the installed registry. Tighten them through a registered hook.",
    );
  if (registry.ownerLimits.maxSteps > (config.workflowBudgets?.maxModelSteps ?? 20))
    fail("The installed snapshot step ceiling exceeds the host's model-step ceiling.");
  if (
    turn.prepareStep ||
    turn.stopWhen ||
    turn.providerOptions ||
    turn.headers ||
    turn.toolChoice ||
    (turn.maxRetries !== undefined && turn.maxRetries !== 0) ||
    (turn.temperature !== undefined && turn.temperature !== snapshot.content.temperature)
  )
    fail("Snapshot loop/model overrides must be installed or versioned, not changed on the call.");
  if (resumedPin !== undefined && digest(resumedPin) !== digest(snapshot))
    fail("A parked snapshot cannot change.");
  const runtime = { ...config.runtime, ...turn.runtime };
  if (
    runtime.bash !== false ||
    config.mcp ||
    config.workflows?.length ||
    config.dynamicWorkflows ||
    config.agents ||
    config.checkpoints ||
    (config.humanInput && config.humanInput.tool !== false) ||
    config.skills.length ||
    config.memory.length ||
    (turn as { type?: unknown }).type !== undefined
  )
    fail(
      "Snapshot v1 currently qualifies inline skills and installed tools with bash:false; MCP, workflows, agents, checkpoints, model-facing humanInput, memory, external skills and typed input require further qualification.",
    );
  if (turn.system !== undefined && turn.system !== snapshot.content.system)
    fail("A call cannot replace the snapshot system.");
  if (
    config.system !== undefined &&
    config.system !== "" &&
    config.system !== snapshot.content.system
  )
    fail("Install protected system rules in the owner envelope before using snapshots.");
  await registry.assertTools(config.tools);
  const pending: SnapshotEvent[] = [];
  const state: State = {
    snapshot,
    registry,
    tools: {},
    pending,
    emit: async (event) => {
      pending.push(event);
    },
  };
  const emit = (event: SnapshotEvent) => state.emit(event);
  state.tools = await registry.tools(snapshot, emit, config.tools);
  const enabled = Object.keys(state.tools);
  const active = turn.activeTools ?? enabled;
  if (active.length !== enabled.length || new Set(active).size !== enabled.length)
    fail("Select optional tools in the admitted snapshot before hashing it.");
  if (
    active.some((name) => !enabled.includes(name)) ||
    registry.requiredTools.some((name) => !active.includes(name))
  )
    fail("Active tools must remain inside the snapshot and include all owner-required tools.");
  const required = registry.requiredTools;
  const checkedStep = (value: unknown, messages: unknown) => {
    if (value === undefined) return {};
    const raw = object(value, "/prepareStep", ["activeTools", "messages", "toolChoice"]);
    if (
      raw.toolChoice !== undefined &&
      !["auto", "none", "required"].includes(raw.toolChoice as string)
    ) {
      const choice = object(raw.toolChoice, "/prepareStep/toolChoice", ["type", "toolName"]);
      const scope = raw.activeTools ?? active;
      if (
        choice.type !== "tool" ||
        typeof choice.toolName !== "string" ||
        !Array.isArray(scope) ||
        !scope.includes(choice.toolName)
      )
        fail("Hook tool choice is outside the current snapshot scope.");
    }
    if (
      raw.activeTools !== undefined &&
      (!Array.isArray(raw.activeTools) ||
        raw.activeTools.some((name) => typeof name !== "string" || !active.includes(name)) ||
        required.some((name) => !(raw.activeTools as string[]).includes(name)))
    )
      fail("Hook removed required tools or selected a tool outside caller scope.");
    if (raw.messages !== undefined) {
      if (!Array.isArray(raw.messages) || !Array.isArray(messages))
        fail("Invalid compaction messages.");
      // This slice supports pruning only. No injected/reordered/system message can weaken owner rules.
      let cursor = 0;
      for (const message of raw.messages) {
        const hash = digest(message);
        while (cursor < messages.length && digest(messages[cursor]) !== hash) cursor++;
        if (cursor === messages.length || (message as { role?: unknown }).role === "system")
          fail("Hook messages must be an ordered subset of this step's messages.");
        cursor++;
      }
    }
    return raw;
  };
  const hookLimits = await registry.hook(snapshot, "turnLimits", {}, emit, (value) => {
    limits(registry.ownerLimits, undefined, value);
    return value;
  });
  const out = {
    ...turn,
    [STATE]: state,
    executionSnapshot: snapshot,
    system: registry.render(snapshot),
    activeTools: [...active],
    turnLimits: limits(registry.ownerLimits, undefined, hookLimits),
    maxRetries: 0,
    turnPin: {
      ...(turn.turnPin === undefined ? {} : object(turn.turnPin, "/pin")),
      harnessSnapshot: snapshot,
    },
    prepareStep: async (event: Parameters<NonNullable<HarnessAgentOptions["prepareStep"]>>[0]) => {
      await registry.current(snapshot);
      let result: Record<string, unknown> = {};
      for (const slot of ["compaction", "prepareStep"] as const) {
        const selected = await registry.hook(
          snapshot,
          slot,
          { messages: result.messages ?? event.messages, stepNumber: event.stepNumber },
          emit,
          (value) => checkedStep(value, result.messages ?? event.messages),
        );
        if (selected !== undefined) result = { ...result, ...(selected as object) };
      }
      return result as Awaited<ReturnType<NonNullable<HarnessAgentOptions["prepareStep"]>>>;
    },
    stopWhen: [
      isStepCount(registry.ownerLimits.maxSteps),
      async (event: { steps: unknown[] }) =>
        (await registry.hook(
          snapshot,
          "stopWhen",
          { stepCount: event.steps.length },
          emit,
          (value) => {
            if (typeof value !== "boolean") fail("stopWhen hooks must return a boolean.");
            return value;
          },
        )) === true,
    ],
  };
  return out as T;
}

export function snapshotConfig<T extends { tools: ToolSet; skills: unknown }>(
  config: T,
  turn: unknown,
): T {
  const state = snapshotState(turn);
  return state === undefined ? config : { ...config, tools: state.tools, skills: [] };
}
export async function bindSnapshotEvents(
  turn: unknown,
  emit: (event: HarnessEventInput) => Promise<unknown>,
): Promise<void> {
  const state = snapshotState(turn);
  if (!state) return;
  state.emit = async (event) => {
    await emit(event);
  };
  for (const event of state.pending.splice(0)) await state.emit(event);
  for (const warning of state.snapshot.warnings)
    await state.emit({
      type: "harness.snapshot.warning",
      metadata: { ...warning, executionHash: state.snapshot.executionHash },
    });
  await state.emit({
    type: "harness.snapshot.catalog_presented",
    metadata: {
      executionHash: state.snapshot.executionHash,
      registryHash: state.snapshot.registryHash,
      envelopeHash: state.snapshot.envelopeHash,
      contentHash: digest(state.snapshot.content),
      pins: json(state.snapshot.pins),
      tools: Object.keys(state.tools),
      files: json(parseHarnessFiles(state.snapshot.content.files).manifest),
      complete: true,
    },
  });
}
export async function guardSnapshotInvocation(turn: unknown): Promise<void> {
  const state = snapshotState(turn);
  if (!state) return;
  await state.registry.verify(
    state.snapshot,
    (turn as Turn).model ?? ((turn as Turn).harness.config as Config).model!,
  );
  await state.registry.assertTools(((turn as Turn).harness.config as Config).tools);
}
