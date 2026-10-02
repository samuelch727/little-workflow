import { createMCPClient, type MCPClient, type MCPClientConfig } from "@ai-sdk/mcp";
import { Experimental_StdioMCPTransport } from "@ai-sdk/mcp/mcp-stdio";
import { asSchema, jsonSchema, tool, type FlexibleSchema, type ToolSet } from "ai";
import { createHash } from "node:crypto";
import { z } from "zod";
import { HarnessInputError } from "./errors.js";
import { canonicalJson } from "./events/durability.js";
import type { SkillInput } from "./types.js";

const DEFAULT_LIST_TOOL_NAME = "mcp_list_tools";
const DEFAULT_CALL_TOOL_NAME = "mcp_call_tool";
const SAFE_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const SERVER_ID = /^[A-Za-z0-9_-]+$/;
const RESERVED_TOOL_NAMES = new Set(["bash", "__proto__", "constructor", "prototype"]);
const AI_SDK_SCHEMA_SYMBOL = Symbol.for("vercel.ai.schema");
const textEncoder = new TextEncoder();

export type HarnessMcpConfig = {
  readonly servers: readonly HarnessMcpServerConfig[];
  readonly gateway?: HarnessMcpGatewayConfig;
};

export type HarnessMcpGatewayConfig = {
  readonly listToolName?: string | false;
  readonly callToolName?: string | false;
  readonly aliases?: false | {
    readonly prefix?: "server_id" | Readonly<Record<string, string>>;
  };
};

export type HarnessMcpServerConfig = {
  readonly id: string;
  readonly description: string;
  readonly transport: HarnessMcpTransportConfig;
  readonly guide?: false | HarnessMcpGuideConfig;
  readonly tools?: HarnessMcpToolPolicy;
  readonly client?: HarnessMcpClientOptions;
};

export type HarnessMcpGuideConfig = {
  readonly name?: string;
  readonly description: string;
  readonly body: string;
  readonly files?: Readonly<Record<string, string | Uint8Array>>;
};

export type HarnessMcpToolPolicy = {
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
  readonly rename?: Readonly<Record<string, string>>;
  readonly schemas?: HarnessMcpToolSchemas;
};

export type HarnessMcpToolSchemas = Readonly<Record<string, HarnessMcpToolSchema>>;

export type HarnessMcpToolSchema = {
  readonly inputSchema: unknown;
  readonly outputSchema?: unknown;
};

export type HarnessMcpClientOptions = {
  readonly name?: string;
  readonly version?: string;
  readonly capabilities?: unknown;
  readonly onUncaughtError?: (error: unknown) => void;
};

export type HarnessMcpTransportConfig =
  | {
    readonly type: "http";
    readonly url: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly redirect?: "follow" | "error";
    readonly authProvider?: unknown;
  }
  | {
    readonly type: "sse";
    readonly url: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly redirect?: "follow" | "error";
    readonly authProvider?: unknown;
  }
  | {
    readonly type: "stdio";
    readonly command: string;
    readonly args?: readonly string[];
    readonly cwd?: string;
    readonly env?: Readonly<Record<string, string>>;
    readonly stderr?: "pipe" | "inherit" | "ignore";
  };

export type HarnessMcpCapabilityManifest = {
  readonly gateway?: HarnessMcpGatewayManifest;
  readonly servers: readonly HarnessMcpServerManifest[];
};

export type HarnessMcpGatewayManifest = {
  readonly listToolName?: string;
  readonly callToolName?: string;
};

export type HarnessMcpServerManifest = {
  readonly id: string;
  readonly description: string;
  readonly transport: HarnessMcpTransportManifest;
  readonly guide?: HarnessMcpGuideManifest;
  readonly tools: readonly HarnessMcpToolManifest[];
};

export type HarnessMcpTransportManifest = {
  readonly type: HarnessMcpTransportConfig["type"];
  readonly url?: string;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
};

export type HarnessMcpGuideManifest = {
  readonly name: string;
  readonly description: string;
  readonly path: string;
  readonly contentHash?: string;
  readonly files?: readonly HarnessMcpGuideFileManifest[];
};

export type HarnessMcpGuideFileManifest = {
  readonly path: string;
  readonly hash: string;
};

