import { canonicalJson } from "./hash.js";
const isObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const same = (a, b) => canonicalJson(a) === canonicalJson(b);
const join = (path, key) => (path ? `${path}.${key}` : key);
const ROOT = "(content)";
/** The paths where two values differ, in the same form as contentChanges uses. */
function changedPaths(a, b, path, out) {
    if (same(a, b))
        return;
    if (isObject(a) && isObject(b)) {
        for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort())
            changedPaths(a[k], b[k], join(path, k), out);
        return;
    }
    if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
        a.forEach((x, i) => changedPaths(x, b[i], `${path}[${i}]`, out));
        return;
    }
    out.push(path || ROOT);
}
/** Workflow steps: the same length and an object with the same `id` at each place. */
function sameSteps(base, ours, theirs) {
    if (base.length !== ours.length || base.length !== theirs.length)
        return false;
    return base.every((b, i) => {
        const o = ours[i];
        const t = theirs[i];
        if (!isObject(b) || !isObject(o) || !isObject(t))
            return false;
        return b.id !== undefined && b.id !== null && same(b.id, o.id) && same(b.id, t.id);
    });
}
/**
 * Merge `ours` and `theirs`, both changed from `base`. `resolved` holds combined values for
 * overlaps (by path), as the composer wrote them; those paths read "composed". Where an overlap
 * has no resolution the result keeps `theirs` (the live content), and `clean` is false.
 */
export function merge3(base, ours, theirs, resolved = {}) {
    const paths = [];
    const overlaps = [];
    const record = (from, to, path, how) => {
        const leaves = [];
        changedPaths(from, to, path, leaves);
        for (const p of leaves)
            paths.push({ path: p, how });
    };
    const walk = (b, o, t, path) => {
        if (same(o, t)) {
            if (!same(o, b))
                record(b, o, path, "same");
            return o;
        }
        if (same(o, b)) {
            record(b, t, path, "theirs");
            return t;
        }
        if (same(t, b)) {
            record(b, o, path, "ours");
            return o;
        }
        // Both changed it, differently.
        if (isObject(o) && isObject(t) && (b === undefined || b === null || isObject(b))) {
            const bb = isObject(b) ? b : {};
            const out = {};
            // The live content's key order first, then what only the fix adds.
            for (const k of [...new Set([...Object.keys(t), ...Object.keys(o)])]) {
                const v = walk(bb[k], o[k], t[k], join(path, k));
                if (v !== undefined)
                    out[k] = v;
            }
            return out;
        }
        if (Array.isArray(b) && Array.isArray(o) && Array.isArray(t) && sameSteps(b, o, t)) {
            return b.map((x, i) => walk(x, o[i], t[i], `${path}[${i}]`));
        }
        const at = path || ROOT;
        if (typeof b === "string" && typeof o === "string" && typeof t === "string") {
            const text = mergeText(b, o, t);
            if (text !== null) {
                paths.push({ path: at, how: "lines" });
                return text;
            }
        }
        if (Object.prototype.hasOwnProperty.call(resolved, at)) {
            paths.push({ path: at, how: "composed" });
            return resolved[at];
        }
        overlaps.push({ path: at, base: b, ours: o, theirs: t });
        paths.push({ path: at, how: "overlap" });
        return t;
    };
    const merged = walk(base, ours, theirs, "");
    const content = isObject(merged) ? merged : {};
    return { content, clean: overlaps.length === 0, paths, overlaps };
}
// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------
/** Lines, each keeping its line break, so joining them gives the text back. */
export const lines = (s) => (s === "" ? [] : s.split(/(?<=\n)/));
/** Sentences, each keeping the space after it. */
export const sentences = (s) => (s === "" ? [] : s.split(/(?<=[.!?]\s+)(?=\S)/));
/**
 * Combine two edits of one text, or null when they change the same region differently. Text
 * with line breaks merges line by line; a region both sides changed gets one more try by
 * sentence, so two edits to different sentences of one paragraph still combine.
 */
