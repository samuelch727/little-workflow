import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { dirname, join, parse } from "node:path";
import type { ToolSet } from "ai";
import { HarnessInputError } from "../errors.js";
import { importDefault } from "../workspace/module-loader.js";
import { rejectReservedDiscoveredToolNames } from "../workspace/tool-name-policy.js";
import {
  isChatSdkConnector,
  isWebRichConnector,
  type WorkspaceConnectorDescriptor,
} from "./descriptors.js";
import { extendTool, resolveToolExtension } from "./tool-extensions.js";

const SOURCE_EXTENSIONS = new Set([".ts", ".js", ".mts", ".mjs", ".cts", ".cjs"]);
const CONNECTOR_MODULE_NAMES = [
  "connector.ts",
  "connector.js",
  "connector.mts",
  "connector.mjs",
  "connector.cts",
  "connector.cjs",
];
const CONNECTOR_TOOL_EXTENSION_BRAND_DESCRIPTION = "little-harness.connector-tool-extension";

export type WorkspaceConnectorMetadata = {
  id: string;
  kind: WorkspaceConnectorDescriptor["kind"];
  path: string;
};

function isTestOrSpec(name: string): boolean {
  return name.endsWith(".test") || name.endsWith(".spec");
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const result = await stat(path);
    return result.isFile();
  } catch (error) {
    if (isExpectedMissingFsError(error)) {
      return false;
    }
    throw new HarnessInputError("Unable to inspect connector module.", {
      path,
      cause: errorMessage(error),
      code: errorCode(error),
    });
  }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isExpectedMissingFsError(error: unknown): boolean {
  const code = errorCode(error);
  return code === "ENOENT" || code === "ENOTDIR";
}

function assertNoDuplicateConnectorIds(files: Array<{ id: string; path: string }>): void {
  const seen = new Map<string, string>();
  for (const file of files) {
    const previous = seen.get(file.id);
    if (previous !== undefined) {
      throw new HarnessInputError("Duplicate connector id.", {
        id: file.id,
        paths: [previous, file.path],
      });
    }
    seen.set(file.id, file.path);
  }
}

async function candidateFiles(
  connectorsDir: string,
  entries: Dirent[],
): Promise<Array<{ id: string; path: string }>> {
  const candidates: Array<{ id: string; path: string }> = [];

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const direct = join(connectorsDir, entry.name);
    if (entry.isFile()) {
      const parsed = parse(entry.name);
      if (SOURCE_EXTENSIONS.has(parsed.ext) && !isTestOrSpec(parsed.name)) {
        candidates.push({ id: parsed.name, path: direct });
      }
      continue;
    }

    if (!entry.isDirectory()) continue;

    for (const moduleName of CONNECTOR_MODULE_NAMES) {
      const nested = join(direct, moduleName);
      if (await fileExists(nested)) {
        candidates.push({ id: entry.name, path: nested });
        break;
      }
    }
  }

  return candidates;
}

async function findConnectorCandidates(agentDir: string): Promise<Array<{ id: string; path: string }>> {
  const connectorsDir = join(agentDir, "connectors");
  let entries: Dirent[];
  try {
    entries = await readdir(connectorsDir, { withFileTypes: true });
  } catch (error) {
    if (isExpectedMissingFsError(error)) {
      return [];
    }
    throw new HarnessInputError("Unable to read connector directory.", {
      agentDir,
      connectorsDir,
      cause: errorMessage(error),
      code: errorCode(error),
    });
  }

  const files = await candidateFiles(connectorsDir, entries);
  assertNoDuplicateConnectorIds(files);
  return files;
}

function connectorKind(value: unknown, path: string): WorkspaceConnectorDescriptor["kind"] {
  if (isChatSdkConnector(value)) return "chat-sdk";
  if (isWebRichConnector(value)) return "web-rich";
  throw new HarnessInputError("Connector module must default-export a Little Harness connector descriptor.", {
    path,
  });
}

function hasForeignConnectorToolExtensionBrand(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  return Object.getOwnPropertySymbols(value).some(
    (symbol) =>
      symbol.description === CONNECTOR_TOOL_EXTENSION_BRAND_DESCRIPTION &&
      (value as Record<symbol, unknown>)[symbol] === true,
  );
}

function rebrandForeignToolExtension(extensionDefaultExport: unknown): unknown {
  if (!hasForeignConnectorToolExtensionBrand(extensionDefaultExport)) {
    return extensionDefaultExport;
  }

  const { tool, ...options } = extensionDefaultExport as { tool: ToolSet[string] } & Record<string, unknown>;
  return extendTool(tool, Object.fromEntries(Object.entries(options)) as Partial<ToolSet[string]>);
}

function resolveDiscoveredToolExtension(
  toolName: string,
  baseTool: ToolSet[string] | undefined,
  extensionDefaultExport: unknown,
): ToolSet[string] {
  try {
    return resolveToolExtension(toolName, baseTool, extensionDefaultExport);
  } catch (error) {
    if (!hasForeignConnectorToolExtensionBrand(extensionDefaultExport)) {
      throw error;
    }
    return resolveToolExtension(toolName, baseTool, rebrandForeignToolExtension(extensionDefaultExport));
  }
}

export type DiscoverConnectorsOptions = {
  /**
   * Invoked once per FLAT `connectors/<id>.ts` candidate that fails to load or is not a connector
   * descriptor. Flat files may be legitimate helpers, so they are skipped rather than fatal — but
   * a silent skip generates "my connector isn't found" tickets, so each skip is surfaced. When no
   * handler is provided, each skip is logged once via `console.warn`.
   */
  onSkip?: (skipped: { id: string; path: string; error: unknown }) => void;
};