export type HarnessMcpToolManifest = {
  readonly name: string;
  readonly description?: string;
  readonly inputSchemaHash?: string;
  readonly outputSchemaHash?: string;
  readonly inputSchema?: unknown;
  readonly outputSchema?: unknown;
};

export type ResolvedHarnessMcpGateway = {
  readonly tools: ToolSet;
  readonly skills: readonly SkillInput[];
  readonly manifest: HarnessMcpCapabilityManifest;
  close(): Promise<void>;
};

export type ResolveHarnessMcpGatewayOptions = {
  readonly createClient?: HarnessMcpCreateClient;
};

export type HarnessMcpCreateClient = (
  server: HarnessMcpServerConfig,
  index: number,
) => Promise<HarnessMcpClient>;

type HarnessMcpClientToolSchemas = Record<string, {
  inputSchema: FlexibleSchema<unknown>;
  outputSchema?: FlexibleSchema<unknown>;
}>;

export type HarnessMcpClient = {
  tools(options?: { schemas?: HarnessMcpClientToolSchemas }): Promise<Record<string, HarnessMcpDiscoveredTool>>;
  close(): Promise<void>;
};

export type HarnessMcpDiscoveredTool = {
  readonly description?: string;
  readonly inputSchema?: unknown;
  readonly outputSchema?: unknown;
  readonly execute?: (args: unknown, options: unknown) => Promise<unknown> | unknown;
};

type ResolvedServer = {
  config: HarnessMcpServerConfig;
  client: HarnessMcpClient;
  tools: Map<string, ResolvedMcpTool>;
  manifest: HarnessMcpServerManifest;
  guide?: HarnessMcpGuideManifest;
};

type ResolvedMcpTool = HarnessMcpToolManifest & {
  execute?: (args: unknown, options: unknown) => Promise<unknown> | unknown;
};

type ResolvedGatewayNames = {
  readonly listToolName?: string;
  readonly callToolName?: string;
};

export async function resolveHarnessMcpGateway(
  config: HarnessMcpConfig | undefined,
  options: ResolveHarnessMcpGatewayOptions = {},
): Promise<ResolvedHarnessMcpGateway> {
  if (config === undefined) {
    return {
      tools: {},
      skills: [],
      manifest: { servers: [] },
      close: async () => {},
    };
  }

  validateConfig(config);

  const clients: HarnessMcpClient[] = [];
  const resolvedServers: ResolvedServer[] = [];
  const createClient = options.createClient ?? createDefaultClient;
  const gatewayNames = resolveGatewayNames(config);

  try {
    for (const [index, server] of config.servers.entries()) {
      const client = await createClient(server, index);
      clients.push(client);
      const clientSchemas = clientToolSchemasFor(server);
      const discovered = await client.tools(clientSchemas === undefined ? undefined : { schemas: clientSchemas });
      const tools = await resolveServerTools(server, discovered);
      const toolManifests = [...tools.values()].map(toolManifest);
      const guideWithoutHash = guideManifestFor(server);
      const guideFiles = guideWithoutHash === undefined
        ? undefined
        : guideFilesFor(server, toolManifests, guideWithoutHash, gatewayNames);
      const guide = guideWithoutHash === undefined
        ? undefined
        : {
          ...guideWithoutHash,
          contentHash: guideFilesContentHash(guideFiles ?? {}),
          files: guideFileManifestsFor(guideFiles ?? {}),
        };
      resolvedServers.push({
        config: server,
        client,
        tools,
        manifest: {
          id: server.id,
          description: server.description,
          transport: transportManifest(server.transport),
          ...(guide === undefined ? {} : { guide }),
          tools: toolManifests,
        },
        ...(guide === undefined ? {} : { guide }),
      });
    }
    const manifest: HarnessMcpCapabilityManifest = {
      gateway: gatewayManifestFor(gatewayNames),
      servers: resolvedServers.map((server) => server.manifest),
    };

    return {
      tools: gatewayTools(config, gatewayNames, resolvedServers, manifest),
      skills: resolvedServers.flatMap((server) => skillForServer(server, gatewayNames)),
      manifest,
      close: async () => {
        await closeAllOrThrow(clients);
      },
    };
  } catch (error) {
    await closeAllBestEffort(clients);
    throw error;
  }
}

