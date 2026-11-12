import { digest, hash, object } from "./harnessJson.js";
import { validateHarnessContent } from "./harnessContent.js";
export const EXECUTION_PIN_KEYS = ["runtime", "renderer", "accounting", "model", "toolState", "memorySnapshot"];
/** Identity of declared immutable inputs, not installation, authorization or evidence attestation. */
export function harnessExecutionIdentity(content, registry, envelope, pinsInput, refinement) {
    const snapshot = validateHarnessContent(content, registry, envelope, refinement);
    const raw = object(pinsInput, "/pins", EXECUTION_PIN_KEYS);
    const pins = Object.fromEntries(EXECUTION_PIN_KEYS.map(k => [k, hash(raw[k], `/pins/${k}`)]));
    const descriptor = { format: 1, contentHash: snapshot.contentHash, manifest: snapshot.files.manifest, tools: snapshot.tools, hooks: snapshot.hooks, registryHash: snapshot.registryHash, envelopeHash: snapshot.envelopeHash, budget: snapshot.budget, pins };
    return { descriptor, executionHash: digest(descriptor) };
}
