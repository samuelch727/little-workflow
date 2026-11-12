export type HarnessWarning = {
    event: "harness_selector_warning";
    path: string;
    reason: string;
};
/** Serving fallback is data only; the SDK emits warnings and still applies current effect vetoes. */
export declare function serveHarnessContent(content: unknown, registry: unknown, envelope: unknown): {
    warnings: HarnessWarning[];
    content: import("./harnessContent.js").AdmittedHarnessContent;
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
        parameters: Record<string, import("./harnessRegistry.js").Parameter>;
        implementationHash?: import("./harnessJson.js").Digest;
        parameterSchemaHash?: import("./harnessJson.js").Digest;
        slot: "prepareStep" | "stopWhen" | "turnLimits" | "compaction";
    }[];
    parts: Record<string, import("./harnessBudget.js").StaticPart>;
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
/** This is an unapproved proposal. Never serve the re-stamped overlay until normal evaluation passes. */
export declare function rebaseHarnessContent(content: unknown, registry: unknown, envelope: unknown): {
    kind: "changed_in_code";
    invalidatesEvidence: true;
    requiresEvaluation: true;
    warnings: HarnessWarning[];
    content: import("./harnessContent.js").AdmittedHarnessContent;
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
        parameters: Record<string, import("./harnessRegistry.js").Parameter>;
        implementationHash?: import("./harnessJson.js").Digest;
        parameterSchemaHash?: import("./harnessJson.js").Digest;
        slot: "prepareStep" | "stopWhen" | "turnLimits" | "compaction";
    }[];
    parts: Record<string, import("./harnessBudget.js").StaticPart>;
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
