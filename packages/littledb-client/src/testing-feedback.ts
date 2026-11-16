import type { FeedbackResult, FeedbackSelection } from "./contract.js";

/** A deliberately small fake: exact string-leaf matches only, without the engine's lifecycle. */
export function testFeedbackSelection(selection: FeedbackSelection | undefined, output: unknown): FeedbackResult["selection"] {
  if (selection?.quote === undefined) return undefined;
  const quote = selection.quote;
  let target = output;
  if (selection.path !== undefined && selection.path !== "") {
    for (const token of selection.path.slice(1).split("/")) {
      const key = token.replace(/~1/gu, "/").replace(/~0/gu, "~");
      target = target !== null && typeof target === "object" && Object.hasOwn(target, key)
        ? (target as Record<string, unknown>)[key]
        : undefined;
    }
  }
  function find(value: unknown, path: string): FeedbackResult["selection"] {
    if (typeof value === "string") {
      const start = value.indexOf(quote);
      return start < 0 ? undefined : { anchor: { status: "exact", start, end: start + quote.length, path } };
    }
    if (value !== null && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        const found = find(child, `${path}/${key.replace(/~/gu, "~0").replace(/\//gu, "~1")}`);
        if (found !== undefined) return found;
      }
    }
    return undefined;
  }
  return find(target, selection.path ?? "") ?? { anchor: { status: "not_found" } };
}