async function createDefaultClient(server: HarnessMcpServerConfig): Promise<HarnessMcpClient> {
  const clientOptions: MCPClientConfig = {
    transport: transportFor(server.transport),
    ...clientOptionsFor(server.client),
  };
  return createMCPClient(clientOptions) as Promise<MCPClient & HarnessMcpClient>;
}

function clientOptionsFor(options: HarnessMcpClientOptions | undefined): Partial<MCPClientConfig> {
  if (options === undefined) {
    return {};
  }

  const out: Partial<MCPClientConfig> = {};
  if (options.name !== undefined) {
    out.clientName = options.name;
  }
  if (options.version !== undefined) {
    out.version = options.version;
  }
  if (options.capabilities !== undefined) {
    out.capabilities = options.capabilities as NonNullable<MCPClientConfig["capabilities"]>;
  }
  if (options.onUncaughtError !== undefined) {
    out.onUncaughtError = options.onUncaughtError;
  }
  return out;
}

function transportFor(transport: HarnessMcpTransportConfig): MCPClientConfig["transport"] {
  if (transport.type === "stdio") {
    return new Experimental_StdioMCPTransport({
      command: transport.command,
      ...(transport.args === undefined ? {} : { args: [...transport.args] }),
      ...(transport.cwd === undefined ? {} : { cwd: transport.cwd }),
      ...(transport.env === undefined ? {} : { env: { ...transport.env } }),
      ...(transport.stderr === undefined ? {} : { stderr: transport.stderr }),
    });
  }

  return {
    type: transport.type,
    url: transport.url,
    ...(transport.headers === undefined ? {} : { headers: { ...transport.headers } }),
    ...(transport.redirect === undefined ? {} : { redirect: transport.redirect }),
    ...(transport.authProvider === undefined ? {} : { authProvider: transport.authProvider as never }),
  };
}

async function resolveServerTools(
  server: HarnessMcpServerConfig,
  discovered: Record<string, HarnessMcpDiscoveredTool>,
): Promise<Map<string, ResolvedMcpTool>> {
  const include = server.tools?.include === undefined ? undefined : new Set(server.tools.include);
  const exclude = new Set(server.tools?.exclude ?? []);
  const rename = server.tools?.rename ?? {};
  const tools = new Map<string, ResolvedMcpTool>();

  for (const [sourceName, discoveredTool] of Object.entries(discovered)) {
    if (include !== undefined && !include.has(sourceName)) {
      continue;
    }
    if (exclude.has(sourceName)) {
      continue;
    }

    const name = ownRecordValue(rename, sourceName) ?? sourceName;
    assertSafeToolName(name, "MCP visible tool name is invalid.");
    if (tools.has(name)) {
      throw new HarnessInputError("MCP tool rename produced a duplicate tool name.", {
        server: server.id,
        tool: name,
      });
    }

    const inputSchema = discoveredTool.inputSchema === undefined
      ? undefined
      : await normalizeMcpSchema(discoveredTool.inputSchema);
    const outputSchema = discoveredTool.outputSchema === undefined
      ? undefined
      : await normalizeMcpSchema(discoveredTool.outputSchema);

    tools.set(name, {
      name,
      ...(discoveredTool.description === undefined ? {} : { description: discoveredTool.description }),
      ...(inputSchema === undefined ? {} : { inputSchema }),
      ...(outputSchema === undefined ? {} : { outputSchema }),
      ...(discoveredTool.execute === undefined ? {} : { execute: discoveredTool.execute }),
    });
  }

  return tools;
}

function clientToolSchemasFor(server: HarnessMcpServerConfig): HarnessMcpClientToolSchemas | undefined {
  const configuredSchemas = server.tools?.schemas;
  if (configuredSchemas === undefined) {
    return undefined;
  }

  const schemas = Object.create(null) as HarnessMcpClientToolSchemas;
  for (const [toolName, schema] of Object.entries(configuredSchemas)) {
    const inputSchema = configuredSchemaProperty(schema, "inputSchema", server.id, toolName);
    const outputSchema = configuredSchemaProperty(schema, "outputSchema", server.id, toolName);
    schemas[toolName] = {
      inputSchema: clientSchemaFor(inputSchema),
      ...(outputSchema === undefined ? {} : { outputSchema: clientSchemaFor(outputSchema) }),
    };
  }
  return schemas;
}

