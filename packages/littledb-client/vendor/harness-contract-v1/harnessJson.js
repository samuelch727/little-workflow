import { contentHash, sha256 } from "./hash.js";
export class HarnessContractError extends Error {
    problem;
    constructor(problem) {
        super(`${problem.path || "/"}: ${problem.message}`);
        this.problem = problem;
        this.name = "HarnessContractError";
    }
}
export const pointer = (key) => key.replace(/~/g, "~0").replace(/\//g, "~1");
export function invalid(path, code, message) { throw new HarnessContractError({ path, code, message }); }
export const unsafeKey = (key) => ["__proto__", "prototype", "constructor"].includes(key);
export function object(value, path = "", keys) {
    if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
        invalid(path, "object", "Expected a plain object");
    const out = value;
    if (Object.getOwnPropertySymbols(out).length)
        invalid(path, "field", "Symbol fields are unsupported");
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(out))) {
        utf8Bytes(key, path);
        if (unsafeKey(key) || !descriptor.enumerable || descriptor.get || descriptor.set || (keys && !keys.includes(key)))
            invalid(`${path}/${pointer(key)}`, "field", "Unsupported field");
    }
    return out;
}
export function text(value, path, max = 1_048_576) {
    if (typeof value !== "string" || value.length > max)
        invalid(path, "text", "Expected bounded text");
    utf8Bytes(value, path);
    return value;
}
/** Exact UTF-8 size; reject lone surrogates rather than hashing replacement bytes. */
export function utf8Bytes(value, path = "") {
    let bytes = 0;
    for (let i = 0; i < value.length; i++) {
        const code = value.charCodeAt(i);
        if (code >= 0xd800 && code <= 0xdbff) {
            const next = value.charCodeAt(++i);
            if (!(next >= 0xdc00 && next <= 0xdfff))
                invalid(path, "unicode", "Invalid Unicode");
            bytes += 4;
        }
        else if (code >= 0xdc00 && code <= 0xdfff)
            invalid(path, "unicode", "Invalid Unicode");
        else
            bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : 3;
    }
    return bytes;
}
export function integer(value, path, min = 0, max = Number.MAX_SAFE_INTEGER) {
    if (!Number.isSafeInteger(value) || value < min || value > max)
        invalid(path, "integer", "Integer outside allowed bounds");
    return value;
}
export function json(value, path = "", depth = 0, budget = { nodes: 0 }) {
    if (++budget.nodes > 100_000 || depth > 32)
        invalid(path, "size", "JSON exceeds structural limits");
    if (value === null || typeof value === "boolean")
        return value;
    if (typeof value === "string")
        return text(value, path);
    if (typeof value === "number" && Number.isFinite(value))
        return value;
    if (Array.isArray(value)) {
        if (Object.getPrototypeOf(value) !== Array.prototype || value.length > 100_000 || Object.getOwnPropertySymbols(value).length)
            invalid(path, "array", "Expected a bounded JSON array");
        const descriptors = Object.getOwnPropertyDescriptors(value);
        if (Object.keys(descriptors).length !== value.length + 1)
            invalid(path, "array", "Sparse or extended arrays are unsupported");
        return Array.from({ length: value.length }, (_, i) => {
            const d = descriptors[i];
            if (!d || d.get || d.set || !d.enumerable)
                invalid(`${path}/${i}`, "array", "Expected an inert array item");
            return json(d.value, `${path}/${i}`, depth + 1, budget);
        });
    }
    const obj = object(value, path);
    return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, json(v, `${path}/${pointer(k)}`, depth + 1, budget)]));
}
export const digest = (value) => `sha256:${contentHash(json(value))}`;
export const textDigest = (value) => { utf8Bytes(value); return `sha256:${sha256(value)}`; };
export function hash(value, path) {
    if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value))
        invalid(path, "hash", "Expected a SHA-256 digest");
    return value;
}
