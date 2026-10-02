import { HarnessInputError } from "../errors.js";
import type { HarnessSession, JsonObject, SessionConnectorEndpoint } from "../types.js";

// The canonical definition lives in ../types.js so the tool-execution context and the registry
// agree on one shape; re-exported here so the connectors public surface is unchanged.
export type { SessionConnectorEndpoint } from "../types.js";

const REGISTRY_PATH = "/session/.harness/connectors.json";
const REGISTRY_RECOVERY_PREFIX = "/session/.harness/connectors.recovered";

export type SessionConnectorDelivery = "active" | "passive" | "mirror" | "disabled";

export type SessionConnectorAttachmentInput = {
  connectorId: string;
  kind: string;
  delivery: SessionConnectorDelivery;
  endpoint: SessionConnectorEndpoint;
  metadata?: JsonObject;
};

export type SessionConnectorAttachment = SessionConnectorAttachmentInput & {
  attachedAt: string;
  updatedAt: string;
  /**
   * Delivery to restore when this attachment is later demoted (another surface goes `active`).
   * Set automatically when a `mirror` or `disabled` surface is temporarily promoted to `active`
   * by a same-key re-attach, so its original standing survives the active turn. Cleared on
   * demotion and by an explicit `setSessionConnectorDelivery`.
   */
  restoreDelivery?: "passive" | "mirror" | "disabled";
};

export type SessionConnectorRef = {
  connectorId: string;
  endpointId: string;
};

type SessionConnectorRegistryFile = {
  version: 1;
  connectors: SessionConnectorAttachment[];
};

// The per-session lock map must be SHARED across jiti module graphs. Connector modules
// (`connector.*` and `connectors/<id>/tools/*`) load through jiti in a separate module graph from
// statically-imported harness code (see workspace/module-loader.ts and the demo's globalThis
// outbox in shared/mirror-delivery.ts). A plain module-level `Map` is therefore duplicated per
// graph, so two graphs attaching/detaching the same session would not serialize and could clobber
// the registry file. Back the map with `globalThis` under a well-known `Symbol.for` key so every
// module-graph copy of this module resolves the identical map.
const SESSION_REGISTRY_LOCKS_KEY = Symbol.for("little-harness.connectors.sessionRegistryLocks");

function sessionRegistryLocks(): Map<string, Promise<void>> {
  const store = globalThis as unknown as Record<symbol, Map<string, Promise<void>> | undefined>;
  const existing = store[SESSION_REGISTRY_LOCKS_KEY];
  if (existing !== undefined) {
    return existing;
  }
  const created = new Map<string, Promise<void>>();
  store[SESSION_REGISTRY_LOCKS_KEY] = created;
  return created;
}

export async function listSessionConnectors(
  session: HarnessSession,
): Promise<SessionConnectorAttachment[]> {
  return withSessionRegistryLock(session, async () => (await readRegistry(session)).connectors);
}

export type AttachSessionConnectorOptions = {
  /**
   * Delivery to assign to OTHER records currently `active` when this attach takes over as
   * `active`. Defaults to `"passive"`. Pass `"mirror"` to keep the previous surface mirrored so
   * the new surface's replies are echoed back to it.
   */
  previousActive?: "passive" | "mirror";
};

export async function attachSessionConnector(
  session: HarnessSession,
  attachment: SessionConnectorAttachmentInput,
  options?: AttachSessionConnectorOptions,
): Promise<SessionConnectorAttachment> {
  return withSessionRegistryLock(session, async () => attachSessionConnectorLocked(session, attachment, options));
}

async function attachSessionConnectorLocked(
  session: HarnessSession,
  attachment: SessionConnectorAttachmentInput,
  options?: AttachSessionConnectorOptions,
): Promise<SessionConnectorAttachment> {
  const registry = await readRegistry(session);
  const now = new Date().toISOString();
  const key = attachmentKey(attachment);
  const previousActive = options?.previousActive ?? "passive";
  let saved: SessionConnectorAttachment | undefined;
  const connectors = registry.connectors.map((existing) => {
    if (attachmentKey(existing) !== key) {
      // Only records currently `active` are demoted; `disabled` and `passive`/`mirror` records
      // are never auto-modified by another surface's attach.
      if (attachment.delivery === "active" && existing.delivery === "active") {
        return demoteActiveRecord(existing, previousActive, now);
      }
      return existing;
    }

    saved = reattachRecord(existing, attachment, now);
    return saved;
  });

  if (saved === undefined) {
    saved = {
      ...attachment,
      attachedAt: now,
      updatedAt: now,
    };
    connectors.push(saved);
  }

  await writeRegistry(session, {
    version: 1,
    connectors: connectors.sort(compareAttachments),
  });
  return saved;
}

