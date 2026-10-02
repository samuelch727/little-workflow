import type { ToolSet } from "ai";
import type { HarnessWarning } from "../types.js";

/**
 * A tool is "executable" when it carries an `execute` function. Abstract tools (declared without
 * `execute`) are structural placeholders in the connector model: they only become live on a
 * connector that provides an implementation. The connector loader already drops them via
 * `resolveConnectorTools`, so this mirrors that exact check (see
 * `connectors/tool-extensions.ts`'s `hasExecute`) rather than introducing a second notion of
 * "abstract". There is no provider-defined tool distinction in this codebase today; if one is ever
 * added it must be preserved here (provider-defined tools legitimately have no local `execute`).
 */
function isExecutableTool(tool: unknown): boolean {
  return typeof (tool as { execute?: unknown } | undefined)?.execute === "function";
}

/**
 * Split a model-facing toolset into the tools that carry an `execute` implementation and the abstract
 * (execute-less) tools that must not be sent to the model. `hidden` keeps the full tool OBJECTS (not
 * just names) so callers can both surface the per-tool warning (via `Object.keys`) and recompute the
 * durable tool refs a pre-abstract-filter recorder would have hashed into the prompt — the durable
 * replay bridge needs those refs, not just names. Applying this on a connector-loaded run is a
 * harmless no-op because `resolveConnectorTools` already filtered them.
 */
export function partitionExecutableTools(tools: ToolSet): { executable: ToolSet; hidden: ToolSet } {
  const executable: ToolSet = {};
  const hidden: ToolSet = {};
  for (const [name, tool] of Object.entries(tools)) {
    if (isExecutableTool(tool)) {
      executable[name] = tool;
    } else {
      hidden[name] = tool;
    }
  }
  return { executable, hidden };
}

/**
 * Warning surfaced once per run for each abstract tool hidden from the model. Uses the shared
 * {@link HarnessWarning} shape (`policy_warning` + a `reason` discriminator in metadata) so it
 * flows through the same warnings channel as skill soft-fails and provider warnings.
 */
export function abstractToolHiddenWarning(tool: string): HarnessWarning {
  return {
    code: "policy_warning",
    message:
      `Tool "${tool}" was hidden from the model because it has no execute() implementation. ` +
      "Abstract tools are exposed only on connectors that provide an implementation.",
    metadata: {
      reason: "abstract-tool-hidden",
      tool,
    },
  };
}
