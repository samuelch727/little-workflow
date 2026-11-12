import { isObject } from "./contract.js";

export const DEFAULT_MAX_REQUEST_BYTES = 1024 * 1024;
export const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export type RemoteToolRequest = {
  v: 1;
  tool: string;
  input: unknown;
  toolCallId: string;
  invocationId?: string;
  idempotencyKey?: string;
  scope: string;
  sessionId: string;
  context?: unknown;
};

const FIELDS = new Set(["v", "tool", "input", "toolCallId", "invocationId", "idempotencyKey", "scope", "sessionId", "context"]);
function identity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 2048;
}
export function validRequest(value: unknown): value is RemoteToolRequest {
  return isObject(value) && Object.keys(value).every(key => FIELDS.has(key)) && value.v === 1 &&
    typeof value.tool === "string" && /^[a-zA-Z0-9_-]{1,64}$/u.test(value.tool) &&
    Object.hasOwn(value, "input") && identity(value.toolCallId) && identity(value.scope) && identity(value.sessionId) &&
    (value.invocationId === undefined || identity(value.invocationId)) &&
    (value.idempotencyKey === undefined || identity(value.idempotencyKey));
}

export function positiveLimit(value: number | undefined, fallback: number): number {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Remote tool limits must be positive safe integers.");
  return limit;
}

export class BodyTooLarge extends Error {}

/** Bounds actual bytes, including chunked bodies without a Content-Length. */
export async function readBounded(body: Request | Response, maxBytes: number): Promise<string> {
  const declared = body.headers.get("content-length");
  if (declared !== null && /^\d+$/u.test(declared) && Number(declared) > maxBytes) {
    await body.body?.cancel().catch(() => undefined);
    throw new BodyTooLarge();
  }
  const reader = body.body?.getReader();
  if (reader === undefined) return "";
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new BodyTooLarge();
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let at = 0;
    for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } finally { reader.releaseLock(); }
}

/**
 * Wire encoding: honor JSON.stringify's Date/toJSON conversion and undefined omission,
 * but do not silently convert non-finite numbers or accept unsupported class instances.
 * This deliberately does not participate in identity hashing.
 */
export function transportJson(value: unknown): string {
  const serialized = JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === "bigint") throw new TypeError("Remote tool transport cannot serialize BigInt values.");
    if (typeof item === "number" && !Number.isFinite(item)) throw new TypeError("Remote tool transport cannot serialize non-finite numbers.");
    if (typeof item === "object" && item !== null && !Array.isArray(item) &&
      Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) {
      throw new TypeError("Remote tool transport requires class instances to provide toJSON() returning JSON values.");
    }
    return item;
  });
  if (serialized === undefined) throw new TypeError("Remote tool transport requires a serializable JSON value.");
  return serialized;
}

/** Reject non-JSON values rather than silently changing a write's identity digest. */
export function canonicalJson(value: unknown): string {
  const seen = new Set<object>();
  function encode(item: unknown): string {
    if (item === null || typeof item === "boolean" || typeof item === "string") return JSON.stringify(item);
    if (typeof item === "number" && Number.isFinite(item)) return JSON.stringify(item);
    if (typeof item !== "object" || item === null || seen.has(item)) throw new Error("Remote tools require JSON values.");
    seen.add(item);
    try {
      if (Array.isArray(item)) return `[${Array.from(item, encode).join(",")}]`;
      if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) {
        throw new Error("Remote tools require JSON objects.");
      }
      return `{${Object.keys(item).sort().map(key => `${JSON.stringify(key)}:${encode((item as Record<string, unknown>)[key])}`).join(",")}}`;
    } finally { seen.delete(item); }
  }
  return encode(value);
}

export async function digest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
}
