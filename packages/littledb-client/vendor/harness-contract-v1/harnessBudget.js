import { integer, invalid, object, text, utf8Bytes } from "./harnessJson.js";
export const STATIC_LIMITS = { maxStaticUnits: 8000, maxCatalogUnits: 2000, maxDescriptionUnits: 128, maxByteStaticUnits: 32000, maxByteCatalogUnits: 8000, maxByteDescriptionUnits: 512, framingUnits: 256 };
export function staticLimits(input = {}) {
    const obj = object(input, "/budget", [...Object.keys(STATIC_LIMITS), "inputWindow"]);
    const out = Object.fromEntries(Object.entries(STATIC_LIMITS).map(([key, value]) => [key, integer(obj[key] ?? value, `/budget/${key}`, key === "framingUnits" ? 0 : 1)]));
    if (obj.inputWindow !== undefined)
        out.inputWindow = integer(obj.inputWindow, "/budget/inputWindow", 1);
    return out;
}
/** Exact counts are trusted caller data; missing/invalid refinement selects the built-in profile. */
export function accountHarnessStatic(parts, input = {}, refinement) {
    const limits = staticLimits(input), names = Object.keys(object(parts)).sort();
    if (names.length > 256)
        invalid("/parts", "size", "Too many static components");
    let exact = false;
    if (refinement)
        try {
            const r = object(refinement, "/counter", ["profile", "units"]), units = object(r.units);
            exact = typeof r.profile === "string" && /^[a-z0-9][a-z0-9.-]{0,63}$/.test(r.profile) &&
                Object.keys(units).length === names.length && names.every(k => Object.hasOwn(units, k) && Number.isSafeInteger(units[k]) && units[k] >= 0) &&
                Number.isSafeInteger(limits.framingUnits + names.reduce((sum, k) => sum + units[k], 0));
        }
        catch { /* Bad/unavailable refinement uses the built-in conservative profile. */ }
    let total = limits.framingUnits, catalog = 0;
    const violations = [], units = {};
    for (const name of names) {
        const part = object(parts[name], `/parts/${name}`, ["text", "category"]);
        const body = text(part.text, `/parts/${name}/text`);
        if (typeof part.category !== "string" || !["owner", "system", "catalog", "tools", "hints", "description"].includes(part.category))
            invalid(`/parts/${name}/category`, "category", "Unsupported static component category");
        const charge = exact ? refinement.units[name] : utf8Bytes(body);
        units[name] = charge;
        total += charge;
        if (part.category === "catalog" || part.category === "description")
            catalog += charge;
        if (part.category === "description" && charge > (exact ? limits.maxDescriptionUnits : limits.maxByteDescriptionUnits))
            violations.push(`description:${name}`);
    }
    // For a known token window, bytes remain a conservative upper bound: never assume 4 bytes/token.
    const cap = Math.min(exact ? limits.maxStaticUnits : limits.maxByteStaticUnits, limits.inputWindow === undefined ? Infinity : Math.floor(limits.inputWindow / 10));
    if (total > cap)
        violations.push("static");
    if (catalog > (exact ? limits.maxCatalogUnits : limits.maxByteCatalogUnits))
        violations.push("catalog");
    return { profile: exact ? refinement.profile : "utf8-static-v1", unit: exact ? "tokens" : "bytes", units, framingUnits: limits.framingUnits, totalUnits: total, cap, violations, pass: violations.length === 0 };
}
