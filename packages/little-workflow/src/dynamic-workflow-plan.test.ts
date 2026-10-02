import { describe, expect, it } from "vitest";
import { parseAdHocPlan } from "./dynamic-workflow-plan.js";

describe("parseAdHocPlan", () => {
  it("accepts a minimal tool.call + ai.generate DAG", () => {
    const result = parseAdHocPlan({
      steps: [
        { id: "fetch", uses: "tool.call", tool: "docs.search", with: { q: "{{ input.query }}" } },
        { id: "sum", uses: "ai.generate", model: "default", needs: ["fetch"],
          prompt: "Summarize: {{ steps.fetch.output }}", output: { mode: "text" } },
      ],
      output: { from: "sum" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.steps).toHaveLength(2);
      expect(result.plan.output.from).toBe("sum");
    }
  });

  it("rejects a non-object plan", () => {
    expect(parseAdHocPlan(null).ok).toBe(false);
    expect(parseAdHocPlan({ steps: "no" }).ok).toBe(false);
  });

  it("rejects duplicate step ids", () => {
    const result = parseAdHocPlan({
      steps: [
        { id: "a", uses: "tool.call", tool: "t", with: {} },
        { id: "a", uses: "tool.call", tool: "t", with: {} },
      ],
      output: { from: "a" },
    });
    expect(result.ok).toBe(false);
  });

  it("rejects output.from referencing an unknown step", () => {
    const result = parseAdHocPlan({
      steps: [{ id: "a", uses: "tool.call", tool: "t", with: {} }],
      output: { from: "z" },
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a non-executable step kind (parallel/code.run/decision) in v1", () => {
    const parallel = parseAdHocPlan({
      steps: [{ id: "p", uses: "parallel", with: { steps: [] } }],
      output: { from: "p" },
    });
    expect(parallel.ok).toBe(false);
    if (!parallel.ok) {
      expect(parallel.message).toContain("step 'p' uses 'parallel'");
    }
    expect(parseAdHocPlan({
      steps: [{ id: "c", uses: "code.run", with: { source: "x" } }],
      output: { from: "c" },
    }).ok).toBe(false);
  });

  it("rejects output.from that does not name the terminal step", () => {
    // fetch is the terminal step (no other step needs it is false — sum needs fetch),
    // so sum is terminal; pointing output.from at the non-terminal fetch is rejected.
    const result = parseAdHocPlan({
      steps: [
        { id: "fetch", uses: "tool.call", tool: "t", with: {} },
        { id: "sum", uses: "ai.generate", model: "default", needs: ["fetch"], prompt: "hi", output: { mode: "text" } },
      ],
      output: { from: "fetch" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("terminal is 'sum'");
    }
  });
});
