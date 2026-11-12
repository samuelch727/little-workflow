import { object, pointer } from "./harnessJson.js";
import { harnessOwner, hookParameters, HOOK_SLOTS } from "./harnessRegistry.js";
import { readHarnessContent, resolveHarnessContent } from "./harnessContent.js";
import { overlayParameterDescriptions } from "./harnessTools.js";
function transition(input, registryInput, envelopeInput, rebase) {
    const content = readHarnessContent(input, true), owner = harnessOwner(registryInput, envelopeInput), { registry, envelope } = owner;
    const warnings = [], warn = (path, reason) => warnings.push({ event: "harness_selector_warning", path, reason });
    for (const name of Object.keys(content.tools)) {
        const path = `/tools/${pointer(name)}`, old = content.tools[name], installed = registry.tools[name];
        if (!envelope.allowedTools.includes(name) || !installed) {
            delete content.tools[name];
            warn(path, "tool_no_longer_allowed");
            continue;
        }
        const stale = old.implementationHash !== installed.implementationHash || old.schemaHash !== installed.schemaHash;
        const descriptions = {};
        let dropped = false;
        for (const [target, value] of Object.entries(old.parameterDescriptions ?? {})) {
            try {
                overlayParameterDescriptions(installed.inputSchema, { [target]: value }, installed.parameterDescriptionPaths);
                descriptions[target] = value;
            }
            catch {
                dropped = true;
                warn(`${path}/parameterDescriptions/${pointer(target)}`, "overlay_pointer_unavailable");
            }
        }
        let selection = {};
        if (rebase || (!stale && !dropped)) {
            if (old.enabled !== undefined)
                selection.enabled = old.enabled;
            if (old.description !== undefined)
                selection.description = old.description;
            selection.parameterDescriptions = descriptions;
        }
        if (stale || dropped)
            warn(path, rebase ? "tool_restamped_for_evaluation" : "stale_tool_installed_default");
        if (selection.enabled === false && envelope.requiredTools.includes(name)) {
            selection.enabled = true;
            warn(path, "required_tool_enabled");
        }
        content.tools[name] = selection;
    }
    for (const name of envelope.allowedTools)
        if (!Object.hasOwn(content.tools, name))
            warn(`/tools/${pointer(name)}`, "new_installed_tool_default");
    for (const slot of HOOK_SLOTS) {
        const old = content.hooks[slot], path = `/hooks/${slot}`;
        if (!old) {
            if (envelope.defaultHooks[slot])
                warn(path, "new_installed_hook_default");
            continue;
        }
        const installed = registry.hooks[slot]?.[old.profile];
        const allowed = installed && (envelope.allowedHooks[slot] ?? []).includes(old.profile);
        const stale = !allowed || old.implementationHash !== installed?.implementationHash || old.parameterSchemaHash !== installed?.parameterSchemaHash;
        try {
            if (!allowed || (!rebase && stale))
                throw new Error("default");
            const parameters = hookParameters(installed.parameters, { ...installed.defaults, ...object(old.parameters) }, `${path}/parameters`);
            content.hooks[slot] = { profile: old.profile, parameters };
            if (stale)
                warn(path, "hook_restamped_for_evaluation");
        }
        catch {
            delete content.hooks[slot];
            warn(path, "stale_hook_installed_default");
        }
    }
    const snapshot = resolveHarnessContent(content, owner, false);
    if (!snapshot.budget.pass)
        warn("/budget", "installed_context_budget_changed");
    return { ...snapshot, warnings };
}
/** Serving fallback is data only; the SDK emits warnings and still applies current effect vetoes. */
export function serveHarnessContent(content, registry, envelope) { return transition(content, registry, envelope, false); }
/** This is an unapproved proposal. Never serve the re-stamped overlay until normal evaluation passes. */
export function rebaseHarnessContent(content, registry, envelope) {
    return { ...transition(content, registry, envelope, true), kind: "changed_in_code", invalidatesEvidence: true, requiresEvaluation: true };
}