export async function discoverConnectors(
  agentDir: string,
  options?: DiscoverConnectorsOptions,
): Promise<WorkspaceConnectorMetadata[]> {
  const connectorsDir = join(agentDir, "connectors");
  const files = await findConnectorCandidates(agentDir);
  const result: WorkspaceConnectorMetadata[] = [];
  for (const file of files) {
    // A nested `connectors/<id>/connector.*` folder unambiguously intends to be a connector; a flat
    // `connectors/<id>.ts` file may just be a helper sitting alongside real connectors.
    const isNested = dirname(file.path) !== connectorsDir;
    try {
      const descriptor = await importDefault<unknown>(file.path);
      result.push({ id: file.id, kind: connectorKind(descriptor, file.path), path: file.path });
    } catch (error) {
      // One candidate's failure must never abort enumeration of the others.
      if (isNested) {
        // A folder with a connector module that fails to import or is not a valid descriptor is a
        // hard error: silence here is the bug the author is trying to debug.
        throw new HarnessInputError("Failed to load connector module.", {
          id: file.id,
          path: file.path,
          cause: errorMessage(error),
        });
      }
      reportSkippedConnector(file, error, options?.onSkip);
    }
  }
  return result.sort((a, b) => a.id.localeCompare(b.id));
}

function reportSkippedConnector(
  file: { id: string; path: string },
  error: unknown,
  onSkip: DiscoverConnectorsOptions["onSkip"],
): void {
  if (onSkip !== undefined) {
    onSkip({ id: file.id, path: file.path, error });
    return;
  }
  console.warn(
    `little-harness: skipped connector candidate "${file.id}" (${file.path}): ${errorMessage(error)}`,
  );
}

export async function loadConnectorDescriptor(
  agentDir: string,
  connector: string,
): Promise<WorkspaceConnectorDescriptor> {
  const found = (await findConnectorCandidates(agentDir)).find((item) => item.id === connector);
  if (found === undefined) {
    throw new HarnessInputError("Connector not found.", { connector, agentDir });
  }

  // The caller explicitly asked for this id, so a module-load failure is always fatal (both flat and
  // nested) — wrap it with the connector/path context instead of surfacing the raw importer error.
  let descriptor: unknown;
  try {
    descriptor = await importDefault<unknown>(found.path);
  } catch (error) {
    throw new HarnessInputError("Failed to load connector module.", {
      connector,
      path: found.path,
      cause: errorMessage(error),
    });
  }
  connectorKind(descriptor, found.path);
  return descriptor as WorkspaceConnectorDescriptor;
}

export async function loadConnectorToolExtensions(
  agentDir: string,
  connector: string,
  baseTools: ToolSet,
): Promise<ToolSet> {
  const found = (await findConnectorCandidates(agentDir)).find((item) => item.id === connector);
  if (found === undefined) {
    throw new HarnessInputError("Connector not found.", { connector, agentDir });
  }

  // Tools live under `connectors/<id>/tools/` regardless of whether the connector descriptor is a
  // flat `connectors/<id>.ts` file or a nested `connectors/<id>/connector.*` module — a flat-file
  // connector may still carry a sibling `tools/` dir. A missing dir returns {} via the ENOENT path.
  return loadConnectorToolExtensionsFromDir(join(agentDir, "connectors", connector, "tools"), baseTools);
}

/**
 * Load tool extensions from a `connectors/<id>/tools/` directory WITHOUT requiring a connector-module
 * candidate to exist. A missing directory resolves to `{}` (via the ENOENT/ENOTDIR path). This is the
 * reusable half of {@link loadConnectorToolExtensions}: the connector loaders' descriptor-object path
 * calls it directly so a folder that ships ONLY `tools/*` (no `connector.*` module, so no discovery
 * candidate) still contributes its on-disk tools instead of being dropped by the "Connector not
 * found." guard. `baseTools[name]` is still the extension base a discovered `extendTool` builds on.
 */
export async function loadConnectorToolExtensionsFromDir(
  toolsDir: string,
  baseTools: ToolSet,
): Promise<ToolSet> {
  let entries: Dirent[];
  try {
    entries = await readdir(toolsDir, { withFileTypes: true });
  } catch (error) {
    if (isExpectedMissingFsError(error)) {
      return {};
    }
    throw new HarnessInputError("Unable to read connector tool directory.", {
      toolsDir,
      cause: errorMessage(error),
      code: errorCode(error),
    });
  }

  const tools: ToolSet = {};
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile()) continue;

    const parsed = parse(entry.name);
    if (!SOURCE_EXTENSIONS.has(parsed.ext) || isTestOrSpec(parsed.name)) continue;

    // Reject reserved/invalid names (e.g. `connectors/<id>/tools/bash.ts`) BEFORE resolving, so the
    // discovered tool fails fast rather than being silently overwritten by the runtime shell tool at
    // turn assembly — symmetric with loadHarness's folder-discovery guard.
    rejectReservedDiscoveredToolNames([parsed.name]);

    const extensionDefaultExport = await importDefault<unknown>(join(toolsDir, entry.name));
    tools[parsed.name] = resolveDiscoveredToolExtension(parsed.name, baseTools[parsed.name], extensionDefaultExport);
  }

  return tools;
}
