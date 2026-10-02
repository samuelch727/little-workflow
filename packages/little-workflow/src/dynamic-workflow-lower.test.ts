import { describe, expect, it } from "vitest";
import { parseAdHocPlan } from "./dynamic-workflow-plan.js";
import { lowerAdHocPlan, referencedCapabilities, subsetCheck } from "./dynamic-workflow-lower.js";

function lower(planInput: unknown, referenced = { tools: ["docs.search"], models: ["default"], bash: false }) {
  const parsed = parseAdHocPlan(planInput);
  if (!parsed.ok) throw new Error(parsed.message);
  return lowerAdHocPlan(parsed.plan, { outputSchema: true, referenced, name: "adhoc" });
}

describe("lowerAdHocPlan", () => {
  const planInput = {
    steps: [
      { id: "fetch", uses: "tool.call", tool: "docs.search", with: { q: "{{ input.query }}" } },
      { id: "sum", uses: "ai.generate", model: "default", needs: ["fetch"],
        prompt: "Summarize: {{ steps.fetch.output }}", output: { mode: "text" } },
    ],
    output: { from: "sum" },
  };

  it("produces a frozen WorkflowVersion whose hash is deterministic", () => {
    const a = lower(planInput);
    const b = lower(planInput);
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(a.version.hash).toBe(b.version.hash);
  });

  it("maps tool.call to with:{tool,args} and sets permissions.tools", () => {
    const result = lower(planInput);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const fetch = result.lwir.steps.find((s) => s.id === "fetch")!;
      expect(fetch.uses).toBe("tool.call");
      expect(fetch.with).toEqual({ tool: "docs.search", args: { q: "{{ input.query }}" } });
      expect(result.lwir.permissions?.tools).toEqual(["docs.search"]);
      expect(result.lwir.permissions?.models).toEqual(["default"]);
    }
  });

  it("maps ai.generate to input:<prompt> + with:{model}", () => {
    const result = lower(planInput);
    if (result.ok) {
      const sum = result.lwir.steps.find((s) => s.id === "sum")!;
      expect(sum.uses).toBe("ai.generate");
      expect(sum.input).toBe("Summarize: {{ steps.fetch.output }}");
      expect(sum.with).toEqual({ model: "default" });
    }
  });

  it("rejects a plan whose lowered LWIR fails validateLwir", () => {
    // ai.generate referencing a model not in referenced.models -> validateLwir model.disallowed
    const bad = {
      steps: [{ id: "g", uses: "ai.generate", model: "other", prompt: "hi", output: { mode: "text" } }],
      output: { from: "g" },
    };
    const result = lower(bad, { tools: [], models: ["default"], bash: false });
    expect(result.ok).toBe(false);
  });
});

describe("referencedCapabilities", () => {
  it("collects tool names, model slots, and bash usage", () => {
    const parsed = parseAdHocPlan({
      steps: [
        { id: "f", uses: "tool.call", tool: "docs.search", with: {} },
        { id: "g", uses: "ai.generate", model: "default", bash: true, prompt: "hi", output: { mode: "text" } },
      ],
      output: { from: "g" },
    });
    if (!parsed.ok) throw new Error(parsed.message);
    expect(referencedCapabilities(parsed.plan)).toEqual({ tools: ["docs.search"], models: ["default"], bash: true });
  });

  it("sorts and de-dupes referenced tool names (out-of-order + duplicate)", () => {
    const parsed = parseAdHocPlan({
      steps: [
        { id: "s1", uses: "tool.call", tool: "b.x", with: {} },
        { id: "s2", uses: "tool.call", tool: "a.y", with: {} },
        { id: "s3", uses: "tool.call", tool: "b.x", with: {} },
      ],
      output: { from: "s3" },
    });
    if (!parsed.ok) throw new Error(parsed.message);
    expect(referencedCapabilities(parsed.plan).tools).toEqual(["a.y", "b.x"]);
  });
});

describe("subsetCheck", () => {
  it("passes when referenced ⊆ allowed", () => {
    expect(subsetCheck({ tools: ["a"], models: ["default"], bash: false },
      { tools: ["a", "b"], models: ["default"], bash: true }).ok).toBe(true);
  });
  it("fails on an out-of-snapshot tool", () => {
    const r = subsetCheck({ tools: ["x"], models: ["default"], bash: false },
      { tools: ["a"], models: ["default"], bash: true });
    expect(r.ok).toBe(false);
  });
  it("fails when bash is used but not allowed", () => {
    const r = subsetCheck({ tools: [], models: ["default"], bash: true },
      { tools: [], models: ["default"], bash: false });
    expect(r.ok).toBe(false);
  });
  it("fails on a model slot outside the snapshot", () => {
    const r = subsetCheck({ tools: [], models: ["x"], bash: false },
      { tools: [], models: ["default"], bash: true });
    expect(r.ok).toBe(false);
  });
});
