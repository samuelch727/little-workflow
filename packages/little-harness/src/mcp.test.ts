import { asSchema, jsonSchema } from "ai";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { HarnessInputError } from "./errors.js";
import { resolveHarnessMcpGateway } from "./mcp.js";

type ExecutableTestTool = {
  description?: string;
  execute?: (input: unknown, options: unknown) => Promise<unknown> | unknown;
};

const textDecoder = new TextDecoder();

function decodeSkillFile(skill: unknown, path: string): string {
  return textDecoder.decode((skill as { files: Record<string, Uint8Array> }).files[path]);
}

describe("resolveHarnessMcpGateway", () => {
  it("creates list and call gateway tools and closes clients", async () => {
    const close = vi.fn(async () => {});
    const search = vi.fn(async (input: unknown) => ({ rows: [input] }));
    const gateway = await resolveHarnessMcpGateway({
      servers: [{
        id: "figma",
        description: "Read Figma design data.",
        transport: { type: "http", url: "https://mcp.example.com/figma" },
      }],
    }, {
      createClient: async () => ({
        tools: async () => ({
          search: {
            description: "Search designs",
            inputSchema: { type: "object", properties: { query: { type: "string" } } },
            execute: search,
          },
        }),
        close,
      }),
    });

    expect(Object.keys(gateway.tools).sort()).toEqual(["mcp_call_tool", "mcp_list_tools"]);
    const listTool = gateway.tools.mcp_list_tools as ExecutableTestTool;
    const callTool = gateway.tools.mcp_call_tool as ExecutableTestTool;
    const list = await listTool.execute?.({}, {});
    expect(list).toMatchObject({
      servers: [{ id: "figma", tools: [{ name: "search", description: "Search designs" }] }],
    });
    const result = await callTool.execute?.({
      server: "figma",
      tool: "search",
      args: { query: "button" },
    }, {});
    expect(result).toEqual({ rows: [{ query: "button" }] });
    expect(search).toHaveBeenCalledWith({ query: "button" }, expect.anything());
    await gateway.close();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("generates MCP guide skills from server guide declarations", async () => {
    const gateway = await resolveHarnessMcpGateway({
      servers: [{
        id: "figma",
        description: "Read Figma design data.",
        transport: { type: "http", url: "https://mcp.example.com/figma" },
        guide: {
          description: "Use when a task needs Figma design context.",
          body: "Always inspect design context before implementation.",
        },
      }],
    }, {
      createClient: async () => ({ tools: async () => ({}), close: async () => {} }),
    });

    expect(gateway.skills[0]).toMatchObject({
      name: "figma-mcp",
      description: "Use when a task needs Figma design context.",
      harnessDir: ".agents/skills/figma-mcp",
    });
    const skill = gateway.skills[0] as { files: Record<string, Uint8Array> };
    expect(new TextDecoder().decode(skill.files["SKILL.md"])).toContain(
      "Always inspect design context before implementation.",
    );
  });

  it("wraps configured MCP guide bodies with metadata and gateway guidance", async () => {
    const gateway = await resolveHarnessMcpGateway({
      servers: [{
        id: "figma",
        description: "Read Figma design data.",
        transport: { type: "http", url: "https://mcp.example.com/figma" },
        guide: {
          name: "figma-design",
          description: "Use when a task needs Figma design context.",
          body: "Always inspect design context before implementation.",
        },
      }],
    }, {
      createClient: async () => ({ tools: async () => ({}), close: async () => {} }),
    });

    const guideBody = decodeSkillFile(gateway.skills[0], "SKILL.md");
    expect(guideBody).toContain("---\nname: figma-design\ndescription: Use when a task needs Figma design context.\n---");
    expect(guideBody).toContain("Always inspect design context before implementation.");
    expect(guideBody).toContain("mcp_list_tools");
    expect(guideBody).toContain("mcp_call_tool");
  });

  it("uses configured gateway names when wrapping configured MCP guide bodies", async () => {
    const gateway = await resolveHarnessMcpGateway({
      gateway: { listToolName: "list_mcp", callToolName: false },
      servers: [{
        id: "figma",
        description: "Read Figma design data.",
        transport: { type: "http", url: "https://mcp.example.com/figma" },
        guide: {
          description: "Use when a task needs Figma design context.",
          body: "Always inspect design context before implementation.",
        },
      }],
    }, {
      createClient: async () => ({ tools: async () => ({}), close: async () => {} }),
    });

    const guideBody = decodeSkillFile(gateway.skills[0], "SKILL.md");
    expect(guideBody).toContain("list_mcp");
    expect(guideBody).not.toContain("mcp_list_tools");
    expect(guideBody).not.toContain("mcp_call_tool");
  });

  it("includes discovered MCP capabilities in gateway tool descriptors", async () => {
    const gateway = await resolveHarnessMcpGateway({
      servers: [{
        id: "figma",
        description: "Read Figma design data.",
        transport: { type: "http", url: "https://mcp.example.com/figma" },
      }],
    }, {
      createClient: async () => ({
        tools: async () => ({
          get_design_context: {
            description: "Get design context.",
            inputSchema: { type: "object", properties: { fileKey: { type: "string" } } },
          },
        }),
        close: async () => {},
      }),
    });

    expect(gateway.manifest.servers[0]?.tools[0]).toMatchObject({
      name: "get_design_context",
      description: "Get design context.",
    });
    const callTool = gateway.tools.mcp_call_tool as ExecutableTestTool;
    expect(callTool.description).toContain("get_design_context");
  });

  it("includes stdio command args and cwd in capability manifest transport identity", async () => {
    const gateway = await resolveHarnessMcpGateway({
      servers: [
        {
          id: "figma",
          description: "Read Figma design data.",
          transport: {
            type: "stdio",
            command: "node",
            args: ["./mcp/figma.mjs"],
            cwd: "/workspace",
            env: { FIGMA_TOKEN: "secret" },
            stderr: "inherit",
          },
        },
        {
          id: "github",
          description: "Read GitHub repository data.",
          transport: {
            type: "stdio",
            command: "node",
            args: ["./mcp/github.mjs"],
            cwd: "/workspace",
          },
        },
      ],
    }, {
      createClient: async () => ({ tools: async () => ({}), close: async () => {} }),
    });

    expect(gateway.manifest.servers.map((server) => ({
      id: server.id,
      transport: server.transport,
    }))).toEqual([
      {
        id: "figma",
        transport: {
          type: "stdio",
          command: "node",
          args: ["./mcp/figma.mjs"],
          cwd: "/workspace",
        },
      },
      {
        id: "github",
        transport: {
          type: "stdio",
          command: "node",
          args: ["./mcp/github.mjs"],
          cwd: "/workspace",
        },
      },
    ]);
    expect(gateway.manifest.servers[0]?.transport).not.toHaveProperty("env");
    expect(gateway.manifest.servers[0]?.transport).not.toHaveProperty("stderr");
  });

  it("strips credentials query and hash from HTTP manifest transport identity", async () => {
    const gateway = await resolveHarnessMcpGateway({
      servers: [{
        id: "remote",
        description: "Remote MCP.",
        transport: { type: "http", url: "https://user:pass@example.com/mcp?token=secret#frag" },
      }],
    }, {
      createClient: async () => ({
        tools: async () => ({
          search: { description: "Search remote data." },
        }),
        close: async () => {},
      }),
    });

    expect(gateway.manifest.servers[0]?.transport.url).toBe("https://example.com/mcp");
    const description = (gateway.tools.mcp_call_tool as ExecutableTestTool).description ?? "";
    expect(description).toContain("https://example.com/mcp");
    expect(description).not.toMatch(/\b(user|pass|token|secret)\b/);
  });

  it("applies include policy before exposing MCP tools", async () => {
    const gateway = await resolveHarnessMcpGateway({
      servers: [{
        id: "figma",
        description: "Read Figma design data.",
        transport: { type: "http", url: "https://mcp.example.com/figma" },
        tools: { include: ["search"] },
      }],
    }, {
      createClient: async () => ({
        tools: async () => ({
          search: { description: "Search designs" },
          inspect: { description: "Inspect designs" },
        }),
        close: async () => {},
      }),
    });

    expect(gateway.manifest.servers[0]?.tools.map((item) => item.name)).toEqual(["search"]);
  });

  it("applies exclude policy before exposing MCP tools", async () => {
    const gateway = await resolveHarnessMcpGateway({
      servers: [{
        id: "figma",
        description: "Read Figma design data.",
        transport: { type: "http", url: "https://mcp.example.com/figma" },
        tools: { exclude: ["inspect"] },
      }],
    }, {
      createClient: async () => ({
        tools: async () => ({
          search: { description: "Search designs" },
          inspect: { description: "Inspect designs" },
        }),
        close: async () => {},
      }),
    });

    expect(gateway.manifest.servers[0]?.tools.map((item) => item.name)).toEqual(["search"]);
  });

  it("wraps configured raw MCP tool JSON schemas before client discovery", async () => {
    let observedSchemas: unknown;
    const inputSchema = {
      type: "object" as const,
      properties: { query: { type: "string" as const } },
      required: ["query"],
    };
    const outputSchema = {
      type: "object" as const,
      properties: { rows: { type: "array" as const, items: { type: "string" as const } } },
    };

    await resolveHarnessMcpGateway({
      servers: [{
        id: "search",
        description: "Search project data.",
        transport: { type: "http", url: "https://mcp.example.com/search" },
        tools: {
          include: ["query"],
          schemas: {
            query: { inputSchema, outputSchema },
          },
        },
      }],
    }, {
      createClient: async () => ({
        tools: async (options) => {
          observedSchemas = options?.schemas;
          return {
            query: { inputSchema, outputSchema },
          };
        },
        close: async () => {},
      }),
    });

    const schemas = observedSchemas as Record<string, { inputSchema: unknown; outputSchema?: unknown }>;
    expect(schemas.query?.inputSchema).not.toBe(inputSchema);
    expect(schemas.query?.outputSchema).not.toBe(outputSchema);
    await expect(Promise.resolve(asSchema(schemas.query?.inputSchema as never).jsonSchema)).resolves.toEqual(
      inputSchema,
    );
    await expect(Promise.resolve(asSchema(schemas.query?.outputSchema as never).jsonSchema)).resolves.toEqual(
      outputSchema,
    );
  });

  it("passes configured Zod MCP tool schemas through as AI SDK compatible schemas", async () => {
    let observedSchemas: unknown;
    const inputSchema = z.object({ query: z.string() });
    const outputSchema = z.object({ rows: z.array(z.string()) });

    await resolveHarnessMcpGateway({
      servers: [{
        id: "search",
        description: "Search project data.",
        transport: { type: "http", url: "https://mcp.example.com/search" },
        tools: {
          include: ["query"],
          schemas: {
            query: { inputSchema, outputSchema },
          },
        },
      }],
    }, {
      createClient: async () => ({
        tools: async (options) => {
          observedSchemas = options?.schemas;
          return {
            query: { inputSchema: { type: "object" } },
          };
        },
        close: async () => {},
      }),
    });

    const schemas = observedSchemas as Record<string, { inputSchema: unknown; outputSchema?: unknown }>;
    expect(schemas.query?.inputSchema).toBe(inputSchema);
    expect(schemas.query?.outputSchema).toBe(outputSchema);
    await expect(Promise.resolve(asSchema(schemas.query?.inputSchema as never).jsonSchema)).resolves.toMatchObject({
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    });
    await expect(Promise.resolve(asSchema(schemas.query?.outputSchema as never).jsonSchema)).resolves.toMatchObject({
      type: "object",
      properties: {
        rows: {
          type: "array",
          items: { type: "string" },
        },
      },
      required: ["rows"],
    });
  });

  it("normalizes configured Zod MCP tool schemas returned by discovery into manifest schemas", async () => {
    const inputSchema = z.object({ query: z.string() });
    const outputSchema = z.object({ rows: z.array(z.string()) });

    const gateway = await resolveHarnessMcpGateway({
      servers: [{
        id: "search",
        description: "Search project data.",
        transport: { type: "http", url: "https://mcp.example.com/search" },
        tools: {
          include: ["query"],
          schemas: {
            query: { inputSchema, outputSchema },
          },
        },
      }],
    }, {
      createClient: async () => ({
        tools: async (options) => ({
          query: {
            inputSchema: options?.schemas?.query?.inputSchema,
            outputSchema: options?.schemas?.query?.outputSchema,
          },
        }),
        close: async () => {},
      }),
    });

    const manifestTool = gateway.manifest.servers[0]?.tools[0];
    expect(manifestTool?.inputSchemaHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(manifestTool?.outputSchemaHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(manifestTool?.inputSchema).toMatchObject({
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    });
    expect(manifestTool?.inputSchema).not.toBe(inputSchema);
    expect(manifestTool?.outputSchema).toMatchObject({
      type: "object",
      properties: {
        rows: {
          type: "array",
          items: { type: "string" },
        },
      },
      required: ["rows"],
    });
    expect(manifestTool?.outputSchema).not.toBe(outputSchema);

    const listTool = gateway.tools.mcp_list_tools as ExecutableTestTool;
    const list = await listTool.execute?.({}, {}) as {
      servers: Array<{
        tools: Array<{
          inputSchemaHash?: string;
          outputSchemaHash?: string;
          inputSchema?: unknown;
          outputSchema?: unknown;
        }>;
      }>;
    };
    const listedTool = list.servers[0]?.tools[0];
    expect(listedTool?.inputSchemaHash).toEqual(manifestTool?.inputSchemaHash);
    expect(listedTool?.outputSchemaHash).toEqual(manifestTool?.outputSchemaHash);
    expect(listedTool?.inputSchema).toEqual(manifestTool?.inputSchema);
    expect(listedTool?.inputSchema).not.toBe(inputSchema);
    expect(listedTool?.outputSchema).toEqual(manifestTool?.outputSchema);
    expect(listedTool?.outputSchema).not.toBe(outputSchema);
  });

  it("rejects configured MCP tool schema maps that are partial relative to include policy", async () => {
    await expect(resolveHarnessMcpGateway({
      servers: [{
        id: "search",
        description: "Search project data.",
        transport: { type: "http", url: "https://mcp.example.com/search" },
        tools: {
          include: ["query", "inspect"],
          schemas: {
            query: {
              inputSchema: {
                type: "object",
                properties: { query: { type: "string" } },
                required: ["query"],
              },
            },
          },
        },
      }],
    }, {
      createClient: async () => ({
        tools: async () => ({}),
        close: async () => {},
      }),
    })).rejects.toThrow(/MCP tool schemas must exactly match included tool names/i);
  });

  it("exposes renamed MCP tool names in manifests, listings, and calls", async () => {
    const search = vi.fn(async (input: unknown) => ({ rows: [input] }));
    const gateway = await resolveHarnessMcpGateway({
      servers: [{
        id: "figma",
        description: "Read Figma design data.",
        transport: { type: "http", url: "https://mcp.example.com/figma" },
        tools: { rename: { search: "find" } },
      }],
    }, {
      createClient: async () => ({
        tools: async () => ({
          search: { description: "Search designs", execute: search },
        }),
        close: async () => {},
      }),
    });

    expect(gateway.manifest.servers[0]?.tools.map((item) => item.name)).toEqual(["find"]);
    const list = await (gateway.tools.mcp_list_tools as ExecutableTestTool).execute?.({}, {}) as {
      servers: Array<{ tools: Array<{ name: string }> }>;
    };
    expect(list.servers[0]?.tools.map((item) => item.name)).toEqual(["find"]);
    await (gateway.tools.mcp_call_tool as ExecutableTestTool).execute?.({
      server: "figma",
      tool: "find",
      args: { query: "button" },
    }, {});
    expect(search).toHaveBeenCalledWith({ query: "button" }, expect.anything());
  });

  it("ignores inherited MCP tool rename values", async () => {
    const rename = Object.create({ search: "find" }) as Record<string, string>;
    const gateway = await resolveHarnessMcpGateway({
      servers: [{
        id: "figma",
        description: "Read Figma design data.",
        transport: { type: "http", url: "https://mcp.example.com/figma" },
        tools: { rename },
      }],
    }, {
      createClient: async () => ({
        tools: async () => ({
          search: { description: "Search designs" },
        }),
        close: async () => {},
      }),
    });

    expect(gateway.manifest.servers[0]?.tools.map((item) => item.name)).toEqual(["search"]);
  });

  it.each([["bad.name"], ["constructor"], ["__proto__"]])(
    "rejects invalid final visible MCP tool name %s",
    async (name) => {
      await expect(resolveHarnessMcpGateway({
        servers: [{
          id: "figma",
          description: "Read Figma design data.",
          transport: { type: "http", url: "https://mcp.example.com/figma" },
        }],
      }, {
        createClient: async () => ({
          tools: async () => Object.fromEntries([[name, { description: "Unsafe tool" }]]),
          close: async () => {},
        }),
      })).rejects.toBeInstanceOf(HarnessInputError);
    },
  );

  it("rejects rename target collisions in final visible MCP tool names", async () => {
    await expect(resolveHarnessMcpGateway({
      servers: [{
        id: "figma",
        description: "Read Figma design data.",
        transport: { type: "http", url: "https://mcp.example.com/figma" },
        tools: { rename: { search: "lookup" } },
      }],
    }, {
      createClient: async () => ({
        tools: async () => ({
          search: { description: "Search designs" },
          lookup: { description: "Lookup designs" },
        }),
        close: async () => {},
      }),
    })).rejects.toBeInstanceOf(HarnessInputError);
  });

  it("includes deterministic schema hashes in the capability manifest", async () => {
    const gateway = await resolveHarnessMcpGateway({
      servers: [{
        id: "figma",
        description: "Read Figma design data.",
        transport: { type: "http", url: "https://mcp.example.com/figma" },
      }],
    }, {
      createClient: async () => ({
        tools: async () => ({
          first: {
            inputSchema: {
              type: "object",
              properties: {
                fileKey: { type: "string" },
                nodeId: { type: "string" },
              },
            },
            outputSchema: {
              type: "object",
              properties: {
                name: { type: "string" },
                nodeCount: { type: "number" },
              },
            },
          },
          reordered: {
            inputSchema: {
              properties: {
                nodeId: { type: "string" },
                fileKey: { type: "string" },
              },
              type: "object",
            },
            outputSchema: {
              properties: {
                nodeCount: { type: "number" },
                name: { type: "string" },
              },
              type: "object",
            },
          },
          changed: {
            inputSchema: {
              type: "object",
              properties: {
                url: { type: "string" },
              },
            },
            outputSchema: {
              type: "object",
              properties: {
                ok: { type: "boolean" },
              },
            },
          },
        }),
        close: async () => {},
      }),
    });

    const [first, reordered, changed] = gateway.manifest.servers[0]?.tools ?? [];

    expect(first?.inputSchemaHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(first?.outputSchemaHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(reordered?.inputSchemaHash).toEqual(first?.inputSchemaHash);
    expect(reordered?.outputSchemaHash).toEqual(first?.outputSchemaHash);
    expect(changed?.inputSchemaHash).not.toEqual(first?.inputSchemaHash);
    expect(changed?.outputSchemaHash).not.toEqual(first?.outputSchemaHash);
  });

  it("exposes normalized plain and AI SDK wrapped schemas in manifests and listing", async () => {
    const plainInputSchema = {
      type: "object" as const,
      properties: {
        id: { type: "string" as const },
      },
      required: ["id"],
    };
    const plainOutputSchema = {
      type: "object" as const,
      properties: {
        ok: { type: "boolean" as const },
      },
      required: ["ok"],
    };
    const wrappedInputSchema = {
      type: "object" as const,
      properties: {
        query: { type: "string" as const },
      },
      required: ["query"],
    };
    const wrappedOutputSchema = {
      type: "object" as const,
      properties: {
        rows: {
          type: "array" as const,
          items: { type: "string" as const },
        },
      },
    };
    const aiSdkInputSchema = jsonSchema(wrappedInputSchema);
    const aiSdkOutputSchema = jsonSchema(wrappedOutputSchema);

    const gateway = await resolveHarnessMcpGateway({
      servers: [{
        id: "search",
        description: "Search project data.",
        transport: { type: "http", url: "https://mcp.example.com/search" },
      }],
    }, {
      createClient: async () => ({
        tools: async () => ({
          by_id: {
            inputSchema: plainInputSchema,
            outputSchema: plainOutputSchema,
          },
          search: {
            inputSchema: aiSdkInputSchema,
            outputSchema: aiSdkOutputSchema,
          },
        }),
        close: async () => {},
      }),
    });

    const [plainManifestTool, wrappedManifestTool] = gateway.manifest.servers[0]?.tools ?? [];
    expect(plainManifestTool?.inputSchemaHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(plainManifestTool?.outputSchemaHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(plainManifestTool?.inputSchema).toEqual(plainInputSchema);
    expect(plainManifestTool?.outputSchema).toEqual(plainOutputSchema);
    expect(wrappedManifestTool?.inputSchemaHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(wrappedManifestTool?.outputSchemaHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(wrappedManifestTool?.inputSchema).toEqual(wrappedInputSchema);
    expect(wrappedManifestTool?.inputSchema).not.toBe(aiSdkInputSchema);
    expect(wrappedManifestTool?.outputSchema).toEqual(wrappedOutputSchema);
    expect(wrappedManifestTool?.outputSchema).not.toBe(aiSdkOutputSchema);

    const listTool = gateway.tools.mcp_list_tools as ExecutableTestTool;
    const list = await listTool.execute?.({}, {}) as {
      servers: Array<{
        tools: Array<{
          inputSchemaHash?: string;
          outputSchemaHash?: string;
          inputSchema?: unknown;
          outputSchema?: unknown;
        }>;
      }>;
    };
    const [plainListedTool, wrappedListedTool] = list.servers[0]?.tools ?? [];
    expect(plainListedTool?.inputSchemaHash).toEqual(plainManifestTool?.inputSchemaHash);
    expect(plainListedTool?.outputSchemaHash).toEqual(plainManifestTool?.outputSchemaHash);
    expect(plainListedTool?.inputSchema).toEqual(plainInputSchema);
    expect(plainListedTool?.outputSchema).toEqual(plainOutputSchema);
    expect(wrappedListedTool?.inputSchemaHash).toEqual(wrappedManifestTool?.inputSchemaHash);
    expect(wrappedListedTool?.outputSchemaHash).toEqual(wrappedManifestTool?.outputSchemaHash);
    expect(wrappedListedTool?.inputSchema).toEqual(wrappedInputSchema);
    expect(wrappedListedTool?.inputSchema).not.toBe(aiSdkInputSchema);
    expect(wrappedListedTool?.outputSchema).toEqual(wrappedOutputSchema);
    expect(wrappedListedTool?.outputSchema).not.toBe(aiSdkOutputSchema);
  });

  it("passes omitted and null MCP tool args through unchanged", async () => {
    const inspect = vi.fn(async (input: unknown) => ({ input }));
    const gateway = await resolveHarnessMcpGateway({
      servers: [{
        id: "figma",
        description: "Read Figma design data.",
        transport: { type: "http", url: "https://mcp.example.com/figma" },
      }],
    }, {
      createClient: async () => ({
        tools: async () => ({
          inspect: { execute: inspect },
        }),
        close: async () => {},
      }),
    });
    const callTool = gateway.tools.mcp_call_tool as ExecutableTestTool;

    await callTool.execute?.({ server: "figma", tool: "inspect" }, {});
    await callTool.execute?.({ server: "figma", tool: "inspect", args: null }, {});

    expect(inspect).toHaveBeenNthCalledWith(1, undefined, expect.anything());
    expect(inspect).toHaveBeenNthCalledWith(2, null, expect.anything());
  });

  it("changes gateway tool descriptors when discovered tool details change", async () => {
    async function callToolDescriptionFor(description: string, inputSchema: unknown): Promise<string | undefined> {
      const gateway = await resolveHarnessMcpGateway({
        servers: [{
          id: "figma",
          description: "Read Figma design data.",
          transport: { type: "http", url: "https://mcp.example.com/figma" },
        }],
      }, {
        createClient: async () => ({
          tools: async () => ({
            get_design_context: {
              description,
              inputSchema,
            },
          }),
          close: async () => {},
        }),
      });

      return (gateway.tools.mcp_call_tool as ExecutableTestTool).description;
    }

    const first = await callToolDescriptionFor(
      "Get design context by file key.",
      { type: "object", properties: { fileKey: { type: "string" } }, required: ["fileKey"] },
    );
    const second = await callToolDescriptionFor(
      "Get design context by node id.",
      { type: "object", properties: { nodeId: { type: "string" } }, required: ["nodeId"] },
    );

    expect(first).toContain("Get design context by file key.");
    expect(first).toContain("fileKey");
    expect(second).toContain("Get design context by node id.");
    expect(second).toContain("nodeId");
    expect(first).not.toEqual(second);
  });

  it("rejects duplicate guide names before creating clients", async () => {
    const createClient = vi.fn(async () => ({ tools: async () => ({}), close: async () => {} }));

    await expect(resolveHarnessMcpGateway({
      servers: [
        {
          id: "figma",
          description: "Read Figma design data.",
          transport: { type: "http", url: "https://mcp.example.com/figma" },
          guide: { name: "mcp-design", description: "Use Figma.", body: "Use Figma." },
        },
        {
          id: "sketch",
          description: "Read Sketch design data.",
          transport: { type: "http", url: "https://mcp.example.com/sketch" },
          guide: { name: "mcp-design", description: "Use Sketch.", body: "Use Sketch." },
        },
      ],
    }, { createClient })).rejects.toBeInstanceOf(HarnessInputError);
    expect(createClient).not.toHaveBeenCalled();
  });

  it("closes already opened clients when a later server fails", async () => {
    const close = vi.fn(async () => {});
    await expect(resolveHarnessMcpGateway({
      servers: [
        { id: "one", description: "One.", transport: { type: "http", url: "https://one.example.com/mcp" } },
        { id: "two", description: "Two.", transport: { type: "http", url: "https://two.example.com/mcp" } },
      ],
    }, {
      createClient: async (_server, index) => {
        if (index === 1) throw new Error("connect failed");
        return { tools: async () => ({}), close };
      },
    })).rejects.toThrow("connect failed");
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("closes opened clients when guide skill generation fails", async () => {
    const close = vi.fn(async () => {});

    await expect(resolveHarnessMcpGateway({
      servers: [{
        id: "figma",
        description: "Read Figma design data.",
        transport: { type: "http", url: "https://mcp.example.com/figma" },
        guide: {
          description: "Use when a task needs Figma design context.",
          body: "Always inspect design context before implementation.",
          files: { "SKILL.md": "bad" },
        },
      }],
    }, {
      createClient: async () => ({ tools: async () => ({}), close }),
    })).rejects.toBeInstanceOf(HarnessInputError);

    expect(close).toHaveBeenCalledTimes(1);
  });

  it("closes every opened client on setup failure when one close throws synchronously", async () => {
    const firstClose = vi.fn(() => {
      throw new Error("close failed");
    });
    const secondClose = vi.fn(async () => {});

    await expect(resolveHarnessMcpGateway({
      servers: [
        { id: "one", description: "One.", transport: { type: "http", url: "https://one.example.com/mcp" } },
        { id: "two", description: "Two.", transport: { type: "http", url: "https://two.example.com/mcp" } },
      ],
    }, {
      createClient: async (_server, index) => index === 0
        ? { tools: async () => ({}), close: firstClose as never }
        : {
          tools: async () => {
            throw new Error("schema discovery failed");
          },
          close: secondClose,
        },
    })).rejects.toThrow("schema discovery failed");

    expect(firstClose).toHaveBeenCalledTimes(1);
    expect(secondClose).toHaveBeenCalledTimes(1);
  });

  it("attempts every client close and rejects when explicit close fails", async () => {
    const firstClose = vi.fn(() => {
      throw new Error("close failed");
    });
    const secondClose = vi.fn(async () => {});

    const gateway = await resolveHarnessMcpGateway({
      servers: [
        { id: "one", description: "One.", transport: { type: "http", url: "https://one.example.com/mcp" } },
        { id: "two", description: "Two.", transport: { type: "http", url: "https://two.example.com/mcp" } },
      ],
    }, {
      createClient: async (_server, index) => ({
        tools: async () => ({}),
        close: index === 0 ? firstClose as never : secondClose,
      }),
    });

    await expect(gateway.close()).rejects.toThrow("close failed");
    expect(firstClose).toHaveBeenCalledTimes(1);
    expect(secondClose).toHaveBeenCalledTimes(1);
  });

  it("rejects normalized guide files that override SKILL.md and closes opened clients", async () => {
    const close = vi.fn(async () => {});

    await expect(resolveHarnessMcpGateway({
      servers: [{
        id: "figma",
        description: "Read Figma design data.",
        transport: { type: "http", url: "https://mcp.example.com/figma" },
        guide: {
          description: "Use when a task needs Figma design context.",
          body: "Always inspect design context before implementation.",
          files: { "./SKILL.md": "bad" },
        },
      }],
    }, {
      createClient: async () => ({ tools: async () => ({}), close }),
    })).rejects.toBeInstanceOf(HarnessInputError);

    expect(close).toHaveBeenCalledTimes(1);
  });

  it("rejects duplicate normalized guide auxiliary file paths", async () => {
    const close = vi.fn(async () => {});

    await expect(resolveHarnessMcpGateway({
      servers: [{
        id: "figma",
        description: "Read Figma design data.",
        transport: { type: "http", url: "https://mcp.example.com/figma" },
        guide: {
          description: "Use when a task needs Figma design context.",
          body: "Always inspect design context before implementation.",
          files: {
            "references/a.md": "first",
            "references/./a.md": "second",
          },
        },
      }],
    }, {
      createClient: async () => ({ tools: async () => ({}), close }),
    })).rejects.toBeInstanceOf(HarnessInputError);

    expect(close).toHaveBeenCalledTimes(1);
  });

  it("rejects unsupported discovered MCP schema objects with a clear input error", async () => {
    const close = vi.fn(async () => {});
    const unsupportedSchema = new Map([["type", "object"]]);

    const rejection = expect(resolveHarnessMcpGateway({
      servers: [{
        id: "search",
        description: "Search project data.",
        transport: { type: "http", url: "https://mcp.example.com/search" },
      }],
    }, {
      createClient: async () => ({
        tools: async () => ({
          search: {
            inputSchema: unsupportedSchema,
          },
        }),
        close,
      }),
    })).rejects;

    await rejection.toBeInstanceOf(HarnessInputError);
    await rejection.toThrow(/unsupported MCP schema|schema must be JSON schema/i);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("includes gateway tool names and guide content hashes in the capability manifest", async () => {
    async function gatewayForGuideBody(body: string) {
      return resolveHarnessMcpGateway({
        servers: [{
          id: "figma",
          description: "Read Figma design data.",
          transport: { type: "http", url: "https://mcp.example.com/figma" },
          guide: {
            description: "Use when a task needs Figma design context.",
            body,
          },
        }],
      }, {
        createClient: async () => ({ tools: async () => ({}), close: async () => {} }),
      });
    }

    const first = await gatewayForGuideBody("Inspect the selected Figma node.");
    const second = await gatewayForGuideBody("Inspect the selected Figma file.");
    const firstManifest = first.manifest;
    const secondManifest = second.manifest;

    expect(firstManifest.gateway).toEqual({
      listToolName: "mcp_list_tools",
      callToolName: "mcp_call_tool",
    });
    expect(firstManifest.servers[0]?.guide?.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(secondManifest.servers[0]?.guide?.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(firstManifest.servers[0]?.guide?.contentHash).not.toEqual(
      secondManifest.servers[0]?.guide?.contentHash,
    );
    expect((first.tools.mcp_list_tools as ExecutableTestTool).description).toContain("mcp_call_tool");
    expect((first.tools.mcp_list_tools as ExecutableTestTool).description).toContain(
      firstManifest.servers[0]?.guide?.contentHash,
    );
  });

  it("uses custom gateway tool names in generated guides and guide content hashes", async () => {
    async function gatewayFor(gateway?: { listToolName?: string; callToolName?: string }) {
      return resolveHarnessMcpGateway({
        ...(gateway === undefined ? {} : { gateway }),
        servers: [{
          id: "figma",
          description: "Read Figma design data.",
          transport: { type: "http", url: "https://mcp.example.com/figma" },
        }],
      }, {
        createClient: async () => ({ tools: async () => ({}), close: async () => {} }),
      });
    }

    const defaults = await gatewayFor();
    const custom = await gatewayFor({ listToolName: "list_mcp", callToolName: "call_mcp" });
    const guideBody = decodeSkillFile(custom.skills[0], "SKILL.md");

    expect(guideBody).toContain("list_mcp");
    expect(guideBody).toContain("call_mcp");
    expect(guideBody).not.toContain("mcp_list_tools");
    expect(guideBody).not.toContain("mcp_call_tool");
    expect(custom.manifest.servers[0]?.guide?.contentHash).not.toEqual(
      defaults.manifest.servers[0]?.guide?.contentHash,
    );
  });

  it("omits disabled gateway tool names from generated guides", async () => {
    const callOnly = await resolveHarnessMcpGateway({
      gateway: { listToolName: false, callToolName: "call_mcp" },
      servers: [{
        id: "figma",
        description: "Read Figma design data.",
        transport: { type: "http", url: "https://mcp.example.com/figma" },
      }],
    }, {
      createClient: async () => ({ tools: async () => ({}), close: async () => {} }),
    });
    const callOnlyGuideBody = decodeSkillFile(callOnly.skills[0], "SKILL.md");

    expect(callOnlyGuideBody).not.toContain("mcp_list_tools");
    expect(callOnlyGuideBody).toContain("call_mcp");

    const disabled = await resolveHarnessMcpGateway({
      gateway: { listToolName: false, callToolName: false },
      servers: [{
        id: "figma",
        description: "Read Figma design data.",
        transport: { type: "http", url: "https://mcp.example.com/figma" },
      }],
    }, {
      createClient: async () => ({ tools: async () => ({}), close: async () => {} }),
    });
    const disabledGuideBody = decodeSkillFile(disabled.skills[0], "SKILL.md");

    expect(disabledGuideBody).not.toContain("mcp_list_tools");
    expect(disabledGuideBody).not.toContain("mcp_call_tool");
  });

  it("exposes direct alias tools with server id prefixes", async () => {
    const search = vi.fn(async (input: unknown) => ({ rows: [input] }));
    const inputSchema = { type: "object", properties: { query: { type: "string" } }, required: ["query"] };
    const gateway = await resolveHarnessMcpGateway({
      gateway: { aliases: { prefix: "server_id" } },
      servers: [{
        id: "figma",
        description: "Read Figma design data.",
        transport: { type: "http", url: "https://mcp.example.com/figma" },
      }],
    }, {
      createClient: async () => ({
        tools: async () => ({
          search: {
            description: "Search designs",
            inputSchema,
            execute: search,
          },
        }),
        close: async () => {},
      }),
    });

    expect(Object.keys(gateway.tools).sort()).toEqual(["figma_search", "mcp_call_tool", "mcp_list_tools"]);
    const aliasInputSchema = (gateway.tools.figma_search as { inputSchema?: never }).inputSchema;
    await expect(Promise.resolve(asSchema(aliasInputSchema).jsonSchema)).resolves.toEqual(inputSchema);
    const result = await (gateway.tools.figma_search as ExecutableTestTool).execute?.({ query: "button" }, {});

    expect(result).toEqual({ rows: [{ query: "button" }] });
    expect(search).toHaveBeenCalledWith({ query: "button" }, expect.anything());
  });

  it("ignores inherited MCP direct alias prefix values", async () => {
    const prefix = Object.create({ figma: "unsafe" }) as Record<string, string>;
    const gateway = await resolveHarnessMcpGateway({
      gateway: { aliases: { prefix } },
      servers: [{
        id: "figma",
        description: "Read Figma design data.",
        transport: { type: "http", url: "https://mcp.example.com/figma" },
      }],
    }, {
      createClient: async () => ({
        tools: async () => ({
          search: { execute: async (input: unknown) => input },
        }),
        close: async () => {},
      }),
    });

    expect(Object.keys(gateway.tools).sort()).toEqual(["figma_search", "mcp_call_tool", "mcp_list_tools"]);
    expect(gateway.tools.unsafe_search).toBeUndefined();
  });

  it("wraps direct alias JSON schemas for AI SDK tool schema normalization", async () => {
    const inputSchema = { type: "object", properties: { query: { type: "string" } }, required: ["query"] };
    const gateway = await resolveHarnessMcpGateway({
      gateway: { aliases: { prefix: "server_id" } },
      servers: [{
        id: "search",
        description: "Search project data.",
        transport: { type: "http", url: "https://mcp.example.com/search" },
      }],
    }, {
      createClient: async () => ({
        tools: async () => ({
          query: {
            inputSchema,
            execute: async (input: unknown) => input,
          },
        }),
        close: async () => {},
      }),
    });

    expect(gateway.manifest.servers[0]?.tools[0]?.inputSchema).toEqual(inputSchema);
    expect(gateway.manifest.servers[0]?.tools[0]?.inputSchema).not.toBe(
      (gateway.tools.search_query as { inputSchema?: unknown }).inputSchema,
    );
    const aliasInputSchema = (gateway.tools.search_query as { inputSchema?: never }).inputSchema;
    await expect(Promise.resolve(asSchema(aliasInputSchema).jsonSchema)).resolves.toEqual(inputSchema);
  });

  it("wraps direct alias input and output JSON schemas while keeping listings plain", async () => {
    const inputSchema = { type: "object", properties: { query: { type: "string" } }, required: ["query"] };
    const outputSchema = {
      type: "object",
      properties: { rows: { type: "array", items: { type: "string" } } },
      required: ["rows"],
    };
    const gateway = await resolveHarnessMcpGateway({
      gateway: { aliases: { prefix: "server_id" } },
      servers: [{
        id: "search",
        description: "Search project data.",
        transport: { type: "http", url: "https://mcp.example.com/search" },
      }],
    }, {
      createClient: async () => ({
        tools: async () => ({
          query: {
            inputSchema,
            outputSchema,
            execute: async (input: unknown) => ({ rows: [input] }),
          },
        }),
        close: async () => {},
      }),
    });

    const alias = gateway.tools.search_query as { inputSchema?: never; outputSchema?: never };
    await expect(Promise.resolve(asSchema(alias.inputSchema).jsonSchema)).resolves.toEqual(inputSchema);
    await expect(Promise.resolve(asSchema(alias.outputSchema).jsonSchema)).resolves.toEqual(outputSchema);

    const manifestTool = gateway.manifest.servers[0]?.tools[0];
    expect(manifestTool?.inputSchema).toEqual(inputSchema);
    expect(manifestTool?.outputSchema).toEqual(outputSchema);
    expect(manifestTool?.inputSchema).not.toBe(alias.inputSchema);
    expect(manifestTool?.outputSchema).not.toBe(alias.outputSchema);

    const listTool = gateway.tools.mcp_list_tools as ExecutableTestTool;
    const list = await listTool.execute?.({}, {});
    const listedTool = (list as { servers: Array<{ tools: Array<{ inputSchema?: unknown; outputSchema?: unknown }> }> })
      .servers[0]?.tools[0];
    expect(listedTool?.inputSchema).toEqual(inputSchema);
    expect(listedTool?.outputSchema).toEqual(outputSchema);
    expect(listedTool?.inputSchema).not.toBe(alias.inputSchema);
    expect(listedTool?.outputSchema).not.toBe(alias.outputSchema);
  });

  it("changes guide content hashes when auxiliary guide files change", async () => {
    async function gatewayForReadme(content: string) {
      return resolveHarnessMcpGateway({
        servers: [{
          id: "figma",
          description: "Read Figma design data.",
          transport: { type: "http", url: "https://mcp.example.com/figma" },
          guide: {
            description: "Use when a task needs Figma design context.",
            body: "Always inspect design context before implementation.",
            files: { "README.md": content },
          },
        }],
      }, {
        createClient: async () => ({ tools: async () => ({}), close: async () => {} }),
      });
    }

    const first = await gatewayForReadme("Auxiliary notes v1.");
    const second = await gatewayForReadme("Auxiliary notes v2.");

    expect(first.manifest.servers[0]?.guide?.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(second.manifest.servers[0]?.guide?.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.manifest.servers[0]?.guide?.contentHash).not.toEqual(
      second.manifest.servers[0]?.guide?.contentHash,
    );
  });

  it("stages top-level __proto__ MCP guide auxiliary file paths as normal files", async () => {
    const gateway = await resolveHarnessMcpGateway({
      servers: [{
        id: "figma",
        description: "Read Figma design data.",
        transport: { type: "http", url: "https://mcp.example.com/figma" },
        guide: {
          description: "Use when a task needs Figma design context.",
          body: "Always inspect design context before implementation.",
          files: { ["__proto__"]: "Prototype notes." },
        },
      }],
    }, {
      createClient: async () => ({ tools: async () => ({}), close: async () => {} }),
    });

    const skill = gateway.skills[0] as { files: Record<string, Uint8Array> };
    expect(Object.prototype.hasOwnProperty.call(skill.files, "__proto__")).toBe(true);
    expect(decodeSkillFile(gateway.skills[0], "__proto__")).toBe("Prototype notes.");
    expect(gateway.manifest.servers[0]?.guide?.files).toContainEqual({
      path: "__proto__",
      hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });
  });

  it("exposes normalized guide file identities in the capability manifest", async () => {
    const gateway = await resolveHarnessMcpGateway({
      servers: [{
        id: "figma",
        description: "Read Figma design data.",
        transport: { type: "http", url: "https://mcp.example.com/figma" },
        guide: {
          description: "Use when a task needs Figma design context.",
          body: "Always inspect design context before implementation.",
          files: { "references/./notes.md": "Review tokens before implementation." },
        },
      }],
    }, {
      createClient: async () => ({ tools: async () => ({}), close: async () => {} }),
    });

    const guideFiles = gateway.manifest.servers[0]?.guide?.files;
    expect(guideFiles).toEqual([
      { path: "SKILL.md", hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/) },
      { path: "references/notes.md", hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/) },
    ]);
  });
});
