import { HarnessInputError } from "../errors.js";

// Tool names a folder-discovered tool may not claim, because the runtime overlays them at turn
// assembly (e.g. `bash`) and would silently overwrite the discovered tool during object spread.
// createHarness rejects these for configured tools via assertSafeUserTools; the discovery path
// must reject them too rather than mask the author's tool with an unexpected runtime tool.
export const RESERVED_DISCOVERED_TOOL_NAMES = new Set(["bash", "__proto__", "constructor", "prototype"]);
// Mirrors createHarness's HARNESS_TOOL_NAME (assertSafeUserTools) so a discovered tool whose name is
// not a valid model-tool identifier (e.g. a `tools/my.tool.ts` stem `my.tool`) fails fast at load
// with a clear error — symmetric with the configured-tool path — instead of degrading to a late
// provider-side rejection at turn time.
export const DISCOVERED_TOOL_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/u;

export function rejectReservedDiscoveredToolNames(names: readonly string[]): void {
  for (const name of names) {
    if (RESERVED_DISCOVERED_TOOL_NAMES.has(name) || !DISCOVERED_TOOL_NAME.test(name)) {
      throw new HarnessInputError("Discovered tool name is reserved or invalid.", { toolName: name });
    }
  }
}
