import { describe, expect, it } from "vitest";
import { sha256Digest } from "./canonical.js";
import {
  assertWorkflowVersionInputCompatible,
  concreteInputStructure,
  concreteInputStructureHash,
  DEFAULT_WORKFLOW_VERSION_REUSE_POLICY,
  resolveWorkflowVersionReusePolicy,
} from "./workflow-version-reuse.js";

describe("concreteInputStructure", () => {
  it("ignores primitive values but preserves primitive kinds", () => {
    expect(concreteInputStructure({ id: "A", count: 1, ok: true, none: null }))
      .toEqual(concreteInputStructure({ id: "B", count: 99, ok: false, none: null }));
    expect(concreteInputStructure({ id: "A" }))
      .not.toEqual(concreteInputStructure({ id: 1 }));
  });

  it("compares objects by key set and child structures", () => {
    expect(concreteInputStructure({ ticket: { id: "A", body: "x" } }))
      .toEqual(concreteInputStructure({ ticket: { id: "B", body: "y" } }));
    expect(concreteInputStructure({ ticket: { id: "A", body: "x" } }))
      .not.toEqual(concreteInputStructure({ ticket: { id: "A" } }));
  });

  it("adds recursive array length categories", () => {
    expect(concreteInputStructure({ items: [] })).toEqual({
      kind: "object",
      fields: [
        ["items", { kind: "array", length: "empty", elements: [] }],
      ],
    });
    expect(concreteInputStructure({ items: [{ id: "a", tags: ["x"] }] }))
      .toEqual(concreteInputStructure({ items: [{ id: "b", tags: ["y"] }] }));
    expect(concreteInputStructure({ items: [{ id: "a" }] }))
      .not.toEqual(concreteInputStructure({ items: [{ id: "a" }, { id: "b" }] }));
    expect(concreteInputStructure({ groups: [{ items: ["a"] }] }))
      .not.toEqual(concreteInputStructure({ groups: [{ items: ["a", "b"] }] }));
  });

  it("hashes the concrete input structure", () => {
    expect(concreteInputStructureHash({ id: "A", nested: { value: 1 } }))
      .toBe(concreteInputStructureHash({ id: "B", nested: { value: 2 } }));
    expect(concreteInputStructureHash({ id: "A" })).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });
});

