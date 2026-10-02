import { expect, it } from "vitest";
import { validateLwir } from "./lwir.js";

const objSchema = { type: "object" as const };

function baseLwir(steps: unknown[]) {
  return {
    apiVersion: "littleworkflow.dev/v0.1",
    kind: "Workflow",
    metadata: { name: "structural.test", version: "0.1.0-alpha" },
    input: { schema: objSchema },
    output: { schema: objSchema },
    permissions: { models: ["m"], tools: [], secrets: [], network: [] },
    steps,
  };
}

// These plans are structurally valid to validateLwir today but CRASH at runtime
// ("Step 'decide' output does not match object output mode", "Ambiguous terminal steps").
// Catching them as findings lets the planner's repair loop fix them instead of crashing.

it("rejects a decision step that declares an output contract (its result is always { chosen })", () => {
  const result = validateLwir(
    baseLwir([
      { id: "gen", uses: "ai.generate", input: "{{ input }}", with: { model: "m" }, output: { mode: "object", schema: objSchema } },
      { id: "route", uses: "decision", needs: ["gen"], with: { cases: [{ when: "1 == 1", to: "end" }], default: "end" }, output: { mode: "object", schema: objSchema } },
    ]),
  );
  expect(result.findings.some((f) => f.code === "decision.output_not_allowed")).toBe(true);
});

it("flags a plan with more than one terminal step as ambiguous", () => {
  const result = validateLwir(
    baseLwir([
      { id: "a", uses: "ai.generate", input: "{{ input }}", with: { model: "m" }, output: { mode: "object", schema: objSchema } },
      { id: "b", uses: "ai.generate", input: "{{ input }}", with: { model: "m" }, output: { mode: "object", schema: objSchema } },
    ]),
  );
  expect(result.findings.some((f) => f.code === "terminal.ambiguous")).toBe(true);
});

it("does not flag a valid single-terminal, no-decision-output plan", () => {
  const result = validateLwir(
    baseLwir([
      { id: "look", uses: "ai.generate", input: "{{ input }}", with: { model: "m" }, output: { mode: "json", schema: true } },
      { id: "gen", uses: "ai.generate", needs: ["look"], input: "{{ input }}", with: { model: "m" }, output: { mode: "object", schema: objSchema } },
    ]),
  );
  expect(result.findings.some((f) => f.code === "terminal.ambiguous")).toBe(false);
  expect(result.findings.some((f) => f.code === "decision.output_not_allowed")).toBe(false);
});

it("accepts a well-formed onFailure.repair config on an ai.generate step", () => {
  const result = validateLwir(
    baseLwir([
      {
        id: "gen",
        uses: "ai.generate",
        input: "{{ input }}",
        with: { model: "m" },
        output: { mode: "object", schema: objSchema },
        onFailure: { repair: { mode: "self", maxAttempts: 3 } },
      },
    ]),
  );
  expect(result.findings.some((f) => f.code.startsWith("repair."))).toBe(false);
});

it("rejects a repair config with a bad mode or maxAttempts", () => {
  const result = validateLwir(
    baseLwir([
      {
        id: "gen",
        uses: "ai.generate",
        input: "{{ input }}",
        with: { model: "m" },
        output: { mode: "object", schema: objSchema },
        onFailure: { repair: { mode: "nope", maxAttempts: 0 } },
      },
    ]),
  );
  expect(result.findings.some((f) => f.code === "repair.invalid_mode")).toBe(true);
  expect(result.findings.some((f) => f.code === "repair.invalid_max_attempts")).toBe(true);
});
