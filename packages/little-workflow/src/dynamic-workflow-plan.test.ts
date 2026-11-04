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

  it("rejects fields a step type does not take, naming the right ones", () => {
    // A tool step's arguments under `input` would be ignored, so the tool would get none.
    const toolStep = parseAdHocPlan({
      steps: [{ id: "credit", uses: "tool.call", tool: "fetch_credit_report", input: { applicationId: "{{ input.id }}" } }],
      output: { from: "credit" },
    });
    expect(toolStep).toEqual({
      ok: false,
      message:
        "Step 'credit' has a field a tool.call step does not take: 'input'. A tool.call step takes `tool` and the tool's arguments in `with`.",
    });
    // A model step's prompt under `with` would be ignored, so the model would get an empty prompt.
    const modelStep = parseAdHocPlan({
      steps: [{ id: "decide", uses: "ai.generate", model: "default", with: { prompt: "Decide." } }],
      output: { from: "decide" },
    });
    expect(modelStep.ok).toBe(false);
    expect(!modelStep.ok && modelStep.message).toBe(
      "Step 'decide' has a field an ai.generate step does not take: 'with'. An ai.generate step takes `model` and its whole instruction in `prompt`.",
    );
  });

  it("names the step types when uses is missing", () => {
    const result = parseAdHocPlan({
      steps: [{ id: "credit", kind: "tool.call", tool: "fetch_credit_report", with: {} }],
      output: { from: "credit" },
    });
    expect(!result.ok && result.message).toBe(
      'Invalid step uses: undefined. Step \'credit\' needs `uses`: "tool.call" or "ai.generate".',
    );
  });

  it("rejects an ai.generate step with no prompt", () => {
    const result = parseAdHocPlan({
      steps: [{ id: "decide", uses: "ai.generate", model: "default", prompt: "  " }],
      output: { from: "decide" },
    });
    expect(!result.ok && result.message).toMatch(/^Step 'decide' has no prompt\./u);
  });

  it("rejects $input-style references, which would reach the tool or model as literal text", () => {
    const inArgs = parseAdHocPlan({
      steps: [{ id: "credit", uses: "tool.call", tool: "fetch_credit_report", with: { applicationId: "$input.applicationId" } }],
      output: { from: "credit" },
    });
    expect(!inArgs.ok && inArgs.message).toBe(
      "Step 'credit' refers to data as '$input...'. Write {{ input.<field> }} or {{ steps.<id>.output }} (or {{ steps.<id>.output.<field> }}).",
    );
    const inPrompt = parseAdHocPlan({
      steps: [{ id: "decide", uses: "ai.generate", model: "default", prompt: "Decide using $.steps.credit.output" }],
      output: { from: "decide" },
    });
    expect(!inPrompt.ok && inPrompt.message).toMatch(/refers to data as '\$\.steps\.\.\.'/u);
    // A dollar sign that is not a reference is fine.
    expect(
      parseAdHocPlan({
        steps: [{ id: "decide", uses: "ai.generate", model: "default", prompt: "Amounts are in $, e.g. $250,000. {{ input.x }}" }],
        output: { from: "decide" },
      }).ok,
    ).toBe(true);
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
