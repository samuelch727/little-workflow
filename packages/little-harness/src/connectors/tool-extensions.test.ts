import type { ToolSet } from "ai";
import { describe, expect, it } from "vitest";
import {
  applyConnectorToolPolicy,
  extendTool,
  isConnectorToolExtension,
  resolveConnectorTools,
  resolveToolExtension,
} from "./tool-extensions.js";

describe("connector tool extensions", () => {
  it("brands tool extensions", () => {
    const base = executableTool("base");
    const extension = extendTool(base, {
      execute: async () => "connector",
    });

    expect(isConnectorToolExtension(extension)).toBe(true);
    expect(extension.tool).toBe(base);
  });

  it("keeps the base tool reference when loose callers pass a tool option", () => {
    const base = executableTool("base");
    const other = executableTool("other");
    const extension = extendTool(base, { tool: other } as any);

    expect(extension.tool).toBe(base);
  });

  it("keeps executable base tools and omits abstract tools during connector runs", () => {
    const tools = resolveConnectorTools({
      lookup: executableTool("lookup"),
      "add-reaction": abstractTool("react"),
    }, {});

    expect(Object.keys(tools)).toEqual(["lookup"]);
  });

  it("exposes abstract capability tools when the active connector provides execute", async () => {
    const base = abstractTool("React to the current message.");
    const extension = resolveToolExtension("add-reaction", base, extendTool(base, {
      execute: async (input: unknown) => ({ ok: true, input }),
    }));

    const tools = resolveConnectorTools({ "add-reaction": base }, { "add-reaction": extension });

    expect(Object.keys(tools)).toEqual(["add-reaction"]);
    await expect(executeTool(tools["add-reaction"], { emoji: "+1" })).resolves.toEqual({
      ok: true,
      input: { emoji: "+1" },
    });
  });

  it("lets connector extensions override portable tool execution", async () => {
    const base = executableTool("base");
    const extension = resolveToolExtension("lookup", base, extendTool(base, {
      execute: async () => "connector",
    }));

    const tools = resolveConnectorTools({ lookup: base }, { lookup: extension });

    await expect(executeTool(tools.lookup, undefined)).resolves.toBe("connector");
  });

  it("prefers the explicitly imported base over a same-named shared base tool", () => {
    // A shared `tools/add-reaction.ts` (schema X) exists AND the extension passes a DIFFERENT
    // imported base (schema Y). The author imported and passed a specific base, so name-matching
    // must not silently override it — the resolved tool must use schema Y.
    const sharedBase = { description: "shared", inputSchema: "schema-X" } as unknown as ToolSet[string];
    const importedBase = { description: "imported", inputSchema: "schema-Y" } as unknown as ToolSet[string];

    const resolved = resolveToolExtension(
      "add-reaction",
      sharedBase,
      extendTool(importedBase, { execute: async () => "ok" }),
    );

    expect((resolved as { inputSchema?: unknown }).inputSchema).toBe("schema-Y");
    expect((resolved as { description?: unknown }).description).toBe("imported");
  });

  it("rejects non-extension values when a base tool with the same name exists", () => {
    expect(() => resolveToolExtension("lookup", executableTool("base"), { execute: async () => "bad" }))
      .toThrow(/default-export extendTool/u);
  });

  it("accepts a plain executable tool as a connector-only tool (no base, no extendTool)", async () => {
    const plain = executableTool("connector-only");
    const resolved = resolveToolExtension("post-to-channel", undefined, plain);

    expect(resolved).toBe(plain);
    const tools = resolveConnectorTools({}, { "post-to-channel": resolved });
    expect(Object.keys(tools)).toEqual(["post-to-channel"]);
    await expect(executeTool(tools["post-to-channel"], undefined)).resolves.toBe("connector-only");
  });

  it("rejects a non-executable plain object as a connector-only tool", () => {
    expect(() => resolveToolExtension("broken", undefined, { description: "no execute" }))
      .toThrow(/execute|extendTool/u);
  });
});

describe("connector tool policy", () => {
  const tools = {
    "get-release-status": executableTool("get"),
    "render-dashboard": executableTool("render"),
    "list-releases": executableTool("list"),
  };

  it("passes through when no policy is given", () => {
    expect(applyConnectorToolPolicy(tools)).toBe(tools);
  });

  it("allow keeps only the listed tools (whitelist)", () => {
    expect(Object.keys(applyConnectorToolPolicy(tools, { allow: ["get-release-status"] }))).toEqual([
      "get-release-status",
    ]);
  });

  it("deny removes the listed tools (blacklist)", () => {
    expect(Object.keys(applyConnectorToolPolicy(tools, { deny: ["list-releases"] }))).toEqual([
      "get-release-status",
      "render-dashboard",
    ]);
  });

  it("deny wins over allow", () => {
    const result = applyConnectorToolPolicy(tools, {
      allow: ["get-release-status", "render-dashboard"],
      deny: ["render-dashboard"],
    });
    expect(Object.keys(result)).toEqual(["get-release-status"]);
  });

  it("ignores unknown tool names", () => {
    expect(Object.keys(applyConnectorToolPolicy(tools, { deny: ["nope"] }))).toEqual(
      Object.keys(tools),
    );
  });

  it("treats an empty allow list as 'expose nothing'", () => {
    expect(applyConnectorToolPolicy(tools, { allow: [] })).toEqual({});
  });

  it("returns an empty toolset when deny lists every tool", () => {
    expect(applyConnectorToolPolicy(tools, { deny: Object.keys(tools) })).toEqual({});
  });
});

function executableTool(value: string): ToolSet[string] {
  return {
    description: value,
    execute: async () => value,
  } as ToolSet[string];
}

function abstractTool(description: string): ToolSet[string] {
  return { description } as ToolSet[string];
}

async function executeTool(tool: ToolSet[string] | undefined, input: unknown): Promise<unknown> {
  const execute = (tool as { execute?: (input: unknown) => Promise<unknown> } | undefined)?.execute;
  if (execute === undefined) {
    throw new Error("missing execute");
  }
  return execute(input);
}
