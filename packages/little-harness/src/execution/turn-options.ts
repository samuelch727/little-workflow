import type {
  HarnessAgentOptions,
  HarnessEvent,
  HarnessSession,
  HarnessTrigger,
  HarnessTurnContext,
  HarnessTurnMetadata,
  HarnessTurnOptions,
} from "../types.js";

/** The turn options a `generateHarness` or `streamHarness` call reads: the per-run overrides and `onEvent`. */
type TurnCallOptions = HarnessAgentOptions & {
  harness: { config: { turnOptions?: HarnessTurnOptions<any> | undefined } };
  extraBody?: unknown;
  trigger?: HarnessTrigger | undefined;
  onEvent?: ((event: HarnessEvent) => void | Promise<void>) | undefined;
};

const OVERRIDE_KEYS = [
  "model",
  "system",
  "temperature",
  "stopWhen",
  "prepareStep",
  "toolChoice",
  "activeTools",
  "providerOptions",
  "headers",
  "maxRetries",
  "toolResultSpooling",
  "turnLimits",
] as const satisfies readonly (keyof HarnessAgentOptions)[];

/** What the hook said about the turn, kept with the turn's options. */
export type TurnDecision = {
  readonly turnMetadata?: HarnessTurnMetadata;
  readonly turnPin?: unknown;
};

/**
 * Apply the harness's `turnOptions` hook to one turn, after its session is known and before
 * anything runs. What the call passed wins over what the hook returned; `runtime` and `trace`
 * merge with the call's on top, and both `onEvent`s run, the hook's first. A continued turn's
 * hook gets the parked turn's `pin` and `metadata` in `resumed`, and keeps them when it returns
 * none of its own.
 */
export async function withTurnOptions<T extends TurnCallOptions>(
  options: T,
  session: HarnessSession,
  resumed?: HarnessTurnContext["resumed"],
): Promise<T & TurnDecision> {
  const hook = options.harness.config.turnOptions;
  const kept = decision(resumed?.metadata, resumed?.pin);
  if (hook === undefined) return { ...options, ...kept };
  const overrides = await hook({
    sessionId: session.id,
    session,
    ...(options.extraBody === undefined ? {} : { extraBody: options.extraBody }),
    ...(options.trigger === undefined ? {} : { trigger: options.trigger }),
    ...(resumed === undefined ? {} : { resumed }),
  });
  if (overrides === undefined || overrides === null) return { ...options, ...kept };
  const out: T & TurnDecision = {
    ...options,
    ...decision(overrides.metadata ?? resumed?.metadata, overrides.pin ?? resumed?.pin),
  };
  const target = out as Record<string, unknown>;
  for (const key of OVERRIDE_KEYS) {
    if (target[key] === undefined && overrides[key] !== undefined) target[key] = overrides[key];
  }
  if (overrides.runtime !== undefined) out.runtime = { ...overrides.runtime, ...options.runtime };
  if (overrides.trace !== undefined) out.trace = { ...overrides.trace, ...options.trace };
  const hookEvent = overrides.onEvent;
  const callEvent = options.onEvent;
  if (hookEvent !== undefined) {
    out.onEvent =
      callEvent === undefined
        ? hookEvent
        : async (event) => {
            await hookEvent(event);
            await callEvent(event);
          };
  }
  return out;
}

function decision(metadata: HarnessTurnMetadata | undefined, pin: unknown): TurnDecision {
  return {
    ...(metadata === undefined ? {} : { turnMetadata: metadata }),
    ...(pin === undefined ? {} : { turnPin: pin }),
  };
}
