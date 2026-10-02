import { types as utilTypes } from "node:util";

/**
 * Recursively drop object properties whose value is `undefined`.
 *
 * `canonicalJson` **rejects** `undefined` rather than ignoring it (canonical.ts, "undefined is not
 * hashable"), so every optional field of a hashed payload must be *omitted*, never set to
 * `undefined`. Running this first is what makes `{ description: undefined }` hash identically to
 * `{}` instead of throwing.
 *
 * Extracted from `world.ts` (where it guards the artifact-manifest and step-config hashes) so the
 * eval-set builder can reuse the same function rather than keep a second copy of it.
 *
 * ## What it deliberately does not touch
 *
 * Recursion stops at anything that is not a *plain* object or array — a `Date`, `Map`, `Set`, class
 * instance, typed array or `Proxy` is returned as it stands, so `canonicalJson` still gets to reject
 * it. This matters: `Object.entries(new Date())` is `[]`, so a naive walk would quietly rewrite a
 * `Date` into `{}` and hash an empty object where the canonicalizer would have thrown. A pre-pass
 * must never be able to launder a value past the canonicalizer's rejections.
 *
 * Not a general JSON sanitiser: `undefined` *inside an array* is preserved (arrays are mapped, not
 * filtered) so index positions never shift, and it is then rejected by `canonicalJson` — which is
 * the correct outcome, because dropping an array element silently changes the value being hashed.
 */
export function stripUndefined<T>(value: T): T {
  if (typeof value !== "object" || value === null || utilTypes.isProxy(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => stripUndefined(item)) as T;
  }
  if (!isPlainObject(value)) {
    return value;
  }
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) {
      result[key] = stripUndefined(item);
    }
  }
  return result as T;
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}
