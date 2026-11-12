import { digest, integer, invalid, object, pointer, text, textDigest, unsafeKey, utf8Bytes } from "./harnessJson.js";
export const FILE_LIMITS = { maxFiles: 128, maxFileBytes: 65_536, maxTotalBytes: 524_288, maxSkills: 32, maxReferenceDepth: 4 };
export function fileLimits(value = {}) {
    const obj = object(value, "/limits", Object.keys(FILE_LIMITS));
    return Object.fromEntries(Object.entries(FILE_LIMITS).map(([k, ceiling]) => [k, integer(obj[k] ?? ceiling, `/limits/${k}`, 1, ceiling)]));
}
export function filePath(path) {
    const segments = path.split("/");
    if (path.length > 512 || segments.some(s => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(s) || s.endsWith(".") || unsafeKey(s) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s)) || !path.endsWith(".md"))
        invalid(`/files/${pointer(path)}`, "path", "Expected a relative ASCII Markdown path");
    if (segments[0] !== "references" && !(segments[0] === "skills" && segments.length >= 3 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(segments[1])))
        invalid(`/files/${pointer(path)}`, "root", "Unsupported file root");
    if (segments[0] === "references" && segments.length < 2)
        invalid("/files", "path", "Reference needs a filename");
}
/** Portable literal-string frontmatter subset. Unsupported YAML features fail explicitly. */
export function skillMetadata(content, path) {
    const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
    if (!header)
        invalid(`/files/${pointer(path)}`, "frontmatter", "Missing SKILL.md frontmatter");
    const fields = {};
    for (const line of header[1].split(/\r?\n/)) {
        if (!line.trim())
            continue;
        const pair = /^([a-z-]+): +(.+)$/.exec(line);
        if (!pair || !["name", "description", "license", "compatibility"].includes(pair[1]) || Object.hasOwn(fields, pair[1]))
            invalid(`/files/${pointer(path)}`, "frontmatter", "Unsupported or duplicate metadata");
        let value = pair[2].trim();
        if (value.startsWith('"')) {
            try {
                value = JSON.parse(value);
            }
            catch {
                invalid(`/files/${pointer(path)}`, "frontmatter", "Invalid quoted scalar");
            }
        }
        else if (value.startsWith("'")) {
            if (!value.endsWith("'") || /(^|[^'])'([^']|$)/.test(value.slice(1, -1)))
                invalid(`/files/${pointer(path)}`, "frontmatter", "Invalid quoted scalar");
            value = value.slice(1, -1).replace(/''/g, "'");
        }
        else if (/^[\[\]{}&*!|>@`]|^[-?]\s|^(?:true|false|null|~|[-+]?\d[\d.eE+-]*)$|\s+#|:\s/.test(value))
            invalid(`/files/${pointer(path)}`, "frontmatter", "Only literal string scalars are supported");
        fields[pair[1]] = text(value, `/files/${pointer(path)}`, pair[1] === "description" ? 1024 : 500);
    }
    if (!fields.name || fields.name.length > 64 || fields.name !== path.split("/")[1] || !fields.description?.trim())
        invalid(`/files/${pointer(path)}`, "metadata", "Skill name must match its folder and description must be nonempty");
    return fields;
}
function headings(content) {
    const seen = new Map();
    return new Set([...content.matchAll(/^#{1,6} +(.+)$/gm)].map(m => {
        const key = m[1].toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").trim().replace(/\s/g, "-");
        const n = seen.get(key) ?? 0;
        seen.set(key, n + 1);
        return n ? `${key}-${n}` : key;
    }));
}
function dependencies(path, content, files) {
    const body = content.replace(/```[^\n]*\n[\s\S]*?```/g, "");
    const refs = new Map([...body.matchAll(/^ {0,3}\[([^\]]+)\]:\s*(\S+)/gm)].map(m => [m[1].toLowerCase(), m[2]]));
    const targets = [...body.matchAll(/!?\[[^\]\n]*\]\(([^)\n]+)\)/g)].map(m => m[1].trim());
    for (const m of body.matchAll(/!?\[([^\]\n]+)\]\[([^\]\n]*)\]/g)) {
        const ref = refs.get((m[2] || m[1]).toLowerCase());
        if (!ref)
            invalid(`/files/${pointer(path)}`, "link", "Undefined reference link");
        targets.push(ref);
    }
    targets.push(...refs.values());
    const out = new Set();
    for (let target of targets) {
        target = target.replace(/^<([^>]+)>$/, "$1").replace(/\s+"[^"]*"$/, "");
        if (/^https?:\/\//.test(target))
            continue; // citation only, never fetched
        const [relative, fragment] = target.split("#");
        if (relative?.startsWith("/") || /[:\\%?]/.test(relative ?? ""))
            invalid(`/files/${pointer(path)}`, "link", "Unsupported reference target");
        const parts = relative ? path.split("/").slice(0, -1) : path.split("/");
        for (const part of relative?.split("/") ?? []) {
            if (part === ".")
                continue;
            if (part === "..") {
                if (!parts.length)
                    invalid(`/files/${pointer(path)}`, "link", "Reference escapes bundle");
                parts.pop();
            }
            else
                parts.push(part);
        }
        const to = parts.join("/");
        if (!Object.hasOwn(files, to))
            invalid(`/files/${pointer(path)}`, "link", "Missing referenced file");
        if (fragment) {
            let decoded = fragment;
            try {
                decoded = decodeURIComponent(fragment);
            }
            catch {
                invalid(`/files/${pointer(path)}`, "link", "Invalid anchor");
            }
            if (!headings(files[to]).has(decoded))
                invalid(`/files/${pointer(path)}`, "link", "Missing reference anchor");
        }
        if (relative)
            out.add(to);
    }
    return [...out].sort();
}
export function parseHarnessFiles(input, bounds = {}) {
    const limits = fileLimits(bounds), raw = object(input, "/files"), paths = Object.keys(raw).sort();
    if (paths.length > limits.maxFiles)
        invalid("/files", "size", "Too many files");
    const files = {}, folded = new Set();
    let totalBytes = 0;
    for (const path of paths) {
        filePath(path);
        if (folded.has(path.toLowerCase()))
            invalid(`/files/${pointer(path)}`, "collision", "Case-colliding paths");
        folded.add(path.toLowerCase());
        const value = text(raw[path], `/files/${pointer(path)}`, limits.maxFileBytes);
        const bytes = utf8Bytes(value);
        if (value.includes("\0") || bytes > limits.maxFileBytes || (totalBytes += bytes) > limits.maxTotalBytes)
            invalid(`/files/${pointer(path)}`, "size", "File bytes exceed bounds");
        files[path] = value;
    }
    const skills = paths.filter(p => /^skills\/[^/]+\/SKILL\.md$/.test(p)).map(path => ({ path, ...skillMetadata(files[path], path) }));
    if (skills.length > limits.maxSkills)
        invalid("/files", "size", "Too many skills");
    const links = Object.fromEntries(paths.map(p => [p, dependencies(p, files[p], files)]));
    const reached = new Set(), heights = new Map();
    const walk = (path, ancestors) => {
        if (ancestors.includes(path))
            invalid(`/files/${pointer(path)}`, "cycle", "Cyclic file references");
        reached.add(path);
        if (heights.has(path))
            return heights.get(path);
        const height = 1 + Math.max(0, ...links[path].map(to => walk(to, [...ancestors, path])));
        heights.set(path, height);
        return height;
    };
    for (const skill of skills)
        if (walk(skill.path, []) > limits.maxReferenceDepth + 1)
            invalid(`/files/${pointer(skill.path)}`, "depth", "References exceed depth bound");
    if (paths.some(p => !reached.has(p)))
        invalid("/files", "unreachable", "Every resource must be reachable from a skill");
    const manifest = paths.map(path => ({ path, bytes: utf8Bytes(files[path]), hash: textDigest(files[path]) }));
    return { files, skills, links, manifest, totalBytes, bundleHash: digest(manifest) };
}