function configuredSchemaProperty(
  schema: HarnessMcpToolSchema,
  property: "inputSchema" | "outputSchema",
  serverId: string,
  toolName: string,
): unknown {
  if (schema === null || typeof schema !== "object") {
    throw new HarnessInputError("MCP tool schema config must be an object.", { server: serverId, tool: toolName });
  }
  const record = schema as Record<PropertyKey, unknown>;
  if (!hasOwn(record, property)) {
    if (property === "outputSchema") {
      return undefined;
    }
    throw new HarnessInputError("MCP tool schema config requires an inputSchema.", {
      server: serverId,
      tool: toolName,
    });
  }
  return record[property];
}

function clientSchemaFor(schema: unknown): FlexibleSchema<unknown> {
  if (isAiSdkSchemaWrapper(schema)) {
    return schema as FlexibleSchema<unknown>;
  }
  if (isJsonSchemaRoot(schema)) {
    return jsonSchema(schema as never) as FlexibleSchema<unknown>;
  }

  try {
    asSchema(schema as FlexibleSchema<unknown>);
    return schema as FlexibleSchema<unknown>;
  } catch {
    throw new HarnessInputError("Unsupported configured MCP schema: schema must be JSON schema.", {
      schemaType: schemaTypeName(schema),
    });
  }
}

async function normalizeMcpSchema(schema: unknown): Promise<unknown> {
  let normalized: unknown;
  if (isJsonSchemaRoot(schema)) {
    normalized = schema;
  } else {
    try {
      normalized = await asSchema(schema as FlexibleSchema<unknown>).jsonSchema;
    } catch {
      throw new HarnessInputError("Unsupported MCP schema: schema must be JSON schema.", {
        schemaType: schemaTypeName(schema),
      });
    }
  }

  if (!isJsonSchemaRoot(normalized)) {
    throw new HarnessInputError("Unsupported MCP schema: schema must be JSON schema.", {
      schemaType: schemaTypeName(normalized),
    });
  }
  return plainJsonValue(normalized);
}

function isAiSdkSchemaWrapper(value: unknown): value is { readonly jsonSchema: unknown | PromiseLike<unknown> } {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const record = value as Record<PropertyKey, unknown>;
  return hasOwn(record, AI_SDK_SCHEMA_SYMBOL)
    && record[AI_SDK_SCHEMA_SYMBOL] === true
    && hasOwn(record, "jsonSchema");
}

function isJsonSchemaRoot(value: unknown): boolean {
  return typeof value === "boolean" || isPlainJsonObject(value);
}

function isJsonValue(value: unknown): boolean {
  if (value === null) {
    return true;
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  return isPlainJsonObject(value);
}

function plainJsonValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(plainJsonValue);
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([key, entry]) => [key, plainJsonValue(entry)]),
  );
}

function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return false;
  }
  return Object.values(value as Record<string, unknown>).every(isJsonValue);
}

function schemaTypeName(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  if (typeof value === "object") {
    return value.constructor?.name ?? "object";
  }
  return typeof value;
}

