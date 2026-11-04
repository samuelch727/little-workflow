import { describe, expect, it } from "vitest";
import {
  resolveExpressionText,
  resolveExpressionValue,
  type ExpressionContext,
} from "./expressions.js";

function makeContext(
  stepsOverride: ExpressionContext["steps"] = {},
): ExpressionContext {
  return {
    input: { ticketId: "t1" },
    steps: stepsOverride,
  };
}

describe("expression resolution — steps.X.lastOutput", () => {
  it("resolves steps.X.lastOutput to the most recent visit when visits array is present", () => {
    const ctx = makeContext({
      worker: {
        output: { v: 3 },
        visits: [{ v: 1 }, { v: 2 }, { v: 3 }],
      },
    });

    expect(resolveExpressionValue("{{ steps.worker.lastOutput.v }}", ctx)).toBe(3);
  });

  it("resolves steps.X.lastOutput to the output field when no visits array is present", () => {
    const ctx = makeContext({
      worker: { output: { v: 42 } },
    });

    expect(resolveExpressionValue("{{ steps.worker.lastOutput.v }}", ctx)).toBe(42);
  });

  it("resolves steps.X.lastOutput to undefined when visits array is empty and no output", () => {
    const ctx = makeContext({
      worker: { visits: [] },
    });

    // Accessing a property on undefined throws an error about unresolvable path
    expect(() =>
      resolveExpressionValue("{{ steps.worker.lastOutput.v }}", ctx),
    ).toThrow();
  });

  it("resolves steps.X.lastOutput for a single-visit step (equivalent to output)", () => {
    const ctx = makeContext({
      "lookup-customer": { output: { plan: "enterprise" }, visits: [{ plan: "enterprise" }] },
    });

    expect(
      resolveExpressionValue("{{ steps.lookup-customer.lastOutput.plan }}", ctx),
    ).toBe("enterprise");
  });

  it("resolves steps.X.lastOutput as a whole object", () => {
    const ctx = makeContext({
      worker: {
        output: { v: 2 },
        visits: [{ v: 1 }, { v: 2 }],
      },
    });

    expect(resolveExpressionValue("{{ steps.worker.lastOutput }}", ctx)).toEqual({ v: 2 });
  });
});

describe("expression resolution — steps.X.allVisits", () => {
  it("resolves steps.X.allVisits as an ordered array of outputs from visits array", () => {
    const ctx = makeContext({
      worker: {
        output: { v: 3 },
        visits: [{ v: 1 }, { v: 2 }, { v: 3 }],
      },
    });

    expect(resolveExpressionValue("{{ steps.worker.allVisits }}", ctx)).toEqual([
      { v: 1 },
      { v: 2 },
      { v: 3 },
    ]);
  });

  it("resolves steps.X.allVisits as a single-element array when no visits array is present", () => {
    const ctx = makeContext({
      worker: { output: { v: 42 } },
    });

    expect(resolveExpressionValue("{{ steps.worker.allVisits }}", ctx)).toEqual([{ v: 42 }]);
  });

  it("resolves steps.X.allVisits as empty array when no visits and no output", () => {
    const ctx = makeContext({
      worker: {},
    });

    expect(resolveExpressionValue("{{ steps.worker.allVisits }}", ctx)).toEqual([]);
  });

  it("resolves steps.X.allVisits index access", () => {
    const ctx = makeContext({
      worker: {
        output: { v: 3 },
        visits: [{ v: 1 }, { v: 2 }, { v: 3 }],
      },
    });

    expect(resolveExpressionValue("{{ steps.worker.allVisits[0].v }}", ctx)).toBe(1);
    expect(resolveExpressionValue("{{ steps.worker.allVisits[2].v }}", ctx)).toBe(3);
  });
});

describe("expression resolution — steps.X.output backward compatibility", () => {
  it("resolves steps.X.output when no visits array is present (single-visit)", () => {
    const ctx = makeContext({
      worker: { output: { v: 42 } },
    });

    expect(resolveExpressionValue("{{ steps.worker.output.v }}", ctx)).toBe(42);
  });

  it("resolves steps.X.output even when visits array is present (runtime doesn't enforce at eval)", () => {
    // The LWIR validator enforces the constraint; at runtime the resolver is permissive.
    const ctx = makeContext({
      worker: {
        output: { v: 3 },
        visits: [{ v: 1 }, { v: 2 }, { v: 3 }],
      },
    });

    // The runtime resolver uses the object shape directly; output is still accessible.
    expect(resolveExpressionValue("{{ steps.worker.output.v }}", ctx)).toBe(3);
  });
});

describe("expression resolution — resolveExpressionText", () => {
  const ctx = makeContext({ credit: { output: { score: 712, flags: ["late"] } } });

  it("fills embedded expressions into the surrounding text", () => {
    expect(resolveExpressionText("Ticket {{ input.ticketId }} scored {{ steps.credit.output.score }}.", ctx))
      .toBe("Ticket t1 scored 712.");
  });

  it("stringifies a template-only value instead of keeping its type", () => {
    expect(resolveExpressionText("{{ steps.credit.output }}", ctx)).toBe('{"score":712,"flags":["late"]}');
    expect(resolveExpressionText("{{ steps.credit.output.score }}", ctx)).toBe("712");
  });

  it("passes plain text through and fails loudly on a path that does not exist", () => {
    expect(resolveExpressionText("No templates here.", ctx)).toBe("No templates here.");
    expect(() => resolveExpressionText("Hi {{ input.missing }}", ctx)).toThrow(/could not be resolved/u);
  });
});

describe("expression resolution — a back-edge step that has not run yet", () => {
  const ctx = makeContext({});

  it("gives no lastOutput, an empty allVisits, and empty text", () => {
    expect(resolveExpressionValue("{{ steps.review.lastOutput }}", ctx)).toBeUndefined();
    expect(resolveExpressionValue("{{ steps.review.lastOutput.note }}", ctx)).toBeUndefined();
    expect(resolveExpressionValue("{{ steps.review.allVisits }}", ctx)).toEqual([]);
    expect(resolveExpressionText("Notes: [{{ steps.review.lastOutput.note }}]", ctx)).toBe("Notes: []");
  });

  it("still fails for output, which needs a completed step", () => {
    expect(() => resolveExpressionValue("{{ steps.review.output }}", ctx)).toThrow(/incomplete step 'review'/u);
  });
});
