import { type Digest, type Json } from "./harnessJson.js";
export declare const HOOK_SLOTS: readonly ["prepareStep", "stopWhen", "turnLimits", "compaction"];
export type HookSlot = typeof HOOK_SLOTS[number];
export type Parameter = string | number | boolean;
export type ParameterSpec = {
    type: "number" | "integer";
    minimum: number;
    maximum: number;
} | {
    type: "boolean";
} | {
    type: "string";
    enum: string[];
};
export declare function installedName(value: unknown, path: string): string;
export declare function hookParameters(specs: Record<string, ParameterSpec>, input: unknown, path: string): Record<string, Parameter>;
export declare function normalizeHarnessRegistry(input: unknown): {
    registry: {
        format: 1;
        tools: Record<string, {
            implementationHash: Digest;
            schemaHash: Digest;
            inputSchema: Record<string, Json>;
            outputSchema: Json;
            description: string;
            parameterDescriptionPaths: string[];
            effect: "read" | "write" | "unknown";
        }>;
        hooks: Partial<Record<"prepareStep" | "stopWhen" | "turnLimits" | "compaction", Record<string, {
            implementationHash: Digest;
            parameters: Record<string, ParameterSpec>;
            defaults: Record<string, Parameter>;
            parameterSchema: Json;
            parameterSchemaHash: Digest;
            order: number;
            staticHints: string;
        }>>>;
    };
    registryHash: `sha256:${string}`;
};
export declare function harnessOwner(registryInput: unknown, envelopeInput: unknown): {
    registry: {
        format: 1;
        tools: Record<string, {
            implementationHash: Digest;
            schemaHash: Digest;
            inputSchema: Record<string, Json>;
            outputSchema: Json;
            description: string;
            parameterDescriptionPaths: string[];
            effect: "read" | "write" | "unknown";
        }>;
        hooks: Partial<Record<"prepareStep" | "stopWhen" | "turnLimits" | "compaction", Record<string, {
            implementationHash: Digest;
            parameters: Record<string, ParameterSpec>;
            defaults: Record<string, Parameter>;
            parameterSchema: Json;
            parameterSchemaHash: Digest;
            order: number;
            staticHints: string;
        }>>>;
    };
    registryHash: `sha256:${string}`;
    envelope: {
        format: 1;
        registryHash: `sha256:${string}`;
        allowedTools: string[];
        requiredTools: string[];
        defaultTools: string[];
        allowedHooks: Partial<Record<"prepareStep" | "stopWhen" | "turnLimits" | "compaction", string[]>>;
        requiredHooks: ("prepareStep" | "stopWhen" | "turnLimits" | "compaction")[];
        defaultHooks: Partial<Record<"prepareStep" | "stopWhen" | "turnLimits" | "compaction", {
            profile: string;
            parameters: Record<string, Parameter>;
        }>>;
        fileLimits: import("./harnessFiles.js").FileLimits;
        staticLimits: import("./harnessBudget.js").StaticLimits;
        ownerRules: string;
        systemField: string;
    };
    envelopeHash: `sha256:${string}`;
};
export type HarnessOwner = ReturnType<typeof harnessOwner>;