function demoteActiveRecord(
  existing: SessionConnectorAttachment,
  previousActive: "passive" | "mirror",
  now: string,
): SessionConnectorAttachment {
  if (existing.restoreDelivery !== undefined) {
    const restored: SessionConnectorAttachment = {
      ...existing,
      delivery: existing.restoreDelivery,
      updatedAt: now,
    };
    delete restored.restoreDelivery;
    return restored;
  }
  return { ...existing, delivery: previousActive, updatedAt: now };
}

function reattachRecord(
  existing: SessionConnectorAttachment,
  attachment: SessionConnectorAttachmentInput,
  now: string,
): SessionConnectorAttachment {
  const saved: SessionConnectorAttachment = {
    ...existing,
    ...attachment,
    attachedAt: existing.attachedAt,
    updatedAt: now,
  };
  const restoreDelivery = reattachRestoreDelivery(existing, attachment.delivery);
  if (restoreDelivery === undefined) {
    delete saved.restoreDelivery;
  } else {
    saved.restoreDelivery = restoreDelivery;
  }
  return saved;
}

function reattachRestoreDelivery(
  existing: SessionConnectorAttachment,
  delivery: SessionConnectorDelivery,
): "passive" | "mirror" | "disabled" | undefined {
  if (delivery !== "active") {
    // An explicit non-active re-attach is a fresh intent; drop any restore stickiness.
    return undefined;
  }
  if (existing.delivery === "mirror" || existing.delivery === "disabled") {
    // Promoting a mirrored/disabled surface to active for this run: remember where to restore it.
    return existing.delivery;
  }
  // Active-over-active/passive re-attach preserves any stickiness carried by the record.
  return existing.restoreDelivery;
}

export async function detachSessionConnector(
  session: HarnessSession,
  ref: SessionConnectorRef,
): Promise<boolean> {
  return withSessionRegistryLock(session, async () => {
    const registry = await readRegistry(session);
    const key = refKey(ref);
    const remaining = registry.connectors.filter((existing) => attachmentKey(existing) !== key);
    if (remaining.length === registry.connectors.length) {
      return false;
    }
    await writeRegistry(session, {
      version: 1,
      connectors: remaining.sort(compareAttachments),
    });
    return true;
  });
}

export async function setSessionConnectorDelivery(
  session: HarnessSession,
  ref: SessionConnectorRef,
  delivery: SessionConnectorDelivery,
): Promise<SessionConnectorAttachment> {
  return withSessionRegistryLock(session, async () => {
    const registry = await readRegistry(session);
    const key = refKey(ref);
    const now = new Date().toISOString();
    let updated: SessionConnectorAttachment | undefined;
    const connectors = registry.connectors.map((existing) => {
      if (attachmentKey(existing) !== key) {
        return existing;
      }
      const next: SessionConnectorAttachment = { ...existing, delivery, updatedAt: now };
      delete next.restoreDelivery;
      updated = next;
      return next;
    });

    if (updated === undefined) {
      throw new HarnessInputError("Session connector attachment not found.", {
        connectorId: ref.connectorId,
        endpointId: ref.endpointId,
      });
    }

    await writeRegistry(session, {
      version: 1,
      connectors: connectors.sort(compareAttachments),
    });
    return updated;
  });
}

export function chatSdkEndpointId(adapterName: string, threadId: string): string {
  return `${adapterName}:${threadId}`;
}

export function webRichEndpointId(userId: string, conversationId: string): string {
  return `${userId}:${conversationId}`;
}

export async function selectSessionDeliveryTargets(
  session: HarnessSession,
  active?: SessionConnectorAttachment,
): Promise<SessionConnectorAttachment[]> {
  const activeKey = active === undefined ? undefined : attachmentKey(active);
  return withSessionRegistryLock(session, async () =>
    (await readRegistry(session)).connectors.filter((connector) =>
      connector.delivery === "mirror" && attachmentKey(connector) !== activeKey
    )
  );
}

