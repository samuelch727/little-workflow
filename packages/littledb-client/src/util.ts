import { createHash } from "node:crypto";
import type { ComputeUsage, Environment, Trigger, Usage } from "./contract.js";
import { currentEvalContext } from "./eval-context.js";

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** A LittleDB id (at most 200 characters): the parts joined with `:`, hashed when too long. */
export function boundedId(...parts: readonly string[]): string {
  const joined = parts.join(":");
  return joined.length <= 200 ? joined : `${joined.slice(0, 150)}~${sha256Hex(joined).slice(0, 40)}`;
}

/** Cut a name or label to LittleDB's limit. */
export function clipText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

const TRIGGER_TEXT = { source: 200, from: 200, label: 500 } as const;
const TRIGGER_IDS = ["sessionId", "turnId", "toolCallId", "runId"] as const;

/**
 * A trigger within LittleDB's limits: strings only, text clipped, ids bounded, empty fields left
 * out, so one odd value never gets a whole batch refused. Undefined without a `kind`.
 */
export function toTrigger(fields: Readonly<Record<string, unknown>>): Trigger | undefined {
  const kind = stringValue(fields.kind);
  if (kind === undefined || kind.length === 0) return undefined;
  const trigger: Trigger = { kind: clipText(kind, 40) };
  for (const [field, max] of Object.entries(TRIGGER_TEXT) as Array<[keyof typeof TRIGGER_TEXT, number]>) {
    const value = stringValue(fields[field]);
    if (value !== undefined && value.length > 0) trigger[field] = clipText(value, max);
  }
  for (const field of TRIGGER_IDS) {
    const value = stringValue(fields[field]);
    if (value !== undefined && value.length > 0) trigger[field] = boundedId(value);
  }
  return trigger;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;
}

function amount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * A trace's `compute` from the harness's `harness.runtime.usage` metadata: the tier the turn
 * reached and the sandbox's own account (`sandbox`). Undefined when the event is not one the
 * contract accepts, so one odd event never gets a batch refused. The vCPU-seconds are worked
 * out here when the sandbox named its vCPU count, since that is what compute is priced on.
 */
export function toLittleDBCompute(metadata: unknown): ComputeUsage | undefined {
  if (!isRecord(metadata)) return undefined;
  const tier = metadata.tier;
  if (tier !== "tier-0" && tier !== "next-tier") return undefined;
  const sandbox = isRecord(metadata.sandbox) ? metadata.sandbox : undefined;
  const provider = stringValue(sandbox?.provider);
  const activeMs = amount(sandbox?.activeMs);
  if (sandbox === undefined || provider === undefined || provider.length === 0 || activeMs === undefined) return undefined;
  const instanceType = stringValue(sandbox.instanceType);
  const vcpu = amount(sandbox.vcpu);
  const memoryGiB = amount(sandbox.memoryGiB);
  const awakeMs = amount(sandbox.awakeMs);
  const costUsd = amount(sandbox.costUsd);
  return {
    tier,
    provider: clipText(provider, 200),
    ...(instanceType === undefined || instanceType.length === 0 ? {} : { instanceType: clipText(instanceType, 200) }),
    ...(vcpu === undefined ? {} : { vcpu }),
    ...(memoryGiB === undefined ? {} : { memoryGiB }),
    activeMs,
    ...(awakeMs === undefined ? {} : { awakeMs }),
    ...(vcpu === undefined ? {} : { vcpuSeconds: (vcpu * activeMs) / 1000 }),
    ...(costUsd === undefined ? {} : { costUsd }),
  };
}

/**
 * Model usage in LittleDB's convention, from the AI SDK's.
 *
 * The AI SDK reports `inputTokens` as the TOTAL input, with cache reads and writes inside it
 * (`inputTokenDetails`, or `cachedInputTokens` in older payloads). LittleDB wants `inputTokens`
 * without them, so the four numbers never double-count and the cache rates apply to the cached part.
 */
