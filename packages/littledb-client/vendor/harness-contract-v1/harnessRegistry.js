import { digest, hash, integer, invalid, json, object, pointer, text, unsafeKey } from "./harnessJson.js";
import { overlayParameterDescriptions } from "./harnessTools.js";
import { fileLimits } from "./harnessFiles.js";
import { staticLimits } from "./harnessBudget.js";
export const HOOK_SLOTS = ["prepareStep", "stopWhen", "turnLimits", "compaction"];
export function installedName(value, path) {
    const name = text(value, path, 128);
    if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(name) || unsafeKey(name))
        invalid(path, "name", "Expected a canonical installed name");
    return name;
}
function names(value, path) {
    if (!Array.isArray(value) || value.length > 64)
        invalid(path, "names", "Expected at most 64 unique installed names");
    const out = value.map(v => installedName(v, path));
    if (new Set(out).size !== out.length)
        invalid(path, "names", "Duplicate installed name");
    return out.sort();
}
function finite(value, path) {
    if (typeof value !== "number" || !Number.isFinite(value))
        invalid(path, "number", "Expected a finite number");
    return value;
}
function parameterSpec(value, path) {
    const p = object(value, path), type = p.type;
    if (type === "number" || type === "integer") {
        object(p, path, ["type", "minimum", "maximum"]);
        const minimum = finite(p.minimum, path), maximum = finite(p.maximum, path);
        if (minimum > maximum || (type === "integer" && (!Number.isSafeInteger(minimum) || !Number.isSafeInteger(maximum))))
            invalid(path, "bounds", "Invalid installed parameter bounds");
        return { type, minimum, maximum };
    }
    if (type === "boolean") {
        object(p, path, ["type"]);
        return { type };
    }
    if (type === "string") {
        object(p, path, ["type", "enum"]);
        if (!Array.isArray(p.enum) || !p.enum.length || p.enum.length > 32)
            invalid(path, "enum", "Expected bounded enumerated strings");
        const values = p.enum.map(v => text(v, path, 128));
        if (new Set(values).size !== values.length)
            invalid(path, "enum", "Duplicate enum value");
        return { type, enum: values.sort() };
    }
    return invalid(path, "parameter_schema", "Only flat bounded typed parameters are supported");
}
export function hookParameters(specs, input, path) {
    const values = object(input, path, Object.keys(specs)), out = {};
    for (const key of Object.keys(specs).sort()) {
        const spec = specs[key], v = values[key], at = `${path}/${pointer(key)}`;
        if (spec.type === "boolean") {
            if (typeof v !== "boolean")
                invalid(at, "parameter", "Expected a boolean");
        }
        else if (spec.type === "string") {
            if (typeof v !== "string" || !spec.enum.includes(v))
                invalid(at, "parameter", "Value outside installed enum");
        }
        else if (typeof v !== "number" || !Number.isFinite(v) || v < spec.minimum || v > spec.maximum || (spec.type === "integer" && !Number.isSafeInteger(v)))
            invalid(at, "parameter", "Value outside installed numeric bounds");
        out[key] = v;
    }
    return out;
}
export function normalizeHarnessRegistry(input) {
    const raw = object(json(input), "/registry", ["format", "tools", "hooks"]);
    if (raw.format !== 1)
        invalid("/registry/format", "format", "Unsupported registry format");
    const tools = {};
    const sourceTools = object(raw.tools, "/registry/tools");
    if (Object.keys(sourceTools).length > 64)
        invalid("/registry/tools", "size", "Too many installed tools");
    for (const name of Object.keys(sourceTools).sort()) {
        const path = `/registry/tools/${pointer(installedName(name, "/registry/tools"))}`;
        const t = object(sourceTools[name], path, ["implementationHash", "inputSchema", "outputSchema", "description", "parameterDescriptionPaths", "effect"]);
        const inputSchema = object(t.inputSchema, path), outputSchema = (t.outputSchema ?? null);
        if (!Array.isArray(t.parameterDescriptionPaths) || t.parameterDescriptionPaths.length > 128)
            invalid(path, "pointer", "Expected bounded owner-allowed description pointers");
        const paths = t.parameterDescriptionPaths.map(p => text(p, path, 512)).sort();
        if (new Set(paths).size !== paths.length)
            invalid(path, "pointer", "Duplicate pointer");
        overlayParameterDescriptions(inputSchema, {}, paths);
        if (typeof t.effect !== "string" || !["read", "write", "unknown"].includes(t.effect))
            invalid(path, "effect", "Unsupported tool effect class");
        tools[name] = { implementationHash: hash(t.implementationHash, path), schemaHash: digest({ inputSchema, outputSchema }), inputSchema, outputSchema, description: text(t.description, path, 4096), parameterDescriptionPaths: paths, effect: t.effect };
    }
    const hooks = {};
    const sourceHooks = object(raw.hooks ?? {}, "/registry/hooks", HOOK_SLOTS);
    for (const slot of HOOK_SLOTS)
        if (sourceHooks[slot] !== undefined) {
            const profiles = object(sourceHooks[slot], `/registry/hooks/${slot}`), out = {};
            if (Object.keys(profiles).length > 32)
                invalid(`/registry/hooks/${slot}`, "size", "Too many installed hook profiles");
            for (const name of Object.keys(profiles).sort()) {
                const path = `/registry/hooks/${slot}/${pointer(installedName(name, "/registry/hooks"))}`;
                const h = object(profiles[name], path, ["implementationHash", "parameters", "defaults", "order", "staticHints"]), specs = object(h.parameters, path);
                if (Object.keys(specs).length > 32)
                    invalid(path, "size", "Too many hook parameters");
                const parameters = Object.fromEntries(Object.keys(specs).sort().map(k => [installedName(k, path), parameterSpec(specs[k], `${path}/${pointer(k)}`)]));
                const parameterSchema = { type: "object", properties: parameters, required: Object.keys(parameters), additionalProperties: false };
                out[name] = { implementationHash: hash(h.implementationHash, path), parameters, defaults: hookParameters(parameters, h.defaults, path), parameterSchema, parameterSchemaHash: digest(parameterSchema), order: integer(h.order, path, 0, 1000), staticHints: text(h.staticHints, path, 4096) };
            }
            hooks[slot] = out;
        }
    const registry = { format: 1, tools, hooks };
    return { registry, registryHash: digest(registry) };
}
export function harnessOwner(registryInput, envelopeInput) {
    const { registry, registryHash } = normalizeHarnessRegistry(registryInput);
    const e = object(json(envelopeInput), "/envelope", ["format", "registryHash", "allowedTools", "requiredTools", "defaultTools", "allowedHooks", "requiredHooks", "defaultHooks", "fileLimits", "staticLimits", "ownerRules", "systemField"]);
    if (e.format !== 1 || hash(e.registryHash, "/envelope/registryHash") !== registryHash)
        invalid("/envelope", "registry", "Envelope must bind the installed registry");
    const allowedTools = names(e.allowedTools, "/envelope/allowedTools"), requiredTools = names(e.requiredTools, "/envelope/requiredTools"), defaultTools = names(e.defaultTools, "/envelope/defaultTools");
    if (allowedTools.some(n => !Object.hasOwn(registry.tools, n)) || [...requiredTools, ...defaultTools].some(n => !allowedTools.includes(n)) || requiredTools.some(n => !defaultTools.includes(n)))
        invalid("/envelope", "tools", "Invalid allowed/required/default tool sets");
    const rawAllowed = object(e.allowedHooks ?? {}, "/envelope/allowedHooks", HOOK_SLOTS), rawDefaults = object(e.defaultHooks ?? {}, "/envelope/defaultHooks", HOOK_SLOTS);
    const requiredHooks = names(e.requiredHooks ?? [], "/envelope/requiredHooks");
    if (requiredHooks.some(slot => !HOOK_SLOTS.includes(slot)))
        invalid("/envelope/requiredHooks", "slot", "Unknown hook slot");
    const allowedHooks = {}, defaultHooks = {};
    for (const slot of HOOK_SLOTS) {
        const allowed = names(rawAllowed[slot] ?? [], `/envelope/allowedHooks/${slot}`);
        allowedHooks[slot] = allowed;
        if (allowed.some(n => !Object.hasOwn(registry.hooks[slot] ?? {}, n)))
            invalid(`/envelope/allowedHooks/${slot}`, "hook", "Uninstalled hook profile");
        if (rawDefaults[slot] !== undefined) {
            const d = object(rawDefaults[slot], `/envelope/defaultHooks/${slot}`, ["profile", "parameters"]), profile = installedName(d.profile, "/envelope/defaultHooks");
            if (!allowed.includes(profile))
                invalid(`/envelope/defaultHooks/${slot}`, "hook", "Default hook must be owner-allowed");
            const h = registry.hooks[slot][profile];
            defaultHooks[slot] = { profile, parameters: hookParameters(h.parameters, { ...h.defaults, ...object(d.parameters ?? {}) }, `/envelope/defaultHooks/${slot}`) };
        }
        else if (requiredHooks.includes(slot))
            invalid(`/envelope/defaultHooks/${slot}`, "required", "Required hook needs an installed default");
    }
    const systemField = e.systemField ?? "system";
    if (systemField !== "system" && systemField !== "instructions")
        invalid("/envelope/systemField", "field", "Unsupported prompt field");
    const envelope = { format: 1, registryHash, allowedTools, requiredTools, defaultTools, allowedHooks, requiredHooks, defaultHooks, fileLimits: fileLimits(e.fileLimits), staticLimits: staticLimits(e.staticLimits), ownerRules: text(e.ownerRules ?? "", "/envelope/ownerRules"), systemField };
    return { registry, registryHash, envelope, envelopeHash: digest(envelope) };
}
