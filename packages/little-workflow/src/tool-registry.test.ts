import { tool } from "ai";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { AiSdkTool, createToolRegistry } from "./tool-registry.js";

describe("createToolRegistry", () => {
  it("stores ai sdk tools and exposes deterministic views", () => {
    const registry = createToolRegistry({
      lookup: tool({
        description: "Lookup",
        inputSchema: z.object({ id: z.string() }),
        outputSchema: z.object({ id: z.string() }),
        execute: async ({ id }) => ({ id }),
      }),
    });

    expect(registry.get("lookup")).toBeDefined();
    expect(registry.list()).toEqual(["lookup"]);
    expect(registry.toRecord()).toHaveProperty("lookup");
    expect(registry.snapshotForManifest()[0]?.id).toBe("lookup");
  });

  it("attaches MCP tools with a prefix", () => {
    const registry = createToolRegistry({
      lookup: tool({
        description: "Lookup",
        inputSchema: z.object({ id: z.string() }),
        execute: async ({ id }) => ({ id }),
      }),
    });
    registry.attachMcpTools({
      search: tool({
        description: "Search MCP",
        inputSchema: z.object({ query: z.string() }),
        execute: async ({ query }) => ({ query }),
      }),
    }, { prefix: "atlas" });

    expect(registry.list()).toEqual(["atlas.search", "lookup"]);
    expect(registry.get("atlas.search")).toBeDefined();
  });

  it("rejects MCP attachment collisions", () => {
    const registry = createToolRegistry({
      search: tool({
        description: "Search local",
        inputSchema: z.object({ query: z.string() }),
        execute: async ({ query }) => ({ query }),
      }),
    });

    expect(() => registry.attachMcpTools({
      search: tool({
        description: "Search MCP",
        inputSchema: z.object({ query: z.string() }),
        execute: async ({ query }) => ({ query }),
      }),
    })).toThrow(/already registered/i);
  });

  it("rejects prefixed MCP collisions", () => {
    const registry = createToolRegistry({
      "atlas.search": tool({
        description: "Search local",
        inputSchema: z.object({ query: z.string() }),
        execute: async ({ query }) => ({ query }),
      }),
    });

    expect(() => registry.attachMcpTools({
      search: tool({
        description: "Search MCP",
        inputSchema: z.object({ query: z.string() }),
        execute: async ({ query }) => ({ query }),
      }),
    }, { prefix: "atlas" })).toThrow(/already registered/i);
  });

  it("rejects invalid tool ids", () => {
    expect(() => createToolRegistry({
      "  bad": tool({
        description: "bad",
        inputSchema: z.object({}),
        execute: async () => null,
      }),
    })).toThrow(/tool id/i);
  });
});

describe("AiSdkTool — v6 needsApproval signature", () => {
  it("accepts a v6-style needsApproval function (input, options) => boolean", () => {
    const t = tool({
      description: "demo",
      inputSchema: z.object({ q: z.string() }),
      execute: async ({ q }) => ({ q }),
      needsApproval: (_input, _options) => true,
    });
    // The fact that this assigns to AiSdkTool without a type error is the test.
    const asAiSdkTool: AiSdkTool = t;
    expect(asAiSdkTool).toBeDefined();
  });

  it("accepts a v6-style async needsApproval (returns PromiseLike<boolean>)", () => {
    const t = tool({
      description: "demo-async",
      inputSchema: z.object({ q: z.string() }),
      execute: async ({ q }) => ({ q }),
      needsApproval: async (_input, _options) => false,
    });
    const asAiSdkTool: AiSdkTool = t;
    expect(asAiSdkTool).toBeDefined();
  });

  it("still accepts a boolean needsApproval", () => {
    const t = tool({
      description: "demo-bool",
      inputSchema: z.object({ q: z.string() }),
      execute: async ({ q }) => ({ q }),
      needsApproval: true,
    });
    const asAiSdkTool: AiSdkTool = t;
    expect(asAiSdkTool).toBeDefined();
  });
});
