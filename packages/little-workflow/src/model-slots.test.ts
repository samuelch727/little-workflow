import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getModelInfoFor } from "./model-registry.js";
import { model, resolveModelSlots } from "./model-slots.js";

const testDir = dirname(fileURLToPath(import.meta.url));

function ai(provider: string, modelId: string) {
  return { provider, modelId };
}

describe("model slot resolution", () => {
  it("derives the first slot id from the model name", () => {
    const [slot] = resolveModelSlots([model(ai("openai", "gpt-4o-mini"))]);

    expect(slot?.slotId).toBe("gpt-4o-mini");
  });

  it("adds deterministic suffixes for duplicate provider model ids", () => {
    const [first, second] = resolveModelSlots([
      model(ai("openai", "gpt-4o-mini")),
      model(ai("openai", "gpt-4o-mini")),
    ]);

    expect(first?.slotId).toBe("gpt-4o-mini");
    expect(second?.slotId).toMatch(/^gpt-4o-mini-[a-z]+$/u);
    expect(second?.slotId).not.toBe(first?.slotId);
  });

  it("disambiguates cross-provider model id collisions with a deterministic animal suffix", () => {
    const [openaiSlot, azureSlot] = resolveModelSlots([
      model(ai("openai", "gpt-4o")),
      model(ai("azure", "gpt-4o")),
    ]);

    expect(openaiSlot?.slotId).toBe("gpt-4o");
    expect(azureSlot?.slotId).toBe("gpt-4o-hare");
  });

  it("lets explicit ids win over earlier implicit derived ids", () => {
    const [implicit, explicit] = resolveModelSlots([
      model(ai("openai", "gpt-4o-mini")),
      model(ai("other", "some-model"), { id: "gpt-4o-mini" }),
    ]);

    expect(explicit?.slotId).toBe("gpt-4o-mini");
    expect(implicit?.slotId).toMatch(/^gpt-4o-mini-[a-z]+$/u);
    expect(implicit?.slotId).not.toBe(explicit?.slotId);
  });

  it("rejects duplicate explicit slot ids", () => {
    expect(() =>
      resolveModelSlots([
        model(ai("openai", "gpt-4o-mini"), { id: "fast" }),
        model(ai("openai", "gpt-4o"), { id: "fast" }),
      ]),
    ).toThrow(/already in use/u);
  });

  it("fills known model descriptions from the registry", () => {
    const [slot] = resolveModelSlots([model(ai("openai", "gpt-4o-mini"))]);

    expect(slot?.metadata.description).toContain("Fast");
  });

  it("strips non-ASCII characters from derived slot ids", () => {
    const [nonAsciiOnly, mixed, nonAsciiCasing] = resolveModelSlots([
      model(ai("test", "Ä")),
      model(ai("test", "GPT_Ä")),
      model(ai("test", "İ")),
    ]);

    expect(nonAsciiOnly?.slotId).toBe("model-0");
    expect(mixed?.slotId).toBe("gpt");
    expect(mixed?.slotId).not.toContain("ä");
    expect(mixed?.slotId).toMatch(/^[a-z0-9-]+$/u);
    expect(nonAsciiCasing?.slotId).toBe("model-2");
  });

  it("reads model info from the JSON registry source", () => {
    const source = readFileSync(join(testDir, "model-registry.ts"), "utf8");
    const registry = JSON.parse(
      readFileSync(join(testDir, "model-registry.json"), "utf8"),
    ) as Record<string, { description?: string }>;

    expect(source).not.toMatch(/"openai\/gpt-4o-mini":\s*\{/u);
    expect(getModelInfoFor("openai", "gpt-4o-mini")?.description).toBe(
      registry["openai/gpt-4o-mini"]?.description,
    );
    expect(getModelInfoFor("openai", "gpt-4o-mini")?.description).toContain("Fast");
  });
});
