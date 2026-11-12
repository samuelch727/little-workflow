import { type Json } from "./harnessJson.js";
/** Metadata overlays never mutate the installed schema or change validation keywords. */
export declare function overlayParameterDescriptions(schema: unknown, descriptions: unknown, allowed: readonly string[]): {
    schema: Record<string, Json>;
    canonicalHash: `sha256:${string}`;
    displayHash: `sha256:${string}`;
};