describe("internal deterministic WorkflowVersion reuse checks", () => {
  const plannedInput = { ticketId: "TIN-1", body: "Cannot export." };
  const plannedInputHash = sha256Digest(plannedInput);
  const plannedInputStructureHash = concreteInputStructureHash(plannedInput);

  it("defaults to never and resolves call-level before workflow-level", () => {
    expect(DEFAULT_WORKFLOW_VERSION_REUSE_POLICY).toBe("never");
    expect(resolveWorkflowVersionReusePolicy()).toBe("never");
    expect(resolveWorkflowVersionReusePolicy({ workflow: "structure" })).toBe("structure");
    expect(resolveWorkflowVersionReusePolicy({ workflow: "structure", call: "exact" }))
      .toBe("exact");
  });

  it("accepts exact reuse only when input hashes match", () => {
    expect(() =>
      assertWorkflowVersionInputCompatible({
        policy: "exact",
        plannedInputHash,
        plannedInputStructureHash,
        runInput: plannedInput,
      })
    ).not.toThrow();

    expect(() =>
      assertWorkflowVersionInputCompatible({
        policy: "exact",
        plannedInputHash,
        plannedInputStructureHash,
        runInput: { ticketId: "TIN-2", body: "Cannot export." },
      })
    ).toThrow("WorkflowVersion planned input hash does not match run input.");
  });

  it("accepts structure reuse for value-only changes", () => {
    expect(() =>
      assertWorkflowVersionInputCompatible({
        policy: "structure",
        plannedInputHash,
        plannedInputStructureHash,
        runInput: { ticketId: "TIN-2", body: "Cannot import." },
      })
    ).not.toThrow();

    expect(() =>
      assertWorkflowVersionInputCompatible({
        policy: "structure",
        plannedInputHash,
        plannedInputStructureHash,
        runInput: { ticketId: "TIN-2", body: ["Cannot import."] },
      })
    ).toThrow("WorkflowVersion planned input structure does not match run input.");
  });

  it("rejects unknown reuse policies", () => {
    expect(() =>
      assertWorkflowVersionInputCompatible({
        policy: "sometimes" as never,
        plannedInputHash,
        plannedInputStructureHash,
        runInput: plannedInput,
      })
    ).toThrow('Unknown WorkflowVersion reuse policy "sometimes".');
  });

  it("rejects unrelated array length category changes during adaptive structure reuse", () => {
    const adaptivePlannedInput = { candidates: [{ id: "A" }], tags: ["urgent"] };
    expect(() =>
      assertWorkflowVersionInputCompatible({
        policy: "structure",
        plannedInputHash: sha256Digest(adaptivePlannedInput),
        plannedInputStructure: concreteInputStructure(adaptivePlannedInput),
        plannedInputStructureHash: concreteInputStructureHash(adaptivePlannedInput),
        runInput: { candidates: [{ id: "B" }, { id: "C" }], tags: ["urgent", "new"] },
        adaptiveArrayPaths: [{ path: ["candidates"], maxBranches: 100 }],
      })
    ).toThrow("WorkflowVersion planned input structure does not match run input.");
  });

  it("allows adaptive array paths to grow from single to many when element structure matches", () => {
    const plannedWithRootCandidates = { candidates: [{ id: "A" }] };
    expect(() =>
      assertWorkflowVersionInputCompatible({
        policy: "structure",
        plannedInputHash: sha256Digest(plannedWithRootCandidates),
        plannedInputStructure: concreteInputStructure(plannedWithRootCandidates),
        plannedInputStructureHash: concreteInputStructureHash(plannedWithRootCandidates),
        runInput: { candidates: [{ id: "B" }, { id: "C" }] },
        adaptiveArrayPaths: [{ path: ["candidates"], maxBranches: 100 }],
      })
    ).not.toThrow();

    const plannedWithNestedCandidates = { group: { candidates: [{ id: "A" }] } };
    expect(() =>
      assertWorkflowVersionInputCompatible({
        policy: "structure",
        plannedInputHash: sha256Digest(plannedWithNestedCandidates),
        plannedInputStructure: concreteInputStructure(plannedWithNestedCandidates),
        plannedInputStructureHash: concreteInputStructureHash(plannedWithNestedCandidates),
        runInput: { group: { candidates: [{ id: "B" }, { id: "C" }] } },
        adaptiveArrayPaths: [{ path: ["group", "candidates"], maxBranches: 100 }],
      })
    ).not.toThrow();
  });

  it("rejects adaptive array paths when the new count exceeds maxBranches", () => {
    const adaptivePlannedInput = { candidates: [{ id: "A" }] };
    expect(() =>
      assertWorkflowVersionInputCompatible({
        policy: "structure",
        plannedInputHash: sha256Digest(adaptivePlannedInput),
        plannedInputStructure: concreteInputStructure(adaptivePlannedInput),
        plannedInputStructureHash: concreteInputStructureHash(adaptivePlannedInput),
        runInput: { candidates: [{ id: "B" }, { id: "C" }, { id: "D" }] },
        adaptiveArrayPaths: [{ path: ["candidates"], maxBranches: 2 }],
      })
    ).toThrow("WorkflowVersion planned input structure does not match run input.");
  });

  it("uses the strictest maxBranches when adaptive array paths are duplicated", () => {
    const adaptivePlannedInput = { candidates: [{ id: "A" }] };
    expect(() =>
      assertWorkflowVersionInputCompatible({
        policy: "structure",
        plannedInputHash: sha256Digest(adaptivePlannedInput),
        plannedInputStructure: concreteInputStructure(adaptivePlannedInput),
        plannedInputStructureHash: concreteInputStructureHash(adaptivePlannedInput),
        runInput: { candidates: [{ id: "B" }, { id: "C" }, { id: "D" }] },
        adaptiveArrayPaths: [
          { path: ["candidates"], maxBranches: 5 },
          { path: ["candidates"], maxBranches: 2 },
        ],
      })
    ).toThrow("WorkflowVersion planned input structure does not match run input.");
  });

  it("rejects adaptive array paths when element structure changes", () => {
    const adaptivePlannedInput = { candidates: [{ id: "A" }] };
    expect(() =>
      assertWorkflowVersionInputCompatible({
        policy: "structure",
        plannedInputHash: sha256Digest(adaptivePlannedInput),
        plannedInputStructure: concreteInputStructure(adaptivePlannedInput),
        plannedInputStructureHash: concreteInputStructureHash(adaptivePlannedInput),
        runInput: { candidates: [{ id: "B", score: 1 }, { id: "C", score: 2 }] },
        adaptiveArrayPaths: [{ path: ["candidates"], maxBranches: 100 }],
      })
    ).toThrow("WorkflowVersion planned input structure does not match run input.");
  });

  it("allows any reuse without planned input compatibility checks", () => {
    expect(() =>
      assertWorkflowVersionInputCompatible({
        policy: "any",
        plannedInputHash,
        plannedInputStructureHash,
        runInput: ["completely", "different"],
      })
    ).not.toThrow();
  });

  it("rejects never reuse for direct WorkflowVersion execution", () => {
    expect(() =>
      assertWorkflowVersionInputCompatible({
        policy: "never",
        plannedInputHash,
        plannedInputStructureHash,
        runInput: plannedInput,
      })
    ).toThrow("WorkflowVersion reuse is disabled.");
  });
});