function attachmentKey(attachment: Pick<SessionConnectorAttachmentInput, "connectorId" | "endpoint">): string {
  return `${attachment.connectorId}:${attachment.endpoint.id}`;
}

function refKey(ref: SessionConnectorRef): string {
  return `${ref.connectorId}:${ref.endpointId}`;
}

async function readRegistry(session: HarnessSession): Promise<SessionConnectorRegistryFile> {
  try {
    const file = await session.files.read(REGISTRY_PATH);
    const text = file.text();
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (error) {
      if (error instanceof SyntaxError) {
        await recoverInvalidRegistry(session, text);
        return emptyRegistry();
      }
      throw error;
    }
    if (isRegistryFile(value)) {
      return {
        version: 1,
        connectors: [...value.connectors].sort(compareAttachments),
      };
    }
    await recoverInvalidRegistry(session, text);
    return emptyRegistry();
  } catch (error) {
    if (isMissingFileError(error)) {
      return emptyRegistry();
    }
    throw error;
  }
}

async function writeRegistry(session: HarnessSession, registry: SessionConnectorRegistryFile): Promise<void> {
  await session.files.writeJSON(REGISTRY_PATH, registry, {
    source: "connector",
    metadata: { littleHarnessConnectors: true },
  });
}

async function recoverInvalidRegistry(session: HarnessSession, text: string): Promise<void> {
  const path = `${REGISTRY_RECOVERY_PREFIX}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
  try {
    await session.files.writeText(path, text, {
      source: "connector",
      metadata: { littleHarnessConnectors: true, recoveredFrom: REGISTRY_PATH },
    });
  } catch {
    /* Recovery metadata is best-effort; invalid registries must not brick message handling. */
  }
  console.warn(
    `little-harness: session connector registry at ${REGISTRY_PATH} was invalid; ` +
      `preserved the original at ${path} and reset the registry to empty.`,
  );
  await writeRegistry(session, emptyRegistry());
}

async function withSessionRegistryLock<T>(
  session: HarnessSession,
  action: () => Promise<T>,
): Promise<T> {
  const locks = sessionRegistryLocks();
  const previous = locks.get(session.id) ?? Promise.resolve();
  const previousDone = previous.catch(() => {});
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = previousDone.then(() => current);
  locks.set(session.id, chained);

  await previousDone;
  try {
    return await action();
  } finally {
    release();
    if (locks.get(session.id) === chained) {
      locks.delete(session.id);
    }
  }
}

function emptyRegistry(): SessionConnectorRegistryFile {
  return { version: 1, connectors: [] };
}

function isRegistryFile(value: unknown): value is SessionConnectorRegistryFile {
  return isObject(value) &&
    value.version === 1 &&
    Array.isArray(value.connectors) &&
    value.connectors.every(isAttachment);
}

function isAttachment(value: unknown): value is SessionConnectorAttachment {
  return isObject(value) &&
    typeof value.connectorId === "string" &&
    typeof value.kind === "string" &&
    isDelivery(value.delivery) &&
    isEndpoint(value.endpoint) &&
    typeof value.attachedAt === "string" &&
    typeof value.updatedAt === "string" &&
    (value.metadata === undefined || isObject(value.metadata)) &&
    (value.restoreDelivery === undefined || isRestoreDelivery(value.restoreDelivery));
}

function isEndpoint(value: unknown): value is SessionConnectorEndpoint {
  return isObject(value) &&
    typeof value.id === "string" &&
    (value.platform === undefined || typeof value.platform === "string") &&
    (value.threadId === undefined || typeof value.threadId === "string") &&
    (value.userId === undefined || typeof value.userId === "string") &&
    (value.label === undefined || typeof value.label === "string");
}

function isDelivery(value: unknown): value is SessionConnectorDelivery {
  return value === "active" || value === "passive" || value === "mirror" || value === "disabled";
}

function isRestoreDelivery(value: unknown): value is "passive" | "mirror" | "disabled" {
  return value === "passive" || value === "mirror" || value === "disabled";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFileError(error: unknown): boolean {
  return isObject(error) && error.code === "ENOENT";
}

function compareAttachments(left: SessionConnectorAttachment, right: SessionConnectorAttachment): number {
  return attachmentKey(left).localeCompare(attachmentKey(right));
}
