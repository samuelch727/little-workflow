import type {
  ConnectorDeliveryError,
  ConnectorDeliveryOptions,
  ConnectorTextDeliveryContext,
  SessionConnectorEndpoint,
} from "little-harness/connectors";

/**
 * In-memory mirror outbox for the support demo.
 *
 * Mirror posting is now DESCRIPTOR-OWNED: the Discord and web-rich connectors each carry a
 * `deliver` (see their `connector.ts`), so when one surface is the active run and another is a
 * `mirror` target, the harness resolves the target connector's own `deliver` — no route re-declares a
 * deliverer map. Both connectors point `deliver` at {@link recordSupportMirrorDelivery} so tests and
 * local runs get a deterministic record of the fan-out. In a real deployment `deliver` would call the
 * target platform SDK (Discord REST / a web push) instead of recording here.
 *
 * IMPORTANT: a connector descriptor's `deliver` is invoked from the module the connector was loaded
 * in. When a connector is loaded by string id, discovery loads it through a dynamic `import()` that
 * lives in a SEPARATE module graph from the route/runner that statically imports this file (true in
 * vitest and in Next.js). A plain module-level array would therefore be duplicated and reads would
 * come back empty, so the outbox is backed by `globalThis` — every module instance shares one array.
 */
export type SupportMirrorDeliveryRecord = {
  connectorId: string;
  sessionId: string;
  sourceConnectorId: string;
  text: string;
  targetEndpoint: SessionConnectorEndpoint;
};

export type SupportMirrorDeliveryErrorRecord = {
  connectorId?: string;
  sessionId?: string;
  message: string;
};

type SupportMirrorOutbox = {
  deliveries: SupportMirrorDeliveryRecord[];
  errors: SupportMirrorDeliveryErrorRecord[];
};

const OUTBOX_KEY = "__supportMirrorOutbox__";

function outbox(): SupportMirrorOutbox {
  const store = globalThis as Record<string, unknown>;
  const existing = store[OUTBOX_KEY] as SupportMirrorOutbox | undefined;
  if (existing !== undefined) return existing;
  const created: SupportMirrorOutbox = { deliveries: [], errors: [] };
  store[OUTBOX_KEY] = created;
  return created;
}

type SupportMirrorDeliveryFilter = {
  sessionId?: string;
};

/**
 * The delivery OPTIONS the support routes pass to `load*Connector`. It no longer carries a
 * `deliverers` map (that moved onto the connector descriptors' `deliver`); it sets
 * `previousActive: "mirror"` — THE first-class portable-session mechanism, so whichever surface was
 * `active` before this run keeps receiving mirrored replies — plus an `onError` sink for the demo.
 */
export function supportMirrorDelivery<TExtraBody = unknown>(): ConnectorDeliveryOptions<TExtraBody> {
  return {
    previousActive: "mirror",
    onError: recordSupportMirrorDeliveryError,
  };
}

/** Descriptor-owned deliverer: records a successful mirror fan-out into the demo outbox. */
export async function recordSupportMirrorDelivery<TExtraBody>(
  ctx: ConnectorTextDeliveryContext<TExtraBody>,
): Promise<void> {
  outbox().deliveries.push({
    connectorId: ctx.target.connectorId,
    sessionId: ctx.sessionId,
    sourceConnectorId: ctx.active.connectorId,
    text: ctx.text,
    targetEndpoint: ctx.target.endpoint,
  });
}

export function listSupportMirrorDeliveries(): readonly SupportMirrorDeliveryRecord[] {
  return [...outbox().deliveries];
}

export function listSupportMirrorDeliveryErrors(): readonly SupportMirrorDeliveryErrorRecord[] {
  return [...outbox().errors];
}

export function clearSupportMirrorDeliveries(filter: SupportMirrorDeliveryFilter = {}): void {
  const store = outbox();
  if (filter.sessionId === undefined) {
    store.deliveries.length = 0;
    store.errors.length = 0;
    return;
  }

  removeMatching(store.deliveries, (delivery) => delivery.sessionId === filter.sessionId);
  removeMatching(store.errors, (error) => error.sessionId === filter.sessionId);
}

async function recordSupportMirrorDeliveryError<TExtraBody>(
  ctx: ConnectorDeliveryError<TExtraBody>,
): Promise<void> {
  outbox().errors.push({
    connectorId: ctx.target?.connectorId,
    sessionId: ctx.sessionId,
    message: ctx.error instanceof Error ? ctx.error.message : String(ctx.error),
  });
}

function removeMatching<T>(items: T[], predicate: (item: T) => boolean): void {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index]!)) items.splice(index, 1);
  }
}
