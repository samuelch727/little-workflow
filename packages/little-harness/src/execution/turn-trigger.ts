import type { HarnessTrigger, JsonObject } from "../types.js";

const TRIGGER_METADATA_KEYS = [
  ["kind", "triggerKind"],
  ["source", "triggerSource"],
  ["from", "triggerFrom"],
  ["label", "triggerLabel"],
] as const;

/**
 * A turn's trigger as `harness.session.started` metadata: flat strings, only the fields that are
 * set. A trigger without a `kind` is left out rather than failing the turn it only describes.
 */
export function triggerMetadata(trigger: HarnessTrigger | undefined): JsonObject | undefined {
  if (trigger === undefined || typeof trigger.kind !== "string" || trigger.kind.length === 0) return undefined;
  const metadata: Record<string, string> = {};
  for (const [field, key] of TRIGGER_METADATA_KEYS) {
    const value = trigger[field];
    if (typeof value === "string" && value.length > 0) metadata[key] = value;
  }
  return metadata;
}
