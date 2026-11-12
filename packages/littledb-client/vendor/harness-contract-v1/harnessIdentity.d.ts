import type { ExactAccounting } from "./harnessBudget.js";
export declare const EXECUTION_PIN_KEYS: readonly ["runtime", "renderer", "accounting", "model", "toolState", "memorySnapshot"];
/** Identity of declared immutable inputs, not installation, authorization or evidence attestation. */
export declare function harnessExecutionIdentity(content: unknown, registry: unknown, envelope: unknown, pinsInput: unknown, refinement?: ExactAccounting): {
    descriptor: {
        format: number;
        contentHash: `sha256:${string}`;
        manifest: {
            path: string;
            bytes: number;
            hash: `sha256:${string}`;
        }[];
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
        registryHash: `sha256:${string}`;
        envelopeHash: `sha256:${string}`;
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
        pins: {
            [k: string]: `sha256:${string}`;
        };
    };
    executionHash: `sha256:${string}`;
};