function hasOwn(record: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function ownRecordValue<T>(
  record: Readonly<Record<string, T>> | undefined,
  key: string,
): T | undefined {
  if (record === undefined || !hasOwn(record, key)) {
    return undefined;
  }
  return record[key];
}

function gatewayTools(
  config: HarnessMcpConfig,
  gatewayNames: ResolvedGatewayNames,
  servers: readonly ResolvedServer[],
  manifest: HarnessMcpCapabilityManifest,
): ToolSet {
  const tools = Object.create(null) as ToolSet;
  const capabilitySummary = describeCapabilities(manifest);

  const setTool = (name: string, value: ToolSet[string]) => {
    if (Object.prototype.hasOwnProperty.call(tools, name)) {
      throw new HarnessInputError("MCP gateway tool names must be unique.", { toolName: name });
    }
    tools[name] = value;
  };

  if (gatewayNames.listToolName !== undefined) {
    setTool(gatewayNames.listToolName, tool({
      description: `List configured MCP servers and visible MCP tools. Available capabilities: ${capabilitySummary}`,
      inputSchema: z.object({
        server: z.string().optional(),
      }),
      execute: async ({ server }) => {
        const selected = server === undefined ? servers : servers.filter((item) => item.config.id === server);
        return {
          servers: selected.map((item) => ({
            id: item.config.id,
            description: item.config.description,
            ...(item.guide === undefined ? {} : { guide: item.guide }),
            tools: item.manifest.tools,
          })),
        };
      },
    }));
  }

  if (gatewayNames.callToolName !== undefined) {
    setTool(gatewayNames.callToolName, tool({
      description: `Call one configured MCP tool by server id and tool name. Available capabilities: ${capabilitySummary}`,
      inputSchema: z.object({
        server: z.string(),
        tool: z.string(),
        args: z.unknown().optional(),
      }),
      execute: async ({ server, tool: toolName, args }, executeOptions) => {
        const resolvedServer = servers.find((item) => item.config.id === server);
        if (resolvedServer === undefined) {
          throw new HarnessInputError("Unknown MCP server.", { server });
        }
        const resolvedTool = resolvedServer.tools.get(toolName);
        if (resolvedTool === undefined) {
          throw new HarnessInputError("Unknown MCP tool.", { server, tool: toolName });
        }
        if (resolvedTool.execute === undefined) {
          throw new HarnessInputError("MCP tool is not executable.", { server, tool: toolName });
        }
        return resolvedTool.execute(args, executeOptions);
      },
    }));
  }

  if (config.gateway?.aliases !== undefined && config.gateway.aliases !== false) {
    for (const server of servers) {
      const aliasPrefix = aliasPrefixFor(config.gateway.aliases.prefix, server.config.id);
      for (const resolvedTool of server.tools.values()) {
        const aliasName = `${aliasPrefix}_${resolvedTool.name}`;
        assertSafeToolName(aliasName, "MCP alias tool name is invalid.");
        setTool(aliasName, tool({
          description: directAliasDescription(server.config.id, resolvedTool),
          inputSchema: aliasInputSchemaFor(resolvedTool.inputSchema),
          ...(resolvedTool.outputSchema === undefined
            ? {}
            : { outputSchema: aliasOutputSchemaFor(resolvedTool.outputSchema) }),
          execute: async (args: unknown, executeOptions: unknown) => {
            if (resolvedTool.execute === undefined) {
              throw new HarnessInputError("MCP tool is not executable.", {
                server: server.config.id,
                tool: resolvedTool.name,
              });
            }
            return resolvedTool.execute(args, executeOptions);
          },
        }));
      }
    }
  }

  return tools;
}

function skillForServer(server: ResolvedServer, gatewayNames: ResolvedGatewayNames): SkillInput[] {
  if (server.config.guide === false || server.guide === undefined) {
    return [];
  }

  const name = server.guide.name;
  const description = server.guide.description;
  const files = guideFilesFor(server.config, server.manifest.tools, server.guide, gatewayNames);

  return [{
    name,
    description,
    harnessDir: server.guide.path,
    files: encodeSkillFiles(files),
  }];
}

function guideFilesFor(
  server: HarnessMcpServerConfig,
  tools: readonly HarnessMcpToolManifest[],
  guide: HarnessMcpGuideManifest,
  gatewayNames: ResolvedGatewayNames,
): Record<string, string | Uint8Array> {
  const guideConfig = server.guide;
  const files = Object.create(null) as Record<string, string | Uint8Array>;
  files["SKILL.md"] = guideConfig === undefined || guideConfig === false
    ? generatedGuideBody(server, tools, guide, gatewayNames)
    : generatedGuideBody(server, tools, guide, gatewayNames, guideConfig.body);

  if (guideConfig !== undefined && guideConfig !== false && guideConfig.files !== undefined) {
    Object.assign(files, normalizeGuideAuxiliaryFiles(server.id, guideConfig.files));
  }

  return files;
}

function normalizeGuideAuxiliaryFiles(
  serverId: string,
  files: Readonly<Record<string, string | Uint8Array>>,
): Record<string, string | Uint8Array> {
  const normalizedFiles = Object.create(null) as Record<string, string | Uint8Array>;
  const seen = new Set<string>();
  for (const [path, content] of Object.entries(files)) {
    const normalizedPath = normalizeGuideFilePath(serverId, path);
    if (normalizedPath === "SKILL.md") {
      throw new HarnessInputError("MCP guide files cannot override SKILL.md.", { server: serverId, path });
    }
    if (seen.has(normalizedPath)) {
      throw new HarnessInputError("MCP guide file paths must be unique after normalization.", {
        server: serverId,
        path,
        normalizedPath,
      });
    }
    seen.add(normalizedPath);
    normalizedFiles[normalizedPath] = content;
  }
  return normalizedFiles;
}

function normalizeGuideFilePath(serverId: string, path: string): string {
  if (path === "" || path.startsWith("/") || path.includes("\0")) {
    throw new HarnessInputError("MCP guide file path is invalid.", { server: serverId, path });
  }

  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      throw new HarnessInputError("MCP guide file path cannot traverse outside the guide.", {
        server: serverId,
        path,
      });
    }
    segments.push(segment);
  }

  const normalizedPath = segments.join("/");
  if (normalizedPath === "") {
    throw new HarnessInputError("MCP guide file path is invalid.", { server: serverId, path });
  }
  return normalizedPath;
}

