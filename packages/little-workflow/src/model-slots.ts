import { sha256Digest } from "./canonical.js";
import type { ModelSelectionMetadata, ModelSlot } from "./authoring.js";
import { getModelInfoFor, type ModelInfo } from "./model-registry.js";

type JsonRecord = Record<string, unknown>;
type PreparedModelSlot = {
  readonly slot: ModelSlot;
  readonly metadata: ModelSelectionMetadata;
  readonly providerId?: string;
  readonly modelId?: string;
  readonly modelInfo?: ModelInfo;
};

export type ResolvedModelSlot<TModel = unknown> = {
  readonly slotId: string;
  readonly aiSdkModel: TModel;
  readonly metadata: ModelSelectionMetadata;
  readonly providerId?: string;
  readonly modelId?: string;
  readonly modelInfo?: ModelInfo;
};

const ANIMALS = [
  "tiger", "panda", "wolf", "bear", "fox", "owl", "hawk", "deer",
  "lynx", "moose", "otter", "raven", "shark", "whale", "lion", "eagle",
  "swan", "crane", "seal", "puma", "yak", "ibex", "elk", "boar",
  "hare", "stoat", "marten", "ocelot", "leopard", "cheetah", "jaguar",
  "gazelle", "antelope", "bison", "buffalo", "camel", "llama", "alpaca", "ox",
  "kestrel", "merlin", "falcon", "kite", "harrier", "osprey", "vulture", "condor",
  "salmon", "trout", "carp", "tuna", "marlin", "barracuda", "manta", "ray",
  "dolphin", "narwhal", "beluga", "orca", "porpoise", "octopus", "squid", "nautilus",
] as const;

export function model<TModel>(
  aiSdkModel: TModel,
  metadata: ModelSelectionMetadata = {},
): ModelSlot<TModel> {
  const providerId = providerIdFor(aiSdkModel);
  const modelId = modelIdFor(aiSdkModel);
  const modelInfo = providerId === undefined || modelId === undefined
    ? undefined
    : getModelInfoFor(providerId, modelId);
  return {
    aiSdkModel,
    metadata: {
      ...(metadata.id === undefined ? {} : { id: metadata.id }),
      description: metadata.description ?? modelInfo?.description,
    },
  };
}

export function resolveModelSlots(slots: readonly ModelSlot[]): readonly ResolvedModelSlot[] {
  const prepared = slots.map((slot) => {
    const providerId = providerIdFor(slot.aiSdkModel);
    const modelId = modelIdFor(slot.aiSdkModel);
    const metadata = model(slot.aiSdkModel, slot.metadata).metadata;
    return {
      slot,
      metadata,
      ...(providerId === undefined ? {} : { providerId }),
      ...(modelId === undefined ? {} : { modelId }),
      ...(providerId === undefined || modelId === undefined
        ? {}
        : { modelInfo: getModelInfoFor(providerId, modelId) }),
    };
  });
  const reservedSlotIds = explicitSlotIdsFor(prepared);
  return prepared.map((entry, index) => {
    const explicitId = entry.metadata.id;
    const slotId = explicitId ?? deriveSlotId({
      providerId: entry.providerId,
      modelId: entry.modelId,
      description: entry.metadata.description,
      existingSlotIds: reservedSlotIds,
      index,
    });
    reservedSlotIds.add(slotId);
    return {
      slotId,
      aiSdkModel: entry.slot.aiSdkModel,
      metadata: entry.metadata,
      ...(entry.providerId === undefined ? {} : { providerId: entry.providerId }),
      ...(entry.modelId === undefined ? {} : { modelId: entry.modelId }),
      ...(entry.modelInfo === undefined ? {} : { modelInfo: entry.modelInfo }),
    };
  });
}

function explicitSlotIdsFor(slots: readonly PreparedModelSlot[]): Set<string> {
  const explicitSlotIds = new Set<string>();
  for (const slot of slots) {
    const explicitId = slot.metadata.id;
    if (explicitId === undefined) {
      continue;
    }
    if (explicitSlotIds.has(explicitId)) {
      throw new Error(`Slot id '${explicitId}' is already in use.`);
    }
    explicitSlotIds.add(explicitId);
  }
  return explicitSlotIds;
}

export function slotIdForResolvedModel(slot: ResolvedModelSlot): string {
  return slot.slotId;
}

function deriveSlotId(options: {
  readonly providerId?: string;
  readonly modelId?: string;
  readonly description?: string;
  readonly existingSlotIds: ReadonlySet<string>;
  readonly index: number;
}): string {
  const base = sanitizeModelId(options.modelId) ?? `model-${options.index}`;
  if (!options.existingSlotIds.has(base)) {
    return base;
  }

  const hash = sha256Digest(`${options.providerId ?? ""}:${options.modelId ?? ""}:${options.description ?? ""}`);
  const hashPrefix = hash.slice("sha256:".length, "sha256:".length + 8);
  const animalIndex = Number.parseInt(hashPrefix, 16) % ANIMALS.length;
  const candidate = `${base}-${ANIMALS[animalIndex]}`;
  if (!options.existingSlotIds.has(candidate)) {
    return candidate;
  }

  for (let offset = 1; offset < ANIMALS.length; offset += 1) {
    const next = `${base}-${ANIMALS[(animalIndex + offset) % ANIMALS.length]}`;
    if (!options.existingSlotIds.has(next)) {
      return next;
    }
  }

  throw new Error(`Cannot derive unique slot id for '${base}' - too many duplicates.`);
}

function sanitizeModelId(modelId: string | undefined): string | undefined {
  if (modelId === undefined) {
    return undefined;
  }
  const sanitized = asciiLowercase(modelId)
    .replace(/[/.:_\s]+/gu, "-")
    .replace(/[^a-z0-9-]+/gu, "")
    .replace(/-+/gu, "-")
    .replace(/^-|-$/gu, "");
  return sanitized.length === 0 ? undefined : sanitized;
}

function asciiLowercase(value: string): string {
  return value.replace(/[A-Z]/g, (character) => character.toLowerCase());
}

function providerIdFor(modelValue: unknown): string | undefined {
  if (!isRecord(modelValue)) {
    return undefined;
  }
  return stringLike(modelValue.provider) ?? stringLike(modelValue.providerId);
}

function modelIdFor(modelValue: unknown): string | undefined {
  return isRecord(modelValue) ? stringLike(modelValue.modelId) : undefined;
}

function stringLike(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return undefined;
}

function isRecord(value: unknown): value is JsonRecord {
  return (typeof value === "object" || typeof value === "function") && value !== null;
}
