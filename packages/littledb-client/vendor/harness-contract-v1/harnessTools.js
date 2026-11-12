import { digest, invalid, json, object, pointer, text, unsafeKey } from "./harnessJson.js";
/** Metadata overlays never mutate the installed schema or change validation keywords. */
export function overlayParameterDescriptions(schema, descriptions, allowed) {
    const original = object(json(schema), "/inputSchema");
    const display = json(original);
    const overlays = object(descriptions, "/parameterDescriptions");
    const nodes = new Map();
    for (const path of allowed) {
        if (!/^\/properties\//.test(path) || /~(?![01])/.test(path))
            invalid("/parameterDescriptions", "pointer", "Expected an existing parameter node pointer");
        const parts = path.slice(1).split("/").map(s => s.replace(/~1/g, "/").replace(/~0/g, "~"));
        let node = display;
        // V1 supports object parameters nested through properties/items, not arbitrary object data.
        for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            if (unsafeKey(part) || !node || typeof node !== "object" || Array.isArray(node) || !Object.hasOwn(node, part))
                invalid(`/parameterDescriptions/${pointer(path)}`, "pointer", "Parameter node does not exist");
            if (part === "properties") {
                const key = parts[++i];
                const properties = object(node.properties);
                if (!key || unsafeKey(key) || !Object.hasOwn(properties, key))
                    invalid(`/parameterDescriptions/${pointer(path)}`, "pointer", "Parameter node does not exist");
                node = properties[key];
            }
            else if (part === "items")
                node = node.items;
            else
                invalid(`/parameterDescriptions/${pointer(path)}`, "pointer", "Unsupported parameter node pointer");
        }
        nodes.set(path, object(node));
    }
    for (const path of Object.keys(overlays).sort()) {
        const node = nodes.get(path);
        if (!node)
            invalid(`/parameterDescriptions/${pointer(path)}`, "pointer", "Description target is not owner-allowed");
        node.description = text(overlays[path], `/parameterDescriptions/${pointer(path)}`, 4096);
    }
    return { schema: display, canonicalHash: digest(original), displayHash: digest(display) };
}