function generatedGuideBody(
  server: HarnessMcpServerConfig,
  toolManifests: readonly HarnessMcpToolManifest[],
  guide: HarnessMcpGuideManifest,
  gatewayNames: ResolvedGatewayNames,
  configuredBody?: string,
): string {
  const tools = toolManifests.length === 0
    ? "- No visible tools were discovered."
    : toolManifests.map((item) => `- ${item.name}${item.description === undefined ? "" : `: ${item.description}`}`).join("\n");
  const instructions = generatedGuideGatewayInstructions(gatewayNames);

  return [
    "---",
    `name: ${guide.name}`,
    `description: ${guide.description}`,
    "---",
    "",
    `# ${guide.name}`,
    "",
    server.description,
    "",
    instructions,
    "",
    `Server id: \`${server.id}\``,
    "",
    ...(configuredBody === undefined
      ? []
      : [
        "## Configured Guidance",
        "",
        configuredBody,
        "",
      ]),
    "## Visible Tools",
    "",
    tools,
    "",
  ].join("\n");
}

function generatedGuideGatewayInstructions(gatewayNames: ResolvedGatewayNames): string {
  if (gatewayNames.listToolName !== undefined && gatewayNames.callToolName !== undefined) {
    return `Use \`${gatewayNames.listToolName}\` to inspect available tools. Use \`${gatewayNames.callToolName}\` with this server id and the selected tool name.`;
  }
  if (gatewayNames.listToolName !== undefined) {
    return `Use \`${gatewayNames.listToolName}\` to inspect available tools for this server.`;
  }
  if (gatewayNames.callToolName !== undefined) {
    return `Use \`${gatewayNames.callToolName}\` with this server id and the selected tool name.`;
  }
  return "No gateway tools are enabled for this MCP server.";
}

function resolveGatewayNames(config: HarnessMcpConfig): ResolvedGatewayNames {
  return {
    ...(config.gateway?.listToolName === false
      ? {}
      : { listToolName: config.gateway?.listToolName ?? DEFAULT_LIST_TOOL_NAME }),
    ...(config.gateway?.callToolName === false
      ? {}
      : { callToolName: config.gateway?.callToolName ?? DEFAULT_CALL_TOOL_NAME }),
  };
}

function gatewayManifestFor(gatewayNames: ResolvedGatewayNames): HarnessMcpGatewayManifest {
  return {
    ...(gatewayNames.listToolName === undefined ? {} : { listToolName: gatewayNames.listToolName }),
    ...(gatewayNames.callToolName === undefined ? {} : { callToolName: gatewayNames.callToolName }),
  };
}

function guideManifestFor(
  server: HarnessMcpServerConfig,
  contentHash?: string,
): HarnessMcpGuideManifest | undefined {
  if (server.guide === false) {
    return undefined;
  }

  const name = server.guide?.name ?? defaultGuideNameFor(server.id);
  return {
    name,
    description: server.guide?.description ?? `Use when the task needs ${server.description}`,
    path: `.agents/skills/${name}`,
    ...(contentHash === undefined ? {} : { contentHash }),
  };
}

