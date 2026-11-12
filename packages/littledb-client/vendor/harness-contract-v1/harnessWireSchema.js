import { HOOK_SLOTS } from "./harnessRegistry.js";
/** Shape schema only; installed/envelope/files/budget semantics require the portable validators. */
export function harnessWireSchema(stamped = false) {
    const text = { type: "string" }, digest = { type: "string", pattern: "^sha256:[a-f0-9]{64}$" };
    const names = { type: "string", maxLength: 128, pattern: "^[A-Za-z_][A-Za-z0-9_.-]*$", not: { enum: ["__proto__", "prototype", "constructor"] } };
    const tool = { type: "object", additionalProperties: false, ...(stamped ? { required: ["implementationHash", "schemaHash"] } : {}), properties: {
            enabled: { type: "boolean" }, description: { ...text, maxLength: 4096 }, parameterDescriptions: { type: "object", maxProperties: 128, additionalProperties: { ...text, maxLength: 4096 } },
            ...(stamped ? { implementationHash: digest, schemaHash: digest } : {}),
        } };
    const hook = { type: "object", additionalProperties: false, required: ["profile", ...(stamped ? ["implementationHash", "parameterSchemaHash"] : [])], properties: {
            profile: names, parameters: { type: "object", maxProperties: 32, propertyNames: names, additionalProperties: { type: ["string", "number", "boolean"] } },
            ...(stamped ? { implementationHash: digest, parameterSchemaHash: digest } : {}),
        } };
    return { $schema: "https://json-schema.org/draft/2020-12/schema", $id: `urn:littledb:harness:1:${stamped ? "admitted" : "request"}`, type: "object", additionalProperties: false,
        required: ["harnessFormat", "files", ...(stamped ? ["tools", "hooks"] : [])], not: { required: ["system", "instructions"] }, properties: {
            harnessFormat: { const: 1 }, files: { type: "object", maxProperties: 128, propertyNames: { maxLength: 512, pattern: "^(skills/[a-z0-9]+(-[a-z0-9]+)*/|references/)[A-Za-z0-9._/-]+\\.md$" }, additionalProperties: { ...text, maxLength: 65536 } },
            system: { ...text, maxLength: 1048576 }, instructions: { ...text, maxLength: 1048576 }, model: { ...text, maxLength: 128 }, temperature: { type: "number", minimum: 0, maximum: 2 },
            tools: { type: "object", maxProperties: 64, propertyNames: names, additionalProperties: tool }, hooks: { type: "object", additionalProperties: false, properties: Object.fromEntries(HOOK_SLOTS.map(slot => [slot, hook])) },
        },
    };
}
