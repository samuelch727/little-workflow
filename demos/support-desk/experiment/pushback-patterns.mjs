/**
 * littleDB's inferred-outcome detector, copied verbatim as a fixture.
 *
 * Provenance: `viewer/src/server/inferredOutcomes.ts` in the littledb repo, LIT-51,
 * `DETECTOR_VERSION = "pushback-heuristic-v1"` (13 patterns).
 *
 * WHY A COPY. Tier B and tier C scenarios only mean anything if the detector actually fires
 * on their pushback turns: tier C reports no outcome at all, so a frustration turn that no
 * pattern matches is a failure littleDB will never hear about, and the whole "can the dream
 * read the conversation?" question quietly stops being asked. Writing the phrasings and
 * *hoping* they match is not good enough, so `verify-truth.mjs` and `tests/scenarios.test.ts`
 * check every follow-up turn against this list.
 *
 * It is a fixture, not a dependency: littledb is a separate repository and this demo cannot
 * import from it. That makes drift possible, which is exactly why the detector version is
 * recorded above — when littleDB bumps it, this file is stale by construction and the
 * scenarios should be re-checked against the new list.
 *
 * The detector's two positional rules are reproduced in the checks that use this list: only
 * USER turns count, and never the first turn of a thread (a correction needs something to
 * correct). That is why only `turns[1..]` are ever tested.
 */

export const DETECTOR_VERSION = "pushback-heuristic-v1";

export const PUSHBACK_PATTERNS = [
  {
    id: "correction-explicit",
    test: /\b(?:that|this|it)(?:['’]s|s|\s+is|\s+was)?\s*(?:not\s+(?:right|correct|it|what\s+i\s+(?:asked|meant))|wrong|incorrect)\b/i,
  },
  {
    id: "correction-wrong-topic",
    test: /\b(?:that|this)(?:['’]s|\s+is|\s+was)\s+about\s+[^.!?]{1,80},\s*not\s+/i,
  },
  {
    id: "contradiction-authority",
    test: /\b(?:hr|legal|finance|payroll|security|my\s+manager|my\s+lead|our\s+manager|my\s+colleague|a\s+colleague|my\s+team|the\s+team)\s+(?:told|said\s+to)\s+me\b/i,
  },
  {
    id: "contradiction-actually",
    test: /\b(?:it['’]?s|the\s+answer\s+is|that['’]?s)\s+actually\b/i,
  },
  { id: "contradiction-explicit", test: /\b(?:that|this|it)\s+contradicts\b/i },
  { id: "contradiction-disbelief", test: /\b(?:that|this)\s+can['’]?t\s+be\b/i },
  {
    id: "stale-source",
    test: /\b(?:outdated|out\s?-?\s?of\s?-?\s?date|no\s+longer\s+(?:current|valid|accurate|true)|superseded|archived)\b/i,
  },
  { id: "repeat-asked", test: /\bi\s+(?:already\s+)?(?:asked|told\s+you|said)\b/i },
  { id: "repeat-nth-time", test: /\b(?:second|third|fourth|fifth|\d+(?:st|nd|rd|th))\s+time\b/i },
  { id: "repeat-you-keep", test: /\byou\s+keep\b/i },
  {
    id: "repeat-same-wrong",
    test: /\b(?:same\s+(?:wrong|incorrect|non-?\s?answer|useless)|wrong\s+(?:answer|document|doc|file|link|policy|page|number))\b/i,
  },
  {
    id: "effort-challenged",
    test: /\b(?:look|search|try|dig)\s+(?:harder|again|properly)\b|\bcan\s+you\s+actually\s+(?:search|look|check|read)\b/i,
  },
  {
    id: "abandonment",
    test: /\b(?:never\s?mind|forget\s+it)\b|\bi(?:['’]ll|\s+will)\s+(?:just\s+)?(?:ask|email|contact|check\s+with|go\s+with)\b/i,
  },
];

/** Every pattern id that fires on this text. Empty means littleDB would see nothing. */
export function matchingPatterns(text) {
  return PUSHBACK_PATTERNS.filter((pattern) => pattern.test.test(text)).map((pattern) => pattern.id);
}