function sha256Hex(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function guideFilesContentHash(files: Record<string, string | Uint8Array>): string {
  const hash = createHash("sha256");
  for (const path of Object.keys(files).sort()) {
    const bytes = bytesForContent(files[path] ?? "");
    hash.update(`${path.length}:${path}:${bytes.byteLength}:`);
    hash.update(bytes);
    hash.update(";");
  }
  return hash.digest("hex");
}

function guideFileManifestsFor(files: Record<string, string | Uint8Array>): HarnessMcpGuideFileManifest[] {
  return Object.keys(files).sort().map((path) => ({
    path,
    hash: sha256DigestForBytes(bytesForContent(files[path] ?? "")),
  }));
}

function bytesForContent(content: string | Uint8Array): Uint8Array {
  return typeof content === "string" ? textEncoder.encode(content) : content;
}

function sha256DigestForBytes(content: Uint8Array): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function sha256Digest(content: string): string {
  return `sha256:${sha256Hex(content)}`;
}

function schemaHash(schema: unknown): string {
  return sha256Digest(canonicalJson(schema));
}

function toolManifest(tool: ResolvedMcpTool): HarnessMcpToolManifest {
  return {
    name: tool.name,
    ...(tool.description === undefined ? {} : { description: tool.description }),
    ...(tool.inputSchema === undefined ? {} : { inputSchemaHash: schemaHash(tool.inputSchema) }),
    ...(tool.outputSchema === undefined ? {} : { outputSchemaHash: schemaHash(tool.outputSchema) }),
    ...(tool.inputSchema === undefined ? {} : { inputSchema: tool.inputSchema }),
    ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
  };
}

function transportManifest(transport: HarnessMcpTransportConfig): HarnessMcpTransportManifest {
  if (transport.type === "stdio") {
    return {
      type: "stdio",
      command: transport.command,
      ...(transport.args === undefined ? {} : { args: [...transport.args] }),
      ...(transport.cwd === undefined ? {} : { cwd: transport.cwd }),
    };
  }

  return {
    type: transport.type,
    url: sanitizedManifestUrl(transport.url),
  };
}

function sanitizedManifestUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    const withoutFragment = url.split("#", 1)[0] ?? "";
    const withoutQuery = withoutFragment.split("?", 1)[0] ?? "";
    return withoutQuery.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]+@/i, "$1");
  }
}

function describeCapabilities(manifest: HarnessMcpCapabilityManifest): string {
  return JSON.stringify(manifest);
}

function aliasPrefixFor(
  prefix: "server_id" | Readonly<Record<string, string>> | undefined,
  serverId: string,
): string {
  if (prefix === undefined || prefix === "server_id") {
    return serverId;
  }
  return ownRecordValue(prefix, serverId) ?? serverId;
}

function directAliasDescription(serverId: string, toolManifest: HarnessMcpToolManifest): string {
  const suffix = toolManifest.description === undefined ? "" : ` ${toolManifest.description}`;
  return `Call MCP tool ${serverId}/${toolManifest.name}.${suffix}`.trim();
}

function aliasInputSchemaFor(inputSchema: unknown | undefined): never {
  if (inputSchema === undefined) {
    return z.unknown() as never;
  }
  return jsonSchema(inputSchema as never) as never;
}

function aliasOutputSchemaFor(outputSchema: unknown): never {
  return jsonSchema(outputSchema as never) as never;
}

function encodeSkillFiles(files: Record<string, string | Uint8Array>): Record<string, Uint8Array> {
  const out = Object.create(null) as Record<string, Uint8Array>;
  for (const [path, content] of Object.entries(files)) {
    out[path] = typeof content === "string" ? textEncoder.encode(content) : content;
  }
  return out;
}

async function closeAllBestEffort(clients: readonly HarnessMcpClient[]): Promise<void> {
  const closeOperations = clients.map(async (client) => {
    try {
      await client.close();
    } catch {
      // Cleanup is best-effort; callers should keep the original operation result.
    }
  });
  await Promise.allSettled(closeOperations);
}

async function closeAllOrThrow(clients: readonly HarnessMcpClient[]): Promise<void> {
  const results = await Promise.allSettled(clients.map(async (client) => client.close()));
  const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
  if (failures.length === 0) {
    return;
  }
  if (failures.length === 1) {
    throw normalizeCloseFailure(failures[0]);
  }
  throw new AggregateError(failures, "One or more MCP client close operations failed.");
}

function normalizeCloseFailure(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error("MCP client close failed.", { cause: error });
}

