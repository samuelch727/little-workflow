import { asSchema, jsonSchema, tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import {
  assertSnapshotRegistry,
  createHarnessSnapshotRegistry,
  type SnapshotDigest,
  type SnapshotEvent,
} from "./execution-snapshot.js";
import { digest, harnessOwner, runHarnessConformance } from "./harness-contract-v1/harness.js";
import { readFile } from "node:fs/promises";

const hash = (letter = "a"): SnapshotDigest => `sha256:${letter.repeat(64)}`;
const model = () => new MockLanguageModelV3({ provider: "snapshot-test", modelId: "fixed" });
async function fixture() {
  const calls: unknown[] = [];
  const events: SnapshotEvent[] = [];
  let revoked = false;
  const read = tool({
    description: "Read an order",
    inputSchema: z.object({ orderId: z.string().min(1) }).strict(),
    execute: async (input) => {
      calls.push(input);
      return { status: "delivered" };
    },
  });
  const tools = { read_order: read };
  const registry = await createHarnessSnapshotRegistry({
    runtime: hash(),
    tools: {
      read_order: {
        tool: read,
        implementationHash: hash("b"),
        effect: "read",
        parameterDescriptionPaths: ["/properties/orderId"],
      },
    },
    hooks: {
      turnLimits: {
        bounded: {
          implementationHash: hash("c"),
          parameters: { maxSteps: { type: "integer", minimum: 1, maximum: 20 } },
          defaults: { maxSteps: 10 },
          order: 0,
          staticHints: "Preserve owner rules.",
          handler: (parameters) => ({ maxSteps: parameters.maxSteps }),
        },
      },
    },
    envelope: {
      allowedTools: ["read_order"],
      requiredTools: ["read_order"],
      defaultTools: ["read_order"],
      allowedHooks: { turnLimits: ["bounded"] },
      requiredHooks: ["turnLimits"],
      defaultHooks: { turnLimits: { profile: "bounded" } },
      ownerRules: "Refunds require authorization.",
    },
    assertCurrent: () => {
      if (revoked) throw new Error("revoked");
    },
  });
  const content = registry.admit({
    harnessFormat: 1,
    system: "Help with returns.",
    files: {
      "skills/returns/SKILL.md":
        "---\nname: returns\ndescription: Return rules\n---\nRead [shared](../../references/rules.md).\n",
      "references/rules.md": "Use the delivery date.退款",
    },
    tools: {
      read_order: {
        description: "Read the identified order",
        parameterDescriptions: { "/properties/orderId": "ID given by the user" },
      },
    },
    hooks: { turnLimits: { profile: "bounded", parameters: { maxSteps: 3 } } },
  }).content;
  const selectedModel = model();
  const snapshot = await registry.snapshot(content, {
    model: selectedModel,
    toolState: digest({ orders: [] }),
    memorySnapshot: digest(null),
  });
  return {
    registry,
    content,
    snapshot,
    selectedModel,
    tools,
    read,
    calls,
    events,
    emit: async (event: SnapshotEvent) => {
      events.push(event);
    },
    revoke: () => {
      revoked = true;
    },
  };
}
describe("owner-installed execution registry", () => {
  it("derives descriptor and hashes from actual canonical schemas", async () => {
    const f = await fixture();
    expect(() => assertSnapshotRegistry(f.registry)).not.toThrow();
    expect(() => assertSnapshotRegistry(JSON.parse(JSON.stringify(f.registry)))).toThrow();
    expect(harnessOwner(f.registry.descriptor, f.registry.envelope).registryHash).toBe(
      f.registry.registryHash,
    );
    expect(f.content.tools.load_skill?.enabled).toBe(true);
    const verified = await f.registry.verify(f.snapshot, f.selectedModel);
    expect(verified.contentHash).toBe(digest(f.content));
    expect(verified.snapshot.executionHash).toBe(f.snapshot.executionHash);
  });
  it("rejects missing validators and schema-shaped validator substitutes", async () => {
    for (const inputSchema of [
      jsonSchema({ type: "object", properties: {} }),
      { type: "object", properties: {} },
    ]) {
      await expect(
        createHarnessSnapshotRegistry({
          runtime: hash(),
          tools: {
            fake: {
              tool: { inputSchema, execute: async () => "never" } as any,
              implementationHash: hash(),
              effect: "write",
            },
          },
          envelope: { allowedTools: ["fake"], requiredTools: [], defaultTools: ["fake"] },
        }),
      ).rejects.toThrow();
    }
  });
  it("rejects model-owned stamps and mandatory loader/tool removal", async () => {
    const f = await fixture();
    for (const tools of [
      { read_order: { implementationHash: hash() } },
      { load_skill: { enabled: false } },
      { read_order: { enabled: false } },
      { unknown: {} },
    ])
      expect(() => f.registry.admit({ harnessFormat: 1, files: {}, tools })).toThrow();
    expect(f.calls).toEqual([]);
  });
  it("detects changed implementation references and mutated canonical schemas", async () => {
    const f = await fixture();
    const old = f.read.execute;
    f.read.execute = async () => ({ status: "changed" });
    await expect(f.registry.assertTools(f.tools)).rejects.toThrow(/changed/);
    f.read.execute = old;
    await f.registry.assertTools(f.tools);
    const replacement = { ...f.read, inputSchema: z.object({ orderId: z.number() }) };
    await expect(f.registry.assertTools({ read_order: replacement })).rejects.toThrow(/changed/);
  });
});
describe("immutable snapshot data and loader", () => {
  it("keeps canonical validators while changing only displayed metadata", async () => {
    const f = await fixture();
    const before = await asSchema(f.read.inputSchema).jsonSchema;
    const tools = await f.registry.tools(f.snapshot, f.emit, f.tools);
    expect(await asSchema(f.read.inputSchema).jsonSchema).toEqual(before);
    expect(await asSchema(tools.read_order!.inputSchema).jsonSchema).toMatchObject({
      properties: { orderId: { type: "string", description: "ID given by the user" } },
    });
    const parsed = await asSchema(tools.read_order!.inputSchema).validate!({ orderId: 4 });
    expect(parsed.success).toBe(false);
    expect(f.calls).toEqual([]);
    expect(tools.read_order!.description).toBe("Read the identified order");
  });
  it("opens root references from exact pinned bytes with complete, hash-bound events", async () => {
    const f = await fixture();
    const tools = await f.registry.tools(f.snapshot, f.emit, f.tools);
    const result = await tools.load_skill!.execute!(
      { name: "returns", file: "../../references/rules.md" },
      { toolCallId: "open", messages: [], context: {} },
    );
    expect(result).toMatchObject({
      file: "references/rules.md",
      content: "Use the delivery date.退款",
    });
    expect(f.events).toContainEqual(
      expect.objectContaining({
        type: "harness.snapshot.file_opened",
        metadata: expect.objectContaining({
          executionHash: f.snapshot.executionHash,
          path: "references/rules.md",
          complete: true,
          entry: false,
        }),
      }),
    );
    await expect(
      tools.load_skill!.execute!(
        { name: "returns", file: "../../../../etc/passwd" },
        { toolCallId: "escape", messages: [], context: {} },
      ),
    ).rejects.toThrow();
    expect(Object.isFrozen(f.snapshot.content.files)).toBe(true);
    expect(f.registry.skills(f.snapshot)[0]?.harnessDir).toContain(
      f.snapshot.executionHash.slice(7),
    );
  });
  it("refuses source/model/policy drift and respects a current revocation veto", async () => {
    const f = await fixture();
    await expect(
      f.registry.verify({ ...f.snapshot, executionHash: hash("f") }, f.selectedModel),
    ).rejects.toThrow(/identity/);
    await expect(
      f.registry.verify({ ...f.snapshot, registryHash: hash("f") }, f.selectedModel),
    ).rejects.toThrow(/unavailable/);
    await expect(
      f.registry.verify(f.snapshot, new MockLanguageModelV3({ modelId: "other" })),
    ).rejects.toThrow(/model/);
    f.revoke();
    await expect(f.registry.verify(f.snapshot, f.selectedModel)).rejects.toThrow("revoked");
    expect(f.calls).toEqual([]);
  });
  it("records a hook as applied only after output validation succeeds", async () => {
    const f = await fixture();
    expect(await f.registry.hook(f.snapshot, "turnLimits", {}, f.emit, (value) => value)).toEqual({
      maxSteps: 3,
    });
    await expect(
      f.registry.hook(f.snapshot, "turnLimits", {}, f.emit, () => {
        throw new Error("bound rejected");
      }),
    ).rejects.toThrow("bound rejected");
    expect(
      f.events.filter((e) => e.type === "harness.snapshot.hook").map((e) => e.metadata.outcome),
    ).toEqual(["applied", "denied"]);
  });
  it("checks current permission and canonical inputs before any effect, and fences receipt failure", async () => {
    const f = await fixture();
    const tools = await f.registry.tools(f.snapshot, f.emit, f.tools);
    const options = { toolCallId: "write", messages: [], context: {} };
    await expect(tools.read_order!.execute!({ orderId: 4 }, options)).rejects.toThrow();
    expect(f.calls).toEqual([]);
    f.revoke();
    await expect(tools.read_order!.execute!({ orderId: "valid" }, options)).rejects.toThrow(
      "revoked",
    );
    expect(f.calls).toEqual([]);
    expect(
      f.events.some(
        (e) => e.type === "harness.snapshot.tool_effect" && e.metadata.outcome === "completed",
      ),
    ).toBe(false);
    const g = await fixture();
    const fenced = await g.registry.tools(
      g.snapshot,
      async () => {
        throw new Error("receipt unavailable");
      },
      g.tools,
    );
    await expect(fenced.read_order!.execute!({ orderId: "valid" }, options)).rejects.toThrow(
      "receipt unavailable",
    );
    expect(g.calls).toEqual([]);
  });
  it("preserves real approval policy and rejects changed approval/render callbacks", async () => {
    const modelInstance = model();
    const original = tool({
      inputSchema: z.object({ id: z.string() }),
      needsApproval: true,
      execute: async () => ({ ok: true }),
    });
    const registry = await createHarnessSnapshotRegistry({
      runtime: hash(),
      tools: { write: { tool: original, implementationHash: hash(), effect: "write" } },
      envelope: { allowedTools: ["write"], requiredTools: ["write"], defaultTools: ["write"] },
    });
    const admitted = registry.admit({ harnessFormat: 1, files: {} }).content;
    const snapshot = await registry.snapshot(admitted, {
      model: modelInstance,
      toolState: digest(null),
      memorySnapshot: digest(null),
    });
    const tools = await registry.tools(snapshot, async () => {}, { write: original });
    expect(tools.write!.needsApproval).toBe(true);
    original.needsApproval = false;
    await expect(registry.assertTools({ write: original })).rejects.toThrow(/changed/);
  });
  it("binds installed ceilings into identity and requires custom accounting provenance", async () => {
    const options = {
      runtime: hash(),
      tools: {},
      envelope: { allowedTools: [], requiredTools: [], defaultTools: [] },
    };
    const a = await createHarnessSnapshotRegistry({ ...options, turnLimits: { maxSteps: 2 } });
    const b = await createHarnessSnapshotRegistry({ ...options, turnLimits: { maxSteps: 3 } });
    expect(a.fixedPins.runtime).not.toBe(b.fixedPins.runtime);
    await expect(
      createHarnessSnapshotRegistry({ ...options, turnLimits: { price: () => 0 } }),
    ).rejects.toThrow(/accounting digest/);
    expect(Object.isFrozen(a.requiredTools)).toBe(true);
  });
  it("preserves transformed inputs and validates outputs exactly once through the SDK seam", async () => {
    let inputs = 0;
    let outputs = 0;
    const actual = tool({
      inputSchema: z.object({
        word: z.string().transform((word) => {
          inputs++;
          return word.trim();
        }),
      }),
      outputSchema: jsonSchema<{ word: string }>(
        { type: "object", properties: { word: { type: "string" } }, required: ["word"] },
        {
          validate: (value) => {
            outputs++;
            return outputs === 1
              ? { success: true, value: value as { word: string } }
              : { success: false, error: new Error("parsed twice") };
          },
        },
      ),
      execute: async (input) => ({ word: input.word }),
    });
    const registry = await createHarnessSnapshotRegistry({
      runtime: hash(),
      tools: { echo: { tool: actual, implementationHash: hash(), effect: "read" } },
      envelope: { allowedTools: ["echo"], requiredTools: [], defaultTools: ["echo"] },
    });
    const snapshot = await registry.snapshot(
      registry.admit({ harnessFormat: 1, files: {} }).content,
      { model: model(), toolState: digest(null), memorySnapshot: digest(null) },
    );
    const events: SnapshotEvent[] = [];
    const tools = await registry.tools(
      snapshot,
      async (event) => {
        events.push(event);
      },
      { echo: actual },
    );
    const checked = await asSchema(tools.echo!.inputSchema).validate!({ word: " padded " });
    if (!checked.success) throw checked.error;
    const output = await tools.echo!.execute!(checked.value, {
      toolCallId: "echo",
      messages: [],
      context: {},
    });
    expect(await asSchema(tools.echo!.outputSchema).validate!(output)).toEqual({
      success: true,
      value: { word: "padded" },
    });
    expect(inputs).toBe(1);
    expect(outputs).toBe(1);
    expect(
      events.filter(
        (event) =>
          event.type === "harness.snapshot.tool_effect" && event.metadata.outcome === "completed",
      ),
    ).toHaveLength(1);
  });
  it("refuses provider-executed tools before any model can receive them", async () => {
    await expect(
      createHarnessSnapshotRegistry({
        runtime: hash(),
        tools: {
          remote: {
            tool: { type: "provider", inputSchema: z.object({}), execute: async () => ({}) } as any,
            implementationHash: hash(),
            effect: "write",
          },
        },
        envelope: { allowedTools: ["remote"], requiredTools: [], defaultTools: ["remote"] },
      }),
    ).rejects.toThrow(/Provider-executed/);
  });
  it("uses exactly the same pinned conformance vectors in Harness and the client", async () => {
    const vectors = JSON.parse(
      await readFile(
        new URL("./harness-contract-v1/contract-vectors.json", import.meta.url),
        "utf8",
      ),
    );
    expect(runHarnessConformance(vectors)).toEqual({ passed: 21, failures: [] });
  });
});
