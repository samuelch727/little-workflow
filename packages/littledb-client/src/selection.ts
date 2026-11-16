import type { FeedbackSelection } from "./contract.js";

export type { FeedbackSelection } from "./contract.js";

/** Pick a passage using JavaScript (UTF-16) indexes; trim its whitespace and keep nearby context. */
export function textSelection(text: string, start: number, end: number): FeedbackSelection {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= end || end > text.length) {
    throw new RangeError("A text selection needs 0 <= start < end <= text.length.");
  }
  const selected = text.slice(start, end);
  const quote = selected.trim();
  if (quote.length === 0 || quote.length > 2000) {
    throw new RangeError("A text selection needs 1 to 2000 non-padding characters.");
  }
  start += selected.length - selected.trimStart().length;
  end = start + quote.length;
  let prefixStart = Math.max(0, start - 32);
  let suffixEnd = Math.min(text.length, end + 32);
  // Keep context within 32 UTF-16 units without cutting a surrogate pair at either outer edge.
  const first = text.charCodeAt(prefixStart);
  if (first >= 0xdc00 && first <= 0xdfff) prefixStart += 1;
  const last = text.charCodeAt(suffixEnd - 1);
  if (last >= 0xd800 && last <= 0xdbff) suffixEnd -= 1;
  return { quote, start, end, prefix: text.slice(prefixStart, start), suffix: text.slice(end, suffixEnd) };
}

/**
 * Read a DOM selection in the container's text-node order, excluding `data-feedback-ignore`
 * subtrees. No range means the document's current selection. Empty/outside selections and quotes
 * over 2000 UTF-16 units after trimming return null.
 */
export function selectionIn(container: Element, range?: Range): FeedbackSelection | null {
  const document = container.ownerDocument;
  if (range === undefined) {
    const current = document.getSelection();
    if (current === null || current.rangeCount === 0) return null;
    range = current.getRangeAt(0);
  }
  if (range.collapsed || !container.contains(range.startContainer) || !container.contains(range.endContainer)) return null;

  const nodes: Text[] = [];
  // SHOW_TEXT's numeric value avoids depending on a browser-global NodeFilter (e.g. in an iframe).
  const walker = document.createTreeWalker(container, 4);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    let ignored = false;
    for (let parent = node.parentElement; parent !== null; parent = parent.parentElement) {
      if (parent.hasAttribute("data-feedback-ignore")) ignored = true;
      if (parent === container) break;
    }
    if (!ignored) nodes.push(node as Text);
  }
  const offsetAt = (node: Node, offset: number): number => {
    const before = document.createRange();
    before.selectNodeContents(container);
    before.setEnd(node, offset);
    let length = 0;
    for (const text of nodes) {
      if (before.comparePoint(text, text.length) <= 0) length += text.length;
      else {
        if (text === node) length += offset;
        break;
      }
    }
    return length;
  };
  const text = nodes.map((node) => node.data).join("");
  const start = offsetAt(range.startContainer, range.startOffset);
  const end = offsetAt(range.endContainer, range.endOffset);
  const length = text.slice(start, end).trim().length;
  if (length === 0 || length > 2000) return null;
  return textSelection(text, start, end);
}
