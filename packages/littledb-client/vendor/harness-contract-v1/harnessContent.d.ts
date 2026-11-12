import { type Digest } from "./harnessJson.js";
import { type ExactAccounting, type StaticPart } from "./harnessBudget.js";
import { type HarnessOwner, type HookSlot, type Parameter } from "./harnessRegistry.js";
export type ToolSelection = {
    enabled?: boolean;
    description?: string;
    parameterDescriptions?: Record<string, string>;
    implementationHash?: Digest;
    schemaHash?: Digest;
};
export type HookSelection = {
    profile: string;
    parameters: Record<string, Parameter>;
    implementationHash?: Digest;
    parameterSchemaHash?: Digest;
};
export type HarnessContent = {
    harnessFormat: 1;
    files: Record<string, string>;
    system?: string;
    instructions?: string;
    model?: string;
    temperature?: number;
    tools: Record<string, ToolSelection>;
    hooks: Partial<Record<HookSlot, HookSelection>>;
};
export type HarnessRequest = Omit<HarnessContent, "tools" | "hooks"> & {
    tools?: Record<string, Omit<ToolSelection, "implementationHash" | "schemaHash">>;
    hooks?: Partial<Record<HookSlot, Omit<HookSelection, "implementationHash" | "parameterSchemaHash">>>;
};
export type AdmittedHarnessContent = Omit<HarnessContent, "tools" | "hooks"> & {
    tools: Record<string, Required<ToolSelection>>;
    hooks: Partial<Record<HookSlot, Required<HookSelection>>>;
};
/** Shape validation is separate from installed/envelope validation; requests cannot supply stamps. */
export declare function readHarnessContent(input: unknown, stamped: boolean): HarnessContent;
export declare function resolveHarnessContent(input: unknown, owner: HarnessOwner, stamped: boolean, refinement?: ExactAccounting): {
    content: AdmittedHarnessContent;
    contentHash: `sha256:${string}`;
    files: {
        files: Record<string, string>;
        skills: {
            name: string;
            description: string;
            license?: string;
            compatibility?: string;
            path: string;
        }[];
        links: {
            [k: string]: string[];
        };
        manifest: {
            path: string;
            bytes: number;
            hash: `sha256:${string}`;
        }[];
        totalBytes: number;
        bundleHash: `sha256:${string}`;
    };
    tools: {
        name: string;
        enabled: boolean;
        description: string;
        implementationHash: `sha256:${string}`;
        schemaHash: `sha256:${string}`;
        inputSchema: Record<string, import("./harnessJson.js").Json>;
        outputSchema: import("./harnessJson.js").Json;
        displayInputSchema: Record<string, import("./harnessJson.js").Json>;
        displayHash: `sha256:${string}`;
        effect: "unknown" | "read" | "write";
    }[];
    hooks: {
        order: number;
        staticHints: string;
        profile: string;
        parameters: Record<string, Parameter>;
        implementationHash?: Digest;
        parameterSchemaHash?: Digest;
        slot: "prepareStep" | "stopWhen" | "turnLimits" | "compaction";
    }[];
    parts: Record<string, StaticPart>;
    budget: {
        profile: string;
        unit: "tokens" | "bytes";
        units: Record<string, number>;
        framingUnits: number;
        totalUnits: number;
        cap: number;
        violations: string[];
        pass: boolean;
    };
    registryHash: `sha256:${string}`;
    envelopeHash: `sha256:${string}`;
};
/** Trusted admission boundary stamps IDs; caller, not this pure function, authenticates admission. */
export declare function admitHarnessContent(request: unknown, registry: unknown, envelope: unknown, refinement?: ExactAccounting): {
    content: AdmittedHarnessContent;
    contentHash: `sha256:${string}`;
    files: {
        files: Record<string, string>;
        skills: {
            name: string;
            description: string;
            license?: string;
            compatibility?: string;
            path: string;
        }[];
        links: {
            [k: string]: string[];
        };
        manifest: {
            path: string;
            bytes: number;
            hash: `sha256:${string}`;
        }[];
        totalBytes: number;
        bundleHash: `sha256:${string}`;
    };
    tools: {
        name: string;
        enabled: boolean;
        description: string;
        implementationHash: `sha256:${string}`;
        schemaHash: `sha256:${string}`;
        inputSchema: Record<string, import("./harnessJson.js").Json>;
        outputSchema: import("./harnessJson.js").Json;
        displayInputSchema: Record<string, import("./harnessJson.js").Json>;
        displayHash: `sha256:${string}`;
        effect: "unknown" | "read" | "write";
    }[];
    hooks: {
        order: number;
        staticHints: string;
        profile: string;
        parameters: Record<string, Parameter>;
        implementationHash?: Digest;
        parameterSchemaHash?: Digest;
        slot: "prepareStep" | "stopWhen" | "turnLimits" | "compaction";
    }[];
    parts: Record<string, StaticPart>;
    budget: {
        profile: string;
        unit: "tokens" | "bytes";
        units: Record<string, number>;
        framingUnits: number;
        totalUnits: number;
        cap: number;
        violations: string[];
        pass: boolean;
    };
    registryHash: `sha256:${string}`;
    envelopeHash: `sha256:${string}`;
};
/** Strict evaluation validation never substitutes a default for a stale installation. */
export declare function validateHarnessContent(content: unknown, registry: unknown, envelope: unknown, refinement?: ExactAccounting): {
    content: AdmittedHarnessContent;
    contentHash: `sha256:${string}`;
    files: {
        files: Record<string, string>;
        skills: {
            name: string;
            description: string;
            license?: string;
            compatibility?: string;
            path: string;
        }[];
        links: {
            [k: string]: string[];
        };
        manifest: {
            path: string;
            bytes: number;
            hash: `sha256:${string}`;
        }[];
        totalBytes: number;
        bundleHash: `sha256:${string}`;
    };
    tools: {
        name: string;
        enabled: boolean;
        description: string;
        implementationHash: `sha256:${string}`;
        schemaHash: `sha256:${string}`;
        inputSchema: Record<string, import("./harnessJson.js").Json>;
        outputSchema: import("./harnessJson.js").Json;
        displayInputSchema: Record<string, import("./harnessJson.js").Json>;
        displayHash: `sha256:${string}`;
        effect: "unknown" | "read" | "write";
    }[];
    hooks: {
        order: number;
        staticHints: string;
        profile: string;
        parameters: Record<string, Parameter>;
        implementationHash?: Digest;
        parameterSchemaHash?: Digest;
        slot: "prepareStep" | "stopWhen" | "turnLimits" | "compaction";
    }[];
    parts: Record<string, StaticPart>;
    budget: {
        profile: string;
        unit: "tokens" | "bytes";
        units: Record<string, number>;
        framingUnits: number;
        totalUnits: number;
        cap: number;
        violations: string[];
        pass: boolean;
    };
    registryHash: `sha256:${string}`;
    envelopeHash: `sha256:${string}`;
};
