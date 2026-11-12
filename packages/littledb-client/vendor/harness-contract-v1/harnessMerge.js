import { canonicalJson } from "./hash.js";
import { merge3 } from "./merge.js";
import { skillMetadata } from "./harnessFiles.js";
import { HarnessContractError, object, pointer } from "./harnessJson.js";
import { readHarnessContent } from "./harnessContent.js";
import { HOOK_SLOTS } from "./harnessRegistry.js";
/** No composer: all conflicts preserve the live value and invalidate the result as a whole. */
export function mergeHarnessFiles(base, ours, live, staleOperation = false) {
    object(base);
    object(ours);
    object(live);
    const files = {}, conflicts = [];
    if (staleOperation)
        return { files: null, conflicts: [{ path: "/files", reason: "Stale split/extract requires a new base" }] };
    for (const path of [...new Set([...Object.keys(base), ...Object.keys(ours), ...Object.keys(live)])].sort()) {
        const b = base[path], o = ours[path], t = live[path];
        const result = merge3({ value: b }, { value: o }, { value: t });
        let metadataConflict = false;
        if (path.endsWith("/SKILL.md") && b !== undefined && o !== undefined && t !== undefined && o !== b && t !== b) {
            const before = canonicalJson(skillMetadata(b, path)), mine = canonicalJson(skillMetadata(o, path)), theirs = canonicalJson(skillMetadata(t, path));
            metadataConflict = mine !== before && theirs !== before && mine !== theirs;
        }
        if (!result.clean || metadataConflict)
            conflicts.push({ path: `/files/${pointer(path)}`, reason: metadataConflict ? "Conflicting skill metadata" : "Conflicting file edits" });
        if (result.content.value !== undefined)
            files[path] = result.content.value;
    }
    return { files: conflicts.length ? null : files, conflicts };
}
/** Bindings never merge across installations; descriptions/scalars have no text composer. */
export function mergeHarnessContent(base, ours, live, staleOperation = false) {
    const b = readHarnessContent(base, true), o = readHarnessContent(ours, true), t = readHarnessContent(live, true);
    const mergedFiles = mergeHarnessFiles(b.files, o.files, t.files, staleOperation), conflicts = [...mergedFiles.conflicts];
    const out = { harnessFormat: 1, files: mergedFiles.files ?? t.files, tools: {}, hooks: {} };
    const same = (a, z) => canonicalJson(a) === canonicalJson(z);
    const scalar = (before, mine, theirs, path) => {
        if (same(mine, theirs) || same(theirs, before))
            return mine;
        if (same(mine, before))
            return theirs;
        conflicts.push({ path, reason: "Conflicting scalar/selector edits" });
        return theirs;
    };
    for (const field of ["system", "instructions", "model", "temperature"]) {
        const v = scalar(b[field], o[field], t[field], `/${field}`);
        if (v !== undefined)
            Object.assign(out, { [field]: v });
    }
    for (const name of [...new Set([...Object.keys(b.tools), ...Object.keys(o.tools), ...Object.keys(t.tools)])].sort()) {
        const before = b.tools[name], mine = o.tools[name], theirs = t.tools[name], path = `/tools/${pointer(name)}`;
        const binding = (v) => v && [v.implementationHash, v.schemaHash];
        if (!same(binding(before), binding(mine)) || !same(binding(before), binding(theirs))) {
            conflicts.push({ path, reason: "Installed tool binding changed" });
            continue;
        }
        if (!before || !mine || !theirs)
            continue;
        const selected = { ...theirs };
        for (const field of ["enabled", "description"]) {
            const v = scalar(before[field], mine[field], theirs[field], `${path}/${field}`);
            if (v === undefined)
                delete selected[field];
            else
                Object.assign(selected, { [field]: v });
        }
        selected.parameterDescriptions = {};
        for (const target of [...new Set([before, mine, theirs].flatMap(v => Object.keys(v.parameterDescriptions ?? {})))].sort()) {
            const v = scalar(before.parameterDescriptions?.[target], mine.parameterDescriptions?.[target], theirs.parameterDescriptions?.[target], `${path}/parameterDescriptions/${pointer(target)}`);
            if (v !== undefined)
                selected.parameterDescriptions[target] = v;
        }
        out.tools[name] = selected;
    }
    for (const slot of HOOK_SLOTS) {
        const before = b.hooks[slot], mine = o.hooks[slot], theirs = t.hooks[slot], path = `/hooks/${slot}`;
        const binding = (v) => v && [v.implementationHash, v.parameterSchemaHash];
        // A profile switch changes bindings and parameters atomically; no field-by-field composition.
        if (mine?.profile === before?.profile && theirs?.profile === before?.profile && (!same(binding(before), binding(mine)) || !same(binding(before), binding(theirs)))) {
            conflicts.push({ path, reason: "Installed hook binding changed" });
            continue;
        }
        const v = scalar(before, mine, theirs, path);
        if (v !== undefined)
            out.hooks[slot] = v;
    }
    if (!conflicts.length)
        try {
            readHarnessContent(out, true);
        }
        catch (error) {
            if (!(error instanceof HarnessContractError))
                throw error;
            conflicts.push({ path: error.problem.path, reason: "Combined content is invalid" });
        }
    return { content: conflicts.length ? null : out, conflicts, requiresValidation: true, requiresEvaluation: true };
}
