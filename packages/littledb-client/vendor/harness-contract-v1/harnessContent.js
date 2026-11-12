import { canonicalJson } from "./hash.js";
import { digest, hash, invalid, json, object, pointer, text } from "./harnessJson.js";
import { parseHarnessFiles } from "./harnessFiles.js";
import { accountHarnessStatic } from "./harnessBudget.js";
import { harnessOwner, hookParameters, HOOK_SLOTS, installedName } from "./harnessRegistry.js";
import { overlayParameterDescriptions } from "./harnessTools.js";
/** Shape validation is separate from installed/envelope validation; requests cannot supply stamps. */
export function readHarnessContent(input, stamped) {
    const raw = object(json(input), "", ["harnessFormat", "files", "system", "instructions", "model", "temperature", "tools", "hooks"]);
    if (raw.harnessFormat !== 1)
        invalid("/harnessFormat", "format", "Unsupported harness format");
    if (stamped && (raw.tools === undefined || raw.hooks === undefined))
        invalid("/tools", "stamps", "Admitted content requires expanded tool/hook maps");
    const files = parseHarnessFiles(raw.files).files, tools = {}, hooks = {};
    const content = { harnessFormat: 1, files, tools, hooks };
    for (const field of ["system", "instructions", "model"])
        if (raw[field] !== undefined)
            content[field] = text(raw[field], `/${field}`, field === "model" ? 128 : 1_048_576);
    if (content.system !== undefined && content.instructions !== undefined)
        invalid("/system", "field", "Use only the application's existing prompt field");
    if (raw.temperature !== undefined) {
        if (typeof raw.temperature !== "number" || raw.temperature < 0 || raw.temperature > 2)
            invalid("/temperature", "number", "Temperature must be finite and between zero and two");
        content.temperature = raw.temperature;
    }
    const sourceTools = object(raw.tools ?? {}, "/tools");
    if (Object.keys(sourceTools).length > 64)
        invalid("/tools", "size", "Too many tool selectors");
    for (const name of Object.keys(sourceTools).sort()) {
        const path = `/tools/${pointer(installedName(name, "/tools"))}`;
        const t = object(sourceTools[name], path, ["enabled", "description", "parameterDescriptions", ...(stamped ? ["implementationHash", "schemaHash"] : [])]), out = {};
        if (t.enabled !== undefined) {
            if (typeof t.enabled !== "boolean")
                invalid(path, "boolean", "enabled must be boolean");
            out.enabled = t.enabled;
        }
        if (t.description !== undefined)
            out.description = text(t.description, `${path}/description`, 4096);
        if (t.parameterDescriptions !== undefined) {
            const overlays = object(t.parameterDescriptions, `${path}/parameterDescriptions`);
            if (Object.keys(overlays).length > 128)
                invalid(path, "size", "Too many parameter descriptions");
            out.parameterDescriptions = Object.fromEntries(Object.entries(overlays).map(([k, v]) => [text(k, path, 512), text(v, path, 4096)]));
        }
        if (stamped) {
            out.implementationHash = hash(t.implementationHash, path);
            out.schemaHash = hash(t.schemaHash, path);
        }
        tools[name] = out;
    }
    const sourceHooks = object(raw.hooks ?? {}, "/hooks", HOOK_SLOTS);
    for (const slot of HOOK_SLOTS)
        if (sourceHooks[slot] !== undefined) {
            const path = `/hooks/${slot}`, h = object(sourceHooks[slot], path, ["profile", "parameters", ...(stamped ? ["implementationHash", "parameterSchemaHash"] : [])]);
            const parameters = object(h.parameters ?? {}, `${path}/parameters`);
            if (Object.keys(parameters).length > 32 || Object.values(parameters).some(v => !["string", "number", "boolean"].includes(typeof v)))
                invalid(path, "parameter", "Expected bounded flat literal parameters");
            const out = { profile: installedName(h.profile, path), parameters: parameters };
            if (stamped) {
                out.implementationHash = hash(h.implementationHash, path);
                out.parameterSchemaHash = hash(h.parameterSchemaHash, path);
            }
            hooks[slot] = out;
        }
    return content;
}
export function resolveHarnessContent(input, owner, stamped, refinement) {
    const content = readHarnessContent(input, stamped), { registry, envelope } = owner;
    if (content[envelope.systemField === "system" ? "instructions" : "system"] !== undefined)
        invalid("/system", "field", "Prompt field is not enabled for this subject");
    const files = parseHarnessFiles(content.files, envelope.fileLimits);
    for (const name of Object.keys(content.tools))
        if (!envelope.allowedTools.includes(name))
            invalid(`/tools/${pointer(name)}`, "capability", "Tool is not installed and owner-allowed");
    const parts = { owner: { text: envelope.ownerRules, category: "owner" }, prompt: { text: content.system ?? content.instructions ?? "", category: "system" } };
    for (const skill of files.skills)
        parts[`catalog:${skill.name}`] = { text: canonicalJson({ name: skill.name, description: skill.description, path: skill.path }), category: "description" };
    const tools = envelope.allowedTools.map(name => {
        const installed = registry.tools[name], selection = content.tools[name] ?? {};
        if (stamped && (selection.implementationHash !== installed.implementationHash || selection.schemaHash !== installed.schemaHash))
            invalid(`/tools/${pointer(name)}`, "stale", "Missing or changed installed tool digests");
        const enabled = selection.enabled ?? envelope.defaultTools.includes(name);
        if (!enabled && envelope.requiredTools.includes(name))
            invalid(`/tools/${pointer(name)}/enabled`, "required", "Mandatory tool cannot be disabled");
        const description = selection.description ?? installed.description, parameterDescriptions = selection.parameterDescriptions ?? {};
        const overlay = overlayParameterDescriptions(installed.inputSchema, parameterDescriptions, installed.parameterDescriptionPaths);
        content.tools[name] = { enabled, description, parameterDescriptions, implementationHash: installed.implementationHash, schemaHash: installed.schemaHash };
        const tool = { name, enabled, description, implementationHash: installed.implementationHash, schemaHash: installed.schemaHash, inputSchema: installed.inputSchema, outputSchema: installed.outputSchema, displayInputSchema: overlay.schema, displayHash: digest({ inputSchema: overlay.schema, outputSchema: installed.outputSchema }), effect: installed.effect };
        if (enabled)
            parts[`tool:${name}`] = { text: canonicalJson({ name, description, inputSchema: overlay.schema, outputSchema: installed.outputSchema }), category: "tools" };
        return tool;
    });
    const hooks = [];
    for (const slot of HOOK_SLOTS) {
        const selected = content.hooks[slot] ?? envelope.defaultHooks[slot];
        if (!selected)
            continue;
        if (!(envelope.allowedHooks[slot] ?? []).includes(selected.profile))
            invalid(`/hooks/${slot}`, "capability", "Hook profile is not installed and owner-allowed");
        const installed = registry.hooks[slot][selected.profile];
        if (stamped && (content.hooks[slot]?.implementationHash !== installed.implementationHash || content.hooks[slot]?.parameterSchemaHash !== installed.parameterSchemaHash))
            invalid(`/hooks/${slot}`, "stale", "Missing or changed installed hook digests");
        const parameters = hookParameters(installed.parameters, { ...installed.defaults, ...selected.parameters }, `/hooks/${slot}/parameters`);
        content.hooks[slot] = { profile: selected.profile, parameters, implementationHash: installed.implementationHash, parameterSchemaHash: installed.parameterSchemaHash };
        hooks.push({ slot, ...content.hooks[slot], order: installed.order, staticHints: installed.staticHints });
        parts[`hook:${slot}`] = { text: installed.staticHints, category: "hints" };
    }
    const budget = accountHarnessStatic(parts, envelope.staticLimits, refinement);
    return { content: content, contentHash: digest(content), files, tools, hooks, parts, budget, registryHash: owner.registryHash, envelopeHash: owner.envelopeHash };
}
/** Trusted admission boundary stamps IDs; caller, not this pure function, authenticates admission. */
export function admitHarnessContent(request, registry, envelope, refinement) {
    const snapshot = resolveHarnessContent(request, harnessOwner(registry, envelope), false, refinement);
    if (!snapshot.budget.pass)
        invalid("/budget", "budget", `Static context exceeds ${snapshot.budget.profile} limits`);
    return snapshot;
}
/** Strict evaluation validation never substitutes a default for a stale installation. */
export function validateHarnessContent(content, registry, envelope, refinement) {
    const snapshot = resolveHarnessContent(content, harnessOwner(registry, envelope), true, refinement);
    if (!snapshot.budget.pass)
        invalid("/budget", "budget", `Static context exceeds ${snapshot.budget.profile} limits`);
    return snapshot;
}