function validateConfig(config: HarnessMcpConfig): void {
  const serverIds = new Set<string>();
  const guideNames = new Set<string>();
  const guidePaths = new Set<string>();
  for (const server of config.servers) {
    validateServer(server);
    if (serverIds.has(server.id)) {
      throw new HarnessInputError("MCP server ids must be unique.", { server: server.id });
    }
    serverIds.add(server.id);

    const guide = guideManifestFor(server);
    if (guide !== undefined) {
      if (guideNames.has(guide.name)) {
        throw new HarnessInputError("MCP guide names must be unique.", {
          server: server.id,
          guide: guide.name,
        });
      }
      if (guidePaths.has(guide.path)) {
        throw new HarnessInputError("MCP guide paths must be unique.", {
          server: server.id,
          path: guide.path,
        });
      }
      guideNames.add(guide.name);
      guidePaths.add(guide.path);
    }
  }

  const listToolName = config.gateway?.listToolName === false ? undefined : config.gateway?.listToolName ?? DEFAULT_LIST_TOOL_NAME;
  const callToolName = config.gateway?.callToolName === false ? undefined : config.gateway?.callToolName ?? DEFAULT_CALL_TOOL_NAME;
  if (listToolName !== undefined) {
    assertSafeToolName(listToolName, "MCP list gateway tool name is invalid.");
  }
  if (callToolName !== undefined) {
    assertSafeToolName(callToolName, "MCP call gateway tool name is invalid.");
  }
  if (listToolName !== undefined && callToolName !== undefined && listToolName === callToolName) {
    throw new HarnessInputError("MCP gateway tool names must be unique.", { toolName: listToolName });
  }
}

function validateServer(server: HarnessMcpServerConfig): void {
  if (!SERVER_ID.test(server.id)) {
    throw new HarnessInputError("MCP server id is invalid.", { server: server.id });
  }
  if (!server.description.trim()) {
    throw new HarnessInputError("MCP server description is required.", { server: server.id });
  }
  if (server.guide !== undefined && server.guide !== false) {
    const guideName = server.guide.name ?? defaultGuideNameFor(server.id);
    assertSafeToolName(guideName, "MCP guide name is invalid.");
  }
  validateToolPolicy(server);
}

function defaultGuideNameFor(serverId: string): string {
  return `${serverId}-mcp`;
}

function validateToolPolicy(server: HarnessMcpServerConfig): void {
  const names = [
    ...(server.tools?.include ?? []),
    ...(server.tools?.exclude ?? []),
    ...Object.keys(server.tools?.rename ?? {}),
    ...Object.keys(server.tools?.schemas ?? {}),
  ];
  for (const name of names) {
    if (!name) {
      throw new HarnessInputError("MCP tool policy names cannot be empty.", { server: server.id });
    }
  }
  for (const name of Object.values(server.tools?.rename ?? {})) {
    assertSafeToolName(name, "MCP renamed tool name is invalid.");
  }
  validateToolSchemaPolicy(server);
}

function validateToolSchemaPolicy(server: HarnessMcpServerConfig): void {
  const schemas = server.tools?.schemas;
  if (schemas === undefined) {
    return;
  }
  const include = server.tools?.include;
  const schemaNames = Object.keys(schemas);
  if (include === undefined) {
    throw new HarnessInputError("MCP tool schemas must exactly match included tool names.", {
      server: server.id,
      schemaTools: schemaNames,
    });
  }

  const includeNames = new Set(include);
  const schemaNameSet = new Set(schemaNames);
  if (
    includeNames.size !== include.length
    || schemaNameSet.size !== schemaNames.length
    || includeNames.size !== schemaNameSet.size
    || schemaNames.some((name) => !includeNames.has(name))
  ) {
    throw new HarnessInputError("MCP tool schemas must exactly match included tool names.", {
      server: server.id,
      includedTools: include,
      schemaTools: schemaNames,
    });
  }

  for (const [toolName, schema] of Object.entries(schemas)) {
    configuredSchemaProperty(schema, "inputSchema", server.id, toolName);
  }
}

function assertSafeToolName(name: string, message: string): void {
  if (!SAFE_NAME.test(name) || RESERVED_TOOL_NAMES.has(name)) {
    throw new HarnessInputError(message, { name });
  }
}
