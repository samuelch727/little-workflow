import { createHash } from "node:crypto";

export type StableHashFormat = "prefixed" | "hex" | "base64url" | "base32hex";

export function canonicalJson(value: unknown): string {
  const seen = new WeakSet<object>();
  const serialized = serializeCanonical(value, seen);
  return serialized ?? "null";
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function stableHash(
  value: unknown,
  options?: { readonly format?: StableHashFormat },
): string {
  const digest = createHash("sha256").update(canonicalJson(value)).digest();
  const format = options?.format ?? "prefixed";
  if (format === "hex") {
    return digest.toString("hex");
  }
  if (format === "base64url") {
    return digest.toString("base64url");
  }
  if (format === "base32hex") {
    return base32Hex(digest);
  }
  return `sha256:${digest.toString("hex")}`;
}

function serializeCanonical(value: unknown, seen: WeakSet<object>): string | undefined {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? JSON.stringify(value) : "null";
  }
  if (typeof value === "bigint") {
    throw new TypeError("Cannot canonicalize bigint values.");
  }
  if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") {
    return undefined;
  }
  if (typeof value !== "object") {
    return JSON.stringify(value);
  }

  const valueWithToJson = value as { readonly toJSON?: () => unknown };
  if (typeof valueWithToJson.toJSON === "function") {
    return serializeCanonical(valueWithToJson.toJSON(), seen);
  }

  if (seen.has(value)) {
    throw new TypeError("Cannot canonicalize circular values.");
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        items.push(serializeCanonical(value[index], seen) ?? "null");
      }
      return `[${items.join(",")}]`;
    }

    const record = value as Readonly<Record<string, unknown>>;
    const entries = Object.keys(record)
      .sort()
      .flatMap((key) => {
        const serializedValue = serializeCanonical(record[key], seen);
        return serializedValue === undefined ? [] : [`${JSON.stringify(key)}:${serializedValue}`];
      });
    return `{${entries.join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

function base32Hex(bytes: Uint8Array): string {
  const alphabet = "0123456789abcdefghijklmnopqrstuv";
  let output = "";
  let accumulator = 0;
  let bits = 0;

  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += alphabet[(accumulator >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += alphabet[(accumulator << (5 - bits)) & 31];
  }

  return output;
}
