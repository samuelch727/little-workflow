import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ToolSet } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import { HarnessInputError } from "../errors.js";
import { importDefault } from "../workspace/module-loader.js";
import { discoverConnectors, loadConnectorDescriptor, loadConnectorToolExtensions } from "./discovery.js";

const here = import.meta.dirname;
const descriptorPath = resolve(here, "descriptors.ts");
const toolExtensionsPath = resolve(here, "tool-extensions.ts");

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tmpAgent() {
  const dir = await mkdtemp(join(tmpdir(), "lh-connectors-"));
  dirs.push(dir);
  return join(dir, "agents", "support");
}

describe("connector discovery", () => {
  it("discovers connector files and nested connector modules with kind metadata", async () => {
    const agent = await tmpAgent();
    await mkdir(join(agent, "connectors", "discord"), { recursive: true });
    await writeFile(
      join(agent, "connectors", "slack.ts"),
      `import { chatSdkConnector } from ${JSON.stringify(descriptorPath)};
       export default chatSdkConnector({ userName: "support", adapter: { name: "slack", create: () => ({}) }, state: () => ({}) });`,
    );
    await writeFile(
      join(agent, "connectors", "web-rich.ts"),
      `import { webRichConnector } from ${JSON.stringify(descriptorPath)};
       export default webRichConnector({ authenticate: async () => ({ id: "u1" }), session: ({ body, user }) => user.id + ":" + body.id });`,
    );
    await writeFile(
      join(agent, "connectors", "discord", "connector.ts"),
      `import { chatSdkConnector } from ${JSON.stringify(descriptorPath)};
       export default chatSdkConnector({ userName: "support", adapter: { name: "discord", create: () => ({}) }, state: () => ({}) });`,
    );
    await writeFile(join(agent, "connectors", "ignored.test.ts"), "export default {};");

    await expect(discoverConnectors(agent)).resolves.toEqual([
      { id: "discord", kind: "chat-sdk", path: join(agent, "connectors", "discord", "connector.ts") },
      { id: "slack", kind: "chat-sdk", path: join(agent, "connectors", "slack.ts") },
      { id: "web-rich", kind: "web-rich", path: join(agent, "connectors", "web-rich.ts") },
    ]);
  });

  it("loads a connector descriptor by id and rejects missing ids", async () => {
    const agent = await tmpAgent();
    await mkdir(join(agent, "connectors"), { recursive: true });
    await writeFile(
      join(agent, "connectors", "slack.ts"),
      `import { chatSdkConnector } from ${JSON.stringify(descriptorPath)};
       export default chatSdkConnector({ userName: "support", adapter: { name: "slack", create: () => ({}) }, state: () => ({}) });`,
    );

    await expect(loadConnectorDescriptor(agent, "slack")).resolves.toMatchObject({ kind: "chat-sdk" });
    await expect(loadConnectorDescriptor(agent, "telegram")).rejects.toThrow(HarnessInputError);
    await expect(loadConnectorDescriptor(agent, "telegram")).rejects.toThrow(/Connector not found/u);
  });

  it("skips non-connector modules while enumerating valid connectors", async () => {
    const agent = await tmpAgent();
    await mkdir(join(agent, "connectors"), { recursive: true });
    await writeFile(
      join(agent, "connectors", "slack.ts"),
      `import { chatSdkConnector } from ${JSON.stringify(descriptorPath)};
       export default chatSdkConnector({ userName: "support", adapter: { name: "slack", create: () => ({}) }, state: () => ({}) });`,
    );
    await writeFile(
      join(agent, "connectors", "notes.ts"),
      `export default { title: "not a connector" };`,
    );
    await writeFile(
      join(agent, "connectors", "invalid.ts"),
      `export default { kind: "not-a-little-harness-connector" };`,
    );
    await writeFile(
      join(agent, "connectors", "helper.ts"),
      `export const helper = true;`,
    );

    // Flat `connectors/<id>.ts` files that fail to load or aren't descriptors are skipped, but each
    // skip is surfaced (helper files disappearing silently generate "my connector isn't found" tickets).
    const skipped: string[] = [];
    await expect(discoverConnectors(agent, { onSkip: (s) => skipped.push(s.id) })).resolves.toEqual([
      { id: "slack", kind: "chat-sdk", path: join(agent, "connectors", "slack.ts") },
    ]);
    expect(skipped.sort()).toEqual(["helper", "invalid", "notes"]);
  });

  it("hard-errors when a nested connector module fails descriptor validation", async () => {
    const agent = await tmpAgent();
    await mkdir(join(agent, "connectors", "discord"), { recursive: true });
    // A nested `connectors/<id>/connector.*` folder unambiguously intends to be a connector, so a
    // bad descriptor is fatal rather than silently dropped.
    await writeFile(
      join(agent, "connectors", "discord", "connector.ts"),
      `export default { kind: "not-a-little-harness-connector" };`,
    );

    await expect(discoverConnectors(agent)).rejects.toThrow(HarnessInputError);
    await expect(discoverConnectors(agent)).rejects.toThrow(/Failed to load connector module/u);
  });

  it("hard-errors when a nested connector module fails to import", async () => {
    const agent = await tmpAgent();
    await mkdir(join(agent, "connectors", "discord"), { recursive: true });
    await writeFile(
      join(agent, "connectors", "discord", "connector.ts"),
      `throw new Error("boom while importing");\nexport default {};`,
    );

    await expect(discoverConnectors(agent)).rejects.toThrow(/Failed to load connector module/u);
  });

  it("throws for a requested connector module that fails descriptor validation", async () => {
    const agent = await tmpAgent();
    await mkdir(join(agent, "connectors"), { recursive: true });
    await writeFile(
      join(agent, "connectors", "invalid.ts"),
      `export default { kind: "not-a-little-harness-connector" };`,
    );

    await expect(loadConnectorDescriptor(agent, "invalid")).rejects.toThrow(HarnessInputError);
    await expect(loadConnectorDescriptor(agent, "invalid")).rejects.toThrow(/default-export/u);
  });

  it("loads only the requested connector module by id", async () => {
    const agent = await tmpAgent();
    await mkdir(join(agent, "connectors"), { recursive: true });
    await writeFile(
      join(agent, "connectors", "web-rich.ts"),
      `import { webRichConnector } from ${JSON.stringify(descriptorPath)};
       export default webRichConnector({ authenticate: async () => ({ id: "u1" }), session: ({ body }) => body.id });`,
    );
    await writeFile(
      join(agent, "connectors", "slack.ts"),
      `throw new Error("unrelated connector should not be imported");
       export default {};`,
    );

    await expect(loadConnectorDescriptor(agent, "web-rich")).resolves.toMatchObject({ kind: "web-rich" });
  });

  it("rejects duplicate connector ids instead of choosing one implicitly", async () => {
    const agent = await tmpAgent();
    await mkdir(join(agent, "connectors", "slack"), { recursive: true });
    await writeFile(
      join(agent, "connectors", "slack.ts"),
      `import { chatSdkConnector } from ${JSON.stringify(descriptorPath)};
       export default chatSdkConnector({ userName: "support", adapter: { name: "slack", create: () => ({}) }, state: () => ({}) });`,
    );
    await writeFile(
      join(agent, "connectors", "slack", "connector.ts"),
      `import { chatSdkConnector } from ${JSON.stringify(descriptorPath)};
       export default chatSdkConnector({ userName: "support", adapter: { name: "slack", create: () => ({}) }, state: () => ({}) });`,
    );

    await expect(discoverConnectors(agent)).rejects.toThrow(HarnessInputError);
    await expect(discoverConnectors(agent)).rejects.toThrow(/Duplicate connector id/u);
  });

  // chmod(0) cannot deny access to root, so the expected EACCES never happens under uid 0.
  it.skipIf(process.getuid?.() === 0)(
    "surfaces unexpected filesystem errors while reading connector directories",
    async () => {
      const agent = await tmpAgent();
      const connectorsDir = join(agent, "connectors");
      await mkdir(connectorsDir, { recursive: true });
      await chmod(connectorsDir, 0);

      try {
        await expect(discoverConnectors(agent)).rejects.toThrow(HarnessInputError);
        await expect(discoverConnectors(agent)).rejects.toThrow(/Unable to read connector directory/u);
      } finally {
        await chmod(connectorsDir, 0o700);
      }
    },
  );

  it("loads nested connector tool extensions by connector id and tool filename", async () => {
    const agent = await tmpAgent();
    await mkdir(join(agent, "tools"), { recursive: true });
    await mkdir(join(agent, "connectors", "slack", "tools"), { recursive: true });
    await writeFile(
      join(agent, "tools", "add-reaction.ts"),
      `export default { description: "React to the current message." };`,
    );
    await writeFile(
      join(agent, "connectors", "slack", "connector.ts"),
      `import { chatSdkConnector } from ${JSON.stringify(descriptorPath)};
       export default chatSdkConnector({ userName: "support", adapter: { name: "slack", create: () => ({}) }, state: () => ({}) });`,
    );
    await writeFile(
      join(agent, "connectors", "slack", "tools", "add-reaction.ts"),
      `import { extendTool } from ${JSON.stringify(toolExtensionsPath)};
       import addReaction from "../../../tools/add-reaction";
       export default extendTool(addReaction, { execute: async () => ({ ok: true, connector: "slack" }) });`,
    );
    await writeFile(
      join(agent, "connectors", "slack", "tools", "ignored.test.ts"),
      `throw new Error("test files should be ignored");`,
    );

    const baseTools: ToolSet = {
      "add-reaction": await importDefault<ToolSet[string]>(join(agent, "tools", "add-reaction.ts")),
    };

    const tools = await loadConnectorToolExtensions(agent, "slack", baseTools);

    expect(Object.keys(tools)).toEqual(["add-reaction"]);
    await expect((tools["add-reaction"] as { execute: () => Promise<unknown> }).execute()).resolves.toEqual({
      ok: true,
      connector: "slack",
    });
  });

  it("loads connector tools for a flat-file connector with a sibling tools dir", async () => {
    const agent = await tmpAgent();
    // A flat `connectors/slack.ts` descriptor with a sibling `connectors/slack/tools/` dir — the
    // tools must still load even though the descriptor is not a nested `connector.*` module.
    await mkdir(join(agent, "connectors", "slack", "tools"), { recursive: true });
    await writeFile(
      join(agent, "connectors", "slack.ts"),
      `import { chatSdkConnector } from ${JSON.stringify(descriptorPath)};
       export default chatSdkConnector({ userName: "support", adapter: { name: "slack", create: () => ({}) }, state: () => ({}) });`,
    );
    await writeFile(
      join(agent, "connectors", "slack", "tools", "post-to-channel.ts"),
      `export default { description: "Post to a Slack channel.", execute: async () => ({ posted: true }) };`,
    );

    const tools = await loadConnectorToolExtensions(agent, "slack", {});

    expect(Object.keys(tools)).toEqual(["post-to-channel"]);
    await expect((tools["post-to-channel"] as { execute: () => Promise<unknown> }).execute()).resolves.toEqual({
      posted: true,
    });
  });

  it("rejects a connector tool whose filename claims a reserved runtime tool name", async () => {
    const agent = await tmpAgent();
    await mkdir(join(agent, "connectors", "slack", "tools"), { recursive: true });
    await writeFile(
      join(agent, "connectors", "slack", "connector.ts"),
      `import { chatSdkConnector } from ${JSON.stringify(descriptorPath)};
       export default chatSdkConnector({ userName: "support", adapter: { name: "slack", create: () => ({}) }, state: () => ({}) });`,
    );
    // `bash` is overlaid by the runtime at turn assembly, so a discovered `tools/bash.ts` would be
    // silently overwritten — discovery must reject it fast, symmetric with the agent-tools guard.
    await writeFile(
      join(agent, "connectors", "slack", "tools", "bash.ts"),
      `export default { description: "not really bash", execute: async () => ({}) };`,
    );

    await expect(loadConnectorToolExtensions(agent, "slack", {})).rejects.toThrow(HarnessInputError);
    await expect(loadConnectorToolExtensions(agent, "slack", {})).rejects.toThrow(/reserved or invalid/u);
  });

  it("loads a plain executable connector-only tool without extendTool", async () => {
    const agent = await tmpAgent();
    await mkdir(join(agent, "connectors", "slack", "tools"), { recursive: true });
    await writeFile(
      join(agent, "connectors", "slack", "connector.ts"),
      `import { chatSdkConnector } from ${JSON.stringify(descriptorPath)};
       export default chatSdkConnector({ userName: "support", adapter: { name: "slack", create: () => ({}) }, state: () => ({}) });`,
    );
    // A connector-only tool defined as a plain tool with execute — no shared base, no extendTool.
    await writeFile(
      join(agent, "connectors", "slack", "tools", "post-to-channel.ts"),
      `export default { description: "Post to a Slack channel.", execute: async () => ({ posted: true }) };`,
    );

    const tools = await loadConnectorToolExtensions(agent, "slack", {});

    expect(Object.keys(tools)).toEqual(["post-to-channel"]);
    await expect((tools["post-to-channel"] as { execute: () => Promise<unknown> }).execute()).resolves.toEqual({
      posted: true,
    });
  });

  it("rejects a plain connector tool when a shared base tool of the same name exists", async () => {
    const agent = await tmpAgent();
    await mkdir(join(agent, "connectors", "slack", "tools"), { recursive: true });
    await writeFile(
      join(agent, "connectors", "slack", "connector.ts"),
      `import { chatSdkConnector } from ${JSON.stringify(descriptorPath)};
       export default chatSdkConnector({ userName: "support", adapter: { name: "slack", create: () => ({}) }, state: () => ({}) });`,
    );
    // A plain tool (no extendTool) collides with a shared base of the same name — the
    // author should extendTool the base, so discovery must reject this.
    await writeFile(
      join(agent, "connectors", "slack", "tools", "react.ts"),
      `export default { description: "React on Slack.", execute: async () => ({ ok: true }) };`,
    );

    const baseTools: ToolSet = { react: { description: "React to the current message." } as ToolSet[string] };

    await expect(loadConnectorToolExtensions(agent, "slack", baseTools)).rejects.toThrow(
      /default-export extendTool/u,
    );
  });

  it("rejects connector tool extension discovery for missing connectors", async () => {
    const agent = await tmpAgent();

    await expect(loadConnectorToolExtensions(agent, "slack", {})).rejects.toThrow(HarnessInputError);
    await expect(loadConnectorToolExtensions(agent, "slack", {})).rejects.toThrow(/Connector not found/u);
  });
});
