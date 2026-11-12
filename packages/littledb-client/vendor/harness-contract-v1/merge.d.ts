/**
 * Three-way merge of two changes to the same content: a fix (ours) and what went live since
 * it was made (theirs), both made from the fix's old base. Pure and deterministic; the
 * composer (composer.ts) handles what this can't combine.
 *
 * Objects merge key by key. A path changed on one side only takes that side, and one changed
 * the same way on both is fine. Arrays are one value unless all three keep the same length and
 * their items are objects with the same `id` at each place (a workflow's steps); then they
 * merge item by item. Two different edits to one string get a small diff3 over its lines,
 * or over its sentences when it has no line breaks (or when the edits share a line), and merge
 * when the changed regions don't overlap. Anything else is an overlap.
 */
export type MergeHow = "theirs" | "ours" | "same" | "lines" | "overlap" | "composed";
export type MergePath = {
    path: string;
    how: MergeHow;
};
export type Overlap = {
    path: string;
    base: unknown;
    ours: unknown;
    theirs: unknown;
};
export type MergeResult = {
    content: Record<string, unknown>;
    clean: boolean;
    paths: MergePath[];
    overlaps: Overlap[];
};
/**
 * Merge `ours` and `theirs`, both changed from `base`. `resolved` holds combined values for
 * overlaps (by path), as the composer wrote them; those paths read "composed". Where an overlap
 * has no resolution the result keeps `theirs` (the live content), and `clean` is false.
 */
export declare function merge3(base: unknown, ours: unknown, theirs: unknown, resolved?: Record<string, unknown>): MergeResult;
/** Lines, each keeping its line break, so joining them gives the text back. */
export declare const lines: (s: string) => string[];
/** Sentences, each keeping the space after it. */
export declare const sentences: (s: string) => string[];
/**
 * Combine two edits of one text, or null when they change the same region differently. Text
 * with line breaks merges line by line; a region both sides changed gets one more try by
 * sentence, so two edits to different sentences of one paragraph still combine.
 */
export declare function mergeText(base: string, ours: string, theirs: string): string | null;
