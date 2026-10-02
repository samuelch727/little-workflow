import type { ToolSet } from "ai";
import { HarnessInputError } from "../errors.js";

const connectorToolExtensionBrand = Symbol("little-harness.connector-tool-extension");

type ConnectorTool = ToolSet[string];
type ConnectorToolExtensionOptions = Partial<ConnectorTool>;

export type ConnectorToolExtension<TTool extends ConnectorTool = ConnectorTool> = {
  readonly [connectorToolExtensionBrand]: true;
  readonly tool: TTool;
} & ConnectorToolExtensionOptions;

function hasExecute(tool: ConnectorTool | undefined): boolean {
  return typeof (tool as { execute?: unknown } | undefined)?.execute === "function";
}

export function extendTool<TTool extends ConnectorTool>(
  tool: TTool,
  options: ConnectorToolExtensionOptions,
): ConnectorToolExtension<TTool> {
  const {
    tool: _ignoredTool,
    [connectorToolExtensionBrand]: _ignoredBrand,
    ...extensionOptions
  } = options as ConnectorToolExtensionOptions & Partial<ConnectorToolExtension<TTool>>;
  return {
    ...extensionOptions,
    tool,
    [connectorToolExtensionBrand]: true,
  };
}

export function isConnectorToolExtension(value: unknown): value is ConnectorToolExtension {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { [connectorToolExtensionBrand]?: unknown })[connectorToolExtensionBrand] === true
  );
}

export function resolveToolExtension(
  toolName: string,
  baseTool: ConnectorTool | undefined,
  extensionDefaultExport: unknown,
): ConnectorTool {
  if (isConnectorToolExtension(extensionDefaultExport)) {
    const {
      tool: extensionTool,
      [connectorToolExtensionBrand]: _brand,
      ...options
    } = extensionDefaultExport;
    // Prefer the base the author explicitly imported and passed to extendTool over a same-named
    // shared base tool: name-matching must not silently override an explicit import. (extensionTool
    // is always present on a branded extension, so baseTool only backstops undefined edge cases.)
    const tool = extensionTool ?? baseTool;
    return { ...tool, ...options } as ConnectorTool;
  }

  // A plain executable tool is accepted as a connector-only tool — but only when no
  // shared base tool of the same name exists. If a base does exist, the dev almost
  // certainly means to extend it, so steer them to extendTool to inherit its contract.
  if (baseTool === undefined && hasExecute(extensionDefaultExport as ConnectorTool | undefined)) {
    return extensionDefaultExport as ConnectorTool;
  }

  throw new HarnessInputError(
    baseTool === undefined
      ? "Connector tool module must default-export a tool with execute, or extendTool(baseTool, options)."
      : "Connector tool module must default-export extendTool(baseTool, options) to extend the shared base tool.",
    { tool: toolName },
  );
}

export function resolveConnectorTools(
  baseTools: ToolSet,
  connectorTools: Partial<Record<string, ConnectorTool>>,
): ToolSet {
  const resolved: ToolSet = {};

  for (const [name, tool] of Object.entries(baseTools)) {
    if (hasExecute(tool)) {
      resolved[name] = tool;
    }
  }

  for (const [name, tool] of Object.entries(connectorTools)) {
    if (tool !== undefined && hasExecute(tool)) {
      resolved[name] = tool;
    }
  }

  return resolved;
}

/**
 * Per-connector tool access policy. Availability is otherwise derived from structure
 * (executable `tools/*` are global; `connectors/<id>/tools/*` are connector-only), so a
 * policy is only needed to narrow that default:
 * - `allow`: expose ONLY these tool names on the connector (whitelist).
 * - `deny`: remove these tool names from the connector (blacklist), applied after `allow`.
 *
 * `deny` wins over `allow`. Unknown names are ignored. Omit the policy to expose the full
 * structure-derived toolset.
 */
export type ConnectorToolPolicy = {
  allow?: readonly string[];
  deny?: readonly string[];
};

/** Apply a {@link ConnectorToolPolicy} to a resolved toolset. Returns a new ToolSet. */
export function applyConnectorToolPolicy(tools: ToolSet, policy?: ConnectorToolPolicy): ToolSet {
  if (policy === undefined) {
    return tools;
  }
  const allow = policy.allow === undefined ? undefined : new Set(policy.allow);
  const deny = new Set(policy.deny ?? []);
  const result: ToolSet = {};
  for (const [name, tool] of Object.entries(tools)) {
    if (allow !== undefined && !allow.has(name)) {
      continue;
    }
    if (deny.has(name)) {
      continue;
    }
    result[name] = tool;
  }
  return result;
}