export function toLittleDBUsage(usage: unknown): Usage | undefined {
  if (!isRecord(usage)) return undefined;
  const details = isRecord(usage.inputTokenDetails) ? usage.inputTokenDetails : {};
  const total = count(usage.inputTokens);
  const cacheRead = count(details.cacheReadTokens) ?? count(usage.cachedInputTokens) ?? count(usage.cacheReadTokens) ?? 0;
  const cacheWrite = count(details.cacheWriteTokens) ?? count(usage.cacheWriteTokens) ?? 0;
  const noCache = count(details.noCacheTokens) ?? (total === undefined ? undefined : Math.max(0, total - cacheRead - cacheWrite));
  const output = count(usage.outputTokens);
  if (noCache === undefined && output === undefined && cacheRead === 0 && cacheWrite === 0) return undefined;
  return {
    ...(noCache === undefined ? {} : { inputTokens: noCache }),
    ...(output === undefined ? {} : { outputTokens: output }),
    ...(cacheRead === 0 ? {} : { cacheReadTokens: cacheRead }),
    ...(cacheWrite === 0 ? {} : { cacheWriteTokens: cacheWrite }),
  };
}

/**
 * The text of a harness trace content reference (`{ captured, preview, truncated, ... }`), or of a
 * plain value. Harness events carry previews, not full content; see `harnessTracer`.
 */
export function contentText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (isRecord(value)) {
    if (value.captured === false) return undefined;
    if (typeof value.preview === "string") return value.preview;
  }
  if (value === undefined) return undefined;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** A content reference as a JSON value when its preview parses, else as text. */
export function contentValue(value: unknown): unknown {
  const text = contentText(value);
  if (text === undefined) return undefined;
  const trimmed = text.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[") || trimmed.startsWith("\"")) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

/** Whether a content reference was cut short (the harness's preview limit). */
export function contentTruncated(value: unknown): boolean {
  if (!isRecord(value) || typeof value.preview !== "string") return false;
  return value.truncated === true || (typeof value.bytes === "number" && value.bytes > Buffer.byteLength(value.preview));
}

/** A message's content as text when it is only text parts, else as the parts. */
export function messageContent(value: unknown): unknown {
  const parsed = contentValue(value);
  if (Array.isArray(parsed)) {
    const texts = parsed.map((part) => (isRecord(part) && part.type === "text" && typeof part.text === "string" ? part.text : undefined));
    if (texts.every((text) => text !== undefined)) return texts.join("\n");
  }
  return parsed;
}

/** `{ message, type }` from an error envelope, an Error or anything else. */
export function errorInfo(value: unknown): { message: string; type?: string } {
  if (value instanceof Error) return { message: value.message || String(value), type: value.name };
  if (isRecord(value)) {
    const message = stringValue(value.message) ?? contentText(value) ?? "Error";
    const type = stringValue(value.name) ?? stringValue(value.code);
    return type === undefined ? { message } : { message, type };
  }
  return { message: value === undefined ? "Error" : String(value) };
}

/** Provider names arrive as `anthropic.messages`; LittleDB wants `anthropic`. */
export function providerName(value: unknown): string | undefined {
  const provider = stringValue(value);
  return provider === undefined ? undefined : provider.split(".")[0];
}

export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * The environment a trace is tagged with: what you set, else `experiment` inside an eval worker
 * run (an agent a run calls is not production traffic), else from the resolve mode.
 */
export function environmentFor(explicit: Environment | undefined, mode: string | undefined): Environment {
  if (explicit !== undefined) return explicit;
  if (currentEvalContext() !== undefined) return "experiment";
  if (mode === "trial") return "trial";
  if (mode === "holdout") return "holdout";
  return "production";
}

/** A deterministic bucket in [0, 1) for a key, the same one LittleDB uses to split traffic. */
export function bucket(key: string): number {
  return parseInt(sha256Hex(key).slice(0, 8), 16) / 0x1_0000_0000;
}