export function mergeText(base, ours, theirs) {
    if (ours === theirs)
        return ours;
    if (ours === base)
        return theirs;
    if (theirs === base)
        return ours;
    const multiline = base.includes("\n") || ours.includes("\n") || theirs.includes("\n");
    if (!multiline)
        return diff3(sentences(base), sentences(ours), sentences(theirs), null);
    return diff3(lines(base), lines(ours), lines(theirs), (b, o, t) => diff3(sentences(b), sentences(o), sentences(t), null));
}
/** Longest-common-subsequence diff of two token lists, as hunks over the first. */
function diff(a, b, side) {
    let pre = 0;
    while (pre < a.length && pre < b.length && a[pre] === b[pre])
        pre++;
    let suf = 0;
    while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf])
        suf++;
    const x = a.slice(pre, a.length - suf);
    const y = b.slice(pre, b.length - suf);
    if (x.length === 0 && y.length === 0)
        return [];
    // Far too big to align token by token: one change over the whole middle.
    if (x.length * y.length > 4_000_000)
        return [{ start: pre, end: pre + x.length, tokens: y, side }];
    const n = x.length;
    const m = y.length;
    // lcs[i][j]: common length of x[i..] and y[j..].
    const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--)
            lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
    const hunks = [];
    let open = null;
    let i = 0;
    let j = 0;
    const close = () => {
        if (open)
            hunks.push(open);
        open = null;
    };
    while (i < n || j < m) {
        if (i < n && j < m && x[i] === y[j]) {
            close();
            i++;
            j++;
        }
        else if (j < m && (i === n || lcs[i][j + 1] >= lcs[i + 1][j])) {
            open ??= { start: pre + i, end: pre + i, tokens: [], side };
            open.tokens.push(y[j]);
            j++;
        }
        else {
            open ??= { start: pre + i, end: pre + i, tokens: [], side };
            open.end = pre + i + 1;
            i++;
        }
    }
    close();
    return hunks;
}
/** A change whose last token has no line break or space after it: the end of its side's text. */
const runsOn = (h) => h.tokens.length > 0 && !/\s$/.test(h.tokens[h.tokens.length - 1]);
/** Whether two changes from different sides touch the same part of the base. */
function clash(a, b) {
    // One side's text ends where the other's change begins: put together, the two would run into
    // one line (or one sentence), so they don't combine on their own.
    if ((a.end === b.start && runsOn(a)) || (b.end === a.start && runsOn(b)))
        return true;
    const aPoint = a.start === a.end;
    const bPoint = b.start === b.end;
    if (aPoint && bPoint)
        return a.start === b.start;
    if (aPoint)
        return b.start < a.start && a.start < b.end;
    if (bPoint)
        return a.start < b.start && b.start < a.end;
    return a.start < b.end && b.start < a.end;
}
function apply(base, start, end, hunks) {
    const out = [];
    let at = start;
    for (const h of hunks) {
        out.push(...base.slice(at, h.start), ...h.tokens);
        at = h.end;
    }
    out.push(...base.slice(at, end));
    return out;
}
function diff3(base, ours, theirs, retry) {
    const mine = diff(base, ours, "ours");
    const live = diff(base, theirs, "theirs");
    if (!mine || !live)
        return null;
    const all = [...mine, ...live];
    // Group changes that clash, directly or through each other.
    const group = all.map((_, i) => i);
    const find = (i) => (group[i] === i ? i : (group[i] = find(group[i])));
    for (let i = 0; i < mine.length; i++) {
        for (let j = 0; j < live.length; j++)
            if (clash(mine[i], live[j]))
                group[find(i)] = find(mine.length + j);
    }
    const groups = new Map();
    all.forEach((h, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), h]));
    const pieces = [];
    for (const hs of groups.values()) {
        const sides = new Set(hs.map((h) => h.side));
        if (sides.size === 1) {
            pieces.push(...hs);
            continue;
        }
        const start = Math.min(...hs.map((h) => h.start));
        const end = Math.max(...hs.map((h) => h.end));
        const byStart = (x, y) => x.start - y.start || x.end - y.end;
        const o = apply(base, start, end, hs.filter((h) => h.side === "ours").sort(byStart));
        const t = apply(base, start, end, hs.filter((h) => h.side === "theirs").sort(byStart));
        if (o.join("") === t.join("")) {
            pieces.push({ start, end, tokens: o, side: "ours" });
            continue;
        }
        const combined = retry ? retry(base.slice(start, end).join(""), o.join(""), t.join("")) : null;
        if (combined === null)
            return null;
        pieces.push({ start, end, tokens: [combined], side: "ours" });
    }
    pieces.sort((x, y) => x.start - y.start || x.end - y.end);
    return apply(base, 0, base.length, pieces).join("");
}
