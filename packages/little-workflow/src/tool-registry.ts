import { sha256Digest } from "./canonical.js";
import { normalizeSchema } from "./schema.js";

export type AiSdkTool = {
  readonly description?: string;
  readonly inputSchema?: unknown;
  readonly outputSchema?: unknown;
  readonly needsApproval?: boolean | ((args: any, options?: any) => boolean | PromiseLike<boolean>);
  readonly execute?: (...args: any[]) => unknown;
};

export type ToolRegistrySnapshot = ReadonlyArray<{
  readonly id: string;
  readonly description: string;
  readonly inputSchemaHash: string;
  readonly outputSchemaHash?: string;
}>;

export type ToolRegistry = {
  get(name: string): AiSdkTool | undefined;
  list(): readonly string[];
  toRecord(): Record<string, AiSdkTool>;
  snapshotForManifest(): ToolRegistrySnapshot;
  attachMcpTools(mcpTools: Record<string, AiSdkTool>, options?: { prefix?: string }): void;
  names(): readonly string[];
  register(name: string, tool: AiSdkTool): void;
  has(name: string): boolean;
};

const TOOL_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]*$/u;

function assertToolId(id: string, source = "Tool id"): void {
  if (!TOOL_ID_PATTERN.test(id)) {
    throw new Error(
      `${source} '${id}' is invalid. Expected pattern [a-zA-Z][a-zA-Z0-9_.-]*.`,
    );
  }
}

function descriptionFor(tool: AiSdkTool | undefined): string {
  return typeof tool?.description === "string" ? tool.description : "";
}

function manifestSnapshotFor(id: string, tool: AiSdkTool): ToolRegistrySnapshot[number] {
  const inputSchema = tool.inputSchema === undefined ? true : normalizeSchema(tool.inputSchema);
  const outputSchema = tool.outputSchema === undefined ? undefined : normalizeSchema(tool.outputSchema);
  return {
    id,
    description: descriptionFor(tool),
    inputSchemaHash: sha256Digest(inputSchema),
    ...(outputSchema === undefined ? {} : { outputSchemaHash: sha256Digest(outputSchema) }),
  };
}

export function createToolRegistry(initial: Record<string, AiSdkTool> = {}): ToolRegistry {
  const tools = new Map<string, AiSdkTool>();

  const insert = (name: string, tool: AiSdkTool, source = "Tool"): void => {
    assertToolId(name, `${source} id`);
    if (tools.has(name)) {
      throw new Error(`Tool '${name}' is already registered.`);
    }
    tools.set(name, tool);
  };

  for (const [name, tool] of Object.entries(initial)) {
    insert(name, tool, "Initial tool");
  }

  const list = (): readonly string[] => [...tools.keys()].sort();

  return {
    get(name) {
      return tools.get(name);
    },
    list,
    toRecord() {
      const record: Record<string, AiSdkTool> = {};
      for (const name of list()) {
        const tool = tools.get(name);
        if (tool !== undefined) {
          record[name] = tool;
        }
      }
      return record;
    },
    snapshotForManifest() {
      return list().map((name) => manifestSnapshotFor(name, tools.get(name)!));
    },
    attachMcpTools(mcpTools, options) {
      const prefix = options?.prefix;
      if (prefix !== undefined) {
        assertToolId(prefix, "MCP prefix");
      }
      const pending: Array<{ name: string; tool: AiSdkTool }> = [];
      const seen = new Set<string>();
      for (const [name, tool] of Object.entries(mcpTools)) {
        assertToolId(name, "MCP tool id");
        const fullName = prefix === undefined ? name : `${prefix}.${name}`;
        assertToolId(fullName);
        if (seen.has(fullName)) {
          throw new Error(`Tool '${fullName}' is already registered.`);
        }
        seen.add(fullName);
        if (tools.has(fullName)) {
          throw new Error(`Tool '${fullName}' is already registered.`);
        }
        pending.push({ name: fullName, tool });
      }
      for (const entry of pending) {
        tools.set(entry.name, entry.tool);
      }
    },
    register(name, tool) {
      insert(name, tool, "Tool");
    },
    names() {
      return list();
    },
    has(name) {
      return tools.has(name);
    },
  };
}
